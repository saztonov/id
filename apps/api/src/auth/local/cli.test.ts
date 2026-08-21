/**
 * Команда `local-admin` на настоящем PostgreSQL (pglite).
 *
 * Проверяется именно логика, а не запуск процесса: `runCommand()` принимает пул
 * аргументом ровно ради этого. Скрипт, который можно проверить только запуском,
 * на практике не проверяется никогда.
 *
 * Главные утверждения: повторный запуск НЕ меняет пароль существующей учётной
 * записи (иначе команда становится тихим перехватом чужого доступа) и пароль
 * нельзя задать аргументом (иначе он оседает в истории оболочки).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { loadEnv, type Env } from '../../config/env.js';
import { parseArguments, runCommand, UsageError } from './cli-commands.js';
import { findCredentialByLogin } from './credentials.js';
import { verifyPassword } from './passwords.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

const ENV: Env = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'local',
  AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-cli-tests-0123456789ab',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-cli-tests-0123456789ab',
  AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://storage.yandexcloud.net',
  S3_BUCKET: 'id-portal',
  S3_ACCESS_KEY: 'unit-test-access-key-id',
  S3_SECRET_KEY: 'unit-test-access-key-material',
});

const EMAIL = 'admin@example.ru';

let db: TestDatabase;
let pool: Pool;

/** Пароль из напечатанного отчёта: он там единственная строка такого вида. */
function passwordFrom(report: readonly string[]): string {
  const line = report.find((entry) => entry.startsWith('Временный пароль: '));
  if (line === undefined) throw new Error(`в отчёте нет пароля: ${report.join(' | ')}`);
  return line.replace('Временный пароль: ', '');
}

function create(email = EMAIL): ReturnType<typeof runCommand> {
  return runCommand({ command: 'create', email, name: 'Админов Админ' }, ENV, pool);
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  pool = createTestPool(db) as unknown as Pool;
}, 180_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  for (const table of [
    'auth_throttle',
    'audit_log',
    'registration_requests',
    'user_credentials',
    'user_roles',
    'users',
  ]) {
    await db.query(`delete from ${table}`);
  }
});

describe('разбор аргументов', () => {
  it('требует известную команду и адрес', () => {
    expect(() => parseArguments([])).toThrow(UsageError);
    expect(() => parseArguments(['delete', '--email', EMAIL])).toThrow(UsageError);
    expect(() => parseArguments(['create'])).toThrow(UsageError);
  });

  it('отказывается принимать пароль аргументом', () => {
    // Пароль в аргументах оседает в истории оболочки и виден в списке процессов
    // любому пользователю машины.
    expect(() => parseArguments(['create', '--email', EMAIL, '--password', 'hack'])).toThrow(
      /генерируется/u,
    );
  });

  it('разбирает полную команду', () => {
    expect(parseArguments(['create', '--email', EMAIL, '--name', 'Админов Админ'])).toEqual({
      command: 'create',
      email: EMAIL,
      name: 'Админов Админ',
    });
  });
});

