/**
 * Навигация «тома → поставки → ревизия» (§3, §14).
 *
 * ## Почему это отдельный репозиторий, а не часть `catalog.ts`
 *
 * Том выглядит справочником, но им не является: `volumes` живёт в миграции
 * 0003 рядом с поставками, а не в 0002 рядом с объектами и контрагентами, и
 * это не случайность расположения. Справочник в портале читается ПОЛНОСТЬЮ
 * теми, кто настраивает систему, и сужается областью только там, где содержит
 * коммерческие сведения. Том же — узел дерева работ: он существует ради
 * поставок, и вопрос «какие тома я вижу» не имеет ответа отдельно от вопроса
 * «какие поставки я вижу». Поэтому он здесь.
 *
 * ## Видимость тома
 *
 * У `volumes` нет колонки `contractor_id`, и придумать её нельзя: том не
 * принадлежит подрядчику, в одном томе работают несколько. Значит область
 * видимости тома — это область видимости его ОБЪЕКТА, и она уже выражена
 * `objectVisibility()` из `catalog.ts`:
 *
 * - подрядчик видит объект, если у него есть поставка на этом объекте;
 * - инженер — назначенные объекты (пустой список назначений = ничего);
 * - руководитель и администратор — все.
 *
 * Второй экземпляр этого правила здесь был бы вторым источником правды для
 * решения о доступе, и разойтись они могли бы молча.
 *
 * **Следствие, которое надо назвать вслух.** Подрядчик, у которого на объекте
 * ещё нет ни одной поставки, не видит ни объекта, ни его томов — и потому не
 * может создать первую поставку через портал. Это свойство модели данных, а не
 * этого модуля: связи «подрядчик закреплён за томом» в схеме не существует
 * вовсе, единственный признак закрепления — уже существующая поставка. Ослабить
 * правило здесь значило бы отдать подрядчику перечень чужих площадок и разделов
 * работ, что прямо запрещено §16. Разрыв вынесен в доклад этапа.
 *
 * ## Создание поставки создаёт и первую ревизию
 *
 * Одной транзакцией. Поставка без единой ревизии — это карточка, в которую
 * некуда загружать файлы: весь конвейер (`/revisions/{id}/files`, разметка,
 * распознавание, проверки) адресуется ревизией. А завести её вторым действием
 * мешает `submission_revisions_parent_chk`: ревизия старше первой обязана иметь
 * родителя, и «первую забыли» уже не отличить от «первую удалили».
 *
 * ## Ручное создание ревизии не спорит с возвратом (§3, S10)
 *
 * Возврат (`returnRevision`) закрывает ревизию и ТОЙ ЖЕ транзакцией открывает
 * следующую с `parent_revision_id`. Второго пути с другой семантикой здесь нет:
 * ручное создание разрешено ровно в тех состояниях, в которых возврат уже
 * отработал или не мог отработать вовсе, — когда у поставки нет незакрытой
 * ревизии. Пересечение с workflow невозможно по построению:
 *
 * | Состояние последней ревизии | Что делает этот метод |
 * |---|---|
 * | `draft` | 409: черновик уже открыт, файлы кладутся в него |
 * | `submitted`, `in_review` | 409: решение ещё не принято, состав заперт |
 * | `returned` | 409: следующую ревизию уже создал возврат |
 * | `approved`, `superseded` | создаёт следующую draft с родителем |
 * | ревизий нет вовсе | создаёт первую (`revision_no = 1`) |
 *
 * Форма создаваемой строки совпадает с формой из `returnRevision` до колонки:
 * `revision_no + 1`, `parent_revision_id` на предшественника, `status='draft'`,
 * указатель `submissions.current_revision_id` переведён. Иначе «ревизия,
 * созданная возвратом» и «ревизия, созданная руками» вели бы себя по-разному в
 * переиспользовании результатов (`findReusableBundle` ходит по цепочке
 * родителей) — то есть разошлись бы там, где расхождение незаметно.
 *
 * Строку с `draft` защищает ещё и `ux_submission_revisions_single_draft`:
 * проверка состояния здесь нужна ради внятного отказа, а инвариант держит БД.
 */
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { submissionRevisions, submissions, volumes } from '@id/db';
import type { Submission, SubmissionRevision, Volume, WorkflowStatus } from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import { badRequest, conflict, forbidden, isHttpProblem, notFound } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendAudit, type AuditActor } from './audit.js';
import { objectVisibility } from './catalog.js';
import { appendRevisionEvent } from './jobs.js';
import type { Database } from './users.js';

