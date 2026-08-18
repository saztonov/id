/**
 * `LegacyRdWebAdapter` — реализация порта §5.1 поверх СЕГОДНЯШНЕГО API RD WEB.
 *
 * Каждое отступление от «как хотелось бы» здесь имеет проверенную причину и
 * попадает в техзадание S13:
 *
 * 1. **Детекция синхронная и постраничными пачками.** У async-режима нет
 *    REST-статуса: `detect_job_id` документирован, но роута опроса не
 *    существует, прогресс идёт по WebSocket для UI. Синхронный вызов принимает
 *    `page_indices` и возвращает `created: list[BlockOut]` прямо в ответе.
 * 2. **`full-page-text` не используется адаптером вовсе.** Он удаляет прежние
 *    блоки страницы (`blocks_bulk.py`), поэтому полностраничная замена — это
 *    явное действие пользователя в портале, а не шаг конвейера.
 * 3. **Провенанс вместо уверенности.** `BlockOut` не содержит ни `confidence`,
 *    ни `model_id`, поэтому импортируемые блоки получают `rf_detr` как факт
 *    происхождения, а не выдуманное число.
 * 4. **Сверка поштучная.** Bulk-снапшота с `expected_revision` у них нет,
 *    поэтому `reconcileLayout` удаляет лишние блоки и создаёт недостающие по
 *    одному. Частичный сбой безопасен: цикл повторяется до совпадения хэшей
 *    (§5.2, шаг 5), а не полагается на атомарность.
 */
import type { BlockType, ShapeType } from '@id/contracts';
import { RdWebClient, type RdWebClientOptions } from './client.js';
import {
  RdWebError,
  type CreateRunDocumentInput,
  type CreateRunDocumentResult,
  type DesiredBlock,
  type DetectPagesInput,
  type DetectPagesResult,
  type EnsureNodeInput,
  type ExportPayload,
  type RdWebPort,
  type RecognitionStatus,
  type ReconcileLayoutInput,
  type ReconcileLayoutResult,
  type RemoteBlock,
  type RemoteDocument,
  type StartRecognitionInput,
  type UploadWorkingPdfInput,
  type WaitPagesResult,
} from './port.js';

/**
 * Потолок страниц на один синхронный вызов детекции.
 *
 * §5.2 называет 5–10; берётся 8. Их сервер отвечает 422 при превышении
 * СВОЕГО потолка (`settings.detection.max_pages_per_call`), который нам
 * неизвестен, поэтому пачка выбирается заведомо меньше любого разумного
 * значения. Разбиение всё равно делает вызывающий (`layout.detect_pages`
 * ставит по задаче на пачку), а здесь стоит защита от вызова с сотней страниц.
 */
export const DETECT_BATCH_LIMIT = 8;

interface RawBlock {
  block_id: string;
  page_index: number;
  block_type: string;
  shape_type: string;
  coords_norm: number[];
  polygon_points?: number[][] | null;
  sort_order?: number | null;
  source: string;
  status: string;
  version: number;
}

interface RawPage {
  page_index: number;
  width_px?: number | null;
  height_px?: number | null;
  rotation?: number | null;
  render_status: string;
  has_preview: boolean;
}

interface RawDocument {
  document_id: string;
  project_id: string;
  status: string;
  page_count?: number | null;
  pages: RawPage[];
}

interface RawJob {
  job_id: string;
  status: string;
  total_blocks: number;
  recognized_blocks: number;
  failed_blocks: number;
  has_export: boolean;
}

function toBlockType(value: string, operation: string): BlockType {
  if (value === 'text' || value === 'image' || value === 'stamp') return value;
  throw new RdWebError(`RD WEB вернул неизвестный тип блока «${value}»`, { operation });
}

function toShapeType(value: string, operation: string): ShapeType {
  if (value === 'rectangle' || value === 'polygon') return value;
  throw new RdWebError(`RD WEB вернул неизвестную форму блока «${value}»`, { operation });
}

/**
 * Приведение блока их формы к нашей.
 *
 * Координаты проверяются здесь, а не при записи в БД: CHECK в `layout_blocks`
 * тоже их отвергнет, но сообщением про нарушение ограничения, из которого не
 * видно, что виновата внешняя система.
 */
