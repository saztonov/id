/**
 * Задачи VLM-распознавания (ADR-0007, план v3 Ф5): `vlm.start_recognition`,
 * `vlm.recognize_page`, `vlm.finalize_run`.
 *
 * Сестра `recognition.ts` (задачи 10–13, ветка RD WEB): те же принципы —
 * порты (`VlmRecognitionDeps`), `withVlmRunTermination` как общее правило
 * закрытия прогона при исчерпании попыток, а не перечисление классов ошибок.
 * Разделение то же и по той же причине (§ урок S3): обработчики написаны на
 * портах, связывание с базой/хранилищем/LLM живёт в `pipeline.ts`.
 *
 * ## ПОЧЕМУ deps-порт шире, чем в плане буквально
 *
 * План перечисляет `vlm: VlmPort | null` как приходящий порт, подразумевая
 * прямой импорт `recognizeBlock`/`assembleRecognitionResult`/
 * `RECOGNITION_PROMPT_DEFAULTS`/`schemaHash` из `@id/api`. На момент написания
 * этого файла `apps/api/src/index.ts` (публичная поверхность пакета для
 * воркера) их не реэкспортирует — они существуют и протестированы в
 * `apps/api/src/recognition/{assemble,vlm/recognize-block,vlm/prompts,vlm/schemas}.ts`,
 * но не видны из `@id/worker` через package boundary (`@id/api`'s `exports`
 * поле — только `"."`). Задача прямо запрещает мне трогать `apps/api/**`
 * (параллельные агенты), поэтому ЧЕТЫРЕ вещи, которые план хотел бы видеть
 * прямым импортом, здесь — ТОЖЕ deps-порты со СТРУКТУРНО идентичными
 * настоящим сигнатурам локальными типами:
 *
 * - `recognizeBlock` — оркестрация одного блока (`recognize-block.ts`);
 * - `assemble` — сборка + двусторонняя сверка (`recognition/assemble.ts`);
 * - `generationProfile` — параметры генерации и `responseFormat` по типу
 *   блока (`RECOGNITION_PROMPT_DEFAULTS`, `schemas.ts` → `schemaHash`);
 *
 * Типы подобраны так, что при разрешении экспорта настоящие функции подходят
 * под мои деps БЕЗ переходников (структурная типизация): `wiring` в
 * `pipeline.ts` — это либо прямое присваивание (`recognizeBlock:
 * recognizeBlockFromApi`), либо однострочная лямбда. Если к моменту wiring
 * `apps/api/src/index.ts` уже реэкспортирует эти символы — тем лучше, ничего
 * менять здесь не придётся.
 *
 * ## Три гейта, которые здесь не деградируют
 *
 * 1. **Гейт целостности перед стартом.** `computeBlocksHash(loadFrozenBlocks)`
 *    обязан совпасть с `run.localLayoutHash` до единственного `seedRunPages` +
 *    fan-out — иначе прогон распознаёт не тот набор блоков, который заказан.
 * 2. **Строгое покрытие перед публикацией.** `vlm.finalize_run` не публикует
 *    ничего, пока все страницы не терминальны И `listBlockEnvelopes` не
 *    покрывает `loadFrozenBlocks` полностью — нулевой/неполный результат не
 *    считается успехом (строже RD WEB: там законный допуск — блоки STAMP, тут
 *    его нет, все три типа обязаны быть покрыты). При выключенной неизменяемости
 *    (`core.enforce_immutability = false`, ADR-0015) вместо отказа публикуется
 *    согласованное подмножество: восемьдесят распознанных страниц полезнее нуля,
 *    а какая отвалилась — видно поимённо.
 * 3. **Идемпотентность через БД, не через память.** `insertBlockResult`
 *    (`ON CONFLICT DO NOTHING` на стороне репозитория) — единственный путь
 *    записи результата; повторная аренда `vlm.recognize_page` не платит дважды
 *    и не создаёт дублей. Указатели `current_block_result` и текст страниц
 *    двигает ТОЛЬКО `publishResults` внутри `vlm.finalize_run`, одной
 *    транзакцией, после проверки покрытия — упавший прогон не оставляет за
 *    собой ни байта downstream (инвариант 1 плана).
 *
 * ## Исчерпание попыток закрывает прогон
 *
 * `withVlmRunTermination` — аналог `withRunTermination` из `recognition.ts`
 * (не экспортирован там, поэтому здесь свой, тем же образцом). Прогон
 * закрывается на ПОСЛЕДНЕЙ попытке или при неповторяемой ошибке
 * (`classifyFailure().permanent`), а не по списку классов: список уже один раз
 * подвёл (S7 — `ExportFormatError`/`RecognitionIntegrityError` оставляли
 * прогон в `running` навсегда).
 */
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyFailure,
  computeBlocksHash,
  RASTER_DPI,
  redactAbsoluteUrls,
  type ArtifactKind,
  type HashableBlock,
  type JobContext,
  type JobHandler,
  type LlmProviderName,
  type PageRasterizer,
  type ProcessingFeedbackSink,
  type VlmJsonSchemaFormat,
  type VlmPort,
  type VlmResponse,
} from '@id/api';
import type { BlockType } from '@id/contracts';
import {
  PAGE_TEXT_RENDER_VERSION,
  recognitionBlockSchema,
  renderPageText,
  textBlockSchema,
  type RecognitionBlock,
  type RecognitionResult,
} from '@id/recognition';

import { CROP_POLICY_VERSION, type CropBlockInput, type CropBlockResult } from '../vlm/crop.js';

/** Конверт `content_json` результата блока — тег форматa, не версия схемы канона. */
export const RECOGNITION_BLOCK_RESULT_ENVELOPE = 'recognition.block_result.v1';

/** Допуск сверки геометрии рендера с сохранённой (§ crop policy / Ф4а «framesAgree»). */
const GEOMETRY_ASPECT_TOLERANCE = 0.02;

const RECOGNIZE_BLOCK_TYPES: readonly BlockType[] = ['text', 'image', 'stamp'];

// =====================================================================
// Типы целей и данных прогона
// =====================================================================

/**
 * Цель прогона VLM. Аналог `RunTarget` из `recognition.ts`, но без
 * RD-специфичных полей (`rdDocumentId`/`rdJobId`) — у VLM-прогона их нет по
 * построению (ADR-0007, `recognition_runs.rd_run_document_id` nullable).
 */
export interface VlmRunTarget {
  readonly runId: string;
  readonly revisionId: string;
  readonly layoutRevisionId: string;
  readonly status: string;
  readonly localLayoutHash: string;
  readonly settingsSnapshot: unknown;
}

/** Замороженный блок разметки: вход хэша целостности, кропа и провенанса. */
export interface VlmFrozenBlock {
  readonly id: string;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  readonly shapeType: 'rectangle' | 'polygon';
  readonly coordsNorm: readonly [number, number, number, number];
  readonly sortOrder: number;
  /** Точки нормализованы к ВСЕЙ странице (как `layout_block_points`); `null` — прямоугольник. */
  readonly polygon: readonly (readonly [number, number])[] | null;
}

/** Геометрия страницы рабочего документа — карта страниц bundle, БЕЗ рендера. */
export interface VlmPageGeometry {
  readonly workingPageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
}

export type VlmRunPageStatus = 'pending' | 'done' | 'failed';

export interface VlmRunPageState {
  readonly workingPageIndex: number;
  readonly status: VlmRunPageStatus;
  readonly blocksTotal: number;
  readonly blocksRecognized: number;
  readonly blocksInvalid: number;
  readonly blocksRefused: number;
}

/** Промпт стадии `recognize` по коду: опубликованная версия либо встроенный текст. */
export interface VlmPrompt {
  readonly code: string;
  /**
   * Версия из каталога, либо `0` — «опубликованной версии нет, взят встроенный
   * текст». Ноль уезжает в `settings_snapshot.promptVersions` наравне с прочими:
   * прогон обязан доказывать, чем он выполнен, и «встроенным» — такой же ответ,
   * как «версией 3».
   */
  readonly version: number;
  readonly systemPrompt: string;
  readonly userTemplate: string;
  readonly outputSchema: unknown;
  /**
   * Модель, зашитая в промпт администратором. ИГНОРИРУЕТСЯ здесь намеренно:
   * модель прогона зафиксирована `settings_snapshot` в момент старта — правка
   * промпта администратором во время выполняющегося прогона не имеет права
   * изменить, какая модель уже оплачивается и на каких результатах строится
   * покрытие. Расхождение (если `modelOverride` задан) уходит warning'ом в
   * лог, а не в вызов.
   */
  readonly modelOverride: string | null;
}

