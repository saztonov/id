/**
 * Две кнопки конвейера через HTTP на собранном приложении (S21).
 *
 * Поднимается штатный `buildApp()`; ни одна функция репозитория не вызывается
 * напрямую. Проверяется не «эндпоинт отвечает 202», а последствия — по ТАБЛИЦАМ,
 * потому что весь смысл этих кнопок в том, что за одним нажатием встаёт
 * несколько задач:
 *
 * 1. **«Разметить» без рабочего документа ставит сборку с признаком
 *    продолжения.** Прежний гранулярный маршрут в этом месте отвечал 409, и
 *    именно этот отказ кнопка обязана убрать — иначе кнопок снова две.
 * 2. **«Разметить» при готовом рабочем документе размечает сразу**, не гоняя
 *    сборку второй раз.
 * 3. **«Проверить» замораживает черновую разметку сама** и ставит распознавание
 *    с признаком сквозного прогона: без признака цепочка оборвалась бы после
 *    распознавания, и «Проверить» не проверяла бы.
 * 4. **«Проверить» без разметки отказывает внятно**, называя первую кнопку.
 * 5. **Повторное нажатие при идущем распознавании не плодит второй прогон.**
 * 6. **Изоляция** (§1.6, non-degradable): чужая ревизия недостижима обеими
 *    кнопками.
 * 7. **Право `pipeline.run` выдано всем пяти ролям** — проверяется на инженере,
 *    которому до S21 состав ревизии был закрыт наглухо.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

// =====================================================================
// Фикстура
// =====================================================================

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_A = id(2);
const ORG_B = id(3);
const OBJECT = id(4);

/** Комплект с готовым рабочим документом: «Проверить» идёт по нему. */
const WORK_READY = id(10);
const REVISION_READY = id(11);
/** Комплект с файлами, но без рабочего документа: «Разметить» ставит сборку. */
const WORK_BARE = id(12);
const REVISION_BARE = id(13);
/** Чужой комплект: недостижим обеими кнопками. */
const WORK_OTHER = id(14);
const REVISION_OTHER = id(15);
/** Комплект с ЧЕРНОВОЙ разметкой и МЁРТВОЙ задачей детекции: кнопка не заперта. */
const WORK_STUCK = id(16);
const REVISION_STUCK = id(17);
/** Комплект для проверки shadow-режима: dry-run отказывает, а не молчит. */
const WORK_DRY = id(18);
const REVISION_DRY = id(19);

const USER_A = id(20);
const USER_B = id(21);
const USER_ENGINEER = id(22);

const FILE_READY = id(30);
const FILE_BARE = id(31);
const FILE_OTHER = id(32);
const FILE_STUCK = id(33);
const PAGE_READY = id(40);
const PAGE_BARE = id(41);
const PAGE_OTHER = id(42);
const PAGE_STUCK = id(43);
const BUNDLE_READY = id(50);
const LAYOUT_READY = id(51);
const BLOCK_READY = id(52);
const BUNDLE_STUCK = id(53);
const LAYOUT_STUCK = id(54);
const BLOCK_STUCK = id(55);
const FILE_DRY = id(34);
const PAGE_DRY = id(44);
const BUNDLE_DRY = id(56);
const LAYOUT_DRY = id(57);
const BLOCK_DRY = id(58);

const SHA_READY = 'a'.repeat(64);
const SHA_WORKING = 'b'.repeat(64);
const SHA_BARE = 'c'.repeat(64);
const SHA_OTHER = 'd'.repeat(64);
const SHA_STUCK = 'e'.repeat(64);
const SHA_DRY = 'f'.repeat(64);

/** Коды промптов стадии recognize: без них распознавание не запускается. */
const RECOGNIZE_PROMPTS = [
  'recognition_block_text',
  'recognition_block_image',
  'recognition_block_stamp',
] as const;

const VLM_MODEL = 'qwen/qwen3-vl-235b';

const KC = {
  a: 'kc-pipeline-a',
  b: 'kc-pipeline-b',
  engineer: 'kc-pipeline-engineer',
} as const;

/**
 * Хэш манифеста считается тем же кодом, что и в бою.
 *
 * Захардкоженное значение разошлось бы с `computeAggregateManifestHash()`
 * молча, и маршрут «Разметить» счёл бы готовый рабочий документ чужим
 * составом — то есть проверял бы не ту ветку, ради которой написан.
 */