function toRemoteBlock(raw: RawBlock, operation: string): RemoteBlock {
  const c = raw.coords_norm;
  if (c.length !== 4) {
    throw new RdWebError(`RD WEB вернул coords_norm длиной ${c.length}, ожидалось 4`, {
      operation,
    });
  }
  const [x0, y0, x1, y1] = c as [number, number, number, number];
  const inRange = [x0, y0, x1, y1].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
  if (!inRange || x0 > x1 || y0 > y1) {
    throw new RdWebError(
      `RD WEB вернул блок с недопустимой геометрией на странице ${raw.page_index}`,
      { operation },
    );
  }
  return {
    blockId: raw.block_id,
    pageIndex: raw.page_index,
    blockType: toBlockType(raw.block_type, operation),
    shapeType: toShapeType(raw.shape_type, operation),
    coordsNorm: [x0, y0, x1, y1],
    polygonPoints:
      raw.polygon_points === undefined || raw.polygon_points === null
        ? null
        : raw.polygon_points.map((point) => [point[0] ?? 0, point[1] ?? 0] as const),
    sortOrder: raw.sort_order ?? null,
    source: raw.source === 'user' ? 'user' : 'auto',
    status: raw.status,
    version: raw.version,
  };
}

function toRemoteDocument(raw: RawDocument): RemoteDocument {
  return {
    documentId: raw.document_id,
    projectId: raw.project_id,
    status: raw.status,
    pageCount: raw.page_count ?? null,
    pages: (raw.pages ?? []).map((page) => ({
      pageIndex: page.page_index,
      widthPx: page.width_px ?? null,
      heightPx: page.height_px ?? null,
      rotation: page.rotation ?? null,
      renderStatus: page.render_status,
      hasPreview: page.has_preview,
    })),
  };
}

/** Ключ сравнения желаемого и удалённого блока: геометрия и тип, но не id. */
function blockKey(input: {
  pageIndex: number;
  blockType: string;
  shapeType: string;
  coordsNorm: readonly number[];
  polygonPoints: readonly (readonly number[])[] | null;
}): string {
  const coords = input.coordsNorm.map((value) => value.toFixed(6)).join(',');
  const points = (input.polygonPoints ?? [])
    .map((point) => `${(point[0] ?? 0).toFixed(6)}:${(point[1] ?? 0).toFixed(6)}`)
    .join(';');
  return [input.pageIndex, input.blockType, input.shapeType, coords, points].join('|');
}

export interface LegacyRdWebAdapterOptions extends RdWebClientOptions {
  /** Проект RD WEB, которым владеет портал (`RDWEB_PROJECT_ALLOWLIST`, §5.1). */
  readonly projectId: string;
}

export class LegacyRdWebAdapter implements RdWebPort {
  readonly #client: RdWebClient;
  readonly #projectId: string;

  constructor(options: LegacyRdWebAdapterOptions) {
    this.#client = new RdWebClient(options);
    this.#projectId = options.projectId;
  }

  get projectId(): string {
    return this.#projectId;
  }

