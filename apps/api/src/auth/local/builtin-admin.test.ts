/**
 * Встроенный администратор из seed-миграции.
 *
 * Проверяется не «строка есть в базе», а то, ради чего она заведена: свежее
 * развёртывание открывается в браузере и пускает внутрь без обращения к консоли
 * сервера. Поэтому вход идёт штатным маршрутом, а не сверкой хэша.
 *
 * Второе по важности утверждение — ограничение последствий. Пароль лежит в git,
 * то есть известен всем, у кого есть доступ к репозиторию; единственное, что
 * держит риск в границах, — принудительная смена при первом входе. Проверки
 * ниже фиксируют оба конца: выданным паролем войти можно, но сделать им нельзя
 * ничего, кроме смены пароля.
 *
 * Проверок со входом здесь намеренно немного: seed-хэш посчитан боевым профилем
 * scrypt, и каждая проверка пароля стоит около полусекунды. Понизить стоимость
 * нельзя — она записана внутри самого хэша.
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
import { hasLocalAdmin } from './startup.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

/**
 * Учётные данные встроенного администратора: те же, что в seed-миграциях.
 *
 * Логин — адрес почты, как у всех остальных: до подключения Keycloak им служит
 * введённый адрес, и исключений из этого правила нет.
 */
const LOGIN = 'admin@test.com';
const PASSWORD = 'qwedcxz1@';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'local',
  AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-builtin-tests-0123456789',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-builtin-tests-0123456789',
  CSRF_SECRET: 'csrf-secret-of-builtin-admin-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/builtin-admin-tests',
  RATE_LIMIT_MAX: '100000',
  AUTH_LOCAL_LOGIN_MAX_PER_IP: '100000',
  AUTH_LOCAL_PASSWORD_MAX_PER_HOUR: '100000',
});

let db: TestDatabase;
let app: AppInstance;

function login(email: string, password: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: SAME_ORIGIN,
    payload: { email, password },
  });
}

function cookieOf(response: LightMyRequestResponse, name: string): string {
  return response.cookies.find((cookie) => cookie.name === name)?.value ?? '';
}

