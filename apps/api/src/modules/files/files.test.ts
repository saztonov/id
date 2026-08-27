/**
 * Приём файлов (§4.2): проверки через HTTP на собранном приложении.
 *
 * Приложение поднимается штатным `buildApp()` поверх настоящей PostgreSQL
 * (pglite) под миграциями проекта, хранилище — драйвер `local` во временном
 * каталоге, вход — штатным потоком `/auth/login` → `/auth/callback`. Ни один
 * маршрут здесь не объявлен заново и ни одна функция репозитория не вызывается
 * напрямую: проверяется то, что зарегистрировано в `app.ts`. Иначе повторился бы
 * дефект S3 — модуль написан, тесты зелёные, из приложения он не вызывается.
 *
 * Загрузка идёт ровно так, как её проходит браузер: `init` отдаёт адрес,
 * клиент кладёт байты по этому адресу БЕЗ сессии, `complete` их проверяет.
 * Файлы берутся из синтетических фикстур `tools/fixtures/pdf` (S0), поэтому
 * повороты, повреждённый файл и файл с подписью проверяются всегда, а не при
 * наличии закрытого корпуса.
 *
 * Что проверяется по существу, а не «эндпоинт отвечает 200»:
 *
 * 1. **Проверка идёт по фактическим байтам.** Повреждённый PDF и не-PDF уходят
 *    в карантин с причиной, а не удаляются: подрядчик обязан видеть, что именно
 *    отвергнуто. Содержимое карантинного файла порталом не раздаётся.
 * 2. **Дедупликация по sha256** (§3.3): повторная подача того же файла не
 *    создаёт второй объект ни в `stored_blobs`, ни в хранилище.
 * 3. **Повороты сохраняются**, а размеры хранятся уже в пост-поворотном фрейме.
 * 4. **Порядок задаёт пользователь**, и позиции страниц ревизии пересчитываются
 *    вместе с ним — иначе «страница 5 ревизии» перестанет означать то, что видит
 *    человек.
 * 5. **Presigned GET наружу не отдаётся** (§4.2): содержимое идёт своим
 *    Range-эндпоинтом, а не редиректом в хранилище.
 * 6. **Изоляция подрядчиков** (§1.6, non-degradable): чужая ревизия и чужой файл
 *    не видны ни списком, ни по прямому идентификатору, ни на скачивании.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';
import { uploadKey } from '../../storage/keys.js';
import { S3StorageProvider } from '../../storage/s3.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const FIXTURES_DIR = join(ROOT, 'tools', 'fixtures', 'pdf');

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, `${name}.pdf`));
}

// =====================================================================
// Фикстура
// =====================================================================

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_DEVELOPER = id(1);
const ORG_CONTRACTOR = id(2);
const ORG_OTHER = id(3);
const OBJECT = id(4);

const SUBMISSION = id(10);
const REVISION_DRAFT = id(11);
const SUBMISSION_SUBMITTED = id(12);
const REVISION_SUBMITTED = id(13);
const SUBMISSION_OTHER = id(14);
const REVISION_OTHER = id(15);
const SUBMISSION_ORDER = id(16);
const REVISION_ORDER = id(17);
const SUBMISSION_PIPELINE = id(18);
const REVISION_PIPELINE = id(19);

const USER_CONTRACTOR = id(20);
const USER_OTHER_CONTRACTOR = id(21);
const USER_ENGINEER = id(22);
const USER_ENGINEER_BLANK = id(23);

const KC = {
  contractor: 'kc-files-contractor',
  other: 'kc-files-other',
  engineer: 'kc-files-engineer',
  engineerBlank: 'kc-files-engineer-blank',
} as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_DEVELOPER}', 'ООО «Застройщик»', 'customer')`,
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
     VALUES ('${USER_OTHER_CONTRACTOR}', '${KC.other}', 'Сотрудник подрядчика Б', '${ORG_OTHER}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_BLANK}', '${KC.engineerBlank}', 'Инженер без объектов')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_OTHER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_BLANK}', 'engineer')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_DRAFT}', '${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,

  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_SUBMITTED}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 2', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_SUBMITTED}', '${SUBMISSION_SUBMITTED}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'submitted')`,

  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_OTHER}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_OTHER}', '${OBJECT}', '${ORG_OTHER}', '${ORG_OTHER}', 'roofing', DATE '2026-01-01', 'Поставка чужая', '${USER_OTHER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_OTHER}', '${SUBMISSION_OTHER}', '${OBJECT}', '${ORG_OTHER}', 1, 'draft')`,

  // Отдельная поставка для проверки «порядок меняется до подачи и не меняется
  // после»: она проводится по статусам, поэтому не должна мешать остальным.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_ORDER}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 3', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_ORDER}', '${SUBMISSION_ORDER}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,

  // Поставка для проверки постановки задач конвейера: очередь по ней считается
  // целиком, поэтому чужие загрузки в неё попадать не должны.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_PIPELINE}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 4', '${USER_CONTRACTOR}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_PIPELINE}', '${SUBMISSION_PIPELINE}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-files-tests-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-files-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-files-tests',
  RATE_LIMIT_MAX: '100000',
  MAX_PAGES_PER_FILE: '500',
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

async function sessionFor(kcSub: string): Promise<SignedIn> {
  const cached = signedIn.get(kcSub);
  if (cached !== undefined) return cached;
  const fresh = await signIn(kcSub);
  signedIn.set(kcSub, fresh);
  return fresh;
}

async function as(
  kcSub: string,
  method: Method,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const session = await sessionFor(kcSub);
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken, ...headers },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
}

// =====================================================================
// Три шага приёма одной функцией
// =====================================================================

interface UploadOutcome {
  readonly init: LightMyRequestResponse;
  readonly put: LightMyRequestResponse;
  readonly complete: LightMyRequestResponse;
}

/**
 * Полный путь загрузки, как его проходит браузер.
 *
 * Байты кладутся по адресу, который выдал сервер, и БЕЗ сессии — ровно как в
 * presigned PUT. Если бы маршрут приёма требовал cookie и CSRF-токен, драйвер
 * `local` перестал бы быть моделью боевого хранилища.
 */
