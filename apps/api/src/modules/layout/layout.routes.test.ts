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

const FOLDER = id(11);
const FOLDER_OTHER = id(13);
const FOLDER_BARE = id(15);

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
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA}', 'blobs/${SHA}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_WORKING}', 'blobs/${SHA_WORKING}', 4096, 'application/pdf')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE}', '${FOLDER}', '${SHA}', 'АОСР.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_0}', '${FOLDER}', '${FILE}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_1}', '${FOLDER}', '${FILE}', 1, 1, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_2}', '${FOLDER}', '${FILE}', 2, 2, 1654, 2339, 0)`,
  `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE}', '${FOLDER}', '${'e'.repeat(64)}', '${SHA_WORKING}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE}', '${FOLDER}', 0, '${PAGE_0}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE}', '${FOLDER}', 1, '${PAGE_1}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE}', '${FOLDER}', 2, '${PAGE_2}')`,

  // Ревизия без рабочего документа: разметку начать нельзя.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_BARE}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка без bundle', '${USER_CONTRACTOR}')`,

  // Чужая поставка с уже существующей разметкой.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_OTHER}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_OTHER}', '${OBJECT}', '${ORG_OTHER}', '${ORG_OTHER}', 'roofing', DATE '2026-01-01', 'Поставка чужая', '${USER_OTHER}')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_OTHER}', 'blobs/${SHA_OTHER}', 700, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_WORKING_OTHER}', 'blobs/${SHA_WORKING_OTHER}', 700, 'application/pdf')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_OTHER}', '${FOLDER_OTHER}', '${SHA_OTHER}', 'Чужой.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_OTHER}', '${FOLDER_OTHER}', '${FILE_OTHER}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_OTHER}', '${FOLDER_OTHER}', '${'f'.repeat(64)}', '${SHA_WORKING_OTHER}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_OTHER}', '${FOLDER_OTHER}', 0, '${PAGE_OTHER}')`,
  `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no, state)
     VALUES ('${LAYOUT_OTHER}', '${FOLDER_OTHER}', '${OBJECT}', '${BUNDLE_OTHER}', 1, 'draft')`,
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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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

