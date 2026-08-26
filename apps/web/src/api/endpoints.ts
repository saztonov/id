/**
 * Типизованные вызовы `/api/v1/*`.
 *
 * Один модуль на все маршруты намеренно: расхождение с фактическим API ловится
 * чтением одного файла, а не обходом экранов. Пути записаны так же, как они
 * объявлены в `apps/api/src/modules/<модуль>/routes.ts`, и ни один из них не
 * придуман — маршрут, которого нет, живёт в `navigation.ts` и помечен как
 * ожидаемый.
 *
 * Мутации, у которых сервер требует `If-Match`, принимают версию обязательным
 * аргументом, а не опциональным: пропуск заголовка даёт 400 «требуется
 * If-Match», и лучше, когда это ловит компилятор.
 */
import { get, newIdempotencyKey, request, type ApiResponse } from './http.js';
import type {
  AuthConfig,
  RegistrationRequest,
  AppSetting,
  Artifact,
  ArchiveState,
  AuditEntry,
  ErrorIssue,
  ErrorIssueActionInput,
  ErrorIssueDetail,
  ErrorJournalSummary,
  ErrorSample,
  ErrorSeriesPoint,
  PipelineFeedbackEvent,
  PipelineFeedbackSummary,
  HttpAnomalyRow,
  SlowOperationRow,
  BlockMutationResult,
  BlockResult,
  Bundle,
  BundleBuildResult,
  BundlePage,
  ConstructionObject,
  Counterparty,
  DetectResult,
  CatalogImport,
  CatalogImportRow,
  CounterpartyKindEntry,
  DocType,
  DocTypeCandidate,
  DocumentDetail,
  FieldValue,
  CheckReport,
  FindingList,
  JobRunView,
  JobView,
  LayoutBlock,
  LayoutBlockList,
  LayoutDetail,
  LayoutRevision,
  LogicalDocument,
  ManualPageLabel,
  Me,
  NormalizedCoords,
  ObjectContractor,
  ObjectSection,
  Page,
  PageAccounting,
  PageClassification,
  PageText,
  PortalUser,
  ProcessingStatus,
  PromptTemplate,
  PromptTransition,
  QueueSnapshot,
  RdDocument,
  RecognitionRun,
  RecognizeResult,
  RegistryRow,
  RuleCatalogEntry,
  RuleDefinition,
  RulesetDetail,
  RulesetRuleInput,
  RulesetVersion,
  Section,
  SectionProfile,
  SettingsView,
  SourceFile,
  StartMarkupResult,
  UploadTicket,
  UserCard,
  ValidationRun,
  WorkflowResult,
  WorkflowState,
} from './types.js';
import type { BlockType, ShapeType, UserRole } from '@id/contracts';

const V1 = '/api/v1';

// =====================================================================
// Сессия
// =====================================================================

export const session = {
  me: () => get<Me>('/me'),
  /**
   * Выход: локальная сессия отзывается, `endSessionUrl` ведёт к провайдеру.
   *
   * В режиме `local` провайдера нет и адрес приходит `null` — переходить некуда,
   * достаточно вернуться на главную.
   */
  logout: () => request<{ endSessionUrl: string | null }>('POST', '/auth/logout'),
  loginUrl: (returnTo: string) => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
};

// =====================================================================
// Локальный вход (AUTH_MODE=local)
// =====================================================================

/**
 * Маршруты существуют только при `AUTH_MODE=local`; в остальных режимах их нет
 * в приложении вовсе. Доступность регистрации сообщает `config()`, а не код
 * ответа на попытку: «404 на POST» и «регистрация выключена» — не одно и то же
 * для интерфейса.
 */
export const auth = {
  config: () => get<AuthConfig>(`${V1}/auth/config`),
  login: (email: string, password: string, returnTo?: string) =>
    request<{ redirectTo: string }>('POST', `${V1}/auth/login`, {
      body: { email, password, ...(returnTo === undefined ? {} : { returnTo }) },
    }).then((response) => response.data),
  register: (input: { email: string; fullName: string; position?: string; password: string }) =>
    request<{ status: 'pending-activation' }>('POST', `${V1}/auth/register`, {
      body: input,
    }).then((response) => response.data),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: true }>('POST', `${V1}/auth/password`, {
      body: { currentPassword, newPassword },
    }).then((response) => response.data),
};

// =====================================================================
// Файлы (§4.2)
// =====================================================================

export interface CreateWorkWithFileInput {
  readonly objectId: string;
  readonly sectionCode: string;
  readonly title: string;
  /** Исполнитель. Задают все, кроме подрядчика: ему сервер берёт свою организацию. */
  readonly contractorId?: string | undefined;
  readonly fileName: string;
  readonly sizeBytes: number;
}

export interface CreatedWorkWithFile {
  readonly workId: string;
  readonly revisionId: string;
  readonly upload: UploadTicket;
}