async function upload(
  kcSub: string,
  revisionId: string,
  fileName: string,
  content: Buffer,
): Promise<UploadOutcome> {
  const init = await as(kcSub, 'POST', `/api/v1/revisions/${revisionId}/files/upload/init`, {
    fileName,
    sizeBytes: content.byteLength,
  });
  if (init.statusCode !== 201) {
    return { init, put: init, complete: init };
  }

  const ticket = init.json<{ uploadId: string; uploadUrl: string }>();
  const target = new URL(ticket.uploadUrl);
  const put = await app.inject({
    method: 'PUT',
    url: `${target.pathname}${target.search}`,
    headers: { 'content-type': 'application/pdf' },
    payload: content,
  });

  const complete = await as(
    kcSub,
    'POST',
    `/api/v1/revisions/${revisionId}/files/upload/complete`,
    { uploadId: ticket.uploadId },
  );
  return { init, put, complete };
}

interface FileView {
  readonly id: string;
  readonly fileName: string;
  readonly sortOrder: number;
  readonly verifyState: string;
  readonly verifyError: string | null;
  readonly pageCount: number;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly blobSha256: string;
  readonly signatureProbe: { result: string } | null;
}

async function listFiles(kcSub: string, revisionId: string): Promise<readonly FileView[]> {
  const response = await as(kcSub, 'GET', `/api/v1/revisions/${revisionId}/files`);
  expect(response.statusCode).toBe(200);
  return response.json<{ items: FileView[] }>().items;
}

async function countRows(sql: string): Promise<number> {
  const rows = await db.query<{ count: string | number }>(sql);
  return Number(rows[0]?.count ?? 0);
}

// =====================================================================
// Тесты
// =====================================================================

describe('приём файлов', () => {
  it('проходит три шага и разбирает страницы загруженного PDF', async () => {
    const content = fixture('multipage');
    const outcome = await upload(KC.contractor, REVISION_DRAFT, 'АОСР № 01-TEST.pdf', content);

    expect(outcome.init.statusCode).toBe(201);
    expect(outcome.put.statusCode).toBe(200);
    expect(outcome.complete.statusCode).toBe(201);

    const file = outcome.complete.json<FileView>();
    expect(file.verifyState).toBe('ok');
    expect(file.verifyError).toBeNull();
    expect(file.mime).toBe('application/pdf');
    expect(file.pageCount).toBe(4);
    expect(file.sizeBytes).toBe(content.byteLength);
    // Имя пользователя живёт в БД и в ответе, но не в ключе объекта (§13).
    expect(file.fileName).toBe('АОСР № 01-TEST.pdf');

    const pages = await db.query<{ revision_ordinal: number; file_page_index: number }>(
      `SELECT revision_ordinal, file_page_index FROM source_pages
        WHERE source_file_id = '${file.id}' ORDER BY file_page_index`,
    );
    expect(pages.map((p) => Number(p.revision_ordinal))).toEqual([0, 1, 2, 3]);
  });

  it('ключ объекта строится из sha256 и не содержит имени файла', async () => {
    const blobs = await db.query<{ s3_key: string; sha256: string }>(
      `SELECT s3_key, sha256 FROM stored_blobs`,
    );
    expect(blobs.length).toBeGreaterThan(0);
    for (const blob of blobs) {
      expect(blob.s3_key).toBe(
        `blobs/${blob.sha256.slice(0, 2)}/${blob.sha256.slice(2, 4)}/${blob.sha256}`,
      );
      expect(blob.s3_key).not.toContain('АОСР');
      expect(blob.s3_key).not.toContain(OBJECT);
    }
  });

  it('повторная подача того же файла не создаёт второй объект в хранилище', async () => {
    const before = await countRows(`SELECT count(*) AS count FROM stored_blobs`);
    const outcome = await upload(
      KC.contractor,
      REVISION_DRAFT,
      'Тот же файл под другим именем.pdf',
      fixture('multipage'),
    );
    expect(outcome.complete.statusCode).toBe(201);

    const after = await countRows(`SELECT count(*) AS count FROM stored_blobs`);
    expect(after).toBe(before);

    // Две строки файлов на один блоб: дубликат в ревизии не запрещён
    // ограничением, он выявляется правилом (§3.3).
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const sameBlob = files.filter((f) => f.fileName.includes('.pdf'));
    expect(sameBlob.length).toBeGreaterThanOrEqual(2);
    expect(new Set(files.map((f) => f.blobSha256)).size).toBe(1);
  });

  it('сохраняет повороты и хранит размеры в пост-поворотном фрейме', async () => {
    const outcome = await upload(KC.contractor, REVISION_DRAFT, 'Схемы.pdf', fixture('rotated'));
    expect(outcome.complete.statusCode).toBe(201);
    const file = outcome.complete.json<FileView>();

    const pages = await db.query<{ rotation: number; width_px: number; height_px: number }>(
      `SELECT rotation, width_px, height_px FROM source_pages
        WHERE source_file_id = '${file.id}' ORDER BY file_page_index`,
    );

    expect(pages.map((p) => Number(p.rotation))).toEqual([0, 90, 180, 270]);
    // A4 портрет: 595×842. При повороте на четверть стороны меняются местами —
    // именно в этом фрейме заданы coords_norm (§7.1).
    expect(Number(pages[0]?.width_px)).toBe(595);
    expect(Number(pages[0]?.height_px)).toBe(842);
    expect(Number(pages[1]?.width_px)).toBe(842);
    expect(Number(pages[1]?.height_px)).toBe(595);
    // Последняя страница — A3 альбомный, повёрнутый на 270°.
    expect(Number(pages[3]?.width_px)).toBe(842);
    expect(Number(pages[3]?.height_px)).toBe(1191);
  });

  it('находит признаки встроенной подписи и не объявляет её проверенной', async () => {
    const outcome = await upload(
      KC.contractor,
      REVISION_DRAFT,
      'Подписанный.pdf',
      fixture('signed'),
    );
    expect(outcome.complete.statusCode).toBe(201);
    const file = outcome.complete.json<FileView>();
    expect(file.signatureProbe?.result).toBe('detected_unverified');
  });

  it('обычный PDF даёт «подписи не обнаружено», а не «неизвестно»', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const plain = files.find((f) => f.fileName === 'Схемы.pdf');
    expect(plain?.signatureProbe?.result).toBe('none_detected');
  });
});

