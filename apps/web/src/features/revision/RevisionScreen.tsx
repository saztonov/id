/**
 * Рабочее место ревизии комплекта: шесть вкладок §14.
 *
 * Активная вкладка живёт в адресе (`?tab=markup`), а не только в состоянии: без
 * этого ссылку на разметку конкретной ревизии нельзя ни отправить, ни открыть из
 * замечания, а обновление страницы возвращало бы пользователя на первую вкладку.
 *
 * Редактируемость определяется статусом ревизии, а не только правом: содержимое
 * поданной ревизии заперто триггерами БД (§3.9), и кнопка, которая гарантированно
 * получит отказ, вводит в заблуждение. Различение классов `source` и `derived`
 * (урок S2) здесь проявляется так: файлы правятся только в черновике, а разметка
 * и документы — пока ревизия не в терминальном состоянии.
 *
 * ## Поток событий живёт на уровне ревизии, а не вкладки
 *
 * Вкладки размонтируются при переключении (`destroyOnHidden`), и поток,
 * открытый внутри вкладки, обрывался бы при каждом переходе — с повторным
 * запросом пропущенного на ровном месте. Поэтому подписка держится здесь и
 * переживает переключение вкладок; состояние потока вкладки читают из контекста
 * (`stream.tsx`).
 */
