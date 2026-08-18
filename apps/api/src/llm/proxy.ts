/**
 * Провайдер `proxy_llm` — единственный работающий в MVP (§10).
 *
 * ## Что здесь важнее реализации HTTP
 *
 * 1. **Наружу уходит только текст.** Тело запроса собирается здесь целиком и
 *    состоит из идентификатора модели и двух текстовых сообщений. Ни байтов
 *    PDF, ни ссылок на изображения в нём нет и появиться не может: `LlmRequest`
 *    их не переносит (см. `port.ts`).
 * 2. **Токен живёт только в заголовке.** Он приходит из окружения, не пишется в
 *    `app_settings`, не попадает в `ai_runs`, не пишется в журнал и вырезается
 *    из текста отказа, даже если шлюз вернул его эхом. Урок S3: `Authorization`
 *    утекает не из места, где его кладут, а из объекта ошибки HTTP-клиента.
 * 3. **Кэш стоит перед политикой расходов.** Повторный идентичный вызов не
 *    ходит наружу и не тратит бюджет второй раз (§8.2). Проверка allowlist при
 *    этом идёт ДО кэша: выдавать записанный ответ модели, которую политика
 *    больше не допускает, — то же самое, что продолжать ею пользоваться.
 * 4. **Токены и стоимость берутся у провайдера как есть.** Их отсутствие — это
 *    `null`, а не ноль: ноль означал бы бесплатный вызов и занижал бы сумму,
 *    по которой считается месячный бюджет.
 */
import type { Logger } from 'pino';

import { childLogger, traceHeaders } from '../observability/context.js';
import { measureExternalCall, type Metrics } from '../observability/metrics.js';
import {
  LlmModelNotAllowedError,
  LlmProtocolError,
  LlmRateLimitError,
  LlmTimeoutError,
  LlmTransportError,
  withAttempt,
  type LlmPort,
  type LlmRequest,
  type LlmResponse,
} from './port.js';
import type { LlmPolicy } from './policy.js';
import {
  buildEffectivePrompt,
  cacheKey,
  promptHash,
  responseHash,
  type LruCache,
} from './prompt.js';

/** Метка сервиса в метриках и журнале (§11). Кардинальность меток ограничена. */
export const LLM_SERVICE = 'llm';

const PROVIDER = 'proxy_llm' as const;

/** Кэшируется всё, кроме измеренного времени и самого признака попадания. */
export type CachedCompletion = Omit<LlmResponse, 'latencyMs' | 'cacheHit'>;

