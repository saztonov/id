/**
 * Задача 2 конвейера — `file.signature_probe` (§12, §0.1).
 *
 * Структурный зонд встроенной подписи с ТРЕМЯ состояниями:
 *
 * - `none_detected` — файл разобран целиком, маркеров подписи нет. Это
 *   утверждение, а не догадка: `/ByteRange` адресует байтовые смещения самого
 *   файла и потому не может лежать в сжатом потоке объектов.
 * - `detected_unverified` — подпись найдена. Найдена — не значит действительна:
 *   криптографической проверки в MVP нет, полная проверка ГОСТ требует внешнего
 *   сервиса (§0.1, §11.2). Признать такую подпись действительной значило бы
 *   выдать юридическое заключение, которого портал не делал.
 * - `unknown` — файл разобран не полностью, и утверждать нельзя ничего.
 *
 * В наблюдаемом корпусе подписей ноль из трёх файлов: штамп «ДОКУМЕНТ ПОДПИСАН
 * ЭЛЕКТРОННОЙ ПОДПИСЬЮ» там растровый, впечатанный системой ЭДО в изображение
 * страницы, и ловится он правилом по OCR-тексту, а не этой задачей.
 *
 * ## Почему это отдельная задача, а не часть проверки файла
 *
 * У них разные последствия. Проверка решает судьбу файла: карантин закрывает
 * ему дорогу в рабочий документ. Зонд подписи не решает ничего — он собирает
 * свидетельство, которое попадёт в отчёт и в правила. Отказ зонда обязан
 * оставлять признак `unknown`, а не останавливать поставку, и смешивать это
 * с проверкой нельзя.
 */
import type { JobContext, JobHandler } from '@id/api';
import type { FileForVerification, FileJobTarget, SignatureFindings } from './file-verify.js';

export const SIGNATURE_PROBE_JOB_TYPE = 'file.signature_probe';

/** Значение колонки `source_files.signature_probe` (contracts: `signatureProbeSchema`). */
export interface StoredSignatureProbe {
  readonly result: SignatureFindings['result'];
  readonly hasByteRange: boolean;
  readonly subFilters: readonly string[];
  readonly signatureFieldCount: number;
  readonly probedAt: string;
  readonly probeError: string | null;
}

export interface SignatureProbeDeps {
  readonly loadFile: (target: FileJobTarget) => Promise<FileForVerification | null>;
  readonly readObject: (storageKey: string) => Promise<Uint8Array>;
  /** Признаки подписи по байтам файла — `probePdf()` из слоя разбора PDF. */
  readonly probe: (bytes: Uint8Array) => { readonly signature: SignatureFindings };
  /**
   * Запись зонда в `source_files.signature_probe`.
   *
   * `written: false` — ревизия уже подана и неизменяема (§3.9). Отказом это не
   * становится: свидетельство о подписи не является условием обработки, и
   * останавливать из-за него поставку было бы неверно. Причина уходит в журнал.
   */
  readonly saveProbe?:
    | ((input: {
        readonly fileId: string;
        readonly folderId: string;
        readonly probe: StoredSignatureProbe;
      }) => Promise<{ readonly written: boolean; readonly reason?: string | undefined }>)
    | undefined;
  readonly now?: (() => Date) | undefined;
}

export class SignatureProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureProbeError';
  }
}

export function createSignatureProbeHandler(
  deps: SignatureProbeDeps,
): JobHandler<'file.signature_probe'> {
  const now = deps.now ?? ((): Date => new Date());

  return async (ctx: JobContext<'file.signature_probe'>): Promise<void> => {
    const { folderId, sourceFileId } = ctx.payload;
    const file = await deps.loadFile({ folderId, sourceFileId });
    if (file === null) {
      throw new SignatureProbeError(
        `Файл ${sourceFileId} не найден или недоступен в области видимости задачи.`,
      );
    }
    if (file.folderId !== folderId) {
      throw new SignatureProbeError(
        `Файл ${sourceFileId} принадлежит ревизии ${file.folderId}, а задача поставлена ` +
          `для ревизии ${folderId}.`,
      );
    }

    const probe = await probeFile(deps, file, now());

    const saved =
      deps.saveProbe === undefined
        ? { written: false, reason: 'запись зонда не подключена' }
        : await deps.saveProbe({ fileId: file.fileId, folderId, probe });

    const fields = {
      event: 'signature_probed',
      source_file_id: file.fileId,
      file_name: file.fileName,
      result: probe.result,
      has_byte_range: probe.hasByteRange,
      sub_filters: probe.subFilters,
      signature_fields: probe.signatureFieldCount,
      saved: saved.written,
      ...(saved.written ? {} : { save_skipped: saved.reason ?? null }),
    };

    if (probe.result === 'detected_unverified') {
      // Предупреждение, а не ошибка: подпись найдена, и это факт, требующий
      // внимания, но не отказ. Проверить её портал не может и не обещает.
      ctx.logger.warn(fields, 'во вложении найдена встроенная подпись, проверка не выполнялась');
    } else if (probe.result === 'unknown') {
      ctx.logger.warn({ ...fields, probe_error: probe.probeError }, 'зонд подписи неопределён');
    } else {
      ctx.logger.info(fields, 'встроенной подписи не найдено');
    }

    await ctx.emit('file.signature_probed', {
      sourceFileId: file.fileId,
      fileName: file.fileName,
      result: probe.result,
      hasByteRange: probe.hasByteRange,
      subFilters: probe.subFilters,
      signatureFieldCount: probe.signatureFieldCount,
    });
  };
}

/**
 * Зонд одного файла.
 *
 * Ошибка чтения или разбора НЕ пробрасывается: она превращается в `unknown` с
 * текстом причины. Иначе недоступное на секунду хранилище отправляло бы задачу
 * в повтор и оставляло бы поставку без признака подписи вовсе — то есть без
 * различия между «подписи нет» и «мы не смотрели».
 */
async function probeFile(
  deps: SignatureProbeDeps,
  file: FileForVerification,
  probedAt: Date,
): Promise<StoredSignatureProbe> {
  try {
    const bytes = await deps.readObject(file.storageKey);
    const { signature } = deps.probe(bytes);
    return {
      result: signature.result,
      hasByteRange: signature.hasByteRange,
      subFilters: [...signature.subFilters],
      signatureFieldCount: signature.signatureFieldCount,
      probedAt: probedAt.toISOString(),
      probeError: signature.probeError,
    };
  } catch (error) {
    return {
      result: 'unknown',
      hasByteRange: false,
      subFilters: [],
      signatureFieldCount: 0,
      probedAt: probedAt.toISOString(),
      probeError: error instanceof Error ? error.message : 'зонд подписи не выполнен',
    };
  }
}
