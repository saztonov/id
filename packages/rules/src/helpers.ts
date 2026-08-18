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

/** Акт освидетельствования скрытых работ и его родственники. */
export const ACT_TYPES = /^aosr/u;

/** Реестр приложений. */
export const REGISTRY_TYPE = 'annex_registry';

/** Протоколы испытаний и акты отбора проб. */
export const PROTOCOL_TYPES = /^lab_protocol_|^sampling_act$|^protocol_/u;

/** Документы о качестве материалов (§8.1, группа «Документы качества»). */
export const QUALITY_TYPES =
  /^cert_conformity$|^declaration$|^quality_passport$|^technical_passport$|^mill_certificate$|^mix_quality_doc$|^fire_certificate$|^refusal_letter$|^equipment_passport$|^ttn$/u;

/**
 * Резервные коды каталога (§8.1).
 *
 * Определяются по суффиксу и по общему коду, а не списком: группы резервных
 * типов заводятся эксплуатацией, и закрытый список в коде превратил бы
 * появление инженерных сетей в задачу на разработку.
 */
export function isFallbackCode(code: string | null): boolean {
  if (code === null) return false;
  return code === 'unknown_document' || code.startsWith('other_');
}

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
      const end = field(act, 'date_end');
      if (isIsoDate(end?.valueDate ?? null)) {
        return {
          date: end?.valueDate as string,
          basis: 'дата окончания работ по акту',
          source: end,
        };
      }
      const actDate = field(act, 'act_date');
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