/** Параметры генерации и `responseFormat` по типу блока (не хранятся в `prompt_templates`). */
export interface VlmGenerationProfile {
  /** Код промпта по умолчанию для этого типа (`recognition_block_text` и т.п.). */
  readonly code: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly topK?: number | undefined;
  readonly responseFormat: VlmJsonSchemaFormat;
  /** sha256 канонизированной JSON Schema — единый источник истины схемы (см. шапку файла). */
  readonly schemaVersion: string;
}

// --- Оркестрация одного блока (структурно = recognize-block.ts, см. шапку) ---

export interface VlmRecognizeBlockPrompt {
  readonly code: string;
  readonly version: number;
  readonly systemPrompt: string;
  readonly userTemplate: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly topK?: number | undefined;
  readonly responseFormat: VlmJsonSchemaFormat;
  readonly schemaVersion: string;
}

export interface VlmRecognizeBlockInput {
  readonly vlm: VlmPort;
  readonly prompt: VlmRecognizeBlockPrompt;
  readonly model: string;
  readonly block: {
    readonly layoutBlockId: string;
    readonly blockType: BlockType;
    readonly coordsNorm: readonly [number, number, number, number];
    readonly sortOrder: number;
  };
  readonly cropPng: Uint8Array;
  readonly pageNumber: number;
  readonly downscale?: ((png: Uint8Array) => Promise<Uint8Array>) | undefined;
  /**
   * Выдача участка страницы по запросу модели (ADR-0013, S21).
   *
   * Зеркалит `RecognizeBlockInput.requestCrop` из `@id/api`: тип объявлен
   * здесь по тому же принципу, что и остальные поля этого интерфейса —
   * структурная копия, а не импорт, чтобы обработчик проверялся без пакета
   * api. Отсутствие означает, что инструмент модели не объявляется вовсе.
   */
  readonly requestCrop?:
    ((rect: readonly [number, number, number, number]) => Promise<Uint8Array | null>) | undefined;
}

export type VlmRecognizeBlockOutcome =
  | {
      readonly kind: 'ok';
      readonly block: RecognitionBlock;
      readonly raw: unknown;
      readonly response: VlmResponse;
      readonly warnings: readonly string[];
    }
  | { readonly kind: 'invalid_response'; readonly reason: string; readonly response?: VlmResponse }
  | { readonly kind: 'model_refusal'; readonly reason: string; readonly response?: VlmResponse };

// --- Сборка результата (структурно = recognition/assemble.ts) ---

export interface VlmAssembleFrozenBlock {
  readonly layoutBlockId: string;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  readonly coordsNorm: readonly [number, number, number, number];
  readonly sortOrder: number;
}

export interface VlmAssemblePageInput {
  readonly workingPageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
}

export interface VlmAssembleInput {
  readonly modelId: string | null;
  readonly pages: readonly VlmAssemblePageInput[];
  readonly frozenBlocks: readonly VlmAssembleFrozenBlock[];
  readonly results: ReadonlyMap<string, RecognitionBlock>;
}

// --- Артефакты (мирроp ArtifactView/RecordArtifactOutcome из recognition.ts) ---

export interface VlmStoredArtifact {
  readonly kind: ArtifactKind;
  readonly artifactSha256: string;
  readonly byteSize: number;
}

// --- Запись результата блока и ai_runs ---

export interface VlmSaveBlockResultInput {
  readonly layoutBlockId: string;
  readonly resultType: string;
  readonly contentHtml: string | null;
  readonly contentMd: string | null;
  readonly contentJson: unknown;
  readonly modelId: string | null;
  readonly confidence: number | null;
}

/**
 * Вход `recordAiRun`. `stage` — литерал `'recognize'`: реальный `LlmStage`
 * (`apps/api/src/llm/port.ts`) на момент написания этого файла его не
 * перечисляет (хотя CHECK `ai_runs_stage_chk`, миграция 0019, уже разрешает
 * значение в БД) — coordinator при wiring либо расширит `LlmStage`, либо
 * приведёт литерал через `as`. Здесь это не проблема: тип моего порта не
 * заимствован из `@id/api`, а объявлен локально.
 */
export interface VlmRecordAiRunInput {
  readonly revisionId: string;
  readonly stage: 'recognize';
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly promptCode: string | null;
  readonly promptVersion: number | null;
  readonly inputHash: string;
  readonly outputHash: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
  readonly latencyMs: number | null;
  readonly structuredResult: unknown;
  readonly requestId: string | null;
}

// =====================================================================
// Deps — единственная граница с базой/хранилищем/LLM/растеризатором
// =====================================================================

/**
 * Порты трёх задач VLM-распознавания.
 *
 * Каждое поле документирует, КАКОЙ функцией репозитория/модуля оно обязано
 * быть закрыто при wiring в `pipeline.ts` — «как wired».
 */
export interface VlmRecognitionDeps {
  /**
   * Как wired: `findRecognitionRun(db, scope, recognitionRunId)` (область —
   * от `revisionId` payload'а, как `pinScope` в `pipeline.ts`), с явной
   * сверкой `run.revisionId === revisionId` (payload с чужим прогоном не
   * находит его через область — тот же приём, что в `recognition.ts`).
   * `null` — прогона нет или он принадлежит другой ревизии.
   */
  loadRun(input: {
    readonly revisionId: string;
    readonly recognitionRunId: string;
  }): Promise<VlmRunTarget | null>;

  /**
   * Как wired: `listLayoutBlocks(db, scope, layoutRevisionId)` + точки полигона
   * (`layout_block_points`), отсортированные по `pointNo`, собранные в
   * `polygon: [x,y][] | null` (не пусто только для `shapeType==='polygon'`).
   */
  loadFrozenBlocks(runId: string): Promise<readonly VlmFrozenBlock[]>;

  /**
   * Действует ли строгий режим (`core.enforce_immutability`, ADR-0015).
   *
   * Как wired: `readImmutabilityEnforced(db)`. Читается по требованию, а не при
   * сборке зависимостей: настройка переключается администратором на живом
   * портале, и снимок, снятый при старте воркера, врал бы до перезапуска.
   */
  enforceGates(): Promise<boolean>;

  /**
   * Как wired: `processing_bundle_pages ⋈ source_pages` по `sourcePageId` в
   * пределах `bundleId` ревизии разметки прогона (тот же bundle, что и
   * `loadBundlePlan`/`listBundlePages`), `widthPx/heightPx/rotation` —
   * колонки `source_pages`. Чисто табличное чтение, рендера не требует —
   * используется И до рендера (сверка снимка при старте), И как эталон
   * геометрии для `framesAgree` в `vlm.recognize_page`.
   */
  loadPageGeometry(runId: string): Promise<readonly VlmPageGeometry[]>;

  /** Как wired: `seedRunPages(db, scope, runId, pages)` — 1:1. */
  seedRunPages(
    runId: string,
    pages: readonly { readonly workingPageIndex: number; readonly blocksTotal: number }[],
  ): Promise<void>;

  /** Как wired: `markRunPage(db, scope, input)` — 1:1. */
  markRunPage(input: {
    readonly runId: string;
    readonly workingPageIndex: number;
    readonly status: Exclude<VlmRunPageStatus, 'pending'>;
    readonly blocksRecognized: number;
    readonly blocksInvalid: number;
    readonly blocksRefused: number;
  }): Promise<void>;

  /** Как wired: `listRunPages(db, scope, runId)` — 1:1. */
  listRunPages(runId: string): Promise<readonly VlmRunPageState[]>;

  /** Как wired: `listRunBlockIds(db, scope, runId)` — 1:1 (checkpoint страницы). */
  existingBlockIds(runId: string): Promise<ReadonlySet<string>>;

  /** Как wired: `insertBlockResultIdempotent(db, scope, input)` — 1:1. */
  insertBlockResult(input: {
    readonly recognitionRunId: string;
    readonly layoutRevisionId: string;
    readonly block: VlmSaveBlockResultInput;
  }): Promise<{ readonly written: boolean }>;

  /** Как wired: `listRunBlockEnvelopes(db, scope, runId)` — 1:1. */
  listBlockEnvelopes(runId: string): Promise<
    readonly {
      readonly id: string;
      readonly layoutBlockId: string;
      readonly contentJson: unknown;
      readonly modelId: string | null;
    }[]
  >;

  /** Как wired: `publishVlmRunResults(db, scope, input)` — 1:1 (одна транзакция, инвариант 1). */
  publishResults(input: {
    readonly recognitionRunId: string;
    readonly artifactVersionId: string;
    readonly pages: readonly {
      readonly workingPageIndex: number;
      readonly textMd: string;
      readonly renderVersion: string;
    }[];
  }): Promise<{
    readonly pagesWritten: number;
    readonly pagesAlreadyPresent: number;
    readonly pagesOutOfRange: number;
    readonly pointersMoved: number;
  }>;

