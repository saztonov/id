/**
 * Распознавание и выгрузка результата — по `routes/recognition_jobs.py`,
 * `routes/_recognition_job_schemas.py`, `routes/exports.py` и
 * `finalizer/render_markdown.py`.
 *
 * ## Что здесь воспроизводится дословно
 *
 * Обязательность `settings` с `provider_type`/`model_id` на каждый тип блока
 * (иначе 422, как у `BlockTypeSelection`), появление экспорта только после
 * «QA-финализации» (`has_export`), 409 на архив до неё, состав архива job'а
 * (`document.md`, `document.html`, `qa_manifest.json` — БЕЗ индекса блоков) и
 * форма Markdown: `## Page N`, `### BLOCK #k [TYPE]: <block_id>` и строки
 * провенанса `> **Created:**`/`> **Crop:**`.
 *
 * ## Подписанная ссылка приезжает во ВСЕХ трёх записях архива
 *
 * Двойник, который мягче оригинала, делает дефект непроверяемым — и именно так
 * и вышло: `renderHtml` не выводил `crop_url` вовсе, поэтому утечка бессрочной
 * подписанной ссылки через выдачу артефакта `html` не ловилась ни одним тестом.
 * У оригинала ссылка есть и в markdown (`render_markdown.py`, строка
 * `> **Crop:** [Crop](<url>)`), и в html (`render_html.py`, блок
 * `<div class="block-crop">…<a href="…">`), а `QaManifest` объявлен с
 * `extra="allow"` и произвольным `checks: dict` (`domain/results.py`) — то есть
 * его схема НЕ запрещает ссылке оказаться и там. Двойник кладёт её во все три
 * записи: правило «наружу подписанная ссылка не выходит» обязано держаться на
 * виде содержимого, а не на вере, что в JSON её не бывает.
 *
 * ## Ручки отказов
 *
 * Две группы. Первая — архив, который не приехал или не разбирается
 * (`neverExport`, `mutateBlocksOnStart`, `truncateExport`, `corruptExport`); на
 * ней проверяются не-деградируемые гейты §1.6. Вторая — архив структурно целый,
 * но описывающий НЕ ТО, что заказано (`dropHtmlEntry`, `dropMarkdownEntry`,
 * `badPageLabel`, `pageLabelOutOfRange`, `emptyMarkdown`,
 * `foreignBlockInMarkdown`, `dropHalfOfBlocks`); на ней проверяется, что нулевой
 * и неполный результат не считается успешным прогоном.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { conflict, notFound, unprocessable } from './errors.js';
import { buildStoredZip } from './pdf.js';
import { parseBody, requireUser } from './routes-auth.js';
import { requireDocument } from './routes-documents.js';
import type {
  BlockOut,
  BlockResultOut,
  FakeState,
  JobOut,
  JobRecord,
  JobScopeName,
} from './state.js';

const jobScopes = [
  'selected',
  'all',
  'unrecognized',
  'failed',
] as const satisfies readonly JobScopeName[];

/** `services/recognition.BlockTypeSelection`: `provider_type` и `model_id` обязательны. */
const blockTypeSelectionSchema = z.object({
  provider_type: z.string().min(1),
  provider_endpoint_id: z.string().nullish(),
  model_id: z.string().min(1),
  prompt_profile_id: z.string().nullish(),
});

const jobCreateSchema = z.object({
  document_id: z.string().min(1),
  scope: z.enum(jobScopes),
  block_ids: z.array(z.string()).nullish(),
  priority: z.number().int().default(0),
  verification: z.boolean().default(false),
  idempotency_key: z.string().nullish(),
  document_mode: z.boolean().default(false),
  settings: z.record(z.string(), blockTypeSelectionSchema),
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
    // Ручка `neverExport` отделяет «job завершён» от «архив собран»: у оригинала
    // это разные факты (статус против `qa_manifest_s3_key`), и портал обязан
    // различать их так же.
    has_export: completed && !state.faults.neverExport,
    document_name: document?.fileName ?? null,
    page_count: document?.pageCount ?? null,
    processing_ms: completed ? total * 1000 : null,
  };
}

