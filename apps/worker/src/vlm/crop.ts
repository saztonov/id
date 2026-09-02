/**
 * Crop policy v2 (ADR-0007, план Ф4а): вырезка PNG-кропа блока из растра
 * страницы для VLM-распознавания.
 *
 * ## Версия политики — часть снимка прогона
 *
 * `CROP_POLICY_VERSION` уходит в `settings_snapshot.cropPolicyVersion`
 * (`vlm.start_recognition`) и в провенанс каждого результата блока: любая
 * содержательная правка геометрии (паддинг, минимальный размер, потолок
 * длинной стороны, алгоритм маски) обязана поднимать эту строку, иначе
 * canonical-артефакты старого и нового поведения неотличимы по одной лишь
 * пиксельной сетке.
 *
 * ## Пять решений, зафиксированных здесь
 *
 * 1. **Клэмп координат** в [0,1] — защита от блока, чьи координаты пришли из
 *    внешнего источника разметки с плавающей погрешностью (в БД это уже держит
 *    CHECK `layout_blocks_coords_chk`, но крoп не имеет права падать на
 *    доверии к чужому инварианту).
 * 2. **floor/ceil при переводе в пиксели**: `x0/y0` — floor (кроп начинается
 *    не позже разметки), `x1/y1` — ceil (кроп заканчивается не раньше) — кроп
 *    целиком накрывает заказанный прямоугольник, а не обрезает его на
 *    субпиксельном округлении.
 * 3. **Паддинг 8 px с клэмпом по границе страницы** — поля вокруг блока часто
 *    несут контекст (продолжение линии, соседняя подпись), и модель получает
 *    его без выхода за пределы растра.
 * 4. **Вырожденный кроп** (сторона < 16 px после паддинга) — не отказ модуля,
 *    а результат `{degenerate: true}`: пустой/микроскопический блок — законное
 *    состояние разметки (граница выделена криво или блок — артефакт детектора),
 *    и что с этим делать по типу блока — решение вызывающего (vlm-recognition.ts),
 *    не этого модуля.
 * 5. **Потолок длинной стороны 2048 px** — выбран из бюджета тела запроса
 *    прокси (~24 MiB после base64, см. `LlmPayloadTooLargeError`): страница на
 *    300 DPI (RASTER_DPI) даёt блок в несколько тысяч пикселей по стороне
 *    только для block'ов, покрывающих значительную часть листа A0/A1, а
 *    2048 px PNG плотного чертежа — единицы мегабайт, что оставляет кратный
 *    запас даже до кодирования в data-URL. Значение симметрично
 *    downscale-retry: тот же потолок, тот же детерминированный ресемплинг.
 *
 *    **Исключение — блок на весь лист** (`FULL_PAGE_MAX_LONG_EDGE_PX`, v2).
 *    Для фрагмента листа 2048 px ничего не решают, для страницы целиком —
 *    решают всё: A4@300dpi это 3508 px по длинной стороне, и сжатие до 2048
 *    уменьшает высоту строки в 1.7 раза. Мелкий шрифт сертификата на этом
 *    уходит за границу разборчивости — а полностраничные блоки ставит заплатка
 *    пустой страницы там, где другого текста у страницы нет вовсе. Потолок
 *    передаёт вызывающий, глядя на `detector_provenance` блока.
 *
 * ## Маска полигона
 *
 * Точки полигона приходят нормализованными к ЦЕЛОЙ СТРАНИЦЕ (0..1), как в
 * `layout_block_points` (миграция 0004/0019: CHECK на диапазон [0,1]) — не к
 * кропу. Пересчёт в пиксели кропа — `pageNorm * pageSizePx - cropOriginPx`.
 * Маска строится в два прохода sharp: (1) `dest-in` вырезанного кропа по
 * SVG-полигону (непрозрачно ВНУТРИ контура, прозрачно СНАРУЖИ — SVG без
 * заливки фона даёт прозрачность по умолчанию), (2) композиция результата на
 * белый фон того же размера. Итог: пиксели вне контура — белые, внутри —
 * исходные. SVG-путь, а не растровая маска руками — libvips/librsvg делает
 * антиалиасинг границы контура сам, тем же движком, что рендерит текст.
 *
 * ## Разворот содержимого (v3, ADR-0020)
 *
 * Скан, легший на лист боком при нулевом `/Rotate`, разворачивается ЗДЕСЬ —
 * последней операцией над уже вырезанной картинкой. Не растр страницы целиком:
 * поворот растра потребовал бы вращать `coords_norm`, полигоны,
 * `frameSizesAgree` и порядок блоков — четыре места вместо одного, и каждое из
 * них умеет ошибиться молча. Кроп же не меняет ни одной координаты:
 * прямоугольник вырезается в системе страницы, а разворачивается уже картинка.
 *
 * Разворот выполняется ОТДЕЛЬНЫМ проходом sharp, а не звеном общего конвейера,
 * и это не перестраховка. У sharp порядок операций внутри одного конвейера
 * ФИКСИРОВАН и не совпадает с порядком вызовов: `composite` применяется ПОСЛЕ
 * `rotate`. На блоке-полигоне конвейер пересобирается вокруг белой подложки
 * (`whiteBackground.composite([...])`), поэтому `.rotate()` на нём поворачивал
 * бы пустую подложку — то есть не делал бы ничего. Проверено: кроп выходил
 * неповёрнутым, молча и только на полигонах.
 *
 * Цена отдельного прохода — один декод и энкод PNG со стороной не больше 2048 px
 * на РАЗВЁРНУТОЙ странице. Против одного вызова модели это ничто, а взамен
 * поворот перестаёт зависеть от внутреннего порядка чужой библиотеки.
 *
 * Четверть оборота меняет стороны местами, но не длину длинной, поэтому потолок,
 * применённый до поворота, даёт тот же результат — последовательность прежняя, и
 * версия политики отвечает ровно за одно изменение.
 *
 * ## Downscale — общая функция, а не побочный эффект
 *
 * `downscalePng` детерминированно уменьшает PNG в `factor` раз (по умолчанию
 * 0.7 — тот же коэффициент, что и уменьшение стороны потолка одним шагом) и
 * экспортирована ОТДЕЛЬНО: `recognize-block.ts` (`@id/api`) принимает функцию
 * `downscale` инъекцией именно этой сигнатуры для повтора при
 * `LlmPayloadTooLargeError` — единственный источник ресемплинга один и тот же
 * для потолка кропа и для downscale-повтора.
 *
 * ## Kernel — дефолт sharp (lanczos3), без переопределения
 *
 * И потолок длинной стороны, и `downscalePng` используют `sharp.resize()` без
 * явного `kernel`: значение по умолчанию для растяжения/сжатия в sharp —
 * `lanczos3` (значение, документированное самим sharp, а не наше решение),
 * оно детерминировано между вызовами на одной версии sharp и не варьируется
 * от входных данных. Явного `kernel: 'lanczos3'` в коде нет намеренно: он был
 * бы копией дефолта, а не значением, которое от дефолта отличается — только
 * повод для двух источников правды, если sharp когда-нибудь сменит дефолт.
 */
