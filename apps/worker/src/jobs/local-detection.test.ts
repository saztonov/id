/**
 * Разметка по формату листа: план пачки, отбор блоков и ленивые гейты.
 *
 * Всё на двойниках и без ONNX. Это не упрощение ради скорости, а единственный
 * способ проверить главное утверждение правила: на комплекте из одних A4
 * задача обязана отработать, НЕ тронув ни модель детекции, ни растеризатор, ни
 * рабочий PDF. Интеграционный тест рядом поднимает настоящий инференс и
 * проверяет другое — что найденное действительно ложится в базу.
 */
import { describe, expect, it, vi } from 'vitest';

import { LEGACY_MARKUP_POLICY, type MarkupPolicy } from '@id/contracts';
import type { BundlePageView, DetectedBlockInput, JobContext } from '@id/api';
import type { Candidate } from '@id/detection';

import {
  createLocalDetectionHandler,
  planDetectionPages,
  selectLargeSheetBlocks,
  type LocalDetectionDeps,
} from './local-detection.js';
import { DetectionConfigurationError } from '../detection/errors.js';
import type { MarkupTarget } from './markup.js';

const FOLDER = '00000000-0000-4000-8000-000000000001';
const LAYOUT = '00000000-0000-4000-8000-000000000002';
const BUNDLE = '00000000-0000-4000-8000-000000000003';

const SHEET_AWARE: MarkupPolicy = {
  version: 1,
  sheetStrategy: 'sheet_aware',
  numberZone: 'near_stamp',
  numberZonePad: { x: 0.1, y: 0.25 },
};

/** Настоящие размеры страниц боевого комплекта, в пунктах. */
const A4_PORTRAIT = { widthPx: 594, heightPx: 842 };
const A3_LANDSCAPE = { widthPx: 1188, heightPx: 842 };

function page(index: number, size: { widthPx: number; heightPx: number }): BundlePageView {
  return {
    workingPageIndex: index,
    sourcePageId: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
    sourceFileId: '00000000-0000-4000-8000-000000000004',
    fileName: 'комплект.pdf',
    filePageIndex: index,
    ...size,
    rotation: 0,
    contentRotation: 0,
    contentRotationSource: null,
  } as BundlePageView;
}

function candidate(
  blockType: Candidate['blockType'],
  coords: [number, number, number, number],
): Candidate {
  return { blockType, coordsNorm: coords, score: 0.9 };
}

// =====================================================================
// План пачки
// =====================================================================

describe('planDetectionPages', () => {
  const geometryByPage = new Map([
    [0, page(0, A4_PORTRAIT)],
    [1, page(1, A3_LANDSCAPE)],
  ]);

  it('при sheet_aware малый лист размечается целиком, крупный уходит на детекцию', () => {
    const plan = planDetectionPages({
      pageIndices: [0, 1],
      geometryByPage,
      alreadyHasBlocks: new Set(),
      policy: SHEET_AWARE,
    });

    expect(plan.map((entry) => entry.kind)).toEqual(['full_page', 'detect']);
    expect(plan[1]).toMatchObject({ mode: 'stamp_only' });
  });

  it('при detect_all детектор идёт по каждой странице — прежнее поведение', () => {
    const plan = planDetectionPages({
      pageIndices: [0, 1],
      geometryByPage,
      alreadyHasBlocks: new Set(),
      policy: LEGACY_MARKUP_POLICY,
    });

    expect(plan.map((entry) => entry.kind)).toEqual(['detect', 'detect']);
    expect(plan.every((entry) => entry.kind === 'detect' && entry.mode === 'full_detection')).toBe(
      true,
    );
  });

  it('нечитаемый размер размечается как раньше, а не как A4', () => {
    // Иначе страница с битым MediaBox получила бы один блок на всю страницу на
    // основании арифметической ошибки — и это было бы неотличимо от решения.
    const plan = planDetectionPages({
      pageIndices: [0],
      geometryByPage: new Map([[0, page(0, { widthPx: 0, heightPx: 0 })]]),
      alreadyHasBlocks: new Set(),
      policy: SHEET_AWARE,
    });

    expect(plan[0]).toMatchObject({ kind: 'detect', mode: 'full_detection' });
  });

  it('уже размеченная страница и страница вне карты не попадают в работу', () => {
    const plan = planDetectionPages({
      pageIndices: [0, 1, 7],
      geometryByPage,
      alreadyHasBlocks: new Set([0]),
      policy: SHEET_AWARE,
    });

    expect(plan.map((entry) => entry.kind)).toEqual([
      'skip_existing',
      'detect',
      'missing_geometry',
    ]);
  });
});

