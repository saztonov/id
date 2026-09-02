/**
 * Тесты правил АОСР, перекрёстных сверок и внешних реестров.
 *
 * Три вещи проверяются здесь ЧЕРЕЗ ДВИЖОК, а не вызовом правила напрямую, и это
 * не педантизм:
 *
 * - два битых ОГРН корпуса обязаны дать РАЗНЫЕ вердикты, а различает их не
 *   правило, а `softenByConfidence` в `engine.ts`. Тест, вызывающий `evaluate`
 *   напрямую, увидел бы два одинаковых `fail` и ничего бы не доказал;
 * - гейт открытого мира требует НОЛЬ вердиктов `fail` на комплекте из
 *   документов резервного и неизвестного типа — это утверждение о прогоне
 *   целиком, а не об одном правиле;
 * - блокирующая находка появляется только после наложения снимка ruleset.
 *
 * Остальные правила проверяются прямым вызовом с `defaultParams`: так падение
 * указывает на правило, а не на движок. Каждый прямой вызов проходит через
 * `inconsistencyOf` — правило, объявившее `pass` при открытом замечании,
 * роняет тест на месте.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AOSR_FIELDS,
  AOSR_RULES,
  AOSR_SIGNER_ROLES,
  CROSSCHECK_RULES,
  EXTERNAL_RULES,
  TRANSFER_REGISTRY_RULES,
} from './aosr.js';
import { RETIRED_RULES, RULE_CATALOG } from './catalog.js';
import { periodOfEarliestAct } from './helpers.js';
import { runRules } from './engine.js';
import { inconsistencyOf } from './result.js';
import {
  makeBatch,
  makeCounterparty,
  makeDocument,
  makeField,
  makeFolder,
  makeGraph,
  makeMaterial,
  makeObject,
  makeProfile,
  makeRdDocument,
  makeRegistryRow,
  makeUnavailableRegistries,
  makeUnconfiguredProfile,
  resetTestIds,
  snapshotOf,
} from './testing.js';
import type {
  RegistryRowNode,
  CheckGraph,
  DocumentNode,
  ExternalRegistriesSnapshot,
  FieldNode,
  NrsRecord,
  RuleExecution,
  RuleResult,
  RuleRunResult,
  RuleSpec,
  ScheduleRecord,
  SroRecord,
} from './types.js';

const ALL_RULES: readonly RuleSpec[] = [
  ...AOSR_RULES,
  ...CROSSCHECK_RULES,
  ...TRANSFER_REGISTRY_RULES,
  ...EXTERNAL_RULES,
];

// ---------------------------------------------------------------------------
// Инструменты
// ---------------------------------------------------------------------------

function specOf(code: string): RuleSpec {
  const spec = ALL_RULES.find((candidate) => candidate.code === code);
  if (spec === undefined) throw new Error(`в каталоге нет правила ${code}`);
  return spec;
}

/** Прямой вызов правила с проверкой согласованности вердикта и находок. */
function evaluate(code: string, graph: CheckGraph): RuleResult {
  const spec = specOf(code);
  const result = spec.evaluate(graph, spec.defaultParams);
  const problem = inconsistencyOf(result);
  if (problem !== null) throw new Error(`правило ${code} несогласовано: ${problem}`);
  return result;
}

function verdictOf(code: string, graph: CheckGraph): string {
  return evaluate(code, graph).verdict;
}

function messagesOf(code: string, graph: CheckGraph): string[] {
  const result = evaluate(code, graph);
  return result.verdict === 'n_a' ? [] : result.findings.map((finding) => finding.message);
}

function reasonOf(code: string, graph: CheckGraph): string {
  const result = evaluate(code, graph);
  return result.reason ?? '';
}

function runAll(graph: CheckGraph): RuleRunResult {
  return runRules(graph, {
    specs: ALL_RULES,
    snapshot: snapshotOf(ALL_RULES),
    enabledRuleCodes: null,
  });
}

function executionOf(run: RuleRunResult, code: string): RuleExecution {
  const execution = run.executions.find((entry) => entry.ruleCode === code);
  if (execution === undefined) throw new Error(`правило ${code} не исполнялось`);
  return execution;
}

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

function text(fieldCode: string, valueText: string, patch: Partial<FieldNode> = {}): FieldNode {
  return makeField({ fieldCode, valueText, ...patch });
}

function dateField(fieldCode: string, valueDate: string): FieldNode {
  return makeField({ fieldCode, valueDate });
}

function listField(fieldCode: string, items: readonly string[]): FieldNode {
  return makeField({ fieldCode, valueJson: [...items] });
}

function signerFields(): FieldNode[] {
  return [
    text('rep_developer', 'Петров П.П.'),
    text('rep_developer_order', 'приказ № 1 от 10.01.2026'),
    text('rep_builder', 'Сидоров С.С.'),
    text('rep_builder_order', 'приказ № 2 от 10.01.2026'),
    text('rep_builder_control', 'Иванов И.И.'),
    text('rep_builder_control_order', 'приказ № 3 от 10.01.2026'),
    text('rep_contractor', 'Кузнецов К.К.'),
    text('rep_contractor_order', 'приказ № 4 от 10.01.2026'),
  ];
}

/**
 * Исправный акт: любой отрицательный тест портит РОВНО ОДИН реквизит.
 *
 * Иначе «правило нашло дефект» перестаёт быть доказательством: находка могла бы
 * прийти от соседнего пустого поля, а не от того, что проверяет тест.
 */
function healthyActFields(): FieldNode[] {
  return [
    text(AOSR_FIELDS.objectName, 'Автостоянка'),
    text(AOSR_FIELDS.actNumber, '10'),
    dateField(AOSR_FIELDS.actDate, '2026-03-10'),
    dateField(AOSR_FIELDS.dateStart, '2026-02-28'),
    dateField(AOSR_FIELDS.dateEnd, '2026-03-09'),
    text(AOSR_FIELDS.workName, 'Устройство 2 слоя гидроизоляции'),
    text(AOSR_FIELDS.workLocation, 'оси 1-5, отм. +0.000'),
    text(AOSR_FIELDS.rdCipher, '2.5.1-АР, изм. 1'),
    text(AOSR_FIELDS.contractorName, 'ООО «СТРОЙПРОФИЛЬ»'),
    text(AOSR_FIELDS.contractorInn, '7700123459'),
    text(AOSR_FIELDS.contractorOgrn, '1037700056789'),
    text(AOSR_FIELDS.worksPerformedBy, 'ООО «СТРОЙПРОФИЛЬ»'),
    text(AOSR_FIELDS.nextWorks, 'Устройство защитной стяжки'),
    ...signerFields(),
  ];
}

function makeAct(fields: readonly FieldNode[], patch: Partial<DocumentNode> = {}): DocumentNode {
  return makeDocument({ docTypeCode: 'aosr', ordinal: 1, fields: [...fields], ...patch });
}

function actGraph(fields: readonly FieldNode[], patch: Partial<CheckGraph> = {}): CheckGraph {
  return makeGraph({
    object: makeObject({ name: 'Автостоянка' }),
    documents: [makeAct(fields)],
    ...patch,
  });
}

function without(fields: readonly FieldNode[], ...codes: readonly string[]): FieldNode[] {
  return fields.filter((value) => !codes.includes(value.fieldCode));
}

function replacing(fields: readonly FieldNode[], value: FieldNode): FieldNode[] {
  return [...without(fields, value.fieldCode), value];
}

/** Комплект без единого акта: типо-специфичное правило обязано дать `n_a`. */
function graphWithoutActs(): CheckGraph {
  return makeGraph({ documents: [makeDocument({ docTypeCode: 'cert_conformity' })] });
}

function externalWith(patch: Partial<ExternalRegistriesSnapshot>): ExternalRegistriesSnapshot {
  return { ...makeUnavailableRegistries(), ...patch };
}

beforeEach(() => {
  resetTestIds();
});

// ---------------------------------------------------------------------------
// Каталог
// ---------------------------------------------------------------------------

describe('каталог правил S9.3/S9.5', () => {
  it('содержит ровно согласованные коды', () => {
    expect(AOSR_RULES.map((spec) => spec.code)).toEqual([
      'AOSR.HDR.010',
      'AOSR.HDR.020',
      'AOSR.HDR.021',
      'AOSR.HDR.022',
      'AOSR.HDR.023',
      'AOSR.ACT.030',
      'AOSR.ACT.031',
      'AOSR.SGN.040',
      'AOSR.SGN.041',
      'AOSR.SGN.042',
      'AOSR.P1.050',
      'AOSR.P2.060',
      'AOSR.P2.061',
      'AOSR.P3.070',
      'AOSR.P3.071',
      'AOSR.P4.080',
      'AOSR.P4.081',
      'AOSR.P7.090',
    ]);
    expect(CROSSCHECK_RULES.map((spec) => spec.code)).toEqual([
      'REG.100',
      'REG.101',
      'REG.102',
      'MAT.110',
      'MAT.111',
      'MAT.112',
      'REF.120',
      'REF.121',
      'XS.130',
    ]);
    expect(EXTERNAL_RULES.map((spec) => spec.code)).toEqual([
      'EXT.SRO.140',
      'EXT.NRS.141',
      'EXT.SCHED.142',
    ]);
  });

  it('привязывает правила АОСР к типу документа, а сверки — к ревизии', () => {
    expect(AOSR_RULES.every((spec) => spec.docTypeCode === 'aosr')).toBe(true);
    expect(AOSR_RULES.every((spec) => spec.level === 'document')).toBe(true);
    expect(AOSR_RULES.every((spec) => spec.requiresExternalRegistry === null)).toBe(true);
    expect([...CROSSCHECK_RULES, ...EXTERNAL_RULES].every((s) => s.docTypeCode === null)).toBe(
      true,
    );
    expect(EXTERNAL_RULES.map((spec) => spec.requiresExternalRegistry)).toEqual([
      'sro',
      'nrs',
      'schedule',
    ]);
  });

  it('требует профиль раздела ровно у правил полноты и матрицы', () => {
    const withProfile = ALL_RULES.filter((spec) => spec.requiresSectionProfile).map((s) => s.code);
    expect(withProfile).toEqual(['AOSR.P3.070', 'MAT.110']);
  });
});

