/**
 * Справочники (§14): объекты, контрагенты, разделы работ, виды ИД.
 *
 * Разделение видимости, введённое на S4, здесь проявляется буквально: объекты,
 * контрагенты и шифры РД — коммерческие данные с областью видимости, а разделы
 * работ и виды ИД — конфигурация, читаемая всеми. Поэтому вкладки не
 * скрываются по роли: сервер сам отдаёт подрядчику только то, что ему видно, и
 * пустой список у него — это правильный ответ, а не отказ.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Button, Input, Space, Table, Tabs, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import type {
  ConstructionObject,
  Counterparty,
  DocType,
  RdDocument,
  Section,
} from '../../api/types.js';
import { EmptyState, ErrorState, LoadingState, ScreenHeading } from '../../shared/ui.js';
import { Link, useNavigate, useQueryParam } from '../../app/router.js';
import { SectionProfilesPanel } from './SectionProfilesPanel.js';
import { ImportPanel } from './ImportPanel.js';
import { CounterpartyDialog, ObjectDialog } from './CatalogForms.js';
import { ToneTag } from '../../shared/tags.js';
import { ConfirmIconAction, IconAction, RowActions } from '../../shared/RowActions.js';
import { EditIcon, TrashIcon } from '../../shared/icons.js';
import { describeError } from '../../api/problem.js';
import { useSession } from '../../app/session.js';

const TABS = [
  'objects',
  'counterparties',
  'sections',
  'section-profiles',
  'rd-documents',
  'doc-types',
  'imports',
] as const;
type TabKey = (typeof TABS)[number];

export function CatalogScreen(): ReactNode {
  const navigate = useNavigate();
  const requested = useQueryParam('tab');
  const tab: TabKey = TABS.includes(requested as TabKey) ? (requested as TabKey) : 'objects';

  return (
    <>
      <ScreenHeading title="Справочники" />
      <Tabs
        activeKey={tab}
        onChange={(key) => navigate(`/catalog?tab=${key}`)}
        destroyOnHidden
        items={[
          { key: 'objects', label: 'Объекты', children: <ObjectsTable /> },
          { key: 'counterparties', label: 'Контрагенты', children: <CounterpartiesTable /> },
          { key: 'sections', label: 'Разделы работ', children: <SectionsTable /> },
          {
            key: 'section-profiles',
            label: 'Профили разделов',
            children: <SectionProfilesPanel />,
          },
          { key: 'rd-documents', label: 'Реестр РД', children: <RdDocumentsTable /> },
          { key: 'doc-types', label: 'Виды ИД', children: <DocTypesTable /> },
          { key: 'imports', label: 'Импорт', children: <ImportPanel /> },
        ]}
      />
    </>
  );
}

/**
 * Действия над строкой справочника: правка, отключение, удаление.
 *
 * Отключение и удаление — РАЗНЫЕ действия, и это не дублирование. Отключение
 * выводит карточку из работы, сохраняя всё, что на неё ссылается: акты,
 * подписанные этой организацией, обязаны остаться объяснимыми. Удаление
 * возможно только пока ссылок нет вовсе — оно для карточки, заведённой по
 * ошибке или задублированной импортом. Сервер отвечает 409 с перечислением
 * помех, и текст показывается дословно: «нельзя» без причины отправило бы
 * администратора искать ссылку по всей схеме.
 */
function CardActions({
  name,
  isActive,
  onEdit,
  onToggleActive,
  onDelete,
  busy,
}: {
  /** Название карточки: попадает в имя каждой кнопки, иначе в таблице из
   *  двадцати строк двадцать кнопок «Удалить» неразличимы на слух. */
  name: string;
  isActive: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <RowActions>
      <IconAction
        icon={<EditIcon />}
        label={`Изменить «${name}»`}
        loading={busy}
        onClick={onEdit}
      />
      {/*
        Переключатель остаётся СЛОВОМ, в отличие от соседей. Иконка показывает
        действие, а не состояние: по глифу нельзя понять, включена карточка
        сейчас или отключена, а именно это здесь и надо знать.
      */}
      <Button size="small" type="text" loading={busy} onClick={onToggleActive}>
        {isActive ? 'Отключить' : 'Включить'}
      </Button>
      <ConfirmIconAction
        icon={<TrashIcon />}
        label={`Удалить «${name}»`}
        danger
        loading={busy}
        onClick={onDelete}
        confirmTitle={`Удалить «${name}»?`}
        confirmDescription="Удаление возможно, только если на карточку ничего не ссылается."
      />
    </RowActions>
  );
}

