/**
 * Выбор прогона распознавания (S29).
 *
 * Проверяется ровно то, что сломалось молча: список приходит отсортированным
 * по убыванию времени, и взятие последнего элемента давало САМЫЙ СТАРЫЙ прогон.
 * Ошибка не видна ни в типах, ни на экране — жёлтая плашка режима просто
 * описывала другой прогон, и выглядело это как включённая настройка.
 */
import { describe, expect, it } from 'vitest';
import type { RecognitionRun } from '../../api/types.js';
import { isDryRun, newestRecognitionRun, runningRecognitionRun } from './runs.js';

function run(over: Partial<RecognitionRun> & { id: string; startedAt: string }): RecognitionRun {
  return {
    folderId: '00000000-0000-4000-8000-000000000001',
    layoutRevisionId: '00000000-0000-4000-8000-000000000002',
    rdJobId: null,
    localLayoutHash: 'hash',
    remoteLayoutHashBefore: null,
    remoteLayoutHashAfter: null,
    workingPdfSha256: 'sha',
    settingsSnapshot: null,
    status: 'done',
    finishedAt: null,
    counts: {},
    warnings: [],
    runDocumentClosedAt: null,
    ...over,
  };
}

/** Список приходит с сервера отсортированным по убыванию `started_at`. */
const DESC: readonly RecognitionRun[] = [
  run({ id: 'new', startedAt: '2026-08-26T12:00:00.000Z', settingsSnapshot: { dryRun: false } }),
  run({ id: 'mid', startedAt: '2026-08-25T12:00:00.000Z' }),
  run({ id: 'old', startedAt: '2026-08-01T12:00:00.000Z', settingsSnapshot: { dryRun: true } }),
];

describe('newestRecognitionRun', () => {
  it('берёт новейший прогон DESC-списка, а не последний элемент', () => {
    expect(newestRecognitionRun(DESC)?.id).toBe('new');
  });

  it('не зависит от порядка списка', () => {
    expect(newestRecognitionRun([...DESC].reverse())?.id).toBe('new');
  });

  it('пустой список и отсутствие данных дают null', () => {
    expect(newestRecognitionRun([])).toBeNull();
    expect(newestRecognitionRun(undefined)).toBeNull();
  });

  it('режим читается по новейшему прогону: старый dry-run больше не виден', () => {
    expect(isDryRun(newestRecognitionRun(DESC)?.settingsSnapshot)).toBe(false);
    // Прежнее поведение — `at(-1)` — дало бы именно этот прогон.
    expect(isDryRun(DESC.at(-1)?.settingsSnapshot)).toBe(true);
  });
});

describe('runningRecognitionRun', () => {
  it('находит идущий прогон независимо от его места в списке', () => {
    const runs = [
      ...DESC,
      run({ id: 'live', startedAt: '2026-08-26T13:00:00.000Z', status: 'running' }),
    ];
    expect(runningRecognitionRun(runs)?.id).toBe('live');
  });

  it('без идущих прогонов отвечает null, а не последним завершённым', () => {
    expect(runningRecognitionRun(DESC)).toBeNull();
  });
});

describe('isDryRun', () => {
  it('снимок без поля и не-объект означают «не dry-run»', () => {
    expect(isDryRun(null)).toBe(false);
    expect(isDryRun(undefined)).toBe(false);
    expect(isDryRun({ version: 2 })).toBe(false);
    expect(isDryRun('dryRun')).toBe(false);
  });

  it('только строгое true считается режимом сравнения', () => {
    expect(isDryRun({ dryRun: true })).toBe(true);
    expect(isDryRun({ dryRun: 'true' })).toBe(false);
  });
});
