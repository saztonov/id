/**
 * Тесты ядра движка (§9.1, §9.6).
 *
 * Проверяется не «функция что-то вернула», а те инварианты, ради которых
 * движок отделён от правил: применимость решается явно, поведение приезжает из
 * снимка, низкая уверенность не даёт `fail`, а «правило прошло» отличимо от
 * «правило не исполнялось».
 */
import { describe, expect, it } from 'vitest';

import {
  RuleRegistryError,
  decideApplicability,
  reconcileRuleRegistry,
  runRules,
} from './engine.js';
import { defect, fromFindings, notApplicable, passed, unknown } from './result.js';
import { makeDocument, makeGraph, makeUnconfiguredProfile, snapshotOf } from './testing.js';
import type { RuleFinding, RuleSpec } from './types.js';

function spec(patch: Partial<RuleSpec> & { readonly code: string }): RuleSpec {
  return {
    title: `Правило ${patch.code}`,
    docTypeCode: null,
    level: 'folder',
    kind: 'crosscheck',
    defaultSeverity: 'error',
    defaultBlocking: false,
    waiverRoles: ['manager'],
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: () => passed(),
    ...patch,
  };
}

const finding = (patch: Partial<RuleFinding> = {}): Omit<RuleFinding, 'state'> => ({
  origin: 'deterministic',
  targetType: 'folder',
  targetId: null,
  message: 'дефект',
  ...patch,
});

describe('reconcileRuleRegistry', () => {
  const specs = [spec({ code: 'A.1' }), spec({ code: 'B.2' })];

  it('пропускает совпадающие множества', () => {
    expect(() => {
      reconcileRuleRegistry(['A.1', 'B.2'], specs);
    }).not.toThrow();
  });

  it('ловит код реестра без реализации', () => {
    try {
      reconcileRuleRegistry(['A.1', 'B.2', 'C.3'], specs);
      expect.unreachable('сверка обязана отказать');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleRegistryError);
      expect((error as RuleRegistryError).missingImplementations).toEqual(['C.3']);
      expect((error as RuleRegistryError).missingDefinitions).toEqual([]);
    }
  });

  it('ловит реализацию без записи в реестре — обратное направление', () => {
    try {
      reconcileRuleRegistry(['A.1'], specs);
      expect.unreachable('сверка обязана отказать');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleRegistryError);
      expect((error as RuleRegistryError).missingDefinitions).toEqual(['B.2']);
    }
  });

  it('без каталога сверка не проходит молча', () => {
    // Забытый второй аргумент означал бы сверку с пустым списком. Она обязана
    // отказать, а не «пройти»: проверка, проходящая при снятой защите, —
    // известная болезнь проекта.
    expect(() => {
      reconcileRuleRegistry(['A.1']);
    }).toThrow(RuleRegistryError);
  });
});

describe('применимость (§9.1)', () => {
  it('раздел без опубликованного профиля закрывает правила полноты', () => {
    const graph = makeGraph({ profile: makeUnconfiguredProfile() });
    const rule = spec({ code: 'MAT.X', requiresSectionProfile: true });

    expect(decideApplicability(rule, graph)).toBe('профиль раздела не настроен');
  });

  it('настроенный профиль правило не закрывает', () => {
    expect(
      decideApplicability(spec({ code: 'MAT.X', requiresSectionProfile: true }), makeGraph()),
    ).toBeNull();
  });

  it('типо-специфичное правило неприменимо без документов этого вида', () => {
    const graph = makeGraph({ documents: [makeDocument({ docTypeCode: 'declaration' })] });
    const reason = decideApplicability(spec({ code: 'AOSR.X', docTypeCode: 'aosr' }), graph);

    expect(reason).toContain('aosr');
  });

  it('резервный и неуверенный тип НЕ считаются документом своего вида', () => {
    const graph = makeGraph({
      documents: [makeDocument({ docTypeCode: 'aosr', isKnownType: false, isFallbackType: true })],
    });

    expect(
      decideApplicability(spec({ code: 'AOSR.X', docTypeCode: 'aosr' }), graph),
    ).not.toBeNull();
  });
});

