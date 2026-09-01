/**
 * Движок фоновых задач и его устойчивость — на настоящей PostgreSQL (§12).
 *
 * Проверяется поведение, а не наличие модулей. Прямое следствие урока S3: слой
 * наблюдаемости был написан, покрыт зелёными тестами и НЕ подключён, потому что
 * тесты звали модули напрямую. Поэтому здесь везде, где это возможно:
 *
 * - задачи исполняет настоящий `JobRunner` с настоящим захватом
 *   `FOR UPDATE SKIP LOCKED`, а не прямой вызов обработчика;
 * - reaper вызывается методом раннера (`runMaintenanceOnce`), а не функцией
 *   репозитория: проверяется, что раннер её действительно зовёт;
 * - ручной повтор идёт через HTTP-консоль собранного `buildApp()`, то есть через
 *   то, что зарегистрировано в `app.ts`;
 * - после каждого «вернули в очередь» задача обязана быть РЕАЛЬНО подхвачена
 *   следующим проходом. Проверка одного лишь `status = 'queued'` доказывала бы,
 *   что строка изменилась, а не что конвейер поехал.
 *
 * ## Чего здесь проверить нельзя
 *
 * Истинную конкурентность двух воркеров. pglite одноконнектна (ADR-0002):
 * «два воркера не получают одну задачу» на ней невыразимо в принципе, а
 * имитация двух воркеров одним соединением была бы зелёным тестом, ничего не
 * проверяющим — то есть хуже пропущенного. Такой тест вынесен в отдельный
 * `describe.skipIf` и исполняется только при заданном `TEST_DATABASE_URL`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPgliteDatabase,
  hasRealPostgres,
  type TestDatabase,
  createTestPool,
} from '@id/db-harness';
import { closePool, createPool } from '@id/db';
import { applyMigrations, loadMigrations, type SqlExecutor } from '@id/migrator';

import { buildApp, type AppInstance } from '../app.js';
import type { AuthScope } from '../auth/scope.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../auth/session.js';
import { loadEnv } from '../config/env.js';
import { NoopErrorReporter } from '../observability/errors.js';
import { createLogger } from '../observability/logger.js';
import { createMetrics } from '../observability/metrics.js';
import {
  claimJobs,
  computeProcessingStatus,
  enqueueSystemJob,
  findJob,
} from '../db/repositories/jobs.js';
import { RdWebError } from '../integrations/rdweb/port.js';
import {
  LlmBudgetError,
  LlmProtocolError,
  LlmRateLimitError,
  LlmTimeoutError,
} from '../llm/port.js';
import { JobRegistry, type JobContext } from './registry.js';
import { classifyFailure, deferralOf, JobDeferredError, JobRunner } from './runner.js';
import { dedupeKeyFor } from './types.js';

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

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR_A = id(2);
const ORG_CONTRACTOR_B = id(3);
const OBJECT = id(4);

const SUBMISSION_A = id(10);
/** Основная ревизия: очередь, повторы, dead, reaper, ручной повтор. */
const REVISION_A = id(11);
const SUBMISSION_B = id(12);
/** Ревизия чужого подрядчика: изоляция сводки обработки. */
const REVISION_B = id(13);
const SUBMISSION_C = id(14);
/** Отдельная ревизия под сводку: её ленту задач не засоряют прочие тесты. */
const REVISION_C = id(15);

const USER_ADMIN = id(20);
const USER_CONTRACTOR_A = id(21);

const KC = { admin: 'kc-runner-admin', contractorA: 'kc-runner-contractor-a' } as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'RUN01', 'Объект', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,

  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR_A}', '${KC.contractorA}', 'Сотрудник А', '${ORG_CONTRACTOR_A}')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR_A}', 'contractor')`,

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
     VALUES ('${SUBMISSION_B}', '${OBJECT}', '${ORG_CONTRACTOR_B}', '${ORG_CONTRACTOR_B}', 'roofing', DATE '2026-01-01', 'Комплект Б', '${USER_ADMIN}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_B}', '${SUBMISSION_B}', '${OBJECT}', '${ORG_CONTRACTOR_B}', 1)`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_C}', '${OBJECT}', '${ORG_CONTRACTOR_A}', '${ORG_CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Комплект А-2', '${USER_CONTRACTOR_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_C}', '${SUBMISSION_C}', '${OBJECT}', '${ORG_CONTRACTOR_A}', 1)`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-runner-tests-01234567890',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/runner-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-runner-tests',
  RATE_LIMIT_MAX: '100000',
});

/**
 * Откат для тестов: разброс снят, база мала, множитель крупный.
 *
 * Множитель 4, а не 2, взят намеренно: при базе 200 мс вторая задержка равна
 * 800 мс, и её невозможно спутать ни с линейным ростом, ни с постоянной паузой.
 * Разброс `jitter: 0` — иначе проверка сравнивала бы случайные числа. Сам разброс
 * и потолок проверяются на чистой функции `backoffDelayMs` (`engine.test.ts`).
 */
const TEST_BACKOFF = { baseMs: 200, factor: 4, capMs: 10_000, jitter: 0 } as const;

let db: TestDatabase;
let app: AppInstance;
let runner: JobRunner;

/** Что делает обработчик — задаёт тест: очередь одна, поведение разное. */
const behaviours = new Map<string, (ctx: JobContext) => Promise<void>>();

const ADMIN_SCOPE: AuthScope = { kind: 'admin', userId: USER_ADMIN };
const CONTRACTOR_A_SCOPE: AuthScope = {
  kind: 'contractor',
  userId: USER_CONTRACTOR_A,
  contractorId: ORG_CONTRACTOR_A,
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

  const registry = new JobRegistry();
  const dispatch = async (ctx: JobContext): Promise<void> => {
    const behaviour = behaviours.get(ctx.jobId);
    if (behaviour !== undefined) await behaviour(ctx);
  };
  // Настоящие типы конвейера: обработчики стадий появятся на своих этапах,
  // а поведение здесь подменяется по идентификатору задачи.
  registry.register('bundle.build', dispatch);
  registry.register('graph.build', dispatch);
  registry.register('checks.run', dispatch);
  registry.register('doc.classify_pages', dispatch);

  runner = new JobRunner({
    db: app.db,
    registry,
    logger: createLogger({ service: 'runner-test', level: 'silent', env: 'test' }),
    metrics: createMetrics({ enabled: false, service: 'runner-test' }),
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-runner-test',
    backoff: TEST_BACKOFF,
  });
}, 180_000);

