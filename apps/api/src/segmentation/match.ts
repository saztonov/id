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
 * Точное совпадение → фолдинг гомоглифов → частичное вхождение номера. Порядок
 * фиксирован, и каждая следующая ступень видит только те строки, которым не
 * ответила предыдущая: иначе кусок номера конкурировал бы с точным совпадением.
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
export type CandidateBasis = 'doc_type' | 'issued_at' | 'doc_type_and_issued_at';

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
   * Документы, похожие на строку, но НЕ подтверждённые номером.
   *
   * Заполняется только у `candidate`: у `matched` документ назван прямо, у
   * `ambiguous` кандидаты различить нельзя, у `missing` их нет вовсе.
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
 * Счёт частичного совпадения номера.
 *
 * Заметно ниже фолдинга: совпал не номер, а его КУСОК. Так бывает штатно —
 * реестр пишет «К14/ДК2-СЦ4», а в штампе номер напечатан с приставкой раздела
 * либо наоборот, — но утверждать по куску «это тот самый документ» нельзя, и
 * §9.1 обязан видеть по счёту, что решение требует глаз человека.
 */
const PARTIAL_SCORE = 0.6;

/**
 * Короче этого номера в частичном сравнении не участвуют.
 *
 * «1», «7», «А» входят подстрокой в половину номеров комплекта, и разрешить их
 * значило бы выдавать случайные пары за находки. Ступень существует ради
 * длинных шифров, где потерян префикс или хвост.
 */
const MIN_PARTIAL_LENGTH = 4;

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
function rowDocType(row: ParsedRegistryRow): string | null {
  const name = row.docNameRaw.trim();
  if (name === '') return null;

  return resolveDocType(matchDocTypes(name, DOC_TYPES, { headingLines: 1 }), DOC_TYPES).code;
}

/** Как основание кандидата читается человеком в объяснении решения. */
function basisLabel(basis: CandidateBasis): string {
  switch (basis) {
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
function rowKeys(row: ParsedRegistryRow): {
  readonly normalized: readonly string[];
  readonly folded: readonly string[];
} {
  const normalized = [row.docNoNorm as string];
  const folded = [row.docNoFolded as string];

  const inner = row.docNoRaw === null ? null : INNER_NUMBER_SIGN.exec(row.docNoRaw);
  const tail = inner?.[1]?.trim() ?? '';
  if (tail !== '') {
    const alias = normalizeDocNo(tail);
    if (alias.normalized !== '' && !normalized.includes(alias.normalized)) {
      normalized.push(alias.normalized);
      folded.push(alias.folded);
    }
  }

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
 * Документы, чей номер содержит номер строки (или содержится в нём).
 *
 * Сравнение идёт по фолдингу: ступень и без того нестрогая, а гомоглифы к её
 * вопросу отношения не имеют.
 */
function partialCandidates(
  rowFolded: string,
  documents: readonly MatchableDocument[],
): readonly string[] {
  if (rowFolded.length < MIN_PARTIAL_LENGTH) return [];

  const found: string[] = [];
  for (const document of documents) {
    const hit = document.numbers.some((number) => {
      const key = normalizeDocNo(number).folded;
      if (key.length < MIN_PARTIAL_LENGTH) return false;
      return key.includes(rowFolded) || rowFolded.includes(key);
    });
    if (hit && !found.includes(document.documentId)) found.push(document.documentId);
  }
  return found;
}

/**
 * Сопоставляет строки реестра с документами комплекта.
 *
 * Порядок ступеней фиксирован: точное совпадение → совпадение через фолдинг →
 * `missing`. Обратный порядок обесценил бы точное совпадение — при коллизии по
 * `folded` строка получала бы `ambiguous` даже там, где посимвольно совпадает
 * ровно один документ.
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

    const keys = rowKeys(row);
    const exact = lookup(byNormalized, keys.normalized);
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
        candidates: [],
      });
      continue;
    }

    const folded = lookup(byFolded, keys.folded);
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
        candidates: [],
      });
      continue;
    }

    // Последняя ступень: номер совпал КУСКОМ. Идёт после точной и фолдинга,
    // поэтому обесценить их не может — сюда доходят только строки, которым
    // целиком не соответствует ни один документ комплекта.
    const partial = partialCandidates(row.docNoFolded, documents);
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
        candidates: [],
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

  // Второй проход: строкам, которым номер не ответил, ищутся КАНДИДАТЫ.
  //
  // Отдельным проходом, а не внутри цикла, потому что кандидат не предлагается
  // из документов, уже названных другой строкой, — а полный список названных
  // известен только после того, как все строки прошли лестницу номера.
  for (const [index, decision] of matches.entries()) {
    if (decision.matchState !== 'missing') continue;

    const row = rows[index];
    if (row === undefined) continue;

    const candidates = candidatesOf(row, documents, named);
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
