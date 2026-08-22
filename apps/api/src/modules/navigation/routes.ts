/**
 * Корневой экран «ИД»: объект → комплект → ревизия и реестры передачи (§3, §14).
 *
 * ## Права
 *
 * Чтение — `submission.read`: комплект и реестр сами по себе не содержат ничего,
 * чего не содержал бы уже доступный по этому праву список документов ревизии, а
 * состав выдачи сужает область видимости, а не право.
 *
 * Заведение комплекта и ревизии — `submission.upload`: состав комплекта
 * формирует тот, кто его сдаёт. Право выдано и генподрядчику: субподрядчики
 * учётных записей в портале, как правило, не имеют, и ПТО собирает их комплекты
 * само. Кого именно он вправе указать исполнителем, решает не право, а
 * закрепление подрядчика за объектом (`works_contractor_fk`).
 *
 * Ведение реестра — `registry.manage` (генподрядчик и администратор), приёмка —
 * `registry.accept` (инженер и руководитель). Разделены потому, что передаёт и
 * принимает не один и тот же человек: подпись «Принял» стоит со стороны
 * заказчика, и передающий не принимает сам у себя.
 *
 * ## Одинаковый статус — разный состав ответа
 *
 * Подрядчик и руководитель на `GET /registries/{id}` получают 200 оба, но
 * подрядчик не видит ни счётчика комплектов, ни файла описи, ни блокеров
 * передачи. Это не «поля пустые», а полей нет: ноль вместо отсутствия был бы
 * ответом, а не умолчанием, и по нему считалось бы, сколько работ у соседей.
 *
 * Различать «нет такого» и «не ваше» наружу нельзя (§1.6): прямой идентификатор
 * чужого комплекта даёт 404, а не 403, иначе перебор идентификаторов
 * подтверждал бы существование чужой работы.
 *
 * ## `If-Match` обязателен там, где состав меняется
 *
 * Реестр собирают минутами, а передают одним нажатием: между «увидел состав» и
 * «передал» второй сотрудник ПТО успевает добавить или убрать комплект. Без
 * версии «последний записавший победил» стало бы поведением по умолчанию, и
 * подпись оказалась бы под составом, которого никто не видел.
 *
 * ## Idempotency-Key здесь не требуется
 *
 * §14 объявляет его обязательным на дорогих действиях: upload complete, freeze,
 * recognize, checks и действия workflow. Заведение комплекта к ним не
 * относится — это вставка одной строки, повтор которой виден в списке и
 * исправляется человеком. Передачу защищает `If-Match`, а не ключ
 * идемпотентности: повтор с той же версией отвергается как устаревший.
 */
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import { notFound } from '../../lib/problem.js';
import { requireIdempotencyKey, requireIfMatch } from '../../lib/http-headers.js';
import { currentAuth } from '../../middleware/require-auth.js';
import {
  hasPermission,
  requireAnyPermission,
  requirePermission,
} from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import {
  acceptRegistry,
  attachRegistryFile,
  createDraftRevision,
  createRegistry,
  createWork,
  excludeWork,
  findRegistry,
  findRegistryFile,
  findWork,
  includeWork,
  issueBlockers,
  issueRegistry,
  listRegistries,
  listRegistryItems,
  listRegistryWorks,
  listWorkRevisions,
  listWorks,
  updateRegistry,
  updateWork,
} from '../../db/repositories/navigation.js';
import {
  findRegistryReconciliation,
  findWorkReconciliation,
  reviewReconciliation,
} from '../../db/repositories/reconciliation.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import {
  createRegistryBodySchema,
  createWorkBodySchema,
  createdWorkSchema,
  includeWorkBodySchema,
  reconcileResponseSchema,
  registryIdParamSchema,
  registryItemListSchema,
  registryListQuerySchema,
  registryPageSchema,
  registryReconciliationViewSchema,
  registryViewSchema,
  registryWorkParamsSchema,
  revisionIdParamSchema,
  revisionListQuerySchema,
  revisionPageSchema,
  reviewReconciliationBodySchema,
  updateRegistryBodySchema,
  updateWorkBodySchema,
  workIdParamSchema,
  workListQuerySchema,
  workPageSchema,
  workReconciliationViewSchema,
} from './schemas.js';
import {
  registryReconciliationSchema,
  registrySchema,
  submissionRevisionSchema,
  workSchema,
} from '@id/contracts';

