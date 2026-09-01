/**
 * Заплатка «страница уходит на распознавание целиком» — на настоящей БД.
 *
 * Распознавание идёт по блокам: страница без блока не получает ни строки
 * текста, а дальше её не видит ни классификатор, ни сегментация — комплект
 * молча теряет напечатанный на ней документ. При этом «блоков не нашлось» —
 * штатный ответ детекции, а не сбой, и до S27 выход был ручной: открыть
 * «Разметку» и нажать «Заменить страницу одним блоком» на каждой такой странице.
 *
 * Предмет здесь — ПОЛИТИКА выбора страниц, и каждая её ветка проверяется
 * отдельно, потому что три из четырёх запрещают трогать страницу, и ошибка в
 * любой стоит по-своему: лишняя замена отправляет чертёж в текстовый промт,
 * пропущенная оставляет документ нераспознанным.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import type { AuthScope } from '../../auth/scope.js';
import {
  applyTextCoverageFallback,
  FALLBACK_LAYOUT_THRESHOLDS,
  findLayoutRevision,
  listLayoutBlocks,
} from './layout.js';
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
const WORK = id(4);
const REVISION = id(5);
const FILE = id(6);
const BUNDLE = id(7);
const LAYOUT = id(8);
const SHA = 'a'.repeat(64);

/** Пять страниц — по одной на каждую ветку политики плюс контрольная. */
const PAGE_COUNT = 5;
const PAGE_EMPTY = 0;
const PAGE_SPARSE = 1;
const PAGE_COVERED = 2;
const PAGE_SCHEME = 3;
const PAGE_MANUAL = 4;

const SCOPE: AuthScope = { kind: 'admin', userId: USER };

let testDb: TestDatabase;
let db: Database;

async function insertBlock(input: {
  readonly page: number;
  readonly blockType: 'text' | 'image' | 'stamp';
  readonly source: 'auto' | 'user';
  readonly rect: readonly [number, number, number, number];
  readonly sortOrder?: number;
}): Promise<void> {
  const [x0, y0, x1, y1] = input.rect;
  await testDb.query(
    `INSERT INTO layout_blocks
       (layout_revision_id, revision_id, bundle_id, source_page_id, working_page_index, object_id,
        block_type, shape_type, x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${LAYOUT}', '${REVISION}', '${BUNDLE}', '${id(100 + input.page)}', ${input.page},
             '${OBJECT}', '${input.blockType}', 'rectangle', ${x0}, ${y0}, ${x1}, ${y1},
             ${input.sortOrder ?? 0}, '${input.source}', 'rf_detr')`,
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
       VALUES ('${OBJECT}', 'FB01', 'Объект', 'ЖК «Фолбэк», корпус 1')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER}', 'kc-fallback', 'Сотрудник', '${ORG}')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    // Закрепление подрядчика за объектом держит ключом `works_contractor_fk`
    // (0028): комплект нельзя завести подрядчику, которого на объекте нет.
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG}') ON CONFLICT DO NOTHING`,
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
       VALUES ('${WORK}', '${OBJECT}', '${ORG}', '${ORG}', 'roofing', DATE '2026-01-01', 'Комплект', '${USER}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION}', '${WORK}', '${OBJECT}', '${ORG}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${SHA}', 'blobs/${SHA}', 1024, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${FILE}', '${REVISION}', '${SHA}', 'комплект.pdf', 0, 'ok')`,
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE}', '${REVISION}', '${'b'.repeat(64)}', '${SHA}', 'bundle/1+pdf-lib')`,
    `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
       VALUES ('${LAYOUT}', '${REVISION}', '${OBJECT}', '${BUNDLE}', 1, 'draft')`,
  ];
  for (const statement of fixture) await testDb.query(statement);

  for (let page = 0; page < PAGE_COUNT; page += 1) {
    await testDb.query(
      `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
         VALUES ('${id(100 + page)}', '${REVISION}', '${FILE}', ${page}, ${page}, 1654, 2339, 0)`,
    );
    await testDb.query(
      `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
         VALUES ('${BUNDLE}', '${REVISION}', ${page}, '${id(100 + page)}')`,
    );
  }

  // Страница 0 — без единого блока: детекция ничего не нашла.
  // Страница 1 — скудная разметка: заголовок найден, тело потеряно (4% листа).
  await insertBlock({
    page: PAGE_SPARSE,
    blockType: 'text',
    source: 'auto',
    rect: [0.1, 0.1, 0.9, 0.15],
  });
  // Страница 2 — покрыта нормально (72%).
  await insertBlock({
    page: PAGE_COVERED,
    blockType: 'text',
    source: 'auto',
    rect: [0.1, 0.1, 0.9, 0.9],
  });
  // Страница 3 — исполнительная схема: `image` плюс `stamp`, текста почти нет.
  await insertBlock({
    page: PAGE_SCHEME,
    blockType: 'image',
    source: 'auto',
    rect: [0.05, 0.05, 0.6, 0.4],
  });
  await insertBlock({
    page: PAGE_SCHEME,
    blockType: 'stamp',
    source: 'auto',
    rect: [0.7, 0.8, 0.95, 0.9],
    sortOrder: 1,
  });
  // Страница 4 — человек уже разметил её сам, покрытие при этом скудное.
  await insertBlock({
    page: PAGE_MANUAL,
    blockType: 'text',
    source: 'user',
    rect: [0.1, 0.1, 0.5, 0.2],
  });

  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

