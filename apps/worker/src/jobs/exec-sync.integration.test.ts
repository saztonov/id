/**
 * Сквозной прогон снимка исполнительной документации: очередь → воркер →
 * RD WEB → БД, на настоящей PostgreSQL (pglite) и настоящем HTTP-двойнике.
 *
 * Предмет — чек-лист приёмки §16 контракта, и проверяются ПОСЛЕДСТВИЯ В БАЗЕ, а
 * не ответы двойника: строка `block_results` на каждый блок, переведённый
 * указатель `current_block_result`, текст страницы, канонический артефакт и
 * счётчики прогона. Двойник при этом не мягче оригинала: он пересчитывает
 * присланный `manifest_sha256` и отвергает расхождение.
 *
 * Главный собственный пункт — последний: повторный прогон по неизменившемуся
 * снимку обязан дать полный результат БЕЗ единого распознавания. Это и есть
 * экономическая выгода контракта, и держится она целиком на реестре внешних
 * идентификаторов.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { startFakeExecSync, type FakeExecSync } from '@id/fake-rdweb-exec';
import {
  createExecSync,
  createLogger,
  createMetrics,
  createStorage,
  DbProcessingFeedbackSink,
  dedupeKeyFor,
  enqueueSystemJob,
  JobRunner,
  listLayoutBlocks,
  loadEnv,
  NoopErrorReporter,
  startRecognitionRun,
  type AuthScope,
  type Database,
  type ExecSyncPort,
  type Metrics,
  type SqlExecutor,
  type StorageProvider,
} from '@id/api';

import { createWorkerRegistry } from './pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-exec-sync-'));

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const OBJECT = id(1);
const ORG = id(2);
const USER = id(3);
const FOLDER = id(5);
const FILE = id(6);
const BUNDLE = id(7);
const LAYOUT = id(8);
const PAGE_COUNT = 2;
const PROJECT = 'idp-object-1';
const TOKEN = 'rdext_integration_secret';

const SCOPE: AuthScope = { kind: 'admin', userId: USER };

let testDb: TestDatabase;
let db: Database;
let storage: StorageProvider;
let metrics: Metrics;
let runner: JobRunner;
let fake: FakeExecSync;
let port: ExecSyncPort;
let workingSha = '';
const logSink: string[] = [];

/** Настоящий PDF: сборка рабочего документа его действительно читает. */
async function buildPdf(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < PAGE_COUNT; page += 1) {
    const created = doc.addPage([595, 842]);
    created.drawText(`List ${String(page + 1)}`, { x: 40, y: 780, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

/**
 * Разбор очереди с прокруткой времени вперёд.
 *
 * Отсрочка (`JobDeferredError`) переносит задачу на `DEFERRAL_BACKOFF` — пять
 * секунд и далее по экспоненте. Простой цикл `runOnce()` увидел бы пустую
 * очередь и решил, что работа кончилась, — то есть тест молча проверял бы
 * половину цепочки. Поэтому, когда взять нечего, отложенные задачи двигаются в
 * настоящее: это моделирует прошедшее время, а не обходит механизм.
 */
async function drainQueue(limit = 400): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    const claimed = await runner.runOnce();
    if (claimed > 0) continue;

    const pending = await testDb.query<{ count: string }>(
      `SELECT count(*) AS count FROM jobs WHERE status = 'queued' AND next_run_at > now()`,
    );
    if (Number(pending[0]?.count ?? 0) === 0) return;
    await testDb.query(`UPDATE jobs SET next_run_at = now() WHERE status = 'queued'`);
  }
  throw new Error('очередь не разошлась за отведённое число шагов');
}

async function insertBlock(blockId: string, page: number, rect: string): Promise<void> {
  await testDb.query(
    `INSERT INTO layout_blocks
       (id, layout_revision_id, folder_id, bundle_id, source_page_id, working_page_index,
        object_id, block_type, shape_type, x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${blockId}', '${LAYOUT}', '${FOLDER}', '${BUNDLE}', '${id(100 + page)}', ${page},
             '${OBJECT}', 'text', 'rectangle', ${rect}, 0, 'auto', 'rf_detr')`,
  );
}

async function startRun(): Promise<string> {
  const blocks = await listLayoutBlocks(db, SCOPE, LAYOUT);
  expect(blocks.length).toBeGreaterThan(0);
  const { run } = await startRecognitionRun(db, SCOPE, {
    layoutRevisionId: LAYOUT,
    requireRdDocument: false,
    settingsSnapshot: {
      version: 3,
      provider: 'rdweb',
      contract: 'rdweb.executive_document_snapshot.v1',
      externalProjectId: PROJECT,
      model: null,
      dryRun: false,
    },
  });
  await enqueueSystemJob(db, {
    type: 'rd.sync_prepare',
    payload: { folderId: FOLDER, recognitionRunId: run.id },
    dedupeKey: dedupeKeyFor('rd.sync_prepare', run.id),
  });
  return run.id;
}

async function countOf(table: string, runId: string): Promise<number> {
  const rows = await testDb.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${table} WHERE recognition_run_id = '${runId}'`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function runOutcome(
  runId: string,
): Promise<{ status: string; counts: Record<string, unknown> }> {
  const rows = await testDb.query<{ status: string; counts: Record<string, unknown> }>(
    `SELECT status, counts FROM recognition_runs WHERE id = '${runId}'`,
  );
  return { status: rows[0]?.status ?? '', counts: rows[0]?.counts ?? {} };
}

/** Прогон возвращается в очередь как новый: у каждого сценария своя отправка. */
async function resetRun(runId: string): Promise<void> {
  await testDb.query(
    `UPDATE recognition_runs SET status = 'done', finished_at = now() WHERE id = '${runId}'`,
  );
}

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const content = await buildPdf();
  workingSha = createHash('sha256').update(content).digest('hex');

  const fixture: readonly string[] = [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'EX01', 'Корпус 1', 'ЖК «Снимок», корпус 1')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER}', 'kc-exec-e2e', 'Инженер', '${ORG}')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG}') ON CONFLICT DO NOTHING`,
    `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER}', '${OBJECT}', '${ORG}', '${ORG}', 'roofing', DATE '2026-01-01',
             'Кровля автостоянки', '${USER}')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${workingSha}', 'blobs/${workingSha}', ${content.byteLength}, 'application/pdf')`,
    `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE}', '${FOLDER}', '${workingSha}', 'комплект.pdf', 0, 'ok')`,
    `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE}', '${FOLDER}', '${'b'.repeat(64)}', '${workingSha}', 'bundle/1+pdf-lib')`,
    `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no, state)
       VALUES ('${LAYOUT}', '${FOLDER}', '${OBJECT}', '${BUNDLE}', 1, 'draft')`,
  ];
  for (const statement of fixture) await testDb.query(statement);

  for (let page = 0; page < PAGE_COUNT; page += 1) {
    await testDb.query(
      `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
         VALUES ('${id(100 + page)}', '${FOLDER}', '${FILE}', ${page}, ${page}, 1654, 2339, 0)`,
    );
    await testDb.query(
      `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
         VALUES ('${BUNDLE}', '${FOLDER}', ${page}, '${id(100 + page)}')`,
    );
  }

  await insertBlock(id(200), 0, '0.10, 0.10, 0.90, 0.40');
  await insertBlock(id(201), 1, '0.10, 0.50, 0.90, 0.80');

  db = drizzle(createTestPool(testDb) as unknown as Pool);
  fake = await startFakeExecSync({ token: TOKEN, projects: [PROJECT], pollsBeforeTerminal: 3 });

  const TEST_ENV = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'dev-stub',
    CSRF_SECRET: 'csrf-secret-of-exec-sync-tests-0123456',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-exec-sync-tests',
    RDWEB_EXEC_BASE_URL: fake.url,
    RDWEB_EXEC_TOKEN: TOKEN,
    RDWEB_EXEC_PROJECT_ID: PROJECT,
  });

  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logSink.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({
    service: 'exec-sync-e2e',
    level: 'trace',
    env: 'test',
    destination,
  });
  metrics = createMetrics({ enabled: false, service: 'exec-sync-e2e' });
  storage = createStorage(TEST_ENV, { metrics, logger });

  const key = `blobs/${workingSha.slice(0, 2)}/${workingSha.slice(2, 4)}/${workingSha}`;
  const target = join(STORAGE_DIR, key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);

  const created = createExecSync(TEST_ENV, { metrics, logger });
  expect(created).not.toBeNull();
  port = created as ExecSyncPort;

  runner = new JobRunner({
    db,
    registry: createWorkerRegistry({
      db,
      storage,
      toolkit: { kind: 'pdf-lib', version: null } as never,
      limits: { maxBytes: TEST_ENV.MAX_UPLOAD_BYTES, maxPages: TEST_ENV.MAX_PAGES_PER_FILE },
      workDirBase: STORAGE_DIR,
      feedback: new DbProcessingFeedbackSink({
        sql: createTestPool(testDb) as unknown as SqlExecutor,
        logger,
      }),
      execSync: port,
      execProjectId: PROJECT,
      // Поллинг ускоряется, но остаётся поллингом: двойник отвечает
      // нетерминальным на первое обращение, и путь «ещё идёт» проходится
      // по-настоящему, вместе с исходом `deferred`.
      pollExecSync: { pollsPerAttempt: 1, pollIntervalMs: 5 },
    }),
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-exec-sync-e2e',
  });
}, 300_000);

