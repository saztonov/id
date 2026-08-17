/**
 * Маршруты администрирования (§14): пользователи, настройки, промты, правила.
 *
 * Все они закрыты правами `users.manage` / `settings.manage` / `rules.publish`,
 * а те по матрице §4.1 выданы только `admin`. Публикация набора правил здесь же и
 * тоже под `admin`: бизнес-согласование ИД требует `manager`, но набор правил —
 * это конфигурация системы, а не решение по поставке.
 *
 * Где журнал аудита пишется в одной транзакции с действием, а где нет — решается
 * идемпотентностью действия, а не удобством:
 *
 *   • публикация промта и версии набора правил НЕ идемпотентна (создаётся
 *     версия, переставляется указатель), поэтому запись в `audit_log` идёт внутри
 *     той же транзакции — иначе повтор после сбоя дал бы вторую версию и один
 *     журнальный след;
 *   • назначение ролей, областей и признака активности идемпотентно: повтор
 *     запроса приводит к тому же состоянию, поэтому запись журнала отдельным
 *     запросом допустима — сбой на ней даёт 500, клиент повторяет, состояние не
 *     дублируется, а след появляется.
 *
 * Отдельно про секреты (§10): API настроек их не хранит и не отдаёт. Наружу
 * уходит ссылка на переменную окружения и признак «задано»; попытка записать
 * секретный ключ отвергается с указанием, где значение живёт.
 */
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.js';
import type { Env } from '../../config/env.js';
import type { AuditEntry } from '../../db/repositories/admin.js';
import {
  activateRulesetVersion,
  appendAuditLog,
  auditEmailHmac,
  createPromptDraft,
  findPromptTemplate,
  findRulesetVersion,
  listPromptTemplates,
  listRuleDefinitions,
  listRulesetRules,
  listRulesetVersions,
  listUserObjectScopes,
  PG_RESTRICT_VIOLATION,
  pgErrorCode,
  publishRulesetVersion,
  readSetting,
  readSettings,
  replaceUserObjectScopes,
  replaceUserRoles,
  setUserContractor,
  transitionPrompt,
  updatePromptDraft,
  writeSetting,
  type PromptTemplateRow,
  type RulesetVersionRow,
  type SettingRow,
} from '../../db/repositories/admin.js';
import {
  findUserById,
  listUsers,
  setUserActive,
  type UserSummary,
} from '../../db/repositories/users.js';
import { conflict, internal, notFound, unprocessable } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import {
  editableStates,
  evaluateContentEdit,
  evaluateTransition,
  type GovernanceState,
} from './governance.js';
import {
  idParamsSchema,
  INTEGRATION_NAMES,
  looksSecret,
  promptCreateBodySchema,
  promptListQuerySchema,
  promptPageResponseSchema,
  promptPatchBodySchema,
  promptStateBodySchema,
  promptTemplateResponseSchema,
  promptTransitionResponseSchema,
  RULESET_ACTIVE_VERSION_KEY,
  ruleDefinitionListResponseSchema,
  rulesetListQuerySchema,
  rulesetPageResponseSchema,
  rulesetPublishBodySchema,
  rulesetVersionDetailResponseSchema,
  rulesetVersionResponseSchema,
  secretEnvVarFor,
  SECRET_SETTINGS,
  SETTING_KEYS,
  settingDefinition,
  settingKeyParamsSchema,
  settingResponseSchema,
  settingsResponseSchema,
  settingWriteBodySchema,
  userCardResponseSchema,
  userContractorBodySchema,
  userListQuerySchema,
  userObjectScopesBodySchema,
  userPageResponseSchema,
  userRolesBodySchema,
  type IntegrationName,
} from './schemas.js';

const PREFIX = '/api/v1/admin';

export function registerAdminRoutes(app: AppInstance): void {
  registerUserRoutes(app);
  registerSettingsRoutes(app);
  registerPromptRoutes(app);
  registerRulesetRoutes(app);
}

// =====================================================================
// Пользователи
// =====================================================================

