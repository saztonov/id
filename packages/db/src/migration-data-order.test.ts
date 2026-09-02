/**
 * Миграции данных не пишут значение, запрещённое действующим CHECK (S44).
 *
 * ## Почему этот файл появился
 *
 * Миграция 0059 переписывала `findings.target_type` со значения `revision` на
 * `folder` и лишь ПОСЛЕ этого заново объявляла CHECK с новым перечнем. Порядок
 * неверен: в момент UPDATE действует прежнее ограничение, а оно `folder` не
 * знает и отвергает первую же строку.
 *
 * Дефект прошёл ВСЕ проверки проекта, потому что миграции прогоняются на чистой
 * pglite: строк со старым значением там нет, UPDATE не трогает ничего, и
 * ограничение молчит. Отказ случился при развёртывании на боевую базу, где
 * такие строки есть, — то есть в единственном месте, где цена максимальна.
 *
 * ## Что проверяется
 *
 * Разбор идёт по файлам В ПОРЯДКЕ ПРИМЕНЕНИЯ и ведёт состояние: какой CHECK на
 * какую колонку действует к этому моменту. Для каждого `UPDATE t SET c = 'x'`
 * спрашивается ровно одно: разрешает ли `x` ограничение, ДЕЙСТВУЮЩЕЕ сейчас.
 *
 * Отсюда важное следствие: сузить перечень ПОСЛЕ переписывания — законно и
 * тестом не отмечается. Так сделана 0048 (`frozen` → `superseded`/`draft`, и
 * только потом новый перечень без `frozen`): все записываемые значения старый
 * CHECK уже разрешал. Запрещено обратное — писать значение, которого
 * действующий перечень ещё не знает.
 *
 * ## Границы разбора
 *
 * Проверяются только присваивания СТРОКОВОГО ЛИТЕРАЛА колонке, у которой есть
 * CHECK с перечнем значений в кавычках. Выражения, подзапросы и ограничения без
 * перечня пропускаются: утверждать о них по тексту нечего, а ложное
 * срабатывание в такой проверке хуже пропуска — его научатся обходить.
 *
 * Настоящая проверка — прогон миграции на базе С ДАННЫМИ, и она была бы
 * сильнее. Но данные пришлось бы заводить на схеме, какой она была ДО этой
 * миграции, то есть держать снимок каждой промежуточной схемы. Здесь закрыт
 * ровно тот класс, что уже стоил боевого развёртывания.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

/** Комментарии убираются: в них лежат и примеры SQL, и рассказ о прошлом. */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/gu, '');
}

/** Объявление CHECK: и внутри `CREATE TABLE`, и через `ALTER TABLE ADD`. */
interface CheckDeclaration {
  readonly name: string;
  readonly body: string;
  readonly at: number;
}

/**
 * Тело CHECK читается СЧЁТЧИКОМ СКОБОК, а не нежадным регулярным выражением.
 *
 * Первая версия брала `CHECK \(([\s\S]*?)\)` и на `CHECK (c IN ('a','b'))`
 * обрывала тело на скобке списка. `allowedValues` не находил перечня, возвращал
 * `null`, и вся проверка молча становилась пустой — зелёной на любых миграциях.
 * Поймал это положительный контроль ниже; без него дефект уехал бы в тест,
 * который «работает».
 */
function readBalanced(sql: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openAt + 1, i);
    }
  }
  return '';
}

function checksOf(sql: string): readonly CheckDeclaration[] {
  const found: CheckDeclaration[] = [];
  const pattern = /\bCONSTRAINT\s+([a-z_][a-z0-9_]*)\s+CHECK\s*\(/giu;
  for (const match of sql.matchAll(pattern)) {
    const openAt = match.index + match[0].length - 1;
    found.push({
      name: (match[1] ?? '').toLowerCase(),
      body: readBalanced(sql, openAt).toLowerCase(),
      at: match.index,
    });
  }
  return found;
}

function dropsOf(sql: string): readonly { name: string; at: number }[] {
  const found: { name: string; at: number }[] = [];
  const pattern = /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/giu;
  for (const match of sql.matchAll(pattern)) {
    found.push({ name: (match[1] ?? '').toLowerCase(), at: match.index });
  }
  return found;
}

/** Присваивание строкового литерала: `UPDATE t SET c = 'x'`. */
interface LiteralAssignment {
  readonly table: string;
  readonly column: string;
  readonly value: string;
  readonly at: number;
}

function assignmentsOf(sql: string): readonly LiteralAssignment[] {
  const found: LiteralAssignment[] = [];
  const pattern =
    /\bUPDATE\s+([a-z_][a-z0-9_]*)[\s\S]{0,400}?\bSET\s+([a-z_][a-z0-9_]*)\s*=\s*'([^']*)'/giu;
  for (const match of sql.matchAll(pattern)) {
    found.push({
      table: (match[1] ?? '').toLowerCase(),
      column: (match[2] ?? '').toLowerCase(),
      value: (match[3] ?? '').toLowerCase(),
      at: match.index,
    });
  }
  return found;
}

