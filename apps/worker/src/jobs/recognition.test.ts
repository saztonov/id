/**
 * Задачи 10–13 на портах-двойниках.
 *
 * Здесь проверяется то, что на настоящей базе воспроизводится только особым
 * стечением обстоятельств: цикл сверки, который так и не сошёлся; исчерпание
 * попыток; запуск OCR при ненастроенном профиле распознавания; повторный забор
 * экспорта, вернувший ДРУГИЕ байты. Содержательная часть — что текст, артефакты
 * и результаты действительно легли в базу и хранилище — живёт в
 * `recognition.integration.test.ts` на настоящей PostgreSQL и настоящем
 * фейк-сервере RD WEB.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  JobDeferredError,
  type JobContext,
  type RdWebPort,
  type ReconcileLayoutResult,
  type RemoteBlock,
} from '@id/api';

import {
  createFetchExportHandler,
  createReconcileHandler,
  createStartRecognitionHandler,
  remoteHashOf,
  type LocalBlock,
  type RecognitionDeps,
  type RunTarget,
} from './recognition.js';

const REVISION = '00000000-0000-4000-8000-000000000011';
const LAYOUT = '00000000-0000-4000-8000-000000000013';
const RUN = '00000000-0000-4000-8000-000000000014';

interface LogEntry {
  readonly level: string;
  readonly fields: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[]): unknown {
  const write =
    (level: string) =>
    (fields: unknown): void => {
      entries.push({ level, fields: (fields ?? {}) as Record<string, unknown> });
    };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} };
}

interface Enqueued {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface Sink {
  readonly enqueued: Enqueued[];
  readonly logs: LogEntry[];
}

function makeContext(
  sink: Sink,
  options: { readonly attempt?: number; readonly maxAttempts?: number } = {},
): JobContext<never> {
  return {
    jobId: '00000000-0000-4000-8000-0000000000ff',
    type: 'layout.reconcile',
    attempt: options.attempt ?? 1,
    maxAttempts: options.maxAttempts ?? 5,
    revisionId: REVISION,
    payload: { revisionId: REVISION, recognitionRunId: RUN },
    db: undefined,
    logger: recordingLogger(sink.logs),
    signal: new AbortController().signal,
    enqueue: (input: Enqueued) => {
      sink.enqueued.push(input);
      return Promise.resolve({ jobId: 'job', created: true });
    },
    emit: () => Promise.resolve(),
  } as unknown as JobContext<never>;
}

const LOCAL: readonly LocalBlock[] = [
  {
    id: 'L1',
    workingPageIndex: 0,
    blockType: 'text',
    shapeType: 'rectangle',
    x0: 0.1,
    y0: 0.1,
    x1: 0.9,
    y1: 0.4,
    sortOrder: 0,
    points: [],
  },
];

function remoteBlock(overrides: Partial<RemoteBlock> = {}): RemoteBlock {
  return {
    blockId: 'R1',
    pageIndex: 0,
    blockType: 'text',
    shapeType: 'rectangle',
    coordsNorm: [0.1, 0.1, 0.9, 0.4],
    polygonPoints: null,
    sortOrder: 0,
    source: 'auto',
    status: 'draft',
    version: 1,
    ...overrides,
  };
}

const MATCHING_HASH = remoteHashOf([remoteBlock()]);

function run(overrides: Partial<RunTarget> = {}): RunTarget {
  return {
    runId: RUN,
    revisionId: REVISION,
    layoutRevisionId: LAYOUT,
    status: 'running',
    rdDocumentId: 'doc_1',
    rdJobId: null,
    localLayoutHash: MATCHING_HASH,
    remoteLayoutHashBefore: null,
    runDocumentClosed: false,
    ...overrides,
  };
}

function fakePort(overrides: Partial<RdWebPort>): RdWebPort {
  const unexpected = (name: string) => (): never => {
    throw new Error(`метод порта ${name} вызван неожиданно`);
  };
  return {
    ensureNode: unexpected('ensureNode'),
    createRunDocument: unexpected('createRunDocument'),
    uploadWorkingPdf: unexpected('uploadWorkingPdf'),
    waitPages: unexpected('waitPages'),
    detectPages: unexpected('detectPages'),
    listBlocks: unexpected('listBlocks'),
    reconcileLayout: unexpected('reconcileLayout'),
    startRecognition: unexpected('startRecognition'),
    pollRecognition: unexpected('pollRecognition'),
    fetchExportOnce: unexpected('fetchExportOnce'),
    fetchBlockResults: unexpected('fetchBlockResults'),
    fetchPagePreview: unexpected('fetchPagePreview'),
    closeRunDocument: unexpected('closeRunDocument'),
    ...overrides,
  } as RdWebPort;
}

function deps(overrides: Partial<RecognitionDeps>): RecognitionDeps {
  const unexpected = (name: string) => (): never => {
    throw new Error(`порт ${name} вызван неожиданно`);
  };
  return {
    rdweb: null,
    selections: [{ blockType: 'text', providerType: 'lmstudio', modelId: 'model-1' }],
    documentMode: false,
    sha256: () => 'f'.repeat(64),
    loadRun: () => Promise.resolve(run()),
    loadFrozenBlocks: () => Promise.resolve(LOCAL),
    saveRemoteHashBefore: unexpected('saveRemoteHashBefore'),
    saveRdJobId: unexpected('saveRdJobId'),
    finishRun: unexpected('finishRun'),
    findArtifact: unexpected('findArtifact'),
    recordArtifact: unexpected('recordArtifact'),
    readArtifactBytes: unexpected('readArtifactBytes'),
    writeArtifactBytes: unexpected('writeArtifactBytes'),
    artifactId: unexpected('artifactId'),
    saveResults: unexpected('saveResults'),
    closeRunDocument: unexpected('closeRunDocument'),
    ...overrides,
  } as RecognitionDeps;
}

function reconcileResult(remote: readonly RemoteBlock[]): ReconcileLayoutResult {
  return { created: 0, updated: 0, deleted: 0, remote };
}

describe('задача 10: цикл сверки', () => {
  it('при совпадении хэшей записывает его и ставит запуск OCR', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const saved: string[] = [];
    const handler = createReconcileHandler(
      deps({
        rdweb: fakePort({
          reconcileLayout: vi.fn(() => Promise.resolve(reconcileResult([remoteBlock()]))),
        }),
        saveRemoteHashBefore: (_runId, hash) => {
          saved.push(hash);
          return Promise.resolve();
        },
      }),
    );

    await handler(makeContext(sink));
    expect(saved).toEqual([MATCHING_HASH]);
    expect(sink.enqueued.map((job) => job.type)).toEqual(['rd.start_recognition']);
  });

  /**
   * Не сошлось — значит НЕ записываем хэш и НЕ ставим запуск OCR. Это первый
   * рубеж не-деградируемого гейта «OCR не стартует при расхождении».
   */
  it('при расхождении не записывает хэш и не ставит запуск OCR', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const handler = createReconcileHandler(
      deps({
        rdweb: fakePort({
          // Удалённая сторона упорно отдаёт другой набор: сверка не сходится.
          reconcileLayout: vi.fn(() =>
            Promise.resolve(reconcileResult([remoteBlock({ coordsNorm: [0.1, 0.1, 0.8, 0.4] })])),
          ),
        }),
      }),
    );

    // Отсрочка, а не отказ RD WEB: их сервис ответил исправно, просто сверка
    // ещё не сошлась. Прежний `RdWebError` записывал каждый круг цикла исходом
    // `failed` и обвинял в этом чужой сервис.
    await expect(handler(makeContext(sink))).rejects.toBeInstanceOf(JobDeferredError);
    expect(sink.enqueued).toEqual([]);
  });

  /**
   * Исход выносит САМА задача, с точной причиной. Общий рубеж
   * `withRunTermination` следом за ней ничего не меняет — `finishRecognitionRun`
   * идемпотентен по `where status = 'running'`, и двойник это воспроизводит.
   * Проверяется именно это: первым записан точный диагноз, а не то, что вызовов
   * ровно один.
   */
  it('на последней попытке переводит прогон в integrity_error', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const finished: { status: string; reason: string | undefined; changed: boolean }[] = [];
    const handler = createReconcileHandler(
      deps({
        rdweb: fakePort({
          reconcileLayout: vi.fn(() => Promise.resolve(reconcileResult([]))),
        }),
        finishRun: (input) => {
          const changed = finished.length === 0;
          finished.push({ status: input.status, reason: input.reason, changed });
          return Promise.resolve({ changed });
        },
      }),
    );

    await expect(handler(makeContext(sink, { attempt: 5, maxAttempts: 5 }))).rejects.toThrow(
      /не сведён/,
    );
    expect(finished[0]).toMatchObject({ status: 'integrity_error', changed: true });
    expect(finished[0]?.reason).toMatch(/цикл сверки/);
    // Ни один последующий вызов не переоформляет уже вынесенный исход.
    expect(finished.filter((entry) => entry.changed)).toHaveLength(1);
    expect(finished.every((entry) => entry.status === 'integrity_error')).toBe(true);
    expect(sink.enqueued).toEqual([]);
  });
});

