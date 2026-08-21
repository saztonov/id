/**
 * Маршруты локального входа (`AUTH_MODE=local`).
 *
 * Регистрируются ТОЛЬКО в этом режиме: в `oidc` и `dev-stub` их нет в дереве
 * маршрутов вовсе. Отсутствующий маршрут нельзя вызвать по ошибке, забыв
 * проверку режима, — отвечающий отказом можно.
 *
 * Границу «в ответ не уходит ничего, чего не должно» держит именно этот файл.
 * Два правила, которые здесь важнее краткости:
 *
 *   1. Ответ на неверный логин и на неверный пароль совпадает ПОБАЙТОВО, и
 *      время ответа тоже: иначе перебор адресов восстанавливает список учётных
 *      записей. Ради этого существует холостая проверка `verifyDummy`.
 *   2. Cookie выставляются только ПОСЛЕ коммита транзакции. Сессия, выданная до
 *      коммита, пережила бы откат и указывала бы в пустоту.
 */
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';

import type { AppInstance } from '../../app.js';
import type { Env } from '../../config/env.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import {
  conflict,
  forbidden,
  tooManyRequests,
  unauthorized,
  unprocessable,
} from '../../lib/problem.js';
import {
  CSRF_COOKIE,
  csrfCookieOptions,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionRecord,
} from '../session.js';
import { recordAuthEvent, type LoginFailureReason } from './audit.js';
import { canonicalizeLogin, ipThrottleKey, loginThrottleKey } from './canonical.js';
import {
  createCredential,
  findCredentialByLogin,
  findCredentialByUserId,
  loginExists,
  rehashPassword,
  replacePassword,
} from './credentials.js';
import { jsonOnlyGuard, sameOriginGuard } from './origin-guard.js';
import { checkPasswordPolicy } from './policy.js';
import {
  HashLimiter,
  hashPassword,
  needsRehash,
  verifyDummy,
  verifyPassword,
} from './passwords.js';
import { clearThrottle, loadThrottle, registerFailure, sweepExpired, unlock } from './throttle.js';

/**
 * Единственный текст отказа во входе.
 *
 * Одна константа, а не литерал в трёх местах: разойдись формулировки хоть
 * пробелом — и разница в ответах снова различает «нет такого пользователя» и
 * «неверный пароль».
 */
const LOGIN_REJECTED = 'Неверный логин или пароль.';

/** Лимит неудач по логину за окно (B.7): десять — блокировка на 30 минут. */
const LOGIN_MAX_FAILURES = 10;

/**
 * Маршруты, которые обязаны работать без сессии и потому не проходят общую
 * проверку CSRF. Защищены `sameOriginGuard` и `jsonOnlyGuard`; список читает
 * `app.ts`, где регистрируется общий хук.
 */
export const PUBLIC_LOCAL_AUTH_ROUTES: ReadonlySet<string> = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
]);

