/**
 * Публичная поверхность пакета `@id/api` для ВТОРОГО процесса — воркера.
 *
 * Портал — модульный монолит: API и воркер это один код и один образ с разными
 * точками входа (§2). Отсюда правило: движок задач, конфигурация и слой
 * наблюдаемости существуют в одном экземпляре, а `apps/worker` их использует, а
 * не повторяет. Второй экземпляр очереди — в воркере своя реализация захвата,
 * своя нормализация ошибок, свой разбор окружения — разошёлся бы с первым молча
 * и ровно в тот момент, когда конвейер начнёт терять задачи.
 *
 * Здесь именно поверхность, а не «всё подряд»: `buildApp()` не экспортируется
 * намеренно. Импорт этого модуля не должен тянуть в процесс воркера Fastify со
 * всеми плагинами — воркер не слушает HTTP, и загружать в него слой, которого
 * он не использует, значит увеличивать и время старта, и площадь отказа.
 * Точка входа API (`server.ts`) берёт `buildApp()` напрямую из `app.ts`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { Database } from './db/repositories/users.js';

export { createPool, closePool } from '@id/db';

export { loadEnv, EnvError, allowedModels, trustProxyOption } from './config/env.js';
export type { Env } from './config/env.js';

export { createLogger } from './observability/logger.js';
export type { AppLogger, LogLevel } from './observability/logger.js';
export { createMetrics, measureExternalCall } from './observability/metrics.js';
export type { Metrics } from './observability/metrics.js';
export {
  errorDigest,
  installProcessErrorHandlers,
  NoopErrorReporter,
  normalizeErrorMessage,
} from './observability/errors.js';
export type {
  ErrorAxes,
  ErrorDomain,
  ErrorEventContext,
  ErrorReporter,
  ErrorSource,
  SqlExecutor,
} from './observability/errors.js';
export { createErrorReporting, ErrorJournalWriter } from './observability/journal-writer.js';
export type { ErrorReporting } from './observability/journal-writer.js';
export { DbProcessingFeedbackSink, NoopProcessingFeedbackSink } from './observability/quality.js';
export type {
  FeedbackStage,
  ProcessingFeedbackEvent,
  ProcessingFeedbackSink,
} from './observability/quality.js';
export { instrumentPool } from './observability/db-timing.js';
export {
  childLogger,
  currentContext,
  newRequestId,
  runWithContext,
  tracePayload,
} from './observability/context.js';

export {
  classifyFailure,
  deferralOf,
  JobDeferredError,
  JobRunner,
  JobTimeoutError,
  LeaseLostError,
} from './jobs/runner.js';
export type { JobRunnerOptions } from './jobs/runner.js';
export { createMaintenanceRegistry, JobRegistry } from './jobs/registry.js';
export type { JobContext, JobHandler } from './jobs/registry.js';
export {
  backoffDelayMs,
  clampConcurrency,
  dedupeKeyFor,
  JOB_QUEUES,
  JOB_TYPES,
  jobDefinition,
  jobTypesOfQueue,
  queueOf,
  stageOf,
} from './jobs/types.js';
export type { JobPayload, JobQueue, JobType } from './jobs/types.js';

export {
  appendOutbox,
  appendRevisionEvent,
  computeProcessingStatus,
  enqueueSystemJob,
  readJobAutoContinue,
  publishOutboxBatch,
  queueSnapshot,
  reapExpiredLeases,
} from './db/repositories/jobs.js';
export type { Database } from './db/repositories/users.js';

/**
 * Поверхность для обработчиков стадий конвейера (§12).
 *
 * Воркер выполняет те же задачи над теми же данными, что и API, и потому ему
 * нужны те же три вещи: область видимости, репозитории и разбор PDF. Вторая
 * реализация любой из них разошлась бы с первой молча — так, что принятый при
 * загрузке файл отвергался бы конвейером без единого признака причины.
 *
 * `buildApp()` по-прежнему не экспортируется: HTTP-слой воркеру не нужен.
 */
export type { AuthScope } from './auth/scope.js';

