/**
 * Три задачи VLM-распознавания на портах-двойниках (без БД) — по образцу
 * `recognition.test.ts`. Содержательная сборка на настоящей БД — задача
 * интеграционных тестов (вне этой зоны, см. план Ф5).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  computeBlocksHash,
  NoopProcessingFeedbackSink,
  type HashableBlock,
  type JobContext,
} from '@id/api';
import { textBlockSchema, type RecognitionBlock, type RecognitionResult } from '@id/recognition';

import {
  createVlmFinalizeHandler,
  createVlmRecognizePageHandler,
  createVlmStartHandler,
  RECOGNITION_BLOCK_RESULT_ENVELOPE,
  VlmRecognitionConfigurationError,
  VlmRecognitionCoverageError,
  VlmRecognitionIntegrityError,
  VlmRecognitionPendingError,
  VlmRecognitionStateError,
  type VlmFrozenBlock,
  type VlmPageGeometry,
  type VlmRecognitionDeps,
  type VlmRecognizeBlockInput,
  type VlmRecognizeBlockOutcome,
  type VlmRunPageState,
  type VlmRunTarget,
} from './vlm-recognition.js';

const REVISION = '00000000-0000-4000-8000-000000000011';
const LAYOUT = '00000000-0000-4000-8000-000000000013';
const RUN = '00000000-0000-4000-8000-000000000014';

// =====================================================================
// Инфраструктура двойников
// =====================================================================

interface LogEntry {
  readonly level: string;
  readonly fields: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[]): unknown {
  const write =
    (level: string) =>
    (fields: unknown): void => {
      entries.push({ level, fields: (fields ?? {}) as Record<string, unknown> });
    };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} };
}

interface Enqueued {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey?: string;
}
interface Emitted {
  readonly eventType: string;
  readonly payload?: Record<string, unknown> | undefined;
}
interface Sink {
  readonly enqueued: Enqueued[];
  readonly emitted: Emitted[];
  readonly logs: LogEntry[];
}
function makeSink(): Sink {
  return { enqueued: [], emitted: [], logs: [] };
}

function makeContext<K extends 'vlm.start_recognition' | 'vlm.recognize_page' | 'vlm.finalize_run'>(
  type: K,
  payload: Record<string, unknown>,
  sink: Sink,
  options: { readonly attempt?: number; readonly maxAttempts?: number } = {},
): JobContext<K> {
  return {
    jobId: '00000000-0000-4000-8000-0000000000ff',
    type,
    attempt: options.attempt ?? 1,
    maxAttempts: options.maxAttempts ?? 5,
    revisionId: (payload['revisionId'] as string) ?? null,
    payload,
    db: undefined,
    logger: recordingLogger(sink.logs),
    signal: new AbortController().signal,
    enqueue: (input: Enqueued) => {
      sink.enqueued.push(input);
      return Promise.resolve({ jobId: `job-${sink.enqueued.length}`, created: true });
    },
    emit: (eventType: string, payload?: Record<string, unknown>) => {
      sink.emitted.push({ eventType, payload });
      return Promise.resolve();
    },
  } as unknown as JobContext<K>;
}

// =====================================================================
// Фикстуры
// =====================================================================

function frozenBlock(overrides: Partial<VlmFrozenBlock> = {}): VlmFrozenBlock {
  return {
    id: 'block-1',
    workingPageIndex: 0,
    blockType: 'text',
    shapeType: 'rectangle',
    coordsNorm: [0.1, 0.1, 0.5, 0.5],
    sortOrder: 0,
    polygon: null,
    ...overrides,
  };
}

function toHashable(block: VlmFrozenBlock): HashableBlock {
  const [x0, y0, x1, y1] = block.coordsNorm;
  return {
    workingPageIndex: block.workingPageIndex,
    blockType: block.blockType,
    shapeType: block.shapeType,
    x0,
    y0,
    x1,
    y1,
    sortOrder: block.sortOrder,
    points: block.shapeType === 'polygon' ? (block.polygon ?? []).map(([x, y]) => ({ x, y })) : [],
  };
}

const DEFAULT_FROZEN: readonly VlmFrozenBlock[] = [frozenBlock()];
const MATCHING_HASH = computeBlocksHash(DEFAULT_FROZEN.map(toHashable));

function runTarget(overrides: Partial<VlmRunTarget> = {}): VlmRunTarget {
  return {
    runId: RUN,
    revisionId: REVISION,
    layoutRevisionId: LAYOUT,
    status: 'running',
    localLayoutHash: MATCHING_HASH,
    settingsSnapshot: {
      version: 2,
      provider: 'openrouter_vlm',
      model: 'vendor/model-1',
      dryRun: false,
    },
    ...overrides,
  };
}

const GEOMETRY: readonly VlmPageGeometry[] = [
  { workingPageIndex: 0, widthPx: 595, heightPx: 842, rotation: 0 },
];

function publishedPrompt(code: string, version = 1) {
  return {
    code,
    version,
    systemPrompt: `system:${code}`,
    userTemplate: `user:${code}`,
    outputSchema: {},
    modelOverride: null,
  };
}

function generationProfile(blockType: 'text' | 'image' | 'stamp') {
  const code =
    blockType === 'text'
      ? 'recognition_block_text'
      : blockType === 'image'
        ? 'recognition_block_image'
        : 'recognition_block_stamp';
  return {
    code,
    temperature: 0.1,
    maxTokens: 4096,
    topK: undefined,
    responseFormat: { name: `${code}_result`, schema: { type: 'object' }, strict: true as const },
    schemaVersion: `${code}@hash`,
  };
}

function okBlock(block: VlmFrozenBlock, text = 'распознанный текст'): RecognitionBlock {
  return textBlockSchema.parse({
    blockId: null,
    layoutBlockId: block.id,
    ordinal: block.sortOrder,
    coordsNorm: [...block.coordsNorm],
    confidence: null,
    modelId: 'vendor/model-1',
    blockType: 'text',
    text,
    fragments: [{ kind: 'paragraph', text, emphasis: 'none' }],
    features: null,
  }) as RecognitionBlock;
}

function vlmResponse(patch: Record<string, unknown> = {}) {
  return {
    text: '{"fragments":[]}',
    model: 'vendor/model-1',
    requestedModel: 'vendor/model-1',
    provider: 'recorded',
    tokensIn: 10,
    tokensOut: 5,
    cost: null,
    latencyMs: 3,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    cacheHit: false,
    finishReason: 'stop',
    ...patch,
  };
}

function okOutcome(block: VlmFrozenBlock): VlmRecognizeBlockOutcome {
  return {
    kind: 'ok',
    block: okBlock(block),
    raw: {},
    response: vlmResponse() as never,
    warnings: [],
  };
}

// =====================================================================
// deps() — двойник со «взрывающимися» незамоканными методами
// =====================================================================

/**
 * `finishRun`, идемпотентный по образцу настоящего `finishRecognitionRun`
 * (`where status='running'`): второй и последующие вызовы — no-op
 * `{changed:false}`, ничего не записывают. Обработчики нередко вызывают
 * `finishRun` явно (гейт с конкретной причиной) И полагаются на
 * `withVlmRunTermination` (общий catch-all при `permanent`/последней
 * попытке) — в проде второй вызов безвреден именно благодаря этой
 * идемпотентности; без неё тест видел бы задвоенные записи там, где
 * настоящая БД видит одну.
 */
