/**
 * Рендер канонического текста страницы.
 *
 * Снапшот-набор фиксирует ПРАВИЛА v1 буквально: изменение рендера без смены
 * `PAGE_TEXT_RENDER_VERSION` обязано делать этот файл красным — от текста
 * зависят все офсеты и цитаты конвейера.
 */
import { describe, expect, it } from 'vitest';

import { PAGE_TEXT_RENDER_VERSION, renderPageText } from './render.js';
import type { RecognitionBlock, RecognitionPage } from './schema.js';

const base = {
  blockId: null,
  layoutBlockId: null,
  coordsNorm: null,
  confidence: null,
  modelId: null,
} as const;

function textBlock(ordinal: number | null, text: string): RecognitionBlock {
  return { ...base, ordinal, blockType: 'text', text, fragments: null, features: null };
}

function page(patch: Partial<RecognitionPage>): RecognitionPage {
  return {
    workingPageIndex: 0,
    rotation: 0,
    widthPx: null,
    heightPx: null,
    text: null,
    blocks: [],
    ...patch,
  };
}

describe('renderPageText v1', () => {
  it('версия правил зафиксирована', () => {
    expect(PAGE_TEXT_RENDER_VERSION).toBe('recognition.page_text.v1');
  });

  it('пре-отрендеренный текст возвращается дословно, байт-в-байт', () => {
    const verbatim = '##### АКТ\n\n\n\nосвидетельствования   скрытых работ  ';

    // Никакой нормализации: legacy-текст уже канонический, офсеты в нём.
    expect(renderPageText(page({ text: verbatim }))).toBe(verbatim);
  });

  it('блоки собираются по ordinal, штамп в текст не попадает', () => {
    const result = renderPageText(
      page({
        blocks: [
          textBlock(2, 'второй абзац'),
          {
            ...base,
            ordinal: null,
            blockType: 'stamp',
            stamp: {
              code: 'ИД-01',
              stage: null,
              sheet: null,
              object: null,
              name: null,
              organization: null,
              revisions: null,
              extra: {},
            },
          },
          textBlock(1, 'первый абзац'),
        ],
      }),
    );

    expect(result).toBe('первый абзац\n\nвторой абзац');
  });

  it('IMAGE-блок рендерится фиксированным шаблоном (снапшот правил v1)', () => {
    const result = renderPageText(
      page({
        blocks: [
          {
            ...base,
            ordinal: 1,
            blockType: 'image',
            image: {
              imageType: 'План',
              axes: '1/2, 2/2',
              zone: null,
              level: '-1 этаж',
              summary: 'Синтетическая схема.',
              description: 'Один лист с планом.',
              entities: [],
              verification: null,
            },
            features: null,
          },
        ],
      }),
    );

    expect(result).toBe(
      '**[IMAGE]** | Type: План | Axes: 1/2, 2/2 | Level: -1 этаж\n\n' +
        '**Summary:** Синтетическая схема.\n\n' +
        '**Description:** Один лист с планом.',
    );
  });

  it('детерминирован: два вызова дают идентичную строку', () => {
    const sample = page({ blocks: [textBlock(1, 'абзац')] });

    expect(renderPageText(sample)).toBe(renderPageText(sample));
  });
});
