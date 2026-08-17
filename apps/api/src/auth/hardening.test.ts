/**
 * Регрессии на дефекты, найденные адверсарным прогоном S3.
 *
 * Каждый тест ниже воспроизводит конкретную атаку и падает на исходном
 * поведении. Приложение поднимается целиком — `buildApp()` с
 * `AUTH_MODE=dev-stub` и настоящей PostgreSQL (pglite) под миграциями проекта:
 * все проверенные здесь дефекты живут в связке «плагин Fastify → хук → SQL», и
 * на выдуманном приложении ни один из них не воспроизводится.
 *
 * Экземпляров приложения три, и это не дублирование:
 *   • `app` — обычный, с заведомо недостижимым лимитом запросов;
 *   • `limited` — с лимитом три запроса, иначе проверка лимита исчерпала бы
 *     квоту остальным тестам того же файла;
 *   • `loud` — с `NODE_ENV=development`, потому что в тестовом окружении журнал
 *     заглушён, а проверять надо именно то, что в него попадает.
 * Все три работают поверх одной тестовой БД: дефекты проверяются по её
 * содержимому, а не по ответам.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { applyMigrations, loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../app.js';
import { loadEnv } from '../config/env.js';
import { CLAIMS_MISMATCH_ACTION } from './provisioning.js';
import { LOGIN_COOKIE, SESSION_COOKIE } from './session.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

const BASE_ENV: Readonly<Record<string, string>> = {
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-hardening-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/hardening-tests',
};

/** Лимит запросов проверяется малым числом: 429 обязан начаться с четвёртого. */
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_ATTEMPTS = 8;

const MAIN_ENV = loadEnv({ ...BASE_ENV, NODE_ENV: 'test', RATE_LIMIT_MAX: '100000' });

const LIMITED_ENV = loadEnv({
  ...BASE_ENV,
  NODE_ENV: 'test',
  RATE_LIMIT_MAX: String(RATE_LIMIT_MAX),
  RATE_LIMIT_WINDOW_MS: '60000',
});

const LOUD_ENV = loadEnv({
  ...BASE_ENV,
  // Не `test`: при нём приложение глушит журнал, и проверять его содержимое
  // было бы проверкой пустой строки.
  NODE_ENV: 'development',
  LOG_LEVEL: 'debug',
  RATE_LIMIT_MAX: '100000',
});

/** `kc_sub` = то, что заглушка подставляет в `sub` токена. */
const KC = {
  forwarded: 'kc-hardening-xff',
  csrf: 'kc-hardening-csrf',
  profile: 'kc-hardening-profile',
  replay: 'kc-hardening-replay',
} as const;

const ORIGINAL_NAME = 'Иванов Иван Иванович';
const ORIGINAL_EMAIL = 'ivanov@portal.test';
const SPOOFED_NAME = 'ПОДМЕНЕННОЕ ФИО';
const SPOOFED_EMAIL = 'attacker@evil.test';

/** Не адрес ни в каком виде: `inet` такого значения принять не может. */
const GARBAGE_FORWARDED_FOR = 'ne-adres-a-musor';

/**
 * Маркеры для проверки журнала.
 *
 * Литерал уезжает в текст SQL, значение — в bind-параметр. Оба выбраны так,
 * чтобы законная нормализация их не сохранила: строковый литерал в
 * нормализованном SQL заменяется на `?`, значение в кавычках в сообщении
 * ошибки — на `<value>`. Появление маркера в журнале означает именно то, что
 * запрос или объект ошибки записан как есть.
 */
const SQL_LITERAL_MARKER = 'marker-literala-v-tekste-zaprosa';
const BIND_VALUE_MARKER = 'marker-znacheniya-bind-parametra';

let db: TestDatabase;
let app: AppInstance;
let limited: AppInstance;
let loud: AppInstance;
let journal: string[];

beforeAll(async () => {
  db = await createPgliteDatabase();
  await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

  const pool = createTestPool(db) as unknown as Pool;

  app = await buildApp({ env: MAIN_ENV, pool });
  await app.ready();

  limited = await buildApp({ env: LIMITED_ENV, pool });
  await limited.ready();

  loud = await buildApp({ env: LOUD_ENV, pool });
  registerFailingQueryRoute(loud);
  journal = captureJournal(loud);
  await loud.ready();
}, 180_000);

