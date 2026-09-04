/**
 * Цепочка снимка исполнительной документации в RD WEB (контракт document-sync v1).
 *
 * Восемь задач, написанных на портах (`ExecSyncDeps`); связывание с базой,
 * хранилищем и адаптером живёт в `pipeline.ts`. Разделение то же, что у
 * остальных стадий, и по той же причине.
 *
 * ## Четыре рубежа, которые здесь НЕ имеют права деградировать
 *
 * 1. **Снимок собирается по замороженному набору.** `rd.sync_prepare`
 *    независимо перепроверяет `computeBlocksHash` против `local_layout_hash`
 *    прогона: гейт обязан держаться на самой задаче, а не на том, что
 *    предыдущая была аккуратна.
 * 2. **Результат сверяется с объявленным.** `GET /documents/{id}/blocks` отдаёт
 *    ПОСЛЕДНИЕ результаты документа, а не результаты нашей отправки — ради
 *    этого различия в ответе и существует `external_block_revision`. Чужая
 *    ревизия останавливает прогон `integrity_error`.
 * 3. **Вытесненная отправка не публикуется.** `superseded` закрывает прогон без
 *    публикации: §16 п. 10 запрещает публиковать результат отправки, которую
 *    обогнала следующая.
 * 4. **409 не повторяется.** Конфликт §9 лечится пересборкой снимка, а не
 *    повтором того же запроса (§17 п. 6), и круги пересборки имеют потолок.
 *
 * ## Исчерпание попыток ЛЮБОЙ задачи завершает прогон
 *
 * `JobRunner` при исчерпании попыток помечает задачу `dead` и о прогонах ничего
 * не знает. Значит закрыть прогон обязан этот модуль, и правило ОБЩЕЕ
 * (`withExecRunTermination`), а не перечисление классов ошибок: перечисление уже
 * один раз подвело на легаси-пути, оставив прогоны в `running` навсегда.
 */
import {
  ADAPTER_VERSION_RDWEB_EXEC,
  blockGeometryKey,
  buildSnapshotBody,
  classifyFailure,
  computeBlocksHash,
  ExecSyncError,
  JobDeferredError,
  mapExecBlockResult,
  SnapshotBuildError,
  SUCCESSFUL_SYNC_STATES,
  TERMINAL_SYNC_STATES,
  type ExecBlockResultRow,
  type ExecSyncPort,
  type HashableBlock,
  type JobContext,
  type JobHandler,
  type ProcessingFeedbackSink,
  type SnapshotBlockInput,
} from '@id/api';
import { manifestSha256 } from '@id/execsync';
import type { BlockType, RecognitionWarning, ShapeType } from '@id/contracts';
import type { RecognitionBlock } from '@id/recognition';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/** Сколько раз задача-поллер спрашивает состояние внутри одной попытки. */
const DEFAULT_POLLS_PER_ATTEMPT = 5;
/** Контракт рекомендует 5–15 секунд (§15). */
const DEFAULT_POLL_INTERVAL_MS = 10_000;
/** Потолок кругов пересборки снимка после 409. */
const MAX_RESYNC_ROUNDS = 2;

// =====================================================================
// Порты
// =====================================================================

export interface ExecRunTarget {
  readonly runId: string;
  readonly folderId: string;
  readonly layoutRevisionId: string;
  readonly bundleId: string;
  readonly status: string;
  readonly localLayoutHash: string;
  readonly workingPdfSha256: string;
  readonly settingsSnapshot: Record<string, unknown>;
  readonly recoveryRound: number;
}

export interface ExecLayoutBlock extends HashableBlock {
  readonly id: string;
  readonly blockType: BlockType;
  readonly shapeType: ShapeType;
  readonly displayName: string | null;
  readonly contentRotation: number;
}

export interface ExecDocumentFacts {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
  readonly projectName: string;
  readonly documentName: string;
}

export interface ExecPageGeometry {
  readonly workingPageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
}

export interface ExecBlockDeclaration {
  readonly layoutBlockId: string;
  readonly externalBlockId: string;
  readonly revision: number;
  readonly matchedBy: 'layout_block' | 'geometry' | 'new';
}

export interface ExecSnapshotPlanView {
  readonly externalProjectId: string;
  readonly externalDocumentId: string;
  readonly documentRevision: string;
  readonly syncGeneration: number;
  readonly baseGeneration: number;
  readonly declarations: readonly ExecBlockDeclaration[];
  readonly reused: boolean;
}

export interface ExecSyncRowView {
  readonly id: string;
  readonly folderId: string;
  readonly recognitionRunId: string | null;
  readonly externalSyncId: string;
  readonly externalDocumentId: string;
  readonly syncGeneration: number;
  readonly baseGeneration: number;
  readonly manifestSha256: string;
  readonly documentSha256: string;
  readonly documentRevision: string;
  readonly blocksCount: number;
  readonly remoteSyncId: string | null;
  readonly uploadRequired: boolean | null;
  readonly uploadAttempts: number;
  readonly state: string;
  readonly remoteState: string | null;
}

export interface ExecDeclaredBlock {
  readonly externalBlockId: string;
  readonly revision: number;
  readonly layoutBlockId: string | null;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
}

export interface ExecSyncDeps {
  /** Адаптер контракта; `null` — интеграция не настроена. */
  readonly port: ExecSyncPort | null;
  /** Проект развёртывания (`RDWEB_EXEC_PROJECT_ID`). */
  readonly projectId: string | null;
  readonly feedback: ProcessingFeedbackSink;

  loadRun(runId: string): Promise<ExecRunTarget | null>;
  loadLayoutBlocks(target: ExecRunTarget): Promise<readonly ExecLayoutBlock[]>;
  loadDocumentFacts(target: ExecRunTarget): Promise<ExecDocumentFacts>;
  loadPageGeometry(target: ExecRunTarget): Promise<readonly ExecPageGeometry[]>;
  openWorkingPdf(sha256: string): Promise<{ body: () => Readable; sizeBytes: number }>;

