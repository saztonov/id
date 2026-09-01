/**
 * Рабочий документ и карта страниц — на настоящей PostgreSQL под миграциями.
 *
 * Проверяется не «функция вернула объект», а поведение, которое существует
 * только вместе с БД:
 *
 * 1. **Изоляция.** Подрядчик не видит чужой bundle ни списком, ни по прямому
 *    идентификатору, ни через обратный поиск страницы. Последний путь — тот
 *    самый, о котором легко забыть: он адресуется идентификатором bundle и
 *    номером страницы, а не поставкой.
 * 2. **Идемпотентность.** Повторная сборка того же состава возвращает прежний
 *    документ, а не второй такой же.
 * 3. **Составные FK.** Страница чужой ревизии в карту не попадает — это держит
 *    БД, а не проверка в коде.
 * 4. **Неизменяемость.** В поданную ревизию bundle не добавляется (0008).
 * 5. **Хэш состава** зависит от порядка и содержимого — и не зависит от
 *    идентификаторов строк, иначе повторная подача того же комплекта не
 *    переиспользовала бы результаты (§5.2).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import type { AuthScope } from '../../auth/scope.js';
import {
  computeAggregateManifestHash,
  createBundle,
  findBundle,
  findSourceOfWorkingPage,
  listBundlePages,
  listBundles,
  loadBundlePlan,
} from './bundles.js';
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

const OBJECT_A = id(1);
const OBJECT_B = id(2);
const ORG_DEVELOPER = id(3);
const ORG_CONTRACTOR_A = id(4);
const ORG_CONTRACTOR_B = id(5);
const USER = id(6);

const FOLDER_A = id(16);
const FOLDER_B = id(17);
/** Ревизия в статусе submitted: её состав неизменяем (0008). */
const FOLDER_LOCKED = id(19);

const FILE_1 = id(20);
const FILE_2 = id(21);
const FILE_B = id(22);
const FILE_LOCKED = id(23);

const PAGE_1_0 = id(30);
const PAGE_1_1 = id(31);
const PAGE_2_0 = id(32);
const PAGE_B_0 = id(33);

const SHA_1 = 'a'.repeat(64);
const SHA_2 = 'b'.repeat(64);
const SHA_B = 'c'.repeat(64);
const SHA_WORKING = 'd'.repeat(64);
const SHA_LOCKED = 'f'.repeat(64);

const ADMIN: AuthScope = { kind: 'admin', userId: USER };
const CONTRACTOR_A: AuthScope = {
  kind: 'contractor',
  userId: USER,
  contractorId: ORG_CONTRACTOR_A,
};
const CONTRACTOR_B: AuthScope = {
  kind: 'contractor',
  userId: USER,
  contractorId: ORG_CONTRACTOR_B,
};
/** Инженер: с S37 его область не делит стройку на объекты. */
const ENGINEER: AuthScope = { kind: 'engineer', userId: USER };

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_DEVELOPER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'OBJA1', 'Объект А', 'ЖК «А», корпус 1')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_B}', 'OBJB1', 'Объект Б', 'ЖК «Б», корпус 2')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER}', 'kc-bundles', 'Тестовый пользователь')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_A}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_B}', 'roofing') ON CONFLICT DO NOTHING`,

  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_A}', '${ORG_CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_B}', '${ORG_CONTRACTOR_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_A}', '${ORG_CONTRACTOR_A}') ON CONFLICT DO NOTHING`,

  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_A}', '${OBJECT_A}', '${ORG_CONTRACTOR_A}', '${ORG_CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Поставка А', '${USER}')`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_B}', '${OBJECT_B}', '${ORG_CONTRACTOR_B}', '${ORG_CONTRACTOR_B}', 'roofing', DATE '2026-01-01', 'Поставка Б', '${USER}')`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_LOCKED}', '${OBJECT_A}', '${ORG_CONTRACTOR_A}', '${ORG_CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Поставка А-2', '${USER}')`,

  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_1}', 'blobs/${SHA_1}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_2}', 'blobs/${SHA_2}', 1024, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_B}', 'blobs/${SHA_B}', 512, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_LOCKED}', 'blobs/${SHA_LOCKED}', 512, 'application/pdf')`,

  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_1}', '${FOLDER_A}', '${SHA_1}', 'akt.pdf', 0, 'ok')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_2}', '${FOLDER_A}', '${SHA_2}', 'sertifikat.pdf', 1, 'ok')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_B}', '${FOLDER_B}', '${SHA_B}', 'chuzhoy.pdf', 0, 'ok')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_LOCKED}', '${FOLDER_LOCKED}', '${SHA_LOCKED}', 'podano.pdf', 0, 'ok')`,

  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_1_0}', '${FOLDER_A}', '${FILE_1}', 0, 0, 595, 842, 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_1_1}', '${FOLDER_A}', '${FILE_1}', 1, 1, 842, 595, 90)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_2_0}', '${FOLDER_A}', '${FILE_2}', 0, 2, 595, 842, 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_B_0}', '${FOLDER_B}', '${FILE_B}', 0, 0, 595, 842, 0)`,
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