export const files = {
  list: (revisionId: string) =>
    get<{ items: SourceFile[] }>(`${V1}/revisions/${revisionId}/files`).then((r) => r.items),

  initUpload: (revisionId: string, fileName: string, sizeBytes: number) =>
    request<UploadTicket>('POST', `${V1}/revisions/${revisionId}/files/upload/init`, {
      body: { fileName, sizeBytes },
    }).then((r) => r.data),

  /**
   * Комплект и первый файл одним запросом.
   *
   * Живёт здесь, а не в `navigation.ts`, потому что возвращает талон загрузки:
   * дальше идут те же PUT и `completeUpload`, что и у обычного приёма, и
   * разносить половины одного потока по двум модулям было бы неверно.
   */
  createWorkWithFile: (body: CreateWorkWithFileInput) =>
    request<CreatedWorkWithFile>('POST', `${V1}/works/with-file`, { body }).then((r) => r.data),

  completeUpload: (revisionId: string, uploadId: string) =>
    request<SourceFile>('POST', `${V1}/revisions/${revisionId}/files/upload/complete`, {
      body: { uploadId },
      idempotencyKey: newIdempotencyKey('upload'),
    }).then((r) => r.data),

  /**
   * Замена файла — своя пара маршрутов, а не «удалить плюс загрузить».
   *
   * Талон подписан другим ключом (`UploadPurpose = 'revision-file-replacement'`),
   * поэтому предъявить его обычному `complete` невозможно: подпись не сойдётся.
   * Порядок файлов держит сервер, отдельный `reorder` не нужен.
   */
  initReplacement: (revisionId: string, fileId: string, fileName: string, sizeBytes: number) =>
    request<UploadTicket>(
      'POST',
      `${V1}/revisions/${revisionId}/files/${fileId}/replacement/init`,
      { body: { fileName, sizeBytes } },
    ).then((r) => r.data),

  completeReplacement: (revisionId: string, fileId: string, uploadId: string) =>
    request<SourceFile>(
      'POST',
      `${V1}/revisions/${revisionId}/files/${fileId}/replacement/complete`,
      { body: { uploadId }, idempotencyKey: newIdempotencyKey('replace') },
    ).then((r) => r.data),

  reorder: (revisionId: string, fileIds: readonly string[]) =>
    request<{ items: SourceFile[] }>('PUT', `${V1}/revisions/${revisionId}/files/order`, {
      body: { fileIds: [...fileIds] },
    }).then((r) => r.data.items),

  remove: (revisionId: string, fileId: string) =>
    request<void>('DELETE', `${V1}/revisions/${revisionId}/files/${fileId}`),

  /**
   * Адрес содержимого файла — same-origin и под сессией (§4.2).
   *
   * Presigned URL в браузер не выдаётся ни при каком режиме: он утекает в
   * историю и обходит RBAC на время своего TTL. Именно этот адрес читает pdf.js
   * запросами с `Range`.
   */
  contentUrl: (fileId: string) => `${V1}/files/${fileId}/content`,
};

// =====================================================================
// Две кнопки конвейера (S21)
// =====================================================================

export interface StartMarkupPipelineResult {
  readonly bundleReady: boolean;
  readonly bundleId: string | null;
  readonly layoutRevisionId: string | null;
  /** `null` — задачи не ставились: детекция пропущена (см. ниже). */
  readonly jobId: string | null;
  readonly jobCreated: boolean;
  /** Модель детекции не настроена: черновик разметки есть, задач нет. */
  readonly detectionSkipped: boolean;
  readonly detectionSkipReason: string | null;
}

export interface CheckPipelineResult {
  readonly stage: 'recognition' | 'analysis' | 'checks';
  readonly recognitionRunId: string | null;
  readonly jobId: string;
  readonly jobCreated: boolean;
  /** Прогон, который запущенный восстанавливает; `null` — распознавание с нуля. */
  readonly repairOfRunId?: string | null;
}

export interface RecognitionProgress {
  readonly recognitionRunId: string;
  readonly status: string;
  readonly pagesTotal: number;
  readonly pagesDone: number;
  readonly pagesFailed: number;
  readonly pagesPending: number;
  readonly blocksTotal: number;
  readonly blocksRecognized: number;
  readonly blocksInvalid: number;
  readonly blocksRefused: number;
  /** Сколько раундов дораспознавания потратила финализация (S28). */
  readonly recoveryRound: number;
  /** Прогон-родитель, если этот восстанавливает упавший (S28). */
  readonly repairOfRunId: string | null;
  /** Блоки, перенесённые из родителя без вызова модели (S28). */
  readonly blocksReused: number;
}

/**
 * Сквозной конвейер: «Разметить» и «Проверить».
 *
 * Отдельный объект, а не методы в `layout`/`checks`: это не ещё одна стадия, а
 * ДРУГОЙ способ вести ту же ревизию — одним нажатием вместо шести. Гранулярные
 * вызовы остались там же, где были, и экран разметки продолжает звать их.
 */
export const pipeline = {
  /** Сборка рабочего документа и детекция блоков одним нажатием. */
  markup: (revisionId: string) =>
    request<StartMarkupPipelineResult>('POST', `${V1}/revisions/${revisionId}/markup`, {
      idempotencyKey: newIdempotencyKey('pipeline-markup'),
    }).then((r) => r.data),

  /** Заморозка, распознавание, анализ и проверки одним нажатием. */
  check: (revisionId: string) =>
    request<CheckPipelineResult>('POST', `${V1}/revisions/${revisionId}/check`, {
      idempotencyKey: newIdempotencyKey('pipeline-check'),
    }).then((r) => r.data),

  /** Постраничный прогресс распознавания: «идёт» без числа страниц бесполезно. */
  progress: (runId: string, signal?: AbortSignal) =>
    get<RecognitionProgress>(`${V1}/recognition-runs/${runId}/progress`, {
      ...(signal === undefined ? {} : { signal }),
    }),
};

// =====================================================================
// Рабочий документ (§3.3)
// =====================================================================

export const bundles = {
  build: (revisionId: string) =>
    request<BundleBuildResult>('POST', `${V1}/revisions/${revisionId}/bundle`, {
      idempotencyKey: newIdempotencyKey('bundle'),
    }).then((r) => r.data),

  list: (revisionId: string) =>
    get<{ items: Bundle[] }>(`${V1}/revisions/${revisionId}/bundles`).then((r) => r.items),

  pages: (bundleId: string) =>
    get<{ bundleId: string; items: BundlePage[] }>(`${V1}/bundles/${bundleId}/pages`).then(
      (r) => r.items,
    ),
};

