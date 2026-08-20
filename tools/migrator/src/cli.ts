/**
 * Точка входа раннера миграций — отдельный deployment step.
 *
 * Стандарт запрещает запускать миграции из контейнеров backend и worker,
 * поэтому это самостоятельный воркспейс со своим образом и своим
 * пользователем БД: у него есть DDL-права, которых у runtime-пользователя
 * быть не должно.
 *
 *   pnpm --filter @id/migrator migrate           применить непринятые
 *   pnpm --filter @id/migrator migrate status    показать состояние, ничего не меняя
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { applyMigrations, loadMigrations, migrationStatus, type SqlExecutor } from './index.js';
import { pgConnectionOptions } from './pg-ssl.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Переменная окружения ${name} не задана`);
  return value;
}

/**
 * Оборачивает pg.Client в общий интерфейс.
 *
 * Тот же интерфейс реализует pglite, поэтому раннер и его тесты работают
 * с одним кодом: проверенное на тестах поведение — это ровно то поведение,
 * которое получит продакшн.
 */
function wrap(client: Client): SqlExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const res = await client.query(sql, params as unknown[] | undefined);
      return res.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      // Без параметров pg сам выбирает простой протокол, поэтому многооператорный
      // SQL проходит; отдельный метод нужен только ради общего интерфейса с pglite.
      await client.query(sql);
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const migrations = loadMigrations(MIGRATIONS_DIR);

  const { connectionString, ssl } = pgConnectionOptions(
    requireEnv('DATABASE_URL'),
    process.env['PG_CA_CERT_PATH'],
  );
  const client = new Client({
    connectionString,
    ...(ssl !== undefined ? { ssl } : {}),
  });

  await client.connect();
  const db = wrap(client);

  try {
    if (command === 'status') {
      const statuses = await migrationStatus(db, migrations);
      for (const s of statuses) {
        console.log(`  ${s.version}  ${s.state.padEnd(9)}  ${s.name}`);
      }
      const broken = statuses.filter((s) => s.state === 'modified' || s.state === 'missing');
      if (broken.length > 0) process.exitCode = 1;
      return;
    }

    if (command !== 'up') throw new Error(`Неизвестная команда «${command}». Доступны: up, status`);

    // Блокировка на уровне БД, а не файла: раннеров может быть несколько
    // (deployment и ручной запуск), и они не видят друг друга иначе.
    await db.query('SELECT pg_advisory_lock(hashtext($1))', ['id_portal_migrations']);
    try {
      const { applied, skipped } = await applyMigrations(db, migrations);
      console.log(`Применено: ${applied.length}, уже было: ${skipped.length}`);
      for (const v of applied) console.log(`  + ${v}`);
    } finally {
      await db.query('SELECT pg_advisory_unlock(hashtext($1))', ['id_portal_migrations']);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('Миграции не применены:', err);
  process.exitCode = 1;
});
