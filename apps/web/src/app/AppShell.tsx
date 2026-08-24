/**
 * Каркас портала: боковое меню, сведения о вошедшем, область экрана.
 *
 * ## Почему меню боковое и сворачиваемое
 *
 * Разделов три, и они плоские — вкладки внутри раздела несут вторую ось.
 * Горизонтальная полоса под три пункта расходовала высоту экрана там, где
 * основное содержимое — таблицы и рабочее место ревизии на весь холст.
 * Свёрнутое состояние оставляет 56 пикселей под иконки и запоминается: человек
 * настраивает его один раз, а не на каждой загрузке.
 *
 * ## Accessibility (часть гейта §17)
 *
 * * ссылка «к содержимому» первым элементом фокуса — иначе клавиатурный
 *   пользователь проходит всю навигацию на каждом переходе;
 * * `<nav>`, `<main id="main">`, `<header>` — ориентиры для скринридера. Боковая
 *   колонка сделана именно `<header>`, а не `Layout.Sider` из antd: тот
 *   разворачивается в `<aside>`, то есть в `complementary`, и портал терял бы
 *   ориентир `banner` — точку перехода «шапка сайта», в которой лежат его имя,
 *   навигация и сведения о вошедшем. Анимации свёртки и точки перелома у
 *   `Sider` здесь всё равно не используются;
 * * активный раздел помечен `aria-current="page"`, а не только цветом;
 * * навигация остаётся списком ссылок, а НЕ `Menu` из antd: у того роли
 *   `menu`/`menuitem`, предназначенные для меню приложения, и axe справедливо
 *   считает их неуместными для навигации сайта. Тот же урок уже записан во
 *   вкладках администрирования;
 * * в свёрнутом состоянии название раздела остаётся в разметке визуально
 *   скрытым: иконка без доступного имени для скринридера нема, а `title` его
 *   не заменяет;
 * * `lang="ru"` стоит в `index.html`: без него синтезатор читает русский текст
 *   английскими правилами.
 *
 * Роли влияют только на состав меню. Право проверяет сервер (§4.1): скрытая
 * ссылка не защищает раздел, она избавляет от перехода, который кончится 403.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Layout, Typography } from 'antd';
import { Link, useLocation } from './router.js';
import { useSession, type Permission } from './session.js';
import { session as sessionApi } from '../api/endpoints.js';
import { onRateLimitPause, pausedUntilMs } from '../api/queue.js';
import { CatalogIcon, DocumentIcon, SettingsIcon } from '../shared/icons.js';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly permission: Permission | null;
  readonly icon: ReactNode;
}

const NAV: readonly NavItem[] = [
  { to: '/ids', label: 'ИД', permission: 'submission.read', icon: <DocumentIcon /> },
  { to: '/catalog', label: 'Справочники', permission: null, icon: <CatalogIcon /> },
  {
    to: '/admin',
    label: 'Администрирование',
    permission: 'settings.manage',
    icon: <SettingsIcon />,
  },
];

/**
 * Ключ запомненного состояния.
 *
 * Значение живёт в браузере пользователя и портала не касается: это удобство, а
 * не настройка. Чтение и запись обёрнуты в `try`, потому что в приватном окне
 * само обращение к `localStorage` бросает.
 */
const COLLAPSED_KEY = 'id.nav.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    // Не записалось — состояние просто не переживёт перезагрузку.
  }
}

const SIDEBAR_BACKGROUND = '#001529';
const SIDEBAR_TEXT = '#ffffff';
const SIDEBAR_MUTED = '#c8ced8';

