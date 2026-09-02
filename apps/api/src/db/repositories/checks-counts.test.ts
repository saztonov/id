/**
 * Счётчики сводки: дефект бумаги и «портал прочитал иначе» — разное (S44).
 *
 * До S44 всё лежало в одной куче, и на боевой папке 61 из 201 предупреждения
 * были претензией портала к самому себе: «извлечённое значение расходится с
 * текстом». Подрядчику с ней делать нечего — исправлять надо не документ.
 *
 * Набор без БД: `countFindings` — чистая функция, и проверяется здесь ровно
 * граница между двумя видами, а не запрос.
 */
import { describe, expect, it } from 'vitest';

import { countFindings, EXTRACTION_QUALITY_KIND, type FindingView } from './checks.js';

function finding(patch: Partial<FindingView> & { readonly id: string }): FindingView {
  return {
    validationRunId: 'run-1',
    ruleCode: 'AOSR.HDR.010',
    ruleKind: 'header',
    severity: 'warning',
    state: 'open',
    origin: 'deterministic',
    isBlocking: false,
    targetType: 'document',
    targetId: 'doc-1',
    sourcePageId: null,
    blockId: null,
    message: 'сообщение',
    hint: null,
    text: 'сообщение',
    page: null,
    document: null,
    target: { label: 'документ', detail: null },
    evidence: [],
    ...patch,
  } as FindingView;
}

describe('countFindings', () => {
  it('замечание о качестве извлечения не попадает в дефекты документа', () => {
    const counts = countFindings([
      finding({ id: 'f1', severity: 'error' }),
      finding({ id: 'f2', severity: 'warning' }),
      finding({
        id: 'f3',
        ruleCode: 'LLM.FILL.020',
        ruleKind: EXTRACTION_QUALITY_KIND,
        severity: 'warning',
        origin: 'llm',
      }),
    ]);

    expect(counts.openErrors).toBe(1);
    // Ключевое: предупреждение ОДНО, а не два. Именно этой цифрой человек и
    // судит о состоянии комплекта.
    expect(counts.openWarnings).toBe(1);
    expect(counts.extractionQuality).toBe(1);
  });

  it('«не проверено» о качестве извлечения тоже считается отдельно', () => {
    const counts = countFindings([
      finding({ id: 'f1', state: 'undetermined' }),
      finding({
        id: 'f2',
        ruleCode: 'LLM.FILL.020',
        ruleKind: EXTRACTION_QUALITY_KIND,
        state: 'undetermined',
      }),
    ]);

    expect(counts.undetermined).toBe(1);
    expect(counts.extractionQuality).toBe(1);
  });

  it('снятое человеком замечание о качестве извлечения из счётчика не уходит', () => {
    // Счётчик отвечает на вопрос «сколько раз портал прочитал иначе», а он о
    // снятии не спрашивает: снятие говорит о решении человека по замечанию, а
    // не о том, что распознавание вдруг стало верным.
    const counts = countFindings([
      finding({
        id: 'f1',
        ruleCode: 'LLM.FILL.020',
        ruleKind: EXTRACTION_QUALITY_KIND,
        state: 'waived',
      }),
    ]);

    expect(counts.waived).toBe(0);
    expect(counts.extractionQuality).toBe(1);
  });

  it('без таких замечаний счётчик нулевой, а остальные считаются как прежде', () => {
    // Отрицательный контроль: разделение не должно менять поведение там, где
    // разделять нечего.
    const counts = countFindings([
      finding({ id: 'f1', severity: 'error' }),
      finding({ id: 'f2', severity: 'warning' }),
      finding({ id: 'f3', severity: 'info' }),
      finding({ id: 'f4', state: 'undetermined' }),
      finding({ id: 'f5', state: 'waived' }),
    ]);

    expect(counts).toEqual({
      openErrors: 1,
      openWarnings: 1,
      openInfo: 1,
      undetermined: 1,
      waived: 1,
      extractionQuality: 0,
    });
  });
});
