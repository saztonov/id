/**
 * Управляемая очередь HTTP-запросов портала (S24).
 *
 * ## Зачем она появилась
 *
 * Экран ревизии выбирал серверный лимит в 300 запросов/минуту на IP за
 * несколько секунд и после этого не восстанавливался. Разбор цепочки показал,
 * что виновата не одна ошибка, а отсутствие места, где вообще принимается
 * решение «сколько запросов и когда»:
 *
 *   1. воркер шлёт по два события на задачу (`job.started`, `job.succeeded`), и
 *      разметка комплекта в сотню страниц даёт сотни событий;
 *   2. поток отдаёт их пачками до двухсот кадров подряд;
 *   3. каждый кадр инвалидировал сводку конвейера;
 *   4. `invalidateQueries` в TanStack Query v5 по умолчанию идёт с
 *      `cancelRefetch: true` — то есть ОТМЕНЯЕТ идущий запрос и начинает новый,
 *      а не схлопывается с ним;
 *   5. отмена не доходила до сети: `AbortSignal` в `fetch` не передавался, и
 *      «отменённый» запрос всё равно съедал слот лимита;
 *   6. `retry: 1` в клиенте кэша повторял и 429 — в тот момент, когда сервер
 *      прямым текстом просил перестать;
 *   7. когда 429 начинал получать сам поток событий, экран сваливался на опрос
 *      — то есть исчерпание лимита само переводило его в более прожорливый
 *      режим и удерживало там.
 *
 * Ретраи при этом были размазаны по трём файлам (`http.ts` — повтор CSRF,
 * `App.tsx` — `retry: 1`, `stream.tsx` — backoff потока), дедупликации не было
 * вовсе, темп не ограничивался ничем.
 *
 * ## Что здесь решается, а что нет
 *
 * Очередь отвечает ровно за транспорт: темп, параллелизм, дедупликацию,
 * повторы, паузу по требованию сервера. Она НЕ знает ни про CSRF (это протокол
 * приложения, он остался в `http.ts`), ни про кэш, ни про экраны.
 *
 * Обратное тоже верно: коалесценция инвалидаций живёт в
 * `features/folder/stream.tsx`, потому что «пачка событий обесценивает одно и
 * то же» — знание о событиях, а не о сети. Очередь схлопнула бы эти запросы и
 * сама, но только те, что пересеклись в полёте; пришедшие подряд она честно
 * выполнит все.
 *
 * ## Почему пауза общая, а не на запрос
 *
 * Ответ 429 означает «у тебя кончился бюджет», а бюджет один на весь API
 * (`keyGenerator: request.ip` в `apps/api/src/app.ts`). Придержать только
 * запрос-виновник значит дать остальным продолжать выбивать лимит, пока сервер
 * просит остановиться, — и пауза никогда не кончится.
 */
import { ApiError, parseProblem, retryAfterMsOf } from './problem.js';

/** Одновременных запросов. Через HTTP/2 браузер своего потолка не ставит. */
const MAX_CONCURRENT = 6;

/**
 * Потолок темпа в скользящем окне.
 *
 * 180 при серверных 300 — запас намеренный: тем же бюджетом пользуются мутации,
 * поток событий, вторая открытая вкладка портала и коллега за тем же NAT (ключ
 * лимита — публичный адрес). Упереться в СВОЙ потолок безопасно: очередь просто
 * подождёт. Упереться в серверный — значит получить 429 и потерять поток.
 */
const MAX_PER_WINDOW = 180;
const WINDOW_MS = 60_000;

/** Пауза по 429, когда сервер не назвал `Retry-After`. */
const DEFAULT_PAUSE_MS = 5_000;
/** Потолок паузы: дольше держать экран замороженным бессмысленно. */
const MAX_PAUSE_MS = 60_000;

/** Попыток всего, считая первую. */
const MAX_ATTEMPTS = 3;
/** Основание экспоненциальной задержки для сетевых и 5xx отказов. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/**
 * Класс запроса.
 *
 * Различие не косметическое: у чтения повтор безопасен всегда, а у мутации —
 * только когда точно известно, что обработчик не начинал работу. Отказ по
 * лимиту как раз такой: `@fastify/rate-limit` отвергает запрос хуком
 * `onRequest`, то есть до маршрута. Сетевой обрыв — противоположный случай:
 * ответ мог потеряться уже после того, как сервер всё сделал.
 */
