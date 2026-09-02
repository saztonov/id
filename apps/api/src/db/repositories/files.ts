/**
 * Репозиторий приёма файлов (§3.3): `stored_blobs`, `source_files`, `source_pages`.
 *
 * ## Область видимости
 *
 * У `source_files` и `source_pages` собственных колонок `object_id` и
 * `contractor_id` нет — их несёт ревизия поставки, а составные FK (миграция
 * 0003) не дают файлу и странице оказаться в чужой ревизии. Поэтому целью
 * `withScope()` здесь всегда служат колонки `folders`, а
 * соединение с ней INNER и обязательное: выборка файлов без него вернула бы
 * файлы всех подрядчиков. Это относится ко ВСЕМ путям, включая выдачу байтов на
 * скачивание, — по §1.6 проверка принадлежности обязана быть и там.
 *
 * `stored_blobs` области видимости не имеет и иметь не может: строка адресуется
 * содержимым (sha256 — первичный ключ, `s3_key` — UNIQUE), одна и та же на все
 * ревизии, которые этот файл подали. Владельца у неё нет по построению, поэтому
 * доступ к байтам даёт не она, а строка `source_files`, привязанная к ревизии.
 * Ни одна функция ниже не отдаёт наружу ключ хранилища иначе как через
 * проверенный областью `source_files`.
 *
 * ## Порядок файлов и порядок страниц — один инвариант
 *
 * `source_files.sort_order` задаёт пользователь до начала разметки, а
 * `source_pages.folder_ordinal` — это позиция страницы в ревизии, то есть
 * ФУНКЦИЯ от порядка файлов. Значит любое изменение порядка файлов обязано
 * пересчитывать ординалы страниц, иначе «страница 7 ревизии» перестанет
 * означать то же, что видит пользователь. Пересчёт двухфазный (сдвиг в
 * свободный диапазон, затем присвоение), потому что `UNIQUE (folder_id,
 * folder_ordinal)` проверяется построчно и немедленно: прямая перестановка
 * упала бы на первой же паре.
 *
 * ## Что запрещено и кем
 *
 * Правку состава ревизии после submit держит триггер `deny_locked_folder_content`
 * (0008), и это правильное место — инвариант обязан жить в БД. Но отказ триггера
 * прилетает как 500 с текстом на языке PL/pgSQL, поэтому статус проверяется и
 * здесь: пользователь получает 409 с объяснением, а триггер остаётся последней
 * линией, а не единственной.
 */
import type { SignatureProbe } from '@id/contracts';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sourceFiles, sourcePages, storedBlobs, folders } from '@id/db';
import type { AuthScope } from '../../auth/scope.js';
import { driverField } from '../driver-errors.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendAudit, type AuditActor } from './audit.js';
import { appendFolderEvent } from './jobs.js';
import { purgeDerivedForFolder } from './purge.js';
import { conflict, notFound, unprocessable } from '../../lib/problem.js';

export type Database = NodePgDatabase;

/** Исполнитель: сама база либо транзакция. Аудит обязан идти той же транзакцией. */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/**
 * Цель области видимости — колонки ревизии, а не файла.
 *
 * Разбор в заголовке файла: у файла и страницы своих колонок области нет.
 */
const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/**
 * Свободный диапазон для двухфазной перестановки.
 *
 * Больше любого мыслимого числа файлов и страниц в ревизии, поэтому сдвинутые
 * значения гарантированно не пересекаются ни со старыми, ни с новыми.
 */
const REORDER_OFFSET = 1_000_000;

/** Только черновик принимает файлы: остальное закрыто триггером 0008. */

export interface FolderForFiles {
  readonly id: string;
  readonly objectId: string;
  readonly contractorId: string;
  /** Рабочий документ уже собран: состав папки больше не меняется (§3.3). */
  readonly hasBundle: boolean;
}

export interface SourceFileView {
  readonly id: string;
  readonly folderId: string;
  readonly fileName: string;
  readonly sortOrder: number;
  readonly verifyState: 'pending' | 'ok' | 'quarantined';
  readonly verifyError: string | null;
  readonly signatureProbe: SignatureProbe | null;
  readonly blobSha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly pageCount: number;
  readonly createdAt: string;
}

/** Всё, что нужно Range-эндпоинту, и ничего сверх того. */
export interface FileContentRef {
  readonly fileId: string;
  readonly folderId: string;
  readonly objectId: string;
  readonly fileName: string;
  readonly verifyState: 'pending' | 'ok' | 'quarantined';
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly sha256: string;
}

export interface PageGeometryInput {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: 0 | 90 | 180 | 270;
  /** Разрешение покрывающего растра; `null` — рендерить на полном разрешении. */
  readonly nativeDpi: number | null;
}

export interface RecordUploadInput {
  readonly folderId: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly storageKey: string;
  readonly verifyState: 'ok' | 'quarantined';
  readonly verifyError: string | null;
  readonly signatureProbe: SignatureProbe;
  readonly pages: readonly PageGeometryInput[];
}

/** Метка времени в ISO-8601 средствами БД: одно место приведения на все ответы. */
function isoTimestamp(column: (typeof sourceFiles)['createdAt']): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

