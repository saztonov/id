/**
 * Объект: комплекты работ, реестры передачи и настройка объекта (§3, §14).
 *
 * ## Комплект заводится здесь, а не в реестре
 *
 * Подрядчик знает объект, раздел и месяц; в какую папку его работа войдёт,
 * решает ПТО генподрядчика позже. Форма поэтому спрашивает ровно эти три вещи
 * и наименование работы — и ничего про реестр.
 *
 * ## Исполнителя выбирает только генподрядчик
 *
 * У подрядчика поля нет вовсе, и это не сокрытие возможности: сервер берёт его
 * организацию из области видимости, а поле в теле запроса отвергает как попытку
 * завести работу от чужого имени. У генподрядчика поле обязательно к показу —
 * субподрядчики учётных записей в портале, как правило, не имеют.
 *
 * ## Настройка объекта видна тем, кто ею занимается
 *
 * Включённые разделы и закреплённые подрядчики — не справочник портала, а
 * состояние стройки. Правит их генподрядчик и администратор; остальные видят
 * список, потому что без него непонятно, почему в форме нет нужного раздела.
 */
import { useState, type ReactNode } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys, navigationKeys } from '../../api/keys.js';
import {
  createRegistry,
  createWork,
  listRegistries,
  listWorks,
  pagesBlocked,
  pagesItems,
  type Registry,
  type Work,
} from '../../api/navigation.js';
import { describeError } from '../../api/problem.js';
import type { ConstructionObject, ObjectContractor, ObjectSection } from '../../api/types.js';
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

