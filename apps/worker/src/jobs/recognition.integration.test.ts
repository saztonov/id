/**
 * Цепочка «Отправить на распознавание» целиком: очередь → воркер → RD WEB → база.
 *
 * ## Что здесь настоящее
 *
 * PostgreSQL (pglite) под миграциями проекта, файловое хранилище, настоящий
 * многостраничный PDF, ФЕЙК-СЕРВЕР RD WEB по их контрактам, штатный
 * `JobRunner.runOnce()` и реестр из `createWorkerRegistry()` — тот же, что
 * собирает точка входа воркера. Ни один порт не подменяется: адаптер ходит по
 * HTTP, архив приезжает настоящим ZIP, sha256 считается по фактическим байтам.
 *
 * ## Что проверяется
 *
 * Не «задача завершилась успехом», а ПОСЛЕДСТВИЯ в базе и в хранилище, и
 * отдельно — четыре не-деградируемых гейта §1.6 на настоящих отказах:
 *
 * 1. OCR не стартует при расхождении хэшей разметки;
 * 2. подмена блока после старта даёт `integrity_error`;
 * 3. хэш артефакта верифицируется, повреждённый архив не становится успехом;
 * 4. забор экспорта однократный и только при `has_export`.
 *
 * Плюс два требования, которые S6 назвал главным риском: повтор каждой задачи
 * не уничтожает данные, и ни один секрет не появляется в журнале уровня
 * `trace`, в payload задач и в снимке настроек прогона.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { startFakeRdWeb, type FakeRdWeb, type FakeRecognitionFaults } from '@id/fake-rdweb';
import {
  artifactKey,
  createDatabase,
  createLogger,
  createMetrics,
  createPdfLibToolkit,
  createStorage,
  dedupeKeyFor,
  enqueueSystemJob,
  ensureDraftLayout,
  findRecognitionRun,
  listLayoutBlocks,
  JobRunner,
  LegacyRdWebAdapter,
  listArtifacts,
  listBlockResults,
  listPageTexts,
  listRecognitionRuns,
  loadEnv,
  loadPdfLibModule,
  NoopErrorReporter,
  startRecognitionRun,
  type AuthScope,
  type Database,
  type PdfToolkit,
  type StorageProvider,
} from '@id/api';

import { createWorkerRegistry } from './pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** Хватает, чтобы детектор дал несколько блоков нескольких типов. */
const PAGE_COUNT = 12;

/** Пароль служебного аккаунта: он же ищется в журнале уровня `trace`. */
const RD_PASSWORD = 'portal-secret-never-in-logs';
const OCR_MODEL = 'qwen2.5-vl-7b-instruct';

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR = id(2);
const ORG_OTHER = id(3);
const OBJECT = id(4);
const FOLDER = id(11);
const USER_CONTRACTOR = id(20);
const USER_OTHER = id(21);
const FILE = id(30);

const SCOPE: AuthScope = { kind: 'admin', userId: USER_CONTRACTOR };
/** Область чужого подрядчика: ею не должно быть видно ничего из этой поставки. */
const FOREIGN_SCOPE: AuthScope = {
  kind: 'contractor',
  userId: USER_OTHER,
  contractorId: ORG_OTHER,
};

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-recognition-e2e-'));

let testDb: TestDatabase;
let db: Database;
let storage: StorageProvider;
let toolkit: PdfToolkit;
let runner: JobRunner;
let fake: FakeRdWeb;
let bundleId = '';
/** Всё, что воркер написал в журнал уровня `trace`, — вход проверки секретов. */
const logSink: string[] = [];

async function buildSourcePdf(): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const document = await PDFDocument.create();
  for (let index = 0; index < PAGE_COUNT; index += 1) document.addPage([595, 842]);
  return Buffer.from(await document.save());
}

function fixtureStatements(sha256: string, sizeBytes: number): readonly string[] {
  return [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_OTHER}', 'ООО «Чужой»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_CONTRACTOR}', 'kc-recognition-contractor', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_OTHER}', 'kc-recognition-other', 'Сотрудник чужого', '${ORG_OTHER}')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_OTHER}', 'contractor')`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
    `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${sha256}', 'blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}', ${sizeBytes}, 'application/pdf')`,
    `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order)
       VALUES ('${FILE}', '${FOLDER}', '${sha256}', 'комплект.pdf', 0)`,
  ];
}

