/**
 * Чтение потока `text/event-stream` (§3.8, §14).
 *
 * ## Почему не `EventSource`
 *
 * `EventSource` доставляет события ТОЛЬКО тем слушателям, чьё имя названо
 * заранее: `onmessage` срабатывает лишь на кадры без поля `event`, а портал
 * присылает исключительно именованные — `file.uploaded`, `layout.frozen`,
 * `job.dead` и так далее. Подписка на фиксированный список имён означала бы, что
 * событие, добавленное на сервере завтра, экран молча не заметит: он выглядел бы
 * работающим и был бы слеп. Это ровно тот класс отказов, который проект ловит
 * восемь этапов подряд, и открытый мир §0.5 требует обратного — незнакомое
 * значение обязано быть замечено.
 *
 * Чтение через `fetch` + `ReadableStream` даёт кадр целиком, с любым именем, и
 * заодно позволяет поставить `Last-Event-ID` заголовком ЯВНО, а не полагаться на
 * то, что браузер сделает это сам при своём переподключении.
 *
 * ## Что здесь НЕ делается
 *
 * Ни повторов, ни таймеров: разрыв возвращается вызывающему как завершение
 * функции. Политика переподключения — вопрос экрана (сколько ждать, когда
 * сдаться, чем заменить поток), и зашивать её в разборщик значило бы принимать
 * это решение за него.
 */

import { retryAfterMsOf } from './problem.js';

/**
 * Поток отклонён ответом сервера.
 *
 * Отдельный класс, а не `Error` с текстом: политика переподключения живёт в
 * экране (`features/revision/stream.tsx`), и решать «ждать названную паузу или
 * считать попытку неудачной» он обязан по коду ответа, а не разбором строки.
 */
export class StreamRejected extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null) {
    super(
      status === 429
        ? 'Поток событий придержан: слишком много запросов'
        : `Поток событий отклонён: HTTP ${String(status)}`,
    );
    this.name = 'StreamRejected';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Кадр потока: имя, данные и номер, если сервер его назвал. */
export interface SseFrame {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

export interface SseOptions {
  readonly url: string;
  /** Значение `Last-Event-ID`: с него сервер повторяет пропущенное. */
  readonly lastEventId: string | null;
  readonly signal: AbortSignal;
  /** Соединение установлено и заголовки приняты. */
  readonly onOpen?: () => void;
  readonly onFrame: (frame: SseFrame) => void;
  /** Сервер попросил другую паузу перед повтором (поле `retry`). */
  readonly onRetryHint?: (delayMs: number) => void;
}

/**
 * Разбор одного кадра.
 *
 * Кадр — это блок строк до пустой строки. Строка, начинающаяся с двоеточия, —
 * комментарий (им сервер шлёт пульс `: ping`), и её надо пропустить, а не
 * принять за поле с пустым именем.
 */
function parseFrame(block: string): { frame: SseFrame | null; retryMs: number | null } {
  let id: string | null = null;
  let event = 'message';
  let retryMs: number | null = null;
  const data: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // По спецификации ровно один пробел после двоеточия принадлежит разделителю,
    // а не значению.
    const rest = colon === -1 ? '' : line.slice(colon + 1);
    const value = rest.startsWith(' ') ? rest.slice(1) : rest;

    switch (field) {
      case 'id':
        id = value;
        break;
      case 'event':
        event = value;
        break;
      case 'data':
        data.push(value);
        break;
      case 'retry': {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) retryMs = parsed;
        break;
      }
      default:
        // Незнакомое поле игнорируется — так требует спецификация.
        break;
    }
  }

  // Кадр без данных — это служебное сообщение (`retry`, пульс), а не событие.
  if (data.length === 0) return { frame: null, retryMs };
  return { frame: { id, event, data: data.join('\n') }, retryMs };
}

/**
 * Чтение потока до разрыва, отмены или конца.
 *
 * Возвращается управление, когда поток закончился. Ошибка сети пробрасывается
 * исключением; отмена по `signal` — тоже (`AbortError`), и вызывающий обязан
 * отличать её от разрыва: отменяет он сам, а разрывает сеть.
 */
export async function readEventStream(options: SseOptions): Promise<void> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.lastEventId !== null) headers['last-event-id'] = options.lastEventId;

  const response = await fetch(options.url, {
    method: 'GET',
    // Тот же режим, что у остального транспорта: cookie сессии уходит только на
    // собственный origin (см. `api/http.ts`).
    credentials: 'same-origin',
    headers,
    signal: options.signal,
    // Кэш браузера на потоке событий означал бы повтор старой ленты вместо новой.
    cache: 'no-store',
  });

  if (!response.ok) {
    // 429 отличается от прочих отказов и по причине, и по лечению: поток не
    // сломан, у вкладки просто кончился бюджет запросов. Обычная ошибка сожгла
    // бы одну из пяти попыток переподключения и приблизила переход в `lost`, где
    // свежесть держит опрос — то есть исчерпание лимита включало бы более
    // прожорливый режим. Здесь вместо этого называется пауза, которую назвал
    // сервер, и вызывающий её выжидает.
    throw new StreamRejected(response.status, retryAfterMsOf(response));
  }
  const body = response.body;
  if (body === null) throw new Error('Браузер не отдал тело потока событий');

  options.onOpen?.();

  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;

      // Кадры разделяются пустой строкой. Хвост без разделителя остаётся в
      // буфере: TCP режет поток произвольно, и половина кадра — норма.
      for (;;) {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary === -1) break;
        const block = buffer.slice(0, boundary);
        const match = /\r?\n\r?\n/.exec(buffer.slice(boundary));
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));

        const { frame, retryMs } = parseFrame(block);
        if (retryMs !== null) options.onRetryHint?.(retryMs);
        if (frame !== null) options.onFrame(frame);
      }
    }
  } finally {
    // Закрыть читателя обязательно: без этого соединение остаётся занятым до
    // сборки мусора, и вкладка копит открытые сокеты при каждом переподключении.
    // Отменяется именно читатель, а не `response.body`: тело уже заблокировано
    // `pipeThrough`, и `body.cancel()` на нём бросает `TypeError`.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
