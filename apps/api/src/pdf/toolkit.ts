/**
 * Интерфейс работы с PDF и выбор реализации (ADR-0003).
 *
 * Домену нужны две операции: собрать рабочий документ ревизии из нескольких
 * исходных файлов (§3.3) и нарезать логические документы по диапазонам страниц
 * (§7, задача 22). Обе идут в фоновых задачах и обе на реальных комплектах
 * работают с десятками мегабайт.
 *
 * ## Почему интерфейс, а не прямой вызов
 *
 * `qpdf` работает потоково, не перекодирует сканы и держит память постоянной;
 * `pdf-lib` загружает документ в heap целиком (86 МБ PDF → 300+ МБ), и при
 * нескольких параллельных задачах это OOM. При этом `qpdf` — внешний бинарник,
 * которого на машине разработки нет. Отсюда две реализации и одно правило:
 * **выбор делает startup check, а не место вызова**. Вызывающий код никогда не
 * спрашивает «есть ли qpdf» — он получает `PdfToolkit` и работает с ним.
 *
 * ## Почему отсутствие qpdf в production валит запуск
 *
 * Молчаливая деградация означала бы OOM на первом крупном комплекте — в фоновой
 * задаче, то есть без внятной ошибки пользователю и без связи с причиной.
 * Отказ при старте, наоборот, происходит один раз, в момент выкатки, с текстом,
 * называющим недостающий бинарник. Вне production деградация разрешена, но с
 * жёстким порогом по размеру: файл крупнее порога даёт понятный отказ задачи
 * «нужен qpdf», а не падение по памяти.
 *
 * ## Карта страниц считается ЗДЕСЬ, а не в реализации
 *
 * `planWorkingPdf()` — чистая функция от состава и порядка файлов. Реализация
 * обязана лишь произвести PDF с ровно таким числом страниц; расхождение —
 * отказ, а не «подгоним карту под результат». Без этого правила карта
 * `processing_bundle_pages` могла бы разъехаться с содержимым рабочего PDF, и
 * результат распознавания привязался бы к чужой странице оригинала.
 */
import type { Logger } from 'pino';

// =====================================================================
// Единицы работы
// =====================================================================

/**
 * Один исходный файл ревизии в составе рабочего документа.
 *
 * Путь, а не байты: `qpdf` читает файлы с диска потоково, и передача Buffer'ов
 * убила бы главное его преимущество. Задача сама выкладывает оригиналы во
 * временный каталог и удаляет его после сборки.
 *
 * Растровые оригиналы (§3.3 упоминает конвертацию изображений в страницы) на
 * этом этапе не принимаются: у изображения нет проверенного источника
 * геометрии страницы, а `source_pages` требует размеров. Приём изображений
 * вводится вместе с разбором заголовков PNG/JPEG.
 */
export interface WorkingPdfPart {
  /** `source_files.id`: к нему привязывается карта страниц. */
  readonly sourceFileId: string;
  readonly path: string;
  readonly byteSize: number;
  /** Число страниц по данным `file.verify`; служит и планом, и контролем. */
  readonly pageCount: number;
}

/** Строка карты: страница рабочего PDF ↔ страница исходного файла. */
export interface WorkingPageMapping {
  readonly workingPageIndex: number;
  readonly sourceFileId: string;
  readonly filePageIndex: number;
}

export interface BuildWorkingPdfInput {
  readonly parts: readonly WorkingPdfPart[];
  readonly outputPath: string;
  /** Пометка о производности документа (§13); попадает в метаданные PDF. */
  readonly derivedNote?: string | undefined;
}

export interface BuildWorkingPdfResult {
  readonly pageCount: number;
  readonly map: readonly WorkingPageMapping[];
  readonly toolkit: PdfToolkitKind;
  /** `false` — реализация не умеет писать метаданные; отметка остаётся в БД. */
  readonly derivedNoteApplied: boolean;
}

export interface ExtractPagesInput {
  readonly sourcePath: string;
  readonly outputPath: string;
  /** Границы включительно, 0-based — как индексы страниц рабочего PDF. */
  readonly firstPageIndex: number;
  readonly lastPageIndex: number;
  readonly derivedNote?: string | undefined;
}

