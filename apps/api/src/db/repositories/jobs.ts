/**
 * Очередь задач, журнал попыток, события ревизии и outbox (§3.8, §12).
 *
 * ## Захват задачи и почему он именно такой
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` в CTE + `UPDATE` в том же операторе:
 * блокировка строки, смена статуса, увеличение попытки и создание строки
 * `job_runs` происходят атомарно. Разбить это на «выбрать → обновить» нельзя —
 * два воркера получили бы одну задачу; разбить на «захватить → записать попытку»
 * тоже нельзя: воркер, умерший между операторами, оставил бы попытку, которой
 * нет в `job_runs`, а `job_runs` — единственный источник ответа на вопрос
 * «сколько реально идёт обработка комплекта» (§11).
 *
 * ## Аренда, а не «взял и держит»
 *
 * `locked_by`/`locked_until` — аренда с сроком. Воркер, убитый сигналом
 * (SIGKILL, OOM, падение узла), не может ничего освободить, поэтому освобождает
 * reaper: `reapExpiredLeases()` возвращает в очередь всё, у чего аренда истекла,
 * и закрывает открытые попытки исходом `lease_expired`. Это тот самый исход, что
 * объявлен в `jobOutcomeSchema`: он не успех и не прикладная ошибка, и склеивать
 * его с `failed` значило бы считать падение воркера дефектом задачи.
 *
 * Живой воркер продлевает аренду сердцебиением (`runner.ts`), поэтому срок
 * аренды — это «через сколько после смерти воркера задачу подберут», а не
 * «сколько задача имеет права выполняться».
 *
 * ## Идемпотентность
 *
 * `dedupe_key` + частичный уникальный индекс `ux_jobs_dedupe_key`
 * (`WHERE dedupe_key IS NOT NULL AND status <> 'done'`). Повторная постановка
 * той же задачи не создаёт вторую, а возвращает идентификатор существующей с
 * `created: false`. Индекс частичный намеренно: он отвечает на вопрос «эта
 * работа уже стоит в очереди?», а не «эта работа когда-либо выполнялась?» —
 * иначе повторная подача комплекта после возврата ревизии не запустила бы
 * конвейер вовсе.
 *
 * ## Область видимости
 *
 * У `jobs` нет ни `object_id`, ни `contractor_id`, и добавлять их сюда нечем:
 * задача ссылается на ревизию через payload. Поэтому видимость выражается
 * подзапросом `EXISTS` по `submission_revisions` с тем же `scopeWhere()`, что и
 * везде. Задача без ревизии (обслуживание) видна только неограниченной области:
 * «показать всем, раз фильтровать не по чему» — это утечка, а не удобство (§16).
 *
 * Писатели (`enqueueSystemJob`, `appendRevisionEvent`, `completeJob`…) области
 * не требуют: их вызывает воркер, у которого пользователя нет. Разбор — в
 * комментарии к `enqueueSystemJob()`.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { jobs, jobRuns, outbox, revisionEvents, submissionRevisions } from '@id/db';
import type { JsonValue, ProcessingStage } from '@id/contracts';
import { isUnrestricted, type AuthScope } from '../../auth/scope.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { conflict, internal, unprocessable } from '../../lib/problem.js';
import {
  isJobType,
  jobDefinition,
  jobTypesOfQueue,
  parseJobPayload,
  revisionIdOf,
  stageOf,
  type JobPayloadMap,
  type JobQueue,
  type JobType,
} from '../../jobs/types.js';
import { appendAudit, type AuditActor } from './audit.js';
import type { Database } from './users.js';

/** Исполнитель: сама база либо транзакция вызывающей операции. */
export type JobExecutor = Pick<Database, 'execute'>;

const REVISION_SCOPE_TARGET: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

/**
 * Форма uuid в тексте payload.
 *
 * Приведение `(payload->>'revisionId')::uuid` без этой проверки даёт 22P02 на
 * любой строке с непригодным значением — то есть одна кривая задача роняла бы
 * весь список задач и всю сводку по ревизии. Постановка задачи payload
 * проверяет, но список читается и по данным, записанным старой версией кода.
 */
const UUID_TEXT = `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`;

