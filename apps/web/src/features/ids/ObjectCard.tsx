/**
 * Карточка объекта в галерее раздела ИД.
 *
 * ## Карточка — это ссылка, а не блок с обработчиком клика
 *
 * Портал смет вешает `onClick` на `Card` (`EstimatesPage.tsx`), и такая плитка
 * недостижима с клавиатуры, не открывается средним кликом и не сообщает
 * скринридеру адреса. Здесь карточка обёрнута настоящим `<a href>` — тем же
 * `Link`, что и остальные переходы портала.
 *
 * Отсюда же запрет, который важнее удобства: внутрь карточки НЕЛЬЗЯ добавлять
 * кнопки, `Popconfirm`, переключатели и триггеры подсказок с `tabIndex`. Любой
 * интерактивный элемент внутри ссылки даёт `nested-interactive` — нарушение
 * критического уровня, роняющее гейт §17. Ровно так устроена карточка портала
 * смет: четыре кнопки в теле кликабельной области, каждая с `stopPropagation`.
 * Если действия над объектом однажды понадобятся, их место — экран объекта.
 *
 * ## Что показано и чего нет
 *
 * Код обязан быть виден: им объект называют в номерах актов и в названиях папок,
 * и буквы на обложке его не заменяют. Код делит строку с адресом — это и есть
 * источник компактности: две коротких величины в одной строке вместо двух строк.
 *
 * Полного наименования на карточке нет: в данных портала оно почти всегда дубль
 * наименования и стоило бы двадцати пикселей высоты ради нуля сведений. Оно
 * уходит в `title` ссылки, и только когда отличается; целиком его показывает
 * экран объекта. Признак активности не показан по решению заказчика — портал его
 * не отслеживает. Реквизиты (кадастровый номер, идентификатор разрешения) — это
 * данные печатных форм, а не признак узнавания объекта.
 */
import type { ReactNode } from 'react';
import { Card } from 'antd';
import { Link } from '../../app/router.js';
import type { ConstructionObject } from '../../api/types.js';
import { coverGradient, objectInitials } from './objectCover.js';

/** Одна строка с многоточием: наименование и мета обязаны держать высоту карточки. */
const ONE_LINE = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

export function ObjectCard({ object }: { object: ConstructionObject }): ReactNode {
  // Прочерка при пустом адресе нет: строка сжимается до кода. Прочерк на
  // карточке — это шум, сообщающий об отсутствии того, чего от неё не ждут.
  const meta = object.address === null ? object.code : `${object.code} · ${object.address}`;

  return (
    <Link
      to={`/ids/objects/${object.id}`}
      {...(object.fullName === object.name ? {} : { title: object.fullName })}
      /*
        `color: inherit` — иначе текст карточки красится `colorLink` и вся
        плитка становится синей. Подчёркивание снято: правило `link-in-text-block`
        касается ссылок внутри абзаца, а не плиток.

        Обводку фокуса трогать нельзя: инлайновые стили не умеют `:focus-visible`,
        вернуть контур будет нечем, а критерий 2.4.7 axe автоматически не
        проверяет — дефект уехал бы в прод незамеченным. Контур рисуется на самой
        ссылке, снаружи `overflow: hidden` карточки, поэтому не срезается: по той
        же причине `borderRadius` и `overflow` здесь не задаются.
      */
      style={{ display: 'block', height: '100%', color: 'inherit', textDecoration: 'none' }}
    >
      <Card
        hoverable
        styles={{ body: { padding: '10px 12px' } }}
        cover={
          /*
            Обложка декоративна и скрыта от скринридера: иначе доступное имя
            ссылки начинается с «ЖЗ» — буквами, которые вслух не значат ничего.
            `aria-hidden` здесь безопасен, потому что внутри нет фокусируемых
            элементов (иначе было бы `aria-hidden-focus`).
          */
          <div
            aria-hidden="true"
            style={{
              height: 64,
              background: coverGradient(object.code),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontSize: 22,
              fontWeight: 700,
              lineHeight: '22px',
              letterSpacing: 1.5,
              userSelect: 'none',
            }}
          >
            {objectInitials(object.name)}
          </div>
        }
      >
        <div data-testid={`object-card-${object.code}`}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '20px', ...ONE_LINE }}>
            {object.name}
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 12,
              lineHeight: '16px',
              color: 'rgba(0, 0, 0, 0.62)',
              ...ONE_LINE,
            }}
          >
            {meta}
          </div>
        </div>
      </Card>
    </Link>
  );
}
