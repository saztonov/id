/**
 * Связывание локальных учётных записей с субъектами Keycloak: логика.
 *
 * Отдельно от точки входа (`link-sso.ts`), чтобы план и его применение можно
 * было прогнать тестом: импорт точки входа выполняет команду и завершает процесс.
 *
 * Зачем это нужно. Переключить `AUTH_MODE` с `local` на `oidc` мало: у локальной
 * учётной записи `kc_sub` имеет вид `local:<uuid>`, Keycloak вернёт СВОЙ `sub`,
 * и `provisionUser()` не найдёт совпадения — он заведёт ВТОРУЮ строку `users`.
 * Роли, назначения на объекты, привязка к подрядчику и вся история действий
 * останутся у первой, а войдёт человек во вторую, беспра́вную. Обнаруживается это
 * в день перехода, когда чинить надо срочно.
 *
 * Поэтому связывание — обязательное предусловие перехода, и оно явное:
 * соответствие «логин → субъект Keycloak» приходит файлом, который составил
 * человек. Автоматическое связывание по адресу запрещено: `users.email` не
 * уникален (в федерации два субъекта с одним адресом законны), а адрес в токене
 * никем не подтверждён — доверять ему значит отдавать учётную запись тому, кто
 * завёл в Keycloak нужный адрес.
 *
 * Формат файла:
 *
 *     [{ "login": "ivanov@example.ru", "subject": "8f0d1c2e-..." }, ...]
 */
import { readFile } from 'node:fs/promises';

import type { Pool } from 'pg';

import { canonicalizeLogin } from './canonical.js';

export interface MappingEntry {
  readonly login: string;
  readonly subject: string;
}

export interface Plan {
  readonly ready: readonly { entry: MappingEntry; userId: string }[];
  readonly problems: readonly string[];
}

/** Ошибка оператора, а не сбой: печатается сообщением, а не стеком. */
export class UsageError extends Error {}

export function parseArguments(argv: readonly string[]): { map: string; apply: boolean } {
  const values = new Map<string, string>();
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    if (flag === '--dry-run') continue;
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      throw new UsageError(`Непонятный аргумент: ${flag ?? ''}`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }

  const map = values.get('map');
  if (map === undefined) throw new UsageError('Обязателен --map <файл>');
  return { map, apply };
}

export async function readMapping(path: string): Promise<readonly MappingEntry[]> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new UsageError('Файл соответствия: ожидается массив');

  return parsed.map((item, index) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as MappingEntry).login !== 'string' ||
      typeof (item as MappingEntry).subject !== 'string'
    ) {
      throw new UsageError(`Запись ${String(index)}: ожидаются поля login и subject`);
    }
    const entry = item as MappingEntry;
    if (entry.subject.startsWith('local:')) {
      throw new UsageError(
        `Запись ${String(index)}: subject «${entry.subject}» — это местная заглушка, ` +
          'а не субъект Keycloak',
      );
    }
    return { login: canonicalizeLogin(entry.login), subject: entry.subject };
  });
}

/**
 * Сверка соответствия с базой БЕЗ изменений.
 *
 * Собираются ВСЕ проблемы, а не первая: связывание выполняется однажды и под
 * остановленным порталом, и список из десяти замечаний за один прогон лучше
 * десяти прогонов по одному.
 */
export async function buildPlan(pool: Pool, mapping: readonly MappingEntry[]): Promise<Plan> {
  const problems: string[] = [];
  const ready: { entry: MappingEntry; userId: string }[] = [];

  const seenSubjects = new Set<string>();
  const seenLogins = new Set<string>();
  for (const entry of mapping) {
    if (seenSubjects.has(entry.subject)) problems.push(`subject указан дважды: ${entry.subject}`);
    if (seenLogins.has(entry.login)) problems.push(`login указан дважды: ${entry.login}`);
    seenSubjects.add(entry.subject);
    seenLogins.add(entry.login);
  }

  for (const entry of mapping) {
    const { rows } = await pool.query<{ user_id: string; kc_sub: string; is_active: boolean }>(
      `select c.user_id, u.kc_sub, u.is_active
         from user_credentials c
         join users u on u.id = c.user_id
        where c.login_key = $1`,
      [entry.login],
    );
    const found = rows[0];
    if (found === undefined) {
      problems.push(`${entry.login}: локальной учётной записи нет`);
      continue;
    }
    if (!found.kc_sub.startsWith('local:')) {
      problems.push(`${entry.login}: уже связана с ${found.kc_sub}`);
      continue;
    }

    const taken = await pool.query<{ id: string }>('select id from users where kc_sub = $1', [
      entry.subject,
    ]);
    if (taken.rows.length > 0) {
      problems.push(
        `${entry.login}: subject ${entry.subject} уже занят пользователем ${taken.rows[0]?.id ?? ''}`,
      );
      continue;
    }

    ready.push({ entry, userId: found.user_id });
  }

  // Локальные учётные записи, которых нет в файле: после перехода они не смогут
  // войти вовсе. Это не всегда ошибка (уволенные), но узнать об этом надо ДО.
  const orphans = await pool.query<{ login_key: string }>(
    `select c.login_key
       from user_credentials c
       join users u on u.id = c.user_id
      where u.kc_sub like 'local:%' and u.is_active`,
  );
  for (const row of orphans.rows) {
    if (!seenLogins.has(row.login_key)) {
      problems.push(`${row.login_key}: активная локальная учётная запись отсутствует в файле`);
    }
  }

  return { ready, problems };
}

/**
 * Применение плана одной транзакцией.
 *
 * `users.id` СОХРАНЯЕТСЯ: вместе с ним сохраняются роли, назначения на объекты,
 * привязка к подрядчику и все ссылки из документов и журнала. Ради этого
 * связывание и существует — простое переключение режима завело бы вторую строку
 * `users` и оставило бы все назначения у первой.
 */
export async function applyPlan(pool: Pool, plan: Plan): Promise<number> {
  if (plan.problems.length > 0) {
    // Частично связанная база хуже несвязанной: часть людей войдёт в свои
    // учётные записи, часть — в пустые новые, и различить это потом нечем.
    throw new UsageError('Есть неразрешённые проблемы: связывание не выполнено.');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const { entry, userId } of plan.ready) {
      await client.query('update users set kc_sub = $2, updated_at = now() where id = $1::uuid', [
        userId,
        entry.subject,
      ]);
      // Локальный пароль удаляется: оставить его значит сохранить второй,
      // необнаружимый путь входа мимо Keycloak. Триггер миграции 0021 этого и
      // не допустил бы — строка перестала бы удовлетворять ограничению.
      await client.query('delete from user_credentials where user_id = $1::uuid', [userId]);
      await client.query(
        `insert into audit_log (actor_user_id, action, entity_type, entity_id, payload)
         values (null, 'user.sso_linked', 'user', $1::text, $2::jsonb)`,
        [userId, JSON.stringify({ subject: entry.subject })],
      );
    }
    await client.query('commit');
    return plan.ready.length;
  } catch (cause) {
    await client.query('rollback').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}
