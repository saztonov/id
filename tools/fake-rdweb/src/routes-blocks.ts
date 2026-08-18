/**
 * Блоки: CRUD с оптимистичной блокировкой, синхронная детекция и массовые операции.
 *
 * Источники: `routes/blocks.py`, `routes/_blocks_schemas.py`, `routes/blocks_detect.py`,
 * `routes/blocks_bulk.py`.
 *
 * ## Что здесь воспроизводится дословно
 *
 * Проверка геометрии (`_check_coords_norm` / `_check_polygon_points`), 409 с ТЕКУЩИМ
 * блоком в теле при расхождении версии и правило `skipped_pages` при повторной
 * детекции. Именно на них ломается клиент: расхождение версии без тела конфликта не
 * даёт ему перерисоваться, а молчаливая повторная детекция плодит дубли разметки.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { conflict, notFound, unprocessable } from './errors.js';
import { detectPages } from './detector.js';
import { parseBody, requireUser } from './routes-auth.js';
import { requireDocument } from './routes-documents.js';
import type { BlockOut, BlockTypeName, DocumentRecord, FakeState, ShapeTypeName } from './state.js';

const blockTypes = ['text', 'image', 'stamp'] as const satisfies readonly BlockTypeName[];
const shapeTypes = ['rectangle', 'polygon'] as const satisfies readonly ShapeTypeName[];

const createBlockSchema = z.object({
  page_index: z.number().int().min(0),
  block_type: z.enum(blockTypes),
  shape_type: z.enum(shapeTypes).default('rectangle'),
  coords_norm: z.array(z.number()),
  coords_px: z.array(z.number()).nullish(),
  polygon_points: z.array(z.array(z.number())).nullish(),
  linked_block_id: z.string().nullish(),
  client_id: z.string().nullish(),
});

const updateBlockSchema = z.object({
  expected_version: z.number().int().min(1),
  block_type: z.enum(blockTypes).nullish(),
  shape_type: z.enum(shapeTypes).nullish(),
  coords_norm: z.array(z.number()).nullish(),
  coords_px: z.array(z.number()).nullish(),
  polygon_points: z.array(z.array(z.number())).nullish(),
});

const detectSchema = z.object({
  page_indices: z.array(z.number().int()).nullish(),
  overwrite_existing: z.boolean().default(false),
  async_mode: z.boolean().default(false),
});

/** `_blocks_schemas._check_coords_norm`. */
function checkCoordsNorm(coords: readonly number[]): void {
  if (coords.length !== 4) {
    throw unprocessable('coords_norm должен содержать ровно 4 числа [x0,y0,x1,y1]');
  }
  if (coords.some((c) => !(c >= 0 && c <= 1))) {
    throw unprocessable('coords_norm: все значения должны быть в диапазоне [0,1]');
  }
  const [x0, y0, x1, y1] = coords as [number, number, number, number];
  if (x0 > x1 || y0 > y1) {
    throw unprocessable('coords_norm: требуется x0<=x1 и y0<=y1');
  }
}

/** `_blocks_schemas._check_polygon_points`. */
function checkPolygonPoints(points: readonly (readonly number[])[]): void {
  if (points.length < 3) {
    throw unprocessable('polygon_points: требуется не менее 3 вершин');
  }
  for (const point of points) {
    if (point.length !== 2 || point.some((c) => !(c >= 0 && c <= 1))) {
      throw unprocessable('polygon_points: каждая вершина — [x,y] в диапазоне [0,1]');
    }
  }
}

function requireBlock(state: FakeState, blockId: string): BlockOut {
  const block = state.blocks.get(blockId);
  if (block === undefined) {
    throw notFound('Блок не найден');
  }
  return block;
}

/** `_blocks_helpers._conflict`: 409 с текущим серверным блоком для diff/reload. */
function sendConflict(reply: FastifyReply, block: BlockOut, expectedVersion: number): FastifyReply {
  return reply.code(409).send({
    detail: 'Версия блока устарела',
    expected_version: expectedVersion,
    actual_version: block.version,
    current: { ...block },
  });
}

interface NewBlockInput {
  readonly pageIndex: number;
  readonly blockType: BlockTypeName;
  readonly shapeType: ShapeTypeName;
  readonly coordsNorm: number[];
  readonly polygonPoints: number[][] | null;
  readonly source: 'user' | 'auto';
  readonly linkedBlockId: string | null;
  readonly clientId: string | null;
}

function createBlock(
  state: FakeState,
  document: DocumentRecord,
  userId: string,
  input: NewBlockInput,
): BlockOut {
  const now = state.now();
  const block: BlockOut = {
    block_id: state.newId('blk'),
    project_id: document.projectId,
    document_id: document.documentId,
    page_index: input.pageIndex,
    sort_order: state.nextSortOrder(document.documentId, input.pageIndex, input.blockType),
    block_type: input.blockType,
    shape_type: input.shapeType,
    coords_norm: input.coordsNorm,
    // Норма — источник истины; `coords_px` от клиента игнорируется (зависит от DPI).
    coords_px: null,
    polygon_points: input.polygonPoints,
    status: 'draft',
    active_result_id: null,
    linked_block_id: input.linkedBlockId,
    source: input.source,
    version: 1,
    created_by: userId,
    updated_by: userId,
    created_at: now,
    updated_at: now,
    client_id: input.clientId,
  };
  state.blocks.set(block.block_id, block);
  return block;
}

