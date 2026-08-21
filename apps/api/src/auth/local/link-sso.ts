/**
 * Связывание локальных учётных записей с субъектами Keycloak.
 *
 *     pnpm link-sso --map ./sso-map.json --dry-run
 *     pnpm link-sso --map ./sso-map.json --apply
 *
 * Обязательное предусловие перехода с `AUTH_MODE=local` на `oidc`: без него
 * Keycloak вернёт свой `sub`, `provisionUser()` не найдёт совпадения с
 * `local:<uuid>` и заведёт ВТОРУЮ строку `users`. Роли, назначения на объекты,
 * привязка к подрядчику и вся история останутся у первой, а войдёт человек во
 * вторую, беспра́вную.
 *
 * Здесь только точка входа: разбор аргументов, подключение и печать. Логика — в
 * `link-sso-commands.ts`, чтобы её можно было прогнать тестом.
 */
import { createPool } from '@id/db';

import { EnvError, loadEnv } from '../../config/env.js';
import {
  applyPlan,
  buildPlan,
  parseArguments,
  readMapping,
  UsageError,
} from './link-sso-commands.js';

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const env = loadEnv();
  const mapping = await readMapping(options.map);

  // Путь к корневому сертификату передаётся так же, как в `buildApp`: команда
  // — шаг боевого развёртывания, а Managed PostgreSQL требует verify-full.
  // Без него скрипт не подключился бы ровно там, где он нужнее всего.
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 1,
    ...(env.PG_CA_CERT_PATH !== undefined ? { caCertPath: env.PG_CA_CERT_PATH } : {}),
    applicationName: 'id-portal-link-sso',
  });
  try {
    const plan = await buildPlan(pool, mapping);

    process.stdout.write(`Готовы к связыванию: ${String(plan.ready.length)}\n`);
    for (const { entry, userId } of plan.ready) {
      process.stdout.write(`  ${entry.login} → ${entry.subject} (users.id=${userId})\n`);
    }
    if (plan.problems.length > 0) {
      process.stdout.write(`\nПроблемы: ${String(plan.problems.length)}\n`);
      for (const problem of plan.problems) process.stdout.write(`  ${problem}\n`);
    }

    if (!options.apply) {
      process.stdout.write('\nПробный прогон: изменений не внесено. Для применения: --apply\n');
      return;
    }

    const linked = await applyPlan(pool, plan);
    process.stdout.write(`\nСвязано учётных записей: ${String(linked)}\n`);
    process.stdout.write('Теперь можно переключить AUTH_MODE на oidc.\n');
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  // Ошибка конфигурации для оператора — такое же сообщение, что и ошибка
  // аргументов: стек ему ничего не даёт, а список проблем окружения — даёт.
  if (error instanceof UsageError || error instanceof EnvError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  throw error;
}
