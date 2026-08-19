/**
 * Обоснованный отказ от замечания (§9.6).
 *
 * Обоснование — обязательное поле не короче десяти символов, потому что таким
 * его объявляет сервер (`reasonBodySchema`), и потому что значение уезжает в
 * `review_actions` и в `audit_log`, то есть в юридически значимый след. Пустая
 * строка означала бы решение без причины, записанное как решение с причиной.
 */
import { type ReactNode } from 'react';
import { Form, Input, Modal, Typography } from 'antd';
import type { Finding } from '../../api/types.js';

export interface OverrideDialogProps {
  readonly finding: Finding | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}

export function OverrideDialog(props: OverrideDialogProps): ReactNode {
  const [form] = Form.useForm<{ reason: string }>();
  const finding = props.finding;

  return (
    <Modal
      open={finding !== null}
      title="Снять блокирующее замечание"
      okText="Снять с обоснованием"
      cancelText="Отмена"
      confirmLoading={props.busy}
      onCancel={props.onCancel}
      onOk={() => {
        void form.validateFields().then((values) => props.onSubmit(values.reason.trim()));
      }}
      destroyOnHidden
    >
      {finding !== null && (
        <Typography.Paragraph>
          <strong>{finding.ruleCode}</strong>: {finding.message}
        </Typography.Paragraph>
      )}
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="reason"
          label="Обоснование решения"
          rules={[
            { required: true, message: 'Обоснование обязательно' },
            { min: 10, message: 'Обоснование короче десяти символов — это отписка, а не причина' },
            { max: 2000, message: 'Не более 2000 символов' },
          ]}
        >
          <Input.TextArea rows={4} data-testid="override-reason" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
