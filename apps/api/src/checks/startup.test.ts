/**
 * Сверка реестра правил при старте: обе стороны расхождения (§9.6, S58).
 *
 * Проверяется поведение на НАСТОЯЩИХ миграциях, а не на выдуманной таблице:
 * ровно те строки, что кладёт партия сида, и ровно тот каталог, из которого
 * портал их досевает. Оба состояния воспроизводят боевые:
 *
 * - определений нет, а реализации есть — так выглядела боевая база 8 сентября,
 *   когда пять определений и пять строк опубликованного снимка были удалены
 *   вне портала, и api с воркером ушли в цикл перезапусков;
 * - определение есть, реализации нет — так выглядит база, ушедшая вперёд кода,
 *   то есть процесс старее схемы.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { applyMigrations, loadMigrations } from '@id/migrator';
import { RuleRegistryError } from '@id/rules';

import type { Database } from '../db/repositories/users.js';
import { assertRuleRegistryConsistent } from './startup.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

/** Правило описи: его определение и удаляется в первом сценарии. */
// Действующее правило: пропажа СНЯТОГО кода расхождением не считается (S59),
// и досевать его портал не стал бы.
const VICTIM = 'REG.112';

let db: TestDatabase;
let orm: Database;

interface Recorded {
  readonly level: 'error' | 'warn' | 'info';
  readonly details: Record<string, unknown>;
}

function recorder(): {
  entries: Recorded[];
  logger: Parameters<typeof assertRuleRegistryConsistent>[1];
} {
  const entries: Recorded[] = [];
  return {
    entries,
    logger: {
      error: (details) => entries.push({ level: 'error', details }),
      warn: (details) => entries.push({ level: 'warn', details }),
      info: (details) => entries.push({ level: 'info', details }),
    },
  };
}

async function codes(): Promise<string[]> {
  const rows = await db.query<{ code: string }>(`SELECT code FROM rule_definitions ORDER BY code`);
  return rows.map((row) => row.code);
}

/**
 * Удаление определения так, как это произошло на бою.
 *
 * Сначала строки снимков, иначе не пустит внешний ключ, и с выключенными
 * триггерами: снимок опубликованного набора заперт (`ruleset_rules_published_immutable`),
 * и портал такого сделать НЕ МОЖЕТ — это и есть смысл теста. Триггеры
 * возвращаются на место сразу же: следующий сценарий обязан идти по обычным
 * правилам.
 */
async function deleteDefinition(code: string): Promise<void> {
  await db.query(`ALTER TABLE ruleset_rules DISABLE TRIGGER USER`);
  await db.query(`DELETE FROM ruleset_rules WHERE rule_code = '${code}'`);
  await db.query(`ALTER TABLE ruleset_rules ENABLE TRIGGER USER`);
  await db.query(`DELETE FROM rule_definitions WHERE code = '${code}'`);
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));
  orm = drizzle(createTestPool(db) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await db.close();
});

describe('запись реестра пропала, а реализация есть', () => {
  it('портал досевает определение из каталога и поднимается', async () => {
    await deleteDefinition(VICTIM);
    expect(await codes()).not.toContain(VICTIM);

    const { entries, logger } = recorder();
    await expect(assertRuleRegistryConsistent(orm, logger)).resolves.toBeUndefined();

    // Строка вернулась целиком, а не одним кодом: заголовок и тяжесть берутся
    // из каталога — иначе досев чинил бы сверку, оставляя реестр непригодным
    // для профиля и отчёта.
    const restored = await db.query<{
      title: string;
      level: string;
      kind: string;
      default_severity: string;
      waiver_roles: string[];
    }>(
      `SELECT title, level, kind, default_severity, waiver_roles
         FROM rule_definitions WHERE code = '${VICTIM}'`,
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]?.title).not.toBe('');
    expect(restored[0]?.level).toBe('folder');
    expect(restored[0]?.kind).toBe('registry');
    expect(restored[0]?.waiver_roles).toContain('engineer');

    // Пропажа осталась ВИДНОЙ: без строки журнала самолечение превратило бы
    // регулярное исчезновение строк в тишину.
    const backfilled = entries.find(
      (entry) => entry.details['event'] === 'rule_registry_backfilled',
    );
    expect(backfilled?.level).toBe('warn');
    expect(backfilled?.details['codes']).toEqual([VICTIM]);
    expect(backfilled?.details['restored']).toBe(1);
  });

  it('повторный старт проходит молча: досевать больше нечего', async () => {
    const { entries, logger } = recorder();
    await expect(assertRuleRegistryConsistent(orm, logger)).resolves.toBeUndefined();
    expect(entries.some((entry) => entry.details['event'] === 'rule_registry_backfilled')).toBe(
      false,
    );
    expect(entries.some((entry) => entry.details['event'] === 'rule_registry_ok')).toBe(true);
  });
});

describe('запись есть, реализации нет', () => {
  it('старт отказывает: досевать нечего, а молча не исполнять правило нельзя', async () => {
    await db.query(
      `INSERT INTO rule_definitions (code, title, level, kind, default_severity)
         VALUES ('PHANTOM.999', 'Правило без реализации', 'document', 'header', 'error')`,
    );

    const { entries, logger } = recorder();
    await expect(assertRuleRegistryConsistent(orm, logger)).rejects.toBeInstanceOf(
      RuleRegistryError,
    );

    const mismatch = entries.find((entry) => entry.details['event'] === 'rule_registry_mismatch');
    expect(mismatch?.level).toBe('error');
    expect(mismatch?.details['missingImplementations']).toEqual(['PHANTOM.999']);

    await db.query(`DELETE FROM rule_definitions WHERE code = 'PHANTOM.999'`);
  });
});