const ISO = (expr: string): string =>
  `to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// =====================================================================
// Видимость
// =====================================================================

/** Ревизия задачи в области видимости (или задача без ревизии — для admin/manager). */
function jobVisibility(scope: AuthScope): SQL {
  const unrestricted = isUnrestricted(scope) ? sql`true` : sql`false`;
  return sql`(
    (${jobs.payload} ->> 'revisionId' is null and ${unrestricted})
    or exists (
      select 1 from ${submissionRevisions}
       where ${jobs.payload} ->> 'revisionId' ~ ${UUID_TEXT}
         and ${submissionRevisions.id} = (${jobs.payload} ->> 'revisionId')::uuid
         and ${withScope(scope, REVISION_SCOPE_TARGET)}
    )
  )`;
}

export interface RevisionRef {
  readonly revisionId: string;
  readonly objectId: string;
  readonly contractorId: string;
}

/**
 * Ревизия, видимая области. `null` — «нет такой ревизии ИЛИ она не ваша».
 *
 * Различать эти случаи наружу нельзя: ответ «есть, но не ваша» сам по себе
 * сообщает о существовании чужой поставки.
 */
export async function findVisibleRevision(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<RevisionRef | null> {
  const rows = await db
    .select({
      revisionId: submissionRevisions.id,
      objectId: submissionRevisions.objectId,
      contractorId: submissionRevisions.contractorId,
    })
    .from(submissionRevisions)
    .where(withScope(scope, REVISION_SCOPE_TARGET, eq(submissionRevisions.id, revisionId)))
    .limit(1);
  return rows[0] ?? null;
}

// =====================================================================
// Постановка
// =====================================================================

export interface EnqueueJobInput<K extends JobType = JobType> {
  readonly type: K;
  readonly payload: JobPayloadMap[K];
  /** Ключ идемпотентности. `undefined` — задача ставится безусловно. */
  readonly dedupeKey?: string | undefined;
  /** Отложенный запуск. По умолчанию — немедленно. */
  readonly runAfterMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly priority?: number | undefined;
}

export interface EnqueueResult {
  readonly jobId: string;
  /** `false` — задача с таким `dedupe_key` уже стояла в очереди. */
  readonly created: boolean;
}

/**
 * Постановка задачи пользователем (роут).
 *
 * Ревизия из payload проверяется на принадлежность области: без этого подрядчик
 * ставил бы задачи на чужую поставку, зная только её идентификатор, — а это один
 * из четырёх путей обхода изоляции (§16).
 */
export async function enqueueJob<K extends JobType>(
  db: Database,
  scope: AuthScope,
  input: EnqueueJobInput<K>,
): Promise<EnqueueResult> {
  const revisionId = revisionIdOf(input.payload);
  if (revisionId !== undefined) {
    const revision = await findVisibleRevision(db, scope, revisionId);
    if (revision === null) {
      throw unprocessable(
        [{ pointer: '/payload/revisionId', code: 'not-visible', message: 'Ревизия недоступна.' }],
        'Задача не поставлена: ревизия недоступна.',
      );
    }
  }
  return enqueueSystemJob(db, input);
}

/**
 * Постановка задачи без пользователя: воркер, планировщик, продолжение конвейера.
 *
 * Отдельная функция, а не необязательный аргумент области: у воркера
 * пользователя нет, и подставлять ему «область администратора» значило бы
 * завести значение `AuthScope`, при котором проверка принадлежности проходит
 * всегда. Такое значение однажды приехало бы в роут.
 *
 * Вызывать её разрешено только из `jobs/runner.ts` (продолжение цепочки внутри
 * уже захваченной задачи) и из точки входа воркера (обслуживание). Из
 * обработчиков HTTP — `enqueueJob()` с областью.
 */
export async function enqueueSystemJob<K extends JobType>(
  db: JobExecutor,
  input: EnqueueJobInput<K>,
): Promise<EnqueueResult> {
  const parsed = parseJobPayload(input.type, input.payload);
  if (!parsed.ok) {
    // 500, а не 422: непригодный payload собрал наш же код, и клиенту тут
    // нечего исправлять.
    throw internal({
      logDetail: `payload задачи ${input.type} не прошёл схему: ${parsed.problems.join('; ')}`,
    });
  }

  const definition = jobDefinition(input.type);
  const maxAttempts = input.maxAttempts ?? definition.maxAttempts;
  const priority = input.priority ?? definition.priority;
  const delayMs = Math.max(0, Math.trunc(input.runAfterMs ?? 0));
  const dedupeKey = input.dedupeKey ?? null;

  const inserted = await db.execute<{ id: string }>(sql`
    insert into ${jobs} (type, payload, status, max_attempts, next_run_at, priority, dedupe_key)
    values (
      ${input.type},
      ${JSON.stringify(parsed.payload)}::jsonb,
      'queued',
      ${maxAttempts},
      now() + ${delayMs}::int * interval '1 millisecond',
      ${priority},
      ${dedupeKey}
    )
    on conflict (dedupe_key) where dedupe_key is not null and status <> 'done'
    do nothing
    returning id
  `);

  const created = inserted.rows[0];
  if (created !== undefined) return { jobId: created.id, created: true };

  // Конфликт по ключу: задача уже стоит. Возвращается существующая, а не
  // ошибка — повторная постановка обязана быть безопасной операцией (§12).
  const existing = await db.execute<{ id: string }>(sql`
    select id from ${jobs}
     where dedupe_key = ${dedupeKey} and status <> 'done'
     order by created_at
     limit 1
  `);
  const found = existing.rows[0];
  if (found === undefined) {
    // Между INSERT и SELECT задача успела завершиться: ключ освободился.
    // Повторять здесь нельзя — это был бы бесконечный цикл при активной
    // очереди; вызывающий ставит задачу заново, если она всё ещё нужна.
    throw conflict('Задача с таким ключом только что завершилась. Повторите постановку.');
  }
  return { jobId: found.id, created: false };
}

// =====================================================================
// Захват и жизненный цикл
// =====================================================================

export interface ClaimedJob {
  readonly jobId: string;
  readonly runId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly requestId: string | null;
  readonly revisionId: string | null;
}

export interface ClaimJobsParams {
  readonly workerId: string;
  readonly types: readonly JobType[];
  readonly limit: number;
  readonly leaseMs: number;
}

/**
 * Захват готовых к запуску задач одним оператором.
 *
 * `FOR UPDATE SKIP LOCKED` пропускает строки, заблокированные другим воркером,
 * поэтому два воркера никогда не получают одну задачу и не ждут друг друга.
 * Порядок — `priority DESC, next_run_at`: он совпадает с частичным индексом
 * `ix_jobs_claim`, иначе на очереди в тысячи строк захват стал бы сортировкой
 * всей таблицы.
 *
 * `payload_digest` считается в SQL: `jsonb` хранится с нормализованным порядком
 * ключей, поэтому `payload::text` канонический, а вычисление на стороне Node
 * потребовало бы второго round-trip'а между захватом и записью попытки — то
 * есть окна, в котором попытка есть, а строки о ней нет.
 */
export async function claimJobs(
  db: JobExecutor,
  params: ClaimJobsParams,
): Promise<readonly ClaimedJob[]> {
  if (params.types.length === 0 || params.limit <= 0) return [];

  const result = await db.execute<{
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
    run_id: string;
    request_id: string | null;
    revision_id: string | null;
  }>(sql`
    with candidate as (
      select id from ${jobs}
       where ${jobs.status} = 'queued'
         and ${jobs.nextRunAt} <= now()
         and ${inArray(jobs.type, [...params.types])}
       order by ${jobs.priority} desc, ${jobs.nextRunAt}
       for update skip locked
       limit ${params.limit}
    ),
    claimed as (
      update ${jobs} j
         set status = 'running',
             attempts = j.attempts + 1,
             locked_by = ${params.workerId},
             locked_until = now() + ${params.leaseMs}::int * interval '1 millisecond',
             updated_at = now()
        from candidate c
       where j.id = c.id
      returning j.id, j.type, j.payload, j.attempts, j.max_attempts
    ),
    run as (
      insert into ${jobRuns} (
        job_id, job_type, revision_id, request_id, attempt, payload_digest
      )
      select c.id,
             c.type,
             case when c.payload ->> 'revisionId' ~ ${UUID_TEXT}
                  then (c.payload ->> 'revisionId')::uuid end,
             c.payload ->> 'request_id',
             c.attempts,
             encode(sha256(convert_to(c.payload::text, 'UTF8')), 'hex')
        from claimed c
      returning id, job_id, request_id, revision_id
    )
    select c.id, c.type, c.payload, c.attempts, c.max_attempts,
           r.id as run_id, r.request_id, r.revision_id::text as revision_id
      from claimed c
      join run r on r.job_id = c.id
  `);

  return result.rows.map((row) => ({
    jobId: row.id,
    runId: row.run_id,
    type: row.type,
    payload: row.payload,
    attempt: row.attempts,
    maxAttempts: row.max_attempts,
    requestId: row.request_id,
    revisionId: row.revision_id,
  }));
}

export interface FinishJobParams {
  readonly jobId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly durationMs: number;
}

/**
 * Успешное завершение.
 *
 * Условие `locked_by = <воркер>` не формальность: если аренда истекла и задачу
 * подобрал другой воркер, наш поздний ответ не имеет права перевести её в
 * `done` — работа второго воркера ещё идёт. Возвращается признак применения,
 * чтобы runner записал это в журнал, а не считал завершение состоявшимся.
 */
export async function completeJob(db: Database, params: FinishJobParams): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update ${jobs}
         set status = 'done',
             locked_by = null,
             locked_until = null,
             last_error = null,
             updated_at = now()
       where ${jobs.id} = ${params.jobId} and ${jobs.lockedBy} = ${params.workerId}
      returning id
    `);

    await tx.execute(sql`
      update ${jobRuns}
         set finished_at = now(),
             duration_ms = ${params.durationMs},
             outcome = 'succeeded'
       where ${jobRuns.id} = ${params.runId} and ${jobRuns.outcome} is null
    `);

    return updated.rows.length > 0;
  });
}

