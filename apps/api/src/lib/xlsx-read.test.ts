/**
 * Читатель .xlsx: что он обязан прочитать и что обязан отвергнуть.
 *
 * Файлы собираются НАШИМ ЖЕ писателем (`buildXlsx` из `@id/api`) — та же пара,
 * что zip-писатель и zip-читатель портала: каждый прогон они проверяют друг
 * друга, и «писатель испортил книгу» не может выглядеть как «читатель не умеет».
 *
 * Отдельно собираются книги, которых писатель не производит: числовые ячейки,
 * общая таблица строк с форматированными прогонами, обрезанный архив,
 * zip-бомба. Именно они приходят из Excel и именно на них ломается наивный
 * разбор, поэтому их XML пишется здесь вручную — иначе проверялось бы только то,
 * что мы сами и сгенерировали.
 */

import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { buildXlsx } from './xlsx.js';
import { crc32 } from './zip.js';

import { DEFAULT_XLSX_LIMITS, readXlsxSheet, XlsxError, columnLetter } from './xlsx-read.js';

// =====================================================================
// Сборка книг, которых наш писатель не производит
// =====================================================================

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

interface RawPart {
  readonly name: string;
  readonly body: string;
}

/**
 * Сборка ZIP вручную: методом DEFLATE и с произвольным содержимым.
 *
 * Свой писатель пишет STORED и только валидные книги — а проверить нужно как раз
 * то, чего он не умеет: сжатую запись (её распаковывает `inflateRawSync`
 * читателя) и заведомо испорченный архив.
 */
function zipOf(
  parts: readonly RawPart[],
  options: { readonly lieAboutSize?: number } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const content = Buffer.from(part.body, 'utf8');
    const compressed = deflateRawSync(content);
    const declared = options.lieAboutSize ?? content.length;
    // Контрольную сумму читатель портала проверяет: без неё архив объявляется
    // повреждённым раньше, чем дело дойдёт до разбора XML.
    const checksum = crc32(content);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** Книга с произвольным телом листа и необязательной общей таблицей строк. */
function workbook(
  sheetXml: string,
  options: { readonly sharedStrings?: string; readonly sheetPath?: string } = {},
): Buffer {
  const path = options.sheetPath ?? 'xl/worksheets/sheet1.xml';
  const parts: RawPart[] = [
    {
      name: 'xl/workbook.xml',
      body: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Лист" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      body: `${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="${path.replace('xl/', '')}"/></Relationships>`,
    },
    {
      name: path,
      body: `${XML}<worksheet xmlns="${MAIN}"><sheetData>${sheetXml}</sheetData></worksheet>`,
    },
  ];
  if (options.sharedStrings !== undefined) {
    parts.push({
      name: 'xl/sharedStrings.xml',
      body: `${XML}<sst xmlns="${MAIN}">${options.sharedStrings}</sst>`,
    });
  }
  return zipOf(parts);
}

/** Значения строки по буквам колонок — в том виде, в котором их видит разборщик. */
function textsOf(sheet: ReturnType<typeof readXlsxSheet>, rowIndex: number): string[] {
  const row = sheet.rows[rowIndex];
  if (row === undefined) throw new Error(`нет строки ${String(rowIndex)}`);
  return [...row.cells.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([, cell]) => cell.text);
}

// =====================================================================
// Круг «записали — прочитали»
// =====================================================================

describe('книга портала читается обратно', () => {
  it('заголовок и строки возвращаются в исходном виде', async () => {
    const bytes = await buildXlsx('Контрагенты', [
      ['Наименование', 'Вид', 'ИНН'],
      ['ООО «Ромашка»', 'contractor', '7700123459'],
      ['АО "Кавычки & символы <>"', 'laboratory', ''],
    ]);

    const sheet = readXlsxSheet(bytes);
    expect(sheet.name).toBe('Контрагенты');
    expect(sheet.rows).toHaveLength(3);
    expect(textsOf(sheet, 0)).toEqual(['Наименование', 'Вид', 'ИНН']);
    expect(textsOf(sheet, 1)).toEqual(['ООО «Ромашка»', 'contractor', '7700123459']);
    // Пустая ячейка не хранится: разборщику она неотличима от отсутствующей.
    expect(textsOf(sheet, 2)).toEqual(['АО "Кавычки & символы <>"', 'laboratory']);
  });

  it('номер строки берётся из файла, а не из порядка чтения', async () => {
    const bytes = await buildXlsx('Лист', [['Код'], [''], ['TST01']]);
    const sheet = readXlsxSheet(bytes);
    // Пустая вторая строка пропущена, но третья осталась третьей: человек ищет
    // её в своём Excel по номеру.
    expect(sheet.rows.map((r) => r.rowNo)).toEqual([1, 3]);
  });
});

// =====================================================================
// То, что приходит из Excel
// =====================================================================

describe('ячейки, которые делает Excel, а не портал', () => {
  it('числовая ячейка с экспонентой разворачивается в цифры', () => {
    const bytes = workbook(
      '<row r="1"><c r="A1"><v>7.701234567E9</v></c><c r="B1"><v>1027700123450</v></c></row>',
    );
    const sheet = readXlsxSheet(bytes);
    expect(textsOf(sheet, 0)).toEqual(['7701234567', '1027700123450']);
    // Вид ячейки доезжает до разборщика: по нему он скажет про ведущий ноль.
    expect(sheet.rows[0]?.cells.get('A')?.kind).toBe('integer');
  });

  it('дробное значение не выдаётся за реквизит', () => {
    const sheet = readXlsxSheet(workbook('<row r="1"><c r="A1"><v>0.5</v></c></row>'));
    expect(sheet.rows[0]?.cells.get('A')).toEqual({ text: '0.5', kind: 'fractional' });
  });

  it('общая таблица строк склеивает форматированные прогоны', () => {
    const bytes = workbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', {
      sharedStrings: '<si><r><t>ООО </t></r><r><t xml:space="preserve">«Ромашка»</t></r></si>',
    });
    // Без склейки прогонов вышло бы «ООО » — часть названия молча исчезла бы.
    expect(textsOf(readXlsxSheet(bytes), 0)).toEqual(['ООО «Ромашка»']);
  });

  it('индекс за пределами общей таблицы даёт пусто, а не соседнюю строку', () => {
    const bytes = workbook('<row r="1"><c r="A1" t="s"><v>7</v></c></row>', {
      sharedStrings: '<si><t>Первая</t></si>',
    });
    expect(readXlsxSheet(bytes).rows).toEqual([]);
  });

  it('inlineStr и результат формулы читаются как текст', () => {
    const bytes = workbook(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Встроенная</t></is></c>' +
        '<c r="B1" t="str"><f>A1</f><v>Посчитано</v></c></row>',
    );
    expect(textsOf(readXlsxSheet(bytes), 0)).toEqual(['Встроенная', 'Посчитано']);
  });

  it('числовые сущности раскрываются', () => {
    const bytes = workbook(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>&#1054;&#1054;&#1054;</t></is></c></row>',
    );
    expect(textsOf(readXlsxSheet(bytes), 0)).toEqual(['ООО']);
  });

  it('первый лист берётся по связи книги, а не по имени файла', () => {
    // Книга, из которой удалили первый лист: данные лежат в sheet2.xml.
    const bytes = workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>Второй</t></is></c></row>', {
      sheetPath: 'xl/worksheets/sheet2.xml',
    });
    expect(textsOf(readXlsxSheet(bytes), 0)).toEqual(['Второй']);
  });
});

