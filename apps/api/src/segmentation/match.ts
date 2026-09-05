/**
 * Сверка реестра приложений с собранными документами (§8.3).
 *
 * ## Сверка идёт по НОМЕРУ, а не по виду документа
 *
 * Это прямая находка корпуса, отменяющая часть исходного замысла §8.3
 * (`docs/CORPUS_FINDINGS.md`, «Реестр приложений называет документы не так,
 * как они называются сами»). Реестр заполняется подрядчиком вручную и
 * обобщает: строка «Паспорт качества Арматура №16005» описывает лист, который
 * сам озаглавлен «СЕРТИФИКАТ КАЧЕСТВА № 16005», а в другом комплекте ВСЕ
 * двенадцать документов о качестве названы просто «Документ о качестве», хотя
 * формы у трёх поставщиков разные.
 *
 * Поэтому вид документа из реестра здесь не участвует в решении вовсе — ни
 * как условие, ни как множитель уверенности. Он остаётся слабой подсказкой
 * для классификатора (§8.2), но расхождение вида дефектом комплекта НЕ
 * является: правило, поднявшее бы на нём замечание, обвиняло бы подрядчика в
 * неполном комплекте там, где комплект полон, а §9.1 прямо запрещает ложные
 * замечания — они разрушают доверие быстрее пропусков.
 *
 * ## Почему коллизия по `folded` — это `ambiguous`, а не `matched`
 *
 * Фолдинг гомоглифов обязателен: одна и та же декларация встречается в двух
 * алфавитах, и `pg_trgm.similarity` даёт на этой паре 0.55 — порогами
 * similarity такое не закрывается. Но фолдинг СКЛЕИВАЕТ классы символов, и
 * при нескольких кандидатах выбор одного из них был бы выдумкой, поданной как
 * факт: строка реестра получила бы `matched` и конкретный документ, которого
 * никто не проверял. `ambiguous` — честный результат: сверка нашла кандидатов,
 * но различить их не может, и это решает человек.
 *
 * ## Лестница ступеней и почему частичное совпадение — последняя из них
 *
 * Точное совпадение → фолдинг гомоглифов → числовое ядро → частичное вхождение
 * номера. Порядок фиксирован, и каждая следующая ступень видит только те строки,
 * которым не ответила предыдущая: иначе кусок номера конкурировал бы с точным
 * совпадением.
 *
 * Частичная ступень заведена не «на всякий случай». Номер листа приходит из
 * штампа, и там он печатается то с приставкой раздела, то без неё, а OCR
 * дополнительно теряет края ячейки. Строгое сравнение на таких парах даёт
 * `missing` — то есть «документа нет в комплекте» про документ, который в
 * комплекте лежит; это ровно тот ложный вывод, который §9.1 запрещает.
 * Плата за ступень — низкий счёт и единственность кандидата: два кандидата
 * дают `ambiguous`, а не выбор наугад.
 */

import { normalizeDocNo } from '@id/contracts';
import { DOC_TYPES, matchDocTypes, resolveDocType } from '@id/doc-types';
import type { ParsedRegistryRow } from './types.js';

/** Документ комплекта в том виде, в каком он участвует в сверке. */
export interface MatchableDocument {
  readonly documentId: string;
  /**
   * Вид документа. В решении НЕ участвует — присутствует ради объяснения и
   * будущей аналитики расхождений «реестр назвал так, документ назвался так».
   */
  readonly docTypeCode: string | null;
  /**
   * Все номера, которыми документ себя называет.
   *
   * Не одно значение, потому что «номер документа» — это не один реквизит.
   * У исполнительной схемы он приходит из штампа (`scheme_number`), у
   * генплана — `plan_number`, у бланочных документов рядом с `number` стоит
   * `blank_number`. Пока сверка смотрела ровно в `number`, ни одна схема
   * комплекта не находила свою строку реестра: у неё этого реквизита нет.
   *
   * Пустой список — номера не извлечены; такой документ не найдётся ни по
   * одной строке, и это честный результат, а не повод искать по прозе.
   */
  readonly numbers: readonly string[];
  /**
   * Дата выдачи документа: слабый признак кандидата, не основание совпадения.
   *
   * `null` — реквизит не извлечён. Пустое значение с любой стороны кандидата не
   * порождает: «дата не прочитана» и «даты разошлись» — разные факты.
   */
  readonly issuedAt: string | null;
  readonly title: string | null;
}

/**
 * Реквизиты, значение которых является номером САМОГО документа.
 *
 * Список закрыт и назван здесь один раз: его читают обе сверки — реестра
 * приложений внутри акта и описи папки, — а разойдясь, они начали бы находить
 * разные документы по одной и той же строке.
 *
 * Критерий отбора один: реквизит называет ЭТОТ документ. Поэтому здесь нет
 * `act_number` (у реестра приложений это номер чужого акта), `batch_number` и
 * `serial_number` (номер партии и заводской номер изделия — не документа):
 * попав сюда, они выдавали бы совпадения между несвязанными бумагами.
 */
export const DOCUMENT_NUMBER_FIELD_CODES = [
  'number',
  'blank_number',
  'scheme_number',
  'plan_number',
] as const;

/** Номера документа из его реквизитов, в порядке значимости кодов выше. */
export function documentNumbersOf(
  values: readonly { readonly fieldCode: string; readonly valueText: string | null }[],
): readonly string[] {
  const numbers: string[] = [];
  for (const code of DOCUMENT_NUMBER_FIELD_CODES) {
    for (const value of values) {
      if (value.fieldCode !== code) continue;
      const text = value.valueText?.trim() ?? '';
      if (text !== '' && !numbers.includes(text)) numbers.push(text);
    }
  }
  return numbers;
}

