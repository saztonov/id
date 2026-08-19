/**
 * Навигация «тома → поставки → ревизия» через HTTP на собранном приложении
 * (§3, §14).
 *
 * Поднимается штатный `buildApp()`, а не роутер модуля: маршрут, написанный и
 * не зарегистрированный в `app.ts`, проходит собственные тесты и недостижим
 * снаружи — это отказ, преследующий проект с S3, и проверять его надо тем же
 * способом, каким он проявляется. Поэтому каждый новый путь получает здесь
 * настоящий ответ настоящего приложения.
 *
 * Что доказывается, кроме кодов ответа:
 *
 * 1. **Изоляция по ВСЕМ путям** (§1.6, non-degradable): список, прямой
 *    идентификатор, вложенный список ревизий и создание в чужом томе. Ни один
 *    из них не отдаёт чужого и не различает «нет такого» и «не ваше».
 * 2. **Положительный контроль рядом с каждым отрицательным.** Проверка «маркера
 *    чужой поставки нет в ответе» проходит и на пустой выдаче, поэтому рядом
 *    всегда стоит проверка, что владелец этот же маркер ВИДИТ.
 * 3. **Инженер без назначенных объектов не видит ничего** — пустая область не
 *    вырождается в отсутствие ограничения.
 * 4. **Организация не берётся из тела запроса.** Пользователь с ролями
 *    `contractor` и `engineer` имеет право `submission.upload`, но его область
 *    построена по старшей роли и организации не содержит: создание отвергается,
 *    а не выполняется от чьего-нибудь имени.
 * 5. **Ручное создание ревизии не спорит с возвратом** (§3, S10): открытый
 *    черновик, ожидание решения и уже отработавший возврат дают 409, а
 *    следующая ревизия после согласования создаётся с `parent_revision_id` той
 *    же формы, что и у возврата.
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

/** Объект, где работает подрядчик А и назначен инженер. */
const OBJECT_1 = id(4);
/** Чужой объект: у А нет ни одной поставки, инженер не назначен. */
const OBJECT_2 = id(5);

const SECTION_1 = id(6);
const SECTION_2 = id(7);

const VOLUME_1 = id(8);
/** Том чужого объекта: его имя несёт маркер. */
const VOLUME_2 = id(9);
/** Закрытый том того же объекта: подавать в него новую поставку нельзя. */
const VOLUME_CLOSED = id(10);

const USER_A = id(20);
const USER_B = id(21);
const USER_ENGINEER = id(22);
const USER_MANAGER = id(23);
const USER_ADMIN = id(24);
/** Инженер БЕЗ назначенных объектов: право есть, область пуста. */
const USER_ENGINEER_NO_SCOPE = id(25);
/** Роли `contractor` + `engineer`: право есть, области подрядчика нет. */
const USER_MIXED = id(26);

/** Поставка А с открытым черновиком. */
const SUB_A_DRAFT = id(30);
const REV_A_DRAFT = id(31);
/** Поставка А с согласованной ревизией: следующую можно открыть руками. */
const SUB_A_APPROVED = id(32);
const REV_A_APPROVED = id(33);
/** Поставка А, ждущая решения проверяющего. */
const SUB_A_PENDING = id(34);
const REV_A_PENDING = id(35);
/** Поставка А с единственной возвращённой ревизией. */
const SUB_A_RETURNED = id(36);
const REV_A_RETURNED = id(37);
/** Поставка подрядчика Б на общем объекте. */
const SUB_B = id(38);
const REV_B = id(39);
/** Поставка подрядчика Б на чужом для А и для инженера объекте. */
const SUB_B_FAR = id(40);
const REV_B_FAR = id(41);

/**
 * Маркер чужих данных.
 *
 * Он лежит в названии тома чужого объекта и в заголовках обеих поставок
 * подрядчика Б. Проверка «в ответе нет маркера» имеет смысл только потому, что
 * он там ЕСТЬ у владельца: иначе она доказывала бы, что данных нет вовсе.
 */
