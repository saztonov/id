/**
 * Корневой экран «ИД»: тома → поставки → ревизия (§3, §14).
 *
 * ## Чего здесь не было
 *
 * Таблицы `volumes`, `submissions` и `submission_revisions` заведены на S2,
 * ими пользуются `catalog.ts`, `checks.ts` и `delivery.ts`, а наружу они не
 * выводились ни одним маршрутом: всё, что есть по ревизии, адресовалось её
 * uuid, взявшимся неизвестно откуда. Это тот же отказ, что закрывали на S3 и
 * S5, — слой написан, таблицы есть, снаружи недостижимо.
 *
 * ## Права
 *
 * Чтение — `submission.read`: том и поставка сами по себе не содержат ничего,
 * чего не содержал бы уже доступный по этому праву список документов ревизии, а
 * состав выдачи сужает область видимости, а не право.
 *
 * Создание поставки и ревизии — `submission.upload` (§4.1: состав комплекта
 * формирует подрядчик). Новых прав модуль не вводит: `submission.upload` до
 * этого имел маршруты приёма файлов, но не имел ни одного маршрута, которым
 * подрядчик мог бы завести саму единицу работы.
 *
 * ## Одинаковый статус — разный состав ответа
 *
 * Подрядчик и руководитель на `GET /volumes` получают 200 оба, но подрядчик
 * видит только тома объектов, где у него есть поставки, а инженер без
 * назначенных объектов — пустой список. Различать «нет такого» и «не ваше»
 * наружу нельзя (§1.6): прямой идентификатор чужой поставки даёт 404, а не 403,
 * иначе перебор идентификаторов подтверждал бы существование чужой работы.
 *
 * ## Idempotency-Key здесь не требуется
 *
 * §14 объявляет его обязательным на дорогих действиях: upload complete, freeze,
 * recognize, checks и действия workflow. Создание поставки к ним не относится —
 * это вставка одной строки, повтор которой виден в списке и исправляется
 * человеком. Требовать заголовок там, где он ничего не защищает, значит
 * приучать клиента слать его формально.
 */
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import { notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import {
  createDraftRevision,
  createSubmission,
  findSubmission,
  findVolume,
  listSubmissionRevisions,
  listSubmissions,
  listVolumes,
} from '../../db/repositories/navigation.js';
import { updateContext } from '../../observability/context.js';
import {
  createSubmissionBodySchema,
  createdSubmissionSchema,
  revisionListQuerySchema,
  revisionPageSchema,
  submissionIdParamSchema,
  submissionListQuerySchema,
  submissionPageSchema,
  volumeIdParamSchema,
  volumeListQuerySchema,
  volumePageSchema,
} from './schemas.js';
import { submissionRevisionSchema, submissionSchema, volumeSchema } from '@id/contracts';

const PREFIX = '/api/v1';

const readSubmissions = requirePermission('submission.read');
const uploadSubmissions = requirePermission('submission.upload');

/** Данные актора для `audit_log`: то, что знает только слой HTTP. */
function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

export function registerNavigationRoutes(app: AppInstance): void {
  registerVolumeRoutes(app);
  registerSubmissionRoutes(app);
  registerRevisionRoutes(app);
}

// =====================================================================
// Тома
// =====================================================================

function registerVolumeRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/volumes`,
    {
      preHandler: readSubmissions,
      schema: { querystring: volumeListQuerySchema, response: { 200: volumePageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await listVolumes(app.db, scope, request.query);
      return reply.code(200).send({ items: [...result.items], nextCursor: result.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/volumes/:volumeId`,
    {
      preHandler: readSubmissions,
      schema: { params: volumeIdParamSchema, response: { 200: volumeSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const volume = await findVolume(app.db, scope, request.params.volumeId);
      if (volume === null) throw notFound('Том не найден.');
      updateContext({ objectId: volume.objectId });
      return reply.code(200).send(volume);
    },
  );
}

// =====================================================================
// Поставки
// =====================================================================

function registerSubmissionRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/submissions`,
    {
      preHandler: readSubmissions,
      schema: { querystring: submissionListQuerySchema, response: { 200: submissionPageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await listSubmissions(app.db, scope, request.query);
      return reply.code(200).send({ items: [...result.items], nextCursor: result.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/submissions/:submissionId`,
    {
      preHandler: readSubmissions,
      schema: { params: submissionIdParamSchema, response: { 200: submissionSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const submission = await findSubmission(app.db, scope, request.params.submissionId);
      if (submission === null) throw notFound('Поставка не найдена.');
      updateContext({ objectId: submission.objectId });
      return reply.code(200).send(submission);
    },
  );

  app.post(
    `${PREFIX}/submissions`,
    {
      preHandler: uploadSubmissions,
      schema: { body: createSubmissionBodySchema, response: { 201: createdSubmissionSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createSubmission(
        app.db,
        scope,
        {
          volumeId: request.body.volumeId,
          title: request.body.title,
          ...(request.body.number === undefined ? {} : { number: request.body.number }),
        },
        auditActor(app, request),
      );
      updateContext({
        objectId: created.submission.objectId,
        revisionId: created.revision.id,
      });
      return reply.code(201).send(created);
    },
  );
}

// =====================================================================
// Ревизии поставки
// =====================================================================

function registerRevisionRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/submissions/:submissionId/revisions`,
    {
      preHandler: readSubmissions,
      schema: {
        params: submissionIdParamSchema,
        querystring: revisionListQuerySchema,
        response: { 200: revisionPageSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await listSubmissionRevisions(
        app.db,
        scope,
        request.params.submissionId,
        request.query,
      );
      return reply.code(200).send({ items: [...result.items], nextCursor: result.nextCursor });
    },
  );

  app.post(
    `${PREFIX}/submissions/:submissionId/revisions`,
    {
      preHandler: uploadSubmissions,
      schema: {
        params: submissionIdParamSchema,
        response: { 201: submissionRevisionSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const revision = await createDraftRevision(
        app.db,
        scope,
        request.params.submissionId,
        auditActor(app, request),
      );
      updateContext({ revisionId: revision.id });
      return reply.code(201).send(revision);
    },
  );
}
