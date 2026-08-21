/**
 * Администрирование локальных учётных записей (`AUTH_MODE=local`).
 *
 * Регистрируется из `modules/admin/routes.ts` только в этом режиме и целиком
 * живёт под правом `users.manage`. Отдельного права не заводится: `users.manage`
 * уже принадлежит только роли `admin`, а новая запись в матрице потребовала бы
 * синхронизации ДВУХ копий — серверной и клиентской — ради различия, которого
 * нет.
 *
 * Одно правило проходит через весь файл: **пароль, назначаемый администратором,
 * всегда генерирует сервер и всегда временный**. Поля `password` в теле запросов
 * нет вовсе. Администратор, задающий пользователю известный себе пароль,
 * получает возможность действовать от его имени, и никакой журнал этого не
 * различит; сгенерированный пароль показывается один раз и обязан быть сменён
 * при первом входе.
 */
import { z } from 'zod';
import type { PoolClient } from 'pg';

import type { AppInstance } from '../../app.js';
import { auditEmailHmac, listUserObjectScopes } from '../../db/repositories/admin.js';
import { findUserById } from '../../db/repositories/users.js';
import { conflict, notFound, unprocessable } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import {
  userCardResponseSchema,
  userRolesBodySchema,
  userSummaryResponseSchema,
} from '../../modules/admin/schemas.js';
import { recordAuthEvent } from './audit.js';
import { canonicalizeLogin, loginThrottleKey } from './canonical.js';
import { createCredential, loginExists, resetPassword } from './credentials.js';
import { hashPassword, randomPassword } from './passwords.js';
import { unlock } from './throttle.js';

const PREFIX = '/api/v1/admin';

const uuidParams = z.object({ id: z.uuid() });

/**
 * Ответ с одноразовым паролем.
 *
 * Значение возвращается ровно один раз и нигде не журналируется: ключ
 * `temporaryPassword` внесён в список редактируемых полей логгера.
 */
const temporaryPasswordSchema = z.object({ temporaryPassword: z.string() });

const registrationRequestSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  position: z.string().nullable(),
  createdAt: z.string(),
  /** Заявитель выбрал пароль сам. Влияет на выбор действия при одобрении. */
  hasRequestedPassword: z.boolean(),
});

type RequestRow = {
  id: string;
  login_display: string;
  login_key: string;
  full_name: string;
  position: string | null;
  created_at: Date | string;
  password_hash: string | null;
  password_algorithm: string | null;
};

