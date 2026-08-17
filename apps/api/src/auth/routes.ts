/**
 * Маршруты аутентификации BFF: `/auth/login`, `/auth/callback`,
 * `/auth/logout`, `/auth/csrf`, `/me`.
 *
 * Границу «токены не покидают сервер» держит именно этот файл: сюда приходят
 * `id_token` и `refresh_token`, и наружу из обработчиков уходит только
 * идентификатор сессии в cookie. Ни один ответ не содержит токена, и ни один
 * редирект не несёт его в query.
 *
 * `/auth/logout` и `/me` требуют СЕССИЮ, но не бизнес-права: пользователь, у
 * которого роль ещё не назначена, обязан уметь выйти и обязан получить внятный
 * ответ «прав нет», а не 403 без объяснения.
 */
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../app.js';
import { userRoleSchema } from '@id/contracts';
import { unauthorized } from '../lib/problem.js';
import {
  buildScope,
  clearSessionCookies,
  type ScopeResolution,
} from '../middleware/require-auth.js';
import { hasPortalAccess, type DevStubIdentity } from './oidc.js';
import { provisionUser } from './provisioning.js';
import {
  CSRF_COOKIE,
  csrfCookieOptions,
  LOGIN_COOKIE,
  loginCookieOptions,
  openLoginTransaction,
  sealLoginTransaction,
  SESSION_COOKIE,
  sessionCookieOptions,
  constantTimeEquals,
  type LoginTransaction,
  type SessionRecord,
} from './session.js';

/**
 * Коды, с которыми пользователь возвращается на страницу входа.
 *
 * Закрытый перечень: сообщение провайдера в редирект не переносится, иначе
 * `error_description` от Keycloak оказался бы в истории браузера и в логах
 * прокси.
 */
type AuthErrorCode = 'denied' | 'invalid_state' | 'no_access' | 'inactive' | 'failed';

const loginQuerySchema = z.object({
  /** Локальный путь, куда вернуть пользователя после входа. */
  returnTo: z.string().max(512).optional(),
  /** Ниже — только для `AUTH_MODE=dev-stub`; провайдером `oidc` игнорируется. */
  devSub: z.string().min(1).max(64).optional(),
  devEmail: z.string().max(320).optional(),
  devName: z.string().max(256).optional(),
  devRoles: z.string().max(256).optional(),
  devNoAccess: z.enum(['1']).optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(8192).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(1024).optional(),
});

const logoutResponseSchema = z.object({
  endSessionUrl: z.string().nullable(),
});

const csrfResponseSchema = z.object({
  /** Тот же токен, что и в cookie `id_csrf`: SPA держит его в памяти. */
  csrfToken: z.string(),
});

const meResponseSchema = z.object({
  authMode: z.enum(['oidc', 'dev-stub']),
  user: z.object({
    id: z.uuid(),
    email: z.string().nullable(),
    fullName: z.string(),
    position: z.string().nullable(),
    contractorId: z.uuid().nullable(),
    isActive: z.boolean(),
  }),
  roles: z.array(userRoleSchema),
  scope: z
    .object({
      kind: z.enum(['contractor', 'engineer', 'manager', 'admin']),
      objectIds: z.array(z.uuid()).nullable(),
      contractorId: z.uuid().nullable(),
    })
    .nullable(),
  /** Причина отсутствия прав. `null`, когда права есть. */
  denial: z
    .enum(['unknown-user', 'inactive', 'no-business-role', 'contractor-without-organization'])
    .nullable(),
  session: z.object({
    idleExpiresAt: z.string(),
    absoluteExpiresAt: z.string(),
  }),
});

