/**
 * Контекст разметки прогона — на настоящей БД.
 *
 * Предмет: какие листы комплекта правило разметки делает «штамповыми». От этого
 * зависит единственное предупреждение, которое отличает исправную сверку с
 * реестром приложений от сверки, объявляющей «нет в комплекте» каждую
 * исполнительную схему.
 *
 * Проверяются обе половины решения по отдельности, потому что перепутать их
 * легко, а последствия разные: размер листа сам по себе ничего не решает —
 * решает ПРАВИЛО, применённое к размеру. При `detect_all` крупных листов в этом
 * смысле нет вовсе, сколько бы А1 ни лежало в папке.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { LEGACY_MARKUP_POLICY, type MarkupPolicy } from '@id/contracts';

import type { AuthScope } from '../../auth/scope.js';
import { loadMarkupContext, pinMarkupPolicy } from './layout.js';
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
const SHA = 'a'.repeat(64);

const SCOPE: AuthScope = { kind: 'admin', userId: USER };

/**
 * Листы комплекта: два крупных вперемешку с обычными.
 *
 * Вперемешку намеренно — если бы крупные шли подряд с нуля, перепутанный
 * индекс страницы дал бы тот же ответ, и тест ничего бы не поймал.
 * Размеры в пунктах: A4 — 595×842, A1 — 1684×2384.
 */
const PAGES: readonly { readonly width: number; readonly height: number }[] = [
  { width: 595, height: 842 },
  { width: 1684, height: 2384 },
  { width: 595, height: 842 },
  { width: 2384, height: 1684 },
  { width: 595, height: 842 },
];

const SHEET_AWARE_OFF: MarkupPolicy = {
  version: 1,
  sheetStrategy: 'sheet_aware',
  numberZone: 'off',
  numberZonePad: { x: 0.1, y: 0.25 },
};

const SHEET_AWARE_NEAR_STAMP: MarkupPolicy = { ...SHEET_AWARE_OFF, numberZone: 'near_stamp' };

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const fixture: readonly string[] = [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'MC01', 'Объект', 'ЖК «Формат», корпус 1')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER}', 'kc-markup', 'Сотрудник', '${ORG}')`,
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

  for (const [index, page] of PAGES.entries()) {
    await testDb.query(
      `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
         VALUES ('${id(100 + index)}', '${FOLDER}', '${FILE}', ${index}, ${index}, ${page.width}, ${page.height}, 0)`,
    );
    await testDb.query(
      `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
         VALUES ('${BUNDLE}', '${FOLDER}', ${index}, '${id(100 + index)}')`,
    );
  }

  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

describe('какие листы правило делает штамповыми', () => {
  it('при sheet_aware крупные листы названы поимённо и по порядку', async () => {
    await pinMarkupPolicy(db, SCOPE, { layoutRevisionId: LAYOUT, policy: SHEET_AWARE_OFF });

    const context = await loadMarkupContext(db, SCOPE, LAYOUT);

    expect(context).not.toBeNull();
    expect(context?.largeSheetPages).toEqual([1, 3]);
    expect(context?.numberZone).toBe('off');
    expect(context?.sheetStrategy).toBe('sheet_aware');
  });

  it('при detect_all крупных листов нет вовсе — решает правило, а не размер', async () => {
    // Негативный контроль к предыдущему: те же самые A1 в той же папке.
    // Без него тест доказывал бы лишь то, что функция умеет находить большие
    // числа, а не то, что она читает политику.
    await pinMarkupPolicy(db, SCOPE, { layoutRevisionId: LAYOUT, policy: LEGACY_MARKUP_POLICY });

    const context = await loadMarkupContext(db, SCOPE, LAYOUT);

    expect(context?.largeSheetPages).toEqual([]);
    expect(context?.sheetStrategy).toBe('detect_all');
  });

  it('зона номера отдаётся как запинена, а не как настроена сейчас', async () => {
    await pinMarkupPolicy(db, SCOPE, { layoutRevisionId: LAYOUT, policy: SHEET_AWARE_NEAR_STAMP });

    const context = await loadMarkupContext(db, SCOPE, LAYOUT);

    expect(context?.numberZone).toBe('near_stamp');
    expect(context?.largeSheetPages).toEqual([1, 3]);
  });

  it('несуществующая ревизия — null, а не пустой контекст', async () => {
    // Пустой контекст означал бы «крупных листов нет», то есть молчание вместо
    // отказа. Предупреждению нельзя исчезать из-за того, что мы не нашли, о чём
    // предупреждать.
    expect(await loadMarkupContext(db, SCOPE, id(999))).toBeNull();
  });
});
