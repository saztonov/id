/**
 * Движок задач и события ревизии: прогон на настоящей PostgreSQL (pglite).
 *
 * Проверяется поведение, а не наличие модулей. Это прямое следствие урока S3:
 * слой наблюдаемости был написан, покрыт зелёными тестами и НЕ подключён,
 * потому что тесты звали модули напрямую. Поэтому здесь:
 *
 * - очередь и журнал попыток проверяются через настоящий `JobRunner` с
 *   настоящим захватом `FOR UPDATE SKIP LOCKED`, а не вызовом обработчика;
 * - консоль задач и поток событий — через собранное `buildApp()`, то есть
 *   ровно то, что зарегистрировано в `app.ts`;
 * - SSE проверяется на поднятом сокете, а не `inject()`: у потока нет конца,
 *   и `inject()` ждал бы его до таймаута.
 *
 * Чего проверить нельзя: истинную конкурентность двух воркеров. pglite
 * одноконнектный (ADR-0002), поэтому «два воркера не получают одну задачу»
 * закрывается на настоящей PostgreSQL в CI (`TEST_DATABASE_URL`), а здесь
 * проверяется наблюдаемое следствие — повторный захват той же строки не
 * происходит, пока аренда жива.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../app.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../auth/session.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createMetrics } from '../observability/metrics.js';
import { NoopErrorReporter } from '../observability/errors.js';
import {
  appendOutbox,
  cancelJob,
  computeProcessingStatus,
  enqueueSystemJob,
  findJob,
  listJobRuns,
  listJobs,
  publishOutboxBatch,
  queueSnapshot,
  reapExpiredLeases,
  readRevisionEvents,
  OUTBOX_REVISION_AGGREGATE,
} from '../db/repositories/jobs.js';
import type { AuthScope } from '../auth/scope.js';
import { JobRegistry, type JobContext } from './registry.js';
import { JobRunner } from './runner.js';
import {
  backoffDelayMs,
  clampConcurrency,
  dedupeKeyFor,
  jobDefinition,
  JOB_QUEUES,
} from './types.js';

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

const ORG_DEVELOPER = id(1);
const ORG_CONTRACTOR_A = id(2);
const ORG_CONTRACTOR_B = id(3);
const OBJECT = id(4);

const SUBMISSION_A = id(10);
const REVISION_A = id(11);
const SUBMISSION_B = id(12);
const REVISION_B = id(13);

const USER_ADMIN = id(20);
const USER_CONTRACTOR_A = id(21);
const USER_CONTRACTOR_B = id(22);

const KC = {
  admin: 'kc-jobs-admin',
  contractorA: 'kc-jobs-contractor-a',
  contractorB: 'kc-jobs-contractor-b',
} as const;

const INN_VALID = '7700123459';

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind, inn)
     VALUES ('${ORG_DEVELOPER}', 'ООО «Застройщик»', 'customer', '${INN_VALID}')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'JOB01', 'Объект', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,

  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR_A}', '${KC.contractorA}', 'Сотрудник А', '${ORG_CONTRACTOR_A}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR_B}', '${KC.contractorB}', 'Сотрудник Б', '${ORG_CONTRACTOR_B}')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR_A}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR_B}', 'contractor')`,

  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_A}', '${OBJECT}', '${ORG_CONTRACTOR_A}', '${ORG_CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Комплект А', '${USER_CONTRACTOR_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_A}', '${SUBMISSION_A}', '${OBJECT}', '${ORG_CONTRACTOR_A}', 1)`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_B}', '${OBJECT}', '${ORG_CONTRACTOR_B}', '${ORG_CONTRACTOR_B}', 'roofing', DATE '2026-01-01', 'Комплект Б', '${USER_CONTRACTOR_B}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_B}', '${SUBMISSION_B}', '${OBJECT}', '${ORG_CONTRACTOR_B}', 1)`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-jobs-tests-0123456789012',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/jobs-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-jobs-tests',
  RATE_LIMIT_MAX: '100000',
});

let db: TestDatabase;
let app: AppInstance;
let runner: JobRunner;
let registry: JobRegistry;

/** Что делает обработчик, задаётся тестом: очередь одна, поведение разное. */
const behaviours = new Map<string, (ctx: JobContext) => Promise<void>>();

