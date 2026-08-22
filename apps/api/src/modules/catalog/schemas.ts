/**
 * Схемы запросов и ответов справочников (§3.2).
 *
 * Две вещи, которые здесь сделаны сознательно и легко «исправить» неверно.
 *
 * **1. Контрольные суммы проверяются на ВХОДЕ справочника, но не в контрактах.**
 * `innSchema` и `ogrnSchema` из `@id/contracts` проверяют только длину и цифры —
 * и это правильно там: реквизит, извлечённый из документа, обязан доехать до
 * движка правил замечанием, а не быть отброшенным на границе как «невалидный
 * ввод». Один из семи известных дефектов корпуса — ОГРН из 12 цифр, и он должен
 * попасть в `findings`, а не в 422. Здесь ситуация обратная: администратор
 * заводит карточку контрагента вручную, и битая контрольная сумма — это
 * опечатка, которую нужно показать сразу. Поэтому вход справочника строже
 * контракта, и обе строгости уместны каждая на своём месте.
 *
 * **2. Значения строки запроса приводятся из строк явно.** Fastify отдаёт
 * querystring строками, а `cursorPageQuerySchema` из контрактов описывает
 * `limit` как `z.int()` — то есть `?limit=10` этой схемой не прошёл бы вовсе.
 * Схема контрактов остаётся формой для тела и для клиента; здесь берётся
 * `z.coerce`, а границы страницы — те же константы контрактов, чтобы предел
 * выдачи не разъехался между слоями.
 */
import { z } from 'zod';
import {
  autonomyLevelSchema,
  constructionObjectSchema,
  counterpartyKindCodeSchema,
  counterpartyKindEntrySchema,
  counterpartyKindSchema,
  counterpartySchema,
  cursorPageSchema,
  DEFAULT_PAGE_LIMIT,
  docTypeCodeSchema,
  isoDateSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  MAX_PAGE_LIMIT,
  objectCodeSchema,
  objectSectionSchema,
  ruleCodeSchema,
  sectionKindCodeSchema,
  sectionProfileSchema,
  sortOrderSchema,
  uuidSchema,
} from '@id/contracts';
import type { DocTypeGroup, DocTypeKind } from '@id/doc-types';
import { checkInn, checkKpp, checkOgrn, type IdentifierCheck } from '../../lib/validators.js';
import type {
  DocTypeCandidateReviewStatus,
  DocTypeCandidateStatus,
} from '../../db/repositories/catalog.js';

// =====================================================================
// Перечисления, которых нет в контрактах
// =====================================================================

/** Ошибка компиляции, если утверждение не выполнено. */
type Assert<TCondition extends true> = TCondition;

const DOC_TYPE_GROUPS = [
  'acts',
  'exec_schemes',
  'registries_logs',
  'quality_docs',
  'tests_conclusions',
  'networks',
  'facade',
  'org',
  'handover',
  'fallback',
] as const satisfies readonly DocTypeGroup[];

const DOC_TYPE_KINDS = [
  'primary',
  'registry',
  'evidence',
  'fallback',
] as const satisfies readonly DocTypeKind[];

const DOC_TYPE_CANDIDATE_STATUSES = [
  'new',
  'reviewing',
  'mapped',
  'ignored',
] as const satisfies readonly DocTypeCandidateStatus[];

/**
 * Группа или роль, добавленная в `@id/doc-types` и забытая здесь, обязана ломать
 * сборку.
 *
 * `satisfies` выше ловит только ЛИШНЕЕ значение. Пропущенное значение он не
 * замечает, а именно оно опаснее: тип, заведённый в новой группе, не прошёл бы
 * валидацию тела и выглядел бы как ошибка администратора.
 */
export type DocTypeEnumsAreExhaustive = Assert<
  [
    Exclude<DocTypeGroup, (typeof DOC_TYPE_GROUPS)[number]>,
    Exclude<DocTypeKind, (typeof DOC_TYPE_KINDS)[number]>,
    Exclude<DocTypeCandidateStatus, (typeof DOC_TYPE_CANDIDATE_STATUSES)[number]>,
  ] extends [never, never, never]
    ? true
    : false