  reconcileSnapshot(input: {
    readonly folderId: string;
    readonly recognitionRunId: string;
    readonly externalProjectId: string;
    readonly documentSha256: string;
    readonly blocks: readonly {
      readonly layoutBlockId: string;
      readonly workingPageIndex: number;
      readonly blockType: BlockType;
      readonly geometryKey: string;
      readonly declaredHash: string;
    }[];
  }): Promise<ExecSnapshotPlanView>;
  openSync(input: {
    readonly folderId: string;
    readonly recognitionRunId: string;
    readonly externalSyncId: string;
    readonly syncGeneration: number;
    readonly baseGeneration: number;
    readonly manifestSha256: string;
    readonly documentSha256: string;
    readonly documentRevision: string;
    readonly blocksCount: number;
  }): Promise<ExecSyncRowView>;
  findSyncForRun(runId: string): Promise<ExecSyncRowView | null>;
  recordSyncInitialized(
    syncId: string,
    input: {
      readonly remoteSyncId: string;
      readonly duplicate: boolean;
      readonly uploadRequired: boolean;
      readonly remoteState: string;
    },
  ): Promise<void>;
  recordSyncState(
    syncId: string,
    state: 'preparing' | 'initialized' | 'uploaded' | 'completed' | 'terminal' | 'conflict',
    patch?: {
      readonly remoteState?: string | undefined;
      readonly allTerminal?: boolean | undefined;
      readonly allSuccessful?: boolean | undefined;
      readonly counters?: Record<string, number> | undefined;
      readonly errorCode?: string | null | undefined;
      readonly errorMessage?: string | null | undefined;
    },
  ): Promise<void>;
  countUploadAttempt(syncId: string): Promise<number>;
  acceptGeneration(folderId: string, generation: number): Promise<void>;
  markResyncRequired(folderId: string): Promise<void>;
  liftGeneration(folderId: string, atLeast: number): Promise<number>;
  liftBlockRevisions(
    folderId: string,
    remote: readonly { readonly externalBlockId: string; readonly revision: number }[],
  ): Promise<void>;
  listDeclaredBlocks(folderId: string): Promise<readonly ExecDeclaredBlock[]>;

  seedRunPages(
    runId: string,
    pages: readonly { readonly workingPageIndex: number; readonly blocksTotal: number }[],
  ): Promise<void>;
  markRunPage(input: {
    readonly runId: string;
    readonly workingPageIndex: number;
    readonly status: 'done' | 'failed';
    readonly blocksRecognized: number;
    readonly blocksInvalid: number;
    readonly blocksRefused: number;
  }): Promise<void>;
  saveBlockResult(input: {
    readonly runId: string;
    readonly layoutRevisionId: string;
    readonly layoutBlockId: string;
    readonly resultType: string;
    readonly contentMd: string | null;
    readonly contentJson: unknown;
  }): Promise<void>;
  listSavedBlockIds(runId: string): Promise<ReadonlySet<string>>;

  mergeSnapshot(runId: string, patch: Record<string, unknown>): Promise<void>;
  finishRun(input: {
    readonly runId: string;
    readonly status: 'done' | 'failed' | 'integrity_error';
    readonly counts?: Record<string, unknown> | undefined;
    readonly warnings?: readonly RecognitionWarning[] | undefined;
  }): Promise<void>;

  /*
   * Публикация. Три функции ниже — те же, что у ветки VLM, и это не совпадение:
   * `assembleRecognitionResult`, канонический артефакт и `publishRunResults`
   * провайдер-нейтральны по построению. Различается только то, ЧТО кладётся в
   * `source`, — и именно поэтому сборка требует его явно.
   */
  listBlockEnvelopes(
    runId: string,
  ): Promise<readonly { layoutBlockId: string; contentJson: unknown }[]>;
  assemble(input: {
    readonly source: { readonly provider: 'rdweb_exec'; readonly adapterVersion: string };
    readonly modelId: null;
    readonly pages: readonly ExecPageGeometry[];
    readonly frozenBlocks: readonly {
      readonly layoutBlockId: string;
      readonly workingPageIndex: number;
      readonly blockType: BlockType;
      readonly coordsNorm: readonly [number, number, number, number];
      readonly sortOrder: number;
    }[];
    readonly results: ReadonlyMap<string, RecognitionBlock>;
  }): unknown;
  storeCanonicalArtifact(runId: string, bytes: Uint8Array): Promise<string>;
  publishResults(input: {
    readonly recognitionRunId: string;
    readonly artifactVersionId: string;
    readonly pages: readonly {
      readonly workingPageIndex: number;
      readonly textMd: string;
      readonly renderVersion: string;
    }[];
  }): Promise<{ readonly pagesWritten: number; readonly pagesAlreadyPresent: number }>;
  /** Переход «распознавание → анализ» при сквозном прогоне (S21). */
  continueWithAnalysis(ctx: JobContext<'rd.sync_finalize'>, target: ExecRunTarget): Promise<void>;
  renderPageText(page: unknown): string;
  readonly pageTextRenderVersion: string;
}

// =====================================================================
// Ошибки ветки
// =====================================================================

export class ExecConfigurationError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ExecConfigurationError';
  }
}

export class ExecStateError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ExecStateError';
  }
}

export class ExecIntegrityError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ExecIntegrityError';
  }
}

/** Отправка вытеснена более новой генерацией. Не сбой, а устаревание. */
export class ExecSupersededError extends Error {
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ExecSupersededError';
  }
}

// =====================================================================
// Общая обвязка
// =====================================================================

function requirePort(deps: ExecSyncDeps): ExecSyncPort {
  if (deps.port === null) {
    throw new ExecConfigurationError(
      'Интеграция RD WEB не настроена: задайте RDWEB_EXEC_BASE_URL, RDWEB_EXEC_TOKEN и ' +
        'RDWEB_EXEC_PROJECT_ID либо переключите распознавание на VLM.',
    );
  }
  return deps.port;
}

