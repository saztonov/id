/**
 * Консоль задач в администрировании (§14, §11): `/api/v1/admin/jobs/*`.
 *
 * Экран отвечает на четыре вопроса, каждый из которых иначе задаётся только
 * запросом в БД руками:
 *
 * 1. **Что стоит в очереди и что выполняется прямо сейчас** — список задач с
 *    фильтром по статусу, типу, очереди и ревизии.
 * 2. **Что упало насовсем** — задачи, исчерпавшие `max_attempts`. Их никто не
 *    подберёт без решения человека, поэтому у них есть кнопка повтора: это
 *    прямое требование §12.
 * 3. **Сколько реально идёт обработка комплекта** — попытки из `job_runs` с
 *    длительностями (§11). Одно поле статуса на этот вопрос не отвечает, и
 *    поэтому `processing_status` не хранится (§3.8).
 * 4. **Есть ли затор** — глубина очереди по типам и статусам, та же, что уходит
 *    в `/metrics`.
 *
 * ## Права
 *
 * Чтение — `diagnostics.read`: до сих пор это право не имело ни одного
 * потребителя (долг S4), и экран задач — первый. Изменяющие действия (повтор,
 * отмена, ручной прогон reaper) — `settings.manage`: перезапуск задачи меняет
 * состояние поставки, а не только показания диагностики.
 *
 * ## Область видимости
 *
 * Право выдано только администратору, у которого область неограниченная,
 * поэтому фильтрация по области здесь в норме ничего не отсекает. Она всё равно
 * применяется в репозитории: правило «если сомневаешься, изоляция нужна» стоит
 * дешевле, чем расширение матрицы прав, которое однажды выдаст `diagnostics.read`
 * инженеру и молча покажет ему чужие поставки.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppInstance } from '../../app.js';
import { notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import {
  cancelJob,
  enqueueJob,
  findJob,
  JOB_STATUSES,
  listJobRuns,
  listJobs,
  queueSnapshot,
  retryJob,
} from '../../db/repositories/jobs.js';
import { dedupeKeyFor, JOB_QUEUES, JOB_TYPES } from '../../jobs/types.js';

const PREFIX = '/api/v1/admin/jobs';

const readJobs = requirePermission('diagnostics.read');
const manageJobs = requirePermission('settings.manage');

/** Сколько попыток показывается в карточке задачи: экран, а не выгрузка. */
const RUNS_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

const jobIdParamsSchema = z.object({ jobId: z.uuid() });

const listQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES as [string, ...string[]]).optional(),
  queue: z.enum(JOB_QUEUES).optional(),
  folderId: z.uuid().optional(),
  deadOnly: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

const jobSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  queue: z.enum(JOB_QUEUES).nullable(),
  status: z.enum(JOB_STATUSES),
  attempts: z.int(),
  maxAttempts: z.int(),
  /** Молчаливые смерти воркера: другой диагноз, чем исчерпанные попытки (S41). */
  leaseExpiries: z.int(),
  priority: z.int(),
  nextRunAt: z.string(),
  lockedBy: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  lastError: z.string().nullable(),
  dedupeKey: z.string().nullable(),
  folderId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isDead: z.boolean(),
});

