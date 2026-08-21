/**
 * Журнал ошибок через HTTP на собранном приложении (§11, §14).
 *
 * Проверяется то, что нельзя проверить вызовом репозитория:
 *
 * 1. **Права.** Чтение закрыто `diagnostics.read`, изменение — `settings.manage`.
 *    Инженер и подрядчик не видят журнал вовсе: у проблемы нет ни объекта, ни
 *    организации, поэтому «показать своё» здесь не существует, и единственная
 *    альтернатива закрытому доступу — показать всё.
 * 2. **Три числа не подменяют друг друга.** `summary` считает события по
 *    почасовым бакетам, а не по примерам. Проверка идёт на данных, где эти
 *    величины СПЕЦИАЛЬНО расходятся: сто событий и один пример. Если однажды
 *    кто-то посчитает события по `error_samples`, тест назовёт разницу.
 * 3. **Сортировка по частоте не обещает курсора**, которого у неё быть не может.
 * 4. **Действие и след аудита — один факт.** Закрытие проблемы обязано оставить
 *    и запись в истории, и строку в `audit_log`.
 * 5. **Разбор при закрытии обязателен схемой**: «убрали с экрана» и «починили»
 *    должны различаться в БД, а не в намерениях того, кто нажал кнопку.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const USER_ADMIN = id(301);
const USER_ENGINEER = id(302);
const USER_MANAGER = id(303);
const OBJECT_A = id(310);

const ISSUE_NOISY = id(401);
const ISSUE_RARE = id(402);
const ISSUE_RESOLVED = id(403);

const KC = {
  admin: 'kc-journal-admin',
  engineer: 'kc-journal-engineer',
  manager: 'kc-journal-manager',
} as const;

const ADMIN_EMAIL = 'journal-admin@example.test';

const FIXTURE: readonly string[] = [
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'JRN01', 'Объект журнала', 'ЖК «Журнал», корпус 1')`,
  `INSERT INTO users (id, kc_sub, full_name, email)
     VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор', '${ADMIN_EMAIL}')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT_A}')`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-journal-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/journal-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-journal-tests',
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
});

/**
 * Данные журнала расставляются прямым SQL, а не через писателя.
 *
 * Писатель проверен своим тестом; здесь нужна ЗАДАННАЯ форма данных — в
 * частности, расхождение между числом событий и числом примеров, которое живой
 * писатель создаёт только под нагрузкой.
 */
