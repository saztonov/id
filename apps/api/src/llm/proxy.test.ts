/**
 * Провайдер `proxy_llm` (§10).
 *
 * Проверяется не «функция сходила по HTTP», а четыре утверждения, каждое из
 * которых при нарушении даёт не падение теста, а инцидент:
 *
 * 1. **Наружу уходит только текст.** Тело запроса разбирается целиком и
 *    проверяется на отсутствие полей-изображений и base64-подобных строк.
 * 2. **Токен не утекает** ни в журнал, ни в текст ошибки — даже если шлюз
 *    вернул его эхом (урок S3: `Authorization` утекает из объекта ошибки).
 * 3. **Кэш экономит и деньги, и вызовы**: второй идентичный запрос не ходит
 *    наружу и не читает бюджет.
 * 4. **Отказы доезжают до вызывающего в своих классах** с верным `retriable`.
 */
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../observability/logger.js';
import { createMetrics } from '../observability/metrics.js';
import { LlmPolicy, type SpendReader } from './policy.js';
import {
  LlmModelNotAllowedError,
  LlmProtocolError,
  LlmRateLimitError,
  LlmTransportError,
  type LlmRequest,
} from './port.js';
import { LruCache } from './prompt.js';
import {
  ProxyLlmProvider,
  chatCompletionsUrl,
  describeFailure,
  idempotencyKey,
  type CachedCompletion,
} from './proxy.js';

/** Часовой: строка, которой в журнале и в ошибках не должно быть нигде. */
const TOKEN = 'chasovoy-llm-token-0001';

/** Отказ вызова как значение: `.catch()` дал бы объединение с успешным ответом. */
async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error('вызов обязан был завершиться отказом');
}

const REQUEST: LlmRequest = {
  stage: 'page_classify',
  promptCode: 'page_classify_open_world',
  promptVersion: 1,
  systemPrompt: 'Классифицируй страницу. Отвечай JSON по схеме.',
  userPrompt: 'АКТ\nосвидетельствования скрытых работ №12',
  schemaVersion: 'page_classify.v1',
  cacheContext: 'prev=U;next=U',
  model: 'gw/model-a',
};

function okBody(text = '{"label":"B-DOC","doc_type":"aosr","confidence":0.9}') {
  return {
    model: 'gw/model-a',
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.12345 },
  };
}

interface Harness {
  readonly provider: ProxyLlmProvider;
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

