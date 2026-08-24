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
 * * СОСТАВ (файлы, их порядок, подача, следующая ревизия) правит ведущая
 *   организация — либо проверяющий за неё, с пометкой в аудите
 *   (`requireManagedByActor`);
 * * ПРОИЗВОДНОЕ (разметка, распознавание, документы, реквизиты) правит любой,
 *   у кого есть право и область.
 *
 * Без этого различия генподрядчик, видящий все комплекты объекта, мог бы
 * дозагрузить файл в чужой черновик — то есть подать от чужого имени. Именно
 * ЭТО различие и осталось; закрытость состава для проверяющих снята на S21
 * (заказчик: загрузить исправленную версию вправе все пять ролей), и их рубежом
 * служит область видимости.
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
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
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
import { purgeRevisionEntirely } from './purge.js';
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

  // Проверяющий (инженер, руководитель, администратор) организации не имеет, и
  // придумать её здесь нечем: `managed_by_contractor_id` ссылается на
  // `counterparties`, а область видимости у него объектная. Поэтому исполнитель
  // ОБЯЗАН быть назван, и он же становится ведущей организацией — иначе
  // подрядчик не смог бы потом дозагрузить в этот комплект исправленную версию,
  // то есть портал завёл бы ему комплект, в который он не может писать.
  if (requested === undefined || requested === null) {
    throw badRequest(
      'Укажите организацию-исполнителя: у вашей области видимости своей организации нет.',
      { logDetail: `создание комплекта без contractorId при области ${scope.kind}` },
    );
  }
  return {
    contractorId: requested,
    managedByContractorId: requested,
    onBehalfOf: true,
  };
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
 * Правка СОСТАВА комплекта: своя организация — или проверяющий за неё.
 *
 * Граница между организациями осталась ровно та же, что задал ADR-0011:
 * генподрядчик видит все комплекты своих объектов и обязан их видеть (иначе
 * собрать реестр не из чего), но дозагрузить файл в черновик СОСЕДНЕЙ
 * организации не может — это значило бы подать за него работу, которую он не
 * выполнял.
 *
 * Изменилось другое: проверяющим (инженер, руководитель, администратор) правка
 * состава открыта. ADR-0011 §3 закрывал её им наглухо, исходя из «подаёт тот,
 * кто выполнил»; заказчик эту посылку снял — загрузить исправленную версию
 * вправе все пять ролей. Область видимости при этом остаётся единственным
 * рубежом для них, и она уже узкая: у инженера — назначенные объекты.
 *
 * Возвращает `onBehalfOf`, а не `void`: подача за другую организацию обязана
 * быть видна в журнале — это единственный путь, которым в портале появляется
 * работа, поданная не тем, кто её выполнил. Вызывающий кладёт флаг в аудит.
 */
export function requireManagedByActor(
  scope: AuthScope,
  work: { readonly managedByContractorId: string; readonly contractorId: string },
): { readonly onBehalfOf: boolean } {
  if (scope.kind === 'contractor' || scope.kind === 'general_contractor') {
    if (work.managedByContractorId !== scope.contractorId) {
      throw forbidden(
        'Состав этого комплекта ведёт другая организация. Разметка и документы вам ' +
          'доступны, файлы и подача — нет.',
        { logDetail: 'правка состава комплекта чужой организацией' },
      );
    }
    return { onBehalfOf: work.contractorId !== scope.contractorId };
  }
  // Проверяющий организации не имеет вовсе, поэтому его правка состава — всегда
  // действие за исполнителя, и всегда помеченное.
  return { onBehalfOf: true };
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

/**
 * Отбор комплектов — без страницы: то же множество, что считает и `sectionCounts`.
 *
 * Вынесено в отдельный тип не ради экономии строк, а ради того, чтобы счётчик и
 * список нельзя было отфильтровать по-разному. Заголовок «комплектов 7» над
 * таблицей, показывающей два, — это не косметический дефект: он утверждает
 * существование пяти работ, которых спрашивающий не видит.
 */
export interface WorkFilterParams {
  readonly objectId?: string | undefined;
  readonly sectionCode?: string | undefined;
  /** Точный месяц. С границами не спорит: они независимы и складываются. */
  readonly period?: string | undefined;
  readonly periodFrom?: string | undefined;
  readonly periodTo?: string | undefined;
  readonly registryId?: string | undefined;
  /** Только комплекты, не включённые ни в один реестр. */
  readonly unassigned?: boolean | undefined;
  readonly search?: string | undefined;
}

export interface WorkListParams extends WorkFilterParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
}

