/**
 * Документы: `init → PUT → complete`, деталь документа и превью страницы.
 *
 * Источники: `routes/documents_upload.py`, `routes/documents.py`,
 * `routes/documents_render.py`, `routes/_documents_schemas.py`.
 *
 * ## Почему рендер моделируется поллингом, а не таймером
 *
 * У оригинала растеризацию делает отдельный worker, и клиент узнаёт о готовности либо
 * по WebSocket, либо перечитывая документ. Таймер в двойнике сделал бы тесты
 * зависимыми от скорости машины; счётчик обращений к `GET /api/documents/{id}` даёт
 * ту же наблюдаемую последовательность `rendering → ready` и при этом детерминирован.
 */
import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { conflict, HttpError, notFound, unprocessable } from './errors.js';
import { countPdfPages, hasPdfMagic, PNG_1X1 } from './pdf.js';
import { parseBody, requireUser } from './routes-auth.js';
import {
  MAX_PDF_BYTES,
  originalPdfKey,
  PRESIGN_TTL_SEC,
  sanitizeFileName,
  type DocumentRecord,
  type FakeState,
} from './state.js';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

const uploadInitSchema = z.object({
  project_id: z.string().regex(idPattern),
  node_id: z.string().regex(idPattern),
  file_name: z.string().min(1).max(255),
  project_version: z.string().min(1).max(64),
  size_bytes: z.number().int().nullish(),
  content_type: z.string().nullish(),
});

