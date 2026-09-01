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
  classifyErrorDomain,
  errorClassOf,
  errorDigest,
  messageOfChain,
  normalizeErrorMessage,
  type ErrorReporter,
} from '../observability/errors.js';
import type { Metrics } from '../observability/metrics.js';
import {
  claimJobs,
  completeJob,
  deferJob,
  enqueueSystemJob,
  failJob,
  publishOutboxBatch,
  queueSnapshot,
  reapExpiredLeases,
  renewLease,
  type ClaimedJob,
} from '../db/repositories/jobs.js';
import type { Database } from '../db/repositories/users.js';
import { pruneJournal } from '../db/repositories/error-journal.js';
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
  DEFERRAL_BACKOFF,
} from './types.js';

/** Аренда на момент захвата: сердцебиение сразу переставит её под тип задачи. */
const CLAIM_LEASE_MS = 60_000;
/** Потолок интервала сердцебиения: чаще не нужно, реже — риск потерять аренду. */
const MAX_HEARTBEAT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const DEFAULT_OUTBOX_INTERVAL_MS = 2_000;
/**
 * Раз в час: очистка удаляет хвост суточной давности и старше, и чаще ей
 * нечего делать. Реже — хвост растёт заметными скачками.
 */
const DEFAULT_PRUNE_INTERVAL_MS = 3_600_000;

/**
 * Предохранитель очереди: сколько транспортных отказов подряд её останавливают.
 *
 * Три, а не один: единичный сбой сети — норма, и вставать из-за него значило бы
 * тормозить конвейер на ровном месте. Три подряд — это уже недоступность
 * стороны, а не совпадение.
 */
const TRANSIENT_STREAK_LIMIT = 3;
/** Первая пауза очереди; дальше удваивается на каждый следующий отказ. */
const QUEUE_PAUSE_BASE_MS = 60_000;
/** Потолок паузы: дольше десяти минут очередь не молчит — сторона могла вернуться. */
const QUEUE_PAUSE_CAP_MS = 600_000;
/**
 * Сколько ждать текущие задачи при остановке, если срок не задан снаружи.
 *
 * Умолчание консервативное: оно рассчитано на 10-секундный grace-период Docker
 * без настройки. Развёртывание, давшее контейнеру больше (`stop_grace_period`),
 * обязано передать сюда своё значение — иначе воркер уйдёт раньше, чем ему
 * разрешено, и оборвёт задачу, которая успела бы дописать результат.
 */
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
 * Не отказ, а отсрочка: «работы ещё нет, условие не наступило».
 *
 * Три задачи конвейера — поллеры, и ожидание у них штатное: `vlm.finalize_run`
 * ждёт терминальности страниц прогона, `rd.poll_recognition` — окончания OCR,
 * `rd.wait_pages` — рендера страниц. Выразить это было нечем: единственным
 * способом попросить повтор был бросок повторяемой ошибки, а единственным
 * исходом попытки — `failed`. Минута нормального ожидания давала двенадцать
 * строк отказа и плашку «Обработка остановилась» на живом конвейере.
 *
 * Класс объявлен здесь, но движок его НЕ УЗНАЁТ по имени: проверка идёт по
 * форме поля (`deferralOf`), тем же приёмом и по той же причине, что и
 * `retriable` ниже. Обработчики живут в пакете воркера, а `instanceof` через
 * границу пакетов ломается при дублировании зависимости молча — и сломался бы
 * в сторону «отсрочка записана как отказ», то есть ровно в ту, ради которой
 * всё это заведено.
 */
export class JobDeferredError extends Error {
  readonly deferred = true;
  /** Через сколько спрашивать снова. Не задано — политика `DEFERRAL_BACKOFF`. */
  readonly retryAfterMs?: number | undefined;

  constructor(message: string, options?: { readonly retryAfterMs?: number | undefined }) {
    super(message);
    this.name = 'JobDeferred';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** Форма отсрочки: см. шапку `JobDeferredError` о том, почему не `instanceof`. */
interface DeferrableFailure {
  readonly deferred: boolean;
  readonly retryAfterMs?: number | undefined;
}

export function deferralOf(error: unknown): { readonly retryAfterMs: number | null } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Partial<DeferrableFailure>;
  if (candidate.deferred !== true) return null;
  const delay = candidate.retryAfterMs;
  return { retryAfterMs: typeof delay === 'number' && Number.isFinite(delay) ? delay : null };
}

/**
 * Отказ, который сам знает, имеет ли смысл его повторять.
 *
 * Контракт структурный, а не номинальный: движку задач важно не то, какого
 * класса ошибка, а только её собственный ответ на вопрос «повторять ли».
 * Проверка формой, а не `instanceof`, — единственное, что не требует править
 * `runner.ts` при появлении следующего класса отказа.
 */
interface SelfClassifyingFailure {
  readonly retriable: boolean;
}

/** Внешний отказ, у которого бывает HTTP-статус. `undefined` — ответа не было. */
interface StatusBearingFailure {
  readonly status: number | undefined;
}

function retriabilityOf(error: unknown): boolean | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Partial<SelfClassifyingFailure>).retriable;
  return typeof value === 'boolean' ? value : null;
}