/**
 * Условия отбора комплектов — ОДИН экземпляр правила на список и на счётчик.
 *
 * Область видимости сюда не входит: её накладывает `withScope` у вызывающего,
 * и разделение намеренное — забыть обёртку заметнее, чем забыть строку внутри
 * длинного `allOf`.
 */
function workFilters(params: WorkFilterParams): SQL {
  const term = params.search === undefined ? null : `%${escapeLike(params.search)}%`;
  return allOf(
    eq(works.kind, 'complect'),
    params.objectId === undefined ? undefined : eq(works.objectId, params.objectId),
    params.sectionCode === undefined ? undefined : eq(works.sectionCode, params.sectionCode),
    params.period === undefined ? undefined : eq(works.period, params.period),
    params.periodFrom === undefined ? undefined : gte(works.period, params.periodFrom),
    params.periodTo === undefined ? undefined : lte(works.period, params.periodTo),
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
  );
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

  const rows = await db
    .select(WORK_SELECTION)
    .from(works)
    .where(
      withScope(
        scope,
        WORK_SCOPE,
        allOf(
          workFilters(params),
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

export interface SectionWorkCount {
  readonly sectionCode: string;
  readonly works: number;
}

/**
 * Сколько комплектов у каждого раздела объекта — одним `GROUP BY`.
 *
 * Существует ради заголовков дерева на экране объекта: без него число рядом с
 * названием раздела пришлось бы получать выкачиванием всех комплектов, то есть
 * ровно тем, чего ленивое дерево и избегает.
 *
 * Область и фильтры — те же, что у `listWorks`: см. `workFilters`. Разделы, в
 * которых спрашивающему не видно ни одного комплекта, в выдаче отсутствуют, а
 * не приходят нулями — «включён, но пуст» и «включён, но не ваш» портал
 * различать не обязан, а вот путать их числом не вправе.
 */
export async function countWorksBySection(
  db: Database,
  scope: AuthScope,
  objectId: string,
  params: Omit<WorkFilterParams, 'objectId'> = {},
): Promise<readonly SectionWorkCount[]> {
  await requireVisibleObject(db, scope, objectId);

  return db
    .select({
      sectionCode: works.sectionCode,
      works: sql<number>`count(*)::int`,
    })
    .from(works)
    .where(withScope(scope, WORK_SCOPE, workFilters({ ...params, objectId })))
    .groupBy(works.sectionCode)
    .orderBy(asc(works.sectionCode));
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
  const { onBehalfOf } = requireManagedByActor(scope, work);

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
        payload: { ...fields, onBehalfOf },
      });
    }),
  );

  return findWork(db, scope, workId);
}

// =====================================================================
// Удаление комплекта (S24)
// =====================================================================

/**
 * Что исчезнет вместе с комплектом.
 *
 * Отдельный ответ, а не строка подтверждения на клиенте: числа знает только БД,
 * а решение принимает человек. «Удалить комплект?» без чисел — это вопрос, на
 * который нельзя ответить осознанно: за безобидным названием может стоять
 * ревизия с сотней страниц и суточной работой распознавания.
 */
export interface WorkDeletionPreview {
  readonly workId: string;
  readonly title: string;
  readonly revisions: number;
  readonly files: number;
  readonly pages: number;
  readonly layoutBlocks: number;
  readonly documents: number;
  readonly findings: number;
  /**
   * Что мешает удалить. Пустой список — удаление пройдёт.
   *
   * Фразы готовые и русские, как `submitBlockers` в рабочем процессе: словарь
   * поверх кодов на клиенте потерял бы числа, а «нельзя» без причины отправляет
   * администратора искать её по всей схеме.
   */
  readonly blockers: readonly string[];
}

/**
 * Помехи удалению комплекта.
 *
 * Все три — про то, что уже ушло наружу и перестало быть внутренним делом
 * портала. Согласованная ревизия — это принятое решение с архивом и хэшем
 * состава; переданный реестр — подписанная папка, список работ в которой
 * доказывает, что именно передавали; юридический запрет прямо требует хранить.
 * Удалить комплект в этих случаях значит переписать чужой документ, и режим
 * тестирования тут ничего не меняет: он ослабляет запреты СВОЕЙ базы, а не
 * обязательства перед второй стороной.
 */
