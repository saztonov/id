/**
 * Исполнитель фоновых задач: захват, выполнение, повтор, reaper (§12).
 *
 * ## Что здесь происходит по шагам
 *
 * 1. На каждую очередь (`io`, `cpu`, `llm`) — свой цикл со своим потолком
 *    параллелизма. Потолки разные не для красоты: `cpu` держит в памяти файлы
 *    комплекта, и четыре такие задачи разом — это OOM на одной VPS (ADR-0003).
 * 2. Захват — `claimJobs()`: `FOR UPDATE SKIP LOCKED` с арендой. Забираются
 *    только типы, для которых у ЭТОГО процесса есть обработчик, — иначе задача
 *    ещё не реализованной стадии была бы захвачена и убита повторами.
 * 3. Пока задача идёт, аренда продлевается сердцебиением. Без него пришлось бы
 *    ставить аренду по самому долгому мыслимому времени выполнения, и задача
 *    умершего воркера столько же ждала бы освобождения.
 * 4. Исход попытки пишется в `job_runs` всегда — и успех, и отказ, и истёкшая
 *    аренда. Это единственный источник ответа на «сколько реально идёт
 *    обработка комплекта» (§11), поэтому «по-быстрому не записать» нельзя.
 * 5. Отказ — экспоненциальный повтор с потолком и разбросом; после
 *    `max_attempts` задача переходит в dead и ждёт решения человека в консоли.
 * 6. Просроченные аренды освобождает reaper по таймеру. Воркер, убитый
 *    сигналом, ничего освободить не может — и это как раз тот отказ, который не
 *    виден снаружи: очередь не растёт, ошибок нет, конвейер стоит.
 *
 * ## Потолок попытки
 *
 * `leaseMs` типа задачи работает и как срок аренды, и как потолок ОДНОЙ попытки.
 * Одно число, а не два, потому что второе неизбежно рассогласовалось бы с
 * первым: обработчик, зависший дольше аренды, продолжал бы её продлевать, и
 * задача стала бы невидимо вечной — reaper к ней не подходит, в очереди её нет.
 * По истечении потолка попытка обрывается (`AbortSignal`) и падает с классом
 * `JobTimeout`. Отмена кооперативная: синхронный цикл она не прервёт.
 *
 * ## Сквозной request_id
 *
 * `request_id` едет в payload'е задачи и здесь поднимается в контекст
 * AsyncLocalStorage (§11). Поэтому строка журнала обработчика, запись в
 * `error_events` и исходящий вызов RD WEB несут тот же идентификатор, что и
 * HTTP-запрос, с которого всё началось.
 */
import type { Logger } from 'pino';
import { childLogger, newRequestId, runWithContext } from '../observability/context.js';
import {
  errorClassOf,
  normalizeErrorMessage,
  type ErrorReporter,
} from '../observability/errors.js';
import type { Metrics } from '../observability/metrics.js';
import {
  claimJobs,
  completeJob,
  enqueueSystemJob,
  failJob,
  publishOutboxBatch,
  queueSnapshot,
  reapExpiredLeases,
  renewLease,
  type ClaimedJob,
} from '../db/repositories/jobs.js';
import type { Database } from '../db/repositories/users.js';
import { RdWebError } from '../integrations/rdweb/port.js';
import { emitRevisionEvent, type JobContext, type JobRegistry } from './registry.js';
import {
  backoffDelayMs,
  clampConcurrency,
  isJobType,
  jobDefinition,
  JOB_QUEUES,
  parseJobPayload,
  type BackoffPolicy,
  type JobQueue,
  type JobType,
  DEFAULT_BACKOFF,
} from './types.js';

