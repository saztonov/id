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
import { enqueueJob, reviveFailedJobs } from '../../db/repositories/jobs.js';
import { ensureDraftLayout, pinMarkupPolicy } from '../../db/repositories/layout.js';
import { resetPipelineForRevision } from '../../db/repositories/purge.js';
import {
  readDetectionSettings,
  readImmutabilityEnforced,
  readOrientationProbeSettings,
} from '../../config/portal-settings.js';
import { DETECT_BATCH_LIMIT } from '../../integrations/rdweb/legacy-adapter.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { conflict } from '../../lib/problem.js';
import { tracePayload } from '../../observability/context.js';

/**
 * Сборка рабочего документа с продолжением разметкой.
 *
 * Вызывающих двое, и оба обязаны ставить ОДНУ И ТУ ЖЕ задачу: кнопка
 * «1. Выделить блоки», когда собранного документа ещё нет, и приём файла
 * комплекта, заведённого вместе со своим файлом (S36). Копия этой постановки во
 * втором месте разошлась бы с первым ключом идемпотентности — то есть дала бы
 * вторую сборку того же комплекта.
 *
 * Манифест в ключе: изменившийся состав обязан дать новую задачу, а не слиться с
 * уже стоящей в очереди сборкой прежнего комплекта.
 *
 * Метка `markup` — по той же причине, что `overwrite` у повторной детекции: без
 * неё постановка склеилась бы с уже стоящей сборкой от кнопки «Собрать рабочий
 * документ», и признак `startMarkup` потерялся бы — сборка прошла бы, а разметка
 * не началась. Второй сборки при этом не будет: обработчик переиспользует уже
 * собранный документ того же манифеста.
 */
