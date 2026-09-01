/**
 * `layout.detect_local` целиком: очередь → воркер → фейковый растеризатор +
 * фейковая ONNX-сессия → база (ADR-0008). По образцу `markup.integration.test.ts`.
 *
 * ## Что здесь настоящее
 *
 * PostgreSQL (pglite) под миграциями проекта, файловое хранилище, настоящий
 * многостраничный PDF (`pdf-lib`), настоящие `file.verify`/`bundle.build`
 * (карта страниц с реальными `widthPx/heightPx` берётся из НАСТОЯЩЕГО разбора
 * PDF), настоящий `createModelStore` (манифест реально скачивается из
 * хранилища, реально проходит zod-схему и sha256-сверку). Единственные
 * двойники — растеризатор (пишет заранее подготовленный PNG вместо вызова
 * `pdftoppm`) и ONNX-сессия (отдаёт фикстурные тензоры вместо инференса):
 * их нет смысла гонять по-настоящему в CI, а числовой путь между ними уже
 * проверен в `detector.test.ts`/`packages/detection`.
 *
 * ## Что проверяется
 *
 * Не «задача завершилась успехом», а результат в базе: блоки локальной
 * детекции несут `detector_provenance='rf_detr'` и заполненные
 * `detection_score`/`detection_model_version`; страница с ручным блоком не
 * тронута; повтор задачи не дублирует блоки; страница с нулём детекций —
 * терминальный успех; отказ без сконфигурированной модели — честная
 * `DetectionConfigurationError`; `layout.analyze_coverage` поставлена.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import type { MarkupPolicy } from '@id/contracts';
import { loadMigrations } from '@id/migrator';
import {
  blobKey,
  createDatabase,
  createLayoutBlock,
  createLogger,
  createMaintenanceRegistry,
  createMetrics,
  createPdfLibToolkit,
  createStorage,
  DbProcessingFeedbackSink,
  dedupeKeyFor,
  detectionManifestKey,
  detectionModelKey,
  ensureDraftLayout,
  enqueueSystemJob,
  findLayoutRevision,
  FALLBACK_LAYOUT_THRESHOLDS,
  importDetectedBlocks,
  JobRunner,
  listBundlePages,
  listLayoutBlocks,
  loadEnv,
  loadPdfLibModule,
  NoopErrorReporter,
  readDetectionSettings,
  type Database,
  type LayoutBlockView,
  type LayoutThresholds,
  type PageRasterizer,
  type PdfToolkit,
  type RenderPageInput,
  type RenderPageResult,
  type StorageProvider,
} from '@id/api';

import { createModelStore } from '../detection/model-store.js';
import type { OnnxSessionPort, OnnxTensorLike } from '../detection/session.js';
import { createLocalDetectionHandler, type LocalDetectionDeps } from './local-detection.js';
import { createWorkerRegistry } from './pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** Страница 72×72 pt (1×1 дюйм) -> ровно 300×300 px при RASTER_DPI=300, без округлений. */
const PAGE_COUNT = 3;
const RENDERED_SIZE = 300;

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR = id(2);
const OBJECT = id(4);
const SUBMISSION = id(10);
const REVISION = id(11);
const USER_CONTRACTOR = id(20);
const FILE = id(30);

const ADMIN_SCOPE = { kind: 'admin', userId: USER_CONTRACTOR } as const;
const MODEL_VERSION = 'v1-test';

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-detect-local-e2e-'));

let testDb: TestDatabase;
let db: Database;
let storage: StorageProvider;
let toolkit: PdfToolkit;
let bundleId = '';
let layoutRevisionId = '';

async function buildSourcePdf(): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const document = await PDFDocument.create();
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    document.addPage([72, 72]);
  }
  return Buffer.from(await document.save());
}

