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
import { RasterizerError, readPngSize } from './raster.js';

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

describe('pdftoppmArgs', () => {
  it('строит 1-базный диапазон из 0-базного индекса и singlefile-выход', () => {
    expect(
      pdftoppmArgs(
        { pdfPath: 'C:/tmp/in.pdf', pageIndex: 0, dpi: 300, outPath: 'C:/tmp/p0000.png' },
        'C:/tmp/p0000',
      ),
    ).toEqual(['-f', '1', '-l', '1', '-r', '300', '-png', '-singlefile', 'C:/tmp/in.pdf', 'C:/tmp/p0000']);
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
