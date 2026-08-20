/**
 * Постпроцессинг выходов RF-DETR ONNX → сырые кандидаты блоков одной плитки.
 *
 * Порт `temp/RDNEW/services/web_ocr/detection/postprocess.py` (референс RD WEB).
 *
 * Контракт выходов (из `onnx_export_manifest.json`):
 * - `dets` — `[batch, num_queries, 4]` в формате, указанном `box_format`;
 * - `labels` — `[batch, num_queries, num_classes+1]` логиты, последний столбец — «no object».
 *
 * RF-DETR-паритет (как в референсном `decode_tile`): активация из манифеста
 * (по умолчанию независимый `sigmoid`, focal loss; `softmax` — legacy-контракт),
 * затем **global top-K по (query × class) ПО ВСЕМ столбцам, включая no-object** —
 * колонки вне `class_mapping` отбрасываются уже ПОСЛЕ отбора top-K (то есть
 * занимают его слоты — ровно так считает референс и стандартный RF-DETR
 * постпроцесс; «исключить no-object до top-K» дало бы другой результат).
 *
 * Сам ONNX-инференс в пакет не входит: функции принимают уже посчитанные
 * тензоры (`Float32Array`+dims от onnxruntime-node либо `number[][]`).
 *
 * Легковесный legacy-путь `decode` (softmax + argmax на query) из референса
 * сознательно НЕ портирован: `service.py` его не вызывает — softmax-манифесты
 * обслуживаются `decode_tile(activation='softmax')`, что и повторяет
 * `decodeTileOutputs`.
 */

import { clamp01, cxcywhToXyxy, type Rect } from './geometry.js';

/** Типы блоков детекции: столбцы модели по `class_mapping` {text:0, image:1, stamp:2}. */
export const DETECTION_BLOCK_TYPES = ['text', 'image', 'stamp'] as const;
export type DetectionBlockType = (typeof DETECTION_BLOCK_TYPES)[number];

export const BOX_FORMAT_CXCYWH_NORMALIZED = 'cxcywh_normalized';
export const BOX_FORMAT_XYXY_PIXELS = 'xyxy_pixels';
export type BoxFormat = typeof BOX_FORMAT_CXCYWH_NORMALIZED | typeof BOX_FORMAT_XYXY_PIXELS;

/**
 * Активация логитов классов. RF-DETR (Deformable/LW-DETR, focal loss) —
 * независимый `sigmoid` по каждому классу + global top-K. `softmax` —
 * legacy-контракт для старых манифестов.
 */
export const CLASS_ACTIVATION_SIGMOID = 'sigmoid';
export const CLASS_ACTIVATION_SOFTMAX = 'softmax';
export type ClassActivation = typeof CLASS_ACTIVATION_SIGMOID | typeof CLASS_ACTIVATION_SOFTMAX;

/**
 * Артефакт не соответствует манифесту (формат/активация/классы) — аналог
 * `DetectionModelMismatch` референса; воркер маппит в честный отказ задачи.
 */
export class DetectionModelMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DetectionModelMismatchError';
  }
}

/** Тензор с формой — то, что отдаёт onnxruntime-node (`Tensor.data` + `Tensor.dims`). */
export interface TensorWithDims {
  readonly data: Float32Array | Float64Array | readonly number[];
  readonly dims: readonly number[];
}

/** `[Q, C]` либо `[B, Q, C]` вложенными массивами, либо тензор с dims. */
export type TensorLike =
  | TensorWithDims
  | ReadonlyArray<readonly number[]>
  | ReadonlyArray<ReadonlyArray<readonly number[]>>;

/** Прямоугольная матрица float64 — внутренняя нормальная форма тензоров. */
export interface Matrix {
  readonly rows: number;
  readonly cols: number;
  /** row-major, длина rows*cols */
  readonly data: Float64Array;
}

function isTensorWithDims(t: TensorLike): t is TensorWithDims {
  return !Array.isArray(t) && typeof t === 'object' && t !== null && 'data' in t && 'dims' in t;
}

/**
 * Привести вход к матрице `[Q, C]`.
 *
 * Как `np.asarray(...)[0]` в референсе: batch-ось (`[B,Q,C]`) снимается взятием
 * ПЕРВОГО элемента — даже при B>1 (батчи режет вызывающий, как `service.py`).
 * Рваные вложенные массивы — ошибка (у numpy они не собрались бы в тензор).
 */
