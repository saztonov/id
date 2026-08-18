/**
 * Офлайн-двойник LLM: зафиксированные ответы по хэшу полного эффективного
 * промта (§1.3).
 *
 * ## Урок S7, определяющий всю конструкцию этого файла
 *
 * На S7 двойник RD WEB принимал `settings` как `record(unknown)` и отвечал на
 * оба пути маршрута. Настоящий сервер требовал `provider_type` и `model_id` при
 * `extra="forbid"` и знал только один путь. Двойник оказался МЯГЧЕ оригинала —
 * и потому скрыл дефект, который на боевом стенде дал бы 404 и 422. Тесты при
 * этом были зелёными.
 *
 * Отсюда контракт этого двойника: он обязан УМЕТЬ вести себя плохо. Настоящая
 * модель возвращает не-JSON, возвращает JSON не по схеме, придумывает цитаты,
 * отвечает на другом языке, отваливается по таймауту, упирается в бюджет и в
 * лимит частоты. Двойник, который умеет только `ok`, — это не двойник, а
 * генератор зелёных тестов: проверки §8.2 «цитата отображается обратно на span,
 * иначе `undetermined`» и §9.1 «низкая уверенность не даёт `fail`» на нём
 * просто не исполняются ни разу.
 *
 * ## Почему незаписанный промт — это ошибка, а не «что-нибудь правдоподобное»
 *
 * Молчаливый правдоподобный ответ на неизвестный хэш означает, что изменение
 * промта не видно НИКОМУ: тесты остаются зелёными, потому что двойник
 * отвечает на что угодно. Именно так двойник становится мягче оригинала во
 * второй раз. Поэтому `fallback` по умолчанию бросает
 * `LlmRecordingMissingError` с хэшем в сообщении — по нему запись добавляется
 * осознанно.
 *
 * ## Почему у двойника нет кэша
 *
 * Кэш вернул бы `ok` там, где запись говорит `timeout` или `rate_limited`:
 * первый вызов упал бы, второй молча прошёл. Двойник обязан воспроизводить
 * поведение записи на каждом вызове, поэтому `cacheHit` у него всегда `false`.
 */
import {
  LlmBudgetError,
  LlmRateLimitError,
  LlmRecordingMissingError,
  LlmTimeoutError,
  withAttempt,
  type LlmPort,
  type LlmRequest,
  type LlmResponse,
} from './port.js';
import type { LlmPolicy } from './policy.js';
import { buildEffectivePrompt, promptHash, responseHash } from './prompt.js';

const PROVIDER = 'recorded' as const;

/**
 * Записанное поведение модели.
 *
 * Четыре «плохих» текстовых вида отличаются от `ok` только содержимым, и это
 * намеренно: провайдер обязан отдать их вызывающему БЕЗ правки. Отдельные
 * ярлыки нужны, чтобы запись читалась как утверждение о дефекте, а не как
 * случайная строка, и чтобы тест мог сослаться на вид дефекта по имени.
 */
export type RecordedBehaviour =
  | {
      kind: 'ok';
      text: string;
      tokensIn?: number;
      tokensOut?: number;
      cost?: number;
    }
  /** Ответ не разбирается как JSON. */
  | { kind: 'invalid_json'; text: string }
  /** Валидный JSON, но не по схеме ответа стадии. */
  | { kind: 'off_schema'; text: string }
  /** Цитата, которой нет в тексте страницы: §8.2 требует `undetermined`. */
  | { kind: 'fabricated_quote'; text: string }
  /** Ответ на другом языке. */
  | { kind: 'foreign_language'; text: string }
  | { kind: 'timeout' }
  | { kind: 'budget_exceeded' }
  | { kind: 'rate_limited' };

/** Виды записей, которые доезжают до вызывающего текстом, а не исключением. */
const TEXTUAL_KINDS = new Set([
  'ok',
  'invalid_json',
  'off_schema',
  'fabricated_quote',
  'foreign_language',
]);

export type RecordedFallback = (
  promptHashHex: string,
  request: LlmRequest,
) => RecordedBehaviour | Promise<RecordedBehaviour>;

