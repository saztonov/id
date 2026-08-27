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
 * Изображение и рамки рисуются от ОДНОГО размера (`content`), полученного из
 * вьюпорта pdf.js. Поэтому совпадение рамки с содержимым не зависит ни от зума,
 * ни от `/Rotate` страницы: см. `geometry.ts`, где объяснено, почему поворот
 * координат здесь не выполняется.
 *
 * ## Разворот содержимого
 *
 * Скан, положенный на лист боком (`/Rotate = 0`, а текст идёт вертикально),
 * показывается развёрнутым. Разворот сделан ОДНОЙ трансформацией `Group` внутри
 * каждого слоя, а не отдельными вычислениями для картинки и для рамок: обе
 * лежат в одной группе, поэтому разъехаться не могут по построению.
 *
 * Слоёв при этом по-прежнему ДВА — поворот не добавляет третьего. На этом
 * держится утверждение сквозного теста о числе элементов `<canvas>`, и заводить
 * третий `Layer` ради поворота значит сломать его, не поняв, о чём он.
 *
 * Внутри группы всё считается в координатах НЕповёрнутого содержимого, поэтому
 * `coordsToRect`, `rectToCoords` и перетаскивание рамок не знают о развороте
 * вовсе. Единственное место, где он виден, — положение указателя: оно берётся
 * `getRelativePointerPosition()` у самой группы, и Konva инвертирует её
 * трансформацию сам. Почему нельзя было повернуть контейнер средствами CSS —
 * разобрано в шапке `rotation.ts`.
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
import { Group, Image as KonvaImage, Layer, Rect, Stage, Text } from 'react-konva';
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
import { contentTransform, type Rotation } from './rotation.js';

export interface PageCanvasProps {
  /**
   * Размер НЕповёрнутого содержимого — та система, в которой заданы
   * `coords_norm`. Не путать с размером сцены: при развороте на четверть у них
   * переставлены стороны.
   */
  readonly content: RenderedSize;
  /** Разворот содержимого по часовой стрелке; 0 — лист лежит прямо. */
  readonly rotation: Rotation;
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
  const { content, rotation, image, blocks, ranks, selection, tool, draftType, editable } = props;
  const [draft, setDraft] = useState<PixelRect | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  /**
   * Группа рамок — та система координат, в которой человек целится.
   *
   * Ссылка нужна ради `getRelativePointerPosition()`: положение указателя внутри
   * повёрнутой группы Konva считает сам, инвертируя её трансформацию. Брать
   * `stage.getPointerPosition()` нельзя — оно даёт координаты СЦЕНЫ, и на
   * развёрнутой странице рамка легла бы не туда, куда вели мышь, причём молча.
   */
  const contentRef = useRef<Konva.Group | null>(null);

  const { stage, group } = contentTransform(content, rotation);

  // Смена страницы обязана снимать незавершённый черновик: иначе отпускание
  // мыши на новой странице создало бы блок по координатам старой.
  useEffect(() => {
    setDraft(null);
    drawStart.current = null;
  }, [props.workingPageIndex]);

  // Смена разворота — тоже: черновик начат в одной системе координат, а
  // закончится в другой.
  useEffect(() => {
    setDraft(null);
    drawStart.current = null;
  }, [rotation]);

  const pointerOf = (): { x: number; y: number } | null => {
    const position = contentRef.current?.getRelativePointerPosition();
    if (position === undefined || position === null) return null;
    return {
      x: Math.min(Math.max(position.x, 0), content.width),
      y: Math.min(Math.max(position.y, 0), content.height),
    };
  };

