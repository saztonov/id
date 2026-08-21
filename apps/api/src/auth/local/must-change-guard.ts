/**
 * Ограничение доступа до смены выданного пароля.
 *
 * Пароль, выданный администратором или сброшенный им, знает как минимум один
 * человек кроме владельца. Пока он не сменён, учётная запись не должна ничего
 * делать в портале — иначе «временный» пароль живёт годами, а действия под ним
 * невозможно приписать конкретному человеку.
 *
 * Хук опирается на `request.authPrincipal`, а НЕ на `authContext`: контекст
 * заполняется только при успешном разрешении области видимости, а свежая
 * учётная запись с временным паролем ролей ещё не имеет. Флаг, прочитанный из
 * контекста, не сработал бы ровно там, где он нужен.
 *
 * Регистрируется только при `AUTH_MODE=local`: в остальных режимах паролем
 * портал не распоряжается.
 */
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

import { forbidden } from '../../lib/problem.js';

/**
 * Что доступно до смены пароля.
 *
 * Список закрытый и намеренно короткий: `/me` нужен интерфейсу, чтобы понять,
 * куда вести пользователя; выход обязан работать всегда; CSRF-токен нужен,
 * чтобы отправить форму смены; сама смена — цель. Всё остальное — работа в
 * портале, которой не должно быть.
 */
const ALLOWED: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'GET', path: '/me' },
  { method: 'GET', path: '/api/v1/auth/config' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'POST', path: '/auth/csrf' },
  { method: 'POST', path: '/api/v1/auth/password' },
];

/** Проверки состояния обязаны работать независимо от чьих-либо паролей. */
const ALLOWED_PREFIXES: readonly string[] = ['/health'];

function isAllowed(request: FastifyRequest): boolean {
  // Путь берётся без строки запроса: `/me?x=1` — тот же маршрут.
  const path = request.url.split('?')[0] ?? '';

  if (ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return true;
  }
  return ALLOWED.some((entry) => entry.method === request.method && entry.path === path);
}

export function mustChangePasswordGuard(): onRequestAsyncHookHandler {
  return function requirePasswordChange(request: FastifyRequest) {
    const principal = request.authPrincipal;
    if (principal === null || !principal.mustChangePassword) return Promise.resolve();
    if (isAllowed(request)) return Promise.resolve();

    return Promise.reject(
      forbidden('Требуется смена выданного пароля.', {
        slug: 'forbidden',
        logDetail: 'доступ до смены временного пароля',
      }),
    );
  };
}
