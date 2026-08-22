/**
 * Маршруты профилей правил объекта (§3.2, §9.2): `/api/v1/catalog/...`.
 *
 * Отдельный файл, а не ещё одна секция в `routes.ts`: у этой сущности своя форма
 * запросов (наложения), своя схема ответа и своё разрешение «правила на дату», и
 * в общем файле справочников она читалась бы как приложение к разделам работ.
 * Префикс тот же, потому что это тот же справочник §3.2 — клиенту делить его по
 * файлам исходников незачем.
 *
 * Права распределены как в остальном каталоге (§4.1):
 *
 * - **чтение** — любому аутентифицированному пользователю с бизнес-ролью, но
 *   строки сужены областью видимости по объекту в SQL. «Какие правила действуют
 *   на моём объекте» — законный вопрос и инженера, и подрядчика, подающего
 *   комплект: ответ объясняет ему будущие замечания;
 * - **запись** — под `settings.manage`, то есть администратору. Наложение
 *   меняет вердикты проверок, поэтому это настройка портала, а не работа с ИД.
 *
 * Разрешение действующих правил вынесено маршрутом (`effective-rules`), а не
 * оставлено внутренней функцией движка: интерфейс обязан показывать инженеру,
 * ЧТО именно будет проверяться, до прогона, — иначе «почему правило не
 * сработало» выясняется только чтением кода. Тот же вызов на S9 использует
 * движок правил.
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import type { AuthScope } from '../../auth/scope.js';
import { notFound } from '../../lib/problem.js';
import { sectionCodeSchema } from '@id/contracts';
import { materialCategoryCodeSchema } from './schemas.js';
import { currentAuth, requireAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import { findConstructionObject, listObjectSections } from '../../db/repositories/catalog.js';
import {
  createObjectRuleProfile,
  listObjectRuleProfiles,
  publishObjectRuleProfile,
  resolveEffectiveRules,
  ruleOverridesInputSchema,
  RELEVANT_DATE_BASES,
} from '../../db/repositories/object-rule-profiles.js';
import {
  autonomyLevelSchema,
  docTypeCodeSchema,
  isoDateSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  ruleCodeSchema,
  uuidSchema,
} from '@id/contracts';

const PREFIX = '/api/v1/catalog';

/** Правка профилей правил — то же право, что у остальных справочников (§4.1). */
const manageCatalog = requirePermission('settings.manage');

// =====================================================================
// Схемы
// =====================================================================

const objectIdParamSchema = z.object({ objectId: uuidSchema });
const objectSectionParamsSchema = z.object({
  objectId: uuidSchema,
  sectionCode: sectionCodeSchema,
});
const profileIdParamSchema = z.object({ profileId: uuidSchema });

/**
 * Что показать: всё, конкретный раздел или профиль всего объекта.
 *
 * Отдельный флаг `objectWide`, а не `sectionId=null` в строке запроса: «параметра
 * нет» и «параметр равен пустому» в querystring неразличимы, а разница здесь
 * содержательна — «все профили объекта» против «профиль, действующий на весь
 * объект».
 */
