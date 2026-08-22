/**
 * Согласование, выдача архива и удержания (§4.1, §4.2, §9.6, §13, §14).
 *
 * ## Права разведены по действиям, а не по «старшинству роли»
 *
 * `submission.submit` — подрядчик, `revision.return` и `revision.approve` —
 * инженер и руководитель, `revision.override` — только руководитель (§4.1).
 * Все четыре права уже объявлены в матрице `require-permission.ts`, этап их не
 * добавляет: он даёт им маршруты. До S10 три из четырёх не имели ни одного
 * вызывающего — то есть выглядели действующей защитой, ничего не защищая.
 *
 * ## Нажатие кладёт строку в `jobs`
 *
 * Прямой урок S5. Согласование ставит `submission.build_archive`, подтверждение
 * границ (модуль документов) ставит `doc.materialize_pdf`, а тесты проверяют
 * ТАБЛИЦУ, а не наличие вызова в коде.
 *
 * ## Постановка задачи не имеет права отменить состоявшееся решение
 *
 * Задача ставится ПОСЛЕ фиксации перехода и отдельной операцией. Если очередь
 * на секунду недоступна, согласование всё равно состоялось: терять решение
 * человека из-за инфраструктуры нельзя, а пересобрать архив можно повторным
 * `POST .../archive`. Тот же порядок выбран на S5 для приёма файлов.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import { badRequest, conflict, notFound } from '../../lib/problem.js';
import { requireIfMatch } from '../../lib/http-headers.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import { loadBundlePlan } from '../../db/repositories/bundles.js';
import {
  findArchive,
  findDerivedDocument,
  requireReadyArchive,
} from '../../db/repositories/delivery.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import {
  approveBlockers,
  approveRevision,
  countActiveHolds,
  findRevisionWorkflow,
  listLegalHolds,
  listReviewActions,
  loadRevisionReadiness,
  overrideFinding,
  placeLegalHold,
  releaseLegalHold,
  returnRevision,
  submitBlockers,
  submitRevision,
  takeRevisionToReview,
  type RevisionWorkflowView,
  type WorkflowResult,
} from '../../db/repositories/workflow.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import { documentPdfKey } from '../../storage/keys.js';
import { decideRetention } from '../../storage/retention.js';
import { contentDisposition, parseRangeHeader } from '../files/routes.js';
import {
  archiveStateSchema,
  commentBodySchema,
  documentIdParamSchema,
  findingIdParamSchema,
  holdIdParamSchema,
  legalHoldListSchema,
  legalHoldSchema,
  materializeResponseSchema,
  overrideResultSchema,
  reasonBodySchema,
  releaseBodySchema,
  retentionSchema,
  revisionIdParamSchema,
  workflowResultSchema,
  workflowStateSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const submitPermission = requirePermission('submission.submit');
const approvePermission = requirePermission('revision.approve');
const returnPermission = requirePermission('revision.return');
const overridePermission = requirePermission('revision.override');
const archivePermission = requirePermission('archive.download');
const readPermission = requirePermission('submission.read');
const editDocuments = requirePermission('document.edit');
const managePermission = requirePermission('settings.manage');

export function registerWorkflowRoutes(app: AppInstance): void {
  registerStateRoutes(app);
  registerTransitionRoutes(app);
  registerDeliveryRoutes(app);
  registerRetentionRoutes(app);
}

// =====================================================================
// Заголовки
// =====================================================================

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') return 'default';
  const trimmed = value.trim();
  if (trimmed.length > 128 || !/^[\w.:@-]+$/.test(trimmed)) {
    throw badRequest('Idempotency-Key: до 128 символов из [A-Za-z0-9._:@-].');
  }
  return trimmed;
}

function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

function toView(revision: RevisionWorkflowView) {
  return {
    id: revision.id,
    workId: revision.workId,
    revisionNo: revision.revisionNo,
    status: revision.status,
    parentRevisionId: revision.parentRevisionId,
    aggregateManifestHash: revision.aggregateManifestHash,
    version: revision.version,
    submittedAt: revision.submittedAt,
    decidedAt: revision.decidedAt,
    returnReason: revision.returnReason,
  };
}

function respond(
  reply: FastifyReply,
  result: WorkflowResult,
  job: { readonly jobId: string | null; readonly jobCreated: boolean },
) {
  return reply
    .header('etag', `"${result.revision.version}"`)
    .code(200)
    .send({
      revision: toView(result.revision),
      nextRevisionId: result.nextRevisionId,
      manifestMatchesParent: result.manifestMatchesParent,
      ...job,
    });
}

const NO_JOB = { jobId: null, jobCreated: false } as const;

// =====================================================================
// Чтение состояния
// =====================================================================

function registerStateRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/revisions/:revisionId/workflow`,
    {
      preHandler: readPermission,
      schema: { params: revisionIdParamSchema, response: { 200: workflowStateSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      const revision = await findRevisionWorkflow(app.db, scope, revisionId);
      if (revision === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ revisionId, objectId: revision.objectId });

      const readiness = await loadRevisionReadiness(app.db, scope, revisionId);
      const actions = await listReviewActions(app.db, scope, revisionId);

      return reply
        .header('etag', `"${revision.version}"`)
        .code(200)
        .send({
          revision: toView(revision),
          readiness: {
            fileCount: readiness.fileCount,
            filesNotOk: readiness.filesNotOk,
            hasBundle: readiness.hasBundle,
            documentCount: readiness.documentCount,
            unconfirmedDocuments: readiness.unconfirmedDocuments,
            unmaterializedDocuments: readiness.unmaterializedDocuments,
            openBlockingFindings: readiness.openBlockingFindings,
            finishedValidationRuns: readiness.finishedValidationRuns,
          },
          submitBlockers: [...submitBlockers(revision, readiness)],
          approveBlockers: [...approveBlockers(revision, readiness)],
          actions: actions.map((action) => ({ ...action })),
        });
    },
  );
}

// =====================================================================
// Переходы
// =====================================================================

function registerTransitionRoutes(app: AppInstance): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/submit`,
    {
      preHandler: submitPermission,
      schema: {
        params: revisionIdParamSchema,
        body: commentBodySchema,
        response: { 200: workflowResultSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const { revisionId } = request.params;
      const expectedVersion = requireIfMatch(request, 'ревизии');
      updateContext({ revisionId });

      // Хэш состава считает план сборки — тот же код, что пиннит его в
      // `processing_bundles`. Второй реализации быть не должно: разойдясь, они
      // сделали бы «состав не менялся» и «состав не менялся» разными фактами.
      const plan = await loadBundlePlan(app.db, scope, revisionId);
      if (plan === null) throw notFound('Ревизия поставки не найдена.');

      const result = await submitRevision(app.db, scope, {
        revisionId,
        actorUserId: user.id,
        expectedVersion,
        aggregateManifestHash: plan.aggregateManifestHash,
        ...(request.body.comment === undefined ? {} : { comment: request.body.comment }),
        actor: auditActor(app, request),
      });

      request.log.info(
        {
          event: 'revision_submitted',
          revision_id: revisionId,
          manifest_matches_parent: result.manifestMatchesParent,
        },
        'комплект подан на проверку',
      );
      return respond(reply, result, NO_JOB);
    },
  );

  app.post(
    `${PREFIX}/revisions/:revisionId/review`,
    {
      preHandler: approvePermission,
      schema: {
        params: revisionIdParamSchema,
        body: commentBodySchema,
        response: { 200: workflowResultSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request, 'ревизии');
      updateContext({ revisionId: request.params.revisionId });

      const result = await takeRevisionToReview(app.db, scope, {
        revisionId: request.params.revisionId,
        actorUserId: user.id,
        expectedVersion,
        ...(request.body.comment === undefined ? {} : { comment: request.body.comment }),
        actor: auditActor(app, request),
      });
      return respond(reply, result, NO_JOB);
    },
  );

  app.post(
    `${PREFIX}/revisions/:revisionId/return`,
    {
      preHandler: returnPermission,
      schema: {
        params: revisionIdParamSchema,
        body: reasonBodySchema,
        response: { 200: workflowResultSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request, 'ревизии');
      updateContext({ revisionId: request.params.revisionId });

      const result = await returnRevision(app.db, scope, {
        revisionId: request.params.revisionId,
        actorUserId: user.id,
        expectedVersion,
        reason: request.body.reason,
        actor: auditActor(app, request),
      });

      request.log.info(
        {
          event: 'revision_returned',
          revision_id: request.params.revisionId,
          next_revision_id: result.nextRevisionId,
        },
        'ревизия возвращена подрядчику, открыта следующая',
      );
      return respond(reply, result, NO_JOB);
    },
  );

  app.post(
    `${PREFIX}/revisions/:revisionId/approve`,
    {
      preHandler: approvePermission,
      schema: {
        params: revisionIdParamSchema,
        body: commentBodySchema,
        response: { 200: workflowResultSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const { revisionId } = request.params;
      const expectedVersion = requireIfMatch(request, 'ревизии');
      updateContext({ revisionId });

      const result = await approveRevision(app.db, scope, {
        revisionId,
        actorUserId: user.id,
        expectedVersion,
        ...(request.body.comment === undefined ? {} : { comment: request.body.comment }),
        actor: auditActor(app, request),
      });

      const job = await enqueueArchive(app, request, revisionId);
      request.log.info(
        { event: 'revision_approved', revision_id: revisionId, job_id: job.jobId },
        'ревизия согласована, сборка архива поставлена в очередь',
      );
      return respond(reply, result, job);
    },
  );

  app.post(
    `${PREFIX}/findings/:findingId/override`,
    {
      preHandler: overridePermission,
      schema: {
        params: findingIdParamSchema,
        body: reasonBodySchema,
        response: { 200: overrideResultSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const result = await overrideFinding(app.db, scope, {
        findingId: request.params.findingId,
        actorUserId: user.id,
        reason: request.body.reason,
        actor: auditActor(app, request),
      });
      updateContext({ revisionId: result.revisionId });

      request.log.info(
        {
          event: 'finding_overridden',
          revision_id: result.revisionId,
          rule_code: result.ruleCode,
        },
        'блокирующее замечание снято обоснованным решением руководителя',
      );
      return reply.code(200).send(result);
    },
  );
}

async function enqueueArchive(
  app: AppInstance,
  request: FastifyRequest,
  revisionId: string,
): Promise<{ readonly jobId: string | null; readonly jobCreated: boolean }> {
  const { scope } = currentAuth(request);
  try {
    const { jobId, created } = await enqueueJob(app.db, scope, {
      type: 'submission.build_archive',
      payload: tracePayload({ revisionId }),
      dedupeKey: dedupeKeyFor('submission.build_archive', revisionId),
    });
    return { jobId, jobCreated: created };
  } catch (error) {
    // Решение уже зафиксировано, и терять его из-за недоступной очереди нельзя.
    // Отсутствие архива видно состоянием `pending`, а пересборка — отдельным
    // действием, поэтому тупика здесь нет.
    request.log.error(
      { event: 'archive_job_not_enqueued', revision_id: revisionId, reason: (error as Error).name },
      'архив согласованной ревизии не поставлен в очередь',
    );
    return { jobId: null, jobCreated: false };
  }
}

// =====================================================================
// Нарезка и выдача
// =====================================================================

function registerDeliveryRoutes(app: AppInstance): void {
  /**
   * Пересборка нарезки по всей ревизии.
   *
   * Существует ради выхода из состояния «задача исчерпала попытки»: без него
   * единственным способом получить нарезку было бы переподтверждение каждого
   * документа по отдельности.
   */
  app.post(
    `${PREFIX}/revisions/:revisionId/materialize`,
    {
      preHandler: editDocuments,
      schema: { params: revisionIdParamSchema, response: { 202: materializeResponseSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;
      updateContext({ revisionId });

      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'doc.materialize_pdf',
        payload: tracePayload({ revisionId }),
        dedupeKey: dedupeKeyFor('doc.materialize_pdf', revisionId, idempotencyKey(request)),
      });

      return reply.code(202).send({ revisionId, jobId, jobCreated: created });
    },
  );

  app.get(
    `${PREFIX}/documents/:documentId/pdf`,
    { preHandler: readPermission, schema: { params: documentIdParamSchema } },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const document = await findDerivedDocument(app.db, scope, request.params.documentId);
      if (document === null) {
        throw notFound('Нарезанный документ не найден: возможно, нарезка ещё не выполнена.');
      }
      updateContext({ revisionId: document.revisionId, objectId: document.objectId });

      const object = await app.storage.getObjectStream(documentPdfKey(document.documentId));

      return reply
        .header('content-type', 'application/pdf')
        .header('content-length', String(object.contentLength))
        .header('content-disposition', contentDisposition(derivedFileName(document)))
        .header('etag', `"${document.sha256}"`)
        .code(200)
        .send(object.stream);
    },
  );

  app.get(
    `${PREFIX}/revisions/:revisionId/archive`,
    {
      preHandler: archivePermission,
      schema: { params: revisionIdParamSchema, response: { 200: archiveStateSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      const revision = await findRevisionWorkflow(app.db, scope, revisionId);
      if (revision === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ revisionId, objectId: revision.objectId });

      const archive = await findArchive(app.db, scope, revisionId);
      const state =
        archive !== null ? 'ready' : revision.status === 'approved' ? 'pending' : 'absent';

      return reply.code(200).send({
        revisionId,
        state,
        archive:
          archive === null
            ? null
            : {
                sha256: archive.archiveSha256,
                byteSize: archive.byteSize,
                entryCount: archive.entryCount,
                builderVersion: archive.builderVersion,
                createdAt: archive.createdAt,
              },
      });
    },
  );

  /** Повторная сборка архива: тот же выход из тупика, что и у нарезки. */
  app.post(
    `${PREFIX}/revisions/:revisionId/archive`,
    {
      preHandler: approvePermission,
      schema: { params: revisionIdParamSchema, response: { 202: materializeResponseSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      const revision = await findRevisionWorkflow(app.db, scope, revisionId);
      if (revision === null) throw notFound('Ревизия поставки не найдена.');
      if (revision.status !== 'approved') {
        throw conflict('Архив собирается только у согласованной ревизии.');
      }
      updateContext({ revisionId, objectId: revision.objectId });

      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'submission.build_archive',
        payload: tracePayload({ revisionId }),
        dedupeKey: dedupeKeyFor('submission.build_archive', revisionId, idempotencyKey(request)),
      });
      return reply.code(202).send({ revisionId, jobId, jobCreated: created });
    },
  );

  app.get(
    `${PREFIX}/revisions/:revisionId/archive/content`,
    { preHandler: archivePermission, schema: { params: revisionIdParamSchema } },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      const revision = await findRevisionWorkflow(app.db, scope, revisionId);
      if (revision === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ revisionId, objectId: revision.objectId });

      const archive = await requireReadyArchive(app.db, scope, revisionId);
      const requested = parseRangeHeader(request.headers.range, archive.byteSize);
      if (requested === 'unsatisfiable') {
        return reply
          .code(416)
          .header('content-range', `bytes */${archive.byteSize}`)
          .header('accept-ranges', 'bytes')
          .send();
      }

      const object = await app.storage.getObjectStream(archive.s3Key, requested ?? undefined);
      const served = object.range;

      reply
        .header('accept-ranges', 'bytes')
        .header('content-type', 'application/zip')
        .header('content-length', String(object.contentLength))
        .header('content-disposition', contentDisposition(`rev${revision.revisionNo}-approved.zip`))
        .header('etag', `"${archive.archiveSha256}"`);

      if (served !== null) {
        reply
          .code(206)
          .header('content-range', `bytes ${served.start}-${served.end}/${object.sizeBytes}`);
      }
      return reply.send(object.stream);
    },
  );
}

