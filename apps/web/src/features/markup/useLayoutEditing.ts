/**
 * Правка разметки: оптимистичная версия, `If-Match`, разбор конфликта (§7.2).
 *
 * ## Версия берётся из ответа, а не наращивается на клиенте
 *
 * Каждая мутация возвращает новую версию ревизии разметки в теле и в `ETag`.
 * Клиент запоминает именно её. Соблазн писать `version + 1` велик и неверен:
 * пакетная операция (замена страницы одним блоком, профиль `full-page-text`)
 * поднимает версию не на единицу, и предсказанное значение разошлось бы с
 * фактическим — а расплата за расхождение это 412 на следующей же правке.
 *
 * ## Конфликт не приводит к повтору сам
 *
 * На 412 набор блоков перечитывается, считается расхождение (`conflict.ts`) и
 * возвращается пользователю. Автоматический повтор с новой версией — это и есть
 * молчаливая перезапись чужой работы, которую §7.2 запрещает прямым текстом.
 * Решение принимает человек: принять серверную версию или применить свою правку
 * заново, уже видя, что именно он затрёт.
 *
 * ## Пакетная операция останавливается на первом конфликте
 *
 * «Применить тип к выделенным» — это N запросов PATCH, каждый со своей версией.
 * Если третий получил 412, четвёртый посылать нельзя: он либо тоже получит 412,
 * либо (что хуже) пройдёт по случайно совпавшей версии, и часть выделения
 * окажется применённой, а часть нет — без следа для пользователя. Поэтому обход
 * прерывается, и в отчёте видно, сколько блоков успело измениться.
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BlockType } from '@id/contracts';
import { layout, type BlockCreateInput, type BlockUpdateInput } from '../../api/endpoints.js';
import { isVersionConflict } from '../../api/problem.js';
import type { LayoutBlock } from '../../api/types.js';
import { diffLayouts, type LayoutDiff } from './conflict.js';
import { layoutKeys } from '../../api/keys.js';

export interface ConflictReport {
  readonly diff: LayoutDiff;
  /** Версия, которая теперь на сервере. */
  readonly serverVersion: number;
  /** Сколько блоков успело измениться до конфликта в пакетной операции. */
  readonly appliedBefore: number;
}

export interface LayoutEditing {
  /** Текущая известная версия ревизии разметки. */
  readonly version: number;
  readonly busy: boolean;
  readonly conflict: ConflictReport | null;
  readonly dismissConflict: () => void;
  readonly createBlock: (input: BlockCreateInput) => Promise<void>;
  readonly updateBlock: (blockId: string, patch: BlockUpdateInput) => Promise<void>;
  readonly deleteBlock: (blockId: string) => Promise<void>;
  readonly deleteBlocks: (blockIds: readonly string[]) => Promise<void>;
  readonly applyTypeTo: (blockIds: readonly string[], blockType: BlockType) => Promise<void>;
  readonly replacePageWithText: (workingPageIndex: number) => Promise<void>;
  readonly applyFullPageProfile: () => Promise<void>;
}

export function useLayoutEditing(options: {
  readonly layoutId: string;
  readonly serverVersion: number;
  readonly blocks: readonly LayoutBlock[];
}): LayoutEditing {
  const { layoutId, serverVersion, blocks } = options;
  const queryClient = useQueryClient();

  // Локальная версия обгоняет ответ списка блоков между перезапросами: список
  // перечитывается после мутации, но до его прихода следующая правка обязана
  // уйти с версией, которую вернула предыдущая.
  const [optimisticVersion, setOptimisticVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictReport | null>(null);

  const version = optimisticVersion ?? serverVersion;

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: layoutKeys.detail(layoutId) });
    await queryClient.invalidateQueries({ queryKey: layoutKeys.blocks(layoutId) });
  }, [queryClient, layoutId]);

  /** Перечитать серверный набор и построить сравнение версий. */
  const buildConflict = useCallback(
    async (appliedBefore: number): Promise<void> => {
      const fresh = await layout.blocks(layoutId);
      setOptimisticVersion(fresh.version);
      setConflict({
        diff: diffLayouts(blocks, fresh.items),
        serverVersion: fresh.version,
        appliedBefore,
      });
      await invalidate();
    },
    [layoutId, blocks, invalidate],
  );

  /**
   * Обёртка одной мутации.
   *
   * Возвращает новую версию либо `null`, если случился конфликт. Значение `null`
   * — единственный способ для вызывающего понять, что обход нужно прервать.
   */
  const runOne = useCallback(
    async (
      call: (currentVersion: number) => Promise<{ version: number }>,
      currentVersion: number,
      appliedBefore: number,
    ): Promise<number | null> => {
      try {
        const result = await call(currentVersion);
        setOptimisticVersion(result.version);
        return result.version;
      } catch (error) {
        if (isVersionConflict(error)) {
          await buildConflict(appliedBefore);
          return null;
        }
        throw error;
      }
    },
    [buildConflict],
  );

  const single = useCallback(
    async (call: (currentVersion: number) => Promise<{ version: number }>): Promise<void> => {
      setBusy(true);
      try {
        const next = await runOne(call, version, 0);
        if (next !== null) await invalidate();
      } finally {
        setBusy(false);
      }
    },
    [runOne, version, invalidate],
  );

  const batch = useCallback(
    async (
      ids: readonly string[],
      call: (blockId: string, currentVersion: number) => Promise<{ version: number }>,
    ): Promise<void> => {
      setBusy(true);
      try {
        let current = version;
        let applied = 0;
        for (const id of ids) {
          const next = await runOne((v) => call(id, v), current, applied);
          if (next === null) break;
          current = next;
          applied += 1;
        }
        await invalidate();
      } finally {
        setBusy(false);
      }
    },
    [runOne, version, invalidate],
  );

  return {
    version,
    busy,
    conflict,
    dismissConflict: () => setConflict(null),

    createBlock: (input) =>
      single(async (v) => (await layout.createBlock(layoutId, v, input)).data),

    updateBlock: (blockId, patch) =>
      single(async (v) => (await layout.updateBlock(layoutId, blockId, v, patch)).data),

    deleteBlock: (blockId) =>
      single(async (v) => (await layout.deleteBlock(layoutId, blockId, v)).data),

    deleteBlocks: (blockIds) =>
      batch(blockIds, async (id, v) => (await layout.deleteBlock(layoutId, id, v)).data),

    applyTypeTo: (blockIds, blockType) =>
      batch(
        blockIds,
        async (id, v) => (await layout.updateBlock(layoutId, id, v, { blockType })).data,
      ),

    replacePageWithText: (workingPageIndex) =>
      single(async (v) => (await layout.replacePageWithText(layoutId, workingPageIndex, v)).data),

    applyFullPageProfile: () => single(async (v) => (await layout.fullPageText(layoutId, v)).data),
  };
}
