/**
 * Исполнитель комплекта, прочитанный из акта (S37) — на настоящей PostgreSQL.
 *
 * Проверяется не «функция вернула true», а то, что существует только вместе с
 * БД: замена исполнителя переписывает ЧЕТЫРЕ денормализованные копии за одну
 * транзакцию с отсроченными составными ключами. Вне отсрочки такой транзакции
 * не существует ни в каком порядке операторов — это доказано отдельно в
 * `packages/db/src/invariants.test.ts`.
 *
 * Второе, ради чего нужна БД: условия «только подставленное», «только пока
 * комплект не в папке» и «только пока все ревизии черновые» живут в самом
 * операторе `UPDATE`, а не в вызывающем. Проверить их можно единственным
 * способом — данными.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { rememberContractorRaw, replaceAssumedContractor } from './navigation.js';
import type { Database } from './users.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const OBJECT = id(1);
const ORG_ASSUMED = id(2);
const ORG_FROM_ACT = id(3);
const USER = id(4);

/** Подставленный портал комплект: его исполнителя конвейер вправе заменить. */
const WORK_ASSUMED = id(10);
const REVISION_ASSUMED = id(11);
const DOCUMENT_ASSUMED = id(12);

/** Названный человеком: его портал не трогает никогда. */
const WORK_NAMED = id(20);
const REVISION_NAMED = id(21);

/** Подставленный, но уже поданный: состав поданного комплекта неизменяем. */
const WORK_SUBMITTED = id(30);
const REVISION_SUBMITTED = id(31);

