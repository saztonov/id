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
 * Возврат (`returnFolder`) закрывает ревизию и ТОЙ ЖЕ транзакцией открывает
 * следующую с `parent_folder_id`. Второго пути с другой семантикой здесь нет:
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
 * Строку с `draft` защищает ещё и `ux_submission_folders_single_draft`:
 * проверка состояния здесь нужна ради внятного отказа, а инвариант держит БД.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { counterparties, folders } from '@id/db';
import type { Folder, ProcessingStage } from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import {
  badRequest,
  conflict,
  forbidden,
  isHttpProblem,
  notFound,
  unprocessable,
} from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendAudit, type AuditActor } from './audit.js';
import { findConstructionObject } from './catalog.js';
import { appendFolderEvent, summarizeFolderStages } from './jobs.js';
import { purgeFolderEntirely } from './purge.js';
import type { Database } from './users.js';

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

const iso = (column: unknown, alias: string) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(alias);

/**
 * Дата без времени: месяц передаётся строкой `ГГГГ-ММ-01`, а не меткой времени.
 *
 * Тип объявлен nullable: `to_char(NULL, …)` возвращает `NULL`, и прежнее
 * `sql<string>` просто лгало — у комплекта, месяц которого портал ещё не
 * прочитал, поле приходит пустым (S30).
 */
const date = (column: unknown, alias: string) =>
  sql<string | null>`to_char(${column}, 'YYYY-MM-DD')`.as(alias);

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
 * сортировался по коду. Папки отдаются по времени заведения, а числового
 * курсора не осталось вместе с рядом ревизий.
 */
const timeCursorSchema = z.object({ at: z.string().min(1), id: z.uuid() });

type AnyCursor = z.infer<typeof timeCursorSchema>;

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
  /**
   * Исполнитель ВЫВЕДЕН порталом, а не назван человеком (S37).
   *
   * Поднимается только у проверяющих: у подрядчика и генподрядчика организация
   * есть, и подставлять нечего.
   */
  readonly assumed: boolean;
}

export function resolveActingContractor(
  scope: AuthScope,
  requested: string | null | undefined,
  /**
   * Кого портал подставит проверяющему, если тот исполнителя не назвал.
   *
   * Приходит из карточки объекта (`deriveObjectContractor`), а не выдумывается
   * здесь: функция чистая, и ходить в базу ей нечем.
   */
  derived?: string | null,
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
      assumed: false,
    };
  }

  if (scope.kind === 'general_contractor') {
    const contractorId = requested ?? scope.contractorId;
    return {
      contractorId,
      managedByContractorId: scope.contractorId,
      onBehalfOf: contractorId !== scope.contractorId,
      assumed: false,
    };
  }

  /**
   * Проверяющий (инженер, руководитель, администратор) своей организации не
   * имеет, и до S37 портал ТРЕБОВАЛ назвать исполнителя. Заказчик указал на
   * это прямо: в момент загрузки файла человек исполнителя не знает — файл ещё
   * никто не читал. Ровно та же ошибка, которую S30 уже исправил для месяца.
   *
   * Названный исполнитель по-прежнему принимается и признаком не помечается:
   * человек, который знает, вправе сказать.
   */
  if (requested !== undefined && requested !== null) {
    return {
      contractorId: requested,
      managedByContractorId: requested,
      onBehalfOf: true,
      assumed: false,
    };
  }

  /**
   * Не назвал — портал ВЫВОДИТ исполнителя и помечает вывод признаком.
   *
   * Вывод, а не выдумка: генподрядчик из карточки объекта — запись, которую
   * сделал человек. Признак `assumed` оставляет значение отличимым от
   * прочитанного и разрешает конвейеру заменить его организацией из акта.
   *
   * Если вывести не из чего — отказ, и текст называет ДЕЙСТВИЕ, а не
   * запрещённое состояние. Действие стоит в `detail`, потому что показывают
   * именно его: `errors[].message` экран не печатает, и до S39 человек видел
   * ровно «Исполнителя не из чего вывести» — верно и бесполезно.
   */
  if (derived === undefined || derived === null) {
    throw unprocessable(
      [
        {
          pointer: '/contractorId',
          code: 'contractor_undetermined',
          message: 'Генподрядчик объекта не назван, и вывести исполнителя не из чего.',
        },
      ],
      'Укажите генподрядчика в карточке объекта — портал возьмёт исполнителя оттуда. ' +
        'Либо назовите исполнителя явно при заведении комплекта.',
    );
  }

  return {
    contractorId: derived,
    managedByContractorId: derived,
    onBehalfOf: true,
    assumed: true,
  };
}

