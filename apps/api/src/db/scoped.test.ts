/**
 * Превращение области видимости в SQL — на настоящей PostgreSQL (§4.1, §1.6).
 *
 * Тест намеренно не подменяет БД: проверять построитель условий его же
 * сериализацией бессмысленно, потому что интересует не текст, а число строк,
 * которое вернёт база. Пустой `IN ()`, `AND` с неверным приоритетом и потерянное
 * условие видны только на данных.
 *
 * Фикстура перекрёстная, и это существенно: у подрядчика А есть поставка на
 * объекте Б, а у объекта Б есть поставка подрядчика Б. На однородных данных
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
import { submissionRevisions, submissions } from '@id/db';

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
const SECTION_A = id(6);
const SECTION_B = id(7);
const VOLUME_A = id(8);
const VOLUME_B = id(9);

/** Поставка подрядчика А на объекте А. */
const SUBMISSION_A_ON_A = id(10);
/** Поставка того же подрядчика А, но на объекте Б. */
const SUBMISSION_A_ON_B = id(11);
/** Поставка подрядчика Б на объекте Б: тот же объект, другая организация. */
const SUBMISSION_B_ON_B = id(12);

const REVISION_A_ON_A = id(13);
const REVISION_A_ON_B = id(14);
const REVISION_B_ON_B = id(15);

const ALL_SUBMISSIONS = [SUBMISSION_A_ON_A, SUBMISSION_A_ON_B, SUBMISSION_B_ON_B];

const TITLE_B_ON_B = 'Кровля автостоянки, подрядчик Б';

