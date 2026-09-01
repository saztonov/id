/**
 * Чтение журнала ошибок и работа с проблемами (§11, §14).
 *
 * ## Три числа, которые нельзя путать
 *
 * Экран журнала показывает три разные величины, и подмена одной другой — самый
 * вероятный способ соврать здесь пользователю:
 *
 *   • **проблемы** — сколько различных поломок видно за период;
 *   • **события** — сколько раз они происходили; берётся ТОЛЬКО из
 *     `error_stats_hourly`, где счёт точный;
 *   • **примеры** — сколько диагностических карточек сохранено; их число
 *     определяется политикой прореживания и к частоте отказов отношения не
 *     имеет.
 *
 * Поэтому здесь нет ни одной функции, которая считала бы события по
 * `error_samples`: такая функция вернула бы правдоподобное и неверное число.
 *
 * ## Сортировка по частоте не имеет курсора
 *
 * Частота — это сумма по бакетам за ВЫБРАННЫЙ период, то есть величина,
 * меняющаяся вместе с фильтром и растущая прямо во время листания. Keyset по
 * ней дал бы пропуски и повторы, а snapshot-пагинация означала бы хранение
 * снимка на сервере ради экрана, который читают сверху вниз. Возвращается топ,
 * и клиенту это сказано явным `nextCursor: null` — не «страница кончилась», а
 * «продолжения у этой сортировки нет».
 *
 * ## Область видимости
 *
 * У `error_issues` нет ни `object_id`, ни `contractor_id` — сопоставить
 * проблему с областью видимости нечем. Поэтому здесь тот же приём, что в
 * `audit.ts`: решение принимает `isUnrestricted()`, а ограниченная область (то
 * есть подрядчик) не получает НИЧЕГО. Право `diagnostics.read` выдано
 * только администратору, у которого область неограниченная, так что на практике
 * ветвь отсечения молчит; она существует, чтобы расширение матрицы прав не
 * открыло технические подробности всего портала инженеру одной строкой в
 * `PERMISSIONS`.
 */
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { errorIssueActions, errorIssues, errorSamples, errorSignatures } from '@id/db';
import type { JsonValue } from '@id/contracts';
import { isUnrestricted, type AuthScope } from '../../auth/scope.js';
import { badRequest } from '../../lib/problem.js';
import type { Database } from './users.js';

/** ISO-8601 из timestamptz: драйвер отдаёт форму, которую схема ответа не примет. */
function iso(column: unknown): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export type IssueStatus = 'new' | 'ack' | 'resolved';
export type IssueSort = 'last_seen' | 'frequency';

export interface IssueView {
  readonly id: string;
  readonly title: string;
  readonly status: IssueStatus;
  readonly priority: string;
  readonly isSynthetic: boolean;
  readonly source: string;
  readonly execution: string;
  readonly domain: string;
  readonly pipelineStage: string | null;
  readonly severity: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly firstRelease: string | null;
  readonly lastRelease: string | null;
  readonly assigneeUserId: string | null;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
  /** Число СОБЫТИЙ за выбранный период, из почасовых бакетов. */
  readonly events: number;
  readonly signatures: number;
}

export interface IssuePage {
  readonly items: readonly IssueView[];
  readonly nextCursor: string | null;
}

export interface ListIssuesParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly status?: IssueStatus | undefined;
  readonly source?: string | undefined;
  readonly domain?: string | undefined;
  readonly execution?: string | undefined;
  readonly severity?: string | undefined;
  readonly pipelineStage?: string | undefined;
  readonly release?: string | undefined;
  readonly search?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly sort?: IssueSort | undefined;
}

const cursorSchema = z.object({ at: z.string().min(1), id: z.string().min(1) });

/** Условие видимости. Разбор — в заголовке файла. */
function visibility(scope: AuthScope): SQL {
  // Подрядчик: сопоставить проблему с его организацией нечем, а показать всё
  // «раз фильтровать не по чему» — это утечка устройства портала.
  return isUnrestricted(scope) ? sql`true` : sql`false`;
}

function issueWhere(scope: AuthScope, ...conditions: (SQL | undefined)[]): SQL {
  return and(visibility(scope), ...conditions) ?? sql`false`;
}

