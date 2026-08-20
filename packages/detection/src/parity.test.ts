/**
 * Паритет Python↔TS: фикстуры сгенерированы референсом RD WEB
 * (`temp/RDNEW/services/web_ocr/detection/`) скриптом
 * `tools/fixtures/detection/generate_parity.py` (numpy, фиксированный seed) и
 * закоммичены — прогону тестов Python не нужен. Каждый ожидаемый результат
 * посчитан ИМЕННО референсной реализацией, сверка с допуском 1e-6.
 *
 * Перегенерация (только при изменении референса):
 *   python tools/fixtures/detection/generate_parity.py
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectPageFromTiles } from './detect.js';
import {
  manifestParams,
  parseDetectionManifest,
  resolveInferenceMode,
  type InferenceParams,
} from './manifest.js';
import {
  capDetections,
  classAwareNms,
  filterByClassThreshold,
  mergeSplitTextBoxes,
  type PixelDet,
} from './nms.js';
import {
  decodeTileOutputs,
  newTileDecodeStats,
  type DetectionBlockType,
  type RawTileDet,
} from './postprocess.js';
import {
  planInferenceTiles,
  remapRectToPage,
  wholePageTile,
  type InferenceTile,
} from './tiling.js';

const TOLERANCE = 1e-6;
const FIXTURES_DIR = fileURLToPath(new URL('../../../tools/fixtures/detection/', import.meta.url));

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as T;
}

function fixtureExists(name: string): boolean {
  try {
    return readdirSync(FIXTURES_DIR).includes(name);
  } catch {
    return false;
  }
}

const expectClose = (actual: number, expected: number, context: string): void => {
  expect(Math.abs(actual - expected), `${context}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    TOLERANCE,
  );
};

interface RawDetJson {
  blockType: DetectionBlockType;
  boxNorm: number[];
  score: number;
}

interface StatsJson {
  nearFullTile: Record<string, number>;
  rejectedFullTile: Record<string, number>;
  rejectedMinBox: number;
}

interface PixelDetJson {
  blockType: DetectionBlockType;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
}

function expectRawDetsEqual(actual: RawTileDet[], expected: RawDetJson[]): void {
  expect(actual.map((d) => d.blockType)).toEqual(expected.map((d) => d.blockType));
  for (const [i, exp] of expected.entries()) {
    const act = actual[i] as RawTileDet;
    expectClose(act.score, exp.score, `raw[${i}].score`);
    for (let c = 0; c < 4; c += 1) {
      expectClose(act.boxNorm[c] as number, exp.boxNorm[c] as number, `raw[${i}].box[${c}]`);
    }
  }
}

function expectPixelDetsEqual(actual: PixelDet[], expected: PixelDetJson[]): void {
  expect(actual.map((d) => d.blockType)).toEqual(expected.map((d) => d.blockType));
  for (const [i, exp] of expected.entries()) {
    const act = actual[i] as PixelDet;
    expectClose(act.score, exp.score, `det[${i}].score`);
    expectClose(act.x0, exp.x0, `det[${i}].x0`);
    expectClose(act.y0, exp.y0, `det[${i}].y0`);
    expectClose(act.x1, exp.x1, `det[${i}].x1`);
    expectClose(act.y1, exp.y1, `det[${i}].y1`);
  }
}

function expectStatsEqual(
  actual: {
    nearFullTile: Partial<Record<DetectionBlockType, number>>;
    rejectedFullTile: Partial<Record<DetectionBlockType, number>>;
    rejectedMinBox: number;
  },
  expected: StatsJson,
): void {
  expect(actual.nearFullTile).toEqual(expected.nearFullTile);
  expect(actual.rejectedFullTile).toEqual(expected.rejectedFullTile);
  expect(actual.rejectedMinBox).toBe(expected.rejectedMinBox);
}

interface DecodeFixture {
  input: { dets: number[][]; labels: number[][] };
  params: {
    classMapping: Record<string, number>;
    resolution: number;
    activation: 'sigmoid' | 'softmax';
    numSelect: number;
    scoreFloor: number;
    boxFormat: 'cxcywh_normalized' | 'xyxy_pixels';
    rejectFullTileTypes?: DetectionBlockType[];
    fullTileMinRatio?: number;
  };
  expected: { raw: RawDetJson[]; stats: StatsJson };
}

// Референс в temp/ — каталог в .gitignore и на CI отсутствует; фикстуры же
// коммитятся. skip остаётся только на случай чекаута без сгенерированных фикстур.
const haveFixtures = fixtureExists('decode_tile_sigmoid.json');

describe.skipIf(!haveFixtures)('паритет с Python-референсом (допуск 1e-6)', () => {
  for (const name of ['decode_tile_sigmoid.json', 'decode_tile_softmax_guard.json']) {
    it(`decodeTileOutputs ≡ decode_tile: ${name}`, () => {
      const fx = loadFixture<DecodeFixture>(name);
      const stats = newTileDecodeStats();
      const raw = decodeTileOutputs(fx.input.dets, fx.input.labels, {
        classMapping: fx.params.classMapping,
        resolution: fx.params.resolution,
        activation: fx.params.activation,
        numSelect: fx.params.numSelect,
        scoreFloor: fx.params.scoreFloor,
        boxFormat: fx.params.boxFormat,
        ...(fx.params.rejectFullTileTypes
          ? { rejectFullTileTypes: new Set(fx.params.rejectFullTileTypes) }
          : {}),
        ...(fx.params.fullTileMinRatio !== undefined
          ? { fullTileMinRatio: fx.params.fullTileMinRatio }
          : {}),
        stats,
      });
      expectRawDetsEqual(raw, fx.expected.raw);
      expectStatsEqual(stats, fx.expected.stats);
    });
  }

  it('classAwareNms/mergeSplitTextBoxes/filterByClassThreshold/capDetections ≡ nms.py', () => {
    const fx = loadFixture<{
      input: { dets: PixelDetJson[] };
      params: {
        nmsIou: number;
        thresholds: Partial<Record<DetectionBlockType, number>>;
        defaultThreshold: number;
        maxDetections: number;
      };
      expected: {
        afterNms: PixelDetJson[];
        afterMerge: PixelDetJson[];
        afterFilter: PixelDetJson[];
        capped: PixelDetJson[];
      };
    }>('nms_merge_filter_cap.json');
    const dets: PixelDet[] = fx.input.dets;
    const afterNms = classAwareNms(dets, { iouThreshold: fx.params.nmsIou });
    expectPixelDetsEqual(afterNms, fx.expected.afterNms);
    const afterMerge = mergeSplitTextBoxes(afterNms);
    expectPixelDetsEqual(afterMerge, fx.expected.afterMerge);
    const afterFilter = filterByClassThreshold(
      afterMerge,
      fx.params.thresholds,
      fx.params.defaultThreshold,
    );
    expectPixelDetsEqual(afterFilter, fx.expected.afterFilter);
    const capped = capDetections(afterFilter, fx.params.maxDetections);
    expectPixelDetsEqual(capped, fx.expected.capped);
  });

  it('planInferenceTiles/remapRectToPage/wholePageTile ≡ tiling.py', () => {
    const fx = loadFixture<{
      input: { tileForRemap: { tileId: number; x0: number; y0: number; x1: number; y1: number } };
      expected: {
        plans: Array<{
          input: { width: number; height: number; tileSize: number; overlap: number };
          expected: Array<{ tileId: number; x0: number; y0: number; x1: number; y1: number }>;
        }>;
        remaps: Array<{ input: { rect: number[] }; expected: number[] }>;
        wholePage: { tileId: number; x0: number; y0: number; x1: number; y1: number };
      };
    }>('tiling.json');

    for (const plan of fx.expected.plans) {
      const tiles = planInferenceTiles(plan.input.width, plan.input.height, {
        tileSize: plan.input.tileSize,
        overlap: plan.input.overlap,
      });
      expect(tiles.map(({ tileId, x0, y0, x1, y1 }) => ({ tileId, x0, y0, x1, y1 }))).toEqual(
        plan.expected,
      );
    }

    const t = fx.input.tileForRemap;
    const tile: InferenceTile = { ...t, width: t.x1 - t.x0, height: t.y1 - t.y0 };
    for (const remap of fx.expected.remaps) {
      const [a, b, c, d] = remap.input.rect as [number, number, number, number];
      const mapped = remapRectToPage([a, b, c, d], tile, 1800, 1400);
      for (let i = 0; i < 4; i += 1) {
        expectClose(mapped[i] as number, remap.expected[i] as number, `remap[${i}]`);
      }
    }

    const whole = wholePageTile(640, 480);
    expect({
      tileId: whole.tileId,
      x0: whole.x0,
      y0: whole.y0,
      x1: whole.x1,
      y1: whole.y1,
    }).toEqual(fx.expected.wholePage);
  });

  it('manifestParams/resolveInferenceMode ≡ model_params.py', () => {
    const fx = loadFixture<{
      input: { manifests: Record<string, unknown> };
      expected: Record<
        string,
        {
          mean: number[];
          std: number[];
          inputName: string;
          boxFormat: string;
          activation: string;
          numSelect: number;
          tileSize: number;
          overlap: number;
          resolution: number;
          dynamicBatch: boolean;
          trainingMode: string | null;
          minVisibility: number | null;
          resolvedAuto: { mode: string; source: string };
        }
      >;
    }>('manifest_params.json');

    for (const [name, manifest] of Object.entries(fx.input.manifests)) {
      const expected = fx.expected[name];
      expect(expected, name).toBeDefined();
      if (!expected) {
        continue;
      }
      const params = manifestParams(parseDetectionManifest(manifest));
      expect(params.inputName, name).toBe(expected.inputName);
      expect(params.boxFormat, name).toBe(expected.boxFormat);
      expect(params.activation, name).toBe(expected.activation);
      expect(params.numSelect, name).toBe(expected.numSelect);
      expect(params.tileSize, name).toBe(expected.tileSize);
      expect(params.overlap, name).toBe(expected.overlap);
      expect(params.resolution, name).toBe(expected.resolution);
      expect(params.dynamicBatch, name).toBe(expected.dynamicBatch);
      expect(params.trainingMode, name).toBe(expected.trainingMode);
      expect(params.minVisibility, name).toBe(expected.minVisibility);
      expect([...params.mean], name).toEqual(expected.mean);
      expect([...params.std], name).toEqual(expected.std);
      const resolved = resolveInferenceMode('auto', params.trainingMode);
      expect(resolved.mode, name).toBe(expected.resolvedAuto.mode);
      expect(resolved.source, name).toBe(expected.resolvedAuto.source);
    }
  });

  it('detectPageFromTiles ≡ числовой путь service._run_page (страница из 4 тайлов)', () => {
    const fx = loadFixture<{
      input: {
        pageWidth: number;
        pageHeight: number;
        tiles: Array<{
          tile: { tileId: number; x0: number; y0: number; x1: number; y1: number };
          dets: number[][];
          labels: number[][];
        }>;
      };
      params: {
        resolution: number;
        activation: 'sigmoid' | 'softmax';
        boxFormat: 'cxcywh_normalized' | 'xyxy_pixels';
        numSelect: number;
        tileSize: number;
        overlap: number;
        thresholds: Partial<Record<DetectionBlockType, number>>;
        defaultThreshold: number;
        nmsIou: number;
        mergeSplitText: boolean;
        maxDetections: number;
      };
      expected: {
        candidates: Array<{ blockType: DetectionBlockType; coordsNorm: number[]; score: number }>;
      };
    }>('page_pipeline.json');

    const params: InferenceParams = {
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      inputName: 'input',
      boxFormat: fx.params.boxFormat,
      activation: fx.params.activation,
      numSelect: fx.params.numSelect,
      tileSize: fx.params.tileSize,
      overlap: fx.params.overlap,
      resolution: fx.params.resolution,
      numClasses: 3,
      dynamicBatch: false,
      classMapping: { text: 0, image: 1, stamp: 2 },
      trainingMode: null,
      minVisibility: null,
      thresholds: fx.params.thresholds,
      defaultThreshold: fx.params.defaultThreshold,
      nmsIou: fx.params.nmsIou,
      mergeSplitText: fx.params.mergeSplitText,
      maxDetections: fx.params.maxDetections,
    };

    const tiles = fx.input.tiles.map(({ tile, dets, labels }) => ({
      tile: { ...tile, width: tile.x1 - tile.x0, height: tile.y1 - tile.y0 },
      dets,
      labels,
    }));
    const { candidates } = detectPageFromTiles({
      pageWidth: fx.input.pageWidth,
      pageHeight: fx.input.pageHeight,
      plannedTileCount: tiles.length,
      tiles,
      params,
    });

    expect(candidates.map((c) => c.blockType)).toEqual(
      fx.expected.candidates.map((c) => c.blockType),
    );
    for (const [i, exp] of fx.expected.candidates.entries()) {
      const act = candidates[i];
      expect(act).toBeDefined();
      if (!act) {
        continue;
      }
      expectClose(act.score, exp.score, `candidate[${i}].score`);
      for (let c = 0; c < 4; c += 1) {
        expectClose(
          act.coordsNorm[c] as number,
          exp.coordsNorm[c] as number,
          `candidate[${i}].coords[${c}]`,
        );
      }
    }
  });
});
