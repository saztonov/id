/**
 * Канва страницы: рамки блоков поверх отрисованной страницы PDF (§7.2).
 *
 * Поддержаны действия §7.2 над рамками: нарисовать, перетащить, растянуть,
 * выделить одну или несколько, сменить тип, удалить. Смена типа и выбор блока
 * списком живут в панели инструментов — здесь то, что делается мышью и
 * клавиатурой по самой странице.
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
 * в панели инструментов лежат выбор блока списком, кнопки типов и удаление, и
 * этот путь полностью клавиатурный. Сама канва помечена `role="application"`,
 * получает фокус (`tabIndex`) и несёт `aria-label`, называющий страницу и число
 * блоков.
 *
 * Собственные клавиши канвы — `Delete`/`Backspace` (удалить выделенное) и
 * `Escape` (снять взвод и выделение) — слушаются НА ОБЁРТКЕ, а не на `window`.
 * Глобальный слушатель срабатывал бы и при наборе текста в полях экрана: рядом
 * живут селект вида ИД и поиск по нему, и `Backspace` в них означает «стереть
 * символ», а не «удалить блок».
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
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
  /**
   * Взведённый тип обводки; `null` — обычный режим, блоки выделяются и правятся.
   *
   * Ровно одно значение вместо прежней пары «инструмент + тип черновика»: два
   * поля на одно решение расходились бы ровно там, где ошибка означает, что
   * человек рисует не тем, что видит на подсвеченной кнопке.
   */
  readonly armedType: BlockType | null;
  readonly editable: boolean;
  readonly workingPageIndex: number;
  readonly onSelect: (blockId: string, additive: boolean) => void;
  readonly onClearSelection: () => void;
  readonly onCreate: (coords: ReturnType<typeof rectToCoords>) => void;
  readonly onMove: (blockId: string, coords: ReturnType<typeof rectToCoords>) => void;
  /** `Delete`/`Backspace` по канве. Подтверждения нет: рамка восстанавливается обводкой. */
  readonly onDeleteSelected: () => void;
  /** `Escape`: снять взвод и выделение разом. */
  readonly onEscape: () => void;
}

/** Сторона квадратика-ручки растягивания в пикселях канвы. */
const HANDLE = 9;

export function PageCanvas(props: PageCanvasProps): ReactNode {
  const { content, rotation, image, blocks, ranks, selection, armedType, editable } = props;
  /** Обводка идёт, только если тип взведён И правка вообще разрешена. */
  const drawing = editable && armedType !== null;
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

  // Снятый взвод убирает незаконченный черновик: иначе пунктирная рамка висела
  // бы поверх листа после `Escape`, а отпускание мыши завело бы блок типом,
  // который уже не выбран.
  useEffect(() => {
    if (armedType !== null) return;
    setDraft(null);
    drawStart.current = null;
  }, [armedType]);

  const pointerOf = (): { x: number; y: number } | null => {
    const position = contentRef.current?.getRelativePointerPosition();
    if (position === undefined || position === null) return null;
    return {
      x: Math.min(Math.max(position.x, 0), content.width),
      y: Math.min(Math.max(position.y, 0), content.height),
    };
  };

  const beginDraw = (): void => {
    if (!drawing) return;
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

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onEscape();
      return;
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (!editable || selection.size === 0) return;
    // `Backspace` в браузере без этого уводит на предыдущую страницу истории.
    event.preventDefault();
    props.onDeleteSelected();
  };

  return (
    <div
      role="application"
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Фокус ставится щелчком: без него клавиши канвы работали бы только после
      // обхода табом, то есть у человека с мышью — никогда.
      onPointerDown={(event) => {
        event.currentTarget.focus({ preventScroll: true });
      }}
      aria-label={`Страница ${String(props.workingPageIndex + 1)}, блоков: ${String(blocks.length)}. Рамки блоков правятся мышью, Delete удаляет выделенное; тот же набор доступен с клавиатуры в панели над страницей.${rotationNote}`}
      style={{ width: stage.width, height: stage.height, position: 'relative', outlineOffset: 2 }}
    >
      <Stage
        width={stage.width}
        height={stage.height}
        onPointerDown={(event: Konva.KonvaEventObject<PointerEvent>) => {
          if (drawing) {
            beginDraw();
            return;
          }
          // Щелчок по пустому месту снимает выделение: иначе кнопка типа однажды
          // сработает по забытому выделению вместо взвода обводки.
          if (event.target === event.target.getStage()) props.onClearSelection();
        }}
        onPointerMove={extendDraw}
        onPointerUp={finishDraw}
        style={{ cursor: drawing ? 'crosshair' : 'default' }}
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
                editable={editable && !drawing}
                drawing={drawing}
                onSelect={props.onSelect}
                onMove={props.onMove}
              />
            ))}
            {draft !== null && armedType !== null && (
              <Rect
                x={draft.x}
                y={draft.y}
                width={draft.width}
                height={draft.height}
                stroke={BLOCK_STYLES[armedType].stroke}
                fill={BLOCK_STYLES[armedType].fill}
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
  /** Взведена ли обводка: тогда рамка не перехватывает указатель вовсе. */
  readonly drawing: boolean;
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
  const { block, rank, size, rotation, selected, editable, drawing } = props;
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
        /*
          При взведённой обводке рамка не слушает указатель ВОВСЕ.

          Прежде `cancelBubble` стоял безусловно, и это молча запрещало обводить
          блок поверх существующего: щелчок внутри чужой рамки не доходил до
          сцены, то есть вместо начала обводки происходило выделение. На плотной
          странице свободного места под новый блок может не быть вообще, и
          человек упирался в «рисование не работает» без единого признака причины.
        */
        listening={!drawing}
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
