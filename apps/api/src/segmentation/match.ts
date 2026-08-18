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
 */

import { normalizeDocNo } from '@id/contracts';
import type { ParsedRegistryRow } from './types.js';

/** Документ комплекта в том виде, в каком он участвует в сверке. */
export interface MatchableDocument {
  readonly documentId: string;
  /**
   * Вид документа. В решении НЕ участвует — присутствует ради объяснения и
   * будущей аналитики расхождений «реестр назвал так, документ назвался так».
   */
  readonly docTypeCode: string | null;
  /** Номер документа из реквизита `number`; `null` — номер не извлечён. */
  readonly number: string | null;
  readonly title: string | null;
}

export interface RegistryMatch {
  readonly rowNo: number;
  readonly matchState: 'matched' | 'missing' | 'extra' | 'ambiguous';
  readonly matchedDocumentId: string | null;
  /** `null` там, где счёта нет: `missing` и `ambiguous` не выбирают документ. */
  readonly matchScore: number | null;
  readonly reason: string;
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

/** Индекс документов по одной из форм номера. */
function indexBy(
  documents: readonly MatchableDocument[],
  form: (value: string) => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const document of documents) {
    if (document.number === null) continue;
    const key = form(document.number);
    if (key === '') continue;

    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [document.documentId]);
    else bucket.push(document.documentId);
  }

  return index;
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
      });
      continue;
    }

    const exact = byNormalized.get(row.docNoNorm) ?? [];
    for (const id of exact) named.add(id);

    if (exact.length === 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'matched',
        matchedDocumentId: exact[0] ?? null,
        matchScore: EXACT_SCORE,
        reason: 'номер документа совпал точно',
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
      });
      continue;
    }

    const folded = byFolded.get(row.docNoFolded) ?? [];
    for (const id of folded) named.add(id);

    if (folded.length === 1) {
      matches.push({
        rowNo: row.rowNo,
        matchState: 'matched',
        matchedDocumentId: folded[0] ?? null,
        matchScore: FOLDED_SCORE,
        reason: 'номер совпал после фолдинга гомоглифов: точного совпадения нет',
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
      });
      continue;
    }

    matches.push({
      rowNo: row.rowNo,
      matchState: 'missing',
      matchedDocumentId: null,
      matchScore: null,
      reason: 'документ с таким номером в комплекте не найден',
    });
  }

  // «Лишний» — не названный НИ ОДНОЙ строкой, включая строки, оставшиеся
  // `ambiguous`: документ, попавший в кандидаты, реестром упомянут, и
  // объявлять его лишним значило бы обвинить комплект дважды за одно.
  const extraDocumentIds = documents
    .filter((document) => !named.has(document.documentId))
    .map((document) => document.documentId);

  return { rows: matches, extraDocumentIds };
}
