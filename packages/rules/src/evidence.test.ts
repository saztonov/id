/**
 * Тесты группы доказательных документов (§9.4).
 *
 * Тесты чувствительны: у каждого правила есть положительный, отрицательный и
 * неприменимый случай, а у дефекта №5 корпуса — ещё и зеркальная пара,
 * доказывающая, что правило различает дефект и его отсутствие, а не срабатывает
 * всегда. Без такой пары зелёный тест доказывает только то, что функция
 * вызвалась, — известная болезнь проекта (S3, S5, S6, S8).
 *
 * Семь правил группы сняты в S59 (ADR-0029): сравнение факта с нормой, марка
 * стали, марка смеси, прочность по возрасту образца, заключение и привязка
 * схемы. Их поведенческие тесты — вместе с помощниками нормы/факта — удалены
 * с телами правил; на их месте блок «снято с исполнения».
 */
import { describe, expect, it } from 'vitest';

import { RETIRED_RULES, RULE_CATALOG } from './catalog.js';
import { runRules } from './engine.js';
import { EVIDENCE_DOC_TYPES, EVIDENCE_FIELDS, EVIDENCE_RULES } from './evidence.js';
import { makeDocument, makeField, makeGraph, snapshotOf } from './testing.js';
import type { CheckGraph, DocumentNode, RuleParams, RuleResult, RuleSpec } from './types.js';

// ---------------------------------------------------------------------------
// Инструменты
// ---------------------------------------------------------------------------

/** Снятые в S59. */
const RETIRED_CODES = [
  'PASS.610',
  'MILL.630',
  'MIX.640',
  'LAB.650',
  'LAB.651',
  'CONCL.660',
  'SCH.680',
] as const;

function ruleOf(code: string): RuleSpec {
  const spec = EVIDENCE_RULES.find((candidate) => candidate.code === code);
  if (spec === undefined) throw new Error(`в группе нет правила ${code}`);
  return spec;
}

function run(code: string, graph: CheckGraph, params: RuleParams = {}): RuleResult {
  const spec = ruleOf(code);
  return spec.evaluate(graph, { ...spec.defaultParams, ...params });
}

function messages(result: RuleResult): string[] {
  return [...(result.findings ?? [])].map((finding) => finding.message);
}

function joined(result: RuleResult): string {
  return messages(result).join(' | ');
}

/** Комплект из одного документа заданного вида. */
function graphWith(document: DocumentNode, patch: Partial<CheckGraph> = {}): CheckGraph {
  return makeGraph({ documents: [document], ...patch });
}

function dateField(fieldCode: string, value: string) {
  return makeField({ fieldCode, valueDate: value, valueText: value });
}

function textField(fieldCode: string, value: string) {
  return makeField({ fieldCode, valueText: value });
}

// ---------------------------------------------------------------------------
// Состав группы
// ---------------------------------------------------------------------------

describe('состав группы EVIDENCE', () => {
  const expected = [
    'CERT.600',
    'DECL.601',
    'PASS.610',
    'PASS.611',
    'TP.620',
    'MILL.630',
    'MIX.640',
    'LAB.650',
    'LAB.651',
    'CONCL.660',
    'REFUS.670',
    'SCH.680',
  ];

  it('содержит ровно двенадцать объявленных кодов — снятые в том числе', () => {
    // Спеки снятых остаются в группе: их строки напечатаны в применённой
    // миграции сида 0017, и тест дрейфа сверяет её с генерацией по группе.
    expect(EVIDENCE_RULES.map((spec) => spec.code).sort()).toEqual([...expected].sort());
  });

  it('все правила документные, группы evidence, без профиля и внешних реестров', () => {
    for (const spec of EVIDENCE_RULES) {
      expect(spec.level, spec.code).toBe('document');
      expect(spec.kind, spec.code).toBe('evidence');
      expect(spec.requiresSectionProfile, spec.code).toBe(false);
      expect(spec.requiresExternalRegistry, spec.code).toBeNull();
      expect(spec.docTypeCode, spec.code).not.toBeNull();
    }
  });

  it('тяжесть и блокирование соответствуют заявленным', () => {
    // У снятых — те же значения, что напечатаны в снимках наборов 0044…0081.
    const declared: Readonly<Record<string, readonly [string, boolean]>> = {
      'CERT.600': ['error', true],
      'DECL.601': ['error', true],
      'PASS.610': ['error', true],
      'PASS.611': ['error', false],
      'TP.620': ['error', true],
      'MILL.630': ['error', true],
      'MIX.640': ['error', true],
      'LAB.650': ['error', false],
      'LAB.651': ['error', true],
      'CONCL.660': ['warning', false],
      'REFUS.670': ['warning', false],
      'SCH.680': ['warning', false],
    };
    for (const spec of EVIDENCE_RULES) {
      expect([spec.defaultSeverity, spec.defaultBlocking], spec.code).toEqual(declared[spec.code]);
    }
  });
});