const PREFIX = '/api/v1';

const readWorks = requirePermission('submission.read');
const uploadWorks = requirePermission('submission.upload');
const manageRegistry = requirePermission('registry.manage');
const acceptRegistryPermission = requirePermission('registry.accept');
/** Чтение реестра доступно всем, кто вообще видит ИД. */
const readRegistries = requireAnyPermission(['submission.read']);

function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

export function registerNavigationRoutes(app: AppInstance): void {
  registerWorkRoutes(app);
  registerRevisionRoutes(app);
  registerRegistryRoutes(app);
}

// =====================================================================
// Комплекты работ
// =====================================================================

function registerWorkRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/works`,
    {
      preHandler: readWorks,
      schema: { querystring: workListQuerySchema, response: { 200: workPageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const page = await listWorks(app.db, scope, request.query);
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/works/:workId`,
    {
      preHandler: readWorks,
      schema: { params: workIdParamSchema, response: { 200: workSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const work = await findWork(app.db, scope, request.params.workId);
      if (work === null) throw notFound('Комплект не найден.');
      updateContext({ objectId: work.objectId });
      return reply.code(200).send(work);
    },
  );

  app.post(
    `${PREFIX}/works`,
    {
      preHandler: uploadWorks,
      schema: { body: createWorkBodySchema, response: { 201: createdWorkSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createWork(app.db, scope, request.body, auditActor(app, request));
      updateContext({ objectId: created.work.objectId, revisionId: created.revision.id });
      return reply.code(201).send(created);
    },
  );

  app.patch(
    `${PREFIX}/works/:workId`,
    {
      preHandler: uploadWorks,
      schema: {
        params: workIdParamSchema,
        body: updateWorkBodySchema,
        response: { 200: workSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await updateWork(
        app.db,
        scope,
        request.params.workId,
        request.body,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Комплект не найден.');
      return reply.code(200).send(updated);
    },
  );
}

// =====================================================================
// Ревизии комплекта
// =====================================================================

function registerRevisionRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/works/:workId/revisions`,
    {
      preHandler: readWorks,
      schema: {
        params: workIdParamSchema,
        querystring: revisionListQuerySchema,
        response: { 200: revisionPageSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const page = await listWorkRevisions(app.db, scope, request.params.workId, request.query);
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );

  app.post(
    `${PREFIX}/works/:workId/revisions`,
    {
      preHandler: uploadWorks,
      schema: { params: workIdParamSchema, response: { 201: submissionRevisionSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const revision = await createDraftRevision(
        app.db,
        scope,
        request.params.workId,
        auditActor(app, request),
      );
      updateContext({ revisionId: revision.id });
      return reply.code(201).send(revision);
    },
  );
}

// =====================================================================
// Реестры
// =====================================================================

function registerRegistryRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/registries`,
    {
      preHandler: readRegistries,
      schema: { querystring: registryListQuerySchema, response: { 200: registryPageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const page = await listRegistries(app.db, scope, request.query);
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );

  /**
   * Карточка реестра. Состав ответа зависит от прав актора, а не от статуса.
   *
   * Ведущий реестр видит его целиком — состав, файл описи и блокеры передачи.
   * Подрядчику отдаётся только сам реестр: остальное сообщало бы ему о работе
   * соседей по папке.
   */
  app.get(
    `${PREFIX}/registries/:registryId`,
    {
      preHandler: readRegistries,
      schema: { params: registryIdParamSchema, response: { 200: registryViewSchema } },
    },
    async (request, reply) => {
      const { scope, roles } = currentAuth(request);
      const { registryId } = request.params;
      const registry = await findRegistry(app.db, scope, registryId);
      if (registry === null) throw notFound('Реестр не найден.');
      updateContext({ objectId: registry.objectId });

      const manages =
        hasPermission(roles, 'registry.manage') || hasPermission(roles, 'registry.accept');
      if (!manages) return reply.code(200).send({ registry });

      const [works, file, blockers] = await Promise.all([
        listRegistryWorks(app.db, scope, registryId),
        findRegistryFile(app.db, scope, registryId),
        issueBlockers(app.db, scope, registryId),
      ]);

      // Сводка сверки — только тому, кто ВЕДЁТ папку, а не всякому, кто её
      // видит. Признак `manages` выше объединяет `registry.manage` и
      // `registry.accept`, и переиспользовать его здесь нельзя: заказчик
      // назвал получателем сводки по папке сотрудников генподрядчика.
      const reconciliation = hasPermission(roles, 'registry.manage')
        ? ((
            await findRegistryReconciliation(
              app.db,
              registryId,
              registry.status === 'draft' ? null : registry.issuedFileRevisionId,
            )
          )?.reconciliation ?? null)
        : undefined;

      return reply.code(200).send({
        registry,
        works: [...works],
        file,
        blockers: [...blockers],
        ...(reconciliation === undefined ? {} : { reconciliation }),
      });
    },
  );

  app.post(
    `${PREFIX}/registries`,
    {
      preHandler: manageRegistry,
      schema: { body: createRegistryBodySchema, response: { 201: registrySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createRegistry(app.db, scope, request.body, auditActor(app, request));
      updateContext({ objectId: created.objectId });
      return reply.code(201).send(created);
    },
  );

  app.patch(
    `${PREFIX}/registries/:registryId`,
    {
      preHandler: manageRegistry,
      schema: {
        params: registryIdParamSchema,
        body: updateRegistryBodySchema,
        response: { 200: registrySchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await updateRegistry(
        app.db,
        scope,
        request.params.registryId,
        requireIfMatch(request, 'реестра'),
        request.body,
        auditActor(app, request),
      );
      return reply.code(200).send(updated);
    },
  );

  app.route({
    method: 'PUT',
    url: `${PREFIX}/registries/:registryId/works/:workId`,
    preHandler: manageRegistry,
    schema: {
      params: registryWorkParamsSchema,
      body: includeWorkBodySchema,
      response: { 200: registrySchema },
    },
    handler: async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await includeWork(
        app.db,
        scope,
        request.params.registryId,
        request.params.workId,
        requireIfMatch(request, 'реестра'),
        request.body.ordinal ?? null,
        auditActor(app, request),
      );
      return reply.code(200).send(updated);
    },
  });

  app.route({
    method: 'DELETE',
    url: `${PREFIX}/registries/:registryId/works/:workId`,
    preHandler: manageRegistry,
    schema: { params: registryWorkParamsSchema, response: { 200: registrySchema } },
    handler: async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await excludeWork(
        app.db,
        scope,
        request.params.registryId,
        request.params.workId,
        requireIfMatch(request, 'реестра'),
        auditActor(app, request),
      );
      return reply.code(200).send(updated);
    },
  });

  /**
   * Заведение файла описи.
   *
   * Возвращает комплект и его первую ревизию: сам скан грузится обычным приёмом
   * файлов на эту ревизию и подаётся `POST /revisions/{id}/submit`. Отдельного
   * пути загрузки для описи нет намеренно — он был бы вторым конвейером с теми
   * же проверками, расходящимся с первым при каждой правке.
   */
  app.post(
    `${PREFIX}/registries/:registryId/file`,
    {
      preHandler: manageRegistry,
      schema: { params: registryIdParamSchema, response: { 201: createdWorkSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await attachRegistryFile(
        app.db,
        scope,
        request.params.registryId,
        auditActor(app, request),
      );
      updateContext({ revisionId: created.revision.id });
      return reply.code(201).send(created);
    },
  );

  app.post(
    `${PREFIX}/registries/:registryId/issue`,
    {
      preHandler: manageRegistry,
      schema: { params: registryIdParamSchema, response: { 200: registrySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const issued = await issueRegistry(
        app.db,
        scope,
        request.params.registryId,
        requireIfMatch(request, 'реестра'),
        auditActor(app, request),
      );
      return reply.code(200).send(issued);
    },
  );

  app.post(
    `${PREFIX}/registries/:registryId/accept`,
    {
      preHandler: acceptRegistryPermission,
      schema: { params: registryIdParamSchema, response: { 200: registrySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const accepted = await acceptRegistry(
        app.db,
        scope,
        request.params.registryId,
        requireIfMatch(request, 'реестра'),
        auditActor(app, request),
      );
      return reply.code(200).send(accepted);
    },
  );

  app.get(
    `${PREFIX}/registries/:registryId/items`,
    {
      preHandler: readRegistries,
      schema: { params: registryIdParamSchema, response: { 200: registryItemListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listRegistryItems(app.db, scope, request.params.registryId);
      return reply.code(200).send([...items]);
    },
  );

  registerReconciliationRoutes(app);
}

// =====================================================================
// Сверка описи передачи (S20)
// =====================================================================

/**
 * Три маршрута и ДВА РАЗНЫХ адреса чтения — это решение, а не оформление.
 *
 * Заказчик: «данные по каждому комплекту формируются отдельно; данные по
 * реестру показываются только сотрудникам генподрядчика». Один маршрут,
 * урезающий ответ по роли, выразил бы это условием внутри обработчика — то
 * есть местом, где однажды забудут ветку, и подрядчик увидит работы соседей по
 * папке. Два адреса выражают то же типом ответа: в схеме результата по
 * комплекту нет ни одного поля о папке, и положить их туда нечего.
 *
 * Запускать сверку вправе всякий, кто видит реестр (`submission.read`).
 * `registry.manage` для этого не годится: оно есть только у генподрядчика и
 * администратора, а заказчик прямо назвал инженера, руководителя и подрядчика —
 * «важна информация о том, есть ли ошибки в документе». Рубеж доступа создаёт
 * не право, а `findRegistry` по области: без него инженер, знающий UUID чужого
 * реестра на чужом объекте, получил бы наименования работ и номера документов
 * чужих подрядчиков.
 */
function registerReconciliationRoutes(app: AppInstance): void {
  app.post(
    `${PREFIX}/registries/:registryId/reconcile`,
    {
      preHandler: readRegistries,
      schema: { params: registryIdParamSchema, response: { 202: reconcileResponseSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { registryId } = request.params;
      // Заголовок обязателен (§14: сверка читает документы всей папки), но в
      // ключ дедупликации НЕ кладётся — см. ниже.
      requireIdempotencyKey(request);

      const registry = await findRegistry(app.db, scope, registryId);
      if (registry === null) throw notFound('Реестр не найден.');
      updateContext({ objectId: registry.objectId });

      // Файл описи по области НЕ ищется, и это не упущение: он подан
      // генподрядчиком, а запускать сверку вправе и субподрядчик — под его
      // областью файл невидим. Рубеж здесь создал `findRegistry` выше; саму
      // ревизию скана обработчик найдёт по ключу, поэтому payload её и не
      // называет (см. докстринг `registry.reconcile` в `jobs/types.ts`).
      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'registry.reconcile',
        payload: tracePayload({ registryId }),
        // Ключ по РЕЕСТРУ, без `Idempotency-Key`. Отступление от образца
        // `doc.classify_pages` намеренное: там ключ включает заголовок, и два
        // нажатия дают две задачи. Здесь две задачи по одной папке одновременно
        // делали бы `DELETE`+`INSERT` под уникальным ключом, и защитой
        // оставалась бы одна advisory-блокировка. С ключом по реестру второе
        // нажатие получает уже стоящую задачу — то самое «повторная постановка
        // безопасна» из §12.
        dedupeKey: dedupeKeyFor('registry.reconcile', registryId),
      });

      request.log.info(
        { event: 'job_enqueued', jobType: 'registry.reconcile', jobId, created, registryId },
        'сверка описи поставлена',
      );
      return reply.code(202).send({ jobId, created });
    },
  );

  /**
   * Сводка по ПАПКЕ — только под `registry.manage`.
   *
   * `readRegistries` здесь не годится: под ним ответ увидел бы подрядчик, а в
   * нём шапка описи, группы без комплекта и комплекты соседей.
   */
  app.get(
    `${PREFIX}/registries/:registryId/reconciliation`,
    {
      preHandler: manageRegistry,
      schema: {
        params: registryIdParamSchema,
        response: { 200: registryReconciliationViewSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { registryId } = request.params;

      const registry = await findRegistry(app.db, scope, registryId);
      if (registry === null) throw notFound('Реестр не найден.');
      updateContext({ objectId: registry.objectId });

      // У переданной папки читается сверка ТОГО скана, который подписан, а не
      // текущего: иначе замена файла молча показала бы более позднюю сверку под
      // прежней подписью.
      const view = await findRegistryReconciliation(
        app.db,
        registryId,
        registry.status === 'draft' ? null : registry.issuedFileRevisionId,
      );
      if (view === null) return reply.code(200).send({ reconciliation: null });

      return reply.code(200).send({
        reconciliation: view.reconciliation,
        works: [...view.works],
        groups: [...view.groups],
        rows: [...view.rows],
        extraDocuments: [...view.extraDocuments],
      });
    },
  );

  /**
   * Результат по ОДНОМУ комплекту, адресуемый его ревизией.
   *
   * Право `submission.read` — все пять ролей; рубеж создаёт область по ревизии
   * комплекта, тем же `withScope`, каким закрыты остальные чтения ревизии.
   * `work: null` — комплект не включён в реестр либо сверки ещё не было; `404`
   * означает только «ревизия не видна».
   */
  app.get(
    `${PREFIX}/revisions/:revisionId/reconciliation`,
    {
      preHandler: readRegistries,
      schema: {
        params: revisionIdParamSchema,
        response: { 200: workReconciliationViewSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;
      updateContext({ revisionId });

      const view = await findWorkReconciliation(app.db, scope, revisionId);
      if (view === null) {
        return reply.code(200).send({
          work: null,
          rows: [],
          extraDocuments: [],
          parserVersion: null,
          finishedAt: null,
        });
      }

      return reply.code(200).send({
        work: view.work,
        rows: [...view.rows],
        extraDocuments: [...view.extraDocuments],
        parserVersion: view.parserVersion,
        finishedAt: view.finishedAt,
      });
    },
  );

  /**
   * Отметка «расхождение разобрано, дефекта нет».
   *
   * Под `registry.accept`: это суждение ПРИНИМАЮЩЕЙ стороны, а не наблюдение
   * портала. Пояснение обязательно — отметка без объяснения не отличима от
   * «закрыл, чтобы не мозолило», и следующий человек не поймёт, разобрано
   * расхождение или спрятано.
   */
  app.post(
    `${PREFIX}/registries/:registryId/reconciliation/review`,
    {
      preHandler: acceptRegistryPermission,
      schema: {
        params: registryIdParamSchema,
        body: reviewReconciliationBodySchema,
        response: { 200: registryReconciliationSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const { registryId } = request.params;

      const registry = await findRegistry(app.db, scope, registryId);
      if (registry === null) throw notFound('Реестр не найден.');
      updateContext({ objectId: registry.objectId });

      const reviewed = await reviewReconciliation(
        app.db,
        registryId,
        requireIfMatch(request, 'сверки'),
        request.body.note,
        user.id,
        auditActor(app, request),
        scope,
      );
      return reply.code(200).send(reviewed);
    },
  );
}
