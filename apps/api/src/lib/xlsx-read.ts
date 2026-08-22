/**
 * Чтение плоской таблицы из .xlsx (§3.2, массовый ввод справочников).
 *
 * ## Почему свой читатель, а не библиотека
 *
 * Та же причина, что у ZIP-читателя портала (`lib/zip.ts`), и ещё одна сверх
 * неё. Обычная: формат нужен ровно в одном известном виде, а зависимость
 * обосновывается (§2). Особая: офисные парсеры — это то место, где уязвимость
 * разбора регулярно превращается в исполнение чужого кода, а нам из всего
 * OOXML нужны три файла и один тип ячейки. Читатель, который умеет только
 * прочитать строки первого листа, по построению не умеет ничего опасного: он не
 * знает ни о формулах, ни о макросах, ни о внешних ссылках, ни о DDE.
 *
 * Отсюда же граница: `.xlsm` от `.xlsx` неотличим по контейнеру, и мы этого не
 * проверяем. Мы просто не читаем ни одной части, где макрос мог бы жить.
 *
 * ## Модуль лежит здесь, а вызывается из воркера
 *
 * Правило «офисный файл не разбирается в процессе публичного API» — про то, КТО
 * вызывает разбор, а не про то, в каком пакете лежит функция. Единственный её
 * вызывающий — задача `catalog.import.parse` воркера; ни один маршрут её не
 * трогает. Рядом с писателем (`xlsx.ts`) она лежит по той же причине, что
 * читатель и писатель ZIP в `zip.ts`: пара проверяет друг друга на каждом
 * прогоне тестов, а разнесённые по пакетам они расходятся молча.
 *
 * ## Всё значимое — текст, и это не упрощение
 *
 * ИНН, КПП, ОГРН и код объекта — идентификаторы, а не числа: ведущий ноль в них
 * значим, а арифметика бессмысленна. Excel об этом не знает и по умолчанию
 * кладёт их числовыми ячейками, теряя ведущий ноль ещё при вводе и печатая
 * длинные значения в экспоненциальной форме. Читатель обязан это РАЗЛИЧАТЬ, а
 * не молча приводить: `kind` ячейки доезжает до разборщика, и «КПП из восьми
 * цифр» становится внятным замечанием строки, а не тихо неверной карточкой.
 *
 * ## Разбор регулярными выражениями, а не деревом
 *
 * Лист на пять тысяч строк — это мегабайты XML; DOM над ними стоит памяти
 * воркера, а нужен последовательный проход. Регулярные выражения здесь
 * допустимы ровно потому, что разбирается не произвольный XML, а известная
 * форма, порождённая Excel: `<row>` содержит `<c>`, `<c>` содержит `<v>` или
 * `<is>`. Всё, что в эту форму не укладывается, читатель пропускает, а не
 * пытается угадать.
 */

import { readZipEntries, ZipError } from './zip.js';

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

/**
 * Чем ячейка была в файле.
 *
 * `integer` и `fractional` разделены не ради полноты: целое в графе реквизита —
 * это потерянный ведущий ноль (поправимо форматом ячейки), дробное — это
 * заведомо не реквизит, и советы человеку тут разные.
 */
export type XlsxCellKind = 'text' | 'integer' | 'fractional' | 'boolean' | 'error';

export interface XlsxCell {
  /** Значение в том виде, в котором его увидит разборщик справочника. */
  readonly text: string;
  readonly kind: XlsxCellKind;
}

export interface XlsxRow {
  /** Номер строки В ФАЙЛЕ: человек ищет её в своём Excel, а не в нашей нумерации. */
  readonly rowNo: number;
  /** Ячейки по букве колонки: `A`, `B`, … Пустые не хранятся. */
  readonly cells: ReadonlyMap<string, XlsxCell>;
}

export interface XlsxSheet {
  readonly name: string;
  readonly rows: readonly XlsxRow[];
}

export interface XlsxLimits {
  /** Потолок суммарного распакованного размера архива. */
  readonly maxUncompressedBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 64,
};

// =====================================================================
// XML: сущности, атрибуты, текст
// =====================================================================

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Раскрытие XML-сущностей.
 *
 * Числовые формы обязательны: Excel кодирует ими всё, что счёл небезопасным, —
 * в том числе неразрывный пробел, который потом обязан быть отличим от обычного
 * при сравнении заголовков.
 */
function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (_match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body.startsWith('#x') || body.startsWith('#X');
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Значение вне диапазона Unicode — это порча файла, а не текст.
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED_ENTITIES[body] ?? '';
  });
}

