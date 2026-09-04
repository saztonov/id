/**
 * HTTP-клиент контура `/api/executive/v1`: Bearer, сквозной `request_id`,
 * измерение вызовов (§11 плана портала).
 *
 * ## Что изменилось против прежнего клиента RD WEB
 *
 * Ушёл весь механизм сессии: вход по паролю, хранение токена в памяти процесса,
 * единовременный логин и повтор после 401. У нового контура M2M-удостоверение —
 * долгоживущий Bearer с областями действия, выданный администратором RD WEB
 * (`executive:sync:init|complete|read`). Повторять вход после 401 стало нечем и
 * незачем: 401 здесь означает неверный или отозванный токен, и второй заход дал
 * бы тот же ответ, только медленнее.
 *
 * Это, кстати, закрытие требования №1 (P0) из `docs/RDWEB_IMPROVEMENTS.md`:
 * доступ портала к RD WEB перестал быть технически неотличимым от доступа
 * человека.
 *
 * ## Что осталось и почему
 *
 * Инъекция `fetch`, таймаут через `AbortController`, `traceHeaders()`,
 * обязательный `measureExternalCall` и правило «тело ответа в журнал не идёт».
 * Последнее здесь важнее, чем раньше: тело ответа этого контура — распознанный
 * текст исполнительной документации, то есть ровно то, что §11 запрещает
 * логировать. В журнал уходят только эндпоинт, длительность и код.
 *
 * Токен приходит из окружения и в журнал не попадает никогда: `logger.ts`
 * вырезает `authorization` по имени ключа, а сюда он вообще не передаётся —
 * заголовки не логируются.
 */
import type { Logger } from 'pino';
import type { Readable } from 'node:stream';

import { childLogger, traceHeaders } from '../../observability/context.js';
import { measureExternalCall, type Metrics } from '../../observability/metrics.js';
import { ExecSyncError } from './port.js';

/** Метка сервиса в метриках и журнале. Кардинальность меток ограничена (§11). */
export const RDWEB_EXEC_SERVICE = 'rdweb_exec';

/** Префикс контура. Версия в пути — требование №2 из RDWEB_IMPROVEMENTS, закрыто. */
export const EXEC_API_PREFIX = '/api/executive/v1';

export interface ExecSyncClientOptions {
  readonly baseUrl: string;
  /** Значение заголовка ПОСЛЕ слова `Bearer`. Живёт только в окружении. */
  readonly token: string;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly slowExternalMs: number;
  readonly timeoutMs?: number | undefined;
  /** Подменяется в тестах; по умолчанию глобальный `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly operation: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | undefined>> | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class ExecSyncClient {
  readonly #options: ExecSyncClientOptions;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger;

  constructor(options: ExecSyncClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#logger = childLogger(options.logger, { component: 'rdweb_exec' });
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(`${EXEC_API_PREFIX}${options.path}`, this.#options.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.#options.token}`,
      ...traceHeaders(),
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    return measureExternalCall(
      this.#options.metrics,
      { service: RDWEB_EXEC_SERVICE, operation: options.operation },
      async () => {
        try {
          const response = await this.#fetch(url, {
            method: options.method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            signal: controller.signal,
          });

          if (!response.ok) throw await failureOf(response, options.operation);
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        } catch (error) {
          if (error instanceof ExecSyncError) throw error;
          throw new ExecSyncError(describeNetworkFailure(error), {
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
   * Загрузка PDF по выданному талону.
   *
   * Отдельно от `request()`: адрес приходит подписанным целиком, Bearer к нему
   * не прикладывается — подписью служит сам адрес, — а тело идёт потоком, чтобы
   * комплект на 86 МБ не поднимался в память воркера.
   */
  async putStream(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: () => Readable;
    readonly sizeBytes: number;
  }): Promise<void> {
    await measureExternalCall(
      this.#options.metrics,
      { service: RDWEB_EXEC_SERVICE, operation: 'upload_put' },
      async () => {
        try {
          const stream = input.body();
          const response = await this.#fetch(input.url, {
            method: 'PUT',
            headers: { ...input.headers, 'content-length': String(input.sizeBytes) },
            // `duplex` обязателен для потокового тела в undici; типы Node его
            // ещё не объявляют, поэтому расширение объявлено локально.
            body: stream as unknown as RequestInit['body'],
            duplex: 'half',
          } as RequestInit & { duplex: 'half' });

          if (!response.ok) throw await failureOf(response, 'upload_put');
          await response.arrayBuffer();
        } catch (error) {
          if (error instanceof ExecSyncError) throw error;
          throw new ExecSyncError(describeNetworkFailure(error), { operation: 'upload_put' });
        }
      },
      { logger: this.#logger, slowExternalMs: this.#options.slowExternalMs },
    );
  }
}

/**
 * Отказ из тела ответа: `{"detail": {"code": "…", "message": "…"}}` (§10).
 *
 * Код разбирается и сохраняется — по нему задача решает, повторять, сдаваться
 * или пересобирать снимок, и решение это обязано опираться на код контракта, а
 * не на угадывание по тексту. Сообщение обрезается: у него нет обещания не
 * содержать эха присланных данных, а данные здесь — исполнительная документация.
 */
async function failureOf(response: Response, operation: string): Promise<ExecSyncError> {
  let code: string | null = null;
  let message = '';
  try {
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
    const detail = (parsed as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'object' && detail !== null) {
      const rawCode = (detail as { code?: unknown }).code;
      const rawMessage = (detail as { message?: unknown }).message;
      if (typeof rawCode === 'string') code = rawCode;
      if (typeof rawMessage === 'string') message = rawMessage.slice(0, 200);
    } else if (typeof detail === 'string') {
      // Прежний контур отвечал строкой в `detail`; форма могла остаться на
      // общих обработчиках, и терять текст из-за этого незачем.
      message = detail.slice(0, 200);
    }
  } catch {
    code = null;
  }

  const described =
    code === null && message === ''
      ? `RD WEB ответил ${String(response.status)}`
      : `RD WEB ответил ${String(response.status)}: ${[code, message].filter(Boolean).join(' — ')}`;

  return new ExecSyncError(described, {
    status: response.status,
    code,
    operation,
    ...(retryAfterMsOf(response) !== undefined ? { retryAfterMs: retryAfterMsOf(response) } : {}),
  });
}

/**
 * `Retry-After` их стороны.
 *
 * Названный сервером срок сильнее нашей экспоненты: §10 требует его соблюдать,
 * а угаданная задержка либо ломится в закрытую дверь, либо ждёт дольше нужного.
 */
function retryAfterMsOf(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function describeNetworkFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'RD WEB не ответил за отведённое время';
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `Вызов RD WEB не состоялся (${name})`;
}
