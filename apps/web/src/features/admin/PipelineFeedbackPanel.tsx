/**
 * Качество конвейера (§11, ADR-0010).
 *
 * ## Главное число здесь — доля, и она бывает неизвестной
 *
 * «Сто невалидных ответов» не значит ничего: сто из ста тысяч — нормальная
 * работа, сто из ста двадцати — сломанный промт. Поэтому рядом с числом
 * дефектов всегда стоит число вызовов и доля.
 *
 * Когда знаменатель неизвестен — у стадий, которые модель не вызывают
 * (детекция, ручные правки), — доля показывается прочерком, а НЕ нулём. Ноль
 * читался бы как «дефектов нет», то есть как утверждение, прямо
 * противоположное тому, что на самом деле произошло.
 *
 * ## Почему это отдельный раздел, а не строки журнала ошибок
 *
 * Здесь нет ни одного исключения. Модель вернула ответ, конвейер отработал, а
 * результат оказался непригоден — и по journal-логике такого события просто не
 * существует. Разные вопросы, разные данные, разный горизонт хранения.
 */
import { useState, type ReactNode } from 'react';
import { Alert, Button, Card, Select, Space, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { admin } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import type { PipelineFeedbackEvent, PipelineFeedbackRow } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { ToneTag } from '../../shared/tags.js';
import { FEEDBACK_REASON_LABELS, FEEDBACK_STAGE_LABELS, labelOf } from '../../shared/labels.js';

const REASONS = Object.keys(FEEDBACK_REASON_LABELS);

function formatMoment(value: string): string {
  return new Date(value).toLocaleString('ru-RU');
}

/** Доля в процентах либо прочерк. Ноль вместо прочерка здесь запрещён. */
function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)} %`;
}

export function PipelineFeedbackPanel(): ReactNode {
  const [reasonCode, setReasonCode] = useState<string | undefined>(undefined);
  const [promptCode, setPromptCode] = useState<string | undefined>(undefined);
  const filterKey = `${reasonCode ?? ''}|${promptCode ?? ''}`;

  const summary = useQuery({
    queryKey: adminKeys.feedbackSummary(filterKey),
    queryFn: () =>
      admin.feedbackSummary({
        ...(reasonCode === undefined ? {} : { reasonCode }),
        ...(promptCode === undefined ? {} : { promptCode }),
      }),
  });

  const events = useQuery({
    queryKey: adminKeys.feedbackEvents(filterKey),
    queryFn: () =>
      admin.feedbackEvents({
        ...(reasonCode === undefined ? {} : { reasonCode }),
        ...(promptCode === undefined ? {} : { promptCode }),
      }),
  });

  const exportUrl = admin.feedbackExportUrl({
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(promptCode === undefined ? {} : { promptCode }),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Здесь дефекты качества, а не сбои"
        description={
          'Модель ответила, конвейер отработал, а результат оказался непригоден: невалидный JSON, ' +
          'отказ модели, ненайденные обводки, правка инженера. Исключений такие случаи не бросают ' +
          'и в журнал ошибок не попадают — по ним дорабатывают промты и модель обводок.'
        }
      />

      <Card size="small" title="Срез за 30 дней">
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            allowClear
            placeholder="Причина"
            style={{ width: 280 }}
            value={reasonCode}
            onChange={setReasonCode}
            aria-label="Фильтр по причине"
            options={REASONS.map((value) => ({
              value,
              label: labelOf(FEEDBACK_REASON_LABELS, value),
            }))}
          />
          <Select
            allowClear
            showSearch
            placeholder="Промт"
            style={{ width: 240 }}
            value={promptCode}
            onChange={setPromptCode}
            aria-label="Фильтр по промту"
            options={[
              ...new Set(
                (summary.data?.rows ?? [])
                  .map((row) => row.promptCode)
                  .filter((code): code is string => code !== null),
              ),
            ].map((code) => ({ value: code, label: code }))}
          />
          <Button href={exportUrl} download>
            Выгрузить выборку (NDJSON)
          </Button>
        </Space>

        {summary.isPending && <LoadingState />}
        {summary.isError && <ErrorState error={summary.error} />}
        {summary.isSuccess && (
          <Table<PipelineFeedbackRow>
            rowKey={(row) =>
              `${row.reasonCode}|${row.promptCode ?? ''}|${String(row.promptVersion)}|${row.model ?? ''}|${row.docTypeCode ?? ''}`
            }
            size="small"
            pagination={false}
            dataSource={summary.data.rows}
            locale={{ emptyText: 'Дефектов за период нет' }}
            columns={[
              {
                title: 'Причина',
                dataIndex: 'reasonCode',
                key: 'reasonCode',
                render: (code: string) => (
                  <Space direction="vertical" size={2}>
                    <Typography.Text>{labelOf(FEEDBACK_REASON_LABELS, code)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {code}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: 'Стадия',
                dataIndex: 'pipelineStage',
                key: 'pipelineStage',
                width: 140,
                render: (stage: string | null) =>
                  stage === null ? '—' : labelOf(FEEDBACK_STAGE_LABELS, stage),
              },
              {
                title: 'Промт',
                key: 'prompt',
                width: 220,
                render: (_value, row) =>
                  row.promptCode === null
                    ? '—'
                    : `${row.promptCode}@${String(row.promptVersion ?? '?')}`,
              },
              {
                title: 'Модель',
                dataIndex: 'model',
                key: 'model',
                render: (model: string | null) => model ?? '—',
              },
              { title: 'Дефектов', dataIndex: 'defects', key: 'defects', width: 110 },
              {
                title: 'Вызовов',
                dataIndex: 'calls',
                key: 'calls',
                width: 110,
                // Прочерк, а не ноль: «вызовов модели не было» и «вызовов было
                // ноль» — здесь одно и то же утверждение, но ноль в столбце
                // рядом с долей читается как знаменатель.
                render: (calls: number | null) => calls ?? '—',
              },
              {
                title: 'Доля',
                dataIndex: 'rate',
                key: 'rate',
                width: 120,
                render: (rate: number | null) =>
                  rate === null ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <ToneTag tone={rate > 0.1 ? 'danger' : rate > 0.02 ? 'warning' : 'neutral'}>
                      {formatRate(rate)}
                    </ToneTag>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="Последние дефекты">
        {events.isPending && <LoadingState />}
        {events.isError && <ErrorState error={events.error} />}
        {events.isSuccess && (
          <Table<PipelineFeedbackEvent>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={events.data.items}
            locale={{ emptyText: 'Дефектов нет' }}
            expandable={{
              expandedRowRender: (row) => (
                <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify({ observed: row.observed, expected: row.expected }, null, 2)}
                </Typography.Text>
              ),
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
                title: 'Причина',
                dataIndex: 'reasonCode',
                key: 'reasonCode',
                render: (code: string) => labelOf(FEEDBACK_REASON_LABELS, code),
              },
              {
                title: 'Промт',
                key: 'prompt',
                render: (_value, row) =>
                  row.promptCode === null
                    ? '—'
                    : `${row.promptCode}@${String(row.promptVersion ?? '?')}`,
              },
              {
                title: 'Блок',
                dataIndex: 'layoutBlockId',
                key: 'layoutBlockId',
                // Идентификатор блока — то, по чему инженер откроет кроп в
                // портале. Самого кропа здесь нет и не будет: §11.
                render: (value: string | null) => value ?? '—',
              },
              {
                title: 'Страница',
                dataIndex: 'workingPageIndex',
                key: 'workingPageIndex',
                width: 110,
                render: (value: number | null) => (value === null ? '—' : value + 1),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
