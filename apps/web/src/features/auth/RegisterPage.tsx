/**
 * Заявка на регистрацию (`AUTH_MODE=local`).
 *
 * Форма создаёт ЗАЯВКУ, а не учётную запись: адрес при регистрации никем не
 * подтверждён, и заявку мог подать кто угодно на чужой адрес. Личность
 * подтверждает администратор вне портала, и он же решает, принять выбранный
 * пароль или выдать временный.
 *
 * Ответ сервера одинаков для нового адреса, для уже поданной заявки и для
 * существующего пользователя — иначе форма регистрации превращается в способ
 * узнать, заведён ли в портале конкретный человек. Интерфейс эту одинаковость
 * обязан сохранять: показывать «такой адрес уже есть» здесь нечего, потому что
 * сервер этого и не сообщает.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Button, Card, Form, Input, Result, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';

import { auth as authApi } from '../../api/endpoints.js';
import { describeError, isApiError } from '../../api/problem.js';
import { applyFieldErrors } from '../../shared/formErrors.js';
import { Link } from '../../app/router.js';
import { passwordHints } from './passwordHints.js';

interface FormValues {
  email: string;
  fullName: string;
  position?: string;
  password: string;
  passwordConfirm: string;
}

export function RegisterPage(): ReactNode {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  const config = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => authApi.config(),
    staleTime: Infinity,
    retry: false,
  });

  async function submit(values: FormValues): Promise<void> {
    setPending(true);
    try {
      await authApi.register({
        email: values.email,
        fullName: values.fullName,
        ...(values.position === undefined || values.position === ''
          ? {}
          : { position: values.position }),
        password: values.password,
      });
      setSubmitted(true);
    } catch (error) {
      // 422 — единственный отказ, который что-то говорит о введённом: он про
      // пароль и ничего не сообщает об учётных записях портала.
      if (isApiError(error) && error.status === 422) {
        const unmapped = applyFieldErrors(form, error, [['password']]);
        for (const text of unmapped) message.error(text);
      } else {
        message.error(describeError(error));
      }
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 16px' }}>
        <Result
          status="success"
          title="Заявка принята"
          subTitle={
            'Администратор портала проверит данные и заведёт учётную запись. ' +
            'Пароль для первого входа он передаст вам лично.'
          }
          extra={<Link to="/login">Вернуться ко входу</Link>}
          data-testid="register-submitted"
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 16px' }}>
      <Card style={{ width: '100%', maxWidth: 480 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Заявка на доступ к порталу ИД
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          Учётную запись заводит администратор портала после проверки данных.
        </Typography.Paragraph>

        <Form<FormValues> form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="email"
            label="Адрес электронной почты"
            rules={[
              { required: true, message: 'Укажите адрес' },
              { type: 'email', message: 'Адрес указан неверно' },
            ]}
          >
            <Input type="email" autoComplete="username" autoFocus data-testid="register-email" />
          </Form.Item>

          <Form.Item
            name="fullName"
            label="Фамилия, имя и отчество"
            rules={[{ required: true, message: 'Укажите ФИО' }]}
          >
            <Input autoComplete="name" data-testid="register-fullname" />
          </Form.Item>

          <Form.Item name="position" label="Должность">
            <Input autoComplete="organization-title" />
          </Form.Item>

          <Form.Item
            name="password"
            label="Пароль"
            extra={passwordHints(config.data?.passwordMinLength)}
            rules={[{ required: true, message: 'Придумайте пароль' }]}
          >
            <Input.Password autoComplete="new-password" data-testid="register-password" />
          </Form.Item>

          <Form.Item
            name="passwordConfirm"
            label="Пароль ещё раз"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Повторите пароль' },
              ({ getFieldValue }) => ({
                validator: (_rule, value: string) =>
                  value === getFieldValue('password')
                    ? Promise.resolve()
                    : Promise.reject(new Error('Пароли не совпадают')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            block
            loading={pending}
            data-testid="register-submit"
          >
            Подать заявку
          </Button>
        </Form>

        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          Уже есть доступ? <Link to="/login">Войти</Link>
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
