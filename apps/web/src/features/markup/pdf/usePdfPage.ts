/**
 * Рендер одной страницы PDF в изображение для канвы (§7.1).
 *
 * Отдаётся именно `HTMLCanvasElement`, а не data URL: Konva умеет рисовать
 * канву как изображение напрямую, а превращение в base64 удваивало бы память на
 * каждой странице скана.
 *
 * Отмена обязательна. Пользователь листает ленту миниатюр быстрее, чем
 * рендерится страница A3, и без отмены предыдущего `RenderTask` в канву успевает
 * записаться ПРЕДЫДУЩАЯ страница поверх текущей — рамки при этом остаются от
 * текущей. Дефект выглядит как «координаты не совпадают», хотя пересчёт верен.
 *
 * ## Разрешение рендера отвязано от размера показа
 *
 * Ширина рендера считается квантованием ширины показа — почему именно так,
 * описано в `render-width.ts`. Здесь важно следствие: пока `renderWidthFor` не
 * изменилась, страница не перерисовывается и берётся из кэша.
 *
 * ## Кэш отрисованных страниц
 *
 * Без него возврат на просмотренную страницу стоил столько же, сколько первый
 * заход: состояние хранилось в `useState` одного хука и терялось при смене
 * страницы. На комплекте в 83 страницы это и было замечено как «долго грузятся
 * страницы при переключении».
 *
 * Кэш общий на модуль, а не на хук: предзагрузка соседней страницы (`prefetchPage`)
 * обязана класть результат туда же, откуда его возьмёт хук, иначе она была бы
 * работой впустую. Вытеснение — по давности использования, с двумя потолками
 * сразу: по числу записей и по памяти. Одного потолка по числу мало — страница
 * A3 при масштабе 300 % занимает десятки мегабайт, и «десять страниц» означало
 * бы от сотни мегабайт до полугигабайта в зависимости от того, что открыли.
 */
import { useEffect, useState } from 'react';
import { openDocument, SAFE_ANNOTATION_MODE } from './pdfjs.js';
import { renderWidthFor } from './render-width.js';
import type { RenderedSize } from '../geometry.js';

export interface RenderedPdfPage {
  readonly canvas: HTMLCanvasElement;
  /** Размер канвы в CSS-пикселях, без множителя плотности. НЕ размер показа. */
  readonly size: RenderedSize;
  /** Пост-поворотный размер страницы при масштабе 1: сверяется с картой страниц. */
  readonly naturalSize: RenderedSize;
  readonly rotation: number;
}

export interface PdfPageRequest {
  readonly fileId: string;
  readonly contentUrl: string;
  /** Индекс страницы в файле, 0-based — как в `processing_bundle_pages`. */
  readonly filePageIndex: number;
  /** Ширина показа в CSS-пикселях; ширина рендера считается из неё квантованием. */
  readonly displayWidth: number;
}

export interface PdfPageState {
  readonly page: RenderedPdfPage | null;
  readonly loading: boolean;
  readonly error: unknown;
}

/** Потолок плотности: на 3x странице A3 канва занимает больше 100 МБ. */
const MAX_PIXEL_RATIO = 2;

/**
 * Потолок пикселей канвы.
 *
 * Ограничивается площадь, а не ширина: у альбомной A3 и у портретной A4 при
 * одной ширине разница по памяти двукратная. 24 мегапикселя — это ~96 МБ
 * (RGBA), выше начинается отказ выделения канвы в браузере, а не медленный
 * рендер. Превышение гасится понижением плотности, а не обрезкой изображения:
 * потерять резкость на трёхкратном масштабе допустимо, потерять страницу — нет.
 */
const MAX_CANVAS_PIXELS = 24_000_000;

/** Потолки кэша: записи и суммарная память канв. */
const CACHE_MAX_ENTRIES = 12;
const CACHE_MAX_BYTES = 192 * 1024 * 1024;

/**
 * Кэш отрисованных страниц. `Map` хранит порядок вставки, поэтому давность
 * использования выражается перекладыванием записи в конец при каждом чтении, а
 * вытесняется всегда первая — без отдельной структуры.
 */
const rendered = new Map<string, RenderedPdfPage>();
/** Незавершённые рендеры: два запроса одного ключа не должны рисовать дважды. */
const inFlight = new Map<string, Promise<RenderedPdfPage>>();
let renderedBytes = 0;

function bytesOf(page: RenderedPdfPage): number {
  return page.canvas.width * page.canvas.height * 4;
}

function keyOf(fileId: string, filePageIndex: number, renderWidth: number): string {
  return `${fileId}:${String(filePageIndex)}:${String(renderWidth)}`;
}

function takeFromCache(key: string): RenderedPdfPage | undefined {
  const hit = rendered.get(key);
  if (hit === undefined) return undefined;
  // Перекладывание в конец — это и есть отметка «использовано только что».
  rendered.delete(key);
  rendered.set(key, hit);
  return hit;
}