// ---------------------------------------------------------------------------
// Снятые в S59
// ---------------------------------------------------------------------------

/**
 * По образцу `AOSR.ACT.032` (S30). Ни у одного из семи у портала нет эталона
 * для сравнения: норма паспорта, марка стали, проектная марка смеси, прочность
 * по возрасту — материаловедение, которое заказчик из проверок вывел. Вид
 * `technical_conclusion` снят из каталога видов, `SCH.680` заменено `SCH.681`.
 */
describe('PASS.610 / MILL.630 / MIX.640 / LAB.650 / LAB.651 / CONCL.660 / SCH.680 — сняты (S59)', () => {
  it('кодов нет в каталоге правил', () => {
    for (const code of RETIRED_CODES) {
      expect(
        RULE_CATALOG.some((spec) => spec.code === code),
        code,
      ).toBe(false);
    }
  });

  it('спеки остались среди снятых — ради контрольных сумм применённых миграций', () => {
    const retired = RETIRED_RULES.map((spec) => spec.code);
    for (const code of RETIRED_CODES) expect(retired, code).toContain(code);
  });

  it('заглушка отвечает n_a «правило снято с исполнения», даже когда документ вида есть', () => {
    // Граф с документами всех семи видов: у заглушки нет тела, и наличие
    // документа ничего не меняет.
    const graph = makeGraph({
      documents: [
        EVIDENCE_DOC_TYPES.qualityPassport,
        EVIDENCE_DOC_TYPES.millCertificate,
        EVIDENCE_DOC_TYPES.mixQualityDoc,
        EVIDENCE_DOC_TYPES.labProtocolConcrete,
        EVIDENCE_DOC_TYPES.technicalConclusion,
        EVIDENCE_DOC_TYPES.execScheme,
      ].map((docTypeCode) => makeDocument({ docTypeCode })),
    });
    for (const code of RETIRED_CODES) {
      const result = run(code, graph);
      expect(result.verdict, code).toBe('n_a');
      expect(result.reason, code).toBe('правило снято с исполнения');
    }
  });
});

// ---------------------------------------------------------------------------
// CERT.600 / DECL.601
// ---------------------------------------------------------------------------