const listQuerySchema = z
  .object({
    sectionCode: sectionCodeSchema.optional(),
    objectWide: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .refine((query) => !(query.objectWide === true && query.sectionCode !== undefined), {
    message: 'Одновременно «профиль всего объекта» и раздел запросить нельзя',
    path: ['objectWide'],
  });

/** Дата, на которую нужны действующие правила. По умолчанию — текущая по UTC. */
const effectiveRulesQuerySchema = z.object({ at: isoDateSchema.optional() });

const createBodySchema = z
  .object({
    /** `null` — профиль всего объекта. */
    sectionCode: sectionCodeSchema.nullish(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullish(),
    overrides: ruleOverridesInputSchema.default({}),
    publish: z.boolean().default(false),
  })
  .refine((body) => body.effectiveTo == null || body.effectiveFrom <= body.effectiveTo, {
    message: 'Начало действия профиля позже его окончания',
    path: ['effectiveTo'],
  });

const overridesResponseSchema = z.object({
  expectedDocTypes: z.array(docTypeCodeSchema).optional(),
  materialCategories: z.array(materialCategoryCodeSchema).optional(),
  materialMatrix: z.record(z.string(), jsonValueSchema).optional(),
  thresholds: z.record(z.string(), jsonValueSchema).optional(),
  enabledRuleCodes: z.array(ruleCodeSchema).optional(),
  disabledRuleCodes: z.array(ruleCodeSchema).optional(),
  autonomyLevel: z.literal('assisted').optional(),
  relevantDateBasis: z.enum(RELEVANT_DATE_BASES).optional(),
});

const objectRuleProfileSchema = z.object({
  id: uuidSchema,
  objectId: uuidSchema,
  sectionCode: sectionCodeSchema.nullable(),
  version: z.int().positive(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
  overrides: overridesResponseSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

const objectRuleProfileListSchema = z.array(objectRuleProfileSchema);

/**
 * Действующие правила.
 *
 * `completenessConfigured` в ответе есть намеренно: §9.1 требует отличать «состав
 * комплекта не настроен» (правила полноты дают `n_a`) от «комплект пуст», и
 * клиент, показывающий эти правила инженеру, обязан различать их так же, как
 * движок.
 */
const resolvedRulesSchema = z.object({
  objectId: uuidSchema,
  sectionCode: sectionCodeSchema,
  onDate: isoDateSchema,
  sectionProfileId: uuidSchema.nullable(),
  sectionProfileVersion: z.int().positive().nullable(),
  objectProfileIds: z.array(uuidSchema),
  expectedDocTypes: z.array(docTypeCodeSchema),
  // На выходе — то, что лежит в БД: закрытое перечисление держится на ВХОДЕ,
  // а профиль, сохранённый до его введения, обязан читаться, а не давать 500
  // при сериализации ответа.
  materialCategories: z.array(z.string()),
  materialMatrix: jsonValueSchema,
  enabledRuleCodes: z.array(ruleCodeSchema),
  thresholds: jsonValueSchema,
  autonomyLevel: autonomyLevelSchema,
  relevantDateBasis: z.enum(RELEVANT_DATE_BASES),
  completenessConfigured: z.boolean(),
});

// =====================================================================
// Регистрация
// =====================================================================

export function registerObjectRuleProfileRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/objects/:objectId/rule-profiles`,
    {
      preHandler: (request: FastifyRequest) => requireAuth(request),
      schema: {
        params: objectIdParamSchema,
        querystring: listQuerySchema,
        response: { 200: objectRuleProfileListSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      await requireVisibleObject(app, scope, objectId);

      const profiles = await listObjectRuleProfiles(app.db, scope, objectId, {
        sectionCode: request.query.objectWide === true ? null : request.query.sectionCode,
      });
      return reply.code(200).send([...profiles]);
    },
  );

  app.post(
    `${PREFIX}/objects/:objectId/rule-profiles`,
    {
      preHandler: manageCatalog,
      schema: {
        params: objectIdParamSchema,
        body: createBodySchema,
        response: { 201: objectRuleProfileSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId } = request.params;
      await requireVisibleObject(app, scope, objectId);

      const sectionCode = request.body.sectionCode ?? null;
      if (sectionCode !== null) {
        // Раздел проверяется здесь, хотя составной FK
        // `object_rule_profiles_section_fk` не дал бы записать чужой: 404 «раздел
        // не найден» отвечает на опечатку в идентификаторе, а 422 по ограничению
        // говорил бы о разделе другого объекта — то есть сообщал бы о его
        // существовании.
        const section = (await listObjectSections(app.db, scope, request.params.objectId)).find(
          (row: { sectionCode: string; isActive: boolean }) =>
            row.sectionCode === sectionCode && row.isActive,
        );
        if (section === undefined) {
          throw notFound('Раздел работ не включён на этом объекте.');
        }
      }

      const created = await createObjectRuleProfile(
        app.db,
        scope,
        {
          objectId,
          sectionCode,
          effectiveFrom: request.body.effectiveFrom,
          effectiveTo: request.body.effectiveTo ?? null,
          overrides: request.body.overrides,
          publish: request.body.publish,
        },
        auditActor(app, request),
      );
      return reply.code(201).send(created);
    },
  );

  app.post(
    `${PREFIX}/rule-profiles/:profileId/publish`,
    {
      preHandler: manageCatalog,
      schema: { params: profileIdParamSchema, response: { 200: objectRuleProfileSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const published = await publishObjectRuleProfile(
        app.db,
        scope,
        request.params.profileId,
        auditActor(app, request),
      );
      if (published === null) throw notFound('Профиль правил объекта не найден.');
      return reply.code(200).send(published);
    },
  );

  /**
   * Правила, действующие для объекта и раздела на дату.
   *
   * Дата по умолчанию — текущая по UTC, но прогон проверок передаёт дату
   * релевантного события явно (§9.2): «действует сегодня» и «действовал на дату
   * работ» — разные вопросы, и подставлять первый вместо второго нельзя.
   */
  app.get(
    `${PREFIX}/objects/:objectId/sections/:sectionCode/effective-rules`,
    {
      preHandler: (request: FastifyRequest) => requireAuth(request),
      schema: {
        params: objectSectionParamsSchema,
        querystring: effectiveRulesQuerySchema,
        response: { 200: resolvedRulesSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { objectId, sectionCode } = request.params;
      const onDate = request.query.at ?? new Date().toISOString().slice(0, 10);

      const resolved = await resolveEffectiveRules(
        app.db,
        scope,
        { objectId, sectionCode },
        onDate,
      );
      // 404, а не пустые правила: подставить настройку другого раздела было бы
      // хуже отказа, а «раздела нет» и «раздел не ваш» запрашивающий различать
      // не должен.
      if (resolved === null) throw notFound('Раздел работ не найден на этом объекте.');
      // Списки копируются: репозиторий отдаёт их `readonly`, чтобы разрешённые
      // правила нельзя было дописать после разрешения, а сериализатор ждёт
      // изменяемый массив.
      return reply.code(200).send({
        ...resolved,
        objectProfileIds: [...resolved.objectProfileIds],
        expectedDocTypes: [...resolved.expectedDocTypes],
        materialCategories: [...resolved.materialCategories],
        enabledRuleCodes: [...resolved.enabledRuleCodes],
      });
    },
  );
}

// =====================================================================
// Общее
// =====================================================================

/** Тот же ответ, что у вложенных маршрутов объекта в `routes.ts`: 404. */
async function requireVisibleObject(
  app: AppInstance,
  scope: AuthScope,
  objectId: string,
): Promise<void> {
  if ((await findConstructionObject(app.db, scope, objectId)) === null) {
    throw notFound('Объект строительства не найден.');
  }
}

/** См. разбор в `routes.ts`: идентификатор актора берётся из области видимости. */
function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}
