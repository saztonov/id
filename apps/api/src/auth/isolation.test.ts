/**
 * Изоляция доступа на уровне HTTP. Non-degradable гейт §1.6.
 *
 * Приложение поднимается целиком — `buildApp()` с `AUTH_MODE=dev-stub` и
 * настоящей PostgreSQL (pglite) под миграциями проекта. Вход выполняется
 * штатным потоком `/auth/login` → `/auth/callback`, то есть сессия, CSRF-токен
 * и область видимости получаются тем же кодом, что в продакшне: сессия,
 * собранная в тесте руками, проверяла бы фикстуру, а не портал.
 *
 * Проверяются ЧЕТЫРЕ пути, по которым чужие данные утекают мимо фильтра в SQL:
 * список, прямой доступ по идентификатору, поток событий и выдача файла со
 * ссылкой. Первые два закрываются `withScope()`, вторые два — `allowsRow()`,
 * потому что там строка уже прочитана, и добавить условие в запрос нечем.
 *
 * Почему маршруты объявлены здесь, а не взяты из `routes/`. Прикладных
 * маршрутов ИД на этом этапе нет, а гейт проверяет не URL, а то, что изоляция
 * держится, когда маршрут собран из положенных деталей: `requirePermission` →
 * `withScope`/`allowsRow` → problem+json. Каждый маршрут ниже — минимальная
 * копия того, что обязан делать боевой обработчик; ни одна проверка доступа в
 * них не написана заново.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asc, eq } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { revisionEvents, sourceFiles, storedBlobs, submissionRevisions, submissions } from '@id/db';

import { buildApp, type AppInstance } from '../app.js';
import { loadEnv } from '../config/env.js';
import { withScope, type ScopeTarget } from '../db/scoped.js';
import { notFound } from '../lib/problem.js';
import { currentAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import { allowsRow } from './scope.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from './session.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
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

const CONTRACTOR_A = id(1);
const CONTRACTOR_B = id(2);
const OBJECT_A = id(3);
const OBJECT_B = id(4);
const SECTION_A = id(5);
const SECTION_B = id(6);
const VOLUME_A = id(7);
const VOLUME_B = id(8);

const SUBMISSION_A = id(10);
const SUBMISSION_B = id(11);
const REVISION_A = id(12);
const REVISION_B = id(13);
const FILE_A = id(14);
const FILE_B = id(15);

const USER_CONTRACTOR_A = id(20);
const USER_CONTRACTOR_B = id(21);
const USER_ENGINEER_A = id(22);
const USER_ENGINEER_WITHOUT_OBJECTS = id(23);
const USER_ADMIN = id(24);
/** Заведён в портале, но без единой строки в `user_roles`. */
const USER_TOKEN_ADMIN = id(25);
/** Роль `contractor` есть, привязки к организации нет. */
const USER_WITHOUT_ORGANIZATION = id(26);
/** Отдельный пользователь для тестов срока жизни сессии. */
const USER_SESSION_PROBE = id(27);

/** `kc_sub` = то, что заглушка подставляет в `sub` токена. */
const KC = {
  contractorA: 'kc-contractor-a',
  contractorB: 'kc-contractor-b',
  engineerA: 'kc-engineer-a',
  engineerWithoutObjects: 'kc-engineer-none',
  admin: 'kc-admin',
  tokenAdmin: 'kc-token-admin',
  withoutOrganization: 'kc-contractor-orphan',
  sessionProbe: 'kc-session-probe',
} as const;

const TITLE_A = 'Комплект подрядчика А';
const TITLE_B = 'Комплект подрядчика Б';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const S3_KEY_A = `blobs/${SHA_A}`;
const S3_KEY_B = `blobs/${SHA_B}`;

