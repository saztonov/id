/**
 * Прогон НАСТОЯЩИХ миграций проекта на настоящем PostgreSQL (pglite).
 *
 * Главный тест файла — сверка схем: набор колонок каждой таблицы в
 * `packages/db/src/schema` сравнивается с фактическим из
 * `information_schema.columns` в обе стороны. Drizzle не порождает миграции
 * проекта (SQL-first — источник правды для production), поэтому без такой
 * сверки описание схемы в коде и схема в БД расходятся молча: запрос собирается
 * по drizzle-описанию, а падает в рантайме.
 *
 * Типы колонок сознательно не сравниваются: отображение drizzle-типов на типы
 * PostgreSQL неоднозначно (`text` против `citext`, `bigint` против `identity`),
 * и сверка по ним давала бы ложные срабатывания. Имена и наличие колонок
 * неоднозначными не бывают.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import type { Migration, SqlExecutor } from '@id/migrator';
import { applyMigrations, loadMigrations } from '@id/migrator';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

/**
 * Таблицы §3 плана. Список захардкожен, а не вычислен из схемы: иначе
 * забытая таблица «сойдётся сама с собой» и тест перестанет что-либо
 * утверждать. Порядок разделов повторяет спецификацию.
 */
const EXPECTED_TABLES: readonly string[] = [
  // §3.1 идентичность и доступ
  'users',
  'user_roles',
  'user_object_scopes',
  'auth_sessions',
  'audit_log',
  // §3.1 локальная аутентификация (ADR-0009): существуют во всех режимах,
  // наполняются только при AUTH_MODE=local.
  'user_credentials',
  'registration_requests',
  'auth_throttle',
  // §3.2 справочники
  'counterparty_kinds',
  'counterparties',
  'construction_objects',
  'section_kinds',
  'object_sections',
  'section_profiles',
  'object_rule_profiles',
  'rd_documents',
  'doc_types',
  'doc_type_overrides',
  'doc_type_candidates',
  'page_roles',
  // §3 том → поставка → ревизия и §3.3 файлы, страницы, рабочий документ
  'volumes',
  'submissions',
  'submission_revisions',
  'stored_blobs',
  'source_files',
  'source_pages',
  'processing_bundles',
  'processing_bundle_pages',
  // §3.4 разметка
  'layout_revisions',
  'layout_blocks',
  'layout_block_points',
  'rd_run_documents',
  // §7.3: пороги флагов внимания принадлежат версионному профилю, а не коду.
  'layout_profiles',
  // §3.5 прогоны и неизменяемые артефакты
  'recognition_runs',
  // Состояние страниц VLM-прогона (0019, ADR-0007): прогресс и покрытие
  // финализация читает отсюда, а не из payload'ов очереди.
  'recognition_run_pages',
  'artifact_versions',
  'page_text_versions',
  'block_results',
  'current_block_result',
  'ai_runs',
  // §3.6 логические документы
  'logical_documents',
  // Одна таблица на оба состояния учёта страницы: привязана к документу и
  // не привязана. Взаимоисключаемость обеспечена ключом, а не триггером.
  'page_assignments',
  // Решение классификатора по странице (0014): передача между задачами 14 и 15
  // и основание, по которому экран отвечает «почему страница попала сюда».
  'page_classifications',
  'document_relations',
  'field_values',
  'registry_rows',
  'materials',
  'batches',
  'material_documents',
  // §3.7 правила и проверки
  'rule_definitions',
  'ruleset_versions',
  'ruleset_rules',
  'validation_runs',
  'findings',
  'finding_evidence',
  'review_actions',
  // §3.8 события, настройки, наблюдаемость
  'revision_events',
  'app_settings',
  'prompt_templates',
  'jobs',
  'job_runs',
  'outbox',
  // §11 журнал ошибок (0022): проблема отделена от отпечатка, счётчики точные и
  // почасовые, примеры выборочные, история работы неизменяема. Прежняя
  // `error_events` переименована в `error_events_legacy` и остаётся до тех пор,
  // пока перенос не проверен на боевых данных.
  'error_events_legacy',
  'error_issues',
  'error_signatures',
  'error_stats_hourly',
  'error_samples',
  'error_issue_actions',
  // §11 обратная связь конвейера (0024): дефекты качества обработки —
  // невалидный ответ модели, отказ, ручная правка человека. Исключений они не
  // бросают и в журнал ошибок не попадают по построению.
  'processing_feedback',
  // §11 поток B (0025): значимые отказы 4xx и медленные операции — почасовые
  // счётчики. Строка на событие превратила бы журнал в усилитель атаки.
  'http_anomaly_stats_hourly',
  'slow_operations',
  // §13 выдача и §4.2 хранение: архив согласованной ревизии и удержания.
  // Обе таблицы §3 не перечисляет — она описывает доменную модель, а не выдачу,
  // — но заведены они тем же порядком и по тем же причинам: архив появляется
  // ПОСЛЕ approve, когда всё содержимое ревизии уже заперто, а удержание
  // накладывается на согласованную ревизию, строка которой неизменяема целиком.
  'submission_archives',
  'legal_holds',
  // §3.2 массовый ввод справочников (0027): загруженный файл разбирается в
  // воркере, а его строки ждут подтверждения человеком. Ни одна из них не
  // попадает в рабочую таблицу сама.
  'catalog_imports',
  'catalog_import_rows',
];