beforeAll(async () => {
  fake = await startFakeRdWeb({
    users: [{ email: 'portal@example.test', password: RD_PASSWORD }],
    renderDelayPolls: 1,
    maxPagesPerDetectCall: 10,
  });

  const TEST_ENV = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'dev-stub',
    CSRF_SECRET: 'csrf-secret-of-recognition-e2e-01234567',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-recognition-e2e',
    RDWEB_BASE_URL: fake.url,
    RDWEB_USER: 'portal@example.test',
    RDWEB_PASSWORD: RD_PASSWORD,
    RDWEB_PROJECT_ALLOWLIST: 'prj-portal',
    RDWEB_OCR_MODEL: OCR_MODEL,
  });

  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const content = await buildSourcePdf();
  const sha256 = createHash('sha256').update(content).digest('hex');
  for (const statement of fixtureStatements(sha256, content.byteLength)) {
    await testDb.query(statement);
  }

  db = createDatabase(createTestPool(testDb) as unknown as Pool);

  // Журнал уровня `trace` в память: требование D проверяется прогоном, а не
  // чтением кода — ровно так же, как на S6.
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logSink.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({
    service: 'recognition-e2e',
    level: 'trace',
    env: 'test',
    destination,
  });
  const metrics = createMetrics({ enabled: false, service: 'recognition-e2e' });
  storage = createStorage(TEST_ENV, { metrics, logger });

  const key = `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  const target = join(STORAGE_DIR, key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);

  toolkit = createPdfLibToolkit(await loadPdfLibModule((specifier) => import(specifier)));

  const rdweb = new LegacyRdWebAdapter({
    baseUrl: fake.url,
    user: 'portal@example.test',
    password: RD_PASSWORD,
    projectId: 'prj-portal',
    metrics,
    logger,
    slowExternalMs: TEST_ENV.SLOW_EXTERNAL_MS,
  });

  runner = new JobRunner({
    db,
    registry: createWorkerRegistry({
      db,
      storage,
      toolkit,
      limits: { maxBytes: TEST_ENV.MAX_UPLOAD_BYTES, maxPages: TEST_ENV.MAX_PAGES_PER_FILE },
      workDirBase: STORAGE_DIR,
      rdweb,
      rdProjectId: 'prj-portal',
      previewCached: false,
      waitPages: { pollsPerAttempt: 6, pollIntervalMs: 10 },
      // Поллинг ускоряется, но остаётся поллингом: фейк отдаёт `done` только со
      // второго обращения, поэтому путь «ещё идёт» проходится по-настоящему.
      pollRecognition: { pollsPerAttempt: 6, pollIntervalMs: 10 },
      recognitionSelections: [
        { blockType: 'text', providerType: 'lmstudio', modelId: OCR_MODEL },
        { blockType: 'image', providerType: 'lmstudio', modelId: OCR_MODEL },
        { blockType: 'stamp', providerType: 'lmstudio', modelId: OCR_MODEL },
      ],
    }),
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-recognition-e2e',
  });

  // Стадии приёма и сборка рабочего документа — штатным путём S5.
  for (const type of ['file.verify', 'file.signature_probe'] as const) {
    await enqueueSystemJob(db, {
      type,
      payload: { folderId: FOLDER, sourceFileId: FILE },
      dedupeKey: dedupeKeyFor(type, FILE),
    });
  }
  await enqueueSystemJob(db, {
    type: 'bundle.build',
    payload: { folderId: FOLDER },
    dedupeKey: dedupeKeyFor('bundle.build', FOLDER),
  });
  await drainQueue();

  const bundles = await testDb.query<{ id: string }>(
    `SELECT id FROM processing_bundles WHERE folder_id = '${FOLDER}'`,
  );
  bundleId = bundles[0]?.id ?? '';
  expect(bundleId).not.toBe('');
}, 300_000);

afterAll(async () => {
  await runner.stop();
  await fake.close();
  await testDb.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue(maxRounds = 120): Promise<void> {
  let idle = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await runner.runOnce();
    if (claimed > 0) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle > 3) return;
    await sleep(200);
  }
  throw new Error('очередь не опустела за отведённое число проходов');
}

/**
 * Новая ревизия разметки: полный проход цепочки §6.1.
 *
 * Каждый сценарий получает СВОЮ ревизию разметки и свой RD-документ. Иначе
 * первый же успешный прогон закрыл бы документ (§5.2, шаг 9), и остальные
 * сценарии проверяли бы отказ «документ закрыт», а не то, ради чего написаны.
 *
 * Прежняя разметка уступает место явно. До отмены заморозки (0048) её вытесняла
 * сама заморозка: `ensureDraftLayout` не находил черновика и заводил следующую
 * ревизию по номеру. Теперь разметка остаётся черновой, а черновик у поставки
 * один (`ux_layout_folders_single_draft`), — и без этого шага все сценарии
 * работали бы с одной ревизией и одним закрытым RD-документом.
 */
async function freshFrozenLayout(): Promise<string> {
  await testDb.query(
    `UPDATE layout_revisions
        SET state = 'superseded',
            blocks_hash = coalesce(blocks_hash, '${'c'.repeat(64)}')
      WHERE folder_id = '${FOLDER}' AND state = 'draft'`,
  );
  const { layout } = await ensureDraftLayout(db, SCOPE, { folderId: FOLDER, bundleId });
  await enqueueSystemJob(db, {
    type: 'rd.create_run_document',
    payload: { folderId: FOLDER, bundleId, layoutRevisionId: layout.id },
    dedupeKey: dedupeKeyFor('rd.create_run_document', layout.id),
  });
  await drainQueue();

  // Заморозки нет (0048): прогон берёт набор блоков как есть. Проверяем, что
  // детекция их вообще положила, — иначе распознавать было бы нечего.
  const blocks = await listLayoutBlocks(db, SCOPE, layout.id);
  expect(blocks.length).toBeGreaterThan(0);
  return layout.id;
}

/** Прогон и постановка цикла сверки — ровно то, что делает маршрут §6.2. */
async function startRun(layoutRevisionId: string): Promise<string> {
  const { run } = await startRecognitionRun(db, SCOPE, {
    layoutRevisionId,
    requireRdDocument: true,
    settingsSnapshot: { version: 1, provider: 'lmstudio', model: OCR_MODEL, documentMode: false },
  });
  await enqueueSystemJob(db, {
    type: 'layout.reconcile',
    payload: { folderId: FOLDER, recognitionRunId: run.id },
    dedupeKey: dedupeKeyFor('layout.reconcile', run.id),
  });
  return run.id;
}

async function runStatus(runId: string): Promise<{
  status: string;
  before: string | null;
  after: string | null;
  local: string;
}> {
  const rows = await testDb.query<{
    status: string;
    remote_layout_hash_before: string | null;
    remote_layout_hash_after: string | null;
    local_layout_hash: string;
  }>(
    `SELECT status, remote_layout_hash_before, remote_layout_hash_after, local_layout_hash
       FROM recognition_runs WHERE id = '${runId}'`,
  );
  const row = rows[0];
  return {
    status: row?.status ?? '(нет строки)',
    before: row?.remote_layout_hash_before ?? null,
    after: row?.remote_layout_hash_after ?? null,
    local: row?.local_layout_hash ?? '',
  };
}

async function runOutcome(runId: string): Promise<{
  status: string;
  counts: Record<string, unknown>;
  warnings: unknown[];
  reason: string | null;
}> {
  const rows = await testDb.query<{
    status: string;
    counts: string;
    warnings: string;
  }>(
    `SELECT status, counts::text AS counts, warnings::text AS warnings
       FROM recognition_runs WHERE id = '${runId}'`,
  );
  const events = await testDb.query<{ payload: string }>(
    `SELECT payload::text AS payload FROM folder_events
      WHERE payload->>'recognitionRunId' = '${runId}'
        AND event_type IN ('recognition.done', 'recognition.failed')
      ORDER BY seq DESC LIMIT 1`,
  );
  const payload = JSON.parse(events[0]?.payload ?? '{}') as { reason?: string | null };
  return {
    status: rows[0]?.status ?? '(нет строки)',
    counts: JSON.parse(rows[0]?.counts ?? '{}') as Record<string, unknown>,
    warnings: JSON.parse(rows[0]?.warnings ?? '[]') as unknown[],
    reason: payload.reason ?? null,
  };
}

/** Байты артефакта из хранилища — вход проверок «что лежит» против «что отдаём». */
async function artifactBytes(runId: string, kind: 'zip' | 'md' | 'html' | 'qa'): Promise<Buffer> {
  const object = await storage.getObjectStream(artifactKey(runId, kind));
  const chunks: Buffer[] = [];
  for await (const chunk of object.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Прогон одного сценария отказа от начала до конца.
 *
 * Каждому — своя ревизия разметки и свой RD-документ: иначе сценарии проверяли
 * бы отказ «документ закрыт», а не то, ради чего написаны.
 */
async function runWithFaults(faults: Partial<FakeRecognitionFaults>): Promise<{
  layoutRevisionId: string;
  runId: string;
}> {
  const layoutRevisionId = await freshFrozenLayout();
  fake.setFaults(faults);
  try {
    const runId = await startRun(layoutRevisionId);
    await drainQueue();
    return { layoutRevisionId, runId };
  } finally {
    fake.setFaults(
      Object.fromEntries(
        Object.keys(faults).map((key) => [key, false]),
      ) as Partial<FakeRecognitionFaults>,
    );
  }
}

async function countOf(table: string, runId: string): Promise<number> {
  const rows = await testDb.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM ${table} WHERE recognition_run_id = '${runId}'`,
  );
  return Number(rows[0]?.count ?? 0);
}