/** Метки в полезной нагрузке событий: по ним видно утечку в теле ответа. */
const EVENT_MARKER_A = 'marker-event-of-contractor-a';
const EVENT_MARKER_B = 'marker-event-of-contractor-b';

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, inn, kpp, ogrn, kind)
     VALUES ('${CONTRACTOR_A}', 'ООО «Подрядчик А»', '7700123459', '770901001',
             '1027700123450', 'contractor')`,
  `INSERT INTO counterparties (id, name, inn, kpp, ogrn, kind)
     VALUES ('${CONTRACTOR_B}', 'ООО «Подрядчик Б»', '7700123460', '770901002',
             '1027700123451', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'OBJ0A', 'Объект А', 'ЖК «Тест», корпус А')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_B}', 'OBJ0B', 'Объект Б', 'ЖК «Тест», корпус Б')`,
  `INSERT INTO section_kinds (code, name) VALUES ('roofing', 'Кровля')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_A}', '${OBJECT_A}', '2.5.1', 'Кровля автостоянки', 'roofing')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_B}', '${OBJECT_B}', '2.5.1', 'Кровля автостоянки', 'roofing')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME_A}', '${OBJECT_A}', '${SECTION_A}', 'V1', 'Том 1')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME_B}', '${OBJECT_B}', '${SECTION_B}', 'V1', 'Том 1')`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR_A}', '${KC.contractorA}', 'Подрядчик А', '${CONTRACTOR_A}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR_B}', '${KC.contractorB}', 'Подрядчик Б', '${CONTRACTOR_B}')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_A}', '${KC.engineerA}', 'Инженер объекта А')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_WITHOUT_OBJECTS}', '${KC.engineerWithoutObjects}',
             'Инженер без объектов')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор портала')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_TOKEN_ADMIN}', '${KC.tokenAdmin}', 'Носитель роли из токена')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_WITHOUT_ORGANIZATION}', '${KC.withoutOrganization}',
             'Подрядчик без организации')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_SESSION_PROBE}', '${KC.sessionProbe}', 'Проба сессии', '${CONTRACTOR_A}')`,

  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR_A}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR_B}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_A}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role)
     VALUES ('${USER_ENGINEER_WITHOUT_OBJECTS}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_WITHOUT_ORGANIZATION}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_SESSION_PROBE}', 'contractor')`,
  `INSERT INTO user_object_scopes (user_id, object_id)
     VALUES ('${USER_ENGINEER_A}', '${OBJECT_A}')`,

  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION_A}', '${VOLUME_A}', '${OBJECT_A}', '${CONTRACTOR_A}',
             '${TITLE_A}', '${USER_CONTRACTOR_A}')`,
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUBMISSION_B}', '${VOLUME_B}', '${OBJECT_B}', '${CONTRACTOR_B}',
             '${TITLE_B}', '${USER_CONTRACTOR_B}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_A}', '${SUBMISSION_A}', '${OBJECT_A}', '${CONTRACTOR_A}', 1)`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_B}', '${SUBMISSION_B}', '${OBJECT_B}', '${CONTRACTOR_B}', 1)`,

  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_A}', '${S3_KEY_A}', 1024, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_B}', '${S3_KEY_B}', 2048, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
     VALUES ('${FILE_A}', '${REVISION_A}', '${SHA_A}', 'komplekt-a.pdf', 0)`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
     VALUES ('${FILE_B}', '${REVISION_B}', '${SHA_B}', 'komplekt-b.pdf', 0)`,

  `INSERT INTO revision_events (revision_id, seq, event_type, payload)
     VALUES ('${REVISION_A}', 1, 'revision.created',
             '{"marker": "${EVENT_MARKER_A}"}'::jsonb)`,
  `INSERT INTO revision_events (revision_id, seq, event_type, payload)
     VALUES ('${REVISION_B}', 1, 'revision.created',
             '{"marker": "${EVENT_MARKER_B}"}'::jsonb)`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-isolation-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/isolation-tests',
  // Тесты бьют десятками запросов с одного адреса: боевой предел превратил бы
  // проверку изоляции в проверку rate-limit.
  RATE_LIMIT_MAX: '100000',
});

const SUBMISSION_SCOPE: ScopeTarget = {
  objectId: submissions.objectId,
  contractorId: submissions.contractorId,
};

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

const idParams = z.object({ id: z.uuid() });

/** Маршрут-проба уровня permission. */
const ADMIN_PROBE_ROUTE = '/api/v1/isolation-probe/admin';

/**
 * Строки приходят с именами колонок БД: без join'а drizzle не переименовывает
 * их, поэтому ключи здесь в snake_case. Типы — псевдонимы, а не интерфейсы:
 * `pg` требует от параметра типа неявный индексный сигнатурный тип.
 */
