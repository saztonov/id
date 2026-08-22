/**
 * Разбор ячеек табличных документов ИД (§8.3).
 *
 * Вынесено из `registry.ts` без единого изменения поведения. Здесь накоплены
 * СЛЕДЫ РАСПОЗНАВАНИЯ, и в этом вся ценность файла: латинская `c` вместо
 * кириллической в предлоге «с», точка с запятой на месте переноса строки внутри
 * ячейки, «от;» вместо «от», «б/н» как законная форма номера, невозможная дата
 * «31.04.2026». Каждый из этих случаев стоил чтения настоящего корпуса, и
 * второй разбор (опись передачи, `transfer-registry.ts`) обязан получить их
 * готовыми, а не открывать заново по одному на каждой новой папке.
 */

/** Числовая дата `DD.MM.YYYY`. Открыта наружу: из неё собираются частные шаблоны. */
export const DATE_PART = String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})`;

/**
 * Интервал действия: «с DD.MM.YYYY по DD.MM.YYYY».
 *
 * `[сc]` — обе буквы: в скане предлог «с» кириллический, но OCR регулярно
 * отдаёт латинскую `c`. Точки с запятой между словами допускаются: OCR
 * вставляет их на месте переносов строки внутри ячейки.
 */
export const VALIDITY_RANGE = new RegExp(
  String.raw`(?:^|[\s;,(])[сc]\s*[;,]?\s*${DATE_PART}\s*[;,]?\s*по\s*[;,]?\s*${DATE_PART}`,
  'iu',
);

/** Разовая дата: «от DD.MM.YYYY», в корпусе встречается и как «от; DD.MM.YYYY». */
export const ISSUED_DATE = new RegExp(String.raw`(?:^|[\s;,(])от\s*[;,]?\s*${DATE_PART}`, 'iu');

/** «б/н» — не отсутствие номера, а его законная форма «без номера». */
const NO_NUMBER = /^б\s*[/\\.]?\s*н\.?$/iu;

export interface CellNumber {
  readonly docNoRaw: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly issuedAt: string | null;
  /** Сравним ли номер: у «б/н» — нет. */
  readonly comparable: boolean;
}

export function toIsoDate(
  day: string | undefined,
  month: string | undefined,
  year: string | undefined,
): string | null {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return null;

  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }

  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Снимает «№», обрамляющую пунктуацию и схлопывает многократные пробелы. */
export function cleanDocNo(value: string): string {
  return value
    .replace(/^№+\s*/u, '')
    .replace(/^[\s;,:]+/u, '')
    .replace(/[\s;,:]+$/u, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/**
 * Разбирает графу «№ чертежа, акта, разрешения…».
 *
 * В одной ячейке лежат и номер, и срок: «№RU.MCC.240.445.38406 с 01.10.2024 по
 * 01.10.2028» либо «№2410/48 от 14.10.2024». Тип даты определяется формой
 * записи, и это не косметика: §9.2 выбирает релевантную дату по типу связи, а
 * интервал и разовая дата дают РАЗНЫЕ правила (`DATE.300` против `DATE.310`).
 */
export function parseNumberCell(cell: string): CellNumber {
  let head = cell;
  let validFrom: string | null = null;
  let validTo: string | null = null;
  let issuedAt: string | null = null;

  const range = VALIDITY_RANGE.exec(cell);
  if (range !== null) {
    validFrom = toIsoDate(range[1], range[2], range[3]);
    validTo = toIsoDate(range[4], range[5], range[6]);
    head = cell.slice(0, range.index);
  } else {
    const issued = ISSUED_DATE.exec(cell);
    if (issued !== null) {
      issuedAt = toIsoDate(issued[1], issued[2], issued[3]);
      head = cell.slice(0, issued.index);
    }
  }

  const cleaned = cleanDocNo(head);
  if (cleaned === '') {
    return { docNoRaw: null, validFrom, validTo, issuedAt, comparable: false };
  }
  if (NO_NUMBER.test(cleaned)) {
    // «б/н» сравнивать нельзя. Два разных документа «без номера» совпали бы по
    // такому «номеру» и дали бы ложный `matched` — то есть отчёт утверждал бы,
    // что строка реестра подтверждена документом, который к ней не относится.
    return { docNoRaw: 'б/н', validFrom, validTo, issuedAt, comparable: false };
  }

  return { docNoRaw: cleaned, validFrom, validTo, issuedAt, comparable: true };
}

/**
 * Нормализация наименования документа и организации.
 *
 * OCR вставляет `;` на месте переносов строки внутри ячейки: «Сертификат
 * качества; Арматура А240С, д.8». Для сравнения и поиска они схлопываются в
 * пробел, но `docNameRaw` и `orgRaw` хранят исходный вид — человек на экране
 * должен видеть реестр таким, каков он есть, включая следы распознавания.
 */
export function normalizeRegistryName(value: string): string {
  return value.replace(/;+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export interface CellDates {
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly issuedAt: string | null;
}

const ANY_DATE = new RegExp(DATE_PART, 'gu');

/** Есть ли в ячейке хоть что-то похожее на дату. Без флага `g` — для `test`. */
export const HAS_DATE = new RegExp(DATE_PART, 'u');

/**
 * Разбирает отдельную графу «Дата».
 *
 * В отличие от графы номера, здесь дата бывает и голой («31.12.2024 г.»), без
 * «от» и «с … по». Две даты в одной ячейке читаются как интервал действия.
 * Невозможная дата («31.04.2026») даёт null — решение о предупреждении
 * принимает вызывающий, у него есть номер строки.
 */
export function parseDateCell(cell: string): CellDates {
  const range = VALIDITY_RANGE.exec(cell);
  if (range !== null) {
    return {
      validFrom: toIsoDate(range[1], range[2], range[3]),
      validTo: toIsoDate(range[4], range[5], range[6]),
      issuedAt: null,
    };
  }
  const found = [...cell.matchAll(ANY_DATE)];
  if (found.length >= 2) {
    const [first, second] = found;
    return {
      validFrom: toIsoDate(first?.[1], first?.[2], first?.[3]),
      validTo: toIsoDate(second?.[1], second?.[2], second?.[3]),
      issuedAt: null,
    };
  }
  const single = found[0];
  return {
    validFrom: null,
    validTo: null,
    issuedAt: single === undefined ? null : toIsoDate(single[1], single[2], single[3]),
  };
}
