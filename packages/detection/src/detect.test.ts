import { describe, expect, it } from 'vitest';

import { detectPageFromTiles, modeMismatchWarning, type DetectPageStats } from './detect.js';
import type { InferenceParams } from './manifest.js';
import { wholePageTile, type InferenceTile } from './tiling.js';

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const baseParams: InferenceParams = {
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  inputName: 'input',
  boxFormat: 'cxcywh_normalized',
  activation: 'sigmoid',
  numSelect: 300,
  tileSize: 1024,
  overlap: 128,
  resolution: 560,
  numClasses: 3,
  dynamicBatch: false,
  classMapping: { text: 0, image: 1, stamp: 2 },
  trainingMode: null,
  minVisibility: null,
  thresholds: {},
  defaultThreshold: 0.5,
  nmsIou: 0.5,
  mergeSplitText: false,
  maxDetections: null,
};

describe('detectPageFromTiles', () => {
  it('whole-page: полностраничный text валиден (guard выключен при 1 плитке)', () => {
    const tile = wholePageTile(200, 100);
    const { candidates, stats } = detectPageFromTiles({
      pageWidth: 200,
      pageHeight: 100,
      plannedTileCount: 1,
      tiles: [
        {
          tile,
          dets: [[0.5, 0.5, 0.96, 0.96]], // xyxy [0.02..0.98] — почти весь лист
          labels: [[3.0, -5.0, -5.0, -5.0]],
        },
      ],
      params: baseParams,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.blockType).toBe('text');
    expect(candidates[0]?.score).toBeCloseTo(sigmoid(3), 12);
    for (const [i, v] of [0.02, 0.02, 0.98, 0.98].entries()) {
      expect(candidates[0]?.coordsNorm[i]).toBeCloseTo(v, 9);
    }
    // паттерн near-full зафиксирован в stats даже без guard'а
    expect(stats.tilesWithNearFullTile.text).toBe(1);
    expect(stats.rejectedFullTile.text).toBeUndefined();
  });

  it('тайловый режим: тот же full-tile text отбрасывается guard-ом', () => {
    const tile = wholePageTile(200, 100);
    const { candidates, stats } = detectPageFromTiles({
      pageWidth: 200,
      pageHeight: 100,
      plannedTileCount: 2, // важно ПЛАНОВОЕ число плиток, а не сколько дошло до инференса
      tiles: [
        {
          tile,
          dets: [[0.5, 0.5, 0.96, 0.96]],
          labels: [[3.0, -5.0, -5.0, -5.0]],
        },
      ],
      params: baseParams,
    });
    expect(candidates).toHaveLength(0);
    expect(stats.rejectedFullTile.text).toBe(1);
  });

  it('дубль в зоне перекрытия двух тайлов схлопывается NMS в один бокс страницы', () => {
    // Один и тот же image-блок страницы (пиксели 120..180 × 50..150) виден из двух тайлов.
    const tileA: InferenceTile = {
      tileId: 0,
      x0: 0,
      y0: 0,
      x1: 200,
      y1: 200,
      width: 200,
      height: 200,
    };
    const tileB: InferenceTile = {
      tileId: 1,
      x0: 100,
      y0: 0,
      x1: 300,
      y1: 200,
      width: 200,
      height: 200,
    };
    const { candidates, stats } = detectPageFromTiles({
      pageWidth: 300,
      pageHeight: 200,
      plannedTileCount: 2,
      tiles: [
        { tile: tileA, dets: [[0.75, 0.5, 0.3, 0.5]], labels: [[-5.0, 2.0, -5.0, -5.0]] },
        { tile: tileB, dets: [[0.25, 0.5, 0.3, 0.5]], labels: [[-5.0, 1.0, -5.0, -5.0]] },
      ],
      params: baseParams,
    });
    expect(stats.rawByType.image).toBe(2);
    expect(stats.afterNms).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.score).toBeCloseTo(sigmoid(2), 12); // выигрывает более уверенный тайл
    for (const [i, v] of [0.4, 0.25, 0.6, 0.75].entries()) {
      expect(candidates[0]?.coordsNorm[i]).toBeCloseTo(v, 9);
    }
  });

  it('per-class пороги: floor собирает всё, страница фильтрует по классу', () => {
    const tile = wholePageTile(1000, 1000);
    const params: InferenceParams = {
      ...baseParams,
      thresholds: { image: 0.6, stamp: 0.9 },
      defaultThreshold: 0.5,
    };
    const { candidates } = detectPageFromTiles({
      pageWidth: 1000,
      pageHeight: 1000,
      plannedTileCount: 1,
      tiles: [
        {
          tile,
          dets: [
            [0.2, 0.2, 0.2, 0.2],
            [0.5, 0.5, 0.2, 0.2],
            [0.8, 0.8, 0.2, 0.2],
          ],
          labels: [
            [0.5, -9, -9, -9], // text 0.62 >= default 0.5 → остаётся
            [-9, 0.5, -9, -9], // image 0.62 < 0.6? нет: 0.62 >= 0.6 → остаётся
            [-9, -9, 0.5, -9], // stamp 0.62 < 0.9 → отсекается порогом класса
          ],
        },
      ],
      params,
    });
    expect(candidates.map((c) => c.blockType).sort()).toEqual(['image', 'text']);
  });

  it('maxDetections ограничивает выдачу top-N по score', () => {
    const tile = wholePageTile(1000, 1000);
    const { candidates } = detectPageFromTiles({
      pageWidth: 1000,
      pageHeight: 1000,
      plannedTileCount: 1,
      tiles: [
        {
          tile,
          dets: [
            [0.2, 0.2, 0.2, 0.2],
            [0.5, 0.5, 0.2, 0.2],
            [0.8, 0.8, 0.2, 0.2],
          ],
          labels: [
            [2.0, -9, -9, -9],
            [-9, 3.0, -9, -9],
            [-9, -9, 2.5, -9],
          ],
        },
      ],
      params: { ...baseParams, maxDetections: 2 },
    });
    expect(candidates.map((c) => c.blockType)).toEqual(['image', 'stamp']);
  });

  it('mergeSplitText=true склеивает разрезанный на границе тайлов текст', () => {
    // Два соседних тайла без перекрытия; text разрезан вертикальной границей x=200.
    const tileA: InferenceTile = {
      tileId: 0,
      x0: 0,
      y0: 0,
      x1: 200,
      y1: 200,
      width: 200,
      height: 200,
    };
    const tileB: InferenceTile = {
      tileId: 1,
      x0: 200,
      y0: 0,
      x1: 400,
      y1: 200,
      width: 200,
      height: 200,
    };
    const input = {
      pageWidth: 400,
      pageHeight: 200,
      plannedTileCount: 2,
      tiles: [
        // левая половина: пиксели страницы 100..200 × 80..120
        { tile: tileA, dets: [[0.75, 0.5, 0.5, 0.2]], labels: [[2.0, -9, -9, -9]] },
        // правая половина: пиксели страницы 200..300 × 80..120
        { tile: tileB, dets: [[0.25, 0.5, 0.5, 0.2]], labels: [[1.5, -9, -9, -9]] },
      ],
    };
    const separate = detectPageFromTiles({ ...input, params: baseParams });
    expect(separate.candidates).toHaveLength(2);

    const merged = detectPageFromTiles({
      ...input,
      params: { ...baseParams, mergeSplitText: true },
    });
    expect(merged.candidates).toHaveLength(1);
    expect(merged.stats.afterMerge).toBe(1);
    expect(merged.candidates[0]?.score).toBeCloseTo(sigmoid(2), 12); // max по членам группы
    for (const [i, v] of [0.25, 0.4, 0.75, 0.6].entries()) {
      expect(merged.candidates[0]?.coordsNorm[i]).toBeCloseTo(v, 9);
    }
  });

  it('некорректные размеры страницы → пустой результат, не исключение (как в референсе)', () => {
    const { candidates } = detectPageFromTiles({
      pageWidth: 0,
      pageHeight: 100,
      plannedTileCount: 1,
      tiles: [],
      params: baseParams,
    });
    expect(candidates).toEqual([]);
  });
});

describe('modeMismatchWarning', () => {
  const stats = (planned: number, nearFullText: number): DetectPageStats => ({
    tilesPlanned: planned,
    tilesInferred: planned,
    rawByType: {},
    tilesWithNearFullTile: nearFullText > 0 ? { text: nearFullText } : {},
    rejectedFullTile: {},
    rejectedMinBox: 0,
    afterNms: 0,
    afterMerge: null,
    afterThreshold: 0,
    finalByType: {},
  });

  it('срабатывает только в настоящем тайловом режиме и от minTiles плиток', () => {
    expect(modeMismatchWarning(stats(1, 5), 0)).toBeNull(); // одна плитка — не тайловый режим
    expect(modeMismatchWarning(stats(6, 2), 0)).toBeNull(); // 2 < MODE_MISMATCH_MIN_TILES
    const warning = modeMismatchWarning(stats(6, 3), 0);
    expect(warning).toContain('Страница 0');
    expect(warning).toContain('text: 3/6 плиток');
    expect(warning).toContain('рассинхрон');
  });
});
