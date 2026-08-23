/**
 * Оркестрация уровня «страница из тайлов» — чистая числовая часть
 * `service._run_page` референса RD WEB (без пикселей и без ONNX-сессии).
 *
 * Воркер: планирует плитки (`planPageTiles`), режет/препроцессит PNG, гоняет
 * onnxruntime-node и передаёт сюда сырые тензоры по каждой НЕпустой плитке.
 * Пакет: decode per-tile → масштаб в пиксели плитки → remap в страницу →
 * class-aware NMS → (опц.) склейка text → per-class пороги → cap →
 * нормализованные кандидаты страницы. Порядок стадий — в точности как в
 * `_run_page` (паритет с тренером RD WEB).
 */

import type { InferenceParams } from './manifest.js';
import {
  capDetections,
  classAwareNms,
  filterByClassThreshold,
  mergeSplitTextBoxes,
  type PixelDet,
} from './nms.js';
import { clamp01, type Rect } from './geometry.js';
import {
  decodeTileOutputs,
  newTileDecodeStats,
  type DetectionBlockType,
  type TensorLike,
} from './postprocess.js';
import { remapRectToPage, type InferenceTile } from './tiling.js';

/** Кандидат блока: тип, нормализованные координаты страницы 0..1 (xyxy), уверенность. */
export interface Candidate {
  readonly blockType: DetectionBlockType;
  readonly coordsNorm: [number, number, number, number];
  readonly score: number;
}

/** Результат инференса одной плитки: сама плитка + сырые выходы графа. */
export interface TileInferenceResult {
  readonly tile: InferenceTile;
  /** `[Q,4]` или `[1,Q,4]` — формат по манифесту (`box_format`). */
  readonly dets: TensorLike;
  /** `[Q,C+1]` или `[1,Q,C+1]` — логиты классов, последний столбец no-object. */
  readonly labels: TensorLike;
}

/** Счётчики прогона страницы (порт `PageRunStats`, без логирования — оно у воркера). */
export interface DetectPageStats {
  /** Сколько плиток было спланировано (включая пропущенные как пустые). */
  tilesPlanned: number;
  /** Сколько плиток реально пришло на декод. */
  tilesInferred: number;
  rawByType: Partial<Record<DetectionBlockType, number>>;
  /**
   * Число ПЛИТОК (не боксов), где декод видел >=1 бокс ~на весь tile данного
   * типа — ДО full-tile guard'а, т.е. включая отброшенные (сигнал вырожденного
   * паттерна «модель whole_page на тайловом инференсе»).
   */
  tilesWithNearFullTile: Partial<Record<DetectionBlockType, number>>;
  rejectedFullTile: Partial<Record<DetectionBlockType, number>>;
  rejectedMinBox: number;
  afterNms: number;
  afterMerge: number | null;
  afterThreshold: number;
  finalByType: Partial<Record<DetectionBlockType, number>>;
  /**
   * Лучшая уверенность среди кандидатов, ОТБРОШЕННЫХ порогом принятия, по типам.
   *
   * Единственное число, отвечающее на вопрос «поможет ли снизить порог». Без
   * него «страница не обведена» остаётся утверждением без величины за ним:
   * пустой результат одинаково выглядит и когда модель не увидела ничего
   * (лучший отброшенный ~0), и когда она увидела блок с уверенностью 0.49 при
   * пороге 0.5. Решения оператора в этих двух случаях противоположны.
   *
   * Собирается из ДВУХ мест, потому что порог режет дважды. Первый рез — на
   * плитке (`scoreFloor` в `decodeTileOutputs`): туда кандидат ниже порога не
   * доживает вовсе, и страничный фильтр его уже не увидит. Второй — на
   * странице (`filterByClassThreshold`), где отсекается то, что прошло общий
   * порог, но не прошло порог своего типа. Учитывать только второй значило бы
   * отвечать «модель не видела ничего» в самом частом случае.
   *
   * Вырожденные боксы и отбракованные full-tile guard'ом сюда не попадают:
   * «лучший непринятый» обязан быть боксом, который приняли бы, будь порог
   * ниже, иначе число вводило бы в заблуждение.
   */
  bestRejectedScore: Partial<Record<DetectionBlockType, number>>;
}

