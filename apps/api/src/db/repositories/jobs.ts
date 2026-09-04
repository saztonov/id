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
 * (`WHERE dedupe_key IS NOT NULL AND status NOT IN ('done', 'cancelled')`).
 * Повторная постановка той же задачи не создаёт вторую, а возвращает
 * идентификатор существующей с `created: false`. Индекс частичный намеренно: он
 * отвечает на вопрос «эта работа уже стоит в очереди?», а не «эта работа
 * когда-либо выполнялась?» — иначе повторная подача комплекта после возврата
 * ревизии не запустила бы конвейер вовсе.
 *
 * Три терминальных состояния ведут себя по-разному, и разница смысловая:
 * `done` — работа сделана, ключ свободен; `cancelled` (0039) — работу СНЯЛИ
 * сами, значит следующее нажатие обязано поставить её заново; `failed` — задача
 * исчерпала попытки, ключ занят, и это единственный способ не дать конвейеру
 * молча пересоздавать то, что уже отказало насмерть. Мёртвую задачу разбирает
 * человек — консолью или кнопкой «повторить».
 *
 * ## Область видимости
 *
 * У `jobs` нет ни `object_id`, ни `contractor_id`, и добавлять их сюда нечем:
 * задача ссылается на ревизию через payload. Поэтому видимость выражается
 * подзапросом `EXISTS` по `folders` с тем же `scopeWhere()`, что и
 * везде. Задача без ревизии (обслуживание) видна только неограниченной области:
 * «показать всем, раз фильтровать не по чему» — это утечка, а не удобство (§16).
 *
 * Писатели (`enqueueSystemJob`, `appendFolderEvent`, `completeJob`…) области
 * не требуют: их вызывает воркер, у которого пользователя нет. Разбор — в
 * комментарии к `enqueueSystemJob()`.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { jobs, jobRuns, outbox, folderEvents, folders } from '@id/db';
import type { JsonValue, ProcessingStage } from '@id/contracts';
import { isUnrestricted, type AuthScope } from '../../auth/scope.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { conflict, internal, unprocessable } from '../../lib/problem.js';
import {
  isJobType,
  jobDefinition,
  JOB_TYPES,
  jobTypesOfQueue,
  parseJobPayload,
  folderIdOf,
  stageOf,
  type JobPayloadMap,
  type JobQueue,
  type JobType,
} from '../../jobs/types.js';
import { appendAudit, type AuditActor } from './audit.js';
import type { Database } from './users.js';

/** Исполнитель: сама база либо транзакция вызывающей операции. */
export type JobExecutor = Pick<Database, 'execute'>;

const FOLDER_SCOPE_TARGET: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/**
 * Форма uuid в тексте payload.
 *
 * Приведение `(payload->>'folderId')::uuid` без этой проверки даёт 22P02 на
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
    (${jobs.payload} ->> 'folderId' is null and ${unrestricted})
    or exists (
      select 1 from ${folders}
       where ${jobs.payload} ->> 'folderId' ~ ${UUID_TEXT}
         and ${folders.id} = (${jobs.payload} ->> 'folderId')::uuid
         and ${withScope(scope, FOLDER_SCOPE_TARGET)}
    )
  )`;
}

export interface FolderRef {
  readonly folderId: string;
  readonly objectId: string;
  readonly contractorId: string;
}

/**
 * Ревизия, видимая области. `null` — «нет такой ревизии ИЛИ она не ваша».
 *
 * Различать эти случаи наружу нельзя: ответ «есть, но не ваша» сам по себе
 * сообщает о существовании чужой поставки.
 */
