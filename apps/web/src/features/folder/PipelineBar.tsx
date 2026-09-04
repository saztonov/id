/**
 * Две кнопки конвейера над вкладками ревизии (S21, переименованы в S24).
 *
 * ## Почему они в шапке, а не на вкладках
 *
 * До S21 шесть кнопок стояли по вкладкам, каждая рядом со своими данными:
 * сборка и разметка — на «Файлах», распознавание — на «Разметке»,
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
 * «Отправить на распознавание», «Собрать документы» и
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
import {
  App as AntApp,
  Alert,
  Button,
  Dropdown,
  Popconfirm,
  Progress,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { pipeline, recognition, folderEvents, type RecheckMode } from '../../api/endpoints.js';
import { pipelineKeys, folderKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import { useSession } from '../../app/session.js';
import { Link } from '../../app/router.js';
import { usePollingInterval } from './stream.js';
import { isDryRun, newestRecognitionRun, runningRecognitionRun } from './runs.js';
import { activeStageOf, isBusy } from './busy.js';
import { describeState, deferredStageOf, plural } from './state.js';
import { startedLabel } from './started.js';

/** Опрос постраничного прогресса, пока прогон идёт. */
const PROGRESS_POLL_MS = 5_000;

export interface PipelineBarProps {
  readonly folderId: string;
  /** Производное правится, пока ревизия не в терминальном состоянии. */
  readonly editable: boolean;
}

