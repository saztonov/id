/**
 * Навигация «объект → комплект → ревизия» и реестры передачи через HTTP на
 * собранном приложении (§3, §14).
 *
 * Поднимается штатный `buildApp()`, а не роутер модуля: маршрут, написанный и
 * не зарегистрированный в `app.ts`, проходит собственные тесты и недостижим
 * снаружи — это отказ, преследующий проект с S3, и проверять его надо тем же
 * способом, каким он проявляется.
 *
 * Что доказывается, кроме кодов ответа:
 *
 * 1. **Изоляция по ВСЕМ путям** (§1.6, non-degradable): список, прямой
 *    идентификатор, вложенный список ревизий, состав реестра и снимок описи. Ни
 *    один из них не отдаёт чужого и не различает «нет такого» и «не ваше».
 * 2. **Положительный контроль рядом с каждым отрицательным.** Проверка «маркера
 *    чужой работы нет в ответе» проходит и на пустой выдаче, поэтому рядом
 *    всегда стоит проверка, что владелец этот же маркер ВИДИТ.
 * 3. **Организация не берётся из тела запроса** — у подрядчика. У генподрядчика,
 *    наоборот, берётся: он собирает комплекты за субподрядчиков, у которых
 *    учётных записей нет. Разница между этими двумя случаями и есть содержание
 *    `resolveActingContractor`.
 * 4. **Правка состава отделена от видимости** (`managed_by_contractor_id`):
 *    генподрядчик видит чужой комплект, но не открывает в нём ревизию.
 * 5. **Передача реестра конкурентна и необратима**: два запроса с одной версией
 *    дают 200 и 412, снимок состава после передачи неизменяем, а сам реестр
 *    заперт триггером.
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
/** Генподрядчик объекта 1: его область выводится из карточки объекта. */
const ORG_GC = id(4);

/** Объект, где закреплены оба подрядчика и назначен инженер. */
const OBJECT_1 = id(5);
/** Чужой объект: генподрядчик там другой, инженер не назначен. */
const OBJECT_2 = id(6);

const SECTION = 'roofing';
const SECTION_OTHER = 'facade';
const PERIOD = '2026-01-01';
const PERIOD_NEXT = '2026-02-01';

const USER_A = id(20);
const USER_B = id(21);
const USER_GC = id(22);
const USER_ENGINEER = id(23);
const USER_MANAGER = id(24);
const USER_ADMIN = id(25);
/** Инженер БЕЗ назначенных объектов: право есть, область пуста. */
const USER_ENGINEER_NO_SCOPE = id(26);
/** Роли `contractor` + `engineer`: право есть, области подрядчика нет. */
const USER_MIXED = id(27);

/** Комплект А с открытым черновиком. */
const WORK_A_DRAFT = id(30);
const REV_A_DRAFT = id(31);
/** Комплект А с согласованной ревизией: следующую можно открыть руками. */
const WORK_A_APPROVED = id(32);
const REV_A_APPROVED = id(33);
/** Комплект А, ждущий решения проверяющего. */
const WORK_A_PENDING = id(34);
const REV_A_PENDING = id(35);
/** Комплект А с единственной возвращённой ревизией. */
const WORK_A_RETURNED = id(36);
const REV_A_RETURNED = id(37);
/** Комплект подрядчика Б на общем объекте: подан. */
const WORK_B = id(38);
const REV_B = id(39);
/** Комплект подрядчика Б на чужом для А и для инженера объекте. */
const WORK_B_FAR = id(40);
const REV_B_FAR = id(41);

/** Реестр-черновик объекта 1 за январь: его собирают тесты передачи. */
const REGISTRY_1 = id(50);
/** Реестр чужого объекта: его номер несёт маркер. */
const REGISTRY_FAR = id(51);
/** Переданная папка: помеха удалению, которую не снимает даже режим тестирования. */
const REGISTRY_ISSUED = id(52);

/**
 * Маркер чужих данных.
 *
 * Он лежит в заголовках обоих комплектов подрядчика Б. Проверка «в ответе нет
 * маркера» имеет смысл только потому, что он там ЕСТЬ у владельца: иначе она
 * доказывала бы, что данных нет вовсе.
 */
const SECRET = 'СЕКРЕТНЫЙ-ФРАГМЕНТ-ЧУЖОЙ-РАБОТЫ';

const KC = {
  a: 'kc-nav-a',
  b: 'kc-nav-b',
  gc: 'kc-nav-gc',
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
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_GC}', 'ООО «Генподрядчик»', 'general_contractor')`,

  // Область генподрядчика выводится ИЗ КАРТОЧКИ объекта, а не назначается
  // отдельно: два источника одного факта разъехались бы при первой же правке.
  `INSERT INTO construction_objects (id, code, name, full_name, general_contractor_id)
     VALUES ('${OBJECT_1}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1', '${ORG_GC}')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_2}', 'TST02', 'Объект 2', 'ЖК «Тест», корпус 2')`,

  // Разделы `roofing` и `facade` есть в сиде 0029; здесь они только включаются
  // на объектах.
  `INSERT INTO object_sections (object_id, section_code) VALUES ('${OBJECT_1}', '${SECTION}')`,
  `INSERT INTO object_sections (object_id, section_code) VALUES ('${OBJECT_1}', '${SECTION_OTHER}')`,
  `INSERT INTO object_sections (object_id, section_code) VALUES ('${OBJECT_2}', '${SECTION}')`,

  `INSERT INTO object_contractors (object_id, contractor_id) VALUES ('${OBJECT_1}', '${ORG_A}')`,
  `INSERT INTO object_contractors (object_id, contractor_id) VALUES ('${OBJECT_1}', '${ORG_B}')`,
  `INSERT INTO object_contractors (object_id, contractor_id) VALUES ('${OBJECT_1}', '${ORG_GC}')`,
  `INSERT INTO object_contractors (object_id, contractor_id) VALUES ('${OBJECT_2}', '${ORG_B}')`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_A}', '${KC.a}', 'Сотрудник А', '${ORG_A}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_B}', '${KC.b}', 'Сотрудник Б', '${ORG_B}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_GC}', '${KC.gc}', 'Инженер ПТО генподрядчика', '${ORG_GC}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_NO_SCOPE}', '${KC.engineerNoScope}', 'Инженер без объектов')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_MIXED}', '${KC.mixed}', 'Совмещающий роли', '${ORG_A}')`,

  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_A}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_B}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_GC}', 'general_contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_NO_SCOPE}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MIXED}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MIXED}', 'engineer')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT_1}')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_MIXED}', '${OBJECT_1}')`,

  // --- Комплекты подрядчика А на объекте 1 ----------------------------------
  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_A_DRAFT}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}', DATE '${PERIOD}', 'Комплект А. Черновик', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REV_A_DRAFT}', '${WORK_A_DRAFT}', '${OBJECT_1}', '${ORG_A}', 1, 'draft')`,
  `UPDATE works SET current_revision_id = '${REV_A_DRAFT}' WHERE id = '${WORK_A_DRAFT}'`,

  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_A_APPROVED}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}', DATE '${PERIOD}', 'Комплект А. Согласован', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status,
                                     submitted_at, submitted_by, decided_at, decided_by)
     VALUES ('${REV_A_APPROVED}', '${WORK_A_APPROVED}', '${OBJECT_1}', '${ORG_A}', 1, 'approved',
             now(), '${USER_A}', now(), '${USER_ENGINEER}')`,
  `UPDATE works SET current_revision_id = '${REV_A_APPROVED}' WHERE id = '${WORK_A_APPROVED}'`,

  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_A_PENDING}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}', DATE '${PERIOD}', 'Комплект А. На согласовании', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status,
                                     submitted_at, submitted_by)
     VALUES ('${REV_A_PENDING}', '${WORK_A_PENDING}', '${OBJECT_1}', '${ORG_A}', 1, 'submitted',
             now(), '${USER_A}')`,
  `UPDATE works SET current_revision_id = '${REV_A_PENDING}' WHERE id = '${WORK_A_PENDING}'`,

  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_A_RETURNED}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}', DATE '${PERIOD_NEXT}', 'Комплект А. Возвращён', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status,
                                     submitted_at, submitted_by, decided_at, decided_by, return_reason)
     VALUES ('${REV_A_RETURNED}', '${WORK_A_RETURNED}', '${OBJECT_1}', '${ORG_A}', 1, 'returned',
             now(), '${USER_A}', now(), '${USER_ENGINEER}', 'нет протоколов испытаний')`,
  `UPDATE works SET current_revision_id = '${REV_A_RETURNED}' WHERE id = '${WORK_A_RETURNED}'`,

  // --- Комплекты подрядчика Б ------------------------------------------------
  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_B}', '${OBJECT_1}', '${ORG_B}', '${ORG_B}', '${SECTION}', DATE '${PERIOD}', '${SECRET} на общем объекте', '${USER_B}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status,
                                     submitted_at, submitted_by)
     VALUES ('${REV_B}', '${WORK_B}', '${OBJECT_1}', '${ORG_B}', 1, 'submitted', now(), '${USER_B}')`,
  `UPDATE works SET current_revision_id = '${REV_B}' WHERE id = '${WORK_B}'`,

  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_B_FAR}', '${OBJECT_2}', '${ORG_B}', '${ORG_B}', '${SECTION}', DATE '${PERIOD}', '${SECRET} на чужом объекте', '${USER_B}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REV_B_FAR}', '${WORK_B_FAR}', '${OBJECT_2}', '${ORG_B}', 1, 'draft')`,
  `UPDATE works SET current_revision_id = '${REV_B_FAR}' WHERE id = '${WORK_B_FAR}'`,

  // --- Реестры ---------------------------------------------------------------
  `INSERT INTO registries (id, object_id, section_code, period, created_by)
     VALUES ('${REGISTRY_1}', '${OBJECT_1}', '${SECTION}', DATE '${PERIOD}', '${USER_GC}')`,
  `INSERT INTO registries (id, object_id, section_code, period, number, created_by)
     VALUES ('${REGISTRY_FAR}', '${OBJECT_2}', '${SECTION}', DATE '${PERIOD}', '${SECRET}', '${USER_ADMIN}')`,
  // Номер обязателен к передаче (`registries_number_required_chk`), поэтому он
  // задан вместе со статусом.
  `INSERT INTO registries (id, object_id, section_code, period, number, status, issued_by,
                           issued_at, created_by)
     VALUES ('${REGISTRY_ISSUED}', '${OBJECT_1}', '${SECTION}', DATE '${PERIOD}', '770', 'issued',
             '${USER_GC}', now(), '${USER_GC}')`,
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

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

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
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  let session = signedIn.get(kcSub);
  if (session === undefined) {
    session = await signIn(kcSub);
    signedIn.set(kcSub, session);
  }
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

