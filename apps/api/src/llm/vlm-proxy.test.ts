/**
 * VLM-провайдер `proxy_llm` (ADR-0007).
 *
 * Проверяются утверждения, нарушение которых — инцидент, а не красный тест:
 *
 * 1. **Форма тела** — data-URL кропов, `response_format` со строгой схемой,
 *    generation-профиль из запроса; ничего лишнего.
 * 2. **Идемпотентный ключ** стабилен между попытками одного вызова и различен
 *    между вызовами: от него зависит «не оплатить повтор дважды».
 * 3. **Предохранитель 24 MiB** срабатывает ДО сети.
 * 4. **Ни токен, ни base64 кропа** не доезжают до текстов ошибок.
 * 5. **Политика — до сети, кэш — до повторной оплаты.**
 * 6. **Оборванный и пустой ответы возвращаются, а не бросают**: классификация
 *    исхода блока — компетенция recognize-block, не провайдера.
 */
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../observability/logger.js';
import { createMetrics } from '../observability/metrics.js';
import { LlmPolicy, type SpendReader } from './policy.js';
import {
  LlmModelNotAllowedError,
  LlmPayloadTooLargeError,
  LlmProtocolError,
  LlmRateLimitError,
  LlmTimeoutError,
  LlmTransportError,
} from './port.js';
import { LruCache } from './prompt.js';
import type { VlmRequest } from './vlm-port.js';
import {
  ProxyVlmProvider,
  scrubDataPayload,
  VLM_MAX_BODY_BYTES,
  type CachedVlmCompletion,
} from './vlm-proxy.js';

/** Часовой: строка, которой не должно быть ни в журнале, ни в ошибках. */
const TOKEN = 'chasovoy-vlm-token-0001';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');

/** Отказ вызова как значение: `.catch()` дал бы объединение с успешным ответом. */
async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error('вызов обязан был завершиться отказом');
}

function request(overrides: Partial<VlmRequest> = {}): VlmRequest {
  return {
    stage: 'recognize',
    promptCode: 'recognition_block_text',
    promptVersion: 1,
    systemPrompt: 'Распознай блок. Отвечай строгим JSON.',
    userPrompt: 'Блок 3 страницы 2 рабочего документа.',
    images: [{ png: PNG }],
    responseFormat: {
      name: 'recognition_block_text',
      strict: true,
      schema: {
        type: 'object',
        properties: { fragments: { type: 'array' } },
        required: ['fragments'],
        additionalProperties: false,
      },
    },
    schemaVersion: 'recognition_block_text.v1',
    model: 'gw/vlm-a',
    temperature: 0.1,
    maxTokens: 12384,
    ...overrides,
  };
}

function okBody(
  text = '{"fragments":[]}',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: 'gw/vlm-a',
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.45678 },
    ...extra,
  };
}

interface Harness {
  readonly provider: ProxyVlmProvider;
  readonly calls: { url: string; init: RequestInit }[];
  readonly logText: () => string;
  readonly spendCalls: () => number;
}

