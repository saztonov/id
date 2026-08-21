/**
 * Тайминги запросов к БД (§11, `SLOW_QUERY_MS`).
 *
 * Инструментируется пул `pg`, а не построитель запросов: логгер Drizzle
 * вызывается до выполнения и длительности не знает, а нас интересует именно она.
 * Обёртка накладывается и на клиентов, выданных `pool.connect()`, иначе запросы
 * внутри транзакций остались бы без таймингов.
 *
 * В лог идёт нормализованный SQL БЕЗ значений параметров: в параметрах ПДн —
 * ФИО подписантов, распознанный текст страниц. По той же причине не логируется
 * текст ошибки PostgreSQL: он содержит значение ключа («Key (dedupe_key)=(…)»).
 * Остаются класс и код ошибки — их достаточно, чтобы отличить конфликт
 * уникальности от нарушения FK.
 *
 * Модуль не импортирует `pg`: инструментируется всё, у чего есть `query`.
 * Это же делает его пригодным для воркера и для тестового pglite.
 */
import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';

/** Приёмник метрик (реализуется `metrics.ts`); см. пояснение в `request-log.ts`. */
export interface DbMetricsSink {
  observeDbQuery(sample: {
    readonly operation: string;
    readonly durationMs: number;
    readonly outcome: 'ok' | 'error';
  }): void;
}

/**
 * Приёмник медленных операций (реализуется `anomalies.ts`).
 *
 * Объявлен здесь, а не импортирован, по той же причине, что `DbMetricsSink`:
 * модуль таймингов не должен тянуть за собой знание о схеме БД, иначе он
 * перестанет годиться процессу без неё.
 */
export interface SlowQuerySink {
  recordSlow(sample: {
    readonly kind: 'sql';
    readonly target: string;
    readonly durationMs: number;
    readonly thresholdMs: number;
  }): void;
}

export interface DbTimingOptions {
  readonly logger: Logger;
  readonly slowQueryMs: number;
  readonly metrics?: DbMetricsSink;
  readonly maxSqlLength?: number;
  /** Быстрые запросы писать на debug. По умолчанию да — уровень их отфильтрует. */
  readonly logFastQueries?: boolean;
  /**
   * Куда складывать превышения порога.
   *
   * Необязателен: без него медленный запрос по-прежнему попадает в лог и в
   * гистограмму, просто не копится в почасовой счётчик.
   */
  readonly slowSink?: SlowQuerySink | undefined;
}

interface Resolved {
  readonly logger: Logger;
  readonly slowQueryMs: number;
  readonly metrics: DbMetricsSink | undefined;
  readonly maxSqlLength: number;
  readonly logFastQueries: boolean;
  readonly slowSink: SlowQuerySink | undefined;
}

/**
 * Метка запросов самой наблюдаемости.
 *
 * Их тайминги не снимаются: сброс счётчиков идёт в ту же базу, и медленная
 * запись статистики порождала бы запись о медленной записи статистики. В
 * спокойное время это незаметно, в инциденте — удваивает поток.
 */
const OBSERVABILITY_MARKER = '/* observability */';

const DEFAULT_MAX_SQL_LENGTH = 400;

/**
 * Операции, которые допускаются как метка метрики.
 *
 * Метка обязана иметь ограниченное множество значений, поэтому всё незнакомое
 * сводится к `OTHER`, а не подставляется как есть.
 */
const KNOWN_OPERATIONS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'WITH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'SHOW',
  'EXPLAIN',
  'COPY',
  'CALL',
  'DO',
  'LOCK',
  'LISTEN',
  'NOTIFY',
  'TRUNCATE',
  'CREATE',
  'ALTER',
  'DROP',
  'REFRESH',
  'VACUUM',
  'ANALYZE',
  'PREPARE',
  'DEALLOCATE',
  'DISCARD',
]);

export function sqlOperation(sql: string): string {
  const match = /[A-Za-z]+/.exec(sql);
  if (!match) return 'OTHER';
  const word = match[0].toUpperCase();
  return KNOWN_OPERATIONS.has(word) ? word : 'OTHER';
}

/**
 * Нормализация SQL: снимаются комментарии, строковые литералы и числа.
 *
 * Двойные кавычки не трогаем — в PostgreSQL это идентификаторы, а не значения;
 * без имён таблиц запись бесполезна. Позиционные параметры `$1` сохраняются:
 * они и есть доказательство того, что значение в лог не попало.
 */