/** Версия реестра в `If-Match`: обязательна на каждом изменении состава. */
function ifMatch(version: number): Record<string, string> {
  return { 'if-match': `"${String(version)}"` };
}

async function registryVersion(kcSub: string, registryId: string): Promise<number> {
  const response = await as(kcSub, 'GET', `/api/v1/registries/${registryId}`);
  return response.json<{ registry: { version: number } }>().registry.version;
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
// Достижимость
// =====================================================================

describe('регистрация маршрутов навигации', () => {
  it('пути комплектов и реестров достижимы и ни один не отвечает «маршрут не найден»', async () => {
    const probes: readonly (readonly [Method, string, number])[] = [
      ['GET', '/api/v1/works', 200],
      ['GET', `/api/v1/works/${WORK_A_DRAFT}`, 200],
      ['GET', `/api/v1/works/${WORK_A_DRAFT}/revisions`, 200],
      ['GET', '/api/v1/registries', 200],
      ['GET', `/api/v1/registries/${REGISTRY_1}`, 200],
      ['GET', `/api/v1/registries/${REGISTRY_1}/items`, 200],
      // Проба измеряет ОДНО: маршрут существует. Код при этом обязан быть
      // точным, иначе «не 404» пройдёт и на случайно сломанном обработчике.
      //
      // Руководителю с S21 выдано `submission.upload`, поэтому здесь уже не
      // 403. С S37 не 400 и не 201: исполнителя портал выводит из карточки
      // объекта сам, поэтому проба берёт НЕСУЩЕСТВУЮЩИЙ объект — иначе она
      // заводила бы комплект и портила соседние наборы. Новая ревизия
      // упирается в уже открытый черновик (409); `registry.manage`
      // руководителю по-прежнему не выдано, и там остался 403.
      //
      // Тело валидно намеренно — схема Fastify проверяется ДО preHandler, и на
      // пустом теле пришёл бы 422, то есть проба измеряла бы валидацию.
      ['POST', '/api/v1/works', 404],
      ['POST', `/api/v1/works/${WORK_A_DRAFT}/revisions`, 409],
      ['POST', '/api/v1/registries', 403],
      ['PUT', `/api/v1/registries/${REGISTRY_1}/works/${WORK_A_DRAFT}`, 403],
      ['DELETE', `/api/v1/registries/${REGISTRY_1}/works/${WORK_A_DRAFT}`, 403],
      ['POST', `/api/v1/registries/${REGISTRY_1}/file`, 403],
      ['POST', `/api/v1/registries/${REGISTRY_1}/issue`, 403],
      // Удаление реестра — `submission.delete`, и оно у руководителя есть, в
      // отличие от `registry.manage` строкой выше. Поэтому проба меряет не
      // отказ права, а помеху: у реестра нет комплектов, но и удалению это не
      // мешает — 204 означало бы, что папку снесли посреди набора. Берётся
      // ПЕРЕДАННЫЙ реестр, у которого помеха безусловна.
      ['GET', `/api/v1/registries/${REGISTRY_ISSUED}/deletion-preview`, 200],
      ['DELETE', `/api/v1/registries/${REGISTRY_ISSUED}`, 409],
    ];

    const bodyFor = (method: Method, url: string): unknown => {
      if (method === 'POST' && url === '/api/v1/works') {
        return { objectId: id(992), sectionCode: SECTION, period: PERIOD, title: 'Проба' };
      }
      if (method === 'POST' && url === '/api/v1/registries') {
        return { objectId: OBJECT_1, sectionCode: SECTION, period: PERIOD };
      }
      if (method === 'PUT') return {};
      return undefined;
    };

    for (const [method, url, expected] of probes) {
      const response = await as(KC.manager, method, url, bodyFor(method, url), ifMatch(0));
      expect([method, url, response.statusCode]).toEqual([method, url, expected]);
    }
  });

  it('ошибка отдаётся как application/problem+json', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/works/${WORK_B}`);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json<{ title: string }>().title).toBeTypeOf('string');
  });

  it('приёмка отделена от ведения: генподрядчику её не выдали', async () => {
    const response = await as(KC.gc, 'POST', `/api/v1/registries/${REGISTRY_1}/accept`, undefined, {
      ...ifMatch(0),
    });
    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Комплекты
// =====================================================================

describe('GET /works', () => {
  it('подрядчик видит только свои комплекты', async () => {
    const response = await as(KC.a, 'GET', '/api/v1/works?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED].sort(),
    );
    expect(response.body).not.toContain(SECRET);

    // Положительный контроль: владелец этих же комплектов маркер ВИДИТ.
    const owner = await as(KC.b, 'GET', '/api/v1/works?limit=100');
    expect([...idsOf(owner)].sort()).toEqual([WORK_B, WORK_B_FAR].sort());
    expect(owner.body).toContain(SECRET);
  });

  it('генподрядчик видит комплекты ВСЕХ подрядчиков, включая чужие организации', async () => {
    // Ограничение по объектам снято (S37), а вот его собственная организация
    // выборку не режет и не резала: она отвечает на «от чьего имени», а не на
    // «что видно». Комплект чужой организации в ответе — гарантия этого.
    const response = await as(KC.gc, 'GET', '/api/v1/works?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
    expect(response.body).toContain(`${SECRET} на общем объекте`);
  });

  it('инженер видит всех подрядчиков на всех объектах', async () => {
    const response = await as(KC.engineer, 'GET', '/api/v1/works?limit=100');
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
  });

  it('руководитель видит все комплекты', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/works?limit=100');
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
  });

  it('инженеру без назначений видны все комплекты стройки', async () => {
    // Прежде это утверждение было обратным и служило гейтом «пустая область —
    // это ничего, а не всё». Пустых областей не осталось (S37); гейтом
    // изоляции остаётся подрядчик, и его проверяют соседние наборы.
    const response = await as(KC.engineerNoScope, 'GET', '/api/v1/works?limit=100');
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
  });

  it('фильтр по объекту сужает выдачу и не расширяет её', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/works?objectId=${OBJECT_1}&limit=100`);
    expect([...idsOf(own)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED].sort(),
    );

    const foreign = await as(KC.a, 'GET', `/api/v1/works?objectId=${OBJECT_2}&limit=100`);
    expect(idsOf(foreign)).toEqual([]);

    // Положительный контроль: фильтр рабочий — у руководителя он отдаёт ровно
    // тот комплект, которого подрядчик А не увидел.
    const byManager = await as(KC.manager, 'GET', `/api/v1/works?objectId=${OBJECT_2}&limit=100`);
    expect(idsOf(byManager)).toEqual([WORK_B_FAR]);
  });

  it('фильтры раздела и месяца работают вместе с областью', async () => {
    const january = await as(
      KC.a,
      'GET',
      `/api/v1/works?sectionCode=${SECTION}&period=${PERIOD}&limit=100`,
    );
    expect([...idsOf(january)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING].sort(),
    );

    const february = await as(KC.a, 'GET', `/api/v1/works?period=${PERIOD_NEXT}&limit=100`);
    expect(idsOf(february)).toEqual([WORK_A_RETURNED]);
  });

  it('признак unassigned отдаёт комплекты, не включённые ни в один реестр', async () => {
    const response = await as(KC.gc, 'GET', '/api/v1/works?unassigned=true&limit=100');
    expect(response.statusCode).toBe(200);
    // Все комплекты фикстуры пока свободны: реестр их ещё не собирал.
    expect(idsOf(response).length).toBeGreaterThan(0);

    // `unassigned=false` — это именно «включённые», а не «любые»: строка
    // «false» не должна прочитаться как истина.
    const assigned = await as(KC.gc, 'GET', '/api/v1/works?unassigned=false&limit=100');
    expect(idsOf(assigned)).toEqual([]);
  });

  it('повреждённый курсор — 400, а не тихий возврат к первой странице', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/works?cursor=%2A%2A%2A');
    expect(response.statusCode).toBe(400);
  });

  it('листает курсором без повторов и без пропусков', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url: string =
        cursor === null
          ? '/api/v1/works?limit=2'
          : `/api/v1/works?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await as(KC.manager, 'GET', url);
      const body = response.json<{ items: Identified[]; nextCursor: string | null }>();
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(6);
  });
});

describe('GET /works/{id}', () => {
  it('свой комплект отдаётся, чужой неотличим от несуществующего', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/works/${WORK_A_DRAFT}`);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ currentRevisionId: string }>().currentRevisionId).toBe(REV_A_DRAFT);

    const foreign = await as(KC.a, 'GET', `/api/v1/works/${WORK_B}`);
    const missing = await as(KC.a, 'GET', `/api/v1/works/${id(998)}`);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(problemShape(foreign)).toEqual(problemShape(missing));

    // Положительный контроль: тот же комплект у владельца — 200 с маркером.
    const owner = await as(KC.b, 'GET', `/api/v1/works/${WORK_B}`);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain(SECRET);
  });

  it('инженеру виден комплект на любом объекте, а несуществующий даёт 404', async () => {
    expect((await as(KC.engineer, 'GET', `/api/v1/works/${WORK_B_FAR}`)).statusCode).toBe(200);
    expect((await as(KC.engineer, 'GET', `/api/v1/works/${WORK_B}`)).statusCode).toBe(200);
    const missing = '00000000-0000-4000-8000-00000000dead';
    expect((await as(KC.engineer, 'GET', `/api/v1/works/${missing}`)).statusCode).toBe(404);
  });
});