function requireProject(deps: ExecSyncDeps): string {
  if (deps.projectId === null) {
    throw new ExecConfigurationError('RDWEB_EXEC_PROJECT_ID не задан.');
  }
  return deps.projectId;
}

async function requireRun(deps: ExecSyncDeps, runId: string): Promise<ExecRunTarget> {
  const run = await deps.loadRun(runId);
  if (run === null) throw new ExecStateError('Прогон распознавания не найден.');
  if (run.status !== 'running') {
    throw new ExecStateError(`Прогон уже завершён со статусом «${run.status}».`);
  }
  return run;
}

async function requireSync(deps: ExecSyncDeps, runId: string): Promise<ExecSyncRowView> {
  const sync = await deps.findSyncForRun(runId);
  if (sync === null)
    throw new ExecStateError('Отправка прогона не заведена: rd.sync_prepare не выполнялась.');
  return sync;
}

/**
 * Прогон закрывается ТОЛЬКО когда повтора больше не будет.
 *
 * Отсрочка (`JobDeferredError`) прогон не закрывает: она означает «ещё идёт», а
 * не «не вышло». Конфликт §9 тоже не закрывает — его лечит `rd.sync_resync`.
 */
async function withExecRunTermination<K extends ExecJobType>(
  deps: ExecSyncDeps,
  ctx: JobContext<K>,
  runId: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof JobDeferredError) throw error;
    if (error instanceof ExecSyncError && error.conflict !== null) throw error;

    const { permanent } = classifyFailure(error);
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;
    if (permanent || lastAttempt) {
      const status = error instanceof ExecIntegrityError ? 'integrity_error' : 'failed';
      await deps.finishRun({
        runId,
        status,
        counts: { terminatedBy: ctx.type },
        warnings: [
          {
            code: error instanceof ExecSupersededError ? 'superseded' : 'exec_sync_failed',
            message: messageOf(error),
            workingPageIndex: null,
          },
        ],
      });
    }
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
}

type ExecJobType =
  | 'rd.sync_prepare'
  | 'rd.sync_init'
  | 'rd.sync_upload'
  | 'rd.sync_complete'
  | 'rd.sync_poll'
  | 'rd.sync_fetch'
  | 'rd.sync_finalize'
  | 'rd.sync_resync';

/**
 * Конфликт §9 уводит на пересборку снимка, а не на повтор запроса.
 *
 * Круги считаются в `recovery_round` прогона — колонка уже есть и означает ровно
 * это: «сколько раз мы пробовали ещё раз». Заводить вторую было бы удвоением
 * одного понятия.
 */
async function routeConflict<K extends ExecJobType>(
  deps: ExecSyncDeps,
  ctx: JobContext<K>,
  target: ExecRunTarget,
  error: ExecSyncError,
): Promise<never> {
  await deps.markResyncRequired(target.folderId);
  const sync = await deps.findSyncForRun(target.runId);
  if (sync !== null) {
    await deps.recordSyncState(sync.id, 'conflict', {
      errorCode: error.code,
      errorMessage: messageOf(error),
    });
  }

  if (target.recoveryRound >= MAX_RESYNC_ROUNDS) {
    await deps.finishRun({
      runId: target.runId,
      status: 'failed',
      warnings: [
        {
          code: 'exec_sync_conflict',
          message:
            `Снимок трижды разошёлся с RD WEB (${error.code ?? 'конфликт'}). ` +
            'Действующую генерацию документа контракт по запросу не отдаёт — ' +
            'обратитесь к эксплуатации RD WEB.',
          workingPageIndex: null,
        },
      ],
    });
    throw new ExecStateError(`Пересборка снимка исчерпала круги: ${messageOf(error)}`);
  }

  await ctx.enqueue({
    type: 'rd.sync_resync',
    payload: { folderId: target.folderId, recognitionRunId: target.runId },
    dedupeKey: `rd.sync_resync:${target.runId}:${String(target.recoveryRound + 1)}`,
  });
  throw error;
}

// =====================================================================
// 1. Подготовка снимка
// =====================================================================

/** Отпечаток всей объявленной проекции блока — вход решения «поднимать ли revision». */
function hashOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Каноническая проекция блока для `declared_sha256`. */
function declaredHashInput(block: ExecLayoutBlock, geometryKey: string): string {
  const points = block.points.map((point) => `${String(point.x)},${String(point.y)}`).join(';');
  return [
    geometryKey,
    String(block.sortOrder),
    block.displayName ?? '',
    String(block.contentRotation),
    points,
  ].join('|');
}