>;

export const docTypeGroupSchema = z.enum(DOC_TYPE_GROUPS);
export const docTypeKindSchema = z.enum(DOC_TYPE_KINDS);
export const docTypeCandidateStatusSchema = z.enum(DOC_TYPE_CANDIDATE_STATUSES);

const DOC_TYPE_CANDIDATE_REVIEW_STATUSES = [
  'new',
  'reviewing',
  'ignored',
] as const satisfies readonly DocTypeCandidateReviewStatus[];

export const docTypeCandidateReviewStatusSchema = z.enum(DOC_TYPE_CANDIDATE_REVIEW_STATUSES);

/**
 * Категории материалов профиля раздела — ЗАКРЫТЫЙ перечень, и это не оплошность
 * рядом с открытым каталогом видов ИД.
 *
 * Виды ИД и виды разделов растут эксплуатацией (§0.5): новый тип документа
 * приносит польза сразу — его можно распознать, подтвердить, сложить в комплект.
 * Категория материала так не работает: она осмысленна ровно настолько, насколько
 * её понимают матрица требований и правила §9.4 («на арматуру нужен сертификат и
 * протокол испытаний», «на товарную смесь — паспорт качества партии»). Категория,
 * которой не знает ни одно правило, не добавляет проверок — она добавляет
 * молчание, а профиль с опечаткой в категории выглядел бы настроенным. Поэтому
 * перечень пополняется релизом вместе с правилами, а не полем в форме.
 *
 * ✓ — категория подтверждена корпусом двух разделов. Остальные взяты из
 * нормативного состава; требования к ним не калиброваны, и это отмечено здесь,
 * а не выяснится на первом же прогоне.
 */
// Перечень живёт в @id/contracts: его используют и схема входа, и репозиторий
// профилей правил, и движок правил. Здесь только реэкспорт.
import { materialCategoryCodeSchema } from '@id/contracts';

export { materialCategoryCodeSchema };

// =====================================================================
// Реквизиты с контрольной суммой
// =====================================================================

/**
 * Текст отказа различает длину и контрольную сумму.
 *
 * Не для красоты: «ИНН — 10 или 12 цифр» и «контрольная сумма не сходится» —
 * разные действия администратора. В первом случае он не дописал знак, во втором
 * значение выглядит правдоподобно и его нужно сверить с выпиской.
 */
function rejectionText(label: string, lengths: string, result: IdentifierCheck): string {
  if (result.ok) return '';
  switch (result.defect) {
    case 'empty':
      return `${label} не заполнен.`;
    case 'non_digits':
      return `${label} содержит посторонние символы: допустимы только цифры.`;
    case 'length':
      return `${label} — ${lengths}.`;
    case 'checksum':
      return `Контрольная сумма ${label} не сходится: ожидалась цифра ${
        result.checksum?.expected ?? '?'
      }, указана ${result.checksum?.actual ?? '?'}.`;
  }
}

function identifierSchema(
  label: string,
  lengths: string,
  check: (value: string) => IdentifierCheck,
) {
  return z.string().superRefine((value, ctx) => {
    const result = check(value);
    if (!result.ok) ctx.addIssue(rejectionText(label, lengths, result));
  });
}

export const innInputSchema = identifierSchema(
  'ИНН',
  '10 цифр у организации или 12 у физического лица',
  checkInn,
);

export const kppInputSchema = identifierSchema('КПП', '9 цифр', checkKpp);

export const ogrnInputSchema = identifierSchema(
  'ОГРН',
  '13 цифр у организации или 15 (ОГРНИП)',
  checkOgrn,
);

// =====================================================================
// Общие параметры
// =====================================================================

/**
 * Страница выдачи. `limit` приводится из строки запроса (см. заголовок файла).
 */
const pageQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

