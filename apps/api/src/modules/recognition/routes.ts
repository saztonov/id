/**
 * Кнопка «Отправить на распознавание» и чтение прогонов (§6.2, §14).
 *
 * ## Действие пользователя кладёт строку в `jobs`
 *
 * Это прямой урок S5, где обработчики задач существовали, а в очередь их не
 * ставил никто. Поэтому `POST .../recognize` создаёт строку `recognition_runs`
 * И ставит `layout.reconcile`, а тест проверяет именно таблицу `jobs`.
 *
 * ## Почему `frozenLayoutId` обязателен и явен
 *
 * §14 требует явного идентификатора замороженной разметки, и это не
 * формальность: между открытием экрана и нажатием кнопки могла быть заморожена
 * следующая ревизия. «Возьми текущую» распознало бы не то, что видел человек, и
 * узналось бы это только по несовпадению координат в результатах.
 *
 * ## `Idempotency-Key`
 *
 * Заголовок обязателен (§14), но он ВТОРОЙ рубеж, а не единственный. Первый —
 * доменный инвариант: незавершённый прогон по этой ревизии разметки один, и
 * повторный запрос возвращает его же. Заголовок входит в ключ дедупликации
 * задачи и потому дополнительно не даёт удвоить очередь, пока первая задача
 * ещё не выполнена.
 *
 * ## Права и область видимости
 *
 * Запуск — `recognition.start` (подрядчик и инженер, §4.1), чтение прогонов,
 * артефактов и текста страниц — `markup.read`. Область применяется в
 * репозитории на КАЖДОМ пути, включая выдачу байтов артефакта: ключ объекта в
 * хранилище выдаёт только запрос, прошедший `withScope()`.
 *
 * ## Выдача содержимого артефакта санируется, а сырой архив закрыт правом
 *
 * Производные виды (`md`, `html`, `qa`) несут БЕССРОЧНЫЕ подписанные ссылки на
 * кропы RD WEB, и §11 относит такой URL к значениям, подлежащим redaction.
 * Поэтому наружу они уходят через `redactArtifactContent()` — тем же правилом,
 * которым вырезаются ссылки из `page_text_versions.text_md`. Сырой `zip`
 * санировать нельзя (его байты описываются `artifact_sha256`, ADR-0005 п. 4),
 * поэтому он закрыт правом `diagnostics.read`: архив — это доказательство
 * целиком, его читатель — администратор на экране диагностики, а не подрядчик,
 * которому нужен текст. Список артефактов с хэшами и размерами остаётся
 * доступным как раньше: ссылок он не содержит.
 */
