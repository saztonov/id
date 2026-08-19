/**
 * Справочники (§14): объекты, контрагенты, разделы и виды разделов, виды ИД.
 *
 * Разделение видимости, введённое на S4, здесь проявляется буквально: объекты,
 * контрагенты и шифры РД — коммерческие данные с областью видимости, а виды
 * разделов и виды ИД — конфигурация, читаемая всеми. Поэтому вкладки не
 * скрываются по роли: сервер сам отдаёт подрядчику только то, что ему видно, и
 * пустой список у него — это правильный ответ, а не отказ.
 */
import { useState, type ReactNode } from 'react';
import { Input, Space, Table, Tabs, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import type {
  ConstructionObject,
  Counterparty,
  DocType,
  ObjectSection,
  RdDocument,
  SectionKind,
} from '../../api/types.js';
import { EmptyState, ErrorState, LoadingState, ScreenHeading } from '../../shared/ui.js';
import { Link, useNavigate, useQueryParam } from '../../app/router.js';
import { SectionProfilesPanel } from './SectionProfilesPanel.js';
import { ToneTag } from '../../shared/tags.js';

const TABS = [
  'objects',
  'counterparties',
  'sections',
  'section-profiles',
  'rd-documents',
  'doc-types',
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
          { key: 'sections', label: 'Разделы и виды разделов', children: <SectionsTable /> },
          {
            key: 'section-profiles',
            label: 'Профили разделов',
            children: <SectionProfilesPanel />,
          },
          { key: 'rd-documents', label: 'Реестр РД', children: <RdDocumentsTable /> },
          { key: 'doc-types', label: 'Виды ИД', children: <DocTypesTable /> },
        ]}
      />
    </>
  );
}

function ObjectsTable(): ReactNode {
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: catalogKeys.objects(search),
    queryFn: () => catalog.objects(search === '' ? {} : { search }),
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;

  return (
    <>
      <Input.Search
        allowClear
        placeholder="Поиск по коду и наименованию"
        onSearch={setSearch}
        style={{ maxWidth: 360, marginBottom: 12 }}
        aria-label="Поиск объекта"
      />
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
        ]}
      />
    </>
  );
}

function CounterpartiesTable(): ReactNode {
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: catalogKeys.counterparties(search, ''),
    queryFn: () => catalog.counterparties(search === '' ? {} : { search }),
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;

  return (
    <>
      <Input.Search
        allowClear
        placeholder="Поиск по наименованию"
        onSearch={setSearch}
        style={{ maxWidth: 360, marginBottom: 12 }}
        aria-label="Поиск контрагента"
      />
      <Table<Counterparty>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={query.data.items}
        locale={{ emptyText: 'Контрагентов в вашей области видимости нет' }}
        columns={[
          { title: 'Наименование', dataIndex: 'name', key: 'name' },
          { title: 'Вид', dataIndex: 'kind', key: 'kind' },
          { title: 'ИНН', dataIndex: 'inn', key: 'inn', render: (v) => v ?? '—' },
          { title: 'ОГРН', dataIndex: 'ogrn', key: 'ogrn', render: (v) => v ?? '—' },
          {
            title: 'Активен',
            dataIndex: 'isActive',
            key: 'isActive',
            render: (value: boolean) => (value ? 'да' : 'нет'),
          },
        ]}
      />
    </>
  );
}

function SectionsTable(): ReactNode {
  const objects = useQuery({
    queryKey: catalogKeys.objects(''),
    queryFn: () => catalog.objects({}),
  });
  const kinds = useQuery({
    queryKey: catalogKeys.sectionKinds(),
    queryFn: () => catalog.sectionKinds(),
  });
  const [objectId, setObjectId] = useState<string | null>(null);
  const selected = objectId ?? objects.data?.items[0]?.id ?? null;
  const sections = useQuery({
    queryKey: catalogKeys.sections(selected ?? 'none'),
    queryFn: () => catalog.sections(selected ?? ''),
    enabled: selected !== null,
  });

  if (objects.isPending) return <LoadingState />;
  if (objects.isError) return <ErrorState error={objects.error} />;

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

      <Table<ObjectSection>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={sections.data ?? []}
        locale={{ emptyText: 'Разделы работ не заведены' }}
        columns={[
          { title: 'Код', dataIndex: 'code', key: 'code' },
          { title: 'Наименование', dataIndex: 'name', key: 'name' },
          { title: 'Вид раздела', dataIndex: 'sectionKindCode', key: 'sectionKindCode' },
        ]}
      />

      <Table<SectionKind>
        rowKey="code"
        size="small"
        pagination={false}
        dataSource={kinds.data ?? []}
        title={() => 'Виды разделов (конфигурация, видна всем)'}
        locale={{ emptyText: 'Виды разделов не заведены' }}
        columns={[
          { title: 'Код', dataIndex: 'code', key: 'code' },
          { title: 'Наименование', dataIndex: 'name', key: 'name' },
        ]}
      />
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