export function registerLocalAuthRoutes(app: AppInstance): void {
  const { env } = app;
  const limiter = new HashLimiter(env.AUTH_LOCAL_HASH_CONCURRENCY);
  const originGuard = sameOriginGuard(env);

  const passwordBody = z
    .string()
    .min(1)
    // Верхняя граница — из конфигурации, та же, что у политики: два независимых
    // максимума однажды разошлись бы, и пароль, принятый формой, отвергался бы
    // политикой без внятного объяснения.
    .max(env.AUTH_LOCAL_PASSWORD_MAX_LENGTH);

  // =====================================================================
  // GET /api/v1/auth/config
  // =====================================================================

  /**
   * Публичные признаки режима.
   *
   * SPA не должен угадывать доступность регистрации по коду ответа на попытку:
   * «404 на POST» и «регистрация выключена» — не одно и то же для интерфейса.
   */
  app.get(
    '/api/v1/auth/config',
    {
      schema: {
        response: {
          200: z.object({ registrationEnabled: z.boolean(), passwordMinLength: z.number() }),
        },
      },
    },
    () =>
      Promise.resolve({
        registrationEnabled: env.AUTH_LOCAL_REGISTRATION_ENABLED,
        passwordMinLength: env.AUTH_LOCAL_PASSWORD_MIN_LENGTH,
      }),
  );

  // =====================================================================
  // POST /api/v1/auth/login
  // =====================================================================

  app.post(
    '/api/v1/auth/login',
    {
      schema: {
        body: z.object({
          // До подключения Keycloak логином служит введённый адрес: так
          // заводятся учётные записи всеми тремя путями (регистрация, создание
          // администратором, CLI). Проверка формата здесь не выдаёт
          // существования учётной записи — она про синтаксис ввода, а не про
          // содержимое базы, — и потому не нарушает единообразия отказов.
          //
          // Обрамляющие пробелы снимаются ДО проверки: адрес часто вставляют из
          // буфера вместе с ними, и отказ «это не адрес» на видимо верном
          // значении объясняет не то.
          email: z.string().trim().pipe(z.email().max(320)),
          password: passwordBody,
          returnTo: z.string().max(512).optional(),
        }),
        response: { 200: z.object({ redirectTo: z.string() }) },
      },
      config: {
        rateLimit: {
          max: env.AUTH_LOCAL_LOGIN_MAX_PER_IP,
          timeWindow: env.AUTH_LOCAL_LOGIN_WINDOW_MINUTES * 60_000,
        },
      },
      onRequest: [originGuard, jsonOnlyGuard],
    },
    async (request, reply) => {
      const { email, password, returnTo } = request.body;
      const login = canonicalizeLogin(email);
      const loginKey = loginThrottleKey(env, login);
      const ipKey = ipThrottleKey(env, request.ip);

      // Троттлинг проверяется ДО обращения к учётным данным: иначе время ответа
      // заблокированному клиенту зависело бы от существования учётной записи.
      for (const [scope, key] of [
        ['login', loginKey],
        ['ip-login', ipKey],
      ] as const) {
        const state = await loadThrottle(app.pool, scope, key);
        if (state.retryAfterSeconds !== null) {
          await logFailure(app, request, {
            userId: null,
            emailHmac: hmac(env, login),
            reason: state.locked ? 'locked' : 'throttled',
          });
          throw tooManyRequests(
            state.retryAfterSeconds,
            'Слишком много попыток входа. Повторите позже.',
          );
        }
      }

      const slot = await limiter.acquire();
      if (slot === null) {
        // Очередь хеширования переполнена. Честный 429 лучше запроса, висящего
        // до таймаута: клиент узнаёт, что нужно повторить, а не что портал умер.
        await logFailure(app, request, {
          userId: null,
          emailHmac: hmac(env, login),
          reason: 'overloaded',
        });
        throw tooManyRequests(
          5,
          'Портал занят проверкой входов. Повторите через несколько секунд.',
        );
      }

      let credential;
      let passwordOk: boolean;
      try {
        credential = await findCredentialByLogin(app.pool, login);
        passwordOk =
          credential === null
            ? await verifyDummy(env, password)
            : await verifyPassword(password, credential.passwordHash);
      } finally {
        slot();
      }

      // Проверка на null здесь не лишняя ветка, а сужение типа: холостая
      // проверка всегда возвращает false, поэтому `passwordOk` при отсутствии
      // учётных данных истинным быть не может, но компилятор этого не знает.
      if (!passwordOk || credential === null) {
        await registerLoginFailure(app, request, {
          login,
          loginKey,
          ipKey,
          userId: credential?.userId ?? null,
          reason: credential === null ? 'unknown-login' : 'bad-password',
        });
        throw unauthorized(LOGIN_REJECTED);
      }

      if (!credential.isActive) {
        // Раскрытие здесь допустимо и полезно: верный пароль уже предъявлен,
        // значит перед нами владелец учётной записи, а не перебор. Молчаливый
        // отказ отправил бы его подбирать пароль, который и так верен.
        await logFailure(app, request, {
          userId: credential.userId,
          emailHmac: hmac(env, login),
          reason: 'inactive',
        });
        throw forbidden('Учётная запись ещё не активирована. Обратитесь к администратору портала.');
      }

      const csrfToken = reply.generateCsrf({ userInfo: credential.userId });
      const session = await withTransaction(app, async (tx) => {
        // Перепроверка хэша: между чтением и этим моментом администратор мог
        // сбросить пароль. Без сверки вход по прежнему паролю прошёл бы уже
        // после сброса, и сброс оказался бы бесполезен.
        const { rows } = await tx.query<{ password_hash: string }>(
          'select password_hash from user_credentials where user_id = $1::uuid for update',
          [credential.userId],
        );
        if (rows[0]?.password_hash !== credential.passwordHash) {
          throw unauthorized(LOGIN_REJECTED);
        }

        await clearThrottle(tx, 'login', loginKey);
        await clearThrottle(tx, 'ip-login', ipKey);

        // Отзыв предъявленной сессии: без него страница, подсунувшая жертве
        // свой идентификатор сессии, сохранила бы его и после входа жертвы
        // (session fixation).
        const presented = request.authSession;
        if (presented !== null) await app.sessions.revoke(presented.id);

        const created = await app.sessions.create({
          userId: credential.userId,
          kcSid: null,
          // Обновлять нечего: внешнего провайдера нет.
          refreshToken: null,
          csrfToken,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        await tx.query('update users set last_login_at = now() where id = $1::uuid', [
          credential.userId,
        ]);
        await recordAuthEvent(tx, {
          action: 'auth.login_success',
          actorUserId: credential.userId,
          actorEmailHmac: hmac(env, login),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return created;
      });

      setSessionCookies(app, reply, session, csrfToken);

      // Перехэширование — оптимизация и потому вне транзакции: проиграть гонку
      // смене пароля для него нормально, а задержать вход — нет.
      if (needsRehash(env, credential.passwordHash)) {
        void rehashInBackground(app, credential.userId, credential.passwordHash, password);
      }

      request.log.info(
        { userId: credential.userId, sessionId: session.id },
        'вход выполнен паролем',
      );
      return reply.code(200).send({ redirectTo: safeLocalPath(returnTo) });
    },
  );

  // =====================================================================
  // POST /api/v1/auth/register
  // =====================================================================

  if (env.AUTH_LOCAL_REGISTRATION_ENABLED) {
    app.post(
      '/api/v1/auth/register',
      {
        schema: {
          body: z.object({
            email: z.string().trim().pipe(z.email().max(320)),
            fullName: z.string().trim().min(2).max(256),
            position: z.string().trim().max(256).optional(),
            password: passwordBody,
          }),
          response: { 202: z.object({ status: z.literal('pending-activation') }) },
        },
        config: {
          rateLimit: { max: env.AUTH_LOCAL_REGISTER_MAX_PER_IP_HOUR, timeWindow: 3_600_000 },
        },
        onRequest: [originGuard, jsonOnlyGuard],
      },
      async (request, reply) => {
        const { email, fullName, position, password } = request.body;
        const login = canonicalizeLogin(email);

        // Политика проверяется всегда и первой: отказ по слишком короткому
        // паролю ничего не сообщает о существовании учётной записи, поэтому его
        // можно и нужно возвращать честно.
        const violations = checkPasswordPolicy(password, env);
        if (violations.length > 0) throw policyProblem(violations);

        // Хэш считается ДО проверки занятости адреса и независимо от неё: иначе
        // занятый адрес отвечал бы заметно быстрее свободного.
        const hash = await hashPassword(env, password);

        const taken =
          (await loginExists(app.pool, login)) || (await pendingRequestExists(app, login));

        if (taken) {
          await recordAuthEvent(app.pool, {
            action: 'auth.register_duplicate',
            actorUserId: null,
            actorEmailHmac: hmac(env, login),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            requestId: request.id,
          });
          // Тот же ответ, что и при успехе: иначе форма регистрации становится
          // способом узнать, заведён ли в портале конкретный человек.
          return reply.code(202).send({ status: 'pending-activation' });
        }

        try {
          await app.pool.query(
            `insert into registration_requests
               (login_key, login_display, full_name, position,
                password_hash, password_algorithm, ip)
             values ($1, $2, $3, $4, $5, $6, $7::inet)`,
            [
              login,
              email.trim(),
              fullName,
              position ?? null,
              hash.encoded,
              hash.algorithm,
              request.ip,
            ],
          );
        } catch (cause) {
          // Гонку двух одновременных заявок ловит частичный уникальный индекс.
          // Ответ обязан совпасть с ответом на дубликат — иначе гонка сама
          // становится оракулом.
          if (!isUniqueViolation(cause)) throw cause;
          return reply.code(202).send({ status: 'pending-activation' });
        }

        await recordAuthEvent(app.pool, {
          action: 'auth.register_requested',
          actorUserId: null,
          actorEmailHmac: hmac(env, login),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        request.log.info('подана заявка на регистрацию');
        return reply.code(202).send({ status: 'pending-activation' });
      },
    );
  }

  // =====================================================================
  // POST /api/v1/auth/password
  // =====================================================================

  app.post(
    '/api/v1/auth/password',
    {
      schema: {
        body: z.object({ currentPassword: passwordBody, newPassword: passwordBody }),
        response: { 200: z.object({ changed: z.literal(true) }) },
      },
      config: {
        rateLimit: { max: env.AUTH_LOCAL_PASSWORD_MAX_PER_HOUR, timeWindow: 3_600_000 },
      },
    },
    async (request, reply) => {
      // Опора на принципала, а не на requireAuth: пользователь с временным
      // паролем ролей ещё не имеет, а сменить пароль обязан.
      const session = request.authSession;
      const principal = request.authPrincipal;
      if (session === null || principal === null) throw unauthorized('Требуется вход в портал.');

      const credential = await findCredentialByUserId(app.pool, principal.user.id);
      if (credential === null) {
        throw conflict('У учётной записи нет локального пароля.');
      }

      const slot = await limiter.acquire();
      if (slot === null) {
        throw tooManyRequests(
          5,
          'Портал занят проверкой входов. Повторите через несколько секунд.',
        );
      }
      let currentOk: boolean;
      try {
        currentOk = await verifyPassword(request.body.currentPassword, credential.passwordHash);
      } finally {
        slot();
      }
      if (!currentOk) throw unauthorized('Текущий пароль неверен.');

      const violations = [...checkPasswordPolicy(request.body.newPassword, env)];
      if (await verifyPassword(request.body.newPassword, credential.passwordHash)) {
        violations.push({ code: 'unchanged', message: 'Новый пароль совпадает с текущим.' });
      }
      if (violations.length > 0) throw policyProblem(violations);

      const hash = await hashPassword(env, request.body.newPassword);
      const csrfToken = reply.generateCsrf({ userInfo: principal.user.id });

      const session2 = await withTransaction(app, async (tx) => {
        const replaced = await replacePassword(tx, {
          userId: principal.user.id,
          expectedHash: credential.passwordHash,
          hash,
          mustChangePassword: false,
        });
        if (!replaced) {
          // Пароль изменился между чтением и записью: решение принималось по
          // устаревшим данным, и записывать его нельзя.
          throw conflict('Пароль был изменён другим запросом. Повторите попытку.');
        }

        // Смена пароля обязана обесценить все прочие сессии: это и есть
        // исполнение требования «password_changed_at инвалидирует активные
        // сессии». Отзыв идёт до создания новой, поэтому новая переживает его.
        await app.sessions.revokeAllForUser(principal.user.id);

        const created = await app.sessions.create({
          userId: principal.user.id,
          kcSid: null,
          refreshToken: null,
          csrfToken,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        await recordAuthEvent(tx, {
          action: 'auth.password_changed',
          actorUserId: principal.user.id,
          actorEmailHmac: hmac(env, credential.loginKey),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return created;
      });

      setSessionCookies(app, reply, session2, csrfToken);
      request.log.info({ userId: principal.user.id }, 'пароль изменён');
      return reply.code(200).send({ changed: true });
    },
  );
}

// =====================================================================
// Вспомогательное
// =====================================================================

function hmac(env: Env, login: string): string | null {
  return auditEmailHmac(env.AUDIT_HMAC_KEY, login);
}

function policyProblem(violations: readonly { code: string; message: string }[]): never {
  throw unprocessable(
    violations.map((violation) => ({
      pointer: '/password',
      code: violation.code,
      message: violation.message,
    })),
    'Пароль не соответствует требованиям.',
  );
}

/**
 * Учёт неудачной попытки: троттлинг и журнал.
 *
 * Считается и по логину, и по адресу. Ключ логина — HMAC КАНОНИЧЕСКОЙ формы,
 * поэтому смена регистра нового ведра не создаёт.
 */
async function registerLoginFailure(
  app: AppInstance,
  request: FastifyRequest,
  input: {
    readonly login: string;
    readonly loginKey: string;
    readonly ipKey: string;
    readonly userId: string | null;
    readonly reason: LoginFailureReason;
  },
): Promise<void> {
  const { env } = app;

  const state = await registerFailure(app.pool, env, {
    scope: 'login',
    bucketKey: input.loginKey,
    userId: input.userId,
    maxAttempts: LOGIN_MAX_FAILURES,
    windowMinutes: 60,
    applyBackoff: true,
  });
  await registerFailure(app.pool, env, {
    scope: 'ip-login',
    bucketKey: input.ipKey,
    userId: null,
    maxAttempts: env.AUTH_LOCAL_LOGIN_MAX_PER_IP,
    windowMinutes: env.AUTH_LOCAL_LOGIN_WINDOW_MINUTES,
    // Задержек по адресу нет: за одним адресом сидит целый офис за NAT.
    applyBackoff: false,
  });

  await logFailure(app, request, {
    userId: input.userId,
    emailHmac: hmac(env, input.login),
    reason: input.reason,
  });

  if (state.locked && state.failedAttempts === LOGIN_MAX_FAILURES) {
    // Ровно один раз на блокировку, а не на каждую последующую попытку: иначе
    // событие «учётная запись заблокирована» тонет в собственных повторах.
    await recordAuthEvent(app.pool, {
      action: 'auth.account_locked',
      actorUserId: input.userId,
      actorEmailHmac: hmac(env, input.login),
      payload: { failedAttempts: state.failedAttempts },
      ip: request.ip,
      requestId: request.id,
    });
  }

  await sweepExpired(app.pool);
}

async function logFailure(
  app: AppInstance,
  request: FastifyRequest,
  input: {
    readonly userId: string | null;
    readonly emailHmac: string | null;
    readonly reason: LoginFailureReason;
  },
): Promise<void> {
  await recordAuthEvent(app.pool, {
    action: 'auth.login_failure',
    actorUserId: input.userId,
    actorEmailHmac: input.emailHmac,
    // Причина живёт в журнале, но не в ответе: снаружи все отказы одинаковы.
    payload: { reason: input.reason },
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  });
}

async function pendingRequestExists(app: AppInstance, login: string): Promise<boolean> {
  const { rows } = await app.pool.query<{ id: string }>(
    `select id from registration_requests where login_key = $1 and status = 'pending'`,
    [login],
  );
  return rows.length > 0;
}

function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === '23505'
  );
}

/**
 * Транзакция на отдельном соединении.
 *
 * Нужна там, где несколько записей обязаны попасть в базу вместе: половина
 * смены пароля хуже, чем её отсутствие.
 */
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

function setSessionCookies(
  app: AppInstance,
  reply: FastifyReply,
  session: SessionRecord,
  csrfToken: string,
): void {
  reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.env));
  reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(app.env));
}

async function rehashInBackground(
  app: AppInstance,
  userId: string,
  previousHash: string,
  password: string,
): Promise<void> {
  try {
    const hash = await hashPassword(app.env, password);
    await rehashPassword(app.pool, userId, previousHash, hash);
  } catch (cause) {
    // Неудача перехэширования не должна ничего ломать: пользователь уже вошёл,
    // а прежний хэш остаётся рабочим.
    app.log.warn({ err: cause, userId }, 'перехэширование пароля не выполнено');
  }
}

/**
 * Локальный путь возврата.
 *
 * Та же проверка, что у `safeReturnTo` в `auth/routes.ts`, и по той же причине:
 * без неё параметр превращается в открытый редирект.
 */
function safeLocalPath(value: string | undefined): string {
  if (value === undefined || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return value;
}

export { unlock as unlockThrottle, createCredential, findCredentialByLogin };
