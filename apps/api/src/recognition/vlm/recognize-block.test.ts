/**
 * Оркестрация распознавания блока: исходы ok/invalid_response/model_refusal,
 * ровно один корректирующий повтор, ровно один downscale-повтор, проброс
 * прочих ошибок порта.
 */
import { describe, expect, it } from 'vitest';

import { LlmPayloadTooLargeError, LlmRateLimitError, LlmUpstreamError } from '../../llm/port.js';
import type { VlmPort, VlmRequest, VlmResponse } from '../../llm/vlm-port.js';

import {
  CORRECTIVE_INSTRUCTION,
  RETRYABLE_TABLE_EMPTY_ROWS,
  RETRY_INSTRUCTION,
  WARNING_EMPTY_FRAGMENTS,
} from './postprocess.js';
import { RECOGNITION_PROMPT_DEFAULTS } from './prompts.js';
import {
  recognizeBlock,
  type RecognizeBlockInput,
  type RecognizeBlockPrompt,
} from './recognize-block.js';

class FakeVlm implements VlmPort {
  readonly requests: VlmRequest[] = [];
  readonly #queue: (VlmResponse | Error)[];

  constructor(queue: readonly (VlmResponse | Error)[]) {
    this.#queue = [...queue];
  }

  complete(request: VlmRequest): Promise<VlmResponse> {
    this.requests.push(request);
    const next = this.#queue.shift();
    if (next === undefined) return Promise.reject(new Error('очередь мока пуста'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

function payloadTooLarge(): LlmPayloadTooLargeError {
  return new LlmPayloadTooLargeError(27_000_000, 'тело запроса превышает предохранитель');
}

/**
 * Двойник из «другой копии модуля»: instanceof по нему лжёт, различение
 * держится на `error.name` — страховочная ветка isPayloadTooLarge.
 */
class ForeignPayloadTooLarge extends Error {
  constructor() {
    super('тело запроса превышает предохранитель (чужая копия класса)');
    this.name = 'LlmPayloadTooLargeError';
  }
}

function reply(text: string, patch: Partial<VlmResponse> = {}): VlmResponse {
  return {
    text,
    model: 'actual/model-slug',
    requestedModel: 'requested/model-slug',
    provider: 'recorded',
    toolCalls: [],
    tokensIn: 100,
    tokensOut: 50,
    cost: null,
    latencyMs: 5,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    upstreamId: null,
    cacheHit: false,
    finishReason: 'stop',
    ...patch,
  };
}

function promptFor(type: 'text' | 'image' | 'stamp'): RecognizeBlockPrompt {
  const defaults = RECOGNITION_PROMPT_DEFAULTS[type];
  return {
    code: defaults.code,
    version: 1,
    systemPrompt: defaults.systemPrompt,
    userTemplate: defaults.userTemplate,
    temperature: defaults.temperature,
    maxTokens: defaults.maxTokens,
    topK: defaults.topK,
    responseFormat: defaults.responseFormat,
    schemaVersion: `${defaults.responseFormat.name}@test`,
  };
}

function inputFor(
  vlm: VlmPort,
  type: 'text' | 'image' | 'stamp',
  patch: Partial<RecognizeBlockInput> = {},
): RecognizeBlockInput {
  return {
    vlm,
    prompt: promptFor(type),
    model: 'requested/model-slug',
    block: {
      layoutBlockId: 'f0c0de00-1111-4222-8333-000000000042',
      blockType: type,
      coordsNorm: [0.1, 0.2, 0.8, 0.9],
      sortOrder: 2,
    },
    cropPng: new Uint8Array([1, 2, 3]),
    pageNumber: 3,
    ...patch,
  };
}

const validTextJson = JSON.stringify({
  fragments: [{ kind: 'paragraph', text: 'Общие указания', emphasis: 'none' }],
});

/** Боевой ответ на страницу описи: сетка объявлена, строк ноль. */
const emptyTableJson = JSON.stringify({
  fragments: [
    { kind: 'table', text: null, emphasis: null, level: null, title: null, header: null, rows: [] },
  ],
});

const filledTableJson = JSON.stringify({
  fragments: [
    {
      kind: 'table',
      text: null,
      emphasis: null,
      level: null,
      title: null,
      header: ['№', 'Наименование'],
      rows: [['1.1', 'АОСР']],
    },
  ],
});

const blankStampJson = JSON.stringify({
  document_code: null,
  sheet_code: null,
  project_name: null,
  sheet_name: null,
  stage: null,
  sheet_number: null,
  total_sheets: null,
  organization: null,
  signatures: [],
  revisions: [],
});

describe('recognizeBlock: успех', () => {
  it('валидный ответ → ok; блок несёт идентичность замороженного блока', async () => {
    const vlm = new FakeVlm([reply(validTextJson)]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.block).toMatchObject({
      blockType: 'text',
      layoutBlockId: 'f0c0de00-1111-4222-8333-000000000042',
      ordinal: 2,
      coordsNorm: [0.1, 0.2, 0.8, 0.9],
      modelId: 'actual/model-slug', // фактическая модель, не заказанная
      text: 'Общие указания',
    });
    expect(outcome.warnings).toEqual([]);
    expect(outcome.raw).toEqual(JSON.parse(validTextJson));
    expect(vlm.requests).toHaveLength(1);
  });

  it('собранный запрос: recognize, подстановка user, схема, параметры', async () => {
    const vlm = new FakeVlm([reply(blankStampJson)]);
    await recognizeBlock(inputFor(vlm, 'stamp'));

    const request = vlm.requests[0];
    expect(request).toMatchObject({
      stage: 'recognize',
      promptCode: 'recognition_block_stamp',
      promptVersion: 1,
      model: 'requested/model-slug',
      temperature: 0,
      maxTokens: 4096,
      schemaVersion: 'stamp_block_result@test',
    });
    // `topK` не задан ни у одного профиля: при `temperature: 0` выборка и так
    // жадная, а лишний параметр сужает маршрутизацию OpenRouter. Сам механизм
    // «задан → уезжает в тело» остаётся под `vlm-proxy.test.ts`.
    expect(request?.topK).toBeUndefined();
    expect(request?.userPrompt).toContain('PAGE_NUM: 3');
    expect(request?.userPrompt).toContain('BLOCK_ID: f0c0de00-1111-4222-8333-000000000042');
    expect(request?.userPrompt).not.toContain('{PAGE_NUM}');
    expect(request?.systemPrompt).not.toContain('CRITICAL — ');
    expect(request?.responseFormat.name).toBe('stamp_block_result');
    expect(request?.images).toHaveLength(1);
  });

  it('шум (<think> + фенс) счищается, ответ разбирается', async () => {
    const vlm = new FakeVlm([reply(`<think>x</think>\`\`\`json\n${validTextJson}\n\`\`\``)]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));
    expect(outcome.kind).toBe('ok');
  });

  it('пустой блок {"fragments": []} — ok с warning, а не отказ', async () => {
    const vlm = new FakeVlm([reply('{"fragments": []}')]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.warnings).toEqual([WARNING_EMPTY_FRAGMENTS]);
  });

  it('пустой штамп — ok с warning stamp_all_fields_blank', async () => {
    const vlm = new FakeVlm([reply(blankStampJson)]);
    const outcome = await recognizeBlock(inputFor(vlm, 'stamp'));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.warnings).toEqual(['stamp_all_fields_blank']);
  });
});

describe('recognizeBlock: отказы модели', () => {
  it('finish_reason=length → model_refusal без повторов', async () => {
    const vlm = new FakeVlm([reply('обрыв', { finishReason: 'length' })]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('model_refusal');
    if (outcome.kind === 'model_refusal') expect(outcome.reason).toContain('length');
    expect(vlm.requests).toHaveLength(1);
  });

  it('finish_reason=content_filter → model_refusal', async () => {
    const vlm = new FakeVlm([reply('', { finishReason: 'content_filter' })]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));
    expect(outcome.kind).toBe('model_refusal');
  });

  it('пустой текст при stop/null → model_refusal (пустая строка — не результат)', async () => {
    for (const finishReason of ['stop', null]) {
      const vlm = new FakeVlm([reply('   ', { finishReason })]);
      const outcome = await recognizeBlock(inputFor(vlm, 'text'));
      expect(outcome.kind).toBe('model_refusal');
      expect(vlm.requests).toHaveLength(1);
    }
  });

  it('пустой текст при finish_reason=error — не отказ модели, а молчание шлюза', async () => {
    // Отказ означает, что модель ответила и ответ непригоден. Здесь ответа не
    // было вовсе: провайдер сообщил свою ошибку, токенов ноль. Исход сделал бы
    // блок непокрытым без единого повтора — и один такой ответ стоил боевому
    // комплекту всего прогона. Повторяемая ошибка отдаёт решение движку задач.
    const vlm = new FakeVlm([reply('', { finishReason: 'error' })]);

    await expect(recognizeBlock(inputFor(vlm, 'text'))).rejects.toBeInstanceOf(LlmUpstreamError);
    expect(vlm.requests).toHaveLength(1);
  });
});

describe('recognizeBlock: корректирующий повтор', () => {
  it('жанровая ошибка → один платный повтор с CORRECTIVE_INSTRUCTION, затем ok', async () => {
    const vlm = new FakeVlm([reply('Не могу распознать это изображение.'), reply(validTextJson)]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('ok');
    expect(vlm.requests).toHaveLength(2);
    const [first, second] = vlm.requests;
    expect(first?.systemPrompt).not.toContain('CRITICAL — ');
    expect(second?.systemPrompt).toBe(`${first?.systemPrompt}\n\n${CORRECTIVE_INSTRUCTION.text}`);
    expect(second?.userPrompt).toBe(first?.userPrompt);
  });

  it('жанровая ошибка дважды → invalid_response, ровно два вызова', async () => {
    const vlm = new FakeVlm([reply('проза'), reply('снова проза')]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('invalid_response');
    expect(vlm.requests).toHaveLength(2);
  });

  it('пустая таблица → повтор с табличной инструкцией, затем таблица прочитана', async () => {
    // Жанр ответа верен, поэтому довесок берётся не из CORRECTIVE_INSTRUCTION:
    // модели говорят про строки таблицы, а не про вид ответа.
    const vlm = new FakeVlm([reply(emptyTableJson), reply(filledTableJson)]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.warnings).toEqual([]);
    expect(vlm.requests).toHaveLength(2);
    const [first, second] = vlm.requests;
    expect(second?.systemPrompt).toBe(
      `${first?.systemPrompt}

${RETRY_INSTRUCTION[RETRYABLE_TABLE_EMPTY_ROWS] ?? ''}`,
    );
  });

  it('пустая таблица дважды → ok с warning, а не отказ', async () => {
    // Упрямая пустота остаётся ответом модели. Отказ здесь стоил бы страницы,
    // а в строгом режиме — всего прогона: покрытие стало бы неполным.
    const vlm = new FakeVlm([reply(emptyTableJson), reply(emptyTableJson)]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.warnings).toEqual([RETRYABLE_TABLE_EMPTY_ROWS]);
    expect(vlm.requests).toHaveLength(2);
  });

  it('обёртка есть, значения не по схеме → invalid_response БЕЗ повтора', async () => {
    const vlm = new FakeVlm([reply('{"fragments": 5}')]);
    const outcome = await recognizeBlock(inputFor(vlm, 'text'));

    expect(outcome.kind).toBe('invalid_response');
    if (outcome.kind === 'invalid_response') {
      expect(outcome.reason).toContain('invalid');
      expect(outcome.reason).toContain('fragments');
    }
    expect(vlm.requests).toHaveLength(1);
  });

  it('invalid-код валидатора → invalid_response (проза вместо шифра штампа)', async () => {
    const prose = JSON.parse(blankStampJson) as Record<string, unknown>;
    prose['document_code'] =
      'Многоквартирный жилой дом со встроенными помещениями обслуживания по адресу город условный, улица условная, участок 12';
    const vlm = new FakeVlm([reply(JSON.stringify(prose))]);
    const outcome = await recognizeBlock(inputFor(vlm, 'stamp'));

    expect(outcome.kind).toBe('invalid_response');
    if (outcome.kind === 'invalid_response') {
      expect(outcome.reason).toBe('stamp_prose_document_code');
    }
    expect(vlm.requests).toHaveLength(1);
  });
});

describe('recognizeBlock: превышение тела и ошибки порта', () => {
  it('payload-too-large + downscale → один повтор с уменьшенным кропом', async () => {
    const smaller = new Uint8Array([9]);
    const downscaleCalls: Uint8Array[] = [];
    const vlm = new FakeVlm([payloadTooLarge(), reply(validTextJson)]);
    const outcome = await recognizeBlock(
      inputFor(vlm, 'text', {
        downscale: (png) => {
          downscaleCalls.push(png);
          return Promise.resolve(smaller);
        },
      }),
    );

    expect(outcome.kind).toBe('ok');
    expect(downscaleCalls).toHaveLength(1);
    expect(vlm.requests).toHaveLength(2);
    expect(vlm.requests[0]?.images[0]?.png).toEqual(new Uint8Array([1, 2, 3]));
    expect(vlm.requests[1]?.images[0]?.png).toBe(smaller);
  });

  it('payload-too-large без downscale → ошибка пробрасывается', async () => {
    const vlm = new FakeVlm([payloadTooLarge()]);
    await expect(recognizeBlock(inputFor(vlm, 'text'))).rejects.toBeInstanceOf(
      LlmPayloadTooLargeError,
    );
    expect(vlm.requests).toHaveLength(1);
  });

  it('чужая копия класса различается по name (страховочная ветка)', async () => {
    const vlm = new FakeVlm([new ForeignPayloadTooLarge(), reply(validTextJson)]);
    const outcome = await recognizeBlock(
      inputFor(vlm, 'text', { downscale: (png) => Promise.resolve(png) }),
    );
    expect(outcome.kind).toBe('ok');
    expect(vlm.requests).toHaveLength(2);
  });

  it('payload-too-large и после downscale → пробрасывается (второго уменьшения нет)', async () => {
    let downscales = 0;
    const vlm = new FakeVlm([payloadTooLarge(), payloadTooLarge()]);
    await expect(
      recognizeBlock(
        inputFor(vlm, 'text', {
          downscale: (png) => {
            downscales += 1;
            return Promise.resolve(png);
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'LlmPayloadTooLargeError' });
    expect(downscales).toBe(1);
    expect(vlm.requests).toHaveLength(2);
  });

  it('прочие LlmError пробрасываются наружу (решает движок задач)', async () => {
    const vlm = new FakeVlm([new LlmRateLimitError('429 от прокси')]);
    await expect(recognizeBlock(inputFor(vlm, 'text'))).rejects.toBeInstanceOf(LlmRateLimitError);
    expect(vlm.requests).toHaveLength(1);
  });
});
