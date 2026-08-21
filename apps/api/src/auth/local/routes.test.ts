/**
 * Локальный вход целиком: приложение, поднятое с `AUTH_MODE=local` на настоящем
 * PostgreSQL (pglite).
 *
 * Что здесь проверяется в первую очередь и почему:
 *
 *   1. **Побайтовое совпадение отказов.** Ответ на несуществующий логин и на
 *      неверный пароль обязан быть неотличим. Это не придирка: различие хотя бы
 *      в одном байте превращает форму входа в список сотрудников.
 *   2. **`mustChangePassword` работает у пользователя БЕЗ роли.** Свежая учётная
 *      запись ролей не имеет, а сменить выданный пароль обязана. Реализация,
 *      читающая флаг из `authContext`, здесь молча не срабатывает.
 *   3. **Отсутствие маршрутов чужого режима.** `/auth/callback` в локальном
 *      режиме не должен существовать вовсе.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../session.js';
import { hashPassword } from './passwords.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'local',
  AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-local-tests-0123456789',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-local-tests-0123456789',
  CSRF_SECRET: 'csrf-secret-of-local-auth-tests-0123456789',
  // Стоимость снижена до минимально допустимой: файл выполняет десятки проверок
  // пароля, и боевые 240 мс на каждую превратили бы прогон в минуты.
  AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/local-auth-tests',
  // Тесты бьют десятками запросов с одного адреса: боевой предел превратил бы
  // проверку входа в проверку rate-limit. Лимиты самого входа проверяются
  // отдельным приложением с малыми значениями.
  RATE_LIMIT_MAX: '100000',
  AUTH_LOCAL_LOGIN_MAX_PER_IP: '100000',
  AUTH_LOCAL_REGISTER_MAX_PER_IP_HOUR: '100000',
  AUTH_LOCAL_PASSWORD_MAX_PER_HOUR: '100000',
});

const USER_ACTIVE = '00000000-0000-4000-8000-000000000001';
const USER_INACTIVE = '00000000-0000-4000-8000-000000000002';
const USER_TEMPORARY = '00000000-0000-4000-8000-000000000003';
const USER_FEDERATED = '00000000-0000-4000-8000-000000000004';

const LOGIN_ACTIVE = 'ivanov@example.ru';
const LOGIN_INACTIVE = 'petrov@example.ru';
const LOGIN_TEMPORARY = 'sidorov@example.ru';
const UNKNOWN_LOGIN = 'nikogo@example.ru';

const PASSWORD = 'Mostovoy-Kran-77!';
const NEW_PASSWORD = 'Betonnaya-Svaya-42!';

let db: TestDatabase;
let app: AppInstance;

/** Заголовки, при которых Origin-guard пропускает запрос как «свой». */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

async function seed(): Promise<void> {
  const hash = await hashPassword(TEST_ENV, PASSWORD);

  await db.query(
    `insert into users (id, kc_sub, email, full_name, is_active) values
       ($1, 'local:active',    $5, 'Иванов Иван',   true),
       ($2, 'local:inactive',  $6, 'Петров Пётр',   false),
       ($3, 'local:temporary', $7, 'Сидоров Семён', true),
       ($4, '8f0d1c2e-0000-4000-8000-000000000009', 'fed@example.ru', 'Федеративный', true)`,
    [
      USER_ACTIVE,
      USER_INACTIVE,
      USER_TEMPORARY,
      USER_FEDERATED,
      LOGIN_ACTIVE,
      LOGIN_INACTIVE,
      LOGIN_TEMPORARY,
    ],
  );
  await db.query(`insert into user_roles (user_id, role) values ($1, 'admin')`, [USER_ACTIVE]);

  for (const [userId, login, mustChange] of [
    [USER_ACTIVE, LOGIN_ACTIVE, false],
    [USER_INACTIVE, LOGIN_INACTIVE, false],
    // Пользователь с временным паролем И БЕЗ РОЛИ: именно на нём проверяется,
    // что принуждение к смене видно вне контекста бизнес-прав.
    [USER_TEMPORARY, LOGIN_TEMPORARY, true],
  ] as const) {
    await db.query(
      // Логин передаётся двумя параметрами, а не одним дважды: колонки имеют
      // разный тип (citext и text), и PostgreSQL отвергает один параметр,
      // выведенный сразу в оба («inconsistent types deduced for parameter»).
      `insert into user_credentials
         (user_id, login_key, login_display, password_hash, password_algorithm,
          must_change_password)
       values ($1::uuid, $2, $3, $4, $5, $6)`,
      [userId, login, login, hash.encoded, hash.algorithm, mustChange],
    );
  }
}