/**
 * Кого портал подставит исполнителем на этом объекте.
 *
 * ## Закрепления здесь больше не читаются (S39)
 *
 * До S39 порядок был «генподрядчик из карточки, потом единственный ЗАКРЕПЛЁННЫЙ
 * подрядчик», и опирался он на `object_contractors`, потому что составной ключ
 * `works_contractor_fk` иначе отверг бы запись. На боевых объектах закрепления
 * не ведут: у одного их ноль, у другого три и ни одного признака, кто из них
 * генподрядчик. Правило отвечало «не из чего вывести» на каждом объекте, то
 * есть портал не давал загрузить ни одного файла.
 *
 * Ключ снят (0055), и вместе с ним ушло основание читать закрепления. Порядок
 * теперь выражает ровно то, что портал знает о стройке:
 *
 * 1. генподрядчик, названный В КАРТОЧКЕ объекта, — прямое утверждение человека;
 * 2. единственная активная организация вида `general_contractor` в справочнике.
 *
 * Второй шаг — допущение, и оно названо допущением: «в портале одна генподрядная
 * организация, значит работает она». Допущение ПРОВЕРЯЕМОЕ — как только таких
 * организаций станет две, портал снова спросит человека вместо того, чтобы
 * выбрать наугад. Тем оно и отличается от догадки.
 *
 * `null` означает «вывести не из чего», и вызывающий превращает его в отказ с
 * названным действием, а не в молчаливую подстановку.
 */
async function deriveObjectContractor(db: Database, objectId: string): Promise<string | null> {
  const named = await db.execute<{ contractor_id: string | null }>(sql`
    select general_contractor_id::text as contractor_id
      from construction_objects
     where id = ${objectId}::uuid
  `);
  const fromCard = named.rows[0]?.contractor_id ?? null;
  if (fromCard !== null) return fromCard;

  // Две строки, а не одна: `limit 2` отвечает на вопрос «единственная ли она»,
  // не вычитывая справочник целиком.
  const generals = await db.execute<{ id: string }>(sql`
    select id::text as id
      from counterparties
     where kind = 'general_contractor' and is_active
     limit 2
  `);
  return generals.rows.length === 1 ? (generals.rows[0]?.id ?? null) : null;
}

/**
 * Объект, на котором актор вправе что-либо заводить.
 *
 * Составной ключ `folders_section_fk` держит ЦЕЛОСТНОСТЬ (раздел включён на
 * объекте), но не область видимости: назвать можно было и чужой объект, где
 * нужный раздел включён, — запись прошла бы. 404, а не 403: «нет такого» и «не
 * ваше» здесь неразличимы по §1.6.
 *
 * Парный ему `works_contractor_fk` снят в S39 — закрепление подрядчика больше
 * не является условием заведения папки (0055).
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

const FOLDER_SELECTION = {
  id: folders.id,
  objectId: folders.objectId,
  sectionCode: folders.sectionCode,
  period: date(folders.period, 'period_date'),
  contractorAssumed: folders.contractorAssumed,
  contractorRaw: folders.contractorRaw,
  // Подзапросом, а не соединением: `FOLDER_SELECTION` используется в
  // `.returning(...)` на вставке папки, куда join не поставить, а вторая
  // выборка ради одного поля разошлась бы с первой при первой же правке.
  contractorName: sql<string>`(
    select c.name from ${counterparties} c where c.id = ${folders.contractorId}
  )`.as('contractor_name'),
  contractorId: folders.contractorId,
  managedByContractorId: folders.managedByContractorId,
  title: folders.title,
  ordinal: folders.ordinal,
  autoRunEnabled: folders.autoRunEnabled,
  aggregateManifestHash: folders.aggregateManifestHash,
  version: folders.version,
  createdBy: folders.createdBy,
  createdAt: iso(folders.createdAt, 'created_at_iso'),
};

/**
 * Отбор комплектов — без страницы: то же множество, что считает и `sectionCounts`.
 *
 * Вынесено в отдельный тип не ради экономии строк, а ради того, чтобы счётчик и
 * список нельзя было отфильтровать по-разному. Заголовок «комплектов 7» над
 * таблицей, показывающей два, — это не косметический дефект: он утверждает
 * существование пяти работ, которых спрашивающий не видит.
 */
