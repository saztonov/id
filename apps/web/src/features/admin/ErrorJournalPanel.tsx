/**
 * Журнал ошибок (§11, §14).
 *
 * ## Три числа в шапке названы по отдельности
 *
 * «Проблем», «событий» и «примеров» — разные величины, и на экране они стоят
 * рядом с подписями именно потому, что их легко перепутать. События считаются
 * по почасовым бакетам и точны; примеры прорежены политикой записи и к частоте
 * отказов отношения не имеют. Одна общая цифра «ошибок за сутки» была бы
 * правдоподобной и неверной — в зависимости от того, что в неё положили.
 *
 * ## Кнопки «показать ещё» нет у сортировки по частоте
 *
 * Частота — сумма за выбранный период; она меняется во время листания, и
 * курсора у неё не существует. Сервер возвращает топ, и экран об этом говорит
 * прямо, вместо того чтобы показывать кнопку, которая ничего не догрузит.
 *
 * ## Чего здесь нет
 *
 * Ленты «все появления»: её не существует и не может существовать — в БД
 * лежат ВЫБОРОЧНЫЕ примеры. Список примеров подписан как примеры, а не как
 * события, чтобы никто не пересчитал по нему частоту.
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
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { admin } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { ErrorIssue, ErrorIssueActionInput, ErrorSample } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { PipelineFeedbackPanel } from './PipelineFeedbackPanel.js';
import { AnomaliesPanel } from './AnomaliesPanel.js';
import { ToneTag, type Tone } from '../../shared/tags.js';
import {
  ERROR_ACTION_LABELS,
  ERROR_DOMAIN_LABELS,
  ERROR_EXECUTION_LABELS,
  ERROR_SEVERITY_LABELS,
  ERROR_SOURCE_LABELS,
  ERROR_STATUS_LABELS,
  labelOf,
} from '../../shared/labels.js';

type Section = 'issues' | 'anomalies' | 'quality';
type StatusFilter = 'all' | 'new' | 'ack' | 'resolved';
type Sort = 'last_seen' | 'frequency';

const STATUS_TONE: Record<string, Tone> = {
  new: 'danger',
  ack: 'warning',
  resolved: 'success',
};

const SEVERITY_TONE: Record<string, Tone> = {
  warn: 'warning',
  error: 'danger',
  fatal: 'danger',
};

function formatMoment(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString('ru-RU');
}

export function ErrorJournalPanel(): ReactNode {
  const [section, setSection] = useState<Section>('issues');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Segmented<Section>
        value={section}
        onChange={setSection}
        options={[
          { label: 'Проблемы', value: 'issues' },
          { label: 'Аномалии и скорость', value: 'anomalies' },
          { label: 'Качество конвейера', value: 'quality' },
        ]}
        aria-label="Раздел журнала"
      />
      {section === 'issues' && <IssuesSection />}
      {section === 'anomalies' && <AnomaliesPanel />}
      {section === 'quality' && <PipelineFeedbackPanel />}
    </Space>
  );
}

/** Инциденты: сбои, у которых есть отпечаток, статус и история работы. */
function IssuesSection(): ReactNode {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<Sort>('last_seen');
  const [domain, setDomain] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [openIssue, setOpenIssue] = useState<string | null>(null);

  const filterKey = `${status}|${sort}|${domain ?? ''}|${source ?? ''}|${search}`;

  const summary = useQuery({
    queryKey: adminKeys.errorSummary(),
    queryFn: () => admin.errorSummary(),
    refetchInterval: 30_000,
  });

  const issues = useQuery({
    queryKey: adminKeys.errors(filterKey),
    queryFn: () =>
      admin.errorIssues({
        ...(status === 'all' ? {} : { status }),
        ...(domain === undefined ? {} : { domain }),
        ...(source === undefined ? {} : { source }),
        ...(search === '' ? {} : { search }),
        sort,
      }),
    refetchInterval: 30_000,
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="За последние сутки">
        {summary.isPending && <LoadingState />}
        {summary.isError && <ErrorState error={summary.error} />}
        {summary.isSuccess && (
          <Space size={48} wrap>
            <Statistic title="Проблем" value={summary.data.issues} />
            <Statistic title="Из них новых" value={summary.data.newIssues} />
            <Statistic title="Событий" value={summary.data.events} />
            <Statistic
              title="Примеров сохранено"
              value={summary.data.samples}
              // Подпись обязательна: без неё число примеров читается как
              // уточнение числа событий, а это разные величины.
              suffix={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  выборочно
                </Typography.Text>
              }
            />
          </Space>
        )}
      </Card>

      <Card size="small" title="Проблемы">
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { label: 'Все', value: 'all' },
              { label: 'Новые', value: 'new' },
              { label: 'В работе', value: 'ack' },
              { label: 'Закрытые', value: 'resolved' },
            ]}
            aria-label="Фильтр по статусу"
          />
          <Segmented<Sort>
            value={sort}
            onChange={setSort}
            options={[
              { label: 'Последние', value: 'last_seen' },
              { label: 'Частые', value: 'frequency' },
            ]}
            aria-label="Порядок"
          />
          <Select
            allowClear
            placeholder="Категория"
            style={{ width: 200 }}
            value={domain}
            onChange={setDomain}
            aria-label="Фильтр по категории"
            options={Object.entries(ERROR_DOMAIN_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <Select
            allowClear
            placeholder="Источник"
            style={{ width: 180 }}
            value={source}
            onChange={setSource}
            aria-label="Фильтр по источнику"
            options={Object.entries(ERROR_SOURCE_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <Input.Search
            allowClear
            placeholder="Текст ошибки"
            style={{ width: 280 }}
            onSearch={setSearch}
            aria-label="Поиск по тексту ошибки"
          />
        </Space>

        {issues.isPending && <LoadingState />}
        {issues.isError && <ErrorState error={issues.error} />}
        {issues.isSuccess && (
          <>
            <Table<ErrorIssue>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={issues.data.items}
              locale={{ emptyText: 'Ошибок за выбранный период нет' }}
              expandable={{
                expandedRowKeys: openIssue === null ? [] : [openIssue],
                onExpand: (open, row) => setOpenIssue(open ? row.id : null),
                expandedRowRender: (row) => <IssueCard issueId={row.id} filterKey={filterKey} />,
              }}
              columns={[
                {
                  title: 'Ошибка',
                  dataIndex: 'title',
                  key: 'title',
                  render: (title: string, row) => (
                    <Space direction="vertical" size={2}>
                      <Typography.Text strong>{title}</Typography.Text>
                      <Space size={4} wrap>
                        <ToneTag tone={STATUS_TONE[row.status] ?? 'neutral'}>
                          {labelOf(ERROR_STATUS_LABELS, row.status)}
                        </ToneTag>
                        <ToneTag tone={SEVERITY_TONE[row.severity] ?? 'neutral'}>
                          {labelOf(ERROR_SEVERITY_LABELS, row.severity)}
                        </ToneTag>
                        <ToneTag tone="info">{labelOf(ERROR_DOMAIN_LABELS, row.domain)}</ToneTag>
                        <ToneTag tone="neutral">{labelOf(ERROR_SOURCE_LABELS, row.source)}</ToneTag>
                        <ToneTag tone="neutral">
                          {labelOf(ERROR_EXECUTION_LABELS, row.execution)}
                        </ToneTag>
                      </Space>
                    </Space>
                  ),
                },
                {
                  title: 'Событий',
                  dataIndex: 'events',
                  key: 'events',
                  width: 110,
                  render: (events: number) => <Typography.Text>{events}</Typography.Text>,
                },
                {
                  title: 'Последний раз',
                  dataIndex: 'lastSeenAt',
                  key: 'lastSeenAt',
                  width: 200,
                  render: (value: string) => formatMoment(value),
                },
                {
                  title: 'Релиз',
                  dataIndex: 'lastRelease',
                  key: 'lastRelease',
                  width: 130,
                  render: (value: string | null) => value ?? '—',
                },
              ]}
            />
            {sort === 'frequency' && (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                Показан топ по числу событий за период. Продолжения у этого порядка нет: частота
                меняется во время просмотра, и страница «дальше» выдавала бы пропуски и повторы.
              </Typography.Paragraph>
            )}
          </>
        )}
      </Card>
    </Space>
  );
}

/** Карточка проблемы: сигнатуры, ряд по релизам, примеры, история и действия. */
function IssueCard({ issueId, filterKey }: { issueId: string; filterKey: string }): ReactNode {
  const { message, modal } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState(false);

  const detail = useQuery({
    queryKey: adminKeys.errorIssue(issueId),
    queryFn: () => admin.errorIssue(issueId),
  });

  const series = useQuery({
    queryKey: adminKeys.errorSeries(issueId),
    queryFn: () => admin.errorSeries(issueId),
  });

  const act = useMutation({
    mutationFn: (input: ErrorIssueActionInput) => admin.errorAction(issueId, input),
    onSuccess: async () => {
      message.success('Журнал обновлён');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminKeys.errorIssue(issueId) }),
        queryClient.invalidateQueries({ queryKey: adminKeys.errors(filterKey) }),
        queryClient.invalidateQueries({ queryKey: adminKeys.errorSummary() }),
      ]);
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <ErrorState error={detail.error} />;

  const { issue, signatures, samples, actions } = detail.data;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" column={3} bordered>
        <Descriptions.Item label="Впервые">{formatMoment(issue.firstSeenAt)}</Descriptions.Item>
        <Descriptions.Item label="Последний раз">
          {formatMoment(issue.lastSeenAt)}
        </Descriptions.Item>
        <Descriptions.Item label="Событий за период">{issue.events}</Descriptions.Item>
        <Descriptions.Item label="Релиз впервые">{issue.firstRelease ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Релиз последний">{issue.lastRelease ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Стадия конвейера">{issue.pipelineStage ?? '—'}</Descriptions.Item>
      </Descriptions>

      {issue.resolution !== null && (
        <Card size="small" title="Чем чинили в прошлый раз">
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            {issue.resolution}
          </Typography.Paragraph>
        </Card>
      )}

      <Card size="small" title="Отпечатки">
        <Table
          rowKey="fingerprint"
          size="small"
          pagination={false}
          dataSource={signatures}
          locale={{ emptyText: 'Отпечатков нет' }}
          columns={[
            { title: 'Класс', dataIndex: 'errorClass', key: 'errorClass', width: 180 },
            { title: 'Сообщение', dataIndex: 'messageTemplate', key: 'messageTemplate' },
            {
              title: 'Кадр стека',
              dataIndex: 'topFrame',
              key: 'topFrame',
              render: (value: string | null) => value ?? '—',
            },
            { title: 'Версия отпечатка', dataIndex: 'algoVersion', key: 'algoVersion', width: 140 },
          ]}
        />
      </Card>

      <Card size="small" title="По часам и релизам">
        {series.isPending && <LoadingState />}
        {series.isError && <ErrorState error={series.error} />}
        {series.isSuccess && (
          <Table
            rowKey={(row) => `${row.bucketAt}-${row.release}`}
            size="small"
            pagination={false}
            dataSource={series.data.points}
            locale={{ emptyText: 'За две недели событий не было' }}
            columns={[
              {
                title: 'Час',
                dataIndex: 'bucketAt',
                key: 'bucketAt',
                render: (value: string) => formatMoment(value),
              },
              { title: 'Релиз', dataIndex: 'release', key: 'release' },
              { title: 'Событий', dataIndex: 'events', key: 'events', width: 120 },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="Примеры (выборочно, не все появления)">
        <Table<ErrorSample>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={samples}
          locale={{ emptyText: 'Примеров нет' }}
          expandable={{
            expandedRowRender: (row) => (
              <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(row.context, null, 2)}
              </Typography.Text>
            ),
            rowExpandable: (row) => row.context !== null && row.context !== undefined,
          }}
          columns={[
            {
              title: 'Когда',
              dataIndex: 'at',
              key: 'at',
              width: 190,
              render: (value: string) => formatMoment(value),
            },
            {
              title: 'Маршрут',
              dataIndex: 'route',
              key: 'route',
              render: (value: string | null) => value ?? '—',
            },
            {
              title: 'Запрос',
              dataIndex: 'requestId',
              key: 'requestId',
              render: (value: string | null, row) => value ?? row.clientEventId ?? '—',
            },
            {
              title: 'Код',
              dataIndex: 'errorCode',
              key: 'errorCode',
              width: 100,
              render: (value: string | null) => value ?? '—',
            },
          ]}
        />
      </Card>

      <Card size="small" title="История работы">
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={actions}
          locale={{ emptyText: 'Действий ещё не было' }}
          columns={[
            {
              title: 'Когда',
              dataIndex: 'at',
              key: 'at',
              width: 190,
              render: (value: string) => formatMoment(value),
            },
            {
              title: 'Действие',
              dataIndex: 'action',
              key: 'action',
              render: (value: string) => labelOf(ERROR_ACTION_LABELS, value),
            },
            {
              title: 'Кто',
              dataIndex: 'actorUserId',
              key: 'actorUserId',
              // `null` — переоткрытие порталом при регрессии, а не человеком.
              render: (value: string | null) => value ?? 'портал',
            },
          ]}
        />
      </Card>

      <Space wrap>
        <Button
          onClick={() => act.mutate({ action: 'acknowledge' })}
          disabled={issue.status === 'ack'}
        >
          Взять в работу
        </Button>
        <Button type="primary" onClick={() => setResolving(true)}>
          Закрыть с разбором
        </Button>
        <Button
          disabled={issue.status !== 'resolved'}
          onClick={() =>
            modal.confirm({
              title: 'Открыть проблему снова?',
              content: 'Прежний разбор сохранится.',
              okText: 'Открыть',
              cancelText: 'Отмена',
              onOk: () => act.mutate({ action: 'reopen', comment: 'открыто вручную' }),
            })
          }
        >
          Открыть снова
        </Button>
      </Space>

      <ResolveModal
        open={resolving}
        onCancel={() => setResolving(false)}
        onSubmit={(input) => {
          act.mutate(input);
          setResolving(false);
        }}
      />
    </Space>
  );
}

/**
 * Закрытие требует разбора и способа устранения.
 *
 * Поля обязательны и на сервере — здесь форма лишь не даёт отправить заведомо
 * отвергаемый запрос. Смысл требования: «убрали с экрана» и «починили» должны
 * различаться в БД, иначе через полгода закрытая запись не отвечает ни на один
 * вопрос, а именно ради этих ответов журнал и хранится.
 */
function ResolveModal({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (input: ErrorIssueActionInput) => void;
}): ReactNode {
  const [form] = Form.useForm<{
    rootCause: string;
    resolution: string;
    resolutionType: 'fixed' | 'wontfix' | 'duplicate' | 'external' | 'not_reproducible';
    fixedInRelease?: string;
  }>();

  return (
    <Modal
      open={open}
      title="Закрыть проблему"
      okText="Закрыть"
      cancelText="Отмена"
      onCancel={onCancel}
      onOk={() => {
        void form.validateFields().then((values) => {
          onSubmit({
            action: 'resolve',
            rootCause: values.rootCause,
            resolution: values.resolution,
            resolutionType: values.resolutionType,
            ...(values.fixedInRelease === undefined || values.fixedInRelease === ''
              ? {}
              : { fixedInRelease: values.fixedInRelease }),
          });
          form.resetFields();
        });
      }}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="rootCause"
          label="Причина"
          rules={[{ required: true, message: 'Назовите причину' }]}
        >
          <Input.TextArea rows={2} placeholder="Что именно приводило к ошибке" />
        </Form.Item>
        <Form.Item
          name="resolution"
          label="Что сделано"
          rules={[{ required: true, message: 'Опишите, что сделано' }]}
        >
          <Input.TextArea rows={2} placeholder="Как устранено" />
        </Form.Item>
        <Form.Item
          name="resolutionType"
          label="Вид решения"
          rules={[{ required: true, message: 'Выберите вид решения' }]}
        >
          <Select
            options={[
              { value: 'fixed', label: 'Исправлено' },
              { value: 'wontfix', label: 'Не будем чинить' },
              { value: 'duplicate', label: 'Дубликат' },
              { value: 'external', label: 'Причина вне портала' },
              { value: 'not_reproducible', label: 'Не воспроизводится' },
            ]}
          />
        </Form.Item>
        <Form.Item name="fixedInRelease" label="Исправлено в релизе">
          <Input placeholder="например 2026.08.2" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