/**
 * Служебная проблема-накопитель видна, только когда переполнение действительно
 * было.
 *
 * Иначе она висела бы в списке всегда и с нулём событий — постоянная строка
 * «переполнение сигнатур», о которой каждый новый дежурный будет спрашивать,
 * что она значит. «Переполнения не было» правильно выражается отсутствием
 * строки, а не строкой с нулём.
 */
function hideEmptySynthetic(params: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): SQL {
  const from =
    params.from === undefined ? sql`` : sql` AND h.bucket_at >= ${params.from}::timestamptz`;
  const to = params.to === undefined ? sql`` : sql` AND h.bucket_at <= ${params.to}::timestamptz`;
  return sql`(NOT ${errorIssues.isSynthetic} OR EXISTS (
    SELECT 1 FROM error_stats_hourly h
     WHERE h.issue_id = ${errorIssues.id} AND h.count > 0${from}${to}
  ))`;
}

function filters(params: ListIssuesParams): (SQL | undefined)[] {
  return [
    hideEmptySynthetic(params),
    params.status === undefined ? undefined : eq(errorIssues.status, params.status),
    params.source === undefined ? undefined : eq(errorIssues.source, params.source),
    params.domain === undefined ? undefined : eq(errorIssues.domain, params.domain),
    params.execution === undefined ? undefined : eq(errorIssues.execution, params.execution),
    params.severity === undefined ? undefined : eq(errorIssues.severity, params.severity),
    params.pipelineStage === undefined
      ? undefined
      : eq(errorIssues.pipelineStage, params.pipelineStage),
    params.release === undefined ? undefined : eq(errorIssues.lastRelease, params.release),
    // Период — по последнему появлению: «что происходило на этой неделе».
    params.from === undefined ? undefined : gte(errorIssues.lastSeenAt, params.from),
    params.to === undefined ? undefined : lte(errorIssues.lastSeenAt, params.to),
    // Поиск по заголовку и по шаблону сообщения любой из сигнатур: человек
    // помнит текст ошибки, а не её отпечаток.
    params.search === undefined
      ? undefined
      : sql`(${errorIssues.title} ILIKE ${'%' + params.search + '%'} OR EXISTS (
           SELECT 1 FROM ${errorSignatures} s
            WHERE s.issue_id = ${errorIssues.id}
              AND s.message_template ILIKE ${'%' + params.search + '%'}))`,
  ];
}

/**
 * Подзапрос числа событий за период.
 *
 * Границы те же, что у фильтра проблем: иначе на экране рядом со строкой
 * «за неделю» стояло бы число за всё время, и разница выглядела бы как дефект
 * счётчика, а не как разные вопросы.
 */
function eventsExpression(params: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): SQL<number> {
  const from =
    params.from === undefined ? sql`` : sql` AND h.bucket_at >= ${params.from}::timestamptz`;
  const to = params.to === undefined ? sql`` : sql` AND h.bucket_at <= ${params.to}::timestamptz`;
  return sql<number>`(
    SELECT COALESCE(SUM(h.count), 0)::bigint FROM error_stats_hourly h
     WHERE h.issue_id = ${errorIssues.id}${from}${to}
  )`;
}

const issueColumns = {
  id: errorIssues.id,
  title: errorIssues.title,
  status: errorIssues.status,
  priority: errorIssues.priority,
  isSynthetic: errorIssues.isSynthetic,
  source: errorIssues.source,
  execution: errorIssues.execution,
  domain: errorIssues.domain,
  pipelineStage: errorIssues.pipelineStage,
  severity: errorIssues.severity,
  firstRelease: errorIssues.firstRelease,
  lastRelease: errorIssues.lastRelease,
  assigneeUserId: errorIssues.assigneeUserId,
  resolution: errorIssues.resolution,
};

