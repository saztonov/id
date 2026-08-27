/**
 * Масштаб страницы на экране разметки (§7.1).
 *
 * ## Почему хранится РЕЖИМ, а не число
 *
 * «По ширине» — это не значение масштаба, а правило его вычисления. Число,
 * посчитанное один раз, перестаёт соответствовать своему имени при первом же
 * изменении ширины колонки: человек тащит разделитель, а страница остаётся
 * прежней, хотя кнопка по-прежнему нажата. Поэтому наружу отдаётся `ZoomMode`, а
 * число считается на каждом рендере из фактически доступного места.
 *
 * ## Почему `fit-page` — это ровно 1
 *
 * `fitInto()` из `geometry.ts` уже вписывает страницу в область по МЕНЬШЕЙ из
 * двух сторон, то есть его результат и есть «страница целиком». Заводить здесь
 * вторую формулу вписывания значило бы держать два ответа на один вопрос и
 * узнать об их расхождении на первой же альбомной A3.
 *
 * ## Почему плавный зум не разоряет кэш pdf.js
 *
 * Разрешение рендера развязано с размером показа: `renderWidthFor()` квантует
 * ширину шагом 256 px, а `KonvaImage` масштабирует готовую канву сам. Поэтому
 * Ctrl+колесо с дробным множителем вызывает повторную отрисовку страницы только
 * при переходе через ступень — ровно ради этого квантование и заводилось.
 */
import type { RenderedSize } from './geometry.js';

/**
 * Ступени масштаба для кнопок «−»/«+».
 *
 * Жили в `store.ts`, пока масштаб был одним числом в состоянии. Переехали сюда
 * вместе со всей арифметикой: хранилище отвечает за то, ЧТО выбрано, а не за то,
 * из чего выбирают.
 */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

/** Границы ручного масштаба. Шире ступеней: Ctrl+колесо ходит между ними плавно. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

/** Множитель одного щелчка колеса. Подобран так, чтобы шаг был заметным, но не прыжком. */
export const WHEEL_ZOOM_FACTOR = 1.1;

export type ZoomMode = 'fit-page' | 'fit-width' | 'manual';

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/**
 * Соседняя ступень СТРОГО больше или строго меньше текущего значения.
 *
 * Строгость существенна: после Ctrl+колеса масштаб оказывается между ступенями,
 * и «ближайшая» ступень при нажатии «+» могла бы оказаться позади — кнопка
 * увеличения уменьшала бы картинку.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const safe = clampZoom(current);
  if (direction === 1) {
    const next = ZOOM_STEPS.find((step) => step > safe + 1e-6);
    return next ?? ZOOM_MAX;
  }
  const previous = [...ZOOM_STEPS].reverse().find((step) => step < safe - 1e-6);
  return previous ?? ZOOM_MIN;
}

/**
 * Действующий масштаб.
 *
 * `fitted` — размер страницы, уже вписанной в область (`fitInto`). Поэтому
 * `fit-page` даёт единицу, а `fit-width` — во сколько раз вписанную страницу надо
 * растянуть, чтобы она заняла область по ширине.
 */
export function effectiveZoom(
  mode: ZoomMode,
  manual: number,
  fitted: RenderedSize,
  available: RenderedSize,
): number {
  if (mode === 'manual') return clampZoom(manual);
  if (mode === 'fit-page') return 1;
  if (fitted.width <= 0 || available.width <= 0) return 1;
  return clampZoom(available.width / fitted.width);
}

export interface AnchoredScrollInput {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  /** Положение курсора относительно КЛИЕНТСКОЙ области контейнера прокрутки. */
  readonly pointerX: number;
  readonly pointerY: number;
  readonly before: RenderedSize;
  readonly after: RenderedSize;
}

/**
 * Прокрутка, при которой точка под курсором остаётся под курсором.
 *
 * Без этого зум колесом «уезжает»: человек наводится на штамп, крутит колесо и
 * теряет штамп из виду — потому что содержимое растёт от левого верхнего угла.
 * Формула — перевод точки документа в новый масштаб: `(scroll + pointer)` это
 * координата точки в содержимом, она умножается на отношение размеров, и обратно
 * вычитается положение курсора.
 */
export function anchoredScroll(input: AnchoredScrollInput): {
  readonly left: number;
  readonly top: number;
} {
  const ratioX = input.before.width > 0 ? input.after.width / input.before.width : 1;
  const ratioY = input.before.height > 0 ? input.after.height / input.before.height : 1;
  return {
    left: Math.max(0, (input.scrollLeft + input.pointerX) * ratioX - input.pointerX),
    top: Math.max(0, (input.scrollTop + input.pointerY) * ratioY - input.pointerY),
  };
}
