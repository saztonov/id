/**
 * Логгер: pino, JSON в stdout, redaction по списку стандарта (§11).
 *
 * Модуль не зависит ни от Fastify, ни от разбора окружения: уровень и имя
 * сервиса передаются явно, потому что тот же логгер поднимает воркер.
 *
 * Redaction в pino работает по путям, а не по имени поля на любой глубине,
 * поэтому для каждого секретного ключа порождаются пути `key`, `*.key` и
 * `*.*.key`. Глубже не идём сознательно: каждый уровень подстановки заставляет
 * redaction обходить всё дерево объекта на каждой строке лога, а трёх уровней
 * хватает на наши формы (`{ token }`, `req.headers.authorization`,
 * `err.response.headers.cookie`). Если появится структура глубже — путь
 * добавляется через `extraRedactPaths`, а не увеличением глубины для всех.
 *
 * Presigned URL стандарт относит к секретам, и попадает он в лог именно через
 * поля вида `url` / `uploadUrl` / `downloadUrl` / `cropUrl`. Целиком такое поле
 * вычёркивать жалко: без адреса непонятно, к какому объекту относилась запись.
 * Подпись SigV4 всегда лежит в query-строке, поэтому у URL-полей вычёркивается
 * query, а схема, хост и путь остаются. Путь безопасен по построению: ключ S3
 * собирается только из UUID и SHA-256 (§13).
 *
 * Важное ограничение: redaction применяется к полям объекта, но не к тексту
 * сообщения. Значения обязаны передаваться полями, а не подстановкой в строку.
 */
import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions, SerializerFn } from 'pino';
import { markTraceMixin, traceFields } from './context.js';
import { errorDigest } from './errors.js';

/** `silent` — для тестов: строки pino между сообщениями vitest нечитаемы. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
export type AppLogger = Logger;

/** Метка вместо значения: сам факт наличия поля должен остаться виден. */
export const REDACTED = '[Redacted]';

/** Секреты: значение недопустимо в логе ни в каком виде. */
const SECRET_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'pass',
  'oldPassword',
  'newPassword',
  'passwordConfirm',
  'authorization',
  'Authorization',
  'proxy-authorization',
  'proxyAuthorization',
  'cookie',
  'cookies',
  'set-cookie',
  'setCookie',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'refreshTokenEnc',
  'idToken',
  'id_token',
  'bearer',
  'sessionId',
  'session_id',
  'sid',
  'kcSid',
  'kc_sid',
  'csrfToken',
  'csrf_token',
  'x-csrf-token',
  'apiKey',
  'api_key',
  'clientSecret',
  'client_secret',
  'secret',
  'secrets',
  'secretKey',
  'secret_key',
  'otp',
  'otpCode',
  'totp',
  'mfaCode',
  'codeVerifier',
  'code_verifier',
  'recoveryCode',
  'recoveryCodes',
  'backupCode',
  'backupCodes',
  'privateKey',
  'private_key',
  'encKey',
  'encryptionKey',
  'hmacKey',
  'hmac_key',
  'keyMaterial',
  'sessionEncKey',
  'auditHmacKey',
];

/**
 * Персональные данные и содержимое документов.
 *
 * `payload` в список не входит: в payload'ах job'ов лежат идентификаторы, без
 * которых диагностика конвейера невозможна. За то, чтобы в payload не попали
 * ПДн, отвечает сам конвейер — он хранит `payload_digest`, а не текст (§3.8).
 */
const PII_KEYS: readonly string[] = [
  'body',
  'rawBody',
  'requestBody',
  'responseBody',
  'text',
  'fullText',
  'pageText',
  'page_text',
  'ocrText',
  'ocr_text',
  'blockText',
  'content',
  'prompt',
  'systemPrompt',
  'userPrompt',
  'completion',
  'messages',
  'fullName',
  'full_name',
  'fio',
  'signerName',
  'signer_name',
  'firstName',
  'lastName',
  'middleName',
  'patronymic',
  'surname',
  'email',
  'phone',
  'passport',
  'snils',
  'birthDate',
  'birth_date',
  'address',
  'thumbprint',
  'certThumbprint',
  'cert_thumbprint',
  'certSerial',
];

