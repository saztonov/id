/**
 * Разметка markdown-таблиц: общее ядро разбора табличных документов (§8.3).
 *
 * Вынесено из `registry.ts` без единого изменения поведения. Причина выноса —
 * второй читатель: реестр приложений внутри АОСР и опись передачи папки
 * (`transfer-registry.ts`) разбирают РАЗНЫЕ документы, но одну и ту же разметку,
 * которую отдаёт распознавание. Копия этих двадцати строк во втором файле
 * означала бы, что след OCR, учтённый в одном разборе, в другом не учтён — и
 * разойтись они могли бы молча, потому что тестируются порознь.
 *
 * ## Что здесь НЕ живёт
 *
 * Ничего, что знает, ЧТО за таблица разбирается: ни канонические шапки, ни
 * восстановление потерянного разделителя, ни раскладка граф. Эти решения имеют
 * смысл только там, где известно, какой документ ищут, и потому остаются у
 * своих разборов. Здесь — синтаксис и ничего больше.
 */

/** Строка таблицы: `| ячейка | ячейка |`. */
const TABLE_LINE = /^\s*\|(.*)\|\s*$/u;

/** Ячейка разделителя шапки: `---`, `:---:`. */
const SEPARATOR_CELL = /^:?-{1,}:?$/u;

/** Строка целиком в полужирном начертании — так OCR печатает заголовки разделов. */
const BOLD_LINE = /^\s*\*\*(.+?)\*\*\s*$/u;

export interface MdTable {
  /** `null` — разделитель шапки стоит первым либо отсутствует вовсе. */
  readonly header: readonly string[] | null;
  readonly rows: readonly (readonly string[])[];
}

export type Block =
  | { readonly kind: 'table'; readonly table: MdTable }
  | { readonly kind: 'bold'; readonly text: string };

export function tableCells(line: string | undefined): string[] | null {
  if (line === undefined) return null;
  const match = TABLE_LINE.exec(line);
  if (match === null) return null;

  return (match[1] ?? '').split('|').map((cell) => cell.replace(/\*\*/gu, '').trim());
}

export function isSeparator(cells: readonly string[]): boolean {
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
export function scanBlocks(text: string): Block[] {
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

export function toTable(run: readonly string[][]): MdTable {
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
