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
import { conflict, notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import {
  countFoldersBySection,
  createFolder,
  deleteFolder,
  findFolder,
  listFolders,
  previewFolderDeletion,
  summarizeFolderPipeline,
  updateFolder,
} from '../../db/repositories/navigation.js';
import { updateContext } from '../../observability/context.js';
import {
  createFolderBodySchema,
  createdFolderSchema,
  folderDeletionPreviewSchema,
  folderIdParamSchema,
  folderListQuerySchema,
  folderPageSchema,
  folderPipelineQuerySchema,
  folderPipelineSchema,
  objectIdParamSchema,
  sectionCountsQuerySchema,
  sectionCountsSchema,
  updateFolderBodySchema,
} from './schemas.js';
import { folderSchema } from '@id/contracts';

const PREFIX = '/api/v1';

const readFolders = requirePermission('submission.read');
const uploadFolders = requirePermission('submission.upload');
/**
 * Удаление папки — у всех пяти ролей (S37).
 *
 * Отдельное право, а не `submission.upload`: это разные действия, и матрица
 * обязана называть каждое своим именем.
 */
const deleteContent = requirePermission('submission.delete');

function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

export function registerNavigationRoutes(app: AppInstance): void {
  registerFolderRoutes(app);
}

// =====================================================================
// Папки ИД
// =====================================================================

function registerFolderRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/folders`,
    {
      preHandler: readFolders,
      schema: { querystring: folderListQuerySchema, response: { 200: folderPageSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const page = await listFolders(app.db, scope, request.query);
      return reply.code(200).send({ items: [...page.items], nextCursor: page.nextCursor });
    },
  );

  /**
   * Счётчики комплектов по разделам объекта.
   *
   * Нужны заголовкам дерева на экране объекта: раздел подписан числом до того,
   * как его раскроют, а раскрытие грузит комплекты лениво. Отдельный маршрут, а
   * не поле в `GET /catalog/objects/{id}/sections`, потому что это данные ИД, а
   * не справочник: число зависит от области видимости спрашивающего и от
   * фильтров, которые он выставил, — у справочника ни того, ни другого нет.
   */
  app.get(
    `${PREFIX}/objects/:objectId/sections/counts`,
    {
      preHandler: readFolders,
      schema: {
        params: objectIdParamSchema,
        querystring: sectionCountsQuerySchema,
        response: { 200: sectionCountsSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      updateContext({ objectId });
      const counts = await countFoldersBySection(app.db, scope, objectId, request.query);
      return reply.code(200).send([...counts]);
    },
  );

  app.get(
    `${PREFIX}/folders/:folderId`,
    {
      preHandler: readFolders,
      schema: { params: folderIdParamSchema, response: { 200: folderSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const folder = await findFolder(app.db, scope, request.params.folderId);
      if (folder === null) throw notFound('Комплект не найден.');
      updateContext({ objectId: folder.objectId });
      return reply.code(200).send(folder);
    },
  );

  app.post(
    `${PREFIX}/folders`,
    {
      preHandler: uploadFolders,
      schema: { body: createFolderBodySchema, response: { 201: createdFolderSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createFolder(app.db, scope, request.body, auditActor(app, request));
      updateContext({ objectId: created.folder.objectId, folderId: created.folder.id });
      return reply.code(201).send(created);
    },
  );

  app.patch(
    `${PREFIX}/folders/:folderId`,
    {
      preHandler: uploadFolders,
      schema: {
        params: folderIdParamSchema,
        body: updateFolderBodySchema,
        response: { 200: folderSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await updateFolder(
        app.db,
        scope,
        request.params.folderId,
        request.body,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Комплект не найден.');
      return reply.code(200).send(updated);
    },
  );

  /**
   * Что исчезнет вместе с комплектом.
   *
   * Отдельный GET перед удалением, а не текст в подтверждении: числа знает
   * только БД. Он же отвечает, можно ли удалять вообще, — тем же списком
   * `blockers`, что вернёт отказ. Экран показывает препятствия ДО нажатия, как
   * это уже делает согласование ревизии: кнопка, которая гарантированно
   * получит 409, вводит в заблуждение.
   *
   * Право на просмотр то же, что на удаление: числа по чужому комплекту — это
   * сведения о чужой работе, и отдавать их шире, чем само действие, незачем.
   */
  /**
   * Состояние конвейера по комплектам ОДНОЙ страницы списка.
   *
   * Тот же приём, что у счётчиков разделов: величина, которую иначе пришлось бы
   * получать по одному запросу на строку. Здесь это важнее — экран объекта
   * обновляет её опросом, пока хоть что-то идёт.
   *
   * `submission.read`: сводка не рассказывает о комплекте ничего сверх того,
   * что человек и так видит в его карточке.
   */
  app.get(
    `${PREFIX}/objects/:objectId/folders/pipeline`,
    {
      preHandler: readFolders,
      schema: {
        params: objectIdParamSchema,
        querystring: folderPipelineQuerySchema,
        response: { 200: folderPipelineSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      updateContext({ objectId });
      const summaries = await summarizeFolderPipeline(
        app.db,
        scope,
        objectId,
        request.query.folderIds,
      );
      return reply.code(200).send([...summaries]);
    },
  );

  app.get(
    `${PREFIX}/folders/:folderId/deletion-preview`,
    {
      preHandler: deleteContent,
      schema: { params: folderIdParamSchema, response: { 200: folderDeletionPreviewSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const preview = await previewFolderDeletion(app.db, scope, request.params.folderId);
      if (preview === null) throw notFound('Комплект не найден.');
      return reply.code(200).send({ ...preview, blockers: [...preview.blockers] });
    },
  );

  /**
   * Удаление комплекта со всем содержимым.
   *
   * Объявлено через `app.route`, а не `app.delete`: правило eslint, запрещающее
   * запросы к БД вне `db/repositories/`, ищет вызовы `.delete()` по имени метода
   * и не различает `db.delete` от `app.delete` (так же сделаны остальные DELETE
   * портала — см. `modules/files/routes.ts`).
   *
   * Отказ 409 перечисляет помехи дословно: «нельзя» без причины отправляет
   * администратора искать её по схеме.
   */
  app.route({
    method: 'DELETE',
    url: `${PREFIX}/folders/:folderId`,
    preHandler: deleteContent,
    schema: { params: folderIdParamSchema },
    handler: async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await deleteFolder(
        app.db,
        scope,
        request.params.folderId,
        auditActor(app, request),
      );
      if (result === null) throw notFound('Комплект не найден.');
      if (!result.deleted) {
        throw conflict(`Папку удалить нельзя: ${result.blockers.join('; ')}.`);
      }
      return reply.code(204).send();
    },
  });
}