  /** Как wired: `mergeRunSettingsSnapshot(db, scope, runId, patch)` — 1:1. */
  mergeSnapshot(runId: string, patch: Record<string, unknown>): Promise<void>;

  /**
   * Как wired: `finishRecognitionRun(db, scope, input)` — 1:1 (статус здесь
   * уже сужен до исходов, которыми закрывается ЭТА ветка).
   */
  finishRun(input: {
    readonly runId: string;
    readonly status: 'done' | 'integrity_error' | 'failed';
    readonly counts?: Record<string, unknown> | undefined;
    readonly warnings?: readonly unknown[] | undefined;
    readonly reason?: string | undefined;
  }): Promise<{ readonly changed: boolean }>;

  /** Как wired: `findArtifact(db, scope, runId, kind)` — 1:1. */
  findArtifact(runId: string, kind: ArtifactKind): Promise<VlmStoredArtifact | null>;

  /** Как wired: `recordArtifact(db, scope, input)` — 1:1. */
  recordArtifact(input: {
    readonly runId: string;
    readonly kind: ArtifactKind;
    readonly artifactSha256: string;
    readonly byteSize: number;
  }): Promise<{ readonly kind: 'recorded' | 'already'; readonly artifactSha256: string }>;

  /** Как wired: `storage.getObjectStream(artifactKey(runId, kind))`, `null` — объекта нет (как в `recognition.ts`). */
  readArtifactBytes(runId: string, kind: ArtifactKind): Promise<Uint8Array | null>;

  /** Как wired: запись через `storage.putObject(artifactKey(runId, kind), bytes, contentType)`. */
  writeArtifactBytes(input: {
    readonly runId: string;
    readonly kind: ArtifactKind;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<void>;

  /** Как wired: `findArtifact(...).id` — тот же приём, что `artifactId` в `recognition.ts`. */
  artifactId(runId: string, kind: ArtifactKind): Promise<string>;

  /**
   * Текст промпта по коду — ВСЕГДА разрешается, `null` не бывает.
   *
   * Как wired: `listPromptTemplates(db, SYSTEM_SCOPE, {code, state:'published', limit:1})`,
   * а при пустом ответе — встроенный текст `recognitionPromptDefaultByCode(code)`
   * с `version: 0`. Двух опубликованных версий одного кода быть не может
   * (`ux_prompt_templates_single_published` — партиальный уникальный индекс по
   * `code`), поэтому неоднозначности здесь нет в отличие от `publishedPrompt`
   * по стадии в `pipeline.ts` (там на стадию — несколько кодов).
   *
   * Не-`null` — это контракт, а не удобство: пока метод мог вернуть пустоту, у
   * старта прогона стоял гейт «опубликуйте промпты стадии recognize», и он убивал
   * прогон на первой же миллисекунде. Тип теперь делает этот гейт невыразимым.
   */
  promptByCode(code: string): Promise<VlmPrompt>;

  /**
   * Как wired: `RECOGNITION_PROMPT_DEFAULTS[blockType]` (`apps/api/src/recognition/vlm/prompts.ts`)
   * + `schemaVersion: schemaHash(defaults.responseFormat.schema)` (`schemas.ts`).
   * Синхронно: чистые данные, без обращения к БД.
   */
  generationProfile(blockType: BlockType): VlmGenerationProfile;

  /** Порт VLM (ADR-0007). `null` — не настроен: обе задачи, которым он нужен, честно отказывают. */
  readonly vlm: VlmPort | null;

  /**
   * Как wired: `recognizeBlock` из `apps/api/src/recognition/vlm/recognize-block.ts`
   * (см. шапку файла — структурно идентичная сигнатура, прямое присваивание).
   */
  recognizeBlock(input: VlmRecognizeBlockInput): Promise<VlmRecognizeBlockOutcome>;

  /** Растеризатор страниц (ADR-0008, `pdf/raster.ts`). `null` — не настроен: честный отказ. */
  readonly rasterizer: PageRasterizer | null;

  /**
   * Рабочий PDF прогона на диске. Как wired: прочитать `blobKey(run.workingPdfSha256)`
   * из хранилища во временный файл (аналог `openWorkingPdf` в `pipeline.ts`,
   * но с материализацией на диск — `pdftoppm` требует путь, не поток).
   * `cleanup` обязан быть вызываем безопасно даже после частичного отказа
   * записи (idempotent remove).
   */
  workingPdfToFile(runId: string): Promise<{ readonly path: string; cleanup(): Promise<void> }>;

  /** Как wired: `cropBlockPng` из `../vlm/crop.js` (этот же пакет, прямая передача). */
  crop(input: CropBlockInput): Promise<CropBlockResult>;

  /** Как wired: `downscalePng` из `../vlm/crop.js`. Тот же коэффициент, что и потолок кропа. */
  downscale(png: Uint8Array): Promise<Uint8Array>;

  /**
   * Как wired: `assembleRecognitionResult` из `apps/api/src/recognition/assemble.ts`
   * (см. шапку файла). Бросает при расхождении сверки — вызывающий здесь ловит
   * по имени ошибки (`RecognitionAssembleError`), не по `instanceof` (класс не
   * импортирован через package boundary, а `error.name` — контрактно стабилен,
   * тот же приём, что `isPayloadTooLarge` в `recognize-block.ts`).
   */
  assemble(input: VlmAssembleInput): RecognitionResult;

  /** Как wired: `recordAiRun(db, scope, input)` — 1:1. Вызывается и на успех, и на отказ. */
  recordAiRun(input: VlmRecordAiRunInput): Promise<void>;

  /**
   * Приёмник дефектов качества (§11, ADR-0010).
   *
   * `ai_runs` фиксирует, что вызов БЫЛ и сколько стоил; `recognition_run_pages`
   * — сколько блоков вышло непригодными. Ни то, ни другое не отвечает, ПОЧЕМУ
   * и КАКОЙ версией промта: именно этого не хватало, чтобы дорабатывать промты
   * по данным, а не по памяти.
   */
  readonly feedback: ProcessingFeedbackSink;

  /** Как wired: `sha256Hex`. */
  sha256(bytes: Uint8Array): string;
}

// =====================================================================
// Классы отказов
// =====================================================================

/**
 * Общая структурная договорённость с `classifyFailure` (`@id/api`, `jobs/runner.ts`):
 * оно смотрит на `.retriable`, а не на `instanceof`. Мои три класса намеренно
 * САМИ объявляют `retriable`, а не полагаются на дефолт (`retriabilityOf`
 * возвращает `null` при отсутствии поля → `permanent:false`, то есть прогон
 * НЕ закрылся бы до исчерпания `maxAttempts`). Все три случая здесь
 * детерминированы — повтор не помогает, поэтому `retriable:false` и закрытие
 * происходит на первом же попадании в `withVlmRunTermination`, а не после N
 * бесполезных попыток.
 */
export class VlmRecognitionConfigurationError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'VlmRecognitionConfigurationError';
  }
}

/** Расхождение доказательств (хэш, покрытие, сборка). Результаты не используются. */
export class VlmRecognitionIntegrityError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'VlmRecognitionIntegrityError';
  }
}

export class VlmRecognitionStateError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'VlmRecognitionStateError';
  }
}

/** Страницы терминальны, но покрытие неполно: нулевой/неполный результат — не успех. */
export class VlmRecognitionCoverageError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'VlmRecognitionCoverageError';
  }
}

/**
 * «Ещё идёт» — единственный класс здесь с `retriable:true`: пока страницы не
 * терминальны, повтор — это и есть план (аналог `RdWebError` в
 * `rd.poll_recognition`). Исчерпание `maxAttempts` (60) закрывает прогон
 * `failed` через `withVlmRunTermination` тем же общим правилом.
 */
export class VlmRecognitionPendingError extends Error {
  readonly retriable = true;
  constructor(message: string) {
    super(message);
    this.name = 'VlmRecognitionPendingError';
  }
}

// =====================================================================
// withVlmRunTermination — общее правило закрытия прогона
// =====================================================================

type VlmJobType = 'vlm.start_recognition' | 'vlm.recognize_page' | 'vlm.finalize_run';

const MAX_REASON_LENGTH = 400;

/**
 * Причина закрытия прогона — по факту, а не по шаблону.
 *
 * Прежний текст говорил «исчерпала попытки» всегда, в том числе на первой попытке
 * из пяти, когда прогон закрывала неповторяемая ошибка. В журнале это выглядело
 * как исчерпанный лимит, которого не было, и уводило разбор в сторону.
 */
function vlmTerminationReason(jobType: string, error: unknown, exhausted: boolean): string {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const what = exhausted ? 'исчерпала попытки' : 'отказала неповторимо';
  const scrubbed = redactAbsoluteUrls(`задача ${jobType} ${what}: ${name}: ${message}`);
  return scrubbed.text.slice(0, MAX_REASON_LENGTH);
}