/** Аренда на момент захвата: сердцебиение сразу переставит её под тип задачи. */
const CLAIM_LEASE_MS = 60_000;
/** Потолок интервала сердцебиения: чаще не нужно, реже — риск потерять аренду. */
const MAX_HEARTBEAT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const DEFAULT_OUTBOX_INTERVAL_MS = 2_000;
/** Сколько ждать текущие задачи при остановке: Docker шлёт SIGKILL через 10 с. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;

export class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`попытка не уложилась в ${timeoutMs} мс`);
    this.name = 'JobTimeout';
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super('аренда задачи потеряна: её подобрал другой воркер');
    this.name = 'LeaseLost';
  }
}

/**
 * Класс отказа и решение о повторе — одним местом.
 *
 * Раньше повторялось ВСЁ: пять попыток на 401 означали пять одинаковых входов
 * служебного аккаунта при отозванном доступе — то есть шум в чужом аудите и
 * четверть часа «конвейер работает» вместо немедленного отказа. Ответ на вопрос
 * «повторять ли» у `RdWebError` уже был (`retriable`: 5xx, 429 и сетевой сбой —
 * да, прочие 4xx — нет), но его никто не спрашивал.
 *
 * HTTP-статус попадает в `error_class`, а не только в текст: `normalizeErrorMessage()`
 * вычёркивает из сообщения все числа (и правильно делает — там бывают значения
 * параметров), поэтому в `job_runs.error_message` от «RD WEB ответил 401»
 * остаётся «RD WEB ответил <n>», и отличить отозванный доступ от падения их
 * сервера по журналу нечем. `RdWebError:401` против `RdWebError:503` — можно.
 */
export function classifyFailure(error: unknown): {
  readonly errorClass: string;
  readonly permanent: boolean;
} {
  if (error instanceof RdWebError) {
    // `network` вместо статуса: соединение не состоялось, кода ответа нет —
    // и это отдельный диагноз, а не «неизвестно какой».
    const kind = error.status === undefined ? 'network' : String(error.status);
    return { errorClass: `RdWebError:${kind}`, permanent: !error.retriable };
  }
  return { errorClass: errorClassOf(error), permanent: false };
}

export interface JobRunnerOptions {
  readonly db: Database;
  readonly registry: JobRegistry;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly errorReporter: ErrorReporter;
  /** Имя арендатора в `jobs.locked_by`: по нему видно, чей воркер держит задачу. */
  readonly workerId: string;
  readonly concurrency?: Partial<Record<JobQueue, number>> | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly reaperIntervalMs?: number | undefined;
  readonly outboxIntervalMs?: number | undefined;
  readonly backoff?: BackoffPolicy | undefined;
  readonly shutdownTimeoutMs?: number | undefined;
}

interface QueueState {
  readonly concurrency: number;
  inFlight: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Выполняющаяся задача.
 *
 * Хранится массивом, а не `Map`: eslint-правило, запрещающее запросы к БД вне
 * `db/repositories/`, ищет вызовы `.delete()` по ИМЕНИ метода и не отличает
 * `map.delete()` от `db.delete()`. Тот же обход применён к маршрутам DELETE
 * в `modules/catalog/routes.ts`. Одновременных задач единицы, поэтому перебор
 * массива здесь ничего не стоит.
 */
interface RunningJob {
  readonly jobId: string;
  readonly promise: Promise<void>;
  readonly abort: () => void;
}

export class JobRunner {
  readonly #options: JobRunnerOptions;
  readonly #queues = new Map<JobQueue, QueueState>();
  #running: RunningJob[] = [];
  readonly #backoff: BackoffPolicy;
  readonly #pollIntervalMs: number;
  #reaperTimer: NodeJS.Timeout | null = null;
  #outboxTimer: NodeJS.Timeout | null = null;
  #started = false;
  #stopping = false;