/**
 * Состояние конвейера по странице списка (S37).
 *
 * Экран объекта печатает стадию у каждой строки, и величина обязана совпадать с
 * той, что показывает плашка на карточке ревизии: иначе один комплект на двух
 * экранах подряд описывается по-разному. Совпадение держится тем, что обе
 * стороны зовут `summaryStage`; здесь проверяется остальное — область, потолок
 * и то, что чужой идентификатор в ответ не попадает.
 */
describe('GET /objects/{id}/works/pipeline', () => {
  const url = (ids: readonly string[]): string =>
    `/api/v1/objects/${OBJECT_1}/works/pipeline?workIds=${ids.join(',')}`;

  it('отдаёт стадию по комплекту с ревизией', async () => {
    const response = await as(KC.engineer, 'GET', url([WORK_A_DRAFT]));
    expect(response.statusCode).toBe(200);

    const items = response.json<{ workId: string; stage: string }[]>();
    expect(items).toHaveLength(1);
    expect(items[0]?.workId).toBe(WORK_A_DRAFT);
    // Задач по этой ревизии в фикстуре нет — стадия начальная, а не пустая.
    expect(items[0]?.stage).toBe('uploaded');
  });

  it('чужой комплект в ответ не попадает — строка остаётся БЕЗ данных', async () => {
    // Не «не запускалось»: о чужом комплекте портал не утверждает ничего, и
    // отсутствие строки честнее выдуманной стадии.
    const response = await as(KC.a, 'GET', url([WORK_A_DRAFT, WORK_B]));
    expect(response.statusCode).toBe(200);
    expect(response.json<{ workId: string }[]>().map((item) => item.workId)).toEqual([
      WORK_A_DRAFT,
    ]);
  });

  it('чужой объект — 404, а не пустой список', async () => {
    const response = await as(
      KC.a,
      'GET',
      `/api/v1/objects/${id(993)}/works/pipeline?workIds=${WORK_A_DRAFT}`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('список сверх потолка страницы отвергается, а не считается', async () => {
    const many = Array.from({ length: 201 }, (_value, index) => id(800 + index));
    const response = await as(KC.engineer, 'GET', url(many));
    // 422 — отказ схемы запроса: список длиннее страницы не является
    // осмысленным вопросом, и считать его портал не начинает.
    expect(response.statusCode).toBe(422);
  });
});

describe('GET /works/{id}/revisions', () => {
  it('отдаёт ревизии своего комплекта, чужой даёт 404, а не пустой список', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/works/${WORK_A_DRAFT}/revisions`);
    expect(idsOf(own)).toEqual([REV_A_DRAFT]);

    const foreign = await as(KC.a, 'GET', `/api/v1/works/${WORK_B}/revisions`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(REV_B);

    const owner = await as(KC.b, 'GET', `/api/v1/works/${WORK_B}/revisions`);
    expect(idsOf(owner)).toEqual([REV_B]);
  });

  it('инженеру без назначений ревизии существующего комплекта видны', async () => {
    const response = await as(KC.engineerNoScope, 'GET', `/api/v1/works/${WORK_A_DRAFT}/revisions`);
    expect(response.statusCode).toBe(200);
    expect(idsOf(response)).toEqual([REV_A_DRAFT]);
  });
});

// =====================================================================
// Заведение комплекта
// =====================================================================

describe('POST /works', () => {
  /**
   * Исполнителя проверяющий больше не называет (S37).
   *
   * До этого портал отвечал 400 «Укажите организацию-исполнителя», а человек в
   * момент загрузки файла её не знает — файл ещё никто не читал. Теперь
   * исполнитель ВЫВОДИТСЯ из карточки объекта и помечается признаком
   * `contractor_assumed`, чтобы догадка портала осталась отличима от
   * прочитанного факта.
   */
  it('исполнитель выводится из карточки объекта и помечается как подставленный', async () => {
    for (const kc of [KC.engineer, KC.manager, KC.admin]) {
      const response = await as(kc, 'POST', '/api/v1/works', {
        objectId: OBJECT_1,
        sectionCode: SECTION,
        period: PERIOD,
        title: `Комплект без исполнителя от ${kc}`,
      });
      expect([kc, response.statusCode]).toEqual([kc, 201]);
    }

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM works WHERE title LIKE 'Комплект без исполнителя от %'`,
    );
    expect(rows).toHaveLength(3);
    // Генподрядчик из карточки объекта — это запись, которую кто-то сделал, а
    // не догадка портала. Признак при этом поднят: назвал не человек.
    for (const row of rows) expect(row).toEqual({ contractor: ORG_GC, assumed: true });
  });

  it('на объекте без генподрядчика исполнитель берётся из справочника (S39)', async () => {
    // Объект 2 генподрядчика в карточке не имеет, и закреплений там ровно одно.
    // До S39 портал отказывал, если закреплений не одно; теперь закрепления не
    // читаются вовсе, а решает справочник: генподрядная организация в нём одна.
    const response = await as(KC.engineer, 'POST', '/api/v1/works', {
      objectId: OBJECT_2,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект на объекте без генподрядчика',
    });
    expect(response.statusCode).toBe(201);

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM works WHERE title = 'Комплект на объекте без генподрядчика'`,
    );
    expect(rows[0]).toEqual({ contractor: ORG_GC, assumed: true });
  });

  it('две генподрядные организации — отказ с названным действием, а не догадка', async () => {
    // Допущение «в портале одна генподрядная организация» обязано быть
    // проверяемым: как только их две, портал спрашивает человека вместо того,
    // чтобы выбрать наугад. Второй ГП заводится здесь же и убирается следом —
    // соседние наборы читают ту же фикстуру.
    const second = id(990);
    await db.query(
      `INSERT INTO counterparties (id, name, kind)
       VALUES ('${second}', 'ООО «Второй генподрядчик»', 'general_contractor')`,
    );
    try {
      const response = await as(KC.engineer, 'POST', '/api/v1/works', {
        objectId: OBJECT_2,
        sectionCode: SECTION,
        period: PERIOD,
        title: 'Комплект при двух генподрядчиках',
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('contractor_undetermined');
      // Действие названо в `detail` — это то, что видит человек на экране.
      expect(response.json<{ detail: string }>().detail).toMatch(/карточке объекта/u);

      const rows = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM works WHERE title = 'Комплект при двух генподрядчиках'`,
      );
      expect(rows[0]?.n).toBe('0');
    } finally {
      await db.query(`DELETE FROM counterparties WHERE id = '${second}'`);
    }
  });

  it('инженер заводит комплект за подрядчика, и это помечено в аудите', async () => {
    const response = await as(KC.engineer, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект, заведённый инженером',
      contractorId: ORG_A,
    });
    expect(response.statusCode).toBe(201);

    // Ведущая организация — исполнитель, а не автор записи: иначе подрядчик не
    // смог бы дозагрузить в этот комплект собственную исправленную версию.
    const rows = await db.query<{ contractor: string; managed: string }>(
      `SELECT contractor_id AS contractor, managed_by_contractor_id AS managed
         FROM works WHERE title = 'Комплект, заведённый инженером'`,
    );
    expect(rows[0]).toEqual({ contractor: ORG_A, managed: ORG_A });

    const audit = await db.query<{ flag: string | null }>(
      `SELECT payload ->> 'onBehalfOf' AS flag FROM audit_log
        WHERE action = 'work.created' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit[0]?.flag).toBe('true');
  });

  it('пользователю с ролями contractor+engineer организация не берётся из его роли', async () => {
    // Область строится по СТАРШЕЙ роли, то есть инженерская, и организации не
    // содержит. Портал по-прежнему НЕ подставляет сюда организацию подрядчика
    // из второй роли: исполнитель выводится из карточки объекта, а не из того,
    // кем человек ещё числится.
    const response = await as(KC.mixed, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект от совмещающего роли',
    });
    expect(response.statusCode).toBe(201);

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM works WHERE title = 'Комплект от совмещающего роли'`,
    );
    expect(rows[0]).toEqual({ contractor: ORG_GC, assumed: true });
  });

  it('подрядчик, назвавший чужого исполнителя, получает 400, а не чужой комплект', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект от чужого имени',
      contractorId: ORG_B,
    });
    expect(response.statusCode).toBe(400);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM works WHERE title = 'Комплект от чужого имени'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('заводит комплект вместе с первой ревизией и указателем на неё', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект А. Новый',
    });
    expect(response.statusCode).toBe(201);

    const body = response.json<{
      work: {
        id: string;
        contractorId: string;
        managedByContractorId: string;
        objectId: string;
        currentRevisionId: string;
        kind: string;
        registryId: string | null;
      };
      revision: { id: string; revisionNo: number; parentRevisionId: string | null; status: string };
    }>();

    // Организация взята из области видимости, а не из тела запроса.
    expect(body.work.contractorId).toBe(ORG_A);
    expect(body.work.managedByContractorId).toBe(ORG_A);
    expect(body.work.objectId).toBe(OBJECT_1);
    expect(body.work.kind).toBe('complect');
    expect(body.work.registryId).toBeNull();
    expect(body.revision.revisionNo).toBe(1);
    expect(body.revision.parentRevisionId).toBeNull();
    expect(body.revision.status).toBe('draft');
    expect(body.work.currentRevisionId).toBe(body.revision.id);

    // Строки действительно записаны, а не только отрисованы в ответе.
    const rows = await db.query<{ status: string; current: string }>(
      `SELECT r.status, w.current_revision_id::text AS current
         FROM works w JOIN submission_revisions r ON r.work_id = w.id
        WHERE w.id = '${body.work.id}'`,
    );
    expect(rows).toEqual([{ status: 'draft', current: body.revision.id }]);

    expect((await as(KC.a, 'GET', `/api/v1/works/${body.work.id}`)).statusCode).toBe(200);
    expect((await as(KC.b, 'GET', `/api/v1/works/${body.work.id}`)).statusCode).toBe(404);
  });

  it('раздел, не включённый на объекте, — 422 с указанием поля', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: 'masonry',
      period: PERIOD,
      title: 'Комплект в невключённом разделе',
    });
    expect(response.statusCode).toBe(422);
    const pointers = response
      .json<{ errors?: { pointer: string | null }[] }>()
      .errors?.map((issue) => issue.pointer);
    expect(pointers).toContain('/sectionCode');
  });

  it('генподрядчик заводит комплект за субподрядчика, и это видно в журнале', async () => {
    const response = await as(KC.gc, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект Б, собранный ПТО',
      contractorId: ORG_B,
    });
    expect(response.statusCode).toBe(201);

    const work = response.json<{
      work: { id: string; contractorId: string; managedByContractorId: string };
    }>().work;
    // Исполнитель — субподрядчик, ведёт комплект генподрядчик. Именно это
    // расхождение и разделяет «кто выполнил» и «кто правит состав».
    expect(work.contractorId).toBe(ORG_B);
    expect(work.managedByContractorId).toBe(ORG_GC);

    const audit = await db.query<{ payload: { onBehalfOf: boolean } }>(
      `SELECT payload FROM audit_log WHERE action = 'work.created' AND entity_id = '${work.id}'`,
    );
    expect(audit[0]?.payload.onBehalfOf).toBe(true);

    // Субподрядчик видит собранный за него комплект: он его исполнитель.
    expect((await as(KC.b, 'GET', `/api/v1/works/${work.id}`)).statusCode).toBe(200);

    // …но состав ведёт не он: следующую ревизию ему открыть не дадут.
    const foreignRevision = await as(KC.b, 'POST', `/api/v1/works/${work.id}/revisions`);
    expect(foreignRevision.statusCode).toBe(403);
  });

  it('незакреплённый за объектом исполнитель принимается (S39)', async () => {
    // До S39 это был 422: составной ключ `works_contractor_fk` требовал
    // закрепления. Заказчик требование снял — «инженеру генподрядчика не должно
    // быть препятствий в виде назначенных на объект подрядчиков», — и ключ снят
    // миграцией 0055. Организация при этом обязана существовать: обычный
    // `works_contractor_id_fkey` не тронут, и его проверяет соседний набор.
    const response = await as(KC.gc, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект незакреплённого',
      contractorId: ORG_CUSTOMER,
    });
    expect(response.statusCode).toBe(201);

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM works WHERE title = 'Комплект незакреплённого'`,
    );
    // Названный человеком исполнитель признаком не метится, даже если он не
    // закреплён: человек сказал, а не портал догадался.
    expect(rows[0]).toEqual({ contractor: ORG_CUSTOMER, assumed: false });
  });

  it('несуществующая организация исполнителем не принимается', async () => {
    // Положительный контроль к предыдущему: снят ключ ЗАКРЕПЛЕНИЯ, а не ключ
    // существования. Без него «любой uuid» стал бы законным исполнителем.
    const response = await as(KC.gc, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект несуществующего',
      contractorId: id(991),
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM works WHERE title = 'Комплект несуществующего'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('комплект заводится БЕЗ месяца, и месяц приходит пустым', async () => {
    // Месяц выводит конвейер по самому раннему распознанному акту (S30).
    // Спрашивать его при заведении значило бы просить назвать то, чего человек
    // ещё не видел: акта в этот момент нет, есть файл, который никто не читал.
    const response = await as(KC.a, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      title: 'Комплект без месяца',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ work: { period: string | null } }>().work.period).toBeNull();
  });

  it('присланный месяц не назначается: он производный, а не заданный', async () => {
    // Схемы тел в портале не `strict` — незнакомое поле отбрасывается zod'ом, и
    // это общее решение, а не особенность этого маршрута. Утверждение здесь не
    // про код ответа, а про ПОСЛЕДСТВИЕ: месяц остаётся пустым, и назначить его
    // снаружи нельзя даже случайно, старым клиентом.
    const response = await as(KC.a, 'POST', '/api/v1/works', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: '2026-01-01',
      title: 'Комплект с назначенным месяцем',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ work: { period: string | null } }>().work.period).toBeNull();
  });
});

// =====================================================================
// Ревизии комплекта
// =====================================================================

describe('POST /works/{id}/revisions', () => {
  it('при открытом черновике отвечает 409 и не заводит вторую', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/works/${WORK_A_DRAFT}/revisions`);
    expect(response.statusCode).toBe(409);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE work_id = '${WORK_A_DRAFT}'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('пока ревизия ждёт решения, новую открыть нельзя', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/works/${WORK_A_PENDING}/revisions`);
    expect(response.statusCode).toBe(409);
  });

  it('после возврата новую ревизию создаёт возврат, а не этот маршрут', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/works/${WORK_A_RETURNED}/revisions`);
    expect(response.statusCode).toBe(409);
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE work_id = '${WORK_A_RETURNED}'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('после согласования открывает следующую ревизию в форме возврата', async () => {
    const response = await as(KC.a, 'POST', `/api/v1/works/${WORK_A_APPROVED}/revisions`);
    expect(response.statusCode).toBe(201);

    const created = response.json<{
      id: string;
      revisionNo: number;
      parentRevisionId: string | null;
      status: string;
    }>();
    expect(created.revisionNo).toBe(2);
    expect(created.parentRevisionId).toBe(REV_A_APPROVED);
    expect(created.status).toBe('draft');

    const rows = await db.query<{ current: string; events: string }>(
      `SELECT w.current_revision_id::text AS current,
              (SELECT count(*)::text FROM revision_events e WHERE e.revision_id = '${created.id}') AS events
         FROM works w WHERE w.id = '${WORK_A_APPROVED}'`,
    );
    expect(rows[0]?.current).toBe(created.id);
    expect(rows[0]?.events).toBe('1');

    const previous = await db.query<{ status: string }>(
      `SELECT status FROM submission_revisions WHERE id = '${REV_A_APPROVED}'`,
    );
    expect(previous[0]?.status).toBe('approved');

    const again = await as(KC.a, 'POST', `/api/v1/works/${WORK_A_APPROVED}/revisions`);
    expect(again.statusCode).toBe(409);
  });

  it('в чужом комплекте ревизию не создать, и она не появляется в базе', async () => {
    const before = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE work_id = '${WORK_B}'`,
    );
    expect((await as(KC.a, 'POST', `/api/v1/works/${WORK_B}/revisions`)).statusCode).toBe(404);
    const after = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM submission_revisions WHERE work_id = '${WORK_B}'`,
    );
    expect(after).toEqual(before);
  });

  it('генподрядчик видит чужой комплект, но состав его не правит', async () => {
    expect((await as(KC.gc, 'GET', `/api/v1/works/${WORK_B}`)).statusCode).toBe(200);
    // 403, а не 404: скрывать существование того, что он и так видит в списке,
    // бессмысленно — отказ обязан назвать причину.
    const response = await as(KC.gc, 'POST', `/api/v1/works/${WORK_B}/revisions`);
    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Реестры: видимость
// =====================================================================

describe('GET /registries', () => {
  it('подрядчик видит реестры всех объектов — но только их шапки', async () => {
    // У реестра нет `contractor_id` по построению (ADR-0011): в нём работы
    // разных организаций. Он резался областью объекта, а её больше нет (S37),
    // поэтому список общий. Изоляция здесь держится не выборкой, а СОСТАВОМ
    // ответа: карточка подрядчику не отдаёт ни состава, ни блокеров — это
    // проверяет следующий набор.
    const all = [REGISTRY_1, REGISTRY_FAR, REGISTRY_ISSUED].sort();

    const response = await as(KC.a, 'GET', '/api/v1/registries?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual(all);

    const byManager = await as(KC.manager, 'GET', '/api/v1/registries?limit=100');
    expect([...idsOf(byManager)].sort()).toEqual(all);
  });

  it('карточка реестра подрядчику не раскрывает ни состава, ни блокеров', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/registries/${REGISTRY_1}`);
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>>();
    // Полей нет вовсе, а не «пустые»: ноль в счётчике — это тоже ответ на
    // вопрос «сколько работ у соседей», только полученный арифметикой.
    expect(body['works']).toBeUndefined();
    expect(body['file']).toBeUndefined();
    expect(body['blockers']).toBeUndefined();

    const forGc = await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_1}`);
    expect(forGc.json<{ works: unknown[] }>().works).toBeDefined();
    expect(forGc.json<{ blockers: unknown[] }>().blockers).toBeDefined();
  });

  it('несуществующий реестр неотличим у подрядчика и у руководителя', async () => {
    // Прежде здесь сравнивались «чужой» и «несуществующий». Чужих реестров у
    // подрядчика больше нет (S37), но неразличимость отказа осталась
    // требованием: форма ответа обязана не зависеть от того, кто спрашивает.
    const byContractor = await as(KC.a, 'GET', `/api/v1/registries/${id(997)}`);
    const byManager = await as(KC.manager, 'GET', `/api/v1/registries/${id(997)}`);
    expect(byContractor.statusCode).toBe(404);
    expect(byManager.statusCode).toBe(404);
    expect(problemShape(byContractor)).toEqual(problemShape(byManager));
  });
});

// =====================================================================
// Реестр: сбор состава
// =====================================================================

describe('состав реестра', () => {
  it('комплект включается, получает порядковый номер и версию реестра', async () => {
    const version = await registryVersion(KC.gc, REGISTRY_1);
    const response = await as(
      KC.gc,
      'PUT',
      `/api/v1/registries/${REGISTRY_1}/works/${WORK_A_PENDING}`,
      {},
      ifMatch(version),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ version: number }>().version).toBe(version + 1);

    const rows = await db.query<{ ordinal: number }>(
      `SELECT ordinal FROM works WHERE id = '${WORK_A_PENDING}'`,
    );
    expect(rows[0]?.ordinal).toBe(1);
  });

  it('без If-Match — 400, с устаревшей версией — 412', async () => {
    const noHeader = await as(KC.gc, 'PUT', `/api/v1/registries/${REGISTRY_1}/works/${WORK_B}`, {});
    expect(noHeader.statusCode).toBe(400);

    const stale = await as(
      KC.gc,
      'PUT',
      `/api/v1/registries/${REGISTRY_1}/works/${WORK_B}`,
      {},
      ifMatch(0),
    );
    expect(stale.statusCode).toBe(412);
  });

  it('комплект другого месяца в реестр не входит', async () => {
    const version = await registryVersion(KC.gc, REGISTRY_1);
    const response = await as(
      KC.gc,
      'PUT',
      `/api/v1/registries/${REGISTRY_1}/works/${WORK_A_RETURNED}`,
      {},
      ifMatch(version),
    );
    expect(response.statusCode).toBe(422);
  });

  it('исключение возвращает комплект в свободные', async () => {
    const version = await registryVersion(KC.gc, REGISTRY_1);
    const excluded = await as(
      KC.gc,
      'DELETE',
      `/api/v1/registries/${REGISTRY_1}/works/${WORK_A_PENDING}`,
      undefined,
      ifMatch(version),
    );
    expect(excluded.statusCode).toBe(200);

    const rows = await db.query<{ registry_id: string | null }>(
      `SELECT registry_id FROM works WHERE id = '${WORK_A_PENDING}'`,
    );
    expect(rows[0]?.registry_id).toBeNull();

    // И снова включается: исключение не делает комплект непригодным.
    const back = await as(
      KC.gc,
      'PUT',
      `/api/v1/registries/${REGISTRY_1}/works/${WORK_A_PENDING}`,
      {},
      ifMatch(await registryVersion(KC.gc, REGISTRY_1)),
    );
    expect(back.statusCode).toBe(200);
  });
});

