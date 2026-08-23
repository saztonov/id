/**
 * Сравнение версий при конфликте (§7.2, гейт §17: «конфликт версий показывает
 * сравнение»).
 *
 * Проверяется не то, что функция возвращает объект, а то, что она РАЗЛИЧАЕТ
 * четыре исхода, каждый из которых требует от пользователя разного решения:
 * блок появился у другого, блок исчез у другого, блок изменён, и — отдельно —
 * расхождений по этой странице нет вовсе.
 */
import { describe, expect, it } from 'vitest';
import { diffLayouts, summarizeDiff } from './conflict.js';
import type { LayoutBlock } from '../../api/types.js';

function block(overrides: Partial<LayoutBlock> & { id: string }): LayoutBlock {
  return {
    layoutRevisionId: 'layout-1',
    sourcePageId: 'page-1',
    workingPageIndex: 0,
    blockType: 'text',
    shapeType: 'rectangle',
    coords: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.4 },
    points: [],
    sortOrder: 0,
    source: 'auto',
    detectorProvenance: 'rf_detr',
    detectionScore: null,
    ...overrides,
  };
}

describe('diffLayouts', () => {
  it('называет блок, появившийся на сервере', () => {
    const diff = diffLayouts([block({ id: 'a' })], [block({ id: 'a' }), block({ id: 'b' })]);
    expect(diff.added.map((item) => item.id)).toEqual(['b']);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.identical).toBe(false);
  });

  it('называет блок, удалённый на сервере', () => {
    const diff = diffLayouts([block({ id: 'a' }), block({ id: 'b' })], [block({ id: 'a' })]);
    expect(diff.removed.map((item) => item.id)).toEqual(['b']);
    expect(diff.added).toHaveLength(0);
  });

  it('перечисляет изменённые поля, а не только факт изменения', () => {
    const diff = diffLayouts(
      [block({ id: 'a' })],
      [
        block({
          id: 'a',
          blockType: 'stamp',
          coords: { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 },
          sortOrder: 3,
        }),
      ],
    );
    expect(diff.changed).toHaveLength(1);
    const fields = diff.changed[0]?.changes.map((change) => change.field) ?? [];
    expect(fields).toEqual(['blockType', 'coords', 'sortOrder']);
    // Значения обеих сторон обязаны быть в расхождении: без них «изменено» не
    // помогает выбрать, чью версию оставить.
    expect(diff.changed[0]?.changes[0]).toMatchObject({ mine: 'text', theirs: 'stamp' });
  });

  it('округление double precision не объявляется изменением', () => {
    const mine = block({ id: 'a', coords: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.4 } });
    const theirs = block({
      id: 'a',
      coords: { x0: 0.1 + 1e-12, y0: 0.1, x1: 0.9 - 1e-12, y1: 0.4 },
    });
    expect(diffLayouts([mine], [theirs]).identical).toBe(true);
  });

  it('настоящий сдвиг рамки изменением объявляется', () => {
    const mine = block({ id: 'a', coords: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.4 } });
    const theirs = block({ id: 'a', coords: { x0: 0.1001, y0: 0.1, x1: 0.9, y1: 0.4 } });
    expect(diffLayouts([mine], [theirs]).identical).toBe(false);
  });

  it('совпадающие наборы дают отдельный исход, а не пустую таблицу', () => {
    const diff = diffLayouts([block({ id: 'a' })], [block({ id: 'a' })]);
    expect(diff.identical).toBe(true);
    expect(summarizeDiff(diff)).toContain('правка другой страницы');
  });

  it('сводка называет направление расхождения', () => {
    const diff = diffLayouts([block({ id: 'a' })], [block({ id: 'b' })]);
    const summary = summarizeDiff(diff);
    expect(summary).toContain('добавлено на сервере: 1');
    expect(summary).toContain('удалено на сервере: 1');
  });
});
