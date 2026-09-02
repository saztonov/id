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
 *
 * Сессия может кончиться и посреди работы — тогда 401 приходит не в `/me`, а в
 * запрос данных. За это отвечает `SessionGate`: транспорт объявляет конец сессии
 * (`api/unauthenticated.ts`), заслон подменяет дерево тем же экраном входа.
 */
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { App as AntApp, ConfigProvider, Result, Spin, Typography } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';

import { AppShell } from './AppShell.js';
import { resolveRoute, RouterProvider, useLocation, type RouteDefinition } from './router.js';
import { SessionProvider, useMeQuery } from './session.js';
import { session as sessionApi } from '../api/endpoints.js';
import { isApiError, isUnauthenticated } from '../api/problem.js';
import { isSessionLost, onUnauthenticated } from '../api/unauthenticated.js';
import { ErrorState } from '../shared/ui.js';
import { IdsScreen } from '../features/ids/IdsScreen.js';
import { ObjectScreen } from '../features/ids/ObjectScreen.js';
import { FolderScreen } from '../features/folder/FolderScreen.js';
import { CatalogScreen } from '../features/catalog/CatalogScreen.js';
import { AdminScreen } from '../features/admin/AdminScreen.js';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { RegisterPage } from '../features/auth/RegisterPage.js';
import { AppUpdateBanner } from './AppUpdateBanner.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { reportClientError } from './errorReporting.js';

/**
 * Клиент кэша.
 *
 * ## Повторов здесь нет вовсе, и это не упрощение
 *
 * До S24 стояло `retry: 1` — то есть повторялось ВСЁ, кроме 401: и 404, и 409,
 * и 412, и 429. Первые три бессмысленны (второй запрос получит тот же ответ), а
 * последний вреден: сервер прямым текстом просит перестать, а клиент удваивает
 * поток. Теперь повторами ведает `api/queue.ts` — там же, где темп и пауза по
 * `Retry-After`, и там же, где известна разница между «отвергнут до обработчика»
 * (429, повторять безопасно) и «исход неизвестен» (обрыв сети на мутации).
 *
 * Два слоя повторов не складываются, а перемножаются: три попытки очереди под
 * одной попыткой кэша дают шесть запросов вместо трёх. Поэтому здесь `false`.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
    mutations: { retry: 0 },
  },
  /**
   * В журнал уходят только НЕ серверные отказы.
   *
   * `ApiError` означает, что сервер ответил: пятисотые он уже записал сам, а
   * четырёхсотые — это отказ по праву или проверке, то есть штатная работа.
   * Докладывать о них с клиента значит удваивать одну ошибку в журнале и
   * заполнять его отказами доступа, которые ошибками не являются. Остаётся то,
   * чего сервер увидеть не может: исключение в коде запроса и обрыв сети.
   */
  queryCache: new QueryCache({
    onError: (error) => {
      if (!isApiError(error)) reportClientError(error, { kind: 'manual' });
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (!isApiError(error)) reportClientError(error, { kind: 'manual' });
    },
  }),
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
 * | `colorError` | `#ff4d4f` | `#cf1322` | 5.9:1 |
 *
 * `colorError` поднят на S18 и найден тем же способом — прогоном axe. Умолчание
 * antd даёт 3.1:1: разрушающее действие («Удалить» в справочнике) читалось хуже
 * всего остального на экране, притом что именно оно требует прочтения. Красный
 * при этом остаётся красным: понижена яркость, а не смысл.
 */
const THEME_TOKENS = {
  fontSize: 14,
  colorPrimary: '#0958d9',
  colorLink: '#0958d9',
  colorLinkHover: '#0b4ec0',
  colorInfo: '#0958d9',
  colorTextDescription: 'rgba(0, 0, 0, 0.62)',
  colorTextSecondary: 'rgba(0, 0, 0, 0.72)',
  colorError: '#cf1322',
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
  /**
   * Подсказка `Select` поднята по той же причине и найдена тем же способом —
   * прогоном axe (вкладка «Журнал ошибок», два фильтра). У `Select` подсказка
   * это НЕ нативный `placeholder`, а обычный текстовый узел: браузер его не
   * выделяет, axe проверяет как текст, и умолчание antd `rgba(0,0,0,.25)` даёт
   * 1.83:1. Глобально токен не трогается — у `Input` подсказка нативная, и её
   * оформление остаётся на усмотрение браузера.
   */
  Select: { colorTextPlaceholder: 'rgba(0, 0, 0, 0.62)' },
  /**
   * Подпись поля в `Descriptions` — третья находка того же класса и найдена тем
   * же способом: прогоном axe по вкладке «Проверка» после того, как карточка
   * согласования переехала туда с «Истории» (S24).
   *
   * Дефект не новый — он просто впервые попал под проверку: axe-сценария для
   * вкладки «История» в наборе нет, и `Descriptions` до сих пор жили только там.
   * Умолчание antd — `colorTextTertiary`, то есть `rgba(0,0,0,.45)`: 4.03:1 на
   * белом при требуемых 4.5:1 (WCAG AA, 1.4.3).
   *
   * Подпись здесь — не украшение: «Статус», «Подана», «Решение» и «Состав (хэш)»
   * — единственное, что отличает четыре соседних значения друг от друга, и
   * прочитать их обязано быть можно.
   */
  Descriptions: { colorTextTertiary: 'rgba(0, 0, 0, 0.62)' },
} as const;

