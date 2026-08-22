/**
 * Инварианты схемы: проверяется, что ограничения РАБОТАЮТ, а не объявлены.
 *
 * Объявленный CHECK, не покрытый попыткой записать заведомо неверные данные, —
 * это документация, а не гарантия: опечатка в регулярном выражении, `NOT NULL`
 * вместо диапазона, триггер с WHEN-условием, которое никогда не истинно, дают
 * зелёный `pnpm test` и пропускают порчу данных в production. Поэтому каждый
 * тест ниже пишет неверную строку и требует отказа БД, а несколько тестов —
 * наоборот, требуют, чтобы законная операция прошла: триггер неизменяемости,
 * запрещающий всё подряд, ломает workflow ровно так же тихо.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

function dollarTagAt(sql: string, at: number): string | null {
  if (at > 0 && /[A-Za-z0-9_]/u.test(sql.charAt(at - 1))) return null;
  DOLLAR_TAG.lastIndex = at;
  return DOLLAR_TAG.exec(sql)?.[0] ?? null;
}

/**
 * Делит файл миграции на операторы: pglite исполняет запрос по расширенному
 * протоколу и файл целиком не принимает. Учитываются комментарии, кавычки и
 * строки в долларах — тело `deny_modification()` содержит и `;`, и `--`.
 *
 * Дублирует `splitSqlStatements` из `migrations.test.ts` сознательно: импорт
 * одного тест-файла из другого заставил бы vitest выполнить его наборы дважды,
 * а место общему помощнику — в `@id/db-harness`, а не в публичном API `@id/db`.
 */
function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  const flush = (): void => {
    if (current.trim() !== '') statements.push(current.trim());
    current = '';
  };

  while (index < sql.length) {
    const ch = sql.charAt(index);

    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const lineEnd = sql.indexOf('\n', index);
      index = lineEnd === -1 ? sql.length : lineEnd;
      continue;
    }

    if (ch === '/' && sql.charAt(index + 1) === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.charAt(index) === '/' && sql.charAt(index + 1) === '*') {
          depth += 1;
          index += 2;
        } else if (sql.charAt(index) === '*' && sql.charAt(index + 1) === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      current += ch;
      index += 1;
      while (index < sql.length) {
        const inner = sql.charAt(index);
        if (inner === ch && sql.charAt(index + 1) === ch) {
          current += ch + ch;
          index += 2;
          continue;
        }
        current += inner;
        index += 1;
        if (inner === ch) break;
      }
      continue;
    }

    if (ch === '$') {
      const tag = dollarTagAt(sql, index);
      if (tag !== null) {
        const close = sql.indexOf(tag, index + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        current += sql.slice(index, end);
        index = end;
        continue;
      }
    }

    if (ch === ';') {
      flush();
      index += 1;
      continue;
    }

    current += ch;
    index += 1;
  }

  flush();
  return statements;
}

// =====================================================================
// Фикстура: минимальный законный граф данных
// =====================================================================

/** Различимые uuid: в сообщениях об ошибках видно, какая строка не прошла. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Правдоподобный SHA-256: колонки закрыты CHECK на 64 hex-символа. */
function sha(marker: string): string {
  return marker.repeat(64).slice(0, 64);
}

const ID = {
  user: id(1),
  contractor: id(2),
  object: id(3),
  work: id(6),
  revision: id(7),
  sourceFile: id(8),
  page1: id(9),
  page2: id(10),
  bundle: id(11),
  layoutDraft: id(12),
  layoutFrozen: id(13),
  polygonBlock: id(14),
  document1: id(15),
  document2: id(16),
  rdRunDocument: id(17),
  recognitionRun: id(18),
  artifact: id(19),
  publishedPrompt: id(20),
  otherWork: id(21),
  otherRevision: id(22),
  otherDocument: id(23),
  approvedWork: id(24),
  approvedRevision: id(25),
  approvedDocument: id(26),
  reviewWork: id(27),
  reviewRevision: id(28),
  reviewDocument: id(29),
  reviewFile: id(30),
  reviewPage: id(31),
  approvedFile: id(32),
  approvedPage: id(33),
} as const;