export async function listIssues(
  db: Database,
  scope: AuthScope,
  params: ListIssuesParams,
): Promise<IssuePage> {
  const selection = {
    ...issueColumns,
    firstSeenAt: iso(errorIssues.firstSeenAt).as('first_seen_iso'),
    lastSeenAt: iso(errorIssues.lastSeenAt).as('last_seen_iso'),
    resolvedAt: iso(errorIssues.resolvedAt).as('resolved_iso'),
    // Машинное значение только для курсора: `to_char` округляет микросекунды,
    // и запись того же тика была бы пропущена или выдана дважды.
    cursorAt: sql<string>`${errorIssues.lastSeenAt}::text`.as('cursor_at'),
    events: eventsExpression(params).as('events'),
    signatures: sql<number>`(
      SELECT count(*)::int FROM error_signatures s WHERE s.issue_id = ${errorIssues.id}
    )`.as('signatures'),
  };

  if ((params.sort ?? 'last_seen') === 'frequency') {
    const rows = await db
      .select(selection)
      .from(errorIssues)
      .where(issueWhere(scope, ...filters(params)))
      .orderBy(desc(sql`events`), desc(errorIssues.lastSeenAt))
      .limit(params.limit);

    // Курсора у этой сортировки нет по построению (см. заголовок файла).
    return { items: rows.map(toIssueView), nextCursor: null };
  }

  const after = decodeCursor(params.cursor);
  const rows = await db
    .select(selection)
    .from(errorIssues)
    .where(
      issueWhere(
        scope,
        after === null
          ? undefined
          : sql`(${errorIssues.lastSeenAt}, ${errorIssues.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        ...filters(params),
      ),
    )
    .orderBy(desc(errorIssues.lastSeenAt), desc(errorIssues.id))
    // На одну больше запрошенного: наличие следующей страницы известно без
    // отдельного COUNT по тому же условию.
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ at: last.cursorAt, id: last.id })
      : null;

  return { items: page.map(toIssueView), nextCursor };
}

/**
 * Строка в том виде, в котором её отдаёт драйвер.
 *
 * Шире, чем `IssueView`: `status` в схеме — обычный `text` с CHECK, а `count`
 * приезжает строкой, потому что `bigint` не помещается в `number` без потерь.
 * Сужение выполняется здесь и только здесь.
 */
type IssueRow = Omit<IssueView, 'status' | 'events' | 'signatures'> & {
  readonly status: string;
  readonly events: number | string;
  readonly signatures: number | string;
  readonly cursorAt?: string;
};

function toIssueView(row: IssueRow): IssueView {
  const { cursorAt: _cursorAt, ...rest } = row;
  return {
    ...rest,
    status: rest.status as IssueStatus,
    events: Number(rest.events),
    signatures: Number(rest.signatures),
  };
}

export interface JournalSummary {
  /** Различных поломок за период. */
  readonly issues: number;
  readonly newIssues: number;
  /** Событий за период — точное число из бакетов. */
  readonly events: number;
  /** Сохранённых примеров: величина политики прореживания, не частоты. */
  readonly samples: number;
  readonly byDomain: readonly { readonly domain: string; readonly events: number }[];
  readonly bySource: readonly { readonly source: string; readonly events: number }[];
}

/**
 * Сводка за период.
 *
 * Все три числа берутся из своих источников, а не выводятся одно из другого:
 * события — из бакетов, примеры — из примеров, проблемы — из проблем. Считать
 * события по примерам было бы дешевле и неверно на три порядка.
 */
export async function journalSummary(
  db: Database,
  scope: AuthScope,
  period: { readonly from: string; readonly to: string },
): Promise<JournalSummary> {
  if (!isUnrestricted(scope)) {
    return { issues: 0, newIssues: 0, events: 0, samples: 0, byDomain: [], bySource: [] };
  }

  // Условие «видимой» проблемы то же, что в списке: число в шапке обязано
  // совпадать с числом строк под ней, иначе первый же взгляд на экран рождает
  // вопрос, на который никто не сможет ответить.
  const visible = sql`
    last_seen_at >= ${period.from}::timestamptz
    AND last_seen_at <= ${period.to}::timestamptz
    AND (NOT is_synthetic OR EXISTS (
      SELECT 1 FROM error_stats_hourly h
       WHERE h.issue_id = error_issues.id AND h.count > 0
         AND h.bucket_at >= ${period.from}::timestamptz
         AND h.bucket_at <= ${period.to}::timestamptz))`;

  const totalsResult = await db.execute<{
    issues: number;
    new_issues: number;
    events: number;
    samples: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM error_issues WHERE ${visible}) AS issues,
      (SELECT count(*)::int FROM error_issues
        WHERE status = 'new' AND ${visible}) AS new_issues,
      (SELECT COALESCE(SUM(count), 0)::bigint FROM error_stats_hourly
        WHERE bucket_at >= ${period.from}::timestamptz
          AND bucket_at <= ${period.to}::timestamptz) AS events,
      (SELECT count(*)::int FROM error_samples
        WHERE at >= ${period.from}::timestamptz
          AND at <= ${period.to}::timestamptz) AS samples
  `);
  const totals = totalsResult.rows[0];

  const byDomain = await db.execute<{ domain: string; events: number }>(sql`
    SELECT domain, COALESCE(SUM(count), 0)::bigint AS events
      FROM error_stats_hourly
     WHERE bucket_at >= ${period.from}::timestamptz AND bucket_at <= ${period.to}::timestamptz
     GROUP BY domain ORDER BY events DESC
  `);

  const bySource = await db.execute<{ source: string; events: number }>(sql`
    SELECT source, COALESCE(SUM(count), 0)::bigint AS events
      FROM error_stats_hourly
     WHERE bucket_at >= ${period.from}::timestamptz AND bucket_at <= ${period.to}::timestamptz
     GROUP BY source ORDER BY events DESC
  `);

  return {
    issues: Number(totals?.issues ?? 0),
    newIssues: Number(totals?.new_issues ?? 0),
    events: Number(totals?.events ?? 0),
    samples: Number(totals?.samples ?? 0),
    byDomain: byDomain.rows.map((row) => ({ domain: row.domain, events: Number(row.events) })),
    bySource: bySource.rows.map((row) => ({ source: row.source, events: Number(row.events) })),
  };
}

export interface SignatureView {
  readonly fingerprint: string;
  readonly algoVersion: number;
  readonly errorClass: string;
  readonly messageTemplate: string;
  readonly topFrame: string | null;
  readonly source: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface SampleView {
  readonly id: number;
  readonly at: string;
  readonly fingerprint: string;
  readonly source: string;
  readonly execution: string;
  readonly domain: string;
  readonly pipelineStage: string | null;
  readonly severity: string;
  readonly release: string | null;
  readonly requestId: string | null;
  readonly clientEventId: string | null;
  readonly userId: string | null;
  readonly route: string | null;
  readonly statusCode: number | null;
  readonly errorCode: string | null;
  readonly objectId: string | null;
  readonly folderId: string | null;
  readonly jobId: string | null;
  readonly jobType: string | null;
  readonly attempt: number | null;
  readonly repeatCount: number;
  readonly context: JsonValue;
}

export interface ActionView {
  readonly id: number;
  readonly at: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly payload: JsonValue;
}

export interface SeriesPoint {
  readonly bucketAt: string;
  readonly release: string;
  readonly events: number;
}

export interface IssueDetail {
  readonly issue: IssueView;
  readonly signatures: readonly SignatureView[];
  readonly samples: readonly SampleView[];
  readonly actions: readonly ActionView[];
}

const SAMPLES_IN_CARD = 50;

export async function findIssue(
  db: Database,
  scope: AuthScope,
  issueId: string,
  period: { readonly from?: string | undefined; readonly to?: string | undefined } = {},
): Promise<IssueDetail | null> {
  const [issue] = await db
    .select({
      ...issueColumns,
      firstSeenAt: iso(errorIssues.firstSeenAt).as('first_seen_iso'),
      lastSeenAt: iso(errorIssues.lastSeenAt).as('last_seen_iso'),
      resolvedAt: iso(errorIssues.resolvedAt).as('resolved_iso'),
      events: eventsExpression(period).as('events'),
      signatures: sql<number>`(
        SELECT count(*)::int FROM error_signatures s WHERE s.issue_id = ${errorIssues.id}
      )`.as('signatures'),
    })
    .from(errorIssues)
    .where(issueWhere(scope, eq(errorIssues.id, issueId)))
    .limit(1);

  if (issue === undefined) return null;

  const signatures = await db
    .select({
      fingerprint: errorSignatures.fingerprint,
      algoVersion: errorSignatures.algoVersion,
      errorClass: errorSignatures.errorClass,
      messageTemplate: errorSignatures.messageTemplate,
      topFrame: errorSignatures.topFrame,
      source: errorSignatures.source,
      firstSeenAt: iso(errorSignatures.firstSeenAt).as('first_seen_iso'),
      lastSeenAt: iso(errorSignatures.lastSeenAt).as('last_seen_iso'),
    })
    .from(errorSignatures)
    .where(eq(errorSignatures.issueId, issueId))
    .orderBy(desc(errorSignatures.lastSeenAt));

  const samples = await db
    .select(sampleSelection())
    .from(errorSamples)
    .where(eq(errorSamples.issueId, issueId))
    .orderBy(desc(errorSamples.at), desc(errorSamples.id))
    .limit(SAMPLES_IN_CARD);

  const actions = await db
    .select({
      id: errorIssueActions.id,
      at: iso(errorIssueActions.at).as('at_iso'),
      actorUserId: errorIssueActions.actorUserId,
      action: errorIssueActions.action,
      payload: errorIssueActions.payload,
    })
    .from(errorIssueActions)
    .where(eq(errorIssueActions.issueId, issueId))
    .orderBy(desc(errorIssueActions.at), desc(errorIssueActions.id));

  return {
    issue: toIssueView(issue as IssueRow),
    signatures,
    samples: samples.map(toSampleView),
    actions: actions.map((row) => ({ ...row, payload: (row.payload ?? {}) as JsonValue })),
  };
}

function sampleSelection() {
  return {
    id: errorSamples.id,
    at: iso(errorSamples.at).as('at_iso'),
    cursorAt: sql<string>`${errorSamples.at}::text`.as('cursor_at'),
    fingerprint: errorSamples.fingerprint,
    source: errorSamples.source,
    execution: errorSamples.execution,
    domain: errorSamples.domain,
    pipelineStage: errorSamples.pipelineStage,
    severity: errorSamples.severity,
    release: errorSamples.release,
    requestId: errorSamples.requestId,
    clientEventId: errorSamples.clientEventId,
    userId: errorSamples.userId,
    route: errorSamples.route,
    statusCode: errorSamples.statusCode,
    errorCode: errorSamples.errorCode,
    objectId: errorSamples.objectId,
    folderId: errorSamples.folderId,
    jobId: errorSamples.jobId,
    jobType: errorSamples.jobType,
    attempt: errorSamples.attempt,
    repeatCount: errorSamples.repeatCount,
    context: errorSamples.context,
  };
}

type SampleRow = Omit<SampleView, 'context'> & {
  readonly context: unknown;
  readonly cursorAt?: string;
};

function toSampleView(row: SampleRow): SampleView {
  const { cursorAt: _cursorAt, ...rest } = row;
  return { ...rest, context: (rest.context ?? {}) as JsonValue };
}

/**
 * Ряд по часам с разбивкой по релизу.
 *
 * Ровно этим отвечают на «сломалось после деплоя»: две точки одного часа с
 * разными релизами показывают переход, которого суммарный счётчик не покажет
 * никогда.
 */
export async function issueSeries(
  db: Database,
  scope: AuthScope,
  issueId: string,
  period: { readonly from: string; readonly to: string },
): Promise<readonly SeriesPoint[]> {
  if (!isUnrestricted(scope)) return [];

  const rows = await db.execute<{ bucket_at: string; release: string; events: number }>(sql`
    SELECT to_char(bucket_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bucket_at,
           release,
           SUM(count)::bigint AS events
      FROM error_stats_hourly
     WHERE issue_id = ${issueId}::uuid
       AND bucket_at >= ${period.from}::timestamptz
       AND bucket_at <= ${period.to}::timestamptz
     GROUP BY bucket_at, release
     ORDER BY bucket_at
  `);

  return rows.rows.map((row) => ({
    bucketAt: row.bucket_at,
    release: row.release,
    events: Number(row.events),
  }));
}

export interface SamplePage {
  readonly items: readonly SampleView[];
  readonly nextCursor: string | null;
}

export interface ListSamplesParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly issueId?: string | undefined;
  readonly fingerprint?: string | undefined;
  readonly requestId?: string | undefined;
  readonly clientEventId?: string | undefined;
  readonly userId?: string | undefined;
  readonly route?: string | undefined;
  readonly domain?: string | undefined;
  readonly source?: string | undefined;
  readonly severity?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** Сквозная лента примеров. Именно примеров — см. заголовок файла. */
export async function listSamples(
  db: Database,
  scope: AuthScope,
  params: ListSamplesParams,
): Promise<SamplePage> {
  if (!isUnrestricted(scope)) return { items: [], nextCursor: null };

  const after = decodeCursor(params.cursor);
  const rows = await db
    .select(sampleSelection())
    .from(errorSamples)
    .where(
      and(
        after === null
          ? undefined
          : sql`(${errorSamples.at}, ${errorSamples.id}) < (${after.at}::timestamptz, ${after.id}::bigint)`,
        params.issueId === undefined ? undefined : eq(errorSamples.issueId, params.issueId),
        params.fingerprint === undefined
          ? undefined
          : eq(errorSamples.fingerprint, params.fingerprint),
        params.requestId === undefined ? undefined : eq(errorSamples.requestId, params.requestId),
        params.clientEventId === undefined
          ? undefined
          : eq(errorSamples.clientEventId, params.clientEventId),
        params.userId === undefined ? undefined : eq(errorSamples.userId, params.userId),
        params.route === undefined ? undefined : eq(errorSamples.route, params.route),
        params.domain === undefined ? undefined : eq(errorSamples.domain, params.domain),
        params.source === undefined ? undefined : eq(errorSamples.source, params.source),
        params.severity === undefined ? undefined : eq(errorSamples.severity, params.severity),
        params.from === undefined ? undefined : gte(errorSamples.at, params.from),
        params.to === undefined ? undefined : lte(errorSamples.at, params.to),
      ),
    )
    .orderBy(desc(errorSamples.at), desc(errorSamples.id))
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ at: last.cursorAt, id: String(last.id) })
      : null;

  return { items: page.map(toSampleView), nextCursor };
}