import sharp from 'sharp';

/**
 * Версия crop policy. Уезжает в `settings_snapshot.cropPolicyVersion` и в
 * провенанс каждого блока, поэтому меняется вместе с ЛЮБЫМ изменением того, как
 * готовится картинка для модели.
 *
 * `v2` — появился отдельный потолок для полностраничных блоков (S27).
 * `v3` — кроп отдаётся модели РАЗВЁРНУТЫМ по `content_rotation` страницы (S35).
 * `v4` — страница рендерится в своём разрешении, а не всегда в 300 dpi (S46).
 *
 * Подъём версии делает все прежние прогоны несовместимыми в
 * `runsProduceSameCrops`, то есть первое «Распознать» после выката
 * перераспознаёт комплект целиком. Это не побочный эффект, а условие
 * корректности: старый результат получен по картинке, которой модель больше не
 * увидит.
 */
export const CROP_POLICY_VERSION = 'crop.v4';

/**
 * Потолок длинной стороны для блока НА ВСЮ СТРАНИЦУ.
 *
 * Общий потолок 2048 px выбран для блоков — фрагментов листа, где он ничего не
 * решает. Для полностраничного блока он означает другое: A4 на 300 DPI — это
 * 3508 px по длинной стороне, и сжатие до 2048 уменьшает высоту строки в 1.7
 * раза. На сертификате, где значимое напечатано мелким шрифтом, это ровно та
 * граница, за которой распознавание перестаёт быть надёжным, — а полностраничные
 * блоки ставит заплатка `applyTextCoverageFallback` именно там, где другого
 * текста у страницы нет вовсе.
 *
 * 3000 px: A4@300dpi проходит почти без сжатия, а бюджет тела запроса прокси
 * (~24 MiB после base64) сохраняет кратный запас — плотная текстовая страница в
 * PNG на этой стороне занимает единицы мегабайт.
 *
 * Константой, а не настройкой: это часть crop policy, и её смена обязана менять
 * `CROP_POLICY_VERSION`. Настройка дала бы два прогона с одной версией политики
 * и разными кропами — то есть провенанс, который врёт.
 */
