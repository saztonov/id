/**
 * Экран «Документы» через HTTP на собранном приложении (§8, §14).
 *
 * Поднимается штатный `buildApp()`. Проверяется не «эндпоинт отвечает 202», а
 * последствия:
 *
 * 1. **Нажатие «Собрать документы» кладёт строку в `jobs`** — проверено по
 *    ТАБЛИЦЕ, а не по наличию вызова в коде (урок S5).
 * 2. **`Idempotency-Key` обязателен**, и повтор с тем же ключом не заводит
 *    вторую задачу.
 * 3. **Постановка задачи с чужой ревизией отвергается** — тот же рубеж, что
 *    закрыл на S6 постановку задачи разметки по чужому идентификатору.
 * 4. **Изоляция подрядчиков** (§1.6, non-degradable): чужие документы,
 *    страницы, реквизиты, строки реестра и классификации не отдаются ни
 *    списком, ни по прямому идентификатору, и ни один секретный маркер не
 *    появляется в теле ответа.
 * 5. **`If-Match` на подтверждении**: без заголовка 400, с устаревшей версией
 *    412, с текущей — 200 и новый ETag.
 * 6. **Учёт страниц отдаёт `unaccounted`** — пустой список здесь утверждение,
 *    а не умолчание (§16).
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

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_A = id(2);
const ORG_B = id(3);
const OBJECT = id(4);
const SECTION = id(5);
const VOLUME = id(6);

const SUBMISSION_A = id(10);
const REVISION_A = id(11);
const SUBMISSION_B = id(12);
const REVISION_B = id(13);

const USER_A = id(20);
const USER_B = id(21);
const USER_ENGINEER = id(22);
const USER_MANAGER = id(23);
const USER_ADMIN = id(24);
/** Инженер БЕЗ назначенных объектов: право есть, область пуста. */
const USER_ENGINEER_NO_SCOPE = id(25);

const FILE_A = id(30);
const FILE_B = id(31);
const PAGE_A0 = id(40);
const PAGE_A1 = id(41);
const PAGE_A2 = id(42);
const PAGE_B0 = id(43);

const DOC_A1 = id(50);
const DOC_A2 = id(51);
const DOC_B = id(52);

const REGISTRY_A = id(60);
const REGISTRY_B = id(61);

const SHA = (letter: string): string => letter.repeat(64);

/**
 * Маркер чужих данных.
 *
 * Он лежит в заголовке документа, в цитате реквизита, в строке реестра и в
 * наблюдённом заголовке классификации поставки Б. Проверка «в ответе нет
 * маркера» имеет смысл только потому, что он там ЕСТЬ у владельца — иначе тест
 * доказывал бы, что данных нет вовсе (тот же дефект, что на S7 нашли у
 * проверки подписанных ссылок).
 */
const SECRET = 'СЕКРЕТНЫЙ-ФРАГМЕНТ-ПОСТАВКИ-Б';

