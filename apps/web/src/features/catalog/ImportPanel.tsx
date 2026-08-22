/**
 * Массовый ввод справочников: загрузка, предпросмотр, применение (§3.2, §14).
 *
 * ## Файл читает воркер, а не браузер
 *
 * Отсюда уходит только `PUT` с байтами по адресу, выданному сервером; разбирает
 * книгу воркер. Ни `xlsx`, ни `exceljs` в клиентском коде портала нет и быть не
 * должно: уязвимость офисного парсера в браузере — это рабочая машина
 * сотрудника, а не одна вкладка.
 *
 * ## Предпросмотр — это точка решения, а не отчёт
 *
 * Разобранные строки не заводят ничего. Пока администратор не нажал «Создать»,
 * в справочнике не появляется ни одной карточки, и это главное свойство экрана:
 * список, пришедший из чужого файла, обязан быть подтверждён человеком.
 *
 * ## Пока файл разбирается, экран опрашивает состояние
 *
 * Через `refetchInterval`, а не через поток событий: SSE в портале привязан к
 * ревизии поставки (§3.8), и заводить второй канал ради полуминутной задачи
 * значило бы держать соединение ради одного перехода статуса.
 */
import { useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CATALOG_IMPORT_COLUMNS, CATALOG_IMPORT_TARGET_LABELS } from '@id/contracts';
import { catalogImports } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { CatalogImport, CatalogImportRow } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { ToneTag } from '../../shared/tags.js';
import { useSession } from '../../app/session.js';

type Target = 'counterparties' | 'construction_objects';

const STATUS_LABELS: Record<CatalogImport['status'], string> = {
  uploading: 'ожидает файл',
  parsing: 'разбирается',
  ready: 'предпросмотр готов',
  applied: 'применён',
  failed: 'отклонён',
  expired: 'истёк',
};

const VERDICT_LABELS: Record<CatalogImportRow['verdict'], string> = {
  create: 'к созданию',
  duplicate: 'уже есть',
  error: 'с ошибкой',
};

/** Состояния, в которых имеет смысл переспрашивать сервер. */
function pollingIntervalOf(status: CatalogImport['status'] | undefined): number | false {
  return status === 'parsing' || status === 'uploading' ? 1500 : false;
}

