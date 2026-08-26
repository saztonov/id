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
  LlmUpstreamError,
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
  sha256Hex,
  type LruCache,
} from './prompt.js';

/** Метка сервиса в метриках и журнале (§11). Кардинальность меток ограничена. */
export const LLM_SERVICE = 'llm';

const PROVIDER = 'proxy_llm' as const;

/**
 * `error.code` шлюза: ответ модели превысил потолок тела ответа (~2 MiB).
 *
 * Приходит со статусом 502, то есть выглядел бы повторяемым транспортным
 * сбоем — но повтор детерминированного промта даст такой же большой ответ и
 * снова оплатит его. Поэтому код различается явно и превращается в
 * `LlmProtocolError` (не повторяется): чинится уменьшением `max_tokens` или
 * объёма запрашиваемого ответа, а не ретраем.
 */
export const UPSTREAM_RESPONSE_TOO_LARGE = 'upstream_response_too_large';

/**
 * Идемпотентный ключ вызова — обязательный `X-Idempotency-Key` шлюза.
 *
 * Считается из хэша эффективного входа и модели, то есть детерминирован:
 * все сетевые попытки ОДНОГО вызова несут один ключ, и шлюз вправе не
 * исполнять (и не оплачивать) повтор уже выполненного. Этим он отличается от
 * `X-Request-Id`, который нарочно новый на каждую попытку и связывает попытку
 * с журналом. Это третий рубеж идемпотентности плана v3: после UNIQUE в БД и
 * LRU-кэша, но единственный, который переживает рестарт процесса.
 */
export function idempotencyKey(inputHash: string, model: string): string {
  return sha256Hex(`${inputHash}:${model}`);
}

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
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
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
    let text: string;
    try {
      await this.#options.policy.ensureCallPermitted({ model });
      payload = await this.#send(request, model, inputHash);
      // Разбор ответа — внутри той же ловушки: оборванный по `max_tokens` или
      // пустой ответ означает СОСТОЯВШИЙСЯ оплаченный вызов, и его попытка
      // обязана дойти до `ai_runs` так же, как таймаут или 5xx.
      text = extractText(payload);
    } catch (error) {
      throw withAttempt(error, {
        provider: PROVIDER,
        model,
        inputHash,
        latencyMs: this.#now() - startedAt,
      });
    }

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

  async #send(
    request: LlmRequest,
    model: string,
    inputHash: string,
  ): Promise<ChatCompletionPayload> {
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
              // Обязателен по контракту шлюза: одинаков на всех попытках
              // одного вызова, чтобы повтор не исполнился и не оплатился
              // второй раз. См. `idempotencyKey`.
              'X-Idempotency-Key': idempotencyKey(inputHash, model),
              // Сквозной `request_id` (§11): без него вызов LLM не связать ни с
              // поставкой, ни со строкой `ai_runs`. Новый на каждую попытку —
              // в отличие от идемпотентного ключа.
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
          const failure = await describeFailure(response);
          if (response.status === 502 && failure.code === UPSTREAM_RESPONSE_TOO_LARGE) {
            // См. UPSTREAM_RESPONSE_TOO_LARGE: 502 здесь врёт про природу
            // отказа, повтор оплатил бы тот же слишком большой ответ.
            throw new LlmProtocolError(
              `Шлюз LLM ответил 502 ${UPSTREAM_RESPONSE_TOO_LARGE}: ответ модели превысил ` +
                'потолок размера на шлюзе. Повтор не поможет — уменьшите max_tokens ' +
                'или объём запрашиваемого ответа.',
            );
          }
          throw new LlmTransportError(this.#scrub(failure.message), {
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
    return networkFailure(error, timeoutMs);
  }

  #scrub(value: string): string {
    return scrubToken(value, this.#options.token);
  }
}

/**
 * Классифицирует сбой самого `fetch`: таймаут отличим от прочей сети.
 *
 * Общая функция обоих путей (текстового и VLM): у них один шлюз, один вид
 * таймаута и одна семантика повторов — расхождение классификации означало бы,
 * что одинаковый сбой в одном пути повторяется, а в другом нет.
 */
