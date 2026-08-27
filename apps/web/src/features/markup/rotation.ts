/**
 * Разворот содержимого страницы на канве разметки (§7.1, ADR-0020).
 *
 * ## Вращается ВИД, а не координаты
 *
 * `layout_blocks.coords_norm` заданы в системе НЕповёрнутой страницы — той, что
 * отдаёт `page.getViewport()` с учётом `/Rotate` (см. шапку `geometry.ts`). Этот
 * модуль их не трогает вовсе: он считает пиксели сцены Konva. Скан, положенный
 * на лист боком, разворачивается для ГЛАЗ инженера и для картинки, уезжающей
 * модели, — но не для базы, где прямоугольник обязан остаться там же, где был.
 *
 * Величины две, и путать их нельзя:
 *
 * - `source_pages.rotation` — `/Rotate` из самого PDF. Уже применён: и к
 *   `width_px/height_px` карты страниц, и к вьюпорту pdf.js, и к растру poppler.
 * - `contentRotation` — скан лёг боком ВНУТРИ прямой страницы (`/Rotate = 0`).
 *   Не применён никем, правится человеком и определяется зондом.
 *
 * ## Соглашение о направлении — одно на весь портал
 *
 * `contentRotation` — на сколько градусов ПО ЧАСОВОЙ СТРЕЛКЕ нужно повернуть
 * страницу, чтобы текст читался нормально. Та же фраза дословно повторена в
 * `rotateRectNorm` (`@id/detection`), в комментарии колонки `page_orientations.
 * content_rotation` и в тексте промпта зонда: четыре разных места, читающие
 * одно число, обязаны понимать его одинаково, иначе страница уедет вверх ногами,
 * и это не упадёт — это просто будет неверно.
 *
 * ## Почему не CSS `transform: rotate()` на контейнере
 *
 * Konva берёт положение указателя из `getBoundingClientRect()` контейнера
 * (`konva/lib/Stage.js`, `_getContentPosition`): оттуда берутся и `left/top`, и
 * `scaleX = rect.width / content.clientWidth`. У повёрнутого элемента
 * `getBoundingClientRect()` возвращает ОСЕВУЮ рамку — при 90° её ширина равна
 * layout-высоте, тогда как `clientWidth` остаётся layout-шириной. Множитель
 * превращается в отношение высоты к ширине, а начало отсчёта указывает на угол
 * осевой рамки. Указатель уезжает и по смещению, и по масштабу, причём тем
 * сильнее, чем дальше от центра и чем непропорциональнее лист. Рамки при этом
 * продолжают рисоваться — просто не там, куда целились.
 *
 * ## Почему не `page.getViewport({ rotation })` в pdf.js
 *
 * Три следствия, и все плохие. Первое: меняется пространство ключей LRU-кэша
 * (`fileId:pageIndex:renderWidth`), и каждое нажатие «повернуть» становится
 * полной переотрисовкой A3 вместо бесплатного поворота уже готовой канвы.
 * Второе: поворот оказывается в ДВУХ местах — во вьюпорте для картинки и в Konva
 * для рамок, — и они обязаны совпадать; ровно тот класс расхождения, ради
 * обнаружения которого существует `framesAgree`. Третье: `naturalSize` станет
 * повёрнутым, и `framesAgree` начнёт падать на каждой странице, которую инженер
 * развернул, — то есть проверка целостности превратится в шум.
 */
import type { RenderedSize } from './geometry.js';

export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

/** Любое число к четверти оборота: −90 → 270, 450 → 90, мусор → 0. */
export function normalizeRotation(value: number): Rotation {
  if (!Number.isFinite(value)) return 0;
  const turns = Math.round(value / 90) % 4;
  const positive = ((turns % 4) + 4) % 4;
  return (positive * 90) as Rotation;
}

/** Поворот на четверть: `+1` — по часовой, `-1` — против. */
export function rotateBy(current: Rotation, quarterTurns: 1 | -1): Rotation {
  return normalizeRotation(current + quarterTurns * 90);
}

/** Меняет стороны местами на 90/270 и оставляет как есть на 0/180. */
export function applyRotation(size: RenderedSize, rotation: Rotation): RenderedSize {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

export interface ContentTransform {
  /** Размер сцены Konva: то, что видно на экране. */
  readonly stage: RenderedSize;
  /** Трансформация группы, внутри которой всё рисуется в координатах содержимого. */
  readonly group: { readonly x: number; readonly y: number; readonly rotation: Rotation };
}

/**
 * Перевод НЕповёрнутого содержимого в систему сцены.
 *
 * Konva вращает ноду вокруг её собственного начала координат, поэтому после
 * поворота содержимое уезжает в отрицательные координаты, и его надо вернуть
 * сдвигом. Значения выведены подстановкой углов: при 90° точка `(x, y)` идёт в
 * `(−y, x)`, и сдвиг на `(H, 0)` кладёт четыре угла листа `W×H` ровно в рамку
 * `[0, H] × [0, W]` — без отрицательных координат и без пустых полей.
 *
 * Формулы держатся ЗДЕСЬ и только здесь. Четыре `if (rotation === 90)`,
 * разбросанные по `PageCanvas`, — это гарантированное будущее расхождение
 * картинки и рамок, которое проявится на одной из четвертей и будет выглядеть
 * как «Konva глючит».
 */
export function contentTransform(content: RenderedSize, rotation: Rotation): ContentTransform {
  const stage = applyRotation(content, rotation);
  switch (rotation) {
    case 90:
      return { stage, group: { x: content.height, y: 0, rotation } };
    case 180:
      return { stage, group: { x: content.width, y: content.height, rotation } };
    case 270:
      return { stage, group: { x: 0, y: content.width, rotation } };
    default:
      return { stage, group: { x: 0, y: 0, rotation: 0 } };
  }
}

/**
 * Обратное преобразование: точка сцены → точка содержимого.
 *
 * В бою НЕ используется — там ту же работу делает Konva через
 * `getRelativePointerPosition()`, инвертируя `getAbsoluteTransform()` группы.
 * Функция существует ради теста: она независимый двойник того, что делает
 * библиотека, и расхождение между ними означает, что наш `contentTransform`
 * описывает не ту трансформацию, которую Konva применяет.
 */
export function contentPointOf(
  point: { readonly x: number; readonly y: number },
  content: RenderedSize,
  rotation: Rotation,
): { readonly x: number; readonly y: number } {
  switch (rotation) {
    case 90:
      return { x: point.y, y: content.height - point.x };
    case 180:
      return { x: content.width - point.x, y: content.height - point.y };
    case 270:
      return { x: content.width - point.y, y: point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

/** Подпись разворота для человека; `null` — разворота нет. */
export function describeRotation(rotation: Rotation): string | null {
  return rotation === 0 ? null : `${String(rotation)}°`;
}