// =====================================================================
// Разметка (§6.1, §7)
// =====================================================================

export interface BlockCreateInput {
  workingPageIndex: number;
  blockType: BlockType;
  shapeType?: ShapeType;
  coords: NormalizedCoords;
  points?: { x: number; y: number }[];
}

export interface BlockUpdateInput {
  blockType?: BlockType;
  shapeType?: ShapeType;
  coords?: NormalizedCoords;
  points?: { x: number; y: number }[];
  sortOrder?: number;
}

export const layout = {
  /** Кнопка «Разметить файл» (§6.1): ставит первую задачу цепочки §12. */
  start: (revisionId: string) =>
    request<StartMarkupResult>('POST', `${V1}/revisions/${revisionId}/layout`, {
      idempotencyKey: newIdempotencyKey('markup'),
    }).then((r) => r.data),

  listRevisions: (revisionId: string) =>
    get<{ items: LayoutRevision[] }>(`${V1}/revisions/${revisionId}/layouts`).then((r) => r.items),

  detail: (layoutId: string) => get<LayoutDetail>(`${V1}/layouts/${layoutId}`),

  blocks: (layoutId: string) => get<LayoutBlockList>(`${V1}/layouts/${layoutId}/blocks`),

  createBlock: (layoutId: string, version: number, input: BlockCreateInput) =>
    request<BlockMutationResult>('POST', `${V1}/layouts/${layoutId}/blocks`, {
      body: input,
      ifMatch: version,
    }),

  updateBlock: (layoutId: string, blockId: string, version: number, patch: BlockUpdateInput) =>
    request<BlockMutationResult>('PATCH', `${V1}/layouts/${layoutId}/blocks/${blockId}`, {
      body: patch,
      ifMatch: version,
    }),

  deleteBlock: (layoutId: string, blockId: string, version: number) =>
    request<{ version: number }>('DELETE', `${V1}/layouts/${layoutId}/blocks/${blockId}`, {
      ifMatch: version,
    }),

  /** Замена страницы одним TEXT-блоком: явное действие пользователя (§5.3). */
  replacePageWithText: (layoutId: string, workingPageIndex: number, version: number) =>
    request<BlockMutationResult>(
      'POST',
      `${V1}/layouts/${layoutId}/pages/${workingPageIndex}/replace-with-text`,
      { ifMatch: version },
    ),

  /** Профиль `full-page-text` на весь комплект; после ручной правки отвергается. */
  fullPageText: (layoutId: string, version: number) =>
    request<{ layoutRevisionId: string; version: number; pages: number }>(
      'POST',
      `${V1}/layouts/${layoutId}/full-page-text`,
      { ifMatch: version },
    ),

  detect: (layoutId: string, workingPageIndices?: readonly number[]) =>
    request<DetectResult>('POST', `${V1}/layouts/${layoutId}/detect`, {
      body: workingPageIndices === undefined ? {} : { workingPageIndices: [...workingPageIndices] },
    }).then((r) => r.data),

};

export type BlockMutationResponse = ApiResponse<BlockMutationResult>;

// =====================================================================
// Распознавание (§6.2)
// =====================================================================

export const recognition = {
  start: (revisionId: string, layoutId: string) =>
    request<RecognizeResult>('POST', `${V1}/revisions/${revisionId}/recognize`, {
      body: { layoutId },
      idempotencyKey: newIdempotencyKey('recognize'),
    }).then((r) => r.data),

  runs: (revisionId: string) =>
    get<{ items: RecognitionRun[] }>(`${V1}/revisions/${revisionId}/recognition-runs`).then(
      (r) => r.items,
    ),

  run: (runId: string) => get<RecognitionRun>(`${V1}/recognition-runs/${runId}`),

  pages: (runId: string) =>
    get<{ items: PageText[] }>(`${V1}/recognition-runs/${runId}/pages`).then((r) => r.items),

  blocks: (runId: string) =>
    get<{ items: BlockResult[] }>(`${V1}/recognition-runs/${runId}/blocks`).then((r) => r.items),

  artifacts: (runId: string) =>
    get<{ items: Artifact[] }>(`${V1}/recognition-runs/${runId}/artifacts`).then((r) => r.items),

  artifactUrl: (runId: string, kind: string) =>
    `${V1}/recognition-runs/${runId}/artifacts/${kind}/content`,
};

// =====================================================================
// Документы, реквизиты, реестр (§8)
// =====================================================================

export const documents = {
  segment: (revisionId: string) =>
    request<{ revisionId: string; jobId: string; jobCreated: boolean }>(
      'POST',
      `${V1}/revisions/${revisionId}/segment`,
      { body: {}, idempotencyKey: newIdempotencyKey('segment') },
    ).then((r) => r.data),

  list: (revisionId: string) =>
    get<{ items: LogicalDocument[] }>(`${V1}/revisions/${revisionId}/documents`).then(
      (r) => r.items,
    ),

  detail: (documentId: string) => get<DocumentDetail>(`${V1}/documents/${documentId}`),

  fields: (documentId: string) =>
    get<{ items: FieldValue[] }>(`${V1}/documents/${documentId}/fields`).then((r) => r.items),

  pages: (revisionId: string) => get<PageAccounting>(`${V1}/revisions/${revisionId}/pages`),

  registry: (revisionId: string) =>
    get<{ items: RegistryRow[] }>(`${V1}/revisions/${revisionId}/registry`).then((r) => r.items),

  classifications: (revisionId: string) =>
    get<{ items: PageClassification[] }>(`${V1}/revisions/${revisionId}/classifications`).then(
      (r) => r.items,
    ),

  /** Ручная метка страницы: приоритетна для сегментации и переживает пересборку. */
  setManualLabel: (
    revisionId: string,
    sourcePageId: string,
    body: { label: string; docTypeCode?: string | null; pageRoleCode?: string | null },
  ) =>
    request<ManualPageLabel>(
      'PUT',
      `${V1}/revisions/${revisionId}/pages/${sourcePageId}/manual-label`,
      { body },
    ).then((r) => r.data),

  clearManualLabel: (revisionId: string, sourcePageId: string) =>
    request<undefined>(
      'DELETE',
      `${V1}/revisions/${revisionId}/pages/${sourcePageId}/manual-label`,
    ).then(() => undefined),

  confirm: (
    documentId: string,
    version: number,
    body: { docTypeCode?: string; needsReview?: boolean },
  ) =>
    request<DocumentDetail>('POST', `${V1}/documents/${documentId}/confirm`, {
      body,
      ifMatch: version,
    }).then((r) => r.data),
};

