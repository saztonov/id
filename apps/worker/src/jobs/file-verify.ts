/**
 * Задача 1 конвейера — `file.verify` (§12, §4.2).
 *
 * Проверяет файл в том виде, в каком он ЛЕЖИТ В ХРАНИЛИЩЕ: MIME по магическим
 * байтам, структуру PDF, шифрование, лимит страниц, совпадение SHA-256. Файл,
 * не прошедший проверку, уходит в карантин, а не удаляется: подрядчик обязан
 * видеть, что именно отвергнуто и почему.
 *
 * ## Почему проверка повторяется, если она была при загрузке
 *
 * При загрузке проверяется ПОТОК, приходящий от клиента; здесь — объект,
 * который в итоге сохранён. Между этими двумя моментами лежат S3, диск и
 * повторные попытки загрузки, а расхождение содержимого с записанным вердиктом
 * означает, что портал считает пригодным файл, которого у него нет. Такое
 * расхождение обязано останавливать конвейер: рабочий документ, собранный из
 * подменённых байтов, дальше уже неотличим от настоящего.
 *
 * ## Разделение обязанностей
 *
 * Вся содержательная работа — в `evaluatePdfFile()` (`apps/api/src/pdf/probe.ts`),
 * который проверяется на настоящих файлах. Здесь только оркестровка: прочитать,
 * спросить вердикт, записать (или сверить) и сообщить. Так решение «в карантин»
 * не зависит от того, вызвана ли задача, и проверяется на файлах, а не на
 * подставных объектах очереди.
 *
 * ## Порты вместо импортов
 *
 * Пакет `@id/api` отдаёт воркеру только объявленную поверхность (движок задач,
 * конфигурацию, наблюдаемость), а хранилище, разбор PDF и репозитории в неё не
 * входят. Поэтому обработчик принимает уже связанные функции: область видимости
 * и подключение к БД подставляет точка сборки, а обработчик остаётся чистой
 * оркестровкой, пригодной для проверки без хранилища и без базы.
 */
import type {
  FileQuarantineReason,
  FileVerdict,
  JobContext,
  JobHandler,
  PdfPageGeometry,
  PdfSignatureFindings,
} from '@id/api';

export const FILE_VERIFY_JOB_TYPE = 'file.verify';

/**
 * Типы вердикта берутся из слоя разбора PDF, а не описываются здесь заново.
 *
 * Зеркало было соблазнительным (обработчик проверяется без базы и хранилища),
 * но структурная копия расходится молча: в ней не оказалось ни `index` у
 * страницы, ни `incrementalUpdates` у подписи, и обнаружилось это лишь при
 * попытке передать вердикт дальше. Типы не создают связи во время выполнения,
 * поэтому проверяемость обработчика от импорта не страдает.
 */
export type { FileQuarantineReason, FileVerdict };
export type PageGeometry = PdfPageGeometry;
export type SignatureFindings = PdfSignatureFindings;

/** Строка файла в объёме, нужном проверке. Совпадает с `FileContentRef`. */
export interface FileForVerification {
  readonly fileId: string;
  readonly folderId: string;
  readonly fileName: string;
  readonly verifyState: 'pending' | 'ok' | 'quarantined';
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Адресация файла задачей: ревизия ВМЕСТЕ с файлом, а не файл отдельно.
 *
 * Ревизия здесь не избыточна. Она — область видимости самой задачи: связывание
 * (`pipeline.ts`) сначала разрешает ревизию из payload, а файл ищет уже
 * закреплённой за ней областью. Приняв один `sourceFileId`, задача читала бы
 * файл любой поставки, у которой совпал идентификатор в payload, и проверка
 * принадлежности не выполнялась бы вовсе.
 */
export interface FileJobTarget {
  readonly folderId: string;
  readonly sourceFileId: string;
}

export interface FileVerifyDeps {
  /** `null` — файла нет или он вне области видимости; разница наружу не выдаётся. */
  readonly loadFile: (target: FileJobTarget) => Promise<FileForVerification | null>;
  readonly readObject: (storageKey: string) => Promise<Uint8Array>;
  readonly evaluate: (
    bytes: Uint8Array,
    policy: {
      readonly maxBytes: number;
      readonly maxPages: number;
      readonly expectedSha256?: string | undefined;
    },
  ) => FileVerdict;
  readonly limits: { readonly maxBytes: number; readonly maxPages: number };
  /**
   * Запись вердикта.
   *
   * `written: false` — писать было нельзя (ревизия уже подана и неизменяема,
   * §3.9). Это не ошибка записи, а другой режим работы: на неизменяемой ревизии
   * задача обязана СВЕРЯТЬ, а не переписывать состояние, потому что расхождение
   * содержимого хранилища с записанным вердиктом там означает подмену байтов уже
   * принятого комплекта — и она должна останавливать конвейер.
   *
   * Необязательность оставлена для проверок обработчика без базы.
   */
  readonly saveVerdict?:
    | ((input: {
        readonly fileId: string;
        readonly folderId: string;
        readonly verdict: FileVerdict;
      }) => Promise<{ readonly written: boolean; readonly reason?: string | undefined }>)
    | undefined;
}

export class FileVerificationError extends Error {
  readonly fileId: string;

