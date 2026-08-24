/**
 * Правило сверки версий.
 *
 * Проверяется не столько «разные метки — значит обновиться», сколько обратное:
 * при какой угодно неопределённости плашка НЕ появляется. Ложное предложение
 * перезагрузиться стоит дорого — оно приходит поверх экрана разметки, где у
 * человека несохранённая работа, и приходит ко всем сразу.
 */
import { describe, expect, it } from 'vitest';
import { isOutdatedBuild } from './buildVersion.js';

describe('isOutdatedBuild', () => {
  it('видит выкатку: метки непустые и разные', () => {
    expect(isOutdatedBuild('aaa1111', { buildId: 'bbb2222' })).toBe(true);
  });

  it('молчит, когда вкладка работает на опубликованной сборке', () => {
    expect(isOutdatedBuild('aaa1111', { buildId: 'aaa1111' })).toBe(false);
  });

  it('молчит, когда сборка вкладки не названа', () => {
    // Так выглядит `vite build` без `APP_RELEASE`: сравнивать не с чем.
    expect(isOutdatedBuild(undefined, { buildId: 'bbb2222' })).toBe(false);
    expect(isOutdatedBuild('', { buildId: 'bbb2222' })).toBe(false);
  });

  it('молчит, когда не названа опубликованная сборка', () => {
    expect(isOutdatedBuild('aaa1111', { buildId: '' })).toBe(false);
    expect(isOutdatedBuild('aaa1111', {})).toBe(false);
  });

  it('молчит на ответе неизвестной формы', () => {
    // `version.json` читается с раздачи статики: вместо JSON может прийти
    // страница-заглушка прокси, `null` или массив.
    expect(isOutdatedBuild('aaa1111', null)).toBe(false);
    expect(isOutdatedBuild('aaa1111', '<!doctype html>')).toBe(false);
    expect(isOutdatedBuild('aaa1111', [])).toBe(false);
    expect(isOutdatedBuild('aaa1111', { buildId: 42 })).toBe(false);
  });
});
