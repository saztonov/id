/**
 * Применение области видимости к запросам Drizzle.
 *
 * Единственное место, где `AuthScope` превращается в условие SQL. Репозитории
 * обязаны получать условие отсюда: продублированная логика фильтрации — это
 * второй источник правды для правила доступа, и разойтись они могут молча.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { isEmptyScope, isUnrestricted, type AuthScope } from '../auth/scope.js';

export interface ScopeTarget {
  readonly objectId: PgColumn;
  readonly contractorId: PgColumn;
}

/**
 * Условие, ограничивающее выборку областью видимости.
 *
 * Возвращает `SQL`, а не `SQL | undefined`: необязательное условие пришлось бы
 * проверять на каждом вызове, и пропущенная проверка означала бы выборку без
 * ограничения. Поэтому «без ограничения» выражается явным `TRUE`, а «пустая
 * область» — явным `FALSE`.
 */
export function scopeWhere(scope: AuthScope, target: ScopeTarget): SQL {
  if (isEmptyScope(scope)) {
    // Инженер или генподрядчик без объектов не видит ничего. Наивный IN () из
    // пустого массива вырождается в TRUE, что открыло бы всю таблицу.
    return sql`false`;
  }

  if (isUnrestricted(scope)) return sql`true`;

  switch (scope.kind) {
    case 'contractor':
      return eq(target.contractorId, scope.contractorId);
    case 'general_contractor':
    case 'engineer':
      // Генподрядчик ограничен ОБЪЕКТОМ, а не организацией: он ведёт реестр из
      // комплектов субподрядчиков, и фильтр по своей организации оставил бы ему
      // видимым только файл самого реестра.
      return inArray(target.objectId, [...scope.objectIds]);
    default:
      // Недостижимо: остальные варианты закрыты проверками выше. Возврат
      // FALSE, а не TRUE — чтобы новый вариант области, добавленный без
      // правки этой функции, закрывал доступ, а не открывал его.
      return sql`false`;
  }
}

/** Совмещает область видимости с прикладными условиями. */
export function withScope(scope: AuthScope, target: ScopeTarget, ...conditions: SQL[]): SQL {
  const combined = and(scopeWhere(scope, target), ...conditions);
  // and() возвращает undefined только при пустом списке, а первый аргумент
  // здесь всегда задан; проверка нужна лишь для сужения типа.
  return combined ?? sql`false`;
}
