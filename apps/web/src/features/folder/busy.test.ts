/**
 * Занятость конвейера: труп прошлого шага не отменяет идущую работу (S54).
 *
 * Дефект боевой: `doc.match_registry` умерла на ограничении БД, сводная стадия
 * папки стала `failed` целиком, признак занятости ответил «не занят» — и с
 * экрана исчезла кнопка «Стоп» ровно в ту минуту, когда шло распознавание
 * 220 страниц. Остановить его стало нечем: ручка жива, кнопки нет.
 *
 * Вкладка «Проверка» страдала тем же признаком с другой стороны: она объявляла
 * проверку выполненной, пока портал ещё читал комплект.
 */
import { describe, expect, it } from 'vitest';

import type { ProcessingStatus, StageSummary } from '../../api/types.js';

import { activeStageOf, checksAhead, isBusy } from './busy.js';

function stage(name: StageSummary['stage'], pending: number): StageSummary {
  return {
    stage: name,
    attempts: 1,
    succeeded: 0,
    failed: 0,
    inFlight: 0,
    pending,
    totalDurationMs: 0,
    startedAt: null,
    finishedAt: null,
  };
}

function status(patch: Partial<ProcessingStatus>): ProcessingStatus {
  return {
    folderId: 'f',
    stage: 'recognition',
    queued: 0,
    running: 0,
    dead: 0,
    attempts: 0,
    totalDurationMs: 0,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
    stages: [],
    jobTypes: [],
    ...patch,
  } as ProcessingStatus;
}

describe('isBusy', () => {
  it('очередь стадии — это занятость', () => {
    expect(isBusy(status({ stage: 'recognition', queued: 16 }))).toBe(true);
  });

  it('мёртвая задача не отменяет идущее распознавание', () => {
    // Сводная стадия при `dead > 0` становится `failed` — но 16 страниц стоят
    // в очереди, и человеку есть что останавливать.
    expect(
      isBusy(
        status({
          stage: 'failed',
          dead: 1,
          queued: 12,
          running: 4,
          stages: [stage('recognition', 16), stage('analysis', 0)],
        }),
      ),
    ).toBe(true);
  });

  it('мёртвая задача без очереди — не занятость', () => {
    // Обратная сторона того же: конвейер, который встал и ничего не делает,
    // останавливать нечем и незачем.
    expect(
      isBusy(
        status({ stage: 'failed', dead: 1, queued: 0, running: 0, stages: [stage('analysis', 0)] }),
      ),
    ).toBe(false);
  });

  it('завершённая обработка — не занятость', () => {
    expect(isBusy(status({ stage: 'ready', queued: 0, running: 0 }))).toBe(false);
  });

  it('сводки нет — не занятость', () => {
    expect(isBusy(undefined)).toBe(false);
    expect(isBusy(null)).toBe(false);
  });
});

describe('checksAhead', () => {
  it('портал ещё читает, даже если один шаг уже умер', () => {
    const now = status({
      stage: 'failed',
      dead: 1,
      queued: 12,
      running: 4,
      stages: [stage('recognition', 16)],
    });
    expect(activeStageOf(now)).toBe('recognition');
    expect(checksAhead(now)).toBe(true);
  });
});
