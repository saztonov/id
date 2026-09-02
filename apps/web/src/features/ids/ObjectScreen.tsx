/**
 * Объект: разделы деревом, комплекты внутри разделов, реестры передачи (§3, §14).
 *
 * ## Почему дерево, а не плоская таблица
 *
 * Комплект живёт в разделе работ, и на стройке их десятки в каждом. Плоский
 * список всех комплектов объекта отвечал на вопрос «что вообще есть», а
 * спрашивают другое — «что у меня по электрике за август». Раздел здесь узел
 * дерева, и его содержимое грузится ТОЛЬКО при раскрытии: сто комплектов
 * объекта не выкачиваются ради того, чтобы показать семь.
 *
 * Число в заголовке панели приходит отдельным запросом
 * (`GET /objects/{id}/sections/counts`) и считается той же областью видимости и
 * теми же фильтрами, что и сам список. Иначе заголовок «комплектов 7» над
 * панелью, в которой подрядчику видны два, сообщал бы ему о работе соседей.
 *
 * ## Комплект заводится файлом, а не карточкой
 *
 * Подрядчик приходит со сканом. Прежняя форма спрашивала раздел, месяц и
 * наименование, заводила пустой комплект и отправляла его на экран ревизии
 * искать вкладку «Файлы». Теперь форма стоит внутри раскрытого раздела, раздел
 * ей известен, а наименование подставляется из имени файла и тут же правится.
 *
 * Если байты не доехали, комплект НЕ удаляется: у него есть черновая ревизия, в
 * которую файл догружается вкладкой «Файлы», и форма даёт на неё прямую ссылку.
 * Удаление потребовало бы стирать строку аудита `work.created`, уже записанную
 * сервером, — то есть править журнал ради косметики.
 *
 * ## Исполнителя форма больше не спрашивает (S37)
 *
 * Поля нет ни у одной роли. У подрядчика и генподрядчика его не было и раньше:
 * сервер берёт организацию из области видимости. У проверяющего оно было
 * ОБЯЗАТЕЛЬНЫМ — и это была та же ошибка, что с месяцем до S30: портал требовал
 * назвать то, чего человек в момент загрузки файла не знает, потому что файл
 * ещё никто не читал.
 *
 * Теперь исполнителя выводит сервер из карточки объекта и помечает вывод
 * признаком, а конвейер заменяет его организацией из акта. До тех пор в колонке
 * стоит надпись, а не имя: догадка обязана быть отличима от прочитанного.
 *
 * ## Настройка объекта свёрнута
 *
 * Включённые разделы и закреплённые подрядчики — состояние стройки, а не то,
 * ради чего сюда заходят. Карточка осталась (без неё непонятно, почему в форме
 * нет нужного раздела), но уступила верх экрана данным.
 */
import { useState, type ReactNode } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalog, files } from '../../api/endpoints.js';
import { catalogKeys, navigationKeys } from '../../api/keys.js';
import {
  deleteFolder,
  getFolderDeletionPreview,
  listSectionCounts,
  listWorkPipeline,
  listFolders,
  pagesBlocked,
  pagesItems,
  type Work,
  type WorkFilter,
} from '../../api/navigation.js';
import { describeError, describeUploadFailure } from '../../api/problem.js';
import type { ConstructionObject, ObjectContractor, ObjectSection } from '../../api/types.js';
import {
  ErrorState,
  ExplainedLimitation,
  LoadingState,
  ScreenHeading,
  UnavailableState,
} from '../../shared/ui.js';
import { IconAction, RowActions } from '../../shared/RowActions.js';
import { TrashIcon } from '../../shared/icons.js';
import { Link, useNavigate } from '../../app/router.js';
import { useSession } from '../../app/session.js';
import { uploadToTicket } from '../files/upload.js';
import {
  contractorLabel,
  periodLabel,
  pipelineBusy,
  pipelineLabel,
  type WorkPipeline,
} from './pipelineState.js';

/** `2026-08` из `<input type="month">` → `2026-08-01`, как ждёт сервер. */
function monthToPeriod(value: string): string | undefined {
  return value === '' ? undefined : `${value}-01`;
}

