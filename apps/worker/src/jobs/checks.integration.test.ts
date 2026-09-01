/**
 * Задачи 20–21 конвейера целиком: очередь → воркер → база (§9, §12).
 *
 * ## Что здесь настоящее
 *
 * PostgreSQL (pglite) под ВСЕМИ миграциями проекта, пул из `createTestPool`,
 * реестр задач из `createWorkerRegistry()` — тот же, что собирает точка входа
 * воркера, — и штатный `JobRunner.runOnce()`. Ни одного обработчика напрямую,
 * ни одного самодельного адаптера пула: на S5 девять таких адаптеров прятали
 * дефект продакшна, а на S3 «зарегистрированный, но никем не вызванный» модуль
 * выглядел рабочим и был покрыт зелёными тестами.
 *
 * ## Почему конвейер не прогоняется целиком
 *
 * Приём, разметка, OCR и сегментация уже покрыты
 * `segmentation.integration.test.ts` и стоят минуты. Здесь их результат
 * выкладывается прямым SQL — ровно в тех таблицах и с теми ограничениями, в
 * которые пишет конвейер, — а проверяется то, чего не проверяет ни один тест
 * до: что задачи 20 и 21 РЕАЛЬНО исполняются очередью и оставляют в базе
 * прогон, замечания, материалы и журнал исполнения правил.
 *
 * ## Что считается доказательством
 *
 * Не «задача завершилась успехом», а ПОСЛЕДСТВИЯ, прочитанные прямым SQL:
 *
 * 1. постановка задачи видна строкой в `jobs`;
 * 2. `runOnce()` её исполняет и создаёт `validation_runs` с пиннингом;
 * 3. задача 20 сама ставит задачу 21, та тоже исполняется;
 * 4. замечания лежат в `findings`, а не в памяти прогона;
 * 5. **non-degradable гейт S9**: семь известных дефектов корпуса найдены
 *    СКВОЗНЫМ прогоном (`docs/CORPUS_FINDINGS.md`);
 * 6. журнал исполнения полон — запись по каждому коду каталога;
 * 7. два битых ОГРН дают РАЗНЫЕ вердикты: с чистого текста — `open`, с круглой
 *    печати — `undetermined`;
 * 8–11. троичная логика, внешние реестры, материалы и партии;
 * 12. повтор задачи безопасен;
 * 13. правило вне `enabled_rule_codes` профиля не исполняется;
 * 14. без активной версии набора правил задача честно отказывает;
 * 15. расхождение реестра правил и реализаций ловится в БОЕВОМ пути.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { RULE_CATALOG, defaultSnapshotRows } from '@id/rules';
import {
  createDatabase,
  createLogger,
  createMetrics,
  createPdfLibToolkit,
  createStorage,
  enqueueSystemJob,
  JobRunner,
  loadEnv,
  loadPdfLibModule,
  NoopErrorReporter,
  type Database,
  type PdfToolkit,
  type StorageProvider,
} from '@id/api';

import { createWorkerRegistry } from './pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-checks-e2e-'));

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Литерал в долларовых кавычках: в данных есть и «ёлочки», и апострофы. */
function lit(value: string): string {
  return `$fx$${value}$fx$`;
}

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR = id(2);
const OBJECT = id(4);
const RD_DOCUMENT = id(7);
const FOLDER = id(11);
const USER_CONTRACTOR = id(20);
const USER_ADMIN = id(21);
const SOURCE_FILE = id(30);
const BUNDLE = id(40);
const LAYOUT = id(41);
const RD_RUN_DOCUMENT = id(42);
const RECOGNITION_RUN = id(43);
const ARTIFACT = id(44);
const SECTION_PROFILE_V1 = id(50);
const SECTION_PROFILE_V2 = id(51);
const RULESET_VERSION = id(52);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

// =====================================================================
// Комплект корпуса
// =====================================================================

/**
 * Значения ЕГРЮЛ из `docs/CORPUS_FINDINGS.md`.
 *
 * `OGRN_SHORT` — 12 цифр вместо 13 (дефект №1 корпуса, вычитан с чистого
 * текстового блока). `OGRN_STAMP` — 13 цифр с битой контрольной суммой,
 * вычитанный с круглой печати: по §9.1 он обязан дать `undetermined`, а не
 * `fail`, и различает эти два случая ИМЕННО вид блока-источника.
 */
const OGRN_SHORT = '102770001234';
const OGRN_STAMP = '1027700012345';
const OGRN_VALID = '1037700056789';
const INN_VALID = '7700123459';

interface FieldSpec {
  readonly code: string;
  readonly text?: string;
  readonly date?: string;
  readonly num?: number;
  readonly json?: readonly string[];
  /** Значение вычитано с круглой печати: `effectiveConfidence` даёт потолок. */
  readonly stamp?: boolean;
}

interface DocSpec {
  readonly key: string;
  readonly typeCode: string;
  readonly title: string;
  readonly fields: readonly FieldSpec[];
}

/**
 * Комплект, воспроизводящий все семь известных дефектов корпуса сразу.
 *
 * Перенесён из `packages/rules/src/known-defects.test.ts`, где та же фикстура
 * живёт на уровне графа. Разница принципиальна: там граф собирается вручную, а
 * здесь он собирается репозиторием ИЗ БАЗЫ — то есть проверяется и сборка
 * графа, и вывод материалов, и запись замечаний, а не только логика правил.
 */