describe('карантин', () => {
  it('повреждённый PDF сохраняется с причиной, а не удаляется', async () => {
    const outcome = await upload(KC.contractor, REVISION_DRAFT, 'Битый.pdf', fixture('malformed'));
    expect(outcome.complete.statusCode).toBe(201);

    const file = outcome.complete.json<FileView>();
    expect(file.verifyState).toBe('quarantined');
    expect(file.verifyError).toMatch(/повреждён/i);
    expect(file.pageCount).toBe(0);

    // Подрядчик видит отвергнутый файл в списке — иначе «загрузка не удалась»
    // остаётся без объяснения.
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    expect(files.some((f) => f.id === file.id)).toBe(true);
  });

  it('не-PDF отвергается по магическим байтам, а не по имени', async () => {
    const outcome = await upload(
      KC.contractor,
      REVISION_DRAFT,
      'Совсем не pdf.pdf',
      fixture('not-a-pdf'),
    );
    expect(outcome.complete.statusCode).toBe(201);
    const file = outcome.complete.json<FileView>();
    expect(file.verifyState).toBe('quarantined');
    expect(file.verifyError).toMatch(/не является PDF/i);
    // Тип содержимого не берётся из заявления клиента (в PUT был application/pdf).
    expect(file.mime).toBe('application/octet-stream');
  });

  it('зашифрованный PDF уходит в карантин', async () => {
    const source = fixture('multipage').toString('latin1');
    const encrypted = Buffer.from(
      source.replace('/Root 2 0 R', '/Encrypt 1 0 R\n/Root 2 0 R'),
      'latin1',
    );

    const outcome = await upload(KC.contractor, REVISION_DRAFT, 'Под паролем.pdf', encrypted);
    expect(outcome.complete.statusCode).toBe(201);
    const file = outcome.complete.json<FileView>();
    expect(file.verifyState).toBe('quarantined');
    expect(file.verifyError).toMatch(/парол/i);
  });

  it('содержимое карантинного файла не раздаётся', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const quarantined = files.find((f) => f.verifyState === 'quarantined');
    expect(quarantined).toBeDefined();

    const response = await as(KC.contractor, 'GET', `/api/v1/files/${quarantined?.id}/content`);
    expect(response.statusCode).toBe(409);
  });
});

