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
 * ## Разбор ячейки обратен её печати
 *
 * Многострочная ячейка и `|` внутри ячейки существуют в исходных документах, а
 * GFM ни того, ни другого не выражает. Рендер портала (`tableCell`,
 * `packages/recognition/src/render-fragments.ts`) поэтому печатает перевод
 * строки как `<br>`, а `|` как `\|` — это единственный способ сохранить
 * строение ячейки. Снимать оба следа обязан разбор: в рендере правка сдвинула
 * бы офсеты цитат и потребовала поднять `RENDER_FRAGMENTS_VERSION`, то есть
 * обесценила бы все уже записанные `char_span`.
 *
 * Цена пропуска не косметическая. `<br>` уезжал в `doc_no_norm` строки реестра
 * вместе с завёрнутым сроком действия (`POCCRUД-RU.<BR>PA01.B.36916/24С…`), и
 * документ по такому номеру не находился никогда. Неснятое `\|` дробило ячейку
 * на две графы, строка не сходилась по их числу и выбрасывалась с
 * предупреждением.
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

/**
 * Граница ячейки — `|`, не защищённая обратной косой чертой.
 *
 * Обратная косая перед трубой ставится рендером и в исходном тексте документа
 * не встречается, поэтому обратная замена однозначна.
 */
const CELL_BOUNDARY = /(?<!\\)\|/u;

/** Экранированная труба внутри ячейки. */
const ESCAPED_PIPE = /\\\|/gu;

/**
 * Перенос строки внутри ячейки.
 *
 * Пробелы вокруг тега забираются вместе с ним: иначе `A<br> B` дало бы двойной
 * пробел посреди значения, а значение ячейки идёт в реквизит дословно.
 */
const LINE_BREAK_TAG = /\s*<br\s*\/?>\s*/giu;

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

  return (match[1] ?? '')
    .split(CELL_BOUNDARY)
    .map((cell) =>
      cell.replace(ESCAPED_PIPE, '|').replace(LINE_BREAK_TAG, ' ').replace(/\*\*/gu, '').trim(),
    );
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
