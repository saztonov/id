import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NMS_IOU,
  DEFAULT_NUM_SELECT,
  DEFAULT_OVERLAP,
  DEFAULT_THRESHOLD,
  DEFAULT_TILE_SIZE,
  manifestParams,
  parseDetectionManifest,
  resolveInferenceMode,
} from './manifest.js';

const minimal = {
  num_classes: 3,
  resolution: 560,
  class_mapping: { text: 0, image: 1, stamp: 2 },
  preprocessing: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
};

describe('detectionManifestSchema', () => {
  it('минимальный legacy-манифест валиден, дефолты — как в референсе', () => {
    const params = manifestParams(parseDetectionManifest(minimal));
    expect(params.boxFormat).toBe('cxcywh_normalized');
    expect(params.activation).toBe('sigmoid');
    expect(params.numSelect).toBe(DEFAULT_NUM_SELECT);
    expect(params.tileSize).toBe(DEFAULT_TILE_SIZE);
    expect(params.overlap).toBe(DEFAULT_OVERLAP);
    expect(params.inputName).toBe('input');
    expect(params.dynamicBatch).toBe(false);
    expect(params.trainingMode).toBeNull();
    expect(params.minVisibility).toBeNull();
    expect(params.thresholds).toEqual({});
    expect(params.defaultThreshold).toBe(DEFAULT_THRESHOLD);
    expect(params.nmsIou).toBe(DEFAULT_NMS_IOU);
    expect(params.mergeSplitText).toBe(false);
    expect(params.maxDetections).toBeNull();
  });

  it('незнакомые поля не отвергаются (открытый мир) и сохраняются', () => {
    const parsed = parseDetectionManifest({
      ...minimal,
      exported_at: '2026-08-01T00:00:00Z',
      training: { epochs: 50 },
    });
    expect((parsed as Record<string, unknown>)['exported_at']).toBe('2026-08-01T00:00:00Z');
    expect((parsed as Record<string, unknown>)['training']).toEqual({ epochs: 50 });
  });

  it('полный манифест: явные значения имеют приоритет над дефолтами', () => {
    const params = manifestParams(
      parseDetectionManifest({
        ...minimal,
        box_format: 'xyxy_pixels',
        class_activation: 'softmax',
        num_select: 200,
        dynamic_batch: true,
        tiling: { tile_size: 768, overlap: 96, mode: 'whole_page', min_visibility: 0.3 },
        thresholds: { default: 0.4, per_class: { text: 0.5, image: 0.6, unknown_class: 0.9 } },
        nms_iou: 0.6,
        merge_split_text: true,
        max_detections: 120,
      }),
    );
    expect(params.boxFormat).toBe('xyxy_pixels');
    expect(params.activation).toBe('softmax');
    expect(params.numSelect).toBe(200);
    expect(params.tileSize).toBe(768);
    expect(params.overlap).toBe(96);
    expect(params.trainingMode).toBe('whole_page');
    expect(params.minVisibility).toBe(0.3);
    // неизвестное имя класса в per_class пропущено — как в разборе порогов референса
    expect(params.thresholds).toEqual({ text: 0.5, image: 0.6 });
    expect(params.defaultThreshold).toBe(0.4);
    expect(params.nmsIou).toBe(0.6);
    expect(params.mergeSplitText).toBe(true);
    expect(params.maxDetections).toBe(120);
  });

  it('box_format из блока outputs (старые манифесты) подхватывается', () => {
    const params = manifestParams(
      parseDetectionManifest({ ...minimal, outputs: { box_format: 'xyxy_pixels' } }),
    );
    expect(params.boxFormat).toBe('xyxy_pixels');
  });

  it('неизвестный tiling.mode терпим (legacy) → trainingMode null → auto=tiles', () => {
    const params = manifestParams(
      parseDetectionManifest({
        ...minimal,
        tiling: { tile_size: 512, overlap: 64, mode: 'мусор' },
      }),
    );
    expect(params.trainingMode).toBeNull();
    expect(resolveInferenceMode('auto', params.trainingMode)).toEqual({
      mode: 'tiles',
      source: 'legacy_default',
      trainingMode: null,
    });
  });

  it('битый class_mapping отвергается', () => {
    // столбец вне диапазона labels (num_classes+1)
    expect(() =>
      parseDetectionManifest({ ...minimal, class_mapping: { text: 0, image: 1, stamp: 4 } }),
    ).toThrow(/столбец 4/);
    // нет ни одного известного класса
    expect(() =>
      parseDetectionManifest({ ...minimal, class_mapping: { background: 0, figure: 1 } }),
    ).toThrow(/известного класса/);
    // два известных класса делят один столбец
    expect(() =>
      parseDetectionManifest({ ...minimal, class_mapping: { text: 0, image: 0, stamp: 2 } }),
    ).toThrow(/делят столбец 0/);
    // пустой class_mapping
    expect(() => parseDetectionManifest({ ...minimal, class_mapping: {} })).toThrow(/непустым/);
    // нецелый индекс
    expect(() =>
      parseDetectionManifest({ ...minimal, class_mapping: { text: 0.5, image: 1, stamp: 2 } }),
    ).toThrow();
  });

  it('logits_size должен быть больше максимального id class_mapping', () => {
    expect(() => parseDetectionManifest({ ...minimal, logits_size: 2 })).toThrow(/logits_size/);
    expect(parseDetectionManifest({ ...minimal, logits_size: 4 })).toBeTruthy();
  });

  it('известные поля валидируются жёстко: битые значения — ошибка, а не молчаливый дефолт', () => {
    expect(() => parseDetectionManifest({ ...minimal, box_format: 'yolo' })).toThrow();
    expect(() => parseDetectionManifest({ ...minimal, score_activation: 'relu' })).toThrow();
    expect(() => parseDetectionManifest({ ...minimal, num_select: 0 })).toThrow();
    expect(() => parseDetectionManifest({ ...minimal, resolution: -1 })).toThrow();
    expect(() =>
      parseDetectionManifest({
        ...minimal,
        preprocessing: { mean: [0.485, 0.456], std: [0.229, 0.224, 0.225] },
      }),
    ).toThrow();
    expect(() =>
      parseDetectionManifest({
        ...minimal,
        preprocessing: { mean: [0.485, 0.456, 0.406], std: [0.229, 0, 0.225] },
      }),
    ).toThrow(/std/);
    expect(() =>
      parseDetectionManifest({ ...minimal, tiling: { tile_size: 512, overlap: 512 } }),
    ).toThrow(/overlap/);
    expect(() => parseDetectionManifest({ ...minimal, onnx_sha256: 'не-хэш' })).toThrow();
  });

  it('resolveInferenceMode: форс настройкой и выбор по манифесту', () => {
    expect(resolveInferenceMode('whole_page', 'tiles')).toEqual({
      mode: 'whole_page',
      source: 'settings_forced',
      trainingMode: 'tiles',
    });
    expect(resolveInferenceMode('tiles', null).source).toBe('settings_forced');
    expect(resolveInferenceMode('auto', 'whole_page')).toEqual({
      mode: 'whole_page',
      source: 'manifest',
      trainingMode: 'whole_page',
    });
    expect(resolveInferenceMode('auto', 'whole_page_and_tiles').mode).toBe('tiles');
    expect(resolveInferenceMode('auto', 'tiles').source).toBe('manifest');
    expect(resolveInferenceMode('auto', null)).toEqual({
      mode: 'tiles',
      source: 'legacy_default',
      trainingMode: null,
    });
  });
});
