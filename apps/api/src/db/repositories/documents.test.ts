/**
 * Документы, учёт страниц, реквизиты и реестр — на PostgreSQL под миграциями.
 *
 * Проверяется не «функция вернула объект», а поведение, которое существует
 * только вместе с БД:
 *
 * 1. **Инвариант назначения страниц (§16, non-degradable §1.6).** Оба рубежа:
 *    представление `v_unaccounted_pages` ловит потерю страницы, уникальный
 *    индекс `page_assignments_page_uq` — страницу в двух документах. Обе
 *    проверки обязаны ОТМЕНЯТЬ транзакцию целиком, а не оставлять половину.
 * 2. **Класс `derived` у классификаций (0014).** В `in_review` писать можно, в
 *    `approved` нельзя. Проверяется в обе стороны: тест, знающий только про
 *    запрет, не заметил бы перерасширения — того самого, из-за которого на S2
 *    инженер не мог подтвердить тип документа.
 * 3. **Повтор не уничтожает работу человека.** Значение `manual` + `verified`
 *    переживает повторный прогон извлечения (урок S6).
 * 4. **Аудит подтверждения — в той же транзакции** (урок S4).
 * 5. **Кластеризация кандидатов в виды ИД.** Два акта с разными номерами и
 *    датами дают ОДНУ строку очереди, а решение администратора (`mapped`,
 *    `ignored`) конвейер не отменяет.
 * 6. **Изоляция** по каждому пути: чужие документы, страницы, реквизиты и
 *    строки реестра не читаются и не пишутся ни списком, ни по прямому
 *    идентификатору.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import type { AuthScope } from '../../auth/scope.js';
import { isHttpProblem } from '../../lib/problem.js';
import type {
  DecodedDocument,
  DecodedUnassigned,
  ExtractedField,
  PageClassification,
  ParsedRegistryRow,
} from '../../segmentation/types.js';
import { normalizeObservedTitle, observeDocTypeCandidate } from './catalog.js';
import {
  applySegmentation,
  confirmDocument,
  findLogicalDocument,
  listDocumentRelations,
  listFieldValues,
  listLogicalDocuments,
  listPageAssignments,
  listPageClassifications,
  listRegistryRows,
  listUnaccountedPages,
  loadSegmentationPages,
  saveDocumentRelations,
  saveFieldValues,
  savePageClassifications,
  saveRegistryMatches,
  saveRegistryRows,
  unconfirmDocument,
} from './documents.js';
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
const ORG_CUSTOMER = id(2);
const ORG_A = id(3);
const ORG_B = id(4);
const USER = id(5);

const FOLDER_A = id(21);
const FOLDER_B = id(23);
const FOLDER_REVIEW = id(25);
const FOLDER_APPROVED = id(27);

const FILE_A = id(30);
const FILE_B = id(31);
const FILE_REVIEW = id(32);
const FILE_APPROVED = id(33);

/** Ревизия А: четыре страницы — акт, его вторая страница, сертификат, пустая. */
const PAGE_A0 = id(40);
const PAGE_A1 = id(41);
const PAGE_A2 = id(42);
const PAGE_A3 = id(43);
const PAGE_B0 = id(44);
const PAGE_REVIEW0 = id(45);
const PAGE_APPROVED0 = id(46);

const BUNDLE_A = id(50);
const LAYOUT_A = id(51);
const RUN_DOC_A = id(52);
const RUN_A = id(53);
/** Прошлый прогон той же ревизии: его текст брать НЕЛЬЗЯ. */
const RUN_A_OLD = id(54);
const ARTIFACT_A = id(55);
const ARTIFACT_A_OLD = id(56);
const BLOCK_A0 = id(57);
const BLOCK_A0_STAMP = id(58);
const BLOCK_A2 = id(59);

const TEXT_A0 = id(60);
const TEXT_A1 = id(61);
const TEXT_A2 = id(62);
const TEXT_A0_OLD = id(63);

const SHA = (letter: string): string => letter.repeat(64);

const ADMIN: AuthScope = { kind: 'admin', userId: USER };
const CONTRACTOR_A: AuthScope = { kind: 'contractor', userId: USER, contractorId: ORG_A };
const CONTRACTOR_B: AuthScope = { kind: 'contractor', userId: USER, contractorId: ORG_B };
const ENGINEER: AuthScope = { kind: 'engineer', userId: USER };