/**
 * Основание, по которому документ попал в кандидаты строки.
 *
 * Перечисление закрытое: основание уходит в БД и в отчёт, и «похож» без
 * названной причины проверяющему бесполезен.
 */
export type CandidateBasis =
  /** Номер совпал, но сразу у нескольких документов: различить их сверка не может. */
  'doc_no' | 'doc_type' | 'issued_at' | 'doc_type_and_issued_at';

export interface RegistryCandidate {
  readonly documentId: string;
  readonly basis: CandidateBasis;
  readonly score: number;
}

export interface RegistryMatch {
  readonly rowNo: number;
  readonly matchState: 'matched' | 'missing' | 'extra' | 'ambiguous' | 'candidate';
  readonly matchedDocumentId: string | null;
  /** `null` там, где счёта нет: `missing` и `ambiguous` не выбирают документ. */
  readonly matchScore: number | null;
  readonly reason: string;
  /**
   * Документы, которыми строка МОЖЕТ быть, но ни один не подтверждён.
   *
   * Заполняется у `candidate` (похожи видом или датой) и у `ambiguous` (номер
   * совпал сразу у нескольких). У `matched` документ назван прямо, у `missing`
   * кандидатов нет вовсе.
   *
   * У `ambiguous` список обязателен не ради показа. Документ, попавший в
   * претенденты, реестром УПОМЯНУТ, и правило «документ не назван ни одной
   * строкой» обязано считать его названным — иначе комплект получает и
   * «строка сопоставлена неоднозначно», и «документ лишний» за один и тот же
   * факт. `match.ts` считал такие документы названными с самого начала, а
   * правило — нет, и расхождение жило ровно потому, что список никуда не
   * сохранялся.
   */
  readonly candidates: readonly RegistryCandidate[];
}

export interface MatchRegistryResult {
  readonly rows: readonly RegistryMatch[];
  /** Документы, не названные ни одной строкой реестра. Основа finding `REG.extra`. */
  readonly extraDocumentIds: readonly string[];
}

/**
 * Счёт совпадения по точному номеру.
 *
 * Ровно 1.0 и только здесь: единица означает «номера совпали посимвольно»,
 * и никакой другой путь такого утверждения делать не вправе.
 */
const EXACT_SCORE = 1;

/**
 * Счёт совпадения через фолдинг.
 *
 * Строго меньше единицы намеренно. Значение попадает в `registry_rows.match_score`
 * и дальше в §9.1: результат, полученный через склейку классов символов, не
 * должен выглядеть как проверенный факт, иначе низкая уверенность распознавания
 * молча превратится в основание для `fail`.
 */
const FOLDED_SCORE = 0.85;

/**
 * Счёт совпадения по компактной форме номера — с оговоркой (S53).
 *
 * Ниже фолдинга и ВЫШЕ числового ядра: ядро сравнивает часть номера, а
 * компактная форма — весь номер, потерявший только разделители. Замер на папке
 * «ИД Мастер апрель 2026»: опись печатает «52-ОТ/-1 этаж», распознавание
 * отдаёт «52-ОТ/1», и девять актов из двенадцати не находили своей строки
 * описи вместе с двенадцатью реестрами приложений и десятью схемами.
 *
 * Счёт ниже фолдинга намеренно: совпал не номер, а номер без разделителей, и
 * §9.1 обязан видеть по счёту, что решение принято с допуском.
 */
const COMPACT_SCORE = 0.7;

/**
 * Компактная форма короче этого в сравнении не участвует.
 *
 * Пять знаков: «001», «1.1», «7» после выброса разделителей входят подстрокой
 * в половину номеров комплекта, и ступень, и без того нестрогая, начала бы
 * находить случайные пары.
 */
export const MIN_COMPACT_LENGTH = 5;

/**
 * Счёт совпадения по числовому ядру номера.
 *
 * Ниже фолдинга и выше куска: совпал не весь номер и не произвольная его часть,
 * а длинная цифровая серия — то, что в номере несёт различающую нагрузку.
 *
 * Ступень заведена по замеру, а не про запас. В комплекте `№01_Бл_П` реестр
 * называет свидетельства о поверке `С-ДЮОП/17-04-2024/333174456` и
 * `С-ДЮОП/17-04-2024/333174457`, сами листы — `С-ДЮП/17-04-2024/333174456` и
 * `С-ДКП/17-04-2024/333174457`: распознавание вставило в буквенную приставку
 * лишнюю «О». Точная ступень и фолдинг сравнивают номер целиком и расходятся;
 * частичная требует вхождения одной формы в другую и тоже расходится — лишний
 * знак стоит В СЕРЕДИНЕ. Итог до этой ступени: одна строка `candidate`, вторая
 * `missing`, то есть портал заявлял «нет в комплекте» про лист, лежащий в
 * комплекте, — ровно тот ложный вывод, который §9.1 запрещает.
 *
 * Девятизначный хвост при этом совпадает посимвольно и различает документы
 * однозначно: он же напечатан на самом свидетельстве отдельной строкой как
 * «номер записи в Федеральном информационном фонде».
 */
const NUMERIC_CORE_SCORE = 0.7;

/**
 * Короче этого цифровая серия ядром не считается.
 *
 * Шесть знаков — не круглое число, а граница, ниже которой серия перестаёт быть
 * различающей: год («2024»), день и месяц («17», «04»), номер партии («3»),
 * пункт перечня встречаются в номерах комплекта постоянно, и совпадение по ним
 * означало бы «у обоих документов есть цифры».
 */
export const MIN_NUMERIC_CORE_LENGTH = 6;