// =====================================================================
// Счастливый путь
// =====================================================================

describe('цепочка распознавания доводит комплект до текста страниц', () => {
  let layoutRevisionId = '';
  let runId = '';

  beforeAll(async () => {
    layoutRevisionId = await freshFrozenLayout();
    runId = await startRun(layoutRevisionId);
    await drainQueue();
  }, 300_000);

  it('все четыре задачи 10–13 действительно выполнялись', async () => {
    const rows = await testDb.query<{ job_type: string }>(
      `SELECT DISTINCT job_type FROM job_runs ORDER BY job_type`,
    );
    const types = rows.map((row) => row.job_type);
    // Обработчик, написанный и не поставленный в очередь, — отказ S5.
    expect(types).toContain('layout.reconcile');
    expect(types).toContain('rd.start_recognition');
    expect(types).toContain('rd.poll_recognition');
    expect(types).toContain('rd.fetch_export_once');
  });

  it('ни одна задача не завершилась отказом', async () => {
    const failed = await testDb.query<{ job_type: string; error_message: string }>(
      `SELECT job_type, error_message FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);
  });

  it('прогон завершён, и оба удалённых хэша равны локальному', async () => {
    const state = await runStatus(runId);
    expect(state.status).toBe('done');
    expect(state.before).toBe(state.local);
    expect(state.after).toBe(state.local);
  });

  it('удалённый набор блоков сведён к заказанному', async () => {
    const local = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_blocks WHERE layout_revision_id = '${layoutRevisionId}'`,
    );
    const document = fake
      .snapshot()
      .documents.find((doc) => doc.fileName.endsWith('.pdf') && doc.pageCount === PAGE_COUNT);
    expect(document).toBeDefined();
    const remote = fake.snapshot().blocks.filter((b) => b.document_id === document?.documentId);
    expect(remote.length).toBe(Number(local[0]?.count ?? -1));
  });

  it('артефакты записаны, и sha256 совпадает с байтами в хранилище', async () => {
    const artifacts = await listArtifacts(db, SCOPE, runId);
    expect(artifacts.map((a) => a.kind).sort()).toEqual(['html', 'md', 'qa', 'zip']);

    for (const artifact of artifacts) {
      const object = await storage.getObjectStream(artifactKey(runId, artifact.kind));
      const chunks: Buffer[] = [];
      for await (const chunk of object.stream) chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.artifactSha256);
      expect(bytes.byteLength).toBe(artifact.byteSize);
    }
  });

  it('архив забран РОВНО ОДИН раз', async () => {
    const jobs = fake.snapshot().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.exportFetches).toBe(1);
  });

  it('запуск OCR ушёл с провайдером и моделью, а не «настройками по умолчанию»', () => {
    const settings = fake.snapshot().jobs[0]?.settings as Record<
      string,
      { provider_type: string; model_id: string }
    >;
    expect(Object.keys(settings).sort()).toEqual(['image', 'stamp', 'text']);
    expect(settings.text?.model_id).toBe(OCR_MODEL);
    expect(settings.text?.provider_type).toBe('lmstudio');
  });

  it('текст страниц записан и не содержит подписанных ссылок на кропы', async () => {
    const pages = await listPageTexts(db, SCOPE, runId);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.textMd.length).toBeGreaterThan(0);
      expect(page.textMd).not.toContain('api/crops');
      expect(page.textMd).not.toContain('http://');
      expect(page.textMd).not.toContain('https://');
      expect(page.textSha256).toBe(createHash('sha256').update(page.textMd, 'utf8').digest('hex'));
    }
  });

  it('результаты блоков записаны с моделью и уверенностью, указатель переведён', async () => {
    const results = await listBlockResults(db, SCOPE, runId);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.modelId).toBe(OCR_MODEL);
      expect(result.confidence).not.toBeNull();
      expect(result.isCurrent).toBe(true);
      expect(result.contentMd ?? '').not.toBe('');
    }

    const pointers = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM current_block_result c
         JOIN block_results r ON r.id = c.block_result_id
        WHERE r.recognition_run_id = '${runId}'`,
    );
    expect(Number(pointers[0]?.count ?? 0)).toBe(results.length);
  });

  /** Шаг 9 §5.2 — долг, оставленный S6. */
  it('RD-документ прогона закрыт', async () => {
    const rows = await testDb.query<{ closed_at: string | null }>(
      `SELECT closed_at FROM rd_run_documents WHERE layout_revision_id = '${layoutRevisionId}'`,
    );
    expect(rows[0]?.closed_at).not.toBeNull();
  });

  it('повторный прогон по закрытому документу не заводится', async () => {
    await expect(
      startRecognitionRun(db, SCOPE, {
        layoutRevisionId,
        requireRdDocument: true,
        settingsSnapshot: {},
      }),
    ).rejects.toThrow();
    expect(await listRecognitionRuns(db, SCOPE, FOLDER)).toHaveLength(1);
  });

  /**
   * Проверяется ПРАВКА обоих: на sha256 артефакта и на смещения текста ссылаются
   * доказательства замечаний, и подмена сдвинула бы все цитаты.
   *
   * Удаление в ЧЕРНОВОЙ ревизии с миграции 0035 разрешено — см. ADR-0015: пока
   * комплект не подан, доказывать нечего, а безусловный запрет не давал убрать
   * ошибочный файл из собственного черновика. Обе стороны правила проверяет
   * `packages/db/src/invariants.test.ts`; здесь проверяется цепочка конвейера, а
   * не матрица триггеров.
   */
  it('артефакты и текст страниц не правятся на уровне БД', async () => {
    await expect(
      testDb.query(
        `UPDATE artifact_versions SET artifact_sha256 = '${'0'.repeat(64)}'
          WHERE recognition_run_id = '${runId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      testDb.query(
        `UPDATE page_text_versions SET text_sha256 = '${'0'.repeat(64)}'
          WHERE recognition_run_id = '${runId}'`,
      ),
    ).rejects.toThrow();
  });

  /**
   * Требование A: повтор задачи не имеет права ни уничтожить данные, ни забрать
   * экспорт второй раз. Проверяется по ТАБЛИЦАМ и по счётчику заборов на стороне
   * RD WEB, а не по коду ответа.
   */
  it('повтор задачи забора не тянет архив второй раз и ничего не теряет', async () => {
    const before = {
      artifacts: await countOf('artifact_versions', runId),
      pages: await countOf('page_text_versions', runId),
      blocks: await countOf('block_results', runId),
      fetches: fake.snapshot().jobs[0]?.exportFetches ?? 0,
    };
    expect(before.artifacts).toBe(4);
    expect(before.pages).toBeGreaterThan(0);
    expect(before.blocks).toBeGreaterThan(0);
    expect(before.fetches).toBe(1);

    // Прогон ВОЗВРАЩАЕТСЯ в `running`: без этого повтор задачи упирался бы в
    // «прогон уже завершён» и не доходил бы до забора вовсе — то есть тест
    // проверял бы терминальность статуса, а не однократность забора. Именно
    // так выглядит падение воркера между забором и записью исхода.
    await testDb.query(
      `UPDATE recognition_runs SET status = 'running', finished_at = NULL WHERE id = '${runId}'`,
    );

    await enqueueSystemJob(db, {
      type: 'rd.fetch_export_once',
      payload: { folderId: FOLDER, recognitionRunId: runId },
      dedupeKey: dedupeKeyFor('rd.fetch_export_once', runId, 'repeat'),
    });
    await drainQueue();

    const failed = await testDb.query<{ error_message: string | null }>(
      `SELECT error_message FROM job_runs
        WHERE job_type = 'rd.fetch_export_once' AND outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);
    expect((await runStatus(runId)).status).toBe('done');

    expect(await countOf('artifact_versions', runId)).toBe(before.artifacts);
    expect(await countOf('page_text_versions', runId)).toBe(before.pages);
    expect(await countOf('block_results', runId)).toBe(before.blocks);
    // Ключевое: НИ ОДНОГО нового обращения за архивом.
    expect(fake.snapshot().jobs[0]?.exportFetches).toBe(before.fetches);
  });

  it('повтор цикла сверки не удаляет удалённые блоки', async () => {
    const document = fake.snapshot().documents.at(-1);
    const before = fake.snapshot().blocks.filter((b) => b.document_id === document?.documentId);
    expect(before.length).toBeGreaterThan(0);

    await enqueueSystemJob(db, {
      type: 'layout.reconcile',
      payload: { folderId: FOLDER, recognitionRunId: runId },
      dedupeKey: dedupeKeyFor('layout.reconcile', runId, 'repeat'),
    });
    await drainQueue();

    const after = fake.snapshot().blocks.filter((b) => b.document_id === document?.documentId);
    expect(after.length).toBe(before.length);
  });

  /**
   * Двойник НЕ мягче оригинала: подписанная ссылка приезжает во всех трёх
   * записях архива, и все они лежат у нас побайтово. Без этой проверки утечка
   * через выдачу `html` и `qa` доказывалась бы отсутствием того, чего и не
   * приходило, — ровно так она и осталась незамеченной до S7-ремонта.
   */
  it('в хранимых артефактах подписанная ссылка ЕСТЬ — иначе проверять нечего', async () => {
    for (const kind of ['zip', 'md', 'html', 'qa'] as const) {
      const bytes = await artifactBytes(runId, kind);
      expect(bytes.toString('utf8')).toContain('api/crops');
    }
  });

  /**
   * IMPORTANT-3: нулевой результат не считается успехом, а значит успешный
   * прогон обязан ПОКАЗЫВАТЬ, что покрытие полное. Положительный путь
   * проверяется вместе с отрицательным (урок S5–S6).
   */
  it('счётчики успешного прогона доказывают полное покрытие разметки', async () => {
    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('done');

    const blocks = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_blocks
        WHERE layout_revision_id = '${layoutRevisionId}' AND block_type <> 'stamp'`,
    );
    const expected = Number(blocks[0]?.count ?? -1);
    expect(expected).toBeGreaterThan(0);

    expect(outcome.counts.blocksExpected).toBe(expected);
    expect(outcome.counts.blocksCovered).toBe(expected);
    expect(outcome.counts.blocksMissing).toBe(0);
    expect(outcome.counts.blocksForeign).toBe(0);
    expect(outcome.counts.pagesOutOfRange).toBe(0);
    // Сумма, а не `pagesWritten`: выше в этом же describe проверялся ПОВТОР
    // задачи забора, и он законно перезаписал счётчики прогона — на повторе всё
    // уже записано, поэтому «записано» ноль, а «уже было» полное число.
    expect(
      Number(outcome.counts.pagesWritten) + Number(outcome.counts.pagesAlreadyPresent),
    ).toBeGreaterThan(0);
    expect(Number(outcome.counts.blocksWritten) + Number(outcome.counts.blocksAlreadyPresent)).toBe(
      expected,
    );
    expect(outcome.counts.blocksUnknown).toBe(0);
  });

  /** Требование C: чужая область не видит ни прогона, ни артефактов, ни текста. */
  it('подрядчик из другой организации не видит прогон, артефакты и текст', async () => {
    expect(await findRecognitionRun(db, FOREIGN_SCOPE, runId)).toBeNull();
    expect(await listRecognitionRuns(db, FOREIGN_SCOPE, FOLDER)).toEqual([]);
    expect(await listArtifacts(db, FOREIGN_SCOPE, runId)).toEqual([]);
    expect(await listPageTexts(db, FOREIGN_SCOPE, runId)).toEqual([]);
    expect(await listBlockResults(db, FOREIGN_SCOPE, runId)).toEqual([]);
  });

  /** Требование D: журнал уровня `trace`, payload задач и снимок настроек. */
  it('ни одного секрета в журнале trace, в payload задач и в снимке настроек', async () => {
    const journal = logSink.join('\n');
    expect(journal.length).toBeGreaterThan(1000);
    expect(journal).not.toContain(RD_PASSWORD);
    expect(journal).not.toContain('api/crops');
    expect(journal).not.toMatch(/upload_url/i);
    expect(journal).not.toMatch(/"authorization"\s*:\s*"Bearer/i);

    const payloads = await testDb.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM jobs`,
    );
    // Непустота обязательна: цикл по нулю строк проходит любую проверку, и
    // «секретов нет» превратилось бы в «смотреть было не на что».
    expect(payloads.length).toBeGreaterThan(0);
    for (const row of payloads) {
      expect(row.payload).not.toContain(RD_PASSWORD);
      expect(row.payload).not.toContain('http');
    }

    const snapshots = await testDb.query<{ snapshot: string }>(
      `SELECT settings_snapshot::text AS snapshot FROM recognition_runs`,
    );
    expect(snapshots.length).toBeGreaterThan(0);
    for (const row of snapshots) {
      expect(row.snapshot).not.toContain(RD_PASSWORD);
      expect(row.snapshot).not.toContain(fake.url);
    }

    const events = await testDb.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM folder_events`,
    );
    expect(events.length).toBeGreaterThan(0);
    for (const row of events) {
      expect(row.payload).not.toContain(RD_PASSWORD);
      expect(row.payload).not.toContain('api/crops');
    }
  });
});

