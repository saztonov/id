/**
 * Команды управления локальными учётными записями.
 *
 * Отдельно от точки входа (`cli.ts`): та выполняет команду при импорте и
 * потому непригодна для тестов — импорт уронил бы прогон на `process.exit`.
 *
 *     pnpm local-admin create --email admin@example.ru --name "Админов Админ"
 *     pnpm local-admin reset  --email admin@example.ru
 *     pnpm local-admin unlock --email admin@example.ru
 *
 * Почему это отдельный шаг развёртывания, а не побочный эффект старта API.
 * Создавать администратора при запуске нельзя по трём причинам: при нескольких
 * репликах это гонка; пароль пришлось бы держать в переменной окружения, где он
 * живёт вечно и превращается в постоянный запасной вход; а забытая переменная
 * делает такой вход незаметным. Порядок развёртывания — миграции, затем эта
 * команда, затем запуск API, который лишь ПРОВЕРЯЕТ, что войти есть кому.
 *
 * Пароль всегда генерирует сервер и печатает один раз. Принимать пароль
 * аргументом командной строки нельзя: он осел бы в истории оболочки и в
 * журнале процессов.
 */
import type { Pool } from 'pg';

import type { Env } from '../../config/env.js';
import { canonicalizeLogin, loginThrottleKey } from './canonical.js';
import { createCredential, findCredentialByLogin, resetPassword } from './credentials.js';
import { recordAuthEvent } from './audit.js';
import { hashPassword, randomPassword } from './passwords.js';
import { unlock } from './throttle.js';

export type Command = 'create' | 'reset' | 'unlock';

export interface Options {
  readonly command: Command;
  readonly email: string;
  readonly name: string | null;
}

/** Ошибка оператора, а не сбой: печатается сообщением, а не стеком. */
export class UsageError extends Error {}

export function parseArguments(argv: readonly string[]): Options {
  const [command, ...rest] = argv;
  if (command !== 'create' && command !== 'reset' && command !== 'unlock') {
    throw new UsageError('Команда: create | reset | unlock');
  }

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      throw new UsageError(`Непонятный аргумент: ${flag ?? ''}`);
    }
    values.set(flag.slice(2), value);
  }

  const email = values.get('email');
  if (email === undefined) throw new UsageError('Обязателен --email');
  if (values.has('password')) {
    // Пароль в аргументах осел бы в истории оболочки и в списке процессов, где
    // его прочитает любой пользователь машины.
    throw new UsageError('Пароль задать нельзя: он всегда генерируется и печатается один раз');
  }

  return { command, email, name: values.get('name') ?? null };
}

/**
 * Исполнение команды.
 *
 * Отдельно от точки входа и с явным пулом в аргументах: только так команду можно
 * прогнать тестом на настоящей базе. Скрипт с одним лишь `main()` проверялся бы
 * запуском процесса, то есть не проверялся бы вовсе.
 *
 * Возвращает строки для вывода, а не печатает сама: печать — дело точки входа.
 */
export async function runCommand(
  options: Options,
  env: Env,
  pool: Pool,
): Promise<readonly string[]> {
  const login = canonicalizeLogin(options.email);
  const existing = await findCredentialByLogin(pool, login);

  if (options.command === 'unlock') {
    if (existing === null) throw new UsageError(`Учётная запись ${login} не найдена`);
    await unlock(pool, { userId: existing.userId, loginBucketKey: loginThrottleKey(env, login) });
    return [`Блокировка снята: ${login}`];
  }

  if (options.command === 'reset') {
    if (existing === null) throw new UsageError(`Учётная запись ${login} не найдена`);
    const password = randomPassword();
    await resetPassword(pool, existing.userId, await hashPassword(env, password));
    return passwordReport(login, password);
  }

  // create
  if (existing !== null) {
    // Молча сменить пароль существующему администратору значит превратить
    // повторный запуск команды в тихий перехват чужой учётной записи.
    throw new UsageError(
      `Учётная запись ${login} уже существует. Для смены пароля: local-admin reset`,
    );
  }
  if (options.name === null) throw new UsageError('Обязателен --name при создании');

  const conflicting = await pool.query<{ id: string; kc_sub: string }>(
    'select id, kc_sub from users where email = $1',
    [login],
  );
  if (conflicting.rows.length > 0) {
    // Совпадение адреса с федеративной либо уже заведённой учётной записью
    // разрешает человек, а не скрипт: догадка здесь стоит чужого доступа.
    throw new UsageError(
      `Адрес ${login} уже занят пользователем ${conflicting.rows[0]?.id ?? ''} ` +
        `(kc_sub=${conflicting.rows[0]?.kc_sub ?? ''}). Разрешите совпадение вручную.`,
    );
  }

  const pendingRequest = await pool.query<{ id: string }>(
    `select id from registration_requests where login_key = $1 and status = 'pending'`,
    [login],
  );
  if (pendingRequest.rows.length > 0) {
    throw new UsageError(
      `На адрес ${login} подана заявка на регистрацию. Рассмотрите её в портале ` +
        'либо отклоните перед созданием администратора.',
    );
  }

  const password = randomPassword();
  const hash = await hashPassword(env, password);

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string }>(
      `insert into users (kc_sub, email, full_name, is_active)
       values ('local:' || gen_random_uuid(), $1, $2, true)
       returning id`,
      [options.email.trim(), options.name],
    );
    const userId = rows[0]?.id;
    if (userId === undefined) throw new Error('пользователь не создан');

    await createCredential(client, {
      userId,
      login: options.email,
      hash,
      mustChangePassword: true,
    });
    await client.query(`insert into user_roles (user_id, role) values ($1::uuid, 'admin')`, [
      userId,
    ]);
    await recordAuthEvent(client, {
      action: 'auth.bootstrap_admin',
      // Действие выполнено не пользователем портала, а оператором машины:
      // приписывать его кому-то из users было бы неправдой.
      actorUserId: null,
      actorEmailHmac: null,
      payload: { via: 'cli' },
    });
    await client.query('commit');

    return passwordReport(login, password);
  } catch (cause) {
    await client.query('rollback').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

function passwordReport(login: string, password: string): readonly string[] {
  return [
    '',
    `Учётная запись: ${login}`,
    `Временный пароль: ${password}`,
    '',
    'Пароль показан один раз и нигде не сохранён в открытом виде.',
    'Портал потребует сменить его при первом входе.',
    '',
  ];
}
