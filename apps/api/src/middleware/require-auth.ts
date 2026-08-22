/**
 * Первый уровень изоляции доступа: кто выполняет запрос (§4.1).
 *
 * Область видимости собирается ЗДЕСЬ и ТОЛЬКО из таблиц портала — `user_roles`
 * и `user_object_scopes`. Токен Keycloak в этом не участвует: он отвечает за
 * идентичность и право входа, но не за бизнес-права. Гарантия структурная, а не
 * дисциплинарная: роли имеют помеченный тип `PortalRole`, значение которого
 * рождается единственным приведением в `buildScope()`. Строку из
 * `realm_access.roles` в проверку прав подставить нельзя — не сойдётся тип.
 */
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Pool } from 'pg';
import { userRoleSchema, type UserRole } from '@id/contracts';
import type { AuthScope } from '../auth/scope.js';
import type { PortalUser } from '../auth/provisioning.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_PROTECTED_METHODS,
  csrfCookieOptions,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionRecord,
  type SessionStore,
} from '../auth/session.js';
import type { Env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/problem.js';

declare const portalRoleSource: unique symbol;

/**
 * Роль, прочитанная из БД портала.
 *
 * Метка нужна не для документации: она делает невозможным вызов
 * `hasPermission()` со строкой, пришедшей из токена, — а именно так и выглядит
 * повышение прав через Keycloak.
 */
export type PortalRole = UserRole & { readonly [portalRoleSource]: 'database' };

export interface AuthContext {
  readonly session: SessionRecord;
  readonly user: PortalUser;
  /** Все роли пользователя, а не только старшая: права проверяются по набору. */
  readonly roles: readonly PortalRole[];
  readonly scope: AuthScope;
}

export type ScopeDenialReason =
  'unknown-user' | 'inactive' | 'no-business-role' | 'contractor-without-organization';

/**
 * Кто выполняет запрос, БЕЗ учёта бизнес-прав.
 *
 * Существует отдельно от `AuthContext` не ради удобства. `authContext`
 * заполняется только при успешном разрешении области видимости, поэтому
 * пользователь без назначенной роли не имеет его вовсе — а именно такой
 * пользователь и обязан быть виден проверке «требуется смена пароля»: свежая
 * учётная запись с временным паролем ролей ещё не имеет. Флаг, положенный в
 * `AuthContext`, не сработал бы ровно там, где он нужен.
 */
export interface AuthPrincipal {
  readonly user: PortalUser;
  /** Пароль выдан администратором либо сброшен: до смены доступ ограничен. */
  readonly mustChangePassword: boolean;
  /** Есть ли у пользователя локальные учётные данные. */
  readonly hasLocalCredentials: boolean;
}

export interface ScopeGranted {
  readonly granted: true;
  readonly user: PortalUser;
  readonly roles: readonly PortalRole[];
  readonly scope: AuthScope;
  readonly principal: AuthPrincipal;
}

export interface ScopeDenied {
  readonly granted: false;
  readonly reason: ScopeDenialReason;
  readonly user: PortalUser | null;
  readonly roles: readonly PortalRole[];
  /** `null` только при `unknown-user`: принципала без пользователя не бывает. */
  readonly principal: AuthPrincipal | null;
}

export type ScopeResolution = ScopeGranted | ScopeDenied;

declare module 'fastify' {
  interface FastifyRequest {
    /** Действующая сессия. Есть и тогда, когда бизнес-прав нет. */
    authSession: SessionRecord | null;
    /** Полный контекст доступа. `null` означает «прав нет», а не «нет сессии». */
    authContext: AuthContext | null;
    /**
     * Пользователь сессии независимо от бизнес-прав.
     *
     * Заполняется всегда, когда сессия ссылается на существующего пользователя,
     * — в том числе при отказе в области видимости.
     */
    authPrincipal: AuthPrincipal | null;
    authDenial: ScopeDenialReason | null;
  }
}

/**
 * Приоритет ролей (§4.1): admin > manager > engineer > general_contractor >
 * contractor.
 *
 * Порядок задаёт, какая роль определяет ОБЛАСТЬ ВИДИМОСТИ при нескольких
 * ролях. Права при этом складываются: `admin` + `manager` даёт и
 * администрирование, и бизнес-согласование, потому что `hasPermission()`
 * смотрит на весь набор ролей.
 *
 * Генподрядчик стоит ниже инженера и выше подрядчика: его область шире
 * подрядческой (объект целиком, а не своя организация) и уже инженерной
 * (объекты выводятся из карточек, а не назначаются).
 */
const ROLE_PRIORITY: readonly UserRole[] = [
  'admin',
  'manager',
  'engineer',
  'general_contractor',
  'contractor',
];

type PrincipalRow = {
  id: string;
  kc_sub: string;
  email: string | null;
  full_name: string;
  position: string | null;
  is_active: boolean;
  contractor_id: string | null;
  roles: string[];
  object_ids: string[];
  /** Объекты, где организация пользователя названа генподрядчиком (0028). */
  gc_object_ids: string[];
  must_change_password: boolean | null;
};

/**
 * Область видимости пользователя.
 *
 * Одним запросом, а не тремя: он выполняется на каждом обращении к API, и три
 * round-trip'а к managed-кластеру на запрос — это заметная часть бюджета
 * `SLOW_REQUEST_MS` (§11).
 */
export async function buildScope(pool: Pool, userId: string): Promise<ScopeResolution> {
  const { rows } = await pool.query<PrincipalRow>(
    // Соединение с user_credentials аддитивно и стоит близко к нулю: оно идёт
    // по первичному ключу. Таблица существует во всех режимах, а строки в ней
    // есть только при AUTH_MODE=local, поэтому в остальных режимах колонка
    // всегда NULL и поведение не меняется.
    `select u.id, u.kc_sub, u.email, u.full_name, u.position, u.is_active, u.contractor_id,
            coalesce(array_agg(distinct r.role) filter (where r.role is not null),
                     '{}'::text[]) as roles,
            coalesce(array_agg(distinct s.object_id::text) filter (where s.object_id is not null),
                     '{}'::text[]) as object_ids,
            -- Область генподрядчика ВЫВОДИТСЯ из карточек объектов, а не
            -- назначается: второй источник той же истины разошёлся бы с первым
            -- молча — генподрядчика сменили в карточке, область осталась старой.
            coalesce(array_agg(distinct g.id::text) filter (where g.id is not null),
                     '{}'::text[]) as gc_object_ids,
            bool_or(c.must_change_password) as must_change_password
       from users u
       left join user_roles r on r.user_id = u.id
       left join user_object_scopes s on s.user_id = u.id
       left join user_credentials c on c.user_id = u.id
       left join construction_objects g
              on g.general_contractor_id = u.contractor_id and g.is_active
      where u.id = $1
      group by u.id`,
    [userId],
  );

  const row = rows[0];
  if (row === undefined) {
    return { granted: false, reason: 'unknown-user', user: null, roles: [], principal: null };
  }

  const user: PortalUser = {
    id: row.id,
    kcSub: row.kc_sub,
    email: row.email,
    fullName: row.full_name,
    position: row.position,
    isActive: row.is_active,
    contractorId: row.contractor_id,
  };

  const principal: AuthPrincipal = {
    user,
    // bool_or по левому соединению: NULL означает «локальных учётных данных
    // нет», а не «менять не нужно», но для проверки доступа это одно и то же.
    mustChangePassword: row.must_change_password === true,
    hasLocalCredentials: row.must_change_password !== null,
  };

  // Единственное место, где роль получает метку `PortalRole`: значение уже
  // прочитано из user_roles и проверено схемой домена.
  const roles: readonly PortalRole[] = row.roles
    .filter((role): role is UserRole => userRoleSchema.safeParse(role).success)
    .map((role) => role as PortalRole);

  if (!user.isActive) return { granted: false, reason: 'inactive', user, roles, principal };

  const primary = ROLE_PRIORITY.find((role) => roles.some((held) => held === role));
  if (primary === undefined) {
    return { granted: false, reason: 'no-business-role', user, roles, principal };
  }

  switch (primary) {
    case 'admin':
      return { granted: true, user, roles, principal, scope: { kind: 'admin', userId: user.id } };
    case 'manager':
      return { granted: true, user, roles, principal, scope: { kind: 'manager', userId: user.id } };
    case 'engineer':
      // Пустой список объектов — законная ситуация: инженер без назначений
      // ничего не видит. scopeWhere() превращает её в FALSE, а не в TRUE.
      return {
        granted: true,
        user,
        roles,
        principal,
        scope: { kind: 'engineer', userId: user.id, objectIds: row.object_ids },
      };
    case 'general_contractor':
      if (user.contractorId === null) {
        // Та же ошибка администрирования, что у подрядчика, и по той же
        // причине: организация — не только область видимости, но и то, от чьего
        // имени подаётся файл реестра. Придумать её за пользователя нельзя.
        return {
          granted: false,
          reason: 'contractor-without-organization',
          user,
          roles,
          principal,
        };
      }
      // Пустой список объектов — законное состояние: генподрядчик заведён, но
      // ни на одном объекте генподрядчиком ещё не назван.
      return {
        granted: true,
        user,
        roles,
        principal,
        scope: {
          kind: 'general_contractor',
          userId: user.id,
          objectIds: row.gc_object_ids,
          contractorId: user.contractorId,
        },
      };
    case 'contractor':
      if (user.contractorId === null) {
        // Ошибка администрирования, а не «видит всё»: подрядчик без организации
        // не имеет области видимости, и придумать её за него нельзя.
        return {
          granted: false,
          reason: 'contractor-without-organization',
          user,
          roles,
          principal,
        };
      }
      return {
        granted: true,
        user,
        roles,
        principal,
        scope: { kind: 'contractor', userId: user.id, contractorId: user.contractorId },
      };
  }
}

export interface AuthMiddlewareDeps {
  readonly pool: Pool;
  readonly sessions: SessionStore;
  readonly env: Env;
}

/**
 * Загрузка сессии и области видимости.
 *
 * Хук не отказывает в доступе: публичные маршруты (`/health/*`, `/auth/login`)
 * обязаны работать без сессии. Отказ — дело `requireAuth`.
 */
export function sessionContextHook(deps: AuthMiddlewareDeps): onRequestAsyncHookHandler {
  return async function loadAuthContext(request: FastifyRequest, reply: FastifyReply) {
    const raw = request.cookies[SESSION_COOKIE];
    if (raw === undefined) return;

    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) {
      clearSessionCookies(reply, deps.env);
      return;
    }

    const session = await deps.sessions.load(unsigned.value);
    if (session === null) {
      // Cookie есть, сессии нет: истекла или отозвана. Оставлять cookie —
      // значит гонять её на каждом запросе и получать 401 вместо страницы входа.
      clearSessionCookies(reply, deps.env);
      return;
    }

    request.authSession = await deps.sessions.touch(session);

    const resolution = await buildScope(deps.pool, session.userId);
    // Принципал выставляется ДО ветки отказа: пользователь без назначенной роли
    // всё равно обязан быть виден проверке «требуется смена пароля» — свежая
    // учётная запись с временным паролем ролей ещё не имеет.
    request.authPrincipal = resolution.principal;

    if (!resolution.granted) {
      request.authDenial = resolution.reason;
      return;
    }

    request.authContext = {
      session: request.authSession,
      user: resolution.user,
      roles: resolution.roles,
      scope: resolution.scope,
    };
  };
}