const FILE_SELECTION = {
  id: sourceFiles.id,
  folderId: sourceFiles.folderId,
  fileName: sourceFiles.fileName,
  sortOrder: sourceFiles.sortOrder,
  verifyState: sourceFiles.verifyState,
  verifyError: sourceFiles.verifyError,
  signatureProbe: sourceFiles.signatureProbe,
  blobSha256: sourceFiles.blobSha256,
  sizeBytes: storedBlobs.sizeBytes,
  mime: storedBlobs.mime,
  // Внутренняя таблица под алиасом, внешняя — ТЕКСТОМ, по той же причине, что у
  // `hasBundle` ниже: подстановка `${sourceFiles.id}` рендерится без имени
  // таблицы, и в запросе без джойнов условие связалось бы с `p.id`. Здесь оно
  // работало только потому, что оба чтения делают по два `innerJoin`, — то есть
  // корректность зависела от вызывающего.
  pageCount: sql<number>`(select count(*)::int from ${sourcePages} p where p.source_file_id = source_files.id)`,
  createdAt: isoTimestamp(sourceFiles.createdAt),
};

// =====================================================================
// Чтение
// =====================================================================

/**
 * Ревизия, в которую разрешено смотреть этой области видимости.
 *
 * Возвращает `null` и на «нет такой ревизии», и на «ревизия чужая»: различать
 * эти случаи в ответе значило бы подтверждать существование чужой поставки по
 * прямому идентификатору.
 */
