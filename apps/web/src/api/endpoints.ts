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
  Artifact,
  ArchiveState,
  AuditEntry,
  BlockMutationResult,
  BlockResult,
  Bundle,
  BundleBuildResult,
  BundlePage,
  ConstructionObject,
  Counterparty,
  DetectResult,
  DocType,
  DocTypeCandidate,
  DocumentDetail,
  FieldValue,
  Finding,
  FreezeResult,
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
  SectionKind,
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
  /** Выход: локальная сессия отзывается, `endSessionUrl` ведёт в Keycloak. */
  logout: () => request<{ endSessionUrl: string | null }>('POST', '/auth/logout'),
  loginUrl: (returnTo: string) => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
};

// =====================================================================
// Файлы (§4.2)
// =====================================================================

export const files = {
  list: (revisionId: string) =>
    get<{ items: SourceFile[] }>(`${V1}/revisions/${revisionId}/files`).then((r) => r.items),

  initUpload: (revisionId: string, fileName: string, sizeBytes: number) =>
    request<UploadTicket>('POST', `${V1}/revisions/${revisionId}/files/upload/init`, {
      body: { fileName, sizeBytes },
    }).then((r) => r.data),

  completeUpload: (revisionId: string, uploadId: string) =>
    request<SourceFile>('POST', `${V1}/revisions/${revisionId}/files/upload/complete`, {
      body: { uploadId },
      idempotencyKey: newIdempotencyKey('upload'),
    }).then((r) => r.data),

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

  freeze: (layoutId: string, version: number) =>
    request<FreezeResult>('POST', `${V1}/layouts/${layoutId}/freeze`, {
      ifMatch: version,
      idempotencyKey: newIdempotencyKey('freeze'),
    }).then((r) => r.data),
};

export type BlockMutationResponse = ApiResponse<BlockMutationResult>;

// =====================================================================
// Распознавание (§6.2)
// =====================================================================

export const recognition = {
  start: (revisionId: string, frozenLayoutId: string) =>
    request<RecognizeResult>('POST', `${V1}/revisions/${revisionId}/recognize`, {
      body: { frozenLayoutId },
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

  findings: (revisionId: string, validationRunId?: string) =>
    get<{ items: Finding[] }>(`${V1}/revisions/${revisionId}/findings`, {
      query: validationRunId === undefined ? {} : { validationRunId },
    }).then((r) => r.items),

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
  processingStatus: (revisionId: string) =>
    get<ProcessingStatus>(`${V1}/revisions/${revisionId}/processing-status`),
  streamUrl: (revisionId: string) => `${V1}/revisions/${revisionId}/events`,
};

// =====================================================================
// Справочники (§14)
// =====================================================================

export const catalog = {
  objects: (query?: { search?: string; limit?: number }) =>
    get<Page<ConstructionObject>>(`${V1}/catalog/objects`, {
      query: { ...(query?.search === undefined ? {} : { search: query.search }), limit: 100 },
    }),

  object: (objectId: string) => get<ConstructionObject>(`${V1}/catalog/objects/${objectId}`),

  counterparties: (query?: { search?: string; kind?: string }) =>
    get<Page<Counterparty>>(`${V1}/catalog/counterparties`, {
      query: {
        ...(query?.search === undefined ? {} : { search: query.search }),
        ...(query?.kind === undefined ? {} : { kind: query.kind }),
        limit: 100,
      },
    }),

  /** Список разделов приходит массивом, а не конвертом — так объявлена схема. */
  sections: (objectId: string) =>
    get<ObjectSection[]>(`${V1}/catalog/objects/${objectId}/sections`),

  sectionKinds: () => get<SectionKind[]>(`${V1}/catalog/section-kinds`),

  rdDocuments: (objectId: string, search?: string) =>
    get<Page<RdDocument>>(`${V1}/catalog/objects/${objectId}/rd-documents`, {
      query: { ...(search === undefined || search === '' ? {} : { search }), limit: 100 },
    }),

  /**
   * Все версии профиля вида раздела.
   *
   * Отдаётся массивом, а не конвертом — так объявлена `sectionProfileListSchema`.
   */
  sectionProfiles: (sectionKindCode?: string) =>
    get<SectionProfile[]>(`${V1}/catalog/section-profiles`, {
      query: sectionKindCode === undefined ? {} : { sectionKindCode },
    }),

  /**
   * Профиль, действующий на дату.
   *
   * Отдельный маршрут, а не фильтр списка: сервер отвечает 404, когда профиля на
   * дату нет, и это законное состояние открытого мира — «раздел не настроен», а
   * не «список пуст». Экран обязан различать их (§9.1).
   */
  effectiveSectionProfile: (sectionKindCode: string, at?: string) =>
    get<SectionProfile>(`${V1}/catalog/section-kinds/${sectionKindCode}/effective-profile`, {
      query: at === undefined ? {} : { at },
    }),

  createSectionProfile: (body: {
    sectionKindCode: string;
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

  settings: () => get<SettingsView>(`${V1}/admin/settings`),

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
};

export type { LayoutBlock };