export {
  createBundle,
  computeAggregateManifestHash,
  findBundle,
  findBundleByManifest,
  findSourceOfWorkingPage,
  listBundlePages,
  listBundles,
  loadBundlePlan,
  orderedParts,
} from './db/repositories/bundles.js';
export type {
  BundlePageView,
  BundlePlan,
  BundlePlanFile,
  BundleView,
  CreateBundleInput,
} from './db/repositories/bundles.js';

export {
  applyFullPageTextProfile,
  BLOCKS_HASH_VERSION,
  computeBlocksHash,
  createLayoutBlock,
  createRunDocument,
  deleteLayoutBlock,
  DEFAULT_LAYOUT_PROFILE_CODE,
  ensureDraftLayout,
  FALLBACK_LAYOUT_THRESHOLDS,
  findActiveLayoutProfile,
  findDraftLayout,
  findLayoutBlock,
  findLayoutRevision,
  findRunDocument,
  freezeLayout,
  importDetectedBlocks,
  listLayoutBlocks,
  listLayoutRevisions,
  listPageAttentionFlags,
  loadProfileForLayout,
  parseThresholds,
  replacePageWithFullPageBlock,
  replaceRunDocument,
  savePageAttentionFlags,
  updateLayoutBlock,
} from './db/repositories/layout.js';
export type {
  DetectedBlockInput,
  HashableBlock,
  ImportDetectionResult,
  LayoutBlockView,
  LayoutProfileView,
  LayoutRevisionView,
  LayoutThresholds,
  RunDocumentView,
  SaveFlagsOutcome,
} from './db/repositories/layout.js';

/**
 * Запуск разметки поверх готового рабочего документа.
 *
 * Наружу выведен ради задачи `layout.start` (S21): звено «сборка → разметка»
 * обязано делать ровно то же, что маршрут, и делать это ТЕМ ЖЕ кодом.
 */
export {
  enqueueDetectBatches,
  enqueueLocalDetectBatches,
  startMarkupOnBundle,
} from './modules/layout/start.js';
export type { StartMarkupResult } from './modules/layout/start.js';

export { analyzePages, unionArea } from './layout/attention.js';
export type { AnalyzedBlock, AnalyzedPage, PageAnalysis } from './layout/attention.js';

export {
  createRdWeb,
  DETECT_BATCH_LIMIT,
  firstAllowedProject,
  LegacyRdWebAdapter,
  RdWebClient,
  RdWebError,
  RDWEB_SERVICE,
  recognitionSelections,
  SUCCESSFUL_RECOGNITION_STATUSES,
  TERMINAL_RECOGNITION_STATUSES,
} from './integrations/rdweb/index.js';
export type {
  CreateRunDocumentInput,
  CreateRunDocumentResult,
  DesiredBlock,
  DetectPagesInput,
  DetectPagesResult,
  ExportPayload,
  RdWebPort,
  RecognitionSelection,
  RecognitionStatus,
  ReconcileLayoutResult,
  RemoteBlock,
  RemoteBlockResult,
  RemoteDocument,
  RemotePage,
} from './integrations/rdweb/index.js';

/** Разбор экспорта и сопоставление блоков (§5.2, шаги 7–8). */
export {
  EXPORT_ENTRY_HTML,
  EXPORT_ENTRY_MARKDOWN,
  EXPORT_ENTRY_QA,
  ExportFormatError,
  parseExportMarkdown,
  requireEntry,
} from './recognition/export.js';
export type { ExportBlockText, ExportPageText, ParsedExport } from './recognition/export.js';
export { geometryKey, matchBlocks } from './recognition/match.js';
export {
  isRedactableArtifactKind,
  redactAbsoluteUrls,
  redactArtifactContent,
  redactHtml,
  redactJson,
  redactMarkdown,
  REDACTABLE_ARTIFACT_KINDS,
  REDACTED_URL,
} from './recognition/redaction.js';
export type { Redacted, RedactableArtifactKind } from './recognition/redaction.js';
export type { MatchableBlock, MatchResult } from './recognition/match.js';
export { crc32, readZipEntries, writeZipStream, ZipError } from './lib/zip.js';
export type { ZipEntry, ZipSourceEntry } from './lib/zip.js';
export { buildXlsx } from './lib/xlsx.js';
export { readXlsxSheet, XlsxError, DEFAULT_XLSX_LIMITS } from './lib/xlsx-read.js';
export type { XlsxCell, XlsxLimits, XlsxRow, XlsxSheet } from './lib/xlsx-read.js';
export { parseCatalogImport, normalizeOrgName } from './catalog-import/parse.js';
export {
  applyCatalogImport,
  claimExpiredImports,
  createCatalogImport,
  failCatalogImport,
  findCatalogImport,
  findImportObjectKey,
  listCatalogImportRows,
  listCatalogImports,
  loadCatalogSnapshot,
  saveCatalogImportRows,
  startImportParsing,
} from './db/repositories/catalog-imports.js';
export type {
  CatalogImportRecord,
  CatalogImportRowRecord,
} from './db/repositories/catalog-imports.js';
export type {
  CatalogImportParseResult,
  CatalogSnapshot,
  ImportCell,
  ImportSheet,
  ImportSheetRow,
  ParsedImportRow,
} from './catalog-import/parse.js';