export function ImportPanel(): ReactNode {
  const { can } = useSession();
  const [target, setTarget] = useState<Target>('counterparties');
  const [openImportId, setOpenImportId] = useState<string | null>(null);

  const imports = useQuery({
    queryKey: catalogKeys.imports(target),
    queryFn: () => catalogImports.list(target),
    // Пока хоть один импорт в работе, список обновляется сам: иначе человек
    // смотрит на «разбирается» и не знает, закончилось ли.
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((item) => pollingIntervalOf(item.status) !== false)
        ? 2000
        : false,
  });

  if (!can('settings.manage')) {
    return (
      <Alert
        type="info"
        showIcon
        message="Массовый ввод доступен администратору портала"
        description="Импорт заводит карточки справочника, поэтому закрыт тем же правом, что и заведение карточки вручную."
      />
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Segmented<Target>
          value={target}
          onChange={setTarget}
          options={[
            { value: 'counterparties', label: CATALOG_IMPORT_TARGET_LABELS.counterparties },
            {
              value: 'construction_objects',
              label: CATALOG_IMPORT_TARGET_LABELS.construction_objects,
            },
          ]}
        />
        <UploadButton target={target} onStarted={setOpenImportId} />
        <Button href={catalogImports.templateUrl(target)} data-testid="import-template">
          Скачать шаблон
        </Button>
      </Space>

      <ColumnHint target={target} />

      {imports.isPending && <LoadingState label="Загрузка списка импортов…" />}
      {imports.isError && <ErrorState error={imports.error} />}
      {imports.isSuccess && (
        <Table<CatalogImport>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={imports.data.items}
          locale={{ emptyText: 'Импортов этого справочника ещё не было' }}
          onRow={(row) => ({ onClick: () => setOpenImportId(row.id) })}
          columns={[
            { title: 'Файл', dataIndex: 'fileName', key: 'fileName' },
            {
              title: 'Состояние',
              dataIndex: 'status',
              key: 'status',
              render: (status: CatalogImport['status']) => (
                <ToneTag
                  tone={
                    status === 'applied'
                      ? 'success'
                      : status === 'failed' || status === 'expired'
                        ? 'danger'
                        : status === 'ready'
                          ? 'info'
                          : 'neutral'
                  }
                >
                  {STATUS_LABELS[status]}
                </ToneTag>
              ),
            },
            {
              title: 'Строк',
              key: 'counts',
              render: (_value, row) =>
                row.status === 'failed'
                  ? '—'
                  : `${String(row.rowCount)} (ошибок ${String(row.errorCount)}, дублей ${String(row.duplicateCount)})`,
            },
            { title: 'Заведено', dataIndex: 'createdCount', key: 'createdCount' },
            { title: 'Начат', dataIndex: 'createdAt', key: 'createdAt' },
          ]}
        />
      )}

      {openImportId !== null && (
        <ImportDialog importId={openImportId} onClose={() => setOpenImportId(null)} />
      )}
    </Space>
  );
}

/** Перечень колонок: он же — ответ на «почему портал не понял мой файл». */
function ColumnHint({ target }: { target: Target }): ReactNode {
  const columns = CATALOG_IMPORT_COLUMNS[target];
  return (
    <Card size="small" title="Колонки файла">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Колонки опознаются по заголовку, порядок значения не имеет. Неизвестный заголовок отклоняет
        файл целиком: столбец, который портал не понял, почти наверняка и есть тот, ради которого
        файл собирали.
      </Typography.Paragraph>
      <Space size={4} wrap>
        {columns.map((column) => (
          <Tag key={column.key} color={column.required ? 'blue' : 'default'}>
            {column.title}
            {column.required ? ' *' : ''}
          </Tag>
        ))}
      </Space>
    </Card>
  );
}

/**
 * Три шага приёма: `init`, `PUT` мимо портала, `complete`.
 *
 * `customRequest` у antd `Upload` — не обход компонента, а его штатная точка
 * подмены транспорта: свой у нас именно транспорт, а не выбор файла.
 */
function UploadButton({
  target,
  onStarted,
}: {
  target: Target;
  onStarted: (importId: string) => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const send = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const ticket = await catalogImports.init({
        target,
        fileName: file.name,
        sizeBytes: file.size,
      });

      const put = await fetch(ticket.uploadUrl, {
        method: ticket.method,
        headers: ticket.headers,
        body: file,
      });
      if (!put.ok) throw new Error(`Хранилище отклонило загрузку (${String(put.status)})`);

      await catalogImports.complete(ticket.importId, ticket.uploadId);
      await queryClient.invalidateQueries({ queryKey: ['catalog', 'imports'] });
      onStarted(ticket.importId);
      message.success('Файл принят, идёт разбор');
    } catch (error) {
      message.error(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Upload
      accept=".xlsx"
      showUploadList={false}
      customRequest={(options) => {
        void send(options.file as File);
      }}
    >
      <Button type="primary" loading={busy} data-testid="import-upload">
        Загрузить .xlsx
      </Button>
    </Upload>
  );
}

/** Предпросмотр одного импорта и решение по нему. */
function ImportDialog({ importId, onClose }: { importId: string; onClose: () => void }): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState<'all' | CatalogImportRow['verdict']>('all');

  const record = useQuery({
    queryKey: catalogKeys.import(importId),
    queryFn: () => catalogImports.one(importId),
    refetchInterval: (query) => pollingIntervalOf(query.state.data?.status),
  });

  const status = record.data?.status;
  const rows = useQuery({
    queryKey: catalogKeys.importRows(importId, verdict),
    queryFn: () => catalogImports.rows(importId, verdict === 'all' ? undefined : verdict),
    enabled: status === 'ready' || status === 'applied',
  });

  const apply = useMutation({
    mutationFn: () => catalogImports.apply(importId),
    onSuccess: async (result) => {
      message.success(
        `Заведено карточек: ${String(result.created)}` +
          (result.skipped > 0 ? `, пропущено дублей: ${String(result.skipped)}` : ''),
      );
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onError: (error) => message.error(describeError(error)),
  });

  const toCreate =
    record.data === undefined
      ? 0
      : record.data.rowCount - record.data.errorCount - record.data.duplicateCount;

  return (
    <Modal
      open
      onCancel={onClose}
      title="Импорт справочника"
      width={960}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          {status === 'ready' && (
            <Button
              type="primary"
              loading={apply.isPending}
              disabled={toCreate === 0}
              onClick={() => apply.mutate()}
              data-testid="import-apply"
            >
              {toCreate === 0 ? 'Заводить нечего' : `Создать ${String(toCreate)}`}
            </Button>
          )}
        </Space>
      }
      destroyOnHidden
    >
      {record.isPending && <LoadingState label="Загрузка карточки импорта…" />}
      {record.isError && <ErrorState error={record.error} />}
      {record.isSuccess && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Файл">{record.data.fileName}</Descriptions.Item>
            <Descriptions.Item label="Состояние">
              {STATUS_LABELS[record.data.status]}
            </Descriptions.Item>
            <Descriptions.Item label="Строк">{record.data.rowCount}</Descriptions.Item>
            <Descriptions.Item label="Заведено">{record.data.createdCount}</Descriptions.Item>
          </Descriptions>

          {record.data.status === 'failed' && (
            <Alert
              type="error"
              showIcon
              message="Файл отклонён целиком"
              description={record.data.failureReason ?? 'Причина не записана.'}
            />
          )}

          {(status === 'ready' || status === 'applied') && (
            <>
              <Segmented<'all' | CatalogImportRow['verdict']>
                value={verdict}
                onChange={setVerdict}
                options={[
                  { value: 'all', label: 'Все строки' },
                  { value: 'create', label: 'К созданию' },
                  { value: 'duplicate', label: 'Уже есть' },
                  { value: 'error', label: 'С ошибкой' },
                ]}
              />
              {rows.isError && <ErrorState error={rows.error} />}
              <Table<CatalogImportRow>
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ y: 360 }}
                loading={rows.isPending}
                dataSource={rows.data?.items ?? []}
                locale={{ emptyText: 'Строк с таким состоянием нет' }}
                columns={[
                  { title: '№ строки', dataIndex: 'rowNo', key: 'rowNo', width: 90 },
                  {
                    title: 'Значения',
                    key: 'raw',
                    render: (_value, row) => (
                      <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                        {Object.entries(row.raw)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join('; ')}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: 'Состояние',
                    dataIndex: 'verdict',
                    key: 'verdict',
                    width: 130,
                    render: (value: CatalogImportRow['verdict']) => (
                      <ToneTag
                        tone={
                          value === 'create' ? 'success' : value === 'error' ? 'danger' : 'neutral'
                        }
                      >
                        {VERDICT_LABELS[value]}
                      </ToneTag>
                    ),
                  },
                  {
                    title: 'Замечания',
                    key: 'problems',
                    render: (_value, row) =>
                      row.problems.length === 0 ? (
                        '—'
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {row.problems.map((problem) => (
                            <li key={`${problem.code}:${problem.column ?? ''}`}>
                              {problem.message}
                            </li>
                          ))}
                        </ul>
                      ),
                  },
                ]}
              />
            </>
          )}
        </Space>
      )}
    </Modal>
  );
}
