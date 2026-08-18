/**
 * Согласование, выдача и удержания через HTTP на собранном приложении (§4.1,
 * §4.2, §9.6, §13, §14).
 *
 * Поднимается штатный `buildApp()`. Проверяется не «эндпоинт отвечает 200», а
 * последствия и границы:
 *
 * 1. **права разведены по действиям**: подрядчик подаёт, но не согласует;
 *    инженер согласует и возвращает, но не снимает блокирующее замечание;
 *    руководитель снимает; администратор без роли `manager` не согласует (§4.1);
 * 2. **изоляция** (§1.6, non-degradable): чужая ревизия не читается, не
 *    подаётся, не согласуется, её архив и нарезки не отдаются ни списком, ни по
 *    прямому идентификатору, ни выдачей содержимого;
 * 3. **нажатие кладёт строку в `jobs`** — проверено по ТАБЛИЦЕ (урок S5):
 *    согласование ставит `submission.build_archive`, подтверждение границ —
 *    `doc.materialize_pdf`;
 * 4. **`If-Match` обязателен** на каждом переходе, устаревшая версия даёт 412;
 * 5. **предусловия перечисляются списком**, а не первым найденным отказом;
 * 6. **возврат закрывает ревизию и открывает новую draft** с
 *    `parent_revision_id`, а закрытая не переоткрывается;
 * 7. **обоснование обязательно**: короткая причина отвергается схемой.
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
/** Готовая к согласованию поставка А2: документы подтверждены и нарезаны. */
const SUBMISSION_C = id(14);
const REVISION_C = id(15);

const USER_A = id(20);
const USER_B = id(21);
const USER_ENGINEER = id(22);
const USER_MANAGER = id(23);
const USER_ADMIN = id(24);

const FILE_A = id(30);
const FILE_B = id(31);
const FILE_C = id(32);
const PAGE_A0 = id(40);
const PAGE_B0 = id(41);
const PAGE_C0 = id(42);
const BUNDLE_A = id(50);
const BUNDLE_B = id(51);
const BUNDLE_C = id(52);
const DOC_C = id(60);
const DOC_B = id(61);
const RULESET_VERSION = id(70);
const RUN_C = id(71);
const FINDING_C = id(72);
const RULE_CODE = 'AOSR.HDR.010';

const SHA = (letter: string): string => letter.repeat(64);

/** Маркер чужих данных: проверка «в ответе его нет» осмысленна лишь потому, что у владельца он ЕСТЬ. */
const SECRET = 'СЕКРЕТНЫЙ-ФРАГМЕНТ-ПОСТАВКИ-Б';

const KC = {
  a: 'kc-workflow-a',
  b: 'kc-workflow-b',
  engineer: 'kc-workflow-engineer',
  manager: 'kc-workflow-manager',
  admin: 'kc-workflow-admin',
} as const;

function submission(input: {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly contractorId: string;
  readonly fileId: string;
  readonly pageId: string;
  readonly bundleId: string;
  readonly sha: string;
  readonly fileName: string;
}): readonly string[] {
  return [
    `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
       VALUES ('${input.submissionId}', '${VOLUME}', '${OBJECT}', '${input.contractorId}', 'Поставка', '${USER_A}')`,
    `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
       VALUES ('${input.revisionId}', '${input.submissionId}', '${OBJECT}', '${input.contractorId}', 1, 'draft')`,
    `UPDATE submissions SET current_revision_id = '${input.revisionId}' WHERE id = '${input.submissionId}'`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${input.fileId}', '${input.revisionId}', '${input.sha}', '${input.fileName}', 0, 'ok')`,
    `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
       VALUES ('${input.pageId}', '${input.revisionId}', '${input.fileId}', 0, 0, 1654, 2339, 0)`,
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${input.bundleId}', '${input.revisionId}', '${MANIFEST_OF(input.sha)}', '${input.sha}', 'bundle/1+pdf-lib')`,
    `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
       VALUES ('${input.bundleId}', '${input.revisionId}', 0, '${input.pageId}')`,
  ];
}

