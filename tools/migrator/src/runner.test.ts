/**
 * Тесты раннера миграций.
 *
 * Проверяется не «SQL применился», а обязанности, ради которых раннер вообще
 * написан: единственный порядок применения, отказ работать с историей, которая
 * разошлась с репозиторием, и транзакционность. Главный тест здесь —
 * «правка применённой миграции задним числом»: стандарт требует исправлять
 * новой миграцией, и молчаливое применение правки означало бы, что схема
 * production и схема репозитория тихо разъехались.
 *
 * Фиктивные миграции пишутся во временный каталог: тесты раннера не должны
 * зависеть от содержимого migrations/, иначе они стали бы тестами схемы.
 * База — настоящий PostgreSQL в WASM (pglite), потому что журнал, откат
 * транзакции и поведение при сбое внутри миграции на заглушке недоказуемы.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';

import {
  applyMigrations,
  checksumOf,
  loadMigrations,
  migrationStatus,
  type SqlExecutor,
} from './index.js';

/** Многострочная миграция: на однострочной проверка нечувствительности к CRLF пуста. */
const CREATE_PROBE = [
  'CREATE TABLE probe (',
  '  ord  bigint GENERATED ALWAYS AS IDENTITY,',
  '  mark text NOT NULL',
  ')',
].join('\n');

const THREE_MIGRATIONS: Readonly<Record<string, string>> = {
  '0001_probe_table.sql': CREATE_PROBE,
  '0002_second.sql': "INSERT INTO probe (mark) VALUES ('вторая')",
  '0003_third.sql': "INSERT INTO probe (mark) VALUES ('третья')",
};

const createdDirs: string[] = [];

/** Каталог с фиктивными миграциями; удаляется после файла тестов. */
function dirWith(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'id-migrator-'));
  createdDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, 'utf8');
  }
  return dir;
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createPgliteDatabase();
}, 120_000);