// =====================================================================
// Передача и приёмка
// =====================================================================

describe('передача реестра', () => {
  it('передача перечисляет ВСЕ препятствия, а не первое', async () => {
    const view = await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_1}`);
    const codes = view
      .json<{ blockers: { code: string }[] }>()
      .blockers.map((blocker) => blocker.code);
    expect(codes).toContain('number_missing');
    expect(codes).toContain('file_missing');

    const refused = await as(
      KC.gc,
      'POST',
      `/api/v1/registries/${REGISTRY_1}/issue`,
      undefined,
      ifMatch(await registryVersion(KC.gc, REGISTRY_1)),
    );
    expect(refused.statusCode).toBe(422);
  });

  it('файл описи заводится комплектом того же конвейера, второй запрещён', async () => {
    const created = await as(KC.gc, 'POST', `/api/v1/registries/${REGISTRY_1}/file`);
    expect(created.statusCode).toBe(201);

    const body = created.json<{
      work: { id: string; kind: string; registryId: string; autoRunEnabled: boolean };
      revision: { id: string; status: string };
    }>();
    expect(body.work.kind).toBe('registry');
    expect(body.work.registryId).toBe(REGISTRY_1);
    // Разметку описи человек не ведёт: она нужна целиком и сразу для сверки.
    expect(body.work.autoRunEnabled).toBe(true);
    expect(body.revision.status).toBe('draft');

    const second = await as(KC.gc, 'POST', `/api/v1/registries/${REGISTRY_1}/file`);
    expect(second.statusCode).toBe(409);

    // Файл описи не включается в состав как обычный комплект.
    const asComplect = await as(
      KC.gc,
      'PUT',
      `/api/v1/registries/${REGISTRY_1}/works/${body.work.id}`,
      {},
      ifMatch(await registryVersion(KC.gc, REGISTRY_1)),
    );
    expect(asComplect.statusCode).toBe(409);

    // Ревизию описи подаём напрямую: путь подачи проверяется в workflow-тестах,
    // здесь нужен только её статус как предусловие передачи.
    await db.query(
      `UPDATE submission_revisions SET status = 'submitted', submitted_at = now(),
              submitted_by = '${USER_GC}' WHERE id = '${body.revision.id}'`,
    );
  });

  it('передача фиксирует снимок состава и переводит статус', async () => {
    // Номер присваивается перед подписью, а не при заведении черновика.
    const numbered = await as(
      KC.gc,
      'PATCH',
      `/api/v1/registries/${REGISTRY_1}`,
      { number: '8' },
      ifMatch(await registryVersion(KC.gc, REGISTRY_1)),
    );
    expect(numbered.statusCode).toBe(200);

    const blockers = (await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_1}`)).json<{
      blockers: { code: string }[];
    }>().blockers;
    expect(blockers).toEqual([]);

    const version = await registryVersion(KC.gc, REGISTRY_1);

    // Сначала — устаревшая версия на ещё-черновике: предусловия пройдены, и
    // отказ приходит именно от сравнения-с-обменом. Так проверяется тот путь,
    // по которому второй сотрудник ПТО не затирает состав, собранный первым.
    const stale = await as(
      KC.gc,
      'POST',
      `/api/v1/registries/${REGISTRY_1}/issue`,
      undefined,
      ifMatch(version - 1),
    );
    expect(stale.statusCode).toBe(412);
    const noSnapshot = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM registry_items WHERE registry_id = '${REGISTRY_1}'`,
    );
    expect(noSnapshot[0]?.n).toBe('0');

    const issued = await as(
      KC.gc,
      'POST',
      `/api/v1/registries/${REGISTRY_1}/issue`,
      undefined,
      ifMatch(version),
    );
    expect(issued.statusCode).toBe(200);
    expect(issued.json<{ status: string }>().status).toBe('issued');
    expect(
      issued.json<{ issuedFileRevisionId: string | null }>().issuedFileRevisionId,
    ).not.toBeNull();

    const items = await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_1}/items`);
    expect(items.json<{ workId: string; title: string }[]>()).toEqual([
      {
        registryId: REGISTRY_1,
        ordinal: 1,
        workId: WORK_A_PENDING,
        revisionId: REV_A_PENDING,
        contractorId: ORG_A,
        title: 'Комплект А. На согласовании',
      },
    ]);
  });

  it('повторная передача второго снимка не создаёт', async () => {
    // Реестр уже передан, поэтому отказ приходит от предусловий (`not_draft`),
    // а не от сравнения версий: до CAS дело не доходит. Проверка CAS стоит
    // выше — она сделана на ещё-черновике с устаревшей версией, где отказ
    // приходит именно из `bumpRegistryVersion`.
    const response = await as(
      KC.gc,
      'POST',
      `/api/v1/registries/${REGISTRY_1}/issue`,
      undefined,
      ifMatch(await registryVersion(KC.gc, REGISTRY_1)),
    );
    expect(response.statusCode).toBe(422);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM registry_items WHERE registry_id = '${REGISTRY_1}'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('переданный реестр неизменяем: состав, шапка и снимок заперты', async () => {
    const version = await registryVersion(KC.gc, REGISTRY_1);

    const patched = await as(
      KC.gc,
      'PATCH',
      `/api/v1/registries/${REGISTRY_1}`,
      { number: '9' },
      ifMatch(version),
    );
    expect(patched.statusCode).toBe(409);

    const excluded = await as(
      KC.gc,
      'DELETE',
      `/api/v1/registries/${REGISTRY_1}/works/${WORK_A_PENDING}`,
      undefined,
      ifMatch(version),
    );
    expect(excluded.statusCode).toBe(409);

    // Замок снимка — на уровне БД, а не маршрута: он держится и против прямого
    // SQL, то есть против любой будущей ошибки в коде.
    await expect(
      db.query(`UPDATE registry_items SET title = 'подмена' WHERE registry_id = '${REGISTRY_1}'`),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM registry_items WHERE registry_id = '${REGISTRY_1}'`),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE registries SET period = DATE '2026-03-01' WHERE id = '${REGISTRY_1}'`),
    ).rejects.toThrow();
  });

  it('снимок подрядчику показывает только его строки', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/registries/${REGISTRY_1}/items`);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ workId: string }[]>().map((row) => row.workId)).toEqual([WORK_A_PENDING]);

    const other = await as(KC.b, 'GET', `/api/v1/registries/${REGISTRY_1}/items`);
    expect(other.json<unknown[]>()).toEqual([]);
  });

  it('принимает заказчик, а передавший — нет; повтор приёмки — 409', async () => {
    const version = await registryVersion(KC.engineer, REGISTRY_1);

    const accepted = await as(
      KC.engineer,
      'POST',
      `/api/v1/registries/${REGISTRY_1}/accept`,
      undefined,
      ifMatch(version),
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ status: string }>().status).toBe('accepted');

    const again = await as(
      KC.manager,
      'POST',
      `/api/v1/registries/${REGISTRY_1}/accept`,
      undefined,
      ifMatch(await registryVersion(KC.manager, REGISTRY_1)),
    );
    expect(again.statusCode).toBe(409);
  });
});

// =====================================================================
// Заведение реестра
// =====================================================================

describe('POST /registries', () => {
  it('генподрядчик заводит реестр без номера, повтор номера — 409', async () => {
    const created = await as(KC.gc, 'POST', '/api/v1/registries', {
      objectId: OBJECT_1,
      sectionCode: SECTION_OTHER,
      period: PERIOD,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ status: string; number: string | null }>()).toMatchObject({
      status: 'draft',
      number: null,
    });

    const numbered = await as(KC.gc, 'POST', '/api/v1/registries', {
      objectId: OBJECT_1,
      sectionCode: SECTION_OTHER,
      period: PERIOD_NEXT,
      number: '8',
    });
    // Номер «8» уже занят реестром объекта 1: уникальность — по объекту.
    expect(numbered.statusCode).toBe(409);
  });

  it('раздел, не включённый на объекте, — 422 с указанием поля', async () => {
    const response = await as(KC.gc, 'POST', '/api/v1/registries', {
      objectId: OBJECT_1,
      sectionCode: 'masonry',
      period: PERIOD,
    });
    expect(response.statusCode).toBe(422);
  });

  it('на несуществующем объекте ни реестр, ни комплект не заводятся', async () => {
    // Прежде эту ветку закрывал «чужой объект»: генподрядчик получал 404 на
    // объекте, где генподрядчиком назван не он. Деления на свои и чужие объекты
    // больше нет (S37), и 404 остаётся ответом на «нет такого объекта» —
    // проверку видимости в `createWork`/`createRegistry` это не отменяет.
    const missing = id(996);
    const registry = await as(KC.gc, 'POST', '/api/v1/registries', {
      objectId: missing,
      sectionCode: SECTION,
      period: PERIOD,
    });
    expect(registry.statusCode).toBe(404);

    const work = await as(KC.gc, 'POST', '/api/v1/works', {
      objectId: missing,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Комплект на несуществующем объекте',
      contractorId: ORG_B,
    });
    expect(work.statusCode).toBe(404);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM works WHERE object_id = '${missing}'`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});