describe('задача 11: запуск OCR', () => {
  it('без настроенного профиля распознавания OCR не запускается', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const handler = createStartRecognitionHandler(
      deps({
        selections: [],
        rdweb: fakePort({}),
        loadRun: () => Promise.resolve(run({ remoteLayoutHashBefore: MATCHING_HASH })),
      }),
    );

    await expect(handler(makeContext(sink))).rejects.toThrow(/RDWEB_OCR_MODEL/);
    expect(sink.enqueued).toEqual([]);
  });

  /** Гейт: задача старта САМА перепроверяет хэш, а не доверяет соседней. */
  it('расхождение записанного хэша с локальным останавливает запуск', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const finished: unknown[] = [];
    const handler = createStartRecognitionHandler(
      deps({
        rdweb: fakePort({}),
        loadRun: () => Promise.resolve(run({ remoteLayoutHashBefore: 'b'.repeat(64) })),
        finishRun: (input) => {
          finished.push(input);
          return Promise.resolve({ changed: true });
        },
      }),
    );

    await expect(handler(makeContext(sink))).rejects.toThrow(/не совпал/);
    expect(finished[0]).toMatchObject({ status: 'integrity_error' });
    expect(sink.enqueued).toEqual([]);
  });

  it('повторный запуск по уже запущенному прогону не создаёт второй job', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const handler = createStartRecognitionHandler(
      deps({
        // `startRecognition` в двойнике не объявлен: его вызов провалит тест.
        rdweb: fakePort({}),
        loadRun: () =>
          Promise.resolve(run({ remoteLayoutHashBefore: MATCHING_HASH, rdJobId: 'job_remote' })),
      }),
    );

    await handler(makeContext(sink));
    expect(sink.enqueued.map((job) => job.type)).toEqual(['rd.poll_recognition']);
  });
});

