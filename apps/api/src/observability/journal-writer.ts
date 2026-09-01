/**
 * Запись журнала ошибок: накопитель в памяти и пакетный сброс (§11).
 *
 * ## Почему пакетом, а не строкой на событие
 *
 * Прежняя реализация выполняла `INSERT … ON CONFLICT` на КАЖДЫЙ отказ. Пока
 * отказы редки, это незаметно; но отказы не редки ровно тогда, когда журнал
 * нужен. При недоступности внешнего сервиса или деградации самой БД портал
 * получает тысячи одинаковых ошибок в минуту, и журнал в этот момент добавляет
 * к нагрузке на больную базу по запросу на каждую — то есть усиливает отказ,
 * который обязан диагностировать. Здесь события копятся в памяти и уходят
 * одним набором операторов раз в `flushIntervalMs`; стоимость записи перестаёт
 * зависеть от частоты отказов.
 *
 * Плата названа прямо: события, не успевшие сброситься до падения процесса,
 * теряются. Поэтому сброс вызывается и обработчиком `uncaughtException` до
 * выхода, и при штатной остановке, а необратимо потерянное считается метрикой
 * `observability_dropped_total`, а не замалчивается.
 *
 * ## Почему идентификатор проблемы выводится из отпечатка
 *
 * Сброс не обёрнут в транзакцию, и это осознанно: писатель должен работать
 * поверх простого `SqlExecutor` (тот же интерфейс использует pglite в тестах),
 * а транзакция на пуле означала бы аренду соединения на время записи журнала.
 * Вместо этого каждый оператор сделан идемпотентным, а идентификатор новой
 * проблемы получается детерминированным преобразованием отпечатка. Два
 * процесса, одновременно встретившие новую ошибку, вычисляют ОДИН И ТОТ ЖЕ
 * идентификатор, и оба `INSERT … ON CONFLICT DO NOTHING` сходятся к одной
 * строке. При случайном `gen_random_uuid()` проигравший гонку процесс оставил
 * бы проблему-сироту без единой сигнатуры.
 *
 * Следствие, которое важно понимать: смена `FINGERPRINT_ALGO_VERSION` заводит
 * НОВУЮ проблему. Иначе и быть не может — сопоставить отпечатки, посчитанные
 * разными алгоритмами, автоматически нечем. Ценность разделения проблемы и
 * сигнатуры в другом: объединить их вручную можно без потери истории, тогда как
 * при одной таблице история просто разошлась бы надвое молча.
 *
 * ## Почему прореживание примеров решается в SQL, а не в памяти
 *
 * Условие «пример этой комбинации уже писали недавно» обязано быть общим для
 * всех процессов: два воркера с памятью на каждый писали бы вдвое больше, три —
 * втрое. Условие проверяется в самом `INSERT … WHERE NOT EXISTS`, и оно же
 * покрывает правило «новая комбинация пишется сразу»: у новой комбинации
 * недавних строк нет по определению.
 */
import type { Logger } from 'pino';
import {
  FINGERPRINT_ALGO_VERSION,
  NoopErrorReporter,
  SentryErrorReporter,
  JournalErrorReporter,
  type ErrorAxes,
  type ErrorEventContext,
  type ErrorFingerprint,
  type ErrorReporter,
  type ErrorSource,
  type JournalEvent,
  type JournalEventSink,
  type SqlExecutor,
} from './errors.js';

/**
 * Служебная проблема-накопитель переполнения (заводится миграцией 0022).
 *
 * События сверх лимита новых сигнатур учитываются здесь счётчиком. Молча
 * отбрасывать их нельзя: «журнал пуст» и «журнал захлебнулся» — разные
 * утверждения, и второе обязано быть видно.
 */
export const OVERFLOW_ISSUE_ID = '00000000-0000-4000-8000-0000000e0001';