export const FULL_PAGE_MAX_LONG_EDGE_PX = 3000;

/** Поля вокруг заказанного прямоугольника блока, px. */
const DEFAULT_PADDING_PX = 8;
/** Сторона кропа короче этого значения после паддинга — вырожденный кроп. */
const DEFAULT_MIN_SIDE_PX = 16;
/**
 * Потолок длинной стороны кропа, px.
 *
 * См. «Пять решений», п. 5. Значение общее для потолка исходного кропа и для
 * шага downscale-повтора (`downscalePng` уменьшает от ТЕКУЩЕГО размера, а не
 * пересчитывает от этого потолка — они независимые операции с одним и тем же
 * инструментом ресемплинга).
 */
const DEFAULT_MAX_LONG_EDGE_PX = 2048;
/** Коэффициент детерминированного downscale-повтора при `LlmPayloadTooLargeError`. */
const DEFAULT_DOWNSCALE_FACTOR = 0.7;

export interface CropBlockInput {
  /** Ровно один из `pagePngPath`/`pageBuffer` — путь дешевле для больших страниц. */
  readonly pagePngPath?: string | undefined;
  readonly pageBuffer?: Uint8Array | undefined;
  readonly pageWidthPx: number;
  readonly pageHeightPx: number;
  /** [x0, y0, x1, y1], нормализовано 0..1 относительно страницы. */
  readonly coordsNorm: readonly [number, number, number, number];
  /**
   * Полигон блока, точки нормализованы 0..1 относительно ВСЕЙ страницы (как в
   * `layout_block_points`) — не относительно кропа. `null` — прямоугольный
   * блок, маска не строится.
   */
  readonly polygon: readonly (readonly [number, number])[] | null;
  readonly paddingPx?: number | undefined;
  readonly minSidePx?: number | undefined;
  readonly maxLongEdgePx?: number | undefined;
  /**
   * Разворот содержимого страницы, градусы по часовой стрелке (ADR-0020).
   *
   * Ноль — полный no-op: ни одной лишней операции над картинкой, побайтовое
   * совпадение с поведением до v3. Это проверяется тестом, потому что «лишний
   * энкод при нуле» — ровно тот класс правки, который проходит ревью незаметно
   * и меняет `cropSha256` у всех блоков всех прямых страниц.
   */
  readonly contentRotation?: 0 | 90 | 180 | 270 | undefined;
}

export type CropBlockResult =
  | { readonly png: Uint8Array; readonly widthPx: number; readonly heightPx: number }
  | { readonly degenerate: true };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * SVG-маска полигона: непрозрачная фигура на прозрачном фоне.
 *
 * Пустого фона (без `<rect>`) достаточно — SVG без явной заливки фона
 * рендерится с alpha=0, и это ровно то, что нужно `dest-in` (см. шапку файла):
 * сохранить кроп там, где маска непрозрачна, обнулить альфу везде, где нет.
 */
function polygonMaskSvg(
  widthPx: number,
  heightPx: number,
  pointsPx: readonly (readonly [number, number])[],
): Buffer {
  const points = pointsPx.map(([x, y]) => `${x},${y}`).join(' ');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">` +
    `<polygon points="${points}" fill="#000000"/>` +
    `</svg>`;
  return Buffer.from(svg, 'utf8');
}

/**
 * Кроп блока по crop policy v1.
 *
 * Порядок операций фиксирован: extract → (опционально) маска полигона →
 * (опционально) потолок длинной стороны. Маска применяется ДО даунскейла,
 * чтобы граница контура считалась в исходном разрешении кропа, а не в уже
 * сжатом изображении — иначе антиалиасинг границы зависел бы от того,
 * потребовался ли даунскейл именно этому блоку.
 */
