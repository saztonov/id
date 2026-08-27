/**
 * Разворот содержимого страницы (§7.1, ADR-0020).
 *
 * ## Что это за величина
 *
 * Скан, положенный на лист боком: `/Rotate` у страницы нулевой, а текст идёт
 * вертикально. `contentRotation` отвечает, на сколько градусов по часовой
 * стрелке повернуть лист, чтобы он читался. Не путать с `page.rotation` — тем
 * самым `/Rotate`, который уже применён и к размерам карты страниц, и к
 * вьюпорту pdf.js.
 *
 * ## Свойство ПОСТАВКИ, а не разметки
 *
 * Значение хранится по `source_page_id` и переживает пересборку рабочего
 * документа — ровно как ручная метка вида ИД (`useManualLabel`). Ревизия
 * разметки в адресе не участвует вовсе: разворот описывает скан, а не рамки.
 *
 * ## Почему нет оптимистичного обновления
 *
 * Значение уезжает в распознавание: по нему разворачивается кроп, который
 * увидит модель. Вторая копия на клиенте означала бы, что картинка на экране
 * может расходиться с тем, что будет распознано, — то есть ровно ту молчаливую
 * рассинхронизацию, которую `store.ts` запрещает прямым текстом для блоков.
 * Задержка в один запрос честнее; на время мутации кнопки выключаются.
 */
import { App as AntApp } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { layout } from '../../api/endpoints.js';
import { revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { Rotation } from './rotation.js';

export interface UsePageOrientationResult {
  /** Идёт любая из мутаций разворота: кнопки поворота на это время выключены. */
  readonly pending: boolean;
  /** Задать разворот вручную; перекрывает значение зонда. */
  readonly setRotation: (sourcePageId: string, rotation: Rotation) => void;
  /** Снять ручной разворот: действующим становится значение зонда. */
  readonly clear: (sourcePageId: string) => void;
}

export function usePageOrientation(
  revisionId: string,
  bundleId: string | null,
): UsePageOrientationResult {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();

  /**
   * Обесценивается КАРТА СТРАНИЦ, а не отдельный запрос разворота.
   *
   * Разворот приезжает вместе с картой (одним левым соединением на сервере),
   * поэтому и лента страниц, и канва читают его оттуда. Отдельный кэш под него
   * был бы вторым источником одного значения — с гарантией разойтись в момент,
   * когда обновили только один из двух.
   */
  const refresh = async (): Promise<void> => {
    if (bundleId === null) return;
    await queryClient.invalidateQueries({ queryKey: revisionKeys.bundlePages(bundleId) });
  };

  const setMutation = useMutation({
    mutationFn: (input: { sourcePageId: string; rotation: Rotation }) =>
      layout.setOrientation(revisionId, input.sourcePageId, input.rotation),
    onSuccess: async (view) => {
      message.success(
        view.contentRotation === 0
          ? 'Разворот снят: страница считается прямой'
          : `Разворот сохранён: ${String(view.contentRotation)}°. ` +
              'Блоки этой страницы стоит выделить заново.',
      );
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const clearMutation = useMutation({
    mutationFn: (sourcePageId: string) => layout.clearOrientation(revisionId, sourcePageId),
    onSuccess: async (view) => {
      message.success(
        view.contentRotation === 0
          ? 'Ручной разворот снят: зонд считает страницу прямой'
          : `Ручной разворот снят: действует значение зонда, ${String(view.contentRotation)}°`,
      );
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  return {
    pending: setMutation.isPending || clearMutation.isPending,
    setRotation: (sourcePageId, rotation) => setMutation.mutate({ sourcePageId, rotation }),
    clear: (sourcePageId) => clearMutation.mutate(sourcePageId),
  };
}
