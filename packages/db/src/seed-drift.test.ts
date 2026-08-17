/**
 * Каталог видов ИД существует в двух представлениях: массивы `DOC_TYPES` и
 * `PAGE_ROLES` в packages/doc-types и строки миграции 0009. Расхождение между
 * ними — тихая ошибка: код классифицирует по одному набору типов, БД ссылается
 * внешними ключами на другой, и увидено это будет только на проде.
 *
 * Отсюда две проверки. Первая — на дрейф: закоммиченная миграция обязана
 * совпадать с тем, что `generateSeedSql()` выдаёт прямо сейчас. Вторая — на
 * применимость: сгенерированный SQL прогоняется на настоящем PostgreSQL
 * (pglite) поверх полной схемы 0001..0008, с её CHECK-ограничениями и внешними
 * ключами, а не поверх урезанных таблиц юнит-теста генератора.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import type { SqlExecutor } from '@id/migrator';
import { applyMigrations, checksumOf, loadMigrations } from '@id/migrator';
import { DOC_TYPES, PAGE_ROLES, generateSeedSql } from '@id/doc-types';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const SEED_FILE = '0009_seed_doc_types.sql';
const SEED_VERSION = '0009';

// Переводы строк нормализуются ровно как в checksumOf(): checkout с
// core.autocrlf=true иначе объявил бы дрейфом различие, которого в каталоге нет.
const committedSeed = readFileSync(join(MIGRATIONS_DIR, SEED_FILE), 'utf8').replace(/\r\n/gu, '\n');

/** Короткая подсказка вместо диффа на 75 КБ, который читать невозможно. */
function describeDrift(committed: string, current: string): string {
  const committedLines = committed.split('\n');
  const currentLines = current.split('\n');
  const at = committedLines.findIndex((line, index) => line !== currentLines[index]);
  const where =
    at === -1
      ? `файл обрывается: ${committedLines.length} строк против ${currentLines.length}`
      : `первое расхождение в строке ${at + 1}`;

  return `${SEED_FILE} разошёлся с каталогом (${where}). Перегенерируйте: pnpm seed:generate`;
}

describe('seed-миграция каталога не отстаёт от кода', () => {
  it('совпадает с текущим выводом generateSeedSql()', () => {
    const current = generateSeedSql();

    expect(checksumOf(committedSeed), describeDrift(committedSeed, current)).toBe(
      checksumOf(current),
    );
  });

  it('видна раннеру как миграция 0009 с той же контрольной суммой', () => {
    // loadMigrations попутно проверяет непрерывность нумерации с 0001:
    // seed, повисший в разрыве, до применения бы не дожил.
    const seed = loadMigrations(MIGRATIONS_DIR).find((mig) => mig.fileName === SEED_FILE);

    expect(seed?.version).toBe(SEED_VERSION);
    expect(seed?.checksum).toBe(checksumOf(generateSeedSql()));
  });
});

describe('применение миграций вместе с seed', () => {
  let db: TestDatabase;
  let versions: readonly string[];
  let applied: readonly string[];

  beforeAll(async () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    versions = migrations.map((mig) => mig.version);

    db = await createPgliteDatabase();
    ({ applied } = await applyMigrations(asExecutor(db), migrations));
  }, 300_000);

  afterAll(async () => {
    await db.close();
  });

  it('применяет всю цепочку, включая 0009', () => {
    expect(applied).toStrictEqual(versions);
    expect(versions).toContain(SEED_VERSION);
  });

  it('заполняет doc_types и page_roles ровно каталогом', async () => {
    const [docTypes] = await db.query<{ total: number; system: number }>(
      `SELECT count(*)::int AS total,
              (count(*) FILTER (WHERE is_system))::int AS system
         FROM doc_types`,
    );
    const [pageRoles] = await db.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM page_roles',
    );

    expect(docTypes?.total).toBe(DOC_TYPES.length);
    expect(pageRoles?.total).toBe(PAGE_ROLES.length);
    // Совпадение счёта ничего не стоило бы, окажись часть строк заведена не
    // seed'ом: владение строкой обозначает именно is_system.
    expect(docTypes?.system).toBe(DOC_TYPES.length);
  });
}); /**
 * TestDatabase реализует SqlExecutor целиком: query для параметризованных
 * запросов и exec для многооператорного тела миграции. Транспортная разница
 * между node-postgres и PGlite закрыта в самом интерфейсе раннера, поэтому на
 * прод уезжает ровно тот код, который проверен здесь.
 */
function asExecutor(db: TestDatabase): SqlExecutor {
  return db;
}

describe('применение миграций вместе с seed', () => {
  let db: TestDatabase;
  let versions: readonly string[];
  let applied: readonly string[];

  beforeAll(async () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    versions = migrations.map((mig) => mig.version);

    db = await createPgliteDatabase();
    ({ applied } = await applyMigrations(asExecutor(db), migrations));
  }, 300_000);

  afterAll(async () => {
    await db.close();
  });

  it('применяет всю цепочку, включая 0009', () => {
    expect(applied).toStrictEqual(versions);
    expect(versions).toContain(SEED_VERSION);
  });

  it('заполняет doc_types и page_roles ровно каталогом', async () => {
    const [docTypes] = await db.query<{ total: number; system: number }>(
      `SELECT count(*)::int AS total,
              (count(*) FILTER (WHERE is_system))::int AS system
         FROM doc_types`,
    );
    const [pageRoles] = await db.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM page_roles',
    );

    expect(docTypes?.total).toBe(DOC_TYPES.length);
    expect(pageRoles?.total).toBe(PAGE_ROLES.length);
    // Совпадение счёта ничего не стоило бы, окажись часть строк заведена не
    // seed'ом: владение строкой обозначает именно is_system.
    expect(docTypes?.system).toBe(DOC_TYPES.length);
  });
});