function harness(
  respond: (call: number) => Response | Promise<Response>,
  overrides: {
    readonly allowedModels?: readonly string[];
    readonly budgetMonthly?: number;
    readonly rateLimitPerMin?: number;
    readonly spent?: number;
  } = {},
): Harness {
  const calls: { url: string; init: RequestInit }[] = [];
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  let spendCalls = 0;
  const spend: SpendReader = {
    monthlySpend: () => {
      spendCalls += 1;
      return Promise.resolve(overrides.spent ?? 0);
    },
  };

  const provider = new ProxyVlmProvider({
    baseUrl: 'https://llm-gw.internal/v1',
    token: TOKEN,
    timeoutMs: 5_000,
    metrics: createMetrics({ enabled: false, service: 'vlm-test' }),
    logger: createLogger({ service: 'vlm-test', level: 'trace', destination }),
    slowExternalMs: 1,
    policy: new LlmPolicy({
      allowedModels: overrides.allowedModels ?? ['gw/vlm-a', 'gw/vlm-b'],
      emptyAllowlist: 'deny',
      budgetMonthly: overrides.budgetMonthly ?? 0,
      rateLimitPerMin: overrides.rateLimitPerMin ?? 60,
      spend,
      now: () => 0,
    }),
    cache: new LruCache<CachedVlmCompletion>({ maxEntries: 16, ttlMs: 60_000 }),
    fetchImpl: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(respond(calls.length - 1));
    }) as typeof fetch,
  });

  return { provider, calls, logText: () => chunks.join(''), spendCalls: () => spendCalls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function idempotencyHeaderOf(call: { init: RequestInit }): string {
  return (call.init.headers as Record<string, string>)['X-Idempotency-Key'] ?? '';
}

describe('форма тела', () => {
  it('кроп уходит data-URL внутри контент-массива пользовательского сообщения', async () => {
    const h = harness(() => jsonResponse(okBody()));
    await h.provider.complete(request());

    const body = bodyOf(h.calls[0]!);
    expect(Object.keys(body).sort()).toStrictEqual([
      'max_tokens',
      'messages',
      'model',
      'response_format',
      'stream',
      'temperature',
    ]);

    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toStrictEqual({
      role: 'system',
      content: 'Распознай блок. Отвечай строгим JSON.',
    });

    const parts = messages[1]!.content as Record<string, unknown>[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toStrictEqual({
      type: 'text',
      text: 'Блок 3 страницы 2 рабочего документа.',
    });
    expect(parts[1]).toStrictEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
    });

    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(12384);
    expect(body.stream).toBe(false);
  });

  it('response_format уходит строгой json_schema', async () => {
    const h = harness(() => jsonResponse(okBody()));
    await h.provider.complete(request());

    expect(bodyOf(h.calls[0]!).response_format).toStrictEqual({
      type: 'json_schema',
      json_schema: {
        name: 'recognition_block_text',
        strict: true,
        schema: {
          type: 'object',
          properties: { fragments: { type: 'array' } },
          required: ['fragments'],
          additionalProperties: false,
        },
      },
    });
  });

  it('top_k кладётся только когда задан', async () => {
    const without = harness(() => jsonResponse(okBody()));
    await without.provider.complete(request());
    expect(bodyOf(without.calls[0]!)).not.toHaveProperty('top_k');

    const withTopK = harness(() => jsonResponse(okBody()));
    await withTopK.provider.complete(request({ topK: 1, temperature: 0 }));
    expect(bodyOf(withTopK.calls[0]!).top_k).toBe(1);
  });
});

describe('идемпотентный ключ', () => {
  it('стабилен между сетевыми попытками одного вызова', async () => {
    // Первая попытка падает 503 (отказ не кэшируется), повтор обязан привезти
    // тот же ключ — иначе шлюз исполнит и оплатит вызов второй раз.
    const h = harness((call) =>
      call === 0 ? jsonResponse({ detail: 'upstream' }, 503) : jsonResponse(okBody()),
    );

    await expect(h.provider.complete(request())).rejects.toBeInstanceOf(LlmTransportError);
    await h.provider.complete(request());

    expect(h.calls).toHaveLength(2);
    expect(idempotencyHeaderOf(h.calls[0]!)).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyHeaderOf(h.calls[1]!)).toBe(idempotencyHeaderOf(h.calls[0]!));
  });

  it('различен для разных моделей', async () => {
    const h = harness(() => jsonResponse(okBody()));

    await h.provider.complete(request());
    await h.provider.complete(request({ model: 'gw/vlm-b' }));

    expect(h.calls).toHaveLength(2);
    expect(idempotencyHeaderOf(h.calls[1]!)).not.toBe(idempotencyHeaderOf(h.calls[0]!));
  });
});

describe('предохранитель размера тела', () => {
  it('тело больше 24 MiB не отправляется вовсе', async () => {
    // 19 MiB PNG → ~25.3 MiB base64: за потолком. Ошибка обязана прийти ДО
    // fetch — отправка заведомо непроходного тела оплатила бы трафик и 413.
    const h = harness(() => jsonResponse(okBody()));
    const oversized = new Uint8Array(19 * 1024 * 1024);

    const error = await failureOf(h.provider.complete(request({ images: [{ png: oversized }] })));

    expect(error).toBeInstanceOf(LlmPayloadTooLargeError);
    expect(h.calls).toHaveLength(0);
    const typed = error as LlmPayloadTooLargeError;
    expect(typed.bytes).toBeGreaterThan(VLM_MAX_BODY_BYTES);
    // Не повторяется как есть, но прогон не останавливает: вызывающий делает
    // downscale-retry.
    expect(typed.retriable).toBe(false);
    expect(typed.stopsBatch).toBe(false);
  });

  it('413 шлюза приходит тем же классом LlmPayloadTooLargeError', async () => {
    const h = harness(() => jsonResponse({ error: { message: 'entity too large' } }, 413));

    const error = await failureOf(h.provider.complete(request()));
    expect(error).toBeInstanceOf(LlmPayloadTooLargeError);
    expect((error as LlmPayloadTooLargeError).retriable).toBe(false);
  });
});

