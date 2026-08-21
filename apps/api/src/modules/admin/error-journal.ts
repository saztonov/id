/**
 * Журнал ошибок в администрировании (§11, §14): `/api/v1/admin/errors/*`.
 *
 * ## Зачем маршруты появились
 *
 * `error_events` писалась с S3 и не имела ни одного читателя: ошибки
 * копились в таблице, которую никто не мог открыть иначе как запросом в БД
 * руками. `DiagnosticsPanel` признавал это прямым текстом на экране. Здесь
 * право `diagnostics.read` получает второго потребителя после консоли задач, а
 * `settings.manage` — работу с проблемой: взять, прокомментировать, закрыть,
 * переоткрыть, назначить.
 *
 * ## Три числа в ответе названы по отдельности
 *
 * `summary` возвращает `issues`, `events` и `samples` разными полями и никогда
 * не выводит одно из другого. Это не педантизм: события считаются по почасовым
 * бакетам, примеры прорежены политикой, и «сколько было ошибок за сутки»,
 * посчитанное по примерам, ошиблось бы на три порядка — правдоподобно и молча.
 *
 * ## Сортировка по частоте не отдаёт курсор
 *
 * Частота — сумма по бакетам за выбранный период; она меняется вместе с
 * фильтром и растёт во время листания. Ответ содержит `nextCursor: null`, и это
 * значит «продолжения у этой сортировки нет», а не «данные кончились».
 * Клиенту это сказано схемой, а не догадкой.
 */
import { z } from 'zod';
import type { AppInstance } from '../../app.js';
import { notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { appendAuditLog, auditEmailHmac } from '../../db/repositories/admin.js';
import {
  applyIssueAction,
  findIssue,
  issueSeries,
  journalSummary,
  listHttpAnomalies,
  listIssues,
  listSamples,
  listSlowOperations,
} from '../../db/repositories/error-journal.js';
import { isoDateTimeSchema, jsonValueSchema, MAX_PAGE_LIMIT, uuidSchema } from '@id/contracts';

const PREFIX = '/api/v1/admin/errors';

/** Чтение — то же право, что у консоли задач (`jobs-console.ts`). */
const readJournal = requirePermission('diagnostics.read');
/**
 * Изменение — `settings.manage`, а не `diagnostics.read`.
 *
 * Тот же раздел, что у повтора задачи: смотреть диагностику и распоряжаться ею
 * — разные полномочия. Закрытие проблемы убирает её с экрана дежурного, то есть
 * меняет то, что увидит следующий человек.
 */
const manageJournal = requirePermission('settings.manage');

const DEFAULT_LIMIT = 50;
/** Топ для сортировки по частоте: экран, а не выгрузка. */
const FREQUENCY_TOP = 200;
const DEFAULT_SUMMARY_HOURS = 24;

const SOURCES = ['api', 'worker', 'web', 'unknown'] as const;
const EXECUTIONS = ['http', 'job', 'process', 'client', 'unknown'] as const;
const DOMAINS = [
  'db',
  'llm',
  'recognition',
  'storage',
  'auth',
  'integration',
  'application',
  'unknown',
] as const;
const SEVERITIES = ['warn', 'error', 'fatal'] as const;
const STATUSES = ['new', 'ack', 'resolved'] as const;
const STAGES = [
  'uploaded',
  'layout',
  'recognition',
  'analysis',
  'checks',
  'ready',
  'failed',
] as const;

const periodSchema = z
  .object({
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Начало периода позже его окончания',
    path: ['to'],
  });

const listQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    // `z.coerce`, потому что значения строки запроса приходят строками.
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_LIMIT),
    status: z.enum(STATUSES).optional(),
    source: z.enum(SOURCES).optional(),
    execution: z.enum(EXECUTIONS).optional(),
    domain: z.enum(DOMAINS).optional(),
    severity: z.enum(SEVERITIES).optional(),
    pipelineStage: z.enum(STAGES).optional(),
    release: z.string().min(1).max(120).optional(),
    search: z.string().min(1).max(200).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    sort: z.enum(['last_seen', 'frequency']).default('last_seen'),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Начало периода позже его окончания',
    path: ['to'],
  });

const issueSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  status: z.enum(STATUSES),
  priority: z.string(),
  isSynthetic: z.boolean(),
  source: z.string(),
  execution: z.string(),
  domain: z.string(),
  pipelineStage: z.string().nullable(),
  severity: z.string(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  firstRelease: z.string().nullable(),
  lastRelease: z.string().nullable(),
  assigneeUserId: uuidSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolution: z.string().nullable(),
  events: z.int(),
  signatures: z.int(),
});

const issuePageSchema = z.object({
  items: z.array(issueSchema),
  /** `null` у сортировки по частоте означает «курсора нет», а не «конец». */
  nextCursor: z.string().nullable(),
});

const summarySchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  /** Различных поломок. */
  issues: z.int(),
  newIssues: z.int(),
  /** Событий — точное число из почасовых бакетов. */
  events: z.int(),
  /** Сохранённых примеров: величина политики прореживания, не частоты. */
  samples: z.int(),
  byDomain: z.array(z.object({ domain: z.string(), events: z.int() })),
  bySource: z.array(z.object({ source: z.string(), events: z.int() })),
});

const sampleSchema = z.object({
  id: z.int(),
  at: isoDateTimeSchema,
  fingerprint: z.string(),
  source: z.string(),
  execution: z.string(),
  domain: z.string(),
  pipelineStage: z.string().nullable(),
  severity: z.string(),
  release: z.string().nullable(),
  requestId: z.string().nullable(),
  clientEventId: z.string().nullable(),
  userId: uuidSchema.nullable(),
  route: z.string().nullable(),
  statusCode: z.int().nullable(),
  errorCode: z.string().nullable(),
  objectId: uuidSchema.nullable(),
  revisionId: uuidSchema.nullable(),
  jobId: uuidSchema.nullable(),
  jobType: z.string().nullable(),
  attempt: z.int().nullable(),
  repeatCount: z.int(),
  context: jsonValueSchema,
});

const samplePageSchema = z.object({
  items: z.array(sampleSchema),
  nextCursor: z.string().nullable(),
});

const signatureSchema = z.object({
  fingerprint: z.string(),
  algoVersion: z.int(),
  errorClass: z.string(),
  messageTemplate: z.string(),
  topFrame: z.string().nullable(),
  source: z.string(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});

const actionSchema = z.object({
  id: z.int(),
  at: isoDateTimeSchema,
  actorUserId: uuidSchema.nullable(),
  action: z.string(),
  payload: jsonValueSchema,
});

const issueDetailSchema = z.object({
  issue: issueSchema,
  signatures: z.array(signatureSchema),
  samples: z.array(sampleSchema),
  actions: z.array(actionSchema),
});

const seriesSchema = z.object({
  points: z.array(z.object({ bucketAt: isoDateTimeSchema, release: z.string(), events: z.int() })),
});

const samplesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_LIMIT),
    issueId: uuidSchema.optional(),
    fingerprint: z.string().min(1).max(64).optional(),
    requestId: z.string().min(1).max(128).optional(),
    clientEventId: z.string().min(1).max(64).optional(),
    userId: uuidSchema.optional(),
    route: z.string().min(1).max(256).optional(),
    domain: z.enum(DOMAINS).optional(),
    source: z.enum(SOURCES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Начало периода позже его окончания',
    path: ['to'],
  });

/**
 * Тело действия.
 *
 * `resolve` требует разбора и способа устранения: закрытие без них — это
 * «убрали с экрана», а не «починили», и через полгода такая запись не отвечает
 * ни на один вопрос. Ограничение выражено схемой, а не соглашением.
 */
const actionBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('acknowledge'), comment: z.string().max(2000).optional() }),
  z.object({ action: z.literal('comment'), comment: z.string().min(1).max(2000) }),
  z.object({
    action: z.literal('resolve'),
    rootCause: z.string().min(1).max(2000),
    resolution: z.string().min(1).max(2000),
    resolutionType: z.enum(['fixed', 'wontfix', 'duplicate', 'external', 'not_reproducible']),
    fixedInRelease: z.string().min(1).max(120).optional(),
  }),
  z.object({ action: z.literal('reopen'), comment: z.string().min(1).max(2000) }),
  z.object({ action: z.literal('assign'), assigneeUserId: uuidSchema.nullable() }),
]);

const issueParamsSchema = z.object({ issueId: uuidSchema });

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const anomalySchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  items: z.array(
    z.object({
      route: z.string(),
      statusCode: z.int(),
      problemSlug: z.string(),
      count: z.int(),
    }),
  ),
});

const slowSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  items: z.array(
    z.object({
      kind: z.string(),
      target: z.string(),
      count: z.int(),
      maxMs: z.int(),
      /** Среднее по периоду; считается из суммы, а не хранится. */
      avgMs: z.int(),
      thresholdMs: z.int(),
      sampleRequestId: z.string().nullable(),
    }),
  ),
});

const slowQuerySchema = z
  .object({
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    kind: z.enum(['http', 'sql', 'external']).optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Начало периода позже его окончания',
    path: ['to'],
  });