  async ensureNode(input: EnsureNodeInput): Promise<{ readonly nodeId: string }> {
    // Идемпотентности «создай папку с этим именем» у них нет: узлы адресуются
    // сгенерированным id, а не путём. Поэтому сначала читаем дерево — иначе
    // повторный запуск задачи плодил бы одноимённые папки прогонов.
    const tree = await this.#client.request<{ node_id: string; name: string; kind: string }[]>({
      method: 'GET',
      path: '/api/projects/tree',
      operation: 'tree_read',
      query: { project_id: input.projectId },
    });
    const existing = tree.body.find((item) => item.kind === 'node' && item.name === input.name);
    if (existing !== undefined) return { nodeId: existing.node_id };

    const created = await this.#client.request<{ node_id: string }>({
      method: 'POST',
      path: '/api/projects/nodes',
      operation: 'node_create',
      body: {
        project_id: input.projectId,
        node_type: 'folder',
        name: input.name,
        ...(input.parentNodeId !== undefined ? { parent_id: input.parentNodeId } : {}),
      },
    });
    return { nodeId: created.body.node_id };
  }

  async createRunDocument(input: CreateRunDocumentInput): Promise<CreateRunDocumentResult> {
    const response = await this.#client.request<{
      document_id: string;
      upload_url: string;
      required_headers: Record<string, string>;
      max_size_bytes: number;
    }>({
      method: 'POST',
      path: '/api/documents/upload/init',
      operation: 'upload_init',
      body: {
        project_id: input.projectId,
        node_id: input.nodeId,
        file_name: input.fileName,
        project_version: input.projectVersion,
        size_bytes: input.sizeBytes,
        content_type: 'application/pdf',
      },
    });
    return {
      documentId: response.body.document_id,
      uploadUrl: response.body.upload_url,
      uploadHeaders: response.body.required_headers,
      maxSizeBytes: response.body.max_size_bytes,
    };
  }

  async uploadWorkingPdf(input: UploadWorkingPdfInput): Promise<void> {
    await this.#client.putStream({
      url: input.uploadUrl,
      headers: input.uploadHeaders,
      body: input.body,
      sizeBytes: input.sizeBytes,
    });
    await this.#client.request<unknown>({
      method: 'POST',
      path: '/api/documents/upload/complete',
      operation: 'upload_complete',
      body: { document_id: input.documentId },
    });
  }

  /**
   * Один опрос готовности страниц, а не ожидание внутри вызова.
   *
   * Ждать здесь нельзя: рендер 83-страничного комплекта идёт минутами, и цикл
   * внутри адаптера означал бы задачу, которая держит аренду и соединение всё
   * это время. Поллинг ведёт задача `rd.wait_pages` штатным переносом на
   * следующую попытку — тогда прогресс виден в `job_runs`, а не в стеке.
   */
  async waitPages(documentId: string): Promise<WaitPagesResult> {
    const response = await this.#client.request<RawDocument>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}`,
      operation: 'document_read',
    });
    const document = toRemoteDocument(response.body);
    const ready =
      document.pages.length > 0 &&
      document.pages.every((page) => page.renderStatus === 'ready') &&
      (document.pageCount === null || document.pages.length === document.pageCount);
    return { ready, document };
  }

  async detectPages(input: DetectPagesInput): Promise<DetectPagesResult> {
    if (input.pageIndices.length === 0) {
      return { created: [], skippedPages: [], warnings: [] };
    }
    if (input.pageIndices.length > DETECT_BATCH_LIMIT) {
      throw new RdWebError(
        `Пачка детекции ${input.pageIndices.length} страниц превышает предел ${DETECT_BATCH_LIMIT}`,
        { operation: 'detect_blocks' },
      );
    }

    const response = await this.#client.request<{
      created: RawBlock[];
      skipped_pages: number[];
      warnings: string[];
    }>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(input.documentId)}/detect-blocks`,
      operation: 'detect_blocks',
      body: {
        page_indices: [...input.pageIndices],
        overwrite_existing: input.overwriteExisting ?? false,
        // Явное `false`: async-режим не используется никогда, потому что
        // опросить его статус по REST нечем.
        async_mode: false,
      },
    });

    return {
      created: response.body.created.map((raw) => toRemoteBlock(raw, 'detect_blocks')),
      skippedPages: response.body.skipped_pages ?? [],
      warnings: response.body.warnings ?? [],
    };
  }

  async listBlocks(documentId: string): Promise<readonly RemoteBlock[]> {
    const response = await this.#client.request<{ blocks: RawBlock[] }>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}/blocks`,
      operation: 'blocks_list',
    });
    return response.body.blocks.map((raw) => toRemoteBlock(raw, 'blocks_list'));
  }

  /**
   * Цикл сверки §5.2, шаг 5, за один проход.
   *
   * Сначала удаление лишнего, потом создание недостающего: обратный порядок на
   * документе с сотней блоков временно удвоил бы их число, а у них на каждый
   * блок пишется строка истории и аудита.
   *
   * Совпадение ищется по геометрии, а не по идентификатору: локальный id блока
   * удалённой стороне неизвестен, а `client_id` она возвращает только в ответе
   * на create и нигде не хранит.
   */
  async reconcileLayout(input: ReconcileLayoutInput): Promise<ReconcileLayoutResult> {
    const remote = await this.listBlocks(input.documentId);

    const desiredByKey = new Map<string, DesiredBlock[]>();
    for (const block of input.desired) {
      const key = blockKey(block);
      const list = desiredByKey.get(key);
      if (list === undefined) desiredByKey.set(key, [block]);
      else list.push(block);
    }

    const keep = new Set<string>();
    let deleted = 0;
    for (const block of remote) {
      const key = blockKey(block);
      const wanted = desiredByKey.get(key);
      if (wanted !== undefined && wanted.length > 0) {
        wanted.pop();
        keep.add(block.blockId);
        continue;
      }
      await this.#client.request<unknown>({
        method: 'DELETE',
        path: `/api/blocks/${encodeURIComponent(block.blockId)}`,
        operation: 'block_delete',
        query: { expected_version: block.version },
        // 409 означает, что блок изменился между чтением и удалением. Это не
        // отказ прогона: следующий проход цикла перечитает набор.
        expect: [409],
      });
      deleted += 1;
    }

    let created = 0;
    for (const [, blocks] of desiredByKey) {
      for (const block of blocks) {
        await this.#client.request<RawBlock>({
          method: 'POST',
          path: `/api/documents/${encodeURIComponent(input.documentId)}/blocks`,
          operation: 'block_create',
          body: {
            page_index: block.pageIndex,
            block_type: block.blockType,
            shape_type: block.shapeType,
            coords_norm: [...block.coordsNorm],
            ...(block.polygonPoints !== null
              ? { polygon_points: block.polygonPoints.map((point) => [...point]) }
              : {}),
          },
        });
        created += 1;
      }
    }

    return { created, updated: 0, deleted, remote: await this.listBlocks(input.documentId) };
  }

  async startRecognition(input: StartRecognitionInput): Promise<RecognitionStatus> {
    const settings = Object.fromEntries(input.blockTypes.map((type) => [type, { enabled: true }]));
    const response = await this.#client.request<{ job: RawJob }>({
      method: 'POST',
      path: '/api/jobs',
      operation: 'job_create',
      body: {
        document_id: input.documentId,
        scope: 'document',
        settings,
        document_mode: input.documentMode,
        idempotency_key: input.idempotencyKey,
      },
    });
    return toStatus(response.body.job);
  }

  async pollRecognition(jobId: string): Promise<RecognitionStatus> {
    const response = await this.#client.request<RawJob>({
      method: 'GET',
      path: `/api/jobs/${encodeURIComponent(jobId)}`,
      operation: 'job_read',
    });
    return toStatus(response.body);
  }

  async fetchExportOnce(jobId: string): Promise<ExportPayload> {
    const response = await this.#client.request<Uint8Array>({
      method: 'GET',
      path: `/api/exports/jobs/${encodeURIComponent(jobId)}/zip`,
      operation: 'export_fetch',
      binary: true,
    });
    return { kind: 'zip', bytes: response.body, contentType: 'application/zip' };
  }

  async fetchPagePreview(documentId: string, pageIndex: number): Promise<Uint8Array> {
    const response = await this.#client.request<Uint8Array>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}/pages/${pageIndex}/preview`,
      operation: 'page_preview',
      binary: true,
    });
    return response.body;
  }

  /**
   * Закрытие RD-документа со стороны портала.
   *
   * Настоящего «закрыть документ» у RD WEB нет — есть только удаление, а удалять
   * нельзя: экспорт и блоки прогона остаются доказательством того, что именно
   * распознавали. Поэтому закрытие фиксируется у НАС (`rd_run_documents.closed_at`),
   * а здесь остаётся проверка достижимости: закрывать документ, которого уже нет,
   * бессмысленно и об этом надо знать. Требование настоящего закрытия — в
   * техзадании S13.
   */
  async closeRunDocument(documentId: string): Promise<void> {
    await this.#client.request<RawDocument>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}`,
      operation: 'document_close_probe',
      expect: [404],
    });
  }
}

function toStatus(job: RawJob): RecognitionStatus {
  return {
    jobId: job.job_id,
    status: job.status,
    totalBlocks: job.total_blocks,
    recognizedBlocks: job.recognized_blocks,
    failedBlocks: job.failed_blocks,
    hasExport: job.has_export,
  };
}
