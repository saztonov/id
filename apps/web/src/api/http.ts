/**
 * Транспорт к `/api/v1/*` (§4.1, §14).
 *
 * Три вещи здесь сделаны намеренно и легко «упростить» неверно.
 *
 * **1. Токенов в браузере нет.** Сессия живёт в `HttpOnly Secure SameSite=Lax`
 * cookie, которую JavaScript не читает; наружу из авторизации к нам приходит
 * только CSRF-токен в обычной cookie `id_csrf` (`httpOnly: false` в
 * `auth/session.ts` — это её единственное назначение). Поэтому здесь нет ни
 * хранилища токенов, ни заголовка `Authorization`, и добавлять их нельзя:
 * §4.1 запрещает попадание токенов Keycloak в браузер.
 *
 * **2. `credentials: 'same-origin'`, а не `'include'`.** Портал ходит только к
 * собственному origin (dev — через прокси Vite), presigned URL наружу не
 * выдаются (§4.2). `'include'` разослал бы cookie сессии и на посторонний хост,
 * если бы такой адрес однажды попал в вызов.
 *
 * **3. Повтор после отказа CSRF — ровно один и только для отказа CSRF.**
 * Токен сессии вращается (`POST /auth/csrf`), и вкладка, открытая до вращения,
 * законно получает 403. Слепой повтор любого 403 маскировал бы отсутствие прав,
 * а повтор без границы дал бы цикл.
 *
 * **4. В сеть отсюда никто не ходит напрямую.** Каждая попытка уезжает через
 * `api/queue.ts`: он держит темп, параллелизм, дедупликацию одинаковых чтений в
 * полёте, повторы по 429/5xx и общую паузу по `Retry-After`. Повтор CSRF
 * остался здесь и в очередь не переехал намеренно — это протокол приложения, а
 * не свойство транспорта, и очереди незачем знать про вращение токена.
 */
import { ApiError, isCsrfRejection, parseProblem, retryAfterMsOf } from './problem.js';
import { submit, type RequestKind } from './queue.js';

/** Заголовок CSRF (`apps/api/src/auth/session.ts`). */
const CSRF_HEADER = 'x-csrf-token';
/** Cookie с тем же токеном; читается JavaScript по построению. */
const CSRF_COOKIE = 'id_csrf';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Версия для оптимистичной блокировки (§7.2). */
  readonly ifMatch?: number | string;
  /** Ключ идемпотентности (§14): freeze, recognize, checks, действия workflow. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Ответ вместе с заголовками, которые несут состояние. */
export interface ApiResponse<T> {
  readonly data: T;
  /** Числовое значение `ETag`; `null`, когда заголовка нет или он не число. */
  readonly version: number | null;
  readonly status: number;
}

export function readCsrfToken(): string | null {
  const source = typeof document === 'undefined' ? '' : document.cookie;
  for (const part of source.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE) {
      const raw = rest.join('=');
      return raw === '' ? null : decodeURIComponent(raw);
    }
  }
  return null;
}

/**
 * Обновление CSRF-токена.
 *
 * Сам этот запрос — POST, то есть проходит ту же проверку. Курица и яйцо
 * разрешаются тем, что текущее значение читается из cookie: сервер сверяет
 * заголовок с хэшем в `auth_sessions`, а cookie и хэш расходятся только после
 * вращения на другой вкладке — ровно тот случай, ради которого метод и нужен.
 */
export async function refreshCsrfToken(): Promise<string | null> {
  const current = readCsrfToken();
  const response = await fetch('/auth/csrf', {
    method: 'POST',
    credentials: 'same-origin',
    headers: current === null ? {} : { [CSRF_HEADER]: current },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (typeof body === 'object' && body !== null && 'csrfToken' in body) {
    const token = (body as { csrfToken: unknown }).csrfToken;
    if (typeof token === 'string') return token;
  }
  return null;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  if (query === undefined) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix === '' ? path : `${path}?${suffix}`;
}

function parseVersion(response: Response): number | null {
  const etag = response.headers.get('etag');
  if (etag === null) return null;
  const cleaned = etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number(cleaned);
  return Number.isInteger(parsed) ? parsed : null;
}

async function readBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Ключ дедупликации.
 *
 * Только для `GET` и только когда у запроса нет полей, различающих намерение:
 * `If-Match` и `Idempotency-Key` на чтении не ставятся, а собственные заголовки
 * вызывающего могут менять ответ, и склеивать такие запросы нельзя.
 */
function dedupeKeyOf(method: HttpMethod, url: string, options: RequestOptions): string | null {
  if (method !== 'GET') return null;
  if (options.headers !== undefined && Object.keys(options.headers).length > 0) return null;
  return `GET ${url}`;
}

async function attempt(
  method: HttpMethod,
  path: string,
  options: RequestOptions,
  csrfToken: string | null,
): Promise<Response> {
  const url = buildUrl(path, options.query);
  const kind: RequestKind = MUTATING_METHODS.has(method) ? 'mutation' : 'read';

  return submit({
    kind,
    dedupeKey: dedupeKeyOf(method, url, options),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // Заголовки собираются на КАЖДУЮ попытку, а не один раз снаружи: между
    // повторами токен CSRF мог смениться на другой вкладке, и замороженный
    // набор ушёл бы со старым.
    send: (signal) => {
      const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.ifMatch !== undefined) headers['if-match'] = `"${String(options.ifMatch)}"`;
      if (options.idempotencyKey !== undefined) {
        headers['idempotency-key'] = options.idempotencyKey;
      }
      if (MUTATING_METHODS.has(method) && csrfToken !== null) headers[CSRF_HEADER] = csrfToken;

      return fetch(url, {
        method,
        credentials: 'same-origin',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        // Сигнал очереди, а не вызывающего: очередь связывает их сама и добавляет
        // собственную отмену. Раньше сигнал не доходил до `fetch` вовсе, и
        // «отменённый» TanStack Query запрос всё равно уезжал на сервер.
        signal,
      });
    },
  });
}

/**
 * Запрос к API с разбором конверта ошибки и заголовка версии.
 *
 * Возвращает и тело, и версию: на экране разметки версия — это состояние,
 * которое клиент обязан вернуть в `If-Match` следующей правкой, и терять его
 * между вызовами нельзя.
 */
export async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  let response = await attempt(method, path, options, readCsrfToken());

  if (response.status === 403 && MUTATING_METHODS.has(method)) {
    const problem = await parseProblem(response.clone());
    if (isCsrfRejection(new ApiError(403, problem, ''))) {
      const refreshed = await refreshCsrfToken();
      if (refreshed !== null) response = await attempt(method, path, options, refreshed);
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      await parseProblem(response),
      `HTTP ${String(response.status)}`,
      retryAfterMsOf(response),
    );
  }

  return {
    data: await readBody<T>(response),
    version: parseVersion(response),
    status: response.status,
  };
}

/** Короткая форма для чтения: версия ответа не нужна. */
export async function get<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await request<T>('GET', path, options)).data;
}

/**
 * Ключ идемпотентности (§14): печатаемые ASCII, длина 8..255.
 *
 * Генерируется клиентом и переживает повтор запроса после сетевого таймаута —
 * иначе второе нажатие «Отправить на распознавание» стоило бы второго прогона
 * на GPU.
 */
export function newIdempotencyKey(prefix: string): string {
  const random = crypto.randomUUID();
  return `${prefix}-${random}`;
}
