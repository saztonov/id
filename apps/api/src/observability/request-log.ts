/**
 * Логирование HTTP-запросов: pino-http поверх сквозного контекста (§11).
 *
 * Обработчик работает с `node:http`, а не с Fastify: приложение подключает его
 * само, и тот же обработчик годится любому http-серверу (например, служебному
 * серверу воркера).
 *
 * Подключение в Fastify:
 *
 *   const httpLog = createRequestLogHandler({ logger, slowRequestMs, metrics });
 *   app.addHook('onRequest', (request, reply, done) => {
 *     httpLog(request.raw, reply.raw, () => {
 *       // шаблон маршрута известен только Fastify — здесь он попадает и в лог,
 *       // и в контекст, и в метки метрик
 *       setRequestLogFields(request.raw, { route: request.routeOptions.url });
 *       done();
 *     });
 *   });
 *
 * Далее слой авторизации добавляет `userId`, обработчики — `objectId`, тем же
 * `setRequestLogFields()`.
 *
 * Почему запись собирается в `customSuccessObject`, а не в `customProps`:
 * customProps попадает в лог дочерними bindings, а поля контекста подмешивает
 * mixin логгера — совпавший ключ дал бы в JSON два поля `request_id`. Объект,
 * переданный в вызов лога, pino сливает с результатом mixin'а через
 * `Object.assign`, то есть дублирования не возникает по построению.
 *
 * Второе следствие того же выбора: строка завершения запроса пишется из
 * обработчика события `close`, а AsyncLocalStorage до слушателей событий сокета
 * доходит не всегда. Поэтому `request_id`, маршрут и `user_id` берутся из
 * данных, привязанных к самому запросу, а не из контекста.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { pinoHttp, startTime, type Options } from 'pino-http';
import {
  REQUEST_ID_HEADER,
  currentRequestId,
  newRequestId,
  runWithContext,
  updateContext,
} from './context.js';
import { safeSerializers } from './logger.js';

/** Маршрут не опознан: 404, сканеры, запрос до разбора роутинга. */
export const UNKNOWN_ROUTE = 'unknown';

/**
 * Приёмник метрик (реализуется `metrics.ts`).
 *
 * Интерфейс объявлен здесь, а не импортирован: модуль логирования не должен
 * тянуть за собой prom-client, иначе он перестанет быть пригодным для процесса
 * без метрик. Совпадение формы проверит компилятор в точке связывания.
 */
export interface HttpMetricsSink {
  observeHttpRequest(sample: {
    readonly method: string;
    readonly route: string;
    readonly statusCode: number;
    readonly durationMs: number;
  }): void;
}

export interface RequestLogFields {
  readonly route?: string | undefined;
  readonly userId?: string | undefined;
  readonly objectId?: string | undefined;
  readonly revisionId?: string | undefined;
}

interface MutableFields {
  requestId?: string;
  route?: string;
  userId?: string;
  objectId?: string;
  revisionId?: string;
}

const fieldsByRequest = new WeakMap<IncomingMessage, MutableFields>();

function fieldsFor(req: IncomingMessage): MutableFields {
  const existing = fieldsByRequest.get(req);
  if (existing) return existing;
  const created: MutableFields = {};
  fieldsByRequest.set(req, created);
  return created;
}

/**
 * Дополняет запись о запросе. Те же поля уходят в контекст, поэтому их увидят
 * и job'ы, поставленные из этого запроса, и репортер ошибок.
 */
export function setRequestLogFields(req: IncomingMessage, fields: RequestLogFields): void {
  const target = fieldsFor(req);
  if (fields.route !== undefined) target.route = fields.route;
  if (fields.userId !== undefined) target.userId = fields.userId;
  if (fields.objectId !== undefined) target.objectId = fields.objectId;
  if (fields.revisionId !== undefined) target.revisionId = fields.revisionId;

  updateContext({
    route: fields.route,
    userId: fields.userId,
    objectId: fields.objectId,
    revisionId: fields.revisionId,
  });
}

export interface RequestLogOptions {
  readonly logger: Logger;
  /** Превышение переводит запись в warn (§11, `SLOW_REQUEST_MS`). */
  readonly slowRequestMs: number;
  /** Пути без логирования и без метрик: `/metrics`, проверки живости. */
  readonly ignorePaths?: readonly string[];
  readonly metrics?: HttpMetricsSink;
  /**
   * Принимать `x-request-id` от клиента (§15, `TRUST_REQUEST_ID`).
   *
   * По умолчанию нет. Принятый заголовок попадает в каждую строку журнала и в
   * тело ответа, поэтому без доверенного прокси перед приложением это
   * управляемая злоумышленником подделка корреляции логов.
   */
  readonly trustIncomingRequestId?: boolean;
}

/**
 * `presetRequestId` — идентификатор, уже присвоенный фреймворком.
 *
 * Без него у одного запроса оказалось бы два идентификатора: один в теле ответа
 * `problem+json` (его выдаёт `genReqId` Fastify), другой в журнале. Поддержка
 * обращения «в логе по этому номеру ничего нет» после такого расхождения
 * невозможна.
 */
export type RequestLogHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  presetRequestId?: string,
) => void;

/** Формат `x-request-id`, который мы согласны принять от прокси. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{8,64}$/;

/** Печатный ASCII: перевод строки в идентификаторе разрезал бы строку журнала. */
const LOGGABLE_REQUEST_ID = /^[\x20-\x7e]{1,128}$/;

/**
 * Идентификатор, выданный фреймворком. Проверяется мягче заголовка: он уже
 * попал в тело ответа, и подменять его здесь значило бы рассогласовать журнал с
 * ответом. Проверяется лишь пригодность для построчного журнала.
 */
function frameworkRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && LOGGABLE_REQUEST_ID.test(value) ? value : undefined;
}

/**
 * Идентификатор извне принимается только в узком формате: значение приходит от
 * клиента и попадает в каждую строку лога, в тело ответа и в БД.
 */
export function safeRequestId(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate) ? candidate : undefined;
}

function incomingRequestId(req: IncomingMessage): string | undefined {
  return safeRequestId(req.headers[REQUEST_ID_HEADER]);
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const cut = url.indexOf('?');
  return cut < 0 ? url : url.slice(0, cut);
}

/**
 * Шаблон маршрута, если фреймворк положил его в сам объект запроса.
 *
 * У raw-объекта Fastify его нет — там шаблон задаёт приложение через
 * `setRequestLogFields()`. Проверка оставлена для Express-подобных серверов и
 * для случая, когда обработчику передали объект запроса фреймворка.
 */
function frameworkRoute(req: IncomingMessage): string | undefined {
  const candidate = req as unknown as {
    routeOptions?: { url?: unknown };
    routerPath?: unknown;
    route?: { path?: unknown };
  };
  const values = [candidate.routeOptions?.url, candidate.routerPath, candidate.route?.path];
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function routeOf(req: IncomingMessage): string {
  return fieldsByRequest.get(req)?.route ?? frameworkRoute(req) ?? UNKNOWN_ROUTE;
}

function requestIdOf(req: IncomingMessage): string | undefined {
  const stored = fieldsByRequest.get(req)?.requestId;
  if (stored !== undefined) return stored;
  return typeof req.id === 'string' ? req.id : currentRequestId();
}

function durationOf(res: ServerResponse): number {
  const started = res[startTime];
  return typeof started === 'number' ? Date.now() - started : 0;
}

export function createRequestLogHandler(options: RequestLogOptions): RequestLogHandler {
  const { logger, slowRequestMs, metrics } = options;
  const trustIncoming = options.trustIncomingRequestId ?? false;
  const ignored = new Set(options.ignorePaths ?? []);
  const isIgnored = (req: IncomingMessage): boolean => ignored.has(pathOf(req));
  const fromClient = (req: IncomingMessage): string | undefined =>
    trustIncoming ? incomingRequestId(req) : undefined;

  const completion = (req: IncomingMessage, res: ServerResponse): Record<string, unknown> => {
    const fields = fieldsByRequest.get(req);
    const route = routeOf(req);
    return {
      event: 'http_request',
      request_id: requestIdOf(req),
      method: req.method ?? 'UNKNOWN',
      route,
      // Конкретный путь — только когда шаблон неизвестен: иначе он ничего не
      // добавляет, а кардинальность значений в логе делает неограниченной.
      path: route === UNKNOWN_ROUTE ? pathOf(req) : undefined,
      status_code: res.statusCode,
      duration_ms: durationOf(res),
      user_id: fields?.userId,
      object_id: fields?.objectId,
      revision_id: fields?.revisionId,
    };
  };

  // Текст строки: у неопознанного маршрута шаблона нет, и «GET unknown → 404»
  // не читается. Путь берётся без query-строки — в ней приезжают секреты.
  const summary = (req: IncomingMessage, res: ServerResponse): string => {
    const route = routeOf(req);
    const where = route === UNKNOWN_ROUTE ? pathOf(req) : route;
    return `${req.method ?? '?'} ${where} → ${res.statusCode}`;
  };

  const pinoOptions: Options = {
    logger,
    genReqId: (req) => requestIdOf(req) ?? fromClient(req) ?? currentRequestId() ?? newRequestId(),
    autoLogging: { ignore: isIgnored },
    // Свои сериализаторы, а не `pino-std-serializers`: штатный сериализатор
    // запроса переносит в лог все заголовки и полный url, а штатный
    // сериализатор ошибки — все собственные поля объекта, включая `query` и
    // `params` драйвера PostgreSQL. `wrapSerializers: false` отключает
    // обёртку, которая иначе прогнала бы значение через штатный сериализатор
    // ПЕРЕД нашим.
    serializers: safeSerializers,
    wrapSerializers: false,
    // Ни req, ни res в bindings: строку завершения запроса мы собираем сами, а
    // стандартные сериализаторы добавили бы к ней заголовки целиком.
    quietReqLogger: false,
    quietResLogger: true,
    customLogLevel: (_req, res, error) => {
      if (error !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return durationOf(res) >= slowRequestMs ? 'warn' : 'info';
    },
    customSuccessObject: (req, res) => completion(req, res),
    customErrorObject: (req, res, error) => ({ ...completion(req, res), err: error }),
    customSuccessMessage: (req, res) => summary(req, res),
    customErrorMessage: (req, res) => summary(req, res),
  };

  const httpLogger = pinoHttp(pinoOptions);

  return (req, res, next, presetRequestId) => {
    const requestId = frameworkRequestId(presetRequestId) ?? fromClient(req) ?? newRequestId();

    runWithContext({ requestId }, () => {
      fieldsFor(req).requestId = requestId;
      // Клиент должен уметь назвать идентификатор в обращении в поддержку.
      if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, requestId);

      if (metrics && !isIgnored(req)) {
        const startedAt = Date.now();
        let observed = false;
        res.once('close', () => {
          if (observed) return;
          observed = true;
          metrics.observeHttpRequest({
            method: req.method ?? 'UNKNOWN',
            route: routeOf(req),
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
          });
        });
      }

      httpLogger(req, res, next);
    });
  };
}
