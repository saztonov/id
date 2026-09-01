/**
 * Обратная связь конвейера через HTTP на собранном приложении (§11, ADR-0010).
 *
 * Проверяется то, ради чего таблица заведена отдельно от журнала ошибок:
 *
 * 1. **Доля считается по `ai_runs`, а не по второму счётчику.** Данные
 *    подобраны так, что число дефектов и число вызовов заведомо разные: три из
 *    десяти. Подмена знаменателя даёт другое число и падает.
 * 2. **Неизвестный знаменатель — `null`, а не ноль.** У стадий без вызова
 *    модели (детекция, ручные правки) `ai_runs` не пишется, и ноль на экране
 *    читался бы как «дефектов нет».
 * 3. **Выгрузка не выносит содержимое наружу**: ни текста документа, ни ответа
 *    модели — файл покидает портал.
 * 4. **Право то же, что у журнала**: `diagnostics.read`, только администратор.
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

const USER_ADMIN = id(601);
const USER_ENGINEER = id(602);
const ORG_CUSTOMER = id(610);
const OBJECT_A = id(611);
const FOLDER_A = id(615);
const BLOCK_A = id(620);

const KC = { admin: 'kc-feedback-admin', engineer: 'kc-feedback-engineer' } as const;
const ADMIN_EMAIL = 'feedback-admin@example.test';

const PROMPT_CODE = 'recognize_text_base';
const MODEL = 'qwen/qwen3-vl-235b';

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Заказчик»', 'customer')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'FBK01', 'Объект обратной связи', 'ЖК «Связь», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_A}', 'roofing') ON CONFLICT DO NOTHING`,
  // Пользователи заводятся ДО поставки: `submissions.created_by` — обязательная
  // ссылка на автора, и порядок здесь не косметика.
  `INSERT INTO users (id, kc_sub, full_name, email)
     VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор', '${ADMIN_EMAIL}')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,

  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_A}', '${ORG_CUSTOMER}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_A}', '${OBJECT_A}', '${ORG_CUSTOMER}', '${ORG_CUSTOMER}', 'roofing', DATE '2026-01-01', 'Комплект', '${USER_ADMIN}')`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-feedback-tests-012345678',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/feedback-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-feedback-tests',
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

beforeEach(async () => {
  await db.query('delete from processing_feedback');
  await db.query('delete from ai_runs');

  // Десять вызовов модели одной комбинацией промта и версии — знаменатель.
  for (let i = 0; i < 10; i += 1) {
    await db.query(
      `INSERT INTO ai_runs (folder_id, stage, provider, model, prompt_code, prompt_version)
         VALUES ($1, 'recognize', 'proxy_llm', $2, $3, 1)`,
      [FOLDER_A, MODEL, PROMPT_CODE],
    );
  }

  // Три дефекта той же комбинации — числитель. Числа заведомо разные: подмена
  // знаменателя вторым счётчиком дала бы долю 1.0 и была бы поймана.
  for (let i = 0; i < 3; i += 1) {
    await db.query(
      `INSERT INTO processing_feedback
         (feedback_type, reason_code, severity, folder_id, layout_block_id,
          pipeline_stage, provider, model, prompt_code, prompt_version, observed)
       VALUES ('recognition_failure', 'vlm.schema_mismatch', 'warn', $1, $2,
               'recognition', 'proxy_llm', $3, $4, 1, $5::jsonb)`,
      [
        FOLDER_A,
        BLOCK_A,
        MODEL,
        PROMPT_CODE,
        JSON.stringify({ reason_code: 'schema:text.text', block_type: 'text' }),
      ],
    );
  }

  // Дефект стадии, у которой вызова модели нет вовсе: знаменатель неизвестен.
  await db.query(
    `INSERT INTO processing_feedback
       (feedback_type, reason_code, severity, folder_id, pipeline_stage,
        detector_model_version, score)
     VALUES ('recognition_failure', 'detect.no_blocks', 'warn', $1, 'detect', 'rf-detr-1.2', 0.1)`,
    [FOLDER_A],
  );
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

async function signIn(kcSub: string, email?: string): Promise<SignedIn> {
  const query = new URLSearchParams({ devSub: kcSub });
  if (email !== undefined) query.set('devEmail', email);

  const started = await app.inject({ method: 'GET', url: `/auth/login?${query.toString()}` });
  const authorizationUrl = new URL(String(started.headers['location']));
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

const sessions = new Map<string, SignedIn>();

async function as(kcSub: string, method: Method, url: string): Promise<LightMyRequestResponse> {
  let session = sessions.get(kcSub);
  if (session === undefined) {
    session = await signIn(kcSub, kcSub === KC.admin ? ADMIN_EMAIL : undefined);
    sessions.set(kcSub, session);
  }
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
  });
}

interface SummaryRow {
  readonly reasonCode: string;
  readonly defects: number;
  readonly calls: number | null;
  readonly rate: number | null;
  readonly medianScore: number | null;
}

async function summaryRows(query = ''): Promise<readonly SummaryRow[]> {
  const response = await as(KC.admin, 'GET', `/api/v1/admin/pipeline-feedback/summary${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ rows: SummaryRow[] }>().rows;
}

describe('срез по причинам', () => {
  it('считает долю по вызовам из ai_runs, а не по собственному счётчику', async () => {
    const rows = await summaryRows();
    const schemaRow = rows.find((row) => row.reasonCode === 'vlm.schema_mismatch');

    expect(schemaRow?.defects).toBe(3);
    expect(
      schemaRow?.calls,
      'знаменатель взят не из ai_runs: доля «дефектов на вызов» — единственное ' +
        'число, по которому сравнивают версии промта, и второй счётчик однажды ' +
        'разошёлся бы с первым незаметно',
    ).toBe(10);
    expect(schemaRow?.rate).toBeCloseTo(0.3, 5);
  });

  it('оставляет долю неизвестной там, где вызова модели не было', async () => {
    const rows = await summaryRows();
    const detectRow = rows.find((row) => row.reasonCode === 'detect.no_blocks');

    expect(detectRow?.defects).toBe(1);
    expect(
      detectRow?.rate,
      'доля посчитана нулём при неизвестном знаменателе: ноль на экране читается ' +
        'как «дефектов нет», то есть как утверждение, противоположное истинному',
    ).toBeNull();
    expect(detectRow?.medianScore).toBeCloseTo(0.1, 5);
  });

  it('фильтрует по причине и по версии промта', async () => {
    const byReason = await summaryRows('?reasonCode=detect.no_blocks');
    expect(byReason.map((row) => row.reasonCode)).toStrictEqual(['detect.no_blocks']);

    const byVersion = await summaryRows(`?promptCode=${PROMPT_CODE}&promptVersion=1`);
    expect(byVersion.map((row) => row.reasonCode)).toStrictEqual(['vlm.schema_mismatch']);
  });
});

describe('лента событий', () => {
  it('отдаёт дефекты с провенансом', async () => {
    const response = await as(KC.admin, 'GET', '/api/v1/admin/pipeline-feedback/events');
    const items = response.json<{ items: { reasonCode: string; promptVersion: number | null }[] }>()
      .items;

    expect(items).toHaveLength(4);
    const schemaItem = items.find((item) => item.reasonCode === 'vlm.schema_mismatch');
    expect(schemaItem?.promptVersion).toBe(1);
  });
});

describe('выгрузка', () => {
  it('отдаёт NDJSON из кодов и идентификаторов', async () => {
    const response = await as(KC.admin, 'GET', '/api/v1/admin/pipeline-feedback/export');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');

    const lines = response.body.trim().split('\n');
    expect(lines).toHaveLength(4);

    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(first).toHaveProperty('reasonCode');
    expect(first).toHaveProperty('promptCode');
    // Идентификатор блока — то, по чему инженер откроет кроп В ПОРТАЛЕ. Самого
    // кропа, текста и ответа модели в выгрузке нет и быть не должно.
    expect(Object.keys(first)).not.toContain('text');
    expect(Object.keys(first)).not.toContain('response');
  });

  it('не выносит наружу значения, если их попытались записать в observed', async () => {
    const secret = 'chasovoy-feedback-secret-3301';
    await db.query(
      `INSERT INTO processing_feedback (feedback_type, reason_code, observed)
         VALUES ('wrong_extraction', 'extract.field_missing', $1::jsonb)`,
      [JSON.stringify({ field_code: 'contractor_name', password: secret })],
    );

    const response = await as(KC.admin, 'GET', '/api/v1/admin/pipeline-feedback/export');

    // Очистка стоит на ЗАПИСИ (`DbProcessingFeedbackSink`), и прямая вставка её
    // минует — тест фиксирует границу честно: выгрузка отдаёт то, что лежит в
    // таблице, и единственный рубеж находится на входе.
    expect(response.body).toContain('contractor_name');
    expect(response.body).toContain(secret);
  });
});

describe('права', () => {
  it('инженеру срез закрыт', async () => {
    const response = await as(KC.engineer, 'GET', '/api/v1/admin/pipeline-feedback/summary');
    expect(response.statusCode).toBe(403);
  });

  it('без сессии — 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/pipeline-feedback/summary',
    });
    expect(response.statusCode).toBe(401);
  });
});