export type IssueActionKind = 'acknowledge' | 'comment' | 'resolve' | 'reopen' | 'assign';

export interface ApplyActionParams {
  readonly issueId: string;
  readonly action: IssueActionKind;
  readonly actorUserId: string;
  readonly comment?: string | undefined;
  readonly rootCause?: string | undefined;
  readonly resolution?: string | undefined;
  readonly resolutionType?: string | undefined;
  readonly fixedInRelease?: string | undefined;
  readonly assigneeUserId?: string | null | undefined;
  readonly priority?: string | undefined;
}

/**
 * Действие над проблемой.
 *
 * Состояние и история пишутся ОДНОЙ транзакцией вместе со следом в `audit_log`
 * (его добавляет вызывающий той же транзакцией). Разделить их нельзя: смена
 * статуса без записи в историю превращает «что уже пробовали» в догадку, а
 * запись без смены статуса — во враньё.
 *
 * `resolve` требует автора не из вежливости: ограничение
 * `error_issues_resolved_chk` не примет закрытие без него.
 */
export type JournalAuditWriter = (
  executor: Pick<Database, 'select' | 'insert' | 'update' | 'delete'>,
) => Promise<void>;

export async function applyIssueAction(
  db: Database,
  params: ApplyActionParams,
  audit?: JournalAuditWriter,
): Promise<IssueStatus | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: errorIssues.status })
      .from(errorIssues)
      .where(eq(errorIssues.id, params.issueId))
      .limit(1);
    if (current === undefined) return null;

    const next = nextStatus(current.status as IssueStatus, params.action);

    await tx
      .update(errorIssues)
      .set({
        status: next,
        ...(params.action === 'acknowledge'
          ? { ackedAt: sql`now()`, ackedBy: params.actorUserId }
          : {}),
        ...(params.action === 'resolve'
          ? {
              resolvedAt: sql`now()`,
              resolvedBy: params.actorUserId,
              rootCause: params.rootCause ?? null,
              resolution: params.resolution ?? null,
              resolutionType: params.resolutionType ?? null,
              fixedInRelease: params.fixedInRelease ?? null,
            }
          : {}),
        // Переоткрытие снимает отметку о закрытии, но НЕ трогает разбор:
        // прежнее решение остаётся видно рядом с новым появлением.
        ...(params.action === 'reopen' ? { resolvedAt: null, resolvedBy: null } : {}),
        ...(params.action === 'assign' ? { assigneeUserId: params.assigneeUserId ?? null } : {}),
        ...(params.priority === undefined ? {} : { priority: params.priority }),
      })
      .where(eq(errorIssues.id, params.issueId));

    await tx.insert(errorIssueActions).values({
      issueId: params.issueId,
      actorUserId: params.actorUserId,
      action: params.action,
      payload: {
        ...(params.comment === undefined ? {} : { comment: params.comment }),
        ...(params.rootCause === undefined ? {} : { root_cause: params.rootCause }),
        ...(params.resolution === undefined ? {} : { resolution: params.resolution }),
        ...(params.resolutionType === undefined ? {} : { resolution_type: params.resolutionType }),
        ...(params.fixedInRelease === undefined ? {} : { fixed_in_release: params.fixedInRelease }),
        ...(params.assigneeUserId === undefined ? {} : { assignee: params.assigneeUserId }),
      },
    });

    // След аудита пишется ТОЙ ЖЕ транзакцией: смена статуса, история и
    // журнал аудита обязаны быть одним фактом. Аудит, который может не
    // записаться, бесполезен ровно в тех случаях, ради которых он ведётся.
    if (audit !== undefined) await audit(tx);

    return next;
  });
}

