/**
 * Контракт `onnx_export_manifest.json` + разбор в параметры инференса.
 *
 * Порт `model_params.py` + валидационных правил `model_publish.validate_manifest`
 * референса RD WEB. Принцип «manifest-driven inference» (ADR-0008): активация,
 * формат боксов, top-K, тайлинг и пороги приходят из манифеста модели, а не из
 * хардкода — retrain с другими параметрами не требует правок воркера.
 *
 * ## Открытый мир, но известные поля — жёстко
 *
 * Незнакомые поля манифеста НЕ отвергаются (`looseObject`): манифест пишет
 * тренер RD WEB и добавляет поля быстрее, чем портал успевает их выучить.
 * Известные же поля валидируются жёстко — здесь порт СТРОЖЕ референсного
 * `manifest_params`, который на мусорные `tiling.tile_size`/`overlap`/`num_select`
 * молча подставлял дефолты: молчаливая подмена геометрии тайлинга меняет
 * результат детекции незаметно, поэтому «поле есть, но битое» — ошибка манифеста.
 * Исключение — `tiling.mode`: неизвестный режим обучения трактуется как
 * отсутствующий (legacy), как в референсе («инференс не валим» — новые режимы
 * тренера не должны отключать детекцию; у резолва режима есть безопасный fallback).
 *
 * ## Пороги в манифесте
 *
 * В RD WEB per-class пороги и NMS IoU живут в настройках сервиса; у портала
 * настроек детекции нет — блок `thresholds`/`nms_iou`/`merge_split_text`/
 * `max_detections` читается из манифеста (расширение портала, опциональное),
 * дефолты равны дефолтам referens-сервиса.
 */

import { z } from 'zod';

import {
  BOX_FORMAT_CXCYWH_NORMALIZED,
  BOX_FORMAT_XYXY_PIXELS,
  CLASS_ACTIVATION_SIGMOID,
  CLASS_ACTIVATION_SOFTMAX,
  DETECTION_BLOCK_TYPES,
  type BoxFormat,
  type ClassActivation,
  type DetectionBlockType,
} from './postprocess.js';

/** Дефолты тайлинга/постобработки — fallback, когда манифест их не задаёт (как в референсе). */
export const DEFAULT_TILE_SIZE = 1024;
export const DEFAULT_OVERLAP = 128;
export const DEFAULT_NUM_SELECT = 300;
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_NMS_IOU = 0.5;

/** Режимы инференса: `auto` выбирает по манифесту модели, остальные — принудительный override. */
export const INFERENCE_MODE_AUTO = 'auto';
export const INFERENCE_MODE_TILES = 'tiles';
export const INFERENCE_MODE_WHOLE_PAGE = 'whole_page';
export type InferenceMode = typeof INFERENCE_MODE_TILES | typeof INFERENCE_MODE_WHOLE_PAGE;

/** Допустимые значения `tiling.mode` манифеста (режим сборки датасета обучения). */
export const TRAINING_MODE_WHOLE_PAGE = 'whole_page';
export const TRAINING_MODES_TILED: ReadonlySet<string> = new Set(['tiles', 'whole_page_and_tiles']);
export const TRAINING_MODE_VALUES: ReadonlySet<string> = new Set([
  TRAINING_MODE_WHOLE_PAGE,
  ...TRAINING_MODES_TILED,
]);
export type TrainingMode = 'whole_page' | 'tiles' | 'whole_page_and_tiles';

/** Источники решения `resolveInferenceMode` (для логов/диагностики воркера). */
export const MODE_SOURCE_SETTINGS = 'settings_forced';
export const MODE_SOURCE_MANIFEST = 'manifest';
export const MODE_SOURCE_LEGACY = 'legacy_default';
export type ModeSource =
  typeof MODE_SOURCE_SETTINGS | typeof MODE_SOURCE_MANIFEST | typeof MODE_SOURCE_LEGACY;

const finiteNumber = z.number().finite();
const positiveInt = z.int().positive();
const unitInterval = finiteNumber.min(0).max(1);
const rgbTriple = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const boxFormatSchema = z.enum([BOX_FORMAT_CXCYWH_NORMALIZED, BOX_FORMAT_XYXY_PIXELS]);
const activationSchema = z.enum([CLASS_ACTIVATION_SIGMOID, CLASS_ACTIVATION_SOFTMAX]);

/**
 * Схема `onnx_export_manifest.json`.
 *
 * Обязательные поля — как в `validate_manifest` референса: `num_classes`,
 * `resolution`, `class_mapping`, `preprocessing.mean/std`. Всё остальное
 * опционально с дефолтами RF-DETR-контракта.
 */
