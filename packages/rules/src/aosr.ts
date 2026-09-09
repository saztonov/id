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
import type { FindingTargetType, IdentifierCheck, NormalizedDocNo } from '@id/contracts';
import {
  actItemNumbers,
  checkInn,
  checkOgrn,
  normalizeDocNo,
  ownDocNoOf,
  parseActItem3,
  registryRefNumber,
} from '@id/contracts';

import {
  ACT_FIELDS,
  ACT_TYPES,
  REGISTRY_TYPE,
  actField,
  actListOf,
  actTextOf,
  digitsOf,
  effectiveConfidence,
  evidenceOf,
  field,
  foldHomoglyphs,
  formatDate,
  isIsoDate,
  isQualityDocCode,
  isRegistryCode,
  listOf,
  listParam,
  matchCounterparty,
  normalizeOrgName,
  parentsOf,
  textOf,
  threshold,
} from './helpers.js';
import { DEFAULT_NAME_SIMILARITY_THRESHOLD, nameSimilarity } from './material-cover.js';
import { defect, fromFindings, notApplicable, retiredRule, unknown } from './result.js';
import type {
  CheckGraph,
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
 * Разбор общий со сверкой комплекта (`@id/contracts`, `act-items.ts`): до S59
 * здесь жила своя копия регулярного выражения, и она разошлась с копией в
 * `apps/api` опечаткой `N(?![p{L}])`. Общий разбор к тому же знает про ссылку
 * на родителя: в «Реестр 2 к АОСР № ПБ-1» номер после «к» принадлежит акту, а
 * не строке, — и правило п. 4 больше не ищет документ с номером акта.
 */
const docNoOf = ownDocNoOf;

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
// AOSR.HDR — шапка акта
// ---------------------------------------------------------------------------

/**
 * Кадастровый номер участка: две пары цифр, квартал и участок через двоеточие.
 *
 * Тот же признак по форме, что и в извлечении (`extract.ts`): двоеточие в
 * номерах исполнительной документации не встречается вовсе, и спутать такую
 * запись не с чем.
 */
const CADASTRAL_NUMBER = /\d{2}:\d{2}:\d{6,7}:\d+/u;

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

    /**
     * Кадастровый номер решает раньше, чем формулировка адреса.
     *
     * Наименование объекта — это адрес, набранный человеком, и совпадать
     * посимвольно он не обязан: акт печатает «Мосфильмовская, д.31А», карточка
     * — «Мосфильмовская ул., вл. 31А». Ни одно из них не ошибка, а сравнение
     * включением подстроки на такой паре краснеет всегда: на папке «ИД Мастер
     * апрель 2026» правило дало одиннадцать предупреждений об одном и том же
     * объекте, а инженеру предложило «привести наименование к формулировке
     * карточки» — то есть переписать акты.
     *
     * Кадастровый номер участка стоит в обеих записях и двусмысленности не
     * имеет: это идентификатор, а не название. Совпал — объект тот же, и
     * разночтение адреса замечания не заслуживает. Разошёлся — замечание тем
     * более уместно, и оно называет обе цифры.
     */
    const actCadastral = CADASTRAL_NUMBER.exec(text)?.[0] ?? null;
    const cardCadastral =
      cardNames.map((name) => CADASTRAL_NUMBER.exec(name)?.[0] ?? null).find((n) => n !== null) ??
      null;

    if (actCadastral !== null && cardCadastral !== null) {
      if (actCadastral === cardCadastral) continue;

      findings.push(
        defect({
          ...anchorOfField(act, value),
          origin: 'deterministic',
          message: `Кадастровый номер объекта в акте ${actLabel(act)} — ${actCadastral} — не совпадает с карточкой объекта: ${cardCadastral}.`,
          hint: 'Проверьте, к тому ли объекту относится акт, либо исправьте кадастровый номер в карточке.',
        }),
      );
      continue;
    }

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
 * Знак, которого в цифровом идентификаторе быть не может.
 *
 * Пробел и дефис исключены: это разделители разрядов, их печатают в бумаге.
 * Всё остальное — буква, косая черта, вертикальная — в оригинале не стоит.
 *
 * Признак читают ОБА правила, судящие ИНН и ОГРН шапки: `AOSR.HDR.021` и
 * `AOSR.HDR.022` (контрольная сумма) и `AOSR.HDR.023` (сверка со справочником).
 * Разойдись они — одна и та же цифра дала бы разом «проверить нечем» и
 * обвинение в неверном реквизите, и это ровно то, что случилось на папке
 * «ИД Мастер апрель 2026»: S55 научил поблажке HDR.021 и не тронул HDR.023.
 * Новый потребитель значения обязан спросить здесь, а не завести свою копию.
 */
const UNREADABLE_IDENTIFIER = /[^\d\s\-‐‑–—]/u;

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

    /**
     * Посторонний знак в неправильном номере — след чтения, а не дефект бумаги.
     *
     * ИНН и ОГРН состоят из цифр, и знака, которого в них быть не может, в
     * оригинале нет тоже: его поставил распознаватель. В акте № 48-ОТ/-1 этаж
     * папки «ИД Мастер апрель 2026» ИНН пришёл как «77/8203762» — ноль прочитан
     * косой чертой, — и портал объявлял ОШИБКУ «указано 9 цифр вместо 10»,
     * тогда как в одиннадцати других актах той же папки тот же ИНН прочитан
     * верно. Обвинение в неверном реквизите на таком основании — ровно тот
     * сорт замечания, который разрушает доверие быстрее пропуска (§0.5).
     *
     * Условие узкое дважды: знак учитывается ТОЛЬКО когда проверка и так не
     * прошла, и разделители (пробел, дефис) посторонними не считаются — их
     * ставят в бумаге («7708 203762»).
     */
    if (UNREADABLE_IDENTIFIER.test(text)) {
      findings.push(
        unknown({
          ...anchor,
          origin: 'deterministic',
          message:
            `${label} «${text}» в шапке акта ${actLabel(act)} прочитан со знаком, ` +
            `которого в ${label} быть не может — проверить контрольную сумму нечем.`,
          hint: `Сверьте ${label} со сканом акта и введите значение вручную.`,
        }),
      );
      continue;
    }

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

/**
 * AOSR.HDR.023 — лицо, выполнившее работы, есть в справочнике по ИНН (ORG.REF).
 *
 * Заголовок правила в сиде заморожен и по-прежнему говорит о «тройке», а
 * поведение с S59 другое: сопоставление идёт по ИНН, затем по ОГРН, и
 * наименование не сверяется вовсе. Одно и то же ИНН в боевой базе встречается
 * в трёх написаниях («ОЛИМПРОЕКТ», «Олимпроект», «ОЛИМППРОЕКТ»), и сверять
 * название значило бы обвинять акт в орфографии. Расхождение ИНН при
 * совпавшем ОГРН (и наоборот) остаётся замечанием: это тот же реквизит, что и
 * искали, только с другой стороны.
 */
function evaluateCounterpartyByInn(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);
  if (graph.counterparties.length === 0) {
    return notApplicable('справочник контрагентов пуст — искать лицо по ИНН не в чем');
  }

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const innValue = actField(act, AOSR_FIELDS.contractorInn);
    const ogrnValue = actField(act, AOSR_FIELDS.contractorOgrn);
    const inn = trimmedText(innValue);
    const ogrn = trimmedText(ogrnValue);
    if (inn === null && ogrn === null) {
      findings.push(
        unknown({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `В шапке акта ${actLabel(act)} не распознаны ни ИНН, ни ОГРН лица, выполнившего работы — найти его в справочнике нечем.`,
          hint: 'Введите ИНН лица, выполнившего работы, из шапки акта вручную.',
        }),
      );
      continue;
    }

    // Знак, которого в ИНН быть не может, поставил распознаватель: искать по
    // такому значению нечего. Признак общий с HDR.021/HDR.022.
    const unreadableInn = inn !== null && UNREADABLE_IDENTIFIER.test(inn);
    const unreadableOgrn = ogrn !== null && UNREADABLE_IDENTIFIER.test(ogrn);

    // Сопоставление — общее с конвейером, который заполняет исполнителя
    // комплекта теми же реквизитами (S37): два экземпляра разошлись бы молча.
    // Наименование не передаётся намеренно — см. докстринг.
    const party =
      matchCounterparty(graph.counterparties, {
        name: null,
        inn: unreadableInn ? null : inn,
        ogrn: unreadableOgrn ? null : ogrn,
      }) ?? undefined;
    if (party === undefined) {
      const identifiers = [
        inn === null ? null : `ИНН ${inn}`,
        ogrn === null ? null : `ОГРН ${ogrn}`,
      ]
        .filter((part): part is string => part !== null)
        .join(', ');
      findings.push(
        unreadableInn || unreadableOgrn
          ? unknown({
              ...anchorOfField(act, innValue ?? ogrnValue),
              origin: 'deterministic',
              message: `Реквизиты лица, выполнившего работы, в шапке акта ${actLabel(act)} (${identifiers}) прочитаны со знаком, которого в них быть не может — искать в справочнике нечем.`,
              hint: 'Сверьте ИНН и ОГРН со сканом акта и введите значения вручную.',
            })
          : defect({
              ...anchorOfField(act, innValue ?? ogrnValue),
              origin: 'deterministic',
              message: `Лицо, выполнившее работы, из шапки акта ${actLabel(act)} (${identifiers}) не найдено в справочнике контрагентов.`,
              hint: 'Заведите контрагента с этим ИНН в справочнике либо исправьте ИНН в шапке акта.',
            }),
      );
      continue;
    }

    checked += 1;

    /**
     * Расхождение со справочником считается ТОЛЬКО у читаемого значения.
     *
     * Посторонний знак означает, что цифру поставил распознаватель, а не
     * составитель акта, — и тогда расходится чтение, а не реквизит. Признак
     * общий с `AOSR.HDR.021`/`AOSR.HDR.022` (`UNREADABLE_IDENTIFIER`), иначе
     * одно и то же значение получает у соседних правил разные приговоры.
     */
    const unreadable = (label: string, value: string, node: FieldNode | null): RuleFinding =>
      unknown({
        ...anchorOfField(act, node),
        origin: 'deterministic',
        message:
          `${label} «${value}» в шапке акта ${actLabel(act)} прочитан со знаком, ` +
          `которого в ${label} быть не может — сверить со справочником нечем.`,
        hint: `Сверьте ${label} со сканом акта и введите значение вручную.`,
      });

    if (inn !== null && party.inn !== null && digitsOf(party.inn) !== digitsOf(inn)) {
      findings.push(
        UNREADABLE_IDENTIFIER.test(inn)
          ? unreadable('ИНН', inn, innValue)
          : defect({
              ...anchorOfField(act, innValue),
              origin: 'deterministic',
              message: `ИНН в шапке акта ${actLabel(act)} — «${inn}» — расходится со справочником: у контрагента «${party.name}» указан ИНН ${party.inn}.`,
              hint: 'Сверьте ИНН с выпиской из ЕГРЮЛ и исправьте расходящуюся сторону — акт или карточку контрагента.',
            }),
      );
    }

    if (ogrn !== null && party.ogrn !== null && digitsOf(party.ogrn) !== digitsOf(ogrn)) {
      findings.push(
        UNREADABLE_IDENTIFIER.test(ogrn)
          ? unreadable('ОГРН', ogrn, ogrnValue)
          : defect({
              ...anchorOfField(act, ogrnValue),
              origin: 'deterministic',
              message: `ОГРН в шапке акта ${actLabel(act)} — «${ogrn}» — расходится со справочником: у контрагента «${party.name}» указан ОГРН ${party.ogrn}.`,
              hint: 'Сверьте ОГРН с выпиской из ЕГРЮЛ и исправьте расходящуюся сторону — акт или карточку контрагента.',
            }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознаны реквизиты стороны');
}

// ---------------------------------------------------------------------------
// AOSR.ACT — номер и даты акта
// ---------------------------------------------------------------------------

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

/** Шифр без хвоста с номером изменения: справочник хранит их отдельно. */
function cipherWithoutRevision(cipher: string): string {
  return cipher.replace(/[,;]?\s*изм(?:енени[ея])?\.?\s*№?\s*\d+\s*$/iu, '').trim();
}

// ---------------------------------------------------------------------------
// AOSR.P3, AOSR.P4 — перечни материалов и приложений (S59)
// ---------------------------------------------------------------------------

/**
 * Номер реестра приложений: реквизит `registry_number`, за ним — заголовок.
 *
 * Запасной путь по заголовку не временный. До S59 реквизит извлекался шаблоном
 * ОГРН (`extract.ts`), и в боевой базе у каждого реестра там лежат тринадцать
 * цифр; перераспознавание папок — дело эксплуатации, а правило обязано работать
 * на том, что есть. Заголовок «Реестр № 2 к АОСР № ПБ-1 …» читается тем же
 * разбором, что и ссылка в п. 3 акта, — второй регулярки здесь нет. Значение
 * реквизита пропускается через тот же разбор: тринадцать цифр номером реестра
 * не считаются.
 */
function annexRegistryNumberOf(document: DocumentNode): string | null {
  const stored = textOf(document, 'registry_number');
  const fromField = stored === null ? null : registryRefNumber(`реестр № ${stored}`);
  if (fromField !== null) return fromField;
  return document.title === null ? null : registryRefNumber(document.title);
}

interface AnnexRegistry {
  readonly document: DocumentNode;
  readonly number: string | null;
}

/** Реестры приложений среза с их номерами. */
function annexRegistriesOf(graph: CheckGraph): readonly AnnexRegistry[] {
  return graph.documents
    .filter(
      (document) =>
        document.docTypeCode === REGISTRY_TYPE && document.isKnownType && !document.isFallbackType,
    )
    .map((document) => ({ document, number: annexRegistryNumberOf(document) }));
}

type RegistryLookup =
  | { readonly status: 'found'; readonly document: DocumentNode }
  /** Реестр в срезе один, а номера у него нет: тот ли это реестр — не установить. */
  | { readonly status: 'unnumbered'; readonly document: DocumentNode }
  | { readonly status: 'missing' };

/**
 * Реестр приложений № N в срезе комплекта.
 *
 * Номер акта из ссылки («к АОСР № ПВ-1») не сравнивается: реестр к акту
 * привязала сегментация (комплект), а номер акта в ссылке OCR читает хуже
 * всего — на скриншоте заказчика «ПБ-1» пришёл как «ПВ-1», и правило искало
 * документ с номером акта вместо реестра.
 */
function findAnnexRegistry(graph: CheckGraph, number: string): RegistryLookup {
  const registries = annexRegistriesOf(graph);
  const wanted = normalizeDocNo(number).normalized;
  const found = registries.find(
    (entry) => entry.number !== null && normalizeDocNo(entry.number).normalized === wanted,
  );
  if (found !== undefined) return { status: 'found', document: found.document };

  const single = registries[0];
  if (registries.length === 1 && single !== undefined && single.number === null) {
    return { status: 'unnumbered', document: single.document };
  }
  return { status: 'missing' };
}

/** Замечание о реестре, названном в пункте акта, но не найденном в срезе. */
function registryLookupFinding(
  graph: CheckGraph,
  act: DocumentNode,
  anchor: Anchor,
  item: string,
  number: string,
  lookup: Exclude<RegistryLookup, { status: 'found' }>,
): RuleFinding {
  if (lookup.status === 'unnumbered') {
    return unknown({
      ...anchor,
      origin: 'deterministic',
      message: `${item} акта ${actLabel(act)} ссылается на реестр приложений № ${number}; в комплекте есть реестр, но его номер не прочитан — тот ли это реестр, установить нечем.`,
      hint: 'Сверьте номер реестра приложений с ссылкой в акте вручную.',
    });
  }
  const gaps = graph.coverageGaps;
  if (gaps > 0) {
    return unknown({
      ...anchor,
      origin: 'deterministic',
      severityOverride: 'warning',
      message: `Реестр приложений № ${number}, названный в ${item.toLowerCase()} акта ${actLabel(act)}, в разобранной части комплекта не найден.${coverageNote(gaps)}`,
      hint: 'Разберите непривязанные листы комплекта либо приложите реестр приложений.',
    });
  }
  return defect({
    ...anchor,
    origin: 'deterministic',
    message: `Реестр приложений № ${number}, названный в ${item.toLowerCase()} акта ${actLabel(act)}, в комплекте отсутствует.`,
    hint: 'Приложите реестр приложений к комплекту либо исправьте ссылку в акте.',
  });
}

/** Документ среза с номерами и наименованиями, которыми его можно найти. */
interface CoverCandidate {
  readonly document: DocumentNode;
  readonly numbers: readonly NormalizedDocNo[];
  readonly names: readonly string[];
}

/**
 * Чем материал п. 3 может быть подтверждён: любой документ среза, кроме актов и
 * перечней. Незнакомый вид тоже годится — по номеру: сертификат незнакомой
 * формы остаётся сертификатом (§0.5).
 */
function coverCandidates(graph: CheckGraph): readonly CoverCandidate[] {
  return graph.documents
    .filter((document) => {
      const code = document.docTypeCode;
      return code === null || (!ACT_TYPES.test(code) && !isRegistryCode(code));
    })
    .map((document) => ({
      document,
      numbers: [textOf(document, AOSR_FIELDS.number), textOf(document, 'blank_number')]
        .filter((value): value is string => value !== null)
        .map((value) => normalizeDocNo(value)),
      names: [
        textOf(document, 'product_name'),
        ...listOf(document, 'product_marks'),
        document.title,
      ].filter((value): value is string => value !== null && value.trim() !== ''),
    }));
}

/** Равенство номеров — те же две ступени, что у сверки реестра: точная и свёрнутая. */
function sameNumber(wanted: NormalizedDocNo, own: NormalizedDocNo): boolean {
  if (wanted.normalized === '' || own.normalized === '') return false;
  return wanted.normalized === own.normalized || wanted.folded === own.folded;
}

/**
 * AOSR.P3.070 — у материала из п. 3 есть документ о качестве (MAT.COVER, S59).
 *
 * ## Почему правило переписано
 *
 * Прежняя реализация читала `graph.materials`, а материалы выводятся из
 * документов качества (`materials.ts`): у каждого «материала» документ был по
 * построению, и правило не могло дать ошибку. Пункт 3 акта оно не читало вовсе.
 *
 * ## Как считается покрытие
 *
 * Запись п. 3 — либо ссылка на реестр приложений, либо перечисление позиций
 * «материал (документ № …, документ № …)». Ссылка проверяется наличием реестра
 * с таким номером; его строки покрывают `REG.100`/`REG.102`, и второе
 * замечание о той же строке здесь не выносится (ADR-0018). Позиция считается
 * подтверждённой по НОМЕРУ (точное или свёрнутое равенство, как в сверке) ИЛИ
 * по НАЗВАНИЮ (сходство токенов марки, `material-cover.ts`) — любое совпадение
 * хорошее. Номер совпал, а марка расходится — предупреждение: документ в
 * комплекте есть, вопрос лишь к его предмету. Ни того ни другого — ошибка.
 *
 * Ступень числового ядра из сверки здесь не повторяется намеренно: номер,
 * прочитанный иначе, идёт по пути названия, а вторая лестница разошлась бы с
 * первой (ADR-0028).
 */
function evaluateMaterialCover(graph: CheckGraph, params: RuleParams): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const minSimilarity = threshold(
    graph.profile,
    params,
    'nameSimilarityThreshold',
    DEFAULT_NAME_SIMILARITY_THRESHOLD,
  );
  const candidates = coverCandidates(graph);
  const gaps = graph.coverageGaps;
  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const value = actField(act, AOSR_FIELDS.materials);
    const entries = actListOf(act, AOSR_FIELDS.materials);
    const registryRef = actTextOf(act, AOSR_FIELDS.registryRef);
    const anchor = anchorOfField(act, value);

    if (entries.length === 0 && registryRef === null) {
      findings.push(
        unknown({
          ...anchor,
          origin: 'deterministic',
          message: `В акте ${actLabel(act)} не распознан п. 3 — подтверждение материалов документами проверить нечем.`,
          hint: 'Проверьте распознавание п. 3 акта либо введите перечень материалов вручную.',
        }),
      );
      continue;
    }

    const parsed = parseActItem3(entries);
    const registryNumbers = new Set<string>();
    for (const entry of parsed) {
      if (entry.kind === 'registry_ref') registryNumbers.add(entry.number);
    }
    const refFromField = registryRef === null ? null : registryRefNumber(registryRef);
    if (refFromField !== null) registryNumbers.add(refFromField);

    for (const number of registryNumbers) {
      checked += 1;
      const lookup = findAnnexRegistry(graph, number);
      if (lookup.status === 'found') continue;
      findings.push(registryLookupFinding(graph, act, anchor, 'П. 3', number, lookup));
    }

    for (const entry of parsed) {
      if (entry.kind === 'registry_ref') continue;
      if (entry.kind === 'unparsed') {
        findings.push(
          unknown({
            ...anchor,
            origin: 'deterministic',
            message: `Запись п. 3 акта ${actLabel(act)} «${entry.raw}» не разобрана на материалы и документы — подтверждение проверить нечем.`,
            hint: 'Уточните запись п. 3: материал и реквизиты документа о качестве в скобках.',
          }),
        );
        continue;
      }

      for (const position of entry.positions) {
        checked += 1;
        const wanted = position.numbers.map((number) => normalizeDocNo(number));
        const similarityOf = (candidate: CoverCandidate): number =>
          Math.max(0, ...candidate.names.map((name) => nameSimilarity(position.name, name)));

        const byNumber = candidates.filter((candidate) =>
          candidate.numbers.some((own) => wanted.some((number) => sameNumber(number, own))),
        );
        if (byNumber.length > 0) {
          const best = Math.max(...byNumber.map(similarityOf));
          if (position.name === '' || best >= minSimilarity) continue;
          const named = byNumber
            .map((candidate) => candidate.names[0] ?? null)
            .filter((name): name is string => name !== null);
          findings.push(
            defect({
              ...anchor,
              origin: 'deterministic',
              severityOverride: 'warning',
              message: `Материал «${position.name}» из п. 3 акта ${actLabel(act)}: документ № ${position.numbers.join(', ')} в комплекте есть, но выдан на «${named.join('», «')}» — марка расходится.`,
              hint: 'Сверьте марку материала в п. 3 с документом о качестве: возможно, приложен документ на другую марку.',
            }),
          );
          continue;
        }

        const byName =
          position.name === ''
            ? []
            : candidates.filter(
                (candidate) =>
                  isQualityDocCode(candidate.document.docTypeCode) &&
                  similarityOf(candidate) >= minSimilarity,
              );
        if (byName.length > 0) continue;

        const numbersText =
          position.numbers.length === 0
            ? 'документ без номера'
            : `документов № ${position.numbers.join(', ')}`;
        findings.push(
          gaps > 0
            ? unknown({
                ...anchor,
                origin: 'deterministic',
                severityOverride: 'warning',
                message: `Материал «${position.name}» из п. 3 акта ${actLabel(act)} в разобранной части комплекта не подтверждён: ${numbersText} не найдено, документа о качестве с такой маркой тоже.${coverageNote(gaps)}`,
                hint: 'Разберите непривязанные листы комплекта либо приложите документ о качестве на материал.',
              })
            : defect({
                ...anchor,
                origin: 'deterministic',
                message: `Материал «${position.name}» из п. 3 акта ${actLabel(act)} не подтверждён: ${numbersText} в комплекте нет, документа о качестве с такой маркой тоже.`,
                hint: 'Приложите сертификат, декларацию или паспорт на материал и укажите его в реестре приложений.',
              }),
        );
      }
    }
  }

  return summarize(findings, checked, 'ни в одном акте не разобран п. 3');
}

/**
 * AOSR.P3.071 — длинный перечень заменяется ссылкой на реестр.
 *
 * С S59 правило смотрит и на п. 4: по практике заказчика при трёх–пяти и более
 * материалах в акте появляется реестр № 1, при стольких же исполнительных или
 * геодезических схемах — реестр № 2. Заголовок правила в сиде заморожен и
 * говорит о п. 3; текст замечания называет пункт сам.
 */
function evaluateRegistryReference(graph: CheckGraph, params: RuleParams): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const limit = threshold(graph.profile, params, 'maxDocumentsWithoutRegistry', 5);
  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    const items: readonly (readonly [string, string, string | null])[] = [
      [AOSR_FIELDS.materials, 'п. 3', actTextOf(act, AOSR_FIELDS.registryRef)],
      [AOSR_FIELDS.documents, 'п. 4', null],
    ];

    for (const [fieldCode, item, refField] of items) {
      const entries = actListOf(act, fieldCode);
      if (entries.length === 0) continue;

      checked += 1;
      const parsed = parseActItem3(entries);
      const hasReference =
        parsed.some((entry) => entry.kind === 'registry_ref') ||
        (refField !== null && registryRefNumber(refField) !== null);
      if (hasReference) continue;

      // Позиция перечня — материал с документами (п. 3) либо названный
      // документ (п. 4): у второго нет скобок, и позиции считаются по номерам.
      const listed = parsed.reduce((sum, entry) => {
        if (entry.kind === 'materials') return sum + entry.positions.length;
        return sum + Math.max(1, actItemNumbers(entry.raw).length);
      }, 0);
      if (listed <= limit) continue;

      findings.push(
        defect({
          ...anchorOfField(act, actField(act, fieldCode)),
          origin: 'deterministic',
          message: `В ${item} акта ${actLabel(act)} перечислено ${String(listed)} документов (больше ${String(limit)}), но ссылки на реестр приложений нет.`,
          hint: `Замените перечисление в ${item} ссылкой на реестр приложений либо добавьте её к перечню.`,
        }),
      );
    }
  }

  return summarize(findings, checked, 'ни в одном акте не распознаны перечни п. 3 и п. 4');
}

