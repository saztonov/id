/**
 * Типы PostgreSQL, которых нет в pg-core у drizzle-orm 0.45.
 *
 * `drizzle-kit introspect` для них выдаёт `unknown("колонка")` с пометкой
 * «failed to parse database type», что не компилируется. Постобработка
 * генератора подставляет вместо этого типы отсюда.
 *
 * Файл рукописный и в генерацию не входит: он описывает соответствие типа БД
 * типу TypeScript, а не структуру схемы.
 */
import { customType } from 'drizzle-orm/pg-core';

/**
 * `citext` — регистронезависимый текст. Используется для email: сравнение
 * адресов по регистру различаться не должно, и обеспечивать это должна БД,
 * а не каждый запрос по отдельности.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * `bytea` — двоичные данные. Хранит зашифрованный конверт refresh-токена:
 * §4.1 требует, чтобы токен Keycloak не попадал ни в браузер, ни в БД
 * в открытом виде.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * `int4range` — диапазон целых. Хранит `char_span`: границы цитаты в тексте
 * страницы. Диапазоном, а не парой колонок, чтобы БД сама отвергала
 * перевёрнутые границы и поддерживала пересечения индексом.
 *
 * Драйвер отдаёт диапазон строкой вида `[12,48)`, поэтому разбор и сборка —
 * здесь, а не в каждом обращении.
 */
export interface Int4Range {
  readonly start: number;
  readonly end: number;
}

export const int4range = customType<{ data: Int4Range; driverData: string }>({
  dataType() {
    return 'int4range';
  },
  toDriver(value: Int4Range): string {
    return `[${value.start},${value.end})`;
  },
  fromDriver(value: string): Int4Range {
    const m = /^\[(-?\d+),(-?\d+)\)$/u.exec(value);
    if (!m) throw new Error(`Не разобран int4range: ${value}`);
    return { start: Number(m[1]), end: Number(m[2]) };
  },
});
