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
import type { ProcessingStage } from '@id/contracts';
import { currentContext } from './context.js';
import { redactDeep } from './logger.js';

/**
 * Версия алгоритма отпечатка.
 *
 * Повышается при ЛЮБОЙ правке `normalizeErrorMessage` или разбора кадров
 * стека. Без неё расхождение счётчиков после такой правки выглядит как две
 * разные ошибки, и объяснить его через полгода нечем: старые отпечатки
 * остались в таблице, новые пошли рядом, а причина не записана нигде.
 */
export const FINGERPRINT_ALGO_VERSION = 1;

/**
 * Оси классификации.
 *
 * Их четыре, а не одна, потому что одно поле заставило бы выбирать. Ошибка
 * драйвера PostgreSQL внутри задачи распознавания одновременно относится к
 * домену `db`, к способу исполнения `job` и к стадии `recognition`, и именно
 * пересечение трёх отвечает на вопрос «где чинить». Поле `kind` вынудило бы
 * назвать одно и молча потерять два.
 */
export type ErrorSource = 'api' | 'worker' | 'web' | 'unknown';
export type ErrorExecution = 'http' | 'job' | 'process' | 'client' | 'unknown';
export type ErrorDomain =
  'db' | 'llm' | 'recognition' | 'storage' | 'auth' | 'integration' | 'application' | 'unknown';
export type ErrorSeverity = 'warn' | 'error' | 'fatal';

export interface ErrorAxes {
  readonly source: ErrorSource;
  readonly execution: ErrorExecution;
  readonly domain: ErrorDomain;
  /** Стадия конвейера (§12); `null` — событие вне конвейера. */
  readonly pipelineStage: ProcessingStage | null;
  readonly severity: ErrorSeverity;
}

export interface ErrorEventContext {
  readonly requestId?: string | undefined;
  readonly userId?: string | undefined;
  readonly route?: string | undefined;
  readonly objectId?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly jobType?: string | undefined;
  readonly jobId?: string | undefined;
  readonly attempt?: number | undefined;
  /** Оси; незаданные выводятся структурно из самой ошибки. */
  readonly source?: ErrorSource | undefined;
  readonly execution?: ErrorExecution | undefined;
  readonly domain?: ErrorDomain | undefined;
  readonly pipelineStage?: ProcessingStage | null | undefined;
  readonly severity?: ErrorSeverity | undefined;
  readonly statusCode?: number | undefined;
  /** Идентификатор события браузера: у ошибки отрисовки `requestId` нет. */
  readonly clientEventId?: string | undefined;
  /** Сколько раз клиент наблюдал ошибку до отправки отчёта. */
  readonly repeatCount?: number | undefined;
  /** Дополнительные поля образца. Уходят в БД как есть — ПДн тут запрещены. */
  readonly extra?: Record<string, unknown> | undefined;
}

/**
 * Домен по ФОРМЕ объекта ошибки, а не по списку имён классов.
 *
 * Тот же принцип, что в `classifyFailure` (`jobs/runner.ts`): перечень классов
 * — это способ, которым дефект случается второй раз. Новый класс ошибки
 * драйвера или нового клиента интеграции попал бы в `unknown` и молча выпал бы
 * из среза, а никто бы этого не заметил: на экране просто стало бы меньше строк.
 *
 * Возвращённое значение — предположение, и вызывающая сторона вправе его
 * переопределить: `runner` знает стадию конвейера, хранилище знает, что оно
 * хранилище, а из объекта ошибки этого не видно.
 */