afterAll(async () => {
  await Promise.all([app.close(), limited.close(), loud.close()]);
  await db.close();
});

/**
 * Маршрут, гарантированно роняющий запрос к БД.
 *
 * Ошибку даёт не выдуманное исключение, а настоящий отказ PostgreSQL с
 * значением параметра в тексте сообщения: именно такой объект и утекает в
 * журнал целиком.
 */
function registerFailingQueryRoute(target: AppInstance): void {
  target.get('/test/db-error', async () => {
    await target.pool.query(`select '${SQL_LITERAL_MARKER}'::text as marker, $1::int as broken`, [
      BIND_VALUE_MARKER,
    ]);
    return { ok: true };
  });
}

interface PinoWithStream {
  [pino.symbols.streamSym]?: { write(chunk: string): void };
}

/**
 * Перехват журнала.
 *
 * Поток берётся у логгера по внутреннему символу pino, а не подменой
 * `process.stdout.write`: pino пишет в файловый дескриптор мимо потока Node, и
 * подмена `write` у самого объекта потока — единственный способ увидеть строки
 * синхронно. Дочерние логгеры запросов используют тот же объект, поэтому
 * перехватываются и записи обработчика ошибок, и записи слоя БД.
 */
function captureJournal(target: AppInstance): string[] {
  const captured: string[] = [];
  const stream = (target.log as unknown as PinoWithStream)[pino.symbols.streamSym];
  if (stream === undefined) throw new Error('Поток логгера не найден: журнал не перехватить');
  stream.write = (chunk: string): void => {
    captured.push(chunk);
  };
  return captured;
}

// =====================================================================
// Вход и чтение состояния
// =====================================================================

function cookieOf(response: LightMyRequestResponse, name: string): string {
  // Берётся последнее значение: в одном ответе cookie бывает сначала очищена,
  // а затем выставлена заново.
  const found = response.cookies.filter((cookie) => cookie.name === name).at(-1);
  if (found === undefined || found.value === '') {
    throw new Error(`В ответе нет cookie ${name}`);
  }
  return found.value;
}

/**
 * Значение кодируется обратно: сервер разбирает cookie через
 * `decodeURIComponent`, а подпись cookie — base64 с `+`, `/` и `=`.
 */
function cookieHeader(response: LightMyRequestResponse, name: string): string {
  return `${name}=${encodeURIComponent(cookieOf(response, name))}`;
}

function locationOf(response: LightMyRequestResponse): string {
  const value = response.headers['location'];
  if (typeof value !== 'string') throw new Error('В ответе нет заголовка location');
  return value;
}

