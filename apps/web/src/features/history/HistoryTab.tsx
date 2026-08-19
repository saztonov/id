/**
 * Вкладка «История»: согласование, стадии обработки, прогоны распознавания (§14).
 *
 * ## Согласование показывает препятствия ДО нажатия
 *
 * `submitBlockers` и `approveBlockers` приходят готовым списком вместе со
 * статусом — экран обязан показывать, что именно мешает, а не выяснять это
 * отказом на нажатие. Фразы приходят русскими и с числами; словарь-переводчик
 * поверх них потерял бы числа (см. `shared/labels.ts`).
 *
 * ## `If-Match` на переходах
 *
 * Каждое действие workflow требует версию ревизии. Версия берётся из ответа
 * `GET /workflow`, а не запоминается: между открытием вкладки и нажатием кнопки
 * ревизию мог тронуть другой проверяющий, и тогда переход обязан быть отвергнут,
 * а не выполнен по устаревшему представлению.
 *
 * ## Стадии — вычисляемая сводка
 *
 * `processing_status` в БД не хранится (§3.8): это сводка над `job_runs`. Поэтому
 * здесь видно и число попыток, и последнюю ошибку по типу задачи — одно поле
 * «статус» скрыло бы и то и другое.
 *
 * ## Опрос — запасной путь, а не основной
 *
 * Пока поток событий ревизии жив, сводка обновляется его событиями, и
 * `refetchInterval` выключен: два механизма одновременно платили бы за одно и
 * то же и скрывали бы смерть одного из них. Как только поток потерян, интервал
 * возвращается — свежесть экрана не должна зависеть от уведомлений (§3.8).
 */
import { useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recognition, revisionEvents, workflow } from '../../api/endpoints.js';
import { revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type {
  Artifact,
  BlockResult,
  RecognitionRun,
  StageSummary,
  WorkflowState,
} from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { usePollingInterval } from '../revision/stream.js';
import {
  PROCESSING_STAGE_LABELS,
  RECOGNITION_STATUS_LABELS,
  REVIEW_ACTION_LABELS,
  WORKFLOW_STATUS_LABELS,
  labelOf,
} from '../../shared/labels.js';

export function HistoryTab({ revisionId }: { revisionId: string }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [returning, setReturning] = useState(false);
  const [openedRun, setOpenedRun] = useState<string | null>(null);
  const pollingInterval = usePollingInterval();

  const state = useQuery({
    queryKey: revisionKeys.workflow(revisionId),
    queryFn: () => workflow.state(revisionId),
  });
  const status = useQuery({
    queryKey: revisionKeys.processingStatus(revisionId),
    queryFn: () => revisionEvents.processingStatus(revisionId),
    refetchInterval: pollingInterval,
  });
  const runs = useQuery({
    queryKey: revisionKeys.recognitionRuns(revisionId),
    queryFn: () => recognition.runs(revisionId),
  });
  const archive = useQuery({
    queryKey: revisionKeys.archive(revisionId),
    queryFn: () => workflow.archive(revisionId),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: revisionKeys.workflow(revisionId) });
    await queryClient.invalidateQueries({ queryKey: revisionKeys.archive(revisionId) });
  };

  const act = useMutation({
    mutationFn: async (input: {
      kind: 'submit' | 'review' | 'approve' | 'return';
      version: number;
      reason?: string;
    }) => {
      switch (input.kind) {
        case 'submit':
          return workflow.submit(revisionId, input.version);
        case 'review':
          return workflow.takeToReview(revisionId, input.version);
        case 'approve':
          return workflow.approve(revisionId, input.version);
        case 'return':
          return workflow.returnToContractor(revisionId, input.version, input.reason ?? '');
      }
    },
    onSuccess: async (result) => {
      message.success(
        `Ревизия переведена в состояние «${labelOf(WORKFLOW_STATUS_LABELS, result.revision.status)}»`,
      );
      setReturning(false);
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (state.isPending) return <LoadingState label="Загрузка состояния согласования…" />;
  if (state.isError) return <ErrorState error={state.error} />;

  const data: WorkflowState = state.data;
  const version = data.revision.version;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="Согласование">
        <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="Статус">
            <Tag data-testid="revision-status">
              {labelOf(WORKFLOW_STATUS_LABELS, data.revision.status)}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Ревизия">№ {data.revision.revisionNo}</Descriptions.Item>
          <Descriptions.Item label="Подана">{data.revision.submittedAt ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Решение">{data.revision.decidedAt ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Состав (хэш)">
            {data.revision.aggregateManifestHash?.slice(0, 12) ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Версия">{version}</Descriptions.Item>
        </Descriptions>

        {data.revision.returnReason !== null && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Причина возврата"
            description={data.revision.returnReason}
          />
        )}

        <Blockers title="Мешает подать" items={data.submitBlockers} />
        <Blockers title="Мешает согласовать" items={data.approveBlockers} />

        <Space wrap style={{ marginTop: 12 }}>
          <Button
            type="primary"
            data-testid="submit-revision"
            disabled={data.submitBlockers.length > 0 || !can('submission.submit')}
            loading={act.isPending}
            onClick={() => act.mutate({ kind: 'submit', version })}
          >
            Подать на проверку
          </Button>
          <Button
            data-testid="take-to-review"
            disabled={data.revision.status !== 'submitted' || !can('revision.approve')}
            loading={act.isPending}
            onClick={() => act.mutate({ kind: 'review', version })}
          >
            Взять на проверку
          </Button>
          <Button
            type="primary"
            data-testid="approve-revision"
            disabled={data.approveBlockers.length > 0 || !can('revision.approve')}
            loading={act.isPending}
            onClick={() => act.mutate({ kind: 'approve', version })}
          >
            Согласовать
          </Button>
          <Button
            danger
            data-testid="return-revision"
            disabled={!can('revision.return')}
            onClick={() => setReturning(true)}
          >
            Вернуть подрядчику
          </Button>
        </Space>

        <ReturnDialog
          open={returning}
          busy={act.isPending}
          onCancel={() => setReturning(false)}
          onSubmit={(reason) => act.mutate({ kind: 'return', version, reason })}
        />
      </Card>

      <Card size="small" title="Действия по ревизии">
        {data.actions.length === 0 ? (
          <Typography.Text type="secondary">Действий пока не было</Typography.Text>
        ) : (
          <Timeline
            items={data.actions.map((action) => ({
              children: (
                <>
                  <div>{labelOf(REVIEW_ACTION_LABELS, action.action)}</div>
                  <Typography.Text type="secondary">{action.at}</Typography.Text>
                  {action.comment !== null && <div>{action.comment}</div>}
                </>
              ),
            }))}
          />
        )}
      </Card>

      <Card size="small" title="Стадии обработки">
        {status.isError && <ErrorState error={status.error} />}
        {status.isSuccess && (
          <>
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              Текущая стадия: <strong>{PROCESSING_STAGE_LABELS[status.data.stage]}</strong>; в
              очереди {status.data.queued}, выполняется {status.data.running}, исчерпали попытки{' '}
              {status.data.dead}
            </Typography.Paragraph>
            <Table<StageSummary>
              rowKey="stage"
              size="small"
              pagination={false}
              dataSource={status.data.stages}
              columns={[
                {
                  title: 'Стадия',
                  dataIndex: 'stage',
                  key: 'stage',
                  render: (stage: StageSummary['stage']) => PROCESSING_STAGE_LABELS[stage],
                },
                { title: 'Попыток', dataIndex: 'attempts', key: 'attempts' },
                { title: 'Успешно', dataIndex: 'succeeded', key: 'succeeded' },
                { title: 'Отказов', dataIndex: 'failed', key: 'failed' },
                {
                  title: 'Длительность',
                  dataIndex: 'totalDurationMs',
                  key: 'totalDurationMs',
                  render: (ms: number) => `${(ms / 1000).toFixed(1)} с`,
                },
              ]}
            />
          </>
        )}
      </Card>

      <Card size="small" title="Прогоны распознавания">
        {runs.isError && <ErrorState error={runs.error} />}
        {runs.isSuccess && (
          <Table<RecognitionRun>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={runs.data}
            locale={{ emptyText: 'Распознавание не запускалось' }}
            expandable={{
              // Подробности прогона грузятся только при раскрытии строки:
              // страницы и результаты блоков — это тысячи строк на комплект, и
              // тянуть их ради колонки «статус» значило бы платить за то, чего
              // никто не смотрит.
              expandedRowKeys: openedRun === null ? [] : [openedRun],
              onExpand: (expanded, row) => setOpenedRun(expanded ? row.id : null),
              expandedRowRender: (row) => <RecognitionRunDetail runId={row.id} />,
            }}
            columns={[
              {
                title: 'Статус',
                dataIndex: 'status',
                key: 'status',
                render: (value: RecognitionRun['status']) => (
                  <Tag color={value === 'done' ? 'green' : value === 'running' ? 'blue' : 'red'}>
                    {RECOGNITION_STATUS_LABELS[value]}
                  </Tag>
                ),
              },
              {
                title: 'Сверка хэшей',
                key: 'hashes',
                render: (_value, row) => {
                  const before = row.remoteLayoutHashBefore;
                  const after = row.remoteLayoutHashAfter;
                  const agree = before === row.localLayoutHash && after === row.localLayoutHash;
                  return (
                    <Tag color={agree ? 'green' : 'orange'}>
                      {agree ? 'локальный и удалённый совпали' : 'сверка не завершена'}
                    </Tag>
                  );
                },
              },
              { title: 'Начат', dataIndex: 'startedAt', key: 'startedAt' },
              {
                title: 'Завершён',
                dataIndex: 'finishedAt',
                key: 'finishedAt',
                render: (value: string | null) => value ?? '—',
              },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="Архив согласованной ревизии">
        {archive.isSuccess && (
          <Space direction="vertical">
            <Typography.Text>
              Состояние:{' '}
              {archive.data.state === 'ready'
                ? 'готов'
                : archive.data.state === 'pending'
                  ? 'собирается'
                  : 'ревизия не согласована'}
            </Typography.Text>
            {archive.data.state === 'ready' && can('archive.download') && (
              <a href={workflow.archiveUrl(revisionId)}>Скачать архив</a>
            )}
          </Space>
        )}
      </Card>
    </Space>
  );
}

/**
 * Подробности одного прогона распознавания (§6.2).
 *
 * Показывается то, ради чего прогон и делается: сколько страниц получили текст,
 * сколько блоков — результат, и какие неизменяемые артефакты записаны. Хэши
 * сверки показаны рядом со списком артефактов намеренно: артефакт без хэша,
 * которым он подтверждён, — это просто файл, а не доказательство.
 *
 * Артефакт скачивается по НАШЕМУ адресу под сессией. Presigned URL сюда не
 * попадает ни при каком режиме хранилища (§4.2).
 */
function RecognitionRunDetail({ runId }: { runId: string }): ReactNode {
  const run = useQuery({
    queryKey: ['recognition-runs', runId],
    queryFn: () => recognition.run(runId),
  });
  const pages = useQuery({
    queryKey: ['recognition-runs', runId, 'pages'],
    queryFn: () => recognition.pages(runId),
  });
  const blocks = useQuery({
    queryKey: ['recognition-runs', runId, 'blocks'],
    queryFn: () => recognition.blocks(runId),
  });
  const artifacts = useQuery({
    queryKey: ['recognition-runs', runId, 'artifacts'],
    queryFn: () => recognition.artifacts(runId),
  });

  if (run.isPending) return <LoadingState label="Загрузка прогона…" />;
  if (run.isError) return <ErrorState error={run.error} />;

  const current = (blocks.data ?? []).filter((block) => block.isCurrent);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label="Задача RD WEB">{run.data.rdJobId ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Хэш разметки (локальный)">
          {run.data.localLayoutHash.slice(0, 12)}…
        </Descriptions.Item>
        <Descriptions.Item label="Хэш до прогона (удалённый)">
          {run.data.remoteLayoutHashBefore?.slice(0, 12) ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label="Хэш после прогона (удалённый)">
          {run.data.remoteLayoutHashAfter?.slice(0, 12) ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label="Страниц с текстом">
          {pages.isSuccess ? pages.data.length : '…'}
        </Descriptions.Item>
        <Descriptions.Item label="Результатов по блокам">
          {blocks.isSuccess ? `${String(current.length)} из ${String(blocks.data.length)}` : '…'}
        </Descriptions.Item>
      </Descriptions>

      {blocks.isSuccess && blocks.data.length > 0 && (
        <Table<BlockResult>
          rowKey="layoutBlockId"
          size="small"
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          dataSource={blocks.data}
          columns={[
            { title: 'Блок', dataIndex: 'layoutBlockId', key: 'layoutBlockId' },
            { title: 'Вид результата', dataIndex: 'resultType', key: 'resultType' },
            {
              title: 'Модель',
              dataIndex: 'modelId',
              key: 'modelId',
              render: (value: string | null) => value ?? '—',
            },
            {
              title: 'Уверенность',
              dataIndex: 'confidence',
              key: 'confidence',
              render: (value: number | null) => (value === null ? '—' : value.toFixed(2)),
            },
            {
              title: 'Действующий',
              dataIndex: 'isCurrent',
              key: 'isCurrent',
              render: (value: boolean) => (value ? 'да' : 'заменён'),
            },
          ]}
        />
      )}

      <Table<Artifact>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={artifacts.data ?? []}
        title={() => 'Неизменяемые артефакты прогона'}
        locale={{ emptyText: 'Артефактов у прогона нет' }}
        columns={[
          { title: 'Вид', dataIndex: 'kind', key: 'kind' },
          {
            title: 'sha256',
            dataIndex: 'artifactSha256',
            key: 'artifactSha256',
            render: (value: string) => `${value.slice(0, 16)}…`,
          },
          {
            title: 'Размер',
            dataIndex: 'byteSize',
            key: 'byteSize',
            render: (bytes: number) => `${(bytes / 1024).toFixed(1)} КБ`,
          },
          {
            title: 'Содержимое',
            key: 'content',
            render: (_value, row) => (
              <a href={recognition.artifactUrl(runId, row.kind)} target="_blank" rel="noreferrer">
                Открыть
              </a>
            ),
          },
        ]}
      />
    </Space>
  );
}

function Blockers({ title, items }: { title: string; items: readonly string[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 8 }}
      message={title}
      description={
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      }
    />
  );
}

function ReturnDialog(props: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}): ReactNode {
  const [form] = Form.useForm<{ reason: string }>();
  return (
    <Modal
      open={props.open}
      title="Вернуть ревизию подрядчику"
      okText="Вернуть"
      cancelText="Отмена"
      confirmLoading={props.busy}
      onCancel={props.onCancel}
      onOk={() => {
        void form.validateFields().then((values) => props.onSubmit(values.reason.trim()));
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Возврат не переоткрывает ревизию: она закрывается, и создаётся новая с ссылкой на
        родительскую.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="reason"
          label="Причина возврата"
          rules={[
            { required: true, message: 'Причина обязательна' },
            { min: 10, message: 'Причина короче десяти символов — это отписка' },
          ]}
        >
          <Input.TextArea rows={4} data-testid="return-reason" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
