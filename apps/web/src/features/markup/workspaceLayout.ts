/**
 * Ширины колонок рабочей области разметки (§7.1).
 *
 * ## Почему это отдельный модуль, а не пара строк в компоненте
 *
 * Здесь ровно та арифметика, которая ломается молча: доли колонок, прочитанные
 * из чужого хранилища. Испорченная запись не даёт исключения — она даёт экран,
 * сложенный в четыре нитки, и починить его пользователь не может ничем, кроме
 * очистки данных сайта. Поэтому разбор входа живёт в чистой функции под тестом,
 * а не в `useState(() => JSON.parse(...))`.
 *
 * ## Почему `localStorage`, а не сервер
 *
 * Ширина колонки зависит от ЭКРАНА, а не от комплекта: раскладка, настроенная
 * инженером на 27-дюймовом мониторе и приехавшая на ноутбук подрядчика, была бы
 * хуже, чем её отсутствие. Маршрута пользовательских настроек в API нет, и
 * заводить его ради четырёх чисел значило бы синхронизировать между людьми то,
 * что у каждого своё.
 *
 * ## Почему не `zustand/persist`
 *
 * В состоянии экрана лежит `selection: ReadonlySet<string>` — не сериализуемый
 * JSON. Пришлось бы городить `partialize`, `merge` и версию хранилища ради
 * четырёх чисел, и заодно случайно сохранился бы `workingPageIndex`: открывать
 * чужую поставку на 47-й странице — это дефект, а не удобство.
 *
 * ## Почему не `useState` в компоненте
 *
 * `Tabs` экрана ревизии стоит с `destroyOnHidden`, то есть `MarkupScreen`
 * размонтируется при каждом переходе на «Файлы» и обратно. Ширины сбрасывались
 * бы по нескольку раз за сеанс, и выглядело бы это как «настройка не
 * сохраняется».
 *
 * ## Почему ключ версионирован
 *
 * Число колонок ещё будет меняться. Сохранённый массив из трёх чисел, прочитанный
 * кодом на четыре панели, — это молча съехавшая раскладка, а не ошибка.
 */

/** Доли четырёх колонок в процентах; сумма ровно 100. */
export type ColumnSizes = readonly [number, number, number, number];

/**
 * Стартовые доли: лента / страница / текст / блоки.
 *
 * Страница получает почти половину намеренно: остальные три колонки читаются,
 * а она — рассматривается, и именно ей масштаб и поворот нужны больше всех.
 */
export const DEFAULT_SIZES: ColumnSizes = [15, 45, 22, 18];

/**
 * Минимальные ширины колонок в пикселях.
 *
 * Сумма — 880 px. Ниже этого колонки начинают наезжать друг на друга, но
 * раскладка остаётся живой: antd применяет минимумы при перетаскивании, а
 * стартовые проценты считает от доступной ширины.
 */
export const COLUMN_MIN = {
  strip: 160,
  canvas: 320,
  text: 180,
  blocks: 220,
} as const;

/**
 * Ширина рабочей области, ниже которой колонка текста стартует свёрнутой.
 *
 * Три живые колонки на ноутбуке полезнее четырёх огрызков. Значение действует
 * ТОЛЬКО при первом открытии: как только человек развернёт текст, выбор
 * запомнится и порог больше ни на что не влияет.
 */
export const NARROW_WORKSPACE = 1400;

const KEY = 'id.markup.columns.v1';

/**
 * Разбор сохранённых долей.
 *
 * Отвергается всё, из чего нельзя собрать четыре положительных числа: длина не
 * четыре, `NaN`, бесконечность, отрицательные, нулевая сумма, не-массив. Сумма
 * приводится к 100 — доли важны, а масштаб нет.
 */
export function normalizeColumnSizes(raw: unknown): ColumnSizes | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const values: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) return null;
    values.push(item);
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const scaled = values.map((value) => (value * 100) / total);
  return [scaled[0] ?? 0, scaled[1] ?? 0, scaled[2] ?? 0, scaled[3] ?? 0];
}

/** Доли из пикселей: `Splitter` отдаёт `onResizeEnd` именно пиксели. */
export function pixelsToPercent(pixels: readonly number[]): ColumnSizes | null {
  return normalizeColumnSizes([...pixels]);
}

export function readColumnSizes(): ColumnSizes | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === null) return null;
    return normalizeColumnSizes(JSON.parse(stored));
  } catch {
    // Приватное окно бросает на самом обращении; испорченный JSON — на разборе.
    // И то и другое означает одно: сохранённой раскладки нет.
    return null;
  }
}

export function writeColumnSizes(sizes: ColumnSizes): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sizes));
  } catch {
    // Не записалось — раскладка просто не переживёт перезагрузку.
  }
}

/**
 * Доли трёх колонок, когда текст свёрнут.
 *
 * Свёрнутая колонка не рисуется вовсе (см. `MarkupScreen`), поэтому `Splitter`
 * получает три панели и три числа. Доля текста при этом НЕ теряется: она
 * хранится отдельно и возвращается при разворачивании.
 */
export function sizesWithoutText(sizes: ColumnSizes): readonly [number, number, number] {
  const rest = sizes[0] + sizes[1] + sizes[3];
  if (rest <= 0) return [15, 55, 30];
  return [(sizes[0] * 100) / rest, (sizes[1] * 100) / rest, (sizes[3] * 100) / rest];
}

/**
 * Возврат трёх долей в четвёрку с сохранением прежней доли текста.
 *
 * Инженер таскал разделители, пока текст был свёрнут; развернув его, он вправе
 * увидеть свои пропорции, а не сброс к умолчанию.
 */
export function mergeSizesWithoutText(
  base: ColumnSizes,
  three: readonly number[],
): ColumnSizes | null {
  const strip = three[0] ?? 0;
  const canvas = three[1] ?? 0;
  const blocks = three[2] ?? 0;
  const restTotal = strip + canvas + blocks;
  if (![strip, canvas, blocks].every((v) => Number.isFinite(v) && v >= 0) || restTotal <= 0) {
    return null;
  }
  const textShare = base[2];
  const restShare = Math.max(0, 100 - textShare);
  return normalizeColumnSizes([
    (strip * restShare) / restTotal,
    (canvas * restShare) / restTotal,
    textShare,
    (blocks * restShare) / restTotal,
  ]);
}