// =====================================================================
// Проверка (§9)
// =====================================================================

export const checks = {
  run: (revisionId: string) =>
    request<{ jobId: string | null; created: boolean }>(
      'POST',
      `${V1}/revisions/${revisionId}/checks`,
      { idempotencyKey: newIdempotencyKey('checks') },
    ).then((r) => r.data),

  runs: (revisionId: string) =>
    get<{ items: ValidationRun[] }>(`${V1}/revisions/${revisionId}/checks`).then((r) => r.items),

  /**
   * Замечания одного прогона вместе со сводкой экрана.
   *
   * Тело возвращается целиком, а не `items`: сводка описывает ТОТ ЖЕ прогон, из
   * которого пришёл список, и разносить их по двум вызовам значило бы дать
   * экрану возможность показать число из одной проверки над списком из другой.
   */
  findings: (revisionId: string, validationRunId?: string) =>
    get<FindingList>(`${V1}/revisions/${revisionId}/findings`, {
      query: validationRunId === undefined ? {} : { validationRunId },
    }),

  /**
   * Состав комплекта и результат проверки по каждой его позиции.
   *
   * Отдельный вызов от `findings`: у ответов разный размер и разная частота
   * обновления, и подмешивать состав комплекта в список замечаний значило бы
   * возить его целиком на каждое обновление списка после снятия одного
   * замечания.
   */
  report: (revisionId: string) => get<CheckReport>(`${V1}/revisions/${revisionId}/check-report`),

  ruleCatalog: () =>
    get<{ items: RuleCatalogEntry[] }>(`${V1}/admin/rule-catalog`).then((r) => r.items),
};

// =====================================================================
// Согласование (§4.1, §13)
// =====================================================================

export const workflow = {
  state: (revisionId: string) => get<WorkflowState>(`${V1}/revisions/${revisionId}/workflow`),

  submit: (revisionId: string, version: number, comment?: string) =>
    request<WorkflowResult>('POST', `${V1}/revisions/${revisionId}/submit`, {
      body: comment === undefined ? {} : { comment },
      ifMatch: version,
      idempotencyKey: newIdempotencyKey('submit'),
    }).then((r) => r.data),

  takeToReview: (revisionId: string, version: number, comment?: string) =>
    request<WorkflowResult>('POST', `${V1}/revisions/${revisionId}/review`, {
      body: comment === undefined ? {} : { comment },
      ifMatch: version,
      idempotencyKey: newIdempotencyKey('review'),
    }).then((r) => r.data),

  returnToContractor: (revisionId: string, version: number, reason: string) =>
    request<WorkflowResult>('POST', `${V1}/revisions/${revisionId}/return`, {
      body: { reason },
      ifMatch: version,
      idempotencyKey: newIdempotencyKey('return'),
    }).then((r) => r.data),

  approve: (revisionId: string, version: number, comment?: string) =>
    request<WorkflowResult>('POST', `${V1}/revisions/${revisionId}/approve`, {
      body: comment === undefined ? {} : { comment },
      ifMatch: version,
      idempotencyKey: newIdempotencyKey('approve'),
    }).then((r) => r.data),

  /** Обоснованный отказ от результата проверки — только руководитель (§9.6). */
  override: (findingId: string, reason: string) =>
    request<{ findingId: string; revisionId: string; ruleCode: string }>(
      'POST',
      `${V1}/findings/${findingId}/override`,
      { body: { reason }, idempotencyKey: newIdempotencyKey('override') },
    ).then((r) => r.data),

  materialize: (revisionId: string) =>
    request<{ revisionId: string; jobId: string | null; jobCreated: boolean }>(
      'POST',
      `${V1}/revisions/${revisionId}/materialize`,
      { idempotencyKey: newIdempotencyKey('materialize') },
    ).then((r) => r.data),

  archive: (revisionId: string) => get<ArchiveState>(`${V1}/revisions/${revisionId}/archive`),
  archiveUrl: (revisionId: string) => `${V1}/revisions/${revisionId}/archive/content`,
  documentPdfUrl: (documentId: string) => `${V1}/documents/${documentId}/pdf`,
};

// =====================================================================
// Наблюдаемость ревизии (§3.8, §11)
// =====================================================================

export const revisionEvents = {
  /**
   * Сводка стадий конвейера.
   *
   * Единственное чтение портала, которое опрашивается в цикле и обесценивается
   * потоком событий, поэтому именно оно принимает `AbortSignal` от TanStack
   * Query. Без сигнала отменённый рефетч всё равно уезжал на сервер и съедал
   * слот лимита — а `invalidateQueries` отменяет рефетч на каждое событие.
   */
  processingStatus: (revisionId: string, signal?: AbortSignal) =>
    get<ProcessingStatus>(`${V1}/revisions/${revisionId}/processing-status`, {
      ...(signal === undefined ? {} : { signal }),
    }),
  streamUrl: (revisionId: string) => `${V1}/revisions/${revisionId}/events`,
};