export interface FolderFilterParams {
  readonly objectId?: string | undefined;
  readonly sectionCode?: string | undefined;
  /** Точный месяц. С границами не спорит: они независимы и складываются. */
  readonly period?: string | undefined;
  readonly periodFrom?: string | undefined;
  readonly periodTo?: string | undefined;
  /**
   * Пускать в отбор по месяцу комплекты, месяц которых ещё не определён (S30).
   *
   * Нужен ровно одному вызывающему — списку кандидатов на включение в реестр.
   * Комплект, который портал ещё не распознал, месяца не имеет, и без этого
   * признака он выпал бы из кандидатов, а включить его при этом можно: сверка
   * месяца в `includeWork` пропускает неизвестный.
   *
   * По умолчанию выключен: обычный отбор «за август» — это вопрос о фактах, и
   * подмешивать в ответ комплекты неизвестного месяца значило бы отвечать не на
   * него.
   */
  readonly includeUndatedPeriod?: boolean | undefined;
  readonly registryId?: string | undefined;
  /** Только комплекты, не включённые ни в один реестр. */
  readonly unassigned?: boolean | undefined;
  readonly search?: string | undefined;
}

export interface FolderListParams extends FolderFilterParams {
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
function folderFilters(params: FolderFilterParams): SQL {
  const term = params.search === undefined ? null : `%${escapeLike(params.search)}%`;
  return allOf(
    params.objectId === undefined ? undefined : eq(folders.objectId, params.objectId),
    params.sectionCode === undefined ? undefined : eq(folders.sectionCode, params.sectionCode),
    params.period === undefined
      ? undefined
      : params.includeUndatedPeriod === true
        ? or(eq(folders.period, params.period), isNull(folders.period))
        : eq(folders.period, params.period),
    params.periodFrom === undefined ? undefined : gte(folders.period, params.periodFrom),
    params.periodTo === undefined ? undefined : lte(folders.period, params.periodTo),
    term === null ? undefined : ilike(folders.title, term),
  );
}

/**
 * Комплекты, новые первыми.
 *
 * Файлы реестров (`kind='registry'`) в общий список НЕ попадают: это служебная
 * единица, у которой нет исполнителя работ, и в перечне работ она выглядела бы
 * работой. Читается она отдельно — вместе с реестром, которому принадлежит.
 */
export async function listFolders(
  db: Database,
  scope: AuthScope,
  params: FolderListParams,
): Promise<Page<Folder>> {
  const after = decodeCursor(params.cursor, timeCursorSchema);

  const rows = await db
    .select(FOLDER_SELECTION)
    .from(folders)
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        allOf(
          folderFilters(params),
          after === null
            ? undefined
            : sql`(${folders.createdAt}, ${folders.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        ),
      ),
    )
    .orderBy(desc(folders.createdAt), desc(folders.id))
    .limit(params.limit + 1);

  const page = paginate(rows, params.limit, (row) => ({ at: row.createdAt, id: row.id }));
  return { items: page.items, nextCursor: page.nextCursor };
}

export interface SectionFolderCount {
  readonly sectionCode: string;
  readonly folders: number;
}

/**
 * Сколько комплектов у каждого раздела объекта — одним `GROUP BY`.
 *
 * Существует ради заголовков дерева на экране объекта: без него число рядом с
 * названием раздела пришлось бы получать выкачиванием всех комплектов, то есть
 * ровно тем, чего ленивое дерево и избегает.
 *
 * Область и фильтры — те же, что у `listFolders`: см. `workFilters`. Разделы, в
 * которых спрашивающему не видно ни одного комплекта, в выдаче отсутствуют, а
 * не приходят нулями — «включён, но пуст» и «включён, но не ваш» портал
 * различать не обязан, а вот путать их числом не вправе.
 */
export async function countFoldersBySection(
  db: Database,
  scope: AuthScope,
  objectId: string,
  params: Omit<FolderFilterParams, 'objectId'> = {},
): Promise<readonly SectionFolderCount[]> {
  await requireVisibleObject(db, scope, objectId);

  return db
    .select({
      sectionCode: folders.sectionCode,
      folders: sql<number>`count(*)::int`,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, folderFilters({ ...params, objectId })))
    .groupBy(folders.sectionCode)
    .orderBy(asc(folders.sectionCode));
}

/**
 * Состояние конвейера по комплектам ОДНОЙ страницы списка.
 *
 * ## Почему отдельный маршрут, а не поле `Folder`
 *
 * `FOLDER_SELECTION` используется в `.returning(...)` на вставке комплекта, куда
 * соединение не поставить, — пришлось бы разделить выборку надвое и завести ту
 * самую вторую копию отбора, против которой написан докстринг
 * `FolderFilterParams`. Плюс сводка меняется каждые секунды, а список — раз в
 * заведение: сложив их, опрос тянул бы весь keyset-список с курсорами.
 *
 * ## Почему идентификаторы приходят от клиента
 *
 * Отбирать заново значило бы отвечать про другую страницу: список листается
 * курсором, и между двумя запросами состав страницы мог измениться. Клиент
 * присылает то, что УЖЕ отрисовал, и расхождение исключено по построению.
 *
 * Область при этом применяется здесь, а не подразумевается: присланный
 * идентификатор чужого комплекта в ответ не попадёт, и строка на экране
 * останется без данных — это честнее, чем «не запускалось», потому что о
 * чужом комплекте портал не утверждает ничего.
 */
export interface FolderPipelineSummary {
  readonly folderId: string;
  readonly stage: ProcessingStage;
  readonly queued: number;
  readonly running: number;
  readonly dead: number;
}

export async function summarizeFolderPipeline(
  db: Database,
  scope: AuthScope,
  objectId: string,
  folderIds: readonly string[],
): Promise<readonly FolderPipelineSummary[]> {
  await requireVisibleObject(db, scope, objectId);
  if (folderIds.length === 0) return [];

  const rows = await db
    .select({ id: folders.id })
    .from(folders)
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        allOf(eq(folders.objectId, objectId), inArray(folders.id, [...folderIds])),
      ),
    );

  return summarizeFolderStages(
    db,
    rows.map((row) => row.id),
  );
}

/**
 * Сообщить о том, что конвейер дописал карточку папки (S45).
 *
 * Месяц (S30) и исполнитель (S37) появляются не действием человека, а
 * прочтением акта — и до S45 об этом не узнавал никто: событие писалось только
 * на `folder.created`, поэтому экран показывал «После OCR» у папки, месяц
 * которой портал уже прочитал, до перезагрузки страницы.
 *
 * Отказ записи события НЕ отменяет саму запись поля: поток — это уведомление, а
 * источник состояния REST (§3.8). Обратный порядок означал бы, что прочитанный
 * месяц не сохраняется из-за неработающего оповещения.
 */
async function announceFolderCardChange(
  db: Database,
  folderId: string,
  field: 'period' | 'contractor',
): Promise<void> {
  try {
    await appendFolderEvent(db, { folderId, eventType: 'folder.updated', payload: { field } });
  } catch {
    // Молча: писать сюда в журнал нечем — у репозитория нет логгера, а
    // вызывающая задача уже пишет свой исход.
  }
}

/**
 * Записать исполнителя, прочитанного из акта (S37).
 *
 * Пара к `fillFolderPeriodIfEmpty`: тот же вызывающий (конвейер, задача
 * `doc.extract_fields`), та же область — без неё, потому что пишет не человек,
 * — и та же идемпотентность условием В САМОМ операторе, а не договорённостью с
 * вызывающим.
 *
 * ## Что именно ограничивает замену
 *
 * `contractor_assumed` — главное условие: заменяется только ПОДСТАВЛЕННОЕ
 * порталом значение. Названное человеком портал не переписывает никогда, даже
 * если акт говорит другое, — расхождение в этом случае выносит замечанием
 * `AOSR.HDR.023`, и решает человек.
 *
 * ## Почему нужна отсрочка ключей
 *
 * `contractor_id` денормализован вниз по дереву составными ключами, и все они
 * `NOT DEFERRABLE` до миграции 0054. Порядка, в котором `UPDATE` проходит, не
 * существует: папка первой — отказ от документов, документы первыми — отказ от
 * папки. `SET CONSTRAINTS ... DEFERRED` переносит проверку на коммит, НЕ отменяя
 * её: оборванная ссылка внутри транзакции всё равно не доживёт до конца. Ключи
 * перечислены поимённо, а не `ALL`: отсрочить то, о чём никто не думал, — это
 * уже другое решение.
 *
 * Возвращает `true`, если исполнитель был записан именно этим вызовом.
 */
export async function replaceAssumedContractor(
  db: Database,
  folderId: string,
  contractorId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      set constraints logical_documents_scope_fk, findings_scope_fk deferred
    `);

    const updated = await tx.execute<{ id: string }>(sql`
      update folders f
         set contractor_id = ${contractorId}::uuid,
             contractor_assumed = false,
             contractor_raw = null,
             updated_at = now()
       where f.contractor_assumed
         and f.id = ${folderId}::uuid
      returning f.id
    `);

    if (updated.rows[0] === undefined) return false;

    // Денормализованные копии — тем же значением и в той же транзакции. Каждая
    // из них закрыта своим составным ключом, и вне отсрочки ни один порядок
    // этих операторов не прошёл бы.
    await tx.execute(sql`
      update logical_documents set contractor_id = ${contractorId}::uuid
       where folder_id = ${folderId}::uuid
    `);
    await tx.execute(sql`
      update findings set contractor_id = ${contractorId}::uuid
       where folder_id = ${folderId}::uuid
    `);

    // Событие пишется В ТОЙ ЖЕ транзакции: откат замены обязан унести и
    // сообщение о ней, иначе экран узнал бы об исполнителе, которого нет.
    await appendFolderEvent(tx, {
      folderId,
      eventType: 'folder.updated',
      payload: { field: 'contractor' },
    });

    return true;
  });
}

