/**
 * Поток событий ревизии (SSE) — на поднятом сокете и настоящей БД (§3.8, §16).
 *
 * ## Почему сокет, а не `inject()`
 *
 * У потока нет конца: `inject()` ждал бы завершения ответа до таймаута и
 * проверял бы в лучшем случае код состояния. Всё содержательное здесь —
 * порядок кадров, точка возобновления по `Last-Event-ID` и поведение при
 * обрыве — существует только на настоящем соединении, поэтому приложение
 * слушает порт, а клиентом выступает `fetch`.
 *
 * ## Что именно проверяется
 *
 * 1. Кадры приходят в порядке `seq`, и `id` кадра совпадает с `seq` события:
 *    иначе `Last-Event-ID` реконнекта указывал бы не туда.
 * 2. Реконнект с `Last-Event-ID` отдаёт ПРОПУЩЕННОЕ, а не начало ленты. Начало
 *    ленты означало бы дубликаты на экране при каждом обрыве.
 * 3. Изоляция: подписка на чужую ревизию не открывается — ни своим адресом, ни
 *    подстановкой чужого идентификатора. Поток событий — один из четырёх путей
 *    обхода изоляции (§16), и отказ обязан быть неотличим от «нет такой
 *    ревизии»: ответ «есть, но не ваша» сам сообщает о существовании чужой
 *    поставки.
 * 4. Обрыв соединения не касается конвейера. Поток — уведомление, а не источник
 *    состояния: задачи обязаны доработать, события — записаться, а следующий
 *    клиент — получить их с той точки, на которой оборвался предыдущий.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';
import { NoopErrorReporter } from '../../observability/errors.js';
import { createLogger } from '../../observability/logger.js';
import { createMetrics } from '../../observability/metrics.js';
import {
  appendRevisionEvent,
  enqueueSystemJob,
  readRevisionEvents,
} from '../../db/repositories/jobs.js';
import { JobRegistry, type JobContext } from '../../jobs/registry.js';
import { JobRunner } from '../../jobs/runner.js';

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

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR_A = id(2);
const ORG_CONTRACTOR_B = id(3);
const OBJECT_A = id(4);
const OBJECT_B = id(5);

const SUBMISSION_A = id(10);
/** Лента подрядчика А: порядок кадров и возобновление. */
const REVISION_A = id(11);
const SUBMISSION_B = id(12);
/** Лента подрядчика Б: цель проверок изоляции. */
const REVISION_B = id(13);
const SUBMISSION_P = id(14);
/** Отдельная ревизия под обрыв соединения: её лента пуста до самого теста. */
const REVISION_P = id(15);

/** Существующий по форме, но отсутствующий идентификатор: эталон ответа 404. */
const REVISION_MISSING = id(99);

const USER_CONTRACTOR_A = id(20);
const USER_CONTRACTOR_B = id(21);
const USER_ENGINEER = id(22);

const KC = {
  contractorA: 'kc-sse-contractor-a',
  contractorB: 'kc-sse-contractor-b',
  engineer: 'kc-sse-engineer',
} as const;

