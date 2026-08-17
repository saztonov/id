/**
 * Регистрация ошибок с дедупликацией по отпечатку (§11).
 *
 * Отпечаток = sha1(класс ошибки + нормализованное сообщение + верхний СВОЙ кадр
 * стека). «Свой» — кадр из нашего кода, не из `node_modules` и не из внутренних
 * модулей Node: если брать просто верхний кадр, все падения внутри одной
 * библиотеки склеятся в одну запись, и по ней будет не видно, какой из наших
 * вызовов её вызвал. Тысяча одинаковых падений даёт одну строку со счётчиком.
 *
 * Номер строки в отпечаток не входит: иначе любая правка файла выше по тексту
 * расщепляла бы счётчик существующей ошибки на две записи. Полный кадр с
 * номером строки сохраняется в `sample_context` как образец.
 *
 * В БД не попадает исходный текст сообщения — только нормализованный шаблон.
 * Сообщения PostgreSQL содержат значения полей («Key (dedupe_key)=(…)»), то
 * есть потенциально ПДн, а таблица диагностики видна администратору.
 */
import { hash } from 'node:crypto';
import type { Logger } from 'pino';
import { currentContext } from './context.js';
import { redactDeep } from './logger.js';

export interface ErrorEventContext {
  readonly requestId?: string | undefined;
  readonly userId?: string | undefined;
  readonly route?: string | undefined;
  readonly objectId?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly jobType?: string | undefined;
  readonly jobId?: string | undefined;
  readonly attempt?: number | undefined;
  /** Дополнительные поля образца. Уходят в БД как есть — ПДн тут запрещены. */
  readonly extra?: Record<string, unknown> | undefined;
}

export interface ErrorReporter {
  report(error: unknown, context?: ErrorEventContext): Promise<void>;
}

export interface ErrorFingerprint {
  readonly fingerprint: string;
  readonly errorClass: string;
  readonly messageTemplate: string;
  /** Нормализованный свой кадр; `undefined`, если своего кадра в стеке нет. */
  readonly topFrame: string | undefined;
  /** Тот же кадр с номером строки — только для образца. */
  readonly topFrameRaw: string | undefined;
}

const MAX_MESSAGE_LENGTH = 300;
const MAX_IDENTIFIER_LENGTH = 63;
const MAX_LOGGED_FRAMES = 5;
/** Глубина цепочки `cause`: `HttpProblem` → ошибка драйвера. Дальше — шум. */
const MAX_CAUSE_DEPTH = 2;

export function errorClassOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor.name || 'Error';
  }
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
    return error.constructor?.name ?? 'Object';
  }
  // Бросили не ошибку — это отдельный класс дефекта, и склеивать его с Error нельзя.
  return `NonError(${typeof error})`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * Слова, после которых PostgreSQL цитирует ИМЯ объекта схемы, а не значение.
 *
 * Различение по контексту, а не по форме содержимого. Проверка «похоже на
 * идентификатор» (буквы, цифры, подчёркивания) пропускала значения
 * bind-параметров той же формы — логины, `kc_sub` вида `kc_admin`, любую
 * буквенно-цифровую строку без дефисов. Они попадали в журнал и НАВСЕГДА
 * в `error_events.message_template`, которую читает администратор, да ещё и
 * получали собственный отпечаток, размножая записи об одном дефекте.
 */
const IDENTIFIER_CONTEXT =
  /\b(relation|column|constraint|table|index|type|function|schema|role|database|sequence|view|trigger|operator|extension|policy)\s+$/iu;

/** Имя объекта схемы стоит сохранить: разные таблицы — разные дефекты. */
function isSchemaIdentifier(value: string, precedingText: string): boolean {
  return (
    value.length <= MAX_IDENTIFIER_LENGTH &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    IDENTIFIER_CONTEXT.test(precedingText)
  );
}

/**
 * Нормализация сообщения: убираются uuid, отпечатки, даты, числа и значения в
 * кавычках. Содержимое кавычек сохраняется, если это похоже на идентификатор:
 * `relation "submission_revisions" does not exist` и
 * `relation "page_assignments" does not exist` — разные дефекты, а после полного
 * вычёркивания кавычек они стали бы одной записью.
 */