describe('выдача содержимого', () => {
  it('отдаёт байты сама, а не редиректом в хранилище', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const target = files.find((f) => f.verifyState === 'ok');
    expect(target).toBeDefined();

    const response = await as(KC.contractor, 'GET', `/api/v1/files/${target?.id}/content`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['location']).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.rawPayload.byteLength).toBe(target?.sizeBytes);
    expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('человекочитаемое имя подставляется в Content-Disposition', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const target = files.find((f) => f.fileName === 'АОСР № 01-TEST.pdf');
    const response = await as(KC.contractor, 'GET', `/api/v1/files/${target?.id}/content`);

    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent('АОСР № 01-TEST.pdf'));
  });

  it('поддерживает диапазон байтов', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const target = files.find((f) => f.verifyState === 'ok');

    const partial = await as(
      KC.contractor,
      'GET',
      `/api/v1/files/${target?.id}/content`,
      undefined,
      { range: 'bytes=0-9' },
    );
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-9/${target?.sizeBytes}`);
    expect(partial.rawPayload.byteLength).toBe(10);

    // Отдан именно запрошенный участок, а не первые попавшиеся десять байт:
    // pdf.js собирает документ из кусков по смещениям, и сдвиг на один байт
    // даёт не ошибку, а испорченный документ.
    const whole = await as(KC.contractor, 'GET', `/api/v1/files/${target?.id}/content`);
    expect(partial.rawPayload.equals(whole.rawPayload.subarray(0, 10))).toBe(true);

    const middle = await as(
      KC.contractor,
      'GET',
      `/api/v1/files/${target?.id}/content`,
      undefined,
      { range: 'bytes=100-149' },
    );
    expect(middle.statusCode).toBe(206);
    expect(middle.headers['content-range']).toBe(`bytes 100-149/${target?.sizeBytes}`);
    expect(middle.rawPayload.equals(whole.rawPayload.subarray(100, 150))).toBe(true);

    // Суффиксная форма: последние 16 байт — ими pdf.js начинает чтение, ища
    // startxref.
    const suffix = await as(
      KC.contractor,
      'GET',
      `/api/v1/files/${target?.id}/content`,
      undefined,
      { range: 'bytes=-16' },
    );
    expect(suffix.statusCode).toBe(206);
    expect(
      suffix.rawPayload.equals(whole.rawPayload.subarray(whole.rawPayload.byteLength - 16)),
    ).toBe(true);
  });

  it('отвечает 416 на диапазон за пределами файла', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const target = files.find((f) => f.verifyState === 'ok');

    const response = await as(
      KC.contractor,
      'GET',
      `/api/v1/files/${target?.id}/content`,
      undefined,
      { range: 'bytes=999999999-' },
    );
    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe(`bytes */${target?.sizeBytes}`);
  });
});

describe('порядок файлов', () => {
  it('задаётся пользователем и пересчитывает позиции страниц ревизии', async () => {
    const before = await listFiles(KC.contractor, REVISION_DRAFT);
    const reversed = [...before].reverse().map((f) => f.id);

    const response = await as(
      KC.contractor,
      'PUT',
      `/api/v1/revisions/${REVISION_DRAFT}/files/order`,
      { fileIds: reversed },
    );
    expect(response.statusCode).toBe(200);

    const after = response.json<{ items: FileView[] }>().items;
    expect(after.map((f) => f.id)).toEqual(reversed);
    expect(after.map((f) => f.sortOrder)).toEqual(after.map((_f, index) => index));

    // Позиция страницы в ревизии — функция от порядка файлов, иначе «страница 5
    // ревизии» перестала бы означать то, что видит человек.
    const pages = await db.query<{ id: string; revision_ordinal: number; sort_order: number }>(
      `SELECT sp.id, sp.revision_ordinal, sf.sort_order
         FROM source_pages sp JOIN source_files sf ON sf.id = sp.source_file_id
        WHERE sp.revision_id = '${REVISION_DRAFT}'
        ORDER BY sp.revision_ordinal`,
    );
    expect(pages.map((p) => Number(p.revision_ordinal))).toEqual(pages.map((_p, index) => index));
    const orders = pages.map((p) => Number(p.sort_order));
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('отвергает неполный список', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const response = await as(
      KC.contractor,
      'PUT',
      `/api/v1/revisions/${REVISION_DRAFT}/files/order`,
      { fileIds: [files[0]?.id] },
    );
    expect(response.statusCode).toBe(422);
  });

  it('удаление файла уплотняет порядок и позиции страниц', async () => {
    const before = await listFiles(KC.contractor, REVISION_DRAFT);
    const victim = before.find((f) => f.verifyState === 'quarantined');
    expect(victim).toBeDefined();

    const response = await as(
      KC.contractor,
      'DELETE',
      `/api/v1/revisions/${REVISION_DRAFT}/files/${victim?.id}`,
    );
    expect(response.statusCode).toBe(204);

    const after = await listFiles(KC.contractor, REVISION_DRAFT);
    expect(after.length).toBe(before.length - 1);
    expect(after.map((f) => f.sortOrder)).toEqual(after.map((_f, index) => index));

    // Байты остаются: тот же блоб может быть нужен другой ревизии, чистит их
    // сборка мусора (§12), а не удаление строки.
    const blobs = await countRows(`SELECT count(*) AS count FROM stored_blobs`);
    expect(blobs).toBeGreaterThan(0);
  });
});

describe('состав поданной ревизии неизменяем', () => {
  it('загрузка в submitted-ревизию отвергается с объяснением', async () => {
    const response = await as(
      KC.contractor,
      'POST',
      `/api/v1/revisions/${REVISION_SUBMITTED}/files/upload/init`,
      { fileName: 'Догрузка.pdf', sizeBytes: 1024 },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail?: string }>().detail).toMatch(/неизменяем/i);
  });
});

describe('изоляция подрядчиков', () => {
  it('чужая ревизия не видна ни списком, ни на загрузке', async () => {
    const list = await as(KC.other, 'GET', `/api/v1/revisions/${REVISION_DRAFT}/files`);
    expect(list.statusCode).toBe(404);

    const init = await as(
      KC.other,
      'POST',
      `/api/v1/revisions/${REVISION_DRAFT}/files/upload/init`,
      {
        fileName: 'Подсадка.pdf',
        sizeBytes: 1024,
      },
    );
    expect(init.statusCode).toBe(404);
  });

  it('чужой файл не отдаётся по прямому идентификатору', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const target = files.find((f) => f.verifyState === 'ok');

    const response = await as(KC.other, 'GET', `/api/v1/files/${target?.id}/content`);
    expect(response.statusCode).toBe(404);
  });

  /**
   * Отдельно от предыдущего: `Range` — это другой путь внутри обработчика.
   *
   * Порядок проверок здесь не косметика. Если бы диапазон разбирался до
   * проверки принадлежности, чужой файл отдавался бы по частям с кодом 206 —
   * ровно тем способом, которым его читает pdf.js, то есть утечкой всего
   * содержимого, а не одного заголовка.
   */
  it('Range к чужому файлу даёт 404, а не 206', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const target = files.find((f) => f.verifyState === 'ok');
    expect(target).toBeDefined();

    for (const range of ['bytes=0-9', 'bytes=-16', 'bytes=100-']) {
      const response = await as(KC.other, 'GET', `/api/v1/files/${target?.id}/content`, undefined, {
        range,
      });
      expect(response.statusCode, `Range: ${range}`).toBe(404);
      expect(response.headers['content-range'], `Range: ${range}`).toBeUndefined();
      expect(response.rawPayload.subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
    }

    // Тот же диапазон своему владельцу отдаётся: проверка не вырождена в
    // «404 на любой запрос с Range».
    const own = await as(KC.contractor, 'GET', `/api/v1/files/${target?.id}/content`, undefined, {
      range: 'bytes=0-9',
    });
    expect(own.statusCode).toBe(206);
  });

  /**
   * Изоляция проверяется в обе стороны.
   *
   * Односторонняя проверка «Б не видит файлов А» оставляет открытым случай,
   * когда область видимости применена только к части путей: подрядчик, чья
   * поставка создана позже или читается другим запросом, увидел бы чужой файл.
   * Поэтому здесь настоящий файл кладёт подрядчик Б, а забрать его пытается А.
   */
  it('подрядчик А не получает у Б ни файла, ни его метаданных', async () => {
    const uploaded = await upload(KC.other, REVISION_OTHER, 'Чужой скан.pdf', fixture('single-3'));
    expect(uploaded.complete.statusCode).toBe(201);
    const foreign = uploaded.complete.json<FileView>();

    // Список чужой ревизии.
    const list = await as(KC.contractor, 'GET', `/api/v1/revisions/${REVISION_OTHER}/files`);
    expect(list.statusCode).toBe(404);

    // Метаданные и содержимое по прямому идентификатору — включая Range.
    const content = await as(KC.contractor, 'GET', `/api/v1/files/${foreign.id}/content`);
    expect(content.statusCode).toBe(404);
    const ranged = await as(
      KC.contractor,
      'GET',
      `/api/v1/files/${foreign.id}/content`,
      undefined,
      { range: 'bytes=0-9' },
    );
    expect(ranged.statusCode).toBe(404);

    // Тот же блоб лежит и у А (дедупликация по sha256 общая на портал), но
    // строка файла принадлежит Б: общее хранилище не должно делать общим доступ.
    const own = await upload(KC.contractor, REVISION_DRAFT, 'Свой скан.pdf', fixture('single-3'));
    expect(own.complete.statusCode).toBe(201);
    expect(own.complete.json<FileView>().blobSha256).toBe(foreign.blobSha256);
    expect(own.complete.json<FileView>().id).not.toBe(foreign.id);

    // И порядок в чужой ревизии не переставляется.
    const order = await as(
      KC.contractor,
      'PUT',
      `/api/v1/revisions/${REVISION_OTHER}/files/order`,
      {
        fileIds: [foreign.id],
      },
    );
    expect(order.statusCode).toBe(404);
  });

  it('инженер объекта видит файлы, инженер без объектов — нет', async () => {
    const assigned = await as(KC.engineer, 'GET', `/api/v1/revisions/${REVISION_DRAFT}/files`);
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json<{ items: FileView[] }>().items.length).toBeGreaterThan(0);

    const blank = await as(KC.engineerBlank, 'GET', `/api/v1/revisions/${REVISION_DRAFT}/files`);
    expect(blank.statusCode).toBe(404);
  });

  // До S21 инженер получал здесь 403: состав поставки формировал только тот,
  // кто её подаёт. Заказчик посылку снял — исправленную версию вправе загрузить
  // и проверяющий. Рубежом остаётся область видимости, и следующий сценарий
  // проверяет, что она не ослабла.
  it('инженер объекта загружает файлы в ревизию', async () => {
    const response = await as(
      KC.engineer,
      'POST',
      `/api/v1/revisions/${REVISION_DRAFT}/files/upload/init`,
      { fileName: 'Правка инженера.pdf', sizeBytes: 1024 },
    );
    expect(response.statusCode).toBe(201);
  });

  it('инженер без назначенных объектов файлы не загружает', async () => {
    const response = await as(
      KC.engineerBlank,
      'POST',
      `/api/v1/revisions/${REVISION_DRAFT}/files/upload/init`,
      { fileName: 'Чужая правка.pdf', sizeBytes: 1024 },
    );
    // 404, а не 403: ревизии вне области видимости для него не существует.
    expect(response.statusCode).toBe(404);
  });

  it('талон одного пользователя не работает у другого', async () => {
    const init = await as(
      KC.contractor,
      'POST',
      `/api/v1/revisions/${REVISION_DRAFT}/files/upload/init`,
      { fileName: 'Перехваченный.pdf', sizeBytes: 1024 },
    );
    expect(init.statusCode).toBe(201);
    const ticket = init.json<{ uploadId: string }>();

    const stolen = await as(
      KC.other,
      'POST',
      `/api/v1/revisions/${REVISION_DRAFT}/files/upload/complete`,
      { uploadId: ticket.uploadId },
    );
    // Область видимости срабатывает раньше сверки талона: чужая ревизия для
    // подрядчика Б не существует вовсе.
    expect([403, 404]).toContain(stolen.statusCode);
  });
});

describe('приём байтов драйвером local', () => {
  it('подделанный токен не принимается', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/uploads/local?token=eyJrIjoiYmxvYnMvMDAvMDAvZmFrZSJ9.podpis-poddelnaya',
      headers: { 'content-type': 'application/pdf' },
      payload: fixture('single-1'),
    });
    expect(response.statusCode).toBe(403);
  });

  /**
   * Регрессия на браузерное поведение, которого нет у `inject` по умолчанию.
   *
   * Адрес приёма — same-origin, поэтому браузер приложит к PUT cookie сессии
   * САМ, без участия кода загрузки, а заголовка CSRF в «презигнутом» запросе
   * нет и быть не может: клиент считает адрес непрозрачным. Если такой запрос
   * отвергается проверкой CSRF, драйвер `local` перестаёт быть моделью боевого
   * хранилища ровно в том месте, ради которого он существует, и отказ выглядит
   * как «недействительная ссылка».
   */
  it('принимает байты, когда браузер сам приложил cookie сессии', async () => {
    const session = await sessionFor(KC.contractor);
    const init = await as(
      KC.contractor,
      'POST',
      `/api/v1/revisions/${REVISION_DRAFT}/files/upload/init`,
      { fileName: 'с-cookie.pdf', sizeBytes: fixture('single-2').byteLength },
    );
    expect(init.statusCode).toBe(201);

    const target = new URL(init.json<{ uploadUrl: string }>().uploadUrl);
    const put = await app.inject({
      method: 'PUT',
      url: `${target.pathname}${target.search}`,
      headers: { 'content-type': 'application/pdf', cookie: session.cookie },
      payload: fixture('single-2'),
    });
    expect(put.statusCode).toBe(200);
  });

  it('события ревизии пишутся вместе с файлом', async () => {
    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM revision_events WHERE revision_id = '${REVISION_DRAFT}' ORDER BY seq`,
    );
    const types = events.map((e) => e.event_type);
    expect(types).toContain('file.uploaded');
    expect(types).toContain('file.quarantined');
    expect(types).toContain('file.order_changed');
  });

  it('изменения состава оставляют след в журнале аудита', async () => {
    const actions = await db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_log WHERE entity_type IN ('source_file', 'submission_revision')`,
    );
    const names = actions.map((a) => a.action);
    expect(names).toContain('source_file.uploaded');
    expect(names).toContain('source_file.quarantined');
    expect(names).toContain('source_file.deleted');
  });
});

// =====================================================================
// Конвейер запускается приёмом, а не существует рядом с ним
// =====================================================================

/**
 * Регрессия на отказ, найденный прогоном S5.
 *
 * Обработчики задач 1–2 были написаны, зарегистрированы в воркере и покрыты
 * тестами — и ни одна строка боевого кода их не ставила. После успешного
 * `complete` таблица `jobs` оставалась пустой, то есть весь конвейер §12 не
 * запускался никогда, а тесты при этом были зелёными: они проверяли
 * обработчики, а не достижимость.
 *
 * Поэтому проверка идёт по ОЧЕРЕДИ, а не по коду: важно не то, что вызов
 * `enqueueJob` написан, а то, что после загрузки в `jobs` появились строки.
 */
describe('приём ставит задачи конвейера', () => {
  const PIPELINE_REVISION = REVISION_PIPELINE;

  async function jobsOf(revisionId: string): Promise<readonly string[]> {
    const rows = await db.query<{ type: string }>(
      `SELECT type FROM jobs WHERE payload->>'revisionId' = '${revisionId}' ORDER BY type`,
    );
    return rows.map((row) => row.type);
  }

  it('после complete в очереди есть file.verify и file.signature_probe', async () => {
    const before = await jobsOf(PIPELINE_REVISION);
    expect(before).not.toContain('file.verify');

    const outcome = await upload(
      KC.contractor,
      PIPELINE_REVISION,
      'конвейер.pdf',
      fixture('multipage'),
    );
    expect(outcome.complete.statusCode).toBe(201);
    const file = outcome.complete.json<FileView>();

    const after = await jobsOf(PIPELINE_REVISION);
    expect(after).toContain('file.verify');
    expect(after).toContain('file.signature_probe');

    // Задача адресует и ревизию, и файл: без ревизии в payload область
    // видимости задачи не определяется, без файла нечего проверять.
    const payloads = await db.query<{ payload: { revisionId: string; sourceFileId: string } }>(
      `SELECT payload FROM jobs WHERE type = 'file.verify'
        AND payload->>'sourceFileId' = '${file.id}'`,
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.payload.revisionId).toBe(PIPELINE_REVISION);
  });

  it('карантинный файл тоже проверяется задачей: вердикт не «пропустить»', async () => {
    // Карантин ставит синхронный путь, но задача обязана быть поставлена и здесь:
    // она сверяет содержимое ХРАНИЛИЩА, а не поток от клиента, и «отвергнут при
    // загрузке» не означает «в бакете лежит то же самое».
    const outcome = await upload(
      KC.contractor,
      PIPELINE_REVISION,
      'битый.pdf',
      fixture('malformed'),
    );
    expect(outcome.complete.statusCode).toBe(201);
    const file = outcome.complete.json<FileView>();
    expect(file.verifyState).toBe('quarantined');

    const rows = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM jobs
        WHERE type = 'file.verify' AND payload->>'sourceFileId' = '${file.id}'`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('повторная постановка по тому же файлу не плодит вторую задачу', async () => {
    const rows = await db.query<{ dedupe_key: string; count: string | number }>(
      `SELECT dedupe_key, count(*) AS count FROM jobs
        WHERE dedupe_key LIKE 'file.verify:%' GROUP BY dedupe_key HAVING count(*) > 1`,
    );
    expect(rows).toEqual([]);
  });
});

