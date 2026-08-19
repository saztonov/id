/**
 * Объект: разделы работ и тома (§14).
 *
 * Разделы читаются маршрутом справочника, тома — `GET /api/v1/volumes` с
 * фильтром `objectId` (плоская коллекция, а не вложенный путь: так объявлен
 * маршрут в `apps/api/src/modules/navigation/routes.ts`).
 *
 * Список курсорный. «Показать ещё» существует не для удобства: без него экран
 * показывал бы первые 50 томов как «все», и объект с длинным перечнем выглядел
 * бы законченным.
 *
 * Пустой список и недоступный раздел показываются РАЗНЫМИ состояниями —
 * см. `api/navigation.ts`.
 */
import { type ReactNode } from 'react';
import { Button, Card, Descriptions, Space, Table, Typography } from 'antd';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys, navigationKeys } from '../../api/keys.js';
import { listVolumes, pagesBlocked, pagesItems, type Volume } from '../../api/navigation.js';
import type { ObjectSection } from '../../api/types.js';
import { ErrorState, LoadingState, ScreenHeading, UnavailableState } from '../../shared/ui.js';
import { Link } from '../../app/router.js';

export function ObjectVolumesScreen({ objectId }: { objectId: string }): ReactNode {
  const object = useQuery({
    queryKey: catalogKeys.object(objectId),
    queryFn: () => catalog.object(objectId),
  });
  const sections = useQuery({
    queryKey: catalogKeys.sections(objectId),
    queryFn: () => catalog.sections(objectId),
  });
  const volumes = useInfiniteQuery({
    queryKey: navigationKeys.volumes(objectId),
    queryFn: ({ pageParam }) => listVolumes({ objectId, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.kind === 'available' ? last.data.nextCursor : null),
  });

  if (object.isPending) return <LoadingState label="Загрузка объекта…" />;
  if (object.isError) return <ErrorState error={object.error} />;

  const sectionNames = new Map(
    (sections.data ?? []).map((section) => [section.id, `${section.code} ${section.name}`]),
  );

  const blocked = pagesBlocked(volumes.data?.pages);
  const items = pagesItems(volumes.data?.pages);

  return (
    <>
      <ScreenHeading title={`${object.data.code} — ${object.data.name}`} />

      <Descriptions size="small" column={1} bordered style={{ marginBottom: 24 }}>
        <Descriptions.Item label="Полное наименование">{object.data.fullName}</Descriptions.Item>
        <Descriptions.Item label="Адрес">{object.data.address ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Шаблон номера акта">
          {object.data.actNumberPattern ?? '—'}
        </Descriptions.Item>
      </Descriptions>

      <Card size="small" title="Разделы работ" style={{ marginBottom: 24 }}>
        {sections.isPending && <LoadingState label="Загрузка разделов…" />}
        {sections.isError && <ErrorState error={sections.error} />}
        {sections.isSuccess && (
          <Table<ObjectSection>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={sections.data}
            locale={{ emptyText: 'Разделы работ по объекту не заведены' }}
            columns={[
              { title: 'Код', dataIndex: 'code', key: 'code' },
              { title: 'Наименование', dataIndex: 'name', key: 'name' },
              { title: 'Вид раздела', dataIndex: 'sectionKindCode', key: 'kind' },
              {
                title: 'Активен',
                dataIndex: 'isActive',
                key: 'isActive',
                render: (value: boolean) => (value ? 'да' : 'нет'),
              },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="Тома">
        {volumes.isPending && <LoadingState label="Загрузка томов…" />}
        {volumes.isError && <ErrorState error={volumes.error} />}
        {blocked !== null && (
          <UnavailableState
            route={blocked.route}
            what="Тома объекта"
            reason={blocked.reason}
            detail={blocked.detail}
          />
        )}
        {volumes.isSuccess && blocked === null && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Table<Volume>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={items}
              locale={{ emptyText: 'Томов по объекту нет' }}
              columns={[
                {
                  title: 'Код',
                  dataIndex: 'code',
                  key: 'code',
                  render: (code: string, row) => <Link to={`/ids/volumes/${row.id}`}>{code}</Link>,
                },
                { title: 'Наименование', dataIndex: 'name', key: 'name' },
                {
                  title: 'Раздел',
                  dataIndex: 'sectionId',
                  key: 'sectionId',
                  render: (sectionId: string) => (
                    <Typography.Text>{sectionNames.get(sectionId) ?? sectionId}</Typography.Text>
                  ),
                },
                {
                  title: 'Открыт',
                  dataIndex: 'isActive',
                  key: 'isActive',
                  render: (value: boolean) => (value ? 'да' : 'нет'),
                },
                {
                  title: 'Автопрогон',
                  dataIndex: 'autoRunEnabled',
                  key: 'autoRunEnabled',
                  render: (value: boolean) => (value ? 'включён' : 'выключен'),
                },
              ]}
            />
            {volumes.hasNextPage && (
              <Button
                data-testid="volumes-more"
                loading={volumes.isFetchingNextPage}
                onClick={() => {
                  void volumes.fetchNextPage();
                }}
              >
                Показать ещё тома
              </Button>
            )}
          </Space>
        )}
      </Card>
    </>
  );
}
