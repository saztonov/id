/**
 * Сессия портала на стороне SPA (§4.1).
 *
 * Здесь нет ни хранилища токенов, ни разбора JWT: браузер получает только
 * идентификатор сессии в `HttpOnly` cookie, а `GET /me` отвечает, кто вошёл,
 * какие у него роли и область видимости. Это единственный источник правды о
 * правах на экране.
 *
 * Права на клиенте — исключительно вопрос того, что показывать. Решение
 * принимает сервер: у каждого маршрута свой `requirePermission`, а изоляция
 * держится ещё и областью видимости в репозитории. Спрятанная кнопка не
 * защищает ничего и не заменяет проверку — она избавляет пользователя от
 * нажатия, которое заведомо кончится 403.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { UserRole } from '@id/contracts';
import { session } from '../api/endpoints.js';
import { isUnauthenticated } from '../api/problem.js';
import type { Me } from '../api/types.js';

/**
 * Матрица прав, дословно повторяющая `PERMISSIONS` из
 * `apps/api/src/middleware/require-permission.ts`.
 *
 * Копия неизбежна — сервер её наружу не отдаёт, — поэтому она собрана в одном
 * месте и подписана источником: расхождение чинится сверкой двух файлов, а не
 * обходом экранов. Копия слабее оригинала по определению: она отвечает на
 * вопрос «показывать ли кнопку», а не «разрешено ли действие».
 */
export const PERMISSIONS = {
  'submission.read': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'submission.upload': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'submission.submit': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'markup.read': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'markup.edit': ['contractor', 'general_contractor', 'engineer'],
  'markup.freeze': ['contractor', 'general_contractor', 'engineer'],
  'recognition.start': ['contractor', 'general_contractor', 'engineer'],
  'document.edit': ['engineer', 'manager'],
  'checks.run': ['engineer', 'manager'],
  'pipeline.run': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'registry.manage': ['general_contractor', 'admin'],
  'registry.accept': ['engineer', 'manager'],
  'revision.approve': ['engineer', 'manager'],
  'revision.return': ['engineer', 'manager'],
  'revision.override': ['manager'],
  'archive.download': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'users.manage': ['admin'],
  'settings.manage': ['admin'],
  'rules.publish': ['admin'],
  'doc_types.manage': ['admin'],
  'diagnostics.read': ['admin'],
  'audit.read': ['admin'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(roles: readonly UserRole[], permission: Permission): boolean {
  const allowed: readonly UserRole[] = PERMISSIONS[permission];
  return roles.some((role) => allowed.includes(role));
}

export interface SessionValue {
  readonly me: Me;
  readonly can: (permission: Permission) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useMeQuery(): UseQueryResult<Me, unknown> {
  return useQuery({
    queryKey: ['me'],
    queryFn: session.me,
    // 401 — это не сбой сети, а «войдите»: повторять запрос бессмысленно.
    retry: (failureCount, error) => !isUnauthenticated(error) && failureCount < 2,
    staleTime: 60_000,
  });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }): ReactNode {
  const value: SessionValue = {
    me,
    can: (permission) => hasPermission(me.roles, permission),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('Компонент вне SessionProvider');
  return value;
}