describe('исполнение и журнал', () => {
  const specs = [
    spec({ code: 'A.1' }),
    spec({ code: 'B.2', evaluate: () => fromFindings([defect(finding())]) }),
    spec({ code: 'C.3', evaluate: () => notApplicable('нечего проверять') }),
  ];

  it('каждое исполненное правило попадает в журнал с вердиктом', () => {
    const result = runRules(makeGraph(), {
      specs,
      snapshot: snapshotOf(specs),
      enabledRuleCodes: null,
    });

    expect(result.executions.map((execution) => execution.ruleCode)).toEqual(['A.1', 'B.2', 'C.3']);
    expect(result.executions.map((execution) => execution.verdict)).toEqual([
      'pass',
      'fail',
      'n_a',
    ]);
    expect(result.counts).toMatchObject({ executed: 3, passed: 1, failed: 1, notApplicable: 1 });
  });

  it('правило вне enabled_rule_codes профиля НЕ исполняется', () => {
    const result = runRules(makeGraph(), {
      specs,
      snapshot: snapshotOf(specs),
      enabledRuleCodes: ['A.1'],
    });

    expect(result.executions.map((execution) => execution.ruleCode)).toEqual(['A.1']);
    expect(result.skipped).toEqual({ 'B.2': 'not_in_profile', 'C.3': 'not_in_profile' });
    // «Не исполнялось» и «прошло» — разные состояния, и второе не покрывает первое.
    expect(result.counts.passed).toBe(1);
    expect(result.counts.skipped).toBe(2);
  });

  it('выключенное в снимке правило не исполняется', () => {
    const snapshot = snapshotOf(specs).map((entry) =>
      entry.ruleCode === 'B.2' ? { ...entry, isEnabled: false } : entry,
    );
    const result = runRules(makeGraph(), { specs, snapshot, enabledRuleCodes: null });

    expect(result.skipped['B.2']).toBe('disabled_in_snapshot');
  });

  it('кода нет в снимке — правило не исполняется и это видно', () => {
    const snapshot = snapshotOf(specs).filter((entry) => entry.ruleCode !== 'C.3');
    const result = runRules(makeGraph(), { specs, snapshot, enabledRuleCodes: null });

    expect(result.skipped['C.3']).toBe('absent_from_snapshot');
  });

  it('исключение правила роняет прогон, а не превращается в «замечаний нет»', () => {
    const boom = spec({
      code: 'X.9',
      evaluate: () => {
        throw new Error('деление на ноль');
      },
    });

    expect(() =>
      runRules(makeGraph(), {
        specs: [boom],
        snapshot: snapshotOf([boom]),
        enabledRuleCodes: null,
      }),
    ).toThrow(/X\.9 упало: деление на ноль/u);
  });

  it('несогласованный результат правила — отказ', () => {
    const liar = spec({
      code: 'X.8',
      evaluate: () => ({ verdict: 'pass', findings: [defect(finding())] }),
    });

    expect(() =>
      runRules(makeGraph(), {
        specs: [liar],
        snapshot: snapshotOf([liar]),
        enabledRuleCodes: null,
      }),
    ).toThrow(/несогласованный результат/u);
  });
});

describe('поведение приезжает из снимка, а не из кода', () => {
  const rule = spec({
    code: 'S.1',
    defaultSeverity: 'error',
    defaultBlocking: false,
    evaluate: () => fromFindings([defect(finding())]),
  });

  it('severity и blocking берутся из снимка', () => {
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: [
        { ruleCode: 'S.1', isEnabled: true, severity: 'error', isBlocking: true, params: {} },
      ],
      enabledRuleCodes: null,
    });

    expect(result.findings[0]).toMatchObject({ severity: 'error', isBlocking: true });
  });

  it('снимок с warning снимает блокировку', () => {
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: [
        { ruleCode: 'S.1', isEnabled: true, severity: 'warning', isBlocking: true, params: {} },
      ],
      enabledRuleCodes: null,
    });

    expect(result.findings[0]).toMatchObject({ severity: 'warning', isBlocking: false });
  });

  it('правило может понизить тяжесть, но не поднять', () => {
    const lowering = spec({
      code: 'S.2',
      evaluate: () => fromFindings([defect({ ...finding(), severityOverride: 'info' })]),
    });
    const raising = spec({
      code: 'S.3',
      evaluate: () => fromFindings([defect({ ...finding(), severityOverride: 'error' })]),
    });
    const snapshot = [
      { ruleCode: 'S.2', isEnabled: true, severity: 'error', isBlocking: false, params: {} },
      { ruleCode: 'S.3', isEnabled: true, severity: 'warning', isBlocking: false, params: {} },
    ] as const;

    const result = runRules(makeGraph(), {
      specs: [lowering, raising],
      snapshot: [...snapshot],
      enabledRuleCodes: null,
    });

    expect(result.findings.find((item) => item.ruleCode === 'S.2')?.severity).toBe('info');
    expect(result.findings.find((item) => item.ruleCode === 'S.3')?.severity).toBe('warning');
  });
});