// =====================================================================
// Non-degradable гейт 1: OCR не стартует при расхождении хэшей
// =====================================================================

describe('OCR не стартует при расхождении хэшей разметки', () => {
  it('подменённый remote_layout_hash_before останавливает запуск', async () => {
    const layoutRevisionId = await freshFrozenLayout();
    const runId = await startRun(layoutRevisionId);
    // Цикл сверки отрабатывает штатно и записывает совпавший хэш.
    await drainQueue();
    expect((await runStatus(runId)).before).toBe((await runStatus(runId)).local);

    const jobsBefore = fake.snapshot().jobs.length;

    // Прогон возвращается в состояние «сверка была», но хэш уже другой: ровно
    // то, что означает подмена набора блоков между сверкой и стартом.
    await testDb.query(
      `UPDATE recognition_runs
          SET remote_layout_hash_before = '${'a'.repeat(64)}', status = 'running',
              finished_at = NULL, rd_job_id = NULL
        WHERE id = '${runId}'`,
    );

    await enqueueSystemJob(db, {
      type: 'rd.start_recognition',
      payload: { folderId: FOLDER, recognitionRunId: runId },
      dedupeKey: dedupeKeyFor('rd.start_recognition', runId, 'tampered'),
    });
    await drainQueue();

    // Гейт: прогон в integrity_error и на стороне RD WEB НЕ появилось job'а.
    expect((await runStatus(runId)).status).toBe('integrity_error');
    expect(fake.snapshot().jobs).toHaveLength(jobsBefore);
  }, 300_000);

  it('без подтверждённой сверки запуск не выполняется вовсе', async () => {
    const layoutRevisionId = await freshFrozenLayout();
    const { run } = await startRecognitionRun(db, SCOPE, {
      layoutRevisionId,
      requireRdDocument: true,
      settingsSnapshot: {},
    });
    const jobsBefore = fake.snapshot().jobs.length;

    // Цикл сверки пропускается: `remote_layout_hash_before` остаётся NULL.
    await enqueueSystemJob(db, {
      type: 'rd.start_recognition',
      payload: { folderId: FOLDER, recognitionRunId: run.id },
      dedupeKey: dedupeKeyFor('rd.start_recognition', run.id, 'no-reconcile'),
    });
    await drainQueue();

    expect(fake.snapshot().jobs).toHaveLength(jobsBefore);
    const failed = await testDb.query<{ error_class: string }>(
      `SELECT error_class FROM job_runs
        WHERE job_type = 'rd.start_recognition' AND outcome <> 'succeeded'
        ORDER BY started_at DESC LIMIT 1`,
    );
    expect(failed[0]?.error_class).toBe('RecognitionIntegrityError');
    // У `rd.start_recognition` ровно одна попытка (второй запуск — это второй
    // прогон на GPU), поэтому первая же неудача ЕСТЬ последняя, и прогон обязан
    // закончиться, а не остаться `running`: незавершённый прогон запирает
    // ревизию разметки навсегда — `startRecognitionRun` возвращал бы его же.
    expect((await runStatus(run.id)).status).toBe('integrity_error');
    expect(await countOf('artifact_versions', run.id)).toBe(0);
  }, 300_000);
});

