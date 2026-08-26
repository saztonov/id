/**
 * Задачи 22–23 целиком: очередь → воркер → база и хранилище (§12, §13).
 *
 * ## Что здесь настоящее
 *
 * PostgreSQL (pglite) под ВСЕМИ миграциями проекта, пул из `createTestPool`,
 * файловое хранилище, настоящий PDF из синтетических фикстур S0, реестр из
 * `createWorkerRegistry()` — тот же, что собирает точка входа воркера, — и
 * штатный `JobRunner.runOnce()`. Ни одного обработчика напрямую, ни одного
 * самодельного адаптера пула: на S3 «зарегистрированный, но никем не
 * вызванный» модуль выглядел рабочим при зелёных тестах, на S5 задачи не
 * ставились в очередь вовсе, а на S6 успешно завершившаяся задача уничтожала
 * данные.
 *
 * ## Что считается доказательством
 *
 * Не «задача завершилась успехом», а ПОСЛЕДСТВИЯ, прочитанные прямым SQL и
 * чтением объектов хранилища:
 *
 * 1. нарезка появилась в `logical_documents` и в хранилище, её sha256 совпадает
 *    с байтами, число страниц совпадает с диапазоном;
 * 2. **специфический гейт S10**: производный PDF ПОМЕЧЕН — `is_derived_copy`
 *    в БД и отметка в метаданных файла, найденная чтением самого файла;
 * 3. нарезка КОРРЕКТНА: в ней ровно страницы документа, а не соседние;
 * 4. повтор задачи безопасен и ничего не теряет;
 * 5. пропуск внутри диапазона нарезке не мешает и объявляется событием, а
 *    пересечение с чужим документом — отказ с названной причиной, а не молча
 *    чужой лист в выдаче;
 * 6. архив собран, читается нашим же разбором, содержит манифест и все
 *    нарезки, записан одной строкой; повтор его не пересобирает;
 * 7. **non-degradable гейт S10**: согласованная ревизия неизменяема на уровне
 *    БД — проверено прямым SQL по всем классам содержимого;
 * 8. запрет узкий: до решения производное содержимое правится свободно.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
  enqueueSystemJob,
  JobRunner,
  loadEnv,
  loadPdfLibModule,
  NoopErrorReporter,
  probePdf,
  readZipEntries,
  type Database,
  type PdfToolkit,
  type StorageProvider,
} from '@id/api';

import { createWorkerRegistry } from './pipeline.js';
import { ARCHIVE_MANIFEST_ENTRY, DERIVED_DOCUMENT_NOTE } from './delivery.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const FIXTURES_DIR = join(ROOT, 'tools', 'fixtures', 'pdf');
const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-delivery-e2e-'));

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR = id(2);
const OBJECT = id(4);
const USER_CONTRACTOR = id(20);
const USER_ENGINEER = id(21);

/** Основная поставка: две пары страниц — два документа. */
const SUBMISSION_MAIN = id(100);
const REVISION_MAIN = id(101);
const FILE_MAIN = id(102);
const BUNDLE_MAIN = id(103);
const DOC_A = id(110);
const DOC_B = id(111);
const VALIDATION_RUN = id(120);
const RULESET_VERSION = id(121);

/**
 * Поставка с пропуском внутри документа: страницы 0 и 2 у одного документа, а
 * страница 1 не отнесена никуда. Так выглядит пустой оборот листа — нарезке он
 * не мешает.
 */
const SUBMISSION_BROKEN = id(200);
const REVISION_BROKEN = id(201);
const FILE_BROKEN = id(202);
const BUNDLE_BROKEN = id(203);
const DOC_C = id(210);

/** Поставка с пересекающимися документами: страница 1 принадлежит соседу. */
const SUBMISSION_OVERLAP = id(400);
const REVISION_OVERLAP = id(401);
const FILE_OVERLAP = id(402);
const BUNDLE_OVERLAP = id(403);
const DOC_D = id(410);
const DOC_E = id(411);

const PAGE = (revision: number, index: number): string => id(revision * 10 + 300 + index);

const WORKING_PDF = join(FIXTURES_DIR, 'multipage.pdf');
/** Число страниц фикстуры проверено разбором в `pdf-lib.test.ts`. */
const WORKING_PAGES = 4;

let workingSha = '';
let testDb: TestDatabase;
let pool: Pool;
let db: Database;
let storage: StorageProvider;
let runner: JobRunner;

