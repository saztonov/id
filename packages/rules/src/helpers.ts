/**
 * Доступ к графу и общие преобразования.
 *
 * Всё, чем пользуется больше одной группы правил, живёт здесь: нормализация
 * обозначений НД, разбор дат, выбор релевантной даты по типу связи (§9.2),
 * подбор документов по виду. Вторая копия любой из этих функций разошлась бы с
 * первой молча — на S4 ровно так разъехались две реализации контрольных сумм.
 */
import type {
  CheckGraph,
  DocumentNode,
  FieldNode,
  FindingEvidence,
  MaterialNode,
  ProfileNode,
  RelationNode,
} from './types.js';

// ---------------------------------------------------------------------------
// Виды документов
// ---------------------------------------------------------------------------

/**
 * Принадлежность вида документа выводится из КАТАЛОГА, а не из регулярки.
 *
 * До S27 здесь жили три регулярных выражения — `QUALITY_TYPES`,
 * `PRIMARY_TYPES`, `PROTOCOL_TYPES`, — и такие же копии лежали в задаче
 * построения графа и в офлайн-харнесе. Копии уже разошлись: в здешней не было
 * `other_quality_docs`, то есть «иной документ о качестве» для правил
 * документом о качестве не являлся, а для графа являлся. Каталог объявляет
 * группу полем `group`, и один источник дешевле трёх согласованных.
 *
 * Предикаты ре-экспортируются под прежними именами: их читают правила, тесты и
 * харнес, и переименование ради переименования — правка чужого кода.
 */
export { isAnalysisAnchor, isFallbackCode, isQualityDocCode, isRegistryCode } from '@id/doc-types';

/** Акт освидетельствования — якорь проверки комплекта. */
export const ACT_TYPES = /^aosr/u;

/** Реестр приложений. */
export const REGISTRY_TYPE = 'annex_registry';

/**
 * Протоколы испытаний и акты отбора проб.
 *
 * Единственное из трёх прежних выражений, которое ОСТАЛОСЬ выражением, и это
 * решение, а не недоделка: «испытательный протокол» каталог группой не
 * моделирует. Группа `tests_conclusions` шире с одной стороны — в неё входят
 * экспертные и санитарные заключения, испытаний не проводившие, — и уже с
 * другой: `protocol_grounding` и `protocol_insulation_resistance` лежат в
 * группе `networks`. Замена на группу сдвинула бы область правила `DATE.372`
 * в обе стороны сразу, и на корпусе это видно: три пакета получили
 * «экспертное заключение не связано с актом» там, где протокола нет вовсе.
 */
export const PROTOCOL_TYPES = /^lab_protocol_|^sampling_act$|^protocol_/u;

// ---------------------------------------------------------------------------
// Выборки из графа
// ---------------------------------------------------------------------------

export function documentsOfType(graph: CheckGraph, pattern: RegExp | string): DocumentNode[] {
  return graph.documents.filter((document) => {
    const code = document.docTypeCode;
    if (code === null) return false;
    return typeof pattern === 'string' ? code === pattern : pattern.test(code);
  });
}

export function acts(graph: CheckGraph): DocumentNode[] {
  return documentsOfType(graph, ACT_TYPES);
}

export function documentById(graph: CheckGraph, id: string): DocumentNode | null {
  return graph.documents.find((document) => document.id === id) ?? null;
}

/** Дочерние документы по виду связи (граф задачи 19). */
export function childrenOf(
  graph: CheckGraph,
  parentDocumentId: string,
  relation?: string,
): DocumentNode[] {
  const ids = graph.relations
    .filter(
      (edge: RelationNode) =>
        edge.parentDocumentId === parentDocumentId &&
        (relation === undefined || edge.relation === relation),
    )
    .map((edge) => edge.childDocumentId);
  return graph.documents.filter((document) => ids.includes(document.id));
}

export function parentsOf(graph: CheckGraph, childDocumentId: string): DocumentNode[] {
  const ids = graph.relations
    .filter((edge) => edge.childDocumentId === childDocumentId)
    .map((edge) => edge.parentDocumentId);
  return graph.documents.filter((document) => ids.includes(document.id));
}

// ---------------------------------------------------------------------------
// Реквизиты
// ---------------------------------------------------------------------------

