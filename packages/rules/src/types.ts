/**
 * Общие типы движка правил (§9).
 *
 * Файл пишется ОДИН раз и до реализаций — по той же причине, что
 * `apps/api/src/segmentation/types.ts` на S8: группы правил (§9.2 даты, §9.3
 * АОСР, §9.4 доказательные документы, §9.5 внешние реестры) пишутся врозь, а
 * обмениваются они ровно этими структурами. Разъехавшиеся определения входа и
 * выхода — тот же класс отказа, что на S2 дал 39 расхождений между схемой
 * Drizzle и SQL.
 *
 * ## Почему правило возвращает не `Finding[]`, а результат с вердиктом
 *
 * §9.6 описывает реализацию правила как `(graph, params) => Finding[]`. Взято
 * почти буквально: правило — чистая СИНХРОННАЯ функция от графа и параметров.
 * Отличие одно и оно вынужденное: пустой массив не различает `pass` и `n_a`,
 * а §9.1 требует, чтобы это были разные состояния с разным поведением. Пустой
 * массив на незнакомом типе документа и пустой массив на проверенном документе
 * означают противоположное, и «замечаний нет» в обоих случаях — это ровно тот
 * отказ, ради предотвращения которого §0.5 введён открытый мир.
 *
 * Поэтому результат — `RuleResult` с явным `verdict`, а движок проверяет
 * согласованность вердикта и находок (`assertConsistent` в `result.ts`):
 * правило не может объявить `pass`, вернув открытое замечание с severity
 * `error`, и не может объявить `fail`, не вернув ни одного.
 *
 * ## Почему правила синхронны, а внешние реестры разрешаются до прогона
 *
 * §9.5 требует, чтобы недоступный внешний реестр давал
 * `origin='external_unavailable'`, а не юридический вывод. Если бы правило
 * ходило в сеть само, оно перестало бы быть чистой функцией, прогон стал бы
 * невоспроизводимым, а таймаут одного реестра растянул бы проверку комплекта.
 * Поэтому все обращения к провайдерам выполняются ОДИН раз при сборке графа, а
 * правило читает уже готовый `ExternalLookup` — доступный или нет.
 */
import type { FindingTargetType, MaterialCategoryCode } from '@id/contracts';

// ---------------------------------------------------------------------------
// Троичная логика
// ---------------------------------------------------------------------------

/**
 * Вердикт правила (§9.1).
 *
 * `n_a` — правило неприменимо (незнакомый тип, нет профиля раздела, категория
 * материала вне профиля). `undetermined` — правило применимо, но данных для
 * вывода нет: неизвестна релевантная дата, не отобразилась цитата, низкая
 * уверенность распознавания. Слить их в одно значение значит потерять разницу
 * между «эта проверка сюда не относится» и «эту проверку надо сделать руками».
 */
export type RuleVerdict = 'pass' | 'fail' | 'undetermined' | 'n_a';

export type FindingSeverity = 'error' | 'warning' | 'info';

/** Совпадает с `findings.origin` (0006). */
export type FindingOrigin = 'deterministic' | 'llm' | 'external_unavailable';

/**
 * Состояние замечания при создании.
 *
 * `open` — дефект найден. `undetermined` — вывод не сделан. Остальные значения
 * `findings.state` (`resolved`, `waived`) ставятся людьми на S10, а не движком.
 */
export type FindingState = 'open' | 'undetermined';

/** Цитата, отображённая на точный диапазон текста страницы (§9.6). */
export interface FindingEvidence {
  readonly pageTextVersionId: string;
  /** Полуинтервал [start, end) в code unit'ах UTF-16 — `offset_convention` §3.5. */
  readonly charStart: number;
  readonly charEnd: number;
  readonly quote: string;
}