export interface ExtractPagesResult {
  readonly pageCount: number;
  readonly toolkit: PdfToolkitKind;
  readonly derivedNoteApplied: boolean;
}

export type PdfToolkitKind = 'qpdf' | 'pdf-lib';

export interface PdfToolkit {
  readonly kind: PdfToolkitKind;
  /** Предел размера одного исходного файла; `null` — без ограничения. */
  readonly maxInputBytes: number | null;
  /** Предел суммарного размера сборки; `null` — без ограничения. */
  readonly maxTotalInputBytes: number | null;
  buildWorkingPdf(input: BuildWorkingPdfInput): Promise<BuildWorkingPdfResult>;
  extractPages(input: ExtractPagesInput): Promise<ExtractPagesResult>;
}

// =====================================================================
// Ошибки
// =====================================================================

export type PdfToolkitErrorCode =
  'toolkit_unavailable' | 'input_too_large' | 'invalid_input' | 'build_failed';

export class PdfToolkitError extends Error {
  readonly code: PdfToolkitErrorCode;

  constructor(code: PdfToolkitErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PdfToolkitError';
    this.code = code;
  }
}

export function isPdfToolkitError(value: unknown): value is PdfToolkitError {
  return value instanceof PdfToolkitError;
}

// =====================================================================
// Порог деградации
// =====================================================================

/**
 * Порог, выше которого `pdf-lib` не допускается (ADR-0003, план §12).
 *
 * Это не измеренная граница безопасности, а граница, названная планом: 20 МБ
 * исходного PDF в pdf-lib дают порядка сотни мегабайт heap. Настоящий замер
 * (одновременная обработка нескольких файлов до 200 МБ) — гейт §16, и он
 * открыт до S12, где появится VPS с установленным qpdf.
 */
export const PDF_LIB_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * Суммарный предел сборки для `pdf-lib`.
 *
 * Существует отдельно от предела на файл, потому что при склейке в памяти
 * одновременно живут ВСЕ исходные документы: десять файлов по 20 МБ — это не
 * «двадцать мегабайт», это двести. Ограничение на файл, взятое в одиночку,
 * создавало бы ровно то ложное чувство безопасности, ради устранения которого
 * ADR и запрещает молчаливую деградацию.
 */
export const PDF_LIB_MAX_TOTAL_BYTES = 4 * PDF_LIB_MAX_INPUT_BYTES;

// =====================================================================
// План рабочего документа
// =====================================================================

/**
 * Карта страниц рабочего PDF по составу и порядку файлов.
 *
 * Чистая функция: тот же вход — та же карта, независимо от реализации и от
 * того, чем собирался PDF. Именно поэтому она считается до сборки и служит
 * контролем результата, а не следствием из него.
 */
export function planWorkingPdf(parts: readonly WorkingPdfPart[]): readonly WorkingPageMapping[] {
  if (parts.length === 0) {
    throw new PdfToolkitError('invalid_input', 'рабочий документ нельзя собрать из нуля файлов');
  }

  const seen = new Set<string>();
  const map: WorkingPageMapping[] = [];

  for (const part of parts) {
    if (!Number.isSafeInteger(part.pageCount) || part.pageCount <= 0) {
      throw new PdfToolkitError(
        'invalid_input',
        `у файла ${part.sourceFileId} не задано число страниц (${part.pageCount})`,
      );
    }
    if (seen.has(part.sourceFileId)) {
      // Один и тот же файл дважды в составе сделал бы отображение страницы
      // рабочего PDF на оригинал неоднозначным, а ограничение
      // processing_bundle_pages_page_uq отвергло бы вторую запись уже в БД.
      throw new PdfToolkitError(
        'invalid_input',
        `файл ${part.sourceFileId} встречается в составе дважды`,
      );
    }
    seen.add(part.sourceFileId);

    for (let filePageIndex = 0; filePageIndex < part.pageCount; filePageIndex += 1) {
      map.push({ workingPageIndex: map.length, sourceFileId: part.sourceFileId, filePageIndex });
    }
  }

  return map;
}

