/**
 * Канва страницы: рамки блоков поверх отрисованной страницы PDF (§7.2).
 *
 * Поддержаны все действия §7.2: нарисовать, перетащить, растянуть, сменить тип,
 * удалить, выделить несколько, применить тип к выделенным, заменить страницу
 * одним блоком. Часть их живёт в панели инструментов и в списке блоков — здесь
 * то, что делается мышью и клавиатурой по самой странице.
 *
 * ## Координаты
 *
 * Изображение и рамки рисуются от ОДНОГО размера (`size`), полученного из
 * вьюпорта pdf.js. Поэтому совпадение рамки с содержимым не зависит ни от зума,
 * ни от поворота страницы: см. `geometry.ts`, где объяснено, почему поворот
 * координат здесь не выполняется.
 *
 * ## Клавиатура и скринридер
 *
 * Konva рисует в `<canvas>`, а элементы канвы недоступны ни фокусу, ни
 * скринридеру по построению. Поэтому канва — не единственный путь к блоку:
 * рядом лежит список блоков со чекбоксами (`BlockList`), который является
 * полноценной альтернативой для клавиатуры, а сама канва помечена
 * `role="application"` с описанием доступных клавиш и `aria-label`, называющим
 * страницу и число блоков. Удаление и смена типа работают с клавиатуры именно
 * из списка, а не только мышью по канве.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Image as KonvaImage, Layer, Rect, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import type { BlockType } from '@id/contracts';
import type { LayoutBlock } from '../../api/types.js';
import { BLOCK_STYLES, SELECTION_STROKE, describeBlock } from './blocks.js';
import {
  coordsToRect,
  isDegenerate,
  normalizeCoords,
  rectToCoords,
  type PixelRect,
  type RenderedSize,
} from './geometry.js';

export interface PageCanvasProps {
  readonly size: RenderedSize;
  readonly image: HTMLCanvasElement | null;
  readonly blocks: readonly LayoutBlock[];
  readonly ranks: ReadonlyMap<string, number>;
  readonly selection: ReadonlySet<string>;
  readonly tool: 'select' | 'draw';
  readonly draftType: BlockType;
  readonly editable: boolean;
  readonly workingPageIndex: number;
  readonly onSelect: (blockId: string, additive: boolean) => void;
  readonly onClearSelection: () => void;
  readonly onCreate: (coords: ReturnType<typeof rectToCoords>) => void;
  readonly onMove: (blockId: string, coords: ReturnType<typeof rectToCoords>) => void;
}

/** Сторона квадратика-ручки растягивания в пикселях канвы. */
const HANDLE = 9;

