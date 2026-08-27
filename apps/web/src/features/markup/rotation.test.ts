/**
 * Разворот вида: сцена, обратное преобразование и невмешательство в сверку фреймов.
 *
 * Главное утверждение файла — «картинка и рамки едут вместе». Оно проверяется не
 * на глаз, а арифметикой: угол содержимого и блок, лежащий в том же углу, обязаны
 * оказаться в одной и той же четверти сцены.
 */
import { describe, expect, it } from 'vitest';

import { coordsToRect, framesAgree } from './geometry.js';
import {
  applyRotation,
  contentPointOf,
  contentTransform,
  normalizeRotation,
  rotateBy,
  ROTATIONS,
  type Rotation,
} from './rotation.js';

/** Асимметричный лист: квадрат скрыл бы перепутанные оси. */
const CONTENT = { width: 400, height: 900 };

/** Прямое применение трансформации группы к точке содержимого — как это делает Konva. */
function toStage(point: { x: number; y: number }, rotation: Rotation): { x: number; y: number } {
  const { group } = contentTransform(CONTENT, rotation);
  const radians = (group.rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(radians));
  const sin = Math.round(Math.sin(radians));
  return {
    x: point.x * cos - point.y * sin + group.x,
    y: point.x * sin + point.y * cos + group.y,
  };
}

describe('normalizeRotation и rotateBy', () => {
  it('любое число приводится к четверти оборота', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(0)).toBe(0);
  });

  it('мусор — это ноль, а не исключение: значение приходит из API и из хранилища', () => {
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('четыре поворота по часовой возвращают исходный', () => {
    let rotation: Rotation = 90;
    for (let i = 0; i < 4; i += 1) rotation = rotateBy(rotation, 1);
    expect(rotation).toBe(90);
    expect(rotateBy(0, -1)).toBe(270);
  });
});

describe('размер сцены', () => {
  it('стороны меняются местами на 90 и 270 и остаются на 0 и 180', () => {
    expect(applyRotation(CONTENT, 0)).toEqual({ width: 400, height: 900 });
    expect(applyRotation(CONTENT, 90)).toEqual({ width: 900, height: 400 });
    expect(applyRotation(CONTENT, 180)).toEqual({ width: 400, height: 900 });
    expect(applyRotation(CONTENT, 270)).toEqual({ width: 900, height: 400 });
  });

  it('четыре угла листа ложатся ровно в рамку сцены, без отрицательных координат', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: CONTENT.width, y: 0 },
      { x: 0, y: CONTENT.height },
      { x: CONTENT.width, y: CONTENT.height },
    ];
    for (const rotation of ROTATIONS) {
      const { stage } = contentTransform(CONTENT, rotation);
      const mapped = corners.map((corner) => toStage(corner, rotation));
      for (const point of mapped) {
        expect(point.x, `x при повороте ${String(rotation)}`).toBeGreaterThanOrEqual(0);
        expect(point.y, `y при повороте ${String(rotation)}`).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(stage.width);
        expect(point.y).toBeLessThanOrEqual(stage.height);
      }
      // Углы обязаны занять всю рамку, а не её часть: иначе на сцене остались бы
      // пустые поля, а часть листа уехала бы за край.
      expect(Math.max(...mapped.map((p) => p.x))).toBeCloseTo(stage.width, 6);
      expect(Math.max(...mapped.map((p) => p.y))).toBeCloseTo(stage.height, 6);
    }
  });
});

describe('обратное преобразование', () => {
  it('contentPointOf возвращает точку содержимого на всех четырёх поворотах', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 400, y: 900 },
      { x: 123.5, y: 47.25 },
      { x: 400, y: 0 },
    ];
    for (const rotation of ROTATIONS) {
      for (const point of points) {
        const back = contentPointOf(toStage(point, rotation), CONTENT, rotation);
        expect(back.x, `x при повороте ${String(rotation)}`).toBeCloseTo(point.x, 9);
        expect(back.y, `y при повороте ${String(rotation)}`).toBeCloseTo(point.y, 9);
      }
    }
  });
});

describe('картинка и рамка едут вместе', () => {
  /**
   * Единственное утверждение, ради которого существует весь модуль.
   *
   * Блок левого верхнего квадранта содержимого при повороте на 90° по часовой
   * обязан оказаться в ПРАВОМ верхнем квадранте сцены — ровно туда же, куда
   * уезжает левый верхний угол картинки. Расхождение означает, что слой с
   * изображением и слой с рамками получили разные трансформации.
   */
  it('блок левого верхнего квадранта при 90° попадает в правый верхний квадрант сцены', () => {
    const rect = coordsToRect({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, CONTENT);
    const { stage } = contentTransform(CONTENT, 90);

    const blockCorners = [
      toStage({ x: rect.x, y: rect.y }, 90),
      toStage({ x: rect.x + rect.width, y: rect.y }, 90),
      toStage({ x: rect.x, y: rect.y + rect.height }, 90),
      toStage({ x: rect.x + rect.width, y: rect.y + rect.height }, 90),
    ];
    const imageCorner = toStage({ x: 0, y: 0 }, 90);

    for (const corner of blockCorners) {
      expect(corner.x).toBeGreaterThanOrEqual(stage.width / 2 - 1e-6);
      expect(corner.y).toBeLessThanOrEqual(stage.height / 2 + 1e-6);
    }
    // Угол картинки — в том же квадранте, что и блок, который его накрывает.
    expect(imageCorner.x).toBeCloseTo(stage.width, 6);
    expect(imageCorner.y).toBeCloseTo(0, 6);
  });
});

describe('сверка фреймов не задета разворотом', () => {
  /**
   * Страховка от «оптимизации».
   *
   * `framesAgree` сравнивает НЕповёрнутый фрейм карты страниц с НЕповёрнутым
   * вьюпортом pdf.js. Соблазн подставить туда развёрнутый размер «для
   * единообразия» велик, а результат — падение проверки целостности на каждой
   * странице, которую инженер развернул.
   */
  it('фреймы совпадают при любом развороте содержимого', () => {
    const page = { width: 595, height: 842 };
    for (const rotation of ROTATIONS) {
      expect(framesAgree(page, page), `поворот ${String(rotation)}`).toBe(true);
      // А развёрнутый фрейм — НЕ совпадает: именно это и ловит сверка.
      if (rotation === 90 || rotation === 270) {
        expect(framesAgree(page, applyRotation(page, rotation))).toBe(false);
      }
    }
  });
});