/** Флаг в строке запроса: `?isActive=true`. Отсутствие означает «любые». */
const queryFlagSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

const searchQuerySchema = z.object({
  search: z.string().min(1).max(200).optional(),
  isActive: queryFlagSchema.optional(),
});

/** Пустая правка — ошибка запроса, а не обновление нуля полей. */
function nonEmptyPatch(body: object): boolean {
  return Object.keys(body).length > 0;
}

const EMPTY_PATCH_MESSAGE = 'Запрос не содержит ни одного изменяемого поля.';

// =====================================================================
// Параметры пути
// =====================================================================

export const objectIdParamSchema = z.object({ objectId: uuidSchema });
export const counterpartyIdParamSchema = z.object({ counterpartyId: uuidSchema });
export const sectionIdParamSchema = z.object({ sectionId: uuidSchema });
export const rdDocumentIdParamSchema = z.object({ rdDocumentId: uuidSchema });
export const profileIdParamSchema = z.object({ profileId: uuidSchema });
export const candidateIdParamSchema = z.object({ candidateId: uuidSchema });
export const docTypeCodeParamSchema = z.object({ code: docTypeCodeSchema });
export const sectionKindCodeParamSchema = z.object({ kindCode: sectionKindCodeSchema });

// =====================================================================
// Объекты строительства
// =====================================================================

export const objectListQuerySchema = pageQuerySchema.extend(searchQuerySchema.shape);

export const createConstructionObjectBodySchema = z.object({
  code: objectCodeSchema,
  name: z.string().min(1).max(255),
  fullName: z.string().min(1).max(1000),
  address: z.string().max(1000).nullish(),
  developerId: uuidSchema.nullish(),
  techCustomerId: uuidSchema.nullish(),
  generalContractorId: uuidSchema.nullish(),
  actNumberPattern: z.string().max(255).nullish(),
  cadastralNumber: z.string().max(255).nullish(),
  permitIdentifier: z.string().max(255).nullish(),
});

/** `code` в правку не входит: он внешне значим (см. репозиторий). */
export const updateConstructionObjectBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    fullName: z.string().min(1).max(1000).optional(),
    address: z.string().max(1000).nullish(),
    isActive: z.boolean().optional(),
    developerId: uuidSchema.nullish(),
    techCustomerId: uuidSchema.nullish(),
    generalContractorId: uuidSchema.nullish(),
    actNumberPattern: z.string().max(255).nullish(),
    cadastralNumber: z.string().max(255).nullish(),
    permitIdentifier: z.string().max(255).nullish(),
  })
  .refine(nonEmptyPatch, { message: EMPTY_PATCH_MESSAGE });

export const constructionObjectPageSchema = cursorPageSchema(constructionObjectSchema);

// =====================================================================
// Контрагенты
// =====================================================================

export const counterpartyListQuerySchema = pageQuerySchema
  .extend(searchQuerySchema.shape)
  .extend({ kind: counterpartyKindSchema.optional() });

export const createCounterpartyBodySchema = z.object({
  name: z.string().min(1).max(500),
  kind: counterpartyKindSchema,
  inn: innInputSchema.nullish(),
  kpp: kppInputSchema.nullish(),
  ogrn: ogrnInputSchema.nullish(),
  legalAddress: z.string().max(1000).nullish(),
});

export const updateCounterpartyBodySchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    kind: counterpartyKindSchema.optional(),
    inn: innInputSchema.nullish(),
    kpp: kppInputSchema.nullish(),
    ogrn: ogrnInputSchema.nullish(),
    legalAddress: z.string().max(1000).nullish(),
    isActive: z.boolean().optional(),
  })
  .refine(nonEmptyPatch, { message: EMPTY_PATCH_MESSAGE });

export const counterpartyPageSchema = cursorPageSchema(counterpartySchema);

/**
 * Виды контрагентов (миграция 0027).
 *
 * `sortOrder` в теле создания необязателен: порядок в списке — вопрос вкуса, а
 * не смысла, и требовать его на каждом заведении значило бы просить у
 * администратора число, которого он не знает. Умолчание задаёт таблица.
 */
