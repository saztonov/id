/**
 * Постобработка детекций в пиксельном пространстве страницы: class-aware NMS,
 * склейка text, пороги, ограничение количества.
 *
 * Порт `temp/RDNEW/services/web_ocr/detection/nms.py`. Инварианты референса:
 * - дубли из зон перекрытия tiles снимаются **class-aware** NMS (боксы разных
 *   классов не подавляют друг друга);
 * - «очевидно разрезанные» text-боксы объединяются лишь отдельной включаемой
 *   постобработкой и ТОЛЬКО для класса text (stamp/image не объединяются
 *   никогда);
 * - Weighted Boxes Fusion (`weighted_boxes_fusion` референса) НЕ портирован:
 *   по умолчанию выключен (`use_wbf=False`) и порталом не используется; при
 *   необходимости переносится отдельно с паритетными фикстурами.
 *
 * Все сортировки — стабильные (гарантия ES2019), как `sorted` в Python:
 * порядок равных score сохраняется, что важно для битового паритета.
 */

import { rectIou, type Rect } from './geometry.js';
import type { DetectionBlockType } from './postprocess.js';

/** Детекция в пикселях страницы: тип, xyxy, уверенность. */
export interface PixelDet {
  readonly blockType: DetectionBlockType;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly score: number;
}

export function pixelDetRect(det: PixelDet): Rect {
  return [det.x0, det.y0, det.x1, det.y1];
}

/** Группировка по классу с сохранением порядка первого появления (как dict в Python). */
function byClass(dets: readonly PixelDet[]): Map<DetectionBlockType, PixelDet[]> {
  const groups = new Map<DetectionBlockType, PixelDet[]>();
  for (const det of dets) {
    const group = groups.get(det.blockType);
    if (group) {
      group.push(det);
    } else {
      groups.set(det.blockType, [det]);
    }
  }
  return groups;
}

function sortByScoreDesc(dets: PixelDet[]): PixelDet[] {
  return dets.sort((a, b) => b.score - a.score);
}

/**
 * Class-aware NMS: подавляем перекрывающиеся боксы одного класса (IoU >= порога
 * против уже оставленных). Разные классы независимы. Возвращает список,
 * отсортированный по убыванию `score`.
 */
export function classAwareNms(
  dets: readonly PixelDet[],
  options: { readonly iouThreshold?: number } = {},
): PixelDet[] {
  const iouThreshold = options.iouThreshold ?? 0.5;
  if (!(iouThreshold >= 0 && iouThreshold <= 1)) {
    throw new RangeError('iouThreshold должен быть в [0, 1]');
  }
  const kept: PixelDet[] = [];
  for (const group of byClass(dets).values()) {
    const ordered = sortByScoreDesc([...group]);
    const keptRects: Rect[] = [];
    for (const det of ordered) {
      const r = pixelDetRect(det);
      if (keptRects.some((kr) => rectIou(r, kr) >= iouThreshold)) {
        continue;
      }
      kept.push(det);
      keptRects.push(r);
    }
  }
  return sortByScoreDesc(kept);
}

/**
 * Условие склейки двух text-боксов — дословный порт `_should_merge_text`.
 *
 * «На одной строке»: вертикальное перекрытие >= minOverlapRatio меньшей высоты
 * и горизонтальный зазор <= gapRatio меньшей высоты. «Стопкой»: горизонтальное
 * перекрытие >= minOverlapRatio меньшей ширины и вертикальный зазор <=
 * gapRatio меньшей ВЫСОТЫ (не ширины — так в референсе: зазор между строками
 * измеряется в высотах строки).
 */
function shouldMergeText(a: Rect, b: Rect, gapRatio: number, minOverlapRatio: number): boolean {
  const ha = a[3] - a[1];
  const hb = b[3] - b[1];
  const wa = a[2] - a[0];
  const wb = b[2] - b[0];
  const minH = Math.min(ha, hb);
  const minW = Math.min(wa, wb);
  if (minH <= 0 || minW <= 0) {
    return false;
  }
  const xOverlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const yOverlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const xGap = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
  const yGap = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
  const sameLine = yOverlap >= minOverlapRatio * minH && xGap <= gapRatio * minH;
  const stacked = xOverlap >= minOverlapRatio * minW && yGap <= gapRatio * minH;
  return sameLine || stacked;
}

/**
 * Опционально склеить очевидно разрезанные TEXT-боксы (например, на границах
 * tiles) — порт `merge_split_text_boxes` (union-find, bounding-box кластера,
 * score = максимум по членам). Объединяются ТОЛЬКО детекции класса text;
 * stamp и image передаются без изменений.
 */
export function mergeSplitTextBoxes(
  dets: readonly PixelDet[],
  options: { readonly gapRatio?: number; readonly minOverlapRatio?: number } = {},
): PixelDet[] {
  const gapRatio = options.gapRatio ?? 0.6;
  const minOverlapRatio = options.minOverlapRatio ?? 0.5;
  const items = [...dets];
  const text = items.filter((d) => d.blockType === 'text');
  const others = items.filter((d) => d.blockType !== 'text');
  if (text.length <= 1) {
    return items;
  }

  const rects = text.map(pixelDetRect);
  const parent = text.map((_, i) => i);

  const find = (start: number): number => {
    let i = start;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    parent[find(i)] = find(j);
  };

  for (let i = 0; i < text.length; i += 1) {
    for (let j = i + 1; j < text.length; j += 1) {
      if (shouldMergeText(rects[i] as Rect, rects[j] as Rect, gapRatio, minOverlapRatio)) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let idx = 0; idx < text.length; idx += 1) {
    const root = find(idx);
    const members = groups.get(root);
    if (members) {
      members.push(idx);
    } else {
      groups.set(root, [idx]);
    }
  }

  const merged: PixelDet[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      merged.push(text[members[0] as number] as PixelDet);
      continue;
    }
    const rs = members.map((m) => rects[m] as Rect);
    const score = Math.max(...members.map((m) => (text[m] as PixelDet).score));
    merged.push({
      blockType: 'text',
      x0: Math.min(...rs.map((r) => r[0])),
      y0: Math.min(...rs.map((r) => r[1])),
      x1: Math.max(...rs.map((r) => r[2])),
      y1: Math.max(...rs.map((r) => r[3])),
      score,
    });
  }

  return sortByScoreDesc([...merged, ...others]);
}

/** Оставить детекции, чей `score` не ниже порога своего класса (порт `filter_by_class_threshold`). */
export function filterByClassThreshold(
  dets: readonly PixelDet[],
  thresholds: Readonly<Partial<Record<DetectionBlockType, number>>>,
  defaultThreshold: number,
): PixelDet[] {
  return dets.filter((d) => d.score >= (thresholds[d.blockType] ?? defaultThreshold));
}

/** Ограничить число детекций top-N по убыванию score (`null` — без ограничения). */
export function capDetections(dets: readonly PixelDet[], maxDetections: number | null): PixelDet[] {
  const ordered = sortByScoreDesc([...dets]);
  if (maxDetections != null && maxDetections > 0) {
    return ordered.slice(0, maxDetections);
  }
  return ordered;
}
