/**
 * Конвейер приёма целиком: очередь → воркер → база (§12, задачи 1–3).
 *
 * ## Зачем этот файл существует
 *
 * Прогон S5 показал отказ, который не ловился ничем: обработчики задач были
 * написаны, зарегистрированы и покрыты модульными тестами на подставных портах,
 * а связка «задача выполнилась → в базе что-то изменилось» не проверялась
 * нигде. В таком виде `file.verify` умел только падать (запись вердикта не была
 * подключена), а `bundle.build` оставлял в хранилище осиротевший рабочий PDF.
 * Модульные тесты при этом были зелёными: они проверяли обработчик, а не
 * последствия его работы.
 *
 * Поэтому здесь всё настоящее: PostgreSQL (pglite) под миграциями проекта,
 * файловое хранилище, настоящие PDF из синтетических фикстур S0, реестр задач
 * из `createWorkerRegistry()` — тот же, что собирает точка входа воркера, — и
 * `JobRunner.runOnce()`, то есть штатный захват задач из очереди. Ни один порт
 * не подменяется.
 *
 * Проверяется не «задача завершилась успехом», а результат в базе и в
 * хранилище: состояние файла, зонд подписи, страницы, рабочий документ и его
 * карта. Успешно завершившаяся задача, ничего не изменившая, — это ровно тот
 * отказ, ради которого файл написан.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import {
  createDatabase,
  createLogger,
  createMetrics,
  createPdfLibToolkit,
  createStorage,
  dedupeKeyFor,
  enqueueSystemJob,
  JobRunner,
  loadEnv,
  loadPdfLibModule,
  NoopErrorReporter,
  type Database,
  type PdfToolkit,
  type StorageProvider,
} from '@id/api';

import { createWorkerRegistry } from './pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const FIXTURES_DIR = join(ROOT, 'tools', 'fixtures', 'pdf');

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, `${name}.pdf`));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// =====================================================================
// Фикстура
// =====================================================================

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR = id(2);
const OBJECT = id(4);
const SUBMISSION = id(10);
const REVISION = id(11);
const USER_CONTRACTOR = id(20);
const FILE_A = id(30);
const FILE_B = id(31);

const CONTENT_A = fixture('multipage');
const CONTENT_B = fixture('single-1');
const SHA_A = sha256(CONTENT_A);
const SHA_B = sha256(CONTENT_B);

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-pipeline-e2e-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-pipeline-e2e-01234567890',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-pipeline-e2e',
});

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR}', 'kc-pipeline-contractor', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION}', '${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,

  // Файлы записаны БЕЗ состояния проверки и без страниц: колонка `verify_state`
  // имеет значение по умолчанию `pending`, и именно из него задача обязана
  // вывести файл. Раньше в этой ситуации она только падала.
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_A}', 'blobs/${SHA_A}', ${CONTENT_A.byteLength}, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_B}', 'blobs/${SHA_B}', ${CONTENT_B.byteLength}, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
     VALUES ('${FILE_A}', '${REVISION}', '${SHA_A}', 'АОСР.pdf', 0)`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
     VALUES ('${FILE_B}', '${REVISION}', '${SHA_B}', 'Сертификат.pdf', 1)`,
];

let testDb: TestDatabase;
let db: Database;
let storage: StorageProvider;
let toolkit: PdfToolkit;
let runner: JobRunner;

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }
  for (const statement of FIXTURE) {
    await testDb.query(statement);
  }

  db = createDatabase(createTestPool(testDb) as unknown as Pool);

  const logger = createLogger({ service: 'pipeline-e2e', level: 'silent', env: 'test' });
  const metrics = createMetrics({ enabled: false, service: 'pipeline-e2e' });
  storage = createStorage(TEST_ENV, { metrics, logger });

  // Байты кладутся в хранилище так же, как их туда кладёт приём: по ключу от
  // sha256. Задача читает именно объект хранилища, а не то, что ей передали.
  for (const [sha, content] of [
    [SHA_A, CONTENT_A],
    [SHA_B, CONTENT_B],
  ] as const) {
    const key = `blobs/${sha}`;
    const target = join(STORAGE_DIR, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  // qpdf на машине разработчика может отсутствовать (ADR-0003), поэтому здесь
  // намеренно берётся деградированная реализация: проверяется конвейер, а не
  // выбор инструмента.
  toolkit = createPdfLibToolkit(await loadPdfLibModule((specifier) => import(specifier)));

  runner = new JobRunner({
    db,
    registry: createWorkerRegistry({
      db,
      storage,
      toolkit,
      limits: { maxBytes: TEST_ENV.MAX_UPLOAD_BYTES, maxPages: TEST_ENV.MAX_PAGES_PER_FILE },
      workDirBase: STORAGE_DIR,
    }),
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-pipeline-e2e',
  });
}, 180_000);

afterAll(async () => {
  await runner.stop();
  await testDb.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

/** Гоняет очередь, пока в ней есть готовые к запуску задачи. */
async function drainQueue(maxRounds = 10): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    if ((await runner.runOnce()) === 0) return;
  }
  throw new Error('очередь не опустела за отведённое число проходов');
}

