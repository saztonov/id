/**
 * Сопоставление локальных блоков разметки с блоками RD WEB (§5.2, шаги 7–8).
 *
 * ## Почему по геометрии, а не по идентификатору
 *
 * Идентификатор блока на их стороне выдаётся ими и нам заранее неизвестен, а
 * `client_id` они возвращают только в ответе на create и нигде не хранят.
 * Хранить сопоставление у себя тоже нельзя честно: цикл сверки пересоздаёт
 * блоки при каждом расхождении, и таблица связей разъехалась бы с фактом ровно
 * тогда, когда она нужнее всего.
 *
 * Зато на момент забора экспорта у нас есть доказательство, которого хватает:
 * канонические хэши совпали ДО старта OCR и не изменились ПОСЛЕ. То есть
 * мультимножества блоков двух сторон равны, и сопоставление по той же
 * канонической форме — не эвристика, а следствие уже проверенного равенства.
 *
 * Порядок внутри группы «страница × тип» берётся тем же плотным рангом, что
 * входит в `computeBlocksHash`: два блока с одинаковой геометрией в одной
 * группе различимы только позицией, и другого различителя не существует ни у
 * одной из сторон.
 */
import type { BlockType, ShapeType } from '@id/contracts';

const COORD_PRECISION = 6;

function fixed(value: number): string {
  const text = value.toFixed(COORD_PRECISION);
  return text === `-${(0).toFixed(COORD_PRECISION)}` ? (0).toFixed(COORD_PRECISION) : text;
}

export interface MatchableBlock {
  readonly workingPageIndex: number;
  readonly blockType: BlockType | string;
  readonly shapeType: ShapeType | string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly sortOrder: number;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export function geometryKey(block: MatchableBlock): string {
  const points = block.points.map((point) => `${fixed(point.x)},${fixed(point.y)}`).join(';');
  return [
    block.workingPageIndex,
    block.blockType,
    block.shapeType,
    fixed(block.x0),
    fixed(block.y0),
    fixed(block.x1),
    fixed(block.y1),
    points,
  ].join('|');
}

/** Позиционный ключ: геометрия плюс ранг внутри группы «страница × тип». */
function positionKeys<T extends MatchableBlock>(blocks: readonly T[]): Map<string, T> {
  const groups = new Map<string, T[]>();
  for (const block of blocks) {
    const key = `${block.workingPageIndex}|${block.blockType}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [block]);
    else list.push(block);
  }

  const result = new Map<string, T>();
  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      const left = geometryKey(a);
      const right = geometryKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    ordered.forEach((block, rank) => {
      result.set(`${geometryKey(block)}|#${rank}`, block);
    });
  }
  return result;
}

export interface BlockMatch<L, R> {
  readonly local: L;
  readonly remote: R;
}

export interface MatchResult<L, R> {
  readonly matched: readonly BlockMatch<L, R>[];
  /** Локальные блоки, которым не нашлось пары. Непустой список — дефект сверки. */
  readonly unmatchedLocal: readonly L[];
  readonly unmatchedRemote: readonly R[];
}

export function matchBlocks<L extends MatchableBlock, R extends MatchableBlock>(
  local: readonly L[],
  remote: readonly R[],
): MatchResult<L, R> {
  const localKeys = positionKeys(local);
  const remoteKeys = positionKeys(remote);

  const matched: BlockMatch<L, R>[] = [];
  const unmatchedLocal: L[] = [];
  for (const [key, block] of localKeys) {
    const pair = remoteKeys.get(key);
    if (pair === undefined) unmatchedLocal.push(block);
    else matched.push({ local: block, remote: pair });
  }

  const usedRemote = new Set(matched.map((pair) => pair.remote));
  const unmatchedRemote = [...remoteKeys.values()].filter((block) => !usedRemote.has(block));
  return { matched, unmatchedLocal, unmatchedRemote };
}
