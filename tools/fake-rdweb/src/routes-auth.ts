/**
 * Сессионная аутентификация двойника — по модели `routes/auth.py`.
 *
 * У legacy RD WEB нет ни OIDC, ни внешнего провайдера: пара токенов выдаётся самим
 * сервисом по email/паролю служебной учётки. Адаптер портала обязан уметь ровно это,
 * поэтому двойник повторяет форму `TokenResponse`/`MeResponse` и коды отказов, а не
 * «какой-нибудь» вход.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { HttpError, unauthorized, unprocessable } from './errors.js';
import { PORTAL_TENANT_ID, type FakeState, type UserRecord } from './state.js';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

const loginSchema = z.object({
  tenant_id: z.string().regex(idPattern).nullish(),
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

const refreshSchema = z.object({
  tenant_id: z.string().regex(idPattern).nullish(),
  refresh_token: z.string().min(1).max(4096),
});

const logoutSchema = z.object({
  tenant_id: z.string().regex(idPattern).nullish(),
  refresh_token: z.string().min(1).max(4096).nullish(),
});

/** Разбор тела через zod: отказ обязан быть 422 с телом `{detail}`, как у FastAPI. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? 'body';
    throw unprocessable(`${path}: ${first?.message ?? 'некорректное тело запроса'}`);
  }
  return parsed.data;
}

interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  user_id: string;
  system_role: string;
}

function issueTokens(state: FakeState, user: UserRecord): IssuedTokens {
  const sessionId = state.newId('sess');
  const accessToken = state.newId('at');
  const refreshToken = state.newId('rt');
  state.accessTokens.set(accessToken, {
    userId: user.userId,
    sessionId,
    epoch: state.tokenEpoch,
    expiresAtMs: Date.now() + state.accessTtlSec * 1000,
  });
  state.refreshTokens.set(refreshToken, { userId: user.userId, sessionId });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: state.accessTtlSec,
    user_id: user.userId,
    system_role: user.systemRole,
  };
}

/**
 * Текущий пользователь по заголовку `Authorization: Bearer`.
 *
 * Три причины отказа (нет заголовка / неизвестный токен / протухший) намеренно дают
 * один и тот же 401: у оригинала они тоже неразличимы снаружи, и адаптер обязан
 * реагировать на код, а не на текст.
 */
export function requireUser(state: FakeState, request: FastifyRequest): UserRecord {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
    throw unauthorized('Требуется Bearer-токен');
  }
  const token = header.slice('bearer '.length).trim();
  const record = state.accessTokens.get(token);
  if (record === undefined) {
    throw unauthorized('Недействительный токен');
  }
  if (record.epoch !== state.tokenEpoch || record.expiresAtMs <= Date.now()) {
    state.accessTokens.delete(token);
    throw unauthorized('Срок действия токена истёк');
  }
  const user = [...state.users.values()].find((u) => u.userId === record.userId);
  if (user === undefined) {
    throw unauthorized('Недействительный токен');
  }
  return user;
}

export function registerAuthRoutes(app: FastifyInstance, state: FakeState): void {
  app.post('/api/auth/login', async (request) => {
    const body = parseBody(loginSchema, request.body);
    const user = state.users.get(body.email.toLowerCase());
    if (user === undefined || user.password !== body.password) {
      throw new HttpError(401, 'Неверный email или пароль');
    }
    return issueTokens(state, user);
  });

  app.post('/api/auth/refresh', async (request) => {
    const body = parseBody(refreshSchema, request.body);
    const session = state.refreshTokens.get(body.refresh_token);
    if (session === undefined) {
      throw new HttpError(401, 'Недействительный refresh-токен');
    }
    const user = [...state.users.values()].find((u) => u.userId === session.userId);
    if (user === undefined) {
      throw new HttpError(401, 'Недействительный refresh-токен');
    }
    // Одноразовость: старый refresh гасится, чтобы повторный обмен тем же токеном
    // не проходил незаметно (у оригинала сессия ротируется на каждом обмене).
    state.refreshTokens.delete(body.refresh_token);
    return issueTokens(state, user);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const body = parseBody(logoutSchema, request.body);
    if (typeof body.refresh_token === 'string') {
      state.refreshTokens.delete(body.refresh_token);
    }
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request) => {
    const user = requireUser(state, request);
    return {
      tenant_id: PORTAL_TENANT_ID,
      user_id: user.userId,
      email: user.email,
      system_role: user.systemRole,
    };
  });
}
