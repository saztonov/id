import { describe, expect, it } from 'vitest';

import { ExecSyncNumberError, fixed6, TIE_BREAK } from './fixed6.js';

/**
 * Значения, на которых `toFixed(6)` и `'%.6f'` расходятся.
 *
 * Замерено запуском обоих интерпретаторов, а не взято из документации:
 *
 *   node   -e "console.log((0.0078125).toFixed(6))"  → 0.007813
 *   python -c "print('%.6f' % 0.0078125)"            → 0.007812
 *
 * Это ровно те случаи, ради которых `fixed6` не может быть обёрткой над
 * `toFixed`: одна такая координата в комплекте — и `manifest_sha256` не сойдётся.
 */
const TIE_CASES: readonly { readonly value: number; readonly printf: string }[] = [
  { value: 0.0078125, printf: '0.007812' }, // 1/128 — половина, вниз к чётному
  { value: 0.0390625, printf: '0.039062' }, // 5/128 — половина, вниз к чётному
  { value: 0.0234375, printf: '0.023438' }, // 3/128 — половина, вверх к чётному
];

describe('fixed6: ровно половина округляется как в printf, а не как в toFixed', () => {
  it.each(TIE_CASES)('$value → $printf', ({ value, printf }) => {
    expect(fixed6(value)).toBe(printf);
  });

  it('в двух из трёх случаев ответ ОТЛИЧАЕТСЯ от toFixed — иначе тест ничего не ловит', () => {
    const differing = TIE_CASES.filter(({ value, printf }) => value.toFixed(6) !== printf);
    expect(differing.map((entry) => entry.value)).toEqual([0.0078125, 0.0390625]);
  });

  it('правило округления объявлено половиной к чётному', () => {
    expect(TIE_BREAK).toBe('half_even');
  });
});

describe('fixed6: нули и знак', () => {
  it('минус-ноль печатается без знака (§13, правило 1)', () => {
    expect(fixed6(-0)).toBe('0.000000');
    expect(fixed6(0)).toBe('0.000000');
  });

  it('отрицательное, схлопнувшееся в ноль, тоже теряет знак', () => {
    // `(-1e-9).toFixed(6)` даёт «-0.000000» — ровно то, что §13 запрещает.
    expect(fixed6(-1e-9)).toBe('0.000000');
    expect((-1e-9).toFixed(6)).toBe('-0.000000');
  });

  it('настоящий минус сохраняется', () => {
    expect(fixed6(-0.5)).toBe('-0.500000');
  });
});

describe('fixed6: разрядность', () => {
  it('всегда ровно шесть знаков после точки', () => {
    expect(fixed6(1)).toBe('1.000000');
    expect(fixed6(0)).toBe('0.000000');
    expect(fixed6(0.1)).toBe('0.100000');
  });

  it('седьмой знак отбрасывается округлением, шестой — значим', () => {
    // Пара «должны совпасть» и пара «должны разойтись»: без второй первая
    // доказывала бы только то, что функция возвращает константу.
    expect(fixed6(0.1)).toBe(fixed6(0.1000004));
    expect(fixed6(0.1)).not.toBe(fixed6(0.100001));
  });

  it('целое и дробная запись одного значения неразличимы', () => {
    expect(fixed6(1)).toBe(fixed6(1.0));
  });
});

describe('fixed6: непригодные числа отвергаются', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '%s — отказ, а не «null» как у JSON.stringify',
    (value) => {
      expect(() => fixed6(value)).toThrow(ExecSyncNumberError);
    },
  );
});
