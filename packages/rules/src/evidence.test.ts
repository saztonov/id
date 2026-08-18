/**
 * Тесты группы доказательных документов (§9.4).
 *
 * Тесты чувствительны: у каждого правила есть положительный, отрицательный и
 * неприменимый случай, а у двух дефектов корпуса — ещё и зеркальная пара,
 * доказывающая, что правило различает дефект и его отсутствие, а не срабатывает
 * всегда. Без такой пары зелёный тест доказывает только то, что функция
 * вызвалась, — известная болезнь проекта (S3, S5, S6, S8).
 */
import { describe, expect, it } from 'vitest';

import { runRules } from './engine.js';
import { EVIDENCE_DOC_TYPES, EVIDENCE_FIELDS, EVIDENCE_RULES } from './evidence.js';
import {
  makeDocument,
  makeField,
  makeGraph,
  makeMaterial,
  makeRelation,
  snapshotOf,
} from './testing.js';
import type { CheckGraph, DocumentNode, RuleParams, RuleResult, RuleSpec } from './types.js';

// ---------------------------------------------------------------------------
// Инструменты
// ---------------------------------------------------------------------------

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

function numField(fieldCode: string, value: number) {
  return makeField({ fieldCode, valueNum: value, valueText: String(value) });
}

function tableField(rows: readonly { indicator: string; norm: string; fact: string }[]) {
  return makeField({ fieldCode: EVIDENCE_FIELDS.ndRequirements, valueJson: rows });
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

  it('содержит ровно двенадцать объявленных кодов', () => {
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
// PASS.610 / PASS.611
// ---------------------------------------------------------------------------

describe('PASS.610 — автосравнение «Норма по НД / Фактически»', () => {
  const passport = (fields: readonly ReturnType<typeof makeField>[]): DocumentNode =>
    makeDocument({ docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport, fields });

  it('факт в пределах напечатанной нормы — pass', () => {
    const result = run(
      'PASS.610',
      graphWith(
        passport([
          tableField([
            { indicator: 'Прочность на сжатие', norm: 'не менее 5 МПа', fact: '6,2 МПа' },
            { indicator: 'Толщина', norm: '4 ± 0,2 мм', fact: '4,1 мм' },
          ]),
        ]),
      ),
    );
    expect(result.verdict).toBe('pass');
    expect(result.findings).toHaveLength(0);
  });

  it('факт вне напечатанной нормы — дефект с объяснением парсера допусков', () => {
    const result = run(
      'PASS.610',
      graphWith(
        passport([
          tableField([
            { indicator: 'Прочность на сжатие', norm: 'не менее 5 МПа', fact: '4,1 МПа' },
          ]),
        ]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('фактически 4.1 МПа при норме не менее 5 МПа');
    expect(joined(result)).toContain('Прочность на сжатие');
  });

  it('симметричный допуск нарушен — дефект', () => {
    const result = run(
      'PASS.610',
      graphWith(
        passport([tableField([{ indicator: 'Толщина', norm: '4 ± 0,2 мм', fact: '4,9' }])]),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('вне допуска 3.8…4.2');
  });

  it('фактическое значение не число — undetermined, а не fail', () => {
    const result = run(
      'PASS.610',
      graphWith(
        passport([
          tableField([{ indicator: 'Внешний вид', norm: 'не менее 5 МПа', fact: 'соответствует' }]),
        ]),
      ),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('требуется ручная проверка');
  });

  it('таблицы нет вовсе — n_a, а не fail', () => {
    const result = run(
      'PASS.610',
      graphWith(passport([textField(EVIDENCE_FIELDS.number, '230126/2/126000477.1.1')])),
    );
    expect(result.verdict).toBe('n_a');
    expect(result.reason).toContain('сравнивать нечего');
  });

  it('без паспортов качества — n_a', () => {
    expect(run('PASS.610', makeGraph()).verdict).toBe('n_a');
  });
});

describe('нормативы не выдумываются (§8.1)', () => {
  it('PASS.610 без напечатанной нормы даёт undetermined и «требуется ручная проверка»', () => {
    const result = run(
      'PASS.610',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.qualityPassport,
          fields: [tableField([{ indicator: 'Предел текучести', norm: '', fact: '512 МПа' }])],
        }),
      ),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('требуется ручная проверка');
    // Ни при каких условиях правило не подставляет норматив само.
    expect(joined(result)).not.toMatch(/ГОСТ\s*\d|СП\s*\d/u);
  });

  it('MILL.630 без напечатанных норм механических свойств даёт undetermined', () => {
    const result = run(
      'MILL.630',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.millCertificate,
          fields: [textField(EVIDENCE_FIELDS.steelClass, 'А240С')],
        }),
        { materials: [makeMaterial({ mark: 'A240C' })] },
      ),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('нормы механических свойств в сертификате не напечатаны');
    expect(joined(result)).toContain('требуется ручная проверка');
  });

  it('в исходниках группы нет числовых нормативов классов проката и бетона', () => {
    // Косвенная, но действенная проверка: любое сравнение опирается на
    // `tolerance.ts`, а он читает норму из документа. Здесь фиксируется, что
    // правило без напечатанной нормы НЕ выносит вердикт о качестве.
    const result = run(
      'MILL.630',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.millCertificate,
          fields: [
            textField(EVIDENCE_FIELDS.steelClass, 'А500С'),
            tableField([{ indicator: 'Предел текучести', norm: '', fact: '480 МПа' }]),
          ],
        }),
        { materials: [makeMaterial({ mark: 'А500С' })] },
      ),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).not.toContain('500 МПа');
  });
});

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
// MILL.630
// ---------------------------------------------------------------------------

describe('MILL.630 — сертификат качества металла', () => {
  const mill = (fields: readonly ReturnType<typeof makeField>[]): DocumentNode =>
    makeDocument({ docTypeCode: EVIDENCE_DOC_TYPES.millCertificate, fields });

  it('марка совпадает через фолдинг гомоглифов, свойства в норме — pass', () => {
    const document = mill([
      textField(EVIDENCE_FIELDS.steelClass, 'A240C'),
      tableField([{ indicator: 'Предел текучести', norm: 'не менее 240 МПа', fact: '265 МПа' }]),
    ]);
    const result = run('MILL.630', {
      ...graphWith(document),
      materials: [makeMaterial({ mark: 'А240С', documentIds: [document.id] })],
    });
    expect(result.verdict).toBe('pass');
  });

  it('марка не совпадает с заявленной — дефект', () => {
    const document = mill([
      textField(EVIDENCE_FIELDS.steelClass, 'А500С'),
      tableField([{ indicator: 'Предел текучести', norm: 'не менее 240 МПа', fact: '265 МПа' }]),
    ]);
    const result = run('MILL.630', {
      ...graphWith(document),
      materials: [makeMaterial({ mark: 'А240С', documentIds: [document.id] })],
    });
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('марка проката «А500С» не совпадает с заявленной');
  });

  it('фактическое свойство ниже напечатанной нормы — дефект', () => {
    const document = mill([
      textField(EVIDENCE_FIELDS.steelClass, 'А240С'),
      tableField([{ indicator: 'Предел текучести', norm: 'не менее 240 МПа', fact: '212 МПа' }]),
    ]);
    const result = run('MILL.630', {
      ...graphWith(document),
      materials: [makeMaterial({ mark: 'А240С', documentIds: [document.id] })],
    });
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('фактически 212 МПа при норме не менее 240 МПа');
  });

  it('марка в комплекте не заявлена — undetermined, а не fail', () => {
    const result = run(
      'MILL.630',
      graphWith(
        mill([
          textField(EVIDENCE_FIELDS.steelClass, 'А240С'),
          tableField([
            { indicator: 'Предел текучести', norm: 'не менее 240 МПа', fact: '265 МПа' },
          ]),
        ]),
      ),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('не определена');
  });

  it('без сертификатов металла — n_a', () => {
    expect(run('MILL.630', makeGraph()).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// MIX.640
// ---------------------------------------------------------------------------

describe('MIX.640 — марка смеси против проектной из пункта 1 акта', () => {
  const act = (workName: string): DocumentNode =>
    makeDocument({ docTypeCode: 'aosr', fields: [textField(EVIDENCE_FIELDS.workName, workName)] });

  const mix = (concreteClass: string | null): DocumentNode =>
    makeDocument({
      docTypeCode: EVIDENCE_DOC_TYPES.mixQualityDoc,
      fields:
        concreteClass === null
          ? [textField(EVIDENCE_FIELDS.number, '77-1')]
          : [textField(EVIDENCE_FIELDS.concreteClass, concreteClass)],
    });

  it('марка смеси совпадает с проектной М-150 — pass', () => {
    const result = run(
      'MIX.640',
      makeGraph({ documents: [act('Устройство стяжки из раствора М-150'), mix('М150')] }),
    );
    expect(result.verdict).toBe('pass');
  });

  it('класс бетона совпадает с проектным В25 — pass', () => {
    const result = run(
      'MIX.640',
      makeGraph({ documents: [act('Устройство монолитной плиты из бетона В25'), mix('B25')] }),
    );
    expect(result.verdict).toBe('pass');
  });

  it('марка смеси расходится с проектной — дефект', () => {
    const result = run(
      'MIX.640',
      makeGraph({ documents: [act('Устройство стяжки из раствора М-150'), mix('М100')] }),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('не совпадает с проектной по пункту 1 акта');
  });

  it('проектная марка в пункте 1 не найдена — undetermined', () => {
    const result = run(
      'MIX.640',
      makeGraph({ documents: [act('Устройство 2 слоя гидроизоляции'), mix('М150')] }),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('проектная марка (класс) в пункте 1 акта не найдена');
  });

  it('марка в документе о качестве не распознана — undetermined', () => {
    const result = run(
      'MIX.640',
      makeGraph({ documents: [act('Устройство стяжки из раствора М-150'), mix(null)] }),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('не распознана');
  });

  it('без документов о качестве смеси — n_a', () => {
    expect(run('MIX.640', makeGraph({ documents: [act('раствор М-150')] })).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// LAB.650 — регрессия «семисуточный протокол не брак»
// ---------------------------------------------------------------------------

function protocol(age: number | null, percent: number | null, ordinal = 1): DocumentNode {
  const fields = [
    ...(age === null ? [] : [numField(EVIDENCE_FIELDS.ageDays, age)]),
    ...(percent === null ? [] : [numField(EVIDENCE_FIELDS.strengthPercent, percent)]),
  ];
  return makeDocument({
    docTypeCode: EVIDENCE_DOC_TYPES.labProtocolConcrete,
    ordinal,
    fields,
  });
}

describe('LAB.650 — оценка по возрасту образца', () => {
  it('семисуточный протокол 71,78 % НЕ даёт error и НЕ даёт вердикт fail', () => {
    const graph = graphWith(protocol(7, 71.78));
    const direct = run('LAB.650', graph);

    expect(direct.verdict).not.toBe('fail');
    expect(direct.verdict).toBe('undetermined');
    expect(joined(direct)).toContain('промежуточный контроль, 71,78 % от требуемой в возрасте 7');

    const outcome = runRules(graph, {
      specs: EVIDENCE_RULES,
      snapshot: snapshotOf(EVIDENCE_RULES),
      enabledRuleCodes: null,
    });
    const execution = outcome.executions.find((entry) => entry.ruleCode === 'LAB.650');
    const findings = outcome.findings.filter((finding) => finding.ruleCode === 'LAB.650');

    expect(execution?.verdict).not.toBe('fail');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings.some((finding) => finding.severity === 'error')).toBe(false);
    expect(findings.some((finding) => finding.isBlocking)).toBe(false);
  });

  it('пять семисуточных протоколов образца — ни одного error', () => {
    const graph = makeGraph({
      documents: [1, 2, 3, 4, 5].map((index) => protocol(7, 71.78, index)),
    });
    const outcome = runRules(graph, {
      specs: EVIDENCE_RULES,
      snapshot: snapshotOf(EVIDENCE_RULES),
      enabledRuleCodes: null,
    });
    const findings = outcome.findings.filter((finding) => finding.ruleCode === 'LAB.650');
    expect(findings).toHaveLength(5);
    expect(findings.every((finding) => finding.severity === 'info')).toBe(true);
  });

  it('28-суточный протокол с 92 % даёт error', () => {
    const graph = graphWith(protocol(28, 92));
    const direct = run('LAB.650', graph);
    expect(direct.verdict).toBe('fail');
    expect(joined(direct)).toContain('в возрасте 28 суток набрано 92 % от требуемой прочности');

    const outcome = runRules(graph, {
      specs: EVIDENCE_RULES,
      snapshot: snapshotOf(EVIDENCE_RULES),
      enabledRuleCodes: null,
    });
    const findings = outcome.findings.filter((finding) => finding.ruleCode === 'LAB.650');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
  });

  it('28-суточный протокол со 105 % — pass', () => {
    expect(run('LAB.650', graphWith(protocol(28, 105))).verdict).toBe('pass');
  });

  it('процент считается из пары «фактическая / требуемая»', () => {
    const document = makeDocument({
      docTypeCode: EVIDENCE_DOC_TYPES.labProtocolConcrete,
      fields: [
        numField(EVIDENCE_FIELDS.ageDays, 28),
        numField(EVIDENCE_FIELDS.strengthActual, 10.57),
        numField(EVIDENCE_FIELDS.strengthRequired, 14.72),
      ],
    });
    const result = run('LAB.650', graphWith(document));
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('71,81 %');
  });

  it('возраст образца не определён — undetermined', () => {
    const result = run('LAB.650', graphWith(protocol(null, 71.78)));
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('возраст образца не определён');
  });

  it('процент не определён — undetermined', () => {
    const result = run('LAB.650', graphWith(protocol(7, null)));
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('процент от требуемой прочности не определён');
  });

  it('без протоколов — n_a', () => {
    expect(run('LAB.650', makeGraph()).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// LAB.651 — дефект №7 корпуса
// ---------------------------------------------------------------------------

describe('LAB.651 — дефект №7: нет 28-суточных при наличии семисуточных', () => {
  it('пять семисуточных и ни одного 28-суточного — дефект с точным текстом', () => {
    const graph = makeGraph({
      documents: [1, 2, 3, 4, 5].map((index) => protocol(7, 71.78, index)),
    });
    const result = run('LAB.651', graph);
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain(
      'приёмочный протокол в проектном возрасте (28 суток) не приложен, приложены только промежуточные (7 суток)',
    );
    expect(result.findings).toHaveLength(1);
  });

  it('добавление 28-суточного протокола снимает дефект — правило не срабатывает всегда', () => {
    const graph = makeGraph({
      documents: [
        ...[1, 2, 3, 4, 5].map((index) => protocol(7, 71.78, index)),
        protocol(28, 104, 6),
      ],
    });
    const result = run('LAB.651', graph);
    expect(result.verdict).toBe('pass');
    expect(result.findings).toHaveLength(0);
  });

  it('проектный возраст берётся из параметров снимка', () => {
    const graph = makeGraph({ documents: [protocol(7, 71.78)] });
    expect(run('LAB.651', graph, { designAgeDays: 7 }).verdict).toBe('pass');
    expect(run('LAB.651', graph, { designAgeDays: 14 }).verdict).toBe('fail');
    expect(joined(run('LAB.651', graph, { designAgeDays: 14 }))).toContain(
      '(14 суток) не приложен',
    );
  });

  it('дефект считается отдельно по каждому акту', () => {
    const early = protocol(7, 71.78, 1);
    const late = protocol(28, 104, 2);
    const actA = makeDocument({ docTypeCode: 'aosr', ordinal: 10 });
    const actB = makeDocument({ docTypeCode: 'aosr', ordinal: 11 });
    const graph = makeGraph({
      documents: [actA, actB, early, late],
      relations: [
        makeRelation({ parentDocumentId: actA.id, childDocumentId: early.id }),
        makeRelation({ parentDocumentId: actB.id, childDocumentId: late.id }),
      ],
    });
    const result = run('LAB.651', graph);
    expect(result.verdict).toBe('fail');
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.targetId).toBe(actA.id);
  });

  it('возраст не определён ни в одном протоколе — undetermined, а не fail', () => {
    const result = run('LAB.651', makeGraph({ documents: [protocol(null, 71.78, 1)] }));
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('возраст образцов не определён');
  });

  it('протоколов нет вовсе — n_a', () => {
    expect(run('LAB.651', makeGraph()).verdict).toBe('n_a');
  });

  it('низкая уверенность возраста понижает дефект до undetermined в движке', () => {
    const document = makeDocument({
      docTypeCode: EVIDENCE_DOC_TYPES.labProtocolConcrete,
      fields: [makeField({ fieldCode: EVIDENCE_FIELDS.ageDays, valueNum: 7, confidence: 0.3 })],
    });
    const outcome = runRules(graphWith(document), {
      specs: EVIDENCE_RULES,
      snapshot: snapshotOf(EVIDENCE_RULES),
      enabledRuleCodes: null,
    });
    const execution = outcome.executions.find((entry) => entry.ruleCode === 'LAB.651');
    expect(execution?.verdict).toBe('undetermined');
    expect(outcome.findings.filter((finding) => finding.isBlocking)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CONCL.660 / REFUS.670
// ---------------------------------------------------------------------------

describe('CONCL.660 — техническое заключение', () => {
  it('заполненные реквизиты — pass', () => {
    const result = run(
      'CONCL.660',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.technicalConclusion,
          fields: [
            textField(EVIDENCE_FIELDS.number, '25-1156'),
            dateField(EVIDENCE_FIELDS.issuedAt, '2025-09-01'),
          ],
        }),
      ),
    );
    expect(result.verdict).toBe('pass');
  });

  it('нет номера — дефект', () => {
    const result = run(
      'CONCL.660',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.technicalConclusion,
          fields: [dateField(EVIDENCE_FIELDS.issuedAt, '2025-09-01')],
        }),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('поле „Номер документа“ не заполнено');
  });

  it('без заключений — n_a', () => {
    expect(run('CONCL.660', makeGraph()).verdict).toBe('n_a');
  });
});

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
// SCH.680
// ---------------------------------------------------------------------------

describe('SCH.680 — исполнительная схема', () => {
  it('есть привязка и штамп — pass', () => {
    const result = run(
      'SCH.680',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.execScheme,
          fields: [
            textField(EVIDENCE_FIELDS.workName, 'Устройство 2 слоёв гидроизоляции'),
            makeField({ fieldCode: 'issuer', valueText: 'ООО «СТРОЙПРОФИЛЬ»', blockType: 'stamp' }),
          ],
        }),
      ),
    );
    expect(result.verdict).toBe('pass');
    expect(result.findings).toHaveLength(0);
  });

  it('нет привязки при размеченных блоках — дефект', () => {
    const result = run(
      'SCH.680',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.execScheme,
          fields: [
            makeField({ fieldCode: 'issuer', valueText: 'ООО «СТРОЙПРОФИЛЬ»', blockType: 'stamp' }),
          ],
        }),
      ),
    );
    expect(result.verdict).toBe('fail');
    expect(joined(result)).toContain('привязка схемы к освидетельствованным работам не указана');
  });

  it('штампа среди блоков нет — undetermined, а не fail', () => {
    const result = run(
      'SCH.680',
      graphWith(
        makeDocument({
          docTypeCode: EVIDENCE_DOC_TYPES.execScheme,
          title: 'Схема раскладки',
          fields: [textField('issuer', 'ООО «СТРОЙПРОФИЛЬ»')],
        }),
      ),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('штамп с подписями на схеме не обнаружен');
  });

  it('данных нет вовсе — undetermined, а не fail', () => {
    const result = run(
      'SCH.680',
      graphWith(makeDocument({ docTypeCode: EVIDENCE_DOC_TYPES.execScheme, fields: [] })),
    );
    expect(result.verdict).toBe('undetermined');
    expect(joined(result)).toContain('требуется ручная проверка');
    expect(joined(result)).not.toContain('не указана');
  });

  it('без исполнительных схем — n_a', () => {
    expect(run('SCH.680', makeGraph()).verdict).toBe('n_a');
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
      protocol(7, 71.78, 3),
    ],
  });

  const outcome = runRules(graph, {
    specs: EVIDENCE_RULES,
    snapshot: snapshotOf(EVIDENCE_RULES),
    enabledRuleCodes: null,
  });

  it('все двенадцать кодов попали в журнал исполнения', () => {
    expect(outcome.executions.map((entry) => entry.ruleCode).sort()).toEqual(
      EVIDENCE_RULES.map((spec) => spec.code).sort(),
    );
    expect(outcome.skipped).toEqual({});
    expect(outcome.counts.executed).toBe(EVIDENCE_RULES.length);
  });

  it('каждое неприменимое правило объясняет причину', () => {
    for (const execution of outcome.executions) {
      if (execution.verdict !== 'n_a') continue;
      expect(execution.reason, execution.ruleCode).toBeTruthy();
    }
  });

  it('дефект №5 и дефект №7 найдены в одном прогоне', () => {
    const byRule = (code: string): string[] =>
      outcome.findings.filter((finding) => finding.ruleCode === code).map((f) => f.message);

    expect(byRule('TP.620').join(' | ')).toContain('поле „Дата выдачи“ не заполнено');
    expect(byRule('LAB.651').join(' | ')).toContain(
      'приёмочный протокол в проектном возрасте (28 суток) не приложен',
    );
  });

  it('семисуточный протокол в том же прогоне остаётся info и не блокирует', () => {
    const lab650 = outcome.findings.filter((finding) => finding.ruleCode === 'LAB.650');
    expect(lab650).toHaveLength(1);
    expect(lab650[0]?.severity).toBe('info');
    expect(lab650[0]?.isBlocking).toBe(false);
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