async function reset(): Promise<void> {
  await db.query('delete from auth_throttle');
  await db.query('delete from auth_sessions');
  await db.query('delete from audit_log');
  await db.query('delete from registration_requests');
  await db.query('delete from user_credentials');
  await db.query('delete from user_roles');
  await db.query('delete from users');
  await seed();
}

function login(
  body: Record<string, unknown>,
  headers: Record<string, string> = SAME_ORIGIN,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: body });
}

function cookieOf(response: LightMyRequestResponse, name: string): string | undefined {
  return response.cookies.find((cookie) => cookie.name === name)?.value;
}

/**
 * Идентификатор сессии из подписанной cookie.
 *
 * Значение cookie — `<uuid>.<подпись>`; в БД лежит только uuid. Без отделения
 * подписи запрос к auth_sessions падал бы на приведении к uuid.
 */
function sessionIdOf(signed: string): string {
  return signed.split('.')[0] ?? signed;
}

/** Вход и снятие cookie: дальше ими пользуются защищённые запросы. */
async function signIn(
  email: string,
  password = PASSWORD,
): Promise<{ session: string; csrf: string }> {
  const response = await login({ email, password });
  expect(response.statusCode, response.body).toBe(200);
  const session = cookieOf(response, SESSION_COOKIE);
  const csrf = cookieOf(response, CSRF_COOKIE);
  if (session === undefined || csrf === undefined) throw new Error('вход не выдал cookie');
  return { session, csrf };
}

function authHeaders(auth: { session: string; csrf: string }): Record<string, string> {
  return {
    ...SAME_ORIGIN,
    cookie: `${SESSION_COOKIE}=${auth.session}`,
    [CSRF_HEADER]: auth.csrf,
  };
}

/**
 * То же, но без `content-type`.
 *
 * Fastify отвергает пустое тело при объявленном `application/json` — и правильно
 * делает. Выход и обновление CSRF-токена тела не имеют.
 */
function authHeadersNoBody(auth: { session: string; csrf: string }): Record<string, string> {
  return {
    'sec-fetch-site': 'same-origin',
    cookie: `${SESSION_COOKIE}=${auth.session}`,
    [CSRF_HEADER]: auth.csrf,
  };
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  await seed();

  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(reset);

// =====================================================================
// Маршруты режима
// =====================================================================

describe('состав маршрутов', () => {
  it('redirect-поток не зарегистрирован', () => {
    // Отсутствующий маршрут нельзя вызвать по ошибке, забыв проверку режима.
    expect(app.hasRoute({ method: 'GET', url: '/auth/callback' })).toBe(false);
  });

  it('вход по ссылке ведёт на форму портала, а не на провайдера', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/login?returnTo=/objects' });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('http://localhost:3000/login?returnTo=%2Fobjects');
  });

  it('открытый редирект через returnTo невозможен', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/login?returnTo=https://evil.example',
    });

    expect(response.headers['location']).toBe('http://localhost:3000/login?returnTo=%2F');
  });

  it('признаки режима доступны без входа', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ registrationEnabled: true, passwordMinLength: 12 });
  });
});

// =====================================================================
// Вход
// =====================================================================