/**
 * Останавливает ли отказ ВЕСЬ прогон, а не только текущий вызов.
 *
 * Берётся у самого отказа (`LlmError.stopsBatch`) — тем же приёмом, что в
 * `segmentation.ts`, где стадия анализа этот флаг уже уважает. Отказ, ничего о
 * себе не сказавший, прогон не останавливает: продолжить обход страниц дешевле,
 * чем потерять восемьдесят распознанных из-за одной.
 *
 * До правки здесь стояло `classifyFailure(error).permanent`, то есть `!retriable`,
 * — и это сводило два РАЗНЫХ вопроса к одному. `retriable` отвечает «поможет ли
 * повтор ЭТОГО вызова», `stopsBatch` — «имеет ли смысл продолжать остальные»
 * (см. шапку `LlmError` в `llm/port.ts`). Транспортный 400 на одной странице
 * неповторим, но остальные восемьдесят две страницы к нему отношения не имеют;
 * на проде именно это и случилось: одна страница закрыла прогон целиком, а
 * оставшиеся 128 задач умерли с «прогон уже завершён». Прогон останавливают
 * только четыре отказа, которые объявляют `stopsBatch: true`: заблокированный
 * провайдер, выключенный ИИ, модель вне allowlist, исчерпанный бюджет.
 */
function stopsBatch(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value: unknown = (error as { stopsBatch?: unknown }).stopsBatch;
  return value === true;
}

/**
 * Аналог `withRunTermination` из `recognition.ts` (там не экспортирован —
 * свой, тем же образцом, см. шапку файла). Закрывает прогон на последней
 * попытке или при отказе, останавливающем весь обход; `finishRun` уже вызванный
 * внутри обработчика (гейты с конкретной причиной) делает повторный вызов здесь
 * идемпотентным no-op — `finishRecognitionRun` пишет только из `running`.
 */
function withVlmRunTermination<T extends VlmJobType>(
  deps: VlmRecognitionDeps,
  handler: JobHandler<T>,
): JobHandler<T> {
  return async (ctx: JobContext<T>) => {
    try {
      await handler(ctx);
    } catch (error) {
      const exhausted = ctx.attempt >= ctx.maxAttempts;
      if (exhausted || stopsBatch(error)) {
        const payload = ctx.payload as { readonly recognitionRunId: string };
        try {
          const outcome = await deps.finishRun({
            runId: payload.recognitionRunId,
            status: error instanceof VlmRecognitionIntegrityError ? 'integrity_error' : 'failed',
            reason: vlmTerminationReason(ctx.type, error, exhausted),
            warnings: [
              {
                code: exhausted ? 'job_attempts_exhausted' : 'job_stops_batch',
                jobType: ctx.type,
                attempt: ctx.attempt,
                errorClass: classifyFailure(error).errorClass,
              },
            ],
          });
          ctx.logger.error(
            {
              event: 'vlm_recognition_run_terminated',
              job_type: ctx.type,
              attempt: ctx.attempt,
              max_attempts: ctx.maxAttempts,
              exhausted,
              error_class: classifyFailure(error).errorClass,
              changed: outcome.changed,
            },
            exhausted
              ? 'попытки задачи исчерпаны, прогон VLM-распознавания завершён'
              : 'отказ останавливает весь обход, прогон VLM-распознавания завершён',
          );
        } catch (finishError) {
          ctx.logger.error(
            {
              event: 'vlm_recognition_run_termination_failed',
              job_type: ctx.type,
              reason: (finishError as Error).name,
            },
            'прогон не удалось перевести в терминальное состояние',
          );
        }
      }
      throw error;
    }
  };
}

// =====================================================================
// Мелкие чистые помощники
// =====================================================================

/**
 * Прогон, в который ещё можно писать, — или `null`, если писать уже некуда.
 *
 * `null` возвращается в двух случаях, и оба — «опоздал, уже не нужно», а не
 * отказ: строки прогона нет вовсе (сброс конвейера или удаление комплекта её
 * снесли) либо прогон уже терминален (его заменило новое нажатие «Распознать»,
 * закрыла финализация, отменил человек).
 *
 * Прежде здесь был `VlmRecognitionStateError`, и он стоил ровно того же, что
 * стоил отказ устаревшей пачки детекции до S24: класс не объявляет `retriable`,
 * то есть считается преходящим, и КАЖДАЯ задача уже неактуального прогона
 * сжигала все свои попытки, чтобы в конце объявить себя мёртвой. На комплекте в
 * 83 страницы это сотня мертвецов и красная плашка на ревизии, у которой всё
 * уже сброшено. Образец тихого выхода — `detection_batch_obsolete` в
 * `local-detection.ts`.
 *
 * Настоящие расхождения состояния (пустая разметка, разошедшийся хэш блоков,
 * непригодный снимок настроек) остаются отказами: там предмет работы на месте,
 * и молчать о нём нельзя.
 */
async function loadRunningVlmRun(
  deps: VlmRecognitionDeps,
  ctx: { readonly logger: JobContext<VlmJobType>['logger']; readonly type: string },
  payload: { readonly revisionId: string; readonly recognitionRunId: string },
): Promise<VlmRunTarget | null> {
  const run = await deps.loadRun(payload);
  if (run === null || run.status !== 'running') {
    ctx.logger.info(
      {
        event: 'vlm_run_obsolete',
        job_type: ctx.type,
        recognition_run_id: payload.recognitionRunId,
        run_status: run?.status ?? null,
      },
      run === null
        ? 'прогон распознавания уже снесён: задача устарела и пропущена'
        : 'прогон распознавания уже завершён: задача устарела и пропущена',
    );
    return null;
  }
  return run;
}

function toHashableBlock(block: VlmFrozenBlock): HashableBlock {
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

function snapshotOf(run: VlmRunTarget): Record<string, unknown> {
  return typeof run.settingsSnapshot === 'object' && run.settingsSnapshot !== null
    ? (run.settingsSnapshot as Record<string, unknown>)
    : {};
}

function snapshotModelOf(run: VlmRunTarget): string {
  const model = snapshotOf(run)['model'];
  return typeof model === 'string' ? model : '';
}

function dryRunOf(run: VlmRunTarget): boolean {
  return snapshotOf(run)['dryRun'] === true;
}

/**
 * Сверка геометрии рендера с сохранённой картой страниц («framesAgree»,
 * Ф4а). Сравнение — по СООТНОШЕНИЮ СТОРОН, а не по абсолютным пикселям:
 * `source_pages.widthPx/heightPx` и рендер `PageRasterizer` живут на разных
 * шкалах (страница хранится в поинтах/эталонном разрешении приёма, рендер —
 * на `RASTER_DPI`), и прямое сравнение пикселей ложно расходилось бы на КАЖДОЙ
 * странице. Аспект от масштаба не зависит; расхождение аспекта — это
 * настоящий признак заменённого/повёрнутого иначе документа.
 */
function frameSizesAgree(
  rendered: { readonly widthPx: number; readonly heightPx: number },
  geometry: { readonly widthPx: number; readonly heightPx: number },
): boolean {
  if (rendered.heightPx <= 0 || geometry.heightPx <= 0) return false;
  const renderedRatio = rendered.widthPx / rendered.heightPx;
  const geometryRatio = geometry.widthPx / geometry.heightPx;
  const diff = Math.abs(renderedRatio - geometryRatio) / Math.max(renderedRatio, geometryRatio);
  return diff <= GEOMETRY_ASPECT_TOLERANCE;
}

function parseBlockEnvelope(contentJson: unknown): RecognitionBlock | null {
  if (typeof contentJson !== 'object' || contentJson === null) return null;
  const envelope = contentJson as Record<string, unknown>;
  if (envelope['envelope'] !== RECOGNITION_BLOCK_RESULT_ENVELOPE) return null;
  const result = recognitionBlockSchema.safeParse(envelope['block']);
  return result.success ? result.data : null;
}

/**
 * `LlmError.attempt` (`apps/api/src/llm/port.ts`) структурно, без импорта
 * класса: провайдер приложил её на выходе к отказу, дошедшему до сети.
 * Отсутствие (`null`) означает «вызова не было вовсе» — тогда строка
 * `ai_runs` не пишется (её CHECK'и требуют хэшей, см. `ai-runs.ts`), это же
 * поведение, что у сегментации (`segmentation.ts`, `if (trace === null) return`).
 */
function llmAttemptOf(error: unknown): {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly inputHash: string;
  readonly latencyMs: number;
} | null {
  if (typeof error !== 'object' || error === null) return null;
  const attempt = (error as { attempt?: unknown }).attempt;
  if (typeof attempt !== 'object' || attempt === null) return null;
  const a = attempt as Record<string, unknown>;
  if (
    typeof a['provider'] !== 'string' ||
    typeof a['model'] !== 'string' ||
    typeof a['inputHash'] !== 'string' ||
    typeof a['latencyMs'] !== 'number'
  ) {
    return null;
  }
  return {
    provider: a['provider'] as LlmProviderName,
    model: a['model'] as string,
    inputHash: a['inputHash'] as string,
    latencyMs: a['latencyMs'] as number,
  };
}

/**
 * Проверка по имени класса, а не `instanceof` — та же страховка, что в
 * `recognize-block.ts` (`isPayloadTooLarge`): инстанс мог прийти из другой
 * копии модуля `@id/api` (алиасы vitest ↔ dist), и `instanceof` через границу
 * копий лжёт, а `error.name` контрактно стабилен.
 */
function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'LlmPayloadTooLargeError'
  );
}

