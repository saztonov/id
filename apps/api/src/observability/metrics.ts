/**
 * Метрики Prometheus (§11): метрики процесса, гистограммы HTTP и job'ов,
 * глубина очереди, латентность внешних вызовов, счётчик стоимости LLM.
 *
 * Наружу `/metrics` не публикуется — ограничение делает nginx. Здесь только
 * маршрут; при `METRICS_ENABLED=false` он не выдаётся вовсе (`route` возвращает
 * `undefined`), а все `observe*` становятся пустыми.
 *
 * Метрики живут в собственном `Registry`, а не в глобальном: два экземпляра в
 * одном процессе (тесты, api и служебный сервер воркера) иначе падают на
 * повторной регистрации имени.
 *
 * Все метки имеют ограниченное множество значений. Маршрут приходит шаблоном, но
 * на всякий случай прогоняется через `collapsePathIds()`: один просочившийся
 * конкретный путь с uuid превратил бы гистограмму в набор из тысяч серий, и
 * первым это заметит не разработчик, а память Prometheus.
 *
 * Модуль не зависит от Fastify. Приложение либо регистрирует `metrics.route`,
 * либо делает свой обработчик поверх `metrics.render()`; воркеру для служебного
 * http-сервера годится `handleNodeRequest()`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface HttpRequestSample {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface DbQuerySample {
  readonly operation: string;
  readonly durationMs: number;
  readonly outcome: 'ok' | 'error';
}

export interface JobRunSample {
  readonly jobType: string;
  readonly outcome: string;
  readonly durationMs: number;
}

export interface ExternalCallSample {
  /** `rdweb`, `llm`, `s3`, `keycloak` — имя сервиса, не адрес. */
  readonly service: string;
  readonly operation: string;
  readonly outcome: string;
  readonly durationMs: number;
}

export interface LlmUsageSample {
  readonly model: string;
  readonly stage: string;
  readonly costRub?: number | undefined;
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
}

export interface QueueDepthSample {
  readonly jobType: string;
  readonly status: string;
  readonly count: number;
}

export interface DeadJobsSample {
  readonly jobType: string;
  readonly count: number;
}

export interface QueueSnapshot {
  readonly depths: readonly QueueDepthSample[];
  /** Исчерпавшие `max_attempts`: их никто не подберёт без ручного решения. */
  readonly dead: readonly DeadJobsSample[];
}

export interface MetricsPayload {
  readonly contentType: string;
  readonly body: string;
}

/** Минимум, который нужен Fastify-ответу; полный `FastifyReply` ему соответствует. */
export interface MetricsReplyLike {
  header(name: string, value: string): unknown;
  send(payload: string): unknown;
}

export interface MetricsRoute {
  readonly method: 'GET';
  readonly url: string;
  readonly handler: (request: unknown, reply: MetricsReplyLike) => Promise<void>;
}

export interface Metrics {
  readonly enabled: boolean;
  readonly registry: Registry;
  /** `undefined`, если метрики выключены: маршрут тогда не регистрируется. */
  readonly route: MetricsRoute | undefined;
  observeHttpRequest(sample: HttpRequestSample): void;
  observeDbQuery(sample: DbQuerySample): void;
  observeJobRun(sample: JobRunSample): void;
  observeExternalCall(sample: ExternalCallSample): void;
  observeLlmUsage(sample: LlmUsageSample): void;
  setQueueDepth(samples: readonly QueueDepthSample[]): void;
  setDeadJobs(samples: readonly DeadJobsSample[]): void;
  /** Снимок очереди на момент сбора: без него значения отстают на интервал. */
  setQueueSnapshotProvider(provider: () => Promise<QueueSnapshot>): void;
  render(): Promise<MetricsPayload>;
  handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface MetricsOptions {
  readonly enabled: boolean;
  readonly service: string;
  readonly logger?: Logger;
  readonly path?: string;
}

const DEFAULT_PATH = '/metrics';
const MAX_LABEL_LENGTH = 120;

const HTTP_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DB_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 1, 3];
/**
 * Ступени job'ов растянуты до получаса: распознавание 83-страничной поставки
 * идёт минутами, и в ступенях HTTP всё оно попало бы в одно последнее ведро.
 */
const JOB_BUCKETS = [0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800];
const EXTERNAL_BUCKETS = [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60];

const JOB_OUTCOMES = new Set(['ok', 'error', 'timeout', 'cancelled', 'dead', 'retry']);
const CALL_OUTCOMES = new Set(['ok', 'error', 'timeout', 'rejected']);

function safeLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed;
}

/** Идентификаторы в пути сводятся к `:id`: метка обязана быть шаблоном. */
export function collapsePathIds(route: string): string {
  const trimmed = route.trim();
  if (trimmed.length === 0) return 'unknown';
  return trimmed
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b[0-9a-f]{32,}\b/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .slice(0, MAX_LABEL_LENGTH);
}

