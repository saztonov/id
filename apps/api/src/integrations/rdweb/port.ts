/**
 * Интерфейс интеграции с RD WEB (§5.1).
 *
 * Домен работает ЧЕРЕЗ этот интерфейс и ничего не знает о том, что сегодня за
 * ним стоит legacy-API без версионирования, без M2M и без REST-статуса у
 * async-детекции. Интерфейс спроектирован под БУДУЩИЙ контракт (техзадание S13):
 * когда появятся bulk-снапшот блоков, M2M и immutable export, меняется
 * реализация, а не задачи конвейера и не репозитории.
 *
 * Отсюда состав методов: он повторяет шаги §5.2 один в один, а не повторяет
 * маршруты сегодняшнего API. `createRunDocument` — это «заведи документ под этот
 * рабочий PDF», а не «вызови upload/init»; `reconcileLayout` — это «приведи
 * удалённый набор блоков к заданному», а не «удали лишние и создай недостающие».
 * Сегодняшняя реализация делает второе, завтрашняя сделает то же самое одним
 * bulk-вызовом, и подпись не изменится.
 *
 * ## Чего в интерфейсе намеренно НЕТ
 *
 * Ни `confidence`, ни `model_id` детектора: их нет в `BlockOut` легаси-API
 * (§0.1, проверено чтением `_blocks_schemas.py`). Поле, которое нечем заполнить,
 * в контракте выглядело бы как обещание.
 *
 * Нет и опроса async-детекции: у `detect_job_id` REST-статуса не существует,
 * прогресс идёт по WebSocket, рассчитанному на UI. Поэтому единственный режим
 * детекции здесь — синхронные постраничные пачки (§5.2, шаг 3).
 */
import type { BlockType, ShapeType } from '@id/contracts';
import type { Readable } from 'node:stream';

/** Блок в терминах удалённой системы. Состав полей — ровно `BlockOut`. */
export interface RemoteBlock {
  readonly blockId: string;
  readonly pageIndex: number;
  readonly blockType: BlockType;
  readonly shapeType: ShapeType;
  /** `[x0, y0, x1, y1]` в 0..1, origin слева-сверху, пост-поворотный фрейм. */
  readonly coordsNorm: readonly [number, number, number, number];
  readonly polygonPoints: readonly (readonly [number, number])[] | null;
  readonly sortOrder: number | null;
  readonly source: 'auto' | 'user';
  readonly status: string;
  readonly version: number;
}

export interface RemotePage {
  readonly pageIndex: number;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly rotation: number | null;
  readonly renderStatus: string;
  readonly hasPreview: boolean;
}

export interface RemoteDocument {
  readonly documentId: string;
  readonly projectId: string;
  readonly status: string;
  readonly pageCount: number | null;
  readonly pages: readonly RemotePage[];
}

export interface EnsureNodeInput {
  /** Проект, которым владеет портал. Ручная работа людей в нём запрещена (§5.1). */
  readonly projectId: string;
  /** Человекочитаемое имя папки прогона. В ключи и пути не попадает. */
  readonly name: string;
  readonly parentNodeId?: string | undefined;
}

export interface CreateRunDocumentInput {
  readonly projectId: string;
  readonly nodeId: string;
  readonly fileName: string;
  /** Метка ревизии на их стороне: у них это обязательное поле загрузки. */
  readonly projectVersion: string;
  readonly sizeBytes: number;
}

export interface CreateRunDocumentResult {
  readonly documentId: string;
  readonly uploadUrl: string;
  readonly uploadHeaders: Readonly<Record<string, string>>;
  readonly maxSizeBytes: number;
}

export interface UploadWorkingPdfInput {
  readonly documentId: string;
  readonly uploadUrl: string;
  readonly uploadHeaders: Readonly<Record<string, string>>;
  readonly body: () => Readable;
  readonly sizeBytes: number;
}

export interface WaitPagesResult {
  readonly ready: boolean;
  readonly document: RemoteDocument;
}

export interface DetectPagesInput {
  readonly documentId: string;
  /**
   * Пачка страниц. Обязательна: детекция всего документа одним вызовом у них
   * упирается в `max_pages_per_call` и отвечает 422 (§5.2, шаг 3).
   */
  readonly pageIndices: readonly number[];
  /**
   * Перезаписывать ли уже размеченные страницы. По умолчанию нет: удалённая
   * сторона вернёт такие страницы в `skippedPages`, и это правильное поведение
   * — повторная детекция не имеет права стирать ручную правку.
   */
  readonly overwriteExisting?: boolean | undefined;
}

export interface DetectPagesResult {
  readonly created: readonly RemoteBlock[];
  readonly skippedPages: readonly number[];
  readonly warnings: readonly string[];
}

/** Желаемое состояние одного блока на удалённой стороне. */
export interface DesiredBlock {
  readonly pageIndex: number;
  readonly blockType: BlockType;
  readonly shapeType: ShapeType;
  readonly coordsNorm: readonly [number, number, number, number];
  readonly polygonPoints: readonly (readonly [number, number])[] | null;
  readonly sortOrder: number;
}

export interface ReconcileLayoutInput {
  readonly documentId: string;
  readonly desired: readonly DesiredBlock[];
}

export interface ReconcileLayoutResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  /** Удалённый набор ПОСЛЕ сверки — вход канонического хэша (§5.2, шаг 5). */
  readonly remote: readonly RemoteBlock[];
}

