/**
 * Правила доказательных документов (§9.4).
 *
 * Группа проверяет то, что напечатано В САМОМ документе о качестве: заполнены
 * ли обязательные реквизиты, не противоречат ли даты друг другу, укладывается
 * ли фактическое значение в норму, НАПЕЧАТАННУЮ РЯДОМ С НИМ.
 *
 * ## Чего здесь нет и почему
 *
 * Ни одной нормативной таблицы ГОСТ, СП или СТО. §8.1 запрещает вводить их без
 * ручной верификации источника и его редакции, и запрет здесь не формальность:
 * константа вида «предел текучести А500С = 500 МПа», внесённая по памяти, —
 * это ложное обвинение подрядчику, подписанное порталом. Поэтому сравнивается
 * ФАКТ с НОРМОЙ ИЗ ТОГО ЖЕ ДОКУМЕНТА (`tolerance.ts`), а если норма в
 * документе не напечатана — ответ `undetermined` с текстом «требуется ручная
 * проверка», а не вывод о качестве.
 *
 * Сроки действия ОТНОСИТЕЛЬНО релевантной даты проверяет группа `DATE.*`. Здесь
 * — только внутренняя непротиворечивость дат одного документа: продублировать
 * `DATE.300` значило бы выдать инженеру два замечания об одном факте.
 *
 * ## Два дефекта корпуса, ради которых написана группа
 *
 * Дефект №5 — пустое поле «Дата выдачи» в техпаспорте (`TP.620`). Дефект №7 —
 * отсутствие 28-суточных протоколов прочности при наличии семисуточных
 * (`LAB.651`). Оба сопровождаются зеркальным запретом: пустое поле нельзя
 * спутать с нераспознанной страницей, а семисуточный протокол нельзя объявить
 * браком (`LAB.650`) — в образце все пять протоколов семисуточные, и это
 * нормальный промежуточный контроль.
 */
import { effectiveConfidence, evidenceOf, field, formatDate, isIsoDate } from './helpers.js';
import { defect, fromFindings, notApplicable, retiredRule, unknown } from './result.js';
import type {
  CheckGraph,
  DocumentNode,
  FieldNode,
  FindingEvidence,
  FindingSeverity,
  RuleFinding,
  RuleParams,
  RuleResult,
  RuleSpec,
  WaiverRole,
} from './types.js';

// ---------------------------------------------------------------------------
// Коды реквизитов
// ---------------------------------------------------------------------------

/**
 * Коды реквизитов, которыми пользуется группа.
 *
 * Именованные константы, а не строковые литералы по месту: опечатка в
 * `'issued_at'` даёт правило, которое всегда находит поле пустым, то есть
 * ложное обвинение на каждом документе комплекта. Базовые коды приходят из
 * `@id/doc-types` (`BASE_EVIDENCE_FIELDS`), типовые — из экстрактора
 * `apps/api/src/segmentation/extract.ts`.
 */
export const EVIDENCE_FIELDS = {
  /** Базовые (`BASE_EVIDENCE_FIELDS`). */
  number: 'number',
  issuedAt: 'issued_at',
  validFrom: 'valid_from',
  validTo: 'valid_to',
  productMarks: 'product_marks',
  batchNo: 'batch_no',
  /** Типовые (`extract.ts`). */
  ndReference: 'nd_reference',
  ndRequirements: 'nd_requirements',
  /**
   * Таблица «показатель / норма по НД / фактически».
   *
   * Код у каждого вида свой, и читать надо ИМЕННО тот, что объявлен в его
   * схеме. До S55 `PASS.610` и `MILL.630` читали `nd_requirements` — код,
   * которого нет ни в схеме паспорта качества (там `indicators`), ни в схеме
   * сертификата качества металла (там `mechanical_properties`). Оба правила
   * исправно исполнялись и не находили ничего: паспорт № 112 папки «ИД Мастер
   * апрель 2026» с водоудерживающей способностью 97,7 % при норме «не менее
   * 98» прошёл проверку шесть раз подряд. Ровно этот класс расхождения
   * описан в `field-codes.test.ts`.
   */
  indicators: 'indicators',
  mechanicalProperties: 'mechanical_properties',
  concreteClass: 'concrete_class',
  steelClass: 'steel_class',
  ageDays: 'age_days',
  testedAt: 'tested_at',
  sampledAt: 'sampled_at',
  /** Прочность образцов: доля от требуемой и пара «фактическая / требуемая». */
  strengthPercent: 'strength_percent',
  strengthActual: 'strength_actual',
  strengthRequired: 'strength_required',
  /** Наименование работ: пункт 1 акта и привязка исполнительной схемы. */
  workName: 'work_name',
} as const;

