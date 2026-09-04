/**
 * Оркестрация `detectPage`: план плиток → (blank-skip) → препроцессинг → ONNX
 * (фиктивная сессия с фикстурными тензорами) → числовой постпроцесс
 * `@id/detection`. Настоящий sharp на маленьких PNG, без бинарника ONNX.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOX_FORMAT_CXCYWH_NORMALIZED,
  CLASS_ACTIVATION_SIGMOID,
  type InferenceParams,
} from '@id/detection';

import { detectPage } from './detector.js';
import type { OnnxSessionPort, OnnxTensorLike } from './session.js';

async function solidPagePath(
  dir: string,
  name: string,
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<string> {
  const png = await sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
  const path = join(dir, name);
  await writeFile(path, png);
  return path;
}

/** Один запрос (Q=1): один known-текстовый бокс с высоким score. */
function oneTextDetectionTensors(): {
  readonly dets: OnnxTensorLike;
  readonly labels: OnnxTensorLike;
} {
  return {
    // cxcywh normalized: cx=0.5 cy=0.5 w=0.4 h=0.2 -> xyxy [0.3,0.4,0.7,0.6]
    dets: { data: Float32Array.from([0.5, 0.5, 0.4, 0.2]), dims: [1, 1, 4] },
    // text=+10 (sigmoid≈0.99995), image/stamp/no-object=-10 (sigmoid≈0.0000454)
    labels: { data: Float32Array.from([10, -10, -10, -10]), dims: [1, 1, 4] },
  };
}

/** Пустые запросы: все логиты глубоко отрицательные — ничего не проходит порог. */
function emptyDetectionTensors(): {
  readonly dets: OnnxTensorLike;
  readonly labels: OnnxTensorLike;
} {
  return {
    dets: { data: Float32Array.from([0.5, 0.5, 0.1, 0.1]), dims: [1, 1, 4] },
    labels: { data: Float32Array.from([-10, -10, -10, -10]), dims: [1, 1, 4] },
  };
}

const BASE_PARAMS: InferenceParams = {
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  inputName: 'input',
  boxFormat: BOX_FORMAT_CXCYWH_NORMALIZED,
  activation: CLASS_ACTIVATION_SIGMOID,
  numSelect: 300,
  tileSize: 1024,
  overlap: 128,
  resolution: 16,
  numClasses: 3,
  dynamicBatch: false,
  classMapping: { text: 0, image: 1, stamp: 2 },
  trainingMode: 'whole_page',
  minVisibility: null,
  thresholds: {},
  defaultThreshold: 0.5,
  nmsIou: 0.5,
  mergeSplitText: false,
  maxDetections: null,
};

class FakeSession implements OnnxSessionPort {
  calls = 0;
  constructor(
    private readonly output: { readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike },
  ) {}

  async run(): Promise<{ readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike }> {
    this.calls += 1;
    return this.output;
  }
}

describe('detectPage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'id-detector-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('whole_page: одна плитка, одна детекция, координаты в норм. системе страницы', async () => {
    const width = 64;
    const height = 48;
    const png = await solidPagePath(dir, 'page.png', width, height, { r: 30, g: 40, b: 50 });
    const session = new FakeSession(oneTextDetectionTensors());

    const result = await detectPage({
      pageIndex: 3,
      pngPath: png,
      widthPx: width,
      heightPx: height,
      session,
      params: BASE_PARAMS,
    });

    expect(session.calls).toBe(1);
    expect(result.stats.tilesPlanned).toBe(1);
    expect(result.stats.tilesInferred).toBe(1);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.blockType).toBe('text');
    expect(candidate.score).toBeCloseTo(1 / (1 + Math.exp(-10)), 5);
    expect(candidate.coordsNorm[0]).toBeCloseTo(0.3, 5);
    expect(candidate.coordsNorm[1]).toBeCloseTo(0.4, 5);
    expect(candidate.coordsNorm[2]).toBeCloseTo(0.7, 5);
    expect(candidate.coordsNorm[3]).toBeCloseTo(0.6, 5);
    // plannedTileCount<=1 -> modeMismatchWarning всегда null (правило пакета).
    expect(result.warning).toBeNull();
  });

  it('нулевые детекции — терминальный успех, а не исключение', async () => {
    const width = 32;
    const height = 32;
    const png = await solidPagePath(dir, 'empty.png', width, height, { r: 5, g: 5, b: 5 });
    const session = new FakeSession(emptyDetectionTensors());

    const result = await detectPage({
      pageIndex: 0,
      pngPath: png,
      widthPx: width,
      heightPx: height,
      session,
      params: BASE_PARAMS,
    });

    expect(result.candidates).toEqual([]);
    expect(result.stats.tilesInferred).toBe(1);
  });

  it('тайловый режим: полностью однотонные плитки пропускаются (blank-skip), ONNX не вызывается', async () => {
    // tileSize=16 без overlap, страница 48×16 -> три плитки по ширине (>1
    // плитки => настоящий тайловый режим, blank-skip активен).
    const params: InferenceParams = {
      ...BASE_PARAMS,
      tileSize: 16,
      overlap: 0,
      trainingMode: 'tiles',
    };
    const width = 48;
    const height = 16;
    const png = await solidPagePath(dir, 'blank.png', width, height, { r: 250, g: 250, b: 250 });
    const session = new FakeSession(oneTextDetectionTensors());

    const result = await detectPage({
      pageIndex: 1,
      pngPath: png,
      widthPx: width,
      heightPx: height,
      session,
      params,
    });

    expect(result.stats.tilesPlanned).toBe(3);
    expect(result.stats.tilesInferred).toBe(0);
    expect(session.calls).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it('тайловый режим: неоднородная плитка не пропускается', async () => {
    const params: InferenceParams = {
      ...BASE_PARAMS,
      tileSize: 16,
      overlap: 0,
      trainingMode: 'tiles',
    };
    const width = 48;
    const height = 16;

    // Первая плитка НЕОДНОРОДНА внутри себя (чёрный квадрат 8×8 на белом фоне
    // той же плитки 16×16) — иначе плитка одного цвета блочно, пусть и другого
    // от соседних, всё равно blank (std=0 у неё самой). Остальные две плитки —
    // чистый белый фон, std=0, пропускаются.
    const square = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const page = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: square, left: 4, top: 4 }])
      .png()
      .toBuffer();
    const path = join(dir, 'mixed.png');
    await writeFile(path, page);

    const session = new FakeSession(oneTextDetectionTensors());
    const result = await detectPage({
      pageIndex: 2,
      pngPath: path,
      widthPx: width,
      heightPx: height,
      session,
      params,
    });

    expect(result.stats.tilesPlanned).toBe(3);
    expect(result.stats.tilesInferred).toBe(1);
    expect(session.calls).toBe(1);
    expect(result.candidates).toHaveLength(1);
  });

  it('некорректные размеры страницы — пустой результат без исключения и без вызова ONNX', async () => {
    const session = new FakeSession(oneTextDetectionTensors());
    const result = await detectPage({
      pageIndex: 0,
      pngPath: join(dir, 'nonexistent.png'),
      widthPx: 0,
      heightPx: 100,
      session,
      params: BASE_PARAMS,
    });
    expect(result.candidates).toEqual([]);
    expect(session.calls).toBe(0);
  });
});