const TEXT_ACT = 'АКТ освидетельствования скрытых работ № 336';
const TEXT_CERT = 'СЕРТИФИКАТ СООТВЕТСТВИЯ № РОСС RU Д-RU.РА01.В.17254/23';

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER}', 'kc-documents', 'Тестовый пользователь')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,

  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('a')}', 'blobs/${SHA('a')}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('b')}', 'blobs/${SHA('b')}', 1024, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('c')}', 'blobs/${SHA('c')}', 512, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('d')}', 'blobs/${SHA('d')}', 512, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('e')}', 'blobs/${SHA('e')}', 4096, 'application/pdf')`,

  // --- Ревизия А (draft, подрядчик А) --------------------------------------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_A}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Поставка А', '${USER}')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_A}', '${FOLDER_A}', '${SHA('a')}', 'akt.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A0}', '${FOLDER_A}', '${FILE_A}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A1}', '${FOLDER_A}', '${FILE_A}', 1, 1, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A2}', '${FOLDER_A}', '${FILE_A}', 2, 2, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A3}', '${FOLDER_A}', '${FILE_A}', 3, 3, 2339, 1654, 90)`,
  `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_A}', '${FOLDER_A}', '${SHA('e')}', '${SHA('b')}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${FOLDER_A}', 0, '${PAGE_A0}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${FOLDER_A}', 1, '${PAGE_A1}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${FOLDER_A}', 2, '${PAGE_A2}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${FOLDER_A}', 3, '${PAGE_A3}')`,
  `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no, state)
     VALUES ('${LAYOUT_A}', '${FOLDER_A}', '${OBJECT}', '${BUNDLE_A}', 1, 'draft')`,
  // Блоки: у первой страницы текст и штамп, у третьей — только текст, у
  // четвёртой блоков нет вовсе (A3-схема, которую детектор не разобрал).
  `INSERT INTO layout_blocks (id, layout_revision_id, folder_id, bundle_id, source_page_id,
                              working_page_index, object_id, block_type, shape_type,
                              x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${BLOCK_A0}', '${LAYOUT_A}', '${FOLDER_A}', '${BUNDLE_A}', '${PAGE_A0}',
             0, '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.4, 0, 'auto', 'rf_detr')`,
  `INSERT INTO layout_blocks (id, layout_revision_id, folder_id, bundle_id, source_page_id,
                              working_page_index, object_id, block_type, shape_type,
                              x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${BLOCK_A0_STAMP}', '${LAYOUT_A}', '${FOLDER_A}', '${BUNDLE_A}', '${PAGE_A0}',
             0, '${OBJECT}', 'stamp', 'rectangle', 0.1, 0.5, 0.4, 0.7, 1, 'auto', 'rf_detr')`,
  `INSERT INTO layout_blocks (id, layout_revision_id, folder_id, bundle_id, source_page_id,
                              working_page_index, object_id, block_type, shape_type,
                              x0, y0, x1, y1, sort_order, source, detector_provenance)
     VALUES ('${BLOCK_A2}', '${LAYOUT_A}', '${FOLDER_A}', '${BUNDLE_A}', '${PAGE_A2}',
             2, '${OBJECT}', 'text', 'rectangle', 0.1, 0.1, 0.9, 0.4, 0, 'auto', 'rf_detr')`,
  `UPDATE layout_revisions SET blocks_hash = '${SHA('7')}'
     WHERE id = '${LAYOUT_A}'`,
  `INSERT INTO rd_run_documents (id, layout_revision_id, rd_document_id, rd_project_id)
     VALUES ('${RUN_DOC_A}', '${LAYOUT_A}', 'doc_a', 'prj-portal')`,
  // Прошлый прогон — завершён раньше; его текст брать нельзя.
  `INSERT INTO recognition_runs (id, folder_id, layout_revision_id, rd_run_document_id,
                                 local_layout_hash, working_pdf_sha256, status, started_at, finished_at)
     VALUES ('${RUN_A_OLD}', '${FOLDER_A}', '${LAYOUT_A}', '${RUN_DOC_A}',
             '${SHA('7')}', '${SHA('b')}', 'done', now() - interval '2 hours', now() - interval '2 hours')`,
  `INSERT INTO recognition_runs (id, folder_id, layout_revision_id, rd_run_document_id,
                                 local_layout_hash, working_pdf_sha256, status, started_at, finished_at)
     VALUES ('${RUN_A}', '${FOLDER_A}', '${LAYOUT_A}', '${RUN_DOC_A}',
             '${SHA('7')}', '${SHA('b')}', 'done', now() - interval '1 hour', now())`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ARTIFACT_A_OLD}', '${RUN_A_OLD}', 'md', 'artifacts/old.md', '${SHA('3')}', 10)`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ARTIFACT_A}', '${RUN_A}', 'md', 'artifacts/new.md', '${SHA('4')}', 20)`,
  `INSERT INTO page_text_versions (id, folder_id, source_page_id, recognition_run_id,
                                   artifact_version_id, text_md, text_sha256)
     VALUES ('${TEXT_A0_OLD}', '${FOLDER_A}', '${PAGE_A0}', '${RUN_A_OLD}', '${ARTIFACT_A_OLD}',
             'ТЕКСТ ПРОШЛОГО ПРОГОНА', '${SHA('5')}')`,
  `INSERT INTO page_text_versions (id, folder_id, source_page_id, recognition_run_id,
                                   artifact_version_id, text_md, text_sha256)
     VALUES ('${TEXT_A0}', '${FOLDER_A}', '${PAGE_A0}', '${RUN_A}', '${ARTIFACT_A}',
             '${TEXT_ACT}', '${SHA('6')}')`,
  `INSERT INTO page_text_versions (id, folder_id, source_page_id, recognition_run_id,
                                   artifact_version_id, text_md, text_sha256)
     VALUES ('${TEXT_A1}', '${FOLDER_A}', '${PAGE_A1}', '${RUN_A}', '${ARTIFACT_A}',
             'Продолжение акта', '${SHA('8')}')`,
  `INSERT INTO page_text_versions (id, folder_id, source_page_id, recognition_run_id,
                                   artifact_version_id, text_md, text_sha256)
     VALUES ('${TEXT_A2}', '${FOLDER_A}', '${PAGE_A2}', '${RUN_A}', '${ARTIFACT_A}',
             '${TEXT_CERT}', '${SHA('9')}')`,

  // --- Ревизия Б (чужая) ----------------------------------------------------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_B}', '${OBJECT}', '${ORG_B}', '${ORG_B}', 'roofing', DATE '2026-01-01', 'Поставка Б', '${USER}')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_B}', '${FOLDER_B}', '${SHA('c')}', 'chuzhoy.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_B0}', '${FOLDER_B}', '${FILE_B}', 0, 0, 1654, 2339, 0)`,

  // --- Ревизия на проверке (in_review): класс derived писать РАЗРЕШЕНО -------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_REVIEW}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Поставка на проверке', '${USER}')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_REVIEW}', '${FOLDER_REVIEW}', '${SHA('d')}', 'review.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_REVIEW0}', '${FOLDER_REVIEW}', '${FILE_REVIEW}', 0, 0, 1654, 2339, 0)`,

  // --- Согласованная ревизия: класс derived писать ЗАПРЕЩЕНО -----------------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_APPROVED}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Поставка согласованная', '${USER}')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_APPROVED}', '${FOLDER_APPROVED}', '${SHA('d')}', 'approved.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_APPROVED0}', '${FOLDER_APPROVED}', '${FILE_APPROVED}', 0, 0, 1654, 2339, 0)`,
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
}, 240_000);

afterAll(async () => {
  await testDb.close();
});

const ACTOR = { emailHmac: null, ip: null, requestId: null };

function classification(
  sourcePageId: string,
  overrides: Partial<PageClassification> = {},
): PageClassification {
  return {
    sourcePageId,
    label: 'B-DOC',
    docTypeCode: 'aosr',
    typeOutcome: 'known',
    observedTitle: null,
    pageRoleCode: null,
    parentRef: null,
    confidence: 0.9,
    reason: 'якорь заголовка',
    source: 'anchor',
    alternatives: [],
    ambiguous: false,
    evidence: null,
    ...overrides,
  };
}

