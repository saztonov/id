/**
 * Разметка: старт цепочки, чтение, правка блоков, заморозка (§6.1, §7, §14).
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
 * `markup.edit` (подрядчик и инженер), заморозка — `markup.freeze`. Область
 * видимости применяется в репозитории на КАЖДОМ пути: подрядчик не видит чужую
 * разметку ни списком, ни по прямому идентификатору.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import type { AuthScope } from '../../auth/scope.js';
import { badRequest, conflict, notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import { listBundlePages, listBundles } from '../../db/repositories/bundles.js';
import {
  applyFullPageTextProfile,
  createLayoutBlock,
  deleteLayoutBlock,
  ensureDraftLayout,
  findLayoutRevision,
  freezeLayout,
  listLayoutBlocks,
  listLayoutRevisions,
  listPageAttentionFlags,
  replacePageWithFullPageBlock,
  updateLayoutBlock,
  type LayoutRevisionView,
} from '../../db/repositories/layout.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { DETECT_BATCH_LIMIT } from '../../integrations/rdweb/legacy-adapter.js';
import {
  blockCreateSchema,
  blockMutationResponseSchema,
  blockParamSchema,
  blockUpdateSchema,
  detectRequestSchema,
  detectResponseSchema,
  freezeResponseSchema,
  fullPageTextResponseSchema,
  layoutBlockListSchema,
  layoutDetailSchema,
  layoutIdParamSchema,
  layoutListSchema,
  pageParamSchema,
  pageQuerySchema,
  revisionIdParamSchema,
  startMarkupResponseSchema,
  versionResponseSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const readMarkup = requirePermission('markup.read');
const editMarkup = requirePermission('markup.edit');
const freezeMarkup = requirePermission('markup.freeze');

export function registerLayoutRoutes(app: AppInstance): void {
  registerStartRoute(app);
  registerReadRoutes(app);
  registerBlockRoutes(app);
  registerPageRoutes(app);
  registerFreezeRoute(app);
}

// =====================================================================
// Версия как ETag
// =====================================================================

function toView(layout: LayoutRevisionView) {
  return {
    id: layout.id,
    revisionId: layout.revisionId,
    bundleId: layout.bundleId,
    revisionNo: layout.revisionNo,
    state: layout.state as 'draft' | 'frozen' | 'superseded',
    blocksHash: layout.blocksHash,
    version: layout.version,
    detectorProfile: layout.detectorProfile as 'rf_detr' | 'full_page',
    manuallyEdited: layout.firstManualEditAt !== null,
    frozenAt: layout.frozenAt,
    createdAt: layout.createdAt,
  };
}

/**
 * Разбор `If-Match`.
 *
 * Заголовок обязателен на каждой мутации: без него «последний записавший
 * победил» становится поведением по умолчанию, а на экране разметки это значит
 * потерянную работу второго редактора. Отсутствие заголовка — ошибка клиента, и
 * отвечать на неё 412 нельзя: 412 клиент понимает как «перечитай и повтори», а
 * перечитывание тут не поможет.
 */
function requireIfMatch(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw badRequest('Требуется заголовок If-Match с версией разметки.');
  }
  const cleaned = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number(cleaned);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest('Заголовок If-Match должен содержать целую версию разметки.');
  }
  return parsed;
}

function withVersion(reply: FastifyReply, version: number): FastifyReply {
  return reply.header('etag', `"${version}"`);
}

// =====================================================================
// Старт цепочки «Разметить файл»
// =====================================================================

function registerStartRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/layout`,
    {
      preHandler: editMarkup,
      schema: {
        params: revisionIdParamSchema,
        response: { 202: startMarkupResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      // Рабочий документ обязан существовать: разметка ложится на его страницы,
      // а не на исходные файлы. Отсутствие bundle — это ответ пользователю
      // сейчас («сначала соберите рабочий документ»), а не задача, которая
      // упадёт через минуту с тем же текстом.
      const bundles = await listBundles(app.db, scope, revisionId);
      const bundle = bundles[bundles.length - 1];
      if (bundle === undefined) {
        throw conflict(
          'Разметку нельзя начать: рабочий документ ревизии ещё не собран ' +
            '(POST /revisions/{id}/bundle).',
        );
      }
      updateContext({ revisionId });

      const { layout, created } = await ensureDraftLayout(app.db, scope, {
        revisionId,
        bundleId: bundle.id,
      });

      // Постановка первой задачи цепочки §12 (задача 4). Ключ идемпотентности —
      // по ревизии разметки: повторное нажатие кнопки не должно порождать
      // второй RD-документ.
      const { jobId, created: jobCreated } = await enqueueJob(app.db, scope, {
        type: 'rd.create_run_document',
        // Ревизия разметки — в payload, а не «найдётся по bundle»: пока задача
        // ждёт в очереди, черновик может смениться (заморозка №1 → создание №2),
        // и задача отработала бы по чужой цели.
        payload: tracePayload({
          revisionId,
          bundleId: bundle.id,
          layoutRevisionId: layout.id,
        }),
        dedupeKey: dedupeKeyFor('rd.create_run_document', layout.id),
      });

      request.log.info(
        {
          event: 'job_enqueued',
          job_type: 'rd.create_run_document',
          job_id: jobId,
          created: jobCreated,
        },
        'цепочка разметки поставлена в очередь',
      );

      return withVersion(reply, layout.version).code(202).send({
        layoutRevisionId: layout.id,
        bundleId: bundle.id,
        created,
        jobId,
        jobCreated,
      });
    },
  );
}

// =====================================================================
// Чтение
// =====================================================================

function registerReadRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/revisions/:revisionId/layouts`,
    {
      preHandler: readMarkup,
      schema: { params: revisionIdParamSchema, response: { 200: layoutListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listLayoutRevisions(app.db, scope, request.params.revisionId);
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
      updateContext({ revisionId: layout.revisionId, objectId: layout.objectId });

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
      const expectedVersion = requireIfMatch(request);
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
      const expectedVersion = requireIfMatch(request);
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
      const expectedVersion = requireIfMatch(request);
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
      const expectedVersion = requireIfMatch(request);
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
      const expectedVersion = requireIfMatch(request);
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
        throw conflict('Замороженную разметку заново не детектируют: создайте новую ревизию.');
      }

      const requested = request.body.workingPageIndices;
      const pages =
        requested !== undefined && requested.length > 0
          ? [...new Set(requested)].sort((a, b) => a - b)
          : (await listBundlePages(app.db, scope, layout.bundleId)).map(
              (page) => page.workingPageIndex,
            );
      if (pages.length === 0) throw conflict('У рабочего документа нет карты страниц.');

      const jobIds = await enqueueDetectBatches(app, request, scope, layout, pages);
      return reply.code(202).send({
        layoutRevisionId: layout.id,
        batches: jobIds.length,
        jobIds,
      });
    },
  );
}

/**
 * Разбиение комплекта на пачки детекции.
 *
 * Одна задача = одна пачка: у их синхронного вызова есть потолок страниц, а
 * задача, обходящая весь комплект в цикле, держала бы аренду минутами и при
 * падении переигрывала бы уже сделанное. Ключ идемпотентности включает границы
 * пачки, поэтому повторное нажатие не удваивает очередь.
 */
async function enqueueDetectBatches(
  app: AppInstance,
  request: FastifyRequest,
  scope: AuthScope,
  layout: LayoutRevisionView,
  pages: readonly number[],
): Promise<string[]> {
  const jobIds: string[] = [];
  for (let offset = 0; offset < pages.length; offset += DETECT_BATCH_LIMIT) {
    const batch = pages.slice(offset, offset + DETECT_BATCH_LIMIT);
    const { jobId } = await enqueueJob(app.db, scope, {
      type: 'layout.detect_pages',
      payload: tracePayload({
        revisionId: layout.revisionId,
        layoutRevisionId: layout.id,
        pageIndices: batch,
        overwriteExisting: true,
      }),
      // Метка `overwrite` входит в ключ: без неё нажатие кнопки склеилось бы с
      // уже стоящей в очереди пачкой первичной цепочки, и флаг потерялся бы.
      dedupeKey: dedupeKeyFor(
        'layout.detect_pages',
        layout.id,
        `${String(batch[0])}-${String(batch[batch.length - 1])}`,
        'overwrite',
      ),
    });
    jobIds.push(jobId);
  }
  request.log.info(
    { event: 'job_enqueued', job_type: 'layout.detect_pages', batches: jobIds.length },
    'детекция поставлена пачками',
  );
  return jobIds;
}

// =====================================================================
// Заморозка
// =====================================================================

function registerFreezeRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/layouts/:layoutId/freeze`,
    {
      preHandler: freezeMarkup,
      schema: { params: layoutIdParamSchema, response: { 200: freezeResponseSchema } },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const expectedVersion = requireIfMatch(request);
      const result = await freezeLayout(app.db, scope, {
        layoutRevisionId: request.params.layoutId,
        expectedVersion,
        actorUserId: user.id,
      });
      request.log.info(
        { event: 'layout_frozen', layout_revision_id: result.layoutRevisionId },
        'разметка заморожена',
      );
      return withVersion(reply, result.version).code(200).send(result);
    },
  );
}