const SUBMISSION_SCOPE: ScopeTarget = {
  objectId: submissions.objectId,
  contractorId: submissions.contractorId,
};

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

/** Статусы, при которых поставка ждёт решения проверяющего. */
const PENDING: readonly WorkflowStatus[] = ['submitted', 'in_review'];

const iso = (column: unknown, alias: string) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(alias);

const isoNullable = (column: unknown, alias: string) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    alias,
  );

export interface Page<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
}

// =====================================================================
// Курсоры
// =====================================================================

const textCursorSchema = z.object({ k: z.string(), id: z.uuid() });
const timeCursorSchema = z.object({ at: z.string().min(1), id: z.uuid() });
const numberCursorSchema = z.object({ n: z.int() });

type AnyCursor =
  | z.infer<typeof textCursorSchema>
  | z.infer<typeof timeCursorSchema>
  | z.infer<typeof numberCursorSchema>;

function encodeCursor(cursor: AnyCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Повреждённый курсор — ошибка запроса, а не «начнём заново».
 *
 * То же решение, что в `catalog.ts` и `admin.ts`: молчаливый откат к первой
 * странице выглядит для клиента бесконечным списком.
 */
function decodeCursor<TCursor>(
  raw: string | null | undefined,
  schema: z.ZodType<TCursor>,
): TCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Ниже общий отказ: разница между «не base64» и «не та форма» клиенту
    // ничего не даёт.
  }
  throw badRequest('Курсор страницы недействителен.');
}

function paginate<TItem>(
  rows: readonly TItem[],
  limit: number,
  cursorOf: (row: TItem) => AnyCursor,
): Page<TItem> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null;
  return { items, nextCursor };
}

/** Условия склеиваются здесь, чтобы `undefined` не приходилось фильтровать на месте. */
function allOf(...conditions: (SQL | undefined)[]): SQL {
  const present = conditions.filter((condition): condition is SQL => condition !== undefined);
  return and(...present) ?? sql`true`;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// =====================================================================
// Тома
// =====================================================================

const VOLUME_SELECTION = {
  id: volumes.id,
  objectId: volumes.objectId,
  sectionId: volumes.sectionId,
  code: volumes.code,
  name: volumes.name,
  isActive: volumes.isActive,
  autoRunEnabled: volumes.autoRunEnabled,
  createdAt: iso(volumes.createdAt, 'created_at_iso'),
};

export interface VolumeListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly objectId?: string | undefined;
  readonly sectionId?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly search?: string | undefined;
}

/**
 * Тома в области видимости, по коду.
 *
 * Фильтр по объекту — параметр, а не отдельный маршрут: «тома объекта» и «все
 * мои тома» отличаются одним условием, и второй запрос с собственной областью
 * означал бы второе место, где можно забыть `objectVisibility()`.
 */