/**
 * Выбор провайдера, модели и профиля промта на ОДИН тип блока.
 *
 * Это их обязательное поле, а не наше украшение: `JobCreateRequest.settings` —
 * `dict[BlockType, BlockTypeSelection]`, а у `BlockTypeSelection` обязательны
 * `provider_type` и `model_id`. Пустой объект их сервер отвергает 422, поэтому
 * «запустить OCR настройками по умолчанию» невозможно в принципе — выбор
 * обязан прийти из конфигурации портала (§10: промты OCR не редактируются, это
 * профили RD WEB, и портал лишь выбирает профиль на тип блока).
 */
export interface RecognitionSelection {
  readonly blockType: BlockType;
  readonly providerType: string;
  readonly modelId: string;
  /** `undefined` — остаётся authoritative-дефолт их админки. */
  readonly promptProfileId?: string | undefined;
}

export interface StartRecognitionInput {
  readonly documentId: string;
  readonly selections: readonly RecognitionSelection[];
  readonly documentMode: boolean;
  readonly idempotencyKey: string;
}

export interface RecognitionStatus {
  readonly jobId: string;
  readonly status: string;
  readonly totalBlocks: number;
  readonly recognizedBlocks: number;
  readonly failedBlocks: number;
  readonly hasExport: boolean;
  /** Текст отказа их стороны; в журнал идёт как есть, без тела ответа. */
  readonly errorMessage: string | null;
}

/**
 * Терминальные статусы их job'а (`domain/enums.JobStatus`).
 *
 * `completed_with_warnings` — успех: документ собран, а перечень неисполнимых
 * блоков лежит в QA-манифесте. `paused` терминальным НЕ считается: job можно
 * возобновить, и поллинг обязан его дождаться, а не объявить провалом.
 */
export const TERMINAL_RECOGNITION_STATUSES = new Set([
  'done',
  'completed_with_warnings',
  'failed',
  'canceled',
]);

export const SUCCESSFUL_RECOGNITION_STATUSES = new Set(['done', 'completed_with_warnings']);

export interface ExportPayload {
  readonly kind: 'zip';
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Активный результат распознавания одного блока (`BlockResultOut`).
 *
 * Экспорт job'а (`document.md`/`document.html`/`qa_manifest.json`) не содержит
 * ни модели, ни уверенности — а §9.1 прямо требует, чтобы низкая уверенность
 * OCR не давала `fail`. Поэтому провенанс результата читается отдельно, и
 * читается ПОСЛЕ забора экспорта: это не второй экспорт, а read-back.
 */
export interface RemoteBlockResult {
  readonly blockId: string;
  readonly resultId: string;
  readonly resultType: string;
  readonly modelId: string | null;
  readonly confidence: number | null;
  readonly ocrHtml: string | null;
  readonly ocrMarkdown: string | null;
  readonly ocrText: string | null;
  readonly ocrJson: unknown;
}

/**
 * Порт RD WEB.
 *
 * Все методы обязаны быть идемпотентны либо явно одноразовы; `fetchExportOnce`
 * назван так намеренно — §5.2 требует ровно одного забора экспорта.
 */
export interface RdWebPort {
  ensureNode(input: EnsureNodeInput): Promise<{ readonly nodeId: string }>;
  createRunDocument(input: CreateRunDocumentInput): Promise<CreateRunDocumentResult>;
  uploadWorkingPdf(input: UploadWorkingPdfInput): Promise<void>;
  waitPages(documentId: string): Promise<WaitPagesResult>;
  detectPages(input: DetectPagesInput): Promise<DetectPagesResult>;
  listBlocks(documentId: string): Promise<readonly RemoteBlock[]>;
  reconcileLayout(input: ReconcileLayoutInput): Promise<ReconcileLayoutResult>;
  startRecognition(input: StartRecognitionInput): Promise<RecognitionStatus>;
  pollRecognition(jobId: string): Promise<RecognitionStatus>;
  fetchExportOnce(jobId: string): Promise<ExportPayload>;
  /**
   * Активные результаты перечисленных блоков.
   *
   * Множественное число в подписи намеренно: сегодня это N обращений к
   * `GET /api/blocks/{id}/results`, потому что bulk-ручки у них нет. Когда она
   * появится (техзадание S13), изменится реализация, а не вызывающий.
   */
  fetchBlockResults(blockIds: readonly string[]): Promise<readonly RemoteBlockResult[]>;
  /** Превью страницы: нужно только при `PREVIEW_MODE=cached` (§7.1). */
  fetchPagePreview(documentId: string, pageIndex: number): Promise<Uint8Array>;
  closeRunDocument(documentId: string): Promise<void>;
}

/** Отказ внешней системы с сохранённым кодом — чтобы отличать 4xx от 5xx. */
export class RdWebError extends Error {
  readonly status: number | undefined;
  readonly operation: string;

  constructor(
    message: string,
    options: { readonly status?: number | undefined; readonly operation: string },
  ) {
    super(message);
    this.name = 'RdWebError';
    this.status = options.status;
    this.operation = options.operation;
  }

  /**
   * Стоит ли повторять.
   *
   * 4xx (кроме 429) повторять бессмысленно: это отказ по существу запроса, и
   * пять одинаковых попыток дадут пять одинаковых отказов. Повтор оправдан на
   * 5xx, 429 и сетевом сбое — там причина внешняя и преходящая.
   */
  get retriable(): boolean {
    if (this.status === undefined) return true;
    if (this.status === 429) return true;
    return this.status >= 500;
  }
}