/**
 * Запомнить наименование исполнителя, которое не удалось сопоставить.
 *
 * Не отказ и не пустота: организация ПРОЧИТАНА, но закрепить её за объектом
 * может только человек — автозакрепление было бы утверждением о стройке,
 * которого никто не делал. Экран печатает это наименование вместо «После OCR»,
 * то есть говорит, чего именно не хватает.
 *
 * Условие то же, что у замены: подставленное значение ещё не заменено человеком.
 */
export async function rememberContractorRaw(
  db: Database,
  folderId: string,
  raw: string,
): Promise<boolean> {
  const updated = await db.execute<{ id: string }>(sql`
    update folders f
       set contractor_raw = ${raw}, updated_at = now()
     where f.contractor_assumed
       and f.id = ${folderId}::uuid
       and f.contractor_raw is distinct from ${raw}
    returning f.id
  `);
  return updated.rows.length > 0;
}

export async function findFolder(
  db: Database,
  scope: AuthScope,
  workId: string,
): Promise<Folder | null> {
  const rows = await db
    .select(FOLDER_SELECTION)
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, workId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : row;
}

export interface CreateFolderInput {
  readonly objectId: string;
  readonly sectionCode: string;
  /**
   * Месяц комплекта. Задаётся только там, где он ИЗВЕСТЕН независимо от
   * распознавания, — у файла описи он наследуется от реестра. Обычный комплект
   * заводится без месяца: его выведет конвейер по самому раннему акту (S30).
   */
  readonly period?: string | undefined;
  readonly title: string;
  /** Исполнитель. Задаётся только генподрядчиком (см. `resolveActingContractor`). */
  readonly contractorId?: string | null | undefined;
}

