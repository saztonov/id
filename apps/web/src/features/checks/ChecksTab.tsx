/**
 * Вкладка «Проверка»: состав комплекта, его результат и согласование (§9, §14).
 *
 * ## Что здесь показано и почему именно это
 *
 * ADR-0016 свёл экран к списку ошибок по формуле заказчика «страница — вид
 * документа — что не так». Формула верна и осталась, но отвечала только на
 * половину вопроса: при чистом комплекте экран показывал пустую таблицу, и
 * заказчик, пройдя стенд на 83 страницах, сказал прямо — «результат
 * распознавания невозможно понять». Понять было нельзя даже того, прочитал ли
 * портал хоть что-нибудь.
 *
 * Поэтому список ошибок заменён таблицей СОСТАВА, в которой ошибка — одно из
 * состояний строки, а не единственная причина строке появиться. Порядок
 * разделов назвал заказчик: акт → строки внутреннего реестра → паспорта,
 * сертификаты и прочее.
 *
 * ## Это НЕ возврат раздела «Документы комплекта»
 *
 * ADR-0016 убрал не показ состава, а требование СОБИРАТЬ его руками: границы
 * подтверждает конвейер, нарезка идёт сама. В таблице нет ни одной кнопки,
 * меняющей состав, и просить что-либо подтверждать экран не начинает.
 *
 * ## Одна плашка вместо трёх
 *
 * Состояние прогона и заявление о полноте съехались в `RunStateAlert`. Вместе с
 * плашками конвейера над вкладками пользователь видел до четырёх сообщений о
 * разных временах жизни одного комплекта и не мог сложить из них ответ на
 * единственный свой вопрос — всё ли в порядке.
 *
 * ## Троичная логика остаётся видимой
 *
 * `undetermined` — не мягкая ошибка, а отдельное состояние «данных для вывода
 * нет»; `not_applicable` и `not_run` в чек-листе — «правило не работало».
 * Слить их с успехом значило бы выдать непроверенное за проверенное, а это
 * ровно тот сорт лжи, из-за которого экран и переделывался.
 *
 * ## Контракт `data-testid`
 *
 * `checks-summary` · `checks-run-state` · `checks-report` ·
 * `checks-report-section-{kind}` · `checks-report-row-{id}` ·
 * `findings-waived`.
 */