// =====================================================================
// Комплект, заведённый вместе с файлом, размечается сам (S36)
// =====================================================================

/**
 * Автозапуск привязан к ТАЛОНУ, и проверяется именно это.
 *
 * Признак «довести до разметки» едет внутри подписи талона, который выдаёт
 * только `POST /works/with-file`. Привязка к самому факту загрузки была бы
 * дефектом: `startMarkupOnBundle` в мягком режиме сносит распознавание и всё
 * производное ниже разметки, а обычная догрузка идёт и в комплект, который уже
 * разобран. Плюс автосборка после первого файла закрыла бы приём остальных —
 * многофайловый комплект собрать стало бы нечем.
 */
describe('заведение комплекта с файлом доводит его до разметки', () => {
  interface CreatedWork {
    readonly workId: string;
    readonly revisionId: string;
    readonly upload: { readonly uploadId: string; readonly uploadUrl: string };
  }

  /** Полный путь «Нового комплекта»: заведение, байты, `complete`. */
  async function createWorkWithFile(
    title: string,
    content: Buffer,
  ): Promise<{ readonly work: CreatedWork; readonly complete: LightMyRequestResponse }> {
    const created = await as(KC.engineer, 'POST', '/api/v1/works/with-file', {
      objectId: OBJECT,
      sectionCode: 'roofing',
      title,
      // Инженер обязан назвать исполнителя: своей организации у его области
      // видимости нет.
      contractorId: ORG_CONTRACTOR,
      fileName: `${title}.pdf`,
      sizeBytes: content.byteLength,
    });
    expect(created.statusCode).toBe(201);
    const work = created.json<CreatedWork>();

    const target = new URL(work.upload.uploadUrl);
    const put = await app.inject({
      method: 'PUT',
      url: `${target.pathname}${target.search}`,
      headers: { 'content-type': 'application/pdf' },
      payload: content,
    });
    expect(put.statusCode).toBe(200);

    const complete = await as(
      KC.engineer,
      'POST',
      `/api/v1/revisions/${work.revisionId}/files/upload/complete`,
      { uploadId: work.upload.uploadId },
    );
    return { work, complete };
  }

  async function buildJobsOf(revisionId: string): Promise<readonly { startMarkup?: boolean }[]> {
    const rows = await db.query<{ payload: { startMarkup?: boolean } }>(
      `SELECT payload FROM jobs
        WHERE type = 'bundle.build' AND payload->>'revisionId' = '${revisionId}'`,
    );
    return rows.map((row) => row.payload);
  }

  it('после приёма файла в очереди стоит сборка с продолжением разметкой', async () => {
    const { work, complete } = await createWorkWithFile('автостарт', fixture('multipage'));
    expect(complete.statusCode).toBe(201);
    expect(complete.json<FileView>().verifyState).toBe('ok');

    const builds = await buildJobsOf(work.revisionId);
    expect(builds).toHaveLength(1);
    // Признак — единственное, что отличает эту сборку от «Собрать рабочий
    // документ»: по нему обработчик поставит `layout.start`, и разметка пойдёт
    // без единого нажатия.
    expect(builds[0]?.startMarkup).toBe(true);
  });

  it('файл в карантине разметку не запускает', async () => {
    const { work, complete } = await createWorkWithFile('карантин', fixture('malformed'));
    expect(complete.statusCode).toBe(201);
    expect(complete.json<FileView>().verifyState).toBe('quarantined');

    expect(await buildJobsOf(work.revisionId)).toEqual([]);
  });

  it('обычная догрузка файла разметку не запускает', async () => {
    // Талон `upload/init` признака не несёт, и это не забывчивость: комплект из
    // нескольких файлов человек дособерёт, а собранный рабочий документ закрыл
    // бы приём остальных.
    const outcome = await upload(
      KC.contractor,
      REVISION_DRAFT,
      'догрузка.pdf',
      fixture('multipage'),
    );
    expect(outcome.complete.statusCode).toBe(201);

    expect(await buildJobsOf(REVISION_DRAFT)).toEqual([]);
  });
});

