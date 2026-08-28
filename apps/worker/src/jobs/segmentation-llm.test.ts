/**
 * Фаза 2 при отказе провайдера: след в `ai_runs` и ранний выход.
 *
 * ## Что было неверно
 *
 * 1. **Таймаут не оставлял строки `ai_runs`.** Вызов состоялся, время (а с ним
 *    и деньги) потрачено, а в аудите пусто: `writeAiRun` выходил, не найдя
 *    ответа. §11 при этом считает бюджет по сумме `ai_runs.cost`, то есть
 *    занижал траты, а расследование «почему страница осталась неопознанной»
 *    упиралось в тишину.
 * 2. **Исчерпанный бюджет не останавливал обход.** Цикл продолжал дёргать
 *    провайдера на каждой оставшейся странице — по разу на страницу, все
 *    восемьдесят три, — и каждый раз получал тот же отказ.
 *
 * Набор работает на подставных портах, а не на базе: предмет проверки —
 * поведение обработчика, а не запись строки, и БД здесь только замедлила бы
 * ответ на вопрос «сколько раз позвали провайдера».
 */
import { describe, expect, it } from 'vitest';

import {
  LlmBudgetError,
  LlmTimeoutError,
  type LlmAttempt,
  type PageClassification,
  type SegmentationInput,
} from '@id/api';

import {
  createClassifyPagesHandler,
  type LlmCallResult,
  type PublishedPrompt,
  type SegmentationDeps,
} from './segmentation.js';

const REVISION = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

const PROMPT: PublishedPrompt = {
  code: 'page_classify',
  version: 1,
  systemPrompt: 'Определи роль страницы по её тексту.',
  userTemplate: 'Текст: {{PAGE}}',
  modelOverride: null,
};

/** Страницы без единого якоря: все уходят в фазу 2. */
function pagesWithoutSignal(count: number): SegmentationInput {
  return {
    recognitionRunId: '00000000-0000-4000-8000-0000000000ff',
    pages: Array.from({ length: count }, (_, index) => ({
      sourcePageId: `page-${index}`,
      revisionOrdinal: index,
      sourceFileId: 'file-1',
      filePageIndex: index,
      pageTextVersionId: `ptv-${index}`,
      text: 'Сведения о поставке. Таблица 1. Позиция 1 — 12 шт.',
      blockTypes: ['text'],
      rotation: 0,
    })),
  } as unknown as SegmentationInput;
}

interface Recorded {
  readonly inputHash: string;
  readonly outputHash: string | null;
  readonly cost: number | null;
  readonly structuredResult: unknown;
}

function harness(behaviour: (index: number) => Promise<LlmCallResult>, pageCount = 5) {
  const calls: number[] = [];
  const runs: Recorded[] = [];
  let saved: readonly PageClassification[] = [];

  const deps: SegmentationDeps = {
    loadPages: () => Promise.resolve(pagesWithoutSignal(pageCount)),
    savePageClassifications: (input) => {
      saved = input.classifications;
      return Promise.resolve({ removed: 0, written: input.classifications.length });
    },
    listPageClassifications: () => Promise.resolve([]),
    // Месяц комплекта в этом наборе не выводится: набор про ступень модели.
    fillWorkPeriod: () => Promise.resolve(false),
    replaceAssumedContractor: () => Promise.resolve(false),
    rememberContractorRaw: () => Promise.resolve(false),
    listMatchableContractors: () => Promise.resolve([]),
    applySegmentation: () =>
      Promise.reject(new Error('задача 15 в этом наборе не участвует')) as never,
    listDocuments: () => Promise.resolve([]),
    listPageAssignments: () => Promise.resolve([]),
    listFieldValues: () => Promise.resolve([]),
    saveFieldValues: () => Promise.resolve({ removed: 0, written: 0 }),
    saveRegistryRows: () => Promise.resolve({ removed: 0, written: 0 }),
    listRegistryRows: () => Promise.resolve([]),
    saveRegistryMatches: () => Promise.resolve({ updated: 0, skipped: 0 }),
    saveDocumentRelations: () => Promise.resolve({ removed: 0, written: 0, skipped: 0 }),
    observeCandidate: () => Promise.resolve({ created: false, occurrences: 1 }),
    stagePrompt: () => Promise.resolve(PROMPT),
    callLlm: (input) => {
      calls.push(calls.length);
      void input;
      return behaviour(calls.length - 1);
    },
    recordAiRun: (input) => {
      runs.push({
        inputHash: input.inputHash,
        outputHash: input.outputHash,
        cost: input.cost,
        structuredResult: input.structuredResult,
      });
      return Promise.resolve();
    },
  };

  const emitted: { type: string; payload: Record<string, unknown> | undefined }[] = [];
  const enqueued: string[] = [];
  const ctx = {
    payload: { revisionId: REVISION },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    emit: (type: string, payload?: Record<string, unknown>) => {
      emitted.push({ type, payload });
      return Promise.resolve();
    },
    enqueue: (input: { type: string }) => {
      enqueued.push(input.type);
      return Promise.resolve({ jobId: 'job', created: true });
    },
  };

  return {
    deps,
    calls,
    runs,
    emitted,
    enqueued,
    saved: () => saved,
    run: () => createClassifyPagesHandler(deps)(ctx as never),
  };
}

