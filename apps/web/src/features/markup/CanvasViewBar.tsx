/**
 * Панель вида страницы: масштаб, панорама и разворот содержимого (§7.1).
 *
 * ## Почему это отдельная панель, а не часть `MarkupToolbar`
 *
 * Три причины, и каждая проверяется.
 *
 * Первая — РАЗНЫЕ права. `MarkupToolbar` целиком гасится флагом `editable`
 * (право `markup.edit`): выбор инструмента, тип блока, повтор детекции. Масштаб
 * же — действие ПРОСМОТРА, и оно обязано работать у роли без права правки,
 * иначе проверяющий не сможет разглядеть мелкий шрифт штампа. Свалив три разных
 * условия доступности в одну панель, мы либо запретим лишнее, либо разрешим.
 *
 * Вторая — панель инструментов уже переполнена: тег состояния, покрытие, хэш,
 * сегмент инструмента, селект типа и пять кнопок в `flexWrap`. Ещё шесть
 * контролов сделали бы её трёхстрочной и вытеснили бы канву вниз — ровно туда,
 * откуда её только что подняли.
 *
 * Третья — контрол стоит у своего предмета. Масштаб и разворот действуют на
 * КОЛОНКУ страницы и при перетаскивании разделителя обязаны ехать вместе с ней,
 * а не оставаться в общей шапке над четырьмя колонками.
 *
 * ## Почему разворот подписан двумя разными словами
 *
 * У страницы два поворота, и путать их нельзя. `/Rotate` из файла уже применён —
 * и к размерам карты страниц, и к вьюпорту pdf.js; он показан в ленте страниц
 * словом «поворот». Разворот содержимого не применён никем: это поправка к
 * скану, легшему на лист боком. Здесь он и называется «разворот», а источник
 * («зонд» или «вручную») подписан словом, а не цветом.
 */
import { type CSSProperties, type ReactNode } from 'react';
import { Button, Space, Tooltip, Typography } from 'antd';

import { TONE_STYLES } from '../../shared/tags.js';
import type { Rotation } from './rotation.js';
import type { ZoomMode } from './zoom.js';

const BAR: CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  flexWrap: 'wrap',
  padding: '6px 12px',
  border: '1px solid #f0f0f0',
  borderRadius: 6,
  background: '#fafafa',
  marginBottom: 8,
};

const PILL: CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 10,
  border: '1px solid',
};

export interface CanvasViewBarProps {
  readonly zoomMode: ZoomMode;
  /** Действующий масштаб — уже посчитанный, не «ручное значение». */
  readonly zoomPercent: number;
  readonly onZoomStep: (direction: 1 | -1) => void;
  readonly onZoomMode: (mode: ZoomMode) => void;

  readonly rotation: Rotation;
  /** Кем поставлен разворот; `null` — никто не решал, значение нулевое. */
  readonly rotationSource: 'probe' | 'user' | null;
  /** `false` гасит только поворот: масштаб остаётся доступным всегда. */
  readonly canRotate: boolean;
  readonly rotationPending: boolean;
  readonly onRotate: (quarterTurns: 1 | -1) => void;
  readonly onResetRotation: () => void;

  readonly textCollapsed: boolean;
  readonly onToggleText: () => void;
  readonly onResetColumns: () => void;
}

export function CanvasViewBar(props: CanvasViewBarProps): ReactNode {
  const rotationBusy = !props.canRotate || props.rotationPending;

  return (
    <div style={BAR} data-testid="canvas-view-bar">
      <Space size={4}>
        <Button size="small" onClick={() => props.onZoomStep(-1)} aria-label="Уменьшить">
          −
        </Button>
        <Typography.Text style={{ minWidth: 48, textAlign: 'center', display: 'inline-block' }}>
          {props.zoomPercent}%
        </Typography.Text>
        <Button size="small" onClick={() => props.onZoomStep(1)} aria-label="Увеличить">
          +
        </Button>
      </Space>

      <Space size={4}>
        <Button
          size="small"
          type={props.zoomMode === 'fit-width' ? 'primary' : 'default'}
          onClick={() => props.onZoomMode('fit-width')}
        >
          По ширине
        </Button>
        <Button
          size="small"
          type={props.zoomMode === 'fit-page' ? 'primary' : 'default'}
          onClick={() => props.onZoomMode('fit-page')}
        >
          Страница целиком
        </Button>
      </Space>

      <Space size={4}>
        <Button
          size="small"
          disabled={rotationBusy}
          onClick={() => props.onRotate(-1)}
          aria-label="Повернуть влево"
        >
          ↺
        </Button>
        <Button
          size="small"
          disabled={rotationBusy}
          onClick={() => props.onRotate(1)}
          aria-label="Повернуть вправо"
        >
          ↻
        </Button>
      </Space>

      <RotationNote
        rotation={props.rotation}
        source={props.rotationSource}
        canReset={props.rotationSource === 'user' && !rotationBusy}
        onReset={props.onResetRotation}
      />

      <Space size={4} style={{ marginLeft: 'auto' }}>
        <Button size="small" onClick={props.onToggleText}>
          {props.textCollapsed ? 'Показать распознанный текст' : 'Скрыть распознанный текст'}
        </Button>
        <Button size="small" onClick={props.onResetColumns}>
          Сбросить ширины колонок
        </Button>
      </Space>

      {/*
        Подсказка о жестах — текстом. Ctrl+колесо и панорама не имеют видимого
        контрола, и без строки о них человек не догадается, что они есть: канва
        выглядит одинаково с ними и без них.
      */}
      <Typography.Text type="secondary" style={{ fontSize: 12, flexBasis: '100%' }}>
        Ctrl + колесо — масштаб, средняя кнопка мыши или пробел с перетаскиванием — панорама.
      </Typography.Text>
    </div>
  );
}

function RotationNote(props: {
  readonly rotation: Rotation;
  readonly source: 'probe' | 'user' | null;
  readonly canReset: boolean;
  readonly onReset: () => void;
}): ReactNode {
  if (props.rotation === 0) {
    return (
      <Typography.Text type="secondary" data-testid="canvas-rotation-note">
        Разворот содержимого не задан
      </Typography.Text>
    );
  }

  const tone = props.source === 'user' ? TONE_STYLES.success : TONE_STYLES.info;
  const sourceWord = props.source === 'user' ? 'вручную' : 'зонд';

  return (
    <Space size={6} data-testid="canvas-rotation-note">
      <Typography.Text>Разворот содержимого: {props.rotation}°</Typography.Text>
      <span style={{ ...PILL, ...tone }}>{sourceWord}</span>
      {props.canReset && (
        <Tooltip title="Вернуть значение, определённое зондом">
          <Button size="small" type="link" onClick={props.onReset}>
            Сбросить
          </Button>
        </Tooltip>
      )}
    </Space>
  );
}
