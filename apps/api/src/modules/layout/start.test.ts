/**
 * Гейт «модель детекции не загружена» — чистая функция, чистый тест.
 *
 * Предмет здесь один: правило форматов сделало модель нужной НЕ ВСЯКОМУ
 * комплекту, и гейт обязан это различать. Комплект из одних A4 размечается
 * полностраничными блоками — без инференса, без растеризатора, без весов, — и
 * ответить ему «детекция пропущена» значило бы оставить его с пустой разметкой
 * там, где отказывать не в чем.
 */
import { describe, expect, it } from 'vitest';

import { LEGACY_MARKUP_POLICY, type MarkupPolicy } from '@id/contracts';

import { detectionUnavailableReason } from './start.js';

const SHEET_AWARE: MarkupPolicy = {
  version: 1,
  sheetStrategy: 'sheet_aware',
  numberZone: 'near_stamp',
  numberZonePad: { x: 0.1, y: 0.25 },
};

const NO_MODEL = { provider: 'local', modelVersion: '' };

describe('detectionUnavailableReason', () => {
  it('легаси-путь RD WEB гейта не касается', () => {
    expect(
      detectionUnavailableReason({
        provider: 'rdweb',
        modelVersion: '',
        markupPolicy: SHEET_AWARE,
      }),
    ).toBeNull();
  });

  it('выложенная модель снимает вопрос при любой стратегии', () => {
    expect(
      detectionUnavailableReason({
        provider: 'local',
        modelVersion: 'v3',
        markupPolicy: SHEET_AWARE,
      }),
    ).toBeNull();
  });

  it('при detect_all модель нужна всегда — прежнее поведение', () => {
    const reason = detectionUnavailableReason(
      { ...NO_MODEL, markupPolicy: LEGACY_MARKUP_POLICY },
      { largeSheetCount: 0 },
    );

    expect(reason).toContain('detection.model_version');
    expect(reason).not.toContain('крупнее A4');
  });

  it('при sheet_aware комплект без крупных листов размечается без модели', () => {
    // Главное утверждение правила: 208 A4-страниц боевого комплекта не требуют
    // ни весов, ни poppler, и отказывать им не в чем.
    expect(
      detectionUnavailableReason(
        { ...NO_MODEL, markupPolicy: SHEET_AWARE },
        { largeSheetCount: 0 },
      ),
    ).toBeNull();
  });

  it('крупные листы в комплекте названы числом и склонением', () => {
    // Оператор комплекта из двухсот A4 и дюжины A3 должен понимать, что именно
    // он потеряет: не «детекция пропущена», а «штампы двенадцати листов».
    expect(
      detectionUnavailableReason(
        { ...NO_MODEL, markupPolicy: SHEET_AWARE },
        { largeSheetCount: 12 },
      ) ?? '',
    ).toContain('12 листов крупнее A4');
    expect(
      detectionUnavailableReason(
        { ...NO_MODEL, markupPolicy: SHEET_AWARE },
        { largeSheetCount: 1 },
      ) ?? '',
    ).toContain('1 лист крупнее A4');
    expect(
      detectionUnavailableReason(
        { ...NO_MODEL, markupPolicy: SHEET_AWARE },
        { largeSheetCount: 3 },
      ) ?? '',
    ).toContain('3 листа крупнее A4');
  });

  it('без собранного комплекта формулировка условная, а не точная', () => {
    // Кнопка «Разметить» на несобранном комплекте карты страниц не имеет.
    // Обещать точность там, где данных нет, хуже, чем ответить условно.
    const reason = detectionUnavailableReason({ ...NO_MODEL, markupPolicy: SHEET_AWARE });

    expect(reason).toContain('Если в комплекте есть листы крупнее A4');
  });
});
