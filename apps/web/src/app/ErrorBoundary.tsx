/**
 * Граница отрисовки: исключение в компоненте не должно гасить весь портал.
 *
 * До её появления любое исключение при отрисовке приводило к белому экрану:
 * React 19 размонтирует всё дерево, если ошибку никто не поймал. Пользователь
 * видел пустую страницу, а портал не узнавал о поломке вовсе — ни строки в
 * журнале, ни следа в метриках.
 *
 * ## Пользователю показывается `clientEventId`, а не `requestId`
 *
 * У ошибки отрисовки нет запроса, и обещать номер запроса значило бы обещать
 * пустое место. Идентификатор события генерируется здесь же и уходит в журнал
 * тем же отчётом — по нему поддержка находит запись, даже если отправка отчёта
 * не удалась и остался только номер на экране пользователя.
 *
 * Классовый компонент, потому что `componentDidCatch` и
 * `getDerivedStateFromError` в хуках не существуют: это единственный способ
 * перехватить исключение отрисовки в React.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result, Typography } from 'antd';
import { reportClientError } from './errorReporting.js';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
  readonly eventId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, eventId: null };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const eventId = reportClientError(error, {
      kind: 'render',
      // Стек компонентов — имена компонентов, не данные пользователя. Без него
      // по минифицированному стеку невозможно понять, какой экран сломался.
      ...(info.componentStack === null || info.componentStack === undefined
        ? {}
        : { componentStack: info.componentStack }),
    });
    this.setState({ eventId });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <Result
        status="error"
        title="Страница не отрисовалась"
        subTitle={
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            Ошибка записана в журнал портала. Если обращаетесь в поддержку, назовите номер события:{' '}
            <Typography.Text copyable code data-testid="client-event-id">
              {this.state.eventId ?? 'номер не присвоен'}
            </Typography.Text>
          </Typography.Paragraph>
        }
        extra={
          // Перезагрузка, а не «попробовать снова»: состояние, приведшее к
          // исключению, осталось в памяти вкладки, и повторная отрисовка того
          // же дерева упала бы снова.
          <Button type="primary" onClick={() => location.reload()}>
            Перезагрузить страницу
          </Button>
        }
      />
    );
  }
}