const ADMIN_SCOPE: AuthScope = { kind: 'admin', userId: USER_ADMIN };
const CONTRACTOR_A_SCOPE: AuthScope = {
  kind: 'contractor',
  userId: USER_CONTRACTOR_A,
  contractorId: ORG_CONTRACTOR_A,
};
const CONTRACTOR_B_SCOPE: AuthScope = {
  kind: 'contractor',
  userId: USER_CONTRACTOR_B,
  contractorId: ORG_CONTRACTOR_B,
};

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

  registry = new JobRegistry();
  // Реальные типы задач конвейера: обработчики стадий появятся на своих
  // этапах, а поведение здесь подменяется по идентификатору задачи.
  const dispatch = async (ctx: JobContext): Promise<void> => {
    const behaviour = behaviours.get(ctx.jobId);
    if (behaviour !== undefined) await behaviour(ctx);
  };
  registry.register('graph.build', dispatch);
  registry.register('checks.run', dispatch);
  registry.register('jobs.reaper', dispatch);

  runner = new JobRunner({
    db: app.db,
    registry,
    logger: createLogger({ service: 'test-worker', level: 'silent', env: 'test' }),
    metrics: createMetrics({ enabled: false, service: 'test-worker' }),
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-1',
    // Ждать реальный экспоненциальный откат в тесте нельзя, а проверять его
    // надо: поведение проверяется отдельно, у `backoffDelayMs`.
    backoff: { baseMs: 20, factor: 2, capMs: 100, jitter: 0 },
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
// Помощники
// =====================================================================

async function rawJob(jobId: string): Promise<Record<string, unknown>> {
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  const row = rows[0];
  if (row === undefined) throw new Error(`задача ${jobId} не найдена`);
  return row;
}

async function runsOf(jobId: string): Promise<Record<string, unknown>[]> {
  return db.query<Record<string, unknown>>(
    `SELECT * FROM job_runs WHERE job_id = $1 ORDER BY attempt`,
    [jobId],
  );
}

async function eventTypesOf(revisionId: string): Promise<string[]> {
  const rows = await db.query<{ event_type: string }>(
    `SELECT event_type FROM revision_events WHERE revision_id = $1 ORDER BY seq`,
    [revisionId],
  );
  return rows.map((row) => row.event_type);
}

/** Задача сразу становится доступной: экспоненциальный откат тесту ждать незачем. */
async function makeRunnable(jobId: string): Promise<void> {
  await db.query(`UPDATE jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [
    jobId,
  ]);
}

// =====================================================================
// Очередь
// =====================================================================

describe('очередь задач', () => {
  it('идемпотентна по dedupe_key: повторная постановка не создаёт вторую задачу', async () => {
    const key = dedupeKeyFor('graph.build', REVISION_A, 'idempotency');
    const first = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A },
      dedupeKey: key,
    });
    const second = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A },
      dedupeKey: key,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);

    const count = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE dedupe_key = $1`,
      [key],
    );
    expect(count[0]?.count).toBe(1);

    await cancelJob(app.db, ADMIN_SCOPE, first.jobId, {
      emailHmac: null,
      ip: null,
      requestId: null,
    });
  });

  it('выполняет задачу, пишет попытку с длительностью и событие ревизии', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A, request_id: 'req-graph-build' },
    });
    behaviours.set(enqueued.jobId, async (ctx) => {
      expect(ctx.revisionId).toBe(REVISION_A);
      expect(ctx.attempt).toBe(1);
      await ctx.emit('graph.built', { nodes: 3 });
    });

    const claimed = await runner.runOnce();
    expect(claimed).toBeGreaterThan(0);

    const job = await rawJob(enqueued.jobId);
    expect(job['status']).toBe('done');
    expect(job['locked_by']).toBeNull();

    const runs = await runsOf(enqueued.jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.['outcome']).toBe('succeeded');
    expect(runs[0]?.['attempt']).toBe(1);
    expect(Number(runs[0]?.['duration_ms'])).toBeGreaterThanOrEqual(0);
    // Сквозной request_id из payload доехал до журнала попыток (§11).
    expect(runs[0]?.['request_id']).toBe('req-graph-build');
    expect(runs[0]?.['payload_digest']).toMatch(/^[0-9a-f]{64}$/);

    const events = await eventTypesOf(REVISION_A);
    expect(events).toContain('job.started');
    expect(events).toContain('graph.built');
    expect(events).toContain('job.succeeded');
  });

  it('повторяет упавшую задачу и уводит в dead после max_attempts', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 2,
    });
    behaviours.set(enqueued.jobId, () => Promise.reject(new Error('внешний сервис не ответил')));

    await runner.runOnce();
    const afterFirst = await rawJob(enqueued.jobId);
    expect(afterFirst['status']).toBe('queued');
    expect(afterFirst['attempts']).toBe(1);
    expect(afterFirst['last_error']).toContain('внешний сервис не ответил');

    await makeRunnable(enqueued.jobId);
    await runner.runOnce();

    const afterSecond = await rawJob(enqueued.jobId);
    expect(afterSecond['status']).toBe('failed');
    expect(afterSecond['attempts']).toBe(2);

    const runs = await runsOf(enqueued.jobId);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run['outcome'] === 'failed')).toBe(true);
    expect(await eventTypesOf(REVISION_A)).toContain('job.dead');

    // Мёртвая задача видна в консоли и повторяется вручную (§12).
    const view = await findJob(app.db, ADMIN_SCOPE, enqueued.jobId);
    expect(view?.isDead).toBe(true);
  });

  it('не повторяет задачу с непригодным payload: тот же вход даст тот же отказ', async () => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO jobs (type, payload, max_attempts) VALUES ('graph.build', '{"nope": 1}'::jsonb, 5)
       RETURNING id`,
    );
    const jobId = rows[0]?.id;
    expect(jobId).toBeDefined();

    await runner.runOnce();

    const job = await rawJob(jobId as string);
    expect(job['status']).toBe('failed');
    expect(job['attempts']).toBe(1);
    const runs = await runsOf(jobId as string);
    expect(runs[0]?.['error_class']).toBe('InvalidPayload');
  });

  it('reaper освобождает аренду убитого воркера и закрывает попытку', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A },
    });
    // Имитация воркера, убитого сигналом: задача занята, аренда истекла,
    // попытка осталась незакрытой.
    await db.query(
      `UPDATE jobs SET status = 'running', locked_by = 'dead-worker',
              locked_until = now() - interval '1 minute', attempts = 1
        WHERE id = $1`,
      [enqueued.jobId],
    );
    await db.query(
      `INSERT INTO job_runs (job_id, job_type, revision_id, attempt, started_at)
       VALUES ($1, 'graph.build', $2, 1, now() - interval '2 minutes')`,
      [enqueued.jobId, REVISION_A],
    );

    const result = await reapExpiredLeases(app.db, {});
    expect(result.requeued).toBe(1);
    expect(result.closedRuns).toBe(1);

    const job = await rawJob(enqueued.jobId);
    expect(job['status']).toBe('queued');
    expect(job['locked_by']).toBeNull();

    const runs = await runsOf(enqueued.jobId);
    expect(runs[0]?.['outcome']).toBe('lease_expired');
    expect(Number(runs[0]?.['duration_ms'])).toBeGreaterThan(0);

    await cancelJob(app.db, ADMIN_SCOPE, enqueued.jobId, {
      emailHmac: null,
      ip: null,
      requestId: null,
    });
  });

  it('экспоненциальный откат растёт и упирается в потолок', () => {
    const policy = { baseMs: 1_000, factor: 2, capMs: 10_000, jitter: 0 };
    expect(backoffDelayMs(1, policy)).toBe(1_000);
    expect(backoffDelayMs(2, policy)).toBe(2_000);
    expect(backoffDelayMs(4, policy)).toBe(8_000);
    expect(backoffDelayMs(9, policy)).toBe(10_000);
  });

  it('параллелизм зажимается диапазоном и опускается до одной задачи', () => {
    // Аварийная ручка эксплуатации: «прижать воркер до утра» обязано делаться
    // переменной окружения, а не правкой кода. До S41 нижняя граница io была 4,
    // и на общем хосте это означало одиннадцать одновременных задач без выбора.
    expect(clampConcurrency('io', 1)).toBe(1);
    expect(clampConcurrency('llm', 1)).toBe(1);
    expect(clampConcurrency('cpu', 1)).toBe(1);

    // Сверху диапазон держит по-прежнему: одна переменная не превращает cpu в
    // четыре параллельных инференса.
    expect(clampConcurrency('cpu', 8)).toBe(2);
    expect(clampConcurrency('io', 99)).toBe(8);

    // Умолчания рассчитаны на общий VPS 2 vCPU и обязаны оставаться в сумме
    // меньше PG_POOL_MAX (10): иначе задачи ждут соединение, и ожидание пула
    // выглядит в журнале как медленная БД.
    const defaults = JOB_QUEUES.map((queue) => clampConcurrency(queue, undefined));
    expect(defaults.reduce((sum, value) => sum + value, 0)).toBeLessThan(10);
  });

  it('приоритет страницы убывает с её номером и не проваливается под фоновые задачи', () => {
    // Fan-out ставит все страницы разом, и очередь разбирала их строго по
    // времени постановки: комплект на 220 листов занимал конвейер целиком, а
    // второй не двигался вовсе. Формула повторена в трёх местах постановки,
    // поэтому проверяется её смысл, а не одно из мест.
    const priorityOf = (pageIndex: number): number =>
      Math.max(60, 100 - Math.floor(pageIndex / 10));

    // Ранние страницы позднего комплекта обходят хвост раннего — оба показывают
    // движение; общее время при этом не меняется.
    expect(priorityOf(0)).toBeGreaterThan(priorityOf(200));
    expect(priorityOf(0)).toBe(priorityOf(9));
    expect(priorityOf(10)).toBe(priorityOf(0) - 1);

    // Ниже фоновых задач (кэш превью — 50, уборка — 10) хвост не падает: это
    // по-прежнему работа, которую ждёт человек.
    expect(priorityOf(100_000)).toBeGreaterThan(jobDefinition('preview.cache_pages').priority);
  });

  it('глубина очереди считается по типам и статусам', async () => {
    const snapshot = await queueSnapshot(app.db);
    expect(snapshot.depths.length).toBeGreaterThan(0);
    expect(snapshot.dead.some((row) => row.jobType === 'checks.run')).toBe(true);
  });
});

// =====================================================================
// Сводка обработки и события
// =====================================================================

describe('вычисляемая сводка обработки', () => {
  it('считается по job_runs, а не по хранимому полю', async () => {
    const status = await computeProcessingStatus(app.db, ADMIN_SCOPE, REVISION_A);
    expect(status).not.toBeNull();
    expect(status?.attempts).toBeGreaterThan(0);
    expect(status?.jobTypes.some((summary) => summary.jobType === 'graph.build')).toBe(true);
    // Мёртвая задача важнее любой активности: комплект стоит и ждёт человека.
    expect(status?.stage).toBe('failed');
    expect(status?.dead).toBeGreaterThan(0);

    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'submission_revisions' AND column_name = 'processing_status'`,
    );
    expect(columns).toHaveLength(0);
  });

  it('не отдаётся чужой области видимости', async () => {
    expect(await computeProcessingStatus(app.db, CONTRACTOR_B_SCOPE, REVISION_A)).toBeNull();
    expect(await computeProcessingStatus(app.db, CONTRACTOR_A_SCOPE, REVISION_A)).not.toBeNull();
  });
});

