/**
 * Администрирование локальных учётных записей.
 *
 * Два утверждения здесь важнее остальных:
 *
 *   1. **В `dev-stub` этих маршрутов нет.** Они распоряжаются паролями, которых
 *      в федеративном режиме портал не хранит; их присутствие означало бы, что
 *      портал умеет заводить второй путь входа мимо Keycloak.
 *   2. **Пароль назначает сервер, а не администратор.** Поля `password` в теле
 *      нет: администратор, задающий пользователю известный себе пароль, получает
 *      возможность действовать от его имени, и журнал этого не различит.
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

const BASE_ENV = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-admin-tests-0123456789',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-admin-tests-0123456789',
  CSRF_SECRET: 'csrf-secret-of-admin-local-tests-0123456789',
  AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/local-admin-tests',
  RATE_LIMIT_MAX: '100000',
  AUTH_LOCAL_LOGIN_MAX_PER_IP: '100000',
  AUTH_LOCAL_PASSWORD_MAX_PER_HOUR: '100000',
  AUTH_LOCAL_REGISTER_MAX_PER_IP_HOUR: '100000',
} as const;

const LOCAL_ENV = loadEnv({ ...BASE_ENV, AUTH_MODE: 'local' });

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const MEMBER_ID = '00000000-0000-4000-8000-000000000002';
const CONTRACTOR_ID = '00000000-0000-4000-8000-000000000010';

const ADMIN_LOGIN = 'admin@example.ru';
const MEMBER_LOGIN = 'member@example.ru';
const PASSWORD = 'Mostovoy-Kran-77!';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

let db: TestDatabase;
let app: AppInstance;

async function seed(): Promise<void> {
  const hash = await hashPassword(LOCAL_ENV, PASSWORD);

  await db.query(
    `insert into counterparties (id, name, inn, kpp, ogrn, kind)
     values ($1, 'ООО «Подрядчик»', '7700123459', '770901001', '1027700123450', 'contractor')`,
    [CONTRACTOR_ID],
  );
  await db.query(
    `insert into users (id, kc_sub, email, full_name, is_active) values
       ($1, 'local:admin',  $3, 'Админов Админ', true),
       ($2, 'local:member', $4, 'Членов Член',   true)`,
    [ADMIN_ID, MEMBER_ID, ADMIN_LOGIN, MEMBER_LOGIN],
  );
  await db.query(`insert into user_roles (user_id, role) values ($1, 'admin')`, [ADMIN_ID]);
  await db.query(`insert into user_roles (user_id, role) values ($1, 'engineer')`, [MEMBER_ID]);

  for (const [userId, login] of [
    [ADMIN_ID, ADMIN_LOGIN],
    [MEMBER_ID, MEMBER_LOGIN],
  ] as const) {
    await db.query(
      `insert into user_credentials
         (user_id, login_key, login_display, password_hash, password_algorithm)
       values ($1::uuid, $2, $3, $4, $5)`,
      [userId, login, login, hash.encoded, hash.algorithm],
    );
  }
}

async function reset(): Promise<void> {
  for (const table of [
    'auth_throttle',
    'auth_sessions',
    'audit_log',
    'registration_requests',
    'user_object_scopes',
    'user_credentials',
    'user_roles',
    'users',
    'counterparties',
  ]) {
    await db.query(`delete from ${table}`);
  }
  await seed();
}

async function signIn(email: string): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: SAME_ORIGIN,
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);

  const session = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '';
  const csrf = response.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value ?? '';
  return { ...SAME_ORIGIN, cookie: `${SESSION_COOKIE}=${session}`, [CSRF_HEADER]: csrf };
}

function post(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url, headers, payload });
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  await seed();

  app = await buildApp({ env: LOCAL_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(reset);

// =====================================================================
// Создание пользователя
// =====================================================================

describe('создание пользователя', () => {
  it('заводит учётную запись с паролем и возвращает его один раз', async () => {
    const admin = await signIn(ADMIN_LOGIN);
    const response = await post('/api/v1/admin/users', admin, {
      email: 'novyy@example.ru',
      fullName: 'Новый Новиков',
      roles: ['engineer'],
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    expect(body.temporaryPassword).toHaveLength(24);
    expect(body.user).toMatchObject({ email: 'novyy@example.ru', roles: ['engineer'] });
    // Пароль, известный не только владельцу, обязан быть сменён при первом входе.
    expect(body.user.local).toMatchObject({ mustChangePassword: true });
  });

  it('выданным паролем можно войти, и портал сразу требует его сменить', async () => {
    const admin = await signIn(ADMIN_LOGIN);
    const created = await post('/api/v1/admin/users', admin, {
      email: 'novyy@example.ru',
      fullName: 'Новый Новиков',
      roles: ['engineer'],
    });
    const password = created.json().temporaryPassword as string;

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: 'novyy@example.ru', password },
    });
    expect(login.statusCode).toBe(200);

    const session = login.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '';
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(me.json()).toMatchObject({ mustChangePassword: true });
  });

  it('не принимает пароль от администратора', async () => {
    // Поля нет в схеме: администратор не должен иметь возможности задать
    // пользователю пароль, который знает сам.
    const admin = await signIn(ADMIN_LOGIN);
    const response = await post('/api/v1/admin/users', admin, {
      email: 'novyy@example.ru',
      fullName: 'Новый Новиков',
      roles: ['engineer'],
      password: 'Podsunutyy-Parol-1!',
    });

    expect(response.statusCode).toBe(201);
    // Заданный пароль проигнорирован, а не принят.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: 'novyy@example.ru', password: 'Podsunutyy-Parol-1!' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('отвергает занятый адрес', async () => {
    const admin = await signIn(ADMIN_LOGIN);
    const response = await post('/api/v1/admin/users', admin, {
      email: 'MEMBER@Example.RU',
      fullName: 'Дубликат Дубликатов',
      roles: ['engineer'],
    });

    expect(response.statusCode).toBe(409);
  });

  it('отвергает подрядчика без организации', async () => {
    // Подрядчик без организации не имеет области видимости и не увидит ничего:
    // это ошибка администрирования, а не «видит всё».
    const admin = await signIn(ADMIN_LOGIN);
    const response = await post('/api/v1/admin/users', admin, {
      email: 'podryad@example.ru',
      fullName: 'Подрядов Подряд',
      roles: ['contractor'],
    });

    expect(response.statusCode).toBe(422);
  });

  it('недоступно не администратору', async () => {
    const member = await signIn(MEMBER_LOGIN);
    const response = await post('/api/v1/admin/users', member, {
      email: 'novyy@example.ru',
      fullName: 'Новый Новиков',
      roles: ['engineer'],
    });

    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Сброс пароля и блокировка
// =====================================================================

describe('сброс пароля', () => {
  it('обесценивает прежний пароль и все сессии пользователя', async () => {
    const victim = await signIn(MEMBER_LOGIN);
    const admin = await signIn(ADMIN_LOGIN);

    const response = await post(`/api/v1/admin/users/${MEMBER_ID}/password`, admin);
    expect(response.statusCode, response.body).toBe(200);

    // Сессия мертва...
    const me = await app.inject({ method: 'GET', url: '/me', headers: victim });
    expect(me.statusCode).toBe(401);

    // ...и прежний пароль тоже.
    const old = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: MEMBER_LOGIN, password: PASSWORD },
    });
    expect(old.statusCode).toBe(401);

    // Неудачная попытка выставила экспоненциальную задержку по логину. Ждать
    // настоящую секунду в тесте значит менять время прогона на ничего.
    await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);

    const fresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: MEMBER_LOGIN, password: response.json().temporaryPassword },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('отказывает у пользователя без локальных учётных данных', async () => {
    const admin = await signIn(ADMIN_LOGIN);
    await db.query(
      `insert into users (id, kc_sub, full_name) values
         ('00000000-0000-4000-8000-000000000099', '8f0d1c2e-0000-4000-8000-000000000099', 'Федеративный')`,
    );

    const response = await post(
      '/api/v1/admin/users/00000000-0000-4000-8000-000000000099/password',
      admin,
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('снятие блокировки', () => {
  it('возвращает возможность входа после перебора', async () => {
    // Десять неудач подряд блокируют учётную запись на полчаса.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: SAME_ORIGIN,
        payload: { email: MEMBER_LOGIN, password: `Ne-Tot-Parol-${String(attempt)}!` },
      });
      await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: MEMBER_LOGIN, password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);

    const admin = await signIn(ADMIN_LOGIN);
    const unlocked = await post(`/api/v1/admin/users/${MEMBER_ID}/unlock`, admin);
    expect(unlocked.statusCode, unlocked.body).toBe(200);

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: MEMBER_LOGIN, password: PASSWORD },
    });
    expect(after.statusCode).toBe(200);
  }, 60_000);

  it('видна в карточке пользователя до снятия', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: SAME_ORIGIN,
        payload: { email: MEMBER_LOGIN, password: `Ne-Tot-Parol-${String(attempt)}!` },
      });
      await db.query(`update auth_throttle set next_attempt_at = now() - interval '1 second'`);
    }

    const admin = await signIn(ADMIN_LOGIN);
    const card = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${MEMBER_ID}`,
      headers: admin,
    });

    expect(card.json().user.local.lockedUntil).not.toBeNull();
  }, 60_000);
});

// =====================================================================
// Заявки на регистрацию
// =====================================================================

describe('заявки на регистрацию', () => {
  async function apply(email = 'zayavka@example.ru'): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: SAME_ORIGIN,
      payload: { email, fullName: 'Заявкин Заявка', password: 'Betonnaya-Svaya-42!' },
    });
    expect(response.statusCode).toBe(202);

    const rows = await db.query<{ id: string }>(
      `select id from registration_requests where login_key = $1`,
      [email],
    );
    return rows[0]?.id ?? '';
  }

  it('перечисляются только нерассмотренные', async () => {
    await apply();
    const admin = await signIn(ADMIN_LOGIN);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/registration-requests',
      headers: admin,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({
      email: 'zayavka@example.ru',
      hasRequestedPassword: true,
    });
  });

  it('одобрение с временным паролем создаёт пользователя и требует смены', async () => {
    // Основное действие: адрес при регистрации не подтверждался, и передача
    // временного пароля вне портала и есть проверка личности.
    const id = await apply();
    const admin = await signIn(ADMIN_LOGIN);

    const response = await post(`/api/v1/admin/registration-requests/${id}/approve`, admin, {
      roles: ['engineer'],
      credential: 'temporary',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().temporaryPassword).toHaveLength(24);
    expect(response.json().user.local).toMatchObject({ mustChangePassword: true });

    // Пароль из заявки больше не работает: он заменён.
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: 'zayavka@example.ru', password: 'Betonnaya-Svaya-42!' },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('одобрение с паролем заявителя оставляет его пароль и не требует смены', async () => {
    const id = await apply();
    const admin = await signIn(ADMIN_LOGIN);

    const response = await post(`/api/v1/admin/registration-requests/${id}/approve`, admin, {
      roles: ['engineer'],
      credential: 'as-requested',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().temporaryPassword).toBeNull();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: 'zayavka@example.ru', password: 'Betonnaya-Svaya-42!' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('одобрение выполняется одной транзакцией: роли и области на месте', async () => {
    const id = await apply();
    const admin = await signIn(ADMIN_LOGIN);

    const response = await post(`/api/v1/admin/registration-requests/${id}/approve`, admin, {
      roles: ['contractor'],
      contractorId: CONTRACTOR_ID,
      credential: 'temporary',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().user).toMatchObject({
      roles: ['contractor'],
      contractorId: CONTRACTOR_ID,
    });

    const requests = await db.query<{ status: string; password_hash: string | null }>(
      'select status, password_hash from registration_requests where id = $1',
      [id],
    );
    expect(requests[0]?.status).toBe('approved');
    // Хэш из заявки стёрт: он переехал в учётные данные либо заменён временным.
    expect(requests[0]?.password_hash).toBeNull();
  });

  it('повторное одобрение отвергается', async () => {
    const id = await apply();
    const admin = await signIn(ADMIN_LOGIN);
    await post(`/api/v1/admin/registration-requests/${id}/approve`, admin, {
      roles: ['engineer'],
      credential: 'temporary',
    });

    const second = await post(`/api/v1/admin/registration-requests/${id}/approve`, admin, {
      roles: ['engineer'],
      credential: 'temporary',
    });
    expect(second.statusCode).toBe(404);
  });

  it('отказ закрывает заявку и стирает пароль из неё', async () => {
    const id = await apply();
    const admin = await signIn(ADMIN_LOGIN);

    const response = await post(`/api/v1/admin/registration-requests/${id}/reject`, admin, {
      reason: 'Нет договора',
    });
    expect(response.statusCode, response.body).toBe(200);

    const rows = await db.query<{ status: string; password_hash: string | null }>(
      'select status, password_hash from registration_requests where id = $1',
      [id],
    );
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.password_hash).toBeNull();

    // После отказа человек имеет право подать заявку снова.
    await apply();
  });

  it('недоступны не администратору', async () => {
    const member = await signIn(MEMBER_LOGIN);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/registration-requests',
      headers: member,
    });

    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Деактивация
// =====================================================================

describe('деактивация', () => {
  it('оставляет сессию живой, но отказывает с внятной причиной', async () => {
    // Сессия НЕ отзывается намеренно: отключённый пользователь получает 403 с
    // объяснением вместо молчаливого разлогинивания, а `/me` продолжает
    // отвечать — интерфейсу есть что показать. Ошибочное отключение при этом
    // отменяется включением обратно, не заставляя человека входить заново.
    const victim = await signIn(MEMBER_LOGIN);
    const admin = await signIn(ADMIN_LOGIN);

    const response = await post(`/api/v1/admin/users/${MEMBER_ID}/deactivate`, admin);
    expect(response.statusCode, response.body).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/me', headers: victim });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ denial: 'inactive' });

    const work = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: victim,
    });
    expect(work.statusCode).toBe(403);
  });

  it('отключённая учётная запись не входит даже с верным паролем', async () => {
    const admin = await signIn(ADMIN_LOGIN);
    await post(`/api/v1/admin/users/${MEMBER_ID}/deactivate`, admin);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_ORIGIN,
      payload: { email: MEMBER_LOGIN, password: PASSWORD },
    });

    expect(login.statusCode).toBe(403);
    const live = await db.query(
      'select id from auth_sessions where user_id = $1 and revoked_at is null',
      [MEMBER_ID],
    );
    // Новой сессии не появилось: отключённому вход не выдаётся.
    expect(live).toHaveLength(0);
  });
});

// =====================================================================
// Отсутствие в чужом режиме
// =====================================================================

describe('федеративный режим', () => {
  it('не имеет ни одного из этих маршрутов', async () => {
    // Они распоряжаются паролями, которых портал в этом режиме не хранит.
    // Переменные локального режима из конфигурации убраны: `crossChecks()`
    // отвергает настройку, которая в этом режиме ничего не делает.
    const {
      AUTH_LOCAL_LOGIN_HMAC_KEY: _hmac,
      AUTH_LOCAL_SCRYPT_COST_LOG2: _cost,
      AUTH_LOCAL_LOGIN_MAX_PER_IP: _perIp,
      AUTH_LOCAL_PASSWORD_MAX_PER_HOUR: _perHour,
      AUTH_LOCAL_REGISTER_MAX_PER_IP_HOUR: _register,
      ...federatedEnv
    } = BASE_ENV;

    const federated = await buildApp({
      env: loadEnv({ ...federatedEnv, AUTH_MODE: 'dev-stub' }),
      pool: createTestPool(db) as unknown as Pool,
    });
    await federated.ready();

    try {
      for (const [method, url] of [
        ['POST', '/api/v1/admin/users'],
        ['POST', '/api/v1/admin/users/:id/password'],
        ['POST', '/api/v1/admin/users/:id/unlock'],
        ['GET', '/api/v1/admin/registration-requests'],
        ['POST', '/api/v1/admin/registration-requests/:id/approve'],
        ['POST', '/api/v1/auth/login'],
        ['POST', '/api/v1/auth/register'],
        ['POST', '/api/v1/auth/password'],
      ] as const) {
        expect(federated.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      }
      // ...а redirect-поток, наоборот, на месте.
      expect(federated.hasRoute({ method: 'GET', url: '/auth/callback' })).toBe(true);
    } finally {
      await federated.close();
    }
  }, 60_000);
});