/**
 * Статус после действия.
 *
 * `comment` и `assign` статуса не меняют: обсуждение и назначение — не решение.
 * Это единственное место, где переходы описаны, и добавление действия без
 * записи здесь даст ошибку компиляции, а не молчаливое «статус остался прежним».
 */
function nextStatus(current: IssueStatus, action: IssueActionKind): IssueStatus {
  switch (action) {
    case 'acknowledge':
      return 'ack';
    case 'resolve':
      return 'resolved';
    case 'reopen':
      return 'new';
    case 'comment':
    case 'assign':
      return current;
  }
}

export interface PruneParams {
  readonly sampleRetentionDays: number;
  readonly statsRetentionDays: number;
  /** Медленные операции интересны свежими: срок короче, чем у ряда ошибок. */
  readonly slowRetentionDays: number;
  readonly samplesPerIssue: number;
  readonly batchSize?: number | undefined;
}

export interface PruneResult {
  readonly samplesDeleted: number;
  readonly statsDeleted: number;
  readonly locked: boolean;
}

/** Ключ advisory-блокировки очистки. Произвольная константа, важна уникальность. */
const PRUNE_LOCK_KEY = 0x1d0a_e770;

/**
 * Очистка журнала по срокам хранения.
 *
 * Под `pg_try_advisory_lock`, потому что цикл живёт в каждом процессе с
 * `JobRunner`: без блокировки два процесса удаляли бы одни строки, блокируя
 * друг друга и раздувая WAL, — а выигрыша от параллельности здесь нет никакого.
 * Не получивший блокировку просто уходит: следующий час его очередь.
 *
 * Пакетами, а не одним `DELETE`: удаление годового хвоста разом держит
 * долгую транзакцию и блокировки на таблице, в которую в этот момент пишет
 * журнал.
 *
 * Проблемы, их история и решения НЕ удаляются ни при каких сроках: это
 * накопленное знание, и оно не содержит ни ПДн, ни контекста.
 */
