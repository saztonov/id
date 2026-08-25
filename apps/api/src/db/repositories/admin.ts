/**
 * Репозиторий администрирования: пользователи, настройки, промты, набор правил.
 *
 * Следует паттерну `users.ts`: область видимости — первый содержательный
 * аргумент каждого метода, условие берётся из `withScope()`, запись
 * ограничивается тем же условием подзапросом.
 *
 * Особенность этого файла — две разные природы таблиц:
 *
 *   • `users`, `user_roles`, `user_object_scopes` имеют путь к области видимости
 *     (через назначения пользователя и его организацию), поэтому к ним
 *     применяется `withScope()` ровно как в `users.ts`;
 *   • `app_settings`, `prompt_templates`, `ruleset_versions`, `ruleset_rules`,
 *     `rule_definitions` — ГЛОБАЛЬНЫЕ записи: ни `object_id`, ни `contractor_id`
 *     у них нет и быть не может. Фильтровать нечего, поэтому область проверяется
 *     целиком (`requireGlobalScope`), а не превращается в WHERE. Молча пропустить
 *     аргумент нельзя: тогда «забыли область» и «области здесь нет по существу»
 *     выглядели бы в коде одинаково.
 *
 * Метки времени отдаются наружу в ISO-8601 через `to_char`, а не «как есть»:
 * драйвер `pg` в режиме строки возвращает формат PostgreSQL
 * («2026-08-17 12:00:00+00»), который не проходит `isoDateTimeSchema` и заставил
 * бы полагаться на снисходительность парсера `Date` в V8.
 */
import { and, asc, desc, eq, inArray, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  appSettings,
  auditLog,
  constructionObjects,
  counterparties,
  promptTemplates,
  ruleDefinitions,
  rulesetRules,
  rulesetVersions,
  userObjectScopes,
  userRoles,
  users,
} from '@id/db';
import {
  severitySchema,
  userRoleSchema,
  type JsonValue,
  type PromptState,
  type Severity,
  type UserRole,
} from '@id/contracts';
import { isUnrestricted, type AuthScope } from '../../auth/scope.js';
import { badRequest, forbidden } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import type { Database } from './users.js';

/**
 * Исполнитель запросов: сама база либо транзакция.
 *
 * Нужен потому, что публикация набора правил обязана быть атомарной, а тип
 * транзакции Drizzle — не `NodePgDatabase`. Перечислены только те методы,
 * которыми пользуется файл: так подмена исполнителя не может незаметно
 * протащить сюда что-то ещё.
 */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

/** Организации, которые вправе подавать ИД (§3.2). */
const SUBMITTING_KINDS: readonly string[] = ['contractor', 'general_contractor'];

// =====================================================================
// Общее
// =====================================================================

/**
 * timestamptz → ISO-8601 в UTC.
 *
 * `to_char` вместо доверия форматтеру драйвера: формат ответа фиксируется здесь
 * и не зависит ни от `DateStyle` сессии, ни от версии `pg`.
 *
 * Псевдоним обязателен и потому в аргументах, а не по желанию: Drizzle не
 * подставляет имя вычисляемому полю сам, и три `to_char` в одном списке выборки
 * дают три столбца с одинаковым именем `to_char`. На позиционном чтении строк
 * (`rowMode: 'array'`, как ходит сам Drizzle) это незаметно, но любой читатель
 * результата по имени — журнал, psql, обёртка в тестах — видит один столбец
 * вместо трёх.
 */