export type RequestKind = 'read' | 'mutation';

export interface QueuedRequest {
  readonly kind: RequestKind;
  /**
   * Ключ дедупликации; `null` — не дедуплицировать.
   *
   * Совпадение ключа означает «эти запросы неразличимы по результату». Для
   * мутаций всегда `null`: два одинаковых POST — это два намерения, даже если
   * тела совпали побайтово.
   */
  readonly dedupeKey: string | null;
  /**
   * Отправка одной попытки. Функция, а не готовый `Request`: между попытками
   * заголовки могут смениться (обновлённый CSRF-токен), и замороженный объект
   * запроса повторился бы со старым.
   */
  readonly send: (signal: AbortSignal) => Promise<Response>;
  readonly signal?: AbortSignal | undefined;
}

interface Waiting {
  readonly run: () => Promise<void>;
}

/** Отметки времени отправленных запросов — скользящее окно темпа. */
let sent: number[] = [];
let active = 0;
let pausedUntil = 0;

/**
 * Мутации и чтения ждут в разных очередях.
 *
 * Нажатие кнопки не должно стоять за полусотней фоновых обновлений: человек
 * ждёт результата своего действия, а сводка конвейера подождёт секунду.
 */
const mutations: Waiting[] = [];
const reads: Waiting[] = [];

/** Запросы в полёте по ключу дедупликации. */
const inFlight = new Map<string, Promise<Response>>();

/** Подписчики на паузу: их будит очередь, а не таймер каждого. */
const pauseListeners = new Set<(untilMs: number) => void>();

/**
 * Подписка на паузу по лимиту.
 *
 * Пауза — это не ошибка, а нормальный ответ на «слишком быстро», и пользователю
 * о ней говорят иначе, чем об отказе: данные на экране остаются годными,
 * обновление просто задержится. Красный экран здесь был бы враньём.
 */
export function onRateLimitPause(listener: (untilMs: number) => void): () => void {
  pauseListeners.add(listener);
  return () => {
    pauseListeners.delete(listener);
  };
}

