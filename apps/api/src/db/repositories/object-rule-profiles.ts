/**
 * Профили правил объекта (§3.2, §9.2): версионные наложения на профиль вида
 * раздела.
 *
 * Таблица `object_rule_profiles` появилась в миграции 0002 и до сих пор не имела
 * ни репозитория, ни маршрута — то есть §17 (этап S4) был выполнен не полностью,
 * а §9.2 ссылался на сущность, которой не существовало в коде: «дата
 * производства, поставки или применения — по профилю правил объекта».
 *
 * ## Зачем два уровня настройки, если профиль раздела уже есть
 *
 * Профиль раздела отвечает на вопрос «чего ждать от кровли вообще»
 * (§0.5): состав комплекта, категории материалов, включённые правила, пороги.
 * Ответ одинаков для всех объектов, где такой раздел есть, — и это правильно по
 * умолчанию, но не всегда верно на конкретной стройке: у одного застройщика
 * приказы подписываются иначе, на одном объекте по договору не требуется часть
 * документов, на другом релевантной датой сертификата считается дата поставки, а
 * не применения. Держать такие решения в профиле ВИДА раздела нельзя: они
 * относятся к объекту и разъехались бы по копиям профиля при первом же втором
 * объекте.
 *
 * Отсюда цепочка разрешения (`resolveEffectiveRules`):
 *
 *   профиль раздела → наложение объекта → наложение объекта и раздела
 *
 * Порядок именно такой: чем уже область решения, тем позже оно применяется.
 * `section_id IS NULL` означает «на весь объект» — ради этого столбец и сделан
 * нуллябельным, а два частичных уникальных индекса (0002) держат нумерацию
 * версий отдельно для объектных и разделных профилей.
 *
 * ## Что наложение НЕ может сделать
 *
 * `autonomyLevel` наложением только понижается до `assisted`. Повышение до
 * `automatic` — решение по накопленной статистике ВИДА раздела (§0.5, п.5), и
 * `createSectionProfile()` не даёт включить автоматизм разделу без
 * опубликованного профиля. Если бы наложение объекта умело поднимать уровень,
 * этот запрет обходился бы одним запросом на любом объекте.
 *
 * ## Область видимости и публикация
 *
 * У таблицы есть `object_id`, поэтому область применяется по объекту —
 * `objectVisibility()` из `catalog.ts`, а не второй экземпляр той же логики
 * (`ScopeTarget` требует пары колонок, а `contractor_id` здесь нет).
 *
 * `published_by` в таблице нет — и колонка не добавляется: §3.2 фиксирует состав
 * `object_rule_profiles`, а автор публикации отвечается журналом аудита, куда
 * запись идёт той же транзакцией. Дублировать автора в двух местах значит
 * получить два ответа на один вопрос.
 */
import { and, asc, desc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { objectRuleProfiles } from '@id/db';
import {
  docTypeCodeSchema,
  jsonValueSchema,
  ruleCodeSchema,
  materialCategoryCodeSchema,
  type MaterialCategoryCode,
  type AutonomyLevel,
  type JsonValue,
  type SectionProfile,
} from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, internal } from '../../lib/problem.js';
import { appendAudit, type AuditActor } from './audit.js';
import {
  findEffectiveSectionProfile,
  guardConstraints,
  listObjectSections,
  objectVisibility,
  visibleWhere,
  assertKnownProfileReferences,
} from './catalog.js';
import type { Database } from './users.js';

/**
 * Основание релевантной даты для документов качества (§9.2).
 *
 * Универсального «действует на дату окончания работ» нет: сертификат сверяется с
 * датой производства, поставки или применения, и выбор принадлежит объекту.
 * Значение по умолчанию — `application`: материал применён на стройке, и именно
 * на эту дату документ обязан действовать; остальные два основания мягче, и
 * молчаливое их применение занижало бы строгость проверки.
 */
export const RELEVANT_DATE_BASES = ['production', 'delivery', 'application'] as const;
export type RelevantDateBasis = (typeof RELEVANT_DATE_BASES)[number];
export const DEFAULT_RELEVANT_DATE_BASIS: RelevantDateBasis = 'application';