// =====================================================================
// Отбор блоков крупного листа
// =====================================================================

describe('selectLargeSheetBlocks', () => {
  const stamp = candidate('stamp', [0.72, 0.82, 0.97, 0.95]);
  const numberCell = candidate('text', [0.72, 0.74, 0.97, 0.8]);
  const explication = candidate('text', [0.05, 0.05, 0.4, 0.3]);
  const drawing = candidate('image', [0.05, 0.35, 0.7, 0.75]);

  it('штампы проходят всегда, текст и изображения чертежа — нет', () => {
    const { kept } = selectLargeSheetBlocks([stamp, explication, drawing], SHEET_AWARE);

    expect(kept).toEqual([stamp]);
  });

  it('текст в околоштамповой зоне остаётся: это номер листа', () => {
    // Без него у исполнительной схемы нет собственного номера вовсе — в штампе
    // стоит «Обозначение» проекта, общее у всех листов раздела, и сверка с
    // реестром приложений объявила бы «нет в комплекте» каждую схему.
    const { kept, numberZone } = selectLargeSheetBlocks(
      [stamp, numberCell, explication],
      SHEET_AWARE,
    );

    expect(kept).toEqual([stamp, numberCell]);
    expect(numberZone).toBe(1);
  });

  it('при off остаётся только штамп', () => {
    const { kept, numberZone } = selectLargeSheetBlocks([stamp, numberCell], {
      ...SHEET_AWARE,
      numberZone: 'off',
    });

    expect(kept).toEqual([stamp]);
    expect(numberZone).toBe(0);
  });

  it('без штампа зоны нет: гадать, где номер, портал не берётся', () => {
    // Синтетический прямоугольник не рисуется намеренно: на реальных схемах
    // номер стоит то над штампом, то в правом верхнем углу.
    const { kept } = selectLargeSheetBlocks([numberCell, explication], SHEET_AWARE);

    expect(kept).toEqual([]);
  });

  it('зона клэмпится в лист и не выходит за его границы', () => {
    // Штамп в правом нижнем углу: зона вниз и вправо упирается в край, вверх
    // раскрывается на четверть листа.
    const cornerStamp = candidate('stamp', [0.85, 0.9, 1, 1]);
    const above = candidate('text', [0.85, 0.66, 1, 0.72]);
    const farAway = candidate('text', [0.05, 0.05, 0.3, 0.12]);

    const { kept } = selectLargeSheetBlocks([cornerStamp, above, farAway], SHEET_AWARE);

    expect(kept).toEqual([cornerStamp, above]);
  });
});

// =====================================================================
// Обработчик: комплект из одних A4 не трогает модель
// =====================================================================

interface Recorder {
  readonly imports: {
    provenance: string;
    pages: readonly number[];
    blocks: readonly DetectedBlockInput[];
  }[];
  readonly ensureModel: ReturnType<typeof vi.fn>;
  readonly workingPdf: ReturnType<typeof vi.fn>;
}

function target(policy: MarkupPolicy): MarkupTarget {
  return {
    layoutRevisionId: LAYOUT,
    folderId: FOLDER,
    bundleId: BUNDLE,
    objectId: '00000000-0000-4000-8000-000000000005',
    state: 'draft',
    detectorProfile: 'rf_detr',
    workingPdfSha256: 'a'.repeat(64),
    workingPdfKey: 'blobs/aa/aa/working.pdf',
    workingPdfSizeBytes: 1024,
    pageIndices: [0, 1],
    thresholds: {} as MarkupTarget['thresholds'],
    layoutProfileVersion: null,
    markupPolicy: policy,
  };
}