  constructor(options: JobRunnerOptions) {
    this.#options = options;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    for (const queue of JOB_QUEUES) {
      this.#queues.set(queue, {
        concurrency: clampConcurrency(queue, options.concurrency?.[queue]),
        inFlight: 0,
        timer: null,
      });
    }
  }

  get inFlight(): number {
    return this.#running.length;
  }

  /** Сколько задач одновременно берёт очередь: нужно и журналу старта, и тестам. */
  concurrencyOf(queue: JobQueue): number {
    return this.#queues.get(queue)?.concurrency ?? 0;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;

    // Глубина очереди снимается в момент сбора метрик, а не по таймеру: иначе
    // значение отстаёт на интервал и по нему нельзя судить о заторе (§11).
    this.#options.metrics.setQueueSnapshotProvider(() => queueSnapshot(this.#options.db));

    const handled = this.#options.registry.types();
    this.#options.logger.info(
      {
        event: 'worker_started',
        worker_id: this.#options.workerId,
        handled_types: handled.length,
        concurrency: Object.fromEntries(
          [...this.#queues].map(([queue, state]) => [queue, state.concurrency]),
        ),
      },
      'исполнитель задач запущен',
    );

    for (const queue of JOB_QUEUES) this.#schedule(queue, 0);
    this.#scheduleReaper();
    this.#scheduleOutbox();
  }

  /**
   * Остановка: текущие задачи дорабатывают, новые не берутся (§12).
   *
   * По истечении отпущенного времени сигнал отмены взводится, но процесс всё
   * равно выходит: незавершённая задача вернётся в очередь по истечении аренды.
   * At-least-once именно для этого и нужен.
   */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopping = true;

    for (const state of this.#queues.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
    }
    if (this.#reaperTimer !== null) clearTimeout(this.#reaperTimer);
    if (this.#outboxTimer !== null) clearTimeout(this.#outboxTimer);
    this.#reaperTimer = null;
    this.#outboxTimer = null;

    const timeoutMs = this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const pending = this.#running.map((entry) => entry.promise);

    if (pending.length > 0) {
      this.#options.logger.info(
        { event: 'worker_draining', in_flight: pending.length, timeout_ms: timeoutMs },
        'ждём завершения текущих задач',
      );

      let timer: NodeJS.Timeout | null = null;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, timeoutMs);
      });

      const outcome = await Promise.race([
        Promise.allSettled(pending).then(() => 'done'),
        deadline,
      ]);
      if (timer !== null) clearTimeout(timer);

      if (outcome === 'timeout') {
        for (const entry of this.#running) entry.abort();
        this.#options.logger.warn(
          { event: 'worker_drain_timeout', in_flight: this.#running.length },
          'задачи не завершились вовремя: аренда истечёт и их подберёт reaper',
        );
      }
    }

    this.#started = false;
    this.#options.logger.info({ event: 'worker_stopped' }, 'исполнитель задач остановлен');
  }

  /**
   * Один проход по всем очередям с ожиданием завершения захваченного.
   *
   * Нужен тестам и ручному прогону: без него проверка «задача выполнилась»
   * зависела бы от таймеров, то есть была бы проверкой на удачу.
   */
  async runOnce(): Promise<number> {
    let claimed = 0;
    for (const queue of JOB_QUEUES) claimed += await this.#pump(queue);
    await Promise.allSettled(this.#running.map((entry) => entry.promise));
    return claimed;
  }

  /** Проход обслуживания вне таймеров: reaper и публикация outbox. */
  async runMaintenanceOnce(): Promise<void> {
    await this.#reapOnce();
    await this.#publishOutboxOnce();
  }

  // -------------------------------------------------------------------
  // Циклы
  // -------------------------------------------------------------------

  #schedule(queue: JobQueue, delayMs: number): void {
    const state = this.#queues.get(queue);
    if (state === undefined || this.#stopping) return;

    state.timer = setTimeout(() => {
      void this.#tick(queue);
    }, delayMs);
    // Таймер не держит event loop: иначе процесс не завершился бы сам, а тест
    // висел бы до таймаута vitest.
    state.timer.unref();
  }

  async #tick(queue: JobQueue): Promise<void> {
    if (this.#stopping) return;
    let claimed = 0;
    try {
      claimed = await this.#pump(queue);
    } catch (error) {
      // Отказ ЗАХВАТА (недоступна БД) не должен останавливать цикл: воркер
      // обязан подняться сам, когда база вернётся.
      this.#options.logger.error(
        { event: 'job_claim_failed', queue, error_class: errorClassOf(error) },
        'не удалось захватить задачи',
      );
      void this.#options.errorReporter.report(error, { extra: { queue, source: 'claim' } });
    } finally {
      // Захватили полную пачку — сразу за следующей: очередь не пуста.
      this.#schedule(queue, claimed > 0 ? 0 : this.#pollIntervalMs);
    }
  }

  async #pump(queue: JobQueue): Promise<number> {
    const state = this.#queues.get(queue);
    if (state === undefined || this.#stopping) return 0;

    const free = state.concurrency - state.inFlight;
    if (free <= 0) return 0;

    const types = this.#options.registry.typesOfQueue(queue);
    if (types.length === 0) return 0;

    const claimed = await claimJobs(this.#options.db, {
      workerId: this.#options.workerId,
      types,
      limit: free,
      leaseMs: CLAIM_LEASE_MS,
    });

    for (const job of claimed) {
      state.inFlight += 1;
      const controller = new AbortController();
      const promise = this.#runJob(job, controller)
        .catch((error: unknown) => {
          // Сюда попадает только сбой самой обвязки: исход задачи обработан
          // внутри. Молча терять его нельзя — это дефект runner'а.
          this.#options.logger.error(
            { event: 'job_runner_failed', job_id: job.jobId, error_class: errorClassOf(error) },
            'сбой обвязки исполнения задачи',
          );
          void this.#options.errorReporter.report(error, {
            jobId: job.jobId,
            jobType: job.type,
            extra: { source: 'runner' },
          });
        })
        .finally(() => {
          state.inFlight -= 1;
          this.#running = this.#running.filter((entry) => entry.jobId !== job.jobId);
        });

      this.#running.push({
        jobId: job.jobId,
        promise,
        abort: () => {
          controller.abort();
        },
      });
    }

    return claimed.length;
  }

  #scheduleReaper(): void {
    if (this.#stopping) return;
    const interval = this.#options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    this.#reaperTimer = setTimeout(() => {
      void this.#reapOnce().finally(() => {
        this.#scheduleReaper();
      });
    }, interval);
    this.#reaperTimer.unref();
  }

  async #reapOnce(): Promise<void> {
    try {
      const result = await reapExpiredLeases(this.#options.db, {});
      if (result.requeued > 0) {
        this.#options.logger.warn(
          {
            event: 'lease_reaped',
            requeued: result.requeued,
            dead: result.dead,
            closed_runs: result.closedRuns,
          },
          'освобождены просроченные аренды задач',
        );
      }
    } catch (error) {
      this.#options.logger.error(
        { event: 'reaper_failed', error_class: errorClassOf(error) },
        'reaper не отработал',
      );
      void this.#options.errorReporter.report(error, { extra: { source: 'reaper' } });
    }
  }

  #scheduleOutbox(): void {
    if (this.#stopping) return;
    const interval = this.#options.outboxIntervalMs ?? DEFAULT_OUTBOX_INTERVAL_MS;
    this.#outboxTimer = setTimeout(() => {
      void this.#publishOutboxOnce().finally(() => {
        this.#scheduleOutbox();
      });
    }, interval);
    this.#outboxTimer.unref();
  }

  async #publishOutboxOnce(): Promise<void> {
    try {
      const result = await publishOutboxBatch(this.#options.db, {});
      if (result.published > 0) {
        this.#options.logger.debug(
          { event: 'outbox_published', published: result.published, events: result.events },
          'записи outbox опубликованы',
        );
      }
    } catch (error) {
      this.#options.logger.error(
        { event: 'outbox_publish_failed', error_class: errorClassOf(error) },
        'публикация outbox не удалась',
      );
      void this.#options.errorReporter.report(error, { extra: { source: 'outbox' } });
    }
  }

  // -------------------------------------------------------------------
  // Выполнение одной задачи
  // -------------------------------------------------------------------

  /**
   * Одна попытка задачи.
   *
   * Метод назван `#runJob`, а не `#execute`: eslint-правило про запросы к БД
   * вне репозиториев ищет обращения к `.execute()` по имени и приватное поле
   * тоже считает попаданием.
   */
  async #runJob(job: ClaimedJob, controller: AbortController): Promise<void> {
    const requestId = job.requestId ?? newRequestId();

    await runWithContext(
      {
        requestId,
        jobType: job.type,
        jobId: job.jobId,
        attempt: job.attempt,
        ...(job.revisionId !== null ? { revisionId: job.revisionId } : {}),
      },
      async () => {
        const logger = childLogger(this.#options.logger, {
          job_type: job.type,
          job_id: job.jobId,
          attempt: job.attempt,
        });
        const startedAt = Date.now();

        if (!isJobType(job.type)) {
          await this.#finishFailed(job, startedAt, logger, {
            errorClass: 'UnknownJobType',
            message: `тип задачи ${job.type} не объявлен`,
            permanent: true,
            error: new Error(`неизвестный тип задачи ${job.type}`),
          });
          return;
        }

        const definition = jobDefinition(job.type);
        const handler = this.#options.registry.handlerFor(job.type);
        if (handler === undefined) {
          await this.#finishFailed(job, startedAt, logger, {
            errorClass: 'MissingHandler',
            message: `обработчик задачи ${job.type} не зарегистрирован`,
            permanent: true,
            error: new Error(`нет обработчика ${job.type}`),
          });
          return;
        }

        const parsed = parseJobPayload(job.type, job.payload);
        if (!parsed.ok) {
          // Повторять нечего: тот же payload даст тот же результат пять раз.
          await this.#finishFailed(job, startedAt, logger, {
            errorClass: 'InvalidPayload',
            message: `payload не прошёл схему: ${parsed.problems.join('; ')}`,
            permanent: true,
            error: new Error('непригодный payload задачи'),
          });
          return;
        }

        logger.info({ event: 'job_started', queue: definition.queue }, 'задача взята в работу');
        await this.#emitLifecycle(job, logger, 'job.started', { attempt: job.attempt });

        const heartbeat = this.#startHeartbeat(job, definition.leaseMs, controller, logger);

        try {
          await this.#withTimeout(
            handler(this.#context(job, parsed.payload, logger, controller.signal) as never),
            definition.leaseMs,
            controller,
          );

          const durationMs = Date.now() - startedAt;
          const applied = await completeJob(this.#options.db, {
            jobId: job.jobId,
            runId: job.runId,
            workerId: this.#options.workerId,
            durationMs,
          });

          this.#options.metrics.observeJobRun({
            jobType: job.type,
            outcome: 'ok',
            durationMs,
          });

          if (!applied) {
            // Аренду перехватили: задача, возможно, выполняется вторым воркером.
            // Успех записан в попытку, но состоянием задачи распоряжается он.
            logger.warn(
              { event: 'job_lease_lost', duration_ms: durationMs },
              'задача завершена, но аренда уже принадлежала другому воркеру',
            );
            return;
          }

          logger.info({ event: 'job_done', duration_ms: durationMs }, 'задача выполнена');
          await this.#emitLifecycle(job, logger, 'job.succeeded', { durationMs });
        } catch (error) {
          const { errorClass, permanent } = classifyFailure(error);
          await this.#finishFailed(job, startedAt, logger, {
            errorClass,
            message: normalizeErrorMessage(error instanceof Error ? error.message : String(error)),
            permanent,
            error,
          });
        } finally {
          heartbeat();
        }
      },
    );
  }

  #context(
    job: ClaimedJob,
    payload: unknown,
    logger: Logger,
    signal: AbortSignal,
  ): JobContext<JobType> {
    return {
      jobId: job.jobId,
      type: job.type as JobType,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      revisionId: job.revisionId,
      payload: payload as JobContext<JobType>['payload'],
      db: this.#options.db,
      logger,
      signal,
      enqueue: (input) => enqueueSystemJob(this.#options.db, input),
      emit: (eventType, eventPayload) =>
        emitRevisionEvent(this.#options.db, job.revisionId, logger, eventType, eventPayload),
    };
  }

  /**
   * Продление аренды.
   *
   * Потеря аренды (другой воркер уже подобрал задачу) обрывает попытку: два
   * воркера, пишущих результат одной задачи, — это гонка на уровне данных, а не
   * лишняя работа.
   */
  #startHeartbeat(
    job: ClaimedJob,
    leaseMs: number,
    controller: AbortController,
    logger: Logger,
  ): () => void {
    const intervalMs = Math.max(1_000, Math.min(MAX_HEARTBEAT_MS, Math.floor(leaseMs / 3)));
    const timer = setInterval(() => {
      void renewLease(this.#options.db, {
        jobId: job.jobId,
        workerId: this.#options.workerId,
        leaseMs,
      })
        .then((held) => {
          if (held) return;
          logger.warn({ event: 'job_lease_lost' }, 'аренда задачи потеряна, прерываем попытку');
          controller.abort(new LeaseLostError());
        })
        .catch((error: unknown) => {
          logger.warn(
            { event: 'job_lease_renew_failed', error_class: errorClassOf(error) },
            'не удалось продлить аренду задачи',
          );
        });
    }, intervalMs);
    timer.unref();

    return () => {
      clearInterval(timer);
    };
  }

  async #withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new JobTimeoutError(timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      timer.unref();
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async #finishFailed(
    job: ClaimedJob,
    startedAt: number,
    logger: Logger,
    failure: {
      readonly errorClass: string;
      readonly message: string;
      readonly permanent: boolean;
      readonly error: unknown;
    },
  ): Promise<void> {
    const durationMs = Date.now() - startedAt;
    const nextAttempt = job.attempt + 1;
    const retryDelayMs = backoffDelayMs(job.attempt, this.#backoff);

    const result = await failJob(this.#options.db, {
      jobId: job.jobId,
      runId: job.runId,
      workerId: this.#options.workerId,
      durationMs,
      errorClass: failure.errorClass,
      errorMessage: failure.message,
      retryDelayMs,
      permanent: failure.permanent,
    });

    const timedOut = failure.errorClass === 'JobTimeout';
    this.#options.metrics.observeJobRun({
      jobType: job.type,
      outcome: result.dead ? 'dead' : timedOut ? 'timeout' : 'retry',
      durationMs,
    });

    // В `error_events` уходит исходная ошибка со стеком: там дедупликация по
    // отпечатку, и по ней видно, сколько раз это уже случалось (§11).
    void this.#options.errorReporter.report(failure.error, {
      jobType: job.type,
      jobId: job.jobId,
      attempt: job.attempt,
      ...(job.revisionId !== null ? { revisionId: job.revisionId } : {}),
    });

    const fields = {
      event: result.dead ? 'job_dead' : 'job_failed',
      duration_ms: durationMs,
      error_class: failure.errorClass,
      will_retry: !result.dead,
      next_attempt: result.dead ? null : nextAttempt,
      retry_in_ms: result.dead ? null : retryDelayMs,
    };

    if (result.dead) {
      logger.error(fields, 'задача исчерпала попытки и требует решения человека');
    } else {
      logger.warn(fields, 'попытка задачи не удалась, будет повтор');
    }

    await this.#emitLifecycle(job, logger, result.dead ? 'job.dead' : 'job.failed', {
      attempt: job.attempt,
      errorClass: failure.errorClass,
      willRetry: !result.dead,
    });
  }

  /**
   * Событие жизненного цикла в ленту ревизии.
   *
   * Отказ записи события не имеет права провалить задачу: SSE — уведомление, а
   * источник состояния — REST (§3.8). Обратный порядок означал бы, что поставка
   * не обрабатывается из-за неработающего уведомления.
   */
  async #emitLifecycle(
    job: ClaimedJob,
    logger: Logger,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (job.revisionId === null) return;
    try {
      await emitRevisionEvent(this.#options.db, job.revisionId, logger, eventType, {
        jobId: job.jobId,
        jobType: job.type,
        ...payload,
      });
    } catch (error) {
      logger.warn(
        { event: 'revision_event_failed', event_type: eventType, error_class: errorClassOf(error) },
        'событие ревизии не записано',
      );
    }
  }
}