/**
 * Замечание в том виде, в каком его порождает правило.
 *
 * `ruleCode`, `severity` и `isBlocking` здесь отсутствуют намеренно: поведение
 * правила живёт в неизменяемом снимке `ruleset_rules` (§3.7), а не в коде.
 * Правило описывает ФАКТ, снимок — что с этим фактом делать. Позволить правилу
 * назначать себе severity значило бы, что прогон месячной давности
 * воспроизводится не снимком, а текущей версией кода.
 *
 * Исключение — `severityOverride`: одно правило может законно порождать
 * замечания разной тяжести (у `LAB` семисуточный протокол это `info`
 * «промежуточный контроль», а несобранная прочность в 28 суток — `error`).
 * Значение обязано быть НЕ ВЫШЕ снимка по строгости — иначе снимок перестаёт
 * ограничивать; проверку делает движок.
 */
export interface RuleFinding {
  readonly state: FindingState;
  readonly origin: FindingOrigin;
  /** Понижение тяжести относительно снимка; повышать правило не вправе. */
  readonly severityOverride?: FindingSeverity;
  readonly targetType: FindingTargetType;
  readonly targetId: string | null;
  readonly sourcePageId?: string | null;
  readonly blockId?: string | null;
  readonly message: string;
  /** Способ устранения: замечание без него бесполезно подрядчику (§9.1). */
  readonly hint?: string | null;
  readonly evidence?: readonly FindingEvidence[];
  /**
   * Уверенность источника факта (уверенность OCR или модели).
   *
   * Нужна движку, а не отчёту: §9.1 запрещает `fail` по низкой уверенности, и
   * запрет обязан держаться в одном месте, а не в сорока правилах.
   */
  readonly confidence?: number | null;
}

/** Результат одного правила на одном прогоне. */
export type RuleResult =
  | {
      readonly verdict: 'n_a';
      /** Почему неприменимо: текст попадает в отчёт прогона (§9.1). */
      readonly reason: string;
      readonly findings?: undefined;
    }
  | {
      readonly verdict: 'pass' | 'fail' | 'undetermined';
      readonly findings: readonly RuleFinding[];
      readonly reason?: string;
    };

// ---------------------------------------------------------------------------
// Граф проверки (§9.1)
// ---------------------------------------------------------------------------

/** Значение реквизита документа. Повторяет `field_values` (§3.6). */
export interface FieldNode {
  readonly id: string;
  readonly fieldCode: string;
  readonly valueText: string | null;
  /** `YYYY-MM-DD`; сравнивается строкой — см. `dates.ts`. */
  readonly valueDate: string | null;
  readonly valueNum: number | null;
  readonly valueJson: unknown;
  readonly confidence: number | null;
  readonly isVerified: boolean;
  readonly extractedBy: 'rule' | 'llm' | 'manual';
  readonly pageTextVersionId: string | null;
  readonly charSpan: { readonly start: number; readonly end: number } | null;
  readonly quote: string | null;
  /**
   * Страница, с которой снято значение. Нужна замечанию: «замечание к странице
   * 47 рабочего документа» без страницы неадресуемо.
   */
  readonly sourcePageId: string | null;
  /**
   * Вид блока-источника.
   *
   * `stamp` — прямой сигнал ненадёжности: ОГРН, вычитанный с круглой печати,
   * перекрытой подписью, — это причина, по которой `1027700012345` обязан дать
   * `undetermined`, а не `fail` (`docs/CORPUS_FINDINGS.md`).
   */
  readonly blockType: 'text' | 'image' | 'stamp' | null;
  readonly blockId: string | null;
}

/** Страница внутри документа. */
export interface DocumentPageNode {
  readonly sourcePageId: string;
  readonly sortOrder: number;
  readonly pageRoleCode: string | null;
}

/** Логический документ комплекта. */
export interface DocumentNode {
  readonly id: string;
  readonly ordinal: number;
  /** Код каталога, резервный код или `null`. */
  readonly docTypeCode: string | null;
  /**
   * Тип определён уверенно и НЕ является резервным.
   *
   * Ровно на этом признаке держится строка 1 матрицы §9.1: типо-специфичное
   * правило на таком документе даёт `n_a`, а не ошибку.
   */
  readonly isKnownType: boolean;
  readonly isFallbackType: boolean;
  readonly title: string | null;
  readonly typeConfidence: number | null;
  readonly boundaryConfidence: number | null;
  readonly needsReview: boolean;
  readonly isConfirmed: boolean;
  readonly pages: readonly DocumentPageNode[];
  readonly fields: readonly FieldNode[];
}

