/**
 * Журнал аудита (§3.1): запись следа изменяющих операций и чтение журнала.
 *
 * ## Зачем отдельный модуль, когда `admin.ts` уже умеет писать `audit_log`
 *
 * `appendAuditLog()` в `admin.ts` писался под администрирование и потому не
 * заполняет `audit_log.object_id`: пользователи, настройки, промты и наборы
 * правил — записи глобальные, объекта у них нет. У справочников объект есть, и
 * именно он делает журнал пригодным для вопросов, которые задают по существу:
 * «кто деактивировал ЭТОТ объект», «кто менял разделы ЭТОГО объекта». Кроме
 * того, `appendAuditLog()` требует неограниченной области (`requireGlobalScope`),
 * а согласование ревизии на S7 будет писать след под областью инженера. Писатель
 * здесь поэтому области не сужает и не требует — см. ниже.
 *
 * ## Актор берётся из области видимости, а не из аргументов
 *
 * `actor_user_id` заполняется из `scope.userId`, и подставить туда чужой
 * идентификатор вызывающий не может — в записи есть только то, что портал
 * установил сам. Область при этом НЕ превращается в условие записи: журнал
 * фиксирует действие, а право его выполнить проверено `requirePermission` на
 * маршруте. Проверять область ещё и здесь значило бы, что при ошибке в правах
 * действие выполнится, а следа не оставит — то есть ровно тот исход, который
 * журнал обязан исключать.
 *
 * ## Чтение: область видимости по объекту, но не через `withScope()`
 *
 * `ScopeTarget` требует ПАРЫ колонок — `object_id` и `contractor_id`, — а
 * `contractor_id` в журнале нет и быть не может: запись обязана существовать при
 * любом состоянии справочников (у таблицы нет ни одного FK на них). Подставить в
 * `contractorId` «что-нибудь похожее» значило бы написать превращение области в
 * SQL второй раз, вне `db/scoped.ts`, то есть завести второй источник правды для
 * правила доступа. Поэтому условие собирается здесь явно, но РЕШЕНИЕ принимает
 * тот же `isUnrestricted()`, что и `scopeWhere()`:
 *
 *   • неограниченная область (все, кроме подрядчика) — весь журнал;
 *   • подрядчик — ничего: сопоставить запись журнала с его организацией нечем,
 *     а «показать всё, раз фильтровать не по чему» — это утечка.
 *
 * Ветки «инженер по назначенным объектам» здесь больше нет: объектных областей
 * не осталось (S37), и записывать её значило бы держать фильтр по величине,
 * которой в области больше нет.
 *
 * Право `audit.read` выдано только `admin` (§4.1), поэтому на практике сюда
 * приходит неограниченная область; остальные ветви — не мёртвый код, а гарантия
 * того, что расширение матрицы прав не откроет журнал целиком.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { isIP } from 'node:net';
import { z } from 'zod';
import { auditLog } from '@id/db';
import type { JsonValue } from '@id/contracts';
import { isUnrestricted, type AuthScope } from '../../auth/scope.js';
import { badRequest } from '../../lib/problem.js';
import type { Database } from './users.js';

/** Исполнитель записи: сама база либо транзакция изменяющей операции. */
export type AuditExecutor = Pick<Database, 'insert'>;

/**
 * Часть записи журнала, которую знает только слой HTTP.
 *
 * Идентификатора актора здесь нет намеренно: он берётся из области видимости
 * (см. заголовок файла). `emailHmac` — отпечаток адреса, а не адрес: запись
 * обязана переживать удаление пользователя, но хранить его ПДн не обязана (§3.1).
 */
export interface AuditActor {
  readonly emailHmac: string | null;
  readonly ip: string | null;
  readonly requestId: string | null;
}

export interface AuditRecord extends AuditActor {
  /** Глагол в прошедшем времени с префиксом сущности: `doc_type.override_set`. */
  readonly action: string;
  readonly entityType: string;
  /** Ключ сущности: uuid, код вида ИД или ключ настройки. */
  readonly entityId: string | null;
  /** Объект, к которому относится изменение; `null` у глобальных справочников. */
  readonly objectId: string | null;
  /** Только изменённые поля. Секретов в справочниках нет по построению. */
  readonly payload: Record<string, unknown>;
}

/**
 * Запись следа в `audit_log`.
 *
 * Вызывается ИЗНУТРИ транзакции изменяющей операции: аудит, который может не
 * записаться, бесполезен, а изменение без следа — это и есть закрываемый дефект.
 *
 * Адрес нормализуется здесь, а не у вызывающего: колонка имеет тип `inet`, и
 * непригодное значение даёт 22P02, то есть 500 на штатном действии
 * администратора. Так уже случалось на `/auth/callback` с нечисловым
 * `X-Forwarded-For` (S3), и повторять этот путь незачем.
 */
export async function appendAudit(
  executor: AuditExecutor,
  scope: AuthScope,
  record: AuditRecord,
): Promise<void> {
  await executor.insert(auditLog).values({
    actorUserId: scope.userId,
    actorEmailHmac: record.emailHmac,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    objectId: record.objectId,
    payload: sql`${JSON.stringify(record.payload)}::jsonb`,
    ip: normalizeInet(record.ip),
    requestId: record.requestId,
  });
}