/**
 * Текст, который «распознан» для блока.
 *
 * По умолчанию детерминирован по идентификатору блока. Если тесту задан текст
 * страницы (`FakeState.pageTexts`), отдаётся он: это единственный способ
 * провести настоящий текст документа через настоящую цепочку задач. Заданный
 * текст относится к СТРАНИЦЕ, поэтому осмыслен он только в паре с
 * `fullPageBlocks` — иначе один и тот же текст повторился бы у каждого блока
 * страницы и приехал бы в `page_text_versions` многократно.
 */
function recognizedMarkdown(state: FakeState, block: BlockOut): string {
  const injected = state.pageTexts[block.page_index];
  if (typeof injected === 'string') return injected;
  const page = block.page_index + 1;
  return `Синтетический распознанный текст блока ${block.block_id} со страницы ${page}.`;
}

/** Результаты создаются в момент старта job'а: у оригинала их пишет воркер. */
function createResults(state: FakeState, job: JobRecord, modelId: string): void {
  for (const blockId of job.blockIds) {
    const block = state.blocks.get(blockId);
    if (block === undefined) continue;
    const markdown = recognizedMarkdown(state, block);
    const result: BlockResultOut = {
      result_id: state.newId('res'),
      block_id: blockId,
      block_version: block.version,
      job_id: job.jobId,
      task_id: state.newId('tsk'),
      result_type: block.block_type === 'text' ? 'html' : `${block.block_type}_json`,
      status: 'succeeded',
      provider_type: 'lmstudio',
      model_id: modelId,
      prompt_profile_id: null,
      // Уверенность OCR — единственное поле confidence в их API, и оно нужно
      // §9.1: низкая уверенность не имеет права давать `fail`.
      confidence: 0.5 + (block.page_index % 5) / 10,
      ocr_html: `<p>${markdown}</p>`,
      ocr_text: markdown,
      ocr_json: block.block_type === 'text' ? null : { kind: block.block_type },
      ocr_markdown: markdown,
      result_phase: 'recognize',
      is_final: true,
      created_by: job.createdBy,
      created_at: state.now(),
      is_active: true,
    };
    state.blockResults.set(result.result_id, result);
    block.active_result_id = result.result_id;
    block.status = 'recognized';
  }
}

/** Бессрочная подписанная ссылка «формата сайта» (`export_crop_short_url`). */
function cropUrl(baseUrl: string, blockId: string): string {
  return `${baseUrl}/api/crops/${blockId.slice(-12)}`;
}

/**
 * Блоки, попадающие в выходные файлы.
 *
 * STAMP-блок питает штамп-контекст, но собственной секции не имеет — ровно как
 * у оригинала (`iter_markdown_blocks` пропускает STAMP, и `terminal_ids` в
 * `service_export._export` считается по тем же не-STAMP блокам).
 */
function renderableBlocks(state: FakeState, job: JobRecord): readonly BlockOut[] {
  const blocks = state
    .blocksOf(job.documentId)
    .filter((b) => job.blockIds.includes(b.block_id) && b.block_type !== 'stamp');
  // Ручка «экспорт неполон»: половина блоков не доехала до выходных файлов.
  return state.faults.dropHalfOfBlocks ? blocks.filter((_block, index) => index % 2 === 0) : blocks;
}

/** `_page_label` у оригинала — это `page_index + 1`; ручки ломают ровно его. */
function pageLabel(state: FakeState, pageIndex: number): number {
  if (state.faults.badPageLabel) return 0;
  if (state.faults.pageLabelOutOfRange) return pageIndex + 10_000;
  return pageIndex + 1;
}

function markdownSection(
  state: FakeState,
  block: BlockOut,
  ordinal: number,
  baseUrl: string,
): readonly string[] {
  return [
    `### BLOCK #${ordinal} [${block.block_type.toUpperCase()}]: ${block.block_id}`,
    '',
    `> **Created:** ${state.now()}`,
    // Подписанная бессрочная ссылка: именно её портал обязан не сохранять в
    // `page_text_versions` и не отдавать наружу выдачей артефакта.
    `> **Crop:** [Crop](${cropUrl(baseUrl, block.block_id)})`,
    '',
    recognizedMarkdown(state, block),
    '',
  ];
}

