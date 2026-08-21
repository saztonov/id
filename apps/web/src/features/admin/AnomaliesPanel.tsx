/**
 * Аномалии и производительность (§11, ADR-0010, поток B).
 *
 * ## Здесь счётчики, а не события
 *
 * У обеих таблиц нет ни одной записи об отдельном случае, и это не упрощение.
 * Отказ 401/403/429 — работающая защита, а не поломка: строка на каждый такой
 * ответ дала бы перебору паролей и сканеру путей писать в базу с частотой своих
 * попыток. Медленный запрос по отдельности тоже ничего не объясняет — тот же
 * запрос в спокойный час выполняется быстро.
 *
 * Поэтому экран отвечает на «где и сколько», а не «когда именно», и в нём нет
 * ни примеров, ни ссылок на конкретные запросы, кроме одного образца
 * `request_id` — по нему в логе находится строка с полным контекстом.
 *
 * ## Среднее считается, а не хранится
 *
 * Среднее по часу нельзя сложить со средним другого часа. В базе лежит сумма,
 * и любое окно считается из неё без потерь.
 */
import { useState, type ReactNode } from 'react';
import { Alert, Card, Segmented, Space, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { admin } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import type { HttpAnomalyRow, SlowOperationRow } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { ToneTag } from '../../shared/tags.js';

type SlowKind = 'all' | 'http' | 'sql' | 'external';

const SLOW_KIND_LABELS: Record<string, string> = {
  http: 'Запрос',
  sql: 'SQL',
  external: 'Внешний вызов',
};

const STATUS_MEANING: Record<number, string> = {
  401: 'нужна аутентификация',
  403: 'нет прав или отклонён CSRF',
  409: 'конфликт состояния',
  412: 'условие запроса не выполнено',
  429: 'сработал лимит',
};

export function AnomaliesPanel(): ReactNode {
  const [kind, setKind] = useState<SlowKind>('all');

  const anomalies = useQuery({
    queryKey: adminKeys.httpAnomalies(),
    queryFn: () => admin.httpAnomalies(),
    refetchInterval: 60_000,
  });

  const slow = useQuery({
    queryKey: adminKeys.slowOperations(kind),
    queryFn: () => admin.slowOperations(kind === 'all' ? undefined : kind),
    refetchInterval: 60_000,
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Это счётчики за сутки, а не список случаев"
        description={
          'Отказ по правам или лимиту — работающая защита, а не поломка портала, и отдельная ' +
          'запись о каждом дала бы перебору писать в базу с частотой своих попыток. ' +
          'Смысл имеет всплеск: «этот маршрут за сутки ответил 403 четыре тысячи раз».'
        }
      />

      <Card size="small" title="Значимые отказы за сутки">
        {anomalies.isPending && <LoadingState />}
        {anomalies.isError && <ErrorState error={anomalies.error} />}
        {anomalies.isSuccess && (
          <Table<HttpAnomalyRow>
            rowKey={(row) => `${row.route}|${row.statusCode}|${row.problemSlug}`}
            size="small"
            pagination={false}
            dataSource={anomalies.data.items}
            locale={{ emptyText: 'Значимых отказов за сутки не было' }}
            columns={[
              { title: 'Маршрут', dataIndex: 'route', key: 'route' },
              {
                title: 'Статус',
                dataIndex: 'statusCode',
                key: 'statusCode',
                width: 260,
                render: (status: number, row) => (
                  <Space size={6}>
                    <ToneTag tone={status === 429 ? 'warning' : 'neutral'}>{status}</ToneTag>
                    <Typography.Text type="secondary">
                      {STATUS_MEANING[status] ?? row.problemSlug}
                    </Typography.Text>
                  </Space>
                ),
              },
              { title: 'Отказов', dataIndex: 'count', key: 'count', width: 120 },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="Медленные операции за сутки">
        <Segmented<SlowKind>
          value={kind}
          onChange={setKind}
          style={{ marginBottom: 12 }}
          options={[
            { label: 'Все', value: 'all' },
            { label: 'Запросы', value: 'http' },
            { label: 'SQL', value: 'sql' },
            { label: 'Внешние', value: 'external' },
          ]}
          aria-label="Вид операции"
        />
        {slow.isPending && <LoadingState />}
        {slow.isError && <ErrorState error={slow.error} />}
        {slow.isSuccess && (
          <Table<SlowOperationRow>
            rowKey={(row) => `${row.kind}|${row.target}`}
            size="small"
            pagination={false}
            dataSource={slow.data.items}
            locale={{ emptyText: 'Порог не превышался' }}
            columns={[
              {
                title: 'Вид',
                dataIndex: 'kind',
                key: 'kind',
                width: 140,
                render: (value: string) => SLOW_KIND_LABELS[value] ?? value,
              },
              {
                title: 'Что именно',
                dataIndex: 'target',
                key: 'target',
                render: (target: string) => (
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {target}
                  </Typography.Text>
                ),
              },
              { title: 'Раз', dataIndex: 'count', key: 'count', width: 90 },
              {
                title: 'Среднее',
                dataIndex: 'avgMs',
                key: 'avgMs',
                width: 110,
                render: (ms: number) => `${(ms / 1000).toFixed(2)} с`,
              },
              {
                title: 'Худшее',
                dataIndex: 'maxMs',
                key: 'maxMs',
                width: 110,
                render: (ms: number) => `${(ms / 1000).toFixed(2)} с`,
              },
              {
                title: 'Порог',
                dataIndex: 'thresholdMs',
                key: 'thresholdMs',
                width: 100,
                // Порог показан рядом с числами: без него ряд, снятый до и
                // после смены настройки, выглядит как изменение поведения.
                render: (ms: number) => `${ms} мс`,
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
