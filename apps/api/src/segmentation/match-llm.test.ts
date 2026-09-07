/**
 * Слияние решений модели с предфильтром (S57).
 *
 * Проверяются границы, ради которых модуль и написан: точное совпадение
 * неприкосновенно, неопределённость модели не превращается в обвинение
 * комплекту, чужой документ в ответе не принимается, а негодная строка ответа
 * не уносит с собой годные.
 */
import { describe, expect, it } from 'vitest';

import {
  acceptDecisions,
  mergeLlmMatches,
  registryMatchResponseSchema,
  DECISION_FOREIGN_DOCUMENT,
  DECISION_UNKNOWN_ROW,
  type LlmRowDecision,
  type PrefilterRow,
} from './match-llm.js';

const exact: PrefilterRow = {
  rowId: 'row-exact',
  matchState: 'matched',
  matchedDocumentId: 'doc-1',
  matchScore: 1,
  candidates: [],
};

const unresolved: PrefilterRow = {
  rowId: 'row-open',
  matchState: 'missing',
  matchedDocumentId: null,
  matchScore: null,
  candidates: [],
};

function decision(over: Partial<LlmRowDecision> = {}): LlmRowDecision {
  return {
    rowId: 'row-open',
    documentId: 'doc-2',
    reason: 'found',
    basis: 'doc_no',
    confidence: 0.95,
    note: 'номер схемы совпал с точностью до раскладки',
    candidateIds: [],
    checks: [],
    ...over,
  };
}

describe('mergeLlmMatches', () => {
  it('уверенно названный документ становится совпадением с автором «llm»', () => {
    const [row] = mergeLlmMatches([unresolved], [decision()]);
    expect(row?.matchState).toBe('matched');
    expect(row?.matchedDocumentId).toBe('doc-2');
    expect(row?.matchedBy).toBe('llm');
    expect(row?.matchScore).toBe(0.95);
  });

  it('ниже порога документ становится кандидатом, а не совпадением', () => {
    // Порог — параметр пилота: сомнительное решение обязано быть видно
    // проверяющему рядом со строкой, а не выдаваться за найденный документ.
    const [row] = mergeLlmMatches([unresolved], [decision({ confidence: 0.6 })]);
    expect(row?.matchState).toBe('candidate');
    expect(row?.matchedDocumentId).toBeNull();
    expect(row?.candidates[0]?.documentId).toBe('doc-2');
  });

  it('точное совпадение предфильтра модель не переписывает', () => {
    // Посимвольное равенство номера — утверждение более сильное, чем суждение
    // по смыслу. Довод модели при этом сохраняется: сомнение в паре, найденной
    // точно, — первое, что должен увидеть разбирающий.
    const [row] = mergeLlmMatches(
      [exact],
      [
        decision({
          rowId: 'row-exact',
          documentId: 'doc-9',
          note: 'сомневаюсь: организации разные',
        }),
      ],
    );
    expect(row?.matchedDocumentId).toBe('doc-1');
    expect(row?.matchedBy).toBe('rule');
    expect(row?.matchScore).toBe(1);
    expect(row?.matchNote).toContain('сомневаюсь');
  });

  it('точное совпадение сохраняет проверки содержания', () => {
    // Ради них строку и показывали модели: сопоставление верное, а описание
    // может быть ошибочным — для инженера это не менее важно.
    const [row] = mergeLlmMatches(
      [exact],
      [
        decision({
          rowId: 'row-exact',
          checks: [
            {
              kind: 'org',
              rowCell: 'org_raw',
              documentFieldCode: 'executor',
              status: 'mismatch',
              confidence: 0.9,
              message: 'в описи ИП Михальский, в схеме ООО «МАСТЕР»',
              rowQuote: 'ИП Михальский Андрей Владимирович',
              docQuote: 'ООО «МАСТЕР»',
            },
          ],
        }),
      ],
    );
    expect(row?.checks).toHaveLength(1);
    expect(row?.checks[0]?.status).toBe('mismatch');
  });

  it('«нет среди показанных» не превращается в «нет в комплекте»', () => {
    // Выборка ограничена разделом описи: документ, лежащий не в своём разделе,
    // модели не показан вовсе. Объявить его отсутствующим — обвинить комплект в
    // границах собственного поиска.
    const [row] = mergeLlmMatches(
      [unresolved],
      [decision({ reason: 'not_in_scope', documentId: null })],
    );
    expect(row?.matchState).toBe('undetermined');
  });

  it('найденный по номеру в другом разделе становится кандидатом с доводом', () => {
    const [row] = mergeLlmMatches(
      [unresolved],
      [decision({ reason: 'absent', documentId: null })],
      {
        locateInFolder: () => ({ documentId: 'doc-7', where: 'в разделе 7' }),
      },
    );
    expect(row?.matchState).toBe('candidate');
    expect(row?.candidates[0]?.documentId).toBe('doc-7');
    expect(row?.matchNote).toContain('в разделе 7');
  });

  it('отсутствие утверждается только после поиска по всей папке', () => {
    const [row] = mergeLlmMatches(
      [unresolved],
      [decision({ reason: 'absent', documentId: null })],
      {
        locateInFolder: () => null,
      },
    );
    expect(row?.matchState).toBe('missing');
  });

  it('неуверенное «отсутствует» остаётся «не сопоставлено»', () => {
    // Чувствительность к предыдущему: обвинение комплекту требует и поиска по
    // папке, и уверенности модели, а не одного из двух.
    const [row] = mergeLlmMatches(
      [unresolved],
      [decision({ reason: 'absent', documentId: null, confidence: 0.4 })],
      { locateInFolder: () => null },
    );
    expect(row?.matchState).toBe('undetermined');
  });

  it('строка, о которой модель промолчала, не пропадает и не обвиняет', () => {
    const [row] = mergeLlmMatches([unresolved], []);
    expect(row?.matchState).toBe('undetermined');
    expect(row?.matchNote).toContain('не ответила');
  });

  it('точное совпадение переживает молчание модели', () => {
    const [row] = mergeLlmMatches([exact], []);
    expect(row?.matchState).toBe('matched');
    expect(row?.matchedDocumentId).toBe('doc-1');
  });
});

