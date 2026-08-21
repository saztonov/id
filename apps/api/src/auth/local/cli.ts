/**
 * Управление локальными учётными записями из командной строки.
 *
 *     pnpm local-admin create --email admin@example.ru --name "Админов Админ"
 *     pnpm local-admin reset  --email admin@example.ru
 *     pnpm local-admin unlock --email admin@example.ru
 *
 * Здесь только точка входа: разбор аргументов, подключение и печать. Сама
 * логика — в `cli-commands.ts`, чтобы её можно было прогнать тестом: импорт
 * этого файла выполняет команду и завершает процесс.
 */
import { createPool } from '@id/db';

import { EnvError, loadEnv } from '../../config/env.js';
import { parseArguments, runCommand, UsageError } from './cli-commands.js';

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const env = loadEnv();

  if (env.AUTH_MODE !== 'local') {
    throw new UsageError(
      `AUTH_MODE=${env.AUTH_MODE}: локальными учётными данными портал в этом режиме не ` +
        'распоряжается',
    );
  }

  // Путь к корневому сертификату передаётся так же, как в `buildApp`: команда
  // — шаг боевого развёртывания, а Managed PostgreSQL требует verify-full.
  // Без него скрипт не подключился бы ровно там, где он нужнее всего.
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 1,
    ...(env.PG_CA_CERT_PATH !== undefined ? { caCertPath: env.PG_CA_CERT_PATH } : {}),
    applicationName: 'id-portal-local-admin',
  });
  try {
    for (const line of await runCommand(options, env, pool)) {
      process.stdout.write(`${line}
`);
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  // Ошибка конфигурации для оператора — такое же сообщение, что и ошибка аргументов:
  // стек ему ничего не даёт, а список проблем окружения — даёт.
  if (error instanceof UsageError || error instanceof EnvError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  throw error;
}