const ROUTES: readonly RouteDefinition[] = [
  { pattern: '/', render: () => <IdsScreen /> },
  { pattern: '/ids', render: () => <IdsScreen /> },
  {
    pattern: '/ids/objects/:objectId',
    render: (params) => <ObjectScreen objectId={params['objectId'] ?? ''} />,
  },
  {
    pattern: '/ids/folders/:folderId',
    render: (params) => <FolderScreen folderId={params['folderId'] ?? ''} />,
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

  // Заслон стоит НИЖЕ форм входа намеренно: 401 от запроса, ушедшего до
  // перехода на форму, иначе подменил бы саму форму предложением войти.
  return (
    <SessionGate>
      <Authenticated />
    </SessionGate>
  );
}

/**
 * Единственный экран «войдите» на оба случая.
 *
 * Их два: 401 на первом `/me` — сессии не было; 401 в середине работы — сессия
 * кончилась. Показывать разное было бы враньём: делать надо одно и то же, — а
 * две копии одного `Result` неизбежно разъезжаются.
 */
function LoginRequired(): ReactNode {
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

/**
 * Подмена дерева экраном входа, когда сессия кончилась в середине работы.
 *
 * ## Почему заслон, а не обработка в каждом экране
 *
 * 401 приходит сразу во все запросы открытого экрана. Разобранный по панелям,
 * он даёт горсть красных карточек, из которых непонятно, что делать; собранный
 * в одном месте — один экран с одной ссылкой. До S45 не было и этого: истёкшая
 * сессия выглядела поломкой портала, а разлогин человек осознавал после F5.
 *
 * ## Почему не редирект
 *
 * `location.assign('/auth/login')` увёл бы немедленно, потеряв несохранённую
 * разметку и не объяснив, что случилось. Ссылка оставляет решение за человеком
 * и несёт `returnTo` — после входа он вернётся на тот же экран.
 *
 * ## Почему кэш чистится ПОСЛЕ подмены дерева
 *
 * `clear()` при живых наблюдателях немедленно запускает перезапросы, то есть
 * вторую волну 401 ровно тогда, когда человек тянется к ссылке «Войти».
 * Сначала состояние — дерево размонтировано, наблюдателей нет, — потом
 * очистка. Чистить обязательно: данные прошлой сессии не должны пережить вход
 * под другой учётной записью.
 */
function SessionGate({ children }: { children: ReactNode }): ReactNode {
  // Начальное значение читается из модуля, а не берётся `false`: StrictMode
  // монтирует дважды, и 401, объявленный между монтированиями, иначе потерялся
  // бы вместе с первой подпиской.
  const [lost, setLost] = useState(isSessionLost);
  const queryClient = useQueryClient();

  useEffect(
    () =>
      onUnauthenticated(() => {
        setLost(true);
      }),
    [],
  );

  useEffect(() => {
    if (!lost) return;
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [lost, queryClient]);

  if (lost) return <LoginRequired />;
  return children;
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
    // Путь холодного старта: сессии не было вовсе. Срабатывает синхронно, не
    // дожидаясь эффекта заслона, — экран тот же самый.
    if (isUnauthenticated(me.error)) return <LoginRequired />;
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
          {/*
            Граница отрисовки охватывает и вход: исключение на экране логина
            гасило бы портал до того, как пользователь может о нём сообщить.
          */}
          <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <RouterProvider>
                {/*
                  Плашка обновления стоит вне `Authenticated`: устаревшая
                  страница входа — тот же устаревший бандл, и обновиться до
                  входа дешевле, чем посреди работы.
                */}
                <AppUpdateBanner />
                <Root />
              </RouterProvider>
            </QueryClientProvider>
          </ErrorBoundary>
        </AntApp>
      </ConfigProvider>
    </StrictMode>
  );
}