export function ObjectScreen({ objectId }: { objectId: string }): ReactNode {
  const { can } = useSession();
  const [filter, setFilter] = useState<WorkFilter>({});
  const [expanded, setExpanded] = useState<string[]>([]);

  const object = useQuery({
    queryKey: catalogKeys.object(objectId),
    queryFn: () => catalog.object(objectId),
  });

  const sections = useQuery({
    queryKey: catalogKeys.sections(objectId),
    queryFn: () => catalog.objectSections(objectId),
  });

  const contractors = useQuery({
    queryKey: catalogKeys.objectContractors(objectId),
    queryFn: () => catalog.objectContractors(objectId),
  });

  const counts = useQuery({
    queryKey: navigationKeys.sectionCounts(objectId, JSON.stringify(filter)),
    queryFn: () => listSectionCounts(objectId, filter),
  });

  const enabled = (sections.data ?? []).filter((row) => row.isActive);

  const countOf = (sectionCode: string): number | null => {
    const result = counts.data;
    if (result === undefined || result.kind !== 'available') return null;
    return result.data.find((row) => row.sectionCode === sectionCode)?.folders ?? 0;
  };

  return (
    <>
      <ScreenHeading
        title={object.data === undefined ? 'Объект' : `${object.data.code} — ${object.data.name}`}
      />

      {object.isPending && <LoadingState label="Загрузка объекта…" />}
      {object.isError && <ErrorState error={object.error} title="Объект недоступен" />}
      {object.isSuccess && <ObjectCard object={object.data} />}

      <ObjectSetup
        objectId={objectId}
        sections={sections.data ?? []}
        contractors={contractors.data ?? []}
        loading={sections.isPending || contractors.isPending}
      />

      <FolderFilters value={filter} onChange={setFilter} />

      <Card size="small" title="Разделы работ" style={{ marginTop: 16 }}>
        {sections.isPending && <LoadingState label="Загрузка разделов…" />}
        {enabled.length === 0 && !sections.isPending && (
          <ExplainedLimitation title="На объекте не включён ни один раздел" testId="no-sections">
            Комплект заводится в раздел работ, и раздел обязан быть включён на объекте. Включает его
            тот, кто ведёт стройку, — генподрядчик или администратор портала.
          </ExplainedLimitation>
        )}
        {enabled.length > 0 && (
          <Collapse
            // Не accordion: после отбора по месяцу человек сравнивает разделы
            // между собой, и «раскрыт ровно один» этому мешает.
            activeKey={expanded}
            onChange={(keys) => setExpanded(Array.isArray(keys) ? keys : [keys])}
            items={enabled.map((section) => {
              const total = countOf(section.sectionCode);
              return {
                key: section.sectionCode,
                label: (
                  <Space size={8}>
                    <span>{section.name}</span>
                    <Typography.Text type="secondary">
                      {total === null ? '' : `комплектов ${String(total)}`}
                    </Typography.Text>
                  </Space>
                ),
                // Содержимое монтируется только раскрытым: запрос комплектов
                // раздела уходит по первому раскрытию, а не при загрузке экрана.
                children: expanded.includes(section.sectionCode) ? (
                  <SectionPanel
                    objectId={objectId}
                    section={section}
                    filter={filter}
                    canUpload={can('submission.upload')}
                    canDelete={can('settings.manage')}
                  />
                ) : null,
              };
            })}
          />
        )}
      </Card>
    </>
  );
}

