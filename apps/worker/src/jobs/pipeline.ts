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
 * получает `folderId` из payload, и порядок такой: ревизия разрешается ОДНИМ
 * системным чтением (`SYSTEM_SCOPE`, единственное место в файле, где область не
 * ограничена), после чего строится область, закреплённая за подрядчиком этой
 * ревизии, и всё остальное — файл, страницы, состав, запись bundle — читается и
 * пишется уже ею. Payload, назвавший файл чужой поставки, не находит его
 * вовсе; файл соседней ревизии того же подрядчика отсекается сверкой
 * `folderId` в самом обработчике.
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
  analysisPromptDefaultByStage,
  assembleRecognitionResult,
  insertBlockResultIdempotent,
  readExtractFanState,
  readJobAutoContinue,
  listRunBlockEnvelopes,
  listRunBlockIds,
  listRunPages,
  markRunPage,
  mergeRunSettingsSnapshot,
  publishRunResults,
  readImmutabilityEnforced,
  RECOGNITION_PROMPT_DEFAULTS,
  recognitionPromptDefaultByCode,
  recognizeBlock,
  schemaHash,
  scheduleRunRecoveryRound,
  seedRunPages,
  NoopProcessingFeedbackSink,
  type ProcessingFeedbackSink,
  type VlmPort,
} from '@id/api';

