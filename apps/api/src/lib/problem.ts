/**
 * Ответы об ошибках в формате RFC 9457 (`application/problem+json`).
 *
 * Тело ошибки собирается здесь целиком и никогда не выводится из объекта
 * исключения. Причина в том, что сообщения нижних слоёв — готовая утечка:
 * ошибка драйвера PostgreSQL несёт текст запроса и имена таблиц, ошибка
 * сериализации ответа — форму внутренней модели, стек — пути файлов и состав
 * зависимостей. Поэтому наружу уходят только `title` и `detail`, написанные
 * автором обработчика, а всё остальное остаётся в журнале.
 */
import {
  BLANK_PROBLEM_TYPE,
  PROBLEM_JSON_CONTENT_TYPE,
  type ProblemDetails,
  type ProblemError,
} from '@id/contracts';

export { PROBLEM_JSON_CONTENT_TYPE };

/**
 * Вид проблемы. Значение `type` строится из него и стабильно: клиент вправе
 * различать ошибки по `type`, а не по тексту `title`.
 */
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

/** URN, а не URL: разрешаемой страницы с описанием проблемы у нас нет. */
export function problemType(slug: ProblemSlug): string {
  return `urn:id-portal:problem:${slug}`;
}

const TITLE_BAD_REQUEST = 'Некорректный запрос';
const TITLE_INTERNAL = 'Внутренняя ошибка сервера';

/**
 * Обезличенные заголовки по статусу.
 *
 * Нужны там, где проблему построил не наш код (плагин Fastify, разбор тела,
 * лимит размера): собственное сообщение такой ошибки в ответ не попадает.
 */
const TITLES: Readonly<Record<number, string>> = {
  400: TITLE_BAD_REQUEST,
  401: 'Требуется аутентификация',
  403: 'Доступ запрещён',
  404: 'Ресурс не найден',
  405: 'Метод не поддерживается',
  406: 'Неприемлемый формат ответа',
  409: 'Конфликт состояния',
  412: 'Условие запроса не выполнено',
  413: 'Тело запроса слишком велико',
  415: 'Неподдерживаемый тип содержимого',
  422: 'Запрос не прошёл проверку',
  429: 'Слишком много запросов',
  500: TITLE_INTERNAL,
  502: 'Ошибка внешнего сервиса',
  503: 'Сервис временно недоступен',
  504: 'Внешний сервис не ответил вовремя',
};

const SLUGS: Readonly<Record<number, ProblemSlug>> = {
  400: 'malformed-request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  409: 'conflict',
  412: 'precondition-failed',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  422: 'validation',
  429: 'rate-limited',
  500: 'internal',
  503: 'unavailable',
};

export function titleForStatus(status: number): string {
  return TITLES[status] ?? (status >= 500 ? TITLE_INTERNAL : TITLE_BAD_REQUEST);
}

export function slugForStatus(status: number): ProblemSlug {
  return SLUGS[status] ?? (status >= 500 ? 'internal' : 'malformed-request');
}

export interface HttpProblemOptions {
  readonly slug?: ProblemSlug;
  /** Пояснение для пользователя. Пишется автором и потому безопасно. */
  readonly detail?: string;
  readonly errors?: readonly ProblemError[];
  /** Заголовки ответа, требуемые статусом: `Retry-After`, `WWW-Authenticate`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Исходная ошибка: уходит только в журнал. */
  readonly cause?: unknown;
  /** Подробность для журнала. В тело ответа не попадает никогда. */
  readonly logDetail?: string;
}

/**
 * Исключение, которое обработчик ошибок превращает в problem+json без правок.
 *
 * Поля объявлены как `T | undefined`, а не как необязательные: при
 * `exactOptionalPropertyTypes` присваивание `undefined` необязательному полю
 * запрещено, и конструктор пришлось бы обвешивать условными спредами.
 */
export class HttpProblem extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly detail: string | undefined;
  readonly errors: readonly ProblemError[] | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly logDetail: string | undefined;

  constructor(status: number, title?: string, options: HttpProblemOptions = {}) {
    // message — для журнала и стека; в ответ клиенту он не попадает.
    super(options.logDetail ?? options.detail ?? title ?? titleForStatus(status));
    this.name = 'HttpProblem';
    this.status = status;
    this.title = title ?? titleForStatus(status);
    this.type = problemType(options.slug ?? slugForStatus(status));
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers;
    this.logDetail = options.logDetail;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Fastify читает `statusCode` у ошибки, если обработчик её не перехватил. */
  get statusCode(): number {
    return this.status;
  }
}

