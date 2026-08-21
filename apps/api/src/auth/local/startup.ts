/**
 * Стартовые проверки локального режима (§25, production startup checks).
 *
 * Здесь НЕТ создания администратора. Заводить учётную запись побочным эффектом
 * старта нельзя по трём причинам: при нескольких репликах это гонка; пароль
 * приходится держать в переменной окружения, где он живёт вечно и превращается
 * в постоянный запасной вход; а забытая переменная делает такой вход
 * незаметным. Администратор создаётся отдельным шагом развёртывания —
 * `pnpm local-admin create`, — и это единственный способ.
 *
 * Старт лишь ПРОВЕРЯЕТ, что войти есть кому, и отказывается подниматься в
 * production, если некому: портал без администратора не чинится изнутри,
 * а обнаруживается это обычно в момент, когда чинить надо срочно.
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
