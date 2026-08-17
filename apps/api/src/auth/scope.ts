/**
 * Область видимости запроса — второй из трёх уровней изоляции (§4.1).
 *
 * Первый уровень — permission на роуте, третий — составные FK в БД. Этот
 * уровень отвечает за то, чтобы запрос физически не мог вернуть строки вне
 * области пользователя, и потому он не «фильтр», а обязательный аргумент
 * каждого репозиторного метода: забыть его нельзя, потому что тип не сойдётся.
 *
 * Почему это тип-сумма, а не объект с необязательными полями. При
 * `{ contractorId?, objectIds? }` пропущенное поле означало бы «нет
 * ограничения», то есть ошибка заполнения открывала бы доступ ко всему.
 * У разъединённого типа отсутствие ограничения выражается отдельным
 * вариантом, который приходится выбрать осознанно.
 */

/** Подрядчик: видит только поставки своей организации. */
export interface ContractorScope {
  readonly kind: 'contractor';
  readonly userId: string;
  readonly contractorId: string;
}

/** Инженер: все подрядчики, но только на назначенных объектах. */
export interface EngineerScope {
  readonly kind: 'engineer';
  readonly userId: string;
  readonly objectIds: readonly string[];
}

/** Руководитель: все объекты. */
export interface ManagerScope {
  readonly kind: 'manager';
  readonly userId: string;
}

/**
 * Администратор: настройки и пользователи.
 *
 * Доступ к данным ИД у него такой же широкий, как у руководителя, но
 * бизнес-согласование требует отдельной роли `manager` (§4.1) — это
 * проверяется permission'ом на роуте, а не областью видимости.
 */
export interface AdminScope {
  readonly kind: 'admin';
  readonly userId: string;
}

export type AuthScope = ContractorScope | EngineerScope | ManagerScope | AdminScope;

/**
 * Колонки области видимости, которые обязана иметь каждая таблица данных ИД.
 *
 * Они денормализованы во всех дочерних таблицах намеренно: иначе фильтрация
 * требовала бы join'а до корня дерева на каждом запросе. Целостность
 * денормализации держат составные FK (§3), а не код.
 */
export interface ScopedColumns {
  readonly objectId: unknown;
  readonly contractorId: unknown;
}

/**
 * Инженер без назначенных объектов.
 *
 * Значимый случай: пустой список объектов должен давать пустую выборку, а не
 * отсутствие ограничения. Наивная сборка `IN ()` из пустого массива в ряде
 * построителей запросов вырождается в `TRUE`, поэтому проверка вынесена явно.
 */
export function isEmptyScope(scope: AuthScope): boolean {
  return scope.kind === 'engineer' && scope.objectIds.length === 0;
}

/** Видит ли область все объекты без ограничения. */
export function isUnrestricted(scope: AuthScope): boolean {
  return scope.kind === 'manager' || scope.kind === 'admin';
}

/**
 * Разрешён ли доступ к конкретному объекту и подрядчику.
 *
 * Используется там, где строка уже прочитана и нужно проверить принадлежность:
 * при выдаче presigned URL, при обработке события SSE, при скачивании файла.
 * Именно эти четыре пути обходят фильтрацию в SQL, если о них забыть.
 */
export function allowsRow(
  scope: AuthScope,
  row: { readonly objectId: string; readonly contractorId: string },
): boolean {
  switch (scope.kind) {
    case 'admin':
    case 'manager':
      return true;
    case 'contractor':
      return row.contractorId === scope.contractorId;
    case 'engineer':
      return scope.objectIds.includes(row.objectId);
  }
}