function loginQuery(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

interface LoginFlow {
  /** Путь обратного вызова со строкой запроса: годится для повторной отправки. */
  readonly callbackUrl: string;
  readonly loginCookie: string;
  readonly callback: LightMyRequestResponse;
}

/**
 * Штатный вход заглушкой: `/auth/login` → редирект → `/auth/callback`.
 *
 * Возвращается не только результат, но и то, из чего он получен: часть тестов
 * повторяет обратный вызов теми же значениями, изображая перехваченный код.
 */
async function signIn(
  target: AppInstance,
  params: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<LoginFlow> {
  const started = await target.inject({
    method: 'GET',
    url: `/auth/login?${loginQuery(params)}`,
    headers,
  });
  expect(started.statusCode).toBe(302);

  const authorizationUrl = new URL(locationOf(started));
  const callbackUrl = `${authorizationUrl.pathname}${authorizationUrl.search}`;
  const loginCookie = cookieHeader(started, LOGIN_COOKIE);

  const callback = await target.inject({
    method: 'GET',
    url: callbackUrl,
    headers: { ...headers, cookie: loginCookie },
  });

  return { callbackUrl, loginCookie, callback };
}

type SessionRow = { id: string; csrf_hash: string; ip: string | null };
type ProfileRow = { full_name: string; email: string | null };
type AuditRow = { action: string; entity_id: string | null; payload: { fields?: string[] } };

function sessionsOf(kcSub: string): Promise<SessionRow[]> {
  return db.query<SessionRow>(
    // host(), а не ::text: приведение inet к тексту дописывает маску (`/32`),
    // а проверяется здесь именно адрес.
    `select s.id, s.csrf_hash, host(s.ip) as ip
       from auth_sessions s
       join users u on u.id = s.user_id
      where u.kc_sub = $1
      order by s.created_at`,
    [kcSub],
  );
}

function profileOf(kcSub: string): Promise<ProfileRow[]> {
  return db.query<ProfileRow>(
    'select full_name, email::text as email from users where kc_sub = $1',
    [kcSub],
  );
}

function claimsMismatchRecords(kcSub: string): Promise<AuditRow[]> {
  return db.query<AuditRow>(
    `select a.action, a.entity_id, a.payload
       from audit_log a
       join users u on u.id = a.actor_user_id
      where u.kc_sub = $1 and a.action = $2
      order by a.id`,
    [kcSub, CLAIMS_MISMATCH_ACTION],
  );
}

// =====================================================================
// Дефект 1: подмена адреса клиента обходила лимит запросов
// =====================================================================

describe('лимит запросов и X-Forwarded-For', () => {
  it('ротация X-Forwarded-For не обходит лимит при пустом TRUST_PROXY', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt += 1) {
      const response = await limited.inject({
        method: 'GET',
        url: '/me',
        // Каждый запрос называет себя новым клиентом. Верить в это можно
        // только там, где заголовок ставит доверенный прокси.
        headers: { 'x-forwarded-for': `203.0.113.${String(attempt + 1)}` },
      });
      statuses.push(response.statusCode);
    }

    // Первые три обязаны пройти лимит: иначе проверка ниже прошла бы и на
    // сломанном маршруте, отвечающем 429 всегда.
    expect(statuses.slice(0, RATE_LIMIT_MAX)).not.toContain(429);
    expect(statuses.slice(RATE_LIMIT_MAX)).toEqual(
      Array.from({ length: RATE_LIMIT_ATTEMPTS - RATE_LIMIT_MAX }, () => 429),
    );
  });

  it('нечисловой X-Forwarded-For не роняет /auth/callback и не пачкает auth_sessions.ip', async () => {
    const flow = await signIn(
      app,
      { devSub: KC.forwarded },
      { 'x-forwarded-for': GARBAGE_FORWARDED_FOR },
    );

    // 302 — вход состоялся. 500 здесь означал бы, что строка из заголовка
    // доехала до колонки `inet`.
    expect(flow.callback.statusCode).toBe(302);

    const sessions = await sessionsOf(KC.forwarded);
    expect(sessions).toHaveLength(1);
    const ip = sessions[0]?.ip ?? null;
    expect(ip).not.toBe(GARBAGE_FORWARDED_FOR);
    expect(ip === null || /^[0-9a-f.:]+$/i.test(ip)).toBe(true);
  });
});

// =====================================================================
// Дефект 2: заголовок x-request-id клиента отражался в ответе
// =====================================================================

describe('x-request-id от клиента', () => {
  it('не отражается в теле ответа при TRUST_REQUEST_ID=false', async () => {
    const marker = 'marker-request-id-ot-klienta';
    const response = await app.inject({
      method: 'GET',
      url: '/net-takogo-marshruta',
      headers: { 'x-request-id': marker },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ requestId?: string }>();
    // Идентификатор в ответе быть обязан — иначе проверка ниже ничего не значит.
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId).not.toBe(marker);
    expect(response.body).not.toContain(marker);
    expect(JSON.stringify(response.headers)).not.toContain(marker);
  });
});

// =====================================================================
// Дефект 3: безопасный метод менял состояние сессии
// =====================================================================

describe('GET /me', () => {
  it('не меняет auth_sessions.csrf_hash', async () => {
    const flow = await signIn(app, { devSub: KC.csrf });
    expect(flow.callback.statusCode).toBe(302);
    const cookie = cookieHeader(flow.callback, SESSION_COOKIE);

    const before = (await sessionsOf(KC.csrf))[0]?.csrf_hash;
    expect(typeof before).toBe('string');

    // Cookie с CSRF-токеном намеренно не отправляется: так выглядит запрос
    // клиента, у которого её вычистили, и именно он ротировал токен.
    const me = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);

    const after = (await sessionsOf(KC.csrf))[0]?.csrf_hash;
    expect(after).toBe(before);
  });
});

