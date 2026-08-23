/**
 * Разбор загруженной таблицы: что становится карточкой, а что — замечанием.
 *
 * Проверяется чистая функция, без БД и хранилища: состояние справочника
 * подаётся снимком. Из-за этого таблица случаев покрывает ровно то, ради чего
 * разбор написан, — расхождения между тем, что человек набрал в Excel, и тем,
 * что портал может принять.
 *
 * Реквизиты синтетические, с посчитанными контрольными суммами: значения
 * корпуса в тесты не попадают, это держит `pnpm pii:scan`.
 */

import { describe, expect, it } from 'vitest';

import { parseCatalogImport, type CatalogSnapshot, type ImportSheet } from './parse.js';

// =====================================================================
// Фикстуры
// =====================================================================

const INN_VALID = '7700123459';
/** Форма верна, контрольная сумма — нет: CHECK в БД такое пропустил бы. */
const INN_BROKEN = '7700123458';
const INN_OTHER = '7743013901';

function snapshot(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    kinds: new Map([
      ['contractor', true],
      ['laboratory', true],
      ['supplier', false],
    ]),
    counterpartyByInn: new Map(),
    counterpartyByName: new Map(),
    objectCodes: new Set<string>(),
    ...overrides,
  };
}

/** Лист из строк: первая — заголовок. Пустая ячейка задаётся пустой строкой. */
function sheetOf(
  rows: readonly (readonly string[])[],
  numeric: readonly string[] = [],
): ImportSheet {
  const letters = 'ABCDEFGHIJKLMNOP'.split('');
  return {
    rows: rows.map((cells, index) => ({
      rowNo: index + 1,
      cells: new Map(
        cells
          .map((text, column) => [letters[column] ?? 'Z', text] as const)
          .filter(([, text]) => text !== '')
          .map(([letter, text]) => [
            letter,
            { text, kind: numeric.includes(text) ? ('integer' as const) : ('text' as const) },
          ]),
      ),
    })),
  };
}

function rowsOf(result: ReturnType<typeof parseCatalogImport>) {
  if (!result.ok) throw new Error(`разбор отвергнут: ${result.reason}`);
  return result.rows;
}

function reasonOf(result: ReturnType<typeof parseCatalogImport>): string {
  if (result.ok) throw new Error('ожидался отказ разбора');
  return result.reason;
}

function codesOf(result: ReturnType<typeof parseCatalogImport>, index: number): string[] {
  return rowsOf(result)[index]?.problems.map((p) => p.code) ?? [];
}

// =====================================================================
// Раскладка колонок
// =====================================================================

describe('колонки сопоставляются по заголовку', () => {
  it('порядок колонок в файле значения не имеет', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([
        ['ИНН', 'Наименование', 'Вид'],
        [INN_VALID, 'ООО «Ромашка»', 'contractor'],
      ]),
      snapshot(),
    );
    expect(rowsOf(result)[0]?.normalized).toMatchObject({
      name: 'ООО «Ромашка»',
      kind: 'contractor',
      inn: INN_VALID,
    });
  });

  it('регистр, точки и пробелы в заголовке различием не считаются', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([
        ['  наименование ', 'ВИД', 'И.Н.Н.'],
        ['ООО «Ромашка»', 'contractor', INN_VALID],
      ]),
      snapshot(),
    );
    expect(rowsOf(result)[0]?.verdict).toBe('create');
  });

  it('неопознанная колонка отвергает файл целиком и называет ожидаемые', () => {
    const reason = reasonOf(
      parseCatalogImport(
        'counterparties',
        sheetOf([
          ['Наименование', 'Вид', 'Телефон'],
          ['ООО «Ромашка»', 'contractor', '+7'],
        ]),
        snapshot(),
      ),
    );
    // Тихо пропустить непонятый столбец нельзя: почти наверняка он и есть тот,
    // ради которого файл собирали.
    expect(reason).toContain('«Телефон»');
    expect(reason).toContain('Наименование');
  });

  it('пропущенная обязательная колонка отвергает файл', () => {
    const reason = reasonOf(
      parseCatalogImport(
        'counterparties',
        sheetOf([['Наименование'], ['ООО «Ромашка»']]),
        snapshot(),
      ),
    );
    expect(reason).toContain('«Вид»');
  });

  it('дважды названная колонка отвергает файл', () => {
    const reason = reasonOf(
      parseCatalogImport(
        'counterparties',
        sheetOf([
          ['Наименование', 'Вид', 'Название'],
          ['ООО «Ромашка»', 'contractor', 'ООО «Ромашка»'],
        ]),
        snapshot(),
      ),
    );
    expect(reason).toContain('дважды');
  });

  it('файл из одного заголовка отвергается', () => {
    expect(
      reasonOf(
        parseCatalogImport('counterparties', sheetOf([['Наименование', 'Вид']]), snapshot()),
      ),
    ).toContain('только заголовок');
  });
});

