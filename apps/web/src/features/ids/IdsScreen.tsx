/**
 * Корень раздела ИД: объекты, доступные пользователю (§14).
 *
 * Объект виден подрядчику через закрепление за ним или через свои комплекты
 * (§4.1, фильтрация в SQL), поэтому список объектов — это уже область
 * видимости, а не общий справочник, и отдельного фильтра здесь не нужно.
 *
 * Пустой перечень объектов объясняется, а не показывается голой таблицей: у
 * подрядчика и у инженера он означает РАЗНОЕ, и оба случая — свойство модели
 * доступа, а не сбой загрузки. Экран, молчащий об этом, выглядит рабочим и
 * тогда, когда за ним нет ни одного объекта.
 *
 * Ниже — вход в ревизию по идентификатору. Это не отладочная возможность:
 * deep-link на ревизию приходит в уведомлениях и в консоли задач, и открыть
 * рабочее место по нему обязано быть можно, минуя дерево навигации.
 */
import { useState, type ReactNode } from 'react';
import { Button, Card, Form, Input, Space, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import type { ConstructionObject } from '../../api/types.js';
import { ErrorState, ExplainedLimitation, LoadingState, ScreenHeading } from '../../shared/ui.js';
import { Link, useNavigate } from '../../app/router.js';
import { useSession } from '../../app/session.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function IdsScreen(): ReactNode {
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const { me } = useSession();
  const scopeKind = me.scope?.kind ?? null;
  const objects = useQuery({
    queryKey: catalogKeys.objects(search),
    queryFn: () => catalog.objects(search === '' ? {} : { search }),
  });

  return (
    <>
      <ScreenHeading
        title="Исполнительная документация"
        extra={
          <Input.Search
            allowClear
            placeholder="Поиск объекта"
            onSearch={setSearch}
            style={{ maxWidth: 320 }}
            aria-label="Поиск объекта строительства"
          />
        }
      />

      {objects.isPending && <LoadingState label="Загрузка объектов…" />}
      {objects.isError && <ErrorState error={objects.error} />}
      {objects.isSuccess && objects.data.items.length === 0 && scopeKind === 'contractor' && (
        <div style={{ marginBottom: 16 }}>
          <ExplainedLimitation
            title="Объектов в вашей области видимости нет — и это может быть не ошибкой"
            testId="contractor-empty-scope"
          >
            Подрядчик видит объект, за которым его организация закреплена, и объект, где у неё уже
            есть комплекты. Закрепление выдаёт генподрядчик или администратор портала — до этого
            объект сюда не попадает. Пустой перечень здесь означает именно это, а не сбой загрузки.
          </ExplainedLimitation>
        </div>
      )}
      {objects.isSuccess && objects.data.items.length === 0 && scopeKind === 'engineer' && (
        <div style={{ marginBottom: 16 }}>
          <ExplainedLimitation
            title="На вас не назначено ни одного объекта"
            testId="engineer-empty-scope"
          >
            Инженер видит только назначенные объекты, и пустой список назначений даёт пустую выдачу,
            а не доступ ко всему. Назначения выдаёт администратор портала.
          </ExplainedLimitation>
        </div>
      )}
      {objects.isSuccess && (
        <Table<ConstructionObject>
          rowKey="id"
          size="middle"
          dataSource={objects.data.items}
          pagination={false}
          locale={{ emptyText: 'Объектов в вашей области видимости нет' }}
          columns={[
            {
              title: 'Код',
              dataIndex: 'code',
              key: 'code',
              render: (code: string, row) => <Link to={`/ids/objects/${row.id}`}>{code}</Link>,
            },
            { title: 'Наименование', dataIndex: 'name', key: 'name' },
            { title: 'Полное наименование', dataIndex: 'fullName', key: 'fullName' },
            {
              title: 'Активен',
              dataIndex: 'isActive',
              key: 'isActive',
              render: (value: boolean) => (value ? 'да' : 'нет'),
            },
          ]}
        />
      )}

      {objects.isSuccess && objects.data.items.length === 0 && (
        <Card
          size="small"
          title="Открыть ревизию комплекта по идентификатору"
          style={{ marginTop: 24 }}
        >
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            Рабочее место ревизии адресуется её идентификатором. Ссылка того же вида приходит в
            уведомлениях и в консоли задач.
          </Typography.Paragraph>
          <Form
            layout="inline"
            onFinish={(values: { revisionId?: string }) => {
              const id = (values.revisionId ?? '').trim();
              if (UUID_PATTERN.test(id)) navigate(`/ids/revisions/${id}`);
            }}
          >
            <Form.Item
              name="revisionId"
              label="Идентификатор ревизии"
              rules={[
                {
                  pattern: UUID_PATTERN,
                  message: 'Идентификатор ревизии — UUID',
                },
              ]}
            >
              <Input style={{ width: 340 }} placeholder="00000000-0000-4000-8000-000000000000" />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit">
                  Открыть
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      )}
    </>
  );
}
