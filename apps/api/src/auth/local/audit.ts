/**
 * Журнал событий локальной аутентификации (§22, B.11).
 *
 * Отдельной таблицы `auth_events` нет: `audit_log` из миграции 0001 уже имеет
 * ровно нужные колонки — `actor_user_id` (допускающий NULL), `actor_email_hmac`,
 * `action`, `entity_type`, `entity_id`, `payload`, `ip`, `request_id` — и свои
 * индексы. Вторая таблица журнала означала бы второй источник правды: разбирая
 * инцидент, читать пришлось бы обе и сводить их по времени вручную.
 *
 * Запись идёт прямым `pool.query`, а не через `appendAuditLog`: тот требует
 * глобальной области видимости, а во время входа области ещё нет — она и
 * устанавливается по итогам входа. Образец — `recordClaimsMismatch` в
 * `auth/provisioning.ts`, включая явное указание типов параметров.
 *
 * Адрес пользователя не попадает в журнал открытым текстом НИКОГДА: ни в
 * `entity_id`, ни в `payload`. Событие неудачного входа по определению касается
 * строки, которую ввёл кто угодно, и складывать эти строки в юридически
 * значимый журнал значит собирать чужие ПДн по чужой воле.
 */
export type AuthAuditAction =
  | 'auth.login_success'
  | 'auth.login_failure'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'auth.account_locked'
  | 'auth.register_requested'
  | 'auth.register_duplicate'
  | 'auth.bootstrap_admin';

/**
 * Причина отказа во входе.
 *
 * Попадает в журнал, но НЕ в ответ клиенту: `unknown-login` и `bad-password`
 * снаружи неразличимы, иначе перебор адресов восстанавливал бы список учётных
 * записей. Администратор, разбирающий инцидент, разницу видеть обязан.
 */
export type LoginFailureReason =
  'unknown-login' | 'bad-password' | 'inactive' | 'locked' | 'throttled' | 'overloaded';

export interface AuthEvent {
  readonly action: AuthAuditAction;
  /** `null`, когда логин не разрешился в пользователя. */
  readonly actorUserId: string | null;
  /** HMAC канонической формы логина; `null`, если логина в событии нет. */
  readonly actorEmailHmac: string | null;
  readonly payload?: Record<string, unknown>;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

/**
 * Минимальный интерфейс исполнителя.
 *
 * Структурный тип, а не объединение `Pool | PoolClient`: у обоих `query`
 * перегружен, и объединение перегрузок TypeScript вызвать не даёт. Под этот
 * интерфейс подходят и пул, и клиент транзакции — событие входа обязано
 * записываться в той же транзакции, что и сам вход.
 */
export interface AuditDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const UA_LIMIT = 512;

export async function recordAuthEvent(db: AuditDb, event: AuthEvent): Promise<void> {
  const payload: Record<string, unknown> = { ...event.payload };
  if (event.userAgent != null && event.userAgent !== '') {
    // Колонки `user_agent` в audit_log нет; строка обрезается так же, как в
    // SessionStore, чтобы длинный заголовок не раздувал журнал.
    payload['ua'] = event.userAgent.slice(0, UA_LIMIT);
  }

  await db.query(
    // Типы параметров указаны явно: без них PostgreSQL выводит для одного
    // параметра сразу uuid и text и отвергает запрос (42P08).
    `insert into audit_log
       (actor_user_id, actor_email_hmac, action, entity_type, entity_id,
        payload, ip, request_id)
     values ($1::uuid, $2::text, $3::text, 'auth', $1::uuid::text,
             $4::jsonb, $5::inet, $6::text)`,
    [
      event.actorUserId,
      event.actorEmailHmac,
      event.action,
      JSON.stringify(payload),
      event.ip ?? null,
      event.requestId ?? null,
    ],
  );
}