const DOCUMENTS: readonly DocSpec[] = [
  {
    key: 'act',
    typeCode: 'aosr',
    title: 'АОСР № 336',
    fields: [
      { code: 'object_name', text: 'Многоквартирный жилой дом' },
      { code: 'act_number', text: '336' },
      { code: 'act_date', date: '2026-03-10' },
      { code: 'date_start', date: '2026-02-28' },
      { code: 'date_end', date: '2026-03-09' },
      // Дефект 6: «2 слоя» в п. 1 против «1 слой» в приложении.
      { code: 'work_name', text: 'Устройство 2 слоя гидроизоляции кровли' },
      { code: 'p1_location', text: 'в осях 1-12/А-К, отм. +0.000' },
      { code: 'rd_cipher', text: '2.5.1-АР изм. 1' },
      { code: 'p3_materials', text: 'Гидроизоляция рулонная, арматура А500С' },
      { code: 'p3_registry_ref', text: 'Реестр приложений № 1' },
      { code: 'p4_annexes', text: 'Исполнительная схема на 1 слой гидроизоляции' },
      { code: 'p7_next_works', text: 'Устройство защитной стяжки' },
      { code: 'signers', text: 'Представитель застройщика; представитель подрядчика' },
      { code: 'contractor_name', text: 'ООО «Подрядчик»' },
      { code: 'contractor_inn', text: INN_VALID },
      // Дефект 1: ОГРН из 12 цифр, снятый с чистого текста.
      { code: 'contractor_ogrn', text: OGRN_SHORT },
      { code: 'works_performed_by', text: 'ООО «Подрядчик»' },
    ],
  },
  {
    key: 'act-stamp',
    typeCode: 'aosr',
    title: 'АОСР № 337',
    fields: [
      { code: 'object_name', text: 'Многоквартирный жилой дом' },
      { code: 'act_number', text: '337' },
      { code: 'act_date', date: '2026-03-11' },
      { code: 'date_start', date: '2026-02-28' },
      { code: 'date_end', date: '2026-03-09' },
      { code: 'work_name', text: 'Устройство 1 слой гидроизоляции кровли' },
      { code: 'p1_location', text: 'в осях 1-12/А-К, отм. +0.000' },
      { code: 'rd_cipher', text: '2.5.1-АР изм. 1' },
      { code: 'p3_materials', text: 'Гидроизоляция рулонная' },
      { code: 'p4_annexes', text: 'Исполнительная схема на 1 слой гидроизоляции' },
      { code: 'p7_next_works', text: 'Устройство защитной стяжки' },
      { code: 'signers', text: 'Представитель застройщика; представитель подрядчика' },
      { code: 'contractor_name', text: 'ООО «Подрядчик»' },
      { code: 'contractor_inn', text: INN_VALID },
      // Парное значение к дефекту 1: контрольная сумма тоже бита, но источник —
      // круглая печать, перекрытая подписью. Вердикт обязан отличаться.
      { code: 'contractor_ogrn', text: OGRN_STAMP, stamp: true },
      { code: 'works_performed_by', text: 'ООО «Подрядчик»' },
    ],
  },
  {
    key: 'scheme',
    typeCode: 'exec_scheme',
    title: 'Исполнительная схема: 1 слой гидроизоляции',
    fields: [{ code: 'work_name', text: 'Гидроизоляция, 1 слой, в осях 1-12/А-К' }],
  },
  {
    key: 'passport',
    typeCode: 'quality_passport',
    title: 'Паспорт качества',
    fields: [
      { code: 'number', text: 'П-77' },
      { code: 'issued_at', date: '2026-01-15' },
      { code: 'product_name', text: 'Гидроизоляция рулонная наплавляемая' },
      // Дефект 3: редакция 2015 против покрытой сертификатом 2011.
      { code: 'gost_tu', json: ['СТО 00287852-005-2015'] },
    ],
  },
  {
    key: 'cert',
    typeCode: 'cert_conformity',
    title: 'Сертификат соответствия',
    fields: [
      { code: 'number', text: 'РОСС RU Д-RU.PA01.B.17254/23' },
      { code: 'issued_at', date: '2025-11-01' },
      { code: 'valid_from', date: '2025-11-01' },
      { code: 'valid_to', date: '2027-11-01' },
      { code: 'product_name', text: 'Гидроизоляция рулонная наплавляемая' },
      { code: 'manufacturer', text: 'ООО «ТехноНИКОЛЬ»' },
      { code: 'gost_tu', json: ['СТО 00287852-005-2011'] },
    ],
  },
  {
    key: 'mill',
    typeCode: 'mill_certificate',
    title: 'Сертификат качества № 16005',
    fields: [
      { code: 'number', text: '16005' },
      { code: 'issued_at', date: '2026-01-09' },
      { code: 'product_name', text: 'Арматура А500С' },
      // Дефект 2: изготовитель партии не покрыт приложенным сертификатом.
      { code: 'manufacturer', text: 'ООО «ПромСорт-Тула»' },
      { code: 'manufactured_at', date: '2026-01-09' },
      { code: 'batch_no', text: '16005' },
    ],
  },
  {
    key: 'rebar-cert',
    typeCode: 'cert_conformity',
    title: 'Сертификат соответствия на арматурный прокат',
    fields: [
      { code: 'number', text: 'РОСС RU Д-RU.PA01.B.90001/24' },
      { code: 'issued_at', date: '2025-12-01' },
      { code: 'valid_from', date: '2025-12-01' },
      { code: 'valid_to', date: '2027-12-01' },
      { code: 'product_name', text: 'Арматура А500С' },
      { code: 'manufacturer', text: 'АО «Северсталь»' },
    ],
  },
  {
    key: 'metal-protocol',
    typeCode: 'lab_protocol_metal',
    title: 'Протокол испытаний № 10353.А/06.25',
    fields: [
      { code: 'number', text: '10353.А/06.25' },
      // Дефект 4: протокол от 06.2025 при партиях от 01.2026.
      { code: 'issued_at', date: '2025-06-20' },
      { code: 'tested_at', date: '2025-06-20' },
    ],
  },
  {
    key: 'technical-passport',
    typeCode: 'technical_passport',
    title: 'Технический паспорт',
    // Дефект 5: «Дата выдачи» не заполнена.
    fields: [
      { code: 'number', text: 'ТП-12' },
      { code: 'product_name', text: 'Смесь бетонная' },
    ],
  },
  {
    key: 'lab-7',
    typeCode: 'lab_protocol_concrete',
    title: 'Протокол испытаний бетона (7 суток)',
    // Дефект 7: 28-суточного протокола в комплекте нет.
    fields: [
      { code: 'number', text: 'Б-7' },
      { code: 'issued_at', date: '2026-01-20' },
      { code: 'tested_at', date: '2026-01-20' },
      { code: 'age_days', num: 7 },
      { code: 'strength_percent', num: 71.78 },
    ],
  },
  {
    key: 'registry',
    typeCode: 'annex_registry',
    title: 'Реестр приложений № 1',
    fields: [
      { code: 'registry_number', text: '1' },
      { code: 'act_number', text: '336' },
      { code: 'act_date', date: '2026-03-10' },
    ],
  },
];

/** Семь известных дефектов корпуса. Порядок — как в §0.1 плана. */
const DEFECT_RULES = [
  'AOSR.HDR.022',
  'MAT.111',
  'MAT.112',
  'DATE.372',
  'TP.620',
  'AOSR.P4.081',
  'LAB.651',
] as const;

const ALL_RULE_CODES: readonly string[] = RULE_CATALOG.map((spec) => spec.code);

function documentIndex(key: string): number {
  const index = DOCUMENTS.findIndex((document) => document.key === key);
  if (index < 0) throw new Error(`документа ${key} нет в комплекте`);
  return index;
}

const docId = (key: string): string => id(100 + documentIndex(key));
const pageId = (index: number): string => id(140 + index);
const textBlockId = (index: number): string => id(170 + index);
const stampBlockId = (index: number): string => id(200 + index);
const textVersionId = (index: number): string => id(230 + index);

// =====================================================================
// Фикстура прямым SQL
// =====================================================================