type SubmissionListRow = { id: string; title: string };
type SubmissionRow = { id: string; title: string; object_id: string; contractor_id: string };
type EventRow = { seq: number | string; event_type: string; payload: unknown };
type FileRow = { id: string; s3_key: string; object_id: string; contractor_id: string };

/**
 * Ссылка на файл в хранилище.
 *
 * Форма подписи неважна — важно, кому ссылка достаётся: presigned URL действует
 * помимо RBAC весь свой TTL и относится к секретам, подлежащим redaction (§11).
 */
function presignedUrlFor(s3Key: string): string {
  return `https://s3.example.invalid/${s3Key}?X-Amz-Signature=${'0'.repeat(32)}`;
}

function registerIsolationRoutes(app: AppInstance): void {
  const pool = app.pool;

  // Путь 1: список.
  app.get(
    '/api/v1/submissions',
    { preHandler: requirePermission('submission.read') },
    async (request) => {
      const { scope } = currentAuth(request);
      const query = new QueryBuilder()
        .select({ id: submissions.id, title: submissions.title })
        .from(submissions)
        .where(withScope(scope, SUBMISSION_SCOPE))
        .orderBy(asc(submissions.title))
        .toSQL();

      const result = await pool.query<SubmissionListRow>(query.sql, [...query.params]);
      return { items: result.rows };
    },
  );

  // Путь 2: прямой доступ по идентификатору.
  app.get(
    '/api/v1/submissions/:id',
    { schema: { params: idParams }, preHandler: requirePermission('submission.read') },
    async (request) => {
      const { scope } = currentAuth(request);
      const query = new QueryBuilder()
        .select({
          id: submissions.id,
          title: submissions.title,
          objectId: submissions.objectId,
          contractorId: submissions.contractorId,
        })
        .from(submissions)
        .where(withScope(scope, SUBMISSION_SCOPE, eq(submissions.id, request.params.id)))
        .toSQL();

      const result = await pool.query<SubmissionRow>(query.sql, [...query.params]);
      const row = result.rows[0];
      // 404, а не 403: сам факт существования чужой поставки — тоже сведения о
      // чужой поставке.
      if (row === undefined) throw notFound('Поставка не найдена.');
      return row;
    },
  );

  /**
   * Путь 3: поток событий ревизии.
   *
   * Путь маршрута — тестовый (`_isolation`), а не боевой: настоящий SSE
   * появился на S5 (`modules/events/sse.ts`) и зарегистрирован в `app.ts`,
   * поэтому одинаковая форма пути дала бы отказ Fastify «route already
   * declared». Подменять им боевой поток нельзя по другой причине:
   * настоящий SSE не закрывается сам, и `inject()` ждал бы его до
   * таймаута. Здесь проверяется превращение области видимости в SQL на
   * четвёртом пути доступа; изоляция самого боевого маршрута проверена в
   * `jobs/engine.test.ts` на поднятом сокете.
   */
  app.get(
    '/api/v1/_isolation/revisions/:id/events',
    { schema: { params: idParams }, preHandler: requirePermission('submission.read') },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const visible = new QueryBuilder()
        .select({ id: submissionRevisions.id })
        .from(submissionRevisions)
        .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.id, request.params.id)))
        .toSQL();

      const allowed = await pool.query<{ id: string }>(visible.sql, [...visible.params]);
      // Проверка ДО открытия потока: подписка, открытая раньше проверки, успеет
      // отдать первое событие чужой ревизии, и отменить это уже нечем.
      if (allowed.rows[0] === undefined) throw notFound('Ревизия не найдена.');

      const events = new QueryBuilder()
        .select({
          seq: revisionEvents.seq,
          eventType: revisionEvents.eventType,
          payload: revisionEvents.payload,
        })
        .from(revisionEvents)
        .where(eq(revisionEvents.revisionId, request.params.id))
        .orderBy(asc(revisionEvents.seq))
        .toSQL();

      const stream = await pool.query<EventRow>(events.sql, [...events.params]);
      const body = stream.rows
        .map(
          (row) =>
            `id: ${String(row.seq)}\nevent: ${row.event_type}\ndata: ${JSON.stringify(row.payload)}\n\n`,
        )
        .join('');

      return reply.type('text/event-stream').send(body);
    },
  );

  // Путь 4: выдача файла и ссылки на него.
  app.get(
    '/api/v1/files/:id/download',
    { schema: { params: idParams }, preHandler: requirePermission('archive.download') },
    async (request) => {
      const { scope } = currentAuth(request);
      // Строка читается БЕЗ области видимости намеренно: так выглядит этот путь
      // в жизни — файл найден по своему идентификатору, и добавить область в
      // запрос забывают именно здесь. Единственная защита — allowsRow().
      const query = new QueryBuilder()
        .select({
          id: sourceFiles.id,
          s3Key: storedBlobs.s3Key,
          objectId: submissionRevisions.objectId,
          contractorId: submissionRevisions.contractorId,
        })
        .from(sourceFiles)
        .innerJoin(submissionRevisions, eq(submissionRevisions.id, sourceFiles.revisionId))
        .innerJoin(storedBlobs, eq(storedBlobs.sha256, sourceFiles.blobSha256))
        .where(eq(sourceFiles.id, request.params.id))
        .toSQL();

      const result = await pool.query<FileRow>(query.sql, [...query.params]);
      const row = result.rows[0];
      if (
        row === undefined ||
        !allowsRow(scope, { objectId: row.object_id, contractorId: row.contractor_id })
      ) {
        throw notFound('Файл не найден.');
      }

      return { fileId: row.id, presignedUrl: presignedUrlFor(row.s3_key) };
    },
  );

  // Небезопасный метод: нужен для проверки CSRF и того, что запись подчиняется
  // той же области видимости, что и чтение.
  app.post(
    '/api/v1/submissions/:id/submit',
    { schema: { params: idParams }, preHandler: requirePermission('submission.submit') },
    async (request) => {
      const { scope } = currentAuth(request);
      const query = new QueryBuilder()
        .select({ id: submissions.id })
        .from(submissions)
        .where(withScope(scope, SUBMISSION_SCOPE, eq(submissions.id, request.params.id)))
        .toSQL();

      const result = await pool.query<{ id: string }>(query.sql, [...query.params]);
      const row = result.rows[0];
      if (row === undefined) throw notFound('Поставка не найдена.');
      return { submitted: row.id };
    },
  );

  // Административный маршрут: право есть только у роли `admin` из user_roles.
  // Путь намеренно не совпадает с боевым путём администрирования: тот теперь
  // зарегистрирован самим приложением, и второе объявление того же метода
  // Fastify отвергает. Гейт проверяет не URL, а то, что permission на маршруте
  // работает (см. пояснение в начале файла).
  app.get(ADMIN_PROBE_ROUTE, { preHandler: requirePermission('users.manage') }, () =>
    Promise.resolve({ ok: true }),
  );
}

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
  registerIsolationRoutes(app);
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

