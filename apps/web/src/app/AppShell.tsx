/**
 * Каркас портала: навигация, сведения о вошедшем, область экрана.
 *
 * ## Accessibility (часть гейта §17)
 *
 * * ссылка «к содержимому» первым элементом фокуса — иначе клавиатурный
 *   пользователь проходит всю навигацию на каждом переходе;
 * * `<nav>`, `<main id="main">`, `<header>` — ориентиры для скринридера;
 * * активный раздел помечен `aria-current="page"`, а не только цветом;
 * * `lang="ru"` стоит в `index.html`: без него синтезатор читает русский текст
 *   английскими правилами.
 *
 * Роли влияют только на состав меню. Право проверяет сервер (§4.1): скрытая
 * ссылка не защищает раздел, она избавляет от перехода, который кончится 403.
 */
import { type ReactNode } from 'react';
import { Layout, Space, Typography } from 'antd';
import { Link, useLocation } from './router.js';
import { useSession, type Permission } from './session.js';
import { session as sessionApi } from '../api/endpoints.js';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly permission: Permission | null;
}

const NAV: readonly NavItem[] = [
  { to: '/ids', label: 'ИД', permission: 'submission.read' },
  { to: '/catalog', label: 'Справочники', permission: null },
  { to: '/admin', label: 'Администрирование', permission: 'settings.manage' },
];

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const { me, can } = useSession();
  const { pathname } = useLocation();

  const visible = NAV.filter((item) => item.permission === null || can(item.permission));

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

      <Layout.Header
        style={{
          background: '#001529',
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          paddingInline: 16,
        }}
      >
        <Typography.Text style={{ color: '#ffffff', fontWeight: 600 }}>
          Исполнительная документация
        </Typography.Text>

        <nav aria-label="Основная навигация">
          <ul
            style={{
              display: 'flex',
              gap: 16,
              listStyle: 'none',
              margin: 0,
              padding: 0,
            }}
          >
            {visible.map((item) => {
              const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
              return (
                <li key={item.to}>
                  <Link to={item.to} aria-current={active ? 'page' : undefined}>
                    <span
                      style={{
                        color: '#ffffff',
                        borderBottom: active ? '2px solid #ffffff' : '2px solid transparent',
                        paddingBottom: 2,
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {item.label}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <Space style={{ marginLeft: 'auto' }}>
          <Typography.Text style={{ color: '#d9d9d9' }} data-testid="current-user">
            {me.user.fullName} ({me.roles.join(', ') || 'без ролей'})
          </Typography.Text>
          <button
            type="button"
            onClick={() => {
              void sessionApi.logout().then((response) => {
                // Адрес front-channel logout выполняется переходом браузера:
                // иначе SSO-cookie провайдера остаётся цела и следующий вход
                // проходит без пароля — то есть выход не выполнен. Раньше
                // ответ игнорировался и портал всегда уходил на «/».
                // В локальном режиме провайдера нет, и адрес приходит null.
                window.location.assign(response.data.endSessionUrl ?? '/');
              });
            }}
            style={{
              background: 'transparent',
              color: '#ffffff',
              border: '1px solid #ffffff',
              borderRadius: 4,
              padding: '2px 10px',
              cursor: 'pointer',
            }}
          >
            Выйти
          </button>
        </Space>
      </Layout.Header>

      {/*
        `Layout.Content` сам разворачивается в `<main>`. Вложенный `<main>`
        внутри него давал ДВА ориентира `main` на странице, и скринридер терял
        единственную точку «основное содержимое». Поэтому `id` вешается на сам
        Content, а не на второй элемент внутри него.
      */}
      <Layout.Content id="main" style={{ padding: 16 }}>
        {children}
      </Layout.Content>
    </Layout>
  );
}
