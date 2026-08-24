/**
 * Навигация ИД: объект → комплект → ревизия и реестры передачи (§3, §14).
 *
 * ## Пути сверены с фактическими маршрутами
 *
 * Первая редакция этого файла писалась до того, как маршруты появились в
 * `apps/api`, и содержала ОЖИДАЕМЫЙ контракт, угаданный по форме соседних
 * модулей: `/objects/{id}/volumes` и `/volumes/{id}/submissions`. Фактические
 * маршруты (`apps/api/src/modules/navigation/routes.ts`) построены иначе —
 * плоские коллекции с фильтром в строке запроса:
 *
 * | Маршрут | Фильтры |
 * |---|---|
 * | `GET /api/v1/works` | `objectId`, `sectionCode`, `period`, `unassigned`, `search` |
 * | `GET /api/v1/works/{workId}` | — |
 * | `POST /api/v1/works` | заводит комплект и первую ревизию |
 * | `GET|POST /api/v1/works/{id}/revisions` | — |
 * | `GET /api/v1/registries` | `objectId`, `sectionCode`, `period`, `status` |
 * | `GET /api/v1/registries/{id}` | состав и блокеры — по правам актора |
 * | `PUT|DELETE /api/v1/registries/{id}/works/{workId}` | состав, `If-Match` |
 * | `POST /api/v1/registries/{id}/file` | заводит комплект-файл описи |
 * | `POST /api/v1/registries/{id}/issue|accept` | передача и приёмка, `If-Match` |
 *
 * Расхождение исправлено здесь, а не в API: сервер — источник правды, и
 * «комплекты объекта» отличаются от «всех моих комплектов» одним условием, а не
 * вторым маршрутом с собственной областью видимости.
 *
 * ## Страница — конверт с курсором, а не массив
 *
 * Все списки отвечают `{ items, nextCursor }`. Клиент, читающий только `items`,
 * молча показывал бы первые 50 строк как «все»: объект с сотней комплектов
 * выглядел бы законченным. Поэтому курсор здесь часть типа, а экраны обязаны
 * его дочитывать.
 *
 * ## Недоступность обязана отличаться от пустоты
 *
 * Экран, который на отсутствующий маршрут или на отказ в правах показывает
 * пустую таблицу, выглядит работающим и когда данных нет, и когда за ним не
 * стоит ничего. Это тот же класс отказа, что «написано, но не подключено», и
 * журнал исполнения ловил его восемь этапов подряд. Поэтому чтение навигации
 * возвращает не список, а размеченное объединение: `available` со страницей
 * (пустой или нет) либо `unavailable` с НАЗВАННОЙ причиной.
 *
 * Причин ровно две, и они разные по смыслу:
 *
 * * `route-missing` — маршрута нет в API. Признак точный: 404 с `detail`,
 *   равным сообщению `setNotFoundHandler` из `apps/api/src/app.ts`. Сегодня все
 *   маршруты на месте, и ветка не срабатывает; она остаётся рубежом на случай
 *   отката или опечатки в пути — молчаливо выродиться в «пусто» она уже не
 *   может.
 * * `forbidden` — маршрут есть, права нет (403). Это НЕ пустой список: §1.6
 *   запрещает различать «нет такого» и «не ваше» по идентификатору, но не
 *   запрещает сказать пользователю, что раздел ему не по правам.
 *
 * Отдельно: 404 на конкретном идентификаторе (комплект, реестр) — обычная ошибка,
 * и она проходит наверх как есть. Чужое и несуществующее неразличимы по
 * построению сервера, и клиент не пытается их разделить.
 */
import { isApiError } from './problem.js';
import { get, newIdempotencyKey, request } from './http.js';

/** Дословно из `app.setNotFoundHandler` в `apps/api/src/app.ts`. */
const ROUTE_MISSING_DETAIL = 'Маршрут не найден.';

const V1 = '/api/v1';

