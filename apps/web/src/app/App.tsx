/**
 * Точка сборки приложения: провайдеры, вход, таблица маршрутов.
 *
 * ## Вход
 *
 * `GET /me` — единственный способ узнать, есть ли сессия. 401 означает «войдите»,
 * и SPA не пытается это скрыть: показывается экран с переходом на
 * `/auth/login?returnTo=...`, то есть на BFF, а не на Keycloak напрямую. Адрес
 * провайдера в браузере не фигурирует, `state`, `nonce` и PKCE остаются на
 * сервере (§4.1).
 *
 * 403 с `denial` — это другой случай: вход состоялся, а бизнес-ролей нет.
 * Показывается именно это, потому что «войдите ещё раз» отправило бы человека в
 * бесконечный цикл входа.
 */
import { StrictMode, type ReactNode } from 'react';
import { App as AntApp, ConfigProvider, Result, Spin, Typography } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AppShell } from './AppShell.js';
import { resolveRoute, RouterProvider, useLocation, type RouteDefinition } from './router.js';
import { SessionProvider, useMeQuery } from './session.js';
import { session as sessionApi } from '../api/endpoints.js';
import { isUnauthenticated } from '../api/problem.js';
import { ErrorState } from '../shared/ui.js';
import { IdsScreen } from '../features/ids/IdsScreen.js';
import { ObjectVolumesScreen } from '../features/ids/ObjectVolumesScreen.js';
import { VolumeSubmissionsScreen } from '../features/ids/VolumeSubmissionsScreen.js';
import { RevisionScreen } from '../features/revision/RevisionScreen.js';
import { CatalogScreen } from '../features/catalog/CatalogScreen.js';
import { AdminScreen } from '../features/admin/AdminScreen.js';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { RegisterPage } from '../features/auth/RegisterPage.js';

/**
 * Клиент кэша.
 *
 * `retry: 1` — компромисс, а не значение по умолчанию: мутации портала
 * идемпотентны по `Idempotency-Key` только там, где ключ передаётся, поэтому
 * автоповторы держатся на минимуме, а 401 и 403 не повторяются вовсе.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !isUnauthenticated(error) && failureCount < 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
    mutations: { retry: 0 },
  },
});

/**
 * Токены темы, поднятые до WCAG 2.1 AA (§17).
 *
 * Значения antd по умолчанию не проходят автоматическую проверку контраста, и
 * это не придирка axe: `#1677ff` на белом даёт 3.6:1 при требуемых 4.5:1 для
 * обычного текста, а вторичный текст `rgba(0,0,0,0.45)` — 3.4:1. В портале
 * вторичным текстом набраны подписи под значениями и пояснения к действиям,
 * то есть ровно то, что читают внимательно.
 *
 * Меняются только цвета, а не палитра целиком: antd выводит из `colorPrimary`
 * десяток производных, и подмена всей темы стоила бы согласованности с
 * компонентами, которые портал не переопределяет.
 *
 * | Токен | Было | Стало | Контраст на белом |
 * |---|---|---|---|
 * | `colorPrimary` | `#1677ff` | `#0958d9` | 6.2:1 |
 * | `colorLink` | `#1677ff` | `#0958d9` | 6.2:1 |
 * | `colorTextDescription` | `rgba(0,0,0,.45)` | `rgba(0,0,0,.62)` | 5.9:1 |
 * | `colorTextSecondary` | `rgba(0,0,0,.65)` | `rgba(0,0,0,.72)` | 7.5:1 |
 */
const THEME_TOKENS = {
  fontSize: 14,
  colorPrimary: '#0958d9',
  colorLink: '#0958d9',
  colorLinkHover: '#0b4ec0',
  colorInfo: '#0958d9',
  colorTextDescription: 'rgba(0, 0, 0, 0.62)',
  colorTextSecondary: 'rgba(0, 0, 0, 0.72)',
} as const;

/**
 * Токены отдельных компонентов.
 *
 * `Table.colorTextDisabled` поднят ради ОДНОЙ строки — надписи пустой таблицы
 * («Задач нет»). antd красит её `colorTextDisabled` = `rgba(0,0,0,.25)`, то
 * есть 1.83:1: сообщение о том, что данных нет, читается хуже всего остального
 * на экране. Глобально этот токен не трогается — им же красится текст
 * ВЫКЛЮЧЕННЫХ элементов управления, а выключенность обязана быть видна как
 * приглушённость (и из требований контраста WCAG она исключена).
 */