export function normalizeSql(sql: string, maxLength = DEFAULT_MAX_SQL_LENGTH): string {
  let out = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, '?')
    .replace(/'(?:''|[^'])*'/g, '?')
    // Число, не приклеенное к идентификатору: `LIMIT 50` — значение,
    // `sha256` и `$1` — нет.
    .replace(/(?<![\w$])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, '?')
    .replace(/\s+/g, ' ')
    .trim();

  // Длина списка IN не должна размножать варианты одного и того же запроса.
  out = out.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)');

  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name;
  return typeof error;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function extractSql(argument: unknown): string {
  if (typeof argument === 'string') return argument;
  if (typeof argument === 'object' && argument !== null) {
    const text = (argument as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Провал передаётся отдельным флагом, а не «ошибка не `undefined`»: промис
 * может быть отвергнут значением `undefined`, и такой запрос учёлся бы удачным.
 */
function report(
  options: Resolved,
  sql: string,
  startedAt: number,
  failed: boolean,
  error: unknown,
): void {
  // Запросы самой наблюдаемости не измеряются: см. OBSERVABILITY_MARKER.
  if (sql.includes(OBSERVABILITY_MARKER)) return;

  const durationMs = Math.round(performance.now() - startedAt);
  const operation = sqlOperation(sql);

  options.metrics?.observeDbQuery({
    operation,
    durationMs,
    outcome: failed ? 'error' : 'ok',
  });

  if (failed) {
    options.logger.warn(
      {
        event: 'db_query_failed',
        operation,
        sql: normalizeSql(sql, options.maxSqlLength),
        duration_ms: durationMs,
        error_class: errorClass(error),
        error_code: errorCode(error),
      },
      'запрос к БД завершился ошибкой',
    );
    return;
  }

  if (durationMs >= options.slowQueryMs) {
    options.slowSink?.recordSlow({
      kind: 'sql',
      target: normalizeSql(sql, options.maxSqlLength),
      durationMs,
      thresholdMs: options.slowQueryMs,
    });
    options.logger.warn(
      {
        event: 'db_query_slow',
        operation,
        sql: normalizeSql(sql, options.maxSqlLength),
        duration_ms: durationMs,
        threshold_ms: options.slowQueryMs,
      },
      'медленный запрос к БД',
    );
    return;
  }

  // Нормализация не бесплатна, а на debug строка чаще всего никуда не пойдёт.
  if (options.logFastQueries && options.logger.isLevelEnabled('debug')) {
    options.logger.debug(
      {
        event: 'db_query',
        operation,
        sql: normalizeSql(sql, options.maxSqlLength),
        duration_ms: durationMs,
      },
      'запрос к БД',
    );
  }
}

interface RawQueryable {
  query: (...args: unknown[]) => unknown;
}

/** Клиент из пула переиспользуется: без отметки обёртка легла бы на него дважды. */
const instrumented = new WeakSet<object>();

function instrumentQueryable(target: object, options: Resolved): void {
  if (instrumented.has(target)) return;
  const raw = target as unknown as RawQueryable;
  if (typeof raw.query !== 'function') return;
  instrumented.add(target);

  const original = raw.query.bind(target);

  raw.query = (...args: unknown[]): unknown => {
    // Колбэчная форма pg промиса не возвращает — оборачивать нечего.
    if (typeof args[args.length - 1] === 'function') return original(...args);

    const sql = extractSql(args[0]);
    const startedAt = performance.now();
    let result: unknown;
    try {
      result = original(...args);
    } catch (error) {
      report(options, sql, startedAt, true, error);
      throw error;
    }
    if (!isPromise(result)) return result;

    return result.then(
      (value) => {
        report(options, sql, startedAt, false, undefined);
        return value;
      },
      (error: unknown) => {
        report(options, sql, startedAt, true, error);
        throw error;
      },
    );
  };
}

/**
 * Инструментирует пул `pg` (или совместимый объект) на месте.
 *
 * Возвращает тот же объект: пул уже роздан по репозиториям, подменять ссылку
 * поздно.
 */
export function instrumentPool<T extends object>(pool: T, options: DbTimingOptions): T {
  const resolved: Resolved = {
    logger: options.logger,
    slowQueryMs: options.slowQueryMs,
    metrics: options.metrics,
    maxSqlLength: options.maxSqlLength ?? DEFAULT_MAX_SQL_LENGTH,
    logFastQueries: options.logFastQueries ?? true,
    slowSink: options.slowSink,
  };

  instrumentQueryable(pool, resolved);

  const raw = pool as unknown as { connect?: unknown };
  if (typeof raw.connect === 'function') {
    const connect = (raw.connect as (...args: unknown[]) => unknown).bind(pool);
    raw.connect = (...args: unknown[]): unknown => {
      if (typeof args[0] === 'function') {
        const callback = args[0] as (...callbackArgs: unknown[]) => void;
        return connect((...callbackArgs: unknown[]) => {
          const client = callbackArgs[1];
          if (typeof client === 'object' && client !== null) {
            instrumentQueryable(client, resolved);
          }
          callback(...callbackArgs);
        });
      }
      const result = connect(...args);
      if (!isPromise(result)) return result;
      return result.then((client) => {
        if (typeof client === 'object' && client !== null) {
          instrumentQueryable(client, resolved);
        }
        return client;
      });
    };
  }

  return pool;
}

/**
 * Логгер запросов для Drizzle.
 *
 * Штатный логгер Drizzle печатает значения параметров — то есть ПДн. Этот пишет
 * нормализованный SQL и только количество параметров. Длительности здесь нет,
 * она снимается обёрткой пула.
 */
export function createDrizzleLogger(
  logger: Logger,
  options: { readonly maxSqlLength?: number } = {},
): { logQuery(query: string, params: unknown[]): void } {
  const maxSqlLength = options.maxSqlLength ?? DEFAULT_MAX_SQL_LENGTH;
  return {
    logQuery(query, params) {
      if (!logger.isLevelEnabled('debug')) return;
      logger.debug(
        {
          event: 'db_query_prepared',
          operation: sqlOperation(query),
          sql: normalizeSql(query, maxSqlLength),
          params_count: params.length,
        },
        'запрос к БД подготовлен',
      );
    },
  };
}
