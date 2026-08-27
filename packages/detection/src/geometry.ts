/**
 * Чистая прямоугольная геометрия для постобработки детекций.
 *
 * Порт `temp/RDNEW/services/web_ocr/detection/geometry.py` (референс RD WEB).
 * Координаты — числа с плавающей точкой (пиксели страницы либо нормализованные
 * 0..1 — функции масштабонезависимы), origin — верхний-левый угол.
 */

/** Axis-aligned прямоугольник `[x0, y0, x1, y1]` (x0<=x1, y0<=y1). */
export type Rect = [x0: number, y0: number, x1: number, y1: number];

export function rectArea(r: Rect): number {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

/** Пересечение двух прямоугольников или `null`, если они не пересекаются. */
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  if (x1 <= x0 || y1 <= y0) {
    return null;
  }
  return [x0, y0, x1, y1];
}

/** IoU двух прямоугольников (0 при нулевом union) — дословный порт `rect_iou`. */
export function rectIou(a: Rect, b: Rect): number {
  const inter = rectIntersection(a, b);
  const interArea = inter ? rectArea(inter) : 0;
  const union = rectArea(a) + rectArea(b) - interArea;
  if (union <= 0) {
    return 0;
  }
  return interArea / union;
}

/** Зажать значение в [0, 1] (для нормализованных координат). */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * `[cx, cy, w, h]` → `[x0, y0, x1, y1]`.
 *
 * Та же формула, что в `postprocess._boxes_to_norm` референса
 * (`cx - w/2 … cy + h/2`); без клампа — его выполняет вызывающий,
 * потому что диапазон зависит от системы координат (0..1 или пиксели).
 */
export function cxcywhToXyxy(box: readonly [number, number, number, number]): Rect {
  const [cx, cy, w, h] = box;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

/** Обратная конверсия `[x0, y0, x1, y1]` → `[cx, cy, w, h]`. */
export function xyxyToCxcywh(rect: Rect): [cx: number, cy: number, w: number, h: number] {
  const [x0, y0, x1, y1] = rect;
  return [(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0];
}

// ---------------------------------------------------------------------------
// Поворот на четверть оборота (ADR-0020)
// ---------------------------------------------------------------------------

/**
 * Четверть оборота ПО ЧАСОВОЙ СТРЕЛКЕ.
 *
 * Соглашение одно на весь портал и записано дословно в четырёх местах: здесь, в
 * комментарии колонки `page_orientations.content_rotation`, в тексте промпта
 * зонда ориентации и в шапке `apps/web/src/features/markup/rotation.ts`. Четыре
 * разных места читают одно число, и понимать его они обязаны одинаково — иначе
 * страница уедет вверх ногами, и это не упадёт, а просто будет неверно.
 */
export type QuarterTurn = 0 | 90 | 180 | 270;

/** Обратный поворот: 90 ↔ 270, 0 и 180 сами себе обратны. */
export function inverseTurn(turn: QuarterTurn): QuarterTurn {
  return ((360 - turn) % 360) as QuarterTurn;
}

/**
 * Точка ИЗ системы страницы В систему повёрнутой картинки, координаты 0..1.
 *
 * - 90:  `(x, y) → (1 − y, x)`
 * - 180: `(x, y) → (1 − x, 1 − y)`
 * - 270: `(x, y) → (y, 1 − x)`
 *
 * Формула НЕ содержит ширины и высоты, и это не упрощение, а свойство
 * нормализованных координат: при 90/270 меняется аспект, но каждая ось
 * независимо перенормируется в [0,1]. В пикселях те же три случая требовали бы
 * двух лишних аргументов — то есть двух лишних способов ошибиться.
 */
export function rotatePointNorm(
  point: readonly [number, number],
  turn: QuarterTurn,
): [number, number] {
  const [x, y] = point;
  switch (turn) {
    case 90:
      return [1 - y, x];
    case 180:
      return [1 - x, 1 - y];
    case 270:
      return [y, 1 - x];
    default:
      return [x, y];
  }
}

/**
 * Прямоугольник ИЗ системы страницы В систему повёрнутой картинки.
 *
 * Поворачиваются два противоположных угла, после чего границы приводятся к
 * порядку `x0<=x1, y0<=y1`: axis-aligned прямоугольник при четверти оборота
 * остаётся axis-aligned, но углы меняются местами.
 */
export function rotateRectNorm(rect: Rect, turn: QuarterTurn): Rect {
  const [ax, ay] = rotatePointNorm([rect[0], rect[1]], turn);
  const [bx, by] = rotatePointNorm([rect[2], rect[3]], turn);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/** Размер картинки после поворота: стороны меняются местами на 90 и 270. */
export function rotatedSize(
  width: number,
  height: number,
  turn: QuarterTurn,
): { width: number; height: number } {
  return turn === 90 || turn === 270 ? { width: height, height: width } : { width, height };
}