export function createSyncPrepareHandler(deps: ExecSyncDeps): JobHandler<'rd.sync_prepare'> {
  return async (ctx: JobContext<'rd.sync_prepare'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      requirePort(deps);
      const projectId = requireProject(deps);

      const blocks = await deps.loadLayoutBlocks(target);
      if (blocks.length === 0) {
        throw new ExecStateError('В разметке нет ни одного блока: распознавать нечего.');
      }

      /*
       * Гейт целостности: снимок обязан описывать ТОТ набор блоков, который
       * прогон запинил на старте. Разметку правят всегда, и без этой сверки
       * отправка описывала бы одно, а `local_layout_hash` доказывал другое.
       */
      const actual = computeBlocksHash(blocks);
      if (actual !== target.localLayoutHash) {
        throw new ExecIntegrityError(
          'Набор блоков изменился после старта прогона: снимок не соответствует заказу.',
        );
      }

      const facts = await deps.loadDocumentFacts(target);

      const geometryKeys = new Map<string, string>();
      for (const block of blocks) geometryKeys.set(block.id, blockGeometryKey(block));

      const plan = await deps.reconcileSnapshot({
        folderId: target.folderId,
        recognitionRunId: target.runId,
        externalProjectId: projectId,
        documentSha256: facts.sha256,
        blocks: blocks.map((block) => {
          const geometryKey = geometryKeys.get(block.id) ?? '';
          return {
            layoutBlockId: block.id,
            workingPageIndex: block.workingPageIndex,
            blockType: block.blockType,
            geometryKey,
            declaredHash: hashOf(declaredHashInput(block, geometryKey)),
          };
        }),
      });

      const byLayoutBlock = new Map(plan.declarations.map((d) => [d.layoutBlockId, d]));
      const snapshotBlocks: SnapshotBlockInput[] = blocks.map((block) => {
        const declaration = byLayoutBlock.get(block.id);
        return {
          externalBlockId: declaration?.externalBlockId ?? block.id,
          revision: declaration?.revision ?? 1,
          workingPageIndex: block.workingPageIndex,
          blockType: block.blockType,
          shapeType: block.shapeType,
          x0: block.x0,
          y0: block.y0,
          x1: block.x1,
          y1: block.y1,
          points: block.points,
          sortOrder: block.sortOrder,
          displayName: block.displayName,
          contentRotation: block.contentRotation,
          forceReprocess: false,
        };
      });

      const externalSyncId = `sync-${target.folderId}-g${String(plan.syncGeneration)}-r${String(target.recoveryRound)}`;
      const built = buildSnapshotBody({
        externalSyncId,
        externalProjectId: plan.externalProjectId,
        projectName: facts.projectName,
        externalDocumentId: plan.externalDocumentId,
        documentName: facts.documentName,
        documentRevision: plan.documentRevision,
        baseGeneration: plan.baseGeneration,
        syncGeneration: plan.syncGeneration,
        document: {
          fileName: `${facts.sha256.slice(0, 16)}.pdf`,
          sizeBytes: facts.sizeBytes,
          sha256: facts.sha256,
          pageCount: facts.pageCount,
        },
        blocks: snapshotBlocks,
      });

      await deps.openSync({
        folderId: target.folderId,
        recognitionRunId: target.runId,
        externalSyncId,
        syncGeneration: plan.syncGeneration,
        baseGeneration: plan.baseGeneration,
        manifestSha256: manifestSha256(built.body),
        documentSha256: facts.sha256,
        documentRevision: plan.documentRevision,
        blocksCount: built.body.blocks.length,
      });

      // Страницы прогона: покрытие считается по ним, и сидировать их обязана
      // головная задача — `markRunPage` строк не создаёт намеренно.
      const perPage = new Map<number, number>();
      for (const block of built.body.blocks) {
        perPage.set(block.page_index, (perPage.get(block.page_index) ?? 0) + 1);
      }
      await deps.seedRunPages(
        target.runId,
        [...perPage.entries()].map(([workingPageIndex, blocksTotal]) => ({
          workingPageIndex,
          blocksTotal,
        })),
      );

      await deps.mergeSnapshot(target.runId, {
        externalDocumentId: plan.externalDocumentId,
        documentRevision: plan.documentRevision,
        syncGeneration: plan.syncGeneration,
        blocksDeclared: built.body.blocks.length,
        blocksReusedIdentity: plan.declarations.filter((d) => d.matchedBy !== 'new').length,
        adapterVersion: ADAPTER_VERSION_RDWEB_EXEC,
      });

      if (built.warnings.length > 0 || built.skipped.length > 0) {
        ctx.logger.warn(
          {
            event: 'exec_snapshot_warnings',
            recognition_run_id: target.runId,
            skipped: built.skipped.length,
            codes: built.warnings.map((warning) => warning.code),
          },
          'снимок собран с оговорками',
        );
      }

      await ctx.emit('recognition.sync_prepared', {
        recognitionRunId: target.runId,
        blocks: built.body.blocks.length,
        generation: plan.syncGeneration,
      });

      await ctx.enqueue({
        type: 'rd.sync_init',
        payload: { folderId: target.folderId, recognitionRunId: target.runId },
        dedupeKey: `rd.sync_init:${externalSyncId}`,
      });
    });
  };
}

// =====================================================================
// 2. Инициализация
// =====================================================================

export function createSyncInitHandler(deps: ExecSyncDeps): JobHandler<'rd.sync_init'> {
  return async (ctx: JobContext<'rd.sync_init'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      const port = requirePort(deps);
      const sync = await requireSync(deps, target.runId);
      const { body, manifest } = await rebuildSnapshot(deps, target, sync);

      /*
       * Сборка обязана быть детерминированной.
       *
       * Тело не хранится (32 МиБ jsonb на каждую отправку), поэтому сторожем
       * служит записанный хеш: если пересборка дала другой манифест, отправлять
       * его под тем же `external_sync_id` нельзя — контракт ответит
       * `409 sync_identity_conflict`, и разбираться будут с чужим симптомом.
       */
      if (manifest !== sync.manifestSha256) {
        throw new ExecIntegrityError(
          'Пересборка снимка дала другой manifest_sha256: сборка недетерминирована.',
        );
      }

      let result;
      try {
        result = await port.initSync(body, manifest);
      } catch (error) {
        if (error instanceof ExecSyncError && error.conflict !== null) {
          await routeConflict(deps, ctx, target, error);
        }
        throw error;
      }

      await deps.recordSyncInitialized(sync.id, {
        remoteSyncId: result.syncId,
        duplicate: result.duplicate,
        uploadRequired: result.uploadRequired,
        remoteState: result.state,
      });
      await deps.acceptGeneration(target.folderId, sync.syncGeneration);

      const next = result.uploadRequired ? 'rd.sync_upload' : 'rd.sync_complete';
      await ctx.enqueue({
        type: next,
        payload: { folderId: target.folderId, recognitionRunId: target.runId },
        dedupeKey: `${next}:${sync.externalSyncId}`,
      });
    });
  };
}