async function fixtureStatements(sha256: string, sizeBytes: number): Promise<readonly string[]> {
  return [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'TST02', 'Объект 2', 'ЖК «Тест», корпус 2')`,
    `INSERT INTO sections (code, name) VALUES ('roofing2', 'Кровля 2') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing2') ON CONFLICT DO NOTHING`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_CONTRACTOR}', 'kc-detect-local-contractor', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing2', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION}', '${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${sha256}', 'blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}', ${sizeBytes}, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
       VALUES ('${FILE}', '${REVISION}', '${sha256}', 'комплект.pdf', 0)`,
  ];
}

/** Растеризатор-двойник: пишет заранее сгенерированный PNG, размеры фиксированы. */
/**
 * Растеризатор-двойник, честный к размеру листа.
 *
 * Фикстура комплекта — квадратные страницы 72×72 pt, и на них хватало одной
 * картинки 300×300. Сценарии правила форматов переразмечают страницу в крупный
 * лист (S42), и рендер обязан отдавать размер, согласованный с картой страниц:
 * иначе `checkRenderedSize` отвергнет страницу раньше, чем дойдёт до отбора
 * блоков, и тест проверял бы сверку размеров вместо правила.
 */
class FakeRasterizer implements PageRasterizer {
  readonly kind = 'pdftoppm' as const;
  readonly version = 'fake-test';
  readonly #cache = new Map<string, Buffer>();
  constructor(private readonly png: Buffer) {}

  async renderPage(input: RenderPageInput): Promise<RenderPageResult> {
    const override = OVERSIZED_PAGES.get(input.pageIndex);
    if (override === undefined) {
      await writeFile(input.outPath, this.png);
      return { widthPx: RENDERED_SIZE, heightPx: RENDERED_SIZE };
    }

    const scale = input.dpi / 72;
    const widthPx = Math.round(override.widthPt * scale);
    const heightPx = Math.round(override.heightPt * scale);
    const key = `${String(widthPx)}x${String(heightPx)}`;
    let png = this.#cache.get(key);
    if (png === undefined) {
      png = await gradientPng(widthPx, heightPx);
      this.#cache.set(key, png);
    }
    await writeFile(input.outPath, png);
    return { widthPx, heightPx };
  }
}

/**
 * Растр с градиентом, а не однотонный.
 *
 * Крупный лист режется на плитки, и в тайловом режиме `detectPage` пропускает
 * ПУСТЫЕ плитки, не тратя на них инференс (`BLANK_TILE_STD_THRESHOLD`).
 * Однотонная заливка даёт нулевое стандартное отклонение, то есть пустую
 * плитку: сессия не вызывается ни разу, и тест «на крупном листе остаётся
 * штамп» проверял бы отсечение пустых плиток вместо правила форматов.
 */
async function gradientPng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      raw[offset] = (x * 7 + y * 13) % 256;
      raw[offset + 1] = (x * 3 + y * 5) % 256;
      raw[offset + 2] = (x + y) % 256;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * Страницы, переразмеченные тестом в крупный лист: индекс → размеры в пунктах.
 *
 * Заполняется сценариями правила форматов; пустая карта означает фикстуру как
 * была, поэтому все прежние сценарии продолжают работать не изменившись.
 */
const OVERSIZED_PAGES = new Map<number, { readonly widthPt: number; readonly heightPt: number }>();

/** ONNX-сессия-двойник: очередь фикстурных тензоров, по одной на вызов `run()`. */
class QueueSession implements OnnxSessionPort {
  #queue: { readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike }[];
  calls = 0;
  constructor(
    queue: readonly { readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike }[],
  ) {
    this.#queue = [...queue];
  }
  async run(): Promise<{ readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike }> {
    this.calls += 1;
    const next = this.#queue.shift();
    if (next === undefined) {
      throw new Error(
        'QueueSession: очередь фикстур исчерпана — вызвано больше раз, чем ожидалось',
      );
    }
    return next;
  }
}

function oneTextDetection(): { readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike } {
  return {
    dets: { data: Float32Array.from([0.5, 0.5, 0.4, 0.2]), dims: [1, 1, 4] },
    labels: { data: Float32Array.from([10, -10, -10, -10]), dims: [1, 1, 4] },
  };
}

/**
 * Штамп и текст на одном листе: класс `stamp` — столбец 2, `text` — столбец 0.
 *
 * Оба бокса уверенные, но на крупном листе в разметку обязан попасть только
 * штамп: текст чертежа (экспликации, выноски) в текст страницы не нужен.
 */
function stampAndTextDetection(): {
  readonly dets: OnnxTensorLike;
  readonly labels: OnnxTensorLike;
} {
  return {
    dets: { data: Float32Array.from([0.8, 0.9, 0.25, 0.12, 0.3, 0.3, 0.3, 0.2]), dims: [1, 2, 4] },
    labels: {
      data: Float32Array.from([-10, -10, 10, -10, 10, -10, -10, -10]),
      dims: [1, 2, 4],
    },
  };
}

function noDetection(): { readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike } {
  return {
    dets: { data: Float32Array.from([0.5, 0.5, 0.1, 0.1]), dims: [1, 1, 4] },
    labels: { data: Float32Array.from([-10, -10, -10, -10]), dims: [1, 1, 4] },
  };
}

/**
 * Детекция, уверенность которой лежит МЕЖДУ порогом по умолчанию и сниженным.
 *
 * Логит -1 даёт sigmoid ≈ 0.269: ниже дефолтных 0.5 и выше 0.2. Это и есть
 * воспроизведение боевого случая «страница не обведена вовсе», где детектор
 * что-то видел, но не дотянул до порога, — крайние ±10 из фикстур выше такой
 * случай проверить не могут, они от порога слишком далеки.
 */
const WEAK_TEXT_SCORE = 1 / (1 + Math.E);

function weakTextDetection(): { readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike } {
  return {
    dets: { data: Float32Array.from([0.5, 0.5, 0.4, 0.2]), dims: [1, 1, 4] },
    labels: { data: Float32Array.from([-1, -10, -10, -10]), dims: [1, 1, 4] },
  };
}

/** Записать настройку детекции в `app_settings` (jsonb, как это делает админка). */
async function setDetectionSetting(key: string, value: unknown): Promise<void> {
  await testDb.query(
    `INSERT INTO app_settings (key, value) VALUES ('${key}', '${JSON.stringify(value)}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
}

function manifestJson(): Record<string, unknown> {
  return {
    num_classes: 3,
    resolution: 16,
    class_mapping: { text: 0, image: 1, stamp: 2 },
    preprocessing: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
    tiling: { tile_size: 1024, overlap: 128 },
  };
}

/**
 * `MarkupTarget`-подобный объект по настоящей ревизии разметки — общий для
 * `LocalDetectionDeps.loadTargetByLayout` и двойника `MarkupDeps` в тесте
 * `layout.analyze_coverage`: обоим нужна ОДНА и та же цель, вычисленная одним
 * и тем же способом, иначе расхождение осталось бы незамеченным до прода.
 */
async function buildTestMarkupTarget(
  revisionId: string,
  lrId: string,
): Promise<{
  readonly layoutRevisionId: string;
  readonly revisionId: string;
  readonly bundleId: string;
  readonly objectId: string;
  readonly state: string;
  readonly detectorProfile: string;
  readonly workingPdfSha256: string;
  readonly workingPdfKey: string;
  readonly workingPdfSizeBytes: number;
  readonly pageIndices: readonly number[];
  readonly thresholds: LayoutThresholds;
  readonly layoutProfileVersion: number | null;
  readonly markupPolicy: MarkupPolicy;
} | null> {
  const layout = await findLayoutRevision(db, ADMIN_SCOPE, lrId);
  if (layout === null || layout.revisionId !== revisionId) return null;
  return {
    layoutRevisionId: layout.id,
    revisionId: layout.revisionId,
    bundleId: layout.bundleId,
    objectId: layout.objectId,
    state: layout.state,
    detectorProfile: layout.detectorProfile,
    workingPdfSha256: sourcePdfSha256,
    workingPdfKey: blobKey(sourcePdfSha256),
    workingPdfSizeBytes: sourcePdfSize,
    pageIndices: [...Array(PAGE_COUNT).keys()],
    // Умолчания портала, а не их копия: копия разошлась бы с профилем при
    // добавлении порога — как это и случилось с `textFallbackCoverageRatio`.
    thresholds: FALLBACK_LAYOUT_THRESHOLDS,
    layoutProfileVersion: null,
    // Правило берётся из ревизии — ровно как в боевой сборке зависимостей
    // (`buildMarkupTarget` в `pipeline.ts`). Сценарии ниже переключают его
    // через колонку, а не подменой двойника.
    markupPolicy: layout.markupPolicy,
  };
}

/** Собрать `LocalDetectionDeps` на настоящих репозиториях + двойники CPU-части. */
function localDetectionDeps(session: OnnxSessionPort): LocalDetectionDeps {
  const modelStore = createModelStore({
    storage,
    cacheDir: mkdtempSync(join(STORAGE_DIR, 'model-cache-')),
    createSession: async () => session,
  });

  return {
    rasterizer: new FakeRasterizer(rgbPagePng),
    modelStore,
    // Настоящий приёмник обратной связи на тестовой БД: проверять запись
    // двойником значило бы проверять двойник. `TestDatabase.query` отдаёт
    // строки, а `SqlExecutor` ждёт `{ rows }` — обёртка ровно в одну строку.
    feedback: new DbProcessingFeedbackSink({
      sql: {
        query: async (text: string, values?: readonly unknown[]) => ({
          rows: await testDb.query(text, values as unknown[] | undefined),
        }),
      },
      logger: createLogger({ service: 'detect-local-e2e', level: 'silent', env: 'test' }),
    }),

    loadTargetByLayout: async ({ revisionId, layoutRevisionId: lrId }) =>
      buildTestMarkupTarget(revisionId, lrId),

    // Настройки читаются целиком, как в боевой сборке зависимостей
    // (`pipeline.ts`): иначе тест на переопределения проверял бы двойник, а не
    // тот путь, по которому значения доезжают до модели.
    detectionSettings: async () => {
      const settings = await readDetectionSettings(db);
      return {
        modelVersion: settings.modelVersion,
        inferenceMode: settings.inferenceMode,
        overrides: settings.overrides,
      };
    },

    pageGeometry: async ({ bundleId: bId }) => listBundlePages(db, ADMIN_SCOPE, bId),

    existingBlockPages: async ({ layoutRevisionId: lrId }) => {
      const blocks = await listLayoutBlocks(db, ADMIN_SCOPE, lrId);
      return new Set(blocks.map((block) => block.workingPageIndex));
    },

    // Аренда вместо скачивания (S41): документ комплекта один и иммутабелен,
    // поэтому задачам его выдаёт кэш. Здесь он изображается файлом, который
    // живёт всё время теста, — освобождение аренды его не удаляет.
    workingPdf: async () => {
      const path = join(STORAGE_DIR, 'working-lease.pdf');
      await writeFile(path, sourcePdfBytes);
      return { path, release: async () => {} };
    },

    importBlocks: async (input) => {
      const result = await importDetectedBlocks(db, ADMIN_SCOPE, {
        layoutRevisionId: input.layoutRevisionId,
        workingPageIndices: input.workingPageIndices,
        blocks: input.blocks,
        // Как в боевой сборке (`pipeline.ts`): провенанс приходит от
        // обработчика. Константа здесь скрыла бы половину правила форматов —
        // полностраничный блок писался бы как результат детектора.
        provenance: input.provenance,
      });
      return { imported: result.imported, skippedPages: result.skippedPages };
    },
  };
}

let sourcePdfBytes: Buffer;
let sourcePdfSha256 = '';
let sourcePdfSize = 0;
let rgbPagePng: Buffer;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Гоняет очередь до опустошения (паттерн `markup.integration.test.ts`).
 *
 * Пустой проход НЕ означает «очередь встала»: `layout.analyze_coverage`
 * ставится с `runAfterMs: 1_000` (см. `local-detection.ts`), и наивный «один
 * пустой проход — стоп» иногда попадал бы РАНЬШЕ, чем `next_run_at` наступит,
 * молча пропуская отложенную задачу.
 */
async function drainQueue(runner: JobRunner, maxRounds = 20): Promise<void> {
  let idle = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await runner.runOnce();
    if (claimed > 0) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle > 3) return;
    await sleep(500);
  }
}