beforeEach(async () => {
  await db.query(`delete from error_issues where is_synthetic = false`);
  await db.query('delete from error_stats_hourly');
  await db.query('delete from error_samples');
  await db.query('delete from error_issue_actions');
  await db.query(`delete from audit_log`);

  const seed: readonly string[] = [
    `INSERT INTO error_issues (id, title, status, source, execution, domain, severity,
                               first_seen_at, last_seen_at, last_release)
       VALUES ('${ISSUE_NOISY}', 'Error: пул соединений исчерпан', 'new', 'api', 'http', 'db',
               'error', now() - interval '3 hours', now() - interval '1 minute', '2026.08.1')`,
    `INSERT INTO error_issues (id, title, status, source, execution, domain, severity,
                               first_seen_at, last_seen_at)
       VALUES ('${ISSUE_RARE}', 'LlmTimeoutError: модель не ответила', 'ack', 'worker', 'job',
               'llm', 'error', now() - interval '2 hours', now() - interval '30 minutes')`,
    `INSERT INTO error_issues (id, title, status, source, execution, domain, severity,
                               first_seen_at, last_seen_at, resolved_at, resolved_by,
                               root_cause, resolution, resolution_type)
       VALUES ('${ISSUE_RESOLVED}', 'Error: экспорт падал на пустом реестре', 'resolved', 'api',
               'job', 'application', 'error', now() - interval '5 days',
               now() - interval '4 days', now() - interval '3 days', '${USER_ADMIN}',
               'экспорт не проверял размер выборки', 'добавлена проверка', 'fixed')`,

    // Сто событий шумной проблемы и одно — редкой. Примеров при этом по одному
    // на каждую: расхождение специально, см. заголовок.
    `INSERT INTO error_stats_hourly (issue_id, bucket_at, release, source, execution, domain,
                                     pipeline_stage, severity, count)
       VALUES ('${ISSUE_NOISY}', date_trunc('hour', now()), '2026.08.1', 'api', 'http', 'db',
               'none', 'error', 100)`,
    `INSERT INTO error_stats_hourly (issue_id, bucket_at, release, source, execution, domain,
                                     pipeline_stage, severity, count)
       VALUES ('${ISSUE_RARE}', date_trunc('hour', now()), 'unknown', 'worker', 'job', 'llm',
               'recognition', 'error', 1)`,
    // Тот же отпечаток в предыдущем релизе: по нему проверяется ряд.
    `INSERT INTO error_stats_hourly (issue_id, bucket_at, release, source, execution, domain,
                                     pipeline_stage, severity, count)
       VALUES ('${ISSUE_NOISY}', date_trunc('hour', now() - interval '2 hours'), '2026.07.9',
               'api', 'http', 'db', 'none', 'error', 5)`,

    `INSERT INTO error_signatures (fingerprint, algo_version, issue_id, error_class,
                                   message_template, top_frame, source)
       VALUES ('aaaa1111', 1, '${ISSUE_NOISY}', 'Error', 'пул соединений исчерпан',
               'claimJobs (apps/api/src/db/repositories/jobs.ts)', 'api')`,
    `INSERT INTO error_signatures (fingerprint, algo_version, issue_id, error_class,
                                   message_template, top_frame, source)
       VALUES ('bbbb2222', 1, '${ISSUE_RARE}', 'LlmTimeoutError', 'модель не ответила',
               'recognizeBlock (apps/api/src/recognition/vlm/recognize-block.ts)', 'worker')`,

    `INSERT INTO error_samples (issue_id, fingerprint, at, source, execution, domain, severity,
                                release, request_id, route, status_code, error_code)
       VALUES ('${ISSUE_NOISY}', 'aaaa1111', now() - interval '1 minute', 'api', 'http', 'db',
               'error', '2026.08.1', 'req-0000000000000001', '/api/v1/submissions', 500, '53300')`,
    `INSERT INTO error_samples (issue_id, fingerprint, at, source, execution, domain, severity,
                                release, request_id, route)
       VALUES ('${ISSUE_RARE}', 'bbbb2222', now() - interval '30 minutes', 'worker', 'job', 'llm',
               'error', 'unknown', 'req-0000000000000002', null)`,
  ];
  for (const statement of seed) await db.query(statement);
});

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

async function signIn(kcSub: string, email?: string): Promise<SignedIn> {
  const query = new URLSearchParams({ devSub: kcSub });
  if (email !== undefined) query.set('devEmail', email);

  const started = await app.inject({ method: 'GET', url: `/auth/login?${query.toString()}` });
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

async function sessionFor(kcSub: string): Promise<SignedIn> {
  const cached = signedIn.get(kcSub);
  if (cached !== undefined) return cached;
  const fresh = await signIn(kcSub, kcSub === KC.admin ? ADMIN_EMAIL : undefined);
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

const asAdmin = (method: Method, url: string, body?: unknown) => as(KC.admin, method, url, body);

describe('доступ к журналу', () => {
  it('администратор читает список проблем', async () => {
    const response = await asAdmin('GET', '/api/v1/admin/errors');

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: { id: string; events: number }[] }>();
    expect(body.items.map((item) => item.id)).toContain(ISSUE_NOISY);
  });

  it('инженеру журнал закрыт правом, а не пустым списком', async () => {
    const response = await as(KC.engineer, 'GET', '/api/v1/admin/errors');

    expect(
      response.statusCode,
      'инженер получил ответ вместо отказа: право diagnostics.read выдано только ' +
        'администратору, и подменять отказ пустым списком нельзя — пустой список ' +
        'читается как «ошибок нет»',
    ).toBe(403);
  });

  it('руководителю журнал закрыт: diagnostics.read у него нет', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/admin/errors');
    expect(response.statusCode).toBe(403);
  });

  it('без сессии — 401, а не 403', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/errors' });
    expect(response.statusCode).toBe(401);
  });
});

