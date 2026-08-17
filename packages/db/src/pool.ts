/**
 * Пул соединений к PostgreSQL.
 *
 * Стандарт требует задавать предел числа соединений явно: на одной VPS живут
 * несколько порталов, и портал, забравший весь лимит managed-кластера, уронит
 * соседей. Значение по умолчанию сознательно скромное.
 */
import { Pool, type PoolConfig } from 'pg';
import { readFileSync } from 'node:fs';

export interface PoolOptions {
  readonly connectionString: string;
  /** Путь к корневому сертификату кластера. Без него TLS не проверяется. */
  readonly caCertPath?: string;
  /** Предел соединений. Стандарт требует задавать явно. */
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  /** Имя приложения в `pg_stat_activity` — без него источник запросов не найти. */
  readonly applicationName?: string;
}

const DEFAULT_MAX = 10;

export function createPool(options: PoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? DEFAULT_MAX,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    application_name: options.applicationName ?? 'id-portal',
    ...(options.caCertPath
      ? { ssl: { ca: readFileSync(options.caCertPath, 'utf8'), rejectUnauthorized: true } }
      : {}),
  };

  const pool = new Pool(config);

  // Без этого обработчика ошибка на простаивающем соединении (обрыв сети,
  // рестарт кластера) поднимается как unhandled и валит процесс целиком.
  pool.on('error', (err) => {
    console.error('Ошибка простаивающего соединения PostgreSQL:', err.message);
  });

  return pool;
}

/** Корректное закрытие: вызывается из graceful shutdown, требуемого стандартом. */
export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
