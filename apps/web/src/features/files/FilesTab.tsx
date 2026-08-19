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
import { Alert, App as AntApp, Button, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bundles, files, layout } from '../../api/endpoints.js';
import { revisionKeys, layoutKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { SourceFile } from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { VERIFY_STATE_LABELS } from '../../shared/labels.js';

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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const list = useQuery({
    queryKey: revisionKeys.files(revisionId),
    queryFn: () => files.list(revisionId),
  });
  const bundleList = useQuery({
    queryKey: revisionKeys.bundles(revisionId),
    queryFn: () => bundles.list(revisionId),
  });

  const refreshAll = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: revisionKeys.files(revisionId) });
    await queryClient.invalidateQueries({ queryKey: revisionKeys.bundles(revisionId) });
  };

  /** Три шага приёма одного файла. */
  const uploadOne = async (file: File): Promise<void> => {
    const ticket = await files.initUpload(revisionId, file.name, file.size);
    const put = await fetch(ticket.uploadUrl, {
      method: ticket.method,
      headers: ticket.headers,
      body: file,
      // Драйвер `local` живёт на нашем origin, боевой S3 — на чужом.
      // `same-origin` не мешает первому и не отправляет cookie второму.
      credentials: 'same-origin',
    });
    if (!put.ok) {
      throw new Error(`Хранилище не приняло байты: HTTP ${String(put.status)}`);
    }
    const stored = await files.completeUpload(revisionId, ticket.uploadId);
    if (stored.verifyState === 'quarantined') {
      message.warning(
        `Файл «${stored.fileName}» помещён в карантин: ${stored.verifyError ?? 'причина не указана'}`,
      );
    }
  };

  /** Выбранная пачка целиком, по очереди и с остановкой на первом отказе. */
  const upload = async (selected: readonly File[]): Promise<void> => {
    setUploading(true);
    setProgress({ done: 0, total: selected.length });
    let accepted = 0;
    try {
      for (const file of selected) {
        await uploadOne(file);
        accepted += 1;
        setProgress({ done: accepted, total: selected.length });
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
            render: (_value, _row, index) => (
              <Space size={4}>
                <span>{index + 1}</span>
                <Button
                  size="small"
                  disabled={!editable || index === 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                  aria-label={`Переместить файл ${String(index + 1)} выше`}
                >
                  ↑
                </Button>
                <Button
                  size="small"
                  disabled={!editable || index === items.length - 1 || reorder.isPending}
                  onClick={() => move(index, 1)}
                  aria-label={`Переместить файл ${String(index + 1)} ниже`}
                >
                  ↓
                </Button>
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
            render: (_value, row) => (
              <Space size={6}>
                <a href={files.contentUrl(row.id)} target="_blank" rel="noreferrer">
                  Открыть
                </a>
                <Popconfirm
                  title="Удалить файл из ревизии?"
                  okText="Удалить"
                  cancelText="Отмена"
                  onConfirm={() => remove.mutate(row.id)}
                  disabled={!canUpload}
                >
                  <Button size="small" danger disabled={!canUpload}>
                    Удалить
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}
