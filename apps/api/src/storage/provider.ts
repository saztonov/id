/**
 * Хранилище файлов: интерфейс, ошибки, измерение и выбор реализации (§7, §13).
 *
 * Домен работает только с этим интерфейсом. Реализации две: `s3` — боевая, и
 * `local` — для разработки; `env.ts` запрещает `local` при
 * `NODE_ENV=production`, потому что стандарт не разрешает держать
 * пользовательские данные на диске VPS.
 *
 * ## Что здесь принципиально
 *
 * **1. Наружу отдаётся presigned PUT и никогда presigned GET.** Загрузка идёт
 * мимо API прямо в хранилище (86 МБ через процесс Node — это память и время
 * запроса), а вот ЧТЕНИЕ идёт только через свой authenticated Range-эндпоинт:
 * presigned GET утекает в историю браузера, в Referer и в логи прокси, живёт до
 * конца TTL и на это время полностью обходит RBAC портала (§4.2). Поэтому
 * `presignPut` в интерфейсе есть, а `presignGet` — нет, и добавлять его нельзя:
 * отсутствие метода и есть гарантия.
 *
 * **2. Каждая операция измеряется.** `SLOW_EXTERNAL_MS` (§11) применяется здесь,
 * а не в каждом вызывающем: пропущенное измерение — это отсутствующая метрика,
 * которую замечают уже при разборе инцидента. Оборачивает `instrumentStorage()`,
 * и оборачивает ОБЕ реализации: `local` тоже внешний ввод-вывод, и «на диске
 * кончилось место» выглядит в журнале так же, как отказ S3.
 *
 * **3. `request_id` сквозной.** Логгер операции берётся `childLogger()` внутри
 * вызова, то есть в момент, когда область AsyncLocalStorage запроса уже открыта
 * (§11). Без этого строки о хранилище нельзя связать с запросом пользователя, а
 * они появляются как раз тогда, когда что-то пошло не так.
 *
 * **4. Тип содержимого хранилища ни на что не влияет.** MIME берётся из
 * `stored_blobs.mime`, куда его записал сервер по магическим байтам, а не из
 * метаданных объекта и тем более не из заявления клиента. Поэтому у драйвера
 * `local`, который метаданных не хранит вовсе, нет ни одной деградации.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { childLogger } from '../observability/context.js';
import { measureExternalCall, type Metrics } from '../observability/metrics.js';
import { LocalStorageProvider } from './local.js';
import { S3StorageProvider } from './s3.js';

export type StorageDriver = 's3' | 'local';

/** Полуинтервал байтов, включая обе границы, как в заголовке `Range`. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface StoredObjectHead {
  readonly key: string;
  readonly sizeBytes: number;
  /** То, что записало хранилище. Доверять ему нельзя, см. заголовок файла. */
  readonly contentType: string | null;
  readonly etag: string | null;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Buffer | Readable;
  readonly contentType: string;
  /** Обязателен для потока: S3 не принимает chunked без потокового подписания. */
  readonly contentLength?: number | undefined;
}

export interface ObjectStream {
  readonly stream: Readable;
  /** Размер объекта целиком, а не выданного куска: нужен для `Content-Range`. */
  readonly sizeBytes: number;
  /** Сколько байт в этом ответе. */
  readonly contentLength: number;
  /** `null`, если отдан объект целиком. */
  readonly range: ByteRange | null;
}

export interface PresignPutInput {
  readonly key: string;
  readonly expiresInSeconds: number;
  /**
   * Потолок размера. Обычный presigned PUT его НЕ навязывает (это умеет только
   * POST-политика), поэтому значение едет клиенту как подсказка, а настоящая
   * проверка выполняется на `complete` по фактическому объекту.
   */
  readonly maxBytes: number;
}

export interface PresignedPut {
  readonly url: string;
  readonly method: 'PUT';
  /** Заголовки, которые клиент обязан отправить: пусто, если ни один не подписан. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

/**
 * Приёмник байтов для драйвера `local`.
 *
 * У `local` нет собственного HTTP-эндпоинта, поэтому «presigned PUT» указывает
 * на маршрут самого портала, а право записи подтверждается подписанным токеном —
 * то же свойство, что у presigned URL: одноразовый адрес, ограниченный ключом и
 * сроком. Признак объявлен в интерфейсе, а не выясняется через `instanceof`,
 * потому что маршрут регистрируется только при наличии приёмника: в конфигурации
 * с S3 такого пути в приложении нет вовсе.
 */
export interface LocalUploadSink {
  /** `null` — токен подделан, просрочен или относится к другому ключу. */
  verifyToken(token: string): { readonly key: string; readonly maxBytes: number } | null;
}

export interface StorageProvider {
  readonly driver: StorageDriver;
  /** Есть только у `local`; в боевой конфигурации `undefined`. */
  readonly localUploads: LocalUploadSink | undefined;