export function networkFailure(error: unknown, timeoutMs: number): Error {
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
export function scrubToken(value: string, token: string): string {
  return token.length === 0 ? value : value.split(token).join('***');
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

/**
 * Текст ответа с проверкой признака завершения.
 *
 * `finish_reason === 'length'` — модель упёрлась в `max_tokens`: JSON в этом
 * месте гарантированно оборван, вызов уже оплачен, а повтор того же промта
 * оборвётся на том же токене. Пустой ответ непригоден по той же причине:
 * стадии §10 ждут JSON, и «успех с пустой строкой» превратился бы уровнем выше
 * в загадочный отказ парсера без указания на виновника. Оба случая — не успех
 * и не повторяемый сбой, а `LlmProtocolError`: чинится промтом или лимитом
 * токенов, руками.
 *
 * Третий случай выглядит так же, но им не является: тело БЕЗ `choices` — это
 * не ответ модели, а отказ апстрима, пересказанный шлюзом. Повтор его лечит,
 * поэтому он `LlmUpstreamError`, и различать их обязано это место: выше по
 * стеку виден только класс.
 */
function extractText(payload: ChatCompletionPayload): string {
  const choice = payload.choices?.[0];
  if (choice === undefined) {
    // Тела без `choices` промт не порождает: так шлюз отдаёт отказ апстрима.
    // Повтор здесь помогает, поэтому класс другой (`LlmUpstreamError`).
    throw new LlmUpstreamError(
      'В ответе шлюза LLM нет choices: модель не ответила вовсе. ' +
        'Это отказ на стороне провайдера, а не дефект промта.',
    );
  }
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  if (finishReason === 'length') {
    throw new LlmProtocolError(
      'Ответ модели оборван по max_tokens (finish_reason=length): вызов оплачен, но JSON ' +
        'неполон. Повтор не поможет — увеличьте лимит токенов либо сократите промт.',
    );
  }
  const content = choice.message?.content;
  if (typeof content !== 'string' || content === '') {
    throw new LlmProtocolError(
      'Пустой ответ модели: в choices[0].message.content нет текста. ' +
        'Вызов оплачен, но результата нет — это дефект промта или модели, а не сети.',
    );
  }
  return content;
}

/** Токены: только конечное неотрицательное целое, иначе «не сообщили». */
export function optionalCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/** Стоимость: `numeric(12,4)` в БД, поэтому здесь же округляется до 4 знаков. */
export function optionalCost(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Number(value.toFixed(4));
}

/** Разобранный отказ шлюза: текст для ошибки и машиночитаемый код. */
export interface GatewayFailure {
  /** Готовая строка отказа: статус и усечённая причина шлюза. */
  readonly message: string;
  /** `error.code` из тела, если шлюз его прислал; по нему ветвится 502. */
  readonly code: string | null;
}

/**
 * Текст отказа без содержимого ответа.
 *
 * Берётся `error.message` либо `detail` и только начало строки: тело ответа
 * шлюза — это эхо промта, то есть текст ИД, и ему в журнале не место. Код ошибки
 * возвращается отдельно: `upstream_response_too_large` меняет класс отказа, и
 * распознавать его по подстроке текста было бы гаданием.
 *
 * ## Почему читается ещё и `error.metadata`
 *
 * Шлюз, отвергая запрос, отвечает собственным `message` — часто это родовое
 * «Provider returned error», из которого не следует ничего. Настоящую причину
 * (не тот слаг модели, апстрим не принимает картинки, лимит провайдера) он кладёт
 * в `error.metadata.raw`, а имя апстрима — в `error.metadata.provider_name`.
 * Прежде это поле не читалось вовсе, и разбор прод-инцидента упёрся ровно в
 * него: в журнале стояло «Шлюз LLM ответил 400: Provider returned error», и
 * узнать, чем именно шлюз недоволен, было неоткуда.
 *
 * `raw` — сообщение об ОТКАЗЕ от апстрима, а не распознанный текст: эхо промта
 * туда не попадает. Срез до 200 символов оставлен как страховка на случай, если
 * какой-то провайдер вернёт в нём простыню.
 */
export async function describeFailure(response: Response): Promise<GatewayFailure> {
  let detail = '';
  let code: string | null = null;
  try {
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as {
        error?: {
          message?: unknown;
          code?: unknown;
          metadata?: { raw?: unknown; provider_name?: unknown };
        };
        detail?: unknown;
      };
      const candidate = record.error?.message ?? record.detail;
      if (typeof candidate === 'string') detail = candidate.slice(0, 200);

      const provider = record.error?.metadata?.provider_name;
      if (typeof provider === 'string' && provider !== '') {
        detail = detail === '' ? `провайдер ${provider}` : `${detail} (провайдер ${provider})`;
      }
      const raw = record.error?.metadata?.raw;
      if (typeof raw === 'string' && raw !== '') {
        detail = detail === '' ? raw.slice(0, 200) : `${detail}: ${raw.slice(0, 200)}`;
      }

      // Код у шлюза бывает и числовым (`"code": 400`) — прежняя проверка
      // «только строка» отбрасывала его молча.
      const rawCode = record.error?.code;
      if (typeof rawCode === 'string') code = rawCode;
      else if (typeof rawCode === 'number') code = String(rawCode);
    }
  } catch {
    detail = '';
  }
  return {
    message:
      detail === ''
        ? `Шлюз LLM ответил ${response.status}`
        : `Шлюз LLM ответил ${response.status}: ${detail}`,
    code,
  };
}
