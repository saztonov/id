/**
 * Ключи кэша TanStack Query.
 *
 * Собраны в одном месте, чтобы инвалидация после мутации попадала в тот же
 * ключ, которым читали. Ключи, написанные по месту, расходятся на одну букву, и
 * тогда экран показывает старые данные после успешной правки — дефект, который
 * выглядит как «сервер не сохранил».
 */
export const layoutKeys = {
  folders: (folderId: string) => ['layouts', 'of-folder', folderId] as const,
  detail: (layoutId: string) => ['layouts', layoutId] as const,
  blocks: (layoutId: string) => ['layouts', layoutId, 'blocks'] as const,
};

export const folderKeys = {
  files: (folderId: string) => ['folders', folderId, 'files'] as const,
  bundles: (folderId: string) => ['folders', folderId, 'bundles'] as const,
  bundlePages: (bundleId: string) => ['bundles', bundleId, 'pages'] as const,
  workflow: (folderId: string) => ['folders', folderId, 'workflow'] as const,
  processingStatus: (folderId: string) => ['folders', folderId, 'processing-status'] as const,
  documents: (folderId: string) => ['folders', folderId, 'documents'] as const,
  pages: (folderId: string) => ['folders', folderId, 'pages'] as const,
  registry: (folderId: string) => ['folders', folderId, 'registry'] as const,
  classifications: (folderId: string) => ['folders', folderId, 'classifications'] as const,
  checkRuns: (folderId: string) => ['folders', folderId, 'check-runs'] as const,
  findings: (folderId: string) => ['folders', folderId, 'findings'] as const,
  checkReport: (folderId: string) => ['folders', folderId, 'check-report'] as const,
  recognitionRuns: (folderId: string) => ['folders', folderId, 'recognition-runs'] as const,
  archive: (folderId: string) => ['folders', folderId, 'archive'] as const,
};

export const pipelineKeys = {
  recognitionProgress: (runId: string) => ['recognition-runs', runId, 'progress'] as const,
};

/** Опубликованный результат прогона: текст страниц и текст блоков. */
export const recognitionKeys = {
  pages: (runId: string) => ['recognition-runs', runId, 'pages'] as const,
  blocks: (runId: string) => ['recognition-runs', runId, 'blocks'] as const,
};

export const documentKeys = {
  detail: (documentId: string) => ['documents', documentId] as const,
  fields: (documentId: string) => ['documents', documentId, 'fields'] as const,
};

export const catalogKeys = {
  /**
   * Справочник объектов ОДНОЙ страницей (`useQuery`).
   *
   * Ключ отличается от `objectsPaged` не из аккуратности: под одним ключом не
   * могут жить `useQuery` и `useInfiniteQuery`. Формы данных у них разные —
   * `{ items, nextCursor }` против `{ pages, pageParams }`, — и кто сходил
   * первым, тот и задал форму в кэше. Второй экран получает готовые данные, у
   * которых нет его полей: `data.items` оказывается `undefined`, таблица
   * пустеет, и НИ ошибки, ни загрузки при этом нет.
   *
   * Так и было до S39: галерея раздела ИД наполняла кэш инфинити-структурой, а
   * «Справочники → Объекты» после неё показывали «В справочнике нет ни одного
   * объекта» при двух заведённых объектах. Экран выглядел рабочим и молчал.
   */
  objects: (search: string) => ['catalog', 'objects', search] as const,
  /** Тот же справочник с докруткой (`useInfiniteQuery`) — галерея раздела ИД. */
  objectsPaged: (search: string) => ['catalog', 'objects', 'paged', search] as const,
  /**
   * Один объект.
   *
   * Сегмент `one` обязателен: без него ключ карточки неотличим по ФОРМЕ от
   * ключа списка (`['catalog','objects', <строка>]`), и совпасть им мешает лишь
   * то, что поиск редко бывает похож на UUID. Это та же ловушка, что развела
   * `objects` и `objectsPaged`, только менее вероятная — а разводится она
   * одним словом.
   */
  object: (objectId: string) => ['catalog', 'objects', 'one', objectId] as const,
  counterparties: (search: string, kind: string) =>
    ['catalog', 'counterparties', search, kind] as const,
  sections: (objectId: string) => ['catalog', 'sections', objectId] as const,
  sectionCatalog: (includeInactive: boolean) =>
    ['catalog', 'sections', 'all', includeInactive] as const,
  objectContractors: (objectId: string) => ['catalog', 'object-contractors', objectId] as const,
  rdDocuments: (objectId: string, search: string) =>
    ['catalog', 'rd-documents', objectId, search] as const,
  sectionProfiles: (sectionCode: string) => ['catalog', 'section-profiles', sectionCode] as const,
  effectiveSectionProfile: (sectionCode: string, at: string) =>
    ['catalog', 'section-profiles', 'effective', sectionCode, at] as const,
  docTypes: (includeInactive: boolean) => ['catalog', 'doc-types', includeInactive] as const,
  candidates: (status: string) => ['catalog', 'doc-type-candidates', status] as const,
  counterpartyKinds: () => ['catalog', 'counterparty-kinds'] as const,
  imports: (target: string) => ['catalog', 'imports', target] as const,
  import: (importId: string) => ['catalog', 'imports', 'one', importId] as const,
  importRows: (importId: string, verdict: string) =>
    ['catalog', 'imports', 'one', importId, 'rows', verdict] as const,
};

