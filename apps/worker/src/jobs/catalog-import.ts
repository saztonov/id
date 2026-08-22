/**
 * Разбор загруженного справочника и уборка брошенных импортов (задачи 26–27).
 *
 * ## Почему разбор именно здесь
 *
 * Офисный файл не разбирается ни в браузере, ни в процессе публичного API.
 * Первое — потому что уязвимость парсера там означает рабочую машину
 * сотрудника, второе — потому что у API есть пул БД, ключи хранилища и один
 * event-loop на все запросы, а разбор книги держит её целиком в памяти. Воркер
 * — единственное место, где такая работа уместна: у него отдельный процесс,
 * ограниченный параллелизм очереди `cpu` и лимит попыток.
 *
 * ## Результат разбора никого не заводит
 *
 * Задача пишет `catalog_import_rows` и переводит импорт в `ready`. Ни одной
 * карточки справочника она не создаёт: это делает администратор явным
 * действием, увидев предпросмотр. Так задумано — модель, читающая чужой файл,
 * не имеет права молча наполнить справочник, по которому потом сверяются акты.
 *
 * ## Отказ разбора — это состояние импорта, а не падение задачи
 *
 * Файл, который книгой не является, между попытками не изменится. Поэтому
 * `XlsxError` и отказ раскладки колонок переводят импорт в `failed` с внятной
 * причиной и ЗАВЕРШАЮТ задачу успешно: три повторных чтения того же файла не
 * дадут ничего, кроме трёх одинаковых записей в журнале ошибок. Падением
 * остаётся только то, что действительно может пройти со второй попытки:
 * недоступное хранилище, оборванное соединение с БД.
 */

import {
  loadCatalogSnapshot,
  failCatalogImport,
  findCatalogImport,
  findImportObjectKey,
  parseCatalogImport,
  saveCatalogImportRows,
  claimExpiredImports,
  readXlsxSheet,
  XlsxError,
  type JobContext,
  type JobHandler,
  type StorageProvider,
  type XlsxLimits,
} from '@id/api';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface CatalogImportDeps {
  readonly db: NodePgDatabase;
  readonly storage: StorageProvider;
  readonly limits?: XlsxLimits | undefined;
  /** Сколько импортов забирает одна уборка. Пачкой, чтобы не будить очередь на каждый. */
  readonly expireBatch?: number | undefined;
}

/** Объект хранилища целиком в память: книга справочника — сотни килобайт. */
async function readObject(
  storage: StorageProvider,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  const object = await storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.stream) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new XlsxError('Файл больше допустимого предела.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createCatalogImportParseHandler(
  deps: CatalogImportDeps,
): JobHandler<'catalog.import.parse'> {
  return async (ctx: JobContext<'catalog.import.parse'>) => {
    const { importId } = ctx.payload;

    const record = await findCatalogImport(deps.db, importId);
    if (record === null) {
      // Импорт исчез между постановкой и выполнением — например, его успела
      // убрать задача истечения. Это не отказ: делать нечего.
      ctx.logger.info({ event: 'catalog_import_gone', import_id: importId }, 'импорт не найден');
      return;
    }
    if (record.status !== 'parsing') {
      // Повторная попытка после успешной записи результата (`at-least-once`):
      // состояние уже целевое, второй разбор его не улучшит.
      ctx.logger.info(
        { event: 'catalog_import_not_parsing', import_id: importId, status: record.status },
        'импорт не в состоянии разбора',
      );
      return;
    }

    const key = await findImportObjectKey(deps.db, importId);
    if (key === null) {
      await failCatalogImport(deps.db, importId, 'Файл импорта не найден в хранилище.');
      return;
    }

    const maxBytes = deps.limits?.maxUncompressedBytes ?? 64 * 1024 * 1024;

    let bytes: Buffer;
    try {
      bytes = await readObject(deps.storage, key, maxBytes);
    } catch (error) {
      if (error instanceof XlsxError) {
        await failCatalogImport(deps.db, importId, error.message);
        return;
      }
      // Хранилище могло быть недоступно секунду — это как раз тот случай, ради
      // которого у задачи есть вторая попытка.
      throw error;
    }

    let sheet;
    try {
      sheet = deps.limits === undefined ? readXlsxSheet(bytes) : readXlsxSheet(bytes, deps.limits);
    } catch (error) {
      if (error instanceof XlsxError) {
        await failCatalogImport(deps.db, importId, error.message);
        ctx.logger.info(
          { event: 'catalog_import_unreadable', import_id: importId },
          'файл импорта не читается как книга Excel',
        );
        return;
      }
      throw error;
    }

    const snapshot = await loadCatalogSnapshot(deps.db);
    const parsed = parseCatalogImport(record.target, sheet, snapshot);

    if (!parsed.ok) {
      await failCatalogImport(deps.db, importId, parsed.reason);
      ctx.logger.info(
        { event: 'catalog_import_rejected', import_id: importId },
        'файл импорта отвергнут целиком',
      );
      return;
    }

    await saveCatalogImportRows(deps.db, importId, parsed.rows);
    ctx.logger.info(
      {
        event: 'catalog_import_parsed',
        import_id: importId,
        rows: parsed.rows.length,
        errors: parsed.rows.filter((row) => row.verdict === 'error').length,
      },
      'файл импорта разобран',
    );
  };
}

/**
 * Уборка брошенных импортов.
 *
 * Задача ставит саму себя на следующие сутки — иначе она выполнилась бы один
 * раз при старте и больше никогда. Отложенная постановка через `runAfterMs`, а не
 * таймер в процессе: воркеров может быть несколько, а уборка нужна одна, и
 * `dedupe_key` очереди обеспечивает это без выборов лидера.
 */
export function createCatalogImportExpireHandler(
  deps: CatalogImportDeps,
): JobHandler<'catalog.import.expire'> {
  const batch = deps.expireBatch ?? 100;

  return async (ctx: JobContext<'catalog.import.expire'>) => {
    const expired = await claimExpiredImports(deps.db, batch);

    for (const item of expired) {
      try {
        await deps.storage.deleteObject(item.s3Key);
      } catch {
        // Строка уже помечена `expired`, и это главное: файл без ссылки на него
        // не найти в интерфейсе. Оставшийся в хранилище объект — вопрос к
        // хранилищу, а не повод крутить задачу в отказах.
        ctx.logger.warn(
          { event: 'catalog_import_object_kept', import_id: item.id },
          'объект истёкшего импорта не удалён из хранилища',
        );
      }
    }

    if (expired.length > 0) {
      ctx.logger.info(
        { event: 'catalog_imports_expired', count: expired.length },
        'брошенные импорты убраны',
      );
    }

    await ctx.enqueue({
      type: 'catalog.import.expire',
      payload: {},
      dedupeKey: 'catalog.import.expire',
      runAfterMs: 24 * 60 * 60 * 1000,
    });
  };
}
