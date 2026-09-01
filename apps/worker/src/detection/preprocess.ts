/**
 * Пиксельный препроцессинг плитки: PNG страницы → вход RF-DETR ONNX (ADR-0008).
 *
 * Числовая логика (`@id/detection`) пикселей не видит — здесь живёт всё, что
 * требует sharp: вырезка плитки, статистика яркости для blank-tile критерия и
 * resize+нормализация в тензор CHW.
 *
 * ## Контракт паритета с обучением
 *
 * Тренер RD WEB готовит кадры PIL'ом: `convert("RGB")` → `resize((R, R),
 * BILINEAR)` — квадрат БЕЗ letterbox (кадр растягивается по обеим осям
 * независимо), затем ImageNet-нормализация из манифеста. Поэтому здесь:
 * - resize строго к `(R, R)` с `fit: 'fill'` — никаких полей и сохранения
 *   пропорций: letterbox дал бы модели геометрию, которой она не видела;
 * - kernel `linear` — ближайший к PIL BILINEAR из ядер libvips; точный
 *   побитовый паритет проверяется офлайн-скриптом на идентичных PNG (план,
 *   раздел приёмки), а не предполагается;
 * - нормализация `(x/255 − mean[c]) / std[c]` в float32, раскладка CHW.
 *
 * ## Blank-tile статистика: полное разрешение, без даунскейла
 *
 * Критерий `_is_blank_tile` референса считает std яркости grayscale-версии
 * ПОЛНОЙ плитки (PIL `convert("L")`, ITU-R 601-2). Даунскейл перед подсчётом
 * менял бы дисперсию (усреднение соседей гасит именно тот шум, который
 * отличает «почти пустую» плитку от пустой) и разошёлся бы с порогом
 * `BLANK_TILE_STD_THRESHOLD` из пакета. Цена честного подсчёта — один проход
 * по ≤1024² пикселей целочисленной арифметикой, микросекунды на фоне
 * PNG-декода, поэтому статистика считается по полному разрешению плитки.
 *
 * ## Почему один декод PNG на плитку, а не полный кадр в памяти
 *
 * Страница A0 на 300 DPI — это ~9930×14040×3 ≈ 400 МБ сырого RGB; держать её
 * целиком ради экономии декодов означало бы прибавить полгигабайта к пику
 * задачи. Вместо этого каждая плитка вырезается отдельным пайплайном sharp
 * (`extract` → raw ≈ 3 МБ), а статистика и препроцессинг считаются по ОДНОЙ
 * и той же вырезке — декод на плитку ровно один.
 */
import sharp from 'sharp';
import { pilGrayscaleLuma } from '@id/detection';

/** Прямоугольник плитки в пикселях страницы — совместим с `InferenceTile`. */
export interface TileRegion {
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
}

/** Сырые пиксели плитки: 3 канала RGB, row-major, без альфы. */
export interface TileRgb {
  readonly width: number;
  readonly height: number;
  readonly rgb: Buffer;
}

/** Статистика яркости плитки по формуле PIL `convert("L")` (ddof=0). */
export interface TileLumaStats {
  readonly mean: number;
  readonly std: number;
}

/** Вход модели: тензор CHW `[1, 3, R, R]` — форма, которую ждёт `OnnxSessionPort`. */
export interface ModelInput {
  readonly data: Float32Array;
  readonly dims: readonly [number, number, number, number];
}

export interface NormalizationOptions {
  readonly mean: readonly [number, number, number];
  readonly std: readonly [number, number, number];
  /** Разрешение входа сети из манифеста (`resolution`). */
  readonly resolution: number;
}

/**
 * Вырезать плитку из PNG страницы в сырой RGB.
 *
 * `toColourspace('srgb')` + `removeAlpha` приводят к трём каналам любой PNG
 * (grayscale-рендер poppler реплицируется в RGB — так же, как PIL
 * `convert("RGB")`). Каналов не три после этого — дефект входа, а не режим.
 */