export {
  closeRunDocument,
  findArtifact,
  findRecognitionRun,
  findRunForLayout,
  finishRecognitionRun,
  insertBlockResultIdempotent,
  listArtifacts,
  listBlockResults,
  listPageTexts,
  listRecognitionRuns,
  listRunBlockEnvelopes,
  listRunBlockIds,
  listRunPages,
  markRunPage,
  mergeRunSettingsSnapshot,
  publishVlmRunResults,
  recordArtifact,
  saveRdJobId,
  saveRecognitionResults,
  saveRemoteHashBefore,
  scheduleRunRecoveryRound,
  seedRunPages,
  startRecognitionRun,
} from './db/repositories/recognition.js';
export type {
  ArtifactView,
  PageTextView,
  RecognitionRunStatus,
  RecognitionRunView,
  RunPageState,
  RunPageStatus,
} from './db/repositories/recognition.js';

/** Ветвление конвейера по настройкам портала (ADR-0007/0008). */
export {
  parseModelAllowlist,
  readAiDryRunOnly,
  readImmutabilityEnforced,
  readRecognitionSettings,
} from './config/portal-settings.js';
export type { RecognitionProviderSettings } from './config/portal-settings.js';

/** VLM-распознавание по кропам блоков (ADR-0007, план v3). */
export {
  RECOGNITION_PROMPT_CODES,
  RECOGNITION_PROMPT_DEFAULTS,
  recognitionPromptDefaultByCode,
  substitutePlaceholders,
} from './recognition/vlm/prompts.js';
export type {
  PromptSubstitutionContext,
  RecognitionPromptDefault,
} from './recognition/vlm/prompts.js';

/**
 * Встроенные тексты промптов стадий АНАЛИЗА — тот же приём, что у `recognize`.
 *
 * Отсутствие опубликованной версии перестало выключать LLM-ступень: сид-миграция
 * генерируется из тех же констант, поэтому «черновик» и «встроенный текст» —
 * одна строка.
 */
export {
  analysisPromptDefaultByStage,
  ANALYSIS_PROMPT_STAGES,
} from './prompts/analysis-defaults.js';
export type { AnalysisPromptDefault, AnalysisPromptStage } from './prompts/analysis-defaults.js';
export { schemaHash } from './recognition/vlm/schemas.js';
export { recognizeBlock } from './recognition/vlm/recognize-block.js';
export type {
  RecognizeBlockInput,
  RecognizeBlockPrompt,
  VlmBlockOutcome,
} from './recognition/vlm/recognize-block.js';
export { assembleRecognitionResult, RecognitionAssembleError } from './recognition/assemble.js';
export type {
  AssembleFrozenBlock,
  AssemblePageInput,
  AssembleRecognitionInput,
} from './recognition/assemble.js';

export { archiveKey, artifactKey, documentPdfKey, previewPageKey } from './storage/keys.js';
export type { ArtifactKind } from './storage/keys.js';

/**
 * Выдача (§12, задачи 22–23; §13).
 *
 * Экспортируется в воркер по той же причине, что и остальные репозитории: обе
 * задачи живут там, где остальные стадии конвейера, а второй реализации
 * репозитория быть не должно. В списке — ровно то, что воркер вызывает: выдача
 * нарезки и архива наружу (`findDerivedDocument`, `requireReadyArchive`) живёт
 * в HTTP-слое и импортируется им напрямую, а реэкспорт «на всякий случай»
 * превращает публичную границу пакета в свалку.
 */
