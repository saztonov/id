/**
 * Прогон правил по комплектам (S44).
 *
 * Проверяется ровно то, ради чего разбиение заведено: правило видит документы
 * СВОЕГО комплекта и не видит соседний, а правило уровня папки продолжает
 * видеть всё. Плюс инвариант ADR-0018 — каждое замечание ровно один раз.
 */
import { describe, expect, it } from 'vitest';

import { groupByComplect, runRulesByComplect, subgraphOfDocuments } from './complect-run.js';
import { makeDocument, makeGraph } from './testing.js';
import { defect, fromFindings } from './result.js';
import type { CheckGraph, RuleSpec } from './types.js';

const COMPLECT_A = 'c-a';
const COMPLECT_B = 'c-b';

function graphOf() {
  return makeGraph({
    documents: [
      makeDocument({ id: 'act-a', ordinal: 1, complectId: COMPLECT_A, docTypeCode: 'aosr' }),
      makeDocument({
        id: 'cert-a',
        ordinal: 2,
        complectId: COMPLECT_A,
        docTypeCode: 'cert_conformity',
      }),
      makeDocument({ id: 'act-b', ordinal: 3, complectId: COMPLECT_B, docTypeCode: 'aosr' }),
      makeDocument({
        id: 'cert-b',
        ordinal: 4,
        complectId: COMPLECT_B,
        docTypeCode: 'cert_conformity',
      }),
      makeDocument({
        id: 'opis',
        ordinal: 5,
        complectId: null,
        docTypeCode: 'transfer_registry',
      }),
    ],
  });
}

/** Правило, сообщающее в замечании, сколько документов оно увидело. */
function countingRule(code: string, level: RuleSpec['level']): RuleSpec {
  const spec: Pick<RuleSpec, 'code' | 'level' | 'docTypeCode' | 'defaultParams' | 'evaluate'> = {
    code,
    level,
    docTypeCode: null,
    defaultParams: {},
    evaluate: (graph: CheckGraph) =>
      fromFindings([
        defect({
          origin: 'deterministic',
          targetType: 'document',
          targetId: graph.documents[0]?.id ?? null,
          message: `видно документов: ${String(graph.documents.length)}`,
        }),
      ]),
  };
  return spec as RuleSpec;
}

function snapshotOf(codes: readonly string[]) {
  return codes.map((ruleCode) => ({
    ruleCode,
    isEnabled: true,
    severity: 'warning' as const,
    isBlocking: false,
    params: {},
  }));
}

describe('groupByComplect', () => {
  it('документы группируются по комплекту, а вне комплектов идут своей группой', () => {
    const groups = groupByComplect(graphOf().documents);

    expect(groups.map((group) => group.complectId)).toEqual([COMPLECT_A, COMPLECT_B, null]);
    expect(groups[0]?.documents.map((document) => document.id)).toEqual(['act-a', 'cert-a']);
    expect(groups[2]?.documents.map((document) => document.id)).toEqual(['opis']);
  });
});

describe('subgraphOfDocuments', () => {
  it('ребро наружу комплекта в подграф не попадает', () => {
    // Связь между комплектами существует (дубликат сертификата), но утверждать
    // по ней что-либо ВНУТРИ одного из них нельзя: у ребра только один конец
    // здесь.
    const graph = {
      ...graphOf(),
      relations: [
        { parentDocumentId: 'act-a', childDocumentId: 'cert-a', relation: 'quality_doc' },
        { parentDocumentId: 'cert-a', childDocumentId: 'cert-b', relation: 'duplicate' },
      ],
    };
    const sub = subgraphOfDocuments(
      graph,
      graph.documents.filter((document) => document.complectId === COMPLECT_A),
    );

    expect(sub.relations).toEqual([
      { parentDocumentId: 'act-a', childDocumentId: 'cert-a', relation: 'quality_doc' },
    ]);
  });

  it('число неразобранных листов остаётся папочным', () => {
    // Обнулить его для комплекта значило бы разрешить правилам полноты вывод
    // «документа нет» как раз там, где оснований для него нет.
    const graph = { ...graphOf(), coverageGaps: 27 };
    const sub = subgraphOfDocuments(graph, [graph.documents[0]!]);

    expect(sub.coverageGaps).toBe(27);
  });
});

