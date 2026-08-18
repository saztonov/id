/**
 * Сопоставление локальных и удалённых блоков (§5.2, шаги 7–8).
 *
 * Сопоставление опирается на уже проверенное равенство хэшей, поэтому здесь
 * проверяется ровно то, что из этого равенства следует: пары находятся без
 * идентификаторов, разрыв нумерации `sort_order` их не ломает, а расхождение
 * геометрии обязано остаться ВИДИМЫМ, а не «сопоставиться поближе».
 */
import { describe, expect, it } from 'vitest';

import { matchBlocks, type MatchableBlock } from './match.js';

function block(overrides: Partial<MatchableBlock> = {}): MatchableBlock {
  return {
    workingPageIndex: 0,
    blockType: 'text',
    shapeType: 'rectangle',
    x0: 0.1,
    y0: 0.1,
    x1: 0.9,
    y1: 0.4,
    sortOrder: 0,
    points: [],
    ...overrides,
  };
}

describe('сопоставление блоков разметки', () => {
  it('находит пары по геометрии, а не по идентификатору', () => {
    const local = [
      { ...block(), id: 'L1' },
      { ...block({ y0: 0.5, y1: 0.8, sortOrder: 1 }), id: 'L2' },
    ];
    const remote = [
      // Порядок выдачи их API не гарантирован, и нумерация у них своя.
      { ...block({ y0: 0.5, y1: 0.8, sortOrder: 7 }), blockId: 'R2' },
      { ...block({ sortOrder: 3 }), blockId: 'R1' },
    ];

    const result = matchBlocks(local, remote);
    expect(result.unmatchedLocal).toEqual([]);
    expect(result.unmatchedRemote).toEqual([]);
    expect(
      Object.fromEntries(result.matched.map((pair) => [pair.local.id, pair.remote.blockId])),
    ).toEqual({ L1: 'R1', L2: 'R2' });
  });

  it('различает одинаковые по геометрии блоки позицией в группе', () => {
    const twin = block({ x0: 0.2, x1: 0.4, y0: 0.2, y1: 0.3 });
    const local = [
      { ...twin, sortOrder: 0, id: 'L1' },
      { ...twin, sortOrder: 1, id: 'L2' },
    ];
    const remote = [
      { ...twin, sortOrder: 0, blockId: 'R1' },
      { ...twin, sortOrder: 4, blockId: 'R2' },
    ];

    const result = matchBlocks(local, remote);
    expect(result.matched).toHaveLength(2);
    expect(result.unmatchedLocal).toEqual([]);
    expect(
      Object.fromEntries(result.matched.map((pair) => [pair.local.id, pair.remote.blockId])),
    ).toEqual({ L1: 'R1', L2: 'R2' });
  });

  it('несовпавший блок остаётся ВИДИМЫМ, а не подбирается к ближайшему', () => {
    const local = [{ ...block(), id: 'L1' }];
    const remote = [{ ...block({ x1: 0.89 }), blockId: 'R1' }];

    const result = matchBlocks(local, remote);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedLocal.map((row) => row.id)).toEqual(['L1']);
    expect(result.unmatchedRemote.map((row) => row.blockId)).toEqual(['R1']);
  });

  it('группы «страница × тип» не перемешиваются', () => {
    const local = [
      { ...block(), id: 'L1' },
      { ...block({ blockType: 'image' }), id: 'L2' },
      { ...block({ workingPageIndex: 1 }), id: 'L3' },
    ];
    const remote = [
      { ...block({ workingPageIndex: 1 }), blockId: 'R3' },
      { ...block({ blockType: 'image' }), blockId: 'R2' },
      { ...block(), blockId: 'R1' },
    ];

    const result = matchBlocks(local, remote);
    expect(
      Object.fromEntries(result.matched.map((pair) => [pair.local.id, pair.remote.blockId])),
    ).toEqual({ L1: 'R1', L2: 'R2', L3: 'R3' });
  });
});
