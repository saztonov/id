/**
 * Канонизация промта, ключ кэша и вытеснение (§8.2).
 *
 * Главная проверка — полнота ключа: §8.2 перечисляет ПЯТЬ составляющих (полный
 * эффективный промт, модель, провайдер, соседний контекст, версия схемы), и
 * каждая проверяется отдельно. Забытая составляющая не ломает ни один сценарий
 * сразу — она проявляется тем, что после смены модели или версии схемы вызов
 * получает ответ, записанный для другой конфигурации, и выглядит это как
 * «модель вдруг стала хуже».
 */
import { describe, expect, it } from 'vitest';

import type { LlmRequest } from './port.js';
import { LruCache, buildEffectivePrompt, cacheKey, promptHash, responseHash } from './prompt.js';

const BASE: LlmRequest = {
  stage: 'page_classify',
  promptCode: 'page_classify_open_world',
  promptVersion: 3,
  systemPrompt: 'Ты классифицируешь страницы исполнительной документации.',
  userPrompt: 'АКТ\nосвидетельствования скрытых работ',
  schemaVersion: 'page_classify.v1',
  cacheContext: 'prev=U;next=I-DOC',
  model: 'gw/model-a',
};

function keyOf(
  overrides: Partial<LlmRequest> = {},
  provider: 'proxy_llm' | 'recorded' = 'proxy_llm',
) {
  const request = { ...BASE, ...overrides };
  const effective = buildEffectivePrompt(request);
  return cacheKey({ effective, model: request.model ?? '', provider });
}

describe('buildEffectivePrompt', () => {
  it('детерминирован и не зависит от вида перевода строки', () => {
    const lf = buildEffectivePrompt({ ...BASE, userPrompt: 'первая\nвторая' });
    const crlf = buildEffectivePrompt({ ...BASE, userPrompt: 'первая\r\nвторая' });
    const cr = buildEffectivePrompt({ ...BASE, userPrompt: 'первая\rвторая' });

    expect(crlf).toBe(lf);
    expect(cr).toBe(lf);
    // Повторный вызов на тех же данных обязан дать ту же строку: иначе хэш
    // промта перестаёт быть доказательством «этот ответ получен этим промтом».
    expect(buildEffectivePrompt(BASE)).toBe(buildEffectivePrompt({ ...BASE }));
  });

  it('содержит все части вызова', () => {
    const effective = buildEffectivePrompt(BASE);

    expect(effective).toContain('stage=page_classify');
    expect(effective).toContain('prompt=page_classify_open_world@3');
    expect(effective).toContain('schema=page_classify.v1');
    expect(effective).toContain('model=gw/model-a');
    expect(effective).toContain(BASE.systemPrompt);
    expect(effective).toContain(BASE.userPrompt);
    expect(effective).toContain(BASE.cacheContext);
  });

  it('перенос текста между частями меняет промт, хотя склейка та же', () => {
    // Без длин в заголовке эти два вызова дали бы БАЙТ В БАЙТ одну строку:
    // разделитель — обычный текст, и границу частей он один не задаёт.
    const left = buildEffectivePrompt({ ...BASE, userPrompt: 'AB', cacheContext: 'C' });
    const right = buildEffectivePrompt({ ...BASE, userPrompt: 'A', cacheContext: 'BC' });

    expect(left).not.toBe(right);
  });

  it('отсутствие модели — это пустое поле, а не пропуск строки', () => {
    const withoutModel = buildEffectivePrompt({ ...BASE, model: undefined });

    expect(withoutModel).toContain('model=\n');
    expect(withoutModel).not.toBe(buildEffectivePrompt(BASE));
  });
});

describe('promptHash и responseHash', () => {
  it('дают sha256 в hex', () => {
    expect(promptHash(buildEffectivePrompt(BASE))).toMatch(/^[0-9a-f]{64}$/);
    expect(responseHash('{"label":"B-DOC"}')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cacheKey: каждая из пяти составляющих §8.2 меняет ключ', () => {
  const base = keyOf();

  it('1. промт (системная часть)', () => {
    expect(keyOf({ systemPrompt: `${BASE.systemPrompt} ` })).not.toBe(base);
  });

  it('1. промт (пользовательская часть)', () => {
    expect(keyOf({ userPrompt: 'ПАСПОРТ КАЧЕСТВА' })).not.toBe(base);
  });

  it('2. модель', () => {
    expect(keyOf({ model: 'gw/model-b' })).not.toBe(base);
  });

  it('3. провайдер', () => {
    expect(keyOf({}, 'recorded')).not.toBe(base);
  });

  it('4. соседний контекст', () => {
    expect(keyOf({ cacheContext: 'prev=B-DOC;next=U' })).not.toBe(base);
  });

  it('5. версия схемы ответа', () => {
    expect(keyOf({ schemaVersion: 'page_classify.v2' })).not.toBe(base);
  });

  it('код и версия промта тоже входят в ключ', () => {
    expect(keyOf({ promptVersion: 4 })).not.toBe(base);
    expect(keyOf({ promptCode: 'page_classify_other' })).not.toBe(base);
  });

  it('стадия входит в ключ', () => {
    expect(keyOf({ stage: 'doc_split' })).not.toBe(base);
  });

  it('идентичный вызов даёт тот же ключ', () => {
    expect(keyOf()).toBe(base);
  });
});

describe('LruCache', () => {
  it('вытесняет самую давнюю запись по потолку', () => {
    const cache = new LruCache<string>({ maxEntries: 2, ttlMs: 1000, now: () => 0 });
    cache.set('a', '1');
    cache.set('b', '2');
    // Обращение к «a» делает её свежей — вытеснена должна быть «b».
    expect(cache.get('a')).toBe('1');
    cache.set('c', '3');

    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
  });

  it('запись протухает по TTL', () => {
    let now = 0;
    const cache = new LruCache<string>({ maxEntries: 10, ttlMs: 100, now: () => now });
    cache.set('k', 'v');

    now = 99;
    expect(cache.get('k')).toBe('v');
    now = 100;
    // Без TTL опубликованная новая версия промта не вытеснила бы ответы старой.
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
