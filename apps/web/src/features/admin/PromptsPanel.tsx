/**
 * Промты моделей: жизненный цикл `draft → test → published` с откатом (§10, §14).
 *
 * ## Почему у промта есть версии и состояния, а не поле «текст»
 *
 * Промт — это часть методики, а не настройка. Результат классификации страницы
 * или извлечения реквизита зависит от него так же, как от правила, и вопрос «по
 * какому промту получен вот этот вывод» обязан иметь ответ через полгода.
 * Поэтому текст опубликованной версии неизменяем (триггер 0008), правится
 * только черновик, а «вернуть прежний промт» — это возврат прежней ВЕРСИИ в
 * эксплуатацию, а не редактирование текста назад.
 *
 * ## Кнопки переходов повторяют автомат, но не решают
 *
 * Таблица допустимых переходов дословно повторяет `modules/admin/governance.ts`
 * и нужна ровно для одного: не показывать кнопку, которая гарантированно
 * получит 409. Решение принимает сервер, и его отказ показывается целиком —
 * включая запрет §0.5 п. 6 на публикацию промта, называющего раздел работ.
 *
 * ## Раздел работ в промте — отказ публикации, а не предупреждение
 *
 * Сервер сканирует обе части текста при публикации и отвечает 422 со списком
 * найденных упоминаний. Экран показывает их построчно: «промт называет раздел
 * работ» без указания, какое именно слово, отправляло бы искать вручную по
 * тексту на сто тысяч символов.
 */
import { useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromptState } from '@id/contracts';
import { admin, catalog } from '../../api/endpoints.js';
import { adminKeys, catalogKeys } from '../../api/keys.js';
import { describeError, isApiError } from '../../api/problem.js';
import type { PromptTemplate } from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { ErrorState, LoadingState, UnavailableState } from '../../shared/ui.js';
import { applyFieldErrors, mapFieldErrors, type FieldPath } from '../../shared/formErrors.js';
import { ToneTag, type Tone } from '../../shared/tags.js';
import { IconAction } from '../../shared/RowActions.js';
import { EditIcon } from '../../shared/icons.js';

/** Стадии конвейера, на которых работает промт (`prompt_templates_stage_chk`). */
const STAGES: Record<string, string> = {
  page_classify: 'Классификация страниц',
  doc_split: 'Разбиение на документы',
  // Разворот страницы — стадия РАЗМЕТКИ, а не распознавания: зонд отрабатывает
  // до детекции, когда прогона распознавания ещё нет (ADR-0020).
  orientation: 'Разворот страницы',
  recognize: 'Распознавание блока',
  extract: 'Извлечение реквизитов',
  check: 'Проверка правилом',
  summary: 'Сводка',
};

const STATE_LABELS: Record<PromptState, string> = {
  draft: 'Черновик',
  test: 'Испытание',
  published: 'В эксплуатации',
  archived: 'В архиве',
};

const STATE_TONES: Record<PromptState, Tone> = {
  draft: 'neutral',
  test: 'warning',
  published: 'success',
  archived: 'neutral',
};

/**
 * Значение фильтра «все».
 *
 * Отдельная строка, а не `placeholder`: подсказка внутри поля рисуется бледным
 * серым, который не проходит контраст WCAG AA (гейт §17 ловит это как
 * `color-contrast`). Явный пункт списка и читается лучше — видно, что фильтр
 * снят, а не что поле пустое.
 */
const ANY = 'any';

/**
 * Допустимые переходы — копия `PROMPT_TRANSITIONS` сервера.
 *
 * Копия подписана источником сознательно: сервер таблицу наружу не отдаёт, и
 * расхождение чинится сверкой двух файлов. Копия слабее оригинала по построению
 * — она отвечает «показывать ли кнопку», а не «разрешён ли переход».
 */
const TRANSITIONS: Record<PromptState, { to: PromptState; label: string; kind: string }[]> = {
  draft: [
    { to: 'test', label: 'На испытание', kind: 'promote' },
    { to: 'archived', label: 'В архив', kind: 'archive' },
  ],
  test: [
    { to: 'draft', label: 'Вернуть в черновик', kind: 'demote' },
    { to: 'published', label: 'Опубликовать', kind: 'publish' },
    { to: 'archived', label: 'В архив', kind: 'archive' },
  ],
  published: [{ to: 'archived', label: 'Снять с эксплуатации', kind: 'archive' }],
  archived: [{ to: 'published', label: 'Вернуть в эксплуатацию (откат)', kind: 'rollback' }],
};

