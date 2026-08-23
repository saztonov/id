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
import { enqueueJob } from '../../db/repositories/jobs.js';
import {
  freezeLayout,
  listLayoutRevisions,
  type LayoutRevisionView,
} from '../../db/repositories/layout.js';
import {
  findRecognitionRun,
  listRecognitionRuns,
  listRunPages,
} from '../../db/repositories/recognition.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { startMarkupOnBundle } from '../layout/start.js';
import { startRecognition } from '../recognition/start.js';
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
          jobId: started.jobIds[0] ?? '',
          jobCreated: started.jobsCreated,
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
        await freezeLayout(app.db, scope, {
          layoutRevisionId: layout.id,
          expectedVersion: layout.version,
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
        throw conflict(
          'Распознавание этой разметки уже идёт. Дождитесь его завершения — ' +
            'анализ и проверки пойдут следом сами.',
        );
      }
      const done = runOfLayout.some((run) => run.status === 'done');
      if (!done) {
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
