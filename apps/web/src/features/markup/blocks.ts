/**
 * Представление блоков разметки: цвет по типу, номер по порядку чтения (§7.2).
 *
 * Цвет — не единственный признак типа. Рамка получает ещё и штриховку, а номер
 * подписывается текстом: различение исключительно цветом недоступно примерно
 * восьми процентам мужчин, и требование accessibility (§17) это прямо
 * закрывает. По той же причине у каждого блока есть текстовое имя в выборе
 * блока на панели инструментов и в `aria-label` на канве.
 */
import type { BlockType } from '@id/contracts';
import type { LayoutBlock } from '../../api/types.js';
import { BLOCK_TYPE_LABELS } from '../../shared/labels.js';
import { areaOf } from './geometry.js';

export interface BlockStyle {
  readonly stroke: string;
  readonly fill: string;
  /**
   * Штриховка: второй, не цветовой признак типа. Пустой массив — сплошная
   * линия; `undefined` здесь недопустим: Konva объявляет свойство `dash`
   * неопциональным, а `exactOptionalPropertyTypes` запрещает передать в такое
   * свойство отсутствующее значение.
   */
  readonly dash: number[];
  readonly label: string;
}

/**
 * Палитра.
 *
 * Три типа, три различимых и в оттенках серого цвета: синий (тёмный), янтарный
 * (средний), пурпурный (тёмный с другой насыщенностью). Заливка полупрозрачна,
 * иначе рамка скрывала бы то, ради чего её и рисуют.
 *
 * Подпись берётся из общего словаря `BLOCK_TYPE_LABELS`, а не пишется здесь
 * второй раз: тип блока называется и на канве, и в списке блоков, и в панели
 * инструментов, и две формулировки одного типа читаются как два разных типа.
 */
export const BLOCK_STYLES: Record<BlockType, BlockStyle> = {
  text: {
    stroke: '#1d4ed8',
    fill: 'rgba(29, 78, 216, 0.10)',
    dash: [],
    label: BLOCK_TYPE_LABELS.text,
  },
  image: {
    stroke: '#b45309',
    fill: 'rgba(180, 83, 9, 0.12)',
    dash: [10, 5],
    label: BLOCK_TYPE_LABELS.image,
  },
  stamp: {
    stroke: '#7e22ce',
    fill: 'rgba(126, 34, 206, 0.12)',
    dash: [3, 3],
    label: BLOCK_TYPE_LABELS.stamp,
  },
};

export const SELECTION_STROKE = '#0f172a';

/**
 * Порядок чтения.
 *
 * `sort_order` назначает сервер, и он может иметь разрывы: после удаления блока
 * в нумерации остаётся дыра, а `blocks_hash` считается по плотному РАНГУ
 * (BLOCKS_HASH_VERSION = 2, урок S7). Номер на канве — тоже ранг: пользователь
 * должен видеть «1, 2, 3», а не «1, 3, 7», иначе он попытается «починить»
 * нумерацию, которая ничего не значит.
 */
export function sortedForReading(blocks: readonly LayoutBlock[]): LayoutBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.workingPageIndex !== b.workingPageIndex) return a.workingPageIndex - b.workingPageIndex;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    // Устойчивость при совпадении: иначе номера прыгают между перерисовками.
    return a.id.localeCompare(b.id);
  });
}

/** Ранг блока в пределах страницы, начиная с единицы. */
export function readingRanks(blocks: readonly LayoutBlock[]): Map<string, number> {
  const ranks = new Map<string, number>();
  const perPage = new Map<number, number>();
  for (const block of sortedForReading(blocks)) {
    const next = (perPage.get(block.workingPageIndex) ?? 0) + 1;
    perPage.set(block.workingPageIndex, next);
    ranks.set(block.id, next);
  }
  return ranks;
}

/** Доля площади страницы, покрытая блоками; перекрытия не вычитаются. */
export function coverageOf(blocks: readonly LayoutBlock[]): number {
  return blocks.reduce((sum, block) => sum + areaOf(block.coords), 0);
}

/** Короткое имя блока для выбора в панели и для `aria-label`. */
export function describeBlock(block: LayoutBlock, rank: number): string {
  const style = BLOCK_STYLES[block.blockType];
  const percent = Math.round(areaOf(block.coords) * 100);
  return `${String(rank)}. ${style.label}, ${String(percent)}% страницы`;
}
