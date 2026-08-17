/**
 * Репозиторий пользователей — ОБРАЗЕЦ для всех остальных репозиториев.
 *
 * Правила, которые повторяются в каждом файле `db/repositories/*`:
 *
 * 1. Первым содержательным аргументом каждого метода идёт `AuthScope`. Не
 *    `userId`, не `role`, не «фильтр»: область видимости — обязательный вход,
 *    забыть который нельзя, потому что без него не сойдётся тип.
 * 2. Условие области берётся ТОЛЬКО из `withScope()`. Своих `eq(objectId, …)`
 *    в репозитории не бывает: продублированное правило доступа — это второй
 *    источник правды, и расходятся такие копии молча.
 * 3. Клиентские параметры (`objectId`, `contractorId` из query) НИКОГДА не
 *    заменяют область: они добавляются как обычные условия ПОВЕРХ неё. Иначе
 *    подрядчик, подставив чужой `contractorId`, читал бы чужие поставки.
 * 4. Запись подчиняется тому же правилу, что и чтение: UPDATE и DELETE
 *    ограничиваются подзапросом с тем же `withScope()`, а не проверкой в коде
 *    после чтения строки.
 *
 * Особенность именно этой таблицы: `users` — таблица идентичности, а не данных
 * ИД, и денормализованного `object_id` в ней нет. Поэтому цель области
 * собирается из соединения с `user_object_scopes`. В репозиториях данных ИД
 * (`files`, `pages`, `markup_blocks`, …) так делать НЕ НУЖНО: там `object_id` и
 * `contractor_id` лежат в самой строке, и в `ScopeTarget` передаются её
 * собственные колонки.
 *
 * Семантика видимости пользователей: `admin` и `manager` видят всех, инженер —
 * тех, кто назначен хотя бы на один из его объектов, подрядчик — сотрудников
 * своей организации.
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { userObjectScopes, userRoles, users } from '@id/db';
import { userRoleSchema, type UserRole } from '@id/contracts';
import { z } from 'zod';
import type { AuthScope } from '../../auth/scope.js';
import { badRequest } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';

export type Database = NodePgDatabase;

/**
 * Цель области видимости для `users`.
 *
 * `objectId` берётся из назначений пользователя, `contractorId` — из его
 * собственной строки. Соединение обязано быть LEFT: пользователь без
 * назначений должен остаться видимым для `admin` и `manager`, а INNER JOIN
 * молча выбросил бы его из выдачи.
 */
const USERS_SCOPE_TARGET: ScopeTarget = {
  objectId: userObjectScopes.objectId,
  contractorId: users.contractorId,
};

/** Агрегат ролей: два LEFT JOIN размножают строки, `distinct` их сворачивает. */
const ROLES_AGGREGATE = sql<
  string[]
>`coalesce(array_agg(distinct ${userRoles.role}) filter (where ${userRoles.role} is not null), '{}'::text[])`;

export interface UserSummary {
  readonly id: string;
  readonly email: string | null;
  readonly fullName: string;
  readonly position: string | null;
  readonly isActive: boolean;
  readonly contractorId: string | null;
  readonly roles: readonly UserRole[];
  readonly createdAt: string;
}

export interface ListUsersParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
}

export interface UserPage {
  readonly items: readonly UserSummary[];
  readonly nextCursor: string | null;
}

type UserRowShape = {
  id: string;
  email: string | null;
  fullName: string;
  position: string | null;
  isActive: boolean;
  contractorId: string | null;
  createdAt: string;
  roles: string[];
};

/**
 * Метка времени в ISO-8601 средствами БД, а не форматтером драйвера.
 *
 * Колонка объявлена `mode: 'string'`, и Drizzle отдаёт то, что прислал
 * PostgreSQL, — `2026-08-18 03:23:26.132+05`. Это не ISO-8601: пробел вместо
 * `T`, смещение без двоеточия. Схема ответа (`isoDateTimeSchema`) такое значение
 * отвергает, то есть список пользователей отвечал бы 500. Тесты этого не
 * показывали, потому что тестовый пул приводил `Date` к ISO сам, — дефект жил
 * ровно в зазоре между двойником и настоящим драйвером.
 */
