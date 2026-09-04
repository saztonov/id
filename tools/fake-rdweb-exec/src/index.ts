/**
 * Офлайн-двойник контура RD WEB `/api/executive/v1` (контракт document-sync v1).
 *
 * ## Зачем настоящий сервер, а не мок `fetch`
 *
 * Мокая `fetch` внутри адаптера, проверяешь код мока, а не соблюдение проводного
 * контракта: коды ответов, порядок проверок §9, форму тела, поведение
 * идемпотентности и поллинга. Поэтому двойник поднимает НАСТОЯЩИЙ HTTP на
 * случайном порту и отвечает телами, описанными в контракте.
 *
 * ## Что он доказывает про канонизацию — и чего НЕ доказывает
 *
 * Двойник пересчитывает `manifest_sha256` присланного тела и отвергает
 * расхождение `422 invalid_manifest`. Это ловит настоящий класс дефекта:
 * недетерминированную сборку снимка, когда отправленное тело перестаёт
 * описываться собственным манифестом.
 *
 * Но соответствия НАШЕЙ канонизации канонизации RD WEB это не доказывает: обе
 * стороны здесь считают одним и тем же кодом. Соответствие доказывается только
 * эталонными примерами `contracts/executive_sync/v1/fixtures.json`, которые
 * запрошены у команды и пока не переданы. Пока их нет, эта дыра открыта, и
 * закрывать её видимостью зелёного теста нельзя.
 *
 * ## Границы
 *
 * Это не эмулятор RD WEB: настоящего распознавания, выбора модели, админки и
 * ручки `/plan` здесь нет. Есть ровно тот срез, который трогает портал.
 */
