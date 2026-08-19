/**
 * Общие состояния экрана: загрузка, отказ, пусто, недоступно.
 *
 * Четыре состояния, а не три. «Недоступно» отделено от «пусто» намеренно и
 * является прямым выводом из журнала исполнения: экран, который на отсутствующий
 * источник данных показывает пустую таблицу, выглядит работающим и когда данных
 * нет, и когда за ним нет ничего. Ровно так восемь этапов подряд выглядел код,
 * который написан и не подключён.
 */
import type { ReactNode } from 'react';
import { Alert, Empty, Result, Spin, Typography } from 'antd';
import { describeError, isApiError } from '../api/problem.js';

export function LoadingState({ label }: { label?: string }): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ padding: 32, display: 'flex', justifyContent: 'center', gap: 12 }}
    >
      <Spin />
      <span>{label ?? 'Загрузка…'}</span>
    </div>
  );
}

/**
 * Отказ обращения к API.
 *
 * Идентификатор запроса показывается, когда сервер его прислал: §11 делает
 * `request_id` сквозным именно ради того, чтобы пользователь мог назвать
 * поддержке одно значение вместо пересказа.
 */
export function ErrorState({ error, title }: { error: unknown; title?: string }): ReactNode {
  const requestId = isApiError(error) ? error.requestId : null;
  return (
    <Alert
      type="error"
      showIcon
      message={title ?? 'Не удалось получить данные'}
      description={
        <>
          <div>{describeError(error)}</div>
          {requestId !== null && (
            <Typography.Text type="secondary" copyable>
              {requestId}
            </Typography.Text>
          )}
        </>
      }
    />
  );
}

export function EmptyState({ label }: { label: string }): ReactNode {
  return <Empty description={label} />;
}

/**
 * Раздел, за которым нет маршрута API или нет прав.
 *
 * Причина названа, а не свёрнута в одно «недоступно»: «маршрута нет» чинит
 * разработчик, «прав нет» — администратор портала, и путать эти два ответа
 * значит отправлять человека не туда. Путь показывается в обоих случаях: это
 * то единственное, что пользователь может назвать поддержке.
 */
export function UnavailableState({
  route,
  what,
  reason = 'route-missing',
  detail = null,
}: {
  route: string;
  what: string;
  reason?: 'route-missing' | 'forbidden';
  detail?: string | null;
}): ReactNode {
  return (
    <Result
      status="info"
      title={
        reason === 'forbidden' ? `${what}: недоступно по правам` : `${what}: раздел недоступен`
      }
      subTitle={
        <>
          <div>
            {reason === 'forbidden'
              ? (detail ??
                'Маршрут есть, но текущая роль не даёт к нему доступа. Это не пустой список — это отказ в правах.')
              : 'В API портала нет маршрута, который отдаёт эти данные. Это не пустой список — это отсутствующий источник.'}
          </div>
          <Typography.Text code>{route}</Typography.Text>
        </>
      }
    />
  );
}

/**
 * Ограничение модели данных, объяснённое на месте.
 *
 * Отдельно от `ErrorState`: это не сбой и не отказ в правах, а свойство, при
 * котором действие невозможно ПО ПОСТРОЕНИЮ. Молчаливо выключенная кнопка
 * оставляла бы пользователя гадать, сломано ли оно; здесь названа причина.
 */
export function ExplainedLimitation({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  return (
    <Alert
      type="warning"
      showIcon
      message={title}
      description={children}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    />
  );
}

/** Заголовок раздела: один уровень h1 на страницу, остальное — h2. */
export function ScreenHeading({ title, extra }: { title: string; extra?: ReactNode }): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
        flexWrap: 'wrap',
      }}
    >
      <Typography.Title level={1} style={{ fontSize: 22, margin: 0 }}>
        {title}
      </Typography.Title>
      {extra}
    </div>
  );
}