export {
  findArchive,
  findReusableBundle,
  isContiguous,
  loadArchivePlan,
  loadMaterializationPlan,
  recordArchive,
  requireVisibleRevisionOfDocument,
  saveDerivedPdf,
} from './db/repositories/delivery.js';
export type {
  ArchivePlan,
  ArchiveView,
  MaterializationPlan,
  MaterializationTarget,
  RecordArchiveOutcome,
  SaveDerivedOutcome,
} from './db/repositories/delivery.js';

export {
  findFileContent,
  findRevisionForFiles,
  listSourceFiles,
  saveFileVerdict,
  saveSignatureProbe,
} from './db/repositories/files.js';
export type {
  FileContentRef,
  RevisionForFiles,
  SaveVerdictInput,
  SaveVerdictOutcome,
} from './db/repositories/files.js';

export { storableVerdict } from './modules/files/verify.js';

export { evaluatePdfFile, PDF_MIME, probePdf, sha256Hex } from './pdf/probe.js';
export type {
  FileQuarantineReason,
  FileVerdict,
  FileVerificationPolicy,
  PdfPageGeometry,
  PdfProbeResult,
  PdfSignatureFindings,
} from './pdf/probe.js';
export {
  assertPageCountMatches,
  assertWithinLimits,
  isPdfToolkitError,
  PDF_LIB_MAX_INPUT_BYTES,
  PDF_LIB_MAX_TOTAL_BYTES,
  PdfToolkitError,
  planWorkingPdf,
  selectPdfToolkit,
} from './pdf/toolkit.js';
export type {
  PdfToolkit,
  PdfToolkitKind,
  PdfToolkitSelection,
  WorkingPageMapping,
  WorkingPdfPart,
} from './pdf/toolkit.js';
export { createQpdfToolkit, detectQpdf } from './pdf/qpdf.js';
export { createPdfLibToolkit, loadPdfLibModule } from './pdf/pdf-lib.js';
export { RASTER_DPI, RasterizerError, readPngSize } from './pdf/raster.js';
export type {
  PageRasterizer,
  RasterizerKind,
  RenderPageInput,
  RenderPageResult,
} from './pdf/raster.js';
export { selectRasterizer } from './pdf/pdftoppm.js';
export { detectionManifestKey, detectionModelKey } from './storage/keys.js';
export { readDetectionSettings } from './config/portal-settings.js';
export type { DetectionProviderSettings } from './config/portal-settings.js';

/**
 * Сегментация, извлечение реквизитов и модель (§8, §10).
 *
 * Ровно та часть S8, которую исполняет ВОРКЕР. Алгоритмы фаз чистые и живут в
 * `segmentation/`, репозитории — в `db/repositories/`, провайдер модели — в
 * `llm/`; задачи 14–19 связывают их в `apps/worker`. Экспорт здесь — не
 * украшение поверхности: без него модуль остался бы кодом, который
 * компилируется, покрыт тестами и никогда не выполняется (урок S3).
 */
export { classifyPages, PHASE1_CONFIDENCE } from './segmentation/classify.js';
export type { Phase1Options } from './segmentation/classify.js';
export {
  classifyPageWithLlm,
  locateQuote,
  pagesNeedingLlm,
  QUOTE_NOT_MAPPED,
  SCHEMA_VERSION as SEGMENTATION_SCHEMA_VERSION,
} from './segmentation/llm-classify.js';
export type { LlmClassifyDeps, LlmClassifyOutcome } from './segmentation/llm-classify.js';
/** ИИ-проверка заполнения (S21): разбор ответа модели и её промт. */
export {
  LLM_REVIEW_SCHEMA_VERSION,
  REVIEW_QUOTE_NOT_MAPPED,
  reviewDocumentWithLlm,
} from './checks/llm-review.js';
export type { LlmReviewDeps, LlmReviewOutcome, ReviewDocument } from './checks/llm-review.js';
export { LLM_REVIEW_PROMPT, renderReviewUserPrompt } from './checks/llm-review-prompt.js';

