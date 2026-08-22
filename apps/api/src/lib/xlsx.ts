/**
 * Сборка плоской таблицы в .xlsx (§3.2, шаблон массового ввода).
 *
 * ## Зачем портал вообще пишет Excel
 *
 * Импорт справочника раскладывает колонки ПО ЗАГОЛОВКУ, а не по позиции, и
 * значит заголовок обязан быть известен человеку до того, как он соберёт файл.
 * Список колонок на экране этой задачи не решает: администратор всё равно
 * наберёт «ИНН.» с точкой или «Юр. адрес», а импорт откажет ему на первом же
 * шаге. Пустой шаблон снимает вопрос целиком.
 *
 * ## Почему колонки текстовые
 *
 * Это половина смысла шаблона. ИНН, КПП, ОГРН и код объекта — идентификаторы:
 * Excel по умолчанию считает их числами, теряет ведущий ноль при вводе и
 * печатает длинные значения экспонентой. Шаблон с `numFmtId="49"` (текст) не
 * даёт этому случиться в момент набора, а не ловит последствия при разборе.
 *
 * ## Почему свой писатель
 *
 * Пишется ровно одна форма — один лист, только строковые ячейки, — и она
 * укладывается в двести строк поверх собственного ZIP-писателя. Побочная польза
 * та же, что у пары zip-писатель/читатель: собранный здесь файл разбирается
 * НАШИМ ЖЕ читателем в воркере, то есть на каждом прогоне тестов они проверяют
 * друг друга.
 */

import { writeZipStream, type ZipSourceEntry } from './zip.js';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Стиль ячейки: 1 — текст, 2 — жирный текст заголовка (см. `stylesPart`). */
const STYLE_TEXT = 1;
const STYLE_HEADER = 2;

/**
 * Экранирование текста ячейки.
 *
 * `&` первым: иначе экранируется уже вставленный амперсанд следующих замен.
 * Управляющие символы вычёркиваются — XML 1.0 их не допускает вовсе, и лист с
 * ними Excel объявляет повреждённым.
 */
function escapeXml(value: string): string {
  return (
    value
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      .replace(/"/gu, '&quot;')
      // Управляющие символы здесь и есть предмет замены: XML 1.0 их не
      // допускает, а лист с ними Excel объявляет повреждённым.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
  );
}

/** Буква колонки по номеру (1 → `A`, 27 → `AA`). */
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

function contentTypesPart(): string {
  return (
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>'
  );
}

function rootRelsPart(): string {
  return (
    `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>'
  );
}

function workbookPart(sheetName: string): string {
  return (
    `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

function workbookRelsPart(): string {
  return (
    `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

/**
 * Минимальные стили: обычный, текстовый и жирный текстовый.
 *
 * Части `fonts`/`fills`/`borders` обязательны, даже пустые по смыслу: Excel
 * считает книгу без них повреждённой. `gray125` во втором заполнении — не
 * украшение, а требование формата к индексу 1.
 */
function stylesPart(): string {
  return (
    `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}">` +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="2">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '</fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '</cellXfs>' +
    '</styleSheet>'
  );
}

function sheetPart(rows: readonly (readonly string[])[], columnCount: number): string {
  const cols =
    columnCount === 0
      ? ''
      : `<cols><col min="1" max="${String(columnCount)}" width="32" style="${String(STYLE_TEXT)}" customWidth="1"/></cols>`;

  const body = rows
    .map((cells, rowIndex) => {
      const rowNo = rowIndex + 1;
      const style = rowIndex === 0 ? STYLE_HEADER : STYLE_TEXT;
      const painted = cells
        .map((value, cellIndex) => {
          if (value === '') return '';
          const reference = `${columnLetter(cellIndex + 1)}${String(rowNo)}`;
          // Только `inlineStr`: общая таблица строк экономит место на повторах,
          // которых в шаблоне нет, а лишняя часть — лишний повод книге не
          // открыться.
          return (
            `<c r="${reference}" s="${String(style)}" t="inlineStr">` +
            `<is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
          );
        })
        .join('');
      return `<row r="${String(rowNo)}">${painted}</row>`;
    })
    .join('');

  return `${XML_HEADER}<worksheet xmlns="${MAIN_NS}">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

function part(name: string, xml: string): ZipSourceEntry {
  const bytes = Buffer.from(xml, 'utf8');
  return { name, byteLength: bytes.length, open: () => [bytes] };
}

/**
 * Собирает книгу с единственным листом из строк текстовых ячеек.
 *
 * Первая строка считается заголовком и печатается жирным. Все ячейки — текст:
 * писатель не пытается угадать, где число, потому что в справочнике портала
 * чисел нет (см. заголовок файла).
 */
export async function buildXlsx(
  sheetName: string,
  rows: readonly (readonly string[])[],
): Promise<Buffer> {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const chunks: Buffer[] = [];

  await writeZipStream(
    [
      part('[Content_Types].xml', contentTypesPart()),
      part('_rels/.rels', rootRelsPart()),
      part('xl/workbook.xml', workbookPart(sheetName)),
      part('xl/_rels/workbook.xml.rels', workbookRelsPart()),
      part('xl/styles.xml', stylesPart()),
      part('xl/worksheets/sheet1.xml', sheetPart(rows, columnCount)),
    ],
    {
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
    },
  );

  return Buffer.concat(chunks);
}
