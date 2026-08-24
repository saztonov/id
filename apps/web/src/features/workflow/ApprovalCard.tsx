/**
 * Согласование ревизии: препятствия и четыре перехода (§10, §14).
 *
 * ## Почему это на вкладке «Проверка», а не на «Истории» (S24)
 *
 * До S24 карточка жила в «Истории» — рядом с журналом действий, по логике «здесь
 * всё про рабочий процесс». Работало это плохо: подрядчик смотрел результат
 * проверки на одной вкладке, а отправлял комплект с другой, и слово «проверка» в
 * портале означало три разных вещи одновременно — прогнать конвейер («Проверить»
 * над вкладками), прогнать правила («Запустить проверку») и отдать комплект
 * генподрядчику («Подать на проверку»).
 *
 * Теперь карточка стоит там, где принимается решение: под списком замечаний.
 * Человек видит, что нашлось, и тут же решает, отдавать ли. «Подать на проверку»
 * переименована в «Отправить на согласование» — из трёх «проверок» осталась
 * одна, и она означает прогон правил.
 *
 * ## Препятствия показываются ДО нажатия
 *
 * `submitBlockers` и `approveBlockers` приходят готовым списком вместе со
 * статусом: экран обязан показывать, что именно мешает, а не выяснять это
 * отказом на нажатие. Фразы приходят русскими и с числами; словарь-переводчик
 * поверх них потерял бы числа (см. `shared/labels.ts`).
 *
 * ## В режиме тестирования список остаётся, а запрет снимается
 *
 * `immutabilityEnforced === false` не прячет препятствия — «чего не хватает»
 * полезно знать и на этапе тестирования. Снимается только `disabled`, и плашка
 * прямо говорит, что действие пройдёт вопреки списку. Спрятать список значило бы
 * сделать режим тестирования ещё и слепым.
 *
 * ## `If-Match` на переходах
 *
 * Каждое действие требует версию ревизии. Версия берётся из ответа
 * `GET /workflow`, а не запоминается: между открытием вкладки и нажатием кнопки
 * ревизию мог тронуть другой проверяющий, и тогда переход обязан быть отвергнут,
 * а не выполнен по устаревшему представлению.
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
  Space,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { workflow } from '../../api/endpoints.js';
import { revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { WorkflowState } from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { WORKFLOW_STATUS_LABELS, labelOf } from '../../shared/labels.js';

export function ApprovalCard({ revisionId }: { revisionId: string }): ReactNode {
  const { can, immutabilityEnforced } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [returning, setReturning] = useState(false);

  const state = useQuery({
    queryKey: revisionKeys.workflow(revisionId),
    queryFn: () => workflow.state(revisionId),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: revisionKeys.workflow(revisionId) });
    await queryClient.invalidateQueries({ queryKey: revisionKeys.archive(revisionId) });
  };

  const act = useMutation({
    mutationFn: async (input: {
      kind: 'submit' | 'review' | 'approve' | 'return';
      version: number;
      reason?: string;
    }) => {
      switch (input.kind) {
        case 'submit':
          return workflow.submit(revisionId, input.version);
        case 'review':
          return workflow.takeToReview(revisionId, input.version);
        case 'approve':
          return workflow.approve(revisionId, input.version);
        case 'return':
          return workflow.returnToContractor(revisionId, input.version, input.reason ?? '');
      }
    },
    onSuccess: async (result) => {
      message.success(
        `Ревизия переведена в состояние «${labelOf(WORKFLOW_STATUS_LABELS, result.revision.status)}»`,
      );
      setReturning(false);
      await refresh();
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (state.isPending) return <LoadingState label="Загрузка состояния согласования…" />;
  if (state.isError) return <ErrorState error={state.error} />;

  const data: WorkflowState = state.data;
  const version = data.revision.version;

  // В режиме тестирования препятствия не запирают кнопку: сервер тоже пропустит
  // переход, и выключенная кнопка означала бы запрет, которого больше нет.
  const blockedBySubmit = immutabilityEnforced && data.submitBlockers.length > 0;
  const blockedByApprove = immutabilityEnforced && data.approveBlockers.length > 0;

  return (
    <Card size="small" title="Согласование" data-testid="approval-card">
      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="Статус">
          <Tag data-testid="revision-status">
            {labelOf(WORKFLOW_STATUS_LABELS, data.revision.status)}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Ревизия">№ {data.revision.revisionNo}</Descriptions.Item>
        <Descriptions.Item label="Подана">{data.revision.submittedAt ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Решение">{data.revision.decidedAt ?? '—'}</Descriptions.Item>
      </Descriptions>

      {data.revision.returnReason !== null && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Причина возврата"
          description={data.revision.returnReason}
        />
      )}

      <Blockers
        title="Мешает отправить"
        items={data.submitBlockers}
        advisory={!immutabilityEnforced}
      />
      <Blockers
        title="Мешает согласовать"
        items={data.approveBlockers}
        advisory={!immutabilityEnforced}
      />

      <Space wrap style={{ marginTop: 12 }}>
        <Button
          type="primary"
          data-testid="submit-revision"
          disabled={blockedBySubmit || !can('submission.submit')}
          loading={act.isPending}
          onClick={() => act.mutate({ kind: 'submit', version })}
        >
          Отправить на согласование
        </Button>
        <Button
          data-testid="take-to-review"
          disabled={data.revision.status !== 'submitted' || !can('revision.approve')}
          loading={act.isPending}
          onClick={() => act.mutate({ kind: 'review', version })}
        >
          Взять на проверку
        </Button>
        <Button
          type="primary"
          data-testid="approve-revision"
          disabled={blockedByApprove || !can('revision.approve')}
          loading={act.isPending}
          onClick={() => act.mutate({ kind: 'approve', version })}
        >
          Согласовать
        </Button>
        <Button
          danger
          data-testid="return-revision"
          disabled={!can('revision.return')}
          onClick={() => setReturning(true)}
        >
          Вернуть подрядчику
        </Button>
      </Space>

      <ReturnDialog
        open={returning}
        busy={act.isPending}
        onCancel={() => setReturning(false)}
        onSubmit={(reason) => act.mutate({ kind: 'return', version, reason })}
      />
    </Card>
  );
}

/**
 * Список препятствий.
 *
 * `advisory` меняет не оформление, а утверждение. «Мешает» при снятом запрете
 * было бы неправдой: действие пройдёт. Поэтому в режиме тестирования плашка
 * прямо говорит, что список остался справкой, — иначе пользователь решит, что
 * кнопка сломана, или что портал врёт.
 */
function Blockers({
  title,
  items,
  advisory,
}: {
  title: string;
  items: readonly string[];
  advisory: boolean;
}): ReactNode {
  if (items.length === 0) return null;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 8 }}
      message={advisory ? `${title} (в режиме тестирования не запрещает)` : title}
      description={
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      }
    />
  );
}

function ReturnDialog(props: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}): ReactNode {
  const [form] = Form.useForm<{ reason: string }>();
  return (
    <Modal
      open={props.open}
      title="Вернуть ревизию подрядчику"
      okText="Вернуть"
      cancelText="Отмена"
      confirmLoading={props.busy}
      onCancel={props.onCancel}
      onOk={() => {
        void form.validateFields().then((values) => {
          props.onSubmit(values.reason.trim());
        });
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Возврат не переоткрывает ревизию: она закрывается, и создаётся новая с ссылкой на
        родительскую.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="reason"
          label="Причина возврата"
          rules={[
            { required: true, message: 'Причина обязательна' },
            { min: 10, message: 'Причина короче десяти символов — это отписка' },
          ]}
        >
          <Input.TextArea rows={4} data-testid="return-reason" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
