/**
 * Навигация ИД: тома → поставки → ревизии (§3, §14).
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
 * | `GET /api/v1/volumes` | `objectId`, `sectionId`, `isActive`, `search` |
 * | `GET /api/v1/volumes/{volumeId}` | — |
 * | `GET /api/v1/submissions` | `volumeId`, `objectId`, `search` |
 * | `GET /api/v1/submissions/{submissionId}` | — |
 * | `POST /api/v1/submissions` | создаёт поставку и первую ревизию |
 * | `GET /api/v1/submissions/{id}/revisions` | — |
 * | `POST /api/v1/submissions/{id}/revisions` | — |
 *
 * Расхождение исправлено здесь, а не в API: сервер — источник правды, и «том
 * объекта» отличается от «все мои тома» одним условием, а не вторым маршрутом
 * с собственной областью видимости.
 *
 * ## Страница — конверт с курсором, а не массив
 *
 * Все списки отвечают `{ items, nextCursor }`. Клиент, читающий только `items`,
 * молча показывал бы первые 50 строк как «все»: том с сотней поставок выглядел
 * бы законченным. Поэтому курсор здесь часть типа, а экраны обязаны его
 * дочитывать.
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
 *   семь маршрутов на месте, и ветка не срабатывает; она остаётся рубежом на
 *   случай отката или опечатки в пути — молчаливо выродиться в «пусто» она уже
 *   не может.
 * * `forbidden` — маршрут есть, права нет (403). Это НЕ пустой список: §1.6
 *   запрещает различать «нет такого» и «не ваше» по идентификатору, но не
 *   запрещает сказать пользователю, что раздел ему не по правам.
 *
 * Отдельно: 404 на конкретном идентификаторе (том, поставка) — обычная ошибка,
 * и она проходит наверх как есть. Чужое и несуществующее неразличимы по
 * построению сервера, и клиент не пытается их разделить.
 */
import { isApiError } from './problem.js';
import { get, request } from './http.js';

/** Дословно из `app.setNotFoundHandler` в `apps/api/src/app.ts`. */
const ROUTE_MISSING_DETAIL = 'Маршрут не найден.';

const V1 = '/api/v1';

/** Размер страницы: не больше `MAX_PAGE_LIMIT` из `@id/contracts`. */
export const PAGE_LIMIT = 50;

export interface Volume {
  id: string;
  objectId: string;
  sectionId: string;
  code: string;
  name: string;
  isActive: boolean;
  autoRunEnabled: boolean;
  createdAt: string;
}

export interface Submission {
  id: string;
  volumeId: string;
  objectId: string;
  contractorId: string;
  number: string | null;
  title: string;
  currentRevisionId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface SubmissionRevisionSummary {
  id: string;
  submissionId: string;
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
  volumes: `${V1}/volumes`,
  volume: (volumeId: string) => `${V1}/volumes/${volumeId}`,
  submissions: `${V1}/submissions`,
  revisionsOfSubmission: (submissionId: string) => `${V1}/submissions/${submissionId}/revisions`,
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
// Тома
// =====================================================================

export interface VolumeFilter {
  readonly objectId?: string | undefined;
  readonly sectionId?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly search?: string | undefined;
  readonly cursor?: string | null | undefined;
}

export async function listVolumes(
  filter: VolumeFilter = {},
): Promise<NavigationResult<CursorPage<Volume>>> {
  return loadNavigation(NAVIGATION_ROUTES.volumes, () =>
    get<CursorPage<Volume>>(NAVIGATION_ROUTES.volumes, {
      query: pageQuery(filter.cursor, {
        ...(filter.objectId === undefined ? {} : { objectId: filter.objectId }),
        ...(filter.sectionId === undefined ? {} : { sectionId: filter.sectionId }),
        // `isActive` передаётся строкой: сервер принимает только `true` и
        // `false`, потому что `z.coerce.boolean()` считал бы истиной и «false».
        ...(filter.isActive === undefined ? {} : { isActive: filter.isActive ? 'true' : 'false' }),
        ...(filter.search === undefined || filter.search === '' ? {} : { search: filter.search }),
      }),
    }),
  );
}

export async function getVolume(volumeId: string): Promise<NavigationResult<Volume>> {
  return loadNavigation(NAVIGATION_ROUTES.volume(volumeId), () =>
    get<Volume>(NAVIGATION_ROUTES.volume(volumeId)),
  );
}

// =====================================================================
// Поставки
// =====================================================================

export interface SubmissionFilter {
  readonly volumeId?: string | undefined;
  readonly objectId?: string | undefined;
  readonly search?: string | undefined;
  readonly cursor?: string | null | undefined;
}

export async function listSubmissions(
  filter: SubmissionFilter = {},
): Promise<NavigationResult<CursorPage<Submission>>> {
  return loadNavigation(NAVIGATION_ROUTES.submissions, () =>
    get<CursorPage<Submission>>(NAVIGATION_ROUTES.submissions, {
      query: pageQuery(filter.cursor, {
        ...(filter.volumeId === undefined ? {} : { volumeId: filter.volumeId }),
        ...(filter.objectId === undefined ? {} : { objectId: filter.objectId }),
        ...(filter.search === undefined || filter.search === '' ? {} : { search: filter.search }),
      }),
    }),
  );
}

export interface CreateSubmissionInput {
  readonly volumeId: string;
  readonly title: string;
  readonly number?: string | undefined;
}

export interface CreatedSubmission {
  submission: Submission;
  revision: SubmissionRevisionSummary;
}

/**
 * Создание поставки вместе с её первой ревизией — одной транзакцией на сервере.
 *
 * `contractorId` в теле НЕТ, и добавлять его нельзя: организация берётся из
 * области видимости (`db/repositories/navigation.ts`). Поле в теле было бы
 * приглашением завести поставку от чужого имени.
 *
 * `Idempotency-Key` не передаётся: §14 требует его на дорогих действиях
 * (freeze, recognize, checks, переходы workflow), а вставка одной строки к ним
 * не относится — повтор виден в списке и правится человеком. Слать заголовок
 * там, где он ничего не защищает, значит приучать клиента к формальности.
 */
export async function createSubmission(input: CreateSubmissionInput): Promise<CreatedSubmission> {
  const response = await request<CreatedSubmission>('POST', NAVIGATION_ROUTES.submissions, {
    body: {
      volumeId: input.volumeId,
      title: input.title,
      ...(input.number === undefined || input.number === '' ? {} : { number: input.number }),
    },
  });
  return response.data;
}

// =====================================================================
// Ревизии поставки
// =====================================================================

export async function listRevisions(
  submissionId: string,
  cursor?: string | null,
): Promise<NavigationResult<CursorPage<SubmissionRevisionSummary>>> {
  const route = NAVIGATION_ROUTES.revisionsOfSubmission(submissionId);
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
export async function createRevision(submissionId: string): Promise<SubmissionRevisionSummary> {
  const response = await request<SubmissionRevisionSummary>(
    'POST',
    NAVIGATION_ROUTES.revisionsOfSubmission(submissionId),
  );
  return response.data;
}
