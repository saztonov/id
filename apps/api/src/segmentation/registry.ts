/**
 * Разбор реестра приложений (§8.3).
 *
 * Реестр — перечень ожидаемого состава комплекта, но **не безусловная истина**.
 * Прямая находка корпуса: подрядчик заполняет его вручную и обобщает — в одном
 * комплекте все двенадцать документов о качестве названы просто «Документ о
 * качестве», а «Паспорт качества Арматура №16005» на своём листе называется
 * «СЕРТИФИКАТ КАЧЕСТВА № 16005» (`docs/CORPUS_FINDINGS.md`). Поэтому разбор
 * извлекает НОМЕР как основание сверки, а наименование сохраняет для показа
 * человеку, и любую собственную аномалию реестра (строка без номера позиции,
 * пропуск, дубль) выносит в `warnings`, а не заглаживает молча: каждая из них
 * на S9 станет отдельным finding, и «починенный» разбор эти findings уничтожил
 * бы, не покраснев ни одним тестом.
 *
 * ## Почему разбор постраничный и с состоянием
 *
 * Таблица реестра рвётся по границе страницы, и продолжение приходит БЕЗ шапки:
 * в АОСР №336 позиции 1–17 лежат на одной странице, 18–29 — на следующей.
 * Разбор каждой страницы по отдельности дал бы 17 строк вместо 29 — то есть
 * двенадцать документов комплекта оказались бы «лишними» (`REG.extra`), а
 * двенадцать строк реестра просто исчезли бы. Поэтому у разбора есть состояние:
 * реестр ОТКРЫВАЕТСЯ канонической шапкой и продолжается на следующие страницы,
 * пока они дают строки.
 *
 * ## Чего разбор намеренно не делает
 *
 * Не назначает номера позиций счётчиком. Пропуск и повтор номера — это ФАКТ
 * реестра: подрядчик мог удалить строку или продублировать позицию, и оба
 * случая обязан увидеть человек. Счётчик превратил бы дефект оформления в
 * ровный список, где ничего не видно.
 */

import { normalizeDocNo } from '@id/contracts';
import type { ParsedRegistryRow } from './types.js';

/** Страница на входе разбора. Тексты — `page_text_versions.text_md`. */
export interface RegistryPageInput {
  readonly sourcePageId: string;
  /** Версия текста; `null` — текста нет, доказательство построить не на чем. */
  readonly pageTextVersionId: string | null;
  readonly text: string;
}

export interface RegistryParseInput {
  readonly pages: readonly RegistryPageInput[];
}

export interface RegistryParseResult {
  readonly rows: readonly ParsedRegistryRow[];
  /** Аномалии самого реестра и отброшенные фрагменты. Не ошибки разбора. */
  readonly warnings: readonly string[];
}

// =====================================================================
// Разметка markdown-таблиц
// =====================================================================

/** Строка таблицы: `| ячейка | ячейка |`. */
const TABLE_LINE = /^\s*\|(.*)\|\s*$/u;

/** Ячейка разделителя шапки: `---`, `:---:`. */
const SEPARATOR_CELL = /^:?-{1,}:?$/u;

/** Строка целиком в полужирном начертании — так OCR печатает заголовки разделов. */
const BOLD_LINE = /^\s*\*\*(.+?)\*\*\s*$/u;

/** Номер позиции реестра: до четырёх цифр и ничего кроме. */
const POSITION_NO = /^\d{1,4}$/u;

interface MdTable {
  /** `null` — разделитель шапки стоит первым либо отсутствует вовсе. */
  readonly header: readonly string[] | null;
  readonly rows: readonly (readonly string[])[];
}

type Block =
  | { readonly kind: 'table'; readonly table: MdTable }
  | { readonly kind: 'bold'; readonly text: string };

function tableCells(line: string | undefined): string[] | null {
  if (line === undefined) return null;
  const match = TABLE_LINE.exec(line);
  if (match === null) return null;

  return (match[1] ?? '').split('|').map((cell) => cell.replace(/\*\*/gu, '').trim());
}

function isSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell));
}