/** Минимум плиток с ~full-tile боксами одного типа для предупреждения о рассинхроне. */
export const MODE_MISMATCH_MIN_TILES = 3;

/**
 * Текст предупреждения о вероятном рассинхроне режима обучения/инференса (или
 * `null`) — порт `diagnostics.mode_mismatch_warning`. Срабатывает только в
 * настоящем тайловом режиме (>1 плитки).
 */
export function modeMismatchWarning(
  stats: DetectPageStats,
  pageIndex: number,
  minTiles: number = MODE_MISMATCH_MIN_TILES,
): string | null {
  if (stats.tilesPlanned <= 1) {
    return null;
  }
  const hot = Object.entries(stats.tilesWithNearFullTile)
    .filter(([, n]) => (n ?? 0) >= Math.max(1, minTiles))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (hot.length === 0) {
    return null;
  }
  const perType = hot.map(([name, n]) => `${name}: ${n}/${stats.tilesPlanned} плиток`).join(', ');
  return (
    `Страница ${pageIndex}: детекции ~на весь тайл (${perType}) — вероятен рассинхрон ` +
    'режима обучения и инференса (модель whole_page на тайловом инференсе). Проверьте ' +
    'tiling.mode манифеста модели и настройку detection.inference_mode.'
  );
}

export interface DetectPageInput {
  readonly pageWidth: number;
  readonly pageHeight: number;
  /**
   * Полное число спланированных плиток (`planPageTiles(...).length`) — оно
   * управляет full-tile guard'ом и НЕ равно `tiles.length`, если воркер
   * пропустил пустые плитки (blank-skip).
   */
  readonly plannedTileCount: number;
  /** Результаты инференса по непустым плиткам. */
  readonly tiles: readonly TileInferenceResult[];
  readonly params: InferenceParams;
}

export interface DetectPageResult {
  readonly candidates: Candidate[];
  readonly stats: DetectPageStats;
}

function bump(
  counter: Partial<Record<DetectionBlockType, number>>,
  bt: DetectionBlockType,
  by = 1,
): void {
  counter[bt] = (counter[bt] ?? 0) + by;
}

/**
 * Собрать кандидатов страницы из результатов инференса плиток.
 *
 * Числовой паритет с `_run_page`:
 * - порог сбора per-tile — минимальный операционный
 *   (`min(defaultThreshold, *thresholds)`), per-class фильтр применяется
 *   на уровне страницы;
 * - full-tile guard включается только при >1 спланированной плитки и только
 *   для класса text (легитимный TEXT-блок физически не занимает весь tile;
 *   в whole_page-режиме полностраничный текст — валидный результат);
 * - нормализованные боксы плитки масштабируются на РЕАЛЬНЫЕ размеры плитки
 *   (крайние плитки не квадратные), затем ремапятся в пиксели страницы;
 * - страница с некорректными размерами дает пустой результат (не исключение) —
 *   как в референсе.
 */