/** Поля-адреса: вычёркивается query-строка, остальное остаётся. */
const URL_KEYS: readonly string[] = [
  'url',
  'uri',
  'href',
  'location',
  'uploadUrl',
  'upload_url',
  'downloadUrl',
  'download_url',
  'cropUrl',
  'crop_url',
  'previewUrl',
  'thumbUrl',
  'presignedUrl',
  'presigned_url',
  'signedUrl',
  'signed_url',
  'callbackUrl',
  'redirectUri',
  'redirect_uri',
];

const NESTING_DEPTH = 3;
const MAX_URL_LENGTH = 300;

const URL_KEY_SET = new Set(URL_KEYS.map((key) => key.toLowerCase()));

/** Пути `key`, `*.key`, `*.*.key`; ключ с дефисом требует скобочной записи. */
function pathsForKey(key: string): string[] {
  const plain = /^[A-Za-z_$][\w$]*$/.test(key);
  const paths: string[] = [];
  for (let level = 0; level < NESTING_DEPTH; level += 1) {
    const prefix = '*.'.repeat(level);
    if (plain) {
      paths.push(`${prefix}${key}`);
    } else {
      paths.push(level === 0 ? `["${key}"]` : `${prefix.slice(0, -1)}["${key}"]`);
    }
  }
  return paths;
}

export function buildRedactPaths(extra: readonly string[] = []): string[] {
  const paths = new Set<string>();
  for (const key of [...SECRET_KEYS, ...PII_KEYS, ...URL_KEYS]) {
    for (const path of pathsForKey(key)) paths.add(path);
  }
  for (const path of extra) paths.add(path);
  return [...paths];
}

function stripQuery(value: string): string {
  const cut = value.indexOf('?');
  // URL без query не может быть подписанным — вычёркивать нечего.
  const kept = cut < 0 ? value : `${value.slice(0, cut)}?${REDACTED}`;
  return kept.length > MAX_URL_LENGTH ? `${kept.slice(0, MAX_URL_LENGTH)}…` : kept;
}

/** Censor pino получает и значение, и путь — это позволяет URL обрабатывать иначе. */
export function censorValue(value: unknown, path: readonly string[]): unknown {
  const key = path[path.length - 1];
  if (key !== undefined && URL_KEY_SET.has(key.toLowerCase()) && typeof value === 'string') {
    return stripQuery(value);
  }
  return REDACTED;
}

/** Ключи, выдающие объект ошибки драйвера PostgreSQL. */
const PG_ERROR_KEYS: ReadonlySet<string> = new Set([
  'query',
  'params',
  'where',
  'detail',
  'internalquery',
  'internalposition',
]);

const SECRET_KEY_SET: ReadonlySet<string> = new Set(
  [...SECRET_KEYS, ...PII_KEYS].map((k) => k.toLowerCase()),
);

/** Ограничитель обхода: защищает от аномально глубоких объектов. */
const MAX_WALK_DEPTH = 12;

