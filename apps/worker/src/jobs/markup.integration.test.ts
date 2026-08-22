/**
 * Цепочка «Разметить файл» целиком: очередь → воркер → RD WEB → база (§6.1, §12).
 *
 * ## Что здесь настоящее
 *
 * PostgreSQL (pglite) под миграциями проекта, файловое хранилище, настоящий
 * 50-страничный PDF, ФЕЙК-СЕРВЕР RD WEB по их реальным контрактам, штатный
 * `JobRunner.runOnce()` и реестр из `createWorkerRegistry()` — тот же, что
 * собирает точка входа воркера. Ни один порт не подменяется: адаптер ходит по
 * HTTP, детекция синхронная и постраничная, координаты приезжают из ответа.
 *
 * ## Что проверяется
 *
 * Не «задача завершилась успехом», а результат в базе: RD-документ прогона
 * записан, блоки импортированы, координаты лежат в 0..1, на 50 страницах
 * встречаются все три типа блоков, флаги внимания проставлены — и, главное,
 * **полностраничный блок не появился ни на одной странице с частичной
 * детекцией**. Успешно завершившаяся задача, ничего не изменившая, — это ровно
 * тот отказ, ради которого файл написан (урок S5).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { startFakeRdWeb, type FakeRdWeb } from '@id/fake-rdweb';
import {
  createDatabase,
  createLogger,
  createMetrics,
  createPdfLibToolkit,
  createStorage,
  dedupeKeyFor,
  enqueueSystemJob,
  ensureDraftLayout,
  JobRunner,
  LegacyRdWebAdapter,
  loadEnv,
  loadPdfLibModule,
  NoopErrorReporter,
  previewPageKey,
  type Database,
  type PdfToolkit,
  type StorageProvider,
} from '@id/api';

import { createWorkerRegistry } from './pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** Столько страниц требует специфический гейт S6 («три типа на 50 страницах»). */
const PAGE_COUNT = 50;

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR = id(2);
const OBJECT = id(4);
const SUBMISSION = id(10);
const REVISION = id(11);
const USER_CONTRACTOR = id(20);
const FILE = id(30);

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-markup-e2e-'));

let testDb: TestDatabase;
let db: Database;
let storage: StorageProvider;
let toolkit: PdfToolkit;
let runner: JobRunner;
let fake: FakeRdWeb;
let layoutRevisionId = '';

/**
 * Настоящий многостраничный PDF: фейк-сервер считает страницы по байтам, а
 * `file.verify` и `bundle.build` разбирают его штатным инструментом.
 *
 * `pdf-lib` берётся прямым импортом, а не через узкий порт `PdfLibModule`: порт
 * описывает ровно те методы, которые нужны сборщику, и заводить в нём
 * `addPage(size)` ради теста значило бы расширять продакшн-интерфейс под тест.
 */
async function buildSourcePdf(): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const document = await PDFDocument.create();
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    document.addPage([595, 842]);
  }
  return Buffer.from(await document.save());
}

async function fixtureStatements(sha256: string, sizeBytes: number): Promise<readonly string[]> {
  return [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_CONTRACTOR}', 'kc-markup-contractor', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION}', '${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${sha256}', 'blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}', ${sizeBytes}, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
       VALUES ('${FILE}', '${REVISION}', '${sha256}', 'комплект.pdf', 0)`,
  ];
}

beforeAll(async () => {
  fake = await startFakeRdWeb({ renderDelayPolls: 2, maxPagesPerDetectCall: 10 });

  const TEST_ENV = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'dev-stub',
    CSRF_SECRET: 'csrf-secret-of-markup-e2e-0123456789012',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-markup-e2e',
    RDWEB_BASE_URL: fake.url,
    RDWEB_USER: 'portal@example.test',
    RDWEB_PASSWORD: 'portal-secret',
    RDWEB_PROJECT_ALLOWLIST: 'prj-portal',
  });

  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const content = await buildSourcePdf();
  const sha256 = createHash('sha256').update(content).digest('hex');
  for (const statement of await fixtureStatements(sha256, content.byteLength)) {
    await testDb.query(statement);
  }

  db = createDatabase(createTestPool(testDb) as unknown as Pool);

  const logger = createLogger({ service: 'markup-e2e', level: 'silent', env: 'test' });
  const metrics = createMetrics({ enabled: false, service: 'markup-e2e' });
  storage = createStorage(TEST_ENV, { metrics, logger });

  const key = `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  const target = join(STORAGE_DIR, key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);

  toolkit = createPdfLibToolkit(await loadPdfLibModule((specifier) => import(specifier)));

  const rdweb = new LegacyRdWebAdapter({
    baseUrl: fake.url,
    user: 'portal@example.test',
    password: 'portal-secret',
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
      // Поллинг ускоряется, но остаётся поллингом: фейк отдаёт `ready` только
      // с третьего обращения, поэтому путь «страницы ещё не готовы» проходится
      // по-настоящему.
      waitPages: { pollsPerAttempt: 6, pollIntervalMs: 20 },
    }),
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-markup-e2e',
  });
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

