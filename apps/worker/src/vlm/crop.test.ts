/**
 * Crop policy v1 на настоящем sharp: размеры кропа, паддинг у краёв,
 * вырожденный кроп, маска полигона (пиксель вне контура — белый), даунскейл
 * (потолок длинной стороны и downscale-повтор) — детерминированы.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { cropBlockPng, CROP_POLICY_VERSION, downscalePng } from './crop.js';

async function solidPage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

interface RawImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
}

async function toRaw(png: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(Buffer.from(png)).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixelAt(image: RawImage, x: number, y: number): readonly number[] {
  const offset = (y * image.width + x) * image.channels;
  return Array.from(image.data.subarray(offset, offset + image.channels));
}

describe('CROP_POLICY_VERSION', () => {
  it('версия политики зафиксирована', () => {
    // Значение уезжает в провенанс КАЖДОГО распознанного блока и в снимок
    // прогона: по нему потом отвечают на вопрос «чем именно готовилась
    // картинка». Поэтому оно закреплено тестом — молча измениться не должно, а
    // изменившись осознанно, обязано поменяться и здесь.
    //
    // v2 — появился отдельный потолок длинной стороны для полностраничных
    // блоков (S27): общий 2048 px сжимал A4@300dpi в 1.7 раза.
    expect(CROP_POLICY_VERSION).toBe('crop.v2');
  });
});

describe('cropBlockPng: размеры и паддинг', () => {
  it('вырезает прямоугольник с паддингом 8px по умолчанию', async () => {
    const page = await solidPage(1000, 800, { r: 10, g: 20, b: 30 });

    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 1000,
      pageHeightPx: 800,
      coordsNorm: [0.2, 0.25, 0.4, 0.45],
      polygon: null,
    });

    // left0=floor(200)=200, top0=floor(200)=200, right0=ceil(400)=400, bottom0=ceil(360)=360
    // паддинг 8 → [192,192]..[408,368] → 216 x 176
    if ('degenerate' in result) throw new Error('ожидался обычный кроп, получен degenerate');
    expect(result.widthPx).toBe(216);
    expect(result.heightPx).toBe(176);
    expect(result.png.byteLength).toBeGreaterThan(0);
  });

  it('принимает путь к файлу наравне с буфером', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const page = await solidPage(300, 300, { r: 1, g: 2, b: 3 });
    const file = path.join(os.tmpdir(), `crop-test-${Date.now()}.png`);
    await fs.writeFile(file, page);
    try {
      const result = await cropBlockPng({
        pagePngPath: file,
        pageWidthPx: 300,
        pageHeightPx: 300,
        coordsNorm: [0.1, 0.1, 0.5, 0.5],
        polygon: null,
      });
      if ('degenerate' in result) throw new Error('ожидался обычный кроп, получен degenerate');
      expect(result.widthPx).toBeGreaterThan(0);
      expect(result.heightPx).toBeGreaterThan(0);
    } finally {
      await fs.unlink(file);
    }
  });

  it('паддинг клэмпится по границе страницы, а не уводит кроп в отрицательные координаты', async () => {
    const page = await solidPage(1000, 800, { r: 5, g: 5, b: 5 });

    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 1000,
      pageHeightPx: 800,
      // Блок в самом углу страницы: left0=0, top0=0.
      coordsNorm: [0, 0, 0.05, 0.05],
      polygon: null,
    });

    // right0=ceil(50)=50, bottom0=ceil(40)=40; паддинг слева/сверху клэмпится
    // в 0 (было бы -8), справа/снизу применяется полностью: 50+8=58, 40+8=48.
    if ('degenerate' in result) throw new Error('ожидался обычный кроп, получен degenerate');
    expect(result.widthPx).toBe(58);
    expect(result.heightPx).toBe(48);
  });

  it('координаты вне [0,1] клэмпятся, а не ломают вычисление кропа', async () => {
    const page = await solidPage(400, 300, { r: 9, g: 9, b: 9 });

    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 400,
      pageHeightPx: 300,
      coordsNorm: [-0.5, -0.2, 1.4, 1.3],
      polygon: null,
    });

    if ('degenerate' in result) throw new Error('ожидался обычный кроп, получен degenerate');
    // Клэмп в [0,1] даёт весь блок = вся страница; паддинг клэмпится границей.
    expect(result.widthPx).toBe(400);
    expect(result.heightPx).toBe(300);
  });
});

describe('cropBlockPng: вырожденный кроп', () => {
  it('сторона меньше 16px после паддинга даёт {degenerate: true}', async () => {
    // Маленькая страница: блок у угла получает паддинг только с одной стороны
    // (вторая клэмпится границей), и итоговая сторона меньше 16px.
    const page = await solidPage(20, 20, { r: 1, g: 1, b: 1 });

    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 20,
      pageHeightPx: 20,
      coordsNorm: [0, 0, 0.05, 0.05],
      polygon: null,
    });

    expect(result).toStrictEqual({ degenerate: true });
  });

  it('сторона ровно 16px НЕ считается вырожденной (строгое <)', async () => {
    // width0=0 (x0n===x1n по пикселям), паддинг не клэмпится ни с одной
    // стороны → итоговая сторона ровно 2*paddingPx = 16.
    const page = await solidPage(1000, 1000, { r: 1, g: 1, b: 1 });

    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 1000,
      pageHeightPx: 1000,
      coordsNorm: [0.5, 0.5, 0.5001, 0.5001],
      polygon: null,
      paddingPx: 8,
      minSidePx: 16,
    });

    if ('degenerate' in result) throw new Error('16px не должно считаться вырожденным');
    expect(result.widthPx).toBeGreaterThanOrEqual(16);
    expect(result.heightPx).toBeGreaterThanOrEqual(16);
  });
});

describe('cropBlockPng: маска полигона', () => {
  it('пиксель вне контура — белый, внутри — исходный цвет', async () => {
    const RED = { r: 255, g: 0, b: 0 };
    const page = await solidPage(200, 200, RED);

    // Блок 0.2..0.8 по обеим осям → до паддинга [40,40]..[160,160];
    // паддинг 8 → крoп [32,32]..[168,168], 136x136.
    // Полигон (нормализован к ВСЕЙ странице) — квадрат [60,60]..[140,140] в
    // пикселях страницы, то есть [28,28]..[108,108] в координатах кропа.
    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 200,
      pageHeightPx: 200,
      coordsNorm: [0.2, 0.2, 0.8, 0.8],
      polygon: [
        [0.3, 0.3],
        [0.7, 0.3],
        [0.7, 0.7],
        [0.3, 0.7],
      ],
    });

    if ('degenerate' in result) throw new Error('ожидался обычный кроп, получен degenerate');
    expect(result.widthPx).toBe(136);
    expect(result.heightPx).toBe(136);

    const raw = await toRaw(result.png);

    // (5,5) — заведомо вне контура [28,108], но внутри кропа: обязан быть белым.
    expect(pixelAt(raw, 5, 5).slice(0, 3)).toEqual([255, 255, 255]);
    // (60,60) — заведомо внутри контура: обязан остаться исходным (красным).
    expect(pixelAt(raw, 60, 60).slice(0, 3)).toEqual([255, 0, 0]);
    // (130,130) — вне контура с другой стороны: тоже белый.
    expect(pixelAt(raw, 130, 130).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('полигон с менее чем 3 точками игнорируется (маска не строится)', async () => {
    const page = await solidPage(100, 100, { r: 4, g: 8, b: 15 });

    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 100,
      pageHeightPx: 100,
      coordsNorm: [0.1, 0.1, 0.9, 0.9],
      polygon: [[0.5, 0.5]],
    });

    if ('degenerate' in result) throw new Error('ожидался обычный кроп, получен degenerate');
    const raw = await toRaw(result.png);
    // Без маски весь кроп остаётся исходным цветом — в т.ч. в углу кропа.
    expect(pixelAt(raw, 1, 1).slice(0, 3)).toEqual([4, 8, 15]);
  });
});

describe('cropBlockPng: потолок длинной стороны', () => {
  it('длинная сторона сверх потолка уменьшается детерминированным ресемплингом', async () => {
    const page = await solidPage(600, 600, { r: 100, g: 100, b: 100 });

    const once = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 600,
      pageHeightPx: 600,
      coordsNorm: [0.05, 0.05, 0.95, 0.95],
      polygon: null,
      maxLongEdgePx: 100,
    });
    const again = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 600,
      pageHeightPx: 600,
      coordsNorm: [0.05, 0.05, 0.95, 0.95],
      polygon: null,
      maxLongEdgePx: 100,
    });

    if ('degenerate' in once || 'degenerate' in again) {
      throw new Error('ожидался обычный кроп, получен degenerate');
    }
    expect(Math.max(once.widthPx, once.heightPx)).toBeLessThanOrEqual(100);
    // Детерминизм: тот же вход даёт побайтово тот же результат.
    expect(Buffer.from(again.png).equals(Buffer.from(once.png))).toBe(true);
  });

  it('кроп короче потолка не трогается ресемплингом', async () => {
    const page = await solidPage(300, 300, { r: 7, g: 7, b: 7 });

    const result = await cropBlockPng({
      pageBuffer: page,
      pageWidthPx: 300,
      pageHeightPx: 300,
      coordsNorm: [0.1, 0.1, 0.3, 0.3],
      polygon: null,
      maxLongEdgePx: 2048,
    });

    if ('degenerate' in result) throw new Error('ожидался обычный кроп, получен degenerate');
    // left0=30,top0=30,right0=90,bottom0=90; паддинг 8 → 22..98 → 76x76.
    expect(result.widthPx).toBe(76);
    expect(result.heightPx).toBe(76);
  });
});

describe('downscalePng', () => {
  it('уменьшает обе стороны в factor раз (по умолчанию 0.7) детерминированно', async () => {
    const source = await solidPage(50, 40, { r: 200, g: 150, b: 50 });

    const once = await downscalePng(new Uint8Array(source));
    const again = await downscalePng(new Uint8Array(source));

    const raw = await toRaw(once);
    expect(raw.width).toBe(Math.round(50 * 0.7));
    expect(raw.height).toBe(Math.round(40 * 0.7));
    expect(Buffer.from(again).equals(Buffer.from(once))).toBe(true);
  });

  it('принимает произвольный коэффициент', async () => {
    const source = await solidPage(100, 100, { r: 1, g: 2, b: 3 });

    const half = await downscalePng(new Uint8Array(source), 0.5);
    const raw = await toRaw(half);

    expect(raw.width).toBe(50);
    expect(raw.height).toBe(50);
  });

  it('изображение 1x1 возвращается как есть (дальше уменьшать некуда)', async () => {
    const source = await solidPage(1, 1, { r: 42, g: 42, b: 42 });
    const bytes = new Uint8Array(source);

    const result = await downscalePng(bytes);

    expect(Buffer.from(result).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('cropBlockPng: валидация входа', () => {
  it('требует pagePngPath либо pageBuffer', async () => {
    await expect(
      cropBlockPng({
        pageWidthPx: 100,
        pageHeightPx: 100,
        coordsNorm: [0, 0, 1, 1],
        polygon: null,
      }),
    ).rejects.toThrow(/pagePngPath.*pageBuffer/);
  });
});
