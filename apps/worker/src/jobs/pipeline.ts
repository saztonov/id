/**
 * Связывание задач 1–3 конвейера с базой, хранилищем и разбором PDF (§12).
 *
 * Обработчики написаны на портах: `file.verify` не знает ни про Drizzle, ни про
 * S3, он знает «прочитать файл», «получить вердикт», «записать». Порты кто-то
 * обязан связать с настоящими реализациями, и это место — здесь. Без него
 * обработчики остаются кодом, который компилируется, покрыт тестами и никогда не
 * выполняется: ровно тот отказ, которым закончился слой наблюдаемости на S3.
 * Поэтому `registerPipelineJobs()` вызывается из точки входа воркера, и её
 * вызов — часть поставки, а не украшение.
 *
 * ## Область видимости фоновой задачи
 *
 * У воркера нет пользователя, но это не повод работать без области. Задача
 * получает `revisionId` из payload, и порядок такой: ревизия разрешается ОДНИМ
 * системным чтением (`SYSTEM_SCOPE`, единственное место в файле, где область не
 * ограничена), после чего строится область, закреплённая за подрядчиком этой
 * ревизии, и всё остальное — файл, страницы, состав, запись bundle — читается и
 * пишется уже ею. Payload, назвавший файл чужой поставки, не находит его
 * вовсе; файл соседней ревизии того же подрядчика отсекается сверкой
 * `revisionId` в самом обработчике.
 *
 * Системное чтение вынесено в одну функцию намеренно: «где здесь запрос без
 * ограничения» должно отвечаться поиском по одному имени, а не вычиткой файла.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import {
  blobKey,
  createBundle,
  createMaintenanceRegistry,
  createRunDocument,
  evaluatePdfFile,
  FALLBACK_LAYOUT_THRESHOLDS,
  findBundle,
  findBundleByManifest,
  findFileContent,
  findLayoutRevision,
  findRevisionForFiles,
  findRunDocument,
  importDetectedBlocks,
  listBundlePages,
  listLayoutBlocks,
  loadBundlePlan,
  loadProfileForLayout,
  previewPageKey,
  probePdf,
  replaceRunDocument,
  saveFileVerdict,
  savePageAttentionFlags,
  saveSignatureProbe,
  storableVerdict,
  type AuthScope,
  type Database,
  type JobRegistry,
  type LayoutRevisionView,
  type PdfToolkit,
  type RdWebPort,
  type StorageProvider,
} from '@id/api';

import {
  createBundleBuildHandler,
  type BundleBuildDeps,
  type BundlePlan,
  type StoredWorkingPdf,
} from './bundle-build.js';
import {
  createFileVerifyHandler,
  type FileForVerification,
  type FileJobTarget,
  type FileVerifyDeps,
} from './file-verify.js';
import { createSignatureProbeHandler, type SignatureProbeDeps } from './signature-probe.js';
import {
  createAnalyzeCoverageHandler,
  createDetectPagesHandler,
  createPreviewCacheHandler,
  createRunDocumentHandler,
  createUploadWorkingPdfHandler,
  createWaitPagesHandler,
  type MarkupDeps,
  type MarkupTarget,
  type PageBlocksSnapshot,
  type WaitPagesOptions,
} from './markup.js';

/**
 * Актор фоновых задач.
 *
 * Нулевой uuid, а не «какой-нибудь администратор»: строка журнала, приписанная
 * настоящему человеку за работу, которую сделал конвейер, — это ложь в
 * юридически значимом журнале (§11). Фильтрацию `userId` не задаёт (её задают
 * `kind` и `contractorId`), поэтому на доступ значение не влияет.
 */
const WORKER_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Единственная неограниченная область в файле.
 *
 * Ею разрешается ТОЛЬКО ревизия из payload и ТОЛЬКО ради того, чтобы узнать её
 * подрядчика. Всё остальное идёт закреплённой областью — см. `pinScope()`.
 */
const SYSTEM_SCOPE: AuthScope = { kind: 'admin', userId: WORKER_ACTOR_ID };

const PDF_CONTENT_TYPE = 'application/pdf';

export interface PipelineLimits {
  /** Потолок размера одного исходного файла (`MAX_UPLOAD_BYTES`). */
  readonly maxBytes: number;
  /** Потолок числа страниц (`MAX_PAGES_PER_FILE`). */
  readonly maxPages: number;
}

