/**
 * Троттлинг попыток входа и регистрации (B.2 backoff, B.7 лимиты и блокировка).
 *
 * Хранилище — PostgreSQL, а не память процесса. Лимит, живущий в памяти,
 * перестаёт быть лимитом при второй реплике и обнуляется при перезапуске;
 * стандарт прямо разрешает PostgreSQL при умеренной нагрузке, и это тот случай.
 * Штатный `@fastify/rate-limit` остаётся вторым, более дешёвым слоем — он
 * отсекает шквал раньше, чем дело дойдёт до базы.
 *
 * Два пространства ключей в одной таблице: `login` (HMAC канонической формы
 * логина) и `ip-login` / `ip-register` (HMAC адреса). Разные `scope` не дают им
 * пересечься — иначе логин, совпавший по виду с адресом, делил бы счётчик с
 * этим адресом.
 *
 * Доступ идёт прямым параметризованным SQL, а не через scoped-репозиторий: у
 * аутентификации нет области видимости по определению — она эту область и
 * устанавливает (тот же довод, что в шапке `SessionStore`).
 */
import type { Pool, PoolClient } from 'pg';
import type { Env } from '../../config/env.js';

export type ThrottleScope = 'login' | 'ip-login' | 'ip-register';

export interface ThrottleState {
  readonly failedAttempts: number;
  /** `null` — можно пробовать прямо сейчас. */
  readonly retryAfterSeconds: number | null;
  readonly locked: boolean;
}

const FREE: ThrottleState = { failedAttempts: 0, retryAfterSeconds: null, locked: false };

/** Вероятность попутной уборки просроченных строк. */
const SWEEP_PROBABILITY = 0.01;

type ThrottleRow = {
  failed_attempts: number;
  next_attempt_at: Date | string | null;
  locked_until: Date | string | null;
};

interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function secondsUntil(value: Date | string | null): number | null {
  if (value === null) return null;
  const target = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(target)) return null;
  const seconds = Math.ceil((target - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}

function toState(row: ThrottleRow | undefined): ThrottleState {
  if (row === undefined) return FREE;

  const lockSeconds = secondsUntil(row.locked_until);
  const backoffSeconds = secondsUntil(row.next_attempt_at);
  // Из двух задержек берётся большая: блокировка не должна сниматься раньше
  // срока из-за того, что окно backoff уже истекло.
  const retryAfterSeconds =
    lockSeconds === null && backoffSeconds === null
      ? null
      : Math.max(lockSeconds ?? 0, backoffSeconds ?? 0);

  return {
    failedAttempts: row.failed_attempts,
    retryAfterSeconds,
    locked: lockSeconds !== null,
  };
}

/**
 * Текущее состояние ведра.
 *
 * Вызывается ДО обращения к учётным данным: иначе время ответа заблокированному
 * клиенту отличалось бы в зависимости от того, существует ли учётная запись.
 */
export async function loadThrottle(
  db: Queryable,
  scope: ThrottleScope,
  bucketKey: string,
): Promise<ThrottleState> {
  const { rows } = await db.query<ThrottleRow>(
    `select failed_attempts, next_attempt_at, locked_until
       from auth_throttle
      where scope = $1 and bucket_key = $2`,
    [scope, bucketKey],
  );
  return toState(rows[0]);
}

/**
 * Учёт неудачной попытки.
 *
 * Один атомарный upsert без чтения-модификации-записи: при параллельном переборе
 * две попытки читали бы одно значение и записывали одно и то же, то есть
 * счётчик отставал бы ровно тогда, когда он нужнее всего.
 *
 * Ключевая тонкость — сброс окна. Число попыток вычисляется ОДИН раз, в CTE, и
 * затем используется во всех трёх производных полях. Наивная версия обнуляла
 * `failed_attempts` в единицу, но считала `next_attempt_at` и `locked_until` из
 * прежнего значения: после снятой блокировки первая же ошибка нового окна снова
 * давала максимальную задержку и новую блокировку, то есть блокировка
 * становилась вечной.
 */
export async function registerFailure(
  db: Queryable,
  env: Env,
  input: {
    readonly scope: ThrottleScope;
    readonly bucketKey: string;
    readonly userId: string | null;
    readonly maxAttempts: number;
    readonly windowMinutes: number;
    /**
     * Применять ли экспоненциальную задержку между попытками.
     *
     * Только для ведра логина (B.2 говорит о backoff «по ключу email»). Для
     * ведра адреса задержка недопустима: за одним адресом сидит целый офис за
     * NAT, и одна опечатка коллеги блокировала бы вход всем остальным на
     * секунды, удваивающиеся с каждой их попыткой. Адрес ограничивается
     * лимитом попыток за окно, а не паузами.
     */
    readonly applyBackoff: boolean;
  },
): Promise<ThrottleState> {
  const { rows } = await db.query<ThrottleRow>(
    `with prior as (
       select failed_attempts, first_failed_at, window_expires_at,
              (window_expires_at < now()) as expired
         from auth_throttle
        where scope = $1 and bucket_key = $2
     ), computed as (
       select
         coalesce(case when p.expired then 1 else p.failed_attempts + 1 end, 1)
           as attempts,
         coalesce(case when p.expired then now() else p.first_failed_at end, now())
           as first_at,
         coalesce(
           case when p.expired then now() + make_interval(mins => $6::int)
                else p.window_expires_at end,
           now() + make_interval(mins => $6::int))
           as window_end
         from (select 1) as one
         left join prior p on true
     )
     insert into auth_throttle
       (scope, bucket_key, user_id, failed_attempts, first_failed_at, last_failed_at,
        next_attempt_at, locked_until, window_expires_at)
     select
       $1, $2, $3::uuid, c.attempts, c.first_at, now(),
       -- Экспоненциальный backoff от ТЕКУЩЕГО числа попыток: первая неудача — 1 с.
       case when $8::boolean
            then now() + make_interval(secs =>
                   least($4::int, power(2, least(c.attempts - 1, 20))::int))
       end,
       case when c.attempts >= $5::int then now() + make_interval(mins => $7::int) end,
       c.window_end
       from computed c
     on conflict (scope, bucket_key) do update set
       user_id           = coalesce(excluded.user_id, auth_throttle.user_id),
       failed_attempts   = excluded.failed_attempts,
       first_failed_at   = excluded.first_failed_at,
       last_failed_at    = excluded.last_failed_at,
       next_attempt_at   = excluded.next_attempt_at,
       -- Новое окно снимает прежнюю блокировку: истёкший lock иначе жил бы вечно.
       locked_until      = excluded.locked_until,
       window_expires_at = excluded.window_expires_at
     returning failed_attempts, next_attempt_at, locked_until`,
    [
      input.scope,
      input.bucketKey,
      input.userId,
      env.AUTH_LOCAL_BACKOFF_MAX_SECONDS,
      input.maxAttempts,
      input.windowMinutes,
      env.AUTH_LOCAL_LOCKOUT_MINUTES,
      input.applyBackoff,
    ],
  );

  return toState(rows[0]);
}

/** Успешная попытка обнуляет счёт: строка удаляется целиком. */
export async function clearThrottle(
  db: Queryable,
  scope: ThrottleScope,
  bucketKey: string,
): Promise<void> {
  await db.query('delete from auth_throttle where scope = $1 and bucket_key = $2', [
    scope,
    bucketKey,
  ]);
}

/**
 * Снятие блокировки администратором.
 *
 * Удаляет и строку, привязанную к пользователю, и строку по ключу логина:
 * первая появляется, только когда логин разрешился в существующего
 * пользователя, а перебор мог идти и до того, как учётная запись была создана.
 */
export async function unlock(
  db: Queryable,
  input: { readonly userId: string | null; readonly loginBucketKey: string | null },
): Promise<void> {
  if (input.userId !== null) {
    await db.query('delete from auth_throttle where user_id = $1::uuid', [input.userId]);
  }
  if (input.loginBucketKey !== null) {
    await clearThrottle(db, 'login', input.loginBucketKey);
  }
}

/**
 * Попутная уборка просроченных строк.
 *
 * Выполняется изредка прямо в обработчике, а не отдельной задачей воркера:
 * задачи обслуживания в воркере нет, и заводить её ради одной таблицы дороже,
 * чем один DELETE на сотню неудачных входов. Удаляются только строки с истёкшим
 * окном И снятой блокировкой — действующая блокировка обязана дожить до срока.
 */
export async function sweepExpired(db: Queryable, force = false): Promise<number> {
  if (!force && Math.random() >= SWEEP_PROBABILITY) return 0;

  const { rows } = await db.query<{ removed: string }>(
    `with removed as (
       delete from auth_throttle
        where window_expires_at < now() - interval '1 day'
          and (locked_until is null or locked_until < now())
        returning 1
     )
     select count(*)::text as removed from removed`,
  );
  return Number(rows[0]?.removed ?? '0');
}

/** Тип-помощник: и пул, и клиент транзакции подходят под `Queryable`. */
export type ThrottleDb = Pool | PoolClient;