export function classifyErrorDomain(error: unknown): ErrorDomain {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const candidate = error as Record<string, unknown>;

  // PostgreSQL: SQLSTATE — ровно пять символов из цифр и заглавных букв. Одного
  // кода мало: `code` есть и у системных ошибок Node (`ECONNREFUSED`), поэтому
  // требуется ещё хотя бы одно поле, которое кладёт именно драйвер.
  const code = candidate.code;
  if (
    typeof code === 'string' &&
    /^[0-9A-Z]{5}$/u.test(code) &&
    ('severity' in candidate ||
      'routine' in candidate ||
      'schema' in candidate ||
      'table' in candidate ||
      'constraint' in candidate)
  ) {
    return 'db';
  }

  // Порт LLM: пара «повторять ли вызов» и «прерывает ли пачку» есть только у
  // `LlmError` и его наследников (`llm/port.ts`).
  if (typeof candidate.retriable === 'boolean' && typeof candidate.stopsBatch === 'boolean') {
    return 'llm';
  }

  // Клиент внешней интеграции: названная операция и статус ответа (`RdWebError`).
  if (typeof candidate.operation === 'string' && 'status' in candidate) return 'integration';

  return 'unknown';
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

/**
 * Класс отказа.
 *
 * `name` предпочитается имени конструктора, но НЕ когда он родовой. Обёртка
 * Drizzle (`DrizzleQueryError`) собственный `name` не выставляет вовсе, и
 * унаследованный `Error` попадал в журнал классом КАЖДОЙ ошибки запроса к БД:
 * отличить нарушение уникальности от отвалившегося соединения по нему было
 * нельзя, а отпечатки таких отказов склеивались в одну строку журнала.
 */
export function errorClassOf(error: unknown): string {
  if (error instanceof Error) {
    const constructorName = error.constructor?.name;
    const generic = error.name === '' || error.name === 'Error';
    if (generic && typeof constructorName === 'string' && constructorName.length > 0) {
      return constructorName;
    }
    return error.name || constructorName || 'Error';
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
 * Цепочка `cause` от внешней ошибки к корневой.
 *
 * Порядок — как у вложенности: первым идёт то, что бросили, последним — то, что
 * на самом деле отказало.
 */
function chainOf(error: unknown): readonly unknown[] {
  const chain: unknown[] = [error];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const cause = causeOf(current);
    if (cause === undefined || cause === null) break;
    chain.push(cause);
    current = cause;
  }
  return chain;
}

/**
 * Сообщение об отказе: ПРИЧИНА первой, обёртки следом.
 *
 * Читать только верхний `message` было нельзя, и это не мелочь диагностики.
 * Drizzle оборачивает любую ошибку драйвера в `DrizzleQueryError`, у которого
 * `message` — это дамп SQL и параметров (`Failed query: insert into …`), а
 * настоящий отказ базы лежит в `cause`. Сообщение при этом усекается по
 * `MAX_MESSAGE_LENGTH`, и весь лимит съедал текст запроса: в журнале и в
 * `jobs.last_error` оставалось «упал вот такой INSERT» — без единого слова о
 * том, ПОЧЕМУ он упал. Различить нарушение уникальности, отказ CHECK и обрыв
 * соединения было нечем.
 *
 * Порядок обратный вложенности намеренно: усечение режет ХВОСТ, поэтому первой
 * обязана стоять причина, а контекст — тем, чем можно пожертвовать. Сообщения,
 * уже содержащиеся в другом звене, отбрасываются: обёртка часто пересказывает
 * причину целиком, и повтор занял бы место, которого и так мало.
 */
export function messageOfChain(error: unknown): string {
  const links = [...chainOf(error)]
    .reverse()
    .map((link) => messageOf(link).trim())
    .filter((message) => message !== '');

  const kept: string[] = [];
  for (const message of links) {
    if (kept.some((existing) => existing.includes(message))) continue;
    kept.push(message);
  }
  return kept.join(' ← ');
}

/** Поле, взятое с первого звена цепочки, где оно есть: у обёртки его нет. */
function fieldInChain(error: unknown, field: string): string | undefined {
  for (const link of chainOf(error)) {
    const value = stringField(link, field);
    if (value !== undefined) return value;
  }
  return undefined;
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
  const messageTemplate = normalizeErrorMessage(messageOfChain(error));
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

function mergeWithContext(context: ErrorEventContext | undefined): ErrorEventContext {
  const ambient = currentContext();
  if (!ambient) return context ?? {};
  return {
    ...context,
    requestId: context?.requestId ?? ambient.requestId,
    userId: context?.userId ?? ambient.userId,
    route: context?.route ?? ambient.route,
    objectId: context?.objectId ?? ambient.objectId,
    revisionId: context?.revisionId ?? ambient.revisionId,
    jobType: context?.jobType ?? ambient.jobType,
    jobId: context?.jobId ?? ambient.jobId,
    attempt: context?.attempt ?? ambient.attempt,
  };
}

/**
 * Контекст, пригодный для записи в БД.
 *
 * Проходит ту же очистку, что журнал. Без неё колонка `context` становится
 * вторым каналом утечки, более долговечным: строка в таблице живёт дольше, чем
 * ротируемый файл журнала.
 */
export function sampleContext(
  fingerprint: ErrorFingerprint,
  context: ErrorEventContext,
): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  if (fingerprint.topFrameRaw !== undefined) sample.own_frame = fingerprint.topFrameRaw;
  if (context.extra !== undefined) sample.extra = redactDeep(context.extra);
  return sample;
}

/**
 * Событие, готовое к накоплению: чистые данные без объекта ошибки.
 *
 * Объект ошибки дальше этой функции не идёт намеренно. Накопитель держит
 * события до сброса, и ссылка на `Error` удерживала бы в памяти весь замкнутый
 * на него граф — при шторме это утечка ровно в тот момент, когда процессу
 * тяжелее всего.
 */
export interface JournalEvent {
  readonly fingerprint: ErrorFingerprint;
  readonly axes: ErrorAxes;
  readonly errorCode: string | undefined;
  readonly context: ErrorEventContext;
  readonly sampleContext: Record<string, unknown>;
}

export interface PrepareEventOptions {
  readonly defaultSource: ErrorSource;
}

export function prepareJournalEvent(
  error: unknown,
  context: ErrorEventContext | undefined,
  options: PrepareEventOptions,
): JournalEvent {
  const fingerprint = fingerprintError(error);
  const merged = mergeWithContext(context);
  // Код ищется по цепочке: у обёртки Drizzle его нет, а SQLSTATE — это то,
  // по чему отказы разделяются на оси `error_code` в журнале.
  const code = fieldInChain(error, 'code');

  const axes: ErrorAxes = {
    source: merged.source ?? options.defaultSource,
    execution: merged.execution ?? (merged.jobType !== undefined ? 'job' : 'unknown'),
    domain: merged.domain ?? classifyErrorDomain(error),
    pipelineStage: merged.pipelineStage ?? null,
    severity: merged.severity ?? 'error',
  };

  return {
    fingerprint,
    axes,
    errorCode: code,
    context: merged,
    sampleContext: sampleContext(fingerprint, merged),
  };
}

/**
 * Приёмник подготовленных событий. Реализуется `journal-writer.ts`.
 *
 * Объявлен здесь, а не импортирован оттуда, чтобы модуль отпечатков не зависел
 * от модуля записи: тот тянет за собой знание о схеме БД, а этот нужен и там,
 * где БД нет.
 */
export interface JournalEventSink {
  accept(event: JournalEvent): void;
}

/** Репортер поверх накопителя: сам SQL выполняет `journal-writer.ts`. */
export class JournalErrorReporter implements ErrorReporter {
  readonly #sink: JournalEventSink;
  readonly #defaultSource: ErrorSource;

  constructor(sink: JournalEventSink, defaultSource: ErrorSource) {
    this.#sink = sink;
    this.#defaultSource = defaultSource;
  }

  report(error: unknown, context?: ErrorEventContext): Promise<void> {
    // Синхронная постановка в накопитель вместо запроса к БД: `report()`
    // вызывают из catch-блоков на горячем пути, и ждать там сети нельзя.
    // Сигнатура остаётся промисной — её ждут вызывающие и тесты.
    this.#sink.accept(prepareJournalEvent(error, context, { defaultSource: this.#defaultSource }));
    return Promise.resolve();
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
   * Досрочный сброс накопителя журнала.
   *
   * Обязателен по смыслу, хотя объявлен необязательным ради вызовов из тестов:
   * репортер только КЛАДЁТ событие в накопитель, и без сброса запись о
   * падении, которое гасит процесс, не доедет до БД никогда — то есть
   * потеряется ровно у самых тяжёлых отказов, ради которых журнал и заводили.
   */
  readonly flush?: (() => Promise<void>) | undefined;
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

  const flush = options.flush ?? ((): Promise<void> => Promise.resolve());

  const onRejection = (reason: unknown): void => {
    logger.error(
      { event: 'unhandled_rejection', error_class: errorClassOf(reason) },
      'необработанный отказ промиса',
    );
    void reporter
      .report(reason, { execution: 'process', extra: { source: 'unhandledRejection' } })
      .then(flush);
  };

  const onException = (error: unknown): void => {
    logger.fatal(
      { event: 'uncaught_exception', error_class: errorClassOf(error) },
      'необработанное исключение',
    );
    // Записать успеваем не всегда, поэтому выход отложен до завершения записи,
    // а не сразу: иначе строки в error_events не будет ровно у самых тяжёлых
    // падений.
    void reporter
      .report(error, {
        execution: 'process',
        severity: 'fatal',
        extra: { source: 'uncaughtException' },
      })
      .then(flush)
      .finally(() => {
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
