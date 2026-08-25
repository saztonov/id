/**
 * Кроп по запросу модели (ADR-0013, S21).
 *
 * Проверяется разбор запроса и цикл кругов. Всё, что модель присылает в
 * аргументах инструмента, — входные данные: прямоугольник вне листа, вырожденный
 * или вовсе не число обязан кончиться ВНЯТНЫМ отказом, доехавшим до модели, а
 * не исключением и не молчанием.
 */
import { describe, expect, it, vi } from 'vitest';

import type { VlmPort, VlmRequest, VlmResponse } from '../../llm/vlm-port.js';
import { parseToolCalls } from '../../llm/vlm-proxy.js';

import {
  MAX_CROP_REQUESTS,
  parseCropRect,
  recognizeBlock,
  REQUEST_CROP_TOOL,
  type RecognizeBlockPrompt,
} from './recognize-block.js';
import { RECOGNITION_PROMPT_DEFAULTS } from './prompts.js';

describe('parseCropRect', () => {
  it('принимает нормированный прямоугольник', () => {
    expect(parseCropRect('{"x0":0.1,"y0":0.2,"x1":0.5,"y1":0.6}')).toEqual({
      rect: [0.1, 0.2, 0.5, 0.6],
    });
  });

  it('отвергает координаты вне листа', () => {
    const result = parseCropRect('{"x0":-0.1,"y0":0,"x1":0.5,"y1":0.5}');
    expect(result).toEqual({ error: 'координаты выходят за пределы листа (допустимо 0..1)' });
  });

  it('отвергает вырожденный участок', () => {
    const result = parseCropRect('{"x0":0.5,"y0":0.5,"x1":0.5,"y1":0.9}');
    expect(result).toEqual({ error: 'участок вырожден: x1>x0 и y1>y0 обязательны' });
  });

  it('отвергает нечисловые и отсутствующие поля', () => {
    expect(parseCropRect('{"x0":"a","y0":0,"x1":1,"y1":1}')).toEqual({
      error: 'нужны четыре числа: x0, y0, x1, y1',
    });
    expect(parseCropRect('не json')).toEqual({ error: 'аргументы инструмента не являются JSON' });
  });
});

describe('parseToolCalls', () => {
  it('пропускает вызовы без id и без имени: закрыть их нечем', () => {
    const calls = parseToolCalls([
      { id: 'call-1', function: { name: 'request_crop', arguments: '{"x0":0}' } },
      { function: { name: 'request_crop', arguments: '{}' } },
      { id: 'call-3', function: { arguments: '{}' } },
      'мусор',
    ]);
    expect(calls).toEqual([{ id: 'call-1', name: 'request_crop', argumentsJson: '{"x0":0}' }]);
  });

  it('отсутствующие аргументы читаются как пустой объект', () => {
    expect(parseToolCalls([{ id: 'c', function: { name: 'request_crop' } }])).toEqual([
      { id: 'c', name: 'request_crop', argumentsJson: '{}' },
    ]);
  });

  it('не-массив даёт пустой список', () => {
    expect(parseToolCalls(undefined)).toEqual([]);
    expect(parseToolCalls({ id: 'c' })).toEqual([]);
  });
});

// =====================================================================
// Цикл кругов
// =====================================================================

const PROMPT: RecognizeBlockPrompt = {
  code: RECOGNITION_PROMPT_DEFAULTS.text.code,
  version: 1,
  systemPrompt: 'система',
  userTemplate: 'страница {PAGE_NUM}, блок {BLOCK_ID}',
  temperature: 0.1,
  maxTokens: 1000,
  responseFormat: RECOGNITION_PROMPT_DEFAULTS.text.responseFormat,
  schemaVersion: 'schema-v1',
};

const BLOCK = {
  layoutBlockId: '00000000-0000-4000-8000-000000000001',
  blockType: 'text' as const,
  coordsNorm: [0.1, 0.1, 0.9, 0.4] as readonly [number, number, number, number],
  sortOrder: 0,
};

function response(patch: Partial<VlmResponse>): VlmResponse {
  return {
    text: '',
    model: 'actual/model',
    requestedModel: 'requested/model',
    provider: 'recorded',
    toolCalls: [],
    tokensIn: 1,
    tokensOut: 1,
    cost: null,
    latencyMs: 1,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    upstreamId: null,
    cacheHit: false,
    finishReason: 'stop',
    ...patch,
  };
}

const FINAL_TEXT = JSON.stringify({
  fragments: [{ kind: 'paragraph', text: 'Прочитанный текст', emphasis: 'none' }],
});