// =====================================================================
// Presigned URL наружу не выходит
// =====================================================================

/**
 * Признаки presigned-адреса S3 в произвольном тексте.
 *
 * Проверка идёт по строке ответа целиком, а не по известным полям: утечка
 * опасна именно тем, что появляется в поле, которого сегодня нет, — «ссылка на
 * скачивание», «адрес превью», вложенный объект в списке. Presigned GET утекает
 * в историю браузера и в Referer и действует мимо RBAC до конца TTL (§4.2), и
 * стандарт относит его к секретам (§11).
 */
const PRESIGNED_MARKERS: readonly RegExp[] = [
  /X-Amz-Signature/i,
  /X-Amz-Credential/i,
  /X-Amz-Algorithm/i,
  /X-Amz-Expires/i,
  /X-Amz-SignedHeaders/i,
  /[?&]Signature=/i,
];

function presignedMarkersIn(text: string): readonly string[] {
  return PRESIGNED_MARKERS.filter((marker) => marker.test(text)).map((marker) => marker.source);
}

/** Имена полей, под которыми presigned GET обычно и просачивается в ответ. */
const FORBIDDEN_URL_FIELDS = [
  'downloadUrl',
  'download_url',
  'previewUrl',
  'preview_url',
  'contentUrl',
  'content_url',
  'signedUrl',
  'signed_url',
  'presignedUrl',
  'presigned_url',
  'objectUrl',
  's3Url',
  's3Key',
  'storageKey',
];

