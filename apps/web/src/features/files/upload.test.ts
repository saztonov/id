/**
 * Заливка байтов: повтор временного отказа и отчёт об окончательном.
 *
 * Проверяется поведение, которого 26 августа 2026 года не было и которое стоило
 * подрядчику загрузки: три подряд `HTTP 500` от хранилища закончились отказом
 * при живом бакете, а в журнал портала из трёх отказов приехал один.
 *
 * `fetch` подменён целиком: настоящего адреса заливки в тестах нет, а важна
 * последовательность попыток, а не байты.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadTicket } from '../../api/types.js';
import { uploadToTicket } from './upload.js';

const reportClientError = vi.hoisted(() => vi.fn(() => 'ev-0001'));
vi.mock('../../app/errorReporting.js', () => ({ reportClientError }));
// Модуль тянет `endpoints.js` ради `init`/`complete`; здесь проверяется только
// заливка, а настоящий модуль потащил бы за собой транспорт и CSRF.
vi.mock('../../api/endpoints.js', () => ({ files: {} }));

const TICKET: UploadTicket = {
  uploadId: 'ticket',
  uploadUrl: 'https://s3.example/id1/uploads/aaaa',
  method: 'PUT',
  headers: {},
  expiresAt: '2026-08-26T15:00:00.000Z',
  maxBytes: 1024,
};

const FILE = new File([new Uint8Array([1, 2, 3])], 'скан.pdf', { type: 'application/pdf' });

const INTERNAL_ERROR = `<Error><Code>InternalError</Code><Message>x</Message><RequestId>TX42</RequestId></Error>`;

function response(status: number, body: string): Response {
  return new Response(body, { status });
}

/**
 * Довести заливку до конца, прокрутив паузы между попытками.
 *
 * Часы подменены, иначе тест ждал бы паузы по-настоящему. Исход возвращается
 * значением, а не бросается: промис создаётся до прокрутки, и необработанный
 * отказ в этом промежутке был бы засчитан окружением как падение теста.
 */
async function settle(promise: Promise<void>): Promise<Error | 'ok'> {
  const outcome = promise.then(
    () => 'ok' as const,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
  reportClientError.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('uploadToTicket', () => {
  it('переживает два временных отказа подряд', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(500, INTERNAL_ERROR))
      .mockResolvedValueOnce(response(503, ''))
      .mockResolvedValueOnce(response(200, ''));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();

    expect(await settle(uploadToTicket(TICKET, FILE, onRetry))).toBe('ok');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 2, 3, expect.stringContaining('InternalError'));
    // Успех после повтора — не происшествие: в журнал ничего не уходит.
    expect(reportClientError).not.toHaveBeenCalled();
  });

  it('не повторяет просроченную подпись', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          response(403, '<Error><Code>SignatureDoesNotMatch</Code><Message>x</Message></Error>'),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();

    const outcome = await settle(uploadToTicket(TICKET, FILE, onRetry));

    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain('начните загрузку заново');
    // Вторая попытка получила бы ровно тот же отказ: ссылка не оживёт.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('окончательный отказ называет код и уходит в журнал со статусом', async () => {
    // Ответ строится на каждый вызов: тело `Response` читается один раз, и один
    // объект на три попытки лгал бы — вторая и третья получили бы пустое тело.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(500, INTERNAL_ERROR)));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await settle(uploadToTicket(TICKET, FILE));

    expect(String(outcome)).toContain('InternalError');
    // Номер обращения — единственное, чем запись журнала и жалоба пользователя
    // сопоставляются: `request_id` у заливки мимо портала не существует.
    expect(String(outcome)).toContain('обращение ev-0001');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reportClientError).toHaveBeenCalledTimes(1);
    expect(reportClientError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('TX42') }),
      { kind: 'manual', statusCode: 500, errorCode: 'InternalError' },
    );
  });

  it('обрыв сети повторяется, а не выдаётся за отказ хранилища', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(200, ''));
    vi.stubGlobal('fetch', fetchMock);

    expect(await settle(uploadToTicket(TICKET, FILE))).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
