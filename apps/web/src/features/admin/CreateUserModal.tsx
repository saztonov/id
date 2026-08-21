/**
 * Создание учётной записи с локальным паролем (`AUTH_MODE=local`).
 *
 * Поля пароля здесь нет и быть не должно: пароль генерирует сервер и возвращает
 * один раз. Дать администратору задать пользователю известный себе пароль
 * значит дать возможность действовать от его имени, и никакой журнал этого не
 * различит — все действия будут выглядеть как действия владельца.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Form, Input, Modal, Select, Switch, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import type { UserRole } from '@id/contracts';

import { admin } from '../../api/endpoints.js';
import { describeError, isApiError } from '../../api/problem.js';
import { applyFieldErrors } from '../../shared/formErrors.js';

const ROLE_OPTIONS: readonly { value: UserRole; label: string }[] = [
  { value: 'contractor', label: 'подрядчик' },
  { value: 'engineer', label: 'инженер' },
  { value: 'manager', label: 'руководитель' },
  { value: 'admin', label: 'администратор' },
];

interface FormValues {
  email: string;
  fullName: string;
  position?: string;
  roles?: UserRole[];
  contractorId?: string;
  isActive: boolean;
}

export function CreateUserModal(props: {
  readonly open: boolean;
  readonly contractorOptions: readonly { value: string; label: string }[];
  readonly onClose: () => void;
  readonly onCreated: (result: { login: string; temporaryPassword: string }) => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [roles, setRoles] = useState<UserRole[]>([]);

  const create = useMutation({
    mutationFn: (values: FormValues) =>
      admin.createUser({
        email: values.email,
        fullName: values.fullName,
        ...(values.position === undefined || values.position === ''
          ? {}
          : { position: values.position }),
        ...(values.contractorId === undefined ? {} : { contractorId: values.contractorId }),
        ...(values.roles === undefined ? {} : { roles: values.roles }),
        isActive: values.isActive,
      }),
    onSuccess: (result, values) => {
      form.resetFields();
      setRoles([]);
      props.onCreated({ login: values.email, temporaryPassword: result.temporaryPassword });
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 422) {
        const unmapped = applyFieldErrors(form, error, [['contractorId'], ['roles']]);
        for (const text of unmapped) message.error(text);
        return;
      }
      message.error(describeError(error));
    },
  });

  // Подрядчик обязан иметь организацию: без неё у него нет области видимости и
  // он не увидит ни одной поставки. Сервер отвергает такое сочетание, форма
  // лишь подсказывает это раньше.
  const contractorSelected = roles.includes('contractor');

  return (
    <Modal
      open={props.open}
      title="Создать пользователя"
      onCancel={props.onClose}
      okText="Создать"
      confirmLoading={create.isPending}
      onOk={() => void form.submit()}
      destroyOnHidden
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ isActive: true }}
        onFinish={(values) => create.mutate(values)}
      >
        <Form.Item
          name="email"
          label="Адрес электронной почты"
          rules={[
            { required: true, message: 'Укажите адрес' },
            { type: 'email', message: 'Адрес указан неверно' },
          ]}
        >
          <Input type="email" autoComplete="off" data-testid="create-user-email" />
        </Form.Item>

        <Form.Item
          name="fullName"
          label="Фамилия, имя и отчество"
          rules={[{ required: true, message: 'Укажите ФИО' }]}
        >
          <Input autoComplete="off" data-testid="create-user-fullname" />
        </Form.Item>

        <Form.Item name="position" label="Должность">
          <Input autoComplete="off" />
        </Form.Item>

        <Form.Item name="roles" label="Роли">
          <Select<UserRole[]>
            mode="multiple"
            options={[...ROLE_OPTIONS]}
            onChange={setRoles}
            placeholder="Можно назначить позже"
            data-testid="create-user-roles"
          />
        </Form.Item>

        <Form.Item
          name="contractorId"
          label="Организация"
          extra={
            contractorSelected
              ? 'Подрядчику организация обязательна: без неё он не увидит ни одной поставки.'
              : undefined
          }
          rules={contractorSelected ? [{ required: true, message: 'Укажите организацию' }] : []}
        >
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            options={[...props.contractorOptions]}
            placeholder="Только для подрядчиков"
          />
        </Form.Item>

        <Form.Item name="isActive" label="Активировать сразу" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>

      <Typography.Text type="secondary">
        Пароль сгенерирует портал и покажет один раз. Передайте его пользователю лично: при первом
        входе портал потребует сменить пароль.
      </Typography.Text>
    </Modal>
  );
}
