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
  type RemoteBlockResult,
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
  error_message?: string | null;
}

/** `_blocks_schemas.BlockResultOut` — только поля, которые портал хранит. */
interface RawBlockResult {
  result_id: string;
  block_id: string;
  result_type: string;
  model_id?: string | null;
  confidence?: number | null;
  ocr_html?: string | null;
  ocr_text?: string | null;
  ocr_markdown?: string | null;
  ocr_json?: unknown;
  is_active?: boolean;
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

/**
 * Группа порядка чтения: страница × тип блока.
 *
 * Та же ось, что у `_next_sort_order` в их `_blocks_helpers.py`, и та же, по
 * которой канонический хэш считает ранг (`layout.ts`). Совпадение осей —
 * несущее: сверка приводит к нужному виду ИМЕННО группу, и ранг после этого
 * совпадает у обеих сторон без единого дополнительного вызова.
 */
function groupKey(pageIndex: number, blockType: string): string {
  return `${pageIndex}|${blockType}`;
}

function groupOf<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const list = groups.get(value);
    if (list === undefined) groups.set(value, [item]);
    else list.push(item);
  }
  return groups;
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
   * Цикл сверки §5.2, шаг 5, за один проход — по группам «страница × тип».
   *
   * ## Почему группами, а не поблочно
   *
   * Совпасть обязан не только НАБОР блоков, но и порядок чтения внутри группы:
   * он входит в канонический хэш (рангом, см. `computeBlocksHash`). А `sort_order`
   * на их стороне назначает их сервер: create даёт max+1 в группе, PATCH его не
   * трогает вовсе, нашего значения не принимает ни тот, ни другой. Значит
   * управлять порядком можно только ПОСЛЕДОВАТЕЛЬНОСТЬЮ операций внутри группы,
   * а для этого группу надо рассматривать целиком.
   *
   * Отсюда правило прохода по каждой группе:
   *
   * - позиции, которые есть с обеих сторон, приводятся PATCH'ем с
   *   `expected_version` — их `sort_order` остаётся прежним, значит и ранг тоже;
   * - хвост удалённой группы (её длиннее нашей) удаляется — у оставшихся
   *   `sort_order` не меняется;
   * - хвост нашей группы создаётся В ПОРЯДКЕ ВОЗРАСТАНИЯ — их сервер выдаёт
   *   max+1, то есть дописывает ровно в конец и ровно в нашем порядке.
   *
   * После такого прохода плотный ранг совпадает у обеих сторон по построению.
   *
   * Идентичные позиции не трогаются вовсе: PATCH сбрасывает `status` и
   * `active_result_id` блока, и переписывать неизменившуюся геометрию значило бы
   * обнулять результаты прошлого прогона на ровном месте.
   *
   * Частичный сбой безопасен: следующий проход перечитывает удалённый набор и
   * доводит его до того же состояния — никакой операции «продолжить с середины»
   * здесь нет по построению.
   */
  async reconcileLayout(input: ReconcileLayoutInput): Promise<ReconcileLayoutResult> {
    const remote = await this.listBlocks(input.documentId);

    const desiredGroups = groupOf([...input.desired], (block) =>
      groupKey(block.pageIndex, block.blockType),
    );
    const remoteGroups = groupOf([...remote], (block) =>
      groupKey(block.pageIndex, block.blockType),
    );

    let created = 0;
    let updated = 0;
    let deleted = 0;

    for (const key of new Set([...desiredGroups.keys(), ...remoteGroups.keys()])) {
      const desired = [...(desiredGroups.get(key) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
      // Тай-брейк по геометрии — тот же, что в каноническом ранге: без него две
      // позиции с равным `sort_order` сопоставлялись бы порядком выдачи.
      const current = [...(remoteGroups.get(key) ?? [])].sort(
        (a, b) =>
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
          blockKey(a).localeCompare(blockKey(b)) ||
          a.blockId.localeCompare(b.blockId),
      );

      const shared = Math.min(desired.length, current.length);
      for (let index = 0; index < shared; index += 1) {
        const want = desired[index];
        const have = current[index];
        if (want === undefined || have === undefined) continue;
        if (blockKey(want) === blockKey(have)) continue;
        await this.#patchBlock(have, want);
        updated += 1;
      }

      for (let index = desired.length; index < current.length; index += 1) {
        const extra = current[index];
        if (extra === undefined) continue;
        await this.#deleteBlock(extra);
        deleted += 1;
      }

      for (let index = current.length; index < desired.length; index += 1) {
        const missing = desired[index];
        if (missing === undefined) continue;
        await this.#createBlock(input.documentId, missing);
        created += 1;
      }
    }

    return { created, updated, deleted, remote: await this.listBlocks(input.documentId) };
  }

  async #patchBlock(current: RemoteBlock, desired: DesiredBlock): Promise<void> {
    await this.#client.request<RawBlock>({
      method: 'PATCH',
      path: `/api/blocks/${encodeURIComponent(current.blockId)}`,
      operation: 'block_update',
      body: {
        expected_version: current.version,
        block_type: desired.blockType,
        shape_type: desired.shapeType,
        coords_norm: [...desired.coordsNorm],
        ...(desired.polygonPoints !== null
          ? { polygon_points: desired.polygonPoints.map((point) => [...point]) }
          : {}),
      },
      // 409 означает, что блок изменился между чтением и правкой. Это не отказ
      // прогона: следующий проход цикла перечитает набор.
      expect: [409],
    });
  }

  async #deleteBlock(block: RemoteBlock): Promise<void> {
    await this.#client.request<unknown>({
      method: 'DELETE',
      path: `/api/blocks/${encodeURIComponent(block.blockId)}`,
      operation: 'block_delete',
      query: { expected_version: block.version },
      expect: [409],
    });
  }

  async #createBlock(documentId: string, block: DesiredBlock): Promise<void> {
    await this.#client.request<RawBlock>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(documentId)}/blocks`,
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
  }

  /**
   * Запуск OCR (`POST /api/recognition/jobs`).
   *
   * Путь — с префиксом `/api/recognition`: именно так подключён их роутер
   * (`recognition.py`, `APIRouter(prefix="/api/recognition")`). `scope` — из
   * закрытого `JobScope` (`selected|all|unrecognized|failed`), и портал
   * запускает `all`: набор блоков уже сведён циклом сверки, а `unrecognized`
   * означал бы «доделать то, что осталось от прошлого прогона», то есть
   * результат, собранный из двух разных запусков.
   *
   * `settings` обязателен и обязан содержать `provider_type` и `model_id` на
   * каждый выбранный тип блока — иначе их схема отвечает 422.
   */
  async startRecognition(input: StartRecognitionInput): Promise<RecognitionStatus> {
    if (input.selections.length === 0) {
      throw new RdWebError(
        'Запуск распознавания без выбора провайдера и модели невозможен: ' +
          'RD WEB отвергает пустой settings',
        { operation: 'job_create' },
      );
    }
    const settings = Object.fromEntries(
      input.selections.map((selection) => [
        selection.blockType,
        {
          provider_type: selection.providerType,
          model_id: selection.modelId,
          ...(selection.promptProfileId !== undefined
            ? { prompt_profile_id: selection.promptProfileId }
            : {}),
        },
      ]),
    );

    const response = await this.#client.request<{ job: RawJob }>({
      method: 'POST',
      path: '/api/recognition/jobs',
      operation: 'job_create',
      body: {
        document_id: input.documentId,
        scope: 'all',
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
      path: `/api/recognition/jobs/${encodeURIComponent(jobId)}`,
      operation: 'job_read',
    });
    return toStatus(response.body);
  }

  /**
   * Забор экспорта.
   *
   * Их экспорт транзиентный: архив собирается на лету из ТЕКУЩИХ активных
   * результатов блоков, а материализован только QA-манифест. То есть «тот же
   * архив завтра» — не обещание их API, и наш `artifact_sha256` описывает
   * ровно те байты, которые мы забрали в этот единственный раз (§5.2, шаг 8).
   *
   * 409 здесь означает «job не финализирован» и обязан долетать до вызывающего
   * как отказ: забирать экспорт до `has_export` нельзя, и молча вернуть пустые
   * байты значило бы записать артефакт ни о чём.
   */
  async fetchExportOnce(jobId: string): Promise<ExportPayload> {
    const response = await this.#client.request<Uint8Array>({
      method: 'GET',
      path: `/api/exports/jobs/${encodeURIComponent(jobId)}/zip`,
      operation: 'export_fetch',
      binary: true,
    });
    return { kind: 'zip', bytes: response.body, contentType: 'application/zip' };
  }

  /**
   * Активные результаты блоков — поштучно, потому что bulk-ручки у них нет.
   *
   * Отдаются ТОЛЬКО активные результаты (`is_active`): история правок оператора
   * и промежуточные результаты фазы 2 к нашему прогону отношения не имеют, а
   * `block_results` у нас append-only с отдельным указателем «текущий».
   */
  async fetchBlockResults(blockIds: readonly string[]): Promise<readonly RemoteBlockResult[]> {
    const results: RemoteBlockResult[] = [];
    for (const blockId of blockIds) {
      const response = await this.#client.request<{
        results: RawBlockResult[];
        active_result_id: string | null;
      }>({
        method: 'GET',
        path: `/api/blocks/${encodeURIComponent(blockId)}/results`,
        operation: 'block_results_read',
        // Блок мог быть удалён между чтением набора и чтением результатов; это
        // не отказ прогона, а отсутствие результата у конкретного блока.
        expect: [404],
      });
      const body = response.body as {
        results?: RawBlockResult[];
        active_result_id?: string | null;
      };
      const active =
        body.results?.find((row) =>
          body.active_result_id !== undefined && body.active_result_id !== null
            ? row.result_id === body.active_result_id
            : row.is_active === true,
        ) ?? null;
      if (active === null) continue;
      results.push({
        blockId,
        resultId: active.result_id,
        resultType: active.result_type,
        modelId: active.model_id ?? null,
        confidence: typeof active.confidence === 'number' ? active.confidence : null,
        ocrHtml: active.ocr_html ?? null,
        ocrMarkdown: active.ocr_markdown ?? null,
        ocrText: active.ocr_text ?? null,
        ocrJson: active.ocr_json ?? null,
      });
    }
    return results;
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
    errorMessage: job.error_message ?? null,
  };
}
