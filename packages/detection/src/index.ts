/**
 * `@id/detection` — чистая числовая логика локальной детекции RF-DETR.
 *
 * Порт референса `temp/RDNEW/services/web_ocr/detection/` (Python) без
 * нативных зависимостей: манифест-контракт, тайлинг, постпроцессинг выходов
 * ONNX, NMS/склейка/пороги и оркестрация уровня страницы. Растеризация,
 * препроцессинг пикселей и onnxruntime-node остаются в `apps/worker`.
 */

export {
  clamp01,
  cxcywhToXyxy,
  rectArea,
  rectIntersection,
  rectIou,
  xyxyToCxcywh,
  type Rect,
} from './geometry.js';
export {
  BOX_FORMAT_CXCYWH_NORMALIZED,
  BOX_FORMAT_XYXY_PIXELS,
  CLASS_ACTIVATION_SIGMOID,
  CLASS_ACTIVATION_SOFTMAX,
  DEFAULT_FULL_TILE_MIN_RATIO,
  DEFAULT_MIN_BOX_NORM,
  DETECTION_BLOCK_TYPES,
  DetectionModelMismatchError,
  activateLogits,
  boxesToNorm,
  decodeTileOutputs,
  invertClassMapping,
  newTileDecodeStats,
  toMatrix,
  type BoxFormat,
  type ClassActivation,
  type DecodeTileOptions,
  type DetectionBlockType,
  type Matrix,
  type RawTileDet,
  type TensorLike,
  type TensorWithDims,
  type TileDecodeStats,
} from './postprocess.js';
export {
  DEFAULT_NMS_IOU,
  DEFAULT_NUM_SELECT,
  DEFAULT_OVERLAP,
  DEFAULT_THRESHOLD,
  DEFAULT_TILE_SIZE,
  INFERENCE_MODE_AUTO,
  INFERENCE_MODE_TILES,
  INFERENCE_MODE_WHOLE_PAGE,
  MODE_SOURCE_LEGACY,
  MODE_SOURCE_MANIFEST,
  MODE_SOURCE_SETTINGS,
  TRAINING_MODES_TILED,
  TRAINING_MODE_VALUES,
  TRAINING_MODE_WHOLE_PAGE,
  detectionManifestSchema,
  manifestParams,
  parseDetectionManifest,
  resolveInferenceMode,
  type DetectionManifest,
  type InferenceMode,
  type InferenceParams,
  type ModeSource,
  type ResolvedMode,
  type TrainingMode,
} from './manifest.js';
export {
  BLANK_TILE_STD_THRESHOLD,
  isBlankTile,
  pilGrayscaleLuma,
  planInferenceTiles,
  planPageTiles,
  remapRectToPage,
  wholePageTile,
  type InferenceTile,
} from './tiling.js';
export {
  capDetections,
  classAwareNms,
  filterByClassThreshold,
  mergeSplitTextBoxes,
  pixelDetRect,
  type PixelDet,
} from './nms.js';
export {
  MODE_MISMATCH_MIN_TILES,
  detectPageFromTiles,
  modeMismatchWarning,
  type Candidate,
  type DetectPageInput,
  type DetectPageResult,
  type DetectPageStats,
  type TileInferenceResult,
} from './detect.js';
export {
  NO_PARAM_OVERRIDES,
  applyParamOverrides,
  describeAppliedOverrides,
  type InferenceParamOverrides,
} from './overrides.js';