export interface FailJobParams extends FinishJobParams {
  readonly errorClass: string;
  /** Уже нормализованное сообщение: значения параметров сюда попадать не должны. */
  readonly errorMessage: string;
  readonly retryDelayMs: number;
  /** Не повторять независимо от числа попыток: неизвестный тип, битый payload. */
  readonly permanent?: boolean | undefined;
}

export interface FailJobResult {
  /** `true` — попыток больше не осталось, задача видна в консоли как dead. */
  readonly dead: boolean;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly applied: boolean;
}

export async function failJob(db: Database, params: FailJobParams): Promise<FailJobResult> {
  return db.transaction(async (tx) => {
    const permanent = params.permanent === true;
    const updated = await tx.execute<{
      status: string;
      attempts: number;
      max_attempts: number;
    }>(sql`
      update ${jobs}
         set status = case
                        when ${permanent} then 'failed'
                        when attempts >= max_attempts then 'failed'
                        else 'queued'
                      end,
             next_run_at = case
                             when ${permanent} or attempts >= max_attempts then next_run_at
                             else now() + ${params.retryDelayMs}::int * interval '1 millisecond'
                           end,
             locked_by = null,
             locked_until = null,
             last_error = ${params.errorMessage},
             updated_at = now()
       where ${jobs.id} = ${params.jobId} and ${jobs.lockedBy} = ${params.workerId}
      returning status, attempts, max_attempts
    `);

    await tx.execute(sql`
      update ${jobRuns}
         set finished_at = now(),
             duration_ms = ${params.durationMs},
             outcome = 'failed',
             error_class = ${params.errorClass},
             error_message = ${params.errorMessage}
       where ${jobRuns.id} = ${params.runId} and ${jobRuns.outcome} is null
    `);

    const row = updated.rows[0];
    if (row === undefined) {
      return { dead: false, attempts: 0, maxAttempts: 0, applied: false };
    }
    return {
      dead: row.status === 'failed',
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      applied: true,
    };
  });
}

/**
 * Продление аренды выполняющейся задачи (сердцебиение воркера).
 *
 * Без продления пришлось бы ставить аренду по самому долгому мыслимому времени
 * выполнения — а тогда задача умершего воркера ждала бы освобождения столько же.
 */
export async function renewLease(
  db: JobExecutor,
  params: { readonly jobId: string; readonly workerId: string; readonly leaseMs: number },
): Promise<boolean> {
  const updated = await db.execute<{ id: string }>(sql`
    update ${jobs}
       set locked_until = now() + ${params.leaseMs}::int * interval '1 millisecond'
     where ${jobs.id} = ${params.jobId}
       and ${jobs.lockedBy} = ${params.workerId}
       and ${jobs.status} = 'running'
    returning id
  `);
  return updated.rows.length > 0;
}

export interface ReapResult {
  readonly requeued: number;
  readonly dead: number;
  readonly closedRuns: number;
}

/**
 * Освобождение просроченных аренд (§12, задача 24).
 *
 * Воркер, убитый сигналом, ничего освободить не может — задача осталась бы в
 * `running` навсегда, и это ровно тот отказ, который не виден: очередь не
 * растёт, ошибок нет, конвейер стоит. Reaper возвращает такие задачи в очередь,
 * а исчерпавшие попытки переводит в `failed`, чтобы они были видны в консоли.
 *
 * Открытые попытки закрываются исходом `lease_expired` (§3.8): считать их
 * прикладной ошибкой нельзя — задача, возможно, отработала целиком и умерла на
 * записи результата.
 */
export async function reapExpiredLeases(
  db: JobExecutor,
  params: { readonly limit?: number | undefined } = {},
): Promise<ReapResult> {
  const limit = params.limit ?? 100;
  const result = await db.execute<{
    requeued: number;
    dead: number;
    closed_runs: number;
  }>(sql`
    with expired as (
      select id from ${jobs}
       where ${jobs.status} = 'running'
         and ${jobs.lockedUntil} is not null
         and ${jobs.lockedUntil} < now()
       order by ${jobs.lockedUntil}
       for update skip locked
       limit ${limit}
    ),
    requeued as (
      update ${jobs} j
         set status = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
             locked_by = null,
             locked_until = null,
             next_run_at = now(),
             last_error = 'аренда истекла: воркер не завершил задачу',
             updated_at = now()
        from expired e
       where j.id = e.id
      returning j.id, j.status
    ),
    closed as (
      update ${jobRuns} r
         set finished_at = now(),
             outcome = 'lease_expired',
             duration_ms = greatest(0, (extract(epoch from (now() - r.started_at)) * 1000)::int),
             error_class = coalesce(r.error_class, 'LeaseExpired'),
             error_message = coalesce(r.error_message, 'аренда истекла: воркер не завершил задачу')
       where r.outcome is null
         and r.job_id in (select id from requeued)
      returning r.id
    )
    select (select count(*) from requeued)::int as requeued,
           (select count(*) from requeued where status = 'failed')::int as dead,
           (select count(*) from closed)::int as closed_runs
  `);

  const row = result.rows[0];
  return {
    requeued: row?.requeued ?? 0,
    dead: row?.dead ?? 0,
    closedRuns: row?.closed_runs ?? 0,
  };
}