// =====================================================================
// Фикстура
// =====================================================================

function catalogStatements(): readonly string[] {
  return [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_CONTRACTOR}', 'kc-delivery-contractor', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,
    `INSERT INTO users (id, kc_sub, full_name)
       VALUES ('${USER_ENGINEER}', 'kc-delivery-engineer', 'Инженер')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${workingSha}', 'blobs/${workingSha.slice(0, 2)}/${workingSha.slice(2, 4)}/${workingSha}', 1, 'application/pdf')`,
  ];
}

/**
 * Поставка с рабочим документом и картой страниц.
 *
 * Рабочий PDF — настоящая четырёхстраничная фикстура S0, и её байты лежат в
 * хранилище по тому же ключу, что записан в `stored_blobs`. Нарезка обязана
 * работать на настоящем документе: подставной «PDF» из десяти байт доказывал бы
 * только то, что вызвался порт.
 */
function submissionStatements(input: {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly fileId: string;
  readonly bundleId: string;
  readonly revisionKey: number;
}): readonly string[] {
  const pages = Array.from({ length: WORKING_PAGES }, (_, index) => PAGE(input.revisionKey, index));
  return [
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${input.submissionId}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка', '${USER_CONTRACTOR}')`,
    // Ревизия заводится ЧЕРНОВИКОМ и переводится в `in_review` последним
    // оператором фикстуры. Иначе состав вставить нельзя, и это правильно:
    // именно так триггеры класса `source` и работают с момента подачи.
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status, aggregate_manifest_hash)
       VALUES ('${input.revisionId}', '${input.submissionId}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft', '${'a'.repeat(64)}')`,
    `UPDATE works SET current_revision_id = '${input.revisionId}' WHERE id = '${input.submissionId}'`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${input.fileId}', '${input.revisionId}', '${workingSha}', 'комплект.pdf', 0, 'ok')`,
    ...pages.map(
      (pageId, index) =>
        `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
           VALUES ('${pageId}', '${input.revisionId}', '${input.fileId}', ${index}, ${index}, 1240, 1754, 0)`,
    ),
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${input.bundleId}', '${input.revisionId}', '${'a'.repeat(64)}', '${workingSha}', 'bundle/1+pdf-lib')`,
    ...pages.map(
      (pageId, index) =>
        `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
           VALUES ('${input.bundleId}', '${input.revisionId}', ${index}, '${pageId}')`,
    ),
  ];
}

function documentStatements(input: {
  readonly revisionId: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly pageIds: readonly string[];
  readonly confirmed: boolean;
}): readonly string[] {
  return [
    `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal, title, is_confirmed, confirmed_by)
       VALUES ('${input.documentId}', '${input.revisionId}', '${OBJECT}', '${ORG_CONTRACTOR}', ${input.ordinal},
               $t$${input.title}$t$, ${input.confirmed}, ${input.confirmed ? `'${USER_ENGINEER}'` : 'NULL'})`,
    ...input.pageIds.map(
      (pageId, index) =>
        `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
           VALUES ('${input.revisionId}', '${pageId}', '${input.documentId}', ${index})`,
    ),
  ];
}

function checksStatements(): readonly string[] {
  return [
    `INSERT INTO ruleset_versions (id, version, published_at, published_by)
       VALUES ('${RULESET_VERSION}', 'v1', now(), '${USER_ENGINEER}')`,
    `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, started_at, finished_at, counts)
       VALUES ('${VALIDATION_RUN}', '${REVISION_MAIN}', '${RULESET_VERSION}', now(), now(), '{}'::jsonb)`,
  ];
}