describe('сводка различает проблемы, события и примеры', () => {
  it('считает события по бакетам, а не по примерам', async () => {
    const response = await asAdmin('GET', '/api/v1/admin/errors/summary');

    expect(response.statusCode).toBe(200);
    const body = response.json<{ issues: number; events: number; samples: number }>();

    expect(
      body.events,
      'события посчитаны не по error_stats_hourly: в фикстуре 106 событий (100 + 1 + 5) ' +
        'и 2 примера, и всякое другое число означает, что одна величина подменена другой',
    ).toBe(106);
    expect(body.samples).toBe(2);
    // Три проблемы заведены, но закрытая последний раз наблюдалась четыре дня
    // назад и в сутки не попадает.
    expect(body.issues).toBe(2);
  });

  it('период сужает и события, и число проблем', async () => {
    const from = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    const to = new Date().toISOString();
    const response = await asAdmin(
      'GET',
      `/api/v1/admin/errors/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );

    expect(response.json<{ issues: number }>().issues).toBe(3);
  });

  it('служебная проблема переполнения не показывается, пока переполнения не было', async () => {
    const list = await asAdmin('GET', '/api/v1/admin/errors');
    const titles = list.json<{ items: { title: string }[] }>().items.map((i) => i.title);

    expect(
      titles.some((title) => title.includes('Переполнение')),
      'служебный накопитель висит в списке с нулём событий: «переполнения не было» ' +
        'выражается отсутствием строки, а не строкой с нулём',
    ).toBe(false);
  });
});

describe('список проблем', () => {
  it('фильтрует по домену и источнику', async () => {
    const byDomain = await asAdmin('GET', '/api/v1/admin/errors?domain=llm');
    expect(byDomain.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toStrictEqual([
      ISSUE_RARE,
    ]);

    const bySource = await asAdmin('GET', '/api/v1/admin/errors?source=worker');
    expect(bySource.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toStrictEqual([
      ISSUE_RARE,
    ]);
  });

  it('ищет по шаблону сообщения сигнатуры, а не только по заголовку', async () => {
    const response = await asAdmin('GET', '/api/v1/admin/errors?search=модель');
    expect(response.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toStrictEqual([
      ISSUE_RARE,
    ]);
  });

  it('сортировка по частоте ставит шумную проблему первой и не обещает курсор', async () => {
    const response = await asAdmin('GET', '/api/v1/admin/errors?sort=frequency');

    const body = response.json<{ items: { id: string; events: number }[]; nextCursor: null }>();
    expect(body.items[0]?.id).toBe(ISSUE_NOISY);
    expect(body.items[0]?.events).toBe(105);
    expect(
      body.nextCursor,
      'сортировка по частоте вернула курсор: частота — это сумма за период, она ' +
        'меняется во время листания, и keyset по ней даёт пропуски и повторы',
    ).toBeNull();
  });

  it('курсор сортировки по времени возвращает следующую страницу без повторов', async () => {
    const first = await asAdmin('GET', '/api/v1/admin/errors?limit=1');
    const firstBody = first.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await asAdmin(
      'GET',
      `/api/v1/admin/errors?limit=1&cursor=${encodeURIComponent(String(firstBody.nextCursor))}`,
    );
    const secondBody = second.json<{ items: { id: string }[] }>();

    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
  });

  it('повреждённый курсор — 400, а не молчаливый возврат к первой странице', async () => {
    const response = await asAdmin('GET', '/api/v1/admin/errors?cursor=%2A%2A%2Anonsense');
    expect(response.statusCode).toBe(400);
  });
});

describe('карточка проблемы', () => {
  it('отдаёт сигнатуры, примеры и ряд по релизам', async () => {
    const detail = await asAdmin('GET', `/api/v1/admin/errors/${ISSUE_NOISY}`);
    expect(detail.statusCode).toBe(200);

    const body = detail.json<{
      issue: { id: string };
      signatures: { fingerprint: string }[];
      samples: { requestId: string | null }[];
    }>();
    expect(body.issue.id).toBe(ISSUE_NOISY);
    expect(body.signatures.map((s) => s.fingerprint)).toStrictEqual(['aaaa1111']);
    expect(body.samples.map((s) => s.requestId)).toStrictEqual(['req-0000000000000001']);

    const series = await asAdmin('GET', `/api/v1/admin/errors/${ISSUE_NOISY}/series`);
    const points = series.json<{ points: { release: string; events: number }[] }>().points;
    expect(
      points.map((p) => p.release).sort(),
      'ряд не разделён по релизам: именно этим отвечают на «сломалось после деплоя»',
    ).toStrictEqual(['2026.07.9', '2026.08.1']);
  });

  it('несуществующая проблема — 404', async () => {
    const response = await asAdmin('GET', `/api/v1/admin/errors/${id(999)}`);
    expect(response.statusCode).toBe(404);
  });
});

describe('лента примеров', () => {
  it('фильтруется по идентификатору запроса', async () => {
    const response = await asAdmin(
      'GET',
      '/api/v1/admin/errors/samples?requestId=req-0000000000000002',
    );

    const items = response.json<{ items: { fingerprint: string }[] }>().items;
    expect(items.map((i) => i.fingerprint)).toStrictEqual(['bbbb2222']);
  });
});

describe('работа с проблемой', () => {
  it('взятие в работу меняет статус и оставляет запись в истории и в аудите', async () => {
    const response = await asAdmin('POST', `/api/v1/admin/errors/${ISSUE_NOISY}/actions`, {
      action: 'acknowledge',
      comment: 'смотрю пул соединений',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('ack');

    const [issue] = await db.query<{ status: string; acked_by: string | null }>(
      'select status, acked_by from error_issues where id = $1',
      [ISSUE_NOISY],
    );
    expect(issue?.status).toBe('ack');
    expect(issue?.acked_by).toBe(USER_ADMIN);

    const actions = await db.query<{ action: string }>(
      'select action from error_issue_actions where issue_id = $1',
      [ISSUE_NOISY],
    );
    expect(actions.map((a) => a.action)).toStrictEqual(['acknowledge']);

    const audit = await db.query<{ action: string; entity_id: string }>(
      `select action, entity_id from audit_log where entity_type = 'error_issue'`,
    );
    expect(
      audit,
      'действие над проблемой не оставило следа в audit_log: смена статуса и её след ' +
        'обязаны быть одним фактом, иначе аудит не отвечает на «кто закрыл»',
    ).toHaveLength(1);
    expect(audit[0]?.action).toBe('diagnostics.issue.acknowledge');
    expect(audit[0]?.entity_id).toBe(ISSUE_NOISY);
  });

  it('закрытие требует разбора и способа устранения', async () => {
    const withoutCause = await asAdmin('POST', `/api/v1/admin/errors/${ISSUE_NOISY}/actions`, {
      action: 'resolve',
      resolution: 'перезапустили',
    });

    expect(
      withoutCause.statusCode,
      'проблему закрыли без разбора: «убрали с экрана» и «починили» обязаны ' +
        'различаться в БД, а не в намерениях нажавшего кнопку',
    ).toBe(422);

    const complete = await asAdmin('POST', `/api/v1/admin/errors/${ISSUE_NOISY}/actions`, {
      action: 'resolve',
      rootCause: 'пул был меньше числа воркеров',
      resolution: 'PG_POOL_MAX поднят до 20',
      resolutionType: 'fixed',
      fixedInRelease: '2026.08.2',
    });
    expect(complete.statusCode).toBe(200);

    const [issue] = await db.query<{ status: string; resolution: string; resolved_by: string }>(
      'select status, resolution, resolved_by from error_issues where id = $1',
      [ISSUE_NOISY],
    );
    expect(issue?.status).toBe('resolved');
    expect(issue?.resolution).toBe('PG_POOL_MAX поднят до 20');
    expect(issue?.resolved_by).toBe(USER_ADMIN);
  });

  it('переоткрытие сохраняет прежний разбор', async () => {
    const response = await asAdmin('POST', `/api/v1/admin/errors/${ISSUE_RESOLVED}/actions`, {
      action: 'reopen',
      comment: 'повторилось на 2026.08.1',
    });

    expect(response.json<{ status: string }>().status).toBe('new');

    const [issue] = await db.query<{ status: string; resolution: string | null }>(
      'select status, resolution from error_issues where id = $1',
      [ISSUE_RESOLVED],
    );
    expect(issue?.status).toBe('new');
    expect(
      issue?.resolution,
      'переоткрытие стёрло прежнее решение: «чем это чинили в прошлый раз» — ' +
        'единственное, ради чего журнал хранят год',
    ).toBe('добавлена проверка');
  });

  it('чтения мало: изменение закрыто правом settings.manage', async () => {
    // Роль, у которой есть diagnostics.read и нет settings.manage, в матрице
    // сейчас не существует: оба права у администратора. Проверяется соседняя
    // граница — что действие вообще требует прав и не открыто инженеру.
    const response = await as(KC.engineer, 'POST', `/api/v1/admin/errors/${ISSUE_NOISY}/actions`, {
      action: 'acknowledge',
    });
    expect(response.statusCode).toBe(403);
  });
});
