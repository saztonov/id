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
  artifactKey,
  blobKey,
  closeRunDocument,
  createBundle,
  createMaintenanceRegistry,
  createRunDocument,
  evaluatePdfFile,
  FALLBACK_LAYOUT_THRESHOLDS,
  findArtifact,
  findBundle,
  findBundleByManifest,
  findFileContent,
  findLayoutRevision,
  findRecognitionRun,
  findRevisionForFiles,
  findRunDocument,
  finishRecognitionRun,
  importDetectedBlocks,
  listBundlePages,
  listLayoutBlocks,
  loadBundlePlan,
  loadProfileForLayout,
  previewPageKey,
  probePdf,
  recordArtifact,
  replaceRunDocument,
  saveFileVerdict,
  savePageAttentionFlags,
  saveRdJobId,
  saveRecognitionResults,
  saveRemoteHashBefore,
  saveSignatureProbe,
  sha256Hex,
  storableVerdict,
  applySegmentation,
  createAiSpendReader,
  createLlmProvider,
  listFieldValues,
  listLogicalDocuments,
  listPageAssignments,
  listPageClassifications,
  listPromptTemplates,
  listRegistryRows,
  loadSegmentationPages,
  observeDocTypeCandidate,
  recordAiRun,
  savePageClassifications,
  saveDocumentRelations,
  saveFieldValues,
  saveRegistryMatches,
  saveRegistryRows,
  type AuthScope,
  type Database,
  type Env,
  type JobRegistry,
  type LlmPort,
  type LlmStage,
  type LayoutRevisionView,
  type PdfToolkit,
  type RdWebPort,
  type RecognitionSelection,
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
  createFetchExportHandler,
  createPollRecognitionHandler,
  createReconcileHandler,
  createStartRecognitionHandler,
  type LocalBlock,
  type PollRecognitionOptions,
  type RecognitionDeps,
} from './recognition.js';
import {
  createClassifyPagesHandler,
  createExtractFieldsHandler,
  createGraphBuildHandler,
  createMatchRegistryHandler,
  createParseRegistryHandler,
  createSegmentHandler,
  SEGMENTATION_VERSION,
  type PublishedPrompt,
  type SegmentationDeps,
} from './segmentation.js';
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
  /** Настройки поллинга распознавания; в тестах ускоряются. */
  readonly pollRecognition?: PollRecognitionOptions | undefined;
  /** Выбор провайдера/модели/профиля OCR на тип блока (§10). */
  readonly recognitionSelections?: readonly RecognitionSelection[] | undefined;
  /** Режим документа RD WEB; по умолчанию выключен (см. `RecognitionDeps`). */
  readonly recognitionDocumentMode?: boolean | undefined;
  /**
   * Провайдер модели для фазы 2 сегментации (§8.2, §10).
   *
   * `null` и отсутствие значения — РАЗНОЕ. `undefined` означает «собери из
   * окружения», `null` — «модели нет намеренно», и во втором случае фаза 2
   * пропускается с названной причиной, а не падает: система обязана работать
   * на якорных правилах без внешней модели (§0.5).
   */
  readonly llm?: LlmPort | null | undefined;
  /** Окружение: нужно фабрике провайдера модели. Без него провайдер не собирается. */
  readonly env?: Env | undefined;
  /** Журнал и метрики для провайдера модели; в тестах подменяются. */
  readonly llmLogger?: Parameters<typeof createLlmProvider>[1]['logger'] | undefined;
  readonly llmMetrics?: Parameters<typeof createLlmProvider>[1]['metrics'] | undefined;
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

// =====================================================================
// Порты задач 10–13 (распознавание)
// =====================================================================

/**
 * Область прогона распознавания.
 *
 * Та же дисциплина, что у задач разметки: `revisionId` из payload разрешается
 * системным чтением ровно ради подрядчика, а сам прогон, его блоки, артефакты и
 * результаты читаются и пишутся уже закреплённой областью. Payload, назвавший
 * чужой прогон, не находит его вовсе — `findRecognitionRun` фильтрует областью.
 */
