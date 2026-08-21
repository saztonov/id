/**
 * Адрес возврата после входа.
 *
 * Проверка дублирует серверную и, как и та, существует ради одного: параметр
 * `returnTo` не должен превращаться в открытый редирект. Ссылка
 * `/login?returnTo=https://evil.example` увела бы пользователя на чужой сайт
 * сразу после успешного входа — в момент, когда он меньше всего насторожен.
 */
import { describe, expect, it } from 'vitest';

import { safeReturnTo } from './returnTo.js';

/**
 * Управляющие символы собираются из кода, а не пишутся литералом.
 *
 * Литеральный DEL или NUL в исходнике невидим: строка выглядит как обычный путь,
 * и при вычитке проверка читается как «обычный путь отбрасывается» — то есть как
 * ошибка. Через `fromCharCode` видно, что именно проверяется.
 */
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);

describe('safeReturnTo', () => {
  it('пропускает локальный путь как есть', () => {
    expect(safeReturnTo('/objects/42')).toBe('/objects/42');
    expect(safeReturnTo('/objects?tab=files#top')).toBe('/objects?tab=files#top');
  });

  it('отбрасывает абсолютный адрес', () => {
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('http://localhost:3000/objects')).toBe('/');
  });

  it('отбрасывает протокол-относительный адрес', () => {
    // Браузер трактует `//host` как абсолютный адрес с текущей схемой — это тот
    // же открытый редирект, только менее заметный при вычитке.
    expect(safeReturnTo('//evil.example')).toBe('/');
    // Обратные слэши нормализуются в прямые, поэтому `/\host` ведёт себя так же.
    expect(safeReturnTo('/\\evil.example')).toBe('/');
  });

  it('отбрасывает управляющие символы', () => {
    // Ими разрезают заголовки ответа.
    expect(safeReturnTo('/objects\r\nSet-Cookie: a=b')).toBe('/');
    expect(safeReturnTo(`/objects${DEL}`)).toBe('/');
    expect(safeReturnTo(`/objects${NUL}`)).toBe('/');
  });

  it('пробел управляющим символом не считается', () => {
    // Граница проверки: 0x20 допустим, всё ниже — нет. Без этой проверки условие
    // легко «уточнить» до `<= 0x20` и молча сломать обычные адреса.
    expect(safeReturnTo('/objects/имя файла')).toBe('/objects/имя файла');
  });

  it('отсутствующее значение даёт корень', () => {
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
    expect(safeReturnTo('objects')).toBe('/');
  });
});