/**
 * Значение реквизита.
 *
 * Проверенное вручную значение приоритетно: `field_values` намеренно не имеет
 * UNIQUE по `(document_id, field_code)` (0005), потому что детерминированный
 * экстрактор и LLM могут предложить разные гипотезы, а выбор фиксируется
 * `is_verified`. Игнорировать этот флаг значило бы, что правка инженера не
 * влияет на проверку.
 */
export function field(document: DocumentNode, fieldCode: string): FieldNode | null {
  const candidates = document.fields.filter((value) => value.fieldCode === fieldCode);
  if (candidates.length === 0) return null;
  const verified = candidates.find((value) => value.isVerified);
  if (verified !== undefined) return verified;
  return [...candidates].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null;
}

export function textOf(document: DocumentNode, fieldCode: string): string | null {
  const value = field(document, fieldCode);
  const text = value?.valueText ?? null;
  return text === null || text.trim() === '' ? null : text;
}

// ---------------------------------------------------------------------------
// Реквизиты акта: канонические коды и группы совместимости
// ---------------------------------------------------------------------------

/**
 * Коды реквизитов акта — РОВНО коды каталога.
 *
 * ## Зачем таблица, если код можно написать строкой по месту
 *
 * До S27 правила называли семь реквизитов акта именами, которых нет ни в
 * каталоге, ни в одном экстракторе: `date_start`, `date_end`, `work_name`,
 * `p4_annexes`, `rd_cipher`, `signers` — и весь чек-лист АОСР честно отвечал
 * «не распознано» на любом комплекте. Тесты этого не ловили, потому что сами
 * клали в граф те же несуществующие коды: тест доказывал согласованность теста
 * с правилом, а не с конвейером.
 *
 * Поэтому таблица здесь, а не в `aosr.ts`: её читают и правила акта, и правила
 * дат (`worksDateOf`), и офлайн-харнес, а `field-codes.test.ts` сверяет каждый
 * код со схемой типа `aosr` в каталоге и со списком реализованных экстракторов.
 */
export const ACT_FIELDS = {
  objectName: 'object_name',
  actNumber: 'act_number',
  actDate: 'act_date',
  /** п. 5, начало работ. */
  dateStart: 'p5_date_start',
  /** п. 5, окончание работ. */
  dateEnd: 'p5_date_end',
  /** п. 1, наименование предъявленных к освидетельствованию работ. */
  workName: 'p1_works',
  /** п. 1, привязка: оси, отметки, захватки. */
  workLocation: 'p1_location',
  /** п. 2, проектная документация и номер изменения. СПИСОК. */
  rdCipher: 'p2_project_docs',
  /** п. 3, применённые материалы. СПИСОК. */
  materials: 'p3_materials',
  /** п. 3, ссылка на реестр приложений. */
  registryRef: 'p3_registry_ref',
  /** п. 4, предъявленные подтверждающие документы. СПИСОК. */
  documents: 'p4_documents',
  /** Блок «Приложения» в подвале бланка — не то же, что п. 4. СПИСОК. */
  attachments: 'annexes',
  /** п. 7, разрешённые последующие работы. */
  nextWorks: 'p7_next_works',
  contractorName: 'contractor_name',
  contractorInn: 'contractor_inn',
  contractorOgrn: 'contractor_ogrn',
  worksPerformedBy: 'works_performed_by',
} as const;

/**
 * Исторические коды: читаются, но не производятся.
 *
 * ## Почему это НЕ синонимы
 *
 * Синоним — это второе имя того же поля, и он обязан быть именем, которого
 * больше ни у кого нет. `p2_project_docs` и `p4_documents` синонимами быть не
 * могли бы: оба объявлены в схеме акта как самостоятельные реквизиты, и
 * «читать одно как другое» дало бы два значения одного смысла с выбором по
 * уверенности — то есть монетку.
 *
 * Здесь перечислены коды, которые в схеме типа `aosr` НЕ объявлены: они либо
 * остались в уже записанных `field_values` от прежних прогонов, либо жили
 * только в правилах. Ни один из них не является живым кодом схемы акта, и это
 * проверяется тестом. Привязка к типу существенна: `date_start` и `date_end` —
 * живые коды у `aosr_responsible_structures` и `aosr_networks`, и там читать их
 * как исторические было бы неверно.
 */
