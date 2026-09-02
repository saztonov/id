/**
 * Срок хранения cookie сессии.
 *
 * До S45 обе cookie были сессионными: закрытое окно браузера стоило входа
 * заново, хотя серверная сессия была жива ещё много часов. Тесты держат два
 * условия, нарушение любого из которых возвращает разлогин в другом обличье:
 * `maxAge` равен абсолютному сроку сессии (а не окну простоя и не константе) и
 * одинаков у обеих cookie.
 */
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../config/env.js';
import { csrfCookieOptions, sessionCookieOptions } from './session.js';

const BASE: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/session-cookie-tests',
};

describe('срок хранения cookie', () => {
  it('равен абсолютному сроку сессии', () => {
    const env = loadEnv({ ...BASE, SESSION_IDLE_MINUTES: '720', SESSION_ABSOLUTE_HOURS: '168' });

    expect(sessionCookieOptions(env).maxAge).toBe(168 * 3600);
  });

  it('одинаков у cookie сессии и cookie CSRF', () => {
    // Разойдись они — пользователь вернулся бы с действующей сессией и без
    // CSRF-токена: чтение работает, любая запись отвечает 403, а восстановить
    // токен нечем (`POST /auth/csrf` сам требует предъявить текущий).
    const env = loadEnv({ ...BASE, SESSION_ABSOLUTE_HOURS: '24' });

    expect(csrfCookieOptions(env).maxAge).toBe(sessionCookieOptions(env).maxAge);
  });

  it('следует за настройкой, а не за константой', () => {
    const short = loadEnv({ ...BASE, SESSION_IDLE_MINUTES: '30', SESSION_ABSOLUTE_HOURS: '8' });

    expect(sessionCookieOptions(short).maxAge).toBe(8 * 3600);
  });

  it('не отменяет прочих свойств cookie', () => {
    // Регрессия на «добавили maxAge и потеряли httpOnly»: подпись и запрет
    // чтения из JavaScript — то, ради чего токены вообще не попадают в браузер.
    const env = loadEnv(BASE);
    const options = sessionCookieOptions(env);

    expect(options.httpOnly).toBe(true);
    expect(options.signed).toBe(true);
    expect(options.sameSite).toBe('lax');
    // CSRF-токен читает SPA: `httpOnly` здесь неприменим по построению.
    expect(csrfCookieOptions(env).httpOnly).toBe(false);
  });
});