/**
 * Раскладывает текст страницы на таблицы и полужирные строки.
 *
 * Разделитель шапки не обязателен для РАЗБОРА таблицы: без него получается
 * `header: null`, и первая строка остаётся обычной строкой данных. Это ровно
 * то, что описано, и не больше: докстринг первой редакции утверждал, что
 * страница реестра при потерянном разделителе не теряется, — и это было
 * неверно. Реестр открывается КАНОНИЧЕСКОЙ ШАПКОЙ (`isCanonicalHeader`), а
 * шапки без разделителя здесь не возникает вовсе, поэтому реестр без
 * строки-разделителя не открывался и терялся целиком, молча.
 *
 * Восстановление этого случая живёт не здесь, а в `parseAnnexRegistry`
 * (`recoverHeaderlessTable`): решение «первая строка данных на самом деле
 * шапка» имеет смысл только там, где известно, что мы ищем реестр. Здесь оно
 * означало бы, что любая безголовая таблица теряет первую строку.
 */
function scanBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/u);
  const blocks: Block[] = [];

  let index = 0;
  while (index < lines.length) {
    const cells = tableCells(lines[index]);
    if (cells === null) {
      const bold = BOLD_LINE.exec(lines[index] ?? '');
      if (bold !== null) blocks.push({ kind: 'bold', text: (bold[1] ?? '').trim() });
      index += 1;
      continue;
    }

    const run: string[][] = [];
    while (index < lines.length) {
      const next = tableCells(lines[index]);
      if (next === null) break;
      run.push(next);
      index += 1;
    }

    blocks.push({ kind: 'table', table: toTable(run) });
  }

  return blocks;
}

function toTable(run: readonly string[][]): MdTable {
  const first = run[0];
  const second = run[1];

  if (first !== undefined && isSeparator(first)) {
    return { header: null, rows: run.slice(1) };
  }
  if (first !== undefined && second !== undefined && isSeparator(second)) {
    return { header: first, rows: run.slice(2) };
  }

  return { header: null, rows: [...run] };
}

// =====================================================================
// Распознавание реестра
// =====================================================================

/**
 * Каноническая шапка реестра приложений.
 *
 * Открывать реестр по заголовку «Реестр приложений» нельзя: эта строка есть в
 * печатной форме РД-11-02 самого акта («Приложения: Реестр приложений №1»), и
 * ровно она уже давала ложный тип `annex_registry` на вторых страницах актов
 * (`docs/CORPUS_FINDINGS.md`, причина 3). Шапка таблицы — признак структурный,
 * а не текстовый, и на странице акта её нет.
 */
function isCanonicalHeader(header: readonly string[] | null): boolean {
  if (header === null || header.length < 3) return false;

  const first = (header[0] ?? '').toLowerCase();
  const second = (header[1] ?? '').toLowerCase();

  return /п\s*\/\s*п/u.test(first) && second.includes('наименован');
}

/** Шапка продолжения: OCR печатает её пустой (`| | | | |`). */
function isContinuationHeader(header: readonly string[] | null, columns: number): boolean {
  if (header === null) return true;
  if (header.length !== columns) return false;

  return header.every((cell) => cell === '') || isCanonicalHeader(header);
}

/**
 * Похожа ли таблица на продолжение реестра.
 *
 * Требуется совпадение числа граф и хотя бы одна строка с номером позиции.
 * Без этого продолжение реестра было бы неотличимо от таблицы показателей в
 * паспорте («Норма по НД / Фактически»), которая идёт следом на тех же
 * страницах поставки.
 */
function looksLikeRegistryTable(table: MdTable, columns: number): boolean {
  if (!isContinuationHeader(table.header, columns)) return false;

  return table.rows.some((row) => row.length === columns && POSITION_NO.test(row[0] ?? ''));
}

/**
 * Восстановление шапки, у которой OCR потерял строку-разделитель.
 *
 * Синтаксис markdown требует разделителя после первой строки таблицы, поэтому
 * его отсутствие — след распознавания, а не оформления. Без восстановления
 * реестр не открывался ВОВСЕ: 29 строк превращались в ноль, `doc.match_registry`
 * докладывал «реестра в поставке нет: сверять нечего», а на S9 это стало бы
 * «комплект без реестра» вместо «реестр не разобран».
 *
 * Признак узкий намеренно: первая строка обязана быть канонической шапкой
 * реестра. Открывать реестр по любой безголовой таблице значило бы вернуть тот
 * же дефект с другой стороны — таблица показателей паспорта («Норма по НД /
 * Фактически») идёт на тех же страницах поставки.
 */
function recoverHeaderlessTable(table: MdTable): MdTable | null {
  if (table.header !== null) return null;

  const first = table.rows[0];
  if (first === undefined || !isCanonicalHeader(first)) return null;

  return { header: first, rows: table.rows.slice(1) };
}

