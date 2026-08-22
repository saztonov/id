/**
 * Массовый ввод справочников: `/api/v1/catalog/imports/*` (§3.2, §14).
 *
 * ## Приём тот же трёхшаговый, что у файлов ревизии, и это не случайность
 *
 * `init` → PUT мимо портала → `complete`. Байты не идут через процесс API по той
 * же причине, что и байты поставки, и по ещё одной, здесь более важной: офисный
 * файл не должен попадать в процесс, у которого есть пул БД и ключи хранилища.
 * Разбирает его воркер, а API только смотрит на первые байты объекта и решает,
 * книга это или нет.
 *
 * ## Что проверяется на `complete`
 *
 * Сигнатура контейнера (`PK`) и наличие `xl/workbook.xml`. Ни одно утверждение
 * клиента — ни имя, ни тип содержимого, ни размер — в решении не участвует.
 * Сигнатура при этом доказывает КОНТЕЙНЕР, а не формат: `.xlsm` от `.xlsx`
 * неотличим по байтам, и мы этого не проверяем — вместо этого читатель книги в
 * воркере не читает ни одной части, где макрос мог бы жить.
 *
 * Отвергнутый объект удаляется из хранилища сразу, а не ждёт уборки: файл,
 * который портал не принял, не должен оставаться в нём ни одним байтом.
 *
 * ## Почему статусы, а не «просто применить»
 *
 * Между разбором и применением проходит время, за которое человек уходит
 * смотреть предпросмотр, а справочник живёт своей жизнью. Все переходы —
 * сравнение-с-обменом по статусу (см. репозиторий), поэтому второй `complete`
 * или второе применение отвечают 409 с текущим состоянием, а не заводят вторую
 * пачку карточек.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  CATALOG_IMPORT_COLUMNS,
  CATALOG_IMPORT_TARGET_LABELS,
  catalogImportProblemSchema,
  catalogImportStatusSchema,
  catalogImportTargetSchema,
  catalogImportVerdictSchema,
  uuidSchema,
  type CatalogImportTarget,
} from '@id/contracts';
import type { AppInstance } from '../../app.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/problem.js';
import { currentAuth, requireAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { tracePayload } from '../../observability/context.js';
import {
  applyCatalogImport,
  createCatalogImport,
  findCatalogImport,
  findImportObjectKey,
  listCatalogImportRows,
  listCatalogImports,
  startImportParsing,
} from '../../db/repositories/catalog-imports.js';
import { buildXlsx } from '../../lib/xlsx.js';
import { uploadKey } from '../../storage/keys.js';
import { isStorageError } from '../../storage/provider.js';
import { deriveTicketKey, signUploadTicket, verifyUploadTicket } from '../files/upload-token.js';

const PREFIX = '/api/v1/catalog';

/**
 * Потолок размера файла справочника.
 *
 * На порядок меньше потолка приёма ИД (200 МБ): пять тысяч строк текста — это
 * сотни килобайт, а десять мегабайт означают, что прислали не тот файл.
 */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Срок жизни адреса загрузки: файл справочника заливается за секунды. */
const UPLOAD_TTL_SECONDS = 900;

/** Сколько живёт незавершённый импорт до уборки вместе с файлом. */
const IMPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const manageCatalog = requirePermission('settings.manage');
const authenticated: preHandlerAsyncHookHandler = (request: FastifyRequest) => requireAuth(request);

// =====================================================================
// Схемы
// =====================================================================

const importIdParamSchema = z.object({ importId: uuidSchema });

const initBodySchema = z.object({
  target: catalogImportTargetSchema,
  fileName: z.string().min(1).max(255),
  sizeBytes: z.int().positive(),
});

const initResponseSchema = z.object({
  importId: uuidSchema,
  uploadId: z.string().min(1),
  uploadUrl: z.string().min(1),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
  maxBytes: z.int().positive(),
});

const completeBodySchema = z.object({ uploadId: z.string().min(1) });

const importViewSchema = z.object({
  id: uuidSchema,
  target: catalogImportTargetSchema,
  status: catalogImportStatusSchema,
  fileName: z.string(),
  sizeBytes: z.int().nonnegative().nullable(),
  rowCount: z.int().nonnegative(),
  errorCount: z.int().nonnegative(),
  duplicateCount: z.int().nonnegative(),
  createdCount: z.int().nonnegative(),
  failureReason: z.string().nullable(),
  createdBy: uuidSchema,
  createdAt: z.string(),
  parsedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
  expiresAt: z.string(),
});

const importListSchema = z.object({ items: z.array(importViewSchema) });

const importRowSchema = z.object({
  id: uuidSchema,
  rowNo: z.int().positive(),
  raw: z.record(z.string(), z.string()),
  verdict: catalogImportVerdictSchema,
  problems: z.array(catalogImportProblemSchema),
  createdEntityId: uuidSchema.nullable(),
});

