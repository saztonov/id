/**
 * Три шага приёма файла (§4.2): `init` → PUT байтов → `complete`.
 *
 * Вынесено из `FilesTab`, потому что вызывающих стало два — обычная загрузка и
 * замена файла. Копия этих тридцати строк во втором месте разошлась бы с первым
 * на первой же правке, а расходятся здесь вещи, о которых узнают поздно:
 * заголовки, `credentials` и разбор отказа preflight.
 *
 * ## Почему PUT идёт голым `fetch`, а не через `api/http.ts`
 *
 * Адрес непрозрачен для клиента (в бою это presigned PUT в S3), и общая
 * обёртка приложила бы заголовок CSRF и наше JSON-оборачивание, которые S3
 * отвергнет подписью. Клиент, заливающий 200 МБ, cookie при этом не держит:
 * `same-origin` не мешает драйверу `local` на нашем origin и не отправляет
 * cookie чужому.
 */
import { files } from '../../api/endpoints.js';
import { describeUploadFailure } from '../../api/problem.js';
import type { SourceFile, UploadTicket } from '../../api/types.js';

/** Заливка байтов по выданному адресу. Общая часть приёма и замены. */
async function putBytes(ticket: UploadTicket, file: File): Promise<void> {
  let put: Response;
  try {
    put = await fetch(ticket.uploadUrl, {
      method: ticket.method,
      headers: ticket.headers,
      body: file,
      credentials: 'same-origin',
    });
  } catch (error) {
    // `TypeError` здесь — это чаще всего непройденный preflight, а не сеть:
    // `Failed to fetch` без объяснения отправляет искать проблему не туда.
    throw new Error(describeUploadFailure(error), { cause: error });
  }
  if (!put.ok) {
    throw new Error(`Хранилище не приняло байты: HTTP ${String(put.status)}`);
  }
}

/** Приём нового файла в ревизию. */
export async function uploadFile(revisionId: string, file: File): Promise<SourceFile> {
  const ticket = await files.initUpload(revisionId, file.name, file.size);
  await putBytes(ticket, file);
  return files.completeUpload(revisionId, ticket.uploadId);
}

/**
 * Замена файла: те же три шага, но своя пара маршрутов.
 *
 * Всё, что меняет базу, происходит на сервере одной транзакцией. Клиентская
 * последовательность «удалить → загрузить → переставить» непригодна: удаление
 * первым же шагом сносит файл вместе со всем производным, и любой отказ дальше
 * оставляет комплект без файла. Поменять шаги местами тоже нельзя — приём
 * файла отвергается, пока собран рабочий документ.
 */
export async function replaceFile(
  revisionId: string,
  fileId: string,
  file: File,
): Promise<SourceFile> {
  const ticket = await files.initReplacement(revisionId, fileId, file.name, file.size);
  await putBytes(ticket, file);
  return files.completeReplacement(revisionId, fileId, ticket.uploadId);
}