let manifestHash: (sha: string) => string;

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-pipeline-tests-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-pipeline-tests-0123456',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-pipeline-tests',
  RATE_LIMIT_MAX: '100000',
  LLM_MODEL_ALLOWLIST: VLM_MODEL,
});

let db: TestDatabase;
let app: AppInstance;

beforeAll(async () => {
  const { computeAggregateManifestHash } = await import('../../db/repositories/bundles.js');
  manifestHash = (sha: string) => computeAggregateManifestHash([{ blobSha256: sha, sortOrder: 0 }]);

  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }

  const fixture: readonly string[] = [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_A}', 'ООО «Подрядчик А»', 'contractor')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_B}', 'ООО «Подрядчик Б»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,

    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_A}', '${KC.a}', 'Сотрудник А', '${ORG_A}')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_B}', '${KC.b}', 'Сотрудник Б', '${ORG_B}')`,
    `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_A}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_B}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
    `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_A}') ON CONFLICT DO NOTHING`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_B}') ON CONFLICT DO NOTHING`,

    // --- Комплект с готовым рабочим документом и черновой разметкой ---
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
       VALUES ('${WORK_READY}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Готовый комплект', '${USER_A}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION_READY}', '${WORK_READY}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA_READY}', 'blobs/${SHA_READY}', 2048, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA_WORKING}', 'blobs/${SHA_WORKING}', 4096, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE_READY}', '${REVISION_READY}', '${SHA_READY}', 'АОСР.pdf', 0, 'ok')`,
    `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
       VALUES ('${PAGE_READY}', '${REVISION_READY}', '${FILE_READY}', 0, 0, 1654, 2339, 0)`,

    // --- Комплект без рабочего документа ---
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
       VALUES ('${WORK_BARE}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Комплект без сборки', '${USER_A}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION_BARE}', '${WORK_BARE}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA_BARE}', 'blobs/${SHA_BARE}', 1024, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE_BARE}', '${REVISION_BARE}', '${SHA_BARE}', 'Без сборки.pdf', 0, 'ok')`,
    `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
       VALUES ('${PAGE_BARE}', '${REVISION_BARE}', '${FILE_BARE}', 0, 0, 1654, 2339, 0)`,

    // --- Чужой комплект ---
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
       VALUES ('${WORK_OTHER}', '${OBJECT}', '${ORG_B}', '${ORG_B}', 'roofing', DATE '2026-01-01', 'Чужой комплект', '${USER_B}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION_OTHER}', '${WORK_OTHER}', '${OBJECT}', '${ORG_B}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA_OTHER}', 'blobs/${SHA_OTHER}', 512, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE_OTHER}', '${REVISION_OTHER}', '${SHA_OTHER}', 'Чужой.pdf', 0, 'ok')`,
    `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
       VALUES ('${PAGE_OTHER}', '${REVISION_OTHER}', '${FILE_OTHER}', 0, 0, 1654, 2339, 0)`,

    // --- Комплект с черновой разметкой и мёртвой задачей детекции ---
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
       VALUES ('${WORK_STUCK}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Комплект с мёртвой детекцией', '${USER_A}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION_STUCK}', '${WORK_STUCK}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA_STUCK}', 'blobs/${SHA_STUCK}', 1024, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE_STUCK}', '${REVISION_STUCK}', '${SHA_STUCK}', 'Застрявший.pdf', 0, 'ok')`,
    `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
       VALUES ('${PAGE_STUCK}', '${REVISION_STUCK}', '${FILE_STUCK}', 0, 0, 1654, 2339, 0)`,

    // --- Комплект для проверки shadow-режима ---
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
       VALUES ('${WORK_DRY}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Комплект для shadow-режима', '${USER_A}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION_DRY}', '${WORK_DRY}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA_DRY}', 'blobs/${SHA_DRY}', 1024, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE_DRY}', '${REVISION_DRY}', '${SHA_DRY}', 'Теневой.pdf', 0, 'ok')`,
    `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
       VALUES ('${PAGE_DRY}', '${REVISION_DRY}', '${FILE_DRY}', 0, 0, 1654, 2339, 0)`,

    // Распознавание — через VLM: у ветки RD WEB нет RD-документа, и прогон
    // отказал бы по причине, к этим маршрутам отношения не имеющей.
    `INSERT INTO app_settings (key, value) VALUES ('recognition.provider', '"openrouter_vlm"')`,
    `INSERT INTO app_settings (key, value) VALUES ('recognition.vlm_model', '"${VLM_MODEL}"')`,
  ];

  for (const statement of fixture) {
    await db.query(statement);
  }

  // Рабочий документ готового комплекта — с НАСТОЯЩИМ хэшем манифеста.
  await db.query(
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE_READY}', '${REVISION_READY}', '${manifestHash(SHA_READY)}', '${SHA_WORKING}', 'bundle/1+pdf-lib')`,
  );
  await db.query(
    `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
       VALUES ('${BUNDLE_READY}', '${REVISION_READY}', 0, '${PAGE_READY}')`,
  );
  await db.query(
    `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
       VALUES ('${LAYOUT_READY}', '${REVISION_READY}', '${OBJECT}', '${BUNDLE_READY}', 1, 'draft')`,
  );
  await db.query(
    `INSERT INTO layout_blocks
       (id, layout_revision_id, revision_id, bundle_id, source_page_id, working_page_index, object_id,
        block_type, shape_type, x0, y0, x1, y1, sort_order, source, detector_provenance)
       VALUES ('${BLOCK_READY}', '${LAYOUT_READY}', '${REVISION_READY}', '${BUNDLE_READY}', '${PAGE_READY}', 0,
               '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.4, 0, 'auto', 'rf_detr')`,
  );

  // Тот же комплект для ревизии с мёртвой детекцией.
  await db.query(
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE_STUCK}', '${REVISION_STUCK}', '${manifestHash(SHA_STUCK)}', '${SHA_WORKING}', 'bundle/1+pdf-lib')`,
  );
  await db.query(
    `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
       VALUES ('${BUNDLE_STUCK}', '${REVISION_STUCK}', 0, '${PAGE_STUCK}')`,
  );
  await db.query(
    `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
       VALUES ('${LAYOUT_STUCK}', '${REVISION_STUCK}', '${OBJECT}', '${BUNDLE_STUCK}', 1, 'draft')`,
  );
  await db.query(
    `INSERT INTO layout_blocks
       (id, layout_revision_id, revision_id, bundle_id, source_page_id, working_page_index, object_id,
        block_type, shape_type, x0, y0, x1, y1, sort_order, source, detector_provenance)
       VALUES ('${BLOCK_STUCK}', '${LAYOUT_STUCK}', '${REVISION_STUCK}', '${BUNDLE_STUCK}', '${PAGE_STUCK}', 0,
               '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.4, 0, 'auto', 'rf_detr')`,
  );
  // Тот же комплект для проверки shadow-режима.
  await db.query(
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE_DRY}', '${REVISION_DRY}', '${manifestHash(SHA_DRY)}', '${SHA_WORKING}', 'bundle/1+pdf-lib')`,
  );
  await db.query(
    `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
       VALUES ('${BUNDLE_DRY}', '${REVISION_DRY}', 0, '${PAGE_DRY}')`,
  );
  await db.query(
    `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
       VALUES ('${LAYOUT_DRY}', '${REVISION_DRY}', '${OBJECT}', '${BUNDLE_DRY}', 1, 'draft')`,
  );
  await db.query(
    `INSERT INTO layout_blocks
       (id, layout_revision_id, revision_id, bundle_id, source_page_id, working_page_index, object_id,
        block_type, shape_type, x0, y0, x1, y1, sort_order, source, detector_provenance)
       VALUES ('${BLOCK_DRY}', '${LAYOUT_DRY}', '${REVISION_DRY}', '${BUNDLE_DRY}', '${PAGE_DRY}', 0,
               '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.4, 0, 'auto', 'rf_detr')`,
  );

  // Пачка детекции, исчерпавшая попытки. Ровно то, что осталось в проде от
  // предыдущего нажатия: такие задачи не имеют права запереть кнопку навсегда.
  await db.query(
    `INSERT INTO jobs (type, payload, status, attempts, max_attempts, last_error)
       VALUES ('layout.detect_local',
               '{"revisionId": "${REVISION_STUCK}", "layoutRevisionId": "${LAYOUT_STUCK}", "pageIndices": [0]}'::jsonb,
               'failed', 3, 3, 'Замороженная разметка не принимает результаты детекции')`,
  );

  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 180_000);

