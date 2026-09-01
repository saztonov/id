/**
 * VLM-провайдер `proxy_llm` (ADR-0007): кроп блока → строгий JSON.
 *
 * ## Чем он отличается от текстового `ProxyLlmProvider` — и чем НЕ отличается
 *
 * НЕ отличается всем, что касается денег и дисциплины: тот же шлюз, та же
 * `LlmPolicy` (allowlist до кэша, бюджет и частота до сети), те же классы
 * отказов, тот же идемпотентный ключ `sha256(inputHash:model)`, тот же скраб
 * токена. Отличается формой тела (data-URL картинок, `response_format`,
 * generation-профиль из снимка настроек) и двумя следствиями картинок:
 *
 * 1. **Предохранитель размера тела.** Кропы в base64 раздувают JSON, а шлюз
 *    отвергает тела ~26 MiB. Отправлять заведомо непроходное тело — значит
 *    оплатить трафик и получить 413; предохранитель бросает
 *    `LlmPayloadTooLargeError` ДО сети, и вызывающий делает downscale-retry.
 * 2. **Расширенный скраб.** Эхо тела в тексте ошибки шлюза — это уже не только
 *    токен, но и base64 кропа страницы ИД: data-URL вычёркивается из любого
 *    текста, который может доехать до `error_events` или журнала.
 *
 * ## Почему пустой ответ здесь НЕ ошибка (в отличие от текстового пути)
 *
 * Текстовые стадии обязаны получить JSON — там пустая строка всегда дефект.
 * Здесь решение об исходе блока (`ok | invalid_response | model_refusal`,
 * ADR-0006) принимает `recognize-block` по СОДЕРЖИМОМУ и `finishReason`:
 * различие «модель отказалась» и «ответ непригоден» — его компетенция, и
 * провайдер обязан отдать факт как есть, не подменяя классификацию исключением.
 */
import type { Logger } from 'pino';

import { childLogger, traceHeaders } from '../observability/context.js';
import { measureExternalCall, type Metrics } from '../observability/metrics.js';
import {
  LlmModelNotAllowedError,
  LlmPayloadTooLargeError,
  LlmProtocolError,
  LlmRateLimitError,
  LlmTransportError,
  LlmUpstreamError,
  withAttempt,
} from './port.js';
import type { LlmPolicy } from './policy.js';
import { type LruCache } from './prompt.js';
import {
  chatCompletionsUrl,
  describeFailure,
  idempotencyKey,
  LLM_SERVICE,
  networkFailure,
  optionalCost,
  optionalCount,
  requestSignal,
  rethrowIfCancelled,
  retryAfterMsOf,
  scrubToken,
  UPSTREAM_RESPONSE_TOO_LARGE,
} from './proxy.js';
import type { VlmPort, VlmRequest, VlmResponse, VlmToolCall } from './vlm-port.js';
import { vlmInputHash, vlmOutputHash } from './vlm-prompt.js';

const PROVIDER = 'proxy_llm' as const;

/**
 * Потолок сериализованного тела запроса: 24 MiB.
 *
 * Лимит шлюза — около 26 MiB; запас в 2 MiB оставлен на заголовки и на то,
 * что лимит шлюза измерен эмпирически, а не выторгован контрактом. Превышение
 * — не сбой сети, а слишком большой кроп: чинится downscale'ом, поэтому класс
 * ошибки отдельный и не повторяемый как есть.
 */
export const VLM_MAX_BODY_BYTES = 24 * 1024 * 1024;

/**
 * Кэшируется всё, кроме измеренного времени и признака попадания. Байты
 * картинок в кэш НЕ попадают по построению: их нет в `VlmResponse`, а ключом
 * служит `inputHash`, куда картинки вошли хэшами.
 */
export type CachedVlmCompletion = Omit<VlmResponse, 'latencyMs' | 'cacheHit'>;

