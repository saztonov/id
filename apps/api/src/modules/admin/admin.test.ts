/**
 * Администрирование: проверки через HTTP на собранном приложении.
 *
 * Приложение поднимается штатным `buildApp()` поверх настоящей PostgreSQL
 * (pglite) под миграциями проекта, вход выполняется штатным потоком
 * `/auth/login` → `/auth/callback`. Ни один маршрут здесь не объявлен заново:
 * проверяется то, что зарегистрировано в `app.ts`, — иначе тест доказывал бы
 * работоспособность модуля, который в приложение не подключён (урок S3).
 *
 * Отдельно проверяется главное требование §10: секретов нет ни в ответе, ни в
 * возможности их записать. В окружении теста заданы настоящие значения токенов,
 * и тело ответа обязано их не содержать.
 *
 * Права и области видимости проверяются на ЖИВОЙ сессии: роль выдаётся и
 * снимается, объект назначается и снимается, учётная запись отключается — и
 * каждый раз доступ обязан измениться в том же процессе, без повторного входа.
 * Кэш прав, переживающий снятие роли, опаснее его отсутствия: администратор
 * видит, что роль снята, а пользователь продолжает работать.
 *
 * Автомат состояний живёт в `governance.test.ts` — он чистый и базы не требует.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RETIRED_RULES, RULE_CODES } from '@id/rules';

import { eq } from 'drizzle-orm';
import { promptTemplates } from '@id/db';
import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';
import { PG_RESTRICT_VIOLATION, pgErrorCode } from '../../db/repositories/admin.js';
import { looksSecret, SECRET_SETTINGS, SETTING_KEYS } from './schemas.js';

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

const ORG_CONTRACTOR = id(1);
const ORG_SUPPLIER = id(2);
const OBJECT_1 = id(3);
const OBJECT_2 = id(4);

const USER_ADMIN = id(10);
const USER_ADMIN_SECOND = id(11);
const USER_ENGINEER = id(12);
const USER_CONTRACTOR = id(13);
/** Заведён без единой роли: цель проверок назначения прав. */
const USER_PLAIN = id(14);
/** Роль выдаётся и снимается, пока его сессия открыта: проверка кэша прав. */
const USER_PROMOTED = id(15);
/** Инженер без назначенных объектов: проверка немедленного расширения выборки. */
const USER_SCOPED = id(16);
/** Отключается, пока его сессия открыта. */
const USER_SUSPENDED = id(17);
/** Старшая бизнес-роль: администрирования она не даёт (§4.1). */
const USER_MANAGER = id(18);

const KC = {
  admin: 'kc-admin-primary',
  adminSecond: 'kc-admin-second',
  engineer: 'kc-engineer',
  contractor: 'kc-contractor',
  promoted: 'kc-promoted',
  scoped: 'kc-scoped',
  suspended: 'kc-suspended',
  manager: 'kc-manager',
} as const;

const RULE_A = 'AOSR.HDR.022';
const RULE_B = 'DATE.312';

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядная организация»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_SUPPLIER}', 'ООО «Поставщик материалов»', 'supplier')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_1}', 'OBJ01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_2}', 'OBJ02', 'Объект 2', 'ЖК «Тест», корпус 2')`,

  `INSERT INTO users (id, kc_sub, full_name, email)
     VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор портала',
             'admin-primary@example.invalid')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ADMIN_SECOND}', '${KC.adminSecond}', 'Второй администратор')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер объекта')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR}', '${KC.contractor}', 'Сотрудник подрядчика',
             '${ORG_CONTRACTOR}')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_PLAIN}', 'kc-plain', 'Пользователь без прав')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_PROMOTED}', '${KC.promoted}', 'Пользователь до выдачи роли')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_SCOPED}', '${KC.scoped}', 'Инженер без назначений')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_SUSPENDED}', '${KC.suspended}', 'Инженер, которого отключат')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,

  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN_SECOND}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_SCOPED}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_SUSPENDED}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_object_scopes (user_id, object_id)
     VALUES ('${USER_ENGINEER}', '${OBJECT_1}')`,
  `INSERT INTO user_object_scopes (user_id, object_id)
     VALUES ('${USER_SUSPENDED}', '${OBJECT_1}')`,

  // Реестр правил заполняется сидом 0017 из RULE_CATALOG (S9), поэтому здесь
  // фикстур нет: собственная строка rule_definitions ломала бы сверку реестра
  // с реализациями при старте приложения (§9.6). Коды ниже — настоящие.
];

// =====================================================================
// Приложение поверх pglite
// =====================================================================

/**
 * Искусственный обрыв одного запроса внутри транзакции.
 *
 * Нужен двум проверкам, которые иначе недоказуемы.
 *
 * Первая — атомарность публикации набора правил. Отмена по неизвестному коду
 * правила проверяет ветку кода, а не транзакцию: она возвращается ДО первой
 * записи. Настоящий вопрос другой — что останется в БД, если публикация
 * прервётся ПОСЛЕ создания версии и ДО того, как снимок записан целиком. Ответ
 * обязан быть «ничего»: версия с половиной правил даёт прогон, результат
 * которого невозможно ни воспроизвести, ни оспорить.
 *
 * Вторая — перевод отказа триггера БД в 409. Через HTTP триггер недостижим:
 * условие состояния стоит в самом UPDATE, поэтому опубликованная строка в него
 * не попадает, а триггер срабатывает лишь при гонке или правке в обход API.
 * Поэтому в запрос подставляется НАСТОЯЩАЯ ошибка, полученная от этого же
 * триггера прямым SQL, — проверяется обработка ошибки, а не её выдумка.
 *
 * Срабатывание одноразовое: `ROLLBACK` идёт тем же каналом и обязан пройти.
 */
interface InjectedFault {
  readonly match: RegExp;
  readonly error: Error;
}

let pendingFault: InjectedFault | null = null;

function armFault(match: RegExp, error: Error): void {
  pendingFault = { match, error };
}

/** `false` после прогона означает, что подстановка сработала на ожидаемом запросе. */
function faultArmed(): boolean {
  return pendingFault !== null;
}

function takeFault(text: string): Error | null {
  if (pendingFault === null || !pendingFault.match.test(text)) return null;
  const { error } = pendingFault;
  pendingFault = null;
  return error;
}

/**
 * Журнал запросов канала.
 *
 * Нужен ровно одной проверке — атомарности публикации. Без него «в БД ничего не
 * осталось» доказывает лишь то, что записи не появилось: точно так же выглядел
 * бы отказ ДО первой вставки, то есть проверка транзакции превратилась бы в
 * проверку ветки кода. По журналу видно, что версия была вставлена, снимок
 * вставлялся и всё это откатилось.
 */
let recorded: string[] | null = null;

function startRecording(): void {
  recorded = [];
}

function recordedStatements(): readonly string[] {
  return recorded ?? [];
}

function stopRecording(): void {
  recorded = null;
}

/**
 * Тестовая БД с журналом и подстановкой ошибки.
 *
 * Перехват стоит НИЖЕ пула (`createTestPool`), а не вместо него: формы вызова
 * драйвера `pg`, позиционный режим и приведение меток времени — общее поведение
 * всех тестов, и вторая его реализация здесь означала бы, что этот файл проверяет
 * репозитории на драйвере, отличном от остальных.
 */
function instrument(db: TestDatabase): TestDatabase {
  const intercept = (text: string): void => {
    // Запрос записывается ДО подстановки ошибки: прерванный запрос обязан быть
    // виден в журнале, иначе по нему нельзя судить, где именно оборвалось.
    if (recorded !== null) recorded.push(text);
    const fault = takeFault(text);
    if (fault !== null) throw fault;
  };

  return {
    kind: db.kind,
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      intercept(sql);
      return db.query<T>(sql, params);
    },
    queryArray(sql: string, params?: unknown[]): Promise<unknown[][]> {
      intercept(sql);
      return db.queryArray(sql, params);
    },
    exec: (sql: string): Promise<void> => db.exec(sql),
    close: (): Promise<void> => db.close(),
  };
}

/** Настоящие значения секретов: тело ответов обязано их не содержать. */
const PROXY_LLM_TOKEN_VALUE = 'llm-token-must-never-appear-in-any-response';
const RDWEB_PASSWORD_VALUE = 'rdweb-password-must-never-appear-in-any-response';

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-admin-tests-01234567890',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/admin-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-admin-tests',
  LLM_PROVIDER: 'proxy_llm',
  PROXY_LLM_BASE_URL: 'https://llm.invalid',
  PROXY_LLM_TOKEN: PROXY_LLM_TOKEN_VALUE,
  RDWEB_BASE_URL: 'https://rdweb.invalid',
  RDWEB_USER: 'rdweb-service',
  RDWEB_PASSWORD: RDWEB_PASSWORD_VALUE,
  // Allowlist обязателен вместе с адресом (§5.1): служебный аккаунт RD WEB
  // ограничен portal-owned проектами, и половина конфигурации хуже её
  // отсутствия — портал поднялся бы, а каждая задача разметки падала бы.
  RDWEB_PROJECT_ALLOWLIST: 'prj-portal',
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

  app = await buildApp({ env: TEST_ENV, pool: createTestPool(instrument(db)) as unknown as Pool });
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

async function signIn(kcSub: string): Promise<SignedIn> {
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${encodeURIComponent(kcSub)}`,
  });
  expect(started.statusCode).toBe(302);

  const authorizationUrl = new URL(locationOf(started));
  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
  });
  expect(completed.statusCode).toBe(302);

  return {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
}

