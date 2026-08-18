/**
 * Non-degradable гейт S9: семь известных дефектов корпуса обнаруживаются (§1.6, §17).
 *
 * Тесты групп правил проверяют каждое правило по отдельности и на фикстуре,
 * собранной под него. Здесь другое: ОДИН комплект, воспроизводящий все семь
 * дефектов сразу, прогоняется через ДВИЖОК полным каталогом
 * (`RULE_CATALOG`) — то есть ровно тем путём, которым идёт `checks.run`.
 * Разница существенна: правило может работать в изоляции и не исполняться в
 * составе набора (нет кода в снимке, отсекла применимость, вердикт понижен
 * уверенностью). Именно этот класс отказа — «код написан, покрыт зелёными
 * тестами и не исполняется» — шесть этапов подряд был главным в проекте.
 *
 * ## Что здесь считается доказательством
 *
 * Для каждого дефекта проверяются три вещи:
 *
 * 1. код правила присутствует в журнале `executions` — правило ИСПОЛНЯЛОСЬ;
 * 2. его вердикт `fail` (или `undetermined` там, где так требует методика);
 * 3. текст замечания содержит конкретику, по которой инженер найдёт место.
 *
 * Плюс парный «здоровый» комплект: те же правила на исправленных данных дают
 * ноль замечаний. Без него тест доказывал бы только то, что правила что-то
 * возвращают.
 *
 * ## Значения реквизитов здесь СИНТЕТИЧЕСКИЕ
 *
 * Ни один ИНН, ОГРН, номер документа, ФИО или адрес в этом файле не взят из
 * корпуса: §1.4 запрещает настоящие реквизиты корпуса в коде и тестах, а
 * `docs/CORPUS_FINDINGS.md` — документ, а не источник фикстур. Регрессия
 * воспроизводит КЛАСС дефекта («ОГРН из 12 цифр вместо 13»), а не конкретное
 * значение, потому что правило проверяет разрядность и контрольную сумму, а не
 * принадлежность строки конкретному юридическому лицу. Подстановка настоящего
 * значения не усилила бы тест ничем и превратила бы файл в носитель ПДн.
 *
 * Отсюда требование к синтетике: она обязана быть арифметически корректной
 * там, где корректность проверяется. `INN_VALID` и `OGRN_VALID` проходят
 * контрольную сумму, `OGRN_SHORT` короче на разряд — иначе «здоровый» комплект
 * давал бы замечания и парный контроль ничего не доказывал бы.
 */
import { describe, expect, it } from 'vitest';

import { RULE_CATALOG } from './catalog.js';
import { runRules } from './engine.js';
import {
  makeBatch,
  makeDocument,
  makeGraph,
  makeMaterial,
  makeRelation,
  snapshotOf,
} from './testing.js';
import type { CheckGraph, FieldNode, PreparedFinding, RuleRunResult } from './types.js';

// ---------------------------------------------------------------------------
// Строительные блоки комплекта
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

function num(fieldCode: string, value: number): FieldNode {
  return { ...text(fieldCode, String(value)), valueNum: value, valueText: null };
}

function list(fieldCode: string, values: readonly string[]): FieldNode {
  return { ...text(fieldCode, values.join(', ')), valueJson: [...values] };
}

/**
 * Комплект корпуса.
 *
 * Параметры выключают дефекты по одному: `healthy()` — все семь исправлены, и
 * тогда ни одно из семи правил не имеет права дать замечание. Так фикстура
 * перестаёт быть «истинной по построению»: разница между дефектным и здоровым
 * комплектом — ровно перечисленные значения.
 */
interface Toggles {
  /** Дефект 1: ОГРН из 12 цифр в шапке акта. */
  readonly brokenOgrnLength: boolean;
  /** Дефект 2: изготовитель партии не покрыт сертификатом. */
  readonly uncoveredManufacturer: boolean;
  /** Дефект 3: год редакции НД в паспорте против сертификата. */
  readonly standardYearMismatch: boolean;
  /** Дефект 4: протокол от 06.2025 при партиях от 01.2026. */
  readonly staleProtocol: boolean;
  /** Дефект 5: пустая «Дата выдачи» в техпаспорте. */
  readonly emptyIssuedAt: boolean;
  /** Дефект 6: «2 слоя» в п. 1 против «1 слой» в приложении. */
  readonly layerMismatch: boolean;
  /** Дефект 7: только семисуточные протоколы прочности. */
  readonly missingDesignAgeProtocol: boolean;
}

const ALL_DEFECTS: Toggles = {
  brokenOgrnLength: true,
  uncoveredManufacturer: true,
  standardYearMismatch: true,
  staleProtocol: true,
  emptyIssuedAt: true,
  layerMismatch: true,
  missingDesignAgeProtocol: true,
};