function idempotentFinishRun(): {
  readonly fn: VlmRecognitionDeps['finishRun'];
  readonly calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  let done = false;
  const fn: VlmRecognitionDeps['finishRun'] = async (input) => {
    if (done) return { changed: false };
    done = true;
    calls.push(input as unknown as Record<string, unknown>);
    return { changed: true };
  };
  return { fn, calls };
}

function deps(overrides: Partial<VlmRecognitionDeps> = {}): VlmRecognitionDeps {
  const unexpected = (name: string) => (): never => {
    throw new Error(`порт ${name} вызван неожиданно`);
  };

  const base: VlmRecognitionDeps = {
    loadRun: async () => runTarget(),
    loadFrozenBlocks: async () => DEFAULT_FROZEN,
    loadPageGeometry: async () => GEOMETRY,
    seedRunPages: async () => {},
    markRunPage: async () => {},
    listRunPages: async () => [],
    existingBlockIds: async () => new Set(),
    insertBlockResult: unexpected('insertBlockResult') as VlmRecognitionDeps['insertBlockResult'],
    listBlockEnvelopes: async () => [],
    publishResults: unexpected('publishResults') as VlmRecognitionDeps['publishResults'],
    mergeSnapshot: async () => {},
    finishRun: async () => ({ changed: true }),
    findArtifact: async () => null,
    recordArtifact: unexpected('recordArtifact') as VlmRecognitionDeps['recordArtifact'],
    readArtifactBytes: async () => null,
    writeArtifactBytes: async () => {},
    artifactId: async () => 'artifact-1',
    promptByCode: async (code: string) => publishedPrompt(code),
    // По умолчанию строгий режим: тесты проверяют штатные гейты, а послабления
    // режима тестирования включаются точечно, там где они и есть предмет.
    enforceGates: async () => true,
    generationProfile: (blockType) => generationProfile(blockType),
    vlm: unexpected('vlm.complete') as never,
    recognizeBlock: unexpected('recognizeBlock') as VlmRecognitionDeps['recognizeBlock'],
    rasterizer: {
      kind: 'pdftoppm',
      version: '1.0',
      renderPage: unexpected('rasterizer.renderPage') as never,
    },
    workingPdfToFile: unexpected('workingPdfToFile') as VlmRecognitionDeps['workingPdfToFile'],
    crop: unexpected('crop') as VlmRecognitionDeps['crop'],
    downscale: async (png: Uint8Array) => png,
    assemble: unexpected('assemble') as VlmRecognitionDeps['assemble'],
    recordAiRun: async () => {},
    // Пустой приёмник: предмет этих тестов — конвейер, а не запись обратной
    // связи. Её содержание проверяется отдельно, на настоящей БД.
    feedback: new NoopProcessingFeedbackSink(),
    sha256: (bytes: Uint8Array) => `h${bytes.byteLength}`.padEnd(64, '0'),
  };

  return { ...base, ...overrides };
}

