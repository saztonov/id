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

          if (!response.ok) throw await failureOf(response, options.operation, this.#options.token);
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

          // Bearer к подписанной ссылке не прикладывается, но вычёркивание всё
          // равно передаётся: правило «секрет не печатается» не должно зависеть
          // от того, помнит ли следующий читатель про это отличие.
          if (!response.ok) throw await failureOf(response, 'upload_put', this.#options.token);
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

/** Сколько символов чужого текста доезжает до диагностики. */
const BODY_SNIPPET_LIMIT = 200;

/**
 * Короткий снимок тела, не подошедшего под форму контракта.
 *
 * Переводы строк схлопываются: HTML-страница ошибки иначе разорвала бы одну
 * запись журнала на полсотни строк, а прочитать её всё равно нельзя.
 *
 * Удостоверение вычёркивается ДО обрезки. Это не паранойя, а прямое следствие
 * решения печатать чужой текст: ответ мы не сочиняем, а текст ошибки доезжает
 * до `job_runs.error_message` и до консоли задач. Шлюз, вернувший присланный
 * заголовок эхом, превратил бы диагностику в способ раздать токен — ровно этот
 * дефект уже случался на S3 (`Authorization` в объекте ошибки LLM-провайдера).
 */
function snippetOf(text: string, secret: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  const safe = secret === '' ? collapsed : collapsed.split(secret).join('***');
  return safe.length > BODY_SNIPPET_LIMIT ? `${safe.slice(0, BODY_SNIPPET_LIMIT)}…` : safe;
}

/**
 * Отказ из тела ответа: `{"detail": {"code": "…", "message": "…"}}` (§10).
 *
 * Код разбирается и сохраняется — по нему задача решает, повторять, сдаваться
 * или пересобирать снимок, и решение это обязано опираться на код контракта, а
 * не на угадывание по тексту. Сообщение обрезается: у него нет обещания не
 * содержать эха присланных данных, а данные здесь — исполнительная документация.
 *
 * ## Почему тело не в форме контракта всё равно попадает в текст
 *
 * Потому что молчание здесь стоило полдня. На приёмке `rd.sync_init` пять раз
 * получил `500`, а в консоли задач стояло «RD WEB ответил» без продолжения:
 * их `500` отдавал `Internal Server Error` простым текстом, `JSON.parse` бросал,
 * и оба поля оставались пустыми. Отличить «сломан их обработчик» от «сломано
 * наше тело» удалось только серией ручных проб через `docker exec` — при том,
 * что сам ответ был у нас в руках и мы его выбрасывали.
 *
 * Обрезка та же, что у `message`, и по той же причине: чужой текст может
 * оказаться эхом присланного, а страница ошибки — километровой.
 */
async function failureOf(
  response: Response,
  operation: string,
  secret: string,
): Promise<ExecSyncError> {
  let code: string | null = null;
  let message = '';
  let raw = '';
  try {
    raw = await response.text();
    const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : null;
    const detail = (parsed as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'object' && detail !== null) {
      const rawCode = (detail as { code?: unknown }).code;
      const rawMessage = (detail as { message?: unknown }).message;
      if (typeof rawCode === 'string') code = rawCode;
      if (typeof rawMessage === 'string') message = rawMessage.slice(0, BODY_SNIPPET_LIMIT);
    } else if (typeof detail === 'string') {
      // Прежний контур отвечал строкой в `detail`; форма могла остаться на
      // общих обработчиках, и терять текст из-за этого незачем.
      message = detail.slice(0, BODY_SNIPPET_LIMIT);
    }
  } catch {
    code = null;
  }

  const status = String(response.status);
  const snippet = snippetOf(raw, secret);
  const described =
    code === null && message === ''
      ? snippet === ''
        ? `RD WEB ответил ${status} с пустым телом`
        : `RD WEB ответил ${status}, тело не в форме контракта: ${snippet}`
      : `RD WEB ответил ${status}: ${[code, message].filter(Boolean).join(' — ')}`;

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
