/**
 * Реестр правил существует в двух представлениях: `RULE_CATALOG` в
 * packages/rules и строки миграции 0017. Расхождение — тихая ошибка того же
 * класса, что каталог видов ИД на S1: движок исполняет один набор кодов, БД
 * ссылается внешними ключами на другой, а сверка при старте узнаёт об этом уже
 * на боевом стенде.
 *
 * Отсюда три проверки. Первая — на дрейф: закоммиченная миграция обязана
 * совпадать с текущим выводом `generateRuleSeedSql()`. Вторая — на применимость:
 * SQL прогоняется на настоящем PostgreSQL (pglite) поверх полной схемы, с её
 * CHECK-ограничениями и внешними ключами. Третья — на смысл: прочитанные из БД
 * коды обязаны сойтись с каталогом реализаций, то есть пройти ровно ту сверку,
 * которую выполняет старт приложения.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import { applyMigrations, checksumOf, loadMigrations } from '@id/migrator';
import type { SqlExecutor } from '@id/migrator';
import {
  RULE_CATALOG,
  RuleRegistryError,
  assertRuleRegistryMatches,
  duplicateRuleCodes,
  generateRuleSeedSql,
} from '@id/rules';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const SEED_FILE = '0017_seed_rule_definitions.sql';

const committedSeed = readFileSync(join(MIGRATIONS_DIR, SEED_FILE), 'utf8').replace(/\r\n/gu, '\n');

describe('seed реестра правил не отстаёт от каталога', () => {
  it('совпадает с текущим выводом generateRuleSeedSql()', () => {
    expect(
      checksumOf(committedSeed),
      `${SEED_FILE} разошёлся с каталогом. Перегенерируйте: pnpm rules:seed:generate`,
    ).toBe(checksumOf(generateRuleSeedSql()));
  });

  it('виден раннеру как миграция и входит в непрерывную нумерацию', () => {
    const seed = loadMigrations(MIGRATIONS_DIR).find(
      (migration) => migration.fileName === SEED_FILE,
    );
    expect(seed).toBeDefined();
    expect(seed?.checksum).toBe(checksumOf(committedSeed));
  });

  it('в каталоге нет дублирующихся кодов', () => {
    // Дубль означал бы, что вторая реализация вытесняет первую при сиде, а
    // правило остаётся в списке включённых и молча не исполняется.
    expect(duplicateRuleCodes()).toEqual([]);
  });
});

describe('seed применяется на настоящей схеме', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createPgliteDatabase();
    await applyMigrations(db as unknown as SqlExecutor, loadMigrations(MIGRATIONS_DIR));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('записывает все правила каталога', async () => {
    const rows = await db.query<{ code: string }>(
      'SELECT code FROM rule_definitions ORDER BY code',
    );
    const codes = rows.map((row) => row.code);

    expect(codes.length).toBe(RULE_CATALOG.length);
    expect(codes).toEqual([...RULE_CATALOG.map((spec) => spec.code)].sort());
  });

  it('прочитанные из БД коды проходят сверку с реализациями', async () => {
    const rows = await db.query<{ code: string }>('SELECT code FROM rule_definitions');
    expect(() => {
      assertRuleRegistryMatches(rows.map((row) => row.code));
    }).not.toThrow();
  });

  it('сверка чувствительна: лишняя строка в реестре её роняет', async () => {
    // Мутация без правки продакшн-кода: доказывает, что зелёный результат выше
    // — свойство данных, а не свойство функции, которая всегда возвращает «ок».
    const rows = await db.query<{ code: string }>('SELECT code FROM rule_definitions');
    expect(() => {
      assertRuleRegistryMatches([...rows.map((row) => row.code), 'PHANTOM.999']);
    }).toThrow(RuleRegistryError);
  });

  it('повторное применение сида идемпотентно', async () => {
    const before = await db.query<{ count: string }>('SELECT count(*) FROM rule_definitions');
    await db.exec(generateRuleSeedSql());
    const after = await db.query<{ count: string }>('SELECT count(*) FROM rule_definitions');

    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('doc_type_code правил ссылается на существующие виды ИД', async () => {
    const orphans = await db.query<{ code: string }>(
      `SELECT r.code FROM rule_definitions r
       LEFT JOIN doc_types d ON d.code = r.doc_type_code
       WHERE r.doc_type_code IS NOT NULL AND d.code IS NULL`,
    );
    expect(orphans).toEqual([]);
  });
});
