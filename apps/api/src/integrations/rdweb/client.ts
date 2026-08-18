/**
 * HTTP-клиент RD WEB: сессия, сквозной `request_id`, измерение вызовов (§11).
 *
 * ## Почему сессия, а не ключ
 *
 * M2M-аутентификации у RD WEB нет — это проверенный факт (§0.1; совпадения по
 * `api_key` в их коде относятся к настройке LM Studio endpoint'ов). Компенсация
 * §5.1: служебный аккаунт с ролью `editor`, ограниченный portal-owned
 * проектами. Отсюда весь механизм здесь: вход по паролю, Bearer-токен в памяти
 * процесса, автоматический повтор ОДИН раз после 401.
 *
 * Пароль приходит из окружения (`RDWEB_PASSWORD`) и не попадает ни в журнал, ни
 * в `app_settings`: в логах живёт только имя учётной записи и то лишь как метка
 * сервиса. Тело запроса на вход в лог не идёт вовсе — `measureExternalCall`
 * по построению пишет только эндпоинт и длительность.
 *
 * ## Почему повтор именно один
 *
 * Второй 401 подряд означает не протухший токен, а неверные учётные данные или
 * отозванный доступ. Бесконечный цикл «401 → login → 401» на такой конфигурации
 * выглядел бы как медленная работа, а не как отказ авторизации.
 */
import type { Logger } from 'pino';
import type { Readable } from 'node:stream';
import { traceHeaders } from '../../observability/context.js';
import { childLogger } from '../../observability/context.js';
import { measureExternalCall, type Metrics } from '../../observability/metrics.js';
import { RdWebError } from './port.js';

/** Метка сервиса в метриках и журнале. Кардинальность меток ограничена (§11). */
export const RDWEB_SERVICE = 'rdweb';

export interface RdWebCredentials {
  readonly baseUrl: string;
  readonly user: string;
  readonly password: string;
}

export interface RdWebClientOptions extends RdWebCredentials {
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly slowExternalMs: number;
  /** Потолок ожидания одного вызова. Внешний сервис не должен держать аренду. */
  readonly timeoutMs?: number | undefined;
  /** Подменяется в тестах; по умолчанию глобальный `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  readonly path: string;
  readonly operation: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | undefined>> | undefined;
  /** Ответ — байты, а не JSON (экспорт, превью). */
  readonly binary?: boolean | undefined;
  /** Не подставлять Bearer: вход и обновление токена. */
  readonly anonymous?: boolean | undefined;
  /** Коды, которые вызывающий разбирает сам (409 у optimistic concurrency). */
  readonly expect?: readonly number[] | undefined;
}

export interface RdWebResponse<T> {
  readonly status: number;
  readonly body: T;
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export class RdWebClient {
  readonly #options: RdWebClientOptions;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger;
  #session: Session | null = null;
  #loginInFlight: Promise<Session> | null = null;

  constructor(options: RdWebClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#logger = childLogger(options.logger, { component: 'rdweb' });
  }

  /**
   * Вход служебным аккаунтом — лениво и единовременно.
   *
   * Отдельного публичного `login()` нет намеренно: вход происходит при первом же
   * вызове, а метод «войти заранее» никто не звал бы, кроме теста, и он молча
   * разошёлся бы с настоящим путём. Единовременность обязательна: параллельные
   * задачи конвейера, наткнувшиеся на 401 в одну секунду, не должны устраивать
   * десять входов подряд — учётная запись у RD WEB одна, и десять сессий на ней
   * это и аудит-шум у них, и потенциальный rate limit.
   */
  #ensureSession(): Promise<Session> {
    const current = this.#session;
    if (current !== null) return Promise.resolve(current);
    if (this.#loginInFlight !== null) return this.#loginInFlight;

    const attempt = (async (): Promise<Session> => {
      const response = await this.#send<{ access_token: string; refresh_token: string }>({
        method: 'POST',
        path: '/api/auth/login',
        operation: 'login',
        anonymous: true,
        body: { email: this.#options.user, password: this.#options.password },
      });
      const session: Session = {
        accessToken: response.body.access_token,
        refreshToken: response.body.refresh_token,
      };
      this.#session = session;
      return session;
    })();

    this.#loginInFlight = attempt;
    return attempt.finally(() => {
      this.#loginInFlight = null;
    });
  }

