/**
 * Оркестровка задач 1–3 конвейера.
 *
 * Здесь проверяется ровно то, за что отвечает обработчик: последовательность
 * действий, идемпотентность, отказ до дорогой работы, уборка временных файлов и
 * состав событий ревизии. Содержательные проверки — разбор PDF, вердикт по
 * файлу, сборка рабочего документа и карта страниц — живут там, где они
 * выполняются, и проверяются на настоящих файлах и настоящей БД
 * (`apps/api/src/pdf/*.test.ts`, `apps/api/src/db/repositories/bundles.test.ts`).
 * Дублировать их фикстурами очереди значило бы проверять подставные объекты.
 */
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  createPdfLibToolkit,
  jobTypesOfQueue,
  loadPdfLibModule,
  type Database,
  type JobContext,
  type PdfToolkit,
} from '@id/api';

import { createWorkerRegistry, readStorageObject, type PipelineJobsOptions } from './pipeline.js';

import {
  createBundleBuildHandler,
  BUNDLE_BUILDER,
  type BundleBuildDeps,
  type BundlePlan,
} from './bundle-build.js';
import {
  createFileVerifyHandler,
  type FileForVerification,
  type FileVerdict,
  type FileVerifyDeps,
} from './file-verify.js';
import {
  createSignatureProbeHandler,
  type SignatureProbeDeps,
  type StoredSignatureProbe,
} from './signature-probe.js';

/** Формы аргументов моков: без них `mock.calls` вырождается в пустой кортеж. */
type EvaluatePolicy = Parameters<FileVerifyDeps['evaluate']>[1];
type CreateBundleInput = Parameters<BundleBuildDeps['createBundle']>[0];

const logger = pino({ level: 'silent' });

interface Emitted {
  readonly type: string;
  readonly payload: Record<string, unknown> | undefined;
}

function makeContext<T extends Record<string, unknown>>(
  payload: T,
  emitted: Emitted[],
  signal = new AbortController().signal,
): JobContext<never> {
  const context = {
    jobId: '00000000-0000-4000-8000-000000000001',
    type: 'file.verify',
    attempt: 1,
    maxAttempts: 3,
    revisionId: (payload['revisionId'] as string | undefined) ?? null,
    payload,
    // База обработчику не нужна: он работает через связанные функции портов.
    db: undefined,
    logger,
    signal,
    enqueue: () => Promise.resolve({ jobId: 'job', created: true }),
    emit: (type: string, eventPayload?: Record<string, unknown>) => {
      emitted.push({ type, payload: eventPayload });
      return Promise.resolve();
    },
  };
  return context as unknown as JobContext<never>;
}

const FILE: FileForVerification = {
  fileId: '00000000-0000-4000-8000-0000000000f1',
  revisionId: '00000000-0000-4000-8000-0000000000r1'.replace('r', 'a'),
  fileName: 'akt.pdf',
  verifyState: 'ok',
  storageKey: 'blobs/aa',
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
};

/** Соседняя ревизия того же подрядчика: область её пропускает, сверка — нет. */
const OTHER_REVISION = '00000000-0000-4000-8000-0000000000a2';

const OK_VERDICT: FileVerdict = {
  state: 'ok',
  sha256: FILE.sha256,
  pageCount: 2,
  pages: [
    { index: 0, widthPt: 595, heightPt: 842, rotation: 0 },
    { index: 1, widthPt: 595, heightPt: 842, rotation: 90 },
  ],
  signature: {
    result: 'none_detected',
    hasByteRange: false,
    subFilters: [],
    signatureFieldCount: 0,
    incrementalUpdates: 0,
    probeError: null,
  },
  warnings: [],
};

const QUARANTINE_VERDICT: FileVerdict = {
  state: 'quarantined',
  sha256: FILE.sha256,
  reason: 'unparsable',
  detail: 'дерево страниц не содержит ни одной страницы',
  signature: {
    result: 'unknown',
    hasByteRange: false,
    subFilters: [],
    signatureFieldCount: 0,
    incrementalUpdates: 0,
    probeError: 'структура файла разобрана не полностью',
  },
};

function verifyDeps(overrides: Partial<FileVerifyDeps> = {}): FileVerifyDeps {
  return {
    loadFile: () => Promise.resolve(FILE),
    readObject: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    evaluate: () => OK_VERDICT,
    limits: { maxBytes: 1_000_000, maxPages: 500 },
    ...overrides,
  };
}