describe('троичная логика и запреты §9.1', () => {
  const withConfidence = (confidence: number | null): RuleSpec =>
    spec({
      code: 'K.1',
      evaluate: () => fromFindings([defect({ ...finding(), confidence })]),
    });

  it('высокая уверенность даёт fail', () => {
    const rule = withConfidence(0.95);
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: snapshotOf([rule]),
      enabledRuleCodes: null,
    });

    expect(result.executions[0]?.verdict).toBe('fail');
    expect(result.findings[0]?.state).toBe('open');
  });

  it('низкая уверенность НИКОГДА не даёт fail — тот же факт становится undetermined', () => {
    const rule = withConfidence(0.3);
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: snapshotOf([rule]),
      enabledRuleCodes: null,
    });

    expect(result.executions[0]?.verdict).toBe('undetermined');
    expect(result.findings[0]?.state).toBe('undetermined');
    expect(result.findings[0]?.message).toContain('требуется ручная проверка');
  });

  it('порог берётся из параметров снимка, а не из кода правила', () => {
    const rule = withConfidence(0.6);
    const strict = runRules(makeGraph(), {
      specs: [rule],
      snapshot: [
        {
          ruleCode: 'K.1',
          isEnabled: true,
          severity: 'error',
          isBlocking: false,
          params: { minConfidence: 0.9 },
        },
      ],
      enabledRuleCodes: null,
    });
    const lenient = runRules(makeGraph(), {
      specs: [rule],
      snapshot: [
        {
          ruleCode: 'K.1',
          isEnabled: true,
          severity: 'error',
          isBlocking: false,
          params: { minConfidence: 0.5 },
        },
      ],
      enabledRuleCodes: null,
    });

    expect(strict.executions[0]?.verdict).toBe('undetermined');
    expect(lenient.executions[0]?.verdict).toBe('fail');
  });

  it('уверенность не сообщена — понижения нет (защита не глушит проверку)', () => {
    const rule = withConfidence(null);
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: snapshotOf([rule]),
      enabledRuleCodes: null,
    });

    expect(result.executions[0]?.verdict).toBe('fail');
  });

  it('undetermined не бывает блокирующим', () => {
    const rule = spec({
      code: 'U.1',
      evaluate: () => fromFindings([unknown(finding())]),
    });
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: [
        { ruleCode: 'U.1', isEnabled: true, severity: 'error', isBlocking: true, params: {} },
      ],
      enabledRuleCodes: null,
    });

    expect(result.findings[0]?.isBlocking).toBe(false);
  });

  it('находка LLM не блокирует без подтверждения инженером', () => {
    const rule = spec({
      code: 'L.1',
      evaluate: () => fromFindings([defect({ ...finding(), origin: 'llm' })]),
    });
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: [
        { ruleCode: 'L.1', isEnabled: true, severity: 'error', isBlocking: true, params: {} },
      ],
      enabledRuleCodes: null,
    });

    expect(result.findings[0]).toMatchObject({ origin: 'llm', isBlocking: false, state: 'open' });
  });

  it('замечание недоступного внешнего реестра не блокирует и не является ошибкой факта', () => {
    const rule = spec({
      code: 'E.1',
      requiresExternalRegistry: 'sro',
      evaluate: () =>
        fromFindings([
          {
            ...finding({ message: 'членство в СРО: требуется ручная проверка' }),
            state: 'undetermined',
            origin: 'external_unavailable',
          },
        ]),
    });
    const result = runRules(makeGraph(), {
      specs: [rule],
      snapshot: [
        { ruleCode: 'E.1', isEnabled: true, severity: 'error', isBlocking: true, params: {} },
      ],
      enabledRuleCodes: null,
    });

    expect(result.findings[0]).toMatchObject({
      origin: 'external_unavailable',
      isBlocking: false,
      state: 'undetermined',
    });
    expect(result.counts.externalUnavailable).toBe(1);
  });
});