import { useEffect, type ReactNode } from 'react';
import { Alert, Tabs, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { workflow } from '../../api/endpoints.js';
import { navigationKeys, revisionKeys } from '../../api/keys.js';
import { getWork } from '../../api/navigation.js';
import { ErrorState, LoadingState, ScreenHeading } from '../../shared/ui.js';
import { WORK_KIND_LABELS, WORKFLOW_STATUS_LABELS, labelOf } from '../../shared/labels.js';
import { Link, useNavigate, useQueryParam } from '../../app/router.js';
import { periodLabel } from '../ids/ObjectScreen.js';
import { FilesTab } from '../files/FilesTab.js';
import { MarkupScreen } from '../markup/MarkupScreen.js';
import { ChecksTab } from '../checks/ChecksTab.js';
import { HistoryTab } from '../history/HistoryTab.js';
import { PipelineBar } from './PipelineBar.js';
import { RevisionStreamProvider } from './stream.js';
import { StreamIndicator } from './StreamIndicator.js';

const TABS = ['files', 'markup', 'checks', 'history'] as const;
type TabKey = (typeof TABS)[number];

/**
 * Прежние вкладки, ставшие секциями «Проверки» (S24).
 *
 * Адреса `?tab=documents` и `?tab=fields` обязаны продолжать работать: по ним
 * ходят ссылки «finding → evidence» из таблицы замечаний — переход к
 * доказательству, отдельный пункт приёмки §16, — и любые ссылки, которые люди
 * успели сохранить. Молча открывать вместо них «Файлы» значило бы сломать
 * навигацию, оставив её на вид исправной.
 */
const MOVED_TO_CHECKS: Readonly<Record<string, 'documents' | 'fields'>> = {
  documents: 'documents',
  fields: 'fields',
};

/** Терминальные состояния: производное содержимое заперто (§3.9). */
const TERMINAL = ['returned', 'approved', 'superseded'];

/**
 * Подзаголовок: чья это работа и куда она попадёт.
 *
 * Раньше здесь печатался идентификатор поставки — строка, ничего не говорящая
 * человеку, который открыл ревизию по ссылке из замечания. Комплект называется
 * работой, месяцем и папкой, потому что именно этими тремя словами его ищут.
 * Отдельный запрос, а не поле рабочего процесса: рабочий процесс отвечает за
 * статус ревизии, и подмешивать в него карточку комплекта значило бы связать
 * два ответа, которые меняются по разным поводам.
 */
function WorkLine({ workId }: { workId: string }): ReactNode {
  const work = useQuery({
    queryKey: navigationKeys.work(workId),
    queryFn: () => getWork(workId),
  });

  if (work.data === undefined || work.data.kind !== 'available') return null;
  const data = work.data.data;

  // Подчёркивание задано явно: ссылка внутри абзаца текста обязана отличаться
  // от него не только цветом (WCAG 1.4.1, правило axe `link-in-text-block`).
  const inline = { textDecoration: 'underline' } as const;

  return (
    <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
      {labelOf(WORK_KIND_LABELS, data.kind)}: {data.title} · {periodLabel(data.period)} ·{' '}
      <Link to={`/ids/objects/${data.objectId}`} style={inline}>
        объект
      </Link>
      {data.registryId === null ? (
        ' · в реестр не включён'
      ) : (
        <>
          {' · '}
          <Link to={`/ids/registries/${data.registryId}`} style={inline}>
            реестр
          </Link>
        </>
      )}
    </Typography.Paragraph>
  );
}

export function RevisionScreen({ revisionId }: { revisionId: string }): ReactNode {
  return (
    <RevisionStreamProvider revisionId={revisionId}>
      <RevisionWorkspace revisionId={revisionId} />
    </RevisionStreamProvider>
  );
}

function RevisionWorkspace({ revisionId }: { revisionId: string }): ReactNode {
  const navigate = useNavigate();
  const requested = useQueryParam('tab');
  const moved = requested === null ? undefined : MOVED_TO_CHECKS[requested];
  const tab: TabKey =
    moved !== undefined
      ? 'checks'
      : TABS.includes(requested as TabKey)
        ? (requested as TabKey)
        : 'files';

  // Старый адрес переписывается на новый, а не просто открывает «Проверку»:
  // иначе строка в браузере продолжала бы обещать вкладку, которой нет, и
  // копирование ссылки из адресной строки воспроизводило бы устаревший вид.
  // `section` раскрывает нужную секцию — ссылка обязана вести к содержимому, а
  // не к свёрнутому заголовку.
  useEffect(() => {
    if (moved === undefined) return;
    navigate(`/ids/revisions/${revisionId}?tab=checks&section=${moved}`, { replace: true });
  }, [moved, navigate, revisionId]);

  const state = useQuery({
    queryKey: revisionKeys.workflow(revisionId),
    queryFn: () => workflow.state(revisionId),
  });

  if (state.isPending) return <LoadingState label="Загрузка ревизии…" />;
  if (state.isError) return <ErrorState error={state.error} title="Ревизия недоступна" />;

  const revision = state.data.revision;
  const sourceEditable = revision.status === 'draft';
  const derivedEditable = !TERMINAL.includes(revision.status);

  return (
    <>
      <ScreenHeading
        title={`Ревизия № ${String(revision.revisionNo)}`}
        extra={
          <>
            <Tag data-testid="revision-status-badge">
              {labelOf(WORKFLOW_STATUS_LABELS, revision.status)}
            </Tag>
            <StreamIndicator />
          </>
        }
      />
      <WorkLine workId={revision.workId} />

      {/*
        Две кнопки конвейера стоят НАД вкладками: они относятся к ревизии
        целиком, и «Проверить» с вкладки «Файлы» делает ровно то же, что с
        вкладки «Проверка». Внутри вкладки их пришлось бы искать.
      */}
      <PipelineBar revisionId={revisionId} editable={derivedEditable} />

      {!sourceEditable && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Состав ревизии заперт"
          description={
            'Файлы и страницы поданной ревизии неизменяемы: они входят в хэш состава. ' +
            'Исправление состава — новая ревизия после возврата.'
          }
        />
      )}

      <Tabs
        activeKey={tab}
        onChange={(key) => navigate(`/ids/revisions/${revisionId}?tab=${key}`)}
        destroyOnHidden
        items={[
          {
            key: 'files',
            label: 'Файлы',
            children: <FilesTab revisionId={revisionId} editable={sourceEditable} />,
          },
          {
            key: 'markup',
            label: 'Разметка',
            children: <MarkupScreen revisionId={revisionId} />,
          },
          {
            key: 'checks',
            label: 'Проверка',
            children: <ChecksTab revisionId={revisionId} />,
          },
          {
            key: 'history',
            label: 'История',
            children: <HistoryTab revisionId={revisionId} />,
          },
        ]}
      />

      {!derivedEditable && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="Ревизия в терминальном состоянии"
          description="Разметка, документы и реквизиты этой ревизии больше не правятся."
        />
      )}
    </>
  );
}
