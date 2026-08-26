/**
 * Разметка через HTTP на собранном приложении (§6.1, §7, §14).
 *
 * Поднимается штатный `buildApp()`; ни одна функция репозитория не вызывается
 * напрямую. Проверяется не «эндпоинт отвечает 202», а последствия:
 *
 * 1. **Кнопка «Разметить файл» кладёт строку в `jobs`.** Это прямой урок S5, где
 *    обработчики задач были написаны и зарегистрированы, а постановки не
 *    существовало вовсе — конвейер §12 не запускался, и все тесты были
 *    зелёными.
 * 2. **`If-Match` обязателен, конфликт версий даёт 412**, а не молчаливую
 *    перезапись (§7.2).
 * 3. **`full-page-text` блокируется после первой ручной правки** — он удаляет
 *    прежние блоки страницы (§5.3, подтверждено чтением `blocks_bulk.py`).
 * 4. **Полностраничный блок не появляется сам.** Замена страницы одним блоком —
 *    отдельный маршрут и отдельное действие пользователя.
 * 5. **Изоляция подрядчиков** (§1.6, non-degradable): чужая разметка не видна
 *    ни списком, ни по прямому идентификатору, ни на правке.
 * 6. **Заморозка пиннит `blocks_hash`** и запирает набор блоков.
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
const ORG_CONTRACTOR = id(2);
const ORG_OTHER = id(3);
const OBJECT = id(4);

const SUBMISSION = id(10);
const REVISION = id(11);
const SUBMISSION_OTHER = id(12);
const REVISION_OTHER = id(13);
const SUBMISSION_BARE = id(14);
const REVISION_BARE = id(15);

const USER_CONTRACTOR = id(20);
const USER_OTHER = id(21);
const USER_ENGINEER = id(22);
const USER_MANAGER = id(23);

const FILE = id(30);
const FILE_OTHER = id(31);

const PAGE_0 = id(40);
const PAGE_1 = id(41);
const PAGE_2 = id(42);
const PAGE_OTHER = id(43);

const BUNDLE = id(50);
const BUNDLE_OTHER = id(51);
const LAYOUT_OTHER = id(52);

const SHA = 'a'.repeat(64);
const SHA_WORKING = 'b'.repeat(64);
const SHA_OTHER = 'c'.repeat(64);
const SHA_WORKING_OTHER = 'd'.repeat(64);

const KC = {
  contractor: 'kc-layout-contractor',
  other: 'kc-layout-other',
  engineer: 'kc-layout-engineer',
  manager: 'kc-layout-manager',
} as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_OTHER}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR}', '${KC.contractor}', 'Сотрудник подрядчика А', '${ORG_CONTRACTOR}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_OTHER}', '${KC.other}', 'Сотрудник подрядчика Б', '${ORG_OTHER}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_OTHER}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

  // Своя ревизия: рабочий документ собран, три страницы.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION}', '${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA}', 'blobs/${SHA}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_WORKING}', 'blobs/${SHA_WORKING}', 4096, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE}', '${REVISION}', '${SHA}', 'АОСР.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_0}', '${REVISION}', '${FILE}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_1}', '${REVISION}', '${FILE}', 1, 1, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_2}', '${REVISION}', '${FILE}', 2, 2, 1654, 2339, 0)`,
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE}', '${REVISION}', '${'e'.repeat(64)}', '${SHA_WORKING}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE}', '${REVISION}', 0, '${PAGE_0}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE}', '${REVISION}', 1, '${PAGE_1}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE}', '${REVISION}', 2, '${PAGE_2}')`,

  // Ревизия без рабочего документа: разметку начать нельзя.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_BARE}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка без bundle', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_BARE}', '${SUBMISSION_BARE}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,

  // Чужая поставка с уже существующей разметкой.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_OTHER}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_OTHER}', '${OBJECT}', '${ORG_OTHER}', '${ORG_OTHER}', 'roofing', DATE '2026-01-01', 'Поставка чужая', '${USER_OTHER}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_OTHER}', '${SUBMISSION_OTHER}', '${OBJECT}', '${ORG_OTHER}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_OTHER}', 'blobs/${SHA_OTHER}', 700, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_WORKING_OTHER}', 'blobs/${SHA_WORKING_OTHER}', 700, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_OTHER}', '${REVISION_OTHER}', '${SHA_OTHER}', 'Чужой.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_OTHER}', '${REVISION_OTHER}', '${FILE_OTHER}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_OTHER}', '${REVISION_OTHER}', '${'f'.repeat(64)}', '${SHA_WORKING_OTHER}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_OTHER}', '${REVISION_OTHER}', 0, '${PAGE_OTHER}')`,
  `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
     VALUES ('${LAYOUT_OTHER}', '${REVISION_OTHER}', '${OBJECT}', '${BUNDLE_OTHER}', 1, 'draft')`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-layout-tests-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-layout-tests-01234567890',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-layout-tests',
  RATE_LIMIT_MAX: '100000',
});

let db: TestDatabase;
let app: AppInstance;

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  for (const statement of FIXTURE) {
    await db.query(statement);
  }

  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// =====================================================================
// Вход и запросы
// =====================================================================

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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
  options: { readonly body?: unknown; readonly ifMatch?: number | string } = {},
): Promise<LightMyRequestResponse> {
  let session = signedIn.get(kcSub);
  if (session === undefined) {
    session = await signIn(kcSub);
    signedIn.set(kcSub, session);
  }
  return app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      ...(options.ifMatch !== undefined ? { 'if-match': `"${String(options.ifMatch)}"` } : {}),
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
}

async function queuedTypes(revisionId: string): Promise<readonly string[]> {
  const rows = await db.query<{ type: string }>(
    `SELECT type FROM jobs WHERE payload->>'revisionId' = '${revisionId}' ORDER BY type`,
  );
  return rows.map((row) => row.type);
}

interface StartResponse {
  readonly layoutRevisionId: string;
  readonly bundleId: string;
  readonly created: boolean;
  readonly jobId: string | null;
  readonly jobCreated: boolean;
}

interface LayoutDetail {
  readonly id: string;
  readonly version: number;
  readonly state: string;
  readonly manuallyEdited: boolean;
  readonly blocksHash: string | null;
  readonly blockCount: number;
  readonly pages: readonly { readonly workingPageIndex: number; readonly flags: string[] }[];
}

async function layoutDetail(layoutId: string): Promise<LayoutDetail> {
  const response = await as(KC.contractor, 'GET', `/api/v1/layouts/${layoutId}`);
  expect(response.statusCode).toBe(200);
  return response.json<LayoutDetail>();
}

const RECT = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.4 };

let layoutId = '';

// =====================================================================
// Старт цепочки
// =====================================================================

describe('приём ставит задачи конвейера', () => {
  it('до нажатия кнопки задач разметки в очереди нет', async () => {
    expect(await queuedTypes(REVISION)).not.toContain('rd.create_run_document');
  });

  it('«Разметить файл» создаёт черновик разметки И кладёт строку в jobs', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/revisions/${REVISION}/layout`);
    expect(response.statusCode).toBe(202);

    const body = response.json<StartResponse>();
    expect(body.created).toBe(true);
    expect(body.bundleId).toBe(BUNDLE);
    expect(body.jobCreated).toBe(true);
    layoutId = body.layoutRevisionId;

    // Проверяется ТАБЛИЦА, а не код ответа: на S5 маршрут отвечал успехом,
    // а очередь оставалась пустой.
    expect(await queuedTypes(REVISION)).toContain('rd.create_run_document');

    const payloads = await db.query<{
      payload: { revisionId: string; bundleId: string; layoutRevisionId: string };
    }>(
      `SELECT payload FROM jobs WHERE type = 'rd.create_run_document'
        AND payload->>'revisionId' = '${REVISION}'`,
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.payload.bundleId).toBe(BUNDLE);
    // Цель задачи адресована явно: «текущий черновик этого bundle» за время
    // ожидания в очереди может смениться на следующую ревизию разметки.
    expect(payloads[0]?.payload.layoutRevisionId).toBe(layoutId);
  });

  it('повторное нажатие не создаёт вторую разметку и вторую задачу', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/revisions/${REVISION}/layout`);
    expect(response.statusCode).toBe(202);
    const body = response.json<StartResponse>();
    expect(body.created).toBe(false);
    expect(body.layoutRevisionId).toBe(layoutId);
    expect(body.jobCreated).toBe(false);

    const rows = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM jobs WHERE type = 'rd.create_run_document'
        AND payload->>'revisionId' = '${REVISION}'`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);

    const layouts = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_revisions WHERE revision_id = '${REVISION}'`,
    );
    expect(Number(layouts[0]?.count ?? 0)).toBe(1);
  });

  it('без собранного рабочего документа разметка не начинается', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/revisions/${REVISION_BARE}/layout`);
    expect(response.statusCode).toBe(409);
    expect(await queuedTypes(REVISION_BARE)).not.toContain('rd.create_run_document');
  });

  it('повторная детекция раскладывается на задачи по пачкам', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/detect`, {
      body: {},
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ batches: number; jobIds: string[] }>();
    expect(body.batches).toBe(1);

    const rows = await db.query<{
      payload: { pageIndices: number[]; overwriteExisting?: boolean };
      dedupe_key: string;
    }>(
      `SELECT payload, dedupe_key FROM jobs WHERE type = 'layout.detect_pages'
        AND payload->>'layoutRevisionId' = '${layoutId}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.pageIndices).toEqual([0, 1, 2]);
    // §5.3: «повторить детекцию» — явное действие пользователя, и оно обязано
    // действительно переразмечать. Без флага удалённая сторона вернула бы уже
    // размеченные страницы в skipped_pages, и нажатие кнопки ничего бы не дало.
    expect(rows[0]?.payload.overwriteExisting).toBe(true);
    expect(rows[0]?.dedupe_key).toMatch(/:overwrite$/u);
  });
});

// =====================================================================
// Правка блоков
// =====================================================================

describe('правка блоков идёт через If-Match', () => {
  it('без If-Match мутация отвергается', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 0, blockType: 'text', shapeType: 'rectangle', coords: RECT },
    });
    expect(response.statusCode).toBe(400);
  });

  it('создание блока поднимает версию разметки и отдаёт её в ETag', async () => {
    const before = await layoutDetail(layoutId);
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 0, blockType: 'text', shapeType: 'rectangle', coords: RECT },
      ifMatch: before.version,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ blockId: string; version: number }>();
    expect(body.version).toBe(before.version + 1);
    expect(response.headers['etag']).toBe(`"${String(body.version)}"`);

    const rows = await db.query<{ source: string; detector_provenance: string }>(
      `SELECT source, detector_provenance FROM layout_blocks WHERE id = '${body.blockId}'`,
    );
    // Блок, нарисованный человеком, детектор не порождал: ни выдуманной
    // уверенности, ни `rf_detr` у него быть не может (§0.1).
    expect(rows[0]).toEqual({ source: 'user', detector_provenance: 'user' });
  });

  it('устаревшая версия даёт 412, а не тихую перезапись', async () => {
    const current = await layoutDetail(layoutId);
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 1, blockType: 'text', shapeType: 'rectangle', coords: RECT },
      ifMatch: current.version - 1,
    });
    expect(response.statusCode).toBe(412);
  });

  it('перемещение, смена типа и удаление доступны и версионируются', async () => {
    let detail = await layoutDetail(layoutId);
    const created = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 1, blockType: 'text', shapeType: 'rectangle', coords: RECT },
      ifMatch: detail.version,
    });
    const blockId = created.json<{ blockId: string }>().blockId;

    detail = await layoutDetail(layoutId);
    const moved = await as(
      KC.contractor,
      'PATCH',
      `/api/v1/layouts/${layoutId}/blocks/${blockId}`,
      {
        body: { coords: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.5 }, blockType: 'image' },
        ifMatch: detail.version,
      },
    );
    expect(moved.statusCode).toBe(200);

    const rows = await db.query<{ block_type: string; x0: number }>(
      `SELECT block_type, x0 FROM layout_blocks WHERE id = '${blockId}'`,
    );
    expect(rows[0]?.block_type).toBe('image');
    expect(Number(rows[0]?.x0)).toBeCloseTo(0.2, 6);

    detail = await layoutDetail(layoutId);
    const removed = await as(
      KC.contractor,
      'DELETE',
      `/api/v1/layouts/${layoutId}/blocks/${blockId}`,
      { ifMatch: detail.version },
    );
    expect(removed.statusCode).toBe(200);

    const left = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_blocks WHERE id = '${blockId}'`,
    );
    expect(Number(left[0]?.count ?? 0)).toBe(0);
  });

  it('блок чужой ревизии разметки не правится через адрес своей', async () => {
    // Блок адресуется собственным uuid, поэтому без сверки с `layoutId` из
    // адреса правка ушла бы в другую ревизию разметки, а `If-Match` сверялся бы
    // с версией той, что названа в адресе.
    const detail = await layoutDetail(layoutId);
    const created = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 0, blockType: 'text', shapeType: 'rectangle', coords: RECT },
      ifMatch: detail.version,
    });
    const blockId = created.json<{ blockId: string }>().blockId;

    const response = await as(
      KC.contractor,
      'PATCH',
      `/api/v1/layouts/${LAYOUT_OTHER}/blocks/${blockId}`,
      { body: { blockType: 'stamp' }, ifMatch: 0 },
    );
    expect(response.statusCode).toBe(404);
  });

  it('полигон требует не менее трёх точек', async () => {
    const detail = await layoutDetail(layoutId);
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: {
        workingPageIndex: 2,
        blockType: 'image',
        shapeType: 'polygon',
        coords: RECT,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
        ],
      },
      ifMatch: detail.version,
    });
    expect(response.statusCode).toBe(409);
  });

  it('вырожденная рамка отвергается схемой', async () => {
    const detail = await layoutDetail(layoutId);
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: {
        workingPageIndex: 0,
        blockType: 'text',
        shapeType: 'rectangle',
        coords: { x0: 0.9, y0: 0.1, x1: 0.1, y1: 0.4 },
      },
      ifMatch: detail.version,
    });
    expect(response.statusCode).toBe(422);
  });
});

// =====================================================================
// Полностраничный блок
// =====================================================================

describe('полностраничный блок — только явным действием', () => {
  it('после ручной правки режим full-page-text заблокирован', async () => {
    // К этому моменту разметку уже правил человек (см. предыдущий describe).
    const detail = await layoutDetail(layoutId);
    expect(detail.manuallyEdited).toBe(true);

    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/full-page-text`, {
      ifMatch: detail.version,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('ручной правки');
  });

  it('до ручной правки режим full-page-text РАБОТАЕТ, а не только «не отвергается»', async () => {
    // Проверяется положительный путь: гарда без работающей операции — это
    // защита от несуществующей функции (класс отказа S3/S5). Берётся чужая
    // ревизия чужим пользователем: там разметку ещё никто не правил.
    const started = await as(KC.other, 'POST', `/api/v1/revisions/${REVISION_OTHER}/layout`);
    const fresh = started.json<StartResponse>();

    const applied = await as(
      KC.other,
      'POST',
      `/api/v1/layouts/${fresh.layoutRevisionId}/full-page-text`,
      { ifMatch: 0 },
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ pages: number }>().pages).toBe(1);

    const rows = await db.query<{
      block_type: string;
      detector_provenance: string;
      source: string;
    }>(
      `SELECT block_type, detector_provenance, source FROM layout_blocks
        WHERE layout_revision_id = '${fresh.layoutRevisionId}'`,
    );
    expect(rows).toEqual([
      { block_type: 'text', detector_provenance: 'full_page', source: 'auto' },
    ]);

    const profile = await db.query<{ detector_profile: string }>(
      `SELECT detector_profile FROM layout_revisions WHERE id = '${fresh.layoutRevisionId}'`,
    );
    expect(profile[0]?.detector_profile).toBe('full_page');
  });

  it('замена одной страницы одним блоком — отдельное действие и она доступна', async () => {
    const detail = await layoutDetail(layoutId);
    const response = await as(
      KC.contractor,
      'POST',
      `/api/v1/layouts/${layoutId}/pages/2/replace-with-text`,
      { ifMatch: detail.version },
    );
    expect(response.statusCode).toBe(201);

    const rows = await db.query<{
      block_type: string;
      detector_provenance: string;
      x0: number;
      x1: number;
    }>(
      `SELECT block_type, detector_provenance, x0, x1 FROM layout_blocks
        WHERE layout_revision_id = '${layoutId}' AND working_page_index = 2`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.block_type).toBe('text');
    expect(rows[0]?.detector_provenance).toBe('full_page');
    expect(Number(rows[0]?.x0)).toBe(0);
    expect(Number(rows[0]?.x1)).toBe(1);
  });
});

// =====================================================================
// Изоляция
// =====================================================================

describe('изоляция подрядчиков', () => {
  it('чужая разметка не видна ни списком, ни по прямому идентификатору', async () => {
    const list = await as(KC.other, 'GET', `/api/v1/revisions/${REVISION}/layouts`);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);

    const direct = await as(KC.other, 'GET', `/api/v1/layouts/${layoutId}`);
    expect(direct.statusCode).toBe(404);

    const blocks = await as(KC.other, 'GET', `/api/v1/layouts/${layoutId}/blocks`);
    expect(blocks.statusCode).toBe(404);
  });

  it('чужой блок не правится по прямому идентификатору', async () => {
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM layout_blocks WHERE layout_revision_id = '${layoutId}' LIMIT 1`,
    );
    const blockId = rows[0]?.id ?? '';
    const response = await as(
      KC.other,
      'PATCH',
      `/api/v1/layouts/${LAYOUT_OTHER}/blocks/${blockId}`,
      { body: { blockType: 'stamp' }, ifMatch: 0 },
    );
    expect(response.statusCode).toBe(404);
  });

  it('руководитель разметку читает, но не правит', async () => {
    const read = await as(KC.manager, 'GET', `/api/v1/layouts/${layoutId}`);
    expect(read.statusCode).toBe(200);

    const write = await as(KC.manager, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 0, blockType: 'text', shapeType: 'rectangle', coords: RECT },
      ifMatch: 999,
    });
    expect(write.statusCode).toBe(403);
  });

  it('инженер на назначенном объекте правит разметку подрядчика', async () => {
    const detail = await layoutDetail(layoutId);
    const response = await as(KC.engineer, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 1, blockType: 'stamp', shapeType: 'rectangle', coords: RECT },
      ifMatch: detail.version,
    });
    expect(response.statusCode).toBe(201);
  });
});

// =====================================================================
// Правка не запирается состоянием разметки
// =====================================================================

describe('разметка правится и после отправки на распознавание', () => {
  it('блок добавляется по разметке, у которой уже есть хэш прогона', async () => {
    // Хэш появляется у разметки, когда по ней стартовал прогон распознавания.
    // Прежде он означал заморозку, и правка после него отвечала 409 «исправление
    // — новая ревизия разметки»; выйти из этого состояния было нечем (0048).
    await db.query(
      `UPDATE layout_revisions SET blocks_hash = '${'a'.repeat(64)}' WHERE id = '${layoutId}'`,
    );

    const detail = await layoutDetail(layoutId);
    expect(detail.blocksHash).not.toBeNull();

    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/blocks`, {
      body: { workingPageIndex: 0, blockType: 'text', shapeType: 'rectangle', coords: RECT },
      ifMatch: detail.version,
    });
    expect(response.statusCode).toBe(201);
  });

  it('детекция по такой разметке тоже повторяется', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/detect`, {
      body: {},
    });
    expect(response.statusCode).toBe(202);
  });
});