function boundedOutcome(outcome: string, allowed: Set<string>): string {
  const value = outcome.trim().toLowerCase();
  return allowed.has(value) ? value : 'other';
}

class PromMetrics implements Metrics {
  readonly enabled = true;
  readonly registry: Registry;
  readonly route: MetricsRoute;

  private readonly logger: Logger | undefined;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  private readonly dbDuration: Histogram<'operation' | 'outcome'>;
  private readonly jobDuration: Histogram<'job_type' | 'outcome'>;
  private readonly externalDuration: Histogram<'service' | 'operation' | 'outcome'>;
  private readonly queueDepth: Gauge<'job_type' | 'status'>;
  private readonly deadJobs: Gauge<'job_type'>;
  private readonly llmCost: Counter<'model' | 'stage'>;
  private readonly llmTokens: Counter<'model' | 'stage' | 'kind'>;
  private queueSnapshotProvider: (() => Promise<QueueSnapshot>) | undefined;

  constructor(options: MetricsOptions) {
    this.logger = options.logger;
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: options.service });
    collectDefaultMetrics({ register: this.registry });

    const registers = [this.registry];

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Длительность обработки HTTP-запроса по шаблону маршрута',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HTTP_BUCKETS,
      registers,
    });

    this.dbDuration = new Histogram({
      name: 'db_query_duration_seconds',
      help: 'Длительность запроса к PostgreSQL по виду операции',
      labelNames: ['operation', 'outcome'],
      buckets: DB_BUCKETS,
      registers,
    });

    this.jobDuration = new Histogram({
      name: 'job_duration_seconds',
      help: 'Длительность выполнения job по типу',
      labelNames: ['job_type', 'outcome'],
      buckets: JOB_BUCKETS,
      registers,
    });

    this.externalDuration = new Histogram({
      name: 'external_call_duration_seconds',
      help: 'Длительность исходящего вызова по сервису',
      labelNames: ['service', 'operation', 'outcome'],
      buckets: EXTERNAL_BUCKETS,
      registers,
    });

    this.queueDepth = new Gauge({
      name: 'job_queue_depth',
      help: 'Число задач в очереди по типу и статусу',
      labelNames: ['job_type', 'status'],
      registers,
    });

    this.deadJobs = new Gauge({
      name: 'job_dead_jobs',
      help: 'Задачи, исчерпавшие max_attempts',
      labelNames: ['job_type'],
      registers,
    });

    this.llmCost = new Counter({
      name: 'llm_cost_rub_total',
      help: 'Накопленная стоимость вызовов LLM в рублях',
      labelNames: ['model', 'stage'],
      registers,
    });

    this.llmTokens = new Counter({
      name: 'llm_tokens_total',
      help: 'Токены LLM по модели, стадии и виду',
      labelNames: ['model', 'stage', 'kind'],
      registers,
    });

    const url = options.path ?? DEFAULT_PATH;
    this.route = {
      method: 'GET',
      url,
      handler: async (_request, reply) => {
        const payload = await this.render();
        reply.header('content-type', payload.contentType);
        reply.send(payload.body);
      },
    };
  }

  observeHttpRequest(sample: HttpRequestSample): void {
    this.httpDuration.observe(
      {
        method: safeLabel(sample.method, 'UNKNOWN'),
        route: collapsePathIds(sample.route),
        status_code: String(sample.statusCode),
      },
      sample.durationMs / 1000,
    );
  }

  observeDbQuery(sample: DbQuerySample): void {
    this.dbDuration.observe(
      { operation: safeLabel(sample.operation, 'OTHER'), outcome: sample.outcome },
      sample.durationMs / 1000,
    );
  }

  observeJobRun(sample: JobRunSample): void {
    this.jobDuration.observe(
      {
        job_type: safeLabel(sample.jobType, 'unknown'),
        outcome: boundedOutcome(sample.outcome, JOB_OUTCOMES),
      },
      sample.durationMs / 1000,
    );
  }

  observeExternalCall(sample: ExternalCallSample): void {
    this.externalDuration.observe(
      {
        service: safeLabel(sample.service, 'unknown'),
        operation: safeLabel(sample.operation, 'unknown'),
        outcome: boundedOutcome(sample.outcome, CALL_OUTCOMES),
      },
      sample.durationMs / 1000,
    );
  }

  observeLlmUsage(sample: LlmUsageSample): void {
    const labels = {
      model: safeLabel(sample.model, 'unknown'),
      stage: safeLabel(sample.stage, 'unknown'),
    };
    if (sample.costRub !== undefined && sample.costRub > 0) {
      this.llmCost.inc(labels, sample.costRub);
    }
    if (sample.promptTokens !== undefined && sample.promptTokens > 0) {
      this.llmTokens.inc({ ...labels, kind: 'prompt' }, sample.promptTokens);
    }
    if (sample.completionTokens !== undefined && sample.completionTokens > 0) {
      this.llmTokens.inc({ ...labels, kind: 'completion' }, sample.completionTokens);
    }
  }

  setQueueDepth(samples: readonly QueueDepthSample[]): void {
    // Сброс перед записью: пропавшая пара (тип, статус) иначе навсегда осталась
    // бы с последним ненулевым значением.
    this.queueDepth.reset();
    for (const sample of samples) {
      this.queueDepth.set(
        {
          job_type: safeLabel(sample.jobType, 'unknown'),
          status: safeLabel(sample.status, 'unknown'),
        },
        sample.count,
      );
    }
  }

  setDeadJobs(samples: readonly DeadJobsSample[]): void {
    this.deadJobs.reset();
    for (const sample of samples) {
      this.deadJobs.set({ job_type: safeLabel(sample.jobType, 'unknown') }, sample.count);
    }
  }

  setQueueSnapshotProvider(provider: () => Promise<QueueSnapshot>): void {
    this.queueSnapshotProvider = provider;
  }

  async render(): Promise<MetricsPayload> {
    await this.refreshQueue();
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  async handleNodeRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = await this.render();
    res.statusCode = 200;
    res.setHeader('content-type', payload.contentType);
    res.end(payload.body);
  }

  private async refreshQueue(): Promise<void> {
    const provider = this.queueSnapshotProvider;
    if (!provider) return;
    try {
      const snapshot = await provider();
      this.setQueueDepth(snapshot.depths);
      this.setDeadJobs(snapshot.dead);
    } catch (error) {
      // Недоступная БД не должна ломать сбор метрик процесса: отдаём прошлые
      // значения глубины очереди, а не пустой ответ.
      this.logger?.warn(
        {
          event: 'queue_snapshot_failed',
          error_class: error instanceof Error ? error.name : typeof error,
        },
        'не удалось обновить глубину очереди',
      );
    }
  }
}