const KC = {
  a: 'kc-documents-a',
  b: 'kc-documents-b',
  engineer: 'kc-documents-engineer',
  manager: 'kc-documents-manager',
  admin: 'kc-documents-admin',
  engineerNoScope: 'kc-documents-engineer-no-scope',
} as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO section_kinds (code, name) VALUES ('roofing', 'Кровля автостоянки')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION}', '${OBJECT}', '2.5.1', 'Кровля', 'roofing')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME}', '${OBJECT}', '${SECTION}', 'V-1', 'Том 1')`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_A}', '${KC.a}', 'Сотрудник А', '${ORG_A}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_B}', '${KC.b}', 'Сотрудник Б', '${ORG_B}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_NO_SCOPE}', '${KC.engineerNoScope}', 'Инженер без объектов')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_A}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_B}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_NO_SCOPE}', 'engineer')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('a')}', 'blobs/${SHA('a')}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('c')}', 'blobs/${SHA('c')}', 512, 'application/pdf')`,

  // --- Поставка А: два документа, три страницы, все учтены ------------------
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION_A}', '${VOLUME}', '${OBJECT}', '${ORG_A}', 'Поставка А', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_A}', '${SUBMISSION_A}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_A}', '${REVISION_A}', '${SHA('a')}', 'akt.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A0}', '${REVISION_A}', '${FILE_A}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A1}', '${REVISION_A}', '${FILE_A}', 1, 1, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A2}', '${REVISION_A}', '${FILE_A}', 2, 2, 1654, 2339, 0)`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title, needs_review)
     VALUES ('${DOC_A1}', '${REVISION_A}', '${OBJECT}', '${ORG_A}', 'aosr', 0,
             'АКТ освидетельствования скрытых работ', true)`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOC_A2}', '${REVISION_A}', '${OBJECT}', '${ORG_A}', 'annex_registry', 1,
             'Реестр приложений')`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_A}', '${PAGE_A0}', '${DOC_A1}', 0)`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order, page_role_code)
     VALUES ('${REVISION_A}', '${PAGE_A1}', '${DOC_A1}', 1, 'copy_stamp')`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_A}', '${PAGE_A2}', '${DOC_A2}', 0)`,
  `INSERT INTO document_relations (revision_id, parent_document_id, child_document_id, relation)
     VALUES ('${REVISION_A}', '${DOC_A1}', '${DOC_A2}', 'annex')`,
  `INSERT INTO field_values (revision_id, document_id, field_code, value_text, extractor_version, extracted_by, confidence)
     VALUES ('${REVISION_A}', '${DOC_A1}', 'number', '336', 'ext/1', 'rule', 0.95)`,
  `INSERT INTO registry_rows (id, revision_id, document_id, ordinal, row_no, doc_name_raw, doc_no_raw, match_state)
     VALUES ('${REGISTRY_A}', '${REVISION_A}', '${DOC_A2}', 0, 1, 'Сертификат соответствия', 'РОСС RU 1', 'missing')`,
  `INSERT INTO page_classifications (revision_id, source_page_id, label, doc_type_code, type_outcome,
                                     confidence, reason, source)
     VALUES ('${REVISION_A}', '${PAGE_A0}', 'B-DOC', 'aosr', 'known', 0.93,
             'якорь «освидетельствования скрытых работ»', 'anchor')`,
  `INSERT INTO page_classifications (revision_id, source_page_id, label, type_outcome, page_role_code,
                                     confidence, reason, source)
     VALUES ('${REVISION_A}', '${PAGE_A1}', 'A-ROLE', 'none', 'copy_stamp', 0.88,
             'одинокий короткий блок «КОПИЯ ВЕРНА»', 'anchor')`,
  `INSERT INTO page_classifications (revision_id, source_page_id, label, doc_type_code, type_outcome,
                                     confidence, reason, source)
     VALUES ('${REVISION_A}', '${PAGE_A2}', 'B-DOC', 'annex_registry', 'known', 0.9,
             'якорь «Реестр приложений»', 'anchor')`,

  // --- Поставка Б: те же сущности, но с маркером -----------------------------
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION_B}', '${VOLUME}', '${OBJECT}', '${ORG_B}', 'Поставка Б', '${USER_B}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_B}', '${SUBMISSION_B}', '${OBJECT}', '${ORG_B}', 1, 'draft')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_B}', '${REVISION_B}', '${SHA('c')}', 'chuzhoy.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_B0}', '${REVISION_B}', '${FILE_B}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOC_B}', '${REVISION_B}', '${OBJECT}', '${ORG_B}', 'cert_conformity', 0, '${SECRET}')`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_B}', '${PAGE_B0}', '${DOC_B}', 0)`,
  `INSERT INTO field_values (revision_id, document_id, field_code, value_text, extractor_version, extracted_by, quote)
     VALUES ('${REVISION_B}', '${DOC_B}', 'issuer', '${SECRET}', 'ext/1', 'llm', NULL)`,
  `INSERT INTO registry_rows (id, revision_id, document_id, ordinal, row_no, doc_name_raw, match_state)
     VALUES ('${REGISTRY_B}', '${REVISION_B}', '${DOC_B}', 0, 1, '${SECRET}', 'missing')`,
  `INSERT INTO page_classifications (revision_id, source_page_id, label, type_outcome, observed_title,
                                     confidence, reason, source)
     VALUES ('${REVISION_B}', '${PAGE_B0}', 'B-DOC', 'other', '${SECRET}', 0.7,
             'известный тип не подошёл', 'llm')`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-documents-routes-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-documents-tests-01234',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-documents-tests',
  RATE_LIMIT_MAX: '100000',
  RDWEB_BASE_URL: 'http://127.0.0.1:1/',
  RDWEB_USER: 'portal@example.test',
  RDWEB_PASSWORD: 'portal-secret-of-tests',
  RDWEB_PROJECT_ALLOWLIST: 'prj-portal',
  RDWEB_OCR_MODEL: 'qwen2.5-vl-7b',
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
}, 240_000);

afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

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

async function signIn(kcSub: string): Promise<SignedIn> {
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${encodeURIComponent(kcSub)}`,
  });
  const location = started.headers['location'];
  if (typeof location !== 'string') throw new Error('нет location');
  const authorizationUrl = new URL(location);
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
  options: {
    readonly body?: unknown;
    readonly idempotencyKey?: string | null;
    readonly ifMatch?: string | null;
  } = {},
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
      ...(options.idempotencyKey !== undefined && options.idempotencyKey !== null
        ? { 'idempotency-key': options.idempotencyKey }
        : {}),
      ...(options.ifMatch !== undefined && options.ifMatch !== null
        ? { 'if-match': options.ifMatch }
        : {}),
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
}

async function jobRows(type: string): Promise<readonly { payload: string }[]> {
  return db.query<{ payload: string }>(
    `SELECT payload::text AS payload FROM jobs WHERE type = '${type}' ORDER BY created_at`,
  );
}

// =====================================================================
// Кнопка «Собрать документы»
// =====================================================================

describe('POST /revisions/{id}/segment', () => {
  it('без Idempotency-Key отвечает 400 и НИЧЕГО не ставит в очередь', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/segment`, {
      body: {},
    });
    expect(response.statusCode).toBe(400);
    expect(await jobRows('doc.classify_pages')).toHaveLength(0);
  });

  it('подрядчику сборка документов не разрешена: границы правит проверяющий', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/segment`, {
      body: {},
      idempotencyKey: 'contractor-attempt',
    });
    expect(response.statusCode).toBe(403);
    expect(await jobRows('doc.classify_pages')).toHaveLength(0);
  });

  /**
   * Главная проверка маршрута: строка в `jobs`, а не код ответа. Ровно того, что
   * тесты этого не проверяли, не хватило на S5, где весь конвейер §12 не
   * запускался вовсе.
   */
  it('ставит doc.classify_pages в jobs с ревизией в payload', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/segment`, {
      body: {},
      idempotencyKey: 'segment-1',
    });
    expect(response.statusCode).toBe(202);
    expect(response.json<{ jobCreated: boolean }>().jobCreated).toBe(true);

    const jobs = await jobRows('doc.classify_pages');
    expect(jobs).toHaveLength(1);
    const payload = JSON.parse(jobs[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload.revisionId).toBe(REVISION_A);
  });

  it('повтор с тем же ключом не заводит вторую задачу', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/segment`, {
      body: {},
      idempotencyKey: 'segment-1',
    });
    expect(response.statusCode).toBe(202);
    expect(response.json<{ jobCreated: boolean }>().jobCreated).toBe(false);
    expect(await jobRows('doc.classify_pages')).toHaveLength(1);
  });

  /**
   * Постановка задачи по чужой ревизии. Право `document.edit` у инженера есть,
   * но область пуста — второй уровень изоляции обязан не пропустить.
   */
  it('инженер без назначенных объектов не может поставить задачу', async () => {
    const before = await jobRows('doc.classify_pages');
    const response = await as(
      KC.engineerNoScope,
      'POST',
      `/api/v1/revisions/${REVISION_B}/segment`,
      { body: {}, idempotencyKey: 'foreign-revision' },
    );
    expect(response.statusCode).toBe(422);
    expect(await jobRows('doc.classify_pages')).toHaveLength(before.length);
  });
});

// =====================================================================
// Чтение
// =====================================================================

describe('чтение документов', () => {
  it('список документов ревизии отдаёт тип, заголовок, число страниц и needsReview', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/documents`);
    expect(response.statusCode).toBe(200);
    const items = response.json<{
      items: readonly {
        id: string;
        docTypeCode: string;
        pageCount: number;
        needsReview: boolean;
        version: number;
      }[];
    }>().items;
    expect(items).toHaveLength(2);
    expect(items[0]?.docTypeCode).toBe('aosr');
    expect(items[0]?.pageCount).toBe(2);
    expect(items[0]?.needsReview).toBe(true);
    expect(items[0]?.version).toBe(0);
  });

  it('карточка документа отдаёт страницы с ролями, связи и ETag', async () => {
    const response = await as(KC.engineer, 'GET', `/api/v1/documents/${DOC_A1}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"0"');
    const body = response.json<{
      pages: readonly { sourcePageId: string; pageRoleCode: string | null }[];
      relations: readonly { relation: string }[];
    }>();
    expect(body.pages.map((page) => page.sourcePageId)).toEqual([PAGE_A0, PAGE_A1]);
    expect(body.pages[1]?.pageRoleCode).toBe('copy_stamp');
    expect(body.relations).toEqual([
      { parentDocumentId: DOC_A1, childDocumentId: DOC_A2, relation: 'annex' },
    ]);
  });

  it('реквизиты отдаются вместе с доказательством', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/documents/${DOC_A1}/fields`);
    expect(response.statusCode).toBe(200);
    const items = response.json<{
      items: readonly { fieldCode: string; valueText: string; extractedBy: string }[];
    }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.fieldCode).toBe('number');
    expect(items[0]?.extractedBy).toBe('rule');
  });

  /**
   * Учёт страниц. `unaccounted` обязан быть пуст, и именно поэтому он в ответе:
   * экран, который не показывает потерянные страницы, делает нарушение §16
   * ненаблюдаемым.
   */
  it('учёт страниц отдаёт привязанные, непривязанные и НЕУЧТЁННЫЕ отдельно', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/pages`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: readonly { sourcePageId: string; documentId: string | null }[];
      unaccounted: readonly unknown[];
      counts: { assigned: number; unassigned: number; unaccounted: number };
    }>();
    expect(body.items).toHaveLength(3);
    expect(body.counts).toEqual({ assigned: 3, unassigned: 0, unaccounted: 0 });
    expect(body.unaccounted).toEqual([]);
  });

  it('потерянная страница видна в unaccounted, а не молчится', async () => {
    // Страница добавляется в черновик ПОСЛЕ сборки документов: ровно так
    // выглядит устаревшая сегментация на экране.
    await db.query(
      `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal,
                                 width_px, height_px, rotation)
         VALUES ('${id(44)}', '${REVISION_A}', '${FILE_A}', 3, 3, 1654, 2339, 0)`,
    );
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/pages`);
    const body = response.json<{
      unaccounted: readonly { sourcePageId: string }[];
      counts: { unaccounted: number };
    }>();
    expect(body.counts.unaccounted).toBe(1);
    expect(body.unaccounted[0]?.sourcePageId).toBe(id(44));

    await db.query(`DELETE FROM source_pages WHERE id = '${id(44)}'`);
  });

  it('строки реестра отдаются с состоянием сверки', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/registry`);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: readonly { matchState: string }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.matchState).toBe('missing');
  });

  it('классификации объясняют, почему страница получила метку', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/classifications`);
    expect(response.statusCode).toBe(200);
    const items = response.json<{
      items: readonly { label: string; reason: string; source: string; confidence: number }[];
    }>().items;
    expect(items).toHaveLength(3);
    expect(items[0]?.label).toBe('B-DOC');
    expect(items[0]?.source).toBe('anchor');
    expect(items[0]?.confidence).toBeCloseTo(0.93);
    expect(items[1]?.reason).toContain('КОПИЯ ВЕРНА');
  });
});

