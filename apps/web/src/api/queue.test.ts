/**
 * Очередь запросов: дедупликация, повторы и пауза по лимиту (S24).
 *
 * Проверяется то, из-за отсутствия чего экран ревизии выбивал серверный лимит в
 * 300 запросов/минуту за секунды. Каждый набор соответствует одному звену той
 * цепочки:
 *
 * * пачка событий потока рождала по запросу на кадр — против этого дедупликация
 *   в полёте;
 * * `retry: 1` в клиенте кэша повторял и 429 — против этого повтор с паузой,
 *   которую назвал сервер;
 * * ни одно место не придерживало ОСТАЛЬНЫЕ запросы, пока лимит закрыт, — против
 *   этого общая пауза очереди.
 *
 * Тесты работают на поддельных таймерах: настоящая пауза по `Retry-After`
 * измеряется секундами, и честное ожидание превратило бы гейт в минуты простоя.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetQueueForTests, submit } from './queue.js';

function ok(body = '{}'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response('{}', {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
  });
}

beforeEach(() => {
  resetQueueForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetQueueForTests();
});

describe('дедупликация в полёте', () => {
  it('два одинаковых чтения дают ОДИН поход в сеть', async () => {
    let calls = 0;
    const send = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(ok('{"stage":"layout"}'));
    };

    // Ровно тот случай, который ронял портал: пачка кадров потока обесценивает
    // сводку конвейера, и TanStack Query шлёт запрос на каждый кадр.
    const [first, second] = await Promise.all([
      submit({ kind: 'read', dedupeKey: 'GET /status', send }),
      submit({ kind: 'read', dedupeKey: 'GET /status', send }),
    ]);

    expect(calls).toBe(1);
    // Тело обязано быть читаемым У ОБОИХ: `Response` отдаёт поток один раз, и
    // без клонирования второй ожидающий получил бы пустоту.
    expect(await first.json()).toEqual({ stage: 'layout' });
    expect(await second.json()).toEqual({ stage: 'layout' });
  });

  it('мутации не склеиваются: два одинаковых POST — два намерения', async () => {
    let calls = 0;
    const send = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(ok());
    };

    await Promise.all([
      submit({ kind: 'mutation', dedupeKey: null, send }),
      submit({ kind: 'mutation', dedupeKey: null, send }),
    ]);

    expect(calls).toBe(2);
  });

  it('ключ снимается после завершения: свежесть — дело кэша, а не очереди', async () => {
    let calls = 0;
    const send = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(ok());
    };

    await submit({ kind: 'read', dedupeKey: 'GET /status', send });
    await submit({ kind: 'read', dedupeKey: 'GET /status', send });

    expect(calls).toBe(2);
  });
});

describe('ответ 429', () => {
  it('повторяется после названной сервером паузы и доходит успехом', async () => {
    let calls = 0;
    const send = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(calls === 1 ? tooManyRequests(1) : ok('{"ok":true}'));
    };

    const pending = submit({ kind: 'read', dedupeKey: null, send });
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;

    expect(calls).toBe(2);
    expect(response.status).toBe(200);
  });

  it('придерживает ОСТАЛЬНЫЕ запросы, пока пауза не кончилась', async () => {
    // Суть общей паузы: бюджет лимита один на весь API (ключ — адрес клиента).
    // Придержать только запрос-виновник значит дать соседям добивать закрытый
    // лимит — и пауза никогда не кончится.
    let otherCalls = 0;

    // Отказ перехватывается СРАЗУ: между отправкой и проверкой ниже проходят
    // тики поддельных таймеров, и промис, отклонившийся без слушателя, всплыл бы
    // как unhandled rejection и загрязнил прогон.
    const limited = submit({
      kind: 'read',
      dedupeKey: null,
      send: () => Promise.resolve(tooManyRequests(2)),
    }).catch((error: unknown) => error);
    // Даём очереди отправить первый запрос и получить 429.
    await vi.advanceTimersByTimeAsync(0);

    const other = submit({
      kind: 'read',
      dedupeKey: null,
      send: () => {
        otherCalls += 1;
        return Promise.resolve(ok());
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(otherCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await other;
    expect(otherCalls).toBe(1);

    // Исчерпавший повторы 429 приходит ошибкой с названной паузой: без неё
    // экран не может сказать «данные подтянутся через N секунд».
    await expect(limited).resolves.toMatchObject({ status: 429, retryAfterMs: 2_000 });
  });
});

describe('повторы по классу запроса', () => {
  it('чтение повторяется по 503, мутация — нет', async () => {
    let readCalls = 0;
    const read = submit({
      kind: 'read',
      dedupeKey: null,
      send: () => {
        readCalls += 1;
        return Promise.resolve(readCalls === 1 ? new Response('{}', { status: 503 }) : ok());
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await read).status).toBe(200);
    expect(readCalls).toBe(2);

    // У мутации исход неизвестен: 503 мог прийти после того, как сервер всё
    // сделал, и повтор выполнил бы работу дважды.
    let writeCalls = 0;
    const write = submit({
      kind: 'mutation',
      dedupeKey: null,
      send: () => {
        writeCalls += 1;
        return Promise.resolve(new Response('{}', { status: 503 }));
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await write).status).toBe(503);
    expect(writeCalls).toBe(1);
  });

  it('прочие 4xx не повторяются вовсе', async () => {
    let calls = 0;
    const response = await submit({
      kind: 'read',
      dedupeKey: null,
      send: () => {
        calls += 1;
        return Promise.resolve(new Response('{}', { status: 404 }));
      },
    });

    // До S24 `retry: 1` в клиенте кэша повторял и это: второй запрос получал тот
    // же ответ и тратил слот лимита ни на что.
    expect(calls).toBe(1);
    expect(response.status).toBe(404);
  });
});