export interface CreatedFolder {
  readonly folder: Folder;
}

/**
 * Заведение ПАПКИ — одной записью (S44).
 *
 * До S44 здесь заводилась пара «комплект + первая ревизия» одной транзакцией:
 * комплект без ревизии был карточкой, в которую некуда загружать файлы. Теперь
 * уровня ревизии нет вовсе, папка сама держит файлы, страницы и разметку, и
 * заводить рядом с ней нечего.
 *
 * Включённость раздела здесь не проверяется чтением: её держит составной ключ
 * `folders_section_fk`, а `guardNavigation` переводит его отказ в 422 с
 * указателем на поле. Проверка чтением была бы второй копией правила и
 * разошлась бы с ключом при первой же гонке.
 *
 * Закрепление подрядчика не проверяется вовсе: ключа больше нет (0055).
 */
export async function createFolder(
  db: Database,
  scope: AuthScope,
  input: CreateFolderInput,
  actor: AuditActor,
): Promise<CreatedFolder> {
  // Объект проверяется ПЕРВЫМ, и порядок значим: «такого объекта нет» — ответ
  // сильнее, чем «исполнителя не из чего вывести». Иначе несуществующий объект
  // получал бы 422 про закрепление подрядчиков, то есть подтверждал бы, что
  // объект существует и дело только в его настройке.
  await requireVisibleObject(db, scope, input.objectId);

  const acting = resolveActingContractor(
    scope,
    input.contractorId,
    // Вывод считается ТОЛЬКО когда исполнитель не назван: лишний запрос на
    // каждое заведение комплекта не нужен, а порядок предпочтения от него не
    // зависит.
    input.contractorId === undefined || input.contractorId === null
      ? await deriveObjectContractor(db, input.objectId)
      : null,
  );

  return guardNavigation(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(folders)
        .values({
          objectId: input.objectId,
          sectionCode: input.sectionCode,
          period: input.period ?? null,
          contractorId: acting.contractorId,
          contractorAssumed: acting.assumed,
          managedByContractorId: acting.managedByContractorId,
          title: input.title,
          createdBy: scope.userId,
        })
        .returning(FOLDER_SELECTION);

      const folder = inserted[0];
      if (folder === undefined) throw conflict('Папка не создана: повторите действие.');

      await appendFolderEvent(tx, {
        folderId: folder.id,
        eventType: 'folder.created',
        payload: { title: folder.title },
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'folder.created',
        entityType: 'folder',
        entityId: folder.id,
        objectId: folder.objectId,
        payload: {
          sectionCode: folder.sectionCode,
          period: folder.period,
          title: folder.title,
          contractorId: folder.contractorId,
          // Заведение за другую организацию обязано быть видно в журнале: это
          // единственный путь, которым в портале появляется работа, поданная не
          // тем, кто её выполнил.
          onBehalfOf: acting.onBehalfOf,
        },
      });

      return { folder };
    }),
  );
}

