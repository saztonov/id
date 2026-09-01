/**
 * Приём ошибок браузера через HTTP на собранном приложении (§11).
 *
 * Проверяется то, ради чего маршрут вообще открыт наружу и чем за это
 * заплачено:
 *
 * 1. **Работает без сессии.** Поломка экрана входа — самый опасный случай, и
 *    отчёт о ней обязан уходить.
 * 2. **Телу не верят.** Пользователь берётся из сессии, а не из тела;
 *    классификацию ставит сервер; секрет, посланный в сообщении или в адресе,
 *    не доезжает ни до одной колонки.
 * 3. **Стражи на месте**: чужой `Origin` и не-JSON отвергаются.
 * 4. **Лимит срабатывает.** Маршрут доступен всем, и без лимита поток
 *    уникальных сообщений с одной машины наполнял бы журнал.
 * 5. **Хэш сборки в кадрах стека нормализуется** — иначе одна и та же ошибка
 *    после каждого деплоя заводила бы новую сигнатуру.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';
import { CLIENT_ERRORS_PATH } from './routes.js';

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

const USER_ENGINEER = id(501);
const KC_ENGINEER = 'kc-client-errors-engineer';

const FIXTURE: readonly string[] = [
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER}', '${KC_ENGINEER}', 'Инженер')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-client-error-tests-01234',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/client-error-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-client-error-tests',
  RATE_LIMIT_MAX: '100000',
  // Лимит приёма занижен намеренно: его срабатывание — предмет проверки.
  CLIENT_ERROR_RATE_LIMIT_MAX: '5',
  // Сброс журнала форсируется вручную, поэтому интервал взят большим: иначе
  // таймер писал бы параллельно проверкам и результат зависел бы от гонки.
  ERROR_JOURNAL_FLUSH_MS: '60000',
  APP_RELEASE: '2026.08.9',
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
  await db.query(`delete from error_issues where is_synthetic = false`);
  await db.query('delete from error_stats_hourly');
  await db.query('delete from error_samples');
});

interface ReportInput {
  readonly name?: string;
  readonly message?: string;
  readonly stack?: string;
  readonly kind?: string;
  readonly url?: string;
  readonly clientEventId?: string;
  readonly repeatCount?: number;
  readonly buildId?: string;
  readonly statusCode?: number;
  readonly errorCode?: string;
}

function report(input: ReportInput = {}): Record<string, unknown> {
  return {
    name: 'TypeError',
    message: 'Cannot read properties of null',
    kind: 'render',
    clientEventId: randomUUID(),
    ...input,
  };
}

/**
 * Каждый тест ходит со своего адреса.
 *
 * Лимит приёма ключуется по `request.ip`, а окно у него минутное: с общим
 * адресом первый же тест выбрал бы квоту на весь файл, и остальные проверяли
 * бы не то, что написано в их названии, а срабатывание лимита. Тест самого
 * лимита адрес фиксирует явно.
 */
let nextAddress = 0;

function freshAddress(): string {
  nextAddress += 1;
  return `10.10.0.${nextAddress}`;
}

async function post(
  body: Record<string, unknown>,
  options: { headers?: Record<string, string>; remoteAddress?: string } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: CLIENT_ERRORS_PATH,
    headers: { 'content-type': 'application/json', ...options.headers },
    remoteAddress: options.remoteAddress ?? freshAddress(),
    payload: body,
  });
}

/** Сброс накопителя: без него записи существуют только в памяти процесса. */
async function flush(): Promise<void> {
  await app.errorJournal.flush();
}

interface SampleRow {
  readonly source: string;
  readonly execution: string;
  readonly domain: string;
  readonly user_id: string | null;
  readonly route: string | null;
  readonly client_event_id: string | null;
  readonly repeat_count: number;
  readonly release: string | null;
  readonly context: Record<string, unknown> | null;
  readonly status_code: number | null;
  readonly error_code: string | null;
}

async function samples(): Promise<readonly SampleRow[]> {
  return db.query<SampleRow>(
    `select source, execution, domain, user_id, route, client_event_id, repeat_count,
            release, context, status_code, error_code
       from error_samples order by id`,
  );
}

