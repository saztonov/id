/**
 * Чтение обратной связи конвейера (§11, ADR-0010).
 *
 * ## Доля, а не количество
 *
 * «Сто невалидных ответов» не значит ничего: сто из ста тысяч — нормальная
 * работа, сто из ста двадцати — сломанный промт. Поэтому срез считает
 * ЗНАМЕНАТЕЛЬ — число вызовов той же комбинации промта, версии и модели — по
 * `ai_runs`, а не заводит второй счётчик. Второй счётчик однажды разошёлся бы с
 * первым, и разойтись он мог бы только незаметно.
 *
 * Знаменатель бывает неизвестен: у стадий без вызова модели (детекция, ручные
 * правки) `ai_runs` не пишется вовсе. Тогда доля возвращается `null`, а НЕ
 * ноль: ноль на экране читается как «дефектов нет», то есть как утверждение,
 * противоположное истинному.
 *
 * ## Выгрузка отдаёт идентификаторы, а не содержимое
 *
 * Файл, уходящий в работу над промтом, содержит коды, версии и идентификаторы
 * страниц и блоков. Ни текста документа, ни ответа модели в нём нет: §11
 * относит их к ПДн, а выгрузка по определению покидает портал. Инженер
 * открывает кроп в самом портале по `layout_block_id`.
 */
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { processingFeedback } from '@id/db';
import type { JsonValue } from '@id/contracts';
import { isUnrestricted, type AuthScope } from '../../auth/scope.js';
import { badRequest } from '../../lib/problem.js';
import type { Database } from './users.js';