afterAll(async () => {
  await runner.stop();
  await app.close();
  await db.close();
});

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
    `SELECT * FROM job_runs WHERE job_id = $1 ORDER BY attempt, started_at`,
    [jobId],
  );
}

/**
 * Пауза перед следующей попыткой, как её записала БД.
 *
 * `failJob` ставит `next_run_at = now() + задержка` и `updated_at = now()` одним
 * оператором, поэтому оба `now()` — это время транзакции, и разность равна
 * ровно вычисленной задержке. Ждать эти паузы в тесте незачем: проверяется
 * записанное значение, а не работа таймера.
 */
async function retryDelayMsOf(jobId: string): Promise<number> {
  const rows = await db.query<{ delay_ms: string | number }>(
    `SELECT extract(epoch from (next_run_at - updated_at)) * 1000 AS delay_ms
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  return Number(rows[0]?.delay_ms ?? Number.NaN);
}

/** Задача становится доступной немедленно: экспоненциальный откат уже проверен. */
async function makeRunnable(jobId: string): Promise<void> {
  await db.query(`UPDATE jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [
    jobId,
  ]);
}

/** Все ожидающие задачи снимаются: следующий тест начинает с чистой очереди. */
async function drainQueue(): Promise<void> {
  await db.query(`UPDATE jobs SET status = 'cancelled' WHERE status IN ('queued', 'running')`);
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
// Вход в портал (для консоли задач)
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
// Исполнение и журнал попыток
// =====================================================================

describe('исполнение задачи', () => {
  it('пишет попытку с номером, длительностью и сквозным request_id', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A, request_id: 'req-runner-ok' },
    });

    let seenAttempt = 0;
    behaviours.set(enqueued.jobId, async (ctx) => {
      seenAttempt = ctx.attempt;
      // Обработчик занимает измеримое время: `duration_ms >= 0` было бы верно и
      // для попытки, о которой ничего не записали.
      await pause(15);
    });

    const claimed = await runner.runOnce();
    expect(claimed).toBeGreaterThan(0);
    expect(seenAttempt).toBe(1);

    const job = await rawJob(enqueued.jobId);
    expect(job['status']).toBe('done');
    expect(job['attempts']).toBe(1);
    expect(job['locked_by']).toBeNull();
    expect(job['locked_until']).toBeNull();

    const runs = await runsOf(enqueued.jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.['outcome']).toBe('succeeded');
    expect(runs[0]?.['attempt']).toBe(1);
    expect(runs[0]?.['finished_at']).not.toBeNull();
    expect(Number(runs[0]?.['duration_ms'])).toBeGreaterThan(0);
    // Сквозной идентификатор доехал от постановщика до журнала попыток (§11).
    expect(runs[0]?.['request_id']).toBe('req-runner-ok');
    expect(runs[0]?.['payload_digest']).toMatch(/^[0-9a-f]{64}$/);
    expect(runs[0]?.['revision_id']).toBe(REVISION_A);

    await drainQueue();
  });

  it('повторная постановка с тем же dedupe_key не создаёт вторую задачу', async () => {
    const key = dedupeKeyFor('graph.build', REVISION_A, 'dedupe');

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

    const rows = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE dedupe_key = $1`,
      [key],
    );
    expect(rows[0]?.count).toBe(1);

    // Ключ частичный и действует, пока задача не завершена: после успешного
    // прогона та же работа обязана ставиться снова, иначе повторная подача
    // комплекта после возврата ревизии не запустила бы конвейер вовсе (§12).
    await runner.runOnce();
    expect((await rawJob(first.jobId))['status']).toBe('done');

    const third = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A },
      dedupeKey: key,
    });
    expect(third.created).toBe(true);
    expect(third.jobId).not.toBe(first.jobId);

    await drainQueue();
  });
});

// =====================================================================
// Повторы и dead
// =====================================================================

describe('повторы упавшей задачи', () => {
  it('переносит попытку с экспоненциально растущей задержкой', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 4,
    });
    behaviours.set(enqueued.jobId, () => Promise.reject(new Error('внешний сервис не ответил')));

    await runner.runOnce();
    const afterFirst = await rawJob(enqueued.jobId);
    expect(afterFirst['status']).toBe('queued');
    expect(afterFirst['attempts']).toBe(1);
    expect(afterFirst['locked_by']).toBeNull();
    expect(String(afterFirst['last_error'])).toContain('внешний сервис не ответил');
    const delay1 = await retryDelayMsOf(enqueued.jobId);

    await makeRunnable(enqueued.jobId);
    await runner.runOnce();
    expect((await rawJob(enqueued.jobId))['attempts']).toBe(2);
    const delay2 = await retryDelayMsOf(enqueued.jobId);

    await makeRunnable(enqueued.jobId);
    await runner.runOnce();
    expect((await rawJob(enqueued.jobId))['attempts']).toBe(3);
    const delay3 = await retryDelayMsOf(enqueued.jobId);

    // Значения записаны БД, а не вычислены тестом заново: сравнение с
    // `backoffDelayMs` здесь означало бы сверку функции с самой собой.
    expect(Math.round(delay1)).toBe(TEST_BACKOFF.baseMs);
    expect(Math.round(delay2)).toBe(TEST_BACKOFF.baseMs * TEST_BACKOFF.factor);
    expect(Math.round(delay3)).toBe(TEST_BACKOFF.baseMs * TEST_BACKOFF.factor ** 2);
    // Рост именно экспоненциальный: у линейного отката эта проверка красная.
    expect(delay3 - delay2).toBeGreaterThan(delay2 - delay1);

    const runs = await runsOf(enqueued.jobId);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run['outcome'] === 'failed')).toBe(true);
    expect(runs.map((run) => run['attempt'])).toEqual([1, 2, 3]);

    await drainQueue();
  });

  it('после max_attempts уходит в dead и больше не берётся', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 2,
    });
    behaviours.set(enqueued.jobId, () => Promise.reject(new Error('внешний сервис не ответил')));

    await runner.runOnce();
    await makeRunnable(enqueued.jobId);
    await runner.runOnce();

    const dead = await rawJob(enqueued.jobId);
    expect(dead['status']).toBe('failed');
    expect(dead['attempts']).toBe(2);
    expect(dead['locked_by']).toBeNull();

    // Мёртвая задача видна в консоли: без этого она молча исчезла бы из работы.
    const view = await findJob(app.db, ADMIN_SCOPE, enqueued.jobId);
    expect(view?.isDead).toBe(true);

    // Дальше — главное: задача обязана не браться СНОВА, даже когда время
    // запуска уже наступило. Проверяется и напрямую (захват ничего не отдаёт),
    // и наблюдаемым следствием (ни новой попытки, ни изменения счётчика).
    await makeRunnable(enqueued.jobId);
    const claimed = await claimJobs(app.db, {
      workerId: 'worker-runner-test',
      types: ['checks.run'],
      limit: 10,
      leaseMs: 60_000,
    });
    expect(claimed.some((job) => job.jobId === enqueued.jobId)).toBe(false);

    await runner.runOnce();
    const still = await rawJob(enqueued.jobId);
    expect(still['status']).toBe('failed');
    expect(still['attempts']).toBe(2);
    expect(await runsOf(enqueued.jobId)).toHaveLength(2);

    await drainQueue();
  });

  /**
   * Причина отказа базы обязана дойти до журнала, а не остаться под обёрткой.
   *
   * Drizzle заворачивает любую ошибку драйвера в `DrizzleQueryError`, у которого
   * `message` — дамп SQL и параметров, а настоящий отказ лежит в `cause`. Пока
   * читался только верхний уровень, вся длина `normalizeErrorMessage()` уходила
   * на текст запроса, и в `jobs.last_error` оставалось «упал вот такой INSERT»
   * без слова о том, что именно отвергла база. Проверяется поэтому не наличие
   * поля, а то, что имя нарушенного ограничения ЧИТАЕТСЯ после усечения.
   */
  it('причина ошибки БД доходит до журнала из-под обёртки Drizzle', async () => {
    const failing = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 1,
    });

    // Форма ровно как у настоящей обёртки: длинный запрос сверху, отказ снизу.
    const query = `insert into "source_pages" (${'"col", '.repeat(40)}"last")`;
    const driverError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "source_pages_revision_ordinal_uq"',
      ),
      { code: '23505', constraint: 'source_pages_revision_ordinal_uq' },
    );
    const wrapper = new Error(
      `Failed query: ${query}
params: 1,2,3`,
      { cause: driverError },
    );

    behaviours.set(failing.jobId, () => Promise.reject(wrapper));

    await runner.runOnce();

    const dead = await rawJob(failing.jobId);
    expect(dead['status']).toBe('failed');

    const recorded = String(dead['last_error']);
    // Имя ограничения сохраняется целиком: `normalizeErrorMessage()` бережёт
    // идентификатор схемы после слова `constraint`, и это тот случай, ради
    // которого исключение и заведено.
    expect(recorded).toContain('source_pages_revision_ordinal_uq');
    expect(recorded).toContain('unique constraint');
    // Причина стоит ПЕРВОЙ: усечение режет хвост, и порядок здесь — не вкус.
    expect(recorded.indexOf('unique constraint')).toBeLessThan(
      recorded.indexOf('Failed query') === -1
        ? Number.MAX_SAFE_INTEGER
        : recorded.indexOf('Failed query'),
    );

    const runs = await runsOf(failing.jobId);
    expect(String(runs[0]?.['error_message'])).toContain('source_pages_revision_ordinal_uq');

    await drainQueue();
  });

  /**
   * Отказ по существу запроса повторять нечем: пять попыток на 401 — это пять
   * одинаковых входов служебного аккаунта при отозванном доступе. Решение о
   * повторе теперь принимает `RdWebError.retriable`, а не «повторяем всё».
   */
  it('4xx от RD WEB уходит в dead с первой попытки, 5xx повторяется', async () => {
    const denied = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 5,
    });
    behaviours.set(denied.jobId, () =>
      Promise.reject(
        new RdWebError('RD WEB ответил 401', { status: 401, operation: 'document_read' }),
      ),
    );

    await runner.runOnce();
    const dead = await rawJob(denied.jobId);
    expect(dead['status']).toBe('failed');
    expect(dead['attempts']).toBe(1);

    // Статус сохранён в КЛАССЕ ошибки: `normalizeErrorMessage()` вычёркивает из
    // текста все числа, и в `error_message` от «401» остаётся «<n>».
    const deniedRuns = await runsOf(denied.jobId);
    expect(deniedRuns[0]?.['error_class']).toBe('RdWebError:401');
    expect(String(deniedRuns[0]?.['error_message'])).not.toContain('401');

    // Положительный контроль: преходящий отказ по-прежнему повторяется, иначе
    // ремонт превратил бы минутную недоступность в отказ поставки.
    const flaky = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 5,
    });
    behaviours.set(flaky.jobId, () =>
      Promise.reject(
        new RdWebError('RD WEB ответил 503', { status: 503, operation: 'document_read' }),
      ),
    );

    await runner.runOnce();
    const queued = await rawJob(flaky.jobId);
    expect(queued['status']).toBe('queued');
    expect(queued['attempts']).toBe(1);
    expect((await runsOf(flaky.jobId))[0]?.['error_class']).toBe('RdWebError:503');

    behaviours.set(flaky.jobId, () => Promise.resolve());
    await makeRunnable(flaky.jobId);
    await runner.runOnce();
    expect((await rawJob(flaky.jobId))['status']).toBe('done');

    await drainQueue();
  });

  /**
   * Классификация задаётся САМИМ классом отказа, а не перечислением в движке.
   *
   * Перечисление и есть способ, которым дефект возвращается: первая редакция
   * знала только `RdWebError`, и появившиеся на S8 `SegmentationStateError`,
   * `LlmBudgetError`, `LlmTimeoutError` все оказались повторяемыми. Тест
   * пользуется классами, о которых `runner.ts` не знает НИЧЕГО, — если правило
   * снова станет перечислением, он покраснеет.
   */
  it('повторяемость читается у класса отказа, а не перечисляется в движке', () => {
    class NewPermanentFailure extends Error {
      readonly retriable = false;
      constructor() {
        super('класс отказа, о котором движок не знает');
        this.name = 'NewPermanentFailure';
      }
    }
    class NewTransientFailure extends Error {
      readonly retriable = true;
      readonly status: number | undefined = 502;
      constructor() {
        super('преходящий отказ');
        this.name = 'NewTransientFailure';
      }
    }

    expect(classifyFailure(new NewPermanentFailure())).toEqual({
      errorClass: 'NewPermanentFailure',
      permanent: true,
    });
    // Статус уточняет класс у любого отказа, а не только у RD WEB.
    expect(classifyFailure(new NewTransientFailure())).toEqual({
      errorClass: 'NewTransientFailure:502',
      permanent: false,
    });

    // Отказ, ничего о себе не сообщивший, остаётся повторяемым: молчание не
    // должно превращаться в тихий отказ от повтора там, где повтор помогает.
    expect(classifyFailure(new Error('просто ошибка'))).toEqual({
      errorClass: 'Error',
      permanent: false,
    });
  });

  /**
   * Исчерпанный бюджет и таймаут — разные вещи, и повторять их одинаково
   * неверно в обе стороны: бюджет от повтора не восстановится, а таймаут
   * внешний и преходящий.
   */
  it('бюджет LLM неповторяем, таймаут и лимит частоты — повторяемы', () => {
    expect(
      classifyFailure(new LlmBudgetError('бюджет исчерпан', { spent: 10, budget: 10 })).permanent,
    ).toBe(true);
    expect(classifyFailure(new LlmTimeoutError(30_000, 'провайдер молчит')).permanent).toBe(false);
    expect(classifyFailure(new LlmRateLimitError('слишком часто')).permanent).toBe(false);
    expect(classifyFailure(new LlmProtocolError('ответ не разобрался')).permanent).toBe(true);
  });
});

// =====================================================================
// Отсрочка: «работы ещё нет», а не «работа не получилась»
// =====================================================================

/**
 * Регрессия на картину, с которой заказчик пришёл: «сразу при клике появляются
 * ошибки… но потом распознавание проходит успешно».
 *
 * Поллер `vlm.finalize_run` ждал терминальности страниц броском повторяемой
 * ошибки, а исход попытки был один — `failed`. Минута нормального ожидания
 * давала двенадцать строк отказа, текст «Распознавание ещё идёт» в
 * `jobs.last_error` и плашку «Обработка остановилась: отказов 12» на конвейере,
 * который в эту секунду работал.
 */
describe('отложенная задача', () => {
  it('пишет попытку исходом deferred и не оставляет текста ошибки', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 5,
    });
    behaviours.set(enqueued.jobId, () =>
      Promise.reject(new JobDeferredError('страницы ещё не дописаны')),
    );

    await runner.runOnce();

    const job = await rawJob(enqueued.jobId);
    expect(job['status']).toBe('queued');
    expect(job['attempts']).toBe(1);
    // Поле читается как «почему не получилось»: ожидание в нём означало бы,
    // что идущая работа — причина неудачи.
    expect(job['last_error']).toBeNull();

    const runs = await runsOf(enqueued.jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.['outcome']).toBe('deferred');
    // Ни класса, ни текста: сообщать не о чем, а заполненные поля утащили бы
    // отсрочку в «последнюю ошибку» типа задачи.
    expect(runs[0]?.['error_class']).toBeNull();
    expect(runs[0]?.['error_message']).toBeNull();

    behaviours.delete(enqueued.jobId);
    await drainQueue();
  });

  it('на последней попытке становится настоящим отказом', async () => {
    // Иначе задача, откладывающая себя безусловно, осталась бы в очереди
    // навсегда, а прогон — в состоянии «идёт». Потолок и превращает «ждём» в
    // «не дождались»: по нему обработчики закрывают свой прогон.
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 2,
    });
    behaviours.set(enqueued.jobId, () =>
      Promise.reject(new JobDeferredError('условие так и не наступило')),
    );

    await runner.runOnce();
    expect((await rawJob(enqueued.jobId))['status']).toBe('queued');

    await makeRunnable(enqueued.jobId);
    await runner.runOnce();

    const job = await rawJob(enqueued.jobId);
    expect(job['status']).toBe('failed');
    expect(String(job['last_error'])).toContain('условие так и не наступило');

    const runs = await runsOf(enqueued.jobId);
    expect(runs.map((run) => run['outcome'])).toEqual(['deferred', 'failed']);
  });

  it('отсрочка узнаётся по форме поля, а не по классу', () => {
    // Обработчики живут в пакете воркера, и `instanceof` через границу пакетов
    // ломается при дублировании зависимости молча — причём в сторону «отсрочка
    // записана как отказ», то есть ровно в ту, ради которой всё заведено.
    expect(deferralOf({ deferred: true })).toEqual({ retryAfterMs: null });
    expect(deferralOf({ deferred: true, retryAfterMs: 1_500 })).toEqual({ retryAfterMs: 1_500 });
    expect(deferralOf(new JobDeferredError('ждём'))).toEqual({ retryAfterMs: null });

    // Всё остальное отсрочкой не является, включая повторяемый отказ: «повторить
    // потому что не получилось» и «повторить потому что ещё рано» — разные факты.
    expect(deferralOf(new Error('обычная ошибка'))).toBeNull();
    expect(deferralOf({ retriable: true })).toBeNull();
    expect(deferralOf({ deferred: 'yes' })).toBeNull();
    expect(deferralOf(null)).toBeNull();
  });
});

// =====================================================================
// Освобождение просроченной аренды
// =====================================================================

describe('reaper', () => {
  it('освобождает аренду убитого воркера, и задача снова исполняется', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A },
    });

    /**
     * Убитый воркер: задача занята, аренда истекла, попытка не закрыта.
     *
     * Именно так выглядит SIGKILL или OOM — процесс не успевает ничего
     * освободить. Отказ не виден снаружи: очередь не растёт, ошибок нет,
     * конвейер стоит.
     */
    await db.query(
      `UPDATE jobs SET status = 'running', locked_by = 'worker-killed',
              locked_until = now() - interval '1 minute', attempts = 1
        WHERE id = $1`,
      [enqueued.jobId],
    );
    await db.query(
      `INSERT INTO job_runs (job_id, job_type, revision_id, attempt, started_at)
       VALUES ($1, 'graph.build', $2, 1, now() - interval '2 minutes')`,
      [enqueued.jobId, REVISION_A],
    );

    // До освобождения задача не берётся никем: статус `running` — это чужая
    // аренда, и обходить её захватом было бы двойным исполнением.
    expect(await runner.runOnce()).toBe(0);
    expect((await rawJob(enqueued.jobId))['status']).toBe('running');

    const before = await rawJob(enqueued.jobId);

    // Reaper вызывается МЕТОДОМ раннера, а не функцией репозитория: проверяется,
    // что раннер её действительно зовёт (урок S3).
    await runner.runMaintenanceOnce();

    const freed = await rawJob(enqueued.jobId);
    expect(freed['status']).toBe('queued');
    expect(freed['locked_by']).toBeNull();
    expect(freed['locked_until']).toBeNull();

    /**
     * Молчаливая смерть воркера не тратит бюджет попыток (S41).
     *
     * До S41 три таких смерти убивали задачу, ни разу её не выполнив, а мёртвая
     * задача держит `dedupe_key` — и повторное нажатие кнопки стадии молча не
     * ставило ничего. Поэтому потраченный при захвате квант возвращается
     * прибавкой к потолку, а сами потери считаются отдельно.
     */
    expect(freed['lease_expiries']).toBe(1);
    expect(Number(freed['max_attempts'])).toBe(Number(before['max_attempts']) + 1);

    // Повтор не мгновенный: воркер, которого только что убил OOM, поднимается
    // не сразу, и немедленный заход пришёлся бы ровно на больную машину.
    expect(await runner.runOnce()).toBe(0);
    await makeRunnable(enqueued.jobId);

    const closed = await runsOf(enqueued.jobId);
    expect(closed).toHaveLength(1);
    // Не `failed`: задача, возможно, отработала целиком и умерла на записи
    // результата. Считать падение воркера дефектом задачи нельзя (§3.8).
    expect(closed[0]?.['outcome']).toBe('lease_expired');
    expect(Number(closed[0]?.['duration_ms'])).toBeGreaterThan(0);

    let executed = false;
    behaviours.set(enqueued.jobId, () => {
      executed = true;
      return Promise.resolve();
    });

    expect(await runner.runOnce()).toBeGreaterThan(0);
    expect(executed).toBe(true);

    const done = await rawJob(enqueued.jobId);
    expect(done['status']).toBe('done');
    // Счётчик попыток сплошной: освобождение аренды не обнуляет историю.
    expect(done['attempts']).toBe(2);
    const runs = await runsOf(enqueued.jobId);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.['outcome']).toBe('succeeded');
    expect(runs[1]?.['attempt']).toBe(2);

    await drainQueue();
  });

  it('задача, роняющая воркер раз за разом, уходит к человеку с названной причиной', async () => {
    // Обратная сторона щедрости к потерянным арендам: страница-гигант, не
    // влезающая в память, убила бы воркер, вернулась в очередь и убила
    // следующий — вечно. Потолок молчаливых смертей эту петлю размыкает, и
    // текст отказа обязан отличать её от обычного падения: «падает пять раз с
    // ошибкой» и «пять раз убивает процесс» чинятся разным.
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_A },
      dedupeKey: `poison:${Date.now()}`,
    });

    await db.query(
      `UPDATE jobs SET status = 'running', locked_by = 'worker-oom',
              locked_until = now() - interval '1 minute', attempts = 1,
              lease_expiries = 4
        WHERE id = $1`,
      [enqueued.jobId],
    );

    await runner.runMaintenanceOnce();

    const dead = await rawJob(enqueued.jobId);
    expect(dead['status']).toBe('failed');
    expect(dead['lease_expiries']).toBe(5);
    expect(String(dead['last_error'])).toContain('роняет воркер');

    await drainQueue();
  });
});

// =====================================================================
// Ручной повтор из консоли
// =====================================================================

describe('консоль задач', () => {
  it('ручной повтор возвращает dead-задачу в очередь, и она исполняется', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_A },
      maxAttempts: 1,
    });
    behaviours.set(enqueued.jobId, () => Promise.reject(new Error('внешний сервис не ответил')));

    await runner.runOnce();
    expect((await rawJob(enqueued.jobId))['status']).toBe('failed');

    const admin = await sessionFor(KC.admin);
    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/${enqueued.jobId}/retry`,
      headers: { cookie: admin.cookie, [CSRF_HEADER]: admin.csrfToken },
    });

    expect(retried.statusCode).toBe(200);
    const body = retried.json() as { status: string; attempts: number; maxAttempts: number };
    expect(body.status).toBe('queued');
    // Потолок поднят на одну, счётчик не обнулён: иначе «задача падала шесть
    // раз» станет неотличимо от «выполняется впервые».
    expect(body.attempts).toBe(1);
    expect(body.maxAttempts).toBe(2);

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_type = 'job' AND entity_id = $1`,
      [enqueued.jobId],
    );
    expect(audit.map((row) => row.action)).toContain('job.retried');

    // Возврат в очередь проверяется исполнением, а не строкой статуса.
    let executed = false;
    behaviours.set(enqueued.jobId, () => {
      executed = true;
      return Promise.resolve();
    });
    expect(await runner.runOnce()).toBeGreaterThan(0);
    expect(executed).toBe(true);

    const done = await rawJob(enqueued.jobId);
    expect(done['status']).toBe('done');
    expect(done['attempts']).toBe(2);
    const runs = await runsOf(enqueued.jobId);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run['outcome'])).toEqual(['failed', 'succeeded']);

    await drainQueue();
  });

  it('повтор недоступен подрядчику и не находит чужую задачу', async () => {
    const enqueued = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_B },
    });

    const contractor = await sessionFor(KC.contractorA);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/${enqueued.jobId}/retry`,
      headers: { cookie: contractor.cookie, [CSRF_HEADER]: contractor.csrfToken },
    });
    // 403 по праву: `settings.manage` подрядчику не выдано. Область видимости —
    // второй рубеж, и он проверяется репозиторием отдельно.
    expect(denied.statusCode).toBe(403);
    expect(await findJob(app.db, CONTRACTOR_A_SCOPE, enqueued.jobId)).toBeNull();

    await drainQueue();
  });
});

