/**
 * Схемы администрирования: тела запросов, ответы и реестр настроек.
 *
 * Главное здесь — реестр `app_settings`. Он существует не для документации:
 * записывать разрешено ТОЛЬКО объявленный ключ. Открытая на запись таблица
 * «ключ → jsonb» рано или поздно получает строку `proxy_llm.token`, потому что
 * так удобнее, чем править окружение и перезапускать контейнер, — и секрет
 * оказывается в БД, в её бэкапах и в реплике. Поэтому:
 *
 *   1. незнакомый ключ отвергается (404) — реестр закрыт;
 *   2. ключи, за которыми стоит секрет, объявлены явно (`SECRET_SETTINGS`) и
 *      отвергаются с указанием переменной окружения, где значение живёт;
 *   3. поверх списка работает проверка по форме имени (`looksSecret`) — она
 *      ловит ключ, который завели в реестр, не подумав.
 *
 * Третья проверка избыточна по отношению к первым двум ровно до того дня, когда
 * в реестр добавят `rdweb.api_key`. Цена ложного срабатывания — переименовать
 * настройку; цена пропуска — секрет в резервных копиях.
 */
import { z } from 'zod';
import {
  codeSlugSchema,
  cursorPageSchema,
  DEFAULT_PAGE_LIMIT,
  detectionProviderSettingSchema,
  docTypeCodeSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  MAX_PAGE_LIMIT,
  promptStateSchema,
  recognitionProviderSettingSchema,
  ruleCodeSchema,
  severitySchema,
  userRoleSchema,
  uuidSchema,
  type JsonValue,
} from '@id/contracts';

/**
 * Параметры страницы в строке запроса.
 *
 * Пределы взяты из `@id/contracts`, но `limit` объявлен через `z.coerce`, а не
 * через готовый `cursorPageQuerySchema`: в query всё приходит строкой, и
 * `z.int()` строку «50» не принимает — эндпоинт отвечал бы 422 на собственное
 * значение по умолчанию. Проверено прогоном: `?limit=50` давал 422.
 */
export const adminPageQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

// =====================================================================
// Настройки
// =====================================================================

/** Ключ настройки: слаги через точку. Совпадает с `app_settings.key`. */
export const settingKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/,
    'Ключ настройки — слаги в нижнем регистре через точку',
  );

/**
 * Ключи, за которыми стоит секрет, и переменная окружения, где он лежит (§10).
 *
 * Список нужен именно как список, а не как «всё, что похоже на секрет»: он
 * позволяет ответить на попытку записи по существу — назвать переменную, а не
 * просто отказать.
 */
export const SECRET_SETTINGS = {
  'auth.oidc_client_secret': 'OIDC_CLIENT_SECRET',
  'auth.session_enc_key': 'SESSION_ENC_KEY',
  'auth.csrf_secret': 'CSRF_SECRET',
  'audit.hmac_key': 'AUDIT_HMAC_KEY',
  'database.url': 'DATABASE_URL',
  'storage.s3_access_key': 'S3_ACCESS_KEY',
  'storage.s3_secret_key': 'S3_SECRET_KEY',
  'rdweb.user': 'RDWEB_USER',
  'rdweb.password': 'RDWEB_PASSWORD',
  'ai.proxy_llm_token': 'PROXY_LLM_TOKEN',
  'observability.sentry_dsn': 'SENTRY_DSN',
} as const satisfies Record<string, string>;

export type SecretSettingKey = keyof typeof SECRET_SETTINGS;

/**
 * Слова, наличие которых в имени ключа означает секрет.
 *
 * `key` включён целиком, без уточнений: `access_key`, `enc_key`, `api_key` — и
 * любое следующее имя того же рода. Настройка, законно содержащая слово `key`,
 * переименовывается; секрет, попавший в `app_settings`, уезжает в бэкапы.
 */
const SECRET_NAME_PATTERN =
  /(^|[._])(secret|secrets|password|passwd|token|credential|credentials|key|dsn|private|signature)([._]|$)/;

export function looksSecret(key: string): boolean {
  return SECRET_NAME_PATTERN.test(key);
}

export function secretEnvVarFor(key: string): string | null {
  return key in SECRET_SETTINGS ? SECRET_SETTINGS[key as SecretSettingKey] : null;
}

