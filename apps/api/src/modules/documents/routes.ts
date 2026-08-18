/**
 * Экран «Документы»: сборка, границы, реквизиты и учёт страниц (§8, §14).
 *
 * ## Нажатие кнопки кладёт строку в `jobs`
 *
 * Прямой урок S5: обработчики задач 1–3 были написаны, зарегистрированы и
 * покрыты тестами, а в очередь их не ставил никто — весь конвейер §12 не
 * запускался вовсе. Поэтому `POST .../segment` ставит `doc.classify_pages`, а
 * тест проверяет ТАБЛИЦУ `jobs`, а не наличие вызова в коде.
 *
 * Цепочка дальше собирается сама: задача 14 ставит 15, та — 16–19. Ставить их
 * все отсюда значило бы дать каждой стартовать до того, как предыдущая
 * записала свой результат.
 *
 * ## Права
 *
 * Сборка и подтверждение — `document.edit` (§4.1: границы и тип правит
 * проверяющий, не подрядчик). Чтение — `submission.read`: подрядчик обязан
 * видеть, как разобрали ЕГО комплект, иначе замечание «документ не найден»
 * нечем проверить. Новых прав этап не вводит.
 *
 * ## Учёт страниц отдаётся вместе с неучтёнными
 *
 * `GET .../pages` возвращает и `unaccounted` из `v_unaccounted_pages`. Список
 * обязан быть пуст (§16), и именно поэтому он в ответе: ненулевой набор — это
 * видимый сигнал, а не тишина.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import { badRequest, notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import {
  confirmDocument,
  findLogicalDocument,
  listDocumentRelations,
  listFieldValues,
  listLogicalDocuments,
  listPageAssignments,
  listPageClassifications,
  listRegistryRows,
  listUnaccountedPages,
  type LogicalDocumentView,
} from '../../db/repositories/documents.js';
import {
  classificationListSchema,
  confirmRequestSchema,
  documentDetailSchema,
  documentIdParamSchema,
  documentListSchema,
  fieldValueListSchema,
  pageAccountingSchema,
  registryListSchema,
  revisionIdParamSchema,
  segmentRequestSchema,
  segmentResponseSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const editDocuments = requirePermission('document.edit');
const readDocuments = requirePermission('submission.read');

export function registerDocumentRoutes(app: AppInstance): void {
  registerSegmentRoute(app);
  registerReadRoutes(app);
  registerConfirmRoute(app);
}

function toView(document: LogicalDocumentView) {
  return {
    id: document.id,
    revisionId: document.revisionId,
    docTypeCode: document.docTypeCode,
    ordinal: document.ordinal,
    title: document.title,
    folderGroup: document.folderGroup,
    typeConfidence: document.typeConfidence,
    boundaryConfidence: document.boundaryConfidence,
    needsReview: document.needsReview,
    isConfirmed: document.isConfirmed,
    confirmedBy: document.confirmedBy,
    confirmedAt: document.confirmedAt,
    version: document.version,
    pageCount: document.pageCount,
  };
}

/**
 * Значение `Idempotency-Key`.
 *
 * Отсутствие — 400, а не молчаливое согласие: §14 объявляет заголовок
 * обязательным на дорогих действиях, а сегментация — это прогон LLM по всем
 * страницам комплекта. «Забыли прислать» обязано быть видно сразу.
 */
function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw badRequest('Требуется заголовок Idempotency-Key.');
  }
  const trimmed = value.trim();
  if (trimmed.length > 128 || !/^[\w.:@-]+$/.test(trimmed)) {
    throw badRequest('Idempotency-Key: до 128 символов из [A-Za-z0-9._:@-].');
  }
  return trimmed;
}

/**
 * Разбор `If-Match` (§14).
 *
 * Обязателен: без него «последний записавший победил» становится поведением по
 * умолчанию, а здесь это значит, что подтверждение типа одним проверяющим молча
 * затрёт подтверждение другого. Отсутствие заголовка — 400, а не 412: 412
 * клиент понимает как «перечитай и повтори», а перечитывание тут не поможет.
 */
function requireIfMatch(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw badRequest('Требуется заголовок If-Match с версией документа.');
  }
  const cleaned = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number(cleaned);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest('Заголовок If-Match должен содержать целую версию документа.');
  }
  return parsed;
}