const ACT_FIELD_LEGACY: Readonly<Record<string, readonly string[]>> = {
  [ACT_FIELDS.dateStart]: ['date_start'],
  [ACT_FIELDS.dateEnd]: ['date_end'],
  [ACT_FIELDS.workName]: ['work_name', 'p1_work_name'],
  [ACT_FIELDS.rdCipher]: ['rd_cipher'],
  [ACT_FIELDS.documents]: ['p4_annexes'],
};

/** Канонический код и его исторические имена, в порядке предпочтения. */
export function actFieldCodes(code: string): readonly string[] {
  return [code, ...(ACT_FIELD_LEGACY[code] ?? [])];
}

/** Все канонические коды акта — вход теста и генератора списка полей. */
export const ACT_FIELD_CODES: readonly string[] = Object.values(ACT_FIELDS);

/** Все исторические коды акта. */
export const ACT_LEGACY_FIELD_CODES: readonly string[] = Object.values(ACT_FIELD_LEGACY).flat();

/**
 * Значение реквизита акта с учётом исторических имён.
 *
 * Порядок разрешения: подтверждённое человеком значение под ЛЮБЫМ из имён,
 * затем канонический код, затем исторические. Правка инженера приоритетна
 * независимо от того, под каким именем она сохранена, — иначе переименование
 * кода обесценило бы уже сделанную работу.
 */
export function actField(document: DocumentNode, code: string): FieldNode | null {
  const codes = actFieldCodes(code);

  for (const candidate of codes) {
    const verified = document.fields.find(
      (value) => value.fieldCode === candidate && value.isVerified,
    );
    if (verified !== undefined) return verified;
  }

  for (const candidate of codes) {
    const value = field(document, candidate);
    if (value !== null) return value;
  }

  return null;
}

/** Текст реквизита акта; пустая строка читается как отсутствие значения. */
export function actTextOf(document: DocumentNode, code: string): string | null {
  const text = actField(document, code)?.valueText ?? null;
  return text === null || text.trim() === '' ? null : text.trim();
}

/**
 * Список реквизита акта.
 *
 * Отдельно от `listOf`, потому что список у акта приходит двумя формами:
 * детерминированный экстрактор кладёт элементы и в `value_json`, и склейкой в
 * `value_text`, а модель — только в `value_json`. Правило, читающее список
 * через `textOf`, на ответе модели получило бы `null` и объявило реквизит
 * нераспознанным.
 */
export function actListOf(document: DocumentNode, code: string): string[] {
  const value = actField(document, code);
  if (value === null) return [];
  if (Array.isArray(value.valueJson)) {
    return value.valueJson
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  const text = value.valueText;
  return text === null || text.trim() === '' ? [] : [text.trim()];
}

export function numberOf(document: DocumentNode, fieldCode: string): number | null {
  return field(document, fieldCode)?.valueNum ?? null;
}

/** Список из `value_json` для реквизитов вида `list` (`product_marks`, `gost_tu`). */
export function listOf(document: DocumentNode, fieldCode: string): string[] {
  const value = field(document, fieldCode);
  if (value === null) return [];
  const json = value.valueJson;
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === 'string');
  }
  return value.valueText === null || value.valueText.trim() === '' ? [] : [value.valueText];
}

/** Доказательство из реквизита: `null`, если цитата не отобразилась на span. */
export function evidenceOf(value: FieldNode | null): FindingEvidence[] {
  if (
    value === null ||
    value.pageTextVersionId === null ||
    value.charSpan === null ||
    value.quote === null
  ) {
    return [];
  }
  return [
    {
      pageTextVersionId: value.pageTextVersionId,
      charStart: value.charSpan.start,
      charEnd: value.charSpan.end,
      quote: value.quote,
    },
  ];
}

/**
 * Уверенность значения с поправкой на источник.
 *
 * Значение, снятое со `stamp`-блока, получает потолок: круглая печать,
 * перекрытая подписью, — это тот самый случай, из-за которого ОГРН `…138138`
 * обязан давать `undetermined`, а не `fail`. Проверенное человеком значение,
 * наоборот, полностью надёжно независимо от того, что показал OCR.
 */
