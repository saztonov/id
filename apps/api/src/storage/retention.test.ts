/**
 * Решение о хранении: срок и удержание (§4.2).
 *
 * Функция одна и чистая, поэтому проверяется именно она, а не «система как-то
 * не удаляет». Смысл набора — зафиксировать, что разрешение на удаление можно
 * получить ровно одним способом: решение по ревизии принято, срок вышел,
 * действующих удержаний нет. Любой другой путь обязан давать «нельзя» с
 * названной причиной.
 */
import { describe, expect, it } from 'vitest';

import { decideRetention, type RetentionPolicy } from './retention.js';

const POLICY: RetentionPolicy = { retentionDays: 30, legalHoldEnabled: true };
const NOW = new Date('2026-08-18T00:00:00.000Z');

const LONG_AGO = '2026-01-01T00:00:00.000Z';
const YESTERDAY = '2026-08-17T00:00:00.000Z';

describe('решение о хранении', () => {
  it('разрешает удаление только при вышедшем сроке и отсутствии удержаний', () => {
    const decision = decideRetention(
      { status: 'approved', decidedAt: LONG_AGO, activeHolds: 0 },
      POLICY,
      NOW,
    );
    expect(decision.deletable).toBe(true);
    expect(decision.blocks).toEqual([]);
    expect(decision.retainedUntil).toBe('2026-01-31T00:00:00.000Z');
  });

  it('не разрешает, пока срок не вышел', () => {
    const decision = decideRetention(
      { status: 'approved', decidedAt: YESTERDAY, activeHolds: 0 },
      POLICY,
      NOW,
    );
    expect(decision.deletable).toBe(false);
    expect(decision.blocks).toContain('retention_not_expired');
  });

  it('не разрешает при действующем удержании даже после срока', () => {
    const decision = decideRetention(
      { status: 'approved', decidedAt: LONG_AGO, activeHolds: 1 },
      POLICY,
      NOW,
    );
    expect(decision.deletable).toBe(false);
    expect(decision.blocks).toEqual(['legal_hold']);
    expect(decision.legalHoldOverridden).toBe(false);
  });

  it('выключенная поддержка удержаний видна отдельным полем, а не тишиной', () => {
    const decision = decideRetention(
      { status: 'approved', decidedAt: LONG_AGO, activeHolds: 2 },
      { retentionDays: 30, legalHoldEnabled: false },
      NOW,
    );
    // Удаление разрешено, но факт «удержание было и его проигнорировали»
    // обязан остаться видимым: это то, о чём спросят до, а не после удаления.
    expect(decision.deletable).toBe(true);
    expect(decision.legalHoldOverridden).toBe(true);
  });

  it('ревизия без решения не удаляется ни при каком сроке', () => {
    for (const status of ['draft', 'submitted', 'in_review']) {
      const decision = decideRetention(
        { status, decidedAt: LONG_AGO, activeHolds: 0 },
        POLICY,
        NOW,
      );
      expect(decision.deletable).toBe(false);
      expect(decision.blocks).toContain('decision_pending');
      expect(decision.retainedUntil).toBeNull();
    }
  });

  it('терминальный статус без даты решения — тоже «нельзя»', () => {
    const decision = decideRetention(
      { status: 'approved', decidedAt: null, activeHolds: 0 },
      POLICY,
      NOW,
    );
    expect(decision.blocks).toContain('decision_pending');
  });

  it('непригодная дата решения не превращается в разрешение', () => {
    // Прямая ловушка: `NaN` в сравнении даёт false, то есть наивная реализация
    // сочла бы срок вышедшим и разрешила удаление.
    const decision = decideRetention(
      { status: 'approved', decidedAt: 'не дата', activeHolds: 0 },
      POLICY,
      NOW,
    );
    expect(decision.deletable).toBe(false);
    expect(decision.blocks).toContain('invalid_decision_date');
  });

  it('срок считается от даты решения, а не от «сейчас»', () => {
    const long = decideRetention(
      { status: 'returned', decidedAt: '2026-08-01T00:00:00.000Z', activeHolds: 0 },
      { retentionDays: 3650, legalHoldEnabled: true },
      NOW,
    );
    expect(long.retainedUntil).toBe('2036-07-29T00:00:00.000Z');
    expect(long.deletable).toBe(false);
  });
});