function iso(column: unknown): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export interface FeedbackFilters {
  readonly reasonCode?: string | undefined;
  readonly feedbackType?: string | undefined;
  readonly pipelineStage?: string | undefined;
  readonly promptCode?: string | undefined;
  readonly promptVersion?: number | undefined;
  readonly model?: string | undefined;
  readonly docTypeCode?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface FeedbackEventView {
  readonly id: number;
  readonly at: string;
  readonly feedbackType: string;
  readonly reasonCode: string;
  readonly severity: string;
  readonly revisionId: string | null;
  readonly recognitionRunId: string | null;
  readonly sourcePageId: string | null;
  readonly workingPageIndex: number | null;
  readonly layoutBlockId: string | null;
  readonly fieldCode: string | null;
  readonly docTypeCode: string | null;
  readonly pipelineStage: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptCode: string | null;
  readonly promptVersion: number | null;
  readonly detectorModelVersion: string | null;
  readonly appRelease: string | null;
  readonly score: number | null;
  readonly observed: JsonValue;
  readonly expected: JsonValue;
  readonly requestId: string | null;
}

export interface FeedbackPage {
  readonly items: readonly FeedbackEventView[];
  readonly nextCursor: string | null;
}

export interface FeedbackSummaryRow {
  readonly reasonCode: string;
  readonly pipelineStage: string | null;
  readonly promptCode: string | null;
  readonly promptVersion: number | null;
  readonly model: string | null;
  readonly docTypeCode: string | null;
  /** Сколько дефектов этой комбинации за период. */
  readonly defects: number;
  /** Сколько всего было вызовов модели той же комбинации; `null` — неизвестно. */
  readonly calls: number | null;
  /** Доля дефектов; `null`, когда знаменатель неизвестен. */
  readonly rate: number | null;
  /** Медиана уверенности, если стадия её знает. */
  readonly medianScore: number | null;
}

const cursorSchema = z.object({ at: z.string().min(1), id: z.string().min(1) });

function visible(scope: AuthScope): boolean {
  // Право `diagnostics.read` выдано только администратору, у которого область
  // неограниченная. Ветвь отсечения — гарантия на случай расширения матрицы:
  // сопоставить дефект конвейера с областью инженера нечем.
  return isUnrestricted(scope);
}

function conditions(params: FeedbackFilters): (SQL | undefined)[] {
  return [
    params.reasonCode === undefined
      ? undefined
      : eq(processingFeedback.reasonCode, params.reasonCode),
    params.feedbackType === undefined
      ? undefined
      : eq(processingFeedback.feedbackType, params.feedbackType),
    params.pipelineStage === undefined
      ? undefined
      : eq(processingFeedback.pipelineStage, params.pipelineStage),
    params.promptCode === undefined
      ? undefined
      : eq(processingFeedback.promptCode, params.promptCode),
    params.promptVersion === undefined
      ? undefined
      : eq(processingFeedback.promptVersion, params.promptVersion),
    params.model === undefined ? undefined : eq(processingFeedback.model, params.model),
    params.docTypeCode === undefined
      ? undefined
      : eq(processingFeedback.docTypeCode, params.docTypeCode),
    params.revisionId === undefined
      ? undefined
      : eq(processingFeedback.revisionId, params.revisionId),
    params.from === undefined ? undefined : gte(processingFeedback.at, params.from),
    params.to === undefined ? undefined : lte(processingFeedback.at, params.to),
  ];
}

const selection = {
  id: processingFeedback.id,
  at: iso(processingFeedback.at).as('at_iso'),
  cursorAt: sql<string>`${processingFeedback.at}::text`.as('cursor_at'),
  feedbackType: processingFeedback.feedbackType,
  reasonCode: processingFeedback.reasonCode,
  severity: processingFeedback.severity,
  revisionId: processingFeedback.revisionId,
  recognitionRunId: processingFeedback.recognitionRunId,
  sourcePageId: processingFeedback.sourcePageId,
  workingPageIndex: processingFeedback.workingPageIndex,
  layoutBlockId: processingFeedback.layoutBlockId,
  fieldCode: processingFeedback.fieldCode,
  docTypeCode: processingFeedback.docTypeCode,
  pipelineStage: processingFeedback.pipelineStage,
  provider: processingFeedback.provider,
  model: processingFeedback.model,
  promptCode: processingFeedback.promptCode,
  promptVersion: processingFeedback.promptVersion,
  detectorModelVersion: processingFeedback.detectorModelVersion,
  appRelease: processingFeedback.appRelease,
  score: processingFeedback.score,
  observed: processingFeedback.observed,
  expected: processingFeedback.expected,
  requestId: processingFeedback.requestId,
};

type FeedbackRow = Omit<FeedbackEventView, 'observed' | 'expected'> & {
  readonly observed: unknown;
  readonly expected: unknown;
  readonly cursorAt?: string;
};

function toView(row: FeedbackRow): FeedbackEventView {
  const { cursorAt: _cursorAt, ...rest } = row;
  return {
    ...rest,
    observed: (rest.observed ?? {}) as JsonValue,
    expected: (rest.expected ?? {}) as JsonValue,
  };
}

export async function listFeedbackEvents(
  db: Database,
  scope: AuthScope,
  params: FeedbackFilters & { readonly limit: number; readonly cursor?: string | null | undefined },
): Promise<FeedbackPage> {
  if (!visible(scope)) return { items: [], nextCursor: null };

  const after = decodeCursor(params.cursor);
  const rows = await db
    .select(selection)
    .from(processingFeedback)
    .where(
      and(
        after === null
          ? undefined
          : sql`(${processingFeedback.at}, ${processingFeedback.id}) < (${after.at}::timestamptz, ${after.id}::bigint)`,
        ...conditions(params),
      ),
    )
    .orderBy(desc(processingFeedback.at), desc(processingFeedback.id))
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ at: last.cursorAt, id: String(last.id) })
      : null;

  return { items: page.map(toView), nextCursor };
}

/**
 * Срез по причине и версии инструмента.
 *
 * Знаменатель берётся из `ai_runs` подзапросом по той же тройке
 * (промт, версия, модель) и тому же периоду. `LEFT JOIN` не годится: он
 * размножил бы строки дефектов на строки вызовов, и «доля» превысила бы
 * единицу — тихо и правдоподобно.
 */