/** Пересборка тела снимка из реестра: без неё нечего слать и нечем сверять. */
async function rebuildSnapshot(
  deps: ExecSyncDeps,
  target: ExecRunTarget,
  sync: ExecSyncRowView,
): Promise<{ body: ReturnType<typeof buildSnapshotBody>['body']; manifest: string }> {
  const blocks = await deps.loadLayoutBlocks(target);
  const facts = await deps.loadDocumentFacts(target);
  const declared = await deps.listDeclaredBlocks(target.folderId);
  const byLayoutBlock = new Map(
    declared
      .filter((row) => row.layoutBlockId !== null)
      .map((row) => [row.layoutBlockId as string, row]),
  );

  const built = buildSnapshotBody({
    externalSyncId: sync.externalSyncId,
    externalProjectId: requireProject(deps),
    projectName: facts.projectName,
    externalDocumentId: sync.externalDocumentId,
    documentName: facts.documentName,
    documentRevision: sync.documentRevision,
    baseGeneration: sync.baseGeneration,
    syncGeneration: sync.syncGeneration,
    document: {
      fileName: `${facts.sha256.slice(0, 16)}.pdf`,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      pageCount: facts.pageCount,
    },
    blocks: blocks.map((block) => {
      const row = byLayoutBlock.get(block.id);
      return {
        externalBlockId: row?.externalBlockId ?? block.id,
        revision: row?.revision ?? 1,
        workingPageIndex: block.workingPageIndex,
        blockType: block.blockType,
        shapeType: block.shapeType,
        x0: block.x0,
        y0: block.y0,
        x1: block.x1,
        y1: block.y1,
        points: block.points,
        sortOrder: block.sortOrder,
        displayName: block.displayName,
        contentRotation: block.contentRotation,
        forceReprocess: false,
      };
    }),
  });

  return { body: built.body, manifest: manifestSha256(built.body) };
}

// =====================================================================
// 3. Загрузка PDF
// =====================================================================

export function createSyncUploadHandler(deps: ExecSyncDeps): JobHandler<'rd.sync_upload'> {
  return async (ctx: JobContext<'rd.sync_upload'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      const port = requirePort(deps);
      const sync = await requireSync(deps, target.runId);
      const { body, manifest } = await rebuildSnapshot(deps, target, sync);

      /*
       * Талон загрузки переспрашивается, а не берётся из payload задачи.
       *
       * Подписанная ссылка — секрет (§11), а `jobs.payload` это jsonb в базе и в
       * её бэкапах. И живёт талон час: повтор задачи через сутки нашёл бы в
       * payload протухший адрес. `init` идемпотентен по `external_sync_id` —
       * отвечает `duplicate: true` и выдаёт свежий талон.
       */
      const result = await port.initSync(body, manifest);

      if (!result.uploadRequired || result.upload === null) {
        // Файл узнан по sha256 — тот же PDF не грузится и не рендерится дважды.
        ctx.logger.info(
          { event: 'exec_upload_skipped', recognition_run_id: target.runId },
          'RD WEB уже знает этот PDF: загрузка пропущена',
        );
      } else {
        const pdf = await deps.openWorkingPdf(sync.documentSha256);
        await port.uploadDocument({
          url: result.upload.url,
          headers: result.upload.requiredHeaders,
          body: pdf.body,
          sizeBytes: pdf.sizeBytes,
        });
        await deps.countUploadAttempt(sync.id);
      }

      await deps.recordSyncState(sync.id, 'uploaded', { remoteState: result.state });
      await ctx.enqueue({
        type: 'rd.sync_complete',
        payload: { folderId: target.folderId, recognitionRunId: target.runId },
        dedupeKey: `rd.sync_complete:${sync.externalSyncId}`,
      });
    });
  };
}

// =====================================================================
// 4. Завершение отправки
// =====================================================================

export function createSyncCompleteHandler(deps: ExecSyncDeps): JobHandler<'rd.sync_complete'> {
  return async (ctx: JobContext<'rd.sync_complete'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      const port = requirePort(deps);
      const sync = await requireSync(deps, target.runId);
      const remoteSyncId = sync.remoteSyncId;
      if (remoteSyncId === null) {
        throw new ExecStateError('Отправка не инициализирована: идентификатора их стороны нет.');
      }

      try {
        await port.completeSync(remoteSyncId);
      } catch (error) {
        if (error instanceof ExecSyncError && error.code === 'upload_not_verified') {
          /*
           * Файл не долетел — это не отказ навсегда, но и не повод крутиться.
           *
           * Ровно один круг: второй означал бы, что в хранилище лежит битый
           * объект, и цикл upload↔complete грузил бы его бесконечно.
           */
          if (sync.uploadAttempts <= 1) {
            await ctx.enqueue({
              type: 'rd.sync_upload',
              payload: { folderId: target.folderId, recognitionRunId: target.runId },
              dedupeKey: `rd.sync_upload:${sync.externalSyncId}:retry`,
            });
            return;
          }
          throw new ExecStateError(
            'RD WEB не подтвердил загруженный PDF дважды: проверьте рабочий документ в хранилище.',
          );
        }
        if (error instanceof ExecSyncError && error.conflict !== null) {
          await routeConflict(deps, ctx, target, error);
        }
        throw error;
      }

      await deps.recordSyncState(sync.id, 'completed');
      await ctx.emit('recognition.sync_completed', { recognitionRunId: target.runId });
      await ctx.enqueue({
        type: 'rd.sync_poll',
        payload: { folderId: target.folderId, recognitionRunId: target.runId },
        dedupeKey: `rd.sync_poll:${sync.externalSyncId}`,
      });
    });
  };
}

// =====================================================================
// 5. Опрос
// =====================================================================