async function workDeletionBlockers(
  db: Database,
  workId: string,
  enforceImmutability: boolean,
): Promise<readonly string[]> {
  const result = await db.execute<{
    approved: number;
    issued: number;
    holds: number;
    submitted: number;
  }>(sql`
    select
      (select count(*) from submission_revisions
        where work_id = ${workId}::uuid and status = 'approved')::int as approved,
      (select count(*) from submission_revisions
        where work_id = ${workId}::uuid
          and status in ('submitted', 'in_review', 'returned'))::int as submitted,
      (select count(*) from registries r
         join registry_items ri on ri.registry_id = r.id
        where ri.work_id = ${workId}::uuid and r.status <> 'draft')::int as issued,
      (select count(*) from legal_holds lh
         join submission_revisions sr on sr.id = lh.revision_id
        where sr.work_id = ${workId}::uuid and lh.released_at is null)::int as holds
  `);

  const row = result.rows[0];
  const blockers: string[] = [];
  if (row === undefined) return blockers;

  if (row.approved > 0) {
    blockers.push(
      `в комплекте есть согласованные ревизии: ${String(row.approved)} — согласование отменяется решением, а не удалением`,
    );
  }
  if (row.issued > 0) {
    blockers.push(
      `комплект включён в переданный реестр (записей: ${String(row.issued)}) — список переданных работ неизменяем`,
    );
  }
  if (row.holds > 0) {
    blockers.push(`на ревизии наложен неснятый юридический запрет: ${String(row.holds)}`);
  }
  // Поданная ревизия — помеха ТОЛЬКО в строгом режиме, и названа она явно, а не
  // оставлена триггерам. Без этой строки удаление доходило бы до БД и падало
  // `restrict_violation` из драйвера — то есть пятисотым кодом без объяснения,
  // хотя запрет ожидаемый и объяснимый: состав поданного комплекта покрыт хэшем,
  // и всё выведенное из него доказывает, что именно проверяли.
  if (enforceImmutability && row.submitted > 0) {
    blockers.push(
      `в комплекте есть поданные ревизии: ${String(row.submitted)} — состав поданного ` +
        'комплекта неизменяем (§3.9). Удаление доступно в режиме тестирования',
    );
  }
  return blockers;
}

export async function previewWorkDeletion(
  db: Database,
  scope: AuthScope,
  workId: string,
  enforceImmutability: boolean,
): Promise<WorkDeletionPreview | null> {
  const work = await findWork(db, scope, workId);
  if (work === null) return null;

  const counts = await db.execute<{
    revisions: number;
    files: number;
    pages: number;
    blocks: number;
    documents: number;
    findings: number;
  }>(sql`
    with rev as (select id from submission_revisions where work_id = ${workId}::uuid)
    select
      (select count(*) from rev)::int as revisions,
      (select count(*) from source_files where revision_id in (select id from rev))::int as files,
      (select count(*) from source_pages where revision_id in (select id from rev))::int as pages,
      (select count(*) from layout_blocks where revision_id in (select id from rev))::int as blocks,
      (select count(*) from logical_documents
        where revision_id in (select id from rev))::int as documents,
      (select count(*) from findings where revision_id in (select id from rev))::int as findings
  `);

  const row = counts.rows[0];
  return {
    workId,
    title: work.title,
    revisions: row?.revisions ?? 0,
    files: row?.files ?? 0,
    pages: row?.pages ?? 0,
    layoutBlocks: row?.blocks ?? 0,
    documents: row?.documents ?? 0,
    findings: row?.findings ?? 0,
    blockers: await workDeletionBlockers(db, workId, enforceImmutability),
  };
}

/**
 * Удалить ОДНУ ревизию комплекта со всем производным.
 *
 * Отдельно от `deleteWork`, потому что вопрос другой: не «этого комплекта не
 * должно быть», а «эта попытка не удалась, начнём заново». Механика удаления при
 * этом общая — `purgeRevisionEntirely`, тот же топологический порядок.
 *
 * Помехи берутся те же, что у комплекта, но считаются по ОДНОЙ ревизии: режим
 * тестирования ослабляет запреты своей базы, а не обязательства перед второй
 * стороной — согласованную ревизию, переданный реестр и юридический запрет он не
 * отменяет (ADR-0015).
 *
 * Последняя ревизия комплекта не удаляется: вход в комплект на экране — это
 * `works.current_revision_id`, и комплект без единой ревизии стал бы недостижим,
 * а `DELETE /works/{id}` — ровно то действие, которое здесь и требуется. Отказ
 * называет его прямо, а не оставляет искать.
 */
