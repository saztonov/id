/**
 * Вкладка «Файлы»: приём, порядок, статусы, карантин (§4.2, §14).
 *
 * ## Приём идёт тремя шагами, и это видно
 *
 * `init` → PUT байтов по выданному адресу → `complete`. Второй шаг выполняется
 * БЕЗ заголовка CSRF и без нашего JSON-обёртывания: адрес непрозрачен для
 * клиента (в бою это presigned PUT в S3), а клиент, заливающий 200 МБ, cookie не
 * держит. Поэтому здесь `fetch` вызывается напрямую, а не через `api/http.ts` —
 * это не обход правил, а требование контракта: общая обёртка приложила бы
 * заголовки, которые S3 отвергнет подписью.
 *
 * Размер заявляется на шаге `init`, чтобы отказ по лимиту пришёл ДО загрузки
 * двухсот мегабайт, а не после.
 *
 * ## Несколько файлов принимаются за один выбор, но по очереди
 *
 * §14 требует выбора нескольких файлов сразу: комплект приходит папкой сканов,
 * и двадцать раз нажать «Обзор» — это не работа. Загрузка при этом идёт
 * ПОСЛЕДОВАТЕЛЬНО, и на то две причины. Первая: порядок файлов в ревизии
 * назначает сервер по времени приёма, а параллельная заливка перемешала бы его
 * случайным образом — и рабочий документ собрался бы не в том порядке, в
 * котором инженер выбрал файлы. Вторая: отказ на пятом файле не должен оставлять
 * непонятным, что стало с шестым и седьмым; здесь обход просто останавливается,
 * а принятое до отказа названо числом.
 *
 * ## Две кнопки §6 разнесены по смыслу
 *
 * «Собрать рабочий документ» и «Разметить файл» стоят здесь, потому что обе
 * относятся к составу поставки. Вторая ставит задачу 4 конвейера; ответ 202
 * означает «поставлено в очередь», и экран это так и называет — обещать
 * готовность разметки в момент нажатия нельзя.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bundles, files, layout } from '../../api/endpoints.js';
import { revisionKeys, layoutKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { SourceFile } from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { VERIFY_STATE_LABELS } from '../../shared/labels.js';
import { ConfirmIconAction, IconAction, RowActions } from '../../shared/RowActions.js';
import { MoveDownIcon, MoveUpIcon, OpenIcon, TrashIcon } from '../../shared/icons.js';
import { ReplaceFileAction } from './ReplaceFileAction.js';
import { uploadFile, type UploadRetryListener } from './upload.js';

export interface FilesTabProps {
  readonly revisionId: string;
  readonly editable: boolean;
}

export function FilesTab({ revisionId, editable }: FilesTabProps): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  // `note` — то, что происходит прямо сейчас помимо счётчика: повтор заливки
  // после отказа хранилища. Без него портал молчит несколько секунд, и молчание
  // читается как зависание, а не как «пробуем ещё раз».
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    note: string | null;
  } | null>(null);

  const list = useQuery({
    queryKey: revisionKeys.files(revisionId),
    queryFn: () => files.list(revisionId),
  });
  const bundleList = useQuery({
    queryKey: revisionKeys.bundles(revisionId),
    queryFn: () => bundles.list(revisionId),
  });
  // Ревизии разметки читаются здесь ровно ради предупреждения об удалении: тот
  // же ключ уже держит экран разметки, поэтому второго запроса при переходе не
  // будет, а «удалить файл» без слов о том, что вместе с ним исчезнет разметка,
  // — это кнопка, о последствиях которой спрашивают уже постфактум.
  const layoutList = useQuery({
    queryKey: layoutKeys.revisions(revisionId),
    queryFn: () => layout.listRevisions(revisionId),
  });

  const refreshAll = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: revisionKeys.files(revisionId) });
    await queryClient.invalidateQueries({ queryKey: revisionKeys.bundles(revisionId) });
  };

  /** Три шага приёма одного файла; сама последовательность — в `upload.ts`. */
  const uploadOne = async (file: File, onRetry: UploadRetryListener): Promise<void> => {
    const stored = await uploadFile(revisionId, file, onRetry);
    if (stored.verifyState === 'quarantined') {
      message.warning(
        `Файл «${stored.fileName}» помещён в карантин: ${stored.verifyError ?? 'причина не указана'}`,
      );
    }
  };

  /** Выбранная пачка целиком, по очереди и с остановкой на первом отказе. */
  const upload = async (selected: readonly File[]): Promise<void> => {
    setUploading(true);
    setProgress({ done: 0, total: selected.length, note: null });
    let accepted = 0;
    try {
      for (const file of selected) {
        await uploadOne(file, (attempt, total) => {
          setProgress({
            done: accepted,
            total: selected.length,
            note: `хранилище не приняло файл, повтор ${String(attempt)} из ${String(total)}`,
          });
        });
        accepted += 1;
        setProgress({ done: accepted, total: selected.length, note: null });
      }
      message.success(
        selected.length === 1
          ? `Файл «${selected[0]?.name ?? ''}» принят`
          : `Принято файлов: ${String(accepted)} из ${String(selected.length)}`,
      );
    } catch (error) {
      message.error(
        accepted === 0
          ? describeError(error)
          : `Принято файлов: ${String(accepted)} из ${String(selected.length)}; остановились на отказе: ${describeError(error)}`,
      );
    } finally {
      setUploading(false);
      setProgress(null);
      await refreshAll();
      if (input.current !== null) input.current.value = '';
    }
  };

  const buildBundle = useMutation({
    mutationFn: () => bundles.build(revisionId),
    onSuccess: async (result) => {
      message.success(
        result.bundle !== null && !result.created
          ? 'Рабочий документ уже собран для этого состава'
          : 'Сборка рабочего документа поставлена в очередь',
      );
      await refreshAll();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const startMarkup = useMutation({
    mutationFn: () => layout.start(revisionId),
    onSuccess: async (result) => {
      message.success(
        result.jobCreated
          ? 'Разметка запущена: детекция пойдёт постраничными пачками'
          : 'Цепочка разметки уже стоит в очереди',
      );
      await queryClient.invalidateQueries({ queryKey: layoutKeys.revisions(revisionId) });
    },
    onError: (error) => message.error(describeError(error)),
  });

  const remove = useMutation({
    mutationFn: (fileId: string) => files.remove(revisionId, fileId),
    onSuccess: async () => {
      message.success('Файл удалён из ревизии');
      await refreshAll();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const reorder = useMutation({
    mutationFn: (fileIds: readonly string[]) => files.reorder(revisionId, fileIds),
    onSuccess: async () => {
      message.success('Порядок файлов сохранён');
      await refreshAll();
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (list.isPending) return <LoadingState label="Загрузка файлов…" />;
  if (list.isError) return <ErrorState error={list.error} />;

  const items = [...list.data].sort((a, b) => a.sortOrder - b.sortOrder);
  const quarantined = items.filter((file) => file.verifyState === 'quarantined');
  const canUpload = editable && can('submission.upload');
  const bundle = (bundleList.data ?? []).at(-1) ?? null;

  // Что именно аннулирует удаление файла. Пересчёт страниц ревизии обесценивает
  // рабочий документ целиком (разметка ложится на его страницы), а вместе с ним
  // — разметку и всё распознанное по ней. Молчаливое удаление выглядело бы
  // дешёвым действием, а стоит оно всего конвейера по этому комплекту.
  //
  // Разобранные документы и найденные ошибки названы отдельно (S27): прежний
  // текст молчал о них, хотя `purgeDerivedForRevision` сносит и то и другое, —
  // а именно за ними человек и приходит на вкладку «Проверка».
  const layoutCount = (layoutList.data ?? []).filter((item) => item.state !== 'superseded').length;
  const deletionWarning =
    bundle === null ? (
      'Страницы ревизии будут перенумерованы.'
    ) : (
      <>
        Вместе с файлом будет удалён рабочий документ ({bundle.pageCount}{' '}
        {plural(bundle.pageCount, 'страница', 'страницы', 'страниц')})
        {layoutCount > 0 && ' и разметка с распознанным текстом по ней'}, разобранные документы и
        все найденные ошибки. Разметить и распознать комплект придётся заново.
      </>
    );

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((file) => file.id);
    const moved = ids[index];
    const replaced = ids[target];
    if (moved === undefined || replaced === undefined) return;
    ids[index] = replaced;
    ids[target] = moved;
    reorder.mutate(ids);
  };

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/*"
          multiple
          disabled={!canUpload || uploading}
          aria-label="Файлы для загрузки в ревизию"
          onChange={(event) => {
            const selected = [...(event.target.files ?? [])];
            if (selected.length > 0) void upload(selected);
          }}
          data-testid="file-input"
        />
        {progress !== null && (
          <Typography.Text type="secondary" data-testid="upload-progress">
            загружено {progress.done} из {progress.total}
            {progress.note === null ? '' : ` — ${progress.note}`}
          </Typography.Text>
        )}
        <Button
          onClick={() => buildBundle.mutate()}
          loading={buildBundle.isPending}
          disabled={!editable || items.length === 0}
          data-testid="build-bundle"
        >
          Собрать рабочий документ
        </Button>
        <Button
          type="primary"
          onClick={() => startMarkup.mutate()}
          loading={startMarkup.isPending}
          disabled={!editable || bundle === null || !can('markup.edit')}
          data-testid="start-markup"
        >
          Разметить файл
        </Button>
      </Space>

      {bundle === null ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Рабочий документ не собран"
          description="Разметка ложится на страницы рабочего документа, поэтому сначала сборка, затем разметка."
        />
      ) : (
        <Typography.Paragraph type="secondary" data-testid="bundle-summary">
          Рабочий документ: страниц {bundle.pageCount}, состав{' '}
          {bundle.aggregateManifestHash.slice(0, 12)}…
        </Typography.Paragraph>
      )}

      {quarantined.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`Файлов в карантине: ${String(quarantined.length)}`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {quarantined.map((file) => (
                <li key={file.id}>
                  {file.fileName}: {file.verifyError ?? 'причина не указана'}
                </li>
              ))}
            </ul>
          }
        />
      )}

      <Table<SourceFile>
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={items}
        locale={{ emptyText: 'Файлов в ревизии нет' }}
        columns={[
          {
            title: '№',
            key: 'order',
            width: 110,
            render: (_value, row, index) => (
              <Space size={4}>
                <span>{index + 1}</span>
                <RowActions>
                  <IconAction
                    icon={<MoveUpIcon />}
                    label={`Переместить «${row.fileName}» выше`}
                    disabled={!editable || index === 0 || reorder.isPending}
                    onClick={() => move(index, -1)}
                  />
                  <IconAction
                    icon={<MoveDownIcon />}
                    label={`Переместить «${row.fileName}» ниже`}
                    disabled={!editable || index === items.length - 1 || reorder.isPending}
                    onClick={() => move(index, 1)}
                  />
                </RowActions>
              </Space>
            ),
          },
          { title: 'Имя файла', dataIndex: 'fileName', key: 'fileName' },
          {
            title: 'Состояние',
            dataIndex: 'verifyState',
            key: 'verifyState',
            render: (state: SourceFile['verifyState']) => (
              <Tag color={state === 'ok' ? 'green' : state === 'quarantined' ? 'red' : 'blue'}>
                {VERIFY_STATE_LABELS[state]}
              </Tag>
            ),
          },
          { title: 'Страниц', dataIndex: 'pageCount', key: 'pageCount' },
          {
            title: 'Размер',
            dataIndex: 'sizeBytes',
            key: 'sizeBytes',
            render: (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} МБ`,
          },
          {
            title: 'Действия',
            key: 'actions',
            width: 96,
            render: (_value, row) => (
              <RowActions>
                <IconAction
                  icon={<OpenIcon />}
                  label={`Открыть «${row.fileName}» в новой вкладке`}
                  href={files.contentUrl(row.id)}
                />
                <ReplaceFileAction
                  revisionId={revisionId}
                  file={row}
                  disabled={!canUpload}
                  {...(canUpload
                    ? {}
                    : {
                        disabledReason: editable
                          ? 'нет права на загрузку файлов'
                          : 'состав ревизии заперт, исправление вносится новой ревизией',
                      })}
                />
                <ConfirmIconAction
                  icon={<TrashIcon />}
                  label={`Удалить «${row.fileName}» из ревизии`}
                  danger
                  disabled={!canUpload}
                  loading={remove.isPending}
                  onClick={() => remove.mutate(row.id)}
                  confirmTitle={`Удалить «${row.fileName}»?`}
                  confirmDescription={deletionWarning}
                />
              </RowActions>
            ),
          },
        ]}
      />
    </>
  );
}

/** Склонение по русскому правилу: 1 страница, 2 страницы, 5 страниц. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
