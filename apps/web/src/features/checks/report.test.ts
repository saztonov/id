/**
 * Печать строк отчёта (S29).
 *
 * Проверяется то, что ломается молча: кому досталась галочка, во что
 * превратилась дата и когда ссылки быть не должно. Экран, который ставит
 * подтверждение непроверенной строке, выглядит исправным.
 */
import { describe, expect, it } from 'vitest';
import type { ReportRow, ReportSection } from '../../api/types.js';
import {
  datesLabel,
  formatDate,
  itemLabel,
  markOf,
  pagesLabel,
  rowDetailText,
  rowHref,
  rowTagText,
  sectionTally,
  toneOf,
} from './report.js';

const FOLDER = '00000000-0000-4000-8000-000000000001';

function row(over: Partial<ReportRow> & { id: string }): ReportRow {
  return {
    kind: 'document',
    title: 'Сертификат соответствия',
    subtitle: null,
    page: null,
    pages: null,
    dates: null,
    status: 'ok',
    statusText: 'данные верны',
    statusHint: null,
    statusRuleCode: null,
    blockId: null,
    findingIds: [],
    items: [],
    ...over,
  };
}

describe('toneOf и markOf', () => {
  it('галочка достаётся только пройденному', () => {
    expect(markOf('ok')).toBe('✓');
    expect(toneOf('ok')).toBe('success');
  });

  it('непроверенное не выдаётся за успех', () => {
    // Главное утверждение файла: `unchecked`, `not_applicable` и `not_run`
    // означают «портал не знает», и зелёный вид у них был бы ложью.
    for (const status of ['unchecked', 'not_applicable', 'not_run', 'undetermined'] as const) {
      expect(toneOf(status)).toBe('neutral');
      expect(markOf(status)).toBe('—');
    }
  });

  it('ошибка и отсутствие документа читаются одинаково тревожно', () => {
    expect(toneOf('error')).toBe('danger');
    expect(toneOf('missing')).toBe('danger');
    expect(markOf('missing')).toBe('✕');
  });
});

describe('rowTagText и rowDetailText', () => {
  it('длинное замечание уходит ПОД метку, а не на неё', () => {
    // Пока весь текст замечания жил на метке, она растягивала колонку
    // «Результат» на пол-экрана, а «Позиция комплекта» сжималась до одной
    // буквы в строке. Метка не переносится по словам — обычный текст переносится.
    const long = row({
      id: 'a',
      status: 'error',
      statusText: 'Наименование объекта в акте № МР/ОВ1/От/32 не совпадает с карточкой объекта',
    });
    expect(rowTagText(long)).toBe('ошибка');
    expect(rowDetailText(long)).toBe(long.statusText);
  });

  it('у подтверждённой строки метка несёт сам текст, а не слово-дубль', () => {
    const ok = row({ id: 'a', status: 'ok', statusText: 'чек-лист пройден: 19 из 19' });
    expect(rowTagText(ok)).toBe('чек-лист пройден: 19 из 19');
    expect(rowDetailText(ok)).toBeNull();
  });

  it('состояния, где подпись и текст совпадают, не печатаются дважды', () => {
    for (const status of ['missing', 'unchecked'] as const) {
      expect(rowDetailText(row({ id: 'a', status }))).toBeNull();
    }
    expect(rowTagText(row({ id: 'a', status: 'missing' }))).toBe('нет в комплекте');
    expect(rowTagText(row({ id: 'a', status: 'unchecked' }))).toBe('не проверялось');
  });
});

describe('itemLabel', () => {
  it('каждое состояние пункта названо словом, а не кодом движка', () => {
    expect(itemLabel('not_applicable')).toBe('неприменимо');
    expect(itemLabel('not_run')).toBe('не исполнялось');
    expect(itemLabel('undetermined')).toBe('не проверено');
  });
});

describe('formatDate', () => {
  it('печатает дату так, как её пишут в документах', () => {
    expect(formatDate('2024-03-12')).toBe('12.03.2024');
  });

  it('НЕ уводит дату на сутки в западных зонах', () => {
    // Через `new Date('2024-03-12')` дата разбирается как полночь UTC и в
    // зонах западнее превращается в 11.03 — в сроке годности сертификата это
    // «просрочен на день раньше».
    expect(formatDate('2024-01-01')).toBe('01.01.2024');
  });

  it('нераспознанное значение отдаётся как есть, а не пустотой', () => {
    expect(formatDate('не дата')).toBe('не дата');
  });
});