function withVersion(reply: FastifyReply, version: number): FastifyReply {
  return reply.header('etag', `"${version}"`);
}

/** Данные актора для `audit_log`: то, что знает только слой HTTP. */
function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

// =====================================================================
// Кнопка «Собрать документы»
// =====================================================================

function registerSegmentRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/segment`,
    {
      preHandler: editDocuments,
      schema: {
        params: revisionIdParamSchema,
        body: segmentRequestSchema,
        response: { 202: segmentResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;
      const idempotencyKey = requireIdempotencyKey(request);
      updateContext({ revisionId });

      // Область проверяет `enqueueJob`: он читает `revisionId` из payload и
      // отказывает 422, если ревизия невидима. Это тот же рубеж, что закрыл на
      // S6 постановку задачи с чужой ревизией в теле запроса.
      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'doc.classify_pages',
        payload: tracePayload({ revisionId }),
        // Ключ включает и ревизию, и заголовок идемпотентности: первая часть
        // отвечает «чья это работа», вторая — «то же самое нажатие или новое».
        dedupeKey: dedupeKeyFor('doc.classify_pages', revisionId, idempotencyKey),
      });

      request.log.info(
        {
          event: 'job_enqueued',
          job_type: 'doc.classify_pages',
          job_id: jobId,
          created,
          revision_id: revisionId,
        },
        'цепочка сегментации поставлена в очередь',
      );

      return reply.code(202).send({ revisionId, jobId, jobCreated: created });
    },
  );
}

// =====================================================================
// Чтение
// =====================================================================

function registerReadRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/revisions/:revisionId/documents`,
    {
      preHandler: readDocuments,
      schema: { params: revisionIdParamSchema, response: { 200: documentListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listLogicalDocuments(app.db, scope, request.params.revisionId);
      return reply.code(200).send({ items: items.map(toView) });
    },
  );

  app.get(
    `${PREFIX}/documents/:documentId`,
    {
      preHandler: readDocuments,
      schema: { params: documentIdParamSchema, response: { 200: documentDetailSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const document = await findLogicalDocument(app.db, scope, request.params.documentId);
      if (document === null) throw notFound('Логический документ не найден.');
      updateContext({ revisionId: document.revisionId, objectId: document.objectId });

      // Страницы и связи читаются теми же областными функциями: второй путь к
      // строкам документа не должен обходить `withScope()`.
      const assignments = await listPageAssignments(app.db, scope, document.revisionId);
      const relations = await listDocumentRelations(app.db, scope, document.revisionId);

      return withVersion(reply, document.version)
        .code(200)
        .send({
          ...toView(document),
          pages: assignments
            .filter((page) => page.documentId === document.id)
            .map((page) => ({
              sourcePageId: page.sourcePageId,
              revisionOrdinal: page.revisionOrdinal,
              sortOrder: page.sortOrder,
              pageRoleCode: page.pageRoleCode,
              needsReview: page.needsReview,
            })),
          relations: relations
            .filter(
              (edge) =>
                edge.parentDocumentId === document.id || edge.childDocumentId === document.id,
            )
            .map((edge) => ({ ...edge })),
        });
    },
  );

  app.get(
    `${PREFIX}/documents/:documentId/fields`,
    {
      preHandler: readDocuments,
      schema: { params: documentIdParamSchema, response: { 200: fieldValueListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listFieldValues(app.db, scope, request.params.documentId);
      return reply.code(200).send({ items: items.map((item) => ({ ...item })) });
    },
  );

  app.get(
    `${PREFIX}/revisions/:revisionId/pages`,
    {
      preHandler: readDocuments,
      schema: { params: revisionIdParamSchema, response: { 200: pageAccountingSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;
      const items = await listPageAssignments(app.db, scope, revisionId);
      const unaccounted = await listUnaccountedPages(app.db, scope, revisionId);

      return reply.code(200).send({
        items: items.map((item) => ({ ...item })),
        unaccounted: unaccounted.map((page) => ({ ...page })),
        counts: {
          assigned: items.filter((item) => item.documentId !== null).length,
          unassigned: items.filter((item) => item.documentId === null).length,
          unaccounted: unaccounted.length,
        },
      });
    },
  );

  app.get(
    `${PREFIX}/revisions/:revisionId/registry`,
    {
      preHandler: readDocuments,
      schema: { params: revisionIdParamSchema, response: { 200: registryListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listRegistryRows(app.db, scope, request.params.revisionId);
      return reply.code(200).send({
        items: items.map((row) => ({
          id: row.id,
          documentId: row.documentId,
          rowNo: row.rowNo,
          sectionTitle: row.sectionTitle,
          docNameRaw: row.docNameRaw,
          docNoRaw: row.docNoRaw,
          orgRaw: row.orgRaw,
          docNoNorm: row.docNoNorm,
          docNoFolded: row.docNoFolded,
          validFrom: row.validFrom,
          validTo: row.validTo,
          issuedAt: row.issuedAt,
          matchedDocumentId: row.matchedDocumentId,
          matchScore: row.matchScore,
          matchState: row.matchState,
        })),
      });
    },
  );

  app.get(
    `${PREFIX}/revisions/:revisionId/classifications`,
    {
      preHandler: readDocuments,
      schema: { params: revisionIdParamSchema, response: { 200: classificationListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listPageClassifications(app.db, scope, request.params.revisionId);
      return reply.code(200).send({
        items: items.map((item) => ({ ...item, alternatives: [...item.alternatives] })),
      });
    },
  );
}

// =====================================================================
// Подтверждение
// =====================================================================

function registerConfirmRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/documents/:documentId/confirm`,
    {
      preHandler: editDocuments,
      schema: {
        params: documentIdParamSchema,
        body: confirmRequestSchema,
        response: { 200: documentDetailSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request);
      const { documentId } = request.params;

      const document = await confirmDocument(app.db, scope, {
        documentId,
        actorUserId: user.id,
        expectedVersion,
        ...(request.body.docTypeCode === undefined
          ? {}
          : { docTypeCode: request.body.docTypeCode }),
        ...(request.body.needsReview === undefined
          ? {}
          : { needsReview: request.body.needsReview }),
        actor: auditActor(app, request),
      });
      updateContext({ revisionId: document.revisionId, objectId: document.objectId });

      // §12: нарезка идёт СРАЗУ после подтверждения границ, и ставит её именно
      // подтверждение. Иначе задача 22 осталась бы написанным и никем не
      // вызываемым обработчиком — отказ S5 в чистом виде. Отказ постановки не
      // отменяет подтверждение: решение человека уже записано, а пересобрать
      // нарезку можно `POST /revisions/{id}/materialize`.
      try {
        const { jobId, created } = await enqueueJob(app.db, scope, {
          type: 'doc.materialize_pdf',
          payload: tracePayload({ revisionId: document.revisionId, documentId }),
          dedupeKey: dedupeKeyFor('doc.materialize_pdf', documentId, String(document.version)),
        });
        request.log.info(
          {
            event: 'job_enqueued',
            job_type: 'doc.materialize_pdf',
            job_id: jobId,
            created,
            revision_id: document.revisionId,
          },
          'нарезка подтверждённого документа поставлена в очередь',
        );
      } catch (error) {
        request.log.error(
          {
            event: 'materialize_job_not_enqueued',
            revision_id: document.revisionId,
            reason: (error as Error).name,
          },
          'нарезка подтверждённого документа не поставлена в очередь',
        );
      }

      const assignments = await listPageAssignments(app.db, scope, document.revisionId);
      const relations = await listDocumentRelations(app.db, scope, document.revisionId);

      return withVersion(reply, document.version)
        .code(200)
        .send({
          ...toView(document),
          pages: assignments
            .filter((page) => page.documentId === document.id)
            .map((page) => ({
              sourcePageId: page.sourcePageId,
              revisionOrdinal: page.revisionOrdinal,
              sortOrder: page.sortOrder,
              pageRoleCode: page.pageRoleCode,
              needsReview: page.needsReview,
            })),
          relations: relations
            .filter(
              (edge) =>
                edge.parentDocumentId === document.id || edge.childDocumentId === document.id,
            )
            .map((edge) => ({ ...edge })),
        });
    },
  );
}
