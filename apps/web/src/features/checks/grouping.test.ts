/**
 * Разбор списка замечаний (S27).
 *
 * Первый unit-тест на этот экран: до сих пор вкладка «Проверка» держалась
 * только на Playwright, то есть проверялась там, где отказ виден позже всего и
 * стоит дороже всего. Здесь проверяется то, что ломается тихо: какая строка в
 * какой секции, что написано вместо номера страницы и когда плашка молчит.
 */
import { describe, expect, it } from 'vitest';
import type { ChecksSummary, Finding } from '../../api/types.js';
import {
  coverageGap,
  markupHref,
  pageLabel,
  runStateOf,
  splitFindings,
  summaryText,
} from './grouping.js';

const REVISION = '00000000-0000-4000-8000-000000000001';

function finding(over: Partial<Finding> & { id: string }): Finding {
  return {
    validationRunId: '00000000-0000-4000-8000-0000000000ff',
    ruleCode: 'DATE.302',
    severity: 'error',
    state: 'open',
    origin: 'deterministic',
    isBlocking: false,
    targetType: 'document',
    targetId: null,
    sourcePageId: null,
    blockId: null,
    message: 'Просрочена дата действия',
    hint: null,
    text: 'Просрочена дата действия',
    page: null,
    document: null,
    target: { kind: 'document', label: 'Сертификат соответствия', detail: null },
    evidence: [],
    ...over,
  };
}

function summary(over: Partial<ChecksSummary> = {}): ChecksSummary {
  return {
    latestRun: { id: 'run-1', startedAt: '2026-08-25T10:00:00.000Z', finishedAt: '2026-08-25T10:01:00.000Z' },
    shownRunId: 'run-1',
    coverage: {
      pagesTotal: 18,
      pagesRecognized: 18,
      pagesAssigned: 18,
      pagesUnassigned: 0,
      unassignedPageNumbers: [],
      documentsTotal: 6,
      documentsUnknownType: 0,
    },
    counts: { openErrors: 0, openWarnings: 0, openInfo: 0, undetermined: 0, waived: 0 },
    ...over,
  };
}

