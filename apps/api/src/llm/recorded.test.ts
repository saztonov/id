/**
 * Офлайн-двойник LLM (§1.3) — и главное требование этапа.
 *
 * Проверяется ровно то, чего не хватило двойнику RD WEB на S7: способность быть
 * НЕ ДОБРЕЕ оригинала. Каждое из восьми записанных поведений обязано доехать до
 * вызывающего в своей форме — четыре текстовых без единой правки и четыре
 * (включая отсутствие записи) исключением своего класса. Двойник, который
 * «чинит» ответ или подставляет правдоподобный, делает зелёными те самые тесты,
 * ради которых пишутся правила §8.2 про цитаты и §9.1 про уверенность.
 */
import { describe, expect, it } from 'vitest';

import { LlmPolicy } from './policy.js';
import {
  LlmBudgetError,
  LlmModelNotAllowedError,
  LlmRateLimitError,
  LlmRecordingMissingError,
  LlmTimeoutError,
  type LlmRequest,
} from './port.js';
import { RecordedLlmProvider, type RecordedBehaviour } from './recorded.js';

/** Отказ вызова как значение: `.catch()` дал бы объединение с успешным ответом. */
async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error('вызов обязан был завершиться отказом');
}

const REQUEST: LlmRequest = {
  stage: 'page_classify',
  promptCode: 'page_classify_open_world',
  promptVersion: 1,
  systemPrompt: 'Классифицируй страницу. Отвечай JSON по схеме.',
  userPrompt: 'АКТ\nосвидетельствования скрытых работ №12',
  schemaVersion: 'page_classify.v1',
  cacheContext: 'prev=U;next=U',
  model: 'recorded/model',
};

/** Текст страницы, на котором проверяется выдуманная цитата. */
const PAGE_TEXT = 'АКТ\nосвидетельствования скрытых работ №12';

function providerWith(behaviour: RecordedBehaviour, request: LlmRequest = REQUEST) {
  const hash = RecordedLlmProvider.hashOf(request);
  return new RecordedLlmProvider({ responses: new Map([[hash, behaviour]]) });
}

describe('поиск записи по хэшу полного эффективного промта', () => {
  it('запись находится по хэшу и отдаётся с провайдером recorded', async () => {
    const provider = providerWith({ kind: 'ok', text: '{"label":"B-DOC"}' });
    const response = await provider.complete(REQUEST);

    expect(response.provider).toBe('recorded');
    expect(response.text).toBe('{"label":"B-DOC"}');
    expect(response.inputHash).toBe(RecordedLlmProvider.hashOf(REQUEST));
    expect(response.outputHash).toMatch(/^[0-9a-f]{64}$/);
    // Кэша у двойника нет намеренно: он обязан воспроизводить запись на КАЖДОМ
    // вызове, иначе `timeout` сработал бы один раз, а дальше молча проходил.
    expect(response.cacheHit).toBe(false);
  });

  it('изменение любой части промта делает запись ненайденной', async () => {
    const provider = providerWith({ kind: 'ok', text: '{"label":"B-DOC"}' });

    for (const changed of [
      { ...REQUEST, userPrompt: `${REQUEST.userPrompt} ` },
      { ...REQUEST, systemPrompt: 'другой системный промт' },
      { ...REQUEST, schemaVersion: 'page_classify.v2' },
      { ...REQUEST, cacheContext: 'prev=B-DOC;next=U' },
      { ...REQUEST, promptVersion: 2 },
      { ...REQUEST, model: 'recorded/other' },
    ]) {
      await expect(provider.complete(changed)).rejects.toBeInstanceOf(LlmRecordingMissingError);
    }
  });
});

describe('незаписанный промт — отказ, а не правдоподобный ответ', () => {
  it('по умолчанию бросает LlmRecordingMissingError с хэшем в сообщении', async () => {
    const provider = new RecordedLlmProvider({ responses: new Map() });
    const hash = RecordedLlmProvider.hashOf(REQUEST);

    const error = await failureOf(provider.complete(REQUEST));
    expect(error).toBeInstanceOf(LlmRecordingMissingError);
    // Хэш в сообщении — это и есть инструкция «добавь запись осознанно».
    expect(error.message).toContain(hash);
    expect(error.message).toContain('page_classify');
  });

  it('явно заданный fallback используется, но по умолчанию его нет', async () => {
    const provider = new RecordedLlmProvider({
      responses: new Map(),
      fallback: () => ({ kind: 'off_schema', text: '{"unexpected":true}' }),
    });

    const response = await provider.complete(REQUEST);
    expect(response.text).toBe('{"unexpected":true}');
  });
});

