/**
 * Квантование ширины рендера (§7.1).
 *
 * Смысл проверки не в арифметике, а в следствии: экран разметки перерисовывает
 * страницу ровно тогда, когда меняется РЕЗУЛЬТАТ этой функции. Пока соседние
 * шаги масштаба дают одно значение, смена масштаба не стоит рендера, а возврат
 * на просмотренную страницу попадает в кэш. Разъехавшийся шаг сломал бы и то,
 * и другое молча — страница просто снова стала бы «долго грузиться».
 */
import { describe, expect, it } from 'vitest';

import { renderWidthFor } from './render-width.js';
import { ZOOM_STEPS } from '../zoom.js';

describe('renderWidthFor', () => {
  it('никогда не мельче запрошенного показа: канва ужимается, но не растягивается', () => {
    for (let width = 1; width <= 4000; width += 7) {
      expect(renderWidthFor(width)).toBeGreaterThanOrEqual(width);
    }
  });

  it('не убывает с ростом ширины показа', () => {
    let previous = 0;
    for (let width = 1; width <= 4000; width += 3) {
      const current = renderWidthFor(width);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('дробная ширина от ResizeObserver даёт то же значение, что и целая', () => {
    // `contentRect.width` приходит дробным, и без квантования каждый пиксель
    // ширины окна был бы отдельным ключом кэша — то есть кэша не было бы вовсе.
    expect(renderWidthFor(812.3125)).toBe(renderWidthFor(812));
    expect(renderWidthFor(812.9999)).toBe(renderWidthFor(813));
  });

  it('соседние шаги масштаба попадают в одну ступень хотя бы иногда', () => {
    // Иначе развязка масштаба и рендера не даёт ничего: на типичной ширине
    // области лестница ZOOM_STEPS обязана укладываться в несколько ступеней,
    // а не в столько же разных, сколько в ней самой шагов.
    const fittedWidth = 700;
    const widths = ZOOM_STEPS.map((zoom) => renderWidthFor(fittedWidth * zoom));
    expect(new Set(widths).size).toBeLessThan(ZOOM_STEPS.length);
  });

  it('нулевая и отрицательная ширина не дают вырожденной канвы', () => {
    expect(renderWidthFor(0)).toBeGreaterThan(0);
    expect(renderWidthFor(-10)).toBeGreaterThan(0);
  });
});