export interface ProxyVlmProviderOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Потолок ожидания по умолчанию (`LLM_TIMEOUT_MS`); запрос вправе сузить. */
  readonly timeoutMs: number;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly slowExternalMs: number;
  readonly policy: LlmPolicy;
  readonly cache: LruCache<CachedVlmCompletion>;
  /** Подменяется в тестах; по умолчанию глобальный `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

interface VlmCompletionPayload {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
      readonly tool_calls?: unknown;
    };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly cost?: unknown;
  };
  readonly model?: unknown;
  /** Идентификатор ответа у шлюза (`gen-…` у OpenRouter) — в аудит. */
  readonly id?: unknown;
}

export class ProxyVlmProvider implements VlmPort {
  readonly #options: ProxyVlmProviderOptions;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(options: ProxyVlmProviderOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#logger = childLogger(options.logger, { component: 'vlm' });
    this.#now = options.now ?? Date.now;
  }

  async complete(request: VlmRequest): Promise<VlmResponse> {
    const startedAt = this.#now();
    const model = request.model;
    if (model === '') {
      // Модель приходит из `settings_snapshot` прогона; пустая строка означает
      // несконфигурированное распознавание, и отказ обязан назвать причину, а
      // не превращаться в 400 шлюза с пустым `model` в теле.
      throw new LlmModelNotAllowedError(
        model,
        'Модель VLM не задана: снимок настроек прогона обязан назвать её явно ' +
          '(настройка recognition.vlm_model).',
      );
    }

    // Allowlist — до кэша: выдавать записанный ответ модели, которую политика
    // больше не допускает, значит продолжать ею пользоваться.
    this.#options.policy.ensureModelAllowed(model);

    const inputHash = vlmInputHash(request);
    const cached = this.#options.cache.get(inputHash);
    if (cached !== undefined) {
      return { ...cached, latencyMs: this.#now() - startedAt, cacheHit: true };
    }

    // Дальше — то, что может стоить денег. Любой отказ уносит с собой хэш
    // входа и модель, иначе оплаченный таймаут не оставит следа в `ai_runs`.
    let payload: VlmCompletionPayload;
    try {
      await this.#options.policy.ensureCallPermitted({ model });
      payload = await this.#send(request, model, inputHash);
    } catch (error) {
      throw withAttempt(error, {
        provider: PROVIDER,
        model,
        inputHash,
        latencyMs: this.#now() - startedAt,
      });
    }

    const choice = payload.choices?.[0];
    if (choice === undefined) {
      // Ответ без choices — это НЕ протокольный дефект промта, а молчание
      // апстрима: так шлюз отдаёт отказ, случившийся на его стороне. Класс
      // повторяемый, потому что повтор здесь и помогает (`LlmUpstreamError`).
      // Попытка прикладывается: вызов состоялся и мог быть оплачен.
      throw withAttempt(new LlmUpstreamError('В ответе шлюза LLM нет choices: разбирать нечего.'), {
        provider: PROVIDER,
        model,
        inputHash,
        latencyMs: this.#now() - startedAt,
      });
    }

    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
    // Пустой или отсутствующий текст здесь НЕ исключение — см. шапку файла:
    // исход блока классифицирует recognize-block, провайдер отдаёт факт.
    const content = choice.message?.content;
    const text = typeof content === 'string' ? content : '';
    const toolCalls = parseToolCalls(choice.message?.tool_calls);

    const completion: CachedVlmCompletion = {
      text,
      toolCalls,
      // Роутинг шлюза вправе подменить слаг: в аудит идёт пара requested/actual,
      // а не жёсткая сверка (vlm-port.ts).
      model: typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : model,
      requestedModel: model,
      provider: PROVIDER,
      tokensIn: optionalCount(payload.usage?.prompt_tokens),
      tokensOut: optionalCount(payload.usage?.completion_tokens),
      cost: optionalCost(payload.usage?.cost),
      inputHash,
      outputHash: vlmOutputHash({ text, toolCalls }),
      upstreamId: typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null,
      finishReason,
    };
    this.#options.cache.set(inputHash, completion);

    this.#options.metrics.observeLlmUsage({
      model: completion.model,
      stage: request.stage,
      costRub: completion.cost ?? undefined,
      promptTokens: completion.tokensIn ?? undefined,
      completionTokens: completion.tokensOut ?? undefined,
    });

    return { ...completion, latencyMs: this.#now() - startedAt, cacheHit: false };
  }

  async #send(
    request: VlmRequest,
    model: string,
    inputHash: string,
  ): Promise<VlmCompletionPayload> {
    const timeoutMs = request.timeoutMs ?? this.#options.timeoutMs;
    /**
     * Тело вызова. Картинки — data-URL внутри контент-массива пользовательского
     * сообщения: единственная форма, которую OpenRouter принимает через
     * `chat/completions` без внешних ссылок (§10: наружу не уходит ни один
     * адрес хранилища портала). `top_k` кладётся только когда задан: слать
     * `top_k: undefined` нельзя, а `null` часть провайдеров отвергает.
     */
    const body = {
      model,
      messages: buildMessages(request),
      ...(request.tools !== undefined && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            // `tool_choice` кладётся ТОЛЬКО вместе с объявлением: без списка
            // инструментов он бессмыслен, а часть провайдеров на него ругается.
            // `none` закрывает последний круг дозапроса, не переписывая уже
            // состоявшуюся историю вызовов в `messages` (vlm-port.ts, S28).
            tool_choice: request.toolChoice ?? 'auto',
          }
        : {}),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...(request.topK !== undefined && { top_k: request.topK }),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name,
          strict: true,
          schema: request.responseFormat.schema,
        },
      },
      stream: false,
    };

    const serialized = JSON.stringify(body);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > VLM_MAX_BODY_BYTES) {
      // ДО сети и до метрики внешнего вызова: вызова не будет, и строка
      // external_call с нулевой длительностью только пачкала бы статистику.
      throw new LlmPayloadTooLargeError(
        bytes,
        `Тело VLM-запроса ${bytes} байт превышает потолок ${VLM_MAX_BODY_BYTES} байт ` +
          '(24 MiB): кроп слишком велик. Уменьшите изображение (downscale) и повторите.',
      );
    }

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
              // Одинаков на всех попытках одного вызова — шлюз не оплачивает
              // повтор уже выполненного; `X-Request-Id` при этом новый на
              // каждую попытку (traceHeaders).
              'X-Idempotency-Key': idempotencyKey(inputHash, model),
              ...traceHeaders(),
            },
            body: serialized,
            signal: requestSignal(request.signal, timeoutMs),
          });
        } catch (error) {
          rethrowIfCancelled(request.signal, error);
          throw networkFailure(error, timeoutMs);
        }

        if (response.status === 429) {
          const retryAfterMs = retryAfterMsOf(response);
          await response.arrayBuffer();
          throw new LlmRateLimitError('Шлюз LLM ответил 429: слишком много запросов.', {
            retryAfterMs,
          });
        }
        if (response.status === 413) {
          // Шлюз оказался строже предохранителя — тело всё же велико. Класс
          // тот же, что у предохранителя: решение у вызывающего одно (downscale).
          await response.arrayBuffer();
          throw new LlmPayloadTooLargeError(
            bytes,
            `Шлюз LLM ответил 413: тело VLM-запроса ${bytes} байт отвергнуто. ` +
              'Уменьшите изображение (downscale) и повторите.',
          );
        }
        if (!response.ok) {
          const failure = await describeFailure(response);
          if (response.status === 502 && failure.code === UPSTREAM_RESPONSE_TOO_LARGE) {
            throw new LlmProtocolError(
              `Шлюз LLM ответил 502 ${UPSTREAM_RESPONSE_TOO_LARGE}: ответ модели превысил ` +
                'потолок размера на шлюзе. Повтор не поможет — уменьшите max_tokens ' +
                'или объём запрашиваемого ответа.',
            );
          }
          // Слаг модели в тексте отказа: шлюз собственного каталога моделей
          // порталу не показывает, и «Шлюз LLM ответил 400» без имени модели не
          // отличает «модель не та» от «запрос не тот». На разборе прод-инцидента
          // именно этого и не хватило.
          throw new LlmTransportError(`${this.#scrub(failure.message)} [модель ${model}]`, {
            status: response.status,
          });
        }

        try {
          return (await response.json()) as VlmCompletionPayload;
        } catch (error) {
          throw new LlmProtocolError('Ответ шлюза LLM не разобрался как JSON.', { cause: error });
        }
      },
      { logger: this.#logger, slowExternalMs: this.#options.slowExternalMs },
    );
  }

  /** Токен И data-URL: у VLM-эха в тексте ошибки два секрета, а не один. */
  #scrub(value: string): string {
    return scrubDataPayload(scrubToken(value, this.#options.token));
  }
}