// =====================================================================
// Изоляция (§1.6, non-degradable)
// =====================================================================

describe('изоляция подрядчиков', () => {
  it('владелец свои данные с маркером получает — иначе проверка ниже пуста', async () => {
    const list = await as(KC.b, 'GET', `/api/v1/revisions/${REVISION_B}/documents`);
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(SECRET);

    const fields = await as(KC.b, 'GET', `/api/v1/documents/${DOC_B}/fields`);
    expect(fields.body).toContain(SECRET);
  });

  it('чужие документы не видны ни списком, ни по прямому идентификатору', async () => {
    const list = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/documents`);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
    expect(list.body).not.toContain(SECRET);

    const direct = await as(KC.a, 'GET', `/api/v1/documents/${DOC_B}`);
    expect(direct.statusCode).toBe(404);
    expect(direct.body).not.toContain(SECRET);
  });

  it('чужие реквизиты, реестр, страницы и классификации не выдаются', async () => {
    const fields = await as(KC.a, 'GET', `/api/v1/documents/${DOC_B}/fields`);
    expect(fields.statusCode).toBe(200);
    expect(fields.json<{ items: unknown[] }>().items).toEqual([]);
    expect(fields.body).not.toContain(SECRET);

    const registry = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/registry`);
    expect(registry.json<{ items: unknown[] }>().items).toEqual([]);
    expect(registry.body).not.toContain(SECRET);

    const pages = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/pages`);
    expect(pages.json<{ items: unknown[] }>().items).toEqual([]);

    const classifications = await as(
      KC.a,
      'GET',
      `/api/v1/revisions/${REVISION_B}/classifications`,
    );
    expect(classifications.json<{ items: unknown[] }>().items).toEqual([]);
    expect(classifications.body).not.toContain(SECRET);
  });

  it('инженер без назначенных объектов не видит ничего', async () => {
    const list = await as(KC.engineerNoScope, 'GET', `/api/v1/revisions/${REVISION_A}/documents`);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);

    const direct = await as(KC.engineerNoScope, 'GET', `/api/v1/documents/${DOC_A1}`);
    expect(direct.statusCode).toBe(404);
  });

  it('инженер объекта видит документы обоих подрядчиков', async () => {
    const direct = await as(KC.engineer, 'GET', `/api/v1/documents/${DOC_B}`);
    expect(direct.statusCode).toBe(200);
  });
});

// =====================================================================
// Подтверждение
// =====================================================================

describe('POST /documents/{id}/confirm', () => {
  it('без If-Match отвечает 400 и ничего не подтверждает', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/documents/${DOC_A1}/confirm`, {
      body: {},
    });
    expect(response.statusCode).toBe(400);

    const rows = await db.query<{ is_confirmed: boolean }>(
      `SELECT is_confirmed FROM logical_documents WHERE id = '${DOC_A1}'`,
    );
    expect(rows[0]?.is_confirmed).toBe(false);
  });

  it('подрядчику подтверждение недоступно', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/documents/${DOC_A1}/confirm`, {
      body: {},
      ifMatch: '"0"',
    });
    expect(response.statusCode).toBe(403);
  });

  it('чужой документ не подтверждается даже по прямому идентификатору', async () => {
    const response = await as(KC.engineerNoScope, 'POST', `/api/v1/documents/${DOC_B}/confirm`, {
      body: {},
      ifMatch: '"0"',
    });
    expect(response.statusCode).toBe(404);
  });

  it('подтверждает тип, поднимает версию и пишет audit_log', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/documents/${DOC_A1}/confirm`, {
      body: { docTypeCode: 'aosr_networks' },
      ifMatch: '"0"',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"1"');
    const body = response.json<{ isConfirmed: boolean; docTypeCode: string; version: number }>();
    expect(body.isConfirmed).toBe(true);
    expect(body.docTypeCode).toBe('aosr_networks');
    expect(body.version).toBe(1);

    const audit = await db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'document.confirmed'`,
    );
    expect(Number(audit[0]?.n ?? 0)).toBe(1);
  });

  it('повтор со старой версией даёт 412', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/documents/${DOC_A1}/confirm`, {
      body: {},
      ifMatch: '"0"',
    });
    expect(response.statusCode).toBe(412);
  });
});