const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 300_000;
const DEFAULT_NEW_SIGNATURE_LIMIT = 500;
/** Потолок накопителя: защита от неограниченного роста между сбросами. */
const DEFAULT_MAX_PENDING_GROUPS = 5_000;
const TITLE_MAX_LENGTH = 300;

/** Приёмник метрик; объявлен здесь по той же причине, что `HttpMetricsSink`. */
export interface JournalMetricsSink {
  observeJournalDropped(count: number): void;
}

export interface ErrorJournalWriterOptions {
  readonly sql: SqlExecutor;
  readonly logger: Logger;
  /** Источник по умолчанию: `api` или `worker`. */
  readonly source: ErrorSource;
  readonly release?: string | undefined;
  readonly flushIntervalMs?: number | undefined;
  readonly sampleIntervalMs?: number | undefined;
  readonly newSignatureLimitPerHour?: number | undefined;
  readonly maxPendingGroups?: number | undefined;
  readonly metrics?: JournalMetricsSink | undefined;
}

interface PendingGroup {
  readonly fingerprint: ErrorFingerprint;
  readonly axes: ErrorAxes;
  readonly bucketAt: Date;
  count: number;
  /** Последнее событие группы — кандидат в примеры. */
  sample: SampleCandidate;
}

interface SampleCandidate {
  readonly context: ErrorEventContext;
  readonly sampleContext: Record<string, unknown>;
  readonly errorCode: string | undefined;
}

/** Начало часа в UTC: ключ бакета обязан совпадать у всех процессов. */
function hourBucket(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()),
  );
}

/**
 * Идентификатор проблемы из отпечатка.
 *
 * Отпечаток — sha1 в hex (40 символов), из них берутся первые 32 и
 * расставляются дефисы. Поля версии и варианта выставляются как у UUIDv4, иначе
 * значение не пройдёт проверку типа `uuid` в PostgreSQL для части входов.
 * Криптостойкость здесь не нужна и не подразумевается: требуется только
 * одинаковый результат у всех процессов на одном входе.
 */