function requireVlm(deps: VlmRecognitionDeps): VlmPort {
  if (deps.vlm === null) {
    throw new VlmRecognitionConfigurationError(
      'VLM-провайдер не настроен: маршрут openrouter_vlm недоступен без настроенного порта',
    );
  }
  return deps.vlm;
}

function requireRasterizer(deps: VlmRecognitionDeps): PageRasterizer {
  if (deps.rasterizer === null) {
    throw new VlmRecognitionConfigurationError(
      'Растеризатор PDF не настроен: страницы для VLM рендерить нечем (ADR-0008)',
    );
  }
  return deps.rasterizer;
}

// =====================================================================
// vlm.start_recognition
// =====================================================================

export function createVlmStartHandler(
  deps: VlmRecognitionDeps,
): JobHandler<'vlm.start_recognition'> {
  return withVlmRunTermination(deps, async (ctx: JobContext<'vlm.start_recognition'>) => {
    const run = await loadRunningVlmRun(deps, ctx, ctx.payload);
    if (run === null) return;

    requireVlm(deps);
    const rasterizer = requireRasterizer(deps);

    // --- Гейт снимка: version 2, provider openrouter_vlm, модель непуста ---
    const snapshot = snapshotOf(run);
    const model = snapshotModelOf(run);
    if (snapshot['version'] !== 2 || snapshot['provider'] !== 'openrouter_vlm' || model === '') {
      throw new VlmRecognitionConfigurationError(
        'Снимок настроек прогона непригоден для VLM: ожидается {version:2, provider:"openrouter_vlm"} и непустая модель',
      );
    }

    // --- Гейт целостности (инвариант 5 / § НЕ-ДЕГРАДИРУЕМЫЙ ГЕЙТ) ---
    const frozen = await deps.loadFrozenBlocks(run.runId);
    const actualHash = computeBlocksHash(frozen.map(toHashableBlock));
    if (actualHash !== run.localLayoutHash) {
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        reason: 'локальный набор блоков изменился после заморозки: хэш не совпал перед стартом VLM',
        counts: { frozenBlocks: frozen.length },
      });
      throw new VlmRecognitionIntegrityError(
        `Хэш замороженных блоков не совпал: локальный ${run.localLayoutHash.slice(0, 12)}…, ` +
          `фактический ${actualHash.slice(0, 12)}…`,
      );
    }

    // --- Пустая разметка — не успех ---
    if (frozen.length === 0) {
      await deps.finishRun({
        runId: run.runId,
        status: 'failed',
        reason: 'в замороженной разметке нет блоков',
      });
      throw new VlmRecognitionStateError('В замороженной разметке нет блоков: распознавать нечего');
    }

    // --- Версии промптов, которыми пойдёт этот прогон ---
    //
    // Гейта «опубликуйте промпты стадии recognize» здесь больше нет. Он убивал
    // прогон на первой же миллисекунде, требуя ручной публикации текста, который
    // и так лежит в коде: сид-миграция промптов генерируется из тех же констант.
    // Теперь отсутствие опубликованной версии — это `version: 0` в снимке, а не
    // отказ (см. `recognitionPromptDefaultByCode`).
    const promptVersions: Record<string, number> = {};
    for (const blockType of RECOGNIZE_BLOCK_TYPES) {
      const profile = deps.generationProfile(blockType);
      const published = await deps.promptByCode(profile.code);
      // Сверка неизменности НЕ выполняется: правка system/user промпта
      // администратором законна (см. VlmPrompt.modelOverride) — фиксируется
      // только версия, использованная этим прогоном.
      promptVersions[blockType] = published.version;
      if (published.modelOverride !== null && published.modelOverride !== model) {
        ctx.logger.warn(
          {
            event: 'prompt_model_override_ignored',
            block_type: blockType,
            prompt_code: profile.code,
            override: published.modelOverride,
            run_model: model,
          },
          'modelOverride опубликованного промпта проигнорирован: модель прогона зафиксирована снимком',
        );
      }
    }

    await deps.mergeSnapshot(run.runId, {
      promptVersions,
      rasterizer: { kind: rasterizer.kind, version: rasterizer.version, dpi: RASTER_DPI },
      cropPolicyVersion: CROP_POLICY_VERSION,
    });

    // --- Сидирование страниц с блоками + fan-out ---
    const blocksByPage = new Map<number, number>();
    for (const block of frozen) {
      blocksByPage.set(block.workingPageIndex, (blocksByPage.get(block.workingPageIndex) ?? 0) + 1);
    }
    const pages = [...blocksByPage.entries()]
      .map(([workingPageIndex, blocksTotal]) => ({ workingPageIndex, blocksTotal }))
      .sort((a, b) => a.workingPageIndex - b.workingPageIndex);

    await deps.seedRunPages(run.runId, pages);

    for (const page of pages) {
      await ctx.enqueue({
        type: 'vlm.recognize_page',
        payload: {
          revisionId: run.revisionId,
          recognitionRunId: run.runId,
          pageIndex: page.workingPageIndex,
        },
        dedupeKey: `vlm.recognize_page:${run.runId}:${page.workingPageIndex}`,
      });
    }
    // Признак сквозного прогона доезжает до финализации: именно она решает,
    // ставить ли анализ. Страницам он не нужен — они ничего дальше не ставят.
    await ctx.enqueue({
      type: 'vlm.finalize_run',
      payload: {
        revisionId: run.revisionId,
        recognitionRunId: run.runId,
        ...(ctx.payload.autoContinue === true ? { autoContinue: true } : {}),
      },
      dedupeKey: `vlm.finalize_run:${run.runId}`,
    });

    ctx.logger.info(
      { event: 'vlm_recognition_started', pages: pages.length, blocks: frozen.length },
      'VLM-распознавание запущено: страницы сидированы, fan-out поставлен',
    );
  });
}

// =====================================================================
// vlm.recognize_page
// =====================================================================

/**
 * Запись дефекта качества по блоку.
 *
 * Собрана в одном месте, чтобы обе ветки отказа заполняли провенанс одинаково:
 * разойдись они в наборе полей — и срез «доля дефектов у промта X версии N»
 * посчитался бы по разным знаменателям, а расхождение было бы незаметно.
 *
 * `await` намеренный, хотя приёмник не бросает: без него запись гонялась бы с
 * завершением задачи, и последние блоки страницы терялись бы при остановке
 * воркера — то есть чаще всего именно те, на которых он и упал.
 */
async function recordBlockFeedback(
  deps: VlmRecognitionDeps,
  ctx: JobContext<'vlm.recognize_page'>,
  run: VlmRunTarget,
  block: VlmFrozenBlock,
  prompt: { readonly code: string; readonly version: number },
  model: string,
  input: {
    readonly reasonCode: 'vlm.invalid_json' | 'vlm.schema_mismatch' | 'vlm.refusal';
    readonly observed: Record<string, unknown>;
  },
): Promise<void> {
  await deps.feedback.record({
    feedbackType: 'recognition_failure',
    reasonCode: input.reasonCode,
    severity: 'warn',
    revisionId: run.revisionId,
    recognitionRunId: run.runId,
    layoutBlockId: block.id,
    workingPageIndex: ctx.payload.pageIndex,
    pipelineStage: 'recognition',
    provider: 'proxy_llm',
    model,
    promptCode: prompt.code,
    promptVersion: prompt.version,
    observed: input.observed,
  });
}

