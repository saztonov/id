/**
 * Вкладка «Документы»: дерево документов, роли страниц, учёт страниц (§8, §14).
 *
 * ## Дерево, а не плоский список
 *
 * Документ — это не строка таблицы, а набор страниц с ролями: продолжение,
 * приложение, лист визуализации подписи, «копия верна». Плоская таблица со
 * счётчиком «страниц: 4» не даёт ответить на единственный вопрос, ради которого
 * границы и подтверждают: КАКИЕ это страницы и в каком порядке. Поэтому здесь
 * дерево, построенное из учёта страниц (`GET /revisions/{id}/pages`) — того же
 * ответа, который несёт причины непривязки.
 *
 * ## Непривязанные и неучтённые страницы — списком, а не числом
 *
 * `unassigned` — страница, у которой ЯВНО записана причина непривязки
 * (ограничение `page_assignments_state_chk` не даёт быть непривязанной молча).
 * `unaccounted` — страница, которой нет ни там, ни там; по §16 этот список
 * обязан быть пуст. Счётчик без списка превращает нарушение инварианта в число,
 * с которым нечего делать: непривязанная страница — это вопрос «почему», и
 * ответ на него уже лежит в поле `reason`.
 *
 * ## Правка границ: маршрута нет, и это сказано прямо
 *
 * Перенести страницу из одного документа в другой и назначить роль странице
 * портал через API не может: таких маршрутов в `apps/api/src/modules/documents`
 * нет. Подтверждение (`POST /documents/{id}/confirm`) принимает только вид ИД и
 * признак «нужна проверка». Экран с неработающим перетаскиванием строк был бы
 * хуже отсутствия правки, поэтому здесь названа недоступность и назван маршрут,
 * которого не хватает.
 *
 * ## Подтверждение границ идёт с `If-Match`
 *
 * Версия документа приходит в его представлении. Подтверждение ставит задачу
 * нарезки (§12), поэтому текст кнопки говорит именно о подтверждении, а не о
 * «сохранить»: у действия есть последствие за пределами экрана.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Select,
  Space,
  Table,
  Tree,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalog, documents, workflow } from '../../api/endpoints.js';
import { catalogKeys, documentKeys, revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type {
  LogicalDocument,
  PageAccounting,
  PageClassification,
  RegistryRow,
} from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { ErrorState, ExplainedLimitation, LoadingState } from '../../shared/ui.js';
import { MATCH_STATE_LABELS, PAGE_ROLE_LABELS, labelOf } from '../../shared/labels.js';
import { ToneTag } from '../../shared/tags.js';
import { useManualLabel } from './useManualLabel.js';

export function DocumentsTab({ revisionId }: { revisionId: string }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [typeDraft, setTypeDraft] = useState<Record<string, string>>({});

  const list = useQuery({
    queryKey: revisionKeys.documents(revisionId),
    queryFn: () => documents.list(revisionId),
  });
  const pages = useQuery({
    queryKey: revisionKeys.pages(revisionId),
    queryFn: () => documents.pages(revisionId),
  });
  const registry = useQuery({
    queryKey: revisionKeys.registry(revisionId),
    queryFn: () => documents.registry(revisionId),
  });
  const classifications = useQuery({
    queryKey: revisionKeys.classifications(revisionId),
    queryFn: () => documents.classifications(revisionId),
  });
  const docTypes = useQuery({
    queryKey: catalogKeys.docTypes(false),
    queryFn: () => catalog.docTypes(false),
  });

  const refreshDocuments = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: revisionKeys.documents(revisionId) });
    await queryClient.invalidateQueries({ queryKey: revisionKeys.pages(revisionId) });
  };

  const segment = useMutation({
    mutationFn: () => documents.segment(revisionId),
    onSuccess: async (result) => {
      message.success(
        result.jobCreated ? 'Сборка документов поставлена в очередь' : 'Сборка уже стоит в очереди',
      );
      await refreshDocuments();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const materialize = useMutation({
    mutationFn: () => workflow.materialize(revisionId),
    onSuccess: (result) => {
      message.success(
        result.jobCreated
          ? 'Пересборка нарезки поставлена в очередь'
          : 'Пересборка нарезки уже стоит в очереди',
      );
    },
    onError: (error) => message.error(describeError(error)),
  });

  const confirm = useMutation({
    mutationFn: (input: { documentId: string; version: number; docTypeCode?: string }) =>
      documents.confirm(
        input.documentId,
        input.version,
        input.docTypeCode === undefined ? {} : { docTypeCode: input.docTypeCode },
      ),
    onSuccess: async () => {
      message.success('Границы и тип документа подтверждены; нарезка поставлена в очередь');
      await refreshDocuments();
    },
    onError: (error) => message.error(describeError(error)),
  });

  // Мутации ручной метки вынесены в общий хук: та же панель есть на экране
  // разметки, и тексты с инвалидацией у них обязаны совпадать.
  const manualLabel = useManualLabel(revisionId);

  if (list.isPending) return <LoadingState label="Загрузка документов…" />;
  if (list.isError) return <ErrorState error={list.error} />;

  const typeOptions = (docTypes.data ?? []).map((type) => ({
    value: type.code,
    label: `${type.name}${type.isFallback ? ' (резервный)' : ''}`,
  }));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Button
          type="primary"
          onClick={() => segment.mutate()}
          loading={segment.isPending}
          disabled={!can('document.edit')}
          data-testid="segment-documents"
        >
          Собрать документы
        </Button>
        <Button
          onClick={() => materialize.mutate()}
          loading={materialize.isPending}
          disabled={!can('document.edit')}
          data-testid="materialize-documents"
        >
          Пересобрать нарезку
        </Button>
        <Typography.Text type="secondary">
          Сборка идёт по последнему завершённому прогону распознавания. Пересборка нужна, когда
          задача нарезки исчерпала попытки: переподтверждать каждый документ ради этого не нужно.
        </Typography.Text>
      </Space>

      {pages.isSuccess && (
        <>
          <PageAccountingCard accounting={pages.data} />
          <Card size="small" title="Дерево документов и страниц">
            <DocumentTree documents={list.data} accounting={pages.data} />
          </Card>
        </>
      )}
      {pages.isError && <ErrorState error={pages.error} title="Учёт страниц недоступен" />}

      <ExplainedLimitation title="Границы документов правятся только пересборкой">
        Перенести страницу между документами и назначить роль странице через API нельзя: маршрутов{' '}
        <Typography.Text code>
          PATCH /api/v1/documents/{'{'}documentId{'}'}/pages
        </Typography.Text>{' '}
        и{' '}
        <Typography.Text code>
          PATCH /api/v1/revisions/{'{'}revisionId{'}'}/page-assignments/{'{'}sourcePageId{'}'}
        </Typography.Text>{' '}
        в портале нет. Подтверждение принимает только вид ИД и признак «нужна проверка», поэтому
        неверная граница исправляется повторной сборкой документов, а не перетаскиванием строк.
      </ExplainedLimitation>

      <Table<LogicalDocument>
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={list.data}
        locale={{ emptyText: 'Документы не собраны' }}
        expandable={{
          expandedRowRender: (row) => <DocumentCard documentId={row.id} />,
        }}
        columns={[
          { title: '№', dataIndex: 'ordinal', key: 'ordinal', width: 60 },
          {
            title: 'Заголовок',
            dataIndex: 'title',
            key: 'title',
            render: (title: string | null) => title ?? 'без заголовка',
          },
          {
            title: 'Вид ИД',
            key: 'docTypeCode',
            render: (_value, row) => (
              <Select
                size="small"
                style={{ minWidth: 240 }}
                value={typeDraft[row.id] ?? row.docTypeCode}
                placeholder="тип не определён"
                options={typeOptions}
                showSearch
                optionFilterProp="label"
                disabled={!can('document.edit') || row.isConfirmed}
                onChange={(value: string) => setTypeDraft((prev) => ({ ...prev, [row.id]: value }))}
                aria-label={`Вид ИД документа ${String(row.ordinal)}`}
              />
            ),
          },
          { title: 'Страниц', dataIndex: 'pageCount', key: 'pageCount', width: 90 },
          {
            title: 'Уверенность',
            key: 'confidence',
            render: (_value, row) => (
              <Space size={4} direction="vertical">
                <span>
                  тип: {row.typeConfidence === null ? '—' : row.typeConfidence.toFixed(2)}
                </span>
                <span>
                  границы:{' '}
                  {row.boundaryConfidence === null ? '—' : row.boundaryConfidence.toFixed(2)}
                </span>
              </Space>
            ),
          },
          {
            title: 'Состояние',
            key: 'state',
            render: (_value, row) => (
              <Space size={4}>
                {row.isConfirmed ? (
                  <ToneTag tone="success">подтверждён</ToneTag>
                ) : (
                  <ToneTag tone="warning">не подтверждён</ToneTag>
                )}
                {row.needsReview && <ToneTag tone="danger">нужна проверка</ToneTag>}
              </Space>
            ),
          },
          {
            title: 'Действия',
            key: 'actions',
            render: (_value, row) => (
              <Space size={6} wrap>
                <Button
                  size="small"
                  type="primary"
                  disabled={!can('document.edit') || row.isConfirmed || confirm.isPending}
                  data-testid={`confirm-document-${row.ordinal}`}
                  onClick={() => {
                    const picked = typeDraft[row.id];
                    confirm.mutate({
                      documentId: row.id,
                      version: row.version,
                      ...(picked === undefined ? {} : { docTypeCode: picked }),
                    });
                  }}
                >
                  Подтвердить границы
                </Button>
                {row.isConfirmed && (
                  <a
                    href={workflow.documentPdfUrl(row.id)}
                    target="_blank"
                    rel="noreferrer"
                    title="Нарезанный PDF собирается задачей после подтверждения; пока она не выполнена, сервер отвечает «нарезка ещё не выполнена»."
                  >
                    Нарезанный PDF
                  </a>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Card size="small" title="Классификация страниц">
        {classifications.isError && (
          <ErrorState error={classifications.error} title="Классификации недоступны" />
        )}
        {classifications.isSuccess && (
          <ClassificationTable
            items={classifications.data}
            manual={{
              canEdit: can('document.edit'),
              typeOptions,
              pending: manualLabel.pending,
              onSetType: manualLabel.setType,
              onSetContinuation: manualLabel.setContinuation,
              onClear: manualLabel.clear,
            }}
          />
        )}
      </Card>

      <Card size="small" title="Реестр приложений">
        {registry.isError && <ErrorState error={registry.error} />}
        {registry.isSuccess && (
          <Table<RegistryRow>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={registry.data}
            locale={{ emptyText: 'Реестр приложений не разобран' }}
            columns={[
              { title: '№ в реестре', dataIndex: 'rowNo', key: 'rowNo', width: 100 },
              { title: 'Наименование', dataIndex: 'docNameRaw', key: 'docNameRaw' },
              {
                title: 'Номер',
                dataIndex: 'docNoRaw',
                key: 'docNoRaw',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: 'Сверка',
                dataIndex: 'matchState',
                key: 'matchState',
                render: (state: string) => (
                  <ToneTag tone={state === 'matched' ? 'success' : 'warning'}>
                    {labelOf(MATCH_STATE_LABELS, state)}
                  </ToneTag>
                ),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}

/**
 * Дерево «документ → его страницы» плюс две отдельные ветви учёта.
 *
 * Строится из одного ответа `GET /revisions/{id}/pages`, а не из обхода
 * документов: этот ответ уже несёт и роль страницы, и порядок внутри документа,
 * и причину непривязки. Обход по документу дал бы то же самое ценой запроса на
 * каждый документ.
 */