  const provider = new ProxyLlmProvider({
    baseUrl: 'https://llm-gw.internal/v1',
    token: TOKEN,
    defaultModel: 'gw/model-a',
    timeoutMs: 5_000,
    metrics: createMetrics({ enabled: false, service: 'llm-test' }),
    logger: createLogger({ service: 'llm-test', level: 'trace', destination }),
    slowExternalMs: 1,
    policy: new LlmPolicy({
      allowedModels: overrides.allowedModels ?? ['gw/model-a'],
      emptyAllowlist: 'deny',
      budgetMonthly: overrides.budgetMonthly ?? 0,
      rateLimitPerMin: overrides.rateLimitPerMin ?? 60,
      spend,
      now: () => 0,
    }),
    cache: new LruCache<CachedCompletion>({ maxEntries: 16, ttlMs: 60_000 }),
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

describe('адрес эндпоинта', () => {
  it('не теряет префикс версии из базового адреса', () => {
    // `new URL('chat/completions', 'https://gw/v1')` отбросил бы `/v1`.
    expect(chatCompletionsUrl('https://llm-gw.internal/v1')).toBe(
      'https://llm-gw.internal/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://llm-gw.internal/v1/')).toBe(
      'https://llm-gw.internal/v1/chat/completions',
    );
  });
});

describe('наружу уходит только текст (§10)', () => {
  it('тело запроса состоит из модели и двух текстовых сообщений', async () => {
    const h = harness(() => jsonResponse(okBody()));
    await h.provider.complete(REQUEST);

    const body = bodyOf(h.calls[0]!);
    expect(Object.keys(body).sort()).toStrictEqual(['messages', 'model', 'stream', 'temperature']);

    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(typeof message.content).toBe('string');
      expect(Object.keys(message).sort()).toStrictEqual(['content', 'role']);
    }
    // Температура нулевая: иначе один промт даёт разные метки, а кэш по хэшу
    // промта превращается в лотерею.
    expect(body.temperature).toBe(0);
  });

  it('в теле нет ни image_url, ни base64-подобных строк, ни путей к файлам', async () => {
    const h = harness(() => jsonResponse(okBody()));
    await h.provider.complete(REQUEST);

    const raw = String(h.calls[0]!.init.body);
    for (const forbidden of ['image_url', 'image', 'input_audio', 'file_id', 'b64_json', 'data:']) {
      expect(raw, `в теле запроса встретилось «${forbidden}»`).not.toContain(forbidden);
    }
    // Длинная строка без пробелов из алфавита base64 — это приложенная
    // картинка или PDF. Промт из текста ИД такой строки не даёт.
    expect(raw).not.toMatch(/[A-Za-z0-9+/]{200,}={0,2}/);
  });

  it('соседний контекст в промт не дублируется', async () => {
    const h = harness(() => jsonResponse(okBody()));
    await h.provider.complete({ ...REQUEST, cacheContext: 'CHASOVOY-SOSEDNIY-KONTEKST' });

    // §8.2: контекст входит в КЛЮЧ КЭША, а модель видит его только в том виде,
    // в каком вызывающий вложил его в userPrompt. Второй кусок означал бы
    // двойную оплату одних и тех же токенов.
    expect(String(h.calls[0]!.init.body)).not.toContain('CHASOVOY-SOSEDNIY-KONTEKST');
  });
});

describe('идемпотентный ключ (контракт шлюза)', () => {
  const headerOf = (call: { init: RequestInit }): string =>
    (call.init.headers as Record<string, string>)['X-Idempotency-Key'] ?? '';

  it('равен sha256(inputHash:model) и едет в каждом запросе', async () => {
    const h = harness(() => jsonResponse(okBody()));
    const response = await h.provider.complete(REQUEST);

    const expected = createHash('sha256')
      .update(`${response.inputHash}:gw/model-a`, 'utf8')
      .digest('hex');
    expect(headerOf(h.calls[0]!)).toBe(expected);
    expect(idempotencyKey(response.inputHash, 'gw/model-a')).toBe(expected);
  });

  it('стабилен между сетевыми попытками одного и того же вызова', async () => {
    // Первая попытка падает 503 (ответ с ошибкой не кэшируется), движок задач
    // повторяет вызов — шлюз обязан увидеть ТОТ ЖЕ ключ, иначе повтор
    // исполнится и оплатится как новый вызов.
    const h = harness((call) =>
      call === 0 ? jsonResponse({ detail: 'upstream' }, 503) : jsonResponse(okBody()),
    );

    await expect(h.provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmTransportError);
    await h.provider.complete(REQUEST);

    expect(h.calls).toHaveLength(2);
    expect(headerOf(h.calls[0]!)).toMatch(/^[0-9a-f]{64}$/);
    expect(headerOf(h.calls[1]!)).toBe(headerOf(h.calls[0]!));
  });

  it('различен для разных моделей и разных промтов', async () => {
    const h = harness(() => jsonResponse(okBody()), {
      allowedModels: ['gw/model-a', 'gw/model-b'],
    });

    await h.provider.complete(REQUEST);
    await h.provider.complete({ ...REQUEST, model: 'gw/model-b' });
    await h.provider.complete({ ...REQUEST, userPrompt: 'ПАСПОРТ КАЧЕСТВА №7' });

    const keys = h.calls.map((call) => headerOf(call));
    expect(new Set(keys).size).toBe(3);
  });
});

describe('токен', () => {
  it('едет только в заголовке Authorization', async () => {
    const h = harness(() => jsonResponse(okBody()));
    await h.provider.complete(REQUEST);

    const headers = h.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(h.calls[0]!.init.body)).not.toContain(TOKEN);
    expect(h.calls[0]!.url).not.toContain(TOKEN);
  });

  it('не появляется в журнале — ни при успехе, ни при отказе', async () => {
    const ok = harness(() => jsonResponse(okBody()));
    await ok.provider.complete(REQUEST);
    expect(ok.logText()).not.toContain(TOKEN);
    // Медленный вызов пишется отдельной строкой warn — она тоже проверяется.
    expect(ok.logText()).toContain('external_call');

    const failed = harness(() => jsonResponse({ error: { message: 'boom' } }, 500));
    await expect(failed.provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmTransportError);
    expect(failed.logText()).not.toContain(TOKEN);
  });

  it('вырезается из текста ошибки, даже если шлюз вернул его эхом', async () => {
    const h = harness(() =>
      jsonResponse({ error: { message: `invalid api key: Bearer ${TOKEN}` } }, 401),
    );

    await expect(h.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmTransportError',
      status: 401,
      // 401 повторять бессмысленно: ключ не станет верным сам собой.
      retriable: false,
    });
    const error = await failureOf(h.provider.complete(REQUEST));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('***');
  });
});

