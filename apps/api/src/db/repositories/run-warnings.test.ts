/**
 * Накопление предупреждений прогона — на настоящей БД.
 *
 * Предмет: предупреждение, родившееся ДО финала, обязано дожить до момента,
 * когда человек откроет прогон. Раньше канала для этого не было вовсе — сборка
 * снимка писала оговорки в журнал воркера, а `recognition_runs.warnings`
 * заполнялся один раз на финале, полной заменой. То есть всё, что накопилось
 * раньше, стиралось ровно в ту секунду, когда становилось нужным.
 *
 * Три утверждения, и каждое ловит свой способ сломать канал: дописывание
 * работает, повтор задачи не удваивает список, финал не стирает накопленное.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import type { RecognitionWarning } from '@id/contracts';

import type { AuthScope } from '../../auth/scope.js';
import { appendRunWarnings, finishRecognitionRun } from './recognition.js';
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
const ORG = id(2);
const USER = id(3);
const FOLDER = id(5);
const FILE = id(6);
const BUNDLE = id(7);
const LAYOUT = id(8);
const RUN = id(9);
const SHA = 'a'.repeat(64);

const SCOPE: AuthScope = { kind: 'admin', userId: USER };

const SKIPPED: RecognitionWarning = {
  code: 'block_degenerate_geometry',
  message: 'Блок на листе 3 вырожден и в снимок не попал.',
  workingPageIndex: 2,
};

const NUMBER_ZONE: RecognitionWarning = {
  code: 'large_sheet_number_zone_off',
  message: 'Листов крупнее A4: 2 (1, 2).',
  workingPageIndex: null,
};

let testDb: TestDatabase;
let db: Database;

async function warningsOf(): Promise<readonly RecognitionWarning[]> {
  const rows = await testDb.query<{ warnings: RecognitionWarning[] }>(
    `SELECT warnings FROM recognition_runs WHERE id = '${RUN}'`,
  );
  return rows[0]?.warnings ?? [];
}

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const fixture: readonly string[] = [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'RW01', 'Объект', 'ЖК «Оговорка», корпус 1')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER}', 'kc-warn', 'Сотрудник', '${ORG}')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG}') ON CONFLICT DO NOTHING`,
    `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER}', '${OBJECT}', '${ORG}', '${ORG}', 'roofing', DATE '2026-01-01', 'Комплект', '${USER}')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA}', 'blobs/${SHA}', 1024, 'application/pdf')`,
    `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE}', '${FOLDER}', '${SHA}', 'комплект.pdf', 0, 'ok')`,
    `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE}', '${FOLDER}', '${'b'.repeat(64)}', '${SHA}', 'bundle/1+pdf-lib')`,
    `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no, state)
       VALUES ('${LAYOUT}', '${FOLDER}', '${OBJECT}', '${BUNDLE}', 1, 'draft')`,
  ];
  for (const statement of fixture) await testDb.query(statement);

  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.query(`DELETE FROM recognition_runs WHERE id = '${RUN}'`);
  await testDb.query(
    `INSERT INTO recognition_runs
       (id, folder_id, layout_revision_id, local_layout_hash, working_pdf_sha256, status)
     VALUES ('${RUN}', '${FOLDER}', '${LAYOUT}', '${'c'.repeat(64)}', '${SHA}', 'running')`,
  );
});

describe('предупреждения накапливаются до финала', () => {
  it('дописываются к пустому списку и к уже накопленному', async () => {
    await appendRunWarnings(db, SCOPE, RUN, [SKIPPED]);
    expect((await warningsOf()).map((warning) => warning.code)).toEqual([
      'block_degenerate_geometry',
    ]);

    await appendRunWarnings(db, SCOPE, RUN, [NUMBER_ZONE]);
    expect((await warningsOf()).map((warning) => warning.code)).toEqual([
      'block_degenerate_geometry',
      'large_sheet_number_zone_off',
    ]);
  });

  it('повтор задачи не удваивает список', async () => {
    // `rd.sync_prepare` повторяется до трёх раз. Без дедупликации второй заход
    // показал бы человеку одну и ту же оговорку трижды, и он резонно решил бы,
    // что вырожденных блоков три.
    await appendRunWarnings(db, SCOPE, RUN, [SKIPPED, NUMBER_ZONE]);
    await appendRunWarnings(db, SCOPE, RUN, [SKIPPED, NUMBER_ZONE]);

    expect(await warningsOf()).toHaveLength(2);
  });

  it('одинаковый код с разным текстом — разные предупреждения', async () => {
    // Негативный контроль к дедупликации: схлопывать по коду нельзя, иначе два
    // вырожденных блока на разных листах превратились бы в один.
    await appendRunWarnings(db, SCOPE, RUN, [SKIPPED]);
    await appendRunWarnings(db, SCOPE, RUN, [
      { ...SKIPPED, message: 'Блок на листе 7 вырожден и в снимок не попал.', workingPageIndex: 6 },
    ]);

    expect(await warningsOf()).toHaveLength(2);
  });

  it('пустой список ничего не меняет и не ходит в базу впустую', async () => {
    await appendRunWarnings(db, SCOPE, RUN, [SKIPPED]);
    await appendRunWarnings(db, SCOPE, RUN, []);

    expect(await warningsOf()).toHaveLength(1);
  });
});

describe('финал не стирает накопленное', () => {
  it('своё предупреждение добавляется к накопленным, а не заменяет их', async () => {
    await appendRunWarnings(db, SCOPE, RUN, [SKIPPED, NUMBER_ZONE]);

    await finishRecognitionRun(db, SCOPE, {
      runId: RUN,
      status: 'done',
      counts: { blocksExpected: 2 },
      warnings: [
        { code: 'partial_publish', message: 'Покрыты не все блоки.', workingPageIndex: null },
      ],
    });

    expect((await warningsOf()).map((warning) => warning.code)).toEqual([
      'block_degenerate_geometry',
      'large_sheet_number_zone_off',
      'partial_publish',
    ]);
  });

  it('финал без своих предупреждений сохраняет накопленное', async () => {
    await appendRunWarnings(db, SCOPE, RUN, [NUMBER_ZONE]);

    await finishRecognitionRun(db, SCOPE, { runId: RUN, status: 'done' });

    expect((await warningsOf()).map((warning) => warning.code)).toEqual([
      'large_sheet_number_zone_off',
    ]);
  });

  it('в завершённый прогон дописать нельзя — это отказ, а не тишина', async () => {
    // Молча проглотить означало бы потерять предупреждение там, где мы его как
    // раз и чиним. Исход уже вынесен: дополнять его нечем.
    await finishRecognitionRun(db, SCOPE, { runId: RUN, status: 'done' });

    await expect(appendRunWarnings(db, SCOPE, RUN, [NUMBER_ZONE])).rejects.toThrow();
  });
});