function DocumentTree({
  documents: items,
  accounting,
}: {
  documents: readonly LogicalDocument[];
  accounting: PageAccounting;
}): ReactNode {
  const treeData = useMemo(() => {
    const byDocument = new Map<string, PageAccounting['items']>();
    for (const page of accounting.items) {
      if (page.documentId === null) continue;
      const bucket = byDocument.get(page.documentId) ?? [];
      bucket.push(page);
      byDocument.set(page.documentId, bucket);
    }

    const documentNodes = items.map((document) => {
      const own = [...(byDocument.get(document.id) ?? [])].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
      );
      return {
        key: `doc:${document.id}`,
        title: (
          <span>
            <strong>№ {document.ordinal}</strong> {document.title ?? 'без заголовка'}{' '}
            <ToneTag tone="neutral">{document.docTypeCode ?? 'тип не определён'}</ToneTag>
            {document.isConfirmed ? (
              <ToneTag tone="success">подтверждён</ToneTag>
            ) : (
              <ToneTag tone="warning">не подтверждён</ToneTag>
            )}
          </span>
        ),
        children: own.map((page) => ({
          key: `page:${page.sourcePageId}`,
          isLeaf: true,
          title: (
            <span>
              стр. {page.revisionOrdinal + 1}
              {page.pageRoleCode === null ? (
                <ToneTag tone="neutral">роль не назначена</ToneTag>
              ) : (
                <ToneTag tone="info">{labelOf(PAGE_ROLE_LABELS, page.pageRoleCode)}</ToneTag>
              )}
              {page.needsReview && <ToneTag tone="danger">нужна проверка</ToneTag>}
            </span>
          ),
        })),
      };
    });

    const unassigned = accounting.items.filter((page) => page.documentId === null);
    const unassignedNode = {
      key: 'unassigned',
      title: (
        <span>
          <strong>Непривязанные страницы</strong> ({unassigned.length}) — причина указана у каждой
        </span>
      ),
      children: unassigned.map((page) => ({
        key: `unassigned:${page.sourcePageId}`,
        isLeaf: true,
        title: (
          <span>
            стр. {page.revisionOrdinal + 1}:{' '}
            {page.reason ?? 'причина не записана — это нарушение ограничения БД'}
          </span>
        ),
      })),
    };

    const unaccountedNode = {
      key: 'unaccounted',
      title: (
        <span>
          <strong>Неучтённые страницы</strong> ({accounting.unaccounted.length}) — по §16 список
          обязан быть пуст
        </span>
      ),
      children: accounting.unaccounted.map((page) => ({
        key: `unaccounted:${page.sourcePageId}`,
        isLeaf: true,
        title: (
          <span>
            стр. {page.revisionOrdinal + 1} из файла {page.sourceFileId}
          </span>
        ),
      })),
    };

    return [...documentNodes, unassignedNode, unaccountedNode];
  }, [items, accounting]);

  return (
    <Tree
      treeData={treeData}
      defaultExpandedKeys={['unassigned', 'unaccounted']}
      selectable={false}
      data-testid="documents-tree"
    />
  );
}