async function recordSuccessAiRun(
  deps: VlmRecognitionDeps,
  ctx: JobContext<'vlm.recognize_page'>,
  run: VlmRunTarget,
  block: VlmFrozenBlock,
  prompt: { readonly code: string; readonly version: number },
  cropSha256: string,
  response: VlmResponse,
  outcomeKind: string,
): Promise<void> {
  await deps.recordAiRun({
    revisionId: run.revisionId,
    stage: 'recognize',
    provider: response.provider,
    model: response.model,
    promptCode: prompt.code,
    promptVersion: prompt.version,
    inputHash: response.inputHash,
    outputHash: response.outputHash,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    cost: response.cost,
    latencyMs: response.latencyMs,
    structuredResult: {
      recognitionRunId: run.runId,
      layoutBlockId: block.id,
      cropSha256,
      requestedModel: response.requestedModel,
      actualModel: response.model,
      attempt: ctx.attempt,
      outcome: outcomeKind,
    },
    requestId: ctx.payload.request_id ?? null,
  });
}

async function recordFailureAiRun(
  deps: VlmRecognitionDeps,
  ctx: JobContext<'vlm.recognize_page'>,
  run: VlmRunTarget,
  block: VlmFrozenBlock,
  prompt: { readonly code: string; readonly version: number },
  cropSha256: string,
  requestedModel: string,
  error: unknown,
): Promise<void> {
  const attempt = llmAttemptOf(error);
  if (attempt === null) return; // вызов до сети не дошёл — хэшей нет, строка не пишется.
  await deps.recordAiRun({
    revisionId: run.revisionId,
    stage: 'recognize',
    provider: attempt.provider,
    model: attempt.model,
    promptCode: prompt.code,
    promptVersion: prompt.version,
    inputHash: attempt.inputHash,
    outputHash: null,
    tokensIn: null,
    tokensOut: null,
    cost: null,
    latencyMs: attempt.latencyMs,
    structuredResult: {
      recognitionRunId: run.runId,
      layoutBlockId: block.id,
      cropSha256,
      requestedModel,
      actualModel: null,
      attempt: ctx.attempt,
      outcome: 'error',
      errorClass: error instanceof Error ? error.name : 'Error',
    },
    requestId: ctx.payload.request_id ?? null,
  });
}

export function createVlmRecognizePageHandler(
  deps: VlmRecognitionDeps,
): JobHandler<'vlm.recognize_page'> {
  return withVlmRunTermination(deps, async (ctx: JobContext<'vlm.recognize_page'>) => {
    const run = await loadRunningVlmRun(deps, ctx, ctx.payload);
    if (run === null) return;
    const pageIndex = ctx.payload.pageIndex;
    const requestedModel = snapshotModelOf(run);

    const frozen = await deps.loadFrozenBlocks(run.runId);
    const pageBlocks = frozen
      .filter((block) => block.workingPageIndex === pageIndex)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    if (pageBlocks.length === 0) {
      // Страница сидирована ТОЛЬКО если у неё были блоки (vlm.start_recognition);
      // ноль блоков сейчас — расхождение с замороженным набором, а не «нечего делать».
      throw new VlmRecognitionIntegrityError(
        `Страница ${pageIndex} прогона ${run.runId} не содержит блоков разметки, хотя была сидирована`,
      );
    }

    const existing = await deps.existingBlockIds(run.runId);
    const pending = pageBlocks.filter((block) => !existing.has(block.id));
    const alreadyWritten = pageBlocks.length - pending.length;

    if (pending.length === 0) {
      // Checkpoint: все блоки страницы уже записаны прошлой попыткой — VLM не зовём.
      await deps.markRunPage({
        runId: run.runId,
        workingPageIndex: pageIndex,
        status: 'done',
        blocksRecognized: pageBlocks.length,
        blocksInvalid: 0,
        blocksRefused: 0,
      });
      return;
    }

    const rasterizer = requireRasterizer(deps);
    const vlm = requireVlm(deps);

    const pdf = await deps.workingPdfToFile(run.runId);
    try {
      const outPath = join(tmpdir(), `vlm-page-${run.runId}-${pageIndex}-${randomUUID()}.png`);
      let rendered: { readonly widthPx: number; readonly heightPx: number };
      try {
        rendered = await rasterizer.renderPage({
          pdfPath: pdf.path,
          pageIndex,
          dpi: RASTER_DPI,
          outPath,
        });

        const geometry = (await deps.loadPageGeometry(run.runId)).find(
          (page) => page.workingPageIndex === pageIndex,
        );
        if (geometry === undefined) {
          throw new VlmRecognitionIntegrityError(
            `Геометрия страницы ${pageIndex} прогона ${run.runId} не найдена в карте страниц bundle`,
          );
        }

        if (!frameSizesAgree(rendered, geometry)) {
          await deps.markRunPage({
            runId: run.runId,
            workingPageIndex: pageIndex,
            status: 'failed',
            blocksRecognized: alreadyWritten,
            blocksInvalid: 0,
            blocksRefused: 0,
          });
          ctx.logger.warn(
            {
              event: 'page_geometry_mismatch',
              working_page_index: pageIndex,
              rendered_width: rendered.widthPx,
              rendered_height: rendered.heightPx,
              geometry_width: geometry.widthPx,
              geometry_height: geometry.heightPx,
            },
            'геометрия рендера страницы разошлась с сохранённой картой страниц (допуск 2% по аспекту): блоки не распознаются',
          );
          return;
        }

        let recognizedThisAttempt = 0;
        let invalidCount = 0;
        let refusedCount = 0;

        for (const block of pending) {
          const generationProfile = deps.generationProfile(block.blockType);
          const cropResult = await deps.crop({
            pagePngPath: outPath,
            pageWidthPx: rendered.widthPx,
            pageHeightPx: rendered.heightPx,
            coordsNorm: block.coordsNorm,
            polygon: block.shapeType === 'polygon' ? block.polygon : null,
          });

          if ('degenerate' in cropResult) {
            if (block.blockType === 'text') {
              const emptyBlock = textBlockSchema.parse({
                blockId: null,
                layoutBlockId: block.id,
                ordinal: block.sortOrder,
                coordsNorm: [...block.coordsNorm],
                confidence: null,
                modelId: null,
                blockType: 'text',
                text: '',
                fragments: [],
                features: null,
              });
              const envelope = {
                envelope: RECOGNITION_BLOCK_RESULT_ENVELOPE,
                block: emptyBlock,
                page: {
                  workingPageIndex: pageIndex,
                  widthPx: rendered.widthPx,
                  heightPx: rendered.heightPx,
                },
                provenance: {
                  promptCode: null,
                  promptVersion: null,
                  model: requestedModel,
                  actualModel: null,
                  finishReason: null,
                  attempts: 0,
                  cropPolicyVersion: CROP_POLICY_VERSION,
                  cropSha256: null,
                  degenerate: true,
                },
              };
              const { written } = await deps.insertBlockResult({
                recognitionRunId: run.runId,
                layoutRevisionId: run.layoutRevisionId,
                block: {
                  layoutBlockId: block.id,
                  resultType: 'text_json',
                  contentJson: envelope,
                  contentMd: '',
                  contentHtml: null,
                  modelId: null,
                  confidence: null,
                },
              });
              if (written) recognizedThisAttempt += 1;
              ctx.logger.warn(
                {
                  event: 'degenerate_crop',
                  layout_block_id: block.id,
                  block_type: block.blockType,
                },
                'кроп блока вырожден: записан пустой текстовый результат',
              );
            } else {
              invalidCount += 1;
              ctx.logger.warn(
                {
                  event: 'degenerate_crop',
                  layout_block_id: block.id,
                  block_type: block.blockType,
                },
                'кроп блока вырожден: результат invalid (degenerate_crop)',
              );
            }
            continue;
          }

          // Защитного гейта «промпт не опубликован» здесь больше нет: текст
          // разрешается всегда — опубликованной версией либо встроенной.
          const published = await deps.promptByCode(generationProfile.code);
          const prompt: VlmRecognizeBlockPrompt = {
            code: published.code,
            version: published.version,
            systemPrompt: published.systemPrompt,
            userTemplate: published.userTemplate,
            temperature: generationProfile.temperature,
            maxTokens: generationProfile.maxTokens,
            topK: generationProfile.topK,
            responseFormat: generationProfile.responseFormat,
            schemaVersion: generationProfile.schemaVersion,
          };

          const cropSha256 = deps.sha256(cropResult.png);

          let outcome: VlmRecognizeBlockOutcome;
          try {
            outcome = await deps.recognizeBlock({
              vlm,
              prompt,
              model: requestedModel,
              block: {
                layoutBlockId: block.id,
                blockType: block.blockType,
                coordsNorm: block.coordsNorm,
                sortOrder: block.sortOrder,
              },
              cropPng: cropResult.png,
              pageNumber: pageIndex + 1,
              downscale: deps.downscale,
              /**
               * Кроп по запросу модели (ADR-0013, S21).
               *
               * Режется из ТОЙ ЖЕ страницы, что и основной кроп: `outPath` —
               * уже отрендеренный растр, и второй рендер ради дозапроса стоил
               * бы столько же, сколько первый. Полигон не передаётся — модель
               * просит прямоугольник, и маскировать в нём нечего.
               *
               * Вырожденный участок отдаётся как `null`: `recognizeBlock`
               * превратит его во внятный отказ инструмента, а не в исключение,
               * — модель обязана узнать, что кропа не будет.
               */
              requestCrop: async (rect) => {
                const extra = await deps.crop({
                  pagePngPath: outPath,
                  pageWidthPx: rendered.widthPx,
                  pageHeightPx: rendered.heightPx,
                  coordsNorm: rect,
                  polygon: null,
                });
                return 'degenerate' in extra ? null : extra.png;
              },
            });
          } catch (error) {
            await recordFailureAiRun(
              deps,
              ctx,
              run,
              block,
              prompt,
              cropSha256,
              requestedModel,
              error,
            );
            if (isPayloadTooLarge(error)) {
              // Тело не пролезает в шлюз даже после downscale-повтора внутри
              // recognizeBlock: по контракту LlmPayloadTooLargeError это НЕ
              // повод останавливать прогон («остальные блоки могут быть
              // меньше») — блок просто непокрыт, страница может стать failed
              // по совокупности, а не по одному большому блоку.
              invalidCount += 1;
              ctx.logger.warn(
                { event: 'block_payload_too_large', layout_block_id: block.id },
                'тело запроса блока превышает предохранитель шлюза и после уменьшения: блок invalid',
              );
              continue;
            }
            if (!stopsBatch(error) && classifyFailure(error).permanent) {
              /**
               * Неповторимый отказ, который прогон не останавливает, — например
               * транспортный 400 на одном кропе. Повторять его бессмысленно, а
               * бросать наверх нельзя: наверху задача умирает, `markRunPage` не
               * вызывается вовсе, и страница остаётся `pending` НАВСЕГДА — именно
               * из-за этого финализация потом крутила «N страниц из M не
               * терминальны» до исчерпания шестидесяти попыток.
               *
               * Поэтому блок засчитывается непокрытым, а обход идёт дальше: по
               * совокупности страница станет `failed`, и это честный терминальный
               * исход с названной причиной.
               */
              invalidCount += 1;
              ctx.logger.warn(
                {
                  event: 'block_permanent_failure',
                  layout_block_id: block.id,
                  error_class: classifyFailure(error).errorClass,
                  reason: error instanceof Error ? error.message : String(error),
                },
                'блок отказал неповторимо, обход страницы продолжается',
              );
              continue;
            }
            // retriable → движок повторит (checkpoint защитит уже записанное);
            // stopsBatch-ошибка (бюджет/allowlist/провайдер заблокирован,
            // выключенный ИИ) → withVlmRunTermination закроет прогон.
            throw error;
          }

          switch (outcome.kind) {
            case 'ok': {
              const contentMd = outcome.block.blockType === 'text' ? outcome.block.text : null;
              const envelope = {
                envelope: RECOGNITION_BLOCK_RESULT_ENVELOPE,
                block: outcome.block,
                page: {
                  workingPageIndex: pageIndex,
                  widthPx: rendered.widthPx,
                  heightPx: rendered.heightPx,
                },
                provenance: {
                  promptCode: prompt.code,
                  promptVersion: prompt.version,
                  model: requestedModel,
                  actualModel: outcome.response.model,
                  finishReason: outcome.response.finishReason,
                  // Номер ПОПЫТКИ ЗАДАЧИ (ctx.attempt), не число внутренних
                  // вызовов recognizeBlock — corrective/downscale-повтор
                  // непрозрачны наружу по контракту порта.
                  attempts: ctx.attempt,
                  cropPolicyVersion: CROP_POLICY_VERSION,
                  cropSha256,
                },
              };
              const { written } = await deps.insertBlockResult({
                recognitionRunId: run.runId,
                layoutRevisionId: run.layoutRevisionId,
                block: {
                  layoutBlockId: block.id,
                  resultType: `${block.blockType}_json`,
                  contentJson: envelope,
                  contentMd,
                  contentHtml: null,
                  modelId: outcome.response.model,
                  confidence: null,
                },
              });
              if (written) recognizedThisAttempt += 1;
              await recordSuccessAiRun(
                deps,
                ctx,
                run,
                block,
                prompt,
                cropSha256,
                outcome.response,
                'ok',
              );
              break;
            }
            case 'invalid_response': {
              invalidCount += 1;
              ctx.logger.warn(
                {
                  event: 'block_invalid_response',
                  layout_block_id: block.id,
                  reason: outcome.reason,
                },
                'ответ модели непригоден: блок invalid',
              );
              // Причина различается по её же коду: «не разобрался как JSON» и
              // «разобрался, но не по схеме» правятся разными местами промта, и
              // сводить их в одну строку значит потерять именно то различие,
              // ради которого запись ведётся.
              await recordBlockFeedback(deps, ctx, run, block, prompt, requestedModel, {
                reasonCode: outcome.reason.includes('schema')
                  ? 'vlm.schema_mismatch'
                  : 'vlm.invalid_json',
                observed: { reason_code: outcome.reason, block_type: block.blockType },
              });
              if (outcome.response !== undefined) {
                await recordSuccessAiRun(
                  deps,
                  ctx,
                  run,
                  block,
                  prompt,
                  cropSha256,
                  outcome.response,
                  'invalid_response',
                );
              }
              break;
            }
            case 'model_refusal': {
              refusedCount += 1;
              ctx.logger.warn(
                { event: 'block_model_refusal', layout_block_id: block.id, reason: outcome.reason },
                'модель не дала результата: блок refused',
              );
              await recordBlockFeedback(deps, ctx, run, block, prompt, requestedModel, {
                reasonCode: 'vlm.refusal',
                observed: {
                  reason_code: outcome.reason,
                  block_type: block.blockType,
                  finish_reason: outcome.response?.finishReason ?? null,
                },
              });
              if (outcome.response !== undefined) {
                await recordSuccessAiRun(
                  deps,
                  ctx,
                  run,
                  block,
                  prompt,
                  cropSha256,
                  outcome.response,
                  'model_refusal',
                );
              }
              break;
            }
          }
        }

        await deps.markRunPage({
          runId: run.runId,
          workingPageIndex: pageIndex,
          status: invalidCount + refusedCount === 0 ? 'done' : 'failed',
          blocksRecognized: alreadyWritten + recognizedThisAttempt,
          blocksInvalid: invalidCount,
          blocksRefused: refusedCount,
        });
      } finally {
        await unlink(outPath).catch(() => {});
      }
    } finally {
      await pdf.cleanup();
    }
  });
}