function isoUtc<T extends string | null>(column: PgColumn, alias: string) {
  return sql<T>`to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(alias);
}

/**
 * jsonb-литерал для колонки NOT NULL (`app_settings.value`, `ruleset_rules.params`).
 *
 * JS-`null` превращается в jsonb-значение `null`, а не в SQL NULL: колонка
 * объявлена NOT NULL, и «настройка выключена» обязана быть значением, а не
 * отсутствием строки.
 */
function jsonbValue(value: unknown): SQL<unknown> {
  return sql`${JSON.stringify(value ?? null)}::jsonb`;
}

/**
 * jsonb-литерал для НУЛЛЯБЕЛЬНОЙ колонки (`prompt_templates.output_schema`).
 *
 * Здесь `null` означает «структурированный ответ не требуется», и это SQL NULL,
 * а не jsonb `null`. Разница видна не в API (оба приезжают к клиенту как `null`),
 * а в SQL: при jsonb `null` условие `output_schema IS NOT NULL` истинно, то есть
 * промт без схемы выглядел бы как промт со схемой.
 */
function jsonbOrNull(value: unknown): SQL<unknown> {
  return value === null || value === undefined ? sql`null` : sql`${JSON.stringify(value)}::jsonb`;
}

function requireGlobalScope(scope: AuthScope, subject: string): void {
  if (!isUnrestricted(scope)) {
    throw forbidden('Недостаточно прав для этого действия.', {
      logDetail: `область видимости «${scope.kind}» не даёт доступа к ${subject}`,
    });
  }
}

/**
 * SQLSTATE ошибки PostgreSQL, если это она.
 *
 * Ищется по цепочке `cause`, а НЕ у самого объекта: Drizzle 0.45 оборачивает
 * ошибку драйвера в свою («Failed query: …») и кладёт исходную в `cause`.
 * Проверка только верхнего объекта не находит код никогда, то есть все
 * осмысленные 409 — конфликт версии, отказ триггера неизменяемости — молча
 * превращались бы в 500. Проверено прогоном: до этой правки повторная
 * публикация версии набора отвечала 500.
 *
 * Значение принимается только в форме SQLSTATE (пять цифр и заглавных букв):
 * у обёрток по пути встречаются свои `code` вида `ERR_INVALID_ARG_TYPE`, и
 * останавливаться на них нельзя.
 */
export function pgErrorCode(error: unknown): string | null {
  return errorField(error, ['code'], /^[0-9A-Z]{5}$/);
}

/** Имя нарушенного ограничения: различает конфликт версии и конфликт кода. */
export function pgConstraint(error: unknown): string | null {
  return errorField(error, ['constraint', 'constraint_name'], /^[A-Za-z0-9_]+$/);
}

/** Максимальная глубина цепочки `cause`: защита от циклической ссылки. */
const MAX_CAUSE_DEPTH = 8;

function errorField(error: unknown, fields: readonly string[], shape: RegExp): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const record = current as Record<string, unknown>;
    for (const field of fields) {
      const value: unknown = record[field];
      if (typeof value === 'string' && shape.test(value)) return value;
    }
    current = record['cause'];
  }
  return null;
}

/** Отказ триггера неизменяемости (§3.9): `restrict_violation`. */
export const PG_RESTRICT_VIOLATION = '23001';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

// =====================================================================
// Курсор
// =====================================================================

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Повреждённый курсор — ошибка запроса (та же семантика, что в `users.ts`):
 * молчаливый откат к первой странице выглядит для клиента как бесконечный список.
 */
function decodeCursor<T>(schema: z.ZodType<T>, raw: string | null | undefined): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Ниже общий отказ: клиенту разница между «не base64» и «не та форма»
    // ничего не даёт.
  }
  throw badRequest('Курсор страницы недействителен.');
}

export interface PageParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
}

// =====================================================================
// Журнал аудита
// =====================================================================

export interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorUserId: string;
  /** HMAC от e-mail актора (§3.1). `null`, когда ключ аудита не настроен. */
  readonly actorEmailHmac: string | null;
  readonly payload: Record<string, unknown>;
  readonly ip: string | null;
  readonly requestId: string | null;
}

/**
 * Запись в `audit_log`.
 *
 * Адрес нормализуется здесь, а не у вызывающего: колонка имеет тип `inet`, и
 * непригодное значение даёт 22P02 — то есть 500 на действии администратора. Так
 * уже случалось на `/auth/callback` с нечисловым `X-Forwarded-For`
 * (EXECUTION_LOG, S3), и повторять этот путь во втором месте незачем.
 */
export async function appendAuditLog(
  executor: Executor,
  scope: AuthScope,
  entry: AuditEntry,
): Promise<void> {
  requireGlobalScope(scope, 'журнала аудита');

  await executor.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    actorEmailHmac: entry.actorEmailHmac,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    payload: sql`${JSON.stringify(entry.payload)}::jsonb`,
    ip: normalizeInet(entry.ip),
    requestId: entry.requestId,
  });
}

function normalizeInet(value: string | null): string | null {
  if (value === null || value === '') return null;
  return isIP(value) === 0 ? null : value;
}

/**
 * Значение колонки `audit_log.actor_email_hmac` (§3.1).
 *
 * Живёт рядом с писателем строки, а не в маршрутах: это не «утилита про
 * криптографию», а способ получить значение конкретной колонки. В журнал идёт
 * отпечаток, а не адрес — запись обязана переживать удаление пользователя, но
 * хранить его ПДн не обязана. Без ключа возвращается `null`: подставлять сам
 * адрес нельзя.
 */
export function auditEmailHmac(key: string | undefined, email: string | null): string | null {
  if (key === undefined || email === null) return null;
  return createHmac('sha256', key).update(email.toLowerCase()).digest('hex');
}

// =====================================================================
// Пользователи
// =====================================================================

const scopedUsers = alias(users, 'scoped_users');
const scopedObjectScopes = alias(userObjectScopes, 'scoped_user_object_scopes');

/**
 * Подзапрос «пользователи, видимые этой областью».
 *
 * Псевдонимы обязательны: подзапрос подставляется внутрь запроса к тем же
 * таблицам, и без переименования условие области сцепилось бы с внешними
 * строками. LEFT JOIN — чтобы пользователь без назначений остался видимым для
 * неограниченной области (то же обоснование, что в `users.ts`).
 */
function visibleUserIds(executor: Executor, scope: AuthScope, userId: string) {
  return executor
    .select({ id: scopedUsers.id })
    .from(scopedUsers)
    .leftJoin(scopedObjectScopes, eq(scopedObjectScopes.userId, scopedUsers.id))
    .where(
      withScope(
        scope,
        { objectId: scopedObjectScopes.objectId, contractorId: scopedUsers.contractorId },
        eq(scopedUsers.id, userId),
      ),
    );
}

const OBJECT_SCOPE_TARGET: ScopeTarget = {
  objectId: userObjectScopes.objectId,
  contractorId: users.contractorId,
};

/**
 * Объекты, назначенные пользователю.
 *
 * Строки фильтруются областью ЗАПРАШИВАЮЩЕГО, а не только видимостью самого
 * пользователя: инженер не должен узнавать состав назначений на объектах, к
 * которым сам не допущен.
 */
export async function listUserObjectScopes(
  db: Database,
  scope: AuthScope,
  userId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ objectId: userObjectScopes.objectId })
    .from(userObjectScopes)
    .innerJoin(users, eq(users.id, userObjectScopes.userId))
    .where(withScope(scope, OBJECT_SCOPE_TARGET, eq(userObjectScopes.userId, userId)))
    .orderBy(asc(userObjectScopes.objectId));

  return rows.map((row) => row.objectId);
}

export type RolesUpdate =
  | { readonly status: 'ok'; readonly roles: readonly UserRole[] }
  | { readonly status: 'not_found' }
  /** Роль `contractor` без организации: такой пользователь не сможет войти. */
  | { readonly status: 'contractor_without_organization' };

/**
 * Замена набора бизнес-ролей.
 *
 * Полная замена, а не «добавить/убрать»: набор ролей — это одно решение
 * администратора, и последовательность из двух запросов оставляла бы окно, в
 * котором у пользователя нет ни одной роли (то есть он не может ничего) или их
 * две несовместимые.
 *
 * Проверки инвариантов выполняются в той же транзакции, что запись, после
 * блокировки строки пользователя: иначе одновременное снятие привязки к
 * организации сделало бы результат недопустимым уже после проверки.
 */
export async function replaceUserRoles(
  db: Database,
  scope: AuthScope,
  userId: string,
  roles: readonly UserRole[],
): Promise<RolesUpdate> {
  return db.transaction(async (tx) => {
    const target = await tx
      .select({ id: users.id, contractorId: users.contractorId })
      .from(users)
      .where(inArray(users.id, visibleUserIds(tx, scope, userId)))
      .for('update');

    const row = target[0];
    if (row === undefined) return { status: 'not_found' };

    if (roles.includes('contractor') && row.contractorId === null) {
      return { status: 'contractor_without_organization' };
    }

    // Пустой массив в notInArray даёт в разных версиях построителя разный SQL,
    // поэтому «снять все роли» — отдельная ветка, а не вырожденный случай.
    await tx
      .delete(userRoles)
      .where(
        roles.length === 0
          ? eq(userRoles.userId, userId)
          : and(eq(userRoles.userId, userId), notInArray(userRoles.role, [...roles])),
      );

    if (roles.length > 0) {
      await tx
        .insert(userRoles)
        .values(roles.map((role) => ({ userId, role })))
        .onConflictDoNothing();
    }

    return { status: 'ok', roles };
  });
}

export type ObjectScopesUpdate =
  | { readonly status: 'ok'; readonly objectIds: readonly string[] }
  | { readonly status: 'not_found' }
  | { readonly status: 'unknown_objects'; readonly missing: readonly string[] };

export async function replaceUserObjectScopes(
  db: Database,
  scope: AuthScope,
  userId: string,
  objectIds: readonly string[],
): Promise<ObjectScopesUpdate> {
  return db.transaction(async (tx) => {
    const target = await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, visibleUserIds(tx, scope, userId)))
      .for('update');
    if (target[0] === undefined) return { status: 'not_found' };

    if (objectIds.length > 0) {
      const known = await tx
        .select({ id: constructionObjects.id })
        .from(constructionObjects)
        .where(inArray(constructionObjects.id, [...objectIds]));
      const knownIds = new Set(known.map((entry) => entry.id));
      const missing = objectIds.filter((id) => !knownIds.has(id));
      // Явный отказ вместо 23503: администратор должен увидеть, какой именно
      // идентификатор объекта не существует.
      if (missing.length > 0) return { status: 'unknown_objects', missing };
    }

    await tx
      .delete(userObjectScopes)
      .where(
        objectIds.length === 0
          ? eq(userObjectScopes.userId, userId)
          : and(
              eq(userObjectScopes.userId, userId),
              notInArray(userObjectScopes.objectId, [...objectIds]),
            ),
      );

    if (objectIds.length > 0) {
      await tx
        .insert(userObjectScopes)
        .values(objectIds.map((objectId) => ({ userId, objectId })))
        .onConflictDoNothing();
    }

    return { status: 'ok', objectIds };
  });
}

export type ContractorUpdate =
  | { readonly status: 'ok'; readonly contractorId: string | null }
  | { readonly status: 'not_found' }
  | { readonly status: 'unknown_contractor' }
  /** Снятие организации у пользователя с ролью `contractor`. */
  | { readonly status: 'contractor_role_requires_organization' };

export async function setUserContractor(
  db: Database,
  scope: AuthScope,
  userId: string,
  contractorId: string | null,
): Promise<ContractorUpdate> {
  return db.transaction(async (tx) => {
    const target = await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, visibleUserIds(tx, scope, userId)))
      .for('update');
    if (target[0] === undefined) return { status: 'not_found' };

    if (contractorId !== null) {
      const organization = await tx
        .select({ id: counterparties.id, kind: counterparties.kind })
        .from(counterparties)
        .where(and(eq(counterparties.id, contractorId), eq(counterparties.isActive, true)));
      const found = organization[0];
      // Вид организации проверяется здесь, а не ограничением БД: FK допускает
      // любого контрагента, но поставку подаёт подрядчик или генподрядчик, а не
      // поставщик и не заказчик.
      if (found === undefined || !SUBMITTING_KINDS.includes(found.kind)) {
        return { status: 'unknown_contractor' };
      }
    } else {
      const held = await tx
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(and(eq(userRoles.userId, userId), eq(userRoles.role, 'contractor')));
      if (held[0] !== undefined) return { status: 'contractor_role_requires_organization' };
    }

    await tx
      .update(users)
      .set({ contractorId, updatedAt: sql`now()` })
      .where(eq(users.id, userId));

    return { status: 'ok', contractorId };
  });
}

// =====================================================================
// Настройки
// =====================================================================

export interface SettingRow {
  readonly key: string;
  readonly value: JsonValue;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export async function readSettings(
  db: Database,
  scope: AuthScope,
  keys: readonly string[],
): Promise<readonly SettingRow[]> {
  requireGlobalScope(scope, 'настроек портала');
  if (keys.length === 0) return [];

  const rows = await db
    .select({
      key: appSettings.key,
      value: appSettings.value,
      updatedAt: isoUtc<string>(appSettings.updatedAt, 'updated_at_iso'),
      updatedBy: appSettings.updatedBy,
    })
    .from(appSettings)
    .where(inArray(appSettings.key, [...keys]))
    .orderBy(asc(appSettings.key));

  return rows.map((row) => ({ ...row, value: row.value as JsonValue }));
}

export async function readSetting(
  db: Database,
  scope: AuthScope,
  key: string,
): Promise<SettingRow | null> {
  const rows = await readSettings(db, scope, [key]);
  return rows[0] ?? null;
}

/**
 * Значение настройки БЕЗ требования глобальной области (ADR-0007/0008).
 *
 * `readSettings` намеренно заперт `requireGlobalScope`: он отдаёт экран
 * администрирования, вместе с секретными ссылками и статусами интеграций.
 * Ветвление конвейера — другой читатель: инженер с областью, ограниченной
 * объектами, ставит распознавание и обязан узнать выбранного провайдера, не
 * получая прав администратора. Безопасно ровно потому, что `SETTINGS_REGISTRY`
 * закрыт для секретов по построению (`SECRET_SETTINGS`, 422 на запись) — здесь
 * нет ничего, что требовало бы скрывать значение по области видимости.
 */
export async function readSettingValue(db: Database, key: string): Promise<JsonValue | undefined> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return rows[0] === undefined ? undefined : (rows[0].value as JsonValue);
}

export async function writeSetting(
  db: Database,
  scope: AuthScope,
  input: {
    readonly key: string;
    readonly value: unknown;
    readonly audit: AuditEntry;
  },
): Promise<SettingRow> {
  requireGlobalScope(scope, 'настроек портала');

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(appSettings)
      .values({
        key: input.key,
        value: jsonbValue(input.value),
        updatedBy: input.audit.actorUserId,
        updatedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: jsonbValue(input.value),
          updatedBy: input.audit.actorUserId,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        key: appSettings.key,
        value: appSettings.value,
        updatedAt: isoUtc<string>(appSettings.updatedAt, 'updated_at_iso'),
        updatedBy: appSettings.updatedBy,
      });

    const row = rows[0];
    if (row === undefined) throw new Error('Настройка не записана: upsert не вернул строку');

    await appendAuditLog(tx, scope, input.audit);
    return { ...row, value: row.value as JsonValue };
  });
}

// =====================================================================
// Промты
// =====================================================================

export interface PromptTemplateRow {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly stage: string;
  readonly docTypeCode: string | null;
  readonly state: PromptState;
  readonly systemPrompt: string;
  readonly userTemplate: string;
  readonly outputSchema: JsonValue | null;
  readonly modelOverride: string | null;
  readonly publishedAt: string | null;
  readonly publishedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const PROMPT_SELECTION = {
  id: promptTemplates.id,
  code: promptTemplates.code,
  version: promptTemplates.version,
  stage: promptTemplates.stage,
  docTypeCode: promptTemplates.docTypeCode,
  state: promptTemplates.state,
  systemPrompt: promptTemplates.systemPrompt,
  userTemplate: promptTemplates.userTemplate,
  outputSchema: promptTemplates.outputSchema,
  modelOverride: promptTemplates.modelOverride,
  publishedAt: isoUtc<string | null>(promptTemplates.publishedAt, 'published_at_iso'),
  publishedBy: promptTemplates.publishedBy,
  createdAt: isoUtc<string>(promptTemplates.createdAt, 'created_at_iso'),
  updatedAt: isoUtc<string>(promptTemplates.updatedAt, 'updated_at_iso'),
};

type RawPromptRow = {
  id: string;
  code: string;
  version: number;
  stage: string;
  docTypeCode: string | null;
  state: string;
  systemPrompt: string;
  userTemplate: string;
  outputSchema: unknown;
  modelOverride: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Состояние и стадия ограничены `CHECK` в БД, поэтому приведение здесь
 * безопасно: расхождение перечисления с базой ломается на миграции и ловится
 * тестом на дрейф схемы, а не рантаймом.
 */
function toPromptRow(row: RawPromptRow): PromptTemplateRow {
  return {
    ...row,
    state: row.state as PromptState,
    outputSchema: (row.outputSchema ?? null) as JsonValue | null,
  };
}

const promptCursorSchema = z.object({ code: z.string().min(1), version: z.int().positive() });

export interface PromptFilter extends PageParams {
  readonly code?: string | undefined;
  readonly stage?: string | undefined;
  readonly state?: string | undefined;
}

export interface PromptPage {
  readonly items: readonly PromptTemplateRow[];
  readonly nextCursor: string | null;
}

/**
 * Страница промтов, упорядоченная по (код, версия).
 *
 * Порядок именно такой, потому что экран администрирования читается по кодам:
 * рядом обязаны стоять все версии одной стадии, иначе выбрать версию для отката
 * нельзя. Keyset по той же паре — вставка новой версии не сдвигает выдачу.
 */
export async function listPromptTemplates(
  db: Database,
  scope: AuthScope,
  filter: PromptFilter,
): Promise<PromptPage> {
  requireGlobalScope(scope, 'каталога промтов');

  const after = decodeCursor(promptCursorSchema, filter.cursor);
  const conditions: SQL[] = [];
  if (filter.code !== undefined) conditions.push(eq(promptTemplates.code, filter.code));
  if (filter.stage !== undefined) conditions.push(eq(promptTemplates.stage, filter.stage));
  if (filter.state !== undefined) conditions.push(eq(promptTemplates.state, filter.state));
  if (after !== null) {
    conditions.push(
      sql`(${promptTemplates.code}, ${promptTemplates.version}) > (${after.code}, ${after.version})`,
    );
  }

  const rows = await db
    .select(PROMPT_SELECTION)
    .from(promptTemplates)
    .where(conditions.length === 0 ? sql`true` : and(...conditions))
    .orderBy(asc(promptTemplates.code), asc(promptTemplates.version))
    .limit(filter.limit + 1);

  const page = rows.slice(0, filter.limit).map(toPromptRow);
  const last = page.at(-1);
  const nextCursor =
    rows.length > filter.limit && last !== undefined
      ? encodeCursor({ code: last.code, version: last.version })
      : null;

  return { items: page, nextCursor };
}

/**
 * Какие из перечисленных кодов опубликованы.
 *
 * Области видимости не принимает намеренно — и это НЕ «забыли аргумент» (шапка
 * файла настаивает на различии). Функция отвечает ровно на вопрос готовности стадии
 * и не отдаёт наружу ни текста промпта, ни его версии, ни факта существования
 * черновиков. Спрашивает её предполёт запуска распознавания
 * (`modules/recognition/start.ts`), который выполняется под областью подрядчика:
 * тот вправе знать, почему кнопка отказала, но не вправе читать каталог промтов, а
 * `listPromptTemplates` выше требует неограниченной области и ответила бы ему 403.
 *
 * Больше одной строки на код прийти не может: партиальный уникальный индекс
 * `ux_prompt_templates_single_published` (0007) держит одну опубликованную версию.
 */
export async function readPublishedPromptCodes(
  db: Database,
  codes: readonly string[],
): Promise<ReadonlySet<string>> {
  if (codes.length === 0) return new Set();

  const rows = await db
    .select({ code: promptTemplates.code })
    .from(promptTemplates)
    .where(and(eq(promptTemplates.state, 'published'), inArray(promptTemplates.code, [...codes])));

  return new Set(rows.map((row) => row.code));
}

export async function findPromptTemplate(
  db: Database,
  scope: AuthScope,
  id: string,
): Promise<PromptTemplateRow | null> {
  requireGlobalScope(scope, 'каталога промтов');

  const rows = await db
    .select(PROMPT_SELECTION)
    .from(promptTemplates)
    .where(eq(promptTemplates.id, id))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toPromptRow(row);
}

export interface PromptDraftInput {
  readonly code: string;
  readonly stage: string;
  readonly docTypeCode: string | null;
  readonly systemPrompt: string;
  readonly userTemplate: string;
  readonly outputSchema: unknown;
  readonly modelOverride: string | null;
}

export type PromptCreated =
  | { readonly status: 'ok'; readonly template: PromptTemplateRow }
  /** Номер версии занят: одновременное создание черновика того же кода. */
  | { readonly status: 'version_conflict' }
  | { readonly status: 'unknown_doc_type' };

/**
 * Новая версия промта в состоянии `draft`.
 *
 * Номер версии вычисляется подзапросом в том же INSERT, а не двумя запросами:
 * «прочитали максимум, прибавили один» — это гонка, из которой два
 * администратора выходят с одинаковой версией. Уникальность всё равно держит
 * `prompt_templates_code_version_uq`, поэтому проигравший получает 409 и
 * повторяет, а не портит нумерацию.
 */
export async function createPromptDraft(
  db: Database,
  scope: AuthScope,
  input: PromptDraftInput,
  audit: AuditEntry,
): Promise<PromptCreated> {
  requireGlobalScope(scope, 'каталога промтов');

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .insert(promptTemplates)
        .values({
          code: input.code,
          version: sql<number>`(select coalesce(max(t.version), 0) + 1
                                  from prompt_templates t
                                 where t.code = ${input.code})`,
          stage: input.stage,
          docTypeCode: input.docTypeCode,
          state: 'draft',
          systemPrompt: input.systemPrompt,
          userTemplate: input.userTemplate,
          outputSchema: jsonbOrNull(input.outputSchema),
          modelOverride: input.modelOverride,
        })
        .returning(PROMPT_SELECTION);

      const row = rows[0];
      if (row === undefined) throw new Error('Промт не создан: INSERT не вернул строку');
      const template = toPromptRow(row);

      await appendAuditLog(tx, scope, {
        ...audit,
        entityId: template.id,
        payload: { ...audit.payload, code: template.code, version: template.version },
      });

      return { status: 'ok', template };
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) return { status: 'version_conflict' };
    if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) return { status: 'unknown_doc_type' };
    throw error;
  }
}

export type PromptUpdated =
  | { readonly status: 'ok'; readonly template: PromptTemplateRow }
  | { readonly status: 'not_found' }
  /** Правка запрещена состоянием: `published` — триггером БД, `archived` — автоматом. */
  | { readonly status: 'immutable'; readonly state: PromptState | null };

export interface PromptPatch {
  readonly systemPrompt?: string | undefined;
  readonly userTemplate?: string | undefined;
  readonly outputSchema?: unknown;
  readonly modelOverride?: string | null | undefined;
}

/**
 * Правка черновика.
 *
 * Условие «состояние допускает правку» стоит в самом UPDATE, а не в коде после
 * чтения: между чтением и записью состояние может измениться публикацией, и
 * проверка оказалась бы про прежнее состояние. Триггер БД остаётся вторым
 * рубежом — его отказ переводится в 409 вызывающим.
 */
export async function updatePromptDraft(
  db: Database,
  scope: AuthScope,
  id: string,
  patch: PromptPatch,
  audit: AuditEntry,
  editableStates: readonly string[],
): Promise<PromptUpdated> {
  requireGlobalScope(scope, 'каталога промтов');

  const changes: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.systemPrompt !== undefined) changes['systemPrompt'] = patch.systemPrompt;
  if (patch.userTemplate !== undefined) changes['userTemplate'] = patch.userTemplate;
  if (patch.modelOverride !== undefined) changes['modelOverride'] = patch.modelOverride;
  if ('outputSchema' in patch) changes['outputSchema'] = jsonbOrNull(patch.outputSchema);

  return db.transaction(async (tx) => {
    const rows = await tx
      .update(promptTemplates)
      .set(changes)
      .where(and(eq(promptTemplates.id, id), inArray(promptTemplates.state, [...editableStates])))
      .returning(PROMPT_SELECTION);

    const row = rows[0];
    if (row === undefined) {
      const existing = await tx
        .select({ state: promptTemplates.state })
        .from(promptTemplates)
        .where(eq(promptTemplates.id, id))
        .limit(1);
      const state = existing[0]?.state;
      // Различие важно для клиента: 404 значит «нет такой версии», 409 —
      // «версия есть, но правится только новой версией».
      return state === undefined
        ? { status: 'not_found' }
        : { status: 'immutable', state: state as PromptState };
    }

    const template = toPromptRow(row);
    await appendAuditLog(tx, scope, {
      ...audit,
      entityId: template.id,
      payload: { ...audit.payload, fields: Object.keys(patch) },
    });

    return { status: 'ok', template };
  });
}

export type PromptTransitioned =
  | {
      readonly status: 'ok';
      readonly template: PromptTemplateRow;
      readonly archivedTemplateId: string | null;
    }
  | { readonly status: 'not_found' }
  /** Состояние изменилось между чтением и записью. */
  | { readonly status: 'stale'; readonly state: PromptState };

export interface PromptTransitionInput {
  readonly id: string;
  readonly from: PromptState;
  readonly to: PromptState;
  readonly archivesPreviousPublished: boolean;
  readonly stampsPublication: boolean;
}

/**
 * Смена состояния промта одной транзакцией.
 *
 * Публикация обязана быть атомарной вместе с архивацией прежней версии:
 * `ux_prompt_templates_single_published` допускает одну опубликованную версию на
 * код, поэтому порядок «сначала снять прежнюю, потом поставить новую» — не
 * стиль, а условие выполнимости. Разорванные операции оставили бы код вовсе без
 * опубликованной версии.
 *
 * `published_at` переставляется при каждом переходе в `published`, включая
 * откат: это отметка «с каких пор версия действует», а история публикаций живёт
 * в `audit_log`, который для этого и заведён.
 */
export async function transitionPrompt(
  db: Database,
  scope: AuthScope,
  input: PromptTransitionInput,
  audit: AuditEntry,
): Promise<PromptTransitioned> {
  requireGlobalScope(scope, 'каталога промтов');

  return db.transaction(async (tx) => {
    const target = await tx
      .select({
        id: promptTemplates.id,
        code: promptTemplates.code,
        state: promptTemplates.state,
      })
      .from(promptTemplates)
      .where(eq(promptTemplates.id, input.id))
      .for('update');

    const row = target[0];
    if (row === undefined) return { status: 'not_found' };
    if (row.state !== input.from) return { status: 'stale', state: row.state as PromptState };

    let archivedTemplateId: string | null = null;
    if (input.archivesPreviousPublished) {
      const archived = await tx
        .update(promptTemplates)
        .set({ state: 'archived', updatedAt: sql`now()` })
        .where(
          and(
            eq(promptTemplates.code, row.code),
            eq(promptTemplates.state, 'published'),
            ne(promptTemplates.id, input.id),
          ),
        )
        .returning({ id: promptTemplates.id });
      archivedTemplateId = archived[0]?.id ?? null;
    }

    const changes: Record<string, unknown> = { state: input.to, updatedAt: sql`now()` };
    if (input.stampsPublication) {
      changes['publishedAt'] = sql`now()`;
      changes['publishedBy'] = audit.actorUserId;
    }

    const updated = await tx
      .update(promptTemplates)
      .set(changes)
      .where(and(eq(promptTemplates.id, input.id), eq(promptTemplates.state, input.from)))
      .returning(PROMPT_SELECTION);

    const result = updated[0];
    if (result === undefined) return { status: 'stale', state: row.state as PromptState };

    const template = toPromptRow(result);
    await appendAuditLog(tx, scope, {
      ...audit,
      entityId: template.id,
      payload: {
        ...audit.payload,
        code: template.code,
        version: template.version,
        from: input.from,
        to: input.to,
        archivedTemplateId,
      },
    });

    return { status: 'ok', template, archivedTemplateId };
  });
}

// =====================================================================
// Правила и версии набора
// =====================================================================

export interface RuleDefinitionRow {
  readonly code: string;
  readonly title: string;
  readonly docTypeCode: string | null;
  readonly level: string;
  readonly kind: string;
  readonly defaultSeverity: Severity;
  readonly waiverRoles: readonly UserRole[];
}

export async function listRuleDefinitions(
  db: Database,
  scope: AuthScope,
): Promise<readonly RuleDefinitionRow[]> {
  requireGlobalScope(scope, 'реестра правил');

  const rows = await db
    .select({
      code: ruleDefinitions.code,
      title: ruleDefinitions.title,
      docTypeCode: ruleDefinitions.docTypeCode,
      level: ruleDefinitions.level,
      kind: ruleDefinitions.kind,
      defaultSeverity: ruleDefinitions.defaultSeverity,
      waiverRoles: ruleDefinitions.waiverRoles,
    })
    .from(ruleDefinitions)
    .orderBy(asc(ruleDefinitions.code));

  return rows.map((row) => ({
    ...row,
    defaultSeverity: severitySchema.parse(row.defaultSeverity),
    waiverRoles: row.waiverRoles.filter(
      (role): role is UserRole => userRoleSchema.safeParse(role).success,
    ),
  }));
}

export interface RulesetVersionRow {
  readonly id: string;
  readonly version: string;
  readonly publishedAt: string | null;
  readonly publishedBy: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly ruleCount: number;
}

const RULESET_SELECTION = {
  id: rulesetVersions.id,
  version: rulesetVersions.version,
  publishedAt: isoUtc<string | null>(rulesetVersions.publishedAt, 'published_at_iso'),
  publishedBy: rulesetVersions.publishedBy,
  notes: rulesetVersions.notes,
  createdAt: isoUtc<string>(rulesetVersions.createdAt, 'created_at_iso'),
  // Внешняя колонка написана ТЕКСТОМ, а не через `${rulesetVersions.id}`: в
  // выборке без джойнов Drizzle рендерит подставленную колонку без имени
  // таблицы, и `"id"` связался бы с внутренней областью подзапроса. Сегодня
  // счётчик верен лишь потому, что у `ruleset_rules` нет колонки `id`, — то
  // есть корректность держится на отсутствии колонки в чужой таблице.
  ruleCount: sql<number>`(select count(*)::int
                            from ruleset_rules r
                           where r.ruleset_version_id = ruleset_versions.id)`.as('rule_count'),
};

const rulesetCursorSchema = z.object({ createdAt: z.string().min(1), id: z.uuid() });

export interface RulesetPage {
  readonly items: readonly RulesetVersionRow[];
  readonly nextCursor: string | null;
}

/** Новые версии первыми: администратора интересует последняя, а не первая. */
export async function listRulesetVersions(
  db: Database,
  scope: AuthScope,
  params: PageParams,
): Promise<RulesetPage> {
  requireGlobalScope(scope, 'версий набора правил');

  const after = decodeCursor(rulesetCursorSchema, params.cursor);
  const conditions: SQL[] =
    after === null
      ? []
      : [
          sql`(${rulesetVersions.createdAt}, ${rulesetVersions.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
        ];

  const rows = await db
    .select({
      ...RULESET_SELECTION,
      cursorAt: sql<string>`${rulesetVersions.createdAt}::text`.as('cursor_at'),
    })
    .from(rulesetVersions)
    .where(conditions.length === 0 ? sql`true` : and(...conditions))
    .orderBy(desc(rulesetVersions.createdAt), desc(rulesetVersions.id))
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ createdAt: last.cursorAt, id: last.id })
      : null;

  return {
    items: page.map(({ cursorAt: _cursorAt, ...row }) => row),
    nextCursor,
  };
}