export function registerLocalAdminRoutes(app: AppInstance): void {
  const manage = requirePermission('users.manage');
  const { env } = app;

  // =====================================================================
  // Создание пользователя
  // =====================================================================

  app.post(
    `${PREFIX}/users`,
    {
      schema: {
        body: z.object({
          email: z.email().max(320),
          fullName: z.string().trim().min(2).max(256),
          position: z.string().trim().max(256).optional(),
          contractorId: z.uuid().nullable().optional(),
          roles: userRolesBodySchema.shape.roles.optional(),
          isActive: z.boolean().optional(),
        }),
        response: {
          201: userCardResponseSchema.extend(temporaryPasswordSchema.shape),
        },
      },
      preHandler: manage,
    },
    async (request, reply) => {
      const { email, fullName, position, contractorId, roles, isActive } = request.body;
      const login = canonicalizeLogin(email);

      if (await loginExists(app.pool, login)) {
        throw conflict('Пользователь с таким адресом уже заведён.');
      }
      assertRolesConsistent(roles ?? [], contractorId ?? null);

      const password = randomPassword();
      const hash = await hashPassword(env, password);

      const userId = await withTransaction(app, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into users (kc_sub, email, full_name, position, contractor_id, is_active)
           values ('local:' || gen_random_uuid(), $1, $2, $3, $4::uuid, $5)
           returning id`,
          [email.trim(), fullName, position ?? null, contractorId ?? null, isActive ?? true],
        );
        const created = rows[0]?.id;
        if (created === undefined) throw new Error('пользователь не создан');

        await createCredential(tx, {
          userId: created,
          login: email,
          hash,
          // Пароль знает не только владелец, поэтому он временный по определению.
          mustChangePassword: true,
        });
        for (const role of roles ?? []) {
          await tx.query('insert into user_roles (user_id, role) values ($1::uuid, $2)', [
            created,
            role,
          ]);
        }
        return created;
      });

      await auditAdminAction(app, request, 'user.created', userId, {
        roles: roles ?? [],
        isActive: isActive ?? true,
      });

      const card = await loadCard(app, request, userId);
      return reply.code(201).send({ ...card, temporaryPassword: password });
    },
  );

  // =====================================================================
  // Сброс пароля
  // =====================================================================

  app.post(
    `${PREFIX}/users/:id/password`,
    {
      schema: { params: uuidParams, response: { 200: temporaryPasswordSchema } },
      preHandler: manage,
    },
    async (request, reply) => {
      const userId = request.params.id;
      const password = randomPassword();
      const hash = await hashPassword(env, password);

      const replaced = await resetPassword(app.pool, userId, hash);
      if (!replaced) throw notFound('У пользователя нет локальных учётных данных.');

      // Прежние сессии обесцениваются: сброс пароля выполняется, когда прежний
      // скомпрометирован, и оставить живую сессию значит не выполнить сброс.
      await app.sessions.revokeAllForUser(userId);
      await auditAdminAction(app, request, 'user.password_reset', userId, {});

      return reply.code(200).send({ temporaryPassword: password });
    },
  );

  // =====================================================================
  // Снятие блокировки
  // =====================================================================

  app.post(
    `${PREFIX}/users/:id/unlock`,
    {
      schema: { params: uuidParams, response: { 200: userCardResponseSchema } },
      preHandler: manage,
    },
    async (request) => {
      const userId = request.params.id;

      const { rows } = await app.pool.query<{ login_key: string }>(
        'select login_key from user_credentials where user_id = $1::uuid',
        [userId],
      );
      const loginKey = rows[0]?.login_key;

      await unlock(app.pool, {
        userId,
        // Перебор мог идти по адресу ещё до того, как учётная запись появилась:
        // та строка не привязана к пользователю и снимается только по ключу.
        loginBucketKey: loginKey === undefined ? null : loginThrottleKey(env, loginKey),
      });
      await auditAdminAction(app, request, 'user.unlocked', userId, {});

      return loadCard(app, request, userId);
    },
  );

  // =====================================================================
  // Заявки на регистрацию
  // =====================================================================

  app.get(
    `${PREFIX}/registration-requests`,
    {
      schema: { response: { 200: z.object({ items: z.array(registrationRequestSchema) }) } },
      preHandler: manage,
    },
    async () => {
      const { rows } = await app.pool.query<RequestRow>(
        `select id, login_display, login_key, full_name, position, created_at,
                password_hash, password_algorithm
           from registration_requests
          where status = 'pending'
          order by created_at asc
          limit 500`,
      );
      return { items: rows.map(toRequestResponse) };
    },
  );

  app.post(
    `${PREFIX}/registration-requests/:id/approve`,
    {
      schema: {
        params: uuidParams,
        body: z.object({
          roles: userRolesBodySchema.shape.roles,
          contractorId: z.uuid().nullable().optional(),
          objectIds: z.array(z.uuid()).max(500).optional(),
          /**
           * Чем закрыть учётную запись.
           *
           * `temporary` — сервер выдаёт одноразовый пароль, который надо
           * передать человеку вне портала. Это и есть подтверждение личности:
           * адрес при регистрации никто не проверял, и заявку мог подать кто
           * угодно на чужой адрес.
           *
           * `as-requested` — принять пароль, выбранный заявителем. Допустимо,
           * когда личность подтверждена иначе; выбор пишется в журнал.
           */
          credential: z.enum(['temporary', 'as-requested']),
        }),
        response: {
          201: userCardResponseSchema.extend({ temporaryPassword: z.string().nullable() }),
        },
      },
      preHandler: manage,
    },
    async (request, reply) => {
      const { rows } = await app.pool.query<RequestRow>(
        `select id, login_display, login_key, full_name, position, created_at,
                password_hash, password_algorithm
           from registration_requests
          where id = $1::uuid and status = 'pending'`,
        [request.params.id],
      );
      const pending = rows[0];
      if (pending === undefined) throw notFound('Заявка не найдена или уже рассмотрена.');

      const { roles, contractorId, objectIds, credential } = request.body;
      assertRolesConsistent(roles, contractorId ?? null);

      if (credential === 'as-requested' && pending.password_hash === null) {
        throw conflict('Заявка подана без пароля: выдайте временный.');
      }
      if (await loginExists(app.pool, pending.login_key)) {
        throw conflict('Пользователь с таким адресом уже заведён.');
      }

      const temporaryPassword = credential === 'temporary' ? randomPassword() : null;
      const hash =
        temporaryPassword === null
          ? { algorithm: 'scrypt' as const, encoded: pending.password_hash ?? '' }
          : await hashPassword(env, temporaryPassword);

      const auth = currentAuth(request);
      const userId = await withTransaction(app, async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `insert into users (kc_sub, email, full_name, position, contractor_id, is_active)
           values ('local:' || gen_random_uuid(), $1, $2, $3, $4::uuid, true)
           returning id`,
          [pending.login_display, pending.full_name, pending.position, contractorId ?? null],
        );
        const created = inserted.rows[0]?.id;
        if (created === undefined) throw new Error('пользователь не создан');

        await createCredential(tx, {
          userId: created,
          login: pending.login_display,
          hash,
          // Пароль, выданный администратором, обязан быть сменён; выбранный
          // самим заявителем менять незачем — его знает только он.
          mustChangePassword: temporaryPassword !== null,
        });
        for (const role of roles) {
          await tx.query('insert into user_roles (user_id, role) values ($1::uuid, $2)', [
            created,
            role,
          ]);
        }
        for (const objectId of objectIds ?? []) {
          await tx.query(
            'insert into user_object_scopes (user_id, object_id) values ($1::uuid, $2::uuid)',
            [created, objectId],
          );
        }
        await tx.query(
          `update registration_requests
              set status = 'approved', decided_at = now(), decided_by = $2::uuid,
                  created_user_id = $3::uuid,
                  -- Хэш из заявки больше не нужен: он переехал в учётные данные
                  -- либо заменён временным паролем.
                  password_hash = null, password_algorithm = null
            where id = $1::uuid`,
          [pending.id, auth.user.id, created],
        );
        return created;
      });

      await auditAdminAction(app, request, 'registration.approved', userId, {
        credential,
        roles,
      });

      const card = await loadCard(app, request, userId);
      return reply.code(201).send({ ...card, temporaryPassword });
    },
  );

  app.post(
    `${PREFIX}/registration-requests/:id/reject`,
    {
      schema: {
        params: uuidParams,
        body: z.object({ reason: z.string().trim().max(512).optional() }),
        response: { 200: z.object({ rejected: z.literal(true) }) },
      },
      preHandler: manage,
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      // `returning`, а не `rowCount`: признак «строка была затронута»
      // выражается возвращённой строкой — тот же приём, что в `setUserActive`.
      // Число затронутых строк драйвер сообщает по-разному, и полагаться на него
      // значит получить разное поведение на разных исполнителях.
      const { rows } = await app.pool.query<{ id: string }>(
        `update registration_requests
            set status = 'rejected', decided_at = now(), decided_by = $2::uuid,
                password_hash = null, password_algorithm = null
          where id = $1::uuid and status = 'pending'
        returning id`,
        [request.params.id, auth.user.id],
      );
      if (rows.length === 0) throw notFound('Заявка не найдена или уже рассмотрена.');

      await auditAdminAction(app, request, 'registration.rejected', request.params.id, {
        // Причина — свободный текст администратора, а не заявителя, поэтому в
        // журнале ей место.
        reason: request.body.reason ?? null,
      });

      return reply.code(200).send({ rejected: true });
    },
  );
}

// =====================================================================
// Вспомогательное
// =====================================================================

function toRequestResponse(row: RequestRow): z.infer<typeof registrationRequestSchema> {
  return {
    id: row.id,
    email: row.login_display,
    fullName: row.full_name,
    position: row.position,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    hasRequestedPassword: row.password_hash !== null,
  };
}

/**
 * То же правило, что и при смене ролей: подрядчик обязан иметь организацию, а
 * роль `contractor` не совмещается с другими.
 *
 * Проверяется здесь, а не только схемой, потому что связь роли и организации
 * схемой тела не выражается: она про два поля сразу.
 */
function assertRolesConsistent(roles: readonly string[], contractorId: string | null): void {
  if (roles.includes('contractor') && contractorId === null) {
    throw unprocessable(
      [
        {
          pointer: '/contractorId',
          code: 'contractor-without-organization',
          message:
            'Подрядчику обязательна организация: без неё у него нет области видимости, ' +
            'и он не увидит ни одной поставки.',
        },
      ],
      'Роли и организация не согласованы.',
    );
  }
}

async function loadCard(
  app: AppInstance,
  request: Parameters<typeof currentAuth>[0],
  userId: string,
): Promise<z.infer<typeof userCardResponseSchema>> {
  const { scope } = currentAuth(request);
  const user = await findUserById(app.db, scope, userId);
  if (user === null) throw notFound('Пользователь не найден.');
  const objectIds = await listUserObjectScopes(app.db, scope, userId);

  return {
    user: userSummaryResponseSchema.parse({ ...user, roles: [...user.roles] }),
    objectIds: [...objectIds],
  };
}

async function auditAdminAction(
  app: AppInstance,
  request: Parameters<typeof currentAuth>[0],
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const auth = currentAuth(request);
  await app.pool.query(
    `insert into audit_log
       (actor_user_id, actor_email_hmac, action, entity_type, entity_id, payload, ip, request_id)
     values ($1::uuid, $2::text, $3::text, 'user', $4::text, $5::jsonb, $6::inet, $7::text)`,
    [
      auth.user.id,
      auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
      action,
      entityId,
      JSON.stringify(payload),
      request.ip,
      request.id,
    ],
  );
}

async function withTransaction<T>(
  app: AppInstance,
  work: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (cause) {
    await client.query('rollback').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

export { recordAuthEvent };