export const createCounterpartyKindBodySchema = z.object({
  code: counterpartyKindCodeSchema,
  name: z.string().min(1).max(255),
  sortOrder: sortOrderSchema.optional(),
});

export const counterpartyKindListSchema = z.array(counterpartyKindEntrySchema);

// =====================================================================
// Разделы работ и их виды
// =====================================================================

export const sectionListQuerySchema = z.object({ isActive: queryFlagSchema.optional() });

export const createObjectSectionBodySchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  sectionKindCode: sectionKindCodeSchema,
  sortOrder: sortOrderSchema.optional(),
});

export const updateObjectSectionBodySchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    sectionKindCode: sectionKindCodeSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(nonEmptyPatch, { message: EMPTY_PATCH_MESSAGE });

export const objectSectionListSchema = z.array(objectSectionSchema);

export const sectionKindSchema = z.object({
  code: sectionKindCodeSchema,
  name: z.string().min(1).max(255),
});

export const sectionKindListSchema = z.array(sectionKindSchema);

// =====================================================================
// Профили видов разделов
// =====================================================================

export const sectionProfileListQuerySchema = z.object({
  sectionKindCode: sectionKindCodeSchema.optional(),
});

/** Дата, на которую нужен действующий профиль. По умолчанию — текущая по UTC. */
export const effectiveProfileQuerySchema = z.object({ at: isoDateSchema.optional() });

/**
 * Новая версия профиля.
 *
 * `version` в теле нет: номер назначает репозиторий, иначе два администратора
 * назвали бы своими правками одну и ту же версию.
 *
 * **Что проверяет схема, а что репозиторий — и почему граница именно здесь.**
 * Профиль состоит из ссылок на три разных множества, и природа у них разная:
 *
 * - `expectedDocTypes` и `enabledRuleCodes` — ссылки в СПРАВОЧНИКИ, которые
 *   растут эксплуатацией. Их существование — вопрос состояния БД, поэтому
 *   сверяет репозиторий (422 с перечислением всех неизвестных кодов сразу).
 *   Здесь остаётся только формат кода: закрытый список в схеме превратил бы
 *   каждый новый вид ИД в задачу на разработку.
 * - `materialCategories` — закрытое перечисление (`materialCategoryCodeSchema`,
 *   см. заголовок раздела перечислений): категория живёт в коде правил §9.4, и
 *   неизвестный код — это опечатка формы, отказ по которой уместен на входе.
 *
 * `autonomyLevel` по умолчанию `assisted` — новый раздел стартует именно так
 * (§0.5, п.5). Ни отказ автоматизма, ни запрет переписывать историю периодов
 * схеме не выразить: и то, и другое — вопросы к накопленной статистике и к уже
 * опубликованным версиям, то есть к БД (см. `createSectionProfile`).
 */
export const createSectionProfileBodySchema = z
  .object({
    sectionKindCode: sectionKindCodeSchema,
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullish(),
    expectedDocTypes: z.array(docTypeCodeSchema).default([]),
    materialCategories: z.array(materialCategoryCodeSchema).default([]),
    materialMatrix: jsonValueSchema.default({}),
    enabledRuleCodes: z.array(ruleCodeSchema).default([]),
    thresholds: jsonValueSchema.default({}),
    autonomyLevel: autonomyLevelSchema.default('assisted'),
    publish: z.boolean().default(false),
  })
  .refine((body) => body.effectiveTo == null || body.effectiveFrom <= body.effectiveTo, {
    message: 'Начало действия профиля позже его окончания',
    path: ['effectiveTo'],
  });

export const sectionProfileListSchema = z.array(sectionProfileSchema);

// =====================================================================
// Реестр рабочей документации
// =====================================================================

export const rdDocumentListQuerySchema = pageQuerySchema.extend(searchQuerySchema.shape);