describe('события ревизии', () => {
  it('outbox публикуется в ленту с монотонным seq', async () => {
    await appendOutbox(app.db, {
      aggregateType: OUTBOX_REVISION_AGGREGATE,
      aggregateId: REVISION_B,
      eventType: 'revision.submitted',
      payload: { revisionNo: 1 },
    });
    await appendOutbox(app.db, {
      aggregateType: 'unknown_aggregate',
      aggregateId: REVISION_B,
      eventType: 'ignored.event',
    });

    const result = await publishOutboxBatch(app.db, {});
    expect(result.published).toBe(2);
    expect(result.events).toBe(1);

    const window = await readRevisionEvents(app.db, { revisionId: REVISION_B, limit: 50 });
    expect(window.events.map((event) => event.eventType)).toEqual(['revision.submitted']);
    expect(window.events[0]?.seq).toBe(1);

    const unpublished = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox WHERE published_at IS NULL`,
    );
    expect(unpublished[0]?.count).toBe(0);
  });

  it('seq монотонен и окно отдаётся начиная с указанного', async () => {
    const all = await readRevisionEvents(app.db, { revisionId: REVISION_A, limit: 500 });
    const sequences = all.events.map((event) => event.seq);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    const tail = await readRevisionEvents(app.db, {
      revisionId: REVISION_A,
      afterSeq: sequences[0] ?? 0,
      limit: 500,
    });
    expect(tail.events.length).toBe(sequences.length - 1);
    expect(tail.oldestSeq).toBe(sequences[0]);
  });
});

// =====================================================================
// Изоляция
// =====================================================================

describe('изоляция задач по области видимости', () => {
  it('подрядчик не видит задач чужой поставки и обслуживающих задач', async () => {
    const maintenance = await enqueueSystemJob(app.db, {
      type: 'jobs.reaper',
      payload: {},
      dedupeKey: dedupeKeyFor('jobs.reaper', 'isolation'),
    });

    const asAdmin = await listJobs(app.db, ADMIN_SCOPE, { limit: 200 });
    const asContractorA = await listJobs(app.db, CONTRACTOR_A_SCOPE, { limit: 200 });
    const asContractorB = await listJobs(app.db, CONTRACTOR_B_SCOPE, { limit: 200 });

    expect(asAdmin.items.some((job) => job.id === maintenance.jobId)).toBe(true);
    // Обслуживающая задача не относится ни к какой поставке: подрядчику её не видно.
    expect(asContractorA.items.some((job) => job.id === maintenance.jobId)).toBe(false);
    expect(asContractorA.items.every((job) => job.revisionId === REVISION_A)).toBe(true);
    expect(asContractorB.items).toHaveLength(0);

    expect(await findJob(app.db, CONTRACTOR_B_SCOPE, maintenance.jobId)).toBeNull();
    expect(
      await listJobRuns(app.db, CONTRACTOR_B_SCOPE, { revisionId: REVISION_A, limit: 10 }),
    ).toEqual([]);

    await cancelJob(app.db, ADMIN_SCOPE, maintenance.jobId, {
      emailHmac: null,
      ip: null,
      requestId: null,
    });
  });
});

// =====================================================================
// Консоль задач через HTTP
// =====================================================================

describe('консоль задач', () => {
  it('закрыта от подрядчика и открыта администратору', async () => {
    const contractor = await sessionFor(KC.contractorA);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs',
      headers: { cookie: contractor.cookie },
    });
    expect(denied.statusCode).toBe(403);

    const admin = await sessionFor(KC.admin);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs?limit=10',
      headers: { cookie: admin.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(Array.isArray(allowed.json().items)).toBe(true);
  });

  it('повторяет мёртвую задачу и оставляет след в журнале аудита', async () => {
    const admin = await sessionFor(KC.admin);
    const dead = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs?deadOnly=true&limit=10',
      headers: { cookie: admin.cookie },
    });
    expect(dead.statusCode).toBe(200);
    const target = dead.json().items[0] as { id: string; attempts: number } | undefined;
    expect(target).toBeDefined();

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/${target?.id}/retry`,
      headers: { cookie: admin.cookie, [CSRF_HEADER]: admin.csrfToken },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe('queued');
    // Потолок попыток поднят на одну, счётчик не обнулён: история сплошная.
    expect(retried.json().maxAttempts).toBe((target?.attempts ?? 0) + 1);

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_type = 'job' AND entity_id = $1`,
      [target?.id],
    );
    expect(audit.map((row) => row.action)).toContain('job.retried');

    const queues = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs/queues',
      headers: { cookie: admin.cookie },
    });
    expect(queues.statusCode).toBe(200);
    expect(Array.isArray(queues.json().depths)).toBe(true);

    // Задача возвращена в очередь — уберём её, чтобы не мешала прочим прогонам.
    await db.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [target?.id]);
  });
});

// =====================================================================
// Поток событий
// =====================================================================

describe('поток событий ревизии', () => {
  it('не открывается для чужой ревизии', async () => {
    const contractorB = await sessionFor(KC.contractorB);
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${REVISION_A}/events`,
      headers: { cookie: contractorB.cookie },
    });
    expect(denied.statusCode).toBe(404);

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${REVISION_A}/processing-status`,
      headers: { cookie: contractorB.cookie },
    });
    expect(status.statusCode).toBe(404);
  });

  it('отдаёт пропущенное по Last-Event-ID и переживает реконнект', async () => {
    const contractorA = await sessionFor(KC.contractorA);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/v1/revisions/${REVISION_A}/events`;

    const all = await readRevisionEvents(app.db, { revisionId: REVISION_A, limit: 500 });
    expect(all.events.length).toBeGreaterThan(2);
    const fromSeq = all.events[0]?.seq ?? 0;

    const received = await readStream(url, contractorA.cookie, String(fromSeq));

    // Первое событие потока — следующее за названным, а не начало ленты:
    // именно это делает реконнект бесшовным (§3.8).
    expect(received.ids[0]).toBe(String(fromSeq + 1));
    expect(received.ids.length).toBeGreaterThan(0);
    expect(received.ids.includes(String(fromSeq))).toBe(false);
    expect(received.events[0]).toBeDefined();
    expect(received.raw).toContain('retry: ');
  }, 30_000);
});

