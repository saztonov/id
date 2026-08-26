/**
 * Сборка RecognitionResult: строгая двусторонняя сверка (инвариант 5),
 * детерминированный порядок и финальная валидация канона (§11).
 */
import type { RecognitionBlock } from '@id/recognition';
import { describe, expect, it } from 'vitest';

import {
  RecognitionAssembleError,
  assembleRecognitionResult,
  type AssembleFrozenBlock,
  type AssemblePageInput,
} from './assemble.js';

const COORDS: readonly [number, number, number, number] = [0.1, 0.1, 0.9, 0.9];

function frozen(patch: Partial<AssembleFrozenBlock>): AssembleFrozenBlock {
  return {
    layoutBlockId: 'blk-a',
    workingPageIndex: 0,
    blockType: 'text',
    coordsNorm: COORDS,
    sortOrder: 1,
    ...patch,
  };
}

function page(workingPageIndex: number): AssemblePageInput {
  return { workingPageIndex, widthPx: 2480, heightPx: 3508, rotation: 0 };
}

function textResult(layoutBlockId: string, sortOrder: number, text = 'т'): RecognitionBlock {
  return {
    blockId: null,
    layoutBlockId,
    ordinal: sortOrder,
    coordsNorm: [...COORDS],
    confidence: null,
    modelId: 'actual/model',
    blockType: 'text',
    text,
    fragments: null,
    features: null,
  };
}

function stampResult(layoutBlockId: string, sortOrder: number): RecognitionBlock {
  return {
    blockId: null,
    layoutBlockId,
    ordinal: sortOrder,
    coordsNorm: [...COORDS],
    confidence: null,
    modelId: 'actual/model',
    blockType: 'stamp',
    stamp: {
      code: null,
      sheetCode: null,
      stage: null,
      sheet: null,
      object: null,
      name: null,
      organization: null,
      revisions: null,
      extra: {},
    },
  };
}

function expectAssembleError(run: () => unknown, fragment: string): void {
  try {
    run();
    expect.unreachable('ожидалась RecognitionAssembleError');
  } catch (error) {
    expect(error).toBeInstanceOf(RecognitionAssembleError);
    const assembleError = error as RecognitionAssembleError;
    expect(assembleError.discrepancies.join('\n')).toContain(fragment);
  }
}

describe('assembleRecognitionResult: успех', () => {
  it('собирает страницы по возрастанию, блоки по ordinal, text страниц = null', () => {
    const blocks = [
      frozen({ layoutBlockId: 'blk-b', workingPageIndex: 1, sortOrder: 2 }),
      frozen({ layoutBlockId: 'blk-a', workingPageIndex: 1, sortOrder: 1 }),
      frozen({ layoutBlockId: 'blk-c', workingPageIndex: 0, blockType: 'stamp', sortOrder: 1 }),
    ];
    const result = assembleRecognitionResult({
      modelId: 'actual/model',
      // Страницы нарочно перепутаны: сборка обязана отсортировать сама.
      pages: [page(1), page(0)],
      frozenBlocks: blocks,
      results: new Map([
        ['blk-a', textResult('blk-a', 1, 'первый')],
        ['blk-b', textResult('blk-b', 2, 'второй')],
        ['blk-c', stampResult('blk-c', 1)],
      ]),
    });

    expect(result.schemaVersion).toBe('recognition.result.v2');
    expect(result.source).toEqual({
      provider: 'openrouter_vlm',
      adapterVersion: 'openrouter-vlm.v3',
      modelId: 'actual/model',
      generatedAt: null,
    });
    expect(result.pages.map((p) => p.workingPageIndex)).toEqual([0, 1]);
    expect(result.pages.every((p) => p.text === null)).toBe(true);
    expect(result.pages[0]?.blocks.map((b) => b.layoutBlockId)).toEqual(['blk-c']);
    expect(result.pages[1]?.blocks.map((b) => b.layoutBlockId)).toEqual(['blk-a', 'blk-b']);
    expect(result.pages[0]?.widthPx).toBe(2480);
    expect(result.warnings).toEqual([]);
  });

  it('страница без блоков законна (пустой лист скана)', () => {
    const result = assembleRecognitionResult({
      modelId: null,
      pages: [page(0), page(1)],
      frozenBlocks: [frozen({ workingPageIndex: 1 })],
      results: new Map([['blk-a', textResult('blk-a', 1)]]),
    });

    expect(result.pages[0]?.blocks).toEqual([]);
    expect(result.source.modelId).toBeNull();
  });

  it('равные sortOrder упорядочиваются по layoutBlockId — детерминизм сохранён', () => {
    const result = assembleRecognitionResult({
      modelId: 'm',
      pages: [page(0)],
      frozenBlocks: [
        frozen({ layoutBlockId: 'blk-z', sortOrder: 1 }),
        frozen({ layoutBlockId: 'blk-b', sortOrder: 1 }),
      ],
      results: new Map([
        ['blk-z', textResult('blk-z', 1)],
        ['blk-b', textResult('blk-b', 1)],
      ]),
    });

    expect(result.pages[0]?.blocks.map((b) => b.layoutBlockId)).toEqual(['blk-b', 'blk-z']);
  });
});