/**
 * Похожа ли таблица на реестр ПО СОДЕРЖИМОМУ, а не по шапке.
 *
 * Нужна ровно для одного: сделать неудачу громкой. Таблица с колонкой
 * порядковых номеров и наименованиями, не открывшая реестр, — это либо реестр
 * с неузнанной шапкой, либо чужая таблица; различить их разбор не может, а
 * промолчать не имеет права. Порог в две строки отсекает случайное совпадение
 * на одной строке.
 */
function looksLikeRegistryByContent(table: MdTable): boolean {
  if (table.header !== null) return false;

  const numbered = table.rows.filter(
    (row) => row.length >= 3 && POSITION_NO.test(row[0] ?? '') && (row[1] ?? '') !== '',
  );

  return numbered.length >= 2 && !numbered.every((row) => isColumnNumbering(row));
}

/**
 * Печатная нумерация граф бланка: `| 1 | 2 | 3 | 4 |`.
 *
 * Это часть формы, а не строка реестра. Отличается от настоящей позиции №1 тем,
 * что КАЖДАЯ ячейка равна своему порядковому номеру; у настоящей строки во
 * второй графе стоит наименование документа.
 */
function isColumnNumbering(cells: readonly string[]): boolean {
  return cells.every((cell, index) => cell === String(index + 1));
}

// =====================================================================
// Разбор ячеек
// =====================================================================