function normalizeInet(value: string | null): string | null {
  if (value === null || value === '') return null;
  return isIP(value) === 0 ? null : value;
}

// =====================================================================
// Чтение журнала
// =====================================================================

/**
 * Запись журнала, как её отдаёт API.
 *
 * `ip` в выдачу не входит. Он остаётся в таблице для разбора инцидента
 * владельцем БД, но в ответе API это ПДн, которые попадут в историю браузера и в
 * кэш промежуточных узлов, не отвечая ни на один вопрос экрана «кто и что
 * менял». Отпечаток адреса (`actorEmailHmac`), напротив, выдаётся: он и заведён
 * для того, чтобы действия удалённого пользователя оставались сопоставимыми.
 */
export interface AuditEntryView {
  readonly id: number;
  readonly at: string;
  readonly actorUserId: string | null;
  readonly actorEmailHmac: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly objectId: string | null;
  readonly payload: JsonValue;
  readonly requestId: string | null;
}

export interface AuditPage {
  readonly items: readonly AuditEntryView[];
  readonly nextCursor: string | null;
}

export interface AuditListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly objectId?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  /** Период по времени записи, границы включительно. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

const AUDIT_SELECTION = {
  id: auditLog.id,
  at: sql<string>`to_char(${auditLog.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    'at_iso',
  ),
  /**
   * То же значение в машинном виде — только для курсора.
   *
   * ISO-строка с миллисекундами для keyset не годится: `to_char` округляет
   * микросекунды, и запись, попавшая в ту же миллисекунду, была бы либо
   * пропущена, либо выдана дважды.
   */
  cursorAt: sql<string>`${auditLog.at}::text`.as('cursor_at'),
  actorUserId: auditLog.actorUserId,
  actorEmailHmac: auditLog.actorEmailHmac,
  action: auditLog.action,
  entityType: auditLog.entityType,
  entityId: auditLog.entityId,
  objectId: auditLog.objectId,
  payload: auditLog.payload,
  requestId: auditLog.requestId,
};

const cursorSchema = z.object({ at: z.string().min(1), id: z.int() });

/**
 * Страница журнала, новые записи первыми.
 *
 * Порядок обратный по времени, потому что журнал читают с последнего события.
 * Курсор — по паре `(at, id)` в том же направлении: две записи одного
 * миллисекундного тика различает `id`, а OFFSET на растущей таблице пропускал бы
 * строки при каждом новом событии.
 */
export async function listAuditEntries(
  db: Database,
  scope: AuthScope,
  params: AuditListParams,
): Promise<AuditPage> {
  const after = decodeCursor(params.cursor);

  const rows = await db
    .select(AUDIT_SELECTION)
    .from(auditLog)
    .where(
      auditWhere(
        scope,
        after === null
          ? undefined
          : sql`(${auditLog.at}, ${auditLog.id}) < (${after.at}::timestamptz, ${after.id}::bigint)`,
        params.objectId === undefined ? undefined : eq(auditLog.objectId, params.objectId),
        params.actorUserId === undefined ? undefined : eq(auditLog.actorUserId, params.actorUserId),
        params.action === undefined ? undefined : eq(auditLog.action, params.action),
        params.entityType === undefined ? undefined : eq(auditLog.entityType, params.entityType),
        params.entityId === undefined ? undefined : eq(auditLog.entityId, params.entityId),
        params.from === undefined ? undefined : sql`${auditLog.at} >= ${params.from}::timestamptz`,
        params.to === undefined ? undefined : sql`${auditLog.at} <= ${params.to}::timestamptz`,
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    // На одну больше запрошенного: наличие следующей страницы известно без
    // отдельного COUNT по тому же условию.
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ at: last.cursorAt, id: last.id })
      : null;

  return {
    items: page.map(({ cursorAt: _cursorAt, ...row }) => ({
      ...row,
      payload: (row.payload ?? {}) as JsonValue,
    })),
    nextCursor,
  };
}

/** Условие видимости журнала. Разбор — в заголовке файла. */
function auditVisibility(scope: AuthScope): SQL {
  if (isUnrestricted(scope)) return sql`true`;
  // Подрядчик и всякая область, добавленная без правки этой функции: закрыто.
  return sql`false`;
}

function auditWhere(scope: AuthScope, ...conditions: (SQL | undefined)[]): SQL {
  const combined = and(auditVisibility(scope), ...conditions);
  // and() отдаёт undefined только на пустом списке, а первый аргумент задан
  // всегда; проверка нужна для сужения типа.
  return combined ?? sql`false`;
}

function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Повреждённый курсор — ошибка запроса, а не «начнём заново».
 *
 * Молчаливый откат к первой странице выглядит для клиента как бесконечный
 * журнал: он листает, получает те же записи и снова тот же курсор.
 */
function decodeCursor(raw: string | null | undefined): z.infer<typeof cursorSchema> | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = cursorSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Ниже общий отказ: разница между «не base64» и «не та форма» клиенту
    // ничего не даёт.
  }
  throw badRequest('Курсор страницы недействителен.');
}