describe('splitFindings', () => {
  it('разводит замечания со страницей и без неё по разным секциям', () => {
    const sections = splitFindings([
      finding({ id: 'a', page: { number: 5, workingPageIndex: 4, basis: 'finding' } }),
      finding({ id: 'b' }),
    ]);

    expect(sections.onPages.map((item) => item.id)).toEqual(['a']);
    expect(sections.onBundle.map((item) => item.id)).toEqual(['b']);
  });

  it('показывает «не проверено» вместе с ошибками, а не прячет', () => {
    // Троичная логика §9.1 видна на экране: `undetermined` — это «данных для
    // вывода нет», отдельное состояние, а не мягкая ошибка. Спрятать его
    // значило бы утверждать, что проверка прошла, там где её не было.
    const sections = splitFindings([
      finding({ id: 'a', state: 'undetermined', page: { number: 1, workingPageIndex: 0, basis: 'finding' } }),
    ]);

    expect(sections.onPages).toHaveLength(1);
  });

  it('снятые замечания уходят в свой список и не смешиваются с открытыми', () => {
    // Решение руководителя юридически значимо и не имеет права исчезнуть
    // бесследно, но и стоять в списке «что не так» ему нечего: оно уже снято.
    const sections = splitFindings([
      finding({ id: 'a', state: 'waived' }),
      finding({ id: 'b', state: 'open' }),
    ]);

    expect(sections.waived.map((item) => item.id)).toEqual(['a']);
    expect(sections.onBundle.map((item) => item.id)).toEqual(['b']);
  });

  it('устранённые не показываются вовсе', () => {
    const sections = splitFindings([finding({ id: 'a', state: 'resolved' })]);
    expect([...sections.onPages, ...sections.onBundle, ...sections.waived]).toHaveLength(0);
  });

  it('порядок сервера сохраняется — вторая сортировка на клиенте не делается', () => {
    const sections = splitFindings([
      finding({ id: 'b', page: { number: 9, workingPageIndex: 8, basis: 'finding' } }),
      finding({ id: 'a', page: { number: 2, workingPageIndex: 1, basis: 'finding' } }),
    ]);

    expect(sections.onPages.map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('pageLabel', () => {
  it('печатает номер страницы, когда адрес точный', () => {
    expect(pageLabel(finding({ id: 'a', page: { number: 5, workingPageIndex: 4, basis: 'finding' } }))).toBe('5');
  });

  it('называет приблизительность, когда номер выведен из начала документа', () => {
    // Срок действия может стоять на любом листе документа. «Страница 5» здесь
    // отправила бы проверяющего смотреть не туда и заявила бы точность,
    // которой у портала нет.
    expect(
      pageLabel(finding({ id: 'a', page: { number: 5, workingPageIndex: 4, basis: 'document' } })),
    ).toBe('Документ со стр. 5');
  });
});

describe('markupHref', () => {
  it('ведёт на страницу разметки и выделяет блок', () => {
    const href = markupHref(
      REVISION,
      finding({ id: 'a', blockId: 'blk', page: { number: 5, workingPageIndex: 4, basis: 'finding' } }),
    );
    expect(href).toBe(`/ids/revisions/${REVISION}?tab=markup&page=4&block=blk`);
  });

  it('не рисует ссылку, когда рабочий документ не собран', () => {
    // Неработающая ссылка хуже её отсутствия: по ней нажмут.
    expect(
      markupHref(REVISION, finding({ id: 'a', page: { number: 5, workingPageIndex: null, basis: 'document' } })),
    ).toBeNull();
  });
});

describe('runStateOf', () => {
  it('различает «проверки не было» и «комплект изменился»', () => {
    // Оба состояния выглядят одинаково пустым экраном и означают разное:
    // в первом надо нажать кнопку, во втором — знать, что список описывает
    // прежний состав.
    expect(runStateOf(summary({ latestRun: null, shownRunId: null }), true)).toEqual({ kind: 'never' });
    expect(runStateOf(summary(), false)).toEqual({ kind: 'stale' });
    expect(runStateOf(summary(), true)).toEqual({ kind: 'done' });
  });

  it('во время повторной проверки называет её и оставляет прежний результат', () => {
    const state = runStateOf(
      summary({
        latestRun: { id: 'run-2', startedAt: '2026-08-25T11:00:00.000Z', finishedAt: null },
        shownRunId: 'run-1',
      }),
      true,
    );
    expect(state).toEqual({ kind: 'running_over_previous', since: '2026-08-25T11:00:00.000Z' });
  });

  it('первый прогон без предыдущего результата — просто «выполняется»', () => {
    const state = runStateOf(
      summary({
        latestRun: { id: 'run-1', startedAt: '2026-08-25T11:00:00.000Z', finishedAt: null },
        shownRunId: null,
      }),
      true,
    );
    expect(state).toEqual({ kind: 'running' });
  });
});

describe('summaryText', () => {
  it('отвечает на вопрос «что прочитано и что нашлось»', () => {
    const text = summaryText(
      summary({ counts: { openErrors: 7, openWarnings: 3, openInfo: 0, undetermined: 0, waived: 0 } }),
    );
    expect(text).toBe('Распознано 18 страниц из 18, разобрано 6 документов. Найдено: 7 ошибок, 3 предупреждения.');
  });

  it('пустой результат называется словами, а не пустой строкой', () => {
    expect(summaryText(summary())).toContain('Ошибок не найдено.');
  });
});

describe('coverageGap', () => {
  it('молчит, когда покрыто всё', () => {
    expect(coverageGap(summary())).toBeNull();
  });

  it('называет непокрытое числом и номерами страниц', () => {
    const text = coverageGap(
      summary({
        coverage: {
          pagesTotal: 18,
          pagesRecognized: 18,
          pagesAssigned: 16,
          pagesUnassigned: 2,
          unassignedPageNumbers: [7, 12],
          documentsTotal: 6,
          documentsUnknownType: 1,
        },
      }),
    );
    expect(text).toBe(
      'Портал не отнёс к документам 2 страницы (7, 12) и не определил вид у 1 документа. ' +
        'Часть проверок по ним не выполнялась.',
    );
  });

  it('длинный список номеров обрезается и говорит об остатке', () => {
    const text = coverageGap(
      summary({
        coverage: {
          pagesTotal: 40,
          pagesRecognized: 40,
          pagesAssigned: 0,
          pagesUnassigned: 25,
          unassignedPageNumbers: Array.from({ length: 20 }, (_, index) => index + 1),
          documentsTotal: 0,
          documentsUnknownType: 0,
        },
      }),
    );
    expect(text).toContain('и ещё 5');
  });
});
