/**
 * Приём файлов и выдача содержимого (§4.2, §14): `/api/v1/revisions/:id/files/*`
 * и `/api/v1/files/:id/content`.
 *
 * ## Приём в три шага
 *
 * `init` → загрузка клиентом → `complete`. Байты идут в хранилище мимо портала:
 * 86 МБ через процесс Node — это его память, время запроса и таймауты прокси.
 * На `init` сервер выдаёт адрес presigned PUT и подписанный талон; на `complete`
 * он читает ФАКТИЧЕСКИЙ объект и проверяет его сам — размер, магические байты,
 * структуру PDF, отсутствие шифрования, число страниц. Ни одно утверждение
 * клиента (тип содержимого, размер, хэш) в решениях не участвует.
 *
 * Промежуточный ключ `uploads/{uuid}` обязателен: presigned PUT прямо в
 * `blobs/{sha256}` позволил бы затереть ЧУЖОЙ проверенный объект — достаточно
 * назвать чужой хэш, который клиент к тому же может знать законно, имея те же
 * байты. После проверки объект переносится в `blobs/{sha256}` серверным
 * копированием, а если такой объект уже есть — не переносится вовсе: это и есть
 * дедупликация §3.3, «повторная подача после возврата не создаёт второй объект».
 *
 * ## Чтение — только своим эндпоинтом
 *
 * Presigned GET наружу не отдаётся (§4.2): он утекает в историю браузера и в
 * Referer, живёт до конца TTL и всё это время действует мимо RBAC. Вместо него
 * `GET /files/:id/content` с поддержкой `Range`: каждый запрос проходит область
 * видимости, а pdf.js получает ровно те диапазоны, которые ему нужны, — при
 * просмотре 86 МБ комплекта через прокси идут единицы мегабайт.
 *
 * Содержимое отдаётся только у файла в состоянии `ok`. Карантинный файл виден в
 * списке вместе с причиной отказа — подрядчик обязан понимать, что именно
 * отвергнуто, — но его байты порталом не раздаются.
 *
 * ## Права
 *
 * Загрузка, порядок и удаление — `submission.upload`, то есть подрядчик (§4.1):
 * состав поставки формирует тот, кто её подаёт. Чтение списка и содержимого —
 * `submission.read`. Область видимости применяется в репозитории ко всем путям,
 * включая выдачу байтов.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppInstance } from '../../app.js';
import {
  HttpProblem,
  badRequest,
  conflict,
  forbidden,
  notFound,
  titleForStatus,
} from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import { auditEmailHmac } from '../../db/repositories/admin.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import type { AuditActor } from '../../db/repositories/audit.js';
import {
  deleteSourceFile,
  findFileContent,
  findRevisionForFiles,
  listSourceFiles,
  recordUploadedFile,
  reorderSourceFiles,
  requireEditableRevision,
} from '../../db/repositories/files.js';
import { LOCAL_UPLOAD_PATH } from '../../storage/local.js';
import { isStorageError, type ByteRange } from '../../storage/provider.js';
import { blobKey, uploadKey } from '../../storage/keys.js';
import { deriveTicketKey, signUploadTicket, verifyUploadTicket } from './upload-token.js';
import { UploadTooLargeError, verifyUploadedObject } from './verify.js';
import {
  fileIdParamSchema,
  fileOrderBodySchema,
  localUploadQuerySchema,
  revisionFileParamSchema,
  revisionIdParamSchema,
  sourceFileListSchema,
  sourceFileViewSchema,
  uploadCompleteBodySchema,
  uploadInitBodySchema,
  uploadInitResponseSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

/**
 * Срок жизни адреса загрузки.
 *
 * Час: 200 МБ по плохому каналу заливаются долго, а адрес всё это время
 * действует без сессии. Больше — значит дольше держать пригодной ссылку,
 * которая могла утечь; меньше — обрывать законную загрузку.
 */
const UPLOAD_TTL_SECONDS = 3600;

const uploadFiles = requirePermission('submission.upload');
const readFiles = requirePermission('submission.read');

