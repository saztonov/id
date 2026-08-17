/**
 * JIT-создание пользователя портала из claims Keycloak (§4.1).
 *
 * Отсюда заполняются только поля идентичности: `kc_sub`, `email`, `full_name`.
 * Ни `user_roles`, ни `user_object_scopes`, ни `users.contractor_id` здесь не
 * пишутся, и это не упущение, а требование: портал — единственный источник
 * бизнес-ролей и областей видимости. Если бы роль из токена попадала в
 * `user_roles`, администратор Keycloak получил бы право выдавать права в
 * портале, а отзыв прав в портале переставал бы что-либо значить.
 *
 * Следствие, которое нужно знать: свежесозданный пользователь входит, но не
 * видит ничего до того, как администратор выдаст ему роль. Это лучше, чем
 * догадываться о правах по токену.
 *
 * Профиль портала НЕ следует за claims. При первом входе взять ФИО и e-mail
 * больше негде, поэтому строка создаётся из токена. При последующих — нет:
 * `full_name` и `email` определяют, под какой личностью пользователь виден в
 * портале и в `audit_log` (`actor_email_hmac` считается от e-mail), а
 * управляет своими claims в Keycloak сам пользователь через self-service.
 * Безусловная перезапись означала бы, что подписантом действий в юридически
 * значимом журнале назначает себя тот, чьи действия журнал и фиксирует.
 * Проверено атакой: вход с подставленными `name` и `email` переписывал профиль.
 *
 * Расхождение при этом не проглатывается: оно пишется в `audit_log` действием
 * `identity.claims_mismatch`. Молча разойтись профиль портала и учётная запись
 * Keycloak не должны — смена фамилии в кадрах выглядит точно так же, как
 * попытка подмены, и различить их может только администратор.
 *
 * `kc_sub` — ключ связи и меняться не может: он единственная цель `on conflict`
 * и в `set` не входит. Пользователь с другим `kc_sub` — другой пользователь.
 */
import type { Pool } from 'pg';
import { userRoleSchema } from '@id/contracts';
import type { IdentityClaims } from './oidc.js';

export interface PortalUser {
  readonly id: string;
  readonly kcSub: string;
  readonly email: string | null;
  readonly fullName: string;
  readonly position: string | null;
  readonly isActive: boolean;
  readonly contractorId: string | null;
}

/** Поля профиля, которые заполняются из claims только при создании строки. */
export type ProfileField = 'full_name' | 'email';

export interface ProvisionResult {
  readonly user: PortalUser;
  /** Пользователь создан этим входом. Нужно для записи в `audit_log`. */
  readonly created: boolean;
  /**
   * Бизнес-роли, заявленные в токене и намеренно проигнорированные.
   *
   * Явная проверка требования §4.1: непустой список означает, что в Keycloak
   * кому-то выдали роль с именем бизнес-роли портала. Прав это не даёт, но
   * расхождение конфигураций стоит увидеть в журнале, а не через полгода.
   */
  readonly ignoredTokenRoles: readonly string[];
  /**
   * Поля профиля, в которых claims расходятся с порталом.
   *
   * Непустой список означает, что запись `identity.claims_mismatch` в
   * `audit_log` уже сделана; профиль при этом остался прежним.
   */
  readonly claimsMismatch: readonly ProfileField[];
}

