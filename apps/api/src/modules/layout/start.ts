/**
 * Запуск цепочки разметки поверх ГОТОВОГО рабочего документа.
 *
 * Вынесено из маршрута `POST /revisions/{id}/layout` отдельным модулем, потому
 * что вызывающих стало двое, и второй — не маршрут:
 *
 * 1. прежний маршрут «Разметить файл» (ручной путь инженера, не изменился);
 * 2. обработчик `bundle.build`, когда сборка запрошена кнопкой «Разметить»
 *    (S21): рабочего документа в момент нажатия ещё нет, а разметка обязана
 *    пойти сразу за сборкой — иначе кнопок снова две вместо одной.
 *
 * Копия этой логики в воркере была бы вторым местом, где читается
 * `detection.provider` и выбирается ветка RF-DETR/RD WEB, и разошлась бы с
 * первым при первой же правке. Модуль лежит в `apps/api`, воркер импортирует
 * его через `@id/api` — так же, как импортирует репозитории.
 *
 * Отказы здесь бросаются `conflict()`: у маршрута это 409 пользователю, у
 * задачи — нерепробируемая ошибка с тем же текстом в консоли задач. Оба ответа
 * верные, и придумывать задаче собственный класс ошибки не нужно.
 */
import type { Logger } from 'pino';

import type { AuthScope } from '../../auth/scope.js';
import type { Database } from '../../db/repositories/users.js';
import { listBundlePages } from '../../db/repositories/bundles.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { ensureDraftLayout } from '../../db/repositories/layout.js';
import { readDetectionSettings } from '../../config/portal-settings.js';
import { DETECT_BATCH_LIMIT } from '../../integrations/rdweb/legacy-adapter.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { conflict } from '../../lib/problem.js';
import { tracePayload } from '../../observability/context.js';

export interface StartMarkupResult {
  readonly layoutRevisionId: string;
  readonly bundleId: string;
  /** Создан ли черновик разметки этим вызовом (а не подобран существующий). */
  readonly created: boolean;
  readonly version: number;
  readonly provider: 'rdweb' | 'local';
  /** Все поставленные задачи: у локальной ветки их страница к странице. */
  readonly jobIds: readonly string[];
  /**
   * Появилась ли этим вызовом хоть одна НОВАЯ задача.
   *
   * `false` означает «всё уже стоит в очереди»: повторное нажатие кнопки
   * склеилось с прежним по ключу идемпотентности. Экран говорит об этом
   * пользователю разными словами («запущено» против «уже идёт»), поэтому
   * значение обязано быть настоящим, а не константой.
   */
  readonly jobsCreated: boolean;
  /**
   * Детекция пропущена: запускать нечем.
   *
   * Не отказ. Черновик разметки создаётся, страницы размечаются руками, и это
   * рабочий путь портала с самого начала. Отказом это было бы, если бы ручная
   * разметка зависела от модели, — она не зависит.
   */
  readonly detectionSkipReason: string | null;
}

/**
 * Почему детекцию нельзя запустить — или `null`, если можно.
 *
 * Читается ДО постановки задач и, отдельно, до сборки рабочего документа в
 * маршруте: без этого пользователь узнавал бы о ненастроенной модели из консоли
 * задач через минуту после нажатия, а на экране всё это время стояло бы «идёт
 * детекция».
 */
export function detectionUnavailableReason(detection: {
  readonly provider: string;
  readonly modelVersion: string;
}): string | null {
  if (detection.provider !== 'local') return null;
  if (detection.modelVersion !== '') return null;
  return (
    'Модель детекции не загружена: в настройках портала пуста ' +
    '`detection.model_version`. Разметьте страницы вручную либо попросите ' +
    'администратора выложить веса модели.'
  );
}

/**
 * Черновик разметки + постановка детекции.
 *
 * `previewCached` передаётся значением, а не читается из окружения: у воркера
 * оно своё, и предупреждение обязано выписываться в его журнал, а не в журнал
 * процесса API.
 */
