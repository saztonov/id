/**
 * TLS для node-postgres к Yandex Managed PostgreSQL.
 * Дублирует packages/db/src/pg-ssl.ts: migrator не зависит от @id/db
 * (там migrator уже в devDependencies — иначе цикл workspace).
 */
import { readFileSync } from 'node:fs';

export function pgConnectionOptions(
  databaseUrl: string,
  caCertPath?: string,
): { connectionString: string; ssl: { ca: string; rejectUnauthorized: true } | undefined } {
  const url = new URL(databaseUrl);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  return {
    connectionString: url.toString(),
    ssl: caCertPath
      ? { ca: readFileSync(caCertPath, 'utf8'), rejectUnauthorized: true }
      : undefined,
  };
}
