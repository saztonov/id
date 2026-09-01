/**
 * Пин правила разметки на ревизии — на настоящей БД.
 *
 * Предмет здесь — момент, в который правило фиксируется, и он важнее самого
 * правила. Разметка комплекта на 220 страниц — это веер из двухсот с лишним
 * постраничных задач, живущий минутами, а правило нужно не только детекции: по
 * нему анализ покрытия решает, какие флаги ставить, заплатка — трогать ли лист,
 * экран — что написать человеку. Читай все они настройку на своём исполнении,
 * переключение посреди веера дало бы ОДНУ ревизию, размеченную двумя правилами,
 * и в базе не осталось бы ничего, чем это объяснить.
 *
 * Поэтому проверяется ровно три утверждения: правило попадает в ревизию при
 * создании черновика, меняется ТОЛЬКО явным перепином, и непригодное значение
 * колонки читается как прежнее поведение, а не роняет чтение.
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
import { ensureDraftLayout, findLayoutRevision, pinMarkupPolicy } from './layout.js';
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
const SHA = 'a'.repeat(64);

const SCOPE: AuthScope = { kind: 'admin', userId: USER };

const SHEET_AWARE: MarkupPolicy = {
  version: 1,
  sheetStrategy: 'sheet_aware',
  numberZone: 'near_stamp',
  numberZonePad: { x: 0.1, y: 0.25 },
};

let testDb: TestDatabase;
let db: Database;

async function policyEvents(): Promise<readonly { event_type: string; payload: unknown }[]> {
  return testDb.query<{ event_type: string; payload: unknown }>(
    `SELECT event_type, payload FROM folder_events
      WHERE folder_id = '${FOLDER}' AND event_type = 'layout.policy_pinned'
      ORDER BY seq`,
  );
}

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const fixture: readonly string[] = [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'PP01', 'Объект', 'ЖК «Политика», корпус 1')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER}', 'kc-policy', 'Сотрудник', '${ORG}')`,
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
  ];
  for (const statement of fixture) await testDb.query(statement);

  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

describe('пин правила разметки', () => {
  it('черновик, созданный без правила, получает прежнее поведение', async () => {
    // Умолчание колонки — не косметика: им размечены ВСЕ ревизии, созданные до
    // появления правила, и судиться они обязаны тем правилом, по которому их
    // действительно размечали.
    const { layout, created } = await ensureDraftLayout(db, SCOPE, {
      folderId: FOLDER,
      bundleId: BUNDLE,
    });

    expect(created).toBe(true);
    expect(layout.markupPolicy).toEqual(LEGACY_MARKUP_POLICY);
  });

  it('повторный вызов не перепинивает правило существующего черновика', async () => {
    // Иначе любое обращение к разметке — открытие экрана, гранулярный маршрут —
    // молча меняло бы правило посреди идущего веера задач.
    const { layout, created } = await ensureDraftLayout(db, SCOPE, {
      folderId: FOLDER,
      bundleId: BUNDLE,
      markupPolicy: SHEET_AWARE,
    });

    expect(created).toBe(false);
    expect(layout.markupPolicy).toEqual(LEGACY_MARKUP_POLICY);
  });

  it('явный перепин меняет правило, пишет событие и НЕ бампает версию', async () => {
    const before = await findLayoutRevision(db, SCOPE, (await draftId())!);
    expect(before).not.toBeNull();

    const result = await pinMarkupPolicy(db, SCOPE, {
      layoutRevisionId: before!.id,
      policy: SHEET_AWARE,
    });

    expect(result.changed).toBe(true);

    const after = await findLayoutRevision(db, SCOPE, before!.id);
    expect(after?.markupPolicy).toEqual(SHEET_AWARE);
    // ETag ревизии сторожит НАБОР БЛОКОВ, а правило блоков не меняет: бамп
    // здесь означал бы 412 у всех, кто держит экран разметки открытым, без
    // единой правки в том, что на экране нарисовано.
    expect(after?.version).toBe(before!.version);

    const events = await policyEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      layoutRevisionId: before!.id,
      from: LEGACY_MARKUP_POLICY,
      to: SHEET_AWARE,
    });
  });

  it('перепин тем же правилом — не событие и не запись', async () => {
    // Кнопку стадии жмут повторно постоянно; запись «правило прежнее» на каждое
    // нажатие утопила бы ленту ревизии в шуме.
    const layoutId = (await draftId())!;

    const result = await pinMarkupPolicy(db, SCOPE, {
      layoutRevisionId: layoutId,
      policy: SHEET_AWARE,
    });

    expect(result.changed).toBe(false);
    expect(await policyEvents()).toHaveLength(1);
  });

  it('непригодное значение колонки читается как прежнее поведение', async () => {
    // Колонку пишут миграция и портал, но экран разметки не должен отвечать
    // пятисоткой на строку, которую поправили руками в консоли БД.
    const layoutId = (await draftId())!;
    await testDb.query(
      `UPDATE layout_revisions SET markup_policy = '{"version":99}'::jsonb WHERE id = '${layoutId}'`,
    );

    const layout = await findLayoutRevision(db, SCOPE, layoutId);

    expect(layout?.markupPolicy).toEqual(LEGACY_MARKUP_POLICY);
  });
});

/** Единственный черновик поставки: частичный UNIQUE не даёт им сосуществовать. */
async function draftId(): Promise<string | null> {
  const rows = await testDb.query<{ id: string }>(
    `SELECT id FROM layout_revisions WHERE folder_id = '${FOLDER}' AND state = 'draft'`,
  );
  return rows[0]?.id ?? null;
}