export async function enqueueMarkupBuild(
  db: Database,
  scope: AuthScope,
  input: {
    readonly revisionId: string;
    readonly aggregateManifestHash: string;
    readonly logger: Logger;
  },
): Promise<{ readonly jobId: string; readonly created: boolean }> {
  const { jobId, created } = await enqueueJob(db, scope, {
    type: 'bundle.build',
    payload: tracePayload({ revisionId: input.revisionId, startMarkup: true }),
    dedupeKey: dedupeKeyFor(
      'bundle.build',
      input.revisionId,
      input.aggregateManifestHash,
      'markup',
    ),
  });

  input.logger.info(
    { event: 'job_enqueued', job_type: 'bundle.build', job_id: jobId, created },
    'сборка рабочего документа поставлена в очередь, за ней пойдёт разметка',
  );

  return { jobId, created };
}

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
  /**
   * Режим читается ЗДЕСЬ, а не приходит аргументом: вызывающих у разметки трое
   * (гранулярный маршрут, кнопка «1. Выделить блоки» и продолжение сборки в
   * воркере), и третий — задача, у которой запроса нет. Забытый аргумент у любого
   * из них означал бы, что одна и та же кнопка ведёт себя по-разному в
   * зависимости от того, через какую дверь вошли.
   */
  const enforceGates = await readImmutabilityEnforced(db);

  /**
   * Настройки детекции читаются ДО создания черновика: правило разметки
   * пиннится на ревизии, а пин — часть её создания (S42).
   *
   * Ветвление провайдера (ADR-0008) читается тем же вызовом и по прежней
   * причине: локальный RF-DETR не создаёт RD-документ и не ходит в RD WEB
   * вовсе. Идущие задачи смену настройки не видят — у них цель уже в payload,
   * а правило — в пине ревизии.
   */
  const detection = await readDetectionSettings(db);

  /**
   * Повторное нажатие поверх распознанного: сначала сброс.
   *
   * `block_results.layout_block_id` объявлен `ON DELETE RESTRICT`, поэтому
   * детекция не смогла бы снести и заменить блок, по которому уже есть результат,
   * — упёрлась бы во внешний ключ посреди импорта. Плюс документы и замечания,
   * выведенные из прежнего текста, после переразметки описывают блоки, которых
   * больше нет.
   */
  if (!enforceGates) {
    await resetPipelineForRevision(db, input.revisionId);
  }

  const { layout, created } = await ensureDraftLayout(db, scope, {
    revisionId: input.revisionId,
    bundleId: input.bundleId,
    enforceGates,
    markupPolicy: detection.markupPolicy,
  });

  /**
   * Правило разметки берётся текущее — но только здесь (S42).
   *
   * Нажатие кнопки стадии и есть решение человека разметить комплект заново, и
   * вместе с этим решением ревизия законно получает сегодняшнее правило. Всё
   * остальное — постраничные задачи детекции, анализ покрытия, заплатка
   * покрытия и экран разметки — читает пин, а не настройку: иначе переключение
   * посреди веера из двухсот задач дало бы ОДНУ ревизию, размеченную двумя
   * правилами, и в базе не осталось бы ничего, чем это объяснить.
   *
   * `ensureDraftLayout` пиннит правило только на НОВОМ черновике; существующий
   * (повторное нажатие, разморозка `superseded`) догоняется здесь.
   */
  const pinned = await pinMarkupPolicy(db, scope, {
    layoutRevisionId: layout.id,
    policy: detection.markupPolicy,
  });
  if (pinned.changed) {
    input.logger.info(
      {
        event: 'layout_policy_pinned',
        layout_revision_id: layout.id,
        sheet_strategy: detection.markupPolicy.sheetStrategy,
        number_zone: detection.markupPolicy.numberZone,
      },
      'правило разметки ревизии обновлено по нажатию кнопки стадии',
    );
  }

  /**
   * Мёртвые задачи этой разметки оживают ДО постановки (S41).
   *
   * Мёртвая задача держит `dedupe_key` — и правильно делает: «мертвеца
   * разбирает человек». Но нажатие этой кнопки и ЕСТЬ решение человека, а
   * конвейер трактовал его как очередную автоматическую постановку: страницы с
   * мёртвыми задачами не получали ничего, потому что `enqueueJob` возвращал
   * существующего мертвеца. Комплект оставался недоразмеченным, и на экране для
   * этого не было причины — счётчик просто стоял.
   *
   * Порядок значим: оживление обязано случиться перед постановкой, иначе
   * дедупликация склеит новую задачу с мертвецом и вернёт `created: false`.
   */
  const revived = await reviveFailedJobs(db, {
    revisionId: input.revisionId,
    stage: 'layout',
    scopeKey: 'layoutRevisionId',
    scopeValue: layout.id,
  });
  if (revived > 0) {
    input.logger.info(
      { event: 'layout_jobs_revived', revived, layout_revision_id: layout.id },
      'мёртвые задачи разметки возвращены в очередь по нажатию кнопки стадии',
    );
  }

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
    const pageMap = await listBundlePages(db, scope, input.bundleId);
    const pages = pageMap.map((page) => page.workingPageIndex);
    if (pages.length === 0) throw conflict('У рабочего документа нет карты страниц.');

    /**
     * Зонд ориентации идёт ПЕРЕД детекцией (ADR-0020).
     *
     * RF-DETR обучен на прямых листах: на боковом он даёт скудную разметку, и
     * табличная зона, оставшаяся без блока, не будет распознана вовсе — её
     * никто не спросит у модели. Поэтому цепочка «зонд → детекция», а не
     * «детекция и когда-нибудь зонд».
     *
     * Детекцию ставит сам зонд, в любом своём исходе. Ставить её здесь ЗАОДНО
     * значило бы поставить дважды — и второй раз без разворота, который зонд
     * ещё не записал.
     */
    const orientation = await readOrientationProbeSettings(db);
    if (orientation.enabled) {
      const probes = await enqueueOrientationProbes(db, scope, {
        layoutRevisionId: layout.id,
        revisionId: input.revisionId,
        bundleId: input.bundleId,
        pages: pageMap.map((page) => ({
          workingPageIndex: page.workingPageIndex,
          sourcePageId: page.sourcePageId,
        })),
        logger: input.logger,
      });
      return {
        layoutRevisionId: layout.id,
        bundleId: input.bundleId,
        created,
        version: layout.version,
        provider: 'local',
        jobIds: probes.jobIds,
        jobsCreated: probes.created,
        detectionSkipReason: null,
      };
    }

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
    // в очереди, черновик может смениться (вытеснение №1 → создание №2), и
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
      priority: pagePriority(100, 60, pageIndex),
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