/**
 * Маскирует data-URL и длинные base64-последовательности в тексте ошибки.
 *
 * Шлюз (и nginx перед ним) вправе вернуть кусок присланного тела эхом в
 * сообщении об отказе — а тело VLM-запроса содержит кроп страницы ИД в base64.
 * Пропустить такую строку в ошибку — значит записать изображение документа в
 * `error_events`, таблицу без срока хранения. Маскируются и полный data-URL,
 * и «голый» base64-хвост без заголовка: усечение текста отказа до 200 символов
 * может отрезать заголовок, оставив только содержимое.
 */
export function scrubDataPayload(value: string): string {
  return value
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi, 'data:***')
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, '***');
}

/**
 * Сообщения запроса, включая уже состоявшиеся круги «модель попросила — дали».
 *
 * ## Почему кроп приезжает отдельным сообщением пользователя
 *
 * Роль `tool` в chat/completions несёт ТОЛЬКО текст: приложить к её содержимому
 * картинку нельзя ни у одного провайдера, через который ходит шлюз. Поэтому
 * круг разворачивается в три сообщения: `assistant` с вызовами, `tool` с
 * коротким текстовым ответом на каждый вызов (иначе провайдер отвергнет
 * незакрытый `tool_call_id`) и `user` с самими кропами. Порядок обязателен и
 * именно такой — иначе картинка окажется до ответа на вызов, и часть моделей
 * прочитает её как новый вопрос.
 *
 * Отказ инструмента (участок вне листа, исчерпан потолок) приезжает тем же
 * путём: текст в `tool`, картинок нет. Молчание вместо отказа оставило бы
 * модель ждать кроп, которого не будет.
 */