export const createRdDocumentBodySchema = z.object({
  cipher: z.string().min(1).max(255),
  revision: z.string().max(64).nullish(),
  name: z.string().max(1000).nullish(),
  designerId: uuidSchema.nullish(),
});

export const updateRdDocumentBodySchema = z
  .object({
    cipher: z.string().min(1).max(255).optional(),
    revision: z.string().max(64).nullish(),
    name: z.string().max(1000).nullish(),
    designerId: uuidSchema.nullish(),
    isActive: z.boolean().optional(),
  })
  .refine(nonEmptyPatch, { message: EMPTY_PATCH_MESSAGE });

export const rdDocumentSchema = z.object({
  id: uuidSchema,
  objectId: uuidSchema,
  cipher: z.string().min(1).max(255),
  revision: z.string().nullable(),
  name: z.string().nullable(),
  designerId: uuidSchema.nullable(),
  isActive: z.boolean(),
});

export const rdDocumentPageSchema = cursorPageSchema(rdDocumentSchema);

// =====================================================================
// Виды ИД и кандидаты
// =====================================================================

export const docTypeListQuerySchema = z.object({
  groupCode: docTypeGroupSchema.optional(),
  kind: docTypeKindSchema.optional(),
  includeInactive: queryFlagSchema.optional(),
});

export const docTypeSchema = z.object({
  code: docTypeCodeSchema,
  name: z.string().min(1).max(500),
  shortName: z.string().min(1).max(255),
  groupCode: docTypeGroupSchema,
  kind: docTypeKindSchema,
  hasAnnexes: z.boolean(),
  matchHints: jsonValueSchema,
  fieldSchema: jsonValueSchema,
  isSystem: z.boolean(),
  isFallback: z.boolean(),
  sortOrder: sortOrderSchema,
  /** Эффективное значение: базовый каталог активен, пока не отключён наложением. */
  isActive: z.boolean(),
  /** Значения отличаются от поставляемых с релизом. */
  hasOverride: z.boolean(),
});

export const docTypeListSchema = z.array(docTypeSchema);

export const createDocTypeBodySchema = z.object({
  code: docTypeCodeSchema,
  name: z.string().min(1).max(500),
  shortName: z.string().min(1).max(255),
  groupCode: docTypeGroupSchema,
  kind: docTypeKindSchema,
  hasAnnexes: z.boolean().optional(),
  matchHints: jsonValueSchema.optional(),
  fieldSchema: jsonValueSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
});

/** `null` снимает конкретное наложение, отсутствие поля его не трогает. */
export const docTypeOverrideBodySchema = z
  .object({
    name: z.string().min(1).max(500).nullish(),
    isActive: z.boolean().nullish(),
    sortOrder: sortOrderSchema.nullish(),
    matchHints: jsonValueSchema.nullish(),
  })
  .refine(nonEmptyPatch, { message: EMPTY_PATCH_MESSAGE });

export const candidateListQuerySchema = pageQuerySchema.extend({
  status: docTypeCandidateStatusSchema.optional(),
});

export const docTypeCandidateSchema = z.object({
  id: uuidSchema,
  observedTitleNorm: z.string(),
  observedTitleSample: z.string(),
  occurrences: z.int().positive(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  sampleRevisionId: uuidSchema.nullable(),
  sampleSourcePageId: uuidSchema.nullable(),
  status: docTypeCandidateStatusSchema,
  mappedDocTypeCode: docTypeCodeSchema.nullable(),
  reviewedBy: uuidSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
});

export const docTypeCandidatePageSchema = cursorPageSchema(docTypeCandidateSchema);

export const mapCandidateBodySchema = z.object({ docTypeCode: docTypeCodeSchema });

export const candidateStatusBodySchema = z.object({
  status: docTypeCandidateReviewStatusSchema,
});

/** Ответ действия «завести тип»: и новый тип, и закрытый кандидат. */
export const docTypeFromCandidateSchema = z.object({
  docType: docTypeSchema,
  candidate: docTypeCandidateSchema,
});
