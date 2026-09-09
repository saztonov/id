/**
 * Non-degradable гейт: известные дефекты обнаруживаются минимальным набором
 * правил (§1.6, §17, ADR-0029).
 *
 * Тесты групп правил проверяют каждое правило по отдельности и на фикстуре,
 * собранной под него. Здесь другое: ОДНА папка, воспроизводящая все дефекты
 * сразу, прогоняется через ДВИЖОК полным каталогом (`RULE_CATALOG`) — то есть
 * ровно тем путём, которым идёт `checks.run`. Разница существенна: правило
 * может работать в изоляции и не исполняться в составе набора (нет кода в
 * снимке, отсекла применимость, вердикт понижен уверенностью). Именно этот
 * класс отказа — «код написан, покрыт зелёными тестами и не исполняется» —
 * шесть этапов подряд был главным в проекте.
 *
 * ## Почему набор дефектов другой, чем до S59
 *
 * Гейт держался на семи дефектах корпуса (§0.1), и ПЯТЬ из семи ловились
 * правилами, снятыми в S59 по ADR-0029: изготовитель партии (`MAT.111`), год
 * редакции НД (`MAT.112`), протокол против партий (`DATE.372`), слои в п. 1
 * против схемы (`AOSR.P4.081`), 28-суточные протоколы (`LAB.651`). Заказчик
 * вывел материаловедение из проверок сознательно, и держать эти пять в гейте
 * значило бы гейтить снятое. Остаются два дефекта корпуса — ОГРН из 12 цифр и
 * пустая «Дата выдачи» — и к ним добавлены дефекты, ради которых минимальный
 * набор заведён: материал п. 3 без документа, акт без исполнительной схемы,
 * чужой акт в папке, строка реестра без документа.
 *
 * ## Что здесь считается доказательством
 *
 * Для каждого дефекта проверяются три вещи: код правила присутствует в журнале
 * `executions` — правило ИСПОЛНЯЛОСЬ; его вердикт `fail`; текст замечания
 * содержит конкретику, по которой инженер найдёт место. Плюс парная «здоровая»
 * папка: те же правила на исправленных данных дают ноль открытых замечаний, а
 * разница между папками — РОВНО перечисленные коды. Без этого тест доказывал
 * бы только то, что правила что-то возвращают.
 *
 * Второй сценарий `AOSR.P3.070` — номер совпал, марка расходится — проверяется
 * отдельным тестом: «разница кодов» двух сценариев одного кода не различила бы.
 *
 * ## Значения реквизитов здесь СИНТЕТИЧЕСКИЕ
 *
 * Ни один ИНН, ОГРН, номер документа, ФИО, кадастровый номер или шифр в этом
 * файле не взят из корпуса: §1.4 запрещает настоящие реквизиты корпуса в коде
 * и тестах. Регрессия воспроизводит КЛАСС дефекта, а не конкретное значение.
 * Отсюда требование к синтетике: она обязана быть арифметически корректной там,
 * где корректность проверяется — `INN_VALID` и `OGRN_VALID` проходят
 * контрольную сумму, `OGRN_SHORT` короче на разряд.
 */
import { describe, expect, it } from 'vitest';