/**
 * Счёт частичного совпадения номера.
 *
 * Заметно ниже фолдинга: совпал не номер, а его КУСОК. Так бывает штатно —
 * реестр пишет «К14/ДК2-СЦ4», а в штампе номер напечатан с приставкой раздела
 * либо наоборот, — но утверждать по куску «это тот самый документ» нельзя, и
 * §9.1 обязан видеть по счёту, что решение требует глаз человека.
 */
const PARTIAL_SCORE = 0.6;

/**
 * Счёт совпадения с допуском в один знак.
 *
 * Ниже частичного: там совпал КУСОК номера целиком, здесь же не совпало
 * ничего — расходится знак внутри. Ступень заведена по замеру, как и числовое
 * ядро. Сертификат пожарной безопасности АРТАЛИКС в папке «ИД Мастер апрель
 * 2026» напечатан номером `РОСС RU.32311.ОС01.ПВ01.0539`, а реестр и его
 * приложения называют `…ПБ01…`. Фолдинг такую пару не сводит и не должен: он
 * про неразличимость начертаний, а «Б» и «В» различимы. Числовое ядро тоже не
 * помогает — длинных цифровых серий в этом номере нет.
 *
 * Счёт низкий намеренно: §9.1 обязан видеть, что решение принято с допуском.
 */
const ONE_CHAR_SCORE = 0.5;

/**
 * Короче этого номер с допуском не сравнивается.
 *
 * Двенадцать знаков: короче — и допуск начнёт склеивать номера, различающиеся
 * законно («48.1-ОТ» против «48.2-ОТ»). В шифре из двадцати знаков расхождение
 * ровно в одном — это чтение, а не другой документ.
 */
const MIN_ONE_CHAR_LENGTH = 12;

/**
 * Короче этого номера в частичном сравнении не участвуют.
 *
 * «1», «7», «А» входят подстрокой в половину номеров комплекта, и разрешить их
 * значило бы выдавать случайные пары за находки. Ступень существует ради
 * длинных шифров, где потерян префикс или хвост.
 */
export const MIN_PARTIAL_LENGTH = 4;

/**
 * Счёт кандидата: строго ниже частичного совпадения и НЕ равен совпадению.
 *
 * Кандидат — не слабое совпадение, а другое состояние. Совпадение утверждает
 * «это тот самый документ» и строит ребро графа `акт → документ`, которое
 * читают правила дат; кандидат утверждает только «похоже, и подтвердить
 * нечем». Счёт нужен ради упорядочивания кандидатов между собой, а не ради
 * сравнения с совпадениями.
 */
const CANDIDATE_TYPE_SCORE = 0.4;
const CANDIDATE_DATE_SCORE = 0.35;
const CANDIDATE_BOTH_SCORE = 0.5;

/**
 * Вид документа, выведенный из НАИМЕНОВАНИЯ строки реестра.
 *
 * §8.3 запрещает решать по виду: реестр обобщает, и «Паспорт качества Арматура
 * №16005» описывает лист, озаглавленный «СЕРТИФИКАТ КАЧЕСТВА № 16005». Запрет
 * остаётся в силе для СОВПАДЕНИЯ и снят только для кандидата — потому что
 * кандидат ничего не утверждает.
 *
 * Каталог берётся тот же и функцией той же: вторая реализация «на что похоже
 * это наименование» разошлась бы с классификатором страниц, и строка реестра
 * начала бы считаться похожей на документ, которым он никогда не был.
 * Наименование материала («Гвозди», «Блок стеновой 600x250x200») вида не даёт
 * вовсе — и это правильный ответ, а не пропуск.
 */
/**
 * Малый лексикон СТРУКТУРНЫХ видов, которые перечень называет своими словами.
 *
 * Каталог видов рассчитан на ЗАГОЛОВОК ЛИСТА, а строка перечня — не заголовок:
 * «АОСР Устройство шпатлевки стен…» ни одному якорю акта не отвечает, потому
 * что акт узнаётся по фразам бланка РД-11-02, которых в строке нет. Из-за
 * этого строка акта оставалась без вида, ограничение «акт и схема носят один
 * номер» не срабатывало, и строка исполнительной схемы дотягивалась до самого
 * акта.
 *
 * Лексикон закрыт тремя видами, у которых опись пишет вид прямо в
 * наименовании, и открывать его шире нельзя: §8.3 запрещает решать по виду
 * там, где перечень обобщает («Паспорт качества Арматура» на листе
 * «СЕРТИФИКАТ КАЧЕСТВА»).
 */
const STRUCTURAL_ROW_TYPES: readonly (readonly [RegExp, string])[] = [
  [/^\s*(?:АОСР|Акт\s+освидетельствован)/iu, 'aosr'],
  [
    /^\s*Реестр\s*(?:№\s*[\d.]+\s*)?(?:к\s+(?:АОСР|АОСП|АСР|акту|№)|приложений)/iu,
    'annex_registry',
  ],
  [/^\s*Исполнительн\S*\s+схем/iu, 'exec_scheme'],
];

function rowDocType(row: ParsedRegistryRow): string | null {
  const name = row.docNameRaw.trim();
  if (name === '') return null;

  for (const [pattern, code] of STRUCTURAL_ROW_TYPES) {
    if (pattern.test(name)) return code;
  }

  return resolveDocType(matchDocTypes(name, DOC_TYPES, { headingLines: 1 }), DOC_TYPES).code;
}