const SELECTION = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  position: users.position,
  isActive: users.isActive,
  contractorId: users.contractorId,
  createdAt:
    sql<string>`to_char(${users.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
      'created_at_iso',
    ),
  roles: ROLES_AGGREGATE,
};

/**
 * Страница пользователей.
 *
 * `group by users.id` достаточно для остальных колонок `users`: PostgreSQL
 * признаёт их функционально зависимыми от первичного ключа. Перечислять их в
 * GROUP BY значило бы получить список, который забудут обновить при добавлении
 * колонки.
 */
export async function listUsers(
  db: Database,
  scope: AuthScope,
  params: ListUsersParams,
): Promise<UserPage> {
  const after = decodeCursor(params.cursor);
  const conditions = after === null ? [] : [keysetAfter(after)];

  const rows = await db
    .select(SELECTION)
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(userObjectScopes, eq(userObjectScopes.userId, users.id))
    .where(withScope(scope, USERS_SCOPE_TARGET, ...conditions))
    .groupBy(users.id)
    .orderBy(asc(users.createdAt), asc(users.id))
    // На одну больше запрошенного: так наличие следующей страницы известно без
    // отдельного COUNT по тому же условию.
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit).map(toUserSummary);
  const last = page.at(-1);
  const nextCursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null;

  return { items: page, nextCursor };
}

export async function findUserById(
  db: Database,
  scope: AuthScope,
  userId: string,
): Promise<UserSummary | null> {
  const rows = await db
    .select(SELECTION)
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(userObjectScopes, eq(userObjectScopes.userId, users.id))
    .where(withScope(scope, USERS_SCOPE_TARGET, eq(users.id, userId)))
    .groupBy(users.id)
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toUserSummary(row);
}

const scopedUsers = alias(users, 'scoped_users');
const scopedObjectScopes = alias(userObjectScopes, 'scoped_user_object_scopes');

/**
 * Пример scoped-записи.
 *
 * Область применяется подзапросом, а не проверкой «прочитали строку — сравнили
 * поля»: между чтением и записью строка может измениться, и проверка окажется
 * про прежнее состояние. Возвращается признак «строка была затронута», по
 * которому вызывающий отличает 404 от успеха, не выполняя отдельного SELECT.
 */
export async function setUserActive(
  db: Database,
  scope: AuthScope,
  userId: string,
  isActive: boolean,
): Promise<boolean> {
  const visible = db
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

  const updated = await db
    .update(users)
    .set({ isActive, updatedAt: sql`now()` })
    .where(inArray(users.id, visible))
    .returning({ id: users.id });

  return updated.length > 0;
}

function toUserSummary(row: UserRowShape): UserSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    position: row.position,
    isActive: row.isActive,
    contractorId: row.contractorId,
    createdAt: row.createdAt,
    // Значения приходят из колонки с ограничением CHECK, но набор ролей — часть
    // контракта API, и проверка схемой домена здесь дешевле, чем расследование
    // «откуда в ответе роль, которой нет в перечислении».
    roles: row.roles.filter((role): role is UserRole => userRoleSchema.safeParse(role).success),
  };
}

// =====================================================================
// Курсор
// =====================================================================

const cursorSchema = z.object({ createdAt: z.string().min(1), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

/** Keyset, а не OFFSET: вставка строки не сдвигает выдачу и не прячет записи. */
function keysetAfter(cursor: Cursor) {
  return sql`(${users.createdAt}, ${users.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Повреждённый курсор — ошибка запроса, а не «начнём заново».
 *
 * Молчаливый откат к первой странице выглядит для клиента как бесконечный
 * список: он листает, получает те же записи и снова тот же курсор.
 */
function decodeCursor(raw: string | null | undefined): Cursor | null {
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
