/**
 * Ручная метка страницы (§8.2, фаза 3).
 *
 * Жил в `features/documents/`, пока меток было два места: таблица
 * классификаций на вкладке «Документы» и панель типа страницы на разметке.
 * Вкладка удалена вместе с разделом (S27, ADR-0016) — метку ставят только с
 * разметки, и хук переехал к единственному вызывающему. Он остался отдельным
 * файлом, а не растворился в панели: семантика меток — это протокол
 * сегментации, и место, где она записана словами, ценнее экономии на файле.
 *
 * Семантика меток зашита здесь, а не у вызывающих: `B-DOC` — страница начинает
 * документ указанного вида, `I-DOC` — продолжает предыдущий (собственного типа
 * нет). Литералы в двух экранах — это две копии протокола сегментации, которые
 * разъезжаются молча.
 *
 * Метка — свойство РЕВИЗИИ ПОСТАВКИ, а не ревизии разметки: она хранится в
 * `page_classifications` по `source_page_id` и переживает пересборку. Поэтому
 * хук не знает про состояние разметки вовсе.
 */
import { App as AntApp } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { documents } from '../../api/endpoints.js';
import { folderKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';

export interface UseManualLabelResult {
  /** Идёт любая из мутаций метки: контролы на это время выключаются. */
  readonly pending: boolean;
  /** Страница начинает документ указанного вида ИД (`B-DOC`). */
  readonly setType: (sourcePageId: string, docTypeCode: string) => void;
  /** Страница продолжает предыдущий документ (`I-DOC`, без собственного типа). */
  readonly setContinuation: (sourcePageId: string) => void;
  /** Снятие ручной метки: страница классифицируется при следующей сборке. */
  readonly clear: (sourcePageId: string) => void;
}

export function useManualLabel(folderId: string): UseManualLabelResult {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();

  const refreshClassifications = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: folderKeys.classifications(folderId) });
  };

  const setManual = useMutation({
    mutationFn: (input: { sourcePageId: string; label: string; docTypeCode: string | null }) =>
      documents.setManualLabel(folderId, input.sourcePageId, {
        label: input.label,
        docTypeCode: input.docTypeCode,
      }),
    onSuccess: async () => {
      message.success('Метка страницы сохранена; пересборка — кнопкой «Собрать документы»');
      await refreshClassifications();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const clearManual = useMutation({
    mutationFn: (sourcePageId: string) => documents.clearManualLabel(folderId, sourcePageId),
    onSuccess: async () => {
      message.success('Ручная метка снята: страница классифицируется при следующей сборке');
      await refreshClassifications();
    },
    onError: (error) => message.error(describeError(error)),
  });

  return {
    pending: setManual.isPending || clearManual.isPending,
    setType: (sourcePageId, docTypeCode) =>
      setManual.mutate({ sourcePageId, label: 'B-DOC', docTypeCode }),
    setContinuation: (sourcePageId) =>
      setManual.mutate({ sourcePageId, label: 'I-DOC', docTypeCode: null }),
    clear: (sourcePageId) => clearManual.mutate(sourcePageId),
  };
}