// =====================================================================
// Справочники (§14)
// =====================================================================

/**
 * Тело заведения объекта.
 *
 * `code` есть только здесь: в правку он не входит — печатается в номерах актов
 * и участвует в именовании выгрузок, поэтому смена задним числом рассогласовала
 * бы уже выданные документы с карточкой (см. репозиторий справочников).
 */
export interface ObjectInput {
  code: string;
  name: string;
  fullName: string;
  address?: string | null;
  cadastralNumber?: string | null;
  permitIdentifier?: string | null;
  actNumberPattern?: string | null;
  developerId?: string | null;
  techCustomerId?: string | null;
  generalContractorId?: string | null;
}

export interface CounterpartyInput {
  name: string;
  kind: string;
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  legalAddress?: string | null;
}

export const catalog = {
  /**
   * Объекты страницей.
   *
   * `cursor` обязателен к передаче вызывающим, который показывает список
   * целиком: до S22 здесь стоял жёсткий `limit: 100` без чтения `nextCursor`, и
   * сто первый объект был молча недостижим — экран выглядел полным и им не был.
   */
  objects: (query?: { search?: string; cursor?: string | null }) =>
    get<Page<ConstructionObject>>(`${V1}/catalog/objects`, {
      query: {
        ...(query?.search === undefined ? {} : { search: query.search }),
        ...(query?.cursor === undefined || query.cursor === null ? {} : { cursor: query.cursor }),
        limit: 100,
      },
    }),

  object: (objectId: string) => get<ConstructionObject>(`${V1}/catalog/objects/${objectId}`),

  createObject: (body: ObjectInput) =>
    request<ConstructionObject>('POST', `${V1}/catalog/objects`, { body }).then((r) => r.data),

  updateObject: (objectId: string, body: Partial<ObjectInput> & { isActive?: boolean }) =>
    request<ConstructionObject>('PATCH', `${V1}/catalog/objects/${objectId}`, { body }).then(
      (r) => r.data,
    ),

  /**
   * Удаление карточки.
   *
   * Ответ пуст (204), поэтому `.data` не читается: попытка разобрать пустое
   * тело как JSON дала бы отказ там, где сервер ответил успехом.
   */
  deleteObject: (objectId: string) =>
    request<null>('DELETE', `${V1}/catalog/objects/${objectId}`).then(() => undefined),

  counterparties: (query?: { search?: string; kind?: string }) =>
    get<Page<Counterparty>>(`${V1}/catalog/counterparties`, {
      query: {
        ...(query?.search === undefined ? {} : { search: query.search }),
        ...(query?.kind === undefined ? {} : { kind: query.kind }),
        limit: 100,
      },
    }),

  createCounterparty: (body: CounterpartyInput) =>
    request<Counterparty>('POST', `${V1}/catalog/counterparties`, { body }).then((r) => r.data),

  updateCounterparty: (
    counterpartyId: string,
    body: Partial<CounterpartyInput> & { isActive?: boolean },
  ) =>
    request<Counterparty>('PATCH', `${V1}/catalog/counterparties/${counterpartyId}`, {
      body,
    }).then((r) => r.data),

  deleteCounterparty: (counterpartyId: string) =>
    request<null>('DELETE', `${V1}/catalog/counterparties/${counterpartyId}`).then(() => undefined),

  counterpartyKinds: () => get<CounterpartyKindEntry[]>(`${V1}/catalog/counterparty-kinds`),

  /**
   * Справочник разделов работ — плоский список, общий для всех объектов.
   *
   * Списки разделов приходят массивом, а не конвертом: их два-три десятка, и
   * курсорная страница на такой размер была бы конструкцией без назначения.
   */
  sections: (includeInactive = false) =>
    get<Section[]>(`${V1}/catalog/sections`, {
      query: includeInactive ? { includeInactive: 'true' } : {},
    }),

  createSection: (body: { code: string; name: string; sortOrder?: number }) =>
    request<Section>('POST', `${V1}/catalog/sections`, { body }).then((r) => r.data),

  updateSection: (
    sectionCode: string,
    body: { name?: string; sortOrder?: number; isActive?: boolean },
  ) =>
    request<Section>('PATCH', `${V1}/catalog/sections/${sectionCode}`, { body }).then(
      (r) => r.data,
    ),

  /**
   * Разделы объекта — ВЕСЬ справочник с отметкой о включённости.
   *
   * Не «включённые разделы»: список из одних включённых не дал бы способа
   * включить первый, а экран объекта — это и есть то место, где включают.
   */
  objectSections: (objectId: string) =>
    get<ObjectSection[]>(`${V1}/catalog/objects/${objectId}/sections`),

  setObjectSection: (objectId: string, sectionCode: string, isActive: boolean) =>
    request<ObjectSection>('PUT', `${V1}/catalog/objects/${objectId}/sections/${sectionCode}`, {
      body: { isActive },
    }).then((r) => r.data),

  objectContractors: (objectId: string) =>
    get<ObjectContractor[]>(`${V1}/catalog/objects/${objectId}/contractors`),

  setObjectContractor: (objectId: string, contractorId: string, isActive: boolean) =>
    request<ObjectContractor>(
      'PUT',
      `${V1}/catalog/objects/${objectId}/contractors/${contractorId}`,
      { body: { isActive } },
    ).then((r) => r.data),

  rdDocuments: (objectId: string, search?: string) =>
    get<Page<RdDocument>>(`${V1}/catalog/objects/${objectId}/rd-documents`, {
      query: { ...(search === undefined || search === '' ? {} : { search }), limit: 100 },
    }),

  /**
   * Все версии профиля раздела работ.
   *
   * Отдаётся массивом, а не конвертом — так объявлена `sectionProfileListSchema`.
   */
  sectionProfiles: (sectionCode?: string) =>
    get<SectionProfile[]>(`${V1}/catalog/section-profiles`, {
      query: sectionCode === undefined ? {} : { sectionCode },
    }),

  /**
   * Профиль, действующий на дату.
   *
   * Отдельный маршрут, а не фильтр списка: сервер отвечает 404, когда профиля на
   * дату нет, и это законное состояние открытого мира — «раздел не настроен», а
   * не «список пуст». Экран обязан различать их (§9.1).
   */
  effectiveSectionProfile: (sectionCode: string, at?: string) =>
    get<SectionProfile>(`${V1}/catalog/sections/${sectionCode}/effective-profile`, {
      query: at === undefined ? {} : { at },
    }),

  createSectionProfile: (body: {
    sectionCode: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    expectedDocTypes: readonly string[];
    materialCategories: readonly string[];
    enabledRuleCodes: readonly string[];
    autonomyLevel: 'assisted' | 'automatic';
    publish: boolean;
  }) =>
    request<SectionProfile>('POST', `${V1}/catalog/section-profiles`, {
      body: {
        ...body,
        expectedDocTypes: [...body.expectedDocTypes],
        materialCategories: [...body.materialCategories],
        enabledRuleCodes: [...body.enabledRuleCodes],
      },
    }).then((r) => r.data),

  publishSectionProfile: (profileId: string) =>
    request<SectionProfile>('POST', `${V1}/catalog/section-profiles/${profileId}/publish`).then(
      (r) => r.data,
    ),

  docTypes: (includeInactive = false) =>
    get<DocType[]>(`${V1}/catalog/doc-types`, {
      query: includeInactive ? { includeInactive: 'true' } : {},
    }),

  candidates: (status?: string) =>
    get<Page<DocTypeCandidate>>(`${V1}/catalog/doc-type-candidates`, {
      query: { ...(status === undefined ? {} : { status }), limit: 100 },
    }),

  setCandidateStatus: (candidateId: string, status: string) =>
    request<DocTypeCandidate>('PATCH', `${V1}/catalog/doc-type-candidates/${candidateId}`, {
      body: { status },
    }).then((r) => r.data),

  mapCandidate: (candidateId: string, docTypeCode: string) =>
    request<DocTypeCandidate>('POST', `${V1}/catalog/doc-type-candidates/${candidateId}/map`, {
      body: { docTypeCode },
    }).then((r) => r.data),

  createDocTypeFromCandidate: (
    candidateId: string,
    body: {
      code: string;
      name: string;
      shortName: string;
      groupCode: string;
      kind: string;
    },
  ) =>
    request<{ docType: DocType; candidate: DocTypeCandidate }>(
      'POST',
      `${V1}/catalog/doc-type-candidates/${candidateId}/doc-type`,
      { body },
    ).then((r) => r.data),
};