/**
 * CSRF: небезопасный метод требует заголовка с токеном (§4.1).
 *
 * Сверяется не cookie с cookie, а заголовок с `auth_sessions.csrf_hash`: при
 * double-submit-проверке «cookie равна заголовку» злоумышленник, умеющий
 * выставить cookie (поддомен, ответ прокси), проходит её насквозь. Хэш в БД
 * привязан к сессии, и подменить его снаружи нечем.
 */
export function csrfGuardHook(deps: AuthMiddlewareDeps): onRequestAsyncHookHandler {
  return function verifyCsrf(request: FastifyRequest) {
    if (!CSRF_PROTECTED_METHODS.includes(request.method)) return Promise.resolve();

    const session = request.authSession;
    // Без сессии защищать нечего: такой запрос упрётся в requireAuth и получит 401.
    if (session === null) return Promise.resolve();

    const header = request.headers[CSRF_HEADER];
    const presented = Array.isArray(header) ? header[0] : header;

    if (!deps.sessions.verifyCsrfToken(session, presented)) {
      return Promise.reject(
        forbidden('Запрос отклонён проверкой CSRF. Обновите страницу и повторите.', {
          slug: 'csrf',
          logDetail:
            presented === undefined
              ? `отсутствует заголовок ${CSRF_HEADER}`
              : 'CSRF-токен не совпал с хэшем сессии',
        }),
      );
    }
    return Promise.resolve();
  };
}