/**
 * Законный граф: объект → включённый раздел → закреплённый подрядчик →
 * комплект → ревизия → файл → страницы → рабочий документ → разметка → прогон
 * распознавания → документы. Негативные тесты пристраиваются к нему, поэтому
 * его успешная вставка сама по себе доказывает, что ограничения не запрещают
 * штатный сценарий.
 */
const FIXTURE: readonly string[] = [
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${ID.user}', 'kc-sub-1', 'Инженер Тестовый')`,
  `INSERT INTO counterparties (id, name, inn, kpp, ogrn, kind)
     VALUES ('${ID.contractor}', 'ООО «Подрядчик»', '7700123459', '770901001',
             '1027700123450', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${ID.object}', 'ABC12', 'Корпус 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${ID.object}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${ID.object}', '${ID.contractor}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${ID.work}', '${ID.object}', '${ID.contractor}', '${ID.contractor}', 'roofing', DATE '2026-01-01', 'Комплект 1', '${ID.user}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${ID.revision}', '${ID.work}', '${ID.object}', '${ID.contractor}', 1)`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${sha('a')}', 'blobs/a', 1024, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
     VALUES ('${ID.sourceFile}', '${ID.revision}', '${sha('a')}', 'komplekt.pdf', 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index,
                             revision_ordinal, width_px, height_px)
     VALUES ('${ID.page1}', '${ID.revision}', '${ID.sourceFile}', 0, 0, 1654, 2339)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index,
                             revision_ordinal, width_px, height_px)
     VALUES ('${ID.page2}', '${ID.revision}', '${ID.sourceFile}', 1, 1, 1654, 2339)`,
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash,
                                   working_pdf_blob_sha256, builder_version)
     VALUES ('${ID.bundle}', '${ID.revision}', '${sha('b')}', '${sha('a')}', 'builder-1')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${ID.bundle}', '${ID.revision}', 0, '${ID.page1}')`,
  `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no)
     VALUES ('${ID.layoutDraft}', '${ID.revision}', '${ID.object}', '${ID.bundle}', 1)`,
  `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no,
                                 state, blocks_hash, frozen_at, frozen_by)
     VALUES ('${ID.layoutFrozen}', '${ID.revision}', '${ID.object}', '${ID.bundle}', 2,
             'frozen', '${sha('c')}', now(), '${ID.user}')`,
  `INSERT INTO layout_blocks (id, layout_revision_id, revision_id, bundle_id, source_page_id, working_page_index,
                              object_id, block_type, shape_type, x0, y0, x1, y1,
                              sort_order, source, detector_provenance)
     VALUES ('${ID.polygonBlock}', '${ID.layoutDraft}', '${ID.revision}', '${ID.bundle}', '${ID.page1}', 0, '${ID.object}',
             'text', 'polygon', 0.1, 0.1, 0.9, 0.5, 0, 'auto', 'rf_detr')`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.document1}', '${ID.revision}', '${ID.object}', '${ID.contractor}', 0)`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.document2}', '${ID.revision}', '${ID.object}', '${ID.contractor}', 1)`,
  `INSERT INTO rd_run_documents (id, layout_revision_id, rd_document_id, rd_project_id)
     VALUES ('${ID.rdRunDocument}', '${ID.layoutFrozen}', 'rd-doc-1', 'rd-project-1')`,
  `INSERT INTO recognition_runs (id, revision_id, layout_revision_id, rd_run_document_id,
                                 local_layout_hash, working_pdf_sha256)
     VALUES ('${ID.recognitionRun}', '${ID.revision}', '${ID.layoutFrozen}',
             '${ID.rdRunDocument}', '${sha('c')}', '${sha('a')}')`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ID.artifact}', '${ID.recognitionRun}', 'md', 'artifacts/md', '${sha('d')}', 4096)`,
  `INSERT INTO prompt_templates (id, code, version, stage, state, system_prompt,
                                 user_template, published_at, published_by)
     VALUES ('${ID.publishedPrompt}', 'page_classify_base', 1, 'page_classify', 'published',
             'системный промт', 'шаблон {{page}}', now(), '${ID.user}')`,
  // Вторая поставка нужна ровно для проверки составного FK: у одной поставки
  // может быть только одна draft-ревизия (частичный уникальный индекс).
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${ID.object}', '${ID.contractor}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${ID.otherWork}', '${ID.object}', '${ID.contractor}', '${ID.contractor}', 'roofing', DATE '2026-01-01', 'Комплект 2', '${ID.user}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${ID.otherRevision}', '${ID.otherWork}', '${ID.object}',
             '${ID.contractor}', 1)`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.otherDocument}', '${ID.otherRevision}', '${ID.object}',
             '${ID.contractor}', 0)`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${ID.object}', '${ID.contractor}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${ID.approvedWork}', '${ID.object}', '${ID.contractor}', '${ID.contractor}', 'roofing', DATE '2026-01-01', 'Комплект 3', '${ID.user}')`,
  // Содержимое создаётся в черновике, и только потом ревизия проводится по
  // статусам: вставить документ прямо в approved-ревизию нельзя — её запирает
  // тот самый триггер, который проверяют тесты ниже. Без этого шага тест
  // «запрещает правку согласованной ревизии» совпал бы с нулём строк и
  // проходил бы, ничего не проверяя.
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${ID.approvedRevision}', '${ID.approvedWork}', '${ID.object}',
             '${ID.contractor}', 1)`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.approvedDocument}', '${ID.approvedRevision}', '${ID.object}',
             '${ID.contractor}', 1)`,
  // Страница согласованной ревизии: нужна, чтобы проверить, что даже
  // производные флаги внимания в терминальном состоянии уже не пишутся.
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
     VALUES ('${ID.approvedFile}', '${ID.approvedRevision}', '${sha('a')}', 'komplekt.pdf', 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index,
                             revision_ordinal, width_px, height_px)
     VALUES ('${ID.approvedPage}', '${ID.approvedRevision}', '${ID.approvedFile}', 0, 0, 1654, 2339)`,
  `UPDATE submission_revisions
      SET status = 'submitted', submitted_at = now(), submitted_by = '${ID.user}'
    WHERE id = '${ID.approvedRevision}'`,
  `UPDATE submission_revisions SET status = 'in_review' WHERE id = '${ID.approvedRevision}'`,
  `UPDATE submission_revisions
      SET status = 'approved', decided_at = now(), decided_by = '${ID.user}'
    WHERE id = '${ID.approvedRevision}'`,
  // Ревизия на проверке у инженера. Отдельная фикстура нужна потому, что
  // in_review — это рабочее состояние, а не терминальное: первая версия
  // триггеров запирала его вместе с approved и оставляла инженеру единственное
  // действие — вернуть всю ревизию подрядчику.
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${ID.object}', '${ID.contractor}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${ID.reviewWork}', '${ID.object}', '${ID.contractor}', '${ID.contractor}', 'roofing', DATE '2026-01-01', 'Комплект 4', '${ID.user}')`,
  // Состав подаётся черновиком и только потом ревизия уходит на проверку:
  // вставить файл и страницы прямо в in_review нельзя — это и есть запрет,
  // который проверяется ниже.
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
     VALUES ('${ID.reviewRevision}', '${ID.reviewWork}', '${ID.object}',
             '${ID.contractor}', 1)`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
     VALUES ('${ID.reviewFile}', '${ID.reviewRevision}', '${sha('a')}', 'komplekt.pdf', 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index,
                             revision_ordinal, width_px, height_px)
     VALUES ('${ID.reviewPage}', '${ID.reviewRevision}', '${ID.reviewFile}', 0, 0, 1654, 2339)`,
  `UPDATE submission_revisions
      SET status = 'submitted', submitted_at = now(), submitted_by = '${ID.user}'
    WHERE id = '${ID.reviewRevision}'`,
  `UPDATE submission_revisions SET status = 'in_review' WHERE id = '${ID.reviewRevision}'`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.reviewDocument}', '${ID.reviewRevision}', '${ID.object}',
             '${ID.contractor}', 1)`,
];

let db: TestDatabase;

beforeAll(async () => {
  db = await createPgliteDatabase();

  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    for (const statement of splitSqlStatements(migration.sql)) {
      await db.query(statement);
    }
  }
  for (const statement of FIXTURE) {
    await db.query(statement);
  }
}, 180_000);

afterAll(async () => {
  await db.close();
});

/** Блок разметки с заданной геометрией; всё остальное — законное. */
function blockWith(x0: number, y0: number, x1: number, y1: number, sortOrder: number): string {
  return `INSERT INTO layout_blocks (layout_revision_id, revision_id, bundle_id, source_page_id, working_page_index,
                                     object_id, block_type, shape_type, x0, y0, x1, y1,
                                     sort_order, source, detector_provenance)
            VALUES ('${ID.layoutDraft}', '${ID.revision}', '${ID.bundle}', '${ID.page1}', 0, '${ID.object}', 'text', 'rectangle',
                    ${x0}, ${y0}, ${x1}, ${y1}, ${sortOrder}, 'user', 'user')`;
}

describe('форма реквизитов справочников', () => {
  it('отвергает код объекта из 4 символов', async () => {
    await expect(
      db.query(
        `INSERT INTO construction_objects (code, name, full_name)
           VALUES ('ABC1', 'Корпус', 'Корпус полностью')`,
      ),
    ).rejects.toThrow(/construction_objects_code_chk/u);
  });

  it('отвергает код объекта из 6 символов', async () => {
    await expect(
      db.query(
        `INSERT INTO construction_objects (code, name, full_name)
           VALUES ('ABC123', 'Корпус', 'Корпус полностью')`,
      ),
    ).rejects.toThrow(/too long|character varying\(5\)/u);
  });

  it('отвергает ИНН из 11 цифр', async () => {
    await expect(
      db.query(
        `INSERT INTO counterparties (name, inn, kind)
           VALUES ('ООО «Одиннадцать»', '12345678901', 'supplier')`,
      ),
    ).rejects.toThrow(/counterparties_inn_chk/u);
  });

  it('отвергает КПП из 8 цифр', async () => {
    await expect(
      db.query(
        `INSERT INTO counterparties (name, kpp, kind)
           VALUES ('ООО «Восемь»', '12345678', 'supplier')`,
      ),
    ).rejects.toThrow(/counterparties_kpp_chk/u);
  });

  // 102770012345 — ОГРН из акта корпуса: 12 цифр вместо 13. Правило AOSR.HDR
  // обязано увидеть его в извлечённом реквизите, но в справочник контрагентов
  // такое значение попасть не должно.
  it('отвергает ОГРН из 12 цифр', async () => {
    await expect(
      db.query(
        `INSERT INTO counterparties (name, ogrn, kind)
           VALUES ('ООО «Тест-Строй»', '102770012345', 'supplier')`,
      ),
    ).rejects.toThrow(/counterparties_ogrn_chk/u);
  });

  it('отвергает ОГРН из 14 цифр', async () => {
    await expect(
      db.query(
        `INSERT INTO counterparties (name, ogrn, kind)
           VALUES ('ООО «Четырнадцать»', '10277001234512', 'supplier')`,
      ),
    ).rejects.toThrow(/counterparties_ogrn_chk/u);
  });
});

describe('геометрия разметки', () => {
  it('отвергает блок с x0 > x1', async () => {
    await expect(db.query(blockWith(0.9, 0.1, 0.2, 0.5, 101))).rejects.toThrow(
      /layout_blocks_coords_chk/u,
    );
  });

  it('отвергает блок с y1 = 1.5', async () => {
    await expect(db.query(blockWith(0.1, 0.1, 0.2, 1.5, 102))).rejects.toThrow(
      /layout_blocks_coords_chk/u,
    );
  });

  it('отвергает блок с x0 = -0.1', async () => {
    await expect(db.query(blockWith(-0.1, 0.1, 0.2, 0.5, 103))).rejects.toThrow(
      /layout_blocks_coords_chk/u,
    );
  });

  // Без этой проверки CHECK вида `false` прошёл бы все негативные тесты выше.
  it('принимает блок в границах страницы', async () => {
    await expect(db.query(blockWith(0.1, 0.1, 0.2, 0.5, 104))).resolves.toStrictEqual([]);
  });

  it('отвергает точку полигона с x = 2', async () => {
    await expect(
      db.query(
        `INSERT INTO layout_block_points (block_id, point_no, x, y)
           VALUES ('${ID.polygonBlock}', 10, 2, 0.5)`,
      ),
    ).rejects.toThrow(/layout_block_points_x_chk/u);
  });

  it('принимает точку полигона внутри страницы', async () => {
    await expect(
      db.query(
        `INSERT INTO layout_block_points (block_id, point_no, x, y)
           VALUES ('${ID.polygonBlock}', 0, 0.5, 0.5)`,
      ),
    ).resolves.toStrictEqual([]);
  });
});

describe('учёт страниц и связи документов', () => {
  it('не даёт привязать одну source_page к двум документам одной ревизии', async () => {
    await db.query(
      `INSERT INTO page_assignments (revision_id, document_id, source_page_id, sort_order)
         VALUES ('${ID.revision}', '${ID.document1}', '${ID.page1}', 0)`,
    );

    await expect(
      db.query(
        `INSERT INTO page_assignments (revision_id, document_id, source_page_id, sort_order)
           VALUES ('${ID.revision}', '${ID.document2}', '${ID.page1}', 0)`,
      ),
    ).rejects.toThrow(/page_assignments_page_uq/u);
  });

  it('не даёт связать document_page с документом другой ревизии', async () => {
    await expect(
      db.query(
        `INSERT INTO page_assignments (revision_id, document_id, source_page_id, sort_order)
           VALUES ('${ID.revision}', '${ID.otherDocument}', '${ID.page2}', 0)`,
      ),
    ).rejects.toThrow(/page_assignments_document_fk/u);
  });

  it('отвергает самоссылку в document_relations', async () => {
    await expect(
      db.query(
        `INSERT INTO document_relations (parent_document_id, child_document_id, relation, revision_id)
           VALUES ('${ID.document1}', '${ID.document1}', 'annex', '${ID.revision}')`,
      ),
    ).rejects.toThrow(/document_relations_self_chk/u);
  });

  it('принимает связь двух разных документов', async () => {
    await expect(
      db.query(
        `INSERT INTO document_relations (parent_document_id, child_document_id, relation, revision_id)
           VALUES ('${ID.document1}', '${ID.document2}', 'annex', '${ID.revision}')`,
      ),
    ).resolves.toStrictEqual([]);
  });
});

describe('неизменяемость на уровне БД (§3.9)', () => {
  it('запрещает UPDATE согласованной ревизии комплекта', async () => {
    await expect(
      db.query(
        `UPDATE submission_revisions SET return_reason = 'переоткрыть'
           WHERE id = '${ID.approvedRevision}'`,
      ),
    ).rejects.toThrow(/согласованную ревизию поставки/u);
  });

  // Контроль: триггер обязан различать состояния, а не запрещать любой UPDATE.
  it('разрешает UPDATE черновика ревизии комплекта', async () => {
    await db.query(
      `UPDATE submission_revisions SET version = version + 1 WHERE id = '${ID.revision}'`,
    );

    const rows = await db.query<{ version: number }>(
      `SELECT version FROM submission_revisions WHERE id = '${ID.revision}'`,
    );
    expect(rows[0]?.version).toBe(1);
  });

  // Группа ниже защищает от перерасширения запрета — дефекта, который уже
  // возникал: триггеры заперли in_review вместе с approved, и работа инженера
  // стала невозможна. Такой триггер выглядит исправным (верные сообщения,
  // верный ERRCODE) и при этом делает продукт неработоспособным, поэтому
  // разрешённые действия проверяются так же строго, как запрещённые.
  it('разрешает инженеру подтвердить документ в in_review', async () => {
    await db.query(
      `UPDATE logical_documents SET is_confirmed = true, confirmed_by = '${ID.user}',
              confirmed_at = now()
         WHERE id = '${ID.reviewDocument}'`,
    );

    const rows = await db.query<{ is_confirmed: boolean }>(
      `SELECT is_confirmed FROM logical_documents WHERE id = '${ID.reviewDocument}'`,
    );
    expect(rows[0]?.is_confirmed).toBe(true);
  });

  it('разрешает инженеру править границы документов в in_review', async () => {
    await db.query(
      `INSERT INTO logical_documents (revision_id, object_id, contractor_id, ordinal)
         VALUES ('${ID.reviewRevision}', '${ID.object}', '${ID.contractor}', 2)`,
    );

    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM logical_documents
         WHERE revision_id = '${ID.reviewRevision}'`,
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('запрещает менять поданный состав файлов даже в in_review', async () => {
    // Обратная сторона того же разделения: содержимое, покрытое
    // aggregate_manifest_hash, заперто с момента submit, иначе хэш описывал бы
    // состав, которого больше нет.
    await expect(
      db.query(
        `INSERT INTO source_files (revision_id, blob_sha256, file_name, sort_order)
           VALUES ('${ID.reviewRevision}', '${sha('a')}', 'подмена.pdf', 1)`,
      ),
    ).rejects.toThrow(/исходный файл/u);
  });

  /**
   * Флаги внимания — производные данные, а не состав поставки (миграция 0013).
   *
   * Разметку правит и инженер, а на проверке ревизия уже `submitted`/`in_review`.
   * Запрет на запись флагов там означал, что детекция отрабатывает, а
   * `attention_flags` остаётся пуст, и «флагов нет» становится неотличимо от
   * «флаги не записаны».
   */
  it('разрешает записать флаги внимания страницы на ревизии в проверке', async () => {
    await db.query(
      `UPDATE source_pages SET attention_flags = ARRAY['no_blocks','low_coverage']::text[]
         WHERE id = '${ID.reviewPage}'`,
    );
    const rows = await db.query<{ flags: string[] }>(
      `SELECT attention_flags AS flags FROM source_pages WHERE id = '${ID.reviewPage}'`,
    );
    expect(rows[0]?.flags).toEqual(['no_blocks', 'low_coverage']);
  });

  it('состав страницы в проверке по-прежнему заперт', async () => {
    // Обратная сторона того же послабления: производной объявлена ОДНА колонка,
    // а не строка целиком. Иначе ремонт открыл бы дыру шире дефекта.
    await expect(
      db.query(`UPDATE source_pages SET rotation = 90 WHERE id = '${ID.reviewPage}'`),
    ).rejects.toThrow(/страницу исходного файла/u);

    await expect(
      db.query(
        `UPDATE source_pages SET attention_flags = ARRAY['tiny_block']::text[], width_px = 100
           WHERE id = '${ID.reviewPage}'`,
      ),
    ).rejects.toThrow(/страницу исходного файла/u);

    await expect(
      db.query(
        `INSERT INTO source_pages (revision_id, source_file_id, file_page_index,
                                   revision_ordinal, width_px, height_px)
           VALUES ('${ID.reviewRevision}', '${ID.reviewFile}', 9, 9, 1654, 2339)`,
      ),
    ).rejects.toThrow(/страницу исходного файла/u);

    await expect(
      db.query(`DELETE FROM source_pages WHERE id = '${ID.reviewPage}'`),
    ).rejects.toThrow(/страницу исходного файла/u);
  });

  it('в согласованной ревизии не пишутся даже флаги внимания', async () => {
    await expect(
      db.query(
        `UPDATE source_pages SET attention_flags = ARRAY['no_blocks']::text[]
           WHERE id = '${ID.approvedPage}'`,
      ),
    ).rejects.toThrow(/страницу исходного файла/u);
  });

  it('запрещает правку документа в согласованной ревизии', async () => {
    await expect(
      db.query(
        `UPDATE logical_documents SET is_confirmed = false
           WHERE revision_id = '${ID.approvedRevision}'`,
      ),
    ).rejects.toThrow(/логический документ/u);
  });

  it('запрещает UPDATE замороженной ревизии разметки', async () => {
    await expect(
      db.query(
        `UPDATE layout_revisions SET blocks_hash = '${sha('e')}'
           WHERE id = '${ID.layoutFrozen}'`,
      ),
    ).rejects.toThrow(/замороженную ревизию разметки/u);
  });

  it('разрешает UPDATE черновика ревизии разметки', async () => {
    await db.query(
      `UPDATE layout_revisions SET version = version + 1 WHERE id = '${ID.layoutDraft}'`,
    );

    const rows = await db.query<{ version: number }>(
      `SELECT version FROM layout_revisions WHERE id = '${ID.layoutDraft}'`,
    );
    expect(rows[0]?.version).toBe(1);
  });

  it('запрещает UPDATE artifact_versions', async () => {
    await expect(
      db.query(
        `UPDATE artifact_versions SET s3_key = 'artifacts/other' WHERE id = '${ID.artifact}'`,
      ),
    ).rejects.toThrow(/артефакт прогона распознавания/u);
  });

  it('запрещает DELETE artifact_versions', async () => {
    await expect(
      db.query(`DELETE FROM artifact_versions WHERE id = '${ID.artifact}'`),
    ).rejects.toThrow(/артефакт прогона распознавания/u);

    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifact_versions WHERE id = '${ID.artifact}'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('запрещает UPDATE опубликованного промта', async () => {
    await expect(
      db.query(
        `UPDATE prompt_templates SET system_prompt = 'подменённый'
           WHERE id = '${ID.publishedPrompt}'`,
      ),
    ).rejects.toThrow(/опубликованный промт/u);
  });

  it('разрешает правку черновика промта', async () => {
    await db.query(
      `INSERT INTO prompt_templates (code, version, stage, system_prompt, user_template)
         VALUES ('page_classify_base', 2, 'page_classify', 'черновик', 'шаблон')`,
    );

    await db.query(
      `UPDATE prompt_templates SET system_prompt = 'исправленный черновик'
         WHERE code = 'page_classify_base' AND version = 2`,
    );

    const rows = await db.query<{ system_prompt: string }>(
      `SELECT system_prompt FROM prompt_templates
         WHERE code = 'page_classify_base' AND version = 2`,
    );
    expect(rows[0]?.system_prompt).toBe('исправленный черновик');
  });
});