// =====================================================================
// Массовый ввод справочников (§3.2)
// =====================================================================

export const catalogImports = {
  templateUrl: (target: string) => `${V1}/catalog/imports/template?target=${target}`,

  list: (target?: string) =>
    get<{ items: CatalogImport[] }>(`${V1}/catalog/imports`, {
      query: target === undefined ? {} : { target },
    }),

  one: (importId: string) => get<CatalogImport>(`${V1}/catalog/imports/${importId}`),

  rows: (importId: string, verdict?: string) =>
    get<{ items: CatalogImportRow[]; nextRowNo: number | null }>(
      `${V1}/catalog/imports/${importId}/rows`,
      { query: { ...(verdict === undefined ? {} : { verdict }), limit: 200 } },
    ),

  init: (body: { target: string; fileName: string; sizeBytes: number }) =>
    request<{
      importId: string;
      uploadId: string;
      uploadUrl: string;
      method: 'PUT';
      headers: Record<string, string>;
      expiresAt: string;
      maxBytes: number;
    }>('POST', `${V1}/catalog/imports/init`, { body }).then((r) => r.data),

  complete: (importId: string, uploadId: string) =>
    request<CatalogImport>('POST', `${V1}/catalog/imports/${importId}/complete`, {
      body: { uploadId },
    }).then((r) => r.data),

  apply: (importId: string) =>
    request<{ created: number; skipped: number }>(
      'POST',
      `${V1}/catalog/imports/${importId}/apply`,
    ).then((r) => r.data),
};

// =====================================================================
// Администрирование (§14)
// =====================================================================

