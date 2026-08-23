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
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  assembleRecognitionResult,
  insertBlockResultIdempotent,
  listRunBlockEnvelopes,
  listRunBlockIds,
  listRunPages,
  markRunPage,
  mergeRunSettingsSnapshot,
  publishVlmRunResults,
  RECOGNITION_PROMPT_DEFAULTS,
  recognizeBlock,
  schemaHash,
  seedRunPages,
  NoopProcessingFeedbackSink,
  type ProcessingFeedbackSink,
  type VlmPort,
} from '@id/api';

import {
  archiveKey,
  artifactKey,
  blobKey,
  closeRunDocument,
  documentPdfKey,
  findArchive,
  findReusableBundle,
  loadArchivePlan,
  loadMaterializationPlan,
  recordArchive,
  requireVisibleRevisionOfDocument,
  saveDerivedPdf,
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
  listBundles,
  listLayoutBlocks,
  loadBundlePlan,
  loadProfileForLayout,
  startMarkupOnBundle,
  previewPageKey,
  probePdf,
  readDetectionSettings,
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
  appendRevisionEvent,
  findCounterparty,
  findRegistry,
  findRegistryFile,
  listDocumentsOfRevisions,
  listFieldValuesOfRevisions,
  listRegistryComplectRevisions,
  saveReconciliation,
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
  type PageRasterizer,
  type PdfToolkit,
  type RdWebPort,
  type RecognitionSelection,
  type ReviewDocument,
  type StorageProvider,
  finishValidationRun,
  listFindings,
  listRuleDefinitionCodes,
  loadActiveRulesetSnapshot,
  loadCheckGraph,
  loadRunJournal,
  saveDerivedMaterials,
  saveFindings,
  saveLlmFindings,
  saveRunJournal,
  startValidationRun,
} from '@id/api';

import {
  createBundleBuildHandler,
  type BundleBuildDeps,
  type BundlePlan,
  type StoredWorkingPdf,
} from './bundle-build.js';
import {
  createCatalogImportExpireHandler,
  createCatalogImportParseHandler,
} from './catalog-import.js';
import {
  createFileVerifyHandler,
  type FileForVerification,
  type FileJobTarget,
  type FileVerifyDeps,
} from './file-verify.js';
import { createSignatureProbeHandler, type SignatureProbeDeps } from './signature-probe.js';
import {
  createBuildArchiveHandler,
  createMaterializePdfHandler,
  type ArchiveDeps,
  type MaterializeDeps,
} from './delivery.js';
import { createInternalRegistryProviders } from '@id/rules';
import { createChecksRunHandler, createChecksSummarizeHandler, type ChecksDeps } from './checks.js';
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
  createRegistryReconcileHandler,
  type RegistryReconcileDeps,
} from './registry-reconcile.js';
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
import { createLocalDetectionHandler, type LocalDetectionDeps } from './local-detection.js';
import { createLayoutStartHandler, type LayoutStartDeps } from './layout-start.js';
import { createChecksLlmReviewHandler, type ChecksLlmReviewDeps } from './checks-llm-review.js';
import { createModelStore } from '../detection/model-store.js';
import {
  DEFAULT_INTER_OP_THREADS,
  DEFAULT_INTRA_OP_THREADS,
  OnnxRuntimeSession,
} from '../detection/session.js';
import {
  createVlmFinalizeHandler,
  createVlmRecognizePageHandler,
  createVlmStartHandler,
  type VlmRecognitionDeps,
} from './vlm-recognition.js';
import { cropBlockPng, downscalePng } from '../vlm/crop.js';

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
 *
 * Экспортирована ради `main.ts`: расходомер бюджета VLM-провайдера
 * (`createAiSpendReader`) строится при старте процесса, вместе с
 * `toolkit`/`rasterizer`/`rdweb` — тем же местом, что и остальные
 * startup-зависимости (ADR-0007), а не второй копией нулевого uuid.
 */
export const SYSTEM_SCOPE: AuthScope = { kind: 'admin', userId: WORKER_ACTOR_ID };

const PDF_CONTENT_TYPE = 'application/pdf';
const ZIP_CONTENT_TYPE = 'application/zip';

export interface PipelineLimits {
  /** Потолок размера одного исходного файла (`MAX_UPLOAD_BYTES`). */
  readonly maxBytes: number;
  /** Потолок числа страниц (`MAX_PAGES_PER_FILE`). */
  readonly maxPages: number;
}

