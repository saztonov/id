/**
 * Чек-лист АОСР, перекрёстные сверки комплекта и внешние реестры (§9.3, §9.5).
 *
 * Файл держит три группы правил, связанные одним предметом — комплектом
 * исполнительной документации вокруг акта освидетельствования скрытых работ:
 * `AOSR.*` проверяют сам акт, `REG/MAT/REF/XS.*` сверяют его с реестром
 * приложений, материалами и справочниками, `EXT.*` читают уже разрешённый
 * снимок внешних реестров.
 *
 * ## Три решения, из-за которых файл написан именно так
 *
 * 1. **Правило НЕ понижает свой вердикт по уверенности само.** `AOSR.HDR.022`
 *    обязан дать `fail` на ОГРН из 12 цифр и `undetermined` на ОГРН с битой
 *    контрольной суммой, вычитанном с круглой печати. Различает их не сам
 *    номер — потеря цифры при OCR объясняет оба случая одинаково, — а
 *    уверенность источника. Поэтому правило лишь прикладывает к замечанию
 *    `confidence: effectiveConfidence(поле)`, а понижение `open → undetermined`
 *    делает движок (`softenByConfidence`). Защита, размазанная по сорока
 *    правилам, — это сорок мест, где о ней можно забыть (см. `result.ts`).
 *
 * 2. **Сверка с реестром идёт по НОМЕРУ, а не по виду документа.** В корпусе
 *    реестр называет все двенадцать документов о качестве просто «Документ о
 *    качестве», а лист под ним озаглавлен «СЕРТИФИКАТ КАЧЕСТВА № 16005»
 *    (`docs/CORPUS_FINDINGS.md`). Правила «вид в реестре не совпал» здесь нет и
 *    быть не может: подрядчик заполняет реестр от руки и обобщает.
 *
 * 3. **Незнакомое не порождает ошибку.** Движок отсекает правила с
 *    `docTypeCode` до вызова, но тело правила фильтрует документы повторно
 *    (`isKnownType && !isFallbackType`): правила уровня ревизии видят весь
 *    комплект, включая резервные типы, и не вправе делать о них выводов.
 *
 * Нормативных таблиц ГОСТ и СП здесь нет намеренно (§0.5): всё, чего нет в
 * документе, справочнике, профиле раздела или параметрах снимка, считается
 * неизвестным, а неизвестное даёт `undetermined`, а не `fail`.
 */
import type { FindingTargetType, IdentifierCheck } from '@id/contracts';
import { checkInn, checkOgrn, normalizeDocNo } from '@id/contracts';

import {
  ACT_FIELDS,
  ACT_TYPES,
  REGISTRY_TYPE,
  actField,
  actListOf,
  actTextOf,
  categoryInProfile,
  digitsOf,
  documentById,
  effectiveConfidence,
  evidenceOf,
  field,
  formatDate,
  isIsoDate,
  listOf,
  listParam,
  matchCounterparty,
  matrixFor,
  normalizeOrgName,
  parentsOf,
  standardWithoutYear,
  standardYear,
  textOf,
  threshold,
} from './helpers.js';
import { defect, externalUnavailable, fromFindings, notApplicable, unknown } from './result.js';
import type {
  CheckGraph,
  CounterpartyNode,
  DocumentNode,
  FieldNode,
  FindingSeverity,
  RuleFinding,
  RuleFn,
  RuleKind,
  RegistryRowNode,
  RuleParams,
  RuleResult,
  RuleSpec,
} from './types.js';

// ---------------------------------------------------------------------------
// Коды реквизитов
// ---------------------------------------------------------------------------

/**
 * Коды реквизитов, которые читают правила этого файла.
 *
 * ## Почему это теперь ре-экспорт, а не собственная таблица
 *
 * Собственная таблица прожила до S27 и всё это время называла семь реквизитов
 * именами, которых нет ни в каталоге, ни в одном экстракторе: `date_start`,
 * `date_end`, `work_name`, `p4_annexes`, `rd_cipher`, `signers`,
 * `contractor_*`. Правила исправно работали и никогда ничего не находили —
 * ровно тот молчаливый отказ, о котором предупреждал комментарий над таблицей.
 * Предупреждение не помогло, потому что второй список всё равно оставался
 * вторым списком.
 *
 * Теперь имя реквизита акта живёт в одном месте (`helpers.ts`, `ACT_FIELDS`) и
 * сверяется тестом со схемой типа `aosr` в каталоге и со списком реализованных
 * экстракторов. Здесь остаётся ре-экспорт под прежним именем: `AOSR_FIELDS`
 * читает офлайн-харнес, и переименование ради переименования — правка чужого
 * кода.
 */
export const AOSR_FIELDS = {
  ...ACT_FIELDS,
  /** Базовые реквизиты доказательных документов (`base-fields.ts`). */
  number: 'number',
  manufacturer: 'manufacturer',
  gostTu: 'gost_tu',
  /** Типовой реквизит (`extract.ts`). */
  ndReference: 'nd_reference',
} as const;

/**
 * Подписанты бланка РД-11-02 и реквизиты их приказов.
 *
 * Это не нормативная таблица, а состав полей типа `aosr` из каталога
 * (`packages/doc-types/src/catalog.ts`, где эти четыре роли объявлены
 * `required: true`). Снимок ruleset может сузить список параметром
 * `requiredSignerFields`.
 */
export const AOSR_SIGNER_ROLES = [
  {
    field: 'rep_developer',
    order: 'rep_developer_order',
    label: 'представитель застройщика (технического заказчика)',
  },
  {
    field: 'rep_builder',
    order: 'rep_builder_order',
    label: 'представитель лица, осуществляющего строительство',
  },
  {
    field: 'rep_builder_control',
    order: 'rep_builder_control_order',
    label: 'представитель по строительному контролю',
  },
  {
    field: 'rep_contractor',
    order: 'rep_contractor_order',
    label: 'представитель лица, выполнившего работы',
  },
] as const;

type SignerRole = (typeof AOSR_SIGNER_ROLES)[number];

/** Код типа акта освидетельствования скрытых работ. */
const AOSR_TYPE = 'aosr';

/** Сертификаты соответствия и декларации: ими подтверждается изготовитель. */
const CERTIFICATE_TYPES: readonly string[] = ['cert_conformity', 'declaration'];

/** Паспорта и сертификаты качества: источник НД со стороны партии. */
const PASSPORT_TYPES: readonly string[] = [
  'quality_passport',
  'technical_passport',
  'mill_certificate',
];

/** Исполнительные схемы. */
const SCHEME_TYPE = /^exec_/u;

/** Журнал (учётный лист) авторского надзора: приложение к акту, но не к материалу. */
const SUPERVISION_LOG_TYPE = 'author_supervision_log';

const NO_ACTS = 'в комплекте нет акта освидетельствования с уверенно определённым типом';

// ---------------------------------------------------------------------------
// Общее
// ---------------------------------------------------------------------------

/** Адресация замечания: куда указывать и чем подтверждать. */
type Anchor = Pick<
  RuleFinding,
  'targetType' | 'targetId' | 'sourcePageId' | 'blockId' | 'evidence' | 'confidence'
>;

function anchorOfDocument(document: DocumentNode): Anchor {
  return {
    targetType: 'document',
    targetId: document.id,
    sourcePageId: document.pages[0]?.sourcePageId ?? null,
    blockId: null,
    evidence: [],
    confidence: null,
  };
}

/**
 * Адресация по реквизиту.
 *
 * `confidence` прикладывается ВСЕГДА, когда факт опирается на распознанное
 * значение: без него централизованный запрет «низкая уверенность не даёт
 * `fail`» не действует, и ОГРН с печати дал бы ложное обвинение в подделке.
 */
function anchorOfField(document: DocumentNode, value: FieldNode | null): Anchor {
  if (value === null) return anchorOfDocument(document);
  return {
    targetType: 'field_value',
    targetId: value.id,
    sourcePageId: value.sourcePageId,
    blockId: value.blockId,
    evidence: evidenceOf(value),
    confidence: effectiveConfidence(value),
  };
}

function anchorOf(targetType: FindingTargetType, targetId: string | null): Anchor {
  return {
    targetType,
    targetId,
    sourcePageId: null,
    blockId: null,
    evidence: [],
    confidence: null,
  };
}

/**
 * Итог правила, различающий «проверено и всё в порядке» и «проверять было
 * нечего».
 *
 * `n_a` возвращается ровно тогда, когда правило не проверило ни одного объекта
 * и не имеет что сказать: иначе `pass` на пустом комплекте выглядел бы как
 * успешная проверка — тот самый неразличимый случай, ради которого §9.1 ввёл
 * четвёртый вердикт.
 */
function summarize(findings: readonly RuleFinding[], checked: number, reason: string): RuleResult {
  if (findings.length === 0 && checked === 0) return notApplicable(reason);
  return fromFindings(findings);
}

/** Акты с уверенно определённым типом (§9.1, строка 1). */
function aosrActs(graph: CheckGraph): DocumentNode[] {
  return graph.documents.filter(
    (document) =>
      document.docTypeCode === AOSR_TYPE && document.isKnownType && !document.isFallbackType,
  );
}

function actLabel(act: DocumentNode): string {
  const number = actTextOf(act, AOSR_FIELDS.actNumber) ?? textOf(act, AOSR_FIELDS.number);
  return number === null ? `(документ ${String(act.ordinal)})` : `№ ${number}`;
}

/** Поле наименования работ п. 1 — канонический код и его исторические имена. */
function workNameField(act: DocumentNode): FieldNode | null {
  return actField(act, AOSR_FIELDS.workName);
}

function trimmedText(value: FieldNode | null): string | null {
  const text = value?.valueText ?? null;
  return text === null || text.trim() === '' ? null : text.trim();
}