const SECRET = 'СЕКРЕТНЫЙ-ФРАГМЕНТ-ЧУЖОЙ-РАБОТЫ';

const KC = {
  a: 'kc-nav-a',
  b: 'kc-nav-b',
  engineer: 'kc-nav-engineer',
  manager: 'kc-nav-manager',
  admin: 'kc-nav-admin',
  engineerNoScope: 'kc-nav-engineer-no-scope',
  mixed: 'kc-nav-mixed',
} as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_B}', 'ООО «Подрядчик Б»', 'contractor')`,

  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_1}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_2}', 'TST02', 'Объект 2', 'ЖК «Тест», корпус 2')`,
  `INSERT INTO section_kinds (code, name) VALUES ('roofing', 'Кровля автостоянки')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_1}', '${OBJECT_1}', '2.5.1', 'Кровля', 'roofing')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_2}', '${OBJECT_2}', '2.5.1', 'Кровля', 'roofing')`,

  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME_1}', '${OBJECT_1}', '${SECTION_1}', 'V-01', 'Том 1. Кровля')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME_2}', '${OBJECT_2}', '${SECTION_2}', 'V-02', '${SECRET}')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name, is_active)
     VALUES ('${VOLUME_CLOSED}', '${OBJECT_1}', '${SECTION_1}', 'V-03', 'Том 3. Закрытый', false)`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_A}', '${KC.a}', 'Сотрудник А', '${ORG_A}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_B}', '${KC.b}', 'Сотрудник Б', '${ORG_B}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_NO_SCOPE}', '${KC.engineerNoScope}', 'Инженер без объектов')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_MIXED}', '${KC.mixed}', 'Совмещающий роли', '${ORG_A}')`,

  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_A}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_B}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_NO_SCOPE}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MIXED}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MIXED}', 'engineer')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT_1}')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_MIXED}', '${OBJECT_1}')`,

  // --- Поставки подрядчика А на объекте 1 -----------------------------------
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, number, created_by)
     VALUES ('${SUB_A_DRAFT}', '${VOLUME_1}', '${OBJECT_1}', '${ORG_A}', 'Поставка А. Черновик', '1', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REV_A_DRAFT}', '${SUB_A_DRAFT}', '${OBJECT_1}', '${ORG_A}', 1, 'draft')`,
  `UPDATE submissions SET current_revision_id = '${REV_A_DRAFT}' WHERE id = '${SUB_A_DRAFT}'`,

  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUB_A_APPROVED}', '${VOLUME_1}', '${OBJECT_1}', '${ORG_A}', 'Поставка А. Согласована', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status,
                                     submitted_at, submitted_by, decided_at, decided_by)
     VALUES ('${REV_A_APPROVED}', '${SUB_A_APPROVED}', '${OBJECT_1}', '${ORG_A}', 1, 'approved',
             now(), '${USER_A}', now(), '${USER_ENGINEER}')`,
  `UPDATE submissions SET current_revision_id = '${REV_A_APPROVED}' WHERE id = '${SUB_A_APPROVED}'`,

  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUB_A_PENDING}', '${VOLUME_1}', '${OBJECT_1}', '${ORG_A}', 'Поставка А. На согласовании', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status,
                                     submitted_at, submitted_by)
     VALUES ('${REV_A_PENDING}', '${SUB_A_PENDING}', '${OBJECT_1}', '${ORG_A}', 1, 'submitted',
             now(), '${USER_A}')`,
  `UPDATE submissions SET current_revision_id = '${REV_A_PENDING}' WHERE id = '${SUB_A_PENDING}'`,

  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUB_A_RETURNED}', '${VOLUME_1}', '${OBJECT_1}', '${ORG_A}', 'Поставка А. Возвращена', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status,
                                     submitted_at, submitted_by, decided_at, decided_by, return_reason)
     VALUES ('${REV_A_RETURNED}', '${SUB_A_RETURNED}', '${OBJECT_1}', '${ORG_A}', 1, 'returned',
             now(), '${USER_A}', now(), '${USER_ENGINEER}', 'нет протоколов испытаний')`,
  `UPDATE submissions SET current_revision_id = '${REV_A_RETURNED}' WHERE id = '${SUB_A_RETURNED}'`,

  // --- Поставки подрядчика Б -------------------------------------------------
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUB_B}', '${VOLUME_1}', '${OBJECT_1}', '${ORG_B}', '${SECRET} на общем объекте', '${USER_B}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REV_B}', '${SUB_B}', '${OBJECT_1}', '${ORG_B}', 1, 'draft')`,
  `UPDATE submissions SET current_revision_id = '${REV_B}' WHERE id = '${SUB_B}'`,

  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
     VALUES ('${SUB_B_FAR}', '${VOLUME_2}', '${OBJECT_2}', '${ORG_B}', '${SECRET} на чужом объекте', '${USER_B}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REV_B_FAR}', '${SUB_B_FAR}', '${OBJECT_2}', '${ORG_B}', 1, 'draft')`,
  `UPDATE submissions SET current_revision_id = '${REV_B_FAR}' WHERE id = '${SUB_B_FAR}'`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-navigation-routes-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-navigation-tests-0123',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-navigation-tests',
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
  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 240_000);

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
  body?: unknown,
): Promise<LightMyRequestResponse> {
  let session = signedIn.get(kcSub);
  if (session === undefined) {
    session = await signIn(kcSub);
    signedIn.set(kcSub, session);
  }
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

interface Identified {
  readonly id: string;
}

function idsOf(response: LightMyRequestResponse): readonly string[] {
  const body = response.json<{ items: readonly Identified[] }>();
  return body.items.map((item) => item.id);
}

/**
 * Различающая часть problem+json.
 *
 * `instance` и `requestId` уникальны у каждого запроса по построению, поэтому
 * сравнивать ответы целиком нельзя. Всё остальное обязано совпасть побайтово:
 * ровно этим «нет такого» и «не ваше» становятся неразличимы (§1.6).
 */
function problemShape(response: LightMyRequestResponse): unknown {
  const {
    instance: _instance,
    requestId: _requestId,
    ...rest
  } = response.json<Record<string, unknown>>();
  return rest;
}

// =====================================================================
// Достижимость: каждый новый путь отвечает на собранном приложении
// =====================================================================

describe('регистрация маршрутов навигации', () => {
  it('все семь путей достижимы и ни один не отвечает «маршрут не найден»', async () => {
    const probes: readonly (readonly [Method, string, number])[] = [
      ['GET', '/api/v1/volumes', 200],
      ['GET', `/api/v1/volumes/${VOLUME_1}`, 200],
      ['GET', '/api/v1/submissions', 200],
      ['GET', `/api/v1/submissions/${SUB_A_DRAFT}`, 200],
      ['GET', `/api/v1/submissions/${SUB_A_DRAFT}/revisions`, 200],
      // Руководителю право `submission.upload` не выдано: 403 доказывает, что
      // маршрут существует и защищён, а не что его нет. Тело валидно намеренно —
      // проверка схемы в Fastify идёт ДО preHandler, и на пустом теле пришёл бы
      // 422, то есть проба измеряла бы валидацию, а не регистрацию маршрута.
      ['POST', '/api/v1/submissions', 403],
      ['POST', `/api/v1/submissions/${SUB_A_DRAFT}/revisions`, 403],
    ];

    for (const [method, url, expected] of probes) {
      const response = await as(
        KC.manager,
        method,
        url,
        url === '/api/v1/submissions' && method === 'POST'
          ? { volumeId: VOLUME_1, title: 'Проба достижимости' }
          : undefined,
      );
      expect([method, url, response.statusCode]).toEqual([method, url, expected]);
    }
  });

  it('ошибка отдаётся как application/problem+json', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/volumes/${VOLUME_2}`);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json<{ title: string }>().title).toBeTypeOf('string');
  });
});