// ---------------------------------------------------------------------------
// AOSR.HDR
// ---------------------------------------------------------------------------

describe('AOSR.HDR.010 — наименование объекта', () => {
  it('совпадение с карточкой объекта даёт pass', () => {
    expect(verdictOf('AOSR.HDR.010', actGraph(healthyActFields()))).toBe('pass');
  });

  it('расхождение с карточкой объекта даёт fail и называет оба наименования', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.objectName, 'Жилой дом по ул. Ленина')),
    );
    expect(verdictOf('AOSR.HDR.010', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.010', graph)[0]).toContain('Жилой дом по ул. Ленина');
    expect(messagesOf('AOSR.HDR.010', graph)[0]).toContain('Автостоянка');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('AOSR.HDR.010', graphWithoutActs())).toBe('n_a');
  });
});

describe('AOSR.HDR.020 — реквизиты сторон', () => {
  it('заполненные реквизиты дают pass', () => {
    expect(verdictOf('AOSR.HDR.020', actGraph(healthyActFields()))).toBe('pass');
  });

  /**
   * Пара тестов на различие, ради которого правило переписано на S27.
   *
   * До неё правило объявляло `fail` в обоих случаях и на реальном корпусе
   * выдавало три ложные ошибки на каждый комплект: `contractor_*` не выдавал
   * ни один экстрактор, и подрядчик получал обвинение в незаполненной шапке за
   * то, что портал её не прочитал.
   */
  it('реквизит не извлечён — undetermined, а не обвинение подрядчика', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.contractorInn));
    expect(verdictOf('AOSR.HDR.020', graph)).toBe('undetermined');
    const messages = messagesOf('AOSR.HDR.020', graph);
    // ОДНА строка на акт, а не по одной на каждый неизвлечённый реквизит.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('не извлечены реквизиты лица, выполнившего работы: ИНН');
  });

  it('графа наблюдалась пустой — fail', () => {
    // Узел есть, значение пустое, цитата отобразилась: реквизит ИСКАЛИ и нашли
    // пустую графу. Такую строку производит LLM-ступень извлечения.
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '', { quote: 'ИНН' })),
    );
    expect(verdictOf('AOSR.HDR.020', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.020', graph).join(' ')).toContain(
      'не заполнен реквизит лица, выполнившего работы: ИНН',
    );
  });

  it('ни один реквизит стороны не извлечён — правило неприменимо', () => {
    const graph = actGraph(
      without(
        healthyActFields(),
        AOSR_FIELDS.contractorName,
        AOSR_FIELDS.contractorInn,
        AOSR_FIELDS.contractorOgrn,
      ),
    );
    expect(verdictOf('AOSR.HDR.020', graph)).toBe('undetermined');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('AOSR.HDR.020', graphWithoutActs())).toBe('n_a');
  });
});

describe('AOSR.HDR.021 — контрольная сумма ИНН', () => {
  it('валидный ИНН корпуса даёт pass', () => {
    expect(verdictOf('AOSR.HDR.021', actGraph(healthyActFields()))).toBe('pass');
  });

  it('битая контрольная сумма даёт fail и называет обе цифры', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '7709574094')),
    );
    expect(verdictOf('AOSR.HDR.021', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.021', graph)[0]).toContain('ожидалась 3, указана 4');
  });

  it('без ИНН в шапке правило неприменимо', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.contractorInn));
    expect(verdictOf('AOSR.HDR.021', graph)).toBe('n_a');
  });
});

describe('AOSR.HDR.022 — контрольная сумма ОГРН', () => {
  it('валидный ОГРН корпуса даёт pass', () => {
    expect(verdictOf('AOSR.HDR.022', actGraph(healthyActFields()))).toBe('pass');
  });

  it('ОГРН из 12 цифр даёт fail с указанием длины', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorOgrn, '102770001234')),
    );
    expect(verdictOf('AOSR.HDR.022', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.022', graph)[0]).toContain('указано 12 цифр вместо 13 или 15');
  });

  it('без ОГРН в шапке правило неприменимо', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.contractorOgrn));
    expect(verdictOf('AOSR.HDR.022', graph)).toBe('n_a');
  });
});

describe('AOSR.HDR.023 — тройка ОГРН, ИНН и наименования', () => {
  const directory = [
    makeCounterparty({
      name: 'ООО «СТРОЙПРОФИЛЬ»',
      inn: '7700123459',
      ogrn: '1037700056789',
    }),
  ];

  it('сходящаяся тройка даёт pass', () => {
    expect(
      verdictOf('AOSR.HDR.023', actGraph(healthyActFields(), { counterparties: directory })),
    ).toBe('pass');
  });

  it('расхождение ОГРН при совпавшем ИНН даёт fail', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorOgrn, '1157744002217')),
      { counterparties: directory },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.023', graph)[0]).toContain('1037700056789');
  });

  it('контрагент вне справочника не порождает ошибку, а даёт undetermined', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '7711223342')),
      { counterparties: [makeCounterparty({ name: 'ООО «Другое»', inn: '5600998870' })] },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('undetermined');
  });

  it('пустой справочник делает правило неприменимым', () => {
    expect(verdictOf('AOSR.HDR.023', actGraph(healthyActFields()))).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// AOSR.ACT
// ---------------------------------------------------------------------------

describe('AOSR.ACT.030 — номер акта по шаблону объекта', () => {
  const object = makeObject({ actNumberPattern: '^\\d+$' });

  it('номер по шаблону даёт pass', () => {
    expect(verdictOf('AOSR.ACT.030', actGraph(healthyActFields(), { object }))).toBe('pass');
  });

  it('номер вне шаблона даёт fail', () => {
    const graph = actGraph(healthyActFields(), {
      object: makeObject({ actNumberPattern: '^АОСР-\\d+$' }),
    });
    expect(verdictOf('AOSR.ACT.030', graph)).toBe('fail');
    expect(messagesOf('AOSR.ACT.030', graph)[0]).toContain('^АОСР-\\d+$');
  });

  it('без шаблона в карточке объекта правило неприменимо', () => {
    expect(verdictOf('AOSR.ACT.030', actGraph(healthyActFields()))).toBe('n_a');
  });
});

describe('AOSR.ACT.031 — порядок дат акта', () => {
  it('верный порядок дат даёт pass', () => {
    expect(verdictOf('AOSR.ACT.031', actGraph(healthyActFields()))).toBe('pass');
  });

  it('дата акта раньше окончания работ даёт fail', () => {
    const graph = actGraph(
      replacing(healthyActFields(), dateField(AOSR_FIELDS.actDate, '2026-03-01')),
    );
    expect(verdictOf('AOSR.ACT.031', graph)).toBe('fail');
    expect(messagesOf('AOSR.ACT.031', graph)[0]).toContain('01.03.2026');
    expect(messagesOf('AOSR.ACT.031', graph)[0]).toContain('09.03.2026');
  });

  it('окончание работ раньше начала даёт fail', () => {
    const graph = actGraph(
      replacing(healthyActFields(), dateField(AOSR_FIELDS.dateEnd, '2026-02-01')),
    );
    expect(verdictOf('AOSR.ACT.031', graph)).toBe('fail');
  });

  it('нераспознанные даты дают undetermined, а не fail', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.dateEnd));
    expect(verdictOf('AOSR.ACT.031', graph)).toBe('undetermined');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('AOSR.ACT.031', graphWithoutActs())).toBe('n_a');
  });
});

/**
 * Правило снято с исполнения (S30).
 *
 * Оно сверяло акт с месяцем, который человек называл руками при заведении
 * комплекта. Теперь месяц выводится порталом из самого раннего акта, и правило
 * сравнивало бы акт с самим собой. Сверку даты акта с периодами документов ведут
 * `relevantDateFor` и семейство `DATE.*`, внутреннюю согласованность дат акта —
 * `AOSR.ACT.031`.
 *
 * Проверяется теперь ровно одно: код не вернулся в каталог. Тест на месте, а не
 * удалён, потому что молча вернувшееся правило дало бы зелёную галочку в
 * чек-листе за проверку, которая не может не пройти.
 */
