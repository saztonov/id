/**
 * Вкладка «Проверка»: прогоны правил и замечания (§9, §14).
 *
 * ## Троичная логика видна, а не свёрнута в «ошибку»
 *
 * `undetermined` — не мягкая ошибка, а отдельное состояние: «данных для вывода
 * нет». Слить его с `open` значило бы утверждать дефект там, где методика его не
 * установила, и это ровно тот сорт ложной ошибки, который §0.5 называет
 * разрушающим доверие быстрее пропущенной.
 *
 * `origin` показывается всегда. Замечание от модели и замечание от правила имеют
 * разный вес: по §3.7 находка LLM не может блокировать без подтверждения
 * человеком, и проверяющий обязан видеть, что перед ним.
 *
 * ## Переход к доказательству
 *
 * У замечания есть адрес: страница (`sourcePageId`), блок разметки (`blockId`)
 * и цель правила (`targetType` + `targetId`). Ссылка ведёт туда, а не печатает
 * идентификатор текстом: §16 называет навигацию «finding → evidence» отдельным
 * пунктом приёмки именно потому, что проверяющий обязан попасть на страницу
 * одним нажатием, а не искать её вручную по номеру.
 *
 * Страница ревизии переводится в номер страницы рабочего документа по карте
 * `processing_bundle_pages`: разметка живёт в координатах рабочего документа, и
 * ссылка «на страницу» без этого перевода вела бы не туда. Когда карты нет
 * (рабочий документ не собран), ссылка не показывается вовсе — неработающая
 * ссылка хуже её отсутствия.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Button, Segmented, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bundles, checks, workflow } from '../../api/endpoints.js';
import { revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { Finding } from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { Link } from '../../app/router.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import {
  FINDING_ORIGIN_LABELS,
  FINDING_STATE_LABELS,
  FINDING_TARGET_LABELS,
  SEVERITY_LABELS,
  labelOf,
} from '../../shared/labels.js';
import { OverrideDialog } from './OverrideDialog.js';

type StateFilter = 'all' | 'open' | 'undetermined' | 'waived' | 'resolved';

/**
 * Стили меток важности.
 *
 * Пресеты antd (`<Tag color="orange">`) не проходят WCAG AA: оранжевый текст
 * `#d46b08` на подложке `#fff7e6` даёт 3.33:1 при требуемых 4.5:1, и это
 * ловится гейтом §17. Важность замечания — не украшение: по ней проверяющий
 * решает, что смотреть первым, и читать её обязано быть можно. Поэтому цвета
 * заданы явно, потемнее пресета, и собраны в одну таблицу, а не рассыпаны по
 * месту вызова.
 */
const SEVERITY_TAG_STYLE: Record<
  Finding['severity'],
  { color: string; background: string; borderColor: string }
> = {
  error: { color: '#a8071a', background: '#fff1f0', borderColor: '#ffa39e' },
  warning: { color: '#873800', background: '#fff7e6', borderColor: '#ffd591' },
  info: { color: '#0958d9', background: '#e6f4ff', borderColor: '#91caff' },
};

