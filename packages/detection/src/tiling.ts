/**
 * Разбиение страницы на tiles для инференса и обратный перевод координат.
 *
 * Порт `temp/RDNEW/services/web_ocr/detection/tiling.py` + правила выбора
 * плиток и blank-tile критерий из `service.py._run_page`/`_is_blank_tile`.
 *
 * Большие листы РД детектируются по кусочкам (tiles с overlap), после чего
 * координаты каждой детекции переводятся из локальной системы tile обратно в
 * пиксели страницы; дубли в зонах перекрытия снимаются NMS (`nms.ts`). Сетка
 * тайлов совпадает с той, что тренер использует при нарезке датасета, поэтому
 * масштаб инференса = масштабу обучения.
 */

import { INFERENCE_MODE_WHOLE_PAGE, type InferenceMode } from './manifest.js';
import type { Rect } from './geometry.js';

/** Прямоугольная область страницы в пикселях: `[x0, y0)` … `[x1, y1)`. */
export interface InferenceTile {
  readonly tileId: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly width: number;
  readonly height: number;
}

function makeTile(tileId: number, x0: number, y0: number, x1: number, y1: number): InferenceTile {
  return { tileId, x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

/** Начала tiles по одной оси: полноразмерные плитки, последняя выровнена к краю. */
function axisOrigins(length: number, tileSize: number, step: number): number[] {
  if (length <= tileSize) {
    return [0];
  }
  const origins: number[] = [];
  let x = 0;
  while (x + tileSize < length) {
    origins.push(x);
    x += step;
  }
  const last = length - tileSize;
  if (origins.length === 0 || origins[origins.length - 1] !== last) {
    origins.push(last);
  }
  return origins;
}

/**
 * Спланировать покрытие страницы tiles (порт `plan_inference_tiles`).
 *
 * Плитки полноразмерные (`tileSize`), крайние сдвигаются внутрь страницы; при
 * `length <= tileSize` по оси одна плитка во всю страницу. Крайние плитки
 * могут быть не квадратными (`x1 = min(x0+tileSize, width)`) — потребитель
 * обязан масштабировать нормализованные боксы на реальные `(width, height)`
 * плитки, а не на разрешение сети.
 */
export function planInferenceTiles(
  width: number,
  height: number,
  options: { readonly tileSize: number; readonly overlap: number },
): InferenceTile[] {
  const { tileSize, overlap } = options;
  if (width <= 0 || height <= 0) {
    throw new RangeError('width и height должны быть положительными');
  }
  if (tileSize <= 0) {
    throw new RangeError('tileSize должен быть положительным');
  }
  if (!(overlap >= 0 && overlap < tileSize)) {
    throw new RangeError('overlap должен удовлетворять 0 <= overlap < tileSize');
  }

  const step = tileSize - overlap;
  const xs = axisOrigins(width, tileSize, step);
  const ys = axisOrigins(height, tileSize, step);
  const tiles: InferenceTile[] = [];
  let tid = 0;
  for (const y0 of ys) {
    for (const x0 of xs) {
      tiles.push(
        makeTile(tid, x0, y0, Math.min(x0 + tileSize, width), Math.min(y0 + tileSize, height)),
      );
      tid += 1;
    }
  }
  return tiles;
}

/** Единственная плитка во весь лист (режим `whole_page` / kill-switch тайлинга). */
export function wholePageTile(width: number, height: number): InferenceTile {
  if (width <= 0 || height <= 0) {
    throw new RangeError('width и height должны быть положительными');
  }
  return makeTile(0, 0, 0, width, height);
}

/**
 * Правило выбора плиток страницы из `service._run_page`: whole-page — если
 * режим `whole_page` ИЛИ страница целиком помещается в один tile; иначе сетка.
 */
export function planPageTiles(
  pageWidth: number,
  pageHeight: number,
  options: { readonly tileSize: number; readonly overlap: number; readonly mode: InferenceMode },
): InferenceTile[] {
  const { tileSize, overlap, mode } = options;
  if (mode === INFERENCE_MODE_WHOLE_PAGE || (pageWidth <= tileSize && pageHeight <= tileSize)) {
    return [wholePageTile(pageWidth, pageHeight)];
  }
  return planInferenceTiles(pageWidth, pageHeight, { tileSize, overlap });
}

/** Локальный (внутри tile) пиксельный xyxy-бокс → координаты страницы (с клампом). */
export function remapRectToPage(
  rectLocal: Rect,
  tile: InferenceTile,
  pageWidth: number,
  pageHeight: number,
): Rect {
  const clampX = (v: number): number => Math.max(0, Math.min(v, pageWidth));
  const clampY = (v: number): number => Math.max(0, Math.min(v, pageHeight));
  return [
    clampX(tile.x0 + rectLocal[0]),
    clampY(tile.y0 + rectLocal[1]),
    clampX(tile.x0 + rectLocal[2]),
    clampY(tile.y0 + rectLocal[3]),
  ];
}

/**
 * Blank-tile критерий из `service._is_blank_tile`: плитка «пустая» (почти
 * однородная), если стандартное отклонение яркости grayscale-версии < 1.0.
 *
 * Подсчёт статистики остаётся воркеру (у пакета нет доступа к пикселям);
 * контракт подсчёта, дающий паритет с референсом:
 * - grayscale — PIL `convert("L")` (ITU-R 601-2), т.е. НА КАЖДЫЙ пиксель
 *   целочисленное `(r*19595 + g*38470 + b*7471 + 0x8000) >> 16`
 *   (см. {@link pilGrayscaleLuma});
 * - std — популяционное (ddof=0) по всем пикселям плитки.
 *
 * Пропуск применяется референсом только в настоящем тайловом режиме
 * (>1 плитки) и только при включённом empty_tile_skip.
 */
export const BLANK_TILE_STD_THRESHOLD = 1.0;

export function isBlankTile(lumaStd: number): boolean {
  return lumaStd < BLANK_TILE_STD_THRESHOLD;
}

/**
 * Точная целочисленная luma-формула Pillow для `convert("L")` (fixed-point
 * ITU-R 601-2 с округлением) — чтобы воркер посчитал ту же статистику,
 * что PIL в референсе.
 */
export function pilGrayscaleLuma(r: number, g: number, b: number): number {
  return (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;
}
