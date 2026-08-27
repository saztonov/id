/**
 * Состояние экрана разметки, не относящееся к серверу.
 *
 * Разделение простое и держится строго: всё, что живёт на сервере (блоки,
 * версия ревизии разметки, флаги внимания), читается TanStack Query и здесь НЕ
 * дублируется. Здесь только то, чего сервер не знает: какая страница открыта,
 * что выделено, взведена ли обводка, как разложены колонки.
 *
 * Копия серверных данных в этом хранилище была бы вторым источником правды о
 * блоках, и разошлась бы она молча — ровно тем способом, которым на S2
 * разъехались схема SQL и схема Drizzle.
 */
import { create } from 'zustand';
import type { BlockType } from '@id/contracts';
import {
  DEFAULT_SIZES,
  readColumnSizes,
  writeColumnSizes,
  type ColumnSizes,
} from './workspaceLayout.js';
import type { ZoomMode } from './zoom.js';

interface MarkupState {
  readonly workingPageIndex: number;
  /**
   * Взведённый тип обводки: `null` — обычный режим, блоки выделяются и правятся.
   *
   * Прежде здесь стояла пара `tool: 'select' | 'draw'` плюс `draftType`, то есть
   * ДВА контрола на одно решение: сначала переключить инструмент, потом выбрать
   * тип. Теперь решение одно и принимается одной кнопкой типа — она же и есть
   * переключатель. Взвод одноразовый: после созданного блока он гаснет сам,
   * иначе промах мышью по листу заводил бы лишние рамки, пока человек не
   * вспомнит про переключатель.
   *
   * Рисование по-прежнему включается ЯВНО, и это существенно: без взвода
   * перетаскивание рамки и рисование новой различались бы только тем, попал ли
   * курсор в существующий блок, — и промах создавал бы блок вместо переноса.
   */
  readonly armedType: BlockType | null;
  readonly selection: ReadonlySet<string>;
  /**
   * Правило вычисления масштаба, а не само число.
   *
   * «По ширине» обязано пережить и смену страницы (у соседней другие
   * пропорции), и перетаскивание разделителя. Число, посчитанное однажды,
   * перестало бы соответствовать своему имени при первом же изменении ширины
   * колонки — кнопка нажата, а страница по ширине уже не влезает.
   */
  readonly zoomMode: ZoomMode;
  /** Значение РУЧНОГО режима; в двух других не читается. */
  readonly zoom: number;
  /** Доли трёх колонок рабочей области; переживают уход на другую вкладку. */
  readonly columnSizes: ColumnSizes;
  /** Свёрнута ли колонка распознанного текста. */
  readonly textCollapsed: boolean;

  goToPage: (workingPageIndex: number) => void;
  /** Взвести обводку этим типом; выделение при этом снимается. */
  armType: (blockType: BlockType) => void;
  /** Снять взвод: обводка отменена, экран вернулся к выделению. */
  disarm: () => void;
  setZoomMode: (mode: ZoomMode) => void;
  /** Ручной масштаб: сам переводит режим в `manual`. */
  setManualZoom: (zoom: number) => void;
  setColumnSizes: (sizes: ColumnSizes) => void;
  toggleTextColumn: () => void;
  resetColumns: () => void;

  /** Одиночный выбор: заменяет выделение. */
  select: (blockId: string) => void;
  /** Множественный выбор: добавляет или снимает один блок. */
  toggle: (blockId: string) => void;
  clearSelection: () => void;
  /** Снятие с выделения блоков, которых больше нет на сервере. */
  retainExisting: (existingIds: readonly string[]) => void;
}

export const useMarkupStore = create<MarkupState>((set) => ({
  workingPageIndex: 0,
  armedType: null,
  selection: new Set<string>(),
  zoomMode: 'fit-page',
  zoom: 1,
  columnSizes: readColumnSizes() ?? DEFAULT_SIZES,
  textCollapsed: false,

  goToPage: (workingPageIndex) => {
    // Выделение снимается при переходе: смена типа «у выделенного» иначе
    // затронула бы блоки страницы, которую пользователь уже не видит.
    //
    // Взвод снимается по той же причине: обводка, начатая для одной страницы и
    // доехавшая до другой, — это блок, поставленный не туда, куда целились.
    set({ workingPageIndex, selection: new Set<string>(), armedType: null });
  },
  // Взвод и выделение взаимно исключаются: кнопка типа при непустом выделении
  // МЕНЯЕТ тип, а взводится только на пустом. Оставленное выделение означало бы,
  // что следующий клик по типу сделает не то, что показывает подсветка кнопки.
  armType: (armedType) => set({ armedType, selection: new Set<string>() }),
  disarm: () => set({ armedType: null }),
  setZoomMode: (zoomMode) => set({ zoomMode }),
  setManualZoom: (zoom) => set({ zoom, zoomMode: 'manual' }),
  // Запись в хранилище браузера — здесь, а не в компоненте: действие одно, и
  // второе место, где его повторяют, разошлось бы с первым на первой же правке.
  setColumnSizes: (columnSizes) => {
    writeColumnSizes(columnSizes);
    set({ columnSizes });
  },
  toggleTextColumn: () => set((state) => ({ textCollapsed: !state.textCollapsed })),
  resetColumns: () => {
    writeColumnSizes(DEFAULT_SIZES);
    set({ columnSizes: DEFAULT_SIZES, textCollapsed: false });
  },

  // Выделение гасит взвод: человек передумал обводить и взялся за готовый блок,
  // а взведённая кнопка типа в этот момент показывала бы неправдой то, что
  // произойдёт по следующему клику.
  select: (blockId) => set({ selection: new Set([blockId]), armedType: null }),
  toggle: (blockId) =>
    set((state) => {
      const next = new Set(state.selection);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return { selection: next, armedType: null };
    }),
  clearSelection: () => set({ selection: new Set<string>() }),
  // Когда снимать нечего, возвращается ТОТ ЖЕ объект состояния, а не пустая
  // заплата: `set({})` собирает новый объект через `Object.assign` и будит
  // подписчиков, включая те компоненты, что читают хранилище целиком. Вызванный
  // из эффекта, он замыкает цикл «обновление → рендер → эффект → обновление».
  // `Object.is(next, state)` в zustand останавливает его на первом шаге.
  retainExisting: (existingIds) =>
    set((state) => {
      const allowed = new Set(existingIds);
      const next = new Set([...state.selection].filter((id) => allowed.has(id)));
      return next.size === state.selection.size ? state : { selection: next };
    }),
}));