export function registerFileRoutes(app: AppInstance): void {
  // Ключ подписи талонов один на процесс. Вне продакшна `CSRF_SECRET`
  // необязателен, и тогда талоны не переживают перезапуск — для незавершённой
  // загрузки это корректно, повторный `init` дешевле хранимого состояния.
  const ticketKey = deriveTicketKey(
    app.env.CSRF_SECRET ?? randomBytes(32).toString('hex'),
    'revision-file',
  );

  registerListRoute(app);
  registerUploadRoutes(app, ticketKey);
  registerOrderRoute(app);
  registerDeleteRoute(app);
  registerContentRoute(app);
  registerLocalUploadRoute(app);
}

// =====================================================================
// Список файлов ревизии
// =====================================================================

function registerListRoute(app: AppInstance): void {
  app.get(
    `${PREFIX}/revisions/:revisionId/files`,
    {
      preHandler: readFiles,
      schema: {
        params: revisionIdParamSchema,
        response: { 200: sourceFileListSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listSourceFiles(app.db, scope, request.params.revisionId);
      // Пустой список у чужой ревизии — это ответ «она есть, но пуста». 404
      // делает «нет такой» и «не ваша» неразличимыми.
      if (items.length === 0) await requireVisibleRevision(app, request, request.params.revisionId);
      return reply.code(200).send({ items: [...items] });
    },
  );
}

// =====================================================================
// Три шага приёма
// =====================================================================

function registerUploadRoutes(app: AppInstance, ticketKey: Buffer): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/files/upload/init`,
    {
      preHandler: uploadFiles,
      schema: {
        params: revisionIdParamSchema,
        body: uploadInitBodySchema,
        response: { 201: uploadInitResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);
      const revision = await requireEditableRevision(app.db, scope, request.params.revisionId);
      updateContext({ revisionId: revision.id, objectId: revision.objectId });

      const maxBytes = app.env.MAX_UPLOAD_BYTES;
      if (request.body.sizeBytes > maxBytes) throw tooLarge(maxBytes);

      const uploadId = randomUUID();
      const key = uploadKey(uploadId);
      const presigned = await app.storage.presignPut({
        key,
        expiresInSeconds: UPLOAD_TTL_SECONDS,
        maxBytes,
      });

      const ticket = signUploadTicket(ticketKey, {
        uploadId,
        targetId: revision.id,
        userId: user.id,
        fileName: request.body.fileName,
        key,
        expiresAt: Date.parse(presigned.expiresAt),
      });

      return reply.code(201).send({
        uploadId: ticket,
        uploadUrl: presigned.url,
        method: 'PUT',
        headers: presigned.headers,
        expiresAt: presigned.expiresAt,
        maxBytes,
      });
    },
  );

  app.post(
    `${PREFIX}/revisions/:revisionId/files/upload/complete`,
    {
      preHandler: uploadFiles,
      schema: {
        params: revisionIdParamSchema,
        body: uploadCompleteBodySchema,
        response: { 201: sourceFileViewSchema },
      },
    },
    async (request, reply) => {
      const { scope, user } = currentAuth(request);

      const ticket = verifyUploadTicket(ticketKey, request.body.uploadId);
      if (ticket === null) {
        throw badRequest('Загрузка недействительна или истекла. Начните загрузку заново.');
      }
      // Талон привязан к ревизии и к пользователю: иначе перехваченный талон
      // работал бы в чужой сессии, а выданный на одну ревизию — в другой.
      if (ticket.targetId !== request.params.revisionId || ticket.userId !== user.id) {
        throw forbidden('Загрузка относится к другой ревизии или к другому пользователю.');
      }

      const revision = await requireEditableRevision(app.db, scope, ticket.targetId);
      updateContext({ revisionId: revision.id, objectId: revision.objectId });

      const maxBytes = app.env.MAX_UPLOAD_BYTES;
      const staged = await app.storage.headObject(ticket.key);
      if (staged === null) {
        throw conflict(
          'Файл не найден в хранилище: загрузка не была завершена или уже принята. ' +
            'Обновите список файлов ревизии.',
        );
      }
      if (staged.sizeBytes > maxBytes) {
        await discardStaged(app, request, ticket.key);
        throw tooLarge(maxBytes);
      }

      const verified = await readAndVerify(app, request, ticket.key, maxBytes);

      // Дедупликация по содержимому: если объект с таким sha256 уже лежит,
      // второй копии не появляется (§3.3). Ключ детерминирован от хэша,
      // поэтому «уже лежит» — это ровно те же байты.
      const target = blobKey(verified.sha256);
      if ((await app.storage.headObject(target)) === null) {
        await app.storage.copyObject(ticket.key, target, verified.mime);
      }

      const file = await recordUploadedFile(
        app.db,
        scope,
        {
          revisionId: revision.id,
          fileName: ticket.fileName,
          sha256: verified.sha256,
          sizeBytes: verified.sizeBytes,
          mime: verified.mime,
          storageKey: target,
          verifyState: verified.state,
          verifyError: verified.error,
          signatureProbe: verified.signatureProbe,
          pages: verified.pages,
        },
        auditActor(app, request),
      );

      await discardStaged(app, request, ticket.key);
      await startFilePipeline(app, request, revision.id, file.id);
      return reply.code(201).send(file);
    },
  );
}

/**
 * Постановка задач 1–2 конвейера для принятого файла (§12).
 *
 * Проверка при загрузке идёт синхронно — иначе `complete` нечего было бы
 * ответить, — но проверяет она ПОТОК от клиента. Задачи проверяют объект,
 * который в итоге лежит в хранилище, и это разные утверждения: между ними S3,
 * диск и повторные попытки. Без постановки обе задачи оставались бы
 * зарегистрированным, протестированным и никогда не выполняющимся кодом.
 *
 * Ключ дедупликации — по файлу: повторный `complete` того же файла не создаёт
 * вторую проверку, пока первая не завершилась.
 *
 * Отказ постановки НЕ отменяет приём файла: файл уже записан и виден в составе
 * ревизии, а откатывать принятые байты из-за недоступной на секунду очереди
 * значило бы терять работу подрядчика. Задачи перезапускаются со сборки рабочего
 * документа, и это видно в консоли.
 */
async function startFilePipeline(
  app: AppInstance,
  request: FastifyRequest,
  revisionId: string,
  fileId: string,
): Promise<void> {
  const { scope } = currentAuth(request);
  const payload = tracePayload({ revisionId, sourceFileId: fileId });

  for (const type of ['file.verify', 'file.signature_probe'] as const) {
    try {
      const { jobId, created } = await enqueueJob(app.db, scope, {
        type,
        payload,
        dedupeKey: dedupeKeyFor(type, fileId),
      });
      request.log.info(
        { event: 'job_enqueued', job_type: type, job_id: jobId, created, source_file_id: fileId },
        'задача конвейера поставлена',
      );
    } catch (error) {
      request.log.error(
        { event: 'job_enqueue_failed', job_type: type, error_class: errorClass(error) },
        'задача конвейера не поставлена',
      );
    }
  }
}

/**
 * Чтение объекта и вердикт.
 *
 * Отдельной функцией, потому что оба отказа — превышение лимита и недоступность
 * хранилища — обязаны оставить после себя чистое состояние: незавершённая
 * загрузка удаляется, а не остаётся занимать место до сборки мусора.
 */
async function readAndVerify(
  app: AppInstance,
  request: FastifyRequest,
  key: string,
  maxBytes: number,
): Promise<Awaited<ReturnType<typeof verifyUploadedObject>>> {
  const object = await app.storage.getObjectStream(key);
  try {
    return await verifyUploadedObject(object.stream, {
      maxBytes,
      maxPages: app.env.MAX_PAGES_PER_FILE,
    });
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      await discardStaged(app, request, key);
      throw tooLarge(maxBytes);
    }
    throw error;
  }
}

/**
 * Удаление незавершённой загрузки.
 *
 * Отказ хранилища здесь не должен превращаться в отказ запроса: файл уже
 * зарегистрирован, а брошенный объект в `uploads/` заберёт `storage.gc` (§12).
 */
async function discardStaged(
  app: AppInstance,
  request: FastifyRequest,
  key: string,
): Promise<void> {
  try {
    await app.storage.deleteObject(key);
  } catch (error) {
    request.log.warn(
      { event: 'upload_staging_orphan', error_class: errorClass(error) },
      'не удалось удалить незавершённую загрузку',
    );
  }
}

// =====================================================================
// Порядок файлов
// =====================================================================

function registerOrderRoute(app: AppInstance): void {
  app.put(
    `${PREFIX}/revisions/:revisionId/files/order`,
    {
      preHandler: uploadFiles,
      schema: {
        params: revisionIdParamSchema,
        body: fileOrderBodySchema,
        response: { 200: sourceFileListSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await reorderSourceFiles(
        app.db,
        scope,
        request.params.revisionId,
        request.body.fileIds,
        auditActor(app, request),
      );
      return reply.code(200).send({ items: [...items] });
    },
  );
}

// =====================================================================
// Удаление файла из черновика
// =====================================================================

/**
 * Маршрут объявлен через `app.route`, а не `app.delete`.
 *
 * Так же, как остальные DELETE портала: eslint-правило, запрещающее запросы к БД
 * вне `db/repositories/`, ищет вызовы `.delete()` по имени метода и не различает
 * `db.delete` от `app.delete`.
 */
function registerDeleteRoute(app: AppInstance): void {
  app.route({
    method: 'DELETE',
    url: `${PREFIX}/revisions/:revisionId/files/:fileId`,
    preHandler: uploadFiles,
    schema: { params: revisionFileParamSchema },
    handler: async (request, reply) => {
      const { scope } = currentAuth(request);
      const removed = await deleteSourceFile(
        app.db,
        scope,
        request.params.revisionId,
        request.params.fileId,
        auditActor(app, request),
      );
      if (!removed) throw notFound('Файл не найден.');
      return reply.code(204).send();
    },
  });
}

// =====================================================================
// Выдача содержимого с поддержкой Range
// =====================================================================

function registerContentRoute(app: AppInstance): void {
  app.get(
    `${PREFIX}/files/:fileId/content`,
    { preHandler: readFiles, schema: { params: fileIdParamSchema } },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const file = await findFileContent(app.db, scope, request.params.fileId);
      if (file === null) throw notFound('Файл не найден.');
      updateContext({ revisionId: file.revisionId, objectId: file.objectId });

      if (file.verifyState !== 'ok') {
        // Карантин виден в списке вместе с причиной; байты не раздаются.
        throw conflict('Файл не прошёл проверку, его содержимое недоступно.');
      }

      const requested = parseRangeHeader(request.headers.range, file.sizeBytes);
      if (requested === 'unsatisfiable') {
        return reply
          .code(416)
          .header('content-range', `bytes */${file.sizeBytes}`)
          .header('accept-ranges', 'bytes')
          .send();
      }

      const object = await app.storage.getObjectStream(file.storageKey, requested ?? undefined);
      // Решение о 206 принимается по тому, что хранилище ОТДАЛО, а не по тому,
      // что попросил клиент: RFC 9110 разрешает серверу вернуть объект целиком,
      // и тогда пара «206 + Content-Range» описывала бы не то тело, которое
      // едет в ответе, — pdf.js собрал бы из таких кусков испорченный документ.
      const served = object.range;

      reply
        .header('accept-ranges', 'bytes')
        .header('content-type', file.mime)
        .header('content-length', String(object.contentLength))
        .header('content-disposition', contentDisposition(file.fileName))
        // Хэш содержимого — естественный сильный ETag: содержимое неизменяемо,
        // поэтому значение не может устареть.
        .header('etag', `"${file.sha256}"`);

      if (served !== null) {
        reply
          .code(206)
          .header('content-range', `bytes ${served.start}-${served.end}/${object.sizeBytes}`);
      }

      return reply.send(object.stream);
    },
  );
}

// =====================================================================
// Приём байтов драйвером `local` (только разработка)
// =====================================================================

/**
 * Маршрут существует только при `STORAGE_DRIVER=local`.
 *
 * Сессия здесь не требуется — как и у настоящего presigned PUT: клиент,
 * заливающий 200 МБ, не должен для этого держать cookie. Право на запись даёт
 * подписанный сервером токен, ограниченный одним ключом и сроком. В продакшне
 * этого пути нет вовсе: `env.ts` запрещает драйвер `local`, и тогда
 * `storage.localUploads` не определён.
 *
 * Разбор тела отключён собственным парсером внутри инкапсулированного плагина:
 * иначе Fastify либо ответил бы 415 на `application/pdf`, либо собрал бы 200 МБ
 * в память ради того, чтобы тут же записать их в поток.
 */
function registerLocalUploadRoute(app: AppInstance): void {
  const sink = app.storage.localUploads;
  if (sink === undefined) return;

  const maxBytes = app.env.MAX_UPLOAD_BYTES;

  void app.register((instance, _options, done) => {
    // Свой провайдер типов у вложенного экземпляра приходится объявлять заново:
    // `register()` в типах Fastify не переносит его из родителя.
    const scope = instance.withTypeProvider<ZodTypeProvider>();

    scope.addContentTypeParser('*', (_request, payload, next) => {
      next(null, payload);
    });

    scope.put(
      LOCAL_UPLOAD_PATH,
      { schema: { querystring: localUploadQuerySchema }, bodyLimit: maxBytes },
      async (request, reply) => {
        const grant = sink.verifyToken(request.query.token);
        if (grant === null) throw forbidden('Ссылка на загрузку недействительна или истекла.');

        const declared = Number(request.headers['content-length'] ?? '');
        if (Number.isFinite(declared) && declared > grant.maxBytes) throw tooLarge(grant.maxBytes);

        try {
          await app.storage.putObject({
            key: grant.key,
            body: limitStream(request.body as Readable, grant.maxBytes),
            contentType: 'application/octet-stream',
          });
        } catch (error) {
          if (error instanceof UploadTooLargeError) throw tooLarge(grant.maxBytes);
          throw error;
        }

        return reply.code(200).send();
      },
    );

    done();
  });
}

/**
 * Поток с жёстким потолком.
 *
 * `Content-Length` заявляет клиент, поэтому проверка заявленного значения — это
 * удобство, а не защита: настоящий предел считается по фактически прочитанным
 * байтам.
 */
function limitStream(source: Readable, maxBytes: number): Readable {
  return Readable.from(
    (async function* limited() {
      let total = 0;
      for await (const chunk of source) {
        const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.byteLength;
        if (total > maxBytes) throw new UploadTooLargeError(maxBytes);
        yield buffer;
      }
    })(),
  );
}

// =====================================================================
// Общее
// =====================================================================

async function requireVisibleRevision(
  app: AppInstance,
  request: FastifyRequest,
  revisionId: string,
): Promise<void> {
  const { scope } = currentAuth(request);
  if ((await findRevisionForFiles(app.db, scope, revisionId)) === null) {
    throw notFound('Ревизия поставки не найдена.');
  }
}

/**
 * Данные актора для `audit_log`.
 *
 * Идентификатор пользователя сюда не входит: его репозиторий берёт из области
 * видимости, поэтому подставить в журнал чужого актора обработчик не может.
 */
function auditActor(app: AppInstance, request: FastifyRequest): AuditActor {
  const auth = currentAuth(request);
  return {
    emailHmac: auditEmailHmac(app.env.AUDIT_HMAC_KEY, auth.user.email),
    ip: request.ip,
    requestId: request.id,
  };
}

function tooLarge(maxBytes: number): HttpProblem {
  return new HttpProblem(413, titleForStatus(413), {
    slug: 'payload-too-large',
    detail: `Размер файла превышает разрешённые ${maxBytes} байт.`,
  });
}

function errorClass(error: unknown): string {
  if (isStorageError(error)) return `StorageError:${error.code}`;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Разбор заголовка `Range`.
 *
 * `null` — отдать объект целиком, `'unsatisfiable'` — 416. Непонятный или
 * составной диапазон трактуется как отсутствие заголовка: RFC 9110 разрешает
 * серверу проигнорировать `Range`, а `multipart/byteranges` pdf.js не требует.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (header === undefined || !header.startsWith('bytes=')) return null;

  const spec = header.slice('bytes='.length).trim();
  if (spec.includes(',')) return null;

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match === null) return null;

  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (size === 0) return 'unsatisfiable';

  if (rawStart === '') {
    // Суффиксная форма `bytes=-500`: последние N байт.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * Человекочитаемое имя в заголовке ответа.
 *
 * Две формы обязательны: `filename` для клиентов, не понимающих RFC 5987, и
 * `filename*` с процентным кодированием для кириллицы. ASCII-форма чистится от
 * кавычек и обратных слэшей — иначе имя файла разрывает заголовок.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