/**
 * Единственная пара видов, которую номер различить НЕ МОЖЕТ.
 *
 * §8.3 запрещает решать по виду, и запрет остаётся в силе: реестр обобщает
 * наименования, и «Паспорт качества Арматура №16005» законно описывает лист
 * «СЕРТИФИКАТ КАЧЕСТВА № 16005». Здесь исключается не расхождение вида, а
 * структурная неразличимость: акт и его исполнительная схема носят в описи
 * ОДИН номер. В папке «ИД Мастер апрель 2026» позиция 1.1 («АОСР …») и
 * позиция 1.16 («Исполнительная схема …») обе стоят с номером «№ 48-ОТ/-1
 * этаж», и номер сам по себе не отвечает, какую из двух бумаг искать.
 *
 * Что было без этого: строка схемы дотягивалась до АКТА частичным совпадением
 * (0.60) и объявлялась сопоставленной, а все двенадцать исполнительных схем
 * папки оставались «не названными описью передачи» — двенадцать ложных
 * предупреждений REG.111 при правильно заполненной описи.
 */
const ACT_CLASS = /^aosr/u;
const SCHEME_CLASS = /^exec_/u;

function numberSharingClass(code: string | null): 'act' | 'scheme' | null {
  if (code === null) return null;
  if (ACT_CLASS.test(code)) return 'act';
  if (SCHEME_CLASS.test(code)) return 'scheme';
  return null;
}

/**
 * Строка и документ принадлежат разным половинам этой пары.
 *
 * Обе стороны обязаны быть УВЕРЕННО опознаны: наименование материала вида не
 * даёт вовсе (`rowDocType` вернёт `null`), и такая строка ограничения не
 * получает — иначе запрет расползся бы на весь реестр.
 */
function contradictsSharedNumber(rowType: string | null, docType: string | null): boolean {
  const row = numberSharingClass(rowType);
  const document = numberSharingClass(docType);
  return row !== null && document !== null && row !== document;
}

/** Как основание кандидата читается человеком в объяснении решения. */
function basisLabel(basis: CandidateBasis): string {
  switch (basis) {
    case 'doc_no':
      return 'номером документа';
    case 'doc_type_and_issued_at':
      return 'и видом, и датой выдачи';
    case 'doc_type':
      return 'видом документа';
    case 'issued_at':
      return 'датой выдачи';
  }
}

/**
 * Документы, похожие на строку по виду либо по дате выдачи.
 *
 * Ступень последняя и самая слабая, поэтому её видят только строки, которым не
 * ответила ни одна ступень номера. Документы, уже названные другой строкой, в
 * кандидаты не попадают: они заняты, и предлагать их второй раз значит
 * подсказывать проверяющему заведомо неверный ответ.
 */
function candidatesOf(
  row: ParsedRegistryRow,
  documents: readonly MatchableDocument[],
  taken: ReadonlySet<string>,
): readonly RegistryCandidate[] {
  const typeCode = rowDocType(row);
  const found: RegistryCandidate[] = [];

  for (const document of documents) {
    if (taken.has(document.documentId)) continue;

    const sameType = typeCode !== null && document.docTypeCode === typeCode;
    const sameDate = row.issuedAt !== null && document.issuedAt === row.issuedAt;
    if (!sameType && !sameDate) continue;

    const basis: CandidateBasis =
      sameType && sameDate ? 'doc_type_and_issued_at' : sameType ? 'doc_type' : 'issued_at';
    const score =
      basis === 'doc_type_and_issued_at'
        ? CANDIDATE_BOTH_SCORE
        : basis === 'doc_type'
          ? CANDIDATE_TYPE_SCORE
          : CANDIDATE_DATE_SCORE;

    found.push({ documentId: document.documentId, basis, score });
  }

  return found.sort((left, right) => right.score - left.score);
}

/**
 * Внутренний «№» в графе номера помечает, где номер начинается.
 *
 * `cleanDocNo` снимает «№» ВЕДУЩИЙ, но реестр сплошь и рядом пишет перед
 * номером сокращённый вид документа: «ИС №001», «ПС №4». Тогда «№» оказывается
 * внутри значения, и сравнимая форма получается `ИС001` — при том, что сам лист
 * называет себя «№ 001». Ни одна ступень лестницы такую пару не сводит: точная
 * и фолдинг сравнивают целиком, а частичная требует от КАЖДОЙ стороны четырёх
 * символов и до трёхсимвольного `001` не дотягивается.
 *
 * Поэтому у строки может быть вторая сравнимая форма — хвост после последнего
 * «№». Она не заменяет первую, а дополняет: «ИС №001» ищется и как `ИС001`, и
 * как `001`.
 *
 * ## Почему форма вычисляется здесь, а не хранится
 *
 * `registry_rows` хранит `doc_no_norm` и `doc_no_folded` — формы САМОГО
 * значения. Алиас же — предположение о том, где в значении кончается приставка,
 * и относится он к сопоставлению, а не к разбору. Храниться должно то, что
 * прочитано с листа; выводимое из него незачем класть в таблицу, где оно
 * разойдётся с алгоритмом при первой же правке.
 */
const INNER_NUMBER_SIGN = /№\s*(.+)$/u;

/**
 * Сравнимые формы строки реестра: сохранённая и, если есть, алиас.
 *
 * Алиас участвует ТОЛЬКО в точной ступени и фолдинге. В частичную его пускать
 * нельзя: «001» входит подстрокой в половину номеров комплекта, и ступень,
 * которая и без того нестрогая, начала бы находить случайные пары.
 */
/**
 * Хвост наименования после «№» до даты: собственный номер документа (S53).
 *
 * Опись описывает исполнительную схему так: «Исполнительная схема устройства
 * стен сплошной штукатурки в/о 3-4//А-Б на отм. -3,850 №52.1-от/-1 этаж от
 * 10.04.2026г.», а в графе номера у той же строки стоит номер АКТА — «52-ОТ/-1
 * этаж». Собственный номер схемы напечатан только в наименовании, и без него
 * десять схем папки не находили своих строк: графа номера отвечала актом,
 * который строке схемы запрещён как структурно неразличимый.
 *
 * Граница — дата: «… № 52.1-от/-1 этаж ОТ 10.04.2026г.». Всё, что после неё, к
 * номеру не относится.
 */