/**
 * Проставить месяц комплекта, если портал его ещё не знает (S30).
 *
 * Зовёт конвейер после извлечения реквизитов: месяц выводится по самому раннему
 * распознанному акту (`periodOfEarliestAct`), а не называется человеком.
 *
 * ## Почему отдельно от `updateFolder`
 *
 * Та правит КАРТОЧКУ и требует `requireManagedByActor` — правку состава ведёт
 * организация-владелец. Здесь пишет конвейер, у которого организации нет, и
 * проверять его правами человека было бы подлогом: месяц не решение
 * пользователя, а прочитанный факт.
 *
 * ## Почему `AND period IS NULL`
 *
 * Повтор задачи обязан быть безопасен (§12, at-least-once). Без этого условия
 * повторное извлечение реквизитов переписывало бы месяц каждый раз, а после
 * пересегментации — ещё и другим значением. Условие делает запись
 * одноразовой по факту, а не по договорённости с вызывающим.
 *
 * Возвращает `true`, если месяц был записан именно этим вызовом.
 */
export async function fillFolderPeriodIfEmpty(
  db: Database,
  folderId: string,
  period: string,
): Promise<boolean> {
  const updated = await db
    .update(folders)
    .set({ period, updatedAt: sql`now()` })
    .where(and(isNull(folders.period), eq(folders.id, folderId)))
    .returning({ id: folders.id });
  if (updated.length === 0) return false;

  await announceFolderCardChange(db, folderId, 'period');
  return true;
}

export interface UpdateFolderPatch {
  readonly title?: string | undefined;
  readonly autoRunEnabled?: boolean | undefined;
}