import { RULE_CATALOG } from './catalog.js';
import { runRules } from './engine.js';
import {
  makeDocument,
  makeGraph,
  makeObject,
  makeRegistryRow,
  makeRelation,
  snapshotOf,
} from './testing.js';
import type {
  CheckGraph,
  DocumentNode,
  FieldNode,
  PreparedFinding,
  RuleRunResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Строительные блоки папки
// ---------------------------------------------------------------------------

function text(fieldCode: string, value: string, patch: Partial<FieldNode> = {}): FieldNode {
  return {
    id: `f-${fieldCode}-${value.slice(0, 8)}`,
    fieldCode,
    valueText: value,
    valueDate: null,
    valueNum: null,
    valueJson: null,
    confidence: 0.95,
    isVerified: false,
    extractedBy: 'rule',
    pageTextVersionId: 'ptv-1',
    charSpan: { start: 0, end: value.length },
    quote: value,
    sourcePageId: 'page-1',
    blockType: 'text',
    blockId: 'block-1',
    ...patch,
  };
}

function date(fieldCode: string, value: string): FieldNode {
  return { ...text(fieldCode, value), valueDate: value, valueText: null };
}

function list(fieldCode: string, values: readonly string[]): FieldNode {
  return { ...text(fieldCode, values.join(', ')), valueJson: [...values] };
}

/**
 * Папка из двух актов.
 *
 * Параметры выключают дефекты по одному: `NO_DEFECTS` — все исправлены, и
 * тогда ни одно из правил гейта не имеет права дать замечание. Так фикстура
 * перестаёт быть «истинной по построению»: разница между дефектной и здоровой
 * папкой — ровно перечисленные значения.
 */
interface Toggles {
  /** ОГРН из 12 цифр в шапке акта (дефект 1 корпуса). */
  readonly brokenOgrnLength: boolean;
  /** Пустая «Дата выдачи» в техпаспорте (дефект 5 корпуса). */
  readonly emptyIssuedAt: boolean;
  /** В п. 3 назван «Сертификат №275», а документа в комплекте нет. */
  readonly uncoveredMaterial: boolean;
  /** К актам не приложено ни одной исполнительной схемы. */
  readonly missingScheme: boolean;
  /** Второй акт — о другом объекте и по другому проекту. */
  readonly foreignAct: boolean;
  /** Строка реестра приложений не нашла своего документа. */
  readonly registryRowMissing: boolean;
  /** Сертификат № 275 в комплекте есть, но выдан на другую марку. */
  readonly brandMismatch: boolean;
}

const ALL_DEFECTS: Toggles = {
  brokenOgrnLength: true,
  emptyIssuedAt: true,
  uncoveredMaterial: true,
  missingScheme: true,
  foreignAct: true,
  registryRowMissing: true,
  brandMismatch: false,
};

const NO_DEFECTS: Toggles = {
  brokenOgrnLength: false,
  emptyIssuedAt: false,
  uncoveredMaterial: false,
  missingScheme: false,
  foreignAct: false,
  registryRowMissing: false,
  brandMismatch: false,
};

/** Синтетический ОГРН из 12 цифр: класс дефекта 1 — потерянный разряд. */
const OGRN_SHORT = '102770001234';
/** Синтетический ОГРН, проходящий контрольную сумму: «здоровый» полюс дефекта 1. */
const OGRN_VALID = '1037700056789';
/** Синтетический ИНН, проходящий контрольную сумму: фон, а не предмет проверки. */
const INN_VALID = '7700123459';

const OBJECT_NAME = 'Многоквартирный жилой дом, кадастровый № 77:01:0001001:10';
const FOREIGN_OBJECT_NAME = 'Многоквартирный жилой дом, кадастровый № 77:02:0002002:20';
const CIPHER = '133/23-ГК-ПБ';
const FOREIGN_CIPHER = '02-200223-ГПЗ.1';
const MATERIAL = 'Смесь сухая шпатлевочная КНАУФ-Тифенгрунд';

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

function act(
  id: string,
  ordinal: number,
  number: string,
  patch: {
    readonly objectName: string;
    readonly cipher: string;
    readonly materials: readonly string[];
    readonly ogrn: string;
    readonly dates: readonly [start: string, end: string, act: string];
  },
): DocumentNode {
  return makeDocument({
    id,
    ordinal,
    docTypeCode: 'aosr',
    title: `АОСР № ${number}`,
    fields: [
      text('object_name', patch.objectName),
      text('act_number', number),
      date('act_date', patch.dates[2]),
      date('p5_date_start', patch.dates[0]),
      date('p5_date_end', patch.dates[1]),
      text('p1_works', 'Устройство шпатлевки стен'),
      text('p1_location', 'в осях 1-12/А-К, отм. +0.000'),
      list('p2_project_docs', [patch.cipher]),
      list('p3_materials', patch.materials),
      text('p7_next_works', 'Устройство окраски стен'),
      text('contractor_name', 'ООО «Подрядчик»'),
      text('contractor_inn', INN_VALID),
      text('contractor_ogrn', patch.ogrn),
      text('works_performed_by', 'ООО «Подрядчик»'),
      ...signerFields(),
    ],
  });
}

function corpusGraph(toggles: Toggles): CheckGraph {
  // Акт 1 перечисляет материал в п. 3; акт 2 ссылается на реестр № 1.
  const first = act('doc-act-336', 1, '336', {
    objectName: OBJECT_NAME,
    cipher: CIPHER,
    materials: [`1. ${MATERIAL} (Сертификат №275 от 10.01.2025)`],
    ogrn: toggles.brokenOgrnLength ? OGRN_SHORT : OGRN_VALID,
    dates: ['2026-02-28', '2026-03-09', '2026-03-10'],
  });
  const second = act('doc-act-337', 2, '337', {
    objectName: toggles.foreignAct ? FOREIGN_OBJECT_NAME : OBJECT_NAME,
    cipher: toggles.foreignAct ? FOREIGN_CIPHER : CIPHER,
    materials: ['Реестр 1 к АОСР № 337 от 12.03.2026'],
    ogrn: OGRN_VALID,
    dates: ['2026-03-01', '2026-03-11', '2026-03-12'],
  });

  const schemes = toggles.missingScheme
    ? []
    : [
        makeDocument({
          id: 'doc-scheme-336',
          ordinal: 3,
          docTypeCode: 'exec_scheme',
          title: 'Исполнительная схема',
          fields: [text('scheme_number', '336.1-ОТ')],
        }),
        makeDocument({
          id: 'doc-scheme-337',
          ordinal: 4,
          docTypeCode: 'exec_scheme',
          title: 'Исполнительная схема',
          fields: [text('scheme_number', '337.1-ОТ')],
        }),
      ];

  const registry = makeDocument({
    id: 'doc-registry',
    ordinal: 5,
    docTypeCode: 'annex_registry',
    title: 'Реестр № 1 к АОСР № 336 от 10.03.2026',
  });

  // Сертификат № 275: подтверждает материал п. 3 акта 336.
  const certificate = toggles.uncoveredMaterial
    ? null
    : makeDocument({
        id: 'doc-cert-275',
        ordinal: 6,
        docTypeCode: 'cert_conformity',
        title: 'Сертификат соответствия № 275',
        fields: [
          text('number', '275'),
          date('issued_at', '2025-01-10'),
          date('valid_from', '2025-01-10'),
          date('valid_to', '2027-01-10'),
          text('product_name', toggles.brandMismatch ? 'КНАУФ-Фуген' : MATERIAL),
        ],
      });

  // Техпаспорт: дефект 5 — не заполнена дата выдачи.
  const technicalPassport = makeDocument({
    id: 'doc-tp',
    ordinal: 7,
    docTypeCode: 'technical_passport',
    title: 'Технический паспорт',
    fields: toggles.emptyIssuedAt
      ? [text('number', 'ТП-12'), text('product_name', 'Смесь бетонная')]
      : [
          text('number', 'ТП-12'),
          date('issued_at', '2026-01-12'),
          text('product_name', 'Смесь бетонная'),
        ],
  });

  const annexes = [
    ...schemes,
    registry,
    ...(certificate === null ? [] : [certificate]),
    technicalPassport,
  ];

  return makeGraph({
    object: makeObject({ name: 'Многоквартирный жилой дом' }),
    documents: [first, second, ...annexes],
    // Приложения привязаны к акту 336: релевантная дата документов качества —
    // окончание работ по нему, а документ с ребром к акту реестром «лишним»
    // не объявляется.
    relations: annexes.map((document) =>
      makeRelation({ parentDocumentId: first.id, childDocumentId: document.id, relation: 'annex' }),
    ),
    registryRows: [
      makeRegistryRow({
        registryDocumentId: registry.id,
        rowNo: 1,
        docNameRaw: 'Сертификат соответствия',
        docNoRaw: '275',
        matchState: certificate === null ? 'missing' : 'matched',
        matchedDocumentId: certificate?.id ?? null,
      }),
      makeRegistryRow({
        registryDocumentId: registry.id,
        rowNo: 2,
        docNameRaw: 'Технический паспорт',
        docNoRaw: 'ТП-12',
        matchState: toggles.registryRowMissing ? 'missing' : 'matched',
        matchedDocumentId: toggles.registryRowMissing ? null : technicalPassport.id,
      }),
    ],
    today: '2026-03-15',
  });
}

// ---------------------------------------------------------------------------
// Прогон полным каталогом через движок
// ---------------------------------------------------------------------------

function run(graph: CheckGraph): RuleRunResult {
  return runRules(graph, {
    specs: RULE_CATALOG,
    snapshot: snapshotOf(RULE_CATALOG),
    enabledRuleCodes: null,
  });
}

function executionOf(result: RuleRunResult, code: string): RuleRunResult['executions'][number] {
  const execution = result.executions.find((item) => item.ruleCode === code);
  if (execution === undefined) {
    throw new Error(
      `правило ${code} не исполнялось: ${JSON.stringify(result.skipped[code] ?? 'нет в журнале')}`,
    );
  }
  return execution;
}

function findingsOf(result: RuleRunResult, code: string): PreparedFinding[] {
  return result.findings.filter((finding) => finding.ruleCode === code);
}

function failedIn(result: RuleRunResult): string[] {
  return result.executions
    .filter((execution) => execution.verdict === 'fail')
    .map((execution) => execution.ruleCode)
    .sort();
}

const defective = run(corpusGraph(ALL_DEFECTS));
const healthy = run(corpusGraph(NO_DEFECTS));

/** Коды, ловящие дефекты гейта. */
const DEFECT_RULES = [
  'AOSR.HDR.022',
  'TP.620',
  'AOSR.P3.070',
  'SCH.681',
  'XS.131',
  'REG.100',
] as const;

describe('non-degradable гейт: известные дефекты обнаруживаются минимальным набором', () => {
  it('все шесть правил ИСПОЛНЯЮТСЯ в общем прогоне', () => {
    // Без этой проверки любой из тестов ниже мог бы оказаться зелёным потому,
    // что правило не исполнялось вовсе.
    for (const code of DEFECT_RULES) {
      expect(executionOf(defective, code).ruleCode).toBe(code);
    }
    expect(Object.keys(defective.skipped)).toEqual([]);
  });

  it('ОГРН из 12 цифр вместо 13 — fail с самим значением', () => {
    expect(executionOf(defective, 'AOSR.HDR.022').verdict).toBe('fail');
    const message = findingsOf(defective, 'AOSR.HDR.022')[0]?.message ?? '';
    expect(message).toContain(OGRN_SHORT);
  });

  it('пустое поле «Дата выдачи» в техпаспорте — fail', () => {
    expect(executionOf(defective, 'TP.620').verdict).toBe('fail');
    expect(findingsOf(defective, 'TP.620')[0]?.message ?? '').toContain('Дата выдачи');
  });

  it('материал п. 3 назван с «Сертификат №275», документа нет — fail с номером и материалом', () => {
    expect(executionOf(defective, 'AOSR.P3.070').verdict).toBe('fail');
    const message = findingsOf(defective, 'AOSR.P3.070')[0]?.message ?? '';
    expect(message).toContain('275');
    expect(message).toContain(MATERIAL);
    expect(message).toContain('не подтверждён');
  });

  it('к актам не приложена исполнительная схема — fail по каждому акту', () => {
    expect(executionOf(defective, 'SCH.681').verdict).toBe('fail');
    const messages = findingsOf(defective, 'SCH.681').map((finding) => finding.message);
    expect(messages).toHaveLength(2);
    expect(messages.join(' | ')).toContain('№ 336');
    expect(messages.join(' | ')).toContain('№ 337');
  });

  it('чужой акт в папке: другой кадастровый номер и другой корень шифра — fail', () => {
    expect(executionOf(defective, 'XS.131').verdict).toBe('fail');
    const messages = findingsOf(defective, 'XS.131').map((finding) => finding.message);
    expect(messages.join(' | ')).toContain('77:01:0001001:10');
    expect(messages.join(' | ')).toContain('77:02:0002002:20');
    expect(messages.join(' | ')).toContain(FOREIGN_CIPHER);
    expect(
      findingsOf(defective, 'XS.131').every((finding) => finding.targetType === 'folder'),
    ).toBe(true);
  });

  it('строка реестра приложений без документа — fail с номером строки', () => {
    expect(executionOf(defective, 'REG.100').verdict).toBe('fail');
    const messages = findingsOf(defective, 'REG.100').map((finding) => finding.message);
    expect(messages.join(' | ')).toContain('строке 2 реестра');
    expect(messages.join(' | ')).toContain('ТП-12');
  });

  it('каждое замечание гейта несёт способ устранения', () => {
    for (const code of DEFECT_RULES) {
      for (const finding of findingsOf(defective, code)) {
        expect(finding.hint, `${code} без hint`).toBeTruthy();
      }
    }
  });
});

describe('чувствительность: исправленная папка замечаний не даёт', () => {
  it('все шесть правил исполняются и НЕ дают fail', () => {
    for (const code of DEFECT_RULES) {
      const execution = executionOf(healthy, code);
      expect(execution.verdict, `${code} на исправленной папке`).not.toBe('fail');
      expect(findingsOf(healthy, code).filter((finding) => finding.state === 'open')).toEqual([]);
    }
  });

  it('исправленная папка не даёт fail ни по одному правилу каталога', () => {
    // Фон обязан быть чистым: иначе «разница кодов» ниже доказывала бы
    // расхождение с грязным фоном, а не с исправным комплектом.
    expect(failedIn(healthy)).toEqual([]);
  });

  it('разница между папками — ровно шесть правил, а не общий фон', () => {
    // Если бы «дефектность» приходила от фикстуры целиком, здесь бы разошлось
    // намного больше кодов, и шесть тестов выше ничего бы не доказывали.
    const onlyDefective = failedIn(defective).filter((code) => !failedIn(healthy).includes(code));
    expect(onlyDefective).toEqual([...DEFECT_RULES].sort());
  });
});

describe('второй сценарий AOSR.P3.070: номер совпал, марка расходится', () => {
  const mismatched = run(corpusGraph({ ...NO_DEFECTS, brandMismatch: true }));

  it('открытое замечание с понижением до warning, без блокировки', () => {
    // Документ в комплекте есть, вопрос лишь к его предмету: снимок говорит
    // `error`, правило понижает до предупреждения, и понижение применяет
    // движок — здесь это видно по итоговой тяжести.
    expect(executionOf(mismatched, 'AOSR.P3.070').verdict).toBe('fail');
    const finding = findingsOf(mismatched, 'AOSR.P3.070')[0];
    expect(finding?.state).toBe('open');
    expect(finding?.severity).toBe('warning');
    expect(finding?.isBlocking).toBe(false);
    expect(finding?.message).toContain('марка расходится');
    expect(finding?.message).toContain('КНАУФ-Фуген');
  });

  it('единственное изменённое значение — наименование в сертификате: разница кодов ровно одна', () => {
    expect(failedIn(mismatched).filter((code) => !failedIn(healthy).includes(code))).toEqual([
      'AOSR.P3.070',
    ]);
  });
});