/** Обстоятельства входа для записи в журнал. Оба поля необязательны. */
export interface ProvisionContext {
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/**
 * Поля пользователя, выводимые из claims.
 *
 * Тип намеренно не содержит ролей: их отсутствие в возвращаемой структуре —
 * причина, по которой роль из токена невозможно записать в БД «случайно».
 */
export interface UserIdentityFields {
  readonly kcSub: string;
  readonly email: string | null;
  readonly fullName: string;
}

export function userIdentityFields(claims: IdentityClaims): UserIdentityFields {
  return {
    kcSub: claims.subject,
    email: claims.email,
    fullName: claims.fullName ?? claims.preferredUsername ?? fallbackName(claims.subject),
  };
}

/** ФИО обязательно в схеме, а Keycloak может не отдать ни одного имени. */
function fallbackName(subject: string): string {
  return `Пользователь ${subject.slice(0, 8)}`;
}

const BUSINESS_ROLE_NAMES: readonly string[] = userRoleSchema.options;

/** Бизнес-роли портала, встретившиеся среди ролей токена. */
export function businessRolesClaimedInToken(claims: IdentityClaims): readonly string[] {
  const claimed = new Set<string>();
  for (const role of [...claims.realmRoles, ...claims.clientRoles]) {
    if (BUSINESS_ROLE_NAMES.includes(role)) claimed.add(role);
  }
  return [...claimed];
}

type UserRow = {
  id: string;
  kc_sub: string;
  email: string | null;
  full_name: string;
  position: string | null;
  is_active: boolean;
  contractor_id: string | null;
  created: boolean;
};

/** Действие журнала: claims Keycloak разошлись с профилем портала. */
export const CLAIMS_MISMATCH_ACTION = 'identity.claims_mismatch';

/**
 * Поля, в которых claims расходятся с профилем портала.
 *
 * Отсутствующий claim расхождением не считается: сравнивать не с чем. По той же
 * причине сравнение идёт с `claims.fullName`, а не с `userIdentityFields()`, —
 * подставное имя из `fallbackName()` провайдер ни о чём не заявлял.
 */
export function profileClaimsMismatch(
  claims: IdentityClaims,
  user: PortalUser,
): readonly ProfileField[] {
  const fields: ProfileField[] = [];
  if (claims.fullName !== null && claims.fullName !== user.fullName) fields.push('full_name');
  if (claims.email !== null && !sameEmail(claims.email, user.email)) fields.push('email');
  return fields;
}

/** `users.email` — citext, поэтому регистр различием не является. */
function sameEmail(claimed: string, stored: string | null): boolean {
  return stored !== null && claimed.toLowerCase() === stored.toLowerCase();
}

/**
 * Запись о расхождении.
 *
 * В `payload` идут только ИМЕНА полей. Значения из токена — строки, которыми
 * управляет владелец учётной записи, и место им не в юридически значимом
 * журнале: администратор и так видит обе стороны — профиль в портале и учётную
 * запись в Keycloak, — а вот произвольный текст в записи журнала не нужен ни
 * тому, кто её читает, ни тому, кто её потом предъявляет.
 */
async function recordClaimsMismatch(
  pool: Pool,
  userId: string,
  fields: readonly ProfileField[],
  context: ProvisionContext,
): Promise<void> {
  await pool.query(
    // Тип каждого использования $1 указан явно: без этого PostgreSQL выводит
    // для одного параметра сразу uuid и text и отвергает запрос (42P08).
    `insert into audit_log
       (actor_user_id, action, entity_type, entity_id, payload, ip, request_id)
     values ($1::uuid, $2, 'user', $1::uuid::text, $3::jsonb, $4::inet, $5)`,
    [
      userId,
      CLAIMS_MISMATCH_ACTION,
      JSON.stringify({ fields }),
      context.ip ?? null,
      context.requestId ?? null,
    ],
  );
}

/**
 * Идемпотентное создание либо обновление пользователя.
 *
 * При конфликте обновляются только отметки времени. `is_active` не трогается:
 * администратор отключил пользователя именно для того, чтобы вход его не
 * включал обратно. `contractor_id` тоже не трогается — привязка к организации
 * это бизнес-решение, а не свойство токена. `full_name` и `email` не трогаются
 * по причине, изложенной в начале файла.
 */
export async function provisionUser(
  pool: Pool,
  claims: IdentityClaims,
  context: ProvisionContext = {},
): Promise<ProvisionResult> {
  const fields = userIdentityFields(claims);

  const { rows } = await pool.query<UserRow>(
    `insert into users (kc_sub, email, full_name, last_login_at)
     values ($1, $2, $3, now())
     on conflict (kc_sub) do update
        set last_login_at = now(),
            updated_at = now()
     returning id, kc_sub, email, full_name, position, is_active, contractor_id,
               (xmax::text::bigint = 0) as created`,
    [fields.kcSub, fields.email, fields.fullName],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('Пользователь не создан: upsert не вернул строку');

  const user: PortalUser = {
    id: row.id,
    kcSub: row.kc_sub,
    email: row.email,
    fullName: row.full_name,
    position: row.position,
    isActive: row.is_active,
    contractorId: row.contractor_id,
  };

  // У созданной строки сравнивать не с чем: она и есть claims этого входа.
  const claimsMismatch = row.created ? [] : profileClaimsMismatch(claims, user);
  if (claimsMismatch.length > 0) {
    await recordClaimsMismatch(pool, user.id, claimsMismatch, context);
  }

  return {
    user,
    // xmax строки, вставленной этим запросом, равен нулю; у обновлённой строки
    // там остаётся xid блокировки. Отдельный SELECT дал бы гонку.
    created: row.created,
    ignoredTokenRoles: businessRolesClaimedInToken(claims),
    claimsMismatch,
  };
}