/** Значение атрибута открывающего тега; `null`, если атрибута нет. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'u').exec(tag);
  return match === null ? null : decodeXmlText(match[1] ?? '');
}

/** Содержимое всех элементов `<tag>…</tag>` подряд, склеенное. */
function innerTexts(xml: string, tag: string): string[] {
  const found: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gu');
  let match = re.exec(xml);
  while (match !== null) {
    found.push(decodeXmlText(match[1] ?? ''));
    match = re.exec(xml);
  }
  return found;
}

// =====================================================================
// Части книги
// =====================================================================

/** Общая таблица строк: индекс `t="s"` указывает в неё. */
function parseSharedStrings(xml: string): readonly string[] {
  const items: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/gu;
  let match = re.exec(xml);
  while (match !== null) {
    const body = match[1];
    // `<si>` без содержимого — законная пустая строка общей таблицы.
    // Внутри `<si>` текст лежит либо прямо в `<t>`, либо разбит на прогоны
    // `<r><t>`: форматирование части строки в Excel режет её на куски, и
    // склеивать их обязан читатель, иначе «ООО «Ромашка»» станет «ООО ».
    items.push(body === undefined ? '' : innerTexts(body, 't').join(''));
    match = re.exec(xml);
  }
  return items;
}

/**
 * Имя и путь первого листа книги.
 *
 * Через связи, а не «возьмём sheet1.xml»: порядок листов задаёт `workbook.xml`,
 * а имя файла первого листа с ним не связано — книга, из которой удалили первый
 * лист, начинается с `sheet2.xml`. Молча прочитать не тот лист хуже, чем не
 * прочитать ничего.
 */
function firstSheet(entries: ReadonlyMap<string, Buffer>): { name: string; path: string } {
  const workbook = entries.get('xl/workbook.xml');
  if (workbook === undefined) {
    throw new XlsxError('Это не книга Excel: в файле нет xl/workbook.xml');
  }
  const workbookXml = workbook.toString('utf8');
  const sheetTag = /<sheet\s[^>]*\/?>/u.exec(workbookXml)?.[0];
  if (sheetTag === undefined) throw new XlsxError('В книге нет ни одного листа');

  const name = attribute(sheetTag, 'name') ?? 'Лист1';
  const relationId = attribute(sheetTag, 'r:id') ?? attribute(sheetTag, 'id');

  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (relationId !== null && rels !== undefined) {
    const relsXml = rels.toString('utf8');
    const re = /<Relationship\s[^>]*\/?>/gu;
    let match = re.exec(relsXml);
    while (match !== null) {
      const tag = match[0];
      if (attribute(tag, 'Id') === relationId) {
        const target = attribute(tag, 'Target') ?? '';
        const path = target.startsWith('/')
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//u, '')}`;
        if (entries.has(path)) return { name, path };
      }
      match = re.exec(relsXml);
    }
  }

  // Связи не разобрались — берём первый лист по имени файла и говорим об этом
  // только через содержимое: отказ здесь означал бы, что портал не читает
  // книгу, которую Excel открывает без единого вопроса.
  const fallback = [...entries.keys()]
    .filter((key) => key.startsWith('xl/worksheets/') && key.endsWith('.xml'))
    .sort((a, b) => a.localeCompare(b, 'en'))[0];
  if (fallback === undefined) throw new XlsxError('В книге нет ни одного листа с данными');
  return { name, path: fallback };
}

// =====================================================================
// Ячейки
// =====================================================================

/** Буква колонки из ссылки вида `AB12`. */
function columnOf(reference: string): string {
  const match = /^([A-Z]+)/u.exec(reference);
  return match?.[1] ?? '';
}

/**
 * Числовое значение в текст без экспоненты.
 *
 * `7.701234567E9` — это ИНН, набранный в ячейке общего формата; вернуть его в
 * таком виде значило бы отдать разборщику заведомо непригодную строку. Предел
 * точности double (около 15 значащих цифр) покрывает и ОГРНИП из 15 цифр, то
 * есть самый длинный реквизит справочника.
 */
function numericText(raw: string): XlsxCell {
  const value = Number(raw);
  if (!Number.isFinite(value)) return { text: raw, kind: 'error' };
  if (Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) {
    return { text: value.toFixed(0), kind: 'integer' };
  }
  return { text: raw, kind: 'fractional' };
}

