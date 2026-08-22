/**
 * Очередь заявок на регистрацию (`AUTH_MODE=local`).
 *
 * Заявка — это намерение получить доступ, а не пользователь: адрес при
 * регистрации никем не подтверждён, и подать её мог кто угодно на чужой адрес.
 * Поэтому одобрение — не «нажать ОК», а решение о том, кому именно принадлежит
 * этот адрес.
 *
 * Отсюда два действия вместо одного. **«Одобрить с временным паролем»** —
 * основное: портал выдаёт пароль, администратор передаёт его человеку лично, и
 * сама эта передача подтверждает личность. **«Принять пароль заявителя»** —
 * вторичное: допустимо, когда личность подтверждена иначе, и выбор пишется в
 * журнал. Умолчание намеренно то, которое безопаснее.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Button, Form, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserRole } from '@id/contracts';

import { admin, catalog } from '../../api/endpoints.js';
import { describeError, isApiError } from '../../api/problem.js';
import type { RegistrationRequest } from '../../api/types.js';
import { applyFieldErrors } from '../../shared/formErrors.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { TemporaryPasswordModal } from './TemporaryPasswordModal.js';

const ROLE_OPTIONS: readonly { value: UserRole; label: string }[] = [
  { value: 'contractor', label: 'подрядчик' },
  { value: 'general_contractor', label: 'генподрядчик (ПТО)' },
  { value: 'engineer', label: 'инженер' },
  { value: 'manager', label: 'руководитель' },
  { value: 'admin', label: 'администратор' },
];

const REQUESTS_KEY = ['admin', 'registration-requests'] as const;

interface ApproveValues {
  roles: UserRole[];
  contractorId?: string;
}

export function RegistrationRequestsPanel(): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState<RegistrationRequest | null>(null);
  const [issued, setIssued] = useState<{ login: string; password: string } | null>(null);

  const requests = useQuery({
    queryKey: REQUESTS_KEY,
    queryFn: () => admin.registrationRequests(),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
  };

  const reject = useMutation({
    mutationFn: (input: { id: string; reason?: string }) =>
      admin.rejectRegistration(input.id, input.reason),
    onSuccess: async () => {
      message.success('Заявка отклонена');
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (requests.isPending) return <LoadingState />;
  if (requests.isError) return <ErrorState error={requests.error} />;

  return (
    <>
      <Table<RegistrationRequest>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={requests.data}
        locale={{ emptyText: 'Нерассмотренных заявок нет' }}
        columns={[
          { title: 'ФИО', dataIndex: 'fullName', key: 'fullName' },
          { title: 'Почта', dataIndex: 'email', key: 'email' },
          {
            title: 'Должность',
            dataIndex: 'position',
            key: 'position',
            render: (value: string | null) => value ?? '—',
          },
          {
            title: 'Подана',
            dataIndex: 'createdAt',
            key: 'createdAt',
            render: (value: string) => new Date(value).toLocaleString('ru-RU'),
          },
          {
            title: 'Пароль',
            key: 'password',
            render: (_value, row) =>
              row.hasRequestedPassword ? (
                <Tag>выбран заявителем</Tag>
              ) : (
                <Tag color="orange">не задан</Tag>
              ),
          },
          {
            title: 'Решение',
            key: 'actions',
            render: (_value, row) => (
              <Space wrap>
                <Button
                  type="primary"
                  size="small"
                  onClick={() => setApproving(row)}
                  data-testid={`approve-${row.id}`}
                >
                  Одобрить
                </Button>
                <Button
                  size="small"
                  danger
                  loading={reject.isPending}
                  onClick={() => reject.mutate({ id: row.id })}
                >
                  Отклонить
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <ApproveModal
        request={approving}
        onClose={() => setApproving(null)}
        onApproved={(result) => {
          setApproving(null);
          if (result.temporaryPassword !== null) {
            setIssued({ login: result.login, password: result.temporaryPassword });
          } else {
            message.success('Учётная запись создана с паролем заявителя');
          }
          void invalidate();
        }}
      />

      <TemporaryPasswordModal
        password={issued?.password ?? null}
        login={issued?.login ?? ''}
        onClose={() => setIssued(null)}
      />
    </>
  );
}

function ApproveModal(props: {
  readonly request: RegistrationRequest | null;
  readonly onClose: () => void;
  readonly onApproved: (result: { login: string; temporaryPassword: string | null }) => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<ApproveValues>();
  const [roles, setRoles] = useState<UserRole[]>([]);
  const request = props.request;

  const counterparties = useQuery({
    queryKey: ['catalog', 'counterparties', 'contractor'],
    queryFn: () => catalog.counterparties({ kind: 'contractor' }),
    enabled: request !== null,
  });

  const approve = useMutation({
    mutationFn: (input: { values: ApproveValues; credential: 'temporary' | 'as-requested' }) => {
      if (request === null) throw new Error('заявка не выбрана');
      return admin.approveRegistration(request.id, {
        roles: input.values.roles,
        ...(input.values.contractorId === undefined
          ? {}
          : { contractorId: input.values.contractorId }),
        credential: input.credential,
      });
    },
    onSuccess: (result) => {
      form.resetFields();
      setRoles([]);
      props.onApproved({
        login: request?.email ?? '',
        temporaryPassword: result.temporaryPassword,
      });
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

  async function submit(credential: 'temporary' | 'as-requested'): Promise<void> {
    const values = await form.validateFields();
    approve.mutate({ values, credential });
  }

  const contractorSelected = roles.includes('contractor') || roles.includes('general_contractor');

  return (
    <Modal
      open={request !== null}
      title={`Одобрить заявку: ${request?.fullName ?? ''}`}
      onCancel={props.onClose}
      destroyOnHidden
      footer={
        <Space wrap>
          <Button onClick={props.onClose}>Отмена</Button>
          <Button
            disabled={request?.hasRequestedPassword !== true}
            loading={approve.isPending}
            onClick={() => void submit('as-requested')}
            data-testid="approve-as-requested"
          >
            Принять пароль заявителя
          </Button>
          <Button
            type="primary"
            loading={approve.isPending}
            onClick={() => void submit('temporary')}
            data-testid="approve-temporary"
          >
            Одобрить с временным паролем
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Адрес заявителя портал не проверял. Передача временного пароля лично и есть подтверждение
        личности; принимать пароль заявителя стоит только если личность подтверждена иначе.
      </Typography.Paragraph>

      <Form<ApproveValues> form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="roles"
          label="Роли"
          rules={[{ required: true, message: 'Назначьте хотя бы одну роль' }]}
        >
          <Select<UserRole[]>
            mode="multiple"
            options={[...ROLE_OPTIONS]}
            onChange={setRoles}
            data-testid="approve-roles"
          />
        </Form.Item>

        <Form.Item
          name="contractorId"
          label="Организация"
          extra={
            contractorSelected
              ? 'Без организации у него нет области видимости: он не увидит ни одного комплекта.'
              : undefined
          }
          rules={contractorSelected ? [{ required: true, message: 'Укажите организацию' }] : []}
        >
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            options={(counterparties.data?.items ?? []).map((party) => ({
              value: party.id,
              label: party.name,
            }))}
            placeholder="Только для подрядчиков"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
