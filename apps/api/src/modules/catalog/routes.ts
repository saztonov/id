/**
 * REST-эндпоинты справочников (§3.2, §14): `/api/v1/catalog/*`.
 *
 * Разграничение доступа — тремя уровнями (§4.1), и на этом слое видны первые
 * два: право на маршруте и обязательный `AuthScope` у каждого вызова
 * репозитория. Правило распределения прав здесь такое:
 *
 * - **Чтение справочника** — любому аутентифицированному пользователю с
 *   бизнес-ролью. Отдельного права «читать справочники» нет намеренно: оно было
 *   бы выдано всем четырём ролям и не отвечало бы ни на один вопрос. Но право на
 *   маршрут НЕ означает право на все строки: справочники делятся на
 *   коммерческие сведения (объекты, контрагенты, разделы, реестр РД) и
 *   конфигурацию (виды разделов и их профили, каталог видов ИД), и первые
 *   сужаются областью видимости в SQL. Деление и его причины — в заголовке
 *   `db/repositories/catalog.ts`; здесь важно следствие: одинаковый статус 200 у
 *   подрядчика и у руководителя означает РАЗНЫЙ состав ответа.
 * - **Запись** — только администратору, через `requirePermission`, а не сверкой
 *   роли в обработчике: перечень прав живёт одной матрицей в
 *   `middleware/require-permission.ts`, и ответ на «кто правит справочники»
 *   не должен требовать чтения роутов.
 * - **Очередь кандидатов** — и чтение тоже под `doc_types.manage`. Это
 *   единственный справочник, в котором лежат фрагменты чужих документов
 *   (`observed_title_sample`, ссылки на ревизию и страницу), поэтому «читают
 *   все» к нему не применяется. Разбор — в заголовке репозитория.
 *
 * Вложенные маршруты объекта (`/objects/:objectId/sections`,
 * `/objects/:objectId/rd-documents`) сначала читают сам объект той же областью, а
 * не сразу список. Иначе объект вне области отвечал бы пустым списком, то есть
 * «объект есть, но он пуст» — а это уже сведение о чужой площадке. 404 делает
 * «объекта нет» и «объект не ваш» неразличимыми для запрашивающего.
 *
 * Обработчики намеренно тонкие: ни одной проверки инварианта. Всё, что зависит
 * от состояния базы — номер версии профиля, запрет `automatic` новому разделу,
 * закрытие периода предыдущей версии, — живёт в репозитории, потому что это
 * вопросы к БД, а не к телу запроса.
 *
 * Из той же тонкости следует, как здесь устроен аудит. Каждая изменяющая
 * операция получает `AuditActor` — то, что знает только слой HTTP: отпечаток
 * e-mail, адрес и `request_id`. Идентификатор актора в него НЕ входит: его
 * репозиторий берёт из области видимости, поэтому подставить в журнал чужого
 * пользователя обработчик не может даже по ошибке. Имя действия и состав payload
 * тоже назначает репозиторий — рядом с самим изменением (разбор в его заголовке).
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppInstance } from '../../app.js';
import type { AuthScope } from '../../auth/scope.js';
import { notFound } from '../../lib/problem.js';
import { currentAuth, requireAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import {
  clearDocTypeOverride,
  createConstructionObject,
  createCounterparty,
  createCounterpartyKind,
  createDocType,
  createDocTypeFromCandidate,
  createObjectSection,
  createRdDocument,
  createSectionKind,
  createSectionProfile,
  deleteConstructionObject,
  deleteCounterparty,
  findConstructionObject,
  findCounterparty,
  findDocType,
  findDocTypeCandidate,
  findEffectiveSectionProfile,
  listConstructionObjects,
  listCounterparties,
  listCounterpartyKinds,
  listDocTypeCandidates,
  listDocTypes,
  listObjectSections,
  listRdDocuments,
  listSectionKinds,
  listSectionProfiles,
  mapDocTypeCandidate,
  publishSectionProfile,
  setDocTypeCandidateStatus,
  setDocTypeOverride,
  updateConstructionObject,
  updateCounterparty,
  updateObjectSection,
  updateRdDocument,
} from '../../db/repositories/catalog.js';
import {
  candidateIdParamSchema,
  candidateListQuerySchema,
  candidateStatusBodySchema,
  constructionObjectPageSchema,
  counterpartyIdParamSchema,
  counterpartyKindListSchema,
  counterpartyListQuerySchema,
  counterpartyPageSchema,
  createConstructionObjectBodySchema,
  createCounterpartyBodySchema,
  createCounterpartyKindBodySchema,
  createDocTypeBodySchema,
  createObjectSectionBodySchema,
  createRdDocumentBodySchema,
  createSectionProfileBodySchema,
  docTypeCandidatePageSchema,
  docTypeCandidateSchema,
  docTypeCodeParamSchema,
  docTypeFromCandidateSchema,
  docTypeListQuerySchema,
  docTypeListSchema,
  docTypeOverrideBodySchema,
  docTypeSchema,
  effectiveProfileQuerySchema,
  mapCandidateBodySchema,
  objectIdParamSchema,
  objectListQuerySchema,
  objectSectionListSchema,
  profileIdParamSchema,
  rdDocumentIdParamSchema,
  rdDocumentListQuerySchema,
  rdDocumentPageSchema,
  rdDocumentSchema,
  sectionIdParamSchema,
  sectionKindCodeParamSchema,
  sectionKindListSchema,
  sectionKindSchema,
  sectionListQuerySchema,
  sectionProfileListQuerySchema,
  sectionProfileListSchema,
  updateConstructionObjectBodySchema,
  updateCounterpartyBodySchema,
  updateObjectSectionBodySchema,
  updateRdDocumentBodySchema,
} from './schemas.js';
import {
  constructionObjectSchema,
  counterpartyKindEntrySchema,
  counterpartySchema,
  objectSectionSchema,
  sectionProfileSchema,
} from '@id/contracts';

const PREFIX = '/api/v1/catalog';

/**
 * Чтение справочника: нужна сессия и бизнес-роль, право не нужно.
 *
 * `requireAuth`, а не `requirePermission`: он различает 401 («войдите») и 403
 * («роль не назначена»), и слитые в один статус эти случаи отправляли бы
 * пользователя на бесконечный повторный вход.
 */