// =====================================================================
// Консоль задач (§14)
// =====================================================================

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobView {
  readonly id: string;
  readonly type: string;
  readonly queue: JobQueue | null;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly nextRunAt: string;
  readonly lockedBy: string | null;
  readonly lockedUntil: string | null;
  readonly lastError: string | null;
  readonly dedupeKey: string | null;
  readonly revisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Исчерпала попытки и ждёт решения человека. */
  readonly isDead: boolean;
}

export interface ListJobsParams {
  readonly status?: JobStatus | undefined;
  readonly type?: string | undefined;
  readonly queue?: JobQueue | undefined;
  readonly revisionId?: string | undefined;
  /** Только исчерпавшие попытки: главный экран консоли. */
  readonly deadOnly?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface JobPage {
  readonly items: readonly JobView[];
  readonly nextCursor: string | null;
}

const jobCursorSchema = z.object({ createdAt: z.string(), id: z.string() });

const JOB_COLUMNS = sql`
  ${jobs.id} as id,
  ${jobs.type} as type,
  ${jobs.status} as status,
  ${jobs.attempts} as attempts,
  ${jobs.maxAttempts} as max_attempts,
  ${jobs.priority} as priority,
  ${sql.raw(ISO('jobs.next_run_at'))} as next_run_at,
  ${jobs.lockedBy} as locked_by,
  ${sql.raw(ISO('jobs.locked_until'))} as locked_until,
  ${jobs.lastError} as last_error,
  ${jobs.dedupeKey} as dedupe_key,
  ${jobs.payload} ->> 'revisionId' as revision_id,
  ${sql.raw(ISO('jobs.created_at'))} as created_at,
  ${sql.raw(ISO('jobs.updated_at'))} as updated_at,
  ${sql.raw('jobs.created_at')} as cursor_at
`;

/**
 * Строка `jobs` как её отдаёт драйвер.
 *
 * Наследование от `Record<string, unknown>` обязательно: `db.execute<T>()`
 * требует индексной сигнатуры, а у интерфейса, в отличие от псевдонима типа,
 * она не выводится сама.
 */
interface JobRawRow extends Record<string, unknown> {
  id: string;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  priority: number;
  next_run_at: string;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  revision_id: string | null;
  created_at: string;
  updated_at: string;
  cursor_at: string | Date;
}

/**
 * Список задач для консоли администратора.
 *
 * Курсор — по `(created_at, id)`, а не по смещению: новая задача, поставленная
 * между страницами, иначе сдвигала бы выдачу и прятала строку.
 */
export async function listJobs(
  db: Database,
  scope: AuthScope,
  params: ListJobsParams,
): Promise<JobPage> {
  const after = decodeCursor(jobCursorSchema, params.cursor);
  const conditions: SQL[] = [jobVisibility(scope)];

  if (params.status !== undefined) conditions.push(sql`${jobs.status} = ${params.status}`);
  if (params.type !== undefined) conditions.push(sql`${jobs.type} = ${params.type}`);
  if (params.queue !== undefined) {
    const types = jobTypesOfQueue(params.queue);
    conditions.push(types.length === 0 ? sql`false` : inArray(jobs.type, [...types]));
  }
  if (params.revisionId !== undefined) {
    conditions.push(sql`${jobs.payload} ->> 'revisionId' = ${params.revisionId}`);
  }
  if (params.deadOnly === true) {
    conditions.push(sql`${jobs.status} = 'failed'`);
  }
  if (after !== null) {
    conditions.push(
      sql`(${jobs.createdAt}, ${jobs.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    );
  }

  const where = and(...conditions) ?? sql`true`;
  const rows = await db.execute<JobRawRow>(sql`
    select ${JOB_COLUMNS}
      from ${jobs}
     where ${where}
     order by ${jobs.createdAt} desc, ${jobs.id} desc
     limit ${params.limit + 1}
  `);

  const page = rows.rows.slice(0, params.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toJobView),
    nextCursor:
      rows.rows.length > params.limit && last !== undefined
        ? encodeCursor({ createdAt: isoOf(last.cursor_at), id: last.id })
        : null,
  };
}

export async function findJob(
  db: Database,
  scope: AuthScope,
  jobId: string,
): Promise<JobView | null> {
  const rows = await db.execute<JobRawRow>(sql`
    select ${JOB_COLUMNS}
      from ${jobs}
     where ${jobs.id} = ${jobId} and ${jobVisibility(scope)}
     limit 1
  `);
  const row = rows.rows[0];
  return row === undefined ? null : toJobView(row);
}

export interface JobRunView {
  readonly id: string;
  readonly jobId: string | null;
  readonly jobType: string;
  readonly revisionId: string | null;
  readonly requestId: string | null;
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: string | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
}

/**
 * Попытки задачи или ревизии.
 *
 * Это и есть ответ на «сколько реально идёт обработка комплекта» (§11):
 * длительность каждой попытки, а не одно поле статуса, за которым не видно ни
 * повторов, ни параллельных стадий.
 */
export async function listJobRuns(
  db: Database,
  scope: AuthScope,
  params: {
    readonly jobId?: string | undefined;
    readonly revisionId?: string | undefined;
    readonly limit: number;
  },
): Promise<readonly JobRunView[]> {
  const conditions: SQL[] = [];

  if (params.jobId !== undefined) {
    // Видимость самой задачи: попытки чужой задачи — это её payload и тайминги.
    const job = await findJob(db, scope, params.jobId);
    if (job === null) return [];
    conditions.push(eq(jobRuns.jobId, params.jobId));
  }

  if (params.revisionId !== undefined) {
    const revision = await findVisibleRevision(db, scope, params.revisionId);
    if (revision === null) return [];
    conditions.push(eq(jobRuns.revisionId, params.revisionId));
  }

  if (conditions.length === 0) {
    // Без фильтра список попыток пришлось бы ограничивать областью построчно,
    // а у попытки обслуживающей задачи ревизии нет. Неограниченной области
    // отдаётся всё, ограниченной — ничего: «показать, что найдётся» здесь
    // означало бы выдачу чужих таймингов.
    conditions.push(isUnrestricted(scope) ? sql`true` : sql`false`);
  }

  const rows = await db
    .select({
      id: jobRuns.id,
      jobId: jobRuns.jobId,
      jobType: jobRuns.jobType,
      revisionId: jobRuns.revisionId,
      requestId: jobRuns.requestId,
      attempt: jobRuns.attempt,
      startedAt: sql<string>`${sql.raw(ISO('job_runs.started_at'))}`.as('started_at_iso'),
      finishedAt: sql<string | null>`${sql.raw(ISO('job_runs.finished_at'))}`.as('finished_at_iso'),
      durationMs: jobRuns.durationMs,
      outcome: jobRuns.outcome,
      errorClass: jobRuns.errorClass,
      errorMessage: jobRuns.errorMessage,
    })
    .from(jobRuns)
    .where(and(...conditions))
    .orderBy(desc(jobRuns.startedAt))
    .limit(params.limit);

  return rows;
}

/**
 * Ручной повтор задачи, исчерпавшей попытки (§12).
 *
 * Повышается потолок попыток, а не обнуляется счётчик: история попыток в
 * `job_runs` обязана остаться сплошной, иначе «задача падала шесть раз» станет
 * неотличимо от «задача выполняется впервые». След в `audit_log` пишется той же
 * транзакцией — перезапуск задачи меняет состояние поставки, и «кто перезапустил»
 * обязано быть отвечаемо (урок S4).
 */
export async function retryJob(
  db: Database,
  scope: AuthScope,
  jobId: string,
  actor: AuditActor,
): Promise<JobView | null> {
  const job = await findJob(db, scope, jobId);
  if (job === null) return null;
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    throw conflict('Повторить можно только задачу, исчерпавшую попытки или отменённую.');
  }

  await db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update ${jobs}
         set status = 'queued',
             max_attempts = attempts + 1,
             next_run_at = now(),
             locked_by = null,
             locked_until = null,
             updated_at = now()
       where ${jobs.id} = ${jobId} and ${jobs.status} in ('failed', 'cancelled')
      returning id
    `);
    if (updated.rows.length === 0) return;

    await appendAudit(tx, scope, {
      ...actor,
      action: 'job.retried',
      entityType: 'job',
      entityId: jobId,
      objectId: await objectIdOfRevision(tx, job.revisionId),
      payload: { type: job.type, attempts: job.attempts, previousStatus: job.status },
    });
  });