export interface SettingDefinition {
  readonly title: string;
  /** Схема значения. Значение хранится в `app_settings.value` как jsonb. */
  readonly schema: z.ZodType;
  /** Значение по умолчанию: строки в `app_settings` может не быть вовсе. */
  readonly defaultValue: JsonValue;
  /**
   * Эндпоинт, которому принадлежит ключ.
   *
   * Указатель активной версии набора правил меняется публикацией и откатом, а не
   * произвольной записью: иначе он мог бы указать на неопубликованную версию, и
   * прогон проверок сослался бы на черновик.
   */
  readonly managedBy?: string;
}

export const RULESET_ACTIVE_VERSION_KEY = 'ruleset.active_version_id';

export const SETTINGS_REGISTRY = {
  'ai.enabled': {
    title: 'Стадии AI включены',
    schema: z.boolean(),
    defaultValue: false,
  },
  'ai.dry_run_only': {
    title: 'Промты выполняются только в режиме dry-run, без записи результатов',
    schema: z.boolean(),
    defaultValue: true,
  },
  'ai.monthly_budget_rub': {
    title: 'Месячный бюджет обращений к LLM, рубли',
    schema: z.number().nonnegative().max(10_000_000),
    defaultValue: 0,
  },
  'rdweb.enabled': {
    title: 'Интеграция с RD WEB включена',
    schema: z.boolean(),
    defaultValue: true,
  },
  /**
   * Ветка распознавания (ADR-0007). Действует только на НОВЫЕ прогоны:
   * выполняющийся прогон читает собственный settings_snapshot.
   */
  'recognition.provider': {
    title: 'Провайдер распознавания',
    schema: recognitionProviderSettingSchema,
    defaultValue: 'rdweb',
  },
  /**
   * Слаг модели OpenRouter для VLM-распознавания. Пусто — модель не выбрана,
   * прогон с провайдером openrouter_vlm честно отказывает (409), как это
   * делает recognitionSelections при ненастроенном OCR RD WEB.
   */
  'recognition.vlm_model': {
    title: 'Модель OpenRouter для распознавания (слаг)',
    schema: z
      .string()
      .max(200)
      .regex(/^$|^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.:-]*$/i, {
        message: 'Слаг модели OpenRouter — «vendor/model», например qwen/qwen3-vl-235b',
      }),
    defaultValue: '',
  },
  /** Ветка детекции блоков (ADR-0008): RD WEB или локальный RF-DETR на CPU. */
  'detection.provider': {
    title: 'Провайдер детекции блоков',
    schema: detectionProviderSettingSchema,
    defaultValue: 'rdweb',
  },
  /**
   * Версия локальной модели детекции — префикс ключа в хранилище
   * (`models/detection/{version}/`). Пусто — модель не загружена, локальная
   * детекция честно отказывает; ручная разметка работает всегда.
   */
  'detection.model_version': {
    title: 'Версия локальной модели детекции (RF-DETR)',
    schema: z
      .string()
      .max(64)
      .regex(/^$|^[a-z0-9][a-z0-9._-]*$/, {
        message: 'Версия модели — слаг из латиницы, цифр, точки, дефиса и подчёркивания',
      }),
    defaultValue: '',
  },
  'checks.autorun_after_documents': {
    title: 'Запускать проверки сразу после подтверждения документов',
    schema: z.boolean(),
    defaultValue: false,
  },
  'doc_type_candidates.min_occurrences': {
    title: 'Сколько раз должен встретиться заголовок, чтобы попасть в кандидаты видов ИД',
    schema: z.int().min(1).max(1000),
    defaultValue: 3,
  },
  [RULESET_ACTIVE_VERSION_KEY]: {
    title: 'Действующая версия набора правил',
    schema: uuidSchema.nullable(),
    defaultValue: null,
    managedBy: 'POST /api/v1/admin/rulesets/{id}/activate',
  },
  'portal.maintenance_notice': {
    title: 'Объявление в интерфейсе портала',
    schema: z.string().max(1000),
    defaultValue: '',
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;

export const SETTING_KEYS: readonly SettingKey[] = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export function settingDefinition(key: string): SettingDefinition | null {
  return key in SETTINGS_REGISTRY ? SETTINGS_REGISTRY[key as SettingKey] : null;
}

/** Интеграции, состояние подключения которых отдаётся вместо секретов (§10). */
export const INTEGRATION_NAMES = ['oidc', 'storage', 'rdweb', 'proxy_llm', 'sentry'] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];

// =====================================================================
// Пользователи
// =====================================================================

export const idParamsSchema = z.object({ id: uuidSchema });

