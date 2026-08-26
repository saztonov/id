/**
 * Печать строк отчёта (S29).
 *
 * Проверяется то, что ломается молча: кому досталась галочка, во что
 * превратилась дата и когда ссылки быть не должно. Экран, который ставит
 * подтверждение непроверенной строке, выглядит исправным.
 */
import { describe, expect, it } from 'vitest';
import type { ReportRow } from '../../api/types.js';
import {
  datesLabel,
  formatDate,
  itemLabel,
  markOf,
  pagesLabel,
  rowHref,
  sectionTally,
  toneOf,
} from './report.js';

const REVISION = '00000000-0000-4000-8000-000000000001';

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
      row({ id: 'a', dates: { issuedAt: null, validFrom: '2023-03-12', validTo: '2026-03-11' } }),
    );
    expect(text).toBe('действует 12.03.2023 — 11.03.2026');
  });

  it('дата выдачи и срок годности читаются вместе', () => {
    const text = datesLabel(
      row({ id: 'a', dates: { issuedAt: '2023-03-12', validFrom: null, validTo: '2024-03-12' } }),
    );
    expect(text).toBe('выдан 12.03.2023, до 12.03.2024');
  });

  it('дат нет — ячейка пустая, а не с прочерком', () => {
    expect(datesLabel(row({ id: 'a', dates: null }))).toBeNull();
    expect(
      datesLabel(row({ id: 'a', dates: { issuedAt: null, validFrom: null, validTo: null } })),
    ).toBeNull();
  });
});

describe('rowHref и pagesLabel', () => {
  it('ведёт на страницу разметки', () => {
    const href = rowHref(REVISION, row({ id: 'a', page: { number: 5, workingPageIndex: 4 } }));
    expect(href).toBe(`/ids/revisions/${REVISION}?tab=markup&page=4`);
  });

  it('выделяет блок замечания, когда он известен (§16)', () => {
    const href = rowHref(
      REVISION,
      row({ id: 'a', page: { number: 5, workingPageIndex: 4 }, blockId: 'blk' }),
    );
    expect(href).toBe(`/ids/revisions/${REVISION}?tab=markup&page=4&block=blk`);
  });

  it('без рабочего документа ссылки нет: неработающая хуже отсутствия', () => {
    expect(
      rowHref(REVISION, row({ id: 'a', page: { number: 5, workingPageIndex: null } })),
    ).toBeNull();
    expect(rowHref(REVISION, row({ id: 'a', page: null }))).toBeNull();
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
    expect(rowHref(REVISION, withFinding)).toContain('page=1');
  });
});

describe('sectionTally', () => {
  it('считает только то, что проверялось', () => {
    const rows = [
      row({ id: 'a', status: 'ok' }),
      row({ id: 'b', status: 'error' }),
      row({ id: 'c', status: 'unchecked' }),
    ];
    expect(sectionTally(rows)).toBe('1 из 2 без замечаний');
  });

  it('молчит, когда считать нечего', () => {
    // «0 из 0 подтверждено» сообщало бы о работе, которой не было.
    expect(sectionTally([])).toBeNull();
    expect(sectionTally([row({ id: 'a', status: 'unchecked' })])).toBeNull();
  });
});