const THEME_COMPONENTS = {
  Table: { colorTextDisabled: 'rgba(0, 0, 0, 0.62)' },
} as const;

const ROUTES: readonly RouteDefinition[] = [
  { pattern: '/', render: () => <IdsScreen /> },
  { pattern: '/ids', render: () => <IdsScreen /> },
  {
    pattern: '/ids/objects/:objectId',
    render: (params) => <ObjectVolumesScreen objectId={params['objectId'] ?? ''} />,
  },
  {
    pattern: '/ids/volumes/:volumeId',
    render: (params) => <VolumeSubmissionsScreen volumeId={params['volumeId'] ?? ''} />,
  },
  {
    pattern: '/ids/revisions/:revisionId',
    render: (params) => <RevisionScreen revisionId={params['revisionId'] ?? ''} />,
  },
  { pattern: '/catalog', render: () => <CatalogScreen /> },
  { pattern: '/admin', render: () => <AdminScreen /> },
];

function Routes(): ReactNode {
  const { pathname } = useLocation();
  const match = resolveRoute(ROUTES, pathname);
  if (match === null) {
    return (
      <Result
        status="404"
        title="Страница не найдена"
        subTitle={<Typography.Text code>{pathname}</Typography.Text>}
      />
    );
  }
  return match.route.render(match.params);
}

/**
 * Внешняя развилка приложения.
 *
 * Страницы входа, заявки и смены пароля рисуются ДО проверки сессии: страница
 * входа не может требовать входа. Внутри `Authenticated` их разместить нельзя —
 * туда попадают только после успешного `/me`.
 *
 * Маршруты присутствуют во всех режимах: в федеративном `/auth/login` ведёт к
 * провайдеру и до `/login` дело не доходит, а прямой заход покажет форму,
 * которая честно ответит отказом — маршрутов локального входа в приложении нет.
 */
function Root(): ReactNode {
  const { pathname } = useLocation();

  if (pathname === '/login') return <LoginPage />;
  if (pathname === '/register') return <RegisterPage />;

  return <Authenticated />;
}

function Authenticated(): ReactNode {
  const me = useMeQuery();

  if (me.isPending) {
    return (
      <div role="status" aria-live="polite" style={{ padding: 48, textAlign: 'center' }}>
        <Spin /> <span>Проверка сессии…</span>
      </div>
    );
  }

  if (me.isError) {
    if (isUnauthenticated(me.error)) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      return (
        <Result
          status="403"
          title="Требуется вход в портал"
          subTitle="Токены в браузер не передаются: портал работает на серверной сессии."
          extra={
            // Ссылка одна на все режимы: в локальном `/auth/login` отвечает
            // перенаправлением на форму портала, в федеративном — к провайдеру.
            <a href={sessionApi.loginUrl(returnTo)} data-testid="login-link">
              Войти
            </a>
          }
        />
      );
    }
    return <ErrorState error={me.error} title="Не удалось проверить сессию" />;
  }

  // Пароль выдан администратором: до смены портал закрыт, и увести туда должен
  // интерфейс — иначе пользователь получит 403 в первом же запросе данных и
  // увидит его как непонятную ошибку. Проверка стоит ДО разбора прав: у свежей
  // учётной записи ролей ещё нет.
  if (me.data.mustChangePassword) return <ChangePasswordPage forced />;

  if (me.data.scope === null) {
    return (
      <Result
        status="warning"
        title="Права в портале не назначены"
        subTitle={denialText(me.data.denial)}
      />
    );
  }

  return (
    <SessionProvider me={me.data}>
      <AppShell>
        <Routes />
      </AppShell>
    </SessionProvider>
  );
}

function denialText(denial: string | null): string {
  switch (denial) {
    case 'inactive':
      return 'Учётная запись отключена. Обратитесь к администратору портала.';
    case 'contractor-without-organization':
      return 'Учётная запись подрядчика не привязана к организации.';
    case 'no-business-role':
      return 'Роль в портале ещё не назначена. Обратитесь к администратору.';
    default:
      return 'Обратитесь к администратору портала.';
  }
}

export function App(): ReactNode {
  return (
    <StrictMode>
      <ConfigProvider locale={ruRU} theme={{ token: THEME_TOKENS, components: THEME_COMPONENTS }}>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <RouterProvider>
              <Root />
            </RouterProvider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>
    </StrictMode>
  );
}