export interface PipelineJobsOptions {
  readonly db: Database;
  readonly storage: StorageProvider;
  /**
   * Приёмник дефектов качества конвейера (§11, ADR-0010).
   *
   * Не задан — записи не ведутся: в тестах и на локальном запуске без БД это
   * честнее, чем молча писать в никуда. В боевом воркере задаётся всегда:
   * ряд начинается тогда, когда включён сбор, и задним числом не
   * восстанавливается.
   */
  readonly feedback?: ProcessingFeedbackSink | undefined;
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
  /**
   * Растеризатор PDF→PNG для локальной детекции (ADR-0008), выбранный
   * startup-проверкой `selectRasterizer()` в `main.ts` — тем же паттерном,
   * что и `toolkit` (ADR-0003). `null` — на машине нет `pdftoppm`:
   * `layout.detect_local` отказывает честно, остальной конвейер не страдает.
   */
  readonly rasterizer?: PageRasterizer | null | undefined;
  /**
   * Каталог кэша весов локальной модели детекции на диске воркера.
   *
   * По умолчанию подкаталог `workDirBase` (или системного tmpdir) — веса
   * переживают job, но не обязаны переживать перезапуск процесса: при
   * следующем старте `model-store.ts` перекачает и заново сверит sha256.
   */
  readonly detectionCacheDir?: string | undefined;
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
  /**
   * Порт VLM-распознавания (ADR-0007). `null`/отсутствие — обе задачи
   * `vlm.*`, которым он нужен, честно отказывают `VlmRecognitionConfigurationError`
   * (тот же принцип, что у `rasterizer`/`rdweb`: опциональная ветка не роняет
   * процесс). `createVlmProvider()` сама по себе НЕ бросает при
   * `LLM_PROVIDER=none|rdweb` — она возвращает объект, честно отказывающий на
   * первом вызове `.complete()`; `null` здесь — путь для тестов и для явного
   * «не собирали вовсе».
   */
  readonly vlm?: VlmPort | null | undefined;
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

    findReusableWorkingPdf: async (target) => {
      const scope = await pinScope(db, target.revisionId);
      if (scope === null) return null;
      const reusable = await findReusableBundle(db, scope, target);
      if (reusable === null) return null;
      return {
        revisionId: reusable.revisionId,
        workingPdfBlobSha256: reusable.workingPdfBlobSha256,
        sizeBytes: reusable.sizeBytes,
        s3Key: blobKey(reusable.workingPdfBlobSha256),
        pageCount: reusable.pageCount,
      };
    },

    workingPdfExists: async (storageKey) => (await storage.headObject(storageKey)) !== null,

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
// Порт задачи `layout.detect_local` (детекция RF-DETR на CPU, ADR-0008)
// =====================================================================

/**
 * Хранилище модели детекции — ОДНО на реестр задач, не на job.
 *
 * `ensureModel()` кэширует ONNX-сессию по версии в памяти процесса и
 * защищает параллельную загрузку single-flight'ом (`model-store.ts`);
 * пересоздание стора на каждую задачу обнулило бы оба — то есть каждая
 * страница комплекта грузила бы веса заново, а очередь cpu с конкуренцией
 * 1–2 не спасала бы от гонки при рестарте.
 *
 * Потоки ONNX Runtime берутся из `ORT_INTRA_OP_THREADS`/`ORT_INTER_OP_THREADS`
 * (`options.env`), при отсутствии окружения — из дефолтов `session.ts` (2/1):
 * тот же паттерн, что у `llm` в `segmentationDeps` — окружение опционально,
 * функциональность деградирует к безопасным значениям, а не падает.
 */
/**
 * Звено «сборка → разметка» (S21).
 *
 * Область — закреплённая за подрядчиком ревизии (`pinScope`), как у всей
 * разметки: задача правит ПРОИЗВОДНОЕ этой поставки и ничего за её пределами не
 * читает. Расширять её до объектной, как это сделано у сверки описи, здесь не
 * нужно и вредно — вход у задачи ровно один, и он свой.
 */
function layoutStartDeps(options: PipelineJobsOptions): LayoutStartDeps {
  const { db } = options;

  return {
    start: async ({ revisionId, logger }) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;

      // Последний рабочий документ, а не «тот, что собрала породившая задача»:
      // между сборкой и этой задачей состав мог смениться, и размечать надо то,
      // что в ревизии сейчас. Пустой список означает, что bundle успели убрать.
      const bundles = await listBundles(db, scope, revisionId);
      const bundle = bundles[bundles.length - 1];
      if (bundle === undefined) return null;

      const started = await startMarkupOnBundle(db, scope, {
        revisionId,
        bundleId: bundle.id,
        previewCached: options.previewCached ?? false,
        logger,
      });
      return {
        layoutRevisionId: started.layoutRevisionId,
        bundleId: started.bundleId,
        provider: started.provider,
        jobsEnqueued: started.jobIds.length,
        // Причина пропуска попадает в результат задачи, а не только в её
        // журнал: консоль задач показывает именно результат, и «поставлено 0
        // задач» без объяснения выглядит сбоем сборки, а не ненастроенной
        // моделью.
        detectionSkipReason: started.detectionSkipReason,
      };
    },
  };
}

