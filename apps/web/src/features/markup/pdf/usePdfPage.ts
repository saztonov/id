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
 */
import { useEffect, useState } from 'react';
import { openDocument, SAFE_ANNOTATION_MODE } from './pdfjs.js';
import type { RenderedSize } from '../geometry.js';

export interface RenderedPdfPage {
  readonly canvas: HTMLCanvasElement;
  /** Размер в координатах канвы (CSS-пиксели), без множителя плотности. */
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
  /** Целевая ширина отрисовки в CSS-пикселях. */
  readonly targetWidth: number;
}

export interface PdfPageState {
  readonly page: RenderedPdfPage | null;
  readonly loading: boolean;
  readonly error: unknown;
}

/** Потолок плотности: на 3x странице A3 канва занимает больше 100 МБ. */
const MAX_PIXEL_RATIO = 2;

export function usePdfPage(request: PdfPageRequest | null): PdfPageState {
  const [state, setState] = useState<PdfPageState>({ page: null, loading: false, error: null });

  const fileId = request?.fileId ?? null;
  const contentUrl = request?.contentUrl ?? null;
  const filePageIndex = request?.filePageIndex ?? null;
  const targetWidth = request?.targetWidth ?? 0;

  useEffect(() => {
    if (fileId === null || contentUrl === null || filePageIndex === null || targetWidth <= 0) {
      setState({ page: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    const run = async (): Promise<void> => {
      try {
        const document = await openDocument(fileId, contentUrl);
        if (cancelled) return;
        // pdf.js нумерует страницы с единицы, карта страниц портала — с нуля.
        const page = await document.getPage(filePageIndex + 1);
        if (cancelled) return;

        // Вьюпорт без явного `rotation`: значение берётся из самой страницы, и
        // фрейм получается пост-поворотным — тем же, в котором заданы
        // `coords_norm` (см. `geometry.ts`).
        const natural = page.getViewport({ scale: 1 });
        const scale = targetWidth / natural.width;
        const viewport = page.getViewport({ scale });

        const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        const context = canvas.getContext('2d');
        if (context === null)
          throw new Error('Браузер не выдал контекст 2d для отрисовки страницы');
        context.scale(ratio, ratio);

        const task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          // Аннотации не исполняются и не рисуются: см. `pdfjs.ts`.
          annotationMode: SAFE_ANNOTATION_MODE,
        });
        renderTask = task;
        await task.promise;
        if (cancelled) return;

        setState({
          page: {
            canvas,
            size: { width: viewport.width, height: viewport.height },
            naturalSize: { width: natural.width, height: natural.height },
            rotation: page.rotate,
          },
          loading: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        // Отменённый рендер — не отказ: пользователь просто пролистнул дальше.
        if (error instanceof Error && error.name === 'RenderingCancelledException') return;
        setState({ page: null, loading: false, error });
      }
    };

    void run();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [fileId, contentUrl, filePageIndex, targetWidth]);

  return state;
}
