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
  type InferenceMode,
  type InferenceParams,
  type ModeSource,
  type TileInferenceResult,
} from '@id/detection';

import {
  cropTileRgb,
  FULL_DECODE_MAX_PIXELS,
  preprocessTile,
  readPageRgb,
  readTileRgb,
  tileLumaStats,
  type PageRgb,
} from './preprocess.js';
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
  /**
   * Режим инференса из настроек портала: `auto` — решать по манифесту.
   *
   * Не `InferenceParams`, потому что это не свойство модели, а решение
   * оператора о том, как её сегодня применяют (`detection.inference_mode`).
   */
  readonly inferenceMode?: InferenceMode | typeof INFERENCE_MODE_AUTO;
}

export interface DetectPageResult {
  readonly candidates: readonly Candidate[];
  readonly stats: DetectPageStats;
  /** Текст предупреждения о рассинхроне режима тайлинга или `null`. */
  readonly warning: string | null;
  /** Какой режим применён и чем он решён — уходит в лог и снимок прогона. */
  readonly mode: InferenceMode;
  readonly modeSource: ModeSource;
}

/**
 * Детекция одной страницы: план плиток → (blank-skip) → препроцессинг →
 * ONNX → числовой постпроцесс `@id/detection`.
 *
 * Режим инференса по умолчанию `auto` — тогда `resolveInferenceMode` выбирает
 * между `tiles`/`whole_page` по `params.trainingMode` манифеста. Явное
 * значение приходит из настройки `detection.inference_mode` и работает как
 * kill-switch: он нужен ровно тогда, когда манифест описывает режим обучения
 * неверно, а инференс обязан идти в масштабе кадра обучения — иначе RF-DETR
 * выдаёт вырожденные боксы ~на весь кадр. Такая же ручка есть в настройках
 * эталонного RD WEB.
 */
export async function detectPage(input: DetectPageInput): Promise<DetectPageResult> {
  const { pageIndex, pngPath, widthPx, heightPx, session, params } = input;
  const requestedMode = input.inferenceMode ?? INFERENCE_MODE_AUTO;

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
    const degenerate = resolveInferenceMode(requestedMode, params.trainingMode);
    return {
      candidates: empty.candidates,
      stats: empty.stats,
      warning: null,
      mode: degenerate.mode,
      modeSource: degenerate.source,
    };
  }

  const resolvedMode = resolveInferenceMode(requestedMode, params.trainingMode);
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

  /**
   * Кадр разворачивается ОДИН раз, если влезает в память (S50).
   *
   * Сетка 1024/128 на A4-скане даёт двенадцать плиток, и прежде каждая
   * открывала PNG заново: страница декодировалась около восьми раз целиком —
   * при том, что весь её растр это 26 МБ. На боевой папке из 220 таких листов
   * детекция шла 39 минут, и заметная часть этого времени уходила на повторный
   * декод одного и того же файла.
   *
   * Крупный формат идёт прежним путём: там довод про память остаётся в силе
   * (см. `FULL_DECODE_MAX_PIXELS`). Одна плитка на страницу тоже: разворачивать
   * кадр целиком, чтобы вырезать из него всю страницу, — лишняя копия.
   */
  const fullFrame: PageRgb | null =
    isTiledMode && widthPx * heightPx <= FULL_DECODE_MAX_PIXELS ? await readPageRgb(pngPath) : null;
  // Растр разошёлся с ожидаемым размером страницы — режем прежним способом:
  // вырезка из чужого кадра дала бы модели сдвинутую картинку молча.
  const frame =
    fullFrame !== null && fullFrame.width === widthPx && fullFrame.height === heightPx
      ? fullFrame
      : null;

  const tiles: TileInferenceResult[] = [];
  for (const tile of plannedTiles) {
    const region = {
      x0: tile.x0,
      y0: tile.y0,
      width: tile.width,
      height: tile.height,
    };
    const rgb = frame === null ? await readTileRgb(pngPath, region) : cropTileRgb(frame, region);

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
    mode: resolvedMode.mode,
    modeSource: resolvedMode.source,
  };
}