describe('CERT.600 — сертификат соответствия', () => {
  const cert = (fields: readonly ReturnType<typeof makeField>[]): DocumentNode =>
    makeDocument({
      docTypeCode: EVIDENCE_DOC_TYPES.cert,
      title: 'Сертификат соответствия',
      fields,
    });

  it('заполненный сертификат с непротиворечивыми датами проходит', () => {
    const result = run(
      'CERT.600',
      graphWith(
        cert([
          textField(EVIDENCE_FIELDS.number, 'РОСС RU С-RU.АЯ56.В.00123'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2025-03-01'),
          dateField(EVIDENCE_FIELDS.validFrom, '2025-03-01'),
          dateField(EVIDENCE_FIELDS.validTo, '2028-02-28'),
        ]),
      ),
    );
    expect(result.verdict).toBe('pass');
    expect(result.findings).toHaveLength(0);
  });

  it('незаполненный номер — дефект документа', () => {
    const result = run(
      'CERT.600',
      graphWith(
        cert([
          makeField({ fieldCode: EVIDENCE_FIELDS.number, valueText: '   ' }),
          dateField(EVIDENCE_FIELDS.issuedAt, '2025-03-01'),
        ]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('поле „Номер документа“ не заполнено');
  });

  it('интервальная форма без даты окончания — дефект', () => {
    const result = run(
      'CERT.600',
      graphWith(
        cert([
          textField(EVIDENCE_FIELDS.number, 'РОСС RU С-RU.АЯ56.В.00123'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2025-03-01'),
          dateField(EVIDENCE_FIELDS.validFrom, '2025-03-01'),
        ]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('поле „Действителен по“ не заполнено');
  });

  it('дата выдачи позже даты окончания действия — дефект', () => {
    const result = run(
      'CERT.600',
      graphWith(
        cert([
          textField(EVIDENCE_FIELDS.number, 'РОСС RU С-RU.АЯ56.В.00123'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2029-01-01'),
          dateField(EVIDENCE_FIELDS.validFrom, '2025-03-01'),
          dateField(EVIDENCE_FIELDS.validTo, '2028-02-28'),
        ]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('позже даты окончания действия 28.02.2028');
  });

  it('без сертификатов в комплекте — n_a, а не «замечаний нет»', () => {
    const result = run(
      'CERT.600',
      graphWith(makeDocument({ docTypeCode: EVIDENCE_DOC_TYPES.declaration })),
    );
    expect(result.verdict).toBe('n_a');
    expect(result.reason).toContain('cert_conformity');
  });

  it('резервный тип документа не порождает ошибку (§0.5, открытый мир)', () => {
    const result = run(
      'CERT.600',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.cert,
          isFallbackType: true,
          fields: [textField(EVIDENCE_FIELDS.number, '')],
        }),
      ),
    );
    expect(result.verdict).toBe('n_a');
  });
});

describe('DECL.601 — декларация о соответствии', () => {
  const decl = (fields: readonly ReturnType<typeof makeField>[]): DocumentNode =>
    makeDocument({ docTypeCode: EVIDENCE_DOC_TYPES.declaration, fields });

  it('заполненная декларация проходит', () => {
    const result = run(
      'DECL.601',
      graphWith(
        decl([
          textField(EVIDENCE_FIELDS.number, 'ЕАЭС N RU Д-RU.РА01.В.12345/23'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2023-05-10'),
          dateField(EVIDENCE_FIELDS.validFrom, '2023-05-10'),
          dateField(EVIDENCE_FIELDS.validTo, '2028-05-09'),
        ]),
      ),
    );
    expect(result.verdict).toBe('pass');
  });

  it('начало действия позже окончания — дефект', () => {
    const result = run(
      'DECL.601',
      graphWith(
        decl([
          textField(EVIDENCE_FIELDS.number, 'ЕАЭС N RU Д-RU.РА01.В.12345/23'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2023-05-10'),
          dateField(EVIDENCE_FIELDS.validFrom, '2028-05-10'),
          dateField(EVIDENCE_FIELDS.validTo, '2023-05-09'),
        ]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('дата начала действия 10.05.2028 позже даты окончания');
  });

  it('без деклараций — n_a', () => {
    expect(run('DECL.601', makeGraph()).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// PASS.611
// ---------------------------------------------------------------------------

describe('PASS.611 — реквизиты паспорта качества', () => {
  it('заполненные реквизиты — pass', () => {
    const result = run(
      'PASS.611',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
          fields: [
            textField(EVIDENCE_FIELDS.number, '16005'),
            dateField(EVIDENCE_FIELDS.issuedAt, '2026-01-09'),
          ],
        }),
      ),
    );
    expect(result.verdict).toBe('pass');
  });

  it('номер партии заменяет номер документа', () => {
    // Бланк паспорта на партию другого номера не печатает: «№ партии: 7».
    // Реестр приложений называет такой документ «Паспорт качества № 7» —
    // то есть номером партии, и это не вольность подрядчика.
    const result = run(
      'PASS.611',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
          fields: [
            textField(EVIDENCE_FIELDS.batchNo, '7'),
            dateField(EVIDENCE_FIELDS.issuedAt, '2025-07-04'),
          ],
        }),
      ),
    );

    expect(result.verdict).toBe('pass');
  });

  it('без номера и без партии — дефект остаётся', () => {
    const result = run(
      'PASS.611',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
          fields: [dateField(EVIDENCE_FIELDS.issuedAt, '2025-07-04')],
        }),
      ),
    );

    expect(result.verdict).toBe('fail');
  });

  it('нет даты выдачи — дефект', () => {
    const result = run(
      'PASS.611',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
          fields: [textField(EVIDENCE_FIELDS.number, '16005')],
        }),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('поле „Дата выдачи“ не заполнено');
  });

  it('без паспортов — n_a', () => {
    expect(run('PASS.611', makeGraph()).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// TP.620 — дефект №5 корпуса
// ---------------------------------------------------------------------------

describe('TP.620 — дефект №5: пустое поле «Дата выдачи» в техпаспорте', () => {
  const tp = (
    fields: readonly ReturnType<typeof makeField>[],
    patch: Partial<DocumentNode> = {},
  ): DocumentNode =>
    makeDocument({
      docTypeCode: EVIDENCE_DOC_TYPES.technicalPassport,
      title: 'Технический паспорт',
      fields,
      ...patch,
    });

  it('поле «Дата выдачи» присутствует, но пусто — fail с названием поля', () => {
    const result = run(
      'TP.620',
      graphWith(
        tp([
          textField(EVIDENCE_FIELDS.number, 'ТП-114'),
          makeField({ fieldCode: EVIDENCE_FIELDS.issuedAt, valueText: '' }),
        ]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('поле „Дата выдачи“ не заполнено');
  });

  it('реквизита «Дата выдачи» нет вовсе при прочих извлечённых — тоже fail', () => {
    const result = run('TP.620', graphWith(tp([textField(EVIDENCE_FIELDS.number, 'ТП-114')])));
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('поле „Дата выдачи“ не заполнено');
  });

  it('заполненный техпаспорт проходит — правило срабатывает не всегда', () => {
    const result = run(
      'TP.620',
      graphWith(
        tp([
          textField(EVIDENCE_FIELDS.number, 'ТП-114'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2025-11-20'),
        ]),
      ),
    );
    expect(result.verdict).toBe('pass');
    expect(result.findings).toHaveLength(0);
  });

  it('пустой номер тоже дефект', () => {
    const result = run(
      'TP.620',
      graphWith(
        tp([
          makeField({ fieldCode: EVIDENCE_FIELDS.number, valueText: '  ' }),
          dateField(EVIDENCE_FIELDS.issuedAt, '2025-11-20'),
        ]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('поле „Номер документа“ не заполнено');
  });

  it('без техпаспортов — n_a', () => {
    expect(run('TP.620', makeGraph()).verdict).toBe('n_a');
  });
});

describe('TP.620 — «поле пусто» и «страница не распознана» различаются', () => {
  it('ноль извлечённых реквизитов — undetermined, а не обвинение в пустом бланке', () => {
    const result = run(
      'TP.620',
      graphWith(makeDocument({ docTypeCode: EVIDENCE_DOC_TYPES.technicalPassport, fields: [] })),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('реквизиты не извлечены');
    expect(joined(result)).not.toContain('не заполнено');
  });

  it('у ревизии нет распознанного текста — undetermined', () => {
    const result = run(
      'TP.620',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.technicalPassport,
          fields: [textField(EVIDENCE_FIELDS.number, 'ТП-114')],
        }),
        { hasRecognizedText: false },
      ),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('нет распознанного текста');
    expect(joined(result)).not.toContain('не заполнено');
  });

  it('тот же документ при распознанном тексте даёт fail — различие содержательно', () => {
    const document = makeDocument({
      docTypeCode: EVIDENCE_DOC_TYPES.technicalPassport,
      fields: [textField(EVIDENCE_FIELDS.number, 'ТП-114')],
    });
    expect(run('TP.620', graphWith(document, { hasRecognizedText: false })).verdict).toBe(
      'undetermined',
    );
    expect(run('TP.620', graphWith(document, { hasRecognizedText: true })).verdict).toBe('fail');
  });

  it('низкая уверенность OCR не даёт blocking fail — понижает движок', () => {
    const graph = graphWith(
      makeDocument({
        docTypeCode: EVIDENCE_DOC_TYPES.technicalPassport,
        fields: [
          textField(EVIDENCE_FIELDS.number, 'ТП-114'),
          makeField({ fieldCode: EVIDENCE_FIELDS.issuedAt, valueText: '', confidence: 0.4 }),
        ],
      }),
    );
    const outcome = runRules(graph, {
      specs: EVIDENCE_RULES,
      snapshot: snapshotOf(EVIDENCE_RULES),
      enabledRuleCodes: null,
    });
    const execution = outcome.executions.find((entry) => entry.ruleCode === 'TP.620');
    expect(execution?.verdict).toBe('undetermined');
    expect(outcome.findings.filter((finding) => finding.isBlocking)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REFUS.670
// ---------------------------------------------------------------------------

describe('REFUS.670 — отказное письмо', () => {
  it('заполненные реквизиты — pass', () => {
    const result = run(
      'REFUS.670',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.refusalLetter,
          fields: [
            textField(EVIDENCE_FIELDS.number, 'ОП-14/25'),
            dateField(EVIDENCE_FIELDS.issuedAt, '2025-04-15'),
          ],
        }),
      ),
    );
    expect(result.verdict).toBe('pass');
  });

  it('нет даты — дефект, но не блокирующий (warning в снимке)', () => {
    const graph = graphWith(
      makeDocument({
        docTypeCode: EVIDENCE_DOC_TYPES.refusalLetter,
        fields: [textField(EVIDENCE_FIELDS.number, 'ОП-14/25')],
      }),
    );
    expect(run('REFUS.670', graph).verdict).toBe('fail');

    const outcome = runRules(graph, {
      specs: EVIDENCE_RULES,
      snapshot: snapshotOf(EVIDENCE_RULES),
      enabledRuleCodes: null,
    });
    const findings = outcome.findings.filter((finding) => finding.ruleCode === 'REFUS.670');
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.isBlocking).toBe(false);
  });

  it('без отказных писем — n_a', () => {
    expect(run('REFUS.670', makeGraph()).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// Прогон через движок
// ---------------------------------------------------------------------------

describe('прогон группы через движок', () => {
  const graph = makeGraph({
    documents: [
      makeDocument({
        docTypeCode: EVIDENCE_DOC_TYPES.cert,
        fields: [
          textField(EVIDENCE_FIELDS.number, 'РОСС RU С-RU.АЯ56.В.00123'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2025-03-01'),
        ],
      }),
      makeDocument({
        docTypeCode: EVIDENCE_DOC_TYPES.technicalPassport,
        fields: [textField(EVIDENCE_FIELDS.number, 'ТП-114')],
      }),
      // Паспорт качества есть — движок доходит до заглушки PASS.610, а не
      // отвечает «нет документов вида» раньше неё.
      makeDocument({
        docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
        fields: [
          textField(EVIDENCE_FIELDS.number, '16005'),
          dateField(EVIDENCE_FIELDS.issuedAt, '2026-01-09'),
        ],
      }),
    ],
  });

  const outcome = runRules(graph, {
    specs: EVIDENCE_RULES,
    snapshot: snapshotOf(EVIDENCE_RULES),
    enabledRuleCodes: null,
  });

  it('все двенадцать кодов попали в журнал исполнения — n_a тоже исполнение', () => {
    // Снятое правило исполняется: движок вызывает заглушку и записывает её
    // ответ. «Не исполнялось» и «неприменимо» — разные состояния, и второе не
    // покрывает первое.
    expect(outcome.executions.map((entry) => entry.ruleCode).sort()).toEqual(
      EVIDENCE_RULES.map((spec) => spec.code).sort(),
    );
    expect(outcome.skipped).toEqual({});
    expect(outcome.counts.executed).toBe(EVIDENCE_RULES.length);
  });

  it('снятое правило при документе своего вида отвечает причиной снятия', () => {
    const execution = outcome.executions.find((entry) => entry.ruleCode === 'PASS.610');
    expect(execution?.verdict).toBe('n_a');
    expect(execution?.reason).toBe('правило снято с исполнения');
    expect(outcome.findings.some((finding) => finding.ruleCode === 'PASS.610')).toBe(false);
  });

  it('каждое неприменимое правило объясняет причину', () => {
    for (const execution of outcome.executions) {
      if (execution.verdict !== 'n_a') continue;
      expect(execution.reason, execution.ruleCode).toBeTruthy();
    }
  });

  it('дефект №5 найден в общем прогоне', () => {
    const byRule = (code: string): string[] =>
      outcome.findings.filter((finding) => finding.ruleCode === code).map((f) => f.message);

    expect(byRule('TP.620').join(' | ')).toContain('поле „Дата выдачи“ не заполнено');
  });

  it('у каждого замечания есть адрес и подсказка', () => {
    for (const finding of outcome.findings) {
      expect(finding.targetType, finding.ruleCode).toBe('document');
      expect(finding.targetId, finding.ruleCode).toBeTruthy();
      expect(finding.hint, finding.ruleCode).toBeTruthy();
      expect(finding.origin, finding.ruleCode).toBe('deterministic');
    }
  });
});
