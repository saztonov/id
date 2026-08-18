/**
 * Детерминированный «детектор» блоков — замена RF-DETR из `blocks_detect.py`.
 *
 * ## Зачем вообще генератор, а не константа
 *
 * Порталу от детекции нужны РАЗНЫЕ страницы: и обычные, и пустые, и с аномально
 * мелким блоком — на них строятся флаги внимания S6. Одинаковая разметка на каждой
 * странице проверяла бы только то, что HTTP-вызов состоялся. При этом результат
 * обязан быть воспроизводимым между прогонами, иначе тест «на 50 страницах есть все
 * три типа» иногда падал бы — поэтому генератор детерминирован от
 * `(seed, document_id, page_index)`, без обращения к времени и `Math.random`.
 *
 * ## Правило раскладки (оно же — контракт для тестов)
 *
 * * 1..4 `text`-блока, разложенных по вертикальным полосам без взаимных перекрытий;
 * * каждая 7-я страница дополнительно получает `image`-блок в нижней полосе;
 * * каждая 11-я — `stamp` в правом нижнем углу (полосы `image` и `stamp` по X не
 *   пересекаются, поэтому и эти два блока не накладываются);
 * * каждая 13-я — один аномально мелкий блок (площадь < 0.2% страницы);
 * * каждая 17-я не даёт блоков вовсе.
 *
 * Периоды — взаимно простые числа, поэтому на 50 страницах все три типа встречаются
 * гарантированно, а «пустая» страница почти никогда не съедает единственную страницу
 * со штампом. Ни `confidence`, ни `model_id` наружу не выходят: их нет и в
 * `DetectBlocksResponse` оригинала.
 */
import type { BlockTypeName } from './state.js';

/** Один кандидат детекции: только геометрия и тип — как у `write_page_detection_blocks`. */
export interface DetectedBlock {
  readonly pageIndex: number;
  readonly blockType: BlockTypeName;
  readonly coordsNorm: readonly [number, number, number, number];
}

/** Периоды особых страниц. Взаимно простые — чтобы правила не глушили друг друга. */
const IMAGE_EVERY = 7;
const STAMP_EVERY = 11;
const TINY_EVERY = 13;
const EMPTY_EVERY = 17;

/** Поля страницы: текстовые блоки не выходят за них, штамп/картинка живут ниже. */
const TEXT_LEFT = 0.06;
const TEXT_RIGHT = 0.94;
const TEXT_TOP = 0.05;
const TEXT_BOTTOM = 0.88;

/** FNV-1a: короткая, без зависимостей и стабильная между платформами. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** xorshift32 поверх хэша: даёт воспроизводимую последовательность из [0,1). */
function makeRng(seedValue: number): () => number {
  let state = seedValue === 0 ? 0x9e3779b9 : seedValue;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Округление до 4 знаков с зажимом в [0,1]: инвариант координат — часть контракта. */
function norm(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 10000) / 10000;
}

function rect(
  pageIndex: number,
  blockType: BlockTypeName,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): DetectedBlock {
  const left = norm(Math.min(x0, x1));
  const right = norm(Math.max(x0, x1));
  const top = norm(Math.min(y0, y1));
  const bottom = norm(Math.max(y0, y1));
  return { pageIndex, blockType, coordsNorm: [left, top, right, bottom] };
}

/** Разметка одной страницы по правилу из докстроки модуля. */
export function detectPage(seed: string, documentId: string, pageIndex: number): DetectedBlock[] {
  if (pageIndex % EMPTY_EVERY === EMPTY_EVERY - 1) {
    return [];
  }
  const rng = makeRng(fnv1a(`${seed}|${documentId}|${pageIndex}`));
  const blocks: DetectedBlock[] = [];

  // Текст: n непересекающихся полос. Отступы внутри полосы меньше её высоты,
  // поэтому блок никогда не выходит за границы своей полосы.
  const count = 1 + Math.floor(rng() * 4);
  const band = (TEXT_BOTTOM - TEXT_TOP) / count;
  for (let i = 0; i < count; i += 1) {
    const bandTop = TEXT_TOP + i * band;
    const pad = band * 0.08;
    const y0 = bandTop + pad * rng();
    const y1 = bandTop + band - pad * (0.5 + 0.5 * rng());
    const x0 = TEXT_LEFT + 0.08 * rng();
    const x1 = TEXT_RIGHT - 0.08 * rng();
    blocks.push(rect(pageIndex, 'text', x0, y0, x1, y1));
  }

  if (pageIndex % IMAGE_EVERY === IMAGE_EVERY - 1) {
    const x0 = 0.08 + 0.04 * rng();
    const x1 = 0.5 + 0.05 * rng();
    blocks.push(rect(pageIndex, 'image', x0, 0.9, x1, 0.975));
  }

  if (pageIndex % STAMP_EVERY === STAMP_EVERY - 1) {
    const x0 = 0.7 + 0.03 * rng();
    const y0 = 0.9 + 0.02 * rng();
    blocks.push(rect(pageIndex, 'stamp', x0, y0, 0.97, 0.985));
  }

  if (pageIndex % TINY_EVERY === TINY_EVERY - 1) {
    // Аномалия «мелкий блок»: площадь ~0.05% страницы — вход для флага внимания.
    const x0 = 0.9 + 0.02 * rng();
    const y0 = 0.01 + 0.005 * rng();
    blocks.push(rect(pageIndex, 'text', x0, y0, x0 + 0.02, y0 + 0.025));
  }

  return blocks;
}

/** Разметка набора страниц — порядок сохраняется (как у синхронного роута оригинала). */
export function detectPages(
  seed: string,
  documentId: string,
  pageIndices: readonly number[],
): DetectedBlock[] {
  return pageIndices.flatMap((pageIndex) => detectPage(seed, documentId, pageIndex));
}