export function detectPageFromTiles(input: DetectPageInput): DetectPageResult {
  const { pageWidth, pageHeight, plannedTileCount, tiles, params } = input;

  const thresholdValues = Object.values(params.thresholds).filter(
    (v): v is number => typeof v === 'number',
  );
  const floor =
    thresholdValues.length > 0
      ? Math.min(params.defaultThreshold, ...thresholdValues)
      : params.defaultThreshold;

  const stats: DetectPageStats = {
    tilesPlanned: plannedTileCount,
    tilesInferred: tiles.length,
    rawByType: {},
    tilesWithNearFullTile: {},
    rejectedFullTile: {},
    rejectedMinBox: 0,
    afterNms: 0,
    afterMerge: null,
    afterThreshold: 0,
    finalByType: {},
    bestRejectedScore: {},
  };
  if (pageWidth <= 0 || pageHeight <= 0) {
    return { candidates: [], stats };
  }

  const rejectFullTileTypes: ReadonlySet<DetectionBlockType> =
    plannedTileCount > 1 ? new Set<DetectionBlockType>(['text']) : new Set<DetectionBlockType>();

  const pixelDets: PixelDet[] = [];
  for (const { tile, dets, labels } of tiles) {
    const tileStats = newTileDecodeStats();
    const raw = decodeTileOutputs(dets, labels, {
      classMapping: params.classMapping,
      resolution: params.resolution,
      activation: params.activation,
      numSelect: params.numSelect,
      scoreFloor: floor,
      boxFormat: params.boxFormat,
      rejectFullTileTypes,
      stats: tileStats,
    });
    // Агрегация как в diagnostics.note_tile.
    for (const det of raw) {
      bump(stats.rawByType, det.blockType);
    }
    for (const [bt, count] of Object.entries(tileStats.nearFullTile)) {
      if ((count ?? 0) > 0) {
        bump(stats.tilesWithNearFullTile, bt as DetectionBlockType);
      }
    }
    for (const [bt, count] of Object.entries(tileStats.rejectedFullTile)) {
      bump(stats.rejectedFullTile, bt as DetectionBlockType, count ?? 0);
    }
    stats.rejectedMinBox += tileStats.rejectedMinBox;
    // Лучший непринятый по плиткам — максимум: страница отвечает за весь лист,
    // а плитка знает только свой кусок.
    for (const [bt, score] of Object.entries(tileStats.bestBelowFloor)) {
      const type = bt as DetectionBlockType;
      const best = stats.bestRejectedScore[type];
      if (score !== undefined && (best === undefined || score > best)) {
        stats.bestRejectedScore[type] = score;
      }
    }

    const tw = tile.width;
    const th = tile.height;
    for (const rd of raw) {
      const local: Rect = [
        rd.boxNorm[0] * tw,
        rd.boxNorm[1] * th,
        rd.boxNorm[2] * tw,
        rd.boxNorm[3] * th,
      ];
      const px = remapRectToPage(local, tile, pageWidth, pageHeight);
      pixelDets.push({
        blockType: rd.blockType,
        x0: px[0],
        y0: px[1],
        x1: px[2],
        y1: px[3],
        score: rd.score,
      });
    }
  }

  // Постобработка в пикселях страницы (паритет с тренером): NMS → merge → пороги → cap.
  let final = classAwareNms(pixelDets, { iouThreshold: params.nmsIou });
  stats.afterNms = final.length;
  if (params.mergeSplitText) {
    final = mergeSplitTextBoxes(final);
    stats.afterMerge = final.length;
  }
  const beforeThreshold = final;
  final = filterByClassThreshold(final, params.thresholds, params.defaultThreshold);
  stats.afterThreshold = final.length;
  // Лучший отброшенный порогом — по разнице множеств, а не по повторному
  // проходу с другим порогом: второй прогон фильтра ответил бы на вопрос «что
  // прошло бы при пороге X», а нужен ответ «насколько близко было то, что не
  // прошло», и он не зависит от гипотетического X.
  const accepted = new Set(final);
  for (const det of beforeThreshold) {
    if (accepted.has(det)) continue;
    const best = stats.bestRejectedScore[det.blockType];
    if (best === undefined || det.score > best) {
      stats.bestRejectedScore[det.blockType] = det.score;
    }
  }
  final = capDetections(final, params.maxDetections);

  const candidates: Candidate[] = [];
  for (const d of final) {
    bump(stats.finalByType, d.blockType);
    candidates.push({
      blockType: d.blockType,
      coordsNorm: [
        clamp01(d.x0 / pageWidth),
        clamp01(d.y0 / pageHeight),
        clamp01(d.x1 / pageWidth),
        clamp01(d.y1 / pageHeight),
      ],
      score: d.score,
    });
  }
  return { candidates, stats };
}