beforeAll(async () => {
  const bytes = await readFile(WORKING_PDF);
  workingSha = createHash('sha256').update(bytes).digest('hex');

  const env = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'dev-stub',
    CSRF_SECRET: 'csrf-secret-of-delivery-e2e-0123456789ab',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-delivery-e2e',
  });

  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  for (const statement of [
    ...catalogStatements(),
    ...submissionStatements({
      submissionId: SUBMISSION_MAIN,
      revisionId: REVISION_MAIN,
      fileId: FILE_MAIN,
      bundleId: BUNDLE_MAIN,
      revisionKey: 1,
    }),
    ...documentStatements({
      revisionId: REVISION_MAIN,
      documentId: DOC_A,
      ordinal: 0,
      title: 'АОСР № 1',
      pageIds: [PAGE(1, 0), PAGE(1, 1)],
      confirmed: true,
    }),
    ...documentStatements({
      revisionId: REVISION_MAIN,
      documentId: DOC_B,
      ordinal: 1,
      title: 'Сертификат',
      pageIds: [PAGE(1, 2), PAGE(1, 3)],
      confirmed: true,
    }),
    ...checksStatements(),
    ...submissionStatements({
      submissionId: SUBMISSION_BROKEN,
      revisionId: REVISION_BROKEN,
      fileId: FILE_BROKEN,
      bundleId: BUNDLE_BROKEN,
      revisionKey: 2,
    }),
    ...documentStatements({
      revisionId: REVISION_BROKEN,
      documentId: DOC_C,
      ordinal: 0,
      title: 'Документ с пропуском',
      pageIds: [PAGE(2, 0), PAGE(2, 2)],
      confirmed: true,
    }),
    ...submissionStatements({
      submissionId: SUBMISSION_OVERLAP,
      revisionId: REVISION_OVERLAP,
      fileId: FILE_OVERLAP,
      bundleId: BUNDLE_OVERLAP,
      revisionKey: 3,
    }),
    // Страница 1 отнесена к соседу: диапазоны документов пересекаются, и
    // нарезка первого включила бы чужой лист.
    ...documentStatements({
      revisionId: REVISION_OVERLAP,
      documentId: DOC_D,
      ordinal: 0,
      title: 'Документ, охватывающий чужой лист',
      pageIds: [PAGE(3, 0), PAGE(3, 2)],
      confirmed: true,
    }),
    ...documentStatements({
      revisionId: REVISION_OVERLAP,
      documentId: DOC_E,
      ordinal: 1,
      title: 'Сосед',
      pageIds: [PAGE(3, 1)],
      confirmed: true,
    }),
    // Подача всех ревизий последним шагом: состав заперт с этого момента.
    `UPDATE submission_revisions SET status = 'in_review', submitted_at = now(), submitted_by = '${USER_CONTRACTOR}'
       WHERE id IN ('${REVISION_MAIN}', '${REVISION_BROKEN}', '${REVISION_OVERLAP}')`,
  ]) {
    await testDb.query(statement);
  }

  pool = createTestPool(testDb) as unknown as Pool;
  db = createDatabase(pool);
  storage = createStorage(env, {
    metrics: createMetrics({ enabled: false, service: 'test' }),
    logger: createLogger({ service: 'test', level: 'silent', env: 'test' }),
  });

  // Байты рабочего документа кладутся ШТАТНЫМ путём хранилища и по тому же
  // ключу, что записан в `stored_blobs`: подмена файла мимо провайдера скрыла
  // бы расхождение ключей.
  await storage.putObject({
    key: `blobs/${workingSha.slice(0, 2)}/${workingSha.slice(2, 4)}/${workingSha}`,
    body: bytes,
    contentType: 'application/pdf',
  });

  const toolkit: PdfToolkit = createPdfLibToolkit(
    await loadPdfLibModule((specifier) => import(specifier)),
  );

  runner = new JobRunner({
    db,
    registry: createWorkerRegistry({
      db,
      storage,
      toolkit,
      limits: { maxBytes: env.MAX_UPLOAD_BYTES, maxPages: env.MAX_PAGES_PER_FILE },
      workDirBase: STORAGE_DIR,
      rdweb: null,
      llm: null,
    }),
    logger: createLogger({ service: 'worker', level: 'silent', env: 'test' }),
    metrics: createMetrics({ enabled: false, service: 'worker' }),
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-delivery-e2e',
  });
}, 120_000);

afterAll(async () => {
  if (runner !== undefined) await runner.stop();
  if (testDb !== undefined) await testDb.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Прогон очереди до опустошения ШТАТНЫМ захватом. */
async function drainQueue(maxRounds = 40): Promise<void> {
  let idle = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await runner.runOnce();
    if (claimed > 0) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle > 2) return;
    await sleep(20);
  }
  throw new Error('очередь не опустела за отведённое число проходов');
}

async function rows<T = Record<string, unknown>>(sql: string): Promise<readonly T[]> {
  return testDb.query<T>(sql);
}