describe('вход', () => {
  it('выдаёт обе cookie и рабочую сессию', async () => {
    const response = await login({ email: LOGIN_ACTIVE, password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ redirectTo: '/' });
    expect(cookieOf(response, SESSION_COOKIE)).toBeDefined();
    expect(cookieOf(response, CSRF_COOKIE)).toBeDefined();

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${cookieOf(response, SESSION_COOKIE) ?? ''}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ authMode: 'local', mustChangePassword: false });
  });

  it('находит учётную запись независимо от регистра логина', async () => {
    const response = await login({ email: '  IVANOV@Example.RU ', password: PASSWORD });

    expect(response.statusCode).toBe(200);
  });

  it('уважает returnTo и отвергает чужой адрес', async () => {
    const local = await login({ email: LOGIN_ACTIVE, password: PASSWORD, returnTo: '/objects/1' });
    expect(local.json()).toEqual({ redirectTo: '/objects/1' });

    const foreign = await login({
      email: LOGIN_ACTIVE,
      password: PASSWORD,
      returnTo: 'https://evil.example',
    });
    expect(foreign.json()).toEqual({ redirectTo: '/' });
  });

  it('отвечает на неизвестный логин и на неверный пароль ПОБАЙТОВО одинаково', async () => {
    // Главная проверка файла: различие хотя бы в одном байте превращает форму
    // входа в способ узнать список сотрудников.
    const unknown = await login({ email: UNKNOWN_LOGIN, password: PASSWORD });
    const wrong = await login({ email: LOGIN_ACTIVE, password: 'Sovsem-Drugoy-99!' });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);

    // `requestId` у каждого запроса свой и об учётной записи не говорит ничего;
    // всё остальное обязано совпасть до байта.
    const strip = (body: string): string =>
      JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), requestId: null });
    expect(strip(unknown.body)).toBe(strip(wrong.body));
    expect(unknown.headers['content-length']).toBe(wrong.headers['content-length']);
  });

  it('федеративная учётная запись войти паролем не может', async () => {
    // Пароля у неё нет по построению: триггер миграции не даёт его завести.
    const response = await login({ email: 'fed@example.ru', password: PASSWORD });

    expect(response.statusCode).toBe(401);
  });

  it('неактивной учётной записи отказывает внятно и сессии не создаёт', async () => {
    // Верный пароль уже предъявлен, значит перед нами владелец, а не перебор:
    // молчаливый отказ отправил бы его подбирать верный пароль.
    const response = await login({ email: LOGIN_INACTIVE, password: PASSWORD });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ detail: expect.stringContaining('не активирована') });

    const sessions = await db.query('select id from auth_sessions');
    expect(sessions).toHaveLength(0);
  });

  it('не принимает форму с чужого источника', async () => {
    const response = await login(
      { email: LOGIN_ACTIVE, password: PASSWORD },
      { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    );

    expect(response.statusCode).toBe(403);
  });

  it('не принимает чужой Origin, когда Fetch Metadata недоступна', async () => {
    const response = await login(
      { email: LOGIN_ACTIVE, password: PASSWORD },
      { origin: 'https://evil.example', 'content-type': 'application/json' },
    );

    expect(response.statusCode).toBe(403);
  });

  it('принимает свой Origin', async () => {
    const response = await login(
      { email: LOGIN_ACTIVE, password: PASSWORD },
      { origin: 'http://localhost:3000', 'content-type': 'application/json' },
    );

    expect(response.statusCode).toBe(200);
  });

  it('не принимает тело, отправленное HTML-формой', async () => {
    // Такая форма уходит с чужой страницы без предварительного запроса CORS.
    const response = await login(
      { email: LOGIN_ACTIVE, password: PASSWORD },
      { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
    );

    expect(response.statusCode).toBe(415);
  });

  it('меняет идентификатор сессии: подсунутая сессия не переживает вход', async () => {
    const first = await signIn(LOGIN_ACTIVE);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...SAME_ORIGIN, cookie: `${SESSION_COOKIE}=${first.session}` },
      payload: { email: LOGIN_ACTIVE, password: PASSWORD },
    });

    expect(cookieOf(second, SESSION_COOKIE)).not.toBe(first.session);

    const revoked = await db.query<{ revoked_at: unknown }>(
      'select revoked_at from auth_sessions where id = $1',
      [sessionIdOf(first.session)],
    );
    expect(revoked[0]?.revoked_at).not.toBeNull();
  });

  it('обновляет отметку последнего входа', async () => {
    await signIn(LOGIN_ACTIVE);

    const rows = await db.query<{ last_login_at: unknown }>(
      'select last_login_at from users where id = $1',
      [USER_ACTIVE],
    );
    expect(rows[0]?.last_login_at).not.toBeNull();
  });
});

// =====================================================================
// Принуждение к смене пароля
// =====================================================================