// =====================================================================
// Сверка описи: две выдачи с разными единицами и разными правами (S20)
// =====================================================================

/**
 * Проверяется не «работают ли маршруты», а РАЗДЕЛЕНИЕ выдач.
 *
 * Заказчик: данные по каждому комплекту формируются отдельно, данные по реестру
 * показываются только сотрудникам генподрядчика. Значит, у подрядчика в ответе
 * не должно быть ни шапки описи, ни групп, ни чужих комплектов — и доказывать
 * это надо маркером, который у ведущего папку ВИДЕН, иначе проверка проходила
 * бы на пустом ответе.
 */
describe('сверка описи передачи', () => {
  const REGISTRY_R = id(70);
  const FILE_WORK = id(71);
  const FILE_REV = id(72);
  const RECON = id(73);

  beforeAll(async () => {
    // Отдельный реестр объекта 1 со своим файлом описи и готовой сверкой:
    // маршрутом её не записать — считает её воркер.
    await db.query(
      `INSERT INTO registries (id, object_id, section_code, period, number, folder_no, created_by)
         VALUES ('${REGISTRY_R}', '${OBJECT_1}', '${SECTION}', DATE '${PERIOD}', '77', '7',
                 '${USER_GC}')`,
    );
    await db.query(
      `INSERT INTO works
         (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
          kind, registry_id, title, created_by)
       VALUES ('${FILE_WORK}', '${OBJECT_1}', '${ORG_GC}', '${ORG_GC}', '${SECTION}',
               DATE '${PERIOD}', 'registry', '${REGISTRY_R}', 'Скан описи', '${USER_GC}')`,
    );
    await db.query(
      `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
         VALUES ('${FILE_REV}', '${FILE_WORK}', '${OBJECT_1}', '${ORG_GC}', 1)`,
    );
    await db.query(
      `UPDATE works SET current_revision_id = '${FILE_REV}' WHERE id = '${FILE_WORK}'`,
    );

    // Маркер лежит и в шапке описи, и в наименовании группы: обе части
    // принадлежат папке, и ни одна не имеет права попасть подрядчику.
    await db.query(
      `INSERT INTO registry_reconciliations
         (id, object_id, registry_id, work_id, revision_id, verdict, header_registry_no,
          header_folder_no, header_mismatch, parser_version, matcher_version,
          works_total, works_extra, rows_total, rows_matched)
       VALUES ('${RECON}', '${OBJECT_1}', '${REGISTRY_R}', '${FILE_WORK}', '${FILE_REV}',
               'mismatch', '${SECRET}', '7', true, 'registry.transfer.v1',
               'registry.reconcile.v1', 1, 0, 1, 1)`,
    );
    await db.query(
      `INSERT INTO registry_reconciliation_works
         (reconciliation_id, revision_id, work_id, matched_revision_id, contractor_id,
          title, contractor_name, state, verdict, rows_total, rows_missing)
       VALUES ('${RECON}', '${FILE_REV}', '${WORK_B}', '${REV_B}', '${ORG_B}',
               'Комплект Б', 'ООО «Подрядчик Б»', 'matched', 'mismatch', 1, 1)`,
    );
    await db.query(
      `INSERT INTO registry_reconciliation_groups
         (reconciliation_id, revision_id, ordinal, title_raw, match_state,
          matched_work_id, matched_revision_id, reason)
       VALUES ('${RECON}', '${FILE_REV}', 0, '${SECRET}', 'matched',
               '${WORK_B}', '${REV_B}', 'номер АОСР совпал точно')`,
    );
    await db.query(
      `INSERT INTO registry_reconciliation_rows
         (reconciliation_id, revision_id, ordinal, group_ordinal, work_id, contractor_id,
          doc_name_raw, match_state, reason)
       VALUES ('${RECON}', '${FILE_REV}', 0, 0, '${WORK_B}', '${ORG_B}',
               'Сертификат соответствия', 'missing', 'документ не найден')`,
    );
  });

  it('сводку по папке отдают только сотрудникам генподрядчика', async () => {
    const gc = await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_R}/reconciliation`);
    expect(gc.statusCode).toBe(200);
    expect(gc.json<{ reconciliation: { verdict: string } }>().reconciliation.verdict).toBe(
      'mismatch',
    );
    expect(gc.body).toContain(SECRET);

    for (const who of [KC.engineer, KC.manager, KC.b, KC.a]) {
      const response = await as(who, 'GET', `/api/v1/registries/${REGISTRY_R}/reconciliation`);
      expect(response.statusCode).toBe(403);
    }
  });

  it('сводка по несуществующему реестру — 404, а не 403', async () => {
    const response = await as(KC.gc, 'GET', `/api/v1/registries/${id(995)}/reconciliation`);
    expect(response.statusCode).toBe(404);
  });

  it('в карточке реестра у подрядчика ключа сверки нет ВОВСЕ, а не null', async () => {
    const contractor = await as(KC.b, 'GET', `/api/v1/registries/${REGISTRY_R}`);
    expect(contractor.statusCode).toBe(200);
    expect('reconciliation' in contractor.json<Record<string, unknown>>()).toBe(false);
    expect(contractor.body).not.toContain(SECRET);

    // Положительный контроль: у ведущего папку ключ есть — иначе проверка выше
    // доказывала бы лишь, что сверки нет вовсе.
    const gc = await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_R}`);
    expect('reconciliation' in gc.json<Record<string, unknown>>()).toBe(true);
  });

  it('свой комплект подрядчик видит, и в ответе нет ни одного поля о папке', async () => {
    const response = await as(KC.b, 'GET', `/api/v1/revisions/${REV_B}/reconciliation`);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      work: { workId: string; verdict: string };
      rows: readonly { docNameRaw: string }[];
    }>();
    expect(body.work.workId).toBe(WORK_B);
    expect(body.work.verdict).toBe('mismatch');
    expect(body.rows).toHaveLength(1);

    expect(response.body).not.toContain(SECRET);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toStrictEqual(
      ['extraDocuments', 'finishedAt', 'parserVersion', 'rows', 'work'].sort(),
    );
  });

  it('по чужой ревизии — пустой ответ, а не чужой комплект', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REV_B}/reconciliation`);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ work: unknown }>().work).toBeNull();
  });

  it('сверку запускают инженер, руководитель и подрядчик, а не только ведущий папку', async () => {
    for (const who of [KC.engineer, KC.manager, KC.b, KC.gc]) {
      const response = await as(
        who,
        'POST',
        `/api/v1/registries/${REGISTRY_R}/reconcile`,
        undefined,
        { 'idempotency-key': `recon-${who}` },
      );
      expect(response.statusCode).toBe(202);
    }

    // Ключ дедупликации — по РЕЕСТРУ, без `Idempotency-Key`: второе нажатие
    // получает уже стоящую задачу, а не заводит вторую по той же папке.
    const jobs = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs WHERE type = 'registry.reconcile'`,
    );
    expect(jobs[0]?.n).toBe('1');
  });

  it('без Idempotency-Key сверка не ставится', async () => {
    const response = await as(KC.gc, 'POST', `/api/v1/registries/${REGISTRY_R}/reconcile`);
    expect(response.statusCode).toBe(400);
  });

  it('отметку «разобрано» ставит принимающая сторона и только с пояснением', async () => {
    const byContractor = await as(
      KC.b,
      'POST',
      `/api/v1/registries/${REGISTRY_R}/reconciliation/review`,
      { note: 'Расхождение разобрано: документ верен.' },
      ifMatch(0),
    );
    expect(byContractor.statusCode).toBe(403);

    const noHeader = await as(
      KC.engineer,
      'POST',
      `/api/v1/registries/${REGISTRY_R}/reconciliation/review`,
      { note: 'Расхождение разобрано: документ верен.' },
    );
    expect(noHeader.statusCode).toBe(400);

    const shortNote = await as(
      KC.engineer,
      'POST',
      `/api/v1/registries/${REGISTRY_R}/reconciliation/review`,
      { note: 'ок' },
      ifMatch(0),
    );
    // 422, а не 400: пояснение короче десяти символов отвергает схема тела, а
    // не разбор заголовка.
    expect(shortNote.statusCode).toBe(422);

    const ok = await as(
      KC.engineer,
      'POST',
      `/api/v1/registries/${REGISTRY_R}/reconciliation/review`,
      { note: 'Расхождение — след распознавания, документ в комплекте верен.' },
      ifMatch(0),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ reviewedBy: string | null }>().reviewedBy).toBe(USER_ENGINEER);

    // Устаревшая версия отвергается: отметка по вчерашней сверке не должна
    // молча приклеиться к сегодняшней.
    const stale = await as(
      KC.engineer,
      'POST',
      `/api/v1/registries/${REGISTRY_R}/reconciliation/review`,
      { note: 'Повтор с прежней версией.' },
      ifMatch(0),
    );
    expect(stale.statusCode).toBe(409);
  });
});

