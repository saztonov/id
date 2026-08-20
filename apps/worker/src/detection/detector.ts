/**
 * Оркестрация «страница → кандидаты блоков» (ADR-0008).
 *
 * Склеивает числовую логику `@id/detection` с пиксельным препроцессингом
 * (`preprocess.ts`) и портом инференса (`session.ts`): планирует плитки,
 * пропускает пустые (только в настоящем тайловом режиме), прогоняет каждую
 * через ONNX-сессию и сдаёт сырые тензоры `detectPageFromTiles` — числовому
 * пути пакета, который делает NMS/склейку/пороги и отдаёт нормализованные
 * координаты страницы.
 */
import {
  detectPageFromTiles,
  INFERENCE_MODE_AUTO,
  isBlankTile,
  modeMismatchWarning,
  planPageTiles,
  resolveInferenceMode,
  type Candidate,
  type DetectPageStats,
  type InferenceParams,
  type TileInferenceResult,
} from '@id/detection';

import { preprocessTile, readTileRgb, tileLumaStats } from './preprocess.js';
import type { OnnxSessionPort } from './session.js';

export interface DetectPageInput {
  /**
   * Только для текста предупреждения (`modeMismatchWarning` вставляет номер
   * страницы в сообщение) — числовая логика страницы его не требует.
   */
  readonly pageIndex: number;
  readonly pngPath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly session: OnnxSessionPort;
  readonly params: InferenceParams;
}

export interface DetectPageResult {
  readonly candidates: readonly Candidate[];
  readonly stats: DetectPageStats;
  /** Текст предупреждения о рассинхроне режима тайлинга или `null`. */
  readonly warning: string | null;
}

/**
 * Детекция одной страницы: план плиток → (blank-skip) → препроцессинг →
 * ONNX → числовой постпроцесс `@id/detection`.
 *
 * Режим инференса всегда `auto`: у портала нет собственной настройки
 * `detection.inference_mode` (манифест — единственный источник правды, ADR-0008),
 * поэтому `resolveInferenceMode` выбирает между `tiles`/`whole_page` только по
 * `params.trainingMode` манифеста.
 */
export async function detectPage(input: DetectPageInput): Promise<DetectPageResult> {
  const { pageIndex, pngPath, widthPx, heightPx, session, params } = input;

  // Паритет с `detectPageFromTiles` референса: некорректные размеры страницы
  // дают пустой результат, а не исключение. Проверка здесь обязательна —
  // `planPageTiles`/`planInferenceTiles` на `<=0` бросает `RangeError`, у него
  // нет своего «пустого» пути.
  if (widthPx <= 0 || heightPx <= 0) {
    const empty = detectPageFromTiles({
      pageWidth: widthPx,
      pageHeight: heightPx,
      plannedTileCount: 0,
      tiles: [],
      params,
    });
    return { candidates: empty.candidates, stats: empty.stats, warning: null };
  }

  const resolvedMode = resolveInferenceMode(INFERENCE_MODE_AUTO, params.trainingMode);
  const plannedTiles = planPageTiles(widthPx, heightPx, {
    tileSize: params.tileSize,
    overlap: params.overlap,
    mode: resolvedMode.mode,
  });
  // Blank-tile skip действует только в НАСТОЯЩЕМ тайловом режиме (>1 плитки):
  // единственная whole_page-плитка обязана детектироваться всегда — иначе
  // страница с малым контрастом (скан под углом, светлая печать) пропала бы
  // из-за своего же единственного «тайла», принятого за пустой.
  const isTiledMode = plannedTiles.length > 1;

  const tiles: TileInferenceResult[] = [];
  for (const tile of plannedTiles) {
    const rgb = await readTileRgb(pngPath, {
      x0: tile.x0,
      y0: tile.y0,
      width: tile.width,
      height: tile.height,
    });

    if (isTiledMode) {
      const luma = tileLumaStats(rgb);
      if (isBlankTile(luma.std)) continue;
    }

    const modelInput = await preprocessTile(rgb, {
      mean: params.mean,
      std: params.std,
      resolution: params.resolution,
    });
    const output = await session.run(modelInput);
    tiles.push({ tile, dets: output.dets, labels: output.labels });
  }

  const result = detectPageFromTiles({
    pageWidth: widthPx,
    pageHeight: heightPx,
    plannedTileCount: plannedTiles.length,
    tiles,
    params,
  });

  return {
    candidates: result.candidates,
    stats: result.stats,
    warning: modeMismatchWarning(result.stats, pageIndex),
  };
}
