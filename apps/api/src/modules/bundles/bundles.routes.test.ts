/**
 * Рабочий документ ревизии через HTTP на собранном приложении (§3.3, §6.1).
 *
 * Проверка идёт по достижимости, а не по коду. Прогон S5 показал отказ ровно
 * этого рода: репозиторий `bundles.ts` был написан и покрыт тестами, а маршрутов
 * к нему не существовало вовсе — `listBundles`, `listBundlePages` и
 * `findSourceOfWorkingPage` не вызывались ниоткуда, то есть обратное
 * отображение «страница рабочего PDF → лист оригинала», без которого §3.3
 * бессмысленна, было недостижимо. Поэтому здесь поднимается штатный
 * `buildApp()`, и ни одна функция репозитория не вызывается напрямую.
 *
 * Что проверяется по существу:
 *
 * 1. Запрос сборки СТАВИТ задачу `bundle.build` в очередь. Пустая `jobs` после
 *    202 — это и есть отказ, найденный прогоном.
 * 2. Препятствия (карантин, пустая ревизия) отвечают 409 сразу, а не задачей,
 *    которая упадёт через минуту с тем же текстом.
 * 3. Повторный запрос того же состава не ставит вторую задачу и не собирает
 *    второй документ.
 * 4. Карта страниц читается целиком и поштучно, и обратное отображение
 *    указывает на настоящий файл и его страницу.
 * 5. Изоляция: чужой рабочий документ не виден ни списком, ни по прямому
 *    идентификатору, ни поштучным чтением карты.
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
const SECTION = id(5);
const VOLUME = id(6);

const SUBMISSION = id(10);
const REVISION = id(11);
const SUBMISSION_OTHER = id(12);
const REVISION_OTHER = id(13);
const SUBMISSION_EMPTY = id(14);
const REVISION_EMPTY = id(15);
const SUBMISSION_DIRTY = id(16);
const REVISION_DIRTY = id(17);

const USER_CONTRACTOR = id(20);
const USER_OTHER = id(21);
const USER_ENGINEER = id(22);

const FILE_1 = id(30);
const FILE_2 = id(31);
const FILE_QUARANTINED = id(32);
const FILE_OTHER = id(33);

const PAGE_1_0 = id(40);
const PAGE_1_1 = id(41);
const PAGE_2_0 = id(42);
const PAGE_OTHER_0 = id(43);

const BUNDLE_OTHER = id(50);

const SHA_1 = 'a'.repeat(64);
const SHA_2 = 'b'.repeat(64);
const SHA_QUARANTINED = 'c'.repeat(64);
const SHA_OTHER = 'd'.repeat(64);
const SHA_WORKING_OTHER = 'e'.repeat(64);

const KC = {
  contractor: 'kc-bundles-contractor',
  other: 'kc-bundles-other',
  engineer: 'kc-bundles-engineer',
} as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_OTHER}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO section_kinds (code, name) VALUES ('roofing', 'Кровля автостоянки')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION}', '${OBJECT}', '2.5.1', 'Кровля автостоянки', 'roofing')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME}', '${OBJECT}', '${SECTION}', 'V-1', 'Том 1')`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR}', '${KC.contractor}', 'Сотрудник подрядчика А', '${ORG_CONTRACTOR}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_OTHER}', '${KC.other}', 'Сотрудник подрядчика Б', '${ORG_OTHER}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_OTHER}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

  // Ревизия, готовая к сборке: два проверенных файла, три страницы.
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION}', '${VOLUME}', '${OBJECT}', '${ORG_CONTRACTOR}', 'Поставка 1', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION}', '${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_1}', 'blobs/${SHA_1}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_2}', 'blobs/${SHA_2}', 1024, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_1}', '${REVISION}', '${SHA_1}', 'АОСР.pdf', 0, 'ok')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_2}', '${REVISION}', '${SHA_2}', 'Сертификат.pdf', 1, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_1_0}', '${REVISION}', '${FILE_1}', 0, 0, 595, 842, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_1_1}', '${REVISION}', '${FILE_1}', 1, 1, 842, 595, 90)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_2_0}', '${REVISION}', '${FILE_2}', 0, 2, 595, 842, 0)`,

  // Ревизия без файлов: сборка невозможна и обязана сказать почему.
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION_EMPTY}', '${VOLUME}', '${OBJECT}', '${ORG_CONTRACTOR}', 'Поставка пустая', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_EMPTY}', '${SUBMISSION_EMPTY}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,

  // Ревизия с карантинным файлом.
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION_DIRTY}', '${VOLUME}', '${OBJECT}', '${ORG_CONTRACTOR}', 'Поставка с карантином', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_DIRTY}', '${SUBMISSION_DIRTY}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_QUARANTINED}', 'blobs/${SHA_QUARANTINED}', 512, 'application/octet-stream')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state, verify_error)
     VALUES ('${FILE_QUARANTINED}', '${REVISION_DIRTY}', '${SHA_QUARANTINED}', 'битый.pdf', 0,
             'quarantined', 'PDF повреждён и не читается')`,

  // Чужая поставка с уже собранным рабочим документом.
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION_OTHER}', '${VOLUME}', '${OBJECT}', '${ORG_OTHER}', 'Поставка чужая', '${USER_OTHER}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_OTHER}', '${SUBMISSION_OTHER}', '${OBJECT}', '${ORG_OTHER}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_OTHER}', 'blobs/${SHA_OTHER}', 700, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_WORKING_OTHER}', 'bundle/${SHA_WORKING_OTHER}.pdf', 700, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_OTHER}', '${REVISION_OTHER}', '${SHA_OTHER}', 'Чужой.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_OTHER_0}', '${REVISION_OTHER}', '${FILE_OTHER}', 0, 0, 595, 842, 0)`,
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_OTHER}', '${REVISION_OTHER}', '${'f'.repeat(64)}', '${SHA_WORKING_OTHER}', 'bundle/1+qpdf')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_OTHER}', '${REVISION_OTHER}', 0, '${PAGE_OTHER_0}')`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-bundles-tests-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-bundles-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-bundles-tests',
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
  expect(started.statusCode).toBe(302);

  const authorizationUrl = new URL(locationOf(started));
  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
  });
  expect(completed.statusCode).toBe(302);

  return {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
}

const signedIn = new Map<string, SignedIn>();

async function as(kcSub: string, method: Method, url: string): Promise<LightMyRequestResponse> {
  let session = signedIn.get(kcSub);
  if (session === undefined) {
    session = await signIn(kcSub);
    signedIn.set(kcSub, session);
  }
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
  });
}

interface BuildResponse {
  readonly jobId: string | null;
  readonly created: boolean;
  readonly bundle: { readonly id: string; readonly pageCount: number } | null;
  readonly aggregateManifestHash: string;
}

async function queuedTypes(revisionId: string): Promise<readonly string[]> {
  const rows = await db.query<{ type: string }>(
    `SELECT type FROM jobs WHERE payload->>'revisionId' = '${revisionId}'`,
  );
  return rows.map((row) => row.type);
}

// =====================================================================
// Сборка
// =====================================================================

describe('запрос сборки рабочего документа', () => {
  it('ставит задачу bundle.build в очередь, а не только отвечает 202', async () => {
    expect(await queuedTypes(REVISION)).toEqual([]);

    const response = await as(KC.contractor, 'POST', `/api/v1/revisions/${REVISION}/bundle`);
    expect(response.statusCode).toBe(202);

    const body = response.json<BuildResponse>();
    expect(body.created).toBe(true);
    expect(body.jobId).not.toBeNull();
    expect(body.bundle).toBeNull();
    expect(body.aggregateManifestHash).toMatch(/^[0-9a-f]{64}$/);

    // Главное утверждение: работа поставлена, а не задекларирована.
    expect(await queuedTypes(REVISION)).toEqual(['bundle.build']);
  });

  it('повторный запрос того же состава не создаёт вторую задачу', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/revisions/${REVISION}/bundle`);
    expect(response.statusCode).toBe(202);
    expect(response.json<BuildResponse>().created).toBe(false);
    expect(await queuedTypes(REVISION)).toEqual(['bundle.build']);
  });

  it('ревизия без файлов отвечает 409 сразу, а не задачей, которая упадёт', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/revisions/${REVISION_EMPTY}/bundle`);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('нет ни одного файла');
    expect(await queuedTypes(REVISION_EMPTY)).toEqual([]);
  });

  it('карантинный файл назван по имени, и сборка не ставится', async () => {
    const response = await as(KC.contractor, 'POST', `/api/v1/revisions/${REVISION_DIRTY}/bundle`);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('битый.pdf');
    expect(await queuedTypes(REVISION_DIRTY)).toEqual([]);
  });

  it('чужая ревизия неотличима от несуществующей', async () => {
    const response = await as(KC.other, 'POST', `/api/v1/revisions/${REVISION}/bundle`);
    expect(response.statusCode).toBe(404);
    expect(await queuedTypes(REVISION)).toEqual(['bundle.build']);
  });
});

// =====================================================================
// Карта страниц
// =====================================================================

describe('карта страниц рабочего документа', () => {
  const BUNDLE = id(60);
  const MANIFEST = '1'.repeat(64);
  const SHA_WORKING = '2'.repeat(64);

  beforeAll(async () => {
    // Документ вписывается напрямую: собирает его воркер, а здесь проверяется
    // выдача карты, а не сборка.
    await db.query(
      `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
         VALUES ('${SHA_WORKING}', 'bundle/${SHA_WORKING}.pdf', 3072, 'application/pdf')`,
    );
    await db.query(
      `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
         VALUES ('${BUNDLE}', '${REVISION}', '${MANIFEST}', '${SHA_WORKING}', 'bundle/1+qpdf')`,
    );
    for (const [index, page] of [PAGE_1_0, PAGE_1_1, PAGE_2_0].entries()) {
      await db.query(
        `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
           VALUES ('${BUNDLE}', '${REVISION}', ${index}, '${page}')`,
      );
    }
  });

  it('список рабочих документов ревизии доступен и считает страницы', async () => {
    const response = await as(KC.contractor, 'GET', `/api/v1/revisions/${REVISION}/bundles`);
    expect(response.statusCode).toBe(200);

    const items = response.json<{ items: { id: string; pageCount: number }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: BUNDLE, pageCount: 3 });
  });

  it('карта отдаёт файл и страницу оригинала для каждой страницы рабочего PDF', async () => {
    const response = await as(KC.contractor, 'GET', `/api/v1/bundles/${BUNDLE}/pages`);
    expect(response.statusCode).toBe(200);

    const items = response.json<{
      items: { workingPageIndex: number; fileName: string; filePageIndex: number }[];
    }>().items;

    expect(items.map((page) => page.workingPageIndex)).toEqual([0, 1, 2]);
    expect(items.map((page) => `${page.fileName}#${String(page.filePageIndex)}`)).toEqual([
      'АОСР.pdf#0',
      'АОСР.pdf#1',
      'Сертификат.pdf#0',
    ]);
  });

  it('обратное отображение одной страницы сохраняет поворот оригинала', async () => {
    // Ради этого §3.3 и требует карту: замечание к странице рабочего документа
    // адресуется листу исходного файла, а поворот определяет систему координат.
    const response = await as(KC.contractor, 'GET', `/api/v1/bundles/${BUNDLE}/pages/1`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workingPageIndex: 1,
      sourcePageId: PAGE_1_1,
      sourceFileId: FILE_1,
      filePageIndex: 1,
      rotation: 90,
      widthPx: 842,
      heightPx: 595,
    });
  });

  it('страница за пределами карты — 404, а не пустой ответ', async () => {
    const response = await as(KC.contractor, 'GET', `/api/v1/bundles/${BUNDLE}/pages/99`);
    expect(response.statusCode).toBe(404);
  });

  it('инженер объекта видит карту чужого подрядчика, подрядчик — нет', async () => {
    const engineer = await as(KC.engineer, 'GET', `/api/v1/bundles/${BUNDLE_OTHER}/pages`);
    expect(engineer.statusCode).toBe(200);

    for (const url of [
      `/api/v1/bundles/${BUNDLE_OTHER}`,
      `/api/v1/bundles/${BUNDLE_OTHER}/pages`,
      `/api/v1/bundles/${BUNDLE_OTHER}/pages/0`,
      `/api/v1/revisions/${REVISION_OTHER}/bundles`,
    ]) {
      const response = await as(KC.contractor, 'GET', url);
      expect(response.statusCode).toBe(404);
    }
  });

  it('чужая карта не выдаёт ни имени файла, ни идентификатора страницы', async () => {
    const response = await as(KC.contractor, 'GET', `/api/v1/bundles/${BUNDLE_OTHER}/pages/0`);
    expect(response.body).not.toContain('Чужой.pdf');
    expect(response.body).not.toContain(PAGE_OTHER_0);
  });
});