/** Страницы, у которых есть готовое превью — единственная цель детекции. */
function renderedPages(document: DocumentRecord): number[] {
  if (document.status !== 'ready' || document.pageCount === null) {
    return [];
  }
  return Array.from({ length: document.pageCount }, (_unused, index) => index);
}

export function registerBlockRoutes(app: FastifyInstance, state: FakeState, seed: string): void {
  app.get('/api/documents/:document_id/blocks', async (request) => {
    requireUser(state, request);
    const params = request.params as { document_id: string };
    const document = requireDocument(state, params.document_id);
    const query = request.query as Record<string, string | undefined>;
    const rawPage = query['page_index'];
    const pageIndex = rawPage === undefined ? undefined : Number.parseInt(rawPage, 10);
    if (pageIndex !== undefined && (!Number.isInteger(pageIndex) || pageIndex < 0)) {
      throw unprocessable('page_index: требуется целое число >= 0');
    }
    const blocks = state.blocksOf(document.documentId, pageIndex);
    return { blocks: blocks.map((b) => ({ ...b })) };
  });

  app.post('/api/documents/:document_id/blocks', async (request, reply) => {
    const user = requireUser(state, request);
    const params = request.params as { document_id: string };
    const document = requireDocument(state, params.document_id);
    const body = parseBody(createBlockSchema, request.body);
    checkCoordsNorm(body.coords_norm);
    if (body.shape_type === 'polygon') {
      if (body.polygon_points === null || body.polygon_points === undefined) {
        throw unprocessable('polygon: требуется непустой polygon_points');
      }
      checkPolygonPoints(body.polygon_points);
    } else if (body.polygon_points !== null && body.polygon_points !== undefined) {
      checkPolygonPoints(body.polygon_points);
    }
    if (document.pageCount !== null && body.page_index >= document.pageCount) {
      throw unprocessable('page_index выходит за число страниц документа');
    }
    const block = createBlock(state, document, user.userId, {
      pageIndex: body.page_index,
      blockType: body.block_type,
      shapeType: body.shape_type,
      coordsNorm: body.coords_norm,
      polygonPoints: body.polygon_points ?? null,
      source: 'user',
      linkedBlockId: body.linked_block_id ?? null,
      clientId: body.client_id ?? null,
    });
    return reply.code(201).send({ ...block });
  });

  app.get('/api/blocks/:block_id', async (request) => {
    requireUser(state, request);
    const params = request.params as { block_id: string };
    return { ...requireBlock(state, params.block_id) };
  });

  app.patch('/api/blocks/:block_id', async (request, reply) => {
    const user = requireUser(state, request);
    const params = request.params as { block_id: string };
    const block = requireBlock(state, params.block_id);
    const body = parseBody(updateBlockSchema, request.body);
    if (body.coords_norm !== null && body.coords_norm !== undefined) {
      checkCoordsNorm(body.coords_norm);
    }
    if (body.polygon_points !== null && body.polygon_points !== undefined) {
      checkPolygonPoints(body.polygon_points);
    }
    if (block.version !== body.expected_version) {
      return sendConflict(reply, block, body.expected_version);
    }
    const shapeType = body.shape_type ?? block.shape_type;
    const polygonPoints = body.polygon_points ?? block.polygon_points;
    if (shapeType === 'polygon' && (polygonPoints === null || polygonPoints.length === 0)) {
      throw unprocessable('polygon: требуется непустой polygon_points');
    }
    const geometryChanged =
      (body.coords_norm !== null && body.coords_norm !== undefined) ||
      (body.polygon_points !== null && body.polygon_points !== undefined) ||
      (body.shape_type !== null &&
        body.shape_type !== undefined &&
        body.shape_type !== block.shape_type);
    const typeChanged =
      body.block_type !== null &&
      body.block_type !== undefined &&
      body.block_type !== block.block_type;

    block.coords_norm = body.coords_norm ?? block.coords_norm;
    block.polygon_points = polygonPoints;
    block.shape_type = shapeType;
    block.block_type = body.block_type ?? block.block_type;
    if (geometryChanged || typeChanged) {
      // Результат распознавания относился к прежнему кропу/типу — он остаётся в
      // истории, но активным быть перестаёт (та же сцепка полей, что в оригинале).
      block.status = 'draft';
      block.active_result_id = null;
    }
    block.version += 1;
    block.updated_by = user.userId;
    block.updated_at = state.now();
    return { ...block };
  });

  app.delete('/api/blocks/:block_id', async (request, reply) => {
    requireUser(state, request);
    const params = request.params as { block_id: string };
    const block = requireBlock(state, params.block_id);
    const query = request.query as Record<string, string | undefined>;
    const expectedVersion = Number.parseInt(query['expected_version'] ?? '', 10);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw unprocessable('expected_version: требуется целое число >= 1');
    }
    if (block.version !== expectedVersion) {
      return sendConflict(reply, block, expectedVersion);
    }
    state.blocks.delete(block.block_id);
    return { deleted: true, block_id: block.block_id };
  });

  app.post('/api/documents/:document_id/detect-blocks', async (request, reply) => {
    const user = requireUser(state, request);
    const params = request.params as { document_id: string };
    const document = requireDocument(state, params.document_id);
    const body = parseBody(detectSchema, request.body);
    const warnings: string[] = [];

    if (body.async_mode) {
      // Асинхронная детекция ставит фоновую задачу и отвечает 202. Маршрута опроса
      // этой задачи у оригинала НЕТ (прогресс идёт по WebSocket), поэтому его нет и
      // здесь: выдуманный роут статуса увёл бы адаптер в несуществующий контракт.
      return reply.code(202).send({
        created: [],
        skipped_pages: [],
        warnings,
        detect_job_id: state.newId('dtask'),
      });
    }

    const rendered = new Set(renderedPages(document));
    let target: number[];
    if (body.page_indices !== null && body.page_indices !== undefined) {
      const requested = [...new Set(body.page_indices)].sort((a, b) => a - b);
      target = requested.filter((p) => rendered.has(p));
      for (const page of requested) {
        if (!rendered.has(page)) {
          warnings.push(`Страница ${page} не отрендерена — пропущена`);
        }
      }
    } else {
      target = [...rendered].sort((a, b) => a - b);
    }

    if (target.length > state.maxPagesPerDetectCall) {
      throw unprocessable(
        `Слишком много страниц за один вызов (${target.length}); максимум ` +
          `${state.maxPagesPerDetectCall}. Передайте page_indices меньшими пачками.`,
      );
    }

    const skippedPages: number[] = [];
    const processPages: number[] = [];
    for (const page of target) {
      const existing = state.blocksOf(document.documentId, page);
      if (existing.length > 0 && !body.overwrite_existing) {
        skippedPages.push(page); // не плодим дубли на уже размеченной странице
      } else {
        processPages.push(page);
      }
    }
    if (processPages.length === 0) {
      return { created: [], skipped_pages: skippedPages, warnings };
    }

    const created: BlockOut[] = [];
    for (const page of processPages) {
      if (body.overwrite_existing) {
        // Перезапись сносит только авто-разметку: ручные блоки оператора детекция
        // затирать не вправе (та же граница, что у `write_page_detection_blocks`).
        for (const existing of state.blocksOf(document.documentId, page)) {
          if (existing.source === 'auto') {
            state.blocks.delete(existing.block_id);
          }
        }
      }
      for (const candidate of detectPages(seed, document.documentId, [page])) {
        created.push(
          createBlock(state, document, user.userId, {
            pageIndex: candidate.pageIndex,
            blockType: candidate.blockType,
            shapeType: 'rectangle',
            coordsNorm: [...candidate.coordsNorm],
            polygonPoints: null,
            source: 'auto',
            linkedBlockId: null,
            clientId: null,
          }),
        );
      }
    }
    return { created: created.map((b) => ({ ...b })), skipped_pages: skippedPages, warnings };
  });

  app.post('/api/documents/:document_id/blocks/full-page-text', async (request, reply) => {
    const user = requireUser(state, request);
    const params = request.params as { document_id: string };
    const document = requireDocument(state, params.document_id);
    const pages = state.pagesOf(document);
    if (pages.length === 0) {
      throw conflict('В документе нет страниц');
    }
    const blocksTotal = state.blocksOf(document.documentId).length;
    // Оригинал уносит операцию в фон; двойник выполняет её синхронно и отвечает тем же
    // 202 — тест обязан видеть результат сразу, а очередь тут моделировать нечем.
    for (const page of pages) {
      for (const existing of state.blocksOf(document.documentId, page.page_index)) {
        state.blocks.delete(existing.block_id);
      }
      createBlock(state, document, user.userId, {
        pageIndex: page.page_index,
        blockType: 'text',
        shapeType: 'rectangle',
        coordsNorm: [0, 0, 1, 1],
        polygonPoints: null,
        source: 'auto',
        linkedBlockId: null,
        clientId: null,
      });
    }
    return reply.code(202).send({
      bulk_job_id: state.newId('dtask'),
      pages_total: pages.length,
      blocks_total: blocksTotal,
    });
  });

  app.post('/api/documents/:document_id/blocks/purge', async (request, reply) => {
    requireUser(state, request);
    const params = request.params as { document_id: string };
    const document = requireDocument(state, params.document_id);
    const pages = state.pagesOf(document);
    if (pages.length === 0) {
      throw conflict('В документе нет страниц');
    }
    const blocks = state.blocksOf(document.documentId);
    for (const block of blocks) {
      state.blocks.delete(block.block_id);
    }
    return reply.code(202).send({
      bulk_job_id: state.newId('dtask'),
      pages_total: pages.length,
      blocks_total: blocks.length,
    });
  });
}