function cellValue(tag: string, body: string, shared: readonly string[]): XlsxCell | null {
  const type = attribute(tag, 't') ?? 'n';

  if (type === 'inlineStr') {
    const inline = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/u.exec(body)?.[1] ?? '';
    return { text: innerTexts(inline, 't').join(''), kind: 'text' };
  }

  const rawValues = innerTexts(body, 'v');
  if (rawValues.length === 0) return null;
  const raw = rawValues[0] ?? '';

  switch (type) {
    case 's': {
      const index = Number.parseInt(raw, 10);
      // Индекс за пределами общей таблицы — порча файла; пустая ячейка честнее
      // подстановки соседней строки.
      return { text: shared[index] ?? '', kind: 'text' };
    }
    case 'str':
      // Результат формулы. Значение уже посчитано Excel, саму формулу мы не
      // читаем и не вычисляем — этого читателя нет.
      return { text: raw, kind: 'text' };
    case 'b':
      return { text: raw === '1' ? 'да' : 'нет', kind: 'boolean' };
    case 'e':
      return { text: raw, kind: 'error' };
    default:
      return numericText(raw);
  }
}

// =====================================================================
// Чтение
// =====================================================================

/**
 * Читает первый лист книги.
 *
 * Бросает `XlsxError` на всём, что не является книгой Excel или выходит за
 * объявленные пределы. Ни одно исключение отсюда не должно доехать до клиента
 * дословно: текст рассчитан на администратора портала, а не на разбор снаружи.
 */
export function readXlsxSheet(
  input: Uint8Array,
  limits: XlsxLimits = DEFAULT_XLSX_LIMITS,
): XlsxSheet {
  let entries: ReadonlyMap<string, Buffer>;
  try {
    entries = new Map(
      readZipEntries(input, limits.maxUncompressedBytes).map((entry) => [entry.name, entry.bytes]),
    );
  } catch (error) {
    if (error instanceof ZipError) {
      throw new XlsxError(`Файл не читается как книга Excel: ${error.message}`);
    }
    throw error;
  }

  const shared = (() => {
    const part = entries.get('xl/sharedStrings.xml');
    return part === undefined ? [] : parseSharedStrings(part.toString('utf8'));
  })();

  const sheet = firstSheet(entries);
  const xml = (entries.get(sheet.path) ?? Buffer.alloc(0)).toString('utf8');

  const rows: XlsxRow[] = [];
  const rowRe = /<row(\s[^>]*)?>([\s\S]*?)<\/row>|<row(\s[^>]*)?\/>/gu;
  let rowMatch = rowRe.exec(xml);
  let fallbackRowNo = 0;

  while (rowMatch !== null) {
    fallbackRowNo += 1;
    const rowTag = `<row${rowMatch[1] ?? rowMatch[3] ?? ''}>`;
    const declared = Number.parseInt(attribute(rowTag, 'r') ?? '', 10);
    const rowNo = Number.isInteger(declared) && declared > 0 ? declared : fallbackRowNo;
    const body = rowMatch[2] ?? '';

    const cells = new Map<string, XlsxCell>();
    const cellRe = /<c(\s[^>]*)?>([\s\S]*?)<\/c>|<c(\s[^>]*)?\/>/gu;
    let cellMatch = cellRe.exec(body);
    let fallbackColumn = 0;

    while (cellMatch !== null) {
      fallbackColumn += 1;
      const cellTag = `<c${cellMatch[1] ?? cellMatch[3] ?? ''}>`;
      const reference = attribute(cellTag, 'r');
      const column =
        reference === null ? columnLetter(fallbackColumn) : columnOf(reference.toUpperCase());
      const value = cellMatch[2] === undefined ? null : cellValue(cellTag, cellMatch[2], shared);

      if (value !== null && value.text.trim() !== '') {
        if (cells.size >= limits.maxColumns && !cells.has(column)) {
          throw new XlsxError(
            `В строке ${String(rowNo)} больше ${String(limits.maxColumns)} заполненных колонок`,
          );
        }
        cells.set(column, { text: value.text.trim(), kind: value.kind });
      }
      cellMatch = cellRe.exec(body);
    }

    // Пустые строки не хранятся, но и не обрывают чтение: между разделами
    // списка человек оставляет пустую строку, и это не конец файла.
    if (cells.size > 0) {
      if (rows.length >= limits.maxRows) {
        throw new XlsxError(
          `В листе больше ${String(limits.maxRows)} заполненных строк: разделите файл на части`,
        );
      }
      rows.push({ rowNo, cells });
    }
    rowMatch = rowRe.exec(xml);
  }

  return { name: sheet.name, rows };
}

/** Буква колонки по её номеру (1 → `A`, 27 → `AA`). Нужна для ячеек без `r`. */
export function columnLetter(index: number): string {
  let rest = index;
  let letters = '';
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    rest = Math.floor((rest - remainder - 1) / 26);
  }
  return letters;
}