export function isHttpProblem(value: unknown): value is HttpProblem {
  return value instanceof HttpProblem;
}

// =====================================================================
// Типовые ошибки
// =====================================================================

export function badRequest(detail?: string, options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(400, titleForStatus(400), withDetail(options, detail));
}

/**
 * 401 всегда с `WWW-Authenticate`: без него клиент не отличает «сессия
 * истекла, попробуй войти» от «этот эндпоинт вообще без аутентификации».
 */
export function unauthorized(detail?: string, options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(401, titleForStatus(401), {
    ...withDetail(options, detail),
    headers: { 'www-authenticate': 'Session realm="id-portal"', ...options.headers },
  });
}

export function forbidden(detail?: string, options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(403, titleForStatus(403), withDetail(options, detail));
}

export function notFound(detail?: string, options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(404, titleForStatus(404), withDetail(options, detail));
}

export function conflict(detail?: string, options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(409, titleForStatus(409), withDetail(options, detail));
}

export function preconditionFailed(detail?: string, options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(412, titleForStatus(412), withDetail(options, detail));
}

/** 422 — тело разобрано, но не прошло проверку схемой или инвариантом. */
export function unprocessable(
  errors: readonly ProblemError[],
  detail?: string,
  options: HttpProblemOptions = {},
): HttpProblem {
  return new HttpProblem(422, titleForStatus(422), {
    ...withDetail(options, detail),
    slug: 'validation',
    errors,
  });
}

export function tooManyRequests(
  retryAfterSeconds: number,
  detail?: string,
  options: HttpProblemOptions = {},
): HttpProblem {
  return new HttpProblem(429, titleForStatus(429), {
    ...withDetail(options, detail),
    headers: {
      'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
      ...options.headers,
    },
  });
}

/**
 * 500 без `detail`.
 *
 * Диагностика внутренней ошибки живёт в журнале и в `error_events` (§11), а
 * клиенту достаётся `requestId`, по которому поддержка находит запись.
 */
export function internal(options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(500, titleForStatus(500), { ...options, slug: 'internal' });
}

export function unavailable(detail?: string, options: HttpProblemOptions = {}): HttpProblem {
  return new HttpProblem(503, titleForStatus(503), {
    ...withDetail(options, detail),
    slug: 'unavailable',
  });
}

function withDetail(options: HttpProblemOptions, detail: string | undefined): HttpProblemOptions {
  return detail === undefined ? options : { ...options, detail };
}

// =====================================================================
// Сборка ответа
// =====================================================================

export interface ProblemContext {
  readonly requestId?: string | undefined;
  /** URI запроса. Только путь: строка запроса может содержать ПДн. */
  readonly instance?: string | undefined;
}

/**
 * Путь запроса без строки параметров.
 *
 * `instance` попадает в тело ответа и в журналы, а в query приезжают поисковые
 * строки с ФИО и номерами документов — то есть ПДн, подлежащие redaction (§11).
 */
export function requestInstance(url: string): string {
  const separator = url.indexOf('?');
  return separator === -1 ? url : url.slice(0, separator);
}

export function problemBody(problem: HttpProblem, context: ProblemContext = {}): ProblemDetails {
  return {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    ...(problem.detail !== undefined ? { detail: problem.detail } : {}),
    ...(context.instance !== undefined ? { instance: context.instance } : {}),
    ...(problem.errors !== undefined ? { errors: [...problem.errors] } : {}),
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
  };
}

/** Проблема без своего `type`: RFC 9457 требует трактовать `title` как фразу статуса. */
export function blankProblemBody(status: number, context: ProblemContext = {}): ProblemDetails {
  return {
    type: BLANK_PROBLEM_TYPE,
    title: titleForStatus(status),
    status,
    ...(context.instance !== undefined ? { instance: context.instance } : {}),
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
  };
}

/**
 * Приведение произвольного значения к проблеме.
 *
 * Клиентские статусы (4xx), выставленные плагинами Fastify, сохраняются — иначе
 * превышение лимита размера тела выглядело бы как поломка сервера. Но сообщение
 * такой ошибки в ответ не переносится: его текст нам не подконтролен.
 */
export function toHttpProblem(error: unknown): HttpProblem {
  if (isHttpProblem(error)) return error;

  const status = statusCodeOf(error);
  if (status !== null && status >= 400 && status < 500) {
    return new HttpProblem(status, titleForStatus(status), {
      cause: error,
      logDetail: messageOf(error),
    });
  }

  return internal({ cause: error, logDetail: messageOf(error) });
}

function statusCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate: unknown = (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'нераспознанная ошибка';
}