/** Размер страницы: не больше `MAX_PAGE_LIMIT` из `@id/contracts`. */
export const PAGE_LIMIT = 50;

export interface Work {
  id: string;
  objectId: string;
  sectionCode: string;
  /** Месяц первым числом: `ГГГГ-ММ-01`. */
  period: string;
  /** Исполнитель работы — он печатается в реестре. */
  contractorId: string;
  /** Организация, ведущая комплект: только она правит его состав. */
  managedByContractorId: string;
  kind: 'complect' | 'registry';
  title: string;
  registryId: string | null;
  ordinal: number | null;
  autoRunEnabled: boolean;
  currentRevisionId: string | null;
  createdBy: string;
  createdAt: string;
}

export type RegistryStatus = 'draft' | 'issued' | 'accepted';

export interface Registry {
  id: string;
  objectId: string;
  sectionCode: string;
  period: string;
  number: string | null;
  folderNo: string | null;
  building: string | null;
  floor: string | null;
  structure: string | null;
  status: RegistryStatus;
  version: number;
  issuedBy: string | null;
  issuedAt: string | null;
  issuedFileRevisionId: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** Строка снимка состава переданного реестра. */
export interface RegistryItem {
  registryId: string;
  ordinal: number;
  workId: string;
  revisionId: string;
  contractorId: string;
  title: string;
}

/** Причина, по которой реестр ещё нельзя передать. */
export interface RegistryBlocker {
  code: string;
  message: string;
}

export interface SubmissionRevisionSummary {
  id: string;
  workId: string;
  revisionNo: number;
  status: string;
  parentRevisionId: string | null;
  aggregateManifestHash: string | null;
  version: number;
  createdAt: string;
  submittedAt: string | null;
  submittedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  returnReason: string | null;
}

/** Конверт курсорной страницы (`cursorPageSchema` из `@id/contracts`). */
export interface CursorPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

/**
 * Фактические пути навигации.
 *
 * Именованные константы, а не строки по месту вызова: сверка с маршрутами
 * `apps/api` — это чтение одного объекта.
 */
export const NAVIGATION_ROUTES = {
  works: `${V1}/works`,
  work: (workId: string) => `${V1}/works/${workId}`,
  sectionCounts: (objectId: string) => `${V1}/objects/${objectId}/sections/counts`,
  revisionsOfWork: (workId: string) => `${V1}/works/${workId}/revisions`,
  workDeletionPreview: (workId: string) => `${V1}/works/${workId}/deletion-preview`,
  registries: `${V1}/registries`,
  registry: (registryId: string) => `${V1}/registries/${registryId}`,
  registryWork: (registryId: string, workId: string) =>
    `${V1}/registries/${registryId}/works/${workId}`,
  registryFile: (registryId: string) => `${V1}/registries/${registryId}/file`,
  registryIssue: (registryId: string) => `${V1}/registries/${registryId}/issue`,
  registryAccept: (registryId: string) => `${V1}/registries/${registryId}/accept`,
  registryItems: (registryId: string) => `${V1}/registries/${registryId}/items`,
  registryReconcile: (registryId: string) => `${V1}/registries/${registryId}/reconcile`,
  registryReconciliation: (registryId: string) => `${V1}/registries/${registryId}/reconciliation`,
  registryReconciliationReview: (registryId: string) =>
    `${V1}/registries/${registryId}/reconciliation/review`,
  revisionReconciliation: (revisionId: string) => `${V1}/revisions/${revisionId}/reconciliation`,
} as const;

export type UnavailableReason = 'route-missing' | 'forbidden';

/** Ответ навигации: данные либо названная причина их отсутствия. */
export type NavigationResult<T> =
  | { readonly kind: 'available'; readonly data: T }
  | {
      readonly kind: 'unavailable';
      readonly route: string;
      readonly reason: UnavailableReason;
      readonly detail: string | null;
    };

/**
 * Отсутствует ли САМ маршрут (в отличие от невидимого ресурса).
 *
 * Экспортируется: то же различение нужно экранам, которые обращаются к
 * навигации не через `loadNavigation`.
 */
export function isRouteMissing(error: unknown): boolean {
  return (
    isApiError(error) && error.status === 404 && error.problem?.detail === ROUTE_MISSING_DETAIL
  );
}

function isForbidden(error: unknown): boolean {
  return isApiError(error) && error.status === 403 && error.slug !== 'csrf';
}

async function loadNavigation<T>(
  route: string,
  load: () => Promise<T>,
): Promise<NavigationResult<T>> {
  try {
    return { kind: 'available', data: await load() };
  } catch (error) {
    if (isRouteMissing(error)) {
      return { kind: 'unavailable', route, reason: 'route-missing', detail: null };
    }
    if (isForbidden(error)) {
      return {
        kind: 'unavailable',
        route,
        reason: 'forbidden',
        detail: isApiError(error) ? error.message : null,
      };
    }
    throw error;
  }
}

/**
 * Разбор накопленных страниц `useInfiniteQuery`.
 *
 * Две функции, а не одна: экран обязан различать «страниц нет, потому что
 * список пуст» и «первая же страница отказала». Свести их к одному «нет данных»
 * — это ровно тот шаг, которым пустая таблица начинает выглядеть рабочей.
 */
export function pagesItems<TItem>(
  pages: readonly NavigationResult<CursorPage<TItem>>[] | undefined,
): TItem[] {
  return (pages ?? []).flatMap((page) => (page.kind === 'available' ? page.data.items : []));
}

export function pagesBlocked<T>(
  pages: readonly NavigationResult<T>[] | undefined,
): Extract<NavigationResult<T>, { kind: 'unavailable' }> | null {
  const first = pages?.[0];
  return first !== undefined && first.kind === 'unavailable' ? first : null;
}

/** Строка запроса без пустых полей: `undefined` в `URLSearchParams` не попадает. */
type Query = Record<string, string | number | boolean | undefined>;

function pageQuery(cursor: string | null | undefined, rest: Query): Query {
  return {
    limit: PAGE_LIMIT,
    ...(cursor === null || cursor === undefined ? {} : { cursor }),
    ...rest,
  };
}

// =====================================================================
// Комплекты работ
// =====================================================================

export interface WorkFilter {
  readonly objectId?: string | undefined;
  readonly sectionCode?: string | undefined;
  /** Точный месяц. Границам не противоречит: условия независимы. */
  readonly period?: string | undefined;
  readonly periodFrom?: string | undefined;
  readonly periodTo?: string | undefined;
  readonly registryId?: string | undefined;
  readonly unassigned?: boolean | undefined;
  readonly search?: string | undefined;
  readonly cursor?: string | null | undefined;
}

export async function listWorks(
  filter: WorkFilter = {},
): Promise<NavigationResult<CursorPage<Work>>> {
  return loadNavigation(NAVIGATION_ROUTES.works, () =>
    get<CursorPage<Work>>(NAVIGATION_ROUTES.works, {
      query: pageQuery(filter.cursor, {
        ...(filter.objectId === undefined ? {} : { objectId: filter.objectId }),
        ...(filter.sectionCode === undefined ? {} : { sectionCode: filter.sectionCode }),
        ...(filter.period === undefined ? {} : { period: filter.period }),
        ...(filter.periodFrom === undefined ? {} : { periodFrom: filter.periodFrom }),
        ...(filter.periodTo === undefined ? {} : { periodTo: filter.periodTo }),
        ...(filter.registryId === undefined ? {} : { registryId: filter.registryId }),
        // Признак передаётся строкой: сервер принимает только `true` и `false`,
        // потому что `z.coerce.boolean()` считал бы истиной и «false».
        ...(filter.unassigned === undefined
          ? {}
          : { unassigned: filter.unassigned ? 'true' : 'false' }),
        ...(filter.search === undefined || filter.search === '' ? {} : { search: filter.search }),
      }),
    }),
  );
}

/** Сколько комплектов видно спрашивающему в каждом разделе объекта. */
export interface SectionWorkCount {
  readonly sectionCode: string;
  readonly works: number;
}

/**
 * Счётчики для заголовков дерева разделов.
 *
 * Фильтры передаются те же, что и в `listWorks`, и это не удобство вызывающего:
 * число над панелью обязано считать ровно то множество, которое панель покажет
 * при раскрытии. Разошлись бы они — заголовок обещал бы комплекты, которых в
 * теле нет.
 */
export async function listSectionCounts(
  objectId: string,
  filter: Omit<WorkFilter, 'objectId' | 'cursor' | 'registryId'> = {},
): Promise<NavigationResult<SectionWorkCount[]>> {
  const route = NAVIGATION_ROUTES.sectionCounts(objectId);
  return loadNavigation(route, () =>
    get<SectionWorkCount[]>(route, {
      query: {
        ...(filter.sectionCode === undefined ? {} : { sectionCode: filter.sectionCode }),
        ...(filter.period === undefined ? {} : { period: filter.period }),
        ...(filter.periodFrom === undefined ? {} : { periodFrom: filter.periodFrom }),
        ...(filter.periodTo === undefined ? {} : { periodTo: filter.periodTo }),
        ...(filter.unassigned === undefined
          ? {}
          : { unassigned: filter.unassigned ? 'true' : 'false' }),
        ...(filter.search === undefined || filter.search === '' ? {} : { search: filter.search }),
      },
    }),
  );
}

export async function getWork(workId: string): Promise<NavigationResult<Work>> {
  return loadNavigation(NAVIGATION_ROUTES.work(workId), () =>
    get<Work>(NAVIGATION_ROUTES.work(workId)),
  );
}

export interface CreateWorkInput {
  readonly objectId: string;
  readonly sectionCode: string;
  readonly period: string;
  readonly title: string;
  /** Исполнитель. Задаёт только генподрядчик; подрядчику поле запрещено. */
  readonly contractorId?: string | undefined;
}

export interface CreatedWork {
  work: Work;
  revision: SubmissionRevisionSummary;
}

/**
 * Заведение комплекта вместе с его первой ревизией — одной транзакцией.
 *
 * `contractorId` подрядчик не передаёт: исполнитель берётся из его области
 * видимости, и поле в теле было бы приглашением завести работу от чужого имени.
 * Генподрядчику оно, наоборот, необходимо — субподрядчики учётных записей не
 * имеют, и ПТО собирает их комплекты само.
 *
 * `Idempotency-Key` не передаётся: §14 требует его на дорогих действиях
 * (freeze, recognize, checks, переходы workflow), а вставка одной строки к ним
 * не относится — повтор виден в списке и правится человеком.
 */
export async function createWork(input: CreateWorkInput): Promise<CreatedWork> {
  const response = await request<CreatedWork>('POST', NAVIGATION_ROUTES.works, {
    body: {
      objectId: input.objectId,
      sectionCode: input.sectionCode,
      period: input.period,
      title: input.title,
      ...(input.contractorId === undefined ? {} : { contractorId: input.contractorId }),
    },
  });
  return response.data;
}

/**
 * Что исчезнет вместе с комплектом.
 *
 * Спрашивается ПЕРЕД показом подтверждения, а не считается на клиенте: экран
 * объекта не держит ни блоков разметки, ни замечаний, и посчитать их ему нечем.
 * `blockers` тот же список, которым ответит отказ, — препятствия показываются до
 * нажатия, а не выясняются им.
 */
export interface WorkDeletionPreview {
  workId: string;
  title: string;
  revisions: number;
  files: number;
  pages: number;
  layoutBlocks: number;
  documents: number;
  findings: number;
  blockers: string[];
}

export async function getWorkDeletionPreview(workId: string): Promise<WorkDeletionPreview> {
  return get<WorkDeletionPreview>(NAVIGATION_ROUTES.workDeletionPreview(workId));
}

/**
 * Удаление комплекта со всем содержимым.
 *
 * Право — `settings.manage` (администратор). Сервер отвергает удаление 409 с
 * перечислением помех, если у комплекта есть согласованная ревизия, он включён в
 * переданный реестр или на ревизию наложен юридический запрет: это уже ушло
 * наружу и перестало быть внутренним делом портала.
 */
export async function deleteWork(workId: string): Promise<void> {
  await request<void>('DELETE', NAVIGATION_ROUTES.work(workId));
}

// =====================================================================
// Ревизии комплекта
// =====================================================================

export async function listRevisions(
  workId: string,
  cursor?: string | null,
): Promise<NavigationResult<CursorPage<SubmissionRevisionSummary>>> {
  const route = NAVIGATION_ROUTES.revisionsOfWork(workId);
  return loadNavigation(route, () =>
    get<CursorPage<SubmissionRevisionSummary>>(route, { query: pageQuery(cursor, {}) }),
  );
}

/**
 * Ручное открытие следующей ревизии.
 *
 * Разрешено сервером ровно там, где возврат уже отработал или не мог отработать
 * вовсе: `approved`, `superseded` и «ревизий нет». Открытый черновик, ожидание
 * решения и уже отработавший возврат дают 409 с внятным текстом — экран
 * показывает этот текст, а не прячет кнопку по собственной догадке о состоянии.
 */
export async function createRevision(workId: string): Promise<SubmissionRevisionSummary> {
  const response = await request<SubmissionRevisionSummary>(
    'POST',
    NAVIGATION_ROUTES.revisionsOfWork(workId),
  );
  return response.data;
}

// =====================================================================
// Реестры передачи
// =====================================================================

export interface RegistryFilter {
  readonly objectId?: string | undefined;
  readonly sectionCode?: string | undefined;
  readonly period?: string | undefined;
  readonly status?: RegistryStatus | undefined;
  readonly cursor?: string | null | undefined;
}

export async function listRegistries(
  filter: RegistryFilter = {},
): Promise<NavigationResult<CursorPage<Registry>>> {
  return loadNavigation(NAVIGATION_ROUTES.registries, () =>
    get<CursorPage<Registry>>(NAVIGATION_ROUTES.registries, {
      query: pageQuery(filter.cursor, {
        ...(filter.objectId === undefined ? {} : { objectId: filter.objectId }),
        ...(filter.sectionCode === undefined ? {} : { sectionCode: filter.sectionCode }),
        ...(filter.period === undefined ? {} : { period: filter.period }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      }),
    }),
  );
}

/**
 * Карточка реестра.
 *
 * `works`, `file` и `blockers` необязательны, и это часть контракта: подрядчику
 * сервер их не отдаёт вовсе. Нулевой счётчик вместо отсутствия был бы ответом на
 * вопрос «сколько работ у соседей», а не умолчанием.
 */
export interface RegistryView {
  registry: Registry;
  works?: Work[];
  file?: Work | null;
  blockers?: RegistryBlocker[];
  /**
   * Сводка сверки описи. Того же класса, что `works`: подрядчику не отдаётся
   * вовсе, потому что относится к папке целиком. Свои расхождения он читает на
   * экране СВОЕГО комплекта.
   */
  reconciliation?: RegistryReconciliation | null;
}

export async function getRegistry(registryId: string): Promise<NavigationResult<RegistryView>> {
  const route = NAVIGATION_ROUTES.registry(registryId);
  return loadNavigation(route, () => get<RegistryView>(route));
}

export interface CreateRegistryInput {
  readonly objectId: string;
  readonly sectionCode: string;
  readonly period: string;
  readonly number?: string | undefined;
  readonly folderNo?: string | undefined;
  readonly building?: string | undefined;
}

export async function createRegistry(input: CreateRegistryInput): Promise<Registry> {
  const response = await request<Registry>('POST', NAVIGATION_ROUTES.registries, {
    body: {
      objectId: input.objectId,
      sectionCode: input.sectionCode,
      period: input.period,
      ...(input.number === undefined || input.number === '' ? {} : { number: input.number }),
      ...(input.folderNo === undefined || input.folderNo === ''
        ? {}
        : { folderNo: input.folderNo }),
      ...(input.building === undefined || input.building === ''
        ? {}
        : { building: input.building }),
    },
  });
  return response.data;
}

/**
 * Версия реестра в `If-Match` на каждом изменении состава.
 *
 * Реестр собирают минутами, а передают одним нажатием: без версии второй
 * сотрудник ПТО молча затёр бы состав, собранный первым, и подпись оказалась бы
 * под тем, чего никто не видел.
 */
function ifMatch(version: number): Record<string, string> {
  return { 'if-match': `"${String(version)}"` };
}

export async function updateRegistry(
  registryId: string,
  version: number,
  patch: Record<string, string | null>,
): Promise<Registry> {
  const response = await request<Registry>('PATCH', NAVIGATION_ROUTES.registry(registryId), {
    headers: ifMatch(version),
    body: patch,
  });
  return response.data;
}

export async function includeWork(
  registryId: string,
  workId: string,
  version: number,
): Promise<Registry> {
  const response = await request<Registry>(
    'PUT',
    NAVIGATION_ROUTES.registryWork(registryId, workId),
    { headers: ifMatch(version), body: {} },
  );
  return response.data;
}

export async function excludeWork(
  registryId: string,
  workId: string,
  version: number,
): Promise<Registry> {
  const response = await request<Registry>(
    'DELETE',
    NAVIGATION_ROUTES.registryWork(registryId, workId),
    { headers: ifMatch(version) },
  );
  return response.data;
}

/** Заведение файла описи: сам скан грузится обычным приёмом на его ревизию. */
export async function attachRegistryFile(registryId: string): Promise<CreatedWork> {
  const response = await request<CreatedWork>('POST', NAVIGATION_ROUTES.registryFile(registryId));
  return response.data;
}

export async function issueRegistry(registryId: string, version: number): Promise<Registry> {
  const response = await request<Registry>('POST', NAVIGATION_ROUTES.registryIssue(registryId), {
    headers: ifMatch(version),
  });
  return response.data;
}

export async function acceptRegistry(registryId: string, version: number): Promise<Registry> {
  const response = await request<Registry>('POST', NAVIGATION_ROUTES.registryAccept(registryId), {
    headers: ifMatch(version),
  });
  return response.data;
}

/**
 * Снимок состава переданного реестра.
 *
 * Отдаётся массивом, а не курсорной страницей: состав описи — это то, что
 * поместилось в подписанную бумагу, и он конечен по построению.
 */
export async function listRegistryItems(registryId: string): Promise<RegistryItem[]> {
  return get<RegistryItem[]>(NAVIGATION_ROUTES.registryItems(registryId));
}

// =====================================================================
// Сверка описи передачи (S20)
// =====================================================================

export type ReconciliationVerdict = 'unparsed' | 'mismatch' | 'clean';
export type ReconciliationMatchState = 'matched' | 'missing' | 'ambiguous';

/** Комплект папки со своим вердиктом: единица выдачи подрядчику и инженеру. */
export interface ReconciliationWork {
  workId: string;
  matchedRevisionId: string | null;
  contractorId: string;
  title: string;
  contractorName: string | null;
  state: 'matched' | 'extra';
  verdict: ReconciliationVerdict;
  rowsTotal: number;
  rowsMatched: number;
  rowsMissing: number;
  rowsAmbiguous: number;
  rowsFieldMismatch: number;
  extraDocuments: number;
}

export interface ReconciliationGroup {
  ordinal: number;
  groupNo: string | null;
  titleRaw: string;
  actNoRaw: string | null;
  actNoNorm: string | null;
  contractorRaw: string | null;
  matchedWorkId: string | null;
  matchedRevisionId: string | null;
  matchedContractorId: string | null;
  matchState: ReconciliationMatchState;
  matchScore: number | null;
  reason: string;
}

export interface ReconciliationRow {
  ordinal: number;
  groupOrdinal: number;
  workId: string | null;
  contractorId: string | null;
  rowNo: string | null;
  docNameRaw: string;
  docNoRaw: string | null;
  docNoNorm: string | null;
  orgRaw: string | null;
  issuedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  sheets: number | null;
  copies: number | null;
  pagesRaw: string | null;
  matchedDocumentId: string | null;
  matchState: ReconciliationMatchState;
  matchScore: number | null;
  fieldMismatches: string[];
  reason: string;
}

export interface ReconciliationExtraDocument {
  documentId: string;
  workId: string;
  revisionId: string;
  contractorId: string;
  docNoRaw: string | null;
  docNameRaw: string | null;
  docTypeCode: string | null;
}

export interface RegistryReconciliation {
  id: string;
  registryId: string;
  revisionId: string;
  verdict: ReconciliationVerdict;
  version: number;
  headerRegistryNo: string | null;
  headerFolderNo: string | null;
  headerMismatch: boolean;
  parserVersion: string;
  matcherVersion: string;
  finishedAt: string;
  groupsTotal: number;
  groupsMatched: number;
  groupsMissing: number;
  groupsAmbiguous: number;
  rowsTotal: number;
  rowsMatched: number;
  rowsMissing: number;
  rowsAmbiguous: number;
  rowsFieldMismatch: number;
  worksTotal: number;
  worksExtra: number;
  extraDocuments: number;
  warnings: string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewedNote: string | null;
}

/** Сводка по ПАПКЕ: отдаётся только тому, кто её ведёт. */
export interface RegistryReconciliationView {
  reconciliation: RegistryReconciliation | null;
  works?: ReconciliationWork[];
  groups?: ReconciliationGroup[];
  rows?: ReconciliationRow[];
  extraDocuments?: ReconciliationExtraDocument[];
}

/**
 * Результат по ОДНОМУ комплекту.
 *
 * Полей о папке в этом типе нет — ни шапки описи, ни групп, ни чужих
 * комплектов, ни общих счётчиков. Их нет и в ответе сервера: разделение
 * выражено типом, а не условием на экране.
 */
export interface WorkReconciliationView {
  work: ReconciliationWork | null;
  rows: ReconciliationRow[];
  extraDocuments: ReconciliationExtraDocument[];
  parserVersion: string | null;
  finishedAt: string | null;
}

/**
 * Постановка сверки.
 *
 * `Idempotency-Key` обязателен: сверка читает документы всей папки. В ключ
 * дедупликации очереди он не входит — второе нажатие получает уже стоящую
 * задачу, а не заводит вторую по той же папке.
 */
export async function reconcileRegistry(
  registryId: string,
): Promise<{ jobId: string; created: boolean }> {
  const response = await request<{ jobId: string; created: boolean }>(
    'POST',
    NAVIGATION_ROUTES.registryReconcile(registryId),
    { idempotencyKey: newIdempotencyKey('reconcile') },
  );
  return response.data;
}

export async function getRegistryReconciliation(
  registryId: string,
): Promise<NavigationResult<RegistryReconciliationView>> {
  const route = NAVIGATION_ROUTES.registryReconciliation(registryId);
  return loadNavigation(route, () => get<RegistryReconciliationView>(route));
}

export async function getWorkReconciliation(revisionId: string): Promise<WorkReconciliationView> {
  return get<WorkReconciliationView>(NAVIGATION_ROUTES.revisionReconciliation(revisionId));
}

export async function reviewReconciliation(
  registryId: string,
  version: number,
  note: string,
): Promise<RegistryReconciliation> {
  const response = await request<RegistryReconciliation>(
    'POST',
    NAVIGATION_ROUTES.registryReconciliationReview(registryId),
    { headers: ifMatch(version), body: { note } },
  );
  return response.data;
}
