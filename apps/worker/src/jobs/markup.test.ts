/**
 * Задачи 4, 5 и 7 конвейера разметки на портах-двойниках.
 *
 * Здесь проверяется то, за что отвечает сам обработчик и что на настоящей базе
 * воспроизводится только сбоем в нужную секунду: ПОРЯДОК записи строки
 * `rd_run_documents` относительно выкладки 86 МБ, поведение повтора после
 * падения между `init` и `complete`, и правило «импорт не удаляет то, чему нет
 * замены». Содержательная часть — что блоки действительно легли в базу —
 * живёт в `markup.integration.test.ts` на настоящей PostgreSQL и настоящем
 * фейк-сервере RD WEB.
 *
 * Каждый тест этого файла падал бы до ремонта S6; какой именно дефект он ловит,
 * написано над ним.
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  FALLBACK_LAYOUT_THRESHOLDS,
  RdWebError,
  type JobContext,
  type RdWebPort,
  type RemoteBlock,
} from '@id/api';

import {
  createDetectPagesHandler,
  createRunDocumentHandler,
  createUploadWorkingPdfHandler,
  type MarkupDeps,
  type MarkupTarget,
  type RunDocumentRef,
} from './markup.js';

const REVISION = '00000000-0000-4000-8000-000000000011';
const BUNDLE = '00000000-0000-4000-8000-000000000012';
const LAYOUT = '00000000-0000-4000-8000-000000000013';

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[]): unknown {
  const write =
    (level: LogEntry['level']) =>
    (fields: unknown): void => {
      entries.push({ level, fields: (fields ?? {}) as Record<string, unknown> });
    };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} };
}

interface Enqueued {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey?: string | undefined;
}

function makeContext<T extends Record<string, unknown>>(
  payload: T,
  sink: { readonly enqueued: Enqueued[]; readonly logs: LogEntry[] },
): JobContext<never> {
  return {
    jobId: '00000000-0000-4000-8000-0000000000ff',
    type: 'rd.create_run_document',
    attempt: 1,
    maxAttempts: 5,
    revisionId: REVISION,
    payload,
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

function target(overrides: Partial<MarkupTarget> = {}): MarkupTarget {
  return {
    layoutRevisionId: LAYOUT,
    revisionId: REVISION,
    bundleId: BUNDLE,
    objectId: '00000000-0000-4000-8000-000000000004',
    state: 'draft',
    detectorProfile: 'rf_detr',
    workingPdfSha256: 'a'.repeat(64),
    workingPdfKey: 'blobs/aa/aa/working.pdf',
    workingPdfSizeBytes: 1024,
    pageIndices: [0, 1, 2],
    thresholds: FALLBACK_LAYOUT_THRESHOLDS,
    layoutProfileVersion: 1,
    ...overrides,
  };
}

/** Порт RD WEB, у которого невызванный метод — это провал теста, а не `undefined`. */
function fakePort(overrides: Partial<RdWebPort>): RdWebPort {
  const unexpected = (name: string) => (): never => {
    throw new Error(`метод порта ${name} вызван неожиданно`);
  };
  return {
    ensureNode: vi.fn(() => Promise.resolve({ nodeId: 'node-1' })),
    createRunDocument: unexpected('createRunDocument'),
    uploadWorkingPdf: unexpected('uploadWorkingPdf'),
    waitPages: unexpected('waitPages'),
    detectPages: unexpected('detectPages'),
    listBlocks: unexpected('listBlocks'),
    reconcileLayout: unexpected('reconcileLayout'),
    startRecognition: unexpected('startRecognition'),
    pollRecognition: unexpected('pollRecognition'),
    fetchExportOnce: unexpected('fetchExportOnce'),
    fetchPagePreview: unexpected('fetchPagePreview'),
    closeRunDocument: unexpected('closeRunDocument'),
    ...overrides,
  } as RdWebPort;
}