function recognitionDeps(options: PipelineJobsOptions): RecognitionDeps {
  const { db, storage } = options;

  /** Область прогона: одна функция на все методы, чтобы её нельзя было забыть. */
  const scopeOf = async (revisionId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, revisionId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${revisionId} не найдена: прогон адресован в никуда.`);
    }
    return scope;
  };

  /**
   * Область по идентификатору прогона.
   *
   * Прогон адресуется своим uuid, а ревизия у него денормализована, поэтому
   * одного системного чтения не избежать — оно ровно одно и здесь.
   */
  const scopeOfRun = async (runId: string): Promise<{ scope: AuthScope; revisionId: string }> => {
    const run = await findRecognitionRun(db, SYSTEM_SCOPE, runId);
    if (run === null) throw new PipelineScopeError(`Прогон ${runId} не найден.`);
    return { scope: await scopeOf(run.revisionId), revisionId: run.revisionId };
  };

  return {
    rdweb: options.rdweb ?? null,
    selections: options.recognitionSelections ?? [],
    documentMode: options.recognitionDocumentMode ?? false,
    sha256: (bytes) => sha256Hex(bytes),

    loadRun: async ({ revisionId, recognitionRunId }) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;
      const run = await findRecognitionRun(db, scope, recognitionRunId);
      // Сверка ревизии в payload с ревизией прогона: задача, поставленная с
      // чужим прогоном, не находит его через область, а задача с прогоном
      // соседней ревизии того же подрядчика отсекается здесь.
      if (run === null || run.revisionId !== revisionId) return null;
      return {
        runId: run.id,
        revisionId: run.revisionId,
        layoutRevisionId: run.layoutRevisionId,
        status: run.status,
        rdDocumentId: run.rdDocumentId,
        rdJobId: run.rdJobId,
        localLayoutHash: run.localLayoutHash,
        remoteLayoutHashBefore: run.remoteLayoutHashBefore,
        runDocumentClosed: run.runDocumentClosedAt !== null,
      };
    },

    loadFrozenBlocks: async (runId): Promise<readonly LocalBlock[]> => {
      const { scope } = await scopeOfRun(runId);
      const run = await findRecognitionRun(db, scope, runId);
      if (run === null) return [];
      const blocks = await listLayoutBlocks(db, scope, run.layoutRevisionId);
      return blocks.map((block) => ({
        id: block.id,
        workingPageIndex: block.workingPageIndex,
        blockType: block.blockType,
        shapeType: block.shapeType,
        x0: block.x0,
        y0: block.y0,
        x1: block.x1,
        y1: block.y1,
        sortOrder: block.sortOrder,
        points: block.points.map((point) => ({ x: point.x, y: point.y })),
      }));
    },

    saveRemoteHashBefore: async (runId, remoteHash) => {
      const { scope } = await scopeOfRun(runId);
      await saveRemoteHashBefore(db, scope, runId, remoteHash);
    },

    saveRdJobId: async (runId, rdJobId) => {
      const { scope } = await scopeOfRun(runId);
      await saveRdJobId(db, scope, runId, rdJobId);
    },

    finishRun: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      return finishRecognitionRun(db, scope, input);
    },

    findArtifact: async (runId, kind) => {
      const { scope } = await scopeOfRun(runId);
      const artifact = await findArtifact(db, scope, runId, kind);
      return artifact === null
        ? null
        : {
            kind: artifact.kind,
            artifactSha256: artifact.artifactSha256,
            byteSize: artifact.byteSize,
          };
    },

    recordArtifact: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      const outcome = await recordArtifact(db, scope, {
        recognitionRunId: input.runId,
        kind: input.kind,
        artifactSha256: input.artifactSha256,
        byteSize: input.byteSize,
      });
      return { kind: outcome.kind, artifactSha256: outcome.artifact.artifactSha256 };
    },

    artifactId: async (runId, kind) => {
      const { scope } = await scopeOfRun(runId);
      const artifact = await findArtifact(db, scope, runId, kind);
      if (artifact === null) {
        throw new PipelineScopeError(`Артефакт ${kind} прогона ${runId} не записан.`);
      }
      return artifact.id;
    },

    readArtifactBytes: async (runId, kind) => {
      const key = artifactKey(runId, kind);
      const head = await storage.headObject(key);
      if (head === null) return null;
      return readStorageObject(storage, key, MAX_ARTIFACT_BYTES);
    },

    writeArtifactBytes: async ({ runId, kind, bytes, contentType }) => {
      await storage.putObject({
        key: artifactKey(runId, kind),
        body: Buffer.from(bytes),
        contentType,
        contentLength: bytes.byteLength,
      });
    },

    saveResults: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      return saveRecognitionResults(db, scope, {
        recognitionRunId: input.runId,
        artifactVersionId: input.artifactVersionId,
        pages: input.pages,
        blocks: input.blocks,
      });
    },

    closeRunDocument: async (layoutRevisionId) => {
      const layout = await findLayoutRevisionSystemwide(db, layoutRevisionId);
      if (layout === null) {
        throw new PipelineScopeError(`Ревизия разметки ${layoutRevisionId} не найдена.`);
      }
      const scope = await scopeOf(layout.revisionId);
      const result = await closeRunDocument(db, scope, layoutRevisionId);
      return { changed: result.changed };
    },
  };
}

/**
 * Связывание задач 14–19 с базой, каталогом и провайдером модели (§8).
 *
 * Та же дисциплина, что у остальных стадий: ровно одно системное чтение ради
 * определения подрядчика ревизии (`pinScope`), после чего ВСЁ идёт закреплённой
 * областью. Задача, поставленная с чужой ревизией в payload, не находит её
 * вовсе; собственных запросов к БД этот модуль не делает — только вызовы
 * репозиториев, потому что иначе правило «прямой запрос вне `db/repositories/`
 * запрещён» держалось бы аккуратностью, а не eslint'ом.
 */
function segmentationDeps(options: PipelineJobsOptions): SegmentationDeps {
  const db = options.db;

  const scopeOf = async (revisionId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, revisionId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${revisionId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  /**
   * Провайдер модели.
   *
   * Собирается ОДИН раз на реестр, а не на задачу: кэш ответов и скользящее
   * окно лимита частоты живут внутри провайдера, и пересоздание на каждую
   * задачу обнуляло бы оба — то есть оплачивало бы повторно каждую страницу
   * при повторе задачи и делало бы лимит частоты декоративным.
   *
   * Бюджет читается областью АДМИНИСТРАТОРА: `LLM_BUDGET_MONTHLY` — потолок
   * портала, а не подрядчика. Областью подрядчика он считал бы только его
   * собственные траты, и потолок стал бы кратным числу подрядчиков.
   */
  const llm: LlmPort | null =
    options.llm !== undefined
      ? options.llm
      : options.env !== undefined &&
          options.llmLogger !== undefined &&
          options.llmMetrics !== undefined
        ? createLlmProvider(options.env, {
            metrics: options.llmMetrics,
            logger: options.llmLogger,
            spend: createAiSpendReader(db, SYSTEM_SCOPE),
          })
        : null;

  return {
    loadPages: async (revisionId) =>
      loadSegmentationPages(db, await scopeOf(revisionId), revisionId),

    savePageClassifications: async (input) =>
      savePageClassifications(db, await scopeOf(input.revisionId), input),

    listPageClassifications: async (revisionId) =>
      listPageClassifications(db, await scopeOf(revisionId), revisionId),

    applySegmentation: async (input) =>
      applySegmentation(db, await scopeOf(input.revisionId), {
        revisionId: input.revisionId,
        documents: input.segmentation.documents,
        unassigned: input.segmentation.unassigned,
        extractorVersion: SEGMENTATION_VERSION,
      }),

    listDocuments: async (revisionId) =>
      listLogicalDocuments(db, await scopeOf(revisionId), revisionId),

    listPageAssignments: async (revisionId) =>
      listPageAssignments(db, await scopeOf(revisionId), revisionId),

    listFieldValues: async (documentId) => listFieldValues(db, SYSTEM_SCOPE, documentId),

    saveFieldValues: async (input) => saveFieldValues(db, await scopeOf(input.revisionId), input),

    saveRegistryRows: async (input) => saveRegistryRows(db, await scopeOf(input.revisionId), input),

    listRegistryRows: async (revisionId) =>
      listRegistryRows(db, await scopeOf(revisionId), revisionId),

    saveRegistryMatches: async (input) =>
      saveRegistryMatches(db, await scopeOf(input.revisionId), input),

    saveDocumentRelations: async (input) =>
      saveDocumentRelations(db, await scopeOf(input.revisionId), input),

    observeCandidate: async (input) => {
      const outcome = await observeDocTypeCandidate(db, await scopeOf(input.revisionId), input);
      return { created: outcome.created, occurrences: outcome.occurrences };
    },

    /**
     * Опубликованный промт стадии.
     *
     * Двух опубликованных промтов одной стадии быть не должно, и «взять
     * первый» здесь запрещено: выбор между ними определял бы результат
     * классификации молча. Уникальный индекс БД гарантирует один
     * опубликованный промт на КОД, но не на стадию, поэтому проверка здесь
     * настоящая, а не удвоение ограничения.
     */
    publishedPrompt: async (stage): Promise<PublishedPrompt | null> => {
      const page = await listPromptTemplates(db, SYSTEM_SCOPE, {
        stage,
        state: 'published',
        limit: 10,
      });
      if (page.items.length === 0) return null;
      if (page.items.length > 1) {
        throw new PipelineScopeError(
          `Стадия ${stage}: опубликовано ${page.items.length} промтов; ` +
            'какой из них применять — не решает конвейер.',
        );
      }
      const row = page.items[0];
      if (row === undefined) return null;
      return {
        code: row.code,
        version: row.version,
        systemPrompt: row.systemPrompt,
        userTemplate: row.userTemplate,
        modelOverride: row.modelOverride,
      };
    },

    callLlm:
      llm === null
        ? null
        : async (input) => {
            const response = await llm.complete({
              stage: input.stage as LlmStage,
              promptCode: input.promptCode,
              promptVersion: input.promptVersion,
              systemPrompt: input.systemPrompt,
              userPrompt: input.userPrompt,
              schemaVersion: input.schemaVersion,
              cacheContext: input.cacheContext,
              ...(input.model !== undefined ? { model: input.model } : {}),
            });
            return {
              text: response.text,
              model: response.model,
              provider: response.provider,
              inputHash: response.inputHash,
              outputHash: response.outputHash,
              tokensIn: response.tokensIn,
              tokensOut: response.tokensOut,
              cost: response.cost,
              latencyMs: response.latencyMs,
              cacheHit: response.cacheHit,
            };
          },

    recordAiRun: async (input) => {
      await recordAiRun(db, await scopeOf(input.revisionId), input);
    },
  };
}

/**
 * Потолок чтения артефакта в память.
 *
 * Экспорт — это md/html/qa по нескольким сотням блоков, а не рабочий PDF:
 * десятки мегабайт против восьмидесяти. Потолок здесь тот же по смыслу, что и
 * у приёма файлов (§4.2), и защищает ровно от того же — от объекта, который
 * «весит» не столько, сколько заявляет.
 */
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

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

  // Задачи 10–13 (§12): цикл сверки, запуск OCR, поллинг и однократный забор
  // экспорта. Регистрируются здесь и безусловно — по той же причине, что и
  // задачи разметки: обработчик без регистрации выглядит зависшим конвейером.
  const recognition = recognitionDeps(options);
  registry.register('layout.reconcile', createReconcileHandler(recognition));
  registry.register('rd.start_recognition', createStartRecognitionHandler(recognition));
  registry.register(
    'rd.poll_recognition',
    createPollRecognitionHandler(recognition, options.pollRecognition ?? {}),
  );
  registry.register('rd.fetch_export_once', createFetchExportHandler(recognition));

  // Задачи 14–19 (§12): классификация страниц, сборка документов, реквизиты,
  // реестр приложений, сверка и граф. Регистрируются здесь и безусловно — по
  // той же причине, что и остальные стадии: обработчик без регистрации
  // выглядит зависшим конвейером, а не отсутствующей возможностью.
  const segmentation = segmentationDeps(options);
  registry.register('doc.classify_pages', createClassifyPagesHandler(segmentation));
  registry.register('doc.segment', createSegmentHandler(segmentation));
  registry.register('doc.extract_fields', createExtractFieldsHandler(segmentation));
  registry.register('doc.parse_registry', createParseRegistryHandler(segmentation));
  registry.register('doc.match_registry', createMatchRegistryHandler(segmentation));
  registry.register('graph.build', createGraphBuildHandler(segmentation));
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