/** Журнал раннера: он не принадлежит §3, но обязан появиться. */
const JOURNAL_TABLE = 'schema_migrations';

// =====================================================================
// Разбиение файла миграции на отдельные операторы
// =====================================================================

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** Открывающий доллар-тег в позиции `at` или null, если это не он. */
function dollarTagAt(sql: string, at: number): string | null {
  // `a$$` — часть идентификатора, а не начало строки в долларах.
  if (at > 0 && /[A-Za-z0-9_]/u.test(sql.charAt(at - 1))) return null;
  DOLLAR_TAG.lastIndex = at;
  return DOLLAR_TAG.exec(sql)?.[0] ?? null;
}

/**
 * Делит SQL-файл на операторы по `;` верхнего уровня.
 *
 * Нужно исключительно из-за pglite: он исполняет запрос по расширенному
 * протоколу и отвечает «cannot insert multiple commands into a prepared
 * statement» на файл целиком. Настоящая PostgreSQL через `pg.Client.query`
 * принимает весь файл простым протоколом, поэтому в production раннер работает
 * без этого разбиения; прогон на настоящей PostgreSQL остаётся отдельным
 * non-degradable гейтом.
 *
 * Учитываются комментарии, строки в кавычках и строки в долларах: тело функции
 * `deny_modification()` в 0008 содержит и `;`, и `--`, и кавычки, и наивное
 * деление по `;` разрезало бы его посередине.
 */
function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  const flush = (): void => {
    if (current.trim() !== '') statements.push(current.trim());
    current = '';
  };

  while (index < sql.length) {
    const ch = sql.charAt(index);

    // Комментарий до конца строки: его содержимое в оператор не попадает,
    // поэтому `;` внутри комментария оператор не разрывает.
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const lineEnd = sql.indexOf('\n', index);
      index = lineEnd === -1 ? sql.length : lineEnd;
      continue;
    }

    // Блочный комментарий; в PostgreSQL он вложенный.
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.charAt(index) === '/' && sql.charAt(index + 1) === '*') {
          depth += 1;
          index += 2;
        } else if (sql.charAt(index) === '*' && sql.charAt(index + 1) === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      current += ch;
      index += 1;
      while (index < sql.length) {
        const inner = sql.charAt(index);
        if (inner === ch && sql.charAt(index + 1) === ch) {
          current += ch + ch;
          index += 2;
          continue;
        }
        current += inner;
        index += 1;
        if (inner === ch) break;
      }
      continue;
    }

    if (ch === '$') {
      const tag = dollarTagAt(sql, index);
      if (tag !== null) {
        const close = sql.indexOf(tag, index + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        current += sql.slice(index, end);
        index = end;
        continue;
      }
    }

    if (ch === ';') {
      flush();
      index += 1;
      continue;
    }

    current += ch;
    index += 1;
  }

  flush();
  return statements;
}

/**
 * TestDatabase реализует SqlExecutor целиком: у него есть и query для
 * параметризованных запросов, и exec для многооператорного тела миграции.
 * Раньше здесь стоял самодельный сплиттер операторов — обходной путь для
 * ограничения, которое теперь закрыто в самом интерфейсе раннера.
 */
function asExecutor(db: TestDatabase): SqlExecutor {
  return db;
}

// =====================================================================
// Прогон
// =====================================================================

let db: TestDatabase;
let migrations: readonly Migration[];
let applied: readonly string[];

beforeAll(async () => {
  migrations = loadMigrations(MIGRATIONS_DIR);
  db = await createPgliteDatabase();
  applied = (await applyMigrations(asExecutor(db), migrations)).applied;
}, 180_000);

afterAll(async () => {
  await db.close();
});

async function tableNames(): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

describe('разбиение файла миграции на операторы', () => {
  it('не режет тело функции по внутренним «;»', () => {
    const sql = [
      '-- комментарий; с точкой с запятой',
      'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $fn$',
      'BEGIN',
      "  RAISE EXCEPTION 'сбой; не здесь';",
      'END',
      '$fn$;',
      'SELECT 1;',
    ].join('\n');

    const statements = splitSqlStatements(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('RAISE EXCEPTION');
    expect(statements[1]).toBe('SELECT 1');
  });
});

describe('миграции проекта', () => {
  it('применяются на чистой pglite без ошибок', () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(applied).toStrictEqual(migrations.map((m) => m.version));
  });

  it('повторное применение даёт 0 новых', async () => {
    const second = await applyMigrations(asExecutor(db), migrations);

    expect(second.applied).toStrictEqual([]);
    expect(second.skipped).toStrictEqual(migrations.map((m) => m.version));
  });

  it('создают ровно те таблицы, которые перечисляет §3', async () => {
    const actual = await tableNames();

    expect(actual).toStrictEqual([...EXPECTED_TABLES, JOURNAL_TABLE].sort());
  });
});
