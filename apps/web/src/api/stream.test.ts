/**
 * Разбор потока событий (§3.8, гейт §17).
 *
 * Проверяется не «умеет ли браузер SSE», а ровно то, что здесь написано руками
 * и потому может быть неверным: сборка кадра, разрезанного границей сетевого
 * чанка, доставка события с ЛЮБЫМ именем и передача `Last-Event-ID`.
 *
 * Разрез посреди кадра — не редкий случай, а норма: TCP режет поток где угодно,
 * и первая же реализация, которая разбирает буфер целиком, теряет половину
 * событий на длинной ленте. Дефект при этом выглядит как «сервер не присылает
 * события», то есть отправляет чинить не тот конец.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readEventStream, type SseFrame } from './stream.js';

/** Ответ с телом, отдающим заранее заданные куски. */
function streamOf(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(chunks: readonly string[]): Promise<{
  frames: SseFrame[];
  retries: number[];
  headers: Headers;
  url: string;
}> {
  const frames: SseFrame[] = [];
  const retries: number[] = [];
  let seenUrl = '';
  let seenHeaders = new Headers();

  const fetchStub = vi.fn((input: unknown, init?: RequestInit) => {
    seenUrl = String(input);
    seenHeaders = new Headers(init?.headers);
    return Promise.resolve(streamOf(chunks));
  });
  vi.stubGlobal('fetch', fetchStub);

  await readEventStream({
    url: '/api/v1/folders/r1/events',
    lastEventId: '17',
    signal: new AbortController().signal,
    onFrame: (frame) => frames.push(frame),
    onRetryHint: (delay) => retries.push(delay),
  });

  return { frames, retries, headers: seenHeaders, url: seenUrl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readEventStream', () => {
  it('собирает кадр, разрезанный границей чанка', async () => {
    const { frames } = await collect([
      'event: recognition.sta',
      'rted\ndata: {"seq":18',
      '}\n\nevent: job.succeeded\ndata: {"seq":19}\n\n',
    ]);

    expect(frames.map((frame) => frame.event)).toEqual(['recognition.started', 'job.succeeded']);
    expect(frames[0]?.data).toBe('{"seq":18}');
  });

  it('доставляет событие с любым именем, а не только `message`', async () => {
    const { frames } = await collect([
      'id: 20\nevent: documents.pages_classified\ndata: {"seq":20}\n\n',
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('documents.pages_classified');
    expect(frames[0]?.id).toBe('20');
  });

  it('пульс-комментарий и поле retry не становятся событиями', async () => {
    const { frames, retries } = await collect([
      'retry: 3000\n\n',
      ': ping\n\n',
      'event: file.uploaded\ndata: {}\n\n',
    ]);

    expect(retries).toEqual([3000]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('file.uploaded');
  });

  it('переносит Last-Event-ID заголовком: пропущенное запрашивается, а не теряется', async () => {
    const { headers } = await collect(['event: ping\ndata: {}\n\n']);

    expect(headers.get('last-event-id')).toBe('17');
    expect(headers.get('accept')).toBe('text/event-stream');
  });

  it('склеивает многострочные данные переводом строки, как требует спецификация', async () => {
    const { frames } = await collect(['event: x\ndata: первая\ndata: вторая\n\n']);

    expect(frames[0]?.data).toBe('первая\nвторая');
  });

  it('понимает разделитель CRLF наравне с LF', async () => {
    const { frames } = await collect(['event: a\r\ndata: {}\r\n\r\nevent: b\r\ndata: {}\r\n\r\n']);

    expect(frames.map((frame) => frame.event)).toEqual(['a', 'b']);
  });

  it('отклонённый поток — это отказ, а не пустая лента', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('нет', { status: 403 }))),
    );

    await expect(
      readEventStream({
        url: '/api/v1/folders/r1/events',
        lastEventId: null,
        signal: new AbortController().signal,
        onFrame: () => undefined,
      }),
    ).rejects.toThrow('HTTP 403');
  });
});