const signedIn = new Map<string, SignedIn>();

async function sessionFor(kcSub: string): Promise<SignedIn> {
  const cached = signedIn.get(kcSub);
  if (cached !== undefined) return cached;
  const fresh = await signIn(kcSub);
  signedIn.set(kcSub, fresh);
  return fresh;
}

function admin(): Promise<SignedIn> {
  return sessionFor(KC.admin);
}

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  session: SignedIn | null,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(session === null
      ? {}
      : { headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken } }),
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
}

async function asAdmin(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return call(method, url, await admin(), body);
}

const P = '/api/v1/admin';

/**
 * Каждый маршрут администрирования с ПРИГОДНЫМ телом.
 *
 * Таблица одна на три проверки — «маршрут зарегистрирован», «без сессии 401» и
 * «роль без права получает 403», — и тело в ней обязано быть валидным по схеме.
 * Причина в порядке жизненного цикла Fastify: `validation` выполняется РАНЬШЕ
 * `preHandler`, где стоит `requirePermission`. Проверено прогоном: тот же запрос
 * с непригодным телом отвечает 422 и анонимному, и инженеру, то есть с пустым
 * телом проверка прав до дела бы не дошла, а тест выглядел бы зелёным («не
 * 200 — значит закрыто»).
 *
 * Новый эндпоинт администрирования обязан появиться здесь: без строки в таблице
 * он не будет ни проверен на регистрацию, ни проверен на доступность чужим ролям.
 */
interface AdminProbe {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Шаблон маршрута для `hasRoute`. */
  readonly route: string;
  /** Конкретный адрес запроса. */
  readonly url: string;
  readonly body?: unknown;
}

/** Идентификатор, которого нет: проверка прав обязана срабатывать до поиска строки. */
const ABSENT_ID = id(900);

const SWEEP_PROMPT_CODE = 'sweep_probe';
const SWEEP_RULESET_VERSION = 'sweep.probe.1';

const ADMIN_PROBES: readonly AdminProbe[] = [
  { method: 'GET', route: `${P}/users`, url: `${P}/users?limit=5` },
  { method: 'GET', route: `${P}/users/:id`, url: `${P}/users/${USER_PLAIN}` },
  {
    method: 'PUT',
    route: `${P}/users/:id/roles`,
    url: `${P}/users/${USER_PLAIN}/roles`,
    body: { roles: ['manager'] },
  },
  {
    method: 'PUT',
    route: `${P}/users/:id/contractor`,
    url: `${P}/users/${USER_PLAIN}/contractor`,
    body: { contractorId: ORG_CONTRACTOR },
  },
  { method: 'POST', route: `${P}/users/:id/activate`, url: `${P}/users/${USER_PLAIN}/activate` },
  {
    method: 'POST',
    route: `${P}/users/:id/deactivate`,
    url: `${P}/users/${USER_PLAIN}/deactivate`,
  },
  { method: 'GET', route: `${P}/settings`, url: `${P}/settings` },
  {
    method: 'PUT',
    route: `${P}/settings/:key`,
    url: `${P}/settings/ai.enabled`,
    body: { value: true },
  },
  { method: 'GET', route: `${P}/prompts`, url: `${P}/prompts?limit=5` },
  {
    method: 'POST',
    route: `${P}/prompts`,
    url: `${P}/prompts`,
    body: {
      code: SWEEP_PROMPT_CODE,
      stage: 'extract',
      docTypeCode: null,
      systemPrompt: 'Проба доступа.',
      userTemplate: 'Текст: {{text}}',
      outputSchema: null,
      modelOverride: null,
    },
  },
  { method: 'GET', route: `${P}/prompts/:id`, url: `${P}/prompts/${ABSENT_ID}` },
  {
    method: 'PATCH',
    route: `${P}/prompts/:id`,
    url: `${P}/prompts/${ABSENT_ID}`,
    body: { systemPrompt: 'Проба правки.' },
  },
  {
    method: 'POST',
    route: `${P}/prompts/:id/state`,
    url: `${P}/prompts/${ABSENT_ID}/state`,
    body: { to: 'test' },
  },
  { method: 'GET', route: `${P}/rules`, url: `${P}/rules` },
  { method: 'GET', route: `${P}/rulesets`, url: `${P}/rulesets?limit=5` },
  {
    method: 'POST',
    route: `${P}/rulesets`,
    url: `${P}/rulesets`,
    body: {
      version: SWEEP_RULESET_VERSION,
      notes: null,
      rules: [{ ruleCode: RULE_A, severity: 'error' }],
    },
  },
  { method: 'GET', route: `${P}/rulesets/:id`, url: `${P}/rulesets/${ABSENT_ID}` },
  {
    method: 'POST',
    route: `${P}/rulesets/:id/activate`,
    url: `${P}/rulesets/${ABSENT_ID}/activate`,
  },
];

// =====================================================================
// Регистрация маршрутов и права
// =====================================================================