export interface ExecPollOptions {
  readonly pollsPerAttempt?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createSyncPollHandler(
  deps: ExecSyncDeps,
  options: ExecPollOptions = {},
): JobHandler<'rd.sync_poll'> {
  const pollsPerAttempt = options.pollsPerAttempt ?? DEFAULT_POLLS_PER_ATTEMPT;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return async (ctx: JobContext<'rd.sync_poll'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      const port = requirePort(deps);
      const sync = await requireSync(deps, target.runId);
      const remoteSyncId = sync.remoteSyncId;
      if (remoteSyncId === null) {
        throw new ExecStateError('Отправка не инициализирована: опрашивать нечего.');
      }

      for (let attempt = 0; attempt < pollsPerAttempt; attempt += 1) {
        if (ctx.signal.aborted) break;
        const status = await port.readSync(remoteSyncId);

        if (!TERMINAL_SYNC_STATES.has(status.state)) {
          if (attempt < pollsPerAttempt - 1) await sleep(intervalMs, ctx.signal);
          continue;
        }

        await deps.recordSyncState(sync.id, 'terminal', {
          remoteState: status.state,
          allTerminal: status.allTerminal,
          allSuccessful: status.allSuccessful,
          counters: status.counters,
        });

        if (status.state === 'superseded') {
          /*
           * Нас вытеснили. Это НЕ отказ по существу: работа не сломалась, она
           * устарела — кто-то нажал «Распознать» ещё раз, и наш снимок обогнала
           * следующая генерация. Публиковать результат такой отправки запрещает
           * чек-лист §16 п. 10, и формулировка обязана отличаться от «RD WEB
           * отказал»: человек должен понимать, что случилось.
           */
          throw new ExecSupersededError(
            'Отправку вытеснила более новая генерация: результат этого прогона не публикуется.',
          );
        }
        if (!SUCCESSFUL_SYNC_STATES.has(status.state)) {
          throw new ExecStateError(`RD WEB завершил отправку состоянием «${status.state}».`);
        }

        await ctx.enqueue({
          type: 'rd.sync_fetch',
          payload: { folderId: target.folderId, recognitionRunId: target.runId },
          dedupeKey: `rd.sync_fetch:${sync.externalSyncId}`,
        });
        return;
      }

      // Ожидание — третий исход, не успех и не отказ: попытка записывается
      // `deferred`, `error_class` не пишется, журнал ошибок не трогается.
      throw new JobDeferredError('RD WEB ещё распознаёт снимок');
    });
  };
}

// =====================================================================
// 6. Забор результатов
// =====================================================================

interface PageTally {
  recognized: number;
  invalid: number;
  refused: number;
}

export function createSyncFetchHandler(deps: ExecSyncDeps): JobHandler<'rd.sync_fetch'> {
  return async (ctx: JobContext<'rd.sync_fetch'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      const port = requirePort(deps);
      const sync = await requireSync(deps, target.runId);

      const declared = await deps.listDeclaredBlocks(target.folderId);
      const byExternalId = new Map(declared.map((row) => [row.externalBlockId, row]));
      const blocks = await deps.loadLayoutBlocks(target);
      const byLayoutBlockId = new Map(blocks.map((block) => [block.id, block]));
      const alreadySaved = await deps.listSavedBlockIds(target.runId);

      const tallies = new Map<number, PageTally>();
      const tally = (page: number): PageTally => {
        const existing = tallies.get(page);
        if (existing !== undefined) return existing;
        const created: PageTally = { recognized: 0, invalid: 0, refused: 0 };
        tallies.set(page, created);
        return created;
      };

      let suspicious = 0;
      let reusedWithoutModel = 0;
      let cursor: string | undefined;

      do {
        const page = await port.readDocumentBlocks(
          sync.externalDocumentId,
          ...(cursor === undefined ? [] : ([cursor] as const)),
        );
        for (const row of page.items) {
          const outcome = await absorbRow({
            deps,
            target,
            row,
            declaration: byExternalId.get(row.externalBlockId),
            layoutBlock: (id) => byLayoutBlockId.get(id),
            alreadySaved,
            syncId: sync.externalSyncId,
          });
          if (outcome === null) continue;
          const counters = tally(outcome.workingPageIndex);
          if (outcome.kind === 'recognized') counters.recognized += 1;
          if (outcome.kind === 'invalid') counters.invalid += 1;
          if (outcome.kind === 'refused') counters.refused += 1;
          if (outcome.suspicious) suspicious += 1;
          if (outcome.reusedWithoutModel) reusedWithoutModel += 1;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      // Страница закрыта, если её блоки покрыты целиком. Непокрытая остаётся
      // `failed` и объясняется частичной публикацией на финализации.
      const expectedPerPage = new Map<number, number>();
      for (const row of declared) {
        expectedPerPage.set(
          row.workingPageIndex,
          (expectedPerPage.get(row.workingPageIndex) ?? 0) + 1,
        );
      }
      for (const [page, expected] of expectedPerPage) {
        const counters = tallies.get(page) ?? { recognized: 0, invalid: 0, refused: 0 };
        const covered = counters.recognized + counters.invalid;
        await deps.markRunPage({
          runId: target.runId,
          workingPageIndex: page,
          status: covered >= expected ? 'done' : 'failed',
          blocksRecognized: counters.recognized,
          blocksInvalid: counters.invalid,
          blocksRefused: counters.refused,
        });
      }

      await deps.mergeSnapshot(target.runId, {
        blocksSuspicious: suspicious,
        blocksReusedWithoutModel: reusedWithoutModel,
      });

      await ctx.enqueue({
        type: 'rd.sync_finalize',
        payload: {
          folderId: target.folderId,
          recognitionRunId: target.runId,
          ...(ctx.payload.autoContinue === true ? { autoContinue: true } : {}),
        },
        dedupeKey: `rd.sync_finalize:${sync.externalSyncId}`,
      });
    });
  };
}

interface AbsorbOutcome {
  readonly kind: 'recognized' | 'invalid' | 'refused';
  readonly workingPageIndex: number;
  readonly suspicious: boolean;
  readonly reusedWithoutModel: boolean;
}

