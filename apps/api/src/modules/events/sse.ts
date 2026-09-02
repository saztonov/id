/**
 * Поток событий ревизии (SSE) и вычисляемая сводка обработки (§3.8, §14).
 *
 * ## Почему это поток, а не источник правды
 *
 * REST остаётся источником текущего состояния. Поток — уведомление: он говорит
 * «посмотри ещё раз», а не «вот как теперь всё устроено». Потеря соединения на
 * конвейер не влияет вовсе, и именно поэтому здесь нет ни очереди на сервере,
 * ни подтверждений доставки: клиент, потерявший события, перечитывает состояние
 * обычным GET.
 *
 * ## Last-Event-ID и повтор пропущенного
 *
 * `folder_events.seq` монотонен внутри ревизии (миграция 0007), поэтому
 * реконнект с `Last-Event-ID` отдаёт ровно пропущенное. Отдельно различается
 * случай, когда пропущенное уже вне окна хранения: клиент получает событие
 * `reset` и обязан перечитать состояние по REST. Молча начать с текущего
 * момента нельзя — экран остался бы с дырой в истории, не зная об этом.
 *
 * ## Изоляция
 *
 * Принадлежность ревизии области видимости проверяется ДО открытия потока
 * (§16: поток событий — один из четырёх путей обхода изоляции). Проверка
 * делается один раз, при открытии: ни объект, ни подрядчик у ревизии не
 * меняются (§3.9), а повторять её на каждом опросе значило бы утроить число
 * запросов к БД на каждое открытое соединение.
 *
 * ## Опрос, а не LISTEN/NOTIFY
 *
 * Слушатель `NOTIFY` требует ВЫДЕЛЕННОГО соединения на процесс и не переживает
 * обрыв без своей логики переподключения, а на pglite (гейты этапов) его нет
 * вовсе. Опрос раз в секунду по первичному ключу `(folder_id, seq)` стоит
 * одного index scan и даёт то же ощущение живого экрана.
 */