// =====================================================================
// Тома
// =====================================================================

describe('GET /volumes', () => {
  it('руководитель видит все тома, включая закрытый и чужой', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/volumes?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual([VOLUME_1, VOLUME_2, VOLUME_CLOSED].sort());
    // Положительный контроль к проверке изоляции ниже: маркер в базе ЕСТЬ.
    expect(response.body).toContain(SECRET);
  });

  it('подрядчик видит тома только тех объектов, где у него есть поставки', async () => {
    const response = await as(KC.a, 'GET', '/api/v1/volumes?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual([VOLUME_1, VOLUME_CLOSED].sort());
    expect(response.body).not.toContain(SECRET);
  });

  it('инженер видит тома назначенных объектов и не видит остальных', async () => {
    const response = await as(KC.engineer, 'GET', '/api/v1/volumes?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual([VOLUME_1, VOLUME_CLOSED].sort());
    expect(response.body).not.toContain(SECRET);
  });

  it('инженер без назначенных объектов не видит ни одного тома', async () => {
    const response = await as(KC.engineerNoScope, 'GET', '/api/v1/volumes?limit=100');
    expect(response.statusCode).toBe(200);
    expect(idsOf(response)).toEqual([]);
  });

  it('фильтр по объекту сужает выдачу и не расширяет её', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/volumes?objectId=${OBJECT_1}&limit=100`);
    expect([...idsOf(own)].sort()).toEqual([VOLUME_1, VOLUME_CLOSED].sort());

    // Тот же фильтр на чужой объект даёт пустую выдачу, а не чужие тома.
    const foreign = await as(KC.a, 'GET', `/api/v1/volumes?objectId=${OBJECT_2}&limit=100`);
    expect(idsOf(foreign)).toEqual([]);
    // Положительный контроль: этот фильтр вообще работает — у руководителя он
    // возвращает именно том чужого объекта.
    const byManager = await as(KC.manager, 'GET', `/api/v1/volumes?objectId=${OBJECT_2}&limit=100`);
    expect(idsOf(byManager)).toEqual([VOLUME_2]);
  });

  it('фильтр isActive=false отдаёт закрытый том, а isActive=true — нет', async () => {
    const closed = await as(KC.a, 'GET', '/api/v1/volumes?isActive=false&limit=100');
    expect(idsOf(closed)).toEqual([VOLUME_CLOSED]);
    const open = await as(KC.a, 'GET', '/api/v1/volumes?isActive=true&limit=100');
    expect(idsOf(open)).toEqual([VOLUME_1]);
  });

  it('листает курсором без повторов и без пропусков', async () => {
    const first = await as(KC.manager, 'GET', '/api/v1/volumes?limit=2');
    const firstBody = first.json<{ items: Identified[]; nextCursor: string | null }>();
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await as(
      KC.manager,
      'GET',
      `/api/v1/volumes?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
    );
    const secondBody = second.json<{ items: Identified[]; nextCursor: string | null }>();
    expect(secondBody.nextCursor).toBeNull();

    const seen = [...firstBody.items, ...secondBody.items].map((item) => item.id);
    expect([...seen].sort()).toEqual([VOLUME_1, VOLUME_2, VOLUME_CLOSED].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('повреждённый курсор — 400, а не тихий возврат к первой странице', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/volumes?cursor=%2A%2A%2A');
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /volumes/{id}', () => {
  it('свой том отдаётся, чужой неотличим от несуществующего', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/volumes/${VOLUME_1}`);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ id: string }>().id).toBe(VOLUME_1);

    const foreign = await as(KC.a, 'GET', `/api/v1/volumes/${VOLUME_2}`);
    const missing = await as(KC.a, 'GET', `/api/v1/volumes/${id(999)}`);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(problemShape(foreign)).toEqual(problemShape(missing));

    // Положительный контроль: том с маркером существует и виден руководителю.
    const byManager = await as(KC.manager, 'GET', `/api/v1/volumes/${VOLUME_2}`);
    expect(byManager.statusCode).toBe(200);
    expect(byManager.body).toContain(SECRET);
  });

  it('инженер без объектов не получает даже том, существующий у других', async () => {
    const response = await as(KC.engineerNoScope, 'GET', `/api/v1/volumes/${VOLUME_1}`);
    expect(response.statusCode).toBe(404);
  });
});

// =====================================================================
// Поставки
// =====================================================================

describe('GET /submissions', () => {
  it('подрядчик видит только свои поставки', async () => {
    const response = await as(KC.a, 'GET', '/api/v1/submissions?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual(
      [SUB_A_DRAFT, SUB_A_APPROVED, SUB_A_PENDING, SUB_A_RETURNED].sort(),
    );
    expect(response.body).not.toContain(SECRET);

    // Положительный контроль: владелец этих же поставок маркер ВИДИТ.
    const owner = await as(KC.b, 'GET', '/api/v1/submissions?limit=100');
    expect([...idsOf(owner)].sort()).toEqual([SUB_B, SUB_B_FAR].sort());
    expect(owner.body).toContain(SECRET);
  });

  it('инженер видит всех подрядчиков, но только на назначенных объектах', async () => {
    const response = await as(KC.engineer, 'GET', '/api/v1/submissions?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual(
      [SUB_A_DRAFT, SUB_A_APPROVED, SUB_A_PENDING, SUB_A_RETURNED, SUB_B].sort(),
    );
    // Поставка Б на объекте 1 видна (маркер в ответе есть), а её двойник на
    // объекте 2 — нет.
    expect(response.body).toContain(`${SECRET} на общем объекте`);
    expect(response.body).not.toContain(`${SECRET} на чужом объекте`);
  });

  it('руководитель видит все поставки', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/submissions?limit=100');
    expect([...idsOf(response)].sort()).toEqual(
      [SUB_A_DRAFT, SUB_A_APPROVED, SUB_A_PENDING, SUB_A_RETURNED, SUB_B, SUB_B_FAR].sort(),
    );
  });

  it('инженер без назначенных объектов не видит ни одной поставки', async () => {
    const response = await as(KC.engineerNoScope, 'GET', '/api/v1/submissions?limit=100');
    expect(idsOf(response)).toEqual([]);
  });

  it('фильтр по тому не выводит из области видимости', async () => {
    const foreign = await as(KC.a, 'GET', `/api/v1/submissions?volumeId=${VOLUME_2}&limit=100`);
    expect(foreign.statusCode).toBe(200);
    expect(idsOf(foreign)).toEqual([]);

    // Положительный контроль: фильтр рабочий — у руководителя он отдаёт ровно
    // ту поставку, которую подрядчик А не увидел.
    const byManager = await as(
      KC.manager,
      'GET',
      `/api/v1/submissions?volumeId=${VOLUME_2}&limit=100`,
    );
    expect(idsOf(byManager)).toEqual([SUB_B_FAR]);
  });

  it('фильтр по объекту работает вместе с областью', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/submissions?objectId=${OBJECT_1}&limit=100`);
    expect([...idsOf(response)].sort()).toEqual(
      [SUB_A_DRAFT, SUB_A_APPROVED, SUB_A_PENDING, SUB_A_RETURNED].sort(),
    );
  });
});

describe('GET /submissions/{id}', () => {
  it('своя поставка отдаётся, чужая неотличима от несуществующей', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/submissions/${SUB_A_DRAFT}`);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ currentRevisionId: string }>().currentRevisionId).toBe(REV_A_DRAFT);

    const foreign = await as(KC.a, 'GET', `/api/v1/submissions/${SUB_B}`);
    const missing = await as(KC.a, 'GET', `/api/v1/submissions/${id(998)}`);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(problemShape(foreign)).toEqual(problemShape(missing));

    // Положительный контроль: та же поставка у её владельца — 200 с маркером.
    const owner = await as(KC.b, 'GET', `/api/v1/submissions/${SUB_B}`);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain(SECRET);
  });

  it('инженер не получает поставку с объекта вне назначений', async () => {
    const far = await as(KC.engineer, 'GET', `/api/v1/submissions/${SUB_B_FAR}`);
    expect(far.statusCode).toBe(404);

    // Положительный контроль: на назначенном объекте чужая поставка ему видна.
    const near = await as(KC.engineer, 'GET', `/api/v1/submissions/${SUB_B}`);
    expect(near.statusCode).toBe(200);
  });
});

// =====================================================================
// Ревизии поставки
// =====================================================================

describe('GET /submissions/{id}/revisions', () => {
  it('отдаёт ревизии своей поставки', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/submissions/${SUB_A_DRAFT}/revisions`);
    expect(response.statusCode).toBe(200);
    expect(idsOf(response)).toEqual([REV_A_DRAFT]);
  });

  it('чужая поставка даёт 404, а не пустой список', async () => {
    const foreign = await as(KC.a, 'GET', `/api/v1/submissions/${SUB_B}/revisions`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(REV_B);

    // Положительный контроль: у владельца тот же путь отдаёт ревизию.
    const owner = await as(KC.b, 'GET', `/api/v1/submissions/${SUB_B}/revisions`);
    expect(owner.statusCode).toBe(200);
    expect(idsOf(owner)).toEqual([REV_B]);
  });

  it('инженер без объектов получает 404 на существующей поставке', async () => {
    const response = await as(
      KC.engineerNoScope,
      'GET',
      `/api/v1/submissions/${SUB_A_DRAFT}/revisions`,
    );
    expect(response.statusCode).toBe(404);
  });
});

