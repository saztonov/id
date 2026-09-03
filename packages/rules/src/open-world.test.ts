/**
 * Non-degradable гейт S9: отсутствие ложных ошибок на незнакомом разделе
 * (§0.5, §9.1, §16, §17).
 *
 * Корпус покрывает два раздела работ из многих. Поэтому система обязана
 * отвечать «эта проверка сюда не относится», а не «комплект неполон», когда
 * видит документ незнакомого вида или раздел без опубликованного профиля.
 * Одна ложная ошибка на новом разделе разрушает доверие к порталу быстрее, чем
 * один пропуск: инженер перестаёт читать список замечаний целиком.
 *
 * Проверяется полным каталогом через движок — тем же путём, которым идёт
 * `checks.run`. Отдельный тест на каждое правило этого не показал бы:
 * применимость решается движком, и вопрос «даёт ли НАБОР ложную ошибку»
 * отвечается только прогоном набора.
 */
import { describe, expect, it } from 'vitest';

import { RULE_CATALOG } from './catalog.js';
import { runRules } from './engine.js';
import {
  makeDocument,
  makeGraph,
  makeProfile,
  makeRelation,
  makeUnconfiguredProfile,
  snapshotOf,
} from './testing.js';
import type { CheckGraph, FieldNode, RuleRunResult } from './types.js';

function text(fieldCode: string, value: string): FieldNode {
  return {
    id: `f-${fieldCode}`,
    fieldCode,
    valueText: value,
    valueDate: null,
    valueNum: null,
    valueJson: null,
    confidence: 0.92,
    isVerified: false,
    extractedBy: 'rule',
    pageTextVersionId: 'ptv-1',
    charSpan: { start: 0, end: value.length },
    quote: value,
    sourcePageId: 'page-1',
    blockType: 'text',
    blockId: 'block-1',
  };
}

function date(fieldCode: string, value: string): FieldNode {
  return { ...text(fieldCode, value), valueDate: value, valueText: null };
}

/**
 * Комплект незнакомого раздела.
 *
 * Синтетическая фикстура §1.4 — «АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ»,
 * которого в каталоге нет намеренно. Документы получают резервный тип, базовые
 * реквизиты у них извлечены (§8.4: двухуровневое извлечение работает и на
 * неизвестном типе), профиль раздела не опубликован.
 */
function unknownSectionGraph(): CheckGraph {
  const act = makeDocument({
    id: 'doc-unknown-act',
    ordinal: 1,
    docTypeCode: 'unknown_document',
    isKnownType: false,
    isFallbackType: true,
    title: 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ',
    needsReview: true,
    fields: [
      text('number', 'ГИ-14'),
      date('issued_at', '2026-02-11'),
      text('issuer', 'ООО «Монтаж»'),
      text('product_name', 'Трубопровод отопления Ду50'),
    ],
  });

  const passport = makeDocument({
    id: 'doc-unknown-passport',
    ordinal: 2,
    docTypeCode: 'other_quality_docs',
    isKnownType: false,
    isFallbackType: true,
    title: 'ПАСПОРТ НА ЗАПОРНУЮ АРМАТУРУ',
    needsReview: true,
    fields: [
      text('number', 'ЗА-901'),
      date('issued_at', '2026-01-20'),
      text('product_name', 'Кран шаровой Ду50'),
      text('manufacturer', 'ООО «Арматура»'),
    ],
  });

  const uncertain = makeDocument({
    id: 'doc-uncertain',
    ordinal: 3,
    // Тип предложен, но уверенности нет: это ВТОРОЙ вид «не знаю» (§8.2), и он
    // тоже не имеет права порождать ошибку.
    docTypeCode: 'quality_passport',
    isKnownType: false,
    isFallbackType: false,
    typeConfidence: 0.55,
    needsReview: true,
    title: 'Паспорт (тип определён неуверенно)',
    fields: [text('number', 'X-1')],
  });

  const documents = [act, passport, uncertain];

  return makeGraph({
    documents,
    relations: [
      makeRelation({ parentDocumentId: act.id, childDocumentId: passport.id, relation: 'annex' }),
      makeRelation({ parentDocumentId: act.id, childDocumentId: uncertain.id, relation: 'annex' }),
    ],
    // Профиль раздела не опубликован: раздел новый, настройки для него ещё
    // нет (§9.1, строка 2).
    profile: makeUnconfiguredProfile(),
    folder: {
      id: 'rev-unknown',
      objectId: 'obj-1',
      contractorId: 'cp-1',
      sectionCode: 'external_mechanical_systems',
      folderTitle: 'Наружные сети водоснабжения',
    },
    today: '2026-03-01',
  });
}