export const detectionManifestSchema = z
  .looseObject({
    num_classes: positiveInt,
    resolution: positiveInt,
    /**
     * `{имя_класса: столбец labels}`. Валидатор ниже требует хотя бы один из
     * известных порталу классов (text/image/stamp) и запрещает двум известным
     * классам делить столбец: в референсе такой манифест «работал», молча
     * теряя один тип блоков (`invert_class_mapping` перезаписывает индекс), —
     * для портала это ошибка конфигурации, а не режим работы.
     */
    class_mapping: z.record(z.string(), z.int().nonnegative()),
    preprocessing: z.looseObject({
      mean: rgbTriple,
      std: rgbTriple,
      input_name: z.string().min(1).optional(),
    }),
    box_format: boxFormatSchema.optional(),
    /** Старые манифесты клали box_format в блок outputs. */
    outputs: z.looseObject({ box_format: boxFormatSchema.optional() }).optional(),
    score_activation: activationSchema.optional(),
    /** Синоним score_activation в старых манифестах. */
    class_activation: activationSchema.optional(),
    num_select: positiveInt.optional(),
    logits_size: positiveInt.optional(),
    dynamic_batch: z.boolean().optional(),
    manifest_version: positiveInt.optional(),
    onnx_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'onnx_sha256 должен быть 64 символа lowercase hex')
      .optional(),
    tiling: z
      .looseObject({
        tile_size: positiveInt.optional(),
        overlap: z.int().nonnegative().optional(),
        /**
         * Режим сборки датасета обучения. Неизвестное значение НЕ отвергается
         * (см. шапку файла): нормализация в известное множество — в
         * `manifestParams`, незнакомый режим = legacy (null).
         */
        mode: z.string().optional(),
        min_visibility: unitInterval.optional(),
      })
      .optional(),
    /** Расширение портала: per-class пороги и дефолтный порог принятия детекции. */
    thresholds: z
      .looseObject({
        default: unitInterval.optional(),
        per_class: z.record(z.string(), unitInterval).optional(),
      })
      .optional(),
    /** Расширение портала: параметры page-level постобработки. */
    nms_iou: unitInterval.optional(),
    merge_split_text: z.boolean().optional(),
    max_detections: positiveInt.optional(),
  })
  .superRefine((m, ctx) => {
    const entries = Object.entries(m.class_mapping);
    if (entries.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['class_mapping'],
        message: 'class_mapping должен быть непустым объектом {name: id}',
      });
      return;
    }
    const maxColumn = Math.max(...entries.map(([, idx]) => idx));
    // Последний столбец labels — no-object, поэтому допустимый диапазон — num_classes+1.
    if (maxColumn >= m.num_classes + 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['class_mapping'],
        message: `class_mapping ссылается на столбец ${maxColumn} вне диапазона labels (num_classes+1)`,
      });
    }
    if (m.logits_size !== undefined && maxColumn >= m.logits_size) {
      ctx.addIssue({
        code: 'custom',
        path: ['logits_size'],
        message: 'logits_size должен быть больше максимального id в class_mapping',
      });
    }
    const known = entries.filter(([name]) =>
      (DETECTION_BLOCK_TYPES as readonly string[]).includes(name),
    );
    if (known.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['class_mapping'],
        message: `class_mapping не содержит ни одного известного класса (${DETECTION_BLOCK_TYPES.join('/')})`,
      });
    }
    const seen = new Map<number, string>();
    for (const [name, idx] of known) {
      const other = seen.get(idx);
      if (other !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['class_mapping'],
          message: `классы ${other} и ${name} делят столбец ${idx}`,
        });
      }
      seen.set(idx, name);
    }
    // ImageNet-нормализация делит на std — ноль дал бы Infinity в тензоре.
    if (m.preprocessing.std.some((v) => v === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['preprocessing', 'std'],
        message: 'preprocessing.std не может содержать 0',
      });
    }
    const tileSize = m.tiling?.tile_size ?? DEFAULT_TILE_SIZE;
    const overlap = m.tiling?.overlap;
    if (overlap !== undefined && overlap >= tileSize) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiling', 'overlap'],
        message: `overlap (${overlap}) должен быть меньше tile_size (${tileSize})`,
      });
    }
  });

export type DetectionManifest = z.infer<typeof detectionManifestSchema>;

/** Разобрать сырой JSON манифеста (`unknown`) с жёсткой валидацией известных полей. */
export function parseDetectionManifest(raw: unknown): DetectionManifest {
  return detectionManifestSchema.parse(raw);
}