/** Подставленный, но включённый в папку: снимок описи копирует исполнителя. */
const REGISTRY = id(40);
const WORK_IN_REGISTRY = id(41);
const REVISION_IN_REGISTRY = id(42);

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_ASSUMED}', 'ООО «Подставленный»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_FROM_ACT}', 'ООО «Из акта»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'OBJ01', 'Объект', 'ЖК «Тест»')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code) VALUES ('${OBJECT}', 'roofing')`,
  `INSERT INTO object_contractors (object_id, contractor_id) VALUES ('${OBJECT}', '${ORG_ASSUMED}')`,
  `INSERT INTO object_contractors (object_id, contractor_id) VALUES ('${OBJECT}', '${ORG_FROM_ACT}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER}', 'kc-contractor-test', 'Инженер')`,

  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code,
                      period, title, created_by, contractor_assumed)
     VALUES ('${WORK_ASSUMED}', '${OBJECT}', '${ORG_ASSUMED}', '${ORG_ASSUMED}', 'roofing',
             DATE '2026-01-01', 'Подставленный исполнитель', '${USER}', true)`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_ASSUMED}', '${WORK_ASSUMED}', '${OBJECT}', '${ORG_ASSUMED}', 1, 'draft')`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal, title)
     VALUES ('${DOCUMENT_ASSUMED}', '${REVISION_ASSUMED}', '${OBJECT}', '${ORG_ASSUMED}', 1, 'АОСР')`,

  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code,
                      period, title, created_by)
     VALUES ('${WORK_NAMED}', '${OBJECT}', '${ORG_ASSUMED}', '${ORG_ASSUMED}', 'roofing',
             DATE '2026-01-01', 'Названный человеком', '${USER}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_NAMED}', '${WORK_NAMED}', '${OBJECT}', '${ORG_ASSUMED}', 1, 'draft')`,

  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code,
                      period, title, created_by, contractor_assumed)
     VALUES ('${WORK_SUBMITTED}', '${OBJECT}', '${ORG_ASSUMED}', '${ORG_ASSUMED}', 'roofing',
             DATE '2026-01-01', 'Подставленный и поданный', '${USER}', true)`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status,
                                     aggregate_manifest_hash, submitted_at, submitted_by)
     VALUES ('${REVISION_SUBMITTED}', '${WORK_SUBMITTED}', '${OBJECT}', '${ORG_ASSUMED}', 1,
             'submitted', '${'a'.repeat(64)}', now(), '${USER}')`,

  `INSERT INTO registries (id, object_id, section_code, period, created_by)
     VALUES ('${REGISTRY}', '${OBJECT}', 'roofing', DATE '2026-01-01', '${USER}')`,
  `INSERT INTO works (id, object_id, contractor_id, managed_by_contractor_id, section_code,
                      period, title, created_by, contractor_assumed, registry_id, ordinal)
     VALUES ('${WORK_IN_REGISTRY}', '${OBJECT}', '${ORG_ASSUMED}', '${ORG_ASSUMED}', 'roofing',
             DATE '2026-01-01', 'Подставленный и в папке', '${USER}', true, '${REGISTRY}', 1)`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_IN_REGISTRY}', '${WORK_IN_REGISTRY}', '${OBJECT}', '${ORG_ASSUMED}', 1,
             'draft')`,
];

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }
  for (const statement of FIXTURE) {
    await testDb.query(statement);
  }
  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

async function contractorOf(workId: string): Promise<{
  work: string;
  assumed: boolean;
  revision: string | null;
}> {
  const rows = await testDb.query<{ work: string; assumed: boolean; revision: string | null }>(
    `SELECT w.contractor_id AS work, w.contractor_assumed AS assumed,
            (SELECT r.contractor_id FROM submission_revisions r WHERE r.work_id = w.id LIMIT 1)
              AS revision
       FROM works w WHERE w.id = '${workId}'`,
  );
  return rows[0] ?? { work: '', assumed: false, revision: null };
}

describe('replaceAssumedContractor', () => {
  it('переписывает исполнителя вместе со всеми денормализованными копиями', async () => {
    expect(await replaceAssumedContractor(db, REVISION_ASSUMED, ORG_FROM_ACT)).toBe(true);

    const state = await contractorOf(WORK_ASSUMED);
    expect(state).toEqual({ work: ORG_FROM_ACT, assumed: false, revision: ORG_FROM_ACT });

    // Документ — третья копия того же значения. Пропустить её означало бы
    // оставить строку, чей `contractor_id` не совпадает с ревизией: составной
    // ключ отверг бы такое состояние на коммите.
    const documents = await testDb.query<{ contractor_id: string }>(
      `SELECT contractor_id FROM logical_documents WHERE id = '${DOCUMENT_ASSUMED}'`,
    );
    expect(documents[0]?.contractor_id).toBe(ORG_FROM_ACT);
  });

  it('повторный вызов ничего не делает: признак снят первым', async () => {
    // Задачи конвейера исполняются at-least-once (§12), и второй прогон не
    // должен переписывать исполнителя ещё раз — тем более другим значением
    // после пересегментации.
    expect(await replaceAssumedContractor(db, REVISION_ASSUMED, ORG_ASSUMED)).toBe(false);
    expect((await contractorOf(WORK_ASSUMED)).work).toBe(ORG_FROM_ACT);
  });

  it('названного человеком исполнителя не трогает', async () => {
    // Расхождение с актом в этом случае выносит замечанием AOSR.HDR.023, и
    // решает человек. Молча переписать его выбор — худшее, что портал может
    // сделать с введённым значением.
    expect(await replaceAssumedContractor(db, REVISION_NAMED, ORG_FROM_ACT)).toBe(false);
    expect((await contractorOf(WORK_NAMED)).work).toBe(ORG_ASSUMED);
  });

  it('поданный комплект не трогает', async () => {
    // Состав поданного комплекта покрыт хэшем, и всё выведенное из него
    // доказывает, что именно проверяли. То же держит триггер 0008 — условие
    // здесь нужно, чтобы отказ не пришёл из драйвера посреди задачи.
    expect(await replaceAssumedContractor(db, REVISION_SUBMITTED, ORG_FROM_ACT)).toBe(false);
    expect((await contractorOf(WORK_SUBMITTED)).work).toBe(ORG_ASSUMED);
  });

  it('включённый в папку комплект не трогает', async () => {
    // Опись копирует исполнителя, а не читает по ссылке (ADR-0011): замена
    // после включения разошлась бы с бумагой.
    expect(await replaceAssumedContractor(db, REVISION_IN_REGISTRY, ORG_FROM_ACT)).toBe(false);
    expect((await contractorOf(WORK_IN_REGISTRY)).work).toBe(ORG_ASSUMED);
  });
});

describe('rememberContractorRaw', () => {
  it('запоминает наименование из акта у подставленного исполнителя', async () => {
    expect(await rememberContractorRaw(db, REVISION_IN_REGISTRY, 'ООО «Незнакомец»')).toBe(true);

    const rows = await testDb.query<{ contractor_raw: string | null }>(
      `SELECT contractor_raw FROM works WHERE id = '${WORK_IN_REGISTRY}'`,
    );
    expect(rows[0]?.contractor_raw).toBe('ООО «Незнакомец»');

    // Повтор тем же значением записи не делает: событие о нём эмитируется, и
    // повторять его на каждом прогоне значило бы засорять журнал ревизии.
    expect(await rememberContractorRaw(db, REVISION_IN_REGISTRY, 'ООО «Незнакомец»')).toBe(false);
  });

  it('у названного человеком исполнителя ничего не пишет', async () => {
    expect(await rememberContractorRaw(db, REVISION_NAMED, 'ООО «Незнакомец»')).toBe(false);
  });
});