// =====================================================================
// Вычисляемая сводка обработки (§3.8)
// =====================================================================

describe('processing_status ревизии', () => {
  /** Ревизия до первой задачи: значения запоминаются, чтобы сверить неизменность. */
  let revisionBefore: Record<string, unknown>;

  beforeAll(async () => {
    await drainQueue();
    const rows = await db.query<Record<string, unknown>>(
      `SELECT version, updated_at, status FROM submission_revisions WHERE id = $1`,
      [REVISION_C],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('ревизия фикстуры не найдена');
    revisionBefore = row;
  });

  it('в submission_revisions нет колонки processing_status', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'submission_revisions' AND column_name = 'processing_status'`,
    );
    expect(columns).toHaveLength(0);
  });

  it('сводит «готово / упало / идёт» в одну картину и меняется вслед за job_runs', async () => {
    // 1. «Готово»: стадия uploaded отработала успешно.
    const ready = await enqueueSystemJob(app.db, {
      type: 'bundle.build',
      payload: { revisionId: REVISION_C },
    });
    behaviours.set(ready.jobId, () => Promise.resolve());
    await runner.runOnce();
    expect((await rawJob(ready.jobId))['status']).toBe('done');

    // 2. «Упало»: стадия checks исчерпала единственную попытку.
    const broken = await enqueueSystemJob(app.db, {
      type: 'checks.run',
      payload: { revisionId: REVISION_C },
      maxAttempts: 1,
    });
    behaviours.set(broken.jobId, () => Promise.reject(new Error('правило не отработало')));
    await runner.runOnce();
    expect((await rawJob(broken.jobId))['status']).toBe('failed');

    // 3. «Идёт»: стадия analysis удерживается внутри обработчика. Попытка при
    //    этом настоящая — строка `job_runs` открыта, аренда взята.
    const running = await enqueueSystemJob(app.db, {
      type: 'graph.build',
      payload: { revisionId: REVISION_C },
    });
    let entered = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    behaviours.set(running.jobId, async () => {
      entered = true;
      await gate;
    });

    const pumping = runner.runOnce();
    await waitUntil(() => entered);

    const inFlight = await computeProcessingStatus(app.db, ADMIN_SCOPE, REVISION_C);
    expect(inFlight).not.toBeNull();
    if (inFlight === null) return;

    expect(inFlight.running).toBe(1);
    expect(inFlight.dead).toBe(1);
    expect(inFlight.attempts).toBe(3);

    const byType = new Map(inFlight.jobTypes.map((summary) => [summary.jobType, summary]));
    expect(byType.get('bundle.build')).toMatchObject({ succeeded: 1, failed: 0, inFlight: 0 });
    expect(byType.get('checks.run')).toMatchObject({ succeeded: 0, failed: 1, inFlight: 0 });
    expect(byType.get('graph.build')).toMatchObject({ succeeded: 0, failed: 0, inFlight: 1 });
    expect(byType.get('checks.run')?.lastErrorClass).toBe('Error');
    // `dead` считает ЗАДАЧИ, исчерпавшие попытки, а `failed` — попытки. Плашка
    // конвейера обязана называть виновником первое: пять неудачных попыток
    // задачи, которая потом прошла, — это работающий конвейер.
    expect(byType.get('checks.run')?.dead).toBe(1);
    expect(byType.get('bundle.build')?.dead).toBe(0);
    expect(byType.get('graph.build')?.dead).toBe(0);

    const byStage = new Map(inFlight.stages.map((summary) => [summary.stage, summary]));
    expect([...byStage.keys()]).toEqual(['uploaded', 'analysis', 'checks']);
    expect(byStage.get('uploaded')).toMatchObject({ succeeded: 1, pending: 0 });
    expect(byStage.get('analysis')).toMatchObject({ inFlight: 1, pending: 1 });
    expect(byStage.get('checks')).toMatchObject({ failed: 1, pending: 0 });
    // Мёртвая задача важнее любой активности: комплект не «на анализе», он стоит.
    expect(inFlight.stage).toBe('failed');

    release();
    await pumping;

    const afterRelease = await computeProcessingStatus(app.db, ADMIN_SCOPE, REVISION_C);
    expect(afterRelease?.running).toBe(0);
    expect(
      afterRelease?.jobTypes.find((summary) => summary.jobType === 'graph.build'),
    ).toMatchObject({ succeeded: 1, inFlight: 0 });
    expect(afterRelease?.attempts).toBe(3);
    expect(afterRelease?.stage).toBe('failed');
    expect(Number(afterRelease?.totalDurationMs)).toBeGreaterThan(0);

    // Убрали мёртвую задачу — сводка немедленно перестала быть `failed`, хотя в
    // `submission_revisions` не записано ни байта. Дальняя стадия с активностью
    // — `checks`: её попытка в `job_runs` осталась, и это верно.
    await db.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [broken.jobId]);
    const afterCancel = await computeProcessingStatus(app.db, ADMIN_SCOPE, REVISION_C);
    expect(afterCancel?.dead).toBe(0);
    expect(afterCancel?.stage).toBe('checks');

    // Ни одна из четырёх сводок не потребовала записи в ревизию: сводка — это
    // ВЫЧИСЛЕНИЕ над job_runs, а не хранимое поле.
    const revisionAfter = await db.query<Record<string, unknown>>(
      `SELECT version, updated_at, status FROM submission_revisions WHERE id = $1`,
      [REVISION_C],
    );
    expect(revisionAfter[0]).toEqual(revisionBefore);

    await drainQueue();
  }, 30_000);

  /**
   * Две поправки, каждая — на своё враньё сводки.
   *
   * «Последняя ошибка» бралась как «последний непустой текст», а текст пишет и
   * reaper, закрывая попытку исходом `lease_expired`: настоящая причина отказа
   * пряталась за словами «аренда истекла: воркер не завершил задачу». С
   * появлением отсрочек то же условие подставляло бы «Распознавание ещё идёт».
   *
   * А сводка по типам собиралась только из `job_runs`, поэтому мёртвая задача
   * без единой записанной попытки в неё не попадала: общая цифра `dead` росла,
   * а тип, который умер, не назывался — плашка печатала «Обработка
   * остановилась» и не могла сказать, на чём.
   */
  it('«последняя ошибка» — только настоящий отказ, а мёртвый тип назван всегда', async () => {
    const dead = await enqueueSystemJob(app.db, {
      type: 'doc.classify_pages',
      payload: { revisionId: REVISION_C },
      maxAttempts: 1,
    });
    behaviours.set(dead.jobId, () => Promise.reject(new Error('модель отвергла страницу')));
    await runner.runOnce();

    // Поверх настоящего отказа ложатся две попытки, отказом не являющиеся:
    // сорванная аренда с её текстом и отсрочка.
    await db.query(
      `INSERT INTO job_runs (job_type, revision_id, attempt, outcome, error_class, error_message, finished_at)
         VALUES ('doc.classify_pages', $1, 2, 'lease_expired', 'LeaseExpired',
                 'аренда истекла: воркер не завершил задачу', now())`,
      [REVISION_C],
    );
    await db.query(
      `INSERT INTO job_runs (job_type, revision_id, attempt, outcome, finished_at)
         VALUES ('doc.classify_pages', $1, 3, 'deferred', now())`,
      [REVISION_C],
    );

    // Мёртвая задача БЕЗ единой попытки: так уходят в failed непригодный
    // payload и неизвестный тип — строка `job_runs` заводится захватом.
    await db.query(
      `INSERT INTO jobs (type, payload, status, attempts, max_attempts, last_error)
         VALUES ('doc.extract_fields', $1::jsonb, 'failed', 0, 3, 'payload не прошёл схему')`,
      [JSON.stringify({ revisionId: REVISION_C })],
    );

    const status = await computeProcessingStatus(app.db, ADMIN_SCOPE, REVISION_C);
    const byType = new Map((status?.jobTypes ?? []).map((row) => [row.jobType, row]));

    const classify = byType.get('doc.classify_pages');
    expect(classify?.failed).toBe(1);
    expect(classify?.deferred).toBe(1);
    expect(classify?.leaseExpired).toBe(1);
    expect(classify?.lastErrorMessage).toContain('модель отвергла страницу');
    expect(classify?.lastErrorMessage).not.toContain('аренда истекла');

    // Тип есть в сводке, хотя попыток у него ноль.
    expect(byType.get('doc.extract_fields')).toMatchObject({ attempts: 0, dead: 1 });

    await db.query(`UPDATE jobs SET status = 'cancelled' WHERE payload->>'revisionId' = $1`, [
      REVISION_C,
    ]);
    await drainQueue();
  });

  it('не отдаётся за пределы области видимости', async () => {
    expect(await computeProcessingStatus(app.db, CONTRACTOR_A_SCOPE, REVISION_C)).not.toBeNull();
    // Подстановка чужого идентификатора: `null` — это 404 на маршруте, а не
    // «есть, но не ваша» (§16).
    expect(await computeProcessingStatus(app.db, CONTRACTOR_A_SCOPE, REVISION_B)).toBeNull();
    // Инженеру же состояние конвейера видно на любой ревизии: областей по
    // объектам больше нет (S37).
    const engineer: AuthScope = { kind: 'engineer', userId: USER_ADMIN };
    expect(await computeProcessingStatus(app.db, engineer, REVISION_C)).not.toBeNull();
  });
});

// =====================================================================
// Конкурентный захват: только настоящая PostgreSQL
// =====================================================================

/**
 * Два воркера никогда не получают одну задачу.
 *
 * На pglite это непроверяемо: у неё одно соединение (ADR-0002), поэтому два
 * «воркера» в одном процессе выполняли бы захват строго по очереди, и зелёный
 * результат означал бы отсутствие параллелизма, а не работу
 * `FOR UPDATE SKIP LOCKED`. Имитация здесь запрещена сознательно: зелёный тест,
 * не проверяющий конкурентность, хуже пропущенного — он закрывает вопрос,
 * оставляя дефект.
 *
 * Задачи взяты без ревизии (`storage.gc`): фикстура поставки для этой проверки
 * не нужна, а лента `revision_events` с её назначением `seq` внесла бы вторую
 * точку соперничества и размыла бы предмет теста.
 */
describe.skipIf(!hasRealPostgres())('конкурентный захват двумя воркерами', () => {
  const CONNECTION = process.env['TEST_DATABASE_URL'] ?? '';

  let poolA: Pool;
  let poolB: Pool;
  let runnerA: JobRunner;
  let runnerB: JobRunner;
  let doneByA = 0;
  let doneByB = 0;

  beforeAll(async () => {
    poolA = createPool({ connectionString: CONNECTION, max: 8, applicationName: 'runner-test-a' });
    poolB = createPool({ connectionString: CONNECTION, max: 8, applicationName: 'runner-test-b' });

    // Миграции — на выделенном соединении: `applyMigrations` открывает
    // транзакцию явными BEGIN/COMMIT, а пул разложил бы их по разным клиентам.
    const client = await poolA.connect();
    try {
      const executor: SqlExecutor = {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
          const result = await client.query(sql, params as unknown[] | undefined);
          return result.rows as T[];
        },
        async exec(sql: string): Promise<void> {
          await client.query(sql);
        },
      };
      await applyMigrations(executor, loadMigrations(MIGRATIONS_DIR));
    } finally {
      client.release();
    }

    // Чужие задачи того же типа сделали бы подсчёт неоднозначным.
    await poolA.query(
      `UPDATE jobs SET status = 'cancelled'
        WHERE type = 'storage.gc' AND status IN ('queued', 'running')`,
    );

    const build = (workerId: string, onDone: () => void): JobRunner => {
      const registry = new JobRegistry();
      registry.register('storage.gc', async () => {
        // Работа занимает время: мгновенный обработчик освобождал бы аренду
        // раньше, чем второй воркер дойдёт до захвата.
        await pause(5);
        onDone();
      });
      return new JobRunner({
        db: drizzle(workerId === 'concurrent-a' ? poolA : poolB),
        registry,
        logger: createLogger({ service: workerId, level: 'silent', env: 'test' }),
        metrics: createMetrics({ enabled: false, service: workerId }),
        errorReporter: new NoopErrorReporter(),
        workerId,
        pollIntervalMs: 10,
        backoff: TEST_BACKOFF,
      });
    };

    runnerA = build('concurrent-a', () => {
      doneByA += 1;
    });
    runnerB = build('concurrent-b', () => {
      doneByB += 1;
    });
  }, 180_000);

  afterAll(async () => {
    await runnerA.stop();
    await runnerB.stop();
    await poolA.query(
      `DELETE FROM job_runs WHERE job_id IN (SELECT id FROM jobs WHERE type = 'storage.gc')`,
    );
    await poolA.query(`DELETE FROM jobs WHERE type = 'storage.gc'`);
    await closePool(poolA);
    await closePool(poolB);
  });

  it('одновременный захват не отдаёт одну задачу двум воркерам', async () => {
    const dbA = drizzle(poolA);
    const dbB = drizzle(poolB);

    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const enqueued = await enqueueSystemJob(dbA, { type: 'storage.gc', payload: {} });
      ids.push(enqueued.jobId);
    }

    const [claimedA, claimedB] = await Promise.all([
      claimJobs(dbA, {
        workerId: 'race-a',
        types: ['storage.gc'],
        limit: 10,
        leaseMs: 60_000,
      }),
      claimJobs(dbB, {
        workerId: 'race-b',
        types: ['storage.gc'],
        limit: 10,
        leaseMs: 60_000,
      }),
    ]);

    const takenA = claimedA.map((job) => job.jobId);
    const takenB = claimedB.map((job) => job.jobId);
    const overlap = takenA.filter((jobId) => takenB.includes(jobId));

    expect(overlap).toEqual([]);
    expect(takenA.length + takenB.length).toBe(20);
    expect(new Set([...takenA, ...takenB]).size).toBe(20);
    // На каждую захваченную задачу — ровно одна открытая попытка: два воркера,
    // пишущих результат одной задачи, это гонка на уровне данных.
    const runs = await poolA.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM job_runs WHERE job_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(Number(runs.rows[0]?.count)).toBe(20);

    await poolA.query(`UPDATE jobs SET status = 'cancelled' WHERE id = ANY($1::uuid[])`, [ids]);
  }, 120_000);

  it('два работающих воркера исполняют каждую задачу ровно один раз', async () => {
    const dbA = drizzle(poolA);
    const total = 40;
    const ids: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const enqueued = await enqueueSystemJob(dbA, { type: 'storage.gc', payload: {} });
      ids.push(enqueued.jobId);
    }

    runnerA.start();
    runnerB.start();

    const deadline = Date.now() + 90_000;
    let finished = 0;
    while (finished < total) {
      if (Date.now() > deadline)
        throw new Error('воркеры не разобрали очередь за отведённое время');
      await pause(50);
      const rows = await poolA.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM jobs WHERE id = ANY($1::uuid[]) AND status = 'done'`,
        [ids],
      );
      finished = Number(rows.rows[0]?.count ?? 0);
    }

    await runnerA.stop();
    await runnerB.stop();

    const runs = await poolA.query<{ count: number; attempts: number }>(
      `SELECT count(*)::int AS count, max(attempt)::int AS attempts
         FROM job_runs WHERE job_id = ANY($1::uuid[])`,
      [ids],
    );
    // Ни одной лишней попытки: повторный захват уже захваченной задачи дал бы
    // вторую строку `job_runs` и вторую фактическую обработку.
    expect(Number(runs.rows[0]?.count)).toBe(total);
    expect(Number(runs.rows[0]?.attempts)).toBe(1);
    expect(doneByA + doneByB).toBe(total);
    // Работа действительно разделена: тест с простаивающим вторым воркером
    // ничего не сказал бы о конкурентности.
    expect(doneByA).toBeGreaterThan(0);
    expect(doneByB).toBeGreaterThan(0);
  }, 120_000);
});
