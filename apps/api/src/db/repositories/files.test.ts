/**
 * Запись вердикта задачей `file.verify` — на настоящей PostgreSQL под миграциями.
 *
 * ## Что здесь проверяется по существу
 *
 * Файл, принятый загрузкой, УЖЕ имеет страницы: синхронный приём пишет геометрию
 * той же функцией приведения вердикта, что и задача. Значит нормальный вход
 * задачи — это «страницы на месте», и её работа сводится к записи состояния.
 *
 * Прежде именно этот — единственный боевой — случай и падал. Счётчик страниц
 * считался коррелированным подзапросом в выборке без джойнов, Drizzle рендерил
 * подставленные колонки без имени таблицы, условие связывалось с внутренней
 * областью подзапроса и давало вечный ноль. Задача каждый раз пыталась записать
 * геометрию заново, ловила `source_pages_file_index_uq`, откатывала транзакцию
 * целиком — вместе с вердиктом, ради которого она и существует, — и повторялась
 * до исчерпания попыток. В консоли это выглядело как «дубликат ключа», в
 * интерфейсе — как красная плашка на ревизии, хотя файл был принят.
 *
 * Интеграционная проверка конвейера этого не ловила: её фикстура сеет файлы БЕЗ
 * страниц, то есть ровно тот путь, на котором дефекта нет.
 *
 * Класс дефекта (а не только этот его случай) держит
 * `db/correlated-subqueries.test.ts`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import type { SignatureProbe } from '@id/contracts';

import type { AuthScope } from '../../auth/scope.js';
import {
  listSourceFiles,
  replaceSourceFile,
  saveFileVerdict,
  type SourceFileView,
} from './files.js';
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
const ORG_CONTRACTOR = id(2);
const USER = id(3);
const FOLDER = id(5);

/** Файл в состоянии «после загрузки»: страницы записаны синхронным приёмом. */
const FILE_UPLOADED = id(10);
/** Файл без страниц: задача обязана записать геометрию сама. */
const FILE_BARE = id(11);

const PAGE_UPLOADED_0 = id(20);
const PAGE_UPLOADED_1 = id(21);

const SHA_UPLOADED = 'a'.repeat(64);
const SHA_BARE = 'b'.repeat(64);

const ADMIN: AuthScope = { kind: 'admin', userId: USER };

const PROBE: SignatureProbe = {
  result: 'none_detected',
  hasByteRange: false,
  subFilters: [],
  signatureFieldCount: 0,
  probedAt: '2026-08-24T14:54:33.000Z',
  probeError: null,
};

/** Геометрия из вердикта: ровно то, что уже лежит в БД у `FILE_UPLOADED`. */
const PAGES = [
  { widthPx: 595, heightPx: 842, rotation: 0, nativeDpi: 200 },
  { widthPx: 842, heightPx: 595, rotation: 90, nativeDpi: null },
] as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'OBJ1', 'Объект', 'ЖК «Объект», корпус 1')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER}', 'kc-files-repo', 'Тестовый пользователь')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
     VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_contractors (object_id, contractor_id)
     VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-08-01', 'Комплект', '${USER}')`,

  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_UPLOADED}', 'blobs/${SHA_UPLOADED}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA_BARE}', 'blobs/${SHA_BARE}', 1024, 'application/pdf')`,

  // Состояние `pending` — то, в котором файл ждёт задачу: приём записал его
  // синхронно, но вердикт по объекту хранилища ещё не вынесен.
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_UPLOADED}', '${FOLDER}', '${SHA_UPLOADED}', 'akt.pdf', 0, 'pending')`,
  `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_BARE}', '${FOLDER}', '${SHA_BARE}', 'sertifikat.pdf', 1, 'pending')`,

  `INSERT INTO source_pages
       (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_UPLOADED_0}', '${FOLDER}', '${FILE_UPLOADED}', 0, 0, 595, 842, 0)`,
  `INSERT INTO source_pages
       (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_UPLOADED_1}', '${FOLDER}', '${FILE_UPLOADED}', 1, 1, 842, 595, 90)`,
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

