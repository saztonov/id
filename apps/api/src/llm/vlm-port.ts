/**
 * Порт VLM-распознавания (ADR-0007): кроп блока → строго структурированный JSON.
 *
 * ## Отношение к текстовому `LlmPort`
 *
 * `LlmRequest` из `port.ts` принимает ТОЛЬКО строки, и это его инвариант §10 —
 * он остаётся нетронутым: текстовые стадии (классификация, извлечение) по-прежнему
 * не могут приложить картинку по построению. VLM-путь — санкционированное
 * заказчиком исключение из §10 для стадии `recognize` (ADR-0007), и оно выражено
 * ОТДЕЛЬНЫМ портом, а не ослаблением общего: у типа с картинками своя канонизация
 * промта, свой ключ кэша и свой предохранитель размера тела.
 *
 * ## Что уходит наружу
 *
 * Кроп блока замороженной разметки (PNG), промпт стадии и json_schema ответа —
 * через корпоративный шлюз proxy_llm, никогда напрямую вендору (гвард
 * `DIRECT_VENDOR_HOSTS` действует и здесь). Ответ модели обязан быть строгим
 * JSON для всех трёх типов блоков — решение заказчика, принципиальное отличие
 * от RD WEB, хранившего markdown.
 *
 * Классы отказов переиспользуются из `port.ts`: словарь ошибок у путей общий,
 * различие только в форме запроса.
 */

import type { LlmProviderName } from './port.js';

/** Единственная стадия порта; совпадает с CHECK `ai_runs_stage_chk` (0019). */
export type VlmStage = 'recognize';

/** Изображение кропа. Всегда PNG: формат фиксирован crop policy (ADR-0007). */
export interface VlmImage {
  readonly png: Uint8Array;
}

/**
 * Строгая схема ответа для `response_format: {type: 'json_schema'}`.
 *
 * `strict: true` — литерал, а не boolean: нестрогий режим означал бы «модель
 * вправе вернуть что угодно», и весь смысл структурированного контракта v3
 * исчез бы. Схема обязана быть strict-совместимой (все поля в `required`,
 * отсутствие значения — null), это держит снапшот-тест схем.
 */
export interface VlmJsonSchemaFormat {
  readonly name: string;
  readonly schema: unknown;
  readonly strict: true;
}

/**
 * Инструмент, который модель вправе позвать (ADR-0013, S21).
 *
 * До S21 порт инструментов не знал вовсе, и это было верно для контракта
 * ADR-0007: блок = ровно один вызов с одним кропом. Заказчик потребовал
 * «предусмотреть отправку кропов по запросу модели» — то есть разрешить модели
 * сказать «покажи мне соседний участок листа», прежде чем отвечать.
 *
 * Инструмент один и узкий: он возвращает КАРТИНКУ участка ТОЙ ЖЕ страницы, а
 * не произвольные данные. Широкий набор инструментов у стадии транскрипции
 * означал бы, что модель может добрать контекст откуда угодно, — а ADR-0007
 * прямо запрещает восстанавливать содержимое кропа по соседям и по домену.
 */
export interface VlmTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema параметров. */
  readonly parameters: unknown;
}

/** Вызов инструмента, пришедший в ответе модели. */
export interface VlmToolCall {
  readonly id: string;
  readonly name: string;
  /** Аргументы как есть, строкой: разбор и проверка — обязанность вызывающего. */
  readonly argumentsJson: string;
}

/**
 * Один круг «модель попросила — портал дал».
 *
 * Диалог передаётся целиком на каждом вызове: у шлюза нет состояния, а
 * `X-Idempotency-Key` считается по каноническому входу — значит вход обязан
 * содержать всё, что модель уже видела, иначе второй круг склеился бы с первым
 * по ключу и вернул бы прежний ответ.
 */
export interface VlmToolExchange {
  readonly calls: readonly VlmToolCall[];
  readonly results: readonly {
    readonly toolCallId: string;
    /** Что портал отвечает текстом: «кроп приложен» либо причина отказа. */
    readonly text: string;
    /** Запрошенный участок. Пусто — инструмент отказал (вне листа, потолок). */
    readonly images: readonly VlmImage[];
  }[];
}

export interface VlmRequest {
  readonly stage: VlmStage;
  readonly promptCode: string;
  readonly promptVersion: number;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Кропы блока. Фактически всегда один: мультикартиночные батчи отвергнуты (ADR-0007). */
  readonly images: readonly VlmImage[];
  /** Инструменты стадии; пусто/отсутствие — модель их не увидит вовсе. */
  readonly tools?: readonly VlmTool[] | undefined;
  /** Уже состоявшиеся круги «запрос кропа → кроп». Порядок значим. */
  readonly exchanges?: readonly VlmToolExchange[] | undefined;
  /** Обязателен для всех типов блоков — строгий JSON, не свободный текст (v3). */
  readonly responseFormat: VlmJsonSchemaFormat;
  /** Версия схемы ответа — входит в ключ кэша и в идемпотентный ключ шлюза. */
  readonly schemaVersion: string;
  /**
   * Модель обязательна и приходит из `settings_snapshot` прогона, а не из
   * `LLM_MODEL`: смена настройки администратором не имеет права менять модель
   * выполняющегося прогона.
   */
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly topK?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface VlmResponse {
  /** Сырой текст ответа: разбор JSON и проверка по схеме — обязанность вызывающего. */
  readonly text: string;
  /**
   * Фактически отработавшая модель из поля `model` ответа. Роутинг шлюза
   * вправе подменить слаг (reasoning-режимы), поэтому жёсткая сверка
   * `model === request.model` запрещена — расхождение фиксируется в аудите,
   * а не считается ошибкой.
   */
  readonly model: string;
  /** Модель, которую заказывали, — для пары requested/actual в `ai_runs`. */
  readonly requestedModel: string;
  readonly provider: LlmProviderName;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
  readonly latencyMs: number;
  /** sha256 канонизированного входа (промт + хэши картинок + схема), hex. */
  readonly inputHash: string;
  /** sha256 текста ответа, hex. */
  readonly outputHash: string;
  readonly cacheHit: boolean;
  /**
   * `finish_reason` ответа; `null` — провайдер его не сообщил (трактуется как
   * `stop`). `length` — оборванный ответ: вызов оплачен, но результат
   * непригоден, и различать это обязан вызывающий (исход `model_refusal`,
   * а не тихий успех).
   */
  readonly finishReason: string | null;
  /**
   * Инструменты, которые модель попросила выполнить. Пусто — ответ окончательный.
   *
   * Непустой список означает, что `text` ответом НЕ является: модель ещё не
   * говорила по существу. Вызывающий обязан различать эти два случая — иначе
   * пустой `content` при `tool_calls` будет прочитан как отказ модели.
   */
  readonly toolCalls: readonly VlmToolCall[];
}

export interface VlmPort {
  complete(request: VlmRequest): Promise<VlmResponse>;
}