/**
 * Состав `overrides`.
 *
 * Форма объявлена один раз и используется двумя схемами: строгой — для тела
 * запроса (неизвестный ключ в наложении означает опечатку, которая иначе молча
 * не сделала бы ничего) и обычной — для разбора уже записанного jsonb, где ключи
 * прошлых версий формы обязаны игнорироваться, а не ломать чтение.
 */
const OVERRIDE_SHAPE = {
  /** Полная замена ожидаемого состава комплекта. */
  expectedDocTypes: z.array(docTypeCodeSchema).optional(),
  /** Полная замена перечня уместных категорий материалов. */
  materialCategories: z.array(materialCategoryCodeSchema).optional(),
  /** Требования к пакету подтверждения: накладывается по категориям. */
  materialMatrix: z.record(z.string(), jsonValueSchema).optional(),
  /** Пороги: накладываются по ключам, а не заменяют набор целиком. */
  thresholds: z.record(z.string(), jsonValueSchema).optional(),
  /** Полная замена списка включённых правил. */
  enabledRuleCodes: z.array(ruleCodeSchema).optional(),
  /** Вычитание из действующего списка: «на этом объекте правило не применяем». */
  disabledRuleCodes: z.array(ruleCodeSchema).optional(),
  /** Только понижение автоматизма — см. заголовок файла. */
  autonomyLevel: z.literal('assisted').optional(),
  relevantDateBasis: z.enum(RELEVANT_DATE_BASES).optional(),
};

export const ruleOverridesInputSchema = z.strictObject(OVERRIDE_SHAPE);
const storedOverridesSchema = z.object(OVERRIDE_SHAPE);

export type RuleOverrides = z.infer<typeof ruleOverridesInputSchema>;