const NAME_NUMBER_TAIL = /№\s*([^№]+?)(?:\s+от\s+\d|\s*$)/u;

function nameAlias(name: string): string {
  const match = NAME_NUMBER_TAIL.exec(name);
  return match?.[1]?.trim() ?? '';
}

/**
 * Сравнимые формы строки перечня: сохранённая, алиас графы номера и алиас
 * наименования.
 *
 * Порядок значим для ОБЪЯСНЕНИЯ, а не для решения: все формы ищутся вместе, и
 * при нескольких найденных документах строка получает `ambiguous`, как и при
 * коллизии одной формы.
 */
function rowKeys(row: ParsedRegistryRow): {
  readonly normalized: readonly string[];
  readonly folded: readonly string[];
} {
  const normalized = [row.docNoNorm as string];
  const folded = [row.docNoFolded as string];

  const push = (value: string): void => {
    if (value === '') return;
    const alias = normalizeDocNo(value);
    if (alias.normalized !== '' && !normalized.includes(alias.normalized)) {
      normalized.push(alias.normalized);
      folded.push(alias.folded);
    }
  };

  const inner = row.docNoRaw === null ? null : INNER_NUMBER_SIGN.exec(row.docNoRaw);
  push(inner?.[1]?.trim() ?? '');
  push(nameAlias(row.docNameRaw));

  return { normalized, folded };
}

/** Документы, найденные по любой из сравнимых форм строки. */
function lookup(index: Map<string, string[]>, keys: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const key of keys) {
    for (const id of index.get(key) ?? []) {
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
}

/** Индекс документов по одной из форм номера: у документа их может быть несколько. */
function indexBy(
  documents: readonly MatchableDocument[],
  form: (value: string) => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const document of documents) {
    for (const number of document.numbers) {
      const key = form(number);
      if (key === '') continue;

      const bucket = index.get(key);
      // Один документ не попадает в свою же корзину дважды: две формы номера
      // могут нормализоваться одинаково, и тогда он выглядел бы коллизией сам
      // с собой, то есть строка получала бы `ambiguous` на ровном месте.
      if (bucket === undefined) index.set(key, [document.documentId]);
      else if (!bucket.includes(document.documentId)) bucket.push(document.documentId);
    }
  }

  return index;
}

/**
 * Самая длинная цифровая серия номера; `null` — различающей серии в нём нет.
 *
 * Именно САМАЯ ДЛИННАЯ, а не первая и не все подряд: в
 * `С-ДЮОП/17-04-2024/333174456` серий четыре, и три из них — календарные.
 * Выбор по длине даёт ту единственную, ради которой ступень существует, и не
 * требует знать раскладку конкретного бланка.
 */
export function numericCoreOf(folded: string): string | null {
  let longest = '';
  for (const match of folded.matchAll(/\d+/gu)) {
    if (match[0].length > longest.length) longest = match[0];
  }
  return longest.length >= MIN_NUMERIC_CORE_LENGTH ? longest : null;
}

/** Документы, чьё числовое ядро номера совпало с ядром строки. */
function numericCoreCandidates(
  core: string,
  documents: readonly MatchableDocument[],
): readonly string[] {
  const found: string[] = [];
  for (const document of documents) {
    const hit = document.numbers.some(
      (number) => numericCoreOf(normalizeDocNo(number).folded) === core,
    );
    if (hit && !found.includes(document.documentId)) found.push(document.documentId);
  }
  return found;
}

/**
 * Документы, чья компактная форма номера РАВНА форме строки.
 *
 * Только равенство: вхождение — это уже частичное совпадение, и оно живёт
 * ступенью ниже со своим счётом. Здесь номер совпал целиком, разошлись лишь
 * разделители: «RU.СМИК.001.Н.00270» и «RU СМИК 001 Н 00270».
 */
function compactCandidates(
  rowCompact: string,
  documents: readonly MatchableDocument[],
): readonly string[] {
  if (rowCompact.length < MIN_COMPACT_LENGTH) return [];

  const found: string[] = [];
  for (const document of documents) {
    const hit = document.numbers.some((number) => normalizeDocNo(number).compact === rowCompact);
    if (hit && !found.includes(document.documentId)) found.push(document.documentId);
  }
  return found;
}

/**
 * Документы, чей номер содержит номер строки (или содержится в нём).
 *
 * Сравнение идёт по КОМПАКТНОЙ форме (S53). Вхождение спрашивает «одна запись
 * номера внутри другой», а разделители в этом вопросе не значат ничего: на
 * боевой папке акт напечатан «48-ОТ/-1 этаж», а распознан «48-ОТ/1», и по
 * свёрнутой форме вхождения нет из-за одного лишнего дефиса — девять актов
 * из двенадцати объявлялись отсутствующими. Граница цифровых групп в
 * компактной форме сохранена, поэтому «1.23-ОТ» и «12.3-ОТ» по-прежнему
 * различаются.
 */
function partialCandidates(
  rowCompact: string,
  documents: readonly MatchableDocument[],
): readonly string[] {
  if (rowCompact.length < MIN_PARTIAL_LENGTH) return [];

  const found: string[] = [];
  for (const document of documents) {
    const hit = document.numbers.some((number) => {
      const key = normalizeDocNo(number).compact;
      if (key.length < MIN_PARTIAL_LENGTH) return false;
      return key.includes(rowCompact) || rowCompact.includes(key);
    });
    if (hit && !found.includes(document.documentId)) found.push(document.documentId);
  }
  return found;
}