function catalogStatements(): readonly string[] {
  return [
    `INSERT INTO counterparties (id, name, inn, ogrn, kind)
       VALUES ('${ORG_CUSTOMER}', ${lit('ООО «Застройщик»')}, '7707083893', '1027700132195', 'customer')`,
    `INSERT INTO counterparties (id, name, inn, ogrn, kind)
       VALUES ('${ORG_CONTRACTOR}', ${lit('ООО «Подрядчик»')}, '${INN_VALID}', '${OGRN_VALID}', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name, developer_id, general_contractor_id)
       VALUES ('${OBJECT}', 'CHK01', ${lit('Многоквартирный жилой дом')},
               ${lit('Многоквартирный жилой дом')}, '${ORG_CUSTOMER}', '${ORG_CONTRACTOR}')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', ${lit('Кровля')})
       ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    // Шифр из п. 2 акта обязан находиться в реестре РД объекта (AOSR.P2.061).
    `INSERT INTO rd_documents (id, object_id, cipher, revision, name)
       VALUES ('${RD_DOCUMENT}', '${OBJECT}', ${lit('2.5.1-АР')}, '1', ${lit('Кровля')})`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_CONTRACTOR}', 'kc-checks-contractor', ${lit('Сотрудник подрядчика')}, '${ORG_CONTRACTOR}')`,
    `INSERT INTO users (id, kc_sub, full_name)
       VALUES ('${USER_ADMIN}', 'kc-checks-admin', ${lit('Администратор портала')})`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
    // Ревизия заводится черновиком: класс содержимого `source` (файлы, страницы,
    // рабочий документ) заперт триггером 0008 уже в `in_review`. В боевом пути
    // они и появляются до подачи; статус переводится ниже, перед прогоном.
    `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', ${lit('Поставка 1')}, '${USER_CONTRACTOR}')`,
  ];
}

/** Источник страниц: файл, страницы, рабочий документ и его карта. */
function sourceStatements(): readonly string[] {
  const statements: string[] = [
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${HASH_A}', 'blobs/aa/aa/${HASH_A}', 1024, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${HASH_B}', 'blobs/bb/bb/${HASH_B}', 2048, 'application/pdf')`,
    `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${SOURCE_FILE}', '${FOLDER}', '${HASH_A}', ${lit('комплект.pdf')}, 0, 'ok')`,
    `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash,
                                     working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE}', '${FOLDER}', '${HASH_C}', '${HASH_B}', 'test-1')`,
  ];

  DOCUMENTS.forEach((_document, index) => {
    statements.push(
      `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index,
                                 folder_ordinal, width_px, height_px)
         VALUES ('${pageId(index)}', '${FOLDER}', '${SOURCE_FILE}', ${String(index)},
                 ${String(index)}, 1240, 1754)`,
    );
    statements.push(
      `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
         VALUES ('${BUNDLE}', '${FOLDER}', ${String(index)}, '${pageId(index)}')`,
    );
  });

  return statements;
}

/**
 * Разметка и распознавание.
 *
 * Блоки нужны не для полноты картины: `field_values.source_block_id` ведёт на
 * `layout_blocks.block_type`, и именно он отличает ОГРН, вычитанный с печати,
 * от ОГРН из шапки. Версии текста страниц нужны затем, чтобы `hasRecognizedText`
 * был `true`, а `finding_evidence` ссылалось на существующую строку.
 */
function layoutStatements(): readonly string[] {
  const statements: string[] = [
    `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no, state)
       VALUES ('${LAYOUT}', '${FOLDER}', '${OBJECT}', '${BUNDLE}', 1, 'draft')`,
    `INSERT INTO rd_run_documents (id, layout_revision_id, rd_document_id, rd_project_id)
       VALUES ('${RD_RUN_DOCUMENT}', '${LAYOUT}', 'rd-doc-1', 'prj-portal')`,
    `INSERT INTO recognition_runs (id, folder_id, layout_revision_id, rd_run_document_id,
                                   local_layout_hash, working_pdf_sha256, status, finished_at)
       VALUES ('${RECOGNITION_RUN}', '${FOLDER}', '${LAYOUT}', '${RD_RUN_DOCUMENT}',
               '${HASH_C}', '${HASH_B}', 'done', now())`,
    `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
       VALUES ('${ARTIFACT}', '${RECOGNITION_RUN}', 'md', 'artifacts/md', '${HASH_D}', 512)`,
  ];

  DOCUMENTS.forEach((document, index) => {
    statements.push(
      `INSERT INTO layout_blocks (id, layout_revision_id, folder_id, bundle_id, source_page_id,
                                  working_page_index, object_id, block_type, shape_type,
                                  x0, y0, x1, y1, sort_order, source, detector_provenance)
         VALUES ('${textBlockId(index)}', '${LAYOUT}', '${FOLDER}', '${BUNDLE}',
                 '${pageId(index)}', ${String(index)}, '${OBJECT}', 'text', 'rectangle',
                 0, 0, 1, 1, 0, 'auto', 'full_page')`,
    );
    if (document.fields.some((value) => value.stamp === true)) {
      statements.push(
        `INSERT INTO layout_blocks (id, layout_revision_id, folder_id, bundle_id, source_page_id,
                                    working_page_index, object_id, block_type, shape_type,
                                    x0, y0, x1, y1, sort_order, source, detector_provenance)
           VALUES ('${stampBlockId(index)}', '${LAYOUT}', '${FOLDER}', '${BUNDLE}',
                   '${pageId(index)}', ${String(index)}, '${OBJECT}', 'stamp', 'rectangle',
                   0.6, 0.8, 0.9, 0.95, 1, 'auto', 'rf_detr')`,
      );
    }
    statements.push(
      `INSERT INTO page_text_versions (id, folder_id, source_page_id, recognition_run_id,
                                       artifact_version_id, text_md, text_sha256)
         VALUES ('${textVersionId(index)}', '${FOLDER}', '${pageId(index)}',
                 '${RECOGNITION_RUN}', '${ARTIFACT}', ${lit(document.title)}, '${HASH_D}')`,
    );
  });

  return statements;
}