async function absorbRow(input: {
  readonly deps: ExecSyncDeps;
  readonly target: ExecRunTarget;
  readonly row: ExecBlockResultRow;
  readonly declaration: ExecDeclaredBlock | undefined;
  readonly layoutBlock: (id: string) => ExecLayoutBlock | undefined;
  readonly alreadySaved: ReadonlySet<string>;
  readonly syncId: string;
}): Promise<AbsorbOutcome | null> {
  const { deps, target, row, declaration } = input;

  // Блок вне нашего снимка либо удалённый: истории прошлых генераций нам не
  // нужны, но и падать из-за них незачем — §14 отдаёт их намеренно.
  if (declaration === undefined || row.isDeleted) return null;

  /*
   * Гейт целостности: ревизия обязана совпасть с объявленной.
   *
   * Ручка отдаёт ПОСЛЕДНИЕ результаты документа, а не результаты нашей
   * отправки. Без сверки вытесненная генерация молча подложила бы результаты
   * другого набора блоков — и обнаружилось бы это уже в тексте документа.
   */
  if (row.externalBlockRevision > declaration.revision) {
    throw new ExecIntegrityError(
      `Блок ${row.externalBlockId}: RD WEB отдал ревизию ${String(row.externalBlockRevision)} ` +
        `при объявленной ${String(declaration.revision)} — результаты принадлежат другой отправке.`,
    );
  }

  const layoutBlockId = declaration.layoutBlockId;
  if (layoutBlockId === null) return null;
  const block = input.layoutBlock(layoutBlockId);
  if (block === undefined) return null;
  if (input.alreadySaved.has(layoutBlockId)) {
    return {
      kind: 'recognized',
      workingPageIndex: declaration.workingPageIndex,
      suspicious: false,
      reusedWithoutModel: row.reusedWithoutModel,
    };
  }

  if (row.status === 'error' || row.status === 'non_retriable') {
    await deps.feedback.record({
      feedbackType: 'recognition_failure',
      reasonCode: row.status === 'error' ? 'rdweb.block_error' : 'rdweb.block_non_retriable',
      severity: 'error',
      folderId: target.folderId,
      recognitionRunId: target.runId,
      layoutBlockId,
      workingPageIndex: declaration.workingPageIndex,
      pipelineStage: 'recognition',
      provider: 'rdweb',
      observed: { status: row.status, reason: [...row.reconciliationReason] },
    });
    return {
      kind: 'refused',
      workingPageIndex: declaration.workingPageIndex,
      suspicious: false,
      reusedWithoutModel: false,
    };
  }

  const mapped = mapExecBlockResult(row, {
    layoutBlockId,
    blockType: block.blockType,
    sortOrder: block.sortOrder,
    coordsNorm: [block.x0, block.y0, block.x1, block.y1],
  });

  if (mapped.kind === 'unmappable') {
    await deps.feedback.record({
      feedbackType: 'recognition_failure',
      reasonCode: 'rdweb.block_unmappable',
      severity: 'warn',
      folderId: target.folderId,
      recognitionRunId: target.runId,
      layoutBlockId,
      workingPageIndex: declaration.workingPageIndex,
      pipelineStage: 'recognition',
      provider: 'rdweb',
      observed: { reason: mapped.reason },
    });
    return {
      kind: 'invalid',
      workingPageIndex: declaration.workingPageIndex,
      suspicious: false,
      reusedWithoutModel: false,
    };
  }

  const isSuspicious = row.status === 'suspicious';
  if (isSuspicious) {
    /*
     * §11: `suspicious` успехом не считается — результат получен, но не
     * подтверждён. Текст мы всё равно публикуем: потерять распознанное хуже,
     * чем показать сомнительное с пометкой. Но след обязан остаться на всех
     * трёх уровнях, иначе «распознано» и «распознано неуверенно» на экране
     * неразличимы.
     */
    await deps.feedback.record({
      feedbackType: 'recognition_failure',
      reasonCode: 'rdweb.suspicious',
      severity: 'warn',
      folderId: target.folderId,
      recognitionRunId: target.runId,
      layoutBlockId,
      workingPageIndex: declaration.workingPageIndex,
      pipelineStage: 'recognition',
      provider: 'rdweb',
      observed: { status: row.status, action: row.reconciliationAction },
    });
  }

  await deps.saveBlockResult({
    runId: target.runId,
    layoutRevisionId: target.layoutRevisionId,
    layoutBlockId,
    resultType: `${block.blockType}_json`,
    contentMd: contentMdOf(mapped.block),
    contentJson: {
      envelope: 'recognition.block_result.v1',
      block: mapped.block,
      provenance: {
        provider: 'rdweb_exec',
        adapterVersion: ADAPTER_VERSION_RDWEB_EXEC,
        syncId: input.syncId,
        externalBlockId: row.externalBlockId,
        externalBlockRevision: row.externalBlockRevision,
        status: row.status,
        reconciliationAction: row.reconciliationAction,
        reconciliationReason: [...row.reconciliationReason],
        reusedWithoutModel: row.reusedWithoutModel,
      },
    },
  });

  return {
    // `suspicious` считается непригодным, а не распознанным: иначе счётчик
    // «распознано» перестал бы значить распознанное. Дублировать его в оба
    // счётчика нельзя — сумма превысила бы число блоков страницы.
    kind: isSuspicious ? 'invalid' : 'recognized',
    workingPageIndex: declaration.workingPageIndex,
    suspicious: isSuspicious,
    reusedWithoutModel: row.reusedWithoutModel,
  };
}

function contentMdOf(block: RecognitionBlock): string | null {
  return block.blockType === 'text' ? block.text : null;
}

// =====================================================================
// 7. Финализация
// =====================================================================

/** Конверт результата блока: та же форма, что пишет ветка VLM. */
function blockOfEnvelope(contentJson: unknown): RecognitionBlock | null {
  if (typeof contentJson !== 'object' || contentJson === null) return null;
  const block = (contentJson as { block?: unknown }).block;
  return typeof block === 'object' && block !== null ? (block as RecognitionBlock) : null;
}