export function normalizeErrorMessage(message: string): string {
  const normalized = message
    .replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      '<timestamp>',
    )
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    // Форма, в которой PostgreSQL печатает значение ключа при нарушении
    // уникальности или FK: там лежат данные строки.
    .replace(/\)=\([^)]*\)/g, ')=(<value>)')
    .replace(
      /'([^']*)'|"([^"]*)"|«([^»]*)»/g,
      (
        match: string,
        single: string | undefined,
        double: string | undefined,
        guillemets: string | undefined,
        offset: number,
        whole: string,
      ): string => {
        const inner = single ?? double ?? guillemets ?? '';
        return isSchemaIdentifier(inner, whole.slice(0, offset)) ? match : '<value>';
      },
    )
    .replace(/(?<![\w$<])\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > MAX_MESSAGE_LENGTH
    ? `${normalized.slice(0, MAX_MESSAGE_LENGTH)}…`
    : normalized;
}

interface OwnFrame {
  readonly normalized: string;
  readonly raw: string;
}

/** Разделители пути приведены к `/` до сравнения — в стеках Windows они обратные. */
const OWN_CODE_MARKERS = ['/apps/', '/packages/', '/tools/'];

function isForeignFrame(frame: string): boolean {
  return (
    frame.includes('node_modules') ||
    frame.includes('(node:') ||
    frame.includes('at node:') ||
    frame.includes('internal/process') ||
    frame.includes('internal/modules')
  );
}

/** Путь до корня репозитория из отпечатка убирается: у деплоя он свой. */
function repoRelative(location: string): string {
  const normalized = location.replace(/\\/g, '/');
  for (const marker of OWN_CODE_MARKERS) {
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash < 0 ? normalized : normalized.slice(lastSlash + 1);
}

/** Разбор кадра: `at fn (файл:строка:столбец)` и `at файл:строка:столбец`. */
function parseFrame(frame: string): OwnFrame | undefined {
  const withParens = /^at\s+(.+?)\s+\((.+)\)$/.exec(frame);
  const bare = /^at\s+(.+)$/.exec(frame);
  const fn = withParens?.[1];
  const location = withParens?.[2] ?? bare?.[1];
  if (location === undefined) return undefined;

  const withoutPosition = location.replace(/:\d+:\d+$/, '');
  const file = repoRelative(withoutPosition);
  return {
    normalized: fn === undefined ? file : `${fn} (${file})`,
    raw: fn === undefined ? repoRelative(location) : `${fn} (${repoRelative(location)})`,
  };
}

function collectOwnFrames(stack: string | undefined, limit: number): OwnFrame[] {
  if (stack === undefined) return [];

  const frames: OwnFrame[] = [];
  for (const line of stack.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('at ')) continue;
    if (isForeignFrame(frame)) continue;

    const parsed = parseFrame(frame);
    if (parsed === undefined) continue;
    frames.push(parsed);
    if (frames.length >= limit) break;
  }
  return frames;
}

export function topOwnFrame(stack: string | undefined): OwnFrame | undefined {
  return collectOwnFrames(stack, 1)[0];
}

/**
 * Свои кадры стека в том виде, в котором их можно писать в журнал.
 *
 * Абсолютный путь из кадра убирается: он выдаёт устройство машины и раздувает
 * строку, а для поиска места падения достаточно пути от корня репозитория.
 * Чужие кадры отброшены — в них не наш дефект.
 */
export function ownStackFrames(stack: string | undefined, limit = MAX_LOGGED_FRAMES): string[] {
  return collectOwnFrames(stack, limit).map((frame) => frame.raw);
}