export async function findFolderForFiles(
  executor: Executor,
  scope: AuthScope,
  folderId: string,
): Promise<FolderForFiles | null> {
  const rows = await executor
    .select({
      id: folders.id,
      objectId: folders.objectId,
      contractorId: folders.contractorId,
      // Ссылка на внешнюю таблицу написана ТЕКСТОМ, а не через
      // `${folders.id}`. Причина проверена дампом SQL: в запросе
      // БЕЗ джойнов Drizzle рендерит колонку без имени таблицы, и коррелирующее
      // условие превращалось в `pb.folder_id = "id"`, где `"id"` связывался с
      // `pb.id` внутри подзапроса. Условие было ложным всегда, то есть
      // `hasBundle` был вечным `false`, и запрет «состав зафиксирован
      // разметкой» (`requireEditableFolder`) не срабатывал ни разу.
      hasBundle: sql<boolean>`exists (select 1 from processing_bundles pb where pb.folder_id = folders.id)`,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  return row;
}

export async function listSourceFiles(
  executor: Executor,
  scope: AuthScope,
  folderId: string,
): Promise<readonly SourceFileView[]> {
  const rows = await executor
    .select(FILE_SELECTION)
    .from(sourceFiles)
    .innerJoin(folders, eq(folders.id, sourceFiles.folderId))
    .innerJoin(storedBlobs, eq(storedBlobs.sha256, sourceFiles.blobSha256))
    .where(withScope(scope, FOLDER_SCOPE, eq(sourceFiles.folderId, folderId)))
    .orderBy(asc(sourceFiles.sortOrder));

  return rows.map(toFileView);
}

/**
 * Файл для выдачи байтов.
 *
 * Отдельная функция, а не «взять из списка»: у неё есть ключ хранилища, которого
 * в списке нет и быть не должно. Область видимости применяется тем же
 * `withScope()` — это тот самый путь, о котором предупреждает §1.6: выдача
 * содержимого обходит фильтрацию списка, если о ней забыть.
 */
export async function findFileContent(
  executor: Executor,
  scope: AuthScope,
  fileId: string,
): Promise<FileContentRef | null> {
  const rows = await executor
    .select({
      fileId: sourceFiles.id,
      folderId: sourceFiles.folderId,
      objectId: folders.objectId,
      fileName: sourceFiles.fileName,
      verifyState: sourceFiles.verifyState,
      storageKey: storedBlobs.s3Key,
      sizeBytes: storedBlobs.sizeBytes,
      mime: storedBlobs.mime,
      sha256: storedBlobs.sha256,
    })
    .from(sourceFiles)
    .innerJoin(folders, eq(folders.id, sourceFiles.folderId))
    .innerJoin(storedBlobs, eq(storedBlobs.sha256, sourceFiles.blobSha256))
    .where(withScope(scope, FOLDER_SCOPE, eq(sourceFiles.id, fileId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  return {
    ...row,
    sizeBytes: Number(row.sizeBytes),
    verifyState: row.verifyState as 'pending' | 'ok' | 'quarantined',
  };
}

// =====================================================================
// Запись
// =====================================================================

/**
 * Регистрация проверенного (или отвергнутого) файла.
 *
 * Блоб пишется `ON CONFLICT DO NOTHING`: дедупликация по sha256 — штатный
 * сценарий повторной подачи после возврата (§3.3), и второй раз те же байты в
 * хранилище не появляются. Ключ детерминирован от sha256, поэтому существующая
 * строка описывает тот же объект, что мы только что сохранили.
 *
 * Повтор `sort_order` — единственная гонка на этом пути: два `complete` в одной
 * ревизии читают одинаковый максимум. Уникальный ключ её ловит, и транзакция
 * повторяется целиком; молча брать «следующий свободный» нельзя, потому что
 * порядок файлов — это то, что задал пользователь.
 */
export async function recordUploadedFile(
  db: Database,
  scope: AuthScope,
  input: RecordUploadInput,
  actor: AuditActor,
): Promise<SourceFileView> {
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await insertUploadedFile(db, scope, input, actor);
    } catch (error) {
      if (attempt < attempts && isUniqueViolation(error, 'source_files_order_uq')) continue;
      throw error;
    }
  }
}

async function insertUploadedFile(
  db: Database,
  scope: AuthScope,
  input: RecordUploadInput,
  actor: AuditActor,
): Promise<SourceFileView> {
  return db.transaction(async (tx) => {
    const folder = await requireEditableFolder(tx, scope, input.folderId);

    const [orderRow] = await tx
      .select({ next: sql<number>`coalesce(max(${sourceFiles.sortOrder}) + 1, 0)` })
      .from(sourceFiles)
      .where(eq(sourceFiles.folderId, input.folderId));

    await tx
      .insert(storedBlobs)
      .values({
        sha256: input.sha256,
        s3Key: input.storageKey,
        sizeBytes: input.sizeBytes,
        mime: input.mime,
      })
      .onConflictDoNothing({ target: storedBlobs.sha256 });

    const [created] = await tx
      .insert(sourceFiles)
      .values({
        folderId: input.folderId,
        blobSha256: input.sha256,
        fileName: input.fileName,
        sortOrder: orderRow?.next ?? 0,
        verifyState: input.verifyState,
        verifyError: input.verifyError,
        signatureProbe: sql`${JSON.stringify(input.signatureProbe)}::jsonb`,
      })
      .returning({ id: sourceFiles.id });

    if (created === undefined) {
      throw conflict('Файл не удалось зарегистрировать. Повторите загрузку.');
    }

    if (input.pages.length > 0) {
      // Временный ординал берётся НАД существующими, а не с фиксированного
      // REORDER_OFFSET. Иначе он сталкивается с целью сдвига в renumberPages:
      // та поднимает все страницы ревизии ровно на REORDER_OFFSET, и старая
      // страница 0 попадает в занятое новой страницей значение — нарушение
      // уникальности внутри одного UPDATE.
      const [ordinalRow] = await tx
        .select({ next: sql<number>`coalesce(max(${sourcePages.folderOrdinal}) + 1, 0)` })
        .from(sourcePages)
        .where(eq(sourcePages.folderId, input.folderId));
      const firstOrdinal = Number(ordinalRow?.next ?? 0);

      await tx.insert(sourcePages).values(
        input.pages.map((page, index) => ({
          folderId: input.folderId,
          sourceFileId: created.id,
          filePageIndex: index,
          // Временное значение: ординалы всей ревизии пересчитываются ниже
          // одним проходом, потому что они зависят от порядка файлов.
          folderOrdinal: firstOrdinal + index,
          widthPx: page.widthPx,
          heightPx: page.heightPx,
          rotation: page.rotation,
          nativeDpi: page.nativeDpi,
          attentionFlags: [],
        })),
      );
      await renumberPages(tx, input.folderId);
    }

    await appendAudit(tx, scope, {
      ...actor,
      action: input.verifyState === 'ok' ? 'source_file.uploaded' : 'source_file.quarantined',
      entityType: 'source_file',
      entityId: created.id,
      objectId: folder.objectId,
      payload: {
        folderId: input.folderId,
        fileName: input.fileName,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        mime: input.mime,
        pages: input.pages.length,
        verifyState: input.verifyState,
        ...(input.verifyError === null ? {} : { verifyError: input.verifyError }),
      },
    });

    // Событие ревизии — той же транзакцией, что и сама запись (§3.8): событие,
    // которое может не записаться, оставит экран «Файлы» с устаревшим составом
    // до перезагрузки страницы, а карантин подрядчик увидит не сразу.
    await appendFolderEvent(tx, {
      folderId: input.folderId,
      eventType: input.verifyState === 'ok' ? 'file.uploaded' : 'file.quarantined',
      payload: {
        fileId: created.id,
        fileName: input.fileName,
        pageCount: input.pages.length,
        ...(input.verifyError === null ? {} : { verifyError: input.verifyError }),
      },
    });

    const [view] = await selectFiles(tx, scope, eq(sourceFiles.id, created.id));
    if (view === undefined) {
      throw conflict('Файл зарегистрирован, но недоступен для чтения.');
    }
    return view;
  });
}

export interface SaveVerdictInput {
  readonly fileId: string;
  readonly folderId: string;
  readonly verifyState: 'ok' | 'quarantined';
  readonly verifyError: string | null;
  readonly signatureProbe: SignatureProbe;
  /** Геометрия страниц; пишется только если у файла их ещё нет. */
  readonly pages: readonly PageGeometryInput[];
}

export type SaveVerdictOutcome =
  /** Состояние записано (или уже совпадало). */
  | { readonly kind: 'written'; readonly changed: boolean }
  /** Ревизия неизменяема или не видна: писать нельзя, остаётся сверка. */
  | { readonly kind: 'locked'; readonly reason: string };

/**
 * Запись вердикта проверки задачей `file.verify` (§12, задача 1).
 *
 * Синхронный путь загрузки пишет то же самое, и это не дублирование: там
 * проверяется ПОТОК от клиента, здесь — объект, который в итоге лежит в
 * хранилище. Задача обязана уметь именно писать, иначе файл со значением
 * колонки по умолчанию (`pending`) не имеет способа получить состояние вовсе, а
 * стадия «uploaded» не наблюдаема.
 *
 * Писать разрешено только в черновик. Поданная ревизия неизменяема (§3.9), и
 * триггер БД отверг бы UPDATE отказом задачи; поэтому вместо отказа
 * возвращается `locked`, и обработчик переходит в режим сверки — расхождение
 * содержимого с записанным состоянием на поданной ревизии как раз и обязано
 * останавливать конвейер, а не молча переписывать вердикт.
 *
 * Страницы пишутся только при их отсутствии: перезапись геометрии сдвинула бы
 * `folder_ordinal` всей ревизии и порвала бы уже собранную карту рабочего
 * документа. Расхождение числа страниц с записанным — это отдельный случай,
 * который ловит сверка sha256 внутри самого вердикта.
 */
export async function saveFileVerdict(
  db: Database,
  scope: AuthScope,
  input: SaveVerdictInput,
): Promise<SaveVerdictOutcome> {
  return db.transaction(async (tx) => {
    const folder = await findFolderForFiles(tx, scope, input.folderId);
    if (folder === null) {
      return { kind: 'locked', reason: 'папка не найдена или недоступна области видимости' };
    }

    const [current] = await tx
      .select({
        id: sourceFiles.id,
        verifyState: sourceFiles.verifyState,
      })
      .from(sourceFiles)
      .where(and(eq(sourceFiles.id, input.fileId), eq(sourceFiles.folderId, input.folderId)))
      .limit(1);

    if (current === undefined) {
      return { kind: 'locked', reason: 'файла нет в этой ревизии' };
    }

    // Страницы считаются ОТДЕЛЬНЫМ запросом, а не коррелированным подзапросом в
    // выборке выше, и это исправление дефекта, а не стилистика. Выборка файла
    // джойнов не имеет, а в таком запросе Drizzle рендерит подставленную колонку
    // без имени таблицы: условие `${sourcePages.sourceFileId} = ${sourceFiles.id}`
    // превращалось в `source_file_id = "id"`, где обе стороны связывались с
    // `source_pages`. Счётчик был вечным нулём, поэтому задача КАЖДЫЙ раз
    // пыталась записать геометрию, уже записанную приёмом файла, и умирала на
    // `source_pages_file_index_uq` — вместе с ней откатывался и вердикт, ради
    // которого задача существует. Тот же механизм однажды обнулил `hasBundle`
    // (см. `findFolderForFiles`).
    const [pageRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(sourcePages)
      .where(eq(sourcePages.sourceFileId, input.fileId));
    const pageCount = Number(pageRow?.count ?? 0);

    const changed = current.verifyState !== input.verifyState;

    await tx
      .update(sourceFiles)
      .set({
        verifyState: input.verifyState,
        verifyError: input.verifyError,
        signatureProbe: sql`${JSON.stringify(input.signatureProbe)}::jsonb`,
      })
      .where(eq(sourceFiles.id, input.fileId));

    if (pageCount === 0 && input.pages.length > 0) {
      const [ordinalRow] = await tx
        .select({ next: sql<number>`coalesce(max(${sourcePages.folderOrdinal}) + 1, 0)` })
        .from(sourcePages)
        .where(eq(sourcePages.folderId, input.folderId));
      const firstOrdinal = Number(ordinalRow?.next ?? 0);

      // `onConflictDoNothing` БЕЗ цели: конкурент, успевший записать те же
      // страницы между счётом и вставкой, нарушил бы и
      // `source_pages_file_index_uq`, и `source_pages_folder_ordinal_uq` —
      // цель по одному ключу оставила бы второй отказом. Проверка-и-потом-
      // запись разными операторами гонку не закрывает в принципе, а «писать,
      // только если страниц нет» — ровно то, что выражает сама операция.
      const inserted = await tx
        .insert(sourcePages)
        .values(
          input.pages.map((page, index) => ({
            folderId: input.folderId,
            sourceFileId: input.fileId,
            filePageIndex: index,
            folderOrdinal: firstOrdinal + index,
            widthPx: page.widthPx,
            heightPx: page.heightPx,
            rotation: page.rotation,
            nativeDpi: page.nativeDpi,
            attentionFlags: [],
          })),
        )
        .onConflictDoNothing()
        .returning({ id: sourcePages.id });

      // Пересчёт ординалов — только если строки появились: проигравший гонку
      // иначе переставлял бы нумерацию всей ревизии впустую.
      if (inserted.length > 0) await renumberPages(tx, input.folderId);
    }

    if (changed) {
      await appendFolderEvent(tx, {
        folderId: input.folderId,
        eventType: input.verifyState === 'ok' ? 'file.verified' : 'file.quarantined',
        payload: {
          fileId: input.fileId,
          previousState: current.verifyState,
          ...(input.verifyError === null ? {} : { verifyError: input.verifyError }),
        },
      });
    }

    return { kind: 'written', changed };
  });
}

/**
 * Запись зонда подписи задачей `file.signature_probe` (§12, задача 2).
 *
 * Отдельно от вердикта, потому что последствия разные: зонд ничего не решает,
 * он собирает свидетельство. Неизменяемая ревизия здесь не отказ, а `locked` без
 * записи — свидетельство о подписи не является условием обработки.
 */
export async function saveSignatureProbe(
  db: Database,
  scope: AuthScope,
  input: {
    readonly fileId: string;
    readonly folderId: string;
    readonly probe: SignatureProbe;
  },
): Promise<SaveVerdictOutcome> {
  return db.transaction(async (tx) => {
    const folder = await findFolderForFiles(tx, scope, input.folderId);
    if (folder === null) {
      return { kind: 'locked', reason: 'папка не найдена или недоступна области видимости' };
    }

    const updated = await tx
      .update(sourceFiles)
      .set({ signatureProbe: sql`${JSON.stringify(input.probe)}::jsonb` })
      .where(and(eq(sourceFiles.id, input.fileId), eq(sourceFiles.folderId, input.folderId)))
      .returning({ id: sourceFiles.id });

    if (updated.length === 0) return { kind: 'locked', reason: 'файла нет в этой ревизии' };
    return { kind: 'written', changed: true };
  });
}

/**
 * Перестановка файлов ревизии.
 *
 * Список обязан быть полной перестановкой: частичный порядок оставил бы часть
 * файлов на прежних местах, и результат зависел бы от того, что лежало в базе, а
 * не от того, что выбрал пользователь. Пропуск или дубль — отказ 422, а не
 * «упорядочим как получится».
 */
export async function reorderSourceFiles(
  db: Database,
  scope: AuthScope,
  folderId: string,
  fileIds: readonly string[],
  actor: AuditActor,
): Promise<readonly SourceFileView[]> {
  return db.transaction(async (tx) => {
    const folder = await requireEditableFolder(tx, scope, folderId);

    const current = await tx
      .select({ id: sourceFiles.id })
      .from(sourceFiles)
      .where(eq(sourceFiles.folderId, folderId));

    const existing = new Set(current.map((row) => row.id));
    const requested = new Set(fileIds);
    if (
      requested.size !== fileIds.length ||
      existing.size !== requested.size ||
      [...requested].some((id) => !existing.has(id))
    ) {
      throw unprocessable(
        [
          {
            pointer: '/fileIds',
            code: 'not_a_permutation',
            message: 'Ожидается полный список файлов ревизии без повторов',
          },
        ],
        'Порядок задаётся полным списком файлов ревизии.',
      );
    }

    // Двухфазно: UNIQUE (folder_id, sort_order) проверяется немедленно, и
    // прямая перестановка упала бы на первой же паре.
    await tx.execute(
      sql`update ${sourceFiles} set sort_order = sort_order + ${REORDER_OFFSET} where folder_id = ${folderId}`,
    );
    for (const [index, fileId] of fileIds.entries()) {
      await tx
        .update(sourceFiles)
        .set({ sortOrder: index })
        .where(and(eq(sourceFiles.id, fileId), eq(sourceFiles.folderId, folderId)));
    }
    await renumberPages(tx, folderId);

    await appendAudit(tx, scope, {
      ...actor,
      action: 'source_file.reordered',
      entityType: 'submission_folder',
      entityId: folderId,
      objectId: folder.objectId,
      payload: { order: [...fileIds] },
    });
    await appendFolderEvent(tx, {
      folderId,
      eventType: 'file.order_changed',
      payload: { order: [...fileIds] },
    });

    return selectFiles(tx, scope, eq(sourceFiles.folderId, folderId));
  });
}

/**
 * Удаление файла из черновика.
 *
 * Нужно ровно из-за карантина: отвергнутый файл виден подрядчику, и следующий
 * его ход — заменить файл, а не остаться с ревизией, которую невозможно
 * собрать. Байты при этом НЕ удаляются: тот же блоб может быть нужен другой
 * ревизии, поэтому чистка хранилища — дело `storage.gc` (§12), который считает
 * ссылки, а не удаляет по факту одной удалённой строки.
 */
export interface DeleteSourceFileOptions {
  /** Действует ли §3.9; см. `EditableFolderOptions`. */
  readonly enforceImmutability?: boolean;
}

export async function deleteSourceFile(
  db: Database,
  scope: AuthScope,
  folderId: string,
  fileId: string,
  actor: AuditActor,
  options: DeleteSourceFileOptions = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Собранный рабочий документ больше не запрещает удаление, и это исправление
    // дефекта, а не послабление. Прежний отказ звучал как «состав и порядок
    // файлов зафиксированы разметкой», то есть ссылался на неизменяемость,
    // которой в черновике нет: рабочий документ черновика пересобирается в
    // любой момент. Настоящая причина запрета была технической — на страницах
    // файла висит разметка, и внешний ключ не даёт их удалить. Теперь эта
    // разметка сносится явно, а пользователь предупреждён о том, что теряет.
    const folder = await requireEditableFolder(tx, scope, folderId, {
      ...(options.enforceImmutability === undefined
        ? {}
        : { enforceImmutability: options.enforceImmutability }),
      allowBuiltBundle: true,
    });

    const [target] = await tx
      .select({ id: sourceFiles.id, fileName: sourceFiles.fileName })
      .from(sourceFiles)
      .where(and(eq(sourceFiles.id, fileId), eq(sourceFiles.folderId, folderId)))
      .limit(1);
    if (target === undefined) return false;

    // Производное сносится целиком по ВСЕЙ ревизии, а не по одному файлу, и это
    // не грубость. Рабочий документ — склейка всех файлов, разметка ложится на
    // его страницы, распознавание идёт по разметке: удаление одного файла
    // сдвигает нумерацию страниц у всех остальных и обесценивает цепочку целиком.
    // Выборочная чистка оставила бы разметку, указывающую на страницы с другими
    // номерами, — то есть данные, которые выглядят целыми и врут.
    const released = await releaseHumanConfirmations(tx, folderId);
    await purgeDerivedForFolder(tx, folderId);

    // Страницы раньше файла: FK не каскадный намеренно, чтобы удаление
    // страницы никогда не происходило как побочный эффект.
    await tx.delete(sourcePages).where(eq(sourcePages.sourceFileId, fileId));
    await tx.delete(sourceFiles).where(eq(sourceFiles.id, fileId));

    await compactFileOrder(tx, folderId);
    await renumberPages(tx, folderId);

    await appendAudit(tx, scope, {
      ...actor,
      action: 'source_file.deleted',
      entityType: 'source_file',
      entityId: fileId,
      objectId: folder.objectId,
      payload: {
        folderId,
        fileName: target.fileName,
        derivedPurged: true,
        confirmationsReleased: released,
      },
    });
    await appendFolderEvent(tx, {
      folderId,
      eventType: 'file.deleted',
      payload: { fileId, fileName: target.fileName, confirmationsReleased: released },
    });

    return true;
  });
}

// =====================================================================
// Замена файла
// =====================================================================

export interface ReplaceSourceFileInput extends RecordUploadInput {
  /** Файл, который занимает место в ревизии и уступает его новому. */
  readonly replacedFileId: string;
}

/**
 * Замена файла ревизии — ОДНА транзакция, а не последовательность вызовов.
 *
 * ## Почему это нельзя было сделать на клиенте
 *
 * Напрашивающаяся последовательность «удалить → загрузить → переставить»
 * непригодна: первый же её шаг сносит файл вместе со всем производным по
 * ревизии, и любой отказ дальше — сорвавшийся PUT, битый PDF, карантин —
 * оставляет комплект вообще без файла. Переставить шаги местами тоже нельзя:
 * `requireEditableFolder` в приёме файла отвергает загрузку, пока собран
 * рабочий документ, то есть всегда после кнопки «Выделить блоки».
 *
 * Поэтому байты проверяются ДО транзакции (маршрут), а всё, что меняет базу,
 * происходит здесь и целиком: либо новый файл встал на место старого, либо не
 * изменилось ничего.
 *
 * ## Почему подтверждения снимаются молча
 *
 * Замена означает согласие потерять весь разбор — интерфейс перечисляет это
 * до нажатия. Подтверждённый человеком документ иначе отверг бы `purge`
 * триггером `logical_documents_confirmed_lock`, и пользователь получил бы
 * отказ, снять который в портале нечем. Число снятых уходит в аудит: молчать о
 * том, что стёрли решение человека, нельзя, даже когда стереть его правильно.
 *
 * ## Порядок сохраняется без перестановки
 *
 * Новый файл встаёт на `sort_order` старого, освобождённый в этой же
 * транзакции. Отдельный `reorder` не нужен, `compactFileOrder` — тоже:
 * количество файлов не изменилось, дырок в нумерации не возникает.
 */
export async function replaceSourceFile(
  db: Database,
  scope: AuthScope,
  input: ReplaceSourceFileInput,
  actor: AuditActor,
  options: DeleteSourceFileOptions = {},
): Promise<SourceFileView> {
  return db.transaction(async (tx) => {
    const folder = await requireEditableFolder(tx, scope, input.folderId, {
      ...(options.enforceImmutability === undefined
        ? {}
        : { enforceImmutability: options.enforceImmutability }),
      allowBuiltBundle: true,
    });

    const [target] = await tx
      .select({
        id: sourceFiles.id,
        fileName: sourceFiles.fileName,
        sortOrder: sourceFiles.sortOrder,
        sha256: sourceFiles.blobSha256,
      })
      .from(sourceFiles)
      .where(
        and(eq(sourceFiles.id, input.replacedFileId), eq(sourceFiles.folderId, input.folderId)),
      )
      .limit(1);
    if (target === undefined) throw notFound('Заменяемый файл не найден в этой ревизии.');

    const released = await releaseHumanConfirmations(tx, input.folderId);
    await purgeDerivedForFolder(tx, input.folderId);

    await tx.delete(sourcePages).where(eq(sourcePages.sourceFileId, target.id));
    await tx.delete(sourceFiles).where(eq(sourceFiles.id, target.id));

    await tx
      .insert(storedBlobs)
      .values({
        sha256: input.sha256,
        s3Key: input.storageKey,
        sizeBytes: input.sizeBytes,
        mime: input.mime,
      })
      .onConflictDoNothing({ target: storedBlobs.sha256 });

    const [created] = await tx
      .insert(sourceFiles)
      .values({
        folderId: input.folderId,
        blobSha256: input.sha256,
        fileName: input.fileName,
        // Место старого файла свободно в этой же транзакции, поэтому
        // `source_files_order_uq` не нарушается и перестановка не нужна.
        sortOrder: target.sortOrder,
        verifyState: input.verifyState,
        verifyError: input.verifyError,
        signatureProbe: sql`${JSON.stringify(input.signatureProbe)}::jsonb`,
      })
      .returning({ id: sourceFiles.id });

    if (created === undefined) {
      throw conflict('Файл не удалось зарегистрировать. Повторите загрузку.');
    }

    if (input.pages.length > 0) {
      // Тот же приём, что в приёме файла: временный ординал берётся НАД
      // существующими, иначе сдвиг в `renumberPages` столкнётся с занятыми
      // значениями внутри одного UPDATE.
      const [ordinalRow] = await tx
        .select({ next: sql<number>`coalesce(max(${sourcePages.folderOrdinal}) + 1, 0)` })
        .from(sourcePages)
        .where(eq(sourcePages.folderId, input.folderId));
      const firstOrdinal = Number(ordinalRow?.next ?? 0);

      await tx.insert(sourcePages).values(
        input.pages.map((page, index) => ({
          folderId: input.folderId,
          sourceFileId: created.id,
          filePageIndex: index,
          folderOrdinal: firstOrdinal + index,
          widthPx: page.widthPx,
          heightPx: page.heightPx,
          rotation: page.rotation,
          nativeDpi: page.nativeDpi,
          attentionFlags: [],
        })),
      );
    }
    await renumberPages(tx, input.folderId);

    // ОДНА запись аудита на всю операцию, а не «удалил» плюс «загрузил»: замена
    // — одно намерение пользователя, и разложенная на два действия она в
    // журнале читается как случайное совпадение по времени.
    await appendAudit(tx, scope, {
      ...actor,
      action: 'source_file.replaced',
      entityType: 'source_file',
      entityId: created.id,
      objectId: folder.objectId,
      payload: {
        folderId: input.folderId,
        replacedFileId: target.id,
        replacedFileName: target.fileName,
        replacedSha256: target.sha256,
        fileName: input.fileName,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        pages: input.pages.length,
        derivedPurged: true,
        confirmationsReleased: released,
      },
    });

    await appendFolderEvent(tx, {
      folderId: input.folderId,
      eventType: 'file.replaced',
      payload: {
        fileId: created.id,
        fileName: input.fileName,
        replacedFileId: target.id,
        replacedFileName: target.fileName,
        pageCount: input.pages.length,
        confirmationsReleased: released,
      },
    });

    const [view] = await selectFiles(tx, scope, eq(sourceFiles.id, created.id));
    if (view === undefined) {
      throw conflict('Файл зарегистрирован, но недоступен для чтения.');
    }
    return view;
  });
}

// =====================================================================
// Внутреннее
// =====================================================================

/**
 * Снять подтверждения границ, поставленные человеком, вместе с нарезкой.
 *
 * Нужно перед `purgeDerivedForFolder`: удаление подтверждённого человеком
 * документа отвергает триггер `logical_documents_confirmed_lock`, и без этого
 * шага удаление или замена файла падали бы отказом, снять который в портале
 * нечем — раздела «Документы» больше нет.
 *
 * Машинные подтверждения не трогаются: их триггер и так пропускает, а лишний
 * `UPDATE` по всем документам ревизии перед их же удалением — работа впустую.
 *
 * Блок `derived_pdf_*` обнуляется целиком, потому что этого требуют
 * `logical_documents_derived_confirmed_chk` (нарезка только у подтверждённого)
 * и `logical_documents_derived_provenance_chk` (провенанс полон или пуст
 * целиком). Смысл ограничений тот же: границы снова под вопросом, а прежний
 * файл описывает уже не тот документ.
 *
 * Возвращает число снятых — оно уходит в аудит: молчать о стёртом решении
 * человека нельзя, даже когда стереть его правильно.
 */
async function releaseHumanConfirmations(executor: Executor, folderId: string): Promise<number> {
  const released = await executor.execute<{ id: string }>(
    sql`update logical_documents
           set is_confirmed = false,
               confirmed_by = null,
               confirmed_at = null,
               derived_pdf_blob_sha256 = null,
               derived_pdf_page_count = null,
               derived_pdf_bytes = null,
               derived_pdf_built_at = null,
               derived_pdf_toolkit = null,
               derived_note_applied = null,
               updated_at = now()
         where folder_id = ${folderId}::uuid
           and is_confirmed
           and confirmation_source = 'human'
       returning id`,
  );
  return released.rows.length;
}

async function selectFiles(
  executor: Executor,
  scope: AuthScope,
  condition: SQL,
): Promise<SourceFileView[]> {
  const rows = await executor
    .select(FILE_SELECTION)
    .from(sourceFiles)
    .innerJoin(folders, eq(folders.id, sourceFiles.folderId))
    .innerJoin(storedBlobs, eq(storedBlobs.sha256, sourceFiles.blobSha256))
    .where(withScope(scope, FOLDER_SCOPE, condition))
    .orderBy(asc(sourceFiles.sortOrder));
  return rows.map(toFileView);
}

function toFileView(row: {
  id: string;
  folderId: string;
  fileName: string;
  sortOrder: number;
  verifyState: string;
  verifyError: string | null;
  signatureProbe: unknown;
  blobSha256: string;
  sizeBytes: number | string;
  mime: string;
  pageCount: number | string;
  createdAt: string;
}): SourceFileView {
  return {
    id: row.id,
    folderId: row.folderId,
    fileName: row.fileName,
    sortOrder: row.sortOrder,
    verifyState: row.verifyState as 'pending' | 'ok' | 'quarantined',
    verifyError: row.verifyError,
    signatureProbe: (row.signatureProbe ?? null) as SignatureProbe | null,
    blobSha256: row.blobSha256,
    // bigint приходит из драйвера строкой: без приведения `sizeBytes` уехал бы
    // в ответ строкой и не прошёл бы схему ответа.
    sizeBytes: Number(row.sizeBytes),
    mime: row.mime,
    pageCount: Number(row.pageCount),
    createdAt: row.createdAt,
  };
}

/**
 * Ревизия, в которую разрешено писать.
 *
 * Три отказа с разным смыслом и разными статусами: нет доступа (404), состав уже
 * подан (409), рабочий документ собран (409). Сливать их в один — значит
 * заставлять подрядчика гадать, что именно не так.
 */
export interface EditableFolderOptions {
  /**
   * Действует ли §3.9 (`core.enforce_immutability`).
   *
   * `false` — режим тестирования: оба запрета ниже пропускаются. Значение
   * приходит СНАРУЖИ, а не читается здесь: функция вызывается внутри транзакции
   * и по нескольку раз за операцию, а настройка одна на запрос — читать её на
   * каждый вызов значило бы платить лишним запросом за неменяющийся ответ.
   */
  readonly enforceImmutability?: boolean;
  /**
   * Разрешить правку состава при собранном рабочем документе.
   *
   * Отдельно от режима тестирования, потому что это ДРУГОЙ случай. Сборка не
   * доказательство: рабочий документ черновика пересобирается в любой момент, и
   * запрет здесь стоял не ради неизменяемости, а ради того, чтобы разметка не
   * осталась висеть на удалённых страницах. Вызывающий, который эту разметку
   * сносит сам (`purgeDerivedForFolder`), берёт ответственность на себя.
   */
  readonly allowBuiltBundle?: boolean;
}

export async function requireEditableFolder(
  executor: Executor,
  scope: AuthScope,
  folderId: string,
  options: EditableFolderOptions = {},
): Promise<FolderForFiles> {
  const folder = await findFolderForFiles(executor, scope, folderId);
  if (folder === null) throw notFound('Папка не найдена.');

  if (folder.hasBundle && options.allowBuiltBundle !== true) {
    throw conflict(
      'Рабочий документ папки уже собран: состав и порядок файлов зафиксированы разметкой.',
    );
  }
  return folder;
}

/**
 * Пересчёт позиций страниц по текущему порядку файлов.
 *
 * `folder_ordinal` — это позиция страницы в ревизии, а не в файле, поэтому
 * порядок задаётся парой «порядок файла, индекс страницы в файле».
 */
async function renumberPages(executor: Executor, folderId: string): Promise<void> {
  await executor.execute(
    sql`update source_pages set folder_ordinal = folder_ordinal + ${REORDER_OFFSET}
         where folder_id = ${folderId}`,
  );
  await executor.execute(
    sql`update source_pages as p
           set folder_ordinal = ordered.position - 1
          from (select sp.id,
                       row_number() over (order by sf.sort_order, sp.file_page_index) as position
                  from source_pages sp
                  join source_files sf on sf.id = sp.source_file_id
                 where sp.folder_id = ${folderId}) as ordered
         where p.id = ordered.id`,
  );
}

/** Сжатие порядка файлов после удаления: позиции остаются плотными. */
async function compactFileOrder(executor: Executor, folderId: string): Promise<void> {
  await executor.execute(
    sql`update source_files set sort_order = sort_order + ${REORDER_OFFSET}
         where folder_id = ${folderId}`,
  );
  await executor.execute(
    sql`update source_files as f
           set sort_order = ordered.position - 1
          from (select id, row_number() over (order by sort_order) as position
                  from source_files
                 where folder_id = ${folderId}) as ordered
         where f.id = ordered.id`,
  );
}

/**
 * Гонка за `sort_order`, а не любой отказ БД.
 *
 * Поля читаются через `driverField`, то есть сквозь цепочку `cause`: Drizzle 0.45
 * оборачивает отказ драйвера в `DrizzleQueryError` и прячет `code`/`constraint`
 * внутрь. Прежняя проверка смотрела только верхний уровень и потому возвращала
 * `false` ВСЕГДА — повтор выше по коду не срабатывал ни разу, и конкурентная
 * загрузка двух файлов в одну ревизию отдавала пользователю 500 вместо тихой
 * повторной попытки.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  return driverField(error, 'code') === '23505' && driverField(error, 'constraint') === constraint;
}