/** Текущий месяц первым числом — то, что подставляется в форму по умолчанию. */
function currentPeriod(): string {
  const now = new Date();
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** `2026-08-01` → `август 2026`: месяц читают словом, а не датой. */
const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

export function periodLabel(period: string): string {
  const [year, month] = period.split('-');
  const index = Number(month) - 1;
  return MONTHS[index] === undefined ? period : `${MONTHS[index]} ${year ?? ''}`.trim();
}

export function ObjectScreen({ objectId }: { objectId: string }): ReactNode {
  const { can } = useSession();
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

  const works = useInfiniteQuery({
    queryKey: navigationKeys.works(objectId),
    queryFn: ({ pageParam }) => listWorks({ objectId, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.kind === 'available' ? last.data.nextCursor : null),
  });

  const registries = useInfiniteQuery({
    queryKey: navigationKeys.registries(objectId),
    queryFn: ({ pageParam }) => listRegistries({ objectId, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.kind === 'available' ? last.data.nextCursor : null),
  });

  const enabled = (sections.data ?? []).filter((row) => row.isActive);
  const assigned = (contractors.data ?? []).filter((row) => row.isActive);
  const worksBlocked = pagesBlocked(works.data?.pages);

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

      <NewWorkCard objectId={objectId} sections={enabled} contractors={assigned} />

      <Card size="small" title="Комплекты работ" style={{ marginTop: 16 }}>
        {works.isPending && <LoadingState label="Загрузка комплектов…" />}
        {works.isError && <ErrorState error={works.error} />}
        {worksBlocked !== null && (
          <UnavailableState
            route={worksBlocked.route}
            what="Комплекты объекта"
            reason={worksBlocked.reason}
            detail={worksBlocked.detail}
          />
        )}
        {works.isSuccess && worksBlocked === null && (
          <>
            <Table<Work>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={pagesItems(works.data.pages)}
              locale={{ emptyText: 'Комплектов на объекте нет' }}
              columns={[
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
                  title: 'Раздел',
                  dataIndex: 'sectionCode',
                  key: 'sectionCode',
                  render: (code: string) =>
                    (sections.data ?? []).find((row) => row.sectionCode === code)?.name ?? code,
                },
                {
                  title: 'Месяц',
                  dataIndex: 'period',
                  key: 'period',
                  render: (period: string) => periodLabel(period),
                },
                {
                  title: 'Исполнитель',
                  dataIndex: 'contractorId',
                  key: 'contractorId',
                  render: (id: string) =>
                    (contractors.data ?? []).find((row) => row.contractorId === id)?.name ?? '—',
                },
                {
                  title: 'Реестр',
                  dataIndex: 'registryId',
                  key: 'registryId',
                  render: (registryId: string | null) =>
                    registryId === null ? (
                      <Tag>не включён</Tag>
                    ) : (
                      <Link to={`/ids/registries/${registryId}`}>папка</Link>
                    ),
                },
              ]}
            />
            {works.hasNextPage && (
              <Button
                style={{ marginTop: 12 }}
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
      </Card>

      <Card
        size="small"
        title="Реестры передачи"
        style={{ marginTop: 16 }}
        extra={
          can('registry.manage') ? (
            <NewRegistryButton objectId={objectId} sections={enabled} />
          ) : null
        }
      >
        {registries.isPending && <LoadingState label="Загрузка реестров…" />}
        {registries.isError && <ErrorState error={registries.error} />}
        {registries.isSuccess && (
          <Table<Registry>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={pagesItems(registries.data.pages)}
            locale={{ emptyText: 'Реестров на объекте нет' }}
            columns={[
              {
                title: '№',
                dataIndex: 'number',
                key: 'number',
                render: (number: string | null, row) => (
                  <Link to={`/ids/registries/${row.id}`}>{number ?? 'без номера'}</Link>
                ),
              },
              {
                title: 'Раздел',
                dataIndex: 'sectionCode',
                key: 'sectionCode',
                render: (code: string) =>
                  (sections.data ?? []).find((row) => row.sectionCode === code)?.name ?? code,
              },
              {
                title: 'Месяц',
                dataIndex: 'period',
                key: 'period',
                render: (period: string) => periodLabel(period),
              },
              {
                title: 'Состояние',
                dataIndex: 'status',
                key: 'status',
                render: (status: string) => <Tag>{labelOf(REGISTRY_STATUS_LABELS, status)}</Tag>,
              },
            ]}
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

/**
 * Разделы и подрядчики объекта.
 *
 * Показывается всем, кто видит объект: без него подрядчик не понимает, почему в
 * форме заведения нет нужного раздела. Переключатели — только у того, кто ведёт
 * стройку.
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
    <Card size="small" title="Настройка объекта" style={{ marginBottom: 16 }}>
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
    </Card>
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

interface WorkFormValues {
  sectionCode: string;
  period: string;
  title: string;
  contractorId?: string;
}

/**
 * Заведение комплекта.
 *
 * Карточка показывается по праву `submission.upload`, но её отказ объясняется
 * заранее: у подрядчика без закрепления сервер ответит 422, и спрятанная кнопка
 * научила бы его, что функции нет, вместо того чтобы объяснить, чего не хватает.
 */
function NewWorkCard({
  objectId,
  sections,
  contractors,
}: {
  objectId: string;
  sections: readonly ObjectSection[];
  contractors: readonly ObjectContractor[];
}): ReactNode {
  const { can, me } = useSession();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<WorkFormValues>();
  const [failure, setFailure] = useState<unknown>(null);

  const isGeneralContractor = me.scope?.kind === 'general_contractor';

  const create = useMutation({
    mutationFn: (values: WorkFormValues) =>
      createWork({
        objectId,
        sectionCode: values.sectionCode,
        period: values.period,
        title: values.title,
        ...(values.contractorId === undefined ? {} : { contractorId: values.contractorId }),
      }),
    onSuccess: async (created) => {
      setFailure(null);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      void message.success('Комплект заведён вместе с первой ревизией');
      navigate(`/ids/revisions/${created.revision.id}`);
    },
    // Отказ показывается на месте формы, а не всплывашкой: причина отказа —
    // часть объяснения ограничения, и она обязана оставаться на экране.
    onError: (error: unknown) => setFailure(error),
  });

  if (!can('submission.upload')) return null;

  return (
    <Card size="small" title="Новый комплект" style={{ marginBottom: 16 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {sections.length === 0 && (
          <ExplainedLimitation title="На объекте не включён ни один раздел" testId="no-sections">
            Комплект заводится в раздел работ, и раздел обязан быть включён на объекте. Включает его
            тот, кто ведёт стройку, — генподрядчик или администратор портала.
          </ExplainedLimitation>
        )}

        {failure !== null && <ErrorState error={failure} title="Комплект не заведён" />}

        <Form<WorkFormValues>
          form={form}
          layout="inline"
          initialValues={{ period: currentPeriod() }}
          onFinish={(values) => {
            create.mutate(values);
          }}
        >
          <Form.Item
            name="sectionCode"
            label="Раздел"
            rules={[{ required: true, message: 'Раздел обязателен' }]}
          >
            <Select
              style={{ width: 260 }}
              options={sections.map((row) => ({ value: row.sectionCode, label: row.name }))}
              data-testid="work-section"
            />
          </Form.Item>
          <Form.Item
            name="period"
            label="Месяц"
            rules={[{ required: true, message: 'Месяц обязателен' }]}
            extra="Первое число месяца"
          >
            <Input type="date" style={{ width: 170 }} data-testid="work-period" />
          </Form.Item>
          <Form.Item
            name="title"
            label="Работа"
            rules={[{ required: true, message: 'Наименование работы обязательно' }]}
          >
            <Input style={{ width: 300 }} data-testid="work-title" />
          </Form.Item>
          {isGeneralContractor && (
            <Form.Item
              name="contractorId"
              label="Исполнитель"
              extra="Пусто — работу выполнила ваша организация"
            >
              <Select
                allowClear
                style={{ width: 260 }}
                options={contractors.map((row) => ({
                  value: row.contractorId,
                  label: row.name,
                }))}
                data-testid="work-contractor"
              />
            </Form.Item>
          )}
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={create.isPending}
              disabled={sections.length === 0}
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

interface RegistryFormValues {
  sectionCode: string;
  period: string;
  number?: string;
}

function NewRegistryButton({
  objectId,
  sections,
}: {
  objectId: string;
  sections: readonly ObjectSection[];
}): ReactNode {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<RegistryFormValues>();

  const create = useMutation({
    mutationFn: (values: RegistryFormValues) =>
      createRegistry({
        objectId,
        sectionCode: values.sectionCode,
        period: values.period,
        ...(values.number === undefined ? {} : { number: values.number }),
      }),
    onSuccess: async (registry) => {
      setOpen(false);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['nav'] });
      navigate(`/ids/registries/${registry.id}`);
    },
    onError: (error) => message.error(describeError(error)),
  });

  return (
    <>
      <Button size="small" type="primary" data-testid="new-registry" onClick={() => setOpen(true)}>
        Новый реестр
      </Button>
      {open && (
        <Card
          size="small"
          title="Новый реестр"
          style={{ marginTop: 12 }}
          extra={
            <Button size="small" onClick={() => setOpen(false)}>
              Отмена
            </Button>
          }
        >
          <Form<RegistryFormValues>
            form={form}
            layout="inline"
            initialValues={{ period: currentPeriod() }}
            onFinish={(values) => {
              create.mutate(values);
            }}
          >
            <Form.Item
              name="sectionCode"
              label="Раздел"
              rules={[{ required: true, message: 'Раздел обязателен' }]}
            >
              <Select
                style={{ width: 240 }}
                options={sections.map((row) => ({ value: row.sectionCode, label: row.name }))}
                data-testid="registry-section"
              />
            </Form.Item>
            <Form.Item name="period" label="Месяц" rules={[{ required: true }]}>
              <Input type="date" style={{ width: 170 }} data-testid="registry-period" />
            </Form.Item>
            <Form.Item name="number" label="№" extra="Можно присвоить позже">
              <Input style={{ width: 120 }} data-testid="registry-number" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={create.isPending}>
                Создать
              </Button>
            </Form.Item>
          </Form>
        </Card>
      )}
    </>
  );
}