export function registerErrorJournalRoutes(app: AppInstance): void {
  app.get(
    PREFIX,
    {
      preHandler: readJournal,
      schema: { querystring: listQuerySchema, response: { 200: issuePageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const query = request.query;
      const page = await listIssues(app.db, scope, {
        ...query,
        // Топ вместо страницы: у сортировки по частоте курсора нет по
        // построению, и выдавать первую страницу из пятидесяти значило бы
        // обещать листание, которого не будет.
        limit: query.sort === 'frequency' ? FREQUENCY_TOP : query.limit,
      });
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/summary`,
    {
      preHandler: readJournal,
      schema: { querystring: periodSchema, response: { 200: summarySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const from = request.query.from ?? isoHoursAgo(DEFAULT_SUMMARY_HOURS);
      const to = request.query.to ?? new Date().toISOString();
      const summary = await journalSummary(app.db, scope, { from, to });
      return reply.code(200).send({
        from,
        to,
        ...summary,
        byDomain: [...summary.byDomain],
        bySource: [...summary.bySource],
      });
    },
  );

  // Статический сегмент регистрируется раньше параметра сознательно: маршрутный
  // приоритет Fastify это и так обеспечивает, но порядок в файле не должен
  // расходиться с порядком разбора — иначе следующий читатель будет гадать.
  app.get(
    `${PREFIX}/samples`,
    {
      preHandler: readJournal,
      schema: { querystring: samplesQuerySchema, response: { 200: samplePageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const page = await listSamples(app.db, scope, request.query);
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/:issueId`,
    {
      preHandler: readJournal,
      schema: {
        params: issueParamsSchema,
        querystring: periodSchema,
        response: { 200: issueDetailSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const detail = await findIssue(app.db, scope, request.params.issueId, request.query);
      if (detail === null) throw notFound('Проблема не найдена.');
      return reply.code(200).send({
        issue: detail.issue,
        signatures: [...detail.signatures],
        samples: [...detail.samples],
        actions: [...detail.actions],
      });
    },
  );

  app.get(
    `${PREFIX}/:issueId/series`,
    {
      preHandler: readJournal,
      schema: {
        params: issueParamsSchema,
        querystring: periodSchema,
        response: { 200: seriesSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const from = request.query.from ?? isoHoursAgo(24 * 14);
      const to = request.query.to ?? new Date().toISOString();
      const points = await issueSeries(app.db, scope, request.params.issueId, { from, to });
      return reply.code(200).send({ points: [...points] });
    },
  );

  app.post(
    `${PREFIX}/:issueId/actions`,
    {
      preHandler: manageJournal,
      schema: {
        params: issueParamsSchema,
        body: actionBodySchema,
        response: { 200: z.object({ status: z.enum(STATUSES) }) },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const body = request.body;
      const issueId = request.params.issueId;

      const status = await applyIssueAction(
        app.db,
        {
          issueId,
          action: body.action,
          actorUserId: scope.userId,
          ...('comment' in body ? { comment: body.comment } : {}),
          ...(body.action === 'resolve'
            ? {
                rootCause: body.rootCause,
                resolution: body.resolution,
                resolutionType: body.resolutionType,
                ...(body.fixedInRelease === undefined
                  ? {}
                  : { fixedInRelease: body.fixedInRelease }),
              }
            : {}),
          ...(body.action === 'assign' ? { assigneeUserId: body.assigneeUserId } : {}),
        },
        // Тем же исполнителем, что и сама правка: см. `applyIssueAction`.
        (tx) =>
          appendAuditLog(tx, scope, {
            action: `diagnostics.issue.${body.action}`,
            entityType: 'error_issue',
            entityId: issueId,
            actorUserId: scope.userId,
            actorEmailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, user.email),
            // В след аудита идёт только вид действия и его исход. Текст разбора
            // живёт в `error_issue_actions`; дублировать его здесь значило бы
            // хранить одно утверждение в двух местах и однажды разойтись.
            payload: { action: body.action },
            ip: request.ip,
            requestId: request.id,
          }),
      );

      if (status === null) throw notFound('Проблема не найдена.');
      return reply.code(200).send({ status });
    },
  );

  /**
   * Значимые отказы 4xx за период.
   *
   * Счётчики, а не записи: 401/403/429 — это работающая защита, и строка на
   * каждый такой ответ дала бы перебору паролей писать в базу с частотой своих
   * попыток.
   */
  app.get(
    '/api/v1/admin/http-anomalies',
    {
      preHandler: readJournal,
      schema: { querystring: periodSchema, response: { 200: anomalySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const from = request.query.from ?? isoHoursAgo(DEFAULT_SUMMARY_HOURS);
      const to = request.query.to ?? new Date().toISOString();
      const items = await listHttpAnomalies(app.db, scope, { from, to });
      return reply.code(200).send({ from, to, items: [...items] });
    },
  );

  app.get(
    '/api/v1/admin/slow-operations',
    {
      preHandler: readJournal,
      schema: { querystring: slowQuerySchema, response: { 200: slowSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const from = request.query.from ?? isoHoursAgo(DEFAULT_SUMMARY_HOURS);
      const to = request.query.to ?? new Date().toISOString();
      const items = await listSlowOperations(app.db, scope, {
        from,
        to,
        ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
      });
      return reply.code(200).send({ from, to, items: [...items] });
    },
  );
}