/** Видимый только скринридеру текст: имя пункта в свёрнутом меню. */
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const { me, can } = useSession();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const visible = NAV.filter((item) => item.permission === null || can(item.permission));

  const toggle = (): void => {
    setCollapsed((previous) => {
      storeCollapsed(!previous);
      return !previous;
    });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <a
        href="#main"
        style={{
          position: 'absolute',
          left: -10000,
          top: 'auto',
          width: 1,
          height: 1,
          overflow: 'hidden',
          zIndex: 10,
        }}
        onFocus={(event) => {
          Object.assign(event.currentTarget.style, {
            position: 'static',
            width: 'auto',
            height: 'auto',
            padding: '8px 12px',
          });
        }}
        onBlur={(event) => {
          Object.assign(event.currentTarget.style, {
            position: 'absolute',
            left: '-10000px',
            width: '1px',
            height: '1px',
          });
        }}
      >
        Перейти к содержимому
      </a>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <header
          style={{
            flex: `0 0 ${collapsed ? '56px' : '240px'}`,
            background: SIDEBAR_BACKGROUND,
            display: 'flex',
            flexDirection: 'column',
            padding: '12px 8px',
            gap: 12,
            overflow: 'hidden',
          }}
        >
          <Typography.Text
            style={{
              color: SIDEBAR_TEXT,
              fontWeight: 600,
              padding: '0 8px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {collapsed ? 'ИД' : 'Исполнительная документация'}
          </Typography.Text>

          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            data-testid="nav-toggle"
            style={{
              background: 'transparent',
              color: SIDEBAR_TEXT,
              border: `1px solid ${SIDEBAR_MUTED}`,
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              alignSelf: collapsed ? 'center' : 'flex-start',
              marginInline: collapsed ? 0 : 8,
            }}
          >
            {collapsed ? '»' : '«'}
          </button>

          <nav aria-label="Основная навигация">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {visible.map((item) => {
                const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
                return (
                  <li key={item.to}>
                    <Link to={item.to} aria-current={active ? 'page' : undefined}>
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          color: SIDEBAR_TEXT,
                          background: active ? 'rgba(255, 255, 255, 0.16)' : 'transparent',
                          borderRadius: 4,
                          padding: '8px 10px',
                          fontWeight: active ? 600 : 400,
                          justifyContent: collapsed ? 'center' : 'flex-start',
                        }}
                      >
                        {item.icon}
                        {collapsed ? (
                          <span style={VISUALLY_HIDDEN}>{item.label}</span>
                        ) : (
                          <span style={{ whiteSpace: 'nowrap' }}>{item.label}</span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div
            style={{
              marginTop: 'auto',
              borderTop: `1px solid ${SIDEBAR_MUTED}`,
              paddingTop: 12,
              display: 'grid',
              gap: 8,
            }}
          >
            <Typography.Text
              style={{
                color: SIDEBAR_MUTED,
                fontSize: 12,
                padding: '0 8px',
                overflowWrap: 'anywhere',
              }}
              data-testid="current-user"
            >
              {collapsed
                ? me.user.fullName.trim().slice(0, 1) || '?'
                : `${me.user.fullName} (${me.roles.join(', ') || 'без ролей'})`}
            </Typography.Text>
            <button
              type="button"
              onClick={() => {
                void sessionApi.logout().then((response) => {
                  // Адрес front-channel logout выполняется переходом браузера:
                  // иначе SSO-cookie провайдера остаётся цела и следующий вход
                  // проходит без пароля — то есть выход не выполнен.
                  // В локальном режиме провайдера нет, и адрес приходит null.
                  window.location.assign(response.data.endSessionUrl ?? '/');
                });
              }}
              style={{
                background: 'transparent',
                color: SIDEBAR_TEXT,
                border: `1px solid ${SIDEBAR_TEXT}`,
                borderRadius: 4,
                padding: '4px 10px',
                cursor: 'pointer',
                marginInline: 8,
              }}
            >
              {collapsed ? '⏻' : 'Выйти'}
              {collapsed && <span style={VISUALLY_HIDDEN}>Выйти</span>}
            </button>
          </div>
        </header>

        {/*
        `Layout.Content` сам разворачивается в `<main>`. Вложенный `<main>`
        внутри него давал ДВА ориентира `main` на странице, и скринридер терял
        единственную точку «основное содержимое». Поэтому `id` вешается на сам
          Content, а не на второй элемент внутри него.
        */}
        <Layout.Content id="main" style={{ padding: 16, flex: 1, minWidth: 0 }}>
          <TestingModeNotice />
          <RateLimitNotice />
          {children}
        </Layout.Content>
      </div>
    </Layout>
  );
}

/**
 * Портал придержал обновления по требованию сервера.
 *
 * Отдельная полоса, а не ошибка экрана, и это не смягчение формулировки.
 * Ответ 429 не означает, что данные недоступны: то, что уже показано, остаётся
 * годным — обновление просто задержится на названное сервером время. Прежнее
 * поведение подменяло весь экран красным «Не удалось получить данные», то есть
 * отнимало у пользователя работающую страницу за то, что портал слишком часто
 * спрашивал сервер. Виноват при этом был клиент, а расплачивался человек.
 *
 * Полоса живёт в оболочке, а не на экране ревизии: бюджет запросов общий на весь
 * API (ключ лимита — адрес), поэтому пауза касается и каталога, и справочников,
 * и любого другого открытого экрана.
 */
function RateLimitNotice(): ReactNode {
  const [until, setUntil] = useState(() => pausedUntilMs());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => onRateLimitPause(setUntil), []);

  useEffect(() => {
    if (until === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(timer);
    };
  }, [until]);

  const leftMs = until - now;
  if (until === 0 || leftMs <= 0) return null;

  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 12 }}
      data-testid="rate-limit-notice"
      message="Портал притормаживает обновление данных"
      description={`Слишком много запросов подряд. Показанное на экране остаётся верным; обновление продолжится через ${String(Math.ceil(leftMs / 1000))} с.`}
    />
  );
}

/**
 * Неизменяемость данных отключена.
 *
 * Плашка висит всё время, пока режим включён, и закрыть её нельзя. Это не
 * навязчивость: в этом режиме поданный комплект перестаёт быть неприкосновенным
 * — файл удаляется из ревизии, которую уже отправили на согласование, а
 * согласовать можно комплект, не прошедший ни одной проверки. Признак, который
 * надо искать в настройках, здесь бесполезен: узнать о режиме обязан каждый, кто
 * работает в портале, а не только тот, кто его включал.
 *
 * Отдельно от `RateLimitNotice`, хотя обе живут в оболочке: та говорит о том,
 * что сейчас происходит, и исчезает сама, а эта — о том, как настроен портал.
 */
function TestingModeNotice(): ReactNode {
  const { immutabilityEnforced } = useSession();
  if (immutabilityEnforced) return null;

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      data-testid="testing-mode-notice"
      message="Режим тестирования: неизменяемость данных отключена"
      description={
        'Состав поданных комплектов правится, файлы и ревизии удаляются, а препятствия ' +
        'согласованию показываются, но не запрещают действие. Конвейер тоже не запрещает: ' +
        'повторное выделение блоков перезаписывает разметку вместо новой ревизии, повторное ' +
        'распознавание заменяет прежний результат, а неполное покрытие публикуется частично. ' +
        'Перед боевой эксплуатацией включите настройку «Неизменяемость поданных данных» на ' +
        'странице «Администрирование».'
      }
    />
  );
}