describe('runRulesByComplect', () => {
  it('правило комплекта видит свои документы, правило папки — все', () => {
    const scoped = countingRule('TEST.DOC', 'document');
    const folderWide = countingRule('TEST.FOLDER', 'folder');

    const result = runRulesByComplect(graphOf(), {
      specs: [scoped, folderWide],
      snapshot: snapshotOf(['TEST.DOC', 'TEST.FOLDER']),
      enabledRuleCodes: null,
    });

    const messagesOf = (code: string): readonly string[] =>
      result.findings.filter((finding) => finding.ruleCode === code).map((f) => f.message);

    // Три прогона правила уровня документа: два комплекта и «вне комплектов».
    expect(messagesOf('TEST.DOC')).toEqual([
      'видно документов: 2',
      'видно документов: 2',
      'видно документов: 1',
    ]);
    // Правило папки исполнилось ОДИН раз и увидело все пять.
    expect(messagesOf('TEST.FOLDER')).toEqual(['видно документов: 5']);
  });

  it('журнал называет комплект каждого исполнения', () => {
    const result = runRulesByComplect(graphOf(), {
      specs: [countingRule('TEST.DOC', 'document'), countingRule('TEST.FOLDER', 'folder')],
      snapshot: snapshotOf(['TEST.DOC', 'TEST.FOLDER']),
      enabledRuleCodes: null,
    });

    expect(
      result.executions.map((execution) => [execution.ruleCode, execution.complectId]),
    ).toEqual([
      ['TEST.FOLDER', null],
      ['TEST.DOC', COMPLECT_A],
      ['TEST.DOC', COMPLECT_B],
      ['TEST.DOC', null],
    ]);
    expect(result.slices.map((slice) => slice.scope)).toEqual([
      'folder',
      'complect',
      'complect',
      'outside',
    ]);
  });

  it('папка без комплектов проверяется одним прогоном, как до нарезки', () => {
    // Так выглядит отдельно загруженная опись передачи.
    const graph = makeGraph({
      documents: [
        makeDocument({
          id: 'opis',
          ordinal: 1,
          complectId: null,
          docTypeCode: 'transfer_registry',
        }),
      ],
    });

    const result = runRulesByComplect(graph, {
      specs: [countingRule('TEST.DOC', 'document')],
      snapshot: snapshotOf(['TEST.DOC']),
      enabledRuleCodes: null,
    });

    expect(result.slices.map((slice) => slice.scope)).toEqual(['outside']);
    expect(result.findings.map((finding) => finding.message)).toEqual(['видно документов: 1']);
  });

  it('пропуск кода не зависит от комплекта и в счётчик попадает один раз', () => {
    // Пропуск решается снимком и профилем, а не графом: код, выключенный
    // администратором, обязан считаться одним пропущенным, а не тремя.
    const result = runRulesByComplect(graphOf(), {
      specs: [countingRule('TEST.DOC', 'document'), countingRule('TEST.OFF', 'document')],
      snapshot: [
        ...snapshotOf(['TEST.DOC']),
        {
          ruleCode: 'TEST.OFF',
          isEnabled: false,
          severity: 'warning',
          isBlocking: false,
          params: {},
        },
      ],
      enabledRuleCodes: null,
    });

    expect(result.counts.skipped).toBe(1);
    expect(result.skipped['TEST.OFF']).toBe('disabled_in_snapshot');
  });

  it('замечание попадает в итог ровно один раз', () => {
    // Инвариант ADR-0018. Держится тем, что наборы правил прогонов не
    // пересекаются: они разбиение, а не перекрытие.
    const result = runRulesByComplect(graphOf(), {
      specs: [countingRule('TEST.DOC', 'document'), countingRule('TEST.FOLDER', 'folder')],
      snapshot: snapshotOf(['TEST.DOC', 'TEST.FOLDER']),
      enabledRuleCodes: null,
    });

    const keys = result.findings.map(
      (finding) => `${finding.ruleCode}|${finding.targetId ?? ''}|${finding.message}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.counts.findings).toBe(result.findings.length);
  });

  it('правило, не прошедшее ни в один комплект, остаётся неисполненным', () => {
    // Отрицательный контроль к разбиению: пустой каталог даёт пустой итог, а не
    // выдуманное исполнение.
    const result = runRulesByComplect(graphOf(), {
      specs: [],
      snapshot: [],
      enabledRuleCodes: null,
    });

    expect(result.executions).toEqual([]);
    expect(result.slices).toEqual([]);
  });
});