function attempt(latencyMs: number): LlmAttempt {
  return { provider: 'recorded', model: 'recorded-model', inputHash: HASH, latencyMs };
}

describe('отказ провайдера в фазе 2', () => {
  it('таймаут оставляет строку ai_runs без ответа, а не тишину', async () => {
    const timeout = new LlmTimeoutError(30_000, 'модель не ответила за отведённое время');
    timeout.attempt = attempt(30_000);

    const test = harness(() => Promise.reject(timeout), 3);
    await test.run();

    // Вызов состоялся по каждой странице — таймаут относится к вызову, а не ко
    // всем последующим, и обход продолжается.
    expect(test.calls).toHaveLength(3);
    expect(test.runs).toHaveLength(3);
    for (const run of test.runs) {
      expect(run.inputHash).toBe(HASH);
      // Ответа не было — и это записано, а не выражено отсутствием строки:
      // «строки нет» неотличимо от «вызова не было».
      expect(run.outputHash).toBeNull();
      // Стоимость не выдумывается: ноль означал бы бесплатный вызов и занижал
      // бы сумму, по которой считается месячный бюджет (§11).
      expect(run.cost).toBeNull();
      expect(JSON.stringify(run.structuredResult)).toContain('LlmTimeoutError');
    }

    // Положительный путь: фаза 1 не потеряна, задача не упала, цепочка идёт
    // дальше. Отказ модели не имеет права останавливать конвейер (§0.5).
    expect(test.saved()).toHaveLength(3);
    expect(test.enqueued).toEqual(['doc.segment']);
  });

  it('исчерпанный бюджет прерывает обход после первой же страницы', async () => {
    const budget = new LlmBudgetError('Месячный бюджет LLM исчерпан.', {
      spent: 100,
      budget: 100,
    });
    budget.attempt = attempt(3);

    const test = harness(() => Promise.reject(budget), 8);
    await test.run();

    // Один вызов на восемь страниц, а не восемь одинаковых отказов.
    expect(test.calls).toHaveLength(1);
    expect(test.runs).toHaveLength(1);

    const counts = test.emitted.find((event) => event.type === 'documents.pages_classified')
      ?.payload?.['llm'] as Record<string, unknown> | undefined;
    // Прерывание названо и посчитано: «модель не вызывалась» и «модель
    // перестала вызываться на второй странице» — разные события.
    expect(counts?.['stoppedReason']).toContain('LlmBudgetError');
    expect(counts?.['called']).toBe(1);
    expect(counts?.['abandoned']).toBe(7);

    expect(test.saved()).toHaveLength(8);
    expect(test.enqueued).toEqual(['doc.segment']);
  });

  it('успешный ответ по-прежнему пишет полную строку и не прерывает обход', async () => {
    // Отрицательный контроль к обоим предыдущим: ремонт не превратил рабочий
    // путь в прерванный и не потерял стоимость.
    const answer: LlmCallResult = {
      text: JSON.stringify({
        label: 'B-DOC',
        doc_type: 'other',
        observed_title: 'ВЕДОМОСТЬ ПОСТАВКИ',
        confidence: 0.82,
        reason: 'самостоятельный документ',
        quote: 'Сведения о поставке',
      }),
      model: 'recorded-model',
      provider: 'recorded',
      inputHash: HASH,
      outputHash: 'b'.repeat(64),
      tokensIn: 900,
      tokensOut: 60,
      cost: 0.0012,
      latencyMs: 12,
      cacheHit: false,
    };

    const test = harness(() => Promise.resolve(answer), 4);
    await test.run();

    expect(test.calls).toHaveLength(4);
    expect(test.runs).toHaveLength(4);
    expect(test.runs.every((run) => run.outputHash !== null)).toBe(true);
    expect(test.runs.every((run) => run.cost === 0.0012)).toBe(true);
  });
});