async function pagesOf(fileId: string): Promise<{ index: number; ordinal: number }[]> {
  const rows = await testDb.query<{
    file_page_index: number | string;
    folder_ordinal: number | string;
  }>(
    `SELECT file_page_index, folder_ordinal FROM source_pages
      WHERE source_file_id = '${fileId}' ORDER BY file_page_index`,
  );
  return rows.map((row) => ({
    index: Number(row.file_page_index),
    ordinal: Number(row.folder_ordinal),
  }));
}

async function stateOf(fileId: string): Promise<string> {
  const rows = await testDb.query<{ verify_state: string }>(
    `SELECT verify_state FROM source_files WHERE id = '${fileId}'`,
  );
  return rows[0]?.verify_state ?? '(нет строки)';
}

describe('saveFileVerdict у файла, страницы которого уже записаны приёмом', () => {
  it('записывает вердикт, а не падает на дубликате ключа страниц', async () => {
    const outcome = await saveFileVerdict(db, ADMIN, {
      fileId: FILE_UPLOADED,
      folderId: FOLDER,
      verifyState: 'ok',
      verifyError: null,
      signatureProbe: PROBE,
      // Вердикт несёт ту же геометрию, что уже лежит в БД: именно это
      // совпадение и подрывало прежний счётчик.
      pages: PAGES,
    });

    expect(outcome).toEqual({ kind: 'written', changed: true });
    expect(await stateOf(FILE_UPLOADED)).toBe('ok');
  });

  it('оставляет страницы нетронутыми: ни второго набора, ни сдвига нумерации', async () => {
    expect(await pagesOf(FILE_UPLOADED)).toEqual([
      { index: 0, ordinal: 0 },
      { index: 1, ordinal: 1 },
    ]);
  });

  it('повтор задачи ничего не ломает и не меняет', async () => {
    const outcome = await saveFileVerdict(db, ADMIN, {
      fileId: FILE_UPLOADED,
      folderId: FOLDER,
      verifyState: 'ok',
      verifyError: null,
      signatureProbe: PROBE,
      pages: PAGES,
    });

    // `changed: false` — состояние уже совпадало, события ревизии не будет.
    expect(outcome).toEqual({ kind: 'written', changed: false });
    expect(await pagesOf(FILE_UPLOADED)).toHaveLength(2);
  });
});

describe('saveFileVerdict у файла без страниц', () => {
  it('записывает геометрию сам и встраивает её в нумерацию ревизии', async () => {
    const outcome = await saveFileVerdict(db, ADMIN, {
      fileId: FILE_BARE,
      folderId: FOLDER,
      verifyState: 'ok',
      verifyError: null,
      signatureProbe: PROBE,
      pages: PAGES,
    });

    expect(outcome).toEqual({ kind: 'written', changed: true });
    expect(await pagesOf(FILE_BARE)).toEqual([
      { index: 0, ordinal: 2 },
      { index: 1, ordinal: 3 },
    ]);
    // Порядок страниц ревизии — по (порядку файлов, номеру страницы в файле):
    // страницы второго файла встают ЗА страницами первого, а не перед ними.
    expect(await pagesOf(FILE_UPLOADED)).toEqual([
      { index: 0, ordinal: 0 },
      { index: 1, ordinal: 1 },
    ]);
  });

  it('счётчик страниц файла виден чтением состава', async () => {
    const files = await listSourceFiles(db, ADMIN, FOLDER);
    expect(files.map((file) => [file.fileName, file.pageCount])).toEqual([
      ['akt.pdf', 2],
      ['sertifikat.pdf', 2],
    ]);
  });
});

// =====================================================================
// Замена файла (S27)
// =====================================================================

/**
 * Замена — ОДНА транзакция, и это её главное свойство.
 *
 * Клиентская последовательность «удалить → загрузить → переставить» непригодна
 * по построению: первый её шаг сносит файл вместе со всем производным по
 * ревизии, и любой отказ дальше оставляет комплект вообще без файла. Поменять
 * шаги местами нельзя — приём файла отвергается, пока собран рабочий документ.
 *
 * Здесь проверяется не «функция отработала», а последствия: позиция файла,
 * снятые подтверждения, снесённое производное и один аудит вместо двух.
 */