import { type ReactNode } from 'react';
import { Alert, Collapse, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { bundles, checks, folderEvents } from '../../api/endpoints.js';
import { folderKeys } from '../../api/keys.js';
import { activeStageOf, checksAhead } from '../folder/busy.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { coverageGap, runStateOf, splitFindings, summaryText, type RunState } from './grouping.js';
import { ReportTable } from './ReportTable.js';

export function ChecksTab({ folderId }: { folderId: string }): ReactNode {
  const findings = useQuery({
    queryKey: folderKeys.findings(folderId),
    queryFn: () => checks.findings(folderId),
  });
  // Отдельный запрос от замечаний: состав комплекта не обязан ехать заново
  // после снятия одного замечания, а список замечаний — после пересборки
  // нарезки. Инвалидируются оба одним событием потока (`case 'checks'`).
  const reportQuery = useQuery({
    queryKey: folderKeys.checkReport(folderId),
    queryFn: () => checks.report(folderId),
  });
  // Тот же ключ, что у вкладки «Файлы»: признак «состав изменился после
  // проверки» считает сервер, и второго запроса при переходе между вкладками
  // не будет.
  const bundleList = useQuery({
    queryKey: folderKeys.bundles(folderId),
    queryFn: () => bundles.list(folderId),
  });
  // Тот же ключ, что у полосы конвейера над вкладками: сводка уже в кэше, и
  // второго запроса не будет. Без неё вкладка объявляет «проверка не
  // выполнялась» ровно тогда, когда конвейер к ней идёт.
  const processing = useQuery({
    queryKey: folderKeys.processingStatus(folderId),
    queryFn: ({ signal }) => folderEvents.processingStatus(folderId, signal),
  });

  if (findings.isPending || reportQuery.isPending)
    return <LoadingState label="Загрузка проверки…" />;
  if (findings.isError) return <ErrorState error={findings.error} />;
  if (reportQuery.isError) return <ErrorState error={reportQuery.error} />;

  const { items, summary } = findings.data;
  const sections = splitFindings(items);
  const bundle = (bundleList.data ?? []).at(-1) ?? null;
  const runState = runStateOf(
    summary,
    bundle?.matchesCurrentFiles ?? true,
    checksAhead(processing.data) ? activeStageOf(processing.data) : null,
  );
  const gap = coverageGap(summary);

  return (
    <>
      <Typography.Paragraph data-testid="checks-summary">
        {summaryText(summary, runState)}
      </Typography.Paragraph>

      <RunStateAlert state={runState} gap={gap} />

      <ReportTable folderId={folderId} report={reportQuery.data} />

      {sections.waived.length > 0 && (
        <div data-testid="findings-waived" style={{ marginTop: 24 }}>
          <Collapse
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
        </div>
      )}
    </>
  );
}

/**
 * Состояние проверки — ОДНОЙ плашкой.
 *
 * Прежняя вкладка молчала во всех этих случаях одинаково — пустым списком, — и
 * именно это заказчик увидел как «никаких данных». Пустой экран без объяснения
 * неотличим от сломанного.
 *
 * ## Почему плашка одна (S29)
 *
 * Их было две: состояние прогона и отдельная «Проверка охватила не весь
 * комплект». Вместе с плашками конвейера над вкладками пользователь видел на
 * одном экране до четырёх сообщений о разных временах жизни одного комплекта и
 * не мог сложить из них ответ на единственный свой вопрос — всё ли в порядке.
 * Заявление о полноте не перестало быть заявлением о полноте (ADR-0016,
 * решение 3): оно осталось тем же текстом и просто переехало внутрь плашки
 * исхода, где читается вместе с ним, а не вместо него.
 */
function RunStateAlert({ state, gap }: { state: RunState; gap: string | null }): ReactNode {
  const view = alertOf(state);

  return (
    <Alert
      type={view.type}
      showIcon
      style={{ marginBottom: 12 }}
      data-testid="checks-run-state"
      message={view.message}
      description={
        <Space direction="vertical" size={2}>
          <Typography.Text>{view.description}</Typography.Text>
          {/*
            Заявление о полноте прикладывается к ЛЮБОМУ исходу, а не только к
            «есть замечания». Пустой список ошибок по неразобранным страницам
            ничего не доказывает — и одинаково ничего не доказывает и там, где
            проверка ещё не запускалась. Знать это пользователь обязан в обоих
            случаях (ADR-0016, решение 3).
          */}
          {gap !== null && <Typography.Text type="secondary">{gap}</Typography.Text>}
        </Space>
      }
    />
  );
}

interface AlertView {
  readonly type: 'success' | 'info' | 'warning' | 'error';
  readonly message: string;
  readonly description: string;
}

/**
 * Чем занят конвейер, словами вкладки «Проверка».
 *
 * Своя таблица, а не общая с полосой конвейера: там фраза встраивается в
 * «идёт: …» и описывает стадию, здесь — объясняет человеку, почему проверки
 * ещё нет и почему ждать правильнее, чем нажимать кнопку.
 */
const STAGE_AHEAD_LABEL: Readonly<Record<string, string>> = {
  recognition: 'распознавание страниц',
  analysis: 'разбор документов и реквизитов',
  checks: 'прогон правил',
};

function alertOf(state: RunState): AlertView {
  switch (state.kind) {
    case 'done_clean':
      return {
        type: 'success',
        message: 'Проверка пройдена: замечаний нет',
        description:
          'Портал прочитал комплект целиком, отнёс каждую страницу к документу и не нашёл ' +
          'ни ошибок, ни непроверенных мест. Состав и результат по каждому документу — ' +
          'в таблице ниже.',
      };
    case 'done_with_issues':
      return {
        type: state.tone,
        message: 'Проверка выполнена, комплект чист не полностью',
        description: `Требует внимания: ${state.reservations.join(', ')}.`,
      };
    case 'never':
      return {
        type: 'info',
        message: 'Проверка ещё не выполнялась',
        description:
          'Нажмите «2. Распознать» над вкладками: портал прочитает комплект и найдёт ошибки. ' +
          'Ниже — состав, который он уже разобрал.',
      };
    case 'ahead':
      return {
        type: 'info',
        message: 'Портал ещё читает комплект',
        description:
          `Идёт ${STAGE_AHEAD_LABEL[state.stage ?? ''] ?? 'обработка'}; проверка запустится сама, ` +
          'нажимать ничего не нужно. Ниже — состав, который портал уже разобрал.',
      };
    case 'running':
      return {
        type: 'info',
        message: 'Проверка выполняется',
        description: 'Результат появится, когда портал закончит читать комплект.',
      };
    case 'running_over_previous':
      return {
        type: 'info',
        message: 'Идёт новая проверка',
        description:
          `Ниже — результат предыдущей от ${formatMoment(state.since)}. ` +
          'Он относится к тому же комплекту, но может измениться.',
      };
    case 'stale':
      return {
        type: 'warning',
        message: 'Комплект изменился после проверки',
        description:
          'Таблица ниже описывает прежний состав файлов. ' +
          'Нажмите «1. Выделить блоки», затем «2. Распознать».',
      };
  }
}

function formatMoment(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString('ru-RU');
}
