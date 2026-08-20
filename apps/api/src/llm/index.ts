/**
 * Сборка провайдера LLM по конфигурации (§10, §0.3 п.6, §0.5).
 *
 * Четыре значения `LLM_PROVIDER` дают четыре РАЗНЫХ по смыслу состояния, и все
 * четыре обязаны быть различимы вызывающим:
 *
 * - `proxy_llm` — работающий провайдер;
 * - `recorded` — офлайн-двойник для гейтов; в production `loadEnv` его не
 *   пропускает, как и `AUTH_MODE=dev-stub`;
 * - `rdweb` — переключатель существует, но заблокирован: generic
 *   text-analysis эндпоинта у RD WEB нет (§0.3 п.6);
 * - `none` — модель не подключена. Это НЕ ошибка конфигурации: система обязана
 *   работать на якорях (§0.5, фаза 1 §8.2), а фаза 2 обязана честно сказать
 *   «модель не подключена», а не молча выдать пустой результат, который
 *   неотличим от «модель посмотрела и ничего не нашла».
 *
 * Заблокированный и отключённый провайдеры — это объекты, а не `null` и не
 * исключение при сборке. Ветвление «а есть ли у нас LLM» в каждой задаче
 * означало бы, что забытая ветка тихо пропускает стадию; отказ на вызове
 * доходит до `job_runs` с внятной причиной.
 */
import type { Logger } from 'pino';

import type { Env } from '../config/env.js';
import type { AuthScope } from '../auth/scope.js';
import { monthlyAiSpend } from '../db/repositories/ai-runs.js';
import type { Database } from '../db/repositories/users.js';
import type { Metrics } from '../observability/metrics.js';
import {
  LlmBlockedProviderError,
  LlmDisabledError,
  type LlmPort,
  type LlmRequest,
  type LlmResponse,
} from './port.js';
import { createLlmPolicy, type LlmPolicy, type SpendReader } from './policy.js';
import { LruCache } from './prompt.js';
import { ProxyLlmProvider, type CachedCompletion } from './proxy.js';
import { RecordedLlmProvider, type RecordedLlmProviderOptions } from './recorded.js';
import type { VlmPort, VlmRequest, VlmResponse } from './vlm-port.js';
import { ProxyVlmProvider, type CachedVlmCompletion } from './vlm-proxy.js';
import { RecordedVlmProvider, type VlmRecordedResponse } from './vlm-recorded.js';

export * from './port.js';
export * from './vlm-port.js';
export {
  buildEffectivePrompt,
  cacheKey,
  promptHash,
  responseHash,
  sha256Hex,
  normalizeNewlines,
  LruCache,
  EFFECTIVE_PROMPT_VERSION,
} from './prompt.js';
export type { CacheKeyInput, LruCacheOptions, EffectivePromptInput } from './prompt.js';
export {
  buildVlmCanonicalInput,
  canonicalJson,
  vlmInputHash,
  VLM_PROMPT_CANON_VERSION,
} from './vlm-prompt.js';
export {
  LlmPolicy,
  createLlmPolicy,
  emptyAllowlistBehaviour,
  type SpendReader,
  type LlmPolicyOptions,
  type EmptyAllowlistBehaviour,
} from './policy.js';
export {
  ProxyLlmProvider,
  chatCompletionsUrl,
  describeFailure,
  idempotencyKey,
  networkFailure,
  scrubToken,
  LLM_SERVICE,
  UPSTREAM_RESPONSE_TOO_LARGE,
  type CachedCompletion,
  type GatewayFailure,
} from './proxy.js';
export {
  ProxyVlmProvider,
  scrubDataPayload,
  VLM_MAX_BODY_BYTES,
  type CachedVlmCompletion,
  type ProxyVlmProviderOptions,
} from './vlm-proxy.js';
export {
  RecordedLlmProvider,
  type RecordedBehaviour,
  type RecordedFallback,
  type RecordedLlmProviderOptions,
} from './recorded.js';
export {
  RecordedVlmProvider,
  type VlmRecordedResponse,
  type RecordedVlmProviderOptions,
} from './vlm-recorded.js';

