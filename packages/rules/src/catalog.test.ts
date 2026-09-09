/**
 * Состав каталога правил после S59 (ADR-0029): минимальный набор.
 *
 * Каталог собирается из партий сида, а снятие правила — это поле `retired` у
 * партии, а не удаление спека. Такое устройство держится на трёх инвариантах,
 * и каждый здесь выписан явно:
 *
 * 1. действующий каталог — РОВНО перечисленные коды. Список набран буквально,
 *    а не вычислен: мутация «вернуть код, убрав его из `retired`» обязана
 *    покраснеть именно здесь, а вычисленный список вернулся бы вместе с ней;
 * 2. снятое правило снято целиком: его нет в каталоге, оно есть среди
 *    снятых, у него нет живого тела;
 * 3. встроенный набор, который активирует поставка, — ровно действующий
 *    каталог: строка `is_enabled = true` у правила, которого движок не
 *    исполняет, была бы ложью о том, что проверял прогон.
 */
import { describe, expect, it } from 'vitest';

import {
  RETIRED_RULES,
  RULE_CATALOG,
  RULE_CATALOG_WITH_RETIRED,
  RULE_CODES,
  RULE_SEED_BATCHES,
  duplicateRuleCodes,
  unknownRetiredCodes,
} from './catalog.js';
import { BUILTIN_RULESETS } from './seed.js';
import { makeGraph } from './testing.js';
import type { RuleSeedBatch } from './catalog.js';

/** Минимальный набор (S59): 33 прежних правила плюс SCH.681 и XS.131. */
const ACTIVE_CODES = [
  'AOSR.ACT.031',
  'AOSR.HDR.010',
  'AOSR.HDR.020',
  'AOSR.HDR.021',
  'AOSR.HDR.022',
  'AOSR.HDR.023',
  'AOSR.P1.050',
  'AOSR.P3.070',
  'AOSR.P3.071',
  'AOSR.P4.080',
  'AOSR.SGN.040',
  'AOSR.SGN.041',
  'AOSR.SGN.042',
  'CERT.600',
  'DATE.300',
  'DATE.302',
  'DATE.303',
  'DATE.310',
  'DATE.312',
  'DECL.601',
  'LLM.FILL.010',
  'LLM.FILL.020',
  'LLM.FILL.030',
  'LLM.FILL.040',
  'PASS.611',
  'REFUS.670',
  'REG.100',
  'REG.101',
  'REG.102',
  'REG.110',
  'REG.111',
  'REG.112',
  'SCH.681',
  'TP.620',
  'XS.131',
] as const;

/** Снятые: 35 по ADR-0029 плюс AOSR.ACT.032 (S30). */
const RETIRED_CODES = [
  'AOSR.ACT.030',
  'AOSR.ACT.032',
  'AOSR.P2.060',
  'AOSR.P2.061',
  'AOSR.P4.081',
  'AOSR.P7.090',
  'CONCL.660',
  'DATE.304',
  'DATE.311',
  'DATE.320',
  'DATE.330',
  'DATE.331',
  'DATE.332',
  'DATE.372',
  'EXT.NRS.141',
  'EXT.SCHED.142',
  'EXT.SRO.140',
  'LAB.650',
  'LAB.651',
  'MAT.110',
  'MAT.111',
  'MAT.112',
  'MILL.630',
  'MIX.640',
  'PASS.610',
  'REF.120',
  'REF.121',
  'REG.113',
  'REG.114',
  'REG.115',
  'REG.116',
  'REG.117',
  'SCH.680',
  'SIG.PDF.371',
  'SIG.STAMP.370',
  'XS.130',
] as const;

const sorted = (codes: readonly string[]): string[] => [...codes].sort();

