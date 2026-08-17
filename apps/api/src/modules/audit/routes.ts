/**
 * Чтение журнала аудита (§3.1, §4.1): `GET /api/v1/audit/entries`.
 *
 * ## Зачем маршрут появился
 *
 * Право `audit.read` существовало в матрице `PERMISSIONS` с S3, но ни один
 * маршрут его не проверял: журнал писался и был недоступен. Право без
 * потребителя — это не безобидная заготовка, а обещание, которого нет:
 * «администратор может прочитать журнал» звучит как выполненное требование, пока
 * кто-нибудь не попробует. Вместе с записью следа правок справочников
 * (`db/repositories/catalog.ts`) этот маршрут закрывает вопросы вида «кто отключил
 * резервный вид ИД», «кто переименовал контрагента», «кто деактивировал объект»:
 * именно эти значения формируют вердикты AOSR.HDR, AOSR.P2/P6 и REF (§9.3).
 *
 * ## Право `diagnostics.read` намеренно остаётся без потребителя
 *
 * Оно закреплено за экраном «Диагностика» (`error_events`, `job_runs`), который
 * по §17 относится к этапу S11. Здесь его НЕ применяют и маршрута под него не
 * заводят: экран без данных и без фильтров по причинам сбоя выглядел бы как
 * готовая диагностика и мешал бы заметить, что её ещё нет. Право оставлено в
 * матрице сознательно — состав прав §4.1 фиксирован планом, и удалять его, чтобы
 * вернуть на S11, значило бы дважды править одну матрицу.
 *
 * ## Почему один маршрут, а не «журнал по каждой сущности»
 *
 * Журнал плоский по построению: `entity_type` + `entity_id` (индекс
 * `ix_audit_log_entity`) отвечают «история этой записи», `object_id` — «что
 * менялось на этом объекте», `actor_user_id` — «что делал этот пользователь».
 * Отдельные маршруты под каждый разрез повторяли бы один запрос с разными
 * параметрами, и добавление сущности требовало бы нового маршрута вместо нового
 * значения фильтра.
 */
import { z } from 'zod';
import type { AppInstance } from '../../app.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { listAuditEntries } from '../../db/repositories/audit.js';
import {
  cursorPageSchema,
  DEFAULT_PAGE_LIMIT,
  isoDateTimeSchema,
  jsonValueSchema,
  MAX_PAGE_LIMIT,
  uuidSchema,
} from '@id/contracts';

const PREFIX = '/api/v1/audit';

/** Чтение журнала — администратору (§4.1). */
const readAudit = requirePermission('audit.read');

/**
 * Имя действия и тип сущности — свободные строки, а не перечисления.
 *
 * Список действий растёт вместе с этапами (S7 добавит согласование ревизий, S9 —
 * прогоны правил), и закрытое перечисление на входе фильтра означало бы, что
 * найти новое действие в журнале нельзя до правки схемы. Длина ограничена: фильтр
 * идёт в индексируемое сравнение, а не в поиск подстроки.
 */
const nameFilterSchema = z.string().min(1).max(128);

const listQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    // `z.coerce`, потому что значения строки запроса приходят строками.
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    objectId: uuidSchema.optional(),
    actorUserId: uuidSchema.optional(),
    action: nameFilterSchema.optional(),
    entityType: nameFilterSchema.optional(),
    entityId: z.string().min(1).max(256).optional(),
    /** Период по времени записи, границы включительно. */
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Начало периода позже его окончания',
    path: ['to'],
  });

/**
 * Запись журнала.
 *
 * `ip` в ответе нет — разбор в заголовке репозитория: адрес остаётся в таблице
 * для разбора инцидента, но в ответе API это ПДн, не отвечающие ни на один вопрос
 * экрана. `payload` отдаётся как есть: в него пишутся изменённые поля справочников
 * и настроек, а секреты в настройках не хранятся вовсе (§10) — попытка записать
 * секрет отвергается раньше, чем дошла бы до журнала значением.
 */
const auditEntrySchema = z.object({
  id: z.int().positive(),
  at: isoDateTimeSchema,
  actorUserId: uuidSchema.nullable(),
  actorEmailHmac: z.string().nullable(),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().nullable(),
  objectId: uuidSchema.nullable(),
  payload: jsonValueSchema,
  requestId: z.string().nullable(),
});

const auditPageSchema = cursorPageSchema(auditEntrySchema);

export function registerAuditRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/entries`,
    {
      preHandler: readAudit,
      schema: { querystring: listQuerySchema, response: { 200: auditPageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      // Фильтры уходят в репозиторий как есть, включая курсор: keyset по
      // `(at, id)` совместим с любым набором условий, пока клиент передаёт их
      // неизменными между страницами. Курсор хранит позицию, а не выборку.
      const page = await listAuditEntries(app.db, scope, request.query);
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );
}