/**
 * Безопасная выжимка ошибки для журнала (§11).
 *
 * Причина существования: объект ошибки драйвера PostgreSQL нельзя отдавать
 * сериализатору `err` целиком. У `pg` в нём лежат `query` (полный текст SQL) и
 * `params` (ВСЕ значения bind-параметров) — для INSERT в `auth_sessions` это
 * выгрузка id сессии, `kc_sid`, `csrf_hash` и шифрованного конверта
 * refresh-токена, а на запросах к документам — распознанного текста и ФИО
 * подписантов. Поля `detail`, `where`, `internalQuery` содержат значения по той
 * же причине. Поэтому берутся только класс, нормализованное сообщение, SQLSTATE
 * и имя ограничения: этого хватает, чтобы отличить конфликт уникальности от
 * нарушения FK, и не хватает, чтобы восстановить данные.
 *
 * `fingerprint` совпадает с ключом строки в `error_events` — строка журнала и
 * запись экрана диагностики соединяются по нему без догадок.
 */
export interface ErrorDigest {
  readonly error_class: string;
  /** Сообщение с вычеркнутыми значениями, не исходный текст. */
  readonly message: string;
  readonly fingerprint: string;
  /** SQLSTATE PostgreSQL или код системной ошибки Node. */
  readonly error_code?: string;
  readonly constraint?: string;
  readonly own_frames?: readonly string[];
  readonly cause?: ErrorDigest;
}

function stringField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function causeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  // Ссылка на себя встречается: так иногда «оборачивают» ошибку повторно.
  return cause === error ? undefined : cause;
}

function digestAt(error: unknown, depthLeft: number): ErrorDigest {
  const fingerprint = fingerprintError(error);
  const code = stringField(error, 'code');
  const constraint = stringField(error, 'constraint');
  const frames = ownStackFrames(error instanceof Error ? error.stack : undefined);
  const cause = depthLeft > 0 ? causeOf(error) : undefined;

  return {
    error_class: fingerprint.errorClass,
    message: fingerprint.messageTemplate,
    fingerprint: fingerprint.fingerprint,
    ...(code === undefined ? {} : { error_code: code }),
    ...(constraint === undefined ? {} : { constraint }),
    ...(frames.length === 0 ? {} : { own_frames: frames }),
    ...(cause === undefined || cause === null ? {} : { cause: digestAt(cause, depthLeft - 1) }),
  };
}

export function errorDigest(error: unknown): ErrorDigest {
  return digestAt(error, MAX_CAUSE_DEPTH);
}

export function fingerprintError(error: unknown): ErrorFingerprint {
  const errorClass = errorClassOf(error);
  const messageTemplate = normalizeErrorMessage(messageOf(error));
  const frame = topOwnFrame(error instanceof Error ? error.stack : undefined);
  const fingerprint = hash('sha1', `${errorClass}\n${messageTemplate}\n${frame?.normalized ?? ''}`);

  return {
    fingerprint,
    errorClass,
    messageTemplate,
    topFrame: frame?.normalized,
    topFrameRaw: frame?.raw,
  };
}

/** Минимальный интерфейс клиента БД: подходят `pg.Pool`, `pg.PoolClient`, pglite. */
export interface SqlExecutor {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/**
 * Повторное появление после `resolved` снова открывает запись: иначе однажды
 * закрытая ошибка исчезла бы с экрана диагностики навсегда. Статус `ack`
 * сохраняется — он означает «взято в работу», и сбрасывать его каждым
 * повторением значило бы заново поднимать шум.
 */
const UPSERT_ERROR_EVENT = `
  INSERT INTO error_events (
    fingerprint, error_class, message_template, top_frame, sample_request_id, sample_context
  )
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  ON CONFLICT (fingerprint) DO UPDATE
     SET count = error_events.count + 1,
         last_seen_at = now(),
         status = CASE WHEN error_events.status = 'resolved' THEN 'new' ELSE error_events.status END,
         resolved_at = CASE WHEN error_events.status = 'resolved' THEN NULL
                            ELSE error_events.resolved_at END,
         sample_request_id = COALESCE($5, error_events.sample_request_id),
         sample_context = COALESCE($6::jsonb, error_events.sample_context)
`;

function mergeWithContext(context: ErrorEventContext | undefined): ErrorEventContext {
  const ambient = currentContext();
  if (!ambient) return context ?? {};
  return {
    requestId: context?.requestId ?? ambient.requestId,
    userId: context?.userId ?? ambient.userId,
    route: context?.route ?? ambient.route,
    objectId: context?.objectId ?? ambient.objectId,
    revisionId: context?.revisionId ?? ambient.revisionId,
    jobType: context?.jobType ?? ambient.jobType,
    jobId: context?.jobId ?? ambient.jobId,
    attempt: context?.attempt ?? ambient.attempt,
    extra: context?.extra,
  };
}

function sampleContext(
  fingerprint: ErrorFingerprint,
  context: ErrorEventContext,
): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  if (context.userId !== undefined) sample.user_id = context.userId;
  if (context.route !== undefined) sample.route = context.route;
  if (context.objectId !== undefined) sample.object_id = context.objectId;
  if (context.revisionId !== undefined) sample.revision_id = context.revisionId;
  if (context.jobType !== undefined) sample.job_type = context.jobType;
  if (context.jobId !== undefined) sample.job_id = context.jobId;
  if (context.attempt !== undefined) sample.attempt = context.attempt;
  if (fingerprint.topFrameRaw !== undefined) sample.own_frame = fingerprint.topFrameRaw;
  // Контекст проходит ту же очистку, что журнал. Без неё error_events.sample_context
  // становится вторым каналом утечки, более долговечным: строка в таблице без срока
  // хранения, тогда как журнал ротируется.
  if (context.extra !== undefined) sample.extra = redactDeep(context.extra);
  return sample;
}