function ObjectCard({ object }: { object: ConstructionObject }): ReactNode {
  return (
    <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
      <Descriptions.Item label="Полное наименование">{object.fullName}</Descriptions.Item>
      <Descriptions.Item label="Адрес">{object.address ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="Кадастровый номер">
        {object.cadastralNumber ?? '—'}
      </Descriptions.Item>
      <Descriptions.Item label="Идентификатор ОКС">
        {object.permitIdentifier ?? '—'}
      </Descriptions.Item>
    </Descriptions>
  );
}

// =====================================================================
// Панель отбора
// =====================================================================

interface FilterFormValues {
  search?: string;
  from?: string;
  to?: string;
  unassigned?: boolean;
}

/**
 * Отбор комплектов по всему объекту сразу.
 *
 * Стоит НАД деревом, а не внутри каждой панели: вопрос «что у меня за август»
 * задают ко всей стройке, и повторять его в каждом разделе значило бы задавать
 * его столько раз, сколько разделов. Отбор применяется и к счётчикам в
 * заголовках — иначе число обещало бы комплекты, которых в теле панели нет.
 */
function FolderFilters({
  value,
  onChange,
}: {
  value: WorkFilter;
  onChange: (next: WorkFilter) => void;
}): ReactNode {
  const [form] = Form.useForm<FilterFormValues>();

  const apply = (values: FilterFormValues): void => {
    onChange({
      ...(values.search === undefined || values.search.trim() === ''
        ? {}
        : { search: values.search.trim() }),
      ...(values.from === undefined ? {} : { periodFrom: monthToPeriod(values.from) }),
      ...(values.to === undefined ? {} : { periodTo: monthToPeriod(values.to) }),
      // Признак трёхзначен и на сервере: снятая галка означает «любые», а не
      // «только включённые в реестр». Передавать `false` было бы другим вопросом.
      ...(values.unassigned === true ? { unassigned: true } : {}),
    });
  };

  const active =
    value.search !== undefined ||
    value.periodFrom !== undefined ||
    value.periodTo !== undefined ||
    value.unassigned !== undefined;

  return (
    <Card size="small" title="Отбор комплектов" style={{ marginTop: 16 }}>
      <Form<FilterFormValues>
        form={form}
        layout="inline"
        onFinish={apply}
        data-testid="work-filters"
      >
        <Form.Item name="search" label="Работа">
          <Input allowClear style={{ width: 240 }} data-testid="filter-search" />
        </Form.Item>
        <Form.Item name="from" label="Месяц с">
          <Input type="month" style={{ width: 160 }} data-testid="filter-from" />
        </Form.Item>
        <Form.Item name="to" label="по">
          <Input type="month" style={{ width: 160 }} data-testid="filter-to" />
        </Form.Item>
        <Form.Item name="unassigned" valuePropName="checked">
          <Checkbox data-testid="filter-unassigned">Только не включённые в реестр</Checkbox>
        </Form.Item>
        <Form.Item>
          <Space>
            <Button htmlType="submit" data-testid="filter-apply">
              Применить
            </Button>
            {active && (
              <Button
                type="link"
                data-testid="filter-reset"
                onClick={() => {
                  form.resetFields();
                  onChange({});
                }}
              >
                Сбросить
              </Button>
            )}
          </Space>
        </Form.Item>
      </Form>
    </Card>
  );
}

/**
 * Удаление комплекта администратором (S24).
 *
 * ## Диалог называет числа, а не спрашивает «уверены?»
 *
 * Предпросмотр загружается по нажатию, а не заранее: строк в разделе бывает
 * много, и опрашивать сервер о каждой ради подсказки, которую откроют у одной, —
 * это тот самый шквал запросов, из-за которого портал выбивал лимит.
 *
 * Числа обязательны. «Удалить комплект?» — вопрос, на который нельзя ответить
 * осознанно: за одинаковыми строками таблицы стоят и пустой черновик, заведённый
 * по ошибке минуту назад, и комплект на сотню страниц с суточным
 * распознаванием. Восстановления нет, поэтому цена решения обязана быть видна
 * ДО него.
 *
 * ## Препятствия показываются до нажатия
 *
 * Согласованная ревизия, переданный реестр и юридический запрет делают удаление
 * невозможным. Их список приходит вместе с числами и показывается вместо кнопки
 * «Удалить»: получить 409 на нажатие — значит узнать причину последним.
 */
function DeleteWorkAction({ work }: { work: Work }): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const preview = useQuery({
    queryKey: navigationKeys.folderDeletionPreview(work.id),
    queryFn: () => getFolderDeletionPreview(work.id),
    enabled: open,
  });

  const remove = useMutation({
    mutationFn: () => deleteFolder(work.id),
    onSuccess: async () => {
      message.success(`Комплект «${work.title}» удалён`);
      setOpen(false);
      // Обесценивается вся навигационная ветка: комплект исчезает и из списка
      // раздела, и из счётчика в заголовке, и из состава реестров.
      await queryClient.invalidateQueries({ queryKey: navigationKeys.root });
    },
    onError: (error) => message.error(describeError(error)),
  });

  const blockers = preview.data?.blockers ?? [];

  return (
    <>
      <RowActions>
        <IconAction
          icon={<TrashIcon />}
          label={`Удалить комплект «${work.title}»`}
          danger
          onClick={() => setOpen(true)}
          testId={`delete-work-${work.id}`}
        />
      </RowActions>

      <Modal
        open={open}
        title={`Удалить комплект «${work.title}»?`}
        okText="Удалить безвозвратно"
        cancelText="Отмена"
        okButtonProps={{
          danger: true,
          disabled: preview.isPending || preview.isError || blockers.length > 0,
        }}
        confirmLoading={remove.isPending}
        onCancel={() => setOpen(false)}
        onOk={() => remove.mutate()}
        destroyOnHidden
      >
        {preview.isPending && <LoadingState label="Считаем, что будет удалено…" />}
        {preview.isError && <ErrorState error={preview.error} />}
        {preview.isSuccess &&
          (blockers.length > 0 ? (
            <ExplainedLimitation title="Этот комплект удалить нельзя">
              <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                {blockers.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              Согласованная ревизия, переданная папка и юридический запрет — это то, что уже ушло
              наружу: список переданных работ и принятое решение неизменяемы.
            </ExplainedLimitation>
          ) : (
            <Space direction="vertical" size={8}>
              <Typography.Text>Будет удалено безвозвратно:</Typography.Text>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  файлов: {preview.data.files}, страниц: {preview.data.pages}
                </li>
                <li>блоков разметки: {preview.data.layoutBlocks}</li>
                <li>
                  документов: {preview.data.documents}, замечаний: {preview.data.findings}
                </li>
              </ul>
              <Typography.Text type="secondary">
                Восстановить комплект будет нечем: удаляются и файлы, и результаты распознавания, и
                журнал обработки.
              </Typography.Text>
            </Space>
          ))}
      </Modal>
    </>
  );
}

// =====================================================================
// Раздел: форма заведения и комплекты
// =====================================================================

function SectionPanel({
  objectId,
  section,
  filter,
  canUpload,
  canDelete,
}: {
  objectId: string;
  section: ObjectSection;
  filter: WorkFilter;
  canUpload: boolean;
  /** Право `submission.delete`: удаляют комплекты все роли (S37). */
  canDelete: boolean;
}): ReactNode {
  const scoped: WorkFilter = { ...filter, objectId, sectionCode: section.sectionCode };

  const works = useInfiniteQuery({
    queryKey: navigationKeys.folderList(JSON.stringify(scoped)),
    queryFn: ({ pageParam }) => listFolders({ ...scoped, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.kind === 'available' ? last.data.nextCursor : null),
  });

  const blocked = pagesBlocked(works.data?.pages);
  const items = works.isSuccess && blocked === null ? pagesItems(works.data.pages) : [];

  /**
   * Состояние конвейера по УЖЕ ОТРИСОВАННЫМ строкам.
   *
   * Идентификаторы берутся из загруженных страниц, а не отбираются заново:
   * список листается курсором, и второй отбор отвечал бы про другую страницу.
   *
   * Опрос тикает, только пока по какому-то комплекту идёт работа, и замолкает
   * после отказа — иначе экран объекта спрашивал бы сервер вечно на
   * остановленном комплекте. Поток событий сюда не дотягивается: он смонтирован
   * на экране ревизии.
   */
  const workIds = items.map((item) => item.id);
  const pipeline = useQuery({
    queryKey: navigationKeys.foldersPipeline(objectId, workIds.join(',')),
    queryFn: () => listWorkPipeline(objectId, workIds),
    enabled: workIds.length > 0,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((row) => pipelineBusy(row)) ? 5_000 : false,
  });

  const byWork = new Map<string, WorkPipeline>(
    // Ключ — `folderId` из ответа: поля `workId` сервер не отдаёт с S44, и
    // сводка не находилась бы ни для одной строки списка.
    (pipeline.data ?? []).map((row) => [row.folderId, row]),
  );
  /** `null` — сводки нет: комплект без ревизии либо строка, которой не оказалось в ответе. */
  const pipelineOf = (workId: string): WorkPipeline | null => byWork.get(workId) ?? null;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {canUpload && <NewWorkWithFileCard objectId={objectId} sectionCode={section.sectionCode} />}

      {works.isPending && <LoadingState label="Загрузка комплектов…" />}
      {works.isError && <ErrorState error={works.error} />}
      {blocked !== null && (
        <UnavailableState
          route={blocked.route}
          what="Комплекты раздела"
          reason={blocked.reason}
          detail={blocked.detail}
        />
      )}
      {works.isSuccess && blocked === null && (
        <>
          <Table<Work>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={items}
            locale={{ emptyText: 'Комплектов в разделе нет' }}
            columns={[
              {
                title: 'Работа',
                dataIndex: 'title',
                key: 'title',
                // Ссылка ведёт на саму папку: с S44 ревизия и комплект
                // схлопнуты, и открывать теперь нечего, кроме неё. Прежде здесь
                // читалось поле currentFolderId, которого сервер уже не отдаёт,
                // и ссылка вела на /ids/folders/undefined.
                render: (title: string, row) => <Link to={`/ids/folders/${row.id}`}>{title}</Link>,
              },
              {
                title: 'Месяц',
                dataIndex: 'period',
                key: 'period',
                render: (period: string | null, row) => periodLabel(period, pipelineOf(row.id)),
              },
              {
                title: 'Исполнитель',
                key: 'contractorId',
                render: (_value: unknown, row) =>
                  contractorLabel({
                    // Имя приходит со строкой комплекта, а не ищется среди
                    // закреплённых за объектом: закрепление больше не условие
                    // заведения (S39), и у незакреплённого исполнителя поиск
                    // давал бы прочерк — то есть утверждал бы, что исполнителя
                    // нет, хотя он назван.
                    name: row.contractorName,
                    assumed: row.contractorAssumed,
                    raw: row.contractorRaw,
                    pipeline: pipelineOf(row.id),
                  }),
              },
              {
                title: 'Распознавание',
                key: 'pipeline',
                render: (_value: unknown, row) => pipelineLabel(pipelineOf(row.id)),
              },
              // Колонка действий появляется только у администратора: у
              // остальных ролей ей нечего показать, а пустой столбец «Действия»
              // читается как «кнопки не загрузились».
              ...(canDelete
                ? [
                    {
                      title: '',
                      key: 'actions',
                      width: 56,
                      render: (_value: unknown, row: Work) => <DeleteWorkAction work={row} />,
                    },
                  ]
                : []),
            ]}
          />
          {works.hasNextPage && (
            <Button
              size="small"
              data-testid="works-more"
              loading={works.isFetchingNextPage}
              onClick={() => {
                void works.fetchNextPage();
              }}
            >
              Показать ещё комплекты
            </Button>
          )}
        </>
      )}
    </Space>
  );
}

interface WorkFormValues {
  title: string;
}

/**
 * Заведение комплекта одним файлом.
 *
 * Порядок шагов тот же, что на вкладке «Файлы»: талон → PUT байтов мимо портала
 * → `complete`. Отличие одно — талон выдаётся вместе с комплектом и ревизией,
 * поэтому кругов не три, а два, и отказать форма может ровно дважды.
 *
 * Наименование подставляется из имени файла и остаётся правимым. Ручную правку
 * форма не затирает: человек, переименовавший работу и передумавший с файлом,
 * потерял бы набранное — а `works.title` в базе `NOT NULL`, и молча подставить
 * туда что-нибудь было бы хуже, чем спросить.
 */
function NewWorkWithFileCard({
  objectId,
  sectionCode,
}: {
  objectId: string;
  sectionCode: string;
}): ReactNode {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<WorkFormValues>();
  const [file, setFile] = useState<File | null>(null);
  const [titleTouched, setTitleTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  /** Черновик, заведённый неудавшейся загрузкой: в него можно догрузить файл. */
  const [orphan, setOrphan] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const reset = (): void => {
    form.resetFields();
    setFile(null);
    setTitleTouched(false);
    setOpen(false);
  };

  const create = useMutation({
    mutationFn: async (values: WorkFormValues) => {
      if (file === null) throw new Error('Файл не выбран');

      const created = await files.createFolderWithFile({
        objectId,
        sectionCode,
        title: values.title,
        fileName: file.name,
        sizeBytes: file.size,
      });

      // С этого места комплект уже существует. Любой дальнейший отказ оставляет
      // его черновиком, а не мусором, — и форма обязана сказать, куда идти.
      try {
        // Заливка — общая с вкладкой «Файлы» и с заменой файла: собственная
        // копия этих строк здесь уже была и успела разойтись с оригиналом,
        // оставшись без повторов и без разбора отказа хранилища.
        await uploadToTicket(created.upload, file, (attempt, total) => {
          message.warning(
            `Хранилище не приняло файл, повтор ${String(attempt)} из ${String(total)}…`,
          );
        });
        const stored = await files.completeUpload(created.folderId, created.upload.uploadId);
        return { created, stored };
      } catch (error) {
        setOrphan(created.folderId);
        throw new Error(describeUploadFailure(error), { cause: error });
      }
    },
    onSuccess: async ({ created, stored }) => {
      setFailure(null);
      setOrphan(null);
      reset();
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      if (stored.verifyState === 'quarantined') {
        message.warning(
          `Комплект заведён, но файл помещён в карантин: ${stored.verifyError ?? 'причина не указана'}`,
        );
      } else {
        // Кнопку «1. Выделить блоки» нажимать не надо: приём файла нового
        // комплекта сам ставит сборку рабочего документа с продолжением
        // разметкой (S36). Обещать это словами обязательно — иначе на экране
        // комплекта человек видит идущий конвейер, которого не запускал.
        message.success('Комплект заведён: собираем рабочий документ, дальше — выделение блоков');
      }
      navigate(`/ids/folders/${created.folderId}`);
    },
    // Отказ показывается на месте формы, а не всплывашкой: причина отказа —
    // часть объяснения ограничения, и она обязана оставаться на экране.
    onError: (error: unknown) => setFailure(error),
  });

  if (!open) {
    return (
      <Button
        size="small"
        type="primary"
        data-testid="new-work"
        onClick={() => {
          setFailure(null);
          setOrphan(null);
          setOpen(true);
        }}
      >
        Новый комплект
      </Button>
    );
  }

  return (
    <Card
      size="small"
      title="Новый комплект"
      extra={
        <Button size="small" onClick={reset}>
          Отмена
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {failure !== null && <ErrorState error={failure} title="Комплект не заведён целиком" />}
        {orphan !== null && (
          <ExplainedLimitation title="Комплект заведён, а файл не принят" testId="upload-orphan">
            Карточка комплекта и его черновая ревизия созданы — они не потеряны. Файл догрузите на
            вкладке «Файлы»: <Link to={`/ids/folders/${orphan}`}>открыть ревизию</Link>.
          </ExplainedLimitation>
        )}

        <Form<WorkFormValues>
          form={form}
          layout="inline"
          onFinish={(values) => {
            create.mutate(values);
          }}
        >
          <Form.Item label="Файл" required>
            <input
              type="file"
              data-testid="work-file"
              aria-label="Файл комплекта"
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                // Наименование подставляется, пока человек его не тронул: иначе
                // выбор другого файла затирал бы набранное вручную.
                if (chosen !== null && !titleTouched) {
                  form.setFieldValue('title', chosen.name);
                }
              }}
            />
          </Form.Item>
          {/*
            Месяца в форме нет (S30): его выводит портал по самому раннему
            распознанному акту. Спрашивать здесь значило бы просить назвать то,
            чего человек ещё не видел, — акта в этот момент нет, есть файл,
            который никто не читал. Подставленный по умолчанию текущий месяц
            оставался в карточке как факт: комплект с актом от 09.03.2026
            заводился «августом 2026».
          */}
          <Form.Item
            name="title"
            label="Работа"
            rules={[{ required: true, message: 'Наименование работы обязательно' }]}
            extra="По умолчанию — имя файла"
          >
            <Input
              style={{ width: 300 }}
              data-testid="work-title"
              onChange={() => setTitleTouched(true)}
            />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={create.isPending}
              disabled={file === null}
              data-testid="create-work"
            >
              Завести комплект
            </Button>
          </Form.Item>
        </Form>
      </Space>
    </Card>
  );
}

// =====================================================================
// Настройка объекта
// =====================================================================

/**
 * Разделы и подрядчики объекта — свёрнутыми.
 *
 * Показывается всем, кто видит объект: без него подрядчик не понимает, почему в
 * дереве нет нужного раздела. Переключатели — только у того, кто ведёт стройку.
 */
function ObjectSetup({
  objectId,
  sections,
  contractors,
  loading,
}: {
  objectId: string;
  sections: readonly ObjectSection[];
  contractors: readonly ObjectContractor[];
  loading: boolean;
}): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const manage = can('registry.manage') || can('settings.manage');

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };

  const toggleSection = useMutation({
    mutationFn: (row: ObjectSection) =>
      catalog.setObjectSection(objectId, row.sectionCode, !row.isActive),
    onSuccess: invalidate,
    onError: (error) => message.error(describeError(error)),
  });

  const toggleContractor = useMutation({
    mutationFn: (row: ObjectContractor) =>
      catalog.setObjectContractor(objectId, row.contractorId, !row.isActive),
    onSuccess: invalidate,
    onError: (error) => message.error(describeError(error)),
  });

  return (
    <Collapse
      size="small"
      data-testid="object-setup"
      items={[
        {
          key: 'setup',
          label: 'Настройка объекта: разделы и подрядчики',
          children: (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <div>
                <Typography.Text strong>Разделы работ</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  {loading && <LoadingState label="Загрузка разделов…" />}
                  <Space size={4} wrap>
                    {sections.map((row) => (
                      <Tag
                        key={row.sectionCode}
                        color={row.isActive ? 'blue' : 'default'}
                        {...(manage && row.sectionIsActive
                          ? {
                              style: { cursor: 'pointer' },
                              onClick: () => toggleSection.mutate(row),
                            }
                          : {})}
                      >
                        {row.name}
                        {row.sectionIsActive ? '' : ' (отключён в справочнике)'}
                      </Tag>
                    ))}
                  </Space>
                </div>
              </div>

              <div>
                <Typography.Text strong>Закреплённые подрядчики</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  {contractors.length === 0 ? (
                    <Typography.Text type="secondary">
                      Ни один подрядчик не закреплён: заводить комплекты на объекте пока некому.
                    </Typography.Text>
                  ) : (
                    <Space size={4} wrap>
                      {contractors.map((row) => (
                        <Tag
                          key={row.contractorId}
                          color={row.isActive ? 'green' : 'default'}
                          {...(manage
                            ? {
                                style: { cursor: 'pointer' },
                                onClick: () => toggleContractor.mutate(row),
                              }
                            : {})}
                        >
                          {row.name}
                        </Tag>
                      ))}
                    </Space>
                  )}
                </div>
              </div>

              {manage && (
                <AssignContractor objectId={objectId} assigned={contractors} onDone={invalidate} />
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}

function AssignContractor({
  objectId,
  assigned,
  onDone,
}: {
  objectId: string;
  assigned: readonly ObjectContractor[];
  onDone: () => Promise<void>;
}): ReactNode {
  const { message } = AntApp.useApp();
  const [contractorId, setContractorId] = useState<string | null>(null);

  const all = useQuery({
    queryKey: catalogKeys.counterparties('', ''),
    queryFn: () => catalog.counterparties(),
  });

  const assign = useMutation({
    mutationFn: (id: string) => catalog.setObjectContractor(objectId, id, true),
    onSuccess: async () => {
      setContractorId(null);
      await onDone();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const known = new Set(assigned.map((row) => row.contractorId));
  const options = (all.data?.items ?? [])
    .filter((row) => row.isActive && !known.has(row.id))
    .map((row) => ({
      value: row.id,
      label: row.inn === null ? row.name : `${row.name} (ИНН ${row.inn})`,
    }));

  return (
    <Space wrap>
      <Select<string>
        style={{ minWidth: 320 }}
        placeholder="Закрепить подрядчика"
        showSearch
        optionFilterProp="label"
        value={contractorId}
        onChange={setContractorId}
        options={options}
        loading={all.isPending}
        data-testid="assign-contractor"
      />
      <Button
        disabled={contractorId === null}
        loading={assign.isPending}
        onClick={() => {
          if (contractorId !== null) assign.mutate(contractorId);
        }}
      >
        Закрепить
      </Button>
    </Space>
  );
}

// =====================================================================
// Реестры
// =====================================================================