describe('задача 13: однократный забор экспорта', () => {
  /**
   * Верификация artifact hash. Артефакт уже записан, а байты в хранилище
   * отвечают ДРУГОМУ хэшу — то есть содержимое подменено после записи.
   * Использовать такой архив нельзя, и «перезабрать» его тоже нельзя.
   */
  it('несовпадение хэша сохранённого архива останавливает прогон', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const finished: unknown[] = [];
    const handler = createFetchExportHandler(
      deps({
        rdweb: fakePort({
          listBlocks: vi.fn(() => Promise.resolve([remoteBlock()])),
        }),
        loadRun: () =>
          Promise.resolve(run({ remoteLayoutHashBefore: MATCHING_HASH, rdJobId: 'job_remote' })),
        findArtifact: () =>
          Promise.resolve({ kind: 'zip', artifactSha256: 'a'.repeat(64), byteSize: 10 }),
        readArtifactBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
        // sha256 двойника даёт 'ff…', а записан 'aa…'.
        finishRun: (input) => {
          finished.push(input);
          return Promise.resolve({ changed: true });
        },
      }),
    );

    await expect(handler(makeContext(sink))).rejects.toThrow(/не совпал/);
    expect(finished[0]).toMatchObject({ status: 'integrity_error' });
  });

  /**
   * Тот же гейт с другой стороны: строку артефакта успел записать параллельный
   * заход, и записан в ней ДРУГОЙ хэш. Значит два забора вернули разные байты,
   * и «какой из них описывает прогон» — неотвечаемый вопрос. Использовать
   * любой нельзя.
   */
  it('уже записанный артефакт с другим хэшем останавливает прогон', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const written: string[] = [];
    const handler = createFetchExportHandler(
      deps({
        rdweb: fakePort({
          listBlocks: vi.fn(() => Promise.resolve([remoteBlock()])),
          fetchExportOnce: vi.fn(() =>
            Promise.resolve({
              kind: 'zip' as const,
              bytes: new Uint8Array([1, 2, 3]),
              contentType: 'application/zip',
            }),
          ),
        }),
        loadRun: () =>
          Promise.resolve(run({ remoteLayoutHashBefore: MATCHING_HASH, rdJobId: 'job_remote' })),
        findArtifact: () => Promise.resolve(null),
        readArtifactBytes: () => Promise.resolve(null),
        writeArtifactBytes: (input) => {
          written.push(input.kind);
          return Promise.resolve();
        },
        recordArtifact: () =>
          Promise.resolve({ kind: 'already' as const, artifactSha256: 'a'.repeat(64) }),
      }),
    );

    await expect(handler(makeContext(sink))).rejects.toThrow(/другим хэшем/);
    expect(written).toEqual(['zip']);
  });

  /**
   * Второй рубеж однократности: строки артефакта нет, но байты в хранилище есть
   * (падение между выкладкой и записью). Второго обращения к RD WEB быть не
   * должно — `fetchExportOnce` в двойнике не объявлен и провалил бы тест.
   */
  it('байты от прошлой попытки берутся из хранилища, а не тянутся заново', async () => {
    const sink: Sink = { enqueued: [], logs: [] };
    const recorded: string[] = [];
    const handler = createFetchExportHandler(
      deps({
        rdweb: fakePort({
          listBlocks: vi.fn(() => Promise.resolve([remoteBlock()])),
        }),
        loadRun: () =>
          Promise.resolve(run({ remoteLayoutHashBefore: MATCHING_HASH, rdJobId: 'job_remote' })),
        findArtifact: () => Promise.resolve(null),
        readArtifactBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
        recordArtifact: (input) => {
          recorded.push(input.kind);
          return Promise.resolve({ kind: 'recorded', artifactSha256: input.artifactSha256 });
        },
      }),
    );

    // Дальше разбор архива упадёт (это не ZIP), но нам важно, что путь к
    // RD WEB за архивом не пошёл ВООБЩЕ: `fetchExportOnce` не вызывался.
    await expect(handler(makeContext(sink))).rejects.toThrow();
    expect(recorded).toEqual(['zip']);
  });
});