export async function listVolumes(
  db: Database,
  scope: AuthScope,
  params: VolumeListParams,
): Promise<Page<Volume>> {
  const after = decodeCursor(params.cursor, textCursorSchema);

  const rows = await db
    .select(VOLUME_SELECTION)
    .from(volumes)
    .where(
      allOf(
        objectVisibility(scope, volumes.objectId),
        after === null
          ? undefined
          : sql`(${volumes.code}::text, ${volumes.id}) > (${after.k}::text, ${after.id}::uuid)`,
        params.objectId === undefined ? undefined : eq(volumes.objectId, params.objectId),
        params.sectionId === undefined ? undefined : eq(volumes.sectionId, params.sectionId),
        params.isActive === undefined ? undefined : eq(volumes.isActive, params.isActive),
        params.search === undefined
          ? undefined
          : or(
              ilike(volumes.name, `%${escapeLike(params.search)}%`),
              ilike(volumes.code, `${escapeLike(params.search)}%`),
            ),
      ),
    )
    .orderBy(asc(volumes.code), asc(volumes.id))
    // На одну больше запрошенного: наличие следующей страницы известно без
    // отдельного COUNT по тому же условию.
    .limit(params.limit + 1);

  return paginate(rows, params.limit, (row) => ({ k: row.code, id: row.id }));
}

/**
 * Том по идентификатору.
 *
 * `null` и на «нет такого», и на «чужой»: различать их наружу значило бы
 * подтверждать существование чужой площадки перебором идентификаторов (§1.6).
 */
export async function findVolume(
  db: Database,
  scope: AuthScope,
  volumeId: string,
): Promise<Volume | null> {
  const rows = await db
    .select(VOLUME_SELECTION)
    .from(volumes)
    .where(allOf(objectVisibility(scope, volumes.objectId), eq(volumes.id, volumeId)))
    .limit(1);
  return rows[0] ?? null;
}

// =====================================================================
// Поставки
// =====================================================================

const SUBMISSION_SELECTION = {
  id: submissions.id,
  volumeId: submissions.volumeId,
  objectId: submissions.objectId,
  contractorId: submissions.contractorId,
  number: submissions.number,
  title: submissions.title,
  currentRevisionId: submissions.currentRevisionId,
  createdBy: submissions.createdBy,
  createdAt: iso(submissions.createdAt, 'created_at_iso'),
};

export interface SubmissionListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly volumeId?: string | undefined;
  readonly objectId?: string | undefined;
  readonly search?: string | undefined;
}

/**
 * Поставки в области видимости, новые первыми.
 *
 * Область берётся по колонкам самой `submissions`, а не через том: денормализация
 * `object_id`/`contractor_id` существует ровно затем, чтобы фильтр доступа не
 * зависел от join'а, который легко забыть (§4.1, третий уровень). Целостность
 * денормализации держит составной FK `submissions_volume_fk`.
 */