/**
 * Приоритет страницы: чем дальше страница, тем ниже (S41).
 *
 * Fan-out ставит задачи на все страницы разом, и очередь до сих пор разбирала
 * их строго по времени постановки. Комплект на 220 страниц, запущенный первым,
 * занимал конвейер целиком: второй комплект не двигался вовсе, и на его экране
 * это выглядело как «ничего не происходит» — притом что обгонять первый ему и
 * не нужно, пропускная способность общая.
 *
 * Убывание по десяткам страниц даёт ранним страницам ПОЗДНЕГО комплекта обойти
 * хвост раннего: оба показывают движение, и оператор видит первые распознанные
 * листы обоих, а не одного. Общее время не меняется — меняется наблюдаемость.
 *
 * Нижняя граница нужна, чтобы конвейерные задачи не провалились под фоновые
 * (`preview.cache_pages` — 50, уборка — 10): хвост длинного комплекта остаётся
 * работой, которую ждёт человек.
 */
function pagePriority(base: number, floor: number, pageIndex: number): number {
  return Math.max(floor, base - Math.floor(pageIndex / 10));
}

/**
 * Постановка зондов ориентации ПЕРЕД детекцией (ADR-0020).
 *
 * Одна задача на страницу, и каждая по завершении ставит детекцию своей
 * страницы сама — тем же приёмом, каким `bundle.build` ставит `layout.start`, а
 * `layout.detect_local` ставит `layout.analyze_coverage`. Сцепление, а не
 * задержка: `runAfterMs` был бы догадкой о времени вызова модели, а цепочка —
 * гарантией порядка.
 *
 * `dedupeKey` детекции воркер поставит ТОТ ЖЕ, что поставил бы этот модуль,
 * поэтому повторный проход и путь «зонд выключен» идемпотентны между собой:
 * дважды детекция одной страницы не встанет.
 */
export async function enqueueOrientationProbes(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly revisionId: string;
    readonly bundleId: string;
    readonly pages: readonly { readonly workingPageIndex: number; readonly sourcePageId: string }[];
    readonly logger: Logger;
  },
): Promise<{ readonly jobIds: string[]; readonly created: boolean }> {
  const jobIds: string[] = [];
  let anyCreated = false;
  for (const page of input.pages) {
    const { jobId, created } = await enqueueJob(db, scope, {
      type: 'page.orientation_probe',
      payload: tracePayload({
        revisionId: input.revisionId,
        layoutRevisionId: input.layoutRevisionId,
        bundleId: input.bundleId,
        sourcePageId: page.sourcePageId,
        workingPageIndex: page.workingPageIndex,
      }),
      dedupeKey: dedupeKeyFor(
        'page.orientation_probe',
        input.layoutRevisionId,
        String(page.workingPageIndex),
      ),
      // Зонды идут выше страниц распознавания (150 против 100) — они вход
      // разметки; внутри комплекта порядок задаёт номер страницы.
      priority: pagePriority(150, 110, page.workingPageIndex),
    });
    jobIds.push(jobId);
    if (created) anyCreated = true;
  }
  input.logger.info(
    {
      event: 'job_enqueued',
      job_type: 'page.orientation_probe',
      batches: jobIds.length,
      created: anyCreated,
    },
    'зонд ориентации поставлен постранично; детекцию поставит он же',
  );
  return { jobIds, created: anyCreated };
}
