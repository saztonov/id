import { describe, expect, it } from 'vitest';

import {
  clamp01,
  cxcywhToXyxy,
  inverseTurn,
  rectArea,
  rectIntersection,
  rectIou,
  rotatePointNorm,
  rotateRectNorm,
  rotatedSize,
  xyxyToCxcywh,
  type QuarterTurn,
  type Rect,
} from './geometry.js';

describe('geometry', () => {
  it('rectArea: отрицательные стороны дают 0', () => {
    expect(rectArea([0, 0, 10, 5])).toBe(50);
    expect(rectArea([10, 0, 0, 5])).toBe(0);
  });

  it('rectIntersection: пересечение и его отсутствие', () => {
    expect(rectIntersection([0, 0, 10, 10], [5, 5, 15, 15])).toEqual([5, 5, 10, 10]);
    expect(rectIntersection([0, 0, 10, 10], [10, 0, 20, 10])).toBeNull(); // касание — не пересечение
    expect(rectIntersection([0, 0, 1, 1], [2, 2, 3, 3])).toBeNull();
  });

  it('rectIou: посчитанные вручную значения', () => {
    // inter 5x5=25, union 100+100-25=175
    expect(rectIou([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(25 / 175, 12);
    expect(rectIou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(rectIou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
    // вырожденные прямоугольники → union 0 → IoU 0
    expect(rectIou([0, 0, 0, 0], [0, 0, 0, 0])).toBe(0);
  });

  it('clamp01', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1.5)).toBe(1);
  });

  it('cxcywh ↔ xyxy: точная конверсия и обратимость', () => {
    expect(cxcywhToXyxy([0.5, 0.5, 0.2, 0.4])).toEqual([0.4, 0.3, 0.6, 0.7]);
    const rect: Rect = [0.1, 0.2, 0.7, 0.9];
    const [cx, cy, w, h] = xyxyToCxcywh(rect);
    const back = cxcywhToXyxy([cx, cy, w, h]);
    for (let i = 0; i < 4; i += 1) {
      expect(back[i]).toBeCloseTo(rect[i] as number, 12);
    }
  });
});

// ---------------------------------------------------------------------------
// Поворот на четверть оборота (ADR-0020)
// ---------------------------------------------------------------------------

describe('поворот нормализованных координат', () => {
  const TURNS: readonly QuarterTurn[] = [0, 90, 180, 270];

  it('обратный поворот определён как дополнение до полного оборота', () => {
    expect(inverseTurn(0)).toBe(0);
    expect(inverseTurn(90)).toBe(270);
    expect(inverseTurn(180)).toBe(180);
    expect(inverseTurn(270)).toBe(90);
  });

  /**
   * Прямоугольник намеренно АСИММЕТРИЧЕН по обеим осям и не касается краёв.
   *
   * Квадрат в центре прошёл бы любую формулу, включая перепутанный знак: именно
   * поэтому здесь посчитанные руками ожидания, а не «повернули и посмотрели».
   */
  const RECT: Rect = [0.1, 0.2, 0.3, 0.9];

  it('четыре отображения совпадают с посчитанными руками', () => {
    expect(rotateRectNorm(RECT, 0)).toEqual([0.1, 0.2, 0.3, 0.9]);
    // 90: (x,y) → (1−y, x). Углы (0.1,0.2) и (0.3,0.9) идут в (0.8,0.1) и (0.1,0.3).
    expect(rotateRectNorm(RECT, 90).map((v) => Number(v.toFixed(6)))).toEqual([0.1, 0.1, 0.8, 0.3]);
    // 180: (x,y) → (1−x, 1−y). Углы идут в (0.9,0.8) и (0.7,0.1).
    expect(rotateRectNorm(RECT, 180).map((v) => Number(v.toFixed(6)))).toEqual([
      0.7, 0.1, 0.9, 0.8,
    ]);
    // 270: (x,y) → (y, 1−x). Углы идут в (0.2,0.9) и (0.9,0.7).
    expect(rotateRectNorm(RECT, 270).map((v) => Number(v.toFixed(6)))).toEqual([
      0.2, 0.7, 0.9, 0.9,
    ]);
  });

  it('поворот и обратный поворот возвращают исходный прямоугольник', () => {
    const rects: readonly Rect[] = [
      RECT,
      [0, 0, 1, 1],
      [0.45, 0.45, 0.55, 0.55],
      [0, 0.33, 0.07, 0.99],
    ];
    for (const turn of TURNS) {
      for (const rect of rects) {
        const back = rotateRectNorm(rotateRectNorm(rect, turn), inverseTurn(turn));
        for (let i = 0; i < 4; i += 1) {
          expect(back[i], `поворот ${String(turn)}, координата ${String(i)}`).toBeCloseTo(
            rect[i] as number,
            9,
          );
        }
      }
    }
  });

  it('нулевой поворот тождественен и не сдвигает границы округлением', () => {
    expect(rotateRectNorm(RECT, 0)).toEqual(RECT);
    expect(rotatePointNorm([0.123456789, 0.987654321], 0)).toEqual([0.123456789, 0.987654321]);
  });

  it('четыре поворота подряд возвращают исходный', () => {
    let rect: Rect = RECT;
    for (let i = 0; i < 4; i += 1) rect = rotateRectNorm(rect, 90);
    for (let i = 0; i < 4; i += 1) {
      expect(rect[i]).toBeCloseTo(RECT[i] as number, 9);
    }
  });

  it('rotatedSize меняет стороны местами ровно на 90 и 270', () => {
    expect(rotatedSize(2481, 3515, 0)).toEqual({ width: 2481, height: 3515 });
    expect(rotatedSize(2481, 3515, 90)).toEqual({ width: 3515, height: 2481 });
    expect(rotatedSize(2481, 3515, 180)).toEqual({ width: 2481, height: 3515 });
    expect(rotatedSize(2481, 3515, 270)).toEqual({ width: 3515, height: 2481 });
  });
});