/** Пояснение для переключателя `rdweb`. Текст виден администратору. */
export const RDWEB_LLM_BLOCK_REASON =
  'Провайдер анализа «RD WEB» заблокирован: generic text-analysis эндпоинта у RD WEB нет; ' +
  'пункт техзадания S13. Пока их /capabilities не подтвердит наличие эндпоинта, ' +
  'единственный работающий провайдер — proxy_llm (§0.3 п.6).';

const LLM_DISABLED_REASON =
  'LLM не подключена (LLM_PROVIDER=none): анализ выполняется только якорными правилами. ' +
  'Стадии, которым нужна модель, не выполняются — это штатное состояние, а не сбой.';

/** Провайдер, существующий только чтобы отказать с объяснением. */
class BlockedLlmProvider implements LlmPort {
  complete(_request: LlmRequest): Promise<LlmResponse> {
    return Promise.reject(new LlmBlockedProviderError('rdweb', RDWEB_LLM_BLOCK_REASON));
  }
}

class DisabledLlmProvider implements LlmPort {
  complete(_request: LlmRequest): Promise<LlmResponse> {
    return Promise.reject(new LlmDisabledError(LLM_DISABLED_REASON));
  }
}

const VLM_DISABLED_REASON =
  'LLM не подключена (LLM_PROVIDER=none): распознавание через VLM недоступно. ' +
  'Это настройка, а не сбой: включите proxy_llm либо выберите провайдера ' +
  'распознавания rdweb.';

/**
 * VLM-путь при `rdweb` заблокирован ТЕМ ЖЕ текстом, что и текстовый: причина
 * одна (§0.3 п.6), и два разных объяснения одного запрета путали бы
 * администратора. Распознавание ЧЕРЕЗ RD WEB при этом живо — но оно идёт
 * задачами `rd.*`, а не этим портом: сюда `rdweb` может доехать только из-за
 * ошибки ветвления в роуте, и отказ обязан быть громким.
 */
class BlockedVlmProvider implements VlmPort {
  complete(_request: VlmRequest): Promise<VlmResponse> {
    return Promise.reject(new LlmBlockedProviderError('rdweb', RDWEB_LLM_BLOCK_REASON));
  }
}

class DisabledVlmProvider implements VlmPort {
  complete(_request: VlmRequest): Promise<VlmResponse> {
    return Promise.reject(new LlmDisabledError(VLM_DISABLED_REASON));
  }
}

export interface LlmDeps {
  readonly metrics: Metrics;
  readonly logger: Logger;
  /** Фактическая трата за месяц: `createAiSpendReader(db, scope)` в бою. */
  readonly spend: SpendReader;
  /** Записи для `LLM_PROVIDER=recorded`. Отсутствие = пустой набор записей. */
  readonly recorded?: Omit<RecordedLlmProviderOptions, 'policy'> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  /** Готовая политика: подменяется в тестах, иначе собирается из окружения. */
  readonly policy?: LlmPolicy | undefined;
}

