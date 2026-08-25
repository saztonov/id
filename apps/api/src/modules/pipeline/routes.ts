/**
 * Две кнопки S21: «Разметить» и «Проверить».
 *
 * ## Зачем они, если каждая стадия уже имеет свой маршрут
 *
 * До S21 конвейер стоял на шести остановках, и каждую снимал человек: «Собрать
 * рабочий документ» → «Разметить файл» → «Заморозить разметку» → «Отправить на
 * распознавание» → «Собрать документы» → «Запустить проверку». Устроено это
 * было намеренно (§12: решение о переходе принимает человек), но заказчик
 * посылку снял:
 *
 * > «Пользователь просто нажимает проверить, а сайт сначала разбивает на
 * > блоки/кропы, потом кропы отправляет на распознавание, а потом распознанный
 * > текст — на анализ, сопоставление, поиск ошибок.»
 *
 * Остановка осталась ровно одна и ровно там, где человек действительно нужен:
 * между детекцией блоков и распознаванием он правит разметку. Отсюда две
 * кнопки, а не одна и не шесть.
 *
 * ## Почему «Проверить» смотрит на состояние, а не помнит шаг
 *
 * Маршрут определяет, с чего продолжить, по фактическому состоянию ревизии:
 * есть ли замороженная разметка, есть ли завершённый прогон распознавания, есть
 * ли логические документы. Счётчик нажатий или поле «текущий шаг» разошлись бы
 * с фактом при первой же упавшей задаче — а конвейер, у которого своё мнение о
 * том, что сделано, хуже конвейера без мнения.
 *
 * Следствие: нажатие повторяемо и безопасно. Упало распознавание — нажали ещё
 * раз, продолжили с распознавания; упали проверки — продолжили с проверок.
 *
 * ## Заморозка выполняется молча, и это решение
 *
 * Распознавание идёт по ЗАМОРОЖЕННОЙ разметке (гейт `blocks_hash`, ADR-0007),
 * поэтому «Проверить» без заморозки невозможно в принципе. Спрашивать
 * подтверждение значило бы возвращать шестую кнопку под видом диалога: человек
 * уже сказал, что правку закончил, — он нажал «Проверить». Необратимой заморозка
 * при этом не является: исправление — новая ревизия разметки, и этот путь
 * остался как был.
 *
 * Молча — да, но не поверх незаконченной работы первой кнопки: нажатие, сделанное
 * слишком рано, обесценивает всю ещё не выполненную детекцию. В строгом режиме
 * заморозка при незакончившейся разметке отказывает; в режиме тестирования
 * (ADR-0015) — снимает остаток с очереди и идёт дальше, потому что «распознать
 * незаконченное выделение» там штатное желание, а не ошибка.
 *
 * ## Права
 *
 * Обе кнопки — `pipeline.run` (все пять ролей). Это ОДНО действие, и
 * авторизуется оно один раз; гранулярные маршруты своих прав не теряют и
 * остаются ручным путём инженера. Область видимости применяется в репозиториях
 * на каждом чтении, как и везде.
 */
import type { Logger } from 'pino';

