import { describe, expect, it } from 'vitest';

import {
  clamp01,
  cxcywhToXyxy,
  rectArea,
  rectIntersection,
  rectIou,
  xyxyToCxcywh,
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