// =====================================================================
// Реестр передачи: снимок и замок (0028)
// =====================================================================

/**
 * Реестр и его опись проверяются отдельным набором, потому что их инварианты
 * держат не форму данных, а НЕОБРАТИМОСТЬ передачи. Подпись «Передал» стоит под
 * конкретным списком работ; если этот список после подписи можно дописать,
 * переименовать или удалить, подпись перестаёт что-либо значить — и никакая
 * проверка в приложении этого не заменит, потому что она обходится прямым SQL.
 */
describe('реестр передачи: снимок состава и неизменяемость после передачи', () => {
  const REGISTRY = id(60);
  const REGISTRY_OTHER = id(61);
  const FILE_WORK = id(62);
  const FILE_WORK_SECOND = id(63);
  const FILE_REVISION = id(64);

  beforeAll(async () => {
    await db.query(
      `INSERT INTO registries (id, object_id, section_code, period, number, created_by)
         VALUES ('${REGISTRY}', '${ID.object}', 'roofing', DATE '2026-01-01', '1', '${ID.user}')`,
    );
    await db.query(
      `INSERT INTO registries (id, object_id, section_code, period, created_by)
         VALUES ('${REGISTRY_OTHER}', '${ID.object}', 'roofing', DATE '2026-01-01', '${ID.user}')`,
    );
    await db.query(
      `INSERT INTO registry_items (registry_id, ordinal, work_id, revision_id, contractor_id, title)
         VALUES ('${REGISTRY}', 1, '${ID.work}', '${ID.revision}', '${ID.contractor}', 'Комплект 1')`,
    );
  });

  it('месяц реестра задаётся первым числом', async () => {
    await expect(
      db.query(
        `INSERT INTO registries (id, object_id, section_code, period, created_by)
           VALUES ('${id(65)}', '${ID.object}', 'roofing', DATE '2026-01-15', '${ID.user}')`,
      ),
    ).rejects.toThrow();
  });

  it('номер реестра уникален в пределах объекта', async () => {
    await expect(
      db.query(
        `INSERT INTO registries (id, object_id, section_code, period, number, created_by)
           VALUES ('${id(66)}', '${ID.object}', 'roofing', DATE '2026-02-01', '1', '${ID.user}')`,
      ),
    ).rejects.toThrow();
  });

  it('строка снимка неизменяема и неудаляема, пока реестр не черновик', async () => {
    // Пока реестр черновик, снимок ещё правится: он собирается той же
    // транзакцией, которая переводит статус, и запрет на черновике сделал бы
    // передачу невозможной.
    await db.query(
      `UPDATE registry_items SET title = 'Комплект 1, уточнённый'
         WHERE registry_id = '${REGISTRY}'`,
    );

    await db.query(`UPDATE registries SET status = 'issued' WHERE id = '${REGISTRY}'`);

    await expect(
      db.query(`UPDATE registry_items SET title = 'подмена' WHERE registry_id = '${REGISTRY}'`),
    ).rejects.toThrow(/реестр/iu);
    await expect(
      db.query(`DELETE FROM registry_items WHERE registry_id = '${REGISTRY}'`),
    ).rejects.toThrow(/реестр/iu);

    const rows = await db.query<{ title: string }>(
      `SELECT title FROM registry_items WHERE registry_id = '${REGISTRY}'`,
    );
    expect(rows[0]?.title).toBe('Комплект 1, уточнённый');
  });

  it('переданный реестр меняет только статус, версию и подпись приёмки', async () => {
    // Приёмка проходит: это и есть разрешённый переход.
    await db.query(
      `UPDATE registries SET status = 'accepted', accepted_by = '${ID.user}',
              accepted_at = now(), version = version + 1 WHERE id = '${REGISTRY}'`,
    );

    // Шапка — нет: она напечатана в подписанной бумаге.
    await expect(
      db.query(`UPDATE registries SET number = '99' WHERE id = '${REGISTRY}'`),
    ).rejects.toThrow(/реестр/iu);
    await expect(
      db.query(`UPDATE registries SET period = DATE '2026-03-01' WHERE id = '${REGISTRY}'`),
    ).rejects.toThrow(/реестр/iu);
    await expect(db.query(`DELETE FROM registries WHERE id = '${REGISTRY}'`)).rejects.toThrow(
      /реестр/iu,
    );
  });

  it('переданный реестр не возвращается в черновик', async () => {
    await expect(
      db.query(`UPDATE registries SET status = 'draft' WHERE id = '${REGISTRY}'`),
    ).rejects.toThrow(/реестр/iu);
  });

  it('у реестра не больше одного файла описи', async () => {
    await db.query(
      `INSERT INTO works
         (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
          kind, registry_id, title, created_by)
       VALUES ('${FILE_WORK}', '${ID.object}', '${ID.contractor}', '${ID.contractor}',
               'roofing', DATE '2026-01-01', 'registry', '${REGISTRY_OTHER}',
               'Файл реестра', '${ID.user}')`,
    );
    await db.query(
      `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no)
         VALUES ('${FILE_REVISION}', '${FILE_WORK}', '${ID.object}', '${ID.contractor}', 1)`,
    );

    await expect(
      db.query(
        `INSERT INTO works
           (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
            kind, registry_id, title, created_by)
         VALUES ('${FILE_WORK_SECOND}', '${ID.object}', '${ID.contractor}', '${ID.contractor}',
                 'roofing', DATE '2026-01-01', 'registry', '${REGISTRY_OTHER}',
                 'Второй файл', '${ID.user}')`,
      ),
    ).rejects.toThrow();
  });

  it('файл описи без реестра завести нельзя', async () => {
    await expect(
      db.query(
        `INSERT INTO works
           (id, object_id, contractor_id, managed_by_contractor_id, section_code, period,
            kind, title, created_by)
         VALUES ('${id(67)}', '${ID.object}', '${ID.contractor}', '${ID.contractor}',
                 'roofing', DATE '2026-01-01', 'registry', 'Файл без папки', '${ID.user}')`,
      ),
    ).rejects.toThrow();
  });

  it('комплект нельзя завести в разделе, не включённом на объекте', async () => {
    await expect(
      db.query(
        `INSERT INTO works
           (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
         VALUES ('${id(68)}', '${ID.object}', '${ID.contractor}', '${ID.contractor}',
                 'masonry', DATE '2026-01-01', 'Кладка без включённого раздела', '${ID.user}')`,
      ),
    ).rejects.toThrow();
  });

  it('комплект нельзя завести подрядчику, не закреплённому за объектом', async () => {
    const stranger = id(69);
    await db.query(
      `INSERT INTO counterparties (id, name, kind)
         VALUES ('${stranger}', 'ООО «Незакреплённый»', 'contractor')`,
    );
    await expect(
      db.query(
        `INSERT INTO works
           (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
         VALUES ('${id(70)}', '${ID.object}', '${stranger}', '${stranger}',
                 'roofing', DATE '2026-01-01', 'Комплект незакреплённого', '${ID.user}')`,
      ),
    ).rejects.toThrow();
  });
});
