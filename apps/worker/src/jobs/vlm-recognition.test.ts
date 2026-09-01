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
  options: {
    readonly attempt?: number;
    readonly maxAttempts?: number;
    /** Отмена попытки: движок ставит её при истёкшем потолке и потере аренды. */
    readonly signal?: AbortSignal;
  } = {},
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
    signal: options.signal ?? new AbortController().signal,
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
    // Обычный блок детектора: свой потолок кропа получает только `full_page`.
    detectorProvenance: 'rf_detr',
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
    recoveryRound: 0,
    repairOfRunId: null,
    workingPdfSha256: 'f'.repeat(64),
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
  { workingPageIndex: 0, widthPx: 595, heightPx: 842, rotation: 0, contentRotation: 0 },
];

/** Та же карта, но страница развёрнута: скан лёг на лист боком (ADR-0020). */
const GEOMETRY_TURNED: readonly VlmPageGeometry[] = [
  { workingPageIndex: 0, widthPx: 595, heightPx: 842, rotation: 0, contentRotation: 90 },
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
    calls: [vlmResponse() as never],
    cropTrail: [],
    cropRequests: 0,
    forcedFinal: false,
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
    // `null` — «строки задачи нет», и тогда решение о продолжении цепочки
    // остаётся за payload. Так набор ведёт себя ровно как до появления порта:
    // тесты, проверяющие сквозной прогон, задают его признаком в payload.
    readAutoContinue: async () => null,
    loadRun: async () => runTarget(),
    // По умолчанию за каждой непройденной страницей стоит живая задача: тесты,
    // проверяющие ожидание финализации, описывают именно этот случай.
    livePageJobs: async () => new Set([0, 1, 2, 3]),
    scheduleRecoveryRound: unexpected('scheduleRecoveryRound') as never,
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
      cropPolicyVersion: 'crop.v3',
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

  it('восстановление: совместимые результаты родителя переносятся до первого вызова модели', async () => {
    const PARENT = '00000000-0000-4000-8000-0000000000f1';
    const block = frozenBlock();
    const parentSnapshot = {
      version: 2,
      provider: 'openrouter_vlm',
      model: 'vendor/model-1',
      dryRun: false,
      cropPolicyVersion: 'crop.v3',
      // Потолок площади входит в подпись растеризатора (S41): родитель без него
      // — это прогон с другим растром, и переносить из него нельзя.
      rasterizer: { kind: 'pdftoppm', version: '1.0', dpi: 300, maxPixels: 40_000_000 },
    };
    const parentEnvelope = (patch: Record<string, unknown> = {}) => ({
      id: 'parent-result',
      layoutBlockId: block.id,
      modelId: 'vendor/model-1',
      contentJson: {
        envelope: 'recognition.block_result.v1',
        block: okBlock(block),
        page: { workingPageIndex: 0, widthPx: 595, heightPx: 842 },
        provenance: {
          promptCode: 'recognition_block_text',
          promptVersion: 1,
          model: 'vendor/model-1',
          cropPolicyVersion: 'crop.v3',
          ...patch,
        },
      },
    });

    const inserted: { block: { layoutBlockId: string; contentJson: unknown } }[] = [];
    const merged: Record<string, unknown>[] = [];
    const d = deps({
      loadRun: async ({ recognitionRunId }) =>
        recognitionRunId === PARENT
          ? runTarget({ status: 'failed', settingsSnapshot: parentSnapshot })
          : runTarget({ repairOfRunId: PARENT }),
      listBlockEnvelopes: async () => [parentEnvelope()],
      insertBlockResult: async (input) => {
        inserted.push(input as never);
        return { written: true };
      },
      mergeSnapshot: async (_runId, patch) => {
        merged.push(patch);
      },
      seedRunPages: async () => {},
    });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await handler(ctx);

    // Результат перенесён ДО fan-out: `vlm.recognize_page` увидит блок уже
    // покрытым и модель для него не позовёт — за прочитанное платят один раз.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.block.layoutBlockId).toBe(block.id);
    const provenance = (inserted[0]?.block.contentJson as { provenance: Record<string, unknown> })
      .provenance;
    // Откуда взялся результат, которого этот прогон не считал сам.
    expect(provenance['reusedFromRunId']).toBe(PARENT);
    expect(merged.at(-1)).toMatchObject({
      repair: { parentRunId: PARENT, blocksReused: 1, blocksRetried: 0 },
    });
  });

  it('восстановление: блок развёрнутой с тех пор страницы не переносится', async () => {
    /**
     * Ради этой проверки перенос и сделан ПОБЛОЧНЫМ.
     *
     * Инженер развернул одну страницу и нажал «Распознать» снова. Её результат
     * получен по картинке, которой модель больше не увидит, — переносить его
     * нельзя. А блоки остальных страниц не изменились ничем, и заставлять
     * платить за них второй раз означало бы вернуть трату, которую убирал S28.
     *
     * Без этой строки кнопка поворота выглядела бы работающей и не меняла бы
     * ничего: прогон молча вернул бы прежний текст.
     */
    const PARENT = '00000000-0000-4000-8000-0000000000f5';
    const turned = frozenBlock({ id: 'b-turned', workingPageIndex: 0, sortOrder: 0 });
    const straight = frozenBlock({ id: 'b-straight', workingPageIndex: 1, sortOrder: 0 });
    const hash = computeBlocksHash([turned, straight].map(toHashable));

    const parentProvenance = (contentRotation: number) => ({
      promptCode: 'recognition_block_text',
      promptVersion: 1,
      model: 'vendor/model-1',
      cropPolicyVersion: 'crop.v3',
      contentRotation,
    });

    const inserted: { block: { layoutBlockId: string } }[] = [];
    const d = deps({
      loadFrozenBlocks: async () => [turned, straight],
      // Страница 0 развёрнута СЕЙЧАС, страница 1 — нет.
      loadPageGeometry: async () => [
        { workingPageIndex: 0, widthPx: 595, heightPx: 842, rotation: 0, contentRotation: 90 },
        { workingPageIndex: 1, widthPx: 595, heightPx: 842, rotation: 0, contentRotation: 0 },
      ],
      loadRun: async ({ recognitionRunId }) =>
        recognitionRunId === PARENT
          ? runTarget({
              status: 'failed',
              // Тот же набор блоков, что у потомка: иначе родитель отвергается
              // целиком, и поблочная сверка разворота не проверялась бы вовсе.
              localLayoutHash: hash,
              settingsSnapshot: {
                version: 2,
                provider: 'openrouter_vlm',
                model: 'vendor/model-1',
                cropPolicyVersion: 'crop.v3',
                rasterizer: { kind: 'pdftoppm', version: '1.0', dpi: 300, maxPixels: 40_000_000 },
              },
            })
          : runTarget({ repairOfRunId: PARENT, localLayoutHash: hash }),
      listBlockEnvelopes: async () => [
        {
          id: 'parent-turned',
          layoutBlockId: turned.id,
          modelId: 'vendor/model-1',
          contentJson: {
            envelope: 'recognition.block_result.v1',
            block: okBlock(turned),
            page: { workingPageIndex: 0, widthPx: 595, heightPx: 842 },
            // Родитель считал эту страницу прямой.
            provenance: parentProvenance(0),
          },
        },
        {
          id: 'parent-straight',
          layoutBlockId: straight.id,
          modelId: 'vendor/model-1',
          contentJson: {
            envelope: 'recognition.block_result.v1',
            block: okBlock(straight),
            page: { workingPageIndex: 1, widthPx: 595, heightPx: 842 },
            provenance: parentProvenance(0),
          },
        },
      ],
      insertBlockResult: async (input) => {
        inserted.push(input as never);
        return { written: true };
      },
      mergeSnapshot: async () => {},
      seedRunPages: async () => {},
    });

    const handler = createVlmStartHandler(d);
    await handler(
      makeContext(
        'vlm.start_recognition',
        { revisionId: REVISION, recognitionRunId: RUN },
        makeSink(),
      ),
    );

    // Перенесён ровно один блок — с той страницы, разворот которой не менялся.
    expect(inserted.map((item) => item.block.layoutBlockId)).toEqual([straight.id]);
  });

  it('восстановление: результат другой модели не переносится', async () => {
    const PARENT = '00000000-0000-4000-8000-0000000000f2';
    const block = frozenBlock();
    const inserted: unknown[] = [];
    const d = deps({
      loadRun: async ({ recognitionRunId }) =>
        recognitionRunId === PARENT
          ? runTarget({
              status: 'failed',
              settingsSnapshot: {
                version: 2,
                provider: 'openrouter_vlm',
                model: 'vendor/model-1',
                cropPolicyVersion: 'crop.v3',
                rasterizer: { kind: 'pdftoppm', version: '1.0', dpi: 300, maxPixels: 40_000_000 },
              },
            })
          : runTarget({ repairOfRunId: PARENT }),
      listBlockEnvelopes: async () => [
        {
          id: 'parent-result',
          layoutBlockId: block.id,
          modelId: 'vendor/model-OLD',
          contentJson: {
            envelope: 'recognition.block_result.v1',
            block: okBlock(block),
            page: { workingPageIndex: 0, widthPx: 595, heightPx: 842 },
            provenance: {
              promptCode: 'recognition_block_text',
              promptVersion: 1,
              // Блок прочитан другой моделью: перенести его значит выдать
              // чужой ответ за результат этого прогона.
              model: 'vendor/model-OLD',
              cropPolicyVersion: 'crop.v3',
            },
          },
        },
      ],
      insertBlockResult: async (input) => {
        inserted.push(input);
        return { written: true };
      },
      mergeSnapshot: async () => {},
      seedRunPages: async () => {},
    });
    const sink = makeSink();
    const handler = createVlmStartHandler(d);
    const ctx = makeContext(
      'vlm.start_recognition',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
    );

    await handler(ctx);

    expect(inserted).toHaveLength(0);
    // Блок остаётся непокрытым — его распознает `vlm.recognize_page`.
    expect(sink.enqueued.filter((job) => job.type === 'vlm.recognize_page')).toHaveLength(1);
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
        calls: [vlmResponse() as never],
        cropTrail: [],
        cropRequests: 0,
        forcedFinal: false,
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

  it('строка ai_runs пишется на КАЖДЫЙ физический вызов, кэш-хиты пропускаются', async () => {
    const aiRuns: Record<string, unknown>[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([9, 9, 9]), widthPx: 50, heightPx: 50 }),
      recognizeBlock: async (input: VlmRecognizeBlockInput) => ({
        ...okOutcome(frozenBlock({ id: input.block.layoutBlockId })),
        // Два круга дозапроса кропа и итоговый ответ: до S28 в учёт попадал
        // только последний, и расход прогона был занижен на треть.
        calls: [
          vlmResponse({ upstreamId: 'gen-1' }) as never,
          vlmResponse({ upstreamId: 'gen-2' }) as never,
          // Попадание в кэш вызовом не было: платить за него нечем.
          vlmResponse({ upstreamId: 'gen-2', cacheHit: true }) as never,
        ],
      }),
      insertBlockResult: async () => ({ written: true }),
      markRunPage: async () => {},
      recordAiRun: async (input) => {
        aiRuns.push(input as unknown as Record<string, unknown>);
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

    expect(aiRuns).toHaveLength(2);
    const structured = aiRuns.map((row) => row['structuredResult'] as Record<string, unknown>);
    expect(structured.map((row) => row['sequence'])).toEqual([1, 2]);
    expect(structured.map((row) => row['upstreamId'])).toEqual(['gen-1', 'gen-2']);
    // Промежуточный вызов и итоговый различаются исходом: первый — обмен с
    // инструментом, ответом блока он не был.
    expect(structured[0]?.['outcome']).toBe('tool_exchange');
  });

  it('блок на весь лист получает лишний круг дозапроса', async () => {
    const inputs: VlmRecognizeBlockInput[] = [];
    const d = deps({
      loadFrozenBlocks: async () => [frozenBlock({ detectorProvenance: 'full_page' })],
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([9, 9, 9]), widthPx: 50, heightPx: 50 }),
      recognizeBlock: async (input: VlmRecognizeBlockInput) => {
        inputs.push(input);
        return okOutcome(frozenBlock({ id: input.block.layoutBlockId }));
      },
      insertBlockResult: async () => ({ written: true }),
      markRunPage: async () => {},
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    // Заплатка «страница целиком» ставится там, где другого текста у страницы
    // нет: зум для неё — рабочий инструмент, а не зацикливание.
    expect(inputs[0]?.maxCropRequests).toBe(3);
  });

  it('отмена попытки останавливает обход блоков и не портит страницу', async () => {
    // Лист с медленными блоками перерастает потолок попытки, и до S41 обход
    // этого не замечал: движок отдавал слот следующей странице, а брошенная
    // задача продолжала резать кропы и звать модель — оплаченными вызовами,
    // писать результат которых уже некуда. Хуже того, отмену ловил тот же
    // `catch`, что и отказ блока: страница получала `failed` по причине,
    // которой не было.
    const controller = new AbortController();
    const cancellation = new Error('попытка не уложилась в 600000 мс');
    cancellation.name = 'JobTimeout';

    const seen: string[] = [];
    const marked: unknown[] = [];
    const d = deps({
      loadFrozenBlocks: async () => [
        frozenBlock({ id: 'block-1', sortOrder: 0 }),
        frozenBlock({ id: 'block-2', sortOrder: 1 }),
      ],
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([9, 9, 9]), widthPx: 50, heightPx: 50 }),
      recognizeBlock: async (input: VlmRecognizeBlockInput) => {
        seen.push(input.block.layoutBlockId);
        // Первый блок успел договорить, и на этом попытку отменили.
        controller.abort(cancellation);
        return okOutcome(frozenBlock({ id: input.block.layoutBlockId }));
      },
      insertBlockResult: async () => ({ written: true }),
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
      { signal: controller.signal },
    );

    // Наружу уходит ПРИЧИНА отмены: движок обязан записать «потолок попытки»,
    // а не выдуманный отказ распознавания.
    await expect(handler(ctx)).rejects.toBe(cancellation);

    // Второй блок не начинали, и страницу терминальной не объявляли: её судьбу
    // решит следующая попытка, а записанный первый блок она пропустит.
    expect(seen).toEqual(['block-1']);
    expect(marked).toEqual([]);
  });

  it('раунд дораспознавания меняет промпт: иначе ответ придёт из кэша', async () => {
    const inputs: VlmRecognizeBlockInput[] = [];
    const d = deps({
      loadRun: async () => runTarget({ recoveryRound: 1 }),
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([9, 9, 9]), widthPx: 50, heightPx: 50 }),
      recognizeBlock: async (input: VlmRecognizeBlockInput) => {
        inputs.push(input);
        return okOutcome(frozenBlock({ id: input.block.layoutBlockId }));
      },
      insertBlockResult: async () => ({ written: true }),
      markRunPage: async () => {},
    });
    const sink = makeSink();
    const handler = createVlmRecognizePageHandler(d);
    const ctx = makeContext(
      'vlm.recognize_page',
      { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
      sink,
    );

    await handler(ctx);

    expect(inputs[0]?.prompt.systemPrompt).toContain('RETRY');
    // Версия промпта при этом та же: раунд — это тот же промт, выполненный
    // второй раз, и приписывать ему отдельную версию значило бы врать каталогу.
    expect(inputs[0]?.prompt.version).toBe(1);
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
          cropPolicyVersion: 'crop.v3',
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

  it('страница без живой задачи помечается отказом, а не ждёт четыре часа', async () => {
    /**
     * Так выглядела «заморозка распознавания» боевого инцидента.
     *
     * Воркер умер от нехватки памяти, задачи страниц исчерпали попытки, и
     * финализация ждала их двести сорок отсрочек — около четырёх часов — с
     * пустым журналом и застывшим счётчиком на экране. Различия между
     * «страница считается» и «страницу считать некому» у неё не было.
     */
    const marked: Record<string, unknown>[] = [];
    let pages: VlmRunPageState[] = [
      donePage(),
      { ...donePage({ workingPageIndex: 1 }), status: 'pending', blocksRecognized: 0 },
    ];
    const { fn: finishRun, calls: finishCalls } = idempotentFinishRun();
    const d = deps({
      listRunPages: async () => pages,
      // Задачи страницы 1 больше нет: она умерла вместе с воркером.
      livePageJobs: async () => new Set<number>(),
      markRunPage: async (input) => {
        marked.push(input as unknown as Record<string, unknown>);
        pages = pages.map((page) =>
          page.workingPageIndex === input.workingPageIndex
            ? { ...page, status: 'failed' as const }
            : page,
        );
      },
      listBlockEnvelopes: async () => [envelope(frozenBlock())],
      finishRun,
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
      { attempt: 1, maxAttempts: 60 },
    );

    /**
     * Ожидание закончилось, и прогон пошёл своим обычным путём.
     *
     * Здесь это честный отказ по покрытию: страница осталась нераспознанной, и
     * прогон закрывается с названной причиной. Важно не то, каким именно
     * исходом он кончился, а то, что он кончился, — до S41 на этом месте были
     * четыре часа молчания.
     */
    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionCoverageError);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ workingPageIndex: 1, status: 'failed' });
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.['status']).toBe('failed');

    // Уже распознанные блоки страницы не теряются: счётчики переносятся как есть.
    expect(marked[0]?.['blocksRecognized']).toBe(0);
  });

  it('страница с живой задачей по-прежнему ждёт, а не объявляется отказом', async () => {
    // Обратная сторона: пока задача в очереди или выполняется, отсрочка —
    // единственный правильный ответ. Иначе финализация обгоняла бы работу и
    // закрывала прогон посреди распознавания.
    const marked: unknown[] = [];
    const d = deps({
      listRunPages: async () => [
        donePage(),
        { ...donePage({ workingPageIndex: 1 }), status: 'pending' },
      ],
      livePageJobs: async () => new Set([1]),
      markRunPage: async (input) => {
        marked.push(input);
      },
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
      { attempt: 1, maxAttempts: 60 },
    );

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionPendingError);
    expect(marked).toHaveLength(0);
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

  it('пробел по вине модели — упавшая страница уходит на дораспознавание, а не в отказ', async () => {
    const finishCalls: Record<string, unknown>[] = [];
    const scheduled: Record<string, unknown>[] = [];
    const d = deps({
      listRunPages: async () => [
        donePage({ status: 'failed', blocksRecognized: 0, blocksRefused: 1 }),
      ],
      listBlockEnvelopes: async () => [],
      scheduleRecoveryRound: async (input) => {
        scheduled.push(input);
        return { scheduled: true, round: 1 };
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

    // Отсрочка, а не отказ: страницы вернулись в работу, и прогон закрывать
    // нечем — именно здесь прежде терялись 84 распознанных блока из 85.
    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionPendingError);
    expect(scheduled).toEqual([{ runId: RUN, fromRound: 0, pages: [0] }]);
    expect(finishCalls).toHaveLength(0);
  });

  it('страница упала не по вине модели — раунд не тратится', async () => {
    const finishCalls: Record<string, unknown>[] = [];
    const d = deps({
      // Расхождение геометрии рендера: счётчики модельных пробелов пусты.
      // Второй проход дал бы тот же отказ, оплатив его заново.
      listRunPages: async () => [donePage({ status: 'failed', blocksRecognized: 0 })],
      listBlockEnvelopes: async () => [],
      scheduleRecoveryRound: async () => {
        throw new Error('раунд не должен планироваться');
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

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionCoverageError);
    expect(finishCalls[0]?.['status']).toBe('failed');
  });

  it('раунд израсходован — покрытие неполно, прогон закрывается как прежде', async () => {
    const finishCalls: Record<string, unknown>[] = [];
    const d = deps({
      loadRun: async () => runTarget({ recoveryRound: 1 }),
      listRunPages: async () => [
        donePage({ status: 'failed', blocksRecognized: 0, blocksRefused: 1 }),
      ],
      listBlockEnvelopes: async () => [],
      scheduleRecoveryRound: async () => {
        throw new Error('второго раунда не бывает');
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

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionCoverageError);
    expect(finishCalls[0]?.['status']).toBe('failed');
  });

  it('раунд уже спланирован соседней попыткой — ждём, второй комплект задач не ставим', async () => {
    const finishCalls: Record<string, unknown>[] = [];
    const d = deps({
      listRunPages: async () => [
        donePage({ status: 'failed', blocksRecognized: 0, blocksInvalid: 1 }),
      ],
      listBlockEnvelopes: async () => [],
      // Переход раунда достался другой попытке финализации: она же поставила
      // задачи. Эта обязана просто ждать.
      scheduleRecoveryRound: async () => ({ scheduled: false, round: 1 }),
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

    await expect(handler(ctx)).rejects.toThrow(VlmRecognitionPendingError);
    expect(finishCalls).toHaveLength(0);
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

    await handler(ctx);

    // Повторный вызов не трогает ни публикацию, ни (напрямую) finishRun —
    // прогон уже не 'running', и обработчик останавливается на первой же
    // проверке цели, не переигрывая уже свершившийся исход.
    expect(publishResults).not.toHaveBeenCalled();
    // И выходит ТИХО, а не отказом: устаревшая задача — это «опоздал, уже не
    // нужно». Отказ здесь сжигал бы все попытки каждой задачи снятого прогона
    // (на комплекте в 83 страницы — сотня мертвецов) и держал бы красную плашку
    // на ревизии, у которой всё уже сброшено.
    expect(sink.logs.map((entry) => entry.fields['event'])).toContain('vlm_run_obsolete');
  });

  it('прогон снесён сбросом: задача пропускается тихо, а не отказом', async () => {
    const finishRun = vi.fn(async () => ({ changed: false }));
    const publishResults = vi.fn();
    const d = deps({
      loadRun: async () => null,
      finishRun,
      publishResults: publishResults as never,
    });
    const sink = makeSink();
    const handler = createVlmFinalizeHandler(d);
    const ctx = makeContext(
      'vlm.finalize_run',
      { revisionId: REVISION, recognitionRunId: RUN },
      sink,
      // Последняя попытка: именно на ней прежний отказ объявлял задачу мёртвой
      // и пытался закрыть прогон, которого больше нет.
      { attempt: 5, maxAttempts: 5 },
    );

    await handler(ctx);

    expect(publishResults).not.toHaveBeenCalled();
    expect(finishRun).not.toHaveBeenCalled();
    expect(sink.logs.map((entry) => entry.fields['event'])).toContain('vlm_run_obsolete');
  });
});

// =====================================================================
// Разворот содержимого страницы (ADR-0020)
// =====================================================================

describe('разворот содержимого доезжает до кропа и до провенанса', () => {
  it('кроп блока получает разворот страницы, а координаты остаются в системе листа', async () => {
    const cropCalls: Record<string, unknown>[] = [];
    const inserted: Record<string, unknown>[] = [];
    const d = deps({
      loadPageGeometry: async () => GEOMETRY_TURNED,
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async (input) => {
        cropCalls.push(input as unknown as Record<string, unknown>);
        return { png: new Uint8Array([1, 2, 3]), widthPx: 100, heightPx: 100 };
      },
      recognizeBlock: async (): Promise<VlmRecognizeBlockOutcome> => okOutcome(frozenBlock()),
      insertBlockResult: async (input) => {
        inserted.push(input as unknown as Record<string, unknown>);
        return { written: true };
      },
      markRunPage: async () => {},
      recordAiRun: async () => {},
    });

    const handler = createVlmRecognizePageHandler(d);
    await handler(
      makeContext(
        'vlm.recognize_page',
        { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
        makeSink(),
      ),
    );

    expect(cropCalls).toHaveLength(1);
    expect(cropCalls[0]?.['contentRotation']).toBe(90);
    // Координаты блока НЕ повёрнуты: прямоугольник вырезается в системе
    // страницы, а разворачивается уже картинка. Поворот координат здесь
    // означал бы вторую систему координат в портале.
    expect(cropCalls[0]?.['coordsNorm']).toEqual(DEFAULT_FROZEN[0]?.coordsNorm);

    // Провенанс называет разворот: без него перенесённый в будущем результат
    // неотличим от полученного по другой картинке.
    const envelope = (inserted[0]?.['block'] as { contentJson: Record<string, unknown> })
      .contentJson;
    const provenance = envelope['provenance'] as Record<string, unknown>;
    expect(provenance['contentRotation']).toBe(90);
    expect(provenance['cropPolicyVersion']).toBe('crop.v3');
  });

  it('на прямой странице в провенанс пишется явный ноль, а не отсутствие поля', async () => {
    const inserted: Record<string, unknown>[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async () => ({ png: new Uint8Array([1, 2, 3]), widthPx: 100, heightPx: 100 }),
      recognizeBlock: async (): Promise<VlmRecognizeBlockOutcome> => okOutcome(frozenBlock()),
      insertBlockResult: async (input) => {
        inserted.push(input as unknown as Record<string, unknown>);
        return { written: true };
      },
      markRunPage: async () => {},
      recordAiRun: async () => {},
    });

    const handler = createVlmRecognizePageHandler(d);
    await handler(
      makeContext(
        'vlm.recognize_page',
        { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
        makeSink(),
      ),
    );

    const envelope = (inserted[0]?.['block'] as { contentJson: Record<string, unknown> })
      .contentJson;
    const provenance = envelope['provenance'] as Record<string, unknown>;
    expect(Object.hasOwn(provenance, 'contentRotation')).toBe(true);
    expect(provenance['contentRotation']).toBe(0);
  });

  /**
   * Самый ценный тест правки.
   *
   * Модель видела РАЗВЁРНУТУЮ картинку и просит участок в её системе координат.
   * Растр лежит в системе страницы. Без обратного отображения модель получила бы
   * участок с другой стороны листа — и он выглядел бы правдоподобно, той же
   * страницей. Дефект не упал бы: он тихо испортил бы результат.
   */
  it('дозапрос кропа отображается ОБРАТНО в систему страницы', async () => {
    const cropCalls: Record<string, unknown>[] = [];
    const d = deps({
      loadPageGeometry: async () => GEOMETRY_TURNED,
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async (input) => {
        cropCalls.push(input as unknown as Record<string, unknown>);
        return { png: new Uint8Array([1, 2, 3]), widthPx: 100, heightPx: 100 };
      },
      recognizeBlock: async (input): Promise<VlmRecognizeBlockOutcome> => {
        // Модель просит ЛЕВУЮ ПОЛОВИНУ того, что видела.
        await input.requestCrop?.([0, 0, 0.5, 1]);
        return okOutcome(frozenBlock());
      },
      insertBlockResult: async () => ({ written: true }),
      markRunPage: async () => {},
      recordAiRun: async () => {},
    });

    const handler = createVlmRecognizePageHandler(d);
    await handler(
      makeContext(
        'vlm.recognize_page',
        { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
        makeSink(),
      ),
    );

    // Первый вызов — основной кроп, второй — дозапрос.
    expect(cropCalls).toHaveLength(2);
    // Обратное отображение при 90°: (x, y) → (y, 1 − x). Левая половина
    // развёрнутой картинки [0,0,0.5,1] — это НИЖНЯЯ половина страницы
    // [0, 0.5, 1, 1]. Не левая: иначе модель получила бы не то, что просила.
    const requested = cropCalls[1]?.['coordsNorm'] as readonly number[];
    expect(requested.map((v) => Number(v.toFixed(6)))).toEqual([0, 0.5, 1, 1]);
    // И выданный участок разворачивается вперёд тем же углом.
    expect(cropCalls[1]?.['contentRotation']).toBe(90);
  });

  it('на прямой странице дозапрос идёт без всякого преобразования', async () => {
    const cropCalls: Record<string, unknown>[] = [];
    const d = deps({
      workingPdfToFile: async () => ({ path: '/tmp/work.pdf', cleanup: async () => {} }),
      rasterizer: {
        kind: 'pdftoppm',
        version: '1.0',
        renderPage: async () => ({ widthPx: 595, heightPx: 842 }),
      },
      crop: async (input) => {
        cropCalls.push(input as unknown as Record<string, unknown>);
        return { png: new Uint8Array([1, 2, 3]), widthPx: 100, heightPx: 100 };
      },
      recognizeBlock: async (input): Promise<VlmRecognizeBlockOutcome> => {
        await input.requestCrop?.([0.25, 0.1, 0.75, 0.4]);
        return okOutcome(frozenBlock());
      },
      insertBlockResult: async () => ({ written: true }),
      markRunPage: async () => {},
      recordAiRun: async () => {},
    });

    const handler = createVlmRecognizePageHandler(d);
    await handler(
      makeContext(
        'vlm.recognize_page',
        { revisionId: REVISION, recognitionRunId: RUN, pageIndex: 0 },
        makeSink(),
      ),
    );

    expect(cropCalls[1]?.['coordsNorm']).toEqual([0.25, 0.1, 0.75, 0.4]);
    expect(cropCalls[1]?.['contentRotation']).toBe(0);
  });
});
