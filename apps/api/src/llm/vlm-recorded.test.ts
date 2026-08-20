/**
 * Офлайн-двойник VLM (урок S7: двойник не смеет быть мягче оригинала).
 *
 * Проверяется контракт, а не удобство: запись находится строго по хэшу
 * канонического входа, незаписанный вход — отказ с хэшем в сообщении, а
 * «плохие» ответы (обрыв, пустой текст) доезжают до вызывающего как данные —
 * ровно так же, как их отдаёт боевой провайдер.
 */
import { describe, expect, it } from 'vitest';

import { LlmModelNotAllowedError, LlmRecordingMissingError } from './port.js';
import { LlmPolicy } from './policy.js';
import type { VlmRequest } from './vlm-port.js';
import { RecordedVlmProvider } from './vlm-recorded.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 2, 1]);

function request(overrides: Partial<VlmRequest> = {}): VlmRequest {
  return {
    stage: 'recognize',
    promptCode: 'recognition_block_stamp',
    promptVersion: 1,
    systemPrompt: 'Распознай штамп.',
    userPrompt: 'Штамп листа 1.',
    images: [{ png: PNG }],
    responseFormat: {
      name: 'recognition_block_stamp',
      strict: true,
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    schemaVersion: 'recognition_block_stamp.v1',
    model: 'gw/vlm-a',
    temperature: 0,
    maxTokens: 4096,
    topK: 1,
    ...overrides,
  };
}

describe('попадание', () => {
  it('запись возвращается как есть, с хэшами и парой requested/actual', async () => {
    const req = request();
    const provider = new RecordedVlmProvider({
      responses: new Map([
        RecordedVlmProvider.recordingFor(req, {
          text: '{"document_code":null}',
          finishReason: 'stop',
          tokensIn: 500,
          tokensOut: 20,
          cost: 0.1,
        }),
      ]),
    });

    const response = await provider.complete(req);
    expect(response.text).toBe('{"document_code":null}');
    expect(response.finishReason).toBe('stop');
    expect(response.provider).toBe('recorded');
    expect(response.model).toBe('gw/vlm-a');
    expect(response.requestedModel).toBe('gw/vlm-a');
    expect(response.tokensIn).toBe(500);
    expect(response.tokensOut).toBe(20);
    expect(response.cost).toBe(0.1);
    expect(response.inputHash).toBe(RecordedVlmProvider.hashOf(req));
    expect(response.outputHash).toMatch(/^[0-9a-f]{64}$/);
    // Кэша у двойника нет: запись обязана воспроизводиться на каждом вызове.
    expect(response.cacheHit).toBe(false);
  });

  it('записанный обрыв доезжает данными, а не исключением', async () => {
    // Ровно как у боевого провайдера: классификация исхода блока — забота
    // recognize-block, двойник довозит факты.
    const req = request();
    const provider = new RecordedVlmProvider({
      responses: new Map([
        RecordedVlmProvider.recordingFor(req, { text: '{"обор', finishReason: 'length' }),
      ]),
    });

    const response = await provider.complete(req);
    expect(response.finishReason).toBe('length');
    expect(response.text).toBe('{"обор');
    expect(response.tokensIn).toBeNull();
    expect(response.cost).toBeNull();
  });

  it('записанная модель может отличаться от запрошенной (роутинг шлюза)', async () => {
    const req = request();
    const provider = new RecordedVlmProvider({
      responses: new Map([
        RecordedVlmProvider.recordingFor(req, {
          text: '{}',
          finishReason: 'stop',
          model: 'gw/vlm-a-2026',
        }),
      ]),
    });

    const response = await provider.complete(req);
    expect(response.model).toBe('gw/vlm-a-2026');
    expect(response.requestedModel).toBe('gw/vlm-a');
  });
});

describe('промах', () => {
  it('незаписанный вход — отказ с хэшем, а не правдоподобный ответ', async () => {
    const provider = new RecordedVlmProvider({ responses: new Map() });
    const req = request();

    const error = await provider.complete(req).then(
      () => {
        throw new Error('вызов обязан был завершиться отказом');
      },
      (raised: unknown) => raised as LlmRecordingMissingError,
    );

    expect(error).toBeInstanceOf(LlmRecordingMissingError);
    expect(error.promptHash).toBe(RecordedVlmProvider.hashOf(req));
    expect(error.message).toContain(RecordedVlmProvider.hashOf(req));
    expect(error.message).toContain('recognition_block_stamp@1');
    expect(error.retriable).toBe(false);
  });

  it('изменённый вход (другой кроп) не находит старую запись', async () => {
    const recorded = request();
    const provider = new RecordedVlmProvider({
      responses: new Map([
        RecordedVlmProvider.recordingFor(recorded, { text: '{}', finishReason: 'stop' }),
      ]),
    });

    const otherCrop = request({ images: [{ png: Uint8Array.from([1, 2, 3]) }] });
    await expect(provider.complete(otherCrop)).rejects.toBeInstanceOf(LlmRecordingMissingError);
  });
});

describe('политика', () => {
  it('allowlist действует и на двойнике', async () => {
    const req = request();
    const provider = new RecordedVlmProvider({
      responses: new Map([
        RecordedVlmProvider.recordingFor(req, { text: '{}', finishReason: 'stop' }),
      ]),
      policy: new LlmPolicy({
        allowedModels: ['gw/other'],
        emptyAllowlist: 'deny',
        budgetMonthly: 0,
        rateLimitPerMin: 0,
        spend: { monthlySpend: () => Promise.resolve(0) },
      }),
    });

    // Иначе тесты на двойнике пропустили бы модель, которую production
    // отвергнет до вызова.
    await expect(provider.complete(req)).rejects.toBeInstanceOf(LlmModelNotAllowedError);
  });
});
