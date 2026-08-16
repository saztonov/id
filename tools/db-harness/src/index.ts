/**
 * Тестовая БД для гейтов.
 *
 * По умолчанию — pglite (настоящий PostgreSQL, собранный в WASM): работает
 * в процессе Node без Docker и без внешних бинарников. `embedded-postgres`
 * не используется: у него нет ни одного стабильного релиза.
 *
 * Ограничение pglite — одно соединение. Тесты, которым нужна истинная
 * конкурентность (`FOR UPDATE SKIP LOCKED` двумя воркерами), должны
 * проверять `hasRealPostgres()` и пропускаться, когда её нет.
 */

/** Расширения, которые боевая БД получает вручную до миграций. */
export const REQUIRED_EXTENSIONS = ['pgcrypto', 'citext', 'pg_trgm'] as const;

export type RequiredExtension = (typeof REQUIRED_EXTENSIONS)[number];

/** Минимальный интерфейс тестовой БД, общий для pglite и настоящей PostgreSQL. */
export interface TestDatabase {
  readonly kind: 'pglite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * Задана ли строка подключения к настоящей PostgreSQL.
 * Тесты на конкурентность и на реальное применение миграций опираются на неё.
 */
export function hasRealPostgres(): boolean {
  return (
    typeof process.env['TEST_DATABASE_URL'] === 'string' && process.env['TEST_DATABASE_URL'] !== ''
  );
}

/**
 * Поднимает эфемерную БД в памяти на pglite и включает обязательные расширения.
 *
 * В pglite contrib-расширения не встроены в ядро: их бандлы подключаются
 * через опцию `extensions`, и только после этого `CREATE EXTENSION` находит
 * control-файл. Без этого запрос падает в `parse_extension_control_file`.
 */
export async function createPgliteDatabase(): Promise<TestDatabase> {
  const [{ PGlite }, { pgcrypto }, { citext }, { pg_trgm }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/contrib/pgcrypto'),
    import('@electric-sql/pglite/contrib/citext'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
  ]);

  const db = await PGlite.create({ extensions: { pgcrypto, citext, pg_trgm } });

  for (const ext of REQUIRED_EXTENSIONS) {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS ${ext};`);
  }

  return {
    kind: 'pglite',
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const res = await db.query<T>(sql, params as unknown[] | undefined);
      return res.rows;
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
