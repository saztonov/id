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
  Modal,
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
  deleteRegistry,
  excludeWork,
  getRegistry,
  getRegistryDeletionPreview,
  getRegistryReconciliation,
  includeWork,
  issueRegistry,
  listRegistryItems,
  listWorks,
  pagesItems,
  reconcileRegistry,
  reviewReconciliation,
  updateRegistry,
  type ReconciliationExtraDocument,
  type ReconciliationGroup,
  type ReconciliationRow,
  type ReconciliationVerdict,
  type ReconciliationWork,
  type Registry,
  type RegistryItem,
  type RegistryReconciliation,
  type RegistryReconciliationView,
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
import { Link, useNavigate } from '../../app/router.js';
import { useSession } from '../../app/session.js';
import { IconAction, RowActions } from '../../shared/RowActions.js';
import { TrashIcon } from '../../shared/icons.js';
import { monthLabel } from './pipelineState.js';

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
        extra={
          <>
            <Tag>{labelOf(REGISTRY_STATUS_LABELS, registry.status)}</Tag>
            {/*
              Кнопка появляется только у черновика — СКРЫВАЕТСЯ, а не гасится,
              по тому же основанию, что и форма шапки: заблокированный элемент
              на переданной папке читался бы как поломка, а не как свойство
              подписанного документа.
            */}
            {draft && <DeleteRegistryAction registry={registry} />}
          </>
        }
      />

      <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Объект">
          <Link to={`/ids/objects/${registry.objectId}`}>карточка объекта</Link>
        </Descriptions.Item>
        <Descriptions.Item label="Раздел">{sectionName}</Descriptions.Item>
        <Descriptions.Item label="Месяц">{monthLabel(registry.period)}</Descriptions.Item>
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

      {manages && <ReconciliationCard registry={registry} summary={data.reconciliation ?? null} />}

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
 * Удалить папку.
 *
 * Копия `DeleteWorkAction` с одним отличием, ради которого она и написана
 * отдельно: предпросмотр здесь говорит ДВУМЯ глаголами. Комплекты состава
 * отвязываются и остаются на объекте; удаляются только файл описи и прогоны
 * сверки — то, что без реестра существовать не может. Один счётчик «будет
 * удалено» напугал бы человека тем, чего не произойдёт.
 *
 * Предпросмотр грузится ПО ОТКРЫТИЮ, а не вместе с экраном: числа знает только
 * БД, а спрашивать их у каждого, кто просто смотрит папку, незачем.
 */
function DeleteRegistryAction({ registry }: { registry: Registry }): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const preview = useQuery({
    queryKey: navigationKeys.registryDeletionPreview(registry.id),
    queryFn: () => getRegistryDeletionPreview(registry.id),
    enabled: open,
  });

  const remove = useMutation({
    mutationFn: () => deleteRegistry(registry.id, registry.version),
    onSuccess: async () => {
      message.success(`Реестр ${registry.number ?? 'без номера'} удалён`);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: navigationKeys.root });
      // Экран удалённой папки показывать нечего: уходим на объект, где видно и
      // отвязанные комплекты.
      navigate(`/ids/objects/${registry.objectId}`);
    },
    onError: (error) => message.error(describeError(error)),
  });

  const blockers = preview.data?.blockers ?? [];

  return (
    <>
      <RowActions>
        <IconAction
          icon={<TrashIcon />}
          label={`Удалить реестр ${registry.number ?? 'без номера'}`}
          danger
          onClick={() => setOpen(true)}
          testId={`delete-registry-${registry.id}`}
        />
      </RowActions>

      <Modal
        open={open}
        title={`Удалить реестр ${registry.number ?? 'без номера'}?`}
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
            <ExplainedLimitation title="Этот реестр удалить нельзя">
              <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                {blockers.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              Переданная опись подписана обеими сторонами: исправления оформляются новым реестром с
              новым номером, а не правкой старого.
            </ExplainedLimitation>
          ) : (
            <Space direction="vertical" size={8}>
              <Typography.Text>
                Комплектов будет отвязано: {preview.data.worksDetached} — сами комплекты, их ревизии
                и проверки останутся на объекте.
              </Typography.Text>
              <Typography.Text>Будет удалено безвозвратно:</Typography.Text>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  {preview.data.file === null
                    ? 'файла описи нет'
                    : `файл описи «${preview.data.file.title}»: ревизий ${preview.data.file.revisions}, ` +
                      `файлов ${preview.data.file.files}, страниц ${preview.data.file.pages}`}
                </li>
                <li>прогонов сверки описи: {preview.data.reconciliations}</li>
              </ul>
            </Space>
          ))}
      </Modal>
    </>
  );
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
        // Комплект, который портал ещё не распознал, месяца не имеет (S30) — и
        // без этого признака выпал бы из кандидатов, хотя включить его можно:
        // сверка месяца при включении пропускает неизвестный.
        includeUndatedPeriod: true,
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
        // Подсказка внутри поля скринридером не читается: axe (§17) считает
        // такое поле безымянным, и это критическое нарушение. Дефект достался
        // от S19 и найден первым же прогоном axe по этому экрану.
        aria-label="Добавить комплект в реестр"
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
// Сверка описи
// =====================================================================

