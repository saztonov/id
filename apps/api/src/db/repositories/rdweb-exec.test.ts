/**
 * Реестр внешних идентификаторов — на настоящей БД.
 *
 * Предмет здесь один: узнаётся ли блок между отправками. Это не деталь учёта —
 * от неё зависит счёт за распознавание. Узнанный блок RD WEB объявляет
 * `unchanged` и модель по нему не вызывает; неузнанный — `new_block`, и
 * комплект на 220 листов распознаётся заново целиком.
 *
 * Поэтому каждая ветка сопоставления проверяется отдельно, и у каждой есть
 * негативный контроль: тест «идентификатор сохранился» без теста «а вот здесь
 * обязан смениться» доказывает только то, что функция возвращает константу.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import type { AuthScope } from '../../auth/scope.js';
import {
  externalDocumentIdOf,
  externalSyncIdOf,
  listDeclaredBlocks,
  openExecSync,
  reconcileExecSnapshot,
  type ReconcileBlockInput,
} from './rdweb-exec.js';
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
const PROJECT = 'idp-object-1';

const SCOPE: AuthScope = { kind: 'admin', userId: USER };

let testDb: TestDatabase;
let db: Database;

/** Блок разметки: строка в БД плюс её описание для сопоставления. */
async function insertLayoutBlock(blockId: string, page: number, rect: string): Promise<void> {
  await testDb.query(
    `INSERT INTO layout_blocks
       (id, layout_revision_id, folder_id, bundle_id, source_page_id, working_page_index,
        object_id, block_type, shape_type, x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${blockId}', '${LAYOUT}', '${FOLDER}', '${BUNDLE}', '${id(100 + page)}', ${page},
             '${OBJECT}', 'text', 'rectangle', ${rect}, 0, 'auto', 'rf_detr')`,
  );
}

async function deleteLayoutBlock(blockId: string): Promise<void> {
  await testDb.query(`DELETE FROM layout_blocks WHERE id = '${blockId}'`);
}

function blockInput(overrides: Partial<ReconcileBlockInput> = {}): ReconcileBlockInput {
  return {
    layoutBlockId: id(200),
    workingPageIndex: 0,
    blockType: 'text',
    geometryKey: 'a'.repeat(64),
    declaredHash: 'b'.repeat(64),
    ...overrides,
  };
}

async function reconcile(blocks: readonly ReconcileBlockInput[], runId: string) {
  return reconcileExecSnapshot(db, SCOPE, {
    folderId: FOLDER,
    recognitionRunId: runId,
    externalProjectId: PROJECT,
    documentSha256: SHA,
    blocks,
  });
}

/** Прогон распознавания: строка нужна, чтобы отправка могла на него сослаться. */
async function insertRun(runId: string): Promise<void> {
  await testDb.query(
    `INSERT INTO recognition_runs
       (id, folder_id, layout_revision_id, local_layout_hash, working_pdf_sha256, status)
     VALUES ('${runId}', '${FOLDER}', '${LAYOUT}', '${'c'.repeat(64)}', '${SHA}', 'running')`,
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
       VALUES ('${OBJECT}', 'RD01', 'Объект', 'ЖК «Снимок», корпус 1')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER}', 'kc-exec', 'Сотрудник', '${ORG}')`,
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

  for (let page = 0; page < 3; page += 1) {
    await testDb.query(
      `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
         VALUES ('${id(100 + page)}', '${FOLDER}', '${FILE}', ${page}, ${page}, 1654, 2339, 0)`,
    );
    await testDb.query(
      `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
         VALUES ('${BUNDLE}', '${FOLDER}', ${page}, '${id(100 + page)}')`,
    );
  }

  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  // Реестр и отправки чистятся между сценариями, разметка — тоже: каждый тест
  // строит свою историю блока с нуля.
  await testDb.query('DELETE FROM rd_exec_syncs');
  await testDb.query('DELETE FROM rd_exec_blocks');
  await testDb.query('DELETE FROM rd_exec_documents');
  await testDb.query('DELETE FROM recognition_runs');
  await testDb.query('DELETE FROM layout_blocks');
});

