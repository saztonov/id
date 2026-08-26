/**
 * Замена файла в строке (S27).
 *
 * ## Почему отдельное действие, а не «удалить и загрузить»
 *
 * Между двумя этими нажатиями ревизия оказывается в состоянии, которого никто
 * не хотел: комплект без файла. Новый файл при этом встаёт последним и молча
 * перенумеровывает страницы — а вместе с ними номера в списке ошибок, по
 * которым человек только что искал листы в папке. И предупреждение о том, что
 * уйдут разметка, распознавание и все замечания, принадлежит намерению
 * «перезаливаю», а не намерению «удаляю».
 *
 * Заказчик описал этот путь дословно: «просто удалил старый файл, загрузил
 * новый — старая проверка сбрасывается».
 *
 * ## Одна мутация, всё остальное — на сервере
 *
 * Клиент выбирает файл и льёт байты; удаление старого, сброс анализа и вставка
 * нового на прежнюю позицию идут одной транзакцией на сервере. Пока байты не
 * проверены, в базе не меняется ничего: отказ проверки, карантин или обрыв
 * заливки оставляют комплект ровно таким, каким он был.
 */
import { useRef, useState, type ReactNode } from 'react';
import { App as AntApp, Modal, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { layoutKeys, revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { SourceFile } from '../../api/types.js';
import { IconAction } from '../../shared/RowActions.js';
import { ReplaceIcon } from '../../shared/icons.js';
import { replaceFile } from './upload.js';

export interface ReplaceFileActionProps {
  readonly revisionId: string;
  readonly file: SourceFile;
  readonly disabled: boolean;
  /** Почему нельзя, если нельзя: выключенная кнопка без причины читается как поломка. */
  readonly disabledReason?: string | undefined;
}

export function ReplaceFileAction(props: ReplaceFileActionProps): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);
  const [asking, setAsking] = useState(false);

  const replace = useMutation({
    mutationFn: (picked: File) =>
      replaceFile(props.revisionId, props.file.id, picked, (attempt, total) => {
        // Кнопка показывает только «идёт»: без этой строки повтор после отказа
        // хранилища выглядит как зависшая замена на несколько секунд.
        message.warning(
          `Хранилище не приняло файл, повтор ${String(attempt)} из ${String(total)}…`,
        );
      }),
    onSuccess: async (stored) => {
      message.success(`Файл заменён на «${stored.fileName}». Проверка сброшена.`);
      await queryClient.invalidateQueries({ queryKey: revisionKeys.files(props.revisionId) });
      await queryClient.invalidateQueries({ queryKey: revisionKeys.bundles(props.revisionId) });
      await queryClient.invalidateQueries({ queryKey: revisionKeys.findings(props.revisionId) });
      await queryClient.invalidateQueries({ queryKey: layoutKeys.revisions(props.revisionId) });
    },
    onError: (error) => message.error(describeError(error)),
  });

  return (
    <>
      <IconAction
        icon={<ReplaceIcon />}
        label={
          props.disabledReason === undefined
            ? `Заменить «${props.file.fileName}»`
            : `Заменить «${props.file.fileName}» — ${props.disabledReason}`
        }
        disabled={props.disabled}
        loading={replace.isPending}
        onClick={() => setAsking(true)}
        testId={`replace-file-${props.file.id}`}
      />

      {/*
        Скрытый `input` вместо `Upload` antd: заливка идёт голым `fetch` по
        presigned-адресу (см. `upload.ts`), и компонент, умеющий отправлять
        форму сам, здесь только мешал бы.
      */}
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = '';
          if (picked !== undefined) replace.mutate(picked);
        }}
      />

      <Modal
        open={asking}
        title={`Заменить «${props.file.fileName}»?`}
        okText="Выбрать новый файл"
        cancelText="Отмена"
        onCancel={() => setAsking(false)}
        onOk={() => {
          setAsking(false);
          input.current?.click();
        }}
        destroyOnHidden
      >
        <Typography.Paragraph>
          Старый файл будет удалён, новый займёт его место — порядок сохранится.
        </Typography.Paragraph>
        <Typography.Paragraph>
          Вместе со старым файлом уйдут разметка, распознанный текст, разобранные документы и все
          найденные ошибки: они описывали прежний файл и к новому не относятся.
        </Typography.Paragraph>
        <Typography.Paragraph>
          Ревизий портал при этом не заводит — комплект остаётся тем же. После замены:
          «1. Выделить блоки», затем «2. Распознать».
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
