/**
 * Разбор ответа-отказа: что именно узнает человек, открывший консоль задач.
 *
 * Предмет здесь один и он дорого стоил. На приёмке `rd.sync_init` пять раз
 * получил `500`, а в консоли задач стояло «RD WEB ответил» без продолжения:
 * их `500` отдавал `Internal Server Error` простым текстом вместо
 * `{"detail":{…}}` (§10), `JSON.parse` бросал, и оба поля оставались пустыми.
 * Ответ был у нас в руках, и мы его выбрасывали — отличить «сломан их
 * обработчик» от «сломано наше тело» удалось только серией ручных проб.
 *
 * Поэтому проверяются обе стороны правила: тело не в форме контракта доезжает
 * до текста ошибки, а тело В форме контракта по-прежнему разбирается и снимком
 * не подменяется. Первый тест без второго доказывал бы лишь то, что мы научились
 * печатать чужие байты.
 */
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../observability/logger.js';
import { createMetrics } from '../../observability/metrics.js';
import { ExecSyncClient } from './client.js';
import { ExecSyncError } from './port.js';

/** Часовой: строка, которой не должно быть ни в тексте ошибки, ни в журнале. */
const TOKEN = 'rdext-chasovoy-0001';

interface Harness {
  readonly client: ExecSyncClient;
  readonly logText: () => string;
}

function harness(respond: () => Response): Harness {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  const client = new ExecSyncClient({
    baseUrl: 'https://rdweb.invalid',
    token: TOKEN,
    metrics: createMetrics({ enabled: false, service: 'exec-client-test' }),
    logger: createLogger({ service: 'exec-client-test', level: 'trace', destination }),
    slowExternalMs: 10_000,
    fetchImpl: (() => Promise.resolve(respond())) as typeof fetch,
  });

  return { client, logText: () => chunks.join('') };
}

/** Один вызов, всегда падающий: возвращает сам отказ, а не бросает его дальше. */
async function failureOf(respond: () => Response): Promise<ExecSyncError> {
  const { client } = harness(respond);
  try {
    await client.request({ method: 'GET', path: '/document-syncs/x', operation: 'sync_read' });
  } catch (error) {
    if (error instanceof ExecSyncError) return error;
    throw error;
  }
  throw new Error('вызов обязан был отказать');
}

describe('тело не в форме контракта доезжает до диагностики', () => {
  it('простой текст вместо JSON — виден целиком', async () => {
    const failure = await failureOf(() => new Response('Internal Server Error', { status: 500 }));

    expect(failure.message).toBe(
      'RD WEB ответил 500, тело не в форме контракта: Internal Server Error',
    );
    expect(failure.status).toBe(500);
    // Код контракта не выдуман: его не было, и притворяться, что был, нельзя —
    // по коду задача решает, повторять или пересобирать снимок.
    expect(failure.code).toBeNull();
    expect(failure.retriable).toBe(true);
  });

  it('пустое тело названо пустым, а не выдано за молчание', async () => {
    const failure = await failureOf(() => new Response('', { status: 502 }));

    expect(failure.message).toBe('RD WEB ответил 502 с пустым телом');
  });

  it('страница ошибки обрезана и схлопнута в одну строку', async () => {
    const html = `<html>\n  <head><title>500</title></head>\n  <body>\n${'    <p>что-то пошло не так</p>\n'.repeat(20)}  </body>\n</html>`;
    const failure = await failureOf(() => new Response(html, { status: 500 }));

    expect(failure.message).toContain('тело не в форме контракта: <html> <head>');
    expect(failure.message.endsWith('…')).toBe(true);
    // Перевод строки разорвал бы одну запись журнала на полсотни, а прочитать её
    // всё равно нельзя.
    expect(failure.message).not.toContain('\n');
    expect(failure.message.length).toBeLessThan(280);
  });

  it('JSON без detail — тоже не форма контракта', async () => {
    const failure = await failureOf(
      () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    );

    expect(failure.message).toBe('RD WEB ответил 500, тело не в форме контракта: {"error":"boom"}');
  });
});

describe('тело В форме контракта разбирается как прежде', () => {
  it('detail объектом — код и текст, без снимка тела', async () => {
    const failure = await failureOf(
      () =>
        new Response(
          JSON.stringify({
            detail: { code: 'invalid_manifest', message: 'manifest_sha256 не совпадает' },
          }),
          { status: 422 },
        ),
    );

    expect(failure.message).toBe(
      'RD WEB ответил 422: invalid_manifest — manifest_sha256 не совпадает',
    );
    expect(failure.message).not.toContain('тело не в форме контракта');
    expect(failure.code).toBe('invalid_manifest');
    expect(failure.permanent).toBe(true);
  });

  it('detail строкой — текст берётся, снимок не подставляется', async () => {
    const failure = await failureOf(
      () => new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 }),
    );

    expect(failure.message).toBe('RD WEB ответил 404: Not Found');
    expect(failure.message).not.toContain('тело не в форме контракта');
  });
});

describe('удостоверение не утекает вместе с телом', () => {
  it('эхо токена вычеркнуто из текста ошибки', async () => {
    // Шлюз, вернувший присланный заголовок эхом, — не выдумка: ровно так на S3
    // `Authorization` уехал в объект ошибки LLM-провайдера. Решение печатать
    // чужой текст обязано нести с собой и защиту от этого.
    const failure = await failureOf(
      () => new Response(`upstream rejected: Bearer ${TOKEN}`, { status: 502 }),
    );

    expect(failure.message).not.toContain(TOKEN);
    expect(failure.message).toBe(
      'RD WEB ответил 502, тело не в форме контракта: upstream rejected: Bearer ***',
    );
  });

  it('и не появляется в журнале', async () => {
    const { client, logText } = harness(
      () => new Response(`upstream rejected: Bearer ${TOKEN}`, { status: 502 }),
    );

    await expect(
      client.request({ method: 'GET', path: '/document-syncs/x', operation: 'sync_read' }),
    ).rejects.toThrow(ExecSyncError);

    expect(logText()).not.toContain(TOKEN);
  });
});
