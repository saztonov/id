/**
 * Набор правил применяется на базе, где его предусловие не выполнено (S57).
 *
 * ## Дефект, из-за которого тест написан
 *
 * Миграция набора вставляет снимок в `ruleset_rules`, а тот ссылается на
 * `rule_definitions` внешним ключом. Определения сеют партии, идущие раньше, и
 * до сих пор этого считалось довольно: партия применена — значит правила на
 * месте.
 *
 * На боевой базе это оказалось неверно. `REG.113` и `REG.114` в реестре
 * отсутствовали, хотя их партия (0074) числилась применённой с совпадающей
 * контрольной суммой; снимок `builtin-3` содержал 64 правила вместо 66. Выкат
 * следующего набора умер на `ruleset_rules_rule_code_fkey`, и вместе с ним
 * встала вся выкатка портала — миграции применяются до старта приложения.
 *
 * ## Почему тест устроен именно так
 *
 * Прогон миграций «с нуля» боевого случая НЕ воспроизводит: там партия отработает
 * и правила появятся. Поэтому состояние моделируется пропуском — применяются все
 * миграции, кроме тех, что сеют `REG.113`/`REG.114` и снимают их в снимок. База
 * получается ровно такой, какой оказалась боевая: определений нет, а набор
 * применить надо.
 *
 * Второй тест — чувствительность: он же доказывает, что первый не проходит сам
 * собой. Без досева определений миграция набора обязана падать именно с
 * нарушением внешнего ключа.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import type { Migration, SqlExecutor } from '@id/migrator';
import { applyMigrations, loadMigrations } from '@id/migrator';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

/** Партия, сеющая REG.113/114, и набор, включивший их в свой снимок. */
const SKIPPED = ['0074', '0075'];

/** Набор, который обязан доставить предусловие сам. */
const RULESET = '0078';

/**
 * Проверяется состояние базы НА МОМЕНТ этого набора, а не «все миграции разом».
 *
 * Следующие наборы тоже досевают определения (0081 — builtin-5), и без границы
 * предпосылка теста ломается молча: правил «нет» ровно до тех пор, пока их не
 * посеял кто-то более поздний, и тогда тест доказывал бы, что набор применяется
 * там, где всё уже на месте.
 */
function upToRuleset(migrations: readonly Migration[]): readonly Migration[] {
  return migrations.filter((migration) => migration.version <= RULESET);
}

/** `TestDatabase` реализует `SqlExecutor` целиком — как и в `migrations.test.ts`. */
function executorOf(db: TestDatabase): SqlExecutor {
  return db;
}

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.close();
  database = null;
});

async function applyUpTo(versions: readonly Migration[]): Promise<TestDatabase> {
  const db = await createPgliteDatabase();
  database = db;
  await applyMigrations(executorOf(db), versions);
  return db;
}

describe('набор правил и его предусловие', () => {
  it('применяется на базе, где определений его правил нет', async () => {
    const all = loadMigrations(MIGRATIONS_DIR);
    const withoutSeed = upToRuleset(
      all.filter((migration) => !SKIPPED.includes(migration.version)),
    );

    // Сначала — всё, КРОМЕ самого набора: так воспроизводится боевое состояние.
    const db = await applyUpTo(withoutSeed.filter((m) => m.version !== RULESET));

    // Предпосылка теста: правил действительно нет — иначе он доказывал бы, что
    // набор применяется там, где всё и так на месте.
    const before = await db.query(
      `SELECT code FROM rule_definitions WHERE code IN ('REG.113', 'REG.114')`,
    );
    expect(before).toHaveLength(0);

    // И только теперь — набор. Он обязан примениться, доставив предусловие сам.
    await applyMigrations(executorOf(db), withoutSeed);

    // Набор применён (иначе `applyMigrations` бросил бы), и определения им же
    // доставлены: снимок ссылается на существующие строки.
    const after = await db.query<{ rule_code: string }>(
      `SELECT r.rule_code FROM ruleset_rules r
         JOIN ruleset_versions v ON v.id = r.ruleset_version_id
        WHERE v.version = 'builtin-4' AND r.rule_code IN ('REG.113', 'REG.114')
        ORDER BY r.rule_code`,
    );
    expect(after.map((row) => row.rule_code)).toEqual(['REG.113', 'REG.114']);
  }, 120_000);

  it('без досева определений тот же набор падает на внешнем ключе', async () => {
    // Чувствительность: доказывает, что первый тест держится на секции досева,
    // а не на порядке миграций. Секция вырезается из текста — ровно то, чем
    // файл отличался до починки.
    const all = loadMigrations(MIGRATIONS_DIR);
    const crippled = upToRuleset(
      all.filter((migration) => !SKIPPED.includes(migration.version)),
    ).map((migration) =>
      migration.version === RULESET
        ? { ...migration, sql: withoutDefinitionsSection(migration.sql) }
        : migration,
    );

    const failure = await applyUpTo(crippled).then(
      () => null,
      (error: unknown) => error,
    );

    // Раннер оборачивает отказ своим текстом, а причина лежит в `cause`:
    // проверяется именно она — «миграция провалилась» сказало бы лишь то, что
    // что-то пошло не так.
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as { cause?: unknown }).cause)).toMatch(/ruleset_rules_rule_code_fkey/u);
  }, 120_000);
});

/**
 * Вырезать из миграции набора секцию досева определений.
 *
 * Границы — комментарий раздела и первый оператор снимка: разметка файла
 * порождается генератором и потому устойчива. Если она изменится, тест
 * перестанет вырезать секцию и первый же прогон это покажет — падения не
 * случится там, где оно обязано быть.
 */
function withoutDefinitionsSection(sql: string): string {
  const start = sql.indexOf('-- 0. Предусловие снимка');
  const end = sql.indexOf('-- 1. Версия');
  if (start < 0 || end < 0) {
    throw new Error('в миграции набора не найдена секция досева определений');
  }
  return sql.slice(0, start) + sql.slice(end);
}
