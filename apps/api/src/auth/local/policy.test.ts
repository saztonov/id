/**
 * Политика пароля.
 *
 * Проверяется и то, что политика отвергает, и то, что она ПРОПУСКАЕТ: политика,
 * отвергающая всё, формально безупречна и практически заставляет пользователя
 * записать пароль на бумаге.
 */
import { describe, expect, it } from 'vitest';

import { loadEnv, type Env } from '../../config/env.js';
import { COMMON_PASSWORD_COUNT } from './common-passwords.js';
import {
  checkPasswordPolicy,
  matchesLogin,
  passwordLength,
  type PasswordContext,
} from './policy.js';

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

const NO_CONTEXT: PasswordContext = {
  login: null,
  email: null,
  fullName: null,
  organizationName: null,
};

const IVANOV: PasswordContext = {
  login: 'ivanov@stroymontazh.ru',
  email: 'ivanov@stroymontazh.ru',
  fullName: 'Иванов Иван Иванович',
  organizationName: 'СтройМонтаж',
};

function codes(
  password: string,
  context: PasswordContext = NO_CONTEXT,
  env: Env = testEnv(),
): string[] {
  return checkPasswordPolicy(password, context, env).map((violation) => violation.code);
}

describe('длина', () => {
  it('считается в code points, а не в единицах UTF-16', () => {
    // '🔒'.length === 2. Без счёта по code points пароль из эмодзи набирал бы
    // порог вдвое дешевле честного текста.
    expect(passwordLength('🔒🔒🔒')).toBe(3);
    expect('🔒🔒🔒'.length).toBe(6);
    expect(codes('🔒🔒🔒🔒🔒🔒')).toContain('too-short');
  });

  it('отвергает короткий и не жалуется на длинный до предела', () => {
    expect(codes('Kr4tk0!')).toContain('too-short');
    expect(codes('A1b!'.repeat(32))).not.toContain('too-long');
    expect(codes('A1b!'.repeat(33))).toContain('too-long');
  });

  it('короткий пароль не заваливает пользователя списком претензий', () => {
    // Три жалобы на «12345» ничего не уточняют: пароль всё равно отвергнут.
    expect(codes('12345')).toEqual(['too-short']);
  });

  it('границы берутся из конфигурации', () => {
    const strict = testEnv({ AUTH_LOCAL_PASSWORD_MIN_LENGTH: '20' });

    expect(codes('Korotkiy-Parol-42', NO_CONTEXT, strict)).toContain('too-short');
    expect(codes('Ochen-Dlinnyy-Parol-Portala-42', NO_CONTEXT, strict)).not.toContain('too-short');
  });
});

describe('разнообразие символов', () => {
  it('требует три класса от пароля короче шестнадцати символов', () => {
    expect(codes('prostoparolik')).toContain('too-simple');
    expect(codes('Prostoparolik1')).not.toContain('too-simple');
  });

  it('длинной парольной фразе классы не нужны', () => {
    // Требовать спецсимвол от фразы в двадцать букв значит выгонять
    // пользователя к «Passw0rd!», который слабее.
    expect(codes('корова летит через реку молча')).not.toContain('too-simple');
  });

  it('отвергает повторы одного символа и повторённый кусок', () => {
    expect(codes('aaaaaaaaaaaaaaaa')).toContain('repetitive');
    expect(codes('abcabcabcabcabca')).toContain('repetitive');
    expect(codes('Nepovtoryaemyy-42!')).not.toContain('repetitive');
  });
});

describe('распространённые пароли', () => {
  it('список не пуст и не выродился при правке', () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThan(100);
  });

  it('ловит основу с хвостом из цифр и знаков', () => {
    for (const password of [
      'Password2024!',
      'password123456',
      'Administrator1!',
      'МойПароль2020',
    ]) {
      expect(codes(password), password).toContain('common');
    }
  });

  it('ловит русскую раскладку', () => {
    // Такого нет ни в одном англоязычном топ-листе, а набирают постоянно.
    for (const password of ['Ghbdtn12345!', 'Gfhjkm-2024!']) {
      expect(codes(password), password).toContain('common');
    }
  });

  it('ловит подмену букв цифрами', () => {
    expect(codes('P@ssw0rd12345')).toContain('common');
  });

  it('ловит основу вхождением, а не только целиком', () => {
    // «Sh1frovanie+Portala» содержит имя самого портала — ровно тот пароль,
    // который придумывает уставший администратор.
    expect(codes('Sh1frovanie+Portala')).toContain('common');
  });

  it('не считает распространённым осмысленный длинный пароль', () => {
    expect(codes('Мостовой-Кран-77!')).not.toContain('common');
    expect(codes('Sh1frovanie+Kryshi')).not.toContain('common');
  });
});

describe('предсказуемые последовательности', () => {
  it('ловит прогулку по клавиатуре в обеих раскладках', () => {
    expect(codes('Qwertyui-99!')).toContain('keyboard-walk');
    expect(codes('Йцукенгш-99!')).toContain('keyboard-walk');
    // И в обратную сторону.
    expect(codes('Poiuytre-99!')).toContain('keyboard-walk');
  });

  it('ловит подряд идущие символы', () => {
    expect(codes('Abcdefgh-99!')).toContain('sequence');
    expect(codes('Parol-123456!')).toContain('sequence');
    expect(codes('Parol-1357-9!')).not.toContain('sequence');
  });
});

describe('связь с личными данными', () => {
  it('отвергает пароль с адресом, локальной частью, ФИО или организацией', () => {
    for (const password of [
      'Ivanov-Parol-42!',
      'ivanov@stroymontazh.ru1',
      'Stroymontazh-2024!',
      'Иванович-Парол-4!',
    ]) {
      expect(codes(password, IVANOV), password).toContain('contains-personal-data');
    }
  });

  it('видит личные данные сквозь разделители и подмены цифрами', () => {
    // Ровно эти написания и придумывает человек, обойдённый наивной проверкой.
    expect(codes('1v4nov-Parol-42!', IVANOV)).toContain('contains-personal-data');
    expect(codes('I.v.a.n.o.v-42!', IVANOV)).toContain('contains-personal-data');
  });

  it('не придирается к короткому совпадению внутри длинной фразы', () => {
    // Слова короче четырёх букв встречаются где угодно; отвергать по ним значит
    // отвергать случайно.
    const context: PasswordContext = { ...IVANOV, fullName: 'Ли Ян Мин' };

    expect(codes('Мостовой-Кран-77!', context)).not.toContain('contains-personal-data');
  });

  it('без контекста претензий по личным данным не возникает', () => {
    expect(codes('Мостовой-Кран-77!')).not.toContain('contains-personal-data');
  });
});

describe('приемлемые пароли', () => {
  it('проходят без единого нарушения', () => {
    for (const password of [
      'Мостовой-Кран-77!',
      'Sh1frovanie+Kryshi',
      'три бетонных сваи у реки',
      'Xk29-Vbn41-Qpz73',
    ]) {
      expect(checkPasswordPolicy(password, IVANOV, testEnv()), password).toEqual([]);
    }
  });
});

describe('совпадение с логином', () => {
  it('видит совпадение сквозь регистр, разделители и подмены', () => {
    expect(matchesLogin('IVANOV@stroymontazh.ru', 'ivanov@stroymontazh.ru')).toBe(true);
    expect(matchesLogin('1v4nov@stroymontazh.ru', 'ivanov@stroymontazh.ru')).toBe(true);
    expect(matchesLogin('Мостовой-Кран-77!', 'ivanov@stroymontazh.ru')).toBe(false);
  });
});