export {
  EXTRACT_QUOTE_NOT_MAPPED,
  EXTRACT_SCHEMA_VERSION,
  extractFieldsWithLlm,
  llmFieldsFor,
} from './segmentation/llm-extract.js';
export type { ExtractPage, LlmExtractDeps, LlmExtractOutcome } from './segmentation/llm-extract.js';
export {
  BOUNDARY_CONFIDENCE_CEILING,
  CONFIDENT_BOUNDARY,
  decodeSegmentation,
} from './segmentation/decoder.js';
export {
  FIELD_EXTRACT_PROMPT,
  findSectionMarkers,
  PAGE_CLASSIFY_PROMPT,
  promptDocTypeCodes,
  renderExtractUserPrompt,
  renderUserPrompt,
  SECTION_MARKERS,
} from './segmentation/prompts.js';
export type { PromptText } from './segmentation/prompts.js';
export { normalizeRegistryName, parseAnnexRegistry } from './segmentation/registry.js';
export type {
  RegistryPageInput,
  RegistryParseInput,
  RegistryParseResult,
} from './segmentation/registry.js';
export { matchRegistryRows } from './segmentation/match.js';
export type {
  MatchableDocument,
  MatchRegistryResult,
  RegistryMatch as RegistryMatchResult,
} from './segmentation/match.js';

/**
 * Разбор описи передачи папки и сопоставление её групп с комплектами (S20).
 *
 * Это НЕ реестр приложений внутри АОСР (`parseAnnexRegistry` выше): другой
 * документ, другие формы, другая единица сверки. Общее у них — только разметка,
 * вынесенная в `md-table.ts` и `registry-cells.ts`.
 */
export {
  matchTransferGroups,
  parseTransferRegistry,
  TRANSFER_MATCHER_VERSION,
  TRANSFER_PARSER_VERSION,
} from './segmentation/transfer-registry.js';
export type {
  ParsedTransferGroup,
  ParsedTransferHeader,
  ParsedTransferRow,
  TransferForm,
  TransferGroupCandidate,
  TransferGroupMatch,
  TransferGroupsOutcome,
  TransferPageInput,
  TransferParseResult,
} from './segmentation/transfer-registry.js';
export {
  extractBaseFields,
  extractFields,
  extractTypeFields,
  LLM_ONLY_BASE_FIELDS,
} from './segmentation/extract.js';
export type { ExtractionInput, ExtractionPage } from './segmentation/extract.js';
export type {
  ClassificationSource,
  DecodedDocument,
  DecodedPage,
  DecodedUnassigned,
  ExtractedField,
  ManualLabel,
  PageClassification,
  PageInput,
  PageLabel,
  ParsedRegistryRow,
  Segmentation,
  SegmentationBlockType,
  TextEvidence,
  TypeOutcome,
} from './segmentation/types.js';

export {
  applySegmentation,
  confirmDocument,
  filterDocumentsOfRevision,
  findLogicalDocument,
  listDocumentRelations,
  listFieldValues,
  listLogicalDocuments,
  listPageAssignments,
  listPageClassifications,
  listRegistryRows,
  listUnaccountedPages,
  loadSegmentationPages,
  savePageClassifications,
  saveDocumentRelations,
  saveFieldValues,
  saveRegistryMatches,
  saveRegistryRows,
} from './db/repositories/documents.js';
export type {
  ApplySegmentationInput,
  ApplySegmentationOutcome,
  DocumentFieldValue,
  DocumentRelationInput,
  FieldValueView,
  LogicalDocumentView,
  PageAssignmentView,
  PageClassificationView,
  RegistryMatch,
  RegistryRowView,
  SegmentationInput,
  SegmentationPageRow,
} from './db/repositories/documents.js';
export {
  listDocumentsOfRevisions,
  listFieldValuesOfRevisions,
} from './db/repositories/documents.js';

/**
 * Навигация и сверка описи: то, что нужно задаче `registry.reconcile` (S20).
 *
 * Репозиторий навигации до S20 в этой поверхности не значился — воркер с
 * реестрами дела не имел. Теперь имеет, и нужное отдаётся поимённо, а не
 * `export *`: воркеру незачем уметь передавать папку.
 */