describe('acceptDecisions', () => {
  const scope = {
    rowIds: new Set(['row-1', 'row-2']),
    documentIds: new Set(['doc-1', 'doc-2']),
  };

  function parse(rows: unknown[]): ReturnType<typeof registryMatchResponseSchema.parse> {
    return registryMatchResponseSchema.parse({ rows });
  }

  const good = {
    rowId: 'row-1',
    match: {
      documentId: 'doc-1',
      reason: 'found',
      basis: 'doc_no',
      confidence: 0.9,
      note: 'номер совпал',
    },
    checks: [],
  };

  it('чужой документ в ответе не принимается', () => {
    const outcome = acceptDecisions(
      parse([{ ...good, match: { ...good.match, documentId: 'doc-999' } }]),
      scope,
    );
    expect(outcome.decisions).toHaveLength(0);
    expect(outcome.problems[0]).toContain(DECISION_FOREIGN_DOCUMENT);
  });

  it('негодная строка не уносит с собой годные', () => {
    // Урок llm-extract: единая проверка «годен ли ответ» отбрасывала документ
    // из-за одного значения из тридцати одного.
    const outcome = acceptDecisions(
      parse([
        { ...good, rowId: 'row-404' },
        { ...good, rowId: 'row-2' },
      ]),
      scope,
    );
    expect(outcome.decisions).toHaveLength(1);
    expect(outcome.decisions[0]?.rowId).toBe('row-2');
    expect(outcome.problems[0]).toContain(DECISION_UNKNOWN_ROW);
  });

  it('повтор строки принимается один раз', () => {
    const outcome = acceptDecisions(
      parse([good, { ...good, match: { ...good.match, documentId: 'doc-2' } }]),
      scope,
    );
    expect(outcome.decisions).toHaveLength(1);
    expect(outcome.decisions[0]?.documentId).toBe('doc-1');
    expect(outcome.problems).toHaveLength(1);
  });

  it('кандидаты вне выборки отбрасываются молча, решение остаётся', () => {
    const outcome = acceptDecisions(
      parse([
        { ...good, match: { ...good.match, reason: 'several', candidates: ['doc-2', 'doc-777'] } },
      ]),
      scope,
    );
    expect(outcome.decisions[0]?.candidateIds).toEqual(['doc-2']);
  });
});