// =====================================================================
// vlm.start_recognition
// =====================================================================

describe('createVlmStartHandler', () => {
  it('гейт целостности: расхождение хэша закрывает прогон integrity_error', async () => {
    const { fn: finishRun, calls: finishCalls } = idempotentFinishRun();
    const d = deps({
      loadRun: async () => runTarget({ localLayoutHash: 'f'.repeat(64) }),
      finishRun,
    });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionIntegrityError);
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.['status']).toBe('integrity_error');
    expect(sink.enqueued).toHaveLength(0);
  });

  it('неопубликованный промпт — не отказ, а встроенный текст: version 0 в снимке', async () => {
    // Прежде это был конфигурационный отказ, закрывавший прогон. Требование было
    // лишним: сид-миграция промптов генерируется из тех же констант, что и
    // встроенный текст, — публикация ничего не добавляла, кроме ручного шага.
    const { fn: finishRun, calls: finishCalls } = idempotentFinishRun();
    const snapshots: Record<string, unknown>[] = [];
    const d = deps({
      promptByCode: async (code: string) =>
        code === 'recognition_block_image' ? publishedPrompt(code, 0) : publishedPrompt(code),
      mergeSnapshot: async (_runId: string, patch: Record<string, unknown>) => {
        snapshots.push(patch);
      },
      finishRun,
    });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await handler(ctx);

    expect(finishCalls).toHaveLength(0);
    // Ноль уезжает в снимок наравне с прочими версиями: прогон обязан
    // доказывать, чем он выполнен, и «встроенным» — такой же ответ.
    expect(snapshots[0]?.['promptVersions']).toMatchObject({ image: 0, text: 1, stamp: 1 });
    expect(sink.enqueued.length).toBeGreaterThan(0);
  });

  it('пустая разметка (0 блоков) — failed с внятной причиной', async () => {
    const { fn: finishRun, calls: finishCalls } = idempotentFinishRun();
    const d = deps({
      // Гейт целостности проверяется РАНЬШЕ гейта «нет блоков» (см. handler):
      // хэш обязан совпасть с пустым набором, иначе тест ловит integrity_error
      // вместо сценария, который проверяет.
      loadRun: async () => runTarget({ localLayoutHash: computeBlocksHash([]) }),
      loadFrozenBlocks: async () => [],
      finishRun,
    });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionStateError);
    expect(finishCalls[0]?.['status']).toBe('failed');
    expect(String(finishCalls[0]?.['reason'])).toContain('нет блоков');
  });

  it('счастливый путь: сидирует снимок, ставит страницы и finalize', async () => {
    const twoPages = [
      frozenBlock({ id: 'b1', workingPageIndex: 0, sortOrder: 0 }),
      frozenBlock({ id: 'b2', workingPageIndex: 1, sortOrder: 0, blockType: 'image' }),
    ];
    const hash = computeBlocksHash(twoPages.map(toHashable));
    const seeded: unknown[] = [];
    const merged: Record<string, unknown>[] = [];
    const d = deps({
      loadRun: async () => runTarget({ localLayoutHash: hash }),
      loadFrozenBlocks: async () => twoPages,
      seedRunPages: async (_runId, pages) => {
        seeded.push(pages);
      },
      mergeSnapshot: async (_runId, patch) => {
        merged.push(patch);
      },
    });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await handler(ctx);

    expect(seeded).toEqual([
      [
        { workingPageIndex: 0, blocksTotal: 1 },
        { workingPageIndex: 1, blocksTotal: 1 },
      ],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      cropPolicyVersion: 'crop.v1',
      rasterizer: { kind: 'pdftoppm', version: '1.0', dpi: 300 },
    });
    expect((merged[0]?.['promptVersions'] as Record<string, number>)['text']).toBe(1);

    const recognizeJobs = sink.enqueued.filter((job) => job.type === 'vlm.recognize_page');
    expect(recognizeJobs).toHaveLength(2);
    expect(recognizeJobs.map((job) => job.dedupeKey)).toEqual([
      `vlm.recognize_page:${RUN}:0`,
      `vlm.recognize_page:${RUN}:1`,
    ]);
    const finalizeJobs = sink.enqueued.filter((job) => job.type === 'vlm.finalize_run');
    expect(finalizeJobs).toHaveLength(1);
    expect(finalizeJobs[0]?.dedupeKey).toBe(`vlm.finalize_run:${RUN}`);
  });

  it('снимок непригоден (провайдер не openrouter_vlm) — конфигурационный отказ', async () => {
    const d = deps({
      loadRun: async () => runTarget({ settingsSnapshot: { version: 1, provider: 'rdweb' } }),
    });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionConfigurationError);
  });

  it('VLM-порт не настроен — конфигурационный отказ до любых чтений', async () => {
    const d = deps({ vlm: null });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionConfigurationError);
  });
});

