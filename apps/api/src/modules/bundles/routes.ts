/**
 * Рабочий документ ревизии: сборка и карта страниц (§3.3, §6.1, §14).
 *
 * ## Почему сборка — отдельное действие, а не следствие загрузки
 *
 * Рабочий PDF склеивается из ВСЕХ файлов ревизии в порядке, заданном
 * пользователем. Собирать его после каждой загрузки значило бы пересобирать 86
 * МБ на каждый добавленный файл и фиксировать состав раньше, чем подрядчик его
 * закончил. Поэтому сборка — первая подстадия кнопки «Разметить файл» (§6.1):
 * пользователь заявляет, что состав и порядок окончательны.
 *
 * После сборки состав ревизии заперт (`requireEditableFolder` отвергает
 * загрузку при наличии bundle): разметка ложится на страницы рабочего
 * документа, и добавленный позже файл сдвинул бы их нумерацию.
 *
 * ## Карта страниц наружу
 *
 * `processing_bundle_pages` выдаётся и списком, и поштучно, потому что связь
 * «страница рабочего PDF → лист исходного файла» нужна каждому экрану, который
 * показывает результат: замечание относится к третьему листу второго файла, а
 * распознавание говорит о странице 47.
 *
 * ## Права
 *
 * Сборка — `markup.edit`: это начало разметки, и её ведёт либо подрядчик, либо
 * инженер. Чтение — `markup.read`, наравне с остальными данными разметки.
 * Область видимости применяется в репозитории на каждом пути.
 */
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import { conflict, notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import type { AuthScope } from '../../auth/scope.js';
import {
  assertPlanBuildable,
  findBundle,
  findSourceOfWorkingPage,
  listBundlePages,
  listBundles,
  loadBundlePlan,
  type BundlePlan,
  type BundleView,
} from '../../db/repositories/bundles.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import {
  bundleBuildResponseSchema,
  bundleIdParamSchema,
  bundleListSchema,
  bundlePageListSchema,
  bundlePageParamSchema,
  bundlePageSchema,
  bundleSchema,
  folderIdParamSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const buildBundle = requirePermission('markup.edit');
const readBundle = requirePermission('markup.read');

export function registerBundleRoutes(app: AppInstance): void {
  registerBuildRoute(app);
  registerListRoute(app);
  registerBundleRoute(app);
  registerPageMapRoutes(app);
}

// =====================================================================
// Сборка
// =====================================================================

function registerBuildRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/folders/:folderId/bundle`,
    {
      preHandler: buildBundle,
      schema: {
        params: folderIdParamSchema,
        response: { 202: bundleBuildResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { folderId } = request.params;

      const plan = await loadBundlePlan(app.db, scope, folderId);
      if (plan === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ folderId, objectId: plan.objectId });

      // Уже собранный документ того же состава возвращается без постановки
      // задачи: сборка идемпотентна по манифесту, и второй прогон склеил бы те
      // же 86 МБ ради того же результата. Версия сборщика в ключ здесь не
      // входит — её знает воркер, а не роут; несовпадение версии просто
      // приведёт к сборке внутри задачи.
      const existing =
        plan.blockers.length === 0 ? await findCurrentBundle(app, scope, plan) : null;
      if (existing !== null) {
        return reply.code(202).send({
          jobId: null,
          created: false,
          bundle: existing,
          aggregateManifestHash: plan.aggregateManifestHash,
        });
      }

      // Препятствия проверяются ДО очереди: «файл в карантине» — это ответ
      // пользователю сейчас, а не задача, которая через минуту упадёт в консоли
      // с тем же текстом.
      assertPlanBuildable(plan);

      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'bundle.build',
        payload: tracePayload({ folderId }),
        // Манифест в ключе: изменившийся состав обязан дать новую задачу, а не
        // слиться с уже стоящей в очереди сборкой прежнего комплекта.
        dedupeKey: dedupeKeyFor('bundle.build', folderId, plan.aggregateManifestHash),
      });

      request.log.info(
        { event: 'job_enqueued', job_type: 'bundle.build', job_id: jobId, created },
        'сборка рабочего документа поставлена в очередь',
      );

      return reply.code(202).send({
        jobId,
        created,
        bundle: null,
        aggregateManifestHash: plan.aggregateManifestHash,
      });
    },
  );
}

async function findCurrentBundle(
  app: AppInstance,
  scope: AuthScope,
  plan: BundlePlan,
): Promise<BundleView | null> {
  const bundles = await listBundles(app.db, scope, plan.folderId);
  return (
    bundles.find((bundle) => bundle.aggregateManifestHash === plan.aggregateManifestHash) ?? null
  );
}

// =====================================================================
// Чтение
// =====================================================================

function registerListRoute(app: AppInstance): void {
  app.get(
    `${PREFIX}/folders/:folderId/bundles`,
    {
      preHandler: readBundle,
      schema: { params: folderIdParamSchema, response: { 200: bundleListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listBundles(app.db, scope, request.params.folderId);
      // Пустой список чужой ревизии неотличим от пустого списка своей: наличие
      // рабочего документа — это факт о чужой поставке (§16).
      if (items.length === 0) {
        await requireVisibleFolder(app, request, request.params.folderId);
        return reply.code(200).send({ items: [] });
      }

      // Отвечает ли документ ТЕКУЩЕМУ составу файлов. План читается один раз на
      // запрос: манифест — функция от набора файлов, а не от конкретного
      // документа, и считать его в цикле значило бы платить за один и тот же
      // ответ столько раз, сколько сборок было у ревизии.
      const plan = await loadBundlePlan(app.db, scope, request.params.folderId);
      return reply.code(200).send({
        items: items.map((bundle) => ({
          ...bundle,
          matchesCurrentFiles:
            plan !== null && bundle.aggregateManifestHash === plan.aggregateManifestHash,
        })),
      });
    },
  );
}

function registerBundleRoute(app: AppInstance): void {
  app.get(
    `${PREFIX}/bundles/:bundleId`,
    {
      preHandler: readBundle,
      schema: { params: bundleIdParamSchema, response: { 200: bundleSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const bundle = await findBundle(app.db, scope, request.params.bundleId);
      if (bundle === null) throw notFound('Рабочий документ не найден.');
      updateContext({ folderId: bundle.folderId });
      return reply.code(200).send(bundle);
    },
  );
}

function registerPageMapRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/bundles/:bundleId/pages`,
    {
      preHandler: readBundle,
      schema: { params: bundleIdParamSchema, response: { 200: bundlePageListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { bundleId } = request.params;
      const items = await listBundlePages(app.db, scope, bundleId);
      if (items.length === 0) {
        // Bundle без карты — это не пустой результат, а расхождение: карта
        // пишется той же транзакцией, что и сам документ (§3.3).
        const bundle = await findBundle(app.db, scope, bundleId);
        if (bundle === null) throw notFound('Рабочий документ не найден.');
        throw conflict('У рабочего документа нет карты страниц: требуется пересборка.');
      }
      return reply.code(200).send({ bundleId, items: [...items] });
    },
  );

  app.get(
    `${PREFIX}/bundles/:bundleId/pages/:workingPageIndex`,
    {
      preHandler: readBundle,
      schema: { params: bundlePageParamSchema, response: { 200: bundlePageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const page = await findSourceOfWorkingPage(
        app.db,
        scope,
        request.params.bundleId,
        request.params.workingPageIndex,
      );
      if (page === null) throw notFound('Страница рабочего документа не найдена.');
      return reply.code(200).send(page);
    },
  );
}

async function requireVisibleFolder(
  app: AppInstance,
  request: FastifyRequest,
  folderId: string,
): Promise<void> {
  const { scope } = currentAuth(request);
  if ((await loadBundlePlan(app.db, scope, folderId)) === null) {
    throw notFound('Ревизия поставки не найдена.');
  }
}
