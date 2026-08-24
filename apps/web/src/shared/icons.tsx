/**
 * Иконки навигации — три инлайновых SVG.
 *
 * ## Почему не `@ant-design/icons`
 *
 * Пакета нет в зависимостях `apps/web`, и добавлять его ради трёх глифов
 * незачем: он тянет в сборку тысячи путей, из которых портал использует три.
 * Сама antd берёт иконки из своей копии, поэтому под строгим `node_modules`
 * импорт из кода воркспейса всё равно не разрешился бы.
 *
 * ## Иконка сама по себе ничего не значит
 *
 * `aria-hidden` обязателен: в свёрнутом меню рядом с иконкой остаётся визуально
 * скрытое имя пункта, и без этого атрибута скринридер прочитал бы название
 * дважды либо — что хуже — сообщил бы «графика» вместо названия раздела.
 */
import type { ReactNode } from 'react';

interface IconProps {
  readonly size?: number;
}

function frame(size: number, children: ReactNode): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      {children}
    </svg>
  );
}

/** Раздел «ИД»: лист с загнутым углом. */
export function DocumentIcon({ size = 18 }: IconProps = {}): ReactNode {
  return frame(
    size,
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </>,
  );
}

/** Раздел «Справочники»: стопка книг. */
export function CatalogIcon({ size = 18 }: IconProps = {}): ReactNode {
  return frame(
    size,
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M10 4h4.5A1.5 1.5 0 0 1 16 5.5v13a1.5 1.5 0 0 1-1.5 1.5H10z" />
      <path d="M18 6.5 20 18" />
    </>,
  );
}

/** Раздел «Администрирование»: шестерня. */
export function SettingsIcon({ size = 18 }: IconProps = {}): ReactNode {
  return frame(
    size,
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </>,
  );
}

// =====================================================================
// Действия в таблицах (S24)
// =====================================================================

/*
 * Глифы действий рисуются здесь по той же причине, что и три навигационных
 * выше: `@ant-design/icons` в зависимостях нет, и добавлять пакет с тысячами
 * путей ради пяти фигур незачем.
 *
 * Все пять — БЕЗ подписи внутри, поэтому имя действия обязано приходить снаружи
 * (`RowActions.tsx` требует `label` типом). Иконка сама по себе ничего не
 * значит: «крестик» одинаково читается как «удалить» и как «закрыть», и решает
 * это не рисунок, а доступное имя.
 */

/** Удаление: корзина. */
export function TrashIcon({ size = 16 }: IconProps = {}): ReactNode {
  return frame(
    size,
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </>,
  );
}

/** Правка: карандаш. */
export function EditIcon({ size = 16 }: IconProps = {}): ReactNode {
  return frame(
    size,
    <>
      <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="M13.5 6.5 17.5 10.5" />
    </>,
  );
}

/** Открыть в новой вкладке: стрелка из рамки. */
export function OpenIcon({ size = 16 }: IconProps = {}): ReactNode {
  return frame(
    size,
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>,
  );
}

/** Переместить выше. */
export function MoveUpIcon({ size = 16 }: IconProps = {}): ReactNode {
  return frame(size, <path d="M12 19V6M6 12l6-6 6 6" />);
}

/** Переместить ниже. */
export function MoveDownIcon({ size = 16 }: IconProps = {}): ReactNode {
  return frame(size, <path d="M12 5v13M6 12l6 6 6-6" />);
}