export function toMatrix(input: TensorLike, what: string): Matrix {
  if (isTensorWithDims(input)) {
    const dims = input.dims;
    let rows: number;
    let cols: number;
    let offset = 0;
    if (dims.length === 2) {
      [rows, cols] = dims as unknown as [number, number];
    } else if (dims.length === 3) {
      rows = dims[1] ?? 0;
      cols = dims[2] ?? 0;
      offset = 0; // первый элемент батча
    } else {
      throw new DetectionModelMismatchError(
        `${what}: ожидался тензор ранга 2 или 3, dims=[${dims.join(',')}]`,
      );
    }
    if (input.data.length < offset + rows * cols) {
      throw new DetectionModelMismatchError(
        `${what}: длина data ${input.data.length} меньше dims ${rows}x${cols}`,
      );
    }
    const data = new Float64Array(rows * cols);
    for (let i = 0; i < rows * cols; i += 1) {
      data[i] = Number(input.data[offset + i]);
    }
    return { rows, cols, data };
  }

  // Вложенные массивы: [Q,C] или [B,Q,C] (batch снимается взятием [0]).
  let matrix: ReadonlyArray<readonly number[]>;
  const first: unknown = input[0];
  if (Array.isArray(first) && Array.isArray((first as unknown[])[0])) {
    matrix = (input as ReadonlyArray<ReadonlyArray<readonly number[]>>)[0] ?? [];
  } else {
    matrix = input as ReadonlyArray<readonly number[]>;
  }
  const rows = matrix.length;
  const cols = rows > 0 ? (matrix[0]?.length ?? 0) : 0;
  const data = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r += 1) {
    const row = matrix[r];
    if (!Array.isArray(row) || row.length !== cols) {
      throw new DetectionModelMismatchError(`${what}: рваная матрица (строка ${r})`);
    }
    for (let c = 0; c < cols; c += 1) {
      data[r * cols + c] = Number(row[c]);
    }
  }
  return { rows, cols, data };
}

/**
 * `{name: column_index}` → `Map<column_index, DetectionBlockType>`.
 *
 * Порт `invert_class_mapping`: неизвестные имена классов пропускаются (это
 * runtime-хелпер с открытой семантикой референса; жёсткую валидацию манифеста
 * делает zod-схема в `manifest.ts`). Индекс приводится усечением (`int()` в
 * Python); нечисловые/нецелые значения пропускаются.
 */
export function invertClassMapping(
  classMapping: Readonly<Record<string, number>> | null | undefined,
): Map<number, DetectionBlockType> {
  const out = new Map<number, DetectionBlockType>();
  for (const [name, idx] of Object.entries(classMapping ?? {})) {
    if (!(DETECTION_BLOCK_TYPES as readonly string[]).includes(name)) {
      continue;
    }
    const parsed = typeof idx === 'number' && Number.isFinite(idx) ? Math.trunc(idx) : null;
    if (parsed === null) {
      continue;
    }
    out.set(parsed, name as DetectionBlockType);
  }
  return out;
}

/** Softmax по последней оси в float64 (со сдвигом на максимум, как в референсе). */
function softmaxRows(m: Matrix): Float64Array {
  const out = new Float64Array(m.rows * m.cols);
  for (let r = 0; r < m.rows; r += 1) {
    let max = -Infinity;
    for (let c = 0; c < m.cols; c += 1) {
      const v = m.data[r * m.cols + c] as number;
      if (v > max) {
        max = v;
      }
    }
    let sum = 0;
    for (let c = 0; c < m.cols; c += 1) {
      const e = Math.exp((m.data[r * m.cols + c] as number) - max);
      out[r * m.cols + c] = e;
      sum += e;
    }
    for (let c = 0; c < m.cols; c += 1) {
      out[r * m.cols + c] = (out[r * m.cols + c] as number) / sum;
    }
  }
  return out;
}

/** Активировать логиты классов: `sigmoid` (независимо) или `softmax` (по оси). */
export function activateLogits(labels: Matrix, activation: ClassActivation): Float64Array {
  if (activation === CLASS_ACTIVATION_SOFTMAX) {
    return softmaxRows(labels);
  }
  if (activation === CLASS_ACTIVATION_SIGMOID) {
    const out = new Float64Array(labels.data.length);
    for (let i = 0; i < labels.data.length; i += 1) {
      out[i] = 1 / (1 + Math.exp(-(labels.data[i] as number)));
    }
    return out;
  }
  throw new DetectionModelMismatchError(
    `Неподдерживаемая активация классов: ${String(activation)}`,
  );
}