// =====================================================================
// Вход и запросы
// =====================================================================

interface SignedIn {
  /** Готовый заголовок `cookie` с подписанным идентификатором сессии. */
  readonly cookie: string;
  readonly csrfToken: string;
}

function cookieOf(response: LightMyRequestResponse, name: string): string {
  // Берётся последнее значение: в одном ответе cookie бывает сначала очищена,
  // а затем выставлена заново.
  const found = response.cookies.filter((cookie) => cookie.name === name).at(-1);
  if (found === undefined || found.value === '') {
    throw new Error(`В ответе нет cookie ${name}`);
  }
  return found.value;
}

/**
 * Заголовок `cookie` из полученного значения.
 *
 * Значение кодируется обратно: сервер разбирает cookie через
 * `decodeURIComponent`, а подпись cookie — base64, в котором встречаются
 * `+`, `/` и `=`.
 */
function cookieHeader(response: LightMyRequestResponse, name: string): string {
  return `${name}=${encodeURIComponent(cookieOf(response, name))}`;
}

function locationOf(response: LightMyRequestResponse): string {
  const value = response.headers['location'];
  if (typeof value !== 'string') throw new Error('В ответе нет заголовка location');
  return value;
}

/**
 * Штатный вход заглушкой: `/auth/login` → редирект → `/auth/callback`.
 *
 * `tokenRoles` уезжают в `realm_access.roles` id_token'а. Это и есть проверка
 * требования §4.1: заявленная в токене бизнес-роль не должна давать прав.
 */
