/**
 * Навигация «объект → комплект → ревизия» и реестры передачи (§3, §14).
 *
 * ## Почему это отдельный репозиторий, а не часть `catalog.ts`
 *
 * Комплект и реестр выглядят справочными сущностями, но ими не являются:
 * справочник читается ПОЛНОСТЬЮ теми, кто настраивает систему, и сужается
 * областью только там, где содержит коммерческие сведения. Комплект — это
 * работа с исполнителем и её ревизии, то есть данные ИД: вопрос «какие
 * комплекты я вижу» не имеет ответа отдельно от вопроса «чьи ревизии я вижу».
 *
 * ## Комплект существует до реестра, а не внутри него
 *
 * Подрядчик заводит комплект, зная объект, раздел и месяц, но не зная, в какую
 * папку он войдёт: папку собирает ПТО генподрядчика позже, из готовых
 * комплектов. Поэтому `registry_id` у комплекта необязателен, и пустой он —
 * нормальное состояние, а не незавершённость. Обратный порядок («сначала
 * заведи реестр») заставил бы подрядчика ждать генподрядчика, чтобы начать
 * работу, которую тот ещё не планировал.
 *
 * ## Две организации у одного комплекта — и это не дублирование
 *
 * `contractorId` — кто ВЫПОЛНИЛ работу, он печатается в реестре исполнителем.
 * `managedByContractorId` — кто ВЕДЁТ комплект в портале. Они расходятся, когда
 * инженер ПТО заводит комплект за субподрядчика, у которого нет учётной записи.
 *
 * Из различия следует граница правки, и она та же, что держат триггеры 0008:
 *
 * * СОСТАВ (файлы, их порядок, подача, следующая ревизия) правит только ведущая
 *   организация — `requireManagedByActor`;
 * * ПРОИЗВОДНОЕ (разметка, распознавание, документы, реквизиты) правит любой,
 *   у кого есть право и область.
 *
 * Без этого различия генподрядчик, видящий все комплекты объекта, мог бы
 * дозагрузить файл в чужой черновик — то есть подать от чужого имени.
 *
 * ## Видимость реестра шире видимости его состава
 *
 * Реестр виден всем, кому виден его объект: номер, месяц и раздел — не
 * коммерческие сведения. А вот его СОСТАВ подрядчику сужается до собственных
 * комплектов, и счётчики с блокерами ему не отдаются вовсе (см. модуль
 * маршрутов): «в папке 7 комплектов, из них ваш один» — это сведение о работе
 * конкурентов, полученное арифметикой.
 *
 * ## Передача замораживает состав
 *
 * `issueRegistry` одной транзакцией проверяет предусловия, пишет снимок
 * `registry_items` и переводит статус. Снимок — не удобство: без него ответ на
 * вопрос «что подписано реестром №8» пересчитывался бы по ссылкам и менялся при
 * каждой новой ревизии комплекта, то есть через месяц бумага и портал
 * рассказывали бы разное. Неизменяемость снимка держит триггер 0028, а не код.
 *
 * ## Ручное создание ревизии не спорит с возвратом (§3, S10)
 *
 * Возврат (`returnRevision`) закрывает ревизию и ТОЙ ЖЕ транзакцией открывает
 * следующую с `parent_revision_id`. Второго пути с другой семантикой здесь нет:
 * ручное создание разрешено ровно в тех состояниях, в которых возврат уже
 * отработал или не мог отработать вовсе, — когда у комплекта нет незакрытой
 * ревизии.
 *
 * | Состояние последней ревизии | Что делает этот метод |
 * |---|---|
 * | `draft` | 409: черновик уже открыт, файлы кладутся в него |
 * | `submitted`, `in_review` | 409: решение ещё не принято, состав заперт |
 * | `returned` | 409: следующую ревизию уже создал возврат |
 * | `approved`, `superseded` | создаёт следующую draft с родителем |
 * | ревизий нет вовсе | создаёт первую (`revision_no = 1`) |
 *
 * Строку с `draft` защищает ещё и `ux_submission_revisions_single_draft`:
 * проверка состояния здесь нужна ради внятного отказа, а инвариант держит БД.
 */
import { and, asc, desc, eq, ilike, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { registries, registryItems, submissionRevisions, works } from '@id/db';
import type {
  Registry,
  RegistryItem,
  RegistryStatus,
  SubmissionRevision,
  Work,
  WorkKind,
  WorkflowStatus,
} from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import {
  badRequest,
  conflict,
  forbidden,
  isHttpProblem,
  notFound,
  preconditionFailed,
  unprocessable,
} from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendAudit, type AuditActor } from './audit.js';
import { findConstructionObject, objectVisibility, visibleWhere } from './catalog.js';
import { appendRevisionEvent } from './jobs.js';
import type { Database } from './users.js';

const WORK_SCOPE: ScopeTarget = {
  objectId: works.objectId,
  contractorId: works.contractorId,
};

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

/** Статусы, при которых ревизия ждёт решения проверяющего. */
const PENDING: readonly WorkflowStatus[] = ['submitted', 'in_review'];

/** Статусы, при которых комплект считается поданным в составе реестра. */
const SUBMITTED_OR_LATER: readonly WorkflowStatus[] = [
  'submitted',
  'in_review',
  'returned',
  'approved',
  'superseded',
];

const iso = (column: unknown, alias: string) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(alias);

const isoNullable = (column: unknown, alias: string) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    alias,
  );

/** Дата без времени: месяц передаётся строкой `ГГГГ-ММ-01`, а не меткой времени. */
const date = (column: unknown, alias: string) =>
  sql<string>`to_char(${column}, 'YYYY-MM-DD')`.as(alias);

export interface Page<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
}

// =====================================================================
// Курсоры
// =====================================================================

/**
 * Курсоров два, и оба соответствуют реальному порядку выдачи.
 *
 * Текстового курсора здесь больше нет: он существовал ради тома, который
 * сортировался по коду. Комплекты и реестры отдаются по времени заведения, а
 * ревизии — по номеру.
 */