// =====================================================================
// vlm.finalize_run
// =====================================================================

function aggregateRunPageCounts(pages: readonly VlmRunPageState[]): {
  readonly blocksRecognized: number;
  readonly blocksInvalid: number;
  readonly blocksRefused: number;
  readonly pagesTotal: number;
  readonly pagesFailed: number;
} {
  let blocksRecognized = 0;
  let blocksInvalid = 0;
  let blocksRefused = 0;
  let pagesFailed = 0;
  for (const page of pages) {
    blocksRecognized += page.blocksRecognized;
    blocksInvalid += page.blocksInvalid;
    blocksRefused += page.blocksRefused;
    if (page.status === 'failed') pagesFailed += 1;
  }
  return { blocksRecognized, blocksInvalid, blocksRefused, pagesTotal: pages.length, pagesFailed };
}

/**
 * Запись canonical-артефакта тремя рубежами — тот же приём, что `storeDerived`
 * в `recognition.ts`: findArtifact (уже записан?) → readArtifactBytes (объект
 * есть, строки нет?) → запись байт + recordArtifact. Хэш сверяется на каждом
 * рубеже; расхождение — `VlmRecognitionIntegrityError`.
 */
async function storeCanonicalArtifact(
  deps: VlmRecognitionDeps,
  runId: string,
  bytes: Uint8Array,
  sha256: string,
): Promise<string> {
  const recorded = await deps.findArtifact(runId, 'canonical');
  if (recorded !== null) {
    if (recorded.artifactSha256 !== sha256) {
      throw new VlmRecognitionIntegrityError(
        'Артефакт canonical этого прогона уже записан с другим хэшем: пересборка дала другие байты',
      );
    }
    return deps.artifactId(runId, 'canonical');
  }

  const staged = await deps.readArtifactBytes(runId, 'canonical');
  if (staged !== null) {
    const stagedSha256 = deps.sha256(staged);
    const outcome = await deps.recordArtifact({
      runId,
      kind: 'canonical',
      artifactSha256: stagedSha256,
      byteSize: staged.byteLength,
    });
    if (outcome.artifactSha256 !== sha256) {
      throw new VlmRecognitionIntegrityError(
        'Байты canonical-артефакта в хранилище не совпадают с только что собранными',
      );
    }
    return deps.artifactId(runId, 'canonical');
  }

  await deps.writeArtifactBytes({
    runId,
    kind: 'canonical',
    bytes,
    contentType: 'application/json; charset=utf-8',
  });
  const outcome = await deps.recordArtifact({
    runId,
    kind: 'canonical',
    artifactSha256: sha256,
    byteSize: bytes.byteLength,
  });
  if (outcome.artifactSha256 !== sha256) {
    throw new VlmRecognitionIntegrityError(
      'Артефакт canonical записан параллельной попыткой с другим хэшем',
    );
  }
  return deps.artifactId(runId, 'canonical');
}

