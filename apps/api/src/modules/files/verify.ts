/**
 * Проверка загруженного объекта на шаге `complete` (§4.2).
 *
 * ## Разбора PDF здесь нет намеренно
 *
 * Структуру, шифрование, число страниц, геометрию и признаки подписи считает
 * `pdf/probe.ts` — тот же модуль, которым пользуется задача `file.verify` (§12).
 * Две реализации одной проверки разошлись бы молча, и однажды файл, принятый
 * синхронно, оказался бы отвергнут задачей (или наоборот). Здесь остаётся то,
 * чего в чистой функции быть не может: чтение потока из хранилища с жёстким
 * потолком и перевод вердикта в форму, которую пишет репозиторий.
 *
 * ## Карантин, а не удаление
 *
 * Непрошедший файл сохраняется с `verify_state='quarantined'` и причиной.
 * Подрядчик обязан видеть, ЧТО именно отвергнуто: «загрузка не удалась» без
 * имени файла и причины — это обращение в поддержку, а не работа с порталом.
 * Байты при этом порталом не раздаются (Range-эндпоинт отдаёт только `ok`).
 *
 * ## Почему в v1 принимается только PDF
 *
 * §3.3 допускает изображения, конвертируемые в страницы рабочего документа, но
 * сборщик рабочего документа этого этапа (`pdf/toolkit.ts`) собирает его только
 * из PDF. Принять JPEG значило бы завести ревизию в тупик: файл лежит, а
 * `bundle.build` по нему не проходит. Поэтому изображение отвергается СРАЗУ и
 * с внятной причиной, а не молча копится до стадии сборки.
 */
import type { Readable } from 'node:stream';
import type { SignatureProbe } from '@id/contracts';
import {
  evaluatePdfFile,
  PDF_MIME,
  type FileQuarantineReason,
  type FileVerdict,
} from '../../pdf/probe.js';

/** Что портал принимает на приёме файлов (§4.2). */
export const ACCEPTED_MIME_TYPES: readonly string[] = [PDF_MIME];

/** Тип для объекта, который PDF не является: наружу он всё равно не отдаётся. */
const UNKNOWN_MIME = 'application/octet-stream';

const PDF_MAGIC = '%PDF-';

export interface VerifyLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
}

export interface VerifiedPage {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: 0 | 90 | 180 | 270;
  /** Разрешение покрывающего растра; `null` — страница не скан либо растр не опознан. */
  readonly nativeDpi: number | null;
}

export interface VerifiedUpload {
  readonly state: 'ok' | 'quarantined';
  /** Причина карантина для подрядчика; `null` у принятого файла. */
  readonly error: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  /** Пусто у карантина: страницы отвергнутого файла в ревизии не учитываются. */
  readonly pages: readonly VerifiedPage[];
  readonly signatureProbe: SignatureProbe;
}

export class UploadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super('Размер файла превышает разрешённый');
    this.name = 'UploadTooLargeError';
  }
}

/**
 * Читает объект целиком, считая вердикт по фактическим байтам.
 *
 * Превышение потолка — это отказ запроса (`UploadTooLargeError`), а не карантин:
 * для файла сверх лимита нет ни честного sha256 (он не дочитан), ни повода
 * занимать им хранилище.
 */
export async function verifyUploadedObject(
  stream: Readable,
  limits: VerifyLimits,
): Promise<VerifiedUpload> {
  const content = await readAll(stream, limits.maxBytes);
  const probedAt = new Date().toISOString();

  const verdict = evaluatePdfFile(content, {
    maxBytes: limits.maxBytes,
    maxPages: limits.maxPages,
    // Заявленный клиентом тип не передаётся сознательно: решение принимается по
    // магическим байтам, иначе `text/html` от подрядчика уехал бы в
    // `stored_blobs.mime`, а оттуда — в заголовок ответа Range-эндпоинта.
  });

  const storable = storableVerdict(verdict, probedAt);
  const looksLikePdf = content.subarray(0, 1024).includes(PDF_MAGIC, 0, 'latin1');

  return {
    state: storable.verifyState,
    error: storable.verifyError,
    sha256: verdict.sha256,
    sizeBytes: content.byteLength,
    // Тип ставится по сигнатуре, а не по вердикту: у повреждённого, но всё же
    // PDF-файла тип известен, у произвольных байтов — нет.
    mime: storable.verifyState === 'ok' || looksLikePdf ? PDF_MIME : UNKNOWN_MIME,
    pages: storable.pages,
    signatureProbe: storable.signatureProbe,
  };
}

/**
 * Вердикт в вид, пригодный для записи в `source_files` и `source_pages`.
 *
 * Экспортируется ради задачи `file.verify`: она пишет то же самое, и вторая
 * реализация приведения означала бы, что состояние файла зависит от того, кто
 * его записал — синхронная загрузка или конвейер. Расхождение при этом было бы
 * невидимым: те же колонки, другие значения.
 */
export function storableVerdict(
  verdict: FileVerdict,
  probedAt: string,
): {
  readonly verifyState: 'ok' | 'quarantined';
  readonly verifyError: string | null;
  readonly signatureProbe: SignatureProbe;
  readonly pages: readonly VerifiedPage[];
} {
  const signatureProbe: SignatureProbe = {
    result: verdict.signature.result,
    hasByteRange: verdict.signature.hasByteRange,
    subFilters: [...verdict.signature.subFilters],
    signatureFieldCount: verdict.signature.signatureFieldCount,
    probedAt,
    probeError: verdict.signature.probeError,
  };

  if (verdict.state === 'quarantined') {
    return {
      verifyState: 'quarantined',
      verifyError: quarantineMessage(verdict.reason, verdict.detail),
      signatureProbe,
      pages: [],
    };
  }

  return {
    verifyState: 'ok',
    verifyError: null,
    signatureProbe,
    pages: verdict.pages.map((page) => ({
      // Колонки `source_pages` целочисленные, а `/MediaBox` дробный: округление
      // здесь, потому что целочисленность — свойство хранения, а не документа.
      widthPx: Math.max(1, Math.round(page.widthPt)),
      heightPx: Math.max(1, Math.round(page.heightPt)),
      rotation: page.rotation,
      nativeDpi: page.nativeDpi,
    })),
  };
}

/**
 * Причина отказа человеческим языком.
 *
 * Код причины остаётся в `pdf/probe.ts` и годится для метрик, но подрядчику
 * нужен следующий шаг, а не классификатор: «снимите пароль», «разделите файл».
 */
function quarantineMessage(reason: FileQuarantineReason, detail: string): string {
  switch (reason) {
    case 'not_a_pdf':
      return 'Файл не является PDF. Портал принимает исполнительную документацию в PDF.';
    case 'encrypted':
      return 'PDF защищён паролем. Снимите защиту и загрузите файл заново.';
    case 'unparsable':
      return `PDF повреждён и не читается: ${detail}`;
    case 'too_many_pages':
      return `Слишком много страниц в одном файле (${detail}). Разделите файл на части.`;
    case 'too_large':
      return `Файл слишком большой (${detail}).`;
    case 'hash_mismatch':
      return 'Содержимое файла не совпало с сохранённым: повторите загрузку.';
    case 'unsupported_mime':
      return 'Неподдерживаемый тип файла. Портал принимает PDF.';
  }
}

/**
 * Чтение потока с жёстким потолком.
 *
 * Потолок нужен и после проверки размера через `headObject`: между HEAD и GET
 * объект может быть перезаписан, а безлимитное накопление в память — это отказ
 * процесса, а не отказ запроса.
 */
async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new UploadTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total);
}
