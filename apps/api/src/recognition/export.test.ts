/**
 * Разбор экспорта: страницы, блоки и вырезание подписанных ссылок (§5.2, §11).
 *
 * Форма Markdown взята из реальных выгрузок `temp/MD/*` и из их
 * `render_markdown.py`, а не придумана: заголовок `## Page N` с номером от
 * ЕДИНИЦЫ, `### BLOCK #k [TYPE]: <block_id>` и строки провенанса `>` перед
 * телом блока.
 */
import { describe, expect, it } from 'vitest';

import { ExportFormatError, parseExportMarkdown, requireEntry } from './export.js';

const MARKDOWN = [
  '# Document: комплект.pdf',
  '',
  'Path: 011 - кровля автостоянки / комплект.pdf',
  '',
  'Generated: 2026-08-16 05:53:14 UTC',
  '',
  '**Stamp:** Code: СТ26/01-14-ДК2-РД | Stage: ИД',
  '',
  '---',
  '',
  '## Page 1',
  '',
  '### BLOCK #1 [TEXT]: blk_1111',
  '',
  '> **Created:** 2026-08-15 20:33:57 UTC',
  '> **Crop:** [Crop](https://vibe.cloud-ip.cc/api/crops/onn4HSsk7JQt)',
  '> **Stamp:** Code: СТ26/01-14-ДК2-РД',
  '',
  '##### АКТ',
  'освидетельствования скрытых работ',
  '',
  '### BLOCK #2 [IMAGE]: blk_2222',
  '',
  '> **Crop:** [Crop](https://vibe.cloud-ip.cc/api/crops/second)',
  '',
  'Схема раскладки',
  '',
  '## Page 3',
  '',
  '### BLOCK #3 [TEXT]: blk_3333',
  '',
  '> status: failed — провайдер недоступен',
  '',
].join('\n');

describe('разбор Markdown экспорта', () => {
  const parsed = parseExportMarkdown(MARKDOWN);

  it('раскладывает текст по страницам рабочего документа', () => {
    // `## Page 1` — это `page_index = 0`: их `_page_label` прибавляет единицу.
    expect(parsed.pages.map((page) => page.workingPageIndex)).toEqual([0, 2]);
    expect(parsed.pages[0]?.textMd).toContain('АКТ');
    expect(parsed.pages[0]?.textMd).toContain('Схема раскладки');
    expect(parsed.pages[1]?.textMd).toContain('status: failed');
  });

  it('шапка документа не попадает ни на одну страницу', () => {
    for (const page of parsed.pages) {
      expect(page.textMd).not.toContain('# Document:');
      expect(page.textMd).not.toContain('Path:');
    }
  });

  it('разбирает блоки с их идентификаторами, типом и порядком', () => {
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0]).toMatchObject({
      remoteBlockId: 'blk_1111',
      workingPageIndex: 0,
      ordinal: 1,
      blockType: 'text',
    });
    expect(parsed.blocks[1]).toMatchObject({ remoteBlockId: 'blk_2222', blockType: 'image' });
    expect(parsed.blocks[2]).toMatchObject({ remoteBlockId: 'blk_3333', workingPageIndex: 2 });
    expect(parsed.blocks[0]?.contentMd).toContain('АКТ');
    expect(parsed.blocks[0]?.contentMd).not.toContain('Схема раскладки');
  });

  /**
   * Главная проверка модуля. Строка `> **Crop:**` несёт БЕССРОЧНУЮ подписанную
   * ссылку на их сайт, а §11 относит такие URL к значениям, подлежащим
   * redaction. `text_md` живёт в БД без срока хранения и уезжает в ответы API.
   */
  it('не сохраняет подписанные ссылки на кропы ни в тексте страниц, ни в блоках', () => {
    expect(parsed.redactedLines).toBeGreaterThan(0);
    for (const page of parsed.pages) {
      expect(page.textMd).not.toContain('api/crops');
      expect(page.textMd).not.toContain('https://');
      expect(page.textMd).not.toContain('**Crop:**');
      expect(page.textMd).not.toContain('**Created:**');
    }
    for (const block of parsed.blocks) {
      expect(block.contentMd).not.toContain('api/crops');
    }
  });

  it('диагностика блока остаётся: это результат, а не провенанс', () => {
    expect(parsed.blocks[2]?.contentMd).toContain('status: failed');
  });

  it('любая уцелевшая абсолютная ссылка обезвреживается', () => {
    const withLink = [
      '## Page 1',
      '',
      'Подробности: [тут](https://example.test/secret?sig=abc)',
    ].join('\n');
    const result = parseExportMarkdown(withLink);
    expect(result.pages[0]?.textMd).not.toContain('https://example.test');
    expect(result.pages[0]?.textMd).toContain('ссылка удалена');
  });

  it('отказывает на недопустимом номере страницы', () => {
    expect(() => parseExportMarkdown('## Page 0\n')).toThrow(ExportFormatError);
  });
});

describe('записи архива', () => {
  it('называют недостающую запись и перечисляют полученные', () => {
    const entries = new Map([['document.md', Buffer.from('x')]]);
    expect(requireEntry(entries, 'document.md').toString()).toBe('x');
    expect(() => requireEntry(entries, 'qa_manifest.json')).toThrow(/qa_manifest\.json/);
    expect(() => requireEntry(entries, 'qa_manifest.json')).toThrow(/document\.md/);
  });
});
