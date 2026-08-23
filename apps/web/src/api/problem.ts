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

  constructor(status: number, problem: ProblemDetails | null, fallback: string) {
    super(problem?.detail ?? problem?.title ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
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