/** Различаются ли строки ровно одной заменой, вставкой или пропуском знака. */
export function differsByOneChar(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;

  if (a.length === b.length) {
    let seen = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i] && (seen += 1) > 1) return false;
    }
    return seen === 1;
  }

  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < long.length && j < short.length) {
    if (long[i] === short[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    i += 1;
  }
  return true;
}

/**
 * Документы, чей номер отличается от номера строки ровно одним знаком.
 *
 * Сравнение по КОМПАКТНОЙ форме (S53): «один знак» — вопрос о буквах и цифрах,
 * а не о разделителях. Опись печатает «RU СММК 001 Н 00270», лист —
 * «RU.СМИК.001.Н.00270»; по свёрнутой форме длины расходятся на четыре точки, и
 * ступень не срабатывала при единственном различающемся знаке «М»/«И».
 *
 * Последняя ступень номера: она отвечает там, где не ответили ни точное
 * сравнение, ни фолдинг, ни числовое ядро, ни кусок, — то есть на паре букв,
 * которые распознавание путает по соседству штрихов, а не по сходству
 * начертаний.
 */
function oneCharCandidates(
  rowCompact: string,
  documents: readonly MatchableDocument[],
): readonly string[] {
  if (rowCompact.length < MIN_ONE_CHAR_LENGTH) return [];

  const found: string[] = [];
  for (const document of documents) {
    const hit = document.numbers.some((number) => {
      const key = normalizeDocNo(number).compact;
      return key.length >= MIN_ONE_CHAR_LENGTH && differsByOneChar(key, rowCompact);
    });
    if (hit && !found.includes(document.documentId)) found.push(document.documentId);
  }
  return found;
}

/**
 * Ссылка на документ в прозе п. 3 акта: значение после «№» до конца ссылки.
 *
 * Пункт 3 бланка перечисляет применённые материалы вместе с реквизитами
 * подтверждающих документов, и записан он одной строкой прозы:
 *
 * ```
 * 1.Песок для строительных работ (Паспорт №0297 от 26.09.2024г., Сертификат
 * соответствия №RU.MCC.234.435.37815 (с 01.08.2023г. по 01.08.2026г.).
 * ```
 *
 * Границей номера служит то, что за ним идёт: предлог «от» перед датой, запятая,
 * точка с запятой или скобка. Пробелы ВНУТРИ номера допускаются — «№ РОСС RU
 * BY.HE06.H22245» пишется через них, — и именно поэтому границей не может быть
 * пробел.
 */
const ACT_ITEM3_NUMBER = /(?:№|N(?![\p{L}]))\s*([^,;()]+?)(?=\s+от\s|\s*[,;()]|$)/gu;

/**
 * Короче этого ссылка номером не считается.
 *
 * Двузначное значение после «№» — это пункт перечня или номер партии, а не
 * номер документа; сопоставление по нему нашло бы случайный лист.
 */
const MIN_ACT_ITEM3_NUMBER_LENGTH = 3;

/**
 * Документы комплекта, названные в п. 3 акта.
 *
 * ## Зачем это нужно
 *
 * Реестр приложений — не единственный законный способ назвать приложение. Бланк
 * РД-11-02 пишет «Приложения: в соответствии с п. 3, 4», то есть объявляет
 * приложениями И перечень документов о качестве из п. 3, и реестр из п. 4.
 * Пока граф строился только по реестру, четыре документа комплекта `№01_Бл_П` —
 * сертификат № 275, два сертификата соответствия и паспорт качества — не были
 * связаны с актом ни одним ребром. Следствий два, и оба ложные: правила дат
 * отвечали «релевантная дата не определена» (восемь замечаний «не проверено»),
 * а `REG.101` объявлял документы не названными реестром — то есть портал винил
 * комплект за то, чего в нём нет.
 *
 * ## Почему сопоставление, а не разбор перечня
 *
 * Разобрать п. 3 на позиции «материал → его документы» нельзя надёжно: запись
 * свободная, скобки вложены, порядок не фиксирован. Здесь и не требуется —
 * вопрос ровно один: назван ли ЭТОТ документ комплекта. На него отвечает та же
 * лестница номера, что и в сверке реестра, и берётся она отсюда же, а не пишется
 * второй раз.
 *
 * Совпадение обязано быть ЕДИНСТВЕННЫМ: ссылка, подошедшая двум документам,
 * не называет ни одного, и ребро по ней было бы выдумкой.
 */
export function documentsNamedInActItem3(
  text: string,
  documents: readonly MatchableDocument[],
): readonly string[] {
  const byNormalized = indexBy(documents, (value) => normalizeDocNo(value).normalized);
  const byFolded = indexBy(documents, (value) => normalizeDocNo(value).folded);
  const named: string[] = [];

  for (const match of text.matchAll(ACT_ITEM3_NUMBER)) {
    const raw = (match[1] ?? '').trim();
    if (raw === '') continue;

    const { normalized, folded } = normalizeDocNo(raw);
    if (normalized.length < MIN_ACT_ITEM3_NUMBER_LENGTH) continue;
    // Ссылка без единой цифры — это проза, дочитанная шаблоном до знака
    // препинания, а не номер документа.
    if (!/\d/u.test(normalized)) continue;

    const core = numericCoreOf(folded);
    const found =
      byNormalized.get(normalized) ??
      byFolded.get(folded) ??
      (core === null ? undefined : numericCoreCandidates(core, documents));

    if (found === undefined || found.length !== 1) continue;
    const documentId = found[0] as string;
    if (!named.includes(documentId)) named.push(documentId);
  }

  return named;
}

/**
 * Сопоставляет строки реестра с документами комплекта.
 *
 * Порядок ступеней фиксирован: точное совпадение → совпадение через фолдинг →
 * числовое ядро → вхождение куска → `missing`. Обратный порядок обесценил бы
 * точное совпадение — при коллизии по `folded` строка получала бы `ambiguous`
 * даже там, где посимвольно совпадает ровно один документ.
 *
 * Функция чистая: ни БД, ни сети. Записью в `registry_rows` занимается job,
 * и он же решает, что делать с `extraDocumentIds` — здесь нет ни ревизии, ни
 * области видимости, а значит нет и способа ошибиться ими.
 */
export function matchRegistryRows(
  rows: readonly ParsedRegistryRow[],
  documents: readonly MatchableDocument[],
): MatchRegistryResult {
  const byNormalized = indexBy(documents, (value) => normalizeDocNo(value).normalized);
  const byFolded = indexBy(documents, (value) => normalizeDocNo(value).folded);
  const typeOf = new Map(documents.map((d) => [d.documentId, d.docTypeCode]));

  const named = new Set<string>();
  const matches: RegistryMatch[] = [];

  for (const row of rows) {
    if (row.docNoNorm === null || row.docNoFolded === null) {
      // Строка без сравнимого номера («б/н», пустая графа). Считать её
      // совпавшей нельзя, а искать по наименованию — нельзя тем более:
      // наименования в реестре обобщены до неразличимости.
      matches.push({
        rowNo: row.rowNo,
        matchState: 'missing',
        matchedDocumentId: null,
        matchScore: null,
        reason: 'строка реестра не содержит сравнимого номера документа',
        candidates: [],
      });
      continue;
    }

    /**
     * Отсев акта из-под строки схемы и наоборот — ДО лестницы, а не внутри неё.
     *
     * Ступеней пять, и отсев на каждой пришлось бы повторить пять раз: одна
     * забытая ступень вернула бы ровно то поведение, ради которого правило
     * написано. Здесь же он действует и на `named` — документ, до которого
     * строке дотягиваться нельзя, не должен считаться ею названным.
     */
    const rowType = rowDocType(row);
    const fits = (ids: readonly string[]): string[] =>
      ids.filter((id) => !contradictsSharedNumber(rowType, typeOf.get(id) ?? null));

    const keys = rowKeys(row);
    const exact = fits(lookup(byNormalized, keys.normalized));
    for (const id of exact) named.add(id);

    if (exact.length === 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'matched',
        matchedDocumentId: exact[0] ?? null,
        matchScore: EXACT_SCORE,
        reason: 'номер документа совпал точно',
        candidates: [],
      });
      continue;
    }

    if (exact.length > 1) {
      // Несколько документов с одним номером — это не «выбери первый».
      // Такое бывает при дублирующем скане одного листа, и решить, какой
      // экземпляр считать приложенным, может только человек.
      matches.push({
        rowNo: row.rowNo,
        matchState: 'ambiguous',
        matchedDocumentId: null,
        matchScore: null,
        reason: `точный номер найден у ${exact.length} документов комплекта`,
        candidates: exact.map((documentId) => ({
          documentId,
          basis: 'doc_no' as const,
          score: EXACT_SCORE,
        })),
      });
      continue;
    }

    const folded = fits(lookup(byFolded, keys.folded));
    for (const id of folded) named.add(id);

    if (folded.length === 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'matched',
        matchedDocumentId: folded[0] ?? null,
        matchScore: FOLDED_SCORE,
        reason: 'номер совпал после фолдинга гомоглифов: точного совпадения нет',
        candidates: [],
      });
      continue;
    }

    if (folded.length > 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'ambiguous',
        matchedDocumentId: null,
        matchScore: null,
        reason: `после фолдинга гомоглифов номеру соответствуют ${folded.length} документов: различить их сверка не может`,
        candidates: folded.map((documentId) => ({
          documentId,
          basis: 'doc_no' as const,
          score: FOLDED_SCORE,
        })),
      });
      continue;
    }

    /**
     * Ступень компактной формы: разделители разошлись, номер — нет (S53).
     *
     * Идёт сразу после фолдинга, потому что сравнивает номер ЦЕЛИКОМ, и до
     * числового ядра, которое сравнивает лишь его часть.
     */
    const compact = fits(compactCandidates(normalizeDocNo(row.docNoRaw ?? '').compact, documents));
    for (const id of compact) named.add(id);

    if (compact.length === 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'matched',
        matchedDocumentId: compact[0] ?? null,
        matchScore: COMPACT_SCORE,
        reason:
          'номер совпал с точностью до разделителей: полного совпадения в комплекте нет, ' +
          'кандидат единственный',
        candidates: [],
      });
      continue;
    }

    if (compact.length > 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'ambiguous',
        matchedDocumentId: null,
        matchScore: null,
        reason: `без разделителей номеру соответствуют ${compact.length} документов: различить их сверка не может`,
        candidates: compact.map((documentId) => ({
          documentId,
          basis: 'doc_no' as const,
          score: COMPACT_SCORE,
        })),
      });
      continue;
    }

    // Ступень числового ядра: буквенная приставка разошлась, цифровая серия —
    // нет. Идёт после фолдинга (тот сравнивает номер целиком и сильнее) и до
    // вхождения куска (то не требует от совпавшей части никакой роли).
    const core = numericCoreOf(row.docNoFolded);
    if (core !== null) {
      const byCore = fits(numericCoreCandidates(core, documents));
      for (const id of byCore) named.add(id);

      if (byCore.length === 1) {
        matches.push({
          rowNo: row.rowNo,
          matchState: 'matched',
          matchedDocumentId: byCore[0] ?? null,
          matchScore: NUMERIC_CORE_SCORE,
          reason: `номер целиком не совпал, но числовое ядро «${core}» совпало у единственного документа комплекта`,
          candidates: [],
        });
        continue;
      }

      if (byCore.length > 1) {
        matches.push({
          rowNo: row.rowNo,
          matchState: 'ambiguous',
          matchedDocumentId: null,
          matchScore: null,
          reason: `числовое ядро «${core}» совпало у ${byCore.length} документов: различить их сверка не может`,
          candidates: byCore.map((documentId) => ({
            documentId,
            basis: 'doc_no' as const,
            score: NUMERIC_CORE_SCORE,
          })),
        });
        continue;
      }
    }

    // Последняя ступень: номер совпал КУСКОМ. Идёт после точной и фолдинга,
    // поэтому обесценить их не может — сюда доходят только строки, которым
    // целиком не соответствует ни один документ комплекта.
    const partial = fits(partialCandidates(normalizeDocNo(row.docNoRaw ?? '').compact, documents));
    for (const id of partial) named.add(id);

    if (partial.length === 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'matched',
        matchedDocumentId: partial[0] ?? null,
        matchScore: PARTIAL_SCORE,
        reason: 'номер совпал частично: полного совпадения в комплекте нет, кандидат единственный',
        candidates: [],
      });
      continue;
    }

    if (partial.length > 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'ambiguous',
        matchedDocumentId: null,
        matchScore: null,
        reason: `номер частично совпал у ${partial.length} документов: выбрать один сверка не вправе`,
        candidates: partial.map((documentId) => ({
          documentId,
          basis: 'doc_no' as const,
          score: PARTIAL_SCORE,
        })),
      });
      continue;
    }

    const nearby = fits(oneCharCandidates(normalizeDocNo(row.docNoRaw ?? '').compact, documents));
    for (const id of nearby) named.add(id);

    if (nearby.length === 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'matched',
        matchedDocumentId: nearby[0] ?? null,
        matchScore: ONE_CHAR_SCORE,
        reason:
          'номер отличается одним знаком: полного совпадения в комплекте нет, кандидат единственный',
        candidates: [],
      });
      continue;
    }

    if (nearby.length > 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'ambiguous',
        matchedDocumentId: null,
        matchScore: null,
        reason: `номер с допуском в один знак совпал у ${nearby.length} документов: выбрать один сверка не вправе`,
        candidates: nearby.map((documentId) => ({
          documentId,
          basis: 'doc_no' as const,
          score: ONE_CHAR_SCORE,
        })),
      });
      continue;
    }

    matches.push({
      rowNo: row.rowNo,
      matchState: 'missing',
      matchedDocumentId: null,
      matchScore: null,
      reason: 'документ с таким номером в комплекте не найден',
      candidates: [],
    });
  }

  // Претенденты неоднозначных строк уже названы: `named` пополняется на каждой
  // ступени до проверки числа кандидатов, поэтому документ, попавший в
  // претенденты, лишним не объявляется.
  //
  // Второй проход: строкам, которым номер не ответил, ищутся КАНДИДАТЫ.
  //
  // Отдельным проходом, а не внутри цикла, потому что кандидат не предлагается
  // из документов, названных по НОМЕРУ, — а полный список названных известен
  // только после того, как все строки прошли лестницу номера.
  //
  // ## Кандидат одной строки не занимает документ у следующей
  //
  // Снимок `named` берётся ДО прохода и по ходу его не растёт. Прежде список
  // пополнялся кандидатами каждой строки, и две одинаковые строки делили
  // документы по принципу «кто первый»: в комплекте `№01_Бл_П` строки 8 и 9
  // («Исполнительная схема обратной засыпки», `ИС №001` и `ИС №002`) описывают
  // две схемы, строка 8 забирала в кандидаты обе, а строке 9 не оставалось
  // ничего — и она получала ошибку «нет в комплекте» про лист, лежащий в
  // комплекте.
  //
  // Занимать документ вправе только СОВПАДЕНИЕ: оно утверждает «это тот самый
  // лист» и строит ребро графа. Кандидат не утверждает ничего, поэтому один и
  // тот же документ законно предлагается нескольким строкам — решает человек, и
  // он обязан видеть все варианты, а не первый по порядку.
  const namedByNumber = new Set(named);
  for (const [index, decision] of matches.entries()) {
    if (decision.matchState !== 'missing') continue;

    const row = rows[index];
    if (row === undefined) continue;

    const candidates = candidatesOf(row, documents, namedByNumber);
    if (candidates.length === 0) continue;

    for (const candidate of candidates) named.add(candidate.documentId);

    const best = candidates[0] as RegistryCandidate;
    matches[index] = {
      ...decision,
      matchState: 'candidate',
      // Документ НЕ выбирается: `candidate` ничего не утверждает, и ребро
      // графа `акт → документ` по нему не строится.
      matchedDocumentId: null,
      matchScore: best.score,
      reason:
        candidates.length === 1
          ? `документа с таким номером в комплекте нет; один документ похож ${basisLabel(best.basis)}`
          : `документа с таким номером в комплекте нет; похожих документов ${candidates.length}`,
      candidates,
    };
  }

  // «Лишний» — не названный НИ ОДНОЙ строкой, включая строки, оставшиеся
  // `ambiguous`, и документы, попавшие в кандидаты: документ, реестром
  // упомянутый, объявлять лишним значило бы обвинить комплект дважды за одно.
  const extraDocumentIds = documents
    .filter((document) => !named.has(document.documentId))
    .map((document) => document.documentId);

  return { rows: matches, extraDocumentIds };
}
