/**
 * Главная проверка — не сравнение строк, а прогон сгенерированного SQL на
 * настоящем PostgreSQL (pglite). Якоря каталога состоят из обратных слэшей и
 * скобок, и единственный надёжный способ доказать корректность экранирования —
 * дать этот SQL исполнить самому парсеру PostgreSQL, а затем прочитать данные
 * обратно и сверить с каталогом.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

// Пакет резолвится по имени, а не относительным путём до dist: так pnpm знает
// о зависимости и собирает db-harness раньше. Поэтому же сборка идёт до тестов
// и в гейте, и в CI.
import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import { DOC_TYPES } from './catalog.js';
import { PAGE_ROLES } from './page-roles.js';
import { generateSeedSql, generateSeedStatements, sqlLiteral } from './seed.js';

const SORTED_DOC_TYPE_CODES = DOC_TYPES.map((docType) => docType.code).sort();
const SORTED_PAGE_ROLE_CODES = PAGE_ROLES.map((role) => role.code).sort();

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('generateSeedSql', () => {
  it('детерминирован', () => {
    expect(generateSeedSql()).toBe(generateSeedSql());
  });

  it('только вставляет и обновляет', () => {
    const sql = generateSeedSql();

    expect(sql).toContain('ON CONFLICT (code) DO UPDATE SET');
    expect(sql).toContain('WHERE doc_types.is_system;');
    expect(sql).not.toMatch(/\b(delete|truncate)\b/i);
  });

  it('обновляет только системные поля', () => {
    const sql = generateSeedSql();

    expect(sql).toContain('  name = EXCLUDED.name');
    expect(sql).toContain('  field_schema = EXCLUDED.field_schema');
    // is_system и code менять нельзя: первое — признак владения строкой,
    // второе — ключ конфликта.
    expect(sql).not.toContain('is_system = EXCLUDED.is_system');
    expect(sql).not.toContain('code = EXCLUDED.code');
  });

  it('каждый код каталога встречается ровно один раз', () => {
    const sql = generateSeedSql();

    for (const code of [...SORTED_DOC_TYPE_CODES, ...SORTED_PAGE_ROLE_CODES]) {
      expect(countOccurrences(sql, sqlLiteral(code))).toBe(1);
    }
  });

  it('перечисляет типы по возрастанию кода', () => {
    const sql = generateSeedSql();
    const positions = SORTED_DOC_TYPE_CODES.map((code) => sql.indexOf(sqlLiteral(code)));

    expect(positions).toStrictEqual([...positions].sort((a, b) => a - b));
  });
});

/**
 * Минимальные таблицы по §3.2 — ровно те колонки, которые заполняет seed,
 * плюс ключи и умолчания. Полная схема приедет отдельной миграцией.
 */
const SCHEMA_SQL = [
  `CREATE TABLE doc_types (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     code text NOT NULL UNIQUE,
     name text NOT NULL,
     short_name text NOT NULL,
     group_code text NOT NULL,
     kind text NOT NULL,
     has_annexes boolean NOT NULL,
     match_hints jsonb NOT NULL,
     field_schema jsonb NOT NULL,
     is_system boolean NOT NULL DEFAULT false,
     is_fallback boolean NOT NULL DEFAULT false,
     sort_order integer NOT NULL
   )`,
  `CREATE TABLE page_roles (
     code text PRIMARY KEY,
     name text NOT NULL
   )`,
];

describe('прогон seed на pglite', () => {
  let db: TestDatabase;

  async function applySeed(): Promise<void> {
    for (const statement of generateSeedStatements()) {
      await db.query(statement);
    }
  }

  async function docTypeRows(): Promise<
    { code: string; name: string; match_hints: unknown; field_schema: unknown }[]
  > {
    return db.query('SELECT code, name, match_hints, field_schema FROM doc_types ORDER BY code');
  }

  beforeAll(async () => {
    db = await createPgliteDatabase();
    for (const statement of SCHEMA_SQL) {
      await db.query(statement);
    }
    await applySeed();
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it('вставляет весь каталог и все роли страниц', async () => {
    const docTypes = await db.query<{ code: string }>('SELECT code FROM doc_types ORDER BY code');
    const pageRoles = await db.query<{ code: string }>('SELECT code FROM page_roles ORDER BY code');

    expect(docTypes.map((row) => row.code)).toStrictEqual(SORTED_DOC_TYPE_CODES);
    expect(pageRoles.map((row) => row.code)).toStrictEqual(SORTED_PAGE_ROLE_CODES);
  });

  it('сохраняет якоря и схемы полей без потерь', async () => {
    const rows = await docTypeRows();
    const byCode = new Map(rows.map((row) => [row.code, row]));

    for (const docType of DOC_TYPES) {
      const row = byCode.get(docType.code);

      // Сверка через JSON.parse(JSON.stringify(...)) снимает разницу
      // readonly-массивов и опущенных необязательных ключей: сравниваются
      // данные, а не то, как их описал TypeScript.
      expect(row?.match_hints).toStrictEqual(JSON.parse(JSON.stringify(docType.matchHints)));
      expect(row?.field_schema).toStrictEqual(JSON.parse(JSON.stringify(docType.fieldSchema)));
    }
  });

  it('повторный прогон ничего не меняет', async () => {
    const before = await docTypeRows();
    const pageRolesBefore = await db.query('SELECT code, name FROM page_roles ORDER BY code');

    await applySeed();

    expect(await docTypeRows()).toStrictEqual(before);
    expect(await db.query('SELECT code, name FROM page_roles ORDER BY code')).toStrictEqual(
      pageRolesBefore,
    );
  });

  it('восстанавливает системную строку и не трогает пользовательскую', async () => {
    const [system, custom] = SORTED_DOC_TYPE_CODES;
    if (system === undefined || custom === undefined) {
      throw new Error('Каталог должен содержать хотя бы два типа');
    }

    const systemName = 'Правка системной строки';
    const customName = 'Правка администратора';
    await db.query('UPDATE doc_types SET name = $1 WHERE code = $2', [systemName, system]);
    await db.query('UPDATE doc_types SET name = $1, is_system = false WHERE code = $2', [
      customName,
      custom,
    ]);

    await applySeed();

    const rows = await db.query<{ code: string; name: string }>(
      'SELECT code, name FROM doc_types WHERE code = ANY($1) ORDER BY code',
      [[system, custom]],
    );
    const names = new Map(rows.map((row) => [row.code, row.name]));

    expect(names.get(system)).not.toBe(systemName);
    expect(names.get(custom)).toBe(customName);
  });

  it('экранирует апострофы, слэши и коллизию с долларовым тегом', async () => {
    const nasty = 'О\'Брайен \\s\\d{1,2} $seed$ $seed1 "кавычки"\n^\\s*АКТ\\s*$';
    const rows = await db.query<{ value: string }>(`SELECT ${sqlLiteral(nasty)} AS value`);

    expect(rows[0]?.value).toBe(nasty);
  });
});
