/**
 * Вкладка «История»: журнал обработки и согласования (§14).
 *
 * ## Здесь ничего не запускается и не решается (S24)
 *
 * Кнопок действий на вкладке нет ни одной. Карточка согласования переехала на
 * «Проверку» — туда, где принимается
 * решение: под список замечаний. Здесь остался ответ на вопрос «что уже
 * происходило», и смешивать его с «что сделать дальше» — то самое устройство,
 * из-за которого «Подать на проверку» оказывалась на вкладке с журналом.
 *
 * Состояние согласования показано, но ТОЛЬКО на чтение: журнал без текущего
 * статуса заставлял бы переключаться на другую вкладку ради одной строки.
 *
 * ## Причина отказа обязана быть видна здесь
 *
 * До S24 отказ выглядел как «Отказов: 1» в таблице стадий и красный тег в
 * таблице прогонов. Почему именно — не отвечал ни один экран портала, хотя текст
 * приходит в тех же ответах: `jobTypes[].lastErrorMessage` в сводке стадий и
 * `warnings` у прогона распознавания. Оба поля были объявлены в типах и не
 * читались ни одной строкой разметки, и диагностика упиралась в админ-консоль
 * задач, доступную только администратору.
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
import { Alert, Card, Descriptions, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { recognition, folderEvents } from '../../api/endpoints.js';
import { folderKeys } from '../../api/keys.js';
import type {
  Artifact,
  BlockResult,
  ProcessingStatus,
  RecognitionRun,
  StageSummary,
} from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { usePollingInterval } from '../folder/stream.js';
import { isDryRun, isVlmRun, recognitionProviderLabel, runProviderOf } from './runProvider.js';
import { PROCESSING_STAGE_LABELS, RECOGNITION_STATUS_LABELS } from '../../shared/labels.js';

export function HistoryTab({ folderId }: { folderId: string }): ReactNode {
  const [openedRun, setOpenedRun] = useState<string | null>(null);
  const pollingInterval = usePollingInterval();

  const status = useQuery({
    queryKey: folderKeys.processingStatus(folderId),
    queryFn: ({ signal }) => folderEvents.processingStatus(folderId, signal),
    // Функция, а не число: после отказа опрос обязан замолкнуть. Прежний
    // фиксированный интервал продолжал тикать и по 429 — то есть добивал уже
    // исчерпанный лимит запросов ровно тогда, когда сервер просил перестать.
    refetchInterval: (query) => (query.state.error === null ? pollingInterval : false),
  });
  const runs = useQuery({
    queryKey: folderKeys.recognitionRuns(folderId),
    queryFn: () => recognition.runs(folderId),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
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
              expandable={{
                // Раскрытие стадии показывает, ЧТО именно упало и что сказал
                // сервер. Текст ошибки приходит в том же ответе
                // (`jobTypes[].lastErrorMessage`) и раньше не читался ни одной
                // строкой разметки: «Отказов: 1» отправляло искать причину в
                // админ-консоль задач, доступную только администратору.
                expandedRowRender: (row) => (
                  <JobTypeBreakdown stage={row.stage} jobTypes={status.data.jobTypes} />
                ),
                rowExpandable: (row) => status.data.jobTypes.some((job) => job.stage === row.stage),
              }}
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
                render: (value: RecognitionRun['status'], row) => (
                  <Space size={4} wrap>
                    <Tag color={value === 'done' ? 'green' : value === 'running' ? 'blue' : 'red'}>
                      {RECOGNITION_STATUS_LABELS[value]}
                    </Tag>
                    {isDryRun(row) && (
                      // Dry-run завершается как `done`, но публикации результатов
                      // не было — без пометки такой прогон неотличим от боевого.
                      <Tag>dry-run: без публикации</Tag>
                    )}
                  </Space>
                ),
              },
              {
                title: 'Провайдер',
                key: 'provider',
                render: (_value, row) => recognitionProviderLabel(row),
              },
              {
                title: 'Сверка хэшей',
                key: 'hashes',
                render: (_value, row) => {
                  // Сверка локального и удалённого хэша — механизм RD WEB-ветки:
                  // у VLM-прогона удалённой разметки нет по построению, и вечное
                  // «сверка не завершена» утверждало бы незавершённость того,
                  // что не начиналось.
                  if (isVlmRun(row)) return <Tag>не применима (VLM)</Tag>;
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
    </Space>
  );
}

/**
 * Задачи стадии и последняя ошибка каждой.
 *
 * Сводка по стадии отвечает «сколько упало», а этот разбор — «что именно и
 * почему». Разница существенна: стадия `layout` — это и сборка рабочего
 * документа, и постраничная детекция, и анализ покрытия; «отказов: 1» без имени
 * задачи не говорит, чинить хранилище или модель.
 *
 * Класс ошибки показан рядом с текстом, а не вместо него: текст объясняет
 * человеку, класс — тому, кто пойдёт искать это в журнале §11.
 */
