/**
 * Вкладка «Проверка»: список ошибок и согласование (§9, §14, ADR-0016).
 *
 * ## Одна форма строки, названная заказчиком
 *
 * > «Страница 5 — сертификат соответствия — просрочена дата».
 *
 * Всё, что не помещается в эту фразу, ушло: фильтр состояний, счётчик
 * блокирующих, колонки «Правило», «Состояние», «Источник», «Доказательство»,
 * секции «Документы комплекта» и «Реквизиты», карточка сверки с описью. Экран
 * отвечает на один вопрос — что не так с комплектом, — и всё остальное на нём
 * было ответом на вопросы, которых пользователь не задавал.
 *
 * Подпись собирает СЕРВЕР: номер страницы и название вида ИД живут только в
 * БД, и прежняя вкладка добывала первый двумя лишними запросами, а второго не
 * знала вовсе. Здесь строка печатается как пришла — включая порядок.
 *
 * ## Две секции, а не одна таблица с прочерком
 *
 * Прочерк в колонке «Страница» читался бы как «портал не смог определить
 * страницу», то есть как дефект портала. А замечание «есть материал, но нет
 * сертификата» страницы не имеет по построению: оно о том, чего в комплекте
 * НЕТ, и листа, на котором этого нет, не существует.
 *
 * ## Троичная логика остаётся видимой
 *
 * `undetermined` — не мягкая ошибка, а отдельное состояние «данных для вывода
 * нет». Слить его с `open` значило бы утверждать дефект там, где методика его
 * не установила, и это ровно тот сорт ложного замечания, который §0.5 называет
 * разрушающим доверие быстрее пропущенного. Поэтому — свой тег, а не своя
 * вкладка: заказчик просил убрать вкладки с типами, а не перестать различать.
 *
 * ## Что не делает этот экран
 *
 * Не просит ничего собирать и подтверждать. Границы документов подтверждает
 * конвейер (S27), нарезка идёт сама, и раздела, где инженер нажимал бы
 * «Подтвердить», больше нет. Маршруты API при этом на месте (ADR-0014: «убраны
 * кнопки, а не возможности»).
 *
 * ## Контракт `data-testid`
 *
 * `checks-summary` · `checks-run-state` · `checks-coverage-gap` ·
 * `findings-by-page` · `findings-by-bundle` · `findings-waived` ·
 * `evidence-{ruleCode}` (переход «замечание → страница», пункт приёмки §16).
 */
import { useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Collapse, Space, Table, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bundles, checks, workflow } from '../../api/endpoints.js';
import { revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { Finding } from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { Link } from '../../app/router.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { ToneTag } from '../../shared/tags.js';
import { FINDING_ORIGIN_LABELS, SEVERITY_LABELS, labelOf } from '../../shared/labels.js';
import {
  coverageGap,
  markupHref,
  pageLabel,
  runStateOf,
  splitFindings,
  summaryText,
  type RunState,
} from './grouping.js';
import { OverrideDialog } from './OverrideDialog.js';
import { ApprovalCard } from '../workflow/ApprovalCard.js';

export function ChecksTab({ revisionId }: { revisionId: string }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [overriding, setOverriding] = useState<Finding | null>(null);

  const findings = useQuery({
    queryKey: revisionKeys.findings(revisionId),
    queryFn: () => checks.findings(revisionId),
  });
  // Тот же ключ, что у вкладки «Файлы»: признак «состав изменился после
  // проверки» считает сервер, и второго запроса при переходе между вкладками
  // не будет.
  const bundleList = useQuery({
    queryKey: revisionKeys.bundles(revisionId),
    queryFn: () => bundles.list(revisionId),
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

  const { items, summary } = findings.data;
  const sections = splitFindings(items);
  const bundle = (bundleList.data ?? []).at(-1) ?? null;
  const runState = runStateOf(summary, bundle?.matchesCurrentFiles ?? true);
  const gap = coverageGap(summary);

  const canOverride = can('revision.override');
  const actionColumn = {
    title: '',
    key: 'actions',
    width: 190,
    render: (_value: unknown, row: Finding) =>
      row.state === 'open' && row.isBlocking && canOverride ? (
        <Button size="small" onClick={() => setOverriding(row)}>
          Снять с обоснованием
        </Button>
      ) : null,
  };

  return (
    <>
      <Typography.Paragraph data-testid="checks-summary">
        {summaryText(summary)}
      </Typography.Paragraph>

      <RunStateAlert state={runState} />

      {gap !== null && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="checks-coverage-gap"
          message="Проверка охватила не весь комплект"
          description={gap}
        />
      )}

      <Typography.Title level={3} style={{ fontSize: 16, marginTop: 8 }}>
        Ошибки на страницах
      </Typography.Title>
      <Table<Finding>
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={[...sections.onPages]}
        data-testid="findings-by-page"
        locale={{ emptyText: 'Ошибок, привязанных к страницам, нет' }}
        columns={[
          {
            title: 'Страница',
            key: 'page',
            width: 170,
            render: (_value, row) => <PageCell revisionId={revisionId} finding={row} />,
          },
          {
            title: 'Что за документ',
            key: 'document',
            width: '32%',
            render: (_value, row) => <SubjectCell finding={row} />,
          },
          {
            title: 'Что не так',
            key: 'text',
            render: (_value, row) => <FindingCell finding={row} />,
          },
          actionColumn,
        ]}
      />

      {sections.onBundle.length > 0 && (
        <>
          <Typography.Title level={3} style={{ fontSize: 16, marginTop: 24 }}>
            Ошибки по комплекту
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            У этих замечаний нет страницы: они о том, чего в комплекте не хватает.
          </Typography.Paragraph>
          <Table<Finding>
            rowKey="id"
            size="middle"
            pagination={false}
            dataSource={[...sections.onBundle]}
            data-testid="findings-by-bundle"
            columns={[
              {
                title: 'Чего это касается',
                key: 'target',
                width: '38%',
                render: (_value, row) => <SubjectCell finding={row} />,
              },
              {
                title: 'Что не так',
                key: 'text',
                render: (_value, row) => <FindingCell finding={row} />,
              },
              actionColumn,
            ]}
          />
        </>
      )}

      {sections.waived.length > 0 && (
        <Collapse
          style={{ marginTop: 24 }}
          data-testid="findings-waived"
          items={[
            {
              key: 'waived',
              label: `Снятые замечания (${String(sections.waived.length)})`,
              children: (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {/*
                    Снятое руководителем решение юридически значимо: оно
                    записано в `review_actions` и в аудит, и на экране обязано
                    оставаться видимым — свёрнутым, но не исчезнувшим.
                  */}
                  {sections.waived.map((row) => (
                    <div key={row.id}>
                      <Typography.Text>{row.text}</Typography.Text>{' '}
                      <Typography.Text type="secondary">
                        — {row.target.label}
                        {row.page === null ? '' : `, страница ${String(row.page.number)}`}
                      </Typography.Text>
                    </div>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      )}

      {/*
        Согласование — под результатом проверки. Подрядчик видит, что нашлось,
        и тут же решает, отдавать ли комплект генподрядчику.
      */}
      <div style={{ marginTop: 24 }}>
        <ApprovalCard revisionId={revisionId} />
      </div>

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
 * Состояние проверки.
 *
 * Прежняя вкладка молчала во всех этих случаях одинаково — пустым списком, — и
 * именно это заказчик увидел как «никаких данных». Пустой экран без объяснения
 * неотличим от сломанного.
 */
function RunStateAlert({ state }: { state: RunState }): ReactNode {
  switch (state.kind) {
    case 'never':
      return (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="checks-run-state"
          message="Проверка ещё не выполнялась"
          description="Нажмите «2. Распознать» над вкладками: портал прочитает комплект и найдёт ошибки."
        />
      );
    case 'running':
      return (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="checks-run-state"
          message="Проверка выполняется"
          description="Список появится, когда портал закончит читать комплект."
        />
      );
    case 'running_over_previous':
      return (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="checks-run-state"
          message="Идёт новая проверка"
          description={`Ниже — результат предыдущей от ${formatMoment(state.since)}. Он относится к тому же комплекту, но может измениться.`}
        />
      );
    case 'stale':
      return (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="checks-run-state"
          message="Комплект изменился после проверки"
          description="Список ниже описывает прежний состав файлов. Нажмите «1. Выделить блоки», затем «2. Распознать»."
        />
      );
    case 'done':
      return null;
  }
}

/**
 * Ячейка страницы.
 *
 * Ссылка ведёт на страницу разметки и выделяет блок — §16 называет переход
 * «замечание → доказательство» отдельным пунктом приёмки. Когда рабочий
 * документ не собран, ссылки нет вовсе: неработающая ссылка хуже её
 * отсутствия, потому что по ней нажмут.
 */
function PageCell({ revisionId, finding }: { revisionId: string; finding: Finding }): ReactNode {
  const label = pageLabel(finding);
  const href = markupHref(revisionId, finding);
  if (href === null) return <Typography.Text>{label}</Typography.Text>;
  return (
    <span data-testid={`evidence-${finding.ruleCode}`}>
      <Link to={href}>{label}</Link>
    </span>
  );
}

/** Что за документ либо чего касается замечание. */
function SubjectCell({ finding }: { finding: Finding }): ReactNode {
  const label = finding.document?.label ?? finding.target.label;
  const detail =
    finding.document === null
      ? finding.target.detail
      : (finding.target.detail ??
        (finding.target.kind === 'document' ? null : finding.target.label));

  return (
    <Space direction="vertical" size={0}>
      <Typography.Text>{label}</Typography.Text>
      {detail !== null && detail !== label && (
        <Typography.Text type="secondary">{detail}</Typography.Text>
      )}
    </Space>
  );
}

/**
 * Что не так — и чем это доказано.
 *
 * Код правила и цитата стоят строкой ниже, а не колонками: поддержке код
 * нужен, а ширины таблицы он не стоит. Цитата — компенсация удалённого
 * раздела «Реквизиты»: «просрочена дата» становится проверяемым утверждением
 * «в документе написано „действителен до 12.03.2024“».
 */
function FindingCell({ finding }: { finding: Finding }): ReactNode {
  const quote = finding.evidence[0]?.quote ?? null;

  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <Space size={6} wrap>
        <Typography.Text>{finding.text}</Typography.Text>
        {finding.state === 'undetermined' ? (
          <ToneTag tone="neutral">не проверено</ToneTag>
        ) : (
          <ToneTag tone={finding.severity === 'error' ? 'danger' : 'warning'}>
            {SEVERITY_LABELS[finding.severity]}
          </ToneTag>
        )}
        {finding.isBlocking && <ToneTag tone="danger">блокирует</ToneTag>}
        {/*
          Источник — только на исключениях. §3.7 требует, чтобы проверяющий
          видел находку модели и недоступный реестр; печатать «Правило» у
          девяноста строк из ста значит платить вниманием за то, что и так
          известно по умолчанию.
        */}
        {finding.origin !== 'deterministic' && (
          <ToneTag tone="accent">{labelOf(FINDING_ORIGIN_LABELS, finding.origin)}</ToneTag>
        )}
      </Space>
      {quote !== null && (
        <Typography.Text type="secondary">в документе написано: «{truncate(quote)}»</Typography.Text>
      )}
      {finding.hint !== null && <Typography.Text type="secondary">{finding.hint}</Typography.Text>}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {finding.ruleCode}
      </Typography.Text>
    </Space>
  );
}

/** Цитата обрезается: доказательством служит начало, а не весь абзац. */
const QUOTE_LIMIT = 200;

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= QUOTE_LIMIT ? collapsed : `${collapsed.slice(0, QUOTE_LIMIT)}…`;
}

function formatMoment(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString('ru-RU');
}