// =====================================================================
// Подключение маршрутов (урок S3)
// =====================================================================

describe('регистрация маршрутов', () => {
  /**
   * Модуль, написанный и не подключённый, проходит собственные тесты и
   * недостижим снаружи — именно так на S3 «работал» весь слой наблюдаемости.
   * Поэтому список маршрутов снимается с СОБРАННОГО приложения.
   */
  it('все восемь маршрутов модуля достижимы в собранном приложении', () => {
    const expected: readonly (readonly ['GET' | 'POST', string])[] = [
      ['POST', '/api/v1/revisions/:revisionId/segment'],
      ['GET', '/api/v1/revisions/:revisionId/documents'],
      ['GET', '/api/v1/revisions/:revisionId/pages'],
      ['GET', '/api/v1/revisions/:revisionId/registry'],
      ['GET', '/api/v1/revisions/:revisionId/classifications'],
      ['GET', '/api/v1/documents/:documentId'],
      ['GET', '/api/v1/documents/:documentId/fields'],
      ['POST', '/api/v1/documents/:documentId/confirm'],
    ];
    for (const [method, url] of expected) {
      // `hasRoute` спрашивает сам роутер Fastify, а не разбирает печать дерева:
      // ответ «есть» здесь означает достижимость, а не совпадение подстроки.
      expect(app.hasRoute({ method, url }), `маршрут ${method} ${url} не зарегистрирован`).toBe(
        true,
      );
    }
  });

  it('проверка чувствительна: несуществующий маршрут модуля не находится', () => {
    // Без этого утверждения предыдущий тест проходил бы и при поломанном
    // способе проверки — ровно тот класс дефекта, который S6 и S7 нашли у себя.
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/documents/:documentId/nope' })).toBe(false);
  });
});