export async function pruneJournal(db: Database, params: PruneParams): Promise<PruneResult> {
  const batch = params.batchSize ?? 10_000;

  const lock = await db.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_lock(${PRUNE_LOCK_KEY}) AS locked`,
  );
  if (lock.rows[0]?.locked !== true) return { samplesDeleted: 0, statsDeleted: 0, locked: false };

  try {
    let samplesDeleted = 0;
    for (;;) {
      const deleted = await db.execute<{ id: number }>(sql`
        DELETE FROM error_samples WHERE id IN (
          SELECT id FROM error_samples
           WHERE at < now() - make_interval(days => ${params.sampleRetentionDays})
           LIMIT ${batch}
        ) RETURNING id
      `);
      samplesDeleted += deleted.rows.length;
      if (deleted.rows.length < batch) break;
    }

    // Потолок примеров на проблему: политика прореживания держит их редкими, но
    // за год редкое накапливается, а карточка показывает последние 50.
    const trimmed = await db.execute<{ id: number }>(sql`
      DELETE FROM error_samples WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY issue_id ORDER BY at DESC, id DESC) AS rn
            FROM error_samples
        ) ranked WHERE rn > ${params.samplesPerIssue}
      ) RETURNING id
    `);
    samplesDeleted += trimmed.rows.length;

    let statsDeleted = 0;
    for (;;) {
      const deleted = await db.execute<{ issue_id: string }>(sql`
        DELETE FROM error_stats_hourly WHERE ctid IN (
          SELECT ctid FROM error_stats_hourly
           WHERE bucket_at < now() - make_interval(days => ${params.statsRetentionDays})
           LIMIT ${batch}
        ) RETURNING issue_id
      `);
      statsDeleted += deleted.rows.length;
      if (deleted.rows.length < batch) break;
    }

    // Счётчики потока B чистятся тем же циклом и по сроку статистики: они
    // такой же почасовой ряд, только про другое.
    await db.execute(sql`
      DELETE FROM http_anomaly_stats_hourly
       WHERE bucket_at < now() - make_interval(days => ${params.statsRetentionDays})
    `);
    await db.execute(sql`
      DELETE FROM slow_operations
       WHERE bucket_at < now() - make_interval(days => ${params.slowRetentionDays})
    `);

    return { samplesDeleted, statsDeleted, locked: true };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${PRUNE_LOCK_KEY})`);
  }
}