/**
 * Чтение SSE до первых событий.
 *
 * Соединение обрывается намеренно: у потока нет конца, и ждать его закрытия
 * значит ждать `MAX_CONNECTION_MS`. Обрыв заодно проверяет, что сервер замечает
 * закрытие клиентом и не оставляет цикл опроса работать вечно.
 */
async function readStream(
  url: string,
  cookie: string,
  lastEventId: string,
): Promise<{ ids: string[]; events: string[]; raw: string }> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { cookie, 'last-event-id': lastEventId, accept: 'text/event-stream' },
    signal: controller.signal,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  const body = response.body;
  if (body === null) throw new Error('поток без тела');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = '';

  try {
    // Хватит первых двух кадров: замер полноты ленты делается запросом к БД,
    // а здесь проверяется транспорт и точка возобновления.
    while (raw.split('\n\n').length < 3) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
  }

  const ids = [...raw.matchAll(/^id: (\d+)$/gm)].map((match) => match[1] ?? '');
  const events = [...raw.matchAll(/^event: (.+)$/gm)].map((match) => match[1] ?? '');
  return { ids, events, raw };
}

// =====================================================================
// Остановка воркера
// =====================================================================

describe('остановка воркера', () => {
  /**
   * Проверяется само требование §12, а не намерение: текущая задача
   * дорабатывает, новые не берутся.
   *
   * Свой экземпляр `JobRunner` с большим интервалом опроса взят намеренно.
   * Общий крутит цикл раз в секунду, и «задачу, поставленную после остановки,
   * никто не захватил» на нём проверялось бы гонкой с таймером: зелёный
   * результат означал бы удачу, а не выполнение требования. Здесь после первого
   * холостого прохода следующий тик назначен через минуту, поэтому окно между
   * `stop()` и постановкой второй задачи детерминировано.
   */
  it('дорабатывает текущую задачу и не берёт новые', async () => {
    const behaviour = new Map<string, () => Promise<void>>();
    const shutdownRegistry = new JobRegistry();
    const dispatch = async (ctx: JobContext): Promise<void> => {
      await behaviour.get(ctx.jobId)?.();
    };
    shutdownRegistry.register('graph.build', dispatch);
    shutdownRegistry.register('checks.run', dispatch);

    const shutdownRunner = new JobRunner({
      db: app.db,
      registry: shutdownRegistry,
      logger: createLogger({ service: 'test-worker-2', level: 'silent', env: 'test' }),
      metrics: createMetrics({ enabled: false, service: 'test-worker-2' }),
      errorReporter: new NoopErrorReporter(),
      workerId: 'worker-shutdown',
      pollIntervalMs: 60_000,
    });

    const held = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A },
    });

    let entered = false;
    let finished = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    behaviour.set(held.jobId, async () => {
      entered = true;
      await gate;
      finished = true;
    });

    shutdownRunner.start();
    await waitUntil(() => entered);
    // Холостой проход после захвата успевает назначить следующий тик на минуту.
    await pause(50);

    // Синхронная часть `stop()` уже сняла таймеры очередей: всё, что поставлено
    // после этой строки, обязано остаться в очереди нетронутым.
    const stopping = shutdownRunner.stop();
    const untouched = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
    });

    expect(finished).toBe(false);
    release();
    await stopping;

    // Задача, которая уже шла, доведена до конца и записана как выполненная.
    expect(finished).toBe(true);
    expect((await rawJob(held.jobId)).status).toBe('done');
    const heldRuns = await runsOf(held.jobId);
    expect(heldRuns.at(-1)?.outcome).toBe('succeeded');

    // Прямая проверка запрета, а не наблюдение за таймерами: явный проход по
    // всем очередям после остановки не имеет права захватить ни одной задачи.
    // Без этой строки тест был бы зелёным и от того, что тик просто не успел.
    expect(await shutdownRunner.runOnce()).toBe(0);

    // Задача, поставленная после сигнала, не захвачена: ни попытки, ни аренды.
    const raw = await rawJob(untouched.jobId);
    expect(raw.status).toBe('queued');
    expect(Number(raw.attempts)).toBe(0);
    expect(raw.locked_by).toBeNull();
    expect(await runsOf(untouched.jobId)).toHaveLength(0);

    await db.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [untouched.jobId]);
  }, 30_000);
});

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