export function PromptsPanel(): ReactNode {
  const { can } = useSession();

  if (!can('settings.manage')) {
    return (
      <UnavailableState
        route="GET /api/v1/admin/prompts"
        what="AI и промты"
        reason="forbidden"
        detail="Раздел требует права settings.manage: им закрыты и чтение промтов, и переходы состояний."
      />
    );
  }

  return <PromptsWorkspace />;
}

function PromptsWorkspace(): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<string>(ANY);
  const [state, setState] = useState<string>(ANY);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; items: string[] } | null>(null);

  const filter = `${stage}|${state}`;
  const prompts = useQuery({
    queryKey: adminKeys.prompts(filter),
    queryFn: () =>
      admin.prompts({
        ...(stage === ANY ? {} : { stage }),
        ...(state === ANY ? {} : { state }),
      }),
  });

  const transition = useMutation({
    mutationFn: (input: { id: string; to: PromptState }) =>
      admin.setPromptState(input.id, input.to),
    onSuccess: async (result) => {
      message.success(
        result.kind === 'rollback'
          ? 'Прежняя версия промта возвращена в эксплуатацию'
          : `Состояние промта изменено: ${STATE_LABELS[result.template.state]}`,
      );
      setRefusal(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'prompts'] });
    },
    onError: (error) => {
      // 422 при публикации несёт список найденных упоминаний раздела работ.
      // Указатель у всех один (`/to`), полю формы он не соответствует — и
      // именно поэтому сообщения показываются списком, а не теряются.
      const mapped = mapFieldErrors(error, []);
      if (isApiError(error) && error.status === 422 && mapped.unmatched.length > 0) {
        setRefusal({ title: error.message, items: mapped.unmatched });
        return;
      }
      message.error(describeError(error));
    },
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap align="end">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Стадия</span>
          <Select<string>
            style={{ width: 240 }}
            value={stage}
            onChange={setStage}
            options={[
              { value: ANY, label: 'все стадии' },
              ...Object.entries(STAGES).map(([code, label]) => ({ value: code, label })),
            ]}
            aria-label="Стадия промта"
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Состояние</span>
          <Select<string>
            style={{ width: 200 }}
            value={state}
            onChange={setState}
            options={[
              { value: ANY, label: 'все состояния' },
              ...(Object.keys(STATE_LABELS) as PromptState[]).map((value) => ({
                value,
                label: STATE_LABELS[value],
              })),
            ]}
            aria-label="Состояние промта"
          />
        </div>
        <Button type="primary" onClick={() => setCreating(true)} data-testid="new-prompt">
          Новый черновик промта
        </Button>
      </Space>

      {refusal !== null && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setRefusal(null)}
          message={refusal.title}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {refusal.items.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          }
          data-testid="prompt-refusal"
        />
      )}

      <Card size="small" title="Версии промтов">
        {prompts.isPending && <LoadingState />}
        {prompts.isError && <ErrorState error={prompts.error} />}
        {prompts.isSuccess && (
          <Table<PromptTemplate>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={prompts.data.items}
            locale={{ emptyText: 'Промтов нет: конвейер работает на текстах по умолчанию' }}
            expandable={{ expandedRowRender: (row) => <PromptBody template={row} /> }}
            columns={[
              { title: 'Код', dataIndex: 'code', key: 'code' },
              { title: 'Версия', dataIndex: 'version', key: 'version', width: 80 },
              {
                title: 'Стадия',
                dataIndex: 'stage',
                key: 'stage',
                render: (value: string) => STAGES[value] ?? value,
              },
              {
                title: 'Вид ИД',
                dataIndex: 'docTypeCode',
                key: 'docTypeCode',
                render: (value: string | null) => value ?? 'любой',
              },
              {
                title: 'Состояние',
                dataIndex: 'state',
                key: 'state',
                render: (value: PromptState) => (
                  <ToneTag tone={STATE_TONES[value]}>{STATE_LABELS[value]}</ToneTag>
                ),
              },
              {
                title: 'Модель',
                dataIndex: 'modelOverride',
                key: 'modelOverride',
                render: (value: string | null) => value ?? 'по умолчанию',
              },
              {
                title: 'Опубликован',
                dataIndex: 'publishedAt',
                key: 'publishedAt',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: 'Действия',
                key: 'actions',
                render: (_value, row) => (
                  <Space size={4} wrap>
                    {row.state === 'draft' && (
                      <IconAction
                        icon={<EditIcon />}
                        label={`Править текст промта ${row.code} версии ${String(row.version)}`}
                        onClick={() => setEditing(row)}
                      />
                    )}
                    {TRANSITIONS[row.state].map((step) => (
                      <Button
                        key={step.to}
                        size="small"
                        type={step.kind === 'publish' ? 'primary' : 'default'}
                        loading={transition.isPending}
                        onClick={() => transition.mutate({ id: row.id, to: step.to })}
                        data-testid={`prompt-${step.kind}-${row.code}-${String(row.version)}`}
                      >
                        {step.label}
                      </Button>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <NewPromptDialog open={creating} onClose={() => setCreating(false)} />
      <EditDraftDialog template={editing} onClose={() => setEditing(null)} />
    </Space>
  );
}

/**
 * Текст промта показывается целиком.
 *
 * Обрезка «первых двухсот символов» здесь была бы вредна: спор о выводе модели
 * решается сверкой ровно того текста, который ушёл провайдеру.
 */
function PromptBody({ template }: { template: PromptTemplate }): ReactNode {
  return (
    <Descriptions size="small" column={1} bordered>
      <Descriptions.Item label="Системная часть">
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {template.systemPrompt}
        </Typography.Paragraph>
      </Descriptions.Item>
      <Descriptions.Item label="Шаблон пользовательской части">
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {template.userTemplate}
        </Typography.Paragraph>
      </Descriptions.Item>
      <Descriptions.Item label="Схема ответа">
        <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
          {template.outputSchema === null
            ? 'не задана: ответ модели не сверяется со схемой'
            : JSON.stringify(template.outputSchema, null, 2)}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="Изменён">{template.updatedAt}</Descriptions.Item>
    </Descriptions>
  );
}

interface NewPromptValues {
  code: string;
  stage: string;
  docTypeCode: string | null;
  systemPrompt: string;
  userTemplate: string;
  modelOverride: string;
  outputSchema: string;
}

const NEW_PROMPT_FIELDS: readonly FieldPath[] = [
  ['code'],
  ['stage'],
  ['docTypeCode'],
  ['systemPrompt'],
  ['userTemplate'],
  ['modelOverride'],
  ['outputSchema'],
];

function NewPromptDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<NewPromptValues>();
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const docTypes = useQuery({
    queryKey: catalogKeys.docTypes(false),
    queryFn: () => catalog.docTypes(false),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: (values: NewPromptValues) =>
      admin.createPrompt({
        code: values.code.trim(),
        stage: values.stage,
        docTypeCode: values.docTypeCode ?? null,
        systemPrompt: values.systemPrompt,
        userTemplate: values.userTemplate,
        // Пустая схема — это `null`, а не `{}`: «схема не задана» и «схема
        // разрешает что угодно» — разные утверждения о том, как проверять ответ.
        outputSchema: values.outputSchema.trim() === '' ? null : JSON.parse(values.outputSchema),
        modelOverride: values.modelOverride.trim() === '' ? null : values.modelOverride.trim(),
      }),
    onSuccess: async (template) => {
      message.success(`Черновик ${template.code} версии ${String(template.version)} создан`);
      setUnmatched([]);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'prompts'] });
      onClose();
    },
    onError: (error) => {
      const leftover = applyFieldErrors(form, error, NEW_PROMPT_FIELDS);
      setUnmatched(leftover.length > 0 ? leftover : [describeError(error)]);
    },
  });

  return (
    <Modal
      open={open}
      title="Новый черновик промта"
      okText="Создать черновик"
      cancelText="Отмена"
      confirmLoading={create.isPending}
      onCancel={() => {
        setUnmatched([]);
        onClose();
      }}
      onOk={() => {
        void form.validateFields().then((values) => create.mutate(values));
      }}
      destroyOnHidden
      width={820}
    >
      <Typography.Paragraph type="secondary">
        Номер версии назначает сервер. Публикация промта, называющего раздел работ, отклоняется
        (§0.5, п. 6): такой промт на других разделах притягивает документы к знакомым видам, и
        ошибка получается тихой и высокоуверенной.
      </Typography.Paragraph>

      {unmatched.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Сервер отклонил черновик"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmatched.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          }
        />
      )}

      <Form<NewPromptValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{
          code: '',
          stage: 'page_classify',
          docTypeCode: null,
          systemPrompt: '',
          userTemplate: '',
          modelOverride: '',
          outputSchema: '',
        }}
      >
        <Form.Item
          name="code"
          label="Код промта"
          rules={[
            { required: true, message: 'Код обязателен' },
            {
              pattern: /^[a-z][a-z0-9_]*$/,
              message: 'Слаг из строчных латинских букв, цифр и подчёркивания',
            },
          ]}
        >
          <Input placeholder="page_classify_base" data-testid="prompt-code" />
        </Form.Item>
        <Form.Item name="stage" label="Стадия" rules={[{ required: true }]}>
          <Select
            options={Object.entries(STAGES).map(([code, label]) => ({ value: code, label }))}
          />
        </Form.Item>
        <Form.Item
          name="docTypeCode"
          label="Вид ИД (пусто — промт общего назначения)"
          tooltip="Незнакомый тип документа обязан обрабатываться, а не проваливаться: промт без привязки — это ответ открытого мира."
        >
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            loading={docTypes.isPending}
            options={(docTypes.data ?? []).map((type) => ({
              value: type.code,
              label: `${type.code} — ${type.name}`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="systemPrompt"
          label="Системная часть"
          rules={[{ required: true, message: 'Системная часть обязательна' }]}
        >
          <Input.TextArea rows={5} data-testid="prompt-system" />
        </Form.Item>
        <Form.Item
          name="userTemplate"
          label="Шаблон пользовательской части"
          rules={[{ required: true, message: 'Шаблон обязателен' }]}
        >
          <Input.TextArea rows={5} data-testid="prompt-user" />
        </Form.Item>
        <Form.Item
          name="outputSchema"
          label="Схема ответа (JSON, пусто — не задана)"
          rules={[
            {
              validator: (_rule, value: string) => {
                if (typeof value !== 'string' || value.trim() === '') return Promise.resolve();
                try {
                  JSON.parse(value);
                  return Promise.resolve();
                } catch {
                  return Promise.reject(new Error('Это не разбирается как JSON'));
                }
              },
            },
          ]}
        >
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item name="modelOverride" label="Модель (пусто — модель по умолчанию)">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface DraftValues {
  systemPrompt: string;
  userTemplate: string;
  modelOverride: string;
}

function EditDraftDialog({
  template,
  onClose,
}: {
  template: PromptTemplate | null;
  onClose: () => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<DraftValues>();

  const update = useMutation({
    mutationFn: (values: DraftValues) => {
      if (template === null) throw new Error('Промт не выбран');
      return admin.updatePromptDraft(template.id, {
        systemPrompt: values.systemPrompt,
        userTemplate: values.userTemplate,
        modelOverride: values.modelOverride.trim() === '' ? null : values.modelOverride.trim(),
      });
    },
    onSuccess: async () => {
      message.success('Черновик промта сохранён');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'prompts'] });
      onClose();
    },
    onError: (error) => message.error(describeError(error)),
  });

  return (
    <Modal
      open={template !== null}
      title={
        template === null
          ? 'Правка черновика'
          : `Правка черновика ${template.code} версии ${String(template.version)}`
      }
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={update.isPending}
      onCancel={onClose}
      onOk={() => {
        void form.validateFields().then((values) => update.mutate(values));
      }}
      destroyOnHidden
      width={820}
    >
      <Typography.Paragraph type="secondary">
        Правится только черновик. Опубликованная и архивная версии неизменяемы: их текст —
        доказательство того, по чему получен вывод модели.
      </Typography.Paragraph>
      {template !== null && (
        <Form<DraftValues>
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            systemPrompt: template.systemPrompt,
            userTemplate: template.userTemplate,
            modelOverride: template.modelOverride ?? '',
          }}
        >
          <Form.Item name="systemPrompt" label="Системная часть" rules={[{ required: true }]}>
            <Input.TextArea rows={6} />
          </Form.Item>
          <Form.Item
            name="userTemplate"
            label="Шаблон пользовательской части"
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={6} />
          </Form.Item>
          <Form.Item name="modelOverride" label="Модель (пусто — модель по умолчанию)">
            <Input />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}
