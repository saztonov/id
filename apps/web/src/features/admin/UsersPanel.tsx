/**
 * Пользователи, роли и области видимости (§4.1, §14).
 *
 * Роль `contractor` не совмещается с другими — это требование сервера
 * (`userRolesBodySchema`), и причина названа там же: при нескольких ролях один
 * человек и подаёт поставку, и согласует её. Форма подсказывает это ДО отправки,
 * но не является защитой: отвергает сервер.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Button, Input, Select, Space, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserRole } from '@id/contracts';
import { admin, catalog } from '../../api/endpoints.js';
import { adminKeys, catalogKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { PortalUser } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';

const ROLES: readonly UserRole[] = ['contractor', 'engineer', 'manager', 'admin'];

const ROLE_LABELS: Record<UserRole, string> = {
  contractor: 'подрядчик',
  engineer: 'инженер',
  manager: 'руководитель',
  admin: 'администратор',
};

export function UsersPanel(): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const users = useQuery({
    queryKey: adminKeys.users(search),
    queryFn: () => admin.users(search === '' ? undefined : search),
  });
  const objects = useQuery({
    queryKey: catalogKeys.objects(''),
    queryFn: () => catalog.objects({}),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: adminKeys.users(search) });
  };

  const setRoles = useMutation({
    mutationFn: (input: { userId: string; roles: UserRole[] }) =>
      admin.setRoles(input.userId, input.roles),
    onSuccess: async () => {
      message.success('Роли сохранены');
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const setScopes = useMutation({
    mutationFn: (input: { userId: string; objectIds: string[] }) =>
      admin.setObjectScopes(input.userId, input.objectIds),
    onSuccess: async () => {
      message.success('Области видимости сохранены');
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const toggleActive = useMutation({
    mutationFn: (input: { userId: string; activate: boolean }) =>
      input.activate ? admin.activate(input.userId) : admin.deactivate(input.userId),
    onSuccess: async () => {
      message.success('Состояние учётной записи изменено');
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (users.isPending) return <LoadingState />;
  if (users.isError) return <ErrorState error={users.error} />;

  const objectOptions = (objects.data?.items ?? []).map((object) => ({
    value: object.id,
    label: `${object.code} — ${object.name}`,
  }));

  return (
    <>
      <Input.Search
        allowClear
        placeholder="Поиск по ФИО и адресу почты"
        onSearch={setSearch}
        style={{ maxWidth: 360, marginBottom: 12 }}
        aria-label="Поиск пользователя"
      />
      <Table<PortalUser>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={users.data.items}
        locale={{ emptyText: 'Пользователей нет' }}
        expandable={{
          expandedRowKeys: expanded === null ? [] : [expanded],
          onExpand: (open, row) => setExpanded(open ? row.id : null),
          expandedRowRender: (row) => (
            <ScopeEditor
              userId={row.id}
              objectOptions={objectOptions}
              busy={setScopes.isPending}
              onSave={(objectIds) => setScopes.mutate({ userId: row.id, objectIds })}
            />
          ),
        }}
        columns={[
          { title: 'ФИО', dataIndex: 'fullName', key: 'fullName' },
          { title: 'Почта', dataIndex: 'email', key: 'email', render: (v) => v ?? '—' },
          {
            title: 'Роли',
            key: 'roles',
            render: (_value, row) => (
              <Select<UserRole[]>
                mode="multiple"
                size="small"
                style={{ minWidth: 260 }}
                value={row.roles}
                onChange={(roles) => setRoles.mutate({ userId: row.id, roles })}
                aria-label={`Роли пользователя ${row.fullName}`}
                options={ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
              />
            ),
          },
          {
            title: 'Организация',
            dataIndex: 'contractorId',
            key: 'contractorId',
            render: (value: string | null) => value ?? '—',
          },
          {
            title: 'Состояние',
            key: 'isActive',
            render: (_value, row) => (
              <Space size={6}>
                <Tag color={row.isActive ? 'green' : 'red'}>
                  {row.isActive ? 'активна' : 'отключена'}
                </Tag>
                <Button
                  size="small"
                  loading={toggleActive.isPending}
                  onClick={() => toggleActive.mutate({ userId: row.id, activate: !row.isActive })}
                >
                  {row.isActive ? 'Отключить' : 'Включить'}
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}

function ScopeEditor(props: {
  readonly userId: string;
  readonly objectOptions: readonly { value: string; label: string }[];
  readonly busy: boolean;
  readonly onSave: (objectIds: string[]) => void;
}): ReactNode {
  const card = useQuery({
    queryKey: adminKeys.user(props.userId),
    queryFn: () => admin.user(props.userId),
  });
  const [draft, setDraft] = useState<string[] | null>(null);

  if (card.isPending) return <LoadingState />;
  if (card.isError) return <ErrorState error={card.error} />;

  const value = draft ?? card.data.objectIds;

  return (
    <Space wrap>
      <Select<string[]>
        mode="multiple"
        style={{ minWidth: 420 }}
        value={value}
        onChange={setDraft}
        options={[...props.objectOptions]}
        placeholder="Объекты, назначенные инженеру"
        aria-label="Области видимости по объектам"
      />
      <Button type="primary" size="small" loading={props.busy} onClick={() => props.onSave(value)}>
        Сохранить области
      </Button>
    </Space>
  );
}