function registerUserRoutes(app: AppInstance): void {
  const manage = requirePermission('users.manage');

  app.get(
    `${PREFIX}/users`,
    {
      schema: { querystring: userListQuerySchema, response: { 200: userPageResponseSchema } },
      preHandler: manage,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const page = await listUsers(app.db, scope, {
        limit: request.query.limit,
        cursor: request.query.cursor ?? null,
      });
      return { items: page.items.map(toUserResponse), nextCursor: page.nextCursor };
    },
  );

  app.get(
    `${PREFIX}/users/:id`,
    {
      schema: { params: idParamsSchema, response: { 200: userCardResponseSchema } },
      preHandler: manage,
    },
    async (request) => userCard(app, request, request.params.id),
  );

  app.put(
    `${PREFIX}/users/:id/roles`,
    {
      schema: {
        params: idParamsSchema,
        body: userRolesBodySchema,
        response: { 200: userCardResponseSchema },
      },
      preHandler: manage,
    },
    async (request) => {
      const auth = currentAuth(request);
      const userId = request.params.id;
      const roles = request.body.roles;

      // Защита портала от потери администрирования сводится к одному запрету:
      // нельзя снять роль `admin` с САМОГО СЕБЯ. Проверка «а остался ли ещё
      // хоть один админ» здесь не нужна и была бы недостижимой ветвью — автор
      // запроса сам является действующим администратором (иначе он не прошёл бы
      // `users.manage`), поэтому после снятия роли с ЛЮБОГО другого
      // пользователя администратор в портале остаётся. В отличие от подсчёта,
      // это сравнение не состоит из чтения и записи и потому не гонится.
      if (userId === auth.user.id && !roles.includes('admin')) {
        throw conflict(
          'Снять роль «admin» с собственной учётной записи нельзя: это отрезало бы доступ ' +
            'к администрированию. Попросите другого администратора.',
        );
      }

      const result = await replaceUserRoles(app.db, auth.scope, userId, roles);
      switch (result.status) {
        case 'not_found':
          throw notFound('Пользователь не найден.');
        case 'contractor_without_organization':
          throw conflict(
            'Роль «contractor» требует привязки к организации: без неё пользователь войдёт, ' +
              'но не увидит ни одной поставки. Сначала назначьте организацию.',
          );
        case 'ok':
          break;
      }

      await audit(app, request, {
        action: 'user.roles_changed',
        entityType: 'user',
        entityId: userId,
        payload: { roles: [...roles] },
      });
      return userCard(app, request, userId);
    },
  );

  app.put(
    `${PREFIX}/users/:id/object-scopes`,
    {
      schema: {
        params: idParamsSchema,
        body: userObjectScopesBodySchema,
        response: { 200: userCardResponseSchema },
      },
      preHandler: manage,
    },
    async (request) => {
      const auth = currentAuth(request);
      const userId = request.params.id;

      const result = await replaceUserObjectScopes(
        app.db,
        auth.scope,
        userId,
        request.body.objectIds,
      );
      switch (result.status) {
        case 'not_found':
          throw notFound('Пользователь не найден.');
        case 'unknown_objects':
          throw unprocessable(
            result.missing.map((id) => ({
              pointer: '/objectIds',
              code: 'unknown-object',
              message: `Объект ${id} не существует`,
            })),
            'В списке есть объекты, которых нет в справочнике.',
          );
        case 'ok':
          break;
      }

      await audit(app, request, {
        action: 'user.object_scopes_changed',
        entityType: 'user',
        entityId: userId,
        payload: { objectIds: [...request.body.objectIds] },
      });
      return userCard(app, request, userId);
    },
  );

  app.put(
    `${PREFIX}/users/:id/contractor`,
    {
      schema: {
        params: idParamsSchema,
        body: userContractorBodySchema,
        response: { 200: userCardResponseSchema },
      },
      preHandler: manage,
    },
    async (request) => {
      const auth = currentAuth(request);
      const userId = request.params.id;

      const result = await setUserContractor(app.db, auth.scope, userId, request.body.contractorId);
      switch (result.status) {
        case 'not_found':
          throw notFound('Пользователь не найден.');
        case 'unknown_contractor':
          throw unprocessable(
            [
              {
                pointer: '/contractorId',
                code: 'unknown-contractor',
                message: 'Организация не найдена, отключена или не является подрядчиком',
              },
            ],
            'Организацию назначить нельзя.',
          );
        case 'contractor_role_requires_organization':
          throw conflict(
            'У пользователя есть роль «contractor»: без организации он потеряет доступ ' +
              'ко всем поставкам. Сначала измените набор ролей.',
          );
        case 'ok':
          break;
      }

      await audit(app, request, {
        action: 'user.contractor_changed',
        entityType: 'user',
        entityId: userId,
        payload: { contractorId: request.body.contractorId },
      });
      return userCard(app, request, userId);
    },
  );

  app.post(
    `${PREFIX}/users/:id/activate`,
    {
      schema: { params: idParamsSchema, response: { 200: userCardResponseSchema } },
      preHandler: manage,
    },
    async (request) => {
      const auth = currentAuth(request);
      const changed = await setUserActive(app.db, auth.scope, request.params.id, true);
      if (!changed) throw notFound('Пользователь не найден.');

      await audit(app, request, {
        action: 'user.activated',
        entityType: 'user',
        entityId: request.params.id,
        payload: {},
      });
      return userCard(app, request, request.params.id);
    },
  );

  app.post(
    `${PREFIX}/users/:id/deactivate`,
    {
      schema: { params: idParamsSchema, response: { 200: userCardResponseSchema } },
      preHandler: manage,
    },
    async (request) => {
      const auth = currentAuth(request);
      const userId = request.params.id;

      // Тот же запрет, что и при снятии роли, и по той же причине: автор
      // запроса — действующий администратор, поэтому отключение любого ДРУГОГО
      // администратора портал без администрирования не оставляет, а отключение
      // себя оставляет и вернуть себя обратно уже нечем.
      if (userId === auth.user.id) {
        throw conflict(
          'Отключить собственную учётную запись нельзя: администратор, отключивший себя, ' +
            'не сможет включить себя обратно.',
        );
      }

      const changed = await setUserActive(app.db, auth.scope, userId, false);
      if (!changed) throw notFound('Пользователь не найден.');

      await audit(app, request, {
        action: 'user.deactivated',
        entityType: 'user',
        entityId: userId,
        payload: {},
      });
      return userCard(app, request, userId);
    },
  );
}

