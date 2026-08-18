/**
 * Каталог правил: реестр и реализации ОДНИМ объектом (§9.6).
 *
 * Два параллельных списка — «коды где-то» и «функции где-то ещё» — расходятся
 * молча. Это ровно тот дефект, который на S2 дал нулевое пересечение имён
 * ограничений между схемой Drizzle и SQL, и тот, который на S4 позволил
 * опечатке в `enabled_rule_codes` тихо выключить проверку. Поэтому здесь
 * ОДНА таблица: из неё порождается сид `rule_definitions` (`seed.ts`), по ней
 * же движок исполняет правила, и сверка при старте сравнивает БД с ней в обе
 * стороны.
 *
 * ## Что здесь можно менять, а что нет
 *
 * `severity`, `isBlocking` и `params` В ПРОГОНЕ берутся не отсюда, а из
 * неизменяемого снимка `ruleset_rules`. Поля `defaultSeverity`,
 * `defaultBlocking` и `defaultParams` — только заготовка для публикации новой
 * версии набора правил и значения по умолчанию сида. Правка кода не меняет
 * поведение уже опубликованного набора: в этом весь смысл §3.7.
 *
 * ## Кодировка
 *
 * `<ГРУППА>.<ПОДГРУППА>.<НОМЕР>` либо `<ГРУППА>.<НОМЕР>`. Номера соответствуют
 * §9.2–§9.5 плана; пропуски в нумерации оставлены намеренно, чтобы правило,
 * добавленное эксплуатацией, вставало рядом со своей группой, а не в конец.
 */
import { DATE_RULES, SIGNATURE_RULES } from './dates.js';
import { AOSR_RULES, CROSSCHECK_RULES, EXTERNAL_RULES } from './aosr.js';
import { EVIDENCE_RULES } from './evidence.js';
import type { RuleSpec } from './types.js';

/**
 * Полный каталог.
 *
 * Порядок групп не влияет на прогон (движок сортирует по коду), но задаёт
 * порядок сида и читаемость diff'а.
 */
export const RULE_CATALOG: readonly RuleSpec[] = [
  ...DATE_RULES,
  ...SIGNATURE_RULES,
  ...AOSR_RULES,
  ...CROSSCHECK_RULES,
  ...EXTERNAL_RULES,
  ...EVIDENCE_RULES,
];

export const RULE_CODES: readonly string[] = RULE_CATALOG.map((spec) => spec.code);

/**
 * Дубли кодов внутри каталога.
 *
 * Проверяется отдельно от сверки с БД: два спека с одним кодом дают
 * `rule_definitions`, где второй молча вытесняет первого при сиде, и одно из
 * двух правил перестаёт исполняться, оставаясь в списке включённых.
 */
export function duplicateRuleCodes(specs: readonly RuleSpec[] = RULE_CATALOG): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.code)) duplicates.add(spec.code);
    seen.add(spec.code);
  }
  return [...duplicates].sort();
}
