/**
 * Счётчики значимых отказов и медленных операций (§11, ADR-0010, поток B).
 *
 * ## Почему накопитель, а не запись на событие
 *
 * Обе величины интересны всплеском, а не отдельным случаем, и обе приходят
 * потоком ровно тогда, когда системе тяжелее всего: 429 сыплются при переборе,
 * медленные запросы — при деградации базы. Запись на событие означала бы, что
 * наблюдаемость добавляет нагрузку пропорционально проблеме, которую
 * наблюдает.
 *
 * ## Почему свои запросы не измеряются
 *
 * Сброс идёт в ту же базу, тайминги которой снимает `db-timing`. Без пометки
 * медленная запись статистики породила бы запись о медленной записи
 * статистики — обратная связь, которая в спокойное время незаметна, а в
 * инциденте удваивает поток. Поэтому каждый оператор помечен комментарием
 * `OBSERVABILITY_SQL_MARKER`, а инструментирование пула такие запросы
 * пропускает.
 *
 * ## Потери считаются, а не замалчиваются
 *
 * Накопитель ограничен по размеру: неограниченный означал бы, что всплеск
 * уникальных маршрутов (сканер путей) съедает память процесса. Переполнение
 * увеличивает `observability_dropped_total` — ту же метрику, что и журнал
 * ошибок: с точки зрения читателя это одна и та же беда.
 */
import type { Logger } from 'pino';
import type { SqlExecutor } from './errors.js';
import type { JournalMetricsSink } from './journal-writer.js';

/**
 * Метка своих запросов.
 *
 * Комментарий в тексте SQL, а не флаг в коде: инструментирование пула видит
 * только текст запроса, и передать ему что-то мимо текста нечем.
 */
export const OBSERVABILITY_SQL_MARKER = '/* observability */';

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
/** Потолок групп: защита от всплеска уникальных маршрутов. */
const DEFAULT_MAX_GROUPS = 2_000;
const MAX_TARGET_LENGTH = 300;

/** Статусы, за которыми имеет смысл следить. Остальные 4xx — опечатка клиента. */
export const WATCHED_CLIENT_STATUSES: ReadonlySet<number> = new Set([401, 403, 409, 412, 429]);

export type SlowOperationKind = 'http' | 'sql' | 'external';

export interface AnomalySample {
  readonly route: string;
  readonly statusCode: number;
  readonly problemSlug: string;
}

export interface SlowSample {
  readonly kind: SlowOperationKind;
  readonly target: string;
  readonly durationMs: number;
  readonly thresholdMs: number;
  readonly requestId?: string | undefined;
}

interface AnomalyGroup {
  readonly bucketAt: Date;
  readonly route: string;
  readonly statusCode: number;
  readonly problemSlug: string;
  count: number;
}

interface SlowGroup {
  readonly bucketAt: Date;
  readonly kind: SlowOperationKind;
  readonly target: string;
  count: number;
  maxMs: number;
  sumMs: number;
  thresholdMs: number;
  requestId: string | undefined;
}

function hourBucket(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()),
  );
}

const UPSERT_ANOMALIES = `${OBSERVABILITY_SQL_MARKER}
  INSERT INTO http_anomaly_stats_hourly (bucket_at, route, status_code, problem_slug, count)
  SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::int[], $4::text[], $5::bigint[])
  ON CONFLICT (bucket_at, route, status_code, problem_slug)
  DO UPDATE SET count = http_anomaly_stats_hourly.count + excluded.count
`;

const UPSERT_SLOW = `${OBSERVABILITY_SQL_MARKER}
  INSERT INTO slow_operations (
    kind, target, bucket_at, count, max_ms, sum_ms, threshold_ms, sample_request_id
  )
  SELECT * FROM unnest(
    $1::text[], $2::text[], $3::timestamptz[], $4::bigint[], $5::int[], $6::bigint[], $7::int[],
    $8::text[]
  )
  ON CONFLICT (kind, target, bucket_at)
  DO UPDATE SET count = slow_operations.count + excluded.count,
                max_ms = greatest(slow_operations.max_ms, excluded.max_ms),
                sum_ms = slow_operations.sum_ms + excluded.sum_ms,
                threshold_ms = excluded.threshold_ms,
                sample_request_id =
                  COALESCE(slow_operations.sample_request_id, excluded.sample_request_id)
`;