/** Типизированные параметры инференса, извлечённые из манифеста (+ fallback-дефолты). */
export interface InferenceParams {
  readonly mean: readonly [number, number, number];
  readonly std: readonly [number, number, number];
  readonly inputName: string;
  readonly boxFormat: BoxFormat;
  readonly activation: ClassActivation;
  readonly numSelect: number;
  readonly tileSize: number;
  readonly overlap: number;
  readonly resolution: number;
  readonly numClasses: number;
  readonly dynamicBatch: boolean;
  readonly classMapping: Readonly<Record<string, number>>;
  /** Режим сборки датасета обучения (`null` — legacy-манифест без режима). */
  readonly trainingMode: TrainingMode | null;
  readonly minVisibility: number | null;
  /** Per-class пороги принятия; отсутствующий класс использует `defaultThreshold`. */
  readonly thresholds: Readonly<Partial<Record<DetectionBlockType, number>>>;
  readonly defaultThreshold: number;
  readonly nmsIou: number;
  readonly mergeSplitText: boolean;
  readonly maxDetections: number | null;
}

/**
 * Достать параметры входа/боксов/классов/тайлинга из валидного манифеста —
 * порт `manifest_params` (дефолты идентичны референсу).
 */
export function manifestParams(manifest: DetectionManifest): InferenceParams {
  const boxFormat =
    manifest.box_format ?? manifest.outputs?.box_format ?? BOX_FORMAT_CXCYWH_NORMALIZED;
  const activation =
    manifest.score_activation ?? manifest.class_activation ?? CLASS_ACTIVATION_SIGMOID;
  const tiling = manifest.tiling;
  const modeRaw = tiling?.mode;
  // Мусорный/неизвестный mode трактуем как отсутствующий (legacy) — как в референсе.
  const trainingMode =
    modeRaw !== undefined && TRAINING_MODE_VALUES.has(modeRaw) ? (modeRaw as TrainingMode) : null;

  const thresholds: Partial<Record<DetectionBlockType, number>> = {};
  for (const [name, value] of Object.entries(manifest.thresholds?.per_class ?? {})) {
    // Неизвестные имена классов пропускаются — как разбор per_type_thresholds в референс-сервисе.
    if ((DETECTION_BLOCK_TYPES as readonly string[]).includes(name)) {
      thresholds[name as DetectionBlockType] = value;
    }
  }

  return {
    mean: manifest.preprocessing.mean,
    std: manifest.preprocessing.std,
    inputName: manifest.preprocessing.input_name ?? 'input',
    boxFormat,
    activation,
    numSelect: manifest.num_select ?? DEFAULT_NUM_SELECT,
    tileSize: tiling?.tile_size ?? DEFAULT_TILE_SIZE,
    overlap: tiling?.overlap ?? DEFAULT_OVERLAP,
    resolution: manifest.resolution,
    numClasses: manifest.num_classes,
    dynamicBatch: manifest.dynamic_batch ?? false,
    classMapping: manifest.class_mapping,
    trainingMode,
    minVisibility: tiling?.min_visibility ?? null,
    thresholds,
    defaultThreshold: manifest.thresholds?.default ?? DEFAULT_THRESHOLD,
    nmsIou: manifest.nms_iou ?? DEFAULT_NMS_IOU,
    mergeSplitText: manifest.merge_split_text ?? false,
    maxDetections: manifest.max_detections ?? null,
  };
}

/** Эффективный режим инференса и источник решения. */
export interface ResolvedMode {
  readonly mode: InferenceMode;
  readonly source: ModeSource;
  readonly trainingMode: TrainingMode | null;
}

/**
 * Выбрать эффективный режим: явная настройка — форс, `auto` — по режиму
 * обучения модели (порт `resolve_inference_mode`).
 *
 * Ключевой контракт: инференс обязан работать в том же масштабе кадра, что и
 * обучение — модель, обученная на целых страницах, на тайлах выдаёт
 * вырожденные боксы ~на весь tile. Legacy-манифест без `tiling.mode` при
 * `auto` → `tiles` (историческое поведение); вызывающий обязан залогировать
 * WARNING — режим обучения неизвестен и рассинхрон масштаба не исключён.
 */
export function resolveInferenceMode(
  configured: string,
  trainingMode: TrainingMode | null,
): ResolvedMode {
  if (configured === INFERENCE_MODE_TILES || configured === INFERENCE_MODE_WHOLE_PAGE) {
    return { mode: configured, source: MODE_SOURCE_SETTINGS, trainingMode };
  }
  if (trainingMode === TRAINING_MODE_WHOLE_PAGE) {
    return { mode: INFERENCE_MODE_WHOLE_PAGE, source: MODE_SOURCE_MANIFEST, trainingMode };
  }
  if (trainingMode !== null && TRAINING_MODES_TILED.has(trainingMode)) {
    return { mode: INFERENCE_MODE_TILES, source: MODE_SOURCE_MANIFEST, trainingMode };
  }
  return { mode: INFERENCE_MODE_TILES, source: MODE_SOURCE_LEGACY, trainingMode: null };
}
