/**
 * Генератор seed-миграции справочников каталога (§3.2, §8.1).
 *
 * Источник правды — массивы `DOC_TYPES` и `PAGE_ROLES` в коде; в БД они
 * попадают этим SQL. Seed владеет только системными строками: администраторские
 * настройки живут в `doc_type_overrides`, и здесь эта таблица не упоминается
 * вовсе — значит, затереть её нечем.
 *
 * Вывод детерминирован: строки отсортированы по коду, ключи JSON фиксированы
 * порядком построения. Иначе каждая перегенерация давала бы шумный диф.
 */

import { DOC_TYPES } from './catalog.js';
import { PAGE_ROLES } from './page-roles.js';
import type { DocTypeDefinition, MatchHints, PageRoleDefinition } from './types.js';

const TAG_BASE = 'seed';

/**
 * Строковый литерал в долларовых кавычках.
 *
 * Якоря каталога — исходники регулярных выражений: там обратные слэши (`\s`,
 * `\d`), скобки и потенциально апострофы. Обычный `'...'`-литерал безопасен
 * только при `standard_conforming_strings = on`; при выключенном параметре
 * `\s` схлопнулось бы в `s`, и якорь молча изменил бы смысл. Долларовые
 * кавычки не интерпретируют внутри себя ничего.
 *
 * Тег наращивается, пока значение содержит подстроку `$<тег>`: именно её, а не
 * полный `$<тег>$`, потому что текст вида `...$seed` слипся бы с открывающей
 * скобкой закрывающего тега и лексер закрыл бы литерал раньше времени.
 */
export function sqlLiteral(value: string): string {
  let tag = TAG_BASE;
  for (let attempt = 1; value.includes(`$${tag}`); attempt += 1) {
    tag = `${TAG_BASE}${attempt}`;
  }
  return `$${tag}$${value}$${tag}$`;
}

function jsonbLiteral(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

/**
 * Признаки распознавания в JSONB.
 *
 * Ключи — camelCase, как в `MatchHints`: значение читается обратно тем же
 * TypeScript-кодом и админкой, а не SQL-выражениями. Необязательные ключи
 * опускаются, а не пишутся как `null`, чтобы разобранный из БД объект совпадал
 * с объектом каталога.
 */
function matchHintsJson(hints: MatchHints): Record<string, readonly string[] | number> {
  const json: Record<string, readonly string[] | number> = { anchors: hints.anchors };
  if (hints.negativeAnchors !== undefined) {
    json['negativeAnchors'] = hints.negativeAnchors;
  }
  if (hints.bodyHints !== undefined) {
    json['bodyHints'] = hints.bodyHints;
  }
  if (hints.headingLines !== undefined) {
    json['headingLines'] = hints.headingLines;
  }
  return json;
}

/**
 * Сравнение по кодовым точкам, а не `localeCompare`: порядок строк миграции не
 * должен зависеть от локали машины, на которой её сгенерировали.
 */
function byCode(a: { readonly code: string }, b: { readonly code: string }): number {
  if (a.code === b.code) {
    return 0;
  }
  return a.code < b.code ? -1 : 1;
}

/** Системные поля: только их обновляет `DO UPDATE`. */
const SYSTEM_COLUMNS = [
  'name',
  'short_name',
  'group_code',
  'kind',
  'has_annexes',
  'is_fallback',
  'match_hints',
  'field_schema',
  'sort_order',
] as const;

function docTypeRow(docType: DocTypeDefinition): string {
  const values = [
    sqlLiteral(docType.code),
    sqlLiteral(docType.name),
    sqlLiteral(docType.shortName),
    sqlLiteral(docType.group),
    sqlLiteral(docType.kind),
    String(docType.hasAnnexes),
    // is_system: всё, что пришло из каталога, системное по определению.
    'true',
    String(docType.isFallback),
    jsonbLiteral(matchHintsJson(docType.matchHints)),
    // Схема каталога, без базовых реквизитов: их подмешивает `fieldsForType()`,
    // и дублировать результат в БД значило бы переписывать все строки при
    // правке одного базового поля.
    jsonbLiteral(docType.fieldSchema),
    String(docType.sortOrder),
  ];

  return `  (${values.join(', ')})`;
}

function docTypesStatement(): string {
  const rows = [...DOC_TYPES].sort(byCode).map(docTypeRow).join(',\n');
  const updates = SYSTEM_COLUMNS.map((column) => `  ${column} = EXCLUDED.${column}`).join(',\n');

  return [
    '-- Системные типы документов.',
    '--',
    '-- Условие WHERE — граница ответственности seed. Тип, заведённый',
    '-- администратором вручную (is_system = false), сохраняет свои значения, и',
    '-- совпадение кода не считается ошибкой миграции.',
    'INSERT INTO doc_types (',
    '  code, name, short_name, group_code, kind, has_annexes,',
    '  is_system, is_fallback, match_hints, field_schema, sort_order',
    ')',
    'VALUES',
    rows,
    'ON CONFLICT (code) DO UPDATE SET',
    updates,
    'WHERE doc_types.is_system;',
  ].join('\n');
}

function pageRoleRow(role: PageRoleDefinition): string {
  return `  (${sqlLiteral(role.code)}, ${sqlLiteral(role.name)})`;
}

function pageRolesStatement(): string {
  const rows = [...PAGE_ROLES].sort(byCode).map(pageRoleRow).join(',\n');

  return [
    '-- Роли страниц.',
    '--',
    '-- По §3.2 таблица состоит из кода и названия. Признаки распознавания ролей',
    '-- остаются в коде (PAGE_ROLES): таблицы переопределений для них нет, а базе',
    '-- справочник нужен ради внешних ключей.',
    'INSERT INTO page_roles (code, name)',
    'VALUES',
    rows,
    'ON CONFLICT (code) DO UPDATE SET',
    '  name = EXCLUDED.name;',
  ].join('\n');
}

const HEADER = [
  '-- Seed справочников каталога исполнительной документации (§3.2, §8.1).',
  '--',
  '-- Файл сгенерирован generateSeedSql() из packages/doc-types. Править вручную',
  '-- бессмысленно: следующая генерация вернёт содержимое каталога. Пользовательские',
  '-- настройки типов живут в doc_type_overrides и этим seed не затрагиваются.',
  '--',
  '-- Новая сид-миграция, а не правка прежней: применённый файл защищён',
  '-- контрольной суммой, и раннер отказывает на изменённом задним числом.',
  '-- Оператор идемпотентен (ON CONFLICT DO UPDATE по системным колонкам),',
  '-- поэтому накат поверх прежнего сида и накат на чистую базу дают одно и то же.',
  '-- Перегенерировать: pnpm seed:generate.',
].join('\n');

/**
 * Отдельные операторы seed.
 *
 * Расширенный протокол PostgreSQL (и `PGlite.query`) исполняет ровно один
 * оператор за вызов, поэтому раннеру и тестам нужен список, а не склеенный
 * скрипт.
 */
export function generateSeedStatements(): readonly string[] {
  return [docTypesStatement(), pageRolesStatement()];
}

/** Полный текст seed-миграции. */
export function generateSeedSql(): string {
  return `${HEADER}\n\n${generateSeedStatements().join('\n\n')}\n`;
}
