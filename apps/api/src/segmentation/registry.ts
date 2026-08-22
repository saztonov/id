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
import { scanBlocks, type MdTable } from './md-table.js';
import { HAS_DATE, parseDateCell, parseNumberCell } from './registry-cells.js';
import type { ParsedRegistryRow } from './types.js';

/**
 * Нормализация наименования переехала в `registry-cells.ts` вместе с остальным
 * разбором ячеек, но остаётся частью поверхности ЭТОГО модуля: на неё ссылается
 * и баррель `@id/api`, и тест разбора. Реэкспорт вместо переноса импорта у
 * читателей — потому что вынос ядра обязан быть доказуемо безобидным, а правка
 * чужих импортов делает его правкой чужого кода.
 */
export { normalizeRegistryName } from './registry-cells.js';

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

/** Номер позиции реестра: до четырёх цифр и ничего кроме. */
const POSITION_NO = /^\d{1,4}$/u;

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
// Раскладка граф
// =====================================================================

/** Где в строке реестра наименование, номер, организация и дата. */
interface RegistryColumns {
  readonly name: number;
  readonly number: number;
  readonly org: number | null;
  readonly date: number | null;
}

/** Историческая раскладка корпуса: №пп | наименование | номер | организация. */
const POSITIONAL_COLUMNS: RegistryColumns = { name: 1, number: 2, org: 3, date: null };

/**
 * Раскладка граф по ЗАГОЛОВКУ, а не по позиции.
 *
 * Формы реестров расходятся: канонический реестр приложений корпуса держит
 * номер в третьей графе и организацию в четвёртой, а реестры temp/MD/new
 * («№ п/п | Наименование материала | Наименование документа | Номер документа |
 * Дата») сдвигают номер в четвёртую графу, и позиционный разбор читал
 * НАЗВАНИЕ документа как его номер. Шапка при этом есть всегда — реестр
 * открывается только канонической шапкой, — и она же называет графы.
 *
 * Наименованием документа считается графа со словами «наименование» и
 * «документ» (в реестре материалов первая «наименование…» — это материал, а
 * не документ). Из даты исключается графа номера: в корпусе её заголовок —
 * «№ чертежа, акта, разрешения и дата…», и дата оттуда разбирается вместе с
 * номером (`parseNumberCell`).
 */
function mapColumns(header: readonly string[] | null): RegistryColumns {
  if (header === null) return POSITIONAL_COLUMNS;
  const lower = header.map((cell) => cell.toLowerCase());

  const nameDoc = lower.findIndex((c) => c.includes('наименован') && c.includes('документ'));
  const name = nameDoc >= 0 ? nameDoc : lower.findIndex((c) => c.includes('наименован'));
  const number = lower.findIndex(
    (c, i) => i > 0 && i !== name && (c.includes('номер') || c.includes('№')),
  );
  const org = lower.findIndex((c) => c.includes('организац'));
  const date = lower.findIndex(
    (c, i) => i !== number && i !== name && (c.includes('дата') || c.includes('срок')),
  );

  return {
    name: name >= 0 ? name : POSITIONAL_COLUMNS.name,
    number: number >= 0 ? number : POSITIONAL_COLUMNS.number,
    org: org >= 0 ? org : number >= 0 ? null : POSITIONAL_COLUMNS.org,
    date: date >= 0 ? date : null,
  };
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
  let layout: RegistryColumns = POSITIONAL_COLUMNS;
  let sectionTitle: string | null = null;
  const continuationRows = new Set<number>();

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
        layout = mapColumns(table.header);
        sectionTitle = null;
      } else if (!looksLikeRegistryTable(table, columns)) {
        continue;
      }

      accepted += 1;
      collectRows(table, columns, layout, sectionTitle, page, rows, warnings, continuationRows);
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

  warnings.push(...auditNumbering(rows, continuationRows));

  return { rows, warnings };
}

function collectRows(
  table: MdTable,
  columns: number,
  layout: RegistryColumns,
  sectionTitle: string | null,
  page: RegistryPageInput,
  rows: ParsedRegistryRow[],
  warnings: string[],
  continuationRows: Set<number>,
): void {
  const buildRow = (cells: readonly string[], rowNo: number): ParsedRegistryRow => {
    const number = parseNumberCell(cells[layout.number] ?? '');
    const dateCellRaw = layout.date === null ? '' : (cells[layout.date] ?? '');
    const dates = parseDateCell(dateCellRaw);
    if (
      HAS_DATE.test(dateCellRaw) &&
      dates.validFrom === null &&
      dates.validTo === null &&
      dates.issuedAt === null
    ) {
      warnings.push(`строка ${rowNo}: дата «${dateCellRaw}» не распознана или невозможна`);
    }

    const normalized =
      number.comparable && number.docNoRaw !== null ? normalizeDocNo(number.docNoRaw) : null;
    const orgCell = layout.org === null ? undefined : cells[layout.org];

    return {
      rowNo,
      sectionTitle,
      docNameRaw: cells[layout.name] ?? '',
      docNoRaw: number.docNoRaw,
      orgRaw: orgCell === undefined || orgCell === '' ? null : orgCell,
      docNoNorm: normalized?.normalized ?? null,
      docNoFolded: normalized?.folded ?? null,
      // Даты из графы номера точнее датой из отдельной графы «Дата»: форма
      // записи («от…», «с… по…») определяет тип, а голая дата — только заливка.
      validFrom: number.validFrom ?? dates.validFrom,
      validTo: number.validTo ?? dates.validTo,
      issuedAt: number.issuedAt ?? dates.issuedAt,
    };
  };

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
      // Строка без номера позиции — это либо хвост переноса ячейки
      // (`| | A240C, д.8 | | |`), либо ДОПОЛНИТЕЛЬНЫЙ документ той же позиции:
      // реестр материалов temp/MD/new пишет у одного материала несколько
      // документов, и только первая строка несёт № п/п. Различает их графа
      // номера: у хвоста переноса она пуста, у документа — сравнима.
      const continuation = parseNumberCell(cells[layout.number] ?? '');
      const previous = rows[rows.length - 1];
      if (continuation.comparable && previous !== undefined) {
        rows.push(buildRow(cells, previous.rowNo));
        continuationRows.add(rows.length - 1);
        continue;
      }
      // Нумерацию хвост не сдвигает — иначе позиция 18 стала бы позицией 19, и
      // сверка разъехалась бы на всём продолжении таблицы.
      warnings.push(
        `страница ${page.sourcePageId}: строка без номера позиции отброшена как хвост переноса ячейки` +
          (cells[1] === '' ? '' : ` («${cells[1] ?? ''}»)`),
      );
      continue;
    }

    const rowNo = Number(rowNoRaw);
    const row = buildRow(cells, rowNo);
    if (row.docNoRaw === null) {
      warnings.push(`строка ${rowNo}: номер документа не указан — сверка по номеру невозможна`);
    }
    rows.push(row);
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
function auditNumbering(
  rows: readonly ParsedRegistryRow[],
  continuationRows: ReadonlySet<number>,
): string[] {
  const warnings: string[] = [];
  const bySection = new Map<string, number[]>();

  for (const [index, row] of rows.entries()) {
    // Строка-продолжение позиции (дополнительный документ, см. `collectRows`)
    // номер позиции не несёт и в аудите нумерации не участвует: её повтор —
    // конструкция разбора, а не сбой реестра.
    if (continuationRows.has(index)) continue;
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