// =====================================================================
// Контрагенты
// =====================================================================

describe('строки контрагентов', () => {
  const header = ['Наименование', 'Вид', 'ИНН', 'КПП', 'ОГРН'];

  it('годная строка становится телом создания', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([header, ['ООО «Ромашка»', 'contractor', INN_VALID, '770012345', '1027700123450']]),
      snapshot(),
    );
    expect(rowsOf(result)[0]).toMatchObject({
      rowNo: 2,
      verdict: 'create',
      normalized: { name: 'ООО «Ромашка»', kind: 'contractor', kpp: '770012345' },
    });
  });

  it('битая контрольная сумма — замечание строки, а не отказ файла', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([
        header,
        ['ООО «Ошибка»', 'contractor', INN_BROKEN, '', ''],
        ['ООО «Норма»', 'contractor', INN_VALID, '', ''],
      ]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['checksum_failed']);
    // Соседняя строка не пострадала: полсотни правильных не ждут одну кривую.
    expect(rowsOf(result)[1]?.verdict).toBe('create');
  });

  it('потерянный ведущий ноль назван своей причиной, а не «неверной длиной»', () => {
    const result = parseCatalogImport(
      'counterparties',
      // КПП из восьми цифр в ЧИСЛОВОЙ ячейке — след того, что Excel съел ноль.
      sheetOf([header, ['ООО «Ноль»', 'contractor', '', '70012345', '']], ['70012345']),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['leading_zero_lost']);
    expect(rowsOf(result)[0]?.problems[0]?.message).toContain('текстовый формат');
  });

  it('неизвестный вид перечисляет допустимые коды', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([header, ['ООО «Вид»', 'нет_такого', '', '', '']]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['unknown_kind']);
    expect(rowsOf(result)[0]?.problems[0]?.message).toContain('laboratory');
  });

  it('отключённый вид не принимается', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([header, ['ООО «Поставщик»', 'supplier', '', '', '']]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['inactive_kind']);
  });

  it('пустое обязательное поле называет колонку', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([header, ['', 'contractor', INN_VALID, '', '']]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['required_missing']);
    expect(rowsOf(result)[0]?.problems[0]?.column).toBe('name');
  });

  it('уже заведённый ИНН даёт дубликат, а не ошибку', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([header, ['ООО «Ромашка»', 'contractor', INN_VALID, '', '']]),
      snapshot({ counterpartyByInn: new Map([[INN_VALID, 'id-1']]) }),
    );
    expect(rowsOf(result)[0]).toMatchObject({ verdict: 'duplicate', normalized: null });
    expect(codesOf(result, 0)).toEqual(['duplicate_in_catalog']);
  });

  it('совпадение по наименованию ловится с точностью до кавычек и регистра', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([header, ['ооо "ромашка"', 'contractor', '', '', '']]),
      snapshot({ counterpartyByName: new Map([['ООО РОМАШКА', ['id-1']]]) }),
    );
    expect(rowsOf(result)[0]?.verdict).toBe('duplicate');
  });

  it('повтор ВНУТРИ файла отличается от повтора справочника', () => {
    const result = parseCatalogImport(
      'counterparties',
      sheetOf([
        header,
        ['ООО «Ромашка»', 'contractor', INN_VALID, '', ''],
        ['ООО «Ромашка» (копия)', 'contractor', INN_VALID, '', ''],
      ]),
      snapshot(),
    );
    expect(rowsOf(result)[0]?.verdict).toBe('create');
    expect(codesOf(result, 1)).toEqual(['duplicate_in_file']);
  });
});