describe('replaceSourceFile', () => {
  const SHA_NEW = 'c'.repeat(64);
  const ACTOR = { emailHmac: null, ip: null, requestId: null };

  /** Тесты идут по одной базе подряд, поэтому заменяемый файл называется явно. */
  async function replaceOne(fileId: string, fileName: string): Promise<SourceFileView> {
    return replaceSourceFile(
      db,
      ADMIN,
      {
        folderId: FOLDER,
        replacedFileId: fileId,
        fileName,
        sha256: SHA_NEW,
        sizeBytes: 4096,
        mime: 'application/pdf',
        storageKey: `blobs/${SHA_NEW}`,
        verifyState: 'ok',
        verifyError: null,
        signatureProbe: PROBE,
        pages: [{ widthPx: 595, heightPx: 842, rotation: 0, nativeDpi: null }],
      },
      ACTOR,
    );
  }

  it('новый файл встаёт на место старого, а не в конец списка', async () => {
    // Иначе он молча перенумеровал бы страницы всего комплекта — а вместе с
    // ними номера в списке ошибок, по которым человек ищет листы в папке.
    const stored = await replaceOne(FILE_UPLOADED, 'akt-ispravlennyj.pdf');
    expect(stored.fileName).toBe('akt-ispravlennyj.pdf');
    expect(stored.sortOrder).toBe(0);

    const files = await listSourceFiles(db, ADMIN, FOLDER);
    expect(files.map((file) => file.fileName)).toEqual(['akt-ispravlennyj.pdf', 'sertifikat.pdf']);

    // Страницы пересчитаны по всей ревизии: у нового файла одна страница,
    // и страницы второго файла сдвинулись за ней.
    expect(await pagesOf(stored.id)).toEqual([{ index: 0, ordinal: 0 }]);
    expect(await pagesOf(FILE_BARE)).toEqual([
      { index: 0, ordinal: 1 },
      { index: 1, ordinal: 2 },
    ]);
  });

  it('замена сносит разбор и пишет ОДИН аудит вместо «удалил» плюс «загрузил»', async () => {
    // Замена — одно намерение пользователя. Разложенная на два действия, она
    // в журнале читается как случайное совпадение по времени.
    await testDb.query(
      `INSERT INTO logical_documents (id, folder_id, object_id, contractor_id, ordinal,
                                      is_confirmed, confirmation_source, confirmed_by, confirmed_at)
         VALUES ('${id(90)}', '${FOLDER}', '${OBJECT}', '${ORG_CONTRACTOR}', 0,
                 true, 'human', '${USER}', now())`,
    );

    const stored = await replaceOne(FILE_BARE, 'sertifikat-novyj.pdf');

    const documents = await testDb.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM logical_documents WHERE folder_id = '${FOLDER}'`,
    );
    expect(Number(documents[0]?.n)).toBe(0);

    const audit = await testDb.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_log
        WHERE entity_id = '${stored.id}' ORDER BY at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe('source_file.replaced');
    // Число снятых подтверждений названо: молчать о стёртом решении человека
    // нельзя, даже когда стереть его правильно.
    expect(audit[0]?.payload.confirmationsReleased).toBe(1);
    expect(audit[0]?.payload.replacedFileName).toBe('sertifikat.pdf');
  });

  it('чужой файл не заменяется под видом своего', async () => {
    await expect(
      replaceSourceFile(
        db,
        ADMIN,
        {
          folderId: FOLDER,
          replacedFileId: id(777),
          fileName: 'chuzhoj.pdf',
          sha256: 'd'.repeat(64),
          sizeBytes: 1,
          mime: 'application/pdf',
          storageKey: `blobs/${'d'.repeat(64)}`,
          verifyState: 'ok',
          verifyError: null,
          signatureProbe: PROBE,
          pages: [],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
