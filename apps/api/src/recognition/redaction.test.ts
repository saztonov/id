/**
 * Обезвреживание подписанных ссылок RD WEB (§11, ADR-0005 п. 9).
 *
 * Каждое правило проверяется С ДВУХ сторон: ссылка исчезает И содержимое,
 * ради которого артефакт отдают, остаётся на месте. Односторонняя проверка
 * («теперь ссылки нет») прошла бы и на пустом ответе — это ровно тот класс
 * дефекта, который S5–S6 вносили ремонтами.
 */
import { describe, expect, it } from 'vitest';

import {
  redactAbsoluteUrls,
  redactArtifactContent,
  redactHtml,
  redactJson,
  redactMarkdown,
  REDACTED_URL,
} from './redaction.js';

/** Бессрочная подписанная ссылка «формата сайта» (`export_crop_short_url`). */
const CROP = 'https://rd.example.test/api/crops/abc123def456';

describe('общий рубеж: абсолютные ссылки', () => {
  it('вырезает ссылку и считает, сколько вырезано', () => {
    const result = redactAbsoluteUrls(`см. ${CROP} и ещё раз ${CROP}`);
    expect(result.count).toBe(2);
    expect(result.text).not.toContain('api/crops');
    expect(result.text).toContain(REDACTED_URL);
  });

  it('текст без ссылок не трогается вовсе', () => {
    const source = 'Акт освидетельствования скрытых работ № 336 от 12.01.2026';
    const result = redactAbsoluteUrls(source);
    expect(result.count).toBe(0);
    expect(result.text).toBe(source);
  });

  it('относительный путь ссылкой не считается: это не bearer-возможность', () => {
    const result = redactAbsoluteUrls('/api/v1/recognition-runs/1/pages');
    expect(result.count).toBe(0);
    expect(result.text).toBe('/api/v1/recognition-runs/1/pages');
  });
});

describe('markdown', () => {
  const source = [
    '# Document: комплект.pdf',
    '## Page 1',
    '### BLOCK #1 [TEXT]: blk_1',
    '> **Created:** 2026-01-12T10:00:00Z',
    `> **Crop:** [Crop](${CROP})`,
    '> status: succeeded',
    '',
    'АКТ ОСВИДЕТЕЛЬСТВОВАНИЯ СКРЫТЫХ РАБОТ',
  ].join('\n');

  it('вырезает строки провенанса вместе со ссылкой', () => {
    const result = redactMarkdown(source);
    expect(result.text).not.toContain('api/crops');
    expect(result.text).not.toContain('**Crop:**');
    expect(result.text).not.toContain('**Created:**');
    expect(result.count).toBe(2);
  });

  it('текст документа, заголовки и диагностику блока сохраняет', () => {
    const result = redactMarkdown(source);
    expect(result.text).toContain('АКТ ОСВИДЕТЕЛЬСТВОВАНИЯ СКРЫТЫХ РАБОТ');
    expect(result.text).toContain('## Page 1');
    expect(result.text).toContain('### BLOCK #1 [TEXT]: blk_1');
    // `> status:` — диагностика результата, а не провенанс: она остаётся.
    expect(result.text).toContain('> status: succeeded');
  });
});

describe('html', () => {
  const source =
    '<!doctype html><html><body>' +
    '<article class="block block-text" id="block-blk_1">' +
    '<div class="block-meta">' +
    '<div class="block-header">Block #1 (page 1) | Type: text | ID: blk_1</div>' +
    '<div class="meta-created"><b>Created:</b> 2026-01-12</div>' +
    `<div class="block-crop"><b>Crop:</b> <a href="${CROP}" target="_blank">Crop</a></div>` +
    '</div>' +
    '<div class="block-content"><p>АКТ ОСВИДЕТЕЛЬСТВОВАНИЯ</p></div>' +
    '</article></body></html>';

  it('ссылки на кроп в выдаче не остаётся', () => {
    const result = redactHtml(source);
    expect(result.text).not.toContain('api/crops');
    expect(result.text).not.toContain('href=');
    expect(result.count).toBeGreaterThan(0);
  });

  it('сам документ остаётся читаемым', () => {
    const result = redactHtml(source);
    expect(result.text).toContain('АКТ ОСВИДЕТЕЛЬСТВОВАНИЯ');
    expect(result.text).toContain('id="block-blk_1"');
    expect(result.text).toContain('Block #1 (page 1)');
  });

  it('ссылка вне бокса кропа тоже обезвреживается', () => {
    // Их разметка может измениться, и правило не имеет права держаться на
    // совпадении имени CSS-класса.
    const result = redactHtml(`<p>подробности: <a href="${CROP}">тут</a></p>`);
    expect(result.text).not.toContain('api/crops');
    expect(result.count).toBe(1);
  });
});

describe('qa-манифест', () => {
  const source = JSON.stringify(
    {
      job_id: 'job_1',
      expected_block_ids: ['blk_1'],
      checks: { markdown_contains_all_blocks: true, crop_urls: { blk_1: CROP } },
      final_status: 'passed',
    },
    null,
    2,
  );

  it('ссылка исчезает из любого поля, включая незаявленные схемой', () => {
    const result = redactJson(source);
    expect(result.text).not.toContain('api/crops');
    expect(result.count).toBe(1);
  });

  it('результат остаётся валидным JSON с теми же данными', () => {
    const parsed = JSON.parse(redactJson(source).text) as {
      job_id: string;
      expected_block_ids: string[];
      checks: { markdown_contains_all_blocks: boolean; crop_urls: Record<string, string> };
      final_status: string;
    };
    expect(parsed.job_id).toBe('job_1');
    expect(parsed.expected_block_ids).toEqual(['blk_1']);
    expect(parsed.checks.markdown_contains_all_blocks).toBe(true);
    expect(parsed.final_status).toBe('passed');
    expect(parsed.checks.crop_urls.blk_1).toBe(REDACTED_URL);
  });

  it('неразбираемый JSON не проходит мимо правила', () => {
    // Иначе достаточно было бы прислать битый манифест, чтобы ссылка вышла.
    const result = redactJson(`{"crop": "${CROP}"`);
    expect(result.text).not.toContain('api/crops');
    expect(result.count).toBe(1);
  });
});

describe('выбор правила по виду артефакта', () => {
  it('каждый производный вид проходит санацию', () => {
    const cases = [
      ['md', `> **Crop:** [Crop](${CROP})`],
      ['html', `<a href="${CROP}">Crop</a>`],
      ['qa', JSON.stringify({ crop: CROP })],
      ['blocks_json', JSON.stringify({ crop: CROP })],
    ] as const;
    for (const [kind, source] of cases) {
      const result = redactArtifactContent(kind, Buffer.from(source, 'utf8'));
      expect(result.bytes.toString('utf8')).not.toContain('api/crops');
      expect(result.count).toBeGreaterThan(0);
    }
  });
});
