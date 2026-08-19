/**
 * Кандидаты в виды ИД (§3.2, §14).
 *
 * Документ, не опознанный ни правилами, ни моделью, не пропадает: его заголовок
 * нормализуется, кластеризуется по всем поставкам и попадает сюда — «встречено N
 * документов с таким заголовком, тип не заведён». Обе кнопки плана на месте:
 * сопоставить с существующим типом или завести новый.
 *
 * Пример заголовка показывается как есть, а нормализованная форма — рядом:
 * администратор решает по тому, что напечатано в документе, а группировка идёт по
 * нормализованному, и подменять одно другим нельзя.
 */
import { useState, type ReactNode } from 'react';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalog } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { DocTypeCandidate } from '../../api/types.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';

const STATUS_LABELS: Record<DocTypeCandidate['status'], string> = {
  new: 'новый',
  reviewing: 'разбирается',
  mapped: 'сопоставлен',
  ignored: 'отклонён',
};

export function CandidatesPanel(): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('new');
  const [creating, setCreating] = useState<DocTypeCandidate | null>(null);

  const candidates = useQuery({
    queryKey: catalogKeys.candidates(status),
    queryFn: () => catalog.candidates(status === 'all' ? undefined : status),
  });
  const docTypes = useQuery({
    queryKey: catalogKeys.docTypes(false),
    queryFn: () => catalog.docTypes(false),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: catalogKeys.candidates(status) });
    await queryClient.invalidateQueries({ queryKey: catalogKeys.docTypes(false) });
  };

  const map = useMutation({
    mutationFn: (input: { candidateId: string; docTypeCode: string }) =>
      catalog.mapCandidate(input.candidateId, input.docTypeCode),
    onSuccess: async () => {
      message.success('Кандидат сопоставлен с существующим видом ИД');
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const setStatusMutation = useMutation({
    mutationFn: (input: { candidateId: string; status: string }) =>
      catalog.setCandidateStatus(input.candidateId, input.status),
    onSuccess: async () => {
      message.success('Состояние кандидата изменено');
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  const create = useMutation({
    mutationFn: (input: {
      candidateId: string;
      body: { code: string; name: string; shortName: string; groupCode: string; kind: string };
    }) => catalog.createDocTypeFromCandidate(input.candidateId, input.body),
    onSuccess: async () => {
      message.success('Вид ИД заведён, кандидат закрыт');
      setCreating(null);
      await invalidate();
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (candidates.isPending) return <LoadingState />;
  if (candidates.isError) return <ErrorState error={candidates.error} />;

  const typeOptions = (docTypes.data ?? []).map((type) => ({
    value: type.code,
    label: type.name,
  }));

  return (
    <>
      <Segmented<string>
        value={status}
        onChange={setStatus}
        style={{ marginBottom: 12 }}
        options={[
          { label: 'Новые', value: 'new' },
          { label: 'Разбираются', value: 'reviewing' },
          { label: 'Сопоставленные', value: 'mapped' },
          { label: 'Отклонённые', value: 'ignored' },
          { label: 'Все', value: 'all' },
        ]}
        aria-label="Фильтр кандидатов по состоянию"
      />

      <Table<DocTypeCandidate>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={candidates.data.items}
        locale={{ emptyText: 'Кандидатов нет' }}
        columns={[
          {
            title: 'Заголовок из документа',
            key: 'title',
            render: (_value, row) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{row.observedTitleSample}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  нормализовано: {row.observedTitleNorm}
                </Typography.Text>
              </Space>
            ),
          },
          { title: 'Встречено', dataIndex: 'occurrences', key: 'occurrences', width: 110 },
          {
            title: 'Состояние',
            dataIndex: 'status',
            key: 'status',
            render: (value: DocTypeCandidate['status']) => <Tag>{STATUS_LABELS[value]}</Tag>,
          },
          {
            title: 'Действия',
            key: 'actions',
            render: (_value, row) => (
              <Space wrap size={6}>
                <Select
                  size="small"
                  style={{ minWidth: 220 }}
                  placeholder="сопоставить с типом"
                  options={typeOptions}
                  showSearch
                  optionFilterProp="label"
                  value={row.mappedDocTypeCode}
                  onChange={(docTypeCode: string) =>
                    map.mutate({ candidateId: row.id, docTypeCode })
                  }
                  aria-label={`Сопоставить кандидата «${row.observedTitleNorm}» с видом ИД`}
                />
                <Button size="small" onClick={() => setCreating(row)}>
                  Завести тип
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    setStatusMutation.mutate({ candidateId: row.id, status: 'ignored' })
                  }
                >
                  Отклонить
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <CreateTypeDialog
        candidate={creating}
        busy={create.isPending}
        onCancel={() => setCreating(null)}
        onSubmit={(body) => {
          if (creating === null) return;
          create.mutate({ candidateId: creating.id, body });
        }}
      />
    </>
  );
}

interface CreateForm {
  code: string;
  name: string;
  shortName: string;
  groupCode: string;
  kind: string;
}

function CreateTypeDialog(props: {
  readonly candidate: DocTypeCandidate | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (body: CreateForm) => void;
}): ReactNode {
  const [form] = Form.useForm<CreateForm>();
  return (
    <Modal
      open={props.candidate !== null}
      title="Завести вид ИД по кандидату"
      okText="Завести"
      cancelText="Отмена"
      confirmLoading={props.busy}
      onCancel={props.onCancel}
      onOk={() => {
        void form.validateFields().then(props.onSubmit);
      }}
      destroyOnHidden
    >
      {props.candidate !== null && (
        <Typography.Paragraph type="secondary">
          Заголовок из документа: {props.candidate.observedTitleSample}
        </Typography.Paragraph>
      )}
      <Form<CreateForm>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{
          name: props.candidate?.observedTitleSample ?? '',
          groupCode: 'other',
          kind: 'evidence',
        }}
      >
        <Form.Item
          name="code"
          label="Код"
          rules={[
            { required: true, message: 'Код обязателен' },
            {
              pattern: /^[a-z][a-z0-9_]*$/u,
              message: 'Слаг из строчных латинских букв, цифр и подчёркиваний',
            },
          ]}
        >
          <Input placeholder="act_hydraulic_test" />
        </Form.Item>
        <Form.Item name="name" label="Наименование" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="shortName" label="Короткое наименование" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="groupCode" label="Группа" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="kind" label="Вид" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