/**
 * Карточка документа: страницы с ролями и связи с другими документами.
 *
 * Связи читаются `GET /documents/{id}` — маршрута «связи всей ревизии» в API
 * нет, поэтому граф целиком здесь не строится, а показываются рёбра, входящие
 * в этот документ. Это честнее, чем нарисовать дерево связей, половина которого
 * не загружена.
 */
function DocumentCard({ documentId }: { documentId: string }): ReactNode {
  const detail = useQuery({
    queryKey: documentKeys.detail(documentId),
    queryFn: () => documents.detail(documentId),
  });

  if (detail.isPending) return <LoadingState label="Загрузка документа…" />;
  if (detail.isError) return <ErrorState error={detail.error} />;

  const document = detail.data;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label="Группа папок">{document.folderGroup ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Версия">{document.version}</Descriptions.Item>
        <Descriptions.Item label="Подтвердил">{document.confirmedBy ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Подтверждён">{document.confirmedAt ?? '—'}</Descriptions.Item>
      </Descriptions>

      <Table
        rowKey="sourcePageId"
        size="small"
        pagination={false}
        dataSource={[...document.pages].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))}
        title={() => 'Страницы документа и их роли'}
        locale={{ emptyText: 'У документа нет страниц' }}
        columns={[
          {
            title: 'Стр. ревизии',
            dataIndex: 'revisionOrdinal',
            key: 'revisionOrdinal',
            render: (value: number) => value + 1,
          },
          {
            title: 'Порядок в документе',
            dataIndex: 'sortOrder',
            key: 'sortOrder',
            render: (value: number | null) => (value === null ? '—' : value + 1),
          },
          {
            title: 'Роль страницы',
            dataIndex: 'pageRoleCode',
            key: 'pageRoleCode',
            render: (value: string | null) =>
              value === null ? (
                <Typography.Text type="secondary">роль не назначена</Typography.Text>
              ) : (
                <ToneTag tone="info">{labelOf(PAGE_ROLE_LABELS, value)}</ToneTag>
              ),
          },
          {
            title: 'Нужна проверка',
            dataIndex: 'needsReview',
            key: 'needsReview',
            render: (value: boolean) => (value ? 'да' : 'нет'),
          },
        ]}
      />

      <Table
        rowKey={(row) => `${row.parentDocumentId}:${row.childDocumentId}:${row.relation}`}
        size="small"
        pagination={false}
        dataSource={document.relations}
        title={() => 'Связи с другими документами'}
        locale={{ emptyText: 'Связей у документа нет' }}
        columns={[
          { title: 'Родитель', dataIndex: 'parentDocumentId', key: 'parentDocumentId' },
          { title: 'Потомок', dataIndex: 'childDocumentId', key: 'childDocumentId' },
          { title: 'Связь', dataIndex: 'relation', key: 'relation' },
        ]}
      />
    </Space>
  );
}

