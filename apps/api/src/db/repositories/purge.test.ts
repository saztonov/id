/**
 * Полнота сброса производного — структурная проверка (S24).
 *
 * ## Почему список сверяется со схемой, а не проверяется наполнением
 *
 * Можно было заполнить сорок таблиц фикстурами и убедиться, что удаление
 * проходит. Такой тест доказывает, что СЕГОДНЯШНИЙ список работает, и молчит
 * ровно в том случае, ради которого он нужен: завтра кто-то добавит таблицу со
 * ссылкой на ревизию, забудет про `purge.ts`, и удаление комплекта упрётся в
 * внешний ключ — у пользователя, а не в тестах.
 *
 * Поэтому проверяется другое утверждение: **список покрывает весь подграф
 * внешних ключей, растущий вниз от `submission_revisions`**. Новая таблица
 * ломает этот тест в тот же день, когда появляется миграция, и сообщение прямо
 * называет, что именно не учтено.
 *
 * ## Что исключено и почему
 *
 * `doc_type_candidates` — обе его ссылки объявлены `ON DELETE SET NULL` (0003):
 * БД обнуляет их сама, а удалять накопленное знание каталога из-за исчезнувшего
 * комплекта было бы неверно.
 *
 * Таблицы за `STOP_TABLES` — это не потомки ревизии, а её соседи и родители
 * (`works`, `registries`, `users`, справочники). Обход не должен уходить в них:
 * `registries` ссылается на ревизию через `registry_items`, но сама папка
 * переживает удаление комплекта — из неё удаляется только членство.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import {
  DERIVED_DELETES,
  PIPELINE_RESET_DELETES,
  REGISTRY_DELETES,
  REVISION_DELETES,
} from './purge.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

/**
 * Границы обхода: родители и соседи ревизии, а не её потомки.
 *
 * `jobs` в списке потому, что задача живёт дольше ревизии по построению —
 * очередь общая на портал, и `job_runs` привязан к ревизии отдельной колонкой.
 */
const STOP_TABLES = new Set([
  'works',
  'registries',
  'users',
  'doc_types',
  'stored_blobs',
  'construction_objects',
  'counterparties',
  'sections',
  'jobs',
  'rule_definitions',
  'ruleset_versions',
  'prompt_templates',
  'error_issues',
]);

/** Таблицы, которые БД чистит сама через `ON DELETE SET NULL`. */
const SELF_CLEARING = new Set(['doc_type_candidates']);

let db: TestDatabase;

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    for (const statement of splitSqlStatements(migration.sql)) {
      await db.query(statement);
    }
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

it('список сброса покрывает весь подграф ссылок на ревизию', async () => {
  const edges = await db.query<{ child: string; parent: string }>(`
    select tc.table_name as child, ccu.table_name as parent
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
     group by 1, 2
  `);

  const children = new Map<string, Set<string>>();
  for (const { child, parent } of edges) {
    if (child === parent) continue;
    const bucket = children.get(parent) ?? new Set<string>();
    bucket.add(child);
    children.set(parent, bucket);
  }

  const reachable = new Set<string>();
  const walk = (table: string): void => {
    for (const child of children.get(table) ?? []) {
      if (STOP_TABLES.has(child) || reachable.has(child)) continue;
      reachable.add(child);
      walk(child);
    }
  };
  walk('submission_revisions');

  const covered = new Set([
    ...DERIVED_DELETES.map((step) => step.table),
    ...REVISION_DELETES.map((step) => step.table),
    ...SELF_CLEARING,
  ]);

  const missing = [...reachable].filter((table) => !covered.has(table)).sort();
  expect(
    missing,
    `Эти таблицы ссылаются на ревизию, но не удаляются в purge.ts: ${missing.join(', ')}. ` +
      'Добавьте их в DERIVED_DELETES или REVISION_DELETES в правильном месте порядка, ' +
      'иначе удаление комплекта упрётся в внешний ключ.',
  ).toEqual([]);
});

/**
 * То же утверждение для подграфа РЕЕСТРА (S37).
 *
 * Реестр — второй корень удаления в портале, и подграф у него свой: комплекты
 * состава реестром не держатся (`registry_id` обнуляется), а снимок состава и
 * прогоны сверки — держатся и удаление отвергнут.
 *
 * Ценность та же, что у первого теста: таблица, которая завтра сошлётся на
 * `registries`, ломает этот тест в день миграции, а не отказом внешнего ключа
 * у пользователя.
 */