const authenticated: preHandlerAsyncHookHandler = (request: FastifyRequest) => requireAuth(request);

/**
 * Объект из адресной строки обязан быть виден области запроса.
 *
 * Один вопрос у всех вложенных маршрутов объекта — и один ответ на него, 404.
 * Отдельной функцией, чтобы новый вложенный маршрут не остался без проверки: без
 * неё чужой объект отвечал бы пустым списком вместо отказа, а нарушение внешнего
 * ключа при записи давало бы 500 вместо внятного «объект не найден» — именно так
 * выглядит опечатка в идентификаторе из адресной строки.
 */
async function requireVisibleObject(
  app: AppInstance,
  scope: AuthScope,
  objectId: string,
): Promise<void> {
  if ((await findConstructionObject(app.db, scope, objectId)) === null) {
    throw notFound('Объект строительства не найден.');
  }
}

/**
 * Данные актора для записи в `audit_log`.
 *
 * `auditEmailHmac()` берётся из репозитория администрирования, а не пишется здесь
 * второй раз: значение колонки `actor_email_hmac` обязано считаться одним
 * способом, иначе следы одного пользователя из разных модулей не сойдутся между
 * собой. Без ключа `AUDIT_HMAC_KEY` возвращается `null` — подставлять сам адрес
 * нельзя (§3.1).
 */
function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

/** Правка справочников — администрирование (§4.1). */
const manageCatalog = requirePermission('settings.manage');

/** Каталог видов ИД и очередь кандидатов — отдельное право (§4.1). */
const manageDocTypes = requirePermission('doc_types.manage');

export function registerCatalogRoutes(app: AppInstance): void {
  registerObjectRoutes(app);
  registerCounterpartyRoutes(app);
  registerCounterpartyKindRoutes(app);
  registerSectionRoutes(app);
  registerSectionProfileRoutes(app);
  registerRdDocumentRoutes(app);
  registerDocTypeRoutes(app);
  registerCandidateRoutes(app);
}

