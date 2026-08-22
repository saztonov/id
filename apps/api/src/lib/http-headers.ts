/**
 * Условные заголовки §14: `Idempotency-Key` и `If-Match`.
 *
 * ## Почему они живут здесь, а не в каждом модуле
 *
 * До S20 разбор `If-Match` был выписан в четырёх модулях маршрутов, а
 * `Idempotency-Key` — в двух. Копии совпадали посимвольно, и это худший случай
 * дублирования: расхождение в них не заметно ни на ревью, ни в тестах модуля —
 * каждая копия проверяется своим набором и остаётся зелёной, пока правку не
 * внесли ровно в неё. Пятая копия, добавленная ради маршрута сверки описи,
 * сделала бы это правилом.
 *
 * ## Название сущности — параметр, а не текст в сообщении
 *
 * Сообщения различались словом: «версией документа», «версией реестра»,
 * «версией разметки», «версией ревизии». Различие сохранено и вынесено в
 * аргумент: человек, получивший 400, должен понять, версию ЧЕГО у него не
 * приняли, — обобщённое «версией записи» отняло бы у отказа единственную
 * полезную часть.
 */

import type { FastifyRequest } from 'fastify';
import { badRequest } from './problem.js';

/**
 * Значение `Idempotency-Key`.
 *
 * Отсутствие — 400, а не молчаливое согласие: §14 объявляет заголовок
 * обязательным на дорогих действиях (прогон LLM по всем страницам комплекта,
 * распознавание, сверка папки). «Забыли прислать» обязано быть видно сразу, а
 * не превращаться в повторный запуск дорогой работы.
 */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw badRequest('Требуется заголовок Idempotency-Key.');
  }
  const trimmed = value.trim();
  if (trimmed.length > 128 || !/^[\w.:@-]+$/.test(trimmed)) {
    throw badRequest('Idempotency-Key: до 128 символов из [A-Za-z0-9._:@-].');
  }
  return trimmed;
}

/**
 * Разбор `If-Match` (§14).
 *
 * Обязателен: без него «последний записавший победил» становится поведением по
 * умолчанию, то есть подтверждение одного проверяющего молча затирает
 * подтверждение другого. Отсутствие заголовка — 400, а не 412: 412 клиент
 * понимает как «перечитай и повтори», а перечитывание тут не поможет —
 * заголовка нет вовсе.
 *
 * @param entity родительный падеж названия сущности: «документа», «реестра».
 */
export function requireIfMatch(request: FastifyRequest, entity: string): number {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw badRequest(`Требуется заголовок If-Match с версией ${entity}.`);
  }
  const cleaned = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number(cleaned);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest(`Заголовок If-Match должен содержать целую версию ${entity}.`);
  }
  return parsed;
}
