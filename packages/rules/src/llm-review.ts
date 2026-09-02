/**
 * Правила ИИ-проверки заполнения (§9.1, S21).
 *
 * ## Зачем они в каталоге, если исполняет их не движок
 *
 * `findings.rule_code` — внешний ключ на `rule_definitions`, а сверка при
 * старте (`assertRuleRegistryConsistent`) сравнивает содержимое этой таблицы с
 * `RULE_CATALOG` В ОБЕ СТОРОНЫ. Значит, у замечания ИИ-стадии обязан быть код,
 * объявленный здесь, — иначе либо запись не пройдёт по внешнему ключу, либо
 * портал перестанет стартовать.
 *
 * Обойти это одним техническим кодом «замечание модели» было заманчиво и
 * неверно: в таблице замечаний колонка «Правило» — то, по чему инженер
 * сортирует работу, и один код на все ИИ-находки превратил бы её в шум.
 * Поэтому кодов четыре, по видам расхождений, которые ИИ-стадия умеет назвать.
 *
 * ## Почему `evaluate` возвращает `n_a`
 *
 * Детерминированный движок эти правила исполнить не может — данных для вывода
 * у него нет. Вернуть `undetermined` значило бы порождать по четыре
 * неразрешённых замечания на каждый прогон правил, то есть шум, неотличимый от
 * работы. `n_a` с названной причиной — честный ответ: «эта проверка делается
 * другой стадией», и она видна в журнале прогона поимённо.
 *
 * Прецедент тот же, что у `EXT.*`: правило объявлено, применимость честно
 * отрицается, реализация живёт вне чистой функции. Разница в том, что там
 * источник — внешний реестр, а здесь — задача `checks.llm_review`.
 *
 * ## Ни одно из них не блокирует
 *
 * `defaultBlocking: false` у всех четырёх, и это не осторожность, а инвариант
 * БД: `findings_llm_blocking_chk` запрещает `origin='llm' AND is_blocking` без
 * `confirmed_by`. Замечание модели становится блокирующим только после того,
 * как его подтвердил человек (§3.7, §9.1).
 */
import { notApplicable } from './result.js';
import type { RuleSpec } from './types.js';

/** Причина `n_a`: она уходит в журнал прогона и читается человеком. */
export const LLM_REVIEW_NOT_APPLICABLE =
  'проверяется ИИ-стадией checks.llm_review, а не движком правил';

/**
 * Коды, которые ИИ-стадия имеет право назвать.
 *
 * Закрытое перечисление: ответ модели с кодом вне этого набора не пройдёт по
 * внешнему ключу `findings.rule_code`, и узналось бы это отказом транзакции
 * записи — то есть потерей всего прогона из-за одной выдуманной строки.
 */
export const LLM_REVIEW_CODES = [
  'LLM.FILL.010',
  'LLM.FILL.020',
  'LLM.FILL.030',
  'LLM.FILL.040',
] as const;

export type LlmReviewCode = (typeof LLM_REVIEW_CODES)[number];

interface LlmRuleInput {
  readonly code: LlmReviewCode;
  readonly title: string;
  readonly level: RuleSpec['level'];
  readonly severity: RuleSpec['defaultSeverity'];
  /** Умолчание — `crosscheck`; см. `extraction_quality` у LLM.FILL.020. */
  readonly kind?: RuleSpec['kind'];
}

function llmRule(input: LlmRuleInput): RuleSpec {
  return {
    code: input.code,
    title: input.title,
    docTypeCode: null,
    level: input.level,
    kind: input.kind ?? 'crosscheck',
    defaultSeverity: input.severity,
    // См. шапку: инвариант БД, а не осторожность.
    defaultBlocking: false,
    waiverRoles: ['engineer', 'manager'],
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: () => notApplicable(LLM_REVIEW_NOT_APPLICABLE),
  };
}

export const LLM_REVIEW_RULES: readonly RuleSpec[] = [
  llmRule({
    code: 'LLM.FILL.010',
    title: 'Обязательный реквизит документа не заполнен',
    level: 'document',
    severity: 'warning',
  }),
  llmRule({
    code: 'LLM.FILL.020',
    title: 'Значение реквизита расходится с текстом документа',
    level: 'document',
    severity: 'warning',
    /**
     * Отчёт о качестве извлечения, а не дефект бумаги (S44).
     *
     * Утверждение правила — «портал прочитал не то, что написано». Подрядчику с
     * ним делать нечего: исправлять надо не документ, а извлечение. 61 такое
     * предупреждение боевой папки лежало вперемешку с настоящими дефектами, где
     * их и принимали за дефекты.
     */
    kind: 'extraction_quality',
  }),
  llmRule({
    code: 'LLM.FILL.030',
    title: 'Реквизиты документов комплекта противоречат друг другу',
    level: 'folder',
    severity: 'warning',
  }),
  llmRule({
    code: 'LLM.FILL.040',
    title: 'Документ не похож на заявленный вид',
    level: 'document',
    severity: 'info',
  }),
];

/** Быстрая проверка принадлежности кода набору ИИ-правил. */
export function isLlmReviewCode(code: string): code is LlmReviewCode {
  return (LLM_REVIEW_CODES as readonly string[]).includes(code);
}