import type { AppInstance } from '../../app.js';
import { conflict, notFound } from '../../lib/problem.js';
import { requireIdempotencyKey } from '../../lib/http-headers.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import { assertPlanBuildable, listBundles, loadBundlePlan } from '../../db/repositories/bundles.js';
import { listLogicalDocuments } from '../../db/repositories/documents.js';
import { findRevisionForFiles } from '../../db/repositories/files.js';
import {
  cancelPendingJobsOfStage,
  computeProcessingStatus,
  enqueueJob,
} from '../../db/repositories/jobs.js';
import { resetPipelineForRevision } from '../../db/repositories/purge.js';
import {
  applyTextCoverageFallback,
  FALLBACK_LAYOUT_THRESHOLDS,
  freezeLayout,
  listLayoutRevisions,
  loadProfileForLayout,
  type LayoutRevisionView,
} from '../../db/repositories/layout.js';
import {
  finishRecognitionRun,
  findRecognitionRun,
  hasPublishedRecognition,
  listRecognitionRuns,
  listRunPages,
} from '../../db/repositories/recognition.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { detectionUnavailableReason, startMarkupOnBundle } from '../layout/start.js';
import { readDetectionSettings, readImmutabilityEnforced } from '../../config/portal-settings.js';
import { assertRecognitionStageReady, startRecognition } from '../recognition/start.js';
import {
  checkResponseSchema,
  recognitionProgressSchema,
  revisionIdParamSchema,
  runIdParamSchema,
  startMarkupPipelineResponseSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const runPipeline = requirePermission('pipeline.run');
const readPipeline = requirePermission('markup.read');

export function registerPipelineRoutes(app: AppInstance): void {
  registerMarkupRoute(app);
  registerCheckRoute(app);
  registerProgressRoute(app);
}

// =====================================================================
// Кнопка «Разметить»
// =====================================================================

/**
 * Сборка рабочего документа и детекция блоков одним нажатием.
 *
 * Разметка ложится на страницы рабочего документа, поэтому порядок здесь не
 * выбирается: сначала сборка. Если она уже сделана — детекция ставится тут же;
 * если нет — ставится `bundle.build` с признаком «продолжить разметкой», и
 * продолжение делает звено `layout.start`. Двух путей в интерфейсе от этого не
 * возникает: пользователь в обоих случаях нажал одну кнопку и увидел «идёт».
 */
function registerMarkupRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/markup`,
    {
      preHandler: runPipeline,
      schema: {
        params: revisionIdParamSchema,
        response: { 202: startMarkupPipelineResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      const plan = await loadBundlePlan(app.db, scope, revisionId);
      if (plan === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ revisionId, objectId: plan.objectId });

      // Препятствия проверяются ДО очереди: «файл в карантине» — это ответ
      // пользователю сейчас, а не задача, которая через минуту упадёт в консоли
      // с тем же текстом.
      assertPlanBuildable(plan);

      // Настройка детекции читается ЗДЕСЬ, а не только внутри
      // `startMarkupOnBundle`, и это не дубль проверки. Веток две: рабочий
      // документ уже собран — и тогда `startMarkupOnBundle` отработает
      // синхронно, признак вернётся сам; не собран — и тогда та же функция
      // отработает в воркере, где отвечать пользователю уже некому. Ответ «идёт
      // детекция» в этом случае оказался бы ложью, обнаруживаемой минутой позже
      // и только в консоли задач.
      const detectionSkipReason = detectionUnavailableReason(await readDetectionSettings(app.db));

      const bundles = await listBundles(app.db, scope, revisionId);
      const bundle = bundles[bundles.length - 1];

      // «Тот же состав» — это совпадение манифеста. Собранный документ ДРУГОГО
      // состава непригоден: пользователь догрузил файл и нажал «Разметить»
      // именно ради него.
      if (bundle !== undefined && bundle.aggregateManifestHash === plan.aggregateManifestHash) {
        const started = await startMarkupOnBundle(app.db, scope, {
          revisionId,
          bundleId: bundle.id,
          previewCached: app.env.PREVIEW_MODE === 'cached',
          logger: request.log as unknown as Logger,
        });
        return reply.code(202).send({
          bundleReady: true,
          bundleId: started.bundleId,
          layoutRevisionId: started.layoutRevisionId,
          jobId: started.jobIds[0] ?? null,
          jobCreated: started.jobsCreated,
          detectionSkipped: started.detectionSkipReason !== null,
          detectionSkipReason: started.detectionSkipReason,
        });
      }

      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'bundle.build',
        payload: tracePayload({ revisionId, startMarkup: true }),
        // Манифест в ключе: изменившийся состав обязан дать новую задачу, а не
        // слиться с уже стоящей в очереди сборкой прежнего комплекта.
        //
        // Метка `markup` — по той же причине, что `overwrite` у повторной
        // детекции: без неё нажатие «Разметить» склеилось бы с уже стоящей
        // сборкой от кнопки «Собрать рабочий документ», и признак `startMarkup`
        // потерялся бы — сборка прошла бы, а разметка не началась. Второй
        // сборки при этом не будет: обработчик переиспользует уже собранный
        // документ того же манифеста.
        dedupeKey: dedupeKeyFor('bundle.build', revisionId, plan.aggregateManifestHash, 'markup'),
      });

      request.log.info(
        { event: 'job_enqueued', job_type: 'bundle.build', job_id: jobId, created },
        'сборка рабочего документа поставлена в очередь, за ней пойдёт разметка',
      );

      return reply.code(202).send({
        bundleReady: false,
        bundleId: null,
        layoutRevisionId: null,
        jobId,
        jobCreated: created,
        // Сборка идёт в любом случае — рабочий документ нужен и для ручной
        // разметки. Предупредить о ненастроенной детекции надо сейчас: за
        // сборкой пойдёт `layout.start`, и там объяснять будет уже некому.
        detectionSkipped: detectionSkipReason !== null,
        detectionSkipReason,
      });
    },
  );
}

// =====================================================================
// Кнопка «Проверить»
// =====================================================================

function registerCheckRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/check`,
    {
      preHandler: runPipeline,
      schema: { params: revisionIdParamSchema, response: { 202: checkResponseSchema } },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const { revisionId } = request.params;
      const idempotencyKey = requireIdempotencyKey(request);

      // Ревизия разрешается ПЕРВОЙ, до любого суждения о её состоянии. Иначе
      // чужая ревизия получала бы 409 «разметки нет» — то есть ответ о
      // состоянии данных, которых спрашивающий видеть не вправе. Область
      // отдаёт пустой список разметок одинаково и для чужой ревизии, и для
      // неразмеченной, и различить их без этого чтения нечем.
      const revision = await findRevisionForFiles(app.db, scope, revisionId);
      if (revision === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ revisionId, objectId: revision.objectId });

      // Строгий режим (ADR-0015). Читается один раз на нажатие: два чтения по
      // ходу обработки могли бы застать разные значения, и одно нажатие повело бы
      // себя наполовину строго, наполовину мягко.
      const enforceGates = await readImmutabilityEnforced(app.db);

      const layouts = await listLayoutRevisions(app.db, scope, revisionId);
      const layout = latestUsableLayout(layouts);
      if (layout === null) {
        throw conflict(
          'Проверять нечего: разметки у ревизии нет. Сначала нажмите «Разметить» — ' +
            'портал соберёт рабочий документ и разметит страницы.',
        );
      }

      // 1. Разметка ещё черновая. Заморозка — часть нажатия, а не отдельный
      //    вопрос: распознавание идёт только по замороженной (гейт blocks_hash).
      let frozen = false;
      if (layout.state === 'draft') {
        /**
         * Оба отказа ниже — ДО заморозки, и это не стилистика.
         *
         * Заморозка необратима для этой ревизии разметки: после неё правка блоков
         * закрыта, и вернуться можно только новой ревизией разметки. Отказ после
         * заморозки оставил бы ревизию замороженной ни за что — черновая разметка
         * ЧЕРНОВАЯ ровно затем, чтобы человек мог её ещё поправить.
         *
         * Готовность стадии спрашивается здесь, хотя её же спросит
         * `startRecognition`: черновая разметка означает, что замороженной нет, а
         * значит нет и завершённого прогона по ней, — распознавание будет запущено
         * наверняка.
         */
        await assertRecognitionStageReady(app.db, app.env, { requirePublication: true });

        /**
         * И не поверх незаконченной работы предыдущей кнопки.
         *
         * Детекция отказывается писать результаты в замороженную разметку, поэтому
         * заморозка под идущей детекцией обесценивает КАЖДУЮ ещё не выполненную
         * постраничную пачку — а их у комплекта десятки.
         *
         * Строгий режим отвечает отказом: подождать полминуты дешевле, чем
         * распознавать половину блоков. В режиме тестирования ждать не заставляем —
         * «распознать незаконченное выделение» там штатное желание, — но и мусора
         * не оставляем: остаток снимается с очереди ЯВНО. Пачка, которую воркер уже
         * взял, отменой не остановится и завершится тихо (`detection_batch_obsolete`
         * в `local-detection.ts`), а не отказом.
         *
         * Стадия, а не список типов задач: типов детекции больше одного, и
         * четвёртый добавили бы, не вспомнив про это место.
         */
        const status = await computeProcessingStatus(app.db, scope, revisionId);
        const layoutStage = status?.stages.find((summary) => summary.stage === 'layout');
        // `pending` не считает мёртвые задачи: исчерпавшая попытки детекция не
        // имеет права запереть кнопку навсегда.
        if (layoutStage !== undefined && layoutStage.pending > 0) {
          if (enforceGates) {
            throw conflict(
              `Выделение блоков ещё идёт: осталось задач ${String(layoutStage.pending)}. ` +
                'Заморозка разметки прямо сейчас отменила бы их результаты — дождитесь ' +
                'окончания и нажмите «2. Распознать» снова.',
            );
          }
          const cancelled = await cancelPendingJobsOfStage(app.db, revisionId, 'layout');
          request.log.info(
            { event: 'detection_cancelled_by_check', revision_id: revisionId, cancelled },
            'остаток выделения блоков снят с очереди нажатием «Распознать»',
          );
        }

        /**
         * Страницы, которые детекция не покрыла, уходят на распознавание
         * целиком — ДО заморозки и только здесь.
         *
         * Распознавание идёт по блокам: страница без блока не получает ни
         * строки текста, а дальше её не видит ни классификатор, ни сегментация,
         * и комплект теряет напечатанный на ней документ. После заморозки
         * поправить это уже нельзя — блоки заперты триггером.
         *
         * Именно здесь, а не в `layout.analyze_coverage`: тот идёт после КАЖДОЙ
         * пачки детекции и судил бы «пусто» о странице, до которой детекция ещё
         * не дошла. Маршрут — единственное место, где стадия разметки
         * гарантированно затихла: несколькими строками выше он либо отказывает
         * при незаконченной детекции, либо снимает её остаток.
         *
         * Пороги берутся из профиля, запиненного ЭТОЙ ревизией разметки, а не
         * из настройки портала: расчёт обязан воспроизводиться вместе с
         * прогоном.
         */
        const profile = await loadProfileForLayout(app.db, layout.layoutProfileId);
        const fallback = await applyTextCoverageFallback(app.db, scope, {
          layoutRevisionId: layout.id,
          expectedVersion: layout.version,
          thresholds: profile?.thresholds ?? FALLBACK_LAYOUT_THRESHOLDS,
        });
        if (fallback.pages.length > 0) {
          request.log.info(
            {
              event: 'text_fallback_applied',
              layout_revision_id: layout.id,
              pages: fallback.pages,
            },
            'страницы без разметки уходят на распознавание целиком',
          );
        }

        await freezeLayout(app.db, scope, {
          // Версия — та, что вернул фолбэк: он поднимает её вставкой блоков, и
          // заморозка по прочитанной раньше ответила бы 412 «разметка
          // изменилась» — на изменение, сделанное этим же нажатием.
          layoutRevisionId: layout.id,
          expectedVersion: fallback.version,
          actorUserId: user.id,
        });
        frozen = true;
        request.log.info(
          { event: 'layout_frozen', layout_revision_id: layout.id, reason: 'check_button' },
          'разметка заморожена нажатием «Проверить»',
        );
      }

      // 2. Нет завершённого распознавания по ЭТОЙ разметке — начинаем с него.
      const runs = await listRecognitionRuns(app.db, scope, revisionId);
      const runOfLayout = runs.filter((run) => run.layoutRevisionId === layout.id);
      const active = runOfLayout.find((run) => run.status === 'running');
      if (active !== undefined) {
        if (enforceGates) {
          throw conflict(
            'Распознавание этой разметки уже идёт. Дождитесь его завершения — ' +
              'анализ и проверки пойдут следом сами.',
          );
        }
        /**
         * «Повторное распознавание просто заменяет предыдущее»: идущий прогон
         * закрывается, его страницы и результаты снесены сбросом ниже, новый
         * стартует с нуля. Задачи прежнего прогона доживут свою попытку и
         * остановятся на гейте «прогон уже завершён» — их результаты писать
         * некуда, потому что строк прогона больше нет.
         */
        await finishRecognitionRun(app.db, scope, {
          runId: active.id,
          status: 'failed',
          reason: 'заменён новым запуском распознавания',
        });
        request.log.info(
          { event: 'recognition_run_superseded', revision_id: revisionId, run_id: active.id },
          'идущий прогон распознавания закрыт нажатием «Распознать»',
        );
      }
      /**
       * «Распознано» — это ОПУБЛИКОВАНО, а не «прогон закрыт со статусом done».
       *
       * Прогон в режиме dry-run (ADR-0007) проходит весь путь и завершается
       * честным `done`, не опубликовав ни строки. Считая его пройденной
       * стадией, маршрут уходил к шагу 3 — к анализу, которому нечего читать, —
       * и цепочка обрывалась на «завершённого прогона распознавания нет» уже
       * внутри задачи, то есть в консоли, а не на экране.
       */
      const done =
        enforceGates &&
        (await hasPublishedRecognition(app.db, scope, {
          revisionId,
          layoutRevisionId: layout.id,
        }));
      if (!done) {
        // Гейт спрашивается ЕЩЁ РАЗ и безусловно: ветка выше срабатывает только
        // на черновой разметке, а сюда приходят и с уже замороженной — например
        // после dry-run, который разметку заморозил, но ничего не опубликовал.
        await assertRecognitionStageReady(app.db, app.env, { requirePublication: true });

        if (!enforceGates && runOfLayout.length > 0) {
          // Прежние результаты по этой разметке больше не описывают то, что
          // получится сейчас: сносим их до старта, а не «поверх».
          await resetPipelineForRevision(app.db, revisionId);
        }
        const started = await startRecognition(app.db, app.env, scope, {
          revisionId,
          frozenLayoutId: layout.id,
          idempotencyKey,
          autoContinue: true,
        });
        return reply.code(202).send({
          stage: 'recognition',
          frozen,
          recognitionRunId: started.recognitionRunId,
          jobId: started.jobId,
          jobCreated: started.jobCreated,
        });
      }

      // 3. Распознано, но документов нет — начинаем с анализа.
      const documents = await listLogicalDocuments(app.db, scope, revisionId);
      if (documents.length === 0) {
        const { jobId, created } = await enqueueJob(app.db, scope, {
          type: 'doc.classify_pages',
          payload: tracePayload({ revisionId, autoContinue: true }),
          dedupeKey: dedupeKeyFor('doc.classify_pages', revisionId, idempotencyKey),
        });
        return reply.code(202).send({
          stage: 'analysis',
          frozen,
          recognitionRunId: null,
          jobId,
          jobCreated: created,
        });
      }

      // 4. Всё готово к правилам. Сюда же приходит осознанный повтор после
      //    правки реквизитов: прогон правил дёшев и детерминирован.
      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'checks.run',
        payload: tracePayload({ revisionId }),
        dedupeKey: dedupeKeyFor('checks.run', revisionId, idempotencyKey),
      });
      return reply.code(202).send({
        stage: 'checks',
        frozen,
        recognitionRunId: null,
        jobId,
        jobCreated: created,
      });
    },
  );
}