export async function deleteRevision(
  db: Database,
  scope: AuthScope,
  revisionId: string,
  actor: AuditActor,
  enforceImmutability: boolean,
): Promise<{ readonly deleted: boolean; readonly blockers: readonly string[] } | null> {
  const rows = await db
    .select({
      id: submissionRevisions.id,
      workId: submissionRevisions.workId,
      objectId: submissionRevisions.objectId,
      revisionNo: submissionRevisions.revisionNo,
      status: submissionRevisions.status,
    })
    .from(submissionRevisions)
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.id, revisionId)))
    .limit(1);

  const revision = rows[0];
  if (revision === undefined) return null;

  const blockers = await revisionDeletionBlockers(db, revision, enforceImmutability);
  if (blockers.length > 0) return { deleted: false, blockers };

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      /**
       * Указатель комплекта переводится на соседнюю ревизию ПЕРВЫМ.
       *
       * `works.current_revision_id` ссылается на строку, которую мы сейчас
       * удалим, и внешний ключ отверг бы удаление раньше, чем дело дойдёт до
       * него. Берётся ревизия с наибольшим номером из оставшихся — то есть та,
       * на которую и указывал бы комплект, если бы удаляемой не было.
       */
      const previous = await tx
        .select({ id: submissionRevisions.id })
        .from(submissionRevisions)
        .where(
          and(
            eq(submissionRevisions.workId, revision.workId),
            ne(submissionRevisions.id, revisionId),
          ),
        )
        .orderBy(desc(submissionRevisions.revisionNo))
        .limit(1);

      await tx
        .update(works)
        .set({ currentRevisionId: previous[0]?.id ?? null })
        .where(eq(works.id, revision.workId));

      // Дети удаляемой ревизии по `parent_revision_id`: ссылка без каскада, и
      // осиротить её нельзя. Родителем становится тот же сосед.
      await tx
        .update(submissionRevisions)
        .set({ parentRevisionId: previous[0]?.id ?? null })
        .where(eq(submissionRevisions.parentRevisionId, revisionId));

      await purgeRevisionEntirely(tx, revisionId);

      await appendAudit(tx, scope, {
        ...actor,
        action: 'revision.deleted',
        entityType: 'submission_revision',
        entityId: revisionId,
        objectId: revision.objectId,
        payload: {
          workId: revision.workId,
          revisionNo: revision.revisionNo,
          status: revision.status,
        },
      });
    }),
  );

  return { deleted: true, blockers: [] };
}

/** Помехи удалению одной ревизии — те же четыре, что у комплекта. */
async function revisionDeletionBlockers(
  db: Database,
  revision: { readonly id: string; readonly workId: string; readonly status: string },
  enforceImmutability: boolean,
): Promise<readonly string[]> {
  const result = await db.execute<{ siblings: number; issued: number; holds: number }>(sql`
    select
      (select count(*) from submission_revisions
        where work_id = ${revision.workId}::uuid)::int as siblings,
      (select count(*) from registries r
         join registry_items ri on ri.registry_id = r.id
        where ri.revision_id = ${revision.id}::uuid and r.status <> 'draft')::int as issued,
      (select count(*) from legal_holds
        where revision_id = ${revision.id}::uuid and released_at is null)::int as holds
  `);

  const row = result.rows[0];
  const blockers: string[] = [];
  if (row === undefined) return blockers;

  if (row.siblings <= 1) {
    blockers.push(
      'это единственная ревизия комплекта — комплект без ревизий недостижим с экрана; ' +
        'удалите комплект целиком',
    );
  }
  if (revision.status === 'approved') {
    blockers.push('ревизия согласована — согласование отменяется решением, а не удалением');
  }
  if (row.issued > 0) {
    blockers.push(
      `ревизия включена в переданный реестр (записей: ${String(row.issued)}) — ` +
        'список переданных работ неизменяем',
    );
  }
  if (row.holds > 0) {
    blockers.push(`на ревизию наложен неснятый юридический запрет: ${String(row.holds)}`);
  }
  if (enforceImmutability && revision.status !== 'draft') {
    blockers.push(
      `ревизия в статусе «${revision.status}» — состав поданного комплекта неизменяем (§3.9). ` +
        'Удаление доступно в режиме тестирования',
    );
  }
  return blockers;
}