export async function startMarkupOnBundle(
  db: Database,
  scope: AuthScope,
  input: {
    readonly revisionId: string;
    readonly bundleId: string;
    readonly previewCached: boolean;
    readonly logger: Logger;
  },
): Promise<StartMarkupResult> {
  const { layout, created } = await ensureDraftLayout(db, scope, {
    revisionId: input.revisionId,
    bundleId: input.bundleId,
  });

  // Ветвление детекции (ADR-0008): локальный RF-DETR не создаёт RD-документ и
  // не ходит в RD WEB вовсе. Настройка читается на постановке; идущие задачи её
  // смену не видят — у них цель уже в payload.
  const detection = await readDetectionSettings(db);

  if (detection.provider === 'local') {
    // Постановка пачек без выложенной модели давала бы страницу задач,
    // падающих гарантированно и одинаково: воркер не нашёл бы ни весов, ни
    // манифеста. Черновик разметки при этом уже создан выше, поэтому ручная
    // разметка доступна — а значит, отказывать нечему, и правильный ответ здесь
    // «сделано, но без детекции», а не 409.
    const unavailable = detectionUnavailableReason(detection);
    if (unavailable !== null) {
      input.logger.warn(
        { event: 'detection_skipped_no_model' },
        'детекция пропущена: версия модели не задана',
      );
      return {
        layoutRevisionId: layout.id,
        bundleId: input.bundleId,
        created,
        version: layout.version,
        provider: 'local',
        jobIds: [],
        jobsCreated: false,
        detectionSkipReason: unavailable,
      };
    }

    if (input.previewCached) {
      // Кэш превью брал картинки у RD WEB; при локальной детекции его взять
      // неоткуда — экран работает через pdf.js (ADR-0008).
      input.logger.warn(
        { event: 'preview_cached_unavailable_local_detection' },
        'PREVIEW_MODE=cached недоступен при локальной детекции: превью рендерит браузер',
      );
    }
    const pages = (await listBundlePages(db, scope, input.bundleId)).map(
      (page) => page.workingPageIndex,
    );
    if (pages.length === 0) throw conflict('У рабочего документа нет карты страниц.');

    const enqueued = await enqueueLocalDetectBatches(db, scope, {
      layoutRevisionId: layout.id,
      revisionId: input.revisionId,
      pages,
      overwriteExisting: false,
      logger: input.logger,
    });
    return {
      layoutRevisionId: layout.id,
      bundleId: input.bundleId,
      created,
      version: layout.version,
      provider: 'local',
      jobIds: enqueued.jobIds,
      jobsCreated: enqueued.created,
      detectionSkipReason: null,
    };
  }

  // Постановка первой задачи цепочки §12 (задача 4). Ключ идемпотентности — по
  // ревизии разметки: повторное нажатие кнопки не должно порождать второй
  // RD-документ.
  const { jobId, created: jobCreated } = await enqueueJob(db, scope, {
    type: 'rd.create_run_document',
    // Ревизия разметки — в payload, а не «найдётся по bundle»: пока задача ждёт
    // в очереди, черновик может смениться (заморозка №1 → создание №2), и
    // задача отработала бы по чужой цели.
    payload: tracePayload({
      revisionId: input.revisionId,
      bundleId: input.bundleId,
      layoutRevisionId: layout.id,
    }),
    dedupeKey: dedupeKeyFor('rd.create_run_document', layout.id),
  });

  input.logger.info(
    {
      event: 'job_enqueued',
      job_type: 'rd.create_run_document',
      job_id: jobId,
      created: jobCreated,
    },
    'цепочка разметки поставлена в очередь',
  );

  return {
    layoutRevisionId: layout.id,
    bundleId: input.bundleId,
    created,
    version: layout.version,
    provider: 'rdweb',
    jobIds: [jobId],
    jobsCreated: jobCreated,
    detectionSkipReason: null,
  };
}

/**
 * Разбиение комплекта на пачки детекции RD WEB.
 *
 * Одна задача = одна пачка: у их синхронного вызова есть потолок страниц, а
 * задача, обходящая весь комплект в цикле, держала бы аренду минутами и при
 * падении переигрывала бы уже сделанное. Ключ идемпотентности включает границы
 * пачки, поэтому повторное нажатие не удваивает очередь.
 */
export async function enqueueDetectBatches(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly revisionId: string;
    readonly pages: readonly number[];
    readonly logger: Logger;
  },
): Promise<string[]> {
  const jobIds: string[] = [];
  for (let offset = 0; offset < input.pages.length; offset += DETECT_BATCH_LIMIT) {
    const batch = input.pages.slice(offset, offset + DETECT_BATCH_LIMIT);
    const { jobId } = await enqueueJob(db, scope, {
      type: 'layout.detect_pages',
      payload: tracePayload({
        revisionId: input.revisionId,
        layoutRevisionId: input.layoutRevisionId,
        pageIndices: batch,
        overwriteExisting: true,
      }),
      // Метка `overwrite` входит в ключ: без неё нажатие кнопки склеилось бы с
      // уже стоящей в очереди пачкой первичной цепочки, и флаг потерялся бы.
      dedupeKey: dedupeKeyFor(
        'layout.detect_pages',
        input.layoutRevisionId,
        `${String(batch[0])}-${String(batch[batch.length - 1])}`,
        'overwrite',
      ),
    });
    jobIds.push(jobId);
  }
  input.logger.info(
    { event: 'job_enqueued', job_type: 'layout.detect_pages', batches: jobIds.length },
    'детекция поставлена пачками',
  );
  return jobIds;
}

/**
 * Пачки ЛОКАЛЬНОЙ детекции (ADR-0008) — ветка `detection.provider='local'`.
 *
 * Одна страница = одна задача: рендер 300 DPI и ONNX-инференс держат ядро и
 * сотни мегабайт, а checkpoint по уже размеченным страницам делает повтор
 * упавшей задачи дешёвым ровно тогда, когда задача маленькая. Потолок пачки
 * RD WEB здесь ни при чём — он был свойством их синхронного API.
 */
export async function enqueueLocalDetectBatches(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly revisionId: string;
    readonly pages: readonly number[];
    readonly overwriteExisting: boolean;
    readonly logger: Logger;
  },
): Promise<{ readonly jobIds: string[]; readonly created: boolean }> {
  const jobIds: string[] = [];
  // Хоть одна новая задача — значит нажатие что-то сделало. Все склеились с
  // прежними — значит детекция уже идёт, и говорить «запущено» было бы неправдой.
  let anyCreated = false;
  for (const pageIndex of input.pages) {
    const { jobId, created } = await enqueueJob(db, scope, {
      type: 'layout.detect_local',
      payload: tracePayload({
        revisionId: input.revisionId,
        layoutRevisionId: input.layoutRevisionId,
        pageIndices: [pageIndex],
        ...(input.overwriteExisting ? { overwriteExisting: true } : {}),
      }),
      dedupeKey: dedupeKeyFor(
        'layout.detect_local',
        input.layoutRevisionId,
        String(pageIndex),
        ...(input.overwriteExisting ? ['overwrite'] : []),
      ),
    });
    jobIds.push(jobId);
    if (created) anyCreated = true;
  }
  input.logger.info(
    {
      event: 'job_enqueued',
      job_type: 'layout.detect_local',
      batches: jobIds.length,
      created: anyCreated,
    },
    'локальная детекция поставлена постранично',
  );
  return { jobIds, created: anyCreated };
}
