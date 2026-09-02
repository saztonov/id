/**
 * Навигация ИД: объект → раздел → папка (§3, §14).
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
 * | `GET /api/v1/folders` | `objectId`, `sectionCode`, `period`, `search` |
 * | `GET /api/v1/folders/{folderId}` | — |
 * | `POST /api/v1/folders` | заводит папку |
 * | `PATCH|DELETE /api/v1/folders/{folderId}` | правка и удаление, `If-Match` |
 * | `GET /api/v1/objects/{objectId}/folders/pipeline` | ход конвейера по папкам |
 * | `GET /api/v1/folders/{folderId}/deletion-preview` | что снесётся вместе с папкой |
 *
 * Расхождение исправлено здесь, а не в API: сервер — источник правды, и
 * «комплекты объекта» отличаются от «всех моих комплектов» одним условием, а не
 * вторым маршрутом с собственной областью видимости.
 *
 * ## Имена в этом файле отстают от адресов (S44 → S45)
 *
 * S44 схлопнул ревизию и комплект в ПАПКУ, и API переехал с `/works` на
 * `/folders`. В клиенте тогда переименовали ключи и типы, а строки адресов
 * остались прежними — и экран объекта на бою получил 404 на каждый список
 * комплектов. Адреса восстановлены в S45; часть внутренних имён (`Work`,
 * `works`, `workId`) ещё говорит на прежнем языке, и это осознанный долг:
 * переименование сущности во фронте — отдельная работа, а адреса обязаны быть
 * верными сегодня.
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
 *   равным сообщению `setNotFoundHandler` из `apps/api/src/app.ts`. Ветка не
 *   теоретическая: в S44 адреса клиента разошлись с маршрутами, и она честно
 *   показала «раздел недоступен» вместо пустой таблицы. Обратная сторона
 *   выяснилась там же — отказ выглядел настолько штатно, что о нём узнали от
 *   пользователя, а не от мониторинга; поэтому теперь адреса ещё и сверяются
 *   тестом (`packages/contracts/src/routes.ts`).
 * * `forbidden` — маршрут есть, права нет (403). Это НЕ пустой список: §1.6
 *   запрещает различать «нет такого» и «не ваше» по идентификатору, но не
 *   запрещает сказать пользователю, что раздел ему не по правам.
 *
 * Отдельно: 404 на конкретном идентификаторе (папка) — обычная ошибка,
 * и она проходит наверх как есть. Чужое и несуществующее неразличимы по
 * построению сервера, и клиент не пытается их разделить.
 */
import type { ProcessingStage } from '@id/contracts';
import { isApiError } from './problem.js';
import { get, request } from './http.js';

/** Дословно из `app.setNotFoundHandler` в `apps/api/src/app.ts`. */
const ROUTE_MISSING_DETAIL = 'Маршрут не найден.';

const V1 = '/api/v1';

/** Размер страницы: не больше `MAX_PAGE_LIMIT` из `@id/contracts`. */
export const PAGE_LIMIT = 50;

export interface Work {
  id: string;
  objectId: string;
  sectionCode: string;
  /** Месяц первым числом; `null` — портал ещё не прочитал акт (S30). */
  period: string | null;
  /** Исполнитель работы: он же печатается в бумагах комплекта. */
  contractorId: string;
  /**
   * Исполнитель подставлен ПОРТАЛОМ, а не назван человеком (S37).
   *
   * Пока признак поднят, экран печатает не имя организации, а надпись — ту же,
   * что и у неизвестного месяца. Показать догадку именем значило бы выдать её
   * за прочитанный факт.
   */
  contractorAssumed: boolean;
  /** Наименование из акта, которого нет в справочнике контрагентов. */
  contractorRaw: string | null;
  /**
   * Наименование исполнителя из справочника.
   *
   * Приходит вместе с комплектом, а не ищется по закреплённым за объектом
   * организациям: закрепление перестало быть условием заведения (S39), и у
   * незакреплённого исполнителя поиск давал бы прочерк.
   */
  contractorName: string;
  /** Организация, ведущая комплект: только она правит его состав. */
  managedByContractorId: string;
  title: string;
  /** Порядок папки в разделе — тот же, что в бумаге. */
  ordinal: number | null;
  autoRunEnabled: boolean;
  /** Хэш состава: им сверяется переиспользование прогонов распознавания. */
  aggregateManifestHash: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
}

export interface FolderSummary {
  id: string;
  workId: string;
  revisionNo: number;
  status: string;
  parentFolderId: string | null;
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
  works: `${V1}/folders`,
  work: (folderId: string) => `${V1}/folders/${folderId}`,
  sectionCounts: (objectId: string) => `${V1}/objects/${objectId}/sections/counts`,
  foldersPipeline: (objectId: string) => `${V1}/objects/${objectId}/folders/pipeline`,
  folderDeletionPreview: (folderId: string) => `${V1}/folders/${folderId}/deletion-preview`,
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
  /** Пускать в отбор по месяцу комплекты, месяц которых ещё не определён. */
  readonly includeUndatedPeriod?: boolean | undefined;
  readonly registryId?: string | undefined;
  readonly unassigned?: boolean | undefined;
  readonly search?: string | undefined;
  readonly cursor?: string | null | undefined;
}