async function userCard(app: AppInstance, request: FastifyRequest, userId: string) {
  const { scope } = currentAuth(request);
  const user = await findUserById(app.db, scope, userId);
  if (user === null) throw notFound('Пользователь не найден.');
  const objectIds = await listUserObjectScopes(app.db, scope, userId);
  return { user: toUserResponse(user), objectIds: [...objectIds] };
}

function toUserResponse(user: UserSummary) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    position: user.position,
    isActive: user.isActive,
    contractorId: user.contractorId,
    roles: [...user.roles],
    createdAt: toIsoTimestamp(user.createdAt),
  };
}

/**
 * Метка времени из `users` в ISO-8601.
 *
 * `users.ts` отдаёт значение так, как его вернул драйвер, — в формате
 * PostgreSQL («2026-08-17 12:00:00+00»). Он не проходит `isoDateTimeSchema`, а
 * полагаться на снисходительность парсера `Date` к нестандартной строке нельзя,
 * поэтому разделитель ставится явно.
 */
function toIsoTimestamp(raw: string): string {
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw internal({ logDetail: 'метка времени из БД не разобрана как дата' });
  }
  return parsed.toISOString();
}

// =====================================================================
// Настройки
// =====================================================================

function registerSettingsRoutes(app: AppInstance): void {
  const manage = requirePermission('settings.manage');

  app.get(
    `${PREFIX}/settings`,
    { schema: { response: { 200: settingsResponseSchema } }, preHandler: manage },
    async (request) => {
      const { scope } = currentAuth(request);
      const stored = await readSettings(app.db, scope, SETTING_KEYS);
      const byKey = new Map(stored.map((row) => [row.key, row]));

      return {
        settings: SETTING_KEYS.map((key) => settingView(key, byKey.get(key) ?? null)),
        secrets: Object.keys(SECRET_SETTINGS).map((key) => secretView(app.env, key)),
        integrations: INTEGRATION_NAMES.map((name) => integrationView(app.env, name)),
      };
    },
  );

  app.put(
    `${PREFIX}/settings/:key`,
    {
      schema: {
        params: settingKeyParamsSchema,
        body: settingWriteBodySchema,
        response: { 200: settingResponseSchema },
      },
      preHandler: manage,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const key = request.params.key;

      // Проверка на секрет идёт ПЕРВОЙ, раньше поиска в реестре: незарегистри-
      // рованный ключ вида `proxy_llm.token` должен получить объяснение, где
      // живёт значение, а не безликое «нет такой настройки».
      const envVar = secretEnvVarFor(key);
      if (envVar !== null || looksSecret(key)) {
        throw unprocessable(
          [
            {
              pointer: '/value',
              code: 'secret-setting',
              message:
                envVar !== null
                  ? `Значение задаётся переменной окружения ${envVar}`
                  : 'Имя ключа указывает на секрет',
            },
          ],
          'Секреты в настройках портала не хранятся (§10): они живут в окружении, а API ' +
            'отдаёт только ссылку на переменную и статус подключения. Запись отклонена.',
        );
      }

      const definition = settingDefinition(key);
      if (definition === null) {
        throw notFound(
          'Такой настройки нет. Список настраиваемых ключей отдаёт GET /api/v1/admin/settings.',
        );
      }

      if (definition.managedBy !== undefined) {
        throw conflict(
          `Ключ «${key}» меняется только через ${definition.managedBy}: произвольная запись ` +
            'могла бы указать на неопубликованную версию.',
        );
      }

      const parsed = definition.schema.safeParse(request.body.value);
      if (!parsed.success) {
        throw unprocessable(
          parsed.error.issues.slice(0, 20).map((issue) => ({
            pointer: `/value${issue.path.length > 0 ? `/${issue.path.join('/')}` : ''}`,
            code: issue.code,
            message: issue.message,
          })),
          `Значение настройки «${key}» не прошло проверку.`,
        );
      }

      const row = await writeSetting(app.db, scope, {
        key,
        value: parsed.data,
        audit: auditEntry(app, request, {
          action: 'setting.updated',
          entityType: 'app_setting',
          entityId: key,
          payload: { key, value: parsed.data },
        }),
      });

      return settingView(key, row);
    },
  );
}

