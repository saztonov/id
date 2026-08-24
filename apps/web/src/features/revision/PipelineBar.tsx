/**
 * Две кнопки конвейера над вкладками ревизии (S21, переименованы в S24).
 *
 * ## Почему они в шапке, а не на вкладках
 *
 * До S21 шесть кнопок стояли по вкладкам, каждая рядом со своими данными:
 * сборка и разметка — на «Файлах», заморозка и распознавание — на «Разметке»,
 * сборка документов — на «Документах», проверка — на «Проверке». Это было
 * верно, пока каждая кнопка означала свою стадию: человек шёл по вкладкам и
 * нажимал очередную.
 *
 * «Выделить блоки» и «Распознать» относятся к РЕВИЗИИ ЦЕЛИКОМ и не принадлежат
 * ни одной вкладке: «Распознать», нажатая на «Файлах», делает ровно то же, что
 * нажатая на «Проверке». Положить их на вкладку значило бы заставить искать, на
 * какой именно, — то есть вернуть навигацию по стадиям, которую они и убирают.
 *
 * ## Почему у кнопок номера (S24)
 *
 * Прежние имена — «Разметить» и «Проверить» — не говорили ни о порядке, ни о
 * разнице между ними, а слово «проверить» в портале означало три разные вещи:
 * прогнать конвейер, прогнать правила и подать комплект на согласование.
 * Заказчик описал работу как «нажал выделить … дальше нажал распознать», и
 * кнопки названы его словами. Номер отвечает на вопрос «а что сначала» без
 * подсказки, которую надо навести.
 *
 * ## Прежние кнопки остались
 *
 * Ручной путь инженера не тронут: «Собрать рабочий документ», «Разметить файл»,
 * «Заморозить разметку», «Отправить на распознавание», «Собрать документы» и
 * гранулярный прогон правил стоят там же, где стояли. Они нужны, когда что-то
 * пошло не так и нужно переиграть ОДНУ стадию, — «Пересобрать нарезку»
 * существует ровно для случая, когда задача исчерпала попытки.
 *
 * ## Состояние берётся из конвейера, а не запоминается кнопкой
 *
 * Что сейчас происходит, знает `processing-status`, и он же обновляется потоком
 * событий ревизии. Собственное состояние «я нажал, значит идёт» разошлось бы с
 * фактом при первой же упавшей задаче и пережило бы перезагрузку страницы
 * неверным.
 *
 * ## Экран обязан отвечать «оно живое?» (S24)
 *
 * Прежняя строка состояния молчала ровно там, где вопрос и возникает. Задача,
 * стоящая в очереди, давала `running === 0`, и экран печатал «последняя стадия:
 * …» — то же самое, что в полном простое. Полоса прогресса требовала, чтобы у
 * прогона уже были зарегистрированы страницы, а до этого не показывалась вовсе.
 * Отказ сводился к «задач упало: N» без единого слова о причине, хотя причина
 * приходит в том же ответе (`jobTypes[].lastErrorMessage`) и просто не
 * читалась.
 *
 * Теперь названы все четыре состояния — «в очереди», «идёт», «готово»,
 * «отказ» — и в занятом конвейере всегда тикает время от старта: растущее число
 * секунд отвечает на «оно живое?» дешевле любой анимации.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { App as AntApp, Alert, Button, Progress, Space, Tooltip, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { pipeline, recognition, revisionEvents } from '../../api/endpoints.js';
import { pipelineKeys, revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import { useSession } from '../../app/session.js';
import { Link } from '../../app/router.js';
import { usePollingInterval } from './stream.js';

/** Стадии, на которых конвейер что-то делает прямо сейчас. */
const BUSY_STAGES: readonly string[] = ['uploaded', 'layout', 'recognition', 'analysis', 'checks'];

const STAGE_STARTED_LABEL: Readonly<Record<string, string>> = {
  recognition: 'Распознавание запущено: дальше анализ и проверки пойдут сами',
  analysis: 'Распознано; запущены разбор документов и реквизитов, за ними — проверки',
  checks: 'Запущен прогон правил по уже разобранным документам',
};