describe('presigned URL не появляется в ответах API', () => {
  /**
   * Контроль на невырожденность: детектор обязан ловить настоящий адрес.
   *
   * Без него набор ниже был бы зелёным и при сломанном детекторе — то есть
   * проверял бы ровно ничего.
   */
  it('детектор находит признаки в настоящем presigned PUT S3', async () => {
    const s3 = new S3StorageProvider({
      endpoint: 'https://storage.yandexcloud.net',
      bucket: 'id-portal',
      accessKey: 'unit-test-access-key',
      secretKey: 'unit-test-secret-key',
      region: 'ru-central1',
      fetchImpl: () => Promise.reject(new Error('сеть в тестах недоступна')),
    });

    const presigned = await s3.presignPut({
      key: uploadKey('00000000-0000-4000-8000-000000009999'),
      expiresInSeconds: 60,
      maxBytes: 1024,
    });

    expect(presignedMarkersIn(presigned.url)).toContain('X-Amz-Signature');
  });

  it('ни один ответ приёма и выдачи файлов не несёт подписанного адреса', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    const target = files.find((f) => f.verifyState === 'ok');
    expect(target).toBeDefined();

    const fresh = await upload(
      KC.contractor,
      REVISION_DRAFT,
      'Ещё один скан.pdf',
      fixture('single-3'),
    );

    const responses: readonly (readonly [string, LightMyRequestResponse])[] = [
      ['init', fresh.init],
      ['complete', fresh.complete],
      [
        'список файлов',
        await as(KC.contractor, 'GET', `/api/v1/revisions/${REVISION_DRAFT}/files`),
      ],
      [
        'список файлов инженера',
        await as(KC.engineer, 'GET', `/api/v1/revisions/${REVISION_DRAFT}/files`),
      ],
      ['содержимое', await as(KC.contractor, 'GET', `/api/v1/files/${target?.id}/content`)],
      [
        'содержимое диапазоном',
        await as(KC.contractor, 'GET', `/api/v1/files/${target?.id}/content`, undefined, {
          range: 'bytes=0-99',
        }),
      ],
      [
        'сводка обработки',
        await as(KC.contractor, 'GET', `/api/v1/revisions/${REVISION_DRAFT}/processing-status`),
      ],
    ];

    for (const [name, response] of responses) {
      const body = response.rawPayload.toString('latin1');
      expect(presignedMarkersIn(body), `подписанный адрес в ответе «${name}»`).toEqual([]);
      // Заголовки — второй канал: редирект в хранилище отдаёт адрес в Location.
      expect(presignedMarkersIn(JSON.stringify(response.headers)), `заголовки «${name}»`).toEqual(
        [],
      );
      expect(response.statusCode, `редирект в хранилище в ответе «${name}»`).toBeLessThan(300);
    }

    // Ни ключа объекта, ни поля-адреса в описании файла: имя поля, которого нет,
    // не может однажды начать возвращать presigned GET.
    const listing = JSON.stringify(files);
    for (const field of FORBIDDEN_URL_FIELDS) {
      expect(listing, `поле ${field} в описании файла`).not.toContain(`"${field}"`);
    }
  });

  /**
   * Presigned PUT — это по §4.2 штатный путь приёма, и он остаётся.
   *
   * Проверяется другое: наружу выдаётся адрес ЗАПИСИ одного ключа, а не адрес
   * чтения. У интерфейса хранилища метода `presignGet` нет вовсе — это и есть
   * гарантия, потому что выдать то, чего нельзя построить, невозможно.
   */
  it('наружу выдаётся только адрес записи, а метода чтения нет вовсе', async () => {
    const init = await as(
      KC.contractor,
      'POST',
      `/api/v1/revisions/${REVISION_DRAFT}/files/upload/init`,
      { fileName: 'Проверка адреса.pdf', sizeBytes: 1024 },
    );
    expect(init.statusCode).toBe(201);

    const ticket = init.json<{ uploadUrl: string; method: string }>();
    expect(ticket.method).toBe('PUT');
    // Драйвер `local` моделирует presigned PUT собственным маршрутом портала;
    // на S3 здесь был бы подписанный адрес бакета, и он тоже относится к записи.
    expect(new URL(ticket.uploadUrl).pathname).toBe('/api/v1/uploads/local');

    expect('presignGet' in app.storage).toBe(false);
    expect((app.storage as unknown as Record<string, unknown>)['presignGet']).toBeUndefined();
  });
});

// =====================================================================
// Порядок файлов запирается подачей
// =====================================================================

