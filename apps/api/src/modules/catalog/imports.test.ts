/**
 * Массовый ввод справочников через HTTP на собранном приложении.
 *
 * Приложение поднимается штатным `buildApp()` поверх настоящей PostgreSQL
 * (pglite) с файловым хранилищем, а вход идёт штатным потоком `/auth/login`.
 * Ни один маршрут здесь не объявлен заново: проверяется то, что зарегистрировано
 * в `app.ts`.
 *
 * ## Разбор выполняется теми же функциями, что и в воркере
 *
 * Задачу `catalog.import.parse` выполняет воркер, которого в этом процессе нет.
 * Вместо мока здесь вызываются РОВНО те функции, из которых состоит обработчик
 * (`loadCatalogSnapshot` → `parseCatalogImport` → `saveCatalogImportRows`), —
 * то есть проверяется настоящая цепочка, а не её изображение. Сам обработчик со
 * своим чтением из хранилища и переводом импорта в `failed` проверяется
 * интеграционным тестом воркера.
 *
 * ## Что здесь проверяется по существу
 *
 * 1. **Приём решает по БАЙТАМ, а не по словам клиента**: `.xlsx` в имени файла
 *    и правдоподобный `sizeBytes` не спасают не-книгу.
 * 2. **Повтор перехода — 409, а не второй комплект карточек.** Это главное:
 *    между предпросмотром и применением проходят минуты, за которые человек
 *    успевает нажать дважды.
 * 3. **Дубликат, возникший МЕЖДУ разбором и применением**, пропускается со
 *    своей причиной, а не роняет пакет и не заводит вторую карточку.
 * 4. **Файл после применения удаляется из хранилища**, а строки предпросмотра
 *    остаются: история ввода переживает разовый ввод.
 */
import { mkdtempSync, rmSync } from 'node:fs';
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
import { buildXlsx } from '../../lib/xlsx.js';
import { readXlsxSheet } from '../../lib/xlsx-read.js';
import { parseCatalogImport } from '../../catalog-import/parse.js';
import {
  loadCatalogSnapshot,
  saveCatalogImportRows,
} from '../../db/repositories/catalog-imports.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

// =====================================================================
// Фикстура
// =====================================================================

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const USER_ADMIN = id(1);
const USER_ENGINEER = id(2);

const KC = { admin: 'kc-import-admin', engineer: 'kc-import-engineer' } as const;

/** Синтетические реквизиты с посчитанными контрольными суммами. */
const INN_A = '7700123459';
const INN_B = '7743013901';
const INN_BROKEN = '7700123458';

