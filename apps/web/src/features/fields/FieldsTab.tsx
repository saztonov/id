/**
 * Вкладка «Реквизиты»: извлечённые значения с доказательством (§8.4, §14).
 *
 * У каждого значения показывается ЧЕТЫРЁХЧАСТНОЕ доказательство: чем извлечено,
 * с какой уверенностью, из какой версии текста страницы и какой именно цитатой.
 * Значение без доказательства неотличимо от угаданного, а по §9.1 низкая
 * уверенность не имеет права давать блокирующую ошибку — значит проверяющий
 * обязан видеть, чему верить.
 */
import { useState, type ReactNode } from 'react';
import { Card, Select, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { documents } from '../../api/endpoints.js';
import { documentKeys, revisionKeys } from '../../api/keys.js';
import type { FieldValue } from '../../api/types.js';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui.js';

const EXTRACTED_BY_LABELS: Record<string, string> = {
  rule: 'детерминированное правило',
  llm: 'модель',
  manual: 'вручную',
};

export function FieldsTab({ revisionId }: { revisionId: string }): ReactNode {
  const [documentId, setDocumentId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: revisionKeys.documents(revisionId),
    queryFn: () => documents.list(revisionId),
  });

  const selected = documentId ?? list.data?.[0]?.id ?? null;

  const fields = useQuery({
    queryKey: documentKeys.fields(selected ?? 'none'),
    queryFn: () => documents.fields(selected ?? ''),
    enabled: selected !== null,
  });

  if (list.isPending) return <LoadingState label="Загрузка документов…" />;
  if (list.isError) return <ErrorState error={list.error} />;
  if (list.data.length === 0) {
    return <EmptyState label="Документы не собраны, поэтому реквизитов ещё нет" />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Select<string>
        style={{ minWidth: 420 }}
        value={selected}
        onChange={(value) => setDocumentId(value)}
        aria-label="Документ, реквизиты которого показаны"
        options={list.data.map((document) => ({
          value: document.id,
          label: `${String(document.ordinal)}. ${document.title ?? 'без заголовка'} (${document.docTypeCode ?? 'тип не определён'})`,
        }))}
      />

      <Card size="small" title="Реквизиты документа">
        {fields.isPending && <LoadingState label="Загрузка реквизитов…" />}
        {fields.isError && <ErrorState error={fields.error} />}
        {fields.isSuccess && (
          <Table<FieldValue>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={fields.data}
            locale={{ emptyText: 'Реквизиты не извлечены' }}
            expandable={{
              expandedRowRender: (row) => (
                <Space direction="vertical" size={4}>
                  <Typography.Text type="secondary">
                    Версия текста страницы: {row.pageTextVersionId ?? 'нет'}
                    {row.charSpan !== null &&
                      `, символы ${String(row.charSpan.start)}–${String(row.charSpan.end)}`}
                  </Typography.Text>
                  {row.quote !== null && (
                    <Typography.Paragraph style={{ marginBottom: 0 }}>
                      <blockquote
                        style={{ margin: 0, paddingLeft: 10, borderLeft: '3px solid #d9d9d9' }}
                      >
                        {row.quote}
                      </blockquote>
                    </Typography.Paragraph>
                  )}
                  <Typography.Text type="secondary">
                    Экстрактор: {row.extractorVersion}
                  </Typography.Text>
                </Space>
              ),
              rowExpandable: (row) => row.quote !== null || row.pageTextVersionId !== null,
            }}
            columns={[
              { title: 'Реквизит', dataIndex: 'fieldCode', key: 'fieldCode' },
              {
                title: 'Значение',
                key: 'value',
                render: (_value, row) =>
                  row.valueText ?? row.valueDate ?? row.valueNum ?? JSON.stringify(row.valueJson),
              },
              {
                title: 'Чем извлечено',
                dataIndex: 'extractedBy',
                key: 'extractedBy',
                render: (value: string) => EXTRACTED_BY_LABELS[value] ?? value,
              },
              {
                title: 'Уверенность',
                dataIndex: 'confidence',
                key: 'confidence',
                render: (value: number | null) =>
                  value === null ? (
                    <Tag>не указана</Tag>
                  ) : (
                    <Tag color={value >= 0.9 ? 'green' : value >= 0.7 ? 'orange' : 'red'}>
                      {value.toFixed(2)}
                    </Tag>
                  ),
              },
              {
                title: 'Проверено',
                dataIndex: 'isVerified',
                key: 'isVerified',
                render: (value: boolean) => (value ? 'да' : 'нет'),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