export function createVlmFinalizeHandler(deps: VlmRecognitionDeps): JobHandler<'vlm.finalize_run'> {
  return withVlmRunTermination(deps, async (ctx: JobContext<'vlm.finalize_run'>) => {
    const run = await loadRunningVlmRun(deps, ctx, ctx.payload);
    if (run === null) return;
    const pages = await deps.listRunPages(run.runId);

    const pending = pages.filter((page) => page.status === 'pending');
    if (pending.length > 0) {
      throw new VlmRecognitionPendingError(
        `Распознавание ещё идёт: ${pending.length} страниц из ${pages.length} не терминальны`,
      );
    }

    const counts = aggregateRunPageCounts(pages);
    const frozenAll = await deps.loadFrozenBlocks(run.runId);
    const envelopes = await deps.listBlockEnvelopes(run.runId);
    const incomplete = counts.pagesFailed > 0 || envelopes.length < frozenAll.length;

    /**
     * Неполное покрытие: отказ или частичный результат.
     *
     * В строгом режиме «распознали не всё» — это провал прогона: неполный набор
     * блоков нельзя выдавать за результат, по которому потом принимают решение.
     * В режиме тестирования запрет мешает ровно тому, ради чего режим и заведён:
     * восемьдесят распознанных страниц полезнее нуля, а какая именно страница
     * отвалилась — видно поимённо.
     *
     * Публикуется при этом СОГЛАСОВАННОЕ подмножество: `assemble` требует точной
     * биекции «замороженный блок ↔ результат», поэтому в сборку уходят только те
     * блоки, у которых результат есть. Иначе сверка развалилась бы на первом же
     * непокрытом блоке, и «частичный результат» превратился бы в отказ с другой
     * формулировкой.
     */
    const covered = new Set(envelopes.map((envelope) => envelope.layoutBlockId));
    const frozen = incomplete ? frozenAll.filter((block) => covered.has(block.id)) : frozenAll;

    if (incomplete && !(await deps.enforceGates())) {
      ctx.logger.warn(
        {
          event: 'vlm_recognition_partial_publish',
          pages_failed: counts.pagesFailed,
          pages_total: counts.pagesTotal,
          blocks_expected: frozenAll.length,
          blocks_covered: envelopes.length,
        },
        'покрытие неполно, но режим тестирования публикует распознанное',
      );
    } else if (incomplete) {
      await deps.finishRun({
        runId: run.runId,
        status: 'failed',
        reason:
          counts.pagesFailed > 0
            ? `${counts.pagesFailed} страниц завершились с ошибкой из ${counts.pagesTotal}`
            : `покрыто ${envelopes.length} блоков из ${frozenAll.length}: нулевой/неполный результат не считается успехом`,
        counts: {
          ...counts,
          blocksExpected: frozenAll.length,
          blocksCovered: envelopes.length,
        },
        warnings: [
          ...(counts.pagesFailed > 0 ? [{ code: 'pages_failed', pages: counts.pagesFailed }] : []),
          ...(envelopes.length < frozenAll.length
            ? [
                {
                  code: 'coverage_incomplete',
                  expected: frozenAll.length,
                  covered: envelopes.length,
                },
              ]
            : []),
        ],
      });
      throw new VlmRecognitionCoverageError(
        `Покрытие неполно: ${envelopes.length} блоков из ${frozenAll.length}, страниц с ошибкой: ${counts.pagesFailed}`,
      );
    }

    // --- Конверты → канонические блоки, валидация схемой ---
    const results = new Map<string, RecognitionBlock>();
    for (const envelope of envelopes) {
      const block = parseBlockEnvelope(envelope.contentJson);
      if (block === null) {
        throw new VlmRecognitionIntegrityError(
          `Конверт результата блока ${envelope.layoutBlockId} не проходит канонический контракт`,
        );
      }
      results.set(envelope.layoutBlockId, block);
    }

    const pageGeometry = await deps.loadPageGeometry(run.runId);
    const pagesWithBlocks = new Set(frozen.map((block) => block.workingPageIndex));

    let assembled: RecognitionResult;
    try {
      assembled = deps.assemble({
        modelId: (() => {
          const model = snapshotOf(run)['model'];
          return typeof model === 'string' ? model : null;
        })(),
        pages: pageGeometry.filter((page) => pagesWithBlocks.has(page.workingPageIndex)),
        frozenBlocks: frozen.map((block) => ({
          layoutBlockId: block.id,
          workingPageIndex: block.workingPageIndex,
          blockType: block.blockType,
          coordsNorm: block.coordsNorm,
          sortOrder: block.sortOrder,
        })),
        results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        reason: `сборка результата провалила двустороннюю сверку: ${message}`.slice(
          0,
          MAX_REASON_LENGTH,
        ),
      });
      throw new VlmRecognitionIntegrityError(`assemble: ${message}`);
    }

    const bytes = new TextEncoder().encode(JSON.stringify(assembled));
    const sha256 = deps.sha256(bytes);
    const artifactVersionId = await storeCanonicalArtifact(deps, run.runId, bytes, sha256);

    if (dryRunOf(run)) {
      // Shadow-режим (ADR-0007): canonical-артефакт записан для сравнения,
      // публикация (page_text_versions/current_block_result) пропускается —
      // downstream-конвейер не видит этот прогон вовсе.
      await deps.finishRun({
        runId: run.runId,
        status: 'done',
        counts: {
          ...counts,
          blocksExpected: frozen.length,
          blocksCovered: envelopes.length,
          dryRun: true,
        },
      });
      ctx.logger.info(
        {
          event: 'vlm_recognition_dry_run_done',
          recognition_run_id: run.runId,
          artifact_sha256: sha256,
        },
        'прогон VLM завершён в dry-run: canonical записан, публикация пропущена',
      );
      return;
    }

    const pagesToPublish = assembled.pages.map((page) => ({
      workingPageIndex: page.workingPageIndex,
      textMd: renderPageText(page),
      renderVersion: PAGE_TEXT_RENDER_VERSION,
    }));
    const published = await deps.publishResults({
      recognitionRunId: run.runId,
      artifactVersionId,
      pages: pagesToPublish,
    });

    const finalCounts = {
      ...counts,
      blocksExpected: frozen.length,
      blocksCovered: envelopes.length,
      pagesWritten: published.pagesWritten,
      pagesAlreadyPresent: published.pagesAlreadyPresent,
    };

    await deps.finishRun({ runId: run.runId, status: 'done', counts: finalCounts });

    ctx.logger.info(
      { event: 'recognition_export_stored', artifact_sha256: sha256, ...finalCounts },
      'результат VLM-распознавания собран, провалидирован и опубликован',
    );
    await ctx.emit('recognition.export_stored', { recognitionRunId: run.runId, ...finalCounts });

    await continueWithAnalysis(ctx);
  });
}

/**
 * Переход «распознавание → анализ» при сквозном прогоне (S21).
 *
 * До S21 здесь стояло только `ctx.emit`, и это было тихой ловушкой: событие
 * доставляется ЭКРАНУ, задачу оно не ставит. Цепочка обрывалась, а выглядело
 * так, будто «сообщили дальше по конвейеру» — экран показывал «распознано», и
 * дальше не происходило ничего, пока человек не нажимал «Собрать документы».
 *
 * Ставится ПОСЛЕ публикации и только после неё: `doc.classify_pages` читает
 * `page_text_versions`, и запуск до транзакции публикации дал бы отказ
 * «завершённого прогона распознавания нет» на прогоне, который вот-вот
 * завершится. Dry-run (`ai.dry_run_only`) сюда не доходит вовсе — он выходит
 * раньше, ничего не опубликовав, и анализировать ему нечего.
 */
async function continueWithAnalysis(ctx: JobContext<'vlm.finalize_run'>): Promise<void> {
  if (ctx.payload.autoContinue !== true) return;
  await ctx.enqueue({
    type: 'doc.classify_pages',
    payload: { revisionId: ctx.payload.revisionId, autoContinue: true },
    dedupeKey: `doc.classify_pages:${ctx.payload.revisionId}`,
  });
}
