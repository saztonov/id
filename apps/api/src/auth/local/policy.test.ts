/**
 * Политика пароля.
 *
 * Требование одно — минимальная длина. Проверяется и то, что политика
 * отвергает, и то, что она ПРОПУСКАЕТ: список принимаемых паролей нужен, чтобы
 * снятые проверки сложности не вернулись незаметно.
 */
import { describe, expect, it } from 'vitest';

import { loadEnv, type Env } from '../../config/env.js';
import { checkPasswordPolicy, passwordLength } from './policy.js';

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

function codes(password: string, env: Env = testEnv()): string[] {
  return checkPasswordPolicy(password, env).map((violation) => violation.code);
}

describe('длина', () => {
  it('считается в code points, а не в единицах UTF-16', () => {
    // '🔒'.length === 2. Без счёта по code points пароль из эмодзи набирал бы
    // порог вдвое дешевле честного текста.
    expect(passwordLength('🔒🔒🔒')).toBe(3);
    expect('🔒🔒🔒'.length).toBe(6);
    expect(codes('🔒🔒🔒🔒🔒🔒')).toContain('too-short');
    expect(codes('🔒🔒🔒🔒🔒🔒🔒🔒')).toEqual([]);
  });

  it('отвергает короткий и не жалуется на длинный до предела', () => {
    expect(codes('Kr4tk0!')).toEqual(['too-short']);
    expect(codes('A1b!'.repeat(32))).not.toContain('too-long');
    expect(codes('A1b!'.repeat(33))).toContain('too-long');
  });

  it('границы берутся из конфигурации', () => {
    const strict = testEnv({ AUTH_LOCAL_PASSWORD_MIN_LENGTH: '20' });

    expect(codes('Korotkiy-Parol-42', strict)).toContain('too-short');
    expect(codes('Ochen-Dlinnyy-Parol-Portala-42', strict)).not.toContain('too-short');
  });
});

describe('приемлемые пароли', () => {
  it('пропускают всё, что набрано восемью символами', () => {
    // Ровно те пароли, которые отвергала прежняя политика сложности. Список
    // существует, чтобы её возвращение не прошло незамеченным.
    for (const password of [
      '12345678',
      'password',
      'qwertyui',
      'qwedcxz1@',
      'aaaaaaaa',
      'Иванов Иван Иванович',
      '        ',
    ]) {
      expect(checkPasswordPolicy(password, testEnv()), password).toEqual([]);
    }
  });
});
