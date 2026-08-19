/**
 * Раскладка ошибок 422 по полям формы (§14, гейт §17).
 *
 * Проверяется главное свойство: ни одно сообщение сервера не исчезает. Оно
 * либо садится на поле, либо возвращается вызывающему для показа отдельно.
 * Молча проглоченное сообщение — это отказ без объяснения, а такой отказ
 * пользователь чинит перебором.
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/problem.js';
import { mapFieldErrors, pointerToPath } from './formErrors.js';

function problem(errors: { pointer: string | null; code: string; message: string }[]): ApiError {
  return new ApiError(
    422,
    {
      type: 'urn:id-portal:problem:validation',
      title: 'Ошибка проверки',
      status: 422,
      detail: 'Профиль ссылается на коды, которых нет в справочниках.',
      errors,
      requestId: 'req-1',
    } as unknown as ConstructorParameters<typeof ApiError>[1],
    'HTTP 422',
  );
}

describe('pointerToPath', () => {
  it('превращает индекс массива в число, а не в строку', () => {
    expect(pointerToPath('/rules/0/severity')).toEqual(['rules', 0, 'severity']);
  });

  it('разворачивает экранирование RFC 6901 в правильном порядке', () => {
    expect(pointerToPath('/a~01b')).toEqual(['a~1b']);
    expect(pointerToPath('/a~1b')).toEqual(['a/b']);
  });

  it('пустой указатель означает тело целиком, а не поле с пустым именем', () => {
    expect(pointerToPath('')).toEqual([]);
    expect(pointerToPath('/')).toEqual([]);
  });
});

describe('mapFieldErrors', () => {
  it('садит сообщение на поле, названное указателем', () => {
    const mapped = mapFieldErrors(
      problem([
        { pointer: '/expectedDocTypes', code: 'unknown-doc-type', message: 'Вида ИД aosr нет' },
      ]),
      [['expectedDocTypes'], ['enabledRuleCodes']],
    );

    expect(mapped.fields).toEqual([{ name: ['expectedDocTypes'], errors: ['Вида ИД aosr нет'] }]);
    expect(mapped.unmatched).toEqual([]);
  });

  it('несколько сообщений об одном поле собираются в одно место', () => {
    const mapped = mapFieldErrors(
      problem([
        { pointer: '/enabledRuleCodes', code: 'unknown-rule', message: 'Правила A нет' },
        { pointer: '/enabledRuleCodes', code: 'unknown-rule', message: 'Правила B нет' },
      ]),
      [['enabledRuleCodes']],
    );

    expect(mapped.fields).toHaveLength(1);
    expect(mapped.fields[0]?.errors).toEqual(['Правила A нет', 'Правила B нет']);
  });

  it('указатель вглубь садится на поле-префикс: форма знает про `rules` целиком', () => {
    const mapped = mapFieldErrors(
      problem([{ pointer: '/rules/3/ruleCode', code: 'unknown-rule', message: 'Правила нет' }]),
      [['rules']],
    );

    expect(mapped.fields[0]?.name).toEqual(['rules']);
  });

  it('сообщение без своего поля не теряется, а возвращается отдельно', () => {
    const mapped = mapFieldErrors(
      problem([
        { pointer: '/to', code: 'section-marker-in-prompt', message: 'Промт называет раздел' },
      ]),
      [['systemPrompt']],
    );

    expect(mapped.fields).toEqual([]);
    expect(mapped.unmatched).toEqual(['Промт называет раздел']);
  });

  it('ошибка не из API не даёт ни полей, ни сообщений', () => {
    const mapped = mapFieldErrors(new Error('сеть отвалилась'), [['code']]);

    expect(mapped).toEqual({ fields: [], unmatched: [] });
  });
});
