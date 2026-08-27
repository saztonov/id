/**
 * Превращение области видимости в SQL — на настоящей PostgreSQL (§4.1, §1.6).
 *
 * Тест намеренно не подменяет БД: проверять построитель условий его же
 * сериализацией бессмысленно, потому что интересует не текст, а число строк,
 * которое вернёт база. Пустой `IN ()`, `AND` с неверным приоритетом и потерянное
 * условие видны только на данных.
 *
 * Фикстура перекрёстная, и это существенно: у подрядчика А есть комплект на
 * объекте Б, а у объекта Б есть комплект подрядчика Б. На однородных данных
 * («каждому подрядчику свой объект») фильтр по объекту и фильтр по подрядчику
 * дают одинаковый результат, и подмена одного другим прошла бы незамеченной.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asc, eq, type SQL } from 'drizzle-orm';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { submissionRevisions, works } from '@id/db';

import type { AuthScope } from '../auth/scope.js';
import { scopeWhere, withScope, type ScopeTarget } from './scoped.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

/** Различимые uuid: в сообщении о падении видно, какая строка просочилась. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const USER = id(1);
const CONTRACTOR_A = id(2);
const CONTRACTOR_B = id(3);
const OBJECT_A = id(4);
const OBJECT_B = id(5);

/** Комплект подрядчика А на объекте А. */
const WORK_A_ON_A = id(10);
/** Комплект того же подрядчика А, но на объекте Б. */
const WORK_A_ON_B = id(11);
/** Комплект подрядчика Б на объекте Б: тот же объект, другая организация. */
const WORK_B_ON_B = id(12);

const REVISION_A_ON_A = id(13);
const REVISION_A_ON_B = id(14);
const REVISION_B_ON_B = id(15);

const ALL_WORKS = [WORK_A_ON_A, WORK_A_ON_B, WORK_B_ON_B];

const TITLE_B_ON_B = 'Кровля автостоянки, подрядчик Б';

const FIXTURE: readonly string[] = [
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER}', 'kc-scoped-test', 'Автор комплектов')`,
  `INSERT INTO counterparties (id, name, inn, kpp, ogrn, kind)
     VALUES ('${CONTRACTOR_A}', 'ООО «Подрядчик А»', '7700123459', '770901001',
             '1027700123450', 'contractor')`,
  `INSERT INTO counterparties (id, name, inn, kpp, ogrn, kind)
     VALUES ('${CONTRACTOR_B}', 'ООО «Подрядчик Б»', '7700123460', '770901002',
             '1027700123451', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'OBJ0A', 'Объект А', 'ЖК «Тест», корпус А')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_B}', 'OBJ0B', 'Объект Б', 'ЖК «Тест», корпус Б')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_A}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_B}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_A}', '${CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_A_ON_A}', '${OBJECT_A}', '${CONTRACTOR_A}', '${CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Кровля автостоянки, подрядчик А', '${USER}')`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_B}', '${CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_A_ON_B}', '${OBJECT_B}', '${CONTRACTOR_A}', '${CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Кровля корпуса Б, подрядчик А', '${USER}')`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_B}', '${CONTRACTOR_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${WORK_B_ON_B}', '${OBJECT_B}', '${CONTRACTOR_B}', '${CONTRACTOR_B}', 'roofing', DATE '2026-01-01', '${TITLE_B_ON_B}', '${USER}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_A_ON_A}', '${WORK_A_ON_A}', '${OBJECT_A}', '${CONTRACTOR_A}', 1)`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_A_ON_B}', '${WORK_A_ON_B}', '${OBJECT_B}', '${CONTRACTOR_A}', 1)`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_B_ON_B}', '${WORK_B_ON_B}', '${OBJECT_B}', '${CONTRACTOR_B}', 1)`,
];

const WORK_SCOPE: ScopeTarget = {
  objectId: works.objectId,
  contractorId: works.contractorId,
};

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

const CONTRACTOR_A_SCOPE: AuthScope = {
  kind: 'contractor',
  userId: USER,
  contractorId: CONTRACTOR_A,
};
const CONTRACTOR_B_SCOPE: AuthScope = {
  kind: 'contractor',
  userId: USER,
  contractorId: CONTRACTOR_B,
};
const ENGINEER_SCOPE: AuthScope = { kind: 'engineer', userId: USER };
const GENERAL_CONTRACTOR_SCOPE: AuthScope = {
  kind: 'general_contractor',
  userId: USER,
  contractorId: CONTRACTOR_A,
};
const MANAGER_SCOPE: AuthScope = { kind: 'manager', userId: USER };
const ADMIN_SCOPE: AuthScope = { kind: 'admin', userId: USER };

let db: TestDatabase;

beforeAll(async () => {
  db = await createPgliteDatabase();

  // exec, а не query: тело миграции многооператорное, и расширенный протокол
  // его не принимает.
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  for (const statement of FIXTURE) {
    await db.query(statement);
  }
}, 180_000);

afterAll(async () => {
  await db.close();
});

/** Идентификаторы комплектов, которые вернёт база при заданном условии. */
async function workIds(where: SQL): Promise<string[]> {
  const query = new QueryBuilder()
    .select({ id: works.id })
    .from(works)
    .where(where)
    // Номера у комплекта нет: порядок в реестре присваивает реестр. Сортировка
    // по идентификатору даёт тот же устойчивый порядок, что и прежний номер.
    .orderBy(asc(works.id))
    .toSQL();

  const rows = await db.query<{ id: string }>(query.sql, [...query.params]);
  return rows.map((row) => row.id);
}

