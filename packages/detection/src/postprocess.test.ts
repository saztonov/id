import { describe, expect, it } from 'vitest';

import {
  DetectionModelMismatchError,
  activateLogits,
  boxesToNorm,
  decodeTileOutputs,
  invertClassMapping,
  newTileDecodeStats,
  toMatrix,
} from './postprocess.js';

const MAPPING = { text: 0, image: 1, stamp: 2 };
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

describe('toMatrix', () => {
  it('вложенные массивы [Q,C] и снятие batch-оси [1,Q,C]', () => {
    const m = toMatrix(
      [
        [1, 2],
        [3, 4],
      ],
      'labels',
    );
    expect({ rows: m.rows, cols: m.cols }).toEqual({ rows: 2, cols: 2 });
    expect([...m.data]).toEqual([1, 2, 3, 4]);

    const batched = toMatrix([[[5, 6]]], 'labels');
    expect([...batched.data]).toEqual([5, 6]);
  });

  it('тензор с dims (onnxruntime-node) ранга 2 и 3', () => {
    const t2 = toMatrix({ data: new Float32Array([1, 2, 3, 4, 5, 6]), dims: [2, 3] }, 'dets');
    expect({ rows: t2.rows, cols: t2.cols }).toEqual({ rows: 2, cols: 3 });
    const t3 = toMatrix({ data: new Float32Array([1, 2, 3, 4]), dims: [1, 2, 2] }, 'dets');
    expect([...t3.data]).toEqual([1, 2, 3, 4]);
  });

  it('рваная матрица и неверный ранг — ошибка', () => {
    expect(() => toMatrix([[1, 2], [3]], 'dets')).toThrow(DetectionModelMismatchError);
    expect(() => toMatrix({ data: new Float32Array(4), dims: [4] }, 'dets')).toThrow(
      DetectionModelMismatchError,
    );
  });
});

describe('invertClassMapping', () => {
  it('известные имена инвертируются, неизвестные пропускаются', () => {
    const map = invertClassMapping({ text: 0, image: 1, stamp: 2, background: 3 });
    expect([...map.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 'text'],
      [1, 'image'],
      [2, 'stamp'],
    ]);
  });

  it('null/undefined → пустая карта', () => {
    expect(invertClassMapping(null).size).toBe(0);
    expect(invertClassMapping(undefined).size).toBe(0);
  });
});

describe('activateLogits', () => {
  it('sigmoid: посчитанные вручную значения', () => {
    const m = toMatrix([[0, 2, -2]], 'labels');
    const probs = activateLogits(m, 'sigmoid');
    expect(probs[0]).toBeCloseTo(0.5, 12);
    expect(probs[1]).toBeCloseTo(sigmoid(2), 12);
    expect(probs[2]).toBeCloseTo(sigmoid(-2), 12);
  });

  it('softmax: равные логиты → равные вероятности, сумма 1', () => {
    const probs = activateLogits(toMatrix([[0, 0, 0]], 'labels'), 'softmax');
    for (let i = 0; i < 3; i += 1) {
      expect(probs[i]).toBeCloseTo(1 / 3, 12);
    }
    const shifted = activateLogits(toMatrix([[1000, 1001, 999]], 'labels'), 'softmax');
    // сдвиг на максимум спасает от переполнения exp
    const sum = (shifted[0] as number) + (shifted[1] as number) + (shifted[2] as number);
    expect(sum).toBeCloseTo(1, 12);
  });
});

describe('boxesToNorm', () => {
  it('cxcywh_normalized → xyxy с клампом 0..1', () => {
    const out = boxesToNorm(toMatrix([[0.5, 0.5, 0.4, 0.2]], 'dets'), 560, 'cxcywh_normalized');
    expect([...out]).toEqual([0.3, 0.4, 0.7, 0.6]);
    const clipped = boxesToNorm(
      toMatrix([[0.05, 0.5, 0.3, 1.4]], 'dets'),
      560,
      'cxcywh_normalized',
    );
    expect(clipped[0]).toBe(0); // cx - w/2 = -0.1 → 0
    expect(clipped[3]).toBe(1); // cy + h/2 = 1.2 → 1
  });

  it('xyxy_pixels → деление на resolution', () => {
    const out = boxesToNorm(toMatrix([[64, 128, 320, 640]], 'dets'), 640, 'xyxy_pixels');
    expect([...out]).toEqual([0.1, 0.2, 0.5, 1]);
  });
});