function authHeaders(response: LightMyRequestResponse): Record<string, string> {
  // Явная проверка вместо молчаливой пустой cookie: без неё неудачный вход
  // превращается в 401 на следующем шаге, и разбираться приходится не с той
  // строкой, которая сломалась.
  expect(response.statusCode, response.body).toBe(200);

  return {
    ...SAME_ORIGIN,
    cookie: `${SESSION_COOKIE}=${cookieOf(response, SESSION_COOKIE)}`,
    [CSRF_HEADER]: cookieOf(response, CSRF_COOKIE),
  };
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(async () => {
  // Неудачная попытка входа выставляет экспоненциальную задержку по логину, и
  // следующий тест получил бы 429 вместо предмета проверки. Троттлинг здесь не
  // проверяется — для него есть `throttle.test.ts` и раздел «лимиты» в
  // `routes.test.ts`.
  await db.query('delete from auth_throttle');
});

// =====================================================================
// Состояние после миграций
// =====================================================================

describe('seed', () => {
  it('заводит ровно одну учётную запись с ролью администратора', async () => {
    const rows = await db.query<{
      kc_sub: string;
      email: string | null;
      is_active: boolean;
      role: string;
      must_change_password: boolean;
    }>(
      `select u.kc_sub, u.email, u.is_active, r.role, c.must_change_password
         from user_credentials c
         join users u on u.id = c.user_id
         join user_roles r on r.user_id = u.id
        where c.login_key = $1`,
      [LOGIN],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kc_sub: 'local:builtin-admin',
      is_active: true,
      role: 'admin',
      // Ограничение последствий: пароль из git обязан быть сменён при первом входе.
      must_change_password: true,
    });
    // Логин и адрес — одно и то же значение: правило «логином служит введённый
    // адрес» не имеет исключений.
    expect(rows[0]?.email).toBe(LOGIN);
  });

  it('не пишет в журнал', async () => {
    // Не стилистика: внешний ключ audit_log.actor_user_id объявлен без
    // ON DELETE, и запись из seed сделала бы невозможным `delete from users`,
    // которым тесты чистят состояние.
    const rows = await db.query<{ count: string }>('select count(*)::text as count from audit_log');

    expect(rows[0]?.count).toBe('0');
  });

  it('применяется повторно, не заводя второй строки', async () => {
    const seed = loadMigrations(MIGRATIONS_DIR).find((migration) =>
      migration.fileName.includes('seed_builtin_admin'),
    );
    expect(seed, 'seed-миграция не найдена по имени').toBeDefined();

    await db.exec(seed?.sql ?? '');
    await db.exec(seed?.sql ?? '');

    const rows = await db.query('select user_id from user_credentials where login_key = $1', [
      LOGIN,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('удовлетворяет проверке старта «есть кому войти»', async () => {
    await expect(hasLocalAdmin(createTestPool(db) as unknown as Pool)).resolves.toBe(true);
  });
});

// =====================================================================
// Первый вход
// =====================================================================

describe('первый вход', () => {
  it('пускает выданным паролем и требует его сменить', async () => {
    const response = await login(LOGIN, PASSWORD);

    expect(response.statusCode, response.body).toBe(200);
    expect(cookieOf(response, SESSION_COOKIE)).not.toBe('');
    expect(cookieOf(response, CSRF_COOKIE)).not.toBe('');

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${cookieOf(response, SESSION_COOKIE)}` },
    });
    expect(me.json()).toMatchObject({ authMode: 'local', mustChangePassword: true });
  }, 30_000);

  it('находит учётную запись независимо от регистра и обрамляющих пробелов', async () => {
    // Адрес часто вставляют из буфера вместе с пробелами; отказ на видимо
    // верном значении объяснял бы не то.
    const response = await login('  ADMIN@Test.COM  ', PASSWORD);

    expect(response.statusCode).toBe(200);
  }, 30_000);

  it('до смены пароля работа в портале закрыта', async () => {
    const session = await login(LOGIN, PASSWORD);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: authHeaders(session),
    });

    expect(response.statusCode).toBe(403);
  }, 30_000);

  it('неверный пароль не пускает', async () => {
    const response = await login(LOGIN, 'qwedcxz1');

    expect(response.statusCode).toBe(401);
  }, 30_000);

  it('логин не в форме адреса отвергается схемой', async () => {
    // Учётной записи с таким логином завести нельзя ни одним из трёх путей,
    // поэтому отказ по формату ничего не сообщает о содержимом базы.
    const response = await login('admin', PASSWORD);

    expect(response.statusCode).toBe(422);
  });
});

// =====================================================================
// Смена пароля
// =====================================================================

describe('смена пароля', () => {
  const NEW_PASSWORD = 'Betonnaya-Svaya-Reki-88!';

  it('отвергает попытку оставить прежний пароль', async () => {
    // `qwedcxz1@` — девять символов при минимуме политики в двенадцать. Пароль
    // первого входа и не должен переживать первый вход, поэтому задать его
    // заново через форму нельзя. Проверка существует, чтобы это следствие не
    // выглядело дефектом при разборе.
    const session = await login(LOGIN, PASSWORD);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(session),
      payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });

    expect(response.statusCode).toBe(422);
  }, 30_000);

  it('снимает требование смены, обесценивает прежний пароль и открывает портал', async () => {
    const session = await login(LOGIN, PASSWORD);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: authHeaders(session),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    // Выданная вместе с ответом сессия работает и уже не ограничена.
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${cookieOf(changed, SESSION_COOKIE)}` },
    });
    expect(me.json()).toMatchObject({ mustChangePassword: false });

    const work = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: authHeaders(changed),
    });
    expect(work.statusCode).toBe(200);

    // Пароль из репозитория перестал быть действующим — ради этого всё и затеяно.
    expect((await login(LOGIN, PASSWORD)).statusCode).toBe(401);

    // Неудачная попытка строкой выше выставила задержку по логину; ждать
    // настоящую секунду в тесте значит менять время прогона на ничего.
    await db.query('delete from auth_throttle');
    expect((await login(LOGIN, NEW_PASSWORD)).statusCode).toBe(200);
  }, 60_000);
});