export interface DbErrorReporterOptions {
  readonly sql: SqlExecutor;
  readonly logger: Logger;
}

export class DbErrorReporter implements ErrorReporter {
  private readonly sql: SqlExecutor;
  private readonly logger: Logger;

  constructor(options: DbErrorReporterOptions) {
    this.sql = options.sql;
    this.logger = options.logger;
  }

  async report(error: unknown, context?: ErrorEventContext): Promise<void> {
    const fingerprint = fingerprintError(error);
    const merged = mergeWithContext(context);

    try {
      await this.sql.query(UPSERT_ERROR_EVENT, [
        fingerprint.fingerprint,
        fingerprint.errorClass,
        fingerprint.messageTemplate,
        fingerprint.topFrame ?? null,
        merged.requestId ?? null,
        JSON.stringify(sampleContext(fingerprint, merged)),
      ]);
      this.logger.debug(
        { event: 'error_reported', fingerprint: fingerprint.fingerprint },
        'ошибка зарегистрирована',
      );
    } catch (writeError) {
      // Репортер не имеет права бросать: его вызывают из catch-блоков и из
      // обработчика необработанных отказов. Собственный сбой только пишется в
      // лог — попытка зарегистрировать его в той же БД зациклила бы отказ.
      this.logger.error(
        {
          event: 'error_report_failed',
          fingerprint: fingerprint.fingerprint,
          error_class: errorClassOf(writeError),
        },
        'не удалось записать ошибку в error_events',
      );
    }
  }
}

export interface SentryErrorReporterOptions {
  readonly dsn: string;
  readonly logger: Logger;
  /**
   * Куда писать событие, пока транспорта нет. Обязателен намеренно: включение
   * флага не должно означать потерю данных экрана диагностики.
   */
  readonly delegate: ErrorReporter;
  readonly environment?: string;
  readonly release?: string;
}

/**
 * Заглушка Sentry: включается `ERROR_REPORTER=sentry` при заданном `SENTRY_DSN`.
 *
 * SDK в зависимостях нет, поэтому событие пишется в лог в том виде, в котором
 * ушло бы в Sentry, и передаётся в `db`-репортер. DSN в лог не попадает — в нём
 * ключ проекта; остаётся только хост, чтобы было видно, куда настроено.
 */
export class SentryErrorReporter implements ErrorReporter {
  private readonly logger: Logger;
  private readonly delegate: ErrorReporter;
  private readonly host: string;
  private readonly environment: string | undefined;
  private readonly release: string | undefined;
  private warned = false;

  constructor(options: SentryErrorReporterOptions) {
    this.logger = options.logger;
    this.delegate = options.delegate;
    this.host = hostOfDsn(options.dsn);
    this.environment = options.environment;
    this.release = options.release;
  }