describe('datesLabel', () => {
  it('интервал печатается интервалом', () => {
    const text = datesLabel(
      row({
        id: 'a',
        dates: { issuedAt: null, validFrom: '2023-03-12', validTo: '2026-03-11', composedAt: null },
      }),
    );
    expect(text).toBe('действует 12.03.2023 — 11.03.2026');
  });

  it('дата выдачи и срок годности читаются вместе', () => {
    const text = datesLabel(
      row({
        id: 'a',
        dates: { issuedAt: '2023-03-12', validFrom: null, validTo: '2024-03-12', composedAt: null },
      }),
    );
    expect(text).toBe('выдан 12.03.2023, до 12.03.2024');
  });

  it('акт датируется составлением, а не выдачей', () => {
    // S40. Акт никто не выдаёт: его составляет комиссия. До S40 колонка
    // печатала «выдан 10.04.2023, до 01.08.2026» — обе даты были взяты у
    // документов, названных внутри самого акта.
    const text = datesLabel(
      row({
        id: 'a',
        dates: { issuedAt: null, validFrom: null, validTo: null, composedAt: '2024-11-21' },
      }),
    );
    expect(text).toBe('акт от 21.11.2024');
  });

  it('дат нет — ячейка пустая, а не с прочерком', () => {
    expect(datesLabel(row({ id: 'a', dates: null }))).toBeNull();
    expect(
      datesLabel(
        row({
          id: 'a',
          dates: { issuedAt: null, validFrom: null, validTo: null, composedAt: null },
        }),
      ),
    ).toBeNull();
  });
});

describe('rowHref и pagesLabel', () => {
  it('ведёт на страницу разметки', () => {
    const href = rowHref(FOLDER, row({ id: 'a', page: { number: 5, workingPageIndex: 4 } }));
    expect(href).toBe(`/ids/folders/${FOLDER}?tab=markup&page=4`);
  });

  it('выделяет блок замечания, когда он известен (§16)', () => {
    const href = rowHref(
      FOLDER,
      row({ id: 'a', page: { number: 5, workingPageIndex: 4 }, blockId: 'blk' }),
    );
    expect(href).toBe(`/ids/folders/${FOLDER}?tab=markup&page=4&block=blk`);
  });

  it('без рабочего документа ссылки нет: неработающая хуже отсутствия', () => {
    expect(
      rowHref(FOLDER, row({ id: 'a', page: { number: 5, workingPageIndex: null } })),
    ).toBeNull();
    expect(rowHref(FOLDER, row({ id: 'a', page: null }))).toBeNull();
  });

  it('у строки без замечания печатается диапазон документа', () => {
    expect(
      pagesLabel(row({ id: 'a', pages: '1–3', page: { number: 1, workingPageIndex: 0 } })),
    ).toBe('1–3');
    expect(pagesLabel(row({ id: 'a', page: { number: 8, workingPageIndex: 7 } }))).toBe('8');
    expect(pagesLabel(row({ id: 'a' }))).toBeNull();
  });

  it('у строки с замечанием печатается страница ЗАМЕЧАНИЯ, куда ведёт и ссылка', () => {
    // Иначе колонка звала бы на первый лист акта, а ссылка вела на второй.
    const withFinding = row({
      id: 'a',
      pages: '1–3',
      page: { number: 2, workingPageIndex: 1 },
      statusRuleCode: 'AOSR.HDR.022',
    });
    expect(pagesLabel(withFinding)).toBe('2');
    expect(rowHref(FOLDER, withFinding)).toContain('page=1');
  });
});

describe('sectionTally', () => {
  function section(over: Partial<ReportSection> = {}): ReportSection {
    return { kind: 'quality', title: 'Документы о качестве', note: null, rows: [], ...over };
  }

  it('считает только то, что проверялось', () => {
    const rows = [
      row({ id: 'a', status: 'ok' }),
      row({ id: 'b', status: 'error' }),
      row({ id: 'c', status: 'unchecked' }),
    ];
    expect(sectionTally(section({ rows }))).toBe('1 из 2 без замечаний');
  });

  it('молчит, когда считать нечего', () => {
    // «0 из 0 подтверждено» сообщало бы о работе, которой не было.
    expect(sectionTally(section())).toBeNull();
    expect(sectionTally(section({ rows: [row({ id: 'a', status: 'unchecked' })] }))).toBeNull();
  });

  it('молчит в секции замечаний: там каждая строка и есть замечание', () => {
    // «0 из 7 без замечаний» читается как отчёт о провале там, где считать
    // просто нечего.
    const rows = [row({ id: 'a', status: 'error' }), row({ id: 'b', status: 'warning' })];
    expect(sectionTally(section({ kind: 'unplaced', rows }))).toBeNull();
  });
});
