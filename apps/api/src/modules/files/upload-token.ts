/**
 * Талон загрузки: состояние трёхшагового приёма между `init` и `complete`.
 *
 * ## Почему талон, а не строка в БД
 *
 * Строку `source_files` на шаге `init` создать нельзя: `blob_sha256` объявлен
 * NOT NULL и ссылается на `stored_blobs`, а хэш известен только после того, как
 * сервер прочитал фактические байты. Отдельная таблица сессий загрузки решала бы
 * ту же задачу ценой миграции и сборки мусора по ней; подписанный талон даёт то
 * же самое без состояния, а «пересоздать upload session» (§4.2) сводится к
 * повторному `init`.
 *
 * ## Что талон обязан нести и почему
 *
 * Ключ, ревизию, пользователя и срок. Ключ — чтобы `complete` читал ровно тот
 * объект, адрес которого выдал сервер, а не тот, который назовёт клиент:
 * иначе подстановкой чужого ключа файл чужой поставки регистрировался бы как
 * свой. Ревизию и пользователя — чтобы талон, выданный на одну ревизию, нельзя
 * было предъявить в другой, и чтобы перехваченный талон не работал в чужой
 * сессии. Срок — чтобы брошенная загрузка не оставалась пригодной вечно.
 *
 * Подпись — HMAC на выведенном ключе (`deriveTicketKey`), а не на `CSRF_SECRET`
 * напрямую: один секрет на два назначения означает, что утечка одного механизма
 * ломает второй.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UploadTicket {
  readonly uploadId: string;
  readonly revisionId: string;
  readonly userId: string;
  /** Имя, названное пользователем на `init`; в ключ объекта оно не попадает (§13). */
  readonly fileName: string;
  readonly key: string;
  readonly expiresAt: number;
}

/** Ключ подписи талонов. Домен разделён строкой назначения. */
export function deriveTicketKey(secret: string): Buffer {
  // `.update()` здесь принадлежит node:crypto, а правило ищет запросы к БД по
  // имени метода и не различает их с хэшированием.
  return createHmac('sha256', secret).update('id-portal:upload-ticket:v1').digest();
}

export function signUploadTicket(key: Buffer, ticket: UploadTicket): string {
  const body = Buffer.from(
    JSON.stringify({
      u: ticket.uploadId,
      r: ticket.revisionId,
      s: ticket.userId,
      n: ticket.fileName,
      k: ticket.key,
      e: ticket.expiresAt,
    }),
    'utf8',
  ).toString('base64url');
  return `${body}.${mac(key, body)}`;
}

/** `null` при любой негодности: подделке, порче, истечении срока. */
export function verifyUploadTicket(key: Buffer, token: string): UploadTicket | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(mac(key, body), 'utf8');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { u, r, s, n, k, e } = parsed as Record<string, unknown>;
  if (
    typeof u !== 'string' ||
    typeof r !== 'string' ||
    typeof s !== 'string' ||
    typeof n !== 'string' ||
    typeof k !== 'string' ||
    typeof e !== 'number'
  ) {
    return null;
  }
  if (e < Date.now()) return null;

  return { uploadId: u, revisionId: r, userId: s, fileName: n, key: k, expiresAt: e };
}

function mac(key: Buffer, body: string): string {
  // node:crypto, см. `deriveTicketKey`.
  return createHmac('sha256', key).update(body, 'utf8').digest('base64url');
}
