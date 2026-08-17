/**
 * Файловая реализация хранилища — только для разработки и тестов.
 *
 * `env.ts` запрещает `STORAGE_DRIVER=local` при `NODE_ENV=production`: стандарт
 * не разрешает держать постоянные пользовательские данные на диске VPS. Здесь
 * она нужна затем же, зачем `pglite` вместо Docker (ADR-0002) — чтобы приём
 * файлов, карантин и Range-эндпоинт проверялись прогоном на машине без S3, а не
 * «по чтению кода».
 *
 * ## Как здесь устроен «presigned PUT»
 *
 * У локального каталога нет своего HTTP-эндпоинта, поэтому адрес указывает на
 * маршрут самого портала, а право записи подтверждает подписанный токен. От
 * настоящего presigned URL он отличается только тем, кто проверяет подпись, и
 * повторяет три его свойства, ради которых он и нужен: адрес выдаётся на один
 * ключ, действует ограниченное время и не требует сессии — клиент, который
 * заливает 86 МБ, не должен для этого держать cookie и CSRF-токен.
 *
 * ## Чего эта реализация не делает
 *
 * Не хранит тип содержимого. Это не деградация: MIME берётся из
 * `stored_blobs.mime`, куда его пишет сервер по магическим байтам (§4.2), и ни
 * один путь в портале не читает тип из метаданных хранилища.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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

/**
 * Путь маршрута, принимающего байты «презигнутого» PUT.
 *
 * Константа общая для провайдера и для роутов: адрес, собранный в двух местах,
 * рано или поздно разъедется, и обнаружится это отказом загрузки в разработке.
 */
export const LOCAL_UPLOAD_PATH = '/api/v1/uploads/local';

export interface LocalStorageOptions {
  readonly directory: string;
  /** Базовый адрес портала: из него собирается адрес приёма. */
  readonly publicUrl: string;
  /** Ключ подписи токенов приёма. Выводится из `CSRF_SECRET`, см. `provider.ts`. */
  readonly secret: Buffer;
}

interface TokenPayload {
  readonly key: string;
  readonly expiresAt: number;
  readonly maxBytes: number;
}

export class LocalStorageProvider implements StorageProvider {
  readonly driver: StorageDriver = 'local';
  readonly localUploads: LocalUploadSink;

  readonly #root: string;
  readonly #tmp: string;
  readonly #publicUrl: string;
  readonly #secret: Buffer;

