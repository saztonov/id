/**
 * Ключи кэша TanStack Query.
 *
 * Собраны в одном месте, чтобы инвалидация после мутации попадала в тот же
 * ключ, которым читали. Ключи, написанные по месту, расходятся на одну букву, и
 * тогда экран показывает старые данные после успешной правки — дефект, который
 * выглядит как «сервер не сохранил».
 */
export const layoutKeys = {
  revisions: (revisionId: string) => ['layouts', 'of-revision', revisionId] as const,
  detail: (layoutId: string) => ['layouts', layoutId] as const,
  blocks: (layoutId: string) => ['layouts', layoutId, 'blocks'] as const,
};

export const revisionKeys = {
  files: (revisionId: string) => ['revisions', revisionId, 'files'] as const,
  bundles: (revisionId: string) => ['revisions', revisionId, 'bundles'] as const,
  bundlePages: (bundleId: string) => ['bundles', bundleId, 'pages'] as const,
  workflow: (revisionId: string) => ['revisions', revisionId, 'workflow'] as const,
  processingStatus: (revisionId: string) => ['revisions', revisionId, 'processing-status'] as const,
  documents: (revisionId: string) => ['revisions', revisionId, 'documents'] as const,
  pages: (revisionId: string) => ['revisions', revisionId, 'pages'] as const,
  registry: (revisionId: string) => ['revisions', revisionId, 'registry'] as const,
  classifications: (revisionId: string) => ['revisions', revisionId, 'classifications'] as const,
  checkRuns: (revisionId: string) => ['revisions', revisionId, 'check-runs'] as const,
  findings: (revisionId: string) => ['revisions', revisionId, 'findings'] as const,
  recognitionRuns: (revisionId: string) => ['revisions', revisionId, 'recognition-runs'] as const,
  archive: (revisionId: string) => ['revisions', revisionId, 'archive'] as const,
};

export const pipelineKeys = {
  recognitionProgress: (runId: string) => ['recognition-runs', runId, 'progress'] as const,
};

export const documentKeys = {
  detail: (documentId: string) => ['documents', documentId] as const,
  fields: (documentId: string) => ['documents', documentId, 'fields'] as const,
};

export const catalogKeys = {
  objects: (search: string) => ['catalog', 'objects', search] as const,
  object: (objectId: string) => ['catalog', 'objects', objectId] as const,
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
  works: (filter: string) => ['nav', 'works', filter] as const,
  work: (workId: string) => ['nav', 'works', 'one', workId] as const,
  sectionCounts: (objectId: string, filter: string) =>
    ['nav', 'works', 'counts', objectId, filter] as const,
  registries: (filter: string) => ['nav', 'registries', filter] as const,
  registry: (registryId: string) => ['nav', 'registries', 'one', registryId] as const,
  registryItems: (registryId: string) => ['nav', 'registries', 'one', registryId, 'items'] as const,
  registryReconciliation: (registryId: string) =>
    ['nav', 'registries', 'one', registryId, 'reconciliation'] as const,
  workReconciliation: (revisionId: string) =>
    ['nav', 'revisions', revisionId, 'reconciliation'] as const,
  revisions: (workId: string) => ['nav', 'revisions', workId] as const,
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