/**
 * Уточнение класса отказа HTTP-статусом.
 *
 * Свойство `status` берётся только у отказов, которые сами объявили
 * повторяемость: иначе сюда попал бы любой объект со случайным полем `status`.
 */
function statusSuffix(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  if (!('status' in error)) return '';
  const status = (error as Partial<StatusBearingFailure>).status;
  if (typeof status === 'number') return `:${status}`;
  // `network` вместо статуса: соединение не состоялось, кода ответа нет —
  // и это отдельный диагноз, а не «неизвестно какой».
  return status === undefined ? ':network' : '';
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
 *
 * ## Почему здесь НЕТ перечисления классов
 *
 * Первая редакция знала ровно про `RdWebError`, а всё остальное объявляла
 * повторяемым. Появились `SegmentationStateError`, `LlmBudgetError` и
 * `LlmTimeoutError` — и первые два поехали в `max_attempts` попыток с backoff:
 * «прогона распознавания нет» и «месячный бюджет исчерпан» повторялись пять раз
 * подряд, хотя повтор не мог изменить ни того, ни другого. Перечисление — это и
 * есть способ, которым дефект возникает второй раз; тот же урок S7 закрывал
 * `withRunTermination`.
 *
 * Поэтому правило общее: решение принимает САМ класс отказа, объявив
 * `retriable`. Движок его только читает. Отказ, ничего о себе не сообщивший,
 * считается преходящим — это сохраняет прежнее поведение неизвестных ошибок
 * (сетевые сбои, срывы аренды), и молчание не превращается в тихий отказ от
 * повтора там, где повтор помог бы.
 *
 * Различение внутри одного семейства из этого следует само: `LlmBudgetError`
 * объявляет `retriable: false` (бюджет от повтора не восстановится),
 * `LlmTimeoutError` и `LlmRateLimitError` — `true` (внешняя и преходящая
 * причина). Повторять их одинаково было бы неверно в обе стороны.
 */
/** Отказ, у которого сторона назвала паузу (`Retry-After` при 429). */
interface RetryAfterBearingFailure {
  readonly retryAfterMs: number | undefined;
}

/**
 * Пауза, названная самой стороной, если она есть.
 *
 * Читается формой поля — тем же приёмом и по той же причине, что `retriable` и
 * `deferred`: классы ошибок живут в другом пакете, и `instanceof` через границу
 * пакетов ломается молча. Сторона знает, когда откроется окно, а откат только
 * гадает по номеру попытки.
 */
function retryAfterMsOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Partial<RetryAfterBearingFailure>).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Транспортный отказ: недоступна сторона, а не плох запрос.
 *
 * Различать это нужно предохранителю очереди. «Шлюз ответил 503» означает, что
 * и следующая задача получит то же самое, а «модель ответила не по схеме» о
 * соседних блоках не говорит ничего — останавливать из-за второго целую очередь
 * значило бы лечить прикладной дефект простоем.
 *
 * Признак структурный, как и всё в этом файле: повторяемый отказ с серверным
 * статусом либо без ответа вовсе. Потолок попытки (`JobTimeout`) считается
 * транспортным только в очереди `llm`: там он почти всегда означает молчащий
 * шлюз, тогда как в `cpu` это своя тяжёлая страница, и соседние страницы
 * ни при чём.
 */
function isTransientOutage(error: unknown, queue: JobQueue | undefined): boolean {
  if (retriabilityOf(error) === true) {
    const suffix = statusSuffix(error);
    if (suffix === ':network') return true;
    const status = Number(suffix.slice(1));
    if (Number.isFinite(status) && (status >= 500 || status === 429)) return true;
  }
  return queue === 'llm' && errorClassOf(error) === 'JobTimeout';
}