/** Правка карточки комплекта. Состав, раздел и месяц здесь не меняются. */
export async function updateFolder(
  db: Database,
  scope: AuthScope,
  workId: string,
  patch: UpdateFolderPatch,
  actor: AuditActor,
): Promise<Folder | null> {
  const work = await findFolder(db, scope, workId);
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
        .update(folders)
        .set({ ...fields, updatedAt: sql`now()` })
        .where(eq(folders.id, workId));

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

  return findFolder(db, scope, workId);
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
export interface FolderDeletionPreview {
  readonly folderId: string;
  readonly title: string;
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

export async function previewFolderDeletion(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<FolderDeletionPreview | null> {
  const folder = await findFolder(db, scope, folderId);
  if (folder === null) return null;

  const counts = await db.execute<{
    files: number;
    pages: number;
    blocks: number;
    documents: number;
    findings: number;
  }>(sql`
    select
      (select count(*) from source_files where folder_id = ${folderId}::uuid)::int as files,
      (select count(*) from source_pages where folder_id = ${folderId}::uuid)::int as pages,
      (select count(*) from layout_blocks where folder_id = ${folderId}::uuid)::int as blocks,
      (select count(*) from logical_documents
        where folder_id = ${folderId}::uuid)::int as documents,
      (select count(*) from findings where folder_id = ${folderId}::uuid)::int as findings
  `);

  const row = counts.rows[0];
  return {
    folderId,
    title: folder.title,
    files: row?.files ?? 0,
    pages: row?.pages ?? 0,
    layoutBlocks: row?.blocks ?? 0,
    documents: row?.documents ?? 0,
    findings: row?.findings ?? 0,
    // Помех удалению больше нет: все четыре держались на согласовании и
    // неизменяемости, снятых в S44.
    blockers: [],
  };
}

/**
 * Удалить папку со всем её содержимым.
 *
 * `null` — папки нет или она вне области видимости; различать их снаружи нельзя
 * (§1.6), и маршрут отвечает на оба случая одинаково.
 *
 * Право на это действие — `settings.manage`, то есть администратор, а не
 * `submission.upload`: загрузить свою папку и стереть чужую работу вместе с
 * историей проверок — разные по весу действия, и первое не должно давать
 * второго.
 *
 * Помех удалению больше нет ни одной. Прежние четыре держались на согласовании
 * (согласованная ревизия, переданный реестр, юридический запрет) и на
 * неизменяемости §3.9 — всё это снято в S44. Осталась одна честная проверка:
 * папка должна быть видна вызывающему.
 */
export async function deleteFolder(
  db: Database,
  scope: AuthScope,
  folderId: string,
  actor: AuditActor,
): Promise<{ readonly deleted: boolean; readonly blockers: readonly string[] } | null> {
  const rows = await db
    .select({
      id: folders.id,
      objectId: folders.objectId,
      title: folders.title,
      period: folders.period,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
    .limit(1);

  const folder = rows[0];
  if (folder === undefined) return null;

  await guardNavigation(() =>
    db.transaction(async (tx) => {
      await purgeFolderEntirely(tx, folderId);

      // Название и месяц попадают в след: после удаления карточки узнать, что
      // именно исчезло, будет неоткуда.
      await appendAudit(tx, scope, {
        ...actor,
        action: 'folder.deleted',
        entityType: 'folder',
        entityId: folderId,
        objectId: folder.objectId,
        payload: { title: folder.title, period: folder.period },
      });
    }),
  );

  return { deleted: true, blockers: [] };
}

// =====================================================================
// Отказы базы
// =====================================================================

/**
 * Отказ ограничения БД → внятный ответ вместо 500.
 *
 * Список инвариантов, за которые отвечает БД, короток и назван поимённо, всё
 * остальное поднимается как есть — молчаливое проглатывание неизвестного кода
 * скрыло бы настоящий дефект.
 *
 * Составной ключ `folders_section_fk` переводится в 422 с указателем на поле, а
 * не в общий 409: «раздел не включён на объекте» — это ответ администратору о
 * том, что настроить, и выразить его обязан текст, а не код состояния.
 *
 * Веток `works_contractor_fk` и реестров здесь больше нет: первый ключ снят
 * (0055), реестры — вместе с согласованием (S44). Перевод несуществующего
 * ограничения однажды объяснил бы отказ причиной, которой в схеме нет.
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

    if (constraint === 'folders_section_fk') {
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
    if (sqlState === '23505') {
      throw conflict('Такая запись в портале уже есть.', {
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
