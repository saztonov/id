/**
 * Табло качества сверки (S57).
 *
 * Проверяется главное свойство: две оси не смешиваются. Портал может
 * сопоставить больше строк и сопоставить их неправильно; может найти
 * расхождение и придумать его. Табло, у которого доля сопоставленных строк
 * заменяет точность, показывало бы рост ровно тогда, когда портал становится
 * смелее, — и это то самое самообольщение, ради ухода от которого оно и
 * строится.
 */
import { describe, expect, it } from 'vitest';

import { scoreRegistryMatching, type RegistryRowLabelView } from './registry-labels.js';

function label(
  registryRowId: string,
  matchVerdict: RegistryRowLabelView['matchVerdict'],
  checkLabels: RegistryRowLabelView['checkLabels'] = [],
): RegistryRowLabelView {
  return {
    registryRowId,
    matchVerdict,
    expectedDocumentId: null,
    checkLabels,
    labeledAt: '2026-09-08T00:00:00Z',
  };
}

const rows = [
  { id: 'row-1', matchState: 'matched', checks: [] },
  { id: 'row-2', matchState: 'matched', checks: [] },
  { id: 'row-3', matchState: 'undetermined', checks: [] },
  { id: 'row-4', matchState: 'missing', checks: [] },
];

describe('scoreRegistryMatching', () => {
  it('смелость и точность считаются РАЗНЫМИ числами', () => {
    // Портал назвал документ двум строкам, но одной — неверно. Табло обязано
    // показать и то и другое: «сопоставлено 2» и «верно 1» — разные ответы.
    const board = scoreRegistryMatching({
      folderId: 'folder-1',
      promptVersion: 3,
      rows,
      labels: [label('row-1', 'correct'), label('row-2', 'wrong_document')],
    });

    expect(board.match.claimed).toBe(2);
    expect(board.match.correct).toBe(1);
    expect(board.match.wrongDocument).toBe(1);
  });

  it('строки без метки в счёт не идут вовсе', () => {
    // Знаменатель — размеченное человеком, а не всё подряд: иначе табло
    // ухудшалось бы от каждой новой папки, которую никто не смотрел.
    const board = scoreRegistryMatching({
      folderId: 'folder-1',
      promptVersion: 3,
      rows,
      labels: [label('row-1', 'correct')],
    });

    expect(board.match.labeled).toBe(1);
    expect(board.match.undetermined).toBe(0);
  });

  it('«не сопоставлено» видно отдельно от «нет в комплекте»', () => {
    const board = scoreRegistryMatching({
      folderId: 'folder-1',
      promptVersion: 3,
      rows,
      labels: [label('row-3', 'not_in_folder'), label('row-4', 'not_in_folder')],
    });

    expect(board.match.undetermined).toBe(1);
    expect(board.match.notInFolder).toBe(2);
  });

  it('«проверяющий не уверен» не считается ни успехом, ни промахом', () => {
    const board = scoreRegistryMatching({
      folderId: 'folder-1',
      promptVersion: 3,
      rows,
      labels: [label('row-1', 'unclear')],
    });

    expect(board.match.unclear).toBe(1);
    expect(board.match.correct).toBe(0);
    expect(board.match.wrongDocument).toBe(0);
  });

  it('пропущенные расхождения считаются наравне с придуманными', () => {
    // Без `missed` табло тем оптимистичнее, чем меньше портал находит: молчание
    // выглядело бы безупречной работой.
    const board = scoreRegistryMatching({
      folderId: 'folder-1',
      promptVersion: 3,
      rows,
      labels: [
        label('row-1', 'correct', [
          { kind: 'org', verdict: 'confirmed' },
          { kind: 'org', verdict: 'false_alarm' },
          { kind: 'date', verdict: 'missed' },
        ]),
      ],
    });

    expect(board.checks).toMatchObject({ confirmed: 1, falseAlarm: 1, missed: 1 });
    expect(board.checks.byKind['org']).toEqual({ confirmed: 1, falseAlarm: 1, missed: 0 });
    expect(board.checks.byKind['date']).toEqual({ confirmed: 0, falseAlarm: 0, missed: 1 });
  });

  it('версия промта переносится в табло как есть', () => {
    // `null` означает «промт не опубликован»: такие прогоны сравнивать между
    // собой нельзя, и табло обязано это показывать, а не подставлять ноль.
    const board = scoreRegistryMatching({
      folderId: 'folder-1',
      promptVersion: null,
      rows,
      labels: [label('row-1', 'correct')],
    });

    expect(board.promptVersion).toBeNull();
  });
});