function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Повреждённый курсор — ошибка запроса, а не «начнём заново».
 *
 * Молча вернуть первую страницу значило бы выдать за продолжение списка его
 * начало: клиент, листающий журнал, получил бы бесконечный цикл из первых
 * страниц и не смог бы этого заметить.
 */
function decodeCursor(cursor: string | null | undefined): z.infer<typeof cursorSchema> | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return cursorSchema.parse(parsed);
  } catch {
    throw badRequest('Курсор страницы недействителен.');
  }
}

// =====================================================================
// Поток B: значимые отказы и медленные операции
// =====================================================================

export interface AnomalyRow {
  readonly route: string;
  readonly statusCode: number;
  readonly problemSlug: string;
  readonly count: number;
}

export interface SlowOperationRow {
  readonly kind: string;
  readonly target: string;
  readonly count: number;
  readonly maxMs: number;
  /** Среднее по периоду: считается из суммы, а не хранится. */
  readonly avgMs: number;
  readonly thresholdMs: number;
  readonly sampleRequestId: string | null;
}

/**
 * Всплески значимых отказов за период.
 *
 * Строки складываются по часам: экран отвечает на «где и сколько», а не «когда
 * именно» — на второй вопрос отвечает ряд, и заводить его здесь до появления
 * спроса значило бы рисовать график, на который никто не смотрит.
 */
