/**
 * Задача разбора справочника на настоящей БД и настоящем хранилище.
 *
 * Проверяется то, чего не видит тест маршрутов: обработчик сам читает объект из
 * хранилища, сам решает, что делать с нечитаемым файлом, и сам переводит импорт
 * в конечное состояние. Ключевое утверждение — **отказ разбора не является
 * падением задачи**: файл между попытками не изменится, и три повтора дали бы
 * три одинаковые записи в журнале ошибок вместо одного внятного состояния.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import {
  buildXlsx,
  createDatabase,
  createLogger,
  createMetrics,
  createStorage,
  loadEnv,
  type Database,
  type JobContext,
  type StorageProvider,
} from '@id/api';

import { createCatalogImportParseHandler } from './catalog-import.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
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
const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-import-worker-'));

let db: TestDatabase;
let drizzle: Database;
let storage: StorageProvider;

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  await db.query(
    `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER}', 'kc-import', 'Администратор')`,
  );
  drizzle = createDatabase(createTestPool(db) as unknown as Pool);
  storage = createStorage(
    loadEnv({
      NODE_ENV: 'test',
      PUBLIC_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://pglite/id-portal-tests',
      AUTH_MODE: 'dev-stub',
      CSRF_SECRET: 'csrf-secret-of-import-worker-0123456789',
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: STORAGE_DIR,
      AUDIT_HMAC_KEY: 'audit-hmac-key-of-import-worker',
    }),
    {
      metrics: createMetrics({ enabled: false, service: 'import-worker-test' }),
      logger: createLogger({ service: 'import-worker-test', level: 'silent', env: 'test' }),
    },
  );
}, 180_000);

afterAll(async () => {
  await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

/** Контекст задачи: обработчику из него нужны только payload и логгер. */
function context(importId: string): JobContext<'catalog.import.parse'> {
  return {
    jobId: id(900),
    type: 'catalog.import.parse',
    attempt: 1,
    maxAttempts: 2,
    revisionId: null,
    payload: { importId },
    db: drizzle,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => context(importId).logger,
    },
    signal: new AbortController().signal,
    enqueue: () => Promise.resolve({ jobId: 'job', created: true }),
    emit: () => Promise.resolve(),
  } as unknown as JobContext<'catalog.import.parse'>;
}

/** Импорт в состоянии `parsing` с уже положенным в хранилище файлом. */
async function stage(target: string, bytes: Buffer): Promise<string> {
  const key = `uploads/${randomUUID()}`;
  await storage.putObject({ key, body: bytes, contentType: 'application/octet-stream' });

  const rows = await db.query<{ id: string }>(
    `INSERT INTO catalog_imports (target, status, file_name, s3_key, created_by, expires_at)
     VALUES ('${target}', 'parsing', 'catalog.xlsx', '${key}', '${USER}', now() + interval '7 days')
     RETURNING id`,
  );
  const importId = rows[0]?.id;
  if (importId === undefined) throw new Error('импорт не создан');
  return importId;
}

async function statusOf(
  importId: string,
): Promise<{ status: string; reason: string | null; rows: number }> {
  const rows = await db.query<{ status: string; failure_reason: string | null; row_count: number }>(
    `SELECT status, failure_reason, row_count FROM catalog_imports WHERE id = '${importId}'`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('импорт не найден');
  return { status: row.status, reason: row.failure_reason, rows: Number(row.row_count) };
}

describe('задача разбора справочника', () => {
  it('разбирает книгу и переводит импорт в готовность', async () => {
    const book = await buildXlsx('Контрагенты', [
      ['Наименование', 'Вид', 'ИНН'],
      ['ООО «Первая»', 'contractor', '7700123459'],
      ['ООО «Вторая»', 'laboratory', ''],
    ]);
    const importId = await stage('counterparties', book);

    await createCatalogImportParseHandler({ db: drizzle, storage })(context(importId));

    expect(await statusOf(importId)).toMatchObject({ status: 'ready', rows: 2 });
    const saved = await db.query<{ verdict: string }>(
      `SELECT verdict FROM catalog_import_rows WHERE import_id = '${importId}' ORDER BY row_no`,
    );
    expect(saved.map((r) => r.verdict)).toEqual(['create', 'create']);
  });

  it('нечитаемый файл переводит импорт в failed и НЕ бросает', async () => {
    const importId = await stage('counterparties', Buffer.from('не книга'));

    // Именно «не бросает» здесь и проверяется: иначе задача ушла бы на вторую
    // попытку читать тот же байт-в-байт файл.
    await expect(
      createCatalogImportParseHandler({ db: drizzle, storage })(context(importId)),
    ).resolves.toBeUndefined();

    const state = await statusOf(importId);
    expect(state.status).toBe('failed');
    expect(state.reason).toContain('не читается как книга Excel');
  });

  it('неопознанная колонка тоже даёт failed с причиной для человека', async () => {
    const book = await buildXlsx('Контрагенты', [
      ['Наименование', 'Вид', 'Телефон'],
      ['ООО «Лишняя графа»', 'contractor', '+7'],
    ]);
    const importId = await stage('counterparties', book);

    await createCatalogImportParseHandler({ db: drizzle, storage })(context(importId));

    const state = await statusOf(importId);
    expect(state.status).toBe('failed');
    expect(state.reason).toContain('«Телефон»');
  });

  it('повторная попытка после успеха ничего не переписывает', async () => {
    const book = await buildXlsx('Контрагенты', [
      ['Наименование', 'Вид'],
      ['ООО «Идемпотентность»', 'contractor'],
    ]);
    const importId = await stage('counterparties', book);
    const handler = createCatalogImportParseHandler({ db: drizzle, storage });

    await handler(context(importId));
    await handler(context(importId));

    // Очередь гарантирует at-least-once, поэтому второй прогон обязан быть
    // безвредным: импорт уже `ready`, и обработчик выходит, не тронув строки.
    expect(await statusOf(importId)).toMatchObject({ status: 'ready', rows: 1 });
  });
});