export function registerAuthRoutes(app: AppInstance): void {
  const { env, pool, sessions, sessionCipher, authProvider } = app;

  app.get('/auth/login', { schema: { querystring: loginQuerySchema } }, async (request, reply) => {
    const returnTo = safeReturnTo(request.query.returnTo);
    const start = await authProvider.startLogin({
      redirectUri: publicUrl(app, '/auth/callback'),
      ...(authProvider.mode === 'dev-stub' ? { devStub: devStubIdentity(request.query) } : {}),
    });

    const sealed = await sealLoginTransaction(sessionCipher, {
      state: start.state,
      nonce: start.nonce,
      codeVerifier: start.codeVerifier,
      returnTo,
      issuedAt: Date.now(),
    });
    reply.setCookie(LOGIN_COOKIE, sealed, loginCookieOptions(env));

    return reply.redirect(start.authorizationUrl, 302);
  });

  app.get(
    '/auth/callback',
    { schema: { querystring: callbackQuerySchema } },
    async (request, reply) => {
      const query = request.query;
      reply.clearCookie(LOGIN_COOKIE, loginCookieOptions(env));

      if (query.error !== undefined) {
        request.log.warn(
          { oidcError: query.error, oidcErrorDescription: query.error_description },
          'провайдер идентификации отказал во входе',
        );
        return redirectWithAuthError(app, reply, 'denied');
      }

      const transaction = await readLoginTransaction(app, request);
      if (transaction === null || query.state === undefined || query.code === undefined) {
        request.log.warn('ответ авторизации без действующей cookie логина');
        return redirectWithAuthError(app, reply, 'invalid_state');
      }

      if (!constantTimeEquals(query.state, transaction.state)) {
        // Единственная защита от подсунутого ответа авторизации; журналируется
        // как инцидент, а не как ошибка ввода.
        request.log.warn('state ответа авторизации не совпал с state запроса');
        return redirectWithAuthError(app, reply, 'invalid_state');
      }

      let completed;
      try {
        completed = await authProvider.completeLogin({
          callbackUrl: new URL(request.url, env.PUBLIC_URL),
          expectedState: transaction.state,
          expectedNonce: transaction.nonce,
          codeVerifier: transaction.codeVerifier,
        });
      } catch (cause) {
        // Браузер пришёл сюда навигацией: problem+json он покажет как текст.
        // Поэтому неудача обмена кода превращается в возврат на страницу входа.
        request.log.warn({ err: cause }, 'обмен authorization code не удался');
        return redirectWithAuthError(app, reply, 'failed');
      }
      const { claims, tokens } = completed;

      if (!hasPortalAccess(claims)) {
        request.log.warn({ kcSub: claims.subject }, 'вход без роли доступа к порталу');
        return redirectWithAuthError(app, reply, 'no_access');
      }

      const provisioned = await provisionUser(pool, claims);
      if (provisioned.ignoredTokenRoles.length > 0) {
        // Требование §4.1: роль в токене прав не даёт. Расхождение всё же стоит
        // увидеть — оно означает, что в Keycloak завели роль с именем бизнес-роли.
        request.log.warn(
          { userId: provisioned.user.id, ignoredTokenRoles: provisioned.ignoredTokenRoles },
          'бизнес-роли из токена проигнорированы: источник прав — таблицы портала',
        );
      }

      if (!provisioned.user.isActive) {
        request.log.warn({ userId: provisioned.user.id }, 'вход отключённой учётной записи');
        return redirectWithAuthError(app, reply, 'inactive');
      }

      const csrfToken = reply.generateCsrf({ userInfo: provisioned.user.id });
      const session = await sessions.create({
        userId: provisioned.user.id,
        kcSid: claims.sessionId,
        // Единственное место, где refresh-токен покидает провайдера: дальше он
        // существует только в виде шифрованного конверта в auth_sessions.
        refreshToken: tokens.refreshToken,
        csrfToken,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      setSessionCookies(app, reply, session, csrfToken);
      request.log.info(
        { userId: provisioned.user.id, created: provisioned.created, sessionId: session.id },
        'вход выполнен',
      );

      return reply.redirect(publicUrl(app, transaction.returnTo), 302);
    },
  );

  app.post(
    '/auth/logout',
    { schema: { response: { 200: logoutResponseSchema } } },
    async (request, reply) => {
      const session = requireSession(request);

      // Порядок важен: локальная сессия отзывается ДО обращения к провайдеру.
      // Если провайдер недоступен, портал всё равно обязан считать пользователя
      // вышедшим, а не оставить действующую сессию из-за чужого сбоя.
      const refreshToken = await sessions.readRefreshToken(session.id);
      await sessions.revoke(session.id);
      clearSessionCookies(reply, env);

      const result = await authProvider.endSession({
        refreshToken,
        postLogoutRedirectUri: env.PUBLIC_URL,
      });
      if (result.failure !== null) {
        request.log.warn(
          { sessionId: session.id, failure: result.failure },
          'end-session провайдера не выполнен полностью',
        );
      }

      request.log.info({ userId: session.userId, sessionId: session.id }, 'выход выполнен');
      // Адрес возвращается, а не выполняется редиректом: front-channel logout
      // обязан пройти через браузер, иначе SSO-cookie Keycloak останется цела.
      return reply.code(200).send({ endSessionUrl: result.endSessionUrl });
    },
  );

  /**
   * Обновление CSRF-токена сессии.
   *
   * Существует потому, что выдача токена — изменение состояния (перезапись
   * `auth_sessions.csrf_hash`), и делать её в `GET /me` нельзя: cookie
   * `SameSite=Lax` уезжает при навигации с чужого origin, то есть чужая страница
   * отбирала бы у пользователя действующий токен, а с ним и право на запись.
   *
   * Метод POST выбран не для красоты: при cross-site POST браузер cookie
   * `SameSite=Lax` не отправляет вовсе, поэтому вызов с чужой страницы упирается
   * в 401 ещё до обработчика. Сверх того запрос проходит общую проверку CSRF, то
   * есть заявитель обязан предъявить текущий токен — эндпоинт вращает токен, а не
   * восстанавливает его из ничего. Если токен потерян целиком, восстановление —
   * повторный `/auth/login`: при живой SSO-сессии он проходит без ввода пароля.
   */
  app.post(
    '/auth/csrf',
    { schema: { response: { 200: csrfResponseSchema } } },
    async (request, reply) => {
      const session = requireSession(request);

      const csrfToken = reply.generateCsrf({ userInfo: session.userId });
      await sessions.rotateCsrfToken(session.id, csrfToken);
      reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(env));

      request.log.info(
        { userId: session.userId, sessionId: session.id },
        'CSRF-токен сессии обновлён',
      );
      return reply.code(200).send({ csrfToken });
    },
  );

  app.get('/me', { schema: { response: { 200: meResponseSchema } } }, async (request, reply) => {
    const session = requireSession(request);

    const resolution: ScopeResolution =
      request.authContext !== null
        ? {
            granted: true,
            user: request.authContext.user,
            roles: request.authContext.roles,
            scope: request.authContext.scope,
          }
        : await buildScope(pool, session.userId);

    if (resolution.user === null) {
      // Сессия ссылается на удалённого пользователя: восстанавливать нечего.
      await sessions.revoke(session.id);
      clearSessionCookies(reply, env);
      throw unauthorized('Требуется вход в портал.');
    }

    // Ни выдачи, ни вращения CSRF-токена здесь нет намеренно: GET не меняет
    // состояние. Обновление токена — POST /auth/csrf.
    return reply.code(200).send({
      authMode: authProvider.mode,
      user: {
        id: resolution.user.id,
        email: resolution.user.email,
        fullName: resolution.user.fullName,
        position: resolution.user.position,
        contractorId: resolution.user.contractorId,
        isActive: resolution.user.isActive,
      },
      roles: [...resolution.roles],
      scope: resolution.granted
        ? {
            kind: resolution.scope.kind,
            objectIds:
              resolution.scope.kind === 'engineer' ? [...resolution.scope.objectIds] : null,
            contractorId:
              resolution.scope.kind === 'contractor' ? resolution.scope.contractorId : null,
          }
        : null,
      denial: resolution.granted ? null : resolution.reason,
      session: {
        idleExpiresAt: session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      },
    });
  });
}

// =====================================================================
// Вспомогательное
// =====================================================================

/**
 * Сессия без проверки бизнес-прав.
 *
 * Отдельно от `requireAuth`, потому что выход и `/me` обязаны работать и у
 * пользователя, которому роль ещё не назначили.
 */
function requireSession(request: FastifyRequest): SessionRecord {
  const session = request.authSession;
  if (session === null) throw unauthorized('Требуется вход в портал.');
  return session;
}

async function readLoginTransaction(
  app: AppInstance,
  request: FastifyRequest,
): Promise<LoginTransaction | null> {
  const raw = request.cookies[LOGIN_COOKIE];
  if (raw === undefined) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  return openLoginTransaction(app.sessionCipher, unsigned.value);
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

function publicUrl(app: AppInstance, path: string): string {
  return new URL(path, app.env.PUBLIC_URL).href;
}

function redirectWithAuthError(app: AppInstance, reply: FastifyReply, code: AuthErrorCode) {
  const url = new URL('/', app.env.PUBLIC_URL);
  url.searchParams.set('auth_error', code);
  return reply.redirect(url.href, 302);
}

/**
 * Куда вернуть пользователя после входа.
 *
 * Принимается только локальный путь. Без этой проверки параметр превращается в
 * открытый редирект: ссылка `/auth/login?returnTo=https://evil.example` увела бы
 * пользователя на чужой сайт сразу после успешного входа в портал.
 */
function safeReturnTo(value: string | undefined): string {
  if (value === undefined || !value.startsWith('/')) return '/';
  // `//host` браузер трактует как протокол-относительный абсолютный адрес,
  // `/\host` — тоже, из-за нормализации обратных слэшей.
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  // Управляющими символами в Location разрезают заголовки ответа. Проверка
  // по кодам, а не регулярным выражением: литеральный управляющий байт в
  // исходнике невидим и переживёт любую вычитку.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return value;
}

function devStubIdentity(query: z.infer<typeof loginQuerySchema>): DevStubIdentity {
  return {
    subject: query.devSub ?? 'dev-stub-user',
    email: query.devEmail ?? null,
    fullName: query.devName ?? null,
    tokenRoles: (query.devRoles ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role.length > 0),
    grantPortalAccess: query.devNoAccess !== '1',
  };
}