// =====================================================================
// vlm.recognize_page
// =====================================================================

describe('createVlmRecognizePageHandler', () => {
  it('checkpoint: все блоки страницы уже записаны — VLM не зовётся, страница done', async () => {
    const marked: Record<string, unknown>[] = [];
    const d = deps({
      existingBlockIds: async () => new Set(['block-1']),
      markRunPage: async (input) => {
        marked.push(input);
      },
      // rasterizer/vlm/workingPdfToFile остаются «взрывающимися» — тест
      // доказывает, что checkpoint их не касается.
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    expect(marked).toEqual([
      {
        runId: RUN,
        workingPageIndex: 0,
        status: 'done',
        blocksRecognized: 1,
        blocksInvalid: 0,
        blocksRefused: 0,
      },
    ]);
  });

  it('invalid_response не пишет строку блока, страница помечается failed', async () => {
    const inserted: unknown[] = [];
    const marked: Record<string, unknown>[] = [];
    const recorded: unknown[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([1, 2, 3]), widthPx: 100, heightPx: 100 }),
      recognizeBlock: async (): Promise<VlmRecognizeBlockOutcome> => ({
        kind: 'invalid_response',
        reason: 'ответ не по схеме',
        response: vlmResponse() as never,
      }),
      insertBlockResult: async (input) => {
        inserted.push(input);
        return { written: true };
      },
      markRunPage: async (input) => {
        marked.push(input);
      },
      recordAiRun: async (input) => {
        recorded.push(input);
      },
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    expect(inserted).toHaveLength(0);
    expect(marked).toEqual([
      {
        runId: RUN,
        workingPageIndex: 0,
        status: 'failed',
        blocksRecognized: 0,
        blocksInvalid: 1,
        blocksRefused: 0,
      },
    ]);
    // Вызов состоялся (есть response) — ai_runs всё равно пишется.
    expect(recorded).toHaveLength(1);
  });

  it('degenerate text пишет пустой канонический блок с пометкой degenerate', async () => {
    const inserted: {
      block: { contentJson: unknown; resultType: string; contentMd: string | null };
    }[] = [];
    const marked: Record<string, unknown>[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ degenerate: true }),
      insertBlockResult: async (input) => {
        inserted.push(input as never);
        return { written: true };
      },
      markRunPage: async (input) => {
        marked.push(input);
      },
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.block.resultType).toBe('text_json');
    expect(inserted[0]?.block.contentMd).toBe('');
    const envelope = inserted[0]?.block.contentJson as {
      envelope: string;
      block: { text: string; fragments: unknown[] };
      provenance: { degenerate: boolean; cropSha256: null };
    };
    expect(envelope.envelope).toBe(RECOGNITION_BLOCK_RESULT_ENVELOPE);
    expect(envelope.block.text).toBe('');
    expect(envelope.block.fragments).toEqual([]);
    expect(envelope.provenance.degenerate).toBe(true);
    expect(envelope.provenance.cropSha256).toBeNull();
    expect(marked).toEqual([
      {
        runId: RUN,
        workingPageIndex: 0,
        status: 'done',
        blocksRecognized: 1,
        blocksInvalid: 0,
        blocksRefused: 0,
      },
    ]);
  });

  it('degenerate image/stamp — invalid без записи строки', async () => {
    const marked: Record<string, unknown>[] = [];
    const d = deps({
      loadFrozenBlocks: async () => [frozenBlock({ blockType: 'image' })],
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ degenerate: true }),
      markRunPage: async (input) => {
        marked.push(input);
      },
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    expect(marked).toEqual([
      {
        runId: RUN,
        workingPageIndex: 0,
        status: 'failed',
        blocksRecognized: 0,
        blocksInvalid: 1,
        blocksRefused: 0,
      },
    ]);
  });

  it('ok-исход пишет строку result_type=text_json и recordAiRun', async () => {
    const inserted: unknown[] = [];
    const marked: Record<string, unknown>[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([9, 9, 9]), widthPx: 50, heightPx: 50 }),
      recognizeBlock: async (input: VlmRecognizeBlockInput) =>
        okOutcome(frozenBlock({ id: input.block.layoutBlockId })),
      insertBlockResult: async (input) => {
        inserted.push(input);
        return { written: true };
      },
      markRunPage: async (input) => {
        marked.push(input);
      },
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { block: { resultType: string } }).block.resultType).toBe('text_json');
    expect(marked).toEqual([
      {
        runId: RUN,
        workingPageIndex: 0,
        status: 'done',
        blocksRecognized: 1,
        blocksInvalid: 0,
        blocksRefused: 0,
      },
    ]);
  });

  it('stopsBatch-подобная ошибка (retriable:false) закрывает прогон через withVlmRunTermination', async () => {
    const finishCalls: Record<string, unknown>[] = [];
    class FakeBudgetError extends Error {
      readonly retriable = false;
      readonly stopsBatch = true;
      readonly attempt = {
        provider: 'proxy_llm',
        model: 'vendor/model-1',
        inputHash: 'c'.repeat(64),
        latencyMs: 12,
      };
      constructor() {
        super('месячный бюджет исчерпан');
        this.name = 'LlmBudgetError';
      }
    }
    const recorded: unknown[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([1]), widthPx: 20, heightPx: 20 }),
      recognizeBlock: async () => {
        throw new FakeBudgetError();
      },
      recordAiRun: async (input) => {
        recorded.push(input);
      },
      finishRun: async (input) => {
        finishCalls.push(input);
        return { changed: true };
      },
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
      { attempt: 1, maxAttempts: 5 },
    );

    await expect(handler(ctx)).rejects.toThrow('месячный бюджет исчерпан');

    // stopsBatch:true → закрывается НЕМЕДЛЕННО, даже на первой из пяти попыток:
    // при исчерпанном бюджете остальные страницы всё равно обречены.
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.['status']).toBe('failed');
    expect(recorded).toHaveLength(1);
  });

  it('неповторимый отказ БЕЗ stopsBatch не закрывает прогон: страница failed, обход идёт дальше', async () => {
    // Регрессия на прод-инцидент: шлюз ответил 400 на ОДНОЙ странице, и прогон из
    // 83 страниц закрылся целиком, а оставшиеся 128 задач умерли с «прогон уже
    // завершён». Причина была в том, что закрытие решалось по `retriable`, хотя у
    // отказа есть отдельный флаг ровно про это — `stopsBatch`.
    const finishCalls: Record<string, unknown>[] = [];
    const marked: Record<string, unknown>[] = [];
    class FakeTransportError extends Error {
      readonly retriable = false;
      readonly stopsBatch = false;
      readonly status = 400;
      readonly attempt = {
        provider: 'proxy_llm',
        model: 'vendor/model-1',
        inputHash: 'e'.repeat(64),
        latencyMs: 9,
      };
      constructor() {
        super('Шлюз LLM ответил 400: Provider returned error');
        this.name = 'LlmTransportError';
      }
    }
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([1]), widthPx: 20, heightPx: 20 }),
      recognizeBlock: async () => {
        throw new FakeTransportError();
      },
      recordAiRun: async () => {},
      markRunPage: async (input: Record<string, unknown>) => {
        marked.push(input);
      },
      finishRun: async (input: Record<string, unknown>) => {
        finishCalls.push(input);
        return { changed: true };
      },
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
      { attempt: 1, maxAttempts: 5 },
    );

    // Задача завершается УСПЕШНО: повторять неповторимое незачем, а бросать наверх
    // нельзя — тогда markRunPage не вызовется и страница застрянет в pending.
    await handler(ctx);

    expect(finishCalls).toHaveLength(0);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.['status']).toBe('failed');
  });

  it('retriable-ошибка НЕ закрывает прогон раньше времени (движок повторит)', async () => {
    const finishCalls: Record<string, unknown>[] = [];
    class FakeRateLimitError extends Error {
      readonly retriable = true;
      readonly attempt = {
        provider: 'proxy_llm',
        model: 'vendor/model-1',
        inputHash: 'd'.repeat(64),
        latencyMs: 8,
      };
      constructor() {
        super('превышен лимит частоты');
        this.name = 'LlmRateLimitError';
      }
    }
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([1]), widthPx: 20, heightPx: 20 }),
      recognizeBlock: async () => {
        throw new FakeRateLimitError();
      },
      recordAiRun: async () => {},
      finishRun: async (input) => {
        finishCalls.push(input);
        return { changed: true };
      },
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
      { attempt: 1, maxAttempts: 5 },
    );

    await expect(handler(ctx)).rejects.toThrow('превышен лимит частоты');
    expect(finishCalls).toHaveLength(0);
  });

  it('расхождение геометрии страницы — failed без вызова блоков', async () => {
    const marked: Record<string, unknown>[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        // Портрет вместо альбомной геометрии — соотношение сторон разойдётся.
        renderPage: async () => ({ widthPx: 842, heightPx: 595 }),
      },
      markRunPage: async (input) => {
        marked.push(input);
      },
      // crop/recognizeBlock остаются «взрывающимися»: до блоков дело не доходит.
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    expect(marked).toEqual([
      {
        runId: RUN,
        workingPageIndex: 0,
        status: 'failed',
        blocksRecognized: 0,
        blocksInvalid: 0,
        blocksRefused: 0,
      },
    ]);
  });
});

