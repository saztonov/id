/**
 * Сборка снимка: три проверки, которых до перехода на новый контракт не было.
 *
 * Все три ловят состояния, законные в НАШЕЙ базе и незаконные в контракте, —
 * то есть ровно тот класс расхождения, который иначе проявился бы отказом
 * `invalid_manifest` на всём комплекте.
 */
import { describe, expect, it } from 'vitest';

import { buildSnapshotBody, SnapshotBuildError, type SnapshotBlockInput } from './snapshot.js';

function blockInput(overrides: Partial<SnapshotBlockInput> = {}): SnapshotBlockInput {
  return {
    externalBlockId: 'blk-000001',
    revision: 1,
    workingPageIndex: 0,
    blockType: 'text',
    shapeType: 'rectangle',
    x0: 0.1,
    y0: 0.1,
    x1: 0.9,
    y1: 0.4,
    points: [],
    sortOrder: 0,
    displayName: null,
    contentRotation: 0,
    forceReprocess: false,
    ...overrides,
  };
}

function build(blocks: readonly SnapshotBlockInput[], pageCount = 4) {
  return buildSnapshotBody({
    externalSyncId: 'sync-1',
    externalProjectId: 'idp-object-1',
    projectName: 'Корпус 1',
    externalDocumentId: 'folder/1f0f2b1e-0000-4000-8000-000000000001',
    documentName: 'ЖБ конструкции',
    documentRevision: 'R1',
    baseGeneration: 0,
    syncGeneration: 1,
    document: { fileName: 'work.pdf', sizeBytes: 1024, sha256: 'a'.repeat(64), pageCount },
    blocks,
  });
}

describe('вырожденная геометрия', () => {
  it('блок с нулевой стороной не отправляется и объясняется предупреждением', () => {
    const result = build([blockInput(), blockInput({ externalBlockId: 'blk-000002', x1: 0.1 })]);

    expect(result.body.blocks.map((block) => block.external_block_id)).toEqual(['blk-000001']);
    expect(result.skipped).toEqual(['blk-000002']);
    expect(result.warnings.map((w) => w.code)).toContain('block_degenerate_geometry');
  });

  it('снимок из одних вырожденных блоков — отказ, а не пустая отправка', () => {
    expect(() => build([blockInput({ y1: 0.1 })])).toThrow(SnapshotBuildError);
  });

  it('исправный блок проходит: контроль к предыдущим двум', () => {
    expect(build([blockInput()]).skipped).toEqual([]);
  });
});

describe('полигон', () => {
  const triangle = [
    { x: 0.2, y: 0.3 },
    { x: 0.8, y: 0.35 },
    { x: 0.5, y: 0.7 },
  ];

  it('coords_norm пересчитывается из точек, а не берётся из строки', () => {
    const result = build([
      blockInput({
        shapeType: 'polygon',
        points: triangle,
        // Заведомо расходящийся с точками прямоугольник — так и бывает после
        // правки формы: bbox в строке никто не пересчитывает.
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
      }),
    ]);

    const block = result.body.blocks[0];
    expect(block?.shape_type).toBe('polygon');
    expect(block?.coords_norm).toEqual([0.2, 0.3, 0.8, 0.7]);
    expect(block?.polygon_points).toHaveLength(3);
  });

  it('полигон из двух точек деградирует в прямоугольник с предупреждением', () => {
    const result = build([
      blockInput({
        shapeType: 'polygon',
        points: [
          { x: 0.2, y: 0.3 },
          { x: 0.8, y: 0.7 },
        ],
      }),
    ]);

    expect(result.body.blocks[0]?.shape_type).toBe('rectangle');
    expect(result.body.blocks[0]?.polygon_points).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain('polygon_degraded');
  });

  it('полигон свыше 512 точек не прореживается, а отправляется прямоугольником', () => {
    const many = Array.from({ length: 600 }, (_unused, index) => ({
      x: 0.2 + (index % 10) / 100,
      y: 0.3 + (index % 7) / 100,
    }));
    const result = build([blockInput({ shapeType: 'polygon', points: many })]);

    expect(result.body.blocks[0]?.shape_type).toBe('rectangle');
    expect(result.warnings.map((w) => w.code)).toContain('polygon_too_many_points');
  });

  it('у прямоугольника polygon_points строго null', () => {
    // В базе у прямоугольника могли остаться точки прежней формы.
    const result = build([blockInput({ shapeType: 'rectangle', points: triangle })]);
    expect(result.body.blocks[0]?.polygon_points).toBeNull();
  });
});

describe('лимиты §12 проверяются ДО отправки', () => {
  it('слишком много страниц — внятный отказ, а не 413 после загрузки', () => {
    expect(() => build([blockInput()], 2001)).toThrow(SnapshotBuildError);
  });

  it('блок за пределами числа страниц выбрасывается', () => {
    const result = build([
      blockInput(),
      blockInput({ externalBlockId: 'blk-x', workingPageIndex: 9 }),
    ]);
    expect(result.skipped).toEqual(['blk-x']);
    expect(result.warnings.map((w) => w.code)).toContain('block_page_out_of_range');
  });

  it('слишком большой PDF — отказ до трафика', () => {
    expect(() =>
      buildSnapshotBody({
        externalSyncId: 'sync-1',
        externalProjectId: 'idp-object-1',
        projectName: 'Корпус 1',
        externalDocumentId: 'folder/x',
        documentName: 'x',
        documentRevision: 'R1',
        baseGeneration: 0,
        syncGeneration: 1,
        document: {
          fileName: 'work.pdf',
          sizeBytes: 300 * 1024 * 1024,
          sha256: 'a'.repeat(64),
          pageCount: 10,
        },
        blocks: [blockInput()],
      }),
    ).toThrow(SnapshotBuildError);
  });
});

describe('разворот скана', () => {
  it('уезжает в metadata и объявляется предупреждением прогона', () => {
    const result = build([blockInput({ contentRotation: 90 })]);
    expect(result.body.blocks[0]?.metadata).toEqual({ content_rotation: 90 });
    expect(result.warnings.map((w) => w.code)).toContain('content_rotation_unsupported');
  });

  it('на прямом листе metadata пуста и предупреждения нет', () => {
    const result = build([blockInput()]);
    expect(result.body.blocks[0]?.metadata).toEqual({});
    expect(result.warnings.map((w) => w.code)).not.toContain('content_rotation_unsupported');
  });
});

describe('форма тела', () => {
  it('режим снимка и система координат — единственные значения v1', () => {
    const { body } = build([blockInput()]);
    expect(body.snapshot_mode).toBe('replace');
    expect(body.coordinate_space).toBe('rendered_page_normalized_v1');
    expect(body.document.mime_type).toBe('application/pdf');
  });
});
