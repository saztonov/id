/**
 * Две кнопки конвейера над вкладками ревизии (S21).
 *
 * ## Почему они в шапке, а не на вкладках
 *
 * До S21 шесть кнопок стояли по вкладкам, каждая рядом со своими данными:
 * сборка и разметка — на «Файлах», заморозка и распознавание — на «Разметке»,
 * сборка документов — на «Документах», проверка — на «Проверке». Это было
 * верно, пока каждая кнопка означала свою стадию: человек шёл по вкладкам и
 * нажимал очередную.
 *
 * «Разметить» и «Проверить» относятся к РЕВИЗИИ ЦЕЛИКОМ и не принадлежат ни
 * одной вкладке: «Проверить», нажатая на «Файлах», делает ровно то же, что
 * нажатая на «Проверке». Положить их на вкладку значило бы заставить искать, на
 * какой именно, — то есть вернуть навигацию по стадиям, которую они и убирают.
 *
 * ## Прежние кнопки остались
 *
 * Ручной путь инженера не тронут: «Собрать рабочий документ», «Разметить файл»,
 * «Заморозить разметку», «Отправить на распознавание», «Собрать документы» и
 * «Запустить проверку» стоят там же, где стояли. Они нужны, когда что-то пошло
 * не так и нужно переиграть ОДНУ стадию, — «Пересобрать нарезку» существует
 * ровно для случая, когда задача исчерпала попытки.
 *
 * ## Состояние берётся из конвейера, а не запоминается кнопкой
 *
 * Что сейчас происходит, знает `processing-status`, и он же обновляется потоком
 * событий ревизии. Собственное состояние «я нажал, значит идёт» разошлось бы с
 * фактом при первой же упавшей задаче и пережило бы перезагрузку страницы
 * неверным.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Button, Progress, Space, Tooltip, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { pipeline, recognition, revisionEvents } from '../../api/endpoints.js';
import { pipelineKeys, revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import { useSession } from '../../app/session.js';
import { usePollingInterval } from './stream.js';

/** Стадии, на которых конвейер что-то делает прямо сейчас. */
const BUSY_STAGES: readonly string[] = ['uploaded', 'layout', 'recognition', 'analysis', 'checks'];

const STAGE_STARTED_LABEL: Readonly<Record<string, string>> = {
  recognition: 'Распознавание запущено: дальше анализ и проверки пойдут сами',
  analysis: 'Распознано; запущены разбор документов и реквизитов, за ними — проверки',
  checks: 'Запущен прогон правил по уже разобранным документам',
};

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
    queryFn: () => revisionEvents.processingStatus(revisionId),
    refetchInterval: pollingInterval,
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
    queryFn: () => pipeline.progress(progressRunId ?? ''),
    enabled: progressRunId !== null && runningRun !== null,
    refetchInterval: 5_000,
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
              ? 'Разметка запущена: детекция пойдёт постраничными пачками'
              : 'Разметка уже идёт'
            : 'Собирается рабочий документ, разметка пойдёт сразу за ним',
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
      const started = STAGE_STARTED_LABEL[result.stage] ?? 'Проверка запущена';
      message.success(result.frozen ? `Разметка заморожена. ${started}` : started);
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const stage = status.data?.stage ?? null;
  const busy = stage !== null && BUSY_STAGES.includes(stage) && (status.data?.running ?? 0) > 0;
  const canRun = editable && can('pipeline.run');

  return (
    <Space
      wrap
      align="center"
      style={{ marginBottom: 12 }}
      data-testid="pipeline-bar"
      role="group"
      aria-label="Конвейер обработки комплекта"
    >
      <Tooltip title="Соберёт рабочий документ и разметит страницы на блоки">
        <Button
          onClick={() => startMarkup.mutate()}
          loading={startMarkup.isPending}
          disabled={!canRun}
          data-testid="pipeline-markup"
        >
          Разметить
        </Button>
      </Tooltip>
      <Tooltip title="Заморозит разметку, распознает блоки и прогонит проверки">
        <Button
          type="primary"
          onClick={() => check.mutate()}
          loading={check.isPending}
          disabled={!canRun}
          data-testid="pipeline-check"
        >
          Проверить
        </Button>
      </Tooltip>

      {/*
        Живое состояние. `aria-live="polite"` обязателен: пользователь нажал
        кнопку и ждёт, а изменение приходит не от его действия — скринридер
        иначе о нём не сообщит вовсе.
      */}
      <span aria-live="polite" data-testid="pipeline-state">
        {busy ? (
          <Typography.Text type="secondary">
            идёт: {stageLabel(stage)}
            {status.data?.dead !== undefined && status.data.dead > 0
              ? `, задач упало: ${String(status.data.dead)}`
              : ''}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">
            {stage === null ? 'конвейер не запускался' : `последняя стадия: ${stageLabel(stage)}`}
          </Typography.Text>
        )}
      </span>

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
              ? `, страниц с отказом ${progress.data.pagesFailed}`
              : ''}
          </Typography.Text>
        </Space>
      )}
    </Space>
  );
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
      return 'разметка страниц на блоки';
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
