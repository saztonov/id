/**
 * Схемы согласования, выдачи и удержаний (§4.1, §4.2, §13, §14).
 *
 * Обоснование действия — обязательное поле с непустой длиной, а не «строка».
 * §9.6 требует обоснования у override, а §3 — причины у возврата, и обе
 * величины уезжают в `review_actions` и в `audit_log`, то есть в юридически
 * значимый след. Пустая строка там означала бы решение без причины, записанное
 * как решение с причиной.
 */
import { z } from 'zod';

export const revisionIdParamSchema = z.object({ revisionId: z.uuid() });
export const documentIdParamSchema = z.object({ documentId: z.uuid() });
export const findingIdParamSchema = z.object({ findingId: z.uuid() });
export const holdIdParamSchema = z.object({ holdId: z.uuid() });

/** Нижняя граница обоснования: короче — это не объяснение, а отписка. */
const reason = z.string().trim().min(10).max(2000);

export const commentBodySchema = z.object({
  comment: z.string().trim().min(1).max(2000).optional(),
});

export const reasonBodySchema = z.object({ reason });

export const releaseBodySchema = z.object({ note: reason });

export const workflowStatusSchema = z.enum([
  'draft',
  'submitted',
  'in_review',
  'returned',
  'approved',
  'superseded',
]);

export const revisionWorkflowSchema = z.object({
  id: z.uuid(),
  workId: z.uuid(),
  revisionNo: z.int(),
  status: workflowStatusSchema,
  parentRevisionId: z.uuid().nullable(),
  aggregateManifestHash: z.string().nullable(),
  version: z.int(),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  returnReason: z.string().nullable(),
});

export const readinessSchema = z.object({
  fileCount: z.int(),
  filesNotOk: z.int(),
  hasBundle: z.boolean(),
  documentCount: z.int(),
  unconfirmedDocuments: z.int(),
  unmaterializedDocuments: z.int(),
  openBlockingFindings: z.int(),
  finishedValidationRuns: z.int(),
});

export const reviewActionSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  actorUserId: z.uuid(),
  action: z.string(),
  comment: z.string().nullable(),
  at: z.string(),
});

/**
 * Состояние согласования одним ответом.
 *
 * Препятствия отдаются СПИСКОМ вместе со статусом: экран обязан показывать, что
 * именно мешает согласовать, а не выяснять это отказом на нажатие.
 */
export const workflowStateSchema = z.object({
  revision: revisionWorkflowSchema,
  readiness: readinessSchema,
  submitBlockers: z.array(z.string()),
  approveBlockers: z.array(z.string()),
  actions: z.array(reviewActionSchema),
});

export const workflowResultSchema = z.object({
  revision: revisionWorkflowSchema,
  nextRevisionId: z.uuid().nullable(),
  manifestMatchesParent: z.boolean().nullable(),
  /** Поставленная действием задача: у submit её нет, у approve это архив. */
  jobId: z.uuid().nullable(),
  jobCreated: z.boolean(),
});

export const overrideResultSchema = z.object({
  findingId: z.uuid(),
  revisionId: z.uuid(),
  ruleCode: z.string(),
});

export const materializeResponseSchema = z.object({
  revisionId: z.uuid(),
  jobId: z.uuid().nullable(),
  jobCreated: z.boolean(),
});

/**
 * Состояние архива ревизии.
 *
 * `state` вычисляется, а не хранится (§3.8): `ready` — есть строка
 * `submission_archives`, `pending` — ревизия согласована, строки ещё нет,
 * `absent` — согласования не было. Хранимое поле пришлось бы поддерживать в
 * согласии с очередью и врать при падении воркера.
 */
export const archiveStateSchema = z.object({
  revisionId: z.uuid(),
  state: z.enum(['absent', 'pending', 'ready']),
  archive: z
    .object({
      sha256: z.string(),
      byteSize: z.int(),
      entryCount: z.int(),
      builderVersion: z.string(),
      createdAt: z.string(),
    })
    .nullable(),
});

export const legalHoldSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  reason: z.string(),
  placedBy: z.uuid(),
  placedAt: z.string(),
  releasedBy: z.uuid().nullable(),
  releasedAt: z.string().nullable(),
  releaseNote: z.string().nullable(),
});

export const legalHoldListSchema = z.object({ items: z.array(legalHoldSchema) });

export const retentionSchema = z.object({
  revisionId: z.uuid(),
  status: workflowStatusSchema,
  decidedAt: z.string().nullable(),
  activeHolds: z.int(),
  policy: z.object({ retentionDays: z.int(), legalHoldEnabled: z.boolean() }),
  decision: z.object({
    deletable: z.boolean(),
    blocks: z.array(
      z.enum(['decision_pending', 'retention_not_expired', 'legal_hold', 'invalid_decision_date']),
    ),
    retainedUntil: z.string().nullable(),
    legalHoldOverridden: z.boolean(),
  }),
});