describe('periodOfEarliestAct — месяц комплекта выводится из акта', () => {
  it('берёт САМЫЙ РАННИЙ акт, а не первый попавшийся', () => {
    // Так поступил бы и человек, подшивая папку: комплект относится к месяцу,
    // в котором работы начали освидетельствовать.
    expect(periodOfEarliestAct(['2026-04-20', '2026-03-09', '2026-05-01'])).toBe('2026-03-01');
  });

  it('день внутри месяца отбрасывается: месяц — первое число', () => {
    expect(periodOfEarliestAct(['2026-03-31'])).toBe('2026-03-01');
  });

  it('нераспознанные даты пропускаются, а не роняют вывод', () => {
    expect(periodOfEarliestAct([null, undefined, '', '2026-07-04'])).toBe('2026-07-01');
  });

  it('без единой распознанной даты месяца НЕТ, а не «сегодняшний»', () => {
    // Выдуманное значение неотличимо от прочитанного, а месяц комплекта
    // попадает в реестр передачи.
    expect(periodOfEarliestAct([])).toBeNull();
    expect(periodOfEarliestAct([null, 'не дата'])).toBeNull();
  });
});

describe('AOSR.ACT.032 снято с исполнения', () => {
  it('кода нет в каталоге правил', () => {
    expect(RULE_CATALOG.some((spec) => spec.code === 'AOSR.ACT.032')).toBe(false);
  });

  it('спек остался только среди снятых — ради контрольных сумм применённых миграций', () => {
    expect(RETIRED_RULES.map((spec) => spec.code)).toContain('AOSR.ACT.032');
  });
});

// ---------------------------------------------------------------------------
// AOSR.SGN
// ---------------------------------------------------------------------------

describe('AOSR.SGN.040 — состав подписантов', () => {
  it('полный состав даёт pass', () => {
    expect(verdictOf('AOSR.SGN.040', actGraph(healthyActFields()))).toBe('pass');
  });

  it('отсутствие представителя по строительному контролю даёт fail', () => {
    const graph = actGraph(without(healthyActFields(), 'rep_builder_control'));
    expect(verdictOf('AOSR.SGN.040', graph)).toBe('fail');
    expect(messagesOf('AOSR.SGN.040', graph)[0]).toContain(
      'представитель по строительному контролю',
    );
  });

  it('акт без распознанных ролей даёт undetermined, а не полный список дефектов', () => {
    const graph = actGraph(
      without(healthyActFields(), ...AOSR_SIGNER_ROLES.map((role) => role.field)),
    );
    expect(verdictOf('AOSR.SGN.040', graph)).toBe('undetermined');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('AOSR.SGN.040', graphWithoutActs())).toBe('n_a');
  });
});

describe('AOSR.SGN.041 — реквизиты приказов подписантов', () => {
  it('приказы у всех подписантов дают pass', () => {
    expect(verdictOf('AOSR.SGN.041', actGraph(healthyActFields()))).toBe('pass');
  });

  it('отсутствие приказа у подписанта даёт fail и называет его', () => {
    const graph = actGraph(without(healthyActFields(), 'rep_contractor_order'));
    expect(verdictOf('AOSR.SGN.041', graph)).toBe('fail');
    expect(messagesOf('AOSR.SGN.041', graph)[0]).toContain('Кузнецов К.К.');
  });

  it('акт без подписантов делает правило неприменимым', () => {
    const graph = actGraph(
      without(healthyActFields(), ...AOSR_SIGNER_ROLES.map((role) => role.field)),
    );
    expect(verdictOf('AOSR.SGN.041', graph)).toBe('n_a');
  });
});

describe('AOSR.SGN.042 — организация в строке осмотра', () => {
  it('совпадение организаций даёт pass', () => {
    expect(verdictOf('AOSR.SGN.042', actGraph(healthyActFields()))).toBe('pass');
  });

  it('расхождение организаций даёт fail', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.worksPerformedBy, 'ООО «Субподрядчик»')),
    );
    expect(verdictOf('AOSR.SGN.042', graph)).toBe('fail');
    expect(messagesOf('AOSR.SGN.042', graph)[0]).toContain('Субподрядчик');
  });

  it('без строки осмотра правило даёт undetermined, а без актов — n_a', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.worksPerformedBy));
    expect(verdictOf('AOSR.SGN.042', graph)).toBe('undetermined');
    expect(verdictOf('AOSR.SGN.042', graphWithoutActs())).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// AOSR.P1–P7
// ---------------------------------------------------------------------------

describe('AOSR.P1.050 — наименование работ и привязка', () => {
  it('заполненные п. 1 и привязка дают pass', () => {
    expect(verdictOf('AOSR.P1.050', actGraph(healthyActFields()))).toBe('pass');
  });

  it('пустое наименование работ даёт fail', () => {
    const graph = actGraph(replacing(healthyActFields(), text(AOSR_FIELDS.workName, '   ')));
    expect(verdictOf('AOSR.P1.050', graph)).toBe('fail');
    expect(messagesOf('AOSR.P1.050', graph)[0]).toContain('наименование предъявленных');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('AOSR.P1.050', graphWithoutActs())).toBe('n_a');
  });
});

describe('AOSR.P2.060 — номер изменения в шифре РД', () => {
  it('шифр с номером изменения даёт pass', () => {
    expect(verdictOf('AOSR.P2.060', actGraph(healthyActFields()))).toBe('pass');
  });

  it('шифр без номера изменения даёт fail', () => {
    const graph = actGraph(replacing(healthyActFields(), text(AOSR_FIELDS.rdCipher, '2.5.1-АР')));
    expect(verdictOf('AOSR.P2.060', graph)).toBe('fail');
    expect(messagesOf('AOSR.P2.060', graph)[0]).toContain('без номера изменения');
  });

  it('без шифра РД правило даёт undetermined, а без актов — n_a', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.rdCipher));
    expect(verdictOf('AOSR.P2.060', graph)).toBe('undetermined');
    expect(verdictOf('AOSR.P2.060', graphWithoutActs())).toBe('n_a');
  });
});

describe('AOSR.P2.061 — шифр РД в справочнике', () => {
  it('известный шифр даёт pass, номер изменения сравнению не мешает', () => {
    const graph = actGraph(healthyActFields(), {
      rdDocuments: [makeRdDocument({ cipher: '2.5.1-АР', revision: '1' })],
    });
    expect(verdictOf('AOSR.P2.061', graph)).toBe('pass');
  });

  it('неизвестный шифр даёт fail', () => {
    const graph = actGraph(healthyActFields(), {
      rdDocuments: [makeRdDocument({ cipher: '2.5.2-КЖ' })],
    });
    expect(verdictOf('AOSR.P2.061', graph)).toBe('fail');
    expect(messagesOf('AOSR.P2.061', graph)[0]).toContain('2.5.1-АР');
  });

  it('пустой справочник РД делает правило неприменимым', () => {
    expect(verdictOf('AOSR.P2.061', actGraph(healthyActFields()))).toBe('n_a');
  });
});