/**
 * Хэш манифеста считается тем же кодом, что и в бою.
 *
 * Захардкоженное значение разъехалось бы с `computeAggregateManifestHash()`
 * молча, и подача перестала бы проходить по причине, не имеющей отношения к
 * тесту.
 */
function MANIFEST_OF(sha: string): string {
  return manifestHash(sha);
}

let manifestHash: (sha: string) => string;

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-workflow-routes-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-workflow-tests-01234567',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-workflow-tests',
  RATE_LIMIT_MAX: '100000',
  RETENTION_DAYS: '30',
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
    `INSERT INTO section_kinds (code, name) VALUES ('roofing', 'Кровля')`,
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
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_A}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_B}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
    `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA('a')}', 'blobs/aa/aa/${SHA('a')}', 2048, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA('c')}', 'blobs/cc/cc/${SHA('c')}', 512, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA('d')}', 'blobs/dd/dd/${SHA('d')}', 1024, 'application/pdf')`,

    ...submission({
      submissionId: SUBMISSION_A,
      revisionId: REVISION_A,
      contractorId: ORG_A,
      fileId: FILE_A,
      pageId: PAGE_A0,
      bundleId: BUNDLE_A,
      sha: SHA('a'),
      fileName: 'akt.pdf',
    }),
    ...submission({
      submissionId: SUBMISSION_B,
      revisionId: REVISION_B,
      contractorId: ORG_B,
      fileId: FILE_B,
      pageId: PAGE_B0,
      bundleId: BUNDLE_B,
      sha: SHA('c'),
      fileName: 'chuzhoy.pdf',
    }),
    ...submission({
      submissionId: SUBMISSION_C,
      revisionId: REVISION_C,
      contractorId: ORG_A,
      fileId: FILE_C,
      pageId: PAGE_C0,
      bundleId: BUNDLE_C,
      sha: SHA('d'),
      fileName: 'gotovyi.pdf',
    }),

    // Документ поставки Б с маркером: чужие данные обязаны существовать, иначе
    // «в ответе их нет» доказывало бы отсутствие данных вообще.
    `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal, title, is_confirmed, confirmed_by)
       VALUES ('${DOC_B}', '${REVISION_B}', '${OBJECT}', '${ORG_B}', 0, '${SECRET}', true, '${USER_ENGINEER}')`,
    `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
       VALUES ('${REVISION_B}', '${PAGE_B0}', '${DOC_B}', 0)`,

    // Поставка C доведена до состояния «можно согласовывать»: прогон проверок
    // завершён, документ подтверждён и нарезан.
    `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal, title, is_confirmed, confirmed_by,
                                    derived_pdf_blob_sha256, derived_pdf_page_count, derived_pdf_bytes,
                                    derived_pdf_built_at, derived_pdf_toolkit, derived_note_applied)
       VALUES ('${DOC_C}', '${REVISION_C}', '${OBJECT}', '${ORG_A}', 0, 'АОСР № 1', true, '${USER_ENGINEER}',
               '${SHA('e')}', 1, 1024, now(), 'pdf-lib', true)`,
    `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
       VALUES ('${REVISION_C}', '${PAGE_C0}', '${DOC_C}', 0)`,
    `INSERT INTO ruleset_versions (id, version, published_at, published_by)
       VALUES ('${RULESET_VERSION}', 'v1', now(), '${USER_ADMIN}')`,
    `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, started_at, finished_at, counts)
       VALUES ('${RUN_C}', '${REVISION_C}', '${RULESET_VERSION}', now(), now(), '{}'::jsonb)`,
    `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                           severity, state, origin, is_blocking, target_type, message)
       VALUES ('${FINDING_C}', '${RUN_C}', '${REVISION_C}', '${OBJECT}', '${ORG_A}', '${RULE_CODE}',
               'error', 'open', 'deterministic', true, 'revision', 'ОГРН не проходит контрольную сумму')`,

    // Подача: с этого момента состав заперт триггерами класса `source`.
    `UPDATE submission_revisions SET status = 'submitted', submitted_at = now(), submitted_by = '${USER_A}'
       WHERE id IN ('${REVISION_B}', '${REVISION_C}')`,
  ];

  for (const statement of fixture) {
    await db.query(statement);
  }

  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 240_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (db !== undefined) await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// =====================================================================
