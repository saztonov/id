/**
 * Эффективный промт, его хэш и ключ кэша (§8.2, §10).
 *
 * ## Что такое «эффективный промт»
 *
 * Это канонизированная строка, полностью определяющая вызов: стадия, код и
 * версия промта, версия схемы ответа, модель, системная и пользовательская
 * части и соседний контекст. Хэш именно этой строки уходит в
 * `ai_runs.input_hash` и служит ключом записанных ответов двойника. Отсюда
 * требование детерминированности: если канонизация зависит от порядка ключей
 * объекта или от вида переводов строки, то один и тот же вызов на Windows и на
 * Linux даёт разные хэши, кэш не срабатывает никогда, а записанные ответы
 * двойника перестают находиться на другой машине.
 *
 * ## Почему в заголовке есть длины частей
 *
 * Разделители — обычный текст, и он может встретиться внутри промта. Без длин
 * перенос куска из `userPrompt` в `cacheContext` давал бы БАЙТ В БАЙТ ту же
 * строку, то есть два разных вызова с одним ключом кэша. Длины делают такую
 * подмену невозможной, не требуя экранирования содержимого.
 *
 * ## Почему кэш живёт в провайдере, а не рядом с задачей
 *
 * §8.2 требует, чтобы в ключ входили промт, модель, провайдер, соседний
 * контекст и версия схемы. Первые два известны только провайдеру, последние
 * три — вызывающему; собрать ключ можно лишь в одном месте, и это провайдер.
 * Кэш на стороне задачи означал бы, что «не ходить наружу второй раз» зависит
 * от аккуратности каждой задачи по отдельности.
 */
import { createHash } from 'node:crypto';

import type { LlmProviderName, LlmRequest } from './port.js';

/**
 * Версия канонизации.
 *
 * Меняется при любой правке формата ниже. Без неё старые записанные ответы
 * двойника молча подошли бы к новому формату промта — то есть двойник отвечал
 * бы на промт, которого больше не существует.
 */
export const EFFECTIVE_PROMPT_VERSION = 1;

const HEADER = `ID-LLM-PROMPT/${EFFECTIVE_PROMPT_VERSION}`;
const SYSTEM_MARK = '--SYSTEM--';
const USER_MARK = '--USER--';
const CONTEXT_MARK = '--CONTEXT--';
const END_MARK = '--END--';

/** CRLF и одиночный CR приводятся к LF: вид перевода строки не меняет смысл. */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export interface EffectivePromptInput extends Pick<
  LlmRequest,
  'stage' | 'promptCode' | 'promptVersion' | 'schemaVersion' | 'systemPrompt' | 'userPrompt'
> {
  readonly cacheContext: string;
  /** Модель, которая ФАКТИЧЕСКИ поедет в запрос, а не пожелание вызывающего. */
  readonly model?: string | undefined;
}

/**
 * Детерминированная канонизация вызова.
 *
 * Порядок полей фиксирован здесь и нигде больше не повторяется: второе место,
 * где собирается «то же самое», разошлось бы с этим при первой же правке.
 */
export function buildEffectivePrompt(request: EffectivePromptInput): string {
  const system = normalizeNewlines(request.systemPrompt);
  const user = normalizeNewlines(request.userPrompt);
  const context = normalizeNewlines(request.cacheContext);
  const model = request.model ?? '';

  return [
    HEADER,
    `stage=${request.stage}`,
    `prompt=${request.promptCode}@${request.promptVersion}`,
    `schema=${request.schemaVersion}`,
    `model=${model}`,
    `len=${system.length},${user.length},${context.length}`,
    SYSTEM_MARK,
    system,
    USER_MARK,
    user,
    CONTEXT_MARK,
    context,
    END_MARK,
  ].join('\n');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** sha256 полного эффективного промта. Он же `ai_runs.input_hash`. */
export function promptHash(effective: string): string {
  return sha256Hex(effective);
}

/** sha256 текста ответа. Он же `ai_runs.output_hash`. */
export function responseHash(text: string): string {
  return sha256Hex(text);
}

export interface CacheKeyInput {
  readonly effective: string;
  readonly model: string;
  readonly provider: LlmProviderName;
}

/**
 * Ключ кэша.
 *
 * Соседний контекст и версия схемы входят сюда ЧЕРЕЗ эффективный промт — они
 * его части. Модель и провайдер добавляются отдельно, потому что один и тот же
 * промт у разных моделей и у разных провайдеров даёт разные ответы, и общий
 * ключ на них означал бы выдачу чужого ответа после переключения провайдера.
 */
export function cacheKey(input: CacheKeyInput): string {
  return sha256Hex(
    [
      `provider=${input.provider}`,
      `model=${input.model}`,
      `effective=${input.effective.length}`,
      input.effective,
    ].join('\n'),
  );
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface LruCacheOptions {
  /** Потолок записей: кэш промтов иначе растёт вместе с числом страниц. */
  readonly maxEntries: number;
  readonly ttlMs: number;
  /** Часы инъекцией: тест на протухание не должен ждать реального времени. */
  readonly now?: (() => number) | undefined;
}

/**
 * Кэш ответов LLM в памяти процесса.
 *
 * И потолок, и TTL обязательны. Без потолка кэш держит все ответы поставки
 * (83 страницы × промт) до конца жизни процесса; без TTL опубликованная новая
 * версия промта не вытеснила бы ответы старой, потому что ключ старого промта
 * продолжает существовать и продолжает находиться.
 */
export class LruCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: LruCacheOptions) {
    this.#maxEntries = Math.max(1, Math.trunc(options.maxEntries));
    this.#ttlMs = Math.max(0, Math.trunc(options.ttlMs));
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Перевставка обновляет позицию в порядке Map — он же порядок вытеснения.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}
