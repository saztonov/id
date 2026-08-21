/**
 * Одноразовый показ выданного пароля.
 *
 * Сервер возвращает пароль ровно один раз и нигде его не сохраняет: в БД лежит
 * только хэш, а ключ `temporaryPassword` внесён в список редактируемых полей
 * журнала. Значит и интерфейс обязан вести себя соответственно — сказать прямо,
 * что второго показа не будет, и дать скопировать без выделения мышью.
 *
 * Пароль передаётся человеку вне портала (голосом, в мессенджере). Это не
 * недостаток, а способ подтверждения личности: адрес при регистрации никем не
 * проверялся, и внеполосная передача — единственное, что связывает учётную
 * запись с конкретным человеком.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Alert, Button, Modal, Typography } from 'antd';

export function TemporaryPasswordModal(props: {
  readonly password: string | null;
  readonly login: string;
  readonly onClose: () => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    if (props.password === null) return;
    try {
      await navigator.clipboard.writeText(props.password);
      setCopied(true);
      message.success('Пароль скопирован');
    } catch {
      // Буфер обмена доступен не везде (http, отказ в разрешении). Пароль виден
      // на экране, поэтому это неудобство, а не отказ.
      message.warning('Скопировать не удалось — выделите пароль вручную.');
    }
  }

  return (
    <Modal
      open={props.password !== null}
      title="Пароль для первого входа"
      onCancel={props.onClose}
      afterClose={() => setCopied(false)}
      footer={
        <Button type="primary" onClick={props.onClose} data-testid="temporary-password-close">
          Готово
        </Button>
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Пароль показывается один раз"
        description={
          'Он не сохранён в портале в открытом виде и повторно показан не будет. ' +
          'Передайте его пользователю лично; при первом входе портал потребует его сменить.'
        }
      />

      <Typography.Paragraph>
        Учётная запись: <Typography.Text strong>{props.login}</Typography.Text>
      </Typography.Paragraph>
      <Typography.Paragraph>
        <Typography.Text code copyable={false} data-testid="temporary-password">
          {props.password}
        </Typography.Text>
      </Typography.Paragraph>

      <Button onClick={() => void copy()} disabled={copied}>
        {copied ? 'Скопировано' : 'Скопировать пароль'}
      </Button>
    </Modal>
  );
}
