/**
 * Запуск распознавания и выгрузка результата — по `routes/recognition_jobs.py`,
 * `routes/_recognition_job_schemas.py` и `routes/exports.py`.
 *
 * Полноценного распознавания у двойника нет и быть не должно: его доводит S7. Здесь
 * закреплены только форма `JobOut`, момент появления экспорта (`has_export`) и коды
 * отказов — то, на что адаптер опирается уже сейчас.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { conflict, notFound, unprocessable } from './errors.js';
import { buildStoredZip } from './pdf.js';
import { parseBody, requireUser } from './routes-auth.js';
import { requireDocument } from './routes-documents.js';
import type { FakeState, JobOut, JobRecord, JobScopeName } from './state.js';

const jobScopes = [
  'selected',
  'all',
  'unrecognized',
  'failed',
] as const satisfies readonly JobScopeName[];

const jobCreateSchema = z.object({
  document_id: z.string().min(1),
  scope: z.enum(jobScopes),
  block_ids: z.array(z.string()).nullish(),
  priority: z.number().int().default(0),
  verification: z.boolean().default(false),
  idempotency_key: z.string().nullish(),
  document_mode: z.boolean().default(false),
  settings: z.record(z.string(), z.unknown()),
});

/** Готов ли экспорт: `has_export` у оригинала = «QA-манифест финализирован». */
function isCompleted(state: FakeState, job: JobRecord): boolean {
  return job.polls > state.renderDelayPolls;
}

function jobOut(state: FakeState, job: JobRecord): JobOut {
  const completed = isCompleted(state, job);
  const total = job.blockIds.length;
  const document = state.documents.get(job.documentId);
  return {
    job_id: job.jobId,
    project_id: job.projectId,
    document_id: job.documentId,
    scope: job.scope,
    // `done` — значение из `JobStatus`; отдельного `completed` в домене нет.
    status: completed ? 'done' : 'running',
    priority: job.priority,
    total_blocks: total,
    queued_blocks: completed ? 0 : total,
    running_blocks: 0,
    recognized_blocks: completed ? total : 0,
    failed_blocks: 0,
    non_retriable_blocks: 0,
    settings: job.settings,
    created_by: job.createdBy,
    created_by_email: null,
    created_at: job.createdAt,
    started_at: job.createdAt,
    updated_at: state.now(),
    completed_at: completed ? state.now() : null,
    error_message: null,
    has_export: completed,
    document_name: document?.fileName ?? null,
    page_count: document?.pageCount ?? null,
    processing_ms: completed ? total * 1000 : null,
  };
}

export function registerJobRoutes(app: FastifyInstance, state: FakeState): void {
  const createJob = (request: FastifyRequest) => {
    const user = requireUser(state, request);
    const body = parseBody(jobCreateSchema, request.body);
    const document = requireDocument(state, body.document_id);
    if (Object.keys(body.settings).length === 0) {
      throw unprocessable('settings не должен быть пустым (нужен выбор хотя бы для одного типа)');
    }
    const documentBlocks = state.blocksOf(document.documentId);
    let blockIds: string[];
    if (body.scope === 'selected') {
      const requested = body.block_ids ?? [];
      if (requested.length === 0) {
        throw unprocessable('scope=selected требует непустой block_ids');
      }
      blockIds = documentBlocks
        .filter((b) => requested.includes(b.block_id))
        .map((b) => b.block_id);
    } else if (body.scope === 'failed') {
      blockIds = documentBlocks
        .filter((b) => b.status === 'failed' || b.status === 'non_retriable')
        .map((b) => b.block_id);
    } else if (body.scope === 'unrecognized') {
      blockIds = documentBlocks.filter((b) => b.status !== 'recognized').map((b) => b.block_id);
    } else {
      blockIds = documentBlocks.map((b) => b.block_id);
    }
    const job: JobRecord = {
      jobId: state.newId('job'),
      projectId: document.projectId,
      documentId: document.documentId,
      scope: body.scope,
      priority: body.priority,
      settings: body.settings,
      blockIds,
      createdBy: user.userId,
      createdAt: state.now(),
      polls: 0,
    };
    state.jobs.set(job.jobId, job);
    return {
      job: jobOut(state, job),
      counts: {},
      skipped_block_ids: [],
      dropped_by_type: {},
    };
  };

  const requireJob = (jobId: string): JobRecord => {
    const job = state.jobs.get(jobId);
    if (job === undefined) {
      throw notFound('Задание не найдено');
    }
    return job;
  };

  // Оба пути ведут в один обработчик: `/api/jobs` — путь, которым пользуется портал,
  // `/api/recognition/jobs` — фактический префикс роутера legacy-сервиса.
  for (const prefix of ['/api/jobs', '/api/recognition/jobs']) {
    app.post(prefix, async (request, reply) => reply.code(201).send(createJob(request)));

    app.get(`${prefix}/:job_id`, async (request) => {
      requireUser(state, request);
      const params = request.params as { job_id: string };
      const job = requireJob(params.job_id);
      job.polls += 1;
      return jobOut(state, job);
    });
  }

  app.get('/api/exports/jobs/:job_id/zip', async (request, reply) => {
    requireUser(state, request);
    const params = request.params as { job_id: string };
    const job = requireJob(params.job_id);
    if (!isCompleted(state, job)) {
      throw conflict('Экспорт ещё не готов (job не финализирован)');
    }
    // Содержимое детерминировано по job_id: побайтово одинаковая выдача на повторный
    // запрос — необходимое условие для проверки идемпотентности загрузки в портале.
    const payload = Buffer.from(`fake-rdweb export for ${job.jobId}\n`, 'utf8');
    const zip = buildStoredZip('document.md', payload);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${job.jobId}.zip"`)
      .send(zip);
  });
}