function decoded(
  ordinal: number,
  pages: readonly string[],
  overrides: Partial<DecodedDocument> = {},
): DecodedDocument {
  return {
    ordinal,
    docTypeCode: 'aosr',
    title: 'АКТ освидетельствования скрытых работ',
    typeConfidence: 0.9,
    boundaryConfidence: 0.8,
    needsReview: false,
    observedTitle: null,
    pages: pages.map((sourcePageId, index) => ({
      sourcePageId,
      sortOrder: index,
      pageRoleCode: null,
    })),
    ...overrides,
  };
}

function unassigned(sourcePageId: string, reason = 'пустая страница'): DecodedUnassigned {
  return { sourcePageId, reason, needsReview: true };
}

/** Полная сегментация ревизии А: все четыре страницы учтены. */
const FULL_SEGMENTATION = {
  folderId: FOLDER_A,
  documents: [
    decoded(0, [PAGE_A0, PAGE_A1]),
    decoded(1, [PAGE_A2], { docTypeCode: 'cert_conformity' }),
  ],
  unassigned: [unassigned(PAGE_A3)],
  extractorVersion: 'seg/1',
} as const;

async function countRows(sql: string): Promise<number> {
  const rows = await testDb.query<{ n: string | number }>(sql);
  return Number(rows[0]?.n ?? 0);
}

// =====================================================================
// Классификация страниц
// =====================================================================

