/**
 * Реестр передачи ИД: шапка, состав, файл описи, передача и приёмка (§3).
 *
 * ## Почему на экране одновременно и состав, и снимок
 *
 * До передачи состав — это набор ссылок на комплекты, и он меняется. После
 * передачи он же — строки `registry_items`, скопированные вместе с
 * наименованием и исполнителем. Второе не пересчитывается из первого намеренно:
 * переименование работы не должно переписывать уже подписанную опись. Поэтому
 * после передачи экран показывает СНИМОК, а не текущее состояние комплектов.
 *
 * ## Препятствия передачи показываются, а не прячут кнопку
 *
 * `blockers` приходят готовыми фразами с сервера. Спрятанная кнопка «Передать»
 * оставила бы инженера гадать, чего не хватает; список причин отвечает на это
 * прямо. Кнопка остаётся нажимаемой, когда препятствий нет, и отсутствует
 * только там, где нет права.
 *
 * ## Чего здесь нет для подрядчика
 *
 * Сервер не отдаёт подрядчику ни состава, ни файла, ни препятствий — это
 * сведения о работе соседей по папке. Экран не подставляет вместо них нули:
 * отсутствие полей показывается объяснением, а не пустой таблицей.
 */
import { useState, type ReactNode } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys, navigationKeys } from '../../api/keys.js';
import {
  acceptRegistry,
  attachRegistryFile,
  excludeWork,
  getRegistry,
  includeWork,
  issueRegistry,
  listRegistryItems,
  listWorks,
  pagesItems,
  updateRegistry,
  type Registry,
  type RegistryItem,
  type RegistryView,
  type Work,
} from '../../api/navigation.js';
import { describeError } from '../../api/problem.js';
import type { ObjectContractor } from '../../api/types.js';
import {
  ErrorState,
  ExplainedLimitation,
  LoadingState,
  ScreenHeading,
  UnavailableState,
} from '../../shared/ui.js';
import { REGISTRY_STATUS_LABELS, labelOf } from '../../shared/labels.js';
import { Link } from '../../app/router.js';
import { useSession } from '../../app/session.js';
import { periodLabel } from './ObjectScreen.js';

export function RegistryScreen({ registryId }: { registryId: string }): ReactNode {
  const { can } = useSession();
  const view = useQuery({
    queryKey: navigationKeys.registry(registryId),
    queryFn: () => getRegistry(registryId),
  });

  if (view.isPending) return <LoadingState label="Загрузка реестра…" />;
  if (view.isError) return <ErrorState error={view.error} title="Реестр недоступен" />;
  if (view.data.kind === 'unavailable') {
    return (
      <UnavailableState
        route={view.data.route}
        what="Реестр передачи"
        reason={view.data.reason}
        detail={view.data.detail}
      />
    );
  }

  const data: RegistryView = view.data.data;
  const registry = data.registry;
  const draft = registry.status === 'draft';

  return (
    <RegistryBody
      registryId={registryId}
      data={data}
      registry={registry}
      draft={draft}
      manages={can('registry.manage')}
      accepts={can('registry.accept')}
    />
  );
}