describe('AOSR.P3.070 — материалы подтверждены документами', () => {
  const passport = makeDocument({ docTypeCode: 'quality_passport' });

  it('материал с документом качества даёт pass', () => {
    const graph = actGraph(healthyActFields(), {
      documents: [makeAct(healthyActFields()), passport],
      materials: [
        makeMaterial({ nameRaw: 'Арматура', categoryCode: 'rebar', documentIds: [passport.id] }),
      ],
    });
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('материал без документов даёт fail', () => {
    const graph = makeGraph({
      materials: [makeMaterial({ nameRaw: 'Арматура А500С', categoryCode: 'rebar' })],
    });
    expect(verdictOf('AOSR.P3.070', graph)).toBe('fail');
    expect(messagesOf('AOSR.P3.070', graph)[0]).toContain('Арматура А500С');
  });

  it('материал категории вне профиля даёт n_a с перечислением категорий', () => {
    const graph = makeGraph({
      materials: [makeMaterial({ nameRaw: 'Труба', categoryCode: 'pipes' })],
    });
    expect(verdictOf('AOSR.P3.070', graph)).toBe('n_a');
    expect(reasonOf('AOSR.P3.070', graph)).toContain('pipes');
  });
});

describe('AOSR.P3.071 — ссылка на реестр при длинном перечне', () => {
  const many = ['д1', 'д2', 'д3', 'д4', 'д5', 'д6'];

  it('короткий перечень даёт pass', () => {
    const graph = actGraph([
      ...healthyActFields(),
      listField(AOSR_FIELDS.materials, ['д1', 'д2', 'д3']),
    ]);
    expect(verdictOf('AOSR.P3.071', graph)).toBe('pass');
  });

  it('длинный перечень без ссылки на реестр даёт fail', () => {
    const graph = actGraph([...healthyActFields(), listField(AOSR_FIELDS.materials, many)]);
    expect(verdictOf('AOSR.P3.071', graph)).toBe('fail');
    expect(messagesOf('AOSR.P3.071', graph)[0]).toContain('6 документов');
  });

  it('длинный перечень со ссылкой на реестр даёт pass', () => {
    const graph = actGraph([
      ...healthyActFields(),
      listField(AOSR_FIELDS.materials, many),
      text(AOSR_FIELDS.registryRef, 'Реестр приложений № 1'),
    ]);
    expect(verdictOf('AOSR.P3.071', graph)).toBe('pass');
  });

  it('без перечня п. 3 правило неприменимо', () => {
    expect(verdictOf('AOSR.P3.071', actGraph(healthyActFields()))).toBe('n_a');
  });
});

describe('AOSR.P4.080 — приложения присутствуют в комплекте', () => {
  const quality = makeDocument({
    docTypeCode: 'mill_certificate',
    fields: [text(AOSR_FIELDS.number, '16005')],
  });

  it('названное приложение найдено по номеру — pass', () => {
    const graph = makeGraph({
      documents: [
        makeAct([
          ...healthyActFields(),
          listField(AOSR_FIELDS.documents, ['Паспорт качества № 16005']),
        ]),
        quality,
      ],
    });
    expect(verdictOf('AOSR.P4.080', graph)).toBe('pass');
  });

  it('приложение с чужим номером не найдено — fail', () => {
    const graph = makeGraph({
      documents: [
        makeAct([...healthyActFields(), listField(AOSR_FIELDS.documents, ['Паспорт № 99999'])]),
        quality,
      ],
    });
    expect(verdictOf('AOSR.P4.080', graph)).toBe('fail');
    expect(messagesOf('AOSR.P4.080', graph)[0]).toContain('99999');
  });

  it('номер схемы с хвостом захватки не теряется на пробеле', () => {
    // В акте схема названа «№ 48.1-от/-1 этаж от 10.04.2026г.». Пока номер
    // обрывался на первом пробеле, из него уходило «этаж», и схема, лежащая
    // в комплекте, не находилась — двенадцать раз в одной папке.
    const scheme = makeDocument({
      docTypeCode: 'exec_scheme',
      fields: [text(AOSR_FIELDS.number, '48.1-ОТ/-1 ЭТАЖ')],
    });
    const graph = makeGraph({
      documents: [
        makeAct([
          ...healthyActFields(),
          listField(AOSR_FIELDS.documents, [
            'Исполнительная схема устройства стен № 48.1-от/-1 этаж от 10.04.2026г.',
          ]),
        ]),
        scheme,
      ],
    });

    expect(verdictOf('AOSR.P4.080', graph)).toBe('pass');
  });

  it('«Не» вместо «№» номером быть не перестаёт', () => {
    const graph = makeGraph({
      documents: [
        makeAct([
          ...healthyActFields(),
          listField(AOSR_FIELDS.documents, ['Паспорт качества Не 16005']),
        ]),
        quality,
      ],
    });

    expect(verdictOf('AOSR.P4.080', graph)).toBe('pass');
  });

  it('схема есть, но её номер прочитан иначе — undetermined, а не fail', () => {
    // Верхняя надпись чертежа распознаётся хуже прочего текста: тот же номер
    // приходит как «48.1-ОТП-1». Ведущее число «48.1» устойчиво, и по нему
    // схема находится.
    const scheme = makeDocument({
      docTypeCode: 'exec_scheme',
      fields: [text(AOSR_FIELDS.number, '48.1-ОТП-1')],
    });
    const graph = makeGraph({
      documents: [
        makeAct([
          ...healthyActFields(),
          listField(AOSR_FIELDS.documents, ['Исполнительная схема № 48.1-от/-1 этаж']),
        ]),
        scheme,
      ],
    });

    expect(verdictOf('AOSR.P4.080', graph)).toBe('pass');
  });

  it('схема в комплекте есть, но ведущее число не сошлось — undetermined', () => {
    const scheme = makeDocument({
      docTypeCode: 'exec_scheme',
      fields: [text(AOSR_FIELDS.number, '77:07:0010004:24')],
    });
    const graph = makeGraph({
      documents: [
        makeAct([
          ...healthyActFields(),
          listField(AOSR_FIELDS.documents, ['Исполнительная схема № 48.1-от/-1 этаж']),
        ]),
        scheme,
      ],
    });

    // Утверждать отсутствие документа, глядя на плохо прочитанный номер,
    // нельзя: схема в комплекте лежит.
    expect(verdictOf('AOSR.P4.080', graph)).toBe('undetermined');
  });

  it('послабление не распространяется на прочие приложения', () => {
    // Ступень по ведущему числу — про чертёж, у которого номер живёт в
    // верхней надписи. У паспорта номер напечатан в тексте, и «нашлось
    // похожее число» подтверждением наличия документа не является.
    const scheme = makeDocument({
      docTypeCode: 'exec_scheme',
      fields: [text(AOSR_FIELDS.number, '48.1-ОТ/-1 ЭТАЖ')],
    });
    const graph = makeGraph({
      documents: [
        makeAct([
          ...healthyActFields(),
          listField(AOSR_FIELDS.documents, ['Паспорт качества № 48.1']),
        ]),
        scheme,
      ],
    });

    expect(verdictOf('AOSR.P4.080', graph)).toBe('fail');
  });

  it('приложение без номера даёт undetermined, а акт без перечня — n_a', () => {
    const graph = makeGraph({
      documents: [
        makeAct([
          ...healthyActFields(),
          listField(AOSR_FIELDS.documents, ['Исполнительная схема']),
        ]),
      ],
    });
    expect(verdictOf('AOSR.P4.080', graph)).toBe('undetermined');
    expect(verdictOf('AOSR.P4.080', actGraph(healthyActFields()))).toBe('n_a');
  });
});

describe('AOSR.P7.090 — последующие работы', () => {
  it('отличающиеся последующие работы дают pass', () => {
    expect(verdictOf('AOSR.P7.090', actGraph(healthyActFields()))).toBe('pass');
  });

  it('дословный повтор п. 1 в п. 7 даёт fail', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.nextWorks, 'Устройство 2 слоя гидроизоляции')),
    );
    expect(verdictOf('AOSR.P7.090', graph)).toBe('fail');
  });

  it('без п. 7 правило даёт undetermined, без актов — n_a', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.nextWorks));
    expect(verdictOf('AOSR.P7.090', graph)).toBe('undetermined');
    expect(verdictOf('AOSR.P7.090', graphWithoutActs())).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// REG
// ---------------------------------------------------------------------------

