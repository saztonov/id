/**
 * Панель «Тип страницы» над канвой разметки (§8.2, решение заказчика 2026-08-20).
 *
 * Инженер размечает вид ИД каждой страницы прямо там, где её видит, — на экране
 * разметки, а не на вкладке «Документы» вслепую по номерам. Данные и мутации те
 * же, что у таблицы классификаций: `GET /revisions/{id}/classifications` и
 * `PUT/DELETE …/manual-label` через общий хук `useManualLabel`.
 *
 * ## Значение селекта — только ручная метка
 *
 * Автоматический вывод конвейера показывается ОТДЕЛЬНЫМ текстом («Автоматически:
 * …»), а не значением селекта: значение в поле читается как «так решил человек»,
 * и подставленный туда вывод модели выглядел бы подтверждённым, хотя никто его
 * не подтверждал. Ровно так различает их и таблица классификаций.
 *
 * ## Панель не зависит от состояния разметки
 *
 * Метка — свойство ревизии поставки (`page_classifications`), а не ревизии
 * разметки: она влияет на сегментацию документов, а не на блоки. Поэтому панель
 * не гаснет ни от чего, что происходит с разметкой. Право у панели своё:
 * `document.edit`, как у таблицы классификаций, а не `markup.edit`.
 *
 * Все контролы — DOM (Select и кнопки antd): канва Konva скринридеру недоступна,
 * и разметка типа обязана иметь путь мимо неё (§17).
 */
import { type ReactNode } from 'react';
import { Button, Select, Space, Typography } from 'antd';
import type { DocType, PageClassification } from '../../api/types.js';
import { ToneTag } from '../../shared/tags.js';
import { useManualLabel } from './useManualLabel.js';

/**
 * Ширина выпадающего списка видов ИД.
 *
 * 560 px покрывают самое длинное название каталога целиком. Число, а не
 * `false`: `false` отдаёт ширину содержимому, и список прыгал бы от страницы к
 * странице вслед за самой длинной ВИДИМОЙ строкой — при поиске по подстроке
 * набор строк меняется на каждое нажатие клавиши.
 */
const POPUP_WIDTH = 560;

export interface PageTypePanelProps {
  readonly revisionId: string;
  /** Страница рабочего документа, открытая на канве. */
  readonly page: { readonly sourcePageId: string; readonly workingPageIndex: number };
  /** Строка классификации этой страницы; отсутствие строки — «тип не задан». */
  readonly classification: PageClassification | undefined;
  /** Каталог видов ИД — тот же, что на вкладке «Документы». */
  readonly docTypes: readonly DocType[];
  /** Право `document.edit`: без него панель видна, но контролы выключены. */
  readonly canEdit: boolean;
}

export function PageTypePanel(props: PageTypePanelProps): ReactNode {
  const { page, classification, docTypes, canEdit } = props;
  const manual = useManualLabel(props.revisionId);

  const isManual = classification?.source === 'manual';
  const pageNo = page.workingPageIndex + 1;

  // `title` дублирует подпись: даже в широком списке названия вроде «Акт
  // освидетельствования участков сетей инженерно-технического обеспечения»
  // упираются в правый край, и подсказка по наведению — единственный способ
  // дочитать строку, не выбирая её.
  const typeOptions = docTypes.map((type) => {
    const label = `${type.name}${type.isFallback ? ' (резервный)' : ''}`;
    return { value: type.code, label, title: label };
  });

  return (
    <div
      data-testid="page-type-panel"
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '8px 12px',
        border: '1px solid #f0f0f0',
        borderRadius: 6,
        background: '#fafafa',
        marginBottom: 8,
      }}
    >
      <Typography.Text strong>Тип страницы {pageNo}</Typography.Text>
      <Space size={6} wrap>
        <Select
          size="small"
          // Ширина фиксированная, а не `flex`: `Space` оборачивает каждого
          // потомка в собственный `div`, поэтому селект НЕ является flex-
          // элементом панели, и `flex-basis` на нём был бы проигнорирован.
          // 420 px вмещают большинство названий каталога; остальное дочитывается
          // в выпадающем списке и в подсказке. Прежние 240 px резали до двух
          // слов даже короткие названия. `maxWidth: '100%'` спасает узкий экран:
          // панель `flex-wrap`, и селект переносится целиком, а не выдавливает
          // соседей за край.
          style={{ width: 420, maxWidth: '100%' }}
          // Выпадающий список ШИРЕ поля. По умолчанию antd повторяет ширину
          // поля (`popupMatchSelectWidth: true`), и обрезание из поля попадало
          // в список — то есть выбрать было нельзя даже вслепую по началу
          // строки, если начала совпадают («Акт освидетельствования …»).
          popupMatchSelectWidth={POPUP_WIDTH}
          // Значение — ТОЛЬКО ручная метка вида (B-DOC с типом). Автовывод и
          // «продолжение» значением не показываются: у продолжения собственного
          // типа нет, а автовывод подписан отдельным текстом ниже.
          {...(isManual && classification.docTypeCode !== null
            ? { value: classification.docTypeCode }
            : {})}
          options={typeOptions}
          showSearch
          optionFilterProp="label"
          disabled={!canEdit || manual.pending}
          onChange={(value: string) => manual.setType(page.sourcePageId, value)}
          aria-label={`Вид ИД страницы ${String(pageNo)}`}
        />
        <Button
          size="small"
          disabled={!canEdit || manual.pending}
          title="Страница продолжает предыдущий документ (I-DOC, без собственного типа)"
          onClick={() => manual.setContinuation(page.sourcePageId)}
        >
          Продолжение
        </Button>
        {isManual && (
          <Button
            size="small"
            danger
            disabled={!canEdit || manual.pending}
            onClick={() => manual.clear(page.sourcePageId)}
          >
            Снять
          </Button>
        )}
      </Space>

      {classification === undefined ? (
        <Typography.Text type="secondary">Тип не задан</Typography.Text>
      ) : (
        <Space size={4} wrap>
          {isManual ? (
            <>
              <ToneTag tone="success">вручную</ToneTag>
              {classification.label === 'I-DOC' && (
                <Typography.Text type="secondary">продолжение документа</Typography.Text>
              )}
            </>
          ) : (
            // Формулировка та же, что в таблице классификаций: вывод конвейера с
            // уверенностью, по которой человек решает, верить ли ему.
            <Typography.Text type="secondary">
              Автоматически: {classification.docTypeCode ?? classification.label}
              {classification.confidence !== null &&
                `, уверенность ${classification.confidence.toFixed(2)}`}
            </Typography.Text>
          )}
        </Space>
      )}
    </div>
  );
}
