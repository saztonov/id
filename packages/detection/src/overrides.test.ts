/**
 * Переопределения параметров инференса настройками портала (ADR-0008).
 *
 * Проверяется не арифметика, а два свойства, на которых держится смысл всей
 * конструкции: незаданная настройка НЕ трогает манифест, а заданная попадает
 * ровно туда, откуда её возьмёт постобработка страницы.
 */
import { describe, expect, it } from 'vitest';

import { manifestParams, parseDetectionManifest, type InferenceParams } from './manifest.js';
import { NO_PARAM_OVERRIDES, applyParamOverrides, describeAppliedOverrides } from './overrides.js';

/**
 * Манифест боевой модели в сокращении: ровно те поля, что обязательны, и НИ
 * ОДНОГО из блоков `thresholds` / `nms_iou` / `merge_split_text` /
 * `max_detections`. Это не упрощение ради теста — это состояние выложенной
 * модели, из-за которого настройки и понадобились.
 */
function paramsFromBareManifest(): InferenceParams {
  return manifestParams(
    parseDetectionManifest({
      resolution: 704,
      num_classes: 3,
      class_mapping: { text: 0, image: 1, stamp: 2 },
      preprocessing: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
      tiling: { mode: 'whole_page', tile_size: 1024, overlap: 128 },
    }),
  );
}

describe('applyParamOverrides', () => {
  it('манифест без настроек детекции даёт дефолты референса', () => {
    const params = paramsFromBareManifest();
    expect(params.defaultThreshold).toBe(0.5);
    expect(params.nmsIou).toBe(0.5);
    expect(params.mergeSplitText).toBe(false);
    expect(params.maxDetections).toBeNull();
    expect(params.thresholds).toEqual({});
  });

  it('пустые переопределения не меняют ничего', () => {
    const params = paramsFromBareManifest();
    expect(applyParamOverrides(params, NO_PARAM_OVERRIDES)).toEqual(params);
    expect(applyParamOverrides(params, null)).toEqual(params);
    expect(applyParamOverrides(params, undefined)).toEqual(params);
  });

  it('null в поле означает «из манифеста», а не ноль', () => {
    // Главное свойство: администратор, не заполнявший карточку, не навязывает
    // модели свои числа. Иначе настройка со значением по умолчанию затирала бы
    // манифест молча.
    const params = paramsFromBareManifest();
    const applied = applyParamOverrides(params, {
      defaultThreshold: null,
      nmsIou: null,
      mergeSplitText: null,
      maxDetections: null,
      perClassThresholds: null,
    });
    expect(applied).toEqual(params);
  });

  it('порог принятия снижается — это и есть ручка под непрокрашенные сканы', () => {
    const applied = applyParamOverrides(paramsFromBareManifest(), { defaultThreshold: 0.25 });
    expect(applied.defaultThreshold).toBe(0.25);
    // Остальное не задето.
    expect(applied.nmsIou).toBe(0.5);
    expect(applied.mergeSplitText).toBe(false);
  });

  it('ноль как порог принимается: это законное «принимать всё»', () => {
    // Отличается от «не задано» — и именно поэтому наследование выражено null,
    // а не нулём.
    expect(
      applyParamOverrides(paramsFromBareManifest(), { defaultThreshold: 0 }).defaultThreshold,
    ).toBe(0);
  });

  it('значение вне 0..1 отбрасывается, а не поджимается к границе', () => {
    // Подогнанный порог выглядел бы применённым и давал бы не тот результат,
    // который задали.
    const params = paramsFromBareManifest();
    expect(applyParamOverrides(params, { defaultThreshold: 1.5 }).defaultThreshold).toBe(0.5);
    expect(applyParamOverrides(params, { defaultThreshold: -1 }).defaultThreshold).toBe(0.5);
    expect(applyParamOverrides(params, { nmsIou: Number.NaN }).nmsIou).toBe(0.5);
  });

  it('пороги по классам сливаются с манифестом, а не заменяют набор', () => {
    const base: InferenceParams = {
      ...paramsFromBareManifest(),
      thresholds: { text: 0.6, image: 0.4 },
    };
    const applied = applyParamOverrides(base, { perClassThresholds: { stamp: 0.2 } });
    // Правка порога штампа не должна молча снимать пороги текста и изображения.
    expect(applied.thresholds).toEqual({ text: 0.6, image: 0.4, stamp: 0.2 });
  });

  it('склейка разорванного текста включается настройкой', () => {
    // В манифесте боевой модели поля нет, значит склейка выключена; включить её
    // можно было только правкой файла модели в хранилище.
    expect(
      applyParamOverrides(paramsFromBareManifest(), { mergeSplitText: true }).mergeSplitText,
    ).toBe(true);
  });

  it('потолок детекций принимается только целым и не меньше единицы', () => {
    const params = paramsFromBareManifest();
    expect(applyParamOverrides(params, { maxDetections: 40 }).maxDetections).toBe(40);
    expect(applyParamOverrides(params, { maxDetections: 0 }).maxDetections).toBeNull();
    expect(applyParamOverrides(params, { maxDetections: 2.5 }).maxDetections).toBeNull();
  });

  it('не меняет исходный объект параметров', () => {
    const params = paramsFromBareManifest();
    const copy = structuredClone(params);
    applyParamOverrides(params, { defaultThreshold: 0.1, perClassThresholds: { text: 0.2 } });
    expect(params).toEqual(copy);
  });
});

describe('describeAppliedOverrides', () => {
  it('в снимок уходит РАЗНИЦА, а не сам объект настроек', () => {
    // «Порог 0.5» в снимке не отвечает на вопрос, пришёл он из манифеста или из
    // админки, а воспроизводимость прошлой разметки держится на этом ответе.
    const before = paramsFromBareManifest();
    const after = applyParamOverrides(before, { defaultThreshold: 0.25, mergeSplitText: true });
    expect(describeAppliedOverrides(before, after)).toEqual({
      default_threshold: { from: 0.5, to: 0.25 },
      merge_split_text: { from: false, to: true },
    });
  });

  it('ничего не переопределено — разница пуста', () => {
    const before = paramsFromBareManifest();
    expect(describeAppliedOverrides(before, applyParamOverrides(before, {}))).toEqual({});
  });

  it('порог класса, которого в манифесте не было, показан как появившийся', () => {
    const before = paramsFromBareManifest();
    const after = applyParamOverrides(before, { perClassThresholds: { stamp: 0.2 } });
    expect(describeAppliedOverrides(before, after)).toEqual({
      threshold_stamp: { from: null, to: 0.2 },
    });
  });
});
