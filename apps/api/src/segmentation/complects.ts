/**
 * Нарезка папки на КОМПЛЕКТЫ: акт со своими приложениями (S44).
 *
 * ## Что решает этот файл
 *
 * Загружают в портал не комплект одной работы, а папку ИД. Боевой файл на 220
 * страниц — это опись передачи и двенадцать актов освидетельствования, у
 * каждого свой перечень приложений, свои паспорта, сертификаты, заключения и
 * исполнительная схема. Пока портал считал такую папку одним комплектом,
 * ломалось всё, что опирается на границу акта: сверка перечня приложений
 * искала документ по ВСЕЙ папке и на двенадцати повторах одного сертификата
 * отвечала «сопоставлено неоднозначно» (72 строки из 138), а граф связей
 * построил семь рёбер «акт → документ качества» вместо сотни с лишним.
 *
 * ## Правило границы — «ближайший предшествующий акт»
 *
 * Ровно то же, которым `graph.build` уже связывает акт с его перечнем
 * приложений. Второго правила здесь заводить нельзя: разойдясь, они дали бы
 * перечень в одном комплекте, а его строки — в другом.
 *
 * Документы ДО первого акта комплекту не принадлежат, и это законное
 * состояние, а не потеря: опись передачи и титульные листы лежат в папке
 * сами по себе. Папка вовсе без актов — тоже законное состояние: так выглядит
 * отдельно загруженная опись, и проверки по ней работают как прежде.
 *
 * ## Почему порядок документов, а не страниц
 *
 * Порядок документов уже выражает порядок страниц: декодер нумерует их
 * `ordinal` в том же обходе, в котором читает комплект. Считать границы по
 * страницам значило бы завести второй источник того же факта.
 */
import { isAnalysisAnchor } from '@id/doc-types';

/** Документ в том виде, в каком нарезка его читает: нужен только вид и порядок. */
export interface ComplectCandidate {
  readonly ordinal: number;
  readonly docTypeCode: string | null;
}

/** Один комплект: порядковый номер в папке и документы, которые в него вошли. */
export interface ComplectGroup {
  /** Номер комплекта в папке, с единицы: `complects.ordinal`. */
  readonly ordinal: number;
  /** Порядковые номера документов комплекта; первый — сам акт. */
  readonly documentOrdinals: readonly number[];
}

export interface ComplectPlan {
  readonly groups: readonly ComplectGroup[];
  /** Документы вне комплектов: опись, титулы, всё до первого акта. */
  readonly outside: readonly number[];
}

/**
 * Разложить документы папки по комплектам.
 *
 * Вход не обязан быть отсортирован: порядок задаёт `ordinal`, и полагаться на
 * порядок массива значило бы зависеть от того, как вызывающий его собрал.
 */
export function planComplects(documents: readonly ComplectCandidate[]): ComplectPlan {
  const ordered = [...documents].sort((a, b) => a.ordinal - b.ordinal);

  const groups: { ordinal: number; documentOrdinals: number[] }[] = [];
  const outside: number[] = [];

  for (const document of ordered) {
    if (isAnalysisAnchor(document.docTypeCode)) {
      groups.push({ ordinal: groups.length + 1, documentOrdinals: [document.ordinal] });
      continue;
    }
    const current = groups[groups.length - 1];
    if (current === undefined) {
      outside.push(document.ordinal);
      continue;
    }
    current.documentOrdinals.push(document.ordinal);
  }

  return { groups, outside };
}