function ObjectsTable(): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ConstructionObject | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery({
    queryKey: catalogKeys.objects(search),
    queryFn: () => catalog.objects(search === '' ? {} : { search }),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };

  const toggle = useMutation({
    mutationFn: (row: ConstructionObject) =>
      catalog.updateObject(row.id, { isActive: !row.isActive }),
    onSuccess: invalidate,
    onError: (error) => message.error(describeError(error)),
  });

  const remove = useMutation({
    mutationFn: (row: ConstructionObject) => catalog.deleteObject(row.id),
    onSuccess: async () => {
      message.success('Объект удалён');
      await invalidate();
    },
    // Текст 409 приходит с сервера и перечисляет, что именно мешает удалению.
    onError: (error) => message.error(describeError(error)),
  });

  const manage = can('settings.manage');

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          allowClear
          placeholder="Поиск по коду и наименованию"
          onSearch={setSearch}
          style={{ width: 360 }}
          aria-label="Поиск объекта"
        />
        {manage && (
          <Button
            type="primary"
            data-testid="new-object"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            Новый объект
          </Button>
        )}
      </Space>
      <Table<ConstructionObject>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={query.data.items}
        locale={{ emptyText: 'Объектов в вашей области видимости нет' }}
        columns={[
          {
            title: 'Код',
            dataIndex: 'code',
            key: 'code',
            render: (code: string, row) => <Link to={`/ids/objects/${row.id}`}>{code}</Link>,
          },
          { title: 'Наименование', dataIndex: 'name', key: 'name' },
          { title: 'Адрес', dataIndex: 'address', key: 'address', render: (v) => v ?? '—' },
          {
            title: 'Активен',
            dataIndex: 'isActive',
            key: 'isActive',
            render: (value: boolean) => (value ? 'да' : 'нет'),
          },
          ...(manage
            ? [
                {
                  title: 'Действия',
                  key: 'actions',
                  render: (_value: unknown, row: ConstructionObject) => (
                    <CardActions
                      name={row.name}
                      isActive={row.isActive}
                      busy={toggle.isPending || remove.isPending}
                      onEdit={() => {
                        setEditing(row);
                        setDialogOpen(true);
                      }}
                      onToggleActive={() => toggle.mutate(row)}
                      onDelete={() => remove.mutate(row)}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      <ObjectDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function CounterpartiesTable(): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Counterparty | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery({
    queryKey: catalogKeys.counterparties(search, ''),
    queryFn: () => catalog.counterparties(search === '' ? {} : { search }),
  });

  // Вид показывается наименованием, а не кодом: `laboratory` в таблице ничего
  // не сообщает человеку, который заводит испытательную лабораторию.
  const kinds = useQuery({
    queryKey: catalogKeys.counterpartyKinds(),
    queryFn: () => catalog.counterpartyKinds(),
  });
  const kindLabel = new Map((kinds.data ?? []).map((kind) => [kind.code, kind.name]));

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };

  const toggle = useMutation({
    mutationFn: (row: Counterparty) =>
      catalog.updateCounterparty(row.id, { isActive: !row.isActive }),
    onSuccess: invalidate,
    onError: (error) => message.error(describeError(error)),
  });

  const remove = useMutation({
    mutationFn: (row: Counterparty) => catalog.deleteCounterparty(row.id),
    onSuccess: async () => {
      message.success('Контрагент удалён');
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const manage = can('settings.manage');

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          allowClear
          placeholder="Поиск по наименованию"
          onSearch={setSearch}
          style={{ width: 360 }}
          aria-label="Поиск контрагента"
        />
        {manage && (
          <Button
            type="primary"
            data-testid="new-counterparty"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            Новый контрагент
          </Button>
        )}
      </Space>
      <Table<Counterparty>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={query.data.items}
        locale={{ emptyText: 'Контрагентов в вашей области видимости нет' }}
        columns={[
          { title: 'Наименование', dataIndex: 'name', key: 'name' },
          {
            title: 'Вид',
            dataIndex: 'kind',
            key: 'kind',
            render: (kind: string) => kindLabel.get(kind) ?? kind,
          },
          { title: 'ИНН', dataIndex: 'inn', key: 'inn', render: (v) => v ?? '—' },
          { title: 'ОГРН', dataIndex: 'ogrn', key: 'ogrn', render: (v) => v ?? '—' },
          {
            title: 'Активен',
            dataIndex: 'isActive',
            key: 'isActive',
            render: (value: boolean) => (value ? 'да' : 'нет'),
          },
          ...(manage
            ? [
                {
                  title: 'Действия',
                  key: 'actions',
                  render: (_value: unknown, row: Counterparty) => (
                    <CardActions
                      name={row.name}
                      isActive={row.isActive}
                      busy={toggle.isPending || remove.isPending}
                      onEdit={() => {
                        setEditing(row);
                        setDialogOpen(true);
                      }}
                      onToggleActive={() => toggle.mutate(row)}
                      onDelete={() => remove.mutate(row)}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      <CounterpartyDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
    </>
  );
}

/**
 * Разделы работ — один плоский справочник на весь портал.
 *
 * До 0028 здесь было две таблицы: разделы, скопированные на каждый объект, и
 * «разделы» — конфигурация, общая для всех. Различие существовало ровно
 * из-за копии; разделы взяты из сметного деления и на всех стройках одни и те
 * же, поэтому копия исчезла вместе с различием. Какие из них ведутся на
 * конкретной стройке, решается на карточке объекта, а не здесь.
 */
function SectionsTable(): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(true);
  const manage = can('settings.manage');

  const sections = useQuery({
    queryKey: catalogKeys.sectionCatalog(includeInactive),
    queryFn: () => catalog.sections(includeInactive),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['catalog', 'sections'] });
  };

  const toggle = useMutation({
    mutationFn: (row: Section) => catalog.updateSection(row.code, { isActive: !row.isActive }),
    onSuccess: invalidate,
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  if (sections.isPending) return <LoadingState />;
  if (sections.isError) return <ErrorState error={sections.error} />;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        {manage && <NewSectionForm onCreated={invalidate} />}
        <Button
          size="small"
          onClick={() => setIncludeInactive((value) => !value)}
          data-testid="toggle-inactive-sections"
        >
          {includeInactive ? 'Скрыть отключённые' : 'Показать отключённые'}
        </Button>
      </Space>

      <Table<Section>
        rowKey="code"
        size="small"
        pagination={false}
        dataSource={sections.data}
        locale={{ emptyText: 'Разделы работ не заведены' }}
        columns={[
          { title: 'Порядок', dataIndex: 'sortOrder', key: 'sortOrder', width: 90 },
          { title: 'Код', dataIndex: 'code', key: 'code' },
          { title: 'Наименование', dataIndex: 'name', key: 'name' },
          {
            title: 'Состояние',
            dataIndex: 'isActive',
            key: 'isActive',
            render: (isActive: boolean) => (
              <ToneTag tone={isActive ? 'success' : 'neutral'}>
                {isActive ? 'Действует' : 'Отключён'}
              </ToneTag>
            ),
          },
          ...(manage
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 120,
                  render: (_: unknown, row: Section) => (
                    <Button size="small" onClick={() => toggle.mutate(row)}>
                      {row.isActive ? 'Отключить' : 'Включить'}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Space>
  );
}

/**
 * Заведение раздела.
 *
 * Форма встроена в страницу, а не спрятана в модальное окно: полей три, и
 * диалог ради них стоил бы пользователю лишнего нажатия на каждое добавление.
 */
function NewSectionForm({ onCreated }: { onCreated: () => Promise<void> }): ReactNode {
  const { message } = AntApp.useApp();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => catalog.createSection({ code, name }),
    onSuccess: async () => {
      setCode('');
      setName('');
      await onCreated();
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  return (
    <Space wrap>
      <Input
        placeholder="Код (латиницей)"
        style={{ width: 200 }}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        data-testid="section-code"
      />
      <Input
        placeholder="Наименование"
        style={{ width: 320 }}
        value={name}
        onChange={(event) => setName(event.target.value)}
        data-testid="section-name"
      />
      <Button
        type="primary"
        size="small"
        disabled={code === '' || name === ''}
        loading={create.isPending}
        data-testid="create-section"
        onClick={() => {
          create.mutate();
        }}
      >
        Завести раздел
      </Button>
    </Space>
  );
}

/**
 * Реестр рабочей документации объекта (§14).
 *
 * Шифр РД — коммерческие данные с областью видимости, поэтому реестр читается
 * ПО ОБЪЕКТУ: маршрута «все шифры сразу» в API нет намеренно, и собирать его
 * клиентским обходом объектов значило бы обойти ту же границу другим путём.
 *
 * Отключённый шифр показывается, а не прячется: ссылка на него могла остаться в
 * прогонах разметки, и «шифр исчез» читалось бы как потеря данных.
 */
function RdDocumentsTable(): ReactNode {
  const objects = useQuery({
    queryKey: catalogKeys.objects(''),
    queryFn: () => catalog.objects({}),
  });
  const [objectId, setObjectId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const selected = objectId ?? objects.data?.items[0]?.id ?? null;

  const documents = useQuery({
    queryKey: catalogKeys.rdDocuments(selected ?? 'none', search),
    queryFn: () => catalog.rdDocuments(selected ?? '', search),
    enabled: selected !== null,
  });

  if (objects.isPending) return <LoadingState />;
  if (objects.isError) return <ErrorState error={objects.error} />;
  if (objects.data.items.length === 0) {
    return (
      <EmptyState label="Объектов в вашей области видимости нет: реестр РД читается по объекту" />
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        {objects.data.items.map((object) => (
          <Tag
            key={object.id}
            color={object.id === selected ? 'blue' : 'default'}
            style={{ cursor: 'pointer' }}
            onClick={() => setObjectId(object.id)}
          >
            {object.code}
          </Tag>
        ))}
      </Space>

      <Input.Search
        allowClear
        placeholder="Поиск по шифру и наименованию"
        onSearch={setSearch}
        style={{ maxWidth: 360 }}
        aria-label="Поиск шифра РД"
      />

      {documents.isError && <ErrorState error={documents.error} />}
      <Table<RdDocument>
        rowKey="id"
        size="small"
        pagination={false}
        loading={documents.isPending}
        dataSource={documents.data?.items ?? []}
        locale={{ emptyText: 'Шифры РД по этому объекту не заведены' }}
        columns={[
          { title: 'Шифр', dataIndex: 'cipher', key: 'cipher' },
          {
            title: 'Изменение',
            dataIndex: 'revision',
            key: 'revision',
            render: (value: string | null) => value ?? '—',
          },
          {
            title: 'Наименование',
            dataIndex: 'name',
            key: 'name',
            render: (value: string | null) => value ?? '—',
          },
          {
            title: 'Состояние',
            dataIndex: 'isActive',
            key: 'isActive',
            render: (value: boolean) =>
              value ? (
                <ToneTag tone="success">действует</ToneTag>
              ) : (
                <ToneTag tone="danger">отключён</ToneTag>
              ),
          },
        ]}
      />
    </Space>
  );
}

function DocTypesTable(): ReactNode {
  const [includeInactive, setIncludeInactive] = useState(false);
  const query = useQuery({
    queryKey: catalogKeys.docTypes(includeInactive),
    queryFn: () => catalog.docTypes(includeInactive),
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;

  return (
    <>
      <label style={{ display: 'inline-flex', gap: 8, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(event) => setIncludeInactive(event.target.checked)}
        />
        <span>Показывать отключённые</span>
      </label>
      <Table<DocType>
        rowKey="code"
        size="small"
        pagination={false}
        dataSource={query.data}
        locale={{ emptyText: 'Каталог видов ИД пуст' }}
        columns={[
          { title: 'Код', dataIndex: 'code', key: 'code' },
          { title: 'Наименование', dataIndex: 'name', key: 'name' },
          { title: 'Группа', dataIndex: 'groupCode', key: 'groupCode' },
          {
            title: 'Признаки',
            key: 'flags',
            render: (_value, row) => (
              <Space size={4} wrap>
                {row.isFallback && <Tag color="purple">резервный</Tag>}
                {row.isSystem && <Tag>системный</Tag>}
                {row.hasOverride && <Tag color="gold">есть наложение</Tag>}
                {!row.isActive && <Tag color="red">отключён</Tag>}
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}