/** Человеческие названия реквизитов для текста замечания. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  [EVIDENCE_FIELDS.number]: 'Номер документа',
  [EVIDENCE_FIELDS.issuedAt]: 'Дата выдачи',
  [EVIDENCE_FIELDS.validFrom]: 'Действителен с',
  [EVIDENCE_FIELDS.validTo]: 'Действителен по',
  [EVIDENCE_FIELDS.workName]: 'Наименование работ',
};

function labelOf(fieldCode: string): string {
  return FIELD_LABELS[fieldCode] ?? fieldCode;
}

// ---------------------------------------------------------------------------
// Виды документов группы
// ---------------------------------------------------------------------------

export const EVIDENCE_DOC_TYPES = {
  cert: 'cert_conformity',
  declaration: 'declaration',
  qualityPassport: 'quality_passport',
  technicalPassport: 'technical_passport',
  millCertificate: 'mill_certificate',
  mixQualityDoc: 'mix_quality_doc',
  labProtocolConcrete: 'lab_protocol_concrete',
  technicalConclusion: 'technical_conclusion',
  refusalLetter: 'refusal_letter',
  execScheme: 'exec_scheme',
} as const;

/**
 * Документы вида с уверенно определённым типом (§0.5, открытый мир).
 *
 * Резервный и неопознанный тип отфильтрованы здесь, а не в вызывающем коде:
 * типо-специфичное правило на незнакомом документе обязано молчать, и если бы
 * фильтр стоял в каждом правиле по-своему, одно из двенадцати рано или поздно
 * забыло бы его поставить.
 */
function knownDocuments(graph: CheckGraph, docTypeCode: string): DocumentNode[] {
  return graph.documents.filter(
    (document) =>
      document.isKnownType && !document.isFallbackType && document.docTypeCode === docTypeCode,
  );
}

function noDocumentsReason(docTypeCode: string): string {
  return `в комплекте нет документов вида «${docTypeCode}» с уверенно определённым типом`;
}

function docLabel(document: DocumentNode): string {
  const title = document.title;
  return title !== null && title.trim() !== ''
    ? `«${title.trim()}»`
    : `документ №${document.ordinal}`;
}

// ---------------------------------------------------------------------------
// Общая заготовка замечания
// ---------------------------------------------------------------------------

interface FindingBase {
  readonly origin: 'deterministic';
  readonly targetType: 'document';
  readonly targetId: string;
  readonly sourcePageId: string | null;
  readonly blockId: string | null;
  readonly evidence: readonly FindingEvidence[];
  readonly confidence: number | null;
}

/**
 * Адрес и провенанс замечания.
 *
 * `confidence` прикладывается ко ВСЕМУ, что опирается на распознанное значение:
 * понижение `open → undetermined` по низкой уверенности делает движок
 * централизованно (`softenByConfidence`), и правило, забывшее передать
 * уверенность, молча выключает эту защиту.
 */
function at(document: DocumentNode, source: FieldNode | null): FindingBase {
  return {
    origin: 'deterministic',
    targetType: 'document',
    targetId: document.id,
    sourcePageId: source?.sourcePageId ?? document.pages[0]?.sourcePageId ?? null,
    blockId: source?.blockId ?? null,
    evidence: evidenceOf(source),
    confidence: effectiveConfidence(source),
  };
}

/** Значение реквизита пусто во всех представлениях. */
function isEmptyValue(value: FieldNode): boolean {
  if (value.valueText !== null && value.valueText.trim() !== '') return false;
  if (value.valueDate !== null) return false;
  if (value.valueNum !== null) return false;
  const json = value.valueJson;
  if (Array.isArray(json) ? json.length > 0 : json !== null && json !== undefined) return false;
  return true;
}

/**
 * Отличить «поле пусто» от «страница не распознана» (дефект №5).
 *
 * Пустое поле — дефект ДОКУМЕНТА, и вердикт по нему `fail`. Но если у ревизии
 * нет распознанного текста или у документа не извлечено ни одного реквизита,
 * различить «в бланке пусто» и «страница пришла картинкой» нечем, и вывод
 * обязан быть `undetermined`. Техпаспорт МСЕТ из корпуса — ровно этот случай:
 * страница отдана единственным `image`-блоком (`docs/CORPUS_FINDINGS.md`).
 */