describe('REG.100 / REG.101 / REG.102 — сверка с реестром приложений', () => {
  const registry = makeDocument({ docTypeCode: 'annex_registry' });
  const quality = makeDocument({ docTypeCode: 'mill_certificate' });

  function registryGraph(
    matchState: 'matched' | 'missing' | 'ambiguous',
    extra: readonly DocumentNode[] = [],
  ): CheckGraph {
    return makeGraph({
      documents: [registry, quality, ...extra],
      registryRows: [
        makeRegistryRow({
          registryDocumentId: registry.id,
          rowNo: 3,
          docNameRaw: 'Документ о качестве',
          docNoRaw: '16005',
          matchState,
          matchedDocumentId: matchState === 'matched' ? quality.id : null,
        }),
      ],
    });
  }

  it('REG.100: сопоставленная строка даёт pass, отсутствующая — fail', () => {
    expect(verdictOf('REG.100', registryGraph('matched'))).toBe('pass');
    const missing = registryGraph('missing');
    expect(verdictOf('REG.100', missing)).toBe('fail');
    expect(messagesOf('REG.100', missing)[0]).toContain('строка 3 реестра');
  });

  it('REG.100: строка «б/н» отсутствия документа не доказывает', () => {
    // Сверка идёт по номеру, а у такой строки его нет: разбор реестра
    // намеренно оставляет сравнимые формы пустыми, чтобы два разных
    // документа «без номера» не совпали друг с другом. Превращать «не с чем
    // сверить» в «документа нет» правило не вправе: на боевой папке так
    // возникало по три-четыре ложных «нет в комплекте» на каждый комплект.
    const graph = makeGraph({
      documents: [registry, quality],
      registryRows: [
        makeRegistryRow({
          registryDocumentId: registry.id,
          rowNo: 5,
          docNameRaw: 'Приложение к экспертному заключению',
          docNoRaw: 'б/н',
          docNoNorm: null,
          docNoFolded: null,
          matchState: 'missing',
        }),
      ],
    });

    expect(verdictOf('REG.100', graph)).toBe('undetermined');
    expect(messagesOf('REG.100', graph)[0]).toContain('без номера');
  });

  it('REG.100: без реестра правило неприменимо', () => {
    expect(verdictOf('REG.100', makeGraph({ documents: [quality] }))).toBe('n_a');
  });

  it('REG.101: названный реестром документ даёт pass', () => {
    expect(verdictOf('REG.101', registryGraph('matched'))).toBe('pass');
  });

  it('REG.101: документ вне реестра даёт fail', () => {
    const orphan = makeDocument({ docTypeCode: 'declaration', title: 'Декларация о соответствии' });
    const graph = registryGraph('matched', [orphan]);
    expect(verdictOf('REG.101', graph)).toBe('fail');
    expect(messagesOf('REG.101', graph)[0]).toContain('Декларация о соответствии');
  });

  it('REG.101: без реестра правило неприменимо', () => {
    expect(verdictOf('REG.101', makeGraph({ documents: [quality] }))).toBe('n_a');
  });

  it('REG.102: однозначное сопоставление даёт pass, неоднозначное — fail', () => {
    expect(verdictOf('REG.102', registryGraph('matched'))).toBe('pass');
    expect(verdictOf('REG.102', registryGraph('ambiguous'))).toBe('fail');
  });

  it('REG.102: без реестра правило неприменимо', () => {
    expect(verdictOf('REG.102', makeGraph({ documents: [quality] }))).toBe('n_a');
  });

  /**
   * S34: незнание перестаёт выдаваться за дефект.
   *
   * Вывод «документа нет в комплекте» опирается на то, что комплект разобран
   * весь. Если часть листов портал не разобрал, документ может лежать ровно на
   * таком листе, и вывод не установлен.
   */
  it('REG.100: при пробеле покрытия строка даёт undetermined, а не fail', () => {
    const missing = registryGraph('missing');
    const withGaps = makeGraph({ ...missing, coverageGaps: 2 });

    expect(verdictOf('REG.100', withGaps)).toBe('undetermined');
    expect(messagesOf('REG.100', withGaps)[0]).toContain('не разобрал');
  });

  it('REG.100: разобранный целиком комплект по-прежнему даёт fail', () => {
    // Отрицательный контроль: смягчение обязано зависеть от пробелов покрытия,
    // а не наступать всегда.
    expect(verdictOf('REG.100', makeGraph({ ...registryGraph('missing'), coverageGaps: 0 }))).toBe(
      'fail',
    );
  });

  it('REG.101: документ-кандидат строки лишним не объявляется', () => {
    // Двойное обвинение: строка реестра не нашла документ по номеру, а сам
    // документ объявлялся не названным реестром — за один и тот же факт.
    const scheme = makeDocument({ docTypeCode: 'exec_scheme', title: null });
    const graph = makeGraph({
      documents: [registry, scheme],
      registryRows: [
        makeRegistryRow({
          registryDocumentId: registry.id,
          rowNo: 9,
          docNameRaw: 'Исполнительная схема обратной засыпки',
          docNoRaw: 'ИС №002',
          matchState: 'candidate',
          matchedDocumentId: null,
          candidateDocumentIds: [scheme.id],
        }),
      ],
    });

    expect(verdictOf('REG.101', graph)).toBe('pass');
  });

  it('REG.101: документ, названный в п. 3 акта, лишним не объявляется', () => {
    // S40. Бланк пишет «Приложения: в соответствии с п. 3, 4»: приложениями
    // объявлены и перечень документов о качестве из п. 3, и реестр из п. 4.
    // Пока «названным» считался только реестр, комплект `№01_Бл_П` получал
    // четыре обвинения подряд — сертификат № 275, паспорт качества и два
    // сертификата соответствия перечислены в п. 3 и не продублированы в
    // реестре. Ребро графа строит `graph.build` по номеру, прочитанному в
    // самом акте, — свидетельство того же уровня, что и строка реестра.
    const act = makeDocument({ docTypeCode: 'aosr', title: 'АКТ' });
    const passport = makeDocument({ docTypeCode: 'quality_passport', title: 'Паспорт качества' });
    const graph = makeGraph({
      documents: [act, registry, quality, passport],
      relations: [
        { parentDocumentId: act.id, childDocumentId: passport.id, relation: 'quality_doc' },
      ],
      registryRows: [
        makeRegistryRow({
          registryDocumentId: registry.id,
          rowNo: 3,
          docNameRaw: 'Документ о качестве',
          docNoRaw: '16005',
          matchState: 'matched',
          matchedDocumentId: quality.id,
        }),
      ],
    });

    expect(verdictOf('REG.101', graph)).toBe('pass');
  });

  it('REG.101: документ без ребра к акту по-прежнему объявляется лишним', () => {
    // Отрицательный контроль: молчать обязано ровно наличие ребра, а не
    // присутствие акта в комплекте.
    const act = makeDocument({ docTypeCode: 'aosr', title: 'АКТ' });
    const orphan = makeDocument({ docTypeCode: 'declaration', title: 'Декларация о соответствии' });
    const graph = makeGraph({
      documents: [act, registry, quality, orphan],
      registryRows: [
        makeRegistryRow({
          registryDocumentId: registry.id,
          rowNo: 3,
          docNameRaw: 'Документ о качестве',
          docNoRaw: '16005',
          matchState: 'matched',
          matchedDocumentId: quality.id,
        }),
      ],
    });

    expect(verdictOf('REG.101', graph)).toBe('fail');
    expect(messagesOf('REG.101', graph)[0]).toContain('Декларация о соответствии');
  });

  it('REG.101: претендент неоднозначной строки лишним не объявляется', () => {
    // Два паспорта под одним номером: сверка не может выбрать, но реестром
    // упомянуты оба. Обвинять их «не назван ни одной строкой» значит
    // обвинять комплект дважды за один факт — вместе с REG.102 по строке.
    const twin = makeDocument({ docTypeCode: 'quality_passport', title: 'Паспорт качества' });
    const graph = makeGraph({
      documents: [registry, quality, twin],
      registryRows: [
        makeRegistryRow({
          registryDocumentId: registry.id,
          rowNo: 2,
          docNameRaw: 'Блок стеновой',
          docNoRaw: '00БС-012814',
          matchState: 'ambiguous',
          matchedDocumentId: null,
          candidateDocumentIds: [quality.id, twin.id],
        }),
      ],
    });

    expect(verdictOf('REG.101', graph)).toBe('pass');
    // Неоднозначность при этом никуда не девается: о ней говорит REG.102.
    expect(verdictOf('REG.102', graph)).toBe('fail');
  });

  it('вид документа в реестре не сверяется: обобщённое название дефектом не является', () => {
    // Реестр называет лист «Документ о качестве», сам лист озаглавлен
    // «СЕРТИФИКАТ КАЧЕСТВА № 16005» — расхождением это не считается
    // (`docs/CORPUS_FINDINGS.md`).
    const graph = registryGraph('matched');
    for (const code of ['REG.100', 'REG.101', 'REG.102']) {
      expect(verdictOf(code, graph)).toBe('pass');
    }
  });
});

// ---------------------------------------------------------------------------
// MAT
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REG.110 / REG.111 / REG.112 — опись передачи
// ---------------------------------------------------------------------------

describe('REG.110 / REG.111 / REG.112 — сверка папки с описью передачи', () => {
  const transfer = makeDocument({ docTypeCode: 'transfer_registry' });
  const quality = makeDocument({
    docTypeCode: 'mill_certificate',
    title: 'СЕРТИФИКАТ КАЧЕСТВА',
    fields: [text(AOSR_FIELDS.number, '16005')],
  });

  const transferRow = (patch: Partial<RegistryRowNode> = {}): RegistryRowNode =>
    makeRegistryRow({
      registryDocumentId: transfer.id,
      sectionTitle: '1. Устройство шпатлевки стен (ООО «СИНТЕТИК»), поз. 1.3',
      docNameRaw: 'Документ о качестве',
      docNoRaw: '16005',
      complectId: 'complect-1',
      ...patch,
    });

  const transferGraph = (
    rows: readonly RegistryRowNode[],
    documents = [transfer, quality],
  ): CheckGraph => makeGraph({ documents, transferRows: rows });

  it('строка описи нашла свой документ — pass', () => {
    const graph = transferGraph([
      transferRow({ matchState: 'matched', matchedDocumentId: quality.id }),
    ]);

    expect(verdictOf('REG.110', graph)).toBe('pass');
  });

  it('строка описи не нашла документа — предупреждение', () => {
    const graph = transferGraph([transferRow({ matchState: 'missing' })]);

    expect(verdictOf('REG.110', graph)).toBe('fail');
    expect(messagesOf('REG.110', graph)[0]).toContain('описью передачи');
  });

  it('строка описи без номера — «не проверено», а не «нет в папке»', () => {
    const graph = transferGraph([
      transferRow({ matchState: 'missing', docNoRaw: 'б/н', docNoNorm: null, docNoFolded: null }),
    ]);

    expect(verdictOf('REG.110', graph)).toBe('undetermined');
  });

  it('неразобранные листы понижают вывод до «не проверено»', () => {
    const graph = makeGraph({
      documents: [transfer, quality],
      transferRows: [transferRow({ matchState: 'missing' })],
      coverageGaps: 3,
    });

    expect(verdictOf('REG.110', graph)).toBe('undetermined');
  });

  it('без описи все три правила неприменимы', () => {
    const graph = makeGraph({ documents: [quality] });

    for (const code of ['REG.110', 'REG.111', 'REG.112']) {
      expect(verdictOf(code, graph), code).toBe('n_a');
    }
  });
});