// =====================================================================
// Non-degradable гейт 2: подмена блока после старта
// =====================================================================

describe('подмена блока после старта OCR даёт integrity_error', () => {
  it('прогон останавливается, артефактов и текста не появляется', async () => {
    const layoutRevisionId = await freshFrozenLayout();
    fake.setFaults({ mutateBlocksOnStart: true });
    const runId = await startRun(layoutRevisionId);
    await drainQueue();
    fake.setFaults({ mutateBlocksOnStart: false });

    const state = await runStatus(runId);
    expect(state.status).toBe('integrity_error');
    // Хэш «после» записан и ОТЛИЧАЕТСЯ от локального: расхождение доказано, а
    // не просто объявлено.
    expect(state.after).not.toBeNull();
    expect(state.after).not.toBe(state.local);

    expect(await countOf('artifact_versions', runId)).toBe(0);
    expect(await countOf('page_text_versions', runId)).toBe(0);
    expect(await countOf('block_results', runId)).toBe(0);

    // Документ закрыт: он больше не описывает заказанное.
    const rows = await testDb.query<{ closed_at: string | null }>(
      `SELECT closed_at FROM rd_run_documents WHERE layout_revision_id = '${layoutRevisionId}'`,
    );
    expect(rows[0]?.closed_at).not.toBeNull();
  }, 300_000);
});