describe('file.verify', () => {
  it('проверенный файл даёт событие и передаёт хэш хранилища в вердикт', async () => {
    const emitted: Emitted[] = [];
    const evaluate = vi.fn((_bytes: Uint8Array, _policy: EvaluatePolicy) => OK_VERDICT);
    const handler = createFileVerifyHandler(verifyDeps({ evaluate }));

    await handler(makeContext({ revisionId: FILE.revisionId, sourceFileId: FILE.fileId }, emitted));

    expect(emitted.map((event) => event.type)).toEqual(['file.verified']);
    expect(emitted[0]?.payload).toMatchObject({ pageCount: 2, signature: 'none_detected' });
    // Расхождение содержимого с записанным sha256 обязано ловиться вердиктом,
    // а значит ожидаемый хэш обязан до него доехать.
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ expectedSha256: FILE.sha256 });
  });

  it('файл в карантине даёт событие с причиной и НЕ валит задачу', async () => {
    const emitted: Emitted[] = [];
    const handler = createFileVerifyHandler(
      verifyDeps({
        loadFile: () => Promise.resolve({ ...FILE, verifyState: 'quarantined' }),
        evaluate: () => QUARANTINE_VERDICT,
      }),
    );

    await handler(makeContext({ revisionId: FILE.revisionId, sourceFileId: FILE.fileId }, emitted));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('file.quarantined');
    expect(emitted[0]?.payload).toMatchObject({ reason: 'unparsable' });
  });

  it('расхождение содержимого с записанным состоянием останавливает конвейер', async () => {
    const emitted: Emitted[] = [];
    // Записано «ok», а в хранилище лежит неразбираемый файл.
    const handler = createFileVerifyHandler(verifyDeps({ evaluate: () => QUARANTINE_VERDICT }));

    await expect(
      handler(makeContext({ revisionId: FILE.revisionId, sourceFileId: FILE.fileId }, emitted)),
    ).rejects.toThrow(/расходится|записан как/i);
    expect(emitted.map((event) => event.type)).toEqual(['file.verify_mismatch']);
  });

  it('при наличии записи вердикта расхождение не отказ, а запись', async () => {
    const emitted: Emitted[] = [];
    const saveVerdict = vi.fn(
      (_input: { fileId: string; revisionId: string; verdict: FileVerdict }) =>
        Promise.resolve({ written: true }),
    );
    const handler = createFileVerifyHandler(
      verifyDeps({ evaluate: () => QUARANTINE_VERDICT, saveVerdict }),
    );

    await handler(makeContext({ revisionId: FILE.revisionId, sourceFileId: FILE.fileId }, emitted));

    expect(saveVerdict).toHaveBeenCalledOnce();
    expect(saveVerdict.mock.calls[0]?.[0]).toMatchObject({ fileId: FILE.fileId });
    expect(emitted.map((event) => event.type)).toEqual(['file.quarantined']);
  });

  it('файл вне области видимости — отказ, а не пустая проверка', async () => {
    const handler = createFileVerifyHandler(verifyDeps({ loadFile: () => Promise.resolve(null) }));

    await expect(
      handler(makeContext({ revisionId: FILE.revisionId, sourceFileId: FILE.fileId }, [])),
    ).rejects.toThrow(/не найден или недоступен/);
  });

  it('файл чужой ревизии отвергается, даже если подрядчик тот же', async () => {
    // Область видимости задачи закреплена за подрядчиком ревизии, а поставок у
    // подрядчика много: без этой сверки вердикт записался бы не в ту ревизию.
    const handler = createFileVerifyHandler(verifyDeps());

    await expect(
      handler(makeContext({ revisionId: OTHER_REVISION, sourceFileId: FILE.fileId }, [])),
    ).rejects.toThrow(/принадлежит ревизии/);
  });
});