/** Гоняет очередь одним небольшим реестром, пока задачи не иссякнут. */
async function runJob(
  session: OnnxSessionPort,
  payload: { readonly pageIndices?: number[]; readonly overwriteExisting?: boolean },
): Promise<void> {
  const logger = createLogger({ service: 'detect-local-e2e', level: 'silent', env: 'test' });
  const metrics = createMetrics({ enabled: false, service: 'detect-local-e2e' });

  const registry = createMaintenanceRegistry();
  registry.register(
    'layout.detect_local',
    createLocalDetectionHandler(localDetectionDeps(session)),
  );

  const runner = new JobRunner({
    db,
    registry,
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-detect-local-e2e',
  });

  await enqueueSystemJob(db, {
    type: 'layout.detect_local',
    payload: { revisionId: REVISION, layoutRevisionId, ...payload },
    dedupeKey: `layout.detect_local:test:${Date.now()}:${Math.random()}`,
  });

  await drainQueue(runner);
  await runner.stop();
}

beforeAll(async () => {
  const TEST_ENV = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'dev-stub',
    CSRF_SECRET: 'csrf-secret-of-detect-local-e2e-0123456789',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-detect-local-e2e',
  });

  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  sourcePdfBytes = await buildSourcePdf();
  sourcePdfSha256 = createHash('sha256').update(sourcePdfBytes).digest('hex');
  sourcePdfSize = sourcePdfBytes.byteLength;
  for (const statement of await fixtureStatements(sourcePdfSha256, sourcePdfSize)) {
    await testDb.query(statement);
  }

  db = createDatabase(createTestPool(testDb) as unknown as Pool);

  const logger = createLogger({ service: 'detect-local-e2e', level: 'silent', env: 'test' });
  const metrics = createMetrics({ enabled: false, service: 'detect-local-e2e' });
  storage = createStorage(TEST_ENV, { metrics, logger });

  const originalKey = `blobs/${sourcePdfSha256.slice(0, 2)}/${sourcePdfSha256.slice(2, 4)}/${sourcePdfSha256}`;
  const target = join(STORAGE_DIR, originalKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, sourcePdfBytes);

  toolkit = createPdfLibToolkit(await loadPdfLibModule((specifier) => import(specifier)));

  rgbPagePng = await sharp({
    create: {
      width: RENDERED_SIZE,
      height: RENDERED_SIZE,
      channels: 3,
      background: { r: 40, g: 60, b: 80 },
    },
  })
    .png()
    .toBuffer();

  // Стадии приёма штатным путём (как в markup.integration.test.ts): без них
  // нет ни страниц (widthPx/heightPx source_pages), ни рабочего документа.
  const bootstrapRegistry = createWorkerRegistry({
    db,
    storage,
    toolkit,
    limits: { maxBytes: TEST_ENV.MAX_UPLOAD_BYTES, maxPages: TEST_ENV.MAX_PAGES_PER_FILE },
    workDirBase: STORAGE_DIR,
    rdweb: null,
    rdProjectId: null,
    previewCached: false,
  });
  const bootstrapRunner = new JobRunner({
    db,
    registry: bootstrapRegistry,
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-detect-local-bootstrap',
  });

  for (const type of ['file.verify', 'file.signature_probe'] as const) {
    await enqueueSystemJob(db, {
      type,
      payload: { revisionId: REVISION, sourceFileId: FILE },
      dedupeKey: dedupeKeyFor(type, FILE),
    });
  }
  await enqueueSystemJob(db, {
    type: 'bundle.build',
    payload: { revisionId: REVISION },
    dedupeKey: dedupeKeyFor('bundle.build', REVISION),
  });
  await drainQueue(bootstrapRunner);
  await bootstrapRunner.stop();

  const bundles = await testDb.query<{ id: string }>(
    `SELECT id FROM processing_bundles WHERE revision_id = '${REVISION}'`,
  );
  bundleId = bundles[0]?.id ?? '';
  expect(bundleId).not.toBe('');

  const { layout } = await ensureDraftLayout(db, ADMIN_SCOPE, { revisionId: REVISION, bundleId });
  layoutRevisionId = layout.id;
}, 300_000);

