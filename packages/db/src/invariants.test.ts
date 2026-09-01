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
  folder: id(7),
  sourceFile: id(8),
  page1: id(9),
  page2: id(10),
  bundle: id(11),
  layoutDraft: id(12),
  layoutSuperseded: id(13),
  polygonBlock: id(14),
  document1: id(15),
  document2: id(16),
  rdRunDocument: id(17),
  recognitionRun: id(18),
  artifact: id(19),
  publishedPrompt: id(20),
  otherWork: id(21),
  otherFolder: id(22),
  otherDocument: id(23),
  approvedWork: id(24),
  approvedFolder: id(25),
  approvedDocument: id(26),
  reviewWork: id(27),
  reviewFolder: id(28),
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
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
         VALUES ('${ID.folder}', '${ID.object}', '${ID.contractor}', '${ID.contractor}', 'roofing', DATE '2026-01-01', 'Комплект 1', '${ID.user}')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${sha('a')}', 'blobs/a', 1024, 'application/pdf')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order)
     VALUES ('${ID.sourceFile}', '${ID.folder}', '${sha('a')}', 'komplekt.pdf', 0)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index,
                             folder_ordinal, width_px, height_px)
     VALUES ('${ID.page1}', '${ID.folder}', '${ID.sourceFile}', 0, 0, 1654, 2339)`,
  `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index,
                             folder_ordinal, width_px, height_px)
     VALUES ('${ID.page2}', '${ID.folder}', '${ID.sourceFile}', 1, 1, 1654, 2339)`,
  `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash,
                                   working_pdf_blob_sha256, builder_version)
     VALUES ('${ID.bundle}', '${ID.folder}', '${sha('b')}', '${sha('a')}', 'builder-1')`,
  `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
     VALUES ('${ID.bundle}', '${ID.folder}', 0, '${ID.page1}')`,
  `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no)
     VALUES ('${ID.layoutDraft}', '${ID.folder}', '${ID.object}', '${ID.bundle}', 1)`,
  `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no,
                                 state, blocks_hash, frozen_at, frozen_by)
     VALUES ('${ID.layoutSuperseded}', '${ID.folder}', '${ID.object}', '${ID.bundle}', 2,
             'superseded', '${sha('c')}', now(), '${ID.user}')`,
  `INSERT INTO layout_blocks (id, layout_revision_id, folder_id, bundle_id, source_page_id, working_page_index,
                              object_id, block_type, shape_type, x0, y0, x1, y1,
                              sort_order, source, detector_provenance)
     VALUES ('${ID.polygonBlock}', '${ID.layoutDraft}', '${ID.folder}', '${ID.bundle}', '${ID.page1}', 0, '${ID.object}',
             'text', 'polygon', 0.1, 0.1, 0.9, 0.5, 0, 'auto', 'rf_detr')`,
  `INSERT INTO logical_documents (id, folder_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.document1}', '${ID.folder}', '${ID.object}', '${ID.contractor}', 0)`,
  `INSERT INTO logical_documents (id, folder_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.document2}', '${ID.folder}', '${ID.object}', '${ID.contractor}', 1)`,
  `INSERT INTO rd_run_documents (id, layout_revision_id, rd_document_id, rd_project_id)
     VALUES ('${ID.rdRunDocument}', '${ID.layoutSuperseded}', 'rd-doc-1', 'rd-project-1')`,
  `INSERT INTO recognition_runs (id, folder_id, layout_revision_id, rd_run_document_id,
                                 local_layout_hash, working_pdf_sha256)
     VALUES ('${ID.recognitionRun}', '${ID.folder}', '${ID.layoutSuperseded}',
             '${ID.rdRunDocument}', '${sha('c')}', '${sha('a')}')`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ID.artifact}', '${ID.recognitionRun}', 'md', 'artifacts/md', '${sha('d')}', 4096)`,
  `INSERT INTO prompt_templates (id, code, version, stage, state, system_prompt,
                                 user_template, published_at, published_by)
     VALUES ('${ID.publishedPrompt}', 'page_classify_base', 1, 'page_classify', 'published',
             'системный промт', 'шаблон {{page}}', now(), '${ID.user}')`,
  // Вторая папка нужна ровно для проверки составного FK: документ одной папки
  // не может сослаться на страницу другой.
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${ID.otherFolder}', '${ID.object}', '${ID.contractor}', '${ID.contractor}', 'roofing', DATE '2026-01-01', 'Папка 2', '${ID.user}')`,
  `INSERT INTO logical_documents (id, folder_id, object_id, contractor_id, ordinal)
     VALUES ('${ID.otherDocument}', '${ID.otherFolder}', '${ID.object}',
             '${ID.contractor}', 0)`,
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
  return `INSERT INTO layout_blocks (layout_revision_id, folder_id, bundle_id, source_page_id, working_page_index,
                                     object_id, block_type, shape_type, x0, y0, x1, y1,
                                     sort_order, source, detector_provenance)
            VALUES ('${ID.layoutDraft}', '${ID.folder}', '${ID.bundle}', '${ID.page1}', 0, '${ID.object}', 'text', 'rectangle',
                    ${x0}, ${y0}, ${x1}, ${y1}, ${sortOrder}, 'user', 'user')`;
}