export async function listFolders(
  filter: WorkFilter = {},
): Promise<NavigationResult<CursorPage<Work>>> {
  return loadNavigation(NAVIGATION_ROUTES.works, () =>
    get<CursorPage<Work>>(NAVIGATION_ROUTES.works, {
      query: pageQuery(filter.cursor, {
        ...(filter.objectId === undefined ? {} : { objectId: filter.objectId }),
        ...(filter.sectionCode === undefined ? {} : { sectionCode: filter.sectionCode }),
        ...(filter.period === undefined ? {} : { period: filter.period }),
        ...(filter.includeUndatedPeriod === true ? { includeUndatedPeriod: 'true' } : {}),
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
export interface SectionFolderCount {
  readonly sectionCode: string;
  /**
   * Сколько папок в разделе.
   *
   * Имя поля — из ответа сервера (`sectionCountsSchema`). До S45 здесь стояло
   * `works`, которого сервер после S44 не отдаёт: заголовок раздела читал
   * `undefined` и печатал «комплектов 0» над непустым списком.
   */
  readonly folders: number;
}

/**
 * Счётчики для заголовков дерева разделов.
 *
 * Фильтры передаются те же, что и в `listFolders`, и это не удобство вызывающего:
 * число над панелью обязано считать ровно то множество, которое панель покажет
 * при раскрытии. Разошлись бы они — заголовок обещал бы комплекты, которых в
 * теле нет.
 */
export async function listSectionCounts(
  objectId: string,
  filter: Omit<WorkFilter, 'objectId' | 'cursor' | 'registryId'> = {},
): Promise<NavigationResult<SectionFolderCount[]>> {
  const route = NAVIGATION_ROUTES.sectionCounts(objectId);
  return loadNavigation(route, () =>
    get<SectionFolderCount[]>(route, {
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

export async function getFolder(workId: string): Promise<NavigationResult<Work>> {
  return loadNavigation(NAVIGATION_ROUTES.work(workId), () =>
    get<Work>(NAVIGATION_ROUTES.work(workId)),
  );
}

export interface CreateFolderInput {
  readonly objectId: string;
  readonly sectionCode: string;
  readonly title: string;
  /** Исполнитель. Задаёт только генподрядчик; подрядчику поле запрещено. */
  readonly contractorId?: string | undefined;
}

export interface CreatedFolder {
  work: Work;
  folder: FolderSummary;
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
export async function createFolder(input: CreateFolderInput): Promise<CreatedFolder> {
  const response = await request<CreatedFolder>('POST', NAVIGATION_ROUTES.works, {
    body: {
      objectId: input.objectId,
      sectionCode: input.sectionCode,
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
export interface FolderDeletionPreview {
  folderId: string;
  title: string;
  files: number;
  pages: number;
  layoutBlocks: number;
  documents: number;
  findings: number;
  blockers: string[];
}

export async function getFolderDeletionPreview(workId: string): Promise<FolderDeletionPreview> {
  return get<FolderDeletionPreview>(NAVIGATION_ROUTES.folderDeletionPreview(workId));
}

/**
 * Удаление папки со всем содержимым.
 *
 * Право — `submission.delete`, оно есть у всех пяти ролей (S37). Помех
 * удалению больше нет: они держались на согласовании и неизменяемости, снятых
 * в S44.
 */
export async function deleteFolder(folderId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/folders/${folderId}`);
}

/**
 * Состояние конвейера по комплектам страницы списка.
 *
 * Идентификаторы уходят строкой через запятую: это `GET`, и повторяющийся ключ
 * разные клиенты кодируют по-разному.
 *
 * Строка, которой в ответе нет, — это «нет данных», а не «не запускалось».
 * Разбирает это `pipelineState`, здесь только транспорт.
 */
export interface FolderPipelineSummary {
  folderId: string;
  stage: ProcessingStage;
  queued: number;
  running: number;
  dead: number;
}

export async function listWorkPipeline(
  objectId: string,
  folderIds: readonly string[],
): Promise<readonly FolderPipelineSummary[]> {
  if (folderIds.length === 0) return [];
  return get<FolderPipelineSummary[]>(NAVIGATION_ROUTES.foldersPipeline(objectId), {
    // Имя параметра — из схемы сервера (`folderPipelineQuerySchema`). До S45
    // клиент слал `workIds`, и запрос отвергался схемой: 422 на каждой
    // отрисовке списка, а колонка «Распознавание» показывала «нет данных».
    query: { folderIds: folderIds.join(',') },
  });
}