export async function listHttpAnomalies(
  db: Database,
  scope: AuthScope,
  period: { readonly from: string; readonly to: string },
): Promise<readonly AnomalyRow[]> {
  if (!isUnrestricted(scope)) return [];

  const rows = await db.execute<{
    route: string;
    status_code: number;
    problem_slug: string;
    count: string;
  }>(sql`
    SELECT route, status_code, problem_slug, SUM(count)::bigint AS count
      FROM http_anomaly_stats_hourly
     WHERE bucket_at >= ${period.from}::timestamptz AND bucket_at <= ${period.to}::timestamptz
     GROUP BY route, status_code, problem_slug
     ORDER BY count DESC
     LIMIT 200
  `);

  return rows.rows.map((row) => ({
    route: row.route,
    statusCode: row.status_code,
    problemSlug: row.problem_slug,
    count: Number(row.count),
  }));
}

/**
 * Медленные операции за период.
 *
 * Среднее считается как `sum_ms / count`, а не хранится: среднее по часу
 * нельзя сложить со средним другого часа, и хранимое поле сделало бы
 * произвольный период невычислимым.
 */
export async function listSlowOperations(
  db: Database,
  scope: AuthScope,
  period: { readonly from: string; readonly to: string; readonly kind?: string | undefined },
): Promise<readonly SlowOperationRow[]> {
  if (!isUnrestricted(scope)) return [];

  const kindFilter = period.kind === undefined ? sql`` : sql` AND kind = ${period.kind}`;
  const rows = await db.execute<{
    kind: string;
    target: string;
    count: string;
    max_ms: number;
    sum_ms: string;
    threshold_ms: number;
    sample_request_id: string | null;
  }>(sql`
    SELECT kind, target,
           SUM(count)::bigint AS count,
           MAX(max_ms)::int AS max_ms,
           SUM(sum_ms)::bigint AS sum_ms,
           MAX(threshold_ms)::int AS threshold_ms,
           MIN(sample_request_id) AS sample_request_id
      FROM slow_operations
     WHERE bucket_at >= ${period.from}::timestamptz
       AND bucket_at <= ${period.to}::timestamptz${kindFilter}
     GROUP BY kind, target
     ORDER BY count DESC
     LIMIT 200
  `);

  return rows.rows.map((row) => {
    const count = Number(row.count);
    return {
      kind: row.kind,
      target: row.target,
      count,
      maxMs: Number(row.max_ms),
      avgMs: count === 0 ? 0 : Math.round(Number(row.sum_ms) / count),
      thresholdMs: Number(row.threshold_ms),
      sampleRequestId: row.sample_request_id,
    };
  });
}
