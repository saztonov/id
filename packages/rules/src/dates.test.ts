/**
 * Тесты правил дат (§9.2).
 *
 * Фикстуры строятся так, чтобы снятие проверки роняло тест: в каждом
 * отрицательном случае граница сдвинута ровно на одну сторону от порога, а
 * положительный случай отличается от отрицательного ОДНИМ значением. Фикстура,
 * в которой утверждение истинно по построению, доказывает только то, что код
 * исполнился, — а «код исполнился и ничего не проверил» шесть этапов подряд был
 * основным способом получить зелёный гейт при сломанной функции.
 *
 * Семь правил дат и оба правила подписей сняты в S59 (ADR-0029): их
 * поведенческие тесты удалены вместе с телами, и на их месте один блок
 * «снято с исполнения» — кода нет в каталоге, спек остался среди снятых,
 * заглушка отвечает `n_a` с причиной.
 */
import { describe, expect, it } from 'vitest';

import { RETIRED_RULES, RULE_CATALOG } from './catalog.js';
import { DATE_RULES, SIGNATURE_RULES } from './dates.js';
import { runRules } from './engine.js';
import {
  makeBatch,
  makeDocument,
  makeField,
  makeGraph,
  makeMaterial,
  makeRelation,
  snapshotOf,
} from './testing.js';
import type {
  CheckGraph,
  DocumentNode,
  FieldNode,
  RuleFinding,
  RuleResult,
  RuleSpec,
} from './types.js';

// ---------------------------------------------------------------------------
// Инструменты фикстур
// ---------------------------------------------------------------------------

const ALL_RULES: readonly RuleSpec[] = [...DATE_RULES, ...SIGNATURE_RULES];

/** Снятые в S59: семь правил дат и оба правила подписей. */
const RETIRED_CODES = [
  'DATE.304',
  'DATE.311',
  'DATE.320',
  'DATE.330',
  'DATE.331',
  'DATE.332',
  'DATE.372',
  'SIG.STAMP.370',
  'SIG.PDF.371',
] as const;

function rule(code: string): RuleSpec {
  const spec = ALL_RULES.find((item) => item.code === code);
  if (spec === undefined) throw new Error(`правило ${code} отсутствует в каталоге группы`);
  return spec;
}

function run(code: string, graph: CheckGraph, params?: Record<string, unknown>): RuleResult {
  const spec = rule(code);
  return spec.evaluate(graph, { ...spec.defaultParams, ...params });
}

function findingsOf(result: RuleResult): readonly RuleFinding[] {
  return result.findings ?? [];
}

function messages(result: RuleResult): string {
  return findingsOf(result)
    .map((finding) => finding.message)
    .join(' | ');
}

/** Реквизит-дата с цитатой: замечание обязано быть адресуемым. */
function dateField(fieldCode: string, valueDate: string): FieldNode {
  return makeField({ fieldCode, valueDate });
}

function textField(fieldCode: string, valueText: string): FieldNode {
  return makeField({ fieldCode, valueText });
}

/** Акт освидетельствования: работы 28.02.2026 — 09.03.2026. */
function makeAct(id = 'act-336'): DocumentNode {
  return makeDocument({
    id,
    docTypeCode: 'aosr',
    title: 'Акт освидетельствования скрытых работ',
    fields: [
      textField('number', '336'),
      dateField('date_start', '2026-02-28'),
      dateField('date_end', '2026-03-09'),
      dateField('act_date', '2026-03-09'),
    ],
  });
}

/** Граф «акт плюс приложенные документы»: связь есть, релевантная дата известна. */
function graphWithAct(
  children: readonly DocumentNode[],
  patch: Partial<CheckGraph> = {},
): CheckGraph {
  const act = makeAct();
  return makeGraph({
    documents: [act, ...children],
    relations: children.map((child) =>
      makeRelation({ parentDocumentId: act.id, childDocumentId: child.id }),
    ),
    ...patch,
  });
}

/** Граф без акта: тот же комплект, но связь отсутствует. */
function graphWithoutAct(
  children: readonly DocumentNode[],
  patch: Partial<CheckGraph> = {},
): CheckGraph {
  return makeGraph({ documents: [...children], relations: [], ...patch });
}

