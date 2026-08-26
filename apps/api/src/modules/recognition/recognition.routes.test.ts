/**
 * «Отправить на распознавание» через HTTP на собранном приложении (§6.2, §14).
 *
 * Поднимается штатный `buildApp()`. Проверяется не «эндпоинт отвечает 202», а
 * последствия:
 *
 * 1. **Нажатие кнопки кладёт строку в `jobs`** — проверено по ТАБЛИЦЕ, а не по
 *    наличию вызова в коде (урок S5).
 * 2. **`Idempotency-Key` обязателен**, а повторный запрос не заводит второй
 *    прогон: один прогон на ревизию разметки — это второй заезд GPU, которого
 *    §5.2 не допускает.
 * 3. **Разметка без единого блока на распознавание не уходит** (§5.2, шаг 5–6).
 * 4. **Изоляция подрядчиков** (§1.6, non-degradable): чужой прогон не виден ни
 *    списком, ни по прямому идентификатору, ни через выдачу файла артефакта.
 * 5. **Права**: `recognition.start` есть у подрядчика и инженера и нет у
 *    руководителя (§4.1). Администратор право получил в S24 вместе с
 *    `markup.edit`: разметку он ведёт, решения по документу — нет.
 * 6. **Подписанная ссылка RD WEB наружу не выходит** (§11): производные виды
 *    артефактов санируются на выдаче, сырой архив закрыт `diagnostics.read`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { artifactKey } from '../../storage/keys.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const ORG_CUSTOMER = id(1);
const ORG_A = id(2);
const ORG_B = id(3);
const OBJECT = id(4);

const SUBMISSION_A = id(10);
const REVISION_A = id(11);
const SUBMISSION_B = id(12);
const REVISION_B = id(13);

const USER_A = id(20);
const USER_B = id(21);
const USER_ENGINEER = id(22);
const USER_MANAGER = id(23);
const USER_ADMIN = id(24);
/** Инженер БЕЗ назначенных объектов: область пуста, значит не видно ничего. */
const USER_ENGINEER_NO_SCOPE = id(25);

const FILE_A = id(30);
const FILE_B = id(31);
const PAGE_A0 = id(40);
const PAGE_A1 = id(41);
const PAGE_B0 = id(42);

const BUNDLE_A = id(50);
const BUNDLE_B = id(51);
const LAYOUT_WITH_BLOCKS = id(60);
const LAYOUT_B = id(62);
const BLOCK_A0 = id(70);
const BLOCK_A1 = id(71);
const BLOCK_B0 = id(72);
const RUN_DOC_A = id(80);
const RUN_DOC_B = id(81);
/** Чужой прогон: заведён прямо фикстурой, чтобы проверить прямой доступ по id. */
const RUN_B = id(90);
const ARTIFACT_B = id(91);
const PAGE_TEXT_B = id(92);
const ARTIFACT_B_HTML = id(93);
const ARTIFACT_B_QA = id(94);
const ARTIFACT_B_ZIP = id(95);

/**
 * Бессрочная подписанная ссылка «формата сайта» (`export_crop_short_url`).
 *
 * Она кладётся в ХРАНИМЫЕ байты артефактов ровно потому, что именно так их
 * присылает RD WEB: проверять «в ответе нет ссылки» на содержимом, где её и не
 * было, значит не проверять ничего.
 */
const CROP_URL = 'https://rd.example.test/api/crops/abc123def456';

const ARTIFACT_MD_BODY = [
  '# Document: Чужой.pdf',
  '## Page 1',
  '### BLOCK #1 [TEXT]: blk_1',
  `> **Crop:** [Crop](${CROP_URL})`,
  '',
  'Секретный текст чужой поставки',
].join('\n');

const ARTIFACT_HTML_BODY =
  '<!doctype html><html><body><article id="block-blk_1">' +
  `<div class="block-crop"><b>Crop:</b> <a href="${CROP_URL}">Crop</a></div>` +
  '<div class="block-content"><p>Секретный текст чужой поставки</p></div>' +
  '</article></body></html>';

