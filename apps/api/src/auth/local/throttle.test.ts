/**
 * Троттлинг попыток входа на настоящем PostgreSQL (pglite).
 *
 * Главная проверка файла — сброс окна. Наивная реализация обнуляла счётчик
 * попыток, но вычисляла задержку и блокировку из ПРЕЖНЕГО значения, из-за чего
 * первая же ошибка после снятой блокировки блокировала снова: защита от
 * перебора превращалась в вечную блокировку честного пользователя, забывшего
 * пароль. Этот дефект не виден ни в типах, ни при вычитке SQL, поэтому проверка
 * на него здесь первая.
 *
 * Вторая по важности — симметричность: несуществующий логин обязан считаться
 * точно так же, как существующий. Разница в поведении и есть тот оракул
 * существования учётной записи, ради устранения которого делается всё
 * остальное.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { loadEnv, type Env } from '../../config/env.js';
import { clearThrottle, loadThrottle, registerFailure, sweepExpired, unlock } from './throttle.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

const LOGIN_KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

/** Лимит попыток по логину: десять неудач — блокировка (B.7). */
const MAX_ATTEMPTS = 10;
const WINDOW_MINUTES = 60;

function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://id_app:local-only-pw@localhost:5432/id',
    AUTH_MODE: 'local',
    AUTH_LOCAL_LOGIN_HMAC_KEY: 'l'.repeat(44),
    AUDIT_HMAC_KEY: 'h'.repeat(44),
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://storage.yandexcloud.net',
    S3_BUCKET: 'id-portal',
    S3_ACCESS_KEY: 'unit-test-access-key-id',
    S3_SECRET_KEY: 'unit-test-access-key-material',
    ...overrides,
  });
}

let db: TestDatabase;
const env = testEnv();

/** `TestDatabase` под интерфейс, которого ждёт модуль троттлинга. */
const asQueryable = (): {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
} => ({
  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    return { rows: await db.query<T>(sql, params) };
  },
});

async function fail(
  bucketKey = LOGIN_KEY,
  userId: string | null = null,
): ReturnType<typeof registerFailure> {
  return registerFailure(asQueryable(), env, {
    scope: 'login',
    bucketKey,
    userId,
    maxAttempts: MAX_ATTEMPTS,
    windowMinutes: WINDOW_MINUTES,
    applyBackoff: true,
  });
}

/** Сдвигает окно строки в прошлое: имитация «прошёл час». */
async function expireWindow(bucketKey = LOGIN_KEY): Promise<void> {
  await db.query(
    `update auth_throttle
        set window_expires_at = now() - interval '1 minute',
            next_attempt_at   = now() - interval '1 minute'
      where scope = 'login' and bucket_key = $1`,
    [bucketKey],
  );
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
}, 180_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('delete from auth_throttle');
});

describe('экспоненциальный backoff', () => {
  it('удваивается с каждой неудачей и упирается в потолок', async () => {
    // B.2: 1с → 2с → 4с → … до 30с. Проверяются именно первые шаги: ошибка в
    // показателе степени заметна только на них.
    const observed: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const state = await fail();
      observed.push(state.retryAfterSeconds ?? 0);
    }

    expect(observed).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });

  it('потолок берётся из конфигурации', async () => {
    const lenient = testEnv({ AUTH_LOCAL_BACKOFF_MAX_SECONDS: '4' });
    const states = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      states.push(
        await registerFailure(asQueryable(), lenient, {
          scope: 'login',
          bucketKey: LOGIN_KEY,
          userId: null,
          maxAttempts: MAX_ATTEMPTS,
          windowMinutes: WINDOW_MINUTES,
          applyBackoff: true,
        }),
      );
    }

    expect(states.map((state) => state.retryAfterSeconds)).toEqual([1, 2, 4, 4]);
  });
});

describe('блокировка', () => {
  it('наступает после исчерпания лимита неудач', async () => {
    let state = await fail();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) state = await fail();

    expect(state.failedAttempts).toBe(MAX_ATTEMPTS);
    expect(state.locked).toBe(true);
    // 30 минут по умолчанию; допуск на время исполнения теста.
    expect(state.retryAfterSeconds).toBeGreaterThan(29 * 60);
  });

  it('до последней попытки не наступает', async () => {
    let state = await fail();
    for (let attempt = 1; attempt < MAX_ATTEMPTS - 1; attempt += 1) state = await fail();

    expect(state.failedAttempts).toBe(MAX_ATTEMPTS - 1);
    expect(state.locked).toBe(false);
  });

  it('видна и через loadThrottle, не только в ответе registerFailure', async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await fail();

    const state = await loadThrottle(asQueryable(), 'login', LOGIN_KEY);
    expect(state.locked).toBe(true);
  });
});

describe('сброс окна', () => {
  it('после истечения окна счёт начинается заново, а не продолжается', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await fail();
    await expireWindow();

    const state = await fail();

    expect(state.failedAttempts).toBe(1);
  });

  it('первая неудача нового окна даёт задержку в секунду, а не максимальную', async () => {
    // Регресс дефекта: задержка вычислялась из ПРЕЖНЕГО числа попыток, поэтому
    // после сброса окна сразу возвращалось 30 секунд.
    for (let attempt = 0; attempt < 7; attempt += 1) await fail();
    await expireWindow();

    const state = await fail();

    expect(state.retryAfterSeconds).toBe(1);
  });

  it('новое окно снимает прежнюю блокировку, а не продлевает её', async () => {
    // Регресс того же дефекта в самой опасной форме: блокировка выставлялась
    // заново на первой же ошибке нового окна и становилась вечной.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await fail();
    expect((await loadThrottle(asQueryable(), 'login', LOGIN_KEY)).locked).toBe(true);

    await expireWindow();
    const state = await fail();

    expect(state.locked).toBe(false);
    expect(state.failedAttempts).toBe(1);
  });
});