// =====================================================================
// Удаление комплекта (S24)
// =====================================================================

/**
 * Удаление проверяется через HTTP, а не вызовом репозитория, по той же причине,
 * по которой так проверяется вся навигация: маршрут, не зарегистрированный в
 * `app.ts`, проходит собственные тесты и недостижим снаружи.
 *
 * Три вопроса, на которые набор обязан ответить:
 *
 * 1. **Право.** Удаление — `submission.delete`, и оно есть у всех пяти ролей
 *    (S37). Подрядчик убирает СВОЙ черновик сам; чужой комплект он не удалит
 *    не правом, а областью видимости — и ответ будет 404, как на
 *    несуществующий.
 * 2. **Помехи названы ДО нажатия и совпадают с отказом.** Предпросмотр и 409
 *    обязаны говорить одно и то же: иначе экран покажет «можно», а сервер
 *    ответит «нельзя», и различие спишут на сбой. Расширение права помехи не
 *    ослабило ни одной строкой — это набор и проверяет.
 * 3. **Удаляется всё.** Комплект без ревизий, файлов и страниц — единственное
 *    доказательство, что порядок в `purgeRevisionEntirely` полон: забытая
 *    таблица дала бы отказ внешнего ключа, а не тихую грязь.
 */
describe('DELETE /works/{id}', () => {
  it('подрядчик не удаляет ЧУЖОЙ комплект: 404, а не 403', async () => {
    // Право у него теперь есть, и отказ приходит от области видимости.
    // Различать «нет такого» и «не ваше» снаружи нельзя (§1.6), поэтому 404.
    const response = await as(KC.a, 'DELETE', `/api/v1/works/${WORK_B}`);
    expect(response.statusCode).toBe(404);

    // И комплект на месте: отказ обязан быть без последствий.
    expect((await as(KC.b, 'GET', `/api/v1/works/${WORK_B}`)).statusCode).toBe(200);
  });

  it('подрядчик удаляет СВОЙ черновик, не дожидаясь администратора', async () => {
    // Комплект заводится здесь же: общие фикстуры нужны соседним наборам, а это
    // утверждение по построению разрушает то, что проверяет.
    const work = id(710);
    const revision = id(711);
    await db.query(`INSERT INTO works
        (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title,
         created_by)
      VALUES ('${work}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}', DATE '${PERIOD}',
              'Черновик подрядчика А', '${USER_A}')`);
    await db.query(`INSERT INTO submission_revisions
        (id, work_id, object_id, contractor_id, revision_no, status)
      VALUES ('${revision}', '${work}', '${OBJECT_1}', '${ORG_A}', 1, 'draft')`);

    expect((await as(KC.a, 'DELETE', `/api/v1/works/${work}`)).statusCode).toBe(204);
    expect((await as(KC.a, 'GET', `/api/v1/works/${work}`)).statusCode).toBe(404);
  });

  it('предпросмотр называет, что исчезнет', async () => {
    const response = await as(KC.admin, 'GET', `/api/v1/works/${WORK_A_DRAFT}/deletion-preview`);
    expect(response.statusCode).toBe(200);

    const preview = response.json<{
      revisions: number;
      files: number;
      blockers: readonly string[];
    }>();
    expect(preview.revisions).toBeGreaterThan(0);
    expect(preview.blockers).toEqual([]);
  });

  it('согласованная ревизия названа помехой и в предпросмотре, и в отказе', async () => {
    const preview = await as(KC.admin, 'GET', `/api/v1/works/${WORK_A_APPROVED}/deletion-preview`);
    expect(preview.statusCode).toBe(200);
    const blockers = preview.json<{ blockers: readonly string[] }>().blockers;
    expect(blockers.join(' ')).toMatch(/согласованные ревизии/u);

    // Отказ повторяет ту же причину дословно: предпросмотр и переход обязаны
    // опираться на один список, иначе экран и сервер расходятся во мнении.
    const attempt = await as(KC.admin, 'DELETE', `/api/v1/works/${WORK_A_APPROVED}`);
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json<{ detail: string }>().detail).toMatch(/согласованные ревизии/u);

    // И комплект на месте: отказ обязан быть без последствий.
    const still = await as(KC.admin, 'GET', `/api/v1/works/${WORK_A_APPROVED}`);
    expect(still.statusCode).toBe(200);
  });

  it('удаляет комплект вместе с ревизиями, файлами и страницами', async () => {
    const response = await as(KC.admin, 'DELETE', `/api/v1/works/${WORK_A_DRAFT}`);
    expect(response.statusCode).toBe(204);

    const gone = await as(KC.admin, 'GET', `/api/v1/works/${WORK_A_DRAFT}`);
    expect(gone.statusCode).toBe(404);

    // Последствие в базе, а не код ответа: ревизия, её файлы и страницы обязаны
    // исчезнуть целиком. Оставшаяся строка не мешала бы работать, но означала
    // бы, что порядок удаления неполон, — и следующая таблица упёрлась бы в FK.
    const left = await db.query<{ revisions: number; files: number; pages: number }>(`
      select
        (select count(*) from submission_revisions where work_id = '${WORK_A_DRAFT}')::int
          as revisions,
        (select count(*) from source_files where revision_id = '${REV_A_DRAFT}')::int as files,
        (select count(*) from source_pages where revision_id = '${REV_A_DRAFT}')::int as pages
    `);
    expect(left[0]).toEqual({ revisions: 0, files: 0, pages: 0 });
  });

  it('чужой комплект отвечает 404, а не 403: существование чужой работы не подтверждается', async () => {
    const response = await as(KC.admin, 'DELETE', `/api/v1/works/${id(999)}`);
    expect(response.statusCode).toBe(404);
  });
});

