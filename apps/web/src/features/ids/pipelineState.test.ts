/**
 * Подписи месяца, исполнителя и стадии — таблицей входов.
 *
 * Набор существует ради одного различия, на которое указал заказчик: пустой
 * месяц у РАЗОБРАННОГО комплекта и пустой месяц у комплекта, который ещё не
 * читали, — разные факты, а печатались одинаково. Проверять это кликами по
 * экрану нельзя: разница не в поле, а в паре «поле плюс стадия».
 */
import { describe, expect, it } from 'vitest';

import {
  contractorLabel,
  monthLabel,
  periodLabel,
  pipelineBusy,
  pipelineLabel,
  type WorkPipeline,
} from './pipelineState.js';

function pipeline(overrides: Partial<WorkPipeline> = {}): WorkPipeline {
  return { stage: 'uploaded', queued: 0, running: 0, dead: 0, ...overrides };
}

describe('месяц комплекта', () => {
  it('прочитанный печатается словом', () => {
    expect(periodLabel('2026-02-01')).toBe('февраль 2026');
    expect(monthLabel('2026-08-01')).toBe('август 2026');
  });

  it('до разбора — «После OCR», а не прочерк', () => {
    // Прочерк читается как «портал не смог», то есть как отказ. Здесь же —
    // ещё не случившаяся работа (ADR-0019).
    expect(periodLabel(null)).toBe('После OCR');
    expect(periodLabel(null, pipeline({ stage: 'recognition', running: 1 }))).toBe('После OCR');
  });

  it('после разбора пустой месяц называется своей причиной', () => {
    // Главное утверждение набора: то самое «комплект распознан, а месяц — После
    // OCR», с которого началась правка.
    expect(periodLabel(null, pipeline({ stage: 'analysis' }))).toBe('Дата акта не распознана');
    expect(periodLabel(null, pipeline({ stage: 'ready' }))).toBe('Дата акта не распознана');
  });

  it('отказ конвейера важнее стадии', () => {
    expect(periodLabel(null, pipeline({ stage: 'ready', dead: 1 }))).toBe('Обработка остановлена');
  });
});

describe('исполнитель комплекта', () => {
  const base = { name: 'ООО «Тест»', assumed: false, raw: null, pipeline: null };

  it('названный человеком печатается как есть', () => {
    expect(contractorLabel(base)).toBe('ООО «Тест»');
  });

  it('подставленный порталом до разбора — той же надписью, что и месяц', () => {
    expect(contractorLabel({ ...base, assumed: true })).toBe('После OCR');
  });

  it('после разбора без организации — своей причиной', () => {
    expect(
      contractorLabel({ ...base, assumed: true, pipeline: pipeline({ stage: 'checks' }) }),
    ).toBe('В акте не распознан');
  });

  it('прочитанное из акта наименование не теряется', () => {
    // Портал организацию ПРОЧИТАЛ, но закрепить её за объектом может только
    // человек. Показать это знание — не то же самое, что показать пустоту.
    expect(
      contractorLabel({
        ...base,
        assumed: true,
        raw: 'ООО «Подрядчик из акта»',
        pipeline: pipeline({ stage: 'ready' }),
      }),
    ).toBe('ООО «Подрядчик из акта» — нет в справочнике объекта');
  });
});

describe('состояние конвейера', () => {
  it('«нет данных» и «не запускалось» — разные ответы', () => {
    expect(pipelineLabel(null)).toBe('нет данных');
    expect(pipelineLabel(pipeline())).toBe('не запускалось');
  });

  it('идущая работа называет стадию', () => {
    expect(pipelineLabel(pipeline({ stage: 'recognition', running: 1 }))).toBe(
      'идёт: распознавание',
    );
    expect(pipelineLabel(pipeline({ stage: 'layout', queued: 2 }))).toBe('идёт: выделение блоков');
  });

  it('законченная стадия называется без слова «идёт»', () => {
    expect(pipelineLabel(pipeline({ stage: 'ready' }))).toBe('готово');
  });

  it('мёртвая задача важнее любой активности', () => {
    expect(pipelineLabel(pipeline({ stage: 'recognition', running: 3, dead: 1 }))).toBe('отказ');
  });

  it('опрос идёт, пока что-то в работе, и молчит после отказа', () => {
    expect(pipelineBusy(pipeline({ queued: 1 }))).toBe(true);
    expect(pipelineBusy(pipeline({ running: 1 }))).toBe(true);
    // Иначе экран опрашивал бы сервер вечно на остановленном комплекте.
    expect(pipelineBusy(pipeline({ running: 1, dead: 1 }))).toBe(false);
    expect(pipelineBusy(pipeline({ stage: 'ready' }))).toBe(false);
    expect(pipelineBusy(null)).toBe(false);
  });
});