afterAll(async () => {
  await testDb.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

async function blockRows(): Promise<
  {
    working_page_index: number;
    block_type: string;
    source: string;
    detector_provenance: string;
    detection_score: number | null;
    detection_model_version: string | null;
  }[]
> {
  return testDb.query(
    `SELECT working_page_index, block_type, source, detector_provenance,
            detection_score, detection_model_version
       FROM layout_blocks WHERE layout_revision_id = '${layoutRevisionId}'
      ORDER BY working_page_index`,
  );
}

/** Записи обратной связи конвейера по этой ревизии, свежие сверху. */
async function feedbackRows(): Promise<
  {
    reason_code: string;
    feedback_type: string;
    pipeline_stage: string | null;
    working_page_index: number | null;
    detector_model_version: string | null;
    score: number | null;
  }[]
> {
  return testDb.query(
    `SELECT reason_code, feedback_type, pipeline_stage, working_page_index,
            detector_model_version, score
       FROM processing_feedback
      WHERE revision_id = '${REVISION}'
      ORDER BY at DESC`,
  );
}

describe('layout.detect_local без сконфигурированной модели', () => {
  it('пустая detection.model_version — DetectionConfigurationError с внятным текстом', async () => {
    // detection.model_version не задана вовсе -> действует дефолт '' реестра
    // настроек (SETTINGS_REGISTRY): readDetectionSettings возвращает ''.
    const registry = createMaintenanceRegistry();
    const session = new QueueSession([]);
    registry.register(
      'layout.detect_local',
      createLocalDetectionHandler(localDetectionDeps(session)),
    );

    const logger = createLogger({ service: 'detect-local-e2e', level: 'silent', env: 'test' });
    const metrics = createMetrics({ enabled: false, service: 'detect-local-e2e' });
    const runner = new JobRunner({
      db,
      registry,
      logger,
      metrics,
      errorReporter: new NoopErrorReporter(),
      workerId: 'worker-detect-local-no-model',
    });

    await enqueueSystemJob(db, {
      type: 'layout.detect_local',
      payload: { revisionId: REVISION, layoutRevisionId, pageIndices: [0] },
      dedupeKey: 'layout.detect_local:test:no-model',
    });
    await drainQueue(runner);
    await runner.stop();

    const failed = await testDb.query<{ error_message: string }>(
      `SELECT error_message FROM job_runs
        WHERE job_type = 'layout.detect_local' AND outcome <> 'succeeded'
        ORDER BY started_at DESC LIMIT 1`,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error_message ?? '').toMatch(/detection\.model_version/);
    expect(session.calls).toBe(0);
  });
});

describe('layout.detect_local с моделью', () => {
  beforeAll(async () => {
    await testDb.query(
      `INSERT INTO app_settings (key, value) VALUES ('detection.model_version', '"${MODEL_VERSION}"'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );

    const weights = Buffer.from('fake-onnx-weights-for-integration-test');
    const sha256 = createHash('sha256').update(weights).digest('hex');
    const manifestBytes = Buffer.from(
      JSON.stringify({ ...manifestJson(), onnx_sha256: sha256 }),
      'utf8',
    );
    await storage.putObject({
      key: detectionManifestKey(MODEL_VERSION),
      body: manifestBytes,
      contentType: 'application/json',
      contentLength: manifestBytes.byteLength,
    });
    await storage.putObject({
      key: detectionModelKey(MODEL_VERSION),
      body: weights,
      contentType: 'application/octet-stream',
      contentLength: weights.byteLength,
    });
  });

  it('манифест виден настройками: readDetectionSettings отдаёт заданную версию', async () => {
    const settings = await readDetectionSettings(db);
    expect(settings.modelVersion).toBe(MODEL_VERSION);
  });

  it('создаёт ручной блок на странице 2 заранее — локальная детекция обязана её не тронуть', async () => {
    const layout = await findLayoutRevision(db, ADMIN_SCOPE, layoutRevisionId);
    const manual = await createLayoutBlock(db, ADMIN_SCOPE, {
      layoutRevisionId,
      expectedVersion: layout?.version ?? 0,
      actorUserId: USER_CONTRACTOR,
      workingPageIndex: 2,
      blockType: 'text',
      shapeType: 'rectangle',
      x0: 0.1,
      y0: 0.1,
      x1: 0.9,
      y1: 0.9,
      points: [],
    });
    expect(manual.blockId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('детектирует страницы 0/1, страница 2 (ручной блок) не тронута, session не вызвана для неё', async () => {
    const session = new QueueSession([oneTextDetection(), noDetection()]);

    await runJob(session, { pageIndices: [0, 1, 2] });

    expect(session.calls).toBe(2);

    const rows = await blockRows();
    const byPage = new Map<number, typeof rows>();
    for (const row of rows) {
      const list = byPage.get(row.working_page_index) ?? [];
      list.push(row);
      byPage.set(row.working_page_index, list);
    }

    // Страница 0: одна авто-детекция с провенансом rf_detr и заполненными
    // detection_score/detection_model_version.
    const page0 = byPage.get(0) ?? [];
    expect(page0).toHaveLength(1);
    expect(page0[0]?.source).toBe('auto');
    expect(page0[0]?.detector_provenance).toBe('rf_detr');
    expect(page0[0]?.block_type).toBe('text');
    expect(page0[0]?.detection_score).not.toBeNull();
    expect(Number(page0[0]?.detection_score)).toBeGreaterThan(0.99);
    expect(page0[0]?.detection_model_version).toBe(MODEL_VERSION);

    // Страница 1: ноль детекций — терминальный успех, блоков нет.
    expect(byPage.get(1) ?? []).toHaveLength(0);

    // Страница 2: РОВНО тот же ручной блок, что был создан раньше.
    const page2 = byPage.get(2) ?? [];
    expect(page2).toHaveLength(1);
    expect(page2[0]?.source).toBe('user');
    expect(page2[0]?.detection_score).toBeNull();
    expect(page2[0]?.detection_model_version).toBeNull();
  });

  it('layout.analyze_coverage поставлена в очередь после детекции', async () => {
    const rows = await testDb.query<{ type: string; dedupe_key: string | null }>(
      `SELECT type, dedupe_key FROM jobs WHERE type = 'layout.analyze_coverage'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.dedupe_key).toBe(`layout.analyze_coverage:${layoutRevisionId}`);
  });

  it('пустая страница 1 действительно получает флаг no_blocks после анализа покрытия', async () => {
    const { createAnalyzeCoverageHandler } = await import('./markup.js');
    const analyzeDeps = {
      rdweb: null,
      rdProjectId: null,
      previewCached: false,
      loadTargetByLayout: async () => buildTestMarkupTarget(REVISION, layoutRevisionId),
      findRunDocument: async () => null,
      saveRunDocument: async () => {},
      replaceRunDocument: async () => {},
      openWorkingPdf: async () => {
        throw new Error('не используется');
      },
      importBlocks: async () => ({ imported: 0, skippedPages: [] }),
      loadPageBlocks: async () => {
        const [pages, blocks] = await Promise.all([
          listBundlePages(db, ADMIN_SCOPE, bundleId),
          listLayoutBlocks(db, ADMIN_SCOPE, layoutRevisionId),
        ]);
        const byPage = new Map<number, LayoutBlockView[]>();
        for (const block of blocks) {
          const list = byPage.get(block.workingPageIndex);
          if (list === undefined) byPage.set(block.workingPageIndex, [block]);
          else list.push(block);
        }
        return pages.map((page) => ({
          workingPageIndex: page.workingPageIndex,
          sourcePageId: page.sourcePageId,
          blocks: (byPage.get(page.workingPageIndex) ?? []).map((block) => ({
            blockType: block.blockType,
            x0: block.x0,
            y0: block.y0,
            x1: block.x1,
            y1: block.y1,
          })),
        }));
      },
      saveFlags: async (input: {
        readonly revisionId: string;
        readonly flags: ReadonlyMap<string, readonly string[]>;
      }) => {
        const { savePageAttentionFlags } = await import('@id/api');
        const outcome = await savePageAttentionFlags(db, ADMIN_SCOPE, {
          revisionId: input.revisionId,
          flags: input.flags as never,
        });
        return outcome.kind === 'written'
          ? { written: true }
          : { written: false, reason: outcome.reason };
      },
      storePreview: async () => {},
    };

    const registry = createMaintenanceRegistry();
    registry.register(
      'layout.analyze_coverage',
      createAnalyzeCoverageHandler(analyzeDeps as never),
    );
    const logger = createLogger({ service: 'detect-local-e2e', level: 'silent', env: 'test' });
    const metrics = createMetrics({ enabled: false, service: 'detect-local-e2e' });
    const runner = new JobRunner({
      db,
      registry,
      logger,
      metrics,
      errorReporter: new NoopErrorReporter(),
      workerId: 'worker-detect-local-analyze',
    });
    await drainQueue(runner);
    await runner.stop();

    const flagged = await testDb.query<{ working_page_index: number; attention_flags: string[] }>(
      `SELECT bp.working_page_index, sp.attention_flags
         FROM processing_bundle_pages bp
         JOIN source_pages sp ON sp.id = bp.source_page_id
        WHERE bp.revision_id = '${REVISION}' AND bp.working_page_index = 1`,
    );
    expect(flagged[0]?.attention_flags ?? []).toContain('no_blocks');
  });

  it('повтор задачи без overwriteExisting не дублирует блоки страницы 0', async () => {
    const before = await blockRows();
    const page0Before = before.filter((row) => row.working_page_index === 0);
    expect(page0Before).toHaveLength(1);

    // Страница 1 (пустая, без блоков) снова уходит на детекцию — retry пустой
    // страницы допустим; страницы 0 и 2 уже имеют блоки и без overwriteExisting
    // пропускаются, session вызывается ТОЛЬКО для страницы 1.
    const session = new QueueSession([noDetection()]);
    await runJob(session, { pageIndices: [0, 1, 2] });
    expect(session.calls).toBe(1);

    const after = await blockRows();
    expect(after.filter((row) => row.working_page_index === 0)).toHaveLength(1);
    expect(after.filter((row) => row.working_page_index === 1)).toHaveLength(0);
    expect(after.filter((row) => row.working_page_index === 2)).toHaveLength(1);
    expect(after).toHaveLength(before.length);
  });

  it('overwriteExisting=true пересматривает страницу 0 (не пропускает по skip-правилу)', async () => {
    const session = new QueueSession([oneTextDetection()]);
    await runJob(session, { pageIndices: [0], overwriteExisting: true });
    expect(session.calls).toBe(1);

    const after = await blockRows();
    const page0 = after.filter((row) => row.working_page_index === 0);
    expect(page0).toHaveLength(1);
    expect(page0[0]?.detector_provenance).toBe('rf_detr');
  });
});

/**
 * Ручки качества детекции (ADR-0008).
 *
 * Проверяется ровно тот сценарий, ради которого настройки и заведены: детектор
 * что-то увидел, но не дотянул до порога, страница осталась без блоков, и
 * единственным способом это изменить была правка файла модели в хранилище.
 */
describe('переопределения параметров детекции настройками портала', () => {
  it('порог по умолчанию отбрасывает слабую детекцию: страница остаётся пустой', async () => {
    await testDb.query(`DELETE FROM processing_feedback`);
    const session = new QueueSession([weakTextDetection()]);
    await runJob(session, { pageIndices: [1], overwriteExisting: true });
    expect(session.calls).toBe(1);

    const page1 = (await blockRows()).filter((row) => row.working_page_index === 1);
    expect(page1).toHaveLength(0);

    // Пустая страница объяснена, а не просто пуста: код причины отличает
    // «порог виноват» от «модель не увидела ничего», а `score` называет,
    // насколько близко подошёл лучший непринятый кандидат.
    const feedback = await feedbackRows();
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.reason_code).toBe('detect.low_score');
    expect(feedback[0]?.pipeline_stage).toBe('detect');
    expect(feedback[0]?.working_page_index).toBe(1);
    expect(feedback[0]?.detector_model_version).toBe(MODEL_VERSION);
    expect(Number(feedback[0]?.score)).toBeCloseTo(WEAK_TEXT_SCORE, 4);
  });

  it('модель не увидела ничего — причина названа иначе, чем «не дотянул до порога»', async () => {
    // Тот же внешний признак «блоков нет», но следствие для оператора другое:
    // снижать порог бессмысленно. Один код на оба случая сделал бы годовой ряд
    // по причинам бесполезным.
    await testDb.query(`DELETE FROM processing_feedback`);
    const session = new QueueSession([noDetection()]);
    await runJob(session, { pageIndices: [1], overwriteExisting: true });

    const feedback = await feedbackRows();
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.reason_code).toBe('detect.no_blocks');
  });

  it('страница с блоками записи об отказе не порождает', async () => {
    await testDb.query(`DELETE FROM processing_feedback`);
    const session = new QueueSession([oneTextDetection()]);
    await runJob(session, { pageIndices: [1], overwriteExisting: true });

    expect((await blockRows()).filter((row) => row.working_page_index === 1)).toHaveLength(1);
    expect(await feedbackRows()).toHaveLength(0);
  });

  it('сниженный detection.score_threshold доводит ту же детекцию до блока', async () => {
    // Ни модель, ни манифест, ни изображение не изменились — изменилась ТОЛЬКО
    // настройка. Если этот тест краснеет, значит переопределения не доезжают до
    // постобработки, и карточка в админке ничего не делает.
    await setDetectionSetting('detection.score_threshold', 0.2);

    const session = new QueueSession([weakTextDetection()]);
    await runJob(session, { pageIndices: [1], overwriteExisting: true });
    expect(session.calls).toBe(1);

    const page1 = (await blockRows()).filter((row) => row.working_page_index === 1);
    expect(page1).toHaveLength(1);
    expect(page1[0]?.block_type).toBe('text');
    expect(page1[0]?.detector_provenance).toBe('rf_detr');
    // Уверенность сохраняется как есть: порог решает, принимать ли детекцию, и
    // не подменяет её оценку.
    expect(Number(page1[0]?.detection_score)).toBeCloseTo(WEAK_TEXT_SCORE, 4);
  });

  it('порог по типу блока перекрывает общий для своего типа', async () => {
    // Общий порог остаётся сниженным (0.2), но для текста задан жёсткий 0.9 —
    // значит та же детекция снова не проходит. Обратное поведение означало бы,
    // что пороги по типам не доезжают либо затирают друг друга.
    await setDetectionSetting('detection.per_class_thresholds', { text: 0.9 });

    const session = new QueueSession([weakTextDetection()]);
    await runJob(session, { pageIndices: [1], overwriteExisting: true });
    expect(session.calls).toBe(1);

    expect((await blockRows()).filter((row) => row.working_page_index === 1)).toHaveLength(0);

    await setDetectionSetting('detection.per_class_thresholds', {});
    await setDetectionSetting('detection.score_threshold', null);
  });
});