/**
 * Рекурсивная очистка значения любой формы и глубины.
 *
 * Заменяет собой очистку по путям, потому что та принципиально не может
 * закрыть задачу. Три подтверждённых атакой дефекта имели один корень —
 * список путей вида `key`, `*.key`, `*.*.key` покрывает фиксированную глубину:
 *
 * 1. Секрет на глубине 4 и глубже уходил открытым текстом. При этом форма
 *    `resp.config.headers.authorization` — стандартный объект ошибки
 *    HTTP-клиента, и она понадобится на интеграции с RD WEB и proxy_llm,
 *    где `Authorization` передаётся в каждом вызове.
 * 2. Защита от выгрузки SQL и bind-параметров была привязана к ИМЕНИ поля
 *    `err` через сериализатор. Тот же объект ошибки PostgreSQL под любым
 *    другим ключом выгружался целиком: `query` с полным текстом SQL и
 *    `params` со всеми значениями параметров. Для `INSERT INTO auth_sessions`
 *    это id сессии, `kc_sid`, `csrf_hash` и конверт refresh-токена.
 * 3. Запись в `error_events.sample_context` шла вообще без очистки, то есть
 *    существовал второй канал утечки, более долговечный, чем журнал:
 *    строка в таблице без срока хранения.
 *
 * Обход по значению закрывает все три: имя ключа перестаёт определять
 * защищённость, а глубина ограничена только здравым смыслом.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_WALK_DEPTH) return REDACTED;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));

  // Ошибка не является обычным объектом: её перечисляемые свойства неполны,
  // а сообщение и стек нужны в очищенном виде.
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      error_class: value.name,
      // Сообщение драйвера содержит значение bind-параметра:
      // «invalid input syntax for type uuid: "…"». Форма сообщения нужна
      // для диагностики, значение — нет.
      message: sanitizeMessage(value.message),
    };
    for (const [k, v] of Object.entries(value)) {
      if (PG_ERROR_KEYS.has(k.toLowerCase()) || SECRET_KEY_SET.has(k.toLowerCase())) continue;
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (PG_ERROR_KEYS.has(lower) || SECRET_KEY_SET.has(lower)) {
      out[k] = REDACTED;
      continue;
    }
    if (URL_KEY_SET.has(lower)) {
      out[k] = typeof v === 'string' ? stripQuery(v) : REDACTED;
      continue;
    }
    out[k] = redactDeep(v, depth + 1);
  }
  return out;
}

/**
 * Убирает значения из текста сообщения.
 *
 * Нужно потому, что `msg` формируется пино отдельно от объекта и никакой
 * очисткой полей не покрывается: идиоматичный `log.error(err)` кладёт в `msg`
 * сырое сообщение драйвера, а оно содержит значение bind-параметра
 * («invalid input syntax for type uuid: "…"»).
 *
 * Вычёркивается ВСЁ содержимое кавычек без исключений. Прежняя реализация
 * сохраняла содержимое, похожее на идентификатор, и значения вида `kc_admin`
 * или любая буквенно-цифровая строка без дефисов переживали нормализацию,
 * попадая и в журнал, и навсегда в `error_events.message_template`.
 */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/"[^"]*"/gu, `"${REDACTED}"`)
    .replace(/'[^']*'/gu, `'${REDACTED}'`)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<uuid>')
    .slice(0, 512);
}

/**
 * Сериализаторы стандартных ключей `err`, `req`, `res`.
 *
 * Redaction работает по именам полей, а штатные сериализаторы pino и Fastify
 * кладут в эти ключи то, чего в журнале быть не должно, под безобидными
 * именами: `pino.stdSerializers.err` копирует ВСЕ собственные свойства ошибки
 * (у драйвера `pg` это `query` и `params`, то есть SQL и значения
 * bind-параметров), а сериализатор запроса Fastify пишет `url` целиком — вместе
 * с authorization code OIDC в query-строке. Поэтому ключи обслуживаются здесь,
 * а не отдаются реализации по умолчанию.
 *
 * Сериализаторы терпимы к чужой форме: значение, не похожее на ошибку, запрос
 * или ответ, возвращается как есть и остаётся под redaction. Иначе поле с
 * именем `req`, в котором лежит что-то своё, молча превратилось бы в пустой
 * объект.
 */
export const safeSerializers: Record<string, SerializerFn> = {
  err: (value: unknown) => (value === null || value === undefined ? value : errorDigest(value)),
  req: serializeRequestLike,
  res: serializeResponseLike,
};

