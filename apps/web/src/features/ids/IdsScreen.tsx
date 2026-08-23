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
 * ## Формы ввода идентификатора ревизии здесь больше нет
 *
 * Она стояла ради deep-link из уведомлений и консоли задач — и была для этого
 * не нужна: ссылка `/ids/revisions/{id}` открывает рабочее место сама, без
 * посредника. Тем, кому она показывалась (пользователю с ПУСТЫМ списком
 * объектов), поле предлагало ввести UUID — то есть просило руками набрать то,
 * чего у него взяться неоткуда, и объясняло пустой экран отладочным приёмом.
 *
 * ## Список докручивается
 *
 * Прежде запрашивались первые сто объектов, и `nextCursor` не читался вовсе:
 * сто первый объект существовал и был недостижим, а экран об этом молчал.
 */
import { useState, type ReactNode } from 'react';
import { Button, Input, Table } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import type { ConstructionObject } from '../../api/types.js';
import { ErrorState, ExplainedLimitation, LoadingState, ScreenHeading } from '../../shared/ui.js';
import { Link } from '../../app/router.js';
import { useSession } from '../../app/session.js';

export function IdsScreen(): ReactNode {
  const [search, setSearch] = useState('');
  const { me } = useSession();
  const scopeKind = me.scope?.kind ?? null;

  const objects = useInfiniteQuery({
    queryKey: catalogKeys.objects(search),
    queryFn: ({ pageParam }) =>
      catalog.objects({ ...(search === '' ? {} : { search }), cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = (objects.data?.pages ?? []).flatMap((page) => page.items);
  const empty = objects.isSuccess && items.length === 0;

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
      {empty && scopeKind === 'contractor' && (
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
      {empty && scopeKind === 'engineer' && (
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
        <>
          <Table<ConstructionObject>
            rowKey="id"
            size="middle"
            dataSource={items}
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
          {objects.hasNextPage && (
            <Button
              style={{ marginTop: 12 }}
              size="small"
              data-testid="objects-more"
              loading={objects.isFetchingNextPage}
              onClick={() => {
                void objects.fetchNextPage();
              }}
            >
              Показать ещё объекты
            </Button>
          )}
        </>
      )}
    </>
  );
}