import type { FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { processingStageSchema } from '@id/contracts';
import type { AppInstance } from '../../app.js';
import { notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import {
  computeProcessingStatus,
  findVisibleFolder,
  readFolderEvents,
} from '../../db/repositories/jobs.js';

const PREFIX = '/api/v1/folders';

/** Интервал опроса ленты событий. */
const POLL_INTERVAL_MS = 1_000;
/** Сколько событий отдаётся за один проход: реконнект после долгого отсутствия. */
const BATCH_LIMIT = 200;
/** Комментарий-пульс: без него прокси закрывает простаивающее соединение. */
const HEARTBEAT_MS = 15_000;
/**
 * Потолок жизни соединения.
 *
 * EventSource переподключается сам и присылает `Last-Event-ID`, поэтому
 * периодическое закрытие ничего не теряет, зато не даёт накопиться соединениям,
 * которые клиент давно забыл (закрытая вкладка, уснувший ноутбук).
 */
const MAX_CONNECTION_MS = 30 * 60_000;
/** Пауза перед повтором подключения на стороне клиента. */
const CLIENT_RETRY_MS = 3_000;

const folderParamsSchema = z.object({ folderId: z.uuid() });

const eventsQuerySchema = z.object({
  /** Дубль `Last-Event-ID` для клиентов, которым нечем поставить заголовок. */
  lastEventId: z.coerce.number().int().nonnegative().optional(),
});

const stageSummarySchema = z.object({
  stage: processingStageSchema,
  attempts: z.int(),
  succeeded: z.int(),
  failed: z.int(),
  inFlight: z.int(),
  pending: z.int(),
  totalDurationMs: z.int(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const jobTypeSummarySchema = z.object({
  jobType: z.string(),
  stage: processingStageSchema.nullable(),
  attempts: z.int(),
  succeeded: z.int(),
  failed: z.int(),
  /** Попытки, окончившиеся ожиданием: условие ещё не наступило. */
  deferred: z.int(),
  leaseExpired: z.int(),
  inFlight: z.int(),
  /** Задачи этого типа, исчерпавшие попытки. Не попытки, а задачи. */
  dead: z.int(),
  totalDurationMs: z.int(),
  firstStartedAt: z.string().nullable(),
  lastFinishedAt: z.string().nullable(),
  lastErrorClass: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  lastReasonText: z.string().nullable(),
});

const processingStatusSchema = z.object({
  folderId: z.uuid(),
  stage: processingStageSchema,
  queued: z.int(),
  running: z.int(),
  dead: z.int(),
  attempts: z.int(),
  totalDurationMs: z.int(),
  elapsedMs: z.int().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  stages: z.array(stageSummarySchema),
  jobTypes: z.array(jobTypeSummarySchema),
  /**
   * Постраничный ход выделения блоков; `null` — считать нечего: рабочего
   * документа ещё нет либо стадия разметки прямо сейчас не идёт.
   *
   * Живёт здесь, а не отдельной ручкой по образцу прогресса распознавания:
   * экран уже опрашивает эту сводку, пока конвейер занят, и поток обесценивает
   * её на любое событие ревизии. Своя ручка потребовала бы своего опроса и
   * своей строки в `invalidateFor` — третьего механизма свежести на одном
   * экране.
   */
  layout: z
    .object({
      pagesTotal: z.int().nonnegative(),
      pagesDone: z.int().nonnegative(),
      pagesPending: z.int().nonnegative(),
      pagesFailed: z.int().nonnegative(),
    })
    .nullable(),
});

export function registerFolderEventRoutes(app: AppInstance): void {
  /**
   * Открытые потоки процесса.
   *
   * Нужны для остановки: `app.close()` ждёт закрытия соединений, а SSE по
   * построению не закрывается сам. Без этого списка graceful shutdown упирался
   * бы в таймаут при каждом открытом экране.
   *
   * Массив, а не `Set`: eslint-правило, запрещающее запросы к БД вне
   * `db/repositories/`, ищет вызовы `.delete()` по имени метода и не отличает
   * `set.delete()` от `db.delete()` (тот же обход — у маршрутов DELETE в
   * `modules/catalog/routes.ts`).
   */
  let openStreams: ServerResponse[] = [];

  app.addHook('onClose', () => {
    for (const stream of openStreams) stream.end();
    openStreams = [];
  });

  app.get(
    `${PREFIX}/:folderId/events`,
    {
      preHandler: requirePermission('submission.read'),
      schema: { params: folderParamsSchema, querystring: eventsQuerySchema },
    },
    async (request, reply) => {
      const { folderId } = request.params;
      const auth = currentAuth(request);

      // Принадлежность ревизии — до открытия потока. 404, а не 403: «ревизия
      // есть, но не ваша» само по себе сообщает о существовании чужой поставки.
      const folder = await findVisibleFolder(app.db, auth.scope, folderId);
      if (folder === null) throw notFound('Ревизия не найдена.');

      const startSeq = lastEventIdOf(request, request.query.lastEventId);

      reply.hijack();
      const stream = reply.raw;
      openStreams.push(stream);

      stream.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // nginx буферизует ответ по умолчанию, и события доходили бы пачками
        // по мере заполнения буфера — то есть экран «оживал» бы рывками.
        'x-accel-buffering': 'no',
      });
      stream.write(`retry: ${CLIENT_RETRY_MS}\n\n`);

      let closed = false;
      const close = (): void => {
        closed = true;
      };
      request.raw.on('close', close);
      request.raw.on('error', close);

      try {
        await pumpEvents(app, stream, {
          folderId,
          startSeq,
          isClosed: () => closed || stream.writableEnded,
        });
      } finally {
        openStreams = openStreams.filter((open) => open !== stream);
        if (!stream.writableEnded) stream.end();
      }
      return reply;
    },
  );

  /**
   * Сводка обработки ревизии — вычисляемая, а не хранимая (§3.8).
   *
   * Живёт рядом с потоком событий намеренно: это две стороны одного вопроса
   * «что сейчас с комплектом». Поток говорит «что-то изменилось», сводка
   * отвечает «вот что именно», и она же остаётся ответом, когда поток потерян.
   */
  app.get(
    `${PREFIX}/:folderId/processing-status`,
    {
      preHandler: requirePermission('submission.read'),
      schema: { params: folderParamsSchema, response: { 200: processingStatusSchema } },
    },
    async (request) => {
      const auth = currentAuth(request);
      const status = await computeProcessingStatus(app.db, auth.scope, request.params.folderId);
      if (status === null) throw notFound('Ревизия не найдена.');
      // Копии массивов: репозиторий отдаёт `readonly`, схема ответа ждёт
      // изменяемый — тот же приём, что в остальных маршрутах со списками.
      return { ...status, stages: [...status.stages], jobTypes: [...status.jobTypes] };
    },
  );
}

interface PumpOptions {
  readonly folderId: string;
  readonly startSeq: number;
  readonly isClosed: () => boolean;
}

/**
 * Повтор пропущенного, затем опрос новых событий.
 *
 * Первый проход отвечает и на вопрос «а не потеряно ли пропущенное»: если
 * клиент назвал `Last-Event-ID` меньше наименьшего сохранённого номера, значит
 * часть ленты уже вне окна хранения, и честный ответ — `reset`, а не тихое
 * продолжение с текущего момента.
 */
async function pumpEvents(
  app: AppInstance,
  stream: ServerResponse,
  options: PumpOptions,
): Promise<void> {
  const deadline = Date.now() + MAX_CONNECTION_MS;
  let cursor = options.startSeq;
  let lastWriteAt = Date.now();
  let checkedGap = false;

  while (!options.isClosed() && Date.now() < deadline) {
    const window = await readFolderEvents(app.db, {
      folderId: options.folderId,
      afterSeq: cursor,
      limit: BATCH_LIMIT,
    });

    if (!checkedGap) {
      checkedGap = true;
      const oldest = window.oldestSeq;
      if (cursor > 0 && oldest !== null && cursor + 1 < oldest) {
        writeEvent(stream, {
          id: null,
          event: 'reset',
          data: { reason: 'events-truncated', oldestSeq: oldest, requestedAfter: cursor },
        });
        lastWriteAt = Date.now();
      }
    }

    for (const event of window.events) {
      if (options.isClosed()) return;
      writeEvent(stream, {
        id: event.seq,
        event: event.eventType,
        data: { seq: event.seq, createdAt: event.createdAt, payload: event.payload },
      });
      cursor = event.seq;
      lastWriteAt = Date.now();
    }

    if (window.events.length === BATCH_LIMIT) continue;

    if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
      // Комментарий, а не событие: клиент его не увидит, но прокси и браузер
      // считают соединение живым.
      stream.write(': ping\n\n');
      lastWriteAt = Date.now();
    }

    await delay(POLL_INTERVAL_MS);
  }
}

interface SseFrame {
  readonly id: number | null;
  readonly event: string;
  readonly data: unknown;
}

function writeEvent(stream: ServerResponse, frame: SseFrame): void {
  if (stream.writableEnded) return;
  const lines: string[] = [];
  if (frame.id !== null) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${sanitizeField(frame.event)}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  stream.write(`${lines.join('\n')}\n\n`);
}

/**
 * Имя события — одна строка без управляющих символов.
 *
 * Имя приходит из `folder_events.event_type`, то есть из БД, а перевод строки
 * в нём разорвал бы кадр SSE и позволил бы подделать соседнее событие.
 */
function sanitizeField(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 120);
}

function lastEventIdOf(request: FastifyRequest, fromQuery: number | undefined): number {
  const header = request.headers['last-event-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fromQuery ?? 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Опрос не держит event loop: процесс, получивший SIGTERM, не должен ждать
    // ещё секунду на каждое открытое соединение.
    timer.unref();
  });
}