export function clearSessionCookies(reply: FastifyReply, env: Env): void {
  reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(env));
  reply.clearCookie(CSRF_COOKIE, csrfCookieOptions(env));
}

/**
 * Требование аутентификации на маршруте.
 *
 * Различает 401 и 403 по существу: 401 — сессии нет либо истекла, 403 — вход
 * состоялся, но прав в портале не назначено. Слитые в один статус, эти случаи
 * отправляют пользователя на бесконечный повторный вход.
 */
export function requireAuth(request: FastifyRequest): Promise<void> {
  if (request.authContext !== null) return Promise.resolve();

  if (request.authSession === null || request.authDenial === 'unknown-user') {
    return Promise.reject(unauthorized('Требуется вход в портал.'));
  }

  return Promise.reject(forbidden(denialMessage(request.authDenial)));
}

function denialMessage(reason: ScopeDenialReason | null): string {
  switch (reason) {
    case 'inactive':
      return 'Учётная запись отключена.';
    case 'contractor-without-organization':
      return 'Учётная запись подрядчика не привязана к организации. Обратитесь к администратору.';
    case 'no-business-role':
      return 'Права в портале не назначены. Обратитесь к администратору.';
    default:
      return 'Доступ запрещён.';
  }
}

/**
 * Контекст доступа в обработчике.
 *
 * Нужен потому, что типы Fastify объявляют `authContext` как возможный `null`:
 * без этой функции каждый обработчик начинался бы с собственной проверки, и
 * одна из них однажды оказалась бы `!`.
 */
export function currentAuth(request: FastifyRequest): AuthContext {
  const context = request.authContext;
  if (context === null) {
    // Признак ошибки сборки маршрута: обработчик защищённого эндпоинта
    // зарегистрирован без requireAuth.
    throw unauthorized('Требуется вход в портал.', {
      logDetail: 'обработчик обратился к authContext без preHandler requireAuth',
    });
  }
  return context;
}