/** Markdown экспорта — форма один в один с `finalizer/render_markdown.py`. */
function renderMarkdown(state: FakeState, job: JobRecord, baseUrl: string): string {
  const document = state.documents.get(job.documentId);
  const out: string[] = [
    `# Document: ${document?.fileName ?? job.documentId}`,
    '',
    `Generated: ${state.now()}`,
    '',
  ];
  if (state.faults.emptyMarkdown) return out.join('\n');

  const blocks = renderableBlocks(state, job);
  const pages = [...new Set(blocks.map((b) => b.page_index))].sort((a, b) => a - b);
  let ordinal = 0;
  for (const pageIndex of pages) {
    out.push(`## Page ${pageLabel(state, pageIndex)}`, '');
    for (const block of blocks.filter((b) => b.page_index === pageIndex)) {
      ordinal += 1;
      out.push(...markdownSection(state, block, ordinal, baseUrl));
    }
  }

  if (state.faults.foreignBlockInMarkdown) {
    // Блока с таким идентификатором в документе нет вовсе: экспорт описывает
    // набор, который никто не заказывал.
    const foreign = 'blk_ffffffffffffffffffffffffffffffff';
    out.push(`## Page ${pageLabel(state, 0)}`, '');
    out.push(
      `### BLOCK #${ordinal + 1} [TEXT]: ${foreign}`,
      '',
      `> **Crop:** [Crop](${cropUrl(baseUrl, foreign)})`,
      '',
      'Текст блока, которого в документе нет.',
      '',
    );
  }
  return out.join('\n');
}

/**
 * HTML экспорта — форма по `finalizer/render_html.py`.
 *
 * Бокс метаданных с `Created` и ссылкой на кроп воспроизводится дословно: без
 * него утечка подписанной ссылки через артефакт `html` была бы непроверяема.
 */
function renderHtml(state: FakeState, job: JobRecord, baseUrl: string): string {
  const body = renderableBlocks(state, job)
    .map((block, index) => {
      const meta =
        '<div class="block-meta">' +
        `<div class="block-header">Block #${index + 1} (page ${block.page_index + 1}) | ` +
        `Type: ${block.block_type} | ID: ${block.block_id}</div>` +
        `<div class="meta-created"><b>Created:</b> ${state.now()}</div>` +
        '<div class="block-crop"><b>Crop:</b> ' +
        `<a href="${cropUrl(baseUrl, block.block_id)}" target="_blank" rel="noreferrer">Crop</a>` +
        '</div></div>';
      return (
        `<article class="block block-${block.block_type}" id="block-${block.block_id}" ` +
        `data-block-id="${block.block_id}">${meta}` +
        `<div class="block-content"><p>${recognizedMarkdown(state, block)}</p></div></article>`
      );
    })
    .join('\n');
  return `<!doctype html><html><body>\n${body}\n</body></html>`;
}

/**
 * QA-манифест.
 *
 * `checks` у оригинала — свободный `dict`, а сама модель объявлена с
 * `extra="allow"` (`domain/results.py`). Ссылки на кропы кладутся сюда именно
 * поэтому: их схема не обещает, что подписанного URL в JSON не будет, а правило
 * «наружу подписанная ссылка не выходит» не имеет права держаться на обещании,
 * которого никто не давал.
 */
function renderQaManifest(state: FakeState, job: JobRecord, baseUrl: string): string {
  const rendered = renderableBlocks(state, job);
  return JSON.stringify(
    {
      job_id: job.jobId,
      document_id: job.documentId,
      expected_block_ids: job.blockIds,
      recognized_block_ids: rendered.map((block) => block.block_id),
      failed_block_ids: [],
      non_retriable_block_ids: [],
      missing_block_ids: [],
      checks: {
        markdown_contains_all_blocks: true,
        html_contains_all_blocks: true,
        crop_urls: Object.fromEntries(
          rendered.map((block) => [block.block_id, cropUrl(baseUrl, block.block_id)]),
        ),
      },
      final_status: 'passed',
    },
    null,
    2,
  );
}