const ARTIFACT_QA_BODY = JSON.stringify(
  {
    job_id: 'job_b',
    expected_block_ids: ['blk_1'],
    checks: { markdown_contains_all_blocks: true, crop_urls: { blk_1: CROP_URL } },
    final_status: 'passed',
  },
  null,
  2,
);

/** Сырой архив: наружу он не санируется вовсе, поэтому и закрыт правом. */
const ARTIFACT_ZIP_BODY = `PK\u0003\u0004 ${CROP_URL} raw-archive-bytes`;

const SHA = (letter: string): string => letter.repeat(64);

const KC = {
  a: 'kc-recognition-a',
  b: 'kc-recognition-b',
  engineer: 'kc-recognition-engineer',
  manager: 'kc-recognition-manager',
  admin: 'kc-recognition-admin',
  engineerNoScope: 'kc-recognition-engineer-no-scope',
} as const;

const LOCAL_HASH_B = SHA('1');

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,

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

  // --- Подрядчик А: разметка с блоками и прогонами --------------------------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_A}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Поставка А', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_A}', '${SUBMISSION_A}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('a')}', 'blobs/${SHA('a')}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('b')}', 'blobs/${SHA('b')}', 4096, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_A}', '${REVISION_A}', '${SHA('a')}', 'АОСР.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A0}', '${REVISION_A}', '${FILE_A}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A1}', '${REVISION_A}', '${FILE_A}', 1, 1, 1654, 2339, 0)`,
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_A}', '${REVISION_A}', '${SHA('e')}', '${SHA('b')}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${REVISION_A}', 0, '${PAGE_A0}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${REVISION_A}', 1, '${PAGE_A1}')`,

  // Блоки нужны прогону: снимок набора считается по ним на старте.
  `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
     VALUES ('${LAYOUT_WITH_BLOCKS}', '${REVISION_A}', '${OBJECT}', '${BUNDLE_A}', 1, 'draft')`,
  `INSERT INTO layout_blocks (id, layout_revision_id, revision_id, bundle_id, source_page_id,
                              working_page_index, object_id, block_type, shape_type,
                              x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${BLOCK_A0}', '${LAYOUT_WITH_BLOCKS}', '${REVISION_A}', '${BUNDLE_A}', '${PAGE_A0}',
             0, '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.4, 0, 'auto', 'rf_detr')`,
  `INSERT INTO layout_blocks (id, layout_revision_id, revision_id, bundle_id, source_page_id,
                              working_page_index, object_id, block_type, shape_type,
                              x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${BLOCK_A1}', '${LAYOUT_WITH_BLOCKS}', '${REVISION_A}', '${BUNDLE_A}', '${PAGE_A1}',
             1, '${OBJECT}', 'text', 'rectangle', 0.1, 0.5, 0.9, 0.8, 0, 'auto', 'rf_detr')`,
  `UPDATE layout_revisions SET blocks_hash = '${SHA('7')}'
     WHERE id = '${LAYOUT_WITH_BLOCKS}'`,
  `INSERT INTO rd_run_documents (id, layout_revision_id, rd_document_id, rd_project_id)
     VALUES ('${RUN_DOC_A}', '${LAYOUT_WITH_BLOCKS}', 'doc_a', 'prj-portal')`,

  // --- Подрядчик Б: готовый чужой прогон с артефактом и текстом -------------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_B}', '${OBJECT}', '${ORG_B}', '${ORG_B}', 'roofing', DATE '2026-01-01', 'Поставка Б', '${USER_B}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_B}', '${SUBMISSION_B}', '${OBJECT}', '${ORG_B}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('c')}', 'blobs/${SHA('c')}', 700, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('d')}', 'blobs/${SHA('d')}', 700, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_B}', '${REVISION_B}', '${SHA('c')}', 'Чужой.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_B0}', '${REVISION_B}', '${FILE_B}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_B}', '${REVISION_B}', '${SHA('f')}', '${SHA('d')}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_B}', '${REVISION_B}', 0, '${PAGE_B0}')`,
  `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
     VALUES ('${LAYOUT_B}', '${REVISION_B}', '${OBJECT}', '${BUNDLE_B}', 1, 'draft')`,
  `INSERT INTO layout_blocks (id, layout_revision_id, revision_id, bundle_id, source_page_id,
                              working_page_index, object_id, block_type, shape_type,
                              x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${BLOCK_B0}', '${LAYOUT_B}', '${REVISION_B}', '${BUNDLE_B}', '${PAGE_B0}',
             0, '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.4, 0, 'auto', 'rf_detr')`,
  `UPDATE layout_revisions SET blocks_hash = '${LOCAL_HASH_B}'
     WHERE id = '${LAYOUT_B}'`,
  `INSERT INTO rd_run_documents (id, layout_revision_id, rd_document_id, rd_project_id)
     VALUES ('${RUN_DOC_B}', '${LAYOUT_B}', 'doc_b', 'prj-portal')`,
  `INSERT INTO recognition_runs (id, revision_id, layout_revision_id, rd_run_document_id,
                                 local_layout_hash, remote_layout_hash_before,
                                 remote_layout_hash_after, working_pdf_sha256, status, finished_at)
     VALUES ('${RUN_B}', '${REVISION_B}', '${LAYOUT_B}', '${RUN_DOC_B}',
             '${LOCAL_HASH_B}', '${LOCAL_HASH_B}', '${LOCAL_HASH_B}', '${SHA('d')}', 'done', now())`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ARTIFACT_B}', '${RUN_B}', 'md', '${artifactKey(RUN_B, 'md')}',
             '${sha256Of(ARTIFACT_MD_BODY)}', ${Buffer.byteLength(ARTIFACT_MD_BODY)})`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ARTIFACT_B_HTML}', '${RUN_B}', 'html', '${artifactKey(RUN_B, 'html')}',
             '${sha256Of(ARTIFACT_HTML_BODY)}', ${Buffer.byteLength(ARTIFACT_HTML_BODY)})`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ARTIFACT_B_QA}', '${RUN_B}', 'qa', '${artifactKey(RUN_B, 'qa')}',
             '${sha256Of(ARTIFACT_QA_BODY)}', ${Buffer.byteLength(ARTIFACT_QA_BODY)})`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ARTIFACT_B_ZIP}', '${RUN_B}', 'zip', '${artifactKey(RUN_B, 'zip')}',
             '${sha256Of(ARTIFACT_ZIP_BODY)}', ${Buffer.byteLength(ARTIFACT_ZIP_BODY)})`,
  `INSERT INTO page_text_versions (id, revision_id, source_page_id, recognition_run_id,
                                   artifact_version_id, text_md, text_sha256)
     VALUES ('${PAGE_TEXT_B}', '${REVISION_B}', '${PAGE_B0}', '${RUN_B}', '${ARTIFACT_B}',
             'Секретный текст чужой поставки', '${SHA('8')}')`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-recognition-routes-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-recognition-tests-01234',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-recognition-tests',
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

  // Байты чужих артефактов существуют: иначе «404 по изоляции» и «404 потому
  // что файла нет» стали бы неразличимы, и проверка ничего не доказывала бы.
  // Хранятся они ПОБАЙТОВО, со ссылкой внутри, — как и приходят из RD WEB.
  const bodies: readonly [string, string][] = [
    ['md', ARTIFACT_MD_BODY],
    ['html', ARTIFACT_HTML_BODY],
    ['qa', ARTIFACT_QA_BODY],
    ['zip', ARTIFACT_ZIP_BODY],
  ];
  for (const [kind, body] of bodies) {
    const target = join(STORAGE_DIR, artifactKey(RUN_B, kind as 'md'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 180_000);

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
  options: { readonly body?: unknown; readonly idempotencyKey?: string | null } = {},
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
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
}

async function jobRows(type: string): Promise<readonly { payload: string }[]> {
  return db.query<{ payload: string }>(
    `SELECT payload::text AS payload FROM jobs WHERE type = '${type}' ORDER BY created_at`,
  );
}

async function runRows(): Promise<readonly { id: string; status: string }[]> {
  return db.query<{ id: string; status: string }>(
    `SELECT id, status FROM recognition_runs WHERE revision_id = '${REVISION_A}'`,
  );
}

describe('POST /revisions/{id}/recognize', () => {
  it('без Idempotency-Key отвечает 400 и НИЧЕГО не ставит в очередь', async () => {
    const before = await jobRows('layout.reconcile');
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/recognize`, {
      body: { layoutId: LAYOUT_WITH_BLOCKS },
    });
    expect(response.statusCode).toBe(400);
    expect(await jobRows('layout.reconcile')).toHaveLength(before.length);
    expect(await runRows()).toHaveLength(0);
  });

  it('чужая ревизия разметки не распознаётся даже по прямому идентификатору', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/recognize`, {
      body: { layoutId: LAYOUT_B },
      idempotencyKey: 'foreign-layout',
    });
    expect(response.statusCode).toBe(404);
    expect(await runRows()).toHaveLength(0);
  });

  it('руководителю запуск распознавания не разрешён', async () => {
    const response = await as(KC.manager, 'POST', `/api/v1/revisions/${REVISION_A}/recognize`, {
      body: { layoutId: LAYOUT_WITH_BLOCKS },
      idempotencyKey: 'manager-attempt',
    });
    expect(response.statusCode).toBe(403);
    expect(await runRows()).toHaveLength(0);
  });

  /**
   * Главная проверка маршрута: строка в `jobs` и строка в `recognition_runs`.
   * Проверяется таблица, а не код ответа — ровно то, чего не хватило на S5.
   */
  it('создаёт прогон и кладёт задачу цикла сверки в jobs', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/recognize`, {
      body: { layoutId: LAYOUT_WITH_BLOCKS },
      idempotencyKey: 'run-1',
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{
      recognitionRunId: string;
      created: boolean;
      jobCreated: boolean;
    }>();
    expect(body.created).toBe(true);
    expect(body.jobCreated).toBe(true);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('running');

    const jobs = await jobRows('layout.reconcile');
    expect(jobs).toHaveLength(1);
    const payload = JSON.parse(jobs[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload.recognitionRunId).toBe(body.recognitionRunId);
    expect(payload.revisionId).toBe(REVISION_A);
  });

  it('повторный запрос не заводит второй прогон и второй job', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/recognize`, {
      body: { layoutId: LAYOUT_WITH_BLOCKS },
      idempotencyKey: 'run-1',
    });
    expect(response.statusCode).toBe(202);
    expect(response.json<{ created: boolean }>().created).toBe(false);

    expect(await runRows()).toHaveLength(1);
    expect(await jobRows('layout.reconcile')).toHaveLength(1);
  });

  it('снимок настроек прогона не содержит ни пароля, ни адреса RD WEB', async () => {
    const rows = await db.query<{ snapshot: string }>(
      `SELECT settings_snapshot::text AS snapshot FROM recognition_runs WHERE revision_id = '${REVISION_A}'`,
    );
    const snapshot = rows[0]?.snapshot ?? '';
    expect(snapshot).toContain('qwen2.5-vl-7b');
    expect(snapshot).not.toContain('portal-secret-of-tests');
    expect(snapshot).not.toContain('127.0.0.1');
    expect(snapshot.toLowerCase()).not.toContain('password');
  });
});

