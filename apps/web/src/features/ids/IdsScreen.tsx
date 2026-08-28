/**
 * Корень раздела ИД: объекты стройки (§14).
 *
 * ## Объяснений пустого списка здесь больше нет (S37)
 *
 * Их было два — подрядчику про закрепление, инженеру про назначения, — и оба
 * объясняли ОБЛАСТЬ ВИДИМОСТИ по объектам. Заказчик её снял: объекты видны
 * всем, кто вошёл в портал. Пустой список теперь означает ровно то, что
 * написано, — объектов ещё не завели, — и вторая формулировка на этот случай
 * была бы объяснением несуществующего правила.
 *
 * Изоляция от этого не исчезла, но живёт она ниже: на экране объекта подрядчик
 * видит комплекты своей организации и не видит соседских.
 *
 * ## Галерея, а не таблица
 *
 * Колонки Код / Наименование / Полное наименование / Активен отвечали на вопрос
 * «что вообще заведено», а сюда приходят с другим — «открыть свой объект».
 * Различить строки таблицы глазом нельзя, их приходится читать; карточка с
 * цветной обложкой опознаётся до чтения, а этот экран человек открывает
 * ежедневно. Полное наименование в данных портала почти всегда дубль
 * наименования, а признак активности не отслеживается — обе колонки занимали
 * место, ничего не сообщая.
 *
 * Отбор остаётся серверным (`search` уходит в запрос), а не фильтрацией уже
 * загруженного: список листается страницами, и фильтр по накопленному молчаливо
 * врал бы о ненайденном.
 *
 * ## Формы ввода идентификатора ревизии здесь больше нет
 *
 * Она стояла ради deep-link из уведомлений и консоли задач — и была для этого
 * не нужна: ссылка `/ids/revisions/{id}` открывает рабочее место сама, без
 * посредника. Тем, кому она показывалась (пользователю с ПУСТЫМ списком
 * объектов), поле предлагало ввести UUID — то есть просило руками набрать то,
 * чего у него взяться неоткуда.
 *
 * ## Список докручивается
 *
 * Прежде запрашивались первые сто объектов, и `nextCursor` не читался вовсе:
 * сто первый объект существовал и был недостижим, а экран об этом молчал. После
 * снятия областей это стало важнее прежнего: список больше не сужен.
 */
import { useState, type ReactNode } from 'react';
import { Button, Col, Input, Row } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import { EmptyState, ErrorState, LoadingState, ScreenHeading } from '../../shared/ui.js';
import { ObjectCard } from './ObjectCard.js';

export function IdsScreen(): ReactNode {
  const [search, setSearch] = useState('');

  const objects = useInfiniteQuery({
    // Ключ ОТДЕЛЬНЫЙ от справочника: там `useQuery`, здесь `useInfiniteQuery`, и
    // общий ключ означал бы, что второй экран читает чужую форму данных (разбор
    // — в `keys.ts`). Из-за него «Справочники → Объекты» показывали пустоту.
    queryKey: catalogKeys.objectsPaged(search),
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
      {objects.isSuccess && (
        <>
          {/*
            Пустая выдача названа словами. Прежде это делала `locale.emptyText`
            таблицы; без явной подстановки галерея показала бы пустое место, то
            есть экран выглядел бы рабочим ровно там, где показывать нечего.
          */}
          {empty ? (
            <EmptyState label="Объектов пока нет" />
          ) : (
            /*
              `align="stretch"` вместе с `height: 100%` у ссылки внутри карточки
              выравнивает высоту плиток ряда: иначе объект без адреса делал бы
              свою карточку ниже соседних.
            */
            <Row gutter={[12, 12]} align="stretch">
              {items.map((object) => (
                <Col key={object.id} xs={24} sm={12} md={12} lg={6} xl={4} xxl={3}>
                  <ObjectCard object={object} />
                </Col>
              ))}
            </Row>
          )}
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
