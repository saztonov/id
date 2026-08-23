/**
 * Формы ответов `/api/v1/*`.
 *
 * Списаны с zod-схем маршрутов (`apps/api/src/modules/<модуль>/schemas.ts`), а не
 * придуманы: где схема отдаёт `nullable`, здесь `| null`, где `unknown` —
 * `unknown`. Перечисления берутся из `@id/contracts`, потому что их значения и
 * так общие, а вторая копия литералов разошлась бы молча.
 *
 * Проверки схемой на входе ответа здесь нет намеренно. Сервер уже валидирует
 * ОТВЕТ своей схемой, а второй рубеж в браузере превратил бы добавленное поле в
 * белый экран у пользователя — ровно та асимметрия «строгий вход, терпимый
 * выход», которая принята на S4.
 */
import type {
  ArtifactKind,
  AttentionFlag,
  BlockSource,
  BlockType,
  DetectorProvenance,
  LayoutRevisionState,
  MatchState,
  ProcessingStage,
  RecognitionStatus,
  Severity,
  ShapeType,
  UserRole,
  VerifyState,
  WorkflowStatus,
} from '@id/contracts';

// =====================================================================
// Сессия
// =====================================================================

export interface Me {
  authMode: 'oidc' | 'dev-stub' | 'local';
  user: {
    id: string;
    email: string | null;
    fullName: string;
    position: string | null;
    contractorId: string | null;
    isActive: boolean;
  };
  roles: UserRole[];
  scope: {
    kind: 'contractor' | 'general_contractor' | 'engineer' | 'manager' | 'admin';
    objectIds: string[] | null;
    contractorId: string | null;
  } | null;
  denial:
    'unknown-user' | 'inactive' | 'no-business-role' | 'contractor-without-organization' | null;
  /**
   * Требуется смена выданного пароля до любой работы в портале.
   *
   * Всегда `false` вне `AUTH_MODE=local`. Портал закрывает всё, кроме выхода и
   * формы смены, поэтому интерфейс обязан увести туда сам — иначе пользователь
   * получит 403 в первом же запросе данных и увидит его как ошибку.
   */
  mustChangePassword: boolean;
  session: { idleExpiresAt: string; absoluteExpiresAt: string };
}

/** Публичные признаки режима: доступны без входа. */
export interface AuthConfig {
  registrationEnabled: boolean;
  passwordMinLength: number;
}

export interface RegistrationRequest {
  id: string;
  email: string;
  fullName: string;
  position: string | null;
  createdAt: string;
  /** Заявитель выбрал пароль сам. */
  hasRequestedPassword: boolean;
}

// =====================================================================
// Файлы и рабочий документ
// =====================================================================

export interface SourceFile {
  id: string;
  revisionId: string;
  blobSha256: string;
  fileName: string;
  sortOrder: number;
  verifyState: VerifyState;
  verifyError: string | null;
  sizeBytes: number;
  mime: string;
  pageCount: number;
  createdAt: string;
  signatureProbe: unknown;
}

export interface UploadTicket {
  uploadId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}

export interface Bundle {
  id: string;
  revisionId: string;
  aggregateManifestHash: string;
  workingPdfBlobSha256: string;
  builderVersion: string;
  createdAt: string;
  pageCount: number;
}

export interface BundlePage {
  workingPageIndex: number;
  sourcePageId: string;
  sourceFileId: string;
  fileName: string;
  filePageIndex: number;
  widthPx: number;
  heightPx: number;
  rotation: number;
}

export interface BundleBuildResult {
  jobId: string | null;
  created: boolean;
  bundle: Bundle | null;
  aggregateManifestHash: string;
}

// =====================================================================
// Разметка (§7)
// =====================================================================

export interface LayoutRevision {
  id: string;
  revisionId: string;
  bundleId: string;
  revisionNo: number;
  state: LayoutRevisionState;
  blocksHash: string | null;
  version: number;
  detectorProfile: 'rf_detr' | 'full_page';
  manuallyEdited: boolean;
  frozenAt: string | null;
  createdAt: string;
}

export interface PageFlags {
  workingPageIndex: number;
  flags: AttentionFlag[];
}