/**
 * Привести боксы `[Q,4]` к `xyxy` в нормализованном диапазоне 0..1 (порт
 * `_boxes_to_norm`). RF-DETR ONNX export отдаёт `cxcywh` в координатах 0..1;
 * старый контракт `xyxy_pixels` поддерживается делением на `resolution`.
 */
export function boxesToNorm(dets: Matrix, resolution: number, boxFormat: BoxFormat): Float64Array {
  const out = new Float64Array(dets.rows * 4);
  if (dets.cols < 4) {
    throw new DetectionModelMismatchError(
      `dets: ожидалась последняя ось >= 4, получено ${dets.cols}`,
    );
  }
  for (let q = 0; q < dets.rows; q += 1) {
    const base = q * dets.cols;
    let rect: Rect;
    if (boxFormat === BOX_FORMAT_CXCYWH_NORMALIZED) {
      rect = cxcywhToXyxy([
        dets.data[base] as number,
        dets.data[base + 1] as number,
        dets.data[base + 2] as number,
        dets.data[base + 3] as number,
      ]);
    } else if (boxFormat === BOX_FORMAT_XYXY_PIXELS) {
      rect = [
        (dets.data[base] as number) / resolution,
        (dets.data[base + 1] as number) / resolution,
        (dets.data[base + 2] as number) / resolution,
        (dets.data[base + 3] as number) / resolution,
      ];
    } else {
      throw new DetectionModelMismatchError(
        `Неподдерживаемый формат координат ONNX-боксов: ${String(boxFormat)}`,
      );
    }
    out[q * 4] = clamp01(rect[0]);
    out[q * 4 + 1] = clamp01(rect[1]);
    out[q * 4 + 2] = clamp01(rect[2]);
    out[q * 4 + 3] = clamp01(rect[3]);
  }
  return out;
}

/** Сырая детекция одной плитки: тип + xyxy в НОРМ-системе плитки (0..1) + score. */
export interface RawTileDet {
  readonly blockType: DetectionBlockType;
  /** [x0, y0, x1, y1] в системе плитки */
  readonly boxNorm: Rect;
  readonly score: number;
}

/**
 * Счётчики `decodeTileOutputs` одной плитки (диагностика; не передан — не считать).
 *
 * `nearFullTile` считается ДО guard'а и для ВСЕХ типов — это сигнал вырожденного
 * паттерна «бокс ~на весь tile» независимо от того, отброшен ли бокс (нужен
 * воркеру для предупреждения о рассинхроне режима обучения/инференса).
 */
export interface TileDecodeStats {
  nearFullTile: Partial<Record<DetectionBlockType, number>>;
  rejectedFullTile: Partial<Record<DetectionBlockType, number>>;
  rejectedMinBox: number;
}

export function newTileDecodeStats(): TileDecodeStats {
  return { nearFullTile: {}, rejectedFullTile: {}, rejectedMinBox: 0 };
}

function bump(counter: Partial<Record<DetectionBlockType, number>>, bt: DetectionBlockType): void {
  counter[bt] = (counter[bt] ?? 0) + 1;
}

/** Дефолты `decode_tile` референса — вынесены в константы, чтобы совпадать с Python. */
export const DEFAULT_MIN_BOX_NORM = 1e-3;
export const DEFAULT_FULL_TILE_MIN_RATIO = 0.9;

export interface DecodeTileOptions {
  readonly classMapping: Readonly<Record<string, number>> | null | undefined;
  readonly resolution: number;
  readonly activation?: ClassActivation;
  readonly numSelect?: number;
  readonly scoreFloor?: number;
  readonly boxFormat?: BoxFormat;
  readonly minBoxNorm?: number;
  /**
   * Защита от подтверждённого вырожденного паттерна модели: на «непохожих на
   * обучающую выборку» плитках почти без содержимого часть запросов RF-DETR
   * выдаёт box ~на весь tile с высоким score (напр. 0.97 для text). Для типов
   * из этого множества бокс, покрывающий >= `fullTileMinRatio` по обеим осям
   * tile, отбрасывается как артефакт. Передавать ТОЛЬКО в настоящем тайловом
   * режиме (>1 плитки): в whole_page полностраничный бокс — валидный результат.
   */
  readonly rejectFullTileTypes?: ReadonlySet<DetectionBlockType>;
  readonly fullTileMinRatio?: number;
  readonly stats?: TileDecodeStats;
}