// =====================================================================
// Отказы
// =====================================================================

describe('читатель отвергает то, что книгой не является', () => {
  it('произвольные байты', () => {
    expect(() => readXlsxSheet(Buffer.from('это не архив'))).toThrow(XlsxError);
  });

  it('архив без workbook.xml', () => {
    const bytes = zipOf([{ name: 'readme.txt', body: 'привет' }]);
    expect(() => readXlsxSheet(bytes)).toThrow(/не книга Excel/u);
  });

  it('обрезанное содержимое записи', () => {
    const bytes = workbook('<row r="1"><c r="A1"><v>1</v></c></row>');
    expect(() => readXlsxSheet(bytes.subarray(0, bytes.length - 40))).toThrow(XlsxError);
  });

  it('запись, заявившая размер больше распакованного', () => {
    const bytes = zipOf([{ name: 'xl/workbook.xml', body: `${XML}<workbook/>` }], {
      lieAboutSize: 1024,
    });
    expect(() => readXlsxSheet(bytes)).toThrow(XlsxError);
  });

  it('zip-бомба останавливается потолком распаковки, а не памятью процесса', () => {
    // 8 МиБ нулей сжимаются в единицы килобайт; потолок ставится в 64 КиБ.
    const bomb = zipOf([{ name: 'xl/workbook.xml', body: '0'.repeat(8 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() =>
      readXlsxSheet(bomb, { ...DEFAULT_XLSX_LIMITS, maxUncompressedBytes: 64 * 1024 }),
    ).toThrow(XlsxError);
  });

  it('лист длиннее предела строк', () => {
    const rows = Array.from(
      { length: 12 },
      (_, index) =>
        `<row r="${String(index + 1)}"><c r="A${String(index + 1)}" t="inlineStr"><is><t>x</t></is></c></row>`,
    ).join('');
    expect(() => readXlsxSheet(workbook(rows), { ...DEFAULT_XLSX_LIMITS, maxRows: 10 })).toThrow(
      /больше 10 заполненных строк/u,
    );
  });

  it('строка шире предела колонок', () => {
    const cells = Array.from(
      { length: 6 },
      (_, index) => `<c r="${columnLetter(index + 1)}1" t="inlineStr"><is><t>x</t></is></c>`,
    ).join('');
    expect(() =>
      readXlsxSheet(workbook(`<row r="1">${cells}</row>`), {
        ...DEFAULT_XLSX_LIMITS,
        maxColumns: 4,
      }),
    ).toThrow(/больше 4 заполненных колонок/u);
  });
});

describe('буква колонки', () => {
  it('считается для двухбуквенных колонок', () => {
    expect([1, 26, 27, 52, 53].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA']);
  });
});
