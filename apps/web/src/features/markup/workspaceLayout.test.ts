/**
 * Разбор сохранённых ширин колонок.
 *
 * Тест существует ради одного класса дефекта: испорченная запись в
 * `localStorage` (чужая версия портала, ручная правка, недописанный JSON) не
 * имеет права сложить экран, потому что починить его пользователь не может
 * ничем, кроме очистки данных сайта.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIZES,
  mergeSizesWithoutText,
  normalizeColumnSizes,
  pixelsToPercent,
  sizesWithoutText,
} from './workspaceLayout.js';

describe('normalizeColumnSizes', () => {
  it('принимает тройку и нормирует сумму к 100', () => {
    expect(normalizeColumnSizes([1, 1, 1])).toEqual([100 / 3, 100 / 3, 100 / 3]);
    const scaled = normalizeColumnSizes([150, 500, 350]);
    expect(scaled?.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
  });

  it('отвергает всё, из чего нельзя собрать три доли', () => {
    expect(normalizeColumnSizes([50, 50])).toBeNull();
    expect(normalizeColumnSizes([25, 25, 25, 25])).toBeNull();
    expect(normalizeColumnSizes([Number.NaN, 1, 1])).toBeNull();
    expect(normalizeColumnSizes([Number.POSITIVE_INFINITY, 1, 1])).toBeNull();
    expect(normalizeColumnSizes([-1, 1, 1])).toBeNull();
    expect(normalizeColumnSizes([0, 0, 0])).toBeNull();
    expect(normalizeColumnSizes('15,50,35')).toBeNull();
    expect(normalizeColumnSizes(null)).toBeNull();
    expect(normalizeColumnSizes({ 0: 33, 1: 33, 2: 34 })).toBeNull();
  });

  /*
    Колонок стало три, и запись прежней раскладки обязана отвергаться, а не
    молча съезжать. Ключ `localStorage` при этом версионирован, то есть до
    разбора четвёрка вообще не доходит, — но проверка длины остаётся последним
    рубежом на случай, если ключ забудут поднять в следующий раз.
  */
  it('сохранённая четвёрка от прежней раскладки не принимается', () => {
    expect(normalizeColumnSizes([15, 45, 22, 18])).toBeNull();
  });

  it('умолчание само проходит проверку — иначе оно было бы ловушкой', () => {
    expect(normalizeColumnSizes([...DEFAULT_SIZES])).toEqual([...DEFAULT_SIZES]);
  });
});

describe('pixelsToPercent', () => {
  it('пиксели любой ширины дают сумму 100', () => {
    const sizes = pixelsToPercent([240, 800, 560]);
    expect(sizes?.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
    expect(sizes?.[0]).toBeCloseTo(15, 6);
  });

  it('пустой массив — это не раскладка', () => {
    expect(pixelsToPercent([])).toBeNull();
  });
});

describe('свёртывание колонки текста', () => {
  it('две доли без текста дают сумму 100', () => {
    const two = sizesWithoutText(DEFAULT_SIZES);
    expect(two.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
  });

  it('круговой прогон сохраняет долю текста', () => {
    const two = sizesWithoutText(DEFAULT_SIZES);
    const back = mergeSizesWithoutText(DEFAULT_SIZES, two);
    expect(back?.[2]).toBeCloseTo(DEFAULT_SIZES[2], 6);
    expect(back?.[0]).toBeCloseTo(DEFAULT_SIZES[0], 6);
    expect(back?.[1]).toBeCloseTo(DEFAULT_SIZES[1], 6);
  });

  it('изменённые в свёрнутом виде доли переносятся пропорционально', () => {
    const back = mergeSizesWithoutText(DEFAULT_SIZES, [20, 80]);
    expect(back?.[2]).toBeCloseTo(DEFAULT_SIZES[2], 6);
    expect(back?.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
    expect(back?.[1]).toBeGreaterThan(back?.[0] ?? 0);
  });

  it('мусор в двух долях не превращается в раскладку', () => {
    expect(mergeSizesWithoutText(DEFAULT_SIZES, [0, 0])).toBeNull();
    expect(mergeSizesWithoutText(DEFAULT_SIZES, [Number.NaN, 1])).toBeNull();
  });
});