export function PipelineBar({ folderId, editable }: PipelineBarProps): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const pollingInterval = usePollingInterval();
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: folderKeys.processingStatus(folderId),
    // Сигнал пробрасывается до `fetch`: `invalidateQueries` отменяет идущий
    // рефетч, и без сигнала «отменённый» запрос всё равно уезжал на сервер.
    queryFn: ({ signal }) => folderEvents.processingStatus(folderId, signal),
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
    queryKey: folderKeys.recognitionRuns(folderId),
    queryFn: () => recognition.runs(folderId),
  });

  // Выбор прогона — в `runs.ts`, а не здесь: список приходит отсортированным по
  // УБЫВАНИЮ времени, и прежние `findLast`/`at(-1)` брали по нему САМЫЙ СТАРЫЙ
  // прогон ревизии.
  //
  // Прогресс читается по ИДУЩЕМУ прогону: он один — незавершённый прогон по
  // ревизии разметки в портале ровно один (доменный инвариант §6.2).
  const runningRun = runningRecognitionRun(runs.data);
  const lastRun = newestRecognitionRun(runs.data);
  /**
   * Законченный прогон этой ревизии: по нему и решается, есть ли выбор (S40).
   *
   * Именно ЗАКОНЧЕННЫЙ, а не «какой-нибудь»: пока прогон идёт, перечитывать
   * нечего, и меню предлагало бы отменить работу, которая ещё делается.
   */
  const finishedRun = runningRun === null && lastRun !== null ? lastRun : null;
  // `lastRunId` — прогон, запущенный В ЭТОЙ вкладке; он старше списка ровно на
  // время до первого его обновления. Новейший прогон стоит третьим: он и есть
  // ответ после перезагрузки страницы и при запуске из соседней вкладки.
  const progressRunId = runningRun?.id ?? lastRunId ?? lastRun?.id ?? null;

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
    await queryClient.invalidateQueries({ queryKey: folderKeys.processingStatus(folderId) });
    await queryClient.invalidateQueries({ queryKey: folderKeys.recognitionRuns(folderId) });
  };

  const startMarkup = useMutation({
    mutationFn: () => pipeline.markup(folderId),
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
      await queryClient.invalidateQueries({ queryKey: folderKeys.bundles(folderId) });
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const check = useMutation({
    mutationFn: (mode: RecheckMode = 'auto') => pipeline.check(folderId, mode),
    onSuccess: async (result) => {
      setLastRunId(result.recognitionRunId);
      message.success(startedLabel(result));
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  /**
   * Остановка обработки (S50).
   *
   * Подтверждение обязательно: нажатие прекращает работу, которая идёт часами,
   * и промах по соседней кнопке стоил бы её целиком. Формулировка называет
   * последствие честно — распознанное остаётся, продолжить можно.
   */
  const stop = useMutation({
    mutationFn: () => pipeline.stop(folderId),
    onSuccess: async (result) => {
      message.success(
        result.cancelledJobs === 0
          ? 'Останавливать было нечего: очередь уже пуста'
          : `Обработка остановлена: снято ${String(result.cancelledJobs)} ${plural(result.cancelledJobs, 'задача', 'задачи', 'задач')}`,
      );
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const data = status.data;
  const stage = data?.stage ?? null;
  const queued = data?.queued ?? 0;
  const running = data?.running ?? 0;
  const dead = data?.dead ?? 0;
  // Ожидание берётся ТЕКУЩЕЕ и вместе со стадией: пожизненный счётчик отсрочек
  // (`deferred`) остаётся ненулевым до конца обработки и потому называл
  // страницы ещё долго после того, как их дописали (см. шапку `state.ts`).
  const deferredStage = deferredStageOf(data);
  const busy = isBusy(stage, queued, running);
  const activeStage = activeStageOf(data);
  // Постраничный счётчик разметки приезжает в той же сводке: своего запроса и
  // своего опроса у него нет намеренно (см. `LayoutProgress` на сервере).
  const layout = data?.layout ?? null;
  const canRun = editable && can('pipeline.run');

  // Shadow-режим виден по снимку НОВЕЙШЕГО прогона, а не по настройке: снимок
  // пиннится на старте (ADR-0007), и прогон, начатый до переключения, идёт по
  // своему режиму, а не по текущему значению настройки. Спрашивать настройку
  // значило бы обещать про идущий прогон то, чего он не делает.
  //
  // `at(-1)` здесь был дефектом: список сортируется по убыванию времени, то есть
  // последний его элемент — САМЫЙ СТАРЫЙ прогон ревизии. Плашка режима описывала
  // давний ручной прогон и выглядела как включённая настройка портала.
  const dryRun = isDryRun(lastRun?.settingsSnapshot);

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
        {/*
          Первое нажатие выбора не имеет: распознавать нечего, кроме всего
          комплекта. Как только у ревизии есть законченный прогон, вопрос «что
          именно перечитать» становится настоящим и стоит денег — один пункт
          зовёт модель по нескольким листам, другой по всем, — поэтому его
          задаёт человек, а не портал за него.
        */}
        {finishedRun === null ? (
          <Tooltip title="Распознает блоки, разберёт документы и прогонит проверки. Если распознавание уже сделано — просто перепроверит.">
            <Button
              type="primary"
              onClick={() => check.mutate('auto')}
              loading={check.isPending}
              disabled={!canRun}
              data-testid="pipeline-check"
            >
              2. Распознать
            </Button>
          </Tooltip>
        ) : (
          <Dropdown
            trigger={['click']}
            disabled={!canRun || check.isPending}
            menu={{
              items: [
                {
                  key: 'errors',
                  label: 'Распознать только ошибки',
                  onClick: () => check.mutate('errors'),
                },
                {
                  key: 'full',
                  label: 'Распознать полностью весь документ',
                  danger: true,
                  onClick: () => check.mutate('full'),
                },
              ],
            }}
          >
            <Button
              type="primary"
              loading={check.isPending}
              disabled={!canRun}
              data-testid="pipeline-check"
            >
              {/*
                Стрелка набрана символом, а не иконкой: `@ant-design/icons` во
                фронте нет, и тянуть пакет ради одного знака дороже, чем
                написать знак.
              */}
              2. Распознать ▾
            </Button>
          </Dropdown>
        )}

        {/*
          «Стоп» показывается только тогда, когда есть что останавливать:
          кнопка, которая всегда на экране и почти всегда бесполезна, приучает
          её не замечать — а нужна она в тот единственный раз, когда человек
          понял, что запустил не то.
        */}
        {busy && (
          <Popconfirm
            title="Остановить обработку?"
            description="Распознанное сохранится. Продолжить можно кнопкой «2. Распознать»."
            okText="Остановить"
            okButtonProps={{ danger: true }}
            cancelText="Отмена"
            onConfirm={() => stop.mutate()}
          >
            <Button danger loading={stop.isPending} disabled={!canRun} data-testid="pipeline-stop">
              Стоп
            </Button>
          </Popconfirm>
        )}

        {/*
          Живое состояние. `aria-live="polite"` обязателен: пользователь нажал
          кнопку и ждёт, а изменение приходит не от его действия — скринридер
          иначе о нём не сообщит вовсе.
        */}
        <span aria-live="polite" data-testid="pipeline-state">
          <Typography.Text type="secondary">
            {describeState({
              stage,
              activeStage,
              queued,
              running,
              deferredStage,
              dead,
              busy,
              dryRun,
              progress: progress.data ?? null,
            })}
          </Typography.Text>
        </span>

        {busy && <Elapsed sinceMs={data?.elapsedMs ?? null} />}

        {/*
          Счётчик выделения блоков. Показывается, пока стадия идёт: у детекции
          нет своего прогона, поэтому и привязан он к стадии, а не к его
          идентификатору. Своего запроса счётчик не заводит — числа приезжают
          в той же сводке, которую экран уже опрашивает и которую поток
          обесценивает на каждое `layout.detected`.

          Стадия берётся ТЕКУЩАЯ, а не сводная: по сводной полоса вылезала во
          время сборки рабочего документа и показывала прошлый комплект.
        */}
        {activeStage === 'layout' && busy && layout !== null && (
          <Space size={8} data-testid="pipeline-layout-progress">
            <Progress
              type="line"
              style={{ width: 160 }}
              percent={Math.round((layout.pagesDone / layout.pagesTotal) * 100)}
              size="small"
              status={layout.pagesFailed > 0 ? 'exception' : 'active'}
            />
            <Typography.Text type="secondary">
              размечено {layout.pagesDone}{' '}
              {plural(layout.pagesDone, 'страница', 'страницы', 'страниц')} из {layout.pagesTotal}
              {layout.pagesFailed > 0 ? `, страниц с отказом ${String(layout.pagesFailed)}` : ''}
            </Typography.Text>
          </Space>
        )}

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
              {progress.data.blocksRecognized} из {progress.data.blocksTotal}
              {progress.data.pagesFailed > 0
                ? `, страниц с отказом ${String(progress.data.pagesFailed)}`
                : ''}
              {/*
                Дораспознавание и восстановление — не служебные подробности:
                они объясняют, почему прогон идёт второй круг или почему он
                добежал до конца подозрительно быстро. Без них экран показывает
                одно и то же для работы и для повтора работы.
              */}
              {progress.data.recoveryRound > 0 ? ', идёт дораспознавание упавших страниц' : ''}
              {progress.data.blocksReused > 0
                ? `, перенесено из прошлого прогона ${String(progress.data.blocksReused)}`
                : ''}
            </Typography.Text>
          </Space>
        )}
      </Space>

      {dryRun && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="pipeline-dry-run"
          message="Портал в режиме сравнения провайдеров: результат не публикуется"
          description={
            <Typography.Text>
              Распознавание выполняется и проверяется, но в комплект не попадает: ни распознанного
              текста, ни документов, ни замечаний после него не появится. Это настройка
              «ai.dry_run_only» в администрировании — выключите её, чтобы прогон доходил до
              проверок.
            </Typography.Text>
          }
        />
      )}

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
              <Link to={`/ids/folders/${folderId}?tab=history`}>
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
 * Причина остановки: КТО умер и что при этом сказал сервер.
 *
 * Выбирается тип с мёртвыми задачами, а не с наибольшим числом отказавших
 * попыток, и это разные вопросы. `failed` считает попытки: пять неудач одной
 * задачи, которая на шестой прошла, — это работающий конвейер. `dead` считает
 * задачи, которым повторять больше нечем, — только это и означает остановку.
 *
 * Прежний выбор по `failed` давал на стенде худший из возможных ответов:
 * поллер финализации записывал каждое ожидание страниц как отказ, набирал
 * двенадцать за минуту и ЗАСЛОНЯЛ собой единственную задачу, которая
 * действительно исчерпала попытки. Плашка называла виновником того, кто
 * нормально работал.
 */
function failureOf(
  data:
    | {
        jobTypes: readonly {
          jobType: string;
          attempts: number;
          dead: number;
          lastErrorClass: string | null;
          lastErrorMessage: string | null;
          lastReasonText: string | null;
        }[];
      }
    | undefined,
): { what: string; reason: string } | null {
  if (data === undefined) return null;

  const worst = [...data.jobTypes].filter((row) => row.dead > 0).sort((a, b) => b.dead - a.dead)[0];
  if (worst === undefined) return null;

  /**
   * Причина словами предпочтительнее нормализованного сообщения (S44).
   *
   * `lastErrorMessage` — ключ агрегации журнала, и числа из него вычеркнуты
   * намеренно (ADR-0010): человек читал «попытка не уложилась в <n> мс» и не мог
   * ответить на вопрос «сколько ждали». `lastReasonText` заполняется только
   * своими классами ошибок из их типизированных полей, поэтому число в нём
   * настоящее. `null` там означает «причина не наша» — тогда шаблон, как
   * раньше.
   */
  const reason =
    worst.lastReasonText ??
    worst.lastErrorMessage ??
    (worst.lastErrorClass === null
      ? 'Сервер не назвал причину; подробности — в журнале задач.'
      : `Класс ошибки: ${worst.lastErrorClass}.`);

  /**
   * Сколько ЗАДАЧ встало, а не сколько попыток они суммарно сделали.
   *
   * `attempts` — агрегат по всему типу задачи: на комплекте в восемьдесят три
   * страницы он давал «попыток 215» при ста тридцати двух мёртвых задачах, и
   * читалось это как одна задача, которая двести раз пыталась. Число попыток
   * ОДНОЙ задачи отсюда неизвестно в принципе, поэтому оно и не называется:
   * плашка отвечает на «что встало и почему», а подробности — в журнале задач.
   */
  const what =
    worst.dead === 1
      ? `задача «${worst.jobType}» исчерпала попытки`
      : `задачи «${worst.jobType}» исчерпали попытки, задач ${String(worst.dead)}`;

  return { what, reason };
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