export interface PipelineJobsOptions {
  readonly db: Database;
  readonly storage: StorageProvider;
  /** Выбран startup-проверкой (`selectPdfToolkit`), а не этим модулем. */
  readonly toolkit: PdfToolkit;
  readonly limits: PipelineLimits;
  /** Каталог временных копий при сборке; по умолчанию системный. */
  readonly workDirBase?: string | undefined;
  /**
   * Адаптер RD WEB (§5.1). `null` — интеграция не настроена: задачи 4–9 при
   * этом честно падают с внятной причиной, а стадии приёма продолжают работать.
   */
  readonly rdweb?: RdWebPort | null | undefined;
  /** Проект RD WEB, которым владеет портал (первый из `RDWEB_PROJECT_ALLOWLIST`). */
  readonly rdProjectId?: string | null | undefined;
  /** `PREVIEW_MODE=cached` (§7.1): только тогда ставится задача 9. */
  readonly previewCached?: boolean | undefined;
  /** Настройки поллинга рендера; в тестах ускоряются. */
  readonly waitPages?: WaitPagesOptions | undefined;
}

export class PipelineScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineScopeError';
  }
}

/**
 * Область, закреплённая за подрядчиком ревизии из payload.
 *
 * `null` — такой ревизии нет. Отдельного варианта «есть, но чужая» здесь не
 * бывает по построению: системная область видит все, и отсутствие строки
 * означает именно отсутствие ревизии.
 */
async function pinScope(db: Database, revisionId: string): Promise<AuthScope | null> {
  const revision = await findRevisionForFiles(db, SYSTEM_SCOPE, revisionId);
  if (revision === null) return null;
  return { kind: 'contractor', userId: WORKER_ACTOR_ID, contractorId: revision.contractorId };
}

// =====================================================================
// Хранилище
// =====================================================================

/**
 * Чтение объекта целиком в память.
 *
 * Потолок проверяется дважды — по заявленному размеру и по фактически
 * прочитанным байтам. Первой проверки мало: размер приходит из метаданных
 * хранилища, а читать до конца объект, который «весит» иначе, значит отдать
 * heap воркера тому, кто положил объект в бакет.
 */
