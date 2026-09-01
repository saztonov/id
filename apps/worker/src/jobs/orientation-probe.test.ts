/**
 * Зонд ориентации на двойниках (ADR-0020).
 *
 * Предмет проверки один и тот же во всех сценариях: **детекция ставится в любом
 * исходе**. Зонд — необязательный шаг качества, и одна недоступность шлюза не
 * имеет права оставить комплект неразмеченным. Всё остальное — как именно зонд
 * записывает своё мнение — проверяется вокруг этого утверждения.
 */
import { describe, expect, it, vi } from 'vitest';

import { LlmError, type JobContext } from '@id/api';

import {
  createOrientationProbeHandler,
  ORIENTATION_MIN_CONFIDENCE,
  PROBE_CALL_TIMEOUT_MS,
  type OrientationProbeCall,
  type OrientationProbeDeps,
} from './orientation-probe.js';

/**
 * Двойник контекста задачи.
 *
 * Свой, а не общий с `vlm-recognition.test.ts`: вынести его в общий модуль
 * значило бы завести инфраструктуру, к которой предъявляются требования, — а
 * здесь нужен журнал, который никто не читает, и очередь, в которую никто не
 * кладёт. Копия из десяти строк дешевле общего модуля с двумя потребителями.
 */
function silentLogger(): unknown {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function makeContext(
  payload: Record<string, unknown>,
  options: { readonly attempt: number; readonly maxAttempts: number },
): JobContext<'page.orientation_probe'> {
  return {
    jobId: '00000000-0000-4000-8000-0000000000ff',
    type: 'page.orientation_probe',
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    revisionId: (payload['revisionId'] as string) ?? null,
    payload,
    db: undefined,
    logger: silentLogger(),
    signal: new AbortController().signal,
    enqueue: () => Promise.resolve({ jobId: 'job-1', created: true }),
    emit: () => Promise.resolve(),
  } as unknown as JobContext<'page.orientation_probe'>;
}

const REVISION = '00000000-0000-4000-8000-000000000001';
const LAYOUT = '00000000-0000-4000-8000-000000000002';
const BUNDLE = '00000000-0000-4000-8000-000000000003';
const PAGE = '00000000-0000-4000-8000-000000000004';

const PAYLOAD = {
  revisionId: REVISION,
  layoutRevisionId: LAYOUT,
  bundleId: BUNDLE,
  sourcePageId: PAGE,
  workingPageIndex: 0,
};

function call(overrides: Partial<OrientationProbeCall> = {}): OrientationProbeCall {
  return {
    promptCode: 'recognition_page_orientation',
    promptVersion: 0,
    model: 'vendor/model-1',
    provider: 'proxy_llm',
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    answer: { rotation: 90, confidence: 0.9, evidence: 'шапка идёт снизу вверх' },
    tokensIn: 100,
    tokensOut: 8,
    cost: null,
    latencyMs: 120,
    ...overrides,
  };
}

interface Recorded {
  readonly saved: Record<string, unknown>[];
  readonly detections: Record<string, unknown>[];
  readonly aiRuns: Record<string, unknown>[];
  readonly feedback: Record<string, unknown>[];
}

function deps(overrides: Partial<OrientationProbeDeps> = {}): {
  readonly deps: OrientationProbeDeps;
  readonly recorded: Recorded;
} {
  const recorded: Recorded = { saved: [], detections: [], aiRuns: [], feedback: [] };
  const base: OrientationProbeDeps = {
    probeEnabled: async () => true,
    dryRun: async () => false,
    existingSource: async () => null,
    workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
    renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
    thumbnail: async () => new Uint8Array([1, 2, 3]),
    probe: async () => call(),
    saveOrientation: async (input) => {
      recorded.saved.push(input as unknown as Record<string, unknown>);
      return true;
    },
    recordAiRun: async (input) => {
      recorded.aiRuns.push(input as unknown as Record<string, unknown>);
    },
    enqueueDetection: async (input) => {
      recorded.detections.push(input as unknown as Record<string, unknown>);
    },
    reportFeedback: async (input) => {
      recorded.feedback.push(input as unknown as Record<string, unknown>);
    },
    isRetriable: (error) => error instanceof LlmError && error.retriable,
  };
  return { deps: { ...base, ...overrides }, recorded };
}

async function run(d: OrientationProbeDeps, attempt = 1, maxAttempts = 3): Promise<void> {
  const handler = createOrientationProbeHandler(d);
  await handler(makeContext(PAYLOAD, { attempt, maxAttempts }));
}

describe('createOrientationProbeHandler', () => {
  it('валидный ответ записывается, детекция ставится, вызов попадает в ai_runs', async () => {
    const { deps: d, recorded } = deps();
    await run(d);

    expect(recorded.saved).toHaveLength(1);
    expect(recorded.saved[0]).toMatchObject({ rotation: 90, effective: 90, error: null });
    expect(recorded.detections).toHaveLength(1);
    expect(recorded.detections[0]).toMatchObject({ layoutRevisionId: LAYOUT, workingPageIndex: 0 });
    expect(recorded.aiRuns).toHaveLength(1);
    // Стадия собственная: у строки зонда нет прогона распознавания, и под
    // `recognize` она врала бы срезу «цена прогона».
    expect(recorded.aiRuns[0]).toMatchObject({ stage: 'orientation' });
  });

  it('низкая уверенность записывает мнение, но лист остаётся прямым', async () => {
    const { deps: d, recorded } = deps({
      probe: async () =>
        call({
          answer: { rotation: 90, confidence: ORIENTATION_MIN_CONFIDENCE - 0.01, evidence: null },
        }),
    });
    await run(d);

    // Асимметрия цены: не повернуть повёрнутую — потерять то, что теряется и
    // сегодня; повернуть прямую — сломать страницу, которая работала.
    expect(recorded.saved[0]).toMatchObject({ rotation: 90, effective: 0 });
    expect(recorded.feedback[0]).toMatchObject({ reasonCode: 'orientation.low_confidence' });
    expect(recorded.detections).toHaveLength(1);
  });

  it('отказ на последней попытке не роняет задачу и НЕ отменяет детекцию', async () => {
    const { deps: d, recorded } = deps({
      probe: async () => {
        throw new LlmError('шлюз недоступен', { retriable: true });
      },
    });
    await run(d, 3, 3);

    expect(recorded.saved[0]).toMatchObject({ effective: 0, rotation: null });
    expect(recorded.saved[0]?.['error']).toContain('шлюз недоступен');
    expect(recorded.feedback[0]).toMatchObject({ reasonCode: 'orientation.probe_failed' });
    // Главное утверждение файла.
    expect(recorded.detections).toHaveLength(1);
  });

  it('повторяемый отказ НЕ на последней попытке пробрасывается: движок повторит', async () => {
    const { deps: d, recorded } = deps({
      probe: async () => {
        throw new LlmError('429', { retriable: true });
      },
    });

    await expect(run(d, 1, 3)).rejects.toThrow('429');
    // Ни записи, ни детекции: задача будет переиграна целиком.
    expect(recorded.saved).toHaveLength(0);
    expect(recorded.detections).toHaveLength(0);
  });

  it('неповторяемый отказ не пробрасывается даже на первой попытке', async () => {
    const { deps: d, recorded } = deps({
      probe: async () => {
        throw new LlmError('ответ не по схеме', { retriable: false });
      },
    });
    await run(d, 1, 3);

    expect(recorded.saved).toHaveLength(1);
    expect(recorded.detections).toHaveLength(1);
  });

  it('выключенный зонд не зовёт модель, но детекцию ставит', async () => {
    const probe = vi.fn();
    const { deps: d, recorded } = deps({
      probeEnabled: async () => false,
      probe: probe as unknown as OrientationProbeDeps['probe'],
    });
    await run(d);

    expect(probe).not.toHaveBeenCalled();
    expect(recorded.saved).toHaveLength(0);
    expect(recorded.detections).toHaveLength(1);
  });

  it('ручной разворот уже задан — зонд не вызывается вовсе', async () => {
    const probe = vi.fn();
    const { deps: d, recorded } = deps({
      existingSource: async () => ({ source: 'user' as const, answered: true }),
      probe: probe as unknown as OrientationProbeDeps['probe'],
    });
    await run(d);

    // Платить за вызов, результат которого ON CONFLICT всё равно не запишет,
    // незачем: ручное значение сильнее зонда по построению.
    expect(probe).not.toHaveBeenCalled();
    expect(recorded.detections).toHaveLength(1);
  });

  it('вызов зонда получает свой потолок ожидания, а не общий для распознавания', async () => {
    // Аренда задачи зонда — 120 секунд, и она же потолок попытки. Общий
    // LLM_TIMEOUT_MS в проде 450 секунд: без своего потолка медленный вызов
    // гарантированно оканчивался JobTimeout, три попытки убивали зонд, а
    // мёртвый зонд не ставит детекцию своей страницы.
    const seen: (number | undefined)[] = [];
    const { deps: d } = deps({
      probe: (async (input: { readonly timeoutMs?: number }) => {
        seen.push(input.timeoutMs);
        return call();
      }) as unknown as OrientationProbeDeps['probe'],
    });
    await run(d);

    expect(seen[0]).toBe(PROBE_CALL_TIMEOUT_MS);
    expect(PROBE_CALL_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it('уже полученное мнение зонда не перезапрашивается', async () => {
    // Разворот — свойство скана: страница, снятая боком, останется такой при
    // любом повторном запуске разметки. До S41 повтор комплекта на 220 страниц
    // заново платил за 220 одинаковых вызовов, и пользователь эти минуты видел
    // как «разметка стоит на нуле».
    const probe = vi.fn();
    const { deps: d, recorded } = deps({
      existingSource: async () => ({ source: 'probe' as const, answered: true }),
      probe: probe as unknown as OrientationProbeDeps['probe'],
    });
    await run(d);

    expect(probe).not.toHaveBeenCalled();
    expect(recorded.saved).toHaveLength(0);
    // Детекция ставится всё равно: она и есть смысл этой задачи в конвейере.
    expect(recorded.detections).toHaveLength(1);
  });

  it('записанный отказ зонда перезапрашивается: мнения там нет', async () => {
    // Строка от зонда бывает и записью об отказе. Считать её ответом значило бы
    // навсегда оставить страницу без мнения о развороте — спросить заново
    // единственный способ его получить.
    const { deps: d, recorded } = deps({
      existingSource: async () => ({ source: 'probe' as const, answered: false }),
    });
    await run(d);
    expect(recorded.saved).toHaveLength(1);
  });

  it('dry-run пишет строку с причиной и не зовёт модель', async () => {
    const probe = vi.fn();
    const { deps: d, recorded } = deps({
      dryRun: async () => true,
      probe: probe as unknown as OrientationProbeDeps['probe'],
    });
    await run(d);

    expect(probe).not.toHaveBeenCalled();
    expect(recorded.saved[0]).toMatchObject({ error: 'ai.dry_run_only', effective: 0 });
    expect(recorded.detections).toHaveLength(1);
  });

  it('вырожденная миниатюра — не исключение, а честный отказ зонда', async () => {
    const { deps: d, recorded } = deps({ thumbnail: async () => null });
    await run(d);

    expect(recorded.saved[0]?.['error']).toContain('вырожден');
    expect(recorded.detections).toHaveLength(1);
  });
});