export function PageCanvas(props: PageCanvasProps): ReactNode {
  const { size, image, blocks, ranks, selection, tool, draftType, editable } = props;
  const [draft, setDraft] = useState<PixelRect | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);

  // Смена страницы обязана снимать незавершённый черновик: иначе отпускание
  // мыши на новой странице создало бы блок по координатам старой.
  useEffect(() => {
    setDraft(null);
    drawStart.current = null;
  }, [props.workingPageIndex]);

  const pointerOf = (stage: Konva.Stage | null): { x: number; y: number } | null => {
    const position = stage?.getPointerPosition();
    if (position === undefined || position === null) return null;
    return {
      x: Math.min(Math.max(position.x, 0), size.width),
      y: Math.min(Math.max(position.y, 0), size.height),
    };
  };

  const beginDraw = (event: Konva.KonvaEventObject<PointerEvent>): void => {
    if (!editable || tool !== 'draw') return;
    const point = pointerOf(event.target.getStage());
    if (point === null) return;
    drawStart.current = point;
    setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const extendDraw = (event: Konva.KonvaEventObject<PointerEvent>): void => {
    const start = drawStart.current;
    if (start === null) return;
    const point = pointerOf(event.target.getStage());
    if (point === null) return;
    setDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const finishDraw = (): void => {
    const rect = draft;
    drawStart.current = null;
    setDraft(null);
    if (rect === null) return;
    const coords = rectToCoords(rect, size);
    // Случайный щелчок при включённом рисовании даёт вырожденную рамку. Такой
    // блок отвергла бы и схема, и CHECK в БД, поэтому он не отправляется вовсе:
    // 422 в ответ на промах мышью — это отказ по причине, которую пользователь
    // не совершал осознанно.
    if (isDegenerate(coords)) return;
    props.onCreate(coords);
  };

  return (
    <div
      role="application"
      aria-label={`Страница ${String(props.workingPageIndex + 1)}, блоков: ${String(blocks.length)}. Рамки блоков правятся мышью; тот же набор доступен с клавиатуры в списке блоков справа.`}
      style={{ width: size.width, height: size.height, position: 'relative' }}
    >
      <Stage
        width={size.width}
        height={size.height}
        onPointerDown={(event: Konva.KonvaEventObject<PointerEvent>) => {
          if (tool === 'draw') {
            beginDraw(event);
            return;
          }
          // Щелчок по пустому месту снимает выделение: иначе «применить тип к
          // выделенным» однажды сработает по забытому выделению.
          if (event.target === event.target.getStage()) props.onClearSelection();
        }}
        onPointerMove={extendDraw}
        onPointerUp={finishDraw}
        style={{ cursor: tool === 'draw' && editable ? 'crosshair' : 'default' }}
      >
        <Layer listening={false}>
          {image !== null && (
            <KonvaImage image={image} width={size.width} height={size.height} alt="" />
          )}
        </Layer>
        <Layer>
          {blocks.map((block) => (
            <BlockShape
              key={block.id}
              block={block}
              rank={ranks.get(block.id) ?? 0}
              size={size}
              selected={selection.has(block.id)}
              editable={editable && tool === 'select'}
              onSelect={props.onSelect}
              onMove={props.onMove}
            />
          ))}
          {draft !== null && (
            <Rect
              x={draft.x}
              y={draft.y}
              width={draft.width}
              height={draft.height}
              stroke={BLOCK_STYLES[draftType].stroke}
              fill={BLOCK_STYLES[draftType].fill}
              dash={[4, 4]}
              strokeWidth={2}
              listening={false}
            />
          )}
        </Layer>
      </Stage>
    </div>
  );
}

interface BlockShapeProps {
  readonly block: LayoutBlock;
  readonly rank: number;
  readonly size: RenderedSize;
  readonly selected: boolean;
  readonly editable: boolean;
  readonly onSelect: (blockId: string, additive: boolean) => void;
  readonly onMove: (blockId: string, coords: ReturnType<typeof rectToCoords>) => void;
}

/**
 * Одна рамка: перенос целиком и растягивание за угловые ручки.
 *
 * Растягивание сделано ручками, а не `Konva.Transformer`, по двум причинам.
 * Первая: трансформер меняет `scaleX/scaleY`, и обратный пересчёт в координаты
 * приходится вести через произведение размера на масштаб — лишний множитель в
 * том самом месте, где ошибка означает уехавшую рамку. Вторая: трансформер
 * добавляет вращение, которого у блока нет и быть не может — `layout_blocks`
 * хранит четыре координаты, а не угол.
 */
function BlockShape(props: BlockShapeProps): ReactNode {
  const { block, rank, size, selected, editable } = props;
  const rect = coordsToRect(block.coords, size);
  const style = BLOCK_STYLES[block.blockType];

  const commit = (next: PixelRect): void => {
    const coords = normalizeCoords(rectToCoords(next, size));
    if (isDegenerate(coords)) return;
    props.onMove(block.id, coords);
  };

  const handles: readonly { key: string; x: number; y: number; corner: string }[] = [
    { key: 'nw', x: rect.x, y: rect.y, corner: 'nw' },
    { key: 'ne', x: rect.x + rect.width, y: rect.y, corner: 'ne' },
    { key: 'sw', x: rect.x, y: rect.y + rect.height, corner: 'sw' },
    { key: 'se', x: rect.x + rect.width, y: rect.y + rect.height, corner: 'se' },
  ];

  return (
    <>
      <Rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        stroke={selected ? SELECTION_STROKE : style.stroke}
        strokeWidth={selected ? 3 : 1.5}
        dash={style.dash}
        fill={style.fill}
        draggable={editable}
        onPointerDown={(event: Konva.KonvaEventObject<PointerEvent>) => {
          event.cancelBubble = true;
          const additive = event.evt.ctrlKey || event.evt.metaKey || event.evt.shiftKey;
          props.onSelect(block.id, additive);
        }}
        onDragEnd={(event: Konva.KonvaEventObject<DragEvent>) => {
          commit({
            x: event.target.x(),
            y: event.target.y(),
            width: rect.width,
            height: rect.height,
          });
        }}
      />
      <Text
        x={rect.x + 3}
        y={rect.y + 3}
        text={String(rank)}
        fontSize={13}
        fontStyle="bold"
        fill={style.stroke}
        listening={false}
        // Тот же текст, что читает список блоков: подпись номера не должна
        // существовать только как пиксели.
        name={describeBlock(block, rank)}
      />
      {selected &&
        editable &&
        handles.map((handle) => (
          <Rect
            key={handle.key}
            x={handle.x - HANDLE / 2}
            y={handle.y - HANDLE / 2}
            width={HANDLE}
            height={HANDLE}
            fill="#ffffff"
            stroke={SELECTION_STROKE}
            strokeWidth={1.5}
            draggable
            onPointerDown={(event: Konva.KonvaEventObject<PointerEvent>) => {
              event.cancelBubble = true;
            }}
            onDragEnd={(event: Konva.KonvaEventObject<DragEvent>) => {
              const x = event.target.x() + HANDLE / 2;
              const y = event.target.y() + HANDLE / 2;
              const left = handle.corner.includes('w') ? x : rect.x;
              const top = handle.corner.includes('n') ? y : rect.y;
              const right = handle.corner.includes('e') ? x : rect.x + rect.width;
              const bottom = handle.corner.includes('s') ? y : rect.y + rect.height;
              commit({
                x: Math.min(left, right),
                y: Math.min(top, bottom),
                width: Math.abs(right - left),
                height: Math.abs(bottom - top),
              });
            }}
          />
        ))}
    </>
  );
}