const VERDICT_LABELS: Record<ReconciliationVerdict, string> = {
  clean: 'расхождений нет',
  mismatch: 'есть расхождения',
  unparsed: 'опись не разобрана',
};

const VERDICT_COLORS: Record<ReconciliationVerdict, string> = {
  clean: 'green',
  mismatch: 'red',
  unparsed: 'orange',
};

const MATCH_LABELS: Record<string, string> = {
  matched: 'сопоставлено',
  missing: 'не найдено',
  ambiguous: 'неоднозначно',
};

/** Коды расхождений реквизитов — словами: `issued_at` человек не читает. */
const FIELD_LABELS: Record<string, string> = {
  issued_at: 'дата',
  organization: 'организация',
  sheets: 'число листов',
};

export function fieldMismatchLabel(codes: readonly string[]): string {
  return codes.map((code) => FIELD_LABELS[code] ?? code).join(', ');
}

/**
 * Сверка описи с комплектами папки — карточка ВЕДУЩЕГО папку.
 *
 * Показывается только под `registry.manage`: здесь шапка описи, группы без
 * комплекта и комплекты, которых опись не назвала, — сведения о папке целиком.
 * Подрядчик читает свои расхождения на экране своего комплекта, где ничего
 * этого нет ни на экране, ни в ответе сервера.
 *
 * Сверка ничего не блокирует: вердикт `mismatch` не мешает ни передаче, ни
 * приёмке. Она отвечает на вопрос «что здесь не так», а решение принимает
 * человек.
 */
