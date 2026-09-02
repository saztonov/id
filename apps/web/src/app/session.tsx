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
  'markup.edit': ['contractor', 'general_contractor', 'engineer', 'admin'],
  'recognition.start': ['contractor', 'general_contractor', 'engineer', 'admin'],
  'document.edit': ['engineer', 'manager'],
  'checks.run': ['engineer', 'manager'],
  'pipeline.run': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'registry.manage': ['general_contractor', 'admin'],
  'registry.accept': ['engineer', 'manager'],
  'folder.approve': ['engineer', 'manager'],
  'folder.return': ['engineer', 'manager'],
  'folder.override': ['manager'],
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
  /**
   * Действует ли неизменяемость §3.9 (S24).
   *
   * Рядом с `can`, потому что отвечает на такой же вопрос — «можно ли это
   * действие», — но по другой причине: `can` смотрит на роль, а это на режим
   * работы портала. Смешивать их в одном предикате было бы ошибкой: отказ по
   * праву и отказ по неизменяемости чинятся по-разному, и объяснять их надо
   * разными словами.
   */
  readonly immutabilityEnforced: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Пульс сессии: раз в 15 минут.
 *
 * Сессия портала скользящая — окно простоя двигает ЛЮБОЙ запрос к API
 * (`sessionContextHook` → `SessionStore.touch()`). Но портал на спокойном
 * экране к API не ходит вовсе: `refetchOnWindowFocus` выключен глобально,
 * данные держит `staleTime`, а единственный фоновый опрос идёт на
 * `/version.json`, то есть на статику. Человек, читающий комплект на двести
 * страниц, для сервера неотличим от закрытой вкладки — и получал 401 на первом
 * же действии. Ровно так выглядели перелогины с интервалом полтора-два часа.
 *
 * Отдельного эндпоинта пульс не требует: `/me` уже проходит тот же хук, то есть
 * продлевает окно самим фактом обращения, и он же — единственный запрос, чей
 * 401 приводит к экрану входа. Лишним запросом это не становится: один вызов на
 * вкладку в 15 минут против `RATE_LIMIT_MAX=300` в минуту.
 *
 * Вечной сессию пульс не делает: `SESSION_ABSOLUTE_HOURS` не двигает ничто —
 * ни запрос, ни пульс, — и `touch()` прижимает окно к этому потолку.
 */
const KEEPALIVE_MS = 15 * 60_000;

export function useMeQuery(): UseQueryResult<Me, unknown> {
  return useQuery({
    queryKey: ['me'],
    queryFn: session.me,
    // 401 — это не сбой сети, а «войдите»: повторять запрос бессмысленно.
    retry: (failureCount, error) => !isUnauthenticated(error) && failureCount < 2,
    staleTime: KEEPALIVE_MS,
    refetchInterval: KEEPALIVE_MS,
    // Свёрнутая вкладка обязана продолжать перепроверку: иначе сессия умирает
    // молча, и человек узнаёт об этом первым же действием — то есть потеряв то,
    // что в этот момент делал.
    refetchIntervalInBackground: true,
    // Только у этого запроса; глобальное умолчание (`App.tsx`) остаётся `false`.
    // Возврат к вкладке — самый частый момент, когда сессия уже могла кончиться,
    // и ждать до конца интервала, чтобы это заметить, незачем. Тем же приёмом
    // пользуется `AppUpdateBanner`: интервал — подстраховка, основной сигнал —
    // внимание человека.
    refetchOnWindowFocus: true,
  });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }): ReactNode {
  const value: SessionValue = {
    me,
    immutabilityEnforced: me.immutabilityEnforced,
    can: (permission) => hasPermission(me.roles, permission),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('Компонент вне SessionProvider');
  return value;
}