function localDetectionDeps(options: PipelineJobsOptions): LocalDetectionDeps {
  const { db, storage } = options;

  const cacheDir =
    options.detectionCacheDir ?? join(options.workDirBase ?? tmpdir(), 'detection-models');

  const modelStore = createModelStore({
    storage,
    cacheDir,
    createSession: (onnxPath, sessionOptions) =>
      OnnxRuntimeSession.create(onnxPath, sessionOptions),
    sessionOptions: {
      intraOpNumThreads: options.env?.ORT_INTRA_OP_THREADS ?? DEFAULT_INTRA_OP_THREADS,
      interOpNumThreads: options.env?.ORT_INTER_OP_THREADS ?? DEFAULT_INTER_OP_THREADS,
    },
  });

  return {
    rasterizer: options.rasterizer ?? null,
    modelStore,
    ...(options.workDirBase !== undefined ? { workDirBase: options.workDirBase } : {}),
    // Тот же приёмник, что у распознавания: страница без блоков — сигнал о
    // качестве обработки (поток C, ADR-0010), а не отказ задачи.
    feedback: options.feedback ?? new NoopProcessingFeedbackSink(),

    loadTargetByLayout: async ({ revisionId, layoutRevisionId }) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;
      const layout = await findLayoutRevision(db, scope, layoutRevisionId);
      if (layout === null || layout.revisionId !== revisionId) return null;
      return buildMarkupTarget(options, scope, layout);
    },

    detectionSettings: async () => {
      const settings = await readDetectionSettings(db);
      // Ручки качества передаются целиком: решение, что из них реально меняет
      // параметры модели, принимает `applyParamOverrides` в обработчике — там
      // же, где виден манифест, поверх которого они кладутся.
      return {
        modelVersion: settings.modelVersion,
        inferenceMode: settings.inferenceMode,
        overrides: settings.overrides,
      };
    },

    pageGeometry: async ({ revisionId, bundleId }) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return [];
      return listBundlePages(db, scope, bundleId);
    },

    // Любой существующий блок (авто ИЛИ ручной) — сигнал «страницу уже
    // размечали»: skip без overwriteExisting экономит рендер+инференс на
    // странице, которую всё равно не тронет `importBlocks` (авто) или которую
    // он безусловно защищает (ручной, `pagesWithManualBlocks`).
    existingBlockPages: async ({ revisionId, layoutRevisionId }) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return new Set();
      const blocks = await listLayoutBlocks(db, scope, layoutRevisionId);
      return new Set(blocks.map((block) => block.workingPageIndex));
    },

    fetchWorkingPdf: (key, destinationPath) => fetchOriginal(storage, key, destinationPath),

    importBlocks: async (input) => {
      const scope = await pinScope(db, input.revisionId);
      if (scope === null) {
        throw new PipelineScopeError('Ревизия исчезла до импорта локальной детекции.');
      }
      const result = await importDetectedBlocks(db, scope, {
        layoutRevisionId: input.layoutRevisionId,
        workingPageIndices: input.workingPageIndices,
        blocks: input.blocks,
        // Провенанс локального детектора — отдельное значение от легаси
        // `rd_detr`... то есть в точности `rf_detr`, как и у RD WEB (§0.1):
        // портал переиспользует ОДНУ и ту же модель детекции, менялся только
        // способ инференса (локально vs через RD WEB), а не архитектура сети.
        provenance: 'rf_detr',
      });
      return { imported: result.imported, skippedPages: result.skippedPages };
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
      // Легаси-задачи rd.* без RD-документа не работают по построению; прогон
      // ветки VLM (rd_run_document_id NULL, ADR-0007) сюда попасть не должен —
      // его ставит vlm.start_recognition, а не layout.reconcile. Если попал,
      // честный null: задача откажет «прогон не найден», а не полезет в RD WEB
      // с пустым идентификатором.
      if (run.rdDocumentId === null) return null;
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

// =====================================================================
// Порты задач `vlm.*` (распознавание через OpenRouter VLM, ADR-0007)
// =====================================================================

/**
 * Связывание трёх задач `vlm.*` (`vlm-recognition.ts`) с базой, хранилищем,
 * порядка правами и VLM-портом.
 *
 * Та же дисциплина, что у `recognitionDeps`: `revisionId`/`runId` из payload
 * разрешаются закреплённой областью, а не системной, — payload с чужим
 * прогоном не находит его вовсе. Отличие от `recognitionDeps` только в
 * наборе полей: у VLM-прогона нет ни RD-документа, ни удалённых хэшей, зато
 * есть таблица `recognition_run_pages`, растеризатор и порт `VlmPort`.
 */
function vlmRecognitionDeps(options: PipelineJobsOptions): VlmRecognitionDeps {
  const { db, storage } = options;

  const scopeOf = async (revisionId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, revisionId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${revisionId} не найдена: прогон адресован в никуда.`);
    }
    return scope;
  };

  const scopeOfRun = async (runId: string): Promise<{ scope: AuthScope; revisionId: string }> => {
    const run = await findRecognitionRun(db, SYSTEM_SCOPE, runId);
    if (run === null) throw new PipelineScopeError(`Прогон ${runId} не найден.`);
    return { scope: await scopeOf(run.revisionId), revisionId: run.revisionId };
  };

  /**
   * Геометрия страниц bundle этого прогона.
   *
   * `layoutRevisionId` прогона резолвится в `bundleId` СИСТЕМНЫМ чтением
   * ревизии разметки (тот же приём, что `closeRunDocument` в
   * `recognitionDeps`) — сама ревизия разметки не денормализует подрядчика, а
   * `listBundlePages` дальше идёт уже закреплённой областью прогона.
   */
  const loadGeometry = async (
    scope: AuthScope,
    layoutRevisionId: string,
  ): ReturnType<VlmRecognitionDeps['loadPageGeometry']> => {
    const layout = await findLayoutRevisionSystemwide(db, layoutRevisionId);
    if (layout === null) return [];
    return listBundlePages(db, scope, layout.bundleId);
  };

  return {
    vlm: options.vlm ?? null,
    rasterizer: options.rasterizer ?? null,
    sha256: (bytes) => sha256Hex(bytes),

    loadRun: async ({ revisionId, recognitionRunId }) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;
      const run = await findRecognitionRun(db, scope, recognitionRunId);
      if (run === null || run.revisionId !== revisionId) return null;
      return {
        runId: run.id,
        revisionId: run.revisionId,
        layoutRevisionId: run.layoutRevisionId,
        status: run.status,
        localLayoutHash: run.localLayoutHash,
        settingsSnapshot: run.settingsSnapshot,
      };
    },

    loadFrozenBlocks: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      const run = await findRecognitionRun(db, scope, runId);
      if (run === null) return [];
      const blocks = await listLayoutBlocks(db, scope, run.layoutRevisionId);
      return blocks.map((block) => ({
        id: block.id,
        workingPageIndex: block.workingPageIndex,
        blockType: block.blockType,
        shapeType: block.shapeType,
        coordsNorm: [block.x0, block.y0, block.x1, block.y1],
        sortOrder: block.sortOrder,
        polygon:
          block.shapeType === 'polygon'
            ? block.points.map((point): readonly [number, number] => [point.x, point.y])
            : null,
      }));
    },

    loadPageGeometry: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      const run = await findRecognitionRun(db, scope, runId);
      if (run === null) return [];
      return loadGeometry(scope, run.layoutRevisionId);
    },

    seedRunPages: async (runId, pages) => {
      const { scope } = await scopeOfRun(runId);
      await seedRunPages(db, scope, runId, pages);
    },

    markRunPage: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      await markRunPage(db, scope, input);
    },

    listRunPages: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      return listRunPages(db, scope, runId);
    },

    existingBlockIds: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      return listRunBlockIds(db, scope, runId);
    },

    insertBlockResult: async (input) => {
      const { scope } = await scopeOfRun(input.recognitionRunId);
      return insertBlockResultIdempotent(db, scope, input);
    },

    listBlockEnvelopes: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      return listRunBlockEnvelopes(db, scope, runId);
    },

    publishResults: async (input) => {
      const { scope } = await scopeOfRun(input.recognitionRunId);
      return publishVlmRunResults(db, scope, input);
    },

    mergeSnapshot: async (runId, patch) => {
      const { scope } = await scopeOfRun(runId);
      await mergeRunSettingsSnapshot(db, scope, runId, patch);
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

    /**
     * Опубликованный промпт по коду (не по стадии, в отличие от сегментации):
     * `ux_prompt_templates_single_published` гарантирует не больше одной
     * опубликованной версии на код, поэтому неоднозначности здесь нет.
     */
    publishedPromptByCode: async (code) => {
      const page = await listPromptTemplates(db, SYSTEM_SCOPE, {
        code,
        state: 'published',
        limit: 1,
      });
      const row = page.items[0];
      if (row === undefined) return null;
      return {
        code: row.code,
        version: row.version,
        systemPrompt: row.systemPrompt,
        userTemplate: row.userTemplate,
        outputSchema: row.outputSchema,
        modelOverride: row.modelOverride,
      };
    },

    /** Параметры генерации и `responseFormat` по типу блока — чистые данные, без БД. */
    generationProfile: (blockType) => {
      const defaults = RECOGNITION_PROMPT_DEFAULTS[blockType];
      return {
        code: defaults.code,
        temperature: defaults.temperature,
        maxTokens: defaults.maxTokens,
        topK: defaults.topK,
        responseFormat: defaults.responseFormat,
        schemaVersion: schemaHash(defaults.responseFormat.schema),
      };
    },

    recognizeBlock: (input) => recognizeBlock(input),

    /**
     * Рабочий PDF прогона на диске — материализуется под каждый вызов задачи,
     * а не кэшируется между блоками: `vlm.recognize_page` вызывается один раз
     * на страницу, и файл нужен ровно на время её обработки.
     */
    workingPdfToFile: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      const run = await findRecognitionRun(db, scope, runId);
      if (run === null) throw new PipelineScopeError(`Прогон ${runId} не найден.`);
      const dir = await mkdtemp(join(options.workDirBase ?? tmpdir(), 'id-vlm-pdf-'));
      const path = join(dir, 'working.pdf');
      await fetchOriginal(storage, blobKey(run.workingPdfSha256), path);
      return {
        path,
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    },

    crop: (input) => cropBlockPng(input),
    downscale: (png) => downscalePng(png),

    assemble: (input) => assembleRecognitionResult(input),

    recordAiRun: async (input) => {
      await recordAiRun(db, await scopeOf(input.revisionId), input);
    },

    // Дефекты качества: непригодный ответ модели и отказ. По умолчанию
    // приёмник пустой — запуск без БД не обязан вести набор данных, и
    // отсутствующий приёмник честнее записи в никуда.
    feedback: options.feedback ?? new NoopProcessingFeedbackSink(),
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
/**
 * Порты задач 20–21.
 *
 * Провайдеры внешних реестров собираются один раз на реестр задач: в MVP это
 * `internal` без источников данных (§9.5), и пересоздавать их на каждую задачу
 * незачем. Параметра «подставь свои провайдеры» здесь НЕТ намеренно: он был,
 * не использовался ни одним вызовом и оправдывался в докстринге подменой в
 * тестах, которой не существовало. Когда появится реальный источник, он
 * соберётся здесь же из `env` — тем же способом, что и провайдер модели, — а
 * шов для тестов остаётся там, где он живой: `ChecksDeps.registries`, через
 * который `resolveExternalRegistries` получает провайдеров в `checks.ts`.
 */
function checksDeps(options: PipelineJobsOptions): ChecksDeps {
  const db = options.db;

  const scopeOf = async (revisionId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, revisionId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${revisionId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  return {
    loadGraph: async (input) => loadCheckGraph(db, await scopeOf(input.revisionId), input),

    saveDerivedMaterials: async (input) =>
      saveDerivedMaterials(db, await scopeOf(input.revisionId), input),

    // Набор правил и реестр правил — конфигурация портала, а не данные
    // подрядчика: читаются системной областью, как и бюджет модели на S8.
    loadActiveRuleset: async () => loadActiveRulesetSnapshot(db, SYSTEM_SCOPE),
    listRuleDefinitionCodes: async () => listRuleDefinitionCodes(db),

    startValidationRun: async (input) =>
      startValidationRun(db, await scopeOf(input.revisionId), input),

    saveFindings: async (input) => saveFindings(db, await scopeOf(input.revisionId), input),

    saveRunJournal: async (input) => saveRunJournal(db, await scopeOf(input.revisionId), input),

    loadRunJournal: async (input) => loadRunJournal(db, await scopeOf(input.revisionId), input),

    listFindings: async (input) =>
      listFindings(db, await scopeOf(input.revisionId), {
        revisionId: input.revisionId,
        validationRunId: input.validationRunId,
      }),

    finishValidationRun: async (input) =>
      finishValidationRun(db, await scopeOf(input.revisionId), input),

    registries: createInternalRegistryProviders(),
  };
}

/**
 * Задачи 22–23: нарезка и архив (§12, §13).
 *
 * Порты связываются здесь, как и у остальных стадий. Отдельно стоит отметить
 * ключи хранилища: нарезка адресуется документом (`documents/{id}.pdf`), архив
 * — ревизией (`archive/{revisionId}/rev{N}-approved.zip`), и оба
 * детерминированы. Это и есть второй рубеж однократности: повтор задачи
 * перезаписывает свой объект, а не плодит сироты (урок S5).
 */
function materializeDeps(options: PipelineJobsOptions): MaterializeDeps {
  const { db, storage } = options;

  const scopeOf = async (revisionId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, revisionId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${revisionId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  return {
    loadPlan: async (revisionId) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;
      return loadMaterializationPlan(db, scope, revisionId);
    },

    fetchWorkingPdf: (storageKey, destinationPath) =>
      fetchOriginal(storage, storageKey, destinationPath),

    extractPages: async (input) => {
      const produced = await options.toolkit.extractPages({
        sourcePath: input.sourcePath,
        outputPath: input.outputPath,
        firstPageIndex: input.firstPageIndex,
        lastPageIndex: input.lastPageIndex,
        derivedNote: input.derivedNote,
      });
      return {
        pageCount: produced.pageCount,
        toolkit: produced.toolkit,
        derivedNoteApplied: produced.derivedNoteApplied,
      };
    },

    storeDerivedPdf: async (documentId, localPath) => {
      const sha256 = await hashFile(localPath);
      const { size: sizeBytes } = await stat(localPath);
      const key = documentPdfKey(documentId);
      await storage.putObject({
        key,
        body: createReadStream(localPath),
        contentType: PDF_CONTENT_TYPE,
        contentLength: sizeBytes,
      });
      return { sha256, byteSize: sizeBytes, s3Key: key };
    },

    saveDerivedPdf: async (input) => {
      const document = await findDocumentRevision(db, input.documentId);
      if (document === null) {
        return { kind: 'rejected', reason: 'документ исчез между нарезкой и записью' };
      }
      return saveDerivedPdf(db, await scopeOf(document.revisionId), input);
    },

    ...(options.workDirBase === undefined ? {} : { workDirBase: options.workDirBase }),
  };
}

function archiveDeps(options: PipelineJobsOptions): ArchiveDeps {
  const { db, storage } = options;

  const scopeOf = async (revisionId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, revisionId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${revisionId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  return {
    loadPlan: async (revisionId) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) return null;
      return loadArchivePlan(db, scope, revisionId);
    },

    findArchive: async (revisionId) => findArchive(db, await scopeOf(revisionId), revisionId),

    openDocumentPdf: (documentId) => streamStorageObject(storage, documentPdfKey(documentId)),

    storeArchive: async (revisionId, revisionNo, localPath) => {
      const sha256 = await hashFile(localPath);
      const { size: sizeBytes } = await stat(localPath);
      const key = archiveKey(revisionId, revisionNo);
      await storage.putObject({
        key,
        body: createReadStream(localPath),
        contentType: ZIP_CONTENT_TYPE,
        contentLength: sizeBytes,
      });
      return { sha256, byteSize: sizeBytes, s3Key: key };
    },

    // Область здесь не применяется намеренно: запись идёт по ревизии, которая
    // уже разрешена чтением плана этой же задачей, а сам INSERT дополнительно
    // проверяется триггером `submission_archives_approved_only`.
    recordArchive: (input) => recordArchive(db, input),

    ...(options.workDirBase === undefined ? {} : { workDirBase: options.workDirBase }),
  };
}

/** Ревизия документа системным чтением: нужна, чтобы построить область записи. */
async function findDocumentRevision(
  db: Database,
  documentId: string,
): Promise<{ readonly revisionId: string } | null> {
  try {
    return await requireVisibleRevisionOfDocument(db, SYSTEM_SCOPE, documentId);
  } catch {
    return null;
  }
}

/** Поток объекта хранилища как асинхронная последовательность байтов. */
async function* streamStorageObject(
  storage: StorageProvider,
  key: string,
): AsyncGenerator<Uint8Array> {
  const object = await storage.getObjectStream(key);
  for await (const chunk of object.stream) {
    yield chunk as Uint8Array;
  }
}

/**
 * Область сверки описи — по ОБЪЕКТУ реестра, а не по подрядчику ревизии.
 *
 * `pinScope` здесь не годится и это не мелочь: она даёт область подрядчика,
 * подавшего скан описи, а комплекты папки принадлежат ДРУГИМ субподрядчикам.
 * Под ней сверка увидела бы один комплект из семи и доложила бы «сошлась» —
 * то есть соврала бы ровно в том вопросе, ради которого её запускают.
 *
 * `SYSTEM_SCOPE` тоже не годится: он неограничен, а `works_registry_fk` (0028)
 * и так гарантирует, что все комплекты реестра лежат на объекте реестра.
 * Область по объекту не сужает выборку ни на строку, но превращает дефект в
 * join'е из «прочитали чужой объект» в «прочитали ноль строк».
 */
function objectScope(objectId: string): AuthScope {
  return { kind: 'engineer', userId: WORKER_ACTOR_ID, objectIds: [objectId] };
}

function registryReconcileDeps(options: PipelineJobsOptions): RegistryReconcileDeps {
  const db = options.db;

  return {
    findScan: async (registryId) => {
      // Файл описи ищется по ключу папки, а не по области: рубеж создал
      // маршрут (`findRegistry`), а областью здесь пришлось бы гадать, чья она,
      // ещё не зная объекта. Системное чтение — ровно одна строка `works`.
      const scan = await findRegistryFile(db, SYSTEM_SCOPE, registryId);
      if (scan === null) return null;

      return {
        workId: scan.id,
        objectId: scan.objectId,
        kind: scan.kind,
        registryId: scan.registryId,
        currentRevisionId: scan.currentRevisionId,
      };
    },

    findRegistry: async (objectId, registryId) => {
      const registry = await findRegistry(db, objectScope(objectId), registryId);
      if (registry === null) return null;
      return {
        id: registry.id,
        objectId: registry.objectId,
        number: registry.number,
        folderNo: registry.folderNo,
      };
    },

    loadPages: async (revisionId) => {
      const scope = await pinScope(db, revisionId);
      if (scope === null) {
        throw new PipelineScopeError(
          `Ревизия ${revisionId} не найдена: задача адресована в никуда.`,
        );
      }
      return loadSegmentationPages(db, scope, revisionId);
    },

    // Область здесь не нужна и вредна: множество закрыто ключом реестра, а
    // фильтрация областью дала бы сверку по видимой части папки (см. докстринг
    // `listRegistryComplectRevisions`).
    listComplectRevisions: async (registryId) => listRegistryComplectRevisions(db, registryId),

    listContractorNames: async (ids) => {
      const unique = [...new Set(ids)];
      const names = new Map<string, string>();
      for (const id of unique) {
        const counterparty = await findCounterparty(db, SYSTEM_SCOPE, id);
        if (counterparty !== null) names.set(id, counterparty.name);
      }
      return names;
    },

    listDocuments: async (objectId, revisionIds) =>
      listDocumentsOfRevisions(db, objectScope(objectId), revisionIds),

    listFieldValues: async (objectId, revisionIds, fieldCodes) =>
      listFieldValuesOfRevisions(db, objectScope(objectId), revisionIds, fieldCodes),

    save: async (input) => saveReconciliation(db, input),

    emit: async (revisionId, eventType, payload) => {
      await appendRevisionEvent(db, { revisionId, eventType, payload });
    },
  };
}

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
 * ИИ-проверка заполнения (S21).
 *
 * Переиспользует ПОРТ МОДЕЛИ сегментации целиком: провайдер, промты и запись
 * `ai_runs` у стадий разные по смыслу, но одинаковые по устройству, и второй
 * экземпляр `createLlmProvider` означал бы второй кэш, второй счётчик бюджета и
 * второй лимит частоты — то есть потолок портала, умноженный на число стадий.
 *
 * Документы читаются областью ревизии: `loadCheckGraph` уже собирает то же
 * самое для движка правил, но с внешними реестрами и материалами, которых этой
 * стадии не нужно, — а нужен ей текст страниц, которого нет в графе.
 */
function checksLlmReviewDeps(options: PipelineJobsOptions): ChecksLlmReviewDeps {
  const db = options.db;
  const segmentation = segmentationDeps(options);

  const scopeOf = async (revisionId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, revisionId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${revisionId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  return {
    loadReviewDocuments: async (revisionId) => {
      const scope = await scopeOf(revisionId);
      const [documents, assignments, pages] = await Promise.all([
        listLogicalDocuments(db, scope, revisionId),
        listPageAssignments(db, scope, revisionId),
        loadSegmentationPages(db, scope, revisionId),
      ]);

      const textOf = new Map(pages.pages.map((page) => [page.sourcePageId, page]));
      const pagesOfDocument = new Map<string, string[]>();
      for (const assignment of [...assignments].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
      )) {
        if (assignment.documentId === null) continue;
        const list = pagesOfDocument.get(assignment.documentId) ?? [];
        list.push(assignment.sourcePageId);
        pagesOfDocument.set(assignment.documentId, list);
      }

      const result: ReviewDocument[] = [];
      for (const document of documents) {
        const fields = await listFieldValues(db, scope, document.id);
        result.push({
          documentId: document.id,
          docTypeCode: document.docTypeCode,
          pages: (pagesOfDocument.get(document.id) ?? [])
            .map((id) => textOf.get(id))
            .filter((page) => page !== undefined)
            .map((page) => ({
              sourcePageId: page.sourcePageId,
              pageTextVersionId: page.pageTextVersionId,
              text: page.text,
            })),
          fields: fields.map((field) => ({
            fieldCode: field.fieldCode,
            valueText: field.valueText,
            valueDate: field.valueDate,
          })),
        });
      }
      return result;
    },

    saveLlmFindings: async (input) => saveLlmFindings(db, await scopeOf(input.revisionId), input),

    publishedPrompt: segmentation.publishedPrompt,
    callLlm: segmentation.callLlm,
    recordAiRun: segmentation.recordAiRun,
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
  // Звено «сборка → разметка» (S21): им кнопка «Разметить» доводит ревизию от
  // загруженных файлов до размеченных страниц одним нажатием.
  registry.register('layout.start', createLayoutStartHandler(layoutStartDeps(options)));

  const markup = markupDeps(options);
  registry.register('rd.create_run_document', createRunDocumentHandler(markup));
  registry.register('rd.upload_working_pdf', createUploadWorkingPdfHandler(markup));
  registry.register('rd.wait_pages', createWaitPagesHandler(markup, options.waitPages ?? {}));
  registry.register('layout.detect_pages', createDetectPagesHandler(markup));
  registry.register('layout.analyze_coverage', createAnalyzeCoverageHandler(markup));
  registry.register('preview.cache_pages', createPreviewCacheHandler(markup));

  // Локальная детекция RF-DETR (ADR-0008): альтернатива задаче 7 при
  // `detection.provider='local'` — растеризация PDF на воркере и ONNX-инференс
  // на CPU вместо похода в RD WEB. Регистрируется здесь и безусловно, как и
  // остальные стадии: обработчик без регистрации выглядит зависшим конвейером.
  registry.register(
    'layout.detect_local',
    createLocalDetectionHandler(localDetectionDeps(options)),
  );

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

  // Задачи `vlm.*` (ADR-0007): распознавание через OpenRouter VLM по кропам
  // блоков — альтернатива задачам 10–13 при `recognition.provider=openrouter_vlm`.
  // Регистрируются безусловно, тем же принципом: отсутствие VLM-порта или
  // растеризатора — честный отказ КОНКРЕТНОГО прогона, а не отсутствующий
  // обработчик.
  const vlmRecognition = vlmRecognitionDeps(options);
  registry.register('vlm.start_recognition', createVlmStartHandler(vlmRecognition));
  registry.register('vlm.recognize_page', createVlmRecognizePageHandler(vlmRecognition));
  registry.register('vlm.finalize_run', createVlmFinalizeHandler(vlmRecognition));

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

  // Сверка описи передачи с комплектами папки (S20). Терминальная задача: она
  // ничего не ставит дальше и ничего не блокирует — её выход читает человек.
  registry.register(
    'registry.reconcile',
    createRegistryReconcileHandler(registryReconcileDeps(options)),
  );

  // Задачи 20–21 (§12): прогон правил и сводка. Регистрируются здесь и
  // безусловно — по той же причине, что и остальные стадии: обработчик без
  // регистрации выглядит зависшим конвейером, а не отсутствующей возможностью.
  const checks = checksDeps(options);
  registry.register('checks.run', createChecksRunHandler(checks));
  // Второй этап проверки (S21): ИИ-разбор заполнения поверх того же прогона.
  // Регистрируется безусловно — отсутствие промта или провайдера это пропуск
  // стадии с названной причиной, а не отсутствующий обработчик.
  registry.register(
    'checks.llm_review',
    createChecksLlmReviewHandler(checksLlmReviewDeps(options)),
  );
  registry.register('checks.summarize', createChecksSummarizeHandler(checks));

  // Задачи 22–23 (§12): нарезка логических документов после подтверждения
  // границ и архив согласованной ревизии. Регистрируются здесь и безусловно —
  // по той же причине, что и остальные стадии.
  registry.register('doc.materialize_pdf', createMaterializePdfHandler(materializeDeps(options)));
  registry.register('submission.build_archive', createBuildArchiveHandler(archiveDeps(options)));

  // Задачи 26–27 (0027): разбор загруженного справочника и уборка брошенных
  // импортов. К ревизии отношения не имеют и стадией конвейера не являются, но
  // регистрируются здесь по той же причине, что и всё остальное: обработчик без
  // регистрации выглядит зависшей очередью, а не отсутствующей возможностью.
  const catalogImport = { db: options.db, storage: options.storage };
  registry.register('catalog.import.parse', createCatalogImportParseHandler(catalogImport));
  registry.register('catalog.import.expire', createCatalogImportExpireHandler(catalogImport));
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