/** Типы событий ленты: порядок значим — по нему проверяется порядок кадров. */
const SEEDED_EVENTS: readonly string[] = [
  'revision.created',
  'file.uploaded',
  'bundle.created',
  'layout.detected',
  'checks.finished',
];

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'SSE01', 'Объект А', 'ЖК «А», корпус 1')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_B}', 'SSE02', 'Объект Б', 'ЖК «Б», корпус 2')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_A}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_B}', 'roofing') ON CONFLICT DO NOTHING`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR_A}', '${KC.contractorA}', 'Сотрудник А', '${ORG_CONTRACTOR_A}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR_B}', '${KC.contractorB}', 'Сотрудник Б', '${ORG_CONTRACTOR_B}')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер без назначений')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR_A}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR_B}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,

  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_A}', '${ORG_CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_A}', '${OBJECT_A}', '${ORG_CONTRACTOR_A}', '${ORG_CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Комплект А', '${USER_CONTRACTOR_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_A}', '${SUBMISSION_A}', '${OBJECT_A}', '${ORG_CONTRACTOR_A}', 1)`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_B}', '${ORG_CONTRACTOR_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_B}', '${OBJECT_B}', '${ORG_CONTRACTOR_B}', '${ORG_CONTRACTOR_B}', 'roofing', DATE '2026-01-01', 'Комплект Б', '${USER_CONTRACTOR_B}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_B}', '${SUBMISSION_B}', '${OBJECT_B}', '${ORG_CONTRACTOR_B}', 1)`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_A}', '${ORG_CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_P}', '${OBJECT_A}', '${ORG_CONTRACTOR_A}', '${ORG_CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Комплект А-2', '${USER_CONTRACTOR_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_P}', '${SUBMISSION_P}', '${OBJECT_A}', '${ORG_CONTRACTOR_A}', 1)`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-sse-tests-012345678901234',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/sse-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-sse-tests',
  RATE_LIMIT_MAX: '100000',
});

let db: TestDatabase;
let app: AppInstance;
let runner: JobRunner;
let baseUrl: string;

const behaviours = new Map<string, (ctx: JobContext) => Promise<void>>();

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
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const eventType of SEEDED_EVENTS) {
    await appendRevisionEvent(app.db, {
      revisionId: REVISION_A,
      eventType,
      payload: { eventType },
    });
  }

  const registry = new JobRegistry();
  registry.register('graph.build', async (ctx) => {
    const behaviour = behaviours.get(ctx.jobId);
    if (behaviour !== undefined) await behaviour(ctx);
  });

  runner = new JobRunner({
    db: app.db,
    registry,
    logger: createLogger({ service: 'sse-test-worker', level: 'silent', env: 'test' }),
    metrics: createMetrics({ enabled: false, service: 'sse-test-worker' }),
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-sse-test',
  });
}, 180_000);

afterAll(async () => {
  await runner.stop();
  await app.close();
  await db.close();
});

// =====================================================================
// Вход
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

  const session: SignedIn = {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
  signedIn.set(kcSub, session);
  return session;
}

// =====================================================================
// Клиент SSE
// =====================================================================

interface SseEventFrame {
  readonly id: string | null;
  readonly event: string;
  readonly data: { seq?: number; createdAt?: string; payload?: Record<string, unknown> };
}

interface StreamResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly raw: string;
  readonly frames: readonly SseEventFrame[];
  /** Управление соединением: тест решает, когда оборвать связь. */
  readonly abort: () => void;
}

interface ReadStreamOptions {
  readonly cookie: string;
  readonly lastEventIdHeader?: string;
  readonly query?: string;
  /** Сколько кадров дождаться перед возвратом. */
  readonly wantFrames: number;
  readonly timeoutMs?: number;
  /** Не обрывать соединение при выходе: тест сделает это сам и позже. */
  readonly keepOpen?: boolean;
}

/**
 * Чтение потока до заданного числа кадров.
 *
 * Соединение обрывается намеренно: у потока нет конца, и ждать его закрытия
 * значило бы ждать `MAX_CONNECTION_MS`. Обрыв заодно проверяет, что сервер
 * замечает уход клиента и не оставляет цикл опроса работать вечно.
 */
async function readStream(path: string, options: ReadStreamOptions): Promise<StreamResult> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const guard = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const headers: Record<string, string> = {
    cookie: options.cookie,
    accept: 'text/event-stream',
  };
  if (options.lastEventIdHeader !== undefined) {
    headers['last-event-id'] = options.lastEventIdHeader;
  }

  const response = await fetch(`${baseUrl}${path}${options.query ?? ''}`, {
    headers,
    signal: controller.signal,
  });

  const abort = (): void => {
    clearTimeout(guard);
    controller.abort();
  };

  if (response.status !== 200) {
    const raw = await response.text();
    clearTimeout(guard);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      raw,
      frames: [],
      abort,
    };
  }

  const body = response.body;
  if (body === null) throw new Error('поток без тела');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let frames = parseFrames(raw);

  try {
    while (frames.length < options.wantFrames) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
      frames = parseFrames(raw);
    }
  } catch (error) {
    // Обрыв по сторожевому таймеру приходит сюда как AbortError: кадры,
    // прочитанные до него, всё равно годятся для разбора, а недобор проверит
    // сам тест — молчаливое «ноль кадров» было бы зелёным результатом.
    // Сверяется имя, а не тип: отмена fetch в Node приходит DOMException.
    if ((error as { name?: unknown }).name !== 'AbortError') throw error;
  }

  clearTimeout(guard);
  if (options.keepOpen !== true) controller.abort();

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    raw,
    frames,
    abort,
  };
}

/** Разбор кадров SSE. Комментарии-пульсы (`: ping`) кадрами не считаются. */
function parseFrames(raw: string): SseEventFrame[] {
  const frames: SseEventFrame[] = [];

  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line !== '');
    if (lines.length === 0) continue;

    let frameId: string | null = null;
    let event: string | null = null;
    let data: string | null = null;

    for (const line of lines) {
      if (line.startsWith('id: ')) frameId = line.slice(4);
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }

    // Незавершённый последний блок и строка `retry:` кадрами не являются.
    if (event === null || data === null) continue;
    frames.push({ id: frameId, event, data: JSON.parse(data) as SseEventFrame['data'] });
  }

  return frames;
}

function eventsPath(revisionId: string): string {
  return `/api/v1/revisions/${revisionId}/events`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('условие не наступило за отведённое время');
    await pause(10);
  }
}

// =====================================================================
// Порядок и возобновление
// =====================================================================

describe('лента событий ревизии', () => {
  it('отдаёт события в порядке seq, и id кадра равен seq события', async () => {
    const contractor = await sessionFor(KC.contractorA);
    const stream = await readStream(eventsPath(REVISION_A), {
      cookie: contractor.cookie,
      wantFrames: SEEDED_EVENTS.length,
    });

    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');
    // Пауза до повторного подключения назначается сервером: без неё браузер
    // выбирает её сам, и после сбоя порталу прилетает шквал реконнектов.
    expect(stream.raw.startsWith('retry: ')).toBe(true);

    const ids = stream.frames.map((frame) => Number(frame.id));
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(stream.frames.map((frame) => frame.event)).toEqual(SEEDED_EVENTS);
    // `id` кадра — это и есть `seq`: иначе `Last-Event-ID` реконнекта указывал
    // бы не на то событие, и дыра в ленте осталась бы незамеченной.
    expect(stream.frames.map((frame) => frame.data.seq)).toEqual(ids);
    expect(stream.frames.every((frame) => typeof frame.data.createdAt === 'string')).toBe(true);

    const stored = await readRevisionEvents(app.db, { revisionId: REVISION_A, limit: 100 });
    expect(stored.events.map((event) => event.seq)).toEqual(ids);
  }, 30_000);

  it('Last-Event-ID отдаёт пропущенное, а не начало ленты', async () => {
    const contractor = await sessionFor(KC.contractorA);
    const stream = await readStream(eventsPath(REVISION_A), {
      cookie: contractor.cookie,
      lastEventIdHeader: '2',
      wantFrames: 3,
    });

    const ids = stream.frames.map((frame) => frame.id);
    expect(ids).toEqual(['3', '4', '5']);
    // Главное отрицание: уже доставленные кадры не повторяются. Начало ленты
    // означало бы дубликаты на экране при каждом обрыве связи.
    expect(ids).not.toContain('1');
    expect(ids).not.toContain('2');
    expect(stream.frames[0]?.event).toBe(SEEDED_EVENTS[2]);
  }, 30_000);

  it('точку возобновления можно назвать и параметром запроса', async () => {
    const contractor = await sessionFor(KC.contractorA);
    // Клиенты, которым нечем поставить заголовок (например, EventSource в
    // обёртке без доступа к заголовкам), обязаны иметь тот же способ.
    const stream = await readStream(eventsPath(REVISION_A), {
      cookie: contractor.cookie,
      query: '?lastEventId=4',
      wantFrames: 1,
    });

    expect(stream.frames.map((frame) => frame.id)).toEqual(['5']);
    expect(stream.frames[0]?.event).toBe(SEEDED_EVENTS[4]);
  }, 30_000);

  it('заголовок сильнее параметра: EventSource всегда шлёт свой', async () => {
    const contractor = await sessionFor(KC.contractorA);
    const stream = await readStream(eventsPath(REVISION_A), {
      cookie: contractor.cookie,
      lastEventIdHeader: '4',
      query: '?lastEventId=0',
      wantFrames: 1,
    });

    expect(stream.frames.map((frame) => frame.id)).toEqual(['5']);
  }, 30_000);
});

// =====================================================================
// Изоляция (§16)
// =====================================================================

describe('изоляция потока событий', () => {
  it('подрядчик не подписывается на ревизию другого подрядчика', async () => {
    const contractorA = await sessionFor(KC.contractorA);
    const contractorB = await sessionFor(KC.contractorB);

    // Контроль: своя ревизия открывается. Без него проверка ниже была бы
    // зелёной и от того, что маршрут сломан для всех.
    const own = await readStream(eventsPath(REVISION_A), {
      cookie: contractorA.cookie,
      wantFrames: 1,
    });
    expect(own.status).toBe(200);

    // Подстановка чужого идентификатора — прямой путь обхода изоляции (§16).
    const crossed = await readStream(eventsPath(REVISION_B), {
      cookie: contractorA.cookie,
      wantFrames: 1,
    });
    expect(crossed.status).toBe(404);
    expect(crossed.contentType).toContain('application/problem+json');
    expect(crossed.raw).not.toContain('text/event-stream');

    // И обратная сторона: у Б своя лента есть, но чужая ему тоже закрыта.
    const mirrored = await readStream(eventsPath(REVISION_A), {
      cookie: contractorB.cookie,
      wantFrames: 1,
    });
    expect(mirrored.status).toBe(404);

    const ownB = await readStream(eventsPath(REVISION_B), {
      cookie: contractorB.cookie,
      wantFrames: 1,
      timeoutMs: 4_000,
    });
    // Лента Б пуста, поэтому кадров нет — но соединение открылось, и это
    // отличает «не ваша ревизия» от «ревизия без событий».
    expect(ownB.status).toBe(200);
    expect(ownB.frames).toEqual([]);
  }, 60_000);

  it('отказ по чужой ревизии неотличим от отказа по несуществующей', async () => {
    const contractorA = await sessionFor(KC.contractorA);

    const foreign = await app.inject({
      method: 'GET',
      url: eventsPath(REVISION_B),
      headers: { cookie: contractorA.cookie },
    });
    const missing = await app.inject({
      method: 'GET',
      url: eventsPath(REVISION_MISSING),
      headers: { cookie: contractorA.cookie },
    });

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Ответ «есть, но не ваша» сам по себе сообщает о существовании чужой
    // поставки, поэтому тела обязаны совпадать во всём, кроме request_id.
    const strip = (response: LightMyRequestResponse): Record<string, unknown> => {
      const body = response.json() as Record<string, unknown>;
      delete body['requestId'];
      delete body['instance'];
      return body;
    };
    expect(strip(foreign)).toEqual(strip(missing));
  });

  it('сводка обработки закрыта теми же правилами, что и поток', async () => {
    const contractorA = await sessionFor(KC.contractorA);
    const engineer = await sessionFor(KC.engineer);

    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${REVISION_A}/processing-status`,
      headers: { cookie: contractorA.cookie },
    });
    expect(own.statusCode).toBe(200);

    const crossed = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${REVISION_B}/processing-status`,
      headers: { cookie: contractorA.cookie },
    });
    expect(crossed.statusCode).toBe(404);

    // Инженер без назначенных объектов видит ничего, а не всё (§1.6).
    const blank = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${REVISION_A}/processing-status`,
      headers: { cookie: engineer.cookie },
    });
    expect(blank.statusCode).toBe(404);

    const blankStream = await app.inject({
      method: 'GET',
      url: eventsPath(REVISION_A),
      headers: { cookie: engineer.cookie },
    });
    expect(blankStream.statusCode).toBe(404);
  });

  it('без сессии поток не открывается вовсе', async () => {
    const response = await fetch(`${baseUrl}${eventsPath(REVISION_A)}`, {
      headers: { accept: 'text/event-stream' },
    });
    await response.text();
    expect(response.status).toBe(401);
  });
});

