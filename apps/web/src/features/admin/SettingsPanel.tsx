/**
 * Настройки и интеграции (§10, §14).
 *
 * ## Секрет наружу не отдаётся даже частично
 *
 * Сервер присылает ссылку на место хранения и признак «задано», а не значение,
 * его префикс или длину: по префиксу токена определяется провайдер, по длине —
 * алгоритм. Экран это уважает и не пытается собрать значение обратно.
 *
 * ## `verified` берётся с сервера, а не печатается
 *
 * Наличие переменных окружения — это НЕ проверенное подключение. Сегодня сервер
 * возвращает `verified` литеральным `false` (`integrationStatusResponseSchema`),
 * и рисовать вместо этого зелёную галочку значило бы утверждать связь, которой
 * никто не проверял. Но и печатать «нет» текстом, не глядя в ответ, нельзя:
 * такая колонка перестанет быть правдой в тот день, когда появится живая проба,
 * и никто этого не заметит — утверждение о состоянии интеграции, не связанное с
 * её состоянием, хуже пустого места. Поэтому значение читается, а отсутствие
 * поля названо отдельно.
 *
 * Переключатель анализа через RD WEB заблокирован по своей причине:
 * generic-эндпоинта у них нет (§0.3, п. 6), и об этом сказано прямо, а не
 * спрятано.
 */
import { type ReactNode } from 'react';
import { Alert, Card, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { admin } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import type { AppSetting, IntegrationStatus, SecretReference } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';

export function SettingsPanel(): ReactNode {
  const settings = useQuery({
    queryKey: adminKeys.settings(),
    queryFn: () => admin.settings(),
  });

  if (settings.isPending) return <LoadingState />;
  if (settings.isError) return <ErrorState error={settings.error} />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="Настройки портала">
        <Table<AppSetting>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={settings.data.settings}
          locale={{ emptyText: 'Настроек нет' }}
          columns={[
            { title: 'Ключ', dataIndex: 'key', key: 'key' },
            { title: 'Назначение', dataIndex: 'title', key: 'title' },
            {
              title: 'Значение',
              dataIndex: 'value',
              key: 'value',
              render: (value: unknown) => (
                <Typography.Text code>{JSON.stringify(value)}</Typography.Text>
              ),
            },
            {
              title: 'Источник',
              dataIndex: 'isDefault',
              key: 'isDefault',
              render: (isDefault: boolean) =>
                isDefault ? <Tag>значение по умолчанию</Tag> : <Tag color="blue">задано</Tag>,
            },
            {
              title: 'Изменено',
              dataIndex: 'updatedAt',
              key: 'updatedAt',
              render: (value: string | null) => value ?? '—',
            },
          ]}
        />
      </Card>

      <Card size="small" title="Секреты">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Значения секретов не отдаются наружу ни целиком, ни частично: показывается место хранения
          и признак «задано».
        </Typography.Paragraph>
        <Table<SecretReference>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={settings.data.secrets}
          locale={{ emptyText: 'Секретов не объявлено' }}
          columns={[
            { title: 'Ключ', dataIndex: 'key', key: 'key' },
            { title: 'Где хранится', dataIndex: 'reference', key: 'reference' },
            {
              title: 'Задан',
              dataIndex: 'configured',
              key: 'configured',
              render: (value: boolean) =>
                value ? <Tag color="green">да</Tag> : <Tag color="red">нет</Tag>,
            },
          ]}
        />
      </Card>

      <Card size="small" title="Интеграции">
        <Table<IntegrationStatus>
          rowKey="name"
          size="small"
          pagination={false}
          dataSource={settings.data.integrations}
          locale={{ emptyText: 'Интеграций не объявлено' }}
          columns={[
            { title: 'Интеграция', dataIndex: 'name', key: 'name' },
            {
              title: 'Конфигурация',
              dataIndex: 'status',
              key: 'status',
              render: (status: IntegrationStatus['status']) => (
                <Tag
                  color={
                    status === 'configured' ? 'blue' : status === 'disabled' ? 'default' : 'orange'
                  }
                >
                  {status === 'configured'
                    ? 'переменные заданы'
                    : status === 'disabled'
                      ? 'выключена'
                      : 'не хватает переменных'}
                </Tag>
              ),
            },
            {
              title: 'Не хватает',
              dataIndex: 'missing',
              key: 'missing',
              render: (missing: string[]) => (missing.length === 0 ? '—' : missing.join(', ')),
            },
            {
              title: 'Связь проверена',
              dataIndex: 'verified',
              key: 'verified',
              render: (verified: IntegrationStatus['verified'] | undefined) =>
                verified === undefined ? (
                  // Поле не пришло — значит либо сервер его больше не отдаёт,
                  // либо экран смотрит в другой маршрут. Собственная догадка на
                  // этом месте была бы утверждением о состоянии интеграции,
                  // которое никто не проверял.
                  <Tag color="orange">сервер не прислал признак</Tag>
                ) : verified ? (
                  <Tag color="green">да: подключение подтверждено пробой</Tag>
                ) : (
                  <Tag>нет: живой пробы подключения не выполнялось</Tag>
                ),
            },
          ]}
        />
      </Card>

      <Alert
        type="warning"
        showIcon
        message="Анализ через RD WEB недоступен"
        description={
          'Generic-эндпоинта структурного анализа текста у RD WEB нет — проверено чтением их ' +
          'исходников. Переключатель провайдера анализа присутствует в настройках и заблокирован ' +
          'до появления такого эндпоинта; требование внесено в техзадание на доработку.'
        }
      />
    </Space>
  );
}