import { createHash, randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import {
  execSyncSnapshotBodySchema,
  manifestSha256,
  type ExecSyncSnapshotBody,
} from '@id/execsync';

import { EMPTY_FAULTS, FakeExecState, type FakeExecFaults, type ResultFactory } from './state.js';

export type { BlockStatus, FakeExecFaults, ReconciliationAction, ResultFactory } from './state.js';

/** Загрузка идёт телом PUT, поэтому потолок тела поднят под реальный PDF. */
const BODY_LIMIT_BYTES = 300 * 1024 * 1024;
const DEFAULT_POLLS_BEFORE_TERMINAL = 1;

export interface FakeExecOptions {
  /** Удостоверение, которое двойник считает действующим. */
  readonly token?: string;
  /** Области действия удостоверения (§«Удостоверение»). */
  readonly scopes?: readonly string[];
  /**
   * Разрешённые проекты. Пустой список означает «ни одного», а не «все», —
   * контракт говорит об этом прямо, и двойник обязан вести себя так же.
   */
  readonly projects?: readonly string[];
  /** Сколько раз состояние отвечает нетерминальным до завершения. */
  readonly pollsBeforeTerminal?: number;
  /** Чем наполняются результаты блоков. */
  readonly resultFactory?: ResultFactory;
}

export interface FakeExecSync {
  readonly url: string;
  readonly calls: readonly { method: string; path: string; requestId: string | null }[];
  setFaults(faults: Partial<FakeExecFaults>): void;
  /** Снимок состояния: документы и их блоки — только чтение. */
  snapshot(): {
    documents: {
      externalDocumentId: string;
      generation: number;
      blocks: {
        externalBlockId: string;
        revision: number;
        status: string;
        action: string;
        deleted: boolean;
      }[];
    }[];
    syncs: { externalSyncId: string; state: string; generation: number }[];
  };
  close(): Promise<void>;
}

const DEFAULT_TOKEN = 'rdext_fake_token';
const DEFAULT_SCOPES = ['executive:sync:init', 'executive:sync:complete', 'executive:sync:read'];

interface Detail {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function fail(status: number, code: string, message: string): Detail {
  return { status, code, message };
}

export async function startFakeExecSync(options: FakeExecOptions = {}): Promise<FakeExecSync> {
  const token = options.token ?? DEFAULT_TOKEN;
  const scopes = new Set(options.scopes ?? DEFAULT_SCOPES);
  const projects = new Set(options.projects ?? ['idp-object-1']);
  const state = new FakeExecState(options.pollsBeforeTerminal ?? DEFAULT_POLLS_BEFORE_TERMINAL);
  if (options.resultFactory !== undefined) state.resultFactory = options.resultFactory;

  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  // Тело presigned PUT приходит с произвольным content-type: без универсального
  // парсера fastify ответил бы 415 раньше обработчика.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.addHook('onRequest', async (request) => {
    const requestId = request.headers['x-request-id'];
    state.calls.push({
      method: request.method,
      path: request.url,
      requestId: typeof requestId === 'string' ? requestId : null,
    });
  });

  const authorize = (auth: string | undefined, scope: string): Detail | null => {
    if (auth !== `Bearer ${token}`) {
      return fail(401, 'invalid_principal', 'Удостоверение неверно или отозвано.');
    }
    if (!scopes.has(scope)) {
      return fail(403, 'scope_forbidden', `У токена нет области действия ${scope}.`);
    }
    return null;
  };

  const prefix = '/api/executive/v1';

  // --- Шаг 1: init ---------------------------------------------------------
  app.post(`${prefix}/document-syncs/init`, async (request, reply) => {
    const denied = authorize(request.headers.authorization, 'executive:sync:init');
    if (denied !== null) return reply.code(denied.status).send({ detail: denied });

    if (state.faults.rateLimitNextInit !== null) {
      const seconds = state.faults.rateLimitNextInit;
      state.faults = { ...state.faults, rateLimitNextInit: null };
      return reply
        .code(429)
        .header('retry-after', String(seconds))
        .send({ detail: fail(429, 'rate_limited', 'Слишком много запросов.') });
    }

    const raw = request.body as Record<string, unknown>;
    const sentManifest = raw['manifest_sha256'];
    const parsed = execSyncSnapshotBodySchema.safeParse(raw);
    if (!parsed.success) {
      return reply.code(422).send({
        detail: fail(422, 'invalid_manifest', parsed.error.issues[0]?.message ?? 'Негодное тело.'),
      });
    }
    const body: ExecSyncSnapshotBody = parsed.data;

    if (!projects.has(body.external_project_id)) {
      return reply.code(403).send({
        detail: fail(403, 'project_forbidden', 'Проект не в списке разрешённых для токена.'),
      });
    }

    /*
     * Манифест обязан описывать присланное тело.
     *
     * Расхождение здесь означает, что сборка снимка недетерминирована: клиент
     * посчитал хеш по одному телу, а отправил другое. Настоящий сервер отвечает
     * на это `invalid_manifest`, и двойник обязан вести себя так же — иначе
     * дефект дожил бы до боевого токена.
     */
    const expected = manifestSha256(body);
    if (sentManifest !== expected) {
      return reply.code(422).send({
        detail: fail(
          422,
          'invalid_manifest',
          `manifest_sha256 не описывает тело: ожидался ${expected}.`,
        ),
      });
    }

    const bodyHash = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
    const document = state.documentOf(body);

    // Идемпотентность и конфликты §9. Порядок проверок значим: «вы отстали»
    // побеждает «вы противоречите».
    const previousBody = state.bodiesBySyncId.get(body.external_sync_id);
    if (previousBody !== undefined) {
      if (previousBody !== bodyHash) {
        return reply.code(409).send({
          detail: fail(409, 'sync_identity_conflict', 'Тот же external_sync_id с другим телом.'),
        });
      }
      const existing = [...state.syncs.values()].find(
        (sync) => sync.externalSyncId === body.external_sync_id,
      );
      if (existing !== undefined) {
        return reply.send({
          sync_id: existing.syncId,
          duplicate: true,
          upload_required: existing.uploadRequired && !existing.uploaded,
          state: existing.state,
          upload:
            existing.uploadRequired && !existing.uploaded
              ? uploadTicket(existing.uploadToken ?? issueUpload(existing.syncId))
              : null,
        });
      }
    }

    if (body.sync_generation <= document.generation) {
      return reply.code(409).send({
        detail: fail(409, 'stale_generation', 'sync_generation не больше текущей серверной.'),
      });
    }
    if (body.base_generation < document.generation) {
      return reply.code(409).send({
        detail: fail(409, 'stale_base_generation', 'base_generation отстала от серверной.'),
      });
    }
    for (const block of body.blocks) {
      const declared = document.blocks.get(block.external_block_id);
      if (declared === undefined) continue;
      if (block.revision < declared.revision) {
        return reply.code(409).send({
          detail: fail(409, 'block_revision_conflict', 'Ревизия блока меньше объявленной.'),
        });
      }
    }

    state.reconcile(document, body);

    const syncId = randomUUID();
    const uploadRequired = !document.knownPdfSha.has(body.document.sha256);
    const uploadToken = uploadRequired ? issueUpload(syncId) : null;
    state.syncs.set(syncId, {
      syncId,
      externalSyncId: body.external_sync_id,
      externalDocumentId: body.external_document_id,
      manifestSha256: expected,
      syncGeneration: body.sync_generation,
      baseGeneration: body.base_generation,
      documentSha256: body.document.sha256,
      state: uploadRequired ? 'uploading' : 'uploaded',
      uploadToken,
      uploadRequired,
      uploaded: !uploadRequired,
      pollsLeft: state.pollsBeforeTerminal,
      counters: {},
    });
    state.bodiesBySyncId.set(body.external_sync_id, bodyHash);
    document.generation = body.sync_generation;

    return reply.send({
      sync_id: syncId,
      duplicate: false,
      upload_required: uploadRequired,
      state: uploadRequired ? 'uploading' : 'uploaded',
      upload: uploadToken === null ? null : uploadTicket(uploadToken),
    });
  });

  function issueUpload(syncId: string): string {
    const uploadToken = randomUUID();
    state.uploads.set(uploadToken, { syncId, sha256: null });
    return uploadToken;
  }

  function uploadTicket(uploadToken: string): Record<string, unknown> {
    return {
      method: 'PUT',
      url: `${baseUrl()}/uploads/${uploadToken}`,
      required_headers: {},
      expires_in: 3600,
    };
  }

  // --- Шаг 2: загрузка -----------------------------------------------------
  app.put('/uploads/:uploadToken', async (request, reply) => {
    const { uploadToken } = request.params as { uploadToken: string };
    const slot = state.uploads.get(uploadToken);
    if (slot === undefined) {
      return reply.code(404).send({ detail: fail(404, 'sync_not_found', 'Талон неизвестен.') });
    }
    const bytes = request.body as Buffer;
    slot.sha256 = createHash('sha256').update(bytes).digest('hex');
    const sync = state.syncs.get(slot.syncId);
    if (sync !== undefined) {
      sync.uploaded = slot.sha256 === sync.documentSha256;
      sync.state = sync.uploaded ? 'uploaded' : 'uploading';
    }
    return reply.code(200).send({});
  });

  // --- Шаг 3: complete -----------------------------------------------------
  app.post(`${prefix}/document-syncs/:syncId/complete`, async (request, reply) => {
    const denied = authorize(request.headers.authorization, 'executive:sync:complete');
    if (denied !== null) return reply.code(denied.status).send({ detail: denied });

    const { syncId } = request.params as { syncId: string };
    const sync = state.syncs.get(syncId);
    if (sync === undefined) {
      return reply.code(404).send({ detail: fail(404, 'sync_not_found', 'Отправка неизвестна.') });
    }
    if (sync.uploadRequired && !sync.uploaded) {
      return reply.code(422).send({
        detail: fail(422, 'upload_not_verified', 'PDF не загружен или его хеш не совпал.'),
      });
    }

    const document = state.documents.get(sync.externalDocumentId);
    if (document !== undefined) {
      document.knownPdfSha.add(sync.documentSha256);
    }
    sync.state = 'running';
    return reply.code(200).send({});
  });

  // --- Шаг 4: состояние ----------------------------------------------------
  app.get(`${prefix}/document-syncs/:syncId`, async (request, reply) => {
    const denied = authorize(request.headers.authorization, 'executive:sync:read');
    if (denied !== null) return reply.code(denied.status).send({ detail: denied });

    const { syncId } = request.params as { syncId: string };
    const sync = state.syncs.get(syncId);
    if (sync === undefined) {
      return reply.code(404).send({ detail: fail(404, 'sync_not_found', 'Отправка неизвестна.') });
    }

    if (sync.state === 'running') {
      if (sync.pollsLeft > 0) {
        sync.pollsLeft -= 1;
      } else {
        sync.state = terminalStateOf();
        if (sync.state === 'completed' || sync.state === 'completed_with_issues') {
          const document = state.documents.get(sync.externalDocumentId);
          if (document !== undefined) sync.counters = state.recognize(document);
        }
      }
    }

    const terminal = TERMINAL.has(sync.state);
    return reply.send({
      sync_id: sync.syncId,
      state: sync.state,
      all_terminal: terminal,
      all_successful: sync.state === 'completed',
      counters: sync.counters,
    });
  });

  function terminalStateOf(): string {
    if (state.faults.supersedeNext) {
      state.faults = { ...state.faults, supersedeNext: false };
      return 'superseded';
    }
    if (state.faults.errorNext) {
      state.faults = { ...state.faults, errorNext: false };
      return 'error';
    }
    return 'completed';
  }

  // --- Шаг 5: результаты ---------------------------------------------------
  app.get(`${prefix}/documents/:documentId/blocks`, async (request, reply) => {
    const denied = authorize(request.headers.authorization, 'executive:sync:read');
    if (denied !== null) return reply.code(denied.status).send({ detail: denied });

    const params = request.params as { documentId: string };
    const document = state.documents.get(decodeURIComponent(params.documentId));
    if (document === undefined) {
      return reply
        .code(404)
        .send({ detail: fail(404, 'document_not_found', 'Документ неизвестен.') });
    }

    const items = [...document.blocks.entries()].map(([externalBlockId, block]) => ({
      external_block_id: externalBlockId,
      external_block_revision: block.revision,
      status: block.status,
      is_deleted: block.deleted,
      reconciliation_action: block.action,
      reconciliation_reason: [...block.reason],
      reused_without_model: block.reusedWithoutModel,
      ocr_markdown: block.ocrMarkdown,
      ocr_text: block.ocrMarkdown,
      ocr_json: block.ocrJson,
      result_status: block.status,
      updated_at: new Date().toISOString(),
    }));

    return reply.send({ items, next_cursor: null });
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('двойник RD WEB не получил адрес');
  }
  const url = `http://127.0.0.1:${String(address.port)}`;
  const baseUrl = (): string => url;

  return {
    url,
    calls: state.calls,
    setFaults: (faults) => {
      state.faults = { ...state.faults, ...faults };
    },
    snapshot: () => ({
      documents: [...state.documents.values()].map((document) => ({
        externalDocumentId: document.externalDocumentId,
        generation: document.generation,
        blocks: [...document.blocks.entries()].map(([id, block]) => ({
          externalBlockId: id,
          revision: block.revision,
          status: block.status,
          action: block.action,
          deleted: block.deleted,
        })),
      })),
      syncs: [...state.syncs.values()].map((sync) => ({
        externalSyncId: sync.externalSyncId,
        state: sync.state,
        generation: sync.syncGeneration,
      })),
    }),
    close: async () => {
      await app.close();
    },
  };
}

const TERMINAL = new Set(['completed', 'completed_with_issues', 'superseded', 'canceled', 'error']);

export { EMPTY_FAULTS };
