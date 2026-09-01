/**
 * Две кнопки S21: «Разметить» и «Проверить».
 *
 * ## Зачем они, если каждая стадия уже имеет свой маршрут
 *
 * До S21 конвейер стоял на шести остановках, и каждую снимал человек: «Собрать
 * рабочий документ» → «Разметить файл» → «Отправить на распознавание» →
 * «Собрать документы» → «Запустить проверку». Устроено это было намеренно
 * (§12: решение о переходе принимает человек), но заказчик посылку снял:
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
 * есть ли разметка, есть ли завершённый прогон распознавания, есть ли
 * логические документы. Счётчик нажатий или поле «текущий шаг» разошлись бы
 * с фактом при первой же упавшей задаче — а конвейер, у которого своё мнение о
 * том, что сделано, хуже конвейера без мнения.
 *
 * Следствие: нажатие повторяемо и безопасно. Упало распознавание — нажали ещё
 * раз, продолжили с распознавания; упали проверки — продолжили с проверок.
 *
 * ## Заморозки разметки больше нет (0048)
 *
 * Прежде «Проверить» по дороге замораживало разметку: распознавание принимало
 * только замороженную. Механизм отменён вместе с самим понятием — блоки правятся
 * всегда, а снимок набора берёт прогон в момент старта. Нажатие от этого не
 * стало беспечнее: оно по-прежнему не идёт поверх незаконченной детекции —
 * в строгом режиме отказывает, в режиме тестирования (ADR-0015) снимает остаток
 * с очереди, потому что «распознать незаконченное выделение» там штатное
 * желание, а не ошибка.
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
  listLayoutRevisions,
  loadProfileForLayout,
  type LayoutRevisionView,
} from '../../db/repositories/layout.js';
import {
  finishRecognitionRun,
  findRecognitionRun,
  hasPublishedRecognition,
  listPagesToRerecognize,
  listRecognitionRuns,
  listRunPages,
} from '../../db/repositories/recognition.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import {
  detectionUnavailableReason,
  enqueueMarkupBuild,
  startMarkupOnBundle,
} from '../layout/start.js';
import { readDetectionSettings, readImmutabilityEnforced } from '../../config/portal-settings.js';
import { assertRecognitionStageReady, startRecognition } from '../recognition/start.js';
import {
  checkRequestSchema,
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
      // Комплекта здесь ещё может не быть, поэтому счётчик крупных листов не
      // передаётся: формулировка отказа станет условной («если в комплекте
      // есть листы крупнее A4»). Точный ответ выдаст `startMarkupOnBundle`
      // после сборки — обещать точность там, где данных нет, хуже.
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

      // Постановка — общей функцией с приёмом файла нового комплекта: обе двери
      // ведут к одной задаче, и разойтись ключам идемпотентности негде.
      const { jobId, created } = await enqueueMarkupBuild(app.db, scope, {
        revisionId,
        aggregateManifestHash: plan.aggregateManifestHash,
        logger: request.log as unknown as Logger,
      });

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
      schema: {
        params: revisionIdParamSchema,
        body: checkRequestSchema,
        response: { 202: checkResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;
      const idempotencyKey = requireIdempotencyKey(request);
      /**
       * Режим повторного нажатия (S40).
       *
       * Тело необязательно: прежние вызывающие его не шлют, и `auto` оставляет
       * им ровно прежнее поведение. Новое — только там, где человек ВЫБРАЛ, что
       * перечитать.
       */
      const mode = request.body?.mode ?? 'auto';

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

      // 1. Нет завершённого распознавания по ЭТОЙ разметке — начинаем с него.
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
      /**
       * Терминальный прогон этой разметки: и родитель восстановления, и ответ
       * на вопрос «есть ли что перечитывать».
       *
       * `integrity_error` донором не бывает — у такого прогона разошлись
       * доказательства, и переносить из него значит тащить дальше расхождение,
       * ради обнаружения которого он и упал.
       */
      const parentRun = runOfLayout.find((run) => run.status === 'failed' || run.status === 'done');

      /**
       * Явный выбор человека перебивает «продолжить с того места, где встали».
       *
       * Без этой ветки оба пункта поповера были бы бесполезны ровно там, где
       * они нужны: на разобранном комплекте `done === true`, и нажатие уходило
       * на прогон правил, ни разу не позвав модель. Пункт «только ошибки» при
       * пустом списке листов сюда и возвращается — но осознанно и с числом в
       * ответе, а не молча.
       */
      const retryPages =
        mode === 'errors'
          ? await listPagesToRerecognize(app.db, scope, {
              revisionId,
              layoutRevisionId: layout.id,
              parentRunId: parentRun?.id ?? null,
            })
          : [];
      const rerecognize = mode === 'full' || (mode === 'errors' && retryPages.length > 0);

      const done =
        !rerecognize &&
        enforceGates &&
        (await hasPublishedRecognition(app.db, scope, {
          revisionId,
          layoutRevisionId: layout.id,
        }));
      if (!done) {
        await assertRecognitionStageReady(app.db, app.env, { requirePublication: true });

        /**
         * Незаконченная детекция: распознавать половину блоков нельзя.
         *
         * Раньше эта проверка стояла в ветке «разметка ещё черновая» рядом с
         * заморозкой. Заморозки нет (0048), но вопрос остался тем же и относится
         * он к СТАРТУ ПРОГОНА: пачки детекции, не выполненные к этому моменту,
         * доложат блоки уже после того, как прогон снял свой снимок набора.
         *
         * Строгий режим отвечает отказом: подождать полминуты дешевле, чем
         * распознавать половину блоков. В режиме тестирования ждать не
         * заставляем — «распознать незаконченное выделение» там штатное
         * желание, — но и мусора не оставляем: остаток снимается с очереди ЯВНО.
         * Пачка, которую воркер уже взял, отменой не остановится и завершится
         * тихо (`detection_batch_obsolete` в `local-detection.ts`).
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
                'Дождитесь окончания и нажмите «2. Распознать» снова — иначе часть ' +
                'блоков не попадёт в прогон.',
            );
          }
          const cancelled = await cancelPendingJobsOfStage(app.db, revisionId, 'layout');
          request.log.info(
            { event: 'detection_cancelled_by_check', revision_id: revisionId, cancelled },
            'остаток выделения блоков снят с очереди нажатием «Распознать»',
          );
        }

        /**
         * Страницы, которые детекция не покрыла, уходят на распознавание целиком.
         *
         * Распознавание идёт по блокам: страница без блока не получает ни
         * строки текста, а дальше её не видит ни классификатор, ни сегментация,
         * и комплект теряет напечатанный на ней документ.
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

        /**
         * Восстановление вместо распознавания с нуля (S28).
         *
         * Упавший прогон этой же разметки оставил после себя результаты — на
         * комплекте, из-за которого правило появилось, 84 блока из 85. Прежде
         * нажатие «Распознать» начинало всё заново и платило за них второй раз;
         * теперь новый прогон объявляется восстанавливающим, а совместимые
         * результаты переносит `vlm.start_recognition` до первого вызова
         * модели. Совместимость он же и решает: разошлись модель, промпт,
         * растеризатор или рабочий документ — блок распознаётся заново.
         *
         * Берётся ПОСЛЕДНИЙ терминальный прогон (`parentRun` выше): список
         * отсортирован по времени старта.
         *
         * Пункт «Распознать полностью» (S40) переносом не пользуется: он и
         * означает «прежний результат больше не описывает то, что получится
         * сейчас». Поэтому родителя у него нет, а прежнее производное сносится
         * — иначе документы и замечания указывали бы на блоки с другими
         * идентификаторами, то есть выглядели бы целыми и врали.
         */
        const repairOf = mode === 'full' ? null : (parentRun?.id ?? null);

        if (
          mode === 'full' ||
          (!enforceGates && runOfLayout.length > 0 && parentRun === undefined)
        ) {
          // Прежние результаты по этой разметке больше не описывают то, что
          // получится сейчас: сносим их до старта, а не «поверх». На пути
          // восстановления сброса нет — он снёс бы ровно то, что переносится.
          await resetPipelineForRevision(app.db, revisionId);
        }
        const started = await startRecognition(app.db, app.env, scope, {
          revisionId,
          layoutId: layout.id,
          idempotencyKey,
          autoContinue: true,
          repairOfRunId: repairOf,
          ...(mode === 'errors' ? { retryPages } : {}),
        });
        return reply.code(202).send({
          stage: 'recognition',
          recognitionRunId: started.recognitionRunId,
          jobId: started.jobId,
          retriedPages: mode === 'errors' ? retryPages.length : 0,
          jobCreated: started.jobCreated,
          repairOfRunId: repairOf,
        });
      }

      // 2. Распознано, но документов нет — начинаем с анализа.
      const documents = await listLogicalDocuments(app.db, scope, revisionId);
      if (documents.length === 0) {
        const { jobId, created } = await enqueueJob(app.db, scope, {
          type: 'doc.classify_pages',
          payload: tracePayload({ revisionId, autoContinue: true }),
          dedupeKey: dedupeKeyFor('doc.classify_pages', revisionId, idempotencyKey),
        });
        return reply.code(202).send({
          stage: 'analysis',
          recognitionRunId: null,
          jobId,
          jobCreated: created,
          retriedPages: 0,
        });
      }

      // 3. Всё готово к правилам. Сюда же приходит осознанный повтор после
      //    правки реквизитов: прогон правил дёшев и детерминирован.
      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'checks.run',
        payload: tracePayload({ revisionId }),
        dedupeKey: dedupeKeyFor('checks.run', revisionId, idempotencyKey),
      });
      return reply.code(202).send({
        stage: 'checks',
        recognitionRunId: null,
        jobId,
        jobCreated: created,
        // «Только ошибки» на комплекте без ошибок доходит сюда: перечитывать
        // нечего, и прогон продолжается правилами. Ноль в ответе отличает это
        // от бездействия кнопки.
        retriedPages: 0,
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

/** `settings_snapshot.repair.blocksReused` — сколько блоков перенесено (S28). */
function reusedBlocksOf(settingsSnapshot: unknown): number {
  if (typeof settingsSnapshot !== 'object' || settingsSnapshot === null) return 0;
  const repair = (settingsSnapshot as Record<string, unknown>)['repair'];
  if (typeof repair !== 'object' || repair === null) return 0;
  const reused = (repair as Record<string, unknown>)['blocksReused'];
  return typeof reused === 'number' ? reused : 0;
}

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
        recoveryRound: run.recoveryRound,
        repairOfRunId: run.repairOfRunId,
        // Счёт ведёт `vlm.start_recognition` при переносе: экрану важно, что
        // часть блоков не стоила ни одного вызова модели, — без этого числа
        // восстановление выглядит обычным прогоном, который подозрительно
        // быстро дошёл до конца.
        blocksReused: reusedBlocksOf(run.settingsSnapshot),
      });
    },
  );
}
