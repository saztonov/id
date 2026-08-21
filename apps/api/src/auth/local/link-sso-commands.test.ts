/**
 * Связывание учётных записей перед переходом на SSO.
 *
 * Главное утверждение файла — сохранение `users.id`. Вместе с ним сохраняются
 * роли, назначения на объекты, привязка к подрядчику и все ссылки из документов
 * и журнала. Наивный переход (просто переключить `AUTH_MODE`) завёл бы человеку
 * вторую, беспра́вную учётную запись, и обнаружилось бы это в день перехода.
 *
 * Второе по важности — отказ при неполном соответствии: частично связанная база
 * хуже несвязанной, потому что часть людей войдёт в свои учётные записи, а часть
 * — в пустые новые, и различить это потом нечем.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { applyPlan, buildPlan, readMapping, UsageError } from './link-sso-commands.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OBJECT_ID = '00000000-0000-4000-8000-000000000020';
const LOGIN = 'ivanov@example.ru';
const SUBJECT = '8f0d1c2e-1111-4000-8000-000000000001';

let db: TestDatabase;
let pool: Pool;

async function seedLocalUser(): Promise<void> {
  await db.query(
    `insert into users (id, kc_sub, email, full_name) values ($1, 'local:ivanov', $2, 'Иванов')`,
    [USER_ID, LOGIN],
  );
  await db.query(`insert into user_roles (user_id, role) values ($1, 'manager')`, [USER_ID]);
  await db.query(
    `insert into user_credentials (user_id, login_key, login_display, password_hash, password_algorithm)
     values ($1::uuid, $2, $3, 'scrypt$N=32768,r=8,p=2$c2FsdHNhbHQ$a2V5', 'scrypt')`,
    [USER_ID, LOGIN, LOGIN],
  );
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
    'audit_log',
    'user_object_scopes',
    'user_credentials',
    'user_roles',
    'users',
  ]) {
    await db.query(`delete from ${table}`);
  }
});

describe('чтение файла соответствия', () => {
  async function fileWith(content: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'id-link-sso-'));
    const path = join(dir, 'map.json');
    await writeFile(path, JSON.stringify(content), 'utf8');
    return path;
  }

  it('канонизирует логин', async () => {
    const mapping = await readMapping(
      await fileWith([{ login: ' IVANOV@Example.RU ', subject: SUBJECT }]),
    );

    expect(mapping[0]?.login).toBe(LOGIN);
  });

  it('отвергает местную заглушку вместо субъекта', async () => {
    // 'local:<uuid>' в правой колонке означает, что файл составлен из текущего
    // состояния базы, а не из Keycloak: связывать было бы не с чем.
    await expect(
      readMapping(await fileWith([{ login: LOGIN, subject: 'local:abc' }])),
    ).rejects.toThrow(UsageError);
  });

  it('отвергает файл не того вида', async () => {
    await expect(readMapping(await fileWith({ login: LOGIN }))).rejects.toThrow(UsageError);
    await expect(readMapping(await fileWith([{ login: LOGIN }]))).rejects.toThrow(UsageError);
  });
});

describe('план', () => {
  it('находит локальную учётную запись', async () => {
    await seedLocalUser();

    const plan = await buildPlan(pool, [{ login: LOGIN, subject: SUBJECT }]);

    expect(plan.problems).toEqual([]);
    expect(plan.ready).toEqual([{ entry: { login: LOGIN, subject: SUBJECT }, userId: USER_ID }]);
  });

  it('сообщает об отсутствующей учётной записи', async () => {
    const plan = await buildPlan(pool, [{ login: 'nikogo@example.ru', subject: SUBJECT }]);

    expect(plan.ready).toEqual([]);
    expect(plan.problems.join(' ')).toContain('локальной учётной записи нет');
  });

  it('сообщает о занятом субъекте', async () => {
    await seedLocalUser();
    await db.query(
      `insert into users (kc_sub, email, full_name) values ($1, 'other@example.ru', 'Чужой')`,
      [SUBJECT],
    );

    const plan = await buildPlan(pool, [{ login: LOGIN, subject: SUBJECT }]);

    expect(plan.ready).toEqual([]);
    expect(plan.problems.join(' ')).toContain('уже занят');
  });

  it('сообщает об уже связанной учётной записи', async () => {
    // Учётные данные ещё есть, а kc_sub уже настоящий: так выглядит база после
    // прерванного связывания, и повторный прогон обязан это заметить.
    await seedLocalUser();
    await db.query('update users set kc_sub = $2 where id = $1', [USER_ID, SUBJECT]);

    const plan = await buildPlan(pool, [{ login: LOGIN, subject: SUBJECT }]);

    expect(plan.problems.join(' ')).toContain('уже связана');
  });

  it('сообщает о повторах в файле', async () => {
    await seedLocalUser();

    const plan = await buildPlan(pool, [
      { login: LOGIN, subject: SUBJECT },
      { login: LOGIN, subject: '8f0d1c2e-2222-4000-8000-000000000002' },
    ]);

    expect(plan.problems.join(' ')).toContain('login указан дважды');
  });

  it('сообщает об активной учётной записи, забытой в файле', async () => {
    // После перехода она не сможет войти вовсе. Это не всегда ошибка (уволенные),
    // но узнать об этом надо ДО перехода, а не после.
    await seedLocalUser();

    const plan = await buildPlan(pool, []);

    expect(plan.problems.join(' ')).toContain('отсутствует в файле');
  });

  it('ничего не меняет в базе', async () => {
    await seedLocalUser();

    await buildPlan(pool, [{ login: LOGIN, subject: SUBJECT }]);

    const rows = await db.query<{ kc_sub: string }>('select kc_sub from users');
    expect(rows[0]?.kc_sub).toBe('local:ivanov');
    expect(await db.query('select user_id from user_credentials')).toHaveLength(1);
  });
});

describe('применение', () => {
  it('сохраняет users.id, роли и назначения, снимая локальный пароль', async () => {
    await seedLocalUser();
    await db.query(
      `insert into counterparties (id, name, inn, kpp, ogrn, kind)
       values ('00000000-0000-4000-8000-000000000030', 'ООО «Объект»', '7700123459',
               '770901001', '1027700123450', 'customer')`,
    );
    await db.query(
      `insert into construction_objects (id, code, name, full_name)
       values ($1, 'OBJ01', 'Объект', 'Объект полностью')`,
      [OBJECT_ID],
    );
    await db.query('insert into user_object_scopes (user_id, object_id) values ($1, $2)', [
      USER_ID,
      OBJECT_ID,
    ]);

    const plan = await buildPlan(pool, [{ login: LOGIN, subject: SUBJECT }]);
    const linked = await applyPlan(pool, plan);

    expect(linked).toBe(1);

    const users = await db.query<{ id: string; kc_sub: string }>('select id, kc_sub from users');
    // Тот же идентификатор — значит те же роли, области и вся история действий.
    expect(users[0]?.id).toBe(USER_ID);
    expect(users[0]?.kc_sub).toBe(SUBJECT);

    expect(await db.query('select role from user_roles')).toHaveLength(1);
    expect(await db.query('select object_id from user_object_scopes')).toHaveLength(1);
    // Локальный пароль снят: иначе остался бы второй путь входа мимо Keycloak.
    expect(await db.query('select user_id from user_credentials')).toHaveLength(0);

    const audit = await db.query<{ action: string }>('select action from audit_log');
    expect(audit[0]?.action).toBe('user.sso_linked');
  });

  it('отказывается при неразрешённых проблемах', async () => {
    // Частично связанная база хуже несвязанной.
    await seedLocalUser();
    const plan = await buildPlan(pool, [{ login: 'nikogo@example.ru', subject: SUBJECT }]);

    await expect(applyPlan(pool, plan)).rejects.toThrow(UsageError);

    const rows = await db.query<{ kc_sub: string }>('select kc_sub from users');
    expect(rows[0]?.kc_sub).toBe('local:ivanov');
  });

  it('после связывания локальный пароль завести уже нельзя', async () => {
    // Ограничение миграции 0021: пароль допустим только у локальной учётной
    // записи. Связанная перестаёт быть таковой.
    await seedLocalUser();
    await applyPlan(pool, await buildPlan(pool, [{ login: LOGIN, subject: SUBJECT }]));

    await expect(
      db.query(
        `insert into user_credentials (user_id, login_key, login_display, password_hash, password_algorithm)
         values ($1::uuid, $2, $3, 'scrypt$N=32768,r=8,p=2$c2FsdHNhbHQ$a2V5', 'scrypt')`,
        [USER_ID, LOGIN, LOGIN],
      ),
    ).rejects.toThrow();
  });
});