/**
 * Имя файла нарезки для `Content-Disposition`.
 *
 * Из порядкового номера и вида документа, а не из заголовка: заголовок берётся
 * из распознанного текста и может содержать что угодно, включая переводы строк
 * и кавычки, разрывающие заголовок ответа. Имя обязано быть предсказуемым.
 */
function derivedFileName(document: {
  readonly ordinal: number;
  readonly docTypeCode: string | null;
}): string {
  const kind = document.docTypeCode ?? 'document';
  return `${String(document.ordinal + 1).padStart(3, '0')}-${kind}.pdf`;
}

// =====================================================================
// Retention и legal hold (§4.2)
// =====================================================================

function registerRetentionRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/revisions/:revisionId/legal-holds`,
    {
      preHandler: managePermission,
      schema: { params: revisionIdParamSchema, response: { 200: legalHoldListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listLegalHolds(app.db, scope, {
        revisionId: request.params.revisionId,
      });
      return reply.code(200).send({ items: items.map((item) => ({ ...item })) });
    },
  );

  app.post(
    `${PREFIX}/revisions/:revisionId/legal-holds`,
    {
      preHandler: managePermission,
      schema: {
        params: revisionIdParamSchema,
        body: reasonBodySchema,
        response: { 201: legalHoldSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const hold = await placeLegalHold(app.db, scope, {
        revisionId: request.params.revisionId,
        reason: request.body.reason,
        actorUserId: user.id,
        actor: auditActor(app, request),
      });
      updateContext({ revisionId: request.params.revisionId });
      return reply.code(201).send({ ...hold });
    },
  );

  app.post(
    `${PREFIX}/legal-holds/:holdId/release`,
    {
      preHandler: managePermission,
      schema: {
        params: holdIdParamSchema,
        body: releaseBodySchema,
        response: { 200: legalHoldSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const hold = await releaseLegalHold(app.db, scope, {
        holdId: request.params.holdId,
        note: request.body.note,
        actorUserId: user.id,
        actor: auditActor(app, request),
      });
      return reply.code(200).send({ ...hold });
    },
  );

  /**
   * Решение о хранении по одной ревизии (§4.2).
   *
   * Отчёт, а не кнопка «удалить»: удаление выполняется отдельной ограниченной
   * ролью и процедурой владельца БД (см. заголовок миграции 0008 и
   * `storage/retention.ts`). Оператору нужно понимать, ПОЧЕМУ данные ещё лежат,
   * и различать «срок не вышел» от «стоит удержание» — это разные действия.
   */
  app.get(
    `${PREFIX}/revisions/:revisionId/retention`,
    {
      preHandler: managePermission,
      schema: { params: revisionIdParamSchema, response: { 200: retentionSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      const revision = await findRevisionWorkflow(app.db, scope, revisionId);
      if (revision === null) throw notFound('Ревизия поставки не найдена.');

      const activeHolds = await countActiveHolds(app.db, revisionId);
      const policy = {
        retentionDays: app.env.RETENTION_DAYS,
        legalHoldEnabled: app.env.LEGAL_HOLD_ENABLED,
      };
      const decision = decideRetention(
        { status: revision.status, decidedAt: revision.decidedAt, activeHolds },
        policy,
      );

      return reply.code(200).send({
        revisionId,
        status: revision.status,
        decidedAt: revision.decidedAt,
        activeHolds,
        policy,
        decision: { ...decision, blocks: [...decision.blocks] },
      });
    },
  );
}