function unrecognizedGuard(graph: CheckGraph, document: DocumentNode): RuleFinding | null {
  if (!graph.hasRecognizedText) {
    return unknown({
      ...at(document, null),
      message: `${docLabel(document)}: у ревизии нет распознанного текста, заполненность реквизитов проверить нечем — требуется ручная проверка`,
      hint: 'дождитесь завершения распознавания либо проверьте реквизиты вручную',
    });
  }
  if (document.fields.length === 0) {
    return unknown({
      ...at(document, null),
      message: `${docLabel(document)}: реквизиты не извлечены (страница не распознана или пришла изображением) — требуется ручная проверка`,
      hint: 'откройте страницу документа и внесите реквизиты вручную',
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Обязательные реквизиты и непротиворечивость дат
// ---------------------------------------------------------------------------

interface RequisitesOptions {
  /** Коды обязательных реквизитов. */
  readonly required: readonly string[];
  /**
   * Требовать `valid_to` при указанном `valid_from`.
   *
   * Интервальная форма без даты окончания — дефект сертификата и декларации:
   * срок действия объявлен открытым, и `DATE.300` без верхней границы вывода
   * сделать не сможет.
   */
  readonly requireValidToWhenInterval: boolean;
}

function requisitesFindings(
  graph: CheckGraph,
  document: DocumentNode,
  options: RequisitesOptions,
): RuleFinding[] {
  const guard = unrecognizedGuard(graph, document);
  if (guard !== null) return [guard];

  const findings: RuleFinding[] = [];

  for (const code of options.required) {
    const value = field(document, code);
    if (value === null || isEmptyValue(value)) {
      /**
       * Номер партии — законная форма номера паспорта качества.
       *
       * Бланк паспорта на партию другого номера не печатает: «№ партии: 7,
       * Дата: 04.07.25». Реестр приложений называет такой документ «Паспорт
       * качества № 7», то есть номером партии, — и это не вольность
       * подрядчика, а то, как документ опознаётся в комплекте.
       *
       * В реквизит `number` номер партии не уезжает намеренно: у него свой
       * код `batch_no`, и захват его номером документа ломал сверку с
       * реестром на других формах. Поэтому подстановка живёт здесь — в
       * вопросе «заполнен ли реквизит», а не в извлечении.
       */
      if (code === EVIDENCE_FIELDS.number) {
        const batch = field(document, EVIDENCE_FIELDS.batchNo);
        if (batch !== null && !isEmptyValue(batch)) continue;
      }

      findings.push(
        defect({
          ...at(document, value),
          message: `${docLabel(document)}: поле „${labelOf(code)}“ не заполнено`,
          hint: `внесите значение поля «${labelOf(code)}» либо приложите документ с заполненным реквизитом`,
        }),
      );
    }
  }

  const validFrom = field(document, EVIDENCE_FIELDS.validFrom);
  const validTo = field(document, EVIDENCE_FIELDS.validTo);
  const issuedAt = field(document, EVIDENCE_FIELDS.issuedAt);
  const validFromDate = validFrom?.valueDate ?? null;
  const validToDate = validTo?.valueDate ?? null;
  const issuedAtDate = issuedAt?.valueDate ?? null;

  if (
    options.requireValidToWhenInterval &&
    isIsoDate(validFromDate) &&
    (validTo === null || isEmptyValue(validTo))
  ) {
    findings.push(
      defect({
        ...at(document, validFrom),
        message: `${docLabel(document)}: указана дата начала действия ${formatDate(validFromDate)}, но поле „${labelOf(EVIDENCE_FIELDS.validTo)}“ не заполнено`,
        hint: 'внесите дату окончания срока действия документа',
      }),
    );
  }

  if (isIsoDate(validFromDate) && isIsoDate(validToDate) && validFromDate > validToDate) {
    findings.push(
      defect({
        ...at(document, validTo),
        message: `${docLabel(document)}: дата начала действия ${formatDate(validFromDate)} позже даты окончания ${formatDate(validToDate)}`,
        hint: 'сверьте даты срока действия с оригиналом документа',
      }),
    );
  }

  if (isIsoDate(issuedAtDate) && isIsoDate(validToDate) && issuedAtDate > validToDate) {
    findings.push(
      defect({
        ...at(document, validTo),
        message: `${docLabel(document)}: дата выдачи ${formatDate(issuedAtDate)} позже даты окончания действия ${formatDate(validToDate)}`,
        hint: 'сверьте дату выдачи и срок действия с оригиналом документа',
      }),
    );
  }

  return findings;
}

function requiredFrom(params: RuleParams, fallback: readonly string[]): readonly string[] {
  const value = params['requiredFields'];
  if (!Array.isArray(value)) return fallback;
  const codes = value.filter((item): item is string => typeof item === 'string');
  return codes.length > 0 ? codes : fallback;
}

/** Правило заполненности реквизитов одного вида документа. */
function requisitesRule(spec: {
  readonly code: string;
  readonly title: string;
  readonly docTypeCode: string;
  readonly defaultSeverity: FindingSeverity;
  readonly defaultBlocking: boolean;
  readonly waiverRoles: readonly WaiverRole[];
  readonly required: readonly string[];
  readonly requireValidToWhenInterval: boolean;
}): RuleSpec {
  return {
    code: spec.code,
    title: spec.title,
    docTypeCode: spec.docTypeCode,
    level: 'document',
    kind: 'evidence',
    defaultSeverity: spec.defaultSeverity,
    defaultBlocking: spec.defaultBlocking,
    waiverRoles: spec.waiverRoles,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: { requiredFields: spec.required },
    evaluate: (graph, params): RuleResult => {
      const documents = knownDocuments(graph, spec.docTypeCode);
      if (documents.length === 0) return notApplicable(noDocumentsReason(spec.docTypeCode));

      const required = requiredFrom(params, spec.required);
      const findings = documents.flatMap((document) =>
        requisitesFindings(graph, document, {
          required,
          requireValidToWhenInterval: spec.requireValidToWhenInterval,
        }),
      );
      return fromFindings(findings);
    },
  };
}

// ---------------------------------------------------------------------------
// Правила
// ---------------------------------------------------------------------------

/** CERT.600 — сертификат соответствия. */
const CERT_600 = requisitesRule({
  code: 'CERT.600',
  title: 'Сертификат соответствия: обязательные реквизиты и срок',
  docTypeCode: EVIDENCE_DOC_TYPES.cert,
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  required: [EVIDENCE_FIELDS.number, EVIDENCE_FIELDS.issuedAt],
  requireValidToWhenInterval: true,
});

/** DECL.601 — декларация о соответствии. */
const DECL_601 = requisitesRule({
  code: 'DECL.601',
  title: 'Декларация о соответствии: обязательные реквизиты и срок',
  docTypeCode: EVIDENCE_DOC_TYPES.declaration,
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  required: [EVIDENCE_FIELDS.number, EVIDENCE_FIELDS.issuedAt],
  requireValidToWhenInterval: true,
});

/** PASS.611 — заполненность реквизитов паспорта качества. */
const PASS_611 = requisitesRule({
  code: 'PASS.611',
  title: 'Паспорт качества: обязательные реквизиты заполнены',
  docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
  defaultSeverity: 'error',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  required: [EVIDENCE_FIELDS.number, EVIDENCE_FIELDS.issuedAt],
  requireValidToWhenInterval: false,
});

/**
 * TP.620 — технический паспорт (дефект №5 корпуса).
 *
 * Ровно здесь ловится пустое поле «Дата выдачи»: реквизит есть в бланке, но не
 * заполнен. Различие с нераспознанной страницей держится в
 * `unrecognizedGuard` — см. его комментарий.
 */
const TP_620 = requisitesRule({
  code: 'TP.620',
  title: 'Технический паспорт: обязательные реквизиты заполнены',
  docTypeCode: EVIDENCE_DOC_TYPES.technicalPassport,
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  required: [EVIDENCE_FIELDS.number, EVIDENCE_FIELDS.issuedAt],
  requireValidToWhenInterval: false,
});

// ---------------------------------------------------------------------------
// Снятые в S59 (ADR-0029)
// ---------------------------------------------------------------------------

/**
 * Спек снятого правила: поля сида и снимков сохранены байт в байт, тело —
 * заглушка. Ни у одного из них у портала нет эталона для сравнения: норма
 * паспорта, марка стали, проектная марка смеси, прочность по возрасту образца
 * — всё это материаловедение, которое заказчик из проверок вывел. Вид
 * `technical_conclusion` снят из каталога видов той же работой, поэтому
 * `CONCL.660` ушло вместе с ним. `SCH.680` заменено `SCH.681` (`aosr.ts`):
 * привязку и подписи схемы текстом не определить, правило всегда отвечало «не
 * проверено».
 */
function retiredEvidenceRule(spec: {
  readonly code: string;
  readonly title: string;
  readonly docTypeCode: string;
  readonly defaultSeverity: FindingSeverity;
  readonly defaultBlocking: boolean;
  readonly waiverRoles: readonly WaiverRole[];
  readonly defaultParams: RuleParams;
}): RuleSpec {
  return {
    code: spec.code,
    title: spec.title,
    docTypeCode: spec.docTypeCode,
    level: 'document',
    kind: 'evidence',
    defaultSeverity: spec.defaultSeverity,
    defaultBlocking: spec.defaultBlocking,
    waiverRoles: spec.waiverRoles,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: spec.defaultParams,
    evaluate: retiredRule,
  };
}

/** Проектный возраст образца — параметр снятых LAB.650/651, напечатан в снимках. */
const DEFAULT_DESIGN_AGE_DAYS = 28;

const PASS_610 = retiredEvidenceRule({
  code: 'PASS.610',
  title: 'Паспорт качества: фактические значения в пределах нормы по НД',
  docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  defaultParams: {},
});

const MILL_630 = retiredEvidenceRule({
  code: 'MILL.630',
  title: 'Сертификат качества металла: марка и механические свойства',
  docTypeCode: EVIDENCE_DOC_TYPES.millCertificate,
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  defaultParams: {},
});

const MIX_640 = retiredEvidenceRule({
  code: 'MIX.640',
  title: 'Документ о качестве смеси: марка соответствует проектной',
  docTypeCode: EVIDENCE_DOC_TYPES.mixQualityDoc,
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  defaultParams: {},
});

const LAB_650 = retiredEvidenceRule({
  code: 'LAB.650',
  title: 'Протокол прочности: оценка результата по возрасту образца',
  docTypeCode: EVIDENCE_DOC_TYPES.labProtocolConcrete,
  defaultSeverity: 'error',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  defaultParams: { designAgeDays: DEFAULT_DESIGN_AGE_DAYS },
});

const LAB_651 = retiredEvidenceRule({
  code: 'LAB.651',
  title: 'Приёмочный протокол в проектном возрасте приложен',
  docTypeCode: EVIDENCE_DOC_TYPES.labProtocolConcrete,
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  defaultParams: { designAgeDays: DEFAULT_DESIGN_AGE_DAYS },
});

const CONCL_660 = retiredEvidenceRule({
  code: 'CONCL.660',
  title: 'Заключение: обязательные реквизиты и срок',
  docTypeCode: EVIDENCE_DOC_TYPES.technicalConclusion,
  defaultSeverity: 'warning',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  // Как у `requisitesRule`: список обязательных реквизитов напечатан в снимках.
  defaultParams: { requiredFields: [EVIDENCE_FIELDS.number, EVIDENCE_FIELDS.issuedAt] },
});

const SCH_680 = retiredEvidenceRule({
  code: 'SCH.680',
  title: 'Исполнительная схема: привязка и подписи',
  docTypeCode: EVIDENCE_DOC_TYPES.execScheme,
  defaultSeverity: 'warning',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  defaultParams: {},
});

/** REFUS.670 — отказное письмо. */
const REFUS_670 = requisitesRule({
  code: 'REFUS.670',
  title: 'Отказное письмо: обязательные реквизиты',
  docTypeCode: EVIDENCE_DOC_TYPES.refusalLetter,
  defaultSeverity: 'warning',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  required: [EVIDENCE_FIELDS.number, EVIDENCE_FIELDS.issuedAt],
  requireValidToWhenInterval: false,
});

/**
 * Группа §9.4 целиком.
 *
 * Порядок — по коду: на прогон он не влияет (движок сортирует сам), но делает
 * сид `rule_definitions` и diff каталога читаемыми.
 */
export const EVIDENCE_RULES: readonly RuleSpec[] = [
  CERT_600,
  DECL_601,
  PASS_610,
  PASS_611,
  TP_620,
  MILL_630,
  MIX_640,
  LAB_650,
  LAB_651,
  CONCL_660,
  REFUS_670,
  SCH_680,
];
