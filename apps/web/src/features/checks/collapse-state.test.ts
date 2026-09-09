/**
 * Свёрнутые блоки вкладки «Проверка» (S59): разбор записи хранилища и
 * переключение ключей — то, что ломается тихо.
 */
import { describe, expect, it } from 'vitest';
import {
  collapsedStorageKey,
  parseCollapsedKeys,
  serializeCollapsedKeys,
  toggleCollapsedKey,
} from './collapse-state.js';

describe('parseCollapsedKeys', () => {
  it('читает то, что записал serializeCollapsedKeys', () => {
    const keys = ['group:c1', 'group:c1:act'];
    expect(parseCollapsedKeys(serializeCollapsedKeys(keys))).toEqual(keys);
  });

  it('пустая, отсутствующая и испорченная запись — ничего не свёрнуто', () => {
    // Испорченная запись не вправе ни ронять экран, ни сворачивать всё подряд.
    expect(parseCollapsedKeys(null)).toEqual([]);
    expect(parseCollapsedKeys('')).toEqual([]);
    expect(parseCollapsedKeys('{not json')).toEqual([]);
    expect(parseCollapsedKeys('{"a":1}')).toEqual([]);
  });

  it('чужие элементы массива отбрасываются, строки остаются', () => {
    expect(parseCollapsedKeys('["group:c1", 5, null, "x"]')).toEqual(['group:c1', 'x']);
  });
});

describe('toggleCollapsedKey', () => {
  it('сворачивает развёрнутое и разворачивает свёрнутое', () => {
    const once = toggleCollapsedKey([], 'a');
    expect(once).toEqual(['a']);
    expect(toggleCollapsedKey(once, 'a')).toEqual([]);
  });

  it('не трогает соседние ключи и не меняет исходный список', () => {
    const keys = ['a', 'b'];
    expect(toggleCollapsedKey(keys, 'b')).toEqual(['a']);
    expect(keys).toEqual(['a', 'b']);
  });
});

describe('collapsedStorageKey', () => {
  it('ключ хранилища свой на каждую папку', () => {
    expect(collapsedStorageKey('f1')).not.toBe(collapsedStorageKey('f2'));
    expect(collapsedStorageKey('f1')).toContain('f1');
  });
});