// =====================================================================
// Дефект 4: профиль портала следовал за claims токена
// =====================================================================

describe('идентичность актора', () => {
  it('повторный вход не перезаписывает профиль claims из токена', async () => {
    const first = await signIn(app, {
      devSub: KC.profile,
      devName: ORIGINAL_NAME,
      devEmail: ORIGINAL_EMAIL,
    });
    expect(first.callback.statusCode).toBe(302);
    expect(await profileOf(KC.profile)).toEqual([
      { full_name: ORIGINAL_NAME, email: ORIGINAL_EMAIL },
    ]);

    const second = await signIn(app, {
      devSub: KC.profile,
      devName: SPOOFED_NAME,
      devEmail: SPOOFED_EMAIL,
    });
    expect(second.callback.statusCode).toBe(302);

    // Профиль остался прежним: под чужим ФИО в журнале действий этот
    // пользователь не появится.
    expect(await profileOf(KC.profile)).toEqual([
      { full_name: ORIGINAL_NAME, email: ORIGINAL_EMAIL },
    ]);
  });

  it('расхождение claims с профилем зафиксировано в audit_log', async () => {
    // Расхождение создаётся здесь же, а не наследуется от предыдущего теста:
    // порядок выполнения не должен быть частью условия.
    const flow = await signIn(app, {
      devSub: KC.profile,
      devName: SPOOFED_NAME,
      devEmail: SPOOFED_EMAIL,
    });
    expect(flow.callback.statusCode).toBe(302);

    const records = await claimsMismatchRecords(KC.profile);
    expect(records.length).toBeGreaterThan(0);
    const last = records[records.length - 1];
    expect(last?.payload.fields).toEqual(expect.arrayContaining(['full_name', 'email']));
    // Значения из токена в журнал не переносятся: администратор сравнивает
    // портал с Keycloak сам, а произвольный текст в записи журнала — лишний.
    const recorded = JSON.stringify(records);
    expect(recorded).not.toContain(SPOOFED_NAME);
    expect(recorded).not.toContain(SPOOFED_EMAIL);
  });
});

// =====================================================================
// Дефект 5: authorization code принимался повторно
// =====================================================================

describe('повтор authorization code', () => {
  it('второй раз тот же код не выписывает сессию', async () => {
    const flow = await signIn(app, { devSub: KC.replay });
    expect(flow.callback.statusCode).toBe(302);
    expect(await sessionsOf(KC.replay)).toHaveLength(1);

    // Перехваченный код и cookie логина отправляются заново — ровно то, что
    // может сделать владелец истории браузера или прокси.
    const replay = await app.inject({
      method: 'GET',
      url: flow.callbackUrl,
      headers: { cookie: flow.loginCookie },
    });

    expect(await sessionsOf(KC.replay)).toHaveLength(1);
    const issued = replay.cookies.filter(
      (cookie) => cookie.name === SESSION_COOKIE && cookie.value !== '',
    );
    expect(issued).toEqual([]);
  });
});

// =====================================================================
// Дефект 6: объект ошибки PostgreSQL попадал в журнал целиком
// =====================================================================

describe('журнал и ошибки БД', () => {
  it('не содержит ни текста SQL, ни значений bind-параметров', async () => {
    journal.length = 0;
    const response = await loud.inject({ method: 'GET', url: '/test/db-error' });

    expect(response.statusCode).toBe(500);
    const written = journal.join('');
    // Перехват обязан что-то поймать: пустой журнал прошёл бы проверки ниже
    // без всякой правки кода.
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain(BIND_VALUE_MARKER);
    expect(written).not.toContain(SQL_LITERAL_MARKER);
    // Клиенту подробности отказа не достаются тем более.
    expect(response.body).not.toContain(BIND_VALUE_MARKER);
    expect(response.body).not.toContain(SQL_LITERAL_MARKER);
  });
});

// =====================================================================
// Дефект 7: метрик не было
// =====================================================================

describe('/metrics', () => {
  it('существует и отдаёт формат Prometheus', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/plain');
    expect(response.body).toMatch(/^# HELP \S+ /m);
    expect(response.body).toMatch(/^# TYPE \S+ (counter|gauge|histogram|summary)$/m);
  });
});