describe('decodeTileOutputs', () => {
  const boxes = [
    [0.5, 0.5, 0.2, 0.2], // q0 → [0.4, 0.4, 0.6, 0.6]
    [0.3, 0.3, 0.2, 0.1], // q1 → [0.2, 0.25, 0.4, 0.35]
  ];

  it('no-object занимает слот top-K и отфильтровывается ПОСЛЕ отбора (семантика референса)', () => {
    // labels [Q=2, C+1=3], mapping только text/image (num_classes=2, col2 — no-object).
    const labels = [
      [2.0, -1.0, 5.0], // сильнейший — no-object q0
      [1.0, 0.5, -2.0],
    ];
    const twoBest = decodeTileOutputs(boxes, labels, {
      classMapping: { text: 0, image: 1 },
      resolution: 560,
      numSelect: 2,
    });
    // top-2 = [no-object(0.993), text q0(0.881)]; no-object съел слот → один кандидат
    expect(twoBest).toHaveLength(1);
    expect(twoBest[0]?.blockType).toBe('text');
    expect(twoBest[0]?.score).toBeCloseTo(sigmoid(2), 12);

    const fourBest = decodeTileOutputs(boxes, labels, {
      classMapping: { text: 0, image: 1 },
      resolution: 560,
      numSelect: 4,
    });
    expect(fourBest.map((d) => [d.blockType, d.score])).toEqual([
      ['text', sigmoid(2)],
      ['text', sigmoid(1)],
      ['image', sigmoid(0.5)],
    ]);
    // один query отдаёт несколько классов — это (query × class), а не argmax по query
    expect(fourBest[1]?.boxNorm).toEqual(fourBest[2]?.boxNorm);
  });

  it('scoreFloor обрывает перебор (top отсортирован по убыванию)', () => {
    const labels = [
      [2.0, -1.0, 5.0],
      [1.0, 0.5, -2.0],
    ];
    const out = decodeTileOutputs(boxes, labels, {
      classMapping: { text: 0, image: 1 },
      resolution: 560,
      numSelect: 6,
      scoreFloor: 0.7,
    });
    // sigmoid(0.5)=0.62 < 0.7 → отрезан вместе со всем хвостом
    expect(out.map((d) => d.blockType)).toEqual(['text', 'text']);
  });

  it('min-box фильтр: вырожденный бокс отброшен и посчитан в stats', () => {
    const stats = newTileDecodeStats();
    const out = decodeTileOutputs([[0.5, 0.5, 5e-4, 0.2]], [[3.0, -5.0, -5.0, -5.0]], {
      classMapping: MAPPING,
      resolution: 560,
      scoreFloor: 0.5,
      stats,
    });
    expect(out).toHaveLength(0);
    expect(stats.rejectedMinBox).toBe(1);
  });

  it('full-tile guard: text отброшен только при переданном reject-множестве', () => {
    const dets = [[0.5, 0.5, 0.95, 0.96]]; // xyxy [0.025..0.975] — обе стороны >= 0.9
    const labels = [[3.0, -5.0, -5.0, -5.0]];
    const base = { classMapping: MAPPING, resolution: 560, scoreFloor: 0.5 };

    const statsKept = newTileDecodeStats();
    const kept = decodeTileOutputs(dets, labels, { ...base, stats: statsKept });
    expect(kept).toHaveLength(1); // без reject-множества (whole_page) — валидный результат
    expect(statsKept.nearFullTile.text).toBe(1); // но паттерн зафиксирован ДО guard'а

    const statsDropped = newTileDecodeStats();
    const dropped = decodeTileOutputs(dets, labels, {
      ...base,
      rejectFullTileTypes: new Set(['text']),
      stats: statsDropped,
    });
    expect(dropped).toHaveLength(0);
    expect(statsDropped.nearFullTile.text).toBe(1);
    expect(statsDropped.rejectedFullTile.text).toBe(1);
  });

  it('рассинхрон num_queries и class_mapping вне диапазона labels — ошибки', () => {
    expect(() =>
      decodeTileOutputs(
        [[0.5, 0.5, 0.2, 0.2]],
        [
          [0, 0],
          [0, 0],
        ],
        {
          classMapping: { text: 0 },
          resolution: 560,
        },
      ),
    ).toThrow(/num_queries/);
    expect(() =>
      decodeTileOutputs(
        boxes,
        [
          [0, 0],
          [0, 0],
        ],
        { classMapping: { stamp: 2 }, resolution: 560 },
      ),
    ).toThrow(/столбец 2/);
  });

  it('пустая карта классов → пустой результат', () => {
    expect(
      decodeTileOutputs(
        boxes,
        [
          [9, 9],
          [9, 9],
        ],
        { classMapping: { background: 0 }, resolution: 560 },
      ),
    ).toEqual([]);
  });

  it('принимает тензоры onnxruntime-node с batch-осью [1,Q,C]', () => {
    const out = decodeTileOutputs(
      { data: new Float32Array([0.5, 0.5, 0.2, 0.2]), dims: [1, 1, 4] },
      { data: new Float32Array([2, -5, -5, -5]), dims: [1, 1, 4] },
      { classMapping: MAPPING, resolution: 560, scoreFloor: 0.5 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.blockType).toBe('text');
  });
});