describe('assembleRecognitionResult: двусторонняя сверка', () => {
  const base = {
    modelId: 'm',
    pages: [page(0)],
    frozenBlocks: [frozen({})],
    results: new Map([['blk-a', textResult('blk-a', 1)]]),
  };

  it('замороженный блок без результата', () => {
    expectAssembleError(
      () => assembleRecognitionResult({ ...base, results: new Map() }),
      'без результата распознавания',
    );
  });

  it('результат вне замороженного набора', () => {
    expectAssembleError(
      () =>
        assembleRecognitionResult({
          ...base,
          results: new Map([
            ['blk-a', textResult('blk-a', 1)],
            ['blk-ghost', textResult('blk-ghost', 9)],
          ]),
        }),
      'вне замороженного набора',
    );
  });

  it('дубль замороженного блока', () => {
    expectAssembleError(
      () => assembleRecognitionResult({ ...base, frozenBlocks: [frozen({}), frozen({})] }),
      'встречается дважды',
    );
  });

  it('дубль страницы', () => {
    expectAssembleError(
      () => assembleRecognitionResult({ ...base, pages: [page(0), page(0)] }),
      'задана дважды',
    );
  });

  it('блок ссылается на отсутствующую страницу', () => {
    expectAssembleError(
      () => assembleRecognitionResult({ ...base, frozenBlocks: [frozen({ workingPageIndex: 5 })] }),
      'отсутствующую страницу 5',
    );
  });

  it('координаты вне [0,1] или вырожденные по знаку', () => {
    expectAssembleError(
      () =>
        assembleRecognitionResult({
          ...base,
          frozenBlocks: [frozen({ coordsNorm: [0, 0, 1.5, 1] })],
        }),
      'coordsNorm',
    );
    expectAssembleError(
      () =>
        assembleRecognitionResult({
          ...base,
          frozenBlocks: [frozen({ coordsNorm: [0.9, 0.1, 0.2, 0.5] })],
        }),
      'coordsNorm',
    );
  });

  it('тип результата не совпадает с замороженным', () => {
    expectAssembleError(
      () =>
        assembleRecognitionResult({ ...base, results: new Map([['blk-a', stampResult('blk-a', 1)]]) }),
      'тип результата',
    );
  });

  it('ordinal результата не совпадает с sortOrder замороженного', () => {
    expectAssembleError(
      () =>
        assembleRecognitionResult({ ...base, results: new Map([['blk-a', textResult('blk-a', 7)]]) }),
      'ordinal результата',
    );
  });

  it('результат под ключом несёт чужой layoutBlockId', () => {
    expectAssembleError(
      () =>
        assembleRecognitionResult({
          ...base,
          results: new Map([['blk-a', { ...textResult('blk-a', 1), layoutBlockId: 'blk-x' }]]),
        }),
      'чужой layoutBlockId',
    );
  });

  it('перечень расхождений полный, а не первый попавшийся', () => {
    try {
      assembleRecognitionResult({
        modelId: 'm',
        pages: [page(0)],
        frozenBlocks: [
          frozen({ layoutBlockId: 'blk-1', coordsNorm: [0, 0, 2, 2] }),
          frozen({ layoutBlockId: 'blk-2', workingPageIndex: 9 }),
        ],
        results: new Map([['blk-ghost', textResult('blk-ghost', 1)]]),
      });
      expect.unreachable('ожидалась RecognitionAssembleError');
    } catch (error) {
      expect(error).toBeInstanceOf(RecognitionAssembleError);
      // 5 расхождений: координаты, чужая страница, два блока без результата, лишний результат.
      expect((error as RecognitionAssembleError).discrepancies).toHaveLength(5);
    }
  });
});

describe('assembleRecognitionResult: финальная валидация канона', () => {
  it('подписанная ссылка на кроп в результате — отказ схемы (§11)', () => {
    expect(() =>
      assembleRecognitionResult({
        modelId: 'm',
        pages: [page(0)],
        frozenBlocks: [frozen({})],
        results: new Map([
          ['blk-a', textResult('blk-a', 1, 'см. https://rd.example/api/crops/abc?sig=1')],
        ]),
      }),
    ).toThrowError(/api\/crops|§11|crop/iu);
  });
});
