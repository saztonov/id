/**
 * Состояние экрана разметки, не относящееся к серверу.
 *
 * Разделение простое и держится строго: всё, что живёт на сервере (блоки,
 * версия ревизии разметки, флаги внимания), читается TanStack Query и здесь НЕ
 * дублируется. Здесь только то, чего сервер не знает: какая страница открыта,
 * что выделено, какой инструмент включён, как отфильтрован список.
 *
 * Копия серверных данных в этом хранилище была бы вторым источником правды о
 * блоках, и разошлась бы она молча — ровно тем способом, которым на S2
 * разъехались схема SQL и схема Drizzle.
 */
import { create } from 'zustand';
import type { BlockType } from '@id/contracts';
import { EMPTY_FILTER, type BlockFilter } from './blocks.js';
import {
  DEFAULT_SIZES,
  NARROW_WORKSPACE,
  readColumnSizes,
  writeColumnSizes,
  type ColumnSizes,
} from './workspaceLayout.js';
import type { ZoomMode } from './zoom.js';

/** Инструмент канвы. Рисование включается явно, иначе перетаскивание рамки и
 * рисование новой различались бы только тем, попал ли курсор в существующий
 * блок, — и промах создавал бы блок вместо переноса. */
export type CanvasTool = 'select' | 'draw';

interface MarkupState {
  readonly workingPageIndex: number;
  readonly tool: CanvasTool;
  /** Тип, которым рисуется новый блок и который применяется к выделенным. */
  readonly draftType: BlockType;
  readonly selection: ReadonlySet<string>;
  readonly filter: BlockFilter;
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
  /** Доли четырёх колонок рабочей области; переживают уход на другую вкладку. */
  readonly columnSizes: ColumnSizes;
  /** Свёрнута ли колонка распознанного текста. */
  readonly textCollapsed: boolean;

  goToPage: (workingPageIndex: number) => void;
  setTool: (tool: CanvasTool) => void;
  setDraftType: (blockType: BlockType) => void;
  setZoomMode: (mode: ZoomMode) => void;
  /** Ручной масштаб: сам переводит режим в `manual`. */
  setManualZoom: (zoom: number) => void;
  setColumnSizes: (sizes: ColumnSizes) => void;
  toggleTextColumn: () => void;
  resetColumns: () => void;
  setFilter: (patch: Partial<BlockFilter>) => void;

  /** Одиночный выбор: заменяет выделение. */
  select: (blockId: string) => void;
  /** Множественный выбор: добавляет или снимает один блок. */
  toggle: (blockId: string) => void;
  selectMany: (blockIds: readonly string[]) => void;
  clearSelection: () => void;
  /** Снятие с выделения блоков, которых больше нет на сервере. */
  retainExisting: (existingIds: readonly string[]) => void;
}

/**
 * Стартовое состояние колонки текста.
 *
 * На узком экране три живые колонки полезнее четырёх огрызков, поэтому текст
 * стартует свёрнутым — но ТОЛЬКО пока человек ничего не выбрал сам: как только
 * он развернёт текст и подвинет разделитель, выбор запомнится, и порог больше
 * ни на что не влияет.
 */
function initialTextCollapsed(hasStoredSizes: boolean): boolean {
  if (hasStoredSizes) return false;
  try {
    return window.innerWidth < NARROW_WORKSPACE;
  } catch {
    return false;
  }
}

const storedSizes = readColumnSizes();

export const useMarkupStore = create<MarkupState>((set) => ({
  workingPageIndex: 0,
  tool: 'select',
  draftType: 'text',
  selection: new Set<string>(),
  filter: EMPTY_FILTER,
  zoomMode: 'fit-page',
  zoom: 1,
  columnSizes: storedSizes ?? DEFAULT_SIZES,
  textCollapsed: initialTextCollapsed(storedSizes !== null),

  goToPage: (workingPageIndex) => {
    // Выделение снимается при переходе: применение типа «к выделенным» иначе
    // затронуло бы блоки страницы, которую пользователь уже не видит.
    set({ workingPageIndex, selection: new Set<string>() });
  },
  setTool: (tool) => set({ tool }),
  setDraftType: (draftType) => set({ draftType }),
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
  setFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),

  select: (blockId) => set({ selection: new Set([blockId]) }),
  toggle: (blockId) =>
    set((state) => {
      const next = new Set(state.selection);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return { selection: next };
    }),
  selectMany: (blockIds) => set({ selection: new Set(blockIds) }),
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
