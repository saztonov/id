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
  it('принимает четвёрку и нормирует сумму к 100', () => {
    expect(normalizeColumnSizes([1, 1, 1, 1])).toEqual([25, 25, 25, 25]);
    const scaled = normalizeColumnSizes([150, 450, 220, 180]);
    expect(scaled?.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
  });

  it('отвергает всё, из чего нельзя собрать четыре доли', () => {
    expect(normalizeColumnSizes([25, 25, 50])).toBeNull();
    expect(normalizeColumnSizes([20, 20, 20, 20, 20])).toBeNull();
    expect(normalizeColumnSizes([Number.NaN, 1, 1, 1])).toBeNull();
    expect(normalizeColumnSizes([Number.POSITIVE_INFINITY, 1, 1, 1])).toBeNull();
    expect(normalizeColumnSizes([-1, 1, 1, 1])).toBeNull();
    expect(normalizeColumnSizes([0, 0, 0, 0])).toBeNull();
    expect(normalizeColumnSizes('15,45,22,18')).toBeNull();
    expect(normalizeColumnSizes(null)).toBeNull();
    expect(normalizeColumnSizes({ 0: 25, 1: 25, 2: 25, 3: 25 })).toBeNull();
  });

  it('умолчание само проходит проверку — иначе оно было бы ловушкой', () => {
    expect(normalizeColumnSizes([...DEFAULT_SIZES])).toEqual([...DEFAULT_SIZES]);
  });
});

describe('pixelsToPercent', () => {
  it('пиксели любой ширины дают сумму 100', () => {
    const sizes = pixelsToPercent([240, 720, 352, 288]);
    expect(sizes?.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
    expect(sizes?.[0]).toBeCloseTo(15, 6);
  });

  it('пустой массив — это не раскладка', () => {
    expect(pixelsToPercent([])).toBeNull();
  });
});

describe('свёртывание колонки текста', () => {
  it('три доли без текста дают сумму 100', () => {
    const three = sizesWithoutText(DEFAULT_SIZES);
    expect(three.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
  });

  it('круговой прогон сохраняет долю текста', () => {
    const three = sizesWithoutText(DEFAULT_SIZES);
    const back = mergeSizesWithoutText(DEFAULT_SIZES, three);
    expect(back?.[2]).toBeCloseTo(DEFAULT_SIZES[2], 6);
    expect(back?.[0]).toBeCloseTo(DEFAULT_SIZES[0], 6);
    expect(back?.[3]).toBeCloseTo(DEFAULT_SIZES[3], 6);
  });

  it('изменённые в свёрнутом виде доли переносятся пропорционально', () => {
    const back = mergeSizesWithoutText(DEFAULT_SIZES, [10, 70, 20]);
    expect(back?.[2]).toBeCloseTo(DEFAULT_SIZES[2], 6);
    expect(back?.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
    expect(back?.[1]).toBeGreaterThan(back?.[0] ?? 0);
  });

  it('мусор в трёх долях не превращается в раскладку', () => {
    expect(mergeSizesWithoutText(DEFAULT_SIZES, [0, 0, 0])).toBeNull();
    expect(mergeSizesWithoutText(DEFAULT_SIZES, [Number.NaN, 1, 1])).toBeNull();
  });
});