/** Выключенные метрики: одна и та же форма, чтобы вызывающий код не ветвился. */
class DisabledMetrics implements Metrics {
  readonly enabled = false;
  readonly registry = new Registry();
  readonly route = undefined;

  observeHttpRequest(): void {}
  observeDbQuery(): void {}
  observeJobRun(): void {}
  observeExternalCall(): void {}
  observeLlmUsage(): void {}
  setQueueDepth(): void {}
  setDeadJobs(): void {}
  setQueueSnapshotProvider(): void {}

  render(): Promise<MetricsPayload> {
    return Promise.resolve({ contentType: this.registry.contentType, body: '' });
  }

  handleNodeRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.statusCode = 404;
    res.end();
    return Promise.resolve();
  }
}

export function createMetrics(options: MetricsOptions): Metrics {
  return options.enabled ? new PromMetrics(options) : new DisabledMetrics();
}

export interface ExternalCallDescriptor {
  readonly service: string;
  readonly operation: string;
  /** Номер попытки: в метку не идёт (кардинальность), в лог — да. */
  readonly attempt?: number | undefined;
}

export interface MeasureExternalCallOptions {
  readonly logger?: Logger | undefined;
  /** §11, `SLOW_EXTERNAL_MS`: превышение переводит запись в warn. */
  readonly slowExternalMs?: number | undefined;
}

/**
 * Измеряет вызов внешнего сервиса, пишет его в лог и отдаёт результат.
 *
 * Отдельная функция, а не обязанность каждого адаптера: пропущенное измерение
 * в одном из вызовов RD WEB — это отсутствующая метрика, которую никто не
 * заметит до инцидента. Ни адрес, ни тело в лог не идут: у RD WEB в адресе
 * бывают токены, а в теле — распознанный текст.
 */
export async function measureExternalCall<T>(
  metrics: Metrics,
  descriptor: ExternalCallDescriptor,
  call: () => Promise<T>,
  options: MeasureExternalCallOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  const finish = (failed: boolean, error: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.observeExternalCall({
      service: descriptor.service,
      operation: descriptor.operation,
      outcome: failed ? 'error' : 'ok',
      durationMs,
    });

    const logger = options.logger;
    if (!logger) return;

    const fields: Record<string, unknown> = {
      event: failed ? 'external_call_failed' : 'external_call',
      service: descriptor.service,
      operation: descriptor.operation,
      attempt: descriptor.attempt,
      duration_ms: durationMs,
    };

    if (failed) {
      fields.error_class = error instanceof Error ? error.name : typeof error;
      logger.warn(fields, 'вызов внешнего сервиса завершился ошибкой');
      return;
    }

    if (options.slowExternalMs !== undefined && durationMs >= options.slowExternalMs) {
      fields.event = 'external_call_slow';
      fields.threshold_ms = options.slowExternalMs;
      logger.warn(fields, 'медленный вызов внешнего сервиса');
      return;
    }
    logger.debug(fields, 'вызов внешнего сервиса');
  };

  try {
    const result = await call();
    finish(false, undefined);
    return result;
  } catch (error) {
    finish(true, error);
    throw error;
  }
}