function certificate(
  fields: readonly FieldNode[],
  patch: Partial<DocumentNode> = {},
): DocumentNode {
  return makeDocument({
    id: 'doc-cert',
    docTypeCode: 'cert_conformity',
    title: 'Сертификат соответствия',
    fields: [textField('number', 'RU-C-1'), ...fields],
    ...patch,
  });
}

/**
 * Сертификат, действующий на релевантную дату 09.03.2026, у которого до конца
 * срока остаётся `daysLeft` дней. Точка отсчёта — дата окончания работ по акту.
 */
function expiringGraph(validTo: string, patch: Partial<CheckGraph> = {}): CheckGraph {
  return graphWithAct(
    [certificate([dateField('valid_from', '2025-01-01'), dateField('valid_to', validTo)])],
    patch,
  );
}

// ---------------------------------------------------------------------------
// DATE.300
// ---------------------------------------------------------------------------

describe('DATE.300 — интервальный документ действует на релевантную дату', () => {
  it('pass: релевантная дата внутри интервала', () => {
    const graph = graphWithAct([
      certificate([dateField('valid_from', '2025-01-01'), dateField('valid_to', '2027-01-01')]),
    ]);
    expect(run('DATE.300', graph).verdict).toBe('pass');
  });

  it('fail: релевантная дата позже окончания действия', () => {
    const graph = graphWithAct([
      certificate([dateField('valid_from', '2025-01-01'), dateField('valid_to', '2026-01-01')]),
    ]);
    const result = run('DATE.300', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('09.03.2026');
    expect(messages(result)).toContain('01.01.2026');
  });

  it('fail: релевантная дата раньше начала действия', () => {
    const graph = graphWithAct([
      certificate([dateField('valid_from', '2026-06-01'), dateField('valid_to', '2027-01-01')]),
    ]);
    expect(run('DATE.300', graph).verdict).toBe('fail');
  });

  it('undetermined: документ не связан с актом', () => {
    const graph = graphWithoutAct([
      certificate([dateField('valid_from', '2025-01-01'), dateField('valid_to', '2026-01-01')]),
    ]);
    const result = run('DATE.300', graph);
    expect(result.verdict).toBe('undetermined');
    expect(messages(result)).toContain('не связан ребром графа');
  });

  it('n_a: в комплекте нет документов с интервалом действия', () => {
    const graph = graphWithAct([certificate([dateField('issued_at', '2026-01-15')])]);
    const result = run('DATE.300', graph);
    expect(result.verdict).toBe('n_a');
    expect(result.reason).toContain('начала и окончания действия');
  });

  it('работает и на документе неизвестного типа (§9.1, строка 1)', () => {
    const unknownDocument = makeDocument({
      id: 'doc-unknown',
      docTypeCode: null,
      title: 'Неопознанный документ',
      fields: [dateField('valid_from', '2025-01-01'), dateField('valid_to', '2026-01-01')],
    });
    expect(unknownDocument.isKnownType).toBe(false);
    expect(run('DATE.300', graphWithAct([unknownDocument])).verdict).toBe('fail');
  });
});

/**
 * Предупреждение «срок истекает» (S59): документ действует на релевантную
 * дату, но до `valid_to` меньше `expiryWarningDays`. Дефекта нет, замечание
 * есть, и тяжесть у него понижена до предупреждения — снимок говорит `error`.
 */
describe('DATE.300 — предупреждение об истекающем сроке', () => {
  it('действует, но до конца срока 10 дней — открытое замечание с понижением до warning', () => {
    // 19.03.2026 — через 10 дней после окончания работ 09.03.2026.
    const result = run('DATE.300', expiringGraph('2026-03-19'));
    expect(result.verdict).toBe('fail');
    const finding = findingsOf(result)[0];
    expect(finding?.state).toBe('open');
    expect(finding?.severityOverride).toBe('warning');
    expect(finding?.message).toContain('оставалось 10 дн.');
    expect(finding?.message).toContain('меньше 30');
    expect(finding?.hint).toBeTruthy();
  });

  it('через движок: тяжесть warning, блокировки нет', () => {
    // Снимок DATE.300 — `error` и блокирующее. Понижение применяет движок, и
    // только здесь видно, что предупреждение не блокирует комплект.
    const spec = rule('DATE.300');
    const outcome = runRules(expiringGraph('2026-03-19'), {
      specs: [spec],
      snapshot: snapshotOf([spec]),
      enabledRuleCodes: null,
    });
    expect(outcome.executions[0]?.verdict).toBe('fail');
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe('warning');
    expect(outcome.findings[0]?.isBlocking).toBe(false);
    expect(outcome.counts.blocking).toBe(0);
  });

  it('запас 60 дней — pass', () => {
    // Единственное изменённое значение — дата окончания действия.
    expect(run('DATE.300', expiringGraph('2026-05-08')).verdict).toBe('pass');
  });

  it('граница: ровно 30 дней запаса предупреждения не дают', () => {
    // 08.04.2026 — ровно через 30 дней; порог «меньше 30», а не «не больше».
    expect(run('DATE.300', expiringGraph('2026-04-08')).verdict).toBe('pass');
  });

  it('порог из профиля раздела: expiryWarningDays 5 делает 10 дней запасом', () => {
    // Мутация порога: сними чтение `expiryWarningDays` через `threshold()` —
    // профиль перестанет действовать, и тест покраснеет.
    const graph = expiringGraph('2026-03-19');
    const profiled = {
      ...graph,
      profile: { ...graph.profile, thresholds: { expiryWarningDays: 5 } },
    };
    expect(run('DATE.300', profiled).verdict).toBe('pass');
  });

  it('порог из параметров снимка действует, когда профиль молчит', () => {
    const graph = expiringGraph('2026-03-19');
    expect(run('DATE.300', graph, { expiryWarningDays: 5 }).verdict).toBe('pass');
    expect(run('DATE.300', graph, { expiryWarningDays: 15 }).verdict).toBe('fail');
  });

  it('истёкший документ остаётся ошибкой, а не предупреждением', () => {
    // Чувствительность: предупреждение — только про ДЕЙСТВУЮЩИЙ документ.
    const result = run('DATE.300', expiringGraph('2026-03-01'));
    expect(result.verdict).toBe('fail');
    expect(findingsOf(result)[0]?.severityOverride).toBeUndefined();
    expect(messages(result)).toContain('не действовал в этот момент');
  });
});

// ---------------------------------------------------------------------------
// DATE.302
// ---------------------------------------------------------------------------

describe('DATE.302 — документ истёк на дату проверки', () => {
  it('info-замечание: срок окончился до graph.today', () => {
    const graph = graphWithAct([certificate([dateField('valid_to', '2025-01-01')])]);
    const result = run('DATE.302', graph);
    expect(findingsOf(result)).toHaveLength(1);
    expect(messages(result)).toContain('18.08.2026');
    expect(rule('DATE.302').defaultSeverity).toBe('info');
    expect(rule('DATE.302').defaultBlocking).toBe(false);
  });

  it('pass: срок окончания позже даты проверки', () => {
    const graph = graphWithAct([certificate([dateField('valid_to', '2027-01-01')])]);
    expect(run('DATE.302', graph).verdict).toBe('pass');
  });

  it('не зависит от связи с актом: срабатывает и без неё', () => {
    const graph = graphWithoutAct([certificate([dateField('valid_to', '2025-01-01')])]);
    expect(findingsOf(run('DATE.302', graph))).toHaveLength(1);
  });

  it('n_a: нет документов с датой окончания действия', () => {
    const graph = graphWithAct([certificate([dateField('issued_at', '2026-01-15')])]);
    expect(run('DATE.302', graph).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// DATE.303
// ---------------------------------------------------------------------------

describe('DATE.303 — документ ещё не действовал на релевантную дату', () => {
  it('pass: начало действия раньше релевантной даты', () => {
    const graph = graphWithAct([certificate([dateField('valid_from', '2025-01-01')])]);
    expect(run('DATE.303', graph).verdict).toBe('pass');
  });

  it('fail: начало действия позже релевантной даты', () => {
    const graph = graphWithAct([certificate([dateField('valid_from', '2026-06-01')])]);
    const result = run('DATE.303', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('01.06.2026');
  });

  it('undetermined: релевантная дата не определена', () => {
    const graph = graphWithoutAct([certificate([dateField('valid_from', '2026-06-01')])]);
    expect(run('DATE.303', graph).verdict).toBe('undetermined');
  });

  it('n_a: нет документов с датой начала действия', () => {
    const graph = graphWithAct([certificate([dateField('valid_to', '2027-01-01')])]);
    expect(run('DATE.303', graph).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// DATE.310
// ---------------------------------------------------------------------------

describe('DATE.310 — разовый документ выдан не позже применения', () => {
  it('pass: выдан до окончания работ', () => {
    const graph = graphWithAct([certificate([dateField('issued_at', '2026-01-15')])]);
    expect(run('DATE.310', graph).verdict).toBe('pass');
  });

  it('fail: выдан после окончания работ', () => {
    const graph = graphWithAct([certificate([dateField('issued_at', '2026-05-01')])]);
    const result = run('DATE.310', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('01.05.2026');
    expect(messages(result)).toContain('09.03.2026');
  });

  it('undetermined: релевантная дата не определена', () => {
    const graph = graphWithoutAct([certificate([dateField('issued_at', '2026-05-01')])]);
    expect(run('DATE.310', graph).verdict).toBe('undetermined');
  });

  it('n_a: у документа есть интервал действия — это дело DATE.300', () => {
    const graph = graphWithAct([
      certificate([dateField('issued_at', '2026-05-01'), dateField('valid_to', '2027-01-01')]),
    ]);
    expect(run('DATE.310', graph).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// DATE.312
// ---------------------------------------------------------------------------

function graphWithBatch(manufacturedAt: string | null, linked = true): CheckGraph {
  const quality = makeDocument({
    id: 'doc-mill',
    docTypeCode: 'mill_certificate',
    title: 'Сертификат качества на арматуру',
    fields: [textField('number', 'A-1')],
  });
  const material = makeMaterial({
    nameRaw: 'Арматура А500С ⌀12',
    batches: [makeBatch({ batchNo: '12', manufacturedAt, documentIds: ['doc-mill'] })],
    documentIds: ['doc-mill'],
  });
  return linked
    ? graphWithAct([quality], { materials: [material] })
    : graphWithoutAct([quality], { materials: [material] });
}

describe('DATE.312 — партия изготовлена не позже применения', () => {
  it('pass: партия изготовлена до окончания работ', () => {
    expect(run('DATE.312', graphWithBatch('2026-01-09')).verdict).toBe('pass');
  });

  it('fail: партия изготовлена после окончания работ', () => {
    const result = run('DATE.312', graphWithBatch('2026-05-01'));
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('01.05.2026');
    expect(messages(result)).toContain('09.03.2026');
  });

  it('undetermined: дата изготовления партии не распознана', () => {
    expect(run('DATE.312', graphWithBatch(null)).verdict).toBe('undetermined');
  });

  it('undetermined: партия не связана с актом', () => {
    expect(run('DATE.312', graphWithBatch('2026-05-01', false)).verdict).toBe('undetermined');
  });

  it('n_a: в комплекте нет партий', () => {
    expect(run('DATE.312', graphWithAct([certificate([])])).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// Снятые в S59
// ---------------------------------------------------------------------------

/**
 * По образцу `AOSR.ACT.032` (S30). Отметка о продлении, «абсурдно старый»,
 * сохраняемость смеси, аккредитация и поверка, протокол против партий — вне
 * минимального набора; подписей портал не ставит и не проверяет.
 */
describe('DATE.304/311/320/330/331/332/372 и SIG.* — сняты с исполнения (S59, ADR-0029)', () => {
  it('кодов нет в каталоге правил', () => {
    for (const code of RETIRED_CODES) {
      expect(
        RULE_CATALOG.some((spec) => spec.code === code),
        code,
      ).toBe(false);
    }
  });

  it('спеки остались в группе и среди снятых — ради контрольных сумм применённых миграций', () => {
    const retired = RETIRED_RULES.map((spec) => spec.code);
    for (const code of RETIRED_CODES) {
      expect(
        ALL_RULES.some((spec) => spec.code === code),
        code,
      ).toBe(true);
      expect(retired, code).toContain(code);
    }
  });

  it('заглушка отвечает n_a «правило снято с исполнения» на любом графе', () => {
    const graphs = [
      graphWithAct([certificate([dateField('valid_to', '2025-01-01')])]),
      makeGraph(),
    ];
    for (const graph of graphs) {
      for (const code of RETIRED_CODES) {
        const result = run(code, graph);
        expect(result.verdict, code).toBe('n_a');
        expect(result.reason, code).toBe('правило снято с исполнения');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Троичная логика
// ---------------------------------------------------------------------------

/**
 * Комплект, в котором ЕСТЬ все реквизиты, но НЕТ ни одного акта и ни одной
 * связи. Каждое значение подобрано так, чтобы дефектом было только незнание
 * релевантной даты: сроки не истекли на дату проверки.
 */
function unlinkedGraph(): CheckGraph {
  const cert = makeDocument({
    id: 'doc-cert',
    docTypeCode: 'cert_conformity',
    title: 'Сертификат соответствия',
    fields: [
      textField('number', 'RU-C-1'),
      dateField('valid_from', '2025-01-01'),
      dateField('valid_to', '2027-01-01'),
    ],
  });
  const passport = makeDocument({
    id: 'doc-passport',
    docTypeCode: 'quality_passport',
    title: 'Паспорт качества',
    fields: [textField('number', 'П-1'), dateField('issued_at', '2015-01-01')],
  });
  return makeGraph({
    documents: [cert, passport],
    relations: [],
    materials: [
      makeMaterial({
        nameRaw: 'Арматура А500С ⌀12',
        batches: [
          makeBatch({ batchNo: '12', manufacturedAt: '2026-01-09', documentIds: ['doc-mill'] }),
        ],
        documentIds: ['doc-mill'],
      }),
    ],
  });
}

describe('троичная логика: неизвестная релевантная дата не даёт fail', () => {
  const graph = unlinkedGraph();

  for (const spec of ALL_RULES) {
    it(`${spec.code} не объявляет fail`, () => {
      const result = spec.evaluate(graph, spec.defaultParams);
      expect(result.verdict).not.toBe('fail');
      expect(findingsOf(result).every((finding) => finding.state !== 'open')).toBe(true);
    });
  }

  it('фикстура не пуста: правила, зависящие от связи, дают именно undetermined', () => {
    const verdicts = new Map(
      ALL_RULES.map((spec) => [spec.code, spec.evaluate(graph, spec.defaultParams).verdict]),
    );
    // DATE.320 и DATE.372 из этого списка ушли: они сняты и отвечают `n_a`
    // независимо от связи — их «не fail» доказывается блоком снятых выше.
    for (const code of ['DATE.300', 'DATE.303', 'DATE.310', 'DATE.312']) {
      expect(verdicts.get(code), code).toBe('undetermined');
    }
    // DATE.302 не зависит от связи и на неистёкшем документе обязан быть pass —
    // иначе «не fail» выше доказывалось бы неприменимостью, а не логикой.
    expect(verdicts.get('DATE.302')).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Прогон через движок
// ---------------------------------------------------------------------------

describe('прогон группы через движок', () => {
  it('все коды группы дат попадают в журнал исполнения — снятые тоже, с вердиктом n_a', () => {
    const result = runRules(expiringGraph('2026-03-19'), {
      specs: DATE_RULES,
      snapshot: snapshotOf(DATE_RULES),
      enabledRuleCodes: null,
    });
    const executed = result.executions.map((execution) => execution.ruleCode).sort();
    expect(executed).toEqual([...DATE_RULES].map((spec) => spec.code).sort());
    expect(result.counts.executed).toBe(DATE_RULES.length);
    expect(Object.keys(result.skipped)).toHaveLength(0);
    for (const code of RETIRED_CODES) {
      const execution = result.executions.find((item) => item.ruleCode === code);
      if (execution === undefined) continue;
      expect(execution.verdict, code).toBe('n_a');
      // DATE.320 привязано к виду `mix_quality_doc`: без таких документов
      // движок отвечает «неприменимо» ещё до заглушки, и до причины снятия
      // дело не доходит. У остальных привязки нет — причина именно снятие.
      if (rule(code).docTypeCode === null) {
        expect(execution.reason, code).toBe('правило снято с исполнения');
      } else {
        expect(execution.reason, code).toContain('нет документов вида');
      }
    }
  });

  it('истекающий срок доезжает до замечания DATE.300 с тяжестью warning и без блокировки', () => {
    const result = runRules(expiringGraph('2026-03-19'), {
      specs: [...DATE_RULES, ...SIGNATURE_RULES],
      snapshot: snapshotOf([...DATE_RULES, ...SIGNATURE_RULES]),
      enabledRuleCodes: null,
    });
    const finding = result.findings.find((item) => item.ruleCode === 'DATE.300');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.isBlocking).toBe(false);
    expect(finding?.message).toContain('оставалось 10 дн.');
    expect(result.findings.filter((item) => item.ruleCode === 'DATE.300')).toHaveLength(1);
    // Единственный сосед в прогоне — DATE.302: на дату проверки (18.08.2026)
    // этот сертификат уже истёк, и это «к сведению», а не дефект комплекта.
    expect(result.findings.map((item) => [item.ruleCode, item.severity])).toEqual([
      ['DATE.300', 'warning'],
      ['DATE.302', 'info'],
    ]);
  });

  it('низкая уверенность источника понижает fail до undetermined (§9.1)', () => {
    const graph = graphWithAct([
      certificate([
        makeField({ fieldCode: 'valid_from', valueDate: '2025-01-01' }),
        makeField({
          fieldCode: 'valid_to',
          valueDate: '2026-01-01',
          confidence: 0.3,
          blockType: 'stamp',
        }),
      ]),
    ]);
    const spec = rule('DATE.300');
    expect(spec.evaluate(graph, spec.defaultParams).verdict).toBe('fail');

    const result = runRules(graph, {
      specs: [spec],
      snapshot: snapshotOf([spec]),
      enabledRuleCodes: null,
    });
    expect(result.executions[0]?.verdict).toBe('undetermined');
    expect(result.counts.blocking).toBe(0);
  });

  it('коды вне профиля не исполняются и это видно в журнале', () => {
    const result = runRules(expiringGraph('2026-03-19'), {
      specs: DATE_RULES,
      snapshot: snapshotOf(DATE_RULES),
      enabledRuleCodes: ['DATE.300'],
    });
    expect(result.executions.map((execution) => execution.ruleCode)).toEqual(['DATE.300']);
    expect(result.skipped['DATE.302']).toBe('not_in_profile');
  });
});

// ---------------------------------------------------------------------------
// Каталог группы
// ---------------------------------------------------------------------------

describe('каталог группы', () => {
  it('коды и порядок соответствуют §9.2', () => {
    // Список включает снятые коды: спеки остаются в группе ради применённой
    // миграции сида 0017, действующий состав задаёт `catalog.ts`.
    expect(DATE_RULES.map((spec) => spec.code)).toEqual([
      'DATE.300',
      'DATE.302',
      'DATE.303',
      'DATE.304',
      'DATE.310',
      'DATE.311',
      'DATE.312',
      'DATE.320',
      'DATE.330',
      'DATE.331',
      'DATE.332',
      'DATE.372',
    ]);
    expect(SIGNATURE_RULES.map((spec) => spec.code)).toEqual(['SIG.STAMP.370', 'SIG.PDF.371']);
  });

  it('внешний реестр не объявлен ни у одного правила группы', () => {
    // До S59 здесь ожидалось `['DATE.332']` с реестром `accreditation`.
    // Правило снято, и требование реестра снято вместе с ним: поле в сид не
    // попадает, а отчёт прогона не должен обещать проверку, которой нет.
    const external = ALL_RULES.filter((spec) => spec.requiresExternalRegistry !== null);
    expect(external.map((spec) => spec.code)).toEqual([]);
  });

  it('ни одно правило группы не требует профиля раздела', () => {
    expect(ALL_RULES.every((spec) => !spec.requiresSectionProfile)).toBe(true);
  });

  it('каждое замечание группы несёт способ устранения', () => {
    const graphs = [
      expiringGraph('2026-03-19'),
      expiringGraph('2026-03-01'),
      unlinkedGraph(),
      graphWithBatch('2026-05-01'),
    ];
    for (const graph of graphs) {
      for (const spec of ALL_RULES) {
        for (const finding of findingsOf(spec.evaluate(graph, spec.defaultParams))) {
          expect(finding.hint, `${spec.code}: ${finding.message}`).toBeTruthy();
          expect(finding.message.length).toBeGreaterThan(20);
        }
      }
    }
  });
});
