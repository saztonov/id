/**
 * Пересчёт координат разметки между нормализованным видом и канвой (§7.1).
 *
 * ## Почему пересчёт — это умножение, и почему поворот в нём не участвует
 *
 * `coords_norm` заданы в ПОСТ-ПОВОРОТНОМ фрейме с началом слева-сверху. Это же
 * утверждают три независимых места, и все три проверены чтением, а не памятью:
 *
 * 1. `apps/api/src/pdf/probe.ts` пишет `source_pages.width_px/height_px` уже с
 *    учётом `/Rotate` (`swapped = rotation === 90 || rotation === 270`), а само
 *    значение поворота хранит отдельной колонкой;
 * 2. RD WEB отдаёт `coords_norm` в своём рендере рабочего PDF, а рендер
 *    выполняется после применения `/Rotate`;
 * 3. pdf.js `page.getViewport({ scale })` по умолчанию берёт `rotation` из
 *    самой страницы, поэтому `viewport.width/height` — тоже пост-поворотные, а
 *    его система координат имеет начало слева-сверху.
 *
 * Отсюда вывод, который легко «улучшить» неверно: НИКАКОГО поворота координат
 * здесь делать не нужно. Три системы уже совпадают, и добавленный `if (rotation
 * === 90)` развернул бы рамки на страницах, где сейчас всё верно. Единственное
 * преобразование — умножение доли на размер отрисованной страницы.
 *
 * Что при этом обязано проверяться — не поворот, а СОГЛАСОВАННОСТЬ фреймов:
 * соотношение сторон страницы из карты `processing_bundle_pages` должно
 * совпадать с соотношением сторон вьюпорта pdf.js. Расхождение означает, что
 * одна из сторон применила поворот дважды или не применила вовсе, и тогда
 * рамки лягут мимо — но молча. Для этого есть `framesAgree()`.
 */
import type { NormalizedCoords } from '../../api/types.js';

/** Размер отрисованной страницы в пикселях канвы. */
export interface RenderedSize {
  readonly width: number;
  readonly height: number;
}

/** Прямоугольник в пикселях канвы (система Konva: начало слева-сверху). */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Приведение координат к виду, который примет и схема, и CHECK в БД.
 *
 * Растягивание рамки «вверх-влево» даёт x1 < x0 — это нормальный ход мыши, а не
 * ошибка, поэтому границы меняются местами, а не отвергаются. Ограничение
 * диапазоном — тоже не косметика: `layout_blocks` имеет
 * `CHECK(x0>=0 AND y0>=0 AND x1<=1 AND y1<=1)`, и без клампа рамка, вытянутая
 * за край страницы, дала бы 422 вместо блока.
 */
export function normalizeCoords(coords: NormalizedCoords): NormalizedCoords {
  const x0 = clamp01(Math.min(coords.x0, coords.x1));
  const x1 = clamp01(Math.max(coords.x0, coords.x1));
  const y0 = clamp01(Math.min(coords.y0, coords.y1));
  const y1 = clamp01(Math.max(coords.y0, coords.y1));
  return { x0, y0, x1, y1 };
}

/** Доля страницы → пиксели канвы. */
export function coordsToRect(coords: NormalizedCoords, size: RenderedSize): PixelRect {
  const safe = normalizeCoords(coords);
  return {
    x: safe.x0 * size.width,
    y: safe.y0 * size.height,
    width: (safe.x1 - safe.x0) * size.width,
    height: (safe.y1 - safe.y0) * size.height,
  };
}

/** Пиксели канвы → доля страницы. */
export function rectToCoords(rect: PixelRect, size: RenderedSize): NormalizedCoords {
  if (size.width <= 0 || size.height <= 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return normalizeCoords({
    x0: rect.x / size.width,
    y0: rect.y / size.height,
    x1: (rect.x + rect.width) / size.width,
    y1: (rect.y + rect.height) / size.height,
  });
}

/**
 * Вырожденная ли рамка.
 *
 * Порог в ДОЛЯХ страницы, а не в пикселях канвы: иначе один и тот же блок был
 * бы законным при зуме 200% и вырожденным при 50%. Значение по умолчанию
 * соответствует примерно одному миллиметру на листе A4.
 */
export function isDegenerate(coords: NormalizedCoords, minSide = 0.002): boolean {
  const safe = normalizeCoords(coords);
  return safe.x1 - safe.x0 < minSide || safe.y1 - safe.y0 < minSide;
}

/**
 * Совпадают ли фреймы страницы и вьюпорта.
 *
 * Сравниваются соотношения сторон, а не сами размеры: `width_px` хранится в
 * пунктах PDF, округлённых репозиторием, а вьюпорт масштабируется зумом.
 * Допуск в 2% покрывает округление до целого на странице A4 и не покрывает
 * перепутанный поворот — при 90° соотношение меняется в разы.
 */
export function framesAgree(page: RenderedSize, viewport: RenderedSize, tolerance = 0.02): boolean {
  if (page.width <= 0 || page.height <= 0) return false;
  if (viewport.width <= 0 || viewport.height <= 0) return false;
  const expected = page.width / page.height;
  const actual = viewport.width / viewport.height;
  return Math.abs(expected - actual) / expected <= tolerance;
}

/**
 * Размер отрисовки, вписанный в доступную область.
 *
 * Берётся минимальный из двух масштабов, поэтому страница целиком видна и в
 * узком окне, и в широком, а рамки продолжают совпадать с изображением: обе
 * величины считаются от одного и того же размера.
 */
export function fitInto(page: RenderedSize, available: RenderedSize): RenderedSize {
  if (page.width <= 0 || page.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(available.width / page.width, available.height / page.height);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { width: page.width * safeScale, height: page.height * safeScale };
}

/** Площадь блока в долях страницы: нужна списку блоков и подсказке о покрытии. */
export function areaOf(coords: NormalizedCoords): number {
  const safe = normalizeCoords(coords);
  return (safe.x1 - safe.x0) * (safe.y1 - safe.y0);
}