export function classifyFailure(error: unknown): {
  readonly errorClass: string;
  readonly permanent: boolean;
} {
  const retriable = retriabilityOf(error);
  if (retriable === null) return { errorClass: errorClassOf(error), permanent: false };

  return {
    errorClass: `${errorClassOf(error)}${statusSuffix(error)}`,
    permanent: !retriable,
  };
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
  /**
   * Очистка журнала ошибок по срокам хранения (§11).
   *
   * Не задано — цикл не запускается вовсе. Это не «выключено по умолчанию из
   * осторожности»: в тестах и в процессах без журнала цикл, который раз в час
   * ходит в БД удалять чужие строки, — чистый вред, а отсутствующий цикл
   * невозможно спутать с работающим.
   */
  readonly journalRetention?:
    | {
        readonly sampleRetentionDays: number;
        readonly statsRetentionDays: number;
        readonly slowRetentionDays: number;
        readonly samplesPerIssue: number;
      }
    | undefined;
  readonly pruneIntervalMs?: number | undefined;
  readonly backoff?: BackoffPolicy | undefined;
  /**
   * Политика повторов для ОТСРОЧЕК — отдельная ручка, как и сама политика.
   *
   * Инъекцией по той же причине, что и `backoff`: тест, которому нужно увидеть
   * второй заход поллера, не должен ждать секунды настоящей паузы. Без этой
   * ручки отсрочки жили бы по константе, а отказы — по внедрённой политике, и
   * набор, уменьшивший `backoff` до миллисекунд, всё равно спотыкался бы о
   * пятисекундную паузу — причём необъяснимо, потому что в его настройках такого
   * числа нет.
   */
  readonly deferralBackoff?: BackoffPolicy | undefined;
  readonly shutdownTimeoutMs?: number | undefined;
}

interface QueueState {
  readonly concurrency: number;
  inFlight: number;
  timer: NodeJS.Timeout | null;
  /**
   * Транспортные отказы подряд и пауза захвата (S41).
   *
   * Пока шлюз лежал, очередь `llm` продолжала брать страницу за страницей и
   * тратить на каждую по попытке: минута недоступности превращалась в десятки
   * сожжённых попыток по всему прогону, и экспоненциальный откат отдельной
   * задачи этому не мешал — задач было много, а откат у каждой свой. Пауза
   * берётся один раз на очередь и снимается первым же успехом.
   */
  transientStreak: number;
  pausedUntil: number;
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
  readonly #deferralBackoff: BackoffPolicy;
  readonly #pollIntervalMs: number;
  #reaperTimer: NodeJS.Timeout | null = null;
  #outboxTimer: NodeJS.Timeout | null = null;
  #pruneTimer: NodeJS.Timeout | null = null;
  #started = false;
  #stopping = false;