/** «Детекция закончилась»: воркера в тесте нет, задачи закрываются руками. */
async function finishLayoutJobs(revisionId: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET status = 'done'
      WHERE payload->>'revisionId' = '${revisionId}'
        AND status IN ('queued', 'running')`,
  );
}

afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// =====================================================================
// Вход и запросы
// =====================================================================

type Method = 'GET' | 'POST';

interface SignedIn {
  readonly cookie: string;
  readonly csrfToken: string;
}

function cookieOf(response: LightMyRequestResponse, name: string): string {
  const found = response.cookies.filter((cookie) => cookie.name === name).at(-1);
  if (found === undefined || found.value === '') throw new Error(`В ответе нет cookie ${name}`);
  return found.value;
}

function cookieHeader(response: LightMyRequestResponse, name: string): string {
  return `${name}=${encodeURIComponent(cookieOf(response, name))}`;
}

function locationOf(response: LightMyRequestResponse): string {
  const value = response.headers['location'];
  if (typeof value !== 'string') throw new Error('В ответе нет заголовка location');
  return value;
}

async function signIn(kcSub: string): Promise<SignedIn> {
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${encodeURIComponent(kcSub)}`,
  });
  const authorizationUrl = new URL(locationOf(started));
  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
  });
  return {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
}

