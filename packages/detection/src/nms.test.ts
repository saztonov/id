import { describe, expect, it } from 'vitest';

import {
  capDetections,
  classAwareNms,
  filterByClassThreshold,
  mergeSplitTextBoxes,
  type PixelDet,
} from './nms.js';

const det = (
  blockType: PixelDet['blockType'],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  score: number,
): PixelDet => ({ blockType, x0, y0, x1, y1, score });

describe('classAwareNms', () => {
  it('перекрывающиеся боксы одного класса подавляются, разных — нет', () => {
    // IoU(a,b) = 9000/11000 ≈ 0.818 >= 0.5 → b подавлен; image с теми же координатами остаётся
    const a = det('text', 0, 0, 100, 100, 0.9);
    const b = det('text', 10, 0, 110, 100, 0.8);
    const c = det('image', 0, 0, 100, 100, 0.7);
    expect(classAwareNms([b, c, a], { iouThreshold: 0.5 })).toEqual([a, c]);
  });

  it('IoU ниже порога — оба бокса остаются, сортировка по убыванию score', () => {
    const a = det('text', 0, 0, 100, 100, 0.6);
    const b = det('text', 80, 80, 200, 200, 0.8); // IoU = 400/(10000+14400-400) ≈ 0.017
    expect(classAwareNms([a, b], { iouThreshold: 0.5 })).toEqual([b, a]);
  });

  it('порог вне [0,1] — ошибка', () => {
    expect(() => classAwareNms([], { iouThreshold: 1.5 })).toThrow(RangeError);
  });
});

describe('mergeSplitTextBoxes', () => {
  it('склейка «на одной строке»: малый горизонтальный зазор', () => {
    // minH=46; xGap=5 <= 0.6*46=27.6; yOverlap=46 >= 0.5*46=23 → merge
    const t1 = det('text', 100, 100, 200, 150, 0.6);
    const t2 = det('text', 205, 102, 300, 148, 0.7);
    expect(mergeSplitTextBoxes([t1, t2])).toEqual([det('text', 100, 100, 300, 150, 0.7)]);
  });

  it('склейка «стопкой»: вертикальный зазор в долях высоты', () => {
    // minW=190; xOverlap=190 >= 95; yGap=10 <= 0.6*minH(30)=18 → merge
    const t1 = det('text', 100, 100, 300, 130, 0.8);
    const t2 = det('text', 105, 140, 295, 170, 0.5);
    expect(mergeSplitTextBoxes([t1, t2])).toEqual([det('text', 100, 100, 300, 170, 0.8)]);
  });

  it('далёкие text-боксы не склеиваются', () => {
    const t1 = det('text', 100, 100, 200, 150, 0.6);
    const t2 = det('text', 100, 400, 200, 450, 0.7);
    expect(mergeSplitTextBoxes([t1, t2])).toEqual([t2, t1]);
  });

  it('транзитивная склейка цепочки a–b–c (union-find)', () => {
    const a = det('text', 0, 0, 100, 50, 0.6);
    const b = det('text', 105, 0, 200, 50, 0.9);
    const c = det('text', 205, 0, 300, 50, 0.7);
    // a↔c напрямую не склеиваются (зазор 105 > 0.6*50), но через b — одна группа
    expect(mergeSplitTextBoxes([a, b, c])).toEqual([det('text', 0, 0, 300, 50, 0.9)]);
  });

  it('stamp и image НЕ объединяются никогда, даже при полном перекрытии', () => {
    const s1 = det('stamp', 0, 0, 100, 100, 0.9);
    const s2 = det('stamp', 0, 5, 100, 105, 0.8);
    const i1 = det('image', 0, 0, 100, 100, 0.7);
    const result = mergeSplitTextBoxes([s1, s2, i1]);
    expect(result).toEqual([s1, s2, i1]); // text-блоков нет → ранний выход без изменений
  });

  it('один text-блок — без изменений (ранний выход)', () => {
    const t = det('text', 0, 0, 10, 10, 0.5);
    const s = det('stamp', 20, 20, 30, 30, 0.9);
    expect(mergeSplitTextBoxes([t, s])).toEqual([t, s]); // исходный порядок сохранён
  });
});

describe('filterByClassThreshold / capDetections', () => {
  const dets = [
    det('text', 0, 0, 10, 10, 0.55),
    det('image', 0, 0, 10, 10, 0.55),
    det('stamp', 0, 0, 10, 10, 0.75),
    det('stamp', 20, 20, 30, 30, 0.65),
  ];

  it('per-class пороги, отсутствующий класс — defaultThreshold', () => {
    const out = filterByClassThreshold(dets, { image: 0.6, stamp: 0.7 }, 0.5);
    // text: 0.55 >= default 0.5; image: 0.55 < 0.6; stamp: 0.75 >= 0.7, 0.65 < 0.7
    expect(out).toEqual([dets[0], dets[2]]);
  });

  it('cap: top-N по score, null — без ограничения', () => {
    expect(capDetections(dets, 2)).toEqual([dets[2], dets[3]]);
    expect(capDetections(dets, null)).toHaveLength(4);
    expect(capDetections(dets, null)[0]?.score).toBe(0.75);
  });
});