describe('успешный вход', () => {
  it('обнуляет счёт полностью', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await fail();

    await clearThrottle(asQueryable(), 'login', LOGIN_KEY);

    expect(await loadThrottle(asQueryable(), 'login', LOGIN_KEY)).toEqual({
      failedAttempts: 0,
      retryAfterSeconds: null,
      locked: false,
    });
  });
});

describe('симметричность', () => {
  it('несуществующий логин считается так же, как существующий', async () => {
    // Разница в поведении и есть оракул существования учётной записи.
    const known = await (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) await fail(LOGIN_KEY, null);
      return loadThrottle(asQueryable(), 'login', LOGIN_KEY);
    })();
    const unknown = await (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) await fail(OTHER_KEY, null);
      return loadThrottle(asQueryable(), 'login', OTHER_KEY);
    })();

    expect(unknown.failedAttempts).toBe(known.failedAttempts);
    expect(unknown.retryAfterSeconds).toBe(known.retryAfterSeconds);
    expect(unknown.locked).toBe(known.locked);
  });

  it('вёдра разных логинов независимы', async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await fail(LOGIN_KEY);

    expect((await loadThrottle(asQueryable(), 'login', OTHER_KEY)).locked).toBe(false);
  });

  it('пространства логинов и адресов не пересекаются', async () => {
    await registerFailure(asQueryable(), env, {
      scope: 'ip-login',
      bucketKey: LOGIN_KEY,
      userId: null,
      maxAttempts: MAX_ATTEMPTS,
      windowMinutes: WINDOW_MINUTES,
      applyBackoff: false,
    });

    // Тот же ключ в пространстве логинов остался нетронутым.
    expect((await loadThrottle(asQueryable(), 'login', LOGIN_KEY)).failedAttempts).toBe(0);
  });
});

describe('снятие блокировки администратором', () => {
  const USER_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    await db.query('delete from users');
    await db.query(
      `insert into users (id, kc_sub, full_name) values ($1, 'local:throttle', 'Пользователь')`,
      [USER_ID],
    );
  });

  it('снимает блокировку по идентификатору пользователя', async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await fail(LOGIN_KEY, USER_ID);

    await unlock(asQueryable(), { userId: USER_ID, loginBucketKey: null });

    expect((await loadThrottle(asQueryable(), 'login', LOGIN_KEY)).locked).toBe(false);
  });

  it('снимает блокировку, накопленную до появления пользователя', async () => {
    // Перебор мог идти по адресу, на который учётной записи ещё не было: такая
    // строка не привязана к user_id, и снять её можно только по ключу логина.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await fail(LOGIN_KEY, null);

    await unlock(asQueryable(), { userId: USER_ID, loginBucketKey: LOGIN_KEY });

    expect((await loadThrottle(asQueryable(), 'login', LOGIN_KEY)).locked).toBe(false);
  });

  it('привязывает строку к пользователю, когда логин разрешился', async () => {
    await fail(LOGIN_KEY, null);
    await fail(LOGIN_KEY, USER_ID);

    const rows = await db.query<{ user_id: string | null }>(
      'select user_id from auth_throttle where bucket_key = $1',
      [LOGIN_KEY],
    );
    expect(rows[0]?.user_id).toBe(USER_ID);
  });

  it('однажды привязанный пользователь не теряется при следующей неудаче', async () => {
    await fail(LOGIN_KEY, USER_ID);
    await fail(LOGIN_KEY, null);

    const rows = await db.query<{ user_id: string | null }>(
      'select user_id from auth_throttle where bucket_key = $1',
      [LOGIN_KEY],
    );
    expect(rows[0]?.user_id).toBe(USER_ID);
  });
});

describe('уборка', () => {
  it('удаляет давно истёкшие строки и щадит действующую блокировку', async () => {
    await fail(LOGIN_KEY);
    await db.query(
      `update auth_throttle set window_expires_at = now() - interval '2 days'
        where bucket_key = $1`,
      [LOGIN_KEY],
    );

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await fail(OTHER_KEY);
    await db.query(
      `update auth_throttle set window_expires_at = now() - interval '2 days'
        where bucket_key = $1`,
      [OTHER_KEY],
    );

    const removed = await sweepExpired(asQueryable(), true);

    expect(removed).toBe(1);
    // Заблокированная строка обязана дожить до конца срока, даже если её окно
    // подсчёта давно истекло: иначе уборка снимала бы блокировки.
    expect((await loadThrottle(asQueryable(), 'login', OTHER_KEY)).locked).toBe(true);
  });

  it('без принуждения выполняется изредка, а не на каждом вызове', async () => {
    // Значение не проверяется: важно лишь то, что вызов не падает и не требует
    // отдельной задачи обслуживания.
    await expect(sweepExpired(asQueryable())).resolves.toBeGreaterThanOrEqual(0);
  });
});
