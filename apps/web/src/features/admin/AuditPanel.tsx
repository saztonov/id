/**
 * Журнал аудита (§3.1, §14).
 *
 * Фильтры — свободные строки по действию и типу сущности: перечень действий
 * растёт вместе с этапами, и закрытый список означал бы, что найти новое
 * действие нельзя до правки клиента.
 *
 * `payload` показывается как есть. Секретов там нет по построению: попытка
 * записать секрет в настройки отвергается раньше, чем дошла бы до журнала
 * значением, а адреса (`ip`) сервер в ответ не отдаёт вовсе.
 */
import { useState, type ReactNode } from 'react';
import { Input, Space, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { admin } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import type { AuditEntry } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';

export function AuditPanel(): ReactNode {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const key = `${action}|${entityType}`;

  const entries = useQuery({
    queryKey: adminKeys.audit(key),
    queryFn: () =>
      admin.audit({
        ...(action === '' ? {} : { action }),
        ...(entityType === '' ? {} : { entityType }),
      }),
  });

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          allowClear
          placeholder="Действие, например catalog.object.update"
          onSearch={setAction}
          style={{ width: 320 }}
          aria-label="Фильтр по действию"
        />
        <Input.Search
          allowClear
          placeholder="Тип сущности"
          onSearch={setEntityType}
          style={{ width: 240 }}
          aria-label="Фильтр по типу сущности"
        />
      </Space>

      {entries.isPending && <LoadingState />}
      {entries.isError && <ErrorState error={entries.error} />}
      {entries.isSuccess && (
        <Table<AuditEntry>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={entries.data.items}
          locale={{ emptyText: 'Записей журнала нет' }}
          expandable={{
            expandedRowRender: (row) => (
              <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(row.payload, null, 2)}
              </Typography.Text>
            ),
            rowExpandable: (row) => row.payload !== null && row.payload !== undefined,
          }}
          columns={[
            { title: 'Время', dataIndex: 'at', key: 'at', width: 220 },
            { title: 'Действие', dataIndex: 'action', key: 'action' },
            { title: 'Сущность', dataIndex: 'entityType', key: 'entityType' },
            {
              title: 'Идентификатор',
              dataIndex: 'entityId',
              key: 'entityId',
              render: (v) => v ?? '—',
            },
            {
              title: 'Актор',
              dataIndex: 'actorUserId',
              key: 'actorUserId',
              render: (v) => v ?? 'система',
            },
            {
              title: 'Запрос',
              dataIndex: 'requestId',
              key: 'requestId',
              render: (v) => v ?? '—',
            },
          ]}
        />
      )}
    </>
  );
}
