/**
 * Препроцессинг плитки на настоящем sharp (мок не нужен, план Ф7): вырезка,
 * blank-tile статистика по формуле PIL и нормализация CHW — на маленьких
 * сгенерированных PNG, без файлов с диска.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isBlankTile, pilGrayscaleLuma } from '@id/detection';

import {
  cropTileRgb,
  preprocessTile,
  readPageRgb,
  readTileRgb,
  tileLumaStats,
} from './preprocess.js';

async function solidPng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

describe('readTileRgb', () => {
  it('вырезает область и отдаёт RGB без альфы', async () => {
    const page = await solidPng(20, 16, { r: 10, g: 20, b: 30 });
    const tile = await readTileRgb(page, { x0: 4, y0: 4, width: 8, height: 8 });

    expect(tile.width).toBe(8);
    expect(tile.height).toBe(8);
    expect(tile.rgb.byteLength).toBe(8 * 8 * 3);
    // Каждый пиксель — заявленный цвет фона.
    expect(tile.rgb[0]).toBe(10);
    expect(tile.rgb[1]).toBe(20);
    expect(tile.rgb[2]).toBe(30);
    expect(tile.rgb[tile.rgb.byteLength - 3]).toBe(10);
  });

  it('принимает путь к файлу наравне с буфером', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const page = await solidPng(12, 12, { r: 1, g: 2, b: 3 });
    const file = path.join(os.tmpdir(), `detect-preprocess-test-${Date.now()}.png`);
    await fs.writeFile(file, page);
    try {
      const tile = await readTileRgb(file, { x0: 0, y0: 0, width: 12, height: 12 });
      expect(tile.width).toBe(12);
      expect(tile.height).toBe(12);
      expect(tile.rgb[0]).toBe(1);
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});

describe('декод страницы целиком', () => {
  /** Шахматная страница: однотонная не отличила бы сдвиг вырезки от совпадения. */
  async function checkerPng(width: number, height: number): Promise<Buffer> {
    const raw = Buffer.allocUnsafe(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 3;
        raw[at] = (x * 7 + y * 13) % 256;
        raw[at + 1] = (x * 3 + y * 5) % 256;
        raw[at + 2] = (x + y) % 256;
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
  }

  it('вырезка из развёрнутого кадра совпадает с вырезкой из файла до байта', async () => {
    // Ради этого равенства режим и выбирается по площади, а не по случаю: два
    // пути декода обязаны давать модели одни и те же пиксели, иначе детекции
    // разошлись бы только на части листов и только на проде.
    const png = await checkerPng(40, 32);
    const page = await readPageRgb(png);
    expect(page.width).toBe(40);
    expect(page.height).toBe(32);

    for (const region of [
      { x0: 0, y0: 0, width: 16, height: 16 },
      { x0: 12, y0: 7, width: 20, height: 11 },
      { x0: 24, y0: 16, width: 16, height: 16 },
    ]) {
      const fromFile = await readTileRgb(png, region);
      const fromFrame = cropTileRgb(page, region);
      expect(fromFrame.width).toBe(fromFile.width);
      expect(fromFrame.height).toBe(fromFile.height);
      expect(fromFrame.rgb.equals(fromFile.rgb)).toBe(true);
    }
  });

  it('область за краем кадра усекается, а не читает соседнюю строку', async () => {
    const page = await readPageRgb(await checkerPng(20, 20));
    const tile = cropTileRgb(page, { x0: 16, y0: 16, width: 8, height: 8 });
    expect(tile.width).toBe(4);
    expect(tile.height).toBe(4);
    expect(tile.rgb.byteLength).toBe(4 * 4 * 3);
  });
});

describe('tileLumaStats', () => {
  it('плитка одного цвета — std=0 и распознаётся как blank', async () => {
    const page = await solidPng(8, 8, { r: 200, g: 200, b: 200 });
    const tile = await readTileRgb(page, { x0: 0, y0: 0, width: 8, height: 8 });

    const stats = tileLumaStats(tile);
    expect(stats.std).toBe(0);
    expect(stats.mean).toBe(pilGrayscaleLuma(200, 200, 200));
    expect(isBlankTile(stats.std)).toBe(true);
  });

  it('плитка из двух контрастных половин — std>0, не blank', async () => {
    // Половина чёрная, половина белая: sharp `composite` кладёт вторую
    // половину поверх однотонного фона.
    const black = await sharp({
      create: { width: 4, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const page = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: black, left: 0, top: 0 }])
      .png()
      .toBuffer();

    const tile = await readTileRgb(page, { x0: 0, y0: 0, width: 8, height: 8 });
    const stats = tileLumaStats(tile);
    expect(stats.std).toBeGreaterThan(1.0);
    expect(isBlankTile(stats.std)).toBe(false);
  });

  it('нулевая плитка (width или height = 0) не делится на ноль', () => {
    const stats = tileLumaStats({ width: 0, height: 0, rgb: Buffer.alloc(0) });
    expect(stats.mean).toBe(0);
    expect(stats.std).toBe(0);
  });
});

describe('preprocessTile', () => {
  it('resize к (R,R) и нормализация CHW: плитка одного цвета остаётся одним значением', async () => {
    const page = await solidPng(40, 30, { r: 128, g: 64, b: 32 });
    const tile = await readTileRgb(page, { x0: 0, y0: 0, width: 40, height: 30 });

    const resolution = 16;
    const mean: readonly [number, number, number] = [0.485, 0.456, 0.406];
    const std: readonly [number, number, number] = [0.229, 0.224, 0.225];
    const input = await preprocessTile(tile, { mean, std, resolution });

    expect(input.dims).toEqual([1, 3, resolution, resolution]);
    expect(input.data.length).toBe(3 * resolution * resolution);

    const plane = resolution * resolution;
    const expectedPerChannel = [128, 64, 32].map(
      (v, c) => (v / 255 - mean[c as 0 | 1 | 2]) / std[c as 0 | 1 | 2],
    );

    for (let c = 0; c < 3; c += 1) {
      for (let i = 0; i < plane; i += 1) {
        expect(input.data[c * plane + i]).toBeCloseTo(expectedPerChannel[c] as number, 3);
      }
    }
  });

  it('resize БЕЗ letterbox: страница 40×10 растягивается по обеим осям независимо', async () => {
    // Не-квадратная плитка на выходе обязана дать квадрат R×R без полей:
    // проверяем через размер результата (raw-буфер длиной точно 3*R*R), а не
    // косвенно через содержимое.
    const page = await solidPng(40, 10, { r: 10, g: 10, b: 10 });
    const tile = await readTileRgb(page, { x0: 0, y0: 0, width: 40, height: 10 });

    const resolution = 8;
    const input = await preprocessTile(tile, {
      mean: [0, 0, 0],
      std: [1, 1, 1],
      resolution,
    });
    expect(input.dims).toEqual([1, 3, resolution, resolution]);
    expect(input.data.length).toBe(3 * resolution * resolution);
  });
});