const signedIn = new Map<string, SignedIn>();

async function as(
  kcSub: string,
  method: Method,
  url: string,
  options: { readonly idempotencyKey?: string; readonly body?: Record<string, unknown> } = {},
): Promise<LightMyRequestResponse> {
  let session = signedIn.get(kcSub);
  if (session === undefined) {
    session = await signIn(kcSub);
    signedIn.set(kcSub, session);
  }
  const payload = options.body;
  return app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    // Тело подставляется только когда оно есть: `payload: undefined` заставил бы
    // inject выставить content-type, и запрос перестал бы быть «нажатием без
    // тела», которое проверяет отрицательный контроль.
    ...(payload === undefined ? {} : { payload }),
  });
}

interface JobRow {
  readonly type: string;
  readonly payload: { readonly autoContinue?: boolean; readonly startMarkup?: boolean };
}

async function jobsOf(revisionId: string): Promise<readonly JobRow[]> {
  return db.query<JobRow>(
    `SELECT type, payload FROM jobs WHERE payload->>'revisionId' = '${revisionId}' ORDER BY type`,
  );
}

async function layoutStateOf(layoutId: string): Promise<string> {
  const rows = await db.query<{ state: string }>(
    `SELECT state FROM layout_revisions WHERE id = '${layoutId}'`,
  );
  return rows[0]?.state ?? 'нет строки';
}

/** Снимок набора блоков: его пишет СТАРТ прогона распознавания (0048). */
async function blocksHashOf(layoutId: string): Promise<string | null> {
  const rows = await db.query<{ blocks_hash: string | null }>(
    `SELECT blocks_hash FROM layout_revisions WHERE id = '${layoutId}'`,
  );
  return rows[0]?.blocks_hash ?? null;
}

// =====================================================================
// Кнопка «Разметить»
// =====================================================================