/** Логические документы, учёт страниц, реквизиты, связи и реестр приложений. */
function graphStatements(): readonly string[] {
  const statements: string[] = [];
  let fieldSeq = 0;

  DOCUMENTS.forEach((document, index) => {
    statements.push(
      `INSERT INTO logical_documents (id, folder_id, object_id, contractor_id, doc_type_code,
                                      ordinal, title, type_confidence, boundary_confidence,
                                      needs_review)
         VALUES ('${docId(document.key)}', '${FOLDER}', '${OBJECT}', '${ORG_CONTRACTOR}',
                 '${document.typeCode}', ${String(index)}, ${lit(document.title)}, 0.95, 0.95, false)`,
    );
    statements.push(
      `INSERT INTO page_assignments (folder_id, source_page_id, document_id, sort_order)
         VALUES ('${FOLDER}', '${pageId(index)}', '${docId(document.key)}', 0)`,
    );

    for (const value of document.fields) {
      fieldSeq += 1;
      const blockId = value.stamp === true ? stampBlockId(index) : textBlockId(index);
      const quote = value.text ?? value.date ?? String(value.num ?? value.json?.[0] ?? '');
      statements.push(
        `INSERT INTO field_values (id, folder_id, document_id, field_code, value_text, value_date,
                                   value_num, value_json, confidence, is_verified, extractor_version,
                                   page_text_version_id, source_block_id, char_span, quote,
                                   extracted_by)
           VALUES ('${id(300 + fieldSeq)}', '${FOLDER}', '${docId(document.key)}',
                   '${value.code}',
                   ${value.text === undefined ? 'NULL' : lit(value.text)},
                   ${value.date === undefined ? 'NULL' : `'${value.date}'::date`},
                   ${value.num === undefined ? 'NULL' : String(value.num)},
                   ${value.json === undefined ? 'NULL' : `${lit(JSON.stringify(value.json))}::jsonb`},
                   0.95, false, 's9-test',
                   '${textVersionId(index)}', '${blockId}',
                   '[0,${String(Math.max(1, quote.length))})'::int4range, ${lit(quote)},
                   'rule')`,
      );
    }
  });

  // Граф §9.1: всё, кроме второго акта, приложено к акту № 336.
  for (const document of DOCUMENTS) {
    if (document.key === 'act' || document.key === 'act-stamp') continue;
    statements.push(
      `INSERT INTO document_relations (parent_document_id, child_document_id, relation, folder_id)
         VALUES ('${docId('act')}', '${docId(document.key)}', 'annex', '${FOLDER}')`,
    );
  }

  const registryEntries: readonly (readonly [string, string, string])[] = [
    ['cert', 'Сертификат соответствия', 'РОСС RU Д-RU.PA01.B.17254/23'],
    ['mill', 'Документ о качестве', '16005'],
    ['metal-protocol', 'Протокол об испытаниях', '10353.А/06.25'],
  ];
  registryEntries.forEach(([key, name, number], index) => {
    statements.push(
      `INSERT INTO registry_rows (id, folder_id, document_id, row_no, ordinal, doc_name_raw,
                                  doc_no_raw, doc_no_norm, doc_no_folded, org_raw,
                                  matched_document_id, match_score, match_state)
         VALUES ('${id(500 + index)}', '${FOLDER}', '${docId('registry')}',
                 ${String(index + 1)}, ${String(index)}, ${lit(name)}, ${lit(number)},
                 ${lit(number.toUpperCase())}, ${lit(number.toUpperCase())},
                 ${lit('ООО «Подрядчик»')}, '${docId(key)}', 1, 'matched')`,
    );
  });

  return statements;
}

/**
 * Настройка проверок: опубликованный профиль раздела и опубликованная
 * версия набора правил, назначенная активной.
 *
 * `enabled_rule_codes` содержит ВЕСЬ каталог намеренно: правило вне списка не
 * исполняется вовсе (§9.1, строка 4), и урезанный список превратил бы гейт
 * «журнал полон» в тавтологию. Обратная сторона проверяется отдельно.
 */
function configurationStatements(): readonly string[] {
  const codes = ALL_RULE_CODES.map((code) => lit(code)).join(', ');
  const statements: string[] = [
    `INSERT INTO section_profiles (id, section_code, version, effective_from, effective_to,
                                   expected_doc_types, material_categories, material_matrix,
                                   enabled_rule_codes, thresholds, autonomy_level,
                                   published_at, published_by)
       VALUES ('${SECTION_PROFILE_V1}', 'roofing', 1, '2020-01-01'::date, NULL,
               ARRAY[${lit('aosr')}, ${lit('annex_registry')}]::text[],
               ARRAY[${lit('roll_waterproofing')}, ${lit('rebar')}, ${lit('ready_mix_concrete')}]::text[],
               '{}'::jsonb, ARRAY[${codes}]::text[], '{}'::jsonb, 'assisted',
               now(), '${USER_ADMIN}')`,
    // Версия заводится ЧЕРНОВИКОМ и публикуется после наполнения: снимок
    // опубликованного набора неизменяем (0008), и вставка правила в уже
    // опубликованную версию отвергается триггером — как и должно быть.
    `INSERT INTO ruleset_versions (id, version) VALUES ('${RULESET_VERSION}', 's9-checks-e2e')`,
  ];

  for (const row of defaultSnapshotRows()) {
    statements.push(
      `INSERT INTO ruleset_rules (ruleset_version_id, rule_code, is_enabled, severity,
                                  is_blocking, params)
         VALUES ('${RULESET_VERSION}', ${lit(row.ruleCode)}, ${String(row.isEnabled)},
                 ${lit(row.severity)}, ${String(row.isBlocking)},
                 ${lit(JSON.stringify(row.params))}::jsonb)`,
    );
  }

  statements.push(
    `UPDATE ruleset_versions SET published_at = now(), published_by = '${USER_ADMIN}'
      WHERE id = '${RULESET_VERSION}'`,
  );

  statements.push(
    // ON CONFLICT: с миграции 0044 указатель уже занят встроенным набором, и
    // фикстура обязана перевести его на СВОЙ — иначе прогон пошёл бы по чужому
    // снимку правил, а тест утверждал бы не то, что проверяет.
    `INSERT INTO app_settings (key, value, updated_by)
       VALUES ('ruleset.active_version_id', ${lit(JSON.stringify(RULESET_VERSION))}::jsonb,
               '${USER_ADMIN}')
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by`,
  );

  return statements;
}

// =====================================================================
// Инфраструктура прогона
// =====================================================================

let testDb: TestDatabase;
let db: Database;
let storage: StorageProvider;
let toolkit: PdfToolkit;
let runner: JobRunner;
/** Первый прогон: его читают почти все проверки ниже. */
let firstRunId = '';
const logSink: string[] = [];

const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'dev-stub',
    CSRF_SECRET: 'csrf-secret-of-checks-e2e-0123456789ab',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-checks-e2e',
  });

  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  for (const statement of [
    ...catalogStatements(),
    ...sourceStatements(),
    ...layoutStatements(),
    ...graphStatements(),
    ...configurationStatements(),
  ]) {
    await testDb.query(statement);
  }

  db = createDatabase(createTestPool(testDb) as unknown as Pool);

  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logSink.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ service: 'checks-e2e', level: 'debug', env: 'test', destination });
  const metrics = createMetrics({ enabled: false, service: 'checks-e2e' });
  storage = createStorage(env, { metrics, logger });
  toolkit = createPdfLibToolkit(await loadPdfLibModule((specifier) => import(specifier)));

  runner = new JobRunner({
    db,
    registry: createWorkerRegistry({
      db,
      storage,
      toolkit,
      limits: { maxBytes: env.MAX_UPLOAD_BYTES, maxPages: env.MAX_PAGES_PER_FILE },
      workDirBase: STORAGE_DIR,
      rdweb: null,
      llm: null,
    }),
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-checks-e2e',
  });
}, 120_000);

afterAll(async () => {
  // Отказ в `beforeAll` оставляет часть ресурсов несозданной: уборка обязана
  // сообщать причину падения, а не перекрывать её собственным исключением.
  if (runner !== undefined) await runner.stop();
  if (testDb !== undefined) await testDb.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Прогон очереди до опустошения ШТАТНЫМ захватом. */
async function drainQueue(maxRounds = 40): Promise<void> {
  let idle = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await runner.runOnce();
    if (claimed > 0) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle > 2) return;
    await sleep(50);
  }
  throw new Error('очередь не опустела за отведённое число проходов');
}

