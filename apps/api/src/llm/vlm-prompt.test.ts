/**
 * Канонизация VLM-входа (ADR-0007).
 *
 * Проверяются два свойства, на которых держатся кэш, идемпотентный ключ шлюза
 * и записи двойника:
 *
 * 1. **Полнота**: КАЖДЫЙ компонент, меняющий ответ модели (картинка, схема,
 *    модель, generation-профиль, промт), меняет `inputHash`. Пропущенный
 *    компонент означал бы выдачу чужого ответа из кэша.
 * 2. **Стабильность**: тот же вход даёт тот же хэш — независимо от порядка
 *    ключей схемы и вида переводов строки. Иначе кэш не срабатывал бы никогда,
 *    а записи двойника не находились бы на другой машине.
 */
import { describe, expect, it } from 'vitest';

import type { VlmRequest } from './vlm-port.js';
import { buildVlmCanonicalInput, canonicalJson, vlmInputHash } from './vlm-prompt.js';

const PNG_A = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function request(overrides: Partial<VlmRequest> = {}): VlmRequest {
  return {
    stage: 'recognize',
    promptCode: 'recognition_block_text',
    promptVersion: 1,
    systemPrompt: 'Распознай блок. Отвечай строгим JSON.',
    userPrompt: 'Блок 3 страницы 2 рабочего документа.',
    images: [{ png: PNG_A }],
    responseFormat: {
      name: 'recognition_block_text',
      strict: true,
      schema: {
        type: 'object',
        properties: { fragments: { type: 'array' } },
        required: ['fragments'],
        additionalProperties: false,
      },
    },
    schemaVersion: 'recognition_block_text.v1',
    model: 'gw/vlm-a',
    temperature: 0.1,
    maxTokens: 12384,
    ...overrides,
  };
}

describe('стабильность', () => {
  it('тот же вход даёт тот же хэш', () => {
    const first = vlmInputHash(request());
    const second = vlmInputHash(request());

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('вид перевода строки в промтах не меняет хэш', () => {
    const unix = vlmInputHash(request({ systemPrompt: 'строка 1\nстрока 2' }));
    const windows = vlmInputHash(request({ systemPrompt: 'строка 1\r\nстрока 2' }));

    expect(windows).toBe(unix);
  });

  it('порядок ключей в схеме ответа не меняет хэш', () => {
    // Схема собирается из zod-описания; порядок ключей объекта — деталь
    // реализации сборки, а не смысл схемы.
    const direct = vlmInputHash(
      request({
        responseFormat: {
          name: 'n',
          strict: true,
          schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        },
      }),
    );
    const reordered = vlmInputHash(
      request({
        responseFormat: {
          name: 'n',
          strict: true,
          schema: { properties: { a: { type: 'string' } }, type: 'object', required: ['a'] },
        },
      }),
    );

    expect(reordered).toBe(direct);
  });
});

describe('полнота: каждый компонент входа меняет хэш', () => {
  const base = () => vlmInputHash(request());

  it('байты картинки', () => {
    expect(vlmInputHash(request({ images: [{ png: PNG_B }] }))).not.toBe(base());
  });

  it('число и порядок картинок', () => {
    const two = vlmInputHash(request({ images: [{ png: PNG_A }, { png: PNG_B }] }));
    const swapped = vlmInputHash(request({ images: [{ png: PNG_B }, { png: PNG_A }] }));

    expect(two).not.toBe(base());
    expect(swapped).not.toBe(two);
  });

  it('схема ответа', () => {
    expect(
      vlmInputHash(
        request({
          responseFormat: {
            name: 'recognition_block_text',
            strict: true,
            schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
          },
        }),
      ),
    ).not.toBe(base());
  });

  it('порядок элементов МАССИВА в схеме значим (required)', () => {
    const ab = vlmInputHash(
      request({
        responseFormat: { name: 'n', strict: true, schema: { required: ['a', 'b'] } },
      }),
    );
    const ba = vlmInputHash(
      request({
        responseFormat: { name: 'n', strict: true, schema: { required: ['b', 'a'] } },
      }),
    );

    expect(ba).not.toBe(ab);
  });

  it('модель', () => {
    expect(vlmInputHash(request({ model: 'gw/vlm-b' }))).not.toBe(base());
  });

  it('generation-профиль: температура, maxTokens, topK', () => {
    expect(vlmInputHash(request({ temperature: 0.7 }))).not.toBe(base());
    expect(vlmInputHash(request({ maxTokens: 8192 }))).not.toBe(base());
    // «topK не задан» отличим от любого значения, включая ноль.
    expect(vlmInputHash(request({ topK: 1 }))).not.toBe(base());
    expect(vlmInputHash(request({ topK: 0 }))).not.toBe(vlmInputHash(request({ topK: 1 })));
    expect(vlmInputHash(request({ topK: 0 }))).not.toBe(base());
  });

  it('промты, код/версия промта и версия схемы', () => {
    expect(vlmInputHash(request({ systemPrompt: 'другой system' }))).not.toBe(base());
    expect(vlmInputHash(request({ userPrompt: 'другой user' }))).not.toBe(base());
    expect(vlmInputHash(request({ promptCode: 'recognition_block_stamp' }))).not.toBe(base());
    expect(vlmInputHash(request({ promptVersion: 2 }))).not.toBe(base());
    expect(vlmInputHash(request({ schemaVersion: 'recognition_block_text.v2' }))).not.toBe(base());
  });
});

describe('в каноническую строку не попадают байты картинок', () => {
  it('картинка входит хэшем: длина канона не растёт с размером кропа', () => {
    const big = new Uint8Array(256 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47]);

    const canonical = buildVlmCanonicalInput(request({ images: [{ png: big }] }));

    // 64 hex-символа на картинку вместо трети мегабайта base64.
    expect(canonical).toContain('image[0]=');
    expect(canonical.length).toBeLessThan(2_000);
    expect(canonical).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  });
});

describe('canonicalJson', () => {
  it('сортирует ключи рекурсивно и сохраняет порядок массивов', () => {
    expect(canonicalJson({ b: { d: 2, c: 1 }, a: [2, 1] })).toBe('{"a":[2,1],"b":{"c":1,"d":2}}');
  });

  it('опускает undefined-свойства — как JSON.stringify при отправке', () => {
    expect(canonicalJson({ a: 1, skip: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });
});