export interface RecordedLlmProviderOptions {
  /** Ключ — sha256 полного эффективного промта, hex. */
  readonly responses: ReadonlyMap<string, RecordedBehaviour>;
  /** По умолчанию — отказ с хэшем в сообщении. См. шапку файла. */
  readonly fallback?: RecordedFallback | undefined;
  /** Модель, от имени которой отвечает запись; попадает в `ai_runs.model`. */
  readonly model?: string | undefined;
  /**
   * Политика: применяется только allowlist моделей.
   *
   * Бюджет и лимит частоты у двойника выражены записями `budget_exceeded` и
   * `rate_limited` — они проверяются в сценарии по месту, а не по календарю.
   * Allowlist же обязан работать и здесь: иначе тесты на двойнике пропустили бы
   * модель, которую production отвергнет ещё до вызова.
   */
  readonly policy?: LlmPolicy | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_MODEL = 'recorded-model';
const DEFAULT_TIMEOUT_MS = 120_000;

export class RecordedLlmProvider implements LlmPort {
  readonly #options: RecordedLlmProviderOptions;
  readonly #model: string;
  readonly #now: () => number;

  constructor(options: RecordedLlmProviderOptions) {
    this.#options = options;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#now = options.now ?? Date.now;
  }

  /** Хэш, под которым нужно записать ответ на такой запрос. */
  static hashOf(request: LlmRequest, model?: string): string {
    return promptHash(buildEffectivePrompt({ ...request, model: request.model ?? model }));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = this.#now();
    const model = request.model ?? this.#model;
    this.#options.policy?.ensureModelAllowed(model);

    const effective = buildEffectivePrompt({ ...request, model });
    const inputHash = promptHash(effective);

    const recorded = this.#options.responses.get(inputHash);
    const behaviour = recorded ?? (await this.#missing(inputHash, request));

    if (!TEXTUAL_KINDS.has(behaviour.kind)) {
      // Двойник обязан быть не мягче оригинала и в этом: записанный отказ
      // уносит с собой ту же попытку, что и настоящий провайдер, иначе тесты
      // проходили бы на следе, которого в бою не бывает.
      throw withAttempt(this.#failure(behaviour.kind), {
        provider: PROVIDER,
        model,
        inputHash,
        latencyMs: this.#now() - startedAt,
      });
    }

    // Текст отдаётся ровно таким, каким записан. Ни разбора, ни починки, ни
    // «а вдруг это всё-таки JSON»: чинить ответ модели внутри провайдера —
    // это и есть двойник, который добрее оригинала.
    const text = 'text' in behaviour ? behaviour.text : '';
    // Токены и стоимость есть только у `ok`: у записанного дефекта их не было
    // бы и в реальности — вызов либо не дошёл, либо ответ непригоден.
    const usage = behaviour.kind === 'ok' ? behaviour : null;

    return {
      text,
      model,
      provider: PROVIDER,
      tokensIn: usage?.tokensIn ?? null,
      tokensOut: usage?.tokensOut ?? null,
      cost: usage?.cost ?? null,
      latencyMs: this.#now() - startedAt,
      inputHash,
      outputHash: responseHash(text),
      cacheHit: false,
    };
  }

  #failure(kind: RecordedBehaviour['kind']): Error {
    switch (kind) {
      case 'timeout':
        return new LlmTimeoutError(
          this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          'Записанное поведение: модель не ответила за отведённое время.',
        );
      case 'budget_exceeded':
        return new LlmBudgetError('Записанное поведение: месячный бюджет LLM исчерпан.', {
          spent: 0,
          budget: 0,
        });
      default:
        return new LlmRateLimitError('Записанное поведение: превышен лимит частоты вызовов LLM.');
    }
  }

  async #missing(hash: string, request: LlmRequest): Promise<RecordedBehaviour> {
    const fallback = this.#options.fallback;
    if (fallback === undefined) {
      throw new LlmRecordingMissingError(
        hash,
        `Нет записанного ответа для хэша ${hash} (стадия ${request.stage}, промт ` +
          `${request.promptCode}@${request.promptVersion}, схема ${request.schemaVersion}). ` +
          'Промт изменился либо запись не добавлена: правдоподобный ответ здесь скрыл бы ' +
          'изменение промта, поэтому вызов отвергнут.',
      );
    }
    return fallback(hash, request);
  }
}