export function createSyncFinalizeHandler(deps: ExecSyncDeps): JobHandler<'rd.sync_finalize'> {
  return async (ctx: JobContext<'rd.sync_finalize'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      const blocks = await deps.loadLayoutBlocks(target);
      const geometry = await deps.loadPageGeometry(target);
      const envelopes = await deps.listBlockEnvelopes(target.runId);

      const results = new Map<string, RecognitionBlock>();
      for (const envelope of envelopes) {
        const block = blockOfEnvelope(envelope.contentJson);
        if (block !== null) results.set(envelope.layoutBlockId, block);
      }

      /*
       * Частичная публикация, а не отказ (дух ADR-0017 и решение S50).
       *
       * Блоки, по которым RD WEB отказал, результата не имеют, и требовать
       * полного покрытия значило бы выбрасывать двести распознанных страниц
       * из-за двух непрочитанных. В сборку идут только покрытые блоки, а
       * непокрытые называются предупреждением прогона — со счётом и с номерами
       * листов, по которым человек решает, дочитывать ли их отдельно.
       */
      const covered = blocks.filter((block) => results.has(block.id));
      if (covered.length === 0) {
        throw new ExecStateError('RD WEB не вернул ни одного результата: публиковать нечего.');
      }

      const pagesWithBlocks = new Set(covered.map((block) => block.workingPageIndex));
      const assembled = deps.assemble({
        source: { provider: 'rdweb_exec', adapterVersion: ADAPTER_VERSION_RDWEB_EXEC },
        // Модель выбирает RD WEB и в ручке результатов не называет.
        modelId: null,
        pages: geometry.filter((page) => pagesWithBlocks.has(page.workingPageIndex)),
        frozenBlocks: covered.map((block) => ({
          layoutBlockId: block.id,
          workingPageIndex: block.workingPageIndex,
          blockType: block.blockType,
          coordsNorm: [block.x0, block.y0, block.x1, block.y1] as const,
          sortOrder: block.sortOrder,
        })),
        results,
      });

      const bytes = new TextEncoder().encode(JSON.stringify(assembled));
      const artifactVersionId = await deps.storeCanonicalArtifact(target.runId, bytes);

      const incomplete = covered.length < blocks.length;
      const counts = {
        blocksExpected: blocks.length,
        blocksCovered: covered.length,
        pagesTotal: geometry.length,
      };

      if (target.settingsSnapshot['dryRun'] === true) {
        /*
         * Shadow-режим. Модель у RD WEB уже отработала и оплачена, так что денег
         * он здесь не экономит — но смысл сохраняет полностью: canonical записан
         * для сравнения провайдеров, публикация пропущена, downstream прогона не
         * видит вовсе.
         */
        await deps.finishRun({
          runId: target.runId,
          status: 'done',
          counts: { ...counts, dryRun: true },
        });
        ctx.logger.info(
          { event: 'exec_sync_dry_run_done', recognition_run_id: target.runId },
          'прогон RD WEB завершён в dry-run: canonical записан, публикация пропущена',
        );
        return;
      }

      const pages = (assembled as { pages: readonly unknown[] }).pages.map((page) => ({
        workingPageIndex: (page as { workingPageIndex: number }).workingPageIndex,
        textMd: deps.renderPageText(page),
        renderVersion: deps.pageTextRenderVersion,
      }));
      const published = await deps.publishResults({
        recognitionRunId: target.runId,
        artifactVersionId,
        pages,
      });

      const failedPages = [
        ...new Set(
          blocks.filter((block) => !results.has(block.id)).map((block) => block.workingPageIndex),
        ),
      ].sort((a, b) => a - b);

      await deps.finishRun({
        runId: target.runId,
        status: 'done',
        counts: { ...counts, ...published },
        ...(incomplete
          ? {
              warnings: [
                {
                  code: 'partial_publish',
                  message:
                    `RD WEB вернул результат по ${String(covered.length)} блокам из ` +
                    `${String(blocks.length)}; листы без полного покрытия: ` +
                    `${failedPages.map((page) => String(page + 1)).join(', ')}.`,
                  workingPageIndex: null,
                },
              ],
            }
          : {}),
      });

      ctx.logger.info(
        { event: 'recognition_export_stored', ...counts, ...published },
        'результат RD WEB собран, провалидирован и опубликован',
      );
      await ctx.emit('recognition.export_stored', { recognitionRunId: target.runId, ...counts });

      await deps.continueWithAnalysis(ctx, target);
    });
  };
}

// =====================================================================
// 8. Пересборка снимка после конфликта
// =====================================================================

export function createSyncResyncHandler(deps: ExecSyncDeps): JobHandler<'rd.sync_resync'> {
  return async (ctx: JobContext<'rd.sync_resync'>) => {
    const target = await requireRun(deps, ctx.payload.recognitionRunId);

    await withExecRunTermination(deps, ctx, target.runId, async () => {
      const port = requirePort(deps);
      const sync = await requireSync(deps, target.runId);

      /*
       * Единственный вид конфликта, который лечится чтением, — коллизия ревизии
       * блока: ответ ручки блоков называет действующие ревизии, и подняться
       * выше них можно точно. Остальные лечатся шагом генерации вперёд —
       * действующей серверной генерации контракт по запросу не отдаёт.
       */
      try {
        const page = await port.readDocumentBlocks(sync.externalDocumentId);
        await deps.liftBlockRevisions(
          target.folderId,
          page.items.map((row) => ({
            externalBlockId: row.externalBlockId,
            revision: row.externalBlockRevision,
          })),
        );
      } catch (error) {
        ctx.logger.warn(
          { event: 'exec_resync_read_failed', reason: messageOf(error) },
          'ревизии блоков прочитать не удалось: пересобираем по счётчику генерации',
        );
      }

      const lifted = await deps.liftGeneration(target.folderId, sync.syncGeneration + 1);
      await deps.recordSyncState(sync.id, 'terminal', { remoteState: 'conflict' });

      ctx.logger.info(
        { event: 'exec_resync_scheduled', generation: lifted, recognition_run_id: target.runId },
        'снимок пересобирается со следующей генерации',
      );

      await ctx.enqueue({
        type: 'rd.sync_prepare',
        payload: { folderId: target.folderId, recognitionRunId: target.runId },
        dedupeKey: `rd.sync_prepare:${target.runId}:g${String(lifted)}`,
      });
    });
  };
}

export { SnapshotBuildError };