/** Опрос постраничного прогресса, пока прогон идёт. */
const PROGRESS_POLL_MS = 5_000;

export interface PipelineBarProps {
  readonly revisionId: string;
  /** Производное правится, пока ревизия не в терминальном состоянии. */
  readonly editable: boolean;
}

export function PipelineBar({ revisionId, editable }: PipelineBarProps): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const pollingInterval = usePollingInterval();
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: revisionKeys.processingStatus(revisionId),
    // Сигнал пробрасывается до `fetch`: `invalidateQueries` отменяет идущий
    // рефетч, и без сигнала «отменённый» запрос всё равно уезжал на сервер.
    queryFn: ({ signal }) => revisionEvents.processingStatus(revisionId, signal),
    // Функция, а не число: опрос обязан замолкать, когда опрашивать нечего.
    // Прежний фиксированный интервал тикал и в простое, и — что хуже — после
    // отказа, добивая уже исчерпанный лимит запросов.
    refetchInterval: (query) => {
      if (query.state.error !== null) return false;
      const data = query.state.data;
      if (data === undefined) return pollingInterval;
      return isBusy(data.stage, data.queued, data.running) ? pollingInterval : false;
    },
  });

  const runs = useQuery({
    queryKey: revisionKeys.recognitionRuns(revisionId),
    queryFn: () => recognition.runs(revisionId),
  });

  // Прогресс читается по ПОСЛЕДНЕМУ идущему прогону: он один — незавершённый
  // прогон по ревизии разметки в портале ровно один (доменный инвариант §6.2).
  const runningRun = (runs.data ?? []).findLast((run) => run.status === 'running') ?? null;
  const progressRunId = runningRun?.id ?? lastRunId;

  // Прогресс опрашивается ВСЕГДА, пока прогон идёт, — и при живом потоке тоже.
  // Поток несёт события задач (`job.succeeded` на каждую страницу), но по §
  // разбора они обесценивают только сводку стадий: постраничные счётчики живут
  // в `recognition_run_pages`, и своего события у них нет. Пять секунд — цена
  // одного маленького запроса против «полоса стоит, а работа идёт».
  const progress = useQuery({
    queryKey: pipelineKeys.recognitionProgress(progressRunId ?? 'none'),
    queryFn: ({ signal }) => pipeline.progress(progressRunId ?? '', signal),
    enabled: progressRunId !== null && runningRun !== null,
    refetchInterval: (query) => (query.state.error === null ? PROGRESS_POLL_MS : false),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: revisionKeys.processingStatus(revisionId) });
    await queryClient.invalidateQueries({ queryKey: revisionKeys.recognitionRuns(revisionId) });
  };

  const startMarkup = useMutation({
    mutationFn: () => pipeline.markup(revisionId),
    onSuccess: async (result) => {
      // Пропуск детекции — предупреждение, а не успех и не отказ: черновик
      // разметки создан, размечать можно руками, но обещать «идёт детекция»
      // нельзя — в очередь ничего не положили.
      if (result.detectionSkipped) {
        message.warning(
          result.detectionSkipReason ??
            'Детекция пропущена: модель не загружена. Разметьте страницы вручную.',
          10,
        );
      } else {
        message.success(
          result.bundleReady
            ? result.jobCreated
              ? 'Выделение блоков запущено: детекция пойдёт постраничными пачками'
              : 'Выделение блоков уже идёт'
            : 'Собирается рабочий документ, выделение блоков пойдёт сразу за ним',
        );
      }
      await queryClient.invalidateQueries({ queryKey: revisionKeys.bundles(revisionId) });
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const check = useMutation({
    mutationFn: () => pipeline.check(revisionId),
    onSuccess: async (result) => {
      setLastRunId(result.recognitionRunId);
      const started = STAGE_STARTED_LABEL[result.stage] ?? 'Обработка запущена';
      message.success(result.frozen ? `Разметка заморожена. ${started}` : started);
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const data = status.data;
  const stage = data?.stage ?? null;
  const queued = data?.queued ?? 0;
  const running = data?.running ?? 0;
  const dead = data?.dead ?? 0;
  const busy = isBusy(stage, queued, running);
  const canRun = editable && can('pipeline.run');

  // Отказ показывается и когда сводная стадия уже уехала дальше: упавшая задача
  // остаётся упавшей, даже если следующая стадия успела начаться.
  const failure = dead > 0 || stage === 'failed' ? failureOf(data) : null;

  return (
    <div data-testid="pipeline-bar" role="group" aria-label="Конвейер обработки комплекта">
      <Space wrap align="center" style={{ marginBottom: failure === null ? 12 : 8 }}>
        <Tooltip title="Соберёт рабочий документ и разметит страницы на блоки. Блоки можно поправить руками на вкладке «Разметка».">
          <Button
            onClick={() => startMarkup.mutate()}
            loading={startMarkup.isPending}
            disabled={!canRun}
            data-testid="pipeline-markup"
          >
            1. Выделить блоки
          </Button>
        </Tooltip>
        <Tooltip title="Заморозит разметку, распознает блоки, разберёт документы и прогонит проверки. Если распознавание уже сделано — просто перепроверит.">
          <Button
            type="primary"
            onClick={() => check.mutate()}
            loading={check.isPending}
            disabled={!canRun}
            data-testid="pipeline-check"
          >
            2. Распознать
          </Button>
        </Tooltip>

        {/*
          Живое состояние. `aria-live="polite"` обязателен: пользователь нажал
          кнопку и ждёт, а изменение приходит не от его действия — скринридер
          иначе о нём не сообщит вовсе.
        */}
        <span aria-live="polite" data-testid="pipeline-state">
          <Typography.Text type="secondary">
            {describeState({ stage, queued, running, busy, progress: progress.data ?? null })}
          </Typography.Text>
        </span>

        {busy && <Elapsed sinceMs={data?.elapsedMs ?? null} />}

        {/*
          Полоса появляется вместе с прогоном, а не вместе с первой страницей.
          Раньше между «нажал» и «пошли страницы» экран не показывал ничего, и
          самая длинная пауза конвейера выглядела как бездействие.
        */}
        {progress.data !== undefined && progress.data.pagesTotal > 0 && (
          <Space size={8} data-testid="pipeline-progress">
            <Progress
              type="line"
              style={{ width: 160 }}
              percent={Math.round((progress.data.pagesDone / progress.data.pagesTotal) * 100)}
              size="small"
              status={progress.data.pagesFailed > 0 ? 'exception' : 'active'}
            />
            <Typography.Text type="secondary">
              страниц {progress.data.pagesDone} из {progress.data.pagesTotal}, блоков распознано{' '}
              {progress.data.blocksRecognized}
              {progress.data.pagesFailed > 0
                ? `, страниц с отказом ${String(progress.data.pagesFailed)}`
                : ''}
            </Typography.Text>
          </Space>
        )}
      </Space>

      {failure !== null && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="pipeline-failure"
          message={`Обработка остановилась: ${failure.what}`}
          description={
            <Space direction="vertical" size={2}>
              {/*
                Текст ошибки приходил в `processing-status` с самого начала и не
                показывался ни одним экраном: узнать причину можно было только в
                админ-консоли задач. «Задач упало: 1» — это сообщение, после
                которого спрашивают «а почему», и спросить было не у кого.
              */}
              <Typography.Text>{failure.reason}</Typography.Text>
              <Link to={`/ids/revisions/${revisionId}?tab=history`}>
                Подробности прогона в «Истории»
              </Link>
            </Space>
          }
        />
      )}
    </div>
  );
}

/**
 * Занят ли конвейер.
 *
 * Очередь считается занятостью наравне с выполнением: задача, ждущая
 * исполнителя, — это работа, которая идёт, просто ещё не начатая. Прежнее
 * условие смотрело только на `running`, и время ожидания воркера экран
 * показывал как простой.
 */
function isBusy(stage: string | null, queued: number, running: number): boolean {
  if (stage === null) return false;
  if (!BUSY_STAGES.includes(stage)) return false;
  return queued > 0 || running > 0;
}

interface StateInput {
  readonly stage: string | null;
  readonly queued: number;
  readonly running: number;
  readonly busy: boolean;
  readonly progress: { readonly pagesTotal: number } | null;
}

/** Одна фраза о том, что происходит прямо сейчас. */
function describeState(input: StateInput): string {
  const { stage, queued, running, busy, progress } = input;

  if (stage === null) return 'конвейер не запускался';
  if (!busy) {
    if (stage === 'ready') return 'готово';
    if (stage === 'failed') return 'обработка остановлена отказом';
    return `последняя стадия: ${stageLabel(stage)}`;
  }

  // Прогон создан, но страниц ещё нет: между постановкой в очередь и первой
  // страницей проходят десятки секунд, и молчание здесь читается как зависание.
  if (stage === 'recognition' && running > 0 && (progress === null || progress.pagesTotal === 0)) {
    return 'идёт: готовим страницы к распознаванию';
  }
  if (running === 0) {
    return `в очереди: ${String(queued)} ${plural(queued, 'задача', 'задачи', 'задач')}, ждём исполнителя`;
  }
  return `идёт: ${stageLabel(stage)}`;
}

/**
 * Причина остановки: что упало и что при этом сказал сервер.
 *
 * Берётся тип задач с наибольшим числом отказов, а не первый попавшийся: в
 * сводке одновременно могут висеть старый единичный отказ и свежая серия, и
 * назвать надо ту, из-за которой всё встало.
 */
function failureOf(
  data:
    | {
        jobTypes: readonly {
          jobType: string;
          failed: number;
          lastErrorClass: string | null;
          lastErrorMessage: string | null;
        }[];
      }
    | undefined,
): { what: string; reason: string } | null {
  if (data === undefined) return null;

  const worst = [...data.jobTypes]
    .filter((row) => row.failed > 0)
    .sort((a, b) => b.failed - a.failed)[0];
  if (worst === undefined) return null;

  const reason =
    worst.lastErrorMessage ??
    (worst.lastErrorClass === null
      ? 'Сервер не назвал причину; подробности — в журнале задач.'
      : `Класс ошибки: ${worst.lastErrorClass}.`);

  return {
    what: `задача «${worst.jobType}», отказов ${String(worst.failed)}`,
    reason,
  };
}

/**
 * Время от старта конвейера.
 *
 * Считается на клиенте от `elapsedMs`, снятого сервером: пересчитывать секунду
 * запросом означало бы двенадцать лишних обращений в минуту ради часов. Тикающее
 * число — самый дешёвый ответ на «оно живое или зависло»: анимация крутится и у
 * мёртвого экрана, а число растёт только у работающего.
 */
function Elapsed({ sinceMs }: { sinceMs: number | null }): ReactNode {
  const [extraMs, setExtraMs] = useState(0);

  useEffect(() => {
    setExtraMs(0);
    if (sinceMs === null) return;
    const started = Date.now();
    const timer = setInterval(() => setExtraMs(Date.now() - started), 1_000);
    return () => clearInterval(timer);
  }, [sinceMs]);

  if (sinceMs === null) return null;
  const total = Math.max(0, Math.round((sinceMs + extraMs) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  return (
    <Typography.Text type="secondary" data-testid="pipeline-elapsed">
      {minutes === 0
        ? `${String(seconds)} с`
        : `${String(minutes)} мин ${String(seconds).padStart(2, '0')} с`}
    </Typography.Text>
  );
}

/** Склонение по русскому правилу: 1 задача, 2 задачи, 5 задач. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Подписи стадий.
 *
 * Отдельная таблица, а не `PROCESSING_STAGE_LABELS` из `shared/labels`: там
 * стадии названы для журнала («распознавание»), а здесь фраза встраивается в
 * «идёт: …» и читается вместе с ней.
 */
function stageLabel(stage: string | null): string {
  switch (stage) {
    case 'uploaded':
      return 'приём файлов и сборка рабочего документа';
    case 'layout':
      return 'выделение блоков на страницах';
    case 'recognition':
      return 'распознавание';
    case 'analysis':
      return 'разбор документов и реквизитов';
    case 'checks':
      return 'проверка правилами';
    case 'ready':
      return 'нарезка и выдача';
    default:
      return stage ?? 'неизвестно';
  }
}