// =====================================================================
// Обрыв соединения и конвейер
// =====================================================================

describe('обрыв соединения', () => {
  it('не мешает задачам исполняться, а следующий клиент получает пропущенное', async () => {
    const contractor = await sessionFor(KC.contractorA);

    // Лента ревизии пуста: всё, что появится дальше, произведено конвейером.
    const before = await readRevisionEvents(app.db, { revisionId: REVISION_P, limit: 100 });
    expect(before.events).toEqual([]);

    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_P },
    });

    let entered = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    behaviours.set(enqueued.jobId, async (ctx) => {
      entered = true;
      await gate;
      await ctx.emit('graph.built', { nodes: 3 });
    });

    // Клиент подписывается ДО постановки работы: иначе проверялся бы повтор
    // уже записанного, а не живое соединение поверх идущего конвейера.
    const livePromise = readStream(eventsPath(REVISION_P), {
      cookie: contractor.cookie,
      wantFrames: 1,
      keepOpen: true,
      timeoutMs: 20_000,
    });

    const pumping = runner.runOnce();
    await waitUntil(() => entered);

    // `job.started` пишется до вызова обработчика, поэтому к этому моменту
    // кадру уже есть чему приехать.
    const live = await livePromise;
    expect(live.status).toBe(200);
    expect(live.frames.map((frame) => frame.event)).toEqual(['job.started']);

    // Обрыв ровно в середине обработки: так выглядит закрытая вкладка или
    // уснувший ноутбук. Конвейер о клиенте ничего не знает и знать не должен.
    live.abort();
    await pause(50);

    release();
    await pumping;

    // 1. Задача доработала до конца, несмотря на ушедшего слушателя.
    const jobRows = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM jobs WHERE id = $1`,
      [enqueued.jobId],
    );
    expect(jobRows[0]?.status).toBe('done');
    const runs = await db.query<{ outcome: string }>(
      `SELECT outcome FROM job_runs WHERE job_id = $1`,
      [enqueued.jobId],
    );
    expect(runs.map((row) => row.outcome)).toEqual(['succeeded']);

    // 2. События, произошедшие после обрыва, записаны в ленту.
    const after = await readRevisionEvents(app.db, { revisionId: REVISION_P, limit: 100 });
    expect(after.events.map((event) => event.eventType)).toEqual([
      'job.started',
      'graph.built',
      'job.succeeded',
    ]);

    // 3. Следующий клиент продолжает с того места, где оборвался предыдущий, —
    //    ни дубликатов, ни дыры.
    const resumed = await readStream(eventsPath(REVISION_P), {
      cookie: contractor.cookie,
      lastEventIdHeader: '1',
      wantFrames: 2,
      timeoutMs: 20_000,
    });
    expect(resumed.frames.map((frame) => frame.id)).toEqual(['2', '3']);
    expect(resumed.frames.map((frame) => frame.event)).toEqual(['graph.built', 'job.succeeded']);
    expect(resumed.frames[0]?.data.payload).toMatchObject({ nodes: 3 });

    // 4. Источник состояния — REST, а не поток: он отвечает то же самое
    //    клиенту, который поток потерял целиком (§3.8).
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${REVISION_P}/processing-status`,
      headers: { cookie: contractor.cookie },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as { attempts: number; running: number; dead: number };
    expect(body.attempts).toBe(1);
    expect(body.running).toBe(0);
    expect(body.dead).toBe(0);
  }, 60_000);

  it('поток, открытый после обрыва, продолжает получать новые события', async () => {
    const contractor = await sessionFor(KC.contractorA);

    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_P },
    });
    behaviours.set(enqueued.jobId, (ctx) => ctx.emit('graph.rebuilt', { nodes: 4 }));

    // Подписка открыта ДО постановки работы: проверяется цикл опроса, а не
    // повтор уже записанного.
    const streamPromise = readStream(eventsPath(REVISION_P), {
      cookie: contractor.cookie,
      lastEventIdHeader: '3',
      wantFrames: 3,
      timeoutMs: 20_000,
    });

    await pause(100);
    await runner.runOnce();

    const stream = await streamPromise;
    expect(stream.frames.map((frame) => frame.event)).toEqual([
      'job.started',
      'graph.rebuilt',
      'job.succeeded',
    ]);
    expect(stream.frames.map((frame) => frame.id)).toEqual(['4', '5', '6']);
  }, 60_000);
});