function JobTypeBreakdown({
  stage,
  jobTypes,
}: {
  stage: StageSummary['stage'];
  jobTypes: ProcessingStatus['jobTypes'];
}): ReactNode {
  const rows = jobTypes.filter((job) => job.stage === stage);
  if (rows.length === 0) return null;

  return (
    <Table<ProcessingStatus['jobTypes'][number]>
      rowKey="jobType"
      size="small"
      pagination={false}
      dataSource={rows}
      columns={[
        { title: 'Задача', dataIndex: 'jobType', key: 'jobType' },
        { title: 'Попыток', dataIndex: 'attempts', key: 'attempts', width: 90 },
        { title: 'Успешно', dataIndex: 'succeeded', key: 'succeeded', width: 90 },
        { title: 'Отказов', dataIndex: 'failed', key: 'failed', width: 90 },
        /*
         * Пять колонок вместо трёх, потому что три состояния сливались в одно.
         *
         * «Отложено» — попытки, окончившиеся ожиданием: поллеры конвейера
         * спрашивают «уже готово?» десятки раз, и до появления отдельного
         * исхода каждый такой вопрос попадал в «Отказов». Прогон, шедший без
         * единой ошибки, показывал здесь двузначное число.
         *
         * «Мертво» — ЗАДАЧИ, исчерпавшие попытки, а не попытки. Именно эта
         * колонка отвечает на вопрос «конвейер стоит?»: «Отказов 5, Мертво 0»
         * означает, что задача пять раз споткнулась и прошла.
         */
        { title: 'Отложено', dataIndex: 'deferred', key: 'deferred', width: 100 },
        { title: 'Мертво', dataIndex: 'dead', key: 'dead', width: 90 },
        {
          title: 'Последняя ошибка',
          key: 'error',
          render: (_value, row) =>
            row.lastErrorMessage === null && row.lastErrorClass === null ? (
              <Typography.Text type="secondary">отказов не было</Typography.Text>
            ) : (
              <Space direction="vertical" size={0}>
                {/*
                  Причина словами предпочтительнее нормализованного текста (S44):
                  в отпечатке журнала числа вычеркнуты намеренно (ADR-0010), и
                  «не уложилась в <n> мс» не отвечает на вопрос «сколько ждали».
                  `null` там означает «причина не нашего класса» — тогда шаблон.
                */}
                <Typography.Text>
                  {row.lastReasonText ?? row.lastErrorMessage ?? 'текст не записан'}
                </Typography.Text>
                {row.lastErrorClass !== null && (
                  <Typography.Text type="secondary">класс: {row.lastErrorClass}</Typography.Text>
                )}
              </Space>
            ),
        },
      ]}
    />
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
  const provider = runProviderOf(run.data);
  // Задача RD WEB и удалённые хэши — атрибуты legacy-ветки: у VLM-прогона их
  // нет по построению, и строка с вечным «—» читалась бы как «не заполнили».
  const vlm = isVlmRun(run.data);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label="Провайдер">
          {recognitionProviderLabel(run.data)}
        </Descriptions.Item>
        <Descriptions.Item label="Модель">{provider.model ?? '—'}</Descriptions.Item>
        {!vlm && (
          <Descriptions.Item label="Задача RD WEB">{run.data.rdJobId ?? '—'}</Descriptions.Item>
        )}
        <Descriptions.Item label="Хэш разметки (локальный)">
          {run.data.localLayoutHash.slice(0, 12)}…
        </Descriptions.Item>
        {!vlm && (
          <Descriptions.Item label="Хэш до прогона (удалённый)">
            {run.data.remoteLayoutHashBefore?.slice(0, 12) ?? '—'}
          </Descriptions.Item>
        )}
        {!vlm && (
          <Descriptions.Item label="Хэш после прогона (удалённый)">
            {run.data.remoteLayoutHashAfter?.slice(0, 12) ?? '—'}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="Страниц с текстом">
          {pages.isSuccess ? pages.data.length : '…'}
        </Descriptions.Item>
        <Descriptions.Item label="Результатов по блокам">
          {blocks.isSuccess ? `${String(current.length)} из ${String(blocks.data.length)}` : '…'}
        </Descriptions.Item>
      </Descriptions>

      {/*
        Предупреждения прогона: здесь и лежит причина отказа.

        Поле `warnings` приходило с сервера с самого начала и не рендерилось ни
        одним экраном, поэтому «Отказ» за 0.1 с был состоянием без объяснения.
        Тон зависит от исхода прогона: у завершённого это замечания по пути
        («страниц с отказом: 3»), у упавшего — то единственное, ради чего сюда и
        приходят.
      */}
      {run.data.warnings.length > 0 && (
        <Alert
          type={run.data.status === 'done' ? 'warning' : 'error'}
          showIcon
          data-testid="run-warnings"
          message={run.data.status === 'done' ? 'Замечания прогона' : 'Почему прогон не удался'}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {run.data.warnings.map((warning, index) => (
                <li key={`${warning.code}-${String(index)}`}>
                  {warning.message}
                  {warning.workingPageIndex !== null &&
                    ` (страница ${String(warning.workingPageIndex + 1)})`}
                  <Typography.Text type="secondary"> · {warning.code}</Typography.Text>
                </li>
              ))}
            </ul>
          }
        />
      )}

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