export function issueIdForFingerprint(fingerprint: string): string {
  const hex = fingerprint
    .replace(/[^0-9a-f]/giu, '')
    .padEnd(32, '0')
    .slice(0, 32)
    .toLowerCase();
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function titleFor(fingerprint: ErrorFingerprint): string {
  return `${fingerprint.errorClass}: ${fingerprint.messageTemplate}`.slice(0, TITLE_MAX_LENGTH);
}

/** Ключ группы: одна строка бакета — одна группа. */
function groupKey(fingerprint: string, bucketAt: Date, axes: ErrorAxes, release: string): string {
  return [
    fingerprint,
    bucketAt.toISOString(),
    release,
    axes.source,
    axes.execution,
    axes.domain,
    axes.pipelineStage ?? 'none',
    axes.severity,
  ].join('|');
}

const SELECT_KNOWN_SIGNATURES = `
  SELECT fingerprint, issue_id FROM error_signatures WHERE fingerprint = ANY($1::text[])
`;

const COUNT_NEW_SIGNATURES_THIS_HOUR = `
  SELECT count(*)::int AS taken
    FROM error_signatures
   WHERE first_seen_at >= date_trunc('hour', now())
`;

/**
 * Заведение проблемы и сигнатуры одним оператором.
 *
 * `ON CONFLICT DO NOTHING` на обеих вставках: одновременный сброс в двух
 * процессах обязан сойтись к одной строке, а не упасть.
 */
const INSERT_ISSUE_WITH_SIGNATURE = `
  WITH issue AS (
    INSERT INTO error_issues (
      id, title, source, execution, domain, pipeline_stage, severity,
      first_seen_at, last_seen_at, first_release, last_release
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, $8)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO error_signatures (
    fingerprint, algo_version, issue_id, error_class, message_template, top_frame, source
  )
  VALUES ($9, $10, $1, $11, $12, $13, $3)
  ON CONFLICT (fingerprint) DO NOTHING
`;

/**
 * Инкремент бакетов пакетом.
 *
 * `unnest` вместо строки-на-запрос: при сбросе групп бывает несколько десятков,
 * и отдельный round-trip на каждую вернул бы ту самую поштучную запись, ради
 * ухода от которой всё и затевалось.
 */
const UPSERT_STATS = `
  INSERT INTO error_stats_hourly (
    issue_id, bucket_at, release, source, execution, domain, pipeline_stage, severity, count
  )
  SELECT * FROM unnest(
    $1::uuid[], $2::timestamptz[], $3::text[], $4::text[],
    $5::text[], $6::text[], $7::text[], $8::text[], $9::bigint[]
  )
  ON CONFLICT (issue_id, bucket_at, release, source, execution, domain, pipeline_stage, severity)
  DO UPDATE SET count = error_stats_hourly.count + excluded.count
`;

/**
 * Обновление проблемы и переоткрытие регрессии.
 *
 * Закрытая проблема, появившаяся снова, возвращается в `new` — но `resolution`,
 * `root_cause` и `fixed_in_release` НЕ стираются: «чем это чинили в прошлый
 * раз» и есть то немногое, ради чего журнал хранят год. Факт переоткрытия
 * возвращается вызывающему, чтобы он записал действие `reopen`.
 */
const TOUCH_ISSUE = `
  UPDATE error_issues i
     SET last_seen_at = greatest(i.last_seen_at, $2),
         last_release = coalesce($3, i.last_release),
         first_release = coalesce(i.first_release, $3),
         status = CASE WHEN i.status = 'resolved' THEN 'new' ELSE i.status END,
         resolved_at = CASE WHEN i.status = 'resolved' THEN NULL ELSE i.resolved_at END,
         resolved_by = CASE WHEN i.status = 'resolved' THEN NULL ELSE i.resolved_by END
    FROM error_issues prev
   WHERE i.id = $1 AND prev.id = i.id
  RETURNING (prev.status = 'resolved') AS reopened
`;

const INSERT_REOPEN_ACTION = `
  INSERT INTO error_issue_actions (issue_id, actor_user_id, action, payload)
  VALUES ($1, NULL, 'reopen', jsonb_build_object('reason', 'regression', 'release', $2::text))
`;

/**
 * Пример пишется, если такой комбинации давно не было.
 *
 * Одно условие покрывает обе половины политики: новая комбинация
 * (release, route, domain, стадия, код ошибки) не найдёт недавних строк и
 * запишется сразу, а повтор той же комбинации — не чаще интервала.
 * `IS NOT DISTINCT FROM` вместо `=`, потому что почти все поля обнуляемы, а
 * `NULL = NULL` в SQL не истинно: со сравнением через `=` условие «недавно уже
 * писали» никогда бы не выполнилось и прореживание не работало бы вовсе.
 */
const INSERT_SAMPLE = `
  INSERT INTO error_samples (
    issue_id, fingerprint, at, source, execution, domain, pipeline_stage, severity,
    release, request_id, client_event_id, user_id, route, status_code, error_code,
    object_id, folder_id, job_id, job_type, attempt, repeat_count, context
  )
  SELECT $1, $2, now(), $3, $4, $5, $6, $7,
         $8, $9, $10, $11::uuid, $12, $13, $14,
         $15::uuid, $16::uuid, $17::uuid, $18, $19, $20, $21::jsonb
   WHERE NOT EXISTS (
     SELECT 1 FROM error_samples s
      WHERE s.issue_id = $1
        AND s.at > now() - make_interval(secs => $22::double precision)
        AND s.release IS NOT DISTINCT FROM $8
        AND s.route IS NOT DISTINCT FROM $12
        AND s.domain = $5
        AND s.pipeline_stage IS NOT DISTINCT FROM $6
        AND s.error_code IS NOT DISTINCT FROM $14
   )
`;

const COUNT_OVERFLOW = `
  INSERT INTO error_stats_hourly (issue_id, bucket_at, count)
  VALUES ($1, $2, $3)
  ON CONFLICT (issue_id, bucket_at, release, source, execution, domain, pipeline_stage, severity)
  DO UPDATE SET count = error_stats_hourly.count + excluded.count
`;

export class ErrorJournalWriter implements JournalEventSink {
  readonly #options: ErrorJournalWriterOptions;
  readonly #sql: SqlExecutor;
  readonly #logger: Logger;
  #pending = new Map<string, PendingGroup>();
  #dropped = 0;
  #timer: NodeJS.Timeout | null = null;
  #flushing: Promise<void> | null = null;
  #stopped = false;

  constructor(options: ErrorJournalWriterOptions) {
    this.#options = options;
    this.#sql = options.sql;
    this.#logger = options.logger;
  }

  get #release(): string {
    return this.#options.release ?? 'unknown';
  }

  accept(event: JournalEvent): void {
    const bucketAt = hourBucket(new Date());
    const key = groupKey(event.fingerprint.fingerprint, bucketAt, event.axes, this.#release);
    const existing = this.#pending.get(key);
    const repeat = event.context.repeatCount ?? 1;

    if (existing !== undefined) {
      existing.count += repeat;
      // Кандидат в примеры заменяется последним: свежий контекст полезнее
      // первого, а первый уже записан примером при первой встрече проблемы.
      existing.sample = {
        context: event.context,
        sampleContext: event.sampleContext,
        errorCode: event.errorCode,
      };
      return;
    }

    if (this.#pending.size >= (this.#options.maxPendingGroups ?? DEFAULT_MAX_PENDING_GROUPS)) {
      // Накопитель переполнен — потеря считается, а не замалчивается.
      this.#dropped += repeat;
      return;
    }

    this.#pending.set(key, {
      fingerprint: event.fingerprint,
      axes: event.axes,
      bucketAt,
      count: repeat,
      sample: {
        context: event.context,
        sampleContext: event.sampleContext,
        errorCode: event.errorCode,
      },
    });
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#stopped) return;
    const interval = this.#options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.#timer = setTimeout(() => {
      void this.flush().finally(() => {
        this.#schedule();
      });
    }, interval);
    // `unref`: незавершённый таймер журнала не должен удерживать процесс.
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await this.flush();
  }

  /**
   * Сброс накопителя.
   *
   * Никогда не бросает: его зовут из обработчика необработанного исключения и
   * из закрытия приложения, где исключение только скрыло бы исходную причину.
   * Параллельные вызовы объединяются — иначе таймер и остановка могли бы
   * записать один набор дважды.
   */
  async flush(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing;
    this.#flushing = this.#flushOnce().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async #flushOnce(): Promise<void> {
    const groups = [...this.#pending.values()];
    const dropped = this.#dropped;
    this.#pending = new Map();
    this.#dropped = 0;

    if (dropped > 0) {
      this.#options.metrics?.observeJournalDropped(dropped);
      this.#logger.warn(
        { event: 'journal_overflow', dropped },
        'накопитель журнала переполнен: часть событий не записана',
      );
    }
    if (groups.length === 0) return;

    try {
      await this.#write(groups);
    } catch (error) {
      // Писатель не имеет права бросать: его вызывают из catch-блоков. Запись
      // о собственном сбое идёт только в лог — попытка зарегистрировать её в
      // той же БД зациклила бы отказ.
      this.#options.metrics?.observeJournalDropped(groups.reduce((sum, g) => sum + g.count, 0));
      this.#logger.error(
        { event: 'journal_write_failed', groups: groups.length, err: error },
        'не удалось записать журнал ошибок',
      );
    }
  }

  async #write(groups: readonly PendingGroup[]): Promise<void> {
    const issueByFingerprint = await this.#resolveIssues(groups);

    const stats = groups.map((group) => ({
      group,
      issueId: issueByFingerprint.get(group.fingerprint.fingerprint) ?? OVERFLOW_ISSUE_ID,
    }));

    await this.#upsertStats(stats);

    for (const { group, issueId } of stats) {
      if (issueId === OVERFLOW_ISSUE_ID) continue;
      await this.#touchIssue(issueId, group);
      await this.#writeSample(issueId, group);
    }
  }

  /**
   * Сопоставляет отпечатки с проблемами, заводя недостающие в пределах лимита.
   *
   * Лимит считается в БД, а не в памяти процесса: поток уникальных сигнатур
   * приходит на все процессы сразу, и счётчик на каждый означал бы лимит,
   * умноженный на их число.
   */
  async #resolveIssues(groups: readonly PendingGroup[]): Promise<Map<string, string>> {
    const fingerprints = [...new Set(groups.map((g) => g.fingerprint.fingerprint))];
    const known = await this.#sql.query(SELECT_KNOWN_SIGNATURES, [fingerprints]);

    const result = new Map<string, string>();
    for (const row of known.rows as readonly { fingerprint: string; issue_id: string }[]) {
      result.set(row.fingerprint, row.issue_id);
    }

    const unknown = groups.filter((g) => !result.has(g.fingerprint.fingerprint));
    if (unknown.length === 0) return result;

    const limit = this.#options.newSignatureLimitPerHour ?? DEFAULT_NEW_SIGNATURE_LIMIT;
    const taken = await this.#sql.query(COUNT_NEW_SIGNATURES_THIS_HOUR);
    const used = Number((taken.rows[0] as { taken: number } | undefined)?.taken ?? 0);
    let budget = Math.max(0, limit - used);

    const seen = new Set<string>();
    for (const group of unknown) {
      const fingerprint = group.fingerprint.fingerprint;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      if (budget <= 0) {
        this.#logger.warn(
          { event: 'journal_signature_limit', limit },
          'достигнут лимит новых сигнатур за час: события учитываются суммарно',
        );
        continue;
      }
      budget -= 1;

      const issueId = issueIdForFingerprint(fingerprint);
      await this.#sql.query(INSERT_ISSUE_WITH_SIGNATURE, [
        issueId,
        titleFor(group.fingerprint),
        group.axes.source,
        group.axes.execution,
        group.axes.domain,
        group.axes.pipelineStage,
        group.axes.severity,
        this.#options.release ?? null,
        fingerprint,
        FINGERPRINT_ALGO_VERSION,
        group.fingerprint.errorClass,
        group.fingerprint.messageTemplate,
        group.fingerprint.topFrame ?? null,
      ]);
      result.set(fingerprint, issueId);
    }

    return result;
  }

  async #upsertStats(
    entries: readonly { readonly group: PendingGroup; readonly issueId: string }[],
  ): Promise<void> {
    const regular = entries.filter((e) => e.issueId !== OVERFLOW_ISSUE_ID);
    const overflow = entries.filter((e) => e.issueId === OVERFLOW_ISSUE_ID);

    if (regular.length > 0) {
      await this.#sql.query(UPSERT_STATS, [
        regular.map((e) => e.issueId),
        regular.map((e) => e.group.bucketAt.toISOString()),
        regular.map(() => this.#release),
        regular.map((e) => e.group.axes.source),
        regular.map((e) => e.group.axes.execution),
        regular.map((e) => e.group.axes.domain),
        regular.map((e) => e.group.axes.pipelineStage ?? 'none'),
        regular.map((e) => e.group.axes.severity),
        regular.map((e) => String(e.group.count)),
      ]);
    }

    for (const entry of overflow) {
      await this.#sql.query(COUNT_OVERFLOW, [
        OVERFLOW_ISSUE_ID,
        entry.group.bucketAt.toISOString(),
        String(entry.group.count),
      ]);
    }
  }

  async #touchIssue(issueId: string, group: PendingGroup): Promise<void> {
    const touched = await this.#sql.query(TOUCH_ISSUE, [
      issueId,
      new Date().toISOString(),
      this.#options.release ?? null,
    ]);
    const reopened = (touched.rows[0] as { reopened: boolean } | undefined)?.reopened === true;
    if (!reopened) return;

    await this.#sql.query(INSERT_REOPEN_ACTION, [issueId, this.#options.release ?? null]);
    this.#logger.warn(
      {
        event: 'error_issue_reopened',
        issue_id: issueId,
        fingerprint: group.fingerprint.fingerprint,
      },
      'закрытая ошибка появилась снова',
    );
  }

  async #writeSample(issueId: string, group: PendingGroup): Promise<void> {
    const { context, sampleContext, errorCode } = group.sample;
    const intervalSeconds = (this.#options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS) / 1000;

    await this.#sql.query(INSERT_SAMPLE, [
      issueId,
      group.fingerprint.fingerprint,
      group.axes.source,
      group.axes.execution,
      group.axes.domain,
      group.axes.pipelineStage,
      group.axes.severity,
      this.#options.release ?? null,
      context.requestId ?? null,
      context.clientEventId ?? null,
      context.userId ?? null,
      context.route ?? null,
      context.statusCode ?? null,
      errorCode ?? null,
      context.objectId ?? null,
      context.folderId ?? null,
      context.jobId ?? null,
      context.jobType ?? null,
      context.attempt ?? null,
      context.repeatCount ?? 1,
      JSON.stringify(sampleContext),
      intervalSeconds,
    ]);
  }
}

