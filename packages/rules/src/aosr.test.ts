/**
 * Тесты правил АОСР, перекрёстных сверок и правил минимального набора (S59).
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
 * - понижение тяжести (`severityOverride`) применяет движок: «марка расходится»
 *   и «срок истекает» обязаны доезжать до замечания предупреждением, а не
 *   ошибкой, и видно это только после наложения снимка ruleset.
 *
 * Остальные правила проверяются прямым вызовом с `defaultParams`: так падение
 * указывает на правило, а не на движок. Каждый прямой вызов проходит через
 * `inconsistencyOf` — правило, объявившее `pass` при открытом замечании,
 * роняет тест на месте.
 *
 * Правила, снятые в S59 (ADR-0029), проверяются одним блоком на семейство:
 * кода нет в `RULE_CATALOG`, спек остался среди снятых ради контрольных сумм
 * применённых миграций, заглушка отвечает `n_a` «правило снято с исполнения».
 * Поведенческие тесты снятых правил удалены вместе с телами правил: тест на
 * поведение, которого нет, доказывал бы только то, что автор помнит, что снял.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AOSR_FIELDS,
  AOSR_RULES,
  AOSR_SIGNER_ROLES,
  CROSSCHECK_RULES,
  EXTERNAL_RULES,
  MINIMAL_RULES,
  TRANSFER_REGISTRY_RULES,
} from './aosr.js';
import { RETIRED_RULES, RULE_CATALOG } from './catalog.js';
import { periodOfEarliestAct } from './helpers.js';
import { runRules } from './engine.js';
import { inconsistencyOf } from './result.js';
import {
  makeCounterparty,
  makeDocument,
  makeField,
  makeGraph,
  makeObject,
  makeProfile,
  makeRegistryRow,
  makeUnconfiguredProfile,
  resetTestIds,
  snapshotOf,
} from './testing.js';
import type {
  CheckGraph,
  DocumentNode,
  FieldNode,
  PreparedFinding,
  RegistryRowNode,
  RuleExecution,
  RuleResult,
  RuleRunResult,
  RuleSpec,
} from './types.js';

const ALL_RULES: readonly RuleSpec[] = [
  ...AOSR_RULES,
  ...CROSSCHECK_RULES,
  ...TRANSFER_REGISTRY_RULES,
  ...EXTERNAL_RULES,
  ...MINIMAL_RULES,
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

/** Прогон одного правила через движок: тяжесть и блокировка приезжают из снимка. */
function runOne(
  code: string,
  graph: CheckGraph,
): { execution: RuleExecution; findings: readonly PreparedFinding[] } {
  const spec = specOf(code);
  const run = runRules(graph, {
    specs: [spec],
    snapshot: snapshotOf([spec]),
    enabledRuleCodes: null,
  });
  return { execution: executionOf(run, code), findings: run.findings };
}

function executionOf(run: RuleRunResult, code: string): RuleExecution {
  const execution = run.executions.find((entry) => entry.ruleCode === code);
  if (execution === undefined) throw new Error(`правило ${code} не исполнялось`);
  return execution;
}

/**
 * Блок «снято с исполнения» — один на семейство, по образцу `AOSR.ACT.032` (S30).
 *
 * Проверяется ровно три вещи, и каждая ловит свой способ вернуть правило
 * через чёрный ход: код в `RULE_CATALOG` (движок стал бы его исполнять), спек
 * вне `RETIRED_RULES` (сверка при старте объявила бы строку БД сиротой),
 * живое тело вместо заглушки (реализация разошлась бы с движком молча).
 */