async function queuedTypes(folderId: string): Promise<readonly string[]> {
  const rows = await db.query<{ type: string }>(
    `SELECT type FROM jobs WHERE payload->>'folderId' = '${folderId}' ORDER BY type`,
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

const PAGE_COUNT = 3;
const RECT = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.4 };

let layoutId = '';

// =====================================================================
// Старт цепочки
// =====================================================================

describe('приём ставит задачи конвейера', () => {
  beforeAll(async () => {
    // Версия модели детекции: без неё локальная ветка законно не ставит ни
    // одной задачи и честно отвечает «размечено, детекция пропущена». Предмет
    // этих тестов — постановка, поэтому модель объявлена выложенной.
    await db.query(
      "INSERT INTO app_settings (key, value) VALUES ('detection.model_version', '\"v1\"'::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
  });

  it('до нажатия кнопки задач разметки в очереди нет', async () => {
    expect(await queuedTypes(FOLDER)).not.toContain('page.orientation_probe');
  });

  it('«Разметить файл» создаёт черновик разметки И кладёт строку в jobs', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/folders/${FOLDER}/layout`);
    expect(response.statusCode).toBe(202);

    const body = response.json<StartResponse>();
    expect(body.created).toBe(true);
    expect(body.bundleId).toBe(BUNDLE);
    expect(body.jobCreated).toBe(true);
    layoutId = body.layoutRevisionId;

    // Проверяется ТАБЛИЦА, а не код ответа: на S5 маршрут отвечал успехом,
    // а очередь оставалась пустой.
    // Зонд разворота идёт ПЕРЕД детекцией и ставит её сам (ADR-0020).
    expect(await queuedTypes(FOLDER)).toContain('page.orientation_probe');

    const payloads = await db.query<{
      payload: { folderId: string; layoutRevisionId: string };
    }>(
      `SELECT payload FROM jobs WHERE type = 'page.orientation_probe'
        AND payload->>'folderId' = '${FOLDER}'
        ORDER BY payload->>'workingPageIndex'`,
    );
    // Одна задача на страницу: зонд смотрит лист, а не комплект.
    expect(payloads.length).toBeGreaterThan(0);
    // Цель задачи адресована явно: «текущий черновик этого bundle» за время
    // ожидания в очереди может смениться на следующую ревизию разметки.
    expect(payloads[0]?.payload.layoutRevisionId).toBe(layoutId);
  });

  it('повторное нажатие не создаёт вторую разметку и вторую задачу', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/folders/${FOLDER}/layout`);
    expect(response.statusCode).toBe(202);
    const body = response.json<StartResponse>();
    expect(body.created).toBe(false);
    expect(body.layoutRevisionId).toBe(layoutId);
    expect(body.jobCreated).toBe(false);

    const rows = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM jobs WHERE type = 'page.orientation_probe'
        AND payload->>'folderId' = '${FOLDER}'`,
    );
    // Одна задача на страницу комплекта — и ни одной сверх того: повторное
    // нажатие склеилось с уже стоящими по ключу дедупликации.
    expect(Number(rows[0]?.count ?? 0)).toBe(PAGE_COUNT);

    const layouts = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM layout_revisions WHERE folder_id = '${FOLDER}'`,
    );
    expect(Number(layouts[0]?.count ?? 0)).toBe(1);
  });

  it('без собранного рабочего документа разметка не начинается', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/folders/${FOLDER_BARE}/layout`);
    expect(response.statusCode).toBe(409);
    expect(await queuedTypes(FOLDER_BARE)).not.toContain('page.orientation_probe');
  });

  it('повторная детекция раскладывается на задачи по пачкам', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/layouts/${layoutId}/detect`, {
      body: {},
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ batches: number; jobIds: string[] }>();
    // Локальная детекция полистна: задача на страницу, а не пачка на комплект.
    // Так падение одного листа не уносит с собой остальные, а приоритет убывает
    // с номером страницы.
    expect(body.batches).toBe(PAGE_COUNT);

    const rows = await db.query<{
      payload: { pageIndices: number[]; overwriteExisting?: boolean };
      dedupe_key: string;
    }>(
      `SELECT payload, dedupe_key FROM jobs WHERE type = 'layout.detect_local'
        AND payload->>'layoutRevisionId' = '${layoutId}'
        ORDER BY payload->'pageIndices'->>0`,
    );
    expect(rows).toHaveLength(PAGE_COUNT);
    expect(rows.map((row) => row.payload.pageIndices)).toEqual([[0], [1], [2]]);
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
    const started = await as(KC.other, 'POST', `/api/v1/folders/${FOLDER_OTHER}/layout`);
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
    const list = await as(KC.other, 'GET', `/api/v1/folders/${FOLDER}/layouts`);
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

// =====================================================================
// Разворот содержимого страницы (ADR-0020)
// =====================================================================

interface OrientationView {
  readonly folderId: string;
  readonly sourcePageId: string;
  readonly contentRotation: number;
  readonly source: 'probe' | 'user' | null;
  readonly probeRotation: number | null;
  readonly probeConfidence: number | null;
  readonly probeError: string | null;
}

interface PageMapItem {
  readonly workingPageIndex: number;
  readonly contentRotation: number;
  readonly contentRotationSource: 'probe' | 'user' | null;
}

async function pageMap(): Promise<readonly PageMapItem[]> {
  const response = await as(KC.engineer, 'GET', `/api/v1/bundles/${BUNDLE}/pages`);
  expect(response.statusCode).toBe(200);
  return response.json<{ items: PageMapItem[] }>().items;
}

describe('разворот содержимого страницы', () => {
  it('до правки развороты нулевые, а источника нет вовсе', async () => {
    const items = await pageMap();
    expect(items).not.toHaveLength(0);
    for (const item of items) {
      expect(item.contentRotation).toBe(0);
      // `null`, а не `probe`: «решения никто не принимал» и «зонд сказал ноль» —
      // разные состояния, и склеивать их в контракте нельзя.
      expect(item.contentRotationSource).toBeNull();
    }
  });

  it('ручной разворот сохраняется и доезжает до карты страниц тем же запросом', async () => {
    const saved = await as(
      KC.engineer,
      'PUT',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_0}/orientation`,
      { body: { rotation: 90 } },
    );
    expect(saved.statusCode).toBe(200);
    const view = saved.json<OrientationView>();
    expect(view.contentRotation).toBe(90);
    expect(view.source).toBe('user');

    // Карта страниц — единственный источник для детекции, распознавания и
    // экрана. Если разворот не доехал сюда, он не доехал никуда.
    const items = await pageMap();
    const first = items.find((item) => item.workingPageIndex === 0);
    expect(first?.contentRotation).toBe(90);
    expect(first?.contentRotationSource).toBe('user');

    // Соседняя страница не задета: разворот — свойство одной страницы.
    expect(items.find((item) => item.workingPageIndex === 1)?.contentRotation).toBe(0);
  });

  it('повторная правка перезаписывает значение, а не заводит вторую строку', async () => {
    const again = await as(
      KC.engineer,
      'PUT',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_0}/orientation`,
      { body: { rotation: 270 } },
    );
    expect(again.statusCode).toBe(200);
    expect(again.json<OrientationView>().contentRotation).toBe(270);

    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM page_orientations
        WHERE folder_id = '${FOLDER}' AND source_page_id = '${PAGE_0}'`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('значение вне четверти оборота отвергается схемой, а не CHECK базы', async () => {
    const refused = await as(
      KC.engineer,
      'PUT',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_0}/orientation`,
      { body: { rotation: 45 } },
    );
    expect(refused.statusCode).toBe(422);
  });

  it('страница чужой ревизии не разворачивается по прямому идентификатору', async () => {
    const refused = await as(
      KC.engineer,
      'PUT',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_OTHER}/orientation`,
      { body: { rotation: 90 } },
    );
    expect(refused.statusCode).toBe(404);
  });

  it('сброс без мнения зонда убирает строку целиком', async () => {
    // Строку заводил человек, зонд её не касался. Оставить её с `source =
    // probe` нельзя буквально: CHECK требует от строки зонда сказать, что он
    // видел, либо почему не увидел ничего. Отсутствие строки и есть честное
    // «решения никто не принимал».
    const cleared = await as(
      KC.engineer,
      'DELETE',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_0}/orientation`,
    );
    expect(cleared.statusCode).toBe(200);
    const view = cleared.json<OrientationView>();
    expect(view.contentRotation).toBe(0);
    expect(view.source).toBeNull();

    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM page_orientations
        WHERE folder_id = '${FOLDER}' AND source_page_id = '${PAGE_0}'`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('сброс поверх мнения зонда возвращает мнение зонда, а не ноль', async () => {
    await db.query(
      `INSERT INTO page_orientations
         (folder_id, source_page_id, content_rotation, source, probe_rotation, probe_confidence)
       VALUES ('${FOLDER}', '${PAGE_1}', 180, 'probe', 180, 0.91)`,
    );
    const overridden = await as(
      KC.engineer,
      'PUT',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_1}/orientation`,
      { body: { rotation: 90 } },
    );
    expect(overridden.statusCode).toBe(200);
    // Мнение зонда пережило перекрытие: без него нельзя ответить на вопрос
    // «зонд ошибся или инженер?», ради которого зонд и заводился.
    expect(overridden.json<OrientationView>().probeRotation).toBe(180);

    const cleared = await as(
      KC.engineer,
      'DELETE',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_1}/orientation`,
    );
    expect(cleared.statusCode).toBe(200);
    const view = cleared.json<OrientationView>();
    expect(view.contentRotation).toBe(180);
    expect(view.source).toBe('probe');
  });

  it('второй сброс подряд отвечает 404, а не делает вид, что снял', async () => {
    const refused = await as(
      KC.engineer,
      'DELETE',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_1}/orientation`,
    );
    expect(refused.statusCode).toBe(404);
  });

  it('зонд не перекрывает ручное значение — правило живёт в SQL', async () => {
    await as(KC.engineer, 'PUT', `/api/v1/folders/${FOLDER}/pages/${PAGE_2}/orientation`, {
      body: { rotation: 90 },
    });

    // Ровно тот запрос, которым пишет задача зонда: `WHERE source <> 'user'`.
    // Гонка «инженер повернул, пока зонд летел» обязана решаться базой, а не
    // порядком вызовов в обработчике.
    await db.query(
      `INSERT INTO page_orientations
         (folder_id, source_page_id, content_rotation, source, probe_rotation)
       VALUES ('${FOLDER}', '${PAGE_2}', 0, 'probe', 0)
       ON CONFLICT (folder_id, source_page_id) DO UPDATE
         SET content_rotation = EXCLUDED.content_rotation, source = EXCLUDED.source
       WHERE page_orientations.source <> 'user'`,
    );

    const items = await pageMap();
    expect(items.find((item) => item.workingPageIndex === 2)?.contentRotation).toBe(90);
    expect(items.find((item) => item.workingPageIndex === 2)?.contentRotationSource).toBe('user');
  });

  it('разметка правится в submitted — значит и разворот тоже', async () => {
    // Ровно та проверка, ради которой разворот вынесен в отдельную таблицу:
    // колонка в `source_pages` была бы заперта триггером уже здесь.
    const saved = await as(
      KC.engineer,
      'PUT',
      `/api/v1/folders/${FOLDER}/pages/${PAGE_0}/orientation`,
      { body: { rotation: 180 } },
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json<OrientationView>().contentRotation).toBe(180);
  });
});