export interface ProxyLlmProviderOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Модель по умолчанию (`LLM_MODEL`); запрос вправе выбрать другую. */
  readonly defaultModel: string;
  readonly timeoutMs: number;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly slowExternalMs: number;
  readonly policy: LlmPolicy;
  readonly cache: LruCache<CachedCompletion>;
  /** Подменяется в тестах; по умолчанию глобальный `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

interface ChatCompletionPayload {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly cost?: unknown;
  };
  readonly model?: unknown;
}

export class ProxyLlmProvider implements LlmPort {
  readonly #options: ProxyLlmProviderOptions;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(options: ProxyLlmProviderOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#logger = childLogger(options.logger, { component: 'llm' });
    this.#now = options.now ?? Date.now;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = this.#now();
    const model = request.model ?? this.#options.defaultModel;
    if (model === '') {
      // `loadEnv` требует `LLM_MODEL` только в production: там отсутствие
      // настройки останавливает старт. Вне production сюда можно доехать, и
      // отказ обязан называть причину, а не превращаться в 400 из шлюза с
      // пустым `model`.
      throw new LlmModelNotAllowedError(
        model,
        'Модель не выбрана: задайте LLM_MODEL в окружении либо model в запросе.',
      );
    }

    // Сначала allowlist: он не стоит ни денег, ни обращений и обязан отработать
    // раньше кэша (см. п. 3 в шапке файла).
    this.#options.policy.ensureModelAllowed(model);

    const effective = buildEffectivePrompt({ ...request, model });
    const inputHash = promptHash(effective);
    const key = cacheKey({ effective, model, provider: PROVIDER });

    const cached = this.#options.cache.get(key);
    if (cached !== undefined) {
      return { ...cached, latencyMs: this.#now() - startedAt, cacheHit: true };
    }

    // Ниже начинается то, что может стоить денег и времени. Любой отказ отсюда
    // обязан унести с собой хэш промта и модель: иначе таймаут не оставляет в
    // `ai_runs` ни строки, и «вызов был» доказывать нечем.
    let payload: ChatCompletionPayload;
    try {
      await this.#options.policy.ensureCallPermitted({ model });
      payload = await this.#send(request, model);
    } catch (error) {
      throw withAttempt(error, {
        provider: PROVIDER,
        model,
        inputHash,
        latencyMs: this.#now() - startedAt,
      });
    }

    const text = extractText(payload);
    const tokensIn = optionalCount(payload.usage?.prompt_tokens);
    const tokensOut = optionalCount(payload.usage?.completion_tokens);
    const cost = optionalCost(payload.usage?.cost);

    const completion: CachedCompletion = {
      text,
      // Отвечающая модель может отличаться от запрошенной (маршрутизация на
      // стороне шлюза). В `ai_runs` обязана попасть та, что ответила.
      model: typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : model,
      provider: PROVIDER,
      tokensIn,
      tokensOut,
      cost,
      inputHash,
      outputHash: responseHash(text),
    };
    this.#options.cache.set(key, completion);

    this.#options.metrics.observeLlmUsage({
      model: completion.model,
      stage: request.stage,
      costRub: cost ?? undefined,
      promptTokens: tokensIn ?? undefined,
      completionTokens: tokensOut ?? undefined,
    });

    return { ...completion, latencyMs: this.#now() - startedAt, cacheHit: false };
  }

  async #send(request: LlmRequest, model: string): Promise<ChatCompletionPayload> {
    const timeoutMs = request.timeoutMs ?? this.#options.timeoutMs;
    /**
     * Тело запроса. Ровно четыре поля, и все — текст либо число.
     *
     * `cacheContext` сюда НЕ идёт: соседний контекст вкладывает в `userPrompt`
     * вызывающий — в том виде, в каком его должна видеть модель, — а в ключ
     * кэша он входит отдельно (§8.2). Отправка его вторым куском означала бы,
     * что модель читает контекст дважды и платит за него дважды.
     */
    const body = {
      model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      // Классификация и извлечение обязаны быть воспроизводимыми: одинаковый
      // промт при ненулевой температуре даёт разные метки на одних страницах,
      // и кэш по хэшу промта превратился бы в лотерею «чей ответ записан».
      temperature: 0,
      stream: false,
    };

    return measureExternalCall(
      this.#options.metrics,
      { service: LLM_SERVICE, operation: request.stage },
      async () => {
        let response: Response;
        try {
          response = await this.#fetch(chatCompletionsUrl(this.#options.baseUrl), {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              authorization: `Bearer ${this.#options.token}`,
              // Сквозной `request_id` (§11): без него вызов LLM не связать ни с
              // поставкой, ни со строкой `ai_runs`.
              ...traceHeaders(),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          throw this.#networkFailure(error, timeoutMs);
        }

        if (response.status === 429) {
          await response.arrayBuffer();
          throw new LlmRateLimitError('Шлюз LLM ответил 429: слишком много запросов.');
        }
        if (!response.ok) {
          throw new LlmTransportError(this.#scrub(await describeFailure(response)), {
            status: response.status,
          });
        }

        try {
          return (await response.json()) as ChatCompletionPayload;
        } catch (error) {
          throw new LlmProtocolError('Ответ шлюза LLM не разобрался как JSON.', { cause: error });
        }
      },
      { logger: this.#logger, slowExternalMs: this.#options.slowExternalMs },
    );
  }

  #networkFailure(error: unknown, timeoutMs: number): Error {
    const name = error instanceof Error ? error.name : typeof error;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new LlmTimeoutError(timeoutMs, `Шлюз LLM не ответил за ${timeoutMs} мс.`);
    }
    return new LlmTransportError(`Вызов шлюза LLM не состоялся (${name}).`);
  }

  /**
   * Вычёркивает токен из текста, который поедет в журнал или в ошибку.
   *
   * Шлюз вправе вернуть присланный заголовок эхом в сообщении об ошибке — так
   * делают и nginx, и часть прокси при 401. Без этой замены секрет попал бы в
   * `error_events`, то есть в таблицу без срока хранения (находка S3, п. 3).
   */
  #scrub(value: string): string {
    const token = this.#options.token;
    return token.length === 0 ? value : value.split(token).join('***');
  }
}

/**
 * Адрес эндпоинта дополнения.
 *
 * Склейка строкой, а не `new URL(path, base)`: второй отбрасывает последний
 * сегмент базы, и `https://gw.internal/v1` превратился бы в
 * `https://gw.internal/chat/completions` — то есть настроенный префикс версии
 * молча пропал бы.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function extractText(payload: ChatCompletionPayload): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LlmProtocolError('В ответе шлюза LLM нет текста (choices[0].message.content).');
  }
  return content;
}

/** Токены: только конечное неотрицательное целое, иначе «не сообщили». */
function optionalCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/** Стоимость: `numeric(12,4)` в БД, поэтому здесь же округляется до 4 знаков. */
function optionalCost(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Number(value.toFixed(4));
}

/**
 * Текст отказа без содержимого ответа.
 *
 * Берётся только `error.message` либо `detail` и только начало строки: тело
 * ответа шлюза — это эхо промта, то есть текст ИД, и ему в журнале не место.
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as { error?: { message?: unknown }; detail?: unknown };
      const candidate = record.error?.message ?? record.detail;
      if (typeof candidate === 'string') detail = candidate.slice(0, 200);
    }
  } catch {
    detail = '';
  }
  return detail === ''
    ? `Шлюз LLM ответил ${response.status}`
    : `Шлюз LLM ответил ${response.status}: ${detail}`;
}
