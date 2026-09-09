/**
 * Пороги профиля раздела доходят до правил (§9.2, §3.2, §3.7).
 *
 * До S9 `thresholds` профиля загружались в граф (`loadCheckGraph`) и не
 * читались НИ ОДНИМ правилом: `threshold()` не вызывалась нигде. Настройка
 * принималась и молча игнорировалась — худший из возможных исходов, потому что
 * администратор видит сохранённое значение и считает его действующим.
 *
 * Здесь проверяются две вещи, которых не проверяет тест группы дат:
 *
 * 1. приоритет самой функции `threshold()` во всех четырёх случаях —
 *    число в профиле, молчание профиля, мусор в профиле, отсутствие ключа
 *    и в снимке;
 * 2. что порог доживает до вердикта, пройдя через ДВИЖОК полным каталогом, а
 *    не только через прямой вызов `spec.evaluate`. Разница та же, из-за которой
 *    существует `known-defects.test.ts`: правило может работать в изоляции и не
 *    исполниться в составе набора.
 *
 * Прогон полным каталогом до S59 держался на `DATE.311` (`maxAgeDays`). Правило
 * снято, и его место занял `DATE.300` с порогом `expiryWarningDays` (S59):
 * у него параметра в снимке нет вовсе — только умолчание в коде, — и это
 * отдельный случай приоритета, который здесь и проверяется.
 */
import { describe, expect, it } from 'vitest';

import { RULE_CATALOG } from './catalog.js';
import { runRules } from './engine.js';
import { threshold } from './helpers.js';
import {
  makeDocument,
  makeField,
  makeGraph,
  makeProfile,
  makeRelation,
  snapshotOf,
} from './testing.js';
import type { CheckGraph, RuleExecution } from './types.js';

// ---------------------------------------------------------------------------
// Приоритет источников
// ---------------------------------------------------------------------------

describe('threshold(): профиль раздела поверх снимка набора правил', () => {
  const params = { maxDocumentsWithoutRegistry: 5 } as const;

  it('число в профиле побеждает значение снимка', () => {
    const profile = makeProfile({ thresholds: { maxDocumentsWithoutRegistry: 2 } });
    expect(threshold(profile, params, 'maxDocumentsWithoutRegistry', 1)).toBe(2);
  });

  it('профиль молчит — берётся значение снимка, а не константа кода', () => {
    const profile = makeProfile({ thresholds: {} });
    expect(threshold(profile, params, 'maxDocumentsWithoutRegistry', 1)).toBe(5);
  });

  it('нечисловое или неконечное значение профиля игнорируется', () => {
    // `thresholds` — свободный jsonb: строка, null и NaN обязаны откатывать к
    // снимку, а не превращать сравнение в вечно-ложное.
    for (const bad of ['пять', null, Number.NaN, [], {}]) {
      const profile = makeProfile({ thresholds: { maxDocumentsWithoutRegistry: bad } });
      expect(threshold(profile, params, 'maxDocumentsWithoutRegistry', 1)).toBe(5);
    }
  });

  it('ключа нет ни в профиле, ни в снимке — последний рубеж fallback', () => {
    // Так ведёт себя снимок, опубликованный ДО появления параметра: правило
    // обязано работать, а не делить на undefined. Ровно так живёт
    // `expiryWarningDays`: в снимках 0044…0083 его нет.
    const profile = makeProfile({ thresholds: {} });
    expect(threshold(profile, {}, 'expiryWarningDays', 30)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Порог доживает до вердикта через движок
// ---------------------------------------------------------------------------

/**
 * Акт с работами, оконченными 09.03.2026, и приложенный к нему сертификат,
 * действующий до 19.03.2026: на релевантную дату документ действует, запас —
 * 10 дней.
 */
function graphWith(thresholds: Readonly<Record<string, unknown>>): CheckGraph {
  const act = makeDocument({
    id: 'act-1',
    docTypeCode: 'aosr',
    fields: [
      makeField({ fieldCode: 'date_start', valueDate: '2026-02-28' }),
      makeField({ fieldCode: 'date_end', valueDate: '2026-03-09' }),
      makeField({ fieldCode: 'act_date', valueDate: '2026-03-09' }),
    ],
  });
  const certificate = makeDocument({
    id: 'cert-1',
    docTypeCode: 'cert_conformity',
    fields: [
      makeField({ fieldCode: 'valid_from', valueDate: '2025-01-01' }),
      makeField({ fieldCode: 'valid_to', valueDate: '2026-03-19' }),
    ],
  });
  return makeGraph({
    documents: [act, certificate],
    relations: [makeRelation({ parentDocumentId: act.id, childDocumentId: certificate.id })],
    profile: makeProfile({ thresholds }),
  });
}

function executionOf(graph: CheckGraph, code: string): RuleExecution {
  const result = runRules(graph, {
    specs: RULE_CATALOG,
    snapshot: snapshotOf(RULE_CATALOG),
    enabledRuleCodes: null,
  });
  const execution = result.executions.find((item) => item.ruleCode === code);
  if (execution === undefined) {
    throw new Error(`правило ${code} не исполнялось: ${JSON.stringify(result.skipped[code])}`);
  }
  return execution;
}

describe('порог профиля меняет вердикт в прогоне полным каталогом', () => {
  it('без порога в профиле DATE.300 предупреждает по умолчанию кода', () => {
    // Положительный контроль: 10 дн. запаса при умолчании 30 — предупреждение
    // (открытое замечание, вердикт `fail` с тяжестью warning).
    const execution = executionOf(graphWith({}), 'DATE.300');
    expect(execution.verdict).toBe('fail');
    expect(execution.findingCount).toBe(1);
  });

  it('порог из профиля превращает тот же комплект в pass', () => {
    expect(executionOf(graphWith({ expiryWarningDays: 5 }), 'DATE.300').verdict).toBe('pass');
  });

  it('чужой ключ в профиле на DATE.300 не влияет', () => {
    // Ключ `thresholds` — это имя параметра правила; посторонний ключ не имеет
    // права ни сработать, ни уронить прогон.
    expect(executionOf(graphWith({ maxDocumentsWithoutRegistry: 1 }), 'DATE.300').verdict).toBe(
      'fail',
    );
  });
});
