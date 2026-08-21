/**
 * Стартовые проверки локального режима (§25, production startup checks).
 *
 * Здесь НЕТ создания администратора, и это по-прежнему намеренно: заводить
 * учётную запись побочным эффектом старта нельзя, потому что при нескольких
 * репликах это гонка, а пароль пришлось бы держать в переменной окружения, где
 * он живёт вечно и превращается в незаметный запасной вход.
 *
 * Администратор приходит из seed-миграции (встроенный `admin`, ADR-0009), а
 * `pnpm local-admin` остаётся для смены пароля, разблокировки и восстановления,
 * если встроенную учётную запись удалили.
 *
 * Старт лишь ПРОВЕРЯЕТ, что войти есть кому. После seed проверка срабатывает
 * редко — только если администратора удалили, отключили или лишили пароля, — но
 * именно этот случай она и должна ловить: портал без администратора не чинится
 * изнутри, а обнаруживается это обычно в момент, когда чинить надо срочно.
 */
import type { Pool } from 'pg';

import type { Env } from '../../config/env.js';

export interface StartupLog {
  warn(details: Record<string, unknown>, message: string): void;
}

/**
 * Есть ли активный администратор с локальным паролем.
 *
 * Именно с паролем: администратор без учётных данных в локальном режиме войти
 * не может, поэтому для этой проверки его всё равно что нет.
 */
export async function hasLocalAdmin(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `select true as present
       from users u
       join user_roles r on r.user_id = u.id and r.role = 'admin'
       join user_credentials c on c.user_id = u.id
      where u.is_active
      limit 1`,
  );
  return rows.length > 0;
}

/**
 * Fail-fast в production, предупреждение в остальных окружениях.
 *
 * Разница намеренная. В production портал без администратора неработоспособен,
 * и запускать его значит откладывать обнаружение проблемы до первого обращения
 * пользователя. На стенде же пустая база — обычное состояние: разработчик
 * поднимает API, потом накатывает фикстуры, и падение старта мешало бы работе.
 */
export async function assertLocalAdminExists(pool: Pool, env: Env, log: StartupLog): Promise<void> {
  if (env.AUTH_MODE !== 'local') return;
  if (await hasLocalAdmin(pool)) return;

  const message =
    'AUTH_MODE=local: в портале нет активного администратора с локальным паролем. ' +
    'Выполните `pnpm local-admin create --email <адрес> --name "<ФИО>"` до запуска API.';

  if (env.NODE_ENV === 'production') throw new Error(message);
  log.warn({ authMode: env.AUTH_MODE }, message);
}