describe('успешный вызов', () => {
  it('возвращает текст, хэши, токены и стоимость', async () => {
    const h = harness(() => jsonResponse(okBody()));
    const response = await h.provider.complete(REQUEST);

    expect(response.text).toContain('B-DOC');
    expect(response.provider).toBe('proxy_llm');
    expect(response.model).toBe('gw/model-a');
    expect(response.tokensIn).toBe(120);
    expect(response.tokensOut).toBe(30);
    // `numeric(12,4)` в БД: округление до четырёх знаков делается здесь.
    expect(response.cost).toBe(0.1235);
    expect(response.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(response.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(response.cacheHit).toBe(false);
  });

  it('отсутствие usage даёт null, а не ноль', async () => {
    const h = harness(() => jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const response = await h.provider.complete(REQUEST);

    // Ноль означал бы «вызов был бесплатным» и занижал бы месячную трату,
    // по которой считается бюджет §11.
    expect(response.tokensIn).toBeNull();
    expect(response.tokensOut).toBeNull();
    expect(response.cost).toBeNull();
  });

  it('в ai_runs попадает модель, которая ОТВЕТИЛА', async () => {
    const h = harness(() => jsonResponse({ ...okBody(), model: 'gw/model-a-2026-08' }));
    const response = await h.provider.complete(REQUEST);

    expect(response.model).toBe('gw/model-a-2026-08');
  });
});

describe('кэш', () => {
  it('повторный идентичный вызов не ходит наружу и не тратит бюджет', async () => {
    const h = harness(() => jsonResponse(okBody()), { budgetMonthly: 1000 });

    const first = await h.provider.complete(REQUEST);
    const second = await h.provider.complete(REQUEST);

    expect(h.calls).toHaveLength(1);
    expect(h.spendCalls()).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.text).toBe(first.text);
    expect(second.inputHash).toBe(first.inputHash);
    expect(second.outputHash).toBe(first.outputHash);
  });

  it('другой соседний контекст — это другой вызов', async () => {
    const h = harness(() => jsonResponse(okBody()));

    await h.provider.complete(REQUEST);
    await h.provider.complete({ ...REQUEST, cacheContext: 'prev=B-DOC;next=U' });

    expect(h.calls).toHaveLength(2);
  });

  it('запрещённая модель не обслуживается из кэша', async () => {
    const h = harness(() => jsonResponse(okBody()));
    await h.provider.complete(REQUEST);

    const strict = harness(() => jsonResponse(okBody()), { allowedModels: ['gw/model-b'] });
    // Allowlist проверяется ДО кэша: иначе отозванная модель продолжала бы
    // обслуживать вызовы из памяти процесса.
    await expect(strict.provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmModelNotAllowedError);
    expect(strict.calls).toHaveLength(0);
  });
});

describe('отказы', () => {
  it('429 — это LlmRateLimitError и он повторяем', async () => {
    const h = harness(() => jsonResponse({ error: { message: 'slow down' } }, 429));

    await expect(h.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmRateLimitError',
      retriable: true,
    });
  });

  it('пауза из Retry-After доезжает до вызывающего', async () => {
    // Шлюз знает, когда откроется окно, а экспоненциальный откат движка только
    // гадает: повтор раньше названного срока получит те же 429 и потратит
    // попытку впустую. Поэтому названная пауза обязана дойти как значение, а не
    // остаться в заголовке ответа, который никто не прочитал.
    const seconds = harness(
      () =>
        new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    );
    await expect(seconds.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmRateLimitError',
      retryAfterMs: 30_000,
    });

    // Заголовка нет — паузу назначает откат движка, и поле честно пустое.
    const silent = harness(() => jsonResponse({ error: { message: 'slow down' } }, 429));
    await expect(silent.provider.complete(REQUEST)).rejects.toMatchObject({
      retryAfterMs: undefined,
    });
  });

  it('отмена попытки доходит своей причиной, а не таймаутом шлюза', async () => {
    // Отмену ставит движок задач (`JobTimeout`, `LeaseLost`), и подменять её на
    // «шлюз LLM не ответил» нельзя: разбор инцидента ушёл бы к провайдеру,
    // тогда как виноват потолок попытки. Отменённый fetch реджектится причиной
    // сигнала — её и обязан пробросить провайдер.
    const cancellation = new Error('попытка не уложилась в 600000 мс');
    cancellation.name = 'JobTimeout';
    const controller = new AbortController();

    const h = harness(() => {
      controller.abort(cancellation);
      return Promise.reject(cancellation) as unknown as Response;
    });

    await expect(h.provider.complete({ ...REQUEST, signal: controller.signal })).rejects.toBe(
      cancellation,
    );
  });

  it('5xx повторяем, 4xx — нет', async () => {
    const server = harness(() => jsonResponse({ detail: 'upstream' }, 503));
    await expect(server.provider.complete(REQUEST)).rejects.toMatchObject({ retriable: true });

    const client = harness(() => jsonResponse({ detail: 'bad model' }, 400));
    await expect(client.provider.complete(REQUEST)).rejects.toMatchObject({ retriable: false });
  });

  it('таймаут доходит как LlmTimeoutError', async () => {
    const h = harness(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      return Promise.reject(error) as unknown as Response;
    });

    await expect(h.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmTimeoutError',
      retriable: true,
      timeoutMs: 5_000,
    });
  });

  it('сетевой сбой доходит как LlmTransportError и повторяем', async () => {
    const h = harness(() => Promise.reject(new TypeError('fetch failed')) as unknown as Response);

    await expect(h.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmTransportError',
      retriable: true,
    });
  });

  it('не-JSON и пустой текст — это LlmProtocolError и он НЕ повторяем', async () => {
    const garbage = harness(
      () => new Response('не json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(garbage.provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmProtocolError);

    const blank = harness(() => jsonResponse({ choices: [{ message: { content: '' } }] }));
    await expect(blank.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmProtocolError',
      // Повтор детерминированного промта даст тот же непригодный ответ и
      // потратит бюджет впустую.
      retriable: false,
    });
  });

  it('ответ без choices — молчание апстрима, и он ПОВТОРЯЕМ', async () => {
    // Выглядит как непригодный ответ, но им не является: тела без `choices`
    // промт не порождает — так шлюз пересказывает отказ провайдера. На боевых
    // прогонах семь таких вызовов из восьми проходили со следующей попытки, а
    // неповторяемый класс лишал их этой попытки вовсе.
    const empty = harness(() => jsonResponse({ choices: [] }));

    await expect(empty.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmUpstreamError',
      retriable: true,
    });
  });

  it('finish_reason=length — это LlmProtocolError, а не тихий успех', async () => {
    // Ответ оборван по max_tokens: JSON гарантированно неполон, вызов оплачен.
    // Повтор оборвётся на том же токене — поэтому не retriable.
    const h = harness(() =>
      jsonResponse({
        model: 'gw/model-a',
        choices: [{ message: { content: '{"label":"B-DOC","doc_' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 120, completion_tokens: 4096, cost: 0.5 },
      }),
    );

    const error = await failureOf(h.provider.complete(REQUEST));
    expect(error).toBeInstanceOf(LlmProtocolError);
    expect((error as LlmProtocolError).retriable).toBe(false);
    expect(error.message).toContain('max_tokens');
    expect(error.message).toContain('оборван');
  });

  it('пустой content — это LlmProtocolError с внятной причиной', async () => {
    const h = harness(() =>
      jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
    );

    const error = await failureOf(h.provider.complete(REQUEST));
    expect(error).toBeInstanceOf(LlmProtocolError);
    expect((error as LlmProtocolError).retriable).toBe(false);
    expect(error.message).toContain('Пустой ответ');
  });

  it('502 upstream_response_too_large не ретраится', async () => {
    // 502 без кода — преходящий сбой шлюза и повторяем; с кодом
    // upstream_response_too_large — детерминированно большой ответ модели,
    // повтор его лишь оплатит ещё раз.
    const tooLarge = harness(() =>
      jsonResponse(
        { error: { message: 'response too large', code: 'upstream_response_too_large' } },
        502,
      ),
    );
    const error = await failureOf(tooLarge.provider.complete(REQUEST));
    expect(error).toBeInstanceOf(LlmProtocolError);
    expect((error as LlmProtocolError).retriable).toBe(false);
    expect(error.message).toContain('upstream_response_too_large');

    const plain = harness(() => jsonResponse({ error: { message: 'bad gateway' } }, 502));
    await expect(plain.provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmTransportError',
      retriable: true,
    });
  });

  it('исчерпанный бюджет останавливает вызов до сети', async () => {
    const h = harness(() => jsonResponse(okBody()), { budgetMonthly: 10, spent: 10 });

    await expect(h.provider.complete(REQUEST)).rejects.toMatchObject({ name: 'LlmBudgetError' });
    expect(h.calls).toHaveLength(0);
  });

  it('превышение частоты останавливает вызов до сети', async () => {
    const h = harness(() => jsonResponse(okBody()), { rateLimitPerMin: 1 });

    await h.provider.complete(REQUEST);
    await expect(
      h.provider.complete({ ...REQUEST, userPrompt: 'ПАСПОРТ КАЧЕСТВА №7' }),
    ).rejects.toBeInstanceOf(LlmRateLimitError);
    expect(h.calls).toHaveLength(1);
  });
});

