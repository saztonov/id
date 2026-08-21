/**
 * Форма входа (`AUTH_MODE=local`).
 *
 * Рисуется ДО проверки сессии: страница входа не может требовать входа.
 * Развилка живёт в `App.tsx`, здесь — только форма.
 *
 * Три вещи, которые легко испортить и которые здесь сделаны намеренно:
 *
 *   1. `autoComplete` расставлен так, чтобы менеджер паролей понял форму, а
 *      вставка из буфера НЕ перехвачена. Запрет вставки не мешает подбору
 *      пароля — он мешает пользоваться длинным сгенерированным паролем, то есть
 *      подталкивает к короткому, который человек помнит.
 *   2. Отказ показывается одной строкой без уточнений. Сервер намеренно не
 *      различает «нет такого пользователя» и «неверный пароль», и интерфейс не
 *      должен додумывать разницу за него.
 *   3. После успеха выполняется полная перезагрузка, а не переход внутри SPA:
 *      cookie сессии только что выставлены, и `/me` нужно запросить с нуля.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { App as AntApp, Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';

import { auth as authApi } from '../../api/endpoints.js';
import { isApiError } from '../../api/problem.js';
import { Link, useQueryParam } from '../../app/router.js';
import { safeReturnTo } from './returnTo.js';

interface FormValues {
  email: string;
  password: string;
}

export function LoginPage(): ReactNode {
  const { message } = AntApp.useApp();
  const returnTo = safeReturnTo(useQueryParam('returnTo'));
  const [failure, setFailure] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  // Доступность регистрации приходит от сервера: угадывать её по коду ответа на
  // попытку нельзя — «404 на POST» и «регистрация выключена» это разное.
  const config = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => authApi.config(),
    staleTime: Infinity,
    retry: false,
  });

  // Обратный отсчёт до конца блокировки: «повторите позже» без числа
  // бесполезно, а число, не убывающее на глазах, выглядит сломанным.
  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const timer = setTimeout(() => {
      setRetryAfter((value) => (value === null || value <= 1 ? null : value - 1));
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [retryAfter]);

  async function submit(values: FormValues): Promise<void> {
    setFailure(null);
    setRetryAfter(null);
    setPending(true);
    try {
      const { redirectTo } = await authApi.login(values.email, values.password, returnTo);
      // Полная перезагрузка: cookie уже выставлены, состояние SPA нужно собрать
      // заново от `/me`.
      window.location.assign(redirectTo);
    } catch (error) {
      setPending(false);
      handleFailure(error);
    }
  }

  function handleFailure(error: unknown): void {
    if (!isApiError(error)) {
      message.error('Не удалось связаться с порталом.');
      return;
    }

    if (error.status === 429) {
      const seconds = Number(error.problem?.detail?.match(/\d+/u)?.[0] ?? '');
      setRetryAfter(Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
      setFailure(
        'Слишком много попыток входа. Учётная запись временно заблокирована — ' +
          'дождитесь окончания паузы либо обратитесь к администратору.',
      );
      return;
    }
    if (error.status === 403) {
      setFailure(
        error.problem?.detail ??
          'Учётная запись ещё не активирована. Обратитесь к администратору портала.',
      );
      return;
    }
    // Единственный текст на все остальные отказы: сервер намеренно не различает
    // «нет такого пользователя» и «неверный пароль».
    setFailure('Неверный логин или пароль.');
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 16px' }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Вход в портал ИД
        </Typography.Title>

        {failure !== null && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            data-testid="login-error"
            message={failure}
            description={
              retryAfter === null ? undefined : `Повторить можно через ${String(retryAfter)} с.`
            }
          />
        )}

        <Form<FormValues> layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="email"
            label="Логин или адрес почты"
            rules={[{ required: true, message: 'Укажите логин' }]}
          >
            {/* Поле НЕ объявлено `type="email"` намеренно: браузер проверяет
                такие поля сам и отказывается отправлять форму со значением без
                собаки — а логином может быть не адрес (встроенный `admin`).
                Сервер формат тоже не проверяет: вход принимает любую строку от
                трёх символов. Проверять адрес обязана регистрация, и там это
                поле объявлено адресом. */}
            <Input autoComplete="username" autoFocus size="large" data-testid="login-email" />
          </Form.Item>

          <Form.Item
            name="password"
            label="Пароль"
            rules={[{ required: true, message: 'Введите пароль' }]}
          >
            {/* Вставка из буфера не перехватывается намеренно: запрет мешает
                пользоваться менеджером паролей, а подбору — нет. */}
            <Input.Password
              autoComplete="current-password"
              size="large"
              data-testid="login-password"
            />
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={pending}
            disabled={retryAfter !== null}
            data-testid="login-submit"
          >
            Войти
          </Button>
        </Form>

        {config.data?.registrationEnabled === true && (
          <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
            Нет учётной записи? <Link to="/register">Подать заявку</Link>
          </Typography.Paragraph>
        )}
      </Card>
    </div>
  );
}
