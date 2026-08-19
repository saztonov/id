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
  readonly zoom: number;

  goToPage: (workingPageIndex: number) => void;
  setTool: (tool: CanvasTool) => void;
  setDraftType: (blockType: BlockType) => void;
  setZoom: (zoom: number) => void;
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

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;

export const useMarkupStore = create<MarkupState>((set) => ({
  workingPageIndex: 0,
  tool: 'select',
  draftType: 'text',
  selection: new Set<string>(),
  filter: EMPTY_FILTER,
  zoom: 1,

  goToPage: (workingPageIndex) => {
    // Выделение снимается при переходе: применение типа «к выделенным» иначе
    // затронуло бы блоки страницы, которую пользователь уже не видит.
    set({ workingPageIndex, selection: new Set<string>() });
  },
  setTool: (tool) => set({ tool }),
  setDraftType: (draftType) => set({ draftType }),
  setZoom: (zoom) => set({ zoom }),
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