  return findJob(db, scope, jobId);
}

/**
 * Отмена задачи.
 *
 * Отменяются только ожидающие и мёртвые: пометить `cancelled` выполняющуюся
 * задачу значило бы соврать — воркер о смене статуса не узнает и доработает её
 * до конца, а консоль показала бы отмену.
 */
export async function cancelJob(
  db: Database,
  scope: AuthScope,
  jobId: string,
  actor: AuditActor,
): Promise<JobView | null> {
  const job = await findJob(db, scope, jobId);
  if (job === null) return null;
  if (job.status === 'running') {
    throw conflict('Выполняющаяся задача не отменяется: дождитесь окончания попытки.');
  }
  if (job.status === 'done' || job.status === 'cancelled') {
    throw conflict('Задача уже завершена.');
  }

  await db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update ${jobs}
         set status = 'cancelled', locked_by = null, locked_until = null, updated_at = now()
       where ${jobs.id} = ${jobId} and ${jobs.status} in ('queued', 'failed')
      returning id
    `);
    if (updated.rows.length === 0) return;

    await tx.execute(sql`
      update ${jobRuns}
         set finished_at = now(), outcome = 'cancelled'
       where ${jobRuns.jobId} = ${jobId} and ${jobRuns.outcome} is null
    `);

    await appendAudit(tx, scope, {
      ...actor,
      action: 'job.cancelled',
      entityType: 'job',
      entityId: jobId,
      objectId: await objectIdOfRevision(tx, job.revisionId),
      payload: { type: job.type, previousStatus: job.status },
    });
  });

  return findJob(db, scope, jobId);
}

export interface QueueDepthRow {
  readonly jobType: string;
  readonly status: string;
  readonly count: number;
}

export interface QueueSnapshotRows {
  readonly depths: readonly QueueDepthRow[];
  readonly dead: readonly { readonly jobType: string; readonly count: number }[];
}

/**
 * Глубина очереди для метрик и экрана диагностики.
 *
 * Области видимости здесь нет намеренно: это агрегат по типам задач без единого
 * идентификатора поставки. `/metrics` наружу не публикуется (§11), а консоль
 * закрыта правом `diagnostics.read`.
 */
export async function queueSnapshot(db: JobExecutor): Promise<QueueSnapshotRows> {
  const rows = await db.execute<{ job_type: string; status: string; count: number }>(sql`
    select ${jobs.type} as job_type, ${jobs.status} as status, count(*)::int as count
      from ${jobs}
     where ${jobs.status} in ('queued', 'running', 'failed')
     group by 1, 2
  `);

  const depths = rows.rows.map((row) => ({
    jobType: row.job_type,
    status: row.status,
    count: row.count,
  }));

  return {
    depths,
    dead: depths
      .filter((row) => row.status === 'failed')
      .map((row) => ({ jobType: row.jobType, count: row.count })),
  };
}

// =====================================================================
// Вычисляемый processing_status (§3.8)
// =====================================================================

/** Порядок стадий конвейера: по нему выбирается сводная стадия ревизии. */
const STAGE_ORDER: readonly ProcessingStage[] = [
  'uploaded',
  'layout',
  'recognition',
  'analysis',
  'checks',
  'ready',
];

export interface JobTypeSummary {
  readonly jobType: string;
  readonly stage: ProcessingStage | null;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly leaseExpired: number;
  readonly inFlight: number;
  readonly totalDurationMs: number;
  readonly firstStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastErrorClass: string | null;
  readonly lastErrorMessage: string | null;
}

export interface StageSummary {
  readonly stage: ProcessingStage;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly inFlight: number;
  readonly pending: number;
  readonly totalDurationMs: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface ProcessingStatus {
  readonly revisionId: string;
  /** Сводная стадия: самая дальняя, где была активность; `failed` при мёртвых задачах. */
  readonly stage: ProcessingStage;
  readonly queued: number;
  readonly running: number;
  readonly dead: number;
  readonly attempts: number;
  /** Сумма длительностей завершённых попыток — ответ на вопрос «сколько идёт». */
  readonly totalDurationMs: number;
  /** Календарное время от первой попытки до последней завершённой. */
  readonly elapsedMs: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stages: readonly StageSummary[];
  readonly jobTypes: readonly JobTypeSummary[];
}

/**
 * Сводка обработки ревизии — ВЫЧИСЛЯЕМАЯ, а не хранимая (§3.8, §0.3 п.5).
 *
 * Хранимое поле `processing_status` скрывало бы попытки и параллельные стадии, а
 * при падении воркера навсегда осталось бы врать: «распознавание» у ревизии, где
 * воркер умер полчаса назад. Здесь тот же вопрос отвечается агрегатом над
 * `job_runs` и `jobs`, то есть по фактам, и при остановке воркера сводка честно
 * показывает задачи в очереди и ни одной выполняющейся.
 *
 * `null` — ревизия не видна области: это 404 на уровне маршрута.
 */
export async function computeProcessingStatus(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<ProcessingStatus | null> {
  const revision = await findVisibleRevision(db, scope, revisionId);
  if (revision === null) return null;

  const runRows = await db.execute<{
    job_type: string;
    attempts: number;
    succeeded: number;
    failed: number;
    lease_expired: number;
    in_flight: number;
    total_duration_ms: number;
    first_started_at: string | null;
    last_finished_at: string | null;
    last_error_class: string | null;
    last_error_message: string | null;
  }>(sql`
    select job_type,
           count(*)::int as attempts,
           count(*) filter (where outcome = 'succeeded')::int as succeeded,
           count(*) filter (where outcome = 'failed')::int as failed,
           count(*) filter (where outcome = 'lease_expired')::int as lease_expired,
           count(*) filter (where outcome is null)::int as in_flight,
           coalesce(sum(duration_ms), 0)::int as total_duration_ms,
           ${sql.raw(ISO('min(started_at)'))} as first_started_at,
           ${sql.raw(ISO('max(finished_at)'))} as last_finished_at,
           (array_agg(error_class order by started_at desc)
              filter (where error_class is not null))[1] as last_error_class,
           (array_agg(error_message order by started_at desc)
              filter (where error_message is not null))[1] as last_error_message
      from ${jobRuns}
     where ${jobRuns.revisionId} = ${revisionId}
     group by job_type
  `);

  const pendingRows = await db.execute<{ type: string; status: string; count: number }>(sql`
    select ${jobs.type} as type, ${jobs.status} as status, count(*)::int as count
      from ${jobs}
     where ${jobs.payload} ->> 'revisionId' = ${revisionId}
       and ${jobs.status} in ('queued', 'running', 'failed')
     group by 1, 2
  `);

  const jobTypes: JobTypeSummary[] = runRows.rows.map((row) => ({
    jobType: row.job_type,
    stage: isJobType(row.job_type) ? stageOf(row.job_type) : null,
    attempts: row.attempts,
    succeeded: row.succeeded,
    failed: row.failed,
    leaseExpired: row.lease_expired,
    inFlight: row.in_flight,
    totalDurationMs: row.total_duration_ms,
    firstStartedAt: row.first_started_at,
    lastFinishedAt: row.last_finished_at,
    lastErrorClass: row.last_error_class,
    lastErrorMessage: row.last_error_message,
  }));

  let queued = 0;
  let running = 0;
  let dead = 0;
  const pendingByStage = new Map<ProcessingStage, number>();
  for (const row of pendingRows.rows) {
    if (row.status === 'queued') queued += row.count;
    if (row.status === 'running') running += row.count;
    if (row.status === 'failed') dead += row.count;
    const stage = isJobType(row.type) ? stageOf(row.type) : null;
    if (stage !== null && row.status !== 'failed') {
      pendingByStage.set(stage, (pendingByStage.get(stage) ?? 0) + row.count);
    }
  }

  const stages: StageSummary[] = STAGE_ORDER.map((stage) => {
    const own = jobTypes.filter((summary) => summary.stage === stage);
    const startedAt = minIso(own.map((s) => s.firstStartedAt));
    const finishedAt = maxIso(own.map((s) => s.lastFinishedAt));
    return {
      stage,
      attempts: sum(own.map((s) => s.attempts)),
      succeeded: sum(own.map((s) => s.succeeded)),
      failed: sum(own.map((s) => s.failed)),
      inFlight: sum(own.map((s) => s.inFlight)),
      pending: pendingByStage.get(stage) ?? 0,
      totalDurationMs: sum(own.map((s) => s.totalDurationMs)),
      startedAt,
      finishedAt,
    };
  }).filter((summary) => summary.attempts > 0 || summary.pending > 0);

  const startedAt = minIso(jobTypes.map((s) => s.firstStartedAt));
  const finishedAt = maxIso(jobTypes.map((s) => s.lastFinishedAt));

  return {
    revisionId,
    stage: summaryStage(stages, dead),
    queued,
    running,
    dead,
    attempts: sum(jobTypes.map((s) => s.attempts)),
    totalDurationMs: sum(jobTypes.map((s) => s.totalDurationMs)),
    elapsedMs:
      startedAt === null || finishedAt === null
        ? null
        : Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    startedAt,
    finishedAt,
    stages,
    jobTypes,
  };
}

/**
 * Сводная стадия.
 *
 * Мёртвая задача важнее любой активности: комплект, у которого задача исчерпала
 * попытки, не «на распознавании», он стоит и ждёт человека. В остальном берётся
 * самая дальняя стадия с активностью — конвейер линейный, и возврат к предыдущей
 * стадии означает новый прогон, который сам станет самой дальней.
 */
function summaryStage(stages: readonly StageSummary[], dead: number): ProcessingStage {
  if (dead > 0) return 'failed';
  let result: ProcessingStage = 'uploaded';
  for (const stage of STAGE_ORDER) {
    if (stages.some((summary) => summary.stage === stage)) result = stage;
  }
  return result;
}

// =====================================================================
// События ревизии (§3.8) и outbox
// =====================================================================

export interface RevisionEventView {
  readonly seq: number;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface AppendRevisionEventInput {
  readonly revisionId: string;
  readonly eventType: string;
  readonly payload?: Record<string, unknown> | undefined;
}

/**
 * Сколько раз пытаться занять свободный `seq`.
 *
 * Лишний проход — это оператор, который УЖЕ ДОЖДАЛСЯ чужой транзакции (см. ниже
 * про спекулятивную вставку), а не холостой оборот, поэтому неограниченный цикл
 * означал бы удержание соединения ровно столько, сколько идёт чужая работа.
 * Восемь одновременных писателей по ОДНОЙ ревизии уже за пределом наблюдаемого,
 * и исчерпание лимита теперь честно означает затор, а не проглоченную ошибку.
 */
const APPEND_EVENT_MAX_TRIES = 8;

/**
 * Событие ревизии с монотонным `seq`.
 *
 * Номер назначается в SQL (`max(seq) + 1` по этой ревизии), а не счётчиком в
 * приложении: два процесса иначе выдали бы один номер, и SSE-клиент с
 * `Last-Event-ID` пропустил бы событие навсегда (`modules/events/sse.ts`).
 *
 * ## Гонка разрешается БЕЗ исключения, и в этом вся суть
 *
 * При READ COMMITTED гонка неизбежна — оба писателя видят один `max`. Но голое
 * нарушение первичного ключа абортирует ВСЮ транзакцию PostgreSQL, а почти все
 * вызывающие передают сюда `tx` изнутри `db.transaction()` (`finishRecognitionRun`,
 * `layout.ts`, `documents.ts`, `navigation.ts`, `workflow.ts`, `bundles.ts`), и
 * SAVEPOINT в проекте не берётся нигде. То есть прежняя схема «поймать 23505 и
 * повторить» не могла работать в принципе: повторять внутри аборченной транзакции
 * нечего, следующий оператор получил бы 25P02. Вдобавок она молчала дважды — её
 * распознаватель читал `code` с верхнего уровня, а Drizzle 0.45 прячет его в
 * `cause` (см. `db/driver-errors.ts`), — так что повтор не срабатывал ни разу.
 *
 * Цена этого молчания видна в проде: запись события `recognition.failed` упала на
 * `revision_events_pkey`, и в журнале задачи осталось «duplicate key» ВМЕСТО
 * настоящей причины отказа распознавания. Отчёт об ошибке не имеет права быть тем
 * местом, где ошибка теряется.
 *
 * ## Почему цикл не вечен и не крутится вхолостую
 *
 * `on conflict do nothing` даёт пустой `rows` вместо исключения. Пустым он
 * окажется только ПОСЛЕ того, как конкурент завершился: на незакоммиченный дубль
 * PostgreSQL не падает и не пропускает строку сразу, а ждёт исхода чужой
 * транзакции (спекулятивная вставка). Каждый следующий проход берёт новый снимок
 * READ COMMITTED, где чужой номер уже виден, и `max(seq) + 1` даёт следующий
 * свободный. Схема ОПИРАЕТСЯ на READ COMMITTED: при REPEATABLE READ снимок между
 * операторами не обновлялся бы и повтор стал бы бессмысленным. Уровень изоляции в
 * проекте нигде не поднимается — если это изменится, менять придётся и здесь.
 *
 * ## Почему не sequence и не счётчик в строке ревизии
 *
 * `max(seq)` считается по ЗАФИКСИРОВАННЫМ строкам, поэтому откат чужой транзакции
 * номер не сжигает и дыр не возникает. Последовательность оставляет дыру на каждом
 * откате, а счётчик в `submission_revisions` ещё и держит блокировку этой строки до
 * конца транзакции, то есть заводит взаимоблокировку с любым кодом, который сначала
 * правит ревизию, а потом пишет событие (`workflow.ts`, `navigation.ts` — именно
 * такие). Дыры небезобидны: SSE отличает «пропущенное вне окна хранения» от «ничего
 * нового» сравнением `cursor + 1 < oldestSeq`, и на дырявой ленте это ложный `reset`.
 *
 * Области видимости у писателя нет: события пишет конвейер, у которого
 * пользователя нет. Читатель (`listRevisionEvents`) область проверяет.
 */
export async function appendRevisionEvent(
  db: JobExecutor,
  input: AppendRevisionEventInput,
): Promise<number> {
  const payload = JSON.stringify(input.payload ?? {});

  for (let attempt = 1; attempt <= APPEND_EVENT_MAX_TRIES; attempt += 1) {
    // Ошибка драйвера наружу выходит как есть и повтора не получает: отказ записи
    // события обязан быть виден, а не растворён в цикле.
    const inserted = await db.execute<{ seq: string | number }>(sql`
      insert into ${revisionEvents} (revision_id, seq, event_type, payload)
      select ${input.revisionId}::uuid,
             coalesce(max(seq), 0) + 1,
             ${input.eventType},
             ${payload}::jsonb
        from ${revisionEvents}
       where ${revisionEvents.revisionId} = ${input.revisionId}::uuid
      on conflict (revision_id, seq) do nothing
      returning seq
    `);
    // Пустой `rows` — это штатный проигрыш гонки, а не сбой: агрегат без `group by`
    // всегда даёт ровно одну строку-кандидата, значит `rows.length ∈ {0, 1}`.
    const row = inserted.rows[0];
    if (row !== undefined) return Number(row.seq);
  }

  // 500, а не 409: конкуренция за номер события — целиком наша внутренняя
  // механика, и клиенту тут нечего повторять.
  throw internal({
    logDetail:
      `не удалось назначить seq события ${input.eventType} ревизии ${input.revisionId}: ` +
      `${String(APPEND_EVENT_MAX_TRIES)} подряд проигранных гонок за номер`,
  });
}

export interface RevisionEventWindow {
  readonly events: readonly RevisionEventView[];
  /** Наименьший сохранённый `seq`. Нужен SSE, чтобы отличить «нет нового» от «уже стёрто». */
  readonly oldestSeq: number | null;
  readonly latestSeq: number | null;
}

/**
 * Окно событий ревизии для SSE.
 *
 * `null` — ревизия не видна области. Проверка обязательна: поток событий — один
 * из четырёх путей обхода изоляции (§16), и «подписаться по прямому id» не
 * должно давать подрядчику чужие события.
 */
export async function listRevisionEvents(
  db: Database,
  scope: AuthScope,
  params: {
    readonly revisionId: string;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  },
): Promise<RevisionEventWindow | null> {
  const revision = await findVisibleRevision(db, scope, params.revisionId);
  if (revision === null) return null;
  return readRevisionEvents(db, params);
}

/**
 * То же без проверки области — для уже проверенного потока.
 *
 * SSE проверяет принадлежность ревизии один раз при открытии соединения и потом
 * опрашивает окно каждую секунду. Повторять проверку на каждом опросе значило бы
 * три запроса в секунду на соединение вместо одного; принадлежность ревизии
 * области при этом не меняется — ни объект, ни подрядчик у ревизии не
 * переписываются (§3.9).
 */
export async function readRevisionEvents(
  db: JobExecutor,
  params: {
    readonly revisionId: string;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  },
): Promise<RevisionEventWindow> {
  const afterSeq = params.afterSeq ?? 0;

  const rows = await db.execute<{
    seq: string | number;
    event_type: string;
    payload: unknown;
    created_at: string;
  }>(sql`
    select seq, event_type, payload, ${sql.raw(ISO('created_at'))} as created_at
      from ${revisionEvents}
     where ${revisionEvents.revisionId} = ${params.revisionId}::uuid
       and ${revisionEvents.seq} > ${afterSeq}
     order by seq
     limit ${params.limit}
  `);

  const bounds = await db.execute<{
    oldest: string | number | null;
    latest: string | number | null;
  }>(
    sql`
      select min(seq) as oldest, max(seq) as latest
        from ${revisionEvents}
       where ${revisionEvents.revisionId} = ${params.revisionId}::uuid
    `,
  );
  const bound = bounds.rows[0];

  return {
    events: rows.rows.map((row) => ({
      seq: Number(row.seq),
      eventType: row.event_type,
      payload: (row.payload ?? {}) as JsonValue,
      createdAt: row.created_at,
    })),
    oldestSeq: bound?.oldest == null ? null : Number(bound.oldest),
    latestSeq: bound?.latest == null ? null : Number(bound.latest),
  };
}

export interface OutboxRecord {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload?: Record<string, unknown> | undefined;
}

/**
 * Запись в outbox — из ТОЙ ЖЕ транзакции, что и изменение состояния.
 *
 * Смысл outbox именно в этом: событие и изменение либо оба состоялись, либо оба
 * нет. Публикация (перенос в `revision_events`, а в будущем — во внешние
 * подписки) идёт отдельным проходом `publishOutboxBatch()`, потому что она может
 * не удаться, и тянуть за собой откат бизнес-операции не должна.
 */
export async function appendOutbox(db: JobExecutor, record: OutboxRecord): Promise<void> {
  await db.execute(sql`
    insert into ${outbox} (aggregate_type, aggregate_id, event_type, payload)
    values (
      ${record.aggregateType},
      ${record.aggregateId}::uuid,
      ${record.eventType},
      ${JSON.stringify(record.payload ?? {})}::jsonb
    )
  `);
}

export const OUTBOX_REVISION_AGGREGATE = 'submission_revision';

export interface PublishOutboxResult {
  readonly published: number;
  readonly events: number;
}

/**
 * Перенос неопубликованных записей outbox в события ревизии.
 *
 * Две таблицы не дублируют друг друга: `outbox` — это транзакционная запись
 * «событие произошло», а `revision_events` — упорядоченная лента с `seq`, по
 * которой SSE умеет replay (§3.8). Записи о других агрегатах помечаются
 * опубликованными без переноса: у них потребителя пока нет, и держать их вечно
 * неопубликованными значило бы, что счётчик отставания outbox всегда красный.
 */
export async function publishOutboxBatch(
  db: Database,
  params: { readonly limit?: number | undefined } = {},
): Promise<PublishOutboxResult> {
  const limit = params.limit ?? 100;

  return db.transaction(async (tx) => {
    const pending = await tx.execute<{
      id: string | number;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: unknown;
    }>(sql`
      select id, aggregate_type, aggregate_id, event_type, payload
        from ${outbox}
       where ${outbox.publishedAt} is null
       order by id
       for update skip locked
       limit ${limit}
    `);

    let events = 0;
    for (const row of pending.rows) {
      if (row.aggregate_type === OUTBOX_REVISION_AGGREGATE) {
        await appendRevisionEvent(tx, {
          revisionId: row.aggregate_id,
          eventType: row.event_type,
          payload: (row.payload ?? {}) as Record<string, unknown>,
        });
        events += 1;
      }
      await tx.execute(sql`
        update ${outbox} set published_at = now() where ${outbox.id} = ${row.id}
      `);
    }

    return { published: pending.rows.length, events };
  });
}

// =====================================================================
// Мелкие помощники
// =====================================================================

function toJobView(row: JobRawRow): JobView {
  const status = (JOB_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as JobStatus)
    : 'queued';
  return {
    id: row.id,
    type: row.type,
    queue: isJobType(row.type) ? jobDefinition(row.type).queue : null,
    status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    nextRunAt: row.next_run_at,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    lastError: row.last_error,
    dedupeKey: row.dedupe_key,
    revisionId: row.revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDead: status === 'failed',
  };
}

async function objectIdOfRevision(
  executor: JobExecutor,
  revisionId: string | null,
): Promise<string | null> {
  if (revisionId === null) return null;
  const rows = await executor.execute<{ object_id: string }>(sql`
    select object_id from ${submissionRevisions}
     where ${submissionRevisions.id} = ${revisionId}::uuid
     limit 1
  `);
  return rows.rows[0]?.object_id ?? null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function minIso(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null);
  return present.length === 0 ? null : present.reduce((a, b) => (a < b ? a : b));
}

function maxIso(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null);
  return present.length === 0 ? null : present.reduce((a, b) => (a > b ? a : b));
}

function isoOf(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(schema: z.ZodType<T>, raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    // Непригодный курсор — это первая страница, а не 500: значение
    // непрозрачно для клиента и могло устареть между релизами.
    return null;
  }
}