describe('изоляция прогонов, артефактов и текста страниц', () => {
  it('чужой прогон не виден ни списком, ни по прямому идентификатору', async () => {
    const list = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/recognition-runs`);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);

    const direct = await as(KC.a, 'GET', `/api/v1/recognition-runs/${RUN_B}`);
    expect(direct.statusCode).toBe(404);
  });

  it('чужие артефакты не перечисляются и не выдаются файлом', async () => {
    const list = await as(KC.a, 'GET', `/api/v1/recognition-runs/${RUN_B}/artifacts`);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);

    const content = await as(KC.a, 'GET', `/api/v1/recognition-runs/${RUN_B}/artifacts/md/content`);
    expect(content.statusCode).toBe(404);
    expect(content.body).not.toContain('Секретный текст');
  });

  it('чужой распознанный текст страниц не выдаётся', async () => {
    const pages = await as(KC.a, 'GET', `/api/v1/recognition-runs/${RUN_B}/pages`);
    expect(pages.statusCode).toBe(200);
    expect(pages.json<{ items: unknown[] }>().items).toEqual([]);
    expect(pages.body).not.toContain('Секретный текст');
  });

  it('владелец те же данные получает', async () => {
    const direct = await as(KC.b, 'GET', `/api/v1/recognition-runs/${RUN_B}`);
    expect(direct.statusCode).toBe(200);

    const content = await as(KC.b, 'GET', `/api/v1/recognition-runs/${RUN_B}/artifacts/md/content`);
    expect(content.statusCode).toBe(200);
    // Хэш ХРАНИМОГО артефакта — тот же, что в `artifact_versions`: выдача
    // санируется, а хранение остаётся побайтовым (ADR-0005 п. 4).
    expect(content.headers['x-artifact-sha256']).toBe(sha256Of(ARTIFACT_MD_BODY));
    expect(content.body).toContain('Секретный текст чужой поставки');

    const pages = await as(KC.b, 'GET', `/api/v1/recognition-runs/${RUN_B}/pages`);
    expect(pages.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('инженер объекта видит прогоны обоих подрядчиков', async () => {
    const direct = await as(KC.engineer, 'GET', `/api/v1/recognition-runs/${RUN_B}`);
    expect(direct.statusCode).toBe(200);
  });

  /**
   * Право `markup.read` у инженера есть, но область видимости пуста: объектов
   * ему не назначено. Первый уровень изоляции пропускает, второй обязан не
   * пропустить — и проверяется именно это, а не «инженеру можно всё».
   */
  it('инженер без назначенных объектов не видит ни прогона, ни текста', async () => {
    const direct = await as(KC.engineerNoScope, 'GET', `/api/v1/recognition-runs/${RUN_B}`);
    expect(direct.statusCode).toBe(404);

    const list = await as(
      KC.engineerNoScope,
      'GET',
      `/api/v1/revisions/${REVISION_B}/recognition-runs`,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);

    const artifacts = await as(
      KC.engineerNoScope,
      'GET',
      `/api/v1/recognition-runs/${RUN_B}/artifacts`,
    );
    expect(artifacts.json<{ items: unknown[] }>().items).toEqual([]);

    const content = await as(
      KC.engineerNoScope,
      'GET',
      `/api/v1/recognition-runs/${RUN_B}/artifacts/md/content`,
    );
    expect(content.statusCode).toBe(404);
    expect(content.body).not.toContain('Секретный текст');

    const pages = await as(KC.engineerNoScope, 'GET', `/api/v1/recognition-runs/${RUN_B}/pages`);
    expect(pages.json<{ items: unknown[] }>().items).toEqual([]);
    expect(pages.body).not.toContain('Секретный текст');
  });
});

/**
 * Подписанные ссылки RD WEB наружу не выходят (§11, ADR-0005 п. 9).
 *
 * Ссылка на кроп — бессрочная и подписанная, а отдача кропа у них публичная,
 * то есть попавший наружу URL даёт чтение фрагмента чужой ИД в обход их RBAC.
 * Вырезание из `page_text_versions.text_md` эту дыру НЕ закрывало: выдача
 * содержимого артефакта отдавала те же ссылки в четырёх видах сразу.
 *
 * Проверяется с двух сторон: ссылки в ответе нет И содержимое, ради которого
 * артефакт запрашивают, на месте.
 */
describe('выдача содержимого артефакта санируется', () => {
  it('в хранимых байтах ссылка ЕСТЬ — иначе проверять было бы нечего', async () => {
    for (const body of [ARTIFACT_MD_BODY, ARTIFACT_HTML_BODY, ARTIFACT_QA_BODY]) {
      expect(body).toContain('api/crops');
    }
  });

  it('markdown отдаётся без строки провенанса, но с текстом документа', async () => {
    const response = await as(
      KC.b,
      'GET',
      `/api/v1/recognition-runs/${RUN_B}/artifacts/md/content`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('api/crops');
    expect(response.body).not.toContain('https://');
    expect(response.body).not.toContain('**Crop:**');
    expect(response.body).toContain('Секретный текст чужой поставки');
    expect(response.body).toContain('### BLOCK #1 [TEXT]: blk_1');
  });

  it('html отдаётся без ссылки на кроп, но с содержимым блока', async () => {
    const response = await as(
      KC.b,
      'GET',
      `/api/v1/recognition-runs/${RUN_B}/artifacts/html/content`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('api/crops');
    expect(response.body).not.toContain('href=');
    expect(response.body).toContain('Секретный текст чужой поставки');
    expect(response.body).toContain('id="block-blk_1"');
  });

  it('qa-манифест отдаётся без ссылок и остаётся валидным JSON', async () => {
    const response = await as(
      KC.b,
      'GET',
      `/api/v1/recognition-runs/${RUN_B}/artifacts/qa/content`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('api/crops');

    const parsed = JSON.parse(response.body) as {
      job_id: string;
      final_status: string;
      checks: { markdown_contains_all_blocks: boolean };
    };
    expect(parsed.job_id).toBe('job_b');
    expect(parsed.final_status).toBe('passed');
    expect(parsed.checks.markdown_contains_all_blocks).toBe(true);
  });

  it('заголовки различают хэш хранимого артефакта и хэш отданных байт', async () => {
    const response = await as(
      KC.b,
      'GET',
      `/api/v1/recognition-runs/${RUN_B}/artifacts/md/content`,
    );
    expect(response.headers['x-artifact-sha256']).toBe(sha256Of(ARTIFACT_MD_BODY));
    // Тело санировано, поэтому его хэш обязан ОТЛИЧАТЬСЯ от хранимого: иначе
    // получатель считал бы, что байты не сошлись с заявленным хэшем.
    expect(response.headers['x-artifact-content-sha256']).toBe(sha256Of(response.body));
    expect(response.headers['x-artifact-content-sha256']).not.toBe(
      response.headers['x-artifact-sha256'],
    );
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body));
  });

  /**
   * Сырой архив санировать нельзя: его байты описываются `artifact_sha256`
   * (ADR-0005 п. 4 и 8). Поэтому он закрыт правом — читатель архива это
   * администратор на экране диагностики, а не подрядчик, которому нужен текст.
   */
  it('сырой архив подрядчику и инженеру не отдаётся', async () => {
    for (const kc of [KC.b, KC.engineer]) {
      const response = await as(
        kc,
        'GET',
        `/api/v1/recognition-runs/${RUN_B}/artifacts/zip/content`,
      );
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('api/crops');
    }
  });

  it('администратору архив отдаётся байт в байт', async () => {
    const response = await as(
      KC.admin,
      'GET',
      `/api/v1/recognition-runs/${RUN_B}/artifacts/zip/content`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(ARTIFACT_ZIP_BODY);
    expect(response.headers['x-artifact-sha256']).toBe(sha256Of(ARTIFACT_ZIP_BODY));
  });

  /** Список артефактов ссылок не содержит и остаётся доступным как раньше. */
  it('список артефактов с хэшами и размерами доступен владельцу', async () => {
    const response = await as(KC.b, 'GET', `/api/v1/recognition-runs/${RUN_B}/artifacts`);
    expect(response.statusCode).toBe(200);
    const items = response.json<{
      items: { kind: string; artifactSha256: string; byteSize: number }[];
    }>().items;
    expect(items.map((item) => item.kind).sort()).toEqual(['html', 'md', 'qa', 'zip']);
    expect(items.find((item) => item.kind === 'md')?.artifactSha256).toBe(
      sha256Of(ARTIFACT_MD_BODY),
    );
    expect(response.body).not.toContain('api/crops');
    expect(response.body).not.toContain('s3Key');
  });
});