  async request<T>(options: RequestOptions): Promise<RdWebResponse<T>> {
    if (options.anonymous === true) return this.#send<T>(options);

    const session = await this.#ensureSession();
    const first = await this.#send<T>(options, session.accessToken, { allow401: true });
    if (first.status !== 401) return first;

    // Токен протух — вход заново ровно один раз.
    this.#session = null;
    const renewed = await this.#ensureSession();
    return this.#send<T>(options, renewed.accessToken);
  }

  async #send<T>(
    options: RequestOptions,
    accessToken?: string,
    behaviour: { readonly allow401?: boolean } = {},
  ): Promise<RdWebResponse<T>> {
    const url = new URL(options.path, this.#options.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: options.binary === true ? '*/*' : 'application/json',
      // Сквозной `request_id` (§11): без него путь поставки через два десятка
      // задач и столько же вызовов RD WEB не проследить ни с одной стороны.
      ...traceHeaders(),
    };
    if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    return measureExternalCall(
      this.#options.metrics,
      { service: RDWEB_SERVICE, operation: options.operation },
      async () => {
        try {
          const response = await this.#fetch(url, {
            method: options.method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            signal: controller.signal,
          });

          if (response.status === 401 && behaviour.allow401 === true) {
            // Тело намеренно не читается: оно уже неинтересно, а поток нужно
            // закрыть, иначе соединение повиснет.
            await response.arrayBuffer();
            return { status: 401, body: undefined as T };
          }

          const expected = options.expect ?? [];
          if (!response.ok && !expected.includes(response.status)) {
            throw new RdWebError(await describeFailure(response), {
              status: response.status,
              operation: options.operation,
            });
          }

          if (options.binary === true) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            return { status: response.status, body: bytes as T };
          }
          if (response.status === 204) return { status: 204, body: undefined as T };
          return { status: response.status, body: (await response.json()) as T };
        } catch (error) {
          if (error instanceof RdWebError) throw error;
          throw new RdWebError(describeNetworkFailure(error), {
            operation: options.operation,
          });
        } finally {
          clearTimeout(timeout);
        }
      },
      { logger: this.#logger, slowExternalMs: this.#options.slowExternalMs },
    );
  }

  /**
   * Загрузка байтов по выданному адресу.
   *
   * Отдельно от `request()`: адрес приходит от них целиком (presigned PUT), тело
   * идёт потоком, а Bearer к нему не прикладывается — подписью служит сам адрес.
   * 86 МБ в память при этом не поднимаются.
   */
  async putStream(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: () => Readable;
    readonly sizeBytes: number;
  }): Promise<void> {
    await measureExternalCall(
      this.#options.metrics,
      { service: RDWEB_SERVICE, operation: 'upload_put' },
      async () => {
        const stream = input.body();
        const response = await this.#fetch(input.url, {
          method: 'PUT',
          headers: { ...input.headers, 'content-length': String(input.sizeBytes) },
          // `duplex` обязателен для потокового тела в undici; типы Node его
          // ещё не объявляют, поэтому расширение объявлено локально.
          body: stream as unknown as RequestInit['body'],
          duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        if (!response.ok) {
          throw new RdWebError(await describeFailure(response), {
            status: response.status,
            operation: 'upload_put',
          });
        }
        await response.arrayBuffer();
      },
      { logger: this.#logger, slowExternalMs: this.#options.slowExternalMs },
    );
  }
}

/**
 * Текст отказа без содержимого ответа.
 *
 * У FastAPI в теле лежит `detail`, и он бывает полезен («Слишком много страниц
 * за один вызов»). Но он же бывает эхом присланного значения, поэтому длина
 * обрезается, а всё, кроме `detail`, отбрасывается: тело ответа RD WEB — это
 * распознанный текст ИД, и ему в журнале не место.
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as { detail?: unknown }).detail;
      if (typeof value === 'string') detail = value.slice(0, 200);
    }
  } catch {
    detail = '';
  }
  return detail === ''
    ? `RD WEB ответил ${response.status}`
    : `RD WEB ответил ${response.status}: ${detail}`;
}

function describeNetworkFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'RD WEB не ответил за отведённое время';
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `Вызов RD WEB не состоялся (${name})`;
}
