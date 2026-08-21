/**
 * Смена пароля.
 *
 * Работает в двух положениях. Обычное — пользователь сам решил сменить пароль.
 * Принудительное (`forced`) — пароль выдан администратором, и портал закрыт до
 * смены: показывать в этом положении навигацию и кнопку «отмена» бессмысленно,
 * идти всё равно некуда.
 *
 * После успеха выполняется полная перезагрузка: смена пароля отзывает все
 * прочие сессии и выдаёт новую, а состояние SPA собрано вокруг прежней.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Alert, Button, Card, Form, Input, Typography } from 'antd';

import { auth as authApi } from '../../api/endpoints.js';
import { describeError, isApiError } from '../../api/problem.js';
import { applyFieldErrors } from '../../shared/formErrors.js';
import { passwordHints } from './passwordHints.js';

interface FormValues {
  currentPassword: string;
  newPassword: string;
  newPasswordConfirm: string;
}

export function ChangePasswordPage({ forced = false }: { forced?: boolean }): ReactNode {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [pending, setPending] = useState(false);

  async function submit(values: FormValues): Promise<void> {
    setPending(true);
    try {
      await authApi.changePassword(values.currentPassword, values.newPassword);
      // Перезагрузка, а не переход внутри SPA: прочие сессии отозваны, cookie
      // заменены, и состояние приложения нужно собрать заново от `/me`.
      window.location.assign('/');
    } catch (error) {
      setPending(false);
      if (isApiError(error) && error.status === 422) {
        // Сервер называет поле `/password`; в форме оно `newPassword`.
        const unmapped = applyFieldErrors(form, error, [['newPassword']]);
        for (const text of unmapped) message.error(text);
        return;
      }
      if (isApiError(error) && error.status === 401) {
        form.setFields([{ name: 'currentPassword', errors: ['Текущий пароль неверен'] }]);
        return;
      }
      message.error(describeError(error));
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 16px' }}>
      <Card style={{ width: '100%', maxWidth: 480 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Смена пароля
        </Typography.Title>

        {forced && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            data-testid="must-change-password"
            message="Требуется сменить выданный пароль"
            description={
              'Пароль, которым вы вошли, знаете не только вы: его выдал администратор. ' +
              'До смены работа в портале закрыта.'
            }
          />
        )}

        <Form<FormValues> form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="currentPassword"
            label="Текущий пароль"
            rules={[{ required: true, message: 'Введите текущий пароль' }]}
          >
            <Input.Password
              autoComplete="current-password"
              autoFocus
              data-testid="current-password"
            />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label="Новый пароль"
            extra={passwordHints(undefined)}
            rules={[{ required: true, message: 'Придумайте новый пароль' }]}
          >
            <Input.Password autoComplete="new-password" data-testid="new-password" />
          </Form.Item>

          <Form.Item
            name="newPasswordConfirm"
            label="Новый пароль ещё раз"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: 'Повторите новый пароль' },
              ({ getFieldValue }) => ({
                validator: (_rule, value: string) =>
                  value === getFieldValue('newPassword')
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
            data-testid="change-password-submit"
          >
            Сменить пароль
          </Button>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          После смены пароля все остальные сессии будут завершены.
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
