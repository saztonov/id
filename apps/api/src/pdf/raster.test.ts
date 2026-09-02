/**
 * Растеризация: что проверяемо без бинарника poppler (ADR-0008).
 *
 * Живой рендер — гейт приёмки на целевой машине; здесь закрыты обнаружение,
 * состав аргументов и разбор PNG-заголовка (паттерн qpdf.test).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectPdftoppm, pdftoppmArgs, selectRasterizer } from './pdftoppm.js';
import {
  effectiveRasterDpi,
  RASTER_DPI,
  RASTER_MAX_PIXELS,
  RasterizerError,
  readPngSize,
} from './raster.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'id-raster-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Минимальный корректный заголовок PNG: сигнатура + длина IHDR + IHDR + размеры. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // длина IHDR
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('readPngSize', () => {
  it('читает размеры из IHDR', async () => {
    const path = join(dir, 'ok.png');
    await writeFile(path, pngHeader(2477, 3507));
    await expect(readPngSize(path)).resolves.toEqual({ widthPx: 2477, heightPx: 3507 });
  });

  it('отвергает не-PNG', async () => {
    const path = join(dir, 'not.png');
    await writeFile(path, Buffer.from('%PDF-1.7 это вообще не картинка, а огрызок'));
    await expect(readPngSize(path)).rejects.toBeInstanceOf(RasterizerError);
  });

  it('отвергает нулевой размер', async () => {
    const path = join(dir, 'zero.png');
    await writeFile(path, pngHeader(0, 10));
    await expect(readPngSize(path)).rejects.toBeInstanceOf(RasterizerError);
  });
});

describe('разрешение рендера', () => {
  /** Стороны листов в пунктах (1 pt = 1/72 дюйма), как в карте страниц. */
  const A4 = { w: 595, h: 842 };
  const A2 = { w: 1191, h: 1684 };
  const A1 = { w: 1684, h: 2384 };
  const A0 = { w: 2384, h: 3370 };

  const pixelsAt = (page: { w: number; h: number }, dpi: number): number =>
    ((page.w * dpi) / 72) * ((page.h * dpi) / 72);

  it('обычные форматы рендерятся на полном разрешении', () => {
    // Потолок площади заведён не ради экономии, а против листов, которые не
    // влезают в память: терять качество там, где всё влезает, незачем.
    expect(effectiveRasterDpi(A4.w, A4.h)).toBe(RASTER_DPI);
    expect(effectiveRasterDpi(A2.w, A2.h)).toBe(RASTER_DPI);
  });

  it('крупноформатный лист укладывается в потолок площади', () => {
    // A1 на 300 DPI — около 70 мегапикселей и сотни мегабайт сырого растра:
    // такой лист укладывал воркер при любом параллелизме очереди.
    expect(pixelsAt(A1, RASTER_DPI)).toBeGreaterThan(RASTER_MAX_PIXELS);

    for (const page of [A1, A0]) {
      const dpi = effectiveRasterDpi(page.w, page.h);
      expect(dpi).toBeLessThan(RASTER_DPI);
      expect(pixelsAt(page, dpi)).toBeLessThanOrEqual(RASTER_MAX_PIXELS);
    }
  });

  it('чем больше лист, тем ниже разрешение, и оно не обнуляется', () => {
    // Монотонность важна как свойство: две страницы одного комплекта не должны
    // получать разрешение в обратном порядке своих размеров.
    expect(effectiveRasterDpi(A0.w, A0.h)).toBeLessThan(effectiveRasterDpi(A1.w, A1.h));
    // Нижняя граница — разрешение миниатюры: ниже текст не читается, и рендер
    // такой страницы бессмыслен даже ради того, чтобы не упасть.
    expect(effectiveRasterDpi(100_000, 100_000)).toBeGreaterThanOrEqual(72);
  });

  it('нечитаемая геометрия не мешает рендеру: остаётся умолчание', () => {
    // Размеры приходят из карты страниц, и «страницы без размеров» там быть не
    // должно — но отказывать в рендере из-за этого не за что.
    expect(effectiveRasterDpi(0, 0)).toBe(RASTER_DPI);
    expect(effectiveRasterDpi(Number.NaN, 842)).toBe(RASTER_DPI);
  });

  it('родное разрешение страницы ограничивает рендер сверху', () => {
    // Замер по пяти боевым комплектам: сканы лежат в 200 dpi, и рендер в 300
    // растягивал те же пиксели, ничего не прибавляя.
    expect(effectiveRasterDpi(A4.w, A4.h, 200)).toBe(200);
  });

  it('родное разрешение выше умолчания рендер не поднимает', () => {
    // Выше RASTER_DPI детектор не обучен, и скан в 600 dpi не повод туда идти.
    expect(effectiveRasterDpi(A4.w, A4.h, 600)).toBe(RASTER_DPI);
  });

  it('неизвестное родное разрешение оставляет прежнее поведение', () => {
    // `null` означает «покрывающего растра не нашлось» — страница нарисована
    // шрифтами либо картинка не опознана. Обе причины ведут к полному рендеру.
    expect(effectiveRasterDpi(A4.w, A4.h, null)).toBe(RASTER_DPI);
    expect(effectiveRasterDpi(A4.w, A4.h, undefined)).toBe(RASTER_DPI);
    expect(effectiveRasterDpi(A4.w, A4.h, 0)).toBe(RASTER_DPI);
    expect(effectiveRasterDpi(A4.w, A4.h, Number.NaN)).toBe(RASTER_DPI);
  });

  it('потолок площади остаётся главнее родного разрешения', () => {
    // A0, отсканированный в 200 dpi, всё равно не помещается: потолок площади
    // про то, что машина не должна лечь, а не про качество картинки.
    const dpi = effectiveRasterDpi(A0.w, A0.h, 200);
    expect(dpi).toBeLessThan(200);
    expect(pixelsAt(A0, dpi)).toBeLessThanOrEqual(RASTER_MAX_PIXELS);
  });
});

describe('pdftoppmArgs', () => {
  it('строит 1-базный диапазон из 0-базного индекса и singlefile-выход', () => {
    expect(
      pdftoppmArgs(
        { pdfPath: 'C:/tmp/in.pdf', pageIndex: 0, dpi: 300, outPath: 'C:/tmp/p0000.png' },
        'C:/tmp/p0000',
      ),
    ).toEqual([
      '-f',
      '1',
      '-l',
      '1',
      '-r',
      '300',
      '-png',
      '-singlefile',
      'C:/tmp/in.pdf',
      'C:/tmp/p0000',
    ]);
  });
});

describe('обнаружение', () => {
  it('честно отвечает про несуществующий бинарник', async () => {
    const detection = await detectPdftoppm('pdftoppm-которого-нет');
    expect(detection.available).toBe(false);
    expect(detection.error).not.toBeNull();
  });

  it('selectRasterizer отдаёт null без бинарника, а не бросает', async () => {
    await expect(selectRasterizer({ binary: 'pdftoppm-которого-нет' })).resolves.toBeNull();
  });
});