/** Сравнение фраз: регистр, «ё» и пунктуация значения не меняют. */
function normalizePhrase(value: string): string {
  return value
    .toUpperCase()
    .replace(/Ё/gu, 'Е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Фамилия плюс инициалы: «Иванов И.И.» и «Иванов Иван Иванович» дают одно. */
function personKey(value: string): string {
  const tokens = value
    .toUpperCase()
    .replace(/Ё/gu, 'Е')
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length > 0);
  const surname = tokens[0];
  if (surname === undefined) return '';
  return (
    surname +
    tokens
      .slice(1)
      .map((token) => token.slice(0, 1))
      .join('')
  );
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringMatrix(value: unknown): readonly (readonly string[])[] {
  return Array.isArray(value)
    ? value.map((group) => stringList(group)).filter((group) => group.length > 0)
    : [];
}

function documentsOf(graph: CheckGraph, ids: readonly string[]): DocumentNode[] {
  return ids
    .map((id) => documentById(graph, id))
    .filter((document): document is DocumentNode => document !== null);
}

function isTypeOf(document: DocumentNode, codes: readonly string[]): boolean {
  return (
    document.isKnownType &&
    !document.isFallbackType &&
    document.docTypeCode !== null &&
    codes.includes(document.docTypeCode)
  );
}

function signerRolesFrom(params: RuleParams): readonly SignerRole[] {
  const codes = listParam(
    params,
    'requiredSignerFields',
    AOSR_SIGNER_ROLES.map((role) => role.field),
  );
  return AOSR_SIGNER_ROLES.filter((role) => codes.includes(role.field));
}

/**
 * Номер документа, названный внутри строки перечня приложений.
 *
 * Границей служит то, что за номером ИДЁТ: предлог «от» перед датой, запятая,
 * точка с запятой, скобка или конец строки. Пробелом граница быть не может —
 * он встречается внутри номера («№ РОСС RU BY.HE06.H22245»), а в акте так
 * записан и номер схемы: «№ 48.1-от/-1 этаж от 10.04.2026г.». Пока номер
 * обрывался на первом пробеле, из него уходило «этаж», и схема, лежащая в
 * комплекте, не находилась.
 *
 * «Не» и «No» — то, во что OCR превращает «№»: в папке так прочитано больше
 * четверти номеров, и без них строка молча становилась «названной без номера».
 */
const DOC_NO_IN_TEXT =
  /(?:№|Не(?=\s*[0-9A-ZА-Я])|No|N(?![p{L}]))\s*([^,;()]+?)(?=\s+от\s|\s*[,;()]|$)/u;

function docNoOf(text: string): string | null {
  const raw = DOC_NO_IN_TEXT.exec(text)?.[1];
  if (raw === undefined) return null;
  const trimmed = raw.replace(/[.,;:]+$/u, '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Есть ли в комплекте документ с таким номером.
 *
 * Сверка идёт ТОЛЬКО по номеру: вид документа в реестре и в перечне приложений
 * подрядчик обобщает («Документ о качестве» на двенадцати разных формах), и
 * расхождение вида дефектом не является (`docs/CORPUS_FINDINGS.md`).
 */
/**
 * Ведущее число номера листа чертежа: «48.1» из «48.1-ОТ/-1 ЭТАЖ».
 *
 * Им схема названа в акте и им же подписана сама: остальное — обозначение
 * захватки, которое подрядчик пишет как придётся («-1 этаж», «/1-1ЭТАЖ»,
 * «1-1 ЭТАЖ»), а распознавание довершает разночтение.
 */
const SHEET_NUMBER_HEAD = /^\d+(?:\.\d+)+/u;

function sheetNumberHead(value: string): string | null {
  return SHEET_NUMBER_HEAD.exec(normalizeDocNo(value).folded)?.[0] ?? null;
}

/** Ссылается ли строка перечня на исполнительную схему. */
const SCHEME_REFERENCE = /схем/iu;

type NumberedLookup = 'found' | 'undetermined' | 'missing';

/**
 * Есть ли в комплекте документ с таким номером.
 *
 * Сверка идёт ТОЛЬКО по номеру: вид документа в реестре и в перечне приложений
 * подрядчик обобщает («Документ о качестве» на двенадцати разных формах), и
 * расхождение вида дефектом не является (`docs/CORPUS_FINDINGS.md`).
 *
 * Три исхода вместо двух — из-за исполнительных схем. У листа чертежа нет
 * заголовка, свой номер он несёт верхней надписью над штампом, и распознаётся
 * она хуже прочего текста: в папке «ИД Мастер апрель 2026» тот же номер
 * прочитан как «48.1-ОТП-1», «49.1-от1-1», «521-от 1этмж». Точное сравнение
 * объявляло отсутствующими двенадцать схем, которые лежат в комплекте, —
 * то есть портал винил подрядчика в собственном чтении.
 *
 * Поэтому у ссылки на схему две дополнительные ступени. Сначала — ведущее
 * число: «48.1» распознаётся устойчиво, а хвост захватки нет. Если и оно не
 * сошлось, но схема в комплекте есть, вердикт `undetermined`: утверждать
 * отсутствие документа, глядя на плохо прочитанный номер, нельзя.
 */
function hasDocumentNumbered(graph: CheckGraph, docNo: string, entry: string): NumberedLookup {
  const wanted = normalizeDocNo(docNo);
  const inDocuments = graph.documents.some((document) => {
    const number = textOf(document, AOSR_FIELDS.number);
    if (number === null) return false;
    const actual = normalizeDocNo(number);
    return actual.normalized === wanted.normalized || actual.folded === wanted.folded;
  });
  if (inDocuments) return 'found';

  const inRegistry = graph.registryRows.some(
    (row) =>
      row.matchedDocumentId !== null &&
      (row.docNoNorm === wanted.normalized || row.docNoFolded === wanted.folded),
  );
  if (inRegistry) return 'found';

  if (!SCHEME_REFERENCE.test(entry)) return 'missing';

  const schemes = graph.documents.filter(
    (document) => document.docTypeCode !== null && SCHEME_TYPE.test(document.docTypeCode),
  );
  if (schemes.length === 0) return 'missing';

  const head = sheetNumberHead(docNo);
  if (
    head !== null &&
    schemes.some((scheme) => {
      const number = textOf(scheme, AOSR_FIELDS.number);
      return number !== null && sheetNumberHead(number) === head;
    })
  ) {
    return 'found';
  }

  return 'undetermined';
}

// ---------------------------------------------------------------------------
// Количественные признаки (дефект №6 корпуса)
// ---------------------------------------------------------------------------

/**
 * Пары «число + существительное» в наименовании работ и схемы.
 *
 * Длинные формы стоят раньше коротких, а хвостовой `(?!\p{L})` не даёт «ряд»
 * совпасть внутри «ряда». Именно лукахед, а не `\b`: граница слова определена
 * через `\w`, то есть через ASCII, и после кириллической буквы её не бывает —
 * `\b` молча не совпал бы ни разу на русском тексте.
 */
const QUANTITY = /(\d+)\s*(слоёв|слоев|слоя|слой|рядов|ряда|ряд|мм|шт)(?!\p{L})/giu;

/** Словоформа → основа: сравниваются числа при ОДНОЙ основе. */
const QUANTITY_STEMS: Readonly<Record<string, string>> = {
  СЛОЙ: 'слой',
  СЛОЯ: 'слой',
  СЛОЁВ: 'слой',
  СЛОЕВ: 'слой',
  РЯД: 'ряд',
  РЯДА: 'ряд',
  РЯДОВ: 'ряд',
  ММ: 'мм',
  ШТ: 'шт',
};

/** Основа → множество названных при ней чисел. */
function quantitiesOf(texts: readonly string[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const text of texts) {
    for (const match of text.matchAll(QUANTITY)) {
      const rawNumber = match[1];
      const rawWord = match[2];
      if (rawNumber === undefined || rawWord === undefined) continue;
      const stem = QUANTITY_STEMS[rawWord.toUpperCase()];
      if (stem === undefined) continue;
      const bucket = result.get(stem) ?? new Set<number>();
      bucket.add(Number(rawNumber));
      result.set(stem, bucket);
    }
  }
  return result;
}

function formatNumbers(values: Set<number>): string {
  return [...values].sort((a, b) => a - b).join(', ');
}

// ---------------------------------------------------------------------------
// AOSR.HDR — шапка акта
// ---------------------------------------------------------------------------

function evaluateObjectName(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const cardNames = [graph.object.name, graph.object.fullName].filter(
    (name): name is string => name !== null && name.trim() !== '',
  );
  if (cardNames.length === 0) {
    return notApplicable('в карточке объекта не заполнено наименование');
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const value = actField(act, AOSR_FIELDS.objectName);
    const text = trimmedText(value);
    if (text === null) {
      findings.push(
        unknown({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознано наименование объекта капитального строительства — сверить с карточкой объекта нечем.`,
          hint: 'Откройте страницу акта, введите наименование объекта вручную и подтвердите реквизит.',
        }),
      );
      continue;
    }

    checked += 1;
    const actual = normalizeOrgName(text);
    const matched = cardNames.some((name) => {
      const expected = normalizeOrgName(name);
      return (
        expected !== '' &&
        actual !== '' &&
        (expected === actual || expected.includes(actual) || actual.includes(expected))
      );
    });
    if (matched) continue;

    findings.push(
      defect({
        ...anchorOfField(act, value),
        origin: 'deterministic',
        message: `Наименование объекта в акте ${actLabel(act)} — «${text}» — не совпадает с карточкой объекта «${cardNames.join('», «')}».`,
        hint: 'Приведите наименование объекта в шапке акта к формулировке карточки объекта либо исправьте карточку.',
      }),
    );
  }

  return summarize(findings, checked, 'ни в одном акте не распознано наименование объекта');
}

/**
 * Реквизиты стороны в шапке акта.
 *
 * ## Почему «реквизита нет» и «графа пуста» — разные вердикты
 *
 * До S27 правило объявляло `defect` на всякий отсутствующий реквизит и на
 * реальном корпусе выдавало ТРИ ложные ошибки на каждый комплект: `contractor_*`
 * не производил ни один экстрактор, и подрядчик получал обвинение в незаполненной
 * шапке за то, что портал её не прочитал. Это ровно тот сорт замечания, который
 * §0.5 называет разрушающим доверие быстрее пропуска.
 *
 * Различие выражено формой данных, а не догадкой. Узла нет вовсе — извлечение до
 * реквизита не дошло, вердикт `undetermined`. Узел есть, значение пустое —
 * значит реквизит ИСКАЛИ и нашли пустую графу, и это дефект бумаги. Тот же приём
 * уже применён в `evaluateItem1` к п. 1; наблюдаемое пустое значение производит
 * LLM-ступень извлечения (см. `llm-extract.ts`).
 *
 * ## Почему неизвлечённое — ОДНА строка, а не три
 *
 * Наименование, ИНН и ОГРН извлекаются одной ступенью и по одной шапке: если
 * она не отработала, не будет ни одного из трёх. Три строки «не проверено» на
 * один и тот же факт — это утроение шума, а не утроение сведений, и на корпусе
 * из семи пакетов оно давало восемнадцать строк вместо шести.
 *
 * Строка при этом остаётся: в отличие от нарезки страниц, реквизит шапки
 * инженер может проверить глазами, открыв лист. Именно поэтому здесь
 * `undetermined`, а не молчание, — но ровно одно на акт.
 *
 * Незаполненные графы, наоборот, перечисляются по одной: каждая — свой дефект
 * бумаги со своей цитатой, и подрядчику надо знать, какую именно дозаполнить.
 */
function evaluateHeaderParties(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const required: readonly (readonly [string, string])[] = [
    [AOSR_FIELDS.contractorName, 'наименование'],
    [AOSR_FIELDS.contractorInn, 'ИНН'],
    [AOSR_FIELDS.contractorOgrn, 'ОГРН'],
  ];

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const missing: string[] = [];

    for (const [code, label] of required) {
      const value = actField(act, code);

      if (value === null) {
        missing.push(label);
        continue;
      }

      checked += 1;
      if (trimmedText(value) !== null) continue;

      findings.push(
        defect({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `В шапке акта ${actLabel(act)} не заполнен реквизит лица, выполнившего работы: ${label}.`,
          hint: 'Дозаполните реквизиты сторон в шапке акта: наименование, ИНН и ОГРН лица, выполнившего работы.',
        }),
      );
    }

    if (missing.length > 0) {
      findings.push(
        unknown({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `В шапке акта ${actLabel(act)} не извлечены реквизиты лица, выполнившего работы: ${missing.join(', ')} — проверить их заполнение нечем.`,
          hint: 'Откройте шапку акта и сверьте реквизиты лица, выполнившего работы, глазами.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не извлечены реквизиты стороны');
}

/**
 * Контрольная сумма реквизита в шапке акта.
 *
 * Правило доводит дело ровно до факта «сумма не сошлась» и прикладывает
 * уверенность источника. Понижение до `undetermined` — задача движка: ОГРН из
 * 12 цифр и ОГРН с битой контрольной суммой отличаются НЕ значением (потеря
 * цифры при OCR объясняет оба), а тем, откуда значение вычитано.
 */
function evaluateIdentifier(
  graph: CheckGraph,
  fieldCode: string,
  label: string,
  lengths: string,
  check: (value: string) => IdentifierCheck,
): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const value = field(act, fieldCode);
    const text = trimmedText(value);
    if (text === null) continue;

    const anchor = anchorOfField(act, value);
    const digits = digitsOf(text);
    if (digits === '') {
      findings.push(
        unknown({
          ...anchor,
          origin: 'deterministic',
          message: `${label} «${text}» в шапке акта ${actLabel(act)} не содержит цифр — проверить контрольную сумму нечем.`,
          hint: `Сверьте ${label} с оригиналом акта и введите значение вручную.`,
        }),
      );
      continue;
    }

    checked += 1;
    const result = check(digits);
    if (result.ok) continue;

    const detail =
      result.defect === 'length'
        ? `указано ${String(digits.length)} цифр вместо ${lengths}`
        : result.checksum !== null
          ? `контрольная сумма не сходится: ожидалась ${result.checksum.expected}, указана ${result.checksum.actual}`
          : 'значение непригодно для проверки';

    findings.push(
      defect({
        ...anchor,
        origin: 'deterministic',
        message: `${label} «${text}» в шапке акта ${actLabel(act)} не проходит проверку: ${detail}.`,
        hint: `Сверьте ${label} с оригиналом акта и выпиской из ЕГРЮЛ; при расхождении исправьте реквизит в шапке акта.`,
      }),
    );
  }

  return summarize(findings, checked, `ни в одном акте не распознан ${label}`);
}

function evaluateCounterpartyTriple(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);
  if (graph.counterparties.length === 0) {
    return notApplicable('справочник контрагентов пуст — сверять тройку не с чем');
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const nameValue = actField(act, AOSR_FIELDS.contractorName);
    const innValue = actField(act, AOSR_FIELDS.contractorInn);
    const ogrnValue = actField(act, AOSR_FIELDS.contractorOgrn);
    const name = trimmedText(nameValue);
    const inn = trimmedText(innValue);
    const ogrn = trimmedText(ogrnValue);
    if (name === null && inn === null && ogrn === null) continue;

    // Сопоставление — общее с конвейером, который заполняет исполнителя
    // комплекта той же тройкой (S37): два экземпляра разошлись бы молча.
    const party = matchCounterparty(graph.counterparties, { name, inn, ogrn }) ?? undefined;
    if (party === undefined) {
      findings.push(
        unknown({
          ...anchorOfField(act, innValue ?? ogrnValue ?? nameValue),
          origin: 'deterministic',
          message: `Контрагент из шапки акта ${actLabel(act)} (${[name, inn, ogrn].filter((part) => part !== null).join(', ')}) не найден в справочнике — сверить тройку ОГРН↔ИНН↔наименование не с чем.`,
          hint: 'Заведите контрагента в справочнике либо исправьте реквизиты в шапке акта.',
        }),
      );
      continue;
    }

    checked += 1;

    if (inn !== null && party.inn !== null && digitsOf(party.inn) !== digitsOf(inn)) {
      findings.push(
        defect({
          ...anchorOfField(act, innValue),
          origin: 'deterministic',
          message: `ИНН в шапке акта ${actLabel(act)} — «${inn}» — расходится со справочником: у контрагента «${party.name}» указан ИНН ${party.inn}.`,
          hint: 'Сверьте ИНН с выпиской из ЕГРЮЛ и исправьте расходящуюся сторону — акт или карточку контрагента.',
        }),
      );
    }

    if (ogrn !== null && party.ogrn !== null && digitsOf(party.ogrn) !== digitsOf(ogrn)) {
      findings.push(
        defect({
          ...anchorOfField(act, ogrnValue),
          origin: 'deterministic',
          message: `ОГРН в шапке акта ${actLabel(act)} — «${ogrn}» — расходится со справочником: у контрагента «${party.name}» указан ОГРН ${party.ogrn}.`,
          hint: 'Сверьте ОГРН с выпиской из ЕГРЮЛ и исправьте расходящуюся сторону — акт или карточку контрагента.',
        }),
      );
    }

    if (name !== null && normalizeOrgName(party.name) !== normalizeOrgName(name)) {
      findings.push(
        defect({
          ...anchorOfField(act, nameValue),
          origin: 'deterministic',
          message: `Наименование в шапке акта ${actLabel(act)} — «${name}» — расходится со справочником: контрагент с этими реквизитами назван «${party.name}».`,
          hint: 'Приведите наименование организации в шапке акта к записи справочника контрагентов.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознаны реквизиты стороны');
}

// ---------------------------------------------------------------------------
// AOSR.ACT — номер и даты акта
// ---------------------------------------------------------------------------

function evaluateActNumberPattern(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const pattern = graph.object.actNumberPattern;
  if (pattern === null || pattern.trim() === '') {
    return notApplicable('для объекта не задан шаблон номера акта');
  }

  let expected: RegExp;
  try {
    expected = new RegExp(pattern);
  } catch {
    return notApplicable(
      `шаблон номера акта «${pattern}» не является корректным регулярным выражением`,
    );
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const value = actField(act, AOSR_FIELDS.actNumber) ?? field(act, AOSR_FIELDS.number);
    const number = trimmedText(value);
    if (number === null) {
      findings.push(
        unknown({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `Номер акта (документ ${String(act.ordinal)}) не распознан — сверить с шаблоном объекта «${pattern}» нечем.`,
          hint: 'Введите номер акта вручную и подтвердите реквизит.',
        }),
      );
      continue;
    }

    checked += 1;
    if (expected.test(number)) continue;

    findings.push(
      defect({
        ...anchorOfField(act, value),
        origin: 'deterministic',
        message: `Номер акта «${number}» не соответствует шаблону номера, заданному для объекта: «${pattern}».`,
        hint: `Приведите номер акта к принятой на объекте форме либо уточните шаблон в карточке объекта.`,
      }),
    );
  }

  return summarize(findings, checked, 'ни в одном акте не распознан номер');
}

function evaluateActDates(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const actDateValue = actField(act, AOSR_FIELDS.actDate);
    const startValue = actField(act, AOSR_FIELDS.dateStart);
    const endValue = actField(act, AOSR_FIELDS.dateEnd);

    const actDate = actDateValue?.valueDate ?? null;
    const start = startValue?.valueDate ?? null;
    const end = endValue?.valueDate ?? null;

    const missing: string[] = [];
    if (!isIsoDate(actDate)) missing.push('дата акта');
    if (!isIsoDate(start)) missing.push('дата начала работ');
    if (!isIsoDate(end)) missing.push('дата окончания работ');

    if (missing.length > 0) {
      findings.push(
        unknown({
          ...anchorOfField(act, actDateValue ?? endValue ?? startValue),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознаны даты: ${missing.join(', ')} — порядок дат проверить нечем.`,
          hint: 'Введите даты начала и окончания работ и дату составления акта вручную.',
        }),
      );
    }

    if (isIsoDate(start) && isIsoDate(end)) {
      checked += 1;
      if (end < start) {
        findings.push(
          defect({
            ...anchorOfField(act, endValue),
            origin: 'deterministic',
            message: `В акте ${actLabel(act)} дата окончания работ ${formatDate(end)} раньше даты начала ${formatDate(start)}.`,
            hint: 'Сверьте период выполнения работ с общим журналом работ и исправьте даты в п. 5 акта.',
          }),
        );
      }
    }

    if (isIsoDate(actDate) && isIsoDate(end)) {
      checked += 1;
      if (actDate < end) {
        findings.push(
          defect({
            ...anchorOfField(act, actDateValue),
            origin: 'deterministic',
            message: `В акте ${actLabel(act)} дата составления ${formatDate(actDate)} раньше даты окончания работ ${formatDate(end)}.`,
            hint: 'Акт составляется не ранее окончания освидетельствуемых работ — сверьте обе даты с оригиналом.',
          }),
        );
      }
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознаны даты работ');
}

// ---------------------------------------------------------------------------
// AOSR.SGN — подписанты
// ---------------------------------------------------------------------------

function evaluateSignerSet(graph: CheckGraph, params: RuleParams): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const roles = signerRolesFrom(params);
  if (roles.length === 0) {
    return notApplicable('снимок правил не задаёт ни одной обязательной роли подписанта');
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const present = roles.filter((role) => trimmedText(field(act, role.field)) !== null);
    if (present.length === 0) {
      findings.push(
        unknown({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `Подписанты акта ${actLabel(act)} не распознаны по ролям — состав проверить нечем.`,
          hint: 'Заполните представителей сторон в блоке подписей акта и подтвердите реквизиты.',
        }),
      );
      continue;
    }

    checked += 1;
    for (const role of roles) {
      if (trimmedText(field(act, role.field)) !== null) continue;
      findings.push(
        defect({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не указан подписант: ${role.label}.`,
          hint: 'Дозаполните состав подписантов акта: в бланке освидетельствования эта роль обязательна.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознан состав подписантов');
}

function evaluateSignerOrders(graph: CheckGraph, params: RuleParams): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const roles = signerRolesFrom(params);
  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    for (const role of roles) {
      const signerValue = field(act, role.field);
      const signer = trimmedText(signerValue);
      if (signer === null) continue;

      checked += 1;
      const orderValue = field(act, role.order);
      if (trimmedText(orderValue) !== null) continue;

      findings.push(
        defect({
          ...anchorOfField(act, signerValue),
          origin: 'deterministic',
          message: `У подписанта «${signer}» (${role.label}) в акте ${actLabel(act)} не указаны реквизиты приказа о назначении.`,
          hint: 'Укажите номер и дату приказа (распорядительного документа) о назначении представителя в строке подписанта.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознан ни один подписант');
}

function evaluateInspectionOrg(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const inspectionValue = actField(act, AOSR_FIELDS.worksPerformedBy);
    const contractorValue = actField(act, AOSR_FIELDS.contractorName);
    const inspection = trimmedText(inspectionValue);
    const contractor = trimmedText(contractorValue);

    if (inspection === null || contractor === null) {
      findings.push(
        unknown({
          ...anchorOfField(act, inspectionValue ?? contractorValue),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознана организация ${inspection === null ? 'в строке «произвели осмотр работ, выполненных»' : 'в реквизитах лица, выполнившего работы'} — сверить строку осмотра не с чем.`,
          hint: 'Введите наименование организации, выполнившей работы, в шапке акта и в строке осмотра.',
        }),
      );
      continue;
    }

    checked += 1;
    if (normalizeOrgName(inspection) === normalizeOrgName(contractor)) continue;

    findings.push(
      defect({
        ...anchorOfField(act, inspectionValue),
        origin: 'deterministic',
        message: `В акте ${actLabel(act)} организация в строке «произвели осмотр работ, выполненных» — «${inspection}» — не совпадает с лицом, выполнившим работы, — «${contractor}».`,
        hint: 'Приведите обе строки к одному наименованию организации, фактически выполнившей освидетельствуемые работы.',
      }),
    );
  }

  return summarize(findings, checked, 'ни в одном акте не распознана строка осмотра работ');
}

// ---------------------------------------------------------------------------
// AOSR.P1–P7 — пункты акта
// ---------------------------------------------------------------------------

function evaluateItem1(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const nameValue = workNameField(act);
    const locationValue = actField(act, AOSR_FIELDS.workLocation);

    // Отсутствие поля и ПУСТОЕ поле — разные вещи: первое означает, что
    // извлечение не дошло до пункта, второе — что в бланке пусто.
    if (nameValue === null) {
      findings.push(
        unknown({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не извлечён п. 1 — наименование предъявленных к освидетельствованию работ проверить нечем.`,
          hint: 'Откройте п. 1 акта и введите наименование работ вручную.',
        }),
      );
      continue;
    }

    checked += 1;
    if (trimmedText(nameValue) === null) {
      findings.push(
        defect({
          ...anchorOfField(act, nameValue),
          origin: 'deterministic',
          message: `В п. 1 акта ${actLabel(act)} не заполнено наименование предъявленных к освидетельствованию работ.`,
          hint: 'Заполните п. 1 акта: наименование работ должно повторять формулировку рабочей документации.',
        }),
      );
    }

    if (locationValue !== null && trimmedText(locationValue) === null) {
      findings.push(
        defect({
          ...anchorOfField(act, locationValue),
          origin: 'deterministic',
          message: `В п. 1 акта ${actLabel(act)} не заполнена привязка работ (оси, отметки, захватки).`,
          hint: 'Укажите привязку работ в п. 1: без осей и отметок акт не адресуется к конструкции.',
        }),
      );
    } else if (locationValue === null) {
      findings.push(
        unknown({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не извлечена привязка работ п. 1 — проверить её заполнение нечем.`,
          hint: 'Проверьте п. 1 акта: привязка работ (оси, отметки, захватки) должна быть указана.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не извлечён п. 1');
}

function evaluateRdFolder(graph: CheckGraph, params: RuleParams): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const raw = params['revisionPattern'];
  const source = typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_REVISION_PATTERN;
  let folder: RegExp;
  try {
    folder = new RegExp(source, 'iu');
  } catch {
    return notApplicable(`параметр revisionPattern «${source}» не является регулярным выражением`);
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const value = actField(act, AOSR_FIELDS.rdCipher);
    // П. 2 — СПИСОК: бланк допускает несколько шифров, и номер изменения
    // обязан стоять у каждого. Чтение одним текстом брало у списка либо
    // склейку через «; » (детерминированный экстрактор), либо `null` (модель
    // кладёт элементы только в `value_json`), — во втором случае правило
    // объявляло реквизит нераспознанным на каждом акте.
    const ciphers = actListOf(act, AOSR_FIELDS.rdCipher);
    if (ciphers.length === 0) {
      findings.push(
        unknown({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознан шифр рабочей документации п. 2 — наличие номера изменения проверить нечем.`,
          hint: 'Введите шифр рабочей документации из п. 2 акта вместе с номером изменения.',
        }),
      );
      continue;
    }

    checked += 1;
    for (const cipher of ciphers) {
      if (folder.test(cipher)) continue;

      findings.push(
        defect({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `Шифр рабочей документации «${cipher}» в п. 2 акта ${actLabel(act)} указан без номера изменения.`,
          hint: 'Допишите к шифру номер изменения (например, «изм. 2») — без него нельзя установить, по какой редакции выполнены работы.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознан шифр рабочей документации');
}

const DEFAULT_REVISION_PATTERN = 'изм(?:енени[ея])?\\.?\\s*№?\\s*\\d+';

/** Шифр без хвоста с номером изменения: справочник хранит их отдельно. */
function cipherWithoutRevision(cipher: string): string {
  return cipher.replace(/[,;]?\s*изм(?:енени[ея])?\.?\s*№?\s*\d+\s*$/iu, '').trim();
}

function evaluateRdInCatalog(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);
  if (graph.rdDocuments.length === 0) {
    return notApplicable('справочник рабочей документации пуст — сверять шифр не с чем');
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const value = actField(act, AOSR_FIELDS.rdCipher);
    const ciphers = actListOf(act, AOSR_FIELDS.rdCipher);
    if (ciphers.length === 0) {
      findings.push(
        unknown({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознан шифр рабочей документации п. 2 — сверить со справочником нечем.`,
          hint: 'Введите шифр рабочей документации из п. 2 акта вручную.',
        }),
      );
      continue;
    }

    checked += 1;
    for (const cipher of ciphers) {
      const wanted = normalizeDocNo(cipherWithoutRevision(cipher));
      const found = graph.rdDocuments.some((rd) => {
        const actual = normalizeDocNo(rd.cipher);
        return actual.normalized === wanted.normalized || actual.folded === wanted.folded;
      });
      if (found) continue;

      findings.push(
        defect({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `Шифр рабочей документации «${cipher}» из п. 2 акта ${actLabel(act)} отсутствует в справочнике рабочей документации объекта.`,
          hint: 'Заведите шифр в справочнике рабочей документации либо исправьте его в п. 2 акта.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознан шифр рабочей документации');
}

/**
 * П. 3: материалы подтверждены документами.
 *
 * Материал вне перечня категорий профиля пропускается с названной причиной, а
 * не объявляется неподтверждённым (§9.1, строка 3): одна ложная ошибка на новом
 * разделе разрушает доверие быстрее пропуска.
 */
function evaluateMaterialsBacked(graph: CheckGraph): RuleResult {
  if (graph.materials.length === 0) {
    return notApplicable('в комплекте не выделено ни одного материала');
  }

  const findings: RuleFinding[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const material of graph.materials) {
    if (!categoryInProfile(graph.profile, material)) {
      skipped.push(`${material.nameRaw} (${material.categoryCode ?? 'категория не определена'})`);
      continue;
    }

    checked += 1;
    const documents = documentsOf(graph, material.documentIds);
    if (documents.length > 0) continue;

    findings.push(
      defect({
        ...anchorOf('material', material.id),
        origin: 'deterministic',
        message: `Материал «${material.nameRaw}» из п. 3 акта не подтверждён ни одним документом о качестве.`,
        hint: 'Приложите документ о качестве на материал и укажите его в реестре приложений.',
      }),
    );
  }

  if (checked === 0) {
    return notApplicable(
      `все материалы комплекта вне перечня категорий профиля раздела: ${skipped.join('; ')}`,
    );
  }
  return fromFindings(findings);
}

function evaluateRegistryReference(graph: CheckGraph, params: RuleParams): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const limit = threshold(graph.profile, params, 'maxDocumentsWithoutRegistry', 5);
  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const listed = actListOf(act, AOSR_FIELDS.materials);
    if (listed.length === 0) continue;

    checked += 1;
    if (listed.length <= limit) continue;
    if (actTextOf(act, AOSR_FIELDS.registryRef) !== null) continue;

    findings.push(
      defect({
        ...anchorOfField(act, actField(act, AOSR_FIELDS.materials)),
        origin: 'deterministic',
        message: `В п. 3 акта ${actLabel(act)} перечислено ${String(listed.length)} документов (больше ${String(limit)}), но ссылки на реестр приложений нет.`,
        hint: 'Замените перечисление в п. 3 ссылкой на реестр приложений либо добавьте её к перечню.',
      }),
    );
  }

  return summarize(findings, checked, 'ни в одном акте не распознан перечень документов п. 3');
}

function evaluateAnnexesPresent(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    // Правило про ПУНКТ 4 — «предъявлены документы, подтверждающие
    // соответствие работ». Блок «Приложения» в подвале бланка перечисляет
    // другое (исполнительные схемы, протоколы) и живёт под своим кодом
    // `annexes`; смешивать их значило бы требовать наличия схемы по номеру,
    // которого у схемы не бывает.
    const documents = actListOf(act, AOSR_FIELDS.documents);
    if (documents.length === 0) continue;

    const anchor = anchorOfField(act, actField(act, AOSR_FIELDS.documents));
    for (const entry of documents) {
      const docNo = docNoOf(entry);
      if (docNo === null) {
        findings.push(
          unknown({
            ...anchor,
            origin: 'deterministic',
            message: `Приложение «${entry}» из п. 4 акта ${actLabel(act)} названо без номера — сопоставить его с документом комплекта нечем.`,
            hint: 'Укажите номер документа в перечне приложений либо сопоставьте строку с документом вручную.',
          }),
        );
        continue;
      }

      checked += 1;
      const lookup = hasDocumentNumbered(graph, docNo, entry);
      if (lookup === 'found') continue;

      if (lookup === 'undetermined') {
        findings.push(
          unknown({
            ...anchor,
            origin: 'deterministic',
            message: `Приложение «${entry}» из п. 4 акта ${actLabel(act)}: в комплекте есть исполнительная схема, но её номер распознан иначе, чем ${docNo}.`,
            hint: 'Сверьте номер схемы с перечнем приложений акта вручную либо исправьте распознанный номер схемы.',
          }),
        );
        continue;
      }

      findings.push(
        defect({
          ...anchor,
          origin: 'deterministic',
          message: `Приложение «${entry}» из п. 4 акта ${actLabel(act)} в комплекте не найдено: документа с номером ${docNo} нет.`,
          hint: 'Приложите недостающий документ к комплекту либо исправьте перечень приложений в п. 4 акта.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознан перечень приложений п. 4');
}

/**
 * П. 4: наименование схемы согласовано с п. 1 (дефект №6 корпуса).
 *
 * В АОСР №10 п. 1 говорит «Устройство 2 слоя гидроизоляции», а п. 4 и перечень
 * приложений ссылаются на схему «1 слой». Сравниваются числовые
 * количественные признаки при ОДНОЙ основе слова: расхождение чисел означает,
 * что акт и схема описывают разный объём работ. Если количественного признака
 * нет ни в п. 1, ни в наименовании схемы, вердикт — `undetermined`, а не
 * `pass`: сверять было нечего, и «проверено» тут было бы ложью.
 */
function evaluateSchemeConsistency(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  const schemeTitles = graph.documents
    .filter(
      (document) =>
        document.isKnownType &&
        !document.isFallbackType &&
        document.docTypeCode !== null &&
        SCHEME_TYPE.test(document.docTypeCode) &&
        document.title !== null,
    )
    .map((document) => document.title as string);

  for (const act of actList) {
    const workValue = workNameField(act);
    const workText = trimmedText(workValue);
    // Схема называется и в п. 4, и в блоке «Приложения» — объединение, а не
    // выбор: бланки заполняют по-разному, и количественный признак может
    // оказаться в любом из двух.
    const schemeTexts = [
      ...actListOf(act, AOSR_FIELDS.documents),
      ...actListOf(act, AOSR_FIELDS.attachments),
      ...schemeTitles,
    ];

    const inWork = quantitiesOf(workText === null ? [] : [workText]);
    const inScheme = quantitiesOf(schemeTexts);

    const common = [...inWork.keys()].filter((stem) => inScheme.has(stem));
    if (common.length === 0) {
      findings.push(
        unknown({
          ...anchorOfField(act, workValue),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} количественный признак (число слоёв, рядов) не распознан ${inWork.size === 0 && inScheme.size === 0 ? 'ни в п. 1, ни в наименовании схемы' : inWork.size === 0 ? 'в п. 1' : 'в наименовании схемы'} — согласованность п. 1 и схемы проверить нечем.`,
          hint: 'Сверьте наименование исполнительной схемы с п. 1 акта вручную: число слоёв (рядов) должно совпадать.',
        }),
      );
      continue;
    }

    checked += 1;
    for (const stem of common) {
      const workNumbers = inWork.get(stem) as Set<number>;
      const schemeNumbers = inScheme.get(stem) as Set<number>;
      const agreed = [...workNumbers].some((value) => schemeNumbers.has(value));
      if (agreed) continue;

      findings.push(
        defect({
          ...anchorOfField(act, workValue),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} количественный признак «${stem}» расходится: в п. 1 указано ${formatNumbers(workNumbers)}, а в наименовании схемы — ${formatNumbers(schemeNumbers)}.`,
          hint: 'Приведите наименование исполнительной схемы и п. 1 акта к одному объёму работ либо приложите схему на фактически выполненный объём.',
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознан п. 1');
}

function evaluateNextWorks(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const workValue = workNameField(act);
    const nextValue = actField(act, AOSR_FIELDS.nextWorks);
    const work = trimmedText(workValue);
    const next = trimmedText(nextValue);

    if (work === null || next === null) {
      findings.push(
        unknown({
          ...anchorOfField(act, nextValue ?? workValue),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознан ${work === null ? 'п. 1' : 'п. 7'} — сверить последующие работы с освидетельствованными нечем.`,
          hint: 'Введите наименование работ п. 1 и перечень последующих работ п. 7 вручную.',
        }),
      );
      continue;
    }

    checked += 1;
    if (normalizePhrase(work) !== normalizePhrase(next)) continue;

    findings.push(
      defect({
        ...anchorOfField(act, nextValue),
        origin: 'deterministic',
        message: `В акте ${actLabel(act)} последующие работы п. 7 дословно повторяют освидетельствованные работы п. 1: «${next}».`,
        hint: 'Укажите в п. 7 работы, производство которых разрешается после освидетельствования, а не сами освидетельствованные работы.',
      }),
    );
  }

  return summarize(findings, checked, 'ни в одном акте не распознаны пп. 1 и 7');
}

// ---------------------------------------------------------------------------
// REG — сверка с реестром приложений
// ---------------------------------------------------------------------------

const NO_REGISTRY = 'в комплекте нет реестра приложений — сверять нечего';

function rowTail(docNoRaw: string | null, docNameRaw: string): string {
  return `реестра («${docNameRaw}»${docNoRaw === null ? '' : `, № ${docNoRaw}`})`;
}

/** Именительный: «строка 3 реестра (…) сопоставлена неоднозначно». */
function rowLabel(rowNo: number, docNoRaw: string | null, docNameRaw: string): string {
  return `строка ${String(rowNo)} ${rowTail(docNoRaw, docNameRaw)}`;
}

/**
 * Предложный: «названный в строкЕ 3 реестра (…)».
 *
 * Отдельная форма, а не склейка на месте: подстановка именительного падежа в
 * предлог давала «названный в строка 3 реестра» — фразу, которую подрядчик
 * читает в отчёте как признак того, что текст собран машиной и доверять ему
 * не обязательно. Замечание об отсутствующем документе — самое тяжёлое из
 * того, что портал говорит, и оно обязано быть написано по-русски.
 */
function rowLabelIn(rowNo: number, docNoRaw: string | null, docNameRaw: string): string {
  return `строке ${String(rowNo)} ${rowTail(docNoRaw, docNameRaw)}`;
}

/**
 * Вывод «документа нет в комплекте» опирается на то, что комплект разобран весь.
 *
 * Если часть листов портал не разобрал — с них ничего не прочитано либо
 * прочитанное не отнесено ни к одному документу, — то отсутствие документа не
 * установлено: он может лежать ровно на таком листе. Это `undetermined`, а не
 * дефект помягче: `fromFindings` выводит вердикт из СОСТОЯНИЯ замечания, а не
 * из его тяжести, и понижение одной severity оставило бы прогон в `fail`.
 *
 * Тяжесть при этом тоже понижается — замечание остаётся видимым, но перестаёт
 * блокировать: `severityOverride` объявлен как понижение и повышать правило не
 * вправе.
 */
function coverageNote(gaps: number): string {
  return (
    ` Часть комплекта портал не разобрал: ${String(gaps)} ` +
    `${gaps === 1 ? 'лист' : 'листов'} без распознанного текста либо не отнесены ни к одному ` +
    'документу, поэтому вывод об отсутствии документа не сделан.'
  );
}

function evaluateRegistryMissing(graph: CheckGraph): RuleResult {
  if (graph.registryRows.length === 0) return notApplicable(NO_REGISTRY);

  const gaps = graph.coverageGaps;
  const findings = graph.registryRows
    .filter((row) => row.matchState === 'missing')
    .map((row) => {
      const label = rowLabelIn(row.rowNo, row.docNoRaw, row.docNameRaw);

      /**
       * Строка без сравнимого номера («б/н») отсутствия документа не доказывает.
       *
       * Сверка идёт по номеру, и у такой строки его нет: разбор реестра
       * намеренно оставляет `doc_no_norm` пустым, чтобы два разных документа
       * «без номера» не совпали друг с другом. Дальше сверка честно отвечает
       * «не нашла», а правило превращало это в утверждение «документа нет».
       * На боевой папке так возникало по три-четыре ложных «нет в комплекте»
       * на каждый из двенадцати комплектов — все на приложениях, которые в
       * комплекте лежат.
       */
      if (row.docNoNorm === null) {
        return unknown({
          ...anchorOf('registry_row', row.id),
          origin: 'deterministic',
          message: `Документ, названный в ${label}, сверить не с чем: в реестре он указан без номера.`,
          hint: 'Сверьте строку с документом комплекта вручную либо укажите номер документа в реестре.',
        });
      }

      if (gaps > 0) {
        return unknown({
          ...anchorOf('registry_row', row.id),
          origin: 'deterministic',
          severityOverride: 'warning',
          message: `Документ, названный в ${label}, в разобранной части комплекта не найден.${coverageNote(gaps)}`,
          hint: 'Разберите непривязанные листы комплекта либо приложите недостающий документ.',
        });
      }
      return defect({
        ...anchorOf('registry_row', row.id),
        origin: 'deterministic',
        message: `В комплекте не найден документ, названный в ${label}.`,
        hint: 'Приложите недостающий документ к комплекту либо исключите строку из реестра приложений.',
      });
    });

  return fromFindings(findings);
}

function evaluateRegistryExtra(graph: CheckGraph): RuleResult {
  if (graph.registryRows.length === 0) return notApplicable(NO_REGISTRY);

  // «Названным» считается и документ, попавший в КАНДИДАТЫ строки: реестром он
  // упомянут, и объявить его лишним значило бы обвинить комплект дважды за
  // одно. Определение то же, что у сверки (`match.ts`, `named`), и берётся оно
  // готовым: вторая реализация лестницы разошлась бы с первой молча.
  const named = new Set<string>();
  for (const row of graph.registryRows) {
    if (row.matchedDocumentId !== null) named.add(row.matchedDocumentId);
    for (const id of row.candidateDocumentIds) named.add(id);
  }
  const registryDocuments = new Set(graph.registryRows.map((row) => row.registryDocumentId));

  const findings: RuleFinding[] = [];
  for (const document of graph.documents) {
    if (named.has(document.id) || registryDocuments.has(document.id)) continue;
    // Реестр приложений — не единственный законный способ назвать приложение.
    // Бланк РД-11-02 пишет «Приложения: в соответствии с п. 3, 4»: приложениями
    // объявлены И перечень документов о качестве из п. 3, И реестр из п. 4.
    // Документ, связанный с актом ребром графа, реестром может быть и не
    // назван — граф строит такое ребро только по номеру, прочитанному в самом
    // акте (`graph.build`), то есть по свидетельству того же уровня, что и
    // строка реестра. На комплекте `№01_Бл_П` без этой ветки правило обвиняло
    // комплект четырежды: сертификат № 275, паспорт качества и два сертификата
    // соответствия перечислены в п. 3 акта и не продублированы в реестре.
    if (
      parentsOf(graph, document.id).some(
        (parent) => parent.docTypeCode !== null && ACT_TYPES.test(parent.docTypeCode),
      )
    ) {
      continue;
    }
    const code = document.docTypeCode;
    // Сам акт и реестр в реестре не перечисляются.
    if (code !== null && (ACT_TYPES.test(code) || code === REGISTRY_TYPE)) continue;
    /**
     * Реестр приложений — перечень МАТЕРИАЛЬНЫЙ, и вид документа решает, вправе
     * ли правило требовать там строку.
     *
     * Его графы — «наименование материала», «организация (производитель)»,
     * «наименование документа», «номер», «дата»: строка заводится на документ
     * о качестве, подтверждающий материал. У исполнительной схемы и журнала
     * авторского надзора материала нет, и в реестре приложений их не бывает —
     * они названы п. 4 акта и описью передачи. Требовать от них строки значит
     * требовать заполнить графу «наименование материала» у чертежа.
     *
     * На боевой папке «ИД Мастер апрель 2026» это давало пятнадцать
     * предупреждений из пятнадцати: одиннадцать схем и четыре учётных листа во
     * всех двенадцати комплектах, где реестры приложений заполнены правильно.
     */
    if (code !== null && (SCHEME_TYPE.test(code) || code === SUPERVISION_LOG_TYPE)) continue;

    findings.push(
      defect({
        ...anchorOfDocument(document),
        origin: 'deterministic',
        message: `Документ комплекта «${document.title ?? `документ ${String(document.ordinal)}`}» не назван ни одной строкой реестра приложений.`,
        hint: 'Добавьте документ в реестр приложений либо исключите его из комплекта.',
      }),
    );
  }

  return fromFindings(findings);
}

function evaluateRegistryAmbiguous(graph: CheckGraph): RuleResult {
  if (graph.registryRows.length === 0) return notApplicable(NO_REGISTRY);

  const findings = graph.registryRows
    .filter((row) => row.matchState === 'ambiguous')
    .map((row) =>
      defect({
        ...anchorOf('registry_row', row.id),
        origin: 'deterministic',
        message: `${rowLabel(row.rowNo, row.docNoRaw, row.docNameRaw)} сопоставлена с комплектом неоднозначно: номеру соответствует больше одного документа.`,
        hint: 'Выберите документ для строки реестра вручную либо уточните номер документа в реестре.',
      }),
    );

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// MAT — материалы
// ---------------------------------------------------------------------------

const NO_MATERIALS = 'в комплекте не выделено ни одного материала';

function evaluateMaterialMatrix(graph: CheckGraph): RuleResult {
  if (graph.materials.length === 0) return notApplicable(NO_MATERIALS);

  const findings: RuleFinding[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const material of graph.materials) {
    if (!categoryInProfile(graph.profile, material)) {
      skipped.push(`${material.nameRaw} (${material.categoryCode ?? 'категория не определена'})`);
      continue;
    }
    const category = material.categoryCode as string;
    const entry = matrixFor(graph.profile, category);
    if (entry === null) {
      skipped.push(`${material.nameRaw}: категория «${category}» не описана в матрице раздела`);
      continue;
    }

    const required = stringList(entry['required']);
    const anyOf = stringMatrix(entry['anyOf']);
    if (required.length === 0 && anyOf.length === 0) {
      skipped.push(`${material.nameRaw}: матрица не требует ни одного документа для «${category}»`);
      continue;
    }

    checked += 1;
    const documents = documentsOf(graph, material.documentIds);
    const known = new Set(
      documents
        .filter((document) => document.isKnownType && !document.isFallbackType)
        .map((document) => document.docTypeCode),
    );
    // Незнакомый документ в пакете означает «не знаем», а не «нет»: §9.1 запрещает
    // делать вывод об ошибке по документу, вид которого не определён.
    const hasUnclassified = documents.some(
      (document) => !document.isKnownType || document.isFallbackType,
    );

    const missing = required.filter((code) => !known.has(code));
    const missingGroups = anyOf.filter((group) => !group.some((code) => known.has(code)));
    if (missing.length === 0 && missingGroups.length === 0) continue;

    const parts = [...missing, ...missingGroups.map((group) => `один из: ${group.join(' | ')}`)];
    const message = `Пакет подтверждения материала «${material.nameRaw}» (категория «${category}») не соответствует матрице раздела: не хватает документов — ${parts.join(', ')}.`;
    const anchor = anchorOf('material', material.id);

    findings.push(
      hasUnclassified
        ? unknown({
            ...anchor,
            origin: 'deterministic',
            message: `${message} В пакете есть документы с неопределённым видом — вывод о полноте сделать нельзя.`,
            hint: 'Уточните вид неопознанных документов материала, после чего повторите проверку полноты пакета.',
          })
        : defect({
            ...anchor,
            origin: 'deterministic',
            message,
            hint: 'Приложите недостающие документы о качестве материала согласно матрице раздела.',
          }),
    );
  }

  if (checked === 0) {
    return notApplicable(
      `матрица раздела не применима ни к одному материалу комплекта: ${skipped.join('; ')}`,
    );
  }
  return fromFindings(findings);
}

/**
 * Изготовитель партии покрыт приложенным сертификатом (дефект №2 корпуса).
 *
 * Здесь проверяется ТОЛЬКО покрытие изготовителя. Полнота пакета — предмет
 * `MAT.110`, и отсутствие сертификатов вовсе даёт `undetermined` с пояснением,
 * а не второе замечание о неполноте: два правила, сообщающие об одном факте,
 * удваивают список замечаний и обесценивают оба.
 */
function evaluateManufacturerCoverage(graph: CheckGraph): RuleResult {
  if (graph.materials.length === 0) return notApplicable(NO_MATERIALS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const material of graph.materials) {
    if (material.batches.length === 0) continue;

    const certificates = documentsOf(graph, material.documentIds).filter((document) =>
      isTypeOf(document, CERTIFICATE_TYPES),
    );
    const covered = certificates
      .map((document) => trimmedText(field(document, AOSR_FIELDS.manufacturer)))
      .filter((name): name is string => name !== null);

    for (const batch of material.batches) {
      const batchDocuments = documentsOf(graph, batch.documentIds);
      const manufacturerField = batchDocuments
        .map((document) => field(document, AOSR_FIELDS.manufacturer))
        .find((value) => trimmedText(value) !== null);
      const manufacturerDocument = batchDocuments.find(
        (document) => trimmedText(field(document, AOSR_FIELDS.manufacturer)) !== null,
      );
      const manufacturer = trimmedText(manufacturerField ?? null);

      if (manufacturer === null) {
        findings.push(
          unknown({
            ...anchorOf('batch', batch.id),
            origin: 'deterministic',
            message: `Изготовитель партии ${batch.batchNo ?? batch.heatNo ?? batch.id} материала «${material.nameRaw}» не распознан — покрытие сертификатом проверить нечем.`,
            hint: 'Введите изготовителя партии из документа о качестве вручную.',
          }),
        );
        continue;
      }

      const anchor =
        manufacturerDocument === undefined
          ? anchorOf('batch', batch.id)
          : {
              ...anchorOfField(manufacturerDocument, manufacturerField ?? null),
              targetType: 'batch' as const,
              targetId: batch.id,
            };

      if (covered.length === 0) {
        findings.push(
          unknown({
            ...anchor,
            origin: 'deterministic',
            message: `У материала «${material.nameRaw}» нет ни одного сертификата соответствия или декларации с указанным изготовителем — покрытие изготовителя «${manufacturer}» проверить нечем.`,
            hint: 'Приложите сертификат соответствия (декларацию) на материал с указанием изготовителя.',
          }),
        );
        continue;
      }

      checked += 1;
      const wanted = normalizeOrgName(manufacturer);
      if (covered.some((name) => normalizeOrgName(name) === wanted)) continue;

      findings.push(
        defect({
          ...anchor,
          origin: 'deterministic',
          message: `Изготовитель партии ${batch.batchNo ?? batch.heatNo ?? batch.id} материала «${material.nameRaw}» — «${manufacturer}» — не покрыт ни одним приложенным сертификатом: сертификаты выданы на изготовителей «${covered.join('», «')}».`,
          hint: 'Приложите сертификат соответствия (декларацию) на продукцию именно этого изготовителя либо замените партию.',
        }),
      );
    }
  }

  return summarize(
    findings,
    checked,
    'ни у одной партии материалов нет одновременно изготовителя и сертификата для сверки',
  );
}

interface StandardMention {
  readonly value: string;
  readonly source: FieldNode | null;
  readonly document: DocumentNode;
}

function standardsOf(document: DocumentNode): StandardMention[] {
  const mentions: StandardMention[] = [];
  const listField = field(document, AOSR_FIELDS.gostTu);
  for (const value of listOf(document, AOSR_FIELDS.gostTu)) {
    mentions.push({ value, source: listField, document });
  }
  const reference = field(document, AOSR_FIELDS.ndReference);
  const referenceText = trimmedText(reference);
  if (referenceText !== null) {
    mentions.push({ value: referenceText, source: reference, document });
  }
  return mentions;
}

/**
 * НД в паспорте совпадает с НД в сертификате (дефект №3 корпуса).
 *
 * Год редакции — не косметика: «СТО …-2015» в паспорте против «…-2011» в
 * сертификате означает, что сертификат покрывает другую редакцию требований.
 * Поэтому `standardWithoutYear` даёт основу для сопоставления, а `standardYear`
 * — предмет сравнения; выбросив год ради «мягкого сравнения», правило перестало
 * бы находить ровно то, ради чего написано.
 */
function evaluateStandardYears(graph: CheckGraph): RuleResult {
  if (graph.materials.length === 0) return notApplicable(NO_MATERIALS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const material of graph.materials) {
    const documents = documentsOf(graph, material.documentIds);
    const passportMentions = documents
      .filter((document) => isTypeOf(document, PASSPORT_TYPES))
      .flatMap((document) => standardsOf(document));
    const certificateMentions = documents
      .filter((document) => isTypeOf(document, CERTIFICATE_TYPES))
      .flatMap((document) => standardsOf(document));
    if (passportMentions.length === 0 || certificateMentions.length === 0) continue;

    for (const passport of passportMentions) {
      const base = standardWithoutYear(passport.value);
      const matching = certificateMentions.filter(
        (certificate) => standardWithoutYear(certificate.value) === base,
      );
      if (matching.length === 0) continue;

      const passportYear = standardYear(passport.value);
      const anchor = anchorOfField(passport.document, passport.source);

      const withYear = matching.filter((certificate) => standardYear(certificate.value) !== null);
      if (passportYear === null || withYear.length === 0) {
        findings.push(
          unknown({
            ...anchor,
            origin: 'deterministic',
            message: `Нормативный документ «${passport.value}» материала «${material.nameRaw}» указан без года редакции ${passportYear === null ? 'в паспорте' : 'в сертификате'} — сверить редакции нечем.`,
            hint: 'Уточните год редакции нормативного документа в паспорте и в сертификате.',
          }),
        );
        continue;
      }

      checked += 1;
      if (withYear.some((certificate) => standardYear(certificate.value) === passportYear))
        continue;

      // Показывается ИСХОДНОЕ обозначение: `normalizeStandard` сворачивает
      // гомоглифы («СТО» → «CTO»), и в тексте замечания это выглядело бы как
      // ещё одна ошибка распознавания.
      const shown = withYear.map((certificate) => certificate.value);
      findings.push(
        defect({
          ...anchor,
          origin: 'deterministic',
          message: `Нормативный документ в паспорте материала «${material.nameRaw}» — «${passport.value}» — не совпадает по году редакции с нормативным документом в сертификате: «${shown.join('», «')}».`,
          hint: 'Приложите сертификат на действующую редакцию нормативного документа либо паспорт, выданный по покрытой сертификатом редакции.',
        }),
      );
    }
  }

  return summarize(
    findings,
    checked,
    'ни у одного материала нет пары «паспорт — сертификат» с сопоставимыми обозначениями НД',
  );
}

// ---------------------------------------------------------------------------
// REF, XS — справочники и контекст
// ---------------------------------------------------------------------------

function evaluateObjectActive(graph: CheckGraph): RuleResult {
  if (graph.object.id !== graph.folder.objectId) {
    return notApplicable('карточка объекта ревизии не загружена в граф проверки');
  }
  if (graph.object.isActive) return fromFindings([]);

  return fromFindings([
    defect({
      ...anchorOf('folder', graph.folder.id),
      origin: 'deterministic',
      message: `Объект строительства «${graph.object.name}» (${graph.object.code}) помечен в справочнике как неактивный.`,
      hint: 'Проверьте карточку объекта: комплект подан по объекту, снятому с сопровождения.',
    }),
  ]);
}

/**
 * Контрагенты, названные ЭТОЙ папкой.
 *
 * `graph.counterparties` — весь справочник портала: он загружается целиком,
 * потому что `AOSR.HDR.023` ищет в нём совпадение по тройке реквизитов из
 * шапки акта. Правило про активность спрашивает обратное — «действует ли тот,
 * кто участвует в этой папке», — и на полном справочнике отвечало о чужих:
 * любая снятая с учёта организация портала становилась замечанием комплекта,
 * к которому она не имеет отношения.
 *
 * Участниками считаются исполнитель папки и те, кого назвали шапки её актов.
 * Сопоставление — то же `matchCounterparty`, что у HDR.023: вторая мерка
 * разошлась бы с первой молча.
 */
function folderCounterparties(graph: CheckGraph): readonly CounterpartyNode[] {
  const involved = new Map<string, CounterpartyNode>();

  const contractor = graph.counterparties.find((party) => party.id === graph.folder.contractorId);
  if (contractor !== undefined) involved.set(contractor.id, contractor);

  for (const act of aosrActs(graph)) {
    const name = trimmedText(actField(act, AOSR_FIELDS.contractorName));
    const inn = trimmedText(actField(act, AOSR_FIELDS.contractorInn));
    const ogrn = trimmedText(actField(act, AOSR_FIELDS.contractorOgrn));
    if (name === null && inn === null && ogrn === null) continue;

    const party = matchCounterparty(graph.counterparties, { name, inn, ogrn });
    if (party !== null) involved.set(party.id, party);
  }

  return [...involved.values()];
}

function evaluateCounterpartiesActive(graph: CheckGraph): RuleResult {
  const parties = folderCounterparties(graph);
  if (parties.length === 0) {
    return notApplicable('контрагенты папки не опознаны в справочнике');
  }

  const findings = parties
    .filter((party) => !party.isActive)
    .map((party) =>
      defect({
        ...anchorOf('folder', graph.folder.id),
        origin: 'deterministic',
        message: `Контрагент комплекта «${party.name}»${party.inn === null ? '' : ` (ИНН ${party.inn})`} помечен в справочнике как неактивный.`,
        hint: 'Проверьте карточку контрагента: организация снята с учёта или исключена из списка участников строительства.',
      }),
    );

  return fromFindings(findings);
}

function evaluateDuplicateActs(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length < 2) {
    return notApplicable('в комплекте меньше двух актов — дубль невозможен');
  }

  const groups = new Map<string, DocumentNode[]>();
  let checked = 0;

  for (const act of actList) {
    const value = actField(act, AOSR_FIELDS.actNumber) ?? field(act, AOSR_FIELDS.number);
    const number = trimmedText(value);
    if (number === null) continue;
    checked += 1;
    const key = normalizeDocNo(number).folded;
    groups.set(key, [...(groups.get(key) ?? []), act]);
  }

  const findings: RuleFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0] as DocumentNode;
    for (const duplicate of group.slice(1)) {
      findings.push(
        defect({
          ...anchorOfDocument(duplicate),
          origin: 'deterministic',
          message: `В комплекте больше одного акта ${actLabel(duplicate)}: документы ${group.map((act) => String(act.ordinal)).join(', ')} при одном объекте «${graph.object.code}», подрядчике и разделе ${graph.folder.sectionCode}.`,
          hint: `Оставьте в комплекте один акт с этим номером; при исправлении ранее поданного акта подайте новую ревизию, а не второй экземпляр (сравните с документом ${String(first.ordinal)}).`,
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни у одного акта комплекта не распознан номер');
}

// ---------------------------------------------------------------------------
// EXT — внешние реестры (§9.5)
// ---------------------------------------------------------------------------

/**
 * Единственное замечание при недоступном источнике.
 *
 * Текст обязан содержать «требуется ручная проверка» и названную причину:
 * вывод «подрядчик не состоит в СРО» без источника данных — юридическое
 * утверждение, которого система сделать не может.
 */
function unavailableFinding(graph: CheckGraph, subject: string, reason: string): RuleFinding {
  return externalUnavailable({
    ...anchorOf('folder', graph.folder.id),
    message: `${subject} автоматически не проверено: требуется ручная проверка — ${reason}.`,
    hint: 'Проверьте сведения по официальному реестру вручную и приложите подтверждение к комплекту.',
  });
}

function validOn(from: string | null, to: string | null, day: string): boolean {
  if (isIsoDate(from) && day < from) return false;
  if (isIsoDate(to) && day > to) return false;
  return true;
}

function evaluateSro(graph: CheckGraph): RuleResult {
  const lookup = graph.external.sro;
  if (lookup.status === 'unavailable') {
    return fromFindings([unavailableFinding(graph, 'Членство подрядчика в СРО', lookup.reason)]);
  }

  const seen = new Map<string, Anchor>();
  const contractor = graph.counterparties.find((party) => party.id === graph.folder.contractorId);
  if (contractor?.inn != null && digitsOf(contractor.inn) !== '') {
    seen.set(digitsOf(contractor.inn), anchorOf('folder', graph.folder.id));
  }
  for (const act of aosrActs(graph)) {
    const value = actField(act, AOSR_FIELDS.contractorInn);
    const text = trimmedText(value);
    if (text === null) continue;
    const digits = digitsOf(text);
    if (digits === '') continue;
    if (!seen.has(digits)) seen.set(digits, anchorOfField(act, value));
  }

  if (seen.size === 0) {
    return fromFindings([
      unknown({
        ...anchorOf('folder', graph.folder.id),
        origin: 'deterministic',
        message: 'ИНН подрядчика не известен — сверить членство в СРО не с чем.',
        hint: 'Заполните ИНН подрядчика в шапке акта или в карточке контрагента.',
      }),
    ]);
  }

  const findings: RuleFinding[] = [];
  for (const [inn, anchor] of seen) {
    const records = lookup.records.filter((record) => digitsOf(record.memberInn) === inn);
    if (records.length === 0) {
      findings.push(
        defect({
          ...anchor,
          origin: 'deterministic',
          message: `Подрядчик с ИНН ${inn} не найден в реестре саморегулируемых организаций.`,
          hint: 'Приложите выписку из реестра СРО либо уточните ИНН лица, выполнившего работы.',
        }),
      );
      continue;
    }
    if (records.some((record) => validOn(record.validFrom, record.validTo, graph.today))) continue;

    findings.push(
      defect({
        ...anchor,
        origin: 'deterministic',
        message: `Членство подрядчика с ИНН ${inn} в «${records.map((record) => record.sroName).join('», «')}» не действует на дату проверки ${formatDate(graph.today)}.`,
        hint: 'Приложите действующую выписку из реестра СРО на дату выполнения работ.',
      }),
    );
  }

  return fromFindings(findings);
}

function evaluateNrs(graph: CheckGraph, params: RuleParams): RuleResult {
  const lookup = graph.external.nrs;
  if (lookup.status === 'unavailable') {
    return fromFindings([
      unavailableFinding(
        graph,
        'Наличие подписантов акта в национальном реестре специалистов',
        lookup.reason,
      ),
    ]);
  }

  const roles = signerRolesFrom(params);
  const signers = new Map<string, { readonly name: string; readonly anchor: Anchor }>();
  for (const act of aosrActs(graph)) {
    for (const role of roles) {
      const value = field(act, role.field);
      const name = trimmedText(value);
      if (name === null) continue;
      const key = personKey(name);
      if (key !== '' && !signers.has(key)) {
        signers.set(key, { name, anchor: anchorOfField(act, value) });
      }
    }
  }

  if (signers.size === 0) {
    return fromFindings([
      unknown({
        ...anchorOf('folder', graph.folder.id),
        origin: 'deterministic',
        message:
          'Подписанты акта не распознаны — сверить их с национальным реестром специалистов нечем.',
        hint: 'Заполните представителей сторон в блоке подписей акта.',
      }),
    ]);
  }

  const registry = new Set(lookup.records.map((record) => personKey(record.fullName)));
  const findings: RuleFinding[] = [];
  for (const [key, signer] of signers) {
    if (registry.has(key)) continue;
    findings.push(
      defect({
        ...signer.anchor,
        origin: 'deterministic',
        message: `Подписант акта «${signer.name}» не найден в национальном реестре специалистов.`,
        hint: 'Проверьте фамилию и инициалы подписанта либо приложите выписку из НРС.',
      }),
    );
  }

  return fromFindings(findings);
}

function evaluateSchedule(graph: CheckGraph): RuleResult {
  const lookup = graph.external.schedule;
  if (lookup.status === 'unavailable') {
    return fromFindings([
      unavailableFinding(
        graph,
        'Наличие освидетельствованных работ в графике строительства',
        lookup.reason,
      ),
    ]);
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of aosrActs(graph)) {
    const value = workNameField(act);
    const work = trimmedText(value);
    if (work === null) {
      findings.push(
        unknown({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознано наименование работ — сверить с графиком строительства нечем.`,
          hint: 'Введите наименование работ п. 1 вручную.',
        }),
      );
      continue;
    }

    checked += 1;
    const wanted = normalizePhrase(work);
    const found = lookup.records.some((record) => {
      const planned = normalizePhrase(record.workName);
      return (
        planned !== '' &&
        (planned === wanted || planned.includes(wanted) || wanted.includes(planned))
      );
    });
    if (found) continue;

    findings.push(
      defect({
        ...anchorOfField(act, value),
        origin: 'deterministic',
        message: `Работы «${work}» из акта ${actLabel(act)} не найдены в графике строительства.`,
        hint: 'Сверьте наименование работ с графиком строительства либо внесите работы в график.',
      }),
    );
  }

  return summarize(findings, checked, 'ни в одном акте не распознано наименование работ');
}

// ---------------------------------------------------------------------------
// Реестр правил
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Опись передачи: состав ПАПКИ
// ---------------------------------------------------------------------------

/** Описи в папке нет — сверять состав не с чем. */
const NO_TRANSFER = 'в папке нет описи передачи — сверять состав папки не с чем';

/**
 * Реквизиты, любым из которых документ может быть назван в перечне.
 *
 * Документ, у которого не распознан ни один из них, перечнем не ищется в
 * принципе: сверка идёт по номеру. Объявлять его «не названным» значило бы
 * винить папку за собственное чтение.
 */
const NUMBER_FIELDS: readonly string[] = ['number', 'blank_number', 'scheme_number', 'plan_number'];

function hasAnyNumber(document: DocumentNode): boolean {
  return document.fields.some(
    (field) => NUMBER_FIELDS.includes(field.fieldCode) && trimmedText(field) !== null,
  );
}

/** Подпись строки описи: раздел плюс наименование и номер документа. */
function transferRowLabel(row: RegistryRowNode): string {
  const section = row.sectionTitle ?? `строка ${String(row.rowNo)}`;
  const number = row.docNoRaw === null ? '' : `, № ${row.docNoRaw}`;
  return `${section}: «${row.docNameRaw}»${number}`;
}

/**
 * REG.110 — строка описи не нашла своего документа в папке.
 *
 * Опись — эталон состава папки (ADR-0012): она перечисляет всё переданное и
 * ничего не блокирует. Поэтому здесь предупреждение, а не ошибка: расхождение
 * описи и папки решает человек.
 */
function evaluateTransferMissing(graph: CheckGraph): RuleResult {
  if (graph.transferRows.length === 0) return notApplicable(NO_TRANSFER);

  const gaps = graph.coverageGaps;
  const findings = graph.transferRows
    .filter((row) => row.matchState === 'missing')
    .map((row) => {
      const label = transferRowLabel(row);

      // Строка без сравнимого номера отсутствия документа не доказывает —
      // тот же довод, что и у REG.100.
      if (row.docNoNorm === null) {
        return unknown({
          ...anchorOf('registry_row', row.id),
          origin: 'deterministic',
          message: `Строку описи передачи (${label}) сверить не с чем: номер в описи не указан.`,
          hint: 'Сверьте строку описи с папкой вручную либо укажите номер документа в описи.',
        });
      }

      if (gaps > 0) {
        return unknown({
          ...anchorOf('registry_row', row.id),
          origin: 'deterministic',
          message: `Документ, названный описью передачи (${label}), в разобранной части папки не найден.${coverageNote(gaps)}`,
          hint: 'Разберите непривязанные листы папки либо приложите недостающий документ.',
        });
      }

      return defect({
        ...anchorOf('registry_row', row.id),
        origin: 'deterministic',
        message: `Документ, названный описью передачи (${label}), в папке не найден.`,
        hint: 'Приложите недостающий документ к папке либо исправьте строку описи.',
      });
    });

  return fromFindings(findings);
}

/**
 * REG.111 — документ папки не назван описью.
 *
 * Обратный вопрос к REG.110 и вторая половина сверки состава: опись обязана
 * перечислять всё переданное, и лист, которого в ней нет, — это либо забытая
 * строка, либо лишний документ в папке.
 */
function evaluateTransferExtra(graph: CheckGraph): RuleResult {
  if (graph.transferRows.length === 0) return notApplicable(NO_TRANSFER);

  const named = new Set<string>();
  for (const row of graph.transferRows) {
    if (row.matchedDocumentId !== null) named.add(row.matchedDocumentId);
    for (const id of row.candidateDocumentIds) named.add(id);
  }

  // Сама опись себя не перечисляет.
  const transferDocumentIds = new Set(graph.transferRows.map((row) => row.registryDocumentId));

  let unnumbered = 0;
  let checked = 0;
  const findings: RuleFinding[] = [];
  for (const document of graph.documents) {
    if (transferDocumentIds.has(document.id)) continue;
    if (!hasAnyNumber(document)) {
      unnumbered += 1;
      continue;
    }

    checked += 1;
    if (named.has(document.id)) continue;

    findings.push(
      defect({
        ...anchorOf('document', document.id),
        origin: 'deterministic',
        message: `Документ папки «${document.title ?? document.docTypeCode ?? document.id}» не назван ни одной строкой описи передачи.`,
        hint: 'Дополните опись строкой об этом документе либо исключите документ из папки.',
      }),
    );
  }

  // Неприменимо, только если проверить было НЕЧЕГО: у всех документов папки
  // номер не распознан, и сверка по номеру невозможна ни для одного.
  if (checked === 0) {
    return notApplicable(
      `номер не распознан ни у одного документа папки: ${String(unnumbered)} документов сверять с описью нечем`,
    );
  }

  return fromFindings(findings);
}

/**
 * REG.112 — раздел описи не сопоставлен ни одному акту папки.
 *
 * Раздел описи открывается работой и номером её акта. Если акта с таким
 * номером в папке нет, ни одна строка раздела не знает своего комплекта, и
 * сверка ищет их документы по всей папке — то есть заведомо хуже. Замечание
 * адресовано первой строке раздела: своей строки в отчёте у раздела нет.
 */
function evaluateTransferSections(graph: CheckGraph): RuleResult {
  if (graph.transferRows.length === 0) return notApplicable(NO_TRANSFER);

  const sections = new Map<string, RegistryRowNode[]>();
  for (const row of graph.transferRows) {
    const key = row.sectionTitle ?? `__row_${String(row.ordinal)}`;
    const bucket = sections.get(key);
    if (bucket === undefined) sections.set(key, [row]);
    else bucket.push(row);
  }

  const findings: RuleFinding[] = [];
  for (const rows of sections.values()) {
    if (rows.some((row) => row.complectId !== null)) continue;
    const first = rows[0];
    if (first === undefined) continue;

    findings.push(
      defect({
        ...anchorOf('registry_row', first.id),
        origin: 'deterministic',
        message: `Раздел описи передачи «${first.sectionTitle ?? String(first.rowNo)}» не сопоставлен ни одному акту папки: его строки сверяются со всей папкой сразу.`,
        hint: 'Проверьте номер акта в заголовке раздела описи либо приложите акт к папке.',
      }),
    );
  }

  return fromFindings(findings);
}

interface SpecInput {
  readonly code: string;
  readonly title: string;
  readonly kind: RuleKind;
  readonly severity: FindingSeverity;
  readonly blocking: boolean;
  readonly requiresSectionProfile?: boolean;
  readonly params?: RuleParams;
  readonly evaluate: RuleFn;
}

/**
 * Кто вправе снять замечание (§3.9).
 *
 * Блокирующее замечание снимает только руководитель и только с обоснованием;
 * остальное закрывает инженер строительного контроля.
 */
function waiversFor(blocking: boolean): readonly ('engineer' | 'manager')[] {
  return blocking ? ['manager'] : ['engineer', 'manager'];
}

function actRule(input: SpecInput): RuleSpec {
  return {
    code: input.code,
    title: input.title,
    docTypeCode: AOSR_TYPE,
    level: 'document',
    kind: input.kind,
    defaultSeverity: input.severity,
    defaultBlocking: input.blocking,
    waiverRoles: waiversFor(input.blocking),
    requiresSectionProfile: input.requiresSectionProfile ?? false,
    requiresExternalRegistry: null,
    defaultParams: input.params ?? {},
    evaluate: input.evaluate,
  };
}

/** Чек-лист акта освидетельствования скрытых работ (§9.3). */
export const AOSR_RULES: readonly RuleSpec[] = [
  actRule({
    code: 'AOSR.HDR.010',
    title: 'Наименование объекта в акте совпадает с карточкой объекта',
    kind: 'header',
    severity: 'warning',
    blocking: false,
    evaluate: (graph) => evaluateObjectName(graph),
  }),
  actRule({
    code: 'AOSR.HDR.020',
    title: 'Реквизиты сторон в шапке акта заполнены',
    kind: 'header',
    severity: 'error',
    blocking: false,
    evaluate: (graph) => evaluateHeaderParties(graph),
  }),
  actRule({
    code: 'AOSR.HDR.021',
    title: 'Контрольная сумма ИНН в шапке акта',
    kind: 'header',
    severity: 'error',
    blocking: true,
    evaluate: (graph) =>
      evaluateIdentifier(graph, AOSR_FIELDS.contractorInn, 'ИНН', '10 или 12', checkInn),
  }),
  actRule({
    code: 'AOSR.HDR.022',
    title: 'Контрольная сумма ОГРН в шапке акта',
    kind: 'header',
    severity: 'error',
    blocking: true,
    evaluate: (graph) =>
      evaluateIdentifier(graph, AOSR_FIELDS.contractorOgrn, 'ОГРН', '13 или 15', checkOgrn),
  }),
  actRule({
    code: 'AOSR.HDR.023',
    title: 'Тройка ОГРН, ИНН и наименования сходится со справочником',
    kind: 'header',
    severity: 'warning',
    blocking: false,
    evaluate: (graph) => evaluateCounterpartyTriple(graph),
  }),
  actRule({
    code: 'AOSR.ACT.030',
    title: 'Номер акта соответствует шаблону объекта',
    kind: 'act',
    severity: 'warning',
    blocking: false,
    evaluate: (graph) => evaluateActNumberPattern(graph),
  }),
  actRule({
    code: 'AOSR.ACT.031',
    title: 'Дата акта не раньше окончания работ, окончание не раньше начала',
    kind: 'act',
    severity: 'error',
    blocking: true,
    evaluate: (graph) => evaluateActDates(graph),
  }),
  actRule({
    code: 'AOSR.SGN.040',
    title: 'Состав подписантов акта полон',
    kind: 'signatures',
    severity: 'error',
    blocking: false,
    params: { requiredSignerFields: AOSR_SIGNER_ROLES.map((role) => role.field) },
    evaluate: (graph, params) => evaluateSignerSet(graph, params),
  }),
  actRule({
    code: 'AOSR.SGN.041',
    title: 'Реквизиты приказов подписантов указаны',
    kind: 'signatures',
    severity: 'warning',
    blocking: false,
    params: { requiredSignerFields: AOSR_SIGNER_ROLES.map((role) => role.field) },
    evaluate: (graph, params) => evaluateSignerOrders(graph, params),
  }),
  actRule({
    code: 'AOSR.SGN.042',
    title: 'Организация в строке осмотра совпадает с выполнившей работы',
    kind: 'signatures',
    severity: 'error',
    blocking: false,
    evaluate: (graph) => evaluateInspectionOrg(graph),
  }),
  actRule({
    code: 'AOSR.P1.050',
    title: 'Пункт 1: наименование работ и привязка заполнены',
    kind: 'items',
    severity: 'error',
    blocking: false,
    evaluate: (graph) => evaluateItem1(graph),
  }),
  actRule({
    code: 'AOSR.P2.060',
    title: 'Пункт 2: шифр рабочей документации указан с номером изменения',
    kind: 'items',
    severity: 'warning',
    blocking: false,
    params: { revisionPattern: DEFAULT_REVISION_PATTERN },
    evaluate: (graph, params) => evaluateRdFolder(graph, params),
  }),
  actRule({
    code: 'AOSR.P2.061',
    title: 'Пункт 2: шифр рабочей документации есть в справочнике',
    kind: 'items',
    severity: 'error',
    blocking: false,
    evaluate: (graph) => evaluateRdInCatalog(graph),
  }),
  actRule({
    code: 'AOSR.P3.070',
    title: 'Пункт 3: применённые материалы подтверждены документами',
    kind: 'items',
    severity: 'error',
    blocking: false,
    requiresSectionProfile: true,
    evaluate: (graph) => evaluateMaterialsBacked(graph),
  }),
  actRule({
    code: 'AOSR.P3.071',
    title: 'Пункт 3: при более чем пяти документах есть ссылка на реестр',
    kind: 'items',
    severity: 'warning',
    blocking: false,
    params: { maxDocumentsWithoutRegistry: 5 },
    evaluate: (graph, params) => evaluateRegistryReference(graph, params),
  }),
  actRule({
    code: 'AOSR.P4.080',
    title: 'Пункт 4: перечисленные приложения присутствуют в комплекте',
    kind: 'items',
    severity: 'error',
    blocking: false,
    evaluate: (graph) => evaluateAnnexesPresent(graph),
  }),
  actRule({
    code: 'AOSR.P4.081',
    title: 'Пункт 4: наименование схемы согласовано с пунктом 1',
    kind: 'items',
    severity: 'error',
    blocking: true,
    evaluate: (graph) => evaluateSchemeConsistency(graph),
  }),
  actRule({
    code: 'AOSR.P7.090',
    title: 'Пункт 7: последующие работы не совпадают с освидетельствованными',
    kind: 'items',
    severity: 'error',
    blocking: false,
    evaluate: (graph) => evaluateNextWorks(graph),
  }),
];

/**
 * Снятое с исполнения правило «месяц комплекта сходится с датой акта» (S30).
 *
 * ## Почему снято
 *
 * Правило появилось, когда месяц выбирал человек при заведении комплекта, и
 * сверяло акт не с документами, а с числом, которое человек назвал руками.
 * Теперь месяц ВЫВОДИТСЯ порталом из самого раннего акта комплекта, и правило
 * сравнивало бы акт с самим собой — проверка, которая не может не пройти, но
 * выглядит в чек-листе пройденной наравне с настоящими.
 *
 * Сверку даты акта с периодами документов при этом никто не потерял: её ведёт
 * `relevantDateFor` (`helpers.ts`), который берёт дату окончания работ по акту,
 * а за ней дату акта, и на эту дату семейство `DATE.300/302/303/310/312` сверяет
 * сроки действия, даты изготовления партий и отгрузку. Внутреннюю
 * согласованность самих дат акта держит `AOSR.ACT.031`.
 *
 * ## Почему спек остался в коде
 *
 * Он больше не в `RULE_CATALOG` — движок о нём не знает, и сверка реестра при
 * старте его не ждёт. Но миграции `0034` и `0044` УЖЕ ПРИМЕНЕНЫ и содержат его
 * строки, а тест дрейфа сверяет их контрольные суммы с выводом генераторов.
 * Убери спек совсем — пришлось бы либо оставить тест красным, либо
 * перегенерировать применённую миграцию, и раннер объявил бы её `modified`.
 * Поэтому спек живёт в `RETIRED_RULES` (`catalog.ts`) и участвует только в
 * генерации уже применённых файлов.
 *
 * Из БД строки удаляет миграция `0047`: код без реализации в
 * `rule_definitions` не даёт порталу стартовать.
 */
export const WORK_PERIOD_RULES: readonly RuleSpec[] = [
  actRule({
    code: 'AOSR.ACT.032',
    title: 'Месяц комплекта сходится с датой акта',
    kind: 'act',
    severity: 'warning',
    blocking: false,
    // Никогда не вызывается: правила вне каталога движок не исполняет.
    evaluate: () => notApplicable('правило снято с исполнения'),
  }),
];

/** Перекрёстные сверки комплекта: реестр, материалы, справочники, контекст. */
export const CROSSCHECK_RULES: readonly RuleSpec[] = [
  {
    code: 'REG.100',
    title: 'Строка реестра приложений не найдена в комплекте',
    docTypeCode: null,
    level: 'registry',
    kind: 'registry',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: waiversFor(true),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateRegistryMissing(graph),
  },
  {
    code: 'REG.101',
    title: 'Документ комплекта не назван ни одной строкой реестра',
    docTypeCode: null,
    level: 'registry',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateRegistryExtra(graph),
  },
  {
    code: 'REG.102',
    title: 'Строка реестра сопоставлена неоднозначно',
    docTypeCode: null,
    level: 'registry',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateRegistryAmbiguous(graph),
  },
  {
    code: 'MAT.110',
    title: 'Пакет подтверждения материала соответствует матрице раздела',
    docTypeCode: null,
    level: 'material',
    kind: 'materials',
    defaultSeverity: 'error',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: true,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateMaterialMatrix(graph),
  },
  {
    code: 'MAT.111',
    title: 'Изготовитель партии покрыт приложенным сертификатом',
    docTypeCode: null,
    level: 'material',
    kind: 'materials',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: waiversFor(true),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateManufacturerCoverage(graph),
  },
  {
    code: 'MAT.112',
    title: 'Нормативный документ в паспорте совпадает с сертификатом',
    docTypeCode: null,
    level: 'material',
    kind: 'materials',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: waiversFor(true),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateStandardYears(graph),
  },
  {
    code: 'REF.120',
    title: 'Объект строительства активен в справочнике',
    docTypeCode: null,
    level: 'folder',
    kind: 'reference',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateObjectActive(graph),
  },
  {
    code: 'REF.121',
    title: 'Контрагенты комплекта активны в справочнике',
    docTypeCode: null,
    level: 'folder',
    kind: 'reference',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateCounterpartiesActive(graph),
  },
  {
    code: 'XS.130',
    title: 'В комплекте нет дубля акта',
    docTypeCode: null,
    level: 'folder',
    kind: 'crosscheck',
    defaultSeverity: 'error',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateDuplicateActs(graph),
  },
];

/**
 * Сверка состава ПАПКИ с описью передачи.
 *
 * Отдельный набор, а не продолжение `CROSSCHECK_RULES`: тот застыл сид-миграцией
 * 0017 и сверяется с ней тестом дрейфа. Уровень у всех трёх — папка: опись
 * перечисляет её целиком, и на срезе комплекта её строк нет вовсе.
 *
 * Тяжесть — предупреждение, блокировки нет ни у одного правила: опись ничего не
 * блокирует (ADR-0012), она эталон состава, а не разрешение.
 */
export const TRANSFER_REGISTRY_RULES: readonly RuleSpec[] = [
  {
    code: 'REG.110',
    title: 'Строка описи передачи не найдена в папке',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateTransferMissing(graph),
  },
  {
    code: 'REG.111',
    title: 'Документ папки не назван описью передачи',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateTransferExtra(graph),
  },
  {
    code: 'REG.112',
    title: 'Раздел описи передачи не сопоставлен акту',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateTransferSections(graph),
  },
];

/** Внешние реестры (§9.5): без источника данных — «требуется ручная проверка». */
export const EXTERNAL_RULES: readonly RuleSpec[] = [
  {
    code: 'EXT.SRO.140',
    title: 'Членство подрядчика в СРО',
    docTypeCode: null,
    level: 'folder',
    kind: 'external',
    defaultSeverity: 'error',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: 'sro',
    defaultParams: {},
    evaluate: (graph) => evaluateSro(graph),
  },
  {
    code: 'EXT.NRS.141',
    title: 'Подписанты акта в национальном реестре специалистов',
    docTypeCode: null,
    level: 'folder',
    kind: 'external',
    defaultSeverity: 'error',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: 'nrs',
    defaultParams: { requiredSignerFields: AOSR_SIGNER_ROLES.map((role) => role.field) },
    evaluate: (graph, params) => evaluateNrs(graph, params),
  },
  {
    code: 'EXT.SCHED.142',
    title: 'Освидетельствованные работы есть в графике строительства',
    docTypeCode: null,
    level: 'folder',
    kind: 'external',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: 'schedule',
    defaultParams: {},
    evaluate: (graph) => evaluateSchedule(graph),
  },
];
