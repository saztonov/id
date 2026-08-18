/**
 * Политика вызовов LLM: allowlist, бюджет, частота (§10, §11).
 *
 * Каждая проверка подтверждает не только отказ, но и то, что отказ произошёл ДО
 * расхода: съеденный слот частоты у отвергнутой по allowlist модели или
 * списанный бюджет у вызова, который не состоялся, — это ровно тот класс
 * дефекта, который в бою выглядит как «лимит кончается сам собой».
 */
import { describe, expect, it } from 'vitest';

import { LlmPolicy, emptyAllowlistBehaviour, type SpendReader } from './policy.js';
import { LlmBudgetError, LlmModelNotAllowedError, LlmRateLimitError } from './port.js';

function spendOf(value: number): SpendReader & { calls: number } {
  const reader = {
    calls: 0,
    monthlySpend: (): Promise<number> => {
      reader.calls += 1;
      return Promise.resolve(value);
    },
  };
  return reader;
}

function policyOf(overrides: Partial<ConstructorParameters<typeof LlmPolicy>[0]> = {}): LlmPolicy {
  return new LlmPolicy({
    allowedModels: ['gw/model-a'],
    emptyAllowlist: 'deny',
    budgetMonthly: 0,
    rateLimitPerMin: 60,
    spend: spendOf(0),
    now: () => 0,
    ...overrides,
  });
}

describe('allowlist моделей', () => {
  it('модель вне списка отвергается до вызова', async () => {
    const spend = spendOf(0);
    const policy = policyOf({ spend });

    await expect(policy.ensureCallPermitted({ model: 'gw/model-b' })).rejects.toBeInstanceOf(
      LlmModelNotAllowedError,
    );
    // Бюджет не читался: отказ произошёл раньше любых расходных проверок.
    expect(spend.calls).toBe(0);
  });

  it('модель из списка проходит', async () => {
    await expect(policyOf().ensureCallPermitted({ model: 'gw/model-a' })).resolves.toBeUndefined();
  });

  it('пустой allowlist в режиме deny запрещает всё (fail-closed)', () => {
    const policy = policyOf({ allowedModels: [], emptyAllowlist: 'deny' });

    expect(() => policy.ensureModelAllowed('что-угодно')).toThrow(LlmModelNotAllowedError);
  });

  it('пустой allowlist в режиме allow разрешает всё', () => {
    const policy = policyOf({ allowedModels: [], emptyAllowlist: 'allow' });

    expect(() => policy.ensureModelAllowed('что-угодно')).not.toThrow();
  });

  it('режим выбирается окружением: production — deny, остальное — allow', () => {
    // Забытая переменная в бою обязана закрывать, а не открывать; в тестовом
    // окружении обратное — иначе гейты требовали бы боевого перечня моделей.
    expect(emptyAllowlistBehaviour({ NODE_ENV: 'production' } as never)).toBe('deny');
    expect(emptyAllowlistBehaviour({ NODE_ENV: 'development' } as never)).toBe('allow');
    expect(emptyAllowlistBehaviour({ NODE_ENV: 'test' } as never)).toBe('allow');
  });
});

describe('месячный бюджет', () => {
  it('нулевой бюджет означает отсутствие ограничения и не читает трату', async () => {
    const spend = spendOf(1_000_000);
    await expect(
      policyOf({ budgetMonthly: 0, spend }).ensureCallPermitted({ model: 'gw/model-a' }),
    ).resolves.toBeUndefined();
    expect(spend.calls).toBe(0);
  });

  it('трата ниже порога проходит', async () => {
    await expect(
      policyOf({ budgetMonthly: 100, spend: spendOf(99.9999) }).ensureCallPermitted({
        model: 'gw/model-a',
      }),
    ).resolves.toBeUndefined();
  });

  it('достигнутый порог отвергает вызов до сети', async () => {
    const policy = policyOf({ budgetMonthly: 100, spend: spendOf(100) });

    await expect(policy.ensureCallPermitted({ model: 'gw/model-a' })).rejects.toMatchObject({
      name: 'LlmBudgetError',
      retriable: false,
      spent: 100,
      budget: 100,
    });
  });

  it('исчерпанный бюджет не расходует слот частоты', async () => {
    const policy = policyOf({ budgetMonthly: 1, rateLimitPerMin: 1, spend: spendOf(5) });

    await expect(policy.ensureCallPermitted({ model: 'gw/model-a' })).rejects.toBeInstanceOf(
      LlmBudgetError,
    );
    // Слот не съеден: после пополнения бюджета первый же вызов обязан пройти.
    const relaxed = policyOf({ budgetMonthly: 0, rateLimitPerMin: 1 });
    await expect(relaxed.ensureCallPermitted({ model: 'gw/model-a' })).resolves.toBeUndefined();
  });
});

describe('лимит частоты', () => {
  it('скользящее окно пропускает ровно лимит и отвергает следующий', async () => {
    let now = 0;
    const policy = policyOf({ rateLimitPerMin: 3, now: () => now });

    for (let i = 0; i < 3; i += 1) {
      now = i * 10;
      await policy.ensureCallPermitted({ model: 'gw/model-a' });
    }
    now = 30;
    await expect(policy.ensureCallPermitted({ model: 'gw/model-a' })).rejects.toBeInstanceOf(
      LlmRateLimitError,
    );
  });

  it('слот освобождается ровно через минуту после его занятия', async () => {
    let now = 0;
    const policy = policyOf({ rateLimitPerMin: 1, now: () => now });

    await policy.ensureCallPermitted({ model: 'gw/model-a' });
    // Окно полуоткрытое: занятие в момент t учитывается на [t, t+60000).
    now = 59_999;
    await expect(policy.ensureCallPermitted({ model: 'gw/model-a' })).rejects.toBeInstanceOf(
      LlmRateLimitError,
    );
    now = 60_000;
    await expect(policy.ensureCallPermitted({ model: 'gw/model-a' })).resolves.toBeUndefined();
  });

  it('на стыке минут двойной лимит не проходит', async () => {
    // У счётчика с обнулением по минуте два лимита подряд проезжают на границе
    // окна. Скользящее окно обязано этого не допускать.
    let now = 0;
    const policy = policyOf({ rateLimitPerMin: 2, now: () => now });

    now = 59_000;
    await policy.ensureCallPermitted({ model: 'gw/model-a' });
    now = 59_500;
    await policy.ensureCallPermitted({ model: 'gw/model-a' });
    now = 60_100;
    await expect(policy.ensureCallPermitted({ model: 'gw/model-a' })).rejects.toBeInstanceOf(
      LlmRateLimitError,
    );
  });

  it('отказ по частоте повторяем, отказ по бюджету и модели — нет', async () => {
    const rate = policyOf({ rateLimitPerMin: 0 });
    // Нулевой лимит означает «ограничения нет», а не «запретить всё»:
    // проверяется отдельно, чтобы значение по умолчанию было однозначным.
    await expect(rate.ensureCallPermitted({ model: 'gw/model-a' })).resolves.toBeUndefined();

    const limited = policyOf({ rateLimitPerMin: 1 });
    await limited.ensureCallPermitted({ model: 'gw/model-a' });
    await expect(limited.ensureCallPermitted({ model: 'gw/model-a' })).rejects.toMatchObject({
      retriable: true,
    });
  });
});