/**
 * Удалить комплект со всем содержимым.
 *
 * `null` — комплекта нет или он вне области видимости; различать их снаружи
 * нельзя (§1.6), и маршрут отвечает на оба случая одинаково.
 *
 * Право на это действие — `settings.manage`, то есть администратор, а не
 * `submission.upload`: загрузить свой комплект и стереть чужую работу вместе с
 * историей проверок — разные по весу действия, и первое не должно давать
 * второго.
 *
 * Удаление идёт ОДНОЙ транзакцией по всем ревизиям: комплект, у которого
 * половина ревизий исчезла, а половина осталась, — это состояние, которого в
 * модели нет и восстанавливать которое нечем.
 */
export async function deleteWork(
  db: Database,
  scope: AuthScope,
  workId: string,
  actor: AuditActor,
  enforceImmutability: boolean,
): Promise<{ readonly deleted: boolean; readonly blockers: readonly string[] } | null> {
  const preview = await previewWorkDeletion(db, scope, workId, enforceImmutability);
  if (preview === null) return null;
  if (preview.blockers.length > 0) return { deleted: false, blockers: preview.blockers };

  const work = await findWork(db, scope, workId);
  if (work === null) return null;

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      const revisions = await tx
        .select({ id: submissionRevisions.id })
        .from(submissionRevisions)
        .where(eq(submissionRevisions.workId, workId));

      // Указатель обнуляется ПЕРВЫМ: `works.current_revision_id` ссылается на
      // строку, которую мы сейчас удалим, и внешний ключ иначе отверг бы
      // удаление ревизии раньше, чем дело дойдёт до самого комплекта.
      await tx.update(works).set({ currentRevisionId: null }).where(eq(works.id, workId));

      for (const revision of revisions) {
        await purgeRevisionEntirely(tx, revision.id);
      }

      // Сверка с описью и членство в папке привязаны к работе, а не к ревизии, и
      // своих строк в `purgeRevisionEntirely` не имеют.
      await tx.execute(
        sql`delete from registry_reconciliation_works where work_id = ${workId}::uuid`,
      );
      await tx.execute(sql`delete from registry_items where work_id = ${workId}::uuid`);
      await tx.delete(works).where(eq(works.id, workId));

      // Название и период попадают в след: после удаления карточки узнать, что
      // именно исчезло, будет неоткуда.
      await appendAudit(tx, scope, {
        ...actor,
        action: 'work.deleted',
        entityType: 'work',
        entityId: workId,
        objectId: work.objectId,
        payload: {
          title: work.title,
          period: work.period,
          revisions: preview.revisions,
          files: preview.files,
          pages: preview.pages,
        },
      });
    }),
  );

  return { deleted: true, blockers: [] };
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
  const { onBehalfOf } = requireManagedByActor(scope, work);

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
          onBehalfOf,
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

/** Комплект папки вместе с его текущей ревизией — вход сверки описи (S20). */
export interface RegistryComplectRevision {
  readonly workId: string;
  readonly revisionId: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly managedByContractorId: string;
  readonly title: string;
}

/**
 * Комплекты папки с текущими ревизиями — БЕЗ области видимости, намеренно.
 *
 * Множество здесь закрывается КЛЮЧОМ, а не областью: `works.registry_id = ?`
 * плюс `kind = 'complect'`. Область была бы не защитой, а дефектом: сверка
 * описи сравнивает бумагу со ВСЕЙ папкой, а в одной папке комплекты разных
 * субподрядчиков. Отфильтруй их областью — и сверка ответила бы «сошлась» в
 * смысле «сошлась по той части, что мне видна», то есть соврала бы ровно там,
 * где её и спрашивают.
 *
 * **Результат нельзя отдавать наружу HTTP-маршрутом.** Он предназначен задаче
 * `registry.reconcile`, которая работает под областью, закреплённой объектом
 * реестра, и записывает итог в замороженные таблицы; выдачу из этих таблиц
 * режут по правам уже маршруты. Прямая отдача отсюда была бы обходом §4.1.
 */
export async function listRegistryComplectRevisions(
  db: Database,
  registryId: string,
): Promise<readonly RegistryComplectRevision[]> {
  const rows = await db
    .select({
      workId: works.id,
      revisionId: works.currentRevisionId,
      objectId: works.objectId,
      contractorId: works.contractorId,
      managedByContractorId: works.managedByContractorId,
      title: works.title,
    })
    .from(works)
    .where(
      and(
        eq(works.registryId, registryId),
        eq(works.kind, 'complect'),
        isNotNull(works.currentRevisionId),
      ),
    )
    .orderBy(asc(works.ordinal), asc(works.createdAt));

  return rows.map((row) => ({ ...row, revisionId: row.revisionId as string }));
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