  async report(error: unknown, context?: ErrorEventContext): Promise<void> {
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        { event: 'sentry_transport_missing', sentry_host: this.host },
        'ERROR_REPORTER=sentry включён, но транспорт не установлен: события пишутся в лог и в БД',
      );
    }

    const fingerprint = fingerprintError(error);
    this.logger.error(
      {
        event: 'sentry_event',
        sentry_host: this.host,
        environment: this.environment,
        release: this.release,
        fingerprint: fingerprint.fingerprint,
        error_class: fingerprint.errorClass,
        message_template: fingerprint.messageTemplate,
        top_frame: fingerprint.topFrame,
      },
      'событие для Sentry',
    );

    await this.delegate.report(error, context);
  }
}

function hostOfDsn(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return 'invalid-dsn';
  }
}

/** Пустой репортер: тесты и локальный запуск без БД. */
export class NoopErrorReporter implements ErrorReporter {
  report(): Promise<void> {
    return Promise.resolve();
  }
}

export interface CreateErrorReporterOptions {
  readonly kind: 'db' | 'sentry';
  readonly sql: SqlExecutor;
  readonly logger: Logger;
  readonly sentryDsn?: string | undefined;
  readonly environment?: string | undefined;
  readonly release?: string | undefined;
}

export function createErrorReporter(options: CreateErrorReporterOptions): ErrorReporter {
  const db = new DbErrorReporter({ sql: options.sql, logger: options.logger });
  if (options.kind !== 'sentry') return db;

  if (options.sentryDsn === undefined || options.sentryDsn.length === 0) {
    // Проверка окружения это уже отвергает; здесь остаётся защита от того,
    // чтобы отсутствие DSN не превратилось в потерю регистрации ошибок.
    options.logger.warn(
      { event: 'sentry_dsn_missing' },
      'ERROR_REPORTER=sentry без SENTRY_DSN: используется запись в БД',
    );
    return db;
  }

  return new SentryErrorReporter({
    dsn: options.sentryDsn,
    logger: options.logger,
    delegate: db,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.release === undefined ? {} : { release: options.release }),
  });
}

/**
 * Минимум логгера для обработчиков процесса.
 *
 * Объявлен структурно, чтобы подходил и `app.log` Fastify: обработчики
 * регистрируются из `server.ts`, где логгер доступен именно в этом виде, а
 * приведение типа ради двух методов означало бы приведение и в следующем месте.
 */
export interface ErrorLogSink {
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
}

export interface ProcessErrorHandlerOptions {
  readonly reporter: ErrorReporter;
  readonly logger: ErrorLogSink;
  /**
   * Гасить процесс после `uncaughtException`. По умолчанию да: после
   * необработанного исключения состояние процесса не определено, и продолжать
   * работу в нём опаснее, чем перезапуститься под supervisor'ом.
   */
  readonly exitOnUncaught?: boolean;
  readonly exitCode?: number;
}

/**
 * Регистрирует необработанные отказы и исключения.
 *
 * Без этого падение вне обработчика запроса не попадает ни в `error_events`, ни
 * в лог в структурированном виде — остаётся только трассировка в stdout, по
 * которой дедупликации нет.
 */
export function installProcessErrorHandlers(options: ProcessErrorHandlerOptions): () => void {
  const { reporter, logger } = options;
  const exitOnUncaught = options.exitOnUncaught ?? true;

  const onRejection = (reason: unknown): void => {
    logger.error(
      { event: 'unhandled_rejection', error_class: errorClassOf(reason) },
      'необработанный отказ промиса',
    );
    void reporter.report(reason, { extra: { source: 'unhandledRejection' } });
  };

  const onException = (error: unknown): void => {
    logger.fatal(
      { event: 'uncaught_exception', error_class: errorClassOf(error) },
      'необработанное исключение',
    );
    // Записать успеваем не всегда, поэтому выход отложен до завершения записи,
    // а не сразу: иначе строки в error_events не будет ровно у самых тяжёлых
    // падений.
    void reporter.report(error, { extra: { source: 'uncaughtException' } }).finally(() => {
      if (exitOnUncaught) process.exit(options.exitCode ?? 1);
    });
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}