export const admin = {
  users: (search?: string) =>
    get<Page<PortalUser>>(`${V1}/admin/users`, {
      query: { ...(search === undefined ? {} : { search }), limit: 100 },
    }),

  user: (userId: string) => get<UserCard>(`${V1}/admin/users/${userId}`),

  setRoles: (userId: string, roles: readonly UserRole[]) =>
    request<UserCard>('PUT', `${V1}/admin/users/${userId}/roles`, {
      body: { roles: [...roles] },
    }).then((r) => r.data),

  setObjectScopes: (userId: string, objectIds: readonly string[]) =>
    request<UserCard>('PUT', `${V1}/admin/users/${userId}/object-scopes`, {
      body: { objectIds: [...objectIds] },
    }).then((r) => r.data),

  activate: (userId: string) =>
    request<UserCard>('POST', `${V1}/admin/users/${userId}/activate`).then((r) => r.data),

  deactivate: (userId: string) =>
    request<UserCard>('POST', `${V1}/admin/users/${userId}/deactivate`).then((r) => r.data),

  // --- локальные учётные записи (AUTH_MODE=local) ---

  /**
   * Создание пользователя с локальным паролем.
   *
   * Пароль не передаётся: его генерирует сервер и возвращает ОДИН раз. Дать
   * администратору возможность задать пользователю известный себе пароль значит
   * дать возможность действовать от его имени, и журнал этого не различит.
   */
  createUser: (input: {
    email: string;
    fullName: string;
    position?: string;
    contractorId?: string | null;
    roles?: readonly UserRole[];
    isActive?: boolean;
  }) =>
    request<UserCard & { temporaryPassword: string }>('POST', `${V1}/admin/users`, {
      body: { ...input, ...(input.roles === undefined ? {} : { roles: [...input.roles] }) },
    }).then((r) => r.data),

  resetPassword: (userId: string) =>
    request<{ temporaryPassword: string }>('POST', `${V1}/admin/users/${userId}/password`).then(
      (r) => r.data,
    ),

  unlockUser: (userId: string) =>
    request<UserCard>('POST', `${V1}/admin/users/${userId}/unlock`).then((r) => r.data),

  registrationRequests: () =>
    get<{ items: RegistrationRequest[] }>(`${V1}/admin/registration-requests`).then((r) => r.items),

  approveRegistration: (
    requestId: string,
    input: {
      roles: readonly UserRole[];
      contractorId?: string | null;
      objectIds?: readonly string[];
      credential: 'temporary' | 'as-requested';
    },
  ) =>
    request<UserCard & { temporaryPassword: string | null }>(
      'POST',
      `${V1}/admin/registration-requests/${requestId}/approve`,
      {
        body: {
          ...input,
          roles: [...input.roles],
          ...(input.objectIds === undefined ? {} : { objectIds: [...input.objectIds] }),
        },
      },
    ).then((r) => r.data),

  rejectRegistration: (requestId: string, reason?: string) =>
    request<{ rejected: true }>('POST', `${V1}/admin/registration-requests/${requestId}/reject`, {
      body: reason === undefined ? {} : { reason },
    }).then((r) => r.data),

  settings: () => get<SettingsView>(`${V1}/admin/settings`),

  /**
   * Запись одного настроечного ключа (`settingWriteBodySchema`).
   *
   * Сервер отвечает 422 на секретные ключи и на значение, не прошедшее схему
   * ключа (pointer `/value`), 404 на незнакомый ключ и 409 на ключ, которым
   * управляет собственный эндпоинт (`managedBy`).
   */
  setSetting: (key: string, value: unknown) =>
    request<AppSetting>('PUT', `${V1}/admin/settings/${key}`, { body: { value } }).then(
      (r) => r.data,
    ),

  rules: () => get<{ items: RuleDefinition[] }>(`${V1}/admin/rules`).then((r) => r.items),

  rulesets: () => get<Page<RulesetVersion>>(`${V1}/admin/rulesets`, { query: { limit: 100 } }),

  ruleset: (rulesetId: string) => get<RulesetDetail>(`${V1}/admin/rulesets/${rulesetId}`),

  /**
   * Публикация версии набора: снимок целиком, а не дельта.
   *
   * Так требует схема сервера, и причина существенна — прогон проверок ссылается
   * на версию по идентификатору, и полупустой снимок дал бы результат, который
   * невозможно ни воспроизвести, ни оспорить.
   */
  publishRuleset: (body: {
    version: string;
    notes: string | null;
    activate: boolean;
    rules: readonly RulesetRuleInput[];
  }) =>
    request<RulesetVersion>('POST', `${V1}/admin/rulesets`, {
      body: { ...body, rules: body.rules.map((rule) => ({ ...rule })) },
    }).then((r) => r.data),

  /**
   * Переключение действующей версии — он же откат (§3.7).
   *
   * Опубликованная версия и её снимок неизменяемы, поэтому «вернуть прежние
   * правила» означает сделать действующей прежнюю версию, а не править её.
   */
  activateRuleset: (rulesetId: string) =>
    request<RulesetVersion>('POST', `${V1}/admin/rulesets/${rulesetId}/activate`).then(
      (r) => r.data,
    ),

  prompts: (query?: { code?: string; stage?: string; state?: string }) =>
    get<Page<PromptTemplate>>(`${V1}/admin/prompts`, {
      query: {
        ...(query?.code === undefined || query.code === '' ? {} : { code: query.code }),
        ...(query?.stage === undefined ? {} : { stage: query.stage }),
        ...(query?.state === undefined ? {} : { state: query.state }),
        limit: 100,
      },
    }),

  createPrompt: (body: {
    code: string;
    stage: string;
    docTypeCode: string | null;
    systemPrompt: string;
    userTemplate: string;
    outputSchema: unknown;
    modelOverride: string | null;
  }) => request<PromptTemplate>('POST', `${V1}/admin/prompts`, { body }).then((r) => r.data),

  updatePromptDraft: (
    promptId: string,
    patch: { systemPrompt?: string; userTemplate?: string; modelOverride?: string | null },
  ) =>
    request<PromptTemplate>('PATCH', `${V1}/admin/prompts/${promptId}`, { body: patch }).then(
      (r) => r.data,
    ),

  /**
   * Один маршрут на все переходы промта, включая публикацию и откат.
   *
   * Так объявлен сервер: допустимость решает автомат `governance.ts`, и
   * четыре разных кнопки на клиенте, каждая со своим маршрутом, разошлись бы с
   * ним при первом же изменении таблицы переходов.
   */
  setPromptState: (promptId: string, to: 'draft' | 'test' | 'published' | 'archived') =>
    request<PromptTransition>('POST', `${V1}/admin/prompts/${promptId}/state`, {
      body: { to },
    }).then((r) => r.data),

  jobs: (query?: { status?: string; type?: string; deadOnly?: boolean; revisionId?: string }) =>
    get<Page<JobView>>(`${V1}/admin/jobs`, {
      query: {
        ...(query?.status === undefined ? {} : { status: query.status }),
        ...(query?.type === undefined ? {} : { type: query.type }),
        ...(query?.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        ...(query?.deadOnly === true ? { deadOnly: 'true' } : {}),
        limit: 100,
      },
    }),

  job: (jobId: string) => get<{ job: JobView; runs: JobRunView[] }>(`${V1}/admin/jobs/${jobId}`),

  retryJob: (jobId: string) =>
    request<{ jobId: string; created: boolean }>('POST', `${V1}/admin/jobs/${jobId}/retry`).then(
      (r) => r.data,
    ),

  cancelJob: (jobId: string) =>
    request<{ jobId: string; created: boolean }>('POST', `${V1}/admin/jobs/${jobId}/cancel`).then(
      (r) => r.data,
    ),

  queues: () => get<QueueSnapshot>(`${V1}/admin/jobs/queues`),

  audit: (query?: { action?: string; entityType?: string; objectId?: string }) =>
    get<Page<AuditEntry>>(`${V1}/audit/entries`, {
      query: {
        ...(query?.action === undefined ? {} : { action: query.action }),
        ...(query?.entityType === undefined ? {} : { entityType: query.entityType }),
        ...(query?.objectId === undefined ? {} : { objectId: query.objectId }),
        limit: 100,
      },
    }),

  // --- журнал ошибок (§11) ---

  /**
   * Список проблем.
   *
   * `sort=frequency` возвращает топ и `nextCursor: null` — у сортировки по
   * частоте курсора нет по построению (частота меняется во время листания).
   * Это не «страница кончилась», и подписывать кнопку «показать ещё» по
   * `nextCursor === null` в этом режиме нельзя.
   */
  errorIssues: (query?: {
    status?: string;
    source?: string;
    domain?: string;
    severity?: string;
    search?: string;
    sort?: 'last_seen' | 'frequency';
    cursor?: string;
  }) =>
    get<Page<ErrorIssue>>(`${V1}/admin/errors`, {
      query: {
        ...(query?.status === undefined ? {} : { status: query.status }),
        ...(query?.source === undefined ? {} : { source: query.source }),
        ...(query?.domain === undefined ? {} : { domain: query.domain }),
        ...(query?.severity === undefined ? {} : { severity: query.severity }),
        ...(query?.search === undefined ? {} : { search: query.search }),
        ...(query?.sort === undefined ? {} : { sort: query.sort }),
        ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: 50,
      },
    }),

  errorSummary: () => get<ErrorJournalSummary>(`${V1}/admin/errors/summary`),

  errorIssue: (issueId: string) => get<ErrorIssueDetail>(`${V1}/admin/errors/${issueId}`),

  errorSeries: (issueId: string) =>
    get<{ points: ErrorSeriesPoint[] }>(`${V1}/admin/errors/${issueId}/series`),

  errorSamples: (query?: {
    requestId?: string;
    domain?: string;
    source?: string;
    cursor?: string;
  }) =>
    get<Page<ErrorSample>>(`${V1}/admin/errors/samples`, {
      query: {
        ...(query?.requestId === undefined ? {} : { requestId: query.requestId }),
        ...(query?.domain === undefined ? {} : { domain: query.domain }),
        ...(query?.source === undefined ? {} : { source: query.source }),
        ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: 50,
      },
    }),

  // --- аномалии и производительность (§11, поток B) ---

  httpAnomalies: () =>
    get<{ from: string; to: string; items: HttpAnomalyRow[] }>(`${V1}/admin/http-anomalies`),

  slowOperations: (kind?: string) =>
    get<{ from: string; to: string; items: SlowOperationRow[] }>(`${V1}/admin/slow-operations`, {
      query: { ...(kind === undefined ? {} : { kind }) },
    }),

  // --- обратная связь конвейера (§11) ---

  feedbackSummary: (query?: { reasonCode?: string; pipelineStage?: string; promptCode?: string }) =>
    get<PipelineFeedbackSummary>(`${V1}/admin/pipeline-feedback/summary`, {
      query: {
        ...(query?.reasonCode === undefined ? {} : { reasonCode: query.reasonCode }),
        ...(query?.pipelineStage === undefined ? {} : { pipelineStage: query.pipelineStage }),
        ...(query?.promptCode === undefined ? {} : { promptCode: query.promptCode }),
      },
    }),

  feedbackEvents: (query?: { reasonCode?: string; promptCode?: string; cursor?: string }) =>
    get<Page<PipelineFeedbackEvent>>(`${V1}/admin/pipeline-feedback/events`, {
      query: {
        ...(query?.reasonCode === undefined ? {} : { reasonCode: query.reasonCode }),
        ...(query?.promptCode === undefined ? {} : { promptCode: query.promptCode }),
        ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: 50,
      },
    }),

  /**
   * Адрес выгрузки.
   *
   * Обычная ссылка, а не `fetch`: файл сохраняет браузер, и тянуть пятьдесят
   * тысяч строк в память вкладки ради того же результата незачем.
   */
  feedbackExportUrl: (query?: { reasonCode?: string; promptCode?: string }) => {
    const search = new URLSearchParams();
    if (query?.reasonCode !== undefined) search.set('reasonCode', query.reasonCode);
    if (query?.promptCode !== undefined) search.set('promptCode', query.promptCode);
    const suffix = search.toString();
    return `${V1}/admin/pipeline-feedback/export${suffix === '' ? '' : `?${suffix}`}`;
  },

  errorAction: (issueId: string, input: ErrorIssueActionInput) =>
    request<{ status: string }>('POST', `${V1}/admin/errors/${issueId}/actions`, {
      body: input,
    }).then((r) => r.data),
};

export type { LayoutBlock };