describe('file.signature_probe', () => {
  function probeDeps(overrides: Partial<SignatureProbeDeps> = {}): SignatureProbeDeps {
    return {
      loadFile: () => Promise.resolve(FILE),
      readObject: () => Promise.resolve(new Uint8Array([1])),
      probe: () => ({ signature: OK_VERDICT.signature }),
      now: () => new Date(Date.UTC(2026, 0, 1)),
      ...overrides,
    };
  }

  it('найденная подпись фиксируется как detected_unverified и не признаётся действительной', async () => {
    const emitted: Emitted[] = [];
    const saveProbe = vi.fn(
      (_input: { fileId: string; revisionId: string; probe: StoredSignatureProbe }) =>
        Promise.resolve({ written: true }),
    );
    const handler = createSignatureProbeHandler(
      probeDeps({
        saveProbe,
        probe: () => ({
          signature: {
            result: 'detected_unverified',
            hasByteRange: true,
            subFilters: ['adbe.pkcs7.detached'],
            signatureFieldCount: 1,
            incrementalUpdates: 1,
            probeError: null,
          },
        }),
      }),
    );

    await handler(makeContext({ revisionId: FILE.revisionId, sourceFileId: FILE.fileId }, emitted));

    expect(saveProbe.mock.calls[0]?.[0]).toMatchObject({
      probe: {
        result: 'detected_unverified',
        hasByteRange: true,
        subFilters: ['adbe.pkcs7.detached'],
        probedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(emitted[0]?.payload).toMatchObject({ result: 'detected_unverified' });
  });

  it('недоступное хранилище даёт unknown с причиной, а не падение задачи', async () => {
    const emitted: Emitted[] = [];
    const saveProbe = vi.fn(
      (_input: { fileId: string; revisionId: string; probe: StoredSignatureProbe }) =>
        Promise.resolve({ written: true }),
    );
    const handler = createSignatureProbeHandler(
      probeDeps({
        saveProbe,
        readObject: () => Promise.reject(new Error('S3 недоступен')),
      }),
    );

    await handler(makeContext({ revisionId: FILE.revisionId, sourceFileId: FILE.fileId }, emitted));

    expect(saveProbe.mock.calls[0]?.[0]).toMatchObject({
      probe: { result: 'unknown', probeError: 'S3 недоступен' },
    });
    // «Подписи нет» и «мы не смотрели» — разные ответы, и второй не молчит.
    expect(emitted[0]?.payload).toMatchObject({ result: 'unknown' });
  });

  it('файл чужой ревизии отвергается и здесь', async () => {
    const handler = createSignatureProbeHandler(probeDeps());

    await expect(
      handler(makeContext({ revisionId: OTHER_REVISION, sourceFileId: FILE.fileId }, [])),
    ).rejects.toThrow(/принадлежит ревизии/);
  });
});

describe('bundle.build', () => {
  const REVISION = '00000000-0000-4000-8000-0000000000e1';

  const PLAN: BundlePlan = {
    revisionId: REVISION,
    status: 'draft',
    aggregateManifestHash: 'b'.repeat(64),
    blockers: [],
    files: [
      {
        sourceFileId: 'file-1',
        fileName: 'akt.pdf',
        sortOrder: 0,
        blobSha256: 'c'.repeat(64),
        sizeBytes: 2048,
        s3Key: 'blobs/cc',
        verifyState: 'ok',
        pages: [
          { sourcePageId: 'page-1', filePageIndex: 0 },
          { sourcePageId: 'page-2', filePageIndex: 1 },
        ],
      },
      {
        sourceFileId: 'file-2',
        fileName: 'sertifikat.pdf',
        sortOrder: 1,
        blobSha256: 'd'.repeat(64),
        sizeBytes: 1024,
        s3Key: 'blobs/dd',
        verifyState: 'ok',
        pages: [{ sourcePageId: 'page-3', filePageIndex: 0 }],
      },
    ],
  };

  function bundleDeps(overrides: Partial<BundleBuildDeps> = {}): BundleBuildDeps {
    return {
      loadPlan: () => Promise.resolve(PLAN),
      findExistingBundle: () => Promise.resolve(null),
      // По умолчанию переиспользовать нечего: у ревизии нет предков.
      findReusableWorkingPdf: () => Promise.resolve(null),
      workingPdfExists: () => Promise.resolve(true),
      fetchOriginal: (_key, path) => writeFile(path, 'PDF'),
      storeWorkingPdf: () =>
        Promise.resolve({ sha256: 'e'.repeat(64), sizeBytes: 4096, s3Key: 'blobs/ee' }),
      createBundle: () =>
        Promise.resolve({ bundle: { id: 'bundle-1', pageCount: 3 }, created: true }),
      toolkit: {
        kind: 'pdf-lib',
        buildWorkingPdf: ({ parts }) => {
          const map = parts
            .flatMap((part, partIndex) =>
              Array.from({ length: part.pageCount }, (_, filePageIndex) => ({
                workingPageIndex: partIndex + filePageIndex,
                sourceFileId: part.sourceFileId,
                filePageIndex,
              })),
            )
            .map((entry, index) => ({ ...entry, workingPageIndex: index }));
          return Promise.resolve({ pageCount: map.length, map, toolkit: 'pdf-lib' as const });
        },
      },
      ...overrides,
    };
  }

  it('карта страниц связывает страницы рабочего PDF со строками source_pages', async () => {
    const emitted: Emitted[] = [];
    const createBundle = vi.fn((_input: CreateBundleInput) =>
      Promise.resolve({ bundle: { id: 'bundle-1', pageCount: 3 }, created: true }),
    );
    const handler = createBundleBuildHandler(bundleDeps({ createBundle }));

    await handler(makeContext({ revisionId: REVISION }, emitted));

    const input = createBundle.mock.calls[0]?.[0];
    expect(input?.pages).toEqual([
      { workingPageIndex: 0, sourcePageId: 'page-1' },
      { workingPageIndex: 1, sourcePageId: 'page-2' },
      { workingPageIndex: 2, sourcePageId: 'page-3' },
    ]);
    // Версия сборщика включает реализацию: выход qpdf и pdf-lib побайтово разный.
    expect(input?.builderVersion).toBe(`${BUNDLE_BUILDER}+pdf-lib`);
    expect(emitted[0]).toMatchObject({ type: 'bundle.ready' });
  });

  it('уже собранный документ того же состава не пересобирается', async () => {
    const emitted: Emitted[] = [];
    const fetchOriginal = vi.fn(() => Promise.resolve());
    const handler = createBundleBuildHandler(
      bundleDeps({
        fetchOriginal,
        findExistingBundle: () => Promise.resolve({ id: 'bundle-0', pageCount: 3 }),
      }),
    );

    await handler(makeContext({ revisionId: REVISION }, emitted));

    expect(fetchOriginal).not.toHaveBeenCalled();
    expect(emitted[0]?.payload).toMatchObject({ bundleId: 'bundle-0', reused: true });
  });

  /**
   * §3: «результаты предыдущей ревизии переиспользуются только при совпадении
   * `aggregate_manifest_hash`». Совпадение ищет репозиторий по цепочке
   * `parent_revision_id`; здесь проверяется поведение задачи при найденном и
   * при негодном кандидате.
   */
  const REUSABLE = {
    revisionId: 'parent-revision',
    workingPdfBlobSha256: 'f'.repeat(64),
    sizeBytes: 8192,
    s3Key: `blobs/ff/ff/${'f'.repeat(64)}`,
    pageCount: 3,
  };

  it('состав, совпавший с предыдущей ревизией, не пересобирается заново', async () => {
    const emitted: Emitted[] = [];
    const fetchOriginal = vi.fn(() => Promise.resolve());
    const storeWorkingPdf = vi.fn(() =>
      Promise.resolve({ sha256: 'e'.repeat(64), sizeBytes: 4096, s3Key: 'blobs/ee' }),
    );
    const createBundle = vi.fn((_input: CreateBundleInput) =>
      Promise.resolve({ bundle: { id: 'bundle-2', pageCount: 3 }, created: true }),
    );

    const handler = createBundleBuildHandler(
      bundleDeps({
        fetchOriginal,
        storeWorkingPdf,
        createBundle,
        findReusableWorkingPdf: () => Promise.resolve(REUSABLE),
      }),
    );
    await handler(makeContext({ revisionId: REVISION }, emitted));

    // 86 МБ не качаются и не склеиваются, но своя строка bundle и своя карта
    // страниц у ревизии появляются: идентификаторы страниц у неё собственные.
    expect(fetchOriginal).not.toHaveBeenCalled();
    expect(storeWorkingPdf).not.toHaveBeenCalled();
    const input = createBundle.mock.calls[0]?.[0];
    expect(input?.workingPdf.sha256).toBe(REUSABLE.workingPdfBlobSha256);
    expect(input?.pages).toEqual([
      { workingPageIndex: 0, sourcePageId: 'page-1' },
      { workingPageIndex: 1, sourcePageId: 'page-2' },
      { workingPageIndex: 2, sourcePageId: 'page-3' },
    ]);
    expect(emitted[0]?.payload).toMatchObject({
      reused: true,
      reusedFromRevisionId: 'parent-revision',
    });
  });

  it('переиспользование не берётся на веру: без объекта в хранилище идёт обычная сборка', async () => {
    const fetchOriginal = vi.fn((_key: string, path: string) => writeFile(path, 'PDF'));
    const handler = createBundleBuildHandler(
      bundleDeps({
        fetchOriginal,
        findReusableWorkingPdf: () => Promise.resolve(REUSABLE),
        workingPdfExists: () => Promise.resolve(false),
      }),
    );

    await handler(makeContext({ revisionId: REVISION }, []));
    expect(fetchOriginal).toHaveBeenCalled();
  });

  it('расхождение числа страниц отменяет переиспользование', async () => {
    const fetchOriginal = vi.fn((_key: string, path: string) => writeFile(path, 'PDF'));
    const handler = createBundleBuildHandler(
      bundleDeps({
        fetchOriginal,
        findReusableWorkingPdf: () => Promise.resolve({ ...REUSABLE, pageCount: 2 }),
      }),
    );

    await handler(makeContext({ revisionId: REVISION }, []));
    expect(fetchOriginal).toHaveBeenCalled();
  });

  it('препятствия состава отвергают сборку до скачивания файлов', async () => {
    const fetchOriginal = vi.fn(() => Promise.resolve());
    const handler = createBundleBuildHandler(
      bundleDeps({
        fetchOriginal,
        loadPlan: () => Promise.resolve({ ...PLAN, blockers: ['файл «akt.pdf» в карантине'] }),
      }),
    );

    await expect(handler(makeContext({ revisionId: REVISION }, []))).rejects.toThrow(/в карантине/);
    expect(fetchOriginal).not.toHaveBeenCalled();
  });

  it('страница без соответствия в оригиналах прекращает сборку', async () => {
    const createBundle = vi.fn((_input: CreateBundleInput) =>
      Promise.resolve({ bundle: { id: 'bundle-1', pageCount: 3 }, created: true }),
    );
    const handler = createBundleBuildHandler(
      bundleDeps({
        createBundle,
        toolkit: {
          kind: 'pdf-lib',
          buildWorkingPdf: () =>
            Promise.resolve({
              pageCount: 1,
              // Страница из файла, которого в составе нет.
              map: [{ workingPageIndex: 0, sourceFileId: 'file-9', filePageIndex: 0 }],
              toolkit: 'pdf-lib' as const,
            }),
        },
      }),
    );

    await expect(handler(makeContext({ revisionId: REVISION }, []))).rejects.toThrow(
      /не найдено соответствие/,
    );
    expect(createBundle).not.toHaveBeenCalled();
  });

  it('временный каталог удаляется и при успехе, и при отказе', async () => {
    const workDirBase = process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp';
    const before = await readdir(workDirBase);

    const handler = createBundleBuildHandler(
      bundleDeps({
        workDirBase,
        storeWorkingPdf: () => Promise.reject(new Error('хранилище недоступно')),
      }),
    );

    await expect(handler(makeContext({ revisionId: REVISION }, []))).rejects.toThrow(
      /хранилище недоступно/,
    );

    const after = await readdir(workDirBase);
    const leftovers = after.filter(
      (entry) => entry.startsWith('id-bundle-') && !before.includes(entry),
    );
    expect(leftovers).toEqual([]);
    for (const entry of leftovers) expect(existsSync(entry)).toBe(false);
  });

  it('остановка воркера прекращает сборку между файлами', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchOriginal = vi.fn(() => Promise.resolve());
    const handler = createBundleBuildHandler(bundleDeps({ fetchOriginal }));

    await expect(
      handler(makeContext({ revisionId: REVISION }, [], controller.signal)),
    ).rejects.toThrow(/прервана/);
    expect(fetchOriginal).not.toHaveBeenCalled();
  });
});

/**
 * Связывание, а не только написание.
 *
 * На S3 слой наблюдаемости был написан, покрыт зелёными тестами и НЕ подключён:
 * тесты проверяли модули напрямую, а приложение их не вызывало. Здесь
 * проверяется именно подключение — состав реестра, который получает процесс
 * воркера, и то, что захват задач очереди `cpu` эти типы действительно берёт.
 */
describe('реестр воркера', () => {
  function options(): PipelineJobsOptions {
    return {
      // Порты связываются лениво: ни один из них при регистрации не вызывается,
      // поэтому подставные объекты здесь не маскируют работу с БД.
      db: {} as Database,
      storage: {} as PipelineJobsOptions['storage'],
      toolkit: { kind: 'pdf-lib' } as PdfToolkit,
      limits: { maxBytes: 1024, maxPages: 10 },
    };
  }

  it('задачи 1–3 зарегистрированы и будут захвачены очередью cpu', () => {
    const registry = createWorkerRegistry(options());

    for (const type of ['file.verify', 'file.signature_probe', 'bundle.build'] as const) {
      expect(registry.has(type), `обработчик ${type} не зарегистрирован`).toBe(true);
      // Захват фильтрует по типам очереди: незарегистрированный тип воркер не
      // берёт вовсе, и задача молча ждала бы в очереди «queued» навсегда.
      expect(jobTypesOfQueue('cpu')).toContain(type);
      expect(registry.typesOfQueue('cpu')).toContain(type);
    }
    // Обслуживание не вытеснено регистрацией стадий.
    expect(registry.has('jobs.reaper')).toBe(true);
  });

  it('повторная регистрация — отказ сборки, а не «побеждает последний»', () => {
    const registry = createWorkerRegistry(options());
    expect(() => createWorkerRegistry(options())).not.toThrow();
    expect(() => registry.register('file.verify', () => Promise.resolve())).toThrow(
      /уже зарегистрирован/,
    );
  });
});

describe('чтение объекта хранилища', () => {
  function storageOf(sizeBytes: number, chunks: readonly Buffer[]): PipelineJobsOptions['storage'] {
    return {
      getObjectStream: () =>
        Promise.resolve({
          stream: Readable.from(chunks),
          sizeBytes,
          contentLength: sizeBytes,
          range: null,
        }),
    } as unknown as PipelineJobsOptions['storage'];
  }

  it('объект в пределах лимита читается целиком', async () => {
    const bytes = await readStorageObject(storageOf(4, [Buffer.from('PDF!')]), 'blobs/aa', 16);
    expect(Buffer.from(bytes).toString()).toBe('PDF!');
  });

  it('заявленный размер сверх лимита отвергается до чтения', async () => {
    await expect(
      readStorageObject(storageOf(1_000_000, [Buffer.alloc(1)]), 'blobs/aa', 16),
    ).rejects.toThrow(/превышает предел/);
  });

  it('объект, который длиннее заявленного, обрывается на лимите', async () => {
    // Размер приходит из метаданных хранилища; доверять только им значит отдать
    // heap воркера тому, кто положил объект в бакет.
    const storage = storageOf(4, [Buffer.alloc(8), Buffer.alloc(16)]);
    await expect(readStorageObject(storage, 'blobs/aa', 16)).rejects.toThrow(/длиннее заявленного/);
  });
});

/**
 * Деградация ADR-0003 на машине без qpdf.
 *
 * Проверяется не «функция написана», а что реализация действительно
 * загружается в ЭТОМ процессе. `import()` резолвит спецификатор относительно
 * файла, в котором написан, а `pdf-lib` объявлен зависимостью воркера, а не
 * `apps/api`: импорт, написанный в общей библиотеке, не нашёл бы пакет вовсе, и
 * воркер на машине разработки не поднялся бы.
 */
describe('запасная реализация работы с PDF', () => {
  it('pdf-lib загружается импортом из модуля воркера', async () => {
    const module = await loadPdfLibModule((specifier) => import(specifier));
    expect(typeof module.PDFDocument.create).toBe('function');
    expect(createPdfLibToolkit(module).kind).toBe('pdf-lib');
  });

  it('отсутствие библиотеки даёт понятный отказ, а не стек изнутри сборки', async () => {
    await expect(
      loadPdfLibModule(() => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')), 'нет-такого'),
    ).rejects.toThrow(/pdf-lib недоступен/);
  });
});