describe('savePageClassifications', () => {
  it('заменяет набор целиком и сохраняет доказательство', async () => {
    const first = await savePageClassifications(db, ADMIN, {
      folderId: FOLDER_A,
      classifications: [classification(PAGE_A0), classification(PAGE_A1, { label: 'I-DOC' })],
    });
    expect(first).toEqual({ removed: 0, written: 2 });

    const second = await savePageClassifications(db, ADMIN, {
      folderId: FOLDER_A,
      classifications: [
        classification(PAGE_A0, {
          evidence: {
            pageTextVersionId: TEXT_A0,
            charStart: 0,
            charEnd: 3,
            quote: TEXT_ACT.slice(0, 3),
          },
        }),
        classification(PAGE_A1, { label: 'I-DOC' }),
        classification(PAGE_A2, { docTypeCode: 'cert_conformity' }),
        classification(PAGE_A3, {
          label: 'U',
          docTypeCode: null,
          typeOutcome: 'none',
          confidence: 0.1,
          source: 'blocks',
          reason: 'блоков на странице нет',
        }),
      ],
    });
    // Прошлый набор снят целиком, а не дополнен: два решения по одной странице
    // означали бы, что задача 15 выбирает из них молча.
    expect(second).toEqual({ removed: 2, written: 4 });

    const items = await listPageClassifications(db, ADMIN, FOLDER_A);
    expect(items.map((item) => item.sourcePageId)).toEqual([PAGE_A0, PAGE_A1, PAGE_A2, PAGE_A3]);
    expect(items[0]?.charSpan).toEqual({ start: 0, end: 3 });
    expect(items[0]?.quote).toBe('АКТ');
    expect(items[0]?.pageTextVersionId).toBe(TEXT_A0);
    expect(items[3]?.typeOutcome).toBe('none');
  });

  /**
   * Ключевое ограничение 0014: без наблюдённого заголовка документ незнакомого
   * типа НЕ попадёт в `doc_type_candidates`, то есть цикл роста каталога (§3.2)
   * сломается молча — резервный тип есть, задача зелёная, очередь пуста.
   */
  it('исход «other» без наблюдённого заголовка отвергается базой', async () => {
    await expect(
      savePageClassifications(db, ADMIN, {
        folderId: FOLDER_A,
        classifications: [
          classification(PAGE_A0, {
            typeOutcome: 'other',
            docTypeCode: null,
            observedTitle: null,
          }),
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Транзакция откатилась целиком: прежний набор на месте.
    expect(await listPageClassifications(db, ADMIN, FOLDER_A)).toHaveLength(4);
  });

  it('заголовок из одних пробелов тоже отвергается', async () => {
    await expect(
      savePageClassifications(db, ADMIN, {
        folderId: FOLDER_A,
        classifications: [
          classification(PAGE_A0, {
            typeOutcome: 'other',
            docTypeCode: null,
            observedTitle: '   ',
          }),
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  /**
   * Класс `derived` (0014) в ОБЕ стороны. Тест, знающий только про запрет, не
   * заметил бы перерасширения: на S2 инженер из-за него не мог подтвердить тип
   * документа на поданной ревизии.
   */
});

// =====================================================================
// Применение сегментации — центральный инвариант §16
// =====================================================================

describe('applySegmentation', () => {
  it('переписывает документы, учитывает все страницы и отдаёт счётчики', async () => {
    const outcome = await applySegmentation(db, ADMIN, FULL_SEGMENTATION);

    expect(outcome.documentsCreated).toBe(2);
    // На пустой ревизии переписывать нечего. Счётчик отличает «собрано на
    // чистом месте» от «собрано вместо прежней сборки» — по одному только
    // `documentsCreated` эти исходы неразличимы.
    expect(outcome.documentsReplaced).toBe(0);
    expect(outcome.pagesAssigned).toBe(3);
    expect(outcome.pagesUnassigned).toBe(1);
    expect(outcome.registryRowsUnlinked).toBe(0);

    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    expect(documents.map((d) => d.ordinal)).toEqual([0, 1]);
    expect(documents[0]?.pageCount).toBe(2);
    expect(documents[1]?.docTypeCode).toBe('cert_conformity');
    // Версия для `If-Match` начинается с нуля, а не с «неизвестно».
    expect(documents[0]?.version).toBe(0);

    const assignments = await listPageAssignments(db, ADMIN, FOLDER_A);
    expect(assignments).toHaveLength(4);
    // Непривязанная страница существует ЯВНОЙ строкой с причиной: отсутствие
    // строки не отличить от потерянной страницы.
    const blank = assignments.find((page) => page.sourcePageId === PAGE_A3);
    expect(blank?.documentId).toBeNull();
    expect(blank?.reason).toBe('пустая страница');

    expect(await listUnaccountedPages(db, ADMIN, FOLDER_A)).toEqual([]);
  });

  it('лист, присоединённый по соседству, помечен и объяснён', async () => {
    /**
     * Приложение без напечатанного номера родителя присоединяется к соседнему
     * документу (S44): на боевой папке это было 17 из 27 непривязанных листов, и
     * каждый уменьшал покрытие, по которому правила полноты решают, вправе ли
     * они сказать «документа нет в комплекте».
     *
     * Присоединение по соседству — довод, а не доказательство, поэтому лист
     * несёт и пометку, и причину. Пометки без причины мало: «проверьте» без
     * «что именно» человек проверить не может.
     */
    await applySegmentation(db, ADMIN, {
      folderId: FOLDER_A,
      documents: [
        {
          ...decoded(0, [PAGE_A0, PAGE_A1]),
          pages: [
            { sourcePageId: PAGE_A0, sortOrder: 0, pageRoleCode: null },
            {
              sourcePageId: PAGE_A1,
              sortOrder: 1,
              pageRoleCode: null,
              needsReview: true,
              reviewReason: 'номер родительского документа на приложении не назван',
            },
          ],
        },
        decoded(1, [PAGE_A2], { docTypeCode: 'cert_conformity' }),
      ],
      unassigned: [unassigned(PAGE_A3)],
      extractorVersion: 'seg/1',
    });

    const assignments = await listPageAssignments(db, ADMIN, FOLDER_A);
    const flagged = assignments.find((page) => page.sourcePageId === PAGE_A1);
    expect(flagged?.needsReview).toBe(true);
    expect(flagged?.reviewReason).toBe('номер родительского документа на приложении не назван');

    // Соседний лист того же документа сомнения не наследует: пометка про ЛИСТ,
    // а не про документ.
    const clean = assignments.find((page) => page.sourcePageId === PAGE_A0);
    expect(clean?.needsReview).toBe(false);
    expect(clean?.reviewReason).toBeNull();
  });

  /**
   * ПЕРВЫЙ РУБЕЖ инварианта §1.6: потеря страницы.
   *
   * Сегментация «забыла» страницу A3. `v_unaccounted_pages` внутри транзакции
   * обязан это увидеть и ОТМЕНИТЬ всё: half-applied сегментация хуже отказа,
   * потому что выглядит выполненной.
   */
  it('потерянная страница отменяет всю транзакцию', async () => {
    const before = await listLogicalDocuments(db, ADMIN, FOLDER_A);

    await expect(
      applySegmentation(db, ADMIN, {
        folderId: FOLDER_A,
        documents: [decoded(0, [PAGE_A0, PAGE_A1]), decoded(1, [PAGE_A2])],
        unassigned: [],
        extractorVersion: 'seg/1',
      }),
    ).rejects.toMatchObject({ status: 409 });

    const after = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    // Прежняя сборка на месте — ни одного документа не потеряно и не создано.
    expect(after.map((d) => d.id).sort()).toEqual(before.map((d) => d.id).sort());
    expect(await listPageAssignments(db, ADMIN, FOLDER_A)).toHaveLength(4);
    expect(await listUnaccountedPages(db, ADMIN, FOLDER_A)).toEqual([]);
  });

  /**
   * ВТОРОЙ РУБЕЖ: страница в двух местах. Его держит уникальный индекс
   * `page_assignments_page_uq`, а не проверка в коде.
   */
  it('страница в двух документах отвергается уникальным индексом', async () => {
    await expect(
      applySegmentation(db, ADMIN, {
        folderId: FOLDER_A,
        documents: [decoded(0, [PAGE_A0, PAGE_A1]), decoded(1, [PAGE_A1, PAGE_A2])],
        unassigned: [unassigned(PAGE_A3)],
        extractorVersion: 'seg/1',
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await listPageAssignments(db, ADMIN, FOLDER_A)).toHaveLength(4);
  });

  it('страница, привязанная и непривязанная одновременно, отвергается тем же индексом', async () => {
    await expect(
      applySegmentation(db, ADMIN, {
        folderId: FOLDER_A,
        documents: [decoded(0, [PAGE_A0, PAGE_A1, PAGE_A2, PAGE_A3])],
        unassigned: [unassigned(PAGE_A3)],
        extractorVersion: 'seg/1',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('страница чужой ревизии в сборку не попадает', async () => {
    await expect(
      applySegmentation(db, ADMIN, {
        folderId: FOLDER_A,
        documents: [decoded(0, [PAGE_A0, PAGE_A1, PAGE_B0])],
        unassigned: [unassigned(PAGE_A2), unassigned(PAGE_A3)],
        extractorVersion: 'seg/1',
      }),
    ).rejects.toThrow();
    expect(await listPageAssignments(db, ADMIN, FOLDER_A)).toHaveLength(4);
  });
});

// =====================================================================
// Реестр приложений и пересегментация
// =====================================================================

describe('реестр приложений', () => {
  it('строки реестра пишутся, сверяются и читаются', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const registryDocument = documents[0];
    const matchedDocument = documents[1];
    expect(registryDocument).toBeDefined();
    expect(matchedDocument).toBeDefined();
    if (registryDocument === undefined || matchedDocument === undefined) return;

    const rows: readonly ParsedRegistryRow[] = [
      {
        rowNo: 1,
        sectionTitle: 'Документы, подтверждающие качество',
        docNameRaw: 'Сертификат соответствия',
        docNoRaw: 'РОСС RU Д-RU.РА01.В.17254/23',
        orgRaw: 'ООО «Поставщик»',
        docNoNorm: 'РОССRUД-RU.РА01.В.17254/23',
        docNoFolded: 'POCCRUD-RU.PA01.B.17254/23',
        validFrom: '2026-01-01',
        validTo: '2027-01-01',
        issuedAt: '2026-01-01',
      },
      {
        rowNo: 2,
        sectionTitle: null,
        docNameRaw: 'Паспорт качества',
        docNoRaw: '16005',
        orgRaw: null,
        docNoNorm: '16005',
        docNoFolded: '16005',
        validFrom: null,
        validTo: null,
        issuedAt: '2026-02-02',
      },
    ];

    const saved = await saveRegistryRows(db, ADMIN, {
      folderId: FOLDER_A,
      documentId: registryDocument.id,
      rows,
    });
    expect(saved).toEqual({ removed: 0, written: 2 });

    const listed = await listRegistryRows(db, ADMIN, FOLDER_A);
    expect(listed).toHaveLength(2);
    expect(listed.every((row) => row.matchState === 'missing')).toBe(true);

    const target = listed.find((row) => row.rowNo === 1);
    expect(target).toBeDefined();
    if (target === undefined) return;

    const matched = await saveRegistryMatches(db, ADMIN, {
      folderId: FOLDER_A,
      matches: [
        {
          registryRowId: target.id,
          matchedDocumentId: matchedDocument.id,
          matchScore: 1,
          matchState: 'matched',
          candidates: [],
        },
        // Строка не из этой ревизии: пропуск обязан считаться, а не молчаться.
        {
          registryRowId: id(999),
          matchedDocumentId: null,
          matchScore: null,
          matchState: 'missing',
          candidates: [],
        },
      ],
    });
    expect(matched).toEqual({ updated: 1, skipped: 1 });

    const afterMatch = await listRegistryRows(db, ADMIN, FOLDER_A);
    expect(afterMatch.find((row) => row.rowNo === 1)?.matchState).toBe('matched');
  });

  /**
   * Пересегментация снимает привязку, но не уносит строку реестра: реестр —
   * самостоятельный факт поставки, а `matched` без документа запрещён
   * `registry_rows_matched_chk`.
   */
  it('пересегментация снимает привязку строк реестра и считает их', async () => {
    const outcome = await applySegmentation(db, ADMIN, {
      ...FULL_SEGMENTATION,
      documents: [decoded(0, [PAGE_A0]), decoded(1, [PAGE_A1, PAGE_A2])],
      unassigned: [unassigned(PAGE_A3)],
    });
    expect(outcome.registryRowsUnlinked).toBe(1);
    // Прежняя сборка из двух документов переписана — и это видно счётчиком,
    // а не выводится из совпадения `documentsCreated` с прошлым прогоном.
    expect(outcome.documentsReplaced).toBe(2);

    // Строки реестра принадлежали удалённому документу-реестру и ушли каскадом
    // вместе с ним: это тот же документ, разобранный заново.
    expect(await listRegistryRows(db, ADMIN, FOLDER_A)).toEqual([]);
    expect(await listUnaccountedPages(db, ADMIN, FOLDER_A)).toEqual([]);
  });
});

// =====================================================================
// Реквизиты
// =====================================================================

describe('saveFieldValues', () => {
  function field(code: string, overrides: Partial<ExtractedField> = {}): ExtractedField {
    return {
      fieldCode: code,
      valueText: 'значение',
      valueDate: null,
      valueNum: null,
      valueJson: null,
      confidence: 0.8,
      extractedBy: 'rule',
      evidence: null,
      ...overrides,
    };
  }

  it('заменяет значения версии экстрактора и НЕ трогает проверенное ручное', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const document = documents[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    await saveFieldValues(db, ADMIN, {
      folderId: FOLDER_A,
      documentId: document.id,
      extractorVersion: 'ext/1',
      fields: [
        field('number', { valueText: 'ГИ-77' }),
        field('issued_at', { valueText: null, valueDate: '2026-05-12' }),
      ],
    });

    // Инженер исправил номер руками и подтвердил значение.
    await testDb.query(
      `INSERT INTO field_values (folder_id, document_id, field_code, value_text, extractor_version,
                                 extracted_by, is_verified)
         VALUES ('${FOLDER_A}', '${document.id}', 'number', 'ГИ-77/исправлено', 'ext/1', 'manual', true)`,
    );

    const again = await saveFieldValues(db, ADMIN, {
      folderId: FOLDER_A,
      documentId: document.id,
      extractorVersion: 'ext/1',
      fields: [field('number', { valueText: 'ГИ-78' })],
    });

    expect(again.removed).toBe(2);
    expect(again.written).toBe(1);
    // Главное утверждение: работа человека пережила повтор прогона.
    expect(again.preservedManual).toBe(1);

    const values = await listFieldValues(db, ADMIN, document.id);
    const manual = values.find((value) => value.extractedBy === 'manual');
    expect(manual?.valueText).toBe('ГИ-77/исправлено');
    expect(values.filter((value) => value.extractedBy === 'rule')).toHaveLength(1);
  });

  it('доказательство пишется тройкой: версия текста, диапазон и цитата', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const document = documents.find((d) => d.pageCount > 0);
    expect(document).toBeDefined();
    if (document === undefined) return;

    await saveFieldValues(db, ADMIN, {
      folderId: FOLDER_A,
      documentId: document.id,
      extractorVersion: 'ext/2',
      fields: [
        field('product_name', {
          valueText: 'АКТ',
          evidence: {
            pageTextVersionId: TEXT_A0,
            charStart: 0,
            charEnd: 3,
            quote: TEXT_ACT.slice(0, 3),
          },
        }),
      ],
    });

    const values = await listFieldValues(db, ADMIN, document.id);
    const withEvidence = values.find((value) => value.extractorVersion === 'ext/2');
    expect(withEvidence?.charSpan).toEqual({ start: 0, end: 3 });
    expect(withEvidence?.pageTextVersionId).toBe(TEXT_A0);
  });
});

// =====================================================================
// Граф документов и подтверждение
// =====================================================================

describe('граф и подтверждение', () => {
  it('связи пересобираются целиком, чужие документы отбрасываются со счётчиком', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const parent = documents[0];
    const child = documents[1];
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    if (parent === undefined || child === undefined) return;

    const saved = await saveDocumentRelations(db, ADMIN, {
      folderId: FOLDER_A,
      relations: [
        { parentDocumentId: parent.id, childDocumentId: child.id, relation: 'quality_doc' },
        // Ссылка на несуществующий документ и петля: отбрасываются явно.
        { parentDocumentId: parent.id, childDocumentId: id(998), relation: 'annex' },
        { parentDocumentId: parent.id, childDocumentId: parent.id, relation: 'annex' },
      ],
    });
    expect(saved).toEqual({ removed: 0, written: 1, skipped: 2 });

    expect(await listDocumentRelations(db, ADMIN, FOLDER_A)).toEqual([
      { parentDocumentId: parent.id, childDocumentId: child.id, relation: 'quality_doc' },
    ]);

    const replaced = await saveDocumentRelations(db, ADMIN, {
      folderId: FOLDER_A,
      relations: [],
    });
    expect(replaced).toEqual({ removed: 1, written: 0, skipped: 0 });
  });

  it('подтверждение поднимает версию и пишет audit_log ТОЙ ЖЕ транзакцией', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const document = documents[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    const auditBefore = await countRows(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'document.confirmed'`,
    );

    const confirmed = await confirmDocument(db, ADMIN, {
      documentId: document.id,
      actorUserId: USER,
      expectedVersion: document.version,
      docTypeCode: 'mill_certificate',
      actor: ACTOR,
    });

    expect(confirmed.isConfirmed).toBe(true);
    expect(confirmed.confirmedBy).toBe(USER);
    expect(confirmed.docTypeCode).toBe('mill_certificate');
    expect(confirmed.version).toBe(document.version + 1);
    expect(confirmed.needsReview).toBe(false);

    expect(
      await countRows(`SELECT count(*) AS n FROM audit_log WHERE action = 'document.confirmed'`),
    ).toBe(auditBefore + 1);
  });

  it('устаревшая версия в If-Match даёт 412 и ничего не меняет', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const document = documents[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    await expect(
      confirmDocument(db, ADMIN, {
        documentId: document.id,
        actorUserId: USER,
        expectedVersion: document.version - 1,
        docTypeCode: 'aosr',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ status: 412 });

    const fresh = await findLogicalDocument(db, ADMIN, document.id);
    expect(fresh?.docTypeCode).toBe('mill_certificate');
    expect(fresh?.version).toBe(document.version);
  });
});

// =====================================================================
// Подтверждение человека переживает пересегментацию
// =====================================================================

/**
 * §8.2: ручная разметка приоритетна. Проверяется на уровне РЕПОЗИТОРИЯ, то есть
 * мимо обработчика задачи 15, — потому что уничтожает подтверждение именно
 * `DELETE FROM logical_documents` внутри `applySegmentation`, а охранник,
 * стоящий у одного вызывающего, защищает ровно этого вызывающего.
 *
 * Блок идёт ПОСЛЕ «граф и подтверждение» намеренно: документ там уже подтверждён
 * настоящим `confirmDocument`, а не помечен вручную UPDATE'ом. Проверять запрет
 * на состоянии, собранном в обход продукта, значило бы проверять свой же фикстур.
 */
describe('пересегментация не переписывает подтверждённое', () => {
  async function confirmedIds(): Promise<readonly string[]> {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    return documents.filter((document) => document.isConfirmed).map((document) => document.id);
  }

  it('репозиторий отказывает и подтверждение уцелевает', async () => {
    const confirmed = await confirmedIds();
    expect(confirmed.length).toBeGreaterThan(0);
    const before = await listLogicalDocuments(db, ADMIN, FOLDER_A);

    const rejection = applySegmentation(db, ADMIN, {
      folderId: FOLDER_A,
      documents: [decoded(0, [PAGE_A0, PAGE_A1, PAGE_A2])],
      unassigned: [unassigned(PAGE_A3)],
      extractorVersion: 'seg/1',
    });
    // Текст именно репозиторного отказа, а не триггера: он называет ЧИСЛО
    // подтверждённых документов, и по нему видно, что отказ наступил ДО
    // удаления, а не был пойман последним рубежом.
    await expect(rejection).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(
        /\d+ подтверждённых человеком документов/u,
      ) as unknown as string,
    });

    const after = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    expect(after.map((document) => document.id).sort()).toEqual(
      before.map((document) => document.id).sort(),
    );
    expect(await confirmedIds()).toEqual(confirmed);
    // Документ, подтверждённый как `mill_certificate`, не превратился обратно
    // в предположение конвейера.
    expect(after.find((document) => document.id === confirmed[0])?.docTypeCode).toBe(
      'mill_certificate',
    );
    expect(await listUnaccountedPages(db, ADMIN, FOLDER_A)).toEqual([]);
  });

  it('триггер БД отвергает удаление подтверждённого документа и прямым SQL', async () => {
    const confirmed = await confirmedIds();
    expect(confirmed.length).toBeGreaterThan(0);

    // Запрет обязан держаться независимо от того, какой код удаляет строку:
    // «второго вызывающего пока не написали» — не инвариант.
    await expect(
      testDb.query(`DELETE FROM logical_documents WHERE id = '${confirmed[0] ?? ''}'`),
    ).rejects.toThrow(/подтверждён человеком/u);

    expect(await confirmedIds()).toEqual(confirmed);
  });

  it('после снятия подтверждения пересегментация проходит', async () => {
    // Положительный путь: запрет не перерасширен. Снятие подтверждения — это
    // UPDATE, и триггер его не трогает; иначе документ оказался бы запертым
    // навсегда, а это ровно то перерасширение, которое пришлось откатывать на S2.
    for (const id of await confirmedIds()) {
      await testDb.query(
        `UPDATE logical_documents SET is_confirmed = false, confirmed_by = NULL,
                                      confirmed_at = NULL
           WHERE id = '${id}'`,
      );
    }
    expect(await confirmedIds()).toEqual([]);

    const outcome = await applySegmentation(db, ADMIN, FULL_SEGMENTATION);
    expect(outcome.documentsCreated).toBe(2);
    expect(outcome.documentsReplaced).toBeGreaterThan(0);
    expect(await listUnaccountedPages(db, ADMIN, FOLDER_A)).toEqual([]);
  });

  it('свои, машинные подтверждения пересегментацию не запирают', async () => {
    // Границы, собранные конвейером, он же и подтверждает — иначе не поедет
    // нарезка (`logical_documents_derived_confirmed_chk`). Если бы охранник
    // смотрел на один `is_confirmed`, портал запретил бы себе пересобирать
    // собственную работу после первого же прогона, и повторное распознавание
    // стало бы невозможным. Ровно это заказчик увидел как «непонятные ошибки
    // после пересборки».
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.every((document) => document.isConfirmed)).toBe(true);
    expect(documents.every((document) => document.confirmationSource === 'machine')).toBe(true);
    expect(documents.every((document) => document.confirmedBy === null)).toBe(true);

    const outcome = await applySegmentation(db, ADMIN, FULL_SEGMENTATION);
    expect(outcome.documentsReplaced).toBeGreaterThan(0);
  });

  it('триггер пропускает удаление машинно подтверждённого документа', async () => {
    // Иначе автоподтверждение заперло бы удаление и замену файла:
    // `logical_documents` входит в `DERIVED_DELETES`, и purge падал бы на
    // каждом разобранном комплекте.
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const victim = documents.at(-1)?.id ?? '';
    await testDb.query(`DELETE FROM page_assignments WHERE document_id = '${victim}'`);
    await testDb.query(`DELETE FROM logical_documents WHERE id = '${victim}'`);

    const rest = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    expect(rest.map((document) => document.id)).not.toContain(victim);

    // Учёт страниц восстанавливается пересегментацией: тест не оставляет за
    // собой ревизию с потерянными страницами.
    await applySegmentation(db, ADMIN, FULL_SEGMENTATION);
    expect(await listUnaccountedPages(db, ADMIN, FOLDER_A)).toEqual([]);
  });

  it('снятие подтверждения обнуляет нарезку вместе с ним', async () => {
    // Требование схемы, а не уборка: `logical_documents_derived_confirmed_chk`
    // не примет неподтверждённый документ с непустой нарезкой, а
    // `..._derived_provenance_chk` требует, чтобы провенанс был полон или пуст
    // целиком. Смысл тот же: границы снова под вопросом, и прежний PDF
    // описывает уже не тот документ.
    const [target] = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    if (target === undefined) throw new Error('фикстура пуста');

    await testDb.query(
      `UPDATE logical_documents
          SET derived_pdf_blob_sha256 = '${SHA('c')}', derived_pdf_page_count = 1,
              derived_pdf_bytes = 512, derived_pdf_built_at = now(),
              derived_pdf_toolkit = 'qpdf/11', derived_note_applied = true
        WHERE id = '${target.id}'`,
    );

    const fresh = await unconfirmDocument(db, ADMIN, {
      documentId: target.id,
      actorUserId: USER,
      expectedVersion: target.version,
      actor: ACTOR,
    });

    expect(fresh.isConfirmed).toBe(false);
    expect(fresh.confirmedBy).toBeNull();
    const rows = await testDb.query<{ derived_pdf_blob_sha256: string | null }>(
      `SELECT derived_pdf_blob_sha256 FROM logical_documents WHERE id = '${target.id}'`,
    );
    expect(rows[0]?.derived_pdf_blob_sha256).toBeNull();

    // И пересегментация снова возможна — ровно то, что обещает текст отказа.
    await applySegmentation(db, ADMIN, FULL_SEGMENTATION);
    expect(await listUnaccountedPages(db, ADMIN, FOLDER_A)).toEqual([]);
  });
});

// =====================================================================
// Вход сегментации
// =====================================================================

describe('loadSegmentationPages', () => {
  it('берёт текст ОДНОГО последнего прогона и отдаёт все страницы ревизии', async () => {
    const input = await loadSegmentationPages(db, ADMIN, FOLDER_A);

    expect(input.recognitionRunId).toBe(RUN_A);
    expect(input.pages).toHaveLength(4);
    expect(input.pages.map((page) => page.folderOrdinal)).toEqual([0, 1, 2, 3]);

    // Текст прошлого прогона не подмешивается: `char_span` доказательств
    // измеряется в конкретной версии текста.
    expect(input.pages[0]?.text).toBe(TEXT_ACT);
    expect(input.pages[0]?.pageTextVersionId).toBe(TEXT_A0);
    expect(input.pages[0]?.text).not.toContain('ПРОШЛОГО');

    // Страница без текста доходит до декодера, а не выпадает из входа.
    expect(input.pages[3]?.text).toBe('');
    expect(input.pages[3]?.pageTextVersionId).toBeNull();
    expect(input.pages[3]?.rotation).toBe(90);

    // Состав блоков: именно им ловятся исполнительные схемы, которые текстом не
    // определяются вовсе.
    expect(input.pages[0]?.blockTypes).toEqual(['stamp', 'text']);
    expect(input.pages[2]?.blockTypes).toEqual(['text']);
    expect(input.pages[3]?.blockTypes).toEqual([]);
    expect(input.pages[0]?.workingPageIndex).toBe(0);
  });

  it('без завершённого прогона отдаёт null и пустой список, а не исключение', async () => {
    const input = await loadSegmentationPages(db, ADMIN, FOLDER_REVIEW);
    expect(input).toEqual({ recognitionRunId: null, pages: [] });
  });

  it('чужая ревизия не читается', async () => {
    await expect(loadSegmentationPages(db, CONTRACTOR_B, FOLDER_A)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// =====================================================================
// Изоляция (§1.6, non-degradable)
// =====================================================================

describe('изоляция подрядчиков', () => {
  it('чужие документы не видны ни списком, ни по прямому идентификатору', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const document = documents[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    expect(await listLogicalDocuments(db, CONTRACTOR_B, FOLDER_A)).toEqual([]);
    expect(await findLogicalDocument(db, CONTRACTOR_B, document.id)).toBeNull();
    // Владелец те же данные получает — иначе тест доказывал бы лишь пустую БД.
    expect(await findLogicalDocument(db, CONTRACTOR_A, document.id)).not.toBeNull();
  });

  it('чужие страницы, реквизиты, реестр и классификации не читаются', async () => {
    const documents = await listLogicalDocuments(db, ADMIN, FOLDER_A);
    const document = documents[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    expect(await listPageAssignments(db, CONTRACTOR_B, FOLDER_A)).toEqual([]);
    expect(await listFieldValues(db, CONTRACTOR_B, document.id)).toEqual([]);
    expect(await listRegistryRows(db, CONTRACTOR_B, FOLDER_A)).toEqual([]);
    expect(await listPageClassifications(db, CONTRACTOR_B, FOLDER_A)).toEqual([]);
    expect(await listUnaccountedPages(db, CONTRACTOR_B, FOLDER_A)).toEqual([]);
    expect(await listDocumentRelations(db, CONTRACTOR_B, FOLDER_A)).toEqual([]);

    expect(await listPageAssignments(db, CONTRACTOR_A, FOLDER_A)).toHaveLength(4);
  });

  it('инженеру видны документы любого объекта', async () => {
    // Прежде это утверждение читалось наоборот: инженер без назначенных
    // объектов не видел ничего. Назначений больше нет (S37), и проверяющий
    // видит стройку целиком — иначе он не мог бы проверить комплект, который
    // ему принесли.
    expect(await listLogicalDocuments(db, ENGINEER, FOLDER_A)).not.toEqual([]);
    expect(await listPageAssignments(db, ENGINEER, FOLDER_A)).not.toEqual([]);
    expect(await listPageClassifications(db, ENGINEER, FOLDER_A)).not.toEqual([]);
  });

  it('в чужую ревизию нельзя ни записать классификацию, ни применить сегментацию', async () => {
    await expect(
      savePageClassifications(db, CONTRACTOR_B, {
        folderId: FOLDER_A,
        classifications: [classification(PAGE_A0)],
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      applySegmentation(db, CONTRACTOR_B, {
        folderId: FOLDER_A,
        documents: [decoded(0, [PAGE_A0, PAGE_A1, PAGE_A2, PAGE_A3])],
        unassigned: [],
        extractorVersion: 'seg/1',
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      confirmDocument(db, CONTRACTOR_B, {
        documentId: (await listLogicalDocuments(db, ADMIN, FOLDER_A))[0]?.id ?? id(997),
        actorUserId: USER,
        expectedVersion: 0,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Прежнее состояние не тронуто ни одной из трёх попыток.
    expect(await listPageAssignments(db, ADMIN, FOLDER_A)).toHaveLength(4);
  });
});

// =====================================================================
// Кандидаты в виды ИД: цикл роста каталога (§3.2)
// =====================================================================

describe('normalizeObservedTitle', () => {
  it('снимает markdown-обвязку, регистр, номер и дату', () => {
    expect(
      normalizeObservedTitle(
        '## **Акт гидравлического испытания трубопроводов № ГИ-77 от 12.05.2026**',
      ),
    ).toBe('АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ');
    expect(normalizeObservedTitle('| АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ №ГИ-91 |')).toBe(
      'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ',
    );
    expect(normalizeObservedTitle('1) Акт   гидравлического  испытания трубопроводов.')).toBe(
      'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ',
    );
  });

  it('не отдаёт пустой ключ: иначе в него склеились бы все незнакомые документы', () => {
    // Заголовок из одного номера: после снятия хвоста остаётся пустота,
    // поэтому ключом становится сам заголовок.
    expect(normalizeObservedTitle('№ 336')).toBe('№ 336');
    expect(normalizeObservedTitle('   ')).toBe('');
  });
});

describe('observeDocTypeCandidate', () => {
  it('кластеризует один вид документа по всем поставкам', async () => {
    const first = await observeDocTypeCandidate(db, ADMIN, {
      observedTitle: 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ № ГИ-77 от 12.05.2026',
      folderId: FOLDER_A,
      sourcePageId: PAGE_A0,
    });
    expect(first).toMatchObject({ created: true, occurrences: 1, status: 'new' });

    const second = await observeDocTypeCandidate(db, ADMIN, {
      // Другой номер, другая дата, другой регистр и markdown-обвязка — тот же вид.
      observedTitle: '## Акт гидравлического испытания трубопроводов № ГИ-91 от 03.06.2026',
      folderId: FOLDER_B,
      sourcePageId: PAGE_B0,
    });
    expect(second).toMatchObject({ created: false, occurrences: 2 });
    expect(second.observedTitleNorm).toBe(first.observedTitleNorm);

    expect(
      await countRows(
        `SELECT count(*) AS n FROM doc_type_candidates
          WHERE observed_title_norm = 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ'`,
      ),
    ).toBe(1);

    // Пример остаётся первым: администратор возвращается к тому же документу.
    const sample = await testDb.query<{ sample_folder_id: string }>(
      `SELECT sample_folder_id FROM doc_type_candidates
        WHERE observed_title_norm = 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ'`,
    );
    expect(sample[0]?.sample_folder_id).toBe(FOLDER_A);
  });

  /**
   * Решение администратора конвейер не отменяет. Иначе разобранная очередь
   * наполнялась бы заново каждой поставкой, а скрытый шум OCR всплывал бы
   * бесконечно.
   */
  it('кандидат в статусе ignored не возвращается в new, но счётчик растёт', async () => {
    await observeDocTypeCandidate(db, ADMIN, {
      observedTitle: 'ВЕДОМОСТЬ СМОНТИРОВАННОГО ОБОРУДОВАНИЯ № 4',
      folderId: FOLDER_A,
      sourcePageId: PAGE_A0,
    });
    await testDb.query(
      `UPDATE doc_type_candidates SET status = 'ignored', reviewed_by = '${USER}', reviewed_at = now()
        WHERE observed_title_norm = 'ВЕДОМОСТЬ СМОНТИРОВАННОГО ОБОРУДОВАНИЯ'`,
    );

    const again = await observeDocTypeCandidate(db, ADMIN, {
      observedTitle: 'Ведомость смонтированного оборудования № 7',
      folderId: FOLDER_A,
      sourcePageId: PAGE_A1,
    });
    expect(again.status).toBe('ignored');
    expect(again.occurrences).toBe(2);
  });

  it('кандидат в статусе mapped тоже сохраняет решение', async () => {
    await observeDocTypeCandidate(db, ADMIN, {
      observedTitle: 'ПРОТОКОЛ ИЗМЕРЕНИЯ СОПРОТИВЛЕНИЯ ИЗОЛЯЦИИ № 12',
      folderId: FOLDER_A,
      sourcePageId: PAGE_A0,
    });
    await testDb.query(
      `UPDATE doc_type_candidates
          SET status = 'mapped', mapped_doc_type_code = 'aosr', reviewed_by = '${USER}', reviewed_at = now()
        WHERE observed_title_norm = 'ПРОТОКОЛ ИЗМЕРЕНИЯ СОПРОТИВЛЕНИЯ ИЗОЛЯЦИИ'`,
    );

    const again = await observeDocTypeCandidate(db, ADMIN, {
      observedTitle: 'Протокол измерения сопротивления изоляции № 13 от 01.07.2026',
      folderId: FOLDER_A,
      sourcePageId: PAGE_A0,
    });
    expect(again.status).toBe('mapped');
    expect(again.occurrences).toBe(2);
  });

  it('пример нельзя записать со ссылкой на чужую ревизию', async () => {
    await expect(
      observeDocTypeCandidate(db, CONTRACTOR_B, {
        observedTitle: 'АКТ ПРОМЫВКИ И ДЕЗИНФЕКЦИИ № 1',
        folderId: FOLDER_A,
        sourcePageId: PAGE_A0,
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(
      await countRows(
        `SELECT count(*) AS n FROM doc_type_candidates
          WHERE observed_title_norm = 'АКТ ПРОМЫВКИ И ДЕЗИНФЕКЦИИ'`,
      ),
    ).toBe(0);
  });

  it('пустой заголовок отвергается: кластеризовать нечего', async () => {
    const rejected = await observeDocTypeCandidate(db, ADMIN, {
      observedTitle: '   ',
      folderId: FOLDER_A,
      sourcePageId: PAGE_A0,
    }).catch((error: unknown) => error);
    expect(isHttpProblem(rejected)).toBe(true);
    expect(rejected).toMatchObject({ status: 422 });
  });
});
