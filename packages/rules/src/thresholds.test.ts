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
  const params = { maxAgeDays: 3650 } as const;

  it('число в профиле побеждает значение снимка', () => {
    const profile = makeProfile({ thresholds: { maxAgeDays: 30 } });
    expect(threshold(profile, params, 'maxAgeDays', 1)).toBe(30);
  });

  it('профиль молчит — берётся значение снимка, а не константа кода', () => {
    const profile = makeProfile({ thresholds: {} });
    expect(threshold(profile, params, 'maxAgeDays', 1)).toBe(3650);
  });

  it('нечисловое или неконечное значение профиля игнорируется', () => {
    // `thresholds` — свободный jsonb: строка, null и NaN обязаны откатывать к
    // снимку, а не превращать сравнение в вечно-ложное.
    for (const bad of ['три года', null, Number.NaN, [], {}]) {
      const profile = makeProfile({ thresholds: { maxAgeDays: bad } });
      expect(threshold(profile, params, 'maxAgeDays', 1)).toBe(3650);
    }
  });

  it('ключа нет ни в профиле, ни в снимке — последний рубеж fallback', () => {
    // Так ведёт себя снимок, опубликованный ДО появления параметра: правило
    // обязано работать, а не делить на undefined.
    const profile = makeProfile({ thresholds: {} });
    expect(threshold(profile, {}, 'graceDays', 7)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Порог доживает до вердикта через движок
// ---------------------------------------------------------------------------

/** Акт с работами, оконченными 09.03.2026, и приложенный к нему сертификат. */
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
    fields: [makeField({ fieldCode: 'issued_at', valueDate: '2025-01-01' })],
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
  it('без порога в профиле DATE.311 проходит по значению снимка', () => {
    // Положительный контроль: 432 дн. при пороге снимка 3650 — это pass.
    expect(executionOf(graphWith({}), 'DATE.311').verdict).toBe('pass');
  });

  it('порог из профиля превращает тот же комплект в fail', () => {
    const execution = executionOf(graphWith({ maxAgeDays: 10 }), 'DATE.311');
    expect(execution.verdict).toBe('fail');
    expect(execution.findingCount).toBe(1);
  });

  it('чужой ключ в профиле на DATE.311 не влияет', () => {
    // Ключ `thresholds` — это имя параметра правила; посторонний ключ не имеет
    // права ни сработать, ни уронить прогон.
    expect(executionOf(graphWith({ designAgeDays: 7 }), 'DATE.311').verdict).toBe('pass');
  });
});