/** Строка реестра приложений и её сверка (§8.3). */
export interface RegistryRowNode {
  readonly id: string;
  /** Документ-реестр, которому принадлежит строка. */
  readonly registryDocumentId: string;
  readonly ordinal: number;
  readonly rowNo: number;
  readonly sectionTitle: string | null;
  readonly docNameRaw: string;
  readonly docNoRaw: string | null;
  readonly docNoNorm: string | null;
  readonly docNoFolded: string | null;
  readonly orgRaw: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly issuedAt: string | null;
  readonly matchedDocumentId: string | null;
  readonly matchScore: number | null;
  readonly matchState: 'matched' | 'missing' | 'ambiguous';
}

/** Ребро графа документов (задача 19). */
export interface RelationNode {
  readonly parentDocumentId: string;
  readonly childDocumentId: string;
  readonly relation: string;
}

/** Партия материала, выведенная из реквизитов документа. */
export interface BatchNode {
  readonly id: string;
  readonly materialId: string;
  readonly batchNo: string | null;
  readonly heatNo: string | null;
  readonly manufacturedAt: string | null;
  /** Документы, из которых собрана партия. */
  readonly documentIds: readonly string[];
}

/** Материал комплекта, выведенный из реквизитов документов качества. */
export interface MaterialNode {
  readonly id: string;
  readonly nameRaw: string;
  readonly nameNorm: string;
  readonly mark: string | null;
  /**
   * Категория по перечню контрактов либо `null` — «категория не определена».
   *
   * `null` и «категория вне профиля» — разные вещи и оба дают `n_a`, но с
   * разными текстами: первое означает, что определить не удалось, второе — что
   * материал уместен, но не в этом разделе (§9.1, строка 3).
   */
  readonly categoryCode: MaterialCategoryCode | null;
  readonly batches: readonly BatchNode[];
  /** Документы качества, относящиеся к материалу. */
  readonly documentIds: readonly string[];
}

/** Карточка объекта строительства (§9.3, `AOSR.HDR`, `REF`). */
export interface ObjectNode {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly fullName: string | null;
  readonly address: string | null;
  readonly isActive: boolean;
  readonly actNumberPattern: string | null;
  readonly developerId: string | null;
  readonly techCustomerId: string | null;
  readonly generalContractorId: string | null;
}

/** Контрагент справочника. */
export interface CounterpartyNode {
  readonly id: string;
  readonly name: string;
  readonly inn: string | null;
  readonly kpp: string | null;
  readonly ogrn: string | null;
  readonly kind: string;
  readonly isActive: boolean;
}

/** Шифр рабочей документации (§9.3, `AOSR.P2/P6`). */
export interface RdDocumentNode {
  readonly id: string;
  readonly cipher: string;
  readonly revision: string | null;
  readonly name: string;
  readonly isActive: boolean;
}

/** Ревизия поставки — корень графа. */
export interface RevisionNode {
  readonly id: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly sectionCode: string;
  /** Наименование работы: им подписывается комплект в реестре. */
  readonly workTitle: string;
  readonly status: string;
}

/**
 * Действующая конфигурация проверки: профиль раздела с наложениями
 * объекта (`resolveEffectiveRules`, S4).
 */
export interface ProfileNode {
  readonly sectionProfileId: string | null;
  readonly sectionProfileVersion: number | null;
  readonly objectProfileIds: readonly string[];
  readonly expectedDocTypes: readonly string[];
  readonly materialCategories: readonly MaterialCategoryCode[];
  readonly materialMatrix: Readonly<Record<string, unknown>>;
  readonly enabledRuleCodes: readonly string[];
  readonly thresholds: Readonly<Record<string, unknown>>;
  readonly autonomyLevel: 'assisted' | 'automatic';
  readonly relevantDateBasis: 'production' | 'delivery' | 'application';
  /**
   * У раздела есть настроенный состав комплекта.
   *
   * `false` — строка 2 матрицы §9.1: правила полноты комплекта и матрицы
   * материалов дают `n_a` с пометкой «профиль раздела не настроен», а не
   * «комплект неполон».
   */
  readonly completenessConfigured: boolean;
}