describe('отказы', () => {
  it('429 — LlmRateLimitError, повторяем', async () => {
    const h = harness(() => jsonResponse({ error: { message: 'slow down' } }, 429));

    await expect(h.provider.complete(request())).rejects.toMatchObject({
      name: 'LlmRateLimitError',
      retriable: true,
    });
  });

  it('503 — LlmTransportError, повторяем', async () => {
    const h = harness(() => jsonResponse({ detail: 'upstream' }, 503));

    await expect(h.provider.complete(request())).rejects.toMatchObject({
      name: 'LlmTransportError',
      status: 503,
      retriable: true,
    });
  });

  it('таймаут — LlmTimeoutError с настроенным потолком', async () => {
    const h = harness(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      return Promise.reject(error) as unknown as Response;
    });

    const error = await failureOf(h.provider.complete(request()));
    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect((error as LlmTimeoutError).timeoutMs).toBe(5_000);
    expect((error as LlmTimeoutError).retriable).toBe(true);
  });

  it('502 upstream_response_too_large — LlmProtocolError, не ретраится', async () => {
    const tooLarge = harness(() =>
      jsonResponse(
        { error: { message: 'response too large', code: 'upstream_response_too_large' } },
        502,
      ),
    );
    const error = await failureOf(tooLarge.provider.complete(request()));
    expect(error).toBeInstanceOf(LlmProtocolError);
    expect((error as LlmProtocolError).retriable).toBe(false);

    // Обычный 502 остаётся повторяемым транспортным сбоем.
    const plain = harness(() => jsonResponse({ error: { message: 'bad gateway' } }, 502));
    await expect(plain.provider.complete(request())).rejects.toMatchObject({
      name: 'LlmTransportError',
      retriable: true,
    });
  });

  it('ответ без choices — LlmProtocolError', async () => {
    const h = harness(() => jsonResponse({ model: 'gw/vlm-a', choices: [] }));

    await expect(h.provider.complete(request())).rejects.toMatchObject({
      name: 'LlmProtocolError',
      retriable: false,
    });
  });
});