// =====================================================================
// Разбор отказа шлюза
// =====================================================================

/**
 * Регрессия на разбор прод-инцидента: прогон из 83 страниц оборвался, и всё, что
 * осталось в журнале, — «Шлюз LLM ответил 400: Provider returned error». Причина
 * была в ответе шлюза с самого начала, просто не читалась.
 */
describe('describeFailure', () => {
  function gatewayResponse(body: unknown, status = 400): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('достаёт настоящую причину из error.metadata.raw', async () => {
    const failure = await describeFailure(
      gatewayResponse({
        error: {
          message: 'Provider returned error',
          code: 400,
          metadata: { provider_name: 'Google', raw: 'model not found: google/gemini-3.7-flash' },
        },
      }),
    );

    expect(failure.message).toContain('Provider returned error');
    expect(failure.message).toContain('Google');
    expect(failure.message).toContain('model not found');
  });

  it('числовой error.code больше не отбрасывается', async () => {
    // Прежняя проверка «только строка» молча теряла код: у шлюза он часто число,
    // а по коду ветвится обработка 502 upstream_response_too_large.
    const failure = await describeFailure(gatewayResponse({ error: { message: 'x', code: 400 } }));
    expect(failure.code).toBe('400');
  });

  it('строковый error.code сохраняется как был', async () => {
    const failure = await describeFailure(
      gatewayResponse({ error: { message: 'x', code: 'upstream_response_too_large' } }, 502),
    );
    expect(failure.code).toBe('upstream_response_too_large');
  });

  it('пустое и неразбираемое тело дают статус без домыслов', async () => {
    expect((await describeFailure(new Response('', { status: 500 }))).message).toBe(
      'Шлюз LLM ответил 500',
    );
    expect((await describeFailure(new Response('не json', { status: 502 }))).message).toBe(
      'Шлюз LLM ответил 502',
    );
  });
});