const importRowsSchema = z.object({
  items: z.array(importRowSchema),
  nextRowNo: z.int().positive().nullable(),
});

const rowsQuerySchema = z.object({
  verdict: catalogImportVerdictSchema.optional(),
  after: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const listQuerySchema = z.object({
  target: catalogImportTargetSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const templateQuerySchema = z.object({ target: catalogImportTargetSchema });

const applyResponseSchema = z.object({
  created: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
});

// =====================================================================
// Вспомогательное
// =====================================================================

function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

/** Сигнатура ZIP: решение принимается после накопления восьми байт. */
function looksLikeZip(head: Buffer): boolean {
  if (head.length < 8) return false;
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

async function readObject(app: AppInstance, key: string, maxBytes: number): Promise<Buffer> {
  const stream = await app.storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream.stream) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('объект больше объявленного предела');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Удаление отвергнутого или использованного объекта.
 *
 * Отказ удаления не отменяет решения по импорту: объект подберёт задача
 * истечения, а вот откатывать принятый файл из-за недоступного на секунду
 * хранилища нельзя.
 */
async function discard(app: AppInstance, request: FastifyRequest, key: string): Promise<void> {
  try {
    await app.storage.deleteObject(key);
  } catch (error) {
    request.log.warn(
      {
        event: 'catalog_import_discard_failed',
        reason: isStorageError(error) ? error.code : 'unknown',
      },
      'объект импорта не удалён из хранилища',
    );
  }
}

// =====================================================================
// Маршруты
// =====================================================================

export function registerCatalogImportRoutes(app: AppInstance): void {
  const ticketKey = deriveTicketKey(
    app.env.CSRF_SECRET ?? randomBytes(32).toString('hex'),
    'catalog-import',
  );

  registerTemplateRoute(app);
  registerUploadRoutes(app, ticketKey);
  registerReadRoutes(app);
  registerApplyRoute(app);
}

/**
 * Пустой шаблон.
 *
 * Читается любым аутентифицированным, а не только администратором: это форма
 * файла, а не данные. Заголовки — единственный способ для человека узнать, как
 * портал раскладывает колонки, и прятать их за правом было бы вредно.
 */
function registerTemplateRoute(app: AppInstance): void {
  app.get(
    `${PREFIX}/imports/template`,
    { preHandler: authenticated, schema: { querystring: templateQuerySchema } },
    async (request, reply) => {
      const target: CatalogImportTarget = request.query.target;
      const columns = CATALOG_IMPORT_COLUMNS[target];
      const label = CATALOG_IMPORT_TARGET_LABELS[target];

      // Вторая строка — подсказки, а не пример данных: строка с правдоподобным
      // ИНН уехала бы в справочник при первой же загрузке «как есть».
      const book = await buildXlsx(label, [
        columns.map((column) => column.title),
        columns.map((column) => column.hint),
      ]);

      return reply
        .code(200)
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="catalog-${target}.xlsx"`)
        .header('x-content-type-options', 'nosniff')
        .send(book);
    },
  );
}

function registerUploadRoutes(app: AppInstance, ticketKey: Buffer): void {
  app.post(
    `${PREFIX}/imports/init`,
    {
      preHandler: manageCatalog,
      schema: { body: initBodySchema, response: { 201: initResponseSchema } },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      if (request.body.sizeBytes > MAX_IMPORT_BYTES) {
        throw badRequest(
          `Файл больше ${String(Math.round(MAX_IMPORT_BYTES / 1024 / 1024))} МБ. ` +
            'Справочник такого размера почти наверняка не тот файл; разделите его на части.',
        );
      }

      const uploadId = randomUUID();
      const key = uploadKey(uploadId);
      const presigned = await app.storage.presignPut({
        key,
        expiresInSeconds: UPLOAD_TTL_SECONDS,
        maxBytes: MAX_IMPORT_BYTES,
      });

      const record = await createCatalogImport(
        app.db,
        scope,
        {
          target: request.body.target,
          fileName: request.body.fileName,
          s3Key: key,
          expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
        },
        auditActor(app, request),
      );

      const ticket = signUploadTicket(ticketKey, {
        uploadId,
        targetId: record.id,
        userId: user.id,
        fileName: request.body.fileName,
        key,
        expiresAt: Date.parse(presigned.expiresAt),
      });

      return reply.code(201).send({
        importId: record.id,
        uploadId: ticket,
        uploadUrl: presigned.url,
        method: 'PUT',
        headers: presigned.headers,
        expiresAt: presigned.expiresAt,
        maxBytes: MAX_IMPORT_BYTES,
      });
    },
  );

  app.post(
    `${PREFIX}/imports/:importId/complete`,
    {
      preHandler: manageCatalog,
      schema: {
        params: importIdParamSchema,
        body: completeBodySchema,
        response: { 200: importViewSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);

      const ticket = verifyUploadTicket(ticketKey, request.body.uploadId);
      if (ticket === null) {
        throw badRequest('Загрузка недействительна или истекла. Начните загрузку заново.');
      }
      if (ticket.targetId !== request.params.importId || ticket.userId !== user.id) {
        throw forbidden('Загрузка относится к другому импорту или к другому пользователю.');
      }

      const staged = await app.storage.headObject(ticket.key);
      if (staged === null) {
        throw conflict('Файл не найден в хранилище: загрузка не была завершена.');
      }
      if (staged.sizeBytes > MAX_IMPORT_BYTES) {
        await discard(app, request, ticket.key);
        throw badRequest('Загруженный файл больше допустимого предела.');
      }

      const bytes = await readObject(app, ticket.key, MAX_IMPORT_BYTES);
      if (!looksLikeZip(bytes.subarray(0, 8))) {
        await discard(app, request, ticket.key);
        throw badRequest(
          'Это не книга Excel: файл не начинается сигнатурой архива. ' +
            'Сохраните таблицу в формате .xlsx и повторите загрузку.',
        );
      }
      // Наличие части книги проверяется по СОДЕРЖИМОМУ архива, а не по имени
      // файла: .zip с фотографиями тоже начинается с `PK`.
      if (!bytes.includes(Buffer.from('xl/workbook.xml', 'utf8'))) {
        await discard(app, request, ticket.key);
        throw badRequest('Архив не содержит книги Excel: в нём нет xl/workbook.xml.');
      }

      const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
      const record = await startImportParsing(app.db, request.params.importId, {
        sha256,
        sizeBytes: bytes.byteLength,
      });

      const { jobId } = await enqueueJob(app.db, scope, {
        type: 'catalog.import.parse',
        payload: tracePayload({ importId: record.id }),
        dedupeKey: dedupeKeyFor('catalog.import.parse', record.id),
      });
      request.log.info(
        { event: 'job_enqueued', job_type: 'catalog.import.parse', job_id: jobId },
        'разбор файла справочника поставлен в очередь',
      );

      return reply.code(200).send(record);
    },
  );
}

function registerReadRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/imports`,
    {
      preHandler: manageCatalog,
      schema: { querystring: listQuerySchema, response: { 200: importListSchema } },
    },
    async (request, reply) => {
      const items = await listCatalogImports(app.db, request.query);
      return reply.code(200).send({ items: [...items] });
    },
  );

  app.get(
    `${PREFIX}/imports/:importId`,
    {
      preHandler: manageCatalog,
      schema: { params: importIdParamSchema, response: { 200: importViewSchema } },
    },
    async (request, reply) => {
      const record = await findCatalogImport(app.db, request.params.importId);
      if (record === null) throw notFound('Импорт справочника не найден.');
      return reply.code(200).send(record);
    },
  );

  app.get(
    `${PREFIX}/imports/:importId/rows`,
    {
      preHandler: manageCatalog,
      schema: {
        params: importIdParamSchema,
        querystring: rowsQuerySchema,
        response: { 200: importRowsSchema },
      },
    },
    async (request, reply) => {
      const record = await findCatalogImport(app.db, request.params.importId);
      if (record === null) throw notFound('Импорт справочника не найден.');

      const { limit } = request.query;
      const rows = await listCatalogImportRows(app.db, record.id, {
        verdict: request.query.verdict,
        afterRowNo: request.query.after,
        limit: limit + 1,
      });

      // Курсор — номер строки: он монотонен внутри импорта и понятен человеку,
      // в отличие от непрозрачного маркера.
      const page = rows.slice(0, limit);
      const nextRowNo = rows.length > limit ? (page.at(-1)?.rowNo ?? null) : null;
      return reply.code(200).send({
        items: page.map((row) => ({ ...row, problems: [...row.problems] })),
        nextRowNo,
      });
    },
  );
}

function registerApplyRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/imports/:importId/apply`,
    {
      preHandler: manageCatalog,
      schema: { params: importIdParamSchema, response: { 200: applyResponseSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const result = await applyCatalogImport(
        app.db,
        scope,
        request.params.importId,
        auditActor(app, request),
      );

      // Применённый импорт файл больше не нужен: строки предпросмотра остаются
      // в БД и отвечают на вопрос «что именно завели», а книга — нет.
      const key = await findImportObjectKey(app.db, request.params.importId);
      if (key !== null) await discard(app, request, key);

      return reply.code(200).send(result);
    },
  );
}
