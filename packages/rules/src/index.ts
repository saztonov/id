/**
 * Движок правил проверки ИД (§9).
 *
 * Пакет содержит ТОЛЬКО чистую логику: граф на входе, замечания на выходе. Ни
 * доступа к БД, ни сетевых вызовов, ни времени — `today` и ответы внешних
 * реестров приходят в графе. Это условие §3.7: прогон месячной давности обязан
 * воспроизводиться точно по снимку `ruleset_rules`, а функция, читающая часы
 * или сеть, воспроизводимой не бывает.
 */
export * from './types.js';
export * from './result.js';
export * from './helpers.js';
export * from './tolerance.js';
export * from './materials.js';
export * from './external.js';
export * from './engine.js';
export * from './complect-run.js';
export * from './catalog.js';
export * from './seed.js';
export * from './testing.js';
export { DATE_RULES, SIGNATURE_RULES } from './dates.js';
export {
  AOSR_FIELDS,
  AOSR_RULES,
  CROSSCHECK_RULES,
  EXTERNAL_RULES,
  TRANSFER_REGISTRY_RULES,
} from './aosr.js';
export { EVIDENCE_RULES } from './evidence.js';
export {
  isLlmReviewCode,
  LLM_REVIEW_CODES,
  LLM_REVIEW_NOT_APPLICABLE,
  LLM_REVIEW_RULES,
} from './llm-review.js';
export type { LlmReviewCode } from './llm-review.js';

import { RETIRED_RULES, RULE_CATALOG } from './catalog.js';
import { reconcileRuleRegistry } from './engine.js';

/**
 * Сверка реестра правил из БД с каталогом реализаций (§9.6).
 *
 * Обёртка существует, чтобы вызывающему не приходилось помнить об остальных
 * аргументах: забытый каталог означал бы сверку с пустым списком, то есть
 * проверку, которая проходит всегда. Проверка, проходящая при снятой защите, —
 * известная болезнь проекта (S6, S7, S8), и здесь она закрыта формой вызова.
 *
 * Снятые правила передаются третьим списком: их строки остаются в БД навсегда
 * (на них ссылаются замечания прошлых прогонов и снимки опубликованных
 * наборов), а реализации у них больше нет — и это не расхождение, а решение.
 */
export function assertRuleRegistryMatches(definitionCodes: Iterable<string>): void {
  reconcileRuleRegistry(
    definitionCodes,
    RULE_CATALOG,
    RETIRED_RULES.map((spec) => spec.code),
  );
}