async function jobOutcomes(): Promise<Record<string, string>> {
  const rows = await testDb.query<{ job_type: string; outcome: string | null }>(
    `SELECT job_type, outcome FROM job_runs ORDER BY started_at`,
  );
  return Object.fromEntries(rows.map((row) => [row.job_type, row.outcome ?? 'in_flight']));
}

// =====================================================================
// Задачи 1–2: проверка файла и зонд подписи
// =====================================================================

describe('file.verify и file.signature_probe пишут состояние, а не только сверяют', () => {
  beforeAll(async () => {
    for (const fileId of [FILE_A, FILE_B]) {
      for (const type of ['file.verify', 'file.signature_probe'] as const) {
        await enqueueSystemJob(db, {
          type,
          payload: { revisionId: REVISION, sourceFileId: fileId },
          dedupeKey: dedupeKeyFor(type, fileId),
        });
      }
    }
    await drainQueue();
  }, 120_000);

  it('все четыре задачи завершились успехом', async () => {
    const outcomes = await jobOutcomes();
    expect(outcomes['file.verify']).toBe('succeeded');
    expect(outcomes['file.signature_probe']).toBe('succeeded');

    const failed = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(Number(failed[0]?.count ?? 0)).toBe(0);
  });

  it('состояние файла выведено из pending в ok самой задачей', async () => {
    const files = await testDb.query<{ id: string; verify_state: string; verify_error: string }>(
      `SELECT id, verify_state, verify_error FROM source_files ORDER BY sort_order`,
    );
    expect(files.map((file) => file.verify_state)).toEqual(['ok', 'ok']);
    expect(files.every((file) => file.verify_error === null)).toBe(true);
  });

  it('страницы записаны с геометрией и сплошными позициями ревизии', async () => {
    const pages = await testDb.query<{
      source_file_id: string;
      file_page_index: number;
      revision_ordinal: number;
      width_px: number;
      height_px: number;
    }>(
      `SELECT source_file_id, file_page_index, revision_ordinal, width_px, height_px
         FROM source_pages WHERE revision_id = '${REVISION}' ORDER BY revision_ordinal`,
    );

    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((page) => Number(page.revision_ordinal))).toEqual(
      pages.map((_, index) => index),
    );
    expect(pages.every((page) => Number(page.width_px) > 0 && Number(page.height_px) > 0)).toBe(
      true,
    );
  });

  it('зонд подписи записан в колонку, а не только в журнал', async () => {
    const rows = await testDb.query<{ signature_probe: { result: string; probedAt: string } }>(
      `SELECT signature_probe FROM source_files WHERE id = '${FILE_A}'`,
    );
    const probe = rows[0]?.signature_probe;
    expect(probe).not.toBeNull();
    // Тройное состояние (§0.1): «не найдено» — утверждение, а не «не смотрели».
    expect(['none_detected', 'detected_unverified', 'unknown']).toContain(probe?.result);
    expect(probe?.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('событие ревизии о проверке дошло до ленты', async () => {
    const events = await testDb.query<{ event_type: string }>(
      `SELECT event_type FROM revision_events WHERE revision_id = '${REVISION}' ORDER BY seq`,
    );
    expect(events.map((event) => event.event_type)).toContain('file.verified');
  });
});

// =====================================================================
// Задача 3: рабочий документ и карта страниц
// =====================================================================

describe('bundle.build собирает рабочий документ и его карту', () => {
  beforeAll(async () => {
    await enqueueSystemJob(db, {
      type: 'bundle.build',
      payload: { revisionId: REVISION },
      dedupeKey: dedupeKeyFor('bundle.build', REVISION),
    });
    await drainQueue();
  }, 120_000);

  it('рабочий документ записан вместе с блобом и версией сборщика', async () => {
    const bundles = await testDb.query<{
      id: string;
      working_pdf_blob_sha256: string;
      builder_version: string;
    }>(`SELECT id, working_pdf_blob_sha256, builder_version FROM processing_bundles`);

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.builder_version).toContain('bundle/1');

    // Блоб рабочего документа обязан существовать: bundle, ссылающийся на
    // отсутствующую строку, прошёл бы FK только при её наличии, но проверка
    // здесь именно на связность результата.
    const blob = await testDb.query<{ s3_key: string; size_bytes: string | number }>(
      `SELECT s3_key, size_bytes FROM stored_blobs WHERE sha256 = '${bundles[0]?.working_pdf_blob_sha256 ?? ''}'`,
    );
    expect(blob).toHaveLength(1);
    expect(Number(blob[0]?.size_bytes ?? 0)).toBeGreaterThan(0);
  });

  it('собранный PDF лежит в хранилище, и его содержимое отвечает записанному хэшу', async () => {
    // Ключ берётся из `stored_blobs`, а не собирается в тесте: раскладка ключей
    // — дело `blobKey()` (§13, шардирование по префиксу хэша), и тест, знающий
    // её наизусть, сломался бы при изменении раскладки, ничего не проверив.
    const [blob] = await testDb.query<{ s3_key: string; sha256: string }>(
      `SELECT sb.s3_key, sb.sha256 FROM stored_blobs sb
         JOIN processing_bundles pb ON pb.working_pdf_blob_sha256 = sb.sha256`,
    );
    const bytes = await readFile(join(STORAGE_DIR, blob?.s3_key ?? ''));

    // Содержимое обязано отвечать хэшу, под которым записано: расхождение
    // означало бы, что в RD WEB уедет не тот документ, который собрали.
    expect(sha256(bytes)).toBe(blob?.sha256);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('карта страниц сплошная и указывает на настоящие страницы оригиналов', async () => {
    const map = await testDb.query<{ working_page_index: number; source_page_id: string }>(
      `SELECT bp.working_page_index, bp.source_page_id
         FROM processing_bundle_pages bp
         JOIN source_pages sp ON sp.id = bp.source_page_id
        ORDER BY bp.working_page_index`,
    );

    const pageCount = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM source_pages WHERE revision_id = '${REVISION}'`,
    );

    expect(map).toHaveLength(Number(pageCount[0]?.count ?? 0));
    expect(map.map((row) => Number(row.working_page_index))).toEqual(map.map((_, i) => i));
  });

  it('повторный прогон не собирает второй документ', async () => {
    await enqueueSystemJob(db, {
      type: 'bundle.build',
      payload: { revisionId: REVISION },
      dedupeKey: dedupeKeyFor('bundle.build', REVISION, 'retry'),
    });
    await drainQueue();

    const bundles = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM processing_bundles`,
    );
    expect(Number(bundles[0]?.count ?? 0)).toBe(1);
  });

  it('ни одна попытка не завершилась отказом', async () => {
    const failed = await testDb.query<{ job_type: string; error_message: string }>(
      `SELECT job_type, error_message FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);
  });
});
