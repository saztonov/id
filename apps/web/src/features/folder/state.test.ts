/**
 * Фраза о состоянии конвейера: таблица входов (S51).
 *
 * Проверяется то, из-за чего фраза и переехала в свой модуль: она обязана
 * называть ожидание, которое идёт СЕЙЧАС, и называть его правильно. На боевом
 * комплекте прежняя версия двадцать минут уверяла, что ждёт страницы, — потому
 * что счётчик отсрочек копится за всю жизнь ревизии и обнуляться не умеет.
 */
import { describe, expect, it } from 'vitest';

import { describeState, deferredStageOf, type StateInput } from './state.js';

const BASE: StateInput = {
  stage: 'analysis',
  activeStage: 'analysis',
  queued: 1,
  running: 1,
  deferredStage: null,
  dead: 0,
  busy: true,
  dryRun: false,
  progress: { pagesTotal: 220 },
};

/** Строка сводки: тесту важны только тип, стадия и текущее ожидание. */
function jobType(
  type: string,
  stage: string | null,
  deferredNow: number,
): { jobType: string; stage: string | null; deferred: number; deferredNow: number } {
  return { jobType: type, stage, deferred: 270, deferredNow };
}

describe('deferredStageOf', () => {
  it('пожизненные отсрочки без текущих не считаются ожиданием', () => {
    const status = { jobTypes: [jobType('vlm.finalize_run', 'recognition', 0)] };
    expect(deferredStageOf(status as never)).toBeNull();
  });

  it('называет стадию задачи, которая ждёт прямо сейчас', () => {
    const status = {
      jobTypes: [
        jobType('vlm.finalize_run', 'recognition', 0),
        jobType('doc.extract_finalize', 'analysis', 1),
      ],
    };
    expect(deferredStageOf(status as never)).toBe('analysis');
  });

  it('из нескольких ждущих стадий называет самую раннюю', () => {
    // Ранняя держит остальные: пока не дописаны страницы, разбору нечего ждать,
    // кроме них.
    const status = {
      jobTypes: [
        jobType('doc.extract_finalize', 'analysis', 1),
        jobType('vlm.finalize_run', 'recognition', 2),
      ],
    };
    expect(deferredStageOf(status as never)).toBe('recognition');
  });

  it('сводки нет — ждать некому', () => {
    expect(deferredStageOf(null)).toBeNull();
    expect(deferredStageOf(undefined)).toBeNull();
  });
});

describe('describeState', () => {
  it('ожидание страниц называется страницами', () => {
    expect(describeState({ ...BASE, deferredStage: 'recognition' })).toBe(
      'идёт: ждём, пока допишутся страницы',
    );
  });

  it('ожидание разбора называется документами, а не страницами', () => {
    // Тот самый боевой случай: страницы дописаны, идёт извлечение реквизитов.
    expect(describeState({ ...BASE, deferredStage: 'analysis' })).toBe(
      'идёт: ждём, пока дочитаются документы',
    );
  });

  it('без текущего ожидания называет стадию, а не страницы', () => {
    expect(describeState(BASE)).toBe('идёт: разбор документов и реквизитов');
  });

  it('мёртвая задача перебивает ожидание', () => {
    // Отказ уже произошёл: обещать, что портал чего-то ждёт, — врать дважды.
    expect(describeState({ ...BASE, deferredStage: 'recognition', dead: 1 })).toBe(
      'идёт: разбор документов и реквизитов',
    );
  });

  it('ожидание на стадии без своих слов не выдумывает их', () => {
    expect(describeState({ ...BASE, deferredStage: 'checks' })).toBe(
      'идёт: разбор документов и реквизитов',
    );
  });

  it('очередь без исполнителя не выдаётся за идущую работу', () => {
    expect(describeState({ ...BASE, running: 0, queued: 2 })).toBe(
      'в очереди: 2 задачи, ждём исполнителя',
    );
  });

  it('незанятый конвейер отвечает о последней стадии, а не об ожидании', () => {
    expect(
      describeState({ ...BASE, busy: false, deferredStage: 'recognition', stage: 'ready' }),
    ).toBe('готово');
  });
});
