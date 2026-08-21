/**
 * Обратная связь конвейера в администрировании (§11, ADR-0010):
 * `/api/v1/admin/pipeline-feedback/*`.
 *
 * ## Зачем маршруты
 *
 * Дефекты качества — невалидный ответ модели, отказ, ненайденные обводки,
 * правка человека — исключений не бросают и в журнал ошибок не попадают. До
 * этого этапа их было видно только счётчиками `blocks_invalid`/`blocks_refused`
 * в `recognition_run_pages`: без причины и без версии промта, то есть без
 * всего, что нужно, чтобы промт исправить.
 *
 * ## Доля — главное число, и она бывает неизвестной
 *
 * `summary` возвращает `defects`, `calls` и `rate` отдельными полями. `rate`
 * равен `null`, когда знаменатель неизвестен (стадии без вызова модели —
 * детекция, ручные правки), и это не то же самое, что ноль: ноль читался бы
 * как «дефектов нет».
 *
 * ## Выгрузка не выносит содержимое наружу
 *
 * `export` отдаёт NDJSON из кодов, версий и идентификаторов. Ни текста
 * документа, ни ответа модели там нет: файл покидает портал, а §11 относит их
 * к ПДн. По идентификатору блока инженер открывает кроп в самом портале.
 */
import { z } from 'zod';
import type { AppInstance } from '../../app.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import {
  exportFeedback,
  feedbackSummary,
  listFeedbackEvents,
} from '../../db/repositories/processing-feedback.js';
import {
  isoDateTimeSchema,
  jsonValueSchema,
  MAX_PAGE_LIMIT,
  processingFeedbackReasonSchema,
  processingFeedbackTypeSchema,
  uuidSchema,
} from '@id/contracts';

const PREFIX = '/api/v1/admin/pipeline-feedback';

const readFeedback = requirePermission('diagnostics.read');

const DEFAULT_LIMIT = 50;
const EXPORT_MAX = 50_000;
const DEFAULT_PERIOD_DAYS = 30;

const STAGES = [
  'uploaded',
  'layout',
  'recognition',
  'analysis',
  'checks',
  'ready',
  'failed',
  'detect',
  'match',
] as const;

const filtersShape = {
  reasonCode: processingFeedbackReasonSchema.optional(),
  feedbackType: processingFeedbackTypeSchema.optional(),
  pipelineStage: z.enum(STAGES).optional(),
  promptCode: z.string().min(1).max(120).optional(),
  promptVersion: z.coerce.number().int().positive().optional(),
  model: z.string().min(1).max(200).optional(),
  docTypeCode: z.string().min(1).max(120).optional(),
  revisionId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
};

const periodOrder = (query: { from?: string | undefined; to?: string | undefined }): boolean =>
  query.from === undefined || query.to === undefined || query.from <= query.to;

const summaryQuerySchema = z
  .object(filtersShape)
  .refine(periodOrder, { message: 'Начало периода позже его окончания', path: ['to'] });

const eventsQuerySchema = z
  .object({
    ...filtersShape,
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_LIMIT),
  })
  .refine(periodOrder, { message: 'Начало периода позже его окончания', path: ['to'] });

const exportQuerySchema = z
  .object({
    ...filtersShape,
    limit: z.coerce.number().int().min(1).max(EXPORT_MAX).default(EXPORT_MAX),
  })
  .refine(periodOrder, { message: 'Начало периода позже его окончания', path: ['to'] });

const summarySchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  rows: z.array(
    z.object({
      reasonCode: z.string(),
      pipelineStage: z.string().nullable(),
      promptCode: z.string().nullable(),
      promptVersion: z.int().nullable(),
      model: z.string().nullable(),
      docTypeCode: z.string().nullable(),
      /** Дефектов за период. */
      defects: z.int(),
      /** Вызовов модели той же комбинации; `null` — знаменатель неизвестен. */
      calls: z.int().nullable(),
      /** Доля; `null` при неизвестном знаменателе, но НЕ ноль. */
      rate: z.number().nullable(),
      medianScore: z.number().nullable(),
    }),
  ),
});

const eventSchema = z.object({
  id: z.int(),
  at: isoDateTimeSchema,
  feedbackType: z.string(),
  reasonCode: z.string(),
  severity: z.string(),
  revisionId: uuidSchema.nullable(),
  recognitionRunId: uuidSchema.nullable(),
  sourcePageId: uuidSchema.nullable(),
  workingPageIndex: z.int().nullable(),
  layoutBlockId: uuidSchema.nullable(),
  fieldCode: z.string().nullable(),
  docTypeCode: z.string().nullable(),
  pipelineStage: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptCode: z.string().nullable(),
  promptVersion: z.int().nullable(),
  detectorModelVersion: z.string().nullable(),
  appRelease: z.string().nullable(),
  score: z.number().nullable(),
  observed: jsonValueSchema,
  expected: jsonValueSchema,
  requestId: z.string().nullable(),
});

const eventPageSchema = z.object({
  items: z.array(eventSchema),
  nextCursor: z.string().nullable(),
});

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3_600_000).toISOString();
}

export function registerPipelineFeedbackRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/summary`,
    {
      preHandler: readFeedback,
      schema: { querystring: summaryQuerySchema, response: { 200: summarySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const from = request.query.from ?? isoDaysAgo(DEFAULT_PERIOD_DAYS);
      const to = request.query.to ?? new Date().toISOString();
      const rows = await feedbackSummary(app.db, scope, { ...request.query, from, to });
      return reply.code(200).send({ from, to, rows: [...rows] });
    },
  );

  app.get(
    `${PREFIX}/events`,
    {
      preHandler: readFeedback,
      schema: { querystring: eventsQuerySchema, response: { 200: eventPageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const page = await listFeedbackEvents(app.db, scope, request.query);
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );

  /**
   * Выгрузка выборки в NDJSON.
   *
   * Построчный формат, а не JSON-массив: файл читают потоково инструментом
   * подготовки данных, и массив пришлось бы держать в памяти целиком с обеих
   * сторон. `content-disposition` с именем — чтобы браузер сохранил файл, а не
   * показал его как текст.
   */
  app.get(
    `${PREFIX}/export`,
    { preHandler: readFeedback, schema: { querystring: exportQuerySchema } },
    async (request, reply) => {
      const { scope } = currentAuth(request);

      reply.header('content-type', 'application/x-ndjson; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="pipeline-feedback.ndjson"');

      let body = '';
      for await (const event of exportFeedback(app.db, scope, request.query)) {
        body += `${JSON.stringify(event)}\n`;
      }
      return reply.code(200).send(body);
    },
  );
}