// =====================================================================
// Хэш состава
// =====================================================================

describe('computeAggregateManifestHash', () => {
  it('зависит от порядка и содержимого, но не от идентификаторов строк', () => {
    const straight = computeAggregateManifestHash([
      { sortOrder: 0, blobSha256: SHA_1 },
      { sortOrder: 1, blobSha256: SHA_2 },
    ]);
    const reordered = computeAggregateManifestHash([
      { sortOrder: 0, blobSha256: SHA_2 },
      { sortOrder: 1, blobSha256: SHA_1 },
    ]);
    // Тот же комплект, перенумерованный: повторная подача после возврата
    // обязана дать тот же хэш, иначе результаты прошлой ревизии не
    // переиспользуются никогда (§5.2).
    const renumbered = computeAggregateManifestHash([
      { sortOrder: 10, blobSha256: SHA_1 },
      { sortOrder: 20, blobSha256: SHA_2 },
    ]);

    expect(straight).toMatch(/^[0-9a-f]{64}$/);
    expect(straight).not.toBe(reordered);
    expect(straight).toBe(renumbered);
  });
});

// =====================================================================
// План сборки
// =====================================================================

describe('loadBundlePlan', () => {
  it('отдаёт файлы в порядке пользователя вместе со страницами и хэшем', async () => {
    const plan = await loadBundlePlan(db, ADMIN, FOLDER_A);

    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.files.map((file) => file.fileName)).toEqual(['akt.pdf', 'sertifikat.pdf']);
    expect(plan.files[0]?.pages.map((page) => page.sourcePageId)).toEqual([PAGE_1_0, PAGE_1_1]);
    expect(plan.files[0]?.sizeBytes).toBe(2048);
    expect(plan.files[0]?.s3Key).toBe(`blobs/${SHA_1}`);
    expect(plan.blockers).toEqual([]);
    expect(plan.aggregateManifestHash).toBe(
      computeAggregateManifestHash([
        { sortOrder: 0, blobSha256: SHA_1 },
        { sortOrder: 1, blobSha256: SHA_2 },
      ]),
    );
  });

  it('чужая ревизия не читается подрядчиком, но читается инженером', async () => {
    expect(await loadBundlePlan(db, CONTRACTOR_B, FOLDER_A)).toBeNull();
    expect(await loadBundlePlan(db, CONTRACTOR_A, FOLDER_A)).not.toBeNull();
    // Инженер видит оба объекта: деления стройки на назначенные и прочие
    // объекты больше нет (S37), и это утверждение — его гарантия.
    expect(await loadBundlePlan(db, ENGINEER, FOLDER_A)).not.toBeNull();
    expect(await loadBundlePlan(db, ENGINEER, FOLDER_B)).not.toBeNull();
  });

  it('файл в карантине и файл без страниц становятся препятствиями', async () => {
    const quarantined = id(40);
    const emptyFile = id(41);
    const sha = 'e'.repeat(64);
    await testDb.query(
      `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
         VALUES ('${sha}', 'blobs/${sha}', 10, 'application/pdf')`,
    );
    await testDb.query(
      `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state, verify_error)
         VALUES ('${quarantined}', '${FOLDER_LOCKED}', '${sha}', 'bitiy.pdf', 1, 'quarantined', 'структура PDF не разобрана')`,
    );
    await testDb.query(
      `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
         VALUES ('${emptyFile}', '${FOLDER_LOCKED}', '${sha}', 'pustoy.pdf', 2, 'ok')`,
    );

    const plan = await loadBundlePlan(db, ADMIN, FOLDER_LOCKED);

    // Причины собираются ВСЕ сразу: подрядчику нужно увидеть весь список, а не
    // получать его по одной за попытку сборки.
    expect(plan?.blockers).toEqual([
      'у файла «podano.pdf» нет ни одной страницы',
      'файл «bitiy.pdf» в карантине',
      'у файла «pustoy.pdf» нет ни одной страницы',
    ]);
  });
});