function putInCache(key: string, page: RenderedPdfPage): void {
  const existing = rendered.get(key);
  if (existing !== undefined) {
    renderedBytes -= bytesOf(existing);
    rendered.delete(key);
  }
  rendered.set(key, page);
  renderedBytes += bytesOf(page);

  while (rendered.size > CACHE_MAX_ENTRIES || renderedBytes > CACHE_MAX_BYTES) {
    const oldest = rendered.keys().next();
    if (oldest.done === true) break;
    // Самая давняя запись никогда не должна вытеснить только что положенную:
    // иначе при одной странице крупнее потолка кэш опустошал бы сам себя в
    // цикле и каждый показ шёл бы мимо него.
    if (oldest.value === key) break;
    const victim = rendered.get(oldest.value);
    if (victim !== undefined) renderedBytes -= bytesOf(victim);
    rendered.delete(oldest.value);
  }
}

/** Освобождение кэша страниц: зовётся вместе с закрытием документов. */
export function clearPageCache(): void {
  rendered.clear();
  inFlight.clear();
  renderedBytes = 0;
}

interface RenderInput {
  readonly fileId: string;
  readonly contentUrl: string;
  readonly filePageIndex: number;
  readonly renderWidth: number;
}

async function renderToCanvas(input: RenderInput): Promise<RenderedPdfPage> {
  const document = await openDocument(input.fileId, input.contentUrl);
  // pdf.js нумерует страницы с единицы, карта страниц портала — с нуля.
  const page = await document.getPage(input.filePageIndex + 1);

  // Вьюпорт без явного `rotation`: значение берётся из самой страницы, и
  // фрейм получается пост-поворотным — тем же, в котором заданы
  // `coords_norm` (см. `geometry.ts`).
  const natural = page.getViewport({ scale: 1 });
  const scale = input.renderWidth / natural.width;
  const viewport = page.getViewport({ scale });

  const deviceRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const area = viewport.width * viewport.height;
  const ratioCap = area > 0 ? Math.sqrt(MAX_CANVAS_PIXELS / area) : deviceRatio;
  const ratio = Math.max(0.5, Math.min(deviceRatio, ratioCap));

  const canvas = window.document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Браузер не выдал контекст 2d для отрисовки страницы');
  context.scale(ratio, ratio);

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
    // Аннотации не исполняются и не рисуются: см. `pdfjs.ts`.
    annotationMode: SAFE_ANNOTATION_MODE,
  }).promise;

  return {
    canvas,
    size: { width: viewport.width, height: viewport.height },
    naturalSize: { width: natural.width, height: natural.height },
    rotation: page.rotate,
  };
}

/**
 * Страница из кэша либо новый рендер.
 *
 * Отмена здесь намеренно отсутствует. Прерванный на середине `RenderTask`
 * оставил бы в кэше наполовину закрашенную канву, и следующий заход показал бы
 * её как готовую — дефект, который выглядит как «страница обрезана».
 * Пользовательскую отмену держит хук: он игнорирует результат, а не рендер.
 */
function renderCached(input: RenderInput): Promise<RenderedPdfPage> {
  const key = keyOf(input.fileId, input.filePageIndex, input.renderWidth);
  const hit = takeFromCache(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const running = inFlight.get(key);
  if (running !== undefined) return running;

  const task = renderToCanvas(input)
    .then((page) => {
      putInCache(key, page);
      return page;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
}

/**
 * Предзагрузка следующей страницы в кэш.
 *
 * Ленту листают подряд, и кэш сам по себе ускоряет только возврат назад: вперёд
 * каждая страница всё равно рисуется впервые. Предзагрузка убирает ожидание и
 * там — за счёт времени, которое воркер pdf.js всё равно простаивает, пока
 * человек смотрит на текущую страницу.
 *
 * Отказ проглатывается: это работа на упреждение, и её неудача не должна ни
 * попадать на экран, ни оставлять необработанное отклонение. Настоящий переход
 * на эту страницу повторит рендер и покажет отказ честно.
 */
export function prefetchPage(input: RenderInput): void {
  void renderCached(input).catch(() => undefined);
}

export function usePdfPage(request: PdfPageRequest | null): PdfPageState {
  const [state, setState] = useState<PdfPageState>({ page: null, loading: false, error: null });

  const fileId = request?.fileId ?? null;
  const contentUrl = request?.contentUrl ?? null;
  const filePageIndex = request?.filePageIndex ?? null;
  const displayWidth = request?.displayWidth ?? 0;
  // Ширина рендера входит в зависимости эффекта вместо ширины показа: смена
  // масштаба внутри одной ступени не обязана ничего перерисовывать.
  const renderWidth = displayWidth > 0 ? renderWidthFor(displayWidth) : 0;

  useEffect(() => {
    if (fileId === null || contentUrl === null || filePageIndex === null || renderWidth <= 0) {
      setState({ page: null, loading: false, error: null });
      return;
    }

    const key = keyOf(fileId, filePageIndex, renderWidth);
    const hit = takeFromCache(key);
    if (hit !== undefined) {
      // Синхронно, без промежуточного `loading`: мигание спиннера на готовой
      // странице читается как «грузится», хотя не грузится ничего.
      setState({ page: hit, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    renderCached({ fileId, contentUrl, filePageIndex, renderWidth })
      .then((page) => {
        if (cancelled) return;
        setState({ page, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ page: null, loading: false, error });
      });

    return () => {
      cancelled = true;
    };
  }, [fileId, contentUrl, filePageIndex, renderWidth]);

  return state;
}