describe('оборванный и пустой ответы — данные, а не исключения', () => {
  it('finish_reason=length возвращается вызывающему', async () => {
    // Решение об исходе блока (invalid_response) принимает recognize-block:
    // провайдер обязан довезти факт обрыва, а не классифицировать сам.
    const h = harness(() =>
      jsonResponse(
        okBody('{"fragments":[{"kind":"par', {
          choices: [{ message: { content: '{"fragments":[{"kind":"par' }, finish_reason: 'length' }],
        }),
      ),
    );

    const response = await h.provider.complete(request());
    expect(response.finishReason).toBe('length');
    expect(response.text).toBe('{"fragments":[{"kind":"par');
  });

  it('пустой content при finish_reason=stop возвращается как text:""', async () => {
    const h = harness(() =>
      jsonResponse({
        model: 'gw/vlm-a',
        choices: [{ message: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 900, completion_tokens: 0 },
      }),
    );

    const response = await h.provider.complete(request());
    expect(response.text).toBe('');
    expect(response.finishReason).toBe('stop');
    expect(response.outputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('отсутствующий finish_reason становится null', async () => {
    const h = harness(() =>
      jsonResponse({ model: 'gw/vlm-a', choices: [{ message: { content: '{}' } }] }),
    );

    expect((await h.provider.complete(request())).finishReason).toBeNull();
  });
});

describe('успешный вызов', () => {
  it('возвращает текст, usage, хэши и пару requested/actual моделей', async () => {
    const h = harness(() => jsonResponse(okBody('{"fragments":[]}', { model: 'gw/vlm-a-2026' })));

    const response = await h.provider.complete(request());
    expect(response.text).toBe('{"fragments":[]}');
    expect(response.provider).toBe('proxy_llm');
    // Роутинг шлюза подменил слаг: actual — из ответа, requested — из запроса.
    expect(response.model).toBe('gw/vlm-a-2026');
    expect(response.requestedModel).toBe('gw/vlm-a');
    expect(response.tokensIn).toBe(900);
    expect(response.tokensOut).toBe(40);
    expect(response.cost).toBe(0.4568);
    expect(response.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(response.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(response.cacheHit).toBe(false);
  });

  it('отсутствие usage даёт null, а не ноль', async () => {
    const h = harness(() =>
      jsonResponse({ model: 'gw/vlm-a', choices: [{ message: { content: '{}' } }] }),
    );

    const response = await h.provider.complete(request());
    expect(response.tokensIn).toBeNull();
    expect(response.tokensOut).toBeNull();
    expect(response.cost).toBeNull();
  });
});

describe('секреты в текстах ошибок', () => {
  it('ни токен, ни data-URL кропа не доезжают до message', async () => {
    // Шлюз возвращает эхом и заголовок авторизации, и кусок присланного тела.
    const h = harness(() =>
      jsonResponse(
        {
          error: {
            message:
              `unauthorized: Bearer ${TOKEN}; body was ` +
              `data:image/png;base64,${'A'.repeat(300)} and more`,
          },
        },
        400,
      ),
    );

    const error = await failureOf(h.provider.complete(request()));
    expect(error).toBeInstanceOf(LlmTransportError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('base64,A');
    expect(error.message).not.toMatch(/[A-Za-z0-9+/]{64,}/);
    expect(error.message).toContain('***');
    expect(h.logText()).not.toContain(TOKEN);
  });

  it('scrubDataPayload маскирует и голый base64-хвост без заголовка', () => {
    // Усечение текста отказа до 200 символов может отрезать `data:...;base64,`,
    // оставив только содержимое картинки.
    expect(scrubDataPayload('A'.repeat(80))).toBe('***');
    expect(scrubDataPayload(`ошибка: data:image/png;base64,${'B'.repeat(40)} хвост`)).toBe(
      'ошибка: data:*** хвост',
    );
    expect(scrubDataPayload('обычный текст отказа')).toBe('обычный текст отказа');
  });
});

describe('политика и кэш', () => {
  it('запрещённая модель отвергается до кэша и до сети', async () => {
    const h = harness(() => jsonResponse(okBody()), { allowedModels: ['gw/other'] });

    await expect(h.provider.complete(request())).rejects.toBeInstanceOf(LlmModelNotAllowedError);
    expect(h.calls).toHaveLength(0);
    expect(h.spendCalls()).toBe(0);
  });

  it('исчерпанный бюджет останавливает вызов до сети', async () => {
    const h = harness(() => jsonResponse(okBody()), { budgetMonthly: 10, spent: 10 });

    await expect(h.provider.complete(request())).rejects.toMatchObject({ name: 'LlmBudgetError' });
    expect(h.calls).toHaveLength(0);
  });

  it('превышение частоты останавливает вызов до сети', async () => {
    const h = harness(() => jsonResponse(okBody()), { rateLimitPerMin: 1 });

    await h.provider.complete(request());
    await expect(h.provider.complete(request({ userPrompt: 'другой блок' }))).rejects.toBeInstanceOf(
      LlmRateLimitError,
    );
    expect(h.calls).toHaveLength(1);
  });

  it('кэш-хит не делает второй fetch и не тратит бюджет', async () => {
    const h = harness(() => jsonResponse(okBody()), { budgetMonthly: 1000 });

    const first = await h.provider.complete(request());
    const second = await h.provider.complete(request());

    expect(h.calls).toHaveLength(1);
    expect(h.spendCalls()).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.text).toBe(first.text);
    expect(second.finishReason).toBe(first.finishReason);
    expect(second.inputHash).toBe(first.inputHash);
  });

  it('другой кроп — это другой вызов, а не кэш-хит', async () => {
    const h = harness(() => jsonResponse(okBody()));

    await h.provider.complete(request());
    await h.provider.complete(
      request({ images: [{ png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]) }] }),
    );

    expect(h.calls).toHaveLength(2);
  });

  it('пустая модель отвергается с внятной причиной до сети', async () => {
    const h = harness(() => jsonResponse(okBody()));

    const error = await failureOf(h.provider.complete(request({ model: '' })));
    expect(error).toBeInstanceOf(LlmModelNotAllowedError);
    expect(error.message).toContain('recognition.vlm_model');
    expect(h.calls).toHaveLength(0);
  });
});