// =====================================================================
// Non-degradable гейт 3: has_export
// =====================================================================

describe('экспорт забирается только при has_export', () => {
  it('завершённый job без финализации переводит прогон в failed без артефактов', async () => {
    const layoutRevisionId = await freshFrozenLayout();
    fake.setFaults({ neverExport: true });
    const runId = await startRun(layoutRevisionId);
    await drainQueue();
    fake.setFaults({ neverExport: false });

    expect((await runStatus(runId)).status).toBe('failed');
    expect(await countOf('artifact_versions', runId)).toBe(0);
    expect(await countOf('page_text_versions', runId)).toBe(0);

    // Задача забора не ставилась вовсе: гейт держится ДО обращения за архивом.
    const fetched = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM jobs
        WHERE type = 'rd.fetch_export_once' AND payload->>'recognitionRunId' = '${runId}'`,
    );
    expect(Number(fetched[0]?.count ?? 0)).toBe(0);
  }, 300_000);
});

// =====================================================================
// Non-degradable гейт 4: верификация артефакта
// =====================================================================

describe('повреждённый архив не становится успешным прогоном', () => {
  it('битая контрольная сумма записи переводит прогон в failed', async () => {
    const layoutRevisionId = await freshFrozenLayout();
    fake.setFaults({ corruptExport: true });
    const runId = await startRun(layoutRevisionId);
    await drainQueue();
    fake.setFaults({ corruptExport: false });

    expect((await runStatus(runId)).status).toBe('failed');
    expect(await countOf('page_text_versions', runId)).toBe(0);
    expect(await countOf('block_results', runId)).toBe(0);

    const failed = await testDb.query<{ error_class: string }>(
      `SELECT error_class FROM job_runs
        WHERE job_type = 'rd.fetch_export_once' AND outcome <> 'succeeded'
        ORDER BY started_at`,
    );
    // Первый заход упал именно на целостности архива. Последующие повторы
    // задачи падают уже `RecognitionStateError` — прогон завершён, и второй раз
    // за архивом никто не идёт; это тоже проверяемое поведение, а не шум.
    expect(failed.map((row) => row.error_class)).toContain('ZipError');
  }, 300_000);

  it('обрыв выдачи архива не оставляет ни строки артефакта, ни текста', async () => {
    const layoutRevisionId = await freshFrozenLayout();
    fake.setFaults({ truncateExport: true });
    const runId = await startRun(layoutRevisionId);
    await drainQueue();
    fake.setFaults({ truncateExport: false });

    expect((await runStatus(runId)).status).toBe('failed');
    expect(await countOf('page_text_versions', runId)).toBe(0);
  }, 300_000);
});

// =====================================================================
// IMPORTANT-2: исчерпание попыток ЛЮБОЙ задачи завершает прогон
// =====================================================================

/**
 * До ремонта `finishRun` вызывался только для `ZipError`, и шесть путей отказа
 * оставляли прогон в `running` навсегда. Последствие тяжелее, чем «поле не
 * обновилось»: незавершённый прогон возвращается `startRecognitionRun`'ом как
 * свой же (`created: false`), то есть новый прогон невозможен и ревизия
 * разметки запирается насмерть, пока цепочка задач крутится по кругу.
 *
 * Проверяется поштучно каждый сценарий, а не «какой-нибудь отказ»: именно
 * перечислением классов ошибок пять случаев из шести и потерялись.
 */
describe('исчерпание попыток задачи не оставляет прогон в running', () => {
  it('в архиве нет document.html — прогон завершается отказом', async () => {
    const { runId } = await runWithFaults({ dropHtmlEntry: true });
    await exhaustFetchAttempts(runId);

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/rd\.fetch_export_once/);
    expect(outcome.reason).toMatch(/ExportFormatError/);
    expect(await countOf('page_text_versions', runId)).toBe(0);
  }, 300_000);

  it('в архиве нет document.md — прогон завершается отказом', async () => {
    const { runId } = await runWithFaults({ dropMarkdownEntry: true });
    await exhaustFetchAttempts(runId);

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/ExportFormatError/);
    expect(await countOf('page_text_versions', runId)).toBe(0);
  }, 300_000);

  it('недопустимый номер страницы — прогон завершается отказом', async () => {
    const { runId } = await runWithFaults({ badPageLabel: true });
    await exhaustFetchAttempts(runId);

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/ExportFormatError/);
    expect(await countOf('page_text_versions', runId)).toBe(0);
  }, 300_000);

  /**
   * Отрицательный путь без положительного ничего не доказывает: правило звучит
   * «завершать, когда повтора БОЛЬШЕ НЕ БУДЕТ», и на не последней попытке
   * прогон обязан остаться `running`, а задача — ждать повтора.
   */
  it('на НЕ последней попытке прогон остаётся running, а задача повторяется', async () => {
    const { runId } = await runWithFaults({ dropHtmlEntry: true });

    expect((await runStatus(runId)).status).toBe('running');
    const rows = await testDb.query<{ status: string; attempts: number; max_attempts: number }>(
      `SELECT status, attempts, max_attempts FROM jobs
        WHERE type = 'rd.fetch_export_once' AND payload->>'recognitionRunId' = '${runId}'`,
    );
    expect(rows[0]?.status).toBe('queued');
    expect(Number(rows[0]?.attempts)).toBe(1);
    expect(Number(rows[0]?.max_attempts)).toBeGreaterThan(1);
  }, 300_000);

  /**
   * Главное следствие ремонта: терминальный прогон отпускает ревизию разметки.
   * До него здесь был вечный `running`, и новый прогон не заводился никогда.
   */
  it('после терминального состояния новый прогон по той же разметке заводится', async () => {
    const { layoutRevisionId, runId } = await runWithFaults({ dropHtmlEntry: true });
    await exhaustFetchAttempts(runId);
    expect((await runStatus(runId)).status).toBe('failed');

    const { run, created } = await startRecognitionRun(db, SCOPE, {
      layoutRevisionId,
      requireRdDocument: true,
      settingsSnapshot: { version: 1, model: OCR_MODEL },
    });
    expect(created).toBe(true);
    expect(run.id).not.toBe(runId);
    expect(run.status).toBe('running');
  }, 300_000);
});

/**
 * Досрочное исчерпание попыток задачи забора.
 *
 * Первая попытка уже израсходована прогоном; остальные не ждут своего часа с
 * бэкоффом, потому что проверяется исход, а не таймер. Байты архива при этом
 * лежат у нас с первой попытки, и повтор берёт их из хранилища — второго
 * обращения к RD WEB не происходит, что и требует §5.2.
 */
async function exhaustFetchAttempts(runId: string): Promise<void> {
  await testDb.query(
    `UPDATE jobs SET attempts = max_attempts - 1, next_run_at = now(), status = 'queued'
      WHERE type = 'rd.fetch_export_once' AND payload->>'recognitionRunId' = '${runId}'`,
  );
  await drainQueue();
}

// =====================================================================
// IMPORTANT-3: нулевой и неполный экспорт — не успех
// =====================================================================

describe('нулевой и неполный экспорт не даёт успешного прогона', () => {
  it('пустой markdown не становится done с нулём страниц', async () => {
    const { runId } = await runWithFaults({ emptyMarkdown: true });

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('failed');
    expect(outcome.counts.blocksCovered).toBe(0);
    expect(Number(outcome.counts.blocksExpected)).toBeGreaterThan(0);
    expect(await countOf('page_text_versions', runId)).toBe(0);
    expect(await countOf('block_results', runId)).toBe(0);
  }, 300_000);

  it('неполный экспорт виден счётчиком и отвергается', async () => {
    const { runId } = await runWithFaults({ dropHalfOfBlocks: true });

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('failed');
    expect(Number(outcome.counts.blocksMissing)).toBeGreaterThan(0);
    expect(Number(outcome.counts.blocksCovered)).toBeLessThan(
      Number(outcome.counts.blocksExpected),
    );
    expect(outcome.warnings).toContainEqual(expect.objectContaining({ code: 'export_incomplete' }));

    /**
     * Отдельный класс ошибки: недобор покрытия — это не сетевой сбой и не
     * расхождение доказательств, и по `job_runs` это обязано быть различимо.
     *
     * Попытки отбираются по СВОЕМУ прогону. Прежний запрос брал последнюю
     * неуспешную попытку `rd.fetch_export_once` во ВСЕЙ базе, а её пишут и
     * соседние наборы этого файла: `exhaustFetchAttempts` доводит задачу до
     * повтора поверх уже закрытого прогона, и та честно отказывает
     * `RecognitionStateError`. Пока порядок по `started_at` разводил эти строки,
     * утверждение держалось на совпадении — и разъезжалось под нагрузкой, когда
     * соседний пакет занимает процессор и метки времени сходятся. `attempt` во
     * втором ключе сортировки закрывает и ничью по метке.
     */
    const failed = await testDb.query<{ error_class: string; attempt: number }>(
      `SELECT r.error_class, r.attempt FROM job_runs r
         JOIN jobs j ON j.id = r.job_id
        WHERE r.job_type = 'rd.fetch_export_once'
          AND j.payload->>'recognitionRunId' = '${runId}'
          AND r.outcome <> 'succeeded'
        ORDER BY r.started_at DESC, r.attempt DESC`,
    );
    expect(
      failed.map((row) => row.error_class),
      'все неуспешные попытки забора у ЭТОГО прогона',
    ).not.toHaveLength(0);
    expect(failed[0]?.error_class).toBe('ExportCoverageError');
    // Частичный результат в базу НЕ попадает: проверка стоит до записи.
    expect(await countOf('page_text_versions', runId)).toBe(0);
    expect(await countOf('block_results', runId)).toBe(0);
  }, 300_000);

  it('лишний блок в экспорте не отбрасывается молча, а даёт integrity_error', async () => {
    const { runId } = await runWithFaults({ foreignBlockInMarkdown: true });

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('integrity_error');
    expect(Number(outcome.counts.blocksForeign)).toBeGreaterThan(0);
    expect(await countOf('page_text_versions', runId)).toBe(0);
    expect(await countOf('block_results', runId)).toBe(0);
  }, 300_000);

  it('страница вне диапазона — отдельная причина, а не общий пропуск', async () => {
    const { runId } = await runWithFaults({ pageLabelOutOfRange: true });

    const outcome = await runOutcome(runId);
    expect(outcome.status).toBe('integrity_error');
    expect(Number(outcome.counts.pagesOutOfRange)).toBeGreaterThan(0);
    expect(outcome.reason).toMatch(/вне рабочего документа/);
    // Батч не записан ВООБЩЕ: терминальный прогон не оставляет за собой
    // половину неизменяемого текста страниц.
    expect(await countOf('page_text_versions', runId)).toBe(0);
  }, 300_000);
});