  constructor(options: JobRunnerOptions) {
    this.#options = options;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#deferralBackoff = options.deferralBackoff ?? DEFERRAL_BACKOFF;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    for (const queue of JOB_QUEUES) {
      this.#queues.set(queue, {
        concurrency: clampConcurrency(queue, options.concurrency?.[queue]),
        inFlight: 0,
        timer: null,
        transientStreak: 0,
        pausedUntil: 0,
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
    // Первый проход reaper — сразу, до таймера (S41). Воркер поднимается чаще
    // всего именно после того, как предыдущий умер не по своей воле (OOM,
    // выкатка, перезагрузка хоста), и его задачи лежат в `running` с ничьей
    // арендой. Ждать тридцать секунд, чтобы это заметить, — ровно та пауза, в
    // которую пользователь смотрит на замерший конвейер.
    void this.#reapOnce();
    this.#scheduleReaper();
    this.#scheduleOutbox();
    if (this.#options.journalRetention !== undefined) this.#schedulePrune();
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
    if (this.#pruneTimer !== null) clearTimeout(this.#pruneTimer);
    this.#reaperTimer = null;
    this.#outboxTimer = null;
    this.#pruneTimer = null;

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

  /**
   * Снять паузу предохранителя немедленно.
   *
   * Пауза рассчитана на то, что сторона недоступна ещё какое-то время, но это
   * догадка: шлюз мог вернуться через секунду после того, как очередь встала.
   * Ручка нужна тем, кто это знает точно — прогонам обслуживания и тестам,
   * которым иначе пришлось бы ждать настоящую минуту молчания.
   */
  resumeQueues(): void {
    for (const state of this.#queues.values()) {
      state.transientStreak = 0;
      state.pausedUntil = 0;
    }
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

    /**
     * Очередь на паузе после серии транспортных отказов (S41).
     *
     * Возврат нуля означает «ничего не захвачено», и цикл сам заснёт на обычный
     * интервал опроса — отдельного таймера пробуждения не нужно, а лишний
     * заход в БД во время недоступности шлюза ничего не стоит.
     */
    if (state.pausedUntil > Date.now()) return 0;

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

  /**
   * Исход попытки глазами предохранителя очереди.
   *
   * Успех снимает серию немедленно и без условий: одна прошедшая задача —
   * доказательство того, что сторона отвечает, и держать паузу после неё
   * значило бы простаивать на исправном шлюзе.
   */
  #noteOutcome(queue: JobQueue | undefined, outage: boolean, logger: Logger): void {
    if (queue === undefined) return;
    const state = this.#queues.get(queue);
    if (state === undefined) return;

    if (!outage) {
      state.transientStreak = 0;
      state.pausedUntil = 0;
      return;
    }

    state.transientStreak += 1;
    if (state.transientStreak < TRANSIENT_STREAK_LIMIT) return;

    // Пауза растёт с каждым следующим отказом сверх порога: недоступность на
    // минуту и недоступность на час лечатся одинаково, но стоить должны разного.
    const overflow = state.transientStreak - TRANSIENT_STREAK_LIMIT;
    const pauseMs = Math.min(QUEUE_PAUSE_CAP_MS, QUEUE_PAUSE_BASE_MS * 2 ** overflow);
    state.pausedUntil = Date.now() + pauseMs;

    logger.warn(
      {
        event: 'queue_paused',
        queue,
        transient_streak: state.transientStreak,
        pause_ms: pauseMs,
      },
      'очередь приостановлена: сторона недоступна, попытки задач не тратятся впустую',
    );
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

  /**
   * Очистка журнала по срокам хранения.
   *
   * Цикл живёт в каждом процессе с исполнителем задач, но одновременно работает
   * только один: `pruneJournal` берёт advisory-блокировку и не получивший её
   * уходит без работы. Выделять очистку в отдельный процесс или в задачу
   * очереди не за чем — она обслуживает саму наблюдаемость и не должна зависеть
   * от того, жива ли очередь.
   */
  #schedulePrune(): void {
    if (this.#stopping) return;
    const interval = this.#options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.#pruneTimer = setTimeout(() => {
      void this.#pruneOnce().finally(() => {
        this.#schedulePrune();
      });
    }, interval);
    this.#pruneTimer.unref();
  }

  async #pruneOnce(): Promise<void> {
    const retention = this.#options.journalRetention;
    if (retention === undefined) return;