export async function listSubmissions(
  db: Database,
  scope: AuthScope,
  params: SubmissionListParams,
): Promise<Page<Submission>> {
  const after = decodeCursor(params.cursor, timeCursorSchema);

  const rows = await db
    .select({
      ...SUBMISSION_SELECTION,
      cursorAt: sql<string>`${submissions.createdAt}::text`.as('cursor_at'),
    })
    .from(submissions)
    .where(
      withScope(
        scope,
        SUBMISSION_SCOPE,
        ...[
          after === null
            ? undefined
            : sql`(${submissions.createdAt}, ${submissions.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
          params.volumeId === undefined ? undefined : eq(submissions.volumeId, params.volumeId),
          params.objectId === undefined ? undefined : eq(submissions.objectId, params.objectId),
          params.search === undefined
            ? undefined
            : or(
                ilike(submissions.title, `%${escapeLike(params.search)}%`),
                ilike(submissions.number, `%${escapeLike(params.search)}%`),
              ),
        ].filter((condition): condition is SQL => condition !== undefined),
      ),
    )
    .orderBy(desc(submissions.createdAt), desc(submissions.id))
    .limit(params.limit + 1);

  const page = paginate(rows, params.limit, (row) => ({ at: row.cursorAt, id: row.id }));
  return {
    items: page.items.map(({ cursorAt: _cursorAt, ...item }) => item),
    nextCursor: page.nextCursor,
  };
}

/** Поставка по идентификатору; `null` и на «нет такой», и на «чужая». */
export async function findSubmission(
  db: Database,
  scope: AuthScope,
  submissionId: string,
): Promise<Submission | null> {
  const rows = await db
    .select(SUBMISSION_SELECTION)
    .from(submissions)
    .where(withScope(scope, SUBMISSION_SCOPE, eq(submissions.id, submissionId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateSubmissionInput {
  readonly volumeId: string;
  readonly title: string;
  readonly number?: string | null | undefined;
}

export interface CreatedSubmission {
  readonly submission: Submission;
  readonly revision: SubmissionRevision;
}

/**
 * Организация, от имени которой создаётся поставка.
 *
 * Берётся ТОЛЬКО из области видимости и никогда из тела запроса: подрядчик,
 * подставивший чужой `contractorId`, завёл бы поставку от чужого имени, а
 * составной FK этого не заметил бы — значение согласовано само с собой.
 *
 * Область, отличная от подрядческой, — отказ с названной причиной, а не
 * догадка. Право `submission.upload` выдано только роли `contractor`, но набор
 * ролей и область — разные вещи: у пользователя с ролями `contractor` и
 * `engineer` право есть, а область строится по старшей роли и организации не
 * содержит. Придумать её здесь нельзя.
 */
function actingContractorId(scope: AuthScope): string {
  if (scope.kind !== 'contractor') {
    throw forbidden(
      'Поставка создаётся от имени организации-подрядчика. У текущей области ' +
        'видимости организации нет.',
      { logDetail: `создание поставки при области ${scope.kind}` },
    );
  }
  return scope.contractorId;
}

/**
 * Создание поставки вместе с её первой ревизией.
 *
 * Том проверяется отдельным чтением ТОЙ ЖЕ областью: иначе поставка в невидимом
 * томе упёрлась бы во внешний ключ и дала 500 вместо внятного «том не найден», а
 * различить «тома нет» и «том не ваш» снаружи всё равно нельзя (§1.6).
 */
export async function createSubmission(
  db: Database,
  scope: AuthScope,
  input: CreateSubmissionInput,
  actor: AuditActor,
): Promise<CreatedSubmission> {
  const contractorId = actingContractorId(scope);

  const volume = await findVolume(db, scope, input.volumeId);
  if (volume === null) throw notFound('Том не найден.');
  if (!volume.isActive) {
    throw conflict('Том закрыт: подать в него новую поставку нельзя.');
  }

  return guardNavigation(() =>
    db.transaction(async (tx) => {
      const insertedSubmission = await tx
        .insert(submissions)
        .values({
          volumeId: volume.id,
          objectId: volume.objectId,
          contractorId,
          title: input.title,
          number: input.number ?? null,
          createdBy: scope.userId,
        })
        .returning(SUBMISSION_SELECTION);

      const submission = insertedSubmission[0];
      if (submission === undefined) {
        throw conflict('Поставка не создана: повторите действие.');
      }

      const revision = await insertDraftRevision(tx, {
        submissionId: submission.id,
        objectId: submission.objectId,
        contractorId: submission.contractorId,
        revisionNo: 1,
        parentRevisionId: null,
      });

      await tx
        .update(submissions)
        .set({ currentRevisionId: revision.id })
        .where(eq(submissions.id, submission.id));

      await appendRevisionEvent(tx, {
        revisionId: revision.id,
        eventType: 'submission.created',
        payload: { submissionId: submission.id, revisionNo: revision.revisionNo },
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'submission.create',
        entityType: 'submission',
        entityId: submission.id,
        objectId: submission.objectId,
        payload: {
          volumeId: submission.volumeId,
          title: submission.title,
          revisionId: revision.id,
        },
      });

      return { submission: { ...submission, currentRevisionId: revision.id }, revision };
    }),
  );
}

// =====================================================================
// Ревизии поставки
// =====================================================================

const REVISION_SELECTION = {
  id: submissionRevisions.id,
  submissionId: submissionRevisions.submissionId,
  revisionNo: submissionRevisions.revisionNo,
  parentRevisionId: submissionRevisions.parentRevisionId,
  status: submissionRevisions.status,
  aggregateManifestHash: submissionRevisions.aggregateManifestHash,
  version: submissionRevisions.version,
  createdAt: iso(submissionRevisions.createdAt, 'created_at_iso'),
  submittedAt: isoNullable(submissionRevisions.submittedAt, 'submitted_at_iso'),
  submittedBy: submissionRevisions.submittedBy,
  decidedAt: isoNullable(submissionRevisions.decidedAt, 'decided_at_iso'),
  decidedBy: submissionRevisions.decidedBy,
  returnReason: submissionRevisions.returnReason,
};

type RevisionRow = {
  readonly status: string;
} & Omit<SubmissionRevision, 'status'>;

/**
 * Статус приводится, а не разбирается схемой.
 *
 * Его множество держит `submission_revisions_status_chk` (0003), а форму ответа
 * дополнительно проверяет схема сериализации маршрута. Третья проверка того же
 * инварианта дала бы 500 на строке, которую БД считает корректной.
 */
function toRevision(row: RevisionRow): SubmissionRevision {
  return { ...row, status: row.status as WorkflowStatus };
}

export interface RevisionListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
}

/**
 * Ревизии поставки, последняя первой.
 *
 * Курсор — один `revision_no`: он уникален внутри поставки
 * (`submission_revisions_no_uq`), а список всегда ограничен одной поставкой.
 * Пары с идентификатором тут не нужно, и лишний компонент лишь создал бы
 * впечатление, что порядок неоднозначен.
 */
export async function listSubmissionRevisions(
  db: Database,
  scope: AuthScope,
  submissionId: string,
  params: RevisionListParams,
): Promise<Page<SubmissionRevision>> {
  // Сначала сама поставка: невидимая обязана отвечать 404, а не пустым списком.
  // Пустой список означал бы «поставка есть, ревизий нет» — это уже сведение о
  // чужой работе.
  if ((await findSubmission(db, scope, submissionId)) === null) {
    throw notFound('Поставка не найдена.');
  }

  const after = decodeCursor(params.cursor, numberCursorSchema);

  const rows = await db
    .select(REVISION_SELECTION)
    .from(submissionRevisions)
    .where(
      withScope(
        scope,
        REVISION_SCOPE,
        ...[
          eq(submissionRevisions.submissionId, submissionId),
          after === null ? undefined : sql`${submissionRevisions.revisionNo} < ${after.n}::integer`,
        ].filter((condition): condition is SQL => condition !== undefined),
      ),
    )
    .orderBy(desc(submissionRevisions.revisionNo))
    .limit(params.limit + 1);

  const page = paginate(rows, params.limit, (row) => ({ n: row.revisionNo }));
  return { items: page.items.map(toRevision), nextCursor: page.nextCursor };
}

interface InsertRevisionInput {
  readonly submissionId: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
}

/** Одна форма строки для обоих путей создания: первая ревизия и следующая. */
async function insertDraftRevision(
  tx: Pick<Database, 'insert'>,
  input: InsertRevisionInput,
): Promise<SubmissionRevision> {
  const inserted = await tx
    .insert(submissionRevisions)
    .values({
      submissionId: input.submissionId,
      objectId: input.objectId,
      contractorId: input.contractorId,
      revisionNo: input.revisionNo,
      parentRevisionId: input.parentRevisionId,
      status: 'draft',
    })
    .returning(REVISION_SELECTION);

  const row = inserted[0];
  if (row === undefined) throw conflict('Ревизия поставки не создана: повторите действие.');
  return toRevision(row);
}

/**
 * Черновая ревизия поставки вручную.
 *
 * Разрешена только там, где не спорит с возвратом: у поставки нет незакрытой
 * ревизии. Таблица состояний — в заголовке файла; отказ называет статус, потому
 * что подрядчику нужно понять, ждать ли решения или продолжать в открытом
 * черновике.
 */
export async function createDraftRevision(
  db: Database,
  scope: AuthScope,
  submissionId: string,
  actor: AuditActor,
): Promise<SubmissionRevision> {
  const submission = await findSubmission(db, scope, submissionId);
  if (submission === null) throw notFound('Поставка не найдена.');
  // Право `submission.upload` выдано подрядчику, но принадлежность поставки его
  // организации проверяет область: `withScope()` выше уже отсёк чужие строки.
  actingContractorId(scope);

  const latest = await db
    .select({
      id: submissionRevisions.id,
      revisionNo: submissionRevisions.revisionNo,
      status: submissionRevisions.status,
    })
    .from(submissionRevisions)
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.submissionId, submissionId)))
    .orderBy(desc(submissionRevisions.revisionNo))
    .limit(1);

  const previous = latest[0] ?? null;

  if (previous !== null) {
    if (previous.status === 'draft') {
      throw conflict(
        'У поставки уже открыта черновая ревизия: файлы добавляются в неё, ' + 'а не в новую.',
      );
    }
    if (PENDING.includes(previous.status as WorkflowStatus)) {
      throw conflict(
        `Ревизия №${previous.revisionNo} ждёт решения проверяющего (статус «${previous.status}»). ` +
          'Новая ревизия появится сама, если поставку вернут.',
      );
    }
    if (previous.status === 'returned') {
      throw conflict(
        `Ревизия №${previous.revisionNo} возвращена, и следующая уже создана возвратом.`,
      );
    }
  }

  return guardNavigation(() =>
    db.transaction(async (tx) => {
      const revision = await insertDraftRevision(tx, {
        submissionId: submission.id,
        objectId: submission.objectId,
        contractorId: submission.contractorId,
        revisionNo: previous === null ? 1 : previous.revisionNo + 1,
        parentRevisionId: previous === null ? null : previous.id,
      });

      await tx
        .update(submissions)
        .set({ currentRevisionId: revision.id })
        .where(eq(submissions.id, submission.id));

      await appendRevisionEvent(tx, {
        revisionId: revision.id,
        eventType: 'revision.opened',
        payload: {
          submissionId: submission.id,
          revisionNo: revision.revisionNo,
          parentRevisionId: revision.parentRevisionId,
        },
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'revision.create',
        entityType: 'submission_revision',
        entityId: revision.id,
        objectId: submission.objectId,
        payload: {
          submissionId: submission.id,
          revisionNo: revision.revisionNo,
          parentRevisionId: revision.parentRevisionId,
        },
      });

      return revision;
    }),
  );
}

/**
 * Отказ ограничения БД → внятный ответ вместо 500.
 *
 * Тот же приём, что у `guardWorkflow()` в `workflow.ts`: список инвариантов, за
 * которые отвечает БД, короток и назван поимённо, всё остальное поднимается как
 * есть — молчаливое проглатывание неизвестного кода скрыло бы настоящий дефект.
 */
async function guardNavigation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    if (isHttpProblem(error)) throw error;
    const driver = error as { code?: unknown; cause?: { code?: unknown } };
    const sqlState =
      typeof driver.code === 'string'
        ? driver.code
        : typeof driver.cause?.code === 'string'
          ? driver.cause.code
          : undefined;

    if (sqlState === '23505') {
      throw conflict('У поставки уже есть незакрытая черновая ревизия.', {
        logDetail: 'нарушен ux_submission_revisions_single_draft',
      });
    }
    if (sqlState === '23503' || sqlState === '23514') {
      throw conflict(
        'База отвергла запись: ссылка на несуществующую строку либо нарушенное ограничение.',
        { logDetail: `sqlstate ${sqlState}` },
      );
    }
    throw error;
  }
}
