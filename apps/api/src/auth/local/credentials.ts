/**
 * Учётные данные локального входа: таблица `user_credentials`.
 *
 * Прямой параметризованный SQL, а не scoped-репозиторий: у аутентификации нет
 * области видимости по определению — она эту область и устанавливает (тот же
 * довод, что в шапке `SessionStore`). Все запросы адресуют строку по первичному
 * ключу либо по уникальному `login_key` и данных ИД не читают.
 *
 * Наличие строки здесь и есть право входить паролем. Триггер миграции 0021 не
 * даёт завести строку федеративному пользователю, поэтому «локальность»
 * проверяется схемой, а не условием в каждом запросе.
 */
import type { Pool, PoolClient } from 'pg';

import { canonicalizeLogin } from './canonical.js';
import { PASSWORD_ALGORITHM, type PasswordHash } from './passwords.js';

export interface CredentialRecord {
  readonly userId: string;
  readonly loginKey: string;
  readonly loginDisplay: string;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly passwordChangedAt: Date;
}

/** Учётные данные вместе с состоянием пользователя: один запрос вместо двух. */
export interface CredentialWithUser extends CredentialRecord {
  readonly isActive: boolean;
  readonly fullName: string;
  readonly email: string | null;
  readonly contractorId: string | null;
}

export interface CredentialsDb {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** И пул, и клиент транзакции подходят. */
export type CredentialsExecutor = Pool | PoolClient;

type CredentialRow = {
  user_id: string;
  login_key: string;
  login_display: string;
  password_hash: string;
  must_change_password: boolean;
  password_changed_at: Date | string;
  is_active: boolean;
  full_name: string;
  email: string | null;
  contractor_id: string | null;
};

function toRecord(row: CredentialRow): CredentialWithUser {
  return {
    userId: row.user_id,
    loginKey: row.login_key,
    loginDisplay: row.login_display,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password,
    passwordChangedAt:
      row.password_changed_at instanceof Date
        ? row.password_changed_at
        : new Date(row.password_changed_at),
    isActive: row.is_active,
    fullName: row.full_name,
    email: row.email,
    contractorId: row.contractor_id,
  };
}

const SELECTION = `c.user_id, c.login_key, c.login_display, c.password_hash,
       c.must_change_password, c.password_changed_at,
       u.is_active, u.full_name, u.email, u.contractor_id`;

const FROM = `from user_credentials c
       join users u on u.id = c.user_id`;

/**
 * Поиск по логину.
 *
 * Значение канонизируется здесь же, а не полагается на вызывающего: забытая
 * канонизация нашла бы строку через `citext` (он и так регистронезависим), но
 * ключ троттлинга посчитался бы от другой формы — и блокировка обходилась бы
 * сменой регистра. Единая точка входа делает такую ошибку невозможной.
 */
export async function findCredentialByLogin(
  db: CredentialsDb,
  login: string,
): Promise<CredentialWithUser | null> {
  const { rows } = await db.query<CredentialRow>(
    `select ${SELECTION} ${FROM} where c.login_key = $1`,
    [canonicalizeLogin(login)],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function findCredentialByUserId(
  db: CredentialsDb,
  userId: string,
): Promise<CredentialWithUser | null> {
  const { rows } = await db.query<CredentialRow>(
    `select ${SELECTION} ${FROM} where c.user_id = $1::uuid`,
    [userId],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/** Занят ли логин действующей учётной записью. Регистр значения не имеет. */
export async function loginExists(db: CredentialsDb, login: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    'select true as exists from user_credentials where login_key = $1',
    [canonicalizeLogin(login)],
  );
  return rows.length > 0;
}

export interface CreateCredentialInput {
  readonly userId: string;
  /** Как ввёл пользователь: канонизация выполняется здесь. */
  readonly login: string;
  readonly hash: PasswordHash;
  readonly mustChangePassword: boolean;
}

export async function createCredential(
  db: CredentialsDb,
  input: CreateCredentialInput,
): Promise<void> {
  await db.query(
    `insert into user_credentials
       (user_id, login_key, login_display, password_hash, password_algorithm,
        must_change_password)
     values ($1::uuid, $2, $3, $4, $5, $6)`,
    [
      input.userId,
      canonicalizeLogin(input.login),
      input.login.trim(),
      input.hash.encoded,
      input.hash.algorithm,
      input.mustChangePassword,
    ],
  );
}

/**
 * Смена пароля со сверкой прежнего значения (compare-and-swap).
 *
 * `expectedHash` — то, что читал вызывающий перед проверкой. Без этой сверки
 * параллельный вход, решивший перехэшировать пароль, затирал бы административный
 * сброс: администратор выдал бы временный пароль, а пользователь продолжил бы
 * входить прежним, и никто бы этого не заметил.
 *
 * Возвращает `false`, если строка изменилась между чтением и записью — значит
 * решение принималось по устаревшим данным и его нужно принимать заново.
 */
export async function replacePassword(
  db: CredentialsDb,
  input: {
    readonly userId: string;
    readonly expectedHash: string;
    readonly hash: PasswordHash;
    readonly mustChangePassword: boolean;
  },
): Promise<boolean> {
  const { rows } = await db.query<{ user_id: string }>(
    `update user_credentials
        set password_hash = $3,
            password_algorithm = $4,
            password_changed_at = now(),
            must_change_password = $5,
            updated_at = now()
      where user_id = $1::uuid and password_hash = $2
      returning user_id`,
    [
      input.userId,
      input.expectedHash,
      input.hash.encoded,
      input.hash.algorithm,
      input.mustChangePassword,
    ],
  );
  return rows.length > 0;
}

/**
 * Безусловная установка пароля администратором.
 *
 * Сверки прежнего значения здесь нет намеренно: администратор сбрасывает пароль
 * именно потому, что прежний неизвестен или скомпрометирован, и «кто-то успел
 * его сменить» — не повод отменять сброс.
 *
 * `must_change_password` выставляется всегда: пароль, который знает кто-то
 * кроме владельца, обязан быть временным.
 */
export async function resetPassword(
  db: CredentialsDb,
  userId: string,
  hash: PasswordHash,
): Promise<boolean> {
  const { rows } = await db.query<{ user_id: string }>(
    `update user_credentials
        set password_hash = $2,
            password_algorithm = $3,
            password_changed_at = now(),
            must_change_password = true,
            updated_at = now()
      where user_id = $1::uuid
      returning user_id`,
    [userId, hash.encoded, hash.algorithm],
  );
  return rows.length > 0;
}

/**
 * Перехэширование при устаревших параметрах.
 *
 * Тоже compare-and-swap и тоже намеренно: перехэширование — оптимизация, и
 * проиграть гонку смене пароля для него совершенно нормально. Молча затереть
 * новый пароль старым — не нормально.
 */
export async function rehashPassword(
  db: CredentialsDb,
  userId: string,
  expectedHash: string,
  hash: PasswordHash,
): Promise<boolean> {
  const { rows } = await db.query<{ user_id: string }>(
    `update user_credentials
        set password_hash = $3, password_algorithm = $4, updated_at = now()
      where user_id = $1::uuid and password_hash = $2
      returning user_id`,
    [userId, expectedHash, hash.encoded, hash.algorithm],
  );
  return rows.length > 0;
}

export { PASSWORD_ALGORITHM };