// =====================================================================
// vlm.finalize_run
// =====================================================================

describe('createVlmFinalizeHandler', () => {
  function donePage(overrides: Partial<VlmRunPageState> = {}): VlmRunPageState {
    return {
      workingPageIndex: 0,
      status: 'done',
      blocksTotal: 1,
      blocksRecognized: 1,
      blocksInvalid: 0,
      blocksRefused: 0,
      ...overrides,
    };
  }

  function envelope(block: VlmFrozenBlock) {
    return {
      id: `result-${block.id}`,
      layoutBlockId: block.id,
      modelId: 'vendor/model-1',
      contentJson: {
        envelope: RECOGNITION_BLOCK_RESULT_ENVELOPE,
        block: okBlock(block),
        page: { workingPageIndex: block.workingPageIndex, widthPx: 595, heightPx: 842 },
        provenance: {
          promptCode: 'recognition_block_text',
          promptVersion: 1,
          model: 'vendor/model-1',
          actualModel: 'vendor/model-1',
          finishReason: 'stop',
          attempts: 1,
          cropPolicyVersion: 'crop.v1',
          cropSha256: 'x'.repeat(64),
        },
      },
    };
  }

  function fakeAssembled(): RecognitionResult {
    return {
      schemaVersion: 'recognition.result.v2',
      source: {
        provider: 'openrouter_vlm',
        adapterVersion: 'test.v1',
        modelId: 'vendor/model-1',
        generatedAt: null,
      },
      pages: [
        {
          workingPageIndex: 0,
          rotation: 0,
          widthPx: 595,
          heightPx: 842,
          text: null,
          blocks: [okBlock(frozenBlock())],
        },
      ],
      warnings: [],
    };
  }

  it('есть незавершённые страницы — retriable, прогон не закрывается', async () => {
    const finishCalls: unknown[] = [];
    const d = deps({
      listRunPages: async () => [
        donePage(),
        { ...donePage({ workingPageIndex: 1 }), status: 'pending' },
      ],
      finishRun: async (input) => {
        finishCalls.push(input);
        return { changed: true };
      },
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
      {
        attempt: 1,
        maxAttempts: 60,
      },
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionPendingError);
    expect(finishCalls).toHaveLength(0);
  });

  it('покрытие неполно (меньше конвертов, чем блоков) — failed', async () => {
    const { fn: finishRun, calls: finishCalls } = idempotentFinishRun();
    const d = deps({
      listRunPages: async () => [donePage()],
      listBlockEnvelopes: async () => [],
      finishRun,
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionCoverageError);
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.['status']).toBe('failed');
  });

  it('есть страницы failed — тоже failed, даже при полном покрытии конвертов', async () => {
    const finishCalls: Record<string, unknown>[] = [];
    const d = deps({
      listRunPages: async () => [donePage({ status: 'failed', blocksRecognized: 0 })],
      listBlockEnvelopes: async () => [envelope(frozenBlock())],
      finishRun: async (input) => {
        finishCalls.push(input);
        return { changed: true };
      },
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionCoverageError);
    expect(finishCalls[0]?.['status']).toBe('failed');
  });

  it('полное покрытие: собирает артефакт, публикует и закрывает done', async () => {
    const written: { bytes: Uint8Array; kind: string }[] = [];
    const recordedArtifacts: Record<string, unknown>[] = [];
    const published: Record<string, unknown>[] = [];
    const finishCalls: Record<string, unknown>[] = [];
    const d = deps({
      listRunPages: async () => [donePage()],
      listBlockEnvelopes: async () => [envelope(frozenBlock())],
      assemble: () => fakeAssembled(),
      writeArtifactBytes: async (input) => {
        written.push({ bytes: input.bytes, kind: input.kind });
      },
      recordArtifact: async (input) => {
        recordedArtifacts.push(input);
        return { kind: 'recorded', artifactSha256: input.artifactSha256 };
      },
      artifactId: async () => 'artifact-final',
      publishResults: async (input) => {
        published.push(input);
        return { pagesWritten: 1, pagesAlreadyPresent: 0, pagesOutOfRange: 0, pointersMoved: 1 };
      },
      finishRun: async (input) => {
        finishCalls.push(input);
        return { changed: true };
      },
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await handler(ctx);

    expect(written).toHaveLength(1);
    expect(written[0]?.kind).toBe('canonical');
    expect(recordedArtifacts).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect((published[0]?.['pages'] as unknown[]).length).toBe(1);
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.['status']).toBe('done');
    expect(sink.emitted).toHaveLength(1);
    expect(sink.emitted[0]?.eventType).toBe('recognition.export_stored');
  });

  it('dryRun: публикация пропускается, прогон done с пометкой dryRun', async () => {
    const published: unknown[] = [];
    const finishCalls: Record<string, unknown>[] = [];
    const d = deps({
      loadRun: async () =>
        runTarget({
          settingsSnapshot: {
            version: 2,
            provider: 'openrouter_vlm',
            model: 'vendor/model-1',
            dryRun: true,
          },
        }),
      listRunPages: async () => [donePage()],
      listBlockEnvelopes: async () => [envelope(frozenBlock())],
      assemble: () => fakeAssembled(),
      writeArtifactBytes: async () => {},
      recordArtifact: async (input) => ({ kind: 'recorded', artifactSha256: input.artifactSha256 }),
      artifactId: async () => 'artifact-dry',
      publishResults: async (input) => {
        published.push(input);
        return { pagesWritten: 0, pagesAlreadyPresent: 0, pagesOutOfRange: 0, pointersMoved: 0 };
      },
      finishRun: async (input) => {
        finishCalls.push(input);
        return { changed: true };
      },
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await handler(ctx);

    expect(published).toHaveLength(0);
    expect(sink.emitted).toHaveLength(0);
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.['status']).toBe('done');
    expect((finishCalls[0]?.['counts'] as Record<string, unknown>)['dryRun']).toBe(true);
  });

  it('повтор finalize после done: loadRun видит status=done — handler завершает без публикации (finishRun идемпотентен)', async () => {
    const finishRun = vi.fn(async () => ({ changed: false }));
    const publishResults = vi.fn();
    const d = deps({
      loadRun: async () => runTarget({ status: 'done' }),
      finishRun,
      publishResults: publishResults as never,
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionStateError);
    // Повторный вызов не трогает ни публикацию, ни (напрямую) finishRun —
    // прогон уже не 'running', и обработчик останавливается на первой же
    // проверке цели, не переигрывая уже свершившийся исход.
    expect(publishResults).not.toHaveBeenCalled();
  });
});
