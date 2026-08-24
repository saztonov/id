/**
 * Действия строки таблицы пиктограммами (S24).
 *
 * ## Почему иконка, а не слово
 *
 * Колонка «Действия» с тремя-четырьмя текстовыми кнопками съедала треть ширины
 * таблицы, и содержательные колонки — имя файла, название комплекта — сжимались
 * до многоточия. Действия при этом одинаковы во всех таблицах портала: удалить,
 * изменить, открыть. Повторять эти три слова в каждой строке каждой таблицы —
 * это платить шириной за то, что читатель и так знает.
 *
 * ## Имя действия обязательно, и поэтому оно в типе
 *
 * `label` не опционален. Кнопка-иконка без доступного имени — это кнопка,
 * которой для скринридера не существует, и гейт §17 (`axe`, правило
 * `button-name`) ловит её как отказ. То же имя уходит в подсказку: «крестик»
 * без пояснения одинаково читается как «удалить» и как «закрыть», и различает
 * их не рисунок, а слово.
 *
 * Имя обязано называть ОБЪЕКТ, а не только глагол: в таблице из двадцати строк
 * двадцать кнопок «Удалить» неразличимы на слух. Поэтому вызывающий передаёт
 * «Удалить файл „АОСР № 336.pdf“», а не «Удалить».
 *
 * ## «Открыть» — ссылка, а не кнопка
 *
 * Выдача содержимого открывается в новой вкладке и обязана оставаться `<a>`:
 * средний клик, «сохранить как» и копирование адреса — это поведение ссылки, и
 * кнопка с `window.open` его отнимает.
 *
 * ## Что НЕ становится иконкой
 *
 * Переключатель с двумя состояниями («Отключить»/«Включить») остаётся словом:
 * иконка показывает действие, а не состояние, и по ней нельзя понять, включено
 * сейчас или выключено. Редкие ответственные действия с длинным смыслом («Снять
 * с обоснованием») тоже остаются подписью — общепонятного глифа у них нет, а
 * выдуманный пришлось бы объяснять каждому новому пользователю.
 */
import type { ReactNode, Ref } from 'react';
import { Button, Popconfirm, Space, Tooltip } from 'antd';

export interface IconActionProps {
  /** Глиф из `shared/icons.tsx`. */
  readonly icon: ReactNode;
  /**
   * Доступное имя и подсказка. Обязательно и обязано называть объект действия:
   * «Удалить файл „АОСР № 336.pdf“», а не «Удалить».
   */
  readonly label: string;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly danger?: boolean | undefined;
  /** Задан — рисуется ссылка в новую вкладку вместо кнопки. */
  readonly href?: string | undefined;
  /**
   * Показывать подсказку компонентом `Tooltip`.
   *
   * `false` — подсказка ставится нативным атрибутом `title`. Нужно там, где
   * кнопка уже служит триггером другого всплывающего слоя: `Tooltip` и
   * `Popconfirm` оба клонируют потомка и вешают на него свои обработчики, а
   * всплывшая подсказка перекрывает подтверждение и не даёт по нему попасть.
   * Проверено прогоном: кнопка «Удалить» в подтверждении находилась, но
   * оставалась «не стабильной» до самого таймаута.
   */
  readonly tooltip?: boolean | undefined;
  readonly testId?: string | undefined;
  /**
   * Ссылка на DOM-узел кнопки.
   *
   * Нужна `Popconfirm`: он клонирует потомка и вешает на него `ref`, чтобы
   * привязать всплывающее подтверждение к его положению. React 19 передаёт
   * `ref` обычным свойством, но функциональный компонент обязан ПРИНЯТЬ его и
   * отдать дальше — иначе якоря нет и подтверждение уезжает за край экрана.
   * Найдено прогоном: кнопка «Удалить» в подтверждении находилась, но навсегда
   * оставалась «outside of the viewport».
   */
  readonly ref?: Ref<HTMLButtonElement> | undefined;
}

export function IconAction(props: IconActionProps): ReactNode {
  const { icon, label, href, testId, ref } = props;
  const withTooltip = props.tooltip !== false;

  const button = (
    <Button
      {...(ref === undefined ? {} : { ref })}
      type="text"
      size="small"
      danger={props.danger ?? false}
      disabled={props.disabled ?? false}
      loading={props.loading ?? false}
      onClick={props.onClick ?? undefined}
      // `aria-label`, а не `title`: antd ставит `title` сам только у части
      // компонентов, и полагаться на подсказку как на источник имени нельзя —
      // она не читается скринридером как имя элемента.
      aria-label={label}
      // Нативная подсказка вместо компонента там, где `Tooltip` мешал бы
      // подтверждению. `aria-label` при этом остаётся источником имени в обоих
      // случаях: `title` скринридером как имя не читается.
      {...(withTooltip ? {} : { title: label })}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      {...(href === undefined ? {} : { href, target: '_blank', rel: 'noreferrer' as const })}
      icon={icon}
    />
  );

  // Подсказка не оборачивает выключенную кнопку: antd снимает с неё указатель
  // событий, и подсказка не всплыла бы — а место под неё осталось бы занято.
  return props.disabled === true || !withTooltip ? (
    button
  ) : (
    <Tooltip title={label}>{button}</Tooltip>
  );
}

/**
 * Пиктограмма с подтверждением.
 *
 * Отдельный компонент, а не флаг у `IconAction`: подтверждение — это не
 * оформление, а вопрос с собственным текстом. Удаление без объяснения
 * последствий («будет удалён рабочий документ и разметка») — ровно та кнопка, о
 * которой потом спрашивают «а куда всё делось».
 */
export interface ConfirmIconActionProps extends IconActionProps {
  readonly confirmTitle: string;
  readonly confirmDescription?: ReactNode;
  readonly okText?: string;
}

export function ConfirmIconAction(props: ConfirmIconActionProps): ReactNode {
  const { confirmTitle, confirmDescription, okText, onClick, ...rest } = props;

  if (rest.disabled === true) return <IconAction {...rest} />;

  return (
    <Popconfirm
      title={confirmTitle}
      {...(confirmDescription === undefined ? {} : { description: confirmDescription })}
      okText={okText ?? 'Удалить'}
      cancelText="Отмена"
      okButtonProps={{ danger: rest.danger ?? true }}
      {...(onClick === undefined ? {} : { onConfirm: onClick })}
    >
      {/*
        onClick не передаётся: нажатие перехватывает Popconfirm и вызывает его
        сам. `tooltip={false}` — потому что подтверждение уже всплывающий слой на
        этом же триггере, и второй перекрывал бы его.
      */}
      <IconAction {...rest} tooltip={false} />
    </Popconfirm>
  );
}

/** Обёртка колонки «Действия»: одинаковые отступы во всех таблицах портала. */
export function RowActions({ children }: { children: ReactNode }): ReactNode {
  return (
    <Space size={0} wrap>
      {children}
    </Space>
  );
}