    try {
      const result = await pruneJournal(this.#options.db, retention);
      if (!result.locked) return;
      this.#options.logger.info(
        {
          event: 'journal_pruned',
          samples_deleted: result.samplesDeleted,
          stats_deleted: result.statsDeleted,
        },
        'журнал ошибок очищен по сроку хранения',
      );
    } catch (error) {
      // Очистка — обслуживание: её сбой не должен ни ронять исполнителя, ни
      // прекращать цикл. Но и молчать нельзя, иначе таблица растёт незаметно.
      this.#options.logger.error(
        { event: 'journal_prune_failed', ...errorDigest(error) },
        'не удалось очистить журнал ошибок',
      );
      void this.#options.errorReporter.report(error, {
        execution: 'process',
        extra: { source: 'journal_prune' },
      });
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

          // Сторона отвечает: серия транспортных отказов очереди снимается.
          this.#noteOutcome(definition.queue, false, logger);

          logger.info({ event: 'job_done', duration_ms: durationMs }, 'задача выполнена');
          await this.#emitLifecycle(job, logger, 'job.succeeded', { durationMs });
        } catch (error) {
          /**
           * Отсрочка спрашивается ПЕРВОЙ и только пока попытки не исчерпаны.
           *
           * На последней попытке ожидание обязано стать настоящим отказом:
           * `deferJob` возвращает задачу в очередь безусловно, и отсрочка без
           * потолка оставила бы её там навсегда, а прогон — в `running`. Именно
           * потолок и превращает «ждём» в «не дождались», а обработчики
           * (`withVlmRunTermination`) закрывают по нему свой прогон.
           */
          const deferral = deferralOf(error);
          if (deferral !== null && job.attempt < job.maxAttempts) {
            await this.#finishDeferred(job, startedAt, logger, {
              message: normalizeErrorMessage(messageOfChain(error)),
              retryAfterMs: deferral.retryAfterMs,
            });
            return;
          }

          const { errorClass, permanent } = classifyFailure(error);
          await this.#finishFailed(job, startedAt, logger, {
            errorClass,
            // Сообщение собирается по цепочке `cause`, а не берётся с верхнего
            // уровня: обёртка Drizzle несёт только текст запроса, а причина
            // отказа лежит под ней. Верхний `message` оставлял в
            // `jobs.last_error` дамп SQL без единого слова о том, что именно
            // отвергла база.
            message: normalizeErrorMessage(messageOfChain(error)),
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

  /**
   * Попытка окончена ожиданием, а не неудачей.
   *
   * Три вещи, которых здесь НЕТ, и каждая отсутствует по своей причине.
   *
   * `errorReporter.report` не вызывается: журнал ошибок (§11) дедуплицирует по
   * отпечатку и отвечает на вопрос «сколько раз это уже падало». Ожидание,
   * попав туда, дало бы «vlm.finalize_run: 240 раз» в списке проблем портала —
   * то есть заслонило бы настоящие отказы собственной нормальной работой.
   *
   * Событие ревизии не пишется: лента показывается человеку, и «задача не
   * удалась» раз в минуту всю дорогу распознавания — это не информирование, а
   * шум, в котором тонет единственное сообщение, которое стоило прочесть.
   *
   * Журнал — `info`, а не `warn`: предупреждать не о чем.
   */
  async #finishDeferred(
    job: ClaimedJob,
    startedAt: number,
    logger: Logger,
    deferral: { readonly message: string; readonly retryAfterMs: number | null },
  ): Promise<void> {
    const durationMs = Date.now() - startedAt;
    const retryDelayMs =
      deferral.retryAfterMs ?? backoffDelayMs(job.attempt, this.#deferralBackoff);

    await deferJob(this.#options.db, {
      jobId: job.jobId,
      runId: job.runId,
      workerId: this.#options.workerId,
      durationMs,
      retryDelayMs,
    });

    this.#options.metrics.observeJobRun({
      jobType: job.type,
      outcome: 'deferred',
      durationMs,
    });

    logger.info(
      {
        event: 'job_deferred',
        duration_ms: durationMs,
        attempt: job.attempt,
        max_attempts: job.maxAttempts,
        retry_in_ms: retryDelayMs,
        reason: deferral.message,
      },
      'условие задачи ещё не наступило, попытка отложена',
    );
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
    /**
     * Пауза перед повтором: своя или названная стороной — что больше (S41).
     *
     * Свой откат гадает по номеру попытки, `Retry-After` знает: повтор раньше
     * названного срока получит те же 429 и потратит попытку впустую. Меньшее из
     * двух брать нельзя ни в какую сторону, поэтому именно максимум.
     */
    const retryDelayMs = Math.max(
      backoffDelayMs(job.attempt, this.#backoff),
      retryAfterMsOf(failure.error) ?? 0,
    );

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

    const definitionOfJob = isJobType(job.type) ? jobDefinition(job.type) : undefined;
    this.#noteOutcome(
      definitionOfJob?.queue,
      isTransientOutage(failure.error, definitionOfJob?.queue),
      logger,
    );

    const timedOut = failure.errorClass === 'JobTimeout';
    this.#options.metrics.observeJobRun({
      jobType: job.type,
      outcome: result.dead ? 'dead' : timedOut ? 'timeout' : 'retry',
      durationMs,
    });

    // В журнал уходит исходная ошибка со стеком: там дедупликация по отпечатку,
    // и по ней видно, сколько раз это уже случалось (§11).
    //
    // Стадия берётся из `JOB_DEFINITIONS`, а не из префикса имени задачи.
    // Разбор имени ошибся бы молча на `layout.reconcile` (стадия распознавания,
    // а не разметки) и устаревал бы при каждом новом типе — то есть ровно так,
    // как это уже случилось с классификацией отказов (см. `classifyFailure`).
    const definition = definitionOfJob;
    void this.#options.errorReporter.report(failure.error, {
      jobType: job.type,
      jobId: job.jobId,
      attempt: job.attempt,
      execution: 'job',
      ...(definition?.stage !== undefined && definition.stage !== null
        ? { pipelineStage: definition.stage }
        : {}),
      // Очередь `llm` — это факт о задаче, а не догадка о причине: домен
      // назначается только когда по самой ошибке его определить не удалось.
      ...(definition?.queue === 'llm' && classifyErrorDomain(failure.error) === 'unknown'
        ? { domain: 'llm' as const }
        : {}),
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
