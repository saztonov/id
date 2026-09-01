/**
 * Тесты правил дат и подписей (§9.2).
 *
 * Фикстуры строятся так, чтобы снятие проверки роняло тест: в каждом
 * отрицательном случае граница сдвинута ровно на одну сторону от порога, а
 * положительный случай отличается от отрицательного ОДНИМ значением. Фикстура,
 * в которой утверждение истинно по построению, доказывает только то, что код
 * исполнился, — а «код исполнился и ничего не проверил» шесть этапов подряд был
 * основным способом получить зелёный гейт при сломанной функции.
 */
import { describe, expect, it } from 'vitest';

import { DATE_RULES, SIGNATURE_RULES } from './dates.js';
import { runRules } from './engine.js';
import {
  makeBatch,
  makeDocument,
  makeField,
  makeGraph,
  makeMaterial,
  makeRelation,
  makeUnavailableRegistries,
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
// DATE.304
// ---------------------------------------------------------------------------

describe('DATE.304 — отметка о подтверждении действия покрывает период', () => {
  it('pass: отметка продлевает документ за релевантную дату', () => {
    const graph = graphWithAct([
      certificate([dateField('valid_to', '2026-01-01'), dateField('valid_until', '2026-12-31')]),
    ]);
    expect(run('DATE.304', graph).verdict).toBe('pass');
  });

  it('fail: отметка кончается раньше релевантной даты', () => {
    const graph = graphWithAct([
      certificate([dateField('valid_to', '2026-01-01'), dateField('valid_until', '2026-02-01')]),
    ]);
    const result = run('DATE.304', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('01.02.2026');
  });

  it('undetermined: релевантная дата не определена', () => {
    const graph = graphWithoutAct([
      certificate([dateField('valid_to', '2026-01-01'), dateField('valid_until', '2026-02-01')]),
    ]);
    expect(run('DATE.304', graph).verdict).toBe('undetermined');
  });

  it('n_a: интервал есть, отметки о подтверждении нет', () => {
    const graph = graphWithAct([certificate([dateField('valid_to', '2026-01-01')])]);
    expect(run('DATE.304', graph).verdict).toBe('n_a');
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
// DATE.311
// ---------------------------------------------------------------------------

describe('DATE.311 — документ не абсурдно старый', () => {
  it('pass: возраст в пределах порога', () => {
    const graph = graphWithAct([certificate([dateField('issued_at', '2025-01-01')])]);
    expect(run('DATE.311', graph).verdict).toBe('pass');
  });

  it('fail: возраст больше порога по умолчанию', () => {
    const graph = graphWithAct([certificate([dateField('issued_at', '2010-01-01')])]);
    const result = run('DATE.311', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('3650');
  });

  it('порог берётся из параметров снимка, а не из норматива', () => {
    const graph = graphWithAct([certificate([dateField('issued_at', '2010-01-01')])]);
    expect(run('DATE.311', graph, { maxAgeDays: 10_000 }).verdict).toBe('pass');
    expect(run('DATE.311', graph, { maxAgeDays: 10 }).verdict).toBe('fail');
  });

  it('undetermined: релевантная дата не определена', () => {
    const graph = graphWithoutAct([certificate([dateField('issued_at', '2010-01-01')])]);
    expect(run('DATE.311', graph).verdict).toBe('undetermined');
  });

  it('n_a: нет документов с датой выдачи', () => {
    const graph = graphWithAct([certificate([dateField('valid_to', '2027-01-01')])]);
    expect(run('DATE.311', graph).verdict).toBe('n_a');
  });
});

/**
 * Пороги профиля раздела действуют (§9.2).
 *
 * До S9 `thresholds` профиля загружались в граф и не читались ни одним
 * правилом: администратор задавал порог, и НИЧЕГО не происходило — молча.
 * Поэтому проверяется не «функция прочитала поле», а СМЕНА ВЕРДИКТА в обе
 * стороны, и рядом — положительный контроль: профиль, промолчавший про порог,
 * обязан оставить вердикт снимка нетронутым. Без второй половины «подключили
 * профиль» было бы неотличимо от «сломали снимок».
 *
 * Релевантная дата фикстуры — 09.03.2026 (окончание работ по акту), поэтому
 * возраст «свежего» документа 432 дн., «старого» — 5911 дн.
 */
describe('DATE.311 — порог профиля раздела поверх снимка', () => {
  const FRESH = '2025-01-01';
  const OLD = '2010-01-01';

  function graphWithThresholds(
    issuedAt: string,
    thresholds: Readonly<Record<string, unknown>>,
  ): CheckGraph {
    const graph = graphWithAct([certificate([dateField('issued_at', issuedAt)])]);
    return { ...graph, profile: { ...graph.profile, thresholds } };
  }

  it('профиль ужесточает порог: по снимку pass, по профилю fail', () => {
    expect(run('DATE.311', graphWithThresholds(FRESH, {})).verdict).toBe('pass');

    const strict = graphWithThresholds(FRESH, { maxAgeDays: 10 });
    const result = run('DATE.311', strict);
    expect(result.verdict).toBe('fail');
    // Порог назван в тексте: инженер обязан видеть, ЧЕМ измеряли.
    expect(messages(result)).toContain('превышает порог 10 дн.');
  });

  it('профиль ослабляет порог: по снимку fail, по профилю pass', () => {
    expect(run('DATE.311', graphWithThresholds(OLD, {})).verdict).toBe('fail');
    expect(run('DATE.311', graphWithThresholds(OLD, { maxAgeDays: 10_000 })).verdict).toBe('pass');
  });

  it('положительный контроль: профиль без этого ключа не трогает значение снимка', () => {
    const graph = graphWithThresholds(OLD, { maxDocumentsWithoutRegistry: 1 });
    const result = run('DATE.311', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('превышает порог 3650 дн.');
    // И снимок по-прежнему главнее константы кода.
    expect(run('DATE.311', graph, { maxAgeDays: 10_000 }).verdict).toBe('pass');
  });

  it('нечисловое значение в профиле не отменяет порог снимка', () => {
    // `thresholds` — свободный jsonb; строка «три года» не обязана превращать
    // порог в NaN и глушить правило целиком.
    const graph = graphWithThresholds(OLD, { maxAgeDays: 'три года' });
    const result = run('DATE.311', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('превышает порог 3650 дн.');
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
// DATE.320
// ---------------------------------------------------------------------------

function mixDocument(shipped: string | null): DocumentNode {
  return makeDocument({
    id: 'doc-mix',
    docTypeCode: 'mix_quality_doc',
    title: 'Документ о качестве бетонной смеси',
    fields: [
      textField('number', '18-000002580'),
      ...(shipped === null ? [] : [dateField('shipped_at', shipped)]),
    ],
  });
}

describe('DATE.320 — отгрузка смеси и сохраняемость', () => {
  it('pass: отгрузка в день работ', () => {
    expect(run('DATE.320', graphWithAct([mixDocument('2026-03-09')])).verdict).toBe('pass');
  });

  it('fail: отгрузка за восемь дней до работ', () => {
    const result = run('DATE.320', graphWithAct([mixDocument('2026-03-01')]));
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('8 дн.');
    expect(messages(result)).toContain('4 ч');
  });

  it('порог расхождения берётся из параметров снимка', () => {
    const graph = graphWithAct([mixDocument('2026-03-01')]);
    expect(run('DATE.320', graph, { maxDaysBetweenShipmentAndUse: 30 }).verdict).toBe('pass');
  });

  it('undetermined: дата укладки не определена', () => {
    expect(run('DATE.320', graphWithoutAct([mixDocument('2026-03-01')])).verdict).toBe(
      'undetermined',
    );
  });

  it('undetermined: дата отгрузки не распознана', () => {
    expect(run('DATE.320', graphWithAct([mixDocument(null)])).verdict).toBe('undetermined');
  });

  it('n_a: в комплекте нет документов о качестве смеси', () => {
    expect(run('DATE.320', graphWithAct([certificate([])])).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// DATE.330
// ---------------------------------------------------------------------------

function protocol(fields: readonly FieldNode[], patch: Partial<DocumentNode> = {}): DocumentNode {
  return makeDocument({
    id: 'doc-protocol',
    docTypeCode: 'lab_protocol_concrete',
    title: 'Протокол испытаний',
    fields: [textField('number', '10353.А/06.25'), ...fields],
    ...patch,
  });
}

describe('DATE.330 — аккредитация лаборатории действует на дату испытания', () => {
  it('pass: аккредитация действует на дату испытания', () => {
    const graph = graphWithAct([
      protocol([
        dateField('tested_at', '2026-03-05'),
        dateField('issuer_accreditation_valid_to', '2027-01-01'),
      ]),
    ]);
    expect(run('DATE.330', graph).verdict).toBe('pass');
  });

  it('fail: аккредитация истекла до даты испытания', () => {
    const graph = graphWithAct([
      protocol([
        dateField('tested_at', '2026-03-05'),
        dateField('issuer_accreditation_valid_to', '2026-01-01'),
      ]),
    ]);
    const result = run('DATE.330', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('05.03.2026');
  });

  it('undetermined: дата испытания не распознана', () => {
    const graph = graphWithAct([
      protocol([dateField('issuer_accreditation_valid_to', '2026-01-01')]),
    ]);
    expect(run('DATE.330', graph).verdict).toBe('undetermined');
  });

  it('n_a: срок аккредитации нигде не распознан', () => {
    const graph = graphWithAct([protocol([dateField('tested_at', '2026-03-05')])]);
    expect(run('DATE.330', graph).verdict).toBe('n_a');
  });

  it('n_a: тип документа резервный — типо-специфичная логика не применяется', () => {
    const graph = graphWithAct([
      protocol(
        [
          dateField('tested_at', '2026-03-05'),
          dateField('issuer_accreditation_valid_to', '2026-01-01'),
        ],
        { docTypeCode: 'protocol_grounding', isKnownType: false },
      ),
    ]);
    expect(run('DATE.330', graph).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// DATE.331
// ---------------------------------------------------------------------------

describe('DATE.331 — поверка прибора действует на дату измерения', () => {
  it('pass: поверка действует на дату измерения', () => {
    const graph = graphWithAct([
      protocol([dateField('measured_at', '2026-03-01'), dateField('valid_until', '2026-06-01')]),
    ]);
    expect(run('DATE.331', graph).verdict).toBe('pass');
  });

  it('fail: поверка истекла до даты измерения', () => {
    const graph = graphWithAct([
      protocol([dateField('measured_at', '2026-03-01'), dateField('valid_until', '2026-01-01')]),
    ]);
    const result = run('DATE.331', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('01.03.2026');
  });

  it('undetermined: срок поверки не распознан', () => {
    const graph = graphWithAct([protocol([dateField('measured_at', '2026-03-01')])]);
    expect(run('DATE.331', graph).verdict).toBe('undetermined');
  });

  it('n_a: реквизита даты измерения в комплекте нет', () => {
    const graph = graphWithAct([protocol([dateField('valid_until', '2026-01-01')])]);
    expect(run('DATE.331', graph).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// DATE.332
// ---------------------------------------------------------------------------

const ATTESTAT = 'РОСС RU.0001.21АВ55';

function accreditationGraph(
  available: boolean,
  patch: { readonly validTo?: string; readonly registryNumber?: string } = {},
): CheckGraph {
  const documents = [
    protocol([textField('issuer_accreditation', ATTESTAT), dateField('tested_at', '2026-03-05')]),
  ];
  const external = available
    ? {
        ...makeUnavailableRegistries(),
        accreditation: {
          status: 'available' as const,
          records: [
            {
              registryNumber: patch.registryNumber ?? ATTESTAT,
              holderName: 'Испытательная лаборатория',
              validFrom: '2020-01-01',
              validTo: patch.validTo ?? '2027-01-01',
            },
          ],
        },
      }
    : makeUnavailableRegistries();
  return graphWithAct(documents, { external });
}

describe('DATE.332 — аккредитация подтверждена внешним реестром', () => {
  it('реестр недоступен: одно замечание external_unavailable с требованием ручной проверки', () => {
    const result = run('DATE.332', accreditationGraph(false));
    expect(result.verdict).toBe('undetermined');
    const findings = findingsOf(result);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.origin).toBe('external_unavailable');
    expect(findings[0]?.targetType).toBe('folder');
    expect(messages(result)).toContain('ребуется ручная проверка');
    expect(messages(result)).toContain('источник данных не подключён');
    expect(messages(result)).toContain(ATTESTAT);
  });

  it('реестр доступен и аттестат найден с действующим сроком: pass', () => {
    expect(run('DATE.332', accreditationGraph(true)).verdict).toBe('pass');
  });

  it('реестр доступен, аттестата в нём нет: fail', () => {
    const result = run(
      'DATE.332',
      accreditationGraph(true, { registryNumber: 'РОСС RU.0001.99ЯЯ00' }),
    );
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('не найден в реестре');
  });

  it('реестр доступен, аккредитация истекла до испытания: fail', () => {
    const result = run('DATE.332', accreditationGraph(true, { validTo: '2026-01-01' }));
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('01.01.2026');
  });

  it('n_a: номера аттестата в комплекте нет', () => {
    expect(run('DATE.332', graphWithAct([certificate([])])).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// DATE.372 — дефект №4 корпуса
// ---------------------------------------------------------------------------

/**
 * АОСР №336: работы 28.02–09.03.2026, протокол №10353.А/06.25 от 20.06.2025,
 * партии арматуры от 09.01.2026.
 */
function corpusGraph(batchManufacturedAt: string): CheckGraph {
  const act = makeAct();
  const lab = makeDocument({
    id: 'doc-protocol',
    docTypeCode: 'lab_protocol_metal',
    title: 'Протокол испытаний арматуры',
    fields: [
      textField('number', '10353.А/06.25'),
      dateField('issued_at', '2025-06-20'),
      dateField('tested_at', '2025-06-20'),
    ],
  });
  const mill = makeDocument({
    id: 'doc-mill',
    docTypeCode: 'mill_certificate',
    title: 'Сертификат качества на арматуру',
    fields: [textField('number', 'СК-1'), dateField('manufactured_at', batchManufacturedAt)],
  });
  return makeGraph({
    documents: [act, lab, mill],
    relations: [
      makeRelation({ parentDocumentId: act.id, childDocumentId: lab.id }),
      makeRelation({ parentDocumentId: act.id, childDocumentId: mill.id }),
    ],
    materials: [
      makeMaterial({
        nameRaw: 'Арматура А500С ⌀12',
        batches: [
          makeBatch({
            batchNo: '12',
            manufacturedAt: batchManufacturedAt,
            documentIds: ['doc-mill'],
          }),
        ],
        documentIds: ['doc-mill'],
      }),
    ],
  });
}

describe('DATE.372 — протокол испытаний относится к применённым партиям (дефект №4 корпуса)', () => {
  it('находит протокол от 20.06.2025 при партии от 09.01.2026 и называет обе даты', () => {
    const result = run('DATE.372', corpusGraph('2026-01-09'));
    expect(result.verdict).toBe('fail');
    const findings = findingsOf(result);
    expect(findings).toHaveLength(1);
    const message = findings[0]?.message ?? '';
    expect(message).toContain('20.06.2025');
    expect(message).toContain('09.01.2026');
    expect(findings[0]?.hint).toBeTruthy();
  });

  it('чувствительность: партия, изготовленная до протокола, замечания не даёт', () => {
    // Единственное изменённое значение — дата изготовления партии. Если убрать
    // сравнение дат, этот тест станет красным вместе с предыдущим.
    const result = run('DATE.372', corpusGraph('2025-01-09'));
    expect(result.verdict).toBe('pass');
    expect(findingsOf(result)).toHaveLength(0);
  });

  it('дефект не виден ни одному другому правилу группы — иначе DATE.372 не нужно', () => {
    const graph = corpusGraph('2026-01-09');
    // Партия изготовлена до работ, протокол выдан до работ, интервалов нет:
    // все остальные правила дат считают комплект исправным.
    expect(run('DATE.312', graph).verdict).toBe('pass');
    expect(run('DATE.310', graph).verdict).toBe('pass');
    expect(run('DATE.311', graph).verdict).toBe('pass');
  });

  it('undetermined: протокол не связан с актом', () => {
    const graph = corpusGraph('2026-01-09');
    const detached = makeGraph({
      documents: graph.documents,
      relations: graph.relations.filter((edge) => edge.childDocumentId !== 'doc-protocol'),
      materials: graph.materials,
    });
    expect(run('DATE.372', detached).verdict).toBe('undetermined');
  });

  it('undetermined: у акта нет партий с распознанной датой изготовления', () => {
    const graph = makeGraph({
      documents: corpusGraph('2026-01-09').documents,
      relations: corpusGraph('2026-01-09').relations,
      materials: [],
    });
    const result = run('DATE.372', graph);
    expect(result.verdict).toBe('undetermined');
    expect(messages(result)).toContain('нет партий с распознанной датой изготовления');
  });

  it('n_a: в комплекте нет протоколов', () => {
    expect(run('DATE.372', graphWithAct([certificate([])])).verdict).toBe('n_a');
  });

  it('graceDays из снимка сдвигает порог', () => {
    expect(run('DATE.372', corpusGraph('2026-01-09'), { graceDays: 1000 }).verdict).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// SIG.STAMP.370
// ---------------------------------------------------------------------------

describe('SIG.STAMP.370 — срок сертификата ЭП по визуальному штампу', () => {
  it('pass: сертификат действует на дату подписания', () => {
    const graph = graphWithAct([
      certificate([
        dateField('signature_stamp_valid_to', '2027-01-01'),
        dateField('signed_at', '2026-03-09'),
      ]),
    ]);
    expect(run('SIG.STAMP.370', graph).verdict).toBe('pass');
  });

  it('fail: сертификат истёк до даты подписания, но замечание не error', () => {
    const graph = graphWithAct([
      certificate([
        dateField('signature_stamp_valid_to', '2026-01-01'),
        dateField('signed_at', '2026-03-09'),
      ]),
    ]);
    const result = run('SIG.STAMP.370', graph);
    expect(result.verdict).toBe('fail');
    expect(messages(result)).toContain('криптографическая проверка не выполнялась');
    expect(rule('SIG.STAMP.370').defaultSeverity).toBe('warning');
    expect(rule('SIG.STAMP.370').defaultBlocking).toBe(false);
    expect(findingsOf(result).every((finding) => finding.severityOverride !== 'error')).toBe(true);
  });

  it('без даты подписания берётся релевантная дата акта', () => {
    const graph = graphWithAct([
      certificate([dateField('signature_stamp_valid_to', '2026-01-01')]),
    ]);
    expect(run('SIG.STAMP.370', graph).verdict).toBe('fail');
  });

  it('undetermined: ни даты подписания, ни связи с актом', () => {
    const graph = graphWithoutAct([
      certificate([dateField('signature_stamp_valid_to', '2026-01-01')]),
    ]);
    expect(run('SIG.STAMP.370', graph).verdict).toBe('undetermined');
  });

  it('n_a: штампа ЭП в комплекте нет', () => {
    expect(run('SIG.STAMP.370', graphWithAct([certificate([])])).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// SIG.PDF.371
// ---------------------------------------------------------------------------

function probeGraph(value: string): CheckGraph {
  return graphWithAct([certificate([textField('signature_probe', value)])]);
}

describe('SIG.PDF.371 — структурный зонд встроенной подписи', () => {
  it('pass: подпись не обнаружена (состояние всего корпуса)', () => {
    expect(run('SIG.PDF.371', probeGraph('none_detected')).verdict).toBe('pass');
  });

  it('info-замечание: подпись обнаружена, но не проверена', () => {
    const result = run('SIG.PDF.371', probeGraph('detected_unverified'));
    expect(findingsOf(result)).toHaveLength(1);
    expect(messages(result)).toContain('криптографическая проверка в MVP не выполняется');
    expect(rule('SIG.PDF.371').defaultSeverity).toBe('info');
  });

  it('undetermined: результат зонда неизвестен', () => {
    expect(run('SIG.PDF.371', probeGraph('unknown')).verdict).toBe('undetermined');
  });

  it('n_a: результата зонда в комплекте нет', () => {
    expect(run('SIG.PDF.371', graphWithAct([certificate([])])).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// Троичная логика
// ---------------------------------------------------------------------------

/**
 * Комплект, в котором ЕСТЬ все реквизиты, но НЕТ ни одного акта и ни одной
 * связи. Каждое значение подобрано так, чтобы дефектом было только незнание
 * релевантной даты: сроки не истекли на дату проверки, поверка действует.
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
      dateField('valid_until', '2028-01-01'),
      dateField('signature_stamp_valid_to', '2027-01-01'),
      textField('signature_probe', 'none_detected'),
    ],
  });
  const passport = makeDocument({
    id: 'doc-passport',
    docTypeCode: 'quality_passport',
    title: 'Паспорт качества',
    fields: [textField('number', 'П-1'), dateField('issued_at', '2015-01-01')],
  });
  const mix = mixDocument('2026-03-01');
  const lab = makeDocument({
    id: 'doc-protocol',
    docTypeCode: 'lab_protocol_concrete',
    title: 'Протокол испытаний',
    fields: [
      textField('number', '10353.А/06.25'),
      dateField('issued_at', '2025-06-20'),
      dateField('tested_at', '2026-03-05'),
      dateField('issuer_accreditation_valid_to', '2027-01-01'),
      textField('issuer_accreditation', ATTESTAT),
      dateField('measured_at', '2026-03-05'),
      dateField('valid_until', '2027-01-01'),
    ],
  });
  return makeGraph({
    documents: [cert, passport, mix, lab],
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
    for (const code of ['DATE.300', 'DATE.303', 'DATE.310', 'DATE.312', 'DATE.320', 'DATE.372']) {
      expect(verdicts.get(code)).toBe('undetermined');
    }
    // DATE.302 не зависит от связи и на неистёкшем документе обязан быть pass —
    // иначе «не fail» выше доказывалось бы неприменимостью, а не логикой.
    expect(verdicts.get('DATE.302')).toBe('pass');
    expect(verdicts.get('DATE.331')).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Прогон через движок
// ---------------------------------------------------------------------------

describe('прогон группы через движок', () => {
  it('все коды группы дат попадают в журнал исполнения', () => {
    const result = runRules(corpusGraph('2026-01-09'), {
      specs: DATE_RULES,
      snapshot: snapshotOf(DATE_RULES),
      enabledRuleCodes: null,
    });
    const executed = result.executions.map((execution) => execution.ruleCode).sort();
    expect(executed).toEqual([...DATE_RULES].map((spec) => spec.code).sort());
    expect(result.counts.executed).toBe(DATE_RULES.length);
    expect(Object.keys(result.skipped)).toHaveLength(0);
  });

  it('дефект №4 доезжает до замечания с кодом DATE.372, тяжестью warning и без блокировки', () => {
    const result = runRules(corpusGraph('2026-01-09'), {
      specs: [...DATE_RULES, ...SIGNATURE_RULES],
      snapshot: snapshotOf([...DATE_RULES, ...SIGNATURE_RULES]),
      enabledRuleCodes: null,
    });
    const finding = result.findings.find((item) => item.ruleCode === 'DATE.372');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.isBlocking).toBe(false);
    expect(finding?.message).toContain('20.06.2025');
    expect(finding?.message).toContain('09.01.2026');
    expect(result.executions.find((execution) => execution.ruleCode === 'DATE.372')?.verdict).toBe(
      'fail',
    );
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
    const result = runRules(corpusGraph('2026-01-09'), {
      specs: DATE_RULES,
      snapshot: snapshotOf(DATE_RULES),
      enabledRuleCodes: ['DATE.372'],
    });
    expect(result.executions.map((execution) => execution.ruleCode)).toEqual(['DATE.372']);
    expect(result.skipped['DATE.300']).toBe('not_in_profile');
  });
});

// ---------------------------------------------------------------------------
// Каталог группы
// ---------------------------------------------------------------------------

describe('каталог группы', () => {
  it('коды и порядок соответствуют §9.2', () => {
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

  it('внешний реестр объявлен ровно у DATE.332', () => {
    const external = ALL_RULES.filter((spec) => spec.requiresExternalRegistry !== null);
    expect(external.map((spec) => spec.code)).toEqual(['DATE.332']);
    expect(external[0]?.requiresExternalRegistry).toBe('accreditation');
  });

  it('ни одно правило группы не требует профиля раздела', () => {
    expect(ALL_RULES.every((spec) => !spec.requiresSectionProfile)).toBe(true);
  });

  it('каждое замечание группы несёт способ устранения', () => {
    const graphs = [
      corpusGraph('2026-01-09'),
      unlinkedGraph(),
      graphWithBatch('2026-05-01'),
      accreditationGraph(false),
      probeGraph('detected_unverified'),
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