export async function findRulesetVersion(
  db: Database,
  scope: AuthScope,
  id: string,
): Promise<RulesetVersionRow | null> {
  requireGlobalScope(scope, 'версий набора правил');

  const rows = await db
    .select(RULESET_SELECTION)
    .from(rulesetVersions)
    .where(eq(rulesetVersions.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export interface RulesetRuleRow {
  readonly ruleCode: string;
  readonly isEnabled: boolean;
  readonly severity: Severity;
  readonly isBlocking: boolean;
  readonly params: JsonValue;
}

export async function listRulesetRules(
  db: Database,
  scope: AuthScope,
  versionId: string,
): Promise<readonly RulesetRuleRow[]> {
  requireGlobalScope(scope, 'снимка правил');

  const rows = await db
    .select({
      ruleCode: rulesetRules.ruleCode,
      isEnabled: rulesetRules.isEnabled,
      severity: rulesetRules.severity,
      isBlocking: rulesetRules.isBlocking,
      params: rulesetRules.params,
    })
    .from(rulesetRules)
    .where(eq(rulesetRules.rulesetVersionId, versionId))
    .orderBy(asc(rulesetRules.ruleCode));

  return rows.map((row) => ({
    ...row,
    severity: severitySchema.parse(row.severity),
    params: (row.params ?? {}) as JsonValue,
  }));
}

export interface RulesetRuleInput {
  readonly ruleCode: string;
  readonly isEnabled: boolean;
  readonly severity: string;
  readonly isBlocking: boolean;
  readonly params: unknown;
}

export interface RulesetPublishInput {
  readonly version: string;
  readonly notes: string | null;
  readonly rules: readonly RulesetRuleInput[];
  readonly activate: boolean;
  /** Ключ `app_settings`, в котором лежит указатель действующей версии. */
  readonly activeVersionKey: string;
}

export type RulesetPublished =
  | { readonly status: 'ok'; readonly version: RulesetVersionRow; readonly activated: boolean }
  | { readonly status: 'duplicate_version' }
  | { readonly status: 'unknown_rule_codes'; readonly missing: readonly string[] };

/**
 * Публикация версии набора правил вместе со снимком — одной транзакцией.
 *
 * Атомарность здесь не про удобство. Прогон проверок берёт поведение правил из
 * `ruleset_rules` по `ruleset_version_id`; версия, опубликованная раньше своих
 * правил, — это набор, по которому проверка выполнится с половиной правил и
 * запишет результат как полноценный. Восстановить потом, каких правил не
 * хватало, будет нечем.
 *
 * Порядок внутри транзакции задан триггерами 0008: сначала НЕопубликованная
 * версия, затем снимок, и только потом `published_at`. Вставить строку снимка в
 * уже опубликованную версию БД не даст — и это тот же инвариант, что здесь
 * соблюдается сознательно.
 */
export async function publishRulesetVersion(
  db: Database,
  scope: AuthScope,
  input: RulesetPublishInput,
  audit: AuditEntry,
): Promise<RulesetPublished> {
  requireGlobalScope(scope, 'версий набора правил');

  const codes = input.rules.map((rule) => rule.ruleCode);

  try {
    return await db.transaction(async (tx) => {
      const known = await tx
        .select({ code: ruleDefinitions.code })
        .from(ruleDefinitions)
        .where(inArray(ruleDefinitions.code, codes));
      const knownCodes = new Set(known.map((entry) => entry.code));
      const missing = codes.filter((code) => !knownCodes.has(code));
      // Отдельный отказ вместо 23503: «правило XXX не заведено в реестре» —
      // это ответ администратору, а нарушение FK им не является.
      if (missing.length > 0) return { status: 'unknown_rule_codes', missing };

      const created = await tx
        .insert(rulesetVersions)
        .values({ version: input.version, notes: input.notes })
        .returning({ id: rulesetVersions.id });
      const versionId = created[0]?.id;
      if (versionId === undefined) throw new Error('Версия набора правил не создана');

      await tx.insert(rulesetRules).values(
        input.rules.map((rule) => ({
          rulesetVersionId: versionId,
          ruleCode: rule.ruleCode,
          isEnabled: rule.isEnabled,
          severity: rule.severity,
          isBlocking: rule.isBlocking,
          params: jsonbValue(rule.params),
        })),
      );

      await tx
        .update(rulesetVersions)
        .set({ publishedAt: sql`now()`, publishedBy: audit.actorUserId })
        .where(eq(rulesetVersions.id, versionId));

      if (input.activate) {
        await upsertSettingWithin(tx, input.activeVersionKey, versionId, audit.actorUserId);
      }

      const published = await tx
        .select(RULESET_SELECTION)
        .from(rulesetVersions)
        .where(eq(rulesetVersions.id, versionId))
        .limit(1);
      const row = published[0];
      if (row === undefined) throw new Error('Опубликованная версия не прочитана');

      await appendAuditLog(tx, scope, {
        ...audit,
        entityId: versionId,
        payload: {
          ...audit.payload,
          version: input.version,
          ruleCount: input.rules.length,
          activated: input.activate,
        },
      });

      return { status: 'ok', version: row, activated: input.activate };
    });
  } catch (error) {
    if (
      pgErrorCode(error) === PG_UNIQUE_VIOLATION &&
      pgConstraint(error) !== 'ruleset_rules_pkey'
    ) {
      return { status: 'duplicate_version' };
    }
    throw error;
  }
}

export type RulesetActivated =
  | { readonly status: 'ok' }
  | { readonly status: 'not_found' }
  /** Указатель обязан вести на опубликованную версию, иначе прогон возьмёт черновик. */
  | { readonly status: 'not_published' };

export async function activateRulesetVersion(
  db: Database,
  scope: AuthScope,
  input: { readonly versionId: string; readonly activeVersionKey: string },
  audit: AuditEntry,
): Promise<RulesetActivated> {
  requireGlobalScope(scope, 'версий набора правил');

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: rulesetVersions.id, publishedAt: rulesetVersions.publishedAt })
      .from(rulesetVersions)
      .where(eq(rulesetVersions.id, input.versionId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return { status: 'not_found' };
    if (row.publishedAt === null) return { status: 'not_published' };

    await upsertSettingWithin(tx, input.activeVersionKey, input.versionId, audit.actorUserId);
    await appendAuditLog(tx, scope, { ...audit, entityId: input.versionId });

    return { status: 'ok' };
  });
}

/** Тот же upsert, что в `writeSetting`, но внутри уже открытой транзакции. */
async function upsertSettingWithin(
  executor: Executor,
  key: string,
  value: unknown,
  actorUserId: string,
): Promise<void> {
  await executor
    .insert(appSettings)
    .values({
      key,
      value: jsonbValue(value),
      updatedBy: actorUserId,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: jsonbValue(value), updatedBy: actorUserId, updatedAt: sql`now()` },
    });
}