function describeRetired(family: string, codes: readonly string[]): void {
  describe(`${family} — снято с исполнения (S59, ADR-0029)`, () => {
    it('кодов нет в каталоге правил', () => {
      for (const code of codes) {
        expect(
          RULE_CATALOG.some((spec) => spec.code === code),
          code,
        ).toBe(false);
      }
    });

    it('спеки остались только среди снятых — ради контрольных сумм применённых миграций', () => {
      const retired = RETIRED_RULES.map((spec) => spec.code);
      for (const code of codes) expect(retired, code).toContain(code);
    });

    it('заглушка отвечает n_a «правило снято с исполнения» на любом графе', () => {
      for (const code of codes) {
        const result = evaluate(code, actGraph(healthyActFields()));
        expect(result.verdict, code).toBe('n_a');
        expect(result.reason, code).toBe('правило снято с исполнения');
      }
    });
  });
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
 *
 * Пункта 3 здесь нет намеренно: `AOSR.P3.070` на таком акте отвечает «п. 3 не
 * распознан», и каждый его тест добавляет перечень сам.
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

beforeEach(() => {
  resetTestIds();
});

// ---------------------------------------------------------------------------
// Каталог
// ---------------------------------------------------------------------------

describe('каталог правил S9.3/S9.5', () => {
  it('содержит ровно согласованные коды', () => {
    // Списки включают СНЯТЫЕ коды: спеки остаются в своих массивах ради
    // применённых миграций сида (0017), а действующий состав задаёт
    // `catalog.ts` полем `retired` — его проверяет `catalog.test.ts`.
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
    expect(MINIMAL_RULES.map((spec) => spec.code)).toEqual(['SCH.681', 'XS.131']);
  });

  it('привязывает правила АОСР к типу документа, а сверки — к папке', () => {
    expect(AOSR_RULES.every((spec) => spec.docTypeCode === 'aosr')).toBe(true);
    expect(AOSR_RULES.every((spec) => spec.level === 'document')).toBe(true);
    expect(AOSR_RULES.every((spec) => spec.requiresExternalRegistry === null)).toBe(true);
    expect([...CROSSCHECK_RULES, ...EXTERNAL_RULES].every((s) => s.docTypeCode === null)).toBe(
      true,
    );
    // До S59 здесь ожидалось `['sro', 'nrs', 'schedule']`. Правила сняты, и
    // требование реестра снято вместе с ними: поле в сид не попадает, а
    // объявлять «правилу нужен реестр» тому, что не исполняется, значило бы
    // печатать в отчёте прогона проверку, которой нет.
    expect(EXTERNAL_RULES.map((spec) => spec.requiresExternalRegistry)).toEqual([null, null, null]);
  });

  it('правила минимального набора: схема — на акте, согласованность — на папке', () => {
    const scheme = specOf('SCH.681');
    expect([scheme.level, scheme.docTypeCode, scheme.defaultSeverity]).toEqual([
      'document',
      'aosr',
      'warning',
    ]);
    const folder = specOf('XS.131');
    expect([folder.level, folder.docTypeCode, folder.defaultSeverity]).toEqual([
      'folder',
      null,
      'warning',
    ]);
    expect(MINIMAL_RULES.every((spec) => !spec.defaultBlocking)).toBe(true);
  });

  it('ни одно правило файла не требует профиля раздела', () => {
    // До S59 профиль требовали `AOSR.P3.070` (категории материалов) и `MAT.110`
    // (матрица раздела). Обе настройки убраны из профиля: вопрос «есть ли у
    // материала документ» от раздела не зависит, а матрицы больше нет.
    const withProfile = ALL_RULES.filter((spec) => spec.requiresSectionProfile).map((s) => s.code);
    expect(withProfile).toEqual([]);
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

  it('разночтение адреса при одном кадастровом номере замечания не даёт', () => {
    // Папка «ИД Мастер апрель 2026»: акт печатает «Мосфильмовская, д.31А»,
    // карточка — «Мосфильмовская ул., вл. 31А». Одиннадцать предупреждений об
    // одном объекте, и совет «привести акты к формулировке карточки».
    const graph = actGraph(
      replacing(
        healthyActFields(),
        text(
          AOSR_FIELDS.objectName,
          'Жилой комплекс по адресу: г. Москва, Мосфильмовская, д.31А, ' +
            'кадастровый № 77:07:0010004:24',
        ),
      ),
      {
        object: makeObject({
          name: 'ЖК «Пример»',
          fullName:
            'Жилой комплекс, расположенный по адресу: г. Москва, Мосфильмовская ул., вл. 31А, ' +
            'земельный участок, кадастровый №77:07:0010004:24',
        }),
      },
    );
    expect(verdictOf('AOSR.HDR.010', graph)).toBe('pass');
  });

  it('разошедшийся кадастровый номер — замечание с обеими записями', () => {
    // Чувствительность: идентификатор решает в обе стороны.
    const graph = actGraph(
      replacing(
        healthyActFields(),
        text(AOSR_FIELDS.objectName, 'Жилой комплекс, кадастровый № 77:07:0010004:99'),
      ),
      {
        object: makeObject({
          name: 'ЖК «Пример»',
          fullName: 'Жилой комплекс, кадастровый №77:07:0010004:24',
        }),
      },
    );
    expect(verdictOf('AOSR.HDR.010', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.010', graph)[0]).toContain('77:07:0010004:99');
    expect(messagesOf('AOSR.HDR.010', graph)[0]).toContain('77:07:0010004:24');
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

  it('косая черта вместо нуля даёт undetermined, а не обвинение в неверном ИНН', () => {
    // Акт № 48-ОТ/-1 этаж папки «ИД Мастер апрель 2026»: ИНН пришёл как
    // «77/8203762», а в одиннадцати других актах той же папки прочитан верно.
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '77/8203762')),
    );
    expect(verdictOf('AOSR.HDR.021', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.HDR.021', graph)[0]).toContain('прочитан со знаком');
  });

  it('чистые цифры с битой суммой по-прежнему ошибка', () => {
    // Чувствительность: поблажка держится на постороннем знаке, а не на самом
    // факте несовпадения.
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '770820376')),
    );
    expect(verdictOf('AOSR.HDR.021', graph)).toBe('fail');
  });

  it('разделитель разрядов посторонним знаком не считается', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '7709 574094')),
    );
    expect(verdictOf('AOSR.HDR.021', graph)).toBe('fail');
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

/**
 * С S59 правило ищет лицо по ИНН, затем по ОГРН, и НЕ сверяет наименование:
 * одно и то же ИНН в боевой базе встречается в трёх написаниях. Заголовок
 * правила в сиде заморожен и по-прежнему говорит о «тройке».
 */
describe('AOSR.HDR.023 — лицо, выполнившее работы, есть в справочнике по ИНН', () => {
  const directory = [
    makeCounterparty({
      name: 'ООО «СТРОЙПРОФИЛЬ»',
      inn: '7700123459',
      ogrn: '1037700056789',
    }),
  ];

  it('ИНН найден в справочнике — pass', () => {
    expect(
      verdictOf('AOSR.HDR.023', actGraph(healthyActFields(), { counterparties: directory })),
    ).toBe('pass');
  });

  it('наименование не сверяется: другое написание при том же ИНН — pass', () => {
    // «ОЛИМПРОЕКТ», «Олимпроект», «ОЛИМППРОЕКТ» на одном ИНН боевой базы:
    // сверять название значило бы обвинять акт в орфографии. Здесь написание
    // расходится с карточкой вовсе, и это не замечание.
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorName, 'ООО «Олимппроект»')),
      { counterparties: directory },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('pass');
    expect(messagesOf('AOSR.HDR.023', graph)).toEqual([]);
  });

  it('ни ИНН, ни ОГРН не распознаны — undetermined, искать нечем', () => {
    const graph = actGraph(
      without(healthyActFields(), AOSR_FIELDS.contractorInn, AOSR_FIELDS.contractorOgrn),
      { counterparties: directory },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.HDR.023', graph)[0]).toContain('ни ИНН, ни ОГРН');
  });

  it('ИНН не распознан, но ОГРН нашёл лицо — pass', () => {
    // Второй ключ, а не второе замечание: ОГРН — тот же реквизит, что и
    // искали, только с другой стороны.
    const graph = actGraph(without(healthyActFields(), AOSR_FIELDS.contractorInn), {
      counterparties: directory,
    });
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('pass');
  });

  it('лицо не найдено ни по ИНН, ни по ОГРН — fail «не найдено в справочнике»', () => {
    // До S59 это было `undetermined`. Заказчик просил ровно этот вопрос —
    // «есть ли исполнитель в справочнике», — и «нет» здесь ответ, а не незнание:
    // оба идентификатора прочитаны чисто, справочник не пуст.
    const graph = actGraph(
      replacing(
        replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '7711223342')),
        text(AOSR_FIELDS.contractorOgrn, '1157744002217'),
      ),
      { counterparties: [makeCounterparty({ name: 'ООО «Другое»', inn: '5600998870' })] },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('fail');
    const message = messagesOf('AOSR.HDR.023', graph)[0] ?? '';
    expect(message).toContain('не найдено в справочнике');
    expect(message).toContain('7711223342');
  });

  it('нечитаемый знак в ИНН при совпавшем ОГРН — undetermined, а не расхождение', () => {
    // Акт № 48-ОТ/-1 этаж папки «ИД Мастер апрель 2026»: ноль прочитан косой
    // чертой («77/8203762»). AOSR.HDR.021 на это отвечает «не проверено», и
    // HDR.023 обязано отвечать так же: иначе одна и та же цифра даёт разом и
    // «проверить нечем», и обвинение в неверном реквизите.
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '77/0123459')),
      { counterparties: directory },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.HDR.023', graph)[0]).toContain('прочитан со знаком');
  });

  it('нечитаемый ИНН без ОГРН — undetermined, а не «не найдено»', () => {
    // Искать по «77/0123459» нечего, а объявить лицо отсутствующим по
    // собственному чтению нельзя.
    const graph = actGraph(
      without(
        replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '77/0123459')),
        AOSR_FIELDS.contractorOgrn,
      ),
      { counterparties: directory },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.HDR.023', graph)[0]).toContain(
      'со знаком, которого в них быть не может',
    );
    expect(messagesOf('AOSR.HDR.023', graph)[0]).not.toContain('не найдено');
  });

  it('расхождение ИНН при совпавшем ОГРН — по-прежнему fail', () => {
    // Чувствительность: поблажка держится на постороннем знаке, а не на самом
    // факте расхождения — иначе правило перестало бы проверять.
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorInn, '7700123458')),
      { counterparties: directory },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.023', graph)[0]).toContain('расходится со справочником');
  });

  it('расхождение ОГРН при совпавшем ИНН даёт fail и называет ОГРН справочника', () => {
    const graph = actGraph(
      replacing(healthyActFields(), text(AOSR_FIELDS.contractorOgrn, '1157744002217')),
      { counterparties: directory },
    );
    expect(verdictOf('AOSR.HDR.023', graph)).toBe('fail');
    expect(messagesOf('AOSR.HDR.023', graph)[0]).toContain('1037700056789');
  });

  it('пустой справочник делает правило неприменимым, без актов — тоже', () => {
    expect(verdictOf('AOSR.HDR.023', actGraph(healthyActFields()))).toBe('n_a');
    expect(
      verdictOf('AOSR.HDR.023', makeGraph({ ...graphWithoutActs(), counterparties: directory })),
    ).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// AOSR.ACT
// ---------------------------------------------------------------------------

// У объектов шаблон номера не задан ни разу — правило отвечало «неприменимо»
// на каждом прогоне.
describeRetired('AOSR.ACT.030 — номер акта по шаблону объекта', ['AOSR.ACT.030']);

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

// Номер изменения шифра и справочник РД не входят в минимальный набор;
// справочник РД на бою пуст.
describeRetired('AOSR.P2.060 / AOSR.P2.061 — шифр РД', ['AOSR.P2.060', 'AOSR.P2.061']);

/**
 * MAT.COVER (S59): пункт 3 читается по-настоящему.
 *
 * Прежняя реализация читала `graph.materials`, а материалы выводятся из
 * документов качества: документ у каждого «материала» был по построению, и
 * правило не могло дать ошибку. Здесь — записи п. 3: ссылка на реестр либо
 * перечисление «материал (документ № …)», и подтверждение номером ИЛИ
 * названием.
 */
describe('AOSR.P3.070 — материалы п. 3 подтверждены документами (MAT.COVER)', () => {
  const REGISTRY_REF = 'Реестр 1 к АОСР №ПБ-1 от 31.03.2026г';
  /** Запись п. 3 из боевого акта: две позиции, у второй — «Сертификат №275». */
  const CORPUS_ENTRY =
    '1.Песок для строительных работ (Паспорт №0297 от 26.09.2024г., ' +
    'Сертификат соответствия №RU.MCC.234 (с 01.01.2024)). ' +
    '2.Смесь сухая шпатлевочная КНАУФ-Тифенгрунд (Сертификат №275 от 10.01.2025)';
  const KNAUF_ENTRY =
    '1. Смесь сухая шпатлевочная КНАУФ-Тифенгрунд (Сертификат №275 от 10.01.2025)';

  function registry(number: string | null, title: string | null = null): DocumentNode {
    return makeDocument({
      docTypeCode: 'annex_registry',
      title,
      fields: number === null ? [] : [text('registry_number', number)],
    });
  }

  function qualityDoc(
    docTypeCode: string | null,
    number: string | null,
    productName: string | null,
    patch: Partial<DocumentNode> = {},
  ): DocumentNode {
    return makeDocument({
      docTypeCode,
      fields: [
        ...(number === null ? [] : [text(AOSR_FIELDS.number, number)]),
        ...(productName === null ? [] : [text('product_name', productName)]),
      ],
      ...patch,
    });
  }

  function coverGraph(
    entries: readonly string[],
    documents: readonly DocumentNode[],
    patch: Partial<CheckGraph> = {},
  ): CheckGraph {
    return makeGraph({
      object: makeObject({ name: 'Автостоянка' }),
      documents: [
        makeAct([...healthyActFields(), listField(AOSR_FIELDS.materials, entries)]),
        ...documents,
      ],
      ...patch,
    });
  }

  it('ссылка на реестр найдена по реквизиту registry_number — pass', () => {
    expect(verdictOf('AOSR.P3.070', coverGraph([REGISTRY_REF], [registry('1')]))).toBe('pass');
  });

  it('ссылка в отдельном реквизите p3_registry_ref читается так же', () => {
    const graph = makeGraph({
      object: makeObject({ name: 'Автостоянка' }),
      documents: [
        makeAct([
          ...healthyActFields(),
          text(AOSR_FIELDS.registryRef, 'Перечислено в реестре приложений №1'),
        ]),
        registry('1'),
      ],
    });
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('реестр найден по заголовку, когда в реквизите лежат 13 цифр ОГРН — pass', () => {
    // До S59 реквизит извлекался шаблоном ОГРН, и в боевой базе у каждого
    // реестра там тринадцать цифр. Правило обязано работать на том, что есть:
    // тринадцать цифр номером реестра не считаются, заголовок — считается.
    const graph = coverGraph(
      [REGISTRY_REF],
      [registry('1037700056789', 'Реестр № 1 к АОСР № ПБ-1 от 31.03.2026 г.')],
    );
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('ссылка на реестр № 2 при единственном реестре № 1 — fail', () => {
    const graph = coverGraph(['Реестр 2 к АОСР №ПБ-1 от 31.03.2026г'], [registry('1')]);
    expect(verdictOf('AOSR.P3.070', graph)).toBe('fail');
    expect(messagesOf('AOSR.P3.070', graph)[0]).toContain('Реестр приложений № 2');
    expect(messagesOf('AOSR.P3.070', graph)[0]).toContain('отсутствует');
  });

  it('единственный реестр без номера — undetermined: тот ли это реестр, установить нечем', () => {
    const graph = coverGraph([REGISTRY_REF], [registry(null)]);
    expect(verdictOf('AOSR.P3.070', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.P3.070', graph)[0]).toContain('номер не прочитан');
  });

  it('реестра нет, но есть неразобранные листы — undetermined', () => {
    const graph = coverGraph([REGISTRY_REF], [], { coverageGaps: 1 });
    expect(verdictOf('AOSR.P3.070', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.P3.070', graph)[0]).toContain('не разобрал');
  });

  it('перечисление из двух позиций: обе подтверждены номерами — pass', () => {
    const graph = coverGraph(
      [CORPUS_ENTRY],
      [
        qualityDoc('quality_passport', '0297', 'Песок для строительных работ'),
        qualityDoc('cert_conformity', 'RU.MCC.234', 'Песок для строительных работ'),
        qualityDoc('cert_conformity', '275', 'Смесь сухая шпатлевочная КНАУФ-Тифенгрунд'),
      ],
    );
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('«Сертификат №275» и документ с number «275» — pass', () => {
    const graph = coverGraph(
      [KNAUF_ENTRY],
      [qualityDoc('cert_conformity', '275', 'Смесь сухая шпатлевочная КНАУФ-Тифенгрунд')],
    );
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('номер совпал на документе незнакомого вида — тоже pass (§0.5)', () => {
    // Сертификат незнакомой формы остаётся сертификатом: по номеру годится
    // любой документ среза, кроме актов и перечней; название берётся из
    // заголовка.
    const graph = coverGraph(
      [KNAUF_ENTRY],
      [qualityDoc(null, '275', null, { title: 'Смесь сухая шпатлевочная КНАУФ-Тифенгрунд' })],
    );
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('номер совпал, а марка расходится — открытое замечание с понижением до warning', () => {
    const graph = coverGraph([KNAUF_ENTRY], [qualityDoc('cert_conformity', '275', 'КНАУФ-Фуген')]);
    const result = evaluate('AOSR.P3.070', graph);
    expect(result.verdict).toBe('fail');
    expect(result.findings?.[0]?.state).toBe('open');
    expect(result.findings?.[0]?.severityOverride).toBe('warning');
    expect(result.findings?.[0]?.message).toContain('марка расходится');
    expect(result.findings?.[0]?.message).toContain('КНАУФ-Фуген');

    // Через движок: снимок говорит `error`, правило понижает до `warning`, и
    // блокировки у такого замечания нет.
    const { execution, findings } = runOne('AOSR.P3.070', graph);
    expect(execution.verdict).toBe('fail');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.isBlocking).toBe(false);
  });

  it('порог сходства — из профиля раздела: 0.5 делает пару КНАУФ проходящей', () => {
    // Мутация порога. У «КНАУФ-Тифенгрунд» против «КНАУФ-Фуген» сходство ровно
    // 0.5: при умолчании 0.75 это предупреждение, при пороге профиля 0.5 —
    // совпадение. Сними чтение `nameSimilarityThreshold` — тест покраснеет.
    const graph = coverGraph([KNAUF_ENTRY], [qualityDoc('cert_conformity', '275', 'КНАУФ-Фуген')], {
      profile: makeProfile({ thresholds: { nameSimilarityThreshold: 0.5 } }),
    });
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('номера нет, но паспорт с похожим наименованием — pass', () => {
    const graph = coverGraph(
      ['1. Техноэласт ЭПП (Паспорт качества от 01.02.2026)'],
      [qualityDoc('quality_passport', null, 'Материал рулонный Техноэласт П ЭПП')],
    );
    expect(verdictOf('AOSR.P3.070', graph)).toBe('pass');
  });

  it('по названию подтверждает только документ о качестве', () => {
    // Чувствительность к предыдущему: исполнительная схема с тем же названием
    // материал не подтверждает — по названию годятся только документы качества.
    const graph = coverGraph(
      ['1. Техноэласт ЭПП (Паспорт качества от 01.02.2026)'],
      [makeDocument({ docTypeCode: 'exec_scheme', title: 'Техноэласт ЭПП' })],
    );
    expect(verdictOf('AOSR.P3.070', graph)).toBe('fail');
  });

  it('«ветонит ЛР+» без документов — fail с названием материала и номером', () => {
    const graph = coverGraph(['1. ветонит ЛР+ (Паспорт № 12345 от 01.02.2026)'], []);
    expect(verdictOf('AOSR.P3.070', graph)).toBe('fail');
    const message = messagesOf('AOSR.P3.070', graph)[0] ?? '';
    expect(message).toContain('ветонит ЛР+');
    expect(message).toContain('12345');
  });

  it('документов нет, но есть неразобранные листы — undetermined', () => {
    const graph = coverGraph(['1. ветонит ЛР+ (Паспорт № 12345 от 01.02.2026)'], [], {
      coverageGaps: 1,
    });
    expect(verdictOf('AOSR.P3.070', graph)).toBe('undetermined');
  });

  it('п. 3 не распознан — undetermined, а не «материалы подтверждены»', () => {
    const graph = actGraph(healthyActFields());
    expect(verdictOf('AOSR.P3.070', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.P3.070', graph)[0]).toContain('не распознан п. 3');
  });

  it('запись, не разобранная на позиции, — undetermined с текстом записи', () => {
    const graph = coverGraph(['см. приложения'], []);
    expect(verdictOf('AOSR.P3.070', graph)).toBe('undetermined');
    expect(messagesOf('AOSR.P3.070', graph)[0]).toContain('см. приложения');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('AOSR.P3.070', graphWithoutActs())).toBe('n_a');
  });

  it('профиль раздела не требуется: без профиля правило исполняется, а не молчит', () => {
    // До S59 правило требовало профиль ради категорий материалов. Раздел без
    // профиля теперь получает тот же ответ, что и настроенный.
    expect(specOf('AOSR.P3.070').requiresSectionProfile).toBe(false);
    const graph = coverGraph(['1. ветонит ЛР+ (Паспорт № 12345 от 01.02.2026)'], [], {
      profile: makeUnconfiguredProfile(),
    });
    expect(runOne('AOSR.P3.070', graph).execution.verdict).toBe('fail');
  });
});

describe('AOSR.P3.071 — ссылка на реестр при длинном перечне', () => {
  const many = ['д1', 'д2', 'д3', 'д4', 'д5', 'д6'];
  const manyDocuments = [1001, 1002, 1003, 1004, 1005, 1006].map((n) => `Паспорт № ${String(n)}`);

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
    expect(messagesOf('AOSR.P3.071', graph)[0]).toContain('п. 3');
  });

  it('длинный перечень со ссылкой на реестр даёт pass', () => {
    const graph = actGraph([
      ...healthyActFields(),
      listField(AOSR_FIELDS.materials, many),
      text(AOSR_FIELDS.registryRef, 'Реестр приложений № 1'),
    ]);
    expect(verdictOf('AOSR.P3.071', graph)).toBe('pass');
  });

  it('ссылка на реестр внутри самой записи п. 3 тоже считается', () => {
    const graph = actGraph([
      ...healthyActFields(),
      listField(AOSR_FIELDS.materials, [...many, 'Реестр 1 к АОСР №ПБ-1 от 31.03.2026г']),
    ]);
    expect(verdictOf('AOSR.P3.071', graph)).toBe('pass');
  });

  it('шесть документов в п. 4 без ссылки — fail с указанием «п. 4» (S59)', () => {
    // По практике заказчика при стольких же схемах в акте появляется реестр № 2.
    const graph = actGraph([
      ...healthyActFields(),
      listField(AOSR_FIELDS.documents, manyDocuments),
    ]);
    expect(verdictOf('AOSR.P3.071', graph)).toBe('fail');
    expect(messagesOf('AOSR.P3.071', graph)[0]).toContain('п. 4');
    expect(messagesOf('AOSR.P3.071', graph)[0]).toContain('6 документов');
  });

  it('ссылка «Реестр 2 к АОСР…» среди записей п. 4 — pass', () => {
    const graph = actGraph([
      ...healthyActFields(),
      listField(AOSR_FIELDS.documents, [...manyDocuments, 'Реестр 2 к АОСР №ПВ-1 от 31.03.2026г']),
    ]);
    expect(verdictOf('AOSR.P3.071', graph)).toBe('pass');
  });

  it('порог берётся из профиля раздела поверх снимка', () => {
    const graph = actGraph(
      [...healthyActFields(), listField(AOSR_FIELDS.materials, ['д1', 'д2', 'д3'])],
      {
        profile: makeProfile({ thresholds: { maxDocumentsWithoutRegistry: 2 } }),
      },
    );
    expect(verdictOf('AOSR.P3.071', graph)).toBe('fail');
    expect(messagesOf('AOSR.P3.071', graph)[0]).toContain('больше 2');
  });

  it('без перечней п. 3 и п. 4 правило неприменимо', () => {
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

  /**
   * S59: запись «Реестр 2 к АОСР № …» — ссылка на реестр, а не документ.
   *
   * До S59 номер после «к АОСР» читался номером строки, и правило искало
   * документ «ПВ-1» — то есть акт, к которому реестр приложен, — и не находило.
   * На скриншоте заказчика «ПБ-1» к тому же прочитан как «ПВ-1»: номер акта в
   * ссылке не сравнивается, реестр к акту привязала сегментация.
   */
  const P4_REGISTRY_REF = 'Реестр 2 к АОСР №ПВ-1 от 31.03.2026г';

  function p4Graph(registryTitle: string | null): CheckGraph {
    return makeGraph({
      documents: [
        makeAct([...healthyActFields(), listField(AOSR_FIELDS.documents, [P4_REGISTRY_REF])]),
        ...(registryTitle === null
          ? []
          : [makeDocument({ docTypeCode: 'annex_registry', title: registryTitle })]),
      ],
    });
  }

  it('«Реестр 2 к АОСР №ПВ-1» — ссылка на реестр № 2 по заголовку, а не документ «ПВ-1»', () => {
    expect(verdictOf('AOSR.P4.080', p4Graph('Реестр № 2 к АОСР № ПБ-1 от 31.03.2026 г.'))).toBe(
      'pass',
    );
  });

  it('заголовок реестра с опечаткой OCR «Рестр № 2 …» из боевой базы тоже узнаётся', () => {
    // Заголовок в боевой базе прочитан как «Рестр № 2 к АОСР № ПБ-1 от
    // 31.03.2026 г.»: без второй «е» слово теряется целиком, реестр остаётся
    // безномерным, и правило отвечало бы «тот ли это реестр, установить нечем».
    // Разбор в `@id/contracts` (`registryRefNumber`) допускает эту опечатку.
    expect(verdictOf('AOSR.P4.080', p4Graph('Рестр № 2 к АОСР № ПБ-1 от 31.03.2026 г.'))).toBe(
      'pass',
    );
  });

  it('реестра № 2 в комплекте нет — fail с номером реестра', () => {
    const graph = p4Graph(null);
    expect(verdictOf('AOSR.P4.080', graph)).toBe('fail');
    const message = messagesOf('AOSR.P4.080', graph)[0] ?? '';
    expect(message).toContain('Реестр приложений № 2');
    expect(message).not.toContain('ПВ-1');
  });
});

// Число слоёв в наименовании схемы против п. 1 и сравнение п. 7 с п. 1 — не из
// восьми смыслов минимального набора; на бою давали только «не проверено».
describeRetired('AOSR.P4.081 / AOSR.P7.090 — схема против п. 1, п. 7 против п. 1', [
  'AOSR.P4.081',
  'AOSR.P7.090',
]);

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
    // Предложный падеж, а не именительный: замечание читает подрядчик, и
    // «названный в строка 3 реестра» обесценивает самое тяжёлое из того, что
    // портал говорит о комплекте.
    expect(messagesOf('REG.100', missing)[0]).toContain('названный в строке 3 реестра');
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

  it('REG.101: схема и журнал авторского надзора строки в реестре приложений не требуют', () => {
    // Реестр приложений — перечень МАТЕРИАЛЬНЫЙ: его графы «наименование
    // материала» и «организация (производитель)» заводятся на документ о
    // качестве. У исполнительной схемы и учётного листа авторского надзора
    // материала нет, и в реестре приложений их не бывает — они названы п. 4
    // акта и описью передачи. На боевой папке «ИД Мастер апрель 2026» правило
    // выдавало пятнадцать предупреждений из пятнадцати ровно на них, при
    // двенадцати правильно заполненных реестрах.
    const scheme = makeDocument({ docTypeCode: 'exec_scheme', title: 'Исполнительная схема' });
    const log = makeDocument({
      docTypeCode: 'author_supervision_log',
      title: 'УЧЕТНЫЙ ЛИСТ № 118',
    });

    expect(verdictOf('REG.101', registryGraph('matched', [scheme, log]))).toBe('pass');
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
    // Вид документа здесь намеренно материальный: исполнительная схема с S51
    // исключена из ожидаемых в реестре приложений безусловно, и на ней это
    // утверждение проходило бы, даже если бы ветка кандидатов сломалась.
    const certificate = makeDocument({ docTypeCode: 'cert_conformity', title: null });
    const graph = makeGraph({
      documents: [registry, certificate],
      registryRows: [
        makeRegistryRow({
          registryDocumentId: registry.id,
          rowNo: 9,
          docNameRaw: 'Сертификат соответствия',
          docNoRaw: 'СС №002',
          matchState: 'candidate',
          matchedDocumentId: null,
          candidateDocumentIds: [certificate.id],
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

// Расхождения граф строки описи по суждению модели — частичная отмена
// ADR-0028: сопоставление строки — только «есть ли документ»; графа
// «организация» называет поставщика, а документ — изготовителя.
describeRetired('REG.113–117 — расхождения граф строки описи', [
  'REG.113',
  'REG.114',
  'REG.115',
  'REG.116',
  'REG.117',
]);

// ---------------------------------------------------------------------------
// MAT, REF, XS.130, EXT — сняты
// ---------------------------------------------------------------------------

// Матрица раздела, изготовитель партии и год редакции НД — материаловедение,
// которого в минимальном наборе нет; матрицы в профиле больше нет вовсе.
describeRetired('MAT.110 / MAT.111 / MAT.112 — матрица и материаловедение', [
  'MAT.110',
  'MAT.111',
  'MAT.112',
]);

// Активность карточек — справочная отметка, не свойство комплекта; дубль акта
// на бою не встретился ни разу.
describeRetired('REF.120 / REF.121 / XS.130 — справочные отметки и дубль акта', [
  'REF.120',
  'REF.121',
  'XS.130',
]);

// Источников данных (СРО, НРС, график) у портала нет: четыре замечания
// «требуется ручная проверка» на папку, ни одного открытого.
describeRetired('EXT.SRO.140 / EXT.NRS.141 / EXT.SCHED.142 — внешние реестры', [
  'EXT.SRO.140',
  'EXT.NRS.141',
  'EXT.SCHED.142',
]);

// ---------------------------------------------------------------------------
// SCH.681 — к акту приложена исполнительная схема (S59)
// ---------------------------------------------------------------------------

describe('SCH.681 — к акту приложена исполнительная схема, ссылающаяся на его номер', () => {
  function scheme(number: string | null, fieldCode = 'scheme_number'): DocumentNode {
    return makeDocument({
      docTypeCode: 'exec_scheme',
      title: 'Исполнительная схема',
      fields: number === null ? [] : [text(fieldCode, number)],
    });
  }

  function actNumbered(number: string): DocumentNode {
    return makeAct(replacing(healthyActFields(), text(AOSR_FIELDS.actNumber, number)));
  }

  function schemeGraph(
    actNumber: string,
    documents: readonly DocumentNode[],
    patch: Partial<CheckGraph> = {},
  ): CheckGraph {
    return makeGraph({ documents: [actNumbered(actNumber), ...documents], ...patch });
  }

  it('схемы в срезе нет — fail', () => {
    const graph = schemeGraph('48-ОТ/-1 этаж', []);
    expect(verdictOf('SCH.681', graph)).toBe('fail');
    expect(messagesOf('SCH.681', graph)[0]).toContain('не приложена исполнительная схема');
    expect(messagesOf('SCH.681', graph)[0]).toContain('48-ОТ/-1 этаж');
  });

  it('схема есть, у номера акта нет ведущего числа («ПБ-1») — pass', () => {
    // Ссылку номером здесь не выразить, и основной сигнал — схема в срезе —
    // выполнен.
    expect(verdictOf('SCH.681', schemeGraph('ПБ-1', [scheme('2.1-ОТ')]))).toBe('pass');
  });

  it('ведущие целые совпали: акт «48-ОТ/-1 этаж», схема «48.1-ОТ/1-1 ЭТАЖ» — pass', () => {
    // Схема подписана номером акта с индексом; хвост захватки подрядчик пишет
    // как придётся, а распознавание довершает разночтение.
    expect(verdictOf('SCH.681', schemeGraph('48-ОТ/-1 этаж', [scheme('48.1-ОТ/1-1 ЭТАЖ')]))).toBe(
      'pass',
    );
  });

  it('номер схемы в реквизите number читается наравне со scheme_number', () => {
    expect(
      verdictOf('SCH.681', schemeGraph('48-ОТ/-1 этаж', [scheme('48.1-ОТ/1-1 ЭТАЖ', 'number')])),
    ).toBe('pass');
  });

  it('ведущие целые не совпали — undetermined, а не fail', () => {
    // Мутация «убрать проверку ведущего числа» даёт здесь `pass` вместо
    // `undetermined`. Номер листа читается хуже прочего текста, поэтому
    // расхождение — «не проверено», а не обвинение.
    const graph = schemeGraph('48-ОТ/-1 этаж', [scheme('52.1-ОТ/-1 ЭТАЖ')]);
    expect(verdictOf('SCH.681', graph)).toBe('undetermined');
    const message = messagesOf('SCH.681', graph)[0] ?? '';
    expect(message).toContain('не ссылается на номер акта');
    expect(message).toContain('52.1-ОТ/-1 ЭТАЖ');
    expect(message).toContain('48');
  });

  it('номер схемы не распознан — undetermined', () => {
    const graph = schemeGraph('48-ОТ/-1 этаж', [scheme(null)]);
    expect(verdictOf('SCH.681', graph)).toBe('undetermined');
    expect(messagesOf('SCH.681', graph)[0]).toContain('номер не распознан');
  });

  it('схемы нет, но есть неразобранные листы — undetermined', () => {
    const graph = schemeGraph('48-ОТ/-1 этаж', [], { coverageGaps: 1 });
    expect(verdictOf('SCH.681', graph)).toBe('undetermined');
    expect(messagesOf('SCH.681', graph)[0]).toContain('не разобрал');
  });

  it('без актов правило неприменимо', () => {
    expect(verdictOf('SCH.681', graphWithoutActs())).toBe('n_a');
    expect(reasonOf('SCH.681', graphWithoutActs())).toContain('нет акта');
  });

  it('через движок: отсутствие схемы — предупреждение без блокировки', () => {
    const { execution, findings } = runOne('SCH.681', schemeGraph('48-ОТ/-1 этаж', []));
    expect(execution.verdict).toBe('fail');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.isBlocking).toBe(false);
    expect(findings[0]?.targetType).toBe('document');
    expect(findings[0]?.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// XS.131 — объект и шифр проекта одинаковы по всей папке (S59)
// ---------------------------------------------------------------------------

describe('XS.131 — объект и шифр проекта одинаковы по всей папке', () => {
  const OBJECT = 'Жилой комплекс, кадастровый № 77:07:0010004:24';
  const CIPHER = 'ООО "ГК" ОЛИМППРОЕКТ шифр 133/23-ГК-ПБ "Система пожарной сигнализации"';

  function act(
    number: string,
    objectName: string | null,
    ciphers: readonly string[],
    ordinal: number,
  ): DocumentNode {
    let fields = replacing(healthyActFields(), text(AOSR_FIELDS.actNumber, number));
    fields =
      objectName === null
        ? without(fields, AOSR_FIELDS.objectName)
        : replacing(fields, text(AOSR_FIELDS.objectName, objectName));
    fields = replacing(fields, listField(AOSR_FIELDS.rdCipher, ciphers));
    return makeAct(fields, { ordinal });
  }

  function folderGraph(acts: readonly DocumentNode[]): CheckGraph {
    return makeGraph({ documents: [...acts] });
  }

  it('один акт — сверять не между чем, n_a', () => {
    expect(verdictOf('XS.131', folderGraph([act('1', OBJECT, [CIPHER], 1)]))).toBe('n_a');
  });

  it('одинаковый кадастровый номер и общий корень шифра — pass', () => {
    const graph = folderGraph([
      act('1', OBJECT, [CIPHER], 1),
      act('2', OBJECT, ['133/23-ГК-ПБ лист 5'], 2),
    ]);
    expect(verdictOf('XS.131', graph)).toBe('pass');
  });

  it('разные кадастровые номера — fail, одно замечание на папку со списком актов', () => {
    const graph = folderGraph([
      act('1', OBJECT, [CIPHER], 1),
      act('2', 'Жилой комплекс, кадастровый № 77:07:0010004:99', [CIPHER], 2),
    ]);
    const result = evaluate('XS.131', graph);
    expect(result.verdict).toBe('fail');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings?.[0];
    expect(finding?.targetType).toBe('folder');
    expect(finding?.message).toContain('Кадастровый номер объекта расходится');
    expect(finding?.message).toContain('77:07:0010004:24 (№ 1)');
    expect(finding?.message).toContain('77:07:0010004:99 (№ 2)');
  });

  it('кадастровый номер решает раньше формулировки: разные адреса при одном номере — pass', () => {
    // Мутация «убрать сужение по кадастровому номеру» даёт здесь `fail`:
    // формулировки адреса не начало друг друга, а идентификатор один.
    const graph = folderGraph([
      act('1', 'г. Москва, Мосфильмовская, д.31А, кадастровый № 77:07:0010004:24', [CIPHER], 1),
      act(
        '2',
        'г. Москва, Мосфильмовская ул., вл. 31А, кадастровый № 77:07:0010004:24',
        [CIPHER],
        2,
      ),
    ]);
    expect(verdictOf('XS.131', graph)).toBe('pass');
  });

  it('без кадастровых номеров: одно наименование — начало другого, pass', () => {
    const graph = folderGraph([
      act('1', 'Жилой комплекс', [CIPHER], 1),
      act('2', 'Жилой комплекс по адресу: г. Москва', [CIPHER], 2),
    ]);
    expect(verdictOf('XS.131', graph)).toBe('pass');
  });

  it('без кадастровых номеров: разные наименования — fail', () => {
    const graph = folderGraph([
      act('1', 'Жилой комплекс', [CIPHER], 1),
      act('2', 'Автостоянка', [CIPHER], 2),
    ]);
    expect(verdictOf('XS.131', graph)).toBe('fail');
    expect(messagesOf('XS.131', graph)[0]).toContain('Наименование объекта расходится');
  });

  it('шифры без общего корня — fail с обоими корнями', () => {
    const graph = folderGraph([
      act('1', OBJECT, [CIPHER], 1),
      act('2', OBJECT, ['02-200223-ГПЗ.1'], 2),
    ]);
    expect(verdictOf('XS.131', graph)).toBe('fail');
    const message = messagesOf('XS.131', graph)[0] ?? '';
    expect(message).toContain('Шифр проекта расходится');
    // Корень печатается после фолдинга гомоглифов: кириллическая «К» в
    // «ГК» становится латинской «K». Глазами разницы нет, сравнение строкой
    // её видит — отсюда класс символов.
    expect(message).toMatch(/133\/23-Г[КK]-ПБ \(№ 1\)/u);
    expect(message).toContain('02-200223-ГПЗ.1 (№ 2)');
  });

  it('хвост «изм. N» корню не мешает', () => {
    const graph = folderGraph([
      act('1', OBJECT, ['12/2024-АР изм. 1'], 1),
      act('2', OBJECT, ['12/2024-АР изм. 2'], 2),
    ]);
    expect(verdictOf('XS.131', graph)).toBe('pass');
  });

  it('акт без наименования объекта — undetermined, а не расхождение', () => {
    const graph = folderGraph([act('1', OBJECT, [CIPHER], 1), act('2', null, [CIPHER], 2)]);
    expect(verdictOf('XS.131', graph)).toBe('undetermined');
    expect(messagesOf('XS.131', graph)[0]).toContain('не распознано наименование объекта');
  });

  it('акт без распознанного шифра — undetermined', () => {
    // В п. 2 записано название раздела без шифра: корня нет, сверить акт
    // нечем, а обвинять его в расхождении нельзя.
    const graph = folderGraph([
      act('1', OBJECT, [CIPHER], 1),
      act('2', OBJECT, ['Рабочая документация, раздел АР'], 2),
    ]);
    expect(verdictOf('XS.131', graph)).toBe('undetermined');
    expect(messagesOf('XS.131', graph)[0]).toContain('не распознан шифр проекта');
  });

  it('через движок: замечание уровня папки, предупреждение без блокировки', () => {
    const graph = folderGraph([
      act('1', OBJECT, [CIPHER], 1),
      act('2', OBJECT, ['02-200223-ГПЗ.1'], 2),
    ]);
    const { execution, findings } = runOne('XS.131', graph);
    expect(execution.verdict).toBe('fail');
    expect(findings[0]?.targetType).toBe('folder');
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.isBlocking).toBe(false);
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

  it('правила АОСР и минимального набора объявлены неприменимыми, а не пройденными', () => {
    const run = runAll(openWorldGraph());
    for (const spec of [...AOSR_RULES, ...MINIMAL_RULES]) {
      expect(executionOf(run, spec.code).verdict, spec.code).toBe('n_a');
    }
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

    for (const spec of [...AOSR_RULES, ...MINIMAL_RULES]) {
      expect([spec.code, verdictOf(spec.code, uncertain)]).toEqual([spec.code, 'n_a']);
      expect([spec.code, verdictOf(spec.code, fallback)]).toEqual([spec.code, 'n_a']);
    }
  });

  it('движок не роняет ни одного правила на пустом графе', () => {
    const run = runAll(makeGraph());
    expect(run.executions).toHaveLength(ALL_RULES.length);
    expect(run.counts.failed).toBe(0);
  });

  it('снятое правило через движок отвечает n_a с причиной «снято», а не молчит', () => {
    // Движок доходит до заглушки: у `MAT.110` нет ни привязки к виду, ни
    // требования профиля, и единственное, что оно может ответить, — причина
    // снятия. Прежде здесь ожидалось «профиль раздела не настроен».
    const run = runAll(openWorldGraph());
    const execution = executionOf(run, 'MAT.110');
    expect(execution.verdict).toBe('n_a');
    expect(execution.reason).toBe('правило снято с исполнения');
  });
});