describe('маршруты администрирования зарегистрированы в приложении', () => {
  /**
   * Регистрация проверяется через `hasRoute`, а не поиском в `printRoutes()`:
   * дерево склеивает общие префиксы («/api/v1/admin/rules» и «…/rulesets»
   * печатаются как `rules` + `ets`), поэтому подстроки полного пути в нём может
   * не быть у совершенно исправного маршрута.
   */
  it('все маршруты модуля зарегистрированы в приложении', () => {
    for (const probe of ADMIN_PROBES) {
      const registered = app.hasRoute({ method: probe.method, url: probe.route });
      expect({ method: probe.method, route: probe.route, registered }).toEqual({
        method: probe.method,
        route: probe.route,
        registered: true,
      });
    }
  });

  it('без сессии каждый маршрут отвечает 401, а не 403 и не 404', async () => {
    // 401 против 403 — не косметика: 403 означает «войти уже пробовали, прав
    // нет», и клиент, получивший его без сессии, не отправит пользователя на
    // вход. Проверяется на всех маршрутах, потому что забыть `requireAuth`
    // можно на любом.
    for (const probe of ADMIN_PROBES) {
      const response = await call(probe.method, probe.url, null, probe.body);
      expect({ method: probe.method, url: probe.url, status: response.statusCode }).toEqual({
        method: probe.method,
        url: probe.url,
        status: 401,
      });
    }
  });

  it('администратор получает список пользователей', async () => {
    const response = await asAdmin('GET', `${P}/users?limit=50`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: { id: string; roles: string[] }[] }>();
    expect(body.items.map((item) => item.id)).toContain(USER_PLAIN);
    expect(body.items.find((item) => item.id === USER_ADMIN)?.roles).toEqual(['admin']);
  });

  it('поиск фильтрует список, а не только меняет ключ кэша', async () => {
    /**
     * Экран администратора спрашивал подстроку с самого начала, но схема
     * маршрута её не знала: zod срезал незнакомый ключ, список приходил
     * нефильтрованным, и по нему делали вывод «такого пользователя нет».
     * Поиск, который молча ничего не ищет, хуже отсутствующего.
     */
    const byName = await asAdmin('GET', `${P}/users?limit=50&search=Инженер объекта`);
    expect(byName.statusCode).toBe(200);
    const names = byName.json<{ items: { id: string }[] }>().items.map((item) => item.id);
    expect(names).toContain(USER_ENGINEER);
    expect(names).not.toContain(USER_PLAIN);

    // Почта ищется тем же параметром: администратор помнит либо имя, либо адрес.
    const byEmail = await asAdmin('GET', `${P}/users?limit=50&search=admin-primary`);
    expect(byEmail.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      USER_ADMIN,
    ]);

    // Подчёркивание — обычный символ, а не «любой знак»: без экранирования LIKE
    // такой запрос вернул бы посторонние строки.
    const literal = await asAdmin('GET', `${P}/users?limit=50&search=_`);
    expect(literal.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('запись без CSRF-заголовка отклоняется', async () => {
    const session = await admin();
    const response = await app.inject({
      method: 'POST',
      url: `${P}/users/${USER_PLAIN}/activate`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Администрирование закрыто для всех, кроме администратора
// =====================================================================

describe('ни один эндпоинт администрирования не доступен инженеру и подрядчику', () => {
  /**
   * Проверяется каждый маршрут, а не один показательный.
   *
   * Право стоит на маршруте (`requirePermission`), то есть забыть его можно
   * ровно в одном месте — при регистрации нового эндпоинта. Проверка «GET /users
   * закрыт» об этом не узнает никогда, а цена пропуска — доступ подрядчика к
   * ролям, настройкам и промтам портала.
   */
  async function expectAllForbidden(kcSub: string): Promise<void> {
    const session = await sessionFor(kcSub);
    for (const probe of ADMIN_PROBES) {
      const response = await call(probe.method, probe.url, session, probe.body);
      expect({
        role: kcSub,
        method: probe.method,
        url: probe.url,
        status: response.statusCode,
      }).toEqual({ role: kcSub, method: probe.method, url: probe.url, status: 403 });
    }
  }

  it('инженер получает 403 на каждом маршруте администрирования', async () => {
    await expectAllForbidden(KC.engineer);
  });

  it('подрядчик получает 403 на каждом маршруте администрирования', async () => {
    await expectAllForbidden(KC.contractor);
  });

  it('руководитель тоже: старшая бизнес-роль не является администрированием', async () => {
    // §4.1 разделяет бизнес-согласование и администрирование намеренно:
    // `manager` согласует ИД, но не выдаёт права и не публикует правила.
    await expectAllForbidden(KC.manager);
  });

  it('ни одна проба ничего не изменила', async () => {
    // 403 сам по себе не доказывает, что запись не прошла: отказать мог хук
    // после обработчика. Поэтому сверяется состояние, к которому пробы
    // прикасались.
    const card = await asAdmin('GET', `${P}/users/${USER_PLAIN}`);
    expect(
      card.json<{ user: { roles: string[]; contractorId: string | null; isActive: boolean } }>(),
    ).toMatchObject({ user: { roles: [], contractorId: null, isActive: true } });

    const settings = await asAdmin('GET', `${P}/settings`);
    const aiEnabled = settings
      .json<{ settings: { key: string; isDefault: boolean }[] }>()
      .settings.find((entry) => entry.key === 'ai.enabled');
    expect(aiEnabled?.isDefault).toBe(true);

    const prompts = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM prompt_templates WHERE code = '${SWEEP_PROMPT_CODE}'`,
    );
    expect(prompts[0]?.total).toBe('0');

    const rulesets = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ruleset_versions WHERE version = '${SWEEP_RULESET_VERSION}'`,
    );
    expect(rulesets[0]?.total).toBe('0');
  });
});

// =====================================================================
// Права и области действуют в том же процессе
// =====================================================================

/**
 * Здесь проверяется отсутствие кэша прав.
 *
 * Область видимости собирается `buildScope()` в хуке `onRequest` на КАЖДОМ
 * запросе, и это решение стоит проверять именно так — снаружи и на живой
 * сессии. Кэш прав, который не сбрасывается снятием роли, опаснее его
 * отсутствия: администратор видит, что роль снята, а пользователь продолжает
 * работать до истечения сессии, и в журнале это выглядит как штатные действия.
 */
describe('назначение и снятие бизнес-роли действуют без повторного входа', () => {
  it('роль выдана — доступ появился, роль снята — доступ пропал в той же сессии', async () => {
    // Сессия открыта ДО выдачи роли: именно она и не должна ничего запомнить.
    const session = await sessionFor(KC.promoted);

    const before = await call('GET', `${P}/users?limit=5`, session);
    expect(before.statusCode).toBe(403);
    expect(before.json<{ detail: string }>().detail).toContain('Права в портале не назначены');

    const granted = await asAdmin('PUT', `${P}/users/${USER_PROMOTED}/roles`, { roles: ['admin'] });
    expect(granted.statusCode).toBe(200);

    const afterGrant = await call('GET', `${P}/users?limit=5`, session);
    expect(afterGrant.statusCode).toBe(200);

    const revoked = await asAdmin('PUT', `${P}/users/${USER_PROMOTED}/roles`, { roles: [] });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<{ user: { roles: string[] } }>().user.roles).toEqual([]);

    const afterRevoke = await call('GET', `${P}/users?limit=5`, session);
    expect(afterRevoke.statusCode).toBe(403);
    expect(afterRevoke.json<{ detail: string }>().detail).toContain('Права в портале не назначены');
  });

  it('сессия при этом остаётся действующей, а /me показывает актуальные роли', async () => {
    const session = await sessionFor(KC.promoted);

    // 403 выше — это «прав нет», а не «войдите заново»: /me обязан работать,
    // иначе пользователь не увидит причину и уйдёт в бесконечный вход.
    const withoutRoles = await call('GET', '/me', session);
    expect(withoutRoles.statusCode).toBe(200);
    expect(withoutRoles.json<{ roles: string[]; denial: string | null }>()).toMatchObject({
      roles: [],
      denial: 'no-business-role',
    });

    await asAdmin('PUT', `${P}/users/${USER_PROMOTED}/roles`, { roles: ['engineer', 'manager'] });

    const withRoles = await call('GET', '/me', session);
    expect(withRoles.json<{ roles: string[] }>().roles.sort()).toEqual(['engineer', 'manager']);
    expect(withRoles.json<{ denial: string | null }>().denial).toBeNull();

    await asAdmin('PUT', `${P}/users/${USER_PROMOTED}/roles`, { roles: [] });
  });
});

/**
 * Область видимости по объектам снята (S37).
 *
 * Прежде здесь стояли два сценария: «инженер без объектов не видит справочник;
 * после назначения — видит сразу» и «снятие области закрывает выборку так же
 * немедленно». Оба проверяли маршрут `PUT /users/{id}/object-scopes`, которого
 * больше нет вместе с самими областями.
 *
 * Набор оставлен и перевёрнут: он сторожит, что справочник открыт инженеру БЕЗ
 * всяких назначений, и что `/me` не обещает клиенту перечня объектов, которого
 * сервер ничем не подкрепляет.
 */
describe('справочник открыт инженеру без назначений', () => {
  const OBJECTS = '/api/v1/catalog/objects';

  it('инженер видит справочник сразу, без назначения объектов', async () => {
    const session = await sessionFor(KC.scoped);

    const response = await call('GET', OBJECTS, session);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(
      OBJECT_1,
    );
  });

  it('область в /me называет только организацию, и та у инженера пуста', async () => {
    const session = await sessionFor(KC.scoped);

    const me = await call('GET', '/me', session);
    expect(me.json<{ scope: unknown }>().scope).toEqual({
      kind: 'engineer',
      contractorId: null,
    });
  });
});

describe('деактивация закрывает доступ существующей сессии', () => {
  it('отключённый пользователь получает 403 с причиной, а не 401 и не 200', async () => {
    const session = await sessionFor(KC.suspended);

    const before = await call('GET', '/api/v1/catalog/objects', session);
    expect(before.statusCode).toBe(200);

    const off = await asAdmin('POST', `${P}/users/${USER_SUSPENDED}/deactivate`);
    if (off.statusCode !== 200) throw new Error('BODY ' + off.body);
    expect(off.statusCode).toBe(200);
    expect(off.json<{ user: { isActive: boolean } }>().user.isActive).toBe(false);

    const denied = await call('GET', '/api/v1/catalog/objects', session);
    // 403, а не 401: вход состоялся и повторять его бессмысленно, пока
    // администратор не включит учётную запись обратно.
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ detail: string }>().detail).toContain('отключена');

    const me = await call('GET', '/me', session);
    expect(me.statusCode).toBe(200);
    expect(me.json<{ denial: string | null }>().denial).toBe('inactive');
  });

  it('повторный вход отключённой учётной записи не выдаёт сессию', async () => {
    // Иначе отключение было бы отменяемо самим пользователем: вход через
    // Keycloak — это upsert строки `users`, и он не имеет права включать
    // отключённого обратно.
    const started = await app.inject({
      method: 'GET',
      url: `/auth/login?devSub=${encodeURIComponent(KC.suspended)}`,
    });
    const authorizationUrl = new URL(locationOf(started));
    const completed = await app.inject({
      method: 'GET',
      url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
      headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
    });

    expect(completed.statusCode).toBe(302);
    expect(locationOf(completed)).toContain('auth_error=inactive');
    expect(
      completed.cookies.some((cookie) => cookie.name === SESSION_COOKIE && cookie.value !== ''),
    ).toBe(false);

    const stored = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM users WHERE id = '${USER_SUSPENDED}'`,
    );
    expect(stored[0]?.is_active).toBe(false);
  });

  it('включение обратно возвращает доступ той же сессии', async () => {
    const session = await sessionFor(KC.suspended);

    const on = await asAdmin('POST', `${P}/users/${USER_SUSPENDED}/activate`);
    expect(on.statusCode).toBe(200);

    const restored = await call('GET', '/api/v1/catalog/objects', session);
    expect(restored.statusCode).toBe(200);
  });
});

// =====================================================================
// Пользователи
// =====================================================================

describe('пользователи: роли, области, организация, активность', () => {
  it('роль contractor без организации отклоняется', async () => {
    const response = await asAdmin('PUT', `${P}/users/${USER_PLAIN}/roles`, {
      roles: ['contractor'],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('организации');
  });

  it('contractor не совмещается с другими ролями', async () => {
    const response = await asAdmin('PUT', `${P}/users/${USER_PLAIN}/roles`, {
      roles: ['contractor', 'engineer'],
    });
    expect(response.statusCode).toBe(422);
  });

  it('организация подрядчика назначается, после чего роль проходит', async () => {
    const assigned = await asAdmin('PUT', `${P}/users/${USER_PLAIN}/contractor`, {
      contractorId: ORG_CONTRACTOR,
    });
    expect(assigned.statusCode).toBe(200);

    const roles = await asAdmin('PUT', `${P}/users/${USER_PLAIN}/roles`, {
      roles: ['contractor'],
    });
    expect(roles.statusCode).toBe(200);
    expect(roles.json<{ user: { roles: string[] } }>().user.roles).toEqual(['contractor']);
  });

  it('поставщик организацией подрядчика быть не может', async () => {
    const response = await asAdmin('PUT', `${P}/users/${USER_PLAIN}/contractor`, {
      contractorId: ORG_SUPPLIER,
    });
    expect(response.statusCode).toBe(422);
  });

  it('снять организацию у пользователя с ролью contractor нельзя', async () => {
    const response = await asAdmin('PUT', `${P}/users/${USER_PLAIN}/contractor`, {
      contractorId: null,
    });
    expect(response.statusCode).toBe(409);
  });

  it('маршрут назначения областей снят вместе с самими областями', async () => {
    // 404 от МАРШРУТИЗАТОРА, а не от обработчика: снятая возможность обязана
    // исчезнуть целиком, иначе администратор продолжал бы «назначать» области,
    // которые ничего не ограничивают.
    const response = await asAdmin('PUT', `${P}/users/${USER_ENGINEER}/object-scopes`, {
      objectIds: [OBJECT_1],
    });
    expect(response.statusCode).toBe(404);
  });

  it('администратор не может снять роль admin с себя и отключить себя', async () => {
    const roles = await asAdmin('PUT', `${P}/users/${USER_ADMIN}/roles`, { roles: ['manager'] });
    expect(roles.statusCode).toBe(409);

    const deactivate = await asAdmin('POST', `${P}/users/${USER_ADMIN}/deactivate`);
    expect(deactivate.statusCode).toBe(409);
  });

  it('другого администратора отключить можно, потом включить обратно', async () => {
    const off = await asAdmin('POST', `${P}/users/${USER_ADMIN_SECOND}/deactivate`);
    expect(off.statusCode).toBe(200);
    expect(off.json<{ user: { isActive: boolean } }>().user.isActive).toBe(false);

    const on = await asAdmin('POST', `${P}/users/${USER_ADMIN_SECOND}/activate`);
    expect(on.statusCode).toBe(200);
    expect(on.json<{ user: { isActive: boolean } }>().user.isActive).toBe(true);
  });

  it('несуществующий пользователь — 404', async () => {
    const response = await asAdmin('GET', `${P}/users/${id(998)}`);
    expect(response.statusCode).toBe(404);
  });
});

// =====================================================================
// Настройки и секреты
// =====================================================================

describe('настройки: секреты не хранятся и не отдаются', () => {
  it('в выдаче настроек нет ни одного значения секрета', async () => {
    const response = await asAdmin('GET', `${P}/settings`);
    expect(response.statusCode).toBe(200);

    expect(response.body).not.toContain(PROXY_LLM_TOKEN_VALUE);
    expect(response.body).not.toContain(RDWEB_PASSWORD_VALUE);

    const body = response.json<{
      settings: { key: string; isDefault: boolean }[];
      secrets: { key: string; reference: string; configured: boolean; masked: string | null }[];
      integrations: { name: string; status: string; verified: boolean }[];
    }>();

    expect(body.settings.map((entry) => entry.key).sort()).toEqual([...SETTING_KEYS].sort());
    expect(body.secrets.map((entry) => entry.key).sort()).toEqual(
      Object.keys(SECRET_SETTINGS).sort(),
    );

    const token = body.secrets.find((entry) => entry.key === 'ai.proxy_llm_token');
    expect(token).toMatchObject({ reference: 'env:PROXY_LLM_TOKEN', configured: true });
    expect(token?.masked).not.toContain('llm-token');

    const oidc = body.secrets.find((entry) => entry.key === 'auth.oidc_client_secret');
    expect(oidc).toMatchObject({ configured: false, masked: null });

    // Статус подключения есть, но «проверено» не заявляется никогда.
    expect(body.integrations.every((entry) => entry.verified === false)).toBe(true);
    expect(body.integrations.find((entry) => entry.name === 'proxy_llm')?.status).toBe(
      'configured',
    );
    expect(body.integrations.find((entry) => entry.name === 'oidc')?.status).toBe('disabled');
    expect(body.integrations.find((entry) => entry.name === 'storage')?.status).toBe('disabled');
  });

  it('запись объявленного секретного ключа отклоняется с указанием переменной', async () => {
    const response = await asAdmin('PUT', `${P}/settings/ai.proxy_llm_token`, {
      value: 'another-token',
    });
    expect(response.statusCode).toBe(422);
    const body = response.json<{ detail: string; errors: { message: string }[] }>();
    expect(body.detail).toContain('окружении');
    expect(body.errors[0]?.message).toContain('PROXY_LLM_TOKEN');
  });

  it('незарегистрированный ключ с секретным именем тоже отклоняется', async () => {
    for (const key of ['rdweb.api_key', 'integration.password', 'llm.access_token']) {
      expect(looksSecret(key)).toBe(true);
      const response = await asAdmin('PUT', `${P}/settings/${key}`, { value: 'x' });
      expect(response.statusCode).toBe(422);
    }
  });

  it('ни один объявленный несекретный ключ не выглядит секретным', () => {
    for (const key of SETTING_KEYS) {
      expect(looksSecret(key)).toBe(false);
    }
  });

  it('незнакомый ключ — 404, ключ под управлением своего эндпоинта — 409', async () => {
    const unknown = await asAdmin('PUT', `${P}/settings/portal.unknown_thing`, { value: 1 });
    expect(unknown.statusCode).toBe(404);

    const managed = await asAdmin('PUT', `${P}/settings/ruleset.active_version_id`, {
      value: id(500),
    });
    expect(managed.statusCode).toBe(409);
    expect(managed.json<{ detail: string }>().detail).toContain('activate');
  });

  it('значение проверяется схемой ключа и сохраняется', async () => {
    const wrong = await asAdmin('PUT', `${P}/settings/ai.enabled`, { value: 'да' });
    expect(wrong.statusCode).toBe(422);

    const written = await asAdmin('PUT', `${P}/settings/ai.enabled`, { value: true });
    expect(written.statusCode).toBe(200);
    expect(written.json<{ value: boolean; isDefault: boolean }>()).toMatchObject({
      value: true,
      isDefault: false,
    });

    const listed = await asAdmin('GET', `${P}/settings`);
    const entry = listed
      .json<{ settings: { key: string; value: unknown; updatedBy: string | null }[] }>()
      .settings.find((item) => item.key === 'ai.enabled');
    expect(entry).toMatchObject({ value: true, updatedBy: USER_ADMIN });
  });
});

// =====================================================================
// Промты
// =====================================================================

interface PromptResponse {
  id: string;
  code: string;
  version: number;
  state: string;
  publishedAt: string | null;
  systemPrompt: string;
}

describe('промты: draft → test → published → archived и откат', () => {
  const CODE = 'page_classify_default';
  let first: PromptResponse;
  let second: PromptResponse;

  it('черновик создаётся первой версией', async () => {
    const response = await asAdmin('POST', `${P}/prompts`, {
      code: CODE,
      stage: 'page_classify',
      docTypeCode: null,
      systemPrompt: 'Определи роль страницы.',
      userTemplate: 'Текст страницы: {{text}}',
      outputSchema: { type: 'object' },
      modelOverride: null,
    });
    expect(response.statusCode).toBe(201);
    first = response.json<PromptResponse>();
    expect(first).toMatchObject({ version: 1, state: 'draft', publishedAt: null });
  });

  it('привязка к несуществующему виду ИД отклоняется', async () => {
    const response = await asAdmin('POST', `${P}/prompts`, {
      code: 'extract_unknown_type',
      stage: 'extract',
      docTypeCode: 'no_such_doc_type',
      systemPrompt: 'x',
      userTemplate: 'y',
      outputSchema: null,
      modelOverride: null,
    });
    expect(response.statusCode).toBe(422);
  });

  it('публикация из черновика запрещена: нужна стадия test', async () => {
    const response = await asAdmin('POST', `${P}/prompts/${first.id}/state`, {
      to: 'published',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('test');
  });

  it('переход в то же состояние отклоняется', async () => {
    const response = await asAdmin('POST', `${P}/prompts/${first.id}/state`, { to: 'draft' });
    expect(response.statusCode).toBe(409);
  });

  it('черновик правится, публикуется через test и получает отметку публикации', async () => {
    const patched = await asAdmin('PATCH', `${P}/prompts/${first.id}`, {
      systemPrompt: 'Определи роль страницы по её тексту.',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<PromptResponse>().systemPrompt).toContain('по её тексту');

    const toTest = await asAdmin('POST', `${P}/prompts/${first.id}/state`, { to: 'test' });
    expect(toTest.statusCode).toBe(200);
    expect(toTest.json<{ kind: string }>().kind).toBe('promote');

    const published = await asAdmin('POST', `${P}/prompts/${first.id}/state`, {
      to: 'published',
    });
    expect(published.statusCode).toBe(200);
    const body = published.json<{
      kind: string;
      archivedTemplateId: string | null;
      template: PromptResponse;
    }>();
    expect(body.kind).toBe('publish');
    expect(body.archivedTemplateId).toBeNull();
    expect(body.template.publishedAt).not.toBeNull();
    first = body.template;
  });

  /**
   * §0.5 п. 6 проверяется на том, что РЕАЛЬНО уедет провайдеру.
   *
   * Прежняя проверка сканировала тексты по умолчанию, то есть доказывала, что
   * автор файла ничего не нарушил. Боевой промт заполняет администратор, и
   * запрет обязан стоять на его пути — иначе «промт не знает раздела работ»
   * остаётся утверждением о репозитории, а не о системе.
   */
  it('промт с названием раздела работ не публикуется', async () => {
    const created = await asAdmin('POST', `${P}/prompts`, {
      code: 'page_classify_section_leak',
      stage: 'page_classify',
      docTypeCode: null,
      systemPrompt: 'Ты классифицируешь страницы комплекта по разделу 2.5.1 «Кровля автостоянки».',
      userTemplate: 'Текст: {{text}}',
      outputSchema: null,
      modelOverride: null,
    });
    expect(created.statusCode).toBe(201);
    const leaking = created.json<PromptResponse>();

    // До публикации черновик правится свободно: итеративная работа не должна
    // упираться в запрет на каждом сохранении.
    await asAdmin('POST', `${P}/prompts/${leaking.id}/state`, { to: 'test' });

    const published = await asAdmin('POST', `${P}/prompts/${leaking.id}/state`, {
      to: 'published',
    });
    expect(published.statusCode).toBe(422);
    expect(published.json<{ detail: string }>().detail).toContain('раздел работ');

    // Отказ называет КАЖДЫЙ найденный маркер: «что-то не так» инженер чинит
    // наугад.
    const errors = published.json<{ errors?: { code: string; message: string }[] }>().errors ?? [];
    expect(errors.map((error) => error.code)).toContain('section-marker-in-prompt');
    expect(errors.some((error) => error.message.includes('кровля'))).toBe(true);

    // Состояние не изменилось: отказ не оставил промт наполовину опубликованным.
    const fresh = await asAdmin('GET', `${P}/prompts/${leaking.id}`);
    expect(fresh.json<PromptResponse>().state).toBe('test');
  });

  it('маркер в ШАБЛОНЕ, а не в системной части, тоже ловится', async () => {
    const created = await asAdmin('POST', `${P}/prompts`, {
      code: 'page_classify_template_leak',
      stage: 'page_classify',
      docTypeCode: null,
      systemPrompt: 'Определи роль страницы по её тексту.',
      userTemplate: 'Комплект по армированию. Текст: {{text}}',
      outputSchema: null,
      modelOverride: null,
    });
    const leaking = created.json<PromptResponse>();
    await asAdmin('POST', `${P}/prompts/${leaking.id}/state`, { to: 'test' });

    const published = await asAdmin('POST', `${P}/prompts/${leaking.id}/state`, {
      to: 'published',
    });
    expect(published.statusCode).toBe(422);
  });

  it('опубликованная версия не правится — 409, а не 500', async () => {
    const response = await asAdmin('PATCH', `${P}/prompts/${first.id}`, {
      systemPrompt: 'подмена текста опубликованного промта',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('неизменяем');
  });

  it('публикация второй версии переводит первую в archived', async () => {
    const created = await asAdmin('POST', `${P}/prompts`, {
      code: CODE,
      stage: 'page_classify',
      docTypeCode: null,
      systemPrompt: 'Вторая редакция промта.',
      userTemplate: 'Текст: {{text}}',
      outputSchema: null,
      modelOverride: null,
    });
    expect(created.statusCode).toBe(201);
    second = created.json<PromptResponse>();
    expect(second.version).toBe(2);

    await asAdmin('POST', `${P}/prompts/${second.id}/state`, { to: 'test' });
    const published = await asAdmin('POST', `${P}/prompts/${second.id}/state`, {
      to: 'published',
    });
    expect(published.statusCode).toBe(200);
    expect(published.json<{ archivedTemplateId: string | null }>().archivedTemplateId).toBe(
      first.id,
    );

    const previous = await asAdmin('GET', `${P}/prompts/${first.id}`);
    expect(previous.json<PromptResponse>().state).toBe('archived');
  });

  it('архивную версию править нельзя: иначе откат вернул бы другой текст', async () => {
    const response = await asAdmin('PATCH', `${P}/prompts/${first.id}`, {
      systemPrompt: 'подмена текста архивной версии',
    });
    expect(response.statusCode).toBe(409);
  });

  it('откат публикует прежнюю версию и архивирует действующую', async () => {
    const rolled = await asAdmin('POST', `${P}/prompts/${first.id}/state`, { to: 'published' });
    expect(rolled.statusCode).toBe(200);
    const body = rolled.json<{ kind: string; archivedTemplateId: string | null }>();
    expect(body.kind).toBe('rollback');
    expect(body.archivedTemplateId).toBe(second.id);

    // Инвариант «одна опубликованная версия на код» держится после отката.
    const listed = await asAdmin('GET', `${P}/prompts?code=${CODE}&limit=50`);
    const states = listed
      .json<{ items: PromptResponse[] }>()
      .items.filter((item) => item.state === 'published');
    expect(states.map((item) => item.id)).toEqual([first.id]);
  });

  /**
   * Второй рубеж — триггер БД — обязан распознаваться как 409.
   *
   * Через HTTP до него не дойти: условие состояния стоит в самом UPDATE, и
   * триггер срабатывает только при гонке или правке в обход API. Поэтому
   * проверяется то, от чего зависит ответ, — что код ошибки вообще извлекается.
   * Drizzle оборачивает ошибку драйвера в свою, и до правки `pgErrorCode()`
   * код не находился, то есть штатный запрет отдавал бы 500.
   */
  it('отказ триггера неизменяемости распознаётся как restrict_violation', async () => {
    const failure: unknown = await app.db
      .update(promptTemplates)
      .set({ systemPrompt: 'правка опубликованного промта в обход API' })
      .where(eq(promptTemplates.id, first.id))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).not.toBeNull();
    expect(pgErrorCode(failure)).toBe(PG_RESTRICT_VIOLATION);
  });

  it('текст откатанной версии не изменился ни на одном шаге', async () => {
    const current = await asAdmin('GET', `${P}/prompts/${first.id}`);
    expect(current.json<PromptResponse>().systemPrompt).toBe(
      'Определи роль страницы по её тексту.',
    );
  });

  /**
   * И тот же отказ, дошедший до обработчика, обязан стать 409 с объяснением.
   *
   * Проверка идёт в два шага, потому что через HTTP триггер недостижим (условие
   * состояния стоит в самом UPDATE). Сначала настоящий отказ БД получается
   * прямым SQL, затем ЭТА ЖЕ ошибка подставляется в штатный запрос правки
   * черновика. Так проверяется не выдуманный код ошибки, а перевод реального
   * отказа PostgreSQL в ответ API: без него администратор получал бы 500 на
   * штатно запрещённой операции, а в `error_events` копились бы записи о
   * «внутренней ошибке», которой нет.
   */
  it('отказ триггера, дошедший до обработчика, отдаётся как 409 с объяснением', async () => {
    const rejection = await db
      .query(
        `UPDATE prompt_templates SET system_prompt = 'правка в обход API'
          WHERE id = '${first.id}'`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejection).not.toBeNull();
    expect(pgErrorCode(rejection)).toBe(PG_RESTRICT_VIOLATION);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('опубликованный промт');

    const draft = await asAdmin('POST', `${P}/prompts`, {
      code: CODE,
      stage: 'page_classify',
      docTypeCode: null,
      systemPrompt: 'Третья редакция промта.',
      userTemplate: 'Текст: {{text}}',
      outputSchema: null,
      modelOverride: null,
    });
    expect(draft.statusCode).toBe(201);
    const draftId = draft.json<PromptResponse>().id;

    armFault(/update "prompt_templates"/i, rejection as Error);
    const patched = await asAdmin('PATCH', `${P}/prompts/${draftId}`, {
      systemPrompt: 'правка, которую отвергнет триггер',
    });

    // Подстановка обязана была сработать: иначе проверялся бы штатный путь.
    expect(faultArmed()).toBe(false);
    expect(patched.statusCode).toBe(409);
    expect(patched.json<{ detail: string }>().detail).toContain('новой версии');

    // Транзакция откатилась целиком: текст черновика прежний.
    const reread = await asAdmin('GET', `${P}/prompts/${draftId}`);
    expect(reread.json<PromptResponse>().systemPrompt).toBe('Третья редакция промта.');
  });
});

// =====================================================================
// Набор правил
// =====================================================================

interface RulesetResponse {
  id: string;
  version: string;
  state: string;
  ruleCount: number;
  isActive: boolean;
}

describe('набор правил: атомарная публикация версии со снимком', () => {
  let published: RulesetResponse;

  it('реестр правил доступен администратору и совпадает с каталогом реализаций', async () => {
    // До S9 здесь сравнивались две строки фикстуры. Теперь реестр заполняет
    // сид 0017 из `RULE_CATALOG`, и осмысленное утверждение другое: выдача
    // обязана СОВПАДАТЬ с каталогом реализаций, потому что расхождение — это
    // правило, которое администратор видит и включает, а движок не исполняет.
    const response = await asAdmin('GET', `${P}/rules`);
    expect(response.statusCode).toBe(200);

    const codes = response.json<{ items: { code: string }[] }>().items.map((item) => item.code);
    expect(codes).toEqual([...RULE_CODES].sort());
    expect(codes).toContain(RULE_A);
    expect(codes).toContain(RULE_B);

    // Снятое правило в списке не предлагается, хотя строка в БД осталась:
    // включённое, оно дало бы проверку, которую движок не исполняет (S30).
    for (const spec of RETIRED_RULES) expect(codes).not.toContain(spec.code);
  });

  it('версия публикуется вместе со снимком и становится действующей', async () => {
    const response = await asAdmin('POST', `${P}/rulesets`, {
      version: '2026.08.1',
      notes: 'Первый набор',
      activate: true,
      rules: [
        { ruleCode: RULE_A, severity: 'error', isBlocking: true },
        { ruleCode: RULE_B, severity: 'warning', params: { toleranceDays: 3 } },
      ],
    });
    expect(response.statusCode).toBe(201);
    published = response.json<RulesetResponse>();
    expect(published).toMatchObject({ state: 'published', ruleCount: 2, isActive: true });

    const detail = await asAdmin('GET', `${P}/rulesets/${published.id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{
      version: RulesetResponse;
      rules: { ruleCode: string; severity: string; isBlocking: boolean; params: unknown }[];
    }>();
    expect(body.rules.map((rule) => rule.ruleCode)).toEqual([RULE_A, RULE_B]);
    expect(body.rules.find((rule) => rule.ruleCode === RULE_B)?.params).toEqual({
      toleranceDays: 3,
    });
    expect(body.version.isActive).toBe(true);
  });

  it('указатель действующей версии лежит в app_settings и виден только через API', async () => {
    const rows = await db.query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'ruleset.active_version_id'`,
    );
    expect(rows[0]?.value).toBe(published.id);
  });

  it('повторная публикация той же метки версии — 409', async () => {
    const response = await asAdmin('POST', `${P}/rulesets`, {
      version: '2026.08.1',
      notes: null,
      rules: [{ ruleCode: RULE_A, severity: 'info' }],
    });
    expect(response.statusCode).toBe(409);

    // И снимок первой публикации не тронут.
    const detail = await asAdmin('GET', `${P}/rulesets/${published.id}`);
    expect(detail.json<{ rules: unknown[] }>().rules).toHaveLength(2);
  });

  it('неизвестный код правила отменяет публикацию целиком', async () => {
    const before = await db.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM ruleset_versions',
    );

    const response = await asAdmin('POST', `${P}/rulesets`, {
      version: '2026.08.2',
      notes: null,
      rules: [
        { ruleCode: RULE_A, severity: 'error' },
        { ruleCode: 'NO.SUCH.RULE', severity: 'error' },
      ],
    });
    expect(response.statusCode).toBe(422);

    // Главное: полупустого набора в БД не появилось — иначе прогон проверок мог
    // бы сослаться на версию без правил.
    const after = await db.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM ruleset_versions',
    );
    expect(after[0]?.total).toBe(before[0]?.total);
  });

  it('черновик версии действующим сделать нельзя', async () => {
    const draftId = id(700);
    await db.query(
      `INSERT INTO ruleset_versions (id, version) VALUES ('${draftId}', 'draft-only')`,
    );
    const response = await asAdmin('POST', `${P}/rulesets/${draftId}/activate`);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('опубликованную');
  });

  it('откат набора — переключение указателя на прежнюю версию', async () => {
    const next = await asAdmin('POST', `${P}/rulesets`, {
      version: '2026.09.1',
      notes: 'Второй набор',
      rules: [{ ruleCode: RULE_A, severity: 'warning' }],
    });
    expect(next.statusCode).toBe(201);
    const second = next.json<RulesetResponse>();
    expect(second.isActive).toBe(true);

    const rolled = await asAdmin('POST', `${P}/rulesets/${published.id}/activate`);
    expect(rolled.statusCode).toBe(200);
    expect(rolled.json<RulesetResponse>().isActive).toBe(true);

    const listed = await asAdmin('GET', `${P}/rulesets?limit=50`);
    const items = listed.json<{ items: RulesetResponse[] }>().items;
    expect(items.filter((item) => item.isActive).map((item) => item.id)).toEqual([published.id]);
    // Прежний снимок продолжает существовать: прогоны на него ссылаются.
    expect(items.find((item) => item.id === second.id)?.ruleCount).toBe(1);
  });

  it('снимок опубликованного набора неизменяем на уровне БД', async () => {
    const rejection = await db
      .query(
        `UPDATE ruleset_rules SET severity = 'info' WHERE ruleset_version_id = '${published.id}'`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).not.toBeNull();
    // Код важен не меньше самого отказа: по нему обработчик отличает штатный
    // запрет от поломки и отвечает 409, а не 500.
    expect(pgErrorCode(rejection)).toBe(PG_RESTRICT_VIOLATION);
    expect((rejection as Error).message).toContain('правило опубликованного набора');

    const severities = await db.query<{ severity: string }>(
      `SELECT severity FROM ruleset_rules WHERE ruleset_version_id = '${published.id}'
        ORDER BY rule_code`,
    );
    expect(severities.map((row) => row.severity)).toEqual(['error', 'warning']);
  });

  it('пополнить снимок опубликованного набора тоже нельзя', async () => {
    // Добавленное после публикации правило меняет результат прогона не меньше
    // изменённого, поэтому запрет распространяется и на INSERT.
    const rejection = await db
      .query(
        `INSERT INTO ruleset_rules (ruleset_version_id, rule_code, severity)
           VALUES ('${published.id}', '${RULE_B}', 'error')`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(pgErrorCode(rejection)).toBe(PG_RESTRICT_VIOLATION);

    const total = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ruleset_rules
        WHERE ruleset_version_id = '${published.id}'`,
    );
    expect(total[0]?.total).toBe('2');
  });
});

// =====================================================================
// Атомарность публикации набора правил
// =====================================================================

/**
 * Проверяется то, что нельзя проверить штатным отказом.
 *
 * Отмена публикации по неизвестному коду правила (выше) возвращается ДО первой
 * записи — она проверяет ветку кода, а не транзакцию. Настоящий вопрос: что
 * останется в БД, если публикация прервётся ПОСЛЕ создания версии и ДО того, как
 * снимок записан целиком. Версия с половиной правил — это прогон проверок,
 * результат которого невозможно ни воспроизвести, ни оспорить, поэтому ответ
 * обязан быть «ничего».
 *
 * Прерывание делается подстановкой ошибки в конкретный запрос (`armFault`), а не
 * отключением БД: нужно попасть именно в середину транзакции, между вставкой
 * версии и вставкой снимка.
 */
describe('публикация версии набора правил атомарна', () => {
  const INTERRUPTED_VERSION = '2026.10.1';
  const CONFLICTING_VERSION = '2026.10.2';
  let publishedId: string;

  interface Snapshot {
    readonly versions: string | undefined;
    readonly rules: string | undefined;
    readonly activePointer: unknown;
  }

  async function snapshot(): Promise<Snapshot> {
    const versions = await db.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM ruleset_versions',
    );
    const rules = await db.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM ruleset_rules',
    );
    const pointer = await db.query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'ruleset.active_version_id'`,
    );
    return {
      versions: versions[0]?.total,
      rules: rules[0]?.total,
      activePointer: pointer[0]?.value,
    };
  }

  it('прерванная публикация не оставляет ни версии, ни половины снимка', async () => {
    const before = await snapshot();

    startRecording();
    armFault(/insert into "ruleset_rules"/i, new Error('обрыв соединения посреди публикации'));
    const response = await asAdmin('POST', `${P}/rulesets`, {
      version: INTERRUPTED_VERSION,
      notes: 'публикация прерывается искусственно',
      activate: true,
      rules: [
        { ruleCode: RULE_A, severity: 'error', isBlocking: true },
        { ruleCode: RULE_B, severity: 'warning' },
      ],
    });
    const statements = [...recordedStatements()];
    stopRecording();

    expect(faultArmed()).toBe(false);
    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    // Текст внутренней ошибки наружу не пересказывается.
    expect(response.body).not.toContain('обрыв соединения');

    // Обрыв случился именно в середине транзакции: версия уже вставлена, снимок
    // вставлялся, после чего канал получил ROLLBACK.
    const versionInsert = statements.findIndex((sql) =>
      /insert into "ruleset_versions"/i.test(sql),
    );
    const rulesInsert = statements.findIndex((sql) => /insert into "ruleset_rules"/i.test(sql));
    const rollback = statements.findIndex((sql) => /^\s*rollback/i.test(sql));
    expect(versionInsert).toBeGreaterThanOrEqual(0);
    expect(rulesInsert).toBeGreaterThan(versionInsert);
    expect(rollback).toBeGreaterThan(rulesInsert);
    // COMMIT не отправлялся вовсе.
    expect(statements.some((sql) => /^\s*commit/i.test(sql))).toBe(false);

    expect(await snapshot()).toEqual(before);
  });

  it('метка прерванной версии осталась свободной: повтор публикации проходит', async () => {
    // Иначе прерывание было бы хуже отказа: администратор не смог бы
    // опубликовать набор под задуманным номером, а причина осталась бы невидимой.
    const retry = await asAdmin('POST', `${P}/rulesets`, {
      version: INTERRUPTED_VERSION,
      notes: 'повтор после обрыва',
      rules: [
        { ruleCode: RULE_A, severity: 'error', isBlocking: true },
        { ruleCode: RULE_B, severity: 'warning' },
      ],
    });
    expect(retry.statusCode).toBe(201);

    const version = retry.json<RulesetResponse>();
    expect(version).toMatchObject({ state: 'published', ruleCount: 2 });
    publishedId = version.id;

    const detail = await asAdmin('GET', `${P}/rulesets/${publishedId}`);
    expect(
      detail.json<{ rules: { ruleCode: string }[] }>().rules.map((rule) => rule.ruleCode),
    ).toEqual([RULE_A, RULE_B]);
  });

  it('отказ триггера снимка на публикации даёт 409, а не 500', async () => {
    const rejection = await db
      .query(
        `UPDATE ruleset_rules SET severity = 'info' WHERE ruleset_version_id = '${publishedId}'`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(pgErrorCode(rejection)).toBe(PG_RESTRICT_VIOLATION);
    expect(rejection).toBeInstanceOf(Error);

    // Тот же самый объект ошибки, полученный от настоящего триггера, попадает в
    // штатный путь публикации: проверяется перевод отказа БД в ответ API.
    armFault(/insert into "ruleset_rules"/i, rejection as Error);
    const response = await asAdmin('POST', `${P}/rulesets`, {
      version: CONFLICTING_VERSION,
      notes: null,
      rules: [{ ruleCode: RULE_A, severity: 'error' }],
    });

    expect(faultArmed()).toBe(false);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('неизменяема');

    const left = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ruleset_versions WHERE version = '${CONFLICTING_VERSION}'`,
    );
    expect(left[0]?.total).toBe('0');
  });
});