/**
 * Классификация страниц: чем конвейер объяснил своё решение.
 *
 * Показывается вместе с альтернативами и признаком неоднозначности: страница, у
 * которой две гипотезы разошлись на сотую долю, и страница с уверенным выводом —
 * это разные поводы для проверки человеком (§8).
 */
interface ManualLabelControls {
  readonly canEdit: boolean;
  readonly typeOptions: readonly { value: string; label: string }[];
  readonly pending: boolean;
  readonly onSetType: (sourcePageId: string, docTypeCode: string) => void;
  readonly onSetContinuation: (sourcePageId: string) => void;
  readonly onClear: (sourcePageId: string) => void;
}

function ClassificationTable({
  items,
  manual,
}: {
  items: readonly PageClassification[];
  manual: ManualLabelControls;
}): ReactNode {
  return (
    <Table<PageClassification>
      rowKey="sourcePageId"
      size="small"
      pagination={{ pageSize: 15, hideOnSinglePage: true }}
      dataSource={[...items]}
      locale={{ emptyText: 'Страницы не классифицированы' }}
      columns={[
        {
          title: 'Стр.',
          dataIndex: 'revisionOrdinal',
          key: 'revisionOrdinal',
          width: 70,
          render: (value: number) => value + 1,
        },
        { title: 'Ярлык', dataIndex: 'label', key: 'label' },
        {
          title: 'Вид ИД',
          dataIndex: 'docTypeCode',
          key: 'docTypeCode',
          render: (value: string | null) => value ?? '—',
        },
        {
          title: 'Роль страницы',
          dataIndex: 'pageRoleCode',
          key: 'pageRoleCode',
          render: (value: string | null) =>
            value === null ? '—' : labelOf(PAGE_ROLE_LABELS, value),
        },
        {
          title: 'Исход',
          key: 'outcome',
          render: (_value, row) => (
            <Space size={4} wrap>
              <ToneTag tone="neutral">{row.typeOutcome}</ToneTag>
              {row.source === 'manual' && <ToneTag tone="success">вручную</ToneTag>}
              {row.ambiguous && <ToneTag tone="danger">неоднозначно</ToneTag>}
              {row.alternatives.length > 0 && (
                <ToneTag tone="neutral">ещё гипотез: {row.alternatives.length}</ToneTag>
              )}
            </Space>
          ),
        },
        {
          title: 'Уверенность',
          dataIndex: 'confidence',
          key: 'confidence',
          render: (value: number | null) => (value === null ? '—' : value.toFixed(2)),
        },
        {
          title: 'Почему',
          dataIndex: 'reason',
          key: 'reason',
          render: (value: string | null) => value ?? '—',
        },
        {
          title: 'Разметка вручную',
          key: 'manual',
          render: (_value, row) => (
            <Space size={4} wrap>
              <Select
                size="small"
                style={{ minWidth: 200 }}
                placeholder="тип страницы…"
                {...(row.source === 'manual' && row.docTypeCode !== null
                  ? { value: row.docTypeCode }
                  : {})}
                options={[...manual.typeOptions]}
                showSearch
                optionFilterProp="label"
                disabled={!manual.canEdit || manual.pending}
                onChange={(value: string) => manual.onSetType(row.sourcePageId, value)}
                aria-label={`Тип страницы ${String(row.revisionOrdinal + 1)} вручную`}
              />
              <Button
                size="small"
                disabled={!manual.canEdit || manual.pending}
                title="Страница продолжает предыдущий документ (I-DOC, без собственного типа)"
                onClick={() => manual.onSetContinuation(row.sourcePageId)}
              >
                Продолжение
              </Button>
              {row.source === 'manual' && (
                <Button
                  size="small"
                  danger
                  disabled={!manual.canEdit || manual.pending}
                  onClick={() => manual.onClear(row.sourcePageId)}
                >
                  Снять
                </Button>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}

function PageAccountingCard({ accounting }: { accounting: PageAccounting }): ReactNode {
  const { counts } = accounting;
  return (
    <Card size="small" title="Учёт страниц">
      <Space wrap>
        <ToneTag tone="success" testId="pages-assigned">
          привязано: {counts.assigned}
        </ToneTag>
        <ToneTag tone="warning" testId="pages-unassigned">
          непривязано: {counts.unassigned}
        </ToneTag>
        <ToneTag tone={counts.unaccounted === 0 ? 'neutral' : 'danger'} testId="pages-unaccounted">
          не учтено: {counts.unaccounted}
        </ToneTag>
      </Space>
      {counts.unaccounted > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          message="Нарушен инвариант учёта страниц"
          description="Каждая страница обязана быть либо в документе, либо явно непривязанной (§16). Неучтённые страницы означают потерю."
        />
      )}
    </Card>
  );
}
