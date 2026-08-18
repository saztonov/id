/**
 * Классификация отказов задач 14–19 (§12).
 *
 * `SegmentationStateError` объявляет неповторяемость сам, а `classifyFailure()`
 * в движке её читает. Проверяется именно СВЯЗКА, а не поле: до починки поле
 * существовало бы, движок бы его не спрашивал, и «прогона распознавания нет»
 * уходило бы в `max_attempts` попыток с backoff — конвейер четверть часа
 * выглядел бы работающим, ничего не делая.
 *
 * Набор живёт в воркере, а не в API, потому что проверяет пересечение границы
 * пакетов: класс отказа объявлен здесь, решение принимается там, и ни один из
 * двух файлов по отдельности эту связку не держит.
 */
import { describe, expect, it } from 'vitest';

import { classifyFailure } from '@id/api';

import { SegmentationStateError } from './segmentation.js';

describe('отказ стадии сегментации не повторяется', () => {
  it('движок объявляет SegmentationStateError неповторяемым', () => {
    const outcome = classifyFailure(
      new SegmentationStateError('Ревизия: завершённого прогона распознавания нет.'),
    );

    expect(outcome).toEqual({ errorClass: 'SegmentationStateError', permanent: true });
  });

  it('класс отказа доезжает до журнала отдельным именем', () => {
    // `job_runs.error_class` обязан отличать «входа нет» от «сеть моргнула»:
    // первое исправляется человеком, второе — повтором.
    expect(classifyFailure(new SegmentationStateError('нет решений')).errorClass).not.toBe('Error');
  });

  it('обычная ошибка задачи по-прежнему повторяется', () => {
    // Положительный контроль: ремонт не превратил преходящий сбой в отказ
    // поставки. Ошибка, ничего о себе не сообщившая, остаётся повторяемой.
    expect(classifyFailure(new Error('соединение с БД разорвано'))).toEqual({
      errorClass: 'Error',
      permanent: false,
    });
  });
});