function run(graph: CheckGraph): RuleRunResult {
  return runRules(graph, {
    specs: RULE_CATALOG,
    snapshot: snapshotOf(RULE_CATALOG),
    enabledRuleCodes: null,
  });
}

const noProfile = run(unknownSectionGraph());

describe('незнакомый раздел без опубликованного профиля', () => {
  it('комплект обрабатывается до конца: исполняются ВСЕ правила каталога', () => {
    // «Не выдал ошибок» ничего не значит, если правила просто не запускались.
    expect(noProfile.executions).toHaveLength(RULE_CATALOG.length);
    expect(Object.keys(noProfile.skipped)).toEqual([]);
  });

  it('ни одно правило не даёт fail', () => {
    const failed = noProfile.executions
      .filter((execution) => execution.verdict === 'fail')
      .map((execution) => execution.ruleCode);

    expect(failed).toEqual([]);
  });

  it('ни одного открытого замечания и ни одного блокирующего', () => {
    expect(noProfile.findings.filter((finding) => finding.state === 'open')).toEqual([]);
    expect(noProfile.counts.blocking).toBe(0);
  });

  it('правила полноты комплекта дают n_a с пометкой о ненастроенном профиле', () => {
    const profileBound = RULE_CATALOG.filter((spec) => spec.requiresSectionProfile);
    expect(profileBound.length).toBeGreaterThan(0);

    for (const spec of profileBound) {
      const execution = noProfile.executions.find((item) => item.ruleCode === spec.code);
      expect(execution?.verdict, spec.code).toBe('n_a');
      expect(execution?.reason ?? '', spec.code).toContain('профиль раздела не настроен');
    }
  });

  it('типо-специфичные правила молчат: n_a либо «не проверено», но не ошибка', () => {
    const typed = RULE_CATALOG.filter((spec) => spec.docTypeCode !== null);
    expect(typed.length).toBeGreaterThan(0);

    for (const spec of typed) {
      const execution = noProfile.executions.find((item) => item.ruleCode === spec.code);
      // С S50 ответов два, и они означают разное: вида в комплекте нет вовсе
      // (`n_a`) либо документ вида есть, но его вид не подтверждён
      // (`undetermined`). Оба — молчание, ни один — не обвинение комплекта.
      expect([...['n_a', 'undetermined']], spec.code).toContain(execution?.verdict);
    }
  });

  it('вид, который есть, но не подтверждён, даёт «не проверено» (S50)', () => {
    // В графе лежит паспорт с уверенностью 0.55: документ есть, вид не
    // подтверждён. Прежде правила по паспортам отвечали «неприменимо» — то
    // есть комплект выглядел так, будто паспортов в нём нет вовсе.
    const passportRules = RULE_CATALOG.filter((spec) => spec.docTypeCode === 'quality_passport');
    expect(passportRules.length).toBeGreaterThan(0);

    for (const spec of passportRules) {
      const execution = noProfile.executions.find((item) => item.ruleCode === spec.code);
      if (execution?.verdict === 'n_a') continue;
      expect(execution?.verdict, spec.code).toBe('undetermined');
      expect(execution?.reason ?? '', spec.code).toContain('не подтверждён');
    }
  });

  it('неопределённость выражена честно: n_a и undetermined, а не «замечаний нет»', () => {
    // Обратная сторона гейта: комплект, по которому система ничего не может
    // сказать, обязан выглядеть как «не проверено», а не как «проверено и
    // чисто». Иначе открытый мир превращается в тихое одобрение.
    expect(noProfile.counts.notApplicable).toBeGreaterThan(0);
    expect(noProfile.counts.undetermined + noProfile.counts.notApplicable).toBeGreaterThan(
      noProfile.counts.passed,
    );
  });
});

describe('чувствительность гейта открытого мира', () => {
  it('тот же комплект со ЗНАКОМЫМИ типами даёт замечания', () => {
    // Доказывает, что ноль ошибок выше — следствие открытого мира, а не того,
    // что фикстура беззубая: достаточно объявить типы известными, и правила
    // начинают находить дефекты в тех же данных.
    const graph = unknownSectionGraph();
    const known = makeGraph({
      ...graph,
      documents: graph.documents.map((document) => ({
        ...document,
        docTypeCode: document.id === 'doc-uncertain' ? 'quality_passport' : 'aosr',
        isKnownType: true,
        isFallbackType: false,
        needsReview: false,
        typeConfidence: 0.95,
      })),
      profile: makeProfile(),
    });

    const result = run(known);
    const failed = result.executions
      .filter((execution) => execution.verdict === 'fail')
      .map((execution) => execution.ruleCode);

    expect(failed.length).toBeGreaterThan(0);
  });
});
