/**
 * Реализация хранилища поверх S3-совместимого сервиса (Yandex Object Storage).
 *
 * ## Почему подпись написана здесь, а не взята из SDK
 *
 * Портал использует из S3 шесть операций: PUT, GET с диапазоном, HEAD, DELETE,
 * серверный COPY и presigned PUT. Всё это — подпись AWS Signature V4 поверх
 * `fetch`, то есть примерно сотня строк; официальный SDK притащил бы за собой
 * дерево зависимостей ради того же самого. Версии в проекте зафиксированы точно
 * (§2), и добавление пакета — отдельное решение, а не побочный эффект этапа.
 *
 * ## Адресация path-style
 *
 * `{endpoint}/{bucket}/{key}`. Yandex Object Storage и MinIO её поддерживают,
 * и она не требует, чтобы имя бакета было валидным доменным именем и имело
 * сертификат. Для AWS S3, где path-style объявлен устаревшим, потребуется
 * virtual-hosted — тогда меняется только `objectUrl()`.
 *
 * ## Чего здесь нет намеренно
 *
 * Presigned GET. Он не реализован не потому, что не нужен, а потому, что его
 * наличие само по себе опасно: §4.2 запрещает отдавать наружу ссылку, которая
 * до конца TTL действует мимо RBAC и оседает в истории браузера. Чтение идёт
 * через свой Range-эндпоинт, который каждый раз проверяет область видимости.
 */
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { assertStorageKey } from './keys.js';
import {
  StorageError,
  type ByteRange,
  type LocalUploadSink,
  type ObjectStream,
  type PresignPutInput,
  type PresignedPut,
  type PutObjectInput,
  type StorageDriver,
  type StorageProvider,
  type StoredObjectHead,
} from './provider.js';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const EMPTY_PAYLOAD_SHA256 = hashHex('');
/** Разрешено при подписи заголовками поверх TLS и обязательно при presign. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * Потолок ожидания для операций с телом фиксированного размера.
 *
 * На поток GET не накладывается: `AbortSignal.timeout` прервал бы законную
 * выгрузку 86 МБ, потому что считает время до конца ответа, а не до заголовков.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export interface S3Options {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
  /** Подмена транспорта для тестов подписи: сеть в тестах недоступна. */
  readonly fetchImpl?: typeof fetch | undefined;
}

interface SignedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export class S3StorageProvider implements StorageProvider {
  readonly driver: StorageDriver = 's3';
  /** У S3 приём идёт напрямую в хранилище, свой маршрут приложению не нужен. */
  readonly localUploads: LocalUploadSink | undefined = undefined;

  readonly #options: S3Options;
  readonly #fetch: typeof fetch;

