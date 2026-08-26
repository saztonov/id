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
import { RULE_CATALOG, RULE_CATALOG_WITH_RETIRED } from './catalog.js';
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

// =====================================================================
// Встроенный набор правил
// =====================================================================

/** Имя миграции встроенного набора — один источник для скрипта и теста дрейфа. */
export const BUILTIN_RULESET_MIGRATION = '0044_builtin_ruleset';

/** Номер версии встроенного набора в `ruleset_versions.version`. */
export const BUILTIN_RULESET_VERSION = 'builtin-1';

const BUILTIN_HEADER = `-- Встроенный набор правил и его активация (§3.7, §9.6).
--
-- Файл сгенерирован generateBuiltinRulesetSql() из RULE_CATALOG. Править вручную
-- бессмысленно: следующая генерация вернёт содержимое каталога.
-- Перегенерировать: pnpm rules:seed:generate.
--
-- ## Что было неверно
--
-- Реестр правил (rule_definitions) сеялся миграциями с S4, а НАБОР — версия с
-- неизменяемым снимком поведения — не сеялся никогда, и указатель
-- ruleset.active_version_id по умолчанию NULL. Прогон правил из-за этого не
-- начинался вовсе: checks.run отказывал «активная версия набора правил не
-- назначена», и замечаний у комплекта не появлялось НИ ОДНОГО ни при каких
-- данных. Портал, вся работа которого — проверка комплекта, из коробки не
-- проверял ничего, и сказано об этом было только в консоли воркера.
--
-- ## Почему набор помечен origin='builtin', а не опубликован от чьего-то имени
--
-- ruleset_versions_published_chk требовал published_by у любой опубликованной
-- версии, и обойти его можно было бы, подставив встроенного администратора.
-- Так делать нельзя по той же причине, по которой сид промптов не сеет
-- published-строку: published_by читают как ДОКАЗАТЕЛЬСТВО решения человека, и
-- подделка в этом столбце обесценивает журнал целиком. Поэтому заведена третья
-- возможность: набор, опубликованный не человеком, а поставкой портала, — и она
-- названа своим словом в колонке origin.
--
-- ## Почему порядок операторов именно такой
--
-- Триггер ruleset_rules_published_immutable (0008) запрещает ВСТАВКУ строк в
-- снимок уже опубликованной версии — правило, добавленное после публикации,
-- меняет результат прогона так же, как изменённое. Отсюда единственно
-- возможный порядок: версия с published_at IS NULL, затем снимок, затем
-- публикация. Обратный порядок дал бы отказ триггера посреди миграции.
--
-- ## Что миграция НЕ делает
--
-- Не трогает уже назначенную активную версию: ON CONFLICT (key) DO NOTHING.
-- Администратор, опубликовавший свой набор, остаётся на нём.
`;

/**
 * SQL встроенного набора правил: колонка `origin`, версия, снимок, активация.
 *
 * Снимок берётся из `defaultSnapshotRows` — того же экспорта, из которого его
 * строят администратор при первой публикации и тест прогона. Четвёртая копия
 * умолчаний разошлась бы с остальными молча, а разойтись ей нельзя: снимок
 * определяет, что именно проверял прогон месячной давности.
 */
export function generateBuiltinRulesetSql(
  specs: readonly RuleSpec[] = RULE_CATALOG_WITH_RETIRED,
): string {
  const rows = defaultSnapshotRows(specs)
    .map(
      (row) =>
        `    (${sqlLiteral(row.ruleCode)}, ${String(row.isEnabled)}, ` +
        `${sqlLiteral(row.severity)}, ${String(row.isBlocking)}, ` +
        `${sqlLiteral(JSON.stringify(row.params))}::jsonb)`,
    )
    .join(',\n');

  const version = sqlLiteral(BUILTIN_RULESET_VERSION);

  return `${BUILTIN_HEADER}
ALTER TABLE ruleset_versions
  ADD COLUMN origin text NOT NULL DEFAULT 'manual';

ALTER TABLE ruleset_versions
  ADD CONSTRAINT ruleset_versions_origin_chk CHECK (origin IN ('manual', 'builtin'));

ALTER TABLE ruleset_versions DROP CONSTRAINT ruleset_versions_published_chk;
ALTER TABLE ruleset_versions ADD CONSTRAINT ruleset_versions_published_chk
  CHECK (published_at IS NULL OR published_by IS NOT NULL OR origin = 'builtin');

-- 1. Версия — НЕОПУБЛИКОВАННАЯ: пока published_at пуст, снимок можно набирать.
INSERT INTO ruleset_versions (version, origin, notes)
SELECT ${version}, $ruleset$builtin$ruleset$,
       $ruleset$Набор по умолчанию из каталога правил портала. Опубликован поставкой, а не человеком.$ruleset$
 WHERE NOT EXISTS (SELECT 1 FROM ruleset_versions WHERE version = ${version});

-- 2. Снимок поведения: severity, is_blocking и params из умолчаний каталога.
--
-- Условие published_at IS NULL — не украшение: триггер запрещает вставку в
-- снимок опубликованной версии и сработал бы РАНЬШЕ, чем ON CONFLICT успел бы
-- признать строку дублем. Так оператор остаётся безвредным при повторе.
INSERT INTO ruleset_rules (ruleset_version_id, rule_code, is_enabled, severity, is_blocking, params)
SELECT v.id, x.rule_code, x.is_enabled, x.severity, x.is_blocking, x.params
  FROM ruleset_versions v
  CROSS JOIN (VALUES
${rows}
  ) AS x(rule_code, is_enabled, severity, is_blocking, params)
 WHERE v.version = ${version} AND v.published_at IS NULL
ON CONFLICT (ruleset_version_id, rule_code) DO NOTHING;

-- 3. Публикация — последним оператором, после набора снимка.
UPDATE ruleset_versions
   SET published_at = now()
 WHERE version = ${version} AND published_at IS NULL;

-- 4. Активация. DO NOTHING: осознанный выбор администратора не затирается.
INSERT INTO app_settings (key, value)
SELECT $ruleset$ruleset.active_version_id$ruleset$, to_jsonb(id::text)
  FROM ruleset_versions WHERE version = ${version}
ON CONFLICT (key) DO NOTHING;
`;
}
