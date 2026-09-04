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
/** Комплект А с согласованной ревизией: следующую можно открыть руками. */
const WORK_A_APPROVED = id(32);
/** Комплект А, ждущий решения проверяющего. */
const WORK_A_PENDING = id(34);
/** Комплект А с единственной возвращённой ревизией. */
const WORK_A_RETURNED = id(36);
/** Комплект подрядчика Б на общем объекте: подан. */
const WORK_B = id(38);
/** Комплект подрядчика Б на чужом для А и для инженера объекте. */
const WORK_B_FAR = id(40);
/** Реестр чужого объекта: его номер несёт маркер. */
/** Переданная папка: помеха удалению, которую не снимает даже режим тестирования. */

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

  // --- Папки подрядчика А на объекте 1 ---------------------------------------
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
        title, created_by)
     VALUES ('${WORK_A_DRAFT}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}',
             DATE '${PERIOD}', 'Папка А. Первая', '${USER_A}')`,

  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
        title, created_by)
     VALUES ('${WORK_A_APPROVED}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}',
             DATE '${PERIOD}', 'Папка А. Вторая', '${USER_A}')`,

  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
        title, created_by)
     VALUES ('${WORK_A_PENDING}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}',
             DATE '${PERIOD}', 'Папка А. Третья', '${USER_A}')`,

  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
        title, created_by)
     VALUES ('${WORK_A_RETURNED}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}',
             DATE '${PERIOD_NEXT}', 'Папка А. Четвёртая', '${USER_A}')`,

  // --- Папки подрядчика Б -----------------------------------------------------
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
        title, created_by)
     VALUES ('${WORK_B}', '${OBJECT_1}', '${ORG_B}', '${ORG_B}', '${SECTION}',
             DATE '${PERIOD}', '${SECRET} на общем объекте', '${USER_B}')`,

  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
        title, created_by)
     VALUES ('${WORK_B_FAR}', '${OBJECT_2}', '${ORG_B}', '${ORG_B}', '${SECTION}',
             DATE '${PERIOD}', '${SECRET} на чужом объекте', '${USER_B}')`,
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

function ifMatch(version: number): Record<string, string> {
  return { 'if-match': `"${String(version)}"` };
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
  it('пути папок достижимы и ни один не отвечает «маршрут не найден»', async () => {
    const probes: readonly (readonly [Method, string, number])[] = [
      ['GET', '/api/v1/folders', 200],
      ['GET', `/api/v1/folders/${WORK_A_DRAFT}`, 200],
      // Проба измеряет ОДНО: маршрут существует. Код при этом обязан быть
      // точным, иначе «не 404» пройдёт и на случайно сломанном обработчике.
      //
      // Руководителю с S21 выдано `submission.upload`, поэтому здесь уже не
      // 403. С S37 не 400 и не 201: исполнителя портал выводит из карточки
      // объекта сам, поэтому проба берёт НЕСУЩЕСТВУЮЩИЙ объект — иначе она
      // заводила бы папку и портила соседние наборы.
      //
      // Тело валидно намеренно — схема Fastify проверяется ДО preHandler, и на
      // пустом теле пришёл бы 422, то есть проба измеряла бы валидацию.
      ['POST', '/api/v1/folders', 404],
    ];

    const bodyFor = (method: Method, url: string): unknown => {
      if (method === 'POST' && url === '/api/v1/folders') {
        return { objectId: id(992), sectionCode: SECTION, period: PERIOD, title: 'Проба' };
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
    const response = await as(KC.a, 'GET', `/api/v1/folders/${WORK_B}`);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json<{ title: string }>().title).toBeTypeOf('string');
  });
});

// =====================================================================
// Комплекты
// =====================================================================