export async function readTileRgb(source: string | Buffer, region: TileRegion): Promise<TileRgb> {
  /**
   * `sequentialRead` — про память, а не про скорость (S41).
   *
   * По умолчанию libvips открывает файл в режиме произвольного доступа и держит
   * распакованный кадр целиком: на листе A1 это сотни мегабайт, и умножается
   * оно на каждую плитку страницы. Последовательное чтение позволяет вырезать
   * область потоком, не разворачивая весь растр в памяти.
   */
  const { data, info } = await sharp(source, { sequentialRead: true })
    .extract({ left: region.x0, top: region.y0, width: region.width, height: region.height })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`Плитка декодировалась в ${info.channels} канала(ов), ожидалось 3 (RGB)`);
  }
  return { width: info.width, height: info.height, rgb: data };
}

/**
 * Среднее и популяционное std яркости плитки.
 *
 * Каждый пиксель проходит через `pilGrayscaleLuma` из `@id/detection` —
 * целочисленную формулу Pillow `convert("L")`; std — популяционное (ddof=0),
 * как `np.std` в `_is_blank_tile`. Порог сравнения (`isBlankTile`) тоже живёт
 * в пакете: здесь только подсчёт, чтобы критерий не существовал дважды.
 */
export function tileLumaStats(tile: TileRgb): TileLumaStats {
  const pixels = tile.width * tile.height;
  if (pixels === 0) {
    return { mean: 0, std: 0 };
  }
  let sum = 0;
  let sumSq = 0;
  const rgb = tile.rgb;
  for (let i = 0; i < pixels; i += 1) {
    const base = i * 3;
    const luma = pilGrayscaleLuma(
      rgb[base] as number,
      rgb[base + 1] as number,
      rgb[base + 2] as number,
    );
    sum += luma;
    sumSq += luma * luma;
  }
  const mean = sum / pixels;
  const variance = Math.max(0, sumSq / pixels - mean * mean);
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Плитка → тензор входа модели: resize `(R, R)` без letterbox → float32 CHW
 * с ImageNet-нормализацией из манифеста.
 */
export async function preprocessTile(
  tile: TileRgb,
  options: NormalizationOptions,
): Promise<ModelInput> {
  const r = options.resolution;
  const resized = await sharp(tile.rgb, {
    raw: { width: tile.width, height: tile.height, channels: 3 },
  })
    .resize(r, r, { kernel: 'linear', fit: 'fill' })
    .raw()
    .toBuffer();

  const plane = r * r;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const base = i * 3;
    for (let c = 0; c < 3; c += 1) {
      data[c * plane + i] =
        ((resized[base + c] as number) / 255 - options.mean[c as 0 | 1 | 2]) /
        options.std[c as 0 | 1 | 2];
    }
  }
  return { data, dims: [1, 3, r, r] };
}

/**
 * Разворот растра страницы перед инференсом (ADR-0020).
 *
 * ## Почему детекции поворачивается ЛИСТ, а распознаванию — кроп
 *
 * Это не непоследовательность, а одно правило для двух потребителей: модель и
 * детектор обязаны видеть прямую картинку, а в БД координаты обязаны остаться в
 * системе страницы. Распознавание получает вырезанный прямоугольник — его и
 * разворачиваем, координаты не трогая. Детектор же потребляет лист целиком:
 * вырезать нечего, поэтому разворачивается растр, а найденные боксы
 * возвращаются обратным поворотом (`rotateRectNorm` с `inverseTurn`).
 *
 * RF-DETR обучен на прямых листах. На боковом он даёт скудную разметку — а
 * табличная зона, оставшаяся без блока, не будет распознана вовсе: её никто не
 * спросит у модели.
 *
 * ## Отдельным файлом, а не звеном конвейера тайлинга
 *
 * Поворот обязан произойти ДО планирования плиток: их сетка считается от
 * размеров страницы, и повернуть плитку после нарезки — значит нарезать не то.
 * Функция пишет новый файл, потому что дальше по коду страница адресуется путём
 * (`readTileRgb` берёт `string | Buffer`), и держать развёрнутый лист A0 в
 * памяти всю детекцию незачем.
 */
export async function rotatePagePng(
  sourcePath: string,
  targetPath: string,
  turn: 90 | 180 | 270,
): Promise<{ readonly widthPx: number; readonly heightPx: number }> {
  // Поворот читает страницу ровно один раз и пишет её на диск: держать
  // распакованный кадр целиком незачем (S41).
  const info = await sharp(sourcePath, { sequentialRead: true })
    .rotate(turn)
    .png()
    .toFile(targetPath);
  return { widthPx: info.width, heightPx: info.height };
}