afterAll(async () => {
  await db.close();
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Пересоздание схемы, а не DELETE из журнала: тест на откат обязан видеть, что
// таблицы, созданной упавшей миграцией, нет, а не что её кто-то прибрал.
beforeEach(async () => {
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
});

describe('loadMigrations', () => {
  it.each([['1_foo.sql'], ['0001-foo.sql'], ['0001_Foo.sql'], ['0001_фу.sql']])(
    'отвергает имя не по шаблону: %s',
    (fileName) => {
      const dir = dirWith({ [fileName]: 'SELECT 1' });

      expect(() => loadMigrations(dir)).toThrow(/не соответствует шаблону/u);
    },
  );

  it('читает только .sql, остальные файлы каталога игнорирует', () => {
    const dir = dirWith({ '0001_first.sql': 'SELECT 1', 'README.md': 'заметка о миграциях' });

    expect(loadMigrations(dir).map((m) => m.fileName)).toStrictEqual(['0001_first.sql']);
  });

  it('отвергает разрыв нумерации', () => {
    const dir = dirWith({ '0001_first.sql': 'SELECT 1', '0003_third.sql': 'SELECT 1' });

    expect(() => loadMigrations(dir)).toThrow(/Разрыв нумерации: ожидалась 0002, найдена 0003/u);
  });

  it('отвергает дубликат версии', () => {
    const dir = dirWith({ '0001_first.sql': 'SELECT 1', '0001_other.sql': 'SELECT 1' });

    expect(() => loadMigrations(dir)).toThrow(/Дублирующиеся версии миграций: 0001/u);
  });

  it('отвергает CREATE EXTENSION: расширения включаются вне миграций приложения', () => {
    const dir = dirWith({ '0001_ext.sql': 'CREATE EXTENSION IF NOT EXISTS pg_jsonschema' });

    expect(() => loadMigrations(dir)).toThrow(/CREATE EXTENSION запрещён/u);
  });

  it('отвергает DROP DATABASE', () => {
    const dir = dirWith({ '0001_drop.sql': 'DROP DATABASE id_portal' });

    expect(() => loadMigrations(dir)).toThrow(/DROP DATABASE недопустим/u);
  });

  it('распознаёт пометку -- migrate:no-transaction', () => {
    const dir = dirWith({
      '0001_plain.sql': 'CREATE TABLE plain (x int)',
      '0002_concurrent.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY ix ON plain (x)',
    });

    expect(loadMigrations(dir).map((m) => m.noTransaction)).toStrictEqual([false, true]);
  });

  it('не принимает пометку, спрятанную в середине строки', () => {
    const dir = dirWith({
      '0001_plain.sql': 'CREATE TABLE plain (x int) -- migrate:no-transaction внутри строки',
    });

    expect(loadMigrations(dir)[0]?.noTransaction).toBe(false);
  });
});

describe('checksumOf', () => {
  it('нечувствителен к CRLF против LF', () => {
    expect(checksumOf(CREATE_PROBE.replaceAll('\n', '\r\n'))).toBe(checksumOf(CREATE_PROBE));
  });

  it('но чувствителен к содержимому', () => {
    expect(checksumOf('SELECT 1')).not.toBe(checksumOf('SELECT 2'));
  });
});

describe('applyMigrations', () => {
  it('применяет по порядку и записывает журнал', async () => {
    const migrations = loadMigrations(dirWith(THREE_MIGRATIONS));

    const result = await applyMigrations(db, migrations);

    expect(result).toStrictEqual({ applied: ['0001', '0002', '0003'], skipped: [] });
    // Порядок доказывается данными, а не отчётом: вставки 0002 и 0003 легли бы
    // в несуществующую таблицу, примени раннер их раньше 0001.
    const rows = await db.query<{ mark: string }>('SELECT mark FROM probe ORDER BY ord');
    expect(rows.map((r) => r.mark)).toStrictEqual(['вторая', 'третья']);

    const journal = await db.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    expect(journal).toStrictEqual(
      migrations.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })),
    );
  });

  it('повторный вызов ничего не применяет', async () => {
    const migrations = loadMigrations(dirWith(THREE_MIGRATIONS));
    await applyMigrations(db, migrations);

    const second = await applyMigrations(db, migrations);

    expect(second).toStrictEqual({ applied: [], skipped: ['0001', '0002', '0003'] });
    // Идемпотентность именно применения: вставки 0002 и 0003 не повторились.
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM probe');
    expect(rows[0]?.n).toBe(2);
  });

  it('перевод строк в уже применённом файле правкой не считается', async () => {
    await applyMigrations(db, loadMigrations(dirWith(THREE_MIGRATIONS)));

    const crlf = Object.fromEntries(
      Object.entries(THREE_MIGRATIONS).map(([name, sql]) => [name, sql.replaceAll('\n', '\r\n')]),
    );
    const migrations = loadMigrations(dirWith(crlf));

    // Checkout репозитория с core.autocrlf=true на другой машине не должен
    // объявлять применённые миграции изменёнными.
    await expect(applyMigrations(db, migrations)).resolves.toStrictEqual({
      applied: [],
      skipped: ['0001', '0002', '0003'],
    });
  });

  it('правка применённой миграции задним числом приводит к ошибке', async () => {
    await applyMigrations(db, loadMigrations(dirWith(THREE_MIGRATIONS)));

    const edited = loadMigrations(
      dirWith({
        ...THREE_MIGRATIONS,
        '0002_second.sql': "INSERT INTO probe (mark) VALUES ('подменённая')",
      }),
    );

    await expect(applyMigrations(db, edited)).rejects.toThrow(
      /Применённые миграции изменены задним числом: 0002/u,
    );
    // Правка не должна ни примениться, ни изменить журнал.
    const rows = await db.query<{ mark: string }>('SELECT mark FROM probe ORDER BY ord');
    expect(rows.map((r) => r.mark)).toStrictEqual(['вторая', 'третья']);
    await expect(migrationStatus(db, edited)).resolves.toStrictEqual([
      { version: '0001', name: 'probe_table', state: 'applied' },
      { version: '0002', name: 'second', state: 'modified' },
      { version: '0003', name: 'third', state: 'applied' },
    ]);
  });

  it('запись в журнале без файла приводит к ошибке', async () => {
    await applyMigrations(db, loadMigrations(dirWith(THREE_MIGRATIONS)));

    // Откат ветки: схема БД новее репозитория, и применять «недостающее» нельзя.
    const truncated = loadMigrations(
      dirWith({
        '0001_probe_table.sql': CREATE_PROBE,
        '0002_second.sql': THREE_MIGRATIONS['0002_second.sql'] as string,
      }),
    );

    await expect(applyMigrations(db, truncated)).rejects.toThrow(
      /В журнале есть миграции без файлов: 0003/u,
    );
    await expect(migrationStatus(db, truncated)).resolves.toContainEqual({
      version: '0003',
      name: 'third',
      state: 'missing',
    });
  });

  it('падение внутри миграции откатывает транзакцию, и журнал не пополняется', async () => {
    const migrations = loadMigrations(
      dirWith({
        '0001_base.sql': 'CREATE TABLE kept (x int)',
        // Один оператор, а внутри — и создание таблицы, и сбой: доказать откат
        // можно только тем, что созданного в той же транзакции не осталось.
        '0002_broken.sql':
          "DO $$ BEGIN CREATE TABLE ghost (x int); RAISE EXCEPTION 'сбой миграции'; END $$",
        '0003_never.sql': 'CREATE TABLE never_created (x int)',
      }),
    );

    await expect(applyMigrations(db, migrations)).rejects.toThrow(/0002_broken\.sql провалилась/u);

    const tables = await db.query<{
      kept: string | null;
      ghost: string | null;
      never: string | null;
    }>(
      `SELECT to_regclass('kept')::text AS kept,
              to_regclass('ghost')::text AS ghost,
              to_regclass('never_created')::text AS never`,
    );
    expect(tables[0]).toStrictEqual({ kept: 'kept', ghost: null, never: null });

    const journal = await db.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(journal.map((r) => r.version)).toStrictEqual(['0001']);
  });

  it('миграция с пометкой no-transaction применяется вне транзакции', async () => {
    const migrations = loadMigrations(
      dirWith({
        '0001_plain.sql': 'CREATE TABLE plain (x int)',
        '0002_nt.sql': '-- migrate:no-transaction\nCREATE TABLE nt (x int)',
      }),
    );

    const calls: string[] = [];
    const recorder: SqlExecutor = {
      query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        calls.push(sql.trim());
        return db.query<T>(sql, params);
      },
      // Тело миграции идёт через exec, поэтому записывать надо оба метода:
      // иначе проверка «обычная миграция обёрнута в транзакцию» смотрела бы
      // на неполный журнал вызовов.
      exec(sql: string): Promise<void> {
        calls.push(sql.trim());
        return db.exec(sql);
      },
    };

    await applyMigrations(recorder, migrations);

    // Обычная миграция обёрнута в транзакцию, помеченная — нет.
    expect(calls.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    expect(calls.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    // Но в журнал попадают обе: отсутствие транзакции не отменяет учёта.
    const journal = await db.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(journal.map((r) => r.version)).toStrictEqual(['0001', '0002']);
  });
});