/**
 * Разметка, по которой пойдёт проверка.
 *
 * Берётся ПОСЛЕДНЯЯ не-`superseded`: список отсортирован по `revision_no`, а
 * заменённые ревизии разметки существуют ради истории и распознаванию не
 * подлежат. Пустой список означает, что разметку ещё не запускали.
 */
function latestUsableLayout(layouts: readonly LayoutRevisionView[]): LayoutRevisionView | null {
  for (let i = layouts.length - 1; i >= 0; i -= 1) {
    const layout = layouts[i];
    if (layout !== undefined && layout.state !== 'superseded') return layout;
  }
  return null;
}

// =====================================================================
// Прогресс распознавания
// =====================================================================

/**
 * Постраничный прогресс VLM-прогона.
 *
 * `recognition_run_pages` заполняется с S12, но наружу не отдавался ни одним
 * маршрутом: экран знал только «прогон идёт». Пока стадий было шесть и каждую
 * начинал человек, это терпелось; с одной кнопкой «идёт» без числа страниц
 * означает «неизвестно, работает ли вообще» — на комплекте в двести листов
 * распознавание занимает десятки минут.
 *
 * Сводка считается здесь, а не в SQL: строк ровно столько, сколько страниц в
 * комплекте, и отдельный агрегирующий запрос ради сотни строк добавил бы второй
 * источник тех же чисел.
 */