export function registerJobRoutes(
  app: FastifyInstance,
  state: FakeState,
  baseUrl: () => string,
): void {
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
    if (blockIds.length === 0) {
      throw new Error('Нет блоков для распознавания по выбранному scope');
    }

    // Режим документа отбрасывает всё, кроме TEXT (`partition_document_mode`).
    if (body.document_mode) {
      blockIds = blockIds.filter((id) => state.blocks.get(id)?.block_type === 'text');
    }

    const job: JobRecord = {
      jobId: state.newId('job'),
      projectId: document.projectId,
      documentId: document.documentId,
      scope: body.scope,
      priority: body.priority,
      settings: body.settings,
      documentMode: body.document_mode,
      idempotencyKey: body.idempotency_key ?? null,
      blockIds,
      createdBy: user.userId,
      createdAt: state.now(),
      polls: 0,
      exportFetches: 0,
    };
    state.jobs.set(job.jobId, job);

    const firstSelection = Object.values(body.settings)[0];
    createResults(state, job, firstSelection?.model_id ?? 'unknown');

    // Ручка «блоки подменены после старта OCR»: моделирует человека, который
    // открыл документ в их UI и передвинул рамку.
    if (state.faults.mutateBlocksOnStart) {
      const victim = state.blocks.get(blockIds[0] as string);
      if (victim !== undefined) {
        victim.coords_norm = [0.01, 0.01, 0.99, 0.99];
        victim.version += 1;
        victim.updated_at = state.now();
      }
    }

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

  // Оба пути ведут в один обработчик: `/api/recognition/jobs` — фактический
  // префикс роутера legacy-сервиса, `/api/jobs` оставлен для совместимости с
  // клиентами, написанными по их устаревшей документации.
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
    if (!isCompleted(state, job) || state.faults.neverExport) {
      throw conflict('Экспорт ещё не готов (job не финализирован)');
    }
    job.exportFetches += 1;

    // Состав архива job'а — ровно три записи (`exports.download_job_zip`).
    // Индекса блоков здесь НЕТ: он есть только в подокументном архиве, который
    // тянет за собой ещё и исходный PDF.
    const url = baseUrl();
    const entries: Record<string, Buffer> = {
      'document.md': Buffer.from(renderMarkdown(state, job, url), 'utf8'),
      'document.html': Buffer.from(renderHtml(state, job, url), 'utf8'),
      'qa_manifest.json': Buffer.from(renderQaManifest(state, job, url), 'utf8'),
    };
    // Ручки «состав архива нарушен»: у их `download_job_zip` состав фиксирован,
    // но отсутствие записи обязано быть отдельным диагнозом, а не падением.
    if (state.faults.dropMarkdownEntry) delete entries['document.md'];
    if (state.faults.dropHtmlEntry) delete entries['document.html'];
    const zip = buildStoredZip(entries);

    const payload = state.faults.truncateExport
      ? zip.subarray(0, Math.floor(zip.length / 2))
      : state.faults.corruptExport
        ? corrupt(zip)
        : zip;

    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${job.jobId}.zip"`)
      .send(payload);
  });
}

/**
 * Порча содержимого записи без порчи структуры.
 *
 * Байт правится в области данных первой записи (после 30-байтового локального
 * заголовка и имени), поэтому каталог и размеры остаются согласованными, а
 * CRC-32 — нет. Именно так выглядит битый архив, который «на вид нормальный»:
 * структурная проверка его пропустит, а проверка целостности обязана поймать.
 */
function corrupt(zip: Buffer): Buffer {
  const copy = Buffer.from(zip);
  const nameLength = copy.readUInt16LE(26);
  const dataStart = 30 + nameLength;
  if (dataStart < copy.length) copy[dataStart] = (copy[dataStart] ?? 0) ^ 0xff;
  return copy;
}