export interface CreateErrorReporterOptions {
  readonly kind: 'db' | 'sentry';
  readonly sql: SqlExecutor;
  readonly logger: Logger;
  readonly source: ErrorSource;
  readonly sentryDsn?: string | undefined;
  readonly environment?: string | undefined;
  readonly release?: string | undefined;
  readonly flushIntervalMs?: number | undefined;
  readonly sampleIntervalMs?: number | undefined;
  readonly newSignatureLimitPerHour?: number | undefined;
  readonly metrics?: JournalMetricsSink | undefined;
}

/**
 * Репортер вместе с его накопителем.
 *
 * Накопитель возвращается наружу намеренно: без доступа к `flush()` и `stop()`
 * приложение не сможет дописать журнал при остановке, а `report()` создавал бы
 * впечатление записи, которой не было.
 */
export interface ErrorReporting {
  readonly reporter: ErrorReporter;
  readonly writer: ErrorJournalWriter;
}

export function createErrorReporting(options: CreateErrorReporterOptions): ErrorReporting {
  const writer = new ErrorJournalWriter({
    sql: options.sql,
    logger: options.logger,
    source: options.source,
    release: options.release,
    flushIntervalMs: options.flushIntervalMs,
    sampleIntervalMs: options.sampleIntervalMs,
    newSignatureLimitPerHour: options.newSignatureLimitPerHour,
    metrics: options.metrics,
  });
  writer.start();

  const journal = new JournalErrorReporter(writer, options.source);
  if (options.kind !== 'sentry') return { reporter: journal, writer };

  if (options.sentryDsn === undefined || options.sentryDsn.length === 0) {
    // Проверка окружения это уже отвергает; здесь остаётся защита от того,
    // чтобы отсутствие DSN не превратилось в потерю регистрации ошибок.
    options.logger.warn(
      { event: 'sentry_dsn_missing' },
      'ERROR_REPORTER=sentry без SENTRY_DSN: используется запись в БД',
    );
    return { reporter: journal, writer };
  }

  return {
    reporter: new SentryErrorReporter({
      dsn: options.sentryDsn,
      logger: options.logger,
      delegate: journal,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.release === undefined ? {} : { release: options.release }),
    }),
    writer,
  };
}

export { NoopErrorReporter };