function registerProgressRoute(app: AppInstance): void {
  app.get(
    `${PREFIX}/recognition-runs/:runId/progress`,
    {
      preHandler: readPipeline,
      schema: { params: runIdParamSchema, response: { 200: recognitionProgressSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { runId } = request.params;

      const run = await findRecognitionRun(app.db, scope, runId);
      if (run === null) throw notFound('Прогон распознавания не найден.');
      updateContext({ revisionId: run.revisionId, objectId: run.objectId });

      const pages = await listRunPages(app.db, scope, runId);
      const sum = (pick: (page: (typeof pages)[number]) => number): number =>
        pages.reduce((total, page) => total + pick(page), 0);

      return reply.code(200).send({
        recognitionRunId: runId,
        status: run.status,
        pagesTotal: pages.length,
        pagesDone: pages.filter((page) => page.status === 'done').length,
        pagesFailed: pages.filter((page) => page.status === 'failed').length,
        pagesPending: pages.filter((page) => page.status === 'pending').length,
        blocksTotal: sum((page) => page.blocksTotal),
        blocksRecognized: sum((page) => page.blocksRecognized),
        blocksInvalid: sum((page) => page.blocksInvalid),
        blocksRefused: sum((page) => page.blocksRefused),
      });
    },
  );
}