const jobRunSchema = z.object({
  id: z.uuid(),
  jobId: z.uuid().nullable(),
  jobType: z.string(),
  folderId: z.uuid().nullable(),
  requestId: z.string().nullable(),
  attempt: z.int(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.int().nullable(),
  outcome: z.string().nullable(),
  errorClass: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

const jobPageSchema = z.object({
  items: z.array(jobSchema),
  nextCursor: z.string().nullable(),
});

const jobDetailSchema = z.object({
  job: jobSchema,
  runs: z.array(jobRunSchema),
});

const queueSnapshotSchema = z.object({
  depths: z.array(z.object({ jobType: z.string(), status: z.string(), count: z.int() })),
  dead: z.array(z.object({ jobType: z.string(), count: z.int() })),
});

const enqueuedSchema = z.object({ jobId: z.uuid(), created: z.boolean() });

export function registerJobsConsoleRoutes(app: AppInstance): void {
  app.get(
    PREFIX,
    {
      preHandler: readJobs,
      schema: { querystring: listQuerySchema, response: { 200: jobPageSchema } },
    },
    async (request) => {
      const auth = currentAuth(request);
      const query = request.query;
      const page = await listJobs(app.db, auth.scope, {
        status: query.status,
        type: query.type,
        queue: query.queue,
        folderId: query.folderId,
        deadOnly: query.deadOnly,
        cursor: query.cursor,
        limit: query.limit,
      });
      // Копия массива: репозиторий отдаёт `readonly`, схема ответа ждёт
      // изменяемый — тот же приём, что в остальных списочных маршрутах.
      return { items: [...page.items], nextCursor: page.nextCursor };
    },
  );

  /**
   * Глубина очереди.
   *
   * Тот же снимок, что уходит в `/metrics`: экран диагностики и Prometheus
   * обязаны показывать одно и то же число, иначе спор «график врёт или экран»
   * не разрешить.
   */
  app.get(
    `${PREFIX}/queues`,
    { preHandler: readJobs, schema: { response: { 200: queueSnapshotSchema } } },
    async () => {
      const snapshot = await queueSnapshot(app.db);
      return { depths: [...snapshot.depths], dead: [...snapshot.dead] };
    },
  );

  app.get(
    `${PREFIX}/:jobId`,
    {
      preHandler: readJobs,
      schema: { params: jobIdParamsSchema, response: { 200: jobDetailSchema } },
    },
    async (request) => {
      const auth = currentAuth(request);
      const job = await findJob(app.db, auth.scope, request.params.jobId);
      if (job === null) throw notFound('Задача не найдена.');

      const runs = await listJobRuns(app.db, auth.scope, {
        jobId: request.params.jobId,
        limit: RUNS_LIMIT,
      });
      return { job, runs: [...runs] };
    },
  );

  /**
   * Ручной повтор задачи, исчерпавшей попытки (§12).
   *
   * Потолок попыток повышается на одну, а счётчик не обнуляется: история в
   * `job_runs` обязана остаться сплошной. След в `audit_log` пишет репозиторий
   * той же транзакцией.
   */
  app.post(
    `${PREFIX}/:jobId/retry`,
    {
      preHandler: manageJobs,
      schema: { params: jobIdParamsSchema, response: { 200: jobSchema } },
    },
    async (request) => {
      const auth = currentAuth(request);
      const job = await retryJob(
        app.db,
        auth.scope,
        request.params.jobId,
        auditActor(app, request),
      );
      if (job === null) throw notFound('Задача не найдена.');
      return job;
    },
  );

  app.post(
    `${PREFIX}/:jobId/cancel`,
    {
      preHandler: manageJobs,
      schema: { params: jobIdParamsSchema, response: { 200: jobSchema } },
    },
    async (request) => {
      const auth = currentAuth(request);
      const job = await cancelJob(
        app.db,
        auth.scope,
        request.params.jobId,
        auditActor(app, request),
      );
      if (job === null) throw notFound('Задача не найдена.');
      return job;
    },
  );

  /**
   * Ручной прогон reaper (§12, задача 24).
   *
   * Штатно аренды освобождает таймер воркера. Кнопка нужна для случая, когда
   * воркер только что перезапустили и ждать интервал незачем, — и заодно она
   * делает освобождение аренд видимым в `job_runs` наравне с прочими задачами.
   * Ключ идемпотентности не даёт накопить очередь из десяти reaper'ов, если по
   * кнопке нажали десять раз.
   */
  app.post(
    `${PREFIX}/maintenance/reaper`,
    { preHandler: manageJobs, schema: { response: { 200: enqueuedSchema } } },
    async (request) => {
      const auth = currentAuth(request);
      return enqueueJob(app.db, auth.scope, {
        type: 'jobs.reaper',
        payload: {},
        dedupeKey: dedupeKeyFor('jobs.reaper', 'manual'),
      });
    },
  );
}

/** Данные актора для `audit_log`: то, что знает только слой HTTP (§3.1). */
function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}