const timeCursorSchema = z.object({ at: z.string().min(1), id: z.uuid() });
const numberCursorSchema = z.object({ n: z.int() });

type AnyCursor = z.infer<typeof timeCursorSchema> | z.infer<typeof numberCursorSchema>;

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
// Организация, от имени которой действует актор
// =====================================================================

/**
 * Кто выполнил работу и кто ведёт комплект.
 *
 * Подрядчик может завести комплект только за себя, и поле в теле запроса для
 * него — отказ, а не пожелание: подставленный чужой `contractorId` завёл бы
 * работу от чужого имени, а составной внешний ключ этого не заметил бы —
 * значение согласовано само с собой.
 *
 * Генподрядчик, наоборот, обязан уметь назвать исполнителя: субподрядчики
 * учётных записей в портале, как правило, не имеют, и ПТО собирает их комплекты
 * само. Ведущей организацией при этом остаётся генподрядчик — иначе он не смог
 * бы дозагрузить в собственный комплект второй файл.
 *
 * Право `submission.upload` выдано обеим ролям, но НАБОР РОЛЕЙ и ОБЛАСТЬ — разные
 * вещи: у пользователя с ролями `contractor` и `engineer` право есть, а область
 * строится по старшей роли и организации не содержит. Придумать её здесь нельзя.
 */
export interface ActingContractor {
  /** Исполнитель работы: он печатается в реестре. */
  readonly contractorId: string;
  /** Организация, ведущая комплект в портале. */
  readonly managedByContractorId: string;
  /** Заведено ли от чужого имени — попадает в аудит. */
  readonly onBehalfOf: boolean;
}

export function resolveActingContractor(
  scope: AuthScope,
  requested: string | null | undefined,
): ActingContractor {
  if (scope.kind === 'contractor') {
    if (requested !== undefined && requested !== null && requested !== scope.contractorId) {
      throw badRequest(
        'Исполнитель комплекта берётся из вашей организации и в запросе не задаётся.',
        { logDetail: 'подрядчик указал чужой contractorId' },
      );
    }
    return {
      contractorId: scope.contractorId,
      managedByContractorId: scope.contractorId,
      onBehalfOf: false,
    };
  }

  if (scope.kind === 'general_contractor') {
    const contractorId = requested ?? scope.contractorId;
    return {
      contractorId,
      managedByContractorId: scope.contractorId,
      onBehalfOf: contractorId !== scope.contractorId,
    };
  }

  throw forbidden(
    'Комплект заводится от имени организации-подрядчика. У текущей области видимости ' +
      'организации нет.',
    { logDetail: `создание комплекта при области ${scope.kind}` },
  );
}

/**
 * Объект, на котором актор вправе что-либо заводить.
 *
 * Составные внешние ключи `works_section_fk` и `works_contractor_fk` держат
 * ЦЕЛОСТНОСТЬ (раздел включён, подрядчик закреплён), но не область видимости:
 * генподрядчик мог назвать чужой объект, где нужный субподрядчик закреплён, и
 * запись прошла бы. 404, а не 403 — «нет такого» и «не ваше» здесь неразличимы
 * по §1.6.
 */
async function requireVisibleObject(
  db: Database,
  scope: AuthScope,
  objectId: string,
): Promise<void> {
  if ((await findConstructionObject(db, scope, objectId)) === null) {
    throw notFound('Объект строительства не найден.');
  }
}

/**
 * Правка СОСТАВА комплекта разрешена только ведущей организации.
 *
 * Отделено от области видимости намеренно: генподрядчик видит все комплекты
 * своих объектов и обязан их видеть — иначе собрать реестр не из чего. Но
 * видеть и дозагружать файл в чужой черновик — разные права. Проверяющие
 * (инженер, руководитель, администратор) состав не правят вовсе, у них своё
 * право на производное.
 */
export function requireManagedByActor(
  scope: AuthScope,
  work: { readonly managedByContractorId: string; readonly contractorId: string },
): void {
  if (scope.kind === 'contractor' || scope.kind === 'general_contractor') {
    if (work.managedByContractorId !== scope.contractorId) {
      throw forbidden(
        'Состав этого комплекта ведёт другая организация. Разметка и документы вам ' +
          'доступны, файлы и подача — нет.',
        { logDetail: 'правка состава комплекта чужой организацией' },
      );
    }
    return;
  }
  throw forbidden('Состав комплекта правит организация, которая его ведёт.', {
    logDetail: `правка состава при области ${scope.kind}`,
  });
}

// =====================================================================
// Комплекты работ
// =====================================================================

const WORK_SELECTION = {
  id: works.id,
  objectId: works.objectId,
  sectionCode: works.sectionCode,
  period: date(works.period, 'period_date'),
  contractorId: works.contractorId,
  managedByContractorId: works.managedByContractorId,
  kind: works.kind,
  title: works.title,
  registryId: works.registryId,
  ordinal: works.ordinal,
  autoRunEnabled: works.autoRunEnabled,
  currentRevisionId: works.currentRevisionId,
  createdBy: works.createdBy,
  createdAt: iso(works.createdAt, 'created_at_iso'),
};

type WorkRow = { readonly kind: string } & Omit<Work, 'kind'>;

/**
 * Вид комплекта приводится, а не разбирается схемой.
 *
 * Его множество держит `works_kind_chk` (0028), а форму ответа дополнительно
 * проверяет схема сериализации маршрута. Третья проверка того же инварианта
 * дала бы 500 на строке, которую БД считает корректной.
 */
function toWork(row: WorkRow): Work {
  return { ...row, kind: row.kind as WorkKind };
}

export interface WorkListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly objectId?: string | undefined;
  readonly sectionCode?: string | undefined;
  readonly period?: string | undefined;
  readonly registryId?: string | undefined;
  /** Только комплекты, не включённые ни в один реестр. */
  readonly unassigned?: boolean | undefined;
  readonly search?: string | undefined;
}

