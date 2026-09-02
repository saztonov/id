/**
 * Уборка отработавших сессий.
 *
 * Проверяется на настоящей схеме (pglite под миграциями проекта), а не на
 * подменном исполнителе: весь смысл функции — в условии отбора строк и в
 * advisory-блокировке, то есть ровно в том, чего выдуманная БД не воспроизводит.
 *
 * Дефект, который эти тесты держат: уборка не должна трогать живые сессии.
 * Ошибка в знаке сравнения или в единице интервала выносила бы из-под ног
 * работающих людей их сессии — то есть чинила бы разлогин разлогином.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { pruneExpiredSessions } from './auth-sessions.js';
import type { Database } from './users.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const USER = id(1);
const LONG_GONE = id(10);
const RECENTLY_ENDED = id(11);
const ALIVE = id(12);
const REVOKED_BUT_FRESH = id(13);

let testDb: TestDatabase;
let db: Database;

/** Строка сессии: конверт и хэш здесь не важны, важны сроки. */
async function insertSession(sessionId: string, endedAgo: string, revoked: boolean): Promise<void> {
  await testDb.query(
    `INSERT INTO auth_sessions
       (id, user_id, auth_mode, refresh_envelope, key_version, csrf_hash,
        idle_expires_at, absolute_expires_at, revoked_at)
     VALUES ($1, $2, 'local', '\\x00'::bytea, 1, 'hash',
             now() - interval '${endedAgo}', now() - interval '${endedAgo}',
             ${revoked ? 'now()' : 'NULL'})`,
    [sessionId, USER],
  );
}

async function survivors(): Promise<string[]> {
  const rows = await testDb.query<{ id: string }>('SELECT id FROM auth_sessions ORDER BY id');
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }
  await testDb.query(
    `INSERT INTO users (id, kc_sub, full_name) VALUES ($1, 'kc-prune', 'Сотрудник')`,
    [USER],
  );

  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.query('DELETE FROM auth_sessions');
  await insertSession(LONG_GONE, '90 days', false);
  await insertSession(RECENTLY_ENDED, '3 days', false);
  await insertSession(REVOKED_BUT_FRESH, '3 days', true);
  // Живая: срок в будущем, поэтому интервал вычитается со знаком минус.
  await insertSession(ALIVE, '-30 days', false);
});

describe('pruneExpiredSessions', () => {
  it('удаляет только строки за порогом хранения', async () => {
    const result = await pruneExpiredSessions(db, { retentionDays: 30 });

    expect(result).toStrictEqual({ deleted: 1, locked: true });
    expect(await survivors()).toStrictEqual([RECENTLY_ENDED, REVOKED_BUT_FRESH, ALIVE].sort());
  });

  it('не трогает живую сессию, каким бы коротким ни был срок хранения', async () => {
    // Порог в один день: всё, что кончилось, уходит. Живая сессия обязана
    // остаться — её `absolute_expires_at` ещё в будущем, и никакая арифметика
    // срока хранения не должна этого перевесить.
    await pruneExpiredSessions(db, { retentionDays: 1 });

    expect(await survivors()).toStrictEqual([ALIVE]);
  });

  it('отозванная сессия убирается по тому же сроку, что и истёкшая', async () => {
    // Отдельной политики для отозванных нет намеренно: строка доживает до
    // своего абсолютного срока и уходит вместе с остальными.
    await testDb.query('DELETE FROM auth_sessions');
    await insertSession(REVOKED_BUT_FRESH, '90 days', true);

    const result = await pruneExpiredSessions(db, { retentionDays: 30 });

    expect(result.deleted).toBe(1);
    expect(await survivors()).toStrictEqual([]);
  });

  it('удаляет хвост длиннее одного пакета', async () => {
    // Цикл по пакетам обязан доходить до конца: остановка после первого пакета
    // означала бы, что таблица растёт быстрее, чем чистится.
    await testDb.query('DELETE FROM auth_sessions');
    for (let n = 0; n < 5; n += 1) await insertSession(id(100 + n), '90 days', false);

    const result = await pruneExpiredSessions(db, { retentionDays: 30, batchSize: 2 });

    expect(result.deleted).toBe(5);
    expect(await survivors()).toStrictEqual([]);
  });
});