describe('временный пароль', () => {
  it('виден в /me у пользователя без роли', async () => {
    // Регресс дефекта: флаг, прочитанный из authContext, у беспра́вного
    // пользователя отсутствовал бы — а это ровно тот, кому смена и предписана.
    const auth = await signIn(LOGIN_TEMPORARY);
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${auth.session}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ mustChangePassword: true, scope: null });
  });

  it('закрывает работу в портале до смены', async () => {
    const auth = await signIn(LOGIN_TEMPORARY);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: authHeaders(auth),
    });

    expect(response.statusCode).toBe(403);
  });

  it('оставляет доступными выход, CSRF и саму смену', async () => {
    const auth = await signIn(LOGIN_TEMPORARY);

    const csrf = await app.inject({
      method: 'POST',
      url: '/auth/csrf',
      headers: authHeadersNoBody(auth),
    });
    expect(csrf.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...authHeadersNoBody(auth), [CSRF_HEADER]: csrf.json().csrfToken as string },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ endSessionUrl: null });
  });

  it('снимается после смены пароля', async () => {
    const auth = await signIn(LOGIN_TEMPORARY);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(auth),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(changed.statusCode, changed.body).toBe(200);
    const next = cookieOf(changed, SESSION_COOKIE);
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${next ?? ''}` },
    });
    expect(me.json()).toMatchObject({ mustChangePassword: false });
  });
});

// =====================================================================
// Смена пароля
// =====================================================================

describe('смена пароля', () => {
  it('отзывает прочие сессии и оставляет текущую вкладку рабочей', async () => {
    const other = await signIn(LOGIN_ACTIVE);
    const current = await signIn(LOGIN_ACTIVE);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(current),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);

    // Прежняя сессия мертва...
    const stale = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${other.session}` },
    });
    expect(stale.statusCode).toBe(401);

    // ...а выданная вместе с ответом — жива.
    const fresh = cookieOf(response, SESSION_COOKIE);
    const alive = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${fresh ?? ''}` },
    });
    expect(alive.statusCode).toBe(200);
  });

  it('новый пароль работает, прежний перестаёт', async () => {
    const auth = await signIn(LOGIN_ACTIVE);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(auth),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect((await login({ email: LOGIN_ACTIVE, password: NEW_PASSWORD })).statusCode).toBe(200);
    expect((await login({ email: LOGIN_ACTIVE, password: PASSWORD })).statusCode).toBe(401);
  });

  it('требует верный текущий пароль', async () => {
    const auth = await signIn(LOGIN_ACTIVE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(auth),
      payload: { currentPassword: 'Ne-Tot-Parol-42!', newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it('отвергает слабый пароль со списком причин', async () => {
    const auth = await signIn(LOGIN_ACTIVE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(auth),
      payload: { currentPassword: PASSWORD, newPassword: 'password123456' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().errors.length).toBeGreaterThan(0);
  });

  it('отвергает повтор прежнего пароля', async () => {
    const auth = await signIn(LOGIN_ACTIVE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(auth),
      payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toContain('совпадает с текущим');
  });

  it('без сессии недоступна', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: SAME_ORIGIN,
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it('требует CSRF-токен', async () => {
    const auth = await signIn(LOGIN_ACTIVE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { ...SAME_ORIGIN, cookie: `${SESSION_COOKIE}=${auth.session}` },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Регистрация
// =====================================================================

describe('регистрация', () => {
  const NEW_LOGIN = 'novichok@example.ru';

  function register(body: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: SAME_ORIGIN,
      payload: body,
    });
  }

  it('создаёт заявку, а не пользователя', async () => {
    const response = await register({
      email: NEW_LOGIN,
      fullName: 'Новиков Новик',
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'pending-activation' });

    // Неодобренная заявка не должна выглядеть пользователем ни для одного
    // запроса портала: строка в users с is_active=false всё равно попадала бы в
    // выборки администрирования и в подсказки выбора исполнителя.
    const users = await db.query('select id from users where email = $1', [NEW_LOGIN]);
    expect(users).toHaveLength(0);

    const requests = await db.query<{ status: string; password_hash: string | null }>(
      'select status, password_hash from registration_requests where login_key = $1',
      [NEW_LOGIN],
    );
    expect(requests[0]?.status).toBe('pending');
    expect(requests[0]?.password_hash).not.toBeNull();
  });

  it('на повторную заявку отвечает так же и второй строки не заводит', async () => {
    await register({ email: NEW_LOGIN, fullName: 'Новиков Новик', password: NEW_PASSWORD });
    const second = await register({
      email: 'NOVICHOK@Example.RU',
      fullName: 'Кто-то Другой',
      password: NEW_PASSWORD,
    });

    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ status: 'pending-activation' });

    const requests = await db.query('select id from registration_requests');
    expect(requests).toHaveLength(1);
  });

  it('на существующего пользователя отвечает так же', async () => {
    // Иначе форма регистрации становится способом узнать, заведён ли в портале
    // конкретный человек.
    const response = await register({
      email: LOGIN_ACTIVE,
      fullName: 'Самозванец',
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'pending-activation' });
    expect(await db.query('select id from registration_requests')).toHaveLength(0);
  });

  it('отвергает слабый пароль честно', async () => {
    // Об учётной записи это ничего не сообщает, поэтому молчать незачем.
    const response = await register({
      email: NEW_LOGIN,
      fullName: 'Новиков Новик',
      password: 'qwerty123456',
    });

    expect(response.statusCode).toBe(422);
  });

  it('не принимает форму с чужого источника', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      payload: { email: NEW_LOGIN, fullName: 'Новиков Новик', password: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Журнал
// =====================================================================

describe('журнал', () => {
  async function actions(): Promise<string[]> {
    const rows = await db.query<{ action: string }>(
      `select action from audit_log where entity_type = 'auth' order by id`,
    );
    return rows.map((row) => row.action);
  }

  it('записывает успешный вход и выход', async () => {
    const auth = await signIn(LOGIN_ACTIVE);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: authHeadersNoBody(auth) });

    expect(await actions()).toEqual(['auth.login_success', 'auth.logout']);
  });

  it('записывает неудачу с причиной, невидимой снаружи', async () => {
    await login({ email: UNKNOWN_LOGIN, password: PASSWORD });
    await login({ email: LOGIN_ACTIVE, password: 'Sovsem-Drugoy-99!' });

    const rows = await db.query<{ payload: { reason?: string } | string }>(
      `select payload from audit_log where action = 'auth.login_failure' order by id`,
    );
    const reasons = rows.map((row) =>
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as { reason?: string }).reason
        : row.payload.reason,
    );
    expect(reasons).toEqual(['unknown-login', 'bad-password']);
  });

  it('не хранит логин открытым текстом ни в одном поле', async () => {
    // Событие неудачного входа касается строки, которую ввёл кто угодно;
    // складывать такие строки в юридически значимый журнал недопустимо.
    await login({ email: UNKNOWN_LOGIN, password: PASSWORD });
    await signIn(LOGIN_ACTIVE);

    const rows = await db.query<{ dump: string }>(
      `select coalesce(payload::text, '') || coalesce(entity_id, '') || coalesce(actor_email_hmac, '')
              as dump
         from audit_log where entity_type = 'auth'`,
    );
    for (const row of rows) {
      expect(row.dump).not.toContain('nikogo');
      expect(row.dump).not.toContain('ivanov');
      expect(row.dump).not.toContain('example.ru');
    }
  });

  it('заполняет HMAC логина и оставляет пользователя пустым у неизвестного', async () => {
    await login({ email: UNKNOWN_LOGIN, password: PASSWORD });

    const rows = await db.query<{ actor_user_id: string | null; actor_email_hmac: string | null }>(
      `select actor_user_id, actor_email_hmac from audit_log where action = 'auth.login_failure'`,
    );
    expect(rows[0]?.actor_user_id).toBeNull();
    expect(rows[0]?.actor_email_hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('записывает смену пароля и заявку на регистрацию', async () => {
    const auth = await signIn(LOGIN_ACTIVE);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(auth),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: SAME_ORIGIN,
      payload: { email: 'novichok@example.ru', fullName: 'Новиков Новик', password: PASSWORD },
    });

    expect(await actions()).toContain('auth.password_changed');
    expect(await actions()).toContain('auth.register_requested');
  });
});

// =====================================================================
// Сессии и режим
// =====================================================================

describe('привязка сессии к режиму', () => {
  it('сессия чужого режима не принимается', async () => {
    // Права те же, но способ подтверждения личности другой: после перевода
    // портала на локальный вход прежнее подтверждение ничего не значит.
    const auth = await signIn(LOGIN_ACTIVE);
    await db.query(`update auth_sessions set auth_mode = 'oidc' where id = $1`, [
      sessionIdOf(auth.session),
    ]);

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${auth.session}` },
    });

    expect(me.statusCode).toBe(401);
  });

  it('сессия локального входа помечена режимом', async () => {
    const auth = await signIn(LOGIN_ACTIVE);

    const rows = await db.query<{ auth_mode: string; kc_sid: string | null }>(
      'select auth_mode, kc_sid from auth_sessions where id = $1',
      [sessionIdOf(auth.session)],
    );
    expect(rows[0]?.auth_mode).toBe('local');
    // Внешней сессии нет: связывать не с чем.
    expect(rows[0]?.kc_sid).toBeNull();
  });
});