export function createLlmProvider(env: Env, deps: LlmDeps): LlmPort {
  const policy = deps.policy ?? createLlmPolicy(env, { spend: deps.spend, now: deps.now });

  switch (env.LLM_PROVIDER) {
    case 'proxy_llm':
      // Все три значения обязательны при `LLM_PROVIDER=proxy_llm` — это
      // проверено `loadEnv`, поэтому здесь достаточно сужения типа.
      return new ProxyLlmProvider({
        baseUrl: env.PROXY_LLM_BASE_URL ?? '',
        token: env.PROXY_LLM_TOKEN ?? '',
        defaultModel: env.LLM_MODEL ?? '',
        timeoutMs: env.LLM_TIMEOUT_MS,
        metrics: deps.metrics,
        logger: deps.logger,
        slowExternalMs: env.SLOW_EXTERNAL_MS,
        policy,
        cache: new LruCache<CachedCompletion>({
          maxEntries: env.LLM_CACHE_MAX_ENTRIES,
          ttlMs: env.LLM_CACHE_TTL_MS,
          now: deps.now,
        }),
        fetchImpl: deps.fetchImpl,
        now: deps.now,
      });

    case 'recorded':
      return new RecordedLlmProvider({
        responses: deps.recorded?.responses ?? new Map(),
        fallback: deps.recorded?.fallback,
        model: deps.recorded?.model ?? env.LLM_MODEL,
        timeoutMs: deps.recorded?.timeoutMs ?? env.LLM_TIMEOUT_MS,
        now: deps.now,
        policy,
      });

    case 'rdweb':
      return new BlockedLlmProvider();

    default:
      return new DisabledLlmProvider();
  }
}

/**
 * Зависимости VLM-фабрики.
 *
 * Отдельный тип, а не переиспользование `LlmDeps`: у двойника VLM другой
 * формат записей (ключ — `vlmInputHash`, значение — текст с `finishReason`),
 * и общий тип заставил бы каждого вызывающего таскать поля чужого пути.
 */
export interface VlmDeps {
  readonly metrics: Metrics;
  readonly logger: Logger;
  /** Фактическая трата за месяц — общая с текстовым путём (`ai_runs`). */
  readonly spend: SpendReader;
  /** Записи для `LLM_PROVIDER=recorded`. Отсутствие = пустой набор записей. */
  readonly recordings?: ReadonlyMap<string, VlmRecordedResponse> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  /** Готовая политика: подменяется в тестах, иначе собирается из окружения. */
  readonly policy?: LlmPolicy | undefined;
}

/**
 * Сборка VLM-провайдера — то же ветвление `LLM_PROVIDER`, что у текстового
 * пути: канал у обоих один (шлюз proxy_llm), и раздельные переключатели
 * позволили бы включить распознавание через канал, который для анализа
 * выключен. Политика расходов тоже одна: бюджет §11 общий на все стадии.
 */
export function createVlmProvider(env: Env, deps: VlmDeps): VlmPort {
  const policy = deps.policy ?? createLlmPolicy(env, { spend: deps.spend, now: deps.now });

  switch (env.LLM_PROVIDER) {
    case 'proxy_llm':
      return new ProxyVlmProvider({
        baseUrl: env.PROXY_LLM_BASE_URL ?? '',
        token: env.PROXY_LLM_TOKEN ?? '',
        timeoutMs: env.LLM_TIMEOUT_MS,
        metrics: deps.metrics,
        logger: deps.logger,
        slowExternalMs: env.SLOW_EXTERNAL_MS,
        policy,
        cache: new LruCache<CachedVlmCompletion>({
          maxEntries: env.LLM_CACHE_MAX_ENTRIES,
          ttlMs: env.LLM_CACHE_TTL_MS,
          now: deps.now,
        }),
        fetchImpl: deps.fetchImpl,
        now: deps.now,
      });

    case 'recorded':
      return new RecordedVlmProvider({
        responses: deps.recordings ?? new Map(),
        policy,
        now: deps.now,
      });

    case 'rdweb':
      return new BlockedVlmProvider();

    default:
      return new DisabledVlmProvider();
  }
}

/**
 * Реализация `SpendReader` поверх `ai_runs`.
 *
 * Область видимости обязательна и здесь: сумма считается по строкам, доступным
 * актору. Общесистемный бюджет читается областью администратора — это явный
 * выбор вызывающего, а не умолчание внутри политики.
 */
export function createAiSpendReader(db: Database, scope: AuthScope): SpendReader {
  return {
    monthlySpend: (at: Date) => monthlyAiSpend(db, scope, at),
  };
}