const DATE_PART = String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})`;

/**
 * Интервал действия: «с DD.MM.YYYY по DD.MM.YYYY».
 *
 * `[сc]` — обе буквы: в скане предлог «с» кириллический, но OCR регулярно
 * отдаёт латинскую `c`. Точки с запятой между словами допускаются: OCR
 * вставляет их на месте переносов строки внутри ячейки.
 */
const VALIDITY_RANGE = new RegExp(
  String.raw`(?:^|[\s;,(])[сc]\s*[;,]?\s*${DATE_PART}\s*[;,]?\s*по\s*[;,]?\s*${DATE_PART}`,
  'iu',
);

/** Разовая дата: «от DD.MM.YYYY», в корпусе встречается и как «от; DD.MM.YYYY». */
const ISSUED_DATE = new RegExp(String.raw`(?:^|[\s;,(])от\s*[;,]?\s*${DATE_PART}`, 'iu');

/** «б/н» — не отсутствие номера, а его законная форма «без номера». */
const NO_NUMBER = /^б\s*[/\\.]?\s*н\.?$/iu;

interface CellNumber {
  readonly docNoRaw: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly issuedAt: string | null;
  /** Сравним ли номер: у «б/н» — нет. */
  readonly comparable: boolean;
}

function toIsoDate(
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
function cleanDocNo(value: string): string {
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
function parseNumberCell(cell: string): CellNumber {
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

// =====================================================================
// Разбор реестра
// =====================================================================

/**
 * Собирает строки реестра приложений со всех страниц поставки.
 *
 * Комплект без реестра — штатный случай (в корпусе такой есть): результат
 * `rows: []` и никаких исключений. Отсутствие реестра само по себе может стать
 * замечанием на S9 (`AOSR.P3` требует ссылку на реестр при более чем пяти
 * документах), но решает это правило, а не разбор.
 */
export function parseAnnexRegistry(input: RegistryParseInput): RegistryParseResult {
  const rows: ParsedRegistryRow[] = [];
  const warnings: string[] = [];

  let open = false;
  let columns = 0;
  let sectionTitle: string | null = null;

  for (const page of input.pages) {
    let accepted = 0;

    for (const block of scanBlocks(page.text)) {
      if (block.kind === 'bold') {
        // Заголовки разделов считаются только внутри реестра: до его шапки на
        // той же странице стоят «Объект: …» и «Реестр приложений №1 к акту …»,
        // которые разделами не являются.
        if (open) sectionTitle = block.text;
        continue;
      }

      let table = block.table;

      if (!open) {
        if (!isCanonicalHeader(table.header)) {
          const recovered = recoverHeaderlessTable(table);
          if (recovered === null) {
            // Тихая потеря запрещена. Если таблица похожа на реестр по
            // содержимому, но шапка не распозналась, об этом обязан узнать
            // человек — с указанием страницы.
            if (looksLikeRegistryByContent(table)) {
              warnings.push(
                `страница ${page.sourcePageId}: таблица похожа на реестр приложений ` +
                  '(колонка номеров позиций и наименования), но шапка не распознана — ' +
                  'строки не разобраны',
              );
            }
            continue;
          }
          warnings.push(
            `страница ${page.sourcePageId}: у шапки реестра нет строки-разделителя ` +
              '(след распознавания) — разбор восстановлен по содержимому первой строки',
          );
          table = recovered;
        }
        open = true;
        columns = (table.header ?? []).length;
        sectionTitle = null;
      } else if (!looksLikeRegistryTable(table, columns)) {
        continue;
      }

      accepted += 1;
      collectRows(table, columns, sectionTitle, page, rows, warnings);
    }

    // Страница без единой строки закрывает реестр. Иначе состояние «реестр
    // открыт» дожило бы до конца поставки и захватило чужие таблицы. Закрытие
    // объявляется вслух: остаток реестра, если он был, дальше не ищется, и
    // «реестр кончился» обязано отличаться от «продолжение потеряно».
    if (open && accepted === 0) {
      open = false;
      warnings.push(
        `страница ${page.sourcePageId}: ни одной строки реестра не найдено — реестр ` +
          'считается закрытым, продолжение на последующих страницах не ищется',
      );
    }
  }

  warnings.push(...auditNumbering(rows));

  return { rows, warnings };
}

function collectRows(
  table: MdTable,
  columns: number,
  sectionTitle: string | null,
  page: RegistryPageInput,
  rows: ParsedRegistryRow[],
  warnings: string[],
): void {
  for (const cells of table.rows) {
    if (cells.every((cell) => cell === '')) continue;

    if (cells.length !== columns) {
      warnings.push(
        `страница ${page.sourcePageId}: строка реестра из ${cells.length} граф вместо ${columns} отброшена`,
      );
      continue;
    }
    if (isColumnNumbering(cells)) continue;

    const rowNoRaw = cells[0] ?? '';
    if (!POSITION_NO.test(rowNoRaw)) {
      // Хвост переноса ячейки: `| | A240C, д.8 | | |`. Это НЕ строка реестра, и
      // нумерацию она не сдвигает — иначе позиция 18 стала бы позицией 19, и
      // сверка разъехалась бы на всём продолжении таблицы.
      warnings.push(
        `страница ${page.sourcePageId}: строка без номера позиции отброшена как хвост переноса ячейки` +
          (cells[1] === '' ? '' : ` («${cells[1] ?? ''}»)`),
      );
      continue;
    }

    const number = parseNumberCell(cells[2] ?? '');
    const rowNo = Number(rowNoRaw);
    if (number.docNoRaw === null) {
      warnings.push(`строка ${rowNo}: номер документа не указан — сверка по номеру невозможна`);
    }

    const normalized =
      number.comparable && number.docNoRaw !== null ? normalizeDocNo(number.docNoRaw) : null;

    rows.push({
      rowNo,
      sectionTitle,
      docNameRaw: cells[1] ?? '',
      docNoRaw: number.docNoRaw,
      orgRaw: cells[3] === undefined || cells[3] === '' ? null : cells[3],
      docNoNorm: normalized?.normalized ?? null,
      docNoFolded: normalized?.folded ?? null,
      validFrom: number.validFrom,
      validTo: number.validTo,
      issuedAt: number.issuedAt,
    });
  }
}

/**
 * Аномалии нумерации — по разделам, а не по реестру целиком.
 *
 * Нумерация в каждом разделе своя и начинается заново: в корпусе есть реестр
 * из трёх разделов с позициями 1–3, 1–5 и 1–15. Сквозная проверка объявила бы
 * дублями двенадцать нормальных строк, а такое предупреждение инженер
 * перестаёт читать вместе со всеми остальными (§9.1).
 */
function auditNumbering(rows: readonly ParsedRegistryRow[]): string[] {
  const warnings: string[] = [];
  const bySection = new Map<string, number[]>();

  for (const row of rows) {
    const key = row.sectionTitle ?? '';
    const list = bySection.get(key);
    if (list === undefined) bySection.set(key, [row.rowNo]);
    else list.push(row.rowNo);
  }

  for (const [section, numbers] of bySection) {
    const label = section === '' ? 'реестр' : `раздел «${section}»`;
    const seen = new Set<number>();

    for (const number of numbers) {
      if (seen.has(number)) warnings.push(`${label}: номер позиции ${number} встречается повторно`);
      seen.add(number);
    }

    const sorted = [...seen].sort((a, b) => a - b);
    const first = sorted[0];
    if (first === undefined) continue;

    for (let expected = first; expected <= (sorted[sorted.length - 1] ?? first); expected += 1) {
      if (!seen.has(expected)) warnings.push(`${label}: пропущен номер позиции ${expected}`);
    }
  }

  return warnings;
}