async function signInEngineer(): Promise<string> {
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${KC_ENGINEER}`,
  });
  const location = started.headers['location'];
  const authorizationUrl = new URL(String(location));
  const loginCookie = started.cookies.filter((c) => c.name === LOGIN_COOKIE).at(-1);
  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: `${LOGIN_COOKIE}=${encodeURIComponent(String(loginCookie?.value))}` },
  });
  const session = completed.cookies.filter((c) => c.name === SESSION_COOKIE).at(-1);
  const csrf = completed.cookies.filter((c) => c.name === CSRF_COOKIE).at(-1);
  // CSRF-токен возвращается ради полноты входа; сам маршрут его не требует —
  // он в исключениях, потому что обязан работать и без сессии.
  expect(csrf?.value).toBeTruthy();
  return `${SESSION_COOKIE}=${encodeURIComponent(String(session?.value))}`;
}

describe('приём отчёта', () => {
  it('принимается без сессии: поломка экрана входа обязана быть видна', async () => {
    const response = await post(report());

    expect(
      response.statusCode,
      'отчёт без сессии отвергнут: тогда поломка экрана входа — тот случай, когда ' +
        'сообщить о ней изнутри портала уже нельзя — осталась бы невидимой',
    ).toBe(204);

    await flush();
    const rows = await samples();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('web');
    expect(rows[0]?.execution).toBe('client');
    expect(rows[0]?.user_id).toBeNull();
  });

  it('подставляет пользователя из сессии, а не из тела', async () => {
    const cookie = await signInEngineer();

    await post({ ...report(), userId: id(999) }, { headers: { cookie } });
    await flush();

    const [row] = await samples();
    expect(
      row?.user_id,
      'идентификатор пользователя взят из тела запроса: это позволило бы ' +
        'приписать чужую ошибку кому угодно',
    ).toBe(USER_ENGINEER);
  });

  it('классификацию ставит сервер, а не клиент', async () => {
    await post({ ...report(), source: 'api', domain: 'db', severity: 'fatal' });
    await flush();

    const [row] = await samples();
    expect(row?.source).toBe('web');
    expect(row?.domain).toBe('application');
  });

  it('сохраняет номер события, повторы и релиз', async () => {
    const eventId = randomUUID();
    await post(report({ clientEventId: eventId, repeatCount: 7 }));
    await flush();

    const [row] = await samples();
    expect(row?.client_event_id).toBe(eventId);
    expect(
      row?.repeat_count,
      'повторы потеряны: браузер подавляет одинаковые ошибки, и без этого числа ' +
        'частота веб-ошибок в журнале заведомо занижена',
    ).toBe(7);
    expect(row?.release).toBe('2026.08.9');
  });

  /**
   * Отказ чужого сервиса, с которым браузер говорит МИМО портала.
   *
   * Такой путь один — заливка байтов в S3 по presigned-адресу (§4.2), — и
   * запроса к порталу у неё нет, а значит нет ни `request_id`, ни серверной
   * строки журнала. Без этих двух полей `HTTP 500` от хранилища выглядит в
   * журнале безымянной веб-ошибкой: 26 августа 2026 года так и вышло.
   */
  it('сохраняет статус и код отказа чужого сервиса', async () => {
    await post(
      report({
        kind: 'manual',
        name: 'Error',
        message: 'Хранилище не приняло байты: HTTP 500 (InternalError, запрос TX42)',
        statusCode: 500,
        errorCode: 'InternalError',
      }),
    );
    await flush();

    const [row] = await samples();
    expect(row?.status_code).toBe(500);
    expect(
      row?.error_code,
      'без кода отказ хранилища неотличим в журнале от испорченной подписи',
    ).toBe('InternalError');
  });

  it('код отказа обязан быть идентификатором, а не текстом', async () => {
    // Значение приходит снаружи и становится осью журнала: текст в оси
    // расщепил бы группировку на одноразовые куски.
    const response = await post(report({ errorCode: 'Ошибка: не удалось <b>' }));

    expect(response.statusCode).toBe(422);
  });
});

describe('телу запроса не верят', () => {
  it('не сохраняет секрет из сообщения и строку запроса из адреса', async () => {
    const secret = 'chasovoy-web-secret-2201';
    await post(
      report({
        message: `Не удалось загрузить: token=${secret}`,
        url: `https://id.example.test/ids/folders/7f00?token=${secret}&q=Иванов`,
      }),
    );
    await flush();

    const [row] = await samples();
    const stored = JSON.stringify(row);

    expect(
      stored,
      'секрет из отчёта браузера доехал до журнала: сообщение обязано проходить ' +
        'нормализацию, а адрес — срез строки запроса',
    ).not.toContain(secret);
    expect(row?.route).toBe('https://id.example.test/ids/folders/7f00');
  });

  it('нормализует хэш сборки в кадрах стека', async () => {
    const stackOf = (hash: string): string =>
      [
        'TypeError: Cannot read properties of null',
        `    at renderFolder (https://id.example.test/assets/index-${hash}.js:12:34)`,
      ].join('\n');

    await post(report({ stack: stackOf('a1b2c3d4') }));
    await post(report({ stack: stackOf('e5f6a7b8') }));
    await flush();

    const signatures = await db.query<{ n: string }>(
      'select count(*)::text as n from error_signatures',
    );
    expect(
      Number(signatures[0]?.n),
      'две сборки одной ошибки дали две сигнатуры: хэш в имени файла меняется с ' +
        'каждым деплоем, и без его вырезания ряд по релизам распадается на куски',
    ).toBe(1);
  });
});

describe('стражи и лимиты', () => {
  it('отвергает запрос с чужого источника', async () => {
    const response = await post(report(), {
      headers: { origin: 'https://evil.example.net', 'sec-fetch-site': 'cross-site' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('отвергает не-JSON: форма с чужой страницы не проходит preflight', async () => {
    const response = await app.inject({
      method: 'POST',
      url: CLIENT_ERRORS_PATH,
      headers: { 'content-type': 'text/plain' },
      remoteAddress: freshAddress(),
      payload: 'name=TypeError',
    });

    expect(response.statusCode).toBe(415);
  });

  it('срабатывает лимит на адрес', async () => {
    const address = freshAddress();
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      codes.push(
        (await post(report({ message: `уникальное сообщение ${i}` }), { remoteAddress: address }))
          .statusCode,
      );
    }

    expect(
      codes.filter((code) => code === 429).length,
      'лимит не сработал: маршрут доступен без сессии, и без ограничения поток ' +
        'уникальных сообщений с одной машины наполнил бы журнал',
    ).toBeGreaterThan(0);
  });

  it('отвергает отчёт без обязательных полей', async () => {
    const response = await post({ message: 'без имени и вида' });
    expect(response.statusCode).toBe(422);
  });
});