function RegistryBody({
  registryId,
  data,
  registry,
  draft,
  manages,
  accepts,
}: {
  registryId: string;
  data: RegistryView;
  registry: Registry;
  draft: boolean;
  manages: boolean;
  accepts: boolean;
}): ReactNode {
  const contractors = useQuery({
    queryKey: catalogKeys.objectContractors(registry.objectId),
    queryFn: () => catalog.objectContractors(registry.objectId),
  });

  const sections = useQuery({
    queryKey: catalogKeys.sections(registry.objectId),
    queryFn: () => catalog.objectSections(registry.objectId),
  });

  const sectionName =
    (sections.data ?? []).find((row) => row.sectionCode === registry.sectionCode)?.name ??
    registry.sectionCode;

  return (
    <>
      <ScreenHeading
        title={`Реестр ${registry.number ?? 'без номера'} — ${sectionName}`}
        extra={<Tag>{labelOf(REGISTRY_STATUS_LABELS, registry.status)}</Tag>}
      />

      <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Объект">
          <Link to={`/ids/objects/${registry.objectId}`}>карточка объекта</Link>
        </Descriptions.Item>
        <Descriptions.Item label="Раздел">{sectionName}</Descriptions.Item>
        <Descriptions.Item label="Месяц">{periodLabel(registry.period)}</Descriptions.Item>
        <Descriptions.Item label="№ папки">{registry.folderNo ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Корпус">{registry.building ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Этаж">{registry.floor ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Конструктив" span={3}>
          {registry.structure ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label="Передан">
          {registry.issuedAt === null ? '—' : new Date(registry.issuedAt).toLocaleString('ru-RU')}
        </Descriptions.Item>
        <Descriptions.Item label="Принят">
          {registry.acceptedAt === null
            ? '—'
            : new Date(registry.acceptedAt).toLocaleString('ru-RU')}
        </Descriptions.Item>
        <Descriptions.Item label="Версия">{registry.version}</Descriptions.Item>
      </Descriptions>

      {manages && draft && <HeaderForm registry={registry} />}

      {data.works === undefined ? (
        <ExplainedLimitation title="Состав папки не показывается" testId="registry-hidden">
          Реестр — общая опись нескольких организаций, и её состав виден тому, кто её ведёт. Свои
          комплекты вы видите в карточке объекта.
        </ExplainedLimitation>
      ) : (
        <>
          <CompositionCard
            registry={registry}
            works={data.works}
            contractors={contractors.data ?? []}
            draft={draft}
            manages={manages}
          />
          <FileCard registry={registry} file={data.file ?? null} manages={manages} />
        </>
      )}

      {!draft && <SnapshotCard registryId={registryId} contractors={contractors.data ?? []} />}

      <TransitionCard
        registry={registry}
        blockers={data.blockers ?? []}
        manages={manages}
        accepts={accepts}
      />
    </>
  );
}

// =====================================================================
// Шапка
// =====================================================================

interface HeaderValues {
  number?: string;
  folderNo?: string;
  building?: string;
  floor?: string;
  structure?: string;
}

/**
 * Реквизиты шапки правятся только в черновике.
 *
 * После передачи форма не показывается вовсе, а не блокируется: сервер запирает
 * строку триггером, и заполненные поля с отказом при сохранении читались бы как
 * поломка, а не как свойство переданного документа.
 */
function HeaderForm({ registry }: { registry: Registry }): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<HeaderValues>();

  const save = useMutation({
    mutationFn: (values: HeaderValues) =>
      updateRegistry(registry.id, registry.version, {
        number: values.number === undefined || values.number === '' ? null : values.number,
        folderNo: values.folderNo === undefined || values.folderNo === '' ? null : values.folderNo,
        building: values.building === undefined || values.building === '' ? null : values.building,
        floor: values.floor === undefined || values.floor === '' ? null : values.floor,
        structure:
          values.structure === undefined || values.structure === '' ? null : values.structure,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      void message.success('Реквизиты сохранены');
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  return (
    <Card size="small" title="Реквизиты шапки" style={{ marginBottom: 16 }}>
      <Form<HeaderValues>
        form={form}
        layout="inline"
        initialValues={{
          number: registry.number ?? '',
          folderNo: registry.folderNo ?? '',
          building: registry.building ?? '',
          floor: registry.floor ?? '',
          structure: registry.structure ?? '',
        }}
        onFinish={(values) => {
          save.mutate(values);
        }}
      >
        <Form.Item name="number" label="№" extra="Обязателен к передаче">
          <Input style={{ width: 120 }} data-testid="header-number" />
        </Form.Item>
        <Form.Item name="folderNo" label="№ папки">
          <Input style={{ width: 100 }} />
        </Form.Item>
        <Form.Item name="building" label="Корпус">
          <Input style={{ width: 120 }} />
        </Form.Item>
        <Form.Item name="floor" label="Этаж">
          <Input style={{ width: 90 }} />
        </Form.Item>
        <Form.Item name="structure" label="Конструктив">
          <Input style={{ width: 220 }} />
        </Form.Item>
        <Form.Item>
          <Button htmlType="submit" loading={save.isPending} data-testid="save-header">
            Сохранить
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}

// =====================================================================
// Состав
// =====================================================================

function CompositionCard({
  registry,
  works,
  contractors,
  draft,
  manages,
}: {
  registry: Registry;
  works: readonly Work[];
  contractors: readonly ObjectContractor[];
  draft: boolean;
  manages: boolean;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();

  const exclude = useMutation({
    mutationFn: (workId: string) => excludeWork(registry.id, workId, registry.version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  const named = (id: string): string =>
    contractors.find((row) => row.contractorId === id)?.name ?? '—';

  const complects = works.filter((row) => row.kind === 'complect');

  return (
    <Card
      size="small"
      title="Состав"
      style={{ marginBottom: 16 }}
      extra={manages && draft ? <AddWorkControl registry={registry} included={complects} /> : null}
    >
      <Table<Work>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={[...complects]}
        locale={{ emptyText: 'В папке пока нет ни одного комплекта' }}
        columns={[
          { title: '№', dataIndex: 'ordinal', key: 'ordinal', width: 60 },
          {
            title: 'Работа',
            dataIndex: 'title',
            key: 'title',
            render: (title: string, row) =>
              row.currentRevisionId === null ? (
                title
              ) : (
                <Link to={`/ids/revisions/${row.currentRevisionId}`}>{title}</Link>
              ),
          },
          {
            title: 'Исполнитель',
            dataIndex: 'contractorId',
            key: 'contractorId',
            render: (id: string) => named(id),
          },
          ...(manages && draft
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 110,
                  render: (_: unknown, row: Work) => (
                    <Popconfirm
                      title="Исключить комплект из папки?"
                      okText="Исключить"
                      cancelText="Отмена"
                      onConfirm={() => exclude.mutate(row.id)}
                    >
                      <Button size="small" danger>
                        Исключить
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  );
}

/**
 * Добавление комплекта в папку.
 *
 * Предлагаются только комплекты того же объекта, раздела и месяца, ещё не
 * включённые ни в один реестр: включить чужой месяц запрещает сервер, и
 * повторять его отказ выпадающим списком, который заведомо кончится 422, незачем.
 */
function AddWorkControl({
  registry,
  included,
}: {
  registry: Registry;
  included: readonly Work[];
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [workId, setWorkId] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: navigationKeys.works(
      `free:${registry.objectId}:${registry.sectionCode}:${registry.period}`,
    ),
    queryFn: () =>
      listWorks({
        objectId: registry.objectId,
        sectionCode: registry.sectionCode,
        period: registry.period,
        unassigned: true,
      }),
  });

  const include = useMutation({
    mutationFn: (id: string) => includeWork(registry.id, id, registry.version),
    onSuccess: async () => {
      setWorkId(null);
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  const known = new Set(included.map((row) => row.id));
  const options = pagesItems(candidates.data === undefined ? undefined : [candidates.data])
    .filter((row) => row.kind === 'complect' && !known.has(row.id))
    .map((row) => ({ value: row.id, label: row.title }));

  return (
    <Space>
      <Select<string>
        style={{ minWidth: 280 }}
        placeholder="Добавить комплект"
        showSearch
        optionFilterProp="label"
        value={workId}
        onChange={setWorkId}
        options={options}
        loading={candidates.isPending}
        notFoundContent="Свободных комплектов этого месяца нет"
        data-testid="add-work"
      />
      <Button
        size="small"
        disabled={workId === null}
        loading={include.isPending}
        onClick={() => {
          if (workId !== null) include.mutate(workId);
        }}
      >
        Включить
      </Button>
    </Space>
  );
}

// =====================================================================
// Файл описи
// =====================================================================

/**
 * Скан подписанной описи.
 *
 * Заводится как обычный комплект вида `registry`: сам файл грузится на его
 * ревизию тем же приёмом, что и любая ИД, и подаётся тем же `submit`. Ссылка
 * ведёт на экран ревизии, потому что там и живёт загрузка файлов.
 */
function FileCard({
  registry,
  file,
  manages,
}: {
  registry: Registry;
  file: Work | null;
  manages: boolean;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();

  const attach = useMutation({
    mutationFn: () => attachRegistryFile(registry.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      void message.success('Файл заведён: загрузите скан на его ревизии');
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  return (
    <Card size="small" title="Файл реестра" style={{ marginBottom: 16 }}>
      {file === null ? (
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary">
            Подписанный скан описи ещё не заведён. Передать папку без него нельзя.
          </Typography.Text>
          {manages && registry.status === 'draft' && (
            <Button
              type="primary"
              size="small"
              loading={attach.isPending}
              data-testid="attach-file"
              onClick={() => {
                attach.mutate();
              }}
            >
              Завести файл описи
            </Button>
          )}
        </Space>
      ) : (
        <Space direction="vertical" size={8}>
          <Typography.Text>{file.title}</Typography.Text>
          {file.currentRevisionId === null ? (
            <Typography.Text type="secondary">Ревизия не открыта</Typography.Text>
          ) : (
            <Link to={`/ids/revisions/${file.currentRevisionId}`}>
              Открыть ревизию файла — загрузка и подача скана
            </Link>
          )}
        </Space>
      )}
    </Card>
  );
}

// =====================================================================
// Снимок состава
// =====================================================================

function SnapshotCard({
  registryId,
  contractors,
}: {
  registryId: string;
  contractors: readonly ObjectContractor[];
}): ReactNode {
  const items = useQuery({
    queryKey: navigationKeys.registryItems(registryId),
    queryFn: () => listRegistryItems(registryId),
  });

  return (
    <Card size="small" title="Опись на момент передачи" style={{ marginBottom: 16 }}>
      {items.isPending && <LoadingState label="Загрузка описи…" />}
      {items.isError && <ErrorState error={items.error} />}
      {items.isSuccess && (
        <Table<RegistryItem>
          rowKey="ordinal"
          size="small"
          pagination={false}
          dataSource={items.data}
          locale={{ emptyText: 'Снимок пуст' }}
          columns={[
            { title: '№', dataIndex: 'ordinal', key: 'ordinal', width: 60 },
            {
              title: 'Работа',
              dataIndex: 'title',
              key: 'title',
              render: (title: string, row) => (
                <Link to={`/ids/revisions/${row.revisionId}`}>{title}</Link>
              ),
            },
            {
              title: 'Исполнитель',
              dataIndex: 'contractorId',
              key: 'contractorId',
              render: (id: string) =>
                contractors.find((row) => row.contractorId === id)?.name ?? '—',
            },
          ]}
        />
      )}
    </Card>
  );
}

// =====================================================================
// Передача и приёмка
// =====================================================================

function TransitionCard({
  registry,
  blockers,
  manages,
  accepts,
}: {
  registry: Registry;
  blockers: readonly { code: string; message: string }[];
  manages: boolean;
  accepts: boolean;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<unknown>(null);

  const issue = useMutation({
    mutationFn: () => issueRegistry(registry.id, registry.version),
    onSuccess: async () => {
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      void message.success('Папка передана: состав зафиксирован');
    },
    onError: (error: unknown) => setFailure(error),
  });

  const accept = useMutation({
    mutationFn: () => acceptRegistry(registry.id, registry.version),
    onSuccess: async () => {
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
    onError: (error: unknown) => setFailure(error),
  });

  if (!manages && !accepts) return null;

  return (
    <Card size="small" title="Передача">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {failure !== null && <ErrorState error={failure} title="Переход не выполнен" />}

        {registry.status === 'draft' && blockers.length > 0 && (
          <ExplainedLimitation title="Папку пока нельзя передать" testId="issue-blockers">
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.message}</li>
              ))}
            </ul>
          </ExplainedLimitation>
        )}

        <Space wrap>
          {manages && registry.status === 'draft' && (
            <Button
              type="primary"
              loading={issue.isPending}
              disabled={blockers.length > 0}
              data-testid="issue-registry"
              onClick={() => {
                issue.mutate();
              }}
            >
              Передать
            </Button>
          )}
          {accepts && registry.status === 'issued' && (
            <Button
              type="primary"
              loading={accept.isPending}
              data-testid="accept-registry"
              onClick={() => {
                accept.mutate();
              }}
            >
              Принять
            </Button>
          )}
          {registry.status === 'accepted' && (
            <Typography.Text type="secondary">
              Папка принята. Исправления оформляются новым реестром с новым номером.
            </Typography.Text>
          )}
        </Space>
      </Space>
    </Card>
  );
}