function settingView(key: string, row: SettingRow | null) {
  const definition = settingDefinition(key);
  return {
    key,
    title: definition?.title ?? key,
    value: row === null ? (definition?.defaultValue ?? null) : row.value,
    isDefault: row === null,
    managedBy: definition?.managedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/** Ни значения, ни его части: только адрес переменной и признак «задано». */
function secretView(env: Env, key: string) {
  const envVar = secretEnvVarFor(key);
  const configured = envVar !== null && envValue(env, envVar) !== undefined;
  return {
    key,
    reference: envVar === null ? 'env' : `env:${envVar}`,
    configured,
    masked: configured ? '••••••••' : null,
  };
}

const INTEGRATION_REQUIREMENTS: Readonly<Record<IntegrationName, readonly string[]>> = {
  oidc: ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'],
  storage: ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'],
  rdweb: ['RDWEB_BASE_URL', 'RDWEB_USER', 'RDWEB_PASSWORD'],
  proxy_llm: ['PROXY_LLM_BASE_URL', 'PROXY_LLM_TOKEN'],
  sentry: ['SENTRY_DSN'],
};

/**
 * Статус интеграции по составу окружения.
 *
 * `verified: false` стоит в схеме литералом: наличие переменных — это не
 * проверенная связь. Живая проба появляется вместе с адаптерами RD WEB и
 * proxy_llm; до тех пор портал не имеет права утверждать, что подключение есть.
 */
function integrationView(env: Env, name: IntegrationName) {
  const required = INTEGRATION_REQUIREMENTS[name];
  const missing = required.filter((variable) => envValue(env, variable) === undefined);

  if (integrationDisabled(env, name)) {
    return { name, status: 'disabled' as const, missing: [], verified: false as const };
  }

  return {
    name,
    status: missing.length === 0 ? ('configured' as const) : ('incomplete' as const),
    missing,
    verified: false as const,
  };
}

function integrationDisabled(env: Env, name: IntegrationName): boolean {
  switch (name) {
    case 'oidc':
      return env.AUTH_MODE !== 'oidc';
    case 'storage':
      return env.STORAGE_DRIVER !== 's3';
    case 'proxy_llm':
      return env.LLM_PROVIDER !== 'proxy_llm';
    case 'sentry':
      return env.ERROR_REPORTER !== 'sentry';
    case 'rdweb':
      return false;
  }
}

function envValue(env: Env, name: string): string | undefined {
  const value: unknown = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// =====================================================================
// Промты
// =====================================================================

function registerPromptRoutes(app: AppInstance): void {
  const manage = requirePermission('settings.manage');

  app.get(
    `${PREFIX}/prompts`,
    {
      schema: { querystring: promptListQuerySchema, response: { 200: promptPageResponseSchema } },
      preHandler: manage,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const page = await listPromptTemplates(app.db, scope, {
        limit: request.query.limit,
        cursor: request.query.cursor ?? null,
        code: request.query.code,
        stage: request.query.stage,
        state: request.query.state,
      });
      return { items: page.items.map(toPromptResponse), nextCursor: page.nextCursor };
    },
  );

  app.get(
    `${PREFIX}/prompts/:id`,
    {
      schema: { params: idParamsSchema, response: { 200: promptTemplateResponseSchema } },
      preHandler: manage,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const template = await findPromptTemplate(app.db, scope, request.params.id);
      if (template === null) throw notFound('Версия промта не найдена.');
      return toPromptResponse(template);
    },
  );

  app.post(
    `${PREFIX}/prompts`,
    {
      schema: { body: promptCreateBodySchema, response: { 201: promptTemplateResponseSchema } },
      preHandler: manage,
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const body = request.body;

      const result = await createPromptDraft(
        app.db,
        scope,
        {
          code: body.code,
          stage: body.stage,
          docTypeCode: body.docTypeCode,
          systemPrompt: body.systemPrompt,
          userTemplate: body.userTemplate,
          outputSchema: body.outputSchema,
          modelOverride: body.modelOverride,
        },
        auditEntry(app, request, {
          action: 'prompt.created',
          entityType: 'prompt_template',
          entityId: null,
          payload: { stage: body.stage, docTypeCode: body.docTypeCode },
        }),
      );

      switch (result.status) {
        case 'version_conflict':
          throw conflict(
            'Номер версии этого промта только что занят другим запросом. Повторите операцию.',
          );
        case 'unknown_doc_type':
          throw unprocessable(
            [
              {
                pointer: '/docTypeCode',
                code: 'unknown-doc-type',
                message: 'Вида ИД с таким кодом нет в справочнике',
              },
            ],
            'Промт нельзя привязать к несуществующему виду ИД.',
          );
        case 'ok':
          return reply.code(201).send(toPromptResponse(result.template));
      }
    },
  );

  app.patch(
    `${PREFIX}/prompts/:id`,
    {
      schema: {
        params: idParamsSchema,
        body: promptPatchBodySchema,
        response: { 200: promptTemplateResponseSchema },
      },
      preHandler: manage,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const body = request.body;

      const result = await guardImmutability(() =>
        updatePromptDraft(
          app.db,
          scope,
          request.params.id,
          {
            ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
            ...(body.userTemplate !== undefined ? { userTemplate: body.userTemplate } : {}),
            ...('outputSchema' in body ? { outputSchema: body.outputSchema } : {}),
            ...(body.modelOverride !== undefined ? { modelOverride: body.modelOverride } : {}),
          },
          auditEntry(app, request, {
            action: 'prompt.updated',
            entityType: 'prompt_template',
            entityId: request.params.id,
            payload: {},
          }),
          editableStates('prompt'),
        ),
      );

      switch (result.status) {
        case 'not_found':
          throw notFound('Версия промта не найдена.');
        case 'immutable': {
          const verdict =
            result.state === null
              ? null
              : evaluateContentEdit('prompt', result.state as GovernanceState);
          throw conflict(
            verdict !== null && !verdict.allowed
              ? verdict.explanation
              : 'Версию промта в этом состоянии править нельзя.',
          );
        }
        case 'ok':
          return toPromptResponse(result.template);
      }
    },
  );

  /**
   * Смена состояния промта, включая публикацию и откат.
   *
   * Один эндпоинт на все переходы, а не четыре: допустимость решает автомат
   * `governance.ts`, и он же единственный источник правды для интерфейса. Откат
   * — это переход `archived → published`, то есть возврат прежней версии как
   * есть; текст при этом не правится нигде.
   */
  app.post(
    `${PREFIX}/prompts/:id/state`,
    {
      schema: {
        params: idParamsSchema,
        body: promptStateBodySchema,
        response: { 200: promptTransitionResponseSchema },
      },
      preHandler: manage,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const current = await findPromptTemplate(app.db, scope, request.params.id);
      if (current === null) throw notFound('Версия промта не найдена.');

      const verdict = evaluateTransition('prompt', current.state, request.body.to);
      if (!verdict.allowed) {
        if (verdict.code === 'state-not-supported') {
          throw unprocessable(
            [{ pointer: '/to', code: verdict.code, message: verdict.explanation }],
            'Такого состояния у промта нет.',
          );
        }
        throw conflict(verdict.explanation);
      }

      const result = await guardImmutability(() =>
        transitionPrompt(
          app.db,
          scope,
          {
            id: request.params.id,
            from: current.state,
            to: request.body.to,
            archivesPreviousPublished: verdict.effects.archivesPreviousPublished,
            stampsPublication: verdict.effects.stampsPublication,
          },
          auditEntry(app, request, {
            action: verdict.kind === 'rollback' ? 'prompt.rolled_back' : 'prompt.state_changed',
            entityType: 'prompt_template',
            entityId: request.params.id,
            payload: { kind: verdict.kind },
          }),
        ),
      );

      switch (result.status) {
        case 'not_found':
          throw notFound('Версия промта не найдена.');
        case 'stale':
          throw conflict(
            `Состояние версии успело измениться на «${result.state}». Обновите список и ` +
              'повторите.',
          );
        case 'ok':
          return {
            template: toPromptResponse(result.template),
            kind: verdict.kind,
            archivedTemplateId: result.archivedTemplateId,
          };
      }
    },
  );
}

function toPromptResponse(row: PromptTemplateRow) {
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    // Стадия ограничена CHECK в БД и совпадает с перечислением схемы ответа.
    stage: row.stage as 'page_classify' | 'doc_split' | 'extract' | 'check' | 'summary',
    docTypeCode: row.docTypeCode,
    state: row.state,
    systemPrompt: row.systemPrompt,
    userTemplate: row.userTemplate,
    outputSchema: row.outputSchema,
    modelOverride: row.modelOverride,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Отказ триггера неизменяемости — это 409, а не 500.
 *
 * Триггеры 0008 — второй рубеж под проверками состояния в SQL: до них дело
 * доходит при гонке или при правке в обход API. Без перехвата администратор
 * получал бы «внутреннюю ошибку» на штатно запрещённой операции.
 */
async function guardImmutability<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (pgErrorCode(error) === PG_RESTRICT_VIOLATION) {
      throw conflict(
        'База данных отклонила изменение: запись неизменяема. Исправление вносится ' +
          'созданием новой версии.',
        { cause: error, logDetail: 'triggered restrict_violation (§3.9)' },
      );
    }
    throw error;
  }
}

// =====================================================================
// Правила и версии набора
// =====================================================================

function registerRulesetRoutes(app: AppInstance): void {
  const publish = requirePermission('rules.publish');

  app.get(
    `${PREFIX}/rules`,
    { schema: { response: { 200: ruleDefinitionListResponseSchema } }, preHandler: publish },
    async (request) => {
      const { scope } = currentAuth(request);
      const items = await listRuleDefinitions(app.db, scope);
      return { items: items.map((rule) => ({ ...rule, waiverRoles: [...rule.waiverRoles] })) };
    },
  );

  app.get(
    `${PREFIX}/rulesets`,
    {
      schema: { querystring: rulesetListQuerySchema, response: { 200: rulesetPageResponseSchema } },
      preHandler: publish,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const activeId = await activeRulesetVersionId(app, request);
      const page = await listRulesetVersions(app.db, scope, {
        limit: request.query.limit,
        cursor: request.query.cursor ?? null,
      });
      return {
        items: page.items.map((row) => toRulesetResponse(row, activeId)),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    `${PREFIX}/rulesets/:id`,
    {
      schema: { params: idParamsSchema, response: { 200: rulesetVersionDetailResponseSchema } },
      preHandler: publish,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const version = await findRulesetVersion(app.db, scope, request.params.id);
      if (version === null) throw notFound('Версия набора правил не найдена.');

      const activeId = await activeRulesetVersionId(app, request);
      const rules = await listRulesetRules(app.db, scope, version.id);
      return {
        version: toRulesetResponse(version, activeId),
        rules: rules.map((rule) => ({ ...rule })),
      };
    },
  );

  /**
   * Публикация версии набора правил вместе со снимком.
   *
   * Снимок передаётся целиком и записывается в одной транзакции с версией:
   * прогон проверок ссылается на версию по id, и полупустой снимок дал бы
   * результат, который невозможно ни воспроизвести, ни оспорить.
   */
  app.post(
    `${PREFIX}/rulesets`,
    {
      schema: { body: rulesetPublishBodySchema, response: { 201: rulesetVersionResponseSchema } },
      preHandler: publish,
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const body = request.body;

      // Допустимость перехода спрашивается у автомата, а не подразумевается:
      // если у набора правил однажды появится стадия проверки, эндпоинт узнает
      // об этом отсюда, а не пропустит публикацию мимо неё.
      const verdict = evaluateTransition('ruleset', 'draft', 'published');
      if (!verdict.allowed) throw conflict(verdict.explanation);

      const result = await guardImmutability(() =>
        publishRulesetVersion(
          app.db,
          scope,
          {
            version: body.version,
            notes: body.notes,
            activate: body.activate,
            activeVersionKey: RULESET_ACTIVE_VERSION_KEY,
            rules: body.rules.map((rule) => ({
              ruleCode: rule.ruleCode,
              isEnabled: rule.isEnabled,
              severity: rule.severity,
              isBlocking: rule.isBlocking,
              params: rule.params,
            })),
          },
          auditEntry(app, request, {
            action: 'ruleset.published',
            entityType: 'ruleset_version',
            entityId: null,
            payload: {},
          }),
        ),
      );

      switch (result.status) {
        case 'duplicate_version':
          throw conflict(
            `Версия набора «${body.version}» уже существует. Опубликованная версия ` +
              'неизменяема, поэтому новый набор публикуется под новой меткой.',
          );
        case 'unknown_rule_codes':
          throw unprocessable(
            result.missing.map((code) => ({
              pointer: '/rules',
              code: 'unknown-rule',
              message: `Правило ${code} не заведено в реестре`,
            })),
            'Снимок ссылается на правила, которых нет в реестре.',
          );
        case 'ok':
          return reply
            .code(201)
            .send(toRulesetResponse(result.version, result.activated ? result.version.id : null));
      }
    },
  );

  /**
   * Переключение действующей версии — он же откат.
   *
   * Именно переключение указателя, а не правка: опубликованная версия и её
   * снимок неизменяемы, поэтому «вернуть прежние правила» означает сделать
   * действующей прежнюю версию. Все выполненные прогоны продолжают ссылаться на
   * ту версию, по которой считались.
   */
  app.post(
    `${PREFIX}/rulesets/:id/activate`,
    {
      schema: { params: idParamsSchema, response: { 200: rulesetVersionResponseSchema } },
      preHandler: publish,
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const result = await activateRulesetVersion(
        app.db,
        scope,
        { versionId: request.params.id, activeVersionKey: RULESET_ACTIVE_VERSION_KEY },
        auditEntry(app, request, {
          action: 'ruleset.activated',
          entityType: 'ruleset_version',
          entityId: request.params.id,
          payload: {},
        }),
      );

      switch (result.status) {
        case 'not_found':
          throw notFound('Версия набора правил не найдена.');
        case 'not_published':
          throw conflict(
            'Действующей можно сделать только опубликованную версию: иначе прогон проверок ' +
              'сослался бы на черновик.',
          );
        case 'ok':
          break;
      }

      const version = await findRulesetVersion(app.db, scope, request.params.id);
      if (version === null) throw notFound('Версия набора правил не найдена.');
      return toRulesetResponse(version, version.id);
    },
  );
}

async function activeRulesetVersionId(
  app: AppInstance,
  request: FastifyRequest,
): Promise<string | null> {
  const { scope } = currentAuth(request);
  const row = await readSetting(app.db, scope, RULESET_ACTIVE_VERSION_KEY);
  return typeof row?.value === 'string' ? row.value : null;
}

function toRulesetResponse(row: RulesetVersionRow, activeVersionId: string | null) {
  return {
    id: row.id,
    version: row.version,
    // Состояния как колонки у версии набора нет: она либо черновик, либо
    // опубликована навсегда (§3.9), и это выражено наличием `published_at`.
    state: row.publishedAt === null ? ('draft' as const) : ('published' as const),
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    notes: row.notes,
    createdAt: row.createdAt,
    ruleCount: row.ruleCount,
    isActive: activeVersionId !== null && activeVersionId === row.id,
  };
}

// =====================================================================
// Аудит
// =====================================================================

interface AuditFields {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly payload: Record<string, unknown>;
}

function auditEntry(app: AppInstance, request: FastifyRequest, fields: AuditFields): AuditEntry {
  const auth = currentAuth(request);
  return {
    ...fields,
    actorUserId: auth.user.id,
    actorEmailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

async function audit(
  app: AppInstance,
  request: FastifyRequest,
  fields: AuditFields,
): Promise<void> {
  const { scope } = currentAuth(request);
  await appendAuditLog(app.db, scope, auditEntry(app, request, fields));
}