// =====================================================================
// Аудит
// =====================================================================

describe('журнал аудита', () => {
  it('каждое административное действие оставило запись', async () => {
    const rows = await db.query<{ action: string; actor_user_id: string }>(
      `SELECT DISTINCT action, actor_user_id FROM audit_log`,
    );
    const actions = new Set(rows.map((row) => row.action));

    for (const expected of [
      'user.roles_changed',
      'user.contractor_changed',
      'user.activated',
      'user.deactivated',
      'setting.updated',
      'prompt.created',
      'prompt.updated',
      'prompt.state_changed',
      'prompt.rolled_back',
      'ruleset.published',
      'ruleset.activated',
    ]) {
      expect(actions).toContain(expected);
    }

    expect(rows.every((row) => row.actor_user_id === USER_ADMIN)).toBe(true);
  });

  it('e-mail актора попал в журнал только отпечатком', async () => {
    const rows = await db.query<{ actor_email_hmac: string | null }>(
      `SELECT actor_email_hmac FROM audit_log WHERE action = 'ruleset.published' LIMIT 1`,
    );
    const hmac = rows[0]?.actor_email_hmac;
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmac).not.toContain('admin-primary');
  });
});

// Автомат состояний проверяется без БД, в `governance.test.ts`: набор переходов
// обязан быть вычислимым до запроса, иначе экран администрирования узнавал бы о
// запрете из 409.
