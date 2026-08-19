/**
 * Контракт RecognitionResult v2: валидация, троичность, §11.
 * Все значения синтетические.
 */
import { describe, expect, it } from 'vitest';

import {
  RECOGNITION_RESULT_SCHEMA_VERSION,
  recognitionResultSchema,
  type RecognitionResult,
} from './schema.js';

function validResult(): RecognitionResult {
  return {
    schemaVersion: RECOGNITION_RESULT_SCHEMA_VERSION,
    source: {
      provider: 'synthetic',
      adapterVersion: 'test.v1',
      modelId: null,
      generatedAt: null,
    },
    pages: [
      {
        workingPageIndex: 0,
        rotation: 0,
        widthPx: 2480,
        heightPx: 3507,
        text: 'СЕРТИФИКАТ СООТВЕТСТВИЯ № СИН-1',
        blocks: [
          {
            blockId: 'blk_1',
            layoutBlockId: null,
            ordinal: 1,
            coordsNorm: [0.1, 0.1, 0.9, 0.9],
            confidence: null,
            modelId: null,
            blockType: 'text',
            text: 'СЕРТИФИКАТ СООТВЕТСТВИЯ № СИН-1',
            fragments: null,
            features: null,
          },
        ],
      },
    ],
    warnings: [],
  };
}

describe('recognitionResultSchema', () => {
  it('валидный результат проходит', () => {
    expect(recognitionResultSchema.parse(validResult())).toBeTruthy();
  });

  it('чужая версия схемы отклоняется', () => {
    const broken = { ...validResult(), schemaVersion: 'recognition.result.v1' };

    expect(recognitionResultSchema.safeParse(broken).success).toBe(false);
  });

  it('подписанная ссылка на кроп в любом строковом поле — отказ (§11)', () => {
    const poisoned = validResult();
    const page = poisoned.pages[0];
    if (page?.blocks[0]?.blockType === 'text') {
      (page.blocks[0] as { text: string }).text = 'см. кроп https://example.invalid/api/crops/1';
    }

    const outcome = recognitionResultSchema.safeParse(poisoned);
    expect(outcome.success).toBe(false);
  });

  it('обычный URL в тексте документа законен: сертификаты ссылаются на реестры', () => {
    const legal = validResult();
    const page = legal.pages[0];
    if (page?.blocks[0]?.blockType === 'text') {
      (page.blocks[0] as { text: string }).text =
        'Сертификаты размещены: https://example.invalid/documentation/certificates/';
    }

    expect(recognitionResultSchema.safeParse(legal).success).toBe(true);
  });

  it('страницы обязаны идти строго по возрастанию', () => {
    const result = validResult();
    const shuffled = {
      ...result,
      pages: [result.pages[0], result.pages[0]],
    };

    expect(recognitionResultSchema.safeParse(shuffled).success).toBe(false);
  });

  it('null и пустота различимы: fragments отсутствуют против пустых', () => {
    const parsed = recognitionResultSchema.parse(validResult());
    const block = parsed.pages[0]?.blocks[0];

    expect(block?.blockType).toBe('text');
    if (block?.blockType === 'text') {
      expect(block.fragments).toBeNull();
    }
  });
});
