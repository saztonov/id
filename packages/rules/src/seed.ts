/**
 * Генератор seed-миграции реестра правил (`rule_definitions`, §3.7).
 *
 * Долг тянется с S4: сверка `enabled_rule_codes` с реестром была введена при
 * ПУСТОЙ таблице, поэтому публикация профиля со ссылкой на правило требовала
 * ручного заведения кода. Здесь долг закрывается — источником правды остаётся
 * `RULE_CATALOG`, а SQL производен от него.
 *
 * ## Почему seed не удаляет строки
 *
 * Удаление строки `rule_definitions` каскадом задело бы `findings.rule_code` и
 * `ruleset_rules.rule_code` — то есть переписало бы историю уже выполненных
 * прогонов. Поэтому seed только вставляет и обновляет, а исчезнувший из
 * каталога код обнаруживается сверкой при старте (`reconcileRuleRegistry`) и
 * требует ЯВНОЙ миграции. Молчаливое исчезновение правила из реестра — это
 * ровно тот отказ, из-за которого §9.6 требует двусторонней сверки.
 */
import { RULE_CATALOG } from './catalog.js';
import type { RuleSpec } from './types.js';

const TAG_BASE = 'rules';

/**
 * Строковый литерал в долларовых кавычках.
 *
 * Заголовки правил содержат кавычки-ёлочки и апострофы, а `params` — JSON.
 * Обычный `'...'`-литерал безопасен только при `standard_conforming_strings =
 * on`; долларовые кавычки не интерпретируют внутри себя ничего. Тот же приём и
 * по той же причине применён в seed каталога видов ИД.
 */
export function sqlLiteral(value: string): string {
  let tag = TAG_BASE;
  for (let attempt = 1; value.includes(`$${tag}`); attempt += 1) {
    tag = `${TAG_BASE}${attempt}`;
  }
  return `$${tag}$${value}$${tag}$`;
}

function textArrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return `'{}'::text[]`;
  return `ARRAY[${values.map((value) => sqlLiteral(value)).join(', ')}]::text[]`;
}

function nullableLiteral(value: string | null): string {
  return value === null ? 'NULL' : sqlLiteral(value);
}

/** Сравнение по кодовым точкам: порядок строк не зависит от локали машины. */
function byCode(a: RuleSpec, b: RuleSpec): number {
  return a.code === b.code ? 0 : a.code < b.code ? -1 : 1;
}

const HEADER = `-- Seed реестра правил проверки (§3.7, §9.6).
--
-- Файл сгенерирован generateRuleSeedSql() из packages/rules. Править вручную
-- бессмысленно: следующая генерация вернёт содержимое каталога. Источник правды
-- — RULE_CATALOG, откуда движок берёт и реализации; сверка при старте требует,
-- чтобы множества кодов совпадали в обе стороны.
--
-- Seed не удаляет строки: удаление задело бы rule_code уже выполненных прогонов
-- и переписало бы историю. Код, исчезнувший из каталога, обнаруживается сверкой
-- и требует явной миграции.
--
-- Значения по умолчанию для снимка (is_blocking, params) сюда НЕ пишутся: их
-- место — ruleset_rules, то есть опубликованная версия набора. Колонок под них
-- в rule_definitions нет намеренно, иначе появилось бы второе место, где
-- задано поведение правила, и снимок перестал бы быть единственным.
`;

/**
 * Значения по умолчанию для первой версии набора правил.
 *
 * Выделены в отдельный экспорт, потому что их читает не только миграция:
 * администратор публикует первую версию ruleset из тех же значений, а тест
 * прогона строит из них снимок. Три копии умолчаний разошлись бы молча.
 */
export function defaultSnapshotRows(specs: readonly RuleSpec[] = RULE_CATALOG): readonly {
  readonly ruleCode: string;
  readonly isEnabled: boolean;
  readonly severity: string;
  readonly isBlocking: boolean;
  readonly params: Readonly<Record<string, unknown>>;
}[] {
  return [...specs].sort(byCode).map((spec) => ({
    ruleCode: spec.code,
    isEnabled: true,
    severity: spec.defaultSeverity,
    isBlocking: spec.defaultBlocking,
    params: spec.defaultParams,
  }));
}

export function generateRuleSeedStatements(
  specs: readonly RuleSpec[] = RULE_CATALOG,
): readonly string[] {
  const values = [...specs]
    .sort(byCode)
    .map(
      (spec) =>
        `  (${sqlLiteral(spec.code)}, ${sqlLiteral(spec.title)}, ` +
        `${nullableLiteral(spec.docTypeCode)}, ${sqlLiteral(spec.level)}, ` +
        `${sqlLiteral(spec.kind)}, ${sqlLiteral(spec.defaultSeverity)}, ` +
        `${textArrayLiteral([...spec.waiverRoles])})`,
    )
    .join(',\n');

  return [
    `INSERT INTO rule_definitions (
  code, title, doc_type_code, level, kind, default_severity, waiver_roles
)
VALUES
${values}
ON CONFLICT (code) DO UPDATE SET
  title = EXCLUDED.title,
  doc_type_code = EXCLUDED.doc_type_code,
  level = EXCLUDED.level,
  kind = EXCLUDED.kind,
  default_severity = EXCLUDED.default_severity,
  waiver_roles = EXCLUDED.waiver_roles`,
  ];
}

export function generateRuleSeedSql(specs: readonly RuleSpec[] = RULE_CATALOG): string {
  return `${HEADER}\n${generateRuleSeedStatements(specs).join(';\n\n')};\n`;
}