/**
 * Выходы одной плитки (`dets`/`labels`) → сырые кандидаты (без NMS и per-class
 * порогов) — дословный порт `decode_tile`.
 *
 * Порядок результата: по убыванию score. При РАВНЫХ score порядок среди равных
 * у numpy (`argpartition`+`argsort`) не специфицирован; здесь для
 * детерминизма равные score упорядочены по возрастанию плоского индекса
 * (query*C+col). На вещественных выходах модели точные совпадения score —
 * событие нулевой меры, паритет с Python это не ломает.
 */
export function decodeTileOutputs(
  dets: TensorLike,
  labels: TensorLike,
  options: DecodeTileOptions,
): RawTileDet[] {
  const {
    classMapping,
    resolution,
    activation = CLASS_ACTIVATION_SIGMOID,
    numSelect = 300,
    scoreFloor = 0,
    boxFormat = BOX_FORMAT_CXCYWH_NORMALIZED,
    minBoxNorm = DEFAULT_MIN_BOX_NORM,
    rejectFullTileTypes,
    fullTileMinRatio = DEFAULT_FULL_TILE_MIN_RATIO,
    stats,
  } = options;

  const detsM = toMatrix(dets, 'dets');
  const labelsM = toMatrix(labels, 'labels');
  if (detsM.rows !== labelsM.rows) {
    throw new DetectionModelMismatchError(
      `num_queries рассинхрон: dets=[${detsM.rows},${detsM.cols}] labels=[${labelsM.rows},${labelsM.cols}]`,
    );
  }

  const idToType = invertClassMapping(classMapping);
  if (idToType.size > 0) {
    const maxColumn = Math.max(...idToType.keys());
    if (maxColumn >= labelsM.cols) {
      throw new DetectionModelMismatchError(
        `class_mapping ссылается на столбец ${maxColumn}, а labels имеет только ${labelsM.cols} столбцов`,
      );
    }
  } else {
    return [];
  }

  const probs = activateLogits(labelsM, activation); // [Q*(C+1)]
  const boxes = boxesToNorm(detsM, resolution, boxFormat); // [Q*4] xyxy norm

  const cCount = labelsM.cols;
  const flatSize = probs.length;
  const k = numSelect > 0 ? Math.min(numSelect, flatSize) : flatSize;
  if (k <= 0) {
    return [];
  }
  // top-K по (query × class): сортируем все плоские индексы по убыванию score
  // (эквивалент argpartition+argsort с точностью до порядка равных значений).
  const order = new Uint32Array(flatSize);
  for (let i = 0; i < flatSize; i += 1) {
    order[i] = i;
  }
  const sorted = Array.from(order).sort((a, b) => {
    const diff = (probs[b] as number) - (probs[a] as number);
    return diff !== 0 ? diff : a - b;
  });

  const out: RawTileDet[] = [];
  for (let rank = 0; rank < k; rank += 1) {
    const fi = sorted[rank] as number;
    const score = probs[fi] as number;
    if (score < scoreFloor) {
      break; // top отсортирован по убыванию — дальше только меньше
    }
    const col = fi % cCount;
    const q = (fi - col) / cCount;
    const bt = idToType.get(col);
    if (bt === undefined) {
      continue; // background / no-object / колонка вне class_mapping
    }
    const x0 = boxes[q * 4] as number;
    const y0 = boxes[q * 4 + 1] as number;
    const x1 = boxes[q * 4 + 2] as number;
    const y1 = boxes[q * 4 + 3] as number;
    if (x1 - x0 < minBoxNorm || y1 - y0 < minBoxNorm) {
      if (stats) {
        stats.rejectedMinBox += 1;
      }
      continue; // вырожденный/слишком тонкий бокс
    }
    const nearFull = x1 - x0 >= fullTileMinRatio && y1 - y0 >= fullTileMinRatio;
    if (nearFull && stats) {
      bump(stats.nearFullTile, bt);
    }
    if (nearFull && rejectFullTileTypes?.has(bt)) {
      if (stats) {
        bump(stats.rejectedFullTile, bt);
      }
      continue;
    }
    out.push({ blockType: bt, boxNorm: [x0, y0, x1, y1], score });
  }
  return out;
}