/** Момент, до которого очередь придержана; `0` — пауза не действует. */
export function pausedUntilMs(): number {
  return pausedUntil > Date.now() ? pausedUntil : 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Сколько ждать до освобождения слота в окне темпа; `0` — можно сейчас. */
function windowDelayMs(now: number): number {
  sent = sent.filter((at) => now - at < WINDOW_MS);
  if (sent.length < MAX_PER_WINDOW) return 0;
  const oldest = sent[0];
  return oldest === undefined ? 0 : Math.max(1, WINDOW_MS - (now - oldest));
}

function pause(ms: number): void {
  const until = Date.now() + Math.min(Math.max(ms, 1_000), MAX_PAUSE_MS);
  if (until <= pausedUntil) return;
  pausedUntil = until;
  for (const listener of pauseListeners) listener(until);
}

/**
 * Насос очереди.
 *
 * Одна точка, которая решает «можно ли отправлять прямо сейчас». Проверок три, и
 * порядок между ними значения не имеет: любая из них задерживает отправку, а
 * повторный вызов придёт либо по таймеру, либо по завершении соседа.
 */
function pump(): void {
  if (active >= MAX_CONCURRENT) return;
  if (mutations.length === 0 && reads.length === 0) return;

  const now = Date.now();
  if (pausedUntil > now) {
    setTimeout(pump, pausedUntil - now);
    return;
  }
  const delay = windowDelayMs(now);
  if (delay > 0) {
    setTimeout(pump, delay);
    return;
  }

  const next = mutations.shift() ?? reads.shift();
  if (next === undefined) return;

  active += 1;
  sent.push(Date.now());
  void next.run().finally(() => {
    active -= 1;
    pump();
  });
  // Соседний слот мог освободиться раньше: пробуем занять и его.
  pump();
}

function schedule(kind: RequestKind, run: () => Promise<void>): void {
  (kind === 'mutation' ? mutations : reads).push({ run });
  pump();
}

/** Отправка одной попытки через очередь: ожидание слота, затем сам запрос. */
function dispatch(request: QueuedRequest, signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    schedule(request.kind, async () => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Запрос отменён'));
        return;
      }
      try {
        resolve(await request.send(signal));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Сетевой отказ `fetch` — `TypeError`; отмена — `AbortError`, и она не повод повторять. */
function isNetworkFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  return error instanceof TypeError;
}

function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  // Джиттер обязателен: без него все запросы, отбитые одним отказом, вернутся
  // ровно в одну миллисекунду и воспроизведут ту же пачку, что их и погубила.
  return base / 2 + Math.random() * (base / 2);
}

/**
 * Повторяем ли этот ответ.
 *
 * 429 повторяется для обоих классов: лимит отвергает запрос до обработчика,
 * значит сайд-эффекта не было. 5xx и сетевой отказ — только для чтения: у
 * мутации исход неизвестен, и повтор мог бы сделать работу дважды.
 */
function retryableStatus(status: number, kind: RequestKind): boolean {
  if (status === 429) return true;
  if (kind === 'mutation') return false;
  return status === 502 || status === 503 || status === 504;
}

async function attemptOnce(
  request: QueuedRequest,
  signal: AbortSignal,
  attempt: number,
): Promise<Response | 'retry'> {
  let response: Response;
  try {
    response = await dispatch(request, signal);
  } catch (error) {
    if (attempt < MAX_ATTEMPTS && request.kind === 'read' && isNetworkFailure(error, signal)) {
      await wait(backoffMs(attempt));
      return 'retry';
    }
    throw error;
  }

  if (response.ok || !retryableStatus(response.status, request.kind)) return response;

  // Пауза берётся из ответа ДО решения о повторе: даже последняя попытка обязана
  // придержать очередь — иначе следующий запрос уйдёт в тот же закрытый лимит.
  const retryAfter = retryAfterMsOf(response);
  if (response.status === 429) pause(retryAfter ?? DEFAULT_PAUSE_MS);

  if (attempt >= MAX_ATTEMPTS) return response;

  // Тело неудачной попытки читать некому: без этого соединение остаётся занятым
  // до сборки мусора.
  await response.body?.cancel().catch(() => undefined);
  await wait(response.status === 429 ? (retryAfter ?? DEFAULT_PAUSE_MS) : backoffMs(attempt));
  return 'retry';
}

async function runWithRetries(request: QueuedRequest, signal: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await attemptOnce(request, signal, attempt);
    if (outcome !== 'retry') return outcome;
  }
}

/**
 * Отправка запроса через очередь.
 *
 * Возвращает `Response` как есть — разбор конверта ошибки остаётся за
 * `http.ts`. Исключение одно: 429, исчерпавший повторы, превращается в
 * `ApiError` прямо здесь, чтобы `retryAfterMs` не потерялся вместе с
 * заголовками ответа.
 */
export async function submit(request: QueuedRequest): Promise<Response> {
  const key = request.dedupeKey;

  // Дедупликация ТОЛЬКО в полёте. Ключ снимается сразу по завершении: кэш
  // ответов — дело TanStack Query, и очередь не должна иметь второго мнения о
  // свежести данных.
  if (key !== null) {
    const existing = inFlight.get(key);
    // `clone()` обязателен: тело ответа читается один раз, и второй ожидающий
    // получил бы пустой поток.
    if (existing !== undefined) return (await existing).clone();
  }

  const controller = new AbortController();
  const outer = request.signal;
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else {
      outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }
  }

  const promise = runWithRetries(request, controller.signal);
  if (key !== null) {
    inFlight.set(key, promise);
    void promise
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(key);
      });
  }

  const response = await promise;
  if (response.status === 429) {
    throw new ApiError(429, await parseProblem(response), 'HTTP 429', retryAfterMsOf(response));
  }
  return key === null ? response : response.clone();
}

/** Сброс состояния между тестами: модуль хранит темп и паузу в себе. */
export function resetQueueForTests(): void {
  sent = [];
  active = 0;
  pausedUntil = 0;
  mutations.length = 0;
  reads.length = 0;
  inFlight.clear();
}