describe('разворот содержимого страницы перед инференсом (ADR-0020)', () => {
  /**
   * Детектор обучен на прямых листах.
   *
   * На боковом он даёт скудную разметку, а табличная зона, оставшаяся без
   * блока, не будет распознана вовсе: её никто не спросит у модели. Поэтому
   * лист разворачивается ДО инференса — но координаты обязаны вернуться в
   * систему страницы, ту самую, в которой их рисует экран разметки.
   *
   * Проверяется именно это: фикстура детектора отдаёт ШИРОКИЙ бокс (0.4 × 0.2),
   * и на развёрнутой на 90° странице он обязан лечь в БД ВЫСОКИМ. Если
   * обратного поворота нет, бокс останется широким — и рамка на экране уедет
   * поперёк содержимого.
   */
  async function boxOfPage(pageIndex: number): Promise<{
    readonly width: number;
    readonly height: number;
  } | null> {
    const rows = await testDb.query<{ x0: string; y0: string; x1: string; y1: string }>(
      `SELECT x0, y0, x1, y1 FROM layout_blocks
        WHERE layout_revision_id = '${layoutRevisionId}'
          AND working_page_index = ${String(pageIndex)}
        LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { width: Number(row.x1) - Number(row.x0), height: Number(row.y1) - Number(row.y0) };
  }

  it('на прямой странице широкая детекция остаётся широкой', async () => {
    const session = new QueueSession([oneTextDetection()]);
    await runJob(session, { pageIndices: [1], overwriteExisting: true });

    const box = await boxOfPage(1);
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(box?.height ?? 1);
  });

  it('на развёрнутой странице та же детекция ложится в базу повёрнутой обратно', async () => {
    await testDb.query(
      `INSERT INTO page_orientations (revision_id, source_page_id, content_rotation, source)
       SELECT '${REVISION}', source_page_id, 90, 'user'
         FROM processing_bundle_pages
        WHERE bundle_id = '${bundleId}' AND working_page_index = 1
       ON CONFLICT (revision_id, source_page_id) DO UPDATE
         SET content_rotation = 90, source = 'user'`,
    );

    const session = new QueueSession([oneTextDetection()]);
    await runJob(session, { pageIndices: [1], overwriteExisting: true });
    expect(session.calls).toBe(1);

    const box = await boxOfPage(1);
    expect(box).not.toBeNull();
    // Широкая детекция на развёрнутом листе — это ВЫСОКИЙ блок страницы.
    expect(box?.height ?? 0).toBeGreaterThan(box?.width ?? 1);

    await testDb.query(`DELETE FROM page_orientations WHERE revision_id = '${REVISION}'`);
  });
});

/**
 * Правило разметки по формату листа (S42) — до базы включительно.
 *
 * Юнит-тест рядом проверяет решение (какой странице какой режим) на двойниках;
 * здесь проверяется ПОСЛЕДСТВИЕ: что именно легло в `layout_blocks` и в
 * `processing_feedback`. Три утверждения, каждое со своей ценой ошибки:
 * полностраничный блок малого листа не смеет называться результатом детектора;
 * крупный лист не смеет приносить текст чертежа; крупный лист без штампа не
 * смеет молча выглядеть как «детекция не справилась».
 */
describe('разметка по формату листа (S42)', () => {
  /** Чуть крупнее порога A4 (625.04 × 883.98 pt): растр 2625×3708 терпим для CI. */
  const LARGE_SHEET = { widthPt: 630, heightPt: 890 };
  const LARGE_PAGE = 1;
  const SMALL_PAGE = 0;

  beforeAll(async () => {
    await testDb.query(
      `UPDATE layout_revisions
          SET markup_policy = '{"version":1,"sheetStrategy":"sheet_aware","numberZone":"near_stamp","numberZonePad":{"x":0.1,"y":0.25}}'::jsonb
        WHERE id = '${layoutRevisionId}'`,
    );
    await testDb.query(
      `UPDATE source_pages SET width_px = ${String(LARGE_SHEET.widthPt)}, height_px = ${String(LARGE_SHEET.heightPt)}
        WHERE id IN (SELECT source_page_id FROM processing_bundle_pages
                      WHERE bundle_id = '${bundleId}' AND working_page_index = ${String(LARGE_PAGE)})`,
    );
    OVERSIZED_PAGES.set(LARGE_PAGE, LARGE_SHEET);
    await testDb.query(`DELETE FROM processing_feedback WHERE revision_id = '${REVISION}'`);
    /**
     * Инференс одним кадром: крупный лист иначе режется на дюжину плиток, и
     * очередь фикстур пришлось бы набивать ими вместо предмета проверки.
     * Плитки — предмет соседних сценариев, здесь проверяется ОТБОР блоков.
     */
    await testDb.query(
      `INSERT INTO app_settings (key, value) VALUES ('detection.inference_mode', '"whole_page"'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
  });

  afterAll(async () => {
    OVERSIZED_PAGES.clear();
    await testDb.query(`DELETE FROM app_settings WHERE key = 'detection.inference_mode'`);
  });

  async function blocksOfPage(
    pageIndex: number,
  ): Promise<
    readonly { block_type: string; detector_provenance: string; detection_score: string | null }[]
  > {
    return testDb.query(
      `SELECT block_type, detector_provenance, detection_score FROM layout_blocks
        WHERE layout_revision_id = '${layoutRevisionId}' AND working_page_index = ${String(pageIndex)}
        ORDER BY sort_order`,
    );
  }

  it('малый лист получает один полностраничный блок без вызова модели', async () => {
    // Очередь фикстур ПУСТА: любой вызов `session.run()` бросит исключение, и
    // это и есть проверка «модель не запускалась».
    const session = new QueueSession([]);

    await runJob(session, { pageIndices: [SMALL_PAGE], overwriteExisting: true });

    expect(session.calls).toBe(0);
    const blocks = await blocksOfPage(SMALL_PAGE);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.block_type).toBe('text');
    // Провенанс `full_page`, а не `rf_detr`: модель этот блок не рисовала, и
    // назвать его результатом детектора значило бы соврать в провенансе.
    expect(blocks[0]?.detector_provenance).toBe('full_page');
    // Уверенности нет — её неоткуда взять, и выдуманное число хуже пустоты.
    expect(blocks[0]?.detection_score).toBeNull();
  });

  it('на крупном листе остаётся штамп, текст чертежа отбрасывается', async () => {
    const session = new QueueSession([stampAndTextDetection()]);

    await runJob(session, { pageIndices: [LARGE_PAGE], overwriteExisting: true });

    expect(session.calls).toBe(1);
    const blocks = await blocksOfPage(LARGE_PAGE);
    expect(blocks.map((block) => block.block_type)).toEqual(['stamp']);
    expect(blocks[0]?.detector_provenance).toBe('rf_detr');
  });

  it('крупный лист без штампа остаётся без блоков и объясняется detect.no_stamp', async () => {
    // Ключевое отличие от `detect.no_blocks`: модель ЧТО-ТО видела. Это
    // качество входящей документации — чертёж без основной надписи, — а не
    // дефект конвейера, и годовой ряд по причинам обязан их различать.
    const session = new QueueSession([oneTextDetection()]);

    await runJob(session, { pageIndices: [LARGE_PAGE], overwriteExisting: true });

    expect(await blocksOfPage(LARGE_PAGE)).toEqual([]);
    const feedback = await testDb.query<{ reason_code: string }>(
      `SELECT reason_code FROM processing_feedback
        WHERE revision_id = '${REVISION}' AND working_page_index = ${String(LARGE_PAGE)}
        ORDER BY at DESC LIMIT 1`,
    );
    expect(feedback[0]?.reason_code).toBe('detect.no_stamp');
  });
});