/**
 * Поданная ревизия в строгом режиме.
 *
 * Без явной помехи удаление доходило бы до триггеров §3.9 и падало
 * `restrict_violation` из драйвера — пятисотым кодом без объяснения. Запрет при
 * этом ожидаемый: состав поданного комплекта покрыт `aggregate_manifest_hash`, и
 * всё выведенное из него доказывает, что именно проверяли.
 */
describe('DELETE /works/{id} и поданные ревизии', () => {
  it('поданная ревизия названа помехой, а не даёт пятисотый код', async () => {
    const preview = await as(KC.admin, 'GET', `/api/v1/works/${WORK_A_PENDING}/deletion-preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ blockers: readonly string[] }>().blockers.join(' ')).toMatch(
      /поданные ревизии/u,
    );

    const attempt = await as(KC.admin, 'DELETE', `/api/v1/works/${WORK_A_PENDING}`);
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json<{ detail: string }>().detail).toMatch(/поданные ревизии/u);
  });

  it('в режиме тестирования поданный комплект удаляется', async () => {
    // Комплект заводится прямо здесь, а не берётся из общих фикстур: те успевают
    // попасть в переданный реестр, а это ДРУГАЯ помеха, которую режим
    // тестирования не снимает и снимать не должен.
    const work = id(700);
    const revision = id(701);
    await db.query(
      `INSERT INTO works (id, object_id, section_code, period, title, contractor_id,
                          managed_by_contractor_id, created_by)
         VALUES ('${work}', '${OBJECT_1}', '${SECTION}', '${PERIOD}', 'Поданный к удалению',
                 '${ORG_A}', '${ORG_A}', '${USER_A}')`,
    );
    await db.query(
      `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
         VALUES ('${revision}', '${work}', '${OBJECT_1}', '${ORG_A}', 1, 'draft')`,
    );
    await db.query(`UPDATE submission_revisions SET status = 'submitted' WHERE id = '${revision}'`);
    await db.query(`UPDATE works SET current_revision_id = '${revision}' WHERE id = '${work}'`);

    // Строгий режим: помеха названа.
    const strict = await as(KC.admin, 'DELETE', `/api/v1/works/${work}`);
    expect(strict.statusCode).toBe(409);

    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('core.enforce_immutability', 'false'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      const response = await as(KC.admin, 'DELETE', `/api/v1/works/${work}`);
      expect(response.statusCode, response.body).toBe(204);
    } finally {
      // Строгий режим возвращается обязательно: соседние наборы проверяют
      // запреты, и оставленный выключатель сделал бы их зелёными независимо от
      // того, работают ли триггеры.
      await db.query(`DELETE FROM app_settings WHERE key = 'core.enforce_immutability'`);
    }
  });
});

/**
 * Удаление реестра (S37).
 *
 * Набор отвечает на четыре вопроса, и порядок их важен.
 *
 * 1. **Переданную папку не удаляет никто** — ни правом, ни режимом. Второй
 *    сценарий здесь главный: он выключает `core.enforce_immutability` и
 *    убеждается, что отказ остался. Триггер `registries_no_delete` при
 *    выключенном режиме пропустил бы удаление, и без этой проверки помеха
 *    выглядела бы рабочей, ею не являясь.
 * 2. **Комплекты состава отвязываются, а не гибнут.** Это единственное, ради
 *    чего предпросмотр различает два глагола, и проверяется оно последствием в
 *    базе, а не кодом ответа.
 * 3. **Сверка уходит целиком.** Дети `registry_reconciliation_*` каскадны от
 *    прогона; если каскад когда-нибудь снимут, останется висячая строка, и
 *    именно этот счётчик её покажет.
 * 4. **Версия обязательна.** Между «увидел состав» и «нажал удалить» папку
 *    могли передать.
 */
describe('DELETE /registries/{id}', () => {
  /** Черновик со своим комплектом и своим прогоном сверки. */
  async function seedDraftRegistry(registry: string, work: string): Promise<void> {
    await db.query(`INSERT INTO registries (id, object_id, section_code, period, created_by)
      VALUES ('${registry}', '${OBJECT_1}', '${SECTION}', DATE '${PERIOD}', '${USER_GC}')`);
    await db.query(`INSERT INTO works
        (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title,
         created_by, registry_id, ordinal)
      VALUES ('${work}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}', DATE '${PERIOD}',
              'Комплект в удаляемой папке', '${USER_A}', '${registry}', 1)`);
  }

  it('предпросмотр различает отвязываемое и удаляемое', async () => {
    const registry = id(720);
    const work = id(721);
    await seedDraftRegistry(registry, work);

    const response = await as(KC.gc, 'GET', `/api/v1/registries/${registry}/deletion-preview`);
    expect(response.statusCode).toBe(200);

    const preview = response.json<{
      worksDetached: number;
      registryItems: number;
      reconciliations: number;
      file: unknown;
      blockers: readonly string[];
    }>();
    expect(preview.worksDetached).toBe(1);
    // Снимок состава пишется при передаче, у черновика его нет по построению.
    expect(preview.registryItems).toBe(0);
    expect(preview.file).toBeNull();
    expect(preview.blockers).toEqual([]);
  });

  it('удаляет папку, отвязывая комплекты и снося сверку', async () => {
    const registry = id(730);
    const work = id(731);
    const reconciliation = id(732);
    await seedDraftRegistry(registry, work);
    // Сверка привязана к файлу описи, а не к комплекту состава: сверяется
    // КОНКРЕТНЫЙ скан. Поэтому файл заводится здесь же — заодно проверяется,
    // что он удаляется целиком вместе с ревизией.
    const fileWork = id(733);
    const fileRevision = id(734);
    await db.query(`INSERT INTO works
        (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title,
         created_by, registry_id, kind)
      VALUES ('${fileWork}', '${OBJECT_1}', '${ORG_GC}', '${ORG_GC}', '${SECTION}',
              DATE '${PERIOD}', 'Файл описи', '${USER_GC}', '${registry}', 'registry')`);
    await db.query(`INSERT INTO submission_revisions
        (id, work_id, object_id, contractor_id, revision_no, status)
      VALUES ('${fileRevision}', '${fileWork}', '${OBJECT_1}', '${ORG_GC}', 1, 'draft')`);
    await db.query(`UPDATE works SET current_revision_id = '${fileRevision}'
                     WHERE id = '${fileWork}'`);
    await db.query(`INSERT INTO registry_reconciliations
        (id, object_id, registry_id, work_id, revision_id, verdict, parser_version,
         matcher_version)
      VALUES ('${reconciliation}', '${OBJECT_1}', '${registry}', '${fileWork}',
              '${fileRevision}', 'clean', 'test', 'test')`);

    const version = await registryVersion(KC.gc, registry);
    const response = await as(KC.gc, 'DELETE', `/api/v1/registries/${registry}`, undefined, {
      ...ifMatch(version),
    });
    expect(response.statusCode).toBe(204);

    const left = await db.query<{
      registries: number;
      reconciliations: number;
      works: number;
      detached: number;
      fileWorks: number;
      fileRevisions: number;
    }>(`
      select
        (select count(*) from registries where id = '${registry}')::int as registries,
        (select count(*) from registry_reconciliations
          where registry_id = '${registry}')::int as reconciliations,
        (select count(*) from works where id = '${work}')::int as works,
        (select count(*) from works
          where id = '${work}' and registry_id is null and ordinal is null)::int as detached,
        (select count(*) from works where id = '${fileWork}')::int as "fileWorks",
        (select count(*) from submission_revisions
          where id = '${fileRevision}')::int as "fileRevisions"
    `);
    // Комплект ЖИВ и отвязан, файл описи — исчез целиком. Ровно то, что обещал
    // предпросмотр двумя разными глаголами.
    expect(left[0]).toEqual({
      registries: 0,
      reconciliations: 0,
      works: 1,
      detached: 1,
      fileWorks: 0,
      fileRevisions: 0,
    });

    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'registry.deleted' AND entity_id = '${registry}'`,
    );
    expect(audit[0]?.n).toBe('1');
  });

  it('без If-Match — 400, с устаревшей версией — 412', async () => {
    const registry = id(740);
    const work = id(741);
    await seedDraftRegistry(registry, work);

    expect((await as(KC.gc, 'DELETE', `/api/v1/registries/${registry}`)).statusCode).toBe(400);

    const stale = await as(KC.gc, 'DELETE', `/api/v1/registries/${registry}`, undefined, {
      ...ifMatch(99),
    });
    expect(stale.statusCode).toBe(412);

    // Папка на месте: оба отказа обязаны быть без последствий.
    expect((await as(KC.gc, 'GET', `/api/v1/registries/${registry}`)).statusCode).toBe(200);
  });

  it('переданный реестр не удаляется, и помеха названа в предпросмотре', async () => {
    const preview = await as(
      KC.gc,
      'GET',
      `/api/v1/registries/${REGISTRY_ISSUED}/deletion-preview`,
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ blockers: readonly string[] }>().blockers.join(' ')).toMatch(
      /реестр передан/u,
    );

    const version = await registryVersion(KC.gc, REGISTRY_ISSUED);
    const attempt = await as(KC.gc, 'DELETE', `/api/v1/registries/${REGISTRY_ISSUED}`, undefined, {
      ...ifMatch(version),
    });
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json<{ detail: string }>().detail).toMatch(/реестр передан/u);
    expect((await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_ISSUED}`)).statusCode).toBe(200);
  });

  it('в режиме тестирования переданный реестр ВСЁ РАВНО не удаляется', async () => {
    // Главный тест набора. Триггер `registries_no_delete` исполняет
    // `deny_modification`, а та с 0035 при выключенной неизменяемости выходит
    // рано и удаление пропускает. Помеха обязана держаться кодом, а не базой:
    // режим тестирования ослабляет запреты СВОЕЙ базы, а не обязательства
    // перед второй стороной.
    await db.query(
      `INSERT INTO app_settings (key, value, updated_by)
       VALUES ('core.enforce_immutability', 'false'::jsonb, '${USER_ADMIN}')
       ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb`,
    );
    try {
      const version = await registryVersion(KC.gc, REGISTRY_ISSUED);
      const attempt = await as(
        KC.gc,
        'DELETE',
        `/api/v1/registries/${REGISTRY_ISSUED}`,
        undefined,
        {
          ...ifMatch(version),
        },
      );
      expect(attempt.statusCode).toBe(409);
      expect((await as(KC.gc, 'GET', `/api/v1/registries/${REGISTRY_ISSUED}`)).statusCode).toBe(
        200,
      );
    } finally {
      await db.query(
        `UPDATE app_settings SET value = 'true'::jsonb WHERE key = 'core.enforce_immutability'`,
      );
    }
  });

  it('несуществующий реестр — 404, а не 409 и не 500', async () => {
    const response = await as(KC.gc, 'DELETE', `/api/v1/registries/${id(994)}`, undefined, {
      ...ifMatch(0),
    });
    expect(response.statusCode).toBe(404);
  });
});