const uploadCompleteSchema = z.object({
  document_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

/** Документ по id или 404 — общий вход для всех документных роутов. */
export function requireDocument(state: FakeState, documentId: string): DocumentRecord {
  const document = state.documents.get(documentId);
  if (document === undefined) {
    throw notFound('Документ не найден');
  }
  return document;
}

/**
 * Продвинуть рендер: после `renderDelayPolls` обращений документ становится `ready`.
 *
 * Счётчик увеличивается ДО сравнения, поэтому при значении 2 клиент получает два
 * ответа `rendering` и только третий — `ready`: поллинг обязан быть поллингом, иначе
 * адаптер, забывший цикл ожидания, проходил бы тест случайно.
 */
function advanceRender(state: FakeState, document: DocumentRecord): void {
  if (document.status !== 'rendering') {
    return;
  }
  document.detailPolls += 1;
  if (document.detailPolls > state.renderDelayPolls) {
    document.status = 'ready';
    document.updatedAt = state.now();
  }
}

function documentDetail(state: FakeState, document: DocumentRecord): unknown {
  const pages = state.pagesOf(document);
  return {
    document_id: document.documentId,
    project_id: document.projectId,
    node_id: document.nodeId,
    file_name: document.fileName,
    status: document.status,
    page_count: document.status === 'ready' ? document.pageCount : null,
    pdf_hash: document.sha256,
    project_version: document.projectVersion,
    is_done: false,
    done_at: null,
    done_by_email: null,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
    pages,
    counters: state.counters(document.documentId),
    render_error: null,
  };
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  state: FakeState,
  baseUrl: () => string,
): void {
  app.post('/api/documents/upload/init', async (request) => {
    requireUser(state, request);
    const body = parseBody(uploadInitSchema, request.body);
    if (typeof body.size_bytes === 'number') {
      if (body.size_bytes <= 0) {
        throw unprocessable('PDF-файл пуст');
      }
      if (body.size_bytes > MAX_PDF_BYTES) {
        throw unprocessable(`PDF-файл превышает лимит ${MAX_PDF_BYTES} байт и не будет загружен`);
      }
    }
    const node = state.nodes.get(body.node_id);
    if (node === undefined) {
      throw notFound('Узел не найден');
    }
    if (node.projectId !== body.project_id) {
      throw conflict('Узел принадлежит другому проекту');
    }
    const documentId = state.newId('doc');
    const s3Key = originalPdfKey(body.project_id, documentId, body.file_name);
    const token = state.newId('put');
    state.uploadTokens.set(token, { documentId, used: false });
    const now = state.now();
    state.documents.set(documentId, {
      documentId,
      projectId: body.project_id,
      nodeId: body.node_id,
      fileName: sanitizeFileName(body.file_name),
      projectVersion: body.project_version,
      s3Key,
      status: 'uploaded',
      sizeBytes: 0,
      bytes: null,
      sha256: null,
      pageCount: null,
      detailPolls: 0,
      createdAt: now,
      updatedAt: now,
    });
    return {
      document_id: documentId,
      s3_key: s3Key,
      // Адрес абсолютный: presigned PUT боевого S3 тоже приходит абсолютным, и
      // адаптер не должен ничего к нему дописывать.
      upload_url: `${baseUrl()}/_storage/${token}`,
      method: 'PUT',
      required_headers: {
        'Content-Type': 'application/pdf',
        'x-amz-meta-document-id': documentId,
      },
      expires_in: PRESIGN_TTL_SEC,
      max_size_bytes: MAX_PDF_BYTES,
    };
  });

  // Presigned PUT: без Bearer — подписью служит сам одноразовый токен в пути.
  app.put('/_storage/:token', async (request) => {
    const params = request.params as { token: string };
    const record = state.uploadTokens.get(params.token);
    if (record === undefined || record.used) {
      throw new HttpError(403, 'Ссылка на загрузку недействительна');
    }
    const body = request.body;
    const bytes = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : '', 'latin1');
    const document = state.documents.get(record.documentId);
    if (document === undefined) {
      throw notFound('Документ не найден');
    }
    record.used = true;
    document.bytes = bytes;
    document.sizeBytes = bytes.length;
    document.sha256 = createHash('sha256').update(bytes).digest('hex');
    document.updatedAt = state.now();
    return { ok: true };
  });

  app.post('/api/documents/upload/complete', async (request) => {
    requireUser(state, request);
    const body = parseBody(uploadCompleteSchema, request.body);
    const document = requireDocument(state, body.document_id);
    // Порядок проверок — как в оригинале: сначала HEAD (наличие/размер), потом
    // сигнатура. Иначе «файл не загружен» приходил бы как «файл не PDF».
    if (document.bytes === null) {
      throw unprocessable('Файл ещё не загружен в хранилище');
    }
    if (document.bytes.length === 0) {
      throw unprocessable('Загруженный файл пуст');
    }
    if (document.bytes.length > MAX_PDF_BYTES) {
      throw unprocessable(`Файл превышает лимит ${MAX_PDF_BYTES} байт`);
    }
    if (!hasPdfMagic(document.bytes)) {
      throw unprocessable('Файл не является PDF (нет сигнатуры %PDF-)');
    }
    document.pageCount = countPdfPages(document.bytes);
    document.status = 'rendering';
    document.detailPolls = 0;
    document.updatedAt = state.now();
    return {
      document_id: document.documentId,
      status: document.status,
      size_bytes: document.sizeBytes,
      s3_key: document.s3Key,
    };
  });

  app.get('/api/documents/:document_id', async (request) => {
    requireUser(state, request);
    const params = request.params as { document_id: string };
    const document = requireDocument(state, params.document_id);
    advanceRender(state, document);
    return documentDetail(state, document);
  });

  app.get('/api/documents/:document_id/pages/:page_index/preview', async (request, reply) => {
    requireUser(state, request);
    const params = request.params as { document_id: string; page_index: string };
    const document = requireDocument(state, params.document_id);
    const pageIndex = Number.parseInt(params.page_index, 10);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      throw unprocessable('page_index: требуется целое число >= 0');
    }
    if (document.status !== 'ready') {
      throw conflict('Превью страницы ещё не отрендерено');
    }
    if (document.pageCount === null || pageIndex >= document.pageCount) {
      throw notFound('Страница не найдена');
    }
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, max-age=300')
      .send(PNG_1X1);
  });
}