describe('документ логический, а не файловый', () => {
  it('заводится один на папку и переживает повторные отправки', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertRun(id(300));
    const first = await reconcile([blockInput()], id(300));

    expect(first.externalDocumentId).toBe(externalDocumentIdOf(FOLDER));
    expect(first.documentRevision).toBe('R1');
    expect(first.syncGeneration).toBe(1);
    expect(first.baseGeneration).toBe(0);

    await testDb.query(`UPDATE rd_exec_syncs SET state = 'terminal', remote_state = 'completed'`);
    await insertRun(id(301));
    const second = await reconcile([blockInput()], id(301));

    expect(second.externalDocumentId).toBe(first.externalDocumentId);
    // Генерация монотонна, редакция PDF та же — файл не менялся.
    expect(second.syncGeneration).toBe(2);
    expect(second.documentRevision).toBe('R1');
  });

  it('смена рабочего PDF поднимает метку редакции', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertRun(id(300));
    await reconcile([blockInput()], id(300));
    await testDb.query(`UPDATE rd_exec_syncs SET state = 'terminal', remote_state = 'completed'`);

    await insertRun(id(301));
    const next = await reconcileExecSnapshot(db, SCOPE, {
      folderId: FOLDER,
      recognitionRunId: id(301),
      externalProjectId: PROJECT,
      documentSha256: 'd'.repeat(64),
      blocks: [blockInput()],
    });
    expect(next.documentRevision).toBe('R2');
  });
});

describe('сопоставление блоков', () => {
  it('правка рамки сохраняет идентификатор и поднимает ревизию', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertRun(id(300));
    const first = await reconcile([blockInput()], id(300));
    const declared = first.declarations[0];
    expect(declared?.matchedBy).toBe('new');
    expect(declared?.revision).toBe(1);

    await testDb.query(`UPDATE rd_exec_syncs SET state = 'terminal', remote_state = 'completed'`);
    await insertRun(id(301));
    // Рамку подвинули: `updateLayoutBlock` правит строку НА МЕСТЕ, uuid цел,
    // геометрия другая.
    const second = await reconcile(
      [blockInput({ geometryKey: 'f'.repeat(64), declaredHash: 'e'.repeat(64) })],
      id(301),
    );
    const moved = second.declarations[0];

    expect(moved?.externalBlockId).toBe(declared?.externalBlockId);
    expect(moved?.matchedBy).toBe('layout_block');
    expect(moved?.revision).toBe(2);
  });

  it('переразметка с новыми uuid сохраняет идентификатор по геометрии', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertRun(id(300));
    const first = await reconcile([blockInput()], id(300));
    const declared = first.declarations[0];

    await testDb.query(`UPDATE rd_exec_syncs SET state = 'terminal', remote_state = 'completed'`);
    // Повторная детекция: строка снесена и вставлена заново с другим uuid.
    // Ссылка реестра обнуляется внешним ключом ON DELETE SET NULL.
    await deleteLayoutBlock(id(200));
    await insertLayoutBlock(id(201), 0, '0.1, 0.1, 0.9, 0.4');

    await insertRun(id(301));
    const second = await reconcile([blockInput({ layoutBlockId: id(201) })], id(301));
    const rematched = second.declarations[0];

    expect(rematched?.externalBlockId).toBe(declared?.externalBlockId);
    expect(rematched?.matchedBy).toBe('geometry');
    // Ревизия НЕ выросла: вырез тот же, RD WEB ответит `unchanged` и не
    // возьмёт денег. Ровно ради этого реестр и существует.
    expect(rematched?.revision).toBe(1);
  });

  it('новая рамка получает новый идентификатор — контроль к двум предыдущим', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertLayoutBlock(id(201), 1, '0.1, 0.5, 0.9, 0.8');
    await insertRun(id(300));

    const plan = await reconcile(
      [
        blockInput(),
        blockInput({
          layoutBlockId: id(201),
          workingPageIndex: 1,
          geometryKey: 'c'.repeat(64),
          declaredHash: 'd'.repeat(64),
        }),
      ],
      id(300),
    );

    const ids = plan.declarations.map((d) => d.externalBlockId).sort();
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['blk-000001', 'blk-000002']);
  });

  it('исчезнувший блок помечается удалённым, а не забывается', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertLayoutBlock(id(201), 1, '0.1, 0.5, 0.9, 0.8');
    await insertRun(id(300));
    await reconcile(
      [
        blockInput(),
        blockInput({ layoutBlockId: id(201), workingPageIndex: 1, geometryKey: 'c'.repeat(64) }),
      ],
      id(300),
    );
    await testDb.query(`UPDATE rd_exec_syncs SET state = 'terminal', remote_state = 'completed'`);

    await deleteLayoutBlock(id(201));
    await insertRun(id(301));
    await reconcile([blockInput()], id(301));

    const alive = await listDeclaredBlocks(db, FOLDER);
    expect(alive).toHaveLength(1);

    const all = await testDb.query<{ external_block_id: string; deleted_at: string | null }>(
      'SELECT external_block_id, deleted_at FROM rd_exec_blocks ORDER BY external_block_id',
    );
    expect(all).toHaveLength(2);
    expect(all[1]?.deleted_at).not.toBeNull();
  });

  it('два блока с одинаковой геометрией разбираются детерминированно', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertLayoutBlock(id(201), 0, '0.1, 0.1, 0.9, 0.4');
    await insertRun(id(300));

    const plan = await reconcile([blockInput(), blockInput({ layoutBlockId: id(201) })], id(300));
    expect(new Set(plan.declarations.map((d) => d.externalBlockId)).size).toBe(2);
  });
});