/**
 * Ответ внешнего реестра (§9.5).
 *
 * `unavailable` — не ошибка провайдера, а штатное состояние MVP: источника
 * данных нет. Правило обязано выдать `origin='external_unavailable'` и текст
 * «требуется ручная проверка», а не юридический вывод.
 */
export type ExternalLookup<T> =
  | { readonly status: 'available'; readonly records: readonly T[] }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Запись реестра НРС. */
export interface NrsRecord {
  readonly fullName: string;
  readonly registryNumber: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

/** Запись реестра СРО. */
export interface SroRecord {
  readonly memberInn: string;
  readonly sroName: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

/** Запись реестра аккредитации лабораторий. */
export interface AccreditationRecord {
  readonly registryNumber: string;
  readonly holderName: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

/** Строка графика строительства. */
export interface ScheduleRecord {
  readonly workName: string;
  readonly plannedFrom: string | null;
  readonly plannedTo: string | null;
}

/** Предразрешённые ответы внешних реестров (см. шапку файла). */
export interface ExternalRegistriesSnapshot {
  readonly nrs: ExternalLookup<NrsRecord>;
  readonly sro: ExternalLookup<SroRecord>;
  readonly accreditation: ExternalLookup<AccreditationRecord>;
  readonly schedule: ExternalLookup<ScheduleRecord>;
}

/** Полный вход движка правил. Собирается один раз на прогон. */
export interface CheckGraph {
  readonly revision: RevisionNode;
  readonly object: ObjectNode;
  readonly profile: ProfileNode;
  readonly counterparties: readonly CounterpartyNode[];
  readonly rdDocuments: readonly RdDocumentNode[];
  readonly documents: readonly DocumentNode[];
  readonly registryRows: readonly RegistryRowNode[];
  readonly relations: readonly RelationNode[];
  readonly materials: readonly MaterialNode[];
  readonly external: ExternalRegistriesSnapshot;
  /**
   * Дата прогона `YYYY-MM-DD`.
   *
   * Отделена от релевантной даты события намеренно (§9.1): «сертификат истёк
   * сегодня» и «сертификат не действовал в день применения материала» — разные
   * утверждения с разной тяжестью, и `DATE.300` против `DATE.302` держатся
   * именно на этом различии.
   */
  readonly today: string;
  /**
   * Есть ли у ревизии распознанный текст.
   *
   * `false` означает, что правила, требующие цитат, обязаны дать
   * `undetermined`, а не `fail`: отсутствие текста — это состояние конвейера,
   * а не дефект комплекта.
   */
  readonly hasRecognizedText: boolean;
}

// ---------------------------------------------------------------------------
// Правило и его снимок
// ---------------------------------------------------------------------------

/** Параметры правила из снимка `ruleset_rules.params`. */
export type RuleParams = Readonly<Record<string, unknown>>;

/**
 * Реализация правила: чистая синхронная функция (§9.6).
 *
 * Асинхронности здесь нет и не будет: любое обращение наружу делает прогон
 * невоспроизводимым, а §3.7 требует, чтобы прогон месячной давности
 * воспроизводился точно по снимку.
 */
export type RuleFn = (graph: CheckGraph, params: RuleParams) => RuleResult;

/**
 * Уровень правила: к чему оно относится. Совпадает с `rule_definitions.level`.
 */
export type RuleLevel = 'revision' | 'document' | 'material' | 'registry' | 'signature';

/** Группа правила. Совпадает с `rule_definitions.kind`. */
export type RuleKind =
  | 'dates'
  | 'header'
  | 'act'
  | 'signatures'
  | 'items'
  | 'registry'
  | 'materials'
  | 'evidence'
  | 'reference'
  | 'crosscheck'
  | 'external';

export type WaiverRole = 'contractor' | 'engineer' | 'manager' | 'admin';

/**
 * Описание правила: то, что попадает в `rule_definitions`, плюс реализация.
 *
 * Реестр и реализации — ОДИН объект, а не два списка. Два списка разъезжаются
 * молча: это ровно тот дефект, который на S2 дал нулевое пересечение имён
 * ограничений между схемой Drizzle и SQL. Сид `rule_definitions` порождается
 * отсюда же (`seed.ts`), а сверка при старте сравнивает БД с этим каталогом в
 * ОБЕ стороны (§9.6).
 */
export interface RuleSpec {
  readonly code: string;
  readonly title: string;
  /**
   * Тип документа, к которому правило привязано, либо `null` — правило
   * применимо к любому документу или к ревизии целиком.
   *
   * Значение попадает в `rule_definitions.doc_type_code` и участвует в
   * применимости: правило с непустым `docTypeCode` на документе неизвестного
   * или резервного типа даёт `n_a` (§9.1, строка 1).
   */
  readonly docTypeCode: string | null;
  readonly level: RuleLevel;
  readonly kind: RuleKind;
  readonly defaultSeverity: FindingSeverity;
  readonly defaultBlocking: boolean;
  readonly waiverRoles: readonly WaiverRole[];
  /**
   * Правило опирается на настроенный состав комплекта или матрицу материалов.
   *
   * `true` → без опубликованного профиля раздела правило даёт `n_a` с
   * пометкой «профиль раздела не настроен» (§9.1, строка 2).
   */
  readonly requiresSectionProfile: boolean;
  /**
   * Правило опирается на внешний реестр.
   *
   * Объявляется декларативно, чтобы отчёт прогона мог перечислить проверки,
   * которые в MVP не автоматизированы, не выспрашивая это у реализаций (§9.5).
   */
  readonly requiresExternalRegistry: keyof ExternalRegistriesSnapshot | null;
  readonly defaultParams: RuleParams;
  readonly evaluate: RuleFn;
}

/** Поведение правила из неизменяемого снимка `ruleset_rules` (§3.7). */
export interface RuleSnapshotEntry {
  readonly ruleCode: string;
  readonly isEnabled: boolean;
  readonly severity: FindingSeverity;
  readonly isBlocking: boolean;
  readonly params: RuleParams;
}

// ---------------------------------------------------------------------------
// Результат прогона
// ---------------------------------------------------------------------------

/** Почему правило не исполнялось. */
export type RuleSkipReason =
  /** Кода нет в `enabled_rule_codes` профиля (§9.1, строка 4). */
  | 'not_in_profile'
  /** Правило выключено в снимке ruleset. */
  | 'disabled_in_snapshot'
  /** Кода нет в снимке ruleset вовсе. */
  | 'absent_from_snapshot';

/** Строка журнала исполнения одного правила. */
export interface RuleExecution {
  readonly ruleCode: string;
  readonly verdict: RuleVerdict;
  /** Текст причины при `n_a`. */
  readonly reason: string | null;
  readonly findingCount: number;
}

/** Замечание, готовое к записи: факт от правила плюс поведение из снимка. */
export interface PreparedFinding extends RuleFinding {
  readonly ruleCode: string;
  readonly severity: FindingSeverity;
  readonly isBlocking: boolean;
}

/** Итог прогона движка. */
export interface RuleRunResult {
  readonly executions: readonly RuleExecution[];
  /** Коды, которые не исполнялись, с причиной. */
  readonly skipped: Readonly<Record<string, RuleSkipReason>>;
  readonly findings: readonly PreparedFinding[];
  readonly counts: RuleRunCounts;
}

export interface RuleRunCounts {
  readonly rulesTotal: number;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly undetermined: number;
  readonly notApplicable: number;
  readonly skipped: number;
  readonly findings: number;
  readonly blocking: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly externalUnavailable: number;
}