function ReconciliationCard({
  registry,
  summary,
}: {
  registry: Registry;
  summary: RegistryReconciliation | null;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const details = useQuery({
    queryKey: navigationKeys.registryReconciliation(registry.id),
    queryFn: () => getRegistryReconciliation(registry.id),
    enabled: open,
  });

  const reconcile = useMutation({
    mutationFn: () => reconcileRegistry(registry.id),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      void message.success(
        result.created
          ? 'Сверка поставлена в очередь: обновите страницу через несколько секунд'
          : 'Сверка этой папки уже идёт',
      );
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  const view = details.data?.kind === 'available' ? details.data.data : null;

  return (
    <Card
      size="small"
      title="Сверка описи"
      style={{ marginBottom: 16 }}
      extra={
        <Space size={8}>
          <Button
            size="small"
            loading={reconcile.isPending}
            data-testid="reconcile-run"
            onClick={() => {
              reconcile.mutate();
            }}
          >
            Сверить
          </Button>
          {summary !== null && (
            <Button
              size="small"
              type="link"
              onClick={() => {
                setOpen((value) => !value);
              }}
            >
              {open ? 'Свернуть' : 'Расхождения'}
            </Button>
          )}
        </Space>
      }
    >
      {summary === null ? (
        <Typography.Text type="secondary" data-testid="reconciliation-empty">
          Опись ещё не сверялась. Скан описи нужно провести по конвейеру — загрузить, разметить и
          распознать на его ревизии, — после чего нажать «Сверить».
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Tag color={VERDICT_COLORS[summary.verdict]} data-testid="reconciliation-verdict">
              {VERDICT_LABELS[summary.verdict]}
            </Tag>
            <Typography.Text>
              групп {summary.groupsTotal} (без комплекта {summary.groupsMissing}), строк{' '}
              {summary.rowsTotal} (не найдено {summary.rowsMissing}, расходятся реквизиты{' '}
              {summary.rowsFieldMismatch}), комплектов вне описи {summary.worksExtra}, документов
              вне описи {summary.extraDocuments}
            </Typography.Text>
          </Space>

          {summary.headerMismatch && (
            <Typography.Text type="danger">
              Шапка описи расходится с карточкой реестра: в бумаге №{' '}
              {summary.headerRegistryNo ?? '—'}, папка {summary.headerFolderNo ?? '—'}.
            </Typography.Text>
          )}

          {summary.warnings.length > 0 && (
            <Typography.Text type="warning">
              Разбор описи: {summary.warnings.join('; ')}
            </Typography.Text>
          )}

          {/* Версия разбора и время прогона объясняют, почему вчерашняя сверка
              расходится с сегодняшней на том же скане. */}
          <Typography.Text type="secondary">
            {new Date(summary.finishedAt).toLocaleString('ru-RU')}, разбор {summary.parserVersion}
            {summary.reviewedNote === null ? '' : ` · разобрано: ${summary.reviewedNote}`}
          </Typography.Text>

          {open && details.isPending && <LoadingState label="Загрузка расхождений…" />}
          {open && view !== null && <ReconciliationDetails view={view} />}

          <ReviewControl registry={registry} summary={summary} />
        </Space>
      )}
    </Card>
  );
}

/** Четыре списка расхождений; каждый ведёт на экран, где его чинят. */
function ReconciliationDetails({ view }: { view: RegistryReconciliationView }): ReactNode {
  const works = view.works ?? [];
  const groups = view.groups ?? [];
  const rows = view.rows ?? [];
  const extra = view.extraDocuments ?? [];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Table<ReconciliationWork>
        size="small"
        rowKey={(row) => row.workId}
        dataSource={works}
        pagination={false}
        title={() => 'Комплекты папки'}
        columns={[
          { title: 'Работа', dataIndex: 'title' },
          {
            title: 'Исполнитель',
            dataIndex: 'contractorName',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'Вердикт',
            dataIndex: 'verdict',
            render: (verdict: ReconciliationVerdict, row) => (
              <Tag color={VERDICT_COLORS[verdict]}>
                {row.state === 'extra' ? 'не названа описью' : VERDICT_LABELS[verdict]}
              </Tag>
            ),
          },
          {
            title: 'Строки',
            render: (_: unknown, row) =>
              `${row.rowsMatched}/${row.rowsTotal}, реквизиты ${row.rowsFieldMismatch}`,
          },
          {
            title: '',
            render: (_: unknown, row) =>
              row.matchedRevisionId === null ? null : (
                <Link to={`/ids/revisions/${row.matchedRevisionId}`}>открыть</Link>
              ),
          },
        ]}
      />

      <Table<ReconciliationGroup>
        size="small"
        rowKey={(row) => row.ordinal}
        dataSource={groups.filter((group) => group.matchState !== 'matched')}
        pagination={false}
        title={() => 'Группы описи без комплекта'}
        locale={{ emptyText: 'Все группы описи нашли свой комплект' }}
        columns={[
          { title: '№', dataIndex: 'groupNo', render: (v: string | null) => v ?? '—' },
          { title: 'Работа по описи', dataIndex: 'titleRaw' },
          { title: '№ АОСР', dataIndex: 'actNoRaw', render: (v: string | null) => v ?? '—' },
          {
            title: 'Исполнитель',
            dataIndex: 'contractorRaw',
            render: (v: string | null) => v ?? '—',
          },
          { title: 'Причина', dataIndex: 'reason' },
        ]}
      />

      <Table<ReconciliationRow>
        size="small"
        rowKey={(row) => row.ordinal}
        dataSource={rows.filter(
          (row) => row.matchState !== 'matched' || row.fieldMismatches.length > 0,
        )}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        title={() => 'Строки описи с расхождениями'}
        locale={{ emptyText: 'Каждая строка описи нашла свой документ' }}
        columns={[
          { title: '№ п/п', dataIndex: 'rowNo', render: (v: string | null) => v ?? '—' },
          { title: 'Документ по описи', dataIndex: 'docNameRaw' },
          { title: '№', dataIndex: 'docNoRaw', render: (v: string | null) => v ?? '—' },
          {
            title: 'Что не так',
            render: (_: unknown, row) =>
              row.fieldMismatches.length > 0
                ? `расходятся: ${fieldMismatchLabel(row.fieldMismatches)}`
                : (MATCH_LABELS[row.matchState] ?? row.matchState),
          },
          {
            title: '',
            render: (_: unknown, row) =>
              row.matchedDocumentId === null ? null : (
                <Link to={`/ids/documents/${row.matchedDocumentId}`}>документ</Link>
              ),
          },
        ]}
      />

      <Table<ReconciliationExtraDocument>
        size="small"
        rowKey={(row) => row.documentId}
        dataSource={extra}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        title={() => 'Есть в портале, но опись их не называет'}
        locale={{ emptyText: 'Каждый документ комплектов назван описью' }}
        columns={[
          { title: 'Документ', dataIndex: 'docNameRaw', render: (v: string | null) => v ?? '—' },
          { title: '№', dataIndex: 'docNoRaw', render: (v: string | null) => v ?? '—' },
          { title: 'Вид', dataIndex: 'docTypeCode', render: (v: string | null) => v ?? '—' },
          {
            title: '',
            render: (_: unknown, row) => (
              <Link to={`/ids/revisions/${row.revisionId}`}>комплект</Link>
            ),
          },
        ]}
      />
    </Space>
  );
}

/**
 * Отметка «разобрано»: суждение принимающей стороны, а не наблюдение портала.
 *
 * Пояснение обязательно и не короче десяти символов — отметка без объяснения
 * неотличима от «закрыл, чтобы не мозолило», и следующий человек не поймёт,
 * разобрано расхождение или спрятано.
 */
function ReviewControl({
  registry,
  summary,
}: {
  registry: Registry;
  summary: RegistryReconciliation;
}): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const review = useMutation({
    mutationFn: () => reviewReconciliation(registry.id, summary.version, note),
    onSuccess: async () => {
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      void message.success('Отметка «разобрано» сохранена');
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  if (!can('registry.accept') || summary.verdict === 'clean') return null;

  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input
        placeholder="Чем объясняется расхождение (не короче 10 символов)"
        aria-label="Пояснение к отметке «разобрано»"
        value={note}
        maxLength={1000}
        data-testid="review-note"
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      <Button
        disabled={note.trim().length < 10}
        loading={review.isPending}
        data-testid="review-submit"
        onClick={() => {
          review.mutate();
        }}
      >
        Разобрано
      </Button>
    </Space.Compact>
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