function portReturning(responses: readonly VlmResponse[]): {
  port: VlmPort;
  requests: VlmRequest[];
} {
  const requests: VlmRequest[] = [];
  let index = 0;
  return {
    requests,
    port: {
      complete: async (request) => {
        requests.push(request);
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return Promise.resolve(next as VlmResponse);
      },
    },
  };
}

describe('recognizeBlock: дозапрос кропа', () => {
  it('инструмент не объявляется, если резать нечем', async () => {
    const { port, requests } = portReturning([response({ text: FINAL_TEXT })]);
    await recognizeBlock({
      vlm: port,
      prompt: PROMPT,
      model: 'requested/model',
      block: BLOCK,
      cropPng: new Uint8Array([1, 2, 3]),
      pageNumber: 1,
    });
    // Пообещать модели инструмент и не исполнить его значит оставить её ждать
    // кроп, которого не будет.
    expect(requests[0]?.tools).toBeUndefined();
  });

  it('исполняет запрос кропа и возвращается к модели с приложенным участком', async () => {
    const { port, requests } = portReturning([
      response({
        toolCalls: [
          {
            id: 'call-1',
            name: REQUEST_CROP_TOOL,
            argumentsJson: '{"x0":0.1,"y0":0.4,"x1":0.9,"y1":0.6}',
          },
        ],
      }),
      response({ text: FINAL_TEXT }),
    ]);
    const requestCrop = vi.fn(async () => Promise.resolve(new Uint8Array([9, 9])));

    const outcome = await recognizeBlock({
      vlm: port,
      prompt: PROMPT,
      model: 'requested/model',
      block: BLOCK,
      cropPng: new Uint8Array([1, 2, 3]),
      pageNumber: 1,
      requestCrop,
    });

    expect(outcome.kind).toBe('ok');
    expect(requestCrop).toHaveBeenCalledWith([0.1, 0.4, 0.9, 0.6]);
    // Диалог уезжает целиком: без него второй вызов склеился бы с первым по
    // каноническому входу и вернул бы тот же запрос кропа.
    expect(requests[1]?.exchanges).toHaveLength(1);
    expect(requests[1]?.exchanges?.[0]?.results[0]?.images).toHaveLength(1);
    if (outcome.kind === 'ok') expect(outcome.warnings).toContain('crop_requests=1');
  });

  it('отказ инструмента доезжает до модели текстом, а не молчанием', async () => {
    const { port, requests } = portReturning([
      response({
        toolCalls: [
          { id: 'call-1', name: REQUEST_CROP_TOOL, argumentsJson: '{"x0":2,"y0":0,"x1":3,"y1":1}' },
        ],
      }),
      response({ text: FINAL_TEXT }),
    ]);

    const outcome = await recognizeBlock({
      vlm: port,
      prompt: PROMPT,
      model: 'requested/model',
      block: BLOCK,
      cropPng: new Uint8Array([1, 2, 3]),
      pageNumber: 1,
      requestCrop: async () => Promise.resolve(new Uint8Array([9])),
    });

    expect(outcome.kind).toBe('ok');
    const result = requests[1]?.exchanges?.[0]?.results[0];
    expect(result?.images).toEqual([]);
    expect(result?.text).toContain('за пределы листа');
  });
  it('потолок кругов исчерпан — закрывающий вызов без права звать инструмент', async () => {
    const asking = response({
      toolCalls: [
        {
          id: 'call-1',
          name: REQUEST_CROP_TOOL,
          argumentsJson: '{"x0":0,"y0":0,"x1":1,"y1":1}',
        },
      ],
    });
    // Модель просит кроп на каждом вызове, где инструмент разрешён, и
    // отвечает по существу на закрывающем.
    const { port, requests } = portReturning([asking, asking, response({ text: FINAL_TEXT })]);

    const outcome = await recognizeBlock({
      vlm: port,
      prompt: PROMPT,
      model: 'requested/model',
      block: BLOCK,
      cropPng: new Uint8Array([1, 2, 3]),
      pageNumber: 1,
      requestCrop: async () => Promise.resolve(new Uint8Array([9])),
    });

    // Прежде здесь был `model_refusal`: диалог обрывался молчанием, и блок
    // оставался непокрытым, роняя весь прогон на строгом покрытии.
    expect(outcome.kind).toBe('ok');
    // Ровно `MAX_CROP_REQUESTS + 1` вызовов: закрывающий занимает место того,
    // который прежде уходил впустую, а не добавляется к ним.
    expect(requests).toHaveLength(MAX_CROP_REQUESTS + 1);

    const closing = requests.at(-1);
    // Инструмент остаётся ОБЪЯВЛЕННЫМ: история кругов уже уехала в диалог, и
    // часть провайдеров отвергает её при пустом списке инструментов. Запрещает
    // звать его `tool_choice`.
    expect(closing?.tools).toHaveLength(1);
    expect(closing?.toolChoice).toBe('none');
    expect(closing?.exchanges).toHaveLength(MAX_CROP_REQUESTS);
    expect(closing?.systemPrompt).toContain('FINAL ANSWER REQUIRED');
    // Обычные круги права не теряют.
    expect(requests[0]?.toolChoice).toBe('auto');

    if (outcome.kind === 'ok') {
      expect(outcome.warnings).toContain('crop_ceiling_reached');
      expect(outcome.warnings).toContain(`crop_requests=${String(MAX_CROP_REQUESTS)}`);
    }
    // Все разрешённые круги выданы: закрывающий вызов идёт следом за
    // последним из них, а не вместо ответа на очередной запрос.
    expect(outcome.cropTrail).toHaveLength(MAX_CROP_REQUESTS);
    expect(outcome.cropTrail.every((event) => event.outcome === 'granted')).toBe(true);
    // Каждый физический вызов доступен вызывающему: по строке `ai_runs` на
    // каждый, иначе круги кропа не попадают в учёт стоимости вовсе.
    expect(outcome.calls).toHaveLength(MAX_CROP_REQUESTS + 1);
  });

  it('модель просит кроп и после закрывающего вызова — model_refusal, четвёртого вызова нет', async () => {
    const asking = response({
      toolCalls: [
        { id: 'call-1', name: REQUEST_CROP_TOOL, argumentsJson: '{"x0":0,"y0":0,"x1":1,"y1":1}' },
      ],
    });
    const { port, requests } = portReturning([asking]);

    const outcome = await recognizeBlock({
      vlm: port,
      prompt: PROMPT,
      model: 'requested/model',
      block: BLOCK,
      cropPng: new Uint8Array([1, 2, 3]),
      pageNumber: 1,
      requestCrop: async () => Promise.resolve(new Uint8Array([9])),
    });

    expect(outcome.kind).toBe('model_refusal');
    if (outcome.kind === 'model_refusal') {
      expect(outcome.reason).toContain('после закрывающего вызова');
    }
    // Запрос, сделанный вопреки запрету, остаётся в следе — иначе разбор
    // видит выданные участки и не видит того, на котором блок встал.
    expect(outcome.cropTrail.at(-1)?.outcome).toBe('ceiling_rejected');
    // Закрывающий вызов на КАЖДУЮ из двух попыток (основную и корректирующую);
    // дальше цикл не растёт — пятого и шестого круга не бывает.
    expect(requests.length).toBeLessThanOrEqual(2 * (MAX_CROP_REQUESTS + 1));
  });

  it('потолок поднимается вызывающим: блоку на весь лист дают лишний круг', async () => {
    const asking = response({
      toolCalls: [
        { id: 'call-1', name: REQUEST_CROP_TOOL, argumentsJson: '{"x0":0,"y0":0,"x1":1,"y1":1}' },
      ],
    });
    const { port, requests } = portReturning([
      asking,
      asking,
      asking,
      response({ text: FINAL_TEXT }),
    ]);

    const outcome = await recognizeBlock({
      vlm: port,
      prompt: PROMPT,
      model: 'requested/model',
      block: BLOCK,
      cropPng: new Uint8Array([1, 2, 3]),
      pageNumber: 1,
      requestCrop: async () => Promise.resolve(new Uint8Array([9])),
      maxCropRequests: 3,
    });

    expect(outcome.kind).toBe('ok');
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)?.exchanges).toHaveLength(3);
  });

  it('поломка резчика доезжает до модели текстом, а не исключением', async () => {
    const { port, requests } = portReturning([
      response({
        toolCalls: [
          {
            id: 'call-1',
            name: REQUEST_CROP_TOOL,
            argumentsJson: '{"x0":0.1,"y0":0.4,"x1":0.9,"y1":0.6}',
          },
        ],
      }),
      response({ text: FINAL_TEXT }),
    ]);

    const outcome = await recognizeBlock({
      vlm: port,
      prompt: PROMPT,
      model: 'requested/model',
      block: BLOCK,
      cropPng: new Uint8Array([1, 2, 3]),
      pageNumber: 1,
      requestCrop: () => Promise.reject(new Error('sharp упал')),
    });

    // Соседний участок вырезать не вышло — это не повод терять блок: основной
    // кроп у модели есть, и она отвечает по нему.
    expect(outcome.kind).toBe('ok');
    expect(requests[1]?.exchanges?.[0]?.results[0]?.images).toEqual([]);
    expect(outcome.cropTrail).toEqual([{ rect: [0.1, 0.4, 0.9, 0.6], outcome: 'crop_failed' }]);
  });
});