/** Сколько блоков сейчас у ревизии разметки. Ноль — это и есть искомый дефект. */
async function blockCount(): Promise<number> {
  const rows = await testDb.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM layout_blocks WHERE layout_revision_id = '${layoutRevisionId}'`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Гоняет очередь, пока в ней есть готовые задачи, с паузой на отложенные. */
async function drainQueue(maxRounds = 80): Promise<void> {
  let idle = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await runner.runOnce();
    if (claimed > 0) {
      idle = 0;
      continue;
    }
    // Пустой проход не означает «конвейер встал»: `layout.analyze_coverage`
    // ставится с отложенным запуском.
    idle += 1;
    if (idle > 3) return;
    await sleep(500);
  }
  throw new Error('очередь не опустела за отведённое число проходов');
}

describe('цепочка «Разметить файл» доводит комплект до координат', () => {
  beforeAll(async () => {
    // Стадии приёма — штатным путём S5: без них нет ни страниц, ни рабочего
    // документа, на который ложится разметка.
    for (const type of ['file.verify', 'file.signature_probe'] as const) {
      await enqueueSystemJob(db, {
        type,
        payload: { revisionId: REVISION, sourceFileId: FILE },
        dedupeKey: dedupeKeyFor(type, FILE),
      });
    }
    await enqueueSystemJob(db, {
      type: 'bundle.build',
      payload: { revisionId: REVISION },
      dedupeKey: dedupeKeyFor('bundle.build', REVISION),
    });
    await drainQueue();

    const bundles = await testDb.query<{ id: string }>(
      `SELECT id FROM processing_bundles WHERE revision_id = '${REVISION}'`,
    );
    const bundleId = bundles[0]?.id ?? '';
    expect(bundleId).not.toBe('');

    // Черновик разметки — то же, что делает маршрут «Разметить файл».
    const { layout } = await ensureDraftLayout(
      db,
      { kind: 'admin', userId: USER_CONTRACTOR },
      { revisionId: REVISION, bundleId },
    );
    layoutRevisionId = layout.id;

    await enqueueSystemJob(db, {
      type: 'rd.create_run_document',
      payload: { revisionId: REVISION, bundleId, layoutRevisionId: layout.id },
      dedupeKey: dedupeKeyFor('rd.create_run_document', layout.id),
    });
    await drainQueue();
  }, 300_000);

  it('ни одна задача конвейера не завершилась отказом', async () => {
    const failed = await testDb.query<{ job_type: string; error_message: string }>(
      `SELECT job_type, error_message FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);
  });

  it('все шесть задач разметки действительно выполнялись', async () => {
    const rows = await testDb.query<{ job_type: string }>(
      `SELECT DISTINCT job_type FROM job_runs ORDER BY job_type`,
    );
    const types = rows.map((row) => row.job_type);
    // Обработчик, написанный и не поставленный в очередь, — это отказ S5.
    expect(types).toContain('rd.create_run_document');
    expect(types).toContain('rd.upload_working_pdf');
    expect(types).toContain('rd.wait_pages');
    expect(types).toContain('layout.detect_pages');
    expect(types).toContain('layout.analyze_coverage');
    // `preview.cache_pages` при PREVIEW_MODE=pdfjs не ставится — и это тоже
    // проверяемое поведение, а не «забыли».
    expect(types).not.toContain('preview.cache_pages');
  });

  it('RD-документ прогона записан и он один', async () => {
    const rows = await testDb.query<{ rd_document_id: string; rd_project_id: string }>(
      `SELECT rd_document_id, rd_project_id FROM rd_run_documents
        WHERE layout_revision_id = '${layoutRevisionId}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rd_project_id).toBe('prj-portal');

    // Второго документа на их стороне быть не должно: повторный `init` — это
    // второй заезд рабочего PDF.
    expect(fake.snapshot().documents).toHaveLength(1);
  });

  it('рабочий PDF доехал целиком и отрендерен на 50 страниц', async () => {
    const [document] = fake.snapshot().documents;
    expect(document?.pageCount).toBe(PAGE_COUNT);
    expect(document?.sizeBytes ?? 0).toBeGreaterThan(0);
  });

  it('блоки импортированы, координаты в диапазоне 0..1', async () => {
    const rows = await testDb.query<{
      count: string | number;
      min_x: number;
      max_x: number;
      min_y: number;
      max_y: number;
      bad: string | number;
    }>(
      `SELECT count(*) AS count, min(x0) AS min_x, max(x1) AS max_x,
              min(y0) AS min_y, max(y1) AS max_y,
              count(*) FILTER (WHERE x0 > x1 OR y0 > y1) AS bad
         FROM layout_blocks WHERE layout_revision_id = '${layoutRevisionId}'`,
    );
    const stats = rows[0];
    expect(Number(stats?.count ?? 0)).toBeGreaterThan(PAGE_COUNT);
    expect(Number(stats?.min_x)).toBeGreaterThanOrEqual(0);
    expect(Number(stats?.max_x)).toBeLessThanOrEqual(1);
    expect(Number(stats?.min_y)).toBeGreaterThanOrEqual(0);
    expect(Number(stats?.max_y)).toBeLessThanOrEqual(1);
    expect(Number(stats?.bad ?? 0)).toBe(0);
  });

  it('на 50-страничном комплекте различаются три типа блоков', async () => {
    const rows = await testDb.query<{ block_type: string; count: string | number }>(
      `SELECT block_type, count(*) AS count FROM layout_blocks
        WHERE layout_revision_id = '${layoutRevisionId}'
        GROUP BY block_type ORDER BY block_type`,
    );
    const types = rows.map((row) => row.block_type);
    expect(types).toEqual(['image', 'stamp', 'text']);
    for (const row of rows) expect(Number(row.count)).toBeGreaterThan(0);
  });

  it('провенанс детектора записан, уверенность и модель НЕ хранятся', async () => {
    const rows = await testDb.query<{ detector_provenance: string; source: string }>(
      `SELECT DISTINCT detector_provenance, source FROM layout_blocks
        WHERE layout_revision_id = '${layoutRevisionId}'`,
    );
    expect(rows).toEqual([{ detector_provenance: 'rf_detr', source: 'auto' }]);

    // Колонок уверенности и модели детектора в схеме нет: их нет в `BlockOut`
    // легаси-API, и они были бы вечно NULL (§0.1).
    const columns = await testDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'layout_blocks'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain('confidence');
    expect(names).not.toContain('model_id');
  });

  it('полностраничный блок не добавлен поверх частичной детекции', async () => {
    // Главное требование этапа. Страница с блоками на 30% площади не имеет
    // права получить ещё один блок на всю страницу: они перекрылись бы, и один
    // и тот же текст уехал бы в md дважды.
    const rows = await testDb.query<{
      working_page_index: number;
      full: string | number;
      total: string | number;
    }>(
      `SELECT working_page_index,
              count(*) FILTER (WHERE x0 <= 0.0001 AND y0 <= 0.0001
                                 AND x1 >= 0.9999 AND y1 >= 0.9999) AS full,
              count(*) AS total
         FROM layout_blocks WHERE layout_revision_id = '${layoutRevisionId}'
        GROUP BY working_page_index`,
    );
    const violations = rows.filter((row) => Number(row.full) > 0);
    expect(violations).toEqual([]);

    const patched = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_blocks
        WHERE layout_revision_id = '${layoutRevisionId}' AND detector_provenance = 'full_page'`,
    );
    expect(Number(patched[0]?.count ?? 0)).toBe(0);
  });

  it('флаги внимания проставлены страницам с пустой детекцией', async () => {
    const emptyPages = await testDb.query<{ working_page_index: number }>(
      `SELECT bp.working_page_index
         FROM processing_bundle_pages bp
         LEFT JOIN layout_blocks b
           ON b.working_page_index = bp.working_page_index
          AND b.layout_revision_id = '${layoutRevisionId}'
        WHERE bp.revision_id = '${REVISION}'
        GROUP BY bp.working_page_index
       HAVING count(b.id) = 0
        ORDER BY bp.working_page_index`,
    );
    expect(emptyPages.length).toBeGreaterThan(0);

    const flagged = await testDb.query<{ working_page_index: number; attention_flags: string[] }>(
      `SELECT bp.working_page_index, sp.attention_flags
         FROM processing_bundle_pages bp
         JOIN source_pages sp ON sp.id = bp.source_page_id
        WHERE bp.revision_id = '${REVISION}'
          AND array_length(sp.attention_flags, 1) > 0
        ORDER BY bp.working_page_index`,
    );
    const flaggedPages = new Set(flagged.map((row) => Number(row.working_page_index)));
    for (const page of emptyPages) {
      expect(flaggedPages.has(Number(page.working_page_index))).toBe(true);
    }

    const noBlocks = flagged.filter((row) => row.attention_flags.includes('no_blocks'));
    expect(noBlocks.length).toBe(emptyPages.length);
  });

  it('аномально маленькие блоки помечены, а здоровые страницы — нет', async () => {
    const flagged = await testDb.query<{ attention_flags: string[] }>(
      `SELECT sp.attention_flags FROM processing_bundle_pages bp
         JOIN source_pages sp ON sp.id = bp.source_page_id
        WHERE bp.revision_id = '${REVISION}'`,
    );
    const all = flagged.flatMap((row) => row.attention_flags);
    expect(all).toContain('tiny_block');

    const clean = flagged.filter((row) => row.attention_flags.length === 0);
    // Флаг на КАЖДОЙ странице означал бы бесполезный сигнал, а не проверку.
    expect(clean.length).toBeGreaterThan(0);
  });

  it('сквозной request_id дошёл до вызовов RD WEB', async () => {
    const withRequestId = fake.calls.filter((call) => call.requestId !== null);
    expect(withRequestId.length).toBeGreaterThan(0);
  });

  it('детекция шла синхронными пачками, а не одним вызовом', async () => {
    const detectCalls = fake.calls.filter((call) => call.path.includes('/detect-blocks'));
    // 50 страниц при пачке в 8 — это семь вызовов, а не один.
    expect(detectCalls.length).toBeGreaterThanOrEqual(7);
  });

  it('при PREVIEW_MODE=cached превью действительно кладутся в хранилище', async () => {
    // Отрицательной проверки «задача не поставлена» мало: она доказывает только
    // гейт режима. Здесь собирается второй реестр с `previewCached: true` — тот
    // же код, тот же адаптер, — и проверяются файлы в хранилище.
    const logger = createLogger({ service: 'markup-e2e-preview', level: 'silent', env: 'test' });
    const metrics = createMetrics({ enabled: false, service: 'markup-e2e-preview' });
    const cachedRunner = new JobRunner({
      db,
      registry: createWorkerRegistry({
        db,
        storage,
        toolkit,
        limits: { maxBytes: 209_715_200, maxPages: 500 },
        workDirBase: STORAGE_DIR,
        rdweb: new LegacyRdWebAdapter({
          baseUrl: fake.url,
          user: 'portal@example.test',
          password: 'portal-secret',
          projectId: 'prj-portal',
          metrics,
          logger,
          slowExternalMs: 5000,
        }),
        rdProjectId: 'prj-portal',
        previewCached: true,
      }),
      logger,
      metrics,
      errorReporter: new NoopErrorReporter(),
      workerId: 'worker-markup-preview',
    });

    const bundles = await testDb.query<{ id: string }>(
      `SELECT id FROM processing_bundles WHERE revision_id = '${REVISION}'`,
    );
    const bundleId = bundles[0]?.id ?? '';
    await enqueueSystemJob(db, {
      type: 'preview.cache_pages',
      payload: { revisionId: REVISION, bundleId, layoutRevisionId },
      dedupeKey: dedupeKeyFor('preview.cache_pages', layoutRevisionId),
    });

    for (let round = 0; round < 5; round += 1) {
      if ((await cachedRunner.runOnce()) === 0) break;
    }
    await cachedRunner.stop();

    const failed = await testDb.query<{ error_message: string }>(
      `SELECT error_message FROM job_runs
        WHERE job_type = 'preview.cache_pages' AND outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);

    const first = await storage.headObject(previewPageKey(bundleId, 'view', 0));
    const last = await storage.headObject(previewPageKey(bundleId, 'view', PAGE_COUNT - 1));
    expect(first?.sizeBytes ?? 0).toBeGreaterThan(0);
    expect(last?.sizeBytes ?? 0).toBeGreaterThan(0);
  }, 120_000);

  /**
   * BLOCKING-1, прогоном. Повторная постановка детекции БЕЗ флага перезаписи —
   * это то, что делает любой повтор задачи на at-least-once конвейере. Все
   * страницы уже размечены, поэтому удалённая сторона вернёт их в
   * `skipped_pages` и не создаст ни одного блока. До ремонта импорт получал всю
   * пачку, выполнял `DELETE ... source='auto'` и вставлял ноль: было 4 блока —
   * стало 0, задача succeeded, все страницы получили `no_blocks`.
   */
  it('повтор детекции без перезаписи не теряет ни одного блока', async () => {
    const before = await blockCount();
    expect(before).toBeGreaterThan(PAGE_COUNT);

    await enqueueSystemJob(db, {
      type: 'layout.detect_pages',
      payload: { revisionId: REVISION, layoutRevisionId },
      dedupeKey: dedupeKeyFor('layout.detect_pages', layoutRevisionId, 'repeat'),
    });
    await drainQueue();

    const after = await blockCount();
    expect(after).toBe(before);
    expect(after).not.toBe(0);

    const failed = await testDb.query<{ job_type: string; error_message: string }>(
      `SELECT job_type, error_message FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);
  });

  /** Явная переразметка (кнопка §5.3) действительно переразмечает и не обнуляет. */
  it('повторная детекция с перезаписью даёт не меньше блоков, но никогда ноль', async () => {
    const before = await blockCount();

    await enqueueSystemJob(db, {
      type: 'layout.detect_pages',
      payload: { revisionId: REVISION, layoutRevisionId, overwriteExisting: true },
      dedupeKey: dedupeKeyFor('layout.detect_pages', layoutRevisionId, 'repeat-overwrite'),
    });
    await drainQueue();

    const after = await blockCount();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeGreaterThanOrEqual(before);

    // Второй RD-документ не завёлся: перезапись — это про блоки, а не про заезд
    // рабочего PDF.
    expect(fake.snapshot().documents).toHaveLength(1);
    const rows = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM rd_run_documents
        WHERE layout_revision_id = '${layoutRevisionId}'`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  /** Ручной блок страницы переживает и то, и другое: правка человека приоритетна. */
  it('страница с ручным блоком не переразмечается вовсе', async () => {
    const scope = { kind: 'admin', userId: USER_CONTRACTOR } as const;
    const { createLayoutBlock, findLayoutRevision } = await import('@id/api');
    const layout = await findLayoutRevision(db, scope, layoutRevisionId);
    const manual = await createLayoutBlock(db, scope, {
      layoutRevisionId,
      expectedVersion: layout?.version ?? 0,
      actorUserId: USER_CONTRACTOR,
      workingPageIndex: 0,
      blockType: 'text',
      shapeType: 'rectangle',
      x0: 0.05,
      y0: 0.05,
      x1: 0.95,
      y1: 0.2,
      points: [],
    });

    await enqueueSystemJob(db, {
      type: 'layout.detect_pages',
      payload: {
        revisionId: REVISION,
        layoutRevisionId,
        pageIndices: [0],
        overwriteExisting: true,
      },
      dedupeKey: dedupeKeyFor('layout.detect_pages', layoutRevisionId, 'manual-page'),
    });
    await drainQueue();

    const survived = await testDb.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_blocks WHERE id = '${manual.blockId}'`,
    );
    expect(Number(survived[0]?.count ?? 0)).toBe(1);
  });

  it('заморозка после детекции даёт хэш по всему набору', async () => {
    const before = await testDb.query<{ version: number }>(
      `SELECT version FROM layout_revisions WHERE id = '${layoutRevisionId}'`,
    );
    const { freezeLayout } = await import('@id/api');
    const result = await freezeLayout(
      db,
      { kind: 'admin', userId: USER_CONTRACTOR },
      {
        layoutRevisionId,
        expectedVersion: Number(before[0]?.version ?? 0),
        actorUserId: USER_CONTRACTOR,
      },
    );
    expect(result.blocksHash).toMatch(/^[0-9a-f]{64}$/);

    const stored = await testDb.query<{ state: string; blocks_hash: string }>(
      `SELECT state, blocks_hash FROM layout_revisions WHERE id = '${layoutRevisionId}'`,
    );
    expect(stored[0]?.state).toBe('frozen');
    expect(stored[0]?.blocks_hash).toBe(result.blocksHash);
  });

  it('после заморозки блоки заперты триггером БД', async () => {
    await expect(
      testDb.query(`DELETE FROM layout_blocks WHERE layout_revision_id = '${layoutRevisionId}'`),
    ).rejects.toThrow();
  });
});
