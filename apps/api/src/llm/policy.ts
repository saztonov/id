/**
 * Политика вызовов LLM: allowlist моделей, месячный бюджет, частота (§10, §11).
 *
 * ## Почему политика — отдельный объект, а не проверки внутри провайдера
 *
 * Все три ограничения обязаны срабатывать ДО сетевого вызова: запрещённая
 * модель, исчерпанный бюджет и превышенная частота отличаются от отказа
 * провайдера тем, что их видно заранее. Проверка «по факту ответа» означала бы,
 * что деньги уже потрачены, а запрещённая модель уже увидела текст ИД.
 *
 * ## Почему бюджет читается инъекцией
 *
 * Фактическая трата — это `sum(ai_runs.cost)` за календарный месяц, то есть
 * запрос к БД с областью видимости. Внутри политики он сделал бы её
 * непроверяемой без базы и завёл бы обращение к БД вне `db/repositories/`.
 * Поэтому здесь только порт `SpendReader`, а его реализация — `monthlyAiSpend`.
 *
 * ## Почему пустой allowlist ведёт себя по-разному
 *
 * В production пустой список означает «администратор не задал ограничение», и
 * единственное безопасное толкование — запретить всё: иначе забытая переменная
 * молча открывает любую модель, включая дорогую или чужую. В test и development
 * пустой список означает «ограничение не настраивали», и запрет всего сделал бы
 * гейты зависимыми от боевого перечня моделей. Это явное расхождение, а не
 * побочный эффект: оно закреплено `emptyAllowlistBehaviour()` и тестом.
 */
import type { Env } from '../config/env.js';
import { allowedModels } from '../config/env.js';
import { LlmBudgetError, LlmModelNotAllowedError, LlmRateLimitError } from './port.js';

/** Источник фактической траты за календарный месяц. Реализация — `monthlyAiSpend`. */
export interface SpendReader {
  monthlySpend(at: Date): Promise<number>;
}

export type EmptyAllowlistBehaviour = 'deny' | 'allow';

export interface LlmPolicyOptions {
  readonly allowedModels: readonly string[];
  readonly emptyAllowlist: EmptyAllowlistBehaviour;
  /** `0` — ограничения нет. Иначе потолок суммы `ai_runs.cost` за месяц. */
  readonly budgetMonthly: number;
  readonly rateLimitPerMin: number;
  readonly spend: SpendReader;
  /** Детерминированные часы: скользящее окно иначе непроверяемо. */
  readonly now?: (() => number) | undefined;
}

const WINDOW_MS = 60_000;

export class LlmPolicy {
  readonly #options: LlmPolicyOptions;
  readonly #now: () => number;
  /** Отметки состоявшихся разрешений в текущем окне. */
  #window: number[] = [];

  constructor(options: LlmPolicyOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Разрешена ли модель. Отдельно от `ensureCallPermitted`, потому что
   * проверяется раньше — до обращения к кэшу: отдавать записанный ответ модели,
   * которую политика больше не допускает, значит продолжать её использовать.
   */
  ensureModelAllowed(model: string): void {
    const list = this.#options.allowedModels;
    if (list.length === 0) {
      if (this.#options.emptyAllowlist === 'allow') return;
      throw new LlmModelNotAllowedError(
        model,
        'LLM_MODEL_ALLOWLIST пуст: в production это запрет всех моделей. ' +
          'Укажите перечень допустимых моделей явно.',
      );
    }
    if (!list.includes(model)) {
      throw new LlmModelNotAllowedError(
        model,
        `Модель «${model}» не входит в LLM_MODEL_ALLOWLIST.`,
      );
    }
  }

  /**
   * Полная проверка перед сетевым вызовом.
   *
   * Порядок важен: сначала бесплатные и детерминированные проверки (модель,
   * бюджет), и только потом расходуется слот частоты. Иначе отвергнутый по
   * allowlist вызов съедал бы квоту, которую он не использовал.
   */
  async ensureCallPermitted(input: { readonly model: string; readonly at?: Date }): Promise<void> {
    this.ensureModelAllowed(input.model);
    await this.#ensureWithinBudget(input.at ?? new Date(this.#now()));
    this.#consumeRateSlot();
  }

  async #ensureWithinBudget(at: Date): Promise<void> {
    const budget = this.#options.budgetMonthly;
    if (budget <= 0) return;

    const spent = await this.#options.spend.monthlySpend(at);
    if (spent >= budget) {
      throw new LlmBudgetError(
        `Месячный бюджет LLM исчерпан: потрачено ${spent.toFixed(4)} при пороге ${budget.toFixed(4)}.`,
        { spent, budget },
      );
    }
  }

  #consumeRateSlot(): void {
    const limit = this.#options.rateLimitPerMin;
    if (limit <= 0) return;

    const now = this.#now();
    const edge = now - WINDOW_MS;
    // Скользящее окно, а не счётчик с обнулением по минуте: у второго на стыке
    // минут проходит двойной лимит подряд, и всплеск виден только провайдеру.
    this.#window = this.#window.filter((stamp) => stamp > edge);
    if (this.#window.length >= limit) {
      throw new LlmRateLimitError(
        `Превышен лимит вызовов LLM: ${limit} в минуту (LLM_RATE_LIMIT_PER_MIN).`,
      );
    }
    this.#window.push(now);
  }
}

/**
 * Толкование пустого `LLM_MODEL_ALLOWLIST` по окружению. См. шапку файла.
 */
export function emptyAllowlistBehaviour(env: Env): EmptyAllowlistBehaviour {
  return env.NODE_ENV === 'production' ? 'deny' : 'allow';
}

export interface LlmPolicyDeps {
  readonly spend: SpendReader;
  readonly now?: (() => number) | undefined;
}

export function createLlmPolicy(env: Env, deps: LlmPolicyDeps): LlmPolicy {
  return new LlmPolicy({
    allowedModels: allowedModels(env),
    emptyAllowlist: emptyAllowlistBehaviour(env),
    budgetMonthly: env.LLM_BUDGET_MONTHLY,
    rateLimitPerMin: env.LLM_RATE_LIMIT_PER_MIN,
    spend: deps.spend,
    now: deps.now,
  });
}