export {
  fillWorkPeriodIfEmpty,
  findRegistry,
  findRegistryFile,
  findWork,
  listRegistryComplectRevisions,
} from './db/repositories/navigation.js';
export type { RegistryComplectRevision } from './db/repositories/navigation.js';
export {
  findRegistryReconciliation,
  findWorkReconciliation,
  reviewReconciliation,
  saveReconciliation,
} from './db/repositories/reconciliation.js';
export type {
  RegistryReconciliationView,
  SaveReconciliationInput,
  WorkReconciliationView,
} from './db/repositories/reconciliation.js';

export { observeDocTypeCandidate, normalizeObservedTitle } from './db/repositories/catalog.js';
/** Наименование организации нужно сверке описи: опись печатает его в графе. */
export { findCounterparty } from './db/repositories/catalog.js';

/**
 * Проверки §9: сборка графа, прогон и замечания.
 *
 * Экспортируется в воркер, потому что задачи 20–21 живут там же, где остальные
 * стадии конвейера, и второй реализации репозитория быть не должно. В списке —
 * ровно то, что воркер вызывает: реэкспорт «на всякий случай» превращает
 * публичную границу пакета в свалку, где не отличить используемое от забытого.
 */
export { assertRuleRegistryConsistent } from './checks/startup.js';
export {
  KNOWN_TYPE_MIN_CONFIDENCE,
  finishValidationRun,
  listFindings,
  listRuleDefinitionCodes,
  listValidationRuns,
  loadCheckGraph,
  loadActiveRulesetSnapshot,
  loadRunJournal,
  saveDerivedMaterials,
  saveFindings,
  saveLlmFindings,
  saveRunJournal,
  startValidationRun,
} from './db/repositories/checks.js';
export type {
  FindingView,
  RuleExecutionJournal,
  RulesetSnapshot,
  ValidationSummary,
} from './db/repositories/checks.js';
export { listPromptTemplates } from './db/repositories/admin.js';
export type { PromptTemplateRow } from './db/repositories/admin.js';

export {
  createAiSpendReader,
  createLlmProvider,
  createVlmProvider,
  LlmBlockedProviderError,
  LlmBudgetError,
  LlmDisabledError,
  LlmError,
  LlmModelNotAllowedError,
  LlmPayloadTooLargeError,
  LlmProtocolError,
  LlmRateLimitError,
  LlmRecordingMissingError,
  LlmTimeoutError,
  LlmTransportError,
  ProxyLlmProvider,
  ProxyVlmProvider,
  RecordedLlmProvider,
  RecordedVlmProvider,
} from './llm/index.js';
export type {
  LlmAttempt,
  LlmPort,
  LlmProviderName,
  LlmRequest,
  LlmResponse,
  LlmStage,
  RecordedBehaviour,
  VlmDeps,
  VlmImage,
  VlmJsonSchemaFormat,
  VlmPort,
  VlmRecordedResponse,
  VlmRequest,
  VlmResponse,
  VlmStage,
} from './llm/index.js';
export { buildEffectivePrompt, cacheKey, promptHash } from './llm/prompt.js';
export {
  buildVlmCanonicalInput,
  vlmInputHash,
  VLM_PROMPT_CANON_VERSION,
} from './llm/vlm-prompt.js';
export { listAiRuns, monthlyAiSpend, recordAiRun } from './db/repositories/ai-runs.js';

export {
  createStorage,
  instrumentStorage,
  isStorageError,
  StorageError,
} from './storage/provider.js';
export type { StorageProvider } from './storage/provider.js';
export { blobKey } from './storage/keys.js';

/**
 * Обёртка Drizzle над пулом.
 *
 * Существует ради того, чтобы воркер не создавал экземпляр Drizzle сам: в
 * монорепозитории у двух воркспейсов могут оказаться два физических экземпляра
 * одной библиотеки, и тогда объект, собранный в воркере, приезжал бы в код API
 * из другой копии модуля. Одна фабрика на оба процесса снимает вопрос целиком.
 */
export function createDatabase(pool: Pool): Database {
  return drizzle(pool);
}