function baseDeps(port: RdWebPort, overrides: Partial<MarkupDeps> = {}): MarkupDeps {
  return {
    rdweb: port,
    rdProjectId: 'prj-portal',
    previewCached: false,
    loadTargetByLayout: () => Promise.resolve(target()),
    findRunDocument: () => Promise.resolve(null),
    saveRunDocument: () => Promise.resolve(),
    replaceRunDocument: () => Promise.resolve(),
    openWorkingPdf: () =>
      Promise.resolve({
        stream: () => Readable.from([Buffer.from('%PDF-1.6')]),
        sizeBytes: 1024,
      }),
    importBlocks: () => Promise.resolve({ imported: 0, skippedPages: [] }),
    loadPageBlocks: () => Promise.resolve([]),
    saveFlags: () => Promise.resolve({ written: true }),
    storePreview: () => Promise.resolve(),
    ...overrides,
  };
}

function remoteBlock(pageIndex: number, y0: number): RemoteBlock {
  return {
    blockId: `blk-${pageIndex}-${y0}`,
    pageIndex,
    blockType: 'text',
    shapeType: 'rectangle',
    coordsNorm: [0.08, y0, 0.92, y0 + 0.2],
    polygonPoints: null,
    sortOrder: null,
    source: 'auto',
    status: 'new',
    version: 1,
  };
}

const markupPayload = { revisionId: REVISION, bundleId: BUNDLE, layoutRevisionId: LAYOUT };

// =====================================================================
// Задача 4: создание RD-документа
// =====================================================================

describe('rd.create_run_document', () => {
  /**
   * BLOCKING-2. Строка пишется до выкладки байтов, поэтому падение на выкладке
   * оставляет след, а повтор находит документ и не заводит второй.
   */
  it('строка RD-документа записана до выкладки байтов', async () => {
    const saved: string[] = [];
    const port = fakePort({
      createRunDocument: vi.fn(() =>
        Promise.resolve({
          documentId: 'doc-1',
          uploadUrl: 'https://rd.test/put/1',
          uploadHeaders: {},
          maxSizeBytes: 1_000_000,
        }),
      ),
      uploadWorkingPdf: vi.fn(() =>
        Promise.reject(new RdWebError('связь оборвалась', { operation: 'upload_put' })),
      ),
    });
    const deps = baseDeps(port, {
      saveRunDocument: (input) => {
        saved.push(input.rdDocumentId);
        return Promise.resolve();
      },
    });
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await expect(createRunDocumentHandler(deps)(makeContext(markupPayload, sink))).rejects.toThrow(
      RdWebError,
    );

    // Именно это и есть починка: до неё строка писалась последней, падение на
    // выкладке не оставляло следа, и каждая из пяти попыток заводила новый
    // документ и везла 86 МБ заново.
    expect(saved).toEqual(['doc-1']);
  });

  /** Повтор после сбоя выкладки: документ найден, второй `init` не выполняется. */
  it('повтор не создаёт второй документ, а идёт проверять приём байтов', async () => {
    const create = vi.fn();
    const port = fakePort({ createRunDocument: create as never });
    const deps = baseDeps(port, {
      findRunDocument: () =>
        Promise.resolve<RunDocumentRef>({
          rdDocumentId: 'doc-1',
          rdProjectId: 'prj-portal',
          closed: false,
        }),
    });
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createRunDocumentHandler(deps)(makeContext(markupPayload, sink));

    expect(create).not.toHaveBeenCalled();
    expect(sink.enqueued.map((job) => job.type)).toEqual(['rd.upload_working_pdf']);
    expect(sink.enqueued[0]?.payload).toMatchObject({ layoutRevisionId: LAYOUT });
  });

  /**
   * IMPORTANT-3. Цель адресуется ревизией разметки из payload, а совпадение
   * рабочего документа проверяется: задача ревизии №1, выполненная после её
   * заморозки, не имеет права отработать по №2.
   */
  it('payload с чужим рабочим документом отвергается', async () => {
    const deps = baseDeps(fakePort({}));
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await expect(
      createRunDocumentHandler(deps)(
        makeContext({ ...markupPayload, bundleId: '00000000-0000-4000-8000-0000000000aa' }, sink),
      ),
    ).rejects.toThrow(/рабочему документу/u);
  });
});

