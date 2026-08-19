/**
 * Маршрутизация SPA.
 *
 * Своя, а не библиотечная, и это осознанный выбор, а не экономия. Порталу нужны
 * ровно три вещи: разбор пути в параметры, ссылка, не перезагружающая страницу,
 * и переход из обработчика. Всё остальное, что даёт роутер (вложенные
 * загрузчики данных, действия форм, ленивая подгрузка сегментов), в портале
 * закрыто TanStack Query и точками входа экранов. Зависимость ради ста строк —
 * это ещё одна версия в списке §2, которую придётся сверять с React 19 при
 * каждом обновлении.
 *
 * Ссылка остаётся НАСТОЯЩЕЙ `<a href>`: средний клик, «открыть в новой вкладке»
 * и чтение адреса скринридером обязаны работать. Перехватывается только простой
 * левый клик без модификаторов — ровно так же, как это делает любой роутер.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

export interface Location {
  readonly pathname: string;
  readonly search: string;
}

interface RouterValue {
  readonly location: Location;
  readonly navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentLocation(): Location {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function RouterProvider({ children }: { children: ReactNode }): ReactNode {
  const [location, setLocation] = useState<Location>(currentLocation);

  useEffect(() => {
    const onPop = (): void => {
      setLocation(currentLocation());
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (options?.replace === true) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setLocation(currentLocation());
  }, []);

  const value = useMemo<RouterValue>(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (value === null) throw new Error('Компонент вне RouterProvider');
  return value;
}

export function useLocation(): Location {
  return useRouter().location;
}

export function useNavigate(): RouterValue['navigate'] {
  return useRouter().navigate;
}

export function useQueryParam(name: string): string | null {
  const { search } = useLocation();
  return new URLSearchParams(search).get(name);
}

export interface LinkProps {
  readonly to: string;
  readonly children: ReactNode;
  readonly title?: string | undefined;
  readonly 'aria-current'?: 'page' | undefined;
}

export function Link({ to, children, ...rest }: LinkProps): ReactNode {
  const navigate = useNavigate();
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    // Модификаторы и не-левая кнопка отдаются браузеру: «открыть в новой
    // вкладке» пользователь ждёт от любой ссылки, и ломать это нельзя.
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}

// =====================================================================
// Сопоставление пути с шаблоном
// =====================================================================

export type RouteParams = Readonly<Record<string, string>>;

/**
 * Сопоставление `/revisions/:revisionId/markup` с фактическим путём.
 *
 * Возвращает параметры либо `null`. Регулярное выражение не строится:
 * посегментное сравнение короче, читается без экранирования и не даёт
 * катастрофического бэктрекинга на длинном адресе.
 */
export function matchPath(pattern: string, pathname: string): RouteParams | null {
  const patternParts = pattern.split('/').filter((part) => part !== '');
  const pathParts = pathname.split('/').filter((part) => part !== '');
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i] ?? '';
    const actual = pathParts[i] ?? '';
    if (expected.startsWith(':')) {
      if (actual === '') return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export interface RouteDefinition {
  readonly pattern: string;
  readonly render: (params: RouteParams) => ReactNode;
}

/**
 * Выбор первого подошедшего маршрута.
 *
 * Порядок значим и задаётся таблицей: конкретный путь обязан стоять раньше
 * шаблона с параметром, иначе `/ids/new` совпадёт с `/ids/:id`.
 */
export function resolveRoute(
  routes: readonly RouteDefinition[],
  pathname: string,
): { route: RouteDefinition; params: RouteParams } | null {
  for (const route of routes) {
    const params = matchPath(route.pattern, pathname);
    if (params !== null) return { route, params };
  }
  return null;
}