// Сессии
// =====================================================================

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
  method: 'GET' | 'POST',
  url: string,
  options: {
    readonly body?: unknown;
    readonly ifMatch?: string | null;
    readonly idempotencyKey?: string | null;
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
      ...(options.ifMatch !== undefined && options.ifMatch !== null
        ? { 'if-match': options.ifMatch }
        : {}),
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

async function versionOf(revisionId: string): Promise<string> {
  const rows = await db.query<{ version: number }>(
    `SELECT version FROM submission_revisions WHERE id = '${revisionId}'`,
  );
  return String(rows[0]?.version ?? 0);
}

async function statusOf(revisionId: string): Promise<string> {
  const rows = await db.query<{ status: string }>(
    `SELECT status FROM submission_revisions WHERE id = '${revisionId}'`,
  );
  return rows[0]?.status ?? '';
}

// =====================================================================
// Права
// =====================================================================

describe('права на действия согласования (§4.1)', () => {
  it('подрядчик не согласует, не возвращает и не снимает замечания', async () => {
    for (const url of [
      `/api/v1/revisions/${REVISION_C}/approve`,
      `/api/v1/revisions/${REVISION_C}/return`,
      `/api/v1/revisions/${REVISION_C}/review`,
    ]) {
      const response = await as(KC.a, 'POST', url, {
        body: { reason: 'обоснованная причина возврата комплекта' },
        ifMatch: await versionOf(REVISION_C),
      });
      expect(response.statusCode).toBe(403);
    }
    const override = await as(KC.a, 'POST', `/api/v1/findings/${FINDING_C}/override`, {
      body: { reason: 'подрядчик снимает собственное замечание' },
    });
    expect(override.statusCode).toBe(403);
  });

  it('инженер не снимает блокирующее замечание — это право руководителя', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/findings/${FINDING_C}/override`, {
      body: { reason: 'инженер пытается снять блокирующее замечание' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('администратор без роли manager не согласует (§4.1)', async () => {
    const response = await as(KC.admin, 'POST', `/api/v1/revisions/${REVISION_C}/approve`, {
      body: {},
      ifMatch: await versionOf(REVISION_C),
    });
    expect(response.statusCode).toBe(403);
  });

  it('инженер не подаёт комплект за подрядчика', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/submit`, {
      body: {},
      ifMatch: await versionOf(REVISION_A),
    });
    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Изоляция
// =====================================================================

describe('изоляция подрядчиков (§1.6, non-degradable)', () => {
  it('чужая ревизия не читается и не подаётся по прямому идентификатору', async () => {
    expect((await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/workflow`)).statusCode).toBe(
      404,
    );
    const submit = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_B}/submit`, {
      body: {},
      ifMatch: '0',
    });
    expect(submit.statusCode).toBe(404);
  });

  it('чужой архив не отдаётся ни описанием, ни содержимым', async () => {
    expect((await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/archive`)).statusCode).toBe(404);
    expect(
      (await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/archive/content`)).statusCode,
    ).toBe(404);
  });

  it('чужая нарезка не отдаётся и её заголовок не утекает', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/documents/${DOC_B}/pdf`);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(SECRET);
  });

  it('чужие удержания и отчёт по хранению не читаются подрядчиком', async () => {
    expect((await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/legal-holds`)).statusCode).toBe(
      403,
    );
    expect((await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/retention`)).statusCode).toBe(
      403,
    );
  });
});

// =====================================================================
// Состояние согласования
// =====================================================================

describe('GET /revisions/{id}/workflow', () => {
  /**
   * Счётчики готовности считаются коррелирующими подзапросами, и именно на них
   * ловится дефект рендеринга SQL: ссылка на внешнюю таблицу через объект
   * Drizzle в запросе без джойнов теряет квалификатор, и КАЖДЫЙ счётчик молча
   * возвращает ноль. Ноль при этом выглядит правдоподобно — «просто ничего
   * нет», — поэтому проверяются ненулевые значения на фикстуре, где данные
   * заведомо есть.
   */
  it('счётчики готовности считают реальные строки, а не нули', async () => {
    const response = await as(KC.engineer, 'GET', `/api/v1/revisions/${REVISION_C}/workflow`);
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      readiness: {
        fileCount: number;
        hasBundle: boolean;
        documentCount: number;
        unconfirmedDocuments: number;
        unmaterializedDocuments: number;
        openBlockingFindings: number;
        finishedValidationRuns: number;
      };
      approveBlockers: readonly string[];
      actions: readonly unknown[];
    };

    expect(body.readiness.fileCount).toBe(1);
    expect(body.readiness.hasBundle).toBe(true);
    expect(body.readiness.documentCount).toBe(1);
    expect(body.readiness.unconfirmedDocuments).toBe(0);
    expect(body.readiness.unmaterializedDocuments).toBe(0);
    expect(body.readiness.openBlockingFindings).toBe(1);
    expect(body.readiness.finishedValidationRuns).toBe(1);

    // Единственное препятствие — открытое блокирующее замечание.
    expect(body.approveBlockers).toHaveLength(1);
    expect(body.approveBlockers[0]).toContain('блокирующих замечаний');
  });

  it('подрядчик видит состояние СВОЕЙ ревизии', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_C}/workflow`);
    expect(response.statusCode).toBe(200);
  });
});