async function revisionIds(where: SQL): Promise<string[]> {
  const query = new QueryBuilder()
    .select({ id: submissionRevisions.id })
    .from(submissionRevisions)
    .where(where)
    .orderBy(asc(submissionRevisions.id))
    .toSQL();

  const rows = await db.query<{ id: string }>(query.sql, [...query.params]);
  return rows.map((row) => row.id);
}

describe('scopeWhere на настоящей БД', () => {
  it('фикстура содержит три поставки: иначе изоляции нечего проверять', async () => {
    expect(await workIds(scopeWhere(ADMIN_SCOPE, WORK_SCOPE))).toEqual(ALL_WORKS);
  });

  it('подрядчик А видит только свои поставки, включая чужой объект', async () => {
    expect(await workIds(scopeWhere(CONTRACTOR_A_SCOPE, WORK_SCOPE))).toEqual([
      WORK_A_ON_A,
      WORK_A_ON_B,
    ]);
  });

  it('подрядчик Б не видит поставок подрядчика А на общем объекте', async () => {
    expect(await workIds(scopeWhere(CONTRACTOR_B_SCOPE, WORK_SCOPE))).toEqual([WORK_B_ON_B]);
  });

  it.each([
    ['engineer', ENGINEER_SCOPE],
    ['general_contractor', GENERAL_CONTRACTOR_SCOPE],
    ['manager', MANAGER_SCOPE],
    ['admin', ADMIN_SCOPE],
  ] as const)('%s видит все поставки на обоих объектах', async (_kind, scope) => {
    // Утверждение про инженера прежде было обратным: он видел строки только
    // назначенных объектов. Деления стройки на объекты больше нет (S37), и
    // теперь этот набор сторожит обратное — что ограничение не вернулось молча.
    //
    // Генподрядчик здесь важен отдельно: у его области есть `contractorId`, и
    // фильтр по нему оставил бы ему одну строку из трёх. Он отвечает на «от
    // чьего имени», а не на «что видно».
    expect(await workIds(scopeWhere(scope, WORK_SCOPE))).toEqual(ALL_WORKS);
  });

  it('применяется к любой таблице с колонками области', async () => {
    expect(await revisionIds(scopeWhere(CONTRACTOR_A_SCOPE, REVISION_SCOPE))).toEqual([
      REVISION_A_ON_A,
      REVISION_A_ON_B,
    ]);
  });

  it('область без ограничения даёт TRUE, а не пустое условие', () => {
    // Условие обязано быть выражением, а не `undefined`: необязательное
    // условие пришлось бы проверять на каждом вызове, и пропущенная проверка
    // означала бы выборку без ограничения там, где оно есть.
    const rendered = new PgDialect().sqlToQuery(scopeWhere(ENGINEER_SCOPE, WORK_SCOPE));
    expect(rendered.sql).toBe('true');
    expect(rendered.sql).not.toContain('in (');
  });

  it('значение области уходит параметром, а не текстом запроса', () => {
    // Интерполяция значения в SQL — это и инъекция, и потеря плана запроса;
    // проверяется здесь, потому что на выборке результат был бы тот же.
    const rendered = new PgDialect().sqlToQuery(scopeWhere(CONTRACTOR_A_SCOPE, WORK_SCOPE));
    expect(rendered.params).toContain(CONTRACTOR_A);
    expect(rendered.sql).not.toContain(CONTRACTOR_A);
  });
});

describe('withScope: область плюс прикладное условие', () => {
  it('сужает область прикладным условием', async () => {
    expect(
      await workIds(withScope(MANAGER_SCOPE, WORK_SCOPE, eq(works.title, TITLE_B_ON_B))),
    ).toEqual([WORK_B_ON_B]);
  });

  it('не теряет область при прикладном условии на чужую строку', async () => {
    // Условие выбирает поставку подрядчика Б, область — подрядчика А.
    // Пересечение пусто; потерянная область вернула бы чужую строку.
    expect(
      await workIds(withScope(CONTRACTOR_A_SCOPE, WORK_SCOPE, eq(works.title, TITLE_B_ON_B))),
    ).toEqual([]);
  });

  it('не позволяет клиентскому параметру расширить область', async () => {
    // Так выглядит попытка подрядчика прочитать чужие данные, подставив
    // contractorId в запрос: параметр ложится ПОВЕРХ области, а не вместо неё.
    expect(
      await workIds(
        withScope(CONTRACTOR_A_SCOPE, WORK_SCOPE, eq(works.contractorId, CONTRACTOR_B)),
      ),
    ).toEqual([]);
  });

  it('совмещает несколько условий, сохраняя область', async () => {
    const both = await workIds(
      withScope(
        ENGINEER_SCOPE,
        WORK_SCOPE,
        eq(works.contractorId, CONTRACTOR_A),
        eq(works.id, WORK_A_ON_B),
      ),
    );
    expect(both).toEqual([WORK_A_ON_B]);

    // Та же пара условий у ПОДРЯДЧИКА Б: область режет её насухо, хотя оба
    // прикладных условия по отдельности строку находят.
    expect(
      await workIds(
        withScope(
          CONTRACTOR_B_SCOPE,
          WORK_SCOPE,
          eq(works.contractorId, CONTRACTOR_A),
          eq(works.id, WORK_A_ON_B),
        ),
      ),
    ).toEqual([]);
  });
});