const FIXTURE: readonly string[] = [
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-import-tests-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-import-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-import-tests',
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

const signedIn = new Map<string, SignedIn>();

async function sessionFor(kcSub: string): Promise<SignedIn> {
  const cached = signedIn.get(kcSub);
  if (cached !== undefined) return cached;

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

  const fresh = {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
  signedIn.set(kcSub, fresh);
  return fresh;
}

async function as(
  kcSub: string,
  method: Method,
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const session = await sessionFor(kcSub);
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
}

function asAdmin(method: Method, url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return as(KC.admin, method, url, body);
}

function detailOf(response: LightMyRequestResponse): string {
  return response.json<{ detail?: string }>().detail ?? '';
}

const P = '/api/v1/catalog';

// =====================================================================
// Ход импорта
// =====================================================================

interface ImportView {
  readonly id: string;
  readonly status: string;
  readonly rowCount: number;
  readonly errorCount: number;
  readonly duplicateCount: number;
  readonly createdCount: number;
  readonly failureReason: string | null;
}

interface Uploaded {
  readonly importId: string;
  readonly complete: LightMyRequestResponse;
}

/** Три шага приёма: `init`, PUT мимо портала, `complete`. */
async function upload(
  target: 'counterparties' | 'construction_objects',
  bytes: Buffer,
  fileName = 'catalog.xlsx',
): Promise<Uploaded> {
  const init = await asAdmin('POST', `${P}/imports/init`, {
    target,
    fileName,
    sizeBytes: bytes.byteLength,
  });
  expect(init.statusCode).toBe(201);

  const ticket = init.json<{ importId: string; uploadId: string; uploadUrl: string }>();
  const url = new URL(ticket.uploadUrl);
  const put = await app.inject({
    method: 'PUT',
    url: `${url.pathname}${url.search}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(put.statusCode).toBeLessThan(300);

  const complete = await asAdmin('POST', `${P}/imports/${ticket.importId}/complete`, {
    uploadId: ticket.uploadId,
  });
  return { importId: ticket.importId, complete };
}

/**
 * Разбор ровно теми функциями, из которых состоит обработчик воркера.
 *
 * Файл при этом читается из ТОГО ЖЕ хранилища, куда его положил приём: иначе
 * проверялся бы разбор придуманных байт, а не принятых.
 */
async function runParseJob(importId: string): Promise<void> {
  const record = await db.query<{ target: string; s3_key: string }>(
    `SELECT target, s3_key FROM catalog_imports WHERE id = '${importId}'`,
  );
  const row = record[0];
  if (row === undefined) throw new Error('импорт не найден');

  const object = await app.storage.getObjectStream(row.s3_key);
  const chunks: Buffer[] = [];
  for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));

  const sheet = readXlsxSheet(Buffer.concat(chunks));
  const snapshot = await loadCatalogSnapshot(app.db);
  const parsed = parseCatalogImport(
    row.target as 'counterparties' | 'construction_objects',
    sheet,
    snapshot,
  );
  if (!parsed.ok) throw new Error(`разбор отвергнут: ${parsed.reason}`);
  await saveCatalogImportRows(app.db, importId, parsed.rows);
}

async function importView(importId: string): Promise<ImportView> {
  const response = await asAdmin('GET', `${P}/imports/${importId}`);
  expect(response.statusCode).toBe(200);
  return response.json<ImportView>();
}

const COUNTERPARTY_HEADER = ['Наименование', 'Вид', 'ИНН'];

// =====================================================================
// Тесты
// =====================================================================

describe('маршруты импорта зарегистрированы', () => {
  const EXPECTED: readonly (readonly [Method, string])[] = [
    ['GET', `${P}/imports/template`],
    ['POST', `${P}/imports/init`],
    ['POST', `${P}/imports/:importId/complete`],
    ['GET', `${P}/imports`],
    ['GET', `${P}/imports/:importId`],
    ['GET', `${P}/imports/:importId/rows`],
    ['POST', `${P}/imports/:importId/apply`],
  ];

  it('все маршруты на месте', () => {
    for (const [method, url] of EXPECTED) {
      expect({ url, registered: app.hasRoute({ method, url }) }).toEqual({ url, registered: true });
    }
  });
});

describe('шаблон', () => {
  it('отдаётся вложением и читается нашим же читателем', async () => {
    const response = await as(KC.engineer, 'GET', `${P}/imports/template?target=counterparties`);
    expect(response.statusCode).toBe(200);
    // Чужой файл портал не отдаёт inline; свой шаблон — тоже вложением, чтобы
    // не заводить второе правило для одного заголовка.
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    const sheet = readXlsxSheet(response.rawPayload);
    const header = [...(sheet.rows[0]?.cells.values() ?? [])].map((cell) => cell.text);
    expect(header).toContain('Наименование');
    expect(header).toContain('ИНН');
  });
});

describe('приём файла', () => {
  it('не-книга отвергается по байтам, а не по имени', async () => {
    const { complete, importId } = await upload(
      'counterparties',
      Buffer.from('это точно не книга Excel'),
      'contractors.xlsx',
    );
    expect(complete.statusCode).toBe(400);
    expect(detailOf(complete)).toContain('сигнатурой архива');

    // Импорт остаётся в `uploading`: отказ приёма — не отказ разбора.
    expect((await importView(importId)).status).toBe('uploading');
  });

  it('архив без книги отвергается', async () => {
    // Первые байты те же, что у .xlsx, — а внутри ничего от Excel нет.
    const notABook = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x20)]);
    const { complete } = await upload('counterparties', notABook);
    expect(complete.statusCode).toBe(400);
    expect(detailOf(complete)).toContain('xl/workbook.xml');
  });

  it('заводит импорт только администратор', async () => {
    const response = await as(KC.engineer, 'POST', `${P}/imports/init`, {
      target: 'counterparties',
      fileName: 'x.xlsx',
      sizeBytes: 10,
    });
    expect(response.statusCode).toBe(403);
  });

  it('повторный complete того же импорта — 409 с текущим состоянием', async () => {
    const book = await buildXlsx('Контрагенты', [
      COUNTERPARTY_HEADER,
      ['ООО «Повтор»', 'contractor', INN_A],
    ]);
    const init = await asAdmin('POST', `${P}/imports/init`, {
      target: 'counterparties',
      fileName: 'repeat.xlsx',
      sizeBytes: book.byteLength,
    });
    const ticket = init.json<{ importId: string; uploadId: string; uploadUrl: string }>();
    const url = new URL(ticket.uploadUrl);
    await app.inject({ method: 'PUT', url: `${url.pathname}${url.search}`, payload: book });

    const first = await asAdmin('POST', `${P}/imports/${ticket.importId}/complete`, {
      uploadId: ticket.uploadId,
    });
    expect(first.statusCode).toBe(200);

    const second = await asAdmin('POST', `${P}/imports/${ticket.importId}/complete`, {
      uploadId: ticket.uploadId,
    });
    expect(second.statusCode).toBe(409);
    expect(detailOf(second)).toContain('разбирается');
  });
});

describe('предпросмотр и применение', () => {
  it('годные строки заводятся, кривые остаются в предпросмотре', async () => {
    const book = await buildXlsx('Контрагенты', [
      COUNTERPARTY_HEADER,
      ['ООО «Лаборатория»', 'laboratory', INN_A],
      ['ООО «Кривой ИНН»', 'contractor', INN_BROKEN],
      ['ООО «Без ИНН»', 'supplier', ''],
    ]);
    const { importId, complete } = await upload('counterparties', book);
    expect(complete.statusCode).toBe(200);

    await runParseJob(importId);
    const ready = await importView(importId);
    expect(ready).toMatchObject({ status: 'ready', rowCount: 3, errorCount: 1 });

    const errors = await asAdmin('GET', `${P}/imports/${importId}/rows?verdict=error`);
    expect(errors.json<{ items: { rowNo: number }[] }>().items.map((r) => r.rowNo)).toEqual([3]);

    const applied = await asAdmin('POST', `${P}/imports/${importId}/apply`);
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ created: number; skipped: number }>()).toEqual({
      created: 2,
      skipped: 0,
    });

    // Карточки действительно заведены и видны обычным маршрутом справочника.
    const list = await asAdmin('GET', `${P}/counterparties?search=Лаборатория`);
    expect(list.json<{ items: { name: string; kind: string }[] }>().items).toEqual([
      expect.objectContaining({ name: 'ООО «Лаборатория»', kind: 'laboratory' }),
    ]);

    // Повторное применение не заводит второй комплект.
    const again = await asAdmin('POST', `${P}/imports/${importId}/apply`);
    expect(again.statusCode).toBe(409);
    expect(detailOf(again)).toContain('уже применён');
  });

  it('дубликат, возникший между разбором и применением, пропускается со своей причиной', async () => {
    const book = await buildXlsx('Контрагенты', [
      COUNTERPARTY_HEADER,
      ['ООО «Гонка»', 'contractor', INN_B],
    ]);
    const { importId } = await upload('counterparties', book);
    await runParseJob(importId);
    expect((await importView(importId)).errorCount).toBe(0);

    // Ровно та же организация заводится формой, пока человек смотрит
    // предпросмотр. `counterparties.inn` уникальным ключом не закрыт, и без
    // перепроверки на применении появилась бы вторая карточка.
    const rival = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Гонка» (форма)',
      kind: 'contractor',
      inn: INN_B,
    });
    expect(rival.statusCode).toBe(201);

    const applied = await asAdmin('POST', `${P}/imports/${importId}/apply`);
    expect(applied.json<{ created: number; skipped: number }>()).toEqual({
      created: 0,
      skipped: 1,
    });

    const rows = await asAdmin('GET', `${P}/imports/${importId}/rows`);
    expect(
      rows.json<{ items: { verdict: string; problems: { code: string }[] }[] }>().items,
    ).toEqual([
      expect.objectContaining({
        verdict: 'duplicate',
        problems: [expect.objectContaining({ code: 'created_meanwhile' })],
      }),
    ]);
  });

  it('после применения файл из хранилища удалён, а строки остались', async () => {
    const book = await buildXlsx('Контрагенты', [
      COUNTERPARTY_HEADER,
      ['ООО «Уборка»', 'contractor', ''],
    ]);
    const { importId } = await upload('counterparties', book);
    await runParseJob(importId);

    const key = (
      await db.query<{ s3_key: string }>(
        `SELECT s3_key FROM catalog_imports WHERE id = '${importId}'`,
      )
    )[0]?.s3_key;
    expect(key).toBeDefined();
    expect(await app.storage.headObject(key ?? '')).not.toBeNull();

    expect((await asAdmin('POST', `${P}/imports/${importId}/apply`)).statusCode).toBe(200);

    // Книга — разовый ввод и после применения не нужна; история ввода — нужна.
    expect(await app.storage.headObject(key ?? '')).toBeNull();
    expect(
      (await asAdmin('GET', `${P}/imports/${importId}/rows`)).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
  });

  it('применение до готовности предпросмотра — 409', async () => {
    const book = await buildXlsx('Контрагенты', [
      COUNTERPARTY_HEADER,
      ['ООО «Рано»', 'contractor', ''],
    ]);
    const { importId } = await upload('counterparties', book);
    const early = await asAdmin('POST', `${P}/imports/${importId}/apply`);
    expect(early.statusCode).toBe(409);
    expect(detailOf(early)).toContain('разбирается');
  });

  it('читает и применяет только администратор', async () => {
    expect((await as(KC.engineer, 'GET', `${P}/imports`)).statusCode).toBe(403);
    expect((await as(KC.engineer, 'POST', `${P}/imports/${id(999)}/apply`)).statusCode).toBe(403);
  });

  it('неизвестный импорт — 404', async () => {
    expect((await asAdmin('GET', `${P}/imports/${id(999)}`)).statusCode).toBe(404);
  });
});

describe('импорт объектов', () => {
  it('ссылка на контрагента по ИНН превращается в идентификатор', async () => {
    const developer = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Застройщик импорта»',
      kind: 'customer',
      inn: '5024002119',
    });
    expect(developer.statusCode).toBe(201);
    const developerId = developer.json<{ id: string }>().id;

    const book = await buildXlsx('Объекты', [
      ['Код', 'Наименование', 'Полное наименование', 'Идентификатор', 'Застройщик'],
      ['IMP01', 'Объект импорта', 'ЖК «Импорт», корпус 1', '90-128/КЛ-23', '5024002119'],
    ]);
    const { importId } = await upload('construction_objects', book, 'objects.xlsx');
    await runParseJob(importId);
    expect((await asAdmin('POST', `${P}/imports/${importId}/apply`)).statusCode).toBe(200);

    const list = await asAdmin('GET', `${P}/objects?search=IMP01`);
    expect(list.json<{ items: Record<string, unknown>[] }>().items).toEqual([
      expect.objectContaining({
        code: 'IMP01',
        permitIdentifier: '90-128/КЛ-23',
        developerId,
      }),
    ]);
  });
});