export function ChecksTab({ revisionId }: { revisionId: string }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [overriding, setOverriding] = useState<Finding | null>(null);

  const runs = useQuery({
    queryKey: revisionKeys.checkRuns(revisionId),
    queryFn: () => checks.runs(revisionId),
  });
  const findings = useQuery({
    queryKey: revisionKeys.findings(revisionId),
    queryFn: () => checks.findings(revisionId),
  });

  // Карта «страница ревизии → страница рабочего документа». Нужна ровно для
  // ссылки на доказательство, поэтому читается тем же путём, что и экран
  // разметки: кэш общий, второго запроса при переходе не будет.
  const bundleList = useQuery({
    queryKey: revisionKeys.bundles(revisionId),
    queryFn: () => bundles.list(revisionId),
  });
  const bundleId = (bundleList.data ?? []).at(-1)?.id ?? null;
  const bundlePages = useQuery({
    queryKey: revisionKeys.bundlePages(bundleId ?? 'none'),
    queryFn: () => bundles.pages(bundleId ?? ''),
    enabled: bundleId !== null,
  });

  const run = useMutation({
    mutationFn: () => checks.run(revisionId),
    onSuccess: async (result) => {
      message.success(
        result.created
          ? 'Прогон проверок поставлен в очередь'
          : 'Прогон проверок уже стоит в очереди',
      );
      await queryClient.invalidateQueries({ queryKey: revisionKeys.checkRuns(revisionId) });
    },
    onError: (error) => message.error(describeError(error)),
  });

  const override = useMutation({
    mutationFn: (input: { findingId: string; reason: string }) =>
      workflow.override(input.findingId, input.reason),
    onSuccess: async () => {
      message.success('Замечание снято обоснованным решением руководителя');
      setOverriding(null);
      await queryClient.invalidateQueries({ queryKey: revisionKeys.findings(revisionId) });
      await queryClient.invalidateQueries({ queryKey: revisionKeys.workflow(revisionId) });
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (findings.isPending) return <LoadingState label="Загрузка замечаний…" />;
  if (findings.isError) return <ErrorState error={findings.error} />;

  const pageIndexOf = new Map<string, number>(
    (bundlePages.data ?? []).map((page) => [page.sourcePageId, page.workingPageIndex]),
  );

  const all = findings.data;
  const visible = stateFilter === 'all' ? all : all.filter((item) => item.state === stateFilter);
  const lastRun = (runs.data ?? []).at(-1) ?? null;
  const blocking = all.filter((item) => item.isBlocking && item.state === 'open');

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Button
          type="primary"
          onClick={() => run.mutate()}
          loading={run.isPending}
          disabled={!can('checks.run')}
          data-testid="run-checks"
        >
          Запустить проверку
        </Button>
        <Segmented<StateFilter>
          value={stateFilter}
          onChange={setStateFilter}
          options={[
            { label: `Все (${all.length})`, value: 'all' },
            { label: 'Открытые', value: 'open' },
            { label: 'Не определено', value: 'undetermined' },
            { label: 'Списанные', value: 'waived' },
            { label: 'Устранённые', value: 'resolved' },
          ]}
          aria-label="Фильтр замечаний по состоянию"
        />
        <Typography.Text type="secondary" data-testid="blocking-count">
          блокирующих открытых: {blocking.length}
        </Typography.Text>
        {lastRun !== null && (
          <Typography.Text type="secondary">
            последний прогон: {lastRun.finishedAt ?? 'выполняется'}
          </Typography.Text>
        )}
      </Space>

      <Table<Finding>
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={visible}
        locale={{ emptyText: 'Замечаний нет' }}
        expandable={{
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4}>
              {row.hint !== null && <Typography.Text>Подсказка: {row.hint}</Typography.Text>}
              <Typography.Text type="secondary">
                Объект замечания: {labelOf(FINDING_TARGET_LABELS, row.targetType)}
                {row.targetId !== null && ` ${row.targetId}`}
              </Typography.Text>
            </Space>
          ),
          rowExpandable: (row) => row.hint !== null || row.targetId !== null,
        }}
        columns={[
          { title: 'Правило', dataIndex: 'ruleCode', key: 'ruleCode' },
          {
            title: 'Важность',
            dataIndex: 'severity',
            key: 'severity',
            render: (severity: Finding['severity'], row) => (
              <Space size={4}>
                <Tag style={SEVERITY_TAG_STYLE[severity]}>{SEVERITY_LABELS[severity]}</Tag>
                {row.isBlocking && (
                  <Tag style={{ color: '#871400', background: '#fff2e8', borderColor: '#ffbb96' }}>
                    блокирует
                  </Tag>
                )}
              </Space>
            ),
          },
          {
            title: 'Состояние',
            dataIndex: 'state',
            key: 'state',
            render: (state: string) => <Tag>{labelOf(FINDING_STATE_LABELS, state)}</Tag>,
          },
          {
            title: 'Источник',
            dataIndex: 'origin',
            key: 'origin',
            render: (origin: string) => labelOf(FINDING_ORIGIN_LABELS, origin),
          },
          { title: 'Сообщение', dataIndex: 'message', key: 'message' },
          {
            title: 'Доказательство',
            key: 'evidence',
            render: (_value, row) => (
              <EvidenceLinks revisionId={revisionId} finding={row} pageIndexOf={pageIndexOf} />
            ),
          },
          {
            title: 'Действия',
            key: 'actions',
            render: (_value, row) =>
              row.state === 'open' && row.isBlocking && can('revision.override') ? (
                <Button size="small" onClick={() => setOverriding(row)}>
                  Снять с обоснованием
                </Button>
              ) : null,
          },
        ]}
      />

      <OverrideDialog
        finding={overriding}
        busy={override.isPending}
        onCancel={() => setOverriding(null)}
        onSubmit={(reason) => {
          if (overriding === null) return;
          override.mutate({ findingId: overriding.id, reason });
        }}
      />
    </>
  );
}

/**
 * Ссылки на доказательство замечания.
 *
 * Три разных адреса, а не один «перейти»: страница разметки отвечает на вопрос
 * «где это на скане», документ — «в каком документе», и путать их нельзя.
 * Отсутствие адреса тоже названо: замечание уровня ревизии («не хватает акта»)
 * доказательства на странице не имеет по построению, и пустая ячейка читалась
 * бы как «ссылку забыли сделать».
 */
function EvidenceLinks({
  revisionId,
  finding,
  pageIndexOf,
}: {
  revisionId: string;
  finding: Finding;
  pageIndexOf: ReadonlyMap<string, number>;
}): ReactNode {
  const workingPageIndex =
    finding.sourcePageId === null ? undefined : pageIndexOf.get(finding.sourcePageId);

  const links: ReactNode[] = [];

  if (workingPageIndex !== undefined) {
    const query = new URLSearchParams({ tab: 'markup', page: String(workingPageIndex) });
    if (finding.blockId !== null) query.set('block', finding.blockId);
    links.push(
      <Link key="page" to={`/ids/revisions/${revisionId}?${query.toString()}`}>
        {finding.blockId === null
          ? `К странице ${String(workingPageIndex + 1)}`
          : `К блоку на странице ${String(workingPageIndex + 1)}`}
      </Link>,
    );
  }

  if (finding.targetType === 'document' && finding.targetId !== null) {
    links.push(
      <Link key="document" to={`/ids/revisions/${revisionId}?tab=documents`}>
        К документу
      </Link>,
    );
  }

  if (finding.targetType === 'field_value' && finding.targetId !== null) {
    links.push(
      <Link key="field" to={`/ids/revisions/${revisionId}?tab=fields`}>
        К реквизиту
      </Link>,
    );
  }

  if (links.length === 0) {
    return (
      <Typography.Text type="secondary">
        {finding.sourcePageId === null
          ? 'замечание уровня ревизии: страницы у него нет'
          : 'рабочий документ не собран — страницу не на что отобразить'}
      </Typography.Text>
    );
  }

  return (
    <Space size={8} wrap data-testid={`evidence-${finding.ruleCode}`}>
      {links}
    </Space>
  );
}