// =====================================================================
// Создание поставки
// =====================================================================

describe('POST /submissions', () => {
  it('инженеру, руководителю и администратору право не выдано', async () => {
    for (const kc of [KC.engineer, KC.manager, KC.admin]) {
      const response = await as(kc, 'POST', '/api/v1/submissions', {
        volumeId: VOLUME_1,
        title: 'Попытка не подрядчика',
      });
      expect([kc, response.statusCode]).toEqual([kc, 403]);
    }
  });

  it('пользователю с ролями contractor+engineer организация не придумывается', async () => {
    const response = await as(KC.mixed, 'POST', '/api/v1/submissions', {
      volumeId: VOLUME_1,
      title: 'Поставка от совмещающего роли',
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('создание в чужом томе неотличимо от создания в несуществующем', async () => {
    const foreign = await as(KC.a, 'POST', '/api/v1/submissions', {
      volumeId: VOLUME_2,
      title: 'Поставка в чужом томе',
    });
    const missing = await as(KC.a, 'POST', '/api/v1/submissions', {
      volumeId: id(997),
      title: 'Поставка в несуществующем томе',
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(problemShape(foreign)).toEqual(problemShape(missing));

    const created = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submissions WHERE volume_id = '${VOLUME_2}'`,
    );
    // В чужом томе по-прежнему только поставка подрядчика Б.
    expect(created[0]?.n).toBe('1');
  });

  it('в закрытый том подать нельзя', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/submissions', {
      volumeId: VOLUME_CLOSED,
      title: 'Поставка в закрытый том',
    });
    expect(response.statusCode).toBe(409);
  });

  it('создаёт поставку вместе с первой ревизией и указателем на неё', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/submissions', {
      volumeId: VOLUME_1,
      title: 'Поставка А. Новая',
      number: '7',
    });
    expect(response.statusCode).toBe(201);

    const body = response.json<{
      submission: {
        id: string;
        contractorId: string;
        objectId: string;
        currentRevisionId: string;
        number: string | null;
      };
      revision: { id: string; revisionNo: number; parentRevisionId: string | null; status: string };
    }>();

    // Организация взята из области видимости, а не из тела запроса.
    expect(body.submission.contractorId).toBe(ORG_A);
    expect(body.submission.objectId).toBe(OBJECT_1);
    expect(body.submission.number).toBe('7');
    expect(body.revision.revisionNo).toBe(1);
    expect(body.revision.parentRevisionId).toBeNull();
    expect(body.revision.status).toBe('draft');
    expect(body.submission.currentRevisionId).toBe(body.revision.id);

    // Строки действительно записаны, а не только отрисованы в ответе.
    const rows = await db.query<{ status: string; current: string }>(
      `SELECT r.status, s.current_revision_id::text AS current
         FROM submissions s JOIN submission_revisions r ON r.submission_id = s.id
        WHERE s.id = '${body.submission.id}'`,
    );
    expect(rows).toEqual([{ status: 'draft', current: body.revision.id }]);

    // Созданная поставка сразу видна её владельцу и не видна подрядчику Б.
    const own = await as(KC.a, 'GET', `/api/v1/submissions/${body.submission.id}`);
    expect(own.statusCode).toBe(200);
    const other = await as(KC.b, 'GET', `/api/v1/submissions/${body.submission.id}`);
    expect(other.statusCode).toBe(404);
  });
});

// =====================================================================
// Создание ревизии
// =====================================================================

describe('POST /submissions/{id}/revisions', () => {
  it('при открытом черновике отвечает 409 и не заводит вторую', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/submissions/${SUB_A_DRAFT}/revisions`);
    expect(response.statusCode).toBe(409);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE submission_id = '${SUB_A_DRAFT}'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('пока ревизия ждёт решения, новую открыть нельзя', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/submissions/${SUB_A_PENDING}/revisions`);
    expect(response.statusCode).toBe(409);
  });

  it('после возврата новую ревизию создаёт возврат, а не этот маршрут', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/submissions/${SUB_A_RETURNED}/revisions`);
    expect(response.statusCode).toBe(409);
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE submission_id = '${SUB_A_RETURNED}'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('после согласования открывает следующую ревизию в форме возврата', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/submissions/${SUB_A_APPROVED}/revisions`);
    expect(response.statusCode).toBe(201);

    const revision = response.json<{
      id: string;
      revisionNo: number;
      parentRevisionId: string | null;
      status: string;
    }>();
    expect(revision.revisionNo).toBe(2);
    // Та же форма, что создаёт returnRevision(): родитель проставлен, статус
    // draft, указатель поставки переведён.
    expect(revision.parentRevisionId).toBe(REV_A_APPROVED);
    expect(revision.status).toBe('draft');

    const rows = await db.query<{ current: string; events: string }>(
      `SELECT s.current_revision_id::text AS current,
              (SELECT count(*)::text FROM revision_events e WHERE e.revision_id = '${revision.id}') AS events
         FROM submissions s WHERE s.id = '${SUB_A_APPROVED}'`,
    );
    expect(rows[0]?.current).toBe(revision.id);
    // Лента новой ревизии начинается с события её появления (§3.8).
    expect(rows[0]?.events).toBe('1');

    // Согласованная ревизия осталась на месте и не переоткрыта.
    const previous = await db.query<{ status: string }>(
      `SELECT status FROM submission_revisions WHERE id = '${REV_A_APPROVED}'`,
    );
    expect(previous[0]?.status).toBe('approved');

    // Повторное нажатие упирается в только что открытый черновик.
    const again = await as(KC.a, 'POST', `/api/v1/submissions/${SUB_A_APPROVED}/revisions`);
    expect(again.statusCode).toBe(409);
  });

  it('в чужой поставке ревизию не создать, и она не появляется в базе', async () => {
    const before = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE submission_id = '${SUB_B}'`,
    );
    const response = await as(KC.a, 'POST', `/api/v1/submissions/${SUB_B}/revisions`);
    expect(response.statusCode).toBe(404);
    const after = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE submission_id = '${SUB_B}'`,
    );
    expect(after).toEqual(before);

    // Положительный контроль: у владельца тот же путь работает — эта поставка
    // существует, и отказ выше вызван областью, а не состоянием данных.
    const owner = await as(KC.b, 'GET', `/api/v1/submissions/${SUB_B}/revisions`);
    expect(owner.statusCode).toBe(200);
  });

  it('инженеру и руководителю право создания ревизии не выдано', async () => {
    for (const kc of [KC.engineer, KC.manager]) {
      const response = await as(kc, 'POST', `/api/v1/submissions/${SUB_A_APPROVED}/revisions`);
      expect([kc, response.statusCode]).toEqual([kc, 403]);
    }
  });
});