describe('GET /folders', () => {
  it('подрядчик видит только свои комплекты', async () => {
    const response = await as(KC.a, 'GET', '/api/v1/folders?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED].sort(),
    );
    expect(response.body).not.toContain(SECRET);

    // Положительный контроль: владелец этих же комплектов маркер ВИДИТ.
    const owner = await as(KC.b, 'GET', '/api/v1/folders?limit=100');
    expect([...idsOf(owner)].sort()).toEqual([WORK_B, WORK_B_FAR].sort());
    expect(owner.body).toContain(SECRET);
  });

  it('генподрядчик видит комплекты ВСЕХ подрядчиков, включая чужие организации', async () => {
    // Ограничение по объектам снято (S37), а вот его собственная организация
    // выборку не режет и не резала: она отвечает на «от чьего имени», а не на
    // «что видно». Комплект чужой организации в ответе — гарантия этого.
    const response = await as(KC.gc, 'GET', '/api/v1/folders?limit=100');
    expect(response.statusCode).toBe(200);
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
    expect(response.body).toContain(`${SECRET} на общем объекте`);
  });

  it('инженер видит всех подрядчиков на всех объектах', async () => {
    const response = await as(KC.engineer, 'GET', '/api/v1/folders?limit=100');
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
  });

  it('руководитель видит все комплекты', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/folders?limit=100');
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
  });

  it('инженеру без назначений видны все комплекты стройки', async () => {
    // Прежде это утверждение было обратным и служило гейтом «пустая область —
    // это ничего, а не всё». Пустых областей не осталось (S37); гейтом
    // изоляции остаётся подрядчик, и его проверяют соседние наборы.
    const response = await as(KC.engineerNoScope, 'GET', '/api/v1/folders?limit=100');
    expect([...idsOf(response)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED, WORK_B, WORK_B_FAR].sort(),
    );
  });

  it('фильтр по объекту сужает выдачу и не расширяет её', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/folders?objectId=${OBJECT_1}&limit=100`);
    expect([...idsOf(own)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING, WORK_A_RETURNED].sort(),
    );

    const foreign = await as(KC.a, 'GET', `/api/v1/folders?objectId=${OBJECT_2}&limit=100`);
    expect(idsOf(foreign)).toEqual([]);

    // Положительный контроль: фильтр рабочий — у руководителя он отдаёт ровно
    // тот комплект, которого подрядчик А не увидел.
    const byManager = await as(KC.manager, 'GET', `/api/v1/folders?objectId=${OBJECT_2}&limit=100`);
    expect(idsOf(byManager)).toEqual([WORK_B_FAR]);
  });

  it('фильтры раздела и месяца работают вместе с областью', async () => {
    const january = await as(
      KC.a,
      'GET',
      `/api/v1/folders?sectionCode=${SECTION}&period=${PERIOD}&limit=100`,
    );
    expect([...idsOf(january)].sort()).toEqual(
      [WORK_A_DRAFT, WORK_A_APPROVED, WORK_A_PENDING].sort(),
    );

    const february = await as(KC.a, 'GET', `/api/v1/folders?period=${PERIOD_NEXT}&limit=100`);
    expect(idsOf(february)).toEqual([WORK_A_RETURNED]);
  });

  it('повреждённый курсор — 400, а не тихий возврат к первой странице', async () => {
    const response = await as(KC.manager, 'GET', '/api/v1/folders?cursor=%2A%2A%2A');
    expect(response.statusCode).toBe(400);
  });

  it('листает курсором без повторов и без пропусков', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url: string =
        cursor === null
          ? '/api/v1/folders?limit=2'
          : `/api/v1/folders?limit=2&cursor=${encodeURIComponent(cursor)}`;
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

describe('GET /folders/{id}', () => {
  it('свой комплект отдаётся, чужой неотличим от несуществующего', async () => {
    const own = await as(KC.a, 'GET', `/api/v1/folders/${WORK_A_DRAFT}`);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ id: string }>().id).toBe(WORK_A_DRAFT);

    const foreign = await as(KC.a, 'GET', `/api/v1/folders/${WORK_B}`);
    const missing = await as(KC.a, 'GET', `/api/v1/folders/${id(998)}`);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(problemShape(foreign)).toEqual(problemShape(missing));

    // Положительный контроль: тот же комплект у владельца — 200 с маркером.
    const owner = await as(KC.b, 'GET', `/api/v1/folders/${WORK_B}`);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain(SECRET);
  });

  it('инженеру виден комплект на любом объекте, а несуществующий даёт 404', async () => {
    expect((await as(KC.engineer, 'GET', `/api/v1/folders/${WORK_B_FAR}`)).statusCode).toBe(200);
    expect((await as(KC.engineer, 'GET', `/api/v1/folders/${WORK_B}`)).statusCode).toBe(200);
    const missing = '00000000-0000-4000-8000-00000000dead';
    expect((await as(KC.engineer, 'GET', `/api/v1/folders/${missing}`)).statusCode).toBe(404);
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
describe('GET /objects/{id}/folders/pipeline', () => {
  const url = (ids: readonly string[]): string =>
    `/api/v1/objects/${OBJECT_1}/folders/pipeline?folderIds=${ids.join(',')}`;

  it('отдаёт стадию по комплекту с ревизией', async () => {
    const response = await as(KC.engineer, 'GET', url([WORK_A_DRAFT]));
    expect(response.statusCode).toBe(200);

    const items = response.json<{ folderId: string; stage: string }[]>();
    expect(items).toHaveLength(1);
    expect(items[0]?.folderId).toBe(WORK_A_DRAFT);
    // Задач по этой ревизии в фикстуре нет — стадия начальная, а не пустая.
    expect(items[0]?.stage).toBe('uploaded');
  });

  it('чужой комплект в ответ не попадает — строка остаётся БЕЗ данных', async () => {
    // Не «не запускалось»: о чужом комплекте портал не утверждает ничего, и
    // отсутствие строки честнее выдуманной стадии.
    const response = await as(KC.a, 'GET', url([WORK_A_DRAFT, WORK_B]));
    expect(response.statusCode).toBe(200);
    expect(response.json<{ folderId: string }[]>().map((item) => item.folderId)).toEqual([
      WORK_A_DRAFT,
    ]);
  });

  it('чужой объект — 404, а не пустой список', async () => {
    const response = await as(
      KC.a,
      'GET',
      `/api/v1/objects/${id(993)}/folders/pipeline?folderIds=${WORK_A_DRAFT}`,
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

describe('POST /folders', () => {
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
      const response = await as(kc, 'POST', '/api/v1/folders', {
        objectId: OBJECT_1,
        sectionCode: SECTION,
        period: PERIOD,
        title: `Папка без исполнителя от ${kc}`,
      });
      expect([kc, response.statusCode]).toEqual([kc, 201]);
    }

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM folders WHERE title LIKE 'Папка без исполнителя от %'`,
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
    const response = await as(KC.engineer, 'POST', '/api/v1/folders', {
      objectId: OBJECT_2,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка на объекте без генподрядчика',
    });
    expect(response.statusCode).toBe(201);

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM folders WHERE title = 'Папка на объекте без генподрядчика'`,
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
      const response = await as(KC.engineer, 'POST', '/api/v1/folders', {
        objectId: OBJECT_2,
        sectionCode: SECTION,
        period: PERIOD,
        title: 'Папка при двух генподрядчиках',
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('contractor_undetermined');
      // Действие названо в `detail` — это то, что видит человек на экране.
      expect(response.json<{ detail: string }>().detail).toMatch(/карточке объекта/u);

      const rows = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM folders WHERE title = 'Папка при двух генподрядчиках'`,
      );
      expect(rows[0]?.n).toBe('0');
    } finally {
      await db.query(`DELETE FROM counterparties WHERE id = '${second}'`);
    }
  });

  it('инженер заводит папку за подрядчика, и это помечено в аудите', async () => {
    const response = await as(KC.engineer, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка, заведённая инженером',
      contractorId: ORG_A,
    });
    expect(response.statusCode).toBe(201);

    // Ведущая организация — исполнитель, а не автор записи: иначе подрядчик не
    // смог бы дозагрузить в этот комплект собственную исправленную версию.
    const rows = await db.query<{ contractor: string; managed: string }>(
      `SELECT contractor_id AS contractor, managed_by_contractor_id AS managed
         FROM folders WHERE title = 'Папка, заведённая инженером'`,
    );
    expect(rows[0]).toEqual({ contractor: ORG_A, managed: ORG_A });

    const audit = await db.query<{ flag: string | null }>(
      `SELECT payload ->> 'onBehalfOf' AS flag FROM audit_log
        WHERE action = 'folder.created' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit[0]?.flag).toBe('true');
  });

  it('пользователю с ролями contractor+engineer организация не берётся из его роли', async () => {
    // Область строится по СТАРШЕЙ роли, то есть инженерская, и организации не
    // содержит. Портал по-прежнему НЕ подставляет сюда организацию подрядчика
    // из второй роли: исполнитель выводится из карточки объекта, а не из того,
    // кем человек ещё числится.
    const response = await as(KC.mixed, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка от совмещающего роли',
    });
    expect(response.statusCode).toBe(201);

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM folders WHERE title = 'Папка от совмещающего роли'`,
    );
    expect(rows[0]).toEqual({ contractor: ORG_GC, assumed: true });
  });

  it('подрядчик, назвавший чужого исполнителя, получает 400, а не чужую папку', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка от чужого имени',
      contractorId: ORG_B,
    });
    expect(response.statusCode).toBe(400);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM folders WHERE title = 'Папка от чужого имени'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('заводит папку одной записью и сразу отдаёт её', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка А. Новая',
    });
    expect(response.statusCode).toBe(201);

    const body = response.json<{
      folder: {
        id: string;
        contractorId: string;
        managedByContractorId: string;
        objectId: string;
        title: string;
      };
    }>();

    // Организация взята из области видимости, а не из тела запроса.
    expect(body.folder.contractorId).toBe(ORG_A);
    expect(body.folder.managedByContractorId).toBe(ORG_A);
    expect(body.folder.objectId).toBe(OBJECT_1);

    // Строка действительно записана, а не только отрисована в ответе.
    const rows = await db.query<{ title: string }>(
      `SELECT title FROM folders WHERE id = '${body.folder.id}'`,
    );
    expect(rows).toEqual([{ title: 'Папка А. Новая' }]);

    expect((await as(KC.a, 'GET', `/api/v1/folders/${body.folder.id}`)).statusCode).toBe(200);
    expect((await as(KC.b, 'GET', `/api/v1/folders/${body.folder.id}`)).statusCode).toBe(404);
  });

  it('раздел, не включённый на объекте, — 422 с указанием поля', async () => {
    const response = await as(KC.a, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: 'masonry',
      period: PERIOD,
      title: 'Папка в невключённом разделе',
    });
    expect(response.statusCode).toBe(422);
    const pointers = response
      .json<{ errors?: { pointer: string | null }[] }>()
      .errors?.map((issue) => issue.pointer);
    expect(pointers).toContain('/sectionCode');
  });

  it('генподрядчик заводит папку за субподрядчика, и это видно в журнале', async () => {
    const response = await as(KC.gc, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка Б, собранная ПТО',
      contractorId: ORG_B,
    });
    expect(response.statusCode).toBe(201);

    const work = response.json<{
      folder: { id: string; contractorId: string; managedByContractorId: string };
    }>().folder;
    // Исполнитель — субподрядчик, ведёт папку генподрядчик. Именно это
    // расхождение и разделяет «кто выполнил» и «кто правит состав».
    expect(work.contractorId).toBe(ORG_B);
    expect(work.managedByContractorId).toBe(ORG_GC);

    const audit = await db.query<{ payload: { onBehalfOf: boolean } }>(
      `SELECT payload FROM audit_log WHERE action = 'folder.created' AND entity_id = '${work.id}'`,
    );
    expect(audit[0]?.payload.onBehalfOf).toBe(true);

    // Субподрядчик видит собранную за него папку: он её исполнитель.
    expect((await as(KC.b, 'GET', `/api/v1/folders/${work.id}`)).statusCode).toBe(200);

    // …но состав ведёт не он: править карточку папки ему не дадут.
    const foreign = await as(KC.b, 'PATCH', `/api/v1/folders/${work.id}`, {
      title: 'Переименовано исполнителем',
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('незакреплённый за объектом исполнитель принимается (S39)', async () => {
    // До S39 это был 422: составной ключ `works_contractor_fk` требовал
    // закрепления. Заказчик требование снял — «инженеру генподрядчика не должно
    // быть препятствий в виде назначенных на объект подрядчиков», — и ключ снят
    // миграцией 0055. Организация при этом обязана существовать: обычный
    // `works_contractor_id_fkey` не тронут, и его проверяет соседний набор.
    const response = await as(KC.gc, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка незакреплённого',
      contractorId: ORG_CUSTOMER,
    });
    expect(response.statusCode).toBe(201);

    const rows = await db.query<{ contractor: string; assumed: boolean }>(
      `SELECT contractor_id AS contractor, contractor_assumed AS assumed
         FROM folders WHERE title = 'Папка незакреплённого'`,
    );
    // Названный человеком исполнитель признаком не метится, даже если он не
    // закреплён: человек сказал, а не портал догадался.
    expect(rows[0]).toEqual({ contractor: ORG_CUSTOMER, assumed: false });
  });

  it('несуществующая организация исполнителем не принимается', async () => {
    // Положительный контроль к предыдущему: снят ключ ЗАКРЕПЛЕНИЯ, а не ключ
    // существования. Без него «любой uuid» стал бы законным исполнителем.
    const response = await as(KC.gc, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: PERIOD,
      title: 'Папка несуществующего',
      contractorId: id(991),
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM folders WHERE title = 'Папка несуществующего'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('папка заводится БЕЗ месяца, и месяц приходит пустым', async () => {
    // Месяц выводит конвейер по самому раннему распознанному акту (S30).
    // Спрашивать его при заведении значило бы просить назвать то, чего человек
    // ещё не видел: акта в этот момент нет, есть файл, который никто не читал.
    const response = await as(KC.a, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      title: 'Папка без месяца',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ folder: { period: string | null } }>().folder.period).toBeNull();
  });

  it('присланный месяц не назначается: он производный, а не заданный', async () => {
    // Схемы тел в портале не `strict` — незнакомое поле отбрасывается zod'ом, и
    // это общее решение, а не особенность этого маршрута. Утверждение здесь не
    // про код ответа, а про ПОСЛЕДСТВИЕ: месяц остаётся пустым, и назначить его
    // снаружи нельзя даже случайно, старым клиентом.
    const response = await as(KC.a, 'POST', '/api/v1/folders', {
      objectId: OBJECT_1,
      sectionCode: SECTION,
      period: '2026-01-01',
      title: 'Папка с назначенным месяцем',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ folder: { period: string | null } }>().folder.period).toBeNull();
  });
});

/**
 * Положить в папку файл и страницу.
 *
 * Общая фикстура их не содержит: соседние наборы читают только карточки. Без
 * содержимого и предпросмотр, и удаление сравнивали бы нули с нулями и прошли
 * бы даже при неполном порядке очистки.
 */
async function fillFolder(folderId: string, seed: number): Promise<void> {
  const sha = 'a'.repeat(64);
  const file = id(seed);
  await db.query(
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${sha}', 'blobs/${folderId}', 1024, 'application/pdf')
     ON CONFLICT (sha256) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order)
     VALUES ('${file}', '${folderId}', '${sha}', 'скан.pdf', ${seed})`,
  );
  await db.query(
    `INSERT INTO source_pages
       (folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px)
     VALUES ('${folderId}', '${file}', 0, ${seed}, 2480, 3508)`,
  );
}

describe('DELETE /folders/{id}', () => {
  it('подрядчик не удаляет ЧУЖУЮ папку: 404, а не 403', async () => {
    // Право у него теперь есть, и отказ приходит от области видимости.
    // Различать «нет такого» и «не ваше» снаружи нельзя (§1.6), поэтому 404.
    const response = await as(KC.a, 'DELETE', `/api/v1/folders/${WORK_B}`);
    expect(response.statusCode).toBe(404);

    // И папка на месте: отказ обязан быть без последствий.
    expect((await as(KC.b, 'GET', `/api/v1/folders/${WORK_B}`)).statusCode).toBe(200);
  });

  it('подрядчик удаляет СВОЮ папку, не дожидаясь администратора', async () => {
    // Папка заводится здесь же: общие фикстуры нужны соседним наборам, а это
    // утверждение по построению разрушает то, что проверяет.
    const folder = id(710);
    await db.query(`INSERT INTO folders
        (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title,
         created_by)
      VALUES ('${folder}', '${OBJECT_1}', '${ORG_A}', '${ORG_A}', '${SECTION}', DATE '${PERIOD}',
              'Черновик подрядчика А', '${USER_A}')`);

    expect((await as(KC.a, 'DELETE', `/api/v1/folders/${folder}`)).statusCode).toBe(204);
    expect((await as(KC.a, 'GET', `/api/v1/folders/${folder}`)).statusCode).toBe(404);
  });

  it('предпросмотр называет, что исчезнет', async () => {
    await fillFolder(WORK_A_DRAFT, 720);

    const response = await as(KC.admin, 'GET', `/api/v1/folders/${WORK_A_DRAFT}/deletion-preview`);
    expect(response.statusCode).toBe(200);

    const preview = response.json<{ files: number; pages: number }>();
    expect(preview.files).toBe(1);
    expect(preview.pages).toBe(1);
  });

  it('удаляет папку вместе с файлами и страницами', async () => {
    await fillFolder(WORK_A_DRAFT, 721);

    const response = await as(KC.admin, 'DELETE', `/api/v1/folders/${WORK_A_DRAFT}`);
    expect(response.statusCode).toBe(204);

    const gone = await as(KC.admin, 'GET', `/api/v1/folders/${WORK_A_DRAFT}`);
    expect(gone.statusCode).toBe(404);

    // Последствие в базе, а не код ответа: папка, её файлы и страницы обязаны
    // исчезнуть целиком. Оставшаяся строка не мешала бы работать, но означала
    // бы, что порядок удаления неполон, — и следующая таблица упёрлась бы в FK.
    const left = await db.query<{ folders: number; files: number; pages: number }>(`
      select
        (select count(*) from folders where id = '${WORK_A_DRAFT}')::int as folders,
        (select count(*) from source_files where folder_id = '${WORK_A_DRAFT}')::int as files,
        (select count(*) from source_pages where folder_id = '${WORK_A_DRAFT}')::int as pages
    `);
    expect(left[0]).toEqual({ folders: 0, files: 0, pages: 0 });
  });

  it('чужая папка отвечает 404, а не 403: существование чужой работы не подтверждается', async () => {
    const response = await as(KC.admin, 'DELETE', `/api/v1/folders/${id(999)}`);
    expect(response.statusCode).toBe(404);
  });
});
