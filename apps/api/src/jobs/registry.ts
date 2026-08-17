/**
 * Реестр обработчиков задач (§12).
 *
 * Реестр отвечает на один вопрос: какие типы задач ЭТОТ процесс умеет
 * выполнять. Из ответа следует главное правило захвата — воркер забирает только
 * те типы, для которых у него есть обработчик. Иначе задача стадии, которая ещё
 * не реализована, была бы захвачена, немедленно провалена и через пять попыток
 * ушла бы в dead; вместо этого она честно ждёт в очереди воркера, который её
 * умеет, и видна в консоли как `queued`.
 *
 * Обработчик получает РАЗОБРАННЫЙ payload: схему применяет runner до вызова, и
 * непригодный payload не доходит до кода стадии, а сразу становится
 * неповторяемым отказом с внятным сообщением.
 */
import type { Logger } from 'pino';
import type { EnqueueJobInput, EnqueueResult, JobExecutor } from '../db/repositories/jobs.js';
import { appendRevisionEvent, reapExpiredLeases } from '../db/repositories/jobs.js';
import type { Database } from '../db/repositories/users.js';
import {
  JOB_TYPES,
  jobTypesOfQueue,
  type JobPayloadMap,
  type JobQueue,
  type JobType,
} from './types.js';

export interface JobContext<K extends JobType = JobType> {
  readonly jobId: string;
  readonly type: K;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Ревизия поставки, если задача к ней относится. */
  readonly revisionId: string | null;
  readonly payload: JobPayloadMap[K];
  readonly db: Database;
  /** Дочерний логгер с `request_id`, `job_type`, `job_id` и номером попытки (§11). */
  readonly logger: Logger;
  /**
   * Отменяется при остановке воркера и при исчерпании потолка попытки.
   *
   * Отмена кооперативная: сигнал нужно проверять в длинных циклах и передавать
   * в `fetch`. Оборвать синхронный код он не может, и обещать этого нельзя.
   */
  readonly signal: AbortSignal;
  /** Постановка следующей задачи конвейера. Область не нужна: ревизия уже наша. */
  enqueue<T extends JobType>(input: EnqueueJobInput<T>): Promise<EnqueueResult>;
  /** Доменное событие ревизии: уходит в SSE (§3.8). */
  emit(eventType: string, payload?: Record<string, unknown>): Promise<void>;
}

export type JobHandler<K extends JobType = JobType> = (ctx: JobContext<K>) => Promise<void>;

/** Хранимый вид обработчика: разбор payload делает runner, поэтому тип стирается. */
type StoredHandler = (ctx: JobContext<never>) => Promise<void>;

export class JobRegistry {
  readonly #handlers = new Map<JobType, StoredHandler>();

  /**
   * Регистрация обработчика.
   *
   * Повторная регистрация — отказ, а не замена: два модуля, объявившие
   * обработчик одного типа, это дефект сборки, и «побеждает последний» скрыл бы
   * его до боевого прогона.
   */
  register<K extends JobType>(type: K, handler: JobHandler<K>): this {
    if (this.#handlers.has(type)) {
      throw new Error(`Обработчик задачи ${type} уже зарегистрирован`);
    }
    this.#handlers.set(type, handler as StoredHandler);
    return this;
  }

  has(type: JobType): boolean {
    return this.#handlers.has(type);
  }

  handlerFor(type: JobType): StoredHandler | undefined {
    return this.#handlers.get(type);
  }

  types(): readonly JobType[] {
    return [...this.#handlers.keys()];
  }

  /** Типы очереди, которые этот процесс умеет: список для захвата. */
  typesOfQueue(queue: JobQueue): readonly JobType[] {
    return jobTypesOfQueue(queue).filter((type) => this.#handlers.has(type));
  }

  /** Объявленные типы без обработчика: воркер пишет их при старте одной строкой. */
  unhandled(): readonly JobType[] {
    return JOB_TYPES.filter((type) => !this.#handlers.has(type));
  }
}

export interface MaintenanceRegistryOptions {
  /** Сколько просроченных аренд освобождать за один проход. */
  readonly reapLimit?: number | undefined;
}

/**
 * Обработчики, которые есть у любого воркера портала.
 *
 * `jobs.reaper` (§12, задача 24) зарегистрирован как обычная задача, хотя runner
 * запускает освобождение аренд ещё и по таймеру. Это не дублирование: таймер —
 * штатный путь, а задача даёт администратору кнопку «прогнать сейчас» в консоли
 * и делает освобождение аренд видимым в `job_runs` наравне с остальными. Обе
 * дороги ведут в одну функцию репозитория, второй реализации нет.
 *
 * Обработчики стадий (`file.verify`, `bundle.build`, `rd.*`, `doc.*`, `checks.*`)
 * регистрируются своими модулями по мере появления — реестр для того и открыт.
 */
export function createMaintenanceRegistry(options: MaintenanceRegistryOptions = {}): JobRegistry {
  const registry = new JobRegistry();

  registry.register('jobs.reaper', async (ctx) => {
    const result = await reapExpiredLeases(ctx.db, { limit: options.reapLimit });
    if (result.requeued > 0) {
      ctx.logger.warn(
        {
          event: 'lease_reaped',
          requeued: result.requeued,
          dead: result.dead,
          closed_runs: result.closedRuns,
        },
        'освобождены просроченные аренды задач',
      );
    }
  });

  return registry;
}

/**
 * Событие ревизии из обработчика.
 *
 * Вынесено сюда, а не в runner: контекст задачи собирает runner, но смысл
 * функции — «как обработчик сообщает о прогрессе», и место ей рядом с
 * определением контекста.
 */
export async function emitRevisionEvent(
  db: JobExecutor,
  revisionId: string | null,
  logger: Logger,
  eventType: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (revisionId === null) {
    // Обслуживающая задача не относится к поставке, и «прицепить» её событие
    // к какой-нибудь ревизии нельзя: лента ревизии — это её история.
    logger.debug({ event: 'revision_event_skipped', event_type: eventType }, 'событие без ревизии');
    return;
  }
  await appendRevisionEvent(db, { revisionId, eventType, ...(payload ? { payload } : {}) });
}