// =====================================================================
// Объекты
// =====================================================================

describe('строки объектов', () => {
  const header = [
    'Код',
    'Наименование',
    'Полное наименование',
    'Кадастровый номер',
    'Застройщик',
    'Генеральный подрядчик',
  ];

  it('ссылки на контрагентов разрешаются по ИНН', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([
        header,
        ['MSK01', 'ЖК Северный', 'ЖК «Северный», корпус 1', '77:07:0010004:24', INN_VALID, ''],
      ]),
      snapshot({ counterpartyByInn: new Map([[INN_VALID, 'org-developer']]) }),
    );
    expect(rowsOf(result)[0]?.normalized).toMatchObject({
      code: 'MSK01',
      cadastralNumber: '77:07:0010004:24',
      developerId: 'org-developer',
      generalContractorId: null,
    });
  });

  it('ссылка по наименованию работает, а неоднозначная — нет', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([header, ['MSK02', 'ЖК Южный', 'ЖК «Южный»', '', 'ООО «Стройка»', 'ООО «Двойник»']]),
      snapshot({
        counterpartyByName: new Map([
          ['ООО СТРОЙКА', ['org-a']],
          ['ООО ДВОЙНИК', ['org-b', 'org-c']],
        ]),
      }),
    );
    // Выбрать одного из двух за человека нельзя: это была бы выдумка, поданная
    // как факт.
    expect(codesOf(result, 0)).toEqual(['counterparty_ambiguous']);
    expect(rowsOf(result)[0]?.problems[0]?.message).toContain('Укажите ИНН');
  });

  it('ненайденный контрагент называет, что делать', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([header, ['MSK03', 'ЖК Третий', 'ЖК «Третий»', '', INN_OTHER, '']]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['counterparty_not_found']);
  });

  /**
   * Короткий код больше не ошибка — и эвристики «Excel съел ноль» здесь нет.
   *
   * До 0033 код из четырёх цифр в числовой ячейке был верным следом потерянного
   * ведущего нуля: пятизначность была правилом. Теперь `1234` — законный код, и
   * отличить его от испорченного `01234` нечем. Отвергать оба значило бы
   * отвергать законные коды ради догадки.
   */
  it('короткий код объекта принимается без замечаний', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([header, ['1234', 'ЖК Ноль', 'ЖК «Ноль»', '', '', '']], ['1234']),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual([]);
    expect(rowsOf(result)[0]?.verdict).toBe('create');
  });

  it('кириллический код объекта принимается', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([header, ['ЗИЛ18', 'ЖК ЗИЛ', 'ЖК «ЗИЛ», корпус 18', '', '', '']]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual([]);
    expect(rowsOf(result)[0]?.verdict).toBe('create');
  });

  it('код длиннее пяти символов — ошибка формата', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([header, ['МОСКВА', 'ЖК Кириллица', 'ЖК «Кириллица»', '', '', '']]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['invalid_format']);
  });

  it('код с разделителем — ошибка формата', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([header, ['ЗИЛ-8', 'ЖК Дефис', 'ЖК «Дефис»', '', '', '']]),
      snapshot(),
    );
    expect(codesOf(result, 0)).toEqual(['invalid_format']);
  });

  it('уже заведённый код даёт дубликат независимо от регистра', () => {
    const result = parseCatalogImport(
      'construction_objects',
      sheetOf([header, ['msk01', 'ЖК Северный', 'ЖК «Северный»', '', '', '']]),
      snapshot({ objectCodes: new Set(['MSK01']) }),
    );
    expect(rowsOf(result)[0]?.verdict).toBe('duplicate');
  });
});
