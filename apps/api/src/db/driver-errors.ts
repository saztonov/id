/**
 * Поля ошибки драйвера `pg` сквозь обёртки Drizzle.
 *
 * Один помощник на весь слой данных, а не копия в каждом репозитории. Копий было
 * три, с разной глубиной обхода, и одна из них — `isUniqueViolation` в `jobs.ts` —
 * читала поле только с верхнего уровня. Цена расхождения известна поимённо: повтор
 * при гонке за `seq` события ревизии не срабатывал ни разу за всё время жизни кода,
 * и в журнале задачи вместо причины отказа распознавания осталось «duplicate key».
 */

/** Ограничение глубины обхода `cause`: цепочка ошибок бывает и циклической. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Поле ошибки драйвера `pg` сквозь обёртки Drizzle.
 *
 * Drizzle 0.45 заворачивает КАЖДЫЙ отказ драйвера в `DrizzleQueryError`, а само имя
 * нарушенного ограничения и SQLSTATE лежат в `cause`. Проверка только верхнего
 * уровня давала бы `null` на КАЖДОМ отказе, то есть все ограничения превращались бы
 * в 500 — молча.
 */
export function driverField(error: unknown, field: 'constraint' | 'code'): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const value: unknown = (current as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.length > 0) return value;
    const cause: unknown = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === null || cause === current) return null;
    current = cause;
  }
  return null;
}
