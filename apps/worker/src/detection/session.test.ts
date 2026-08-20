/**
 * Разрешение выходов dets/labels по размерности и по имени (см. докстринг
 * `session.ts`) — без настоящего onnxruntime-node: чистая функция над
 * `outputNames`/`outputMetadata`.
 */
import { describe, expect, it } from 'vitest';
import { DetectionModelMismatchError } from '@id/detection';

import { resolveOutputNames } from './session.js';

function tensorMeta(
  name: string,
  shape: readonly (number | string)[],
): { readonly name: string; readonly isTensor: true; readonly type: 'float32'; readonly shape: readonly (number | string)[] } {
  return { name, isTensor: true, type: 'float32', shape };
}

describe('resolveOutputNames', () => {
  it('различает по размерности последней оси: 4 → dets, иное → labels', () => {
    const result = resolveOutputNames(
      ['pred_boxes', 'pred_logits'],
      [tensorMeta('pred_boxes', [1, 300, 4]), tensorMeta('pred_logits', [1, 300, 6])],
    );
    expect(result).toEqual({ detsName: 'pred_boxes', labelsName: 'pred_logits' });
  });

  it('порядок в outputNames не важен — решает форма, а не позиция', () => {
    const result = resolveOutputNames(
      ['logits', 'boxes'],
      [tensorMeta('logits', [1, 300, 6]), tensorMeta('boxes', [1, 300, 4])],
    );
    expect(result).toEqual({ detsName: 'boxes', labelsName: 'logits' });
  });

  it('неоднозначность размерности (3 известных класса → labels тоже 4 столбца) решается по имени', () => {
    const result = resolveOutputNames(
      ['dets', 'labels'],
      [tensorMeta('dets', [1, 300, 4]), tensorMeta('labels', [1, 300, 4])],
    );
    expect(result).toEqual({ detsName: 'dets', labelsName: 'labels' });
  });

  it('неоднозначность размерности решается по имени независимо от порядка', () => {
    const result = resolveOutputNames(
      ['class_logits', 'output_boxes'],
      [tensorMeta('class_logits', [1, 300, 4]), tensorMeta('output_boxes', [1, 300, 4])],
    );
    expect(result).toEqual({ detsName: 'output_boxes', labelsName: 'class_logits' });
  });

  it('ни размерность, ни имя не различают выходы — честный отказ', () => {
    expect(() =>
      resolveOutputNames(
        ['output_0', 'output_1'],
        [tensorMeta('output_0', [1, 300, 4]), tensorMeta('output_1', [1, 300, 4])],
      ),
    ).toThrow(DetectionModelMismatchError);
  });

  it('не ровно 2 выхода — честный отказ', () => {
    expect(() => resolveOutputNames(['only_one'], [tensorMeta('only_one', [1, 300, 4])])).toThrow(
      DetectionModelMismatchError,
    );
    expect(() =>
      resolveOutputNames(
        ['a', 'b', 'c'],
        [tensorMeta('a', [1, 4]), tensorMeta('b', [1, 6]), tensorMeta('c', [1, 2])],
      ),
    ).toThrow(DetectionModelMismatchError);
  });

  it('метаданные без формы (не-тензор либо отсутствуют) — не рушит, работает через fallback по имени', () => {
    const result = resolveOutputNames(['boxes_out', 'logits_out'], []);
    expect(result).toEqual({ detsName: 'boxes_out', labelsName: 'logits_out' });
  });
});