export async function readStorageObject(
  storage: StorageProvider,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const object = await storage.getObjectStream(key);
  if (object.sizeBytes > maxBytes) {
    object.stream.destroy();
    throw new PipelineScopeError(
      `Объект хранилища ${key} размером ${object.sizeBytes} Б превышает предел ${maxBytes} Б.`,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.stream) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) {
      object.stream.destroy();
      throw new PipelineScopeError(
        `Объект хранилища ${key} длиннее заявленного и превысил предел ${maxBytes} Б.`,
      );
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Выкладка оригинала во временный файл потоком: 86 МБ в heap здесь не нужны. */
async function fetchOriginal(
  storage: StorageProvider,
  key: string,
  destinationPath: string,
): Promise<void> {
  const object = await storage.getObjectStream(key);
  await pipeline(object.stream, createWriteStream(destinationPath));
}

/** sha256 файла потоком: собранный рабочий документ в память не поднимается. */
async function hashFile(path: string): Promise<string> {
  const digest = createHash('sha256');
  await pipeline(createReadStream(path), digest);
  return digest.digest('hex');
}

/**
 * Сохранение собранного рабочего документа.
 *
 * Ключ детерминирован от sha256 (`blobKey`): та же сборка второй раз пишет тот
 * же объект, а не плодит копии, и дедупликация блобов работает на производных
 * документах так же, как на оригиналах (§7).
 */
async function storeWorkingPdf(storage: StorageProvider, path: string): Promise<StoredWorkingPdf> {
  const sha256 = await hashFile(path);
  const { size } = await stat(path);
  const key = blobKey(sha256);
  await storage.putObject({
    key,
    body: createReadStream(path),
    contentType: PDF_CONTENT_TYPE,
    contentLength: size,
  });
  return { sha256, sizeBytes: size, s3Key: key };
}

// =====================================================================
// Связывание портов
// =====================================================================

/** Общий для обеих файловых задач порт чтения строки файла. */
function loadFilePort(
  db: Database,
): (target: FileJobTarget) => Promise<FileForVerification | null> {
  return async (target: FileJobTarget): Promise<FileForVerification | null> => {
    const scope = await pinScope(db, target.revisionId);
    if (scope === null) return null;

    const file = await findFileContent(db, scope, target.sourceFileId);
    if (file === null) return null;
    return {
      fileId: file.fileId,
      revisionId: file.revisionId,
      fileName: file.fileName,
      verifyState: file.verifyState,
      storageKey: file.storageKey,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    };
  };
}

function fileVerifyDeps(options: PipelineJobsOptions): FileVerifyDeps {
  return {
    loadFile: loadFilePort(options.db),
    readObject: (storageKey) =>
      readStorageObject(options.storage, storageKey, options.limits.maxBytes),
    // Вердикт считает `evaluatePdfFile()` — та же функция, что и на синхронном
    // пути загрузки. Второй реализации проверки быть не должно: расхождение
    // означало бы, что принятый при загрузке файл отвергается конвейером
    // (или наоборот) без единого признака, по которому это заметно.
    evaluate: (bytes, policy) =>
      evaluatePdfFile(bytes, {
        maxBytes: policy.maxBytes,
        maxPages: policy.maxPages,
        declaredMime: PDF_CONTENT_TYPE,
        ...(policy.expectedSha256 !== undefined ? { expectedSha256: policy.expectedSha256 } : {}),
      }),
    limits: options.limits,

    // Приведение вердикта к колонкам — общей функцией с синхронным путём
    // загрузки (`storableVerdict`). Вторая реализация означала бы, что
    // состояние файла зависит от того, кто его записал.
    saveVerdict: async ({ fileId, revisionId, verdict }) => {
      const scope = await pinScope(options.db, revisionId);
      if (scope === null) return { written: false, reason: 'ревизия исчезла' };

      const storable = storableVerdict(verdict, new Date().toISOString());
      const outcome = await saveFileVerdict(options.db, scope, {
        fileId,
        revisionId,
        verifyState: storable.verifyState,
        verifyError: storable.verifyError,
        signatureProbe: storable.signatureProbe,
        pages: storable.pages,
      });

      return outcome.kind === 'written'
        ? { written: true }
        : { written: false, reason: outcome.reason };
    },
  };
}

function signatureProbeDeps(options: PipelineJobsOptions): SignatureProbeDeps {
  return {
    loadFile: loadFilePort(options.db),
    readObject: (storageKey) =>
      readStorageObject(options.storage, storageKey, options.limits.maxBytes),
    probe: (bytes) => ({ signature: probePdf(bytes).signature }),

    saveProbe: async ({ fileId, revisionId, probe }) => {
      const scope = await pinScope(options.db, revisionId);
      if (scope === null) return { written: false, reason: 'ревизия исчезла' };

      const outcome = await saveSignatureProbe(options.db, scope, {
        fileId,
        revisionId,
        probe: { ...probe, subFilters: [...probe.subFilters] },
      });
      return outcome.kind === 'written'
        ? { written: true }
        : { written: false, reason: outcome.reason };
    },
  };
}

function bundleBuildDeps(options: PipelineJobsOptions): BundleBuildDeps {
  const { db, storage } = options;

  return {
    loadPlan: async (revisionId: string): Promise<BundlePlan | null> => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;
      return loadBundlePlan(db, scope, revisionId);
    },

    findExistingBundle: async (target) => {
      const scope = await pinScope(db, target.revisionId);
      if (scope === null) return null;
      const bundle = await findBundleByManifest(db, scope, target);
      return bundle === null ? null : { id: bundle.id, pageCount: bundle.pageCount };
    },

    fetchOriginal: (storageKey, destinationPath) =>
      fetchOriginal(storage, storageKey, destinationPath),

    storeWorkingPdf: (localPath) => storeWorkingPdf(storage, localPath),

    createBundle: async (input) => {
      const scope = await pinScope(db, input.revisionId);
      if (scope === null) {
        throw new PipelineScopeError(
          `Ревизия ${input.revisionId} исчезла между планом и записью рабочего документа.`,
        );
      }
      const result = await createBundle(db, scope, input);
      return {
        bundle: { id: result.bundle.id, pageCount: result.bundle.pageCount },
        created: result.created,
      };
    },

    toolkit: options.toolkit,
    ...(options.workDirBase !== undefined ? { workDirBase: options.workDirBase } : {}),
  };
}

// =====================================================================
// Порты задач 4–9 (разметка)
// =====================================================================

/**
 * Сборка цели задачи разметки из репозиториев.
 *
 * Всё читается закреплённой областью (`pinScope`), включая карту страниц и
 * рабочий документ: задача, назвавшая в payload чужую ревизию, не находит
 * ничего, а не работает с чужими данными от имени системы.
 */
async function buildMarkupTarget(
  options: PipelineJobsOptions,
  scope: AuthScope,
  layout: LayoutRevisionView,
): Promise<MarkupTarget | null> {
  const { db, storage } = options;

  const bundle = await findBundle(db, scope, layout.bundleId);
  if (bundle === null) return null;

  const pages = await listBundlePages(db, scope, layout.bundleId);
  const key = blobKey(bundle.workingPdfBlobSha256);
  const head = await storage.headObject(key);
  const profile = await loadProfileForLayout(db, layout.layoutProfileId);

  return {
    layoutRevisionId: layout.id,
    revisionId: layout.revisionId,
    bundleId: layout.bundleId,
    objectId: layout.objectId,
    state: layout.state,
    detectorProfile: layout.detectorProfile,
    workingPdfSha256: bundle.workingPdfBlobSha256,
    workingPdfKey: key,
    workingPdfSizeBytes: head?.sizeBytes ?? 0,
    pageIndices: pages.map((page) => page.workingPageIndex),
    // Фолбэк берётся из репозитория, а не объявляется здесь второй раз:
    // разошедшиеся значения дали бы флаги, не совпадающие с экраном.
    thresholds: profile?.thresholds ?? FALLBACK_LAYOUT_THRESHOLDS,
    layoutProfileVersion: profile?.version ?? null,
  };
}

function markupDeps(options: PipelineJobsOptions): MarkupDeps {
  const { db, storage } = options;

  return {
    rdweb: options.rdweb ?? null,
    rdProjectId: options.rdProjectId ?? null,
    previewCached: options.previewCached ?? false,

    loadTargetByLayout: async ({ revisionId, layoutRevisionId }) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;
      const layout = await findLayoutRevision(db, scope, layoutRevisionId);
      if (layout === null || layout.revisionId !== revisionId) return null;
      return buildMarkupTarget(options, scope, layout);
    },

    findRunDocument: async (layoutRevisionId) => {
      // Область берётся от ревизии разметки: у `rd_run_documents` собственных
      // денормализованных колонок области нет.
      const layout = await findLayoutRevisionSystemwide(db, layoutRevisionId);
      if (layout === null) return null;
      const scope = await pinScope(db, layout.revisionId);
      if (scope === null) return null;
      const found = await findRunDocument(db, scope, layoutRevisionId);
      return found === null
        ? null
        : {
            rdDocumentId: found.rdDocumentId,
            rdProjectId: found.rdProjectId,
            closed: found.closedAt !== null,
          };
    },

    saveRunDocument: async (input) => {
      const scope = await pinScope(db, input.revisionId);
      if (scope === null) throw new PipelineScopeError('Ревизия исчезла до записи RD-документа.');
      await createRunDocument(db, scope, {
        layoutRevisionId: input.layoutRevisionId,
        rdDocumentId: input.rdDocumentId,
        rdProjectId: input.rdProjectId,
      });
    },

    replaceRunDocument: async (input) => {
      const scope = await pinScope(db, input.revisionId);
      if (scope === null) throw new PipelineScopeError('Ревизия исчезла до замены RD-документа.');
      await replaceRunDocument(db, scope, {
        layoutRevisionId: input.layoutRevisionId,
        rdDocumentId: input.rdDocumentId,
        rdProjectId: input.rdProjectId,
      });
    },

    openWorkingPdf: async (key) => {
      const object = await storage.getObjectStream(key);
      return { stream: () => object.stream, sizeBytes: object.sizeBytes };
    },

    importBlocks: async (input) => {
      const scope = await pinScope(db, input.revisionId);
      if (scope === null) throw new PipelineScopeError('Ревизия исчезла до импорта разметки.');
      const result = await importDetectedBlocks(db, scope, {
        layoutRevisionId: input.layoutRevisionId,
        workingPageIndices: input.workingPageIndices,
        blocks: input.blocks,
        // Провенанс — факт происхождения, а не выдуманная уверенность: ни
        // `confidence`, ни `model_id` в `BlockOut` нет (§0.1).
        provenance: 'rf_detr',
      });
      return { imported: result.imported, skippedPages: result.skippedPages };
    },

    loadPageBlocks: async (input) => {
      const scope = await pinScope(db, input.revisionId);
      if (scope === null) return [];
      const layout = await findLayoutRevision(db, scope, input.layoutRevisionId);
      if (layout === null) return [];

      const [pages, blocks] = await Promise.all([
        listBundlePages(db, scope, layout.bundleId),
        listLayoutBlocks(db, scope, layout.id),
      ]);

      const byPage = new Map<number, PageBlocksSnapshot['blocks'][number][]>();
      for (const block of blocks) {
        const list = byPage.get(block.workingPageIndex);
        const entry = {
          blockType: block.blockType,
          x0: block.x0,
          y0: block.y0,
          x1: block.x1,
          y1: block.y1,
        };
        if (list === undefined) byPage.set(block.workingPageIndex, [entry]);
        else list.push(entry);
      }

      // Страницы берутся из КАРТЫ, а не из набора блоков: страница без единого
      // блока обязана попасть в анализ — она и есть главный кандидат на флаг.
      return pages.map((page) => ({
        workingPageIndex: page.workingPageIndex,
        sourcePageId: page.sourcePageId,
        blocks: byPage.get(page.workingPageIndex) ?? [],
      }));
    },

    saveFlags: async (input) => {
      const scope = await pinScope(db, input.revisionId);
      if (scope === null) return { written: false, reason: 'ревизия исчезла' };
      const outcome = await savePageAttentionFlags(db, scope, {
        revisionId: input.revisionId,
        flags: input.flags,
      });
      return outcome.kind === 'written'
        ? { written: true }
        : { written: false, reason: outcome.reason };
    },

    storePreview: async (input) => {
      const key = previewPageKey(input.bundleId, 'view', input.workingPageIndex);
      await storage.putObject({
        key,
        body: Buffer.from(input.bytes),
        contentType: 'image/png',
        contentLength: input.bytes.byteLength,
      });
    },
  };
}