const NO_DEFECTS: Toggles = {
  brokenOgrnLength: false,
  uncoveredManufacturer: false,
  standardYearMismatch: false,
  staleProtocol: false,
  emptyIssuedAt: false,
  layerMismatch: false,
  missingDesignAgeProtocol: false,
};

/** Синтетический ОГРН из 12 цифр: класс дефекта 1 — потерянный разряд. */
const OGRN_SHORT = '102770001234';
/** Синтетический ОГРН, проходящий контрольную сумму: «здоровый» полюс дефекта 1. */
const OGRN_VALID = '1037700056789';
/** Синтетический ИНН, проходящий контрольную сумму: фон, а не предмет проверки. */
const INN_VALID = '7700123459';

function corpusGraph(toggles: Toggles): CheckGraph {
  const act = makeDocument({
    id: 'doc-act',
    ordinal: 1,
    docTypeCode: 'aosr',
    title: 'АОСР № 336',
    fields: [
      text('object_name', 'Многоквартирный жилой дом'),
      text('act_number', '336'),
      date('act_date', '2026-03-10'),
      date('date_start', '2026-02-28'),
      date('date_end', '2026-03-09'),
      text(
        'work_name',
        toggles.layerMismatch
          ? 'Устройство 2 слоя гидроизоляции кровли'
          : 'Устройство 1 слой гидроизоляции кровли',
      ),
      text('p1_location', 'в осях 1-12/А-К, отм. +0.000'),
      text('rd_cipher', '2.5.1-АР изм. 1'),
      text('p3_materials', 'Гидроизоляция рулонная, арматура А500С'),
      text('p4_annexes', 'Исполнительная схема на 1 слой гидроизоляции'),
      text('p7_next_works', 'Устройство защитной стяжки'),
      text('signers', 'Представитель застройщика; представитель подрядчика'),
      text('contractor_name', 'ООО «Подрядчик»'),
      text('contractor_inn', INN_VALID),
      text('contractor_ogrn', toggles.brokenOgrnLength ? OGRN_SHORT : OGRN_VALID),
      text('works_performed_by', 'ООО «Подрядчик»'),
    ],
  });

  const scheme = makeDocument({
    id: 'doc-scheme',
    ordinal: 2,
    docTypeCode: 'exec_scheme',
    title: 'Исполнительная схема: 1 слой гидроизоляции',
    pages: [{ sourcePageId: 'page-scheme', sortOrder: 0, pageRoleCode: null }],
    fields: [text('work_name', 'Гидроизоляция, 1 слой, в осях 1-12/А-К')],
  });

  // Дефект 3: паспорт ссылается на редакцию 2015 года, сертификат покрывает 2011.
  const passport = makeDocument({
    id: 'doc-passport',
    ordinal: 3,
    docTypeCode: 'quality_passport',
    title: 'Паспорт качества',
    fields: [
      text('number', 'П-77'),
      date('issued_at', '2026-01-15'),
      text('product_name', 'Гидроизоляция рулонная наплавляемая'),
      list('gost_tu', [
        toggles.standardYearMismatch ? 'СТО 00287852-005-2015' : 'СТО 00287852-005-2011',
      ]),
    ],
  });

  const certificate = makeDocument({
    id: 'doc-cert',
    ordinal: 4,
    docTypeCode: 'cert_conformity',
    title: 'Сертификат соответствия',
    fields: [
      text('number', 'РОСС RU Д-RU.PA01.B.17254/23'),
      date('issued_at', '2025-11-01'),
      date('valid_from', '2025-11-01'),
      date('valid_to', '2027-11-01'),
      text('product_name', 'Гидроизоляция рулонная наплавляемая'),
      text('manufacturer', 'ООО «ТехноНИКОЛЬ»'),
      list('gost_tu', ['СТО 00287852-005-2011']),
    ],
  });

  // Дефект 2: сертификат на арматуру выдан другому изготовителю.
  const mill = makeDocument({
    id: 'doc-mill',
    ordinal: 5,
    docTypeCode: 'mill_certificate',
    title: 'Сертификат качества № 16005',
    fields: [
      text('number', '16005'),
      date('issued_at', '2026-01-09'),
      text('product_name', 'Арматура А500С'),
      text('manufacturer', 'ООО «ПромСорт-Тула»'),
      date('manufactured_at', '2026-01-09'),
      text('batch_no', '16005'),
    ],
  });

  const rebarCertificate = makeDocument({
    id: 'doc-rebar-cert',
    ordinal: 6,
    docTypeCode: 'cert_conformity',
    title: 'Сертификат соответствия на арматурный прокат',
    fields: [
      text('number', 'РОСС RU Д-RU.PA01.B.90001/24'),
      date('issued_at', '2025-12-01'),
      date('valid_from', '2025-12-01'),
      date('valid_to', '2027-12-01'),
      text('product_name', 'Арматура А500С'),
      text(
        'manufacturer',
        toggles.uncoveredManufacturer ? 'АО «Северсталь»' : 'ООО «ПромСорт-Тула»',
      ),
    ],
  });

  // Дефект 4: протокол испытаний старше применённых партий.
  const metalProtocol = makeDocument({
    id: 'doc-metal-protocol',
    ordinal: 7,
    docTypeCode: 'lab_protocol_metal',
    title: 'Протокол испытаний № 10353.А/06.25',
    fields: [
      text('number', '10353.А/06.25'),
      date('issued_at', toggles.staleProtocol ? '2025-06-20' : '2026-01-20'),
      date('tested_at', toggles.staleProtocol ? '2025-06-20' : '2026-01-20'),
    ],
  });

  // Дефект 5: у технического паспорта не заполнена дата выдачи.
  const technicalPassport = makeDocument({
    id: 'doc-tp',
    ordinal: 8,
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

  // Дефект 7: только семисуточные протоколы прочности бетона.
  const sevenDay = makeDocument({
    id: 'doc-lab-7',
    ordinal: 9,
    docTypeCode: 'lab_protocol_concrete',
    title: 'Протокол испытаний бетона (7 суток)',
    fields: [
      text('number', 'Б-7'),
      date('issued_at', '2026-01-20'),
      date('tested_at', '2026-01-20'),
      num('age_days', 7),
      num('strength_percent', 71.78),
    ],
  });

  const twentyEightDay = makeDocument({
    id: 'doc-lab-28',
    ordinal: 10,
    docTypeCode: 'lab_protocol_concrete',
    title: 'Протокол испытаний бетона (28 суток)',
    fields: [
      text('number', 'Б-28'),
      date('issued_at', '2026-02-10'),
      date('tested_at', '2026-02-10'),
      num('age_days', 28),
      num('strength_percent', 104),
    ],
  });

  const documents = [
    act,
    scheme,
    passport,
    certificate,
    mill,
    rebarCertificate,
    metalProtocol,
    technicalPassport,
    sevenDay,
    ...(toggles.missingDesignAgeProtocol ? [] : [twentyEightDay]),
  ];

  return makeGraph({
    documents,
    relations: documents
      .filter((document) => document.id !== act.id)
      .map((document) =>
        makeRelation({ parentDocumentId: act.id, childDocumentId: document.id, relation: 'annex' }),
      ),
    materials: [
      makeMaterial({
        id: 'mat-waterproofing',
        nameRaw: 'Гидроизоляция рулонная наплавляемая',
        nameNorm: 'ГИДРОИЗОЛЯЦИЯ РУЛОННАЯ НАПЛАВЛЯЕМАЯ',
        categoryCode: 'roll_waterproofing',
        documentIds: [passport.id, certificate.id],
      }),
      makeMaterial({
        id: 'mat-rebar',
        nameRaw: 'Арматура А500С',
        nameNorm: 'АРМАТУРА А500С',
        mark: 'А500С',
        categoryCode: 'rebar',
        batches: [
          makeBatch({
            id: 'batch-16005',
            materialId: 'mat-rebar',
            batchNo: '16005',
            manufacturedAt: '2026-01-09',
            documentIds: [mill.id],
          }),
        ],
        documentIds: [mill.id, rebarCertificate.id],
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

const defective = run(corpusGraph(ALL_DEFECTS));
const healthy = run(corpusGraph(NO_DEFECTS));

/** Коды, ловящие семь известных дефектов. Порядок — как в §0.1 плана. */
const DEFECT_RULES = [
  'AOSR.HDR.022',
  'MAT.111',
  'MAT.112',
  'DATE.372',
  'TP.620',
  'AOSR.P4.081',
  'LAB.651',
] as const;

describe('non-degradable гейт: семь известных дефектов обнаруживаются', () => {
  it('все семь правил ИСПОЛНЯЮТСЯ в общем прогоне', () => {
    // Без этой проверки любой из тестов ниже мог бы оказаться зелёным потому,
    // что правило не исполнялось вовсе.
    for (const code of DEFECT_RULES) {
      expect(executionOf(defective, code).ruleCode).toBe(code);
    }
    expect(Object.keys(defective.skipped)).toEqual([]);
  });

  it('дефект 1: ОГРН из 12 цифр вместо 13 — fail с самим значением', () => {
    expect(executionOf(defective, 'AOSR.HDR.022').verdict).toBe('fail');
    const message = findingsOf(defective, 'AOSR.HDR.022')[0]?.message ?? '';
    expect(message).toContain(OGRN_SHORT);
  });

  it('дефект 2: изготовитель ПромСорт-Тула не покрыт сертификатом', () => {
    expect(executionOf(defective, 'MAT.111').verdict).toBe('fail');
    expect(findingsOf(defective, 'MAT.111')[0]?.message ?? '').toContain('ПромСорт-Тула');
  });

  it('дефект 3: НД «СТО …-2015» в паспорте против «…-2011» в сертификате', () => {
    expect(executionOf(defective, 'MAT.112').verdict).toBe('fail');
    const message = findingsOf(defective, 'MAT.112')[0]?.message ?? '';
    expect(message).toContain('2015');
    expect(message).toContain('2011');
  });

  it('дефект 4: протокол от 06.2025 приложен к партиям от 01.2026', () => {
    expect(executionOf(defective, 'DATE.372').verdict).toBe('fail');
    const message = findingsOf(defective, 'DATE.372')[0]?.message ?? '';
    expect(message).toContain('20.06.2025');
    expect(message).toContain('09.01.2026');
  });

  it('дефект 5: пустое поле «Дата выдачи» в техпаспорте', () => {
    expect(executionOf(defective, 'TP.620').verdict).toBe('fail');
    expect(findingsOf(defective, 'TP.620')[0]?.message ?? '').toContain('Дата выдачи');
  });

  it('дефект 6: «2 слоя» в п. 1 против «1 слой» в приложении', () => {
    expect(executionOf(defective, 'AOSR.P4.081').verdict).toBe('fail');
    const message = findingsOf(defective, 'AOSR.P4.081')[0]?.message ?? '';
    expect(message).toContain('2');
    expect(message).toContain('1');
  });

  it('дефект 7: нет 28-суточных протоколов при наличии семисуточных', () => {
    expect(executionOf(defective, 'LAB.651').verdict).toBe('fail');
    const message = findingsOf(defective, 'LAB.651')[0]?.message ?? '';
    expect(message).toMatch(/28/u);
  });

  it('каждое из семи замечаний несёт способ устранения', () => {
    for (const code of DEFECT_RULES) {
      const finding = findingsOf(defective, code)[0];
      expect(finding?.hint, `${code} без hint`).toBeTruthy();
    }
  });
});

describe('чувствительность: исправленный комплект замечаний не даёт', () => {
  it('все семь правил исполняются и НЕ дают fail', () => {
    for (const code of DEFECT_RULES) {
      const execution = executionOf(healthy, code);
      expect(execution.verdict, `${code} на исправленном комплекте`).not.toBe('fail');
      expect(findingsOf(healthy, code).filter((finding) => finding.state === 'open')).toEqual([]);
    }
  });

  it('разница между комплектами — ровно семь правил, а не общий фон', () => {
    // Если бы «дефектность» приходила от фикстуры целиком, здесь бы разошлось
    // намного больше кодов, и семь тестов выше ничего бы не доказывали.
    const failedIn = (result: RuleRunResult): string[] =>
      result.executions
        .filter((execution) => execution.verdict === 'fail')
        .map((execution) => execution.ruleCode)
        .sort();

    const onlyDefective = failedIn(defective).filter((code) => !failedIn(healthy).includes(code));
    expect(onlyDefective).toEqual([...DEFECT_RULES].sort());
  });
});

describe('методика: семисуточный протокол не объявляется браком', () => {
  it('LAB.650 на 71,78 % в возрасте 7 суток не даёт ни error, ни fail', () => {
    // §9.4: ошибкой было бы и пропустить отсутствие 28-суточных (это LAB.651),
    // и объявить браком семисуточные.
    expect(executionOf(defective, 'LAB.650').verdict).not.toBe('fail');
    for (const finding of findingsOf(defective, 'LAB.650')) {
      expect(finding.severity).not.toBe('error');
      expect(finding.isBlocking).toBe(false);
    }
  });
});

describe('внешние реестры не дают юридических выводов (§9.5)', () => {
  it('в MVP каждая внешняя проверка — external_unavailable и не блокирует', () => {
    const external = defective.findings.filter(
      (finding) => finding.origin === 'external_unavailable',
    );
    expect(external.length).toBeGreaterThan(0);
    for (const finding of external) {
      expect(finding.state).toBe('undetermined');
      expect(finding.isBlocking).toBe(false);
      expect(finding.message).toContain('требуется ручная проверка');
    }
  });
});