  constructor(options: S3Options) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async putObject(input: PutObjectInput): Promise<StoredObjectHead> {
    assertStorageKey(input.key);

    const isBuffer = Buffer.isBuffer(input.body);
    const contentLength = isBuffer ? (input.body as Buffer).byteLength : input.contentLength;
    if (contentLength === undefined) {
      // S3 не принимает chunked-загрузку без потокового подписания, а оно
      // здесь не реализовано: длина обязана быть известна заранее.
      throw new StorageError('rejected', 'put_object', 'Для потока обязателен contentLength');
    }

    const payloadHash = isBuffer ? hashHex(input.body as Buffer) : UNSIGNED_PAYLOAD;

    const signed = this.#sign('PUT', input.key, {
      payloadHash,
      headers: {
        'content-type': input.contentType,
        'content-length': String(contentLength),
      },
    });

    const response = await this.#send('put_object', signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: isBuffer
        ? (input.body as Buffer)
        : // Web-поток из Node-потока: `fetch` не принимает `Readable`, а
          // объявление тела в типах `undici` не экспортируется по имени.
          (Readable.toWeb(input.body as Readable) as unknown as NonNullable<RequestInit['body']>),
      // Обязательно для потокового тела в undici: без этого fetch отказывается
      // отправлять запрос с ReadableStream.
      ...(isBuffer ? {} : { duplex: 'half' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    await drain(response);
    return {
      key: input.key,
      sizeBytes: contentLength,
      contentType: input.contentType,
      etag: response.headers.get('etag'),
    };
  }

  async getObjectStream(key: string, range?: ByteRange | undefined): Promise<ObjectStream> {
    assertStorageKey(key);

    const headers: Record<string, string> =
      range === undefined ? {} : { range: `bytes=${range.start}-${range.end}` };
    const signed = this.#sign('GET', key, { payloadHash: EMPTY_PAYLOAD_SHA256, headers });

    const response = await this.#send('get_object', signed.url, {
      method: 'GET',
      headers: signed.headers,
    });

    const body = response.body;
    if (body === null) {
      throw new StorageError('unavailable', 'get_object', 'Хранилище вернуло ответ без тела');
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    const contentRange = response.headers.get('content-range');
    const total = totalFromContentRange(contentRange) ?? contentLength;

    return {
      stream: Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      sizeBytes: total,
      contentLength,
      range: response.status === 206 && range !== undefined ? range : null,
    };
  }

  async headObject(key: string): Promise<StoredObjectHead | null> {
    assertStorageKey(key);
    const signed = this.#sign('HEAD', key, { payloadHash: EMPTY_PAYLOAD_SHA256, headers: {} });

    const response = await this.#send(
      'head_object',
      signed.url,
      {
        method: 'HEAD',
        headers: signed.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      { allowMissing: true },
    );
    if (response.status === 404) {
      await drain(response);
      return null;
    }

    await drain(response);
    return {
      key,
      sizeBytes: Number(response.headers.get('content-length') ?? '0'),
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
    };
  }

  async deleteObject(key: string): Promise<void> {
    assertStorageKey(key);
    const signed = this.#sign('DELETE', key, { payloadHash: EMPTY_PAYLOAD_SHA256, headers: {} });

    // Удаление отсутствующего объекта — не ошибка: сборка мусора и повтор
    // операции обязаны быть идемпотентными.
    const response = await this.#send(
      'delete_object',
      signed.url,
      {
        method: 'DELETE',
        headers: signed.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      { allowMissing: true },
    );
    await drain(response);
  }

  async copyObject(
    sourceKey: string,
    targetKey: string,
    contentType: string,
  ): Promise<StoredObjectHead> {
    assertStorageKey(sourceKey);
    assertStorageKey(targetKey);

    const signed = this.#sign('PUT', targetKey, {
      payloadHash: EMPTY_PAYLOAD_SHA256,
      headers: {
        'content-type': contentType,
        'x-amz-copy-source': encodePath(`/${this.#options.bucket}/${sourceKey}`),
        // Иначе объект унаследовал бы тип содержимого, который назвал клиент при
        // загрузке; портал же ставит тип, определённый по магическим байтам.
        'x-amz-metadata-directive': 'REPLACE',
      },
    });

    const response = await this.#send('copy_object', signed.url, {
      method: 'PUT',
      headers: signed.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await drain(response);

    const head = await this.headObject(targetKey);
    if (head === null) {
      throw new StorageError('unavailable', 'copy_object', 'Скопированный объект не найден');
    }
    return head;
  }

  presignPut(input: PresignPutInput): Promise<PresignedPut> {
    assertStorageKey(input.key);

    const now = new Date();
    const stamps = timestamps(now);
    const host = new URL(this.objectUrl(input.key)).host;
    const credential = `${this.#options.accessKey}/${stamps.dateStamp}/${this.#options.region}/${SERVICE}/aws4_request`;

    const query: Record<string, string> = {
      'X-Amz-Algorithm': ALGORITHM,
      'X-Amz-Credential': credential,
      'X-Amz-Date': stamps.amzDate,
      'X-Amz-Expires': String(input.expiresInSeconds),
      // Подписан только `host`. Подписать сюда ещё и `content-type` заманчиво,
      // но тогда любое расхождение с тем, что подставит браузер, даёт 403 без
      // внятной причины; тип содержимого всё равно не является доказательством
      // и переопределяется на `complete` по магическим байтам.
      'X-Amz-SignedHeaders': 'host',
    };

    const canonicalRequest = [
      'PUT',
      encodePath(`/${this.#options.bucket}/${input.key}`),
      canonicalQuery(query),
      `host:${host}\n`,
      'host',
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const signature = this.#signature(canonicalRequest, stamps);
    const url = `${this.objectUrl(input.key)}?${canonicalQuery({ ...query, 'X-Amz-Signature': signature })}`;

    return Promise.resolve({
      url,
      method: 'PUT',
      headers: {},
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString(),
    });
  }

  /** Адрес объекта без строки запроса. Открыт для тестов подписи. */
  objectUrl(key: string): string {
    const base = this.#options.endpoint.replace(/\/+$/, '');
    return `${base}${encodePath(`/${this.#options.bucket}/${key}`)}`;
  }

  // =====================================================================
  // Подпись
  // =====================================================================

  #sign(
    method: string,
    key: string,
    options: { payloadHash: string; headers: Record<string, string> },
  ): SignedRequest {
    const url = this.objectUrl(key);
    const stamps = timestamps(new Date());
    const host = new URL(url).host;

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries({
      ...options.headers,
      host,
      'x-amz-content-sha256': options.payloadHash,
      'x-amz-date': stamps.amzDate,
    })) {
      headers[name.toLowerCase()] = value;
    }

    // Имена заголовков здесь уже в нижнем регистре, но канонический запрос
    // требует именно нижнего регистра и сортировки, поэтому приведение явное:
    // один заголовок в другом регистре даёт 403 без пояснения причины.
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names
      .map((name) => `${name}:${collapseSpaces(headers[name] ?? '')}\n`)
      .join('');

    const canonicalRequest = [
      method,
      encodePath(`/${this.#options.bucket}/${key}`),
      '',
      canonicalHeaders,
      names.join(';'),
      options.payloadHash,
    ].join('\n');

    const signature = this.#signature(canonicalRequest, stamps);
    const credential = `${this.#options.accessKey}/${stamps.dateStamp}/${this.#options.region}/${SERVICE}/aws4_request`;

    return {
      url,
      headers: {
        ...headers,
        authorization: `${ALGORITHM} Credential=${credential}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
      },
    };
  }

  #signature(canonicalRequest: string, stamps: Timestamps): string {
    const scope = `${stamps.dateStamp}/${this.#options.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, stamps.amzDate, scope, hashHex(canonicalRequest)].join('\n');

    const dateKey = hmac(`AWS4${this.#options.secretKey}`, stamps.dateStamp);
    const regionKey = hmac(dateKey, this.#options.region);
    const serviceKey = hmac(regionKey, SERVICE);
    const signingKey = hmac(serviceKey, 'aws4_request');
    return hmac(signingKey, stringToSign).toString('hex');
  }

  async #send(
    operation: string,
    url: string,
    init: RequestInit,
    options: { readonly allowMissing?: boolean } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      // Ни адрес, ни подпись в сообщение не попадают: строка уходит в журнал.
      throw new StorageError('unavailable', operation, 'Хранилище недоступно', { cause: error });
    }

    if (response.ok || (options.allowMissing === true && response.status === 404)) return response;

    await drain(response);
    throw new StorageError(
      codeForStatus(response.status),
      operation,
      storageMessage(response.status),
      {
        statusCode: response.status,
      },
    );
  }
}

interface Timestamps {
  readonly amzDate: string;
  readonly dateStamp: string;
}

function timestamps(now: Date): Timestamps {
  const amz = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amzDate: amz, dateStamp: amz.slice(0, 8) };
}