// =====================================================================
// Подача
// =====================================================================

describe('POST /revisions/{id}/submit', () => {
  it('без If-Match отвечает 400 и статус не меняется', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/submit`, {
      body: {},
    });
    expect(response.statusCode).toBe(400);
    expect(await statusOf(REVISION_A)).toBe('draft');
  });

  it('устаревшая версия даёт 412', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/submit`, {
      body: {},
      ifMatch: '99',
    });
    expect(response.statusCode).toBe(412);
    expect(await statusOf(REVISION_A)).toBe('draft');
  });

  it('подача переводит ревизию в submitted и пиннит хэш состава', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/submit`, {
      body: { comment: 'комплект собран' },
      ifMatch: await versionOf(REVISION_A),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { revision: { status: string; aggregateManifestHash: string } };
    expect(body.revision.status).toBe('submitted');
    expect(body.revision.aggregateManifestHash).toBe(manifestHash(SHA('a')));

    // След действия обязан быть, иначе «кто подал» неотвечаемо.
    const actions = await db.query<{ action: string }>(
      `SELECT action FROM review_actions WHERE revision_id = '${REVISION_A}'`,
    );
    expect(actions.map((row) => row.action)).toContain('submit');
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = '${REVISION_A}'`,
    );
    expect(audit.map((row) => row.action)).toContain('revision.submit');
  });

  it('повторная подача уже поданной ревизии отвергается', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/submit`, {
      body: {},
      ifMatch: await versionOf(REVISION_A),
    });
    expect(response.statusCode).toBe(409);
  });
});

// =====================================================================
// Согласование
// =====================================================================

describe('POST /revisions/{id}/approve', () => {
  it('перечисляет ВСЕ препятствия, а не первое найденное', async () => {
    // У ревизии A нет ни прогона проверок, ни документов — оба факта обязаны
    // прозвучать сразу, иначе разговор с подрядчиком идёт по одному отказу за
    // раз.
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/approve`, {
      body: {},
      ifMatch: await versionOf(REVISION_A),
    });
    expect(response.statusCode).toBe(409);
    const detail = (response.json() as { detail: string }).detail;
    expect(detail).toContain('прогон проверок');
    expect(detail).toContain('логического документа');
  });

  it('открытое блокирующее замечание закрывает согласование', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_C}/approve`, {
      body: {},
      ifMatch: await versionOf(REVISION_C),
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { detail: string }).detail).toContain('блокирующих замечаний');
    expect(await statusOf(REVISION_C)).toBe('submitted');
  });

  it('короткое обоснование override отвергается схемой', async () => {
    const response = await as(KC.manager, 'POST', `/api/v1/findings/${FINDING_C}/override`, {
      body: { reason: 'ок' },
    });
    // 422: схема тела отвергает обоснование короче содержательного минимума.
    expect(response.statusCode).toBe(422);
    const state = await db.query<{ state: string }>(
      `SELECT state FROM findings WHERE id = '${FINDING_C}'`,
    );
    expect(state[0]?.state).toBe('open');
  });

  it('руководитель снимает замечание с обоснованием и следом в аудите', async () => {
    const response = await as(KC.manager, 'POST', `/api/v1/findings/${FINDING_C}/override`, {
      body: { reason: 'ОГРН подтверждён выпиской ЕГРЮЛ, приложенной вне комплекта' },
    });
    expect(response.statusCode).toBe(200);

    const finding = await db.query<{ state: string; waiver_reason: string; waived_by: string }>(
      `SELECT state, waiver_reason, waived_by FROM findings WHERE id = '${FINDING_C}'`,
    );
    expect(finding[0]?.state).toBe('waived');
    expect(finding[0]?.waived_by).toBe(USER_MANAGER);
    expect(finding[0]?.waiver_reason).toContain('ЕГРЮЛ');

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = '${REVISION_C}' AND action = 'revision.override'`,
    );
    expect(audit).toHaveLength(1);
  });

  it('согласование ставит сборку архива строкой в jobs (проверено по таблице)', async () => {
    expect(await jobRows('submission.build_archive')).toHaveLength(0);

    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_C}/approve`, {
      body: { comment: 'замечаний нет' },
      ifMatch: await versionOf(REVISION_C),
    });
    expect(response.statusCode).toBe(200);
    expect(await statusOf(REVISION_C)).toBe('approved');

    const jobs = await jobRows('submission.build_archive');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toContain(REVISION_C);
  });

  it('архив согласованной ревизии числится ожидаемым, пока задача не отработала', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_C}/archive`);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { state: string }).state).toBe('pending');

    // Содержимое при этом не выдаётся: 409 с объяснением, а не 404 и не
    // «пустой архив».
    const content = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_C}/archive/content`);
    expect(content.statusCode).toBe(409);
  });

  it('согласованную ревизию нельзя согласовать или вернуть повторно', async () => {
    const version = await versionOf(REVISION_C);
    expect(
      (
        await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_C}/approve`, {
          body: {},
          ifMatch: version,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_C}/return`, {
          body: { reason: 'попытка вернуть уже согласованную ревизию' },
          ifMatch: version,
        })
      ).statusCode,
    ).toBe(409);
  });
});

// =====================================================================
// Возврат
// =====================================================================

describe('POST /revisions/{id}/return', () => {
  it('возврат закрывает ревизию и открывает новую draft с parent_revision_id', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/return`, {
      body: { reason: 'в акте не совпадает число слоёв гидроизоляции с приложением' },
      ifMatch: await versionOf(REVISION_A),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { nextRevisionId: string };
    expect(body.nextRevisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await statusOf(REVISION_A)).toBe('returned');

    const next = await db.query<{
      status: string;
      parent_revision_id: string;
      revision_no: number;
    }>(
      `SELECT status, parent_revision_id, revision_no FROM submission_revisions WHERE id = '${body.nextRevisionId}'`,
    );
    expect(next[0]?.status).toBe('draft');
    expect(next[0]?.parent_revision_id).toBe(REVISION_A);
    expect(next[0]?.revision_no).toBe(2);

    // Указатель поставки переведён: экран поставки обязан открывать новую
    // ревизию, а не закрытую возвратом.
    const submissionRow = await db.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM submissions WHERE id = '${SUBMISSION_A}'`,
    );
    expect(submissionRow[0]?.current_revision_id).toBe(body.nextRevisionId);
  });

  it('возвращённая ревизия не переоткрывается: БД отвергает возврат в draft', async () => {
    // Инвариант держит триггер, а не только код: §3 требует новой ревизии, а
    // не оживления закрытой.
    await expect(
      db.query(`UPDATE submission_revisions SET status = 'draft' WHERE id = '${REVISION_A}'`),
    ).rejects.toThrow(/неизменяем|поданную ревизию/);
  });
});

// =====================================================================
// Нарезка
// =====================================================================

describe('нарезка документов', () => {
  it('подтверждение границ кладёт doc.materialize_pdf строкой в jobs', async () => {
    // Ревизия Б в статусе `submitted`, документ подтверждён повторно инженером
    // с областью на объект. Проверяется ТАБЛИЦА, а не вызов в коде (урок S5).
    const before = (await jobRows('doc.materialize_pdf')).length;
    const version = await db.query<{ version: number }>(
      `SELECT version FROM logical_documents WHERE id = '${DOC_B}'`,
    );

    const response = await as(KC.engineer, 'POST', `/api/v1/documents/${DOC_B}/confirm`, {
      body: {},
      ifMatch: String(version[0]?.version ?? 0),
    });
    expect(response.statusCode).toBe(200);

    const jobs = await jobRows('doc.materialize_pdf');
    expect(jobs).toHaveLength(before + 1);
    expect(jobs.at(-1)?.payload).toContain(DOC_B);
  });

  it('пересборка нарезки доступна проверяющему и недоступна подрядчику', async () => {
    expect(
      (await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/materialize`, { body: {} }))
        .statusCode,
    ).toBe(403);
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_B}/materialize`, {
      body: {},
      idempotencyKey: 'retry-1',
    });
    expect(response.statusCode).toBe(202);
  });
});

// =====================================================================
// Retention и legal hold
// =====================================================================

describe('retention и legal hold (§4.2)', () => {
  it('отчёт по хранению объясняет, почему данные ещё лежат', async () => {
    const response = await as(KC.admin, 'GET', `/api/v1/revisions/${REVISION_C}/retention`);
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      policy: { retentionDays: number };
      decision: { deletable: boolean; blocks: readonly string[]; retainedUntil: string };
    };
    expect(body.policy.retentionDays).toBe(30);
    expect(body.decision.deletable).toBe(false);
    expect(body.decision.blocks).toContain('retention_not_expired');
    expect(body.decision.retainedUntil).not.toBeNull();
  });

  it('удержание накладывается, блокирует удаление и снимается один раз', async () => {
    const placed = await as(KC.admin, 'POST', `/api/v1/revisions/${REVISION_C}/legal-holds`, {
      body: { reason: 'запрос следственного органа по объекту TST01' },
    });
    expect(placed.statusCode).toBe(201);
    const holdId = (placed.json() as { id: string }).id;

    // Второе действующее удержание невозможно: инвариант держит частичный
    // уникальный индекс, а не аккуратность вызывающего.
    const second = await as(KC.admin, 'POST', `/api/v1/revisions/${REVISION_C}/legal-holds`, {
      body: { reason: 'второе удержание по той же ревизии' },
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);

    const report = await as(KC.admin, 'GET', `/api/v1/revisions/${REVISION_C}/retention`);
    expect(
      (report.json() as { decision: { blocks: readonly string[] } }).decision.blocks,
    ).toContain('legal_hold');

    const released = await as(KC.admin, 'POST', `/api/v1/legal-holds/${holdId}/release`, {
      body: { note: 'производство по запросу завершено, удержание снято' },
    });
    expect(released.statusCode).toBe(200);
    expect((released.json() as { releasedAt: string | null }).releasedAt).not.toBeNull();

    const again = await as(KC.admin, 'POST', `/api/v1/legal-holds/${holdId}/release`, {
      body: { note: 'повторное снятие того же удержания' },
    });
    expect(again.statusCode).toBe(409);
  });
});