  constructor(options: LocalStorageOptions) {
    this.#root = resolve(options.directory);
    // Ключи начинаются с буквы или цифры (см. `keys.ts`), поэтому каталог с
    // точкой в имени не может пересечься с ключом.
    this.#tmp = join(this.#root, '.tmp');
    this.#publicUrl = options.publicUrl.replace(/\/+$/, '');
    this.#secret = options.secret;
    this.localUploads = { verifyToken: (token) => this.#verifyToken(token) };
  }

  async putObject(input: PutObjectInput): Promise<StoredObjectHead> {
    const target = this.#path(input.key);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(this.#tmp, { recursive: true });

    // Запись во временный файл и переименование: иначе оборванная загрузка
    // оставила бы по ключу половину файла, которую следующий шаг принял бы за
    // готовый объект.
    const staging = join(this.#tmp, randomUUID());
    try {
      if (Buffer.isBuffer(input.body)) {
        await writeFile(staging, input.body);
      } else {
        await pipeline(input.body, createWriteStream(staging));
      }
      const written = await stat(staging);
      await rename(staging, target);
      return {
        key: input.key,
        sizeBytes: written.size,
        contentType: input.contentType,
        etag: null,
      };
    } catch (error) {
      await rm(staging, { force: true });
      // Ошибка, пришедшая из ТЕЛА запроса (превышение потолка у приёма байтов),
      // не является отказом хранилища. Обёртка превратила бы её в
      // «хранилище недоступно», то есть в 500 вместо 413, и подрядчик увидел бы
      // аварию портала вместо своей ошибки.
      if (!isFileSystemError(error)) throw error;
      throw wrap('put_object', error);
    }
  }

  async getObjectStream(key: string, range?: ByteRange | undefined): Promise<ObjectStream> {
    const path = this.#path(key);
    const info = await this.#stat(path, 'get_object');
    if (info === null) {
      throw new StorageError('not_found', 'get_object', 'Объект в хранилище не найден');
    }

    if (range === undefined) {
      return {
        stream: createReadStream(path),
        sizeBytes: info.size,
        contentLength: info.size,
        range: null,
      };
    }

    return {
      stream: createReadStream(path, { start: range.start, end: range.end }),
      sizeBytes: info.size,
      contentLength: range.end - range.start + 1,
      range,
    };
  }

  async headObject(key: string): Promise<StoredObjectHead | null> {
    const path = this.#path(key);
    const info = await this.#stat(path, 'head_object');
    if (info === null) return null;
    return { key, sizeBytes: info.size, contentType: null, etag: null };
  }

  async deleteObject(key: string): Promise<void> {
    // Удаление отсутствующего объекта — не ошибка: повтор операции и сборка
    // мусора обязаны быть идемпотентными.
    await rm(this.#path(key), { force: true });
  }

  async copyObject(
    sourceKey: string,
    targetKey: string,
    contentType: string,
  ): Promise<StoredObjectHead> {
    const source = this.#path(sourceKey);
    const target = this.#path(targetKey);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(source, target);
    } catch (error) {
      throw wrap('copy_object', error);
    }
    const info = await this.#stat(target, 'copy_object');
    if (info === null) {
      throw new StorageError('unavailable', 'copy_object', 'Скопированный объект не найден');
    }
    return { key: targetKey, sizeBytes: info.size, contentType, etag: null };
  }

  presignPut(input: PresignPutInput): Promise<PresignedPut> {
    assertStorageKey(input.key);
    const expiresAt = Date.now() + input.expiresInSeconds * 1000;
    const token = this.#signToken({
      key: input.key,
      expiresAt,
      maxBytes: input.maxBytes,
    });

    return Promise.resolve({
      // Токен в query, а не в сегменте пути: длина сегмента ограничена
      // maxParamLength Fastify, и подписанный токен упирался в неё, давая 414.
      // Настоящие presigned URL несут подпись тоже в query.
      url: `${this.#publicUrl}${LOCAL_UPLOAD_PATH}?token=${encodeURIComponent(token)}`,
      method: 'PUT',
      headers: {},
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  // =====================================================================
  // Токены приёма
  // =====================================================================

  #signToken(payload: TokenPayload): string {
    const body = Buffer.from(
      JSON.stringify({ k: payload.key, e: payload.expiresAt, m: payload.maxBytes }),
      'utf8',
    ).toString('base64url');
    return `${body}.${this.#mac(body)}`;
  }

  #verifyToken(token: string): { key: string; maxBytes: number } | null {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;

    const body = token.slice(0, dot);
    const presented = Buffer.from(token.slice(dot + 1), 'utf8');
    const expected = Buffer.from(this.#mac(body), 'utf8');
    // Сравнение постоянного времени: побайтовое сравнение подписи — учебный
    // канал подбора, и стоит защита от него одну строку.
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) return null;
    const { k, e, m } = parsed as { k?: unknown; e?: unknown; m?: unknown };
    if (typeof k !== 'string' || typeof e !== 'number' || typeof m !== 'number') return null;
    if (e < Date.now()) return null;
    if (!keyIsSafe(k)) return null;

    return { key: k, maxBytes: m };
  }

  #mac(body: string): string {
    // `.update()` здесь принадлежит node:crypto, а правило ищет запросы к БД по
    // имени метода и не различает их с хэшированием.
    return createHmac('sha256', this.#secret).update(body, 'utf8').digest('base64url');
  }

  // =====================================================================
  // Файловая система
  // =====================================================================

  /**
   * Ключ → путь.
   *
   * Проверка ключа обязательна именно здесь: `..` в ключе — это запись за
   * пределы `LOCAL_STORAGE_DIR`. Вторая проверка (результат внутри корня) стоит
   * на случай, если правило допустимого ключа однажды ослабят.
   */
  #path(key: string): string {
    assertStorageKey(key);
    const path = resolve(join(this.#root, ...key.split('/')));
    if (path !== this.#root && !path.startsWith(this.#root + sep)) {
      throw new StorageError('invalid_key', 'resolve_key', 'Ключ выходит за пределы хранилища');
    }
    return path;
  }

  async #stat(path: string, operation: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(path);
      return { size: info.size };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw wrap(operation, error);
    }
  }
}

function keyIsSafe(key: string): boolean {
  try {
    assertStorageKey(key);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Отказ файловой системы отличается от прикладной ошибки полем `code`. */
function isFileSystemError(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string';
}

function wrap(operation: string, error: unknown): StorageError {
  if (isNotFound(error)) {
    return new StorageError('not_found', operation, 'Объект в хранилище не найден', {
      cause: error,
    });
  }
  // Текст ошибки файловой системы содержит путь, то есть раскрывает раскладку
  // диска; в сообщение он не переносится, а в журнал уходит через `cause`.
  return new StorageError('unavailable', operation, 'Локальное хранилище недоступно', {
    cause: error,
  });
}