// =====================================================================
// Лимиты и блокировка
// =====================================================================

/**
 * Лимиты проверяются на ОТДЕЛЬНОМ приложении с малыми значениями.
 *
 * Основное приложение файла поднято с огромными пределами намеренно: иначе
 * тридцать проверок входа превратились бы в проверку rate-limit, а не входа.
 * Здесь всё наоборот — пределы минимальны, и предмет проверки именно они.
 */
describe('лимиты', () => {
  const TIGHT_ENV = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'local',
    AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-local-tests-0123456789',
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-local-tests-0123456789',
    CSRF_SECRET: 'csrf-secret-of-local-auth-tests-0123456789',
    AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: '.tmp/local-auth-tests',
    RATE_LIMIT_MAX: '100000',
    // Три неудачи по логину — блокировка. Backoff отключён потолком в секунду,
    // иначе тест ждал бы реального времени.
    AUTH_LOCAL_BACKOFF_MAX_SECONDS: '1',
    AUTH_LOCAL_LOCKOUT_MINUTES: '30',
    AUTH_LOCAL_LOGIN_MAX_PER_IP: '100000',
  });

  let tight: AppInstance;

  beforeAll(async () => {
    tight = await buildApp({ env: TIGHT_ENV, pool: createTestPool(db) as unknown as Pool });
    await tight.ready();
  }, 180_000);

  afterAll(async () => {
    await tight.close();
  });

  function attempt(email: string, password: string): Promise<LightMyRequestResponse> {
    return tight.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email, password },
    });
  }

  it('после десяти неудач блокирует и сообщает, когда повторить', async () => {
    let last: LightMyRequestResponse | null = null;
    for (let i = 0; i < 12; i += 1) {
      last = await attempt(LOGIN_ACTIVE, `Ne-Tot-Parol-${String(i)}!`);
      // Задержка между попытками снимается вручную: ждать настоящие секунды в
      // тесте значит менять время прогона на ничего.
      await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);
    }

    expect(last?.statusCode).toBe(429);
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(60);

    // Даже ВЕРНЫЙ пароль после блокировки не пускает: иначе блокировка защищала
    // бы только от неверных паролей, то есть ни от чего.
    const correct = await attempt(LOGIN_ACTIVE, PASSWORD);
    expect(correct.statusCode).toBe(429);
  }, 30_000);

  it('блокирует несуществующий логин так же, как существующий', async () => {
    // Разница в поведении и есть оракул существования учётной записи.
    let known: LightMyRequestResponse | null = null;
    let unknown: LightMyRequestResponse | null = null;

    for (let i = 0; i < 11; i += 1) {
      known = await attempt(LOGIN_ACTIVE, `Ne-Tot-Parol-${String(i)}!`);
      unknown = await attempt(UNKNOWN_LOGIN, `Ne-Tot-Parol-${String(i)}!`);
      await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);
    }

    expect(unknown?.statusCode).toBe(known?.statusCode);
    expect(unknown?.statusCode).toBe(429);
  }, 30_000);

  it('смена регистра логина блокировку не обходит', async () => {
    // citext находит ту же строку, а ключ троттлинга считается в коде: разойдись
    // канонизация — каждое написание получило бы свой счётчик.
    for (let i = 0; i < 11; i += 1) {
      await attempt(LOGIN_ACTIVE, `Ne-Tot-Parol-${String(i)}!`);
      await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);
    }

    const disguised = await attempt('IVANOV@Example.RU', PASSWORD);
    expect(disguised.statusCode).toBe(429);
  }, 30_000);

  it('записывает блокировку в журнал ровно один раз', async () => {
    for (let i = 0; i < 13; i += 1) {
      await attempt(LOGIN_ACTIVE, `Ne-Tot-Parol-${String(i)}!`);
      await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);
    }

    const rows = await db.query<{ count: string }>(
      `select count(*)::text as count from audit_log where action = 'auth.account_locked'`,
    );
    // Иначе событие «учётная запись заблокирована» тонет в собственных повторах.
    expect(rows[0]?.count).toBe('1');
  }, 30_000);

  it('успешный вход обнуляет накопленные неудачи', async () => {
    for (let i = 0; i < 3; i += 1) {
      await attempt(LOGIN_ACTIVE, `Ne-Tot-Parol-${String(i)}!`);
      await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);
    }

    expect((await attempt(LOGIN_ACTIVE, PASSWORD)).statusCode).toBe(200);
    expect(await db.query(`select 1 from auth_throttle where scope = 'login'`)).toHaveLength(0);
  });
});