describe('REG.111 — документ папки не назван описью', () => {
  const transfer = makeDocument({ docTypeCode: 'transfer_registry' });
  const named = makeDocument({
    docTypeCode: 'mill_certificate',
    title: 'СЕРТИФИКАТ КАЧЕСТВА',
    fields: [text(AOSR_FIELDS.number, '16005')],
  });
  const orphan = makeDocument({
    docTypeCode: 'declaration',
    title: 'ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ',
    fields: [text(AOSR_FIELDS.number, 'РОСС RU Д-RU.PA01.B.29363/25')],
  });

  const row = (matchedDocumentId: string) =>
    makeRegistryRow({
      registryDocumentId: transfer.id,
      docNoRaw: '16005',
      matchState: 'matched',
      matchedDocumentId,
    });

  it('названный описью документ замечания не даёт', () => {
    const graph = makeGraph({ documents: [transfer, named], transferRows: [row(named.id)] });

    expect(verdictOf('REG.111', graph)).toBe('pass');
  });

  it('документ, которого в описи нет, — предупреждение', () => {
    const graph = makeGraph({
      documents: [transfer, named, orphan],
      transferRows: [row(named.id)],
    });

    expect(verdictOf('REG.111', graph)).toBe('fail');
    expect(messagesOf('REG.111', graph)[0]).toContain('ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ');
  });

  it('документ без единого распознанного номера в счёт не идёт', () => {
    // Сверка идёт по номеру: документ, у которого номер не прочитан, описью не
    // ищется в принципе, и «не назван» о нём сказать нельзя.
    const numberless = makeDocument({ docTypeCode: 'quality_passport', title: 'ПАСПОРТ' });
    const graph = makeGraph({
      documents: [transfer, named, numberless],
      transferRows: [row(named.id)],
    });

    expect(verdictOf('REG.111', graph)).toBe('pass');
  });

  it('документ, названный кандидатом, считается названным', () => {
    const candidate = makeRegistryRow({
      registryDocumentId: transfer.id,
      docNoRaw: 'РОСС RU Д-RU.PA01.B.29363/25',
      matchState: 'candidate',
      candidateDocumentIds: [orphan.id],
    });
    const graph = makeGraph({
      documents: [transfer, named, orphan],
      transferRows: [row(named.id), candidate],
    });

    expect(verdictOf('REG.111', graph)).toBe('pass');
  });
});

describe('REG.112 — раздел описи не сопоставлен акту', () => {
  const transfer = makeDocument({ docTypeCode: 'transfer_registry' });

  const sectionRow = (sectionTitle: string, complectId: string | null) =>
    makeRegistryRow({
      registryDocumentId: transfer.id,
      sectionTitle,
      docNoRaw: '16005',
      matchState: 'missing',
      complectId,
    });

  it('раздел, нашедший свой акт, замечания не даёт', () => {
    const graph = makeGraph({
      documents: [transfer],
      transferRows: [sectionRow('1. Устройство шпатлевки', 'complect-1')],
    });

    expect(verdictOf('REG.112', graph)).toBe('pass');
  });

  it('раздел без акта — одно замечание на раздел, а не на строку', () => {
    const graph = makeGraph({
      documents: [transfer],
      transferRows: [
        sectionRow('7. Устройство окраски потолка', null),
        sectionRow('7. Устройство окраски потолка', null),
        sectionRow('8. Устройство шпатлевки', 'complect-2'),
      ],
    });

    expect(verdictOf('REG.112', graph)).toBe('fail');
    expect(messagesOf('REG.112', graph)).toHaveLength(1);
    expect(messagesOf('REG.112', graph)[0]).toContain('Устройство окраски потолка');
  });
});

describe('MAT.110 — матрица документов раздела', () => {
  const matrixProfile = makeProfile({
    materialMatrix: { rebar: { required: ['mill_certificate', 'cert_conformity'] } },
  });

  function matrixGraph(documents: readonly DocumentNode[], profile = matrixProfile): CheckGraph {
    return makeGraph({
      profile,
      documents: [...documents],
      materials: [
        makeMaterial({
          nameRaw: 'Арматура А500С',
          categoryCode: 'rebar',
          documentIds: documents.map((document) => document.id),
        }),
      ],
    });
  }

  it('полный пакет даёт pass', () => {
    const graph = matrixGraph([
      makeDocument({ docTypeCode: 'mill_certificate' }),
      makeDocument({ docTypeCode: 'cert_conformity' }),
    ]);
    expect(verdictOf('MAT.110', graph)).toBe('pass');
  });

  it('нехватка документа даёт fail с названием вида', () => {
    const graph = matrixGraph([makeDocument({ docTypeCode: 'mill_certificate' })]);
    expect(verdictOf('MAT.110', graph)).toBe('fail');
    expect(messagesOf('MAT.110', graph)[0]).toContain('cert_conformity');
  });

  it('документ резервного типа в пакете даёт undetermined, а не fail', () => {
    const graph = matrixGraph([
      makeDocument({ docTypeCode: 'mill_certificate' }),
      makeDocument({ docTypeCode: 'other_quality_document', isFallbackType: true }),
    ]);
    expect(verdictOf('MAT.110', graph)).toBe('undetermined');
  });

  it('категория вне матрицы делает правило неприменимым', () => {
    const graph = matrixGraph([makeDocument({ docTypeCode: 'mill_certificate' })], makeProfile());
    expect(verdictOf('MAT.110', graph)).toBe('n_a');
    expect(reasonOf('MAT.110', graph)).toContain('не описана в матрице');
  });
});

describe('MAT.111 — дефект №2 корпуса: изготовитель партии не покрыт сертификатом', () => {
  function rebarGraph(certificateManufacturer: string | null): CheckGraph {
    const mill = makeDocument({
      docTypeCode: 'mill_certificate',
      fields: [
        text(AOSR_FIELDS.manufacturer, 'ООО «ПромСорт-Тула»'),
        text(AOSR_FIELDS.number, '16005'),
      ],
    });
    const certificate = makeDocument({
      docTypeCode: 'cert_conformity',
      fields:
        certificateManufacturer === null
          ? []
          : [text(AOSR_FIELDS.manufacturer, certificateManufacturer)],
    });
    const batch = makeBatch({ materialId: 'mat-rebar', batchNo: '16005', documentIds: [mill.id] });
    return makeGraph({
      documents: [mill, certificate],
      materials: [
        makeMaterial({
          id: 'mat-rebar',
          nameRaw: 'Арматура А500С',
          categoryCode: 'rebar',
          batches: [batch],
          documentIds: [mill.id, certificate.id],
        }),
      ],
    });
  }

  it('изготовитель партии не назван ни одним сертификатом — fail с именем изготовителя', () => {
    const graph = rebarGraph('АО «Северсталь»');
    expect(verdictOf('MAT.111', graph)).toBe('fail');
    const message = messagesOf('MAT.111', graph)[0] ?? '';
    expect(message).toContain('ПромСорт-Тула');
    expect(message).toContain('Северсталь');
  });

  it('тот же комплект с сертификатом на этого изготовителя даёт pass', () => {
    // Чувствительность: меняется РОВНО изготовитель в сертификате.
    expect(verdictOf('MAT.111', rebarGraph('ООО «ПромСорт-Тула»'))).toBe('pass');
  });

  it('сертификат без изготовителя даёт undetermined: полнота пакета — дело MAT.110', () => {
    expect(verdictOf('MAT.111', rebarGraph(null))).toBe('undetermined');
  });

  it('без материалов правило неприменимо', () => {
    expect(verdictOf('MAT.111', makeGraph())).toBe('n_a');
  });
});

