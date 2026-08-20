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

export interface VlmRequest {
  readonly stage: VlmStage;
  readonly promptCode: string;
  readonly promptVersion: number;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Кропы блока. Фактически всегда один: мультикартиночные батчи отвергнуты (ADR-0007). */
  readonly images: readonly VlmImage[];
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
}

export interface VlmPort {
  complete(request: VlmRequest): Promise<VlmResponse>;
}