function serializeRequestLike(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;

  const candidate = value as {
    method?: unknown;
    url?: unknown;
    routeOptions?: { url?: unknown };
  };
  const method = typeof candidate.method === 'string' ? candidate.method : undefined;
  const url = typeof candidate.url === 'string' ? candidate.url : undefined;
  if (method === undefined && url === undefined) return value;

  const route =
    typeof candidate.routeOptions?.url === 'string' ? candidate.routeOptions.url : undefined;
  return {
    method,
    // Тот же приём, что в `requestInstance()`: строка запроса вычёркивается
    // целиком. В ней приезжают authorization code, `state` и поисковые строки
    // с ПДн, а разбирать её по параметрам — гадание о том, что безопасно.
    url: url === undefined ? undefined : stripQuery(url),
    route,
  };
}

function serializeResponseLike(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const statusCode = (value as { statusCode?: unknown }).statusCode;
  // Заголовки ответа не переносятся: в них `set-cookie` с идентификатором сессии.
  return typeof statusCode === 'number' ? { statusCode } : value;
}

export interface CreateLoggerOptions {
  /** `api` или `worker`: без этого поля строки двух процессов неразличимы. */
  readonly service: string;
  readonly level?: LogLevel;
  readonly env?: string;
  readonly version?: string;
  readonly extraRedactPaths?: readonly string[];
  readonly base?: Record<string, unknown>;
  /** Поток для тестов; по умолчанию stdout, как требует стандарт. */
  readonly destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: Record<string, unknown> = { service: options.service, pid: process.pid };
  if (options.env !== undefined) base.env = options.env;
  if (options.version !== undefined) base.version = options.version;
  Object.assign(base, options.base ?? {});

  const loggerOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base,
    // ISO вместо epoch: логи читают глазами в `docker logs`, а не только машиной.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // Рекурсивный обход всего объекта записи вместо очистки по списку путей.
      // Список путей покрывает фиксированную глубину и зависит от имени ключа,
      // из-за чего секрет на глубине 4 и объект ошибки PostgreSQL под ключом,
      // отличным от `err`, уходили в журнал открытым текстом (см. redactDeep).
      log: (object) => redactDeep(object) as Record<string, unknown>,
    },
    // Очистка по путям сохранена как дополнительный слой: она отрабатывает
    // раньше форматтера и закрывает случай, когда форматтер отключат.
    redact: {
      paths: buildRedactPaths(options.extraRedactPaths ?? []),
      censor: censorValue,
    },
    serializers: safeSerializers,
    // Поля контекста подмешиваются в каждую строку: request_id обязан быть и в
    // тех записях, которые делает код, ничего не знающий о запросе.
    mixin: () => traceFields(),
    hooks: {
      // `msg` формируется пино отдельно от объекта, и очистка полей его не
      // касается: `log.error(err)` кладёт в него сырое сообщение драйвера
      // вместе со значением bind-параметра.
      logMethod(args, method) {
        // Идиоматичный `log.error(err)`: пино само переносит `err.message`
        // в `msg`, минуя и очистку полей, и обработку строковых аргументов.
        // Поэтому ошибка первым аргументом переписывается в явную форму.
        if (args[0] instanceof Error) {
          const err = args[0];
          const rest = args.slice(1);
          const explicit =
            typeof rest[0] === 'string'
              ? [{ err }, sanitizeMessage(rest[0]), ...rest.slice(1)]
              : [{ err }, sanitizeMessage(err.message), ...rest];
          method.apply(this, explicit as Parameters<typeof method>);
          return;
        }

        const cleaned = args.map((arg) =>
          typeof arg === 'string' ? sanitizeMessage(arg) : arg,
        ) as Parameters<typeof method>;
        method.apply(this, cleaned);
      },
    },
  };

  const logger =
    options.destination === undefined
      ? pino(loggerOptions)
      : pino(loggerOptions, options.destination);

  markTraceMixin(logger);
  return logger;
}