describe('форма реквизитов справочников', () => {
  /**
   * Кириллический код — проверка ЛОКАЛИ кластера, а не только ограничения.
   *
   * Ограничение намеренно выражено запретом пробелов, управляющих и знаков
   * пунктуации, а не разрешением `[:alnum:]`: последний класс для кириллицы
   * зависит от `LC_CTYPE`, и на базе в локали `C` буква «З» им не покрывается.
   * Тест вставляет `ЗИЛ18` в НАСТОЯЩУЮ базу, поэтому проходит он тогда и только
   * тогда, когда правило одинаково ведёт себя на боевом кластере.
   */
  it('принимает код объекта из кириллицы и одиночную букву', async () => {
    await expect(
      db.query(
        `INSERT INTO construction_objects (code, name, full_name)
           VALUES ('ЗИЛ18', 'Корпус', 'Корпус полностью'),
                  ('Ц', 'Корпус Ц', 'Корпус Ц полностью'),
                  ('ABC1', 'Корпус короткий', 'Корпус короткий полностью')`,
      ),
    ).resolves.toBeDefined();
  });

  it('отвергает код объекта с разделителем', async () => {
    await expect(
      db.query(
        `INSERT INTO construction_objects (code, name, full_name)
           VALUES ('ЗИЛ-8', 'Корпус', 'Корпус полностью')`,
      ),
    ).rejects.toThrow(/construction_objects_code_chk/u);
  });

  it('отвергает пустой код объекта', async () => {
    await expect(
      db.query(
        `INSERT INTO construction_objects (code, name, full_name)
           VALUES ('', 'Корпус', 'Корпус полностью')`,
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
      `INSERT INTO page_assignments (folder_id, document_id, source_page_id, sort_order)
         VALUES ('${ID.folder}', '${ID.document1}', '${ID.page1}', 0)`,
    );

    await expect(
      db.query(
        `INSERT INTO page_assignments (folder_id, document_id, source_page_id, sort_order)
           VALUES ('${ID.folder}', '${ID.document2}', '${ID.page1}', 0)`,
      ),
    ).rejects.toThrow(/page_assignments_page_uq/u);
  });

  it('не даёт связать document_page с документом другой ревизии', async () => {
    await expect(
      db.query(
        `INSERT INTO page_assignments (folder_id, document_id, source_page_id, sort_order)
           VALUES ('${ID.folder}', '${ID.otherDocument}', '${ID.page2}', 0)`,
      ),
    ).rejects.toThrow(/page_assignments_document_fk/u);
  });

  it('отвергает самоссылку в document_relations', async () => {
    await expect(
      db.query(
        `INSERT INTO document_relations (parent_document_id, child_document_id, relation, folder_id)
           VALUES ('${ID.document1}', '${ID.document1}', 'annex', '${ID.folder}')`,
      ),
    ).rejects.toThrow(/document_relations_self_chk/u);
  });

  it('принимает связь двух разных документов', async () => {
    await expect(
      db.query(
        `INSERT INTO document_relations (parent_document_id, child_document_id, relation, folder_id)
           VALUES ('${ID.document1}', '${ID.document2}', 'annex', '${ID.folder}')`,
      ),
    ).resolves.toStrictEqual([]);
  });
});

describe('неизменяемость производного и справочников', () => {
  it('запрещает UPDATE вытесненной ревизии разметки', async () => {
    // Заморозки нет (0048), но `superseded` осталась запертой: по её
    // `blocks_hash` уже прошёл прогон, и артефакты обязаны воспроизводиться.
    await expect(
      db.query(
        `UPDATE layout_revisions SET blocks_hash = '${sha('e')}'
           WHERE id = '${ID.layoutSuperseded}'`,
      ),
    ).rejects.toThrow(/вытесненную ревизию разметки/u);
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

  /**
   * Артефакт неизменяем ВСЕГДА на правку и удаляем только вместе с черновиком
   * (миграция 0035, ADR-0015).
   *
   * До S24 запрет на удаление был безусловным. Практическое следствие оказалось
   * не тем, ради которого он ставился: подрядчик не мог убрать ошибочный файл из
   * СВОЕГО ЖЕ черновика, если успел нажать «Распознать», — и получал пятисотый
   * код из драйвера вместо объяснения.
   *
   * Артефакт доказывает, что именно проверяли, а проверяют поданное. Пока
   * ревизия черновик, доказывать нечего: хэш состава не записан, наружу ничего
   * не уходило. Поэтому проверяются ОБЕ стороны — иначе тест доказывал бы только
   * то, что послабление удалось внести.
   */
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
// Выключатель неизменяемости (0035, S24)
// =====================================================================

/**
 * Режим тестирования проверяется в ОБЕ стороны, и это принципиально.
 *
 * Выключатель ослабляет инвариант §3.9 — самый дорогой из объявленных. Тест,
 * проверяющий только что «при false запись проходит», доказывает лишь, что
 * защиту удалось снять. Вопрос, ради которого выключатель и сделан
 * выключателем, другой: ВЕРНЁТСЯ ли строгость. Поэтому каждый набор ниже
 * возвращает флаг обратно и требует прежнего отказа.
 *
 * Проверяется и умолчание: строки в `app_settings` нет ни в одной базе, и
 * забытая настройка обязана означать строгий режим, а не открытый.
 */
describe('отсроченные ключи области (0054)', () => {
  const OTHER_ORG = id(90);

  beforeAll(async () => {
    await db.query(
      `INSERT INTO counterparties (id, name, kind)
         VALUES ('${OTHER_ORG}', 'ООО «Второй подрядчик»', 'contractor')
       ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO object_contractors (object_id, contractor_id)
         VALUES ('${ID.object}', '${OTHER_ORG}') ON CONFLICT DO NOTHING`,
    );
  });

  it('без отсрочки одиночная правка исполнителя отвергается сразу', async () => {
    await expect(
      db.query(`UPDATE folders SET contractor_id = '${OTHER_ORG}' WHERE id = '${ID.folder}'`),
    ).rejects.toThrow();
  });

  it('в отсрочке промежуточное состояние проходит, а оборванная ссылка падает на COMMIT', async () => {
    await db.query('BEGIN');
    await db.query(`
      SET CONSTRAINTS logical_documents_scope_fk, findings_scope_fk DEFERRED
    `);

    // Промежуточное состояние: у папки новый исполнитель, у документов — ещё
    // прежний. Вне отсрочки этот оператор не прошёл бы вовсе.
    await db.query(`UPDATE folders SET contractor_id = '${OTHER_ORG}' WHERE id = '${ID.folder}'`);

    // Копии НЕ обновлены намеренно: проверяется, что коммит это заметит.
    await expect(db.query('COMMIT')).rejects.toThrow();
    await db.query('ROLLBACK');

    const rows = await db.query<{ contractor_id: string }>(
      `SELECT contractor_id FROM folders WHERE id = '${ID.folder}'`,
    );
    expect(rows[0]?.contractor_id).toBe(ID.contractor);
  });

  it('в отсрочке согласованная правка обеих сторон проходит целиком', async () => {
    const move = async (to: string): Promise<void> => {
      await db.query('BEGIN');
      await db.query(`
        SET CONSTRAINTS logical_documents_scope_fk, findings_scope_fk DEFERRED
      `);
      await db.query(`UPDATE folders SET contractor_id = '${to}' WHERE id = '${ID.folder}'`);
      await db.query(
        `UPDATE logical_documents SET contractor_id = '${to}'
          WHERE folder_id = '${ID.folder}'`,
      );
      await db.query(
        `UPDATE findings SET contractor_id = '${to}' WHERE folder_id = '${ID.folder}'`,
      );
      await db.query('COMMIT');
    };

    await move(OTHER_ORG);
    const rows = await db.query<{ contractor_id: string }>(
      `SELECT contractor_id FROM folders WHERE id = '${ID.folder}'`,
    );
    expect(rows[0]?.contractor_id).toBe(OTHER_ORG);

    // Возврат: соседние наборы этого файла читают ту же фикстуру.
    await move(ID.contractor);
  });
});
