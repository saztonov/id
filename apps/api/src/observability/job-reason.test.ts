/**
 * Причина отказа задачи словами (S44).
 *
 * Главное утверждение набора — не «текст красивый», а «чужая строка сюда не
 * попадает». Отпечаток журнала (`normalizeErrorMessage`) вычёркивает числа
 * намеренно, и появление рядом поля с числами имеет смысл ровно до тех пор, пока
 * заполняет его закрытый перечень своих классов.
 */
import { describe, expect, it } from 'vitest';

import { JobTimeoutError, LeaseLostError } from '../jobs/runner.js';
import {
  LlmBudgetError,
  LlmDisabledError,
  LlmError,
  LlmModelNotAllowedError,
  LlmPayloadTooLargeError,
  LlmProtocolError,
  LlmRateLimitError,
  LlmTimeoutError,
  LlmTransportError,
} from '../llm/port.js';
import { readableJobReason } from './job-reason.js';

describe('свои классы называют причину числом', () => {
  it('исчерпанная аренда печатает СВОЙ потолок, а не «<n> мс»', () => {
    // Ровно то, что читал человек на боевом прогоне: «попытка не уложилась в
    // <n> мс». Число здесь задал сам портал — приписать к нему ПДн неоткуда.
    expect(readableJobReason(new JobTimeoutError(600_000))).toBe(
      'Попытка не уложилась в отведённое время (600.0 с).',
    );
  });

  it('исчерпанный бюджет называет потраченное и потолок', () => {
    const reason = readableJobReason(
      new LlmBudgetError('budget exhausted', { spent: 1234.5, budget: 2000 }),
    );
    expect(reason).toBe('Месячный бюджет модели исчерпан: потрачено 1234.50 из 2000.00.');
  });

  it('ограничение частоты называет паузу, когда шлюз её назвал', () => {
    expect(readableJobReason(new LlmRateLimitError('429', { retryAfterMs: 30_000 }))).toContain(
      '30.0 с',
    );
    // Шлюз промолчал — портал не выдумывает срок, но факт называет.
    expect(readableJobReason(new LlmRateLimitError('429', {}))).toBe(
      'Шлюз модели ограничил частоту запросов.',
    );
  });

  it('потерянная аренда и выключенная модель объясняются без чисел', () => {
    expect(readableJobReason(new LeaseLostError())).toContain('другой воркер');
    expect(readableJobReason(new LlmDisabledError('off'))).toContain('выключены настройкой');
  });

  it('слишком большое тело называет размер в килобайтах', () => {
    expect(readableJobReason(new LlmPayloadTooLargeError(2_097_152, '413'))).toBe(
      'Запрос к модели не пролез в шлюз: 2048 КБ.',
    );
  });

  it('модель вне списка названа по имени: оно из настройки, а не из скана', () => {
    expect(
      readableJobReason(new LlmModelNotAllowedError('qwen/qwen3.8-27b', 'вне списка')),
    ).toContain('qwen/qwen3.8-27b');
  });

  it('модель не ответила — печатается свой таймаут', () => {
    expect(readableJobReason(new LlmTimeoutError(120_000, 'timeout'))).toBe(
      'Модель не ответила за отведённое время (120.0 с).',
    );
  });
});

describe('чужая строка не пересказывается', () => {
  /**
   * Перечень закрыт, и это главное свойство: ПДн не просачиваются не потому,
   * что строка отфильтрована, а потому, что чужая строка сюда не попадает.
   */
  it.each([
    ['ошибка Postgres', new Error('duplicate key value violates unique constraint "docs_pkey"')],
    ['сообщение провайдера', new LlmProtocolError('upstream said: ФИО Иванов И.И. не найден')],
    ['сетевой отказ', new LlmTransportError('ECONNRESET', { status: 502 })],
    ['базовый класс шлюза', new LlmError('что-то пошло не так', { retriable: true })],
    ['строка вместо ошибки', 'просто текст'],
    ['null', null],
    ['объект без имени', { message: 'таблица «Иванов» не найдена' }],
  ])('%s причины не получает', (_name, error) => {
    expect(readableJobReason(error)).toBeNull();
  });

  it('подделка под свой класс без типизированного поля тоже даёт null', () => {
    // Имя класса совпало, а числа нет: собирать причину не из чего, и выдумать
    // её портал не вправе.
    expect(readableJobReason({ name: 'JobTimeout', message: 'таймаут 600000 мс' })).toBeNull();
    expect(readableJobReason({ name: 'LlmBudgetError', spent: 10 })).toBeNull();
  });
});
