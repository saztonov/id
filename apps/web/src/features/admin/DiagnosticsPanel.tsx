/**
 * Диагностика и консоль задач (§11, §14) — первый потребитель `diagnostics.read`.
 *
 * Показывается то, что §11 перечисляет и что API действительно отдаёт: глубина
 * очереди, список задач с фильтрами, попытки задачи с длительностями, классом и
 * сообщением ошибки. Глубина берётся тем же снимком, что уходит в `/metrics`, —
 * иначе спор «график врёт или экран» неразрешим.
 *
 * Топ ошибок отсюда УШЁЛ, а не появился: он живёт на вкладке «Журнал ошибок»,
 * где у него есть история, статусы и разбор. Здесь остаётся дежурный вопрос
 * «что происходит прямо сейчас».
 *
 * Медленные запросы и всплески отказов ушли туда же и по той же причине: это
 * накопленная статистика, а не состояние очереди прямо сейчас.
 */
import { useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Card, Segmented, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { admin } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { JobRunView, JobView } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { JOB_STATUS_LABELS, labelOf } from '../../shared/labels.js';

type Filter = 'all' | 'queued' | 'running' | 'failed' | 'dead';

export function DiagnosticsPanel(): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [openJob, setOpenJob] = useState<string | null>(null);

  const queues = useQuery({
    queryKey: adminKeys.queues(),
    queryFn: () => admin.queues(),
    refetchInterval: 10_000,
  });
  const jobs = useQuery({
    queryKey: adminKeys.jobs(filter),
    queryFn: () =>
      admin.jobs(
        filter === 'all' ? {} : filter === 'dead' ? { deadOnly: true } : { status: filter },
      ),
    refetchInterval: 10_000,
  });

  const retry = useMutation({
    mutationFn: (jobId: string) => admin.retryJob(jobId),
    onSuccess: async () => {
      message.success('Задача поставлена на повтор');
      await queryClient.invalidateQueries({ queryKey: adminKeys.jobs(filter) });
    },
    onError: (error) => message.error(describeError(error)),
  });

  const cancel = useMutation({
    mutationFn: (jobId: string) => admin.cancelJob(jobId),
    onSuccess: async () => {
      message.success('Задача отменена');
      await queryClient.invalidateQueries({ queryKey: adminKeys.jobs(filter) });
    },
    onError: (error) => message.error(describeError(error)),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="Глубина очереди">
        {queues.isPending && <LoadingState />}
        {queues.isError && <ErrorState error={queues.error} />}
        {queues.isSuccess && (
          <Space wrap>
            {queues.data.depths.length === 0 && (
              <Typography.Text type="secondary">Очередь пуста</Typography.Text>
            )}
            {queues.data.depths.map((entry) => (
              <Tag key={`${entry.jobType}-${entry.status}`}>
                {entry.jobType} / {labelOf(JOB_STATUS_LABELS, entry.status)}: {entry.count}
              </Tag>
            ))}
            {queues.data.dead.map((entry) => (
              <Tag color="red" key={`dead-${entry.jobType}`}>
                {entry.jobType}: исчерпали попытки {entry.count}
              </Tag>
            ))}
          </Space>
        )}
      </Card>

      <Card size="small" title="Задачи конвейера">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          style={{ marginBottom: 12 }}
          options={[
            { label: 'Все', value: 'all' },
            { label: 'В очереди', value: 'queued' },
            { label: 'Выполняются', value: 'running' },
            { label: 'Отказы', value: 'failed' },
            { label: 'Исчерпали попытки', value: 'dead' },
          ]}
          aria-label="Фильтр задач"
        />
        {jobs.isPending && <LoadingState />}
        {jobs.isError && <ErrorState error={jobs.error} />}
        {jobs.isSuccess && (
          <Table<JobView>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={jobs.data.items}
            locale={{ emptyText: 'Задач нет' }}
            expandable={{
              expandedRowKeys: openJob === null ? [] : [openJob],
              onExpand: (open, row) => setOpenJob(open ? row.id : null),
              expandedRowRender: (row) => <JobRuns jobId={row.id} />,
            }}
            columns={[
              { title: 'Тип', dataIndex: 'type', key: 'type' },
              {
                title: 'Статус',
                dataIndex: 'status',
                key: 'status',
                render: (status: string, row) => (
                  <Space size={4}>
                    <Tag>{labelOf(JOB_STATUS_LABELS, status)}</Tag>
                    {row.isDead && <Tag color="red">исчерпаны попытки</Tag>}
                  </Space>
                ),
              },
              {
                title: 'Попытки',
                key: 'attempts',
                render: (_value, row) => `${row.attempts} / ${row.maxAttempts}`,
              },
              { title: 'Очередь', dataIndex: 'queue', key: 'queue', render: (v) => v ?? '—' },
              {
                title: 'Последняя ошибка',
                dataIndex: 'lastError',
                key: 'lastError',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: 'Действия',
                key: 'actions',
                render: (_value, row) => (
                  <Space size={6}>
                    <Button size="small" onClick={() => retry.mutate(row.id)}>
                      Повторить
                    </Button>
                    <Button size="small" danger onClick={() => cancel.mutate(row.id)}>
                      Отменить
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Alert
        type="info"
        showIcon
        message="Ошибки, аномалии и скорость — на вкладке «Журнал и качество»"
        description={
          'Здесь дежурная сводка: что происходит прямо сейчас. Ошибки с историей и разбором, ' +
          'всплески отказов по правам и лимитам, медленные запросы и SQL живут на вкладке ' +
          '«Журнал и качество» — у них другой горизонт, чем у очереди задач.'
        }
      />
    </Space>
  );
}

function JobRuns({ jobId }: { jobId: string }): ReactNode {
  const detail = useQuery({
    queryKey: adminKeys.job(jobId),
    queryFn: () => admin.job(jobId),
  });

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <ErrorState error={detail.error} />;

  return (
    <Table<JobRunView>
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={detail.data.runs}
      locale={{ emptyText: 'Попыток ещё не было' }}
      columns={[
        { title: 'Попытка', dataIndex: 'attempt', key: 'attempt', width: 90 },
        { title: 'Начата', dataIndex: 'startedAt', key: 'startedAt' },
        {
          title: 'Длительность',
          dataIndex: 'durationMs',
          key: 'durationMs',
          render: (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)} с`),
        },
        { title: 'Исход', dataIndex: 'outcome', key: 'outcome', render: (v) => v ?? '—' },
        {
          title: 'Класс ошибки',
          dataIndex: 'errorClass',
          key: 'errorClass',
          render: (v) => v ?? '—',
        },
        {
          title: 'Сообщение',
          dataIndex: 'errorMessage',
          key: 'errorMessage',
          render: (v) => v ?? '—',
        },
        {
          title: 'Запрос',
          dataIndex: 'requestId',
          key: 'requestId',
          render: (v) => v ?? '—',
        },
      ]}
    />
  );
}