// =====================================================================
// Задача 5: подтверждение приёма байтов
// =====================================================================

describe('rd.upload_working_pdf', () => {
  /** Положительный путь: байты приняты — ничего не пересоздаётся. */
  it('принятый документ идёт дальше без замены', async () => {
    const port = fakePort({
      waitPages: vi.fn(() =>
        Promise.resolve({
          ready: false,
          document: {
            documentId: 'doc-1',
            projectId: 'prj-portal',
            status: 'rendering',
            pageCount: null,
            pages: [],
          },
        }),
      ),
    });
    const replace = vi.fn(() => Promise.resolve());
    const deps = baseDeps(port, {
      findRunDocument: () =>
        Promise.resolve({ rdDocumentId: 'doc-1', rdProjectId: 'prj-portal', closed: false }),
      replaceRunDocument: replace,
    });
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createUploadWorkingPdfHandler(deps)(makeContext(markupPayload, sink));

    expect(replace).not.toHaveBeenCalled();
    expect(sink.enqueued.map((job) => job.type)).toEqual(['rd.wait_pages']);
  });

  /**
   * BLOCKING-2, вторая половина. Документ заведён, байтов нет (задача 4 упала
   * между `init` и `complete`). Талон повторно не выдаётся, поэтому заводится
   * новый документ — а брошенный НАЗЫВАЕТСЯ в журнале и строка ОБНОВЛЯЕТСЯ,
   * а не дублируется.
   */
  it('документ без принятых байтов назван в журнале, заменён и выложен заново', async () => {
    const upload = vi.fn(() => Promise.resolve());
    const statuses = ['uploaded', 'rendering'];
    const port = fakePort({
      waitPages: vi.fn(() =>
        Promise.resolve({
          ready: false,
          document: {
            documentId: 'doc-1',
            projectId: 'prj-portal',
            status: statuses.shift() ?? 'rendering',
            pageCount: null,
            pages: [],
          },
        }),
      ),
      createRunDocument: vi.fn(() =>
        Promise.resolve({
          documentId: 'doc-2',
          uploadUrl: 'https://rd.test/put/2',
          uploadHeaders: {},
          maxSizeBytes: 1_000_000,
        }),
      ),
      uploadWorkingPdf: upload,
    });
    const replaced: string[] = [];
    const saved: string[] = [];
    const deps = baseDeps(port, {
      findRunDocument: () =>
        Promise.resolve({ rdDocumentId: 'doc-1', rdProjectId: 'prj-portal', closed: false }),
      replaceRunDocument: (input) => {
        replaced.push(input.rdDocumentId);
        return Promise.resolve();
      },
      saveRunDocument: (input) => {
        saved.push(input.rdDocumentId);
        return Promise.resolve();
      },
    });
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createUploadWorkingPdfHandler(deps)(makeContext(markupPayload, sink));

    const orphaned = sink.logs.find(
      (entry) => entry.fields['event'] === 'rd_run_document_orphaned',
    );
    expect(orphaned?.fields['rd_document_id']).toBe('doc-1');

    // Строка ОДНА: вторая вставка всё равно упёрлась бы в UNIQUE, а «пять
    // документов, о которых никто не знает» начинаются именно с попытки.
    expect(saved).toEqual([]);
    expect(replaced).toEqual(['doc-2']);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sink.enqueued.map((job) => job.type)).toEqual(['rd.wait_pages']);
  });

  /** Исчезнувший документ (404) — то же самое: продолжать по нему нечем. */
  it('пропавший на их стороне документ заменяется, а не роняет пять попыток', async () => {
    let call = 0;
    const port = fakePort({
      waitPages: vi.fn(() => {
        call += 1;
        if (call === 1) {
          return Promise.reject(
            new RdWebError('RD WEB ответил 404', { status: 404, operation: 'document_read' }),
          );
        }
        return Promise.resolve({
          ready: false,
          document: {
            documentId: 'doc-2',
            projectId: 'prj-portal',
            status: 'rendering',
            pageCount: null,
            pages: [],
          },
        });
      }),
      createRunDocument: vi.fn(() =>
        Promise.resolve({
          documentId: 'doc-2',
          uploadUrl: 'https://rd.test/put/2',
          uploadHeaders: {},
          maxSizeBytes: 1_000_000,
        }),
      ),
      uploadWorkingPdf: vi.fn(() => Promise.resolve()),
    });
    const replaced: string[] = [];
    const deps = baseDeps(port, {
      findRunDocument: () =>
        Promise.resolve({ rdDocumentId: 'doc-1', rdProjectId: 'prj-portal', closed: false }),
      replaceRunDocument: (input) => {
        replaced.push(input.rdDocumentId);
        return Promise.resolve();
      },
    });
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createUploadWorkingPdfHandler(deps)(makeContext(markupPayload, sink));
    expect(replaced).toEqual(['doc-2']);
  });
});

