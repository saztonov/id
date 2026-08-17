/**
 * Раннер SQL-миграций.
 *
 * Стандарт (раздел 8) требует: SQL-first, версионированные файлы, источник
 * правды для production, отдельный deployment step, запуск НЕ из контейнеров
 * backend и worker, без `drizzle-kit push`, без `CREATE EXTENSION`, без правок
 * задним числом — исправление только новой миграцией.
 *
 * Отсюда две неочевидные обязанности раннера, помимо собственно применения:
 * он сверяет контрольные суммы уже применённых файлов (правка задним числом
 * должна быть замечена, а не тихо проигнорирована) и отказывается применять
 * миграцию, создающую расширение.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Минимальный интерфейс соединения: подходит и настоящему pg, и pglite.
 *
 * Два метода, а не один, из-за протоколов PostgreSQL. `query` работает через
 * расширенный протокол и допускает ровно один оператор — им идут запросы
 * с параметрами. Тело миграции содержит десятки операторов, и для него нужен
 * простой протокол: `exec`. На настоящем `pg` разница незаметна (клиент сам
 * выбирает простой протокол при отсутствии параметров), а pglite отвергает
 * многооператорный SQL в `query` с «cannot insert multiple commands into
 * a prepared statement».
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Многооператорный SQL без параметров: тело миграции. */
  exec(sql: string): Promise<void>;
}

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
  /**
   * Миграция выполняется вне транзакции.
   *
   * Нужна для операций, которые PostgreSQL запрещает в транзакционном блоке:
   * `CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` в старых версиях.
   * Помечается строкой `-- migrate:no-transaction` в начале файла. Цена —
   * частичное применение при сбое, поэтому такие миграции должны быть
   * идемпотентны.
   */
  readonly noTransaction: boolean;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Стандарт запрещает создавать расширения из миграций приложения. */
const FORBIDDEN = [
  { pattern: /\bCREATE\s+EXTENSION\b/i, reason: 'CREATE EXTENSION запрещён (раздел 8 стандарта)' },
  { pattern: /\bDROP\s+DATABASE\b/i, reason: 'DROP DATABASE недопустим в миграции' },
];

export function checksumOf(sql: string): string {
  // Переводы строк нормализуются: иначе checkout с CRLF на другой машине
  // объявил бы все применённые миргации изменёнными.
  return createHash('sha256').update(sql.replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}

/**
 * Читает миграции из каталога и проверяет их корректность.
 *
 * Падает при дубликате версии или разрыве нумерации: и то, и другое означает
 * неудачно слитые ветки, а порядок применения обязан быть однозначным.
 */
export function loadMigrations(dir: string): readonly Migration[] {
  const migrations: Migration[] = [];

  for (const fileName of readdirSync(dir).sort()) {
    if (!fileName.endsWith('.sql')) continue;

    const m = FILE_PATTERN.exec(fileName);
    if (!m) {
      throw new Error(`Имя миграции «${fileName}» не соответствует шаблону NNNN_имя_латиницей.sql`);
    }

    const sql = readFileSync(join(dir, fileName), 'utf8');
    for (const { pattern, reason } of FORBIDDEN) {
      if (pattern.test(sql)) throw new Error(`${fileName}: ${reason}`);
    }

    migrations.push({
      version: m[1] as string,
      name: m[2] as string,
      fileName,
      sql,
      checksum: checksumOf(sql),
      noTransaction: /^\s*--\s*migrate:no-transaction\s*$/mu.test(sql),
    });
  }

  const versions = migrations.map((x) => x.version);
  const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Дублирующиеся версии миграций: ${[...new Set(duplicates)].join(', ')}`);
  }

  migrations.forEach((mig, i) => {
    const expected = String(i + 1).padStart(4, '0');
    if (mig.version !== expected) {
      throw new Error(`Разрыв нумерации: ожидалась ${expected}, найдена ${mig.version}`);
    }
  });

  return migrations;
}

const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  name        text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user,
  duration_ms integer NOT NULL
)`;

interface JournalRow {
  version: string;
  name: string;
  checksum: string;
}

export interface MigrationStatus {
  readonly version: string;
  readonly name: string;
  readonly state: 'applied' | 'pending' | 'modified' | 'missing';
}

/** Читает состояние без изменений — безопасно вызывать на проде. */
export async function migrationStatus(
  db: SqlExecutor,
  migrations: readonly Migration[],
): Promise<readonly MigrationStatus[]> {
  await db.query(JOURNAL_DDL);
  const rows = await db.query<JournalRow>('SELECT version, name, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.version, r]));

  const statuses: MigrationStatus[] = migrations.map((mig) => {
    const row = applied.get(mig.version);
    if (!row) return { version: mig.version, name: mig.name, state: 'pending' };
    return {
      version: mig.version,
      name: mig.name,
      state: row.checksum === mig.checksum ? 'applied' : 'modified',
    };
  });

  // Записи в журнале, которым не соответствует файл: откат ветки или удаление
  // применённой миграции. Молчать об этом нельзя — схема БД и репозиторий разошлись.
  const known = new Set(migrations.map((x) => x.version));
  for (const [version, row] of applied) {
    if (!known.has(version)) {
      statuses.push({ version, name: row.name, state: 'missing' });
    }
  }

  return statuses.sort((a, b) => a.version.localeCompare(b.version));
}

export interface ApplyResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Применяет непринятые миграции по порядку.
 *
 * Каждая — в собственной транзакции вместе с записью в журнал: иначе сбой
 * между применением и отметкой оставил бы БД в состоянии, которое повторный
 * запуск попытался бы применить второй раз.
 */
export async function applyMigrations(
  db: SqlExecutor,
  migrations: readonly Migration[],
): Promise<ApplyResult> {
  const statuses = await migrationStatus(db, migrations);

  const modified = statuses.filter((s) => s.state === 'modified');
  if (modified.length > 0) {
    throw new Error(
      `Применённые миграции изменены задним числом: ${modified.map((s) => s.version).join(', ')}. ` +
        'Стандарт требует исправлять новой миграцией, а не правкой существующей.',
    );
  }

  const missing = statuses.filter((s) => s.state === 'missing');
  if (missing.length > 0) {
    throw new Error(
      `В журнале есть миграции без файлов: ${missing.map((s) => s.version).join(', ')}. ` +
        'Схема БД новее репозитория.',
    );
  }

  const pending = new Set(statuses.filter((s) => s.state === 'pending').map((s) => s.version));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const mig of migrations) {
    if (!pending.has(mig.version)) {
      skipped.push(mig.version);
      continue;
    }

    const started = Date.now();
    const journal = `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
                     VALUES ($1, $2, $3, $4)`;

    if (mig.noTransaction) {
      await db.exec(mig.sql);
      await db.query(journal, [mig.version, mig.name, mig.checksum, Date.now() - started]);
    } else {
      await db.query('BEGIN');
      try {
        await db.exec(mig.sql);
        await db.query(journal, [mig.version, mig.name, mig.checksum, Date.now() - started]);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw new Error(`Миграция ${mig.fileName} провалилась`, { cause: err });
      }
    }

    applied.push(mig.version);
  }

  return { applied, skipped };
}