function buildMessages(request: VlmRequest): readonly unknown[] {
  const dataUrl = (image: { readonly png: Uint8Array }): unknown => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${Buffer.from(image.png).toString('base64')}` },
  });

  const messages: unknown[] = [
    { role: 'system', content: request.systemPrompt },
    {
      role: 'user',
      content: [{ type: 'text', text: request.userPrompt }, ...request.images.map(dataUrl)],
    },
  ];

  for (const exchange of request.exchanges ?? []) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: exchange.calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    });
    for (const result of exchange.results) {
      messages.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.text });
    }
    const images = exchange.results.flatMap((result) => [...result.images]);
    if (images.length > 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Запрошенный участок листа:' }, ...images.map(dataUrl)],
      });
    }
  }

  return messages;
}

/**
 * Разбор `tool_calls` ответа.
 *
 * Недоверчиво: поле приходит от провайдера, а не от нас. Вызов без `id` или без
 * имени функции пропускается — закрыть его нечем (`tool_call_id` обязателен в
 * ответном сообщении), и попытка это сделать кончилась бы отказом шлюза на
 * следующем круге. Отсутствующие аргументы читаются как `{}`: у инструмента
 * бывают значения по умолчанию, и это не повод отбрасывать вызов.
 */
export function parseToolCalls(value: unknown): readonly VlmToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: VlmToolCall[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as { id?: unknown; function?: unknown };
    const fn = record.function;
    if (fn === null || typeof fn !== 'object') continue;
    const call = fn as { name?: unknown; arguments?: unknown };
    if (typeof record.id !== 'string' || record.id === '') continue;
    if (typeof call.name !== 'string' || call.name === '') continue;
    calls.push({
      id: record.id,
      name: call.name,
      argumentsJson: typeof call.arguments === 'string' ? call.arguments : '{}',
    });
  }
  return calls;
}