export const userListQuerySchema = adminPageQuerySchema;

/**
 * Набор бизнес-ролей пользователя.
 *
 * `contractor` не совмещается ни с чем: при нескольких ролях право на загрузку
 * и право на согласование сложились бы у одного человека (`hasPermission`
 * смотрит на весь набор), и подрядчик согласовывал бы собственную поставку.
 * Остальные сочетания законны и предусмотрены §4.1 — в частности `admin` +
 * `manager`, без которого администратор не согласует ИД.
 */
export const userRolesBodySchema = z
  .object({ roles: z.array(userRoleSchema).max(4) })
  .refine((body) => new Set(body.roles).size === body.roles.length, {
    message: 'Роль указана дважды',
    path: ['roles'],
  })
  .refine((body) => !body.roles.includes('contractor') || body.roles.length === 1, {
    message:
      'Роль «contractor» не совмещается с другими: иначе один человек и подаёт поставку, ' +
      'и согласует её',
    path: ['roles'],
  });

export const userObjectScopesBodySchema = z
  .object({ objectIds: z.array(uuidSchema).max(500) })
  .refine((body) => new Set(body.objectIds).size === body.objectIds.length, {
    message: 'Объект указан дважды',
    path: ['objectIds'],
  });

export const userContractorBodySchema = z.object({ contractorId: uuidSchema.nullable() });

export const userSummaryResponseSchema = z.object({
  id: uuidSchema,
  email: z.string().nullable(),
  fullName: z.string(),
  position: z.string().nullable(),
  isActive: z.boolean(),
  contractorId: uuidSchema.nullable(),
  roles: z.array(userRoleSchema),
  createdAt: isoDateTimeSchema,
});

export const userPageResponseSchema = cursorPageSchema(userSummaryResponseSchema);

export const userCardResponseSchema = z.object({
  user: userSummaryResponseSchema,
  objectIds: z.array(uuidSchema),
});

// =====================================================================
// Настройки: запросы и ответы
// =====================================================================

export const settingKeyParamsSchema = z.object({ key: settingKeySchema });

export const settingWriteBodySchema = z.object({ value: jsonValueSchema });

export const settingResponseSchema = z.object({
  key: settingKeySchema,
  title: z.string(),
  value: jsonValueSchema,
  /** Значение отдано из реестра, потому что строки в `app_settings` нет. */
  isDefault: z.boolean(),
  managedBy: z.string().nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
  updatedBy: uuidSchema.nullable(),
});

/**
 * Секрет наружу.
 *
 * Ни значения, ни его префикса, ни длины: по префиксу токена определяется
 * провайдер, по длине — алгоритм. Отдаётся ссылка на место хранения и признак
 * «задано».
 */
export const secretReferenceResponseSchema = z.object({
  key: settingKeySchema,
  reference: z.string(),
  configured: z.boolean(),
  masked: z.string().nullable(),
});

/**
 * Состояние интеграции.
 *
 * `verified` всегда `false`: наличие переменных окружения — это не проверенное
 * подключение. Живая проба появляется вместе с адаптерами RD WEB и proxy_llm;
 * до тех тех пор портал не имеет права утверждать, что связь есть.
 */
export const integrationStatusResponseSchema = z.object({
  name: z.enum(INTEGRATION_NAMES),
  status: z.enum(['configured', 'incomplete', 'disabled']),
  missing: z.array(z.string()),
  verified: z.literal(false),
});

export const settingsResponseSchema = z.object({
  settings: z.array(settingResponseSchema),
  secrets: z.array(secretReferenceResponseSchema),
  integrations: z.array(integrationStatusResponseSchema),
});

// =====================================================================
// Промты
// =====================================================================

/**
 * Стадия промта.
 *
 * Дословно повторяет `prompt_templates_stage_chk`. В `@id/contracts` этого
 * перечисления нет, а расхождение с БД обязано ловиться на границе API, а не
 * ошибкой 23514 из драйвера.
 */
export const promptStageSchema = z.enum([
  'page_classify',
  'doc_split',
  'extract',
  'check',
  'summary',
  'recognize',
]);

export const promptListQuerySchema = adminPageQuerySchema.extend({
  code: codeSlugSchema.optional(),
  stage: promptStageSchema.optional(),
  state: promptStateSchema.optional(),
});

const promptContentSchema = z.object({
  systemPrompt: z.string().min(1).max(100_000),
  userTemplate: z.string().min(1).max(100_000),
  outputSchema: jsonValueSchema.nullable(),
  modelOverride: z.string().min(1).max(256).nullable(),
});