describe('POST /revisions/{id}/markup', () => {
  it('без рабочего документа ставит сборку с признаком продолжения разметкой', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_BARE}/markup`);
    expect(response.statusCode).toBe(202);

    const body = response.json<{ bundleReady: boolean; layoutRevisionId: string | null }>();
    expect(body.bundleReady).toBe(false);
    expect(body.layoutRevisionId).toBeNull();

    // Признак в payload — единственное, что отличает эту сборку от нажатия
    // «Собрать рабочий документ»: по нему обработчик поставит `layout.start`.
    const jobs = await jobsOf(REVISION_BARE);
    const build = jobs.find((job) => job.type === 'bundle.build');
    expect(build).toBeDefined();
    expect(build?.payload.startMarkup).toBe(true);
  });

  it('при готовом рабочем документе размечает сразу, без второй сборки', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_READY}/markup`);
    expect(response.statusCode).toBe(202);

    const body = response.json<{ bundleReady: boolean; layoutRevisionId: string | null }>();
    expect(body.bundleReady).toBe(true);
    // Черновик разметки у ревизии уже есть — берётся он, а не создаётся второй.
    expect(body.layoutRevisionId).toBe(LAYOUT_READY);

    const jobs = await jobsOf(REVISION_READY);
    expect(jobs.some((job) => job.type === 'bundle.build')).toBe(false);
    expect(jobs.some((job) => job.type.startsWith('rd.') || job.type.startsWith('layout.'))).toBe(
      true,
    );
  });

  it('чужая ревизия недостижима', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_OTHER}/markup`);
    expect(response.statusCode).toBe(404);
  });
});

// =====================================================================
// Кнопка «Проверить»
// =====================================================================

describe('POST /revisions/{id}/check', () => {
  /**
   * Промпты стадии recognize этот файл НЕ публикует — ни здесь, ни где-либо ещё,
   * и это утверждение, а не упущение.
   *
   * Сид-миграция кладёт три кода черновиками, и раньше кнопка на этом отказывала:
   * распознавание требовало ручной публикации текста, который лежит в коде и из
   * которого сама миграция и сгенерирована. Теперь отсутствие опубликованной
   * версии означает «взят встроенный текст», поэтому каждый успешный прогон ниже
   * по файлу доказывает заодно и это.
   */
  it('промпты стадии recognize остались черновиками — и это ничему не мешает', async () => {
    const rows = await db.query<{ code: string; state: string }>(
      `SELECT code, state FROM prompt_templates
        WHERE code IN (${RECOGNIZE_PROMPTS.map((code) => `'${code}'`).join(', ')})`,
    );
    // Версий у кода может быть несколько: правка промпта приезжает НОВОЙ
    // сид-миграцией (применённый файл защищён контрольной суммой мигратора).
    // Утверждение здесь не про их число, а про то, что ни одна не опубликована.
    expect([...new Set(rows.map((row) => row.code))].sort()).toEqual([...RECOGNIZE_PROMPTS].sort());
    expect(rows.every((row) => row.state === 'draft')).toBe(true);
  });

  it('без разметки отказывает и называет первую кнопку', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_BARE}/check`, {
      idempotencyKey: 'check-bare-1',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('Разметить');
  });

  it('не отправляет на распознавание, пока детекция ещё идёт', async () => {
    // Задачи стадии разметки стоят в очереди с нажатия «1. Выделить блоки» выше
    // по файлу: прогон, стартовавший сейчас, снял бы снимок половины набора, а
    // доложенные позже блоки остались бы нераспознанными.
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_READY}/check`, {
      idempotencyKey: 'check-detecting-1',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('Выделение блоков ещё идёт');

    expect(await layoutStateOf(LAYOUT_READY)).toBe('draft');
  });

  it('мёртвая задача детекции кнопку не запирает', async () => {
    // В проде на момент разбора висели 34 задачи «исчерпали попытки». Если бы они
    // считались незаконченной работой, кнопка была бы заперта навсегда.
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_STUCK}/check`, {
      idempotencyKey: 'check-stuck-1',
    });
    expect(response.statusCode).toBe(202);
    expect(response.json<{ stage: string }>().stage).toBe('recognition');
    expect(await blocksHashOf(LAYOUT_STUCK)).not.toBeNull();
  });

  it('ставит распознавание со сквозным признаком, не трогая состояние разметки', async () => {
    await finishLayoutJobs(REVISION_READY);
    expect(await layoutStateOf(LAYOUT_READY)).toBe('draft');

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_READY}/check`, {
      idempotencyKey: 'check-ready-1',
    });
    expect(response.statusCode).toBe(202);

    const body = response.json<{
      stage: string;
      recognitionRunId: string | null;
    }>();
    expect(body.stage).toBe('recognition');
    expect(body.recognitionRunId).not.toBeNull();

    // Разметка осталась правимой, а снимок набора блоков записан прогоном.
    expect(await layoutStateOf(LAYOUT_READY)).toBe('draft');
    expect(await blocksHashOf(LAYOUT_READY)).not.toBeNull();

    // Признак сквозного прогона — то, ради чего кнопка существует: без него
    // цепочка встала бы после распознавания, и «Проверить» не проверяла бы.
    const jobs = await jobsOf(REVISION_READY);
    const head = jobs.find((job) => job.type === 'vlm.start_recognition');
    expect(head).toBeDefined();
    expect(head?.payload.autoContinue).toBe(true);
  });

  it('повторное нажатие при идущем распознавании не плодит второй прогон', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_READY}/check`, {
      idempotencyKey: 'check-ready-2',
    });
    expect(response.statusCode).toBe(409);

    const runs = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM recognition_runs WHERE revision_id = '${REVISION_READY}'`,
    );
    expect(Number(runs[0]?.count ?? 0)).toBe(1);
  });

  it('заголовок идемпотентности обязателен', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_READY}/check`);
    expect(response.statusCode).toBe(400);
  });

  it('чужая ревизия недостижима', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_OTHER}/check`, {
      idempotencyKey: 'check-other-1',
    });
    // 409 «разметки нет» тоже был бы утечкой: он отличал бы существующую чужую
    // ревизию от несуществующей. Область отсекает раньше.
    expect(response.statusCode).toBe(404);
  });
});

// =====================================================================
// Права
// =====================================================================

describe('право pipeline.run', () => {
  it('инженеру объекта обе кнопки доступны', async () => {
    // До S21 инженер получал 403 на любой правке состава. Кнопки конвейера
    // правят производное и открыты ему наравне с подрядчиком.
    const markup = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_BARE}/markup`);
    expect(markup.statusCode).toBe(202);

    const check = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_BARE}/check`, {
      idempotencyKey: 'check-engineer-1',
    });
    // 409 «разметки нет», а не 403: право есть, не хватает разметки.
    expect(check.statusCode).toBe(409);
  });
});

// =====================================================================
// Прогресс распознавания
// =====================================================================

describe('GET /recognition-runs/{id}/progress', () => {
  it('отдаёт постраничные счётчики прогона', async () => {
    const runs = await db.query<{ id: string }>(
      `SELECT id FROM recognition_runs WHERE revision_id = '${REVISION_READY}' LIMIT 1`,
    );
    const runId = runs[0]?.id ?? '';
    expect(runId).not.toBe('');

    // Страницы сидирует `vlm.start_recognition`; здесь она вписывается прямо,
    // потому что проверяется ВЫДАЧА, а не то, кто её заполнил.
    await db.query(
      `INSERT INTO recognition_run_pages
         (recognition_run_id, working_page_index, status, blocks_total, blocks_recognized, blocks_invalid, blocks_refused)
         VALUES ('${runId}', 0, 'done', 4, 3, 1, 0)`,
    );
    await db.query(
      `INSERT INTO recognition_run_pages
         (recognition_run_id, working_page_index, status, blocks_total, blocks_recognized, blocks_invalid, blocks_refused)
         VALUES ('${runId}', 1, 'pending', 2, 0, 0, 0)`,
    );

    const response = await as(KC.a, 'GET', `/api/v1/recognition-runs/${runId}/progress`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recognitionRunId: runId,
      pagesTotal: 2,
      pagesDone: 1,
      pagesPending: 1,
      pagesFailed: 0,
      blocksTotal: 6,
      blocksRecognized: 3,
      blocksInvalid: 1,
    });
  });

  it('чужой прогон недостижим', async () => {
    const runs = await db.query<{ id: string }>(
      `SELECT id FROM recognition_runs WHERE revision_id = '${REVISION_READY}' LIMIT 1`,
    );
    const response = await as(
      KC.b,
      'GET',
      `/api/v1/recognition-runs/${runs[0]?.id ?? ''}/progress`,
    );
    expect(response.statusCode).toBe(404);
  });
});

// =====================================================================
// Shadow-режим (ADR-0007): dry-run отказывает вслух и не запирает разметку
// =====================================================================

/**
 * Три следствия одного дефекта, каждое проверено отдельно.
 *
 * Прогон в режиме `ai.dry_run_only` выполняется целиком и закрывается ЧЕСТНЫМ
 * `done`, но публикацию пропускает: `page_text_versions` после него нет ни
 * одной. Пока «распознано» проверялось статусом, это давало на стенде картину,
 * из которой не было выхода: кнопка срабатывала, модель отрабатывала комплект,
 * деньги тратились — и вкладка «Проверка» оставалась пустой, потому что анализу
 * нечего было читать. Повторное нажатие отвечало «для повторного распознавания
 * нужна новая ревизия разметки», а завести её было нечем — тот же тупик, из-за
 * которого заморозка в итоге и отменена (0048).
 *
 * Набор идёт в СТРОГОМ режиме намеренно — `done` вычисляется только при
 * `enforceGates`, и в режиме тестирования утверждения ниже проверяли бы не то.
 */
describe('POST /revisions/{id}/check в shadow-режиме', () => {
  const setDryRun = async (value: boolean): Promise<void> => {
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('ai.dry_run_only', '${String(value)}'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
  };

  it('dry-run отказывает ДО правки разметки и объясняет, чем это кончится', async () => {
    await setDryRun(true);

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_DRY}/check`, {
      idempotencyKey: 'check-dry-1',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('dry-run');
    // Отказ обязан быть ДО правки разметки: снятый остаток детекции и
    // доклеенные полностраничные блоки — изменения, сделанные ни за что.
    expect(await layoutStateOf(LAYOUT_DRY)).toBe('draft');
    // И ни одного прогона: сквозной путь не начат вовсе.
    const runs = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM recognition_runs WHERE revision_id = '${REVISION_DRY}'`,
    );
    expect(Number(runs[0]?.count ?? 0)).toBe(0);
  });

  it('с выключенным dry-run та же кнопка проходит', async () => {
    await setDryRun(false);
    await finishLayoutJobs(REVISION_DRY);

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_DRY}/check`, {
      idempotencyKey: 'check-dry-2',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<{ stage: string }>().stage).toBe('recognition');
    expect(await blocksHashOf(LAYOUT_DRY)).not.toBeNull();
  });

  it('завершённый БЕЗ публикации прогон не запирает разметку', async () => {
    // Прогон закрывается ровно так, как его закрывает финализация в dry-run:
    // статус `done`, счётчики на месте, `page_text_versions` — ни одной.
    await db.query(
      `UPDATE recognition_runs SET status = 'done', finished_at = now()
        WHERE revision_id = '${REVISION_DRY}'`,
    );

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_DRY}/check`, {
      idempotencyKey: 'check-dry-3',
    });

    // Прежде здесь было 409 «для повторного распознавания нужна новая ревизия
    // разметки» — тупик, из которого нет выхода.
    expect(response.statusCode).toBe(202);
    expect(response.json<{ stage: string }>().stage).toBe('recognition');

    const runs = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM recognition_runs WHERE revision_id = '${REVISION_DRY}'`,
    );
    expect(Number(runs[0]?.count ?? 0)).toBe(2);
  });

  it('опубликованный прогон стадию закрывает: следующее нажатие идёт к анализу', async () => {
    const runs = await db.query<{ id: string }>(
      `SELECT id FROM recognition_runs
        WHERE revision_id = '${REVISION_DRY}' AND status = 'running' ORDER BY started_at DESC`,
    );
    const runId = runs[0]?.id;
    expect(runId).toBeDefined();

    // Настоящая публикация: артефакт прогона и версия текста страницы. Именно
    // их существование, а не статус, и означает «распознано».
    const artifact = id(90);
    await db.query(
      `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
         VALUES ('${artifact}', '${runId ?? ''}', 'blocks_json', 'artifacts/dry.json', '${'1'.repeat(64)}', 128)`,
    );
    await db.query(
      `INSERT INTO page_text_versions
         (revision_id, source_page_id, recognition_run_id, artifact_version_id, text_md, text_sha256)
         VALUES ('${REVISION_DRY}', '${PAGE_DRY}', '${runId ?? ''}', '${artifact}', 'текст', '${'2'.repeat(64)}')`,
    );
    await db.query(
      `UPDATE recognition_runs SET status = 'done', finished_at = now() WHERE id = '${runId ?? ''}'`,
    );

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_DRY}/check`, {
      idempotencyKey: 'check-dry-4',
    });

    expect(response.statusCode).toBe(202);
    // Стадия распознавания пройдена — маршрут идёт к разбору документов.
    expect(response.json<{ stage: string }>().stage).toBe('analysis');
  });
});

// =====================================================================
// Выбор режима повторного распознавания (S40)
// =====================================================================

/**
 * Комплект `REVISION_DRY` дошёл сюда с ОПУБЛИКОВАННЫМ распознаванием: набор
 * выше довёл его до состояния «стадия пройдена, следующее нажатие идёт к
 * анализу». Это ровно то состояние, в котором и появляется выбор, — и ровно
 * то, в котором до S40 повторное нажатие модель не звало ни при каких
 * обстоятельствах.
 *
 * Набор идёт ДО режима тестирования: `full` обязан работать и в строгом режиме,
 * иначе пункт бесполезен там, где он нужен, — на боевом портале.
 */
describe('POST /revisions/{id}/check с выбором режима', () => {
  it('нажатие без тела остаётся прежним нажатием', async () => {
    // Отрицательный контроль: `mode` необязателен, и вызывающие, которые о нём
    // не знают, обязаны получать ровно прежнее поведение.
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_DRY}/check`, {
      idempotencyKey: 'check-mode-absent',
    });

    expect(response.statusCode).toBe(202);
  });

  it('«только ошибки» на комплекте без замечаний доходит до правил и говорит об этом', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_DRY}/check`, {
      idempotencyKey: 'check-mode-errors',
      body: { mode: 'errors' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<{ stage: string; retriedPages?: number }>();
    // Перечитывать нечего — прогон продолжается разбором, а не молча ничем.
    expect(body.stage).not.toBe('recognition');
    expect(body.retriedPages).toBe(0);
  });

  it('«полностью» зовёт распознавание заново и родителя себе не берёт', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_DRY}/check`, {
      idempotencyKey: 'check-mode-full',
      body: { mode: 'full' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<{ stage: string; repairOfRunId: string | null }>();
    expect(body.stage).toBe('recognition');
    // Перенос результатов — это ровно то, чего «полностью» не делает.
    expect(body.repairOfRunId).toBeNull();
  });

  it('«полностью» сносит прежние прогоны, а не кладёт новый поверх', async () => {
    const runs = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM recognition_runs WHERE revision_id = '${REVISION_DRY}'`,
    );
    expect(Number(runs[0]?.count ?? 0)).toBe(1);
  });
});

// =====================================================================
// Режим тестирования: конвейер не отказывает
// =====================================================================

/**
 * Выключатель ADR-0015 распространён на гейты конвейера.
 *
 * Набор идёт ПОСЛЕДНИМ и настройку обратно не возвращает: она глобальная, и
 * тесты выше проверяют строгий режим на той же базе. Порядок здесь — часть
 * фикстуры, а не случайность.
 *
 * Предмет — ровно то, чем заказчик упёрся на стенде: «можно отправлять на
 * распознавание идущие выделения», «повторное распознавание просто заменяет
 * предыдущее, не создаёт новую ревизию».
 */
describe('POST /revisions/{id}/check при выключенной неизменяемости', () => {
  beforeAll(async () => {
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('core.enforce_immutability', 'false'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
  });

  it('повторное выделение блоков перезаписывает разметку, а не заводит следующую', async () => {
    // REVISION_STUCK пришла сюда с ЗАМОРОЖЕННОЙ разметкой и прогоном по ней:
    // в строгом режиме это ровно тот случай, когда заводилась «Ревизия 2».
    expect(await blocksHashOf(LAYOUT_STUCK)).not.toBeNull();

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_STUCK}/markup`);
    expect(response.statusCode).toBe(202);

    const body = response.json<{ layoutRevisionId: string | null }>();
    expect(body.layoutRevisionId).toBe(LAYOUT_STUCK);
    expect(await layoutStateOf(LAYOUT_STUCK)).toBe('draft');

    const layouts = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_revisions WHERE revision_id = '${REVISION_STUCK}'`,
    );
    expect(Number(layouts[0]?.count ?? 0)).toBe(1);

    // Сброс снёс производное прежнего распознавания: без него детекция упёрлась
    // бы в block_results.layout_block_id ON DELETE RESTRICT.
    const runs = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM recognition_runs WHERE revision_id = '${REVISION_STUCK}'`,
    );
    expect(Number(runs[0]?.count ?? 0)).toBe(0);
  });

  it('идущая детекция не отказ, а отмена остатка', async () => {
    // Задачи детекции от нажатия выше стоят в очереди.
    const before = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM jobs
        WHERE payload->>'revisionId' = '${REVISION_STUCK}' AND status IN ('queued', 'running')`,
    );
    expect(Number(before[0]?.count ?? 0)).toBeGreaterThan(0);

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_STUCK}/check`, {
      idempotencyKey: 'check-soft-1',
    });
    expect(response.statusCode).toBe(202);
    expect(await blocksHashOf(LAYOUT_STUCK)).not.toBeNull();

    // Остаток снят явно: пачки, которые доложили бы блоки уже после снимка
    // набора, в очереди не остаются.
    const layoutPending = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM jobs
        WHERE payload->>'revisionId' = '${REVISION_STUCK}'
          AND type LIKE 'layout.%' AND status IN ('queued', 'running')`,
    );
    expect(Number(layoutPending[0]?.count ?? 0)).toBe(0);
  });

  it('повторное распознавание заменяет прежний прогон, а не отказывает', async () => {
    const before = await db.query<{ id: string }>(
      `SELECT id FROM recognition_runs
        WHERE revision_id = '${REVISION_STUCK}' AND status = 'running'`,
    );
    expect(before).toHaveLength(1);

    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_STUCK}/check`, {
      idempotencyKey: 'check-soft-2',
    });
    expect(response.statusCode).toBe(202);
    expect(response.json<{ stage: string }>().stage).toBe('recognition');

    // Прогон ровно один — новый. Прежний снесён сбросом вместе со своими
    // страницами: «заменяет предыдущее» здесь буквально.
    const after = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM recognition_runs WHERE revision_id = '${REVISION_STUCK}'`,
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('running');
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });
});