it('список удаления реестра покрывает подграф ссылок на реестр', async () => {
  const edges = await db.query<{ child: string; parent: string }>(`
    select tc.table_name as child, ccu.table_name as parent
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
       and ccu.table_name = 'registries'
     group by 1, 2
  `);

  const children = new Set(
    edges.map((edge) => edge.child).filter((child) => child !== 'registries'),
  );

  /**
   * Чем закрыта каждая ссылка, кроме перечисленных в `REGISTRY_DELETES`.
   *
   * `works` — отвязкой: комплект переживает удаление папки, это и есть смысл
   * действия. Файл описи (`kind = 'registry'`) отвязать нельзя —
   * `works_registry_kind_chk`, — поэтому `deleteRegistry` удаляет его целиком
   * через `purgeRevisionEntirely`; таблица в списке та же.
   */
  const detached = new Set(['works']);

  const covered = new Set([...REGISTRY_DELETES.map((step) => step.table), ...detached]);
  const missing = [...children].filter((table) => !covered.has(table)).sort();

  expect(
    missing,
    `Эти таблицы ссылаются на реестр, но при удалении не обрабатываются: ${missing.join(', ')}. ` +
      'Добавьте их в REGISTRY_DELETES либо отвяжите явно в deleteRegistry.',
  ).toEqual([]);
});

it('в списке сброса нет таблиц, которых нет в схеме', async () => {
  // Обратная сторона: опечатка в имени таблицы дала бы `DELETE` по
  // несуществующему отношению — то есть отказ посреди транзакции удаления,
  // причём только на том комплекте, у которого дошло бы до этой строки.
  const tables = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const known = new Set(tables.map((row) => row.table_name));

  const unknown = [...DERIVED_DELETES, ...REVISION_DELETES, ...REGISTRY_DELETES]
    .map((step) => step.table)
    .filter((table) => !known.has(table));

  expect(unknown, `Нет таких таблиц: ${unknown.join(', ')}`).toEqual([]);
});

/**
 * Делит файл миграции на операторы.
 *
 * pglite исполняет запрос по расширенному протоколу и файл целиком не
 * принимает. Учитываются комментарии, кавычки и строки в долларах — тело
 * `deny_modification()` содержит и `;`, и `--`.
 */
function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const ch = sql.charAt(index);

    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (ch === "'") {
      const end = sql.indexOf("'", index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }

    const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
    if (tag !== null && !/[A-Za-z0-9_]/u.test(sql.charAt(index - 1))) {
      const marker = tag[0];
      const end = sql.indexOf(marker, index + marker.length);
      const stop = end === -1 ? sql.length : end + marker.length;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (ch === ';') {
      if (current.trim() !== '') statements.push(current.trim());
      current = '';
      index += 1;
      continue;
    }

    current += ch;
    index += 1;
  }

  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}

/**
 * Сброс конвейера — ПОДМНОЖЕСТВО того же порядка, а не второй список.
 *
 * Утверждение структурное, как и всё в этом файле: сценарный тест доказывал бы,
 * что сегодняшний список работает, и промолчал бы ровно тогда, когда нужен, — при
 * появлении новой таблицы ниже разметки. Два разошедшихся списка дают
 * `foreign key violation` посреди операции, объяснить который пользователю нечем.
 */
it('сброс конвейера сохраняет порядок DERIVED_DELETES и щадит разметку', () => {
  const derived = DERIVED_DELETES.map((step) => step.table);
  const reset = PIPELINE_RESET_DELETES.map((step) => step.table);

  // Порядок совпадает: подмножество получено фильтром, а не переписано руками.
  expect(reset).toEqual(derived.filter((table) => reset.includes(table)));

  // Разметка и рабочий документ переживают сброс — иначе «распознать заново
  // поверх той же разметки» означало бы «поверх никакой».
  const kept = derived.filter((table) => !reset.includes(table)).sort();
  expect(kept).toEqual([
    'layout_block_points',
    'layout_blocks',
    'layout_revisions',
    'processing_bundle_pages',
    'processing_bundles',
  ]);

  // Результаты распознавания уходят обязательно: `block_results.layout_block_id`
  // объявлен ON DELETE RESTRICT, и без их удаления переразметка упрётся в него.
  expect(reset).toContain('block_results');
  expect(reset).toContain('current_block_result');
  expect(reset).toContain('recognition_runs');
});