describe('create', () => {
  it('заводит активного администратора с временным паролем', async () => {
    const report = await create();
    const password = passwordFrom(report);

    const credential = await findCredentialByLogin(pool, EMAIL);
    expect(credential).not.toBeNull();
    expect(credential?.isActive).toBe(true);
    // Пароль знает оператор машины, а не только владелец: он временный.
    expect(credential?.mustChangePassword).toBe(true);
    await expect(verifyPassword(password, credential?.passwordHash ?? '')).resolves.toBe(true);

    const roles = await db.query<{ role: string }>('select role from user_roles');
    expect(roles.map((row) => row.role)).toEqual(['admin']);
  });

  it('пишет событие в журнал без указания автора', async () => {
    // Действие выполнил оператор машины, а не пользователь портала: приписывать
    // его кому-то из users было бы неправдой.
    await create();

    const rows = await db.query<{ action: string; actor_user_id: string | null }>(
      'select action, actor_user_id from audit_log',
    );
    expect(rows[0]?.action).toBe('auth.bootstrap_admin');
    expect(rows[0]?.actor_user_id).toBeNull();
  });

  it('повторный запуск НЕ меняет пароль существующей учётной записи', async () => {
    // Иначе команда, забытая в скрипте развёртывания, тихо перехватывала бы
    // чужую учётную запись при каждом обновлении.
    const first = passwordFrom(await create());

    await expect(create()).rejects.toThrow(/уже существует/u);

    const credential = await findCredentialByLogin(pool, EMAIL);
    await expect(verifyPassword(first, credential?.passwordHash ?? '')).resolves.toBe(true);
  });

  it('видит совпадение независимо от регистра', async () => {
    await create();

    await expect(create('ADMIN@Example.RU')).rejects.toThrow(/уже существует/u);
  });

  it('отказывается при занятом адресе у другой учётной записи', async () => {
    // Совпадение с федеративным пользователем разрешает человек: догадка здесь
    // стоит чужого доступа.
    await db.query(
      `insert into users (kc_sub, email, full_name)
       values ('8f0d1c2e-0000-4000-8000-000000000001', $1, 'Федеративный')`,
      [EMAIL],
    );

    await expect(create()).rejects.toThrow(/занят/u);
  });

  it('отказывается при нерассмотренной заявке на тот же адрес', async () => {
    await db.query(
      `insert into registration_requests (login_key, login_display, full_name)
       values ($1, $2, 'Заявкин')`,
      [EMAIL, EMAIL],
    );

    await expect(create()).rejects.toThrow(/заявка/u);
  });

  it('требует имя', async () => {
    await expect(
      runCommand({ command: 'create', email: EMAIL, name: null }, ENV, pool),
    ).rejects.toThrow(/--name/u);
  });

  it('не оставляет половины учётной записи при сбое', async () => {
    // Роль вставляется последней; порча CHECK'а на роли роняет транзакцию уже
    // после создания пользователя и учётных данных.
    await db.exec('alter table user_roles drop constraint user_roles_role_chk');
    await db.exec(
      "alter table user_roles add constraint user_roles_role_chk check (role = 'engineer')",
    );

    await expect(create()).rejects.toThrow();

    expect(await db.query('select id from users')).toHaveLength(0);
    expect(await db.query('select user_id from user_credentials')).toHaveLength(0);

    await db.exec('alter table user_roles drop constraint user_roles_role_chk');
    await db.exec(
      'alter table user_roles add constraint user_roles_role_chk ' +
        "check (role in ('contractor', 'engineer', 'manager', 'admin'))",
    );
  });
});

describe('reset', () => {
  it('выдаёт новый пароль и обесценивает прежний', async () => {
    const first = passwordFrom(await create());
    const second = passwordFrom(
      await runCommand({ command: 'reset', email: EMAIL, name: null }, ENV, pool),
    );

    expect(second).not.toBe(first);
    const credential = await findCredentialByLogin(pool, EMAIL);
    await expect(verifyPassword(second, credential?.passwordHash ?? '')).resolves.toBe(true);
    await expect(verifyPassword(first, credential?.passwordHash ?? '')).resolves.toBe(false);
    expect(credential?.mustChangePassword).toBe(true);
  });

  it('отказывается для несуществующей учётной записи', async () => {
    await expect(
      runCommand({ command: 'reset', email: 'nikogo@example.ru', name: null }, ENV, pool),
    ).rejects.toThrow(/не найдена/u);
  });
});

describe('unlock', () => {
  it('снимает блокировку, накопленную перебором', async () => {
    await create();
    const credential = await findCredentialByLogin(pool, EMAIL);
    await db.query(
      `insert into auth_throttle
         (scope, bucket_key, user_id, failed_attempts, window_expires_at, locked_until)
       values ('login', 'key', $1::uuid, 10, now() + interval '1 hour', now() + interval '30 minutes')`,
      [credential?.userId],
    );

    const report = await runCommand({ command: 'unlock', email: EMAIL, name: null }, ENV, pool);

    expect(report.join(' ')).toContain('снята');
    expect(await db.query('select scope from auth_throttle')).toHaveLength(0);
  });

  it('отказывается для несуществующей учётной записи', async () => {
    await expect(
      runCommand({ command: 'unlock', email: 'nikogo@example.ru', name: null }, ENV, pool),
    ).rejects.toThrow(/не найдена/u);
  });
});