export const promptCreateBodySchema = promptContentSchema.extend({
  code: codeSlugSchema,
  stage: promptStageSchema,
  /**
   * Тип ИД, к которому привязан промт. `null` — промт общего назначения:
   * незнакомый тип документа обязан обрабатываться, а не проваливаться (§0.5).
   */
  docTypeCode: docTypeCodeSchema.nullable(),
});

/** Правка черновика: любое подмножество полей содержимого, но не пустое. */
export const promptPatchBodySchema = promptContentSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Нет полей для изменения' });

export const promptStateBodySchema = z.object({ to: promptStateSchema });

export const promptTemplateResponseSchema = z.object({
  id: uuidSchema,
  code: codeSlugSchema,
  version: z.int().positive(),
  stage: promptStageSchema,
  docTypeCode: docTypeCodeSchema.nullable(),
  state: promptStateSchema,
  systemPrompt: z.string(),
  userTemplate: z.string(),
  outputSchema: jsonValueSchema.nullable(),
  modelOverride: z.string().nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  publishedBy: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const promptPageResponseSchema = cursorPageSchema(promptTemplateResponseSchema);

export const promptTransitionResponseSchema = z.object({
  template: promptTemplateResponseSchema,
  kind: z.enum(['promote', 'demote', 'publish', 'rollback', 'archive']),
  /** Версия, снятая с публикации этим переходом. */
  archivedTemplateId: uuidSchema.nullable(),
});

// =====================================================================
// Набор правил
// =====================================================================

/**
 * Метка версии набора.
 *
 * `ruleset_versions.version` — текст без CHECK в схеме, поэтому формат задаётся
 * здесь: и `2026.08.1`, и `1.4.0`, и `2026-08-17` проходят, а пробелы и
 * управляющие символы — нет.
 */
export const rulesetVersionLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[0-9A-Za-z][0-9A-Za-z._-]*$/,
    'Метка версии — латиница, цифры, точка, дефис, подчёркивание',
  );

export const rulesetRuleInputSchema = z.object({
  ruleCode: ruleCodeSchema,
  isEnabled: z.boolean().default(true),
  severity: severitySchema,
  isBlocking: z.boolean().default(false),
  params: jsonValueSchema.default({}),
});

export const rulesetPublishBodySchema = z
  .object({
    version: rulesetVersionLabelSchema,
    notes: z.string().max(4000).nullable(),
    /** Сделать версию действующей сразу. По умолчанию да. */
    activate: z.boolean().default(true),
    /**
     * Снимок целиком, а не дельта: версия набора обязана быть самодостаточной,
     * иначе прогон месячной давности воспроизводится только вместе с историей
     * правок реестра.
     */
    rules: z.array(rulesetRuleInputSchema).min(1).max(2000),
  })
  .refine((body) => new Set(body.rules.map((rule) => rule.ruleCode)).size === body.rules.length, {
    message: 'Код правила указан в снимке дважды',
    path: ['rules'],
  });

export const rulesetListQuerySchema = adminPageQuerySchema;

export const rulesetRuleResponseSchema = z.object({
  ruleCode: ruleCodeSchema,
  isEnabled: z.boolean(),
  severity: severitySchema,
  isBlocking: z.boolean(),
  params: jsonValueSchema,
});

export const rulesetVersionResponseSchema = z.object({
  id: uuidSchema,
  version: rulesetVersionLabelSchema,
  state: z.enum(['draft', 'published']),
  publishedAt: isoDateTimeSchema.nullable(),
  publishedBy: uuidSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  ruleCount: z.int().nonnegative(),
  isActive: z.boolean(),
});

export const rulesetPageResponseSchema = cursorPageSchema(rulesetVersionResponseSchema);

export const rulesetVersionDetailResponseSchema = z.object({
  version: rulesetVersionResponseSchema,
  rules: z.array(rulesetRuleResponseSchema),
});

export const ruleDefinitionResponseSchema = z.object({
  code: ruleCodeSchema,
  title: z.string(),
  docTypeCode: docTypeCodeSchema.nullable(),
  level: z.string(),
  kind: z.string(),
  defaultSeverity: severitySchema,
  waiverRoles: z.array(userRoleSchema),
});

export const ruleDefinitionListResponseSchema = z.object({
  items: z.array(ruleDefinitionResponseSchema),
});