describe('идемпотентность отправки', () => {
  it('повторная подготовка того же прогона не поднимает генерацию', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertRun(id(300));

    const first = await reconcile([blockInput()], id(300));
    await openExecSync(db, {
      folderId: FOLDER,
      recognitionRunId: id(300),
      externalSyncId: externalSyncIdOf(FOLDER, first.syncGeneration, 0),
      syncGeneration: first.syncGeneration,
      baseGeneration: first.baseGeneration,
      manifestSha256: 'e'.repeat(64),
      documentSha256: SHA,
      documentRevision: first.documentRevision,
      blocksCount: 1,
    });

    const second = await reconcile([blockInput()], id(300));
    expect(second.reused).toBe(true);
    expect(second.syncGeneration).toBe(first.syncGeneration);
    // И идентификаторы блоков те же — иначе тело разошлось бы при том же
    // external_sync_id, и контракт ответил бы 409 sync_identity_conflict.
    expect(second.declarations[0]?.externalBlockId).toBe(first.declarations[0]?.externalBlockId);
  });

  it('повторная запись строки отправки не создаёт второй', async () => {
    await insertLayoutBlock(id(200), 0, '0.1, 0.1, 0.9, 0.4');
    await insertRun(id(300));
    const plan = await reconcile([blockInput()], id(300));
    const args = {
      folderId: FOLDER,
      recognitionRunId: id(300),
      externalSyncId: externalSyncIdOf(FOLDER, plan.syncGeneration, 0),
      syncGeneration: plan.syncGeneration,
      baseGeneration: plan.baseGeneration,
      manifestSha256: 'e'.repeat(64),
      documentSha256: SHA,
      documentRevision: plan.documentRevision,
      blocksCount: 1,
    };

    const first = await openExecSync(db, args);
    const second = await openExecSync(db, args);
    expect(second.id).toBe(first.id);

    const rows = await testDb.query<{ count: string }>('SELECT count(*) FROM rd_exec_syncs');
    expect(Number(rows[0]?.count)).toBe(1);
  });
});
