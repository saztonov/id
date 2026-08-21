/**
 * Счётчики значимых отказов и медленных операций (§11, поток B).
 *
 * Проверяется ровно то, ради чего эти счётчики устроены агрегатами:
 *
 * 1. **Тысяча отказов — одна строка.** Иначе перебор паролей писал бы в базу с
 *    частотой своих попыток, и наблюдаемость стала бы усилителем атаки.
 * 2. **Сумма и максимум складываются правильно** — среднее по произвольному
 *    периоду считается из суммы, и ошибка здесь незаметна на глаз.
 * 3. **Переполнение считается, а не замалчивается**: всплеск уникальных
 *    маршрутов не должен ни съедать память, ни исчезать бесследно.
 * 4. **Свои запросы помечены** — иначе запись статистики порождает статистику
 *    о себе.
 */
import { Writable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import { applyMigrations, loadMigrations } from '@id/migrator';

import { AnomalyWriter, OBSERVABILITY_SQL_MARKER, WATCHED_CLIENT_STATUSES } from './anomalies.js';
import { createLogger, type AppLogger } from './logger.js';
import type { SqlExecutor } from './errors.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

let db: TestDatabase;
let logger: AppLogger;
let logLines: Record<string, unknown>[] = [];
let queries = 0;
/** Тексты выполненных запросов: по ним проверяется пометка своих операторов. */
let statements: string[] = [];

function asSqlExecutor(source: TestDatabase): SqlExecutor {
  return {
    async query(text: string, values?: readonly unknown[]) {
      queries += 1;
      statements.push(text);
      return { rows: await source.query(text, values as unknown[] | undefined) };
    },
  };
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      callback();
    },
  });
  logger = createLogger({ service: 'api-test', level: 'trace', destination });
}, 300_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('delete from http_anomaly_stats_hourly');
  await db.query('delete from slow_operations');
  logLines = [];
  statements = [];
  queries = 0;
});

function newWriter(overrides: Partial<ConstructorParameters<typeof AnomalyWriter>[0]> = {}) {
  return new AnomalyWriter({ sql: asSqlExecutor(db), logger, ...overrides });
}

describe('значимые отказы', () => {
  it('тысяча отказов складывается в одну строку', async () => {
    const writer = newWriter();
    for (let i = 0; i < 1_000; i += 1) {
      writer.recordAnomaly({
        route: 'POST /api/v1/auth/login',
        statusCode: 429,
        problemSlug: 'rate-limited',
      });
    }
    const before = queries;
    await writer.flush();

    expect(
      queries - before,
      'число обращений к БД растёт вместе с числом отказов: перебор паролей ' +
        'заставлял бы журнал писать с частотой своих попыток',
    ).toBeLessThan(5);

    const rows = await db.query<{ count: string }>(
      'select count::text as count from http_anomaly_stats_hourly',
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.count)).toBe(1_000);
  });

  it('разные маршруты и статусы не склеиваются', async () => {
    const writer = newWriter();
    writer.recordAnomaly({ route: 'GET /a', statusCode: 403, problemSlug: 'forbidden' });
    writer.recordAnomaly({ route: 'GET /a', statusCode: 401, problemSlug: 'unauthenticated' });
    writer.recordAnomaly({ route: 'GET /b', statusCode: 403, problemSlug: 'forbidden' });
    await writer.flush();

    const rows = await db.query<{ n: string }>(
      'select count(*)::text as n from http_anomaly_stats_hourly',
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it('перечень наблюдаемых статусов не пуст и не включает опечатки клиента', () => {
    expect(WATCHED_CLIENT_STATUSES.has(429)).toBe(true);
    expect(WATCHED_CLIENT_STATUSES.has(403)).toBe(true);
    expect(
      WATCHED_CLIENT_STATUSES.has(404),
      '404 попал в наблюдаемые: обращение к несуществующему пути — опечатка ' +
        'клиента или сканер, и накопление таких строк не отвечает ни на один вопрос',
    ).toBe(false);
    expect(WATCHED_CLIENT_STATUSES.has(422)).toBe(false);
  });
});

describe('медленные операции', () => {
  it('складывает сумму и берёт максимум', async () => {
    const writer = newWriter();
    for (const durationMs of [1_000, 3_000, 2_000]) {
      writer.recordSlow({
        kind: 'sql',
        target: 'SELECT ? FROM submissions',
        durationMs,
        thresholdMs: 300,
      });
    }
    await writer.flush();

    const [row] = await db.query<{ count: string; max_ms: number; sum_ms: string }>(
      'select count::text as count, max_ms, sum_ms::text as sum_ms from slow_operations',
    );
    expect(Number(row?.count)).toBe(3);
    expect(row?.max_ms).toBe(3_000);
    expect(
      Number(row?.sum_ms),
      'сумма не сходится: среднее по произвольному периоду считается из неё, и ' +
        'ошибка здесь на глаз незаметна',
    ).toBe(6_000);
  });

  it('повторный сброс наращивает, а не перезаписывает', async () => {
    const writer = newWriter();
    writer.recordSlow({ kind: 'http', target: 'GET /x', durationMs: 1_500, thresholdMs: 1_000 });
    await writer.flush();
    writer.recordSlow({ kind: 'http', target: 'GET /x', durationMs: 2_500, thresholdMs: 1_000 });
    await writer.flush();

    const [row] = await db.query<{ count: string; max_ms: number; sum_ms: string }>(
      'select count::text as count, max_ms, sum_ms::text as sum_ms from slow_operations',
    );
    expect(Number(row?.count)).toBe(2);
    expect(row?.max_ms).toBe(2_500);
    expect(Number(row?.sum_ms)).toBe(4_000);
  });
});

describe('устойчивость', () => {
  it('переполнение накопителя считается потерей', async () => {
    let dropped = 0;
    const writer = newWriter({
      maxGroups: 2,
      metrics: {
        observeJournalDropped(count) {
          dropped += count;
        },
      },
    });

    for (let i = 0; i < 10; i += 1) {
      writer.recordAnomaly({ route: `GET /path-${i}`, statusCode: 403, problemSlug: 'forbidden' });
    }
    await writer.flush();

    expect(
      dropped,
      'всплеск уникальных маршрутов исчез бесследно: сканер путей не должен ни ' +
        'съедать память процесса, ни оставаться незамеченным',
    ).toBe(8);
    expect(logLines.some((line) => line.event === 'anomaly_overflow')).toBe(true);
  });

  it('свои запросы помечены, чтобы не измерять самих себя', async () => {
    const writer = newWriter();
    writer.recordAnomaly({ route: 'GET /y', statusCode: 403, problemSlug: 'forbidden' });
    writer.recordSlow({ kind: 'sql', target: 'SELECT ?', durationMs: 500, thresholdMs: 300 });
    await writer.flush();

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(
        statement,
        'оператор накопителя не помечен: инструментирование пула снимет с него ' +
          'тайминги, и медленная запись статистики породит статистику о себе',
      ).toContain(OBSERVABILITY_SQL_MARKER);
    }
  });

  it('сбой записи не бросает наружу', async () => {
    const writer = new AnomalyWriter({
      sql: { query: () => Promise.reject(new Error('база недоступна')) },
      logger,
    });
    writer.recordAnomaly({ route: 'GET /z', statusCode: 403, problemSlug: 'forbidden' });

    await expect(writer.flush()).resolves.toBeUndefined();
    expect(logLines.some((line) => line.event === 'anomaly_write_failed')).toBe(true);
  });
});