function hmac(key: string | Buffer, value: string): Buffer {
  // `.update()` здесь принадлежит node:crypto, а правило ищет запросы к БД по
  // имени метода и не различает их с хэшированием.
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hashHex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Кодирование по RFC 3986, как того требует SigV4.
 *
 * `encodeURIComponent` оставляет `!'()*` незакодированными, а канонический
 * запрос обязан их кодировать: расхождение в один символ даёт 403 без пояснения.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Путь кодируется посегментно: разделители `/` остаются разделителями. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

export function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key] ?? '')}`)
    .join('&');
}

function collapseSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function codeForStatus(status: number): 'not_found' | 'rejected' | 'unavailable' {
  if (status === 404) return 'not_found';
  if (status >= 500) return 'unavailable';
  return 'rejected';
}

function storageMessage(status: number): string {
  if (status === 403 || status === 401) return 'Хранилище отклонило запрос: нет прав';
  if (status === 404) return 'Объект в хранилище не найден';
  if (status >= 500) return 'Хранилище недоступно';
  return `Хранилище отклонило запрос (${status})`;
}

/** Тело ответа обязано быть прочитано или отменено, иначе соединение не вернётся в пул. */
async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Ответ уже потреблён или прерван: диагностической ценности у этого нет.
  }
}

/** `bytes 0-99/12345` → 12345. */
function totalFromContentRange(value: string | null): number | null {
  if (value === null) return null;
  const match = /\/(\d+)\s*$/.exec(value);
  return match?.[1] === undefined ? null : Number(match[1]);
}
