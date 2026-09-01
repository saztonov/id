/**
 * Разметка: старт цепочки, чтение и правка блоков (§6.1, §7, §14).
 *
 * ## Кнопка «Разметить файл» ставит задачу, а не отвечает 202 в пустоту
 *
 * Это прямой урок S5: там обработчики задач 1–3 были написаны, зарегистрированы
 * и покрыты тестами, а в очередь их не клал никто — конвейер §12 не запускался
 * вовсе, и все тесты при этом были зелёными. Поэтому `POST .../layout` создаёт
 * черновик разметки И кладёт строку в `jobs`, а тест проверяет именно таблицу
 * `jobs`, а не код ответа.
 *
 * ## Оптимистичная блокировка
 *
 * Единица конфликта — ревизия разметки целиком, а не блок: пользователь двигает
 * рамку, второй в это время удаляет соседнюю, и «мой блок не менялся» ничего не
 * говорит о том, что набор страницы уже другой. `ETag` = версия ревизии
 * разметки, `If-Match` обязателен на каждой мутации, конфликт даёт 412 — на нём
 * клиент перечитывает и показывает сравнение версий (§7.2), а не молча
 * перезаписывает.
 *
 * ## Права
 *
 * Чтение — `markup.read` (видят все роли в пределах своей области), правка —
 * `markup.edit` (подрядчик и инженер). Область видимости применяется в
 * репозитории на КАЖДОМ пути: подрядчик не видит чужую разметку ни списком, ни
 * по прямому идентификатору.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppInstance } from '../../app.js';
import { conflict, notFound } from '../../lib/problem.js';
import { requireIfMatch } from '../../lib/http-headers.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { updateContext } from '../../observability/context.js';
import { listBundlePages, listBundles } from '../../db/repositories/bundles.js';
import {
  applyFullPageTextProfile,
  createLayoutBlock,
  deleteLayoutBlock,
  findLayoutRevision,
  listLayoutBlocks,
  listLayoutRevisions,
  listPageAttentionFlags,
  replacePageWithFullPageBlock,
  updateLayoutBlock,
  type LayoutRevisionView,
} from '../../db/repositories/layout.js';
import {
  clearManualPageOrientation,
  findPageOrientation,
  saveManualPageOrientation,
} from '../../db/repositories/page-orientation.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import { readDetectionSettings, readImmutabilityEnforced } from '../../config/portal-settings.js';
import { enqueueDetectBatches, enqueueLocalDetectBatches, startMarkupOnBundle } from './start.js';
import {
  blockCreateSchema,
  blockMutationResponseSchema,
  blockParamSchema,
  blockUpdateSchema,
  detectRequestSchema,
  detectResponseSchema,
  fullPageTextResponseSchema,
  layoutBlockListSchema,
  layoutDetailSchema,
  layoutIdParamSchema,
  layoutListSchema,
  orientationParamSchema,
  orientationRequestSchema,
  orientationResponseSchema,
  pageParamSchema,
  pageQuerySchema,
  folderIdParamSchema,
  startMarkupResponseSchema,
  versionResponseSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const readMarkup = requirePermission('markup.read');
const editMarkup = requirePermission('markup.edit');

export function registerLayoutRoutes(app: AppInstance): void {
  registerStartRoute(app);
  registerReadRoutes(app);
  registerBlockRoutes(app);
  registerPageRoutes(app);
  registerOrientationRoutes(app);
}

/** Данные актора для `audit_log`: то, что знает только слой HTTP. */
function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

// =====================================================================
// Версия как ETag
// =====================================================================

function toView(layout: LayoutRevisionView) {
  return {
    id: layout.id,
    folderId: layout.folderId,
    bundleId: layout.bundleId,
    revisionNo: layout.revisionNo,
    state: layout.state as 'draft' | 'superseded',
    blocksHash: layout.blocksHash,
    version: layout.version,
    detectorProfile: layout.detectorProfile as 'rf_detr' | 'full_page',
    manuallyEdited: layout.firstManualEditAt !== null,
    markupPolicy: layout.markupPolicy,
    createdAt: layout.createdAt,
  };
}

function withVersion(reply: FastifyReply, version: number): FastifyReply {
  return reply.header('etag', `"${version}"`);
}

// =====================================================================
// Старт цепочки «Разметить файл»
// =====================================================================

function registerStartRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/folders/:folderId/layout`,
    {
      preHandler: editMarkup,
      schema: {
        params: folderIdParamSchema,
        response: { 202: startMarkupResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { folderId } = request.params;

      // Рабочий документ обязан существовать: разметка ложится на его страницы,
      // а не на исходные файлы. Отсутствие bundle — это ответ пользователю
      // сейчас («сначала соберите рабочий документ»), а не задача, которая
      // упадёт через минуту с тем же текстом.
      //
      // Кнопка S21 «Разметить» (`POST /folders/{id}/markup`) этого отказа не
      // видит: она сама ставит сборку и продолжает разметкой. Здесь он остаётся
      // потому, что это ГРАНУЛЯРНЫЙ маршрут ручного пути — он делает ровно то,
      // что назвали, и молча делать за пользователя ещё и сборку не должен.
      const bundles = await listBundles(app.db, scope, folderId);
      const bundle = bundles[bundles.length - 1];
      if (bundle === undefined) {
        throw conflict(
          'Разметку нельзя начать: рабочий документ ревизии ещё не собран ' +
            '(POST /folders/{id}/bundle).',
        );
      }
      updateContext({ folderId });

      const started = await startMarkupOnBundle(app.db, scope, {
        folderId,
        bundleId: bundle.id,
        previewCached: app.env.PREVIEW_MODE === 'cached',
        logger: request.log as unknown as Logger,
      });

      return withVersion(reply, started.version)
        .code(202)
        .send({
          layoutRevisionId: started.layoutRevisionId,
          bundleId: started.bundleId,
          created: started.created,
          // Схема ответа отдаёт одну задачу; у локальной ветки их страница к
          // странице — наружу уходит первая, остальные видны в консоли задач.
          jobId: started.jobIds[0] ?? '',
          jobCreated: started.jobsCreated,
        });
    },
  );
}

// =====================================================================
// Чтение
// =====================================================================

function registerReadRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/folders/:folderId/layouts`,
    {
      preHandler: readMarkup,
      schema: { params: folderIdParamSchema, response: { 200: layoutListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listLayoutRevisions(app.db, scope, request.params.folderId);
      return reply.code(200).send({ items: items.map(toView) });
    },
  );

  app.get(
    `${PREFIX}/layouts/:layoutId`,
    {
      preHandler: readMarkup,
      schema: { params: layoutIdParamSchema, response: { 200: layoutDetailSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const layout = await findLayoutRevision(app.db, scope, request.params.layoutId);
      if (layout === null) throw notFound('Ревизия разметки не найдена.');
      updateContext({ folderId: layout.folderId, objectId: layout.objectId });

      const [flags, blocks] = await Promise.all([
        listPageAttentionFlags(app.db, scope, layout.bundleId),
        listLayoutBlocks(app.db, scope, layout.id),
      ]);

      return withVersion(reply, layout.version)
        .code(200)
        .send({
          ...toView(layout),
          pages: flags.map((page) => ({
            workingPageIndex: page.workingPageIndex,
            flags: [...page.flags],
          })),
          blockCount: blocks.length,
        });
    },
  );

  app.get(
    `${PREFIX}/layouts/:layoutId/blocks`,
    {
      preHandler: readMarkup,
      schema: {
        params: layoutIdParamSchema,
        querystring: pageQuerySchema,
        response: { 200: layoutBlockListSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const layout = await findLayoutRevision(app.db, scope, request.params.layoutId);
      if (layout === null) throw notFound('Ревизия разметки не найдена.');

      const items = await listLayoutBlocks(
        app.db,
        scope,
        layout.id,
        request.query.workingPageIndex,
      );
      return withVersion(reply, layout.version)
        .code(200)
        .send({
          layoutRevisionId: layout.id,
          version: layout.version,
          items: items.map((block) => ({
            id: block.id,
            layoutRevisionId: block.layoutRevisionId,
            sourcePageId: block.sourcePageId,
            workingPageIndex: block.workingPageIndex,
            blockType: block.blockType,
            shapeType: block.shapeType,
            coords: { x0: block.x0, y0: block.y0, x1: block.x1, y1: block.y1 },
            points: block.points.map((point) => ({ x: point.x, y: point.y })),
            sortOrder: block.sortOrder,
            source: block.source,
            detectorProvenance: block.detectorProvenance,
            detectionScore: block.detectionScore,
          })),
        });
    },
  );
}

// =====================================================================
// Блоки
// =====================================================================

function registerBlockRoutes(app: AppInstance): void {
  app.post(
    `${PREFIX}/layouts/:layoutId/blocks`,
    {
      preHandler: editMarkup,
      schema: {
        params: layoutIdParamSchema,
        body: blockCreateSchema,
        response: { 201: blockMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request, 'разметки');
      const body = request.body;

      const result = await createLayoutBlock(app.db, scope, {
        layoutRevisionId: request.params.layoutId,
        expectedVersion,
        actorUserId: user.id,
        workingPageIndex: body.workingPageIndex,
        blockType: body.blockType,
        shapeType: body.shapeType,
        x0: body.coords.x0,
        y0: body.coords.y0,
        x1: body.coords.x1,
        y1: body.coords.y1,
        points: body.points,
      });
      return withVersion(reply, result.version).code(201).send(result);
    },
  );

  app.patch(
    `${PREFIX}/layouts/:layoutId/blocks/:blockId`,
    {
      preHandler: editMarkup,
      schema: {
        params: blockParamSchema,
        body: blockUpdateSchema,
        response: { 200: blockMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request, 'разметки');
      const body = request.body;

      const result = await updateLayoutBlock(app.db, scope, {
        blockId: request.params.blockId,
        layoutRevisionId: request.params.layoutId,
        expectedVersion,
        actorUserId: user.id,
        blockType: body.blockType,
        shapeType: body.shapeType,
        coords: body.coords,
        points: body.points,
        sortOrder: body.sortOrder,
      });
      return withVersion(reply, result.version).code(200).send(result);
    },
  );

  app.delete(
    `${PREFIX}/layouts/:layoutId/blocks/:blockId`,
    {
      preHandler: editMarkup,
      schema: { params: blockParamSchema, response: { 200: versionResponseSchema } },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request, 'разметки');
      const result = await deleteLayoutBlock(app.db, scope, {
        blockId: request.params.blockId,
        layoutRevisionId: request.params.layoutId,
        expectedVersion,
        actorUserId: user.id,
      });
      return withVersion(reply, result.version).code(200).send(result);
    },
  );
}

// =====================================================================
// Действия над страницей и повторная детекция
// =====================================================================

function registerPageRoutes(app: AppInstance): void {
  /**
   * Замена страницы одним TEXT-блоком.
   *
   * Отдельный маршрут, а не флаг детекции: автоматически полностраничный блок
   * не добавляется НИКОГДА (§5.3). Пользователь видит флаг внимания на странице
   * и решает сам — повторить детекцию или заменить страницу целиком.
   */
  app.post(
    `${PREFIX}/layouts/:layoutId/pages/:workingPageIndex/replace-with-text`,
    {
      preHandler: editMarkup,
      schema: { params: pageParamSchema, response: { 201: blockMutationResponseSchema } },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request, 'разметки');
      const result = await replacePageWithFullPageBlock(app.db, scope, {
        layoutRevisionId: request.params.layoutId,
        expectedVersion,
        actorUserId: user.id,
        workingPageIndex: request.params.workingPageIndex,
      });
      return withVersion(reply, result.version).code(201).send(result);
    },
  );

  /**
   * Режим `full-page-text` на весь комплект (§5.3).
   *
   * После первой ручной правки отвергается: операция удаляет прежние блоки
   * страницы, то есть стёрла бы уже сделанную человеком разметку. Проверка
   * живёт в репозитории — маршрут не должен быть единственным местом, где она
   * есть.
   */
  app.post(
    `${PREFIX}/layouts/:layoutId/full-page-text`,
    {
      preHandler: editMarkup,
      schema: { params: layoutIdParamSchema, response: { 200: fullPageTextResponseSchema } },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request, 'разметки');
      const result = await applyFullPageTextProfile(app.db, scope, {
        layoutRevisionId: request.params.layoutId,
        expectedVersion,
        actorUserId: user.id,
      });
      return withVersion(reply, result.version).code(200).send({
        layoutRevisionId: request.params.layoutId,
        version: result.version,
        pages: result.pages,
      });
    },
  );

  /**
   * Повторная детекция: пачки по страницам, по задаче на пачку (§5.2, шаг 3).
   *
   * Это ЯВНОЕ действие пользователя на флагованной странице (§5.3: «повторить
   * детекцию или заменить страницу одним блоком»), поэтому задачи ставятся с
   * флагом перезаписи: без него удалённая сторона вернула бы уже размеченные
   * страницы в `skipped_pages`, и нажатие кнопки ничего бы не изменило. Ручные
   * блоки при этом не трогаются — их защищает импорт (страница с блоком
   * пользователя пропускается целиком), а не отсутствие флага.
   */
  app.post(
    `${PREFIX}/layouts/:layoutId/detect`,
    {
      preHandler: editMarkup,
      schema: {
        params: layoutIdParamSchema,
        body: detectRequestSchema,
        response: { 202: detectResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const layout = await findLayoutRevision(app.db, scope, request.params.layoutId);
      if (layout === null) throw notFound('Ревизия разметки не найдена.');
      if (layout.state !== 'draft') {
        /**
         * Ручной путь инженера — тот же ответ, что у кнопки.
         *
         * Сюда попадают только `superseded`-ревизии из баз, работавших до отмены
         * заморозки (0048): их содержимое заперто, по нему уже прошёл прогон. В
         * строгом режиме это отказ, в режиме тестирования разметка возвращается в
         * работу и перезаписывается — ровно как это делает «1. Выделить блоки».
         */
        if (await readImmutabilityEnforced(app.db)) {
          throw conflict(
            'Вытесненную разметку заново не детектируют: она описывает набор, по которому уже прошёл прогон.',
          );
        }
        const restarted = await startMarkupOnBundle(app.db, scope, {
          folderId: layout.folderId,
          bundleId: layout.bundleId,
          previewCached: app.env.PREVIEW_MODE === 'cached',
          logger: request.log as unknown as Logger,
        });
        return reply.code(202).send({
          layoutRevisionId: restarted.layoutRevisionId,
          batches: restarted.jobIds.length,
          jobIds: [...restarted.jobIds],
        });
      }

      const requested = request.body.workingPageIndices;
      const pages =
        requested !== undefined && requested.length > 0
          ? [...new Set(requested)].sort((a, b) => a - b)
          : (await listBundlePages(app.db, scope, layout.bundleId)).map(
              (page) => page.workingPageIndex,
            );
      if (pages.length === 0) throw conflict('У рабочего документа нет карты страниц.');

      const detection = await readDetectionSettings(app.db);
      const batch = {
        layoutRevisionId: layout.id,
        folderId: layout.folderId,
        pages,
        logger: request.log as unknown as Logger,
      };
      const jobIds =
        detection.provider === 'local'
          ? (await enqueueLocalDetectBatches(app.db, scope, { ...batch, overwriteExisting: true }))
              .jobIds
          : await enqueueDetectBatches(app.db, scope, batch);
      return reply.code(202).send({
        layoutRevisionId: layout.id,
        batches: jobIds.length,
        jobIds,
      });
    },
  );
}

// =====================================================================
// Разворот содержимого страницы (ADR-0020)
// =====================================================================

/**
 * Почему разворот живёт в модуле разметки, а не документов.
 *
 * Ручная метка вида ИД адресуется той же парой `folderId/sourcePageId` и
 * лежит в соседнем модуле, поэтому соблазн положить разворот рядом с ней
 * велик. Но метка отвечает на вопрос «что это за документ» и правится правом
 * `document.edit`, а разворот отвечает на вопрос «как эту страницу читать» и
 * является входом ДЕТЕКЦИИ И РАСПОЗНАВАНИЯ — того же конвейера, что рисует
 * рамки. Право на него то же, что на рамки: `markup.edit`.
 *
 * Ревизия ПОСТАВКИ, а не разметки, в адресе — намеренно: разворот привязан к
 * странице исходного файла и переживает пересборку рабочего документа, как её
 * переживает ручная метка. Ревизия разметки здесь не при чём вовсе.
 */
function registerOrientationRoutes(app: AppInstance): void {
  app.put(
    `${PREFIX}/folders/:folderId/pages/:sourcePageId/orientation`,
    {
      preHandler: editMarkup,
      schema: {
        params: orientationParamSchema,
        body: orientationRequestSchema,
        response: { 200: orientationResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { folderId, sourcePageId } = request.params;
      updateContext({ folderId });

      const view = await saveManualPageOrientation(app.db, scope, {
        folderId,
        sourcePageId,
        rotation: request.body.rotation,
        actor: auditActor(app, request),
      });

      request.log.info(
        {
          event: 'page_orientation_set',
          folder_id: folderId,
          source_page_id: sourcePageId,
          content_rotation: view.contentRotation,
          probe_rotation: view.probeRotation,
        },
        'разворот содержимого страницы задан вручную',
      );

      return reply.code(200).send(view);
    },
  );

  app.delete(
    `${PREFIX}/folders/:folderId/pages/:sourcePageId/orientation`,
    {
      preHandler: editMarkup,
      schema: {
        params: orientationParamSchema,
        response: { 200: orientationResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { folderId, sourcePageId } = request.params;
      updateContext({ folderId });

      const view = await clearManualPageOrientation(app.db, scope, {
        folderId,
        sourcePageId,
        actor: auditActor(app, request),
      });

      request.log.info(
        {
          event: 'page_orientation_cleared',
          folder_id: folderId,
          source_page_id: sourcePageId,
          content_rotation: view.contentRotation,
        },
        'ручной разворот снят: действует значение зонда',
      );

      return reply.code(200).send(view);
    },
  );

  app.get(
    `${PREFIX}/folders/:folderId/pages/:sourcePageId/orientation`,
    {
      preHandler: readMarkup,
      schema: {
        params: orientationParamSchema,
        response: { 200: orientationResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope: _scope } = currentAuth(request);
      const { folderId, sourcePageId } = request.params;
      updateContext({ folderId });

      const view = await findPageOrientation(app.db, folderId, sourcePageId);
      if (view === null) throw notFound('Разворот этой страницы не задавали.');
      return reply.code(200).send(view);
    },
  );
}