/**
 * Комплекты, новые первыми.
 *
 * Файлы реестров (`kind='registry'`) в общий список НЕ попадают: это служебная
 * единица, у которой нет исполнителя работ, и в перечне работ она выглядела бы
 * работой. Читается она отдельно — вместе с реестром, которому принадлежит.
 */
export async function listWorks(
  db: Database,
  scope: AuthScope,
  params: WorkListParams,
): Promise<Page<Work>> {
  const after = decodeCursor(params.cursor, timeCursorSchema);
  const term = params.search === undefined ? null : `%${escapeLike(params.search)}%`;

  const rows = await db
    .select(WORK_SELECTION)
    .from(works)
    .where(
      withScope(
        scope,
        WORK_SCOPE,
        allOf(
          eq(works.kind, 'complect'),
          params.objectId === undefined ? undefined : eq(works.objectId, params.objectId),
          params.sectionCode === undefined ? undefined : eq(works.sectionCode, params.sectionCode),
          params.period === undefined ? undefined : eq(works.period, params.period),
          params.registryId === undefined ? undefined : eq(works.registryId, params.registryId),
          // Признак трёхзначен: не задан — «любые», `true` — свободные,
          // `false` — уже включённые. Молчаливо приравнивать `false` к «любые»
          // значило бы отвечать на другой вопрос.
          params.unassigned === undefined
            ? undefined
            : params.unassigned
              ? isNull(works.registryId)
              : isNotNull(works.registryId),
          term === null ? undefined : ilike(works.title, term),
          after === null
            ? undefined
            : sql`(${works.createdAt}, ${works.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        ),
      ),
    )
    .orderBy(desc(works.createdAt), desc(works.id))
    .limit(params.limit + 1);

  const page = paginate(rows, params.limit, (row) => ({ at: row.createdAt, id: row.id }));
  return { items: page.items.map(toWork), nextCursor: page.nextCursor };
}

export async function findWork(
  db: Database,
  scope: AuthScope,
  workId: string,
): Promise<Work | null> {
  const rows = await db
    .select(WORK_SELECTION)
    .from(works)
    .where(withScope(scope, WORK_SCOPE, eq(works.id, workId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toWork(row);
}

export interface CreateWorkInput {
  readonly objectId: string;
  readonly sectionCode: string;
  readonly period: string;
  readonly title: string;
  /** Исполнитель. Задаётся только генподрядчиком (см. `resolveActingContractor`). */
  readonly contractorId?: string | null | undefined;
}

export interface CreatedWork {
  readonly work: Work;
  readonly revision: SubmissionRevision;
}

/**
 * Заведение комплекта вместе с его первой ревизией.
 *
 * Одной транзакцией. Комплект без единой ревизии — это карточка, в которую
 * некуда загружать файлы: весь конвейер (`/revisions/{id}/files`, разметка,
 * распознавание, проверки) адресуется ревизией. А завести её вторым действием
 * мешает `submission_revisions_parent_chk`: ревизия старше первой обязана иметь
 * родителя, и «первую забыли» уже не отличить от «первую удалили».
 *
 * Ни включённость раздела, ни закрепление подрядчика здесь не проверяются
 * чтением: их держат составные внешние ключи `works_section_fk` и
 * `works_contractor_fk`, а `guardNavigation` переводит их отказ в 422 с
 * указателем на поле. Проверка чтением была бы второй копией правила и
 * разошлась бы с ключом при первой же гонке.
 */
export async function createWork(
  db: Database,
  scope: AuthScope,
  input: CreateWorkInput,
  actor: AuditActor,
): Promise<CreatedWork> {
  const acting = resolveActingContractor(scope, input.contractorId);
  await requireVisibleObject(db, scope, input.objectId);

  return guardNavigation(() =>
    db.transaction(async (tx) => {
      const insertedWork = await tx
        .insert(works)
        .values({
          objectId: input.objectId,
          sectionCode: input.sectionCode,
          period: input.period,
          contractorId: acting.contractorId,
          managedByContractorId: acting.managedByContractorId,
          kind: 'complect',
          title: input.title,
          createdBy: scope.userId,
        })
        .returning(WORK_SELECTION);

      const work = insertedWork[0];
      if (work === undefined) throw conflict('Комплект не создан: повторите действие.');

      const revision = await insertDraftRevision(tx, {
        workId: work.id,
        objectId: work.objectId,
        contractorId: work.contractorId,
        revisionNo: 1,
        parentRevisionId: null,
      });

      await tx.update(works).set({ currentRevisionId: revision.id }).where(eq(works.id, work.id));

      await appendRevisionEvent(tx, {
        revisionId: revision.id,
        eventType: 'work.created',
        payload: { workId: work.id, revisionNo: revision.revisionNo },
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'work.created',
        entityType: 'work',
        entityId: work.id,
        objectId: work.objectId,
        payload: {
          sectionCode: work.sectionCode,
          period: work.period,
          title: work.title,
          contractorId: work.contractorId,
          // Заведение за другую организацию обязано быть видно в журнале: это
          // единственный путь, которым в портале появляется работа, поданная не
          // тем, кто её выполнил.
          onBehalfOf: acting.onBehalfOf,
          revisionId: revision.id,
        },
      });

      return { work: toWork({ ...work, currentRevisionId: revision.id }), revision };
    }),
  );
}

export interface UpdateWorkPatch {
  readonly title?: string | undefined;
  readonly autoRunEnabled?: boolean | undefined;
}

/** Правка карточки комплекта. Состав, раздел и месяц здесь не меняются. */
export async function updateWork(
  db: Database,
  scope: AuthScope,
  workId: string,
  patch: UpdateWorkPatch,
  actor: AuditActor,
): Promise<Work | null> {
  const work = await findWork(db, scope, workId);
  if (work === null) return null;
  requireManagedByActor(scope, work);

  const fields = {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.autoRunEnabled === undefined ? {} : { autoRunEnabled: patch.autoRunEnabled }),
  };
  if (Object.keys(fields).length === 0) {
    throw badRequest('Запрос не содержит ни одного изменяемого поля.');
  }

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      await tx
        .update(works)
        .set({ ...fields, updatedAt: sql`now()` })
        .where(eq(works.id, workId));

      await appendAudit(tx, scope, {
        ...actor,
        action: 'work.updated',
        entityType: 'work',
        entityId: workId,
        objectId: work.objectId,
        payload: fields,
      });
    }),
  );

  return findWork(db, scope, workId);
}

// =====================================================================
// Ревизии комплекта
// =====================================================================

const REVISION_SELECTION = {
  id: submissionRevisions.id,
  workId: submissionRevisions.workId,
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
 * Ревизии комплекта, последняя первой.
 *
 * Курсор — один `revision_no`: он уникален внутри комплекта
 * (`submission_revisions_work_no_uq`), а список всегда ограничен одним
 * комплектом. Пары с идентификатором тут не нужно, и лишний компонент лишь
 * создал бы впечатление, что порядок неоднозначен.
 */
export async function listWorkRevisions(
  db: Database,
  scope: AuthScope,
  workId: string,
  params: RevisionListParams,
): Promise<Page<SubmissionRevision>> {
  // Сначала сам комплект: невидимый обязан отвечать 404, а не пустым списком.
  // Пустой список означал бы «комплект есть, ревизий нет» — это уже сведение о
  // чужой работе.
  if ((await findWork(db, scope, workId)) === null) {
    throw notFound('Комплект не найден.');
  }

  const after = decodeCursor(params.cursor, numberCursorSchema);

  const rows = await db
    .select(REVISION_SELECTION)
    .from(submissionRevisions)
    .where(
      withScope(
        scope,
        REVISION_SCOPE,
        allOf(
          eq(submissionRevisions.workId, workId),
          after === null ? undefined : sql`${submissionRevisions.revisionNo} < ${after.n}::integer`,
        ),
      ),
    )
    .orderBy(desc(submissionRevisions.revisionNo))
    .limit(params.limit + 1);

  const page = paginate(rows, params.limit, (row) => ({ n: row.revisionNo }));
  return { items: page.items.map(toRevision), nextCursor: page.nextCursor };
}

interface InsertRevisionInput {
  readonly workId: string;
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
      workId: input.workId,
      objectId: input.objectId,
      contractorId: input.contractorId,
      revisionNo: input.revisionNo,
      parentRevisionId: input.parentRevisionId,
      status: 'draft',
    })
    .returning(REVISION_SELECTION);

  const row = inserted[0];
  if (row === undefined) throw conflict('Ревизия комплекта не создана: повторите действие.');
  return toRevision(row);
}

/**
 * Черновая ревизия комплекта вручную.
 *
 * Разрешена только там, где не спорит с возвратом: у комплекта нет незакрытой
 * ревизии. Таблица состояний — в заголовке файла; отказ называет статус, потому
 * что подрядчику нужно понять, ждать ли решения или продолжать в открытом
 * черновике.
 */
export async function createDraftRevision(
  db: Database,
  scope: AuthScope,
  workId: string,
  actor: AuditActor,
): Promise<SubmissionRevision> {
  const work = await findWork(db, scope, workId);
  if (work === null) throw notFound('Комплект не найден.');
  requireManagedByActor(scope, work);

  const latest = await db
    .select({
      id: submissionRevisions.id,
      revisionNo: submissionRevisions.revisionNo,
      status: submissionRevisions.status,
    })
    .from(submissionRevisions)
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.workId, workId)))
    .orderBy(desc(submissionRevisions.revisionNo))
    .limit(1);

  const previous = latest[0] ?? null;

  if (previous !== null) {
    if (previous.status === 'draft') {
      throw conflict(
        'У комплекта уже открыта черновая ревизия: файлы добавляются в неё, а не в новую.',
      );
    }
    if (PENDING.includes(previous.status as WorkflowStatus)) {
      throw conflict(
        `Ревизия №${previous.revisionNo} ждёт решения проверяющего (статус «${previous.status}»). ` +
          'Новая ревизия появится сама, если комплект вернут.',
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
        workId: work.id,
        objectId: work.objectId,
        contractorId: work.contractorId,
        revisionNo: previous === null ? 1 : previous.revisionNo + 1,
        parentRevisionId: previous === null ? null : previous.id,
      });

      await tx.update(works).set({ currentRevisionId: revision.id }).where(eq(works.id, work.id));

      await appendRevisionEvent(tx, {
        revisionId: revision.id,
        eventType: 'revision.opened',
        payload: {
          workId: work.id,
          revisionNo: revision.revisionNo,
          parentRevisionId: revision.parentRevisionId,
        },
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'revision.create',
        entityType: 'submission_revision',
        entityId: revision.id,
        objectId: work.objectId,
        payload: {
          workId: work.id,
          revisionNo: revision.revisionNo,
          parentRevisionId: revision.parentRevisionId,
        },
      });

      return revision;
    }),
  );
}

// =====================================================================
// Реестры
// =====================================================================

const REGISTRY_SELECTION = {
  id: registries.id,
  objectId: registries.objectId,
  sectionCode: registries.sectionCode,
  period: date(registries.period, 'period_date'),
  number: registries.number,
  folderNo: registries.folderNo,
  building: registries.building,
  floor: registries.floor,
  structure: registries.structure,
  status: registries.status,
  version: registries.version,
  issuedBy: registries.issuedBy,
  issuedAt: isoNullable(registries.issuedAt, 'issued_at_iso'),
  issuedFileRevisionId: registries.issuedFileRevisionId,
  acceptedBy: registries.acceptedBy,
  acceptedAt: isoNullable(registries.acceptedAt, 'accepted_at_iso'),
  createdBy: registries.createdBy,
  createdAt: iso(registries.createdAt, 'created_at_iso'),
};

type RegistryRow = { readonly status: string } & Omit<Registry, 'status'>;

function toRegistry(row: RegistryRow): Registry {
  return { ...row, status: row.status as RegistryStatus };
}

/**
 * Видимость реестра — это видимость его ОБЪЕКТА.
 *
 * У `registries` нет колонки `contractor_id`, и придумать её нельзя: в одной
 * папке работы нескольких организаций. Поэтому область выражена
 * `objectVisibility()` из `catalog.ts` — тем же правилом, которым решается
 * видимость самого объекта. Второй экземпляр правила здесь был бы вторым
 * источником правды о доступе, и разойтись они могли бы молча.
 */
function registryVisibility(scope: AuthScope): SQL {
  return objectVisibility(scope, registries.objectId);
}

export interface RegistryListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly objectId?: string | undefined;
  readonly sectionCode?: string | undefined;
  readonly period?: string | undefined;
  readonly status?: RegistryStatus | undefined;
}

export async function listRegistries(
  db: Database,
  scope: AuthScope,
  params: RegistryListParams,
): Promise<Page<Registry>> {
  const after = decodeCursor(params.cursor, timeCursorSchema);

  const rows = await db
    .select(REGISTRY_SELECTION)
    .from(registries)
    .where(
      visibleWhere(
        registryVisibility(scope),
        allOf(
          params.objectId === undefined ? undefined : eq(registries.objectId, params.objectId),
          params.sectionCode === undefined
            ? undefined
            : eq(registries.sectionCode, params.sectionCode),
          params.period === undefined ? undefined : eq(registries.period, params.period),
          params.status === undefined ? undefined : eq(registries.status, params.status),
          after === null
            ? undefined
            : sql`(${registries.createdAt}, ${registries.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        ),
      ),
    )
    .orderBy(desc(registries.createdAt), desc(registries.id))
    .limit(params.limit + 1);

  const page = paginate(rows, params.limit, (row) => ({ at: row.createdAt, id: row.id }));
  return { items: page.items.map(toRegistry), nextCursor: page.nextCursor };
}

export async function findRegistry(
  db: Database,
  scope: AuthScope,
  registryId: string,
): Promise<Registry | null> {
  const rows = await db
    .select(REGISTRY_SELECTION)
    .from(registries)
    .where(visibleWhere(registryVisibility(scope), eq(registries.id, registryId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRegistry(row);
}

/** Файл-скан описи: комплект особого вида, принадлежащий реестру. */
export async function findRegistryFile(
  db: Database,
  scope: AuthScope,
  registryId: string,
): Promise<Work | null> {
  const rows = await db
    .select(WORK_SELECTION)
    .from(works)
    .where(
      withScope(
        scope,
        WORK_SCOPE,
        allOf(eq(works.registryId, registryId), eq(works.kind, 'registry')),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toWork(row);
}

export interface CreateRegistryInput {
  readonly objectId: string;
  readonly sectionCode: string;
  readonly period: string;
  readonly number?: string | null | undefined;
  readonly folderNo?: string | null | undefined;
  readonly building?: string | null | undefined;
  readonly floor?: string | null | undefined;
  readonly structure?: string | null | undefined;
}

export async function createRegistry(
  db: Database,
  scope: AuthScope,
  input: CreateRegistryInput,
  actor: AuditActor,
): Promise<Registry> {
  await requireVisibleObject(db, scope, input.objectId);

  const registryId = await guardNavigation(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(registries)
        .values({
          objectId: input.objectId,
          sectionCode: input.sectionCode,
          period: input.period,
          number: input.number ?? null,
          folderNo: input.folderNo ?? null,
          building: input.building ?? null,
          floor: input.floor ?? null,
          structure: input.structure ?? null,
          createdBy: scope.userId,
        })
        .returning({ id: registries.id });

      const id = inserted[0]?.id;
      if (id === undefined) throw conflict('Реестр не создан: повторите действие.');

      await appendAudit(tx, scope, {
        ...actor,
        action: 'registry.created',
        entityType: 'registry',
        entityId: id,
        objectId: input.objectId,
        payload: { sectionCode: input.sectionCode, period: input.period, number: input.number },
      });
      return id;
    }),
  );

  const created = await findRegistry(db, scope, registryId);
  if (created === null) throw conflict('Реестр создан, но недоступен текущей области видимости.');
  return created;
}

export interface UpdateRegistryPatch {
  readonly number?: string | null | undefined;
  readonly folderNo?: string | null | undefined;
  readonly building?: string | null | undefined;
  readonly floor?: string | null | undefined;
  readonly structure?: string | null | undefined;
}

/**
 * Сравнение-с-обменом по версии.
 *
 * Возвращает новую версию или бросает 412. Без него «последний записавший
 * победил» становится поведением по умолчанию, а здесь это значит, что один
 * сотрудник ПТО молча затрёт состав, собранный другим.
 */
async function bumpRegistryVersion(
  tx: Pick<Database, 'update'>,
  registryId: string,
  expectedVersion: number,
  fields: Record<string, unknown> = {},
): Promise<number> {
  const updated = await tx
    .update(registries)
    .set({ ...fields, version: sql`${registries.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(registries.id, registryId), eq(registries.version, expectedVersion)))
    .returning({ version: registries.version });

  const version = updated[0]?.version;
  if (version === undefined) {
    throw preconditionFailed(
      'Реестр изменён другим пользователем: перечитайте его и повторите действие.',
    );
  }
  return version;
}

/** Реестр в состоянии, в котором его ещё можно править. */
async function requireDraftRegistry(
  db: Database,
  scope: AuthScope,
  registryId: string,
): Promise<Registry> {
  const registry = await findRegistry(db, scope, registryId);
  if (registry === null) throw notFound('Реестр не найден.');
  if (registry.status !== 'draft') {
    throw conflict(
      registry.status === 'issued'
        ? 'Реестр передан: его состав и шапка неизменяемы.'
        : 'Реестр принят: его состав и шапка неизменяемы.',
    );
  }
  return registry;
}

export async function updateRegistry(
  db: Database,
  scope: AuthScope,
  registryId: string,
  expectedVersion: number,
  patch: UpdateRegistryPatch,
  actor: AuditActor,
): Promise<Registry> {
  const registry = await requireDraftRegistry(db, scope, registryId);

  const fields = {
    ...(patch.number === undefined ? {} : { number: patch.number }),
    ...(patch.folderNo === undefined ? {} : { folderNo: patch.folderNo }),
    ...(patch.building === undefined ? {} : { building: patch.building }),
    ...(patch.floor === undefined ? {} : { floor: patch.floor }),
    ...(patch.structure === undefined ? {} : { structure: patch.structure }),
  };
  if (Object.keys(fields).length === 0) {
    throw badRequest('Запрос не содержит ни одного изменяемого поля.');
  }

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      await bumpRegistryVersion(tx, registryId, expectedVersion, fields);
      await appendAudit(tx, scope, {
        ...actor,
        action: 'registry.updated',
        entityType: 'registry',
        entityId: registryId,
        objectId: registry.objectId,
        payload: fields,
      });
    }),
  );

  const updated = await findRegistry(db, scope, registryId);
  if (updated === null) throw notFound('Реестр не найден.');
  return updated;
}

/**
 * Включение комплекта в реестр.
 *
 * Комплект обязан принадлежать тому же объекту, разделу и месяцу: реестр —
 * опись работ за период по одному разделу, и работа другого месяца в ней
 * означала бы, что подпись стоит под чужим периодом. Проверка здесь, а не
 * ключом, потому что это правило предметной области, а не целостности ссылок:
 * база не знает, что «месяц реестра» и «месяц работы» обязаны совпадать.
 */
export async function includeWork(
  db: Database,
  scope: AuthScope,
  registryId: string,
  workId: string,
  expectedVersion: number,
  ordinal: number | null,
  actor: AuditActor,
): Promise<Registry> {
  const registry = await requireDraftRegistry(db, scope, registryId);
  const work = await findWork(db, scope, workId);
  if (work === null) throw notFound('Комплект не найден.');

  if (work.kind !== 'complect') {
    throw conflict('Файл реестра включается в него отдельным действием, а не как комплект.');
  }
  if (
    work.objectId !== registry.objectId ||
    work.sectionCode !== registry.sectionCode ||
    work.period !== registry.period
  ) {
    throw unprocessable(
      [
        {
          pointer: '/workId',
          code: 'mismatch',
          message:
            'Комплект относится к другому объекту, разделу или месяцу: реестр описывает ' +
            'работы одного раздела за один период.',
        },
      ],
      'Комплект не подходит этому реестру.',
    );
  }
  if (work.registryId !== null && work.registryId !== registryId) {
    throw conflict('Комплект уже включён в другой реестр. Сначала исключите его оттуда.');
  }

  const nextOrdinal =
    ordinal ??
    (await db
      .select({ next: sql<number>`coalesce(max(${works.ordinal}), 0) + 1` })
      .from(works)
      .where(eq(works.registryId, registryId))
      .then((rows) => rows[0]?.next ?? 1));

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      await tx
        .update(works)
        .set({ registryId, ordinal: nextOrdinal, updatedAt: sql`now()` })
        .where(eq(works.id, workId));

      await bumpRegistryVersion(tx, registryId, expectedVersion);

      await appendAudit(tx, scope, {
        ...actor,
        action: 'registry.work_included',
        entityType: 'registry',
        entityId: registryId,
        objectId: registry.objectId,
        payload: { workId, ordinal: nextOrdinal },
      });
    }),
  );

  const updated = await findRegistry(db, scope, registryId);
  if (updated === null) throw notFound('Реестр не найден.');
  return updated;
}

export async function excludeWork(
  db: Database,
  scope: AuthScope,
  registryId: string,
  workId: string,
  expectedVersion: number,
  actor: AuditActor,
): Promise<Registry> {
  const registry = await requireDraftRegistry(db, scope, registryId);
  const work = await findWork(db, scope, workId);
  if (work === null || work.registryId !== registryId) {
    throw notFound('Комплект не входит в этот реестр.');
  }
  if (work.kind === 'registry') {
    throw conflict('Файл реестра исключается заменой, а не исключением из состава.');
  }

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      await tx
        .update(works)
        .set({ registryId: null, ordinal: null, updatedAt: sql`now()` })
        .where(eq(works.id, workId));

      await bumpRegistryVersion(tx, registryId, expectedVersion);

      await appendAudit(tx, scope, {
        ...actor,
        action: 'registry.work_excluded',
        entityType: 'registry',
        entityId: registryId,
        objectId: registry.objectId,
        payload: { workId },
      });
    }),
  );

  const updated = await findRegistry(db, scope, registryId);
  if (updated === null) throw notFound('Реестр не найден.');
  return updated;
}

// =====================================================================
// Файл реестра
// =====================================================================

/**
 * Заведение комплекта-файла для реестра.
 *
 * Файл описи проходит тот же конвейер, что и любой комплект, поэтому он и есть
 * комплект — особого вида. Организация берётся из области генподрядчика: описи
 * подписывает он, и заведение её от чужого имени лишено смысла.
 *
 * Второй файл у одного реестра запрещён `ux_works_registry_file`: две описи на
 * одну папку оставили бы вопрос «какая из них подписана» без ответа.
 */
export async function attachRegistryFile(
  db: Database,
  scope: AuthScope,
  registryId: string,
  actor: AuditActor,
): Promise<CreatedWork> {
  const registry = await requireDraftRegistry(db, scope, registryId);
  const acting = resolveActingContractor(scope, null);

  return guardNavigation(() =>
    db.transaction(async (tx) => {
      const insertedWork = await tx
        .insert(works)
        .values({
          objectId: registry.objectId,
          sectionCode: registry.sectionCode,
          period: registry.period,
          contractorId: acting.contractorId,
          managedByContractorId: acting.managedByContractorId,
          kind: 'registry',
          registryId,
          title: `Файл реестра${registry.number === null ? '' : ` №${registry.number}`}`,
          createdBy: scope.userId,
          // Файл описи — единственный комплект, у которого автопрохождение
          // остановок конвейера осмысленно по умолчанию: человек его не
          // размечает, он нужен целиком и сразу для сверки (S20).
          autoRunEnabled: true,
        })
        .returning(WORK_SELECTION);

      const work = insertedWork[0];
      if (work === undefined) throw conflict('Файл реестра не заведён: повторите действие.');

      const revision = await insertDraftRevision(tx, {
        workId: work.id,
        objectId: work.objectId,
        contractorId: work.contractorId,
        revisionNo: 1,
        parentRevisionId: null,
      });

      await tx.update(works).set({ currentRevisionId: revision.id }).where(eq(works.id, work.id));

      await appendRevisionEvent(tx, {
        revisionId: revision.id,
        eventType: 'registry_file.created',
        payload: { registryId, workId: work.id },
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'registry_file.created',
        entityType: 'registry',
        entityId: registryId,
        objectId: registry.objectId,
        payload: { workId: work.id, revisionId: revision.id },
      });

      return { work: toWork({ ...work, currentRevisionId: revision.id }), revision };
    }),
  );
}

// =====================================================================
// Передача и приёмка
// =====================================================================

export interface RegistryBlocker {
  readonly code: string;
  readonly message: string;
}

interface RegistryComposition {
  readonly works: readonly (Work & { readonly revisionStatus: WorkflowStatus | null })[];
  readonly file: (Work & { readonly revisionStatus: WorkflowStatus | null }) | null;
}

/** Состав реестра вместе со статусом текущей ревизии каждого комплекта. */
async function loadComposition(
  db: Database,
  scope: AuthScope,
  registryId: string,
): Promise<RegistryComposition> {
  const rows = await db
    .select({ ...WORK_SELECTION, revisionStatus: submissionRevisions.status })
    .from(works)
    .leftJoin(submissionRevisions, eq(submissionRevisions.id, works.currentRevisionId))
    .where(withScope(scope, WORK_SCOPE, eq(works.registryId, registryId)))
    .orderBy(asc(works.ordinal), asc(works.createdAt));

  const mapped = rows.map((row) => ({
    ...toWork(row),
    revisionStatus: row.revisionStatus === null ? null : (row.revisionStatus as WorkflowStatus),
  }));

  return {
    works: mapped.filter((row) => row.kind === 'complect'),
    file: mapped.find((row) => row.kind === 'registry') ?? null,
  };
}

/**
 * Предусловия передачи — списком, а не первым отказом.
 *
 * Тот же принцип, что у `submitBlockers` в `workflow.ts`: инженер ПТО обязан
 * увидеть все причины сразу, а не получать их по одной за попытку.
 */
export async function issueBlockers(
  db: Database,
  scope: AuthScope,
  registryId: string,
): Promise<readonly RegistryBlocker[]> {
  const registry = await findRegistry(db, scope, registryId);
  if (registry === null) throw notFound('Реестр не найден.');

  const blockers: RegistryBlocker[] = [];
  if (registry.status !== 'draft') {
    blockers.push({
      code: 'not_draft',
      message: registry.status === 'issued' ? 'Реестр уже передан.' : 'Реестр уже принят.',
    });
    return blockers;
  }
  if (registry.number === null || registry.number.trim() === '') {
    blockers.push({ code: 'number_missing', message: 'Не присвоен номер реестра.' });
  }

  const composition = await loadComposition(db, scope, registryId);

  if (composition.works.length === 0) {
    blockers.push({ code: 'no_works', message: 'В реестр не включён ни один комплект.' });
  }

  const unsubmitted = composition.works.filter(
    (work) => work.revisionStatus === null || !SUBMITTED_OR_LATER.includes(work.revisionStatus),
  );
  if (unsubmitted.length > 0) {
    blockers.push({
      code: 'works_not_submitted',
      message:
        `Не поданы комплекты: ${unsubmitted.map((work) => work.title).join(', ')}. ` +
        'Передать можно только то, что подрядчик уже сдал.',
    });
  }

  if (composition.file === null) {
    blockers.push({
      code: 'file_missing',
      message: 'Не загружен подписанный файл реестра.',
    });
  } else if (
    composition.file.revisionStatus === null ||
    !SUBMITTED_OR_LATER.includes(composition.file.revisionStatus)
  ) {
    blockers.push({
      code: 'file_not_submitted',
      message: 'Файл реестра загружен, но не подан: подайте его ревизию.',
    });
  }

  return blockers;
}

/**
 * Передача реестра: снимок состава и смена статуса одной транзакцией.
 *
 * Порядок внутри транзакции значим. Снимок пишется, пока реестр ещё черновик:
 * триггер `registry_items_locked` смотрит на статус РОДИТЕЛЯ, и после смены
 * статуса вставка была бы отвергнута собственным замком.
 */
export async function issueRegistry(
  db: Database,
  scope: AuthScope,
  registryId: string,
  expectedVersion: number,
  actor: AuditActor,
): Promise<Registry> {
  const registry = await findRegistry(db, scope, registryId);
  if (registry === null) throw notFound('Реестр не найден.');

  const blockers = await issueBlockers(db, scope, registryId);
  if (blockers.length > 0) {
    throw unprocessable(
      blockers.map((blocker) => ({
        pointer: null,
        code: blocker.code,
        message: blocker.message,
      })),
      'Реестр не готов к передаче.',
    );
  }

  const composition = await loadComposition(db, scope, registryId);

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      await tx.insert(registryItems).values(
        composition.works.map((work, index) => ({
          registryId,
          ordinal: work.ordinal ?? index + 1,
          workId: work.id,
          // `currentRevisionId` не может быть пуст: комплект без ревизии попал бы
          // в блокеры выше как неподанный.
          revisionId: work.currentRevisionId ?? '',
          contractorId: work.contractorId,
          title: work.title,
        })),
      );

      await bumpRegistryVersion(tx, registryId, expectedVersion, {
        status: 'issued',
        issuedBy: scope.userId,
        issuedAt: sql`now()`,
        issuedFileRevisionId: composition.file?.currentRevisionId ?? null,
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'registry.issued',
        entityType: 'registry',
        entityId: registryId,
        objectId: registry.objectId,
        payload: { number: registry.number, works: composition.works.length },
      });
    }),
  );

  const issued = await findRegistry(db, scope, registryId);
  if (issued === null) throw notFound('Реестр не найден.');
  return issued;
}

/** Приёмка: подпись «Принял» в подвале описи. */
export async function acceptRegistry(
  db: Database,
  scope: AuthScope,
  registryId: string,
  expectedVersion: number,
  actor: AuditActor,
): Promise<Registry> {
  const registry = await findRegistry(db, scope, registryId);
  if (registry === null) throw notFound('Реестр не найден.');
  if (registry.status === 'draft') {
    throw conflict('Реестр ещё не передан: принимать нечего.');
  }
  if (registry.status === 'accepted') {
    throw conflict('Реестр уже принят.');
  }

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      await bumpRegistryVersion(tx, registryId, expectedVersion, {
        status: 'accepted',
        acceptedBy: scope.userId,
        acceptedAt: sql`now()`,
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'registry.accepted',
        entityType: 'registry',
        entityId: registryId,
        objectId: registry.objectId,
        payload: { number: registry.number },
      });
    }),
  );

  const accepted = await findRegistry(db, scope, registryId);
  if (accepted === null) throw notFound('Реестр не найден.');
  return accepted;
}

/**
 * Снимок состава переданного реестра.
 *
 * Подрядчику отдаются только его строки: «в папке 7 работ, из них ваша одна» —
 * сведение о работе конкурентов, полученное арифметикой.
 */
export async function listRegistryItems(
  db: Database,
  scope: AuthScope,
  registryId: string,
): Promise<readonly RegistryItem[]> {
  if ((await findRegistry(db, scope, registryId)) === null) {
    throw notFound('Реестр не найден.');
  }

  return db
    .select({
      registryId: registryItems.registryId,
      ordinal: registryItems.ordinal,
      workId: registryItems.workId,
      revisionId: registryItems.revisionId,
      contractorId: registryItems.contractorId,
      title: registryItems.title,
    })
    .from(registryItems)
    .where(
      allOf(
        eq(registryItems.registryId, registryId),
        scope.kind === 'contractor'
          ? eq(registryItems.contractorId, scope.contractorId)
          : undefined,
      ),
    )
    .orderBy(asc(registryItems.ordinal));
}

/** Комплекты реестра, видимые актору: для карточки реестра и для сверки. */
export async function listRegistryWorks(
  db: Database,
  scope: AuthScope,
  registryId: string,
): Promise<readonly Work[]> {
  const composition = await loadComposition(db, scope, registryId);
  return composition.works.map((work) => toWork(work));
}

// =====================================================================
// Отказы базы
// =====================================================================

/**
 * Отказ ограничения БД → внятный ответ вместо 500.
 *
 * Тот же приём, что у `guardWorkflow()` в `workflow.ts`: список инвариантов, за
 * которые отвечает БД, короток и назван поимённо, всё остальное поднимается как
 * есть — молчаливое проглатывание неизвестного кода скрыло бы настоящий дефект.
 *
 * Составные внешние ключи `works_section_fk` и `works_contractor_fk` переводятся
 * в 422 с указателем на поле, а не в общий 409: «раздел не включён на объекте» и
 * «подрядчик не закреплён» — это ответы администратору о том, что настроить, и
 * различать их обязан текст, а не код состояния.
 */
async function guardNavigation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    if (isHttpProblem(error)) throw error;
    const driver = error as {
      code?: unknown;
      constraint?: unknown;
      cause?: { code?: unknown; constraint?: unknown };
    };
    const sqlState =
      typeof driver.code === 'string'
        ? driver.code
        : typeof driver.cause?.code === 'string'
          ? driver.cause.code
          : undefined;
    const constraint =
      typeof driver.constraint === 'string'
        ? driver.constraint
        : typeof driver.cause?.constraint === 'string'
          ? driver.cause.constraint
          : undefined;

    if (constraint === 'works_section_fk') {
      throw unprocessable(
        [
          {
            pointer: '/sectionCode',
            code: 'section_not_enabled',
            message: 'Раздел не включён на этом объекте. Включите его в справочнике объекта.',
          },
        ],
        'Раздел работ недоступен на объекте.',
      );
    }
    if (constraint === 'works_contractor_fk') {
      throw unprocessable(
        [
          {
            pointer: '/contractorId',
            code: 'contractor_not_assigned',
            message: 'Подрядчик не закреплён за этим объектом. Закрепите его в карточке объекта.',
          },
        ],
        'Подрядчик недоступен на объекте.',
      );
    }
    if (constraint === 'ux_works_registry_file') {
      throw conflict('У реестра уже есть файл описи. Замените его, а не добавляйте второй.');
    }
    if (constraint === 'ux_registries_object_number') {
      throw conflict('Реестр с таким номером на объекте уже есть.');
    }
    if (constraint === 'registries_section_fk') {
      throw unprocessable(
        [
          {
            pointer: '/sectionCode',
            code: 'section_not_enabled',
            message: 'Раздел не включён на этом объекте. Включите его в карточке объекта.',
          },
        ],
        'Раздел работ недоступен на объекте.',
      );
    }
    if (constraint === 'ux_submission_revisions_single_draft' || sqlState === '23505') {
      throw conflict('У комплекта уже есть незакрытая черновая ревизия.', {
        logDetail: `нарушено ограничение ${constraint ?? 'уникальности'}`,
      });
    }
    if (sqlState === '23503' || sqlState === '23514') {
      throw conflict(
        'База отвергла запись: ссылка на несуществующую строку либо нарушенное ограничение.',
        { logDetail: `sqlstate ${sqlState}, ограничение ${constraint ?? 'не указано'}` },
      );
    }
    throw error;
  }
}