async function signIn(kcSub: string, tokenRoles: readonly string[] = []): Promise<SignedIn> {
  const roles =
    tokenRoles.length > 0 ? `&devRoles=${encodeURIComponent(tokenRoles.join(','))}` : '';
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${encodeURIComponent(kcSub)}${roles}`,
  });
  expect(started.statusCode).toBe(302);

  const authorizationUrl = new URL(locationOf(started));
  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
  });
  // Успешный вход — редирект. Иной статус означал бы, что заглушка не прошла
  // проверку state, PKCE или nonce, и тогда все проверки ниже бессмысленны.
  expect(completed.statusCode).toBe(302);

  return {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
}

/** Вход выполняется один раз на пользователя: каждый создаёт строку сессии. */
const signedIn = new Map<string, SignedIn>();

async function sessionFor(kcSub: string): Promise<SignedIn> {
  const cached = signedIn.get(kcSub);
  if (cached !== undefined) return cached;
  const fresh = await signIn(kcSub);
  signedIn.set(kcSub, fresh);
  return fresh;
}

function get(url: string, session: SignedIn | null): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url,
    ...(session === null ? {} : { headers: { cookie: session.cookie } }),
  });
}

function submissionIds(response: LightMyRequestResponse): string[] {
  return response.json<{ items: SubmissionListRow[] }>().items.map((item) => item.id);
}

/**
 * Чего в ответе быть не должно.
 *
 * Идентификатор запрошенной строки в список не входит: его клиент прислал сам,
 * и он возвращается в `instance` конверта problem+json. Утечкой является всё
 * остальное — заголовок чужой поставки, её объект, организация, ключ в
 * хранилище, полезная нагрузка события.
 */
function expectNoLeak(response: LightMyRequestResponse, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(response.body).not.toContain(secret);
  }
}

const SECRETS_OF_B = [TITLE_B, OBJECT_B, CONTRACTOR_B, S3_KEY_B, EVENT_MARKER_B];

// =====================================================================
// Путь 1: списочный эндпоинт
// =====================================================================

describe('путь 1: список', () => {
  it('подрядчик А не видит поставку подрядчика Б', async () => {
    const response = await get('/api/v1/submissions', await sessionFor(KC.contractorA));
    expect(response.statusCode).toBe(200);
    expect(submissionIds(response)).toEqual([SUBMISSION_A]);
    expectNoLeak(response, SECRETS_OF_B);
  });

  it('подрядчик Б не видит поставку подрядчика А', async () => {
    const response = await get('/api/v1/submissions', await sessionFor(KC.contractorB));
    expect(response.statusCode).toBe(200);
    expect(submissionIds(response)).toEqual([SUBMISSION_B]);
    expectNoLeak(response, [TITLE_A, OBJECT_A, CONTRACTOR_A]);
  });

  it('администратор видит обе поставки: список не пуст сам по себе', async () => {
    const response = await get('/api/v1/submissions', await sessionFor(KC.admin));
    expect(response.statusCode).toBe(200);
    expect(submissionIds(response)).toEqual([SUBMISSION_A, SUBMISSION_B]);
  });
});

// =====================================================================
// Путь 2: прямой доступ по идентификатору
// =====================================================================

describe('путь 2: прямой доступ по id', () => {
  it('подрядчик А не получает поставку Б и не узнаёт о ней из ошибки', async () => {
    const response = await get(
      `/api/v1/submissions/${SUBMISSION_B}`,
      await sessionFor(KC.contractorA),
    );
    expect(response.statusCode).not.toBe(200);
    expect([403, 404]).toContain(response.statusCode);
    expectNoLeak(response, SECRETS_OF_B);
  });

  it('свою поставку по тому же маршруту получает: отказ выше не про маршрут', async () => {
    const response = await get(
      `/api/v1/submissions/${SUBMISSION_A}`,
      await sessionFor(KC.contractorA),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<SubmissionRow>().title).toBe(TITLE_A);
  });
});

// =====================================================================
// Путь 3: поток событий ревизии
// =====================================================================

describe('путь 3: поток событий', () => {
  it('подрядчик А не получает поток ревизии подрядчика Б', async () => {
    const response = await get(
      `/api/v1/_isolation/revisions/${REVISION_B}/events`,
      await sessionFor(KC.contractorA),
    );
    expect([403, 404]).toContain(response.statusCode);
    // Поток не должен даже начаться: заголовок event-stream означает, что
    // проверка выполнена после открытия подписки.
    expect(String(response.headers['content-type'])).not.toContain('text/event-stream');
    expectNoLeak(response, SECRETS_OF_B);
  });

  it('свой поток открывается и содержит события: отказ выше не про пустую таблицу', async () => {
    const response = await get(
      `/api/v1/_isolation/revisions/${REVISION_A}/events`,
      await sessionFor(KC.contractorA),
    );
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/event-stream');
    expect(response.body).toContain(EVENT_MARKER_A);
  });

  it('инженер объекта А не получает поток ревизии объекта Б', async () => {
    const response = await get(
      `/api/v1/_isolation/revisions/${REVISION_B}/events`,
      await sessionFor(KC.engineerA),
    );
    expect([403, 404]).toContain(response.statusCode);
    expectNoLeak(response, SECRETS_OF_B);
  });
});

// =====================================================================
// Путь 4: скачивание файла и presigned URL
// =====================================================================

describe('путь 4: файл и presigned URL', () => {
  it('подрядчик А не получает ссылку на файл подрядчика Б', async () => {
    const response = await get(
      `/api/v1/files/${FILE_B}/download`,
      await sessionFor(KC.contractorA),
    );
    expect([403, 404]).toContain(response.statusCode);
    expectNoLeak(response, SECRETS_OF_B);
    // Ссылки не должно быть в ответе ни в каком виде, включая «безобидную»
    // подсказку с ключом объекта в хранилище.
    expectNoLeak(response, ['presignedUrl', 'X-Amz', 'https://', SHA_B]);
  });

  it('ссылку на свой файл получает: отказ выше не про сломанный маршрут', async () => {
    const response = await get(
      `/api/v1/files/${FILE_A}/download`,
      await sessionFor(KC.contractorA),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ presignedUrl: string }>().presignedUrl).toContain(S3_KEY_A);
  });

  it('инженер объекта А не получает ссылку на файл объекта Б', async () => {
    const response = await get(`/api/v1/files/${FILE_B}/download`, await sessionFor(KC.engineerA));
    expect([403, 404]).toContain(response.statusCode);
    expectNoLeak(response, ['presignedUrl', S3_KEY_B, SHA_B]);
  });
});

// =====================================================================
// Область видимости инженера
// =====================================================================

describe('инженер и область объектов', () => {
  it('видит поставку своего объекта и не видит поставку чужого', async () => {
    const response = await get('/api/v1/submissions', await sessionFor(KC.engineerA));
    expect(response.statusCode).toBe(200);
    // Инженер видит всех подрядчиков, но только на назначенных объектах (§4.1).
    expect(submissionIds(response)).toEqual([SUBMISSION_A]);
    expectNoLeak(response, SECRETS_OF_B);
  });

  it('не получает поставку чужого объекта по прямому id', async () => {
    const response = await get(
      `/api/v1/submissions/${SUBMISSION_B}`,
      await sessionFor(KC.engineerA),
    );
    expect([403, 404]).toContain(response.statusCode);
    expectNoLeak(response, SECRETS_OF_B);
  });

  it('инженер без назначенных объектов не видит ни одной поставки', async () => {
    const session = await sessionFor(KC.engineerWithoutObjects);

    const list = await get('/api/v1/submissions', session);
    expect(list.statusCode).toBe(200);
    // Пустая область — это ноль строк, а не отсутствие ограничения.
    expect(submissionIds(list)).toEqual([]);
    expectNoLeak(list, [TITLE_A, TITLE_B]);

    const direct = await get(`/api/v1/submissions/${SUBMISSION_A}`, session);
    expect([403, 404]).toContain(direct.statusCode);
    expectNoLeak(direct, [TITLE_A]);
  });
});

// =====================================================================
// Источник бизнес-ролей — портал, а не токен
// =====================================================================

describe('роль из токена', () => {
  it('роль admin в токене без записи в user_roles не даёт админского доступа', async () => {
    const session = await signIn(KC.tokenAdmin, ['admin', 'manager']);

    const me = await get('/me', session);
    expect(me.statusCode).toBe(200);
    const body = me.json<{ roles: string[]; denial: string | null; scope: unknown }>();
    // Роль не «недостаточна», её вообще нет: токен в источник прав не входит.
    expect(body.roles).toEqual([]);
    expect(body.denial).toBe('no-business-role');
    expect(body.scope).toBeNull();

    expect((await get(ADMIN_PROBE_ROUTE, session)).statusCode).toBe(403);

    const list = await get('/api/v1/submissions', session);
    expect(list.statusCode).toBe(403);
    expectNoLeak(list, [TITLE_A, TITLE_B]);
  });

  it('та же роль, выданная в портале, доступ даёт: 403 выше не про маршрут', async () => {
    const response = await get(ADMIN_PROBE_ROUTE, await sessionFor(KC.admin));
    expect(response.statusCode).toBe(200);
  });

  it('подрядчик не получает административного доступа', async () => {
    const response = await get(ADMIN_PROBE_ROUTE, await sessionFor(KC.contractorA));
    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Подрядчик без организации
// =====================================================================

describe('подрядчик без users.contractor_id', () => {
  it('не видит ничего, а не всё', async () => {
    const session = await signIn(KC.withoutOrganization);

    const list = await get('/api/v1/submissions', session);
    // Область видимости за него не придумывается: без организации у роли
    // `contractor` её нет, и запрос отклоняется целиком.
    expect(list.statusCode).toBe(403);
    expectNoLeak(list, [TITLE_A, TITLE_B, S3_KEY_A, S3_KEY_B]);

    const direct = await get(`/api/v1/submissions/${SUBMISSION_A}`, session);
    expect(direct.statusCode).toBe(403);
    expectNoLeak(direct, [TITLE_A]);
  });

  it('видит причину отказа в /me', async () => {
    const session = await signIn(KC.withoutOrganization);
    const me = await get('/me', session);
    expect(me.statusCode).toBe(200);
    expect(me.json<{ denial: string | null }>().denial).toBe('contractor-without-organization');
  });
});

// =====================================================================
// CSRF
// =====================================================================

describe('CSRF', () => {
  it('POST без заголовка токена отвергается', async () => {
    const session = await sessionFor(KC.contractorA);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${SUBMISSION_A}/submit`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ type: string }>().type).toContain('csrf');
  });

  it('POST с посторонним значением токена отвергается', async () => {
    const session = await sessionFor(KC.contractorA);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${SUBMISSION_A}/submit`,
      headers: { cookie: session.cookie, [CSRF_HEADER]: 'postoronnij-token' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ type: string }>().type).toContain('csrf');
  });

  it('POST с верным токеном проходит', async () => {
    const session = await sessionFor(KC.contractorA);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${SUBMISSION_A}/submit`,
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ submitted: string }>().submitted).toBe(SUBMISSION_A);
  });

  it('верный CSRF-токен не открывает чужую поставку', async () => {
    const session = await sessionFor(KC.contractorA);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${SUBMISSION_B}/submit`,
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    });
    expect([403, 404]).toContain(response.statusCode);
    expectNoLeak(response, SECRETS_OF_B);
  });
});

// =====================================================================
// Сессия
// =====================================================================

describe('сессия', () => {
  it('без cookie сессии — 401', async () => {
    const response = await get('/api/v1/submissions', null);
    expect(response.statusCode).toBe(401);
    // Без WWW-Authenticate клиент не отличает «войди» от «этот маршрут открыт».
    expect(response.headers['www-authenticate']).toBeDefined();
    expectNoLeak(response, [TITLE_A, TITLE_B]);
  });

  it('неподписанное значение в cookie сессии — 401, а не 500', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/submissions',
      headers: { cookie: `${SESSION_COOKIE}=00000000-0000-4000-8000-000000000099` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('истёкшая сессия — 401', async () => {
    const session = await signIn(KC.sessionProbe);
    expect((await get('/api/v1/submissions', session)).statusCode).toBe(200);

    // Истекает только эта сессия: у остальных пользователей свои строки.
    await db.query(
      `update auth_sessions
          set idle_expires_at = now() - interval '1 minute',
              absolute_expires_at = now() - interval '30 seconds'
        where user_id = $1`,
      [USER_SESSION_PROBE],
    );

    const response = await get('/api/v1/submissions', session);
    expect(response.statusCode).toBe(401);
    expectNoLeak(response, [TITLE_A]);
  });
});