/**
 * Псевдонима у таблицы здесь нет намеренно.
 *
 * Условия фильтра строит drizzle, и он подставляет в них ПОЛНОЕ имя таблицы
 * (`processing_feedback.reason_code`). Псевдоним `f` скрыл бы это имя, и запрос
 * упал бы на «missing FROM-clause entry» — причём только при непустом фильтре,
 * то есть не на первом же прогоне.
 */
export async function feedbackSummary(
  db: Database,
  scope: AuthScope,
  params: FeedbackFilters & { readonly from: string; readonly to: string },
): Promise<readonly FeedbackSummaryRow[]> {
  if (!visible(scope)) return [];

  const filters = conditions(params).filter((item): item is SQL => item !== undefined);
  const where = filters.length === 0 ? sql`true` : (and(...filters) ?? sql`true`);

  const rows = await db.execute<{
    reason_code: string;
    pipeline_stage: string | null;
    prompt_code: string | null;
    prompt_version: number | null;
    model: string | null;
    doc_type_code: string | null;
    defects: string;
    calls: string | null;
    median_score: number | null;
  }>(sql`
    SELECT processing_feedback.reason_code,
           processing_feedback.pipeline_stage,
           processing_feedback.prompt_code,
           processing_feedback.prompt_version,
           processing_feedback.model,
           processing_feedback.doc_type_code,
           count(*)::bigint AS defects,
           (
             SELECT count(*)::bigint FROM ai_runs r
              WHERE r.prompt_code IS NOT DISTINCT FROM processing_feedback.prompt_code
                AND r.prompt_version IS NOT DISTINCT FROM processing_feedback.prompt_version
                AND r.model IS NOT DISTINCT FROM processing_feedback.model
                AND r.created_at >= ${params.from}::timestamptz
                AND r.created_at <= ${params.to}::timestamptz
           ) AS calls,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY processing_feedback.score) AS median_score
      FROM processing_feedback
     WHERE ${where}
     GROUP BY processing_feedback.reason_code, processing_feedback.pipeline_stage,
              processing_feedback.prompt_code, processing_feedback.prompt_version,
              processing_feedback.model, processing_feedback.doc_type_code
     ORDER BY defects DESC
     LIMIT 500
  `);

  return rows.rows.map((row) => {
    const defects = Number(row.defects);
    const calls = row.calls === null ? null : Number(row.calls);
    return {
      reasonCode: row.reason_code,
      pipelineStage: row.pipeline_stage,
      promptCode: row.prompt_code,
      promptVersion: row.prompt_version,
      model: row.model,
      docTypeCode: row.doc_type_code,
      defects,
      calls,
      // Ноль вызовов — это «знаменатель неизвестен», а не «доля бесконечна»:
      // дефект без вызова модели бывает у детекции и у ручных правок.
      rate: calls === null || calls === 0 ? null : defects / calls,
      medianScore: row.median_score === null ? null : Number(row.median_score),
    };
  });
}

/**
 * Выгрузка выборки.
 *
 * Отдаётся генератором, а не массивом: файл уходит в работу над промтом
 * целиком, и собирать пятьдесят тысяч строк в память ради потока, который их
 * тут же сериализует, незачем.
 */
export async function* exportFeedback(
  db: Database,
  scope: AuthScope,
  params: FeedbackFilters & { readonly limit: number },
): AsyncGenerator<FeedbackEventView> {
  if (!visible(scope)) return;

  const rows = await db
    .select(selection)
    .from(processingFeedback)
    .where(and(...conditions(params)))
    .orderBy(desc(processingFeedback.at), desc(processingFeedback.id))
    .limit(params.limit);

  for (const row of rows) yield toView(row);
}

function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): z.infer<typeof cursorSchema> | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return cursorSchema.parse(parsed);
  } catch {
    throw badRequest('Курсор страницы недействителен.');
  }
}