export async function cropBlockPng(input: CropBlockInput): Promise<CropBlockResult> {
  const source =
    input.pagePngPath ?? (input.pageBuffer === undefined ? undefined : toBuffer(input.pageBuffer));
  if (source === undefined) {
    throw new Error('cropBlockPng: требуется pagePngPath либо pageBuffer');
  }

  const paddingPx = input.paddingPx ?? DEFAULT_PADDING_PX;
  const minSidePx = input.minSidePx ?? DEFAULT_MIN_SIDE_PX;
  const maxLongEdgePx = input.maxLongEdgePx ?? DEFAULT_MAX_LONG_EDGE_PX;

  const [x0n, y0n, x1n, y1n] = input.coordsNorm.map(clamp01) as [number, number, number, number];
  const left0 = Math.floor(Math.min(x0n, x1n) * input.pageWidthPx);
  const top0 = Math.floor(Math.min(y0n, y1n) * input.pageHeightPx);
  const right0 = Math.ceil(Math.max(x0n, x1n) * input.pageWidthPx);
  const bottom0 = Math.ceil(Math.max(y0n, y1n) * input.pageHeightPx);

  const left = Math.max(0, left0 - paddingPx);
  const top = Math.max(0, top0 - paddingPx);
  const right = Math.min(input.pageWidthPx, right0 + paddingPx);
  const bottom = Math.min(input.pageHeightPx, bottom0 + paddingPx);
  const width = right - left;
  const height = bottom - top;

  if (width < minSidePx || height < minSidePx) {
    return { degenerate: true };
  }

  // Последовательное чтение: кроп берётся потоком, а не из распакованного в
  // память кадра страницы — на крупноформатном листе это сотни мегабайт (S41).
  let pipeline = sharp(source, { sequentialRead: true }).extract({ left, top, width, height });

  if (input.polygon !== null && input.polygon.length >= 3) {
    const pointsPx = input.polygon.map(
      ([px, py]) =>
        [clamp01(px) * input.pageWidthPx - left, clamp01(py) * input.pageHeightPx - top] as const,
    );
    const maskSvg = polygonMaskSvg(width, height, pointsPx);
    const masked = await pipeline
      .ensureAlpha()
      .composite([{ input: maskSvg, blend: 'dest-in' }])
      .png()
      .toBuffer();
    const whiteBackground = sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    });
    pipeline = whiteBackground.composite([{ input: masked }]);
  }

  const contentRotation = input.contentRotation ?? 0;

  const longEdge = Math.max(width, height);
  if (longEdge > maxLongEdgePx) {
    // `fit: 'inside'` рассчитывает недостающую сторону сам — единственная
    // сторона, реально ограничивающая размер, не всегда та же для всех
    // блоков, и жёстко высчитывать её здесь значило бы дублировать то, что
    // sharp уже делает детерминированно.
    pipeline = pipeline.resize({
      width: maxLongEdgePx,
      height: maxLongEdgePx,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const { data, info } = await pipeline.png().toBuffer({ resolveWithObject: true });

  // Разворот — ОТДЕЛЬНЫМ проходом, последней операцией над готовым кропом
  // (см. шапку файла: внутри одного конвейера sharp ставит `composite` после
  // `rotate`, и на полигонах поворот не применялся бы вовсе).
  //
  // Ноль — полный no-op: ни одного лишнего декода, ни одного изменённого байта.
  // `cropSha256` уезжает в провенанс каждого блока, и лишний энкод при нуле
  // переписал бы провенанс всем прямым страницам комплекта без единой причины.
  if (contentRotation !== 0) {
    const turned = await sharp(data)
      .rotate(contentRotation)
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      png: new Uint8Array(turned.data.buffer, turned.data.byteOffset, turned.data.byteLength),
      widthPx: turned.info.width,
      heightPx: turned.info.height,
    };
  }

  return {
    png: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    widthPx: info.width,
    heightPx: info.height,
  };
}

/**
 * Даунскейл-повтор PNG в `factor` раз (по умолчанию {@link DEFAULT_DOWNSCALE_FACTOR}).
 *
 * Инъецируется в `recognizeBlock` (`@id/api`, `recognize-block.ts`) как
 * `downscale` — единственный вызов на попытку при `LlmPayloadTooLargeError`.
 * Детерминирован: тот же вход и тот же `factor` дают побайтово тот же PNG на
 * одной версии sharp (никакого рандома, кэша размера шрифта и т.п.).
 *
 * Обе стороны — `Math.round`, не меньше 1 px: дальше уменьшать уже некуда, и
 * функция возвращает вход как есть, а не бросает — вызывающий (`recognizeBlock`)
 * сам решает, что делать с телом, которое не помещается даже при 1×1.
 */
export async function downscalePng(
  png: Uint8Array,
  factor: number = DEFAULT_DOWNSCALE_FACTOR,
): Promise<Uint8Array> {
  const buffer = toBuffer(png);
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 1 || height <= 1) return png;

  const newWidth = Math.max(1, Math.round(width * factor));
  const newHeight = Math.max(1, Math.round(height * factor));
  const { data } = await sharp(buffer)
    .resize({ width: newWidth, height: newHeight, fit: 'fill' })
    .png()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