import {
  artifactKey,
  acceptGeneration,
  appendRunWarnings,
  blobKey,
  countUploadAttempt,
  documentPdfKey,
  loadMaterializationPlan,
  requireVisibleFolderOfDocument,
  saveDerivedPdf,
  createBundle,
  createMaintenanceRegistry,
  evaluatePdfFile,
  FALLBACK_LAYOUT_THRESHOLDS,
  findArtifact,
  findBundle,
  findExecSyncForRun,
  liftBlockRevisions,
  liftGeneration,
  listDeclaredBlocks,
  listPageOrientations,
  loadDocumentNaming,
  markResyncRequired,
  openExecSync,
  reconcileExecSnapshot,
  recordSyncInitialized,
  recordSyncState,
  findBundleByManifest,
  findFileContent,
  findLayoutRevision,
  findRecognitionRun,
  findFolderForFiles,
  finishRecognitionRun,
  importDetectedBlocks,
  listBundlePages,
  listBundles,
  listLayoutBlocks,
  listPagesWithBlocks,
  loadBundlePlan,
  loadMarkupContext,
  loadProfileForLayout,
  startMarkupOnBundle,
  probePdf,
  readDetectionSettings,
  recordArtifact,
  saveFileVerdict,
  savePageAttentionFlags,
  saveSignatureProbe,
  sha256Hex,
  type ExecSyncPort,
  storableVerdict,
  applySegmentation,
  createAiSpendReader,
  createLlmProvider,
  fillFolderPeriodIfEmpty,
  listMatchableContractors,
  listFieldValues,
  listLiveRecognizePageJobs,
  listLogicalDocuments,
  listPageAssignments,
  listPageClassifications,
  listPromptTemplates,
  listRegistryRows,
  loadDocumentPageText,
  loadSegmentationPages,
  observeDocTypeCandidate,
  recordAiRun,
  savePageClassifications,
  saveDocumentRelations,
  saveComplectActFields,
  saveFieldValues,
  rememberContractorRaw,
  replaceAssumedContractor,
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
  // Зонд ориентации (ADR-0020): настройки, репозиторий разворота, промт и
  // разбор ответа. Классификация отказа берётся у самой ошибки — `LlmError`
  // несёт `retriable` полем.
  LlmError,
  RECOGNITION_ORIENTATION_PROMPT,
  findPageOrientation,
  enqueueLocalDetectBatches,
  readAiDryRunOnly,
  readAnalysisModel,
  readOrientationProbeSettings,
  readRecognitionSettings,
  saveProbeOrientation,
  stripNoise,
  substitutePlaceholders,
  vlmOrientationResponseSchema,
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
import { createMaterializePdfHandler, type MaterializeDeps } from './delivery.js';
import { createInternalRegistryProviders } from '@id/rules';
import { createChecksRunHandler, createChecksSummarizeHandler, type ChecksDeps } from './checks.js';
import {
  createClassifyPagesHandler,
  createExtractDocumentHandler,
  createExtractFieldsHandler,
  createExtractFinalizeHandler,
  createGraphBuildHandler,
  createMatchRegistryHandler,
  createParseRegistryHandler,
  createSegmentHandler,
  SEGMENTATION_VERSION,
  type PublishedPrompt,
  type SegmentationDeps,
} from './segmentation.js';
import {
  createLocalDetectionHandler,
  type LocalDetectionDeps,
  type MarkupTarget,
} from './local-detection.js';
import {
  createOrientationProbeHandler,
  ORIENTATION_PROBE_MAX_LONG_EDGE_PX,
  type OrientationProbeDeps,
} from './orientation-probe.js';
import { createLayoutStartHandler, type LayoutStartDeps } from './layout-start.js';
import { createChecksLlmReviewHandler, type ChecksLlmReviewDeps } from './checks-llm-review.js';
import { createModelStore } from '../detection/model-store.js';
import { WorkingPdfCache } from '../lib/pdf-cache.js';
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
import {
  createAnalyzeCoverageHandler,
  type CoverageDeps,
  type PageBlocksSnapshot,
} from './layout-coverage.js';
import {
  createSyncCompleteHandler,
  createSyncFetchHandler,
  createSyncFinalizeHandler,
  createSyncInitHandler,
  createSyncPollHandler,
  createSyncPrepareHandler,
  createSyncResyncHandler,
  createSyncUploadHandler,
  type ExecPollOptions,
  type ExecSyncDeps,
} from './exec-sync.js';
import { PAGE_TEXT_RENDER_VERSION, renderPageText } from '@id/recognition';
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
   * Потолок кэша рабочих PDF на диске, байт (S41).
   *
   * Не задан — кэша нет, и каждая задача скачивает документ себе, как до S41.
   * Выключаемость важна для тестов и для машин, где временный раздел мал:
   * кэш — ускорение, а не условие работы конвейера.
   */
  readonly pdfCacheBytes?: number | undefined;
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
  /**
   * Адаптер контура снимка исполнительной документации (контракт document-sync v1).
   *
   * `null` — интеграция не настроена: цепочка `rd.sync_*` честно отказывает с
   * внятной причиной, а приём файлов и локальная разметка продолжают работать.
   */
  readonly execSync?: ExecSyncPort | null | undefined;
  /** Проект RD WEB, в который уезжают снимки (`RDWEB_EXEC_PROJECT_ID`). */
  readonly execProjectId?: string | null | undefined;
  /** Настройки поллинга снимка RD WEB; в тестах ускоряются. */
  readonly pollExecSync?: ExecPollOptions | undefined;
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
async function pinScope(db: Database, folderId: string): Promise<AuthScope | null> {
  const folder = await findFolderForFiles(db, SYSTEM_SCOPE, folderId);
  if (folder === null) return null;
  return { kind: 'contractor', userId: WORKER_ACTOR_ID, contractorId: folder.contractorId };
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
    const scope = await pinScope(db, target.folderId);
    if (scope === null) return null;

    const file = await findFileContent(db, scope, target.sourceFileId);
    if (file === null) return null;
    return {
      fileId: file.fileId,
      folderId: file.folderId,
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
    saveVerdict: async ({ fileId, folderId, verdict }) => {
      const scope = await pinScope(options.db, folderId);
      if (scope === null) return { written: false, reason: 'ревизия исчезла' };

      const storable = storableVerdict(verdict, new Date().toISOString());
      const outcome = await saveFileVerdict(options.db, scope, {
        fileId,
        folderId,
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

    saveProbe: async ({ fileId, folderId, probe }) => {
      const scope = await pinScope(options.db, folderId);
      if (scope === null) return { written: false, reason: 'ревизия исчезла' };

      const outcome = await saveSignatureProbe(options.db, scope, {
        fileId,
        folderId,
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
    loadPlan: async (folderId: string): Promise<BundlePlan | null> => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return null;
      return loadBundlePlan(db, scope, folderId);
    },

    findExistingBundle: async (target) => {
      const scope = await pinScope(db, target.folderId);
      if (scope === null) return null;
      const bundle = await findBundleByManifest(db, scope, target);
      return bundle === null ? null : { id: bundle.id, pageCount: bundle.pageCount };
    },

    fetchOriginal: (storageKey, destinationPath) =>
      fetchOriginal(storage, storageKey, destinationPath),

    storeWorkingPdf: (localPath) => storeWorkingPdf(storage, localPath),

    createBundle: async (input) => {
      const scope = await pinScope(db, input.folderId);
      if (scope === null) {
        throw new PipelineScopeError(
          `Папка ${input.folderId} исчезла между планом и записью рабочего документа.`,
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
// Порт анализа покрытия
// =====================================================================

/**
 * Связывание анализа покрытия: ревизия разметки, её блоки и флаги внимания.
 *
 * Порт узкий намеренно. Прежде эта задача жила в общем порте стадии разметки
 * вместе с загрузкой PDF, рендером и детекцией через RD WEB — и половина его
 * методов ей была не нужна. Со снятием легаси-маршрута лишнее ушло, и осталось
 * ровно то, что задача действительно делает.
 */
/**
 * Цель задачи детекции из репозиториев.
 *
 * Всё читается закреплённой областью (`pinScope`), включая карту страниц и
 * рабочий документ: задача, назвавшая в payload чужую папку, не находит
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
    folderId: layout.folderId,
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
    markupPolicy: layout.markupPolicy,
  };
}
function coverageDeps(options: PipelineJobsOptions): CoverageDeps {
  const { db } = options;

  return {
    loadTargetByLayout: async ({ folderId, layoutRevisionId }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return null;
      const layout = await findLayoutRevision(db, scope, layoutRevisionId);
      if (layout === null || layout.folderId !== folderId) return null;
      const profile = await loadProfileForLayout(db, layout.layoutProfileId);
      return {
        layoutRevisionId: layout.id,
        folderId: layout.folderId,
        bundleId: layout.bundleId,
        // Фолбэк берётся из репозитория, а не объявляется здесь второй раз:
        // разошедшиеся значения дали бы флаги, не совпадающие с экраном.
        thresholds: profile?.thresholds ?? FALLBACK_LAYOUT_THRESHOLDS,
        layoutProfileVersion: profile?.version ?? null,
        markupPolicy: layout.markupPolicy,
      };
    },

    loadPageBlocks: async ({ folderId, layoutRevisionId }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return [];
      const layout = await findLayoutRevision(db, scope, layoutRevisionId);
      if (layout === null) return [];

      const [pages, blocks] = await Promise.all([
        listBundlePages(db, scope, layout.bundleId),
        listLayoutBlocks(db, scope, layout.id),
      ]);

      const byPage = new Map<number, PageBlocksSnapshot['blocks'][number][]>();
      for (const block of blocks) {
        const entry = {
          blockType: block.blockType,
          x0: block.x0,
          y0: block.y0,
          x1: block.x1,
          y1: block.y1,
        };
        const list = byPage.get(block.workingPageIndex);
        if (list === undefined) byPage.set(block.workingPageIndex, [entry]);
        else list.push(entry);
      }

      // Страницы берутся из КАРТЫ, а не из набора блоков: страница без единого
      // блока обязана попасть в анализ — она и есть главный кандидат на флаг.
      return pages.map((page) => ({
        workingPageIndex: page.workingPageIndex,
        sourcePageId: page.sourcePageId,
        // Колонки названы `_px` исторически: в них округлённые пункты.
        widthPt: page.widthPx,
        heightPt: page.heightPx,
        blocks: byPage.get(page.workingPageIndex) ?? [],
      }));
    },

    saveFlags: async ({ folderId, flags }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return { written: false, reason: 'папка исчезла' };
      const outcome = await savePageAttentionFlags(db, scope, { folderId, flags });
      return outcome.kind === 'written'
        ? { written: true }
        : { written: false, reason: outcome.reason };
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
    start: async ({ folderId, logger }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return null;

      // Последний рабочий документ, а не «тот, что собрала породившая задача»:
      // между сборкой и этой задачей состав мог смениться, и размечать надо то,
      // что в ревизии сейчас. Пустой список означает, что bundle успели убрать.
      const bundles = await listBundles(db, scope, folderId);
      const bundle = bundles[bundles.length - 1];
      if (bundle === undefined) return null;

      const started = await startMarkupOnBundle(db, scope, {
        folderId,
        bundleId: bundle.id,
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

/**
 * Кэш рабочих PDF реестра: один на процесс, общий для всех трёх стадий (S41).
 *
 * Общий намеренно: зонд, детекция и распознавание читают ОДИН документ
 * комплекта, и три отдельных кэша означали бы три его копии на диске — то есть
 * ровно ту трату, ради устранения которой кэш и заведён.
 *
 * `null` — кэш выключен (`pdfCacheBytes` не задан): тогда каждая задача
 * скачивает документ себе, как до S41. Так ведут себя тесты и машины, где
 * временный раздел мал.
 */
function createPdfCache(options: PipelineJobsOptions): WorkingPdfCache | null {
  if (options.pdfCacheBytes === undefined || options.pdfCacheBytes <= 0) return null;
  return new WorkingPdfCache({
    dir: join(options.workDirBase ?? tmpdir(), 'working-pdf'),
    maxBytes: options.pdfCacheBytes,
    fetch: (storageKey, destinationPath) =>
      fetchOriginal(options.storage, storageKey, destinationPath),
  });
}

/**
 * Кэш на процесс — по одному на набор настроек (S50).
 *
 * Докстринг выше объявлял «один на процесс, общий для всех трёх стадий», а
 * код звал `createPdfCache` трижды: получались три экземпляра с ОБЩИМ
 * каталогом и раздельными картами аренд. Вытеснение одного не видит аренд
 * другого и вправе удалить файл, который прямо сейчас читает `pdftoppm`
 * соседней стадии. На одном комплекте это не стреляло — потолок кэша больше
 * документа, — но на двух-трёх сразу выстрелило бы отказом рендера без
 * единого следа о причине.
 *
 * Ключ — сам объект настроек: в проде он один на процесс, а в тестах их
 * несколько, и общий кэш склеил бы независимые прогоны.
 */
const pdfCaches = new WeakMap<PipelineJobsOptions, WorkingPdfCache | null>();

function sharedPdfCache(options: PipelineJobsOptions): WorkingPdfCache | null {
  if (!pdfCaches.has(options)) pdfCaches.set(options, createPdfCache(options));
  return pdfCaches.get(options) ?? null;
}

/**
 * Аренда рабочего PDF: из кэша, если он есть, иначе своя временная копия.
 *
 * Одна функция на все три стадии — иначе выключенный кэш вёл бы себя в них
 * по-разному, и разница вскрылась бы на машине, где кэш не настроен.
 */
async function leaseWorkingPdf(
  options: PipelineJobsOptions,
  cache: WorkingPdfCache | null,
  storageKey: string,
  fallbackPrefix: string,
): Promise<{ readonly path: string; readonly release: () => Promise<void> }> {
  if (cache !== null) return cache.lease(storageKey);

  const dir = await mkdtemp(join(options.workDirBase ?? tmpdir(), fallbackPrefix));
  const path = join(dir, 'working.pdf');
  await fetchOriginal(options.storage, storageKey, path);
  return { path, release: () => rm(dir, { recursive: true, force: true }) };
}

function localDetectionDeps(options: PipelineJobsOptions): LocalDetectionDeps {
  const { db, storage } = options;
  const pdfCache = sharedPdfCache(options);

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

    loadTargetByLayout: async ({ folderId, layoutRevisionId }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return null;
      const layout = await findLayoutRevision(db, scope, layoutRevisionId);
      if (layout === null || layout.folderId !== folderId) return null;
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

    pageGeometry: async ({ folderId, bundleId }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return [];
      return listBundlePages(db, scope, bundleId);
    },

    // Любой существующий блок (авто ИЛИ ручной) — сигнал «страницу уже
    // размечали»: skip без overwriteExisting экономит рендер+инференс на
    // странице, которую всё равно не тронет `importBlocks` (авто) или которую
    // он безусловно защищает (ручной, `pagesWithManualBlocks`).
    existingBlockPages: async ({ folderId, layoutRevisionId }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return new Set();
      return listPagesWithBlocks(db, scope, layoutRevisionId);
    },

    workingPdf: (key) => leaseWorkingPdf(options, pdfCache, key, 'id-detect-pdf-'),

    importBlocks: async (input) => {
      const scope = await pinScope(db, input.folderId);
      if (scope === null) {
        throw new PipelineScopeError('Ревизия исчезла до импорта локальной детекции.');
      }
      const result = await importDetectedBlocks(db, scope, {
        layoutRevisionId: input.layoutRevisionId,
        workingPageIndices: input.workingPageIndices,
        blocks: input.blocks,
        /**
         * Провенанс приходит от обработчика (S42), а не зашит здесь.
         *
         * Раньше он был константой `rf_detr`: локальный детектор — та же модель,
         * что у RD WEB, менялся только способ инференса, а не архитектура сети.
         * Теперь обработчик размечает часть страниц БЕЗ модели вовсе — лист A4
         * получает один блок на всю страницу, — и назвать это `rf_detr` значило
         * бы приписать модели работу, которой она не делала.
         */
        provenance: input.provenance,
      });
      return { imported: result.imported, skippedPages: result.skippedPages };
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
 * Та же дисциплина, что у `recognitionDeps`: `folderId`/`runId` из payload
 * разрешаются закреплённой областью, а не системной, — payload с чужим
 * прогоном не находит его вовсе. Отличие от `recognitionDeps` только в
 * наборе полей: у VLM-прогона нет ни RD-документа, ни удалённых хэшей, зато
 * есть таблица `recognition_run_pages`, растеризатор и порт `VlmPort`.
 */
/**
 * Связывание зонда ориентации (ADR-0020).
 *
 * Растеризатор и VLM-порт здесь ОПЦИОНАЛЬНЫ, как и у распознавания. Их
 * отсутствие не отказ задачи, а выключенный зонд: страница считается прямой,
 * детекция ставится, процесс поднимается. Молчаливая деградация хуже честного
 * отказа — но остановленный конвейер хуже обоих, а поворот скана это поправка к
 * качеству, без которой портал работал всё время до S35.
 */
function orientationProbeDeps(options: PipelineJobsOptions): OrientationProbeDeps {
  const { db } = options;
  const pdfCache = sharedPdfCache(options);

  const scopeOf = async (folderId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, folderId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${folderId} не найдена: зонд адресован в никуда.`);
    }
    return scope;
  };

  return {
    ...(options.workDirBase !== undefined ? { workDirBase: options.workDirBase } : {}),

    probeEnabled: async () => {
      if (options.vlm === undefined || options.vlm === null) return false;
      if (options.rasterizer === undefined || options.rasterizer === null) return false;
      return (await readOrientationProbeSettings(db)).enabled;
    },

    dryRun: () => readAiDryRunOnly(db),

    existingSource: async ({ folderId, sourcePageId }) => {
      const view = await findPageOrientation(db, folderId, sourcePageId);
      if (view === null || view.source === null) return null;
      // «Ответил» — это мнение о развороте, а не строка о том, что зонд
      // отказал: во втором случае спросить заново единственный способ узнать
      // ответ, в первом — повторный вызов оплачивал бы уже известное (S41).
      return { source: view.source, answered: view.probeRotation !== null };
    },

    workingPdfToFile: async (bundleId) => {
      const bundle = await findBundle(db, SYSTEM_SCOPE, bundleId);
      if (bundle === null) throw new PipelineScopeError(`Рабочий документ ${bundleId} не найден.`);
      const leased = await leaseWorkingPdf(
        options,
        pdfCache,
        blobKey(bundle.workingPdfBlobSha256),
        'id-orientation-pdf-',
      );
      return { path: leased.path, cleanup: leased.release };
    },

    renderPage: async (input) => {
      const rasterizer = options.rasterizer;
      if (rasterizer === null || rasterizer === undefined) {
        throw new Error('Растеризатор недоступен: зонд не может отрендерить страницу');
      }
      return rasterizer.renderPage(input);
    },

    // Миниатюра берётся ТЕМ ЖЕ `cropBlockPng`, что режет блоки: второй путь
    // ресемплинга означал бы два ответа на вопрос «как уменьшить картинку», а
    // побочный выигрыш в том, что картинка зонда попадает под ту же версию
    // crop policy.
    thumbnail: async ({ pagePngPath, widthPx, heightPx }) => {
      const cropped = await cropBlockPng({
        pagePngPath,
        pageWidthPx: widthPx,
        pageHeightPx: heightPx,
        coordsNorm: [0, 0, 1, 1],
        polygon: null,
        paddingPx: 0,
        maxLongEdgePx: ORIENTATION_PROBE_MAX_LONG_EDGE_PX,
      });
      return 'degenerate' in cropped ? null : cropped.png;
    },

    probe: async ({ png, pageNumber, signal, timeoutMs }) => {
      const vlm = options.vlm;
      if (vlm === null || vlm === undefined) {
        throw new Error('VLM-порт не настроен: зонд не может спросить модель');
      }

      const preset = RECOGNITION_ORIENTATION_PROMPT;
      // Опубликованная версия в приоритете, встроенный текст — запасной, с
      // версией 0. Та же схема, что у промтов распознавания: «встроенным» —
      // такой же честный ответ на вопрос «чем выполнено», как «версией 3».
      const templates = await listPromptTemplates(db, SYSTEM_SCOPE, {
        code: preset.code,
        state: 'published',
        limit: 1,
      });
      const published = templates.items[0];
      const systemPrompt = published?.systemPrompt ?? preset.systemPrompt;
      const userTemplate = published?.userTemplate ?? preset.userTemplate;
      const promptVersion = published?.version ?? 0;

      // Модель зонда: своя настройка, иначе модель распознавания. Требовать
      // настройки ВТОРОЙ модели ради работы зонда значило бы завести гейт того
      // же рода, который `prompts.ts` уже описал и снял.
      const [probeSettings, recognitionSettings] = await Promise.all([
        readOrientationProbeSettings(db),
        readRecognitionSettings(db),
      ]);
      const model = probeSettings.model !== '' ? probeSettings.model : recognitionSettings.vlmModel;
      if (model === '') {
        throw new Error('Модель зонда не выбрана: пусты и своя настройка, и модель распознавания');
      }

      const response = await vlm.complete({
        stage: 'orientation',
        promptCode: preset.code,
        promptVersion,
        systemPrompt,
        userPrompt: substitutePlaceholders(userTemplate, {
          pageNumber,
          // Зонд смотрит на страницу целиком: блока у него нет, и подставлять
          // сюда нечего. Пустая строка честнее выдуманного идентификатора.
          layoutBlockId: '',
        }),
        images: [{ png }],
        responseFormat: preset.responseFormat,
        schemaVersion: schemaHash(preset.responseFormat.schema),
        model,
        temperature: preset.temperature,
        maxTokens: preset.maxTokens,
        // Отмена попытки задачи доезжает до самого вызова (S41): брошенный
        // зонд иначе держал бы соединение до ответа модели.
        ...(signal !== undefined ? { signal } : {}),
        // Свой потолок ожидания: общий LLM_TIMEOUT_MS вчетверо больше аренды
        // задачи зонда, и медленный вызов оканчивался бы JobTimeout (S41).
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });

      const parsed = vlmOrientationResponseSchema.safeParse(
        JSON.parse(stripNoise(response.text)) as unknown,
      );
      if (!parsed.success) {
        throw new Error(`Ответ зонда не прошёл схему: ${parsed.error.issues[0]?.message ?? ''}`);
      }

      return {
        promptCode: preset.code,
        promptVersion,
        model: response.model,
        provider: response.provider,
        inputHash: response.inputHash,
        outputHash: response.outputHash,
        answer: {
          rotation: parsed.data.rotation,
          confidence: parsed.data.confidence ?? null,
          evidence: parsed.data.evidence ?? null,
        },
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        cost: response.cost,
        latencyMs: response.latencyMs,
      };
    },

    saveOrientation: (input) => saveProbeOrientation(db, input),

    recordAiRun: async (input) => {
      await recordAiRun(db, await scopeOf(input.folderId), input);
    },

    enqueueDetection: async ({ folderId, layoutRevisionId, workingPageIndex, logger }) => {
      await enqueueLocalDetectBatches(db, await scopeOf(folderId), {
        layoutRevisionId,
        folderId,
        pages: [workingPageIndex],
        overwriteExisting: false,
        // Журнал контекста задачи — тот же интерфейс, что ждёт постановка.
        logger,
      });
    },

    reportFeedback: async (input) => {
      const sink = options.feedback ?? new NoopProcessingFeedbackSink();
      await sink.record({
        folderId: input.folderId,
        sourcePageId: input.sourcePageId,
        workingPageIndex: input.workingPageIndex,
        feedbackType: 'system_failure',
        reasonCode: input.reasonCode,
        severity: 'warn',
        pipelineStage: 'layout',
        observed: { detail: input.detail },
      });
    },

    /**
     * Повторяемость отказа спрашивается у самой ошибки.
     *
     * `LlmError` несёт `retriable` полем — провайдер уже решил, поможет ли
     * повтор ЭТОГО вызова (см. шапку `llm/port.ts`). Второй классификатор
     * рядом означал бы второй словарь ошибок шлюза, расходящийся с первым на
     * первом же новом коде. Всё, что не `LlmError`, — не сетевой отказ, а
     * дефект нашего кода: повторять его незачем.
     */
    isRetriable: (error) => error instanceof LlmError && error.retriable,
  };
}

function vlmRecognitionDeps(options: PipelineJobsOptions): VlmRecognitionDeps {
  const { db, storage } = options;
  const pdfCache = sharedPdfCache(options);

  const scopeOf = async (folderId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, folderId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${folderId} не найдена: прогон адресован в никуда.`);
    }
    return scope;
  };

  const scopeOfRun = async (runId: string): Promise<{ scope: AuthScope; folderId: string }> => {
    const run = await findRecognitionRun(db, SYSTEM_SCOPE, runId);
    if (run === null) throw new PipelineScopeError(`Прогон ${runId} не найден.`);
    return { scope: await scopeOf(run.folderId), folderId: run.folderId };
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

    loadRun: async ({ folderId, recognitionRunId }) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return null;
      const run = await findRecognitionRun(db, scope, recognitionRunId);
      if (run === null || run.folderId !== folderId) return null;
      return {
        runId: run.id,
        folderId: run.folderId,
        layoutRevisionId: run.layoutRevisionId,
        status: run.status,
        localLayoutHash: run.localLayoutHash,
        settingsSnapshot: run.settingsSnapshot,
        recoveryRound: run.recoveryRound,
        repairOfRunId: run.repairOfRunId,
        workingPdfSha256: run.workingPdfSha256,
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
        detectorProvenance: block.detectorProvenance,
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

    // Область видимости здесь не нужна: спрашиваются СВОИ задачи прогона по его
    // идентификатору, и ответ — множество номеров страниц, а не данные комплекта.
    livePageJobs: (runId) => listLiveRecognizePageJobs(db, runId),

    scheduleRecoveryRound: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      return scheduleRunRecoveryRound(db, scope, input);
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
      return publishRunResults(db, scope, input);
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
     * Промпт по коду (не по стадии, в отличие от сегментации):
     * `ux_prompt_templates_single_published` гарантирует не больше одной
     * опубликованной версии на код, поэтому неоднозначности здесь нет.
     *
     * Пустой каталог — не отказ, а встроенный текст с `version: 0`. Сид-миграция
     * промптов генерируется из тех же констант, поэтому «черновик, который забыли
     * опубликовать» и «встроенный текст» — одна и та же строка; требовать ручной
     * публикации, чтобы её получить, значило бы убивать прогон ни за что.
     */
    promptByCode: async (code) => {
      const page = await listPromptTemplates(db, SYSTEM_SCOPE, {
        code,
        state: 'published',
        limit: 1,
      });
      const row = page.items[0];
      if (row !== undefined) {
        return {
          code: row.code,
          version: row.version,
          systemPrompt: row.systemPrompt,
          userTemplate: row.userTemplate,
          outputSchema: row.outputSchema,
          modelOverride: row.modelOverride,
        };
      }

      const preset = recognitionPromptDefaultByCode(code);
      if (preset === null) {
        // Код не из `RECOGNITION_PROMPT_DEFAULTS`: постановка задачи ссылается на
        // промпт, которого нет ни в каталоге, ни в коде. Это дефект вызывающего.
        throw new Error(`Промпт ${code} неизвестен: нет ни опубликованной версии, ни встроенной`);
      }
      return {
        code: preset.code,
        version: 0,
        systemPrompt: preset.systemPrompt,
        userTemplate: preset.userTemplate,
        outputSchema: preset.responseFormat.schema,
        modelOverride: null,
      };
    },

    enforceGates: () => readImmutabilityEnforced(db),

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
      const leased = await leaseWorkingPdf(
        options,
        pdfCache,
        blobKey(run.workingPdfSha256),
        'id-vlm-pdf-',
      );
      return { path: leased.path, cleanup: leased.release };
    },

    crop: (input) => cropBlockPng(input),
    downscale: (png) => downscalePng(png),

    assemble: (input) => assembleRecognitionResult(input),

    recordAiRun: async (input) => {
      await recordAiRun(db, await scopeOf(input.folderId), input);
    },

    // Дефекты качества: непригодный ответ модели и отказ. По умолчанию
    // приёмник пустой — запуск без БД не обязан вести набор данных, и
    // отсутствующий приёмник честнее записи в никуда.
    feedback: options.feedback ?? new NoopProcessingFeedbackSink(),

    // Свежий заказ сквозного прогона: снимок payload, взятый при захвате, у
    // поллера финализации отстаёт на минуты и до 240 попыток.
    readAutoContinue: async (jobId) => readJobAutoContinue(db, jobId),
  };
}

/**
 * Связывание цепочки снимка RD WEB с базой, хранилищем и адаптером контракта.
 *
 * Та же дисциплина, что у остальных стадий: одно системное чтение ради
 * определения подрядчика прогона (`pinScope`), после чего всё идёт закреплённой
 * областью. Вторая реализация любой из этих функций разошлась бы с первой молча.
 */
function execSyncDeps(options: PipelineJobsOptions): ExecSyncDeps {
  const { db, storage } = options;

  const scopeOf = async (folderId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, folderId);
    if (scope === null) {
      throw new PipelineScopeError(`Папка ${folderId} не найдена: прогон адресован в никуда.`);
    }
    return scope;
  };

  const scopeOfRun = async (runId: string): Promise<{ scope: AuthScope; folderId: string }> => {
    const run = await findRecognitionRun(db, SYSTEM_SCOPE, runId);
    if (run === null) throw new PipelineScopeError(`Прогон ${runId} не найден.`);
    return { scope: await scopeOf(run.folderId), folderId: run.folderId };
  };

  return {
    port: options.execSync ?? null,
    projectId: options.execProjectId ?? null,
    feedback: options.feedback ?? new NoopProcessingFeedbackSink(),

    loadRun: async (runId) => {
      const run = await findRecognitionRun(db, SYSTEM_SCOPE, runId);
      if (run === null) return null;
      const layout = await findLayoutRevisionSystemwide(db, run.layoutRevisionId);
      if (layout === null) return null;
      return {
        runId: run.id,
        folderId: run.folderId,
        layoutRevisionId: run.layoutRevisionId,
        bundleId: layout.bundleId,
        status: run.status,
        localLayoutHash: run.localLayoutHash,
        workingPdfSha256: run.workingPdfSha256,
        settingsSnapshot: (run.settingsSnapshot ?? {}) as Record<string, unknown>,
        recoveryRound: run.recoveryRound,
      };
    },

    /**
     * Блоки разметки вместе с разворотом их страницы.
     *
     * Разворот приклеивается здесь, а не читается задачей отдельно: он свойство
     * СКАНА, ключ у него `source_page_id`, и связать его с блоком можно только
     * через карту страниц рабочего документа. Задача, делающая это сама, завела
     * бы второе место, где карта читается, — и разошлась бы с первым при
     * пересборке комплекта.
     */
    loadLayoutBlocks: async (target) => {
      const scope = await scopeOf(target.folderId);
      const blocks = await listLayoutBlocks(db, scope, target.layoutRevisionId);
      const orientations = await listPageOrientations(db, target.folderId);
      const rotationByPage = new Map(
        orientations.map((row) => [row.sourcePageId, row.contentRotation]),
      );
      const pages = await listBundlePages(db, scope, target.bundleId);
      const sourceByIndex = new Map(
        pages.map((page) => [page.workingPageIndex, page.sourcePageId]),
      );

      return blocks.map((block) => {
        const sourcePageId = sourceByIndex.get(block.workingPageIndex);
        return {
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
          displayName: null,
          contentRotation: sourcePageId === undefined ? 0 : (rotationByPage.get(sourcePageId) ?? 0),
        };
      });
    },

    loadDocumentFacts: async (target) => {
      const scope = await scopeOf(target.folderId);
      const bundle = await findBundle(db, scope, target.bundleId);
      if (bundle === null) {
        throw new PipelineScopeError(`Рабочий документ ${target.bundleId} не найден.`);
      }
      const naming = await loadDocumentNaming(db, target.folderId);
      const head = await storage.headObject(blobKey(bundle.workingPdfBlobSha256));
      return {
        sha256: bundle.workingPdfBlobSha256,
        sizeBytes: head?.sizeBytes ?? 0,
        pageCount: bundle.pageCount,
        projectName: naming.projectName,
        documentName: naming.documentName,
      };
    },

    loadPageGeometry: async (target) => {
      const scope = await scopeOf(target.folderId);
      return listBundlePages(db, scope, target.bundleId);
    },

    loadMarkupContext: async (target) => {
      const scope = await scopeOf(target.folderId);
      return loadMarkupContext(db, scope, target.layoutRevisionId);
    },

    openWorkingPdf: async (sha256) => {
      const key = blobKey(sha256);
      const head = await storage.headObject(key);
      if (head === null) {
        throw new PipelineScopeError(`Рабочий PDF ${sha256} отсутствует в хранилище.`);
      }
      const openedStream = await storage.getObjectStream(key);
      return {
        sizeBytes: head.sizeBytes,
        body: () => openedStream.stream,
      };
    },

    reconcileSnapshot: async (input) => {
      const scope = await scopeOf(input.folderId);
      return reconcileExecSnapshot(db, scope, input);
    },

    openSync: async (input) => openExecSync(db, input),
    findSyncForRun: async (runId) => findExecSyncForRun(db, runId),
    recordSyncInitialized: async (syncId, input) => recordSyncInitialized(db, syncId, input),
    recordSyncState: async (syncId, state, patch) => recordSyncState(db, syncId, state, patch),
    countUploadAttempt: async (syncId) => countUploadAttempt(db, syncId),
    acceptGeneration: async (folderId, generation) => acceptGeneration(db, folderId, generation),
    markResyncRequired: async (folderId) => markResyncRequired(db, folderId),
    liftGeneration: async (folderId, atLeast) => liftGeneration(db, folderId, atLeast),
    liftBlockRevisions: async (folderId, remote) => liftBlockRevisions(db, folderId, remote),
    listDeclaredBlocks: async (folderId) => listDeclaredBlocks(db, folderId),

    seedRunPages: async (runId, pages) => {
      const { scope } = await scopeOfRun(runId);
      await seedRunPages(db, scope, runId, pages);
    },

    markRunPage: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      await markRunPage(db, scope, input);
    },

    saveBlockResult: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      await insertBlockResultIdempotent(db, scope, {
        recognitionRunId: input.runId,
        layoutRevisionId: input.layoutRevisionId,
        block: {
          layoutBlockId: input.layoutBlockId,
          resultType: input.resultType,
          contentHtml: null,
          contentMd: input.contentMd,
          contentJson: input.contentJson,
          modelId: null,
          confidence: null,
        },
      });
    },

    listSavedBlockIds: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      return listRunBlockIds(db, scope, runId);
    },

    listBlockEnvelopes: async (runId) => {
      const { scope } = await scopeOfRun(runId);
      const rows = await listRunBlockEnvelopes(db, scope, runId);
      return rows.map((row) => ({
        layoutBlockId: row.layoutBlockId,
        contentJson: row.contentJson,
      }));
    },

    mergeSnapshot: async (runId, patch) => {
      const { scope } = await scopeOfRun(runId);
      await mergeRunSettingsSnapshot(db, scope, runId, patch);
    },

    appendWarnings: async (runId, warnings) => {
      const { scope } = await scopeOfRun(runId);
      await appendRunWarnings(db, scope, runId, warnings);
    },

    finishRun: async (input) => {
      const { scope } = await scopeOfRun(input.runId);
      await finishRecognitionRun(db, scope, input);
    },

    assemble: (input) => assembleRecognitionResult(input),

    /**
     * Канонический артефакт: запись идемпотентна и сверяется по хэшу.
     *
     * Повторная финализация обязана попасть в тот же артефакт, а не записать
     * второй: `artifact_versions` держит UNIQUE по (прогон, вид), и расхождение
     * байтов при том же прогоне означает недетерминированную сборку — это
     * отказ, а не новая версия.
     */
    storeCanonicalArtifact: async (runId, bytes) => {
      const { scope } = await scopeOfRun(runId);
      const sha256 = sha256Hex(bytes);
      const existing = await findArtifact(db, scope, runId, 'canonical');
      if (existing !== null) {
        if (existing.artifactSha256 !== sha256) {
          throw new PipelineScopeError(
            'Артефакт canonical этого прогона записан с другим хэшем: сборка недетерминирована.',
          );
        }
        return existing.id;
      }
      await storage.putObject({
        key: artifactKey(runId, 'canonical'),
        body: Buffer.from(bytes),
        contentType: 'application/json',
        contentLength: bytes.byteLength,
      });
      await recordArtifact(db, scope, {
        recognitionRunId: runId,
        kind: 'canonical',
        artifactSha256: sha256,
        byteSize: bytes.byteLength,
      });
      const recorded = await findArtifact(db, scope, runId, 'canonical');
      if (recorded === null) {
        throw new PipelineScopeError('Артефакт canonical не читается сразу после записи.');
      }
      return recorded.id;
    },

    publishResults: async (input) => {
      const { scope } = await scopeOfRun(input.recognitionRunId);
      return publishRunResults(db, scope, input);
    },

    renderPageText: (page) => renderPageText(page as Parameters<typeof renderPageText>[0]),
    pageTextRenderVersion: PAGE_TEXT_RENDER_VERSION,

    /**
     * Переход «распознавание → анализ» при сквозном прогоне (S21).
     *
     * Заказ перечитывается из строки задачи, а не берётся из payload: между
     * захватом попытки и решением проходят минуты, и человек мог нажать
     * «Проверить» уже после захвата. Тот же довод и тот же приём, что у
     * финализации VLM.
     */
    continueWithAnalysis: async (ctx, target) => {
      const wanted =
        (await readJobAutoContinue(db, ctx.jobId)) || ctx.payload.autoContinue === true;
      if (!wanted) return;
      await ctx.enqueue({
        type: 'doc.classify_pages',
        payload: { folderId: target.folderId, autoContinue: true },
        dedupeKey: `doc.classify_pages:${target.folderId}:${target.runId}`,
      });
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

  const scopeOf = async (folderId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, folderId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${folderId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  return {
    loadGraph: async (input) => loadCheckGraph(db, await scopeOf(input.folderId), input),

    saveDerivedMaterials: async (input) =>
      saveDerivedMaterials(db, await scopeOf(input.folderId), input),

    // Набор правил и реестр правил — конфигурация портала, а не данные
    // подрядчика: читаются системной областью, как и бюджет модели на S8.
    loadActiveRuleset: async () => loadActiveRulesetSnapshot(db, SYSTEM_SCOPE),
    listRuleDefinitionCodes: async () => listRuleDefinitionCodes(db),

    startValidationRun: async (input) =>
      startValidationRun(db, await scopeOf(input.folderId), input),

    saveFindings: async (input) => saveFindings(db, await scopeOf(input.folderId), input),

    saveRunJournal: async (input) => saveRunJournal(db, await scopeOf(input.folderId), input),

    loadRunJournal: async (input) => loadRunJournal(db, await scopeOf(input.folderId), input),

    listFindings: async (input) =>
      listFindings(db, await scopeOf(input.folderId), {
        folderId: input.folderId,
        validationRunId: input.validationRunId,
      }),

    finishValidationRun: async (input) =>
      finishValidationRun(db, await scopeOf(input.folderId), input),

    registries: createInternalRegistryProviders(),
  };
}

/**
 * Задачи 22–23: нарезка и архив (§12, §13).
 *
 * Порты связываются здесь, как и у остальных стадий. Отдельно стоит отметить
 * ключи хранилища: нарезка адресуется документом (`documents/{id}.pdf`), архив
 * — ревизией (`archive/{folderId}/rev{N}-approved.zip`), и оба
 * детерминированы. Это и есть второй рубеж однократности: повтор задачи
 * перезаписывает свой объект, а не плодит сироты (урок S5).
 */
function materializeDeps(options: PipelineJobsOptions): MaterializeDeps {
  const { db, storage } = options;

  const scopeOf = async (folderId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, folderId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${folderId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  return {
    loadPlan: async (folderId) => {
      const scope = await pinScope(db, folderId);
      if (scope === null) return null;
      return loadMaterializationPlan(db, scope, folderId);
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
      const document = await findDocumentFolder(db, input.documentId);
      if (document === null) {
        return { kind: 'rejected', reason: 'документ исчез между нарезкой и записью' };
      }
      return saveDerivedPdf(db, await scopeOf(document.folderId), input);
    },

    ...(options.workDirBase === undefined ? {} : { workDirBase: options.workDirBase }),
  };
}

/** Ревизия документа системным чтением: нужна, чтобы построить область записи. */
async function findDocumentFolder(
  db: Database,
  documentId: string,
): Promise<{ readonly folderId: string } | null> {
  try {
    return await requireVisibleFolderOfDocument(db, SYSTEM_SCOPE, documentId);
  } catch {
    return null;
  }
}

function segmentationDeps(options: PipelineJobsOptions): SegmentationDeps {
  const db = options.db;

  const scopeOf = async (folderId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, folderId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${folderId} не найдена: задача адресована в никуда.`);
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
    loadPages: async (folderId) => loadSegmentationPages(db, await scopeOf(folderId), folderId),

    loadDocumentText: async (folderId, documentId) =>
      loadDocumentPageText(db, await scopeOf(folderId), folderId, documentId),

    // Область не нужна: состояние веера читается по идентификаторам задач, а не
    // по данным папки, и спрашивает его конвейер, а не человек.
    extractFanState: async (folderId, generation) => readExtractFanState(db, folderId, generation),

    saveComplectActFields: async (input) => saveComplectActFields(db, input),

    savePageClassifications: async (input) =>
      savePageClassifications(db, await scopeOf(input.folderId), input),

    listPageClassifications: async (folderId) =>
      listPageClassifications(db, await scopeOf(folderId), folderId),

    applySegmentation: async (input) =>
      applySegmentation(db, await scopeOf(input.folderId), {
        folderId: input.folderId,
        documents: input.segmentation.documents,
        unassigned: input.segmentation.unassigned,
        extractorVersion: SEGMENTATION_VERSION,
      }),

    listDocuments: async (folderId) => listLogicalDocuments(db, await scopeOf(folderId), folderId),

    listPageAssignments: async (folderId) =>
      listPageAssignments(db, await scopeOf(folderId), folderId),

    listFieldValues: async (documentId) => listFieldValues(db, SYSTEM_SCOPE, documentId),

    // Без области: месяц выводит конвейер, а не человек, и проверять его
    // правами пользователя было бы подлогом. Запись идемпотентна и не трогает
    // уже определённый месяц — условие живёт в самом операторе.
    fillFolderPeriod: async (folderId, period) => fillFolderPeriodIfEmpty(db, folderId, period),

    // Исполнитель — по тем же основаниям без области: он прочитан из акта, а
    // не назван человеком. Условия «заменяется только подставленное» и «пока
    // комплект не подан и не в папке» живут в самих операторах.
    replaceAssumedContractor: async (folderId, contractorId) =>
      replaceAssumedContractor(db, folderId, contractorId),

    rememberContractorRaw: async (folderId, raw) => rememberContractorRaw(db, folderId, raw),

    // Весь справочник, а не закрепления объекта: сужение оставляло бы
    // исполнителя неопознанным на объектах без закреплений (S39).
    listMatchableContractors: async () => listMatchableContractors(db),

    saveFieldValues: async (input) => saveFieldValues(db, await scopeOf(input.folderId), input),

    saveRegistryRows: async (input) => saveRegistryRows(db, await scopeOf(input.folderId), input),

    listRegistryRows: async (folderId) => listRegistryRows(db, await scopeOf(folderId), folderId),

    saveRegistryMatches: async (input) =>
      saveRegistryMatches(db, await scopeOf(input.folderId), input),

    saveDocumentRelations: async (input) =>
      saveDocumentRelations(db, await scopeOf(input.folderId), input),
    readAutoContinue: async (jobId) => readJobAutoContinue(db, jobId),

    observeCandidate: async (input) => {
      const outcome = await observeDocTypeCandidate(db, await scopeOf(input.folderId), input);
      return { created: outcome.created, occurrences: outcome.occurrences };
    },

    /**
     * Промт стадии: опубликованный, иначе встроенный.
     *
     * Двух опубликованных промтов одной стадии быть не должно, и «взять
     * первый» здесь запрещено: выбор между ними определял бы результат
     * классификации молча. Уникальный индекс БД гарантирует один
     * опубликованный промт на КОД, но не на стадию, поэтому проверка здесь
     * настоящая, а не удвоение ограничения.
     *
     * Пустой каталог — НЕ отказ и не пропуск стадии, а встроенный текст с
     * `version: 0`. Прежде `null` отсюда означал «стадия пропущена целиком», и
     * это выключало весь анализ: сид-миграция 0032 кладёт `extract` и `check`
     * черновиками, а `page_classify` не сеяла ни одна миграция. Требовать
     * ручной публикации ради текста, из которого сама сид-миграция и
     * сгенерирована, значило запирать конвейер ни за чем — тот же вывод уже
     * сделан для стадии `recognize` (`promptByCode` выше).
     *
     * `null` остаётся ровно для одного случая: стадия, у которой встроенного
     * текста нет вовсе. Тогда пропуск с названной причиной — законный исход.
     */
    stagePrompt: async (stage): Promise<PublishedPrompt | null> => {
      /**
       * Модель стадий анализа читается ЗДЕСЬ, вместе с промтом.
       *
       * Не в момент вызова шлюза и не один раз на процесс: промт и модель —
       * одна пара, и в `ai_runs` они уезжают вместе. Настройка, прочитанная
       * отдельно от промта, разошлась бы с ним при смене посреди прогона.
       *
       * Порядок предпочтения: `model_override` конкретного промта → настройка
       * `analysis.model` → модель распознавания (её подставит сам провайдер,
       * получив `undefined`). Первый уровень существует ради опыта с одной
       * стадией, второй — ради всей ветки анализа.
       */
      const analysisModel = await readAnalysisModel(db);
      const fallbackModel = analysisModel === '' ? null : analysisModel;

      const page = await listPromptTemplates(db, SYSTEM_SCOPE, {
        stage,
        state: 'published',
        limit: 10,
      });
      if (page.items.length > 1) {
        throw new PipelineScopeError(
          `Стадия ${stage}: опубликовано ${page.items.length} промтов; ` +
            'какой из них применять — не решает конвейер.',
        );
      }
      const row = page.items[0];
      if (row !== undefined) {
        return {
          code: row.code,
          version: row.version,
          systemPrompt: row.systemPrompt,
          userTemplate: row.userTemplate,
          modelOverride: row.modelOverride ?? fallbackModel,
        };
      }

      const preset = analysisPromptDefaultByStage(stage);
      if (preset === null) return null;
      return {
        code: preset.code,
        // Ноль — не «версия неизвестна», а «версия из кода»: строка каталога с
        // таким номером не создаётся никогда, поэтому значение однозначно и
        // видно в `ai_runs.prompt_version`.
        version: 0,
        systemPrompt: preset.text.system,
        userTemplate: preset.text.user,
        modelOverride: fallbackModel,
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
      await recordAiRun(db, await scopeOf(input.folderId), input);
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

  const scopeOf = async (folderId: string): Promise<AuthScope> => {
    const scope = await pinScope(db, folderId);
    if (scope === null) {
      throw new PipelineScopeError(`Ревизия ${folderId} не найдена: задача адресована в никуда.`);
    }
    return scope;
  };

  return {
    loadReviewDocuments: async (folderId) => {
      const scope = await scopeOf(folderId);
      const [documents, assignments, pages] = await Promise.all([
        listLogicalDocuments(db, scope, folderId),
        listPageAssignments(db, scope, folderId),
        loadSegmentationPages(db, scope, folderId),
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

    saveLlmFindings: async (input) => saveLlmFindings(db, await scopeOf(input.folderId), input),

    // Сигнал о качестве извлечения: годовой ряд «как часто портал читает
    // неверно и каким промтом» строится по нему, а не по замечаниям — их
    // заменяет следующая проверка.
    recordFeedback: async (event) => {
      const sink = options.feedback ?? new NoopProcessingFeedbackSink();
      await sink.record({
        feedbackType: 'wrong_extraction',
        reasonCode: 'extract.value_mismatch',
        severity: 'warn',
        folderId: event.folderId,
        ...(event.findingId === null ? {} : { findingId: event.findingId }),
        ...(event.docTypeCode === null ? {} : { docTypeCode: event.docTypeCode }),
        pipelineStage: 'checks',
        promptCode: event.promptCode,
        // Версия 0 — встроенный промт (см. `stagePrompt`), а CHECK таблицы
        // требует положительную: тогда версия не называется вовсе.
        ...(event.promptVersion > 0 ? { promptVersion: event.promptVersion } : {}),
      });
    },

    stagePrompt: segmentation.stagePrompt,
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

  registry.register('layout.analyze_coverage', createAnalyzeCoverageHandler(coverageDeps(options)));

  // Локальная детекция RF-DETR (ADR-0008): альтернатива задаче 7 при
  // `detection.provider='local'` — растеризация PDF на воркере и ONNX-инференс
  // на CPU вместо похода в RD WEB. Регистрируется здесь и безусловно, как и
  // остальные стадии: обработчик без регистрации выглядит зависшим конвейером.
  registry.register(
    'layout.detect_local',
    createLocalDetectionHandler(localDetectionDeps(options)),
  );
  registry.register(
    'page.orientation_probe',
    createOrientationProbeHandler(orientationProbeDeps(options)),
  );

  // Задачи 10–13 (§12): цикл сверки, запуск OCR, поллинг и однократный забор
  // экспорта. Регистрируются здесь и безусловно — по той же причине, что и
  // задачи разметки: обработчик без регистрации выглядит зависшим конвейером.

  // Задачи `vlm.*` (ADR-0007): распознавание через OpenRouter VLM по кропам
  // блоков — альтернатива задачам 10–13 при `recognition.provider=openrouter_vlm`.
  // Регистрируются безусловно, тем же принципом: отсутствие VLM-порта или
  // растеризатора — честный отказ КОНКРЕТНОГО прогона, а не отсутствующий
  // обработчик.
  const vlmRecognition = vlmRecognitionDeps(options);
  registry.register('vlm.start_recognition', createVlmStartHandler(vlmRecognition));
  registry.register('vlm.recognize_page', createVlmRecognizePageHandler(vlmRecognition));
  registry.register('vlm.finalize_run', createVlmFinalizeHandler(vlmRecognition));

  // Задачи `rd.sync_*`: снимок исполнительной документации в RD WEB (контракт
  // document-sync v1) — вторая ветка распознавания, ставится при
  // `recognition.provider=rdweb`. Регистрируются безусловно, тем же принципом,
  // что и остальные: ненастроенная интеграция — это честный отказ КОНКРЕТНОГО
  // прогона, а не отсутствующий обработчик, который выглядит зависшим
  // конвейером.
  const execSync = execSyncDeps(options);
  registry.register('rd.sync_prepare', createSyncPrepareHandler(execSync));
  registry.register('rd.sync_init', createSyncInitHandler(execSync));
  registry.register('rd.sync_upload', createSyncUploadHandler(execSync));
  registry.register('rd.sync_complete', createSyncCompleteHandler(execSync));
  registry.register('rd.sync_poll', createSyncPollHandler(execSync, options.pollExecSync ?? {}));
  registry.register('rd.sync_fetch', createSyncFetchHandler(execSync));
  registry.register('rd.sync_finalize', createSyncFinalizeHandler(execSync));
  registry.register('rd.sync_resync', createSyncResyncHandler(execSync));

  // Задачи 14–19 (§12): классификация страниц, сборка документов, реквизиты,
  // реестр приложений, сверка и граф. Регистрируются здесь и безусловно — по
  // той же причине, что и остальные стадии: обработчик без регистрации
  // выглядит зависшим конвейером, а не отсутствующей возможностью.
  const segmentation = segmentationDeps(options);
  registry.register('doc.classify_pages', createClassifyPagesHandler(segmentation));
  registry.register('doc.segment', createSegmentHandler(segmentation));
  registry.register('doc.extract_fields', createExtractFieldsHandler(segmentation));
  registry.register('doc.extract_document', createExtractDocumentHandler(segmentation));
  registry.register('doc.extract_finalize', createExtractFinalizeHandler(segmentation));
  registry.register('doc.parse_registry', createParseRegistryHandler(segmentation));
  registry.register('doc.match_registry', createMatchRegistryHandler(segmentation));
  registry.register('graph.build', createGraphBuildHandler(segmentation));

  // Сверка описи передачи с комплектами папки (S20). Терминальная задача: она
  // ничего не ставит дальше и ничего не блокирует — её выход читает человек.

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