import type { AppInstance } from '../../app.js';
import { forbidden, internal, notFound } from '../../lib/problem.js';
import { requireIdempotencyKey } from '../../lib/http-headers.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { hasPermission, requirePermission } from '../../middleware/require-permission.js';
import { sha256Hex } from '../../pdf/probe.js';
import { isRedactableArtifactKind, redactArtifactContent } from '../../recognition/redaction.js';
import { updateContext } from '../../observability/context.js';
import {
  findArtifact,
  findRecognitionRun,
  listArtifacts,
  listBlockResults,
  listPageTexts,
  listRecognitionRuns,
  type RecognitionRunView,
} from '../../db/repositories/recognition.js';
import { startRecognition } from './start.js';
import {
  artifactListSchema,
  artifactParamSchema,
  blockResultListSchema,
  pageTextListSchema,
  recognitionRunListSchema,
  recognitionRunViewSchema,
  recognizeRequestSchema,
  recognizeResponseSchema,
  revisionIdParamSchema,
  runIdParamSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const requireRecognitionStart = requirePermission('recognition.start');
const readRecognition = requirePermission('markup.read');

/** MIME артефактов: их вид закрыт перечислением, поэтому и таблица закрыта. */
const ARTIFACT_CONTENT_TYPE: Readonly<Record<string, string>> = {
  zip: 'application/zip',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  blocks_json: 'application/json; charset=utf-8',
  qa: 'application/json; charset=utf-8',
  canonical: 'application/json; charset=utf-8',
};

export function registerRecognitionRoutes(app: AppInstance): void {
  registerStartRoute(app);
  registerReadRoutes(app);
  registerArtifactRoutes(app);
}

function toView(run: RecognitionRunView) {
  return {
    id: run.id,
    revisionId: run.revisionId,
    layoutRevisionId: run.layoutRevisionId,
    rdJobId: run.rdJobId,
    localLayoutHash: run.localLayoutHash,
    remoteLayoutHashBefore: run.remoteLayoutHashBefore,
    remoteLayoutHashAfter: run.remoteLayoutHashAfter,
    workingPdfSha256: run.workingPdfSha256,
    settingsSnapshot: run.settingsSnapshot,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts: run.counts,
    warnings: [...run.warnings],
    runDocumentClosedAt: run.runDocumentClosedAt,
  };
}

// =====================================================================
// Запуск
// =====================================================================

function registerStartRoute(app: AppInstance): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/recognize`,
    {
      preHandler: requireRecognitionStart,
      schema: {
        params: revisionIdParamSchema,
        body: recognizeRequestSchema,
        response: { 202: recognizeResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;
      const idempotencyKey = requireIdempotencyKey(request);
      updateContext({ revisionId });

      // Гранулярный маршрут ручного пути: он ставит РАСПОЗНАВАНИЕ и ничего
      // больше. Анализ дальше не идёт — его инженер запускает своей кнопкой,
      // как и до S21. Сквозной прогон живёт в `POST /revisions/{id}/check`.
      const started = await startRecognition(app.db, app.env, scope, {
        revisionId,
        frozenLayoutId: request.body.frozenLayoutId,
        idempotencyKey,
        autoContinue: false,
      });

      request.log.info(
        {
          event: 'job_enqueued',
          job_id: started.jobId,
          created: started.jobCreated,
          recognition_run_id: started.recognitionRunId,
          run_created: started.created,
        },
        'цепочка распознавания поставлена в очередь',
      );

      return reply.code(202).send(started);
    },
  );
}

// =====================================================================
// Чтение
// =====================================================================

function registerReadRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/revisions/:revisionId/recognition-runs`,
    {
      preHandler: readRecognition,
      schema: { params: revisionIdParamSchema, response: { 200: recognitionRunListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listRecognitionRuns(app.db, scope, request.params.revisionId);
      return reply.code(200).send({ items: items.map(toView) });
    },
  );

  app.get(
    `${PREFIX}/recognition-runs/:runId`,
    {
      preHandler: readRecognition,
      schema: { params: runIdParamSchema, response: { 200: recognitionRunViewSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const run = await findRecognitionRun(app.db, scope, request.params.runId);
      if (run === null) throw notFound('Прогон распознавания не найден.');
      updateContext({ revisionId: run.revisionId, objectId: run.objectId });
      return reply.code(200).send(toView(run));
    },
  );

  app.get(
    `${PREFIX}/recognition-runs/:runId/pages`,
    {
      preHandler: readRecognition,
      schema: { params: runIdParamSchema, response: { 200: pageTextListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listPageTexts(app.db, scope, request.params.runId);
      return reply.code(200).send({
        items: items.map((page) => ({
          id: page.id,
          sourcePageId: page.sourcePageId,
          workingPageIndex: page.workingPageIndex,
          artifactVersionId: page.artifactVersionId,
          textMd: page.textMd,
          textSha256: page.textSha256,
          offsetConvention: 'utf16-code-unit' as const,
        })),
      });
    },
  );

  app.get(
    `${PREFIX}/recognition-runs/:runId/blocks`,
    {
      preHandler: readRecognition,
      schema: { params: runIdParamSchema, response: { 200: blockResultListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listBlockResults(app.db, scope, request.params.runId);
      return reply.code(200).send({ items: items.map((item) => ({ ...item })) });
    },
  );
}

// =====================================================================
// Артефакты
// =====================================================================

function registerArtifactRoutes(app: AppInstance): void {
  app.get(
    `${PREFIX}/recognition-runs/:runId/artifacts`,
    {
      preHandler: readRecognition,
      schema: { params: runIdParamSchema, response: { 200: artifactListSchema } },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const items = await listArtifacts(app.db, scope, request.params.runId);
      return reply.code(200).send({
        items: items.map((artifact) => ({
          id: artifact.id,
          recognitionRunId: artifact.recognitionRunId,
          kind: artifact.kind,
          // `s3Key` наружу не отдаётся: знание ключа — это не право доступа, но
          // и рассказывать раскладку хранилища клиенту незачем (§13).
          artifactSha256: artifact.artifactSha256,
          byteSize: artifact.byteSize,
        })),
      });
    },
  );

  /**
   * Выдача содержимого артефакта — через наш эндпоинт, с санацией.
   *
   * Presigned GET в браузер не выдаётся (§4.2): он утекает в историю и обходит
   * RBAC на время TTL. Область видимости здесь та же, что у метаданных: ключ
   * объекта появляется только после `findArtifact()` с областью, поэтому
   * подрядчик не получит чужой файл, даже зная идентификатор прогона.
   *
   * Два разных ответа для двух разных вопросов:
   *
   * - производный вид (`md`, `html`, `qa`) читается целиком, санируется и
   *   отдаётся телом. Заголовок `x-artifact-sha256` при этом описывает
   *   ХРАНИМЫЙ артефакт, а `x-artifact-content-sha256` — фактически отданные
   *   байты: без второго получатель считал бы, что тело не сошлось с хэшем;
   * - `zip` отдаётся байт в байт и только по праву `diagnostics.read`.
   */
  app.get(
    `${PREFIX}/recognition-runs/:runId/artifacts/:kind/content`,
    {
      preHandler: readRecognition,
      schema: { params: artifactParamSchema },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { runId, kind } = request.params;

      // Право проверяется ДО чтения строки артефакта: «нет прав» и «нет
      // артефакта» — разные ответы, и первый не должен зависеть от второго.
      if (!isRedactableArtifactKind(kind)) {
        if (!hasPermission(request.authContext?.roles ?? [], 'diagnostics.read')) {
          throw forbidden('Сырой архив экспорта доступен только на экране диагностики.', {
            logDetail: `отказано в выдаче сырого артефакта ${kind} по праву diagnostics.read`,
          });
        }
      }

      const artifact = await findArtifact(app.db, scope, runId, kind);
      if (artifact === null) throw notFound('Артефакт прогона не найден.');

      const contentType = ARTIFACT_CONTENT_TYPE[kind] ?? 'application/octet-stream';
      const disposition = `attachment; filename="${runId}.${kind}"`;

      if (!isRedactableArtifactKind(kind)) {
        const object = await app.storage.getObjectStream(artifact.s3Key);
        return reply
          .header('content-type', contentType)
          .header('content-length', String(object.sizeBytes))
          .header('content-disposition', disposition)
          .header('x-artifact-sha256', artifact.artifactSha256)
          .header('cache-control', 'private, no-store')
          .send(object.stream);
      }

      const raw = await readArtifactBytes(app, artifact.s3Key, artifact.byteSize);
      const redacted = redactArtifactContent(kind, raw);
      request.log.info(
        {
          event: 'artifact_content_redacted',
          recognition_run_id: runId,
          artifact_kind: kind,
          redactions: redacted.count,
        },
        'содержимое производного артефакта отдано санированным',
      );

      return (
        reply
          .header('content-type', contentType)
          .header('content-length', String(redacted.bytes.byteLength))
          .header('content-disposition', disposition)
          // Хэш ХРАНИМОГО артефакта: он же в `artifact_versions` и в списке.
          .header('x-artifact-sha256', artifact.artifactSha256)
          // Хэш ОТДАННЫХ байт: тело санировано и хранимому хэшу не равно.
          .header('x-artifact-content-sha256', sha256Hex(redacted.bytes))
          .header('x-artifact-redacted', String(redacted.count))
          .header('cache-control', 'private, no-store')
          .send(redacted.bytes)
      );
    },
  );
}

/**
 * Потолок чтения производного артефакта в память.
 *
 * Санация — операция над содержимым целиком (разбор JSON, вырезание строк), и
 * потоковой её сделать нельзя честно. Потолок здесь по той же причине, что и у
 * приёма файлов (§4.2): объект может «весить» не столько, сколько заявляет, и
 * heap процесса не отдаётся тому, кто положил объект в бакет. Производный
 * артефакт 83-страничного комплекта — это единицы мегабайт.
 */
const MAX_REDACTED_ARTIFACT_BYTES = 64 * 1024 * 1024;

async function readArtifactBytes(
  app: AppInstance,
  key: string,
  declaredSize: number,
): Promise<Buffer> {
  if (declaredSize > MAX_REDACTED_ARTIFACT_BYTES) {
    throw internal({
      logDetail: `артефакт ${key} размером ${declaredSize} Б не помещается в потолок санации`,
    });
  }
  const object = await app.storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.stream) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_REDACTED_ARTIFACT_BYTES) {
      object.stream.destroy();
      throw internal({ logDetail: `артефакт ${key} длиннее заявленного размера` });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