  const beginDraw = (): void => {
    if (!editable || tool !== 'draw') return;
    const point = pointerOf();
    if (point === null) return;
    drawStart.current = point;
    setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const extendDraw = (): void => {
    const start = drawStart.current;
    if (start === null) return;
    const point = pointerOf();
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
    const coords = rectToCoords(rect, content);
    // Случайный щелчок при включённом рисовании даёт вырожденную рамку. Такой
    // блок отвергла бы и схема, и CHECK в БД, поэтому он не отправляется вовсе:
    // 422 в ответ на промах мышью — это отказ по причине, которую пользователь
    // не совершал осознанно.
    if (isDegenerate(coords)) return;
    props.onCreate(coords);
  };

  // Разворот дописывается в КОНЕЦ подписи: её начало («Страница N, блоков: M»)
  // закреплено сквозным тестом доступности как признак того, что канва вообще
  // назвалась.
  const rotationNote = rotation === 0 ? '' : ` Лист показан развёрнутым на ${String(rotation)}°.`;

  return (
    <div
      role="application"
      aria-label={`Страница ${String(props.workingPageIndex + 1)}, блоков: ${String(blocks.length)}. Рамки блоков правятся мышью; тот же набор доступен с клавиатуры в списке блоков справа.${rotationNote}`}
      style={{ width: stage.width, height: stage.height, position: 'relative' }}
    >
      <Stage
        width={stage.width}
        height={stage.height}
        onPointerDown={(event: Konva.KonvaEventObject<PointerEvent>) => {
          if (tool === 'draw') {
            beginDraw();
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
          <Group {...group}>
            {image !== null && (
              <KonvaImage image={image} width={content.width} height={content.height} alt="" />
            )}
          </Group>
        </Layer>
        <Layer>
          <Group {...group} ref={contentRef}>
            {blocks.map((block) => (
              <BlockShape
                key={block.id}
                block={block}
                rank={ranks.get(block.id) ?? 0}
                size={content}
                rotation={rotation}
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
          </Group>
        </Layer>
      </Stage>
    </div>
  );
}

interface BlockShapeProps {
  readonly block: LayoutBlock;
  readonly rank: number;
  /** Размер НЕповёрнутого содержимого: рамка живёт внутри повёрнутой группы. */
  readonly size: RenderedSize;
  /** Разворот группы — нужен ТОЛЬКО подписи ранга, чтобы она читалась прямо. */
  readonly rotation: Rotation;
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
 *
 * ## Почему разворот страницы не потребовал здесь ни строчки арифметики
 *
 * Рамка лежит ВНУТРИ повёрнутой группы, то есть `x()`/`y()` ноды — это
 * координаты в системе родителя, а не экрана. Konva при перетаскивании
 * присваивает положение через `setAbsolutePosition`, который инвертирует
 * трансформацию родителя сам, — поэтому `onDragEnd` читает уже те самые
 * координаты содержимого, в которых заданы `coords_norm`. Единственное, что
 * пришлось поправить, — подпись ранга: она вращалась вместе с листом.
 */
function BlockShape(props: BlockShapeProps): ReactNode {
  const { block, rank, size, rotation, selected, editable } = props;
  const rect = coordsToRect(block.coords, size);
  const style = BLOCK_STYLES[block.blockType];
  /**
   * Якорь подписи ранга — тот угол рамки, который после разворота окажется
   * верхним левым НА ЭКРАНЕ. Без этого контрповёрнутая подпись уезжала бы за
   * пределы своей рамки на трёх четвертях из четырёх.
   */
  const label =
    rotation === 90
      ? { x: rect.x + 3, y: rect.y + rect.height - 3 }
      : rotation === 180
        ? { x: rect.x + rect.width - 3, y: rect.y + rect.height - 3 }
        : rotation === 270
          ? { x: rect.x + rect.width - 3, y: rect.y + 3 }
          : { x: rect.x + 3, y: rect.y + 3 };

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
        x={label.x}
        y={label.y}
        // Контрповорот: абсолютный угол подписи равен нулю при любом развороте
        // листа. Номер блока — это подпись портала, а не содержимое скана, и
        // читаться он обязан прямо.
        rotation={-rotation}
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