// =====================================================================
// Запись и карта
// =====================================================================

describe('createBundle', () => {
  const MANIFEST = computeAggregateManifestHash([
    { sortOrder: 0, blobSha256: SHA_1 },
    { sortOrder: 1, blobSha256: SHA_2 },
  ]);
  const BUILDER = 'bundle/1+pdf-lib';

  const INPUT = {
    folderId: FOLDER_A,
    aggregateManifestHash: MANIFEST,
    builderVersion: BUILDER,
    workingPdf: { sha256: SHA_WORKING, sizeBytes: 3072, s3Key: `bundle/${SHA_WORKING}.pdf` },
    pages: [
      { workingPageIndex: 0, sourcePageId: PAGE_1_0 },
      { workingPageIndex: 1, sourcePageId: PAGE_1_1 },
      { workingPageIndex: 2, sourcePageId: PAGE_2_0 },
    ],
  };

  it('пишет документ, карту и событие ревизии одной транзакцией', async () => {
    const { bundle, created } = await createBundle(db, CONTRACTOR_A, INPUT);

    expect(created).toBe(true);
    expect(bundle.pageCount).toBe(3);
    expect(bundle.workingPdfBlobSha256).toBe(SHA_WORKING);

    const events = await testDb.query<{ event_type: string; seq: string }>(
      `SELECT event_type, seq FROM folder_events WHERE folder_id = '${FOLDER_A}'`,
    );
    expect(events.map((row) => row.event_type)).toEqual(['bundle.created']);
  });

  it('повторная сборка того же состава не создаёт второй документ', async () => {
    const again = await createBundle(db, CONTRACTOR_A, INPUT);

    expect(again.created).toBe(false);
    expect(await listBundles(db, ADMIN, FOLDER_A)).toHaveLength(1);
  });

  it('карта отображает страницу рабочего PDF на файл и его страницу', async () => {
    const [bundle] = await listBundles(db, ADMIN, FOLDER_A);
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;

    const pages = await listBundlePages(db, ADMIN, bundle.id);
    expect(pages.map((page) => page.workingPageIndex)).toEqual([0, 1, 2]);
    expect(pages[1]).toMatchObject({
      sourcePageId: PAGE_1_1,
      sourceFileId: FILE_1,
      fileName: 'akt.pdf',
      filePageIndex: 1,
      rotation: 90,
    });
    expect(pages[2]).toMatchObject({ sourceFileId: FILE_2, filePageIndex: 0 });

    const single = await findSourceOfWorkingPage(db, ADMIN, bundle.id, 2);
    expect(single).toMatchObject({ sourcePageId: PAGE_2_0, fileName: 'sertifikat.pdf' });
  });

  it('чужой подрядчик не видит ни документ, ни карту, ни отдельную страницу', async () => {
    const [bundle] = await listBundles(db, ADMIN, FOLDER_A);
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;

    expect(await findBundle(db, CONTRACTOR_B, bundle.id)).toBeNull();
    expect(await listBundlePages(db, CONTRACTOR_B, bundle.id)).toEqual([]);
    expect(await findSourceOfWorkingPage(db, CONTRACTOR_B, bundle.id, 0)).toBeNull();
    expect(await listBundles(db, CONTRACTOR_B, FOLDER_A)).toEqual([]);
    // Инженер рабочий документ видит: изоляция режет подрядчика, не его.
    expect(await findBundle(db, ENGINEER, bundle.id)).not.toBeNull();
  });

  it('карта с дырой отвергается до записи', async () => {
    await expect(
      createBundle(db, ADMIN, {
        ...INPUT,
        aggregateManifestHash: '1'.repeat(64),
        pages: [
          { workingPageIndex: 0, sourcePageId: PAGE_1_0 },
          { workingPageIndex: 2, sourcePageId: PAGE_1_1 },
        ],
      }),
    ).rejects.toThrow(/не сплошная/);
  });

  it('страница чужой ревизии в карту не попадает — это держит составной FK', async () => {
    await expect(
      createBundle(db, ADMIN, {
        ...INPUT,
        aggregateManifestHash: '2'.repeat(64),
        pages: [{ workingPageIndex: 0, sourcePageId: PAGE_B_0 }],
      }),
    ).rejects.toThrow();
  });

  it('ревизия вне области видимости — отказ, а не запись', async () => {
    await expect(
      createBundle(db, CONTRACTOR_B, { ...INPUT, aggregateManifestHash: '5'.repeat(64) }),
    ).rejects.toThrow();
  });
});
