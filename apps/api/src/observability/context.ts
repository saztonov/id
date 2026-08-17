/**
 * Сквозной контекст запроса: `request_id` и поля, которые к нему привязаны.
 *
 * Стандарт требует, чтобы `request_id` доходил от HTTP-запроса до job'ов и
 * исходящих вызовов RD WEB и LLM (§11): путь 83-страничной поставки через два
 * десятка job'ов иначе не проследить. Протаскивать идентификатор параметром
 * через каждый слой нереально — поэтому AsyncLocalStorage.
 *
 * Модуль ничего не знает ни про Fastify, ни про очередь задач. Воркер поднимает
 * контекст сам: `requestIdFromPayload()` достаёт идентификатор из payload'а
 * job'а, `runWithContext()` открывает область на время его выполнения.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

export interface RequestContext {
  requestId: string;
  userId?: string;
  objectId?: string;
  revisionId?: string;
  /**
   * Шаблон маршрута (`/api/objects/:objectId`), а не конкретный путь.
   * Конкретный путь в этом поле означал бы неограниченную кардинальность
   * значений — и в логах, и в метриках, которые из него строятся.
   */
  route?: string;
  jobType?: string;
  jobId?: string;
  attempt?: number;
}

export type ContextPatch = {
  -readonly [K in keyof RequestContext]?: RequestContext[K] | undefined;
};

/** Ключ, которым `request_id` едет в payload'е job'а. */
export const REQUEST_ID_PAYLOAD_KEY = 'request_id';

/** Заголовок для исходящих вызовов и для ответа клиенту. */
export const REQUEST_ID_HEADER = 'x-request-id';

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Присваивание по одному полю, а не `Object.assign`.
 *
 * При `exactOptionalPropertyTypes` присвоить `undefined` необязательному полю
 * нельзя, а `Object.assign` затёр бы значение родительского контекста
 * отсутствующим полем патча.
 */
function applyPatch(target: RequestContext, patch: ContextPatch): void {
  if (patch.requestId !== undefined) target.requestId = patch.requestId;
  if (patch.userId !== undefined) target.userId = patch.userId;
  if (patch.objectId !== undefined) target.objectId = patch.objectId;
  if (patch.revisionId !== undefined) target.revisionId = patch.revisionId;
  if (patch.route !== undefined) target.route = patch.route;
  if (patch.jobType !== undefined) target.jobType = patch.jobType;
  if (patch.jobId !== undefined) target.jobId = patch.jobId;
  if (patch.attempt !== undefined) target.attempt = patch.attempt;
}

/**
 * Выполняет `fn` в новом контексте, наследуя поля текущего.
 *
 * Возвращает результат `fn` как есть: для асинхронной функции это её промис, и
 * контекст сохраняется во всех её продолжениях.
 */
export function runWithContext<T>(seed: ContextPatch, fn: () => T): T {
  const parent = storage.getStore();
  const context: RequestContext = {
    requestId: seed.requestId ?? parent?.requestId ?? newRequestId(),
  };
  if (parent) applyPatch(context, parent);
  applyPatch(context, seed);
  return storage.run(context, fn);
}

export function currentContext(): Readonly<RequestContext> | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Дополняет текущий контекст. Возвращает `false`, если контекста нет. */
export function updateContext(patch: ContextPatch): boolean {
  const context = storage.getStore();
  if (!context) return false;
  applyPatch(context, patch);
  return true;
}

/** Поля контекста в том виде, в котором они попадают в лог. */
export function traceFields(): Record<string, string | number> {
  const context = storage.getStore();
  if (!context) return {};

  const fields: Record<string, string | number> = { request_id: context.requestId };
  if (context.userId !== undefined) fields.user_id = context.userId;
  if (context.objectId !== undefined) fields.object_id = context.objectId;
  if (context.revisionId !== undefined) fields.revision_id = context.revisionId;
  if (context.route !== undefined) fields.route = context.route;
  if (context.jobType !== undefined) fields.job_type = context.jobType;
  if (context.jobId !== undefined) fields.job_id = context.jobId;
  if (context.attempt !== undefined) fields.attempt = context.attempt;
  return fields;
}

/** Заголовки для исходящего вызова: цепочка не должна обрываться на границе. */
export function traceHeaders(): Record<string, string> {
  const requestId = currentRequestId();
  return requestId === undefined ? {} : { [REQUEST_ID_HEADER]: requestId };
}

/** Добавляет `request_id` в payload job'а — воркер поднимет из него контекст. */
export function tracePayload<T extends Record<string, unknown>>(payload: T): T {
  const requestId = currentRequestId();
  if (requestId === undefined) return payload;
  return { ...payload, [REQUEST_ID_PAYLOAD_KEY]: requestId };
}

export function requestIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[REQUEST_ID_PAYLOAD_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Отметка «у этого логгера поля контекста подмешиваются автоматически».
 *
 * `Symbol.for` — чтобы отметка выжила при двух копиях модуля в дереве
 * зависимостей. Дочерние логгеры pino создаются через `Object.create(parent)`,
 * поэтому отметка наследуется.
 */
const TRACE_MIXIN = Symbol.for('id.observability.trace-mixin');

export function markTraceMixin(logger: object): void {
  Object.defineProperty(logger, TRACE_MIXIN, { value: true, enumerable: false });
}

export function hasTraceMixin(logger: object): boolean {
  return TRACE_MIXIN in logger;
}

/**
 * Дочерний логгер с дополнительными постоянными полями (компонент, job).
 *
 * Поля контекста добавляются только логгеру без mixin'а: у логгера из
 * `createLogger()` они и так попадают в каждую строку, а второй источник тех же
 * ключей дал бы в JSON два поля `request_id` — часть парсеров прочитает не то.
 */
export function childLogger(base: Logger, bindings: Record<string, unknown> = {}): Logger {
  return base.child(hasTraceMixin(base) ? bindings : { ...traceFields(), ...bindings });
}