const FIXTURE: readonly string[] = [
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER}', 'kc-scoped-test', 'Автор поставок')`,
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
  `INSERT INTO section_kinds (code, name) VALUES ('roofing', 'Кровля')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_A}', '${OBJECT_A}', '2.5.1', 'Кровля автостоянки', 'roofing')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_B}', '${OBJECT_B}', '2.5.1', 'Кровля автостоянки', 'roofing')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME_A}', '${OBJECT_A}', '${SECTION_A}', 'V1', 'Том 1')`,
  `INSERT INTO volumes (id, object_id, section_id, code, name)
     VALUES ('${VOLUME_B}', '${OBJECT_B}', '${SECTION_B}', 'V1', 'Том 1')`,
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, number, title, created_by)
     VALUES ('${SUBMISSION_A_ON_A}', '${VOLUME_A}', '${OBJECT_A}', '${CONTRACTOR_A}',
             'S1', 'Кровля автостоянки, подрядчик А', '${USER}')`,
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, number, title, created_by)
     VALUES ('${SUBMISSION_A_ON_B}', '${VOLUME_B}', '${OBJECT_B}', '${CONTRACTOR_A}',
             'S2', 'Кровля корпуса Б, подрядчик А', '${USER}')`,
  `INSERT INTO submissions (id, volume_id, object_id, contractor_id, number, title, created_by)
     VALUES ('${SUBMISSION_B_ON_B}', '${VOLUME_B}', '${OBJECT_B}', '${CONTRACTOR_B}',
             'S3', '${TITLE_B_ON_B}', '${USER}')`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_A_ON_A}', '${SUBMISSION_A_ON_A}', '${OBJECT_A}', '${CONTRACTOR_A}', 1)`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_A_ON_B}', '${SUBMISSION_A_ON_B}', '${OBJECT_B}', '${CONTRACTOR_A}', 1)`,
  `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no)
     VALUES ('${REVISION_B_ON_B}', '${SUBMISSION_B_ON_B}', '${OBJECT_B}', '${CONTRACTOR_B}', 1)`,
];

const SUBMISSION_SCOPE: ScopeTarget = {
  objectId: submissions.objectId,
  contractorId: submissions.contractorId,
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
const ENGINEER_ON_B_SCOPE: AuthScope = { kind: 'engineer', userId: USER, objectIds: [OBJECT_B] };
const ENGINEER_WITHOUT_OBJECTS: AuthScope = { kind: 'engineer', userId: USER, objectIds: [] };
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

/** Идентификаторы поставок, которые вернёт база при заданном условии. */
async function submissionIds(where: SQL): Promise<string[]> {
  const query = new QueryBuilder()
    .select({ id: submissions.id })
    .from(submissions)
    .where(where)
    .orderBy(asc(submissions.number))
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
    expect(await submissionIds(scopeWhere(ADMIN_SCOPE, SUBMISSION_SCOPE))).toEqual(ALL_SUBMISSIONS);
  });

  it('подрядчик А видит только свои поставки, включая чужой объект', async () => {
    expect(await submissionIds(scopeWhere(CONTRACTOR_A_SCOPE, SUBMISSION_SCOPE))).toEqual([
      SUBMISSION_A_ON_A,
      SUBMISSION_A_ON_B,
    ]);
  });

  it('подрядчик Б не видит поставок подрядчика А на общем объекте', async () => {
    expect(await submissionIds(scopeWhere(CONTRACTOR_B_SCOPE, SUBMISSION_SCOPE))).toEqual([
      SUBMISSION_B_ON_B,
    ]);
  });

  it('инженер с одним объектом видит только строки этого объекта', async () => {
    // Обе организации на объекте Б и ни одной строки объекта А: инженер
    // ограничен объектом, а не подрядчиком.
    expect(await submissionIds(scopeWhere(ENGINEER_ON_B_SCOPE, SUBMISSION_SCOPE))).toEqual([
      SUBMISSION_A_ON_B,
      SUBMISSION_B_ON_B,
    ]);
  });

  it('инженер с пустым списком объектов не видит ни одной строки', async () => {
    const visible = await submissionIds(scopeWhere(ENGINEER_WITHOUT_OBJECTS, SUBMISSION_SCOPE));
    expect(visible).toEqual([]);
    // Сравнение с полным составом, а не только с длиной: дефект «пустой список
    // вырождается в отсутствие ограничения» даёт именно все строки.
    expect(visible).not.toEqual(ALL_SUBMISSIONS);
  });

  it.each([
    ['manager', MANAGER_SCOPE],
    ['admin', ADMIN_SCOPE],
  ] as const)('%s видит все поставки', async (_kind, scope) => {
    expect(await submissionIds(scopeWhere(scope, SUBMISSION_SCOPE))).toEqual(ALL_SUBMISSIONS);
  });

  it('применяется к любой таблице с колонками области', async () => {
    expect(await revisionIds(scopeWhere(CONTRACTOR_A_SCOPE, REVISION_SCOPE))).toEqual([
      REVISION_A_ON_A,
      REVISION_A_ON_B,
    ]);
  });

  it('пустая область даёт FALSE, а не IN () и не TRUE', () => {
    const rendered = new PgDialect().sqlToQuery(
      scopeWhere(ENGINEER_WITHOUT_OBJECTS, SUBMISSION_SCOPE),
    );
    expect(rendered.sql).toBe('false');
    expect(rendered.sql).not.toContain('in (');
  });

  it('значение области уходит параметром, а не текстом запроса', () => {
    // Интерполяция значения в SQL — это и инъекция, и потеря плана запроса;
    // проверяется здесь, потому что на выборке результат был бы тот же.
    const rendered = new PgDialect().sqlToQuery(scopeWhere(CONTRACTOR_A_SCOPE, SUBMISSION_SCOPE));
    expect(rendered.params).toContain(CONTRACTOR_A);
    expect(rendered.sql).not.toContain(CONTRACTOR_A);
  });
});

describe('withScope: область плюс прикладное условие', () => {
  it('сужает область прикладным условием', async () => {
    expect(
      await submissionIds(
        withScope(MANAGER_SCOPE, SUBMISSION_SCOPE, eq(submissions.title, TITLE_B_ON_B)),
      ),
    ).toEqual([SUBMISSION_B_ON_B]);
  });

  it('не теряет область при прикладном условии на чужую строку', async () => {
    // Условие выбирает поставку подрядчика Б, область — подрядчика А.
    // Пересечение пусто; потерянная область вернула бы чужую строку.
    expect(
      await submissionIds(
        withScope(CONTRACTOR_A_SCOPE, SUBMISSION_SCOPE, eq(submissions.title, TITLE_B_ON_B)),
      ),
    ).toEqual([]);
  });

  it('не позволяет клиентскому параметру расширить область', async () => {
    // Так выглядит попытка подрядчика прочитать чужие данные, подставив
    // contractorId в запрос: параметр ложится ПОВЕРХ области, а не вместо неё.
    expect(
      await submissionIds(
        withScope(CONTRACTOR_A_SCOPE, SUBMISSION_SCOPE, eq(submissions.contractorId, CONTRACTOR_B)),
      ),
    ).toEqual([]);
  });

  it('пустая область не открывается прикладным условием', async () => {
    expect(
      await submissionIds(
        withScope(
          ENGINEER_WITHOUT_OBJECTS,
          SUBMISSION_SCOPE,
          eq(submissions.id, SUBMISSION_A_ON_A),
        ),
      ),
    ).toEqual([]);
  });

  it('совмещает несколько условий, сохраняя область', async () => {
    const both = await submissionIds(
      withScope(
        ENGINEER_ON_B_SCOPE,
        SUBMISSION_SCOPE,
        eq(submissions.contractorId, CONTRACTOR_A),
        eq(submissions.number, 'S2'),
      ),
    );
    expect(both).toEqual([SUBMISSION_A_ON_B]);

    // То же условие, но объект вне области инженера: ни одной строки.
    expect(
      await submissionIds(
        withScope(
          ENGINEER_ON_B_SCOPE,
          SUBMISSION_SCOPE,
          eq(submissions.contractorId, CONTRACTOR_A),
          eq(submissions.number, 'S1'),
        ),
      ),
    ).toEqual([]);
  });
});