async function count(sql: string): Promise<number> {
  const rows = await testDb.query<{ count: string | number }>(sql);
  return Number(rows[0]?.count ?? 0);
}

interface JournalEntry {
  readonly ruleCode: string;
  readonly verdict: string;
  readonly reason: string | null;
  readonly findingCount: number;
}

interface Journal {
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly executions: readonly JournalEntry[];
  readonly skippedCodes: Readonly<Record<string, string>>;
  readonly externalRegistriesUnavailable: readonly string[];
}

interface RunCounts {
  readonly journal?: Journal;
  readonly findings?: number;
  readonly blocking?: number;
}

async function runCounts(validationRunId: string): Promise<RunCounts> {
  const rows = await testDb.query<{ counts: string }>(
    `SELECT counts::text AS counts FROM validation_runs WHERE id = '${validationRunId}'`,
  );
  const raw = rows[0]?.counts ?? '{}';
  return JSON.parse(raw) as RunCounts;
}

async function journalOf(validationRunId: string): Promise<Journal> {
  const journal = (await runCounts(validationRunId)).journal;
  if (journal === undefined) throw new Error(`у прогона ${validationRunId} нет журнала`);
  return journal;
}

interface FindingRow {
  readonly rule_code: string;
  readonly state: string;
  readonly severity: string;
  readonly origin: string;
  readonly is_blocking: boolean;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly message: string;
  readonly hint: string | null;
}

async function findingsOf(validationRunId: string): Promise<readonly FindingRow[]> {
  return testDb.query<FindingRow>(
    `SELECT rule_code, state, severity, origin, is_blocking, target_type, target_id, message, hint
       FROM findings WHERE validation_run_id = '${validationRunId}' ORDER BY rule_code`,
  );
}

async function latestRunId(): Promise<string> {
  const rows = await testDb.query<{ id: string }>(
    `SELECT id FROM validation_runs WHERE folder_id = '${FOLDER}'
      ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  const value = rows[0]?.id;
  if (value === undefined) throw new Error('прогонов проверок нет');
  return value;
}

// =====================================================================
// 1–3. Постановка, исполнение и цепочка задач 20 → 21
// =====================================================================

describe('задачи 20–21 действительно исполняются очередью', () => {
  it('постановка задачи 20 кладёт строку в jobs', async () => {
    // «Задача поставлена» доказывается ТАБЛИЦЕЙ, а не успешным вызовом:
    // на S5 обработчик существовал, а в очередь его никто не ставил.
    const before = await count(`SELECT count(*) AS count FROM jobs WHERE type = 'checks.run'`);
    expect(before).toBe(0);

    await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
      dedupeKey: `checks.run:${FOLDER}:first`,
    });

    const rows = await testDb.query<{ type: string; status: string }>(
      `SELECT type, status FROM jobs ORDER BY type`,
    );
    expect(rows.map((row) => row.type)).toContain('checks.run');
    expect(rows.find((row) => row.type === 'checks.run')?.status).toBe('queued');
  });

  it('runOnce() исполняет её и создаёт прогон с пиннингом', async () => {
    const claimed = await runner.runOnce();
    expect(claimed).toBe(1);

    const failed = await testDb.query<{ job_type: string; error_message: string | null }>(
      `SELECT job_type, error_message FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);

    const runs = await testDb.query<{
      id: string;
      ruleset_version_id: string | null;
      section_profile_id: string | null;
      finished_at: string | null;
    }>(
      `SELECT id, ruleset_version_id, section_profile_id, finished_at
         FROM validation_runs WHERE folder_id = '${FOLDER}'`,
    );
    expect(runs).toHaveLength(1);
    firstRunId = runs[0]?.id ?? '';
    expect(firstRunId).not.toBe('');
    // Пиннинг §3.7: прогон обязан помнить, ПО ЧЕМУ он выполнен.
    expect(runs[0]?.ruleset_version_id).toBe(RULESET_VERSION);
    expect(runs[0]?.section_profile_id).toBe(SECTION_PROFILE_V1);
    // Сводка ещё не сделана: `finished_at` ставит только задача 21.
    expect(runs[0]?.finished_at).toBeNull();
  });

  it('задача 20 сама поставила ИИ-проверку, а та — сводку, и обе исполняются', async () => {
    // С S21 между прогоном правил и сводкой стоит `checks.llm_review`: её
    // замечания принадлежат тому же прогону, и сводка обязана считаться уже с
    // ними. Провайдера модели в тесте нет, поэтому стадия честно пропускает
    // себя — и ВСЁ РАВНО ставит сводку. Именно это здесь и проверяется: обрыв
    // цепочки на ненастроенной модели был бы конвейером, который «работает,
    // пока модель настроена».
    const queued = await testDb.query<{ type: string; status: string }>(
      `SELECT type, status FROM jobs WHERE type IN ('checks.llm_review', 'checks.summarize')
        ORDER BY type`,
    );
    expect(queued.map((row) => row.type)).toEqual(['checks.llm_review']);
    expect(queued[0]?.status).toBe('queued');

    await drainQueue();

    const types = await testDb.query<{ job_type: string; outcome: string | null }>(
      `SELECT job_type, outcome FROM job_runs ORDER BY job_type`,
    );
    expect(types.map((row) => row.job_type)).toContain('checks.llm_review');
    expect(types.map((row) => row.job_type)).toContain('checks.summarize');
    expect(types.every((row) => row.outcome === 'succeeded')).toBe(true);

    const runs = await testDb.query<{ finished_at: string | null }>(
      `SELECT finished_at FROM validation_runs WHERE id = '${firstRunId}'`,
    );
    expect(runs[0]?.finished_at).not.toBeNull();

    const journal = await journalOf(firstRunId);
    expect(journal.executions.length).toBeGreaterThan(0);
    expect(journal.rulesetVersion).toBe('s9-checks-e2e');
  });
});

// =====================================================================
// 4–5. Замечания в базе и non-degradable гейт S9
// =====================================================================