afterAll(async () => {
  await runner.stop();
  await fake.close();
  await testDb.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe('первая отправка проходит целиком (§16 п. 3)', () => {
  let runId = '';

  beforeAll(async () => {
    runId = await startRun();
    await drainQueue();
  }, 180_000);

  it('прогон завершён и опубликован', async () => {
    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('done');
    expect(outcome.counts['blocksExpected']).toBe(2);
    expect(outcome.counts['blocksCovered']).toBe(2);
  });

  it('на каждый блок есть результат и переведён указатель', async () => {
    expect(await countOf('block_results', runId)).toBe(2);
    const pointers = await testDb.query<{ count: string }>(
      `SELECT count(*) AS count FROM current_block_result c
         JOIN block_results r ON r.id = c.block_result_id
        WHERE r.recognition_run_id = '${runId}'`,
    );
    expect(Number(pointers[0]?.count)).toBe(2);
  });

  it('текст страниц записан вместе с версией рендера', async () => {
    const rows = await testDb.query<{ render_version: string; text_md: string }>(
      `SELECT render_version, text_md FROM page_text_versions WHERE recognition_run_id = '${runId}'`,
    );
    expect(rows.length).toBe(2);
    expect(rows[0]?.render_version).toBe('recognition.page_text.v2');
    expect(rows[0]?.text_md.length).toBeGreaterThan(0);
  });

  it('канонический артефакт записан и назван нашим адаптером', async () => {
    const rows = await testDb.query<{ kind: string }>(
      `SELECT kind FROM artifact_versions WHERE recognition_run_id = '${runId}'`,
    );
    expect(rows.map((row) => row.kind)).toEqual(['canonical']);
  });

  it('опрос прошёл через исход deferred, а не через отказ', async () => {
    const rows = await testDb.query<{ outcome: string }>(
      `SELECT outcome FROM job_runs WHERE job_type = 'rd.sync_poll' ORDER BY started_at`,
    );
    expect(rows.some((row) => row.outcome === 'deferred')).toBe(true);
    expect(rows.some((row) => row.outcome === 'failed')).toBe(false);
  });

  it('ни одна задача цепочки не упала', async () => {
    const failed = await testDb.query<{ job_type: string; error_message: string | null }>(
      `SELECT job_type, error_message FROM job_runs
        WHERE job_type LIKE 'rd.sync_%' AND outcome NOT IN ('succeeded', 'deferred')`,
    );
    expect(failed).toEqual([]);
  });

  it('удостоверение не встречается в журнале ни разу', () => {
    // Прогон идёт на уровне trace: если токен куда-то просачивается, он тут.
    expect(logSink.join('\n')).not.toContain(TOKEN);
  });

  it('сквозной request_id доехал до двойника', () => {
    const withId = fake.calls.filter((call) => call.requestId !== null);
    expect(withId.length).toBeGreaterThan(0);
  });
});

describe('повтор по неизменившемуся снимку не платит за распознавание', () => {
  it('все блоки объявлены unchanged, и результат всё равно полон (§16 п. 6)', async () => {
    const first = fake.snapshot().documents[0];
    expect(first?.blocks.every((block) => block.action === 'recognition_required')).toBe(true);

    const runId = await startRun();
    await drainQueue();

    expect((await runOutcome(runId)).status).toBe('done');
    const after = fake.snapshot().documents[0];
    // Ни один блок не потребовал распознавания: реестр узнал их по геометрии.
    expect(after?.blocks.every((block) => block.action === 'unchanged')).toBe(true);
    // При этом результат полон: unchanged-блоки отдают прежний текст.
    expect(await countOf('block_results', runId)).toBe(2);
    await resetRun(runId);
  }, 180_000);
});

describe('правка одной рамки перераспознаёт только её (§16 п. 7)', () => {
  it('второй блок остаётся unchanged', async () => {
    await testDb.query(`UPDATE layout_blocks SET y1 = 0.45 WHERE id = '${id(200)}'`);

    const runId = await startRun();
    await drainQueue();
    expect((await runOutcome(runId)).status).toBe('done');

    const blocks = fake.snapshot().documents[0]?.blocks ?? [];
    const actions = new Map(blocks.map((block) => [block.externalBlockId, block.action]));
    expect(
      [...actions.values()].filter((action) => action === 'recognition_required'),
    ).toHaveLength(1);
    expect([...actions.values()].filter((action) => action === 'unchanged')).toHaveLength(1);
    await resetRun(runId);
  }, 180_000);
});

describe('suspicious публикуется, но успехом не считается (§16 п. 14)', () => {
  it('текст записан, страница помечена непригодным блоком, есть след в обратной связи', async () => {
    const target = fake.snapshot().documents[0]?.blocks[0]?.externalBlockId ?? '';
    expect(target).not.toBe('');
    fake.setFaults({ suspiciousBlocks: [target] });
    // Рамку двигаем, иначе блок останется `unchanged` и распознан не будет.
    await testDb.query(`UPDATE layout_blocks SET y1 = 0.48 WHERE id = '${id(200)}'`);

    const runId = await startRun();
    await drainQueue();

    expect((await runOutcome(runId)).status).toBe('done');
    // Текст опубликован: потерять распознанное хуже, чем показать с пометкой.
    expect(await countOf('block_results', runId)).toBe(2);

    const pages = await testDb.query<{ blocks_invalid: number }>(
      `SELECT blocks_invalid FROM recognition_run_pages
        WHERE recognition_run_id = '${runId}' AND blocks_invalid > 0`,
    );
    expect(pages.length).toBe(1);

    const feedback = await testDb.query<{ reason_code: string }>(
      `SELECT reason_code FROM processing_feedback WHERE recognition_run_id = '${runId}'`,
    );
    expect(feedback.map((row) => row.reason_code)).toContain('rdweb.suspicious');

    fake.setFaults({ suspiciousBlocks: [] });
    await resetRun(runId);
  }, 180_000);
});

describe('вытеснение не публикуется (§16 п. 10)', () => {
  it('superseded закрывает прогон без текста страниц и с внятной причиной', async () => {
    fake.setFaults({ supersedeNext: true });
    await testDb.query(`UPDATE layout_blocks SET y1 = 0.52 WHERE id = '${id(200)}'`);

    const runId = await startRun();
    await drainQueue();

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('failed');
    expect(await countOf('page_text_versions', runId)).toBe(0);

    const warnings = await testDb.query<{ warnings: { code: string }[] }>(
      `SELECT warnings FROM recognition_runs WHERE id = '${runId}'`,
    );
    expect(warnings[0]?.warnings.map((warning) => warning.code)).toContain('superseded');
  }, 180_000);
});