export interface AnomalyWriterOptions {
  readonly sql: SqlExecutor;
  readonly logger: Logger;
  readonly flushIntervalMs?: number | undefined;
  readonly maxGroups?: number | undefined;
  readonly metrics?: JournalMetricsSink | undefined;
}

export class AnomalyWriter {
  readonly #options: AnomalyWriterOptions;
  #anomalies = new Map<string, AnomalyGroup>();
  #slow = new Map<string, SlowGroup>();
  #dropped = 0;
  #timer: NodeJS.Timeout | null = null;
  #flushing: Promise<void> | null = null;
  #stopped = false;

  constructor(options: AnomalyWriterOptions) {
    this.#options = options;
  }

  /** Значимый клиентский отказ. Прочие статусы отбрасываются вызывающим. */
  recordAnomaly(sample: AnomalySample): void {
    const bucketAt = hourBucket(new Date());
    const route = sample.route.slice(0, MAX_TARGET_LENGTH);
    const key = `${bucketAt.toISOString()}|${route}|${sample.statusCode}|${sample.problemSlug}`;

    const existing = this.#anomalies.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    if (this.#anomalies.size >= (this.#options.maxGroups ?? DEFAULT_MAX_GROUPS)) {
      this.#dropped += 1;
      return;
    }
    this.#anomalies.set(key, {
      bucketAt,
      route,
      statusCode: sample.statusCode,
      problemSlug: sample.problemSlug,
      count: 1,
    });
  }

  /** Операция, превысившая свой порог. */
  recordSlow(sample: SlowSample): void {
    const bucketAt = hourBucket(new Date());
    const target = sample.target.slice(0, MAX_TARGET_LENGTH);
    const key = `${bucketAt.toISOString()}|${sample.kind}|${target}`;

    const existing = this.#slow.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      existing.sumMs += sample.durationMs;
      existing.maxMs = Math.max(existing.maxMs, sample.durationMs);
      existing.thresholdMs = sample.thresholdMs;
      existing.requestId ??= sample.requestId;
      return;
    }
    if (this.#slow.size >= (this.#options.maxGroups ?? DEFAULT_MAX_GROUPS)) {
      this.#dropped += 1;
      return;
    }
    this.#slow.set(key, {
      bucketAt,
      kind: sample.kind,
      target,
      count: 1,
      maxMs: sample.durationMs,
      sumMs: sample.durationMs,
      thresholdMs: sample.thresholdMs,
      requestId: sample.requestId,
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
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing;
    this.#flushing = this.#flushOnce().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async #flushOnce(): Promise<void> {
    const anomalies = [...this.#anomalies.values()];
    const slow = [...this.#slow.values()];
    const dropped = this.#dropped;
    this.#anomalies = new Map();
    this.#slow = new Map();
    this.#dropped = 0;

    if (dropped > 0) {
      this.#options.metrics?.observeJournalDropped(dropped);
      this.#options.logger.warn(
        { event: 'anomaly_overflow', dropped },
        'накопитель аномалий переполнен: часть событий не записана',
      );
    }
    if (anomalies.length === 0 && slow.length === 0) return;

    try {
      if (anomalies.length > 0) {
        await this.#options.sql.query(UPSERT_ANOMALIES, [
          anomalies.map((group) => group.bucketAt.toISOString()),
          anomalies.map((group) => group.route),
          anomalies.map((group) => group.statusCode),
          anomalies.map((group) => group.problemSlug),
          anomalies.map((group) => String(group.count)),
        ]);
      }
      if (slow.length > 0) {
        await this.#options.sql.query(UPSERT_SLOW, [
          slow.map((group) => group.kind),
          slow.map((group) => group.target),
          slow.map((group) => group.bucketAt.toISOString()),
          slow.map((group) => String(group.count)),
          slow.map((group) => Math.round(group.maxMs)),
          slow.map((group) => String(Math.round(group.sumMs))),
          slow.map((group) => group.thresholdMs),
          slow.map((group) => group.requestId ?? null),
        ]);
      }
    } catch (error) {
      // Статистика не имеет права ни бросать, ни повторять: её потеря видна
      // метрикой, а повтор в момент недоступности базы только удлинит очередь.
      this.#options.metrics?.observeJournalDropped(anomalies.length + slow.length);
      this.#options.logger.error(
        { event: 'anomaly_write_failed', err: error },
        'не удалось записать счётчики аномалий',
      );
    }
  }
}
