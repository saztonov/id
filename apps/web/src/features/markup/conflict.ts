/**
 * Сравнение версий разметки при конфликте оптимистичной блокировки (§7.2).
 *
 * Единица конфликта — ревизия разметки целиком, а не блок: это решение принято
 * на стороне API и объяснено там же. Пользователь двигает рамку, второй в это
 * время удаляет соседнюю, и «мой блок не менялся» ничего не говорит о том, что
 * набор страницы уже другой. Поэтому сервер отвечает 412 на любую правку с
 * устаревшей версией.
 *
 * Требование этапа: при конфликте пользователь видит СРАВНЕНИЕ версий, а не
 * молчаливую перезапись. Отсюда форма этого модуля — не «показать ошибку», а
 * посчитать, чем набор на сервере отличается от того, что было на экране, и
 * назвать каждое расхождение. Молчаливая перезапись здесь означала бы повтор
 * запроса с новой версией без ведома человека — именно то, чего делать нельзя.
 *
 * Сравнение геометрии идёт с допуском. Координаты — `double precision`, и
 * округление при передаче через JSON даёт расхождения в пятнадцатом знаке;
 * строгое равенство объявило бы «изменено» у блока, которого никто не касался.
 */
import type { LayoutBlock } from '../../api/types.js';
import type { NormalizedCoords } from '../../api/types.js';

/** Допуск сравнения координат: 1e-9 доли страницы — это микрометры на A4. */
const COORD_EPSILON = 1e-9;

export interface BlockFieldChange {
  readonly field: 'blockType' | 'shapeType' | 'coords' | 'sortOrder';
  readonly mine: string;
  readonly theirs: string;
}

export interface ChangedBlock {
  readonly block: LayoutBlock;
  readonly changes: readonly BlockFieldChange[];
}

export interface LayoutDiff {
  /** Есть на сервере, не было на экране. */
  readonly added: readonly LayoutBlock[];
  /** Было на экране, на сервере нет. */
  readonly removed: readonly LayoutBlock[];
  /** Есть в обоих наборах, но отличается. */
  readonly changed: readonly ChangedBlock[];
  /** Пусто ли расхождение: тогда конфликт вызван правкой другой страницы. */
  readonly identical: boolean;
}

function sameCoords(a: NormalizedCoords, b: NormalizedCoords): boolean {
  return (
    Math.abs(a.x0 - b.x0) <= COORD_EPSILON &&
    Math.abs(a.y0 - b.y0) <= COORD_EPSILON &&
    Math.abs(a.x1 - b.x1) <= COORD_EPSILON &&
    Math.abs(a.y1 - b.y1) <= COORD_EPSILON
  );
}

function formatCoords(coords: NormalizedCoords): string {
  const round = (value: number): string => value.toFixed(3);
  return `${round(coords.x0)}, ${round(coords.y0)} — ${round(coords.x1)}, ${round(coords.y1)}`;
}

/**
 * Расхождение между набором на экране и набором на сервере.
 *
 * Направление названо явно: «added» — то, что появилось НА СЕРВЕРЕ. Обратное
 * прочтение («я добавил») даёт пользователю ровно противоположную картину, и
 * различить это по одному слову «добавлено» невозможно, поэтому оно вынесено в
 * докстринг и в подписи интерфейса.
 */
export function diffLayouts(
  mine: readonly LayoutBlock[],
  theirs: readonly LayoutBlock[],
): LayoutDiff {
  const mineById = new Map(mine.map((block) => [block.id, block]));
  const theirsById = new Map(theirs.map((block) => [block.id, block]));

  const added = theirs.filter((block) => !mineById.has(block.id));
  const removed = mine.filter((block) => !theirsById.has(block.id));

  const changed: ChangedBlock[] = [];
  for (const block of mine) {
    const other = theirsById.get(block.id);
    if (other === undefined) continue;

    const changes: BlockFieldChange[] = [];
    if (block.blockType !== other.blockType) {
      changes.push({ field: 'blockType', mine: block.blockType, theirs: other.blockType });
    }
    if (block.shapeType !== other.shapeType) {
      changes.push({ field: 'shapeType', mine: block.shapeType, theirs: other.shapeType });
    }
    if (!sameCoords(block.coords, other.coords)) {
      changes.push({
        field: 'coords',
        mine: formatCoords(block.coords),
        theirs: formatCoords(other.coords),
      });
    }
    if (block.sortOrder !== other.sortOrder) {
      changes.push({
        field: 'sortOrder',
        mine: String(block.sortOrder),
        theirs: String(other.sortOrder),
      });
    }
    if (changes.length > 0) changed.push({ block: other, changes });
  }

  return {
    added,
    removed,
    changed,
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

export const FIELD_LABELS: Record<BlockFieldChange['field'], string> = {
  blockType: 'Тип блока',
  shapeType: 'Форма',
  coords: 'Координаты',
  sortOrder: 'Порядок чтения',
};

/**
 * Итог расхождения одной строкой — для заголовка окна и для скринридера.
 *
 * «Расхождений нет» — законный и важный исход: версия могла уйти вперёд из-за
 * правки ДРУГОЙ страницы того же комплекта. Пользователю нужно сказать именно
 * это, а не показать пустую таблицу, из которой следует, будто сравнение не
 * сработало.
 */
export function summarizeDiff(diff: LayoutDiff): string {
  if (diff.identical) {
    return 'Состав блоков этой страницы не изменился: версию подняла правка другой страницы комплекта.';
  }
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`добавлено на сервере: ${String(diff.added.length)}`);
  if (diff.removed.length > 0) parts.push(`удалено на сервере: ${String(diff.removed.length)}`);
  if (diff.changed.length > 0) parts.push(`изменено: ${String(diff.changed.length)}`);
  return `Разметку изменил другой пользователь — ${parts.join(', ')}.`;
}