export const STAMP_CONFIDENCE_CEILING = 0.5;

export function effectiveConfidence(value: FieldNode | null): number | null {
  if (value === null) return null;
  if (value.isVerified || value.extractedBy === 'manual') return 1;
  const raw = value.confidence;
  if (raw === null) return null;
  return value.blockType === 'stamp' ? Math.min(raw, STAMP_CONFIDENCE_CEILING) : raw;
}

// ---------------------------------------------------------------------------
// Даты
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Даты сравниваются СТРОКАМИ.
 *
 * `YYYY-MM-DD` лексикографически упорядочен так же, как хронологически, а
 * разбор в `Date` внёс бы зависимость от часового пояса процесса туда, где её
 * в данных нет. Тот же приём уже применён в `catalog.ts` для периодов
 * действия профилей.
 */
/**
 * Месяц комплекта по датам его актов (S30).
 *
 * Месяц перестал быть тем, что человек называет руками при заведении: акта в
 * тот момент ещё нет — есть файл, который никто не читал. Портал выводит месяц
 * сам, и берёт его по САМОМУ РАННЕМУ акту комплекта — так поступил бы и
 * человек, подшивая папку.
 *
 * `null` — ни у одного акта дата не распознана. Это не повод подставить
 * сегодняшний месяц: выдуманное значение неотличимо от прочитанного, а месяц
 * комплекта попадает в реестр передачи.
 *
 * Живёт в правилах, а не в воркере, потому что вызывающих двое — конвейер
 * портала и офлайн-харнес, — и вторая копия разошлась бы с первой молча.
 */
export function periodOfEarliestAct(
  actDates: readonly (string | null | undefined)[],
): string | null {
  const earliest = actDates.filter(isIsoDate).sort()[0];
  return earliest === undefined ? null : `${earliest.slice(0, 7)}-01`;
}

export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DATE.test(value);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

export function formatDate(value: string): string {
  return `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
}

/**
 * Релевантная дата документа о качестве по типу связи (§9.2).
 *
 * Возвращает `null`, если ни одна из подходящих дат не известна. Вызывающее
 * правило обязано превратить `null` в `undetermined`, а не в `fail`: план
 * говорит об этом прямым текстом — «если нужная дата или тип связи неизвестны —
 * `undetermined`, а не `fail`».
 */
export interface RelevantDate {
  readonly date: string;
  /** Откуда взята: попадает в текст замечания, иначе вывод непроверяем. */
  readonly basis: string;
  readonly source: FieldNode | null;
}

/**
 * Дата, на которую документ качества обязан действовать.
 *
 * Основание выбирает профиль правил объекта (`relevantDateBasis`): §9.2 прямо
 * говорит, что универсального «действует на дату окончания работ» нет.
 * Порядок поиска внутри основания — от точного к общему; если ни одна дата не
 * известна, ответ `null`.
 */
export function relevantDateFor(
  graph: CheckGraph,
  document: DocumentNode,
  act: DocumentNode | null,
): RelevantDate | null {
  const basis = graph.profile.relevantDateBasis;

  const candidates: readonly (readonly [string, string])[] =
    basis === 'production'
      ? [
          ['manufactured_at', 'дата изготовления партии'],
          ['made_at', 'дата изготовления'],
          ['shipped_at', 'дата отгрузки'],
        ]
      : basis === 'delivery'
        ? [
            ['shipped_at', 'дата отгрузки'],
            ['manufactured_at', 'дата изготовления партии'],
            ['made_at', 'дата изготовления'],
          ]
        : [];

  for (const [code, label] of candidates) {
    const value = field(document, code);
    if (isIsoDate(value?.valueDate ?? null)) {
      return { date: value?.valueDate as string, basis: label, source: value };
    }
  }

  if (basis === 'application' || candidates.length > 0) {
    // Применение — это выполнение работ, освидетельствованных актом.
    if (act !== null) {
      const end = actField(act, ACT_FIELDS.dateEnd);
      if (isIsoDate(end?.valueDate ?? null)) {
        return {
          date: end?.valueDate as string,
          basis: 'дата окончания работ по акту',
          source: end,
        };
      }
      const actDate = actField(act, ACT_FIELDS.actDate);
      if (isIsoDate(actDate?.valueDate ?? null)) {
        return {
          date: actDate?.valueDate as string,
          basis: 'дата акта',
          source: actDate,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Нормализация текста
// ---------------------------------------------------------------------------

/** Гомоглифы кириллицы и латиницы (§8.3, расширенный на S8 список). */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  С: 'C',
  А: 'A',
  Р: 'P',
  О: 'O',
  Е: 'E',
  М: 'M',
  Т: 'T',
  Х: 'X',
  В: 'B',
  К: 'K',
  Н: 'H',
  У: 'U',
  І: 'I',
  Ѕ: 'S',
  Ј: 'J',
};

export function foldHomoglyphs(value: string): string {
  return [...value.toUpperCase()].map((char) => HOMOGLYPHS[char] ?? char).join('');
}

/**
 * Нормализация обозначения НД: ГОСТ, СТО, ТУ.
 *
 * Год редакции СОХРАНЯЕТСЯ — на нём держится дефект №3 корпуса: паспорт
 * ссылается на «СТО …-2015», сертификат покрывает «…-2011». Выбросив год ради
 * «мягкого сравнения», правило перестало бы находить именно то, ради чего оно
 * написано.
 */
export function normalizeStandard(value: string): string {
  return foldHomoglyphs(value)
    .replace(/[«»"'`]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*-\s*/gu, '-')
    .replace(/^ГОСТ\s+Р\s+/u, 'ГОСТ Р ')
    .trim();
}

