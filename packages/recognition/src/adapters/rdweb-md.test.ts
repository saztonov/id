/**
 * Адаптер rdweb-md.v1: синтетический round-trip плюс golden-прогон по
 * закрытому корпусу, если он лежит на машине (`describe.skipIf` — тот же
 * паттерн, что у corpus-reference.test.ts: CI без корпуса не краснеет).
 * Синтетические значения вымышлены целиком (§1.4).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { recognitionResultSchema } from '../schema.js';
import { renderPageText } from '../render.js';
import {
  canonicalFromArchiveEntries,
  parseImageContent,
  parseStampLine,
  RDWEB_MD_ADAPTER_VERSION,
} from './rdweb-md.js';

const MD = `# Document: synthetic.pdf

Path: Синтетика / synthetic.pdf

Generated: 2026-08-18 00:00:00 UTC

**Stamp:** Code: СИН-ИД | Stage: ИД | Object: Синтетический объект | Organization: ООО «Синтет»

---

## Page 1

### BLOCK #1 [TEXT]: blk_00000000000000000000000000000001

> **Created:** 2026-08-18 00:00:00 UTC
> **Crop:** [Crop](https://example.invalid/api/crops/1)
> **Stamp:** Code: СИН-ИД | Stage: ИД | Sheet: 3 | Organization: ООО «Синтет»

##### АКТ

###### освидетельствования скрытых работ

№ 7-СИН от 15.03.2026

### BLOCK #2 [IMAGE]: blk_00000000000000000000000000000002

> **Created:** 2026-08-18 00:00:00 UTC
> **Crop:** [Crop](https://example.invalid/api/crops/2)

**[IMAGE]** | Type: План | Level: -1 этаж

**Summary:** Синтетическая исполнительная схема.

**Description:** Один лист. Внизу штамп «СИН-1586».

## Page 3

### BLOCK #1 [TEXT]: blk_00000000000000000000000000000003

> **Created:** 2026-08-18 00:00:00 UTC
> **Crop:** [Crop](https://example.invalid/api/crops/3)

Реестр № 1 к АОСР № 7-СИН от 15.03.2026
`;

const BLOCKS = JSON.stringify({
  schema_version: 1,
  generated_at: '2026-08-18T00:00:00Z',
  coordinate_space: 'normalized_page_top_left',
  pages: [
    { page_index: 0, width_px: 2480, height_px: 3507, rotation: 0 },
    { page_index: 1, width_px: 2480, height_px: 3507, rotation: 0 },
    { page_index: 2, width_px: 2480, height_px: 3507, rotation: 90 },
  ],
  blocks: [
    {
      block_id: 'blk_00000000000000000000000000000001',
      ordinal: 1,
      page_index: 0,
      page_label: 1,
      block_type: 'text',
      coords_norm: [0.1, 0.1, 0.9, 0.5],
      crop_url: 'https://example.invalid/api/crops/1',
    },
    {
      block_id: 'blk_00000000000000000000000000000002',
      ordinal: 2,
      page_index: 0,
      page_label: 1,
      block_type: 'image',
      coords_norm: [0.1, 0.5, 0.9, 0.9],
      crop_url: 'https://example.invalid/api/crops/2',
    },
    {
      block_id: 'blk_000000000000000000000000000000aa',
      ordinal: null,
      page_index: 0,
      page_label: 1,
      block_type: 'stamp',
      coords_norm: [0.7, 0.9, 0.95, 0.98],
      crop_url: null,
    },
    {
      block_id: 'blk_00000000000000000000000000000003',
      ordinal: 1,
      page_index: 2,
      page_label: 3,
      block_type: 'text',
      coords_norm: [0.1, 0.1, 0.9, 0.9],
      crop_url: 'https://example.invalid/api/crops/3',
    },
  ],
});

describe('canonicalFromArchiveEntries — синтетика', () => {
  const result = canonicalFromArchiveEntries(MD, BLOCKS);

  it('результат валиден по схеме и не содержит подписанных URL', () => {
    // `crop_url` и ссылки `> **Crop:**` присутствуют во входе — schema.parse
    // упал бы, просочись хоть одна (§11).
    expect(() => recognitionResultSchema.parse(result)).not.toThrow();
    expect(result.source.provider).toBe('rdweb_md');
    expect(result.source.adapterVersion).toBe(RDWEB_MD_ADAPTER_VERSION);
  });

  it('страница без блоков законно пуста', () => {
    expect(result.pages).toHaveLength(3);
    expect(result.pages[1]?.text).toBe('');
    expect(result.pages[1]?.blocks).toEqual([]);
  });

  it('текст страницы очищен от провенанса и заголовков блоков', () => {
    const text = result.pages[0]?.text ?? '';

    expect(text).toContain('##### АКТ');
    expect(text).not.toContain('BLOCK #');
    expect(text).not.toContain('Crop');
    expect(text).not.toContain('Stamp:');
  });

  it('renderPageText возвращает legacy-текст байт-в-байт', () => {
    for (const page of result.pages) {
      expect(renderPageText(page)).toBe(page.text);
    }
  });

  it('IMAGE-блок разобран в структурные поля', () => {
    const image = result.pages[0]?.blocks.find((block) => block.blockType === 'image');

    expect(image?.blockType).toBe('image');
    if (image?.blockType === 'image') {
      expect(image.image.imageType).toBe('План');
      expect(image.image.level).toBe('-1 этаж');
      expect(image.image.summary).toBe('Синтетическая исполнительная схема.');
      expect(image.image.description).toContain('СИН-1586');
    }
  });

  it('штамп получил поля из строки `> **Stamp:**` своей страницы', () => {
    const stamp = result.pages[0]?.blocks.find((block) => block.blockType === 'stamp');

    expect(stamp?.blockType).toBe('stamp');
    if (stamp?.blockType === 'stamp') {
      expect(stamp.stamp.code).toBe('СИН-ИД');
      expect(stamp.stamp.sheet).toBe('3');
      expect(stamp.stamp.organization).toBe('ООО «Синтет»');
    }
  });

  it('геометрия и идентификаторы блоков пришли из blocks.json', () => {
    const text = result.pages[0]?.blocks.find((block) => block.blockType === 'text');

    expect(text?.coordsNorm).toEqual([0.1, 0.1, 0.9, 0.5]);
    expect(text?.blockId).toBe('blk_00000000000000000000000000000001');
    expect(result.pages[2]?.rotation).toBe(90);
  });

  it('без blocks.json строится md-only результат (форма архива job)', () => {
    const bare = canonicalFromArchiveEntries(MD);

    expect(() => recognitionResultSchema.parse(bare)).not.toThrow();
    expect(bare.pages.map((page) => page.workingPageIndex)).toEqual([0, 2]);
    expect(bare.pages[0]?.widthPx).toBeNull();
    expect(bare.pages[0]?.blocks.some((block) => block.blockType === 'stamp')).toBe(false);
  });

  it('усечённый экспорт и чужая страница markdown — ошибки', () => {
    const truncated = MD.replace(/## Page 3[\s\S]*$/u, '');

    expect(() => canonicalFromArchiveEntries(truncated, BLOCKS)).toThrow(/усечён/u);
    expect(() =>
      canonicalFromArchiveEntries(`${MD}\n## Page 9\n\nчужая страница\n`, BLOCKS),
    ).toThrow(/нет в blocks\.json/u);
  });
});

describe('разбор строк штампа и IMAGE-секций', () => {
  it('незнакомые ключи штампа не теряются, а уходят в extra', () => {
    const stamp = parseStampLine('Code: А-1 | Stage: ИД | Custom: значение');

    expect(stamp.code).toBe('А-1');
    expect(stamp.extra).toEqual({ Custom: 'значение' });
  });

  it('Entities разбирается списком', () => {
    const image = parseImageContent([
      '**[IMAGE]** | Type: Схема',
      '',
      '**Entities:** штамп СИН-1, печать «Синтет»',
    ]);

    expect(image.entities).toEqual(['штамп СИН-1', 'печать «Синтет»']);
  });
});

// ---------------------------------------------------------------------------
// Golden: все пакеты закрытого корпуса, если он есть на машине
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, 'temp', 'MD');

function goldenPackages(): readonly string[] {
  if (!existsSync(GOLDEN_DIR)) return [];
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    const files = readdirSync(dir);
    if (
      files.some((f) => f.endsWith('_results.md')) &&
      files.some((f) => f.endsWith('_blocks.json'))
    ) {
      found.push(dir);
      return;
    }
    if (depth >= 2) return;
    for (const entry of files) {
      const child = join(dir, entry);
      if (statSync(child).isDirectory()) visit(child, depth + 1);
    }
  };
  visit(GOLDEN_DIR, 0);
  return found;
}

const GOLDEN = goldenPackages();

describe.skipIf(GOLDEN.length === 0)('golden: адаптер на закрытом корпусе', () => {
  it('каждый пакет валиден, без URL, с полным набором страниц', () => {
    expect(GOLDEN.length).toBeGreaterThan(0);
    for (const dir of GOLDEN) {
      const files = readdirSync(dir);
      const md = readFileSync(
        join(dir, files.find((f) => f.endsWith('_results.md')) ?? ''),
        'utf8',
      );
      const blocks = readFileSync(
        join(dir, files.find((f) => f.endsWith('_blocks.json')) ?? ''),
        'utf8',
      );
      const parsed = JSON.parse(blocks) as {
        pages?: unknown[];
        blocks?: { block_type: string }[];
      };

      const result = canonicalFromArchiveEntries(md, blocks);
      expect(() => recognitionResultSchema.parse(result), dir).not.toThrow();
      expect(result.pages, dir).toHaveLength(parsed.pages?.length ?? 0);

      const stampsIn = (parsed.blocks ?? []).filter((b) => b.block_type === 'stamp').length;
      const stampsOut = result.pages.reduce(
        (sum, page) => sum + page.blocks.filter((b) => b.blockType === 'stamp').length,
        0,
      );
      expect(stampsOut, dir).toBe(stampsIn);

      for (const page of result.pages) {
        expect(renderPageText(page), `${dir} стр. ${page.workingPageIndex + 1}`).toBe(page.text);
      }
    }
  }, 60_000);
});