// =====================================================================
// Объекты строительства
// =====================================================================

function registerObjectRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/objects`,
    {
      preHandler: authenticated,
      schema: {
        querystring: objectListQuerySchema,
        response: { 200: constructionObjectPageSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await listConstructionObjects(app.db, scope, request.query);
      return reply.code(200).send({ items: [...result.items], nextCursor: result.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/objects/:objectId`,
    {
      preHandler: authenticated,
      schema: { params: objectIdParamSchema, response: { 200: constructionObjectSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const object = await findConstructionObject(app.db, scope, request.params.objectId);
      if (object === null) throw notFound('Объект строительства не найден.');
      return reply.code(200).send(object);
    },
  );

  app.post(
    `${PREFIX}/objects`,
    {
      preHandler: manageCatalog,
      schema: {
        body: createConstructionObjectBodySchema,
        response: { 201: constructionObjectSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createConstructionObject(
        app.db,
        scope,
        request.body,
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    `${PREFIX}/objects/:objectId`,
    {
      preHandler: manageCatalog,
      schema: {
        params: objectIdParamSchema,
        body: updateConstructionObjectBodySchema,
        response: { 200: constructionObjectSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await updateConstructionObject(
        app.db,
        scope,
        request.params.objectId,
        request.body,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Объект строительства не найден.');
      return reply.code(200).send(updated);
    },
  );

  /**
   * Удаление объекта — только пока на него ничего не ссылается.
   *
   * Основной способ вывести объект из работы — отключение (`PATCH isActive`), и
   * оно остаётся: удаление отвечает 409, как только у объекта появились разделы,
   * шифры РД или поставки. Ответ перечисляет, что именно мешает, — иначе
   * администратор получает «нельзя» без причины и идёт искать её в схеме.
   *
   * Через `app.route`, а не `app.delete`: см. разбор у наложений видов ИД ниже.
   */
  app.route({
    method: 'DELETE',
    url: `${PREFIX}/objects/:objectId`,
    preHandler: manageCatalog,
    schema: { params: objectIdParamSchema },
    handler: async (request, reply) => {
      const { scope } = currentAuth(request);
      const removed = await deleteConstructionObject(
        app.db,
        scope,
        request.params.objectId,
        auditActor(app, request),
      );
      if (removed === null) throw notFound('Объект строительства не найден.');
      return reply.code(204).send();
    },
  });
}

// =====================================================================
// Контрагенты
// =====================================================================

function registerCounterpartyRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/counterparties`,
    {
      preHandler: authenticated,
      schema: {
        querystring: counterpartyListQuerySchema,
        response: { 200: counterpartyPageSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await listCounterparties(app.db, scope, request.query);
      return reply.code(200).send({ items: [...result.items], nextCursor: result.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/counterparties/:counterpartyId`,
    {
      preHandler: authenticated,
      schema: { params: counterpartyIdParamSchema, response: { 200: counterpartySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const found = await findCounterparty(app.db, scope, request.params.counterpartyId);
      if (found === null) throw notFound('Контрагент не найден.');
      return reply.code(200).send(found);
    },
  );

  app.post(
    `${PREFIX}/counterparties`,
    {
      preHandler: manageCatalog,
      schema: { body: createCounterpartyBodySchema, response: { 201: counterpartySchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createCounterparty(
        app.db,
        scope,
        request.body,
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    `${PREFIX}/counterparties/:counterpartyId`,
    {
      preHandler: manageCatalog,
      schema: {
        params: counterpartyIdParamSchema,
        body: updateCounterpartyBodySchema,
        response: { 200: counterpartySchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await updateCounterparty(
        app.db,
        scope,
        request.params.counterpartyId,
        request.body,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Контрагент не найден.');
      return reply.code(200).send(updated);
    },
  );

  /** Удаление контрагента — только при нуле ссылок; разбор у объектов выше. */
  app.route({
    method: 'DELETE',
    url: `${PREFIX}/counterparties/:counterpartyId`,
    preHandler: manageCatalog,
    schema: { params: counterpartyIdParamSchema },
    handler: async (request, reply) => {
      const { scope } = currentAuth(request);
      const removed = await deleteCounterparty(
        app.db,
        scope,
        request.params.counterpartyId,
        auditActor(app, request),
      );
      if (removed === null) throw notFound('Контрагент не найден.');
      return reply.code(204).send();
    },
  });
}

// =====================================================================
// Виды контрагентов
// =====================================================================

/**
 * Справочник видов контрагентов (миграция 0027).
 *
 * Чтение — всем аутентифицированным: это конфигурация, подписи в форме, а не
 * сведения об участниках стройки. Запись — `settings.manage`, как у остальных
 * справочников.
 */
function registerCounterpartyKindRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/counterparty-kinds`,
    { preHandler: authenticated, schema: { response: { 200: counterpartyKindListSchema } } },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const kinds = await listCounterpartyKinds(app.db, scope);
      return reply.code(200).send([...kinds]);
    },
  );

  app.post(
    `${PREFIX}/counterparty-kinds`,
    {
      preHandler: manageCatalog,
      schema: {
        body: createCounterpartyKindBodySchema,
        response: { 201: counterpartyKindEntrySchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createCounterpartyKind(
        app.db,
        scope,
        request.body,
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );
}

// =====================================================================
// Разделы работ и виды разделов
// =====================================================================

function registerSectionRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/objects/:objectId/sections`,
    {
      preHandler: authenticated,
      schema: {
        params: objectIdParamSchema,
        querystring: sectionListQuerySchema,
        response: { 200: objectSectionListSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      await requireVisibleObject(app, scope, objectId);
      const sections = await listObjectSections(app.db, scope, objectId, request.query);
      return reply.code(200).send([...sections]);
    },
  );

  app.post(
    `${PREFIX}/objects/:objectId/sections`,
    {
      preHandler: manageCatalog,
      schema: {
        params: objectIdParamSchema,
        body: createObjectSectionBodySchema,
        response: { 201: objectSectionSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      await requireVisibleObject(app, scope, objectId);
      const created = await createObjectSection(
        app.db,
        scope,
        objectId,
        request.body,
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    `${PREFIX}/sections/:sectionId`,
    {
      preHandler: manageCatalog,
      schema: {
        params: sectionIdParamSchema,
        body: updateObjectSectionBodySchema,
        response: { 200: objectSectionSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await updateObjectSection(
        app.db,
        scope,
        request.params.sectionId,
        request.body,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Раздел работ не найден.');
      return reply.code(200).send(updated);
    },
  );

  app.get(
    `${PREFIX}/section-kinds`,
    { preHandler: authenticated, schema: { response: { 200: sectionKindListSchema } } },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const kinds = await listSectionKinds(app.db, scope);
      return reply.code(200).send([...kinds]);
    },
  );

  app.post(
    `${PREFIX}/section-kinds`,
    {
      preHandler: manageCatalog,
      schema: { body: sectionKindSchema, response: { 201: sectionKindSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createSectionKind(
        app.db,
        scope,
        request.body,
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );
}

// =====================================================================
// Профили видов разделов
// =====================================================================

function registerSectionProfileRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/section-profiles`,
    {
      preHandler: authenticated,
      schema: {
        querystring: sectionProfileListQuerySchema,
        response: { 200: sectionProfileListSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const profiles = await listSectionProfiles(app.db, scope, request.query);
      return reply.code(200).send([...profiles]);
    },
  );

  /**
   * Профиль, действующий на дату.
   *
   * Отдельный маршрут, а не параметр списка: у «всех версий» и «версии на дату»
   * разные ответы — массив и объект, — и совмещение их в одном маршруте заставило
   * бы клиента разбирать форму ответа по наличию параметра. Дата по умолчанию —
   * текущая по UTC; прогон проверок передаёт дату события явно (§9.2).
   */
  app.get(
    `${PREFIX}/section-kinds/:kindCode/effective-profile`,
    {
      preHandler: authenticated,
      schema: {
        params: sectionKindCodeParamSchema,
        querystring: effectiveProfileQuerySchema,
        response: { 200: sectionProfileSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const onDate = request.query.at ?? new Date().toISOString().slice(0, 10);
      const profile = await findEffectiveSectionProfile(
        app.db,
        scope,
        request.params.kindCode,
        onDate,
      );
      if (profile === null) {
        // 404, а не пустой профиль: «профиль раздела не настроен» — законное
        // состояние открытого мира, и правила полноты обязаны отличать его от
        // «комплект неполон» (§9.1). Пустой объект стёр бы это различие.
        throw notFound('Для этого вида раздела нет опубликованного профиля на указанную дату.');
      }
      return reply.code(200).send(profile);
    },
  );

  app.post(
    `${PREFIX}/section-profiles`,
    {
      preHandler: manageCatalog,
      schema: { body: createSectionProfileBodySchema, response: { 201: sectionProfileSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createSectionProfile(
        app.db,
        scope,
        request.body,
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );

  app.post(
    `${PREFIX}/section-profiles/:profileId/publish`,
    {
      preHandler: manageCatalog,
      schema: { params: profileIdParamSchema, response: { 200: sectionProfileSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const published = await publishSectionProfile(
        app.db,
        scope,
        request.params.profileId,
        auditActor(app, request),
      );
      if (published === null) throw notFound('Профиль вида раздела не найден.');
      return reply.code(200).send(published);
    },
  );
}

// =====================================================================
// Реестр рабочей документации
// =====================================================================

function registerRdDocumentRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/objects/:objectId/rd-documents`,
    {
      preHandler: authenticated,
      schema: {
        params: objectIdParamSchema,
        querystring: rdDocumentListQuerySchema,
        response: { 200: rdDocumentPageSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      await requireVisibleObject(app, scope, objectId);
      const result = await listRdDocuments(app.db, scope, { ...request.query, objectId });
      return reply.code(200).send({ items: [...result.items], nextCursor: result.nextCursor });
    },
  );

  app.post(
    `${PREFIX}/objects/:objectId/rd-documents`,
    {
      preHandler: manageCatalog,
      schema: {
        params: objectIdParamSchema,
        body: createRdDocumentBodySchema,
        response: { 201: rdDocumentSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      await requireVisibleObject(app, scope, objectId);
      const created = await createRdDocument(
        app.db,
        scope,
        objectId,
        request.body,
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    `${PREFIX}/rd-documents/:rdDocumentId`,
    {
      preHandler: manageCatalog,
      schema: {
        params: rdDocumentIdParamSchema,
        body: updateRdDocumentBodySchema,
        response: { 200: rdDocumentSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await updateRdDocument(
        app.db,
        scope,
        request.params.rdDocumentId,
        request.body,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Документ рабочей документации не найден.');
      return reply.code(200).send(updated);
    },
  );
}

// =====================================================================
// Каталог видов ИД
// =====================================================================

function registerDocTypeRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/doc-types`,
    {
      preHandler: authenticated,
      schema: { querystring: docTypeListQuerySchema, response: { 200: docTypeListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const types = await listDocTypes(app.db, scope, request.query);
      return reply.code(200).send([...types]);
    },
  );

  app.get(
    `${PREFIX}/doc-types/:code`,
    {
      preHandler: authenticated,
      schema: { params: docTypeCodeParamSchema, response: { 200: docTypeSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const found = await findDocType(app.db, scope, request.params.code);
      if (found === null) throw notFound('Вид ИД не найден.');
      return reply.code(200).send(found);
    },
  );

  app.post(
    `${PREFIX}/doc-types`,
    {
      preHandler: manageDocTypes,
      schema: { body: createDocTypeBodySchema, response: { 201: docTypeSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const created = await createDocType(app.db, scope, request.body, auditActor(app, request));
      return reply.code(201).send(created);
    },
  );

  /**
   * Правка вида ИД пишет НАЛОЖЕНИЕ, а не строку каталога.
   *
   * Базовые строки `doc_types` приходят seed-миграцией, и правка их из портала
   * исчезла бы при следующем seed'е без следа. Поэтому маршрута, меняющего
   * `doc_types`, нет вовсе, а этот пишет `doc_type_overrides`.
   */
  app.patch(
    `${PREFIX}/doc-types/:code`,
    {
      preHandler: manageDocTypes,
      schema: {
        params: docTypeCodeParamSchema,
        body: docTypeOverrideBodySchema,
        response: { 200: docTypeSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await setDocTypeOverride(
        app.db,
        scope,
        request.params.code,
        request.body,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Вид ИД не найден.');
      return reply.code(200).send(updated);
    },
  );

  /**
   * Снять наложение целиком — через `app.route`, а не `app.delete`.
   *
   * Не стиль: eslint-правило, запрещающее запросы к БД вне `db/repositories/`,
   * ищет вызовы `.delete()`, `.insert()`, `.update()`, `.select()` по ИМЕНИ
   * метода и не различает `db.delete` от `app.delete`. Любой HTTP-маршрут DELETE
   * в этом проекте объявляется так же — иначе он не проходит линт.
   */
  app.route({
    method: 'DELETE',
    url: `${PREFIX}/doc-types/:code/override`,
    preHandler: manageDocTypes,
    schema: { params: docTypeCodeParamSchema, response: { 200: docTypeSchema } },
    handler: async (request, reply) => {
      const { scope } = currentAuth(request);
      const restored = await clearDocTypeOverride(
        app.db,
        scope,
        request.params.code,
        auditActor(app, request),
      );
      if (restored === null) throw notFound('Вид ИД не найден.');
      return reply.code(200).send(restored);
    },
  });
}

// =====================================================================
// Кандидаты в виды ИД
// =====================================================================

function registerCandidateRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/doc-type-candidates`,
    {
      // Право, а не просто сессия: в записях лежат заголовки чужих документов.
      preHandler: manageDocTypes,
      schema: {
        querystring: candidateListQuerySchema,
        response: { 200: docTypeCandidatePageSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await listDocTypeCandidates(app.db, scope, request.query);
      return reply.code(200).send({ items: [...result.items], nextCursor: result.nextCursor });
    },
  );

  app.get(
    `${PREFIX}/doc-type-candidates/:candidateId`,
    {
      preHandler: manageDocTypes,
      schema: { params: candidateIdParamSchema, response: { 200: docTypeCandidateSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const found = await findDocTypeCandidate(app.db, scope, request.params.candidateId);
      if (found === null) throw notFound('Кандидат в виды ИД не найден.');
      return reply.code(200).send(found);
    },
  );

  app.patch(
    `${PREFIX}/doc-type-candidates/:candidateId`,
    {
      preHandler: manageDocTypes,
      schema: {
        params: candidateIdParamSchema,
        body: candidateStatusBodySchema,
        response: { 200: docTypeCandidateSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const updated = await setDocTypeCandidateStatus(
        app.db,
        scope,
        request.params.candidateId,
        request.body.status,
        auditActor(app, request),
      );
      if (updated === null) throw notFound('Кандидат в виды ИД не найден.');
      return reply.code(200).send(updated);
    },
  );

  /** Действие «сопоставить с существующим» (§3.2). */
  app.post(
    `${PREFIX}/doc-type-candidates/:candidateId/map`,
    {
      preHandler: manageDocTypes,
      schema: {
        params: candidateIdParamSchema,
        body: mapCandidateBodySchema,
        response: { 200: docTypeCandidateSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const mapped = await mapDocTypeCandidate(
        app.db,
        scope,
        request.params.candidateId,
        request.body.docTypeCode,
        auditActor(app, request),
      );
      if (mapped === null) throw notFound('Кандидат в виды ИД не найден.');
      return reply.code(200).send(mapped);
    },
  );

  /** Действие «завести тип» (§3.2): создаёт вид ИД и закрывает кандидата. */
  app.post(
    `${PREFIX}/doc-type-candidates/:candidateId/doc-type`,
    {
      preHandler: manageDocTypes,
      schema: {
        params: candidateIdParamSchema,
        body: createDocTypeBodySchema,
        response: { 201: docTypeFromCandidateSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await createDocTypeFromCandidate(
        app.db,
        scope,
        request.params.candidateId,
        request.body,
        auditActor(app, request),
      );
      if (result === null) throw notFound('Кандидат в виды ИД не найден.');
      return reply.code(201).send(result);
    },
  );
}