/**
 * Проверка размеров под ограничения реализации.
 *
 * Вынесена сюда, а не продублирована в реализациях: отказ обязан быть
 * одинаковым и одинаково понятным независимо от того, кто его выдал.
 */
export function assertWithinLimits(toolkit: PdfToolkit, parts: readonly WorkingPdfPart[]): void {
  const total = parts.reduce((sum, part) => sum + part.byteSize, 0);

  if (toolkit.maxInputBytes !== null) {
    for (const part of parts) {
      if (part.byteSize > toolkit.maxInputBytes) {
        throw new PdfToolkitError(
          'input_too_large',
          `файл ${part.sourceFileId} размером ${mb(part.byteSize)} превышает предел ` +
            `${mb(toolkit.maxInputBytes)} для реализации ${toolkit.kind}: нужен qpdf`,
        );
      }
    }
  }

  if (toolkit.maxTotalInputBytes !== null && total > toolkit.maxTotalInputBytes) {
    throw new PdfToolkitError(
      'input_too_large',
      `суммарный размер комплекта ${mb(total)} превышает предел ` +
        `${mb(toolkit.maxTotalInputBytes)} для реализации ${toolkit.kind}: нужен qpdf`,
    );
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Расхождение плана и результата: карта была бы ложью, поэтому это отказ. */
export function assertPageCountMatches(expected: number, produced: number): void {
  if (expected !== produced) {
    throw new PdfToolkitError(
      'build_failed',
      `в рабочем PDF ${produced} страниц вместо ${expected}: карта страниц ` +
        'не описывала бы документ, поэтому bundle не сохраняется',
    );
  }
}

// =====================================================================
// Выбор реализации при старте
// =====================================================================

export interface QpdfDetection {
  readonly available: boolean;
  readonly version: string | null;
  readonly binary: string;
  readonly error: string | null;
}

export interface SelectPdfToolkitOptions {
  readonly nodeEnv: string;
  /** Проба бинарника; подменяется в тестах, чтобы не зависеть от машины. */
  readonly detectQpdf: () => Promise<QpdfDetection>;
  readonly createQpdfToolkit: (detection: QpdfDetection) => PdfToolkit;
  readonly createFallbackToolkit: () => Promise<PdfToolkit>;
  readonly logger?: Logger | undefined;
}

export interface PdfToolkitSelection {
  readonly toolkit: PdfToolkit;
  readonly detection: QpdfDetection;
  /** `true` — работаем на деградации, значит с ограничением по размеру. */
  readonly degraded: boolean;
}

/**
 * Startup check: какой реализацией пользуется процесс.
 *
 * Вызывается один раз при подъёме приложения и воркера. В production отказ
 * бросается наружу и процесс не поднимается — это и есть решение ADR-0003.
 */
export async function selectPdfToolkit(
  options: SelectPdfToolkitOptions,
): Promise<PdfToolkitSelection> {
  const detection = await options.detectQpdf();

  if (detection.available) {
    const toolkit = options.createQpdfToolkit(detection);
    options.logger?.info(
      { event: 'pdf_toolkit_selected', toolkit: toolkit.kind, qpdf_version: detection.version },
      'работа с PDF идёт через qpdf',
    );
    return { toolkit, detection, degraded: false };
  }

  if (options.nodeEnv === 'production') {
    throw new PdfToolkitError(
      'toolkit_unavailable',
      `qpdf не найден (${detection.binary}): ${detection.error ?? 'бинарник недоступен'}. ` +
        'В production деградация на pdf-lib запрещена — она означает исчерпание ' +
        'памяти на первом крупном комплекте в фоновой задаче (ADR-0003).',
    );
  }

  const toolkit = await options.createFallbackToolkit();
  options.logger?.warn(
    {
      event: 'pdf_toolkit_degraded',
      toolkit: toolkit.kind,
      max_input_bytes: toolkit.maxInputBytes,
      max_total_input_bytes: toolkit.maxTotalInputBytes,
      reason: detection.error,
    },
    'qpdf не найден: работа с PDF идёт на pdf-lib с ограничением по размеру',
  );
  return { toolkit, detection, degraded: true };
}