// =====================================================================
// Задача 7: детекция
// =====================================================================

const detectPayload = {
  revisionId: REVISION,
  layoutRevisionId: LAYOUT,
  pageIndices: [0, 1, 2],
};

function detectDeps(
  port: RdWebPort,
  captured: { pages?: readonly number[]; blockPages?: readonly number[] },
): MarkupDeps {
  return baseDeps(port, {
    findRunDocument: () =>
      Promise.resolve({ rdDocumentId: 'doc-1', rdProjectId: 'prj-portal', closed: false }),
    importBlocks: (input) => {
      captured.pages = input.workingPageIndices;
      captured.blockPages = input.blocks.map((block) => block.workingPageIndex);
      return Promise.resolve({ imported: input.blocks.length, skippedPages: [] });
    },
  });
}

describe('layout.detect_pages', () => {
  /**
   * BLOCKING-1. Страница, которую удалённая сторона отказалась переразмечать,
   * приходит в `skipped_pages` без единого блока. До ремонта она уезжала в
   * импорт вместе со всей пачкой, там выполнялось `DELETE ... source='auto'` и
   * вставлялось ноль блоков: было четыре блока — стало ноль, задача succeeded.
   */
  it('пропущенная удалённой стороной страница импортируется её существующими блоками', async () => {
    const port = fakePort({
      detectPages: vi.fn(() =>
        Promise.resolve({
          created: [remoteBlock(0, 0.1), remoteBlock(2, 0.1)],
          skippedPages: [1],
          warnings: [],
        }),
      ),
      listBlocks: vi.fn(() =>
        Promise.resolve([remoteBlock(1, 0.1), remoteBlock(1, 0.4), remoteBlock(3, 0.1)]),
      ),
    });
    const captured: { pages?: readonly number[]; blockPages?: readonly number[] } = {};
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createDetectPagesHandler(detectDeps(port, captured))(makeContext(detectPayload, sink));

    // Страница 1 остаётся в списке замены, но НЕ пустой: её блоки забраны у них.
    expect(captured.pages).toEqual([0, 1, 2]);
    expect(captured.blockPages).toEqual([0, 2, 1, 1]);
  });

  /** Та же защита с другой стороны: удалять нечего и заменять нечем. */
  it('пропущенная страница без блоков и у них в список удаления не попадает', async () => {
    const port = fakePort({
      detectPages: vi.fn(() =>
        Promise.resolve({
          created: [remoteBlock(0, 0.1), remoteBlock(2, 0.1)],
          skippedPages: [1],
          warnings: [],
        }),
      ),
      listBlocks: vi.fn(() => Promise.resolve([])),
    });
    const captured: { pages?: readonly number[]; blockPages?: readonly number[] } = {};
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createDetectPagesHandler(detectDeps(port, captured))(makeContext(detectPayload, sink));

    expect(captured.pages).toEqual([0, 2]);
  });

  /** Положительный путь не изменился: без пропусков лишних вызовов нет. */
  it('без пропусков пачка импортируется целиком и удалённый набор не перечитывается', async () => {
    const listBlocks = vi.fn();
    const port = fakePort({
      detectPages: vi.fn(() =>
        Promise.resolve({
          created: [remoteBlock(0, 0.1), remoteBlock(1, 0.1), remoteBlock(2, 0.1)],
          skippedPages: [],
          warnings: [],
        }),
      ),
      listBlocks: listBlocks as never,
    });
    const captured: { pages?: readonly number[]; blockPages?: readonly number[] } = {};
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createDetectPagesHandler(detectDeps(port, captured))(makeContext(detectPayload, sink));

    expect(listBlocks).not.toHaveBeenCalled();
    expect(captured.pages).toEqual([0, 1, 2]);
    expect(captured.blockPages).toEqual([0, 1, 2]);
    expect(sink.enqueued.map((job) => job.type)).toEqual(['layout.analyze_coverage']);
  });

  /** BLOCKING-1, вторая часть: явная переразметка обязана переразмечать. */
  it('флаг перезаписи доходит до порта', async () => {
    const detect = vi.fn(() =>
      Promise.resolve({ created: [remoteBlock(0, 0.1)], skippedPages: [], warnings: [] }),
    );
    const port = fakePort({ detectPages: detect });
    const captured = {};
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createDetectPagesHandler(detectDeps(port, captured))(
      makeContext({ ...detectPayload, pageIndices: [0], overwriteExisting: true }, sink),
    );

    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ overwriteExisting: true, pageIndices: [0] }),
    );
  });

  /** Фан-аут наследует флаг: иначе кнопка «повторить детекцию» ничего не меняет. */
  it('фан-аут передаёт флаг перезаписи дочерним пачкам', async () => {
    const deps = baseDeps(fakePort({}), {
      findRunDocument: () =>
        Promise.resolve({ rdDocumentId: 'doc-1', rdProjectId: 'prj-portal', closed: false }),
    });
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createDetectPagesHandler(deps)(
      makeContext(
        { revisionId: REVISION, layoutRevisionId: LAYOUT, overwriteExisting: true },
        sink,
      ),
    );

    expect(sink.enqueued).toHaveLength(1);
    expect(sink.enqueued[0]?.payload).toMatchObject({ overwriteExisting: true });
    expect(sink.enqueued[0]?.dedupeKey).toMatch(/:overwrite$/u);
  });

  /** Первичная цепочка флаг НЕ ставит: автоматика не стирает сделанное. */
  it('фан-аут без флага не ставит его дочерним пачкам', async () => {
    const deps = baseDeps(fakePort({}), {
      findRunDocument: () =>
        Promise.resolve({ rdDocumentId: 'doc-1', rdProjectId: 'prj-portal', closed: false }),
    });
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await createDetectPagesHandler(deps)(
      makeContext({ revisionId: REVISION, layoutRevisionId: LAYOUT }, sink),
    );

    expect(sink.enqueued[0]?.payload['overwriteExisting']).toBeUndefined();
    expect(sink.enqueued[0]?.dedupeKey).not.toMatch(/overwrite/u);
  });

  /**
   * MINOR-8. Блок страницы, которой пачка не запрашивала, — это внешняя
   * система, ответившая мимо запроса. Молчаливый отброс делал бы её
   * неотличимой от «детектор ничего не нашёл»: задача succeeded, блоков ноль.
   */
  it('блок чужой страницы останавливает пачку, а не отбрасывается молча', async () => {
    const port = fakePort({
      detectPages: vi.fn(() =>
        Promise.resolve({
          created: [remoteBlock(0, 0.1), remoteBlock(99, 0.1)],
          skippedPages: [],
          warnings: [],
        }),
      ),
    });
    const captured: { pages?: readonly number[] } = {};
    const sink = { enqueued: [] as Enqueued[], logs: [] as LogEntry[] };

    await expect(
      createDetectPagesHandler(detectDeps(port, captured))(makeContext(detectPayload, sink)),
    ).rejects.toThrow(/99/u);

    // Импорт не состоялся вовсе: разметку по ответу мимо запроса не пишут.
    expect(captured.pages).toBeUndefined();
    expect(sink.logs.some((entry) => entry.fields['event'] === 'detect_foreign_pages')).toBe(true);
  });
});