describe('замечания записаны, семь известных дефектов найдены', () => {
  it('замечания читаются прямым SQL из findings', async () => {
    const rows = await findingsOf(firstRunId);
    expect(rows.length).toBeGreaterThan(0);
    // Сводка описывает то, что РЕАЛЬНО лежит в таблице, а не память прогона.
    expect((await runCounts(firstRunId)).findings).toBe(rows.length);
  });

  it('каждый из семи дефектов корпуса даёт открытое замечание', async () => {
    const rows = await findingsOf(firstRunId);
    for (const code of DEFECT_RULES) {
      const open = rows.filter((row) => row.rule_code === code && row.state === 'open');
      expect(open.length, `${code}: открытого замечания нет в findings`).toBeGreaterThan(0);
      // Замечание без способа устранения бесполезно подрядчику (§9.1).
      expect(open[0]?.hint, `${code} без hint`).toBeTruthy();
    }
  });

  it('семь правил исполнялись и дали вердикт fail', async () => {
    // Без этой проверки предыдущая могла бы быть зелёной по чужому замечанию.
    const journal = await journalOf(firstRunId);
    const byCode = new Map(journal.executions.map((entry) => [entry.ruleCode, entry]));
    for (const code of DEFECT_RULES) {
      expect(byCode.get(code)?.verdict, `${code} в журнале прогона`).toBe('fail');
    }
  });

  it('дефекты названы конкретикой, по которой инженер найдёт место', async () => {
    const rows = await findingsOf(firstRunId);
    const messageOf = (code: string): string =>
      rows.find((row) => row.rule_code === code && row.state === 'open')?.message ?? '';

    expect(messageOf('AOSR.HDR.022')).toContain(OGRN_SHORT);
    expect(messageOf('MAT.111')).toContain('ПромСорт-Тула');
    expect(messageOf('MAT.112')).toContain('2015');
    expect(messageOf('MAT.112')).toContain('2011');
    expect(messageOf('DATE.372')).toContain('20.06.2025');
    expect(messageOf('DATE.372')).toContain('09.01.2026');
    expect(messageOf('TP.620')).toContain('Дата выдачи');
    expect(messageOf('LAB.651')).toMatch(/28/u);
  });
});

// =====================================================================
// 6. Полнота журнала исполнения
// =====================================================================

describe('журнал исполнения полон', () => {
  it('в журнале есть запись по КАЖДОМУ коду каталога, пропущенных нет', async () => {
    const journal = await journalOf(firstRunId);
    const executed = journal.executions.map((entry) => entry.ruleCode).sort();
    expect(executed).toEqual([...ALL_RULE_CODES].sort());
    expect(Object.keys(journal.skippedCodes)).toEqual([]);
  });

  it('ни один код не имеет постороннего вердикта', async () => {
    const journal = await journalOf(firstRunId);
    for (const entry of journal.executions) {
      expect(['pass', 'fail', 'undetermined', 'n_a'], entry.ruleCode).toContain(entry.verdict);
    }
  });

  it('журнал переживает переход между задачами 20 и 21', async () => {
    // Он пишется задачей 20 в БД и читается задачей 21 оттуда же: сводку может
    // подхватить другой процесс, и «правило прошло» обязано оставаться отличимым
    // от «правило не исполнялось» после любого перезапуска.
    const counts = await runCounts(firstRunId);
    expect(counts.journal?.engineVersion).toBeTruthy();
    expect(counts.journal?.executions.length).toBe(ALL_RULE_CODES.length);
  });
});

// =====================================================================
// 7–10. Троичная логика и внешние реестры
// =====================================================================

