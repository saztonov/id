/**
 * Разбор конверта ошибки `application/problem+json` (RFC 9457, §14).
 *
 * Ошибка транспорта в портале — не строка. По ней принимаются РАЗНЫЕ решения:
 * 401 отправляет на вход, 403 с видом `csrf` лечится обновлением токена и
 * повтором, 412 открывает сравнение версий (§7.2), 422 подсвечивает поля формы
 * по `pointer`. Свернуть всё это в `Error(message)` значит потерять именно ту
 * часть ответа, ради которой сервер её и формирует.
 *
 * Различение идёт по `type`, а не по тексту `title`: `problemType()` на стороне
 * API строит URN `urn:id-portal:problem:<вид>` и объявлен стабильным, тогда как
 * заголовок — человеческая формулировка и меняется без предупреждения.
 */
import type { ProblemDetails, ProblemError } from '@id/contracts';

/** Префикс URN видов проблем портала (`apps/api/src/lib/problem.ts`). */
const PROBLEM_TYPE_PREFIX = 'urn:id-portal:problem:';

export type ProblemSlug =
  | 'malformed-request'
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'csrf'
  | 'not-found'
  | 'method-not-allowed'
  | 'conflict'
  | 'precondition-failed'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'rate-limited'
  | 'internal'
  | 'unavailable';

/**
 * Ошибка обращения к API.
 *
 * `problem` может быть `null`: сервер за прокси отвечает и `text/html`, а
 * страница, которая в этом случае показывает «[object Object]», хуже страницы,
 * которая честно говорит «сервис недоступен».
 */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | null;
  /**
   * Через сколько сервер разрешил повторить (`Retry-After`), в миллисекундах.
   *
   * Хранится в ошибке, потому что заголовки ответа дальше транспорта не идут, а
   * без этого числа экран не может сказать «данные подтянутся через N секунд» и
   * скатывается к «не удалось получить данные» — сообщению, из которого следует,
   * что сломалось, хотя всего лишь попросили подождать.
   */
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    problem: ProblemDetails | null,
    fallback: string,
    retryAfterMs: number | null = null,
  ) {
    super(problem?.detail ?? problem?.title ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.retryAfterMs = retryAfterMs;
  }

  /** Вид проблемы, если сервер его назвал. */
  get slug(): ProblemSlug | null {
    const type = this.problem?.type;
    if (type === undefined || !type.startsWith(PROBLEM_TYPE_PREFIX)) return null;
    return type.slice(PROBLEM_TYPE_PREFIX.length) as ProblemSlug;
  }

  /** Ошибки полей: форма подсвечивает их по `pointer` (JSON Pointer). */
  get fieldErrors(): readonly ProblemError[] {
    return this.problem?.errors ?? [];
  }

  /** Идентификатор запроса из §11: то единственное, что пользователь может назвать поддержке. */
  get requestId(): string | null {
    return this.problem?.requestId ?? null;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Требуется вход: сессии нет либо она истекла. */
export function isUnauthenticated(value: unknown): boolean {
  return isApiError(value) && value.status === 401;
}

/**
 * Конфликт версий оптимистичной блокировки (§7.2).
 *
 * Отдельный предикат, а не сравнение с числом по месту: на этом условии
 * открывается сравнение версий, и «412» рассыпанный по экранам однажды
 * разъедется с «версия устарела» по смыслу.
 */
export function isVersionConflict(value: unknown): boolean {
  return isApiError(value) && value.status === 412;
}

/**
 * Слишком много запросов.
 *
 * Отдельный предикат по той же причине, что и `isVersionConflict`: на этом
 * условии экран ведёт себя иначе, чем при любой другой ошибке, — он НЕ прячет
 * уже показанные данные. Они не устарели катастрофически, обновление просто
 * задержится, и подменять их красным экраном значит наказывать пользователя за
 * то, что портал слишком часто спрашивал сервер.
 */
export function isRateLimited(value: unknown): boolean {
  return isApiError(value) && value.status === 429;
}

/**
 * Разбор `Retry-After` из ответа.
 *
 * Спецификация допускает две формы — секунды и HTTP-дату. Портал шлёт секунды
 * (`apps/api/src/lib/problem.ts`), но разбирать обе дешевле, чем однажды
 * получить дату от промежуточного прокси и молча посчитать её нулём.
 */
export function retryAfterMsOf(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null) return null;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/** Ответ отвергнут проверкой CSRF — токен обновляется и запрос повторяется один раз. */
export function isCsrfRejection(value: unknown): boolean {
  return isApiError(value) && value.status === 403 && value.slug === 'csrf';
}

/**
 * Разбор тела ответа об ошибке.
 *
 * Схема из контрактов сюда НЕ применяется намеренно: `problemDetailsSchema`
 * отвергнет ответ, форма которого чуть шире объявленной, и вместо сообщения
 * сервера пользователь увидит ошибку разбора. Ответ об ошибке — последнее
 * место, где уместна строгость к чужому формату.
 */
export async function parseProblem(response: Response): Promise<ProblemDetails | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    if (typeof record['title'] !== 'string' || typeof record['status'] !== 'number') return null;
    return record as unknown as ProblemDetails;
  } catch {
    return null;
  }
}