function deps(
  input: {
    readonly policy: MarkupPolicy;
    readonly pages: readonly BundlePageView[];
    readonly modelVersion?: string;
  },
  recorder: Recorder,
): LocalDetectionDeps {
  return {
    // Ни растеризатора, ни модели: комплект из малых листов обязан размечаться
    // при пустой `detection.model_version` и без poppler на воркере.
    rasterizer: null,
    modelStore: {
      ensureModel: recorder.ensureModel,
    } as unknown as LocalDetectionDeps['modelStore'],
    loadTargetByLayout: () => Promise.resolve(target(input.policy)),
    detectionSettings: () => Promise.resolve({ modelVersion: input.modelVersion ?? '' }),
    pageGeometry: () => Promise.resolve(input.pages),
    existingBlockPages: () => Promise.resolve(new Set<number>()),
    workingPdf: recorder.workingPdf as unknown as LocalDetectionDeps['workingPdf'],
    importBlocks: (call) => {
      recorder.imports.push({
        provenance: call.provenance,
        pages: call.workingPageIndices,
        blocks: call.blocks,
      });
      return Promise.resolve({ imported: call.blocks.length, skippedPages: [] });
    },
  };
}

function recorder(): Recorder {
  return {
    imports: [],
    ensureModel: vi.fn(() => Promise.reject(new Error('модель не должна загружаться'))),
    workingPdf: vi.fn(() => Promise.reject(new Error('рабочий PDF не должен арендоваться'))),
  };
}

function context(pageIndices: readonly number[]): JobContext<'layout.detect_local'> {
  return {
    payload: { folderId: FOLDER, layoutRevisionId: LAYOUT, pageIndices },
    signal: new AbortController().signal,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    enqueue: () => Promise.resolve({ jobId: 'job', created: true }),
    emit: () => Promise.resolve(),
  } as unknown as JobContext<'layout.detect_local'>;
}

describe('createLocalDetectionHandler при sheet_aware', () => {
  it('комплект из одних A4 размечается без модели, растеризатора и PDF', async () => {
    const rec = recorder();
    const handler = createLocalDetectionHandler(
      deps({ policy: SHEET_AWARE, pages: [page(0, A4_PORTRAIT), page(1, A4_PORTRAIT)] }, rec),
    );

    await handler(context([0, 1]));

    expect(rec.ensureModel).not.toHaveBeenCalled();
    expect(rec.workingPdf).not.toHaveBeenCalled();
    expect(rec.imports).toHaveLength(1);
    expect(rec.imports[0]?.provenance).toBe('full_page');
    expect(rec.imports[0]?.pages).toEqual([0, 1]);
    expect(rec.imports[0]?.blocks).toEqual([
      {
        workingPageIndex: 0,
        blockType: 'text',
        shapeType: 'rectangle',
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
        sortOrder: 0,
        points: [],
      },
      {
        workingPageIndex: 1,
        blockType: 'text',
        shapeType: 'rectangle',
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
        sortOrder: 0,
        points: [],
      },
    ]);
  });

  it('полностраничный блок не несёт уверенности и версии модели', async () => {
    // Репозиторий требует их парой и только у блока, который действительно
    // нарисовал детектор: выдуманное число сделало бы провенанс ложью.
    const rec = recorder();
    const handler = createLocalDetectionHandler(
      deps({ policy: SHEET_AWARE, pages: [page(0, A4_PORTRAIT)] }, rec),
    );

    await handler(context([0]));

    const block = rec.imports[0]?.blocks[0];
    expect(block).not.toHaveProperty('detectionScore');
    expect(block).not.toHaveProperty('detectionModelVersion');
  });

  it('крупный лист в пачке требует модель — отказ называет формат', async () => {
    const rec = recorder();
    const handler = createLocalDetectionHandler(
      deps({ policy: SHEET_AWARE, pages: [page(0, A4_PORTRAIT), page(1, A3_LANDSCAPE)] }, rec),
    );

    await expect(handler(context([0, 1]))).rejects.toThrow(DetectionConfigurationError);
    await expect(handler(context([0, 1]))).rejects.toThrow(/A3/);
    // Отказ наступает ДО импорта: частичная разметка половины комплекта хуже
    // честного отказа, который оператор увидит и починит.
    expect(rec.imports).toHaveLength(0);
  });

  it('при detect_all модель нужна даже на A4 — прежнее поведение', async () => {
    const rec = recorder();
    const handler = createLocalDetectionHandler(
      deps({ policy: LEGACY_MARKUP_POLICY, pages: [page(0, A4_PORTRAIT)] }, rec),
    );

    await expect(handler(context([0]))).rejects.toThrow(DetectionConfigurationError);
  });
});
