/**
 * Транспортный слой API (§14): конверт ошибок, курсорная пагинация,
 * заголовки идемпотентности и оптимистичной блокировки.
 *
 * Здесь нет ни одной доменной сущности — только форма, общая для всех
 * эндпоинтов `/api/v1/*`.
 */

import { z } from 'zod';

// =====================================================================
// Заголовки и типы содержимого
// =====================================================================

/**
 * Ключ идемпотентности (§14).
 *
 * Ставится на `upload complete`, `freeze`, `recognize`, `checks` и действиях
 * workflow — там, где повтор запроса после сетевого таймаута иначе создал бы
 * вторую ревизию разметки или второй прогон OCR на GPU.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Оптимистичная блокировка (§7.2).
 *
 * Ставится на редактировании разметки, документов и реквизитов. При
 * несовпадении версии пользователь получает 412 и сравнение версий, а не
 * молчаливую перезапись чужой правки.
 */
export const IF_MATCH_HEADER = 'If-Match';

/** Ответный заголовок, значение которого клиент возвращает в `If-Match`. */
export const ETAG_HEADER = 'ETag';

/** Тип содержимого ответа об ошибке (RFC 9457). */
export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

/**
 * Значение `type` по умолчанию для проблемы без собственного URI (RFC 9457).
 *
 * При `about:blank` клиент обязан трактовать `title` как стандартную фразу
 * HTTP-статуса, поэтому свои формулировки требуют своего `type`.
 */
export const BLANK_PROBLEM_TYPE = 'about:blank';

/**
 * Ключ идемпотентности как значение: непустая печатаемая ASCII-строка.
 *
 * Ограничение сверху не декоративное — ключ уходит в `jobs.dedupe_key` и в
 * индекс, а произвольно длинная строка от клиента туда попадать не должна.
 */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Ключ идемпотентности — печатаемые ASCII-символы без пробелов');

// =====================================================================
// Ошибки: RFC 9457 Problem Details
// =====================================================================

/**
 * Одна ошибка валидации внутри проблемы.
 *
 * `pointer` — JSON Pointer (RFC 6901) на поле тела запроса; для ошибок, не
 * привязанных к полю, он null. Массив таких ошибок — расширение RFC 9457:
 * стандарт его не описывает, но и не запрещает, а форма ответа «одно
 * сообщение на весь запрос» не годится для формы с двумя десятками полей.
 */
export const problemErrorSchema = z.object({
  pointer: z.string().nullable(),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2000),
});
export type ProblemError = z.infer<typeof problemErrorSchema>;

/**
 * Тело ответа об ошибке (RFC 9457).
 *
 * `type` имеет значение по умолчанию, поэтому у схемы различаются вход и
 * выход: при построении проблемы поле можно опустить (`ProblemDetailsInput`),
 * а разобранный ответ его всегда содержит (`ProblemDetails`).
 *
 * `requestId` — расширение: без сквозного идентификатора запроса (§11) путь
 * поставки через два десятка задач по логам не восстанавливается, а
 * пользователь не может назвать поддержке ничего, кроме текста ошибки.
 */
export const problemDetailsSchema = z.object({
  type: z.string().min(1).max(2048).default(BLANK_PROBLEM_TYPE),
  title: z.string().min(1).max(500),
  status: z.int().min(100).max(599),
  detail: z.string().max(4000).optional(),
  instance: z.string().max(2048).optional(),
  errors: z.array(problemErrorSchema).optional(),
  requestId: z.string().max(128).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ProblemDetailsInput = z.input<typeof problemDetailsSchema>;

// =====================================================================
// Курсорная пагинация
// =====================================================================

/** Значение по умолчанию и потолок размера страницы. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/**
 * Параметры запроса страницы.
 *
 * Курсор непрозрачен для клиента: смещения нет, поэтому вставка строки не
 * сдвигает выдачу и не приводит к пропуску записей при листании.
 */
export const cursorPageQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;
export type CursorPageQueryInput = z.input<typeof cursorPageQuerySchema>;

/** Страница выдачи. `nextCursor === null` означает, что данных больше нет. */
export interface CursorPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

/**
 * Схема страницы для конкретного типа элемента.
 *
 * Функция, а не готовая схема: `items` типизируется схемой элемента, иначе
 * ответ списочного эндпоинта проверялся бы только по конверту.
 */
export function cursorPageSchema<TItem extends z.ZodType>(itemSchema: TItem) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().min(1).nullable(),
  });
}