export interface LayoutDetail extends LayoutRevision {
  pages: PageFlags[];
  blockCount: number;
}

export interface NormalizedCoords {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutBlock {
  id: string;
  layoutRevisionId: string;
  sourcePageId: string;
  workingPageIndex: number;
  blockType: BlockType;
  shapeType: ShapeType;
  coords: NormalizedCoords;
  points: { x: number; y: number }[];
  sortOrder: number;
  source: BlockSource;
  detectorProvenance: DetectorProvenance;
  /**
   * Уверенность детектора, 0..1, либо `null` — у ручных блоков и у блоков от
   * легаси-API RD WEB, чей ответ её не несёт. `null` означает «неизвестно», а
   * не «ноль», и показывается отдельно от числа.
   */
  detectionScore: number | null;
}

export interface LayoutBlockList {
  layoutRevisionId: string;
  version: number;
  items: LayoutBlock[];
}

export interface StartMarkupResult {
  layoutRevisionId: string;
  bundleId: string;
  created: boolean;
  jobId: string | null;
  jobCreated: boolean;
}

export interface BlockMutationResult {
  blockId: string;
  version: number;
}

export interface FreezeResult {
  layoutRevisionId: string;
  blocksHash: string;
  version: number;
  blockCount: number;
}

export interface DetectResult {
  layoutRevisionId: string;
  batches: number;
  jobIds: string[];
}

// =====================================================================
// Распознавание
// =====================================================================

export interface RecognitionRun {
  id: string;
  revisionId: string;
  layoutRevisionId: string;
  rdJobId: string | null;
  localLayoutHash: string;
  remoteLayoutHashBefore: string | null;
  remoteLayoutHashAfter: string | null;
  workingPdfSha256: string;
  settingsSnapshot: unknown;
  status: RecognitionStatus;
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, unknown>;
  warnings: unknown[];
  runDocumentClosedAt: string | null;
}

export interface RecognizeResult {
  recognitionRunId: string;
  created: boolean;
  jobId: string;
  jobCreated: boolean;
}

export interface Artifact {
  id: string;
  recognitionRunId: string;
  kind: ArtifactKind;
  artifactSha256: string;
  byteSize: number;
}

export interface PageText {
  id: string;
  sourcePageId: string;
  workingPageIndex: number | null;
  artifactVersionId: string;
  textMd: string;
  textSha256: string;
  offsetConvention: 'utf16-code-unit';
}

export interface BlockResult {
  layoutBlockId: string;
  resultType: string;
  contentMd: string | null;
  modelId: string | null;
  confidence: number | null;
  isCurrent: boolean;
}

// =====================================================================
// Документы, реквизиты, реестр
// =====================================================================

export interface LogicalDocument {
  id: string;
  revisionId: string;
  docTypeCode: string | null;
  ordinal: number;
  title: string | null;
  folderGroup: string | null;
  typeConfidence: number | null;
  boundaryConfidence: number | null;
  needsReview: boolean;
  isConfirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  version: number;
  pageCount: number;
}

export interface DocumentPage {
  sourcePageId: string;
  revisionOrdinal: number;
  sortOrder: number | null;
  pageRoleCode: string | null;
  needsReview: boolean;
}

export interface DocumentDetail extends LogicalDocument {
  pages: DocumentPage[];
  relations: { parentDocumentId: string; childDocumentId: string; relation: string }[];
}

export interface FieldValue {
  id: string;
  documentId: string;
  fieldCode: string;
  valueText: string | null;
  valueDate: string | null;
  valueNum: string | null;
  valueJson: unknown;
  confidence: number | null;
  isVerified: boolean;
  extractorVersion: string;
  pageTextVersionId: string | null;
  charSpan: { start: number; end: number } | null;
  quote: string | null;
  extractedBy: string;
}

export interface PageAccounting {
  items: {
    sourcePageId: string;
    revisionOrdinal: number;
    documentId: string | null;
    sortOrder: number | null;
    pageRoleCode: string | null;
    reason: string | null;
    needsReview: boolean;
  }[];
  unaccounted: { sourcePageId: string; sourceFileId: string; revisionOrdinal: number }[];
  counts: { assigned: number; unassigned: number; unaccounted: number };
}

export interface RegistryRow {
  id: string;
  documentId: string;
  rowNo: number;
  sectionTitle: string | null;
  docNameRaw: string;
  docNoRaw: string | null;
  orgRaw: string | null;
  docNoNorm: string | null;
  docNoFolded: string | null;
  validFrom: string | null;
  validTo: string | null;
  issuedAt: string | null;
  matchedDocumentId: string | null;
  matchScore: number | null;
  matchState: MatchState;
}

export interface PageClassification {
  sourcePageId: string;
  revisionOrdinal: number;
  label: string;
  docTypeCode: string | null;
  typeOutcome: string;
  observedTitle: string | null;
  pageRoleCode: string | null;
  parentRef: string | null;
  confidence: number | null;
  reason: string | null;
  source: string;
  pageTextVersionId: string | null;
  charSpan: { start: number; end: number } | null;
  quote: string | null;
  alternatives: string[];
  ambiguous: boolean;
}

/** Метка страницы, поставленная инженером вручную (§8.2, фаза 3). */
export interface ManualPageLabel {
  revisionId: string;
  sourcePageId: string;
  label: string;
  docTypeCode: string | null;
  pageRoleCode: string | null;
  source: 'manual';
}

// =====================================================================
// Проверка
// =====================================================================

export interface ValidationRun {
  id: string;
  revisionId: string;
  rulesetVersionId: string;
  sectionProfileId: string | null;
  objectRuleProfileId: string | null;
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, unknown>;
}

export interface Finding {
  id: string;
  validationRunId: string;
  ruleCode: string;
  severity: Severity;
  state: 'open' | 'resolved' | 'waived' | 'undetermined';
  origin: 'deterministic' | 'llm' | 'external_unavailable';
  isBlocking: boolean;
  targetType: string;
  targetId: string | null;
  sourcePageId: string | null;
  blockId: string | null;
  message: string;
  hint: string | null;
}

export interface RuleCatalogEntry {
  code: string;
  title: string;
  docTypeCode: string | null;
  level: string;
  kind: string;
  defaultSeverity: Severity;
  defaultBlocking: boolean;
  requiresSectionProfile: boolean;
  requiresExternalRegistry: string | null;
  defaultParams: Record<string, unknown>;
}

// =====================================================================
// Согласование
// =====================================================================

export interface RevisionWorkflow {
  id: string;
  workId: string;
  revisionNo: number;
  status: WorkflowStatus;
  parentRevisionId: string | null;
  aggregateManifestHash: string | null;
  version: number;
  submittedAt: string | null;
  decidedAt: string | null;
  returnReason: string | null;
}

export interface WorkflowState {
  revision: RevisionWorkflow;
  readiness: {
    fileCount: number;
    filesNotOk: number;
    hasBundle: boolean;
    documentCount: number;
    unconfirmedDocuments: number;
    unmaterializedDocuments: number;
    openBlockingFindings: number;
    finishedValidationRuns: number;
  };
  submitBlockers: string[];
  approveBlockers: string[];
  actions: {
    id: string;
    revisionId: string;
    actorUserId: string;
    action: string;
    comment: string | null;
    at: string;
  }[];
}

export interface WorkflowResult {
  revision: RevisionWorkflow;
  nextRevisionId: string | null;
  manifestMatchesParent: boolean | null;
  jobId: string | null;
  jobCreated: boolean;
}

export interface ArchiveState {
  revisionId: string;
  state: 'absent' | 'pending' | 'ready';
  archive: {
    sha256: string;
    byteSize: number;
    entryCount: number;
    builderVersion: string;
    createdAt: string;
  } | null;
}

// =====================================================================
// Наблюдаемость ревизии
// =====================================================================

export interface StageSummary {
  stage: ProcessingStage;
  attempts: number;
  succeeded: number;
  failed: number;
  inFlight: number;
  pending: number;
  totalDurationMs: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProcessingStatus {
  revisionId: string;
  stage: ProcessingStage;
  queued: number;
  running: number;
  dead: number;
  attempts: number;
  totalDurationMs: number;
  elapsedMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  stages: StageSummary[];
  jobTypes: {
    jobType: string;
    stage: ProcessingStage | null;
    attempts: number;
    succeeded: number;
    failed: number;
    leaseExpired: number;
    inFlight: number;
    totalDurationMs: number;
    firstStartedAt: string | null;
    lastFinishedAt: string | null;
    lastErrorClass: string | null;
    lastErrorMessage: string | null;
  }[];
}

// =====================================================================
// Справочники
// =====================================================================

/**
 * Сущности справочников совпадают с контрактами один в один, поэтому
 * переобъявления здесь нет: вторая копия полей разошлась бы с первой молча —
 * ровно тот дефект, из-за которого на S2 схема Drizzle сделана производной.
 */
export type {
  CatalogImportProblem,
  CatalogImportStatus,
  CatalogImportTarget,
  CatalogImportVerdict,
  ConstructionObject,
  Counterparty,
  CounterpartyKindEntry,
  ObjectContractor,
  ObjectSection,
  Section,
  SectionProfile,
} from '@id/contracts';

/** Карточка массового ввода справочника (§3.2, миграция 0027). */
export interface CatalogImport {
  id: string;
  target: 'counterparties' | 'construction_objects';
  status: 'uploading' | 'parsing' | 'ready' | 'applied' | 'failed' | 'expired';
  fileName: string;
  sizeBytes: number | null;
  rowCount: number;
  errorCount: number;
  duplicateCount: number;
  createdCount: number;
  failureReason: string | null;
  createdBy: string;
  createdAt: string;
  parsedAt: string | null;
  appliedAt: string | null;
  expiresAt: string;
}

/** Строка предпросмотра: то, что человек утверждает перед созданием карточек. */
export interface CatalogImportRow {
  id: string;
  rowNo: number;
  raw: Record<string, string>;
  verdict: 'create' | 'duplicate' | 'error';
  problems: { column: string | null; code: string; message: string }[];
  createdEntityId: string | null;
}

export interface DocType {
  code: string;
  name: string;
  shortName: string;
  groupCode: string;
  kind: string;
  hasAnnexes: boolean;
  matchHints: unknown;
  fieldSchema: unknown;
  isSystem: boolean;
  isFallback: boolean;
  sortOrder: number;
  /** Эффективное значение: базовый каталог активен, пока не отключён наложением. */
  isActive: boolean;
  /** Значения отличаются от поставляемых с релизом. */
  hasOverride: boolean;
}

export interface DocTypeCandidate {
  id: string;
  observedTitleNorm: string;
  observedTitleSample: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleRevisionId: string | null;
  sampleSourcePageId: string | null;
  status: 'new' | 'reviewing' | 'mapped' | 'ignored';
  mappedDocTypeCode: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface RdDocument {
  id: string;
  objectId: string;
  cipher: string;
  revision: string | null;
  name: string | null;
  designerId: string | null;
  isActive: boolean;
}

// =====================================================================
// Администрирование
// =====================================================================

export interface PortalUser {
  id: string;
  email: string | null;
  fullName: string;
  position: string | null;
  isActive: boolean;
  contractorId: string | null;
  roles: UserRole[];
  createdAt: string;
  /**
   * Состояние локальных учётных данных; `null` — пароля нет.
   *
   * Всегда `null` вне `AUTH_MODE=local`. Отличает заведённого пользователя от
   * того, кому нечем войти, а заблокированного перебором — от отключённого.
   */
  local: {
    mustChangePassword: boolean;
    passwordChangedAt: string;
    lockedUntil: string | null;
  } | null;
}

export interface UserCard {
  user: PortalUser;
  objectIds: string[];
}

export interface AppSetting {
  key: string;
  title: string;
  value: unknown;
  isDefault: boolean;
  managedBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SecretReference {
  key: string;
  reference: string;
  configured: boolean;
  masked: string | null;
}

export interface IntegrationStatus {
  name: string;
  status: 'configured' | 'incomplete' | 'disabled';
  missing: string[];
  verified: false;
}

export interface SettingsView {
  settings: AppSetting[];
  secrets: SecretReference[];
  integrations: IntegrationStatus[];
}

export interface PromptTemplate {
  id: string;
  code: string;
  version: number;
  stage: string;
  docTypeCode: string | null;
  state: 'draft' | 'test' | 'published' | 'archived';
  systemPrompt: string;
  userTemplate: string;
  outputSchema: unknown;
  modelOverride: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RulesetVersion {
  id: string;
  version: string;
  state: 'draft' | 'published';
  publishedAt: string | null;
  publishedBy: string | null;
  notes: string | null;
  createdAt: string;
  ruleCount: number;
  isActive: boolean;
}

export interface RulesetRule {
  ruleCode: string;
  isEnabled: boolean;
  severity: Severity;
  isBlocking: boolean;
  params: unknown;
}

export interface RuleDefinition {
  code: string;
  title: string;
  docTypeCode: string | null;
  level: string;
  kind: string;
  defaultSeverity: Severity;
  waiverRoles: UserRole[];
}

/**
 * Версия набора вместе со снимком правил.
 *
 * Снимок отдаётся отдельным запросом, а не в списке: у опубликованной версии он
 * неизменяем и может содержать сотни строк, и таскать его в каждой строке
 * таблицы значило бы грузить весь реестр ради колонки «правил в снимке».
 */
export interface RulesetDetail {
  version: RulesetVersion;
  rules: RulesetRule[];
}

/** Снимок правила для публикации набора. */
export interface RulesetRuleInput {
  ruleCode: string;
  isEnabled: boolean;
  severity: Severity;
  isBlocking: boolean;
  params?: unknown;
}

/**
 * Результат перехода состояния промта.
 *
 * `kind` приходит от автомата на сервере (`modules/admin/governance.ts`), а не
 * выводится клиентом из пары «было → стало»: откат и публикация различаются
 * последствиями, и называть их обязан тот, кто их выполнил.
 */
export interface PromptTransition {
  template: PromptTemplate;
  kind: 'promote' | 'demote' | 'publish' | 'rollback' | 'archive';
  archivedTemplateId: string | null;
}

export interface JobView {
  id: string;
  type: string;
  queue: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  priority: number;
  nextRunAt: string;
  lockedBy: string | null;
  lockedUntil: string | null;
  lastError: string | null;
  dedupeKey: string | null;
  revisionId: string | null;
  createdAt: string;
  updatedAt: string;
  isDead: boolean;
}

export interface JobRunView {
  id: string;
  jobId: string | null;
  jobType: string;
  revisionId: string | null;
  requestId: string | null;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: string | null;
  errorClass: string | null;
  errorMessage: string | null;
}

export interface QueueSnapshot {
  depths: { jobType: string; status: string; count: number }[];
  dead: { jobType: string; count: number }[];
}

/**
 * Запись журнала аудита. Адреса (`ip`) в ответе нет — так решено на стороне
 * API: он остаётся в таблице для разбора инцидента, но экрану не отвечает ни на
 * один вопрос, а это ПДн.
 */
export interface AuditEntry {
  id: number;
  at: string;
  actorUserId: string | null;
  actorEmailHmac: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  objectId: string | null;
  payload: unknown;
  requestId: string | null;
}

/**
 * Журнал ошибок (§11).
 *
 * `events` — число СОБЫТИЙ за выбранный период, из почасовых бакетов.
 * `signatures` — сколько разных отпечатков отнесено к этой проблеме. Числа
 * примеров в строке нет намеренно: примеры прорежены политикой, и рядом с
 * частотой такое число читалось бы как её уточнение.
 */
export interface ErrorIssue {
  id: string;
  title: string;
  status: 'new' | 'ack' | 'resolved';
  priority: string;
  isSynthetic: boolean;
  source: string;
  execution: string;
  domain: string;
  pipelineStage: string | null;
  severity: string;
  firstSeenAt: string;
  lastSeenAt: string;
  firstRelease: string | null;
  lastRelease: string | null;
  assigneeUserId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  events: number;
  signatures: number;
}

export interface ErrorSignature {
  fingerprint: string;
  algoVersion: number;
  errorClass: string;
  messageTemplate: string;
  topFrame: string | null;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Диагностический пример. Их число НЕ равно числу событий — см. `ErrorIssue`. */
export interface ErrorSample {
  id: number;
  at: string;
  fingerprint: string;
  source: string;
  execution: string;
  domain: string;
  pipelineStage: string | null;
  severity: string;
  release: string | null;
  requestId: string | null;
  clientEventId: string | null;
  userId: string | null;
  route: string | null;
  statusCode: number | null;
  errorCode: string | null;
  objectId: string | null;
  revisionId: string | null;
  jobId: string | null;
  jobType: string | null;
  attempt: number | null;
  repeatCount: number;
  context: unknown;
}

export interface ErrorIssueAction {
  id: number;
  at: string;
  actorUserId: string | null;
  action: string;
  payload: unknown;
}

export interface ErrorIssueDetail {
  issue: ErrorIssue;
  signatures: ErrorSignature[];
  samples: ErrorSample[];
  actions: ErrorIssueAction[];
}

export interface ErrorSeriesPoint {
  bucketAt: string;
  release: string;
  events: number;
}

/** Три величины названы по отдельности: подменять их друг другом нельзя. */
export interface ErrorJournalSummary {
  from: string;
  to: string;
  issues: number;
  newIssues: number;
  events: number;
  samples: number;
  byDomain: { domain: string; events: number }[];
  bySource: { source: string; events: number }[];
}

export type ErrorIssueActionInput =
  | { action: 'acknowledge'; comment?: string }
  | { action: 'comment'; comment: string }
  | {
      action: 'resolve';
      rootCause: string;
      resolution: string;
      resolutionType: 'fixed' | 'wontfix' | 'duplicate' | 'external' | 'not_reproducible';
      fixedInRelease?: string;
    }
  | { action: 'reopen'; comment: string }
  | { action: 'assign'; assigneeUserId: string | null };

/** Маршрут приёма ошибок браузера (§11). */
export const CLIENT_ERROR_PATH = '/api/v1/client-errors';

/**
 * Обстоятельство, при котором ошибка возникла в браузере.
 *
 * Это НЕ классификация журнала — её ставит сервер. Здесь только то, чего сервер
 * знать не может: упало при отрисовке, в необработанном промисе или в
 * обработчике события. По нему видно, почему у отчёта может не быть стека.
 */
export type ClientErrorKind = 'render' | 'unhandled_rejection' | 'window_error' | 'manual';

export interface ClientErrorReport {
  name: string;
  message: string;
  kind: ClientErrorKind;
  clientEventId: string;
  repeatCount: number;
  stack?: string;
  componentStack?: string;
  buildId?: string;
  url?: string;
}

/**
 * Срез обратной связи конвейера (§11, ADR-0010).
 *
 * `rate` равен `null`, когда знаменатель неизвестен — у стадий без вызова
 * модели. Это НЕ то же самое, что ноль: ноль читается как «дефектов нет».
 */
export interface PipelineFeedbackRow {
  reasonCode: string;
  pipelineStage: string | null;
  promptCode: string | null;
  promptVersion: number | null;
  model: string | null;
  docTypeCode: string | null;
  defects: number;
  calls: number | null;
  rate: number | null;
  medianScore: number | null;
}

export interface PipelineFeedbackSummary {
  from: string;
  to: string;
  rows: PipelineFeedbackRow[];
}

export interface PipelineFeedbackEvent {
  id: number;
  at: string;
  feedbackType: string;
  reasonCode: string;
  severity: string;
  revisionId: string | null;
  recognitionRunId: string | null;
  sourcePageId: string | null;
  workingPageIndex: number | null;
  layoutBlockId: string | null;
  fieldCode: string | null;
  docTypeCode: string | null;
  pipelineStage: string | null;
  provider: string | null;
  model: string | null;
  promptCode: string | null;
  promptVersion: number | null;
  detectorModelVersion: string | null;
  appRelease: string | null;
  score: number | null;
  observed: unknown;
  expected: unknown;
  requestId: string | null;
}

/** Всплеск значимых отказов: счётчик по маршруту, а не запись на отказ. */
export interface HttpAnomalyRow {
  route: string;
  statusCode: number;
  problemSlug: string;
  count: number;
}

/** Медленная операция за период. `avgMs` считается из суммы, а не хранится. */
export interface SlowOperationRow {
  kind: string;
  target: string;
  count: number;
  maxMs: number;
  avgMs: number;
  thresholdMs: number;
  sampleRequestId: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