describe('MAT.112 — дефект №3 корпуса: год редакции НД в паспорте и сертификате', () => {
  function standardsGraph(passportNd: string, certificateNd: string): CheckGraph {
    const passport = makeDocument({
      docTypeCode: 'quality_passport',
      fields: [listField(AOSR_FIELDS.gostTu, [passportNd])],
    });
    const certificate = makeDocument({
      docTypeCode: 'cert_conformity',
      fields: [listField(AOSR_FIELDS.gostTu, [certificateNd])],
    });
    return makeGraph({
      documents: [passport, certificate],
      materials: [
        makeMaterial({
          nameRaw: 'Гидроизоляция рулонная',
          categoryCode: 'roll_waterproofing',
          documentIds: [passport.id, certificate.id],
        }),
      ],
    });
  }

  it('разные годы редакции дают fail с обоими обозначениями', () => {
    const graph = standardsGraph('СТО 00287852-005-2015', 'СТО 00287852-005-2011');
    expect(verdictOf('MAT.112', graph)).toBe('fail');
    const message = messagesOf('MAT.112', graph)[0] ?? '';
    expect(message).toContain('СТО 00287852-005-2015');
    expect(message).toContain('СТО 00287852-005-2011');
  });

  it('совпадающий год редакции даёт pass', () => {
    // Чувствительность: меняется РОВНО год в сертификате.
    expect(
      verdictOf('MAT.112', standardsGraph('СТО 00287852-005-2015', 'СТО 00287852-005-2015')),
    ).toBe('pass');
  });

  it('обозначение без года даёт undetermined', () => {
    expect(verdictOf('MAT.112', standardsGraph('СТО 00287852-005', 'СТО 00287852-005-2011'))).toBe(
      'undetermined',
    );
  });

  it('без материалов правило неприменимо', () => {
    expect(verdictOf('MAT.112', makeGraph())).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// REF, XS
// ---------------------------------------------------------------------------

describe('REF.120 — объект активен', () => {
  it('активный объект даёт pass', () => {
    expect(verdictOf('REF.120', makeGraph())).toBe('pass');
  });

  it('неактивный объект даёт fail', () => {
    const graph = makeGraph({ object: makeObject({ isActive: false, name: 'Автостоянка' }) });
    expect(verdictOf('REF.120', graph)).toBe('fail');
    expect(messagesOf('REF.120', graph)[0]).toContain('Автостоянка');
  });

  it('карточка чужого объекта делает правило неприменимым', () => {
    expect(verdictOf('REF.120', makeGraph({ object: makeObject({ id: 'obj-other' }) }))).toBe(
      'n_a',
    );
  });
});

describe('REF.121 — контрагенты активны', () => {
  /** Исполнитель папки — контрагент, названный её карточкой. */
  const folderContractor = (patch = {}) => {
    const party = makeCounterparty({ name: 'ООО «СТРОЙПРОФИЛЬ»', ...patch });
    return { party, folder: makeFolder({ contractorId: party.id }) };
  };

  it('активные контрагенты дают pass', () => {
    const { party, folder } = folderContractor();
    expect(verdictOf('REF.121', makeGraph({ counterparties: [party], folder }))).toBe('pass');
  });

  it('неактивный контрагент даёт fail', () => {
    const { party, folder } = folderContractor({ name: 'ООО «МСЕТ»', isActive: false });
    const graph = makeGraph({ counterparties: [party], folder });

    expect(verdictOf('REF.121', graph)).toBe('fail');
    expect(messagesOf('REF.121', graph)[0]).toContain('МСЕТ');
  });

  it('неактивный контрагент, к папке не относящийся, замечанием не становится', () => {
    // Справочник грузится целиком ради сверки тройки реквизитов (HDR.023).
    // Пока правило смотрело на него весь, любая снятая с учёта организация
    // портала становилась замечанием чужого комплекта.
    const { party, folder } = folderContractor();
    const stranger = makeCounterparty({ name: 'ООО «ПОСТОРОННИЙ»', isActive: false });

    expect(verdictOf('REF.121', makeGraph({ counterparties: [party, stranger], folder }))).toBe(
      'pass',
    );
  });

  it('контрагент из шапки акта в папку входит, даже если он не исполнитель', () => {
    const stranger = makeCounterparty({
      name: 'ООО «СУБПОДРЯД»',
      inn: '7708203762',
      isActive: false,
    });
    const graph = makeGraph({
      counterparties: [stranger],
      documents: [
        makeAct(
          replacing(
            replacing(healthyActFields(), text(AOSR_FIELDS.contractorName, 'ООО «СУБПОДРЯД»')),
            text(AOSR_FIELDS.contractorInn, '7708203762'),
          ),
        ),
      ],
    });

    expect(verdictOf('REF.121', graph)).toBe('fail');
  });

  it('пустой справочник делает правило неприменимым', () => {
    expect(verdictOf('REF.121', makeGraph())).toBe('n_a');
  });
});

describe('XS.130 — дубль акта в комплекте', () => {
  it('акты с разными номерами дают pass', () => {
    const graph = makeGraph({
      documents: [
        makeAct(healthyActFields(), { ordinal: 1 }),
        makeAct(replacing(healthyActFields(), text(AOSR_FIELDS.actNumber, '11')), { ordinal: 2 }),
      ],
    });
    expect(verdictOf('XS.130', graph)).toBe('pass');
  });

  it('два акта с одним номером дают fail', () => {
    const graph = makeGraph({
      documents: [
        makeAct(healthyActFields(), { ordinal: 1 }),
        makeAct(healthyActFields(), { ordinal: 4 }),
      ],
    });
    expect(verdictOf('XS.130', graph)).toBe('fail');
    expect(messagesOf('XS.130', graph)[0]).toContain('1, 4');
  });

  it('один акт делает правило неприменимым', () => {
    expect(verdictOf('XS.130', actGraph(healthyActFields()))).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// EXT (§9.5)
// ---------------------------------------------------------------------------

describe('EXT.SRO.140 — членство подрядчика в СРО', () => {
  const record: SroRecord = {
    memberInn: '7700123459',
    sroName: 'СРО «Ассоциация строителей»',
    validFrom: '2020-01-01',
    validTo: '2027-01-01',
  };

  it('недоступный реестр даёт ровно одно замечание «требуется ручная проверка»', () => {
    const graph = actGraph(healthyActFields());
    const result = evaluate('EXT.SRO.140', graph);
    expect(result.verdict).toBe('undetermined');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings?.[0];
    expect(finding?.origin).toBe('external_unavailable');
    expect(finding?.message).toContain('требуется ручная проверка');
    expect(finding?.message).toContain('источник данных не подключён');
  });

  it('доступный реестр с записью подрядчика даёт pass', () => {
    const graph = actGraph(healthyActFields(), {
      external: externalWith({ sro: { status: 'available', records: [record] } }),
    });
    expect(verdictOf('EXT.SRO.140', graph)).toBe('pass');
  });

  it('доступный реестр без записи подрядчика даёт fail', () => {
    const graph = actGraph(healthyActFields(), {
      external: externalWith({
        sro: { status: 'available', records: [{ ...record, memberInn: '7711223342' }] },
      }),
    });
    expect(verdictOf('EXT.SRO.140', graph)).toBe('fail');
    expect(messagesOf('EXT.SRO.140', graph)[0]).toContain('7700123459');
  });

  it('истёкшее членство даёт fail с датой проверки', () => {
    const graph = actGraph(healthyActFields(), {
      external: externalWith({
        sro: { status: 'available', records: [{ ...record, validTo: '2025-12-31' }] },
      }),
    });
    expect(verdictOf('EXT.SRO.140', graph)).toBe('fail');
    expect(messagesOf('EXT.SRO.140', graph)[0]).toContain('18.08.2026');
  });

  it('неизвестный ИНН подрядчика даёт undetermined, а не fail', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.contractorInn), {
      external: externalWith({ sro: { status: 'available', records: [record] } }),
    });
    expect(verdictOf('EXT.SRO.140', graph)).toBe('undetermined');
  });
});

describe('EXT.NRS.141 — подписанты в национальном реестре специалистов', () => {
  const registry: readonly NrsRecord[] = [
    { fullName: 'Петров Пётр Петрович', registryNumber: 'С-1', validFrom: null, validTo: null },
    { fullName: 'Сидоров Сергей Сергеевич', registryNumber: 'С-2', validFrom: null, validTo: null },
    { fullName: 'Иванов Иван Иванович', registryNumber: 'С-3', validFrom: null, validTo: null },
    {
      fullName: 'Кузнецов Кирилл Кириллович',
      registryNumber: 'С-4',
      validFrom: null,
      validTo: null,
    },
  ];

  it('недоступный реестр даёт одно замечание «требуется ручная проверка»', () => {
    const result = evaluate('EXT.NRS.141', actGraph(healthyActFields()));
    expect(result.verdict).toBe('undetermined');
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.message).toContain('требуется ручная проверка');
  });

  it('все подписанты найдены в реестре — pass', () => {
    const graph = actGraph(healthyActFields(), {
      external: externalWith({ nrs: { status: 'available', records: registry } }),
    });
    expect(verdictOf('EXT.NRS.141', graph)).toBe('pass');
  });

  it('подписант вне реестра даёт fail и называется поимённо', () => {
    const graph = actGraph(healthyActFields(), {
      external: externalWith({
        nrs: { status: 'available', records: registry.slice(0, 3) },
      }),
    });
    expect(verdictOf('EXT.NRS.141', graph)).toBe('fail');
    expect(messagesOf('EXT.NRS.141', graph)[0]).toContain('Кузнецов К.К.');
  });

  it('нераспознанные подписанты дают undetermined', () => {
    const graph = actGraph(
      without(healthyActFields(), ...AOSR_SIGNER_ROLES.map((role) => role.field)),
      { external: externalWith({ nrs: { status: 'available', records: registry } }) },
    );
    expect(verdictOf('EXT.NRS.141', graph)).toBe('undetermined');
  });
});

describe('EXT.SCHED.142 — работы в графике строительства', () => {
  const planned: readonly ScheduleRecord[] = [
    {
      workName: 'Устройство 2 слоя гидроизоляции кровли',
      plannedFrom: '2026-02-20',
      plannedTo: '2026-03-15',
    },
  ];

  it('недоступный график даёт одно замечание «требуется ручная проверка»', () => {
    const result = evaluate('EXT.SCHED.142', actGraph(healthyActFields()));
    expect(result.verdict).toBe('undetermined');
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.message).toContain('требуется ручная проверка');
  });

  it('работы найдены в графике — pass', () => {
    const graph = actGraph(healthyActFields(), {
      external: externalWith({ schedule: { status: 'available', records: planned } }),
    });
    expect(verdictOf('EXT.SCHED.142', graph)).toBe('pass');
  });

  it('работ нет в графике — fail', () => {
    const graph = actGraph(healthyActFields(), {
      external: externalWith({
        schedule: {
          status: 'available',
          records: [{ workName: 'Монтаж металлоконструкций', plannedFrom: null, plannedTo: null }],
        },
      }),
    });
    expect(verdictOf('EXT.SCHED.142', graph)).toBe('fail');
    expect(messagesOf('EXT.SCHED.142', graph)[0]).toContain('Устройство 2 слоя гидроизоляции');
  });

  it('без наименования работ правило даёт undetermined', () => {
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.workName), {
      external: externalWith({ schedule: { status: 'available', records: planned } }),
    });
    expect(verdictOf('EXT.SCHED.142', graph)).toBe('undetermined');
  });
});

// ---------------------------------------------------------------------------
// Дефект №6 корпуса: п. 1 против наименования схемы
// ---------------------------------------------------------------------------

describe('AOSR.P4.081 — дефект №6 корпуса: 2 слоя в п. 1 против 1 слоя в схеме', () => {
  function schemeGraph(workName: string, schemeName: string | null): CheckGraph {
    const fields = [
      ...replacing(healthyActFields(), text(AOSR_FIELDS.workName, workName)),
      ...(schemeName === null ? [] : [listField(AOSR_FIELDS.documents, [schemeName])]),
    ];
    return actGraph(fields);
  }

  it('расхождение числа слоёв даёт fail и называет ОБА числа', () => {
    const graph = schemeGraph(
      'Устройство 2 слоя гидроизоляции',
      'Исполнительная схема устройства 1 слоя гидроизоляции',
    );
    expect(verdictOf('AOSR.P4.081', graph)).toBe('fail');
    const message = messagesOf('AOSR.P4.081', graph)[0] ?? '';
    expect(message).toContain('слой');
    expect(message).toContain('в п. 1 указано 2');
    expect(message).toContain('в наименовании схемы — 1');
  });

  it('совпадение числа слоёв даёт pass', () => {
    // Чувствительность: меняется РОВНО число в наименовании схемы.
    const graph = schemeGraph(
      'Устройство 2 слоя гидроизоляции',
      'Исполнительная схема устройства 2 слоёв гидроизоляции',
    );
    expect(verdictOf('AOSR.P4.081', graph)).toBe('pass');
  });

  it('расхождение ловится и по заголовку исполнительной схемы', () => {
    const graph = makeGraph({
      documents: [
        makeAct(
          replacing(
            healthyActFields(),
            text(AOSR_FIELDS.workName, 'Устройство 2 слоя гидроизоляции'),
          ),
        ),
        makeDocument({
          docTypeCode: 'exec_scheme',
          title: 'Схема устройства 1 слоя гидроизоляции',
        }),
      ],
    });
    expect(verdictOf('AOSR.P4.081', graph)).toBe('fail');
  });

  it('без количественного признака вердикт undetermined, а не pass', () => {
    const graph = schemeGraph('Устройство гидроизоляции', 'Исполнительная схема гидроизоляции');
    expect(verdictOf('AOSR.P4.081', graph)).toBe('undetermined');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('AOSR.P4.081', graphWithoutActs())).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// Два битых ОГРН — через ДВИЖОК
// ---------------------------------------------------------------------------

describe('два битых ОГРН корпуса дают разные вердикты (прогон через движок)', () => {
  function identifierGraph(
    fieldCode: string,
    value: string,
    blockType: 'text' | 'stamp',
  ): CheckGraph {
    return actGraph(
      replacing(
        healthyActFields(),
        makeField({ fieldCode, valueText: value, confidence: 0.92, blockType }),
      ),
    );
  }

  it('ОГРН из 12 цифр с чистого текстового блока даёт fail и блокирующее замечание', () => {
    const run = runAll(identifierGraph(AOSR_FIELDS.contractorOgrn, '102770001234', 'text'));
    const execution = executionOf(run, 'AOSR.HDR.022');
    expect(execution.verdict).toBe('fail');
    const finding = run.findings.find((entry) => entry.ruleCode === 'AOSR.HDR.022');
    expect(finding?.state).toBe('open');
    expect(finding?.isBlocking).toBe(true);
    expect(finding?.message).toContain('указано 12 цифр');
  });

  it('ОГРН с битой суммой, вычитанный с печати, даёт undetermined и не блокирует', () => {
    const run = runAll(identifierGraph(AOSR_FIELDS.contractorOgrn, '1027700012345', 'stamp'));
    expect(executionOf(run, 'AOSR.HDR.022').verdict).toBe('undetermined');
    const finding = run.findings.find((entry) => entry.ruleCode === 'AOSR.HDR.022');
    expect(finding?.state).toBe('undetermined');
    expect(finding?.isBlocking).toBe(false);
    expect(finding?.message).toContain('ожидалась 0, указана 5');
    expect(finding?.message).toContain('низкой уверенностью');
    expect(finding?.confidence).toBe(0.5);
  });

  it('различает не номер, а источник: тот же ОГРН с текстового блока даёт fail', () => {
    // Ключевой тест чувствительности. Интринсически «12 цифр» и «битая сумма»
    // одинаково объяснимы потерей цифры при OCR, поэтому разделять их обязан
    // потолок уверенности stamp-блока, а не значение реквизита.
    const run = runAll(identifierGraph(AOSR_FIELDS.contractorOgrn, '1027700012345', 'text'));
    expect(executionOf(run, 'AOSR.HDR.022').verdict).toBe('fail');
  });

  it('ИНН ведёт себя так же: длина с текста — fail, сумма с печати — undetermined', () => {
    const short = runAll(identifierGraph(AOSR_FIELDS.contractorInn, '770957409', 'text'));
    expect(executionOf(short, 'AOSR.HDR.021').verdict).toBe('fail');

    const stamped = runAll(identifierGraph(AOSR_FIELDS.contractorInn, '7709574094', 'stamp'));
    expect(executionOf(stamped, 'AOSR.HDR.021').verdict).toBe('undetermined');

    const printed = runAll(identifierGraph(AOSR_FIELDS.contractorInn, '7709574094', 'text'));
    expect(executionOf(printed, 'AOSR.HDR.021').verdict).toBe('fail');
  });

  it('замечание о реквизите несёт уверенность и доказательство', () => {
    const run = runAll(identifierGraph(AOSR_FIELDS.contractorOgrn, '102770001234', 'text'));
    const finding = run.findings.find((entry) => entry.ruleCode === 'AOSR.HDR.022');
    expect(finding?.confidence).toBe(0.92);
    expect(finding?.evidence?.[0]?.pageTextVersionId).toBe('ptv-1');
    expect(finding?.sourcePageId).toBe('page-1');
    expect(finding?.targetType).toBe('field_value');
  });
});

// ---------------------------------------------------------------------------
// Открытый мир (§17)
// ---------------------------------------------------------------------------

describe('открытый мир: незнакомое не порождает ошибку', () => {
  function openWorldGraph(): CheckGraph {
    return makeGraph({
      profile: makeUnconfiguredProfile(),
      documents: [
        makeDocument({
          docTypeCode: null,
          isKnownType: false,
          ordinal: 1,
          title: 'Неизвестный лист',
          fields: [text(AOSR_FIELDS.number, '77-А')],
        }),
        makeDocument({
          docTypeCode: 'other_quality_document',
          isFallbackType: true,
          ordinal: 2,
          title: 'Иной документ о качестве',
          fields: [
            text(AOSR_FIELDS.number, '16005'),
            text(AOSR_FIELDS.manufacturer, 'ООО «ПромСорт-Тула»'),
            listField(AOSR_FIELDS.gostTu, ['СТО 00287852-005-2015']),
          ],
        }),
        makeDocument({
          docTypeCode: 'other_act',
          isFallbackType: true,
          ordinal: 3,
          title: 'Иной акт',
          fields: [text(AOSR_FIELDS.contractorOgrn, '102770001234')],
        }),
      ],
    });
  }

  it('прогон по всем правилам файла не даёт ни одного вердикта fail', () => {
    const run = runAll(openWorldGraph());
    expect(run.executions.filter((execution) => execution.verdict === 'fail')).toEqual([]);
    expect(run.counts.failed).toBe(0);
    expect(run.counts.blocking).toBe(0);
  });

  it('правила АОСР объявлены неприменимыми, а не пройденными', () => {
    const run = runAll(openWorldGraph());
    for (const spec of AOSR_RULES) {
      expect(executionOf(run, spec.code).verdict).toBe('n_a');
    }
    expect(executionOf(run, 'MAT.110').reason).toBe('профиль раздела не настроен');
  });

  it('тест чувствителен: тот же прогон на комплекте с уверенным типом даёт fail', () => {
    // Без этой пары «ноль fail» доказывал бы лишь то, что правила молчат всегда.
    const defective = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorOgrn, '102770001234')),
    );
    const run = runAll(defective);
    expect(run.counts.failed).toBeGreaterThan(0);
    expect(executionOf(run, 'AOSR.HDR.022').verdict).toBe('fail');
  });

  it('второй рубеж: при ПРЯМОМ вызове акт с неуверенным типом тоже даёт n_a', () => {
    // Движок отсекает такие документы в `decideApplicability`, но фильтр
    // продублирован в теле каждого правила: одна защита, снятая правкой
    // движка, оставила бы дефектный акт резервного типа порождать `fail`.
    const broken = [
      text(AOSR_FIELDS.contractorOgrn, '102770001234'),
      text(AOSR_FIELDS.contractorInn, '770957409'),
      text(AOSR_FIELDS.workName, '   '),
    ];
    const uncertain = makeGraph({
      documents: [makeAct(broken, { isKnownType: false, needsReview: true })],
    });
    const fallback = makeGraph({
      documents: [makeAct(broken, { isFallbackType: true })],
    });

    for (const spec of AOSR_RULES) {
      expect([spec.code, verdictOf(spec.code, uncertain)]).toEqual([spec.code, 'n_a']);
      expect([spec.code, verdictOf(spec.code, fallback)]).toEqual([spec.code, 'n_a']);
    }
  });

  it('движок не роняет ни одного правила на пустом графе', () => {
    const run = runAll(makeGraph());
    expect(run.executions).toHaveLength(ALL_RULES.length);
    expect(run.counts.failed).toBe(0);
  });
});