/**
 * AOSR.P4.080 — приложения из п. 4 присутствуют в комплекте.
 *
 * Запись п. 4 — либо ссылка на реестр приложений (обычно № 2, со схемами),
 * либо документ с номером. Ссылка проверяется наличием реестра; его строки
 * дальше покрывает `REG.100`. Документ ищется по СОБСТВЕННОМУ номеру записи:
 * номер после «к АОСР» принадлежит акту и строкой не является.
 */
function evaluateAnnexesPresent(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const findings: RuleFinding[] = [];
  let checked = 0;

  for (const act of actList) {
    // Правило про ПУНКТ 4 — «предъявлены документы, подтверждающие
    // соответствие работ». Блок «Приложения» в подвале бланка перечисляет
    // другое и живёт под своим кодом `annexes`.
    const documents = actListOf(act, AOSR_FIELDS.documents);
    if (documents.length === 0) continue;

    const anchor = anchorOfField(act, actField(act, AOSR_FIELDS.documents));
    for (const entry of documents) {
      const [parsed] = parseActItem3([entry]);
      if (parsed !== undefined && parsed.kind === 'registry_ref') {
        checked += 1;
        const lookup = findAnnexRegistry(graph, parsed.number);
        if (lookup.status === 'found') continue;
        findings.push(registryLookupFinding(graph, act, anchor, 'П. 4', parsed.number, lookup));
        continue;
      }

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

// ---------------------------------------------------------------------------
// SCH.681 — у акта есть исполнительная схема (SCHEME.REF, S59)
// ---------------------------------------------------------------------------

/** Ведущее целое номера: «48» из «48-ОТ/-1 этаж» и из «48.1-ОТ/1-1 ЭТАЖ». */
function leadingInteger(value: string): string | null {
  return /^\d+/u.exec(normalizeDocNo(value).folded)?.[0] ?? null;
}

/**
 * Основной сигнал — схема есть в срезе комплекта; принадлежность схемы акту
 * уже установила сегментация. Сверка номера — второй план и только в одну
 * сторону, акт → схема: у схемы нет реквизита с номером акта, а новых полей до
 * «паспорта страницы» RD WEB не заводится (ADR-0029). Номер схемы подписан
 * номером акта с индексом («48.1-ОТ/1-1 ЭТАЖ» к акту «48-ОТ/-1 этаж»), поэтому
 * сравниваются ведущие целые: `sheetNumberHead` здесь не годится — он требует
 * точку в номере и на номере акта даёт `null`. Несовпадение — «не проверено»,
 * а не ошибка: номер листа читается хуже прочего текста (см. `hasDocumentNumbered`).
 */
function evaluateSchemePresence(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length === 0) return notApplicable(NO_ACTS);

  const schemes = graph.documents.filter(
    (document) =>
      document.isKnownType &&
      !document.isFallbackType &&
      document.docTypeCode !== null &&
      SCHEME_TYPE.test(document.docTypeCode),
  );
  const gaps = graph.coverageGaps;
  const findings: RuleFinding[] = [];

  for (const act of actList) {
    if (schemes.length === 0) {
      findings.push(
        gaps > 0
          ? unknown({
              ...anchorOfDocument(act),
              origin: 'deterministic',
              message: `К акту ${actLabel(act)} в разобранной части комплекта не найдена исполнительная схема.${coverageNote(gaps)}`,
              hint: 'Разберите непривязанные листы комплекта либо приложите исполнительную схему.',
            })
          : defect({
              ...anchorOfDocument(act),
              origin: 'deterministic',
              message: `К акту ${actLabel(act)} не приложена исполнительная схема.`,
              hint: 'Приложите исполнительную схему освидетельствованных работ к комплекту акта.',
            }),
      );
      continue;
    }

    const actNumber = actTextOf(act, AOSR_FIELDS.actNumber) ?? textOf(act, AOSR_FIELDS.number);
    const head = actNumber === null ? null : leadingInteger(actNumber);
    // У акта нет ведущего числа («ПБ-1») — ссылку номером не выразить, схема есть.
    if (head === null) continue;

    const schemeNumbers = schemes.flatMap((scheme) =>
      [textOf(scheme, 'scheme_number'), textOf(scheme, AOSR_FIELDS.number)].filter(
        (value): value is string => value !== null,
      ),
    );
    if (schemeNumbers.length === 0) {
      findings.push(
        unknown({
          ...anchorOfDocument(act),
          origin: 'deterministic',
          message: `Исполнительная схема к акту ${actLabel(act)} есть, но её номер не распознан — ссылку схемы на номер акта сверить нечем.`,
          hint: 'Сверьте номер на листе схемы с номером акта вручную.',
        }),
      );
      continue;
    }
    if (schemeNumbers.some((number) => leadingInteger(number) === head)) continue;

    findings.push(
      unknown({
        ...anchorOfDocument(act),
        origin: 'deterministic',
        message: `Исполнительная схема к акту ${actLabel(act)} есть, но её номер (${schemeNumbers.join(', ')}) не ссылается на номер акта: ведущее число ${head} не найдено.`,
        hint: 'Сверьте номер схемы с номером акта вручную: по бланку схема подписывается номером акта с индексом.',
      }),
    );
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// XS.131 — объект и шифр проекта одинаковы по всей папке (FOLDER.CONSIST, S59)
// ---------------------------------------------------------------------------

/** Текст для нестрогого сравнения: фолдинг, «ё» → «е», только буквы и цифры. */
function normalizeLooseText(value: string): string {
  return foldHomoglyphs(value)
    .replace(/Ё/gu, 'Е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Корень шифра проекта: «133/23-ГК-ПБ» из «ООО "ГК" ОЛИМППРОЕКТ шифр 133/23-ГК-ПБ
 * "Система пожарной сигнализации"», «02-200223-ГПЗ.1» из записи п. 2.
 *
 * `\p{L}`, а не `\w`: под флагом `u` класс `\w` — это ASCII, и кириллица внутри
 * шифра рвала бы совпадение. Хвост «изм. N» и номер листа срезаются до разбора.
 */
const CIPHER_ROOT =
  /(\d[\d.]*(?:[/-][\p{L}\p{N}.\-/]*?)?-[А-ЯЁA-Z]{2,}\d{0,2}(?:\.\d{1,2})?)(?=[\s,;(»"]|$)/gu;

/** Корни шифра в исходном написании; сравниваются они после фолдинга (`sameRoot`). */
function cipherRootsOf(text: string): readonly string[] {
  const cleaned = cipherWithoutRevision(text).replace(/\s*(?:лист|л\.)\s*\d+.*$/iu, '');
  const roots: string[] = [];
  for (const match of cleaned.matchAll(CIPHER_ROOT)) {
    const root = match[1];
    if (root === undefined) continue;
    if (!roots.some((known) => sameRoot(known, root))) roots.push(root);
  }
  return roots;
}

/** «133/23-ГК-ПБ» и «133/23-ГK-ПБ» (латинская K) — один шифр в двух алфавитах. */
function sameRoot(left: string, right: string): boolean {
  return foldHomoglyphs(left) === foldHomoglyphs(right);
}

/**
 * Папка — один объект и один проект: расхождение между актами означает либо
 * чужой акт в папке, либо ошибку чтения шапки, и в обоих случаях инженеру
 * стоит посмотреть.
 *
 * Объект сравнивается по кадастровому номеру, когда он напечатан в наименовании
 * хотя бы у двух актов (на бою так и печатают), иначе — по наименованию с
 * допуском «одно — начало другого»: то же наименование встречается с
 * кадастровой припиской и без неё. Шифр сравнивается по корням из п. 2:
 * расхождение — когда у актов нет ни одного общего корня.
 */
function evaluateFolderConsistency(graph: CheckGraph): RuleResult {
  const actList = aosrActs(graph);
  if (actList.length < 2) {
    return notApplicable('в папке меньше двух актов — сверять объект и шифр не между чем');
  }

  const findings: RuleFinding[] = [];
  const folderAnchor = anchorOf('folder', graph.folder.id);

  // --- объект ---
  const objects = actList.map((act) => ({
    act,
    name: trimmedText(actField(act, AOSR_FIELDS.objectName)),
  }));
  const withName = objects.filter(
    (entry): entry is typeof entry & { name: string } => entry.name !== null,
  );
  const unnamed = objects.filter((entry) => entry.name === null);
  if (unnamed.length > 0) {
    findings.push(
      unknown({
        ...folderAnchor,
        origin: 'deterministic',
        message: `У актов ${unnamed.map((entry) => actLabel(entry.act)).join(', ')} не распознано наименование объекта — сверить объект по папке нечем.`,
        hint: 'Проверьте распознавание шапки этих актов.',
      }),
    );
  }

  const cadastral = withName
    .map((entry) => ({ act: entry.act, value: CADASTRAL_NUMBER.exec(entry.name)?.[0] ?? null }))
    .filter((entry): entry is { act: DocumentNode; value: string } => entry.value !== null);
  if (cadastral.length >= 2) {
    const variants = [...new Set(cadastral.map((entry) => entry.value))];
    if (variants.length > 1) {
      findings.push(
        defect({
          ...folderAnchor,
          origin: 'deterministic',
          message: `Кадастровый номер объекта расходится между актами папки: ${variants
            .map(
              (value) =>
                `${value} (${cadastral
                  .filter((entry) => entry.value === value)
                  .map((entry) => actLabel(entry.act))
                  .join(', ')})`,
            )
            .join('; ')}.`,
          hint: 'Проверьте, все ли акты относятся к одному объекту, либо исправьте кадастровый номер в шапке акта.',
        }),
      );
    }
  } else if (withName.length >= 2) {
    const normalized = withName.map((entry) => ({ ...entry, key: normalizeLooseText(entry.name) }));
    const groups: { key: string; names: string[]; acts: DocumentNode[] }[] = [];
    for (const entry of normalized) {
      const group = groups.find(
        (candidate) =>
          candidate.key === entry.key ||
          candidate.key.startsWith(entry.key) ||
          entry.key.startsWith(candidate.key),
      );
      if (group === undefined) {
        groups.push({ key: entry.key, names: [entry.name], acts: [entry.act] });
      } else {
        group.acts.push(entry.act);
        if (!group.names.includes(entry.name)) group.names.push(entry.name);
        if (entry.key.length > group.key.length) group.key = entry.key;
      }
    }
    if (groups.length > 1) {
      findings.push(
        defect({
          ...folderAnchor,
          origin: 'deterministic',
          message: `Наименование объекта расходится между актами папки: ${groups.map((group) => `«${group.names[0] ?? ''}» (${group.acts.map((act) => actLabel(act)).join(', ')})`).join('; ')}.`,
          hint: 'Проверьте, все ли акты относятся к одному объекту, либо приведите наименование объекта к одной формулировке.',
        }),
      );
    }
  }

  // --- шифр проекта ---
  const ciphers = actList.map((act) => ({
    act,
    roots: actListOf(act, AOSR_FIELDS.rdCipher).flatMap((entry) => cipherRootsOf(entry)),
  }));
  const withRoots = ciphers.filter((entry) => entry.roots.length > 0);
  const withoutRoots = ciphers.filter((entry) => entry.roots.length === 0);
  if (withoutRoots.length > 0) {
    findings.push(
      unknown({
        ...folderAnchor,
        origin: 'deterministic',
        message: `У актов ${withoutRoots.map((entry) => actLabel(entry.act)).join(', ')} не распознан шифр проекта в п. 2 — сверить шифр по папке нечем.`,
        hint: 'Проверьте распознавание п. 2 этих актов.',
      }),
    );
  }
  if (withRoots.length >= 2) {
    const first = withRoots[0];
    const hasRoot = (roots: readonly string[], root: string): boolean =>
      roots.some((known) => sameRoot(known, root));
    const common =
      first === undefined
        ? []
        : first.roots.filter((root) => withRoots.every((entry) => hasRoot(entry.roots, root)));
    if (common.length === 0) {
      const variants: string[] = [];
      for (const root of withRoots.flatMap((entry) => entry.roots)) {
        if (!hasRoot(variants, root)) variants.push(root);
      }
      findings.push(
        defect({
          ...folderAnchor,
          origin: 'deterministic',
          message: `Шифр проекта расходится между актами папки: ${variants
            .map(
              (root) =>
                `${root} (${withRoots
                  .filter((entry) => hasRoot(entry.roots, root))
                  .map((entry) => actLabel(entry.act))
                  .join(', ')})`,
            )
            .join('; ')}.`,
          hint: 'Проверьте, к одному ли проекту относятся акты папки, либо исправьте шифр в п. 2 акта.',
        }),
      );
    }
  }

  return fromFindings(findings);
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

/**
 * Параметр снятого `AOSR.P2.060` — значение по умолчанию из снимков 0044…0081.
 *
 * Правило снято, а параметр остаётся: `defaultParams` печатаются в применённые
 * миграции наборов, и тест дрейфа сверяет их с каталогом байт в байт.
 */
const RETIRED_REVISION_PATTERN = 'изм(?:енени[ея])?\\.?\\s*№?\\s*\\d+';

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
    evaluate: (graph) => evaluateCounterpartyByInn(graph),
  }),
  actRule({
    // Снято (S59): у объектов шаблон номера не задан ни разу — правило
    // отвечало «неприменимо» на каждом прогоне.
    code: 'AOSR.ACT.030',
    title: 'Номер акта соответствует шаблону объекта',
    kind: 'act',
    severity: 'warning',
    blocking: false,
    evaluate: retiredRule,
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
    // Снято (S59): номер изменения шифра и справочник рабочей документации
    // не входят в минимальный набор проверок. Параметр остаётся: он напечатан
    // в снимках наборов 0044…0081.
    code: 'AOSR.P2.060',
    title: 'Пункт 2: шифр рабочей документации указан с номером изменения',
    kind: 'items',
    severity: 'warning',
    blocking: false,
    params: { revisionPattern: RETIRED_REVISION_PATTERN },
    evaluate: retiredRule,
  }),
  actRule({
    // Снято (S59): справочник рабочей документации на бою пуст.
    code: 'AOSR.P2.061',
    title: 'Пункт 2: шифр рабочей документации есть в справочнике',
    kind: 'items',
    severity: 'error',
    blocking: false,
    evaluate: retiredRule,
  }),
  actRule({
    // MAT.COVER (S59): профиль раздела больше не требуется — вопрос «есть ли
    // у материала документ» от раздела не зависит.
    code: 'AOSR.P3.070',
    title: 'Пункт 3: применённые материалы подтверждены документами',
    kind: 'items',
    severity: 'error',
    blocking: false,
    evaluate: (graph, params) => evaluateMaterialCover(graph, params),
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
    // Снято (S59): число слоёв в наименовании схемы против п. 1 — не из
    // восьми смыслов минимального набора; на бою давало только «не проверено».
    code: 'AOSR.P4.081',
    title: 'Пункт 4: наименование схемы согласовано с пунктом 1',
    kind: 'items',
    severity: 'error',
    blocking: true,
    evaluate: retiredRule,
  }),
  actRule({
    // Снято (S59): сравнение п. 7 с п. 1 не входит в минимальный набор.
    code: 'AOSR.P7.090',
    title: 'Пункт 7: последующие работы не совпадают с освидетельствованными',
    kind: 'items',
    severity: 'error',
    blocking: false,
    evaluate: retiredRule,
  }),
];

/**
 * Правила минимального набора, заведённые в S59 (партия 0082).
 *
 * Отдельный массив, а не дописывание в `AOSR_RULES`/`CROSSCHECK_RULES`: те
 * застыли сид-миграцией 0017 и сверяются с ней тестом дрейфа.
 */
export const MINIMAL_RULES: readonly RuleSpec[] = [
  actRule({
    code: 'SCH.681',
    title: 'К акту приложена исполнительная схема, ссылающаяся на его номер',
    kind: 'items',
    severity: 'warning',
    blocking: false,
    evaluate: (graph) => evaluateSchemePresence(graph),
  }),
  {
    code: 'XS.131',
    title: 'Объект и шифр проекта одинаковы по всей папке',
    docTypeCode: null,
    level: 'folder',
    kind: 'crosscheck',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateFolderConsistency(graph),
  },
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
 * Строка в `rule_definitions` остаётся навсегда: на неё ссылаются замечания
 * прошлых прогонов и снимки опубликованных наборов, а сверка при старте терпит
 * снятые коды через `RETIRED_RULES` (ADR-0019). Прежний комментарий про
 * «миграцию 0047, удаляющую строки» был неверен: 0047 — про период работ.
 */
export const WORK_PERIOD_RULES: readonly RuleSpec[] = [
  actRule({
    code: 'AOSR.ACT.032',
    title: 'Месяц комплекта сходится с датой акта',
    kind: 'act',
    severity: 'warning',
    blocking: false,
    // Никогда не вызывается: правила вне каталога движок не исполняет.
    evaluate: retiredRule,
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
  /**
   * Снятые в S59 (ADR-0029). Спеки остаются ради применённых миграций сида и
   * снимков; `requiresSectionProfile` у снятого правила снят вместе с ним —
   * поле в сид не попадает, а требовать профиль тому, что не исполняется,
   * незачем.
   */
  {
    // Матрица раздела: эталона показателей у портала нет, категории материалов
    // из профиля убраны.
    code: 'MAT.110',
    title: 'Пакет подтверждения материала соответствует матрице раздела',
    docTypeCode: null,
    level: 'material',
    kind: 'materials',
    defaultSeverity: 'error',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
  },
  {
    // Изготовитель партии против сертификата: материаловедческая сверка вне
    // минимального набора; на бою только «не проверено».
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
    evaluate: retiredRule,
  },
  {
    // Год редакции НД в паспорте против сертификата: вне минимального набора.
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
    evaluate: retiredRule,
  },
  {
    // Активность карточки объекта: справочная отметка, не свойство комплекта.
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
    evaluate: retiredRule,
  },
  {
    // Активность контрагентов: то же.
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
    evaluate: retiredRule,
  },
  {
    // Дубль акта: вне восьми смыслов; на бою ни разу не сработало.
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
    evaluate: retiredRule,
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
  /**
   * REG.113–117 сняты в S59 (ADR-0029, частичная отмена ADR-0028).
   *
   * Ретрансляторы расхождений граф строки описи (номер акта, организация,
   * написание номера, дата, число листов) — суждение модели о СОДЕРЖАНИИ
   * строки. По решению заказчика сопоставление строки — только «есть ли
   * документ»; графа «организация» в перечне называет поставщика, а документ —
   * изготовителя, и предупреждение на верно названном сертификате было ложным.
   * Суждение модели о том, КАКОЙ документ отвечает строке, остаётся
   * (`doc.match_partition`); проверки содержания в данных строки сохраняются
   * как сведения, замечаний не порождают.
   */
  {
    code: 'REG.113',
    title: 'Номер акта в строке описи передачи расходится с актом раздела',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
  },
  {
    code: 'REG.114',
    title: 'Организация в строке описи передачи расходится с документом',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
  },
  {
    code: 'REG.115',
    title: 'Номер в строке описи передачи записан иначе, чем в документе',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'info',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
  },
  {
    code: 'REG.116',
    title: 'Дата в строке описи передачи расходится с документом',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
  },
  {
    code: 'REG.117',
    title: 'Число листов в строке описи передачи расходится с документом',
    docTypeCode: null,
    level: 'folder',
    kind: 'registry',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: waiversFor(false),
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
  },
];

/**
 * Внешние реестры (§9.5) — сняты в S59.
 *
 * Источников данных (СРО, НРС, график строительства) у портала нет, и все три
 * правила на каждом прогоне отвечали «требуется ручная проверка» —
 * четыре замечания на папку, ни одного открытого. `requiresExternalRegistry`
 * снят вместе с правилом: поле в сид не попадает, а требовать реестр тому, что
 * не исполняется, незачем.
 */
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
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
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
    requiresExternalRegistry: null,
    defaultParams: { requiredSignerFields: AOSR_SIGNER_ROLES.map((role) => role.field) },
    evaluate: retiredRule,
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
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: retiredRule,
  },
];
