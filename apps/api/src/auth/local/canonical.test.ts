/**
 * Канонизация логина и ключи троттлинга.
 *
 * Главное утверждение файла — совпадение двух путей: база находит учётную
 * запись через `citext` без учёта регистра, а ключ подсчёта попыток считается в
 * коде. Если эти два понимания «того же логина» разойдутся, блокировка после
 * десяти неудач обходится нажатием Caps Lock.
 */
import { describe, expect, it } from 'vitest';

import { loadEnv, type Env } from '../../config/env.js';
import { canonicalizeLogin, ipThrottleKey, loginEquals, loginThrottleKey } from './canonical.js';

function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://id_app:local-only-pw@localhost:5432/id',
    AUTH_MODE: 'local',
    AUTH_LOCAL_LOGIN_HMAC_KEY: 'l'.repeat(44),
    AUDIT_HMAC_KEY: 'h'.repeat(44),
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://storage.yandexcloud.net',
    S3_BUCKET: 'id-portal',
    S3_ACCESS_KEY: 'unit-test-access-key-id',
    S3_SECRET_KEY: 'unit-test-access-key-material',
    ...overrides,
  });
}

/** Написания одного и того же адреса, которые citext считает совпадающими. */
const SAME_LOGIN = [
  'user@example.ru',
  'User@Example.ru',
  'USER@EXAMPLE.RU',
  '  user@example.ru  ',
  '\tuser@example.ru\n',
];

describe('канонизация', () => {
  it('сводит регистр и обрамляющие пробелы к одной форме', () => {
    const canonical = SAME_LOGIN.map(canonicalizeLogin);

    expect(new Set(canonical).size, `разошлись: ${canonical.join(' | ')}`).toBe(1);
    expect(canonical[0]).toBe('user@example.ru');
  });

  it('сводит совместимые формы Unicode', () => {
    // Полноширинные латинские буквы визуально отличимы, но пользователь,
    // переключивший раскладку, получил бы вторую учётную запись на тот же адрес.
    expect(canonicalizeLogin('ＵＳＥＲ@example.ru')).toBe('user@example.ru');
    // Составной и разложенный é — один адрес. Литералы визуально неразличимы, и
    // редактор, нормализовавший файл, превратил бы проверку в тавтологию. Именно
    // поэтому первым идёт not.toBe: он падает ровно в этом случае.
    const composed = 'café@example.ru';
    const decomposed = 'café@example.ru';
    expect(composed).not.toBe(decomposed);
    expect(canonicalizeLogin(decomposed)).toBe(canonicalizeLogin(composed));
    expect(canonicalizeLogin(decomposed)).toBe(composed);
  });

  it('не удаляет внутренние пробелы', () => {
    // Адрес с пробелом внутри некорректен. Молча «починить» его значит принять
    // за верный тот логин, которого у пользователя нет.
    expect(canonicalizeLogin('user name@example.ru')).toBe('user name@example.ru');
  });

  it('не портит уже канонический логин', () => {
    expect(canonicalizeLogin('user@example.ru')).toBe('user@example.ru');
  });
});

describe('ключ троттлинга', () => {
  it('одинаков для всех написаний одного логина', () => {
    // Это и есть проверка обхода блокировки сменой регистра: разойдись ключи —
    // каждое написание получило бы собственный счётчик попыток.
    const env = testEnv();
    const keys = SAME_LOGIN.map((login) => loginThrottleKey(env, canonicalizeLogin(login)));

    expect(new Set(keys).size, 'написания одного логина дали разные ключи').toBe(1);
  });

  it('различается у разных логинов', () => {
    const env = testEnv();

    expect(loginThrottleKey(env, 'a@example.ru')).not.toBe(loginThrottleKey(env, 'b@example.ru'));
  });

  it('не содержит самого логина', () => {
    // Строка на каждый перебранный адрес не должна быть строкой ПДн.
    const env = testEnv();
    const key = loginThrottleKey(env, 'ivanov@example.ru');

    expect(key).not.toContain('ivanov');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('зависит от ключа локального входа, а не от ключа журнала', () => {
    // Ротация AUDIT_HMAC_KEY не должна массово снимать блокировки: иначе смена
    // ключа журнала становится способом сбросить защиту от перебора.
    const base = testEnv();
    const otherAudit = testEnv({ AUDIT_HMAC_KEY: 'z'.repeat(44) });
    const otherLogin = testEnv({ AUTH_LOCAL_LOGIN_HMAC_KEY: 'z'.repeat(44) });

    expect(loginThrottleKey(otherAudit, 'a@b.ru')).toBe(loginThrottleKey(base, 'a@b.ru'));
    expect(loginThrottleKey(otherLogin, 'a@b.ru')).not.toBe(loginThrottleKey(base, 'a@b.ru'));
  });

  it('не пересекается с пространством адресов', () => {
    // Иначе логин, совпавший по виду с адресом, делил бы счётчик с этим адресом.
    const env = testEnv();

    expect(loginThrottleKey(env, '10.0.0.1')).not.toBe(ipThrottleKey(env, '10.0.0.1'));
  });

  it('отсутствие адреса даёт общее ведро, а не исключение', () => {
    const env = testEnv();

    expect(ipThrottleKey(env, null)).toBe(ipThrottleKey(env, null));
    expect(ipThrottleKey(env, null)).not.toBe(ipThrottleKey(env, '10.0.0.1'));
  });
});

describe('сравнение логинов', () => {
  it('сравнивает по канонической форме', () => {
    expect(loginEquals('User@Example.ru', ' user@example.ru ')).toBe(true);
    expect(loginEquals('a@example.ru', 'b@example.ru')).toBe(false);
  });

  it('разная длина не совпадает', () => {
    expect(loginEquals('a@example.ru', 'aa@example.ru')).toBe(false);
  });
});
