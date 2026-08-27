/**
 * Масштаб: ступени, режимы вписывания и привязка прокрутки к точке под курсором.
 */
import { describe, expect, it } from 'vitest';

import {
  anchoredScroll,
  clampZoom,
  effectiveZoom,
  stepZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
} from './zoom.js';

describe('clampZoom', () => {
  it('держит границы и не пропускает нечисло', () => {
    expect(clampZoom(0.001)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('stepZoom', () => {
  it('идёт по ступеням и упирается в края', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_MIN);
  });

  it('из значения между ступенями «+» даёт строго бо́льшую, «−» строго меньшую', () => {
    expect(stepZoom(1.21, 1)).toBe(1.5);
    expect(stepZoom(1.21, -1)).toBe(1);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(0.9, -1)).toBe(0.75);
  });

  it('ровно на ступени шаг переходит на соседнюю, а не остаётся на месте', () => {
    expect(stepZoom(2, 1)).toBe(3);
    expect(stepZoom(2, -1)).toBe(1.5);
  });
});

describe('effectiveZoom', () => {
  const fitted = { width: 400, height: 560 };
  const available = { width: 900, height: 600 };

  it('fit-page — это ровно 1 при любых размерах', () => {
    expect(effectiveZoom('fit-page', 3, fitted, available)).toBe(1);
    expect(effectiveZoom('fit-page', 3, { width: 1, height: 9999 }, available)).toBe(1);
  });

  it('fit-width растягивает вписанную страницу ровно на ширину области', () => {
    const zoom = effectiveZoom('fit-width', 1, fitted, available);
    expect(fitted.width * zoom).toBeCloseTo(available.width, 6);
  });

  it('manual берёт своё число и клэмпится', () => {
    expect(effectiveZoom('manual', 2, fitted, available)).toBe(2);
    expect(effectiveZoom('manual', 99, fitted, available)).toBe(ZOOM_MAX);
  });

  it('вырожденные размеры не дают деления на ноль', () => {
    expect(effectiveZoom('fit-width', 1, { width: 0, height: 0 }, available)).toBe(1);
    expect(effectiveZoom('fit-width', 1, fitted, { width: 0, height: 0 })).toBe(1);
  });
});

describe('anchoredScroll', () => {
  const before = { width: 1000, height: 2000 };

  it('точка под курсором остаётся под курсором при увеличении', () => {
    const next = anchoredScroll({
      scrollLeft: 100,
      scrollTop: 200,
      pointerX: 300,
      pointerY: 400,
      before,
      after: { width: 2000, height: 4000 },
    });
    expect(next.left).toBeCloseTo(500, 6);
    expect(next.top).toBeCloseTo(800, 6);
  });

  it('та же точка удерживается и при уменьшении', () => {
    const next = anchoredScroll({
      scrollLeft: 500,
      scrollTop: 800,
      pointerX: 300,
      pointerY: 400,
      before: { width: 2000, height: 4000 },
      after: before,
    });
    expect(next.left).toBeCloseTo(100, 6);
    expect(next.top).toBeCloseTo(200, 6);
  });

  it('при неизменном размере прокрутка не двигается', () => {
    const next = anchoredScroll({
      scrollLeft: 137,
      scrollTop: 42,
      pointerX: 300,
      pointerY: 400,
      before,
      after: before,
    });
    expect(next.left).toBeCloseTo(137, 6);
    expect(next.top).toBeCloseTo(42, 6);
  });

  it('курсор в левом верхнем углу оставляет прокрутку в нуле, а не уводит в минус', () => {
    const next = anchoredScroll({
      scrollLeft: 0,
      scrollTop: 0,
      pointerX: 0,
      pointerY: 0,
      before,
      after: { width: 500, height: 1000 },
    });
    expect(next.left).toBe(0);
    expect(next.top).toBe(0);
  });
});