/** Перечень разрешённых значений из тела CHECK; `null` — перечня в нём нет. */
function allowedValues(body: string, column: string): readonly string[] | null {
  const inList = new RegExp(`\\b${column}\\s+in\\s*\\(([^)]*)\\)`, 'u').exec(body);
  if (inList === null) return null;
  const values = [...(inList[1] ?? '').matchAll(/'([^']*)'/gu)].map((m) => m[1] ?? '');
  return values.length === 0 ? null : values;
}

/**
 * Действующие ограничения к моменту очередного файла.
 *
 * Ключ — имя ограничения: в проекте они уникальны и строятся как
 * `<таблица>_<колонка>_chk`, поэтому по имени же определяется и таблица.
 */
type ActiveChecks = Map<string, string>;

describe('миграции данных не спорят с действующим CHECK', () => {
  it('ни один UPDATE не пишет значение, запрещённое ограничением на тот момент', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(files.length).toBeGreaterThan(20);

    const active: ActiveChecks = new Map();
    const violations: string[] = [];

    for (const file of files) {
      const sql = withoutComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      const declared = checksOf(sql);
      const dropped = dropsOf(sql);

      for (const assignment of assignmentsOf(sql)) {
        // Ограничение того же файла, снятое ДО этого UPDATE, уже не действует;
        // объявленное ПОСЛЕ — ещё не действует. Оба случая законны.
        const droppedHere = new Set(
          dropped.filter((drop) => drop.at < assignment.at).map((drop) => drop.name),
        );

        for (const [name, body] of active) {
          if (droppedHere.has(name)) continue;
          if (!name.startsWith(`${assignment.table}_`)) continue;
          const allowed = allowedValues(body, assignment.column);
          if (allowed === null) continue;
          if (allowed.includes(assignment.value)) continue;

          violations.push(
            `${file}: UPDATE ${assignment.table}.${assignment.column} = '${assignment.value}' ` +
              `при действующем ${name}, который такого значения не знает. ` +
              'На пустой базе проходит, на боевой — нет: снимите ограничение ДО UPDATE.',
          );
        }
      }

      // Состояние переносится на следующий файл: снятое исчезает, объявленное
      // появляется. Порядок внутри файла уже учтён выше.
      for (const drop of dropped) active.delete(drop.name);
      for (const check of declared) active.set(check.name, check.body);
    }

    expect(violations).toEqual([]);
  });

  it('разбор видит ту самую ошибку — иначе проверка ничего не значит', () => {
    // Положительный контроль: без него тест выше зеленел бы и при сломанном
    // разборе. Образец — ровно то, что уронило развёртывание S44.
    const before = checksOf(`CONSTRAINT findings_target_type_chk CHECK (target_type IN (
      'revision', 'document'));`);
    expect(allowedValues(before[0]?.body ?? '', 'target_type')).toEqual(['revision', 'document']);

    const assignment = assignmentsOf(
      `UPDATE findings SET target_type = 'folder' WHERE target_type = 'revision';`,
    )[0];
    expect(assignment?.value).toBe('folder');
    // Значение вне перечня — это и есть отказ боевой базы.
    expect(allowedValues(before[0]?.body ?? '', 'target_type')).not.toContain(assignment?.value);
  });

  it('сужение перечня ПОСЛЕ переписывания законно и не отмечается', () => {
    // Так сделана 0048: `frozen` → `superseded`, и лишь потом перечень без
    // `frozen`. Все записываемые значения старый CHECK уже разрешал.
    const body = "state in ('draft', 'frozen', 'superseded')";
    expect(allowedValues(body, 'state')).toContain('superseded');
    expect(allowedValues(body, 'state')).toContain('draft');
  });
});
