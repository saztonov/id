/**
 * Окно сравнения версий разметки (§7.2).
 *
 * Требование этапа буквально: «при конфликте пользователь видит сравнение
 * версий, а не молчаливую перезапись». Отсюда три свойства этого окна.
 *
 * **Оно показывает расхождение, а не сообщение об ошибке.** Таблица называет
 * каждый блок и каждое поле, у которого разошлись значения, с обеих сторон.
 *
 * **У него нет кнопки «повторить»,** которая просто отправила бы правку с новой
 * версией. Такая кнопка и есть молчаливая перезапись, только с лишним щелчком.
 * Есть «Взять версию сервера» — то есть перечитать и продолжить с фактического
 * состояния.
 *
 * **Оно называет, сколько успело примениться** в пакетной операции. Без этого
 * пользователь не может знать, применён ли тип к первым трём выделенным блокам
 * из семи, и второе нажатие применяло бы его повторно.
 */
import { type ReactNode } from 'react';
import { Alert, Modal, Table, Typography } from 'antd';
import { BLOCK_STYLES } from './blocks.js';
import { FIELD_LABELS, summarizeDiff, type LayoutDiff } from './conflict.js';

export interface VersionConflictModalProps {
  readonly open: boolean;
  readonly diff: LayoutDiff;
  readonly serverVersion: number;
  readonly appliedBefore: number;
  readonly onAcceptServer: () => void;
}

interface Row {
  readonly key: string;
  readonly what: string;
  readonly block: string;
  readonly mine: string;
  readonly theirs: string;
}

export function VersionConflictModal(props: VersionConflictModalProps): ReactNode {
  const { diff, serverVersion, appliedBefore } = props;

  const rows: Row[] = [
    ...diff.added.map((block) => ({
      key: `added-${block.id}`,
      what: 'Появился на сервере',
      block: `${BLOCK_STYLES[block.blockType].label}, стр. ${String(block.workingPageIndex + 1)}`,
      mine: 'нет',
      theirs: 'есть',
    })),
    ...diff.removed.map((block) => ({
      key: `removed-${block.id}`,
      what: 'Удалён на сервере',
      block: `${BLOCK_STYLES[block.blockType].label}, стр. ${String(block.workingPageIndex + 1)}`,
      mine: 'есть',
      theirs: 'нет',
    })),
    ...diff.changed.flatMap((entry) =>
      entry.changes.map((change) => ({
        key: `changed-${entry.block.id}-${change.field}`,
        what: FIELD_LABELS[change.field],
        block: `${BLOCK_STYLES[entry.block.blockType].label}, стр. ${String(entry.block.workingPageIndex + 1)}`,
        mine: change.mine,
        theirs: change.theirs,
      })),
    ),
  ];

  return (
    <Modal
      open={props.open}
      title="Разметку изменил другой пользователь"
      okText="Взять версию сервера"
      onOk={props.onAcceptServer}
      onCancel={props.onAcceptServer}
      cancelButtonProps={{ style: { display: 'none' } }}
      width={720}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        message={summarizeDiff(diff)}
        description={
          <>
            <div>Версия разметки на сервере: {serverVersion}.</div>
            {appliedBefore > 0 && (
              <div data-testid="conflict-applied-before">
                До конфликта успело примениться изменений: {appliedBefore}. Остальные выделенные
                блоки не изменены.
              </div>
            )}
            <div>
              Ваша правка не записана и чужую не затирает. Экран перечитан — повторите действие,
              видя фактическое состояние.
            </div>
          </>
        }
        style={{ marginBottom: 16 }}
      />

      {rows.length === 0 ? (
        <Typography.Paragraph type="secondary">
          По этой странице расхождений нет: версию подняла правка другой страницы комплекта.
        </Typography.Paragraph>
      ) : (
        <Table<Row>
          size="small"
          rowKey="key"
          dataSource={rows}
          pagination={false}
          data-testid="conflict-diff-table"
          columns={[
            { title: 'Что', dataIndex: 'what', key: 'what' },
            { title: 'Блок', dataIndex: 'block', key: 'block' },
            { title: 'У вас на экране', dataIndex: 'mine', key: 'mine' },
            { title: 'На сервере', dataIndex: 'theirs', key: 'theirs' },
          ]}
        />
      )}
    </Modal>
  );
}
