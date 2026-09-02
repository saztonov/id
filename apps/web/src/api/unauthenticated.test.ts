/**
 * Конец сессии: объявление и его различение с «пароль не подошёл».
 *
 * Проверяется то, ради чего эти строки написаны (S45). Портал разлогинивал
 * людей раз в пару часов, и второй половиной проблемы была слепота клиента:
 * 401 в середине работы не приводил ни к чему, кроме красных карточек в
 * панелях, а понимал человек произошедшее только после перезагрузки.
 *
 * Здесь же лежит регрессия на ловушку, в которую легко провалиться при починке:
 * 401 в портале означает ДВА разных события. «Сессия истекла» на запросе данных
 * и «пароль не подошёл» на входе. Объявляй мы оба — опечатка в пароле подменяла
 * бы форму входа предложением войти, то есть войти стало бы нельзя.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { request } from './http.js';
import { resetQueueForTests } from './queue.js';
import {
  isSessionLost,
  notifyUnauthenticated,
  onUnauthenticated,
  resetSessionLostForTests,
} from './unauthenticated.js';

function respond(status: number): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetSessionLostForTests();
  resetQueueForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionLostForTests();
  resetQueueForTests();
});

describe('защёлка', () => {
  it('объявляет конец сессии подписчикам один раз', () => {
    let calls = 0;
    onUnauthenticated(() => {
      calls += 1;
    });

    // Экран ревизии держит десяток запросов, и все получают 401 в одну
    // секунду: без защёлки это десять уведомлений об одном событии.
    notifyUnauthenticated();
    notifyUnauthenticated();

    expect(calls).toBe(1);
    expect(isSessionLost()).toBe(true);
  });

  it('вызывает подписчика, пришедшего после объявления', () => {
    // Гонка между монтированием заслона и фоновым запросом иначе решала бы,
    // увидит ли человек экран входа.
    notifyUnauthenticated();

    let called = false;
    onUnauthenticated(() => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it('перестаёт звать отписавшегося', () => {
    let calls = 0;
    const unsubscribe = onUnauthenticated(() => {
      calls += 1;
    });
    unsubscribe();

    notifyUnauthenticated();

    expect(calls).toBe(0);
  });
});

describe('401 в транспорте', () => {
  it('объявляет конец сессии на обычном запросе', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond(401)));
    let called = false;
    onUnauthenticated(() => {
      called = true;
    });

    await expect(request('GET', '/api/v1/folders')).rejects.toThrow();

    expect(called).toBe(true);
  });

  it('МОЛЧИТ, когда 401 означает «пароль не подошёл»', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond(401)));
    let called = false;
    onUnauthenticated(() => {
      called = true;
    });

    await expect(
      request('POST', '/api/v1/auth/login', {
        body: { email: 'a@b.c', password: 'опечатка' },
        unauthenticatedIsExpected: true,
      }),
    ).rejects.toThrow();

    expect(called).toBe(false);
    expect(isSessionLost()).toBe(false);
  });

  it('не объявляет конец сессии на прочих отказах', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond(403)));
    let called = false;
    onUnauthenticated(() => {
      called = true;
    });

    await expect(request('GET', '/api/v1/folders')).rejects.toThrow();

    expect(called).toBe(false);
  });
});