describe('троичная логика на сквозном прогоне', () => {
  it('два битых ОГРН дают РАЗНЫЕ вердикты', async () => {
    const rows = await findingsOf(firstRunId);
    const ogrn = rows.filter((row) => row.rule_code === 'AOSR.HDR.022');

    const fromText = ogrn.find((row) => row.message.includes(OGRN_SHORT));
    const fromStamp = ogrn.find((row) => row.message.includes(OGRN_STAMP));
    expect(fromText, 'замечания по ОГРН из чистого текста нет').toBeDefined();
    expect(fromStamp, 'замечания по ОГРН с печати нет').toBeDefined();

    // Различает их не сам номер — потеря цифры при OCR объясняет оба случая
    // одинаково, — а уверенность источника (§9.1, `docs/CORPUS_FINDINGS.md`).
    expect(fromText?.state).toBe('open');
    expect(fromStamp?.state).toBe('undetermined');
    expect(fromStamp?.is_blocking).toBe(false);
  });

  it('низкая уверенность не даёт ни одного блокирующего замечания', async () => {
    expect(
      await count(
        `SELECT count(*) AS count FROM findings
          WHERE validation_run_id = '${firstRunId}' AND state = 'undetermined' AND is_blocking`,
      ),
    ).toBe(0);
  });

  it('находка LLM не блокирует без подтверждения инженером — проверка ВАКУУМНА', async () => {
    // ВАКУУМНОСТЬ НАЗЫВАЕТСЯ ВСЛУХ, а не умалчивается. Ни одно правило
    // каталога сегодня не выносит замечание с `origin = 'llm'`: все 56 правил
    // детерминированы, а стадия `check` через модель (§9.6, §10) в конвейер
    // ещё не подключена. Значит выборка ниже читает ПУСТОЕ множество и прошла
    // бы даже на движке, который запрет не соблюдает. Здесь утверждается
    // отсутствие нарушения, а не сработавший запрет, и это разные вещи.
    //
    // Проверка перестанет быть вакуумной ровно в тот день, когда в
    // `RULE_CATALOG` появится правило, выносящее находку с `origin = 'llm'`.
    // До того дня её единственная роль — сторожевая: она покраснеет, если
    // такое правило появится и обойдёт запрет.
    //
    // Второй рубеж — ограничение БД — проверяется СЛЕДУЮЩИМ тестом прямым
    // INSERT'ом. Раньше комментарий здесь утверждал, что «каждое из трёх мест
    // проверено своим тестом»; это было неправдой и останавливало
    // следующего проверяющего.
    expect(
      await count(
        `SELECT count(*) AS count FROM findings
          WHERE validation_run_id = '${firstRunId}'
            AND origin = 'llm' AND is_blocking AND confirmed_by IS NULL`,
      ),
    ).toBe(0);
  });

  describe('ограничение findings_llm_blocking_chk (0006) как второй рубеж', () => {
    // Первый рубеж — движок (`engine.test.ts`), третий — выборка выше.
    // РУБЕЖ БАЗЫ не проверял никто: `rg "INSERT INTO findings"` не находил ни
    // одной попытки нарушить ограничение. Ограничение, написанное в миграции и
    // ни разу не испытанное, — это гипотеза о поведении PostgreSQL, а не
    // барьер. Ниже оно испытывается прямым SQL, минуя весь код портала:
    // именно этим оно и ценно — оно держит запрет и для того, кто напишет в
    // `findings` в обход репозиториев.

    // Прогон СОБСТВЕННЫЙ, а не `firstRunId` соседних тестов. Две причины:
    // испытание не должно ни на строку изменять данные, по которым считает
    // выводы гейт семи дефектов, и блок обязан исполняться сам по себе —
    // с `vitest -t`, то есть без соседей, заполняющих `firstRunId`.
    const CHECK_RUN = id(910);

    beforeAll(async () => {
      await testDb.query(
        `INSERT INTO validation_runs (id, folder_id, ruleset_version_id)
           VALUES ('${CHECK_RUN}', '${FOLDER}', '${RULESET_VERSION}')`,
      );
    });

    afterAll(async () => {
      await testDb.query(`DELETE FROM validation_runs WHERE id = '${CHECK_RUN}'`);
    });

    /** Одна строка замечания; варьируются только три спорных поля. */
    function insertFinding(
      findingId: string,
      origin: string,
      isBlocking: boolean,
      confirmedBy: string | null,
    ): string {
      return `INSERT INTO findings (id, validation_run_id, folder_id, object_id, contractor_id,
                                    rule_code, severity, state, origin, is_blocking,
                                    confirmed_by, confirmed_at, target_type, target_id, message)
         VALUES ('${findingId}', '${CHECK_RUN}', '${FOLDER}', '${OBJECT}', '${ORG_CONTRACTOR}',
                 'AOSR.HDR.022', 'error', 'open', '${origin}', ${String(isBlocking)},
                 ${confirmedBy === null ? 'NULL' : `'${confirmedBy}'`},
                 ${confirmedBy === null ? 'NULL' : 'now()'},
                 'folder', '${FOLDER}', ${lit('Испытание ограничения БД')})`;
    }

    /** Вставка с гарантированной уборкой: строка не должна пережить тест. */
    async function insertAndDrop(sql: string, findingId: string): Promise<void> {
      try {
        await testDb.query(sql);
      } finally {
        await testDb.query(`DELETE FROM findings WHERE id = '${findingId}'`);
      }
    }

    it('ОТКЛОНЯЕТ блокирующую находку модели без подтверждения', async () => {
      const findingId = id(900);
      await expect(
        insertAndDrop(insertFinding(findingId, 'llm', true, null), findingId),
      ).rejects.toThrow(/findings_llm_blocking_chk/);
    });

    it('ПРОПУСКАЕТ ту же находку, подтверждённую инженером', async () => {
      // Положительный контроль №1: без него тест выше прошёл бы и на
      // ограничении `CHECK (false)`, запрещающем вообще любую находку LLM.
      const findingId = id(901);
      await expect(
        insertAndDrop(insertFinding(findingId, 'llm', true, USER_ADMIN), findingId),
      ).resolves.toBeUndefined();
    });

    it('ПРОПУСКАЕТ неблокирующую находку модели без подтверждения', async () => {
      // Положительный контроль №2: запрет прицелен в блокирующие находки.
      // Совет модели без подтверждения — штатный путь §9.1, он обязан
      // сохраняться, иначе стадия `check` не сможет писать вообще ничего.
      const findingId = id(902);
      await expect(
        insertAndDrop(insertFinding(findingId, 'llm', false, null), findingId),
      ).resolves.toBeUndefined();
    });

    it('ПРОПУСКАЕТ блокирующую детерминированную находку без подтверждения', async () => {
      // Положительный контроль №3: ограничение адресовано именно происхождению
      // `llm`. Детерминированное правило блокирует без чьей-либо подписи —
      // на этом стоит весь гейт семи известных дефектов.
      const findingId = id(903);
      await expect(
        insertAndDrop(insertFinding(findingId, 'deterministic', true, null), findingId),
      ).resolves.toBeUndefined();
    });

    it('не оставляет за собой ни одной строки', async () => {
      // Уборка проверяется, а не предполагается: пережившая строка исказила бы
      // счётчики соседних тестов и превратила бы этот файл в источник
      // плавающих отказов.
      expect(
        await count(
          `SELECT count(*) AS count FROM findings
            WHERE message = ${lit('Испытание ограничения БД')}`,
        ),
      ).toBe(0);
    });
  });

  it('отсутствие внешнего реестра даёт external_unavailable и ручную проверку', async () => {
    const rows = (await findingsOf(firstRunId)).filter(
      (row) => row.origin === 'external_unavailable',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Вывод о членстве в СРО без источника — юридическое утверждение,
      // которого система сделать не может (§9.5).
      expect(row.state, row.rule_code).toBe('undetermined');
      expect(row.is_blocking, row.rule_code).toBe(false);
      expect(row.message, row.rule_code).toContain('требуется ручная проверка');
    }

    const journal = await journalOf(firstRunId);
    expect(journal.externalRegistriesUnavailable.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// 11. Материалы и партии записаны
// =====================================================================

describe('материалы и партии выведены и записаны', () => {
  it('materials, batches и material_documents непусты', async () => {
    expect(
      await count(`SELECT count(*) AS count FROM materials WHERE folder_id = '${FOLDER}'`),
    ).toBeGreaterThan(0);
    expect(
      await count(
        `SELECT count(*) AS count FROM batches b
           JOIN materials m ON m.id = b.material_id
          WHERE m.folder_id = '${FOLDER}'`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(`SELECT count(*) AS count FROM material_documents WHERE folder_id = '${FOLDER}'`),
    ).toBeGreaterThan(0);
  });

  it('target_id замечаний уровня материала и партии ведёт на существующие строки', async () => {
    // Замечание с `target_id`, не ведущим никуда, невозможно открыть с экрана.
    const dangling = await count(
      `SELECT count(*) AS count FROM findings f
        WHERE f.validation_run_id = '${firstRunId}'
          AND f.target_type = 'material'
          AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.id = f.target_id)`,
    );
    expect(dangling).toBe(0);

    const danglingBatches = await count(
      `SELECT count(*) AS count FROM findings f
        WHERE f.validation_run_id = '${firstRunId}'
          AND f.target_type = 'batch'
          AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.id = f.target_id)`,
    );
    expect(danglingBatches).toBe(0);

    // Дефект №2 адресуется именно партии, а не документу: иначе проверка выше
    // была бы истинна по построению (целей такого типа просто не было бы).
    const batchTargets = await count(
      `SELECT count(*) AS count FROM findings
        WHERE validation_run_id = '${firstRunId}'
          AND rule_code = 'MAT.111' AND target_type = 'batch'`,
    );
    expect(batchTargets).toBeGreaterThan(0);
  });

  it('доказательства замечаний ссылаются на настоящие версии текста', async () => {
    const evidence = await count(
      `SELECT count(*) AS count FROM finding_evidence e
         JOIN findings f ON f.id = e.finding_id
        WHERE f.validation_run_id = '${firstRunId}'`,
    );
    expect(evidence).toBeGreaterThan(0);
  });
});

// =====================================================================
// 12. Повтор задачи безопасен
// =====================================================================

describe('повтор задачи 20 безопасен', () => {
  it('второй прогон не трогает первый и не задваивает материалы', async () => {
    const materialsBefore = await count(
      `SELECT count(*) AS count FROM materials WHERE folder_id = '${FOLDER}'`,
    );
    const firstFindings = await findingsOf(firstRunId);
    const firstCodes = [...new Set(firstFindings.map((row) => row.rule_code))].sort();

    await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
      dedupeKey: `checks.run:${FOLDER}:repeat`,
    });
    await drainQueue();

    const secondRunId = await latestRunId();
    expect(secondRunId).not.toBe(firstRunId);

    // История проверок и есть то, ради чего `validation_runs` существует.
    const firstAgain = await findingsOf(firstRunId);
    expect(firstAgain).toEqual(firstFindings);

    expect(
      await count(`SELECT count(*) AS count FROM materials WHERE folder_id = '${FOLDER}'`),
    ).toBe(materialsBefore);

    const secondCodes = [
      ...new Set((await findingsOf(secondRunId)).map((row) => row.rule_code)),
    ].sort();
    expect(secondCodes).toEqual(firstCodes);

    const failed = await testDb.query<{ job_type: string; error_message: string | null }>(
      `SELECT job_type, error_message FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);
  });
});

// =====================================================================
// 13. Область видимости профиля: правило вне списка не исполняется
// =====================================================================

describe('enabled_rule_codes профиля ограничивает прогон', () => {
  it('правило вне списка профиля пропущено с причиной not_in_profile', async () => {
    // Публикация следующей версии профиля: период предшественника закрывается
    // той же операцией, иначе ux_section_profiles_open_period отвергнет вставку.
    const enabled = DEFECT_RULES.map((code) => lit(code)).join(', ');
    await testDb.query(
      `UPDATE section_profiles SET effective_to = '${TODAY}'::date - 1
        WHERE id = '${SECTION_PROFILE_V1}'`,
    );
    await testDb.query(
      `INSERT INTO section_profiles (id, section_code, version, effective_from, effective_to,
                                     expected_doc_types, material_categories, material_matrix,
                                     enabled_rule_codes, thresholds, autonomy_level,
                                     published_at, published_by)
         VALUES ('${SECTION_PROFILE_V2}', 'roofing', 2, '${TODAY}'::date, NULL,
                 ARRAY[${lit('aosr')}, ${lit('annex_registry')}]::text[],
                 ARRAY[${lit('roll_waterproofing')}, ${lit('rebar')}, ${lit('ready_mix_concrete')}]::text[],
                 '{}'::jsonb, ARRAY[${enabled}]::text[], '{}'::jsonb, 'assisted',
                 now(), '${USER_ADMIN}')`,
    );

    await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
      dedupeKey: `checks.run:${FOLDER}:narrow-profile`,
    });
    await drainQueue();

    const narrowRunId = await latestRunId();
    const runs = await testDb.query<{ section_profile_id: string | null }>(
      `SELECT section_profile_id FROM validation_runs WHERE id = '${narrowRunId}'`,
    );
    expect(runs[0]?.section_profile_id).toBe(SECTION_PROFILE_V2);

    const journal = await journalOf(narrowRunId);
    const skipped = journal.skippedCodes;
    const excluded = ALL_RULE_CODES.filter((code) => !DEFECT_RULES.includes(code as never));
    expect(excluded.length).toBeGreaterThan(0);
    for (const code of excluded) {
      expect(skipped[code], `${code} обязан быть пропущен профилем`).toBe('not_in_profile');
    }
    expect(journal.executions.map((entry) => entry.ruleCode).sort()).toEqual(
      [...DEFECT_RULES].sort(),
    );

    // Пропущенное правило не оставляет замечаний: «пропущено» и «прошло» —
    // разное, и на экране это разные состояния.
    const codes = new Set((await findingsOf(narrowRunId)).map((row) => row.rule_code));
    for (const code of excluded) {
      expect(codes.has(code), `${code} оставил замечание, не будучи исполненным`).toBe(false);
    }
  });
});

// =====================================================================
// 14–15. Отказы состояния настройки: задача обязана падать, а не молчать
// =====================================================================

describe('задача честно отказывает вместо «замечаний нет»', () => {
  it('без активной версии набора правил прогон не начинается', async () => {
    const runsBefore = await count(
      `SELECT count(*) AS count FROM validation_runs WHERE folder_id = '${FOLDER}'`,
    );
    const findingsBefore = await count(`SELECT count(*) AS count FROM findings`);

    await testDb.query(`DELETE FROM app_settings WHERE key = 'ruleset.active_version_id'`);
    await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
      dedupeKey: `checks.run:${FOLDER}:no-ruleset`,
    });
    await drainQueue();

    const runsOfJob = await testDb.query<{ outcome: string | null; error_message: string | null }>(
      `SELECT r.outcome, r.error_message FROM job_runs r
         JOIN jobs j ON j.id = r.job_id
        WHERE j.dedupe_key = 'checks.run:${FOLDER}:no-ruleset'`,
    );
    expect(runsOfJob.length).toBeGreaterThan(0);
    for (const row of runsOfJob) expect(row.outcome).not.toBe('succeeded');
    expect(runsOfJob[0]?.error_message ?? '').toContain('Активная версия набора правил');

    const job = await testDb.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM jobs WHERE dedupe_key = 'checks.run:${FOLDER}:no-ruleset'`,
    );
    // Повтор ничего не изменит, пока администратор не опубликует набор.
    expect(job[0]?.status).toBe('failed');
    expect(job[0]?.last_error ?? '').toContain('Активная версия набора правил');

    // Отказ, оставивший после себя прогон или замечания, был бы хуже успеха.
    expect(
      await count(`SELECT count(*) AS count FROM validation_runs WHERE folder_id = '${FOLDER}'`),
    ).toBe(runsBefore);
    expect(await count(`SELECT count(*) AS count FROM findings`)).toBe(findingsBefore);

    await testDb.query(
      `INSERT INTO app_settings (key, value, updated_by)
         VALUES ('ruleset.active_version_id', ${lit(JSON.stringify(RULESET_VERSION))}::jsonb,
                 '${USER_ADMIN}')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by`,
    );
  });

  it('расхождение реестра правил и реализаций ловится в боевом пути', async () => {
    const runsBefore = await count(
      `SELECT count(*) AS count FROM validation_runs WHERE folder_id = '${FOLDER}'`,
    );

    // Правило, включённое администратором и не имеющее реализации, молча не
    // исполняется, и отличить это от исправной работы нечем (§9.6).
    await testDb.query(
      `INSERT INTO rule_definitions (code, title, level, kind, default_severity)
         VALUES ('PHANTOM.999', ${lit('Фантомное правило без реализации')},
                 'document', 'header', 'error')`,
    );

    await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
      dedupeKey: `checks.run:${FOLDER}:phantom`,
    });
    await drainQueue();

    const runsOfJob = await testDb.query<{ outcome: string | null; error_message: string | null }>(
      `SELECT r.outcome, r.error_message FROM job_runs r
         JOIN jobs j ON j.id = r.job_id
        WHERE j.dedupe_key = 'checks.run:${FOLDER}:phantom'`,
    );
    expect(runsOfJob.length).toBeGreaterThan(0);
    for (const row of runsOfJob) expect(row.outcome).not.toBe('succeeded');
    expect(runsOfJob[0]?.error_message ?? '').toContain('реестр правил разошёлся с реализациями');

    expect(
      await count(`SELECT count(*) AS count FROM validation_runs WHERE folder_id = '${FOLDER}'`),
    ).toBe(runsBefore);

    await testDb.query(`DELETE FROM rule_definitions WHERE code = 'PHANTOM.999'`);
  });
});