describe('порядок файлов до и после подачи', () => {
  it('меняется в черновике и не меняется после submit', async () => {
    await upload(KC.contractor, REVISION_ORDER, 'Первый.pdf', fixture('single-1'));
    await upload(KC.contractor, REVISION_ORDER, 'Второй.pdf', fixture('single-2'));

    const draft = await listFiles(KC.contractor, REVISION_ORDER);
    expect(draft.map((f) => f.fileName)).toEqual(['Первый.pdf', 'Второй.pdf']);
    const reversed = [...draft].reverse().map((f) => f.id);

    const beforeSubmit = await as(
      KC.contractor,
      'PUT',
      `/api/v1/revisions/${REVISION_ORDER}/files/order`,
      { fileIds: reversed },
    );
    expect(beforeSubmit.statusCode).toBe(200);
    expect(beforeSubmit.json<{ items: FileView[] }>().items.map((f) => f.fileName)).toEqual([
      'Второй.pdf',
      'Первый.pdf',
    ]);

    // Подача: собственного маршрута у неё пока нет (S5 — приём файлов), а
    // проверяется здесь именно запрет после подачи, поэтому статус ставится
    // напрямую.
    await db.query(
      `UPDATE submission_revisions SET status = 'submitted' WHERE id = '${REVISION_ORDER}'`,
    );

    const afterSubmit = await as(
      KC.contractor,
      'PUT',
      `/api/v1/revisions/${REVISION_ORDER}/files/order`,
      { fileIds: [...reversed].reverse() },
    );
    expect(afterSubmit.statusCode).toBe(409);
    expect(afterSubmit.json<{ detail?: string }>().detail).toMatch(/неизменяем/i);

    // Запрет держит БД, а не только проверка в репозитории: прямой UPDATE в
    // обход приложения тоже отвергается. Порядок файлов входит в
    // `aggregate_manifest_hash`, поэтому его правка после подачи означала бы
    // манифест, не описывающий состав.
    await expect(
      db.query(
        `UPDATE source_files SET sort_order = sort_order + 10 WHERE revision_id = '${REVISION_ORDER}'`,
      ),
    ).rejects.toThrow(/ревизия поставки в статусе/i);

    const after = await listFiles(KC.contractor, REVISION_ORDER);
    expect(after.map((f) => f.fileName)).toEqual(['Второй.pdf', 'Первый.pdf']);
    expect(after.map((f) => f.sortOrder)).toEqual([0, 1]);
  });
});

describe('состав черновика фиксируется собранным рабочим документом', () => {
  /**
   * Регрессия дефекта, найденного на S10.
   *
   * `RevisionForFiles.hasBundle` вычислялся коррелирующим подзапросом, в котором
   * ссылка на внешнюю таблицу шла через `${submissionRevisions.id}`. В запросе
   * БЕЗ джойнов Drizzle рендерит колонку без имени таблицы, поэтому условие
   * превращалось в `pb.revision_id = "id"` и связывалось с `pb.id` — то есть
   * было ложным ВСЕГДА. Следствие: запрет «состав и порядок зафиксированы
   * разметкой» (§3.3) не срабатывал ни разу, и подрядчик мог переставить файлы
   * уже после того, как рабочий документ уехал в RD WEB, — при неизменном
   * `aggregate_manifest_hash` рабочего документа.
   */
  it('после сборки рабочего документа порядок файлов не переставляется', async () => {
    const files = await listFiles(KC.contractor, REVISION_DRAFT);
    expect(files.length).toBeGreaterThan(1);

    const blobs = await db.query<{ sha256: string }>(`SELECT sha256 FROM stored_blobs LIMIT 1`);
    const blobSha = blobs[0]?.sha256;
    expect(blobSha).toBeDefined();
    await db.query(
      `INSERT INTO processing_bundles (revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
         VALUES ('${REVISION_DRAFT}', '${'f'.repeat(64)}', '${blobSha}', 'bundle/1+pdf-lib')`,
    );

    const response = await as(
      KC.contractor,
      'PUT',
      `/api/v1/revisions/${REVISION_DRAFT}/files/order`,
      { fileIds: [...files].reverse().map((file) => file.id) },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail?: string }>().detail).toMatch(/рабочий документ/i);

    // Порядок не изменился: отказ обязан быть настоящим, а не косметическим.
    const after = await listFiles(KC.contractor, REVISION_DRAFT);
    expect(after.map((file) => file.id)).toEqual(files.map((file) => file.id));
  });
});

// =====================================================================
// Удаление файла из черновика со сборкой (S24)
// =====================================================================

/**
 * Регрессия дефекта, на который указал заказчик.
 *
 * `DELETE /revisions/{id}/files/{fileId}` отвечал 409 в ЧЕРНОВИКЕ — потому что у
 * ревизии уже был собран рабочий документ. Формулировка отказа («состав и
 * порядок файлов зафиксированы разметкой») звучала как неизменяемость §3.9 и
 * отправляла искать причину не туда: ревизия была черновиком, а мешала сборка.
 *
 * Настоящая причина запрета техническая — на страницах файла висит разметка, а
 * `processing_bundle_pages.source_page_id` ссылается на `source_pages` внешним
 * ключом без каскада. Теперь производное сносится явно, и удаление проходит.
 *
 * Перестановка файлов после сборки при этом ОСТАЁТСЯ запрещённой (набор выше):
 * порядок задаёт `aggregate_manifest_hash` уже уехавшего в работу документа, а
 * удаление честно обесценивает и его.
 */
describe('удаление файла из черновика с собранным рабочим документом', () => {
  it('проходит и уносит с собой рабочий документ вместе с разметкой', async () => {
    const before = await listFiles(KC.contractor, REVISION_DRAFT);
    expect(before.length).toBeGreaterThan(1);
    const victim = before[0];
    expect(victim).toBeDefined();

    // Рабочий документ мог остаться от соседнего набора: он и есть условие,
    // которое раньше делало удаление невозможным.
    const existing = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM processing_bundles WHERE revision_id = '${REVISION_DRAFT}'`,
    );
    if ((existing[0]?.n ?? 0) === 0) {
      const blobs = await db.query<{ sha256: string }>(`SELECT sha256 FROM stored_blobs LIMIT 1`);
      await db.query(
        `INSERT INTO processing_bundles (revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
           VALUES ('${REVISION_DRAFT}', '${'e'.repeat(64)}', '${blobs[0]?.sha256 ?? ''}', 'bundle/1+pdf-lib')`,
      );
    }

    const response = await as(
      KC.contractor,
      'DELETE',
      `/api/v1/revisions/${REVISION_DRAFT}/files/${victim?.id ?? ''}`,
    );
    expect(response.statusCode).toBe(204);

    // Файла нет, а рабочий документ обесценен целиком: оставить его значило бы
    // хранить карту страниц, половина которой указывает в никуда.
    const after = await listFiles(KC.contractor, REVISION_DRAFT);
    expect(after.map((file) => file.id)).not.toContain(victim?.id);

    const bundles = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM processing_bundles WHERE revision_id = '${REVISION_DRAFT}'`,
    );
    expect(bundles[0]?.n).toBe(0);

    // Порядок оставшихся файлов плотный: дыра в нумерации сделала бы «файл № 3»
    // и третью строку таблицы разными вещами.
    expect(after.map((file) => file.sortOrder)).toEqual(after.map((_file, index) => index));
  });
});