describe('восемь записанных поведений доезжают до вызывающего', () => {
  it('1. ok — текст, токены и стоимость', async () => {
    const provider = providerWith({
      kind: 'ok',
      text: '{"label":"B-DOC","doc_type":"aosr","confidence":0.92}',
      tokensIn: 100,
      tokensOut: 20,
      cost: 0.05,
    });
    const response = await provider.complete(REQUEST);

    expect(JSON.parse(response.text)).toMatchObject({ label: 'B-DOC' });
    expect(response.tokensIn).toBe(100);
    expect(response.tokensOut).toBe(20);
    expect(response.cost).toBe(0.05);
  });

  it('2. invalid_json — текст доезжает НЕразобранным и не чинится', async () => {
    const broken = 'Конечно! Вот ответ:\n{"label": "B-DOC",}';
    const provider = providerWith({ kind: 'invalid_json', text: broken });
    const response = await provider.complete(REQUEST);

    expect(response.text).toBe(broken);
    expect(() => JSON.parse(response.text)).toThrow();
  });

  it('3. off_schema — валидный JSON, но полей схемы в нём нет', async () => {
    const provider = providerWith({
      kind: 'off_schema',
      text: '{"class":"акт","probability":"высокая"}',
    });
    const response = await provider.complete(REQUEST);
    const parsed = JSON.parse(response.text) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty('label');
    expect(parsed).not.toHaveProperty('doc_type');
  });

  it('4. fabricated_quote — цитаты нет в тексте страницы', async () => {
    const provider = providerWith({
      kind: 'fabricated_quote',
      text: '{"label":"B-DOC","doc_type":"aosr","quote":"Приложение к акту №99"}',
    });
    const response = await provider.complete(REQUEST);
    const quote = (JSON.parse(response.text) as { quote: string }).quote;

    // §8.2: цитата обязана отображаться обратно на точный span текста страницы,
    // иначе результат `undetermined`. Двойник без этого поведения не даёт
    // правилу ни одного повода сработать.
    expect(PAGE_TEXT).not.toContain(quote);
  });

  it('5. foreign_language — ответ на другом языке', async () => {
    const provider = providerWith({
      kind: 'foreign_language',
      text: '{"label":"B-DOC","reason":"This page starts a new document."}',
    });
    const response = await provider.complete(REQUEST);
    const reason = (JSON.parse(response.text) as { reason: string }).reason;

    expect(reason).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('6. timeout — LlmTimeoutError, повторяемый', async () => {
    const provider = providerWith({ kind: 'timeout' });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmTimeoutError',
      retriable: true,
    });
    // Второй вызов обязан упасть так же: запись описывает поведение модели, а
    // не одноразовое событие.
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('7. budget_exceeded — LlmBudgetError, неповторяемый', async () => {
    const provider = providerWith({ kind: 'budget_exceeded' });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmBudgetError',
      retriable: false,
    });
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmBudgetError);
  });

  it('8. rate_limited — LlmRateLimitError, повторяемый', async () => {
    const provider = providerWith({ kind: 'rate_limited' });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'LlmRateLimitError',
      retriable: true,
    });
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmRateLimitError);
  });
});

describe('allowlist применяется и к двойнику', () => {
  it('модель вне списка отвергается до поиска записи', async () => {
    const hash = RecordedLlmProvider.hashOf(REQUEST);
    const provider = new RecordedLlmProvider({
      responses: new Map<string, RecordedBehaviour>([[hash, { kind: 'ok', text: '{}' }]]),
      policy: new LlmPolicy({
        allowedModels: ['gw/model-a'],
        emptyAllowlist: 'deny',
        budgetMonthly: 0,
        rateLimitPerMin: 0,
        spend: { monthlySpend: () => Promise.resolve(0) },
      }),
    });

    // Иначе гейты на двойнике пропустили бы модель, которую production
    // отвергает ещё до сетевого вызова.
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmModelNotAllowedError);
  });
});