describe('действующий каталог', () => {
  it('содержит ровно 35 кодов минимального набора', () => {
    expect(ACTIVE_CODES).toHaveLength(35);
    expect(sorted(RULE_CODES)).toEqual(sorted(ACTIVE_CODES));
  });

  it('каждый код `retired` назван в своей партии', () => {
    expect(unknownRetiredCodes()).toEqual([]);
  });

  it('unknownRetiredCodes ловит код, которого в партии нет', () => {
    // Чувствительность: такой код ничего не снимает, а запись выглядит как
    // сделанное решение.
    const batch: RuleSeedBatch = {
      migration: '9999_test',
      rules: RULE_SEED_BATCHES[0]?.rules ?? [],
      retired: ['AOSR.HDR.010', 'X.1'],
    };
    expect(unknownRetiredCodes([batch])).toEqual(['X.1']);
  });

  it('действующие и снятые не пересекаются', () => {
    const active = new Set(RULE_CODES);
    expect(RETIRED_RULES.filter((spec) => active.has(spec.code)).map((s) => s.code)).toEqual([]);
  });

  it('дублей кодов нет ни в каталоге, ни в каталоге со снятыми', () => {
    expect(duplicateRuleCodes(RULE_CATALOG)).toEqual([]);
    expect(duplicateRuleCodes(RULE_CATALOG_WITH_RETIRED)).toEqual([]);
  });

  it('каталог со снятыми — это действующие плюс снятые, без остатка', () => {
    // Собирается из партий целиком, а не сложением: код, снятый внутри
    // партии, попал бы в сумму дважды — здесь это видно по дублям выше.
    expect(RULE_CATALOG_WITH_RETIRED).toHaveLength(RULE_CATALOG.length + RETIRED_RULES.length);
    expect(sorted(RULE_CATALOG_WITH_RETIRED.map((spec) => spec.code))).toEqual(
      sorted([...RULE_CODES, ...RETIRED_RULES.map((spec) => spec.code)]),
    );
  });
});

describe('снятые правила', () => {
  it('их ровно 36, и список назван буквально', () => {
    expect(RETIRED_CODES).toHaveLength(36);
    expect(sorted(RETIRED_RULES.map((spec) => spec.code))).toEqual(sorted(RETIRED_CODES));
  });

  it('у каждого снятого правила заглушка вместо тела: n_a «правило снято с исполнения»', () => {
    for (const spec of RETIRED_RULES) {
      const result = spec.evaluate(makeGraph(), spec.defaultParams);
      expect(result.verdict, spec.code).toBe('n_a');
      expect(result.reason, spec.code).toBe('правило снято с исполнения');
    }
  });

  it('снятое правило не требует ни профиля раздела, ни внешнего реестра', () => {
    // Оба поля в сид не попадают, а требовать что-либо тому, что не
    // исполняется, незачем: отчёт прогона перечислял бы проверки, которых нет.
    for (const spec of RETIRED_RULES) {
      expect(spec.requiresSectionProfile, spec.code).toBe(false);
      expect(spec.requiresExternalRegistry, spec.code).toBeNull();
    }
  });
});

describe('встроенные наборы', () => {
  it('последний набор (builtin-6) — ровно действующий каталог', () => {
    const last = BUILTIN_RULESETS.at(-1);
    expect(last?.version).toBe('builtin-6');
    expect(last?.seedsDefinitions).toBe(true);
    expect(sorted((last?.specs ?? []).map((spec) => spec.code))).toEqual(sorted(RULE_CODES));
  });

  it('предыдущие наборы зафиксированы по своим миграциям и снятых не потеряли', () => {
    // builtin-5 печатался как «весь каталог» до S59 и обязан остаться
    // байт в байт: в нём есть и снятые с тех пор коды.
    const previous = BUILTIN_RULESETS.find((ruleset) => ruleset.version === 'builtin-5');
    const codes = new Set((previous?.specs ?? []).map((spec) => spec.code));
    expect(codes.has('MAT.110')).toBe(true);
    expect(codes.has('SCH.681')).toBe(false);
  });
});