export async function findVisibleFolder(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<FolderRef | null> {
  const rows = await db
    .select({
      folderId: folders.id,
      objectId: folders.objectId,
      contractorId: folders.contractorId,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE_TARGET, eq(folders.id, folderId)))
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
  const folderId = folderIdOf(input.payload);
  if (folderId !== undefined) {
    const folder = await findVisibleFolder(db, scope, folderId);
    if (folder === null) {
      throw unprocessable(
        [{ pointer: '/payload/folderId', code: 'not-visible', message: 'Ревизия недоступна.' }],
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
    on conflict (dedupe_key) where dedupe_key is not null and status not in ('done', 'cancelled')
    do nothing
    returning id
  `);

  const created = inserted.rows[0];
  if (created !== undefined) return { jobId: created.id, created: true };

  // Конфликт по ключу: задача уже стоит. Возвращается существующая, а не
  // ошибка — повторная постановка обязана быть безопасной операцией (§12).
  //
  // Условие ДОСЛОВНО повторяет предикат `ux_jobs_dedupe_key` (0039), и это не
  // стилистика: `ON CONFLICT ... WHERE` подбирает индекс по совпадению
  // предиката, а запасной `SELECT` обязан находить ровно те строки, из-за
  // которых INSERT ничего не вставил. Разошедшись, они дают либо отказ
  // «no unique or exclusion constraint matching the ON CONFLICT
  // specification», либо `conflict()` ниже на задаче, которая на самом деле
  // есть.
  //
  // Отменённая задача ключ НЕ держит: `enqueueSystemJob` на конфликте
  // возвращает найденную задачу с `created: false`, поэтому мертвец в индексе
  // означал бы «конвейер отвечает „уже стоит“ и не делает ничего». Мёртвая
  // (`failed`) — держит: исчерпавшая попытки задача разбирается человеком, а
  // не пересоздаётся следующим нажатием молча.
  const existing = await db.execute<{ id: string }>(sql`
    select id from ${jobs}
     where dedupe_key = ${dedupeKey} and status not in ('done', 'cancelled')
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

  /**
   * Сквозной прогон не отменяется дедупликацией.
   *
   * Payload найденной задачи побеждал по построению: `do nothing` выбрасывает
   * входящий целиком. Значит, задача, поставленная ручной кнопкой БЕЗ
   * `autoContinue`, съедала нажатие «2. Распознать», сделанное следом: цепочка
   * доходила до своего звена и молча вставала, потому что заказ «доведи до
   * конца» никуда не записался.
   *
   * Флаг поэтому монотонный: `false → true` возможно, обратно — нет. Сквозной
   * прогон — это заказ, который однажды сделан; отменить его повторным
   * нажатием ручной кнопки было бы неверно в другую сторону.
   *
   * Обновляется только незавершённая задача: у `done` payload — часть
   * законченной истории.
   */
  if (autoContinueOf(parsed.payload)) {
    await db.execute(sql`
      update ${jobs}
         set payload = payload || '{"autoContinue":true}'::jsonb, updated_at = now()
       where ${jobs.id} = ${found.id}
         and ${jobs.status} not in ('done', 'cancelled')
         and coalesce((${jobs.payload} ->> 'autoContinue')::boolean, false) = false
    `);
  }

  return { jobId: found.id, created: false };
}

/** Заказан ли сквозной прогон. Отсутствие поля равно `false` (см. `autoContinue`). */
function autoContinueOf(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as { autoContinue?: unknown }).autoContinue === true;
}

/**
 * Свежее значение флага сквозного прогона у СТРОКИ задачи.
 *
 * Нужна потому, что `ctx.payload` — снимок, сделанный при захвате, а решение
 * «продолжать ли цепочку» принимается в конце попытки. У поллера финализации
 * между этими моментами проходят минуты и сотни попыток, и заказ «доведи до
 * конца», пришедший в середине (`enqueueSystemJob` поднимает флаг у уже стоящей
 * задачи), до снимка не доезжает вовсе.
 *
 * Чтение одной строки в момент решения закрывает окно целиком и не требует ни
 * миграции, ни второго места хранения намерения.
 *
 * `null` — строки задачи больше нет (сборка мусора, отмена): тогда вызывающий
 * остаётся при значении из payload, потому что других сведений о заказе нет.
 */
export async function readJobAutoContinue(db: JobExecutor, jobId: string): Promise<boolean | null> {
  const rows = await db.execute<{ auto_continue: boolean | null }>(sql`
    select coalesce((${jobs.payload} ->> 'autoContinue')::boolean, false) as auto_continue
      from ${jobs}
     where ${jobs.id} = ${jobId}
  `);
  const row = rows.rows[0];
  return row === undefined ? null : row.auto_continue === true;
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
  readonly folderId: string | null;
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
    folder_id: string | null;
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
        job_id, job_type, folder_id, request_id, attempt, payload_digest
      )
      select c.id,
             c.type,
             case when c.payload ->> 'folderId' ~ ${UUID_TEXT}
                  then (c.payload ->> 'folderId')::uuid end,
             c.payload ->> 'request_id',
             c.attempts,
             encode(sha256(convert_to(c.payload::text, 'UTF8')), 'hex')
        from claimed c
      returning id, job_id, request_id, folder_id
    )
    select c.id, c.type, c.payload, c.attempts, c.max_attempts,
           r.id as run_id, r.request_id, r.folder_id::text as folder_id
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
    folderId: row.folder_id,
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
  /**
   * Причина словами из закрытого набора СВОИХ классов ошибок (S44).
   *
   * `undefined` — причина не наша, и пересказывать её портал не вправе: плашка
   * покажет нормализованный `errorMessage`, как показывала. Собирает строку
   * `readableJobReason`, и только оттуда сюда что-либо попадает.
   */
  readonly reasonText?: string | null | undefined;
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
             error_message = ${params.errorMessage},
             reason_text = ${params.reasonText ?? null}
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

export interface DeferJobParams extends FinishJobParams {
  /** Через сколько спрашивать снова. Считает `runner` по `DEFERRAL_BACKOFF`. */
  readonly retryDelayMs: number;
}

/**
 * Отсрочка попытки: условие ещё не наступило, работы пока нет.
 *
 * Пара к `failJob`, и различия с ней — весь смысл функции.
 *
 * `last_error = NULL`, а не текст ожидания: `jobs.last_error` читается как
 * «почему не получилось», и «Распознавание ещё идёт» в этом поле означало бы,
 * что идущее распознавание — причина неудачи. `job_runs` пишется исходом
 * `deferred` без `error_class` и `error_message`: сообщать не о чем, а
 * заполненные поля утащили бы отсрочку в диагностику отказов — по ним же
 * `computeProcessingStatus` выбирает «последнюю ошибку» типа задачи.
 *
 * Статус всегда `queued`, потолок попыток здесь не проверяется, и это не
 * упущение: решение «отсрочка исчерпана» принимает `runner` ДО вызова — он
 * один знает номер текущей попытки и обязан на последней перевести отсрочку в
 * настоящий отказ, чтобы задача не осталась в очереди навсегда, а прогон — в
 * `running`.
 *
 * `attempts` не откатывается: счётчик остаётся предохранителем. Ожидание,
 * которое не кончается, обязано однажды кончиться.
 */
export async function deferJob(db: Database, params: DeferJobParams): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update ${jobs}
         set status = 'queued',
             next_run_at = now() + ${params.retryDelayMs}::int * interval '1 millisecond',
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
             outcome = 'deferred'
       where ${jobRuns.id} = ${params.runId} and ${jobRuns.outcome} is null
    `);

    return updated.rows.length > 0;
  });
}

/**
 * Продление аренды выполняющейся задачи (сердцебиение воркера).
 *
 * Без продления пришлось бы ставить аренду по самому долгому мыслимому времени
 * выполнения — а тогда задача умершего воркера ждала бы освобождения столько же.
 */
/**
 * Чем кончился стук аренды.
 *
 * Три исхода вместо `boolean`, потому что причин потерять аренду две, и они
 * означают разное (S50): `lost` — задачу подобрал другой воркер, это гонка;
 * `cancelled` — человек нажал «Стоп», и это штатное завершение работы. До S50
 * отмена работала ПОБОЧНЫМ эффектом: она обнуляла `locked_by`, стук не находил
 * своей строки и рапортовал «аренду перехватили». Журнал при этом писал о
 * гонке, которой не было, а любая правка условия `renewLease` молча сломала бы
 * единственный способ остановить работу.
 */
export type LeaseRenewal = 'held' | 'lost' | 'cancelled';

export async function renewLease(
  db: JobExecutor,
  params: { readonly jobId: string; readonly workerId: string; readonly leaseMs: number },
): Promise<LeaseRenewal> {
  const updated = await db.execute<{ id: string }>(sql`
    update ${jobs}
       set locked_until = now() + ${params.leaseMs}::int * interval '1 millisecond'
     where ${jobs.id} = ${params.jobId}
       and ${jobs.lockedBy} = ${params.workerId}
       and ${jobs.status} = 'running'
    returning id
  `);
  if (updated.rows.length > 0) return 'held';

  // Второй запрос делается только на неудачном стуке, то есть редко: в норме
  // аренда продлевается, и цена контракта равна нулю.
  const current = await db.execute<{ status: string }>(sql`
    select status from ${jobs} where ${jobs.id} = ${params.jobId}
  `);
  return current.rows[0]?.status === 'cancelled' ? 'cancelled' : 'lost';
}

export interface ReapResult {
  readonly requeued: number;
  readonly dead: number;
  readonly closedRuns: number;
}

/**
 * Сколько молчаливых смертей подряд задача переживает, прежде чем уйти к людям.
 *
 * Потолок нужен ровно от одного случая — задачи, которая роняет воркер сама:
 * страница-гигант, не влезающая в память, убила бы процесс, вернулась в очередь
 * и убила следующий, бесконечно. Пять — это заметно больше, чем случайное
 * совпадение (выкатка, перезагрузка хоста, разовый OOM соседа), и заметно
 * меньше, чем «крутится вечно».
 */
export const LEASE_EXPIRY_LIMIT = 5;

/**
 * Освобождение просроченных аренд (§12, задача 24).
 *
 * Воркер, убитый сигналом, ничего освободить не может — задача осталась бы в
 * `running` навсегда, и это ровно тот отказ, который не виден: очередь не
 * растёт, ошибок нет, конвейер стоит. Reaper возвращает такие задачи в очередь,
 * а исчерпавшие терпение переводит в `failed`, чтобы они были видны в консоли.
 *
 * Открытые попытки закрываются исходом `lease_expired` (§3.8): считать их
 * прикладной ошибкой нельзя — задача, возможно, отработала целиком и умерла на
 * записи результата.
 *
 * ## Почему молчаливая смерть не тратит бюджет попыток (S41)
 *
 * `attempts` растёт при захвате, и до S41 этого счётчика хватало на всё: три
 * смерти воркера подряд убивали задачу детекции, ни разу её не выполнив. На
 * боевом инциденте так умер целый комплект: хост перезагрузился под нагрузкой,
 * задачи ушли в `failed`, а `failed` держит `dedupe_key` (0039) — и повторное
 * нажатие «Выделить блоки» для этих страниц молча не ставило ничего.
 *
 * Поэтому потраченный квант возвращается (`max_attempts + 1`), а считается
 * отдельным счётчиком со своим потолком. Возврат сделан прибавкой к потолку, а
 * не уменьшением `attempts`: номера попыток уезжают в `job_runs`, и откат
 * счётчика назад дал бы две разные попытки с одним номером — то есть испорченную
 * историю там, где её и смотрят при разборе.
 *
 * Пауза перед повтором растёт с числом потерь: воркер, которого только что убил
 * OOM, поднимается не мгновенно, и немедленный повтор попал бы ровно в момент,
 * когда машине ещё плохо.
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
         set status = case
               when j.lease_expiries + 1 >= ${LEASE_EXPIRY_LIMIT} then 'failed'
               else 'queued'
             end,
             lease_expiries = j.lease_expiries + 1,
             max_attempts = j.max_attempts + 1,
             locked_by = null,
             locked_until = null,
             next_run_at = now() + (j.lease_expiries + 1) * interval '30 seconds',
             last_error = case
               when j.lease_expiries + 1 >= ${LEASE_EXPIRY_LIMIT}
                 then 'аренда истекала ' || (j.lease_expiries + 1)::text ||
                      ' раз подряд: задача, вероятно, роняет воркер (нехватка памяти или зависание)'
               else 'аренда истекла: воркер не завершил задачу'
             end,
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
  /**
   * Сколько раз аренда истекала без ответа воркера (S41).
   *
   * Отдельно от `attempts` и рядом с ним: «шесть попыток» и «шесть смертей
   * воркера» — разные диагнозы с разным лечением. Первое разбирают по тексту
   * ошибки, второе — по памяти машины.
   */
  readonly leaseExpiries: number;
  readonly priority: number;
  readonly nextRunAt: string;
  readonly lockedBy: string | null;
  readonly lockedUntil: string | null;
  readonly lastError: string | null;
  readonly dedupeKey: string | null;
  readonly folderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Исчерпала попытки и ждёт решения человека. */
  readonly isDead: boolean;
}

export interface ListJobsParams {
  readonly status?: JobStatus | undefined;
  readonly type?: string | undefined;
  readonly queue?: JobQueue | undefined;
  readonly folderId?: string | undefined;
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
  ${jobs.leaseExpiries} as lease_expiries,
  ${jobs.priority} as priority,
  ${sql.raw(ISO('jobs.next_run_at'))} as next_run_at,
  ${jobs.lockedBy} as locked_by,
  ${sql.raw(ISO('jobs.locked_until'))} as locked_until,
  ${jobs.lastError} as last_error,
  ${jobs.dedupeKey} as dedupe_key,
  ${jobs.payload} ->> 'folderId' as folder_id,
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
  lease_expiries: number;
  priority: number;
  next_run_at: string;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  folder_id: string | null;
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
  if (params.folderId !== undefined) {
    conditions.push(sql`${jobs.payload} ->> 'folderId' = ${params.folderId}`);
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
  readonly folderId: string | null;
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
    readonly folderId?: string | undefined;
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

  if (params.folderId !== undefined) {
    const folder = await findVisibleFolder(db, scope, params.folderId);
    if (folder === null) return [];
    conditions.push(eq(jobRuns.folderId, params.folderId));
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
      folderId: jobRuns.folderId,
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
             -- Терпение к молчаливым смертям тоже возвращается: человек,
             -- нажавший «повторить», уже знает, что задача роняла воркер, и
             -- решение принял он. Оставить счётчик у потолка значило бы, что
             -- его повтор умрёт от первой же истёкшей аренды.
             lease_expiries = 0,
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
      objectId: await objectIdOfFolder(tx, job.folderId),
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
      objectId: await objectIdOfFolder(tx, job.folderId),
      payload: { type: job.type, previousStatus: job.status },
    });
  });

  return findJob(db, scope, jobId);
}

/**
 * Снять с очереди незавершённые задачи одной стадии по ревизии.
 *
 * Не путать с `cancelJob`: та — действие администратора над ОДНОЙ задачей, с
 * аудитом и отказом на выполняющейся. Здесь конвейер снимает СВОЙ же остаток,
 * потому что человек нажал следующую кнопку и результаты предыдущей стадии ему
 * больше не нужны. Аудита нет намеренно: это не решение о чужой работе, а часть
 * обработки одного нажатия, и след от неё — событие ревизии у вызывающего.
 *
 * Отменяются и `queued`, и `running`. Взятую воркером попытку строкой в таблице
 * не остановить — она доработает и завершится сама; отметка нужна, чтобы такая
 * задача не встала в очередь снова после `failJob` и не считалась незаконченной
 * работой. Отставший обработчик, обнаружив, что цель ушла, обязан выйти тихо, а
 * не отказом (`detection_batch_obsolete` в `local-detection.ts`).
 *
 * Стадия, а не список типов: типы задач одной стадии добавляются со временем, и
 * забытый в списке тип означал бы молча недоснятый остаток.
 */
export async function cancelPendingJobsOfStage(
  db: JobExecutor,
  folderId: string,
  stage: ProcessingStage,
): Promise<number> {
  const types = JOB_TYPES.filter((type) => stageOf(type) === stage);
  if (types.length === 0) return 0;

  const cancelled = await db.execute<{ id: string }>(sql`
    update ${jobs}
       set status = 'cancelled', locked_by = null, locked_until = null, updated_at = now()
     where ${jobs.payload} ->> 'folderId' = ${folderId}
       and ${jobs.status} in ('queued', 'running')
       and ${jobs.type} in (${sql.join(
         types.map((type) => sql`${type}`),
         sql`, `,
       )})
    returning id
  `);
  return cancelled.rows.length;
}

/**
 * Страницы прогона, за которыми ещё стоит живая задача распознавания (S41).
 *
 * Нужна финализации, чтобы отличить «страница считается» от «страницу считать
 * некому». Прежде такого различия не было: любая непройденная страница
 * означала отсрочку, и прогон, у которого задачи умерли при перезагрузке хоста,
 * молча ждал их четыре часа — двести сорок отсрочек, ни одной ошибки в журнале,
 * застывший счётчик на экране.
 *
 * Живыми считаются `queued` и `running`. Отложенная задача лежит в `queued` и
 * потому тоже живая — она проснётся сама.
 */
export async function listLiveRecognizePageJobs(
  db: JobExecutor,
  runId: string,
): Promise<ReadonlySet<number>> {
  const rows = await db.execute<{ page_index: number }>(sql`
    select (${jobs.payload} ->> 'pageIndex')::int as page_index
      from ${jobs}
     where ${jobs.type} = 'vlm.recognize_page'
       and ${jobs.payload} ->> 'recognitionRunId' = ${runId}
       and ${jobs.status} in ('queued', 'running')
       and ${jobs.payload} ->> 'pageIndex' is not null
  `);
  return new Set(rows.rows.map((row) => row.page_index));
}

/**
 * Состояние веера извлечения реквизитов одного прогона (S44).
 *
 * Барьер `doc.extract_finalize` спрашивает им ровно одно: «остался ли кто-то,
 * кто ещё считает?». Живыми считаются `queued` и `running` — отложенная задача
 * лежит в `queued` и проснётся сама.
 *
 * Разрез по `generation` (идентификатор задачи-постановщика), а не по одной
 * папке: повторная сегментация ставит веер заново, пока предыдущий ещё
 * разбирается, и без разреза барьер ждал бы чужую работу либо, что хуже,
 * посчитал бы её своей и подвёл итог по чужому составу.
 */
export interface ExtractFanState {
  /** Ещё считаются: `queued` либо `running`. */
  readonly live: number;
  /** Отказались окончательно: попытки исчерпаны или задача снята. */
  readonly dead: number;
  readonly done: number;
  readonly total: number;
}

export async function readExtractFanState(
  db: JobExecutor,
  folderId: string,
  generation: string,
): Promise<ExtractFanState> {
  const rows = await db.execute<{ status: string; n: number }>(sql`
    select ${jobs.status} as status, count(*)::int as n
      from ${jobs}
     where ${jobs.type} = 'doc.extract_document'
       and ${jobs.payload} ->> 'folderId' = ${folderId}
       and ${jobs.payload} ->> 'generation' = ${generation}
     group by ${jobs.status}
  `);

  let live = 0;
  let dead = 0;
  let done = 0;
  for (const row of rows.rows) {
    if (row.status === 'queued' || row.status === 'running') live += row.n;
    else if (row.status === 'done') done += row.n;
    else dead += row.n;
  }
  return { live, dead, done, total: live + dead + done };
}

/**
 * Оживить мёртвые задачи стадии — по явному нажатию человека (S41).
 *
 * ## Что чинится
 *
 * Мёртвая задача ДЕРЖИТ `dedupe_key` (0039), и это правильно: «мертвеца
 * разбирает человек» — иначе следующее нажатие молча пересоздавало бы работу,
 * которая уже пять раз не удалась. Но у правила была дыра: нажатие кнопки
 * стадии и есть решение человека, а конвейер трактовал его как ещё одну
 * автоматическую постановку. Повторный запуск разметки на страницах с мёртвыми
 * задачами не ставил НИЧЕГО — `enqueueJob` возвращал существующего мертвеца с
 * `created: false`, — и комплект оставался недоразмеченным без единой ошибки на
 * экране. Так выглядел боевой инцидент: «разметка сбросилась до нуля и не
 * восстановилась».
 *
 * ## Почему полный бюджет попыток, а не +1
 *
 * Консольный `retryJob` даёт одну попытку: там человек разбирает КОНКРЕТНУЮ
 * задачу и хочет посмотреть, что будет. Здесь он заказывает стадию целиком, и
 * задача обязана получить тот же бюджет, что получила бы новая: иначе первая же
 * случайность (недоступность шлюза на десять секунд) снова убила бы её.
 * `lease_expiries` обнуляется по той же причине.
 *
 * Скоуп задаётся ключом payload, а не одной ревизией: у ревизии бывает несколько
 * разметок и прогонов, и оживлять мертвецов ЧУЖОГО прогона нельзя — их предмета
 * уже нет, и они честно ждут своей участи в консоли.
 */
export async function reviveFailedJobs(
  db: JobExecutor,
  params: {
    readonly folderId: string;
    readonly stage: ProcessingStage;
    /** Ключ payload, сужающий скоуп: `layoutRevisionId` или `recognitionRunId`. */
    readonly scopeKey: 'layoutRevisionId' | 'recognitionRunId';
    readonly scopeValue: string;
  },
): Promise<number> {
  const types = JOB_TYPES.filter((type) => stageOf(type) === params.stage);
  if (types.length === 0) return 0;

  // Бюджет — свой у каждого типа: `vlm.recognize_page` живёт восемью попытками,
  // `layout.detect_local` тремя, и выдавать им поровну значило бы придумать
  // третье значение вдобавок к тем, что уже объявлены в каталоге задач.
  const budgetByType = sql.join(
    types.map((type) => sql`when ${type} then ${jobDefinition(type).maxAttempts}`),
    sql` `,
  );

  const revived = await db.execute<{ id: string }>(sql`
    update ${jobs} j
       set status = 'queued',
           max_attempts = j.attempts + (case j.type ${budgetByType} else 1 end),
           lease_expiries = 0,
           next_run_at = now(),
           locked_by = null,
           locked_until = null,
           updated_at = now()
     where j.payload ->> 'folderId' = ${params.folderId}
       and j.payload ->> ${params.scopeKey} = ${params.scopeValue}
       and j.status = 'failed'
       and j.type in (${sql.join(
         types.map((type) => sql`${type}`),
         sql`, `,
       )})
    returning j.id
  `);
  return revived.rows.length;
}

/**
 * Снять с ревизии ВСЕ незаконченные задачи — включая мёртвые.
 *
 * Пара к `purge.ts`: сброс конвейера и удаление комплекта сносят производное, но
 * `jobs` не трогали вовсе, и это давало две беды сразу.
 *
 * Мёртвая задача прежнего прогона продолжала держать `dead > 0`, то есть красную
 * плашку «обработка остановилась» на ревизии, у которой сбросили ровно то, из-за
 * чего задача умерла. А `queued` — просыпалась по `next_run_at`, не находила ни
 * прогона, ни разметки, и рождала НОВОГО мертвеца: сброс не заканчивал прошлую
 * попытку, а размножал её.
 *
 * Поэтому здесь, в отличие от `cancelPendingJobsOfStage`, снимается и `failed`:
 * та функция снимает остаток идущей работы («человек нажал следующую кнопку»),
 * а эта закрывает работу, предмета которой больше нет. Мёртвая задача переживать
 * снос своего предмета не имеет права — разбирать в ней уже нечего.
 *
 * `job_runs` НЕ удаляются: это журнал (§11 и шапка `purge.ts`). Открытые попытки
 * закрываются исходом `cancelled` — строка без `outcome` означает «попытка идёт»,
 * и оставленная открытой навсегда попала бы в `in_flight` сводки обработки.
 *
 * `stages` не задан — снимаются задачи всех стадий, включая обслуживающие
 * (`stageOf` вернул `null`): при полном удалении ревизии не должно остаться
 * ничего, что на неё сошлётся.
 */
export async function cancelJobsOfFolder(
  db: JobExecutor,
  folderId: string,
  options: { readonly stages?: readonly ProcessingStage[] | undefined } = {},
): Promise<number> {
  const stages = options.stages;
  const typeFilter =
    stages === undefined
      ? null
      : JOB_TYPES.filter((type) => {
          const stage = stageOf(type);
          return stage !== null && stages.includes(stage);
        });
  // Пустой список типов — не «снять всё», а «снимать нечего»: молчаливое
  // расширение до всех типов было бы худшим из возможных прочтений.
  if (typeFilter !== null && typeFilter.length === 0) return 0;

  const cancelled = await db.execute<{ id: string }>(sql`
    update ${jobs}
       set status = 'cancelled', locked_by = null, locked_until = null, updated_at = now()
     where ${jobs.payload} ->> 'folderId' = ${folderId}
       and ${jobs.status} in ('queued', 'running', 'failed')
       ${
         typeFilter === null
           ? sql``
           : sql`and ${jobs.type} in (${sql.join(
               typeFilter.map((type) => sql`${type}`),
               sql`, `,
             )})`
       }
    returning id
  `);

  return closeOpenAttempts(db, cancelled.rows);
}

/**
 * Снять задачи прогона распознавания, работу которого принял дочерний (S28).
 *
 * Нажатие «2. Распознать» после отказа создаёт восстановительный прогон
 * (`repair_of_run_id`, ADR-0017) и переносит в него совместимые результаты.
 * Задачи родителя после этого разбирать некому и незачем — их предмет перешёл
 * дочернему прогоном, — но `computeProcessingStatus` считает `dead` по ВСЕМ
 * задачам ревизии без фильтра по прогону, а `summaryStage` при `dead > 0`
 * объявляет стадию `failed`. Одна мёртвая задача погибшего прогона держала
 * красную плашку «обработка остановилась» вечно, сколько бы успешных прогонов
 * после неё ни прошло, и гасила опрос сводки: `isBusy` при стадии `failed`
 * даёт `false`, то есть плашка не могла исчезнуть даже сама собой.
 *
 * Почему это правка ПО ФАКТУ, а не по отображению: сокрытие мертвецов в выдаче
 * оставило бы в очереди задачи, которые `enqueueJob` продолжает считать
 * стоящими (`ux_jobs_dedupe_key` держит ключ на `failed`), — и повторная
 * постановка той же работы молча возвращала бы `created: false`, указывая на
 * мертвеца. Отмена снимает и это.
 *
 * Запрет 0039 «мёртвая задача обязана разбираться человеком, а не
 * пересоздаваться следующим нажатием молча» не нарушен: человек и принял
 * решение — он нажал «2. Распознать» после отказа, и портал ответил
 * восстановлением, а не тихим повтором.
 *
 * Фильтр — по `recognitionRunId` в payload, а не по стадии: стадия
 * `recognition` снялась бы у ревизии целиком, включая задачи дочернего прогона,
 * который прямо сейчас и ставится.
 */
export async function cancelJobsOfRecognitionRun(
  db: JobExecutor,
  folderId: string,
  recognitionRunId: string,
): Promise<number> {
  const cancelled = await db.execute<{ id: string }>(sql`
    update ${jobs}
       set status = 'cancelled', locked_by = null, locked_until = null, updated_at = now()
     where ${jobs.payload} ->> 'folderId' = ${folderId}
       and ${jobs.payload} ->> 'recognitionRunId' = ${recognitionRunId}
       and ${jobs.status} in ('queued', 'running', 'failed')
    returning id
  `);

  return closeOpenAttempts(db, cancelled.rows);
}

/**
 * Закрыть попытки отменённых задач исходом `cancelled`.
 *
 * Попытки закрываются ОТДЕЛЬНЫМ оператором по списку идентификаторов, а не
 * подзапросом по `jobs`: к этому моменту статус уже переписан, и подзапрос
 * «где задача отменена» захватил бы задачи, отменённые кем-то раньше, вместе
 * с их давно закрытыми попытками.
 *
 * `job_runs` не удаляются: это журнал (§11). Строка без `outcome` означает
 * «попытка идёт», и оставленная открытой навсегда попала бы в `in_flight`
 * сводки обработки.
 */
async function closeOpenAttempts(
  db: JobExecutor,
  cancelled: readonly { readonly id: string }[],
): Promise<number> {
  if (cancelled.length === 0) return 0;

  await db.execute(sql`
    update ${jobRuns}
       set finished_at = now(), outcome = 'cancelled'
     where ${jobRuns.outcome} is null
       and ${jobRuns.jobId} in (${sql.join(
         cancelled.map((row) => sql`${row.id}::uuid`),
         sql`, `,
       )})
  `);

  return cancelled.length;
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

/**
 * Пауза, после которой работа считается ПРЕРВАННОЙ, а не идущей.
 *
 * Пятнадцать минут — с запасом над самой длинной штатной паузой внутри работы:
 * потолок повтора после отказа — десять минут (`DEFAULT_BACKOFF`, `jobs/types`),
 * отсрочки поллеров ждут не дольше минуты. То есть работающий конвейер этот
 * порог не рвёт никогда, а человеческую паузу — «разметил вечером, распознаю
 * утром» — рвёт всегда.
 */
const IDLE_GAP = `interval '15 minutes'`;

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
  /**
   * Попытки, окончившиеся ожиданием: «условие ещё не наступило».
   *
   * Отдельно от `failed` намеренно — см. `jobOutcomeSchema`. Пока значение было
   * одно, поллер финализации на минуте ожидания давал `failed: 12`, и плашка
   * конвейера объявляла остановку на работающем конвейере.
   */
  readonly deferred: number;
  /**
   * Задачи этого типа, отсроченные ПРЯМО СЕЙЧАС.
   *
   * `deferred` считает попытки за всю жизнь ревизии и потому отвечает на другой
   * вопрос: «ждали ли здесь когда-нибудь». Экран спрашивает «ждут ли сейчас», и
   * пожизненного счётчика ему мало — после первой же отсрочки он остаётся
   * ненулевым до конца обработки. На боевом комплекте это выглядело так: страницы
   * дописались, двадцать минут шло извлечение реквизитов, а полоса конвейера всё
   * ещё уверяла, что ждёт страницы.
   *
   * Признак берётся из `jobs`, а не из журнала попыток, и однозначен: `deferJob`
   * — единственное место, оставляющее задачу в `queued` без `last_error` при
   * непустом `attempts`. `failJob` и `reapExpiredLeases` всегда пишут причину, а
   * у задачи, поставленной с отложенным стартом, нет попыток.
   */
  readonly deferredNow: number;
  readonly leaseExpired: number;
  readonly inFlight: number;
  /**
   * Задачи этого типа, исчерпавшие попытки (`jobs.status = 'failed'`).
   *
   * Не то же, что `failed`: тот считает ПОПЫТКИ, а эта — ЗАДАЧИ, которым
   * повторять больше нечем. Пять неудачных попыток одной задачи, которая потом
   * прошла, дают `failed: 5, dead: 0` — конвейер жив; одна задача, исчерпавшая
   * лимит, даёт `failed: 1, dead: 1` — конвейер стоит. Красная плашка обязана
   * реагировать на второе, а реагировала на первое.
   */
  readonly dead: number;
  readonly totalDurationMs: number;
  readonly firstStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastErrorClass: string | null;
  readonly lastErrorMessage: string | null;
  /**
   * Причина отказа словами; `null` — причина не из своих классов (S44).
   *
   * Отдельно от `lastErrorMessage`, потому что это разные требования к одной
   * строке: сообщение — ключ агрегации журнала и потому без чисел, причина —
   * ответ человеку и потому с ними.
   */
  readonly lastReasonText: string | null;
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

/**
 * Постраничный ход выделения блоков (S30, переписан на прямой счёт в S36).
 *
 * ## Считается СДЕЛАННОЕ — так, как написано на экране
 *
 * До S36 здесь считался остаток (`pagesTotal − pending − failed`), и он врал в
 * обе стороны, потому что «никто эту страницу не ждёт» верно и когда работа
 * сделана, и когда её ещё не раздали. На экране это выглядело так: прогон
 * начинался со «100%, размечено 22 из 22», а дальше счётчик ПЯТИЛСЯ — 21, 17,
 * — ровно с той скоростью, с какой зонды ориентации порождали задачи детекции.
 *
 * Теперь страница считается размеченной, когда выполнены оба условия:
 *
 * * её больше не ждёт ни одна задача разметки — ни зонд ориентации, ни детекция;
 * * хотя бы одна задача ДЕТЕКЦИИ этой страницы завершилась успехом.
 *
 * Второе условие обязательно: без него страница, у которой отработал только
 * зонд, считалась бы сделанной в промежутке между зондом и детекцией.
 *
 * ## Что НЕ годится в числители
 *
 * * **страницы, у которых появились блоки.** Страница, на которой детектор не
 *   нашёл ничего, — штатный терминальный исход, и блоков для неё не пишется
 *   вовсе (`local-detection.ts`, «Терминальность пустой страницы»). На комплекте
 *   с пустыми листами счётчик никогда не дошёл бы до конца. Поэтому считаются
 *   задачи, а не `layout_blocks`;
 * * **завершённые задачи детекции сами по себе.** Черновик разметки у ревизии
 *   один, а `resetPipelineForFolder` намеренно не снимает задачи стадии
 *   `layout` — `done`-задачи прошлого прогона остаются лежать. Спасает то, что
 *   новый прогон СРАЗУ ставит на каждую страницу свою ждущую задачу: `pending`
 *   перекрывает `done`, и счёт честно начинается с нуля.
 *
 * Последнее верно с точностью до одной оговорки: волна раздаётся циклом
 * `enqueueJob` без общей транзакции (`modules/layout/start.ts`), поэтому опрос,
 * попавший ВНУТРЬ раздачи повторного прогона, увидит часть страниц ещё по
 * прошлым `done`-задачам. Окно — десятки миллисекунд против опроса раз в
 * несколько секунд; заводить ради него транзакцию значило бы расширить тип
 * исполнителя во всей цепочке `enqueueJob → findVisibleFolder`.
 *
 * ## Почему по страницам, а не по задачам
 *
 * У локальной ветки (RF-DETR) одна задача — одна страница, у ветки RD WEB — до
 * восьми. Считать задачи значило бы получить верный ответ на одном провайдере и
 * заниженный в разы на другом, причём в зависимости от настройки портала.
 * Поэтому массив `pageIndices` разворачивается, и счёт идёт по страницам.
 */
export interface LayoutProgress {
  /** Страницы рабочего документа — та же карта, по которой раздавались задачи. */
  readonly pagesTotal: number;
  /** Детекция страницы завершилась, и больше её никто не ждёт. */
  readonly pagesDone: number;
  readonly pagesPending: number;
  /** Страницы задач, исчерпавших попытки: в `pagesDone` они не входят. */
  readonly pagesFailed: number;
}

export interface ProcessingStatus {
  readonly folderId: string;
  /** Сводная стадия: самая дальняя, где была активность; `failed` при мёртвых задачах. */
  readonly stage: ProcessingStage;
  readonly queued: number;
  readonly running: number;
  readonly dead: number;
  readonly attempts: number;
  /** Сумма длительностей завершённых попыток — ответ на вопрос «сколько идёт». */
  readonly totalDurationMs: number;
  /**
   * Календарное время ТЕКУЩЕГО непрерывного отрезка работы; простои между
   * запусками в него не входят.
   *
   * Считалось от самой первой попытки ревизии за всю её жизнь, и это давало
   * ответ на вопрос, которого никто не задавал. На боевом комплекте экран
   * показал «966 мин»: между разметкой вечером и распознаванием утром конвейер
   * девять с половиной часов не делал ничего, и эта ночь целиком лежала в
   * «сколько идёт обработка».
   */
  readonly elapsedMs: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stages: readonly StageSummary[];
  readonly jobTypes: readonly JobTypeSummary[];
  /**
   * `null` — считать нечего: рабочего документа ещё нет либо стадия разметки
   * прямо сейчас не идёт.
   */
  readonly layout: LayoutProgress | null;
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
  folderId: string,
): Promise<ProcessingStatus | null> {
  const folder = await findVisibleFolder(db, scope, folderId);
  if (folder === null) return null;

  const runRows = await db.execute<{
    job_type: string;
    attempts: number;
    succeeded: number;
    failed: number;
    deferred: number;
    lease_expired: number;
    in_flight: number;
    total_duration_ms: number;
    first_started_at: string | null;
    last_finished_at: string | null;
    last_error_class: string | null;
    last_error_message: string | null;
    last_reason_text: string | null;
  }>(sql`
    select job_type,
           count(*)::int as attempts,
           count(*) filter (where outcome = 'succeeded')::int as succeeded,
           count(*) filter (where outcome = 'failed')::int as failed,
           count(*) filter (where outcome = 'deferred')::int as deferred,
           count(*) filter (where outcome = 'lease_expired')::int as lease_expired,
           count(*) filter (where outcome is null)::int as in_flight,
           coalesce(sum(duration_ms), 0)::int as total_duration_ms,
           ${sql.raw(ISO('min(started_at)'))} as first_started_at,
           ${sql.raw(ISO('max(finished_at)'))} as last_finished_at,
           -- Фильтр по ИСХОДУ, а не по «текст непуст». Прежнее условие
           -- подхватывало сообщение любой закрытой не успехом попытки, и
           -- «последней ошибкой» типа задачи становилось «аренда истекла:
           -- воркер не завершил задачу» — текст, который пишет reaper, закрывая
           -- попытку исходом lease_expired. Настоящая причина отказа при этом
           -- пряталась за словами о сорванной аренде. С появлением отсрочек то
           -- же условие подхватывало бы «Распознавание ещё идёт».
           (array_agg(error_class order by started_at desc)
              filter (where outcome = 'failed'))[1] as last_error_class,
           (array_agg(error_message order by started_at desc)
              filter (where outcome = 'failed'))[1] as last_error_message,
           -- Причина словами той же последней неудачной попытки (S44). NULL —
           -- отказ не нашего класса, и показывать надо нормализованный текст.
           (array_agg(reason_text order by started_at desc)
              filter (where outcome = 'failed'))[1] as last_reason_text
      from ${jobRuns}
     where ${jobRuns.folderId} = ${folderId}
     group by job_type
  `);

  const pendingRows = await db.execute<{
    type: string;
    status: string;
    count: number;
    deferred_now: number;
  }>(sql`
    select ${jobs.type} as type, ${jobs.status} as status, count(*)::int as count,
           count(*) filter (
             where ${jobs.status} = 'queued'
               and ${jobs.attempts} > 0
               and ${jobs.lastError} is null
               and ${jobs.nextRunAt} > now()
           )::int as deferred_now
      from ${jobs}
     where ${jobs.payload} ->> 'folderId' = ${folderId}
       and ${jobs.status} in ('queued', 'running', 'failed')
     group by 1, 2
  `);

  /**
   * Начало ТЕКУЩЕГО отрезка работы: первая попытка после последнего простоя.
   *
   * Разрывы ищутся по бегущему максимуму окончаний, а не по предыдущей строке:
   * попытки идут внахлёст (десятки страниц распознаются разом), и соседняя по
   * времени старта попытка вполне может завершиться раньше начала своей
   * предшественницы. Незавершённая попытка держит отрезок открытым — её конец
   * берётся равным началу.
   */
  const sessionRows = await db.execute<{ session_started_at: string | null }>(sql`
    with attempts as (
      select ${jobRuns.startedAt} as started_at,
             max(coalesce(${jobRuns.finishedAt}, ${jobRuns.startedAt})) over (
               order by ${jobRuns.startedAt}
               rows between unbounded preceding and 1 preceding
             ) as prev_end
        from ${jobRuns}
       where ${jobRuns.folderId} = ${folderId}
    )
    select ${sql.raw(
      ISO(`max(started_at) filter (
             where prev_end is null or started_at - prev_end > ${IDLE_GAP}
           )`),
    )} as session_started_at
      from attempts
  `);

  let queued = 0;
  let running = 0;
  let dead = 0;
  const deferredNowByType = new Map<string, number>();
  const deadByType = new Map<string, number>();
  const pendingByStage = new Map<ProcessingStage, number>();
  for (const row of pendingRows.rows) {
    if (row.status === 'queued') queued += row.count;
    if (row.status === 'running') running += row.count;
    if (row.status === 'failed') {
      dead += row.count;
      deadByType.set(row.type, (deadByType.get(row.type) ?? 0) + row.count);
    }
    if (row.deferred_now > 0) {
      deferredNowByType.set(row.type, (deferredNowByType.get(row.type) ?? 0) + row.deferred_now);
    }
    const stage = isJobType(row.type) ? stageOf(row.type) : null;
    if (stage !== null && row.status !== 'failed') {
      pendingByStage.set(stage, (pendingByStage.get(stage) ?? 0) + row.count);
    }
  }

  // Ход разметки считается только при ИДУЩЕЙ стадии, и число ждущих задач уже
  // посчитано здесь же: второй запрос ради него был бы тем же агрегатом,
  // выполненным заново.
  const layout = await computeLayoutProgress(db, folderId, pendingByStage.get('layout') ?? 0);

  /**
   * Ключи ОБЪЕДИНЯЮТСЯ, а не берутся из журнала попыток.
   *
   * Сводка собиралась только по `job_runs`, и мёртвая задача без единой
   * записанной попытки в неё не попадала вовсе. Такие есть: `UnknownJobType` и
   * `InvalidPayload` объявляются `permanent` и переводят задачу в `failed`
   * сразу, а строка попытки заводится захватом — то есть общая цифра `dead`
   * росла, а тип, который умер, не назывался. Плашка в этом случае печатала
   * «Обработка остановилась» и не могла сказать, на чём.
   */
  const jobTypes: JobTypeSummary[] = [
    ...new Set([
      ...runRows.rows.map((row) => row.job_type),
      ...deadByType.keys(),
      ...deferredNowByType.keys(),
    ]),
  ].map((jobType) => {
    const row = runRows.rows.find((candidate) => candidate.job_type === jobType);
    return {
      jobType,
      stage: isJobType(jobType) ? stageOf(jobType) : null,
      attempts: row?.attempts ?? 0,
      succeeded: row?.succeeded ?? 0,
      failed: row?.failed ?? 0,
      deferred: row?.deferred ?? 0,
      deferredNow: deferredNowByType.get(jobType) ?? 0,
      leaseExpired: row?.lease_expired ?? 0,
      inFlight: row?.in_flight ?? 0,
      dead: deadByType.get(jobType) ?? 0,
      totalDurationMs: row?.total_duration_ms ?? 0,
      firstStartedAt: row?.first_started_at ?? null,
      lastFinishedAt: row?.last_finished_at ?? null,
      lastErrorClass: row?.last_error_class ?? null,
      lastErrorMessage: row?.last_error_message ?? null,
      lastReasonText: row?.last_reason_text ?? null,
    };
  });

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
  const sessionStartedAt = sessionRows.rows[0]?.session_started_at ?? null;

  return {
    folderId,
    stage: summaryStage(
      stages,
      dead,
      [...pendingByStage.entries()].filter(([, count]) => count > 0).map(([stage]) => stage),
    ),
    queued,
    running,
    dead,
    attempts: sum(jobTypes.map((s) => s.attempts)),
    totalDurationMs: sum(jobTypes.map((s) => s.totalDurationMs)),
    // Ноль — законный ответ: в начатом отрезке ещё ни одна попытка не
    // завершилась, и последний известный финиш остался в прошлом отрезке.
    // Дальше время дотикивает экран, а следующий опрос вернёт настоящее.
    elapsedMs:
      sessionStartedAt === null || finishedAt === null
        ? null
        : Math.max(0, Date.parse(finishedAt) - Date.parse(sessionStartedAt)),
    startedAt,
    finishedAt,
    stages,
    jobTypes,
    layout,
  };
}

/** Типы задач детекции: обе ветки провайдера сразу (ADR-0008 и легаси RD WEB). */
const DETECTION_JOB_TYPES = ['layout.detect_local', 'layout.detect_pages'] as const;

/**
 * Задачи-РАЗДАТЧИКИ стадии разметки: пока такая ждёт, страницы ещё не розданы.
 *
 * `layout.analyze_coverage` и `preview.cache_pages` сюда не входят намеренно,
 * хотя стадия у них та же: они идут ПОСЛЕ страниц, и обнулять счёт при них
 * значило бы сбрасывать полосу в ноль на финише прогона.
 */
const LAYOUT_HANDOUT_JOB_TYPES = [
  'layout.start',
  'rd.create_run_document',
  'rd.upload_working_pdf',
  'rd.wait_pages',
] as const;

/**
 * Постраничный ход выделения блоков — см. докстринг `LayoutProgress`.
 *
 * Отдельным запросом, а не подзапросом в общей сводке: та собирается по
 * `job_runs` и `jobs` в разрезе ТИПОВ задач, а здесь разрез страничный, и
 * склеивать два разреза в один оператор значило бы получить строку, где часть
 * колонок про задачи, а часть про страницы.
 *
 * `pending` перекрывает и `done`, и `failed`: страница, которую прошлый прогон
 * оставил сделанной или упавшей, а новый взял в работу, — это работающая
 * страница. Не разведи их — одна страница попала бы в две корзины сразу, и
 * сумма превысила бы общее число страниц.
 *
 * `layoutPending` — число ждущих задач стадии `layout`, посчитанное вызывающим.
 * Ноль означает «стадия не идёт», и это не то же самое, что «всё сделано»:
 * сводная стадия остаётся `layout` и во время пересборки рабочего документа —
 * `summaryStage` берёт самую дальнюю стадию с активностью, а её оставил прошлый
 * прогон. Без этой проверки экран показывал бы прошлый комплект («22 из 22»)
 * ровно в ту минуту, когда собирается новый на 28 страниц.
 */
async function computeLayoutProgress(
  db: Database,
  folderId: string,
  layoutPending: number,
): Promise<LayoutProgress | null> {
  if (layoutPending === 0) return null;

  const rows = await db.execute<{
    pages_total: number;
    pages_pending: number;
    pages_done: number;
    pages_failed: number;
    handout_pending: number;
  }>(sql`
    with bundle as (
      select b.id
        from processing_bundles b
       where b.folder_id = ${folderId}
       order by b.created_at desc
       limit 1
    ),
    -- Страничные задачи разметки: детекция несёт МАССИВ страниц (у локальной
    -- ветки в нём одна, у легаси RD WEB — до восьми), зонд ориентации — скаляр.
    -- Разворот обязателен: счёт задач дал бы разный ответ на разных провайдерах.
    page_jobs as (
      select (idx.value)::int as page_index,
             j.status as status,
             true as detection
        from ${jobs} j
        cross join lateral jsonb_array_elements_text(
          coalesce(j.payload -> 'pageIndices', '[]'::jsonb)
        ) as idx(value)
       where j.payload ->> 'folderId' = ${folderId}
         and j.type in (${sql.join(
           DETECTION_JOB_TYPES.map((type) => sql`${type}`),
           sql`, `,
         )})
      union all
      select (j.payload ->> 'workingPageIndex')::int as page_index,
             j.status as status,
             false as detection
        from ${jobs} j
       where j.payload ->> 'folderId' = ${folderId}
         and j.type = 'page.orientation_probe'
         and j.payload ->> 'workingPageIndex' is not null
    ),
    -- Соединение с картой страниц НОВЕЙШЕГО рабочего документа отсекает задачи
    -- прошлой, более длинной карты: их индексы не существуют в текущей, и без
    -- отсечения счёт вышел бы за общее число страниц.
    pages as (
      select p.working_page_index as page_index,
             bool_or(page_jobs.status in ('queued', 'running')) as pending,
             bool_or(page_jobs.status = 'done' and page_jobs.detection) as detected,
             bool_or(page_jobs.status = 'failed') as failed
        from processing_bundle_pages p
        join bundle on bundle.id = p.bundle_id
        join page_jobs on page_jobs.page_index = p.working_page_index
       group by 1
    )
    select
      (select count(*)::int from processing_bundle_pages p
         join bundle on bundle.id = p.bundle_id) as pages_total,
      (select count(*)::int from pages where pending) as pages_pending,
      (select count(*)::int from pages where detected and not pending) as pages_done,
      (select count(*)::int from pages
        where failed and not pending and not detected) as pages_failed,
      (select count(*)::int from ${jobs} j
        where j.payload ->> 'folderId' = ${folderId}
          and j.status in ('queued', 'running')
          and j.type in (${sql.join(
            LAYOUT_HANDOUT_JOB_TYPES.map((type) => sql`${type}`),
            sql`, `,
          )})) as handout_pending
  `);

  const row = rows.rows[0];
  // Рабочего документа ещё нет — считать страницы не по чему, и ноль здесь
  // означал бы «комплект пуст», а не «мы пока не знаем».
  if (row === undefined || row.pages_total === 0) return null;

  /**
   * Раздатчик ещё в очереди — значит страницы этого прогона не розданы, и всё,
   * что видно в очереди, принадлежит прошлому. Ноль здесь не осторожность, а
   * факт: ни одна страница ТЕКУЩЕГО прогона не размечена.
   */
  if (row.handout_pending > 0) {
    return { pagesTotal: row.pages_total, pagesDone: 0, pagesPending: 0, pagesFailed: 0 };
  }

  return {
    pagesTotal: row.pages_total,
    pagesDone: row.pages_done,
    pagesPending: row.pages_pending,
    pagesFailed: row.pages_failed,
  };
}

/**
 * Сводная стадия.
 *
 * Мёртвая задача важнее любой активности: комплект, у которого задача исчерпала
 * попытки, не «на распознавании», он стоит и ждёт человека. В остальном берётся
 * самая дальняя стадия с активностью — конвейер линейный, и возврат к предыдущей
 * стадии означает новый прогон, который сам станет самой дальней.
 *
 * Экспортируется ради списка комплектов объекта (S37): та же величина, что
 * печатает плашка на карточке ревизии, обязана печататься и в списке. Второе
 * определение «сводной стадии» разошлось бы с первым молча — список сказал бы
 * «распознано» там, где карточка говорит «обработка остановлена».
 *
 * Аргумент сужен до `{ stage }` намеренно: массовому агрегату остальные поля
 * `StageSummary` не нужны, а требовать их значило бы заставлять его считать то,
 * чего он не читает.
 */
export function summaryStage(
  stages: readonly { readonly stage: ProcessingStage }[],
  dead: number,
  pending: readonly ProcessingStage[] = [],
): ProcessingStage {
  if (dead > 0) return 'failed';
  /**
   * Идущая работа важнее пройденной (S50).
   *
   * Прежде бралась самая ДАЛЬНЯЯ стадия с активностью, и это верно ровно до
   * того момента, когда конвейер перестаёт быть линейным. Он перестал: нарезка
   * производных PDF ставится сегментацией ПАРАЛЛЕЛЬНО анализу, и её стадия
   * оказывалась самой дальней. Папка на 220 страниц двадцать восемь минут
   * показывала «готово», пока шло извлечение реквизитов, а вкладка «Проверка»
   * по той же причине советовала нажать «Распознать» — нажатие, которое
   * начинает всё заново.
   *
   * Самая РАННЯЯ стадия с очередью и есть то, что происходит сейчас: конвейер
   * идёт слева направо, и работа, стоящая раньше, ещё не сделана.
   */
  for (const stage of STAGE_ORDER) {
    if (pending.includes(stage)) return stage;
  }
  let result: ProcessingStage = 'uploaded';
  for (const stage of STAGE_ORDER) {
    if (stages.some((summary) => summary.stage === stage)) result = stage;
  }
  return result;
}

/**
 * Сводная стадия конвейера сразу по НЕСКОЛЬКИМ ревизиям.
 *
 * Существует ради одного экрана: списка комплектов объекта, где стадия нужна у
 * каждой строки страницы. `computeProcessingStatus` по каждой ревизии отдельно
 * дал бы два запроса на строку плюс расчёт хода разметки — то есть до полусотни
 * обращений на один экран, обновляемый опросом.
 *
 * Считается ровно то, что печатается: стадия, и числа ждущих, идущих и мёртвых
 * задач. Всё остальное из `ProcessingStatus` — стадии по отдельности, типы
 * задач, тексты ошибок, ход разметки — принадлежит карточке ревизии, и списку
 * не нужно ни одного из них.
 *
 * Стадия берётся ТОЙ ЖЕ функцией `summaryStage`, что и в карточке. Это условие
 * непротиворечивости экранов, а не удобство: разойдясь, два определения
 * показали бы про один комплект разное на двух экранах подряд.
 */
export interface FolderStageSummary {
  readonly folderId: string;
  readonly stage: ProcessingStage;
  readonly queued: number;
  readonly running: number;
  readonly dead: number;
}

export async function summarizeFolderStages(
  db: Database,
  folderIds: readonly string[],
): Promise<readonly FolderStageSummary[]> {
  if (folderIds.length === 0) return [];

  // Отбор выражен `inArray`, а не `= any($1)`: связанный МАССИВ приходится
  // объявлять типом на стороне SQL, и типов здесь два — `uuid` у попыток и
  // `text` у выражения над payload. Список идентификаторов ограничен размером
  // страницы (`MAX_PAGE_LIMIT`), поэтому развёрнутый `IN (...)` не растёт.
  const ids = [...folderIds];

  // Первый агрегат: в каких стадиях по ревизии вообще была активность. Индекс
  // `ix_job_runs_folder` (0007) закрывает отбор.
  const runRows = await db
    .select({
      folderId: jobRuns.folderId,
      jobTypes: sql<string[]>`array_agg(distinct ${jobRuns.jobType})`.as('job_types'),
    })
    .from(jobRuns)
    .where(inArray(jobRuns.folderId, ids))
    .groupBy(jobRuns.folderId);

  // Второй: что ещё стоит в очереди, идёт или умерло. Очередь ссылается на
  // ревизию через payload, без внешнего ключа, поэтому отбор текстовый — его и
  // закрывает частичный индекс `ix_jobs_folder` (0054).
  const folderOfJob = sql<string>`${jobs.payload} ->> 'folderId'`;
  const pendingRows = await db
    .select({
      folderId: folderOfJob.as('folder_id'),
      status: jobs.status,
      type: jobs.type,
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(jobs)
    .where(
      and(
        inArray(folderOfJob, ids),
        inArray(jobs.status, ['queued', 'running', 'failed'] as const),
      ),
    )
    .groupBy(folderOfJob, jobs.status, jobs.type);

  const stagesOf = new Map<string, Set<ProcessingStage>>();
  const add = (folderId: string, stage: ProcessingStage | null): void => {
    if (stage === null) return;
    const bucket = stagesOf.get(folderId) ?? new Set<ProcessingStage>();
    bucket.add(stage);
    stagesOf.set(folderId, bucket);
  };

  /** Стадии с НЕЗАКОНЧЕННОЙ работой: по ним сводка называет идущее (S50). */
  const pendingOf = new Map<string, Set<ProcessingStage>>();
  const addPending = (folderId: string, stage: ProcessingStage | null): void => {
    if (stage === null) return;
    const bucket = pendingOf.get(folderId) ?? new Set<ProcessingStage>();
    bucket.add(stage);
    pendingOf.set(folderId, bucket);
  };

  for (const row of runRows) {
    // `job_runs.folder_id` объявлен nullable (системные задачи ревизии не
    // имеют), но отбор выше оставил только те строки, чей идентификатор в
    // списке. Проверка нужна типу, а не данным.
    if (row.folderId === null) continue;
    for (const jobType of row.jobTypes) {
      add(row.folderId, isJobType(jobType) ? stageOf(jobType) : null);
    }
  }

  const counts = new Map<string, { queued: number; running: number; dead: number }>();
  for (const row of pendingRows) {
    const bucket = counts.get(row.folderId) ?? { queued: 0, running: 0, dead: 0 };
    if (row.status === 'queued') bucket.queued += row.count;
    if (row.status === 'running') bucket.running += row.count;
    if (row.status === 'failed') bucket.dead += row.count;
    counts.set(row.folderId, bucket);
    // Ждущая задача — это тоже активность стадии: комплект, у которого
    // распознавание только поставлено в очередь, уже не «на разметке».
    if (row.status !== 'failed') {
      const stage = isJobType(row.type) ? stageOf(row.type) : null;
      add(row.folderId, stage);
      addPending(row.folderId, stage);
    }
  }

  return folderIds.map((folderId) => {
    const bucket = counts.get(folderId) ?? { queued: 0, running: 0, dead: 0 };
    const stages = [...(stagesOf.get(folderId) ?? [])].map((stage) => ({ stage }));
    return {
      folderId,
      stage: summaryStage(stages, bucket.dead, [...(pendingOf.get(folderId) ?? [])]),
      queued: bucket.queued,
      running: bucket.running,
      dead: bucket.dead,
    };
  });
}

// =====================================================================
// События ревизии (§3.8) и outbox
// =====================================================================

export interface FolderEventView {
  readonly seq: number;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface AppendFolderEventInput {
  readonly folderId: string;
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
 * `folder_events_pkey`, и в журнале задачи осталось «duplicate key» ВМЕСТО
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
 * откате, а счётчик в `folders` ещё и держит блокировку этой строки до
 * конца транзакции, то есть заводит взаимоблокировку с любым кодом, который сначала
 * правит ревизию, а потом пишет событие (`workflow.ts`, `navigation.ts` — именно
 * такие). Дыры небезобидны: SSE отличает «пропущенное вне окна хранения» от «ничего
 * нового» сравнением `cursor + 1 < oldestSeq`, и на дырявой ленте это ложный `reset`.
 *
 * Области видимости у писателя нет: события пишет конвейер, у которого
 * пользователя нет. Читатель (`listFolderEvents`) область проверяет.
 */
export async function appendFolderEvent(
  db: JobExecutor,
  input: AppendFolderEventInput,
): Promise<number> {
  const payload = JSON.stringify(input.payload ?? {});

  for (let attempt = 1; attempt <= APPEND_EVENT_MAX_TRIES; attempt += 1) {
    // Ошибка драйвера наружу выходит как есть и повтора не получает: отказ записи
    // события обязан быть виден, а не растворён в цикле.
    const inserted = await db.execute<{ seq: string | number }>(sql`
      insert into ${folderEvents} (folder_id, seq, event_type, payload)
      select ${input.folderId}::uuid,
             coalesce(max(seq), 0) + 1,
             ${input.eventType},
             ${payload}::jsonb
        from ${folderEvents}
       where ${folderEvents.folderId} = ${input.folderId}::uuid
      on conflict (folder_id, seq) do nothing
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
      `не удалось назначить seq события ${input.eventType} ревизии ${input.folderId}: ` +
      `${String(APPEND_EVENT_MAX_TRIES)} подряд проигранных гонок за номер`,
  });
}