  constructor(message: string, fileId: string) {
    super(message);
    this.name = 'FileVerificationError';
    this.fileId = fileId;
  }
}

export function createFileVerifyHandler(deps: FileVerifyDeps): JobHandler<'file.verify'> {
  return async (ctx: JobContext<'file.verify'>): Promise<void> => {
    const { folderId, sourceFileId } = ctx.payload;
    const file = await deps.loadFile({ folderId, sourceFileId });
    if (file === null) {
      throw new FileVerificationError(
        `Файл ${sourceFileId} не найден или недоступен в области видимости задачи.`,
        sourceFileId,
      );
    }
    // Вторая половина проверки принадлежности: область видимости закреплена за
    // подрядчиком ревизии, но у подрядчика поставок много. Файл из ЧУЖОЙ
    // ревизии того же подрядчика прошёл бы область и получил бы вердикт,
    // записанный не туда, куда относится.
    if (file.folderId !== folderId) {
      throw new FileVerificationError(
        `Файл ${sourceFileId} принадлежит ревизии ${file.folderId}, а задача поставлена ` +
          `для ревизии ${folderId}.`,
        sourceFileId,
      );
    }

    const bytes = await deps.readObject(file.storageKey);
    const verdict = deps.evaluate(bytes, {
      maxBytes: deps.limits.maxBytes,
      maxPages: deps.limits.maxPages,
      // Расхождение хэша ловится тем же вердиктом: байты в хранилище обязаны
      // быть теми, под которыми файл записан.
      expectedSha256: file.sha256,
    });

    const fields = {
      event: 'file_verified',
      source_file_id: file.fileId,
      file_name: file.fileName,
      recorded_state: file.verifyState,
      verdict: verdict.state,
      ...(verdict.state === 'quarantined'
        ? { reason: verdict.reason }
        : { page_count: verdict.pageCount }),
      signature: verdict.signature.result,
    };

    const saved =
      deps.saveVerdict === undefined
        ? { written: false, reason: 'запись вердикта не подключена' }
        : await deps.saveVerdict({ fileId: file.fileId, folderId, verdict });

    if (!saved.written && verdict.state !== file.verifyState) {
      // Сверка вместо записи: см. `saveVerdict`. Молчаливое расхождение здесь
      // означало бы, что рабочий документ соберётся из файла, который проверку
      // на самом деле не проходит.
      ctx.logger.error(
        { ...fields, save_skipped: saved.reason ?? null },
        'содержимое хранилища расходится с записанным состоянием файла',
      );
      await ctx.emit('file.verify_mismatch', {
        sourceFileId: file.fileId,
        recordedState: file.verifyState,
        actualState: verdict.state,
        ...(verdict.state === 'quarantined' ? { reason: verdict.reason } : {}),
      });
      throw new FileVerificationError(
        `Файл «${file.fileName}» записан как «${file.verifyState}», ` +
          `а содержимое хранилища даёт «${verdict.state}»` +
          (verdict.state === 'quarantined' ? `: ${verdict.detail}` : '') +
          '. Состав ревизии обязан быть перепроверен человеком.',
        file.fileId,
      );
    }

    if (verdict.state === 'quarantined') {
      ctx.logger.warn(fields, 'файл отправлен в карантин');
      await ctx.emit('file.quarantined', {
        sourceFileId: file.fileId,
        fileName: file.fileName,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      return;
    }

    if (verdict.warnings.length > 0) {
      ctx.logger.warn(
        { ...fields, warnings: verdict.warnings },
        'файл принят, но его структура нестандартна',
      );
    } else {
      ctx.logger.info(fields, 'файл проверен');
    }

    await ctx.emit('file.verified', {
      sourceFileId: file.fileId,
      fileName: file.fileName,
      pageCount: verdict.pageCount,
      signature: verdict.signature.result,
    });
  };
}