export interface ObjectRuleProfileView {
  readonly id: string;
  readonly objectId: string;
  /** `null` — профиль всего объекта, иначе профиль конкретного раздела. */
  readonly sectionCode: string | null;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly overrides: RuleOverrides;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

const PROFILE_SELECTION = {
  id: objectRuleProfiles.id,
  objectId: objectRuleProfiles.objectId,
  sectionCode: objectRuleProfiles.sectionCode,
  version: objectRuleProfiles.version,
  effectiveFrom: objectRuleProfiles.effectiveFrom,
  effectiveTo: objectRuleProfiles.effectiveTo,
  overrides: objectRuleProfiles.overrides,
  publishedAt: sql<
    string | null
  >`to_char(${objectRuleProfiles.publishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    'published_at_iso',
  ),
  createdAt:
    sql<string>`to_char(${objectRuleProfiles.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
      'created_at_iso',
    ),
};

// =====================================================================
// Чтение
// =====================================================================

export interface ObjectRuleProfileFilter {
  /** `null` — только профили всего объекта; `undefined` — и объектные, и разделные. */
  readonly sectionCode?: string | null | undefined;
}

/**
 * Версии профилей правил объекта, новые первыми.
 *
 * Без курсора: версий профиля у объекта единицы, и экран настройки читает их
 * целиком — страница выдачи означала бы, что часть истории не видна.
 */
export async function listObjectRuleProfiles(
  db: Database,
  scope: AuthScope,
  objectId: string,
  filter: ObjectRuleProfileFilter = {},
): Promise<readonly ObjectRuleProfileView[]> {
  const rows = await db
    .select(PROFILE_SELECTION)
    .from(objectRuleProfiles)
    .where(
      visibleWhere(
        objectVisibility(scope, objectRuleProfiles.objectId),
        eq(objectRuleProfiles.objectId, objectId),
        sectionCondition(filter.sectionCode),
      ),
    )
    .orderBy(asc(objectRuleProfiles.sectionCode), desc(objectRuleProfiles.version));
  return rows.map(toProfileView);
}

export async function findObjectRuleProfile(
  db: Database,
  scope: AuthScope,
  profileId: string,
): Promise<ObjectRuleProfileView | null> {
  const rows = await db
    .select(PROFILE_SELECTION)
    .from(objectRuleProfiles)
    .where(
      visibleWhere(
        objectVisibility(scope, objectRuleProfiles.objectId),
        eq(objectRuleProfiles.id, profileId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toProfileView(row);
}

/**
 * Профиль правил объекта, действующий на дату.
 *
 * Только опубликованные версии и тот же порядок разрешения, что у профиля вида
 * раздела (`effective_from desc, version desc`): черновик, попавший в прогон,
 * менял бы результат проверки, не будучи решением администратора, а
 * упорядочивание делает выбор однозначным даже при двух версиях с одной датой
 * начала.
 */
export async function findEffectiveObjectRuleProfile(
  db: Database,
  scope: AuthScope,
  target: { readonly objectId: string; readonly sectionCode: string | null },
  onDate: string,
): Promise<ObjectRuleProfileView | null> {
  const rows = await db
    .select(PROFILE_SELECTION)
    .from(objectRuleProfiles)
    .where(
      visibleWhere(
        objectVisibility(scope, objectRuleProfiles.objectId),
        eq(objectRuleProfiles.objectId, target.objectId),
        sectionCondition(target.sectionCode),
        sql`${objectRuleProfiles.publishedAt} is not null`,
        sql`${objectRuleProfiles.effectiveFrom} <= ${onDate}::date`,
        sql`(${objectRuleProfiles.effectiveTo} is null or ${objectRuleProfiles.effectiveTo} >= ${onDate}::date)`,
      ),
    )
    .orderBy(desc(objectRuleProfiles.effectiveFrom), desc(objectRuleProfiles.version))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toProfileView(row);
}

// =====================================================================
// Запись
// =====================================================================

export interface CreateObjectRuleProfileInput {
  readonly objectId: string;
  readonly sectionCode: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null | undefined;
  readonly overrides: RuleOverrides;
  readonly publish: boolean;
}

/**
 * Новая версия профиля правил объекта.
 *
 * Три решения, и все три — про состояние БД, а не про тело запроса:
 *
 * 1. **Номер версии** назначает репозиторий — `max(version) + 1` в пределах
 *    (объект, раздел). Гонку закрывают частичные UNIQUE-индексы 0002:
 *    проигравший получает 409 и повторяет запрос, а не переписывает чужую версию.
 * 2. **Период предыдущей версии закрывается только при ПУБЛИКАЦИИ** — здесь, если
 *    новая версия публикуется сразу, и в `publishObjectRuleProfile()` иначе.
 *    Проверено прогоном: закрытие периода при создании ЧЕРНОВИКА оставляет объект
 *    без действующего профиля до публикации — то есть черновик меняет результат
 *    проверок, ничего не публикуя. Это ровно то, чего версионность обязана не
 *    допускать (§9.1: прогон месячной давности должен воспроизводиться).
 * 3. **Запись и след в журнале — одна транзакция.** Настройка правил объекта
 *    меняет вердикты проверок, и «кто ослабил требования на этом объекте» обязано
 *    быть отвечаемо.
 */
export async function createObjectRuleProfile(
  db: Database,
  scope: AuthScope,
  input: CreateObjectRuleProfileInput,
  actor: AuditActor,
): Promise<ObjectRuleProfileView> {
  const profileId = await guardConstraints(() =>
    db.transaction(async (tx) => {
      // Наложение объекта ПОЛНОСТЬЮ заменяет действующий список, поэтому
      // опечатка в коде не просто добавляет мусор, а вытесняет настоящие
      // правила: прогон ответит «замечаний нет», и отличить это от исправной
      // работы будет нечем (§9.1). Сверка та же, что у профиля раздела.
      await assertKnownProfileReferences(tx, {
        expectedDocTypes: input.overrides.expectedDocTypes ?? [],
        enabledRuleCodes: [
          ...(input.overrides.enabledRuleCodes ?? []),
          ...(input.overrides.disabledRuleCodes ?? []),
        ],
      });

      const existing = await tx
        .select({ version: objectRuleProfiles.version })
        .from(objectRuleProfiles)
        .where(
          and(eq(objectRuleProfiles.objectId, input.objectId), sectionCondition(input.sectionCode)),
        );
      const nextVersion = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;

      if (input.publish) {
        await closePrecedingPeriods(tx, input, input.effectiveFrom);
      }

      const inserted = await tx
        .insert(objectRuleProfiles)
        .values({
          objectId: input.objectId,
          sectionCode: input.sectionCode,
          version: nextVersion,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          overrides: sql`${JSON.stringify(input.overrides)}::jsonb`,
          ...(input.publish ? { publishedAt: sql`now()` } : { publishedAt: null }),
        })
        .returning({ id: objectRuleProfiles.id });

      const row = inserted[0];
      if (row === undefined) {
        throw internal({ logDetail: 'INSERT профиля правил объекта не вернул строку' });
      }

      await appendAudit(tx, scope, {
        ...actor,
        action: input.publish ? 'object_rule_profile.published' : 'object_rule_profile.created',
        entityType: 'object_rule_profile',
        entityId: row.id,
        objectId: input.objectId,
        payload: {
          sectionCode: input.sectionCode,
          version: nextVersion,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          published: input.publish,
          // Наложение целиком: это и есть решение администратора, и без него
          // журнал отвечал бы «правила объекта менялись», не отвечая, как именно.
          overrides: input.overrides,
        },
      });

      return row.id;
    }),
  );

  const created = await findObjectRuleProfile(db, scope, profileId);
  if (created === null) {
    // Только что записанная строка обязана читаться: если её нет, дело не в
    // данных, а в области видимости или условии чтения.
    throw internal({ logDetail: 'профиль правил объекта не читается сразу после записи' });
  }
  return created;
}

/**
 * Публикация версии — она же момент, когда закрывается период предыдущей.
 *
 * Отдельным действием, как у профиля раздела: опубликованная версия
 * участвует в прогонах, и повторная публикация переставила бы `published_at`
 * вперёд у профиля, по которому прогоны уже выполнены.
 *
 * Период предшественников закрывается здесь, а не при создании черновика (разбор
 * в `createObjectRuleProfile`): до публикации черновик обязан быть невидим для
 * разрешения правил, а значит и не имеет права укорачивать чужой период.
 */
export async function publishObjectRuleProfile(
  db: Database,
  scope: AuthScope,
  profileId: string,
  actor: AuditActor,
): Promise<ObjectRuleProfileView | null> {
  const current = await findObjectRuleProfile(db, scope, profileId);
  if (current === null) return null;
  if (current.publishedAt !== null) throw conflict('Профиль правил объекта уже опубликован.');

  await guardConstraints(() =>
    db.transaction(async (tx) => {
      // Условие «ещё не опубликован» стоит в самом UPDATE: между чтением выше и
      // этой записью версию мог опубликовать другой администратор.
      const published = await tx
        .update(objectRuleProfiles)
        .set({ publishedAt: sql`now()` })
        .where(and(eq(objectRuleProfiles.id, profileId), isNull(objectRuleProfiles.publishedAt)))
        .returning({ id: objectRuleProfiles.id });
      if (published.length === 0) return;

      await closePrecedingPeriods(tx, current, current.effectiveFrom, profileId);

      await appendAudit(tx, scope, {
        ...actor,
        action: 'object_rule_profile.published',
        entityType: 'object_rule_profile',
        entityId: profileId,
        objectId: current.objectId,
        payload: {
          sectionCode: current.sectionCode,
          version: current.version,
          effectiveFrom: current.effectiveFrom,
        },
      });
    }),
  );

  return findObjectRuleProfile(db, scope, profileId);
}

// =====================================================================
// Разрешение действующих правил (понадобится движку правил на S9)
// =====================================================================

/**
 * Правила, действующие для объекта и раздела на дату.
 *
 * `completenessConfigured` отделяет «состав комплекта не настроен» от «комплект
 * пуст», и это требование §9.1: у раздела без опубликованного профиля правила
 * полноты обязаны дать `n_a` с пометкой «профиль раздела не настроен», а не
 * «комплект неполон». Пустой `expectedDocTypes` сам по себе этих случаев не
 * различает, поэтому признак выдаётся отдельно, а не выводится из длины списка.
 *
 * `sectionProfileId` и `objectProfileIds` возвращаются, чтобы прогон мог
 * запиннить то, по чему считался: воспроизводимость прогона (§9.1) требует
 * ссылок на версии, а не пересчёта по дате.
 */
export interface ResolvedRules {
  readonly objectId: string;
  readonly sectionCode: string;
  readonly onDate: string;
  readonly sectionProfileId: string | null;
  readonly sectionProfileVersion: number | null;
  /** Применённые наложения в порядке применения: объектное, затем разделное. */
  readonly objectProfileIds: readonly string[];
  readonly expectedDocTypes: readonly string[];
  readonly materialCategories: readonly MaterialCategoryCode[];
  readonly materialMatrix: JsonValue;
  readonly enabledRuleCodes: readonly string[];
  readonly thresholds: JsonValue;
  readonly autonomyLevel: AutonomyLevel;
  readonly relevantDateBasis: RelevantDateBasis;
  readonly completenessConfigured: boolean;
}

/**
 * Действующие правила для объекта и раздела на дату.
 *
 * `null` означает «такого раздела у этого объекта нет (или он вне области
 * видимости)» — это 404, а не пустые правила: подставить настройку другого
 * раздела было бы хуже отказа.
 */
export async function resolveEffectiveRules(
  db: Database,
  scope: AuthScope,
  target: { readonly objectId: string; readonly sectionCode: string },
  onDate: string,
): Promise<ResolvedRules | null> {
  // Раздел обязан быть ВКЛЮЧЁН на объекте: иначе прогон считал бы правила по
  // работам, которых на этой стройке не ведут. Проверка чтением, а не ключом:
  // здесь читают, а не пишут, и составному FK нечего защищать.
  const enabled = await listObjectSections(db, scope, target.objectId);
  const section = enabled.find((row) => row.sectionCode === target.sectionCode && row.isActive);
  if (section === undefined) return null;

  const sectionProfile = await findEffectiveSectionProfile(db, scope, target.sectionCode, onDate);
  const objectWide = await findEffectiveObjectRuleProfile(
    db,
    scope,
    { objectId: target.objectId, sectionCode: null },
    onDate,
  );
  const sectionScoped = await findEffectiveObjectRuleProfile(
    db,
    scope,
    { objectId: target.objectId, sectionCode: target.sectionCode },
    onDate,
  );

  const applied = [objectWide, sectionScoped].filter(
    (profile): profile is ObjectRuleProfileView => profile !== null,
  );

  let rules = baseRules(sectionProfile);
  let completenessConfigured = sectionProfile !== null;
  for (const profile of applied) {
    rules = applyOverrides(rules, profile.overrides);
    // Наложение, задающее состав комплекта, настраивает полноту само — даже если
    // у раздела опубликованного профиля нет.
    completenessConfigured =
      completenessConfigured || profile.overrides.expectedDocTypes !== undefined;
  }

  return {
    objectId: target.objectId,
    sectionCode: target.sectionCode,
    onDate,
    sectionProfileId: sectionProfile?.id ?? null,
    sectionProfileVersion: sectionProfile?.version ?? null,
    objectProfileIds: applied.map((profile) => profile.id),
    ...rules,
    completenessConfigured,
  };
}

/** Значения без наложений: либо из профиля раздела, либо безопасные пустые. */
type RuleValues = Omit<
  ResolvedRules,
  | 'objectId'
  | 'sectionCode'
  | 'onDate'
  | 'sectionProfileId'
  | 'sectionProfileVersion'
  | 'objectProfileIds'
  | 'completenessConfigured'
>;

function baseRules(profile: SectionProfile | null): RuleValues {
  if (profile === null) {
    return {
      expectedDocTypes: [],
      materialCategories: [],
      materialMatrix: {},
      enabledRuleCodes: [],
      thresholds: {},
      // Раздел без профиля стартует в assisted (§0.5, п.5), а не «как получится».
      autonomyLevel: 'assisted',
      relevantDateBasis: DEFAULT_RELEVANT_DATE_BASIS,
    };
  }
  return {
    expectedDocTypes: profile.expectedDocTypes,
    // Колонка в БД — text[], а закрытое перечисление держится на входе
    // (materialCategoryCodeSchema). Приведение здесь, а не проверка: строки
    // старше введения перечисления читаются как есть, и падать на чтении
    // исторического профиля нельзя.
    materialCategories: profile.materialCategories as readonly MaterialCategoryCode[],
    materialMatrix: profile.materialMatrix,
    enabledRuleCodes: profile.enabledRuleCodes,
    thresholds: profile.thresholds,
    autonomyLevel: profile.autonomyLevel,
    relevantDateBasis: DEFAULT_RELEVANT_DATE_BASIS,
  };
}

/**
 * Наложение поверх действующих значений.
 *
 * Списки заменяются целиком, а объекты (`materialMatrix`, `thresholds`)
 * накладываются по верхним ключам. Разница не произвольна: «ожидаемый состав
 * комплекта» — это одно решение, и частичная замена его элементов не имеет
 * смысла, а матрица и пороги — набор независимых требований, и полная замена
 * заставляла бы копировать в каждое наложение объекта всё, что задано у вида
 * раздела. Копия же неизбежно отстанет от исходника — молча.
 */
function applyOverrides(base: RuleValues, overrides: RuleOverrides): RuleValues {
  const enabled = overrides.enabledRuleCodes ?? base.enabledRuleCodes;
  const disabled = new Set(overrides.disabledRuleCodes ?? []);

  return {
    expectedDocTypes: overrides.expectedDocTypes ?? base.expectedDocTypes,
    materialCategories: overrides.materialCategories ?? base.materialCategories,
    materialMatrix: mergeJsonObjects(base.materialMatrix, overrides.materialMatrix),
    enabledRuleCodes: enabled.filter((code) => !disabled.has(code)),
    thresholds: mergeJsonObjects(base.thresholds, overrides.thresholds),
    // Понижение — единственное допустимое изменение уровня (см. заголовок файла),
    // и схема наложения других значений не принимает.
    autonomyLevel: overrides.autonomyLevel ?? base.autonomyLevel,
    relevantDateBasis: overrides.relevantDateBasis ?? base.relevantDateBasis,
  };
}

/**
 * Слияние по верхним ключам.
 *
 * Если действующее значение не объект (в профиле раздела `jsonb` мог
 * оказаться массивом или числом), наложение заменяет его целиком: сливать
 * массив со словарём нечем, а угадывать здесь опаснее, чем заменить.
 */
function mergeJsonObjects(
  base: JsonValue,
  patch: Record<string, JsonValue> | undefined,
): JsonValue {
  if (patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  return { ...base, ...patch };
}

// =====================================================================
// Мелкие помощники
// =====================================================================

/**
 * Закрывает период действующих версий днём до начала новой.
 *
 * Затрагиваются только ОПУБЛИКОВАННЫЕ версии: черновик в разрешении правил не
 * участвует, поэтому его открытый период ничему не мешает, а укорачивание его
 * задним числом было бы правкой чужой заготовки. Условие `effective_from <
 * новая` обязательно: версия, начинающаяся позже (запланированная вперёд), к
 * предшественникам не относится, и её период не наш.
 */
async function closePrecedingPeriods(
  executor: Pick<Database, 'update'>,
  target: { readonly objectId: string; readonly sectionCode: string | null },
  effectiveFrom: string,
  exceptProfileId?: string,
): Promise<void> {
  await executor
    .update(objectRuleProfiles)
    .set({ effectiveTo: sql`(${effectiveFrom}::date - 1)` })
    .where(
      and(
        eq(objectRuleProfiles.objectId, target.objectId),
        sectionCondition(target.sectionCode),
        isNull(objectRuleProfiles.effectiveTo),
        sql`${objectRuleProfiles.publishedAt} is not null`,
        lt(objectRuleProfiles.effectiveFrom, effectiveFrom),
        exceptProfileId === undefined ? undefined : ne(objectRuleProfiles.id, exceptProfileId),
      ),
    );
}

/**
 * Условие по разделу с различением NULL.
 *
 * `undefined` — «любой», `null` — именно профиль всего объекта. Через `eq()`
 * второй случай не выражается: `section_id = NULL` не истинно ни для одной
 * строки, и профиль объекта был бы невидим, а его версия — назначена повторно.
 */
function sectionCondition(sectionCode: string | null | undefined) {
  if (sectionCode === undefined) return undefined;
  return sectionCode === null
    ? isNull(objectRuleProfiles.sectionCode)
    : eq(objectRuleProfiles.sectionCode, sectionCode);
}

function toProfileView(row: {
  id: string;
  objectId: string;
  sectionCode: string | null;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  overrides: unknown;
  publishedAt: string | null;
  createdAt: string;
}): ObjectRuleProfileView {
  const parsed = storedOverridesSchema.safeParse(row.overrides ?? {});
  if (!parsed.success) {
    // Не «применим значения по умолчанию»: молча ослабленные правила хуже
    // отказа — прогон посчитался бы по настройке, которой никто не задавал.
    throw internal({
      logDetail: `overrides профиля правил объекта не разобраны (${row.id})`,
    });
  }
  return { ...row, overrides: parsed.data };
}
