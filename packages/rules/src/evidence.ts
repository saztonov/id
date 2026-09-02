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
import {
  acts,
  childrenOf,
  effectiveConfidence,
  evidenceOf,
  field,
  formatDate,
  isIsoDate,
  listOf,
  normalizeMark,
  numberOf,
  textOf,
  threshold,
} from './helpers.js';
import { defect, fromFindings, notApplicable, unknown } from './result.js';
import { compare, normFactRows, parseMeasured, parseRequirement } from './tolerance.js';
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
// Сравнение «Норма по НД / Фактически»
// ---------------------------------------------------------------------------

/**
 * Автосравнение таблицы «показатель / норма / факт» (§9.4, `PASS`).
 *
 * Возвращает `null`, если таблицы в документе нет: «сравнивать нечего» и
 * «сравнение не сошлось» — разные ответы, и склеить их значило бы объявить
 * дефектом отсутствие таблицы, которой в форме документа может не быть вовсе.
 */
function normFactFindings(document: DocumentNode, fieldCode: string): RuleFinding[] | null {
  const source = field(document, fieldCode);
  if (source === null) return null;
  const rows = normFactRows(source.valueJson);
  if (rows.length === 0) return null;

  const findings: RuleFinding[] = [];
  for (const row of rows) {
    const indicator = row.indicator === '' ? 'показатель без названия' : row.indicator;
    const requirement = parseRequirement(row.norm);

    if (requirement.status === 'unparsed') {
      // Норма в документе не напечатана либо не приводится к числовому
      // требованию. Придумать её здесь значило бы нарушить §8.1.
      findings.push(
        unknown({
          ...at(document, source),
          message: `${docLabel(document)}, показатель «${indicator}»: ${requirement.reason} — требуется ручная проверка`,
          hint: 'сверьте фактическое значение с нормой по НД вручную',
        }),
      );
      continue;
    }

    const measured = parseMeasured(row.fact);
    if (measured === null) {
      findings.push(
        unknown({
          ...at(document, source),
          message: `${docLabel(document)}, показатель «${indicator}»: фактическое значение «${row.fact}» не приведено к числу — требуется ручная проверка`,
          hint: 'сверьте фактическое значение с нормой по НД вручную',
        }),
      );
      continue;
    }

    const verdict = compare(requirement.requirement, measured);
    if (verdict.status === 'violated') {
      findings.push(
        defect({
          ...at(document, source),
          message: `${docLabel(document)}, показатель «${indicator}»: ${verdict.explanation}`,
          hint: 'приложите документ о качестве с фактическим значением в пределах нормы либо обоснование отступления',
        }),
      );
    } else if (verdict.status === 'undecidable') {
      findings.push(
        unknown({
          ...at(document, source),
          message: `${docLabel(document)}, показатель «${indicator}»: ${verdict.reason} — требуется ручная проверка`,
          hint: 'сверьте фактическое значение с нормой по НД вручную',
        }),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Протоколы прочности
// ---------------------------------------------------------------------------

const DEFAULT_DESIGN_AGE_DAYS = 28;

function designAgeOf(graph: CheckGraph, params: RuleParams): number {
  return threshold(graph.profile, params, 'designAgeDays', DEFAULT_DESIGN_AGE_DAYS);
}

/** «71.78» → «71,78», «92» → «92»: десятичная запятая, без хвостовых нулей. */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(2))).replace('.', ',');
}

interface StrengthPercent {
  readonly percent: number | null;
  readonly source: FieldNode | null;
}

/**
 * Процент от требуемой прочности.
 *
 * Готовое значение приоритетно; пара «фактическая / требуемая» — резервный
 * путь. Требуемая берётся ИЗ ПРОТОКОЛА, а не из таблицы классов бетона: класс
 * B15 в коде означал бы норматив, введённый без верификации редакции (§8.1).
 */
function strengthPercentOf(document: DocumentNode): StrengthPercent {
  const direct = field(document, EVIDENCE_FIELDS.strengthPercent);
  if (direct !== null && direct.valueNum !== null) {
    return { percent: direct.valueNum, source: direct };
  }
  const actual = field(document, EVIDENCE_FIELDS.strengthActual);
  const required = field(document, EVIDENCE_FIELDS.strengthRequired);
  if (
    actual !== null &&
    actual.valueNum !== null &&
    required !== null &&
    required.valueNum !== null &&
    required.valueNum !== 0
  ) {
    return { percent: (actual.valueNum / required.valueNum) * 100, source: actual };
  }
  return { percent: null, source: direct ?? actual ?? null };
}

interface ProtocolGroup {
  readonly act: DocumentNode | null;
  readonly documents: readonly DocumentNode[];
}

/**
 * Протоколы, сгруппированные по акту.
 *
 * Если связей «акт → приложение» в графе нет, группа одна на ревизию: комплект
 * ревизии описывает один акт, и требовать связей значило бы выключить проверку
 * там, где граф документов ещё не построен.
 */
function protocolGroups(graph: CheckGraph, docTypeCode: string): ProtocolGroup[] {
  const all = knownDocuments(graph, docTypeCode);
  if (all.length === 0) return [];

  const groups: ProtocolGroup[] = [];
  const taken = new Set<string>();

  for (const act of acts(graph)) {
    const children = childrenOf(graph, act.id).filter((child) =>
      all.some((protocol) => protocol.id === child.id),
    );
    if (children.length === 0) continue;
    for (const child of children) taken.add(child.id);
    groups.push({ act, documents: children });
  }

  const rest = all.filter((protocol) => !taken.has(protocol.id));
  if (rest.length > 0) groups.push({ act: null, documents: rest });
  return groups;
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

/** PASS.610 — фактические значения паспорта против нормы, напечатанной рядом. */
const PASS_610: RuleSpec = {
  code: 'PASS.610',
  title: 'Паспорт качества: фактические значения в пределах нормы по НД',
  docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
  level: 'document',
  kind: 'evidence',
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  requiresSectionProfile: false,
  requiresExternalRegistry: null,
  defaultParams: {},
  evaluate: (graph): RuleResult => {
    const documents = knownDocuments(graph, EVIDENCE_DOC_TYPES.qualityPassport);
    if (documents.length === 0) {
      return notApplicable(noDocumentsReason(EVIDENCE_DOC_TYPES.qualityPassport));
    }

    const findings: RuleFinding[] = [];
    let compared = 0;
    for (const document of documents) {
      const rowFindings = normFactFindings(document, EVIDENCE_FIELDS.ndRequirements);
      if (rowFindings === null) continue;
      compared += 1;
      findings.push(...rowFindings);
    }

    if (compared === 0) {
      // Таблицы нет вовсе — сравнивать нечего. Это НЕ дефект: у части форм
      // паспорта таблицы «Норма по НД / Фактически» не бывает, и объявить её
      // отсутствие браком значило бы обвинить подрядчика в форме бланка.
      return notApplicable(
        'ни в одном паспорте качества нет таблицы «Норма по НД / Фактически» — сравнивать нечего',
      );
    }
    return fromFindings(findings);
  },
};

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

/** Марка проката в сертификате против марки, заявленной в комплекте. */
function markFindings(graph: CheckGraph, document: DocumentNode): RuleFinding[] {
  const steelClass = field(document, EVIDENCE_FIELDS.steelClass);
  const productMarks = field(document, EVIDENCE_FIELDS.productMarks);
  const source =
    steelClass !== null && !isEmptyValue(steelClass)
      ? steelClass
      : productMarks !== null && !isEmptyValue(productMarks)
        ? productMarks
        : null;
  const certMark =
    textOf(document, EVIDENCE_FIELDS.steelClass) ??
    listOf(document, EVIDENCE_FIELDS.productMarks)[0] ??
    null;

  if (certMark === null) {
    return [
      unknown({
        ...at(document, source),
        message: `${docLabel(document)}: марка проката в сертификате не распознана — требуется ручная проверка`,
        hint: 'внесите марку проката вручную либо приложите читаемую копию сертификата',
      }),
    ];
  }

  const linked = graph.materials.filter((material) => material.documentIds.includes(document.id));
  const pool = linked.length > 0 ? linked : graph.materials;
  const declared = pool
    .map((material) => material.mark)
    .filter((mark): mark is string => mark !== null && mark.trim() !== '');

  if (declared.length === 0) {
    return [
      unknown({
        ...at(document, source),
        message: `${docLabel(document)}: марка проката, заявленная в акте, не определена — сравнить марку «${certMark}» не с чем, требуется ручная проверка`,
        hint: 'укажите марку материала в пункте 3 акта либо сверьте марку вручную',
      }),
    ];
  }

  // `A240C` и `А240С` — одна марка в двух алфавитах: без фолдинга гомоглифов
  // сравнение даёт ложное расхождение (`docs/CORPUS_FINDINGS.md`).
  const normalized = normalizeMark(certMark);
  if (declared.some((mark) => normalizeMark(mark) === normalized)) return [];

  return [
    defect({
      ...at(document, source),
      message: `${docLabel(document)}: марка проката «${certMark}» не совпадает с заявленной в комплекте (${declared.join(', ')})`,
      hint: 'приложите сертификат качества на применённую марку проката либо исправьте марку в акте',
    }),
  ];
}

/** MILL.630 — сертификат качества металла: марка и механические свойства. */
const MILL_630: RuleSpec = {
  code: 'MILL.630',
  title: 'Сертификат качества металла: марка и механические свойства',
  docTypeCode: EVIDENCE_DOC_TYPES.millCertificate,
  level: 'document',
  kind: 'evidence',
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  requiresSectionProfile: false,
  requiresExternalRegistry: null,
  defaultParams: {},
  evaluate: (graph): RuleResult => {
    const documents = knownDocuments(graph, EVIDENCE_DOC_TYPES.millCertificate);
    if (documents.length === 0) {
      return notApplicable(noDocumentsReason(EVIDENCE_DOC_TYPES.millCertificate));
    }

    const findings: RuleFinding[] = [];
    for (const document of documents) {
      findings.push(...markFindings(graph, document));

      // Механические свойства сравниваются с нормой ИЗ САМОГО сертификата.
      // Таблицы классов проката в коде нет и не будет (§8.1).
      const mechanical = normFactFindings(document, EVIDENCE_FIELDS.ndRequirements);
      if (mechanical === null) {
        findings.push(
          unknown({
            ...at(document, field(document, EVIDENCE_FIELDS.ndRequirements)),
            message: `${docLabel(document)}: нормы механических свойств в сертификате не напечатаны, сравнить фактические значения не с чем — требуется ручная проверка`,
            hint: 'сверьте механические свойства с требованиями НД вручную',
          }),
        );
      } else {
        findings.push(...mechanical);
      }
    }
    return fromFindings(findings);
  },
};

/**
 * Проектная марка (класс) из пункта 1 акта: `B25`, `М150`, `М-150`.
 *
 * Разделитель обязателен слева и справа: без него «АОСР-150» и «А240С» дали бы
 * ложную марку, а ложная проектная марка порождает ложное расхождение на
 * каждом документе о качестве смеси.
 */
const DESIGN_MARK =
  /(?:^|[\s(,;:|«"])([BВ]\s?\d{1,3}(?:[.,]\d)?|[MМ]\s?-?\s?\d{2,4})(?=[\s),;:|»".]|$)/gu;

interface DesignMarks {
  readonly marks: readonly string[];
  readonly source: FieldNode | null;
}

function designMarksOf(graph: CheckGraph): DesignMarks {
  const marks: string[] = [];
  let source: FieldNode | null = null;
  for (const act of acts(graph)) {
    const workName = field(act, EVIDENCE_FIELDS.workName);
    const text = workName?.valueText ?? null;
    if (text === null || text.trim() === '') continue;
    for (const match of text.matchAll(DESIGN_MARK)) {
      const value = match[1];
      if (value === undefined) continue;
      marks.push(value.trim());
      source ??= workName;
    }
  }
  return { marks, source };
}

/** MIX.640 — марка смеси из документа о качестве против проектной. */
const MIX_640: RuleSpec = {
  code: 'MIX.640',
  title: 'Документ о качестве смеси: марка соответствует проектной',
  docTypeCode: EVIDENCE_DOC_TYPES.mixQualityDoc,
  level: 'document',
  kind: 'evidence',
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  requiresSectionProfile: false,
  requiresExternalRegistry: null,
  defaultParams: {},
  evaluate: (graph): RuleResult => {
    const documents = knownDocuments(graph, EVIDENCE_DOC_TYPES.mixQualityDoc);
    if (documents.length === 0) {
      return notApplicable(noDocumentsReason(EVIDENCE_DOC_TYPES.mixQualityDoc));
    }

    const design = designMarksOf(graph);
    const findings: RuleFinding[] = [];

    for (const document of documents) {
      const classField = field(document, EVIDENCE_FIELDS.concreteClass);
      const documentMark = textOf(document, EVIDENCE_FIELDS.concreteClass);

      if (documentMark === null) {
        findings.push(
          unknown({
            ...at(document, classField),
            message: `${docLabel(document)}: марка (класс) смеси в документе о качестве не распознана — требуется ручная проверка`,
            hint: 'внесите марку (класс) смеси вручную либо приложите читаемую копию документа',
          }),
        );
        continue;
      }

      if (design.marks.length === 0) {
        findings.push(
          unknown({
            ...at(document, classField),
            message: `${docLabel(document)}: проектная марка (класс) в пункте 1 акта не найдена — сравнить марку «${documentMark}» не с чем, требуется ручная проверка`,
            hint: 'укажите проектную марку (класс) смеси в пункте 1 акта либо сверьте её вручную',
          }),
        );
        continue;
      }

      const normalized = normalizeMark(documentMark);
      if (design.marks.some((mark) => normalizeMark(mark) === normalized)) continue;

      findings.push(
        defect({
          ...at(document, classField),
          message: `${docLabel(document)}: марка (класс) смеси «${documentMark}» не совпадает с проектной по пункту 1 акта (${design.marks.join(', ')})`,
          hint: 'приложите документ о качестве на проектную марку смеси либо обоснуйте замену',
        }),
      );
    }

    return fromFindings(findings);
  },
};

/**
 * LAB.650 — оценка результата испытания ПО ВОЗРАСТУ образца.
 *
 * Методологически ключевое правило группы. В образце корпуса все пять
 * протоколов семисуточные (10,57 МПа = 71,78 % при М150), и это НОРМАЛЬНЫЙ
 * промежуточный контроль: объявить его браком — такая же ошибка, как не
 * заметить отсутствия 28-суточных (это ловит `LAB.651`).
 *
 * ## Почему промежуточный контроль — `undetermined`, а не `open`
 *
 * По содержанию это информационный факт, а не дефект, и §9.4 задаёт ему тяжесть
 * `info`. Но состояние `open` в `result.ts` означает «дефект найден», и
 * `fromFindings`/`inconsistencyOf` выводят из него вердикт `fail` без
 * исключений: правило физически не может вернуть не-`fail` при открытом
 * замечании. Семисуточный протокол, дающий `fail`, — ровно то ложное
 * обвинение, против которого написано правило.
 *
 * Поэтому состояние — `undetermined`, и по §9.1 это точно по смыслу: «правило
 * применимо, но данных для вывода нет». Испытание в возрасте 7 суток НЕ
 * позволяет заключить, набрана ли проектная прочность; вывод делается по
 * приёмочному протоколу, наличие которого проверяет `LAB.651`. Тяжесть при этом
 * понижена до `info` через `severityOverride`, и факт попадает в отчёт.
 */
const LAB_650: RuleSpec = {
  code: 'LAB.650',
  title: 'Протокол прочности: оценка результата по возрасту образца',
  docTypeCode: EVIDENCE_DOC_TYPES.labProtocolConcrete,
  level: 'document',
  kind: 'evidence',
  defaultSeverity: 'error',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  requiresSectionProfile: false,
  requiresExternalRegistry: null,
  defaultParams: { designAgeDays: DEFAULT_DESIGN_AGE_DAYS },
  evaluate: (graph, params): RuleResult => {
    const documents = knownDocuments(graph, EVIDENCE_DOC_TYPES.labProtocolConcrete);
    if (documents.length === 0) {
      return notApplicable(noDocumentsReason(EVIDENCE_DOC_TYPES.labProtocolConcrete));
    }

    const designAge = designAgeOf(graph, params);
    const findings: RuleFinding[] = [];

    for (const document of documents) {
      const ageField = field(document, EVIDENCE_FIELDS.ageDays);
      const age = numberOf(document, EVIDENCE_FIELDS.ageDays);
      const { percent, source } = strengthPercentOf(document);

      if (age === null) {
        findings.push(
          unknown({
            ...at(document, ageField),
            message: `${docLabel(document)}: возраст образца не определён, оценить результат испытания нечем — требуется ручная проверка`,
            hint: 'внесите возраст образца в сутках либо приложите читаемую копию протокола',
          }),
        );
        continue;
      }

      if (percent === null) {
        findings.push(
          unknown({
            ...at(document, source ?? ageField),
            message: `${docLabel(document)}: процент от требуемой прочности не определён (нет ни доли от требуемой, ни пары «фактическая / требуемая») — требуется ручная проверка`,
            hint: 'внесите фактическую и требуемую прочность либо долю от требуемой',
          }),
        );
        continue;
      }

      if (age < designAge) {
        findings.push(
          unknown({
            ...at(document, source ?? ageField),
            severityOverride: 'info',
            message: `${docLabel(document)}: промежуточный контроль, ${formatNumber(percent)} % от требуемой в возрасте ${formatNumber(age)} суток; вывод о наборе проектной прочности по этому протоколу не делается`,
            hint: `приложите приёмочный протокол в проектном возрасте ${formatNumber(designAge)} суток — его наличие проверяет правило LAB.651`,
          }),
        );
        continue;
      }

      if (percent < 100) {
        findings.push(
          defect({
            ...at(document, source ?? ageField),
            message: `${docLabel(document)}: в возрасте ${formatNumber(age)} суток набрано ${formatNumber(percent)} % от требуемой прочности`,
            hint: 'приложите протокол повторных испытаний либо заключение о пригодности конструкции',
          }),
        );
      }
    }

    return fromFindings(findings);
  },
};

/**
 * LAB.651 — приёмочный протокол в проектном возрасте (дефект №7 корпуса).
 *
 * «Отсутствие 28-суточных протоколов прочности при наличии семисуточных».
 * Правило намеренно отделено от `LAB.650`: там оценивается ОТДЕЛЬНЫЙ протокол,
 * здесь — СОСТАВ приложений. Слить их значило бы либо потерять дефект (каждый
 * семисуточный протокол сам по себе исправен), либо объявить браком нормальный
 * промежуточный контроль.
 */
const LAB_651: RuleSpec = {
  code: 'LAB.651',
  title: 'Приёмочный протокол в проектном возрасте приложен',
  docTypeCode: EVIDENCE_DOC_TYPES.labProtocolConcrete,
  level: 'document',
  kind: 'evidence',
  defaultSeverity: 'error',
  defaultBlocking: true,
  waiverRoles: ['manager', 'admin'],
  requiresSectionProfile: false,
  requiresExternalRegistry: null,
  defaultParams: { designAgeDays: DEFAULT_DESIGN_AGE_DAYS },
  evaluate: (graph, params): RuleResult => {
    const groups = protocolGroups(graph, EVIDENCE_DOC_TYPES.labProtocolConcrete);
    if (groups.length === 0) {
      return notApplicable(noDocumentsReason(EVIDENCE_DOC_TYPES.labProtocolConcrete));
    }

    const designAge = designAgeOf(graph, params);
    const findings: RuleFinding[] = [];

    for (const group of groups) {
      const entries = group.documents.map((document) => ({
        document,
        source: field(document, EVIDENCE_FIELDS.ageDays),
        age: numberOf(document, EVIDENCE_FIELDS.ageDays),
      }));

      const anchor = group.act ?? group.documents[0] ?? null;
      if (anchor === null) continue;

      const known = entries.filter(
        (entry): entry is (typeof entries)[number] & { age: number } => entry.age !== null,
      );

      if (known.length === 0) {
        findings.push(
          unknown({
            ...at(anchor, entries[0]?.source ?? null),
            message: `возраст образцов не определён ни в одном из ${entries.length} протоколов прочности — установить наличие приёмочного протокола нечем, требуется ручная проверка`,
            hint: 'внесите возраст образцов в сутках либо приложите читаемые копии протоколов',
          }),
        );
        continue;
      }

      if (known.some((entry) => entry.age >= designAge)) continue;

      const intermediate = known.filter((entry) => entry.age < designAge);
      if (intermediate.length === 0) continue;

      const observed = [...new Set(intermediate.map((entry) => formatNumber(entry.age)))].join(
        ', ',
      );
      // Уверенность — минимальная среди возрастов, на которых держится вывод:
      // понижение `open → undetermined` при плохом OCR делает движок.
      const confidence = intermediate.reduce<number | null>((acc, entry) => {
        const value = effectiveConfidence(entry.source);
        if (value === null) return acc;
        return acc === null ? value : Math.min(acc, value);
      }, null);

      findings.push(
        defect({
          ...at(anchor, intermediate[0]?.source ?? null),
          confidence,
          message: `приёмочный протокол в проектном возрасте (${formatNumber(designAge)} суток) не приложен, приложены только промежуточные (${observed} суток)`,
          hint: `приложите протокол испытания образцов в проектном возрасте ${formatNumber(designAge)} суток`,
        }),
      );
    }

    return fromFindings(findings);
  },
};

/** CONCL.660 — техническое заключение. */
const CONCL_660 = requisitesRule({
  code: 'CONCL.660',
  title: 'Заключение: обязательные реквизиты и срок',
  docTypeCode: EVIDENCE_DOC_TYPES.technicalConclusion,
  defaultSeverity: 'warning',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  required: [EVIDENCE_FIELDS.number, EVIDENCE_FIELDS.issuedAt],
  requireValidToWhenInterval: false,
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
 * SCH.680 — исполнительная схема: привязка и подписи.
 *
 * Текстом этот тип не определяется в принципе (`docs/CORPUS_FINDINGS.md`, 0 из
 * 4): слов «исполнительная схема» нет ни в тексте, ни в штампе, а страница
 * состоит из `image`-блока и легенды. Поэтому отсутствие данных здесь —
 * ожидаемое состояние и даёт `undetermined`, а не `fail`.
 */
const SCH_680: RuleSpec = {
  code: 'SCH.680',
  title: 'Исполнительная схема: привязка и подписи',
  docTypeCode: EVIDENCE_DOC_TYPES.execScheme,
  level: 'document',
  kind: 'evidence',
  defaultSeverity: 'warning',
  defaultBlocking: false,
  waiverRoles: ['engineer', 'manager', 'admin'],
  requiresSectionProfile: false,
  requiresExternalRegistry: null,
  defaultParams: {},
  evaluate: (graph): RuleResult => {
    const documents = knownDocuments(graph, EVIDENCE_DOC_TYPES.execScheme);
    if (documents.length === 0) {
      return notApplicable(noDocumentsReason(EVIDENCE_DOC_TYPES.execScheme));
    }

    const findings: RuleFinding[] = [];
    for (const document of documents) {
      const workName = field(document, EVIDENCE_FIELDS.workName);
      const title = document.title;
      const binding =
        textOf(document, EVIDENCE_FIELDS.workName) ??
        (title !== null && title.trim() !== '' ? title.trim() : null);
      const noData = !graph.hasRecognizedText || document.fields.length === 0;

      if (binding === null) {
        findings.push(
          noData
            ? unknown({
                ...at(document, workName),
                message: `${docLabel(document)}: текст схемы не распознан, привязку к работам установить нечем — требуется ручная проверка`,
                hint: 'проверьте привязку схемы к пункту 1 акта вручную',
              })
            : defect({
                ...at(document, workName),
                message: `${docLabel(document)}: привязка схемы к освидетельствованным работам не указана`,
                hint: 'укажите на схеме наименование работ, согласованное с пунктом 1 акта',
              }),
        );
      }

      // Штамп с подписями виден по блоку вида `stamp`: собственного текста
      // «подписи» на схеме нет, а выводить наличие подписей из его отсутствия
      // значило бы обвинять по признаку, которого в данных не бывает.
      if (!document.fields.some((value) => value.blockType === 'stamp')) {
        findings.push(
          unknown({
            ...at(document, null),
            message: noData
              ? `${docLabel(document)}: блоки страницы схемы не размечены, наличие штампа с подписями установить нечем — требуется ручная проверка`
              : `${docLabel(document)}: штамп с подписями на схеме не обнаружен — требуется ручная проверка`,
            hint: 'откройте страницу схемы и подтвердите наличие штампа с подписями вручную',
          }),
        );
      }
    }

    return fromFindings(findings);
  },
};

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