export interface FolderEventWindow {
  readonly events: readonly FolderEventView[];
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
export async function listFolderEvents(
  db: Database,
  scope: AuthScope,
  params: {
    readonly folderId: string;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  },
): Promise<FolderEventWindow | null> {
  const folder = await findVisibleFolder(db, scope, params.folderId);
  if (folder === null) return null;
  return readFolderEvents(db, params);
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
export async function readFolderEvents(
  db: JobExecutor,
  params: {
    readonly folderId: string;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  },
): Promise<FolderEventWindow> {
  const afterSeq = params.afterSeq ?? 0;

  const rows = await db.execute<{
    seq: string | number;
    event_type: string;
    payload: unknown;
    created_at: string;
  }>(sql`
    select seq, event_type, payload, ${sql.raw(ISO('created_at'))} as created_at
      from ${folderEvents}
     where ${folderEvents.folderId} = ${params.folderId}::uuid
       and ${folderEvents.seq} > ${afterSeq}
     order by seq
     limit ${params.limit}
  `);

  const bounds = await db.execute<{
    oldest: string | number | null;
    latest: string | number | null;
  }>(
    sql`
      select min(seq) as oldest, max(seq) as latest
        from ${folderEvents}
       where ${folderEvents.folderId} = ${params.folderId}::uuid
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
 * нет. Публикация (перенос в `folder_events`, а в будущем — во внешние
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

export const OUTBOX_FOLDER_AGGREGATE = 'submission_folder';

export interface PublishOutboxResult {
  readonly published: number;
  readonly events: number;
}

/**
 * Перенос неопубликованных записей outbox в события ревизии.
 *
 * Две таблицы не дублируют друг друга: `outbox` — это транзакционная запись
 * «событие произошло», а `folder_events` — упорядоченная лента с `seq`, по
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
      if (row.aggregate_type === OUTBOX_FOLDER_AGGREGATE) {
        await appendFolderEvent(tx, {
          folderId: row.aggregate_id,
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
    leaseExpiries: row.lease_expiries,
    priority: row.priority,
    nextRunAt: row.next_run_at,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    lastError: row.last_error,
    dedupeKey: row.dedupe_key,
    folderId: row.folder_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDead: status === 'failed',
  };
}

async function objectIdOfFolder(
  executor: JobExecutor,
  folderId: string | null,
): Promise<string | null> {
  if (folderId === null) return null;
  const rows = await executor.execute<{ object_id: string }>(sql`
    select object_id from ${folders}
     where ${folders.id} = ${folderId}::uuid
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