export const navigationKeys = {
  /** Префикс всей навигационной ветки: обесценивается целиком после удаления. */
  root: ['nav'] as const,
  folderList: (filter: string) => ['nav', 'folders', filter] as const,
  folderDeletionPreview: (folderId: string) =>
    ['nav', 'folders', 'one', folderId, 'deletion'] as const,
  /**
   * Состояние конвейера по странице списка комплектов.
   *
   * Идентификаторы входят в КЛЮЧ: страница «Показать ещё» меняет состав
   * вопроса, и общий ключ отдал бы ответ про прежнюю страницу.
   */
  foldersPipeline: (objectId: string, folderIds: string) =>
    ['nav', 'folders', 'pipeline', objectId, folderIds] as const,
  folder: (folderId: string) => ['nav', 'folders', 'one', folderId] as const,
  sectionCounts: (objectId: string, filter: string) =>
    ['nav', 'folders', 'counts', objectId, filter] as const,
};

export const adminKeys = {
  users: (search: string) => ['admin', 'users', search] as const,
  user: (userId: string) => ['admin', 'users', userId] as const,
  settings: () => ['admin', 'settings'] as const,
  rules: () => ['admin', 'rules'] as const,
  rulesets: () => ['admin', 'rulesets'] as const,
  ruleset: (rulesetId: string) => ['admin', 'rulesets', 'one', rulesetId] as const,
  prompts: (filter: string) => ['admin', 'prompts', filter] as const,
  jobs: (filter: string) => ['admin', 'jobs', filter] as const,
  job: (jobId: string) => ['admin', 'jobs', 'one', jobId] as const,
  queues: () => ['admin', 'queues'] as const,
  audit: (filter: string) => ['admin', 'audit', filter] as const,
  ruleCatalog: () => ['admin', 'rule-catalog'] as const,
  errors: (filter: string) => ['admin', 'errors', filter] as const,
  errorIssue: (issueId: string) => ['admin', 'errors', 'one', issueId] as const,
  errorSeries: (issueId: string) => ['admin', 'errors', 'series', issueId] as const,
  errorSummary: () => ['admin', 'errors', 'summary'] as const,
  errorSamples: (filter: string) => ['admin', 'errors', 'samples', filter] as const,
  feedbackSummary: (filter: string) => ['admin', 'feedback', 'summary', filter] as const,
  feedbackEvents: (filter: string) => ['admin', 'feedback', 'events', filter] as const,
  httpAnomalies: () => ['admin', 'http-anomalies'] as const,
  slowOperations: (kind: string) => ['admin', 'slow-operations', kind] as const,
};