  putObject(input: PutObjectInput): Promise<StoredObjectHead>;
  getObjectStream(key: string, range?: ByteRange | undefined): Promise<ObjectStream>;
  /** `null`, если объекта нет: отсутствие — это не ошибка, а ответ. */
  headObject(key: string): Promise<StoredObjectHead | null>;
  deleteObject(key: string): Promise<void>;
  /**
   * Копирование внутри хранилища.
   *
   * Нужно для перевода проверенной загрузки из `uploads/` в `blobs/{sha256}`.
   * Через хранилище, а не через процесс портала: перекачивать 86 МБ туда и
   * обратно ради смены ключа — это и трафик, и память, и время запроса.
   */
  copyObject(sourceKey: string, targetKey: string, contentType: string): Promise<StoredObjectHead>;
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
}

export type StorageErrorCode = 'not_found' | 'invalid_key' | 'rejected' | 'unavailable';

/**
 * Ошибка хранилища.
 *
 * Ни адреса, ни подписи, ни тела ответа в сообщение не попадают: presigned URL
 * стандарт относит к секретам (§11), а сообщение ошибки — первое, что уезжает в
 * журнал целиком.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly operation: string;
  readonly statusCode: number | undefined;

  constructor(
    code: StorageErrorCode,
    operation: string,
    message: string,
    options: { readonly statusCode?: number | undefined; readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.operation = operation;
    this.statusCode = options.statusCode;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}

export interface StorageInstrumentation {
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly slowExternalMs: number;
}

/**
 * Обёртка, снимающая тайминги и пишущая строку журнала на каждую операцию.
 *
 * Метка `service` — имя драйвера, а не адрес: кардинальность меток ограничена
 * (§11). Ключ в журнал попадает, и это безопасно: он состоит из uuid и sha256 и
 * по построению не содержит ни имени файла, ни сведений о стройке.
 */
export function instrumentStorage(
  provider: StorageProvider,
  instrumentation: StorageInstrumentation,
): StorageProvider {
  const { metrics, logger, slowExternalMs } = instrumentation;
  const service = provider.driver === 's3' ? 's3' : 'local-storage';

  const measure = <T>(operation: string, key: string, call: () => Promise<T>): Promise<T> =>
    measureExternalCall(metrics, { service, operation }, call, {
      // Дочерний логгер создаётся внутри вызова: поля контекста (`request_id`,
      // `user_id`, `folder_id`) берутся в момент операции, а не в момент
      // сборки приложения, когда никакого запроса ещё нет.
      logger: childLogger(logger, { component: 'storage', storage_key: key }),
      slowExternalMs,
    });

  return {
    driver: provider.driver,
    localUploads: provider.localUploads,
    putObject: (input) => measure('put_object', input.key, () => provider.putObject(input)),
    // Измеряется время до заголовков ответа: тело читает вызывающий, и его
    // длительность — это длительность его запроса, а не внешнего вызова.
    getObjectStream: (key, range) =>
      measure('get_object', key, () => provider.getObjectStream(key, range)),
    headObject: (key) => measure('head_object', key, () => provider.headObject(key)),
    deleteObject: (key) => measure('delete_object', key, () => provider.deleteObject(key)),
    copyObject: (sourceKey, targetKey, contentType) =>
      measure('copy_object', targetKey, () =>
        provider.copyObject(sourceKey, targetKey, contentType),
      ),
    presignPut: (input) => measure('presign_put', input.key, () => provider.presignPut(input)),
  };
}

/**
 * Секрет подписи токенов драйвера `local`.
 *
 * Отдельный ключ, выведенный из `CSRF_SECRET`, а не сам `CSRF_SECRET`: один
 * секрет для двух назначений означает, что утечка одного механизма ломает
 * второй. Вне продакшна секрета может не быть вовсе — тогда берётся случайное
 * значение на время жизни процесса: токен переживать перезапуск не обязан.
 */
function localUploadSecret(env: Env): Buffer {
  const base = env.CSRF_SECRET ?? randomBytes(32).toString('hex');
  // `.update()` здесь принадлежит node:crypto, а правило ищет запросы к БД по
  // имени метода и не различает их с хэшированием.
  return createHmac('sha256', base).update('id-portal:local-upload:v1').digest();
}

export interface CreateStorageOptions {
  readonly metrics: Metrics;
  readonly logger: Logger;
}

/**
 * Выбор реализации по конфигурации.
 *
 * Обязательность `S3_*` при `STORAGE_DRIVER=s3` и `LOCAL_STORAGE_DIR` при
 * `local` проверяет `loadEnv()` при старте; проверки здесь — сужение типа и
 * защита от вызова с самодельным объектом окружения в тестах.
 */
export function createStorage(env: Env, options: CreateStorageOptions): StorageProvider {
  const base =
    env.STORAGE_DRIVER === 's3'
      ? new S3StorageProvider({
          endpoint: required(env.S3_ENDPOINT, 'S3_ENDPOINT'),
          bucket: required(env.S3_BUCKET, 'S3_BUCKET'),
          accessKey: required(env.S3_ACCESS_KEY, 'S3_ACCESS_KEY'),
          secretKey: required(env.S3_SECRET_KEY, 'S3_SECRET_KEY'),
          region: env.S3_REGION,
        })
      : new LocalStorageProvider({
          directory: required(env.LOCAL_STORAGE_DIR, 'LOCAL_STORAGE_DIR'),
          publicUrl: env.PUBLIC_URL,
          secret: localUploadSecret(env),
        });

  return instrumentStorage(base, {
    metrics: options.metrics,
    logger: options.logger,
    slowExternalMs: env.SLOW_EXTERNAL_MS,
  });
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} обязателен при выбранном STORAGE_DRIVER`);
  }
  return value;
}
