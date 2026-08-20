/**
 * TLS для node-postgres к Yandex Managed PostgreSQL.
 *
 * `sslmode` / `sslrootcert` из URL вычищаются: их понимает libpq, а node-pg — нет;
 * оставленные в connectionString параметры конфликтуют с объектом `ssl` и дают
 * «self-signed certificate in certificate chain». Режим TLS задаётся только через
 * `ssl` + CA из `PG_CA_CERT_PATH`.
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