async function count(sql: string): Promise<number> {
  const result = await rows<{ value: string | number }>(sql);
  return Number(result[0]?.value ?? 0);
}

/** Отказ прямого SQL: инвариант обязана держать БД, а не код над ней. */
async function rejects(sql: string): Promise<string> {
  try {
    await testDb.query(sql);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`ожидался отказ базы, но оператор прошёл: ${sql}`);
}

async function storedBytes(key: string): Promise<Buffer> {
  const object = await storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  for await (const chunk of object.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// =====================================================================
// Задача 22
// =====================================================================

describe('нарезка логических документов (задача 22)', () => {
  it('веер по ревизии ставит задачу на каждый подтверждённый документ и исполняет её', async () => {
    await enqueueSystemJob(db, {
      type: 'doc.materialize_pdf',
      payload: { revisionId: REVISION_MAIN },
      dedupeKey: 'doc.materialize_pdf:main:fanout',
    });

    // Задача ЛЕЖИТ в очереди — проверено по таблице, а не по вызову в коде.
    expect(
      await count(
        `SELECT count(*)::int AS value FROM jobs WHERE type = 'doc.materialize_pdf' AND status = 'queued'`,
      ),
    ).toBe(1);

    await drainQueue();

    const done = await rows<{ id: string; derived_pdf_blob_sha256: string | null }>(
      `SELECT id, derived_pdf_blob_sha256 FROM logical_documents WHERE revision_id = '${REVISION_MAIN}' ORDER BY ordinal`,
    );
    expect(done).toHaveLength(2);
    for (const document of done) {
      expect(document.derived_pdf_blob_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 120_000);

  it('нарезка корректна: страниц столько же, сколько у документа, и это его страницы', async () => {
    const [a] = await rows<{ derived_pdf_page_count: number; derived_pdf_blob_sha256: string }>(
      `SELECT derived_pdf_page_count, derived_pdf_blob_sha256 FROM logical_documents WHERE id = '${DOC_A}'`,
    );
    expect(a?.derived_pdf_page_count).toBe(2);

    const bytes = await storedBytes(`documents/${DOC_A}.pdf`);
    // sha256 в БД описывает ИМЕННО эти байты: иначе выдача отдавала бы одно, а
    // целостность подтверждалась другим.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(a?.derived_pdf_blob_sha256);

    const probe = probePdf(bytes);
    expect(probe.ok).toBe(true);
    expect(probe.ok === true ? probe.pageCount : 0).toBe(2);
  });

  it('производный PDF помечен: флаг в БД и отметка в метаданных файла', async () => {
    const [document] = await rows<{ is_derived_copy: boolean; derived_note_applied: boolean }>(
      `SELECT is_derived_copy, derived_note_applied FROM logical_documents WHERE id = '${DOC_A}'`,
    );
    expect(document?.is_derived_copy).toBe(true);
    // `derived_note_applied` пишется по результату ЧТЕНИЯ готового файла, а не
    // по факту передачи параметра. Проверяется и сам файл — независимо от того,
    // что записала задача.
    expect(document?.derived_note_applied).toBe(true);

    const bytes = await storedBytes(`documents/${DOC_A}.pdf`);
    const hex = Buffer.from(DERIVED_DOCUMENT_NOTE, 'utf16le').swap16().toString('hex');
    expect(bytes.toString('latin1').toLowerCase()).toContain(hex.toLowerCase());
  });

  it('БД запрещает нарезку без пометки производности', async () => {
    // §13 держит ограничение, а не аккуратность задачи: снять пометку у
    // нарезанного документа нельзя.
    const message = await rejects(
      `UPDATE logical_documents SET is_derived_copy = false WHERE id = '${DOC_A}'`,
    );
    expect(message).toContain('logical_documents_derived_marked_chk');
  });

  it('повтор задачи безопасен и ничего не теряет', async () => {
    const before = await rows<{ derived_pdf_blob_sha256: string; version: number }>(
      `SELECT derived_pdf_blob_sha256, version FROM logical_documents WHERE id = '${DOC_A}'`,
    );

    await enqueueSystemJob(db, {
      type: 'doc.materialize_pdf',
      payload: { revisionId: REVISION_MAIN, documentId: DOC_A },
      dedupeKey: 'doc.materialize_pdf:main:repeat',
    });
    await drainQueue();

    const after = await rows<{ derived_pdf_blob_sha256: string }>(
      `SELECT derived_pdf_blob_sha256 FROM logical_documents WHERE id = '${DOC_A}'`,
    );
    // Содержимое детерминировано, поэтому повтор даёт ТОТ ЖЕ хэш: «успешно
    // завершилась и ничего не изменила» здесь не отказ, а требование.
    expect(after[0]?.derived_pdf_blob_sha256).toBe(before[0]?.derived_pdf_blob_sha256);
    expect(
      await count(
        `SELECT count(*)::int AS value FROM job_runs WHERE job_type = 'doc.materialize_pdf' AND outcome = 'failed'`,
      ),
    ).toBe(0);
  }, 120_000);

  it('пропуск внутри диапазона нарезке не мешает, но назван в ленте', async () => {
    // Непривязанная страница между листами документа — это пустой оборот или
    // штамп ЭП, а не чужой документ. Отказ на ней лишал выдачи весь комплект
    // из-за одного листа, поэтому нарезка идёт, а факт объявляется событием.
    await enqueueSystemJob(db, {
      type: 'doc.materialize_pdf',
      payload: { revisionId: REVISION_BROKEN, documentId: DOC_C },
      dedupeKey: 'doc.materialize_pdf:gaps',
    });
    await drainQueue();

    const [job] = await rows<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM jobs WHERE dedupe_key = 'doc.materialize_pdf:gaps'`,
    );
    expect(job?.status).toBe('done');

    // В нарезке ВЕСЬ отрезок 0..2, включая непривязанный лист: страница
    // физически лежит внутри документа, и выкидывать её из выдачи нечем.
    const [document] = await rows<{ derived_pdf_page_count: number }>(
      `SELECT derived_pdf_page_count FROM logical_documents WHERE id = '${DOC_C}'`,
    );
    expect(Number(document?.derived_pdf_page_count)).toBe(3);
    expect((await storedBytes(`documents/${DOC_C}.pdf`)).length).toBeGreaterThan(0);

    const events = await rows<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM revision_events
        WHERE revision_id = '${REVISION_BROKEN}' AND event_type = 'document.materialize.gaps'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ assignedPages: 2, unassignedPages: 1 });
  }, 120_000);

  it('пересечение с чужим документом — отказ с названной причиной', async () => {
    await enqueueSystemJob(db, {
      type: 'doc.materialize_pdf',
      payload: { revisionId: REVISION_OVERLAP, documentId: DOC_D },
      dedupeKey: 'doc.materialize_pdf:overlap',
    });
    await drainQueue();

    const [job] = await rows<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM jobs WHERE dedupe_key = 'doc.materialize_pdf:overlap'`,
    );
    // `failed` — терминальный статус строки задачи; «dead» это его имя в
    // журнале раннера. Повтора не будет: отказ объявлен неповторяемым самим
    // классом ошибки, а не перечислением в обработчике.
    expect(job?.status).toBe('failed');
    expect(job?.last_error).toContain('пересекается');

    // Ни строки в БД, ни объекта в хранилище: отказ обязан не оставлять следа
    // в виде «наполовину нарезанного» документа.
    expect(
      await count(
        `SELECT count(*)::int AS value FROM logical_documents WHERE id = '${DOC_D}' AND derived_pdf_blob_sha256 IS NOT NULL`,
      ),
    ).toBe(0);
    await expect(storedBytes(`documents/${DOC_D}.pdf`)).rejects.toThrow();
  }, 120_000);

  it('исчерпание попыток оставляет в ленте ревизии названную причину', async () => {
    const events = await rows<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM revision_events
        WHERE revision_id = '${REVISION_OVERLAP}' AND event_type = 'document.materialize.failed'`,
    );
    // Общее правило `withDeliveryTermination`, а не перечисление классов
    // ошибок: ревизия не имеет права остаться в состоянии, о котором ничего не
    // сказано (урок S7).
    expect(events).toHaveLength(1);
    expect(String(events[0]?.payload.reason)).toContain('пересекается');
  });
});

// =====================================================================
// Задача 23
// =====================================================================

describe('архив согласованной ревизии (задача 23)', () => {
  it('до согласования архив не собирается', async () => {
    await enqueueSystemJob(db, {
      type: 'submission.build_archive',
      payload: { revisionId: REVISION_MAIN },
      dedupeKey: 'submission.build_archive:early',
    });
    await drainQueue();

    const [job] = await rows<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM jobs WHERE dedupe_key = 'submission.build_archive:early'`,
    );
    // `failed` — терминальный статус строки задачи; «dead» это его имя в
    // журнале раннера. Повтора не будет: отказ объявлен неповторяемым самим
    // классом ошибки, а не перечислением в обработчике.
    expect(job?.status).toBe('failed');
    expect(job?.last_error).toContain('согласованной');
    expect(await count(`SELECT count(*)::int AS value FROM submission_archives`)).toBe(0);
  }, 120_000);

  it('после согласования собирает архив, который читается нашим же разбором', async () => {
    await testDb.query(
      `UPDATE submission_revisions
          SET status = 'approved', decided_at = now(), decided_by = '${USER_ENGINEER}'
        WHERE id = '${REVISION_MAIN}'`,
    );

    await enqueueSystemJob(db, {
      type: 'submission.build_archive',
      payload: { revisionId: REVISION_MAIN },
      dedupeKey: 'submission.build_archive:main',
    });
    await drainQueue();

    const [archive] = await rows<{
      s3_key: string;
      archive_sha256: string;
      byte_size: string | number;
      entry_count: number;
    }>(
      `SELECT s3_key, archive_sha256, byte_size, entry_count FROM submission_archives WHERE revision_id = '${REVISION_MAIN}'`,
    );

    expect(archive?.s3_key).toBe(`archive/${REVISION_MAIN}/rev1-approved.zip`);
    expect(archive?.entry_count).toBe(3);

    const bytes = await storedBytes(archive?.s3_key ?? '');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(archive?.archive_sha256);
    expect(Number(archive?.byte_size)).toBe(bytes.length);

    const entries = readZipEntries(bytes, 64 * 1024 * 1024);
    expect(entries.map((entry) => entry.name)).toEqual([
      ARCHIVE_MANIFEST_ENTRY,
      `documents/001-${DOC_A}.pdf`,
      `documents/002-${DOC_B}.pdf`,
    ]);

    // Нарезки внутри архива — те же байты, что лежат в хранилище: архив не
    // пересобирает документы заново и не подменяет их.
    const inArchive = entries[1]?.bytes ?? Buffer.alloc(0);
    expect(inArchive.equals(await storedBytes(`documents/${DOC_A}.pdf`))).toBe(true);

    const manifest = JSON.parse((entries[0]?.bytes ?? Buffer.alloc(0)).toString('utf8')) as {
      revision: { status: string };
      documents: readonly { id: string; sha256: string; derivedCopy: boolean }[];
      sourceFiles: readonly { sha256: string }[];
    };
    expect(manifest.revision.status).toBe('approved');
    expect(manifest.documents).toHaveLength(2);
    // Получатель архива обязан узнать, что перед ним нарезка, не открывая PDF.
    expect(manifest.documents.every((document) => document.derivedCopy)).toBe(true);
    expect(manifest.sourceFiles[0]?.sha256).toBe(workingSha);
  }, 120_000);

  it('повтор задачи не пересобирает архив и не заводит вторую строку', async () => {
    await enqueueSystemJob(db, {
      type: 'submission.build_archive',
      payload: { revisionId: REVISION_MAIN },
      dedupeKey: 'submission.build_archive:main:repeat',
    });
    await drainQueue();

    expect(
      await count(
        `SELECT count(*)::int AS value FROM submission_archives WHERE revision_id = '${REVISION_MAIN}'`,
      ),
    ).toBe(1);
    const reused = await rows<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM revision_events
        WHERE revision_id = '${REVISION_MAIN}' AND event_type = 'archive.ready'
        ORDER BY seq DESC LIMIT 1`,
    );
    expect(reused[0]?.payload.reused).toBe(true);
  }, 120_000);

  it('архив неизменяем и не может появиться у несогласованной ревизии', async () => {
    expect(
      await rejects(
        `UPDATE submission_archives SET archive_sha256 = '${'b'.repeat(64)}' WHERE revision_id = '${REVISION_MAIN}'`,
      ),
    ).toContain('архив согласованной ревизии');
    expect(
      await rejects(`DELETE FROM submission_archives WHERE revision_id = '${REVISION_MAIN}'`),
    ).toContain('архив согласованной ревизии');
    expect(
      await rejects(
        `INSERT INTO submission_archives (revision_id, object_id, contractor_id, s3_key, archive_sha256, byte_size, entry_count, builder_version)
           VALUES ('${REVISION_BROKEN}', '${OBJECT}', '${ORG_CONTRACTOR}', 'archive/x.zip', '${'c'.repeat(64)}', 10, 1, 'archive/1')`,
      ),
    ).toContain('согласованной ревизии');
  });
});

// =====================================================================
// Non-degradable гейт S10: неизменяемость согласованной ревизии
// =====================================================================

describe('неизменяемость согласованной ревизии на уровне БД', () => {
  it('состав поставки не правится ни одним оператором', async () => {
    expect(
      await rejects(
        `UPDATE source_files SET sort_order = 5 WHERE revision_id = '${REVISION_MAIN}'`,
      ),
    ).toContain('ревизия поставки в статусе «approved»');
    expect(
      await rejects(`DELETE FROM source_pages WHERE revision_id = '${REVISION_MAIN}'`),
    ).toContain('approved');
    expect(
      await rejects(
        `INSERT INTO source_files (revision_id, blob_sha256, file_name, sort_order, verify_state)
           VALUES ('${REVISION_MAIN}', '${workingSha}', 'подложенный.pdf', 9, 'ok')`,
      ),
    ).toContain('approved');
    expect(
      await rejects(
        `UPDATE processing_bundles SET working_pdf_blob_sha256 = '${'d'.repeat(64)}' WHERE revision_id = '${REVISION_MAIN}'`,
      ),
    ).toContain('рабочий документ');
  });

  it('производное содержимое согласованной ревизии тоже заперто', async () => {
    expect(
      await rejects(`UPDATE logical_documents SET title = 'подмена' WHERE id = '${DOC_A}'`),
    ).toContain('approved');
    expect(
      await rejects(`DELETE FROM page_assignments WHERE revision_id = '${REVISION_MAIN}'`),
    ).toContain('approved');
    expect(
      await rejects(
        `UPDATE page_assignments SET document_id = '${DOC_B}' WHERE revision_id = '${REVISION_MAIN}'`,
      ),
    ).toContain('approved');
  });

  it('сама строка ревизии не меняется и не переоткрывается', async () => {
    expect(
      await rejects(
        `UPDATE submission_revisions SET status = 'draft' WHERE id = '${REVISION_MAIN}'`,
      ),
    ).toContain('ревизию поставки');
    expect(
      await rejects(
        `UPDATE submission_revisions SET aggregate_manifest_hash = '${'e'.repeat(64)}' WHERE id = '${REVISION_MAIN}'`,
      ),
    ).toContain('согласованную ревизию поставки');
    expect(
      await rejects(`DELETE FROM submission_revisions WHERE id = '${REVISION_MAIN}'`),
    ).toContain('ревизию поставки');
  });

  it('нарезка согласованной ревизии не переписывается', async () => {
    // Прямое следствие: задача 22 после approve исполниться не может, поэтому
    // согласование и требует готовой нарезки (`approveBlockers`).
    expect(
      await rejects(
        `UPDATE logical_documents SET derived_pdf_blob_sha256 = '${'f'.repeat(64)}' WHERE id = '${DOC_A}'`,
      ),
    ).toContain('approved');
  });

  it('запрет узкий: до решения производное содержимое правится свободно', async () => {
    // Урок S2: запрет, заперший больше нужного, лишает проверяющего работы.
    // Ревизия REVISION_BROKEN в статусе `in_review` — инженер обязан иметь
    // возможность править границы и заголовки.
    await testDb.query(
      `UPDATE logical_documents SET title = 'поправленный заголовок' WHERE id = '${DOC_C}'`,
    );
    await testDb.query(
      `UPDATE page_assignments SET sort_order = 7 WHERE revision_id = '${REVISION_BROKEN}' AND source_page_id = '${PAGE(2, 0)}'`,
    );
    expect(
      await count(
        `SELECT count(*)::int AS value FROM logical_documents WHERE id = '${DOC_C}' AND title = 'поправленный заголовок'`,
      ),
    ).toBe(1);

    // А вот состав поставки заперт уже с момента подачи, а не с решения.
    expect(
      await rejects(
        `UPDATE source_files SET sort_order = 3 WHERE revision_id = '${REVISION_BROKEN}'`,
      ),
    ).toContain('in_review');
  });
});