/**
 * Ревизия разметки без области видимости.
 *
 * Единственное системное чтение задач разметки и ровно в одном месте, как и
 * `SYSTEM_SCOPE` выше: оно отвечает на вопрос «чьей поставке принадлежит эта
 * ревизия разметки», после чего всё идёт закреплённой областью.
 */
async function findLayoutRevisionSystemwide(
  db: Database,
  layoutRevisionId: string,
): Promise<LayoutRevisionView | null> {
  return findLayoutRevision(db, SYSTEM_SCOPE, layoutRevisionId);
}

/**
 * Регистрация задач 1–3 в реестре воркера.
 *
 * Возвращает тот же реестр, чтобы вызов читался в точке входа одной строкой.
 * Повторная регистрация типа — отказ на стороне `JobRegistry`, и это правильно:
 * два места, объявившие один обработчик, — дефект сборки.
 */
export function registerPipelineJobs(
  registry: JobRegistry,
  options: PipelineJobsOptions,
): JobRegistry {
  registry.register('file.verify', createFileVerifyHandler(fileVerifyDeps(options)));
  registry.register(
    'file.signature_probe',
    createSignatureProbeHandler(signatureProbeDeps(options)),
  );
  registry.register('bundle.build', createBundleBuildHandler(bundleBuildDeps(options)));

  // Задачи 4–9 (§12): рабочий документ в RD WEB, рендер, синхронная
  // постраничная детекция, флаги внимания и кэш превью. Регистрируются здесь и
  // безусловно: обработчик без регистрации — это задача, которая вечно ждёт в
  // очереди воркера, который её «умеет», и выглядит как зависший конвейер.
  const markup = markupDeps(options);
  registry.register('rd.create_run_document', createRunDocumentHandler(markup));
  registry.register('rd.upload_working_pdf', createUploadWorkingPdfHandler(markup));
  registry.register('rd.wait_pages', createWaitPagesHandler(markup, options.waitPages ?? {}));
  registry.register('layout.detect_pages', createDetectPagesHandler(markup));
  registry.register('layout.analyze_coverage', createAnalyzeCoverageHandler(markup));
  registry.register('preview.cache_pages', createPreviewCacheHandler(markup));
  return registry;
}

/**
 * Полный реестр воркера: обслуживание плюс стадии конвейера.
 *
 * Отдельная функция, а не пять строк в `main.ts`, ровно по причине S3: состав
 * реестра — это то, что процесс УМЕЕТ делать, и проверяться он обязан прогоном,
 * а не вычиткой точки входа. Внутри `main.ts` то же самое было бы недостижимо
 * для теста, потому что вызвать его значит поднять пул, метрики и захват задач.
 */
export function createWorkerRegistry(options: PipelineJobsOptions): JobRegistry {
  return registerPipelineJobs(createMaintenanceRegistry(), options);
}