describe('applyTextCoverageFallback', () => {
  it('заменяет пустую и скудную страницы, не трогая остальные', async () => {
    const layout = await findLayoutRevision(db, SCOPE, LAYOUT);
    expect(layout).not.toBeNull();

    const result = await applyTextCoverageFallback(db, SCOPE, {
      layoutRevisionId: LAYOUT,
      expectedVersion: layout?.version ?? 0,
      thresholds: FALLBACK_LAYOUT_THRESHOLDS,
    });

    expect([...result.pages].sort()).toEqual([PAGE_EMPTY, PAGE_SPARSE]);
    // Версия поднята: вызывающий обязан идти по ней, иначе получит 412 на
    // изменение, сделанное этим же нажатием.
    expect(result.version).toBeGreaterThan(layout?.version ?? 0);

    const blocks = await listLayoutBlocks(db, SCOPE, LAYOUT);
    const byPage = new Map<number, typeof blocks>();
    for (const block of blocks) {
      byPage.set(block.workingPageIndex, [...(byPage.get(block.workingPageIndex) ?? []), block]);
    }

    // Пустая страница получила ровно один блок на весь лист.
    const empty = byPage.get(PAGE_EMPTY) ?? [];
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ blockType: 'text', x0: 0, y0: 0, x1: 1, y1: 1 });
    // `source='auto'` — условие обратимости: пришедшая позже пачка детекции
    // заменит заплатку. С `source='user'` страница закрылась бы навсегда.
    expect(empty[0]?.source).toBe('auto');
    expect(empty[0]?.detectorProvenance).toBe('full_page');

    // Скудная — прежний блок снесён, вместо него один на всю страницу.
    const sparse = byPage.get(PAGE_SPARSE) ?? [];
    expect(sparse).toHaveLength(1);
    expect(sparse[0]?.detectorProvenance).toBe('full_page');

    // Нормально покрытая — не тронута.
    expect(byPage.get(PAGE_COVERED)?.map((b) => b.detectorProvenance)).toEqual(['rf_detr']);

    // Исполнительная схема — не тронута: `image`/`stamp` единственный её
    // признак, а низкое покрытие текстом для неё нормально.
    expect(byPage.get(PAGE_SCHEME)).toHaveLength(2);

    // Ручная разметка — не тронута, хотя покрытие скудное: человек уже сказал,
    // как надо.
    expect(byPage.get(PAGE_MANUAL)?.map((b) => b.source)).toEqual(['user']);
  });

  it('отмечает тронутые страницы флагом внимания, не стирая прежние', async () => {
    const rows = await testDb.query<{ id: string; attention_flags: string[] }>(
      `SELECT id, attention_flags FROM source_pages WHERE revision_id = '${REVISION}' ORDER BY revision_ordinal`,
    );
    expect(rows[PAGE_EMPTY]?.attention_flags).toContain('text_fallback_applied');
    expect(rows[PAGE_SPARSE]?.attention_flags).toContain('text_fallback_applied');
    expect(rows[PAGE_COVERED]?.attention_flags ?? []).not.toContain('text_fallback_applied');
    expect(rows[PAGE_SCHEME]?.attention_flags ?? []).not.toContain('text_fallback_applied');
  });

  it('повтор ничего не меняет: заплатка уже покрывает страницу целиком', async () => {
    const layout = await findLayoutRevision(db, SCOPE, LAYOUT);
    const result = await applyTextCoverageFallback(db, SCOPE, {
      layoutRevisionId: LAYOUT,
      expectedVersion: layout?.version ?? 0,
      thresholds: FALLBACK_LAYOUT_THRESHOLDS,
    });

    // Ни одной цели: покрытие 100% — выше любого порога. Версия не поднимается,
    // потому что и транзакции не было.
    expect(result.pages).toEqual([]);
    expect(result.version).toBe(layout?.version);
  });

  it('нулевой порог оставляет скудные страницы детекции в покое', async () => {
    // Отдельная ревизия разметки: та, что выше, уже вся покрыта заплатками.
    // Черновик у поставки ровно один (`ux_layout_revisions_single_draft`),
    // поэтому прежний сначала уступает место.
    const layout2 = id(9);
    // `layout_revisions_superseded_chk` требует у нечерновой ревизии хэш набора:
    // вытесненная разметка описывает набор, по которому уже прошёл прогон.
    await testDb.query(
      `UPDATE layout_revisions
          SET state = 'superseded', blocks_hash = '${'c'.repeat(64)}'
        WHERE id = '${LAYOUT}'`,
    );
    await testDb.query(
      `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
         VALUES ('${layout2}', '${REVISION}', '${OBJECT}', '${BUNDLE}', 2, 'draft')`,
    );
    await testDb.query(
      `INSERT INTO layout_blocks
         (layout_revision_id, revision_id, bundle_id, source_page_id, working_page_index, object_id,
          block_type, shape_type, x0, y0, x1, y1, sort_order, source, detector_provenance)
       VALUES ('${layout2}', '${REVISION}', '${BUNDLE}', '${id(100 + PAGE_SPARSE)}', ${PAGE_SPARSE},
               '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.15, 0, 'auto', 'rf_detr')`,
    );

    const before = await findLayoutRevision(db, SCOPE, layout2);
    const result = await applyTextCoverageFallback(db, SCOPE, {
      layoutRevisionId: layout2,
      expectedVersion: before?.version ?? 0,
      // `0` — «только страницы БЕЗ единого блока»: скудная разметка остаётся
      // как есть, и это осознанный режим, а не выключение заплатки.
      thresholds: { ...FALLBACK_LAYOUT_THRESHOLDS, textFallbackCoverageRatio: 0 },
    });

    // Скудной страницы среди целей нет, пустые — есть.
    expect(result.pages).not.toContain(PAGE_SPARSE);
    expect(result.pages).toContain(PAGE_EMPTY);
  });

  /**
   * Правило 0: при `sheet_aware` крупный лист заплатке не принадлежит.
   *
   * Без него заплатка отменяла бы решение разметки ровно там, где оно принято
   * осознанно: на крупном листе портал ищет ТОЛЬКО штамп, и пустой лист — это
   * «штампа нет, нужен человек», а не «детекция не справилась». Полностраничный
   * `text` на A1 отправил бы чертёж в текстовый промт и стёр бы флаг, ради
   * которого страница и осталась пустой.
   *
   * Фикстура здесь удачна сама по себе: её страницы 1654×2339 pt — это A1 по
   * правилу форматов, то есть ровно тот случай, который заплатка обязана
   * пропустить.
   */
  describe('правило разметки по формату листа', () => {
    const layout3 = id(10);

    beforeAll(async () => {
      // Черновик у поставки ровно один: прежний уступает место.
      await testDb.query(
        `UPDATE layout_revisions
            SET state = 'superseded', blocks_hash = '${'d'.repeat(64)}'
          WHERE state = 'draft' AND revision_id = '${REVISION}'`,
      );
      await testDb.query(
        `INSERT INTO layout_revisions
           (id, revision_id, object_id, bundle_id, revision_no, state, markup_policy)
         VALUES ('${layout3}', '${REVISION}', '${OBJECT}', '${BUNDLE}', 3, 'draft',
                 '{"version":1,"sheetStrategy":"sheet_aware","numberZone":"near_stamp","numberZonePad":{"x":0.1,"y":0.25}}'::jsonb)`,
      );
    });

    it('крупные листы без блоков не получают полностраничной заплатки', async () => {
      const before = await findLayoutRevision(db, SCOPE, layout3);

      const result = await applyTextCoverageFallback(db, SCOPE, {
        layoutRevisionId: layout3,
        expectedVersion: before?.version ?? 0,
        thresholds: FALLBACK_LAYOUT_THRESHOLDS,
      });

      // Ни одной цели: все пять страниц крупные, хотя блоков нет ни на одной.
      expect(result.pages).toEqual([]);
      expect(await listLayoutBlocks(db, SCOPE, layout3)).toEqual([]);
    });

    it('малый лист заплатку по-прежнему получает', async () => {
      // Отрицательный контроль: правило снимает заплатку с КРУПНЫХ листов, а не
      // выключает её. Иначе A4 без блоков молча остался бы без текста.
      await testDb.query(
        `UPDATE source_pages SET width_px = 595, height_px = 842
          WHERE id = '${id(100 + PAGE_EMPTY)}'`,
      );
      const before = await findLayoutRevision(db, SCOPE, layout3);

      const result = await applyTextCoverageFallback(db, SCOPE, {
        layoutRevisionId: layout3,
        expectedVersion: before?.version ?? 0,
        thresholds: FALLBACK_LAYOUT_THRESHOLDS,
      });

      expect(result.pages).toEqual([PAGE_EMPTY]);
    });

    it('при detect_all крупный лист заплатку получает как раньше', async () => {
      // Правило обратимо: ревизия, размеченная прежним способом, судится
      // прежним способом — это и есть смысл пина.
      await testDb.query(
        `UPDATE layout_revisions
            SET markup_policy = '{"version":1,"sheetStrategy":"detect_all","numberZone":"off","numberZonePad":{"x":0.1,"y":0.25}}'::jsonb
          WHERE id = '${layout3}'`,
      );
      const before = await findLayoutRevision(db, SCOPE, layout3);

      const result = await applyTextCoverageFallback(db, SCOPE, {
        layoutRevisionId: layout3,
        expectedVersion: before?.version ?? 0,
        thresholds: FALLBACK_LAYOUT_THRESHOLDS,
      });

      expect(result.pages).toEqual([PAGE_SPARSE, PAGE_COVERED, PAGE_SCHEME, PAGE_MANUAL]);
    });
  });
});
