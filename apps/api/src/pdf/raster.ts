/**
 * Растеризация страниц PDF в PNG на сервере (ADR-0008).
 *
 * До локальной детекции у портала не было серверных изображений страниц вовсе:
 * экран рендерит pdf.js в браузере, а единственным серверным источником PNG
 * были превью RD WEB. Локальный RF-DETR и кропы для VLM требуют собственного
 * рендера — и он устроен по прецеденту ADR-0003 (qpdf): порт с явным выбором
 * реализации при старте, честный отказ вместо молчаливой деградации.
 *
 * ## Почему порт, а не прямой вызов pdftoppm
 *
 * Задачам (`layout.detect_local`, `vlm.recognize_page`) нужна одна операция —
 * «страница N этого PDF в PNG с этим DPI». Кто её выполняет (poppler, pdfium,
 * тестовый двойник) — свойство окружения процесса, а не задачи. Порт делает
 * тестовый двойник тривиальным: интеграционные тесты подставляют растеризатор,
 * отдающий заранее сгенерированные PNG, и не требуют бинарника в CI.
 *
 * ## Судьба фолбэка pdfium
 *
 * План предусматривает WASM-фолбэк вне production (`@hyzyla/pdfium`), чтобы
 * машина разработки без poppler могла прогонять детекцию вживую. Он появится
 * отдельным шагом вместе с установкой зависимости; `selectRasterizer` уже
 * построен списком кандидатов, так что добавление — новая фабрика в списке,
 * а не пересмотр выбора. До тех пор отсутствие pdftoppm означает `null`:
 * зависимые задачи отказывают с внятным классом ошибки, портал поднимается.
 */
import { open } from 'node:fs/promises';

/** DPI рендера для детекции и кропов: ~300 — разрешение, на котором обучен детектор. */
export const RASTER_DPI = 300;

/** Пунктов в дюйме: единица размеров страницы в PDF. */
const POINTS_PER_INCH = 72;

/**
 * Потолок площади растра, пикселей (S41).
 *
 * 300 DPI — правильное разрешение для A4 и разумное для A3–A2, но у страницы
 * PDF нет обязанности быть маленькой. Лист A1 при 300 DPI — это 7016×9933,
 * то есть 70 мегапикселей и около 630 МБ сырого RGB; A0 — вдвое больше. Такой
 * лист укладывал воркер при ЛЮБОМ параллелизме: потолок очереди ограничивает
 * число задач, а не аппетит одной из них, и «уменьшить cpu до единицы» здесь
 * не помогало.
 *
 * 40 мегапикселей выбраны так, чтобы обычные форматы не потерять вовсе: A4, A3
 * и A2 остаются на честных 300 DPI, и разрешение снижается только там, где
 * альтернатива — не отрендерить страницу совсем.
 */
export const RASTER_MAX_PIXELS = 40_000_000;

/**
 * DPI, с которым эту страницу можно отрендерить, не выйдя за потолок площади.
 *
 * Считается от размеров страницы в пунктах — тех же, что лежат в карте страниц
 * рабочего документа, — и потому ДЕТЕРМИНИРОВАН: детекция и распознавание,
 * спрашивая про одну страницу, получают одно число и работают в одном масштабе.
 * Координаты блоков нормированы к [0,1], поэтому снижение DPI на них не влияет.
 *
 * Возвращает `RASTER_DPI` для всего, что в потолок укладывается: платить за
 * вычисление уменьшенным качеством там, где в этом нет нужды, незачем.
 */
export function effectiveRasterDpi(widthPt: number, heightPt: number): number {
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt)) return RASTER_DPI;
  if (widthPt <= 0 || heightPt <= 0) return RASTER_DPI;

  const scale = RASTER_DPI / POINTS_PER_INCH;
  const pixelsAtFullDpi = widthPt * scale * (heightPt * scale);
  if (pixelsAtFullDpi <= RASTER_MAX_PIXELS) return RASTER_DPI;

  // Площадь растёт квадратом разрешения, поэтому корень отношения — это ровно
  // тот множитель, который приводит площадь к потолку.
  const reduced = Math.floor(RASTER_DPI * Math.sqrt(RASTER_MAX_PIXELS / pixelsAtFullDpi));
  // Нижняя граница — DPI миниатюры зонда: ниже неё текст перестаёт читаться, и
  // рендерить такую страницу бессмысленно даже ради того, чтобы не упасть.
  return Math.max(POINTS_PER_INCH, reduced);
}

export interface RenderPageInput {
  readonly pdfPath: string;
  /** Индекс страницы рабочего PDF с нуля — как везде в портале. */
  readonly pageIndex: number;
  readonly dpi: number;
  /** Куда положить PNG. Файл эфемерный: scratch задачи, удаляется в finally. */
  readonly outPath: string;
  /**
   * Отмена попытки задачи (S41).
   *
   * Рендер — внешний процесс, и он не узнаёт о том, что заказчика больше нет:
   * `pdftoppm` на листе A1 занимает ядро на десятки секунд и продолжал бы
   * занимать его после того, как движок уже отдал слот следующей задаче. С
   * сигналом процесс снимается сразу.
   */
  readonly signal?: AbortSignal | undefined;
}

export interface RenderPageResult {
  readonly widthPx: number;
  readonly heightPx: number;
}

export type RasterizerKind = 'pdftoppm' | 'pdfium';

export interface PageRasterizer {
  readonly kind: RasterizerKind;
  /** Версия инструмента — уходит в settings_snapshot прогона (ADR-0007). */
  readonly version: string | null;
  renderPage(input: RenderPageInput): Promise<RenderPageResult>;
}

/**
 * Растеризация недоступна или не справилась. Один класс на обе причины
 * намеренно: для задачи это одинаковый исход — «страницу отрендерить нельзя,
 * повтор не поможет, нужен оператор» — а различие живёт в сообщении.
 */
export class RasterizerError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RasterizerError';
  }
}

/**
 * Размер PNG из заголовка IHDR.
 *
 * Своя функция на 30 строк вместо зависимости: IHDR обязан быть первым чанком
 * (RFC 2083), ширина и высота лежат по фиксированным смещениям 16 и 20. Размер
 * нужен вызывающему для пересчёта нормализованных координат блоков в пиксели
 * кропа и для сверки с геометрией `source_pages` (контроль поворота).
 */
export async function readPngSize(path: string): Promise<RenderPageResult> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24) throw new RasterizerError('PNG короче заголовка IHDR');
    // Сигнатура PNG: 89 50 4E 47 0D 0A 1A 0A.
    if (header.readUInt32BE(0) !== 0x89504e47 || header.readUInt32BE(4) !== 0x0d0a1a0a) {
      throw new RasterizerError('Файл не является PNG: сигнатура не совпала');
    }
    if (header.toString('latin1', 12, 16) !== 'IHDR') {
      throw new RasterizerError('Первый чанк PNG не IHDR');
    }
    const widthPx = header.readUInt32BE(16);
    const heightPx = header.readUInt32BE(20);
    if (widthPx === 0 || heightPx === 0) {
      throw new RasterizerError('PNG объявляет нулевой размер');
    }
    return { widthPx, heightPx };
  } finally {
    await handle.close();
  }
}