/** Обозначение НД без года редакции: «СТО 00287852-005-2015» → «СТО 00287852-005». */
export function standardWithoutYear(value: string): string {
  return normalizeStandard(value).replace(/-(?:19|20)\d{2}(?:\s*\(.*\))?$/u, '');
}

/** Год редакции НД либо `null`. */
export function standardYear(value: string): string | null {
  const match = /-((?:19|20)\d{2})(?:\s*\(.*\))?$/u.exec(normalizeStandard(value));
  return match?.[1] ?? null;
}

/** Нормализация наименования организации для сравнения (не для отображения). */
export function normalizeOrgName(value: string): string {
  return foldHomoglyphs(value)
    .replace(/[«»"'`]/gu, '')
    .replace(/\b(?:ООО|ОАО|ЗАО|ПАО|АО|ИП|ГК|НАО)\b/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/**
 * Организация из документа, найденная в справочнике контрагентов.
 *
 * Порядок сравнения выражает НАДЁЖНОСТЬ признака, а не удобство: ИНН и ОГРН —
 * идентификаторы с контрольной суммой, наименование сравнивается нормализацией
 * и совпадает у однофамильцев («ООО Стройсервис» в трёх регионах). Поэтому
 * наименование стоит последним и решает только там, где номеров нет.
 *
 * ## Почему это отдельная функция
 *
 * До S37 тройка жила внутри `AOSR.HDR.023` (`aosr.ts`), где по ней выносится
 * замечание «контрагента из шапки акта нет в справочнике». В S37 тем же
 * сопоставлением конвейер стал ЗАПОЛНЯТЬ исполнителя комплекта. Второй
 * экземпляр разошёлся бы с первым молча — правило говорило бы «нашли», а
 * конвейер «не нашли», — и объяснить расхождение было бы нечем.
 *
 * `null` означает «не нашли», а не «не искали»: вызывающий отличает их сам по
 * тому, была ли у него хоть одна непустая часть тройки.
 */
export interface CounterpartyTriple {
  readonly name?: string | null | undefined;
  readonly inn?: string | null | undefined;
  readonly ogrn?: string | null | undefined;
}

interface MatchableParty {
  readonly name: string;
  readonly inn: string | null;
  readonly ogrn: string | null;
}

export function matchCounterparty<T extends MatchableParty>(
  parties: readonly T[],
  triple: CounterpartyTriple,
): T | null {
  /** Пустое значение и отсутствующее здесь одно и то же: искать не по чему. */
  const given = (value: string | null | undefined): string | null =>
    value === null || value === undefined || value.trim() === '' ? null : value;

  const inn = given(triple.inn);
  const ogrn = given(triple.ogrn);
  const name = given(triple.name);

  const byInn =
    inn === null
      ? undefined
      : parties.find((party) => party.inn !== null && digitsOf(party.inn) === digitsOf(inn));
  const byOgrn =
    ogrn === null
      ? undefined
      : parties.find((party) => party.ogrn !== null && digitsOf(party.ogrn) === digitsOf(ogrn));
  const byName =
    name === null
      ? undefined
      : parties.find((party) => normalizeOrgName(party.name) === normalizeOrgName(name));

  return byInn ?? byOgrn ?? byName ?? null;
}

/** Нормализация марки продукции: `A240C` ↔ `А240С` (§9.4, `MILL`). */
export function normalizeMark(value: string): string {
  return foldHomoglyphs(value).replace(/[\s.-]+/gu, '');
}

/** Цифры значения: ИНН и ОГРН приходят из OCR с пробелами и разделителями. */
export function digitsOf(value: string): string {
  return value.replace(/\D+/gu, '');
}

// ---------------------------------------------------------------------------
// Материалы и профиль
// ---------------------------------------------------------------------------

/**
 * Категория материала уместна в разделе (§9.1, строка 3).
 *
 * Материал вне перечня профиля даёт `n_a`, а НЕ «пакет подтверждения неполон»:
 * ложная ошибка на незнакомом разделе разрушает доверие быстрее пропуска.
 */
export function categoryInProfile(profile: ProfileNode, material: MaterialNode): boolean {
  if (material.categoryCode === null) return false;
  return profile.materialCategories.includes(material.categoryCode);
}

/** Требования матрицы к категории; `null` — категория в матрице не описана. */
export function matrixFor(
  profile: ProfileNode,
  category: string,
): Readonly<Record<string, unknown>> | null {
  const entry = profile.materialMatrix[category];
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as Readonly<Record<string, unknown>>)
    : null;
}

/** Числовой параметр снимка ruleset либо значение по умолчанию. */
export function numberParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Числовой порог правила: `thresholds` профиля ПОВЕРХ параметров снимка.
 *
 * ## Почему выбран этот приоритет, а не обратный
 *
 * Оба источника одинаково воспроизводимы, и спор «что новее» здесь бессмыслен.
 * Снимок `ruleset_rules` неизменяем и закреплён за прогоном (§3.7); профиль
 * раздела тоже версионен, имеет период действия, а его идентификатор и версия
 * вместе с наложением объекта закрепляются в `validation_runs` при старте
 * прогона (§3.2). Повторный прогон месячной давности читает те же две
 * неизменяемые записи независимо от порядка их наложения.
 *
 * Приоритет выбран по ОБЛАСТИ ДЕЙСТВИЯ. Снимок набора правил — калибровка,
 * общая для всего портала: он отвечает на вопрос «что считать разумным по
 * умолчанию». Профиль раздела с наложениями объекта — настройка одного вида
 * раздела на одном объекте, то есть более узкая и более осведомлённая. Узкое
 * побеждает широкое — ровно так уже устроен `resolveEffectiveRules`, где
 * наложение объекта побеждает профиль раздела. Обратный порядок («снимок
 * поверх профиля») означал бы, что `thresholds` не действует НИКОГДА, потому
 * что у каждого параметра снимка есть значение: это и есть то молчаливое
 * игнорирование настройки, ради устранения которого функция подключена.
 *
 * ## Контракт ключа
 *
 * Ключ в `thresholds` — это ИМЯ ПАРАМЕТРА правила (`maxAgeDays`,
 * `designAgeDays`, `graceDays`, …), а не отдельный словарь имён: второй
 * словарь потребовал бы таблицы соответствия, которая разъезжается молча.
 * Параметр, не названный в профиле, приходит из снимка, а `fallback` —
 * последний рубеж на случай снимка, собранного до появления параметра.
 */
export function threshold(
  profile: ProfileNode,
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const fromProfile = profile.thresholds[key];
  if (typeof fromProfile === 'number' && Number.isFinite(fromProfile)) return fromProfile;
  return numberParam(params, key, fallback);
}

/** Строковый список из параметров снимка. */
export function listParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: readonly string[] = [],
): readonly string[] {
  const value = params[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : fallback;
}