/**
 * Отказ браузера ДО запроса — `fetch` бросает `TypeError` и молчит о причине.
 *
 * Так выглядит непройденный preflight `OPTIONS` к presigned PUT: у бакета нет
 * CORS-политики, браузер обрывает обмен сам и по требованию спецификации не
 * сообщает скрипту, что именно случилось, — остаётся `TypeError: Failed to
 * fetch`. Пользователь при этом видит сообщение, из которого следует «интернет
 * пропал», хотя настраивать нужно хранилище.
 *
 * Различить наверняка нельзя, и текст поэтому называет обе возможности. Это
 * честнее, чем и молчание, и уверенное «дело в CORS».
 */
export function describeUploadFailure(error: unknown): string {
  if (error instanceof TypeError) {
    return (
      'Браузер не смог отправить файл в хранилище. Обычно это значит, что хранилище отвергло ' +
      'предварительный запрос браузера (CORS): проверьте политику бакета. Реже — обрыв сети. ' +
      `Сообщение движка: ${error.message}`
    );
  }
  return describeError(error);
}

/**
 * Отказ хранилища, разобранный из XML-ответа S3.
 *
 * `code` вынесен отдельно от текста намеренно: он уезжает в журнал портала осью
 * `error_code`, по которой отказы группируются и фильтруются, — а текст живёт
 * только на экране у того, кто грузил.
 */
export interface StorageRejection {
  /** Текст пользователю: статус, код, номер запроса и что с этим делать. */
  readonly message: string;
  /** `<Code>` из ответа: `InternalError`, `SlowDown`, `SignatureDoesNotMatch`… */
  readonly code: string | null;
  /** `<RequestId>` — с ним обращаются в поддержку хранилища. */
  readonly requestId: string | null;
}

/**
 * Тело ошибки S3 разбирается регулярным выражением, а не `DOMParser`.
 *
 * Не из экономии: юнит-тесты идут в node-окружении, где `DOMParser`
 * отсутствует, — то есть разбор, написанный через него, проверялся бы только
 * вручную в браузере. Нужны при этом ровно два элемента верхнего уровня, и
 * ошибиться в них выражению негде.
 */
function tagValue(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]{1,200})</${tag}>`, 'u').exec(body);
  return match?.[1]?.trim() ?? null;
}

/**
 * Что делать пользователю — по классу отказа, а не по одному лишь статусу.
 *
 * Совет обязателен: «HTTP 500» человеку не говорит ничего, а «повторите через
 * минуту» и «начните загрузку заново» — это разные действия, и выбирать между
 * ними по коду умеем мы, а не он.
 */
function adviceFor(status: number, code: string | null): string {
  if (code === 'SignatureDoesNotMatch' || code === 'AccessDenied' || status === 403) {
    return 'Ссылка на загрузку недействительна — начните загрузку заново.';
  }
  if (code === 'RequestTimeTooSkewed') {
    return 'Часы устройства разошлись с хранилищем — проверьте время и начните загрузку заново.';
  }
  if (code === 'RequestTimeout' || code === 'IncompleteBody') {
    return 'Файл дошёл не целиком: соединение оборвалось. Попробуйте ещё раз.';
  }
  if (status >= 500 || status === 429 || code === 'SlowDown' || code === 'ServiceUnavailable') {
    return 'Это временный отказ хранилища; портал уже повторил попытку. Попробуйте через минуту.';
  }
  return 'Попробуйте ещё раз; если повторяется — сообщите администратору портала.';
}

/**
 * Отказ хранилища на заливке байтов.
 *
 * Тело кросс-доменного ответа читаемо: раз браузер отдал скрипту статус, а не
 * `TypeError`, значит CORS-заголовки на ответе есть. Пустое или не-XML тело —
 * законный исход (прокси, заглушка), и тогда остаётся один статус.
 */
export function describeStorageRejection(status: number, body: string): StorageRejection {
  const code = tagValue(body, 'Code');
  const requestId = tagValue(body, 'RequestId');

  const details = [code, requestId === null ? null : `запрос ${requestId}`]
    .filter((part): part is string => part !== null)
    .join(', ');

  const head = `Хранилище не приняло байты: HTTP ${String(status)}${details === '' ? '' : ` (${details})`}`;
  return { message: `${head}. ${adviceFor(status, code)}`, code, requestId };
}

/** Человеческий текст ошибки для уведомления. */
export function describeError(error: unknown): string {
  if (isApiError(error)) {
    const requestId = error.requestId;
    const base = error.message;
    return requestId === null ? base : `${base} (запрос ${requestId})`;
  }
  if (error instanceof Error) return error.message;
  return 'Непредвиденная ошибка';
}
