/**
 * Задачи 10–13 конвейера: сверка, запуск OCR, поллинг, однократный забор (§12).
 *
 * Обработчики написаны на портах (`RecognitionDeps`); связывание с базой,
 * хранилищем и адаптером RD WEB живёт в `pipeline.ts`. Разделение то же, что у
 * задач 1–9, и по той же причине (урок S3).
 *
 * ## Четыре гейта, которые здесь НЕ имеют права деградировать (§1.6)
 *
 * 1. **OCR не стартует при расхождении хэшей.** Цикл сверки доводит удалённый
 *    набор блоков до заказанного и записывает `remote_layout_hash_before`
 *    ТОЛЬКО при совпадении. `rd.start_recognition` независимо перепроверяет
 *    записанное перед вызовом RD WEB: гейт обязан держаться на самой задаче
 *    старта, а не на том, что предыдущая задача была аккуратна.
 * 2. **Подмена блока после старта даёт `integrity_error`.** Перед забором
 *    экспорта удалённый набор перечитывается заново и хэшируется; расхождение
 *    останавливает прогон, и результаты не используются.
 * 3. **Верификация хэша артефакта.** Забранные байты хэшируются, хэш ложится в
 *    `artifact_versions`, и повторный заход сверяет байты с записанным хэшем.
 *    Несовпадение — отказ, а не тихое использование.
 * 4. **Забор экспорта ровно один раз и только при `has_export`.** Однократность
 *    держится тремя рубежами: строка `artifact_versions` (UNIQUE по
 *    прогону и виду), детерминированный ключ объекта в нашем хранилище и явная
 *    проверка обоих ДО обращения к RD WEB. Повтор задачи после падения
 *    продолжает с уже забранных байт, а не тянет экспорт второй раз.
 *
 * ## Почему забор — отдельная задача, а не хвост поллинга
 *
 * Их экспорт транзиентный: архив собирается на лету из ТЕКУЩИХ активных
 * результатов. Значит между «job готов» и «байты у нас» есть окно, в котором
 * состояние может измениться, и это окно обязано быть видно в `job_runs`
 * отдельной строкой со своим таймингом — иначе «долго качали» и «долго ждали»
 * сливаются в одну цифру.
 *
 * ## Исчерпание попыток ЛЮБОЙ задачи завершает прогон
 *
 * `JobRunner` при исчерпании попыток помечает задачу `dead` и `recognition_runs`
 * не трогает — он о прогонах ничего не знает и знать не должен. Значит закрыть
 * прогон обязан этот модуль, и правило здесь ОБЩЕЕ (`withRunTermination`), а не
 * перечисление классов ошибок. Перечисление уже один раз подвело: обрабатывался
 * `ZipError`, а `ExportFormatError`, `RecognitionIntegrityError` и обычный
 * `Error` оставляли прогон в `running` навсегда. Последствие тяжелее, чем
 * «поле не обновилось»: `startRecognitionRun` на незавершённом прогоне
 * возвращает его же (`created: false`), то есть новый прогон невозможен и
 * ревизия разметки запирается насмерть.
 *
 * Прогон завершается ТОЛЬКО когда повтора больше не будет — на последней
 * попытке или при неповторяемой ошибке (`classifyFailure().permanent`).
 * Расхождение доказательств даёт `integrity_error`, всё остальное — `failed`.
 *
 * ## Нулевой результат — не успех
 *
 * Прогон, распознавший ноль блоков, до S7-ремонта был неотличим от успешного:
 * пустой markdown давал `done` с нулём страниц. Поэтому перед записью
 * результатов проверяется покрытие: каждый не-STAMP блок замороженной разметки
 * обязан иметь секцию в `document.md`. Рубеж взят не с потолка — это ИХ
 * собственный QA-инвариант `markdown_contains_all_blocks`, считаемый по тем же
 * не-STAMP блокам (`finalizer/service_export._export`). STAMP — единственный
 * законный допуск: их рендер таким блокам секции не даёт вовсе.
 */
import type { JobContext, JobHandler } from '@id/api';
import {
  classifyFailure,
  computeBlocksHash,
  JobDeferredError,
  matchBlocks,
  parseExportMarkdown,
  readZipEntries,
  redactAbsoluteUrls,
  requireEntry,
  SUCCESSFUL_RECOGNITION_STATUSES,
  TERMINAL_RECOGNITION_STATUSES,
  ZipError,
  EXPORT_ENTRY_HTML,
  EXPORT_ENTRY_MARKDOWN,
  EXPORT_ENTRY_QA,
  type ArtifactKind,
  type HashableBlock,
  type RdWebPort,
  type RecognitionSelection,
  type RemoteBlock,
  type RemoteBlockResult,
} from '@id/api';

/** Потолок распакованного экспорта: защита от zip-бомбы из внешней системы. */
const MAX_EXPORT_UNPACKED_BYTES = 256 * 1024 * 1024;

/** Сколько проходов сверки делает одна попытка задачи 10. */
const RECONCILE_PASSES = 3;

export interface RunTarget {
  readonly runId: string;
  readonly revisionId: string;
  readonly layoutRevisionId: string;
  readonly status: string;
  readonly rdDocumentId: string;
  readonly rdJobId: string | null;
  readonly localLayoutHash: string;
  readonly remoteLayoutHashBefore: string | null;
  readonly runDocumentClosed: boolean;
}

/** Локальный блок замороженной разметки: и вход хэша, и вход сопоставления. */
export interface LocalBlock extends HashableBlock {
  readonly id: string;
}

export interface StoredArtifact {
  readonly kind: ArtifactKind;
  readonly artifactSha256: string;
  readonly byteSize: number;
}

export interface RecognitionDeps {
  readonly rdweb: RdWebPort | null;
  /** Выбор провайдера/модели/профиля на тип блока (§10). Пусто — OCR не запускается. */
  readonly selections: readonly RecognitionSelection[];
  /**
   * Режим документа RD WEB.
   *
   * `false` по умолчанию и осознанно: в режиме документа в job уходят ТОЛЬКО
   * TEXT-блоки, а штамп подавляется в выходных файлах. §5.3 прямо опирается на
   * `image`- и `stamp`-блоки (описание чертежей и метаданные штампа), поэтому
   * включать его значило бы выбросить часть заказанного набора уже на их
   * стороне — при совпавших хэшах.
   */
  readonly documentMode: boolean;

  loadRun(input: {
    readonly revisionId: string;
    readonly recognitionRunId: string;
  }): Promise<RunTarget | null>;
  loadFrozenBlocks(runId: string): Promise<readonly LocalBlock[]>;

  saveRemoteHashBefore(runId: string, remoteHash: string): Promise<void>;
  saveRdJobId(runId: string, rdJobId: string): Promise<void>;
  finishRun(input: {
    readonly runId: string;
    readonly status: 'done' | 'integrity_error' | 'failed';
    readonly counts?: Record<string, unknown> | undefined;
    readonly warnings?: readonly unknown[] | undefined;
    readonly remoteLayoutHashAfter?: string | undefined;
    readonly reason?: string | undefined;
  }): Promise<{ readonly changed: boolean }>;

  findArtifact(runId: string, kind: ArtifactKind): Promise<StoredArtifact | null>;
  recordArtifact(input: {
    readonly runId: string;
    readonly kind: ArtifactKind;
    readonly artifactSha256: string;
    readonly byteSize: number;
  }): Promise<{ readonly kind: 'recorded' | 'already'; readonly artifactSha256: string }>;
  /** Байты артефакта из НАШЕГО хранилища; `null` — объекта нет. */
  readArtifactBytes(runId: string, kind: ArtifactKind): Promise<Uint8Array | null>;
  writeArtifactBytes(input: {
    readonly runId: string;
    readonly kind: ArtifactKind;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<void>;
  artifactId(runId: string, kind: ArtifactKind): Promise<string>;

  saveResults(input: {
    readonly runId: string;
    readonly artifactVersionId: string;
    readonly pages: readonly { readonly workingPageIndex: number; readonly textMd: string }[];
    readonly blocks: readonly {
      readonly layoutBlockId: string;
      readonly resultType: string;
      readonly contentHtml: string | null;
      readonly contentMd: string | null;
      readonly contentJson: unknown;
      readonly modelId: string | null;
      readonly confidence: number | null;
    }[];
  }): Promise<{
    readonly pagesWritten: number;
    readonly pagesAlreadyPresent: number;
    /** Номер страницы вне рабочего документа: батч не записан вовсе. */
    readonly pagesOutOfRange: number;
    readonly blocksWritten: number;
    readonly blocksAlreadyPresent: number;
    readonly blocksUnknown: number;
  }>;

  closeRunDocument(layoutRevisionId: string): Promise<{ readonly changed: boolean }>;
  sha256(bytes: Uint8Array): string;
}

export class RecognitionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecognitionConfigurationError';
  }
}

/**
 * Нарушение целостности прогона.
 *
 * Отдельный класс, а не общий `Error`: он означает, что результат НЕ будет
 * использован, и по `job_runs.error_class` это обязано отличаться от сетевого
 * сбоя, который надо повторить.
 */
export class RecognitionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecognitionIntegrityError';
  }
}

export class RecognitionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecognitionStateError';
  }
}

/**
 * Задачи прогона распознавания.
 *
 * Перечисление здесь допустимо и даже нужно: это состав стадии, а не список
 * «ошибок, которые мы вспомнили». Забытая в нём задача не компилируется в
 * `registerPipelineJobs`, забытый класс ошибки — компилировался бы молча.
 */
type RecognitionJobType =
  'layout.reconcile' | 'rd.start_recognition' | 'rd.poll_recognition' | 'rd.fetch_export_once';

/** Длина причины в `recognition_runs.warnings`: строка для человека, не дамп. */
const MAX_REASON_LENGTH = 400;

/**
 * Причина отказа в терминальном состоянии прогона.
 *
 * Сообщение ошибки уходит и в `revision_events`, и в ответ API, поэтому оно
 * проходит через ту же обработку, что и текст страниц: абсолютные ссылки
 * обезвреживаются (§11), длина ограничена. Дословный дамп чужого ответа в поле,
 * которое читает подрядчик, — это утечка, а не диагностика; диагностика лежит в
 * `job_runs.error_message` и в `error_events`.
 */
function terminationReason(jobType: string, error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const scrubbed = redactAbsoluteUrls(`задача ${jobType} исчерпала попытки: ${name}: ${message}`);
  return scrubbed.text.slice(0, MAX_REASON_LENGTH);
}

/**
 * Завершение прогона, когда повтора больше не будет.
 *
 * ОБЩЕЕ правило на все четыре задачи, и именно поэтому оно обёртка, а не ветка
 * в каждом обработчике: перечисление классов ошибок уже потеряло пять случаев
 * из шести. Обёртка не подменяет точные диагнозы внутри обработчиков — те
 * закрывают прогон раньше и с внятной причиной, — она закрывает всё остальное.
 *
 * Два условия «повтора не будет» ровно те же, по которым `JobRunner` объявляет
 * задачу мёртвой: последняя попытка либо неповторяемая ошибка. Иначе прогон
 * оставался бы `running` — и это правильно: повтор ещё предстоит.
 *
 * Отказ самого завершения не имеет права подменить исходную ошибку: она
 * объясняет, ЧТО случилось, а неудача записи исхода — это отдельный факт для
 * журнала. Поэтому `finishRun` здесь в своём try/catch.
 */
function withRunTermination<T extends RecognitionJobType>(
  deps: RecognitionDeps,
  handler: JobHandler<T>,
): JobHandler<T> {
  return async (ctx: JobContext<T>) => {
    try {
      await handler(ctx);
    } catch (error) {
      if (ctx.attempt >= ctx.maxAttempts || classifyFailure(error).permanent) {
        const payload = ctx.payload as { readonly recognitionRunId: string };
        try {
          const outcome = await deps.finishRun({
            runId: payload.recognitionRunId,
            // Расхождение доказательств — отдельный исход: результаты такого
            // прогона не используются, и по статусу это обязано быть видно.
            status: error instanceof RecognitionIntegrityError ? 'integrity_error' : 'failed',
            reason: terminationReason(ctx.type, error),
            warnings: [
              {
                code: 'job_attempts_exhausted',
                jobType: ctx.type,
                attempt: ctx.attempt,
                errorClass: classifyFailure(error).errorClass,
              },
            ],
          });
          ctx.logger.error(
            {
              event: 'recognition_run_terminated',
              job_type: ctx.type,
              attempt: ctx.attempt,
              max_attempts: ctx.maxAttempts,
              error_class: classifyFailure(error).errorClass,
              changed: outcome.changed,
            },
            'попытки задачи исчерпаны, прогон распознавания завершён',
          );
        } catch (finishError) {
          ctx.logger.error(
            {
              event: 'recognition_run_termination_failed',
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

function requirePort(deps: RecognitionDeps): RdWebPort {
  if (deps.rdweb === null) {
    throw new RecognitionConfigurationError(
      'Интеграция RD WEB не настроена: задайте RDWEB_BASE_URL, RDWEB_USER, ' +
        'RDWEB_PASSWORD и RDWEB_PROJECT_ALLOWLIST',
    );
  }
  return deps.rdweb;
}

async function loadRunningRun(
  deps: RecognitionDeps,
  payload: { readonly revisionId: string; readonly recognitionRunId: string },
): Promise<RunTarget> {
  const run = await deps.loadRun(payload);
  if (run === null) throw new RecognitionStateError('Прогон распознавания не найден');
  if (run.status !== 'running') {
    throw new RecognitionStateError(
      `Прогон уже завершён со статусом ${run.status}: продолжать его нельзя`,
    );
  }
  return run;
}

/** Приведение блока RD WEB к форме, пригодной и для хэша, и для сопоставления. */
export function toHashable(block: RemoteBlock, fallbackOrder: number): HashableBlock {
  const [x0, y0, x1, y1] = block.coordsNorm;
  return {
    workingPageIndex: block.pageIndex,
    blockType: block.blockType,
    shapeType: block.shapeType,
    x0,
    y0,
    x1,
    y1,
    sortOrder: block.sortOrder ?? fallbackOrder,
    points:
      block.shapeType === 'polygon'
        ? (block.polygonPoints ?? []).map((point) => ({ x: point[0], y: point[1] }))
        : [],
  };
}

export function remoteHashOf(blocks: readonly RemoteBlock[]): string {
  return computeBlocksHash(blocks.map((block, index) => toHashable(block, index)));
}

// =====================================================================
// Задача 10: цикл сверки (§5.2, шаг 5)
// =====================================================================

export function createReconcileHandler(deps: RecognitionDeps): JobHandler<'layout.reconcile'> {
  return withRunTermination(deps, async (ctx: JobContext<'layout.reconcile'>) => {
    const port = requirePort(deps);
    const run = await loadRunningRun(deps, ctx.payload);
    const local = await deps.loadFrozenBlocks(run.runId);
    if (local.length === 0) {
      throw new RecognitionStateError('У замороженной разметки нет блоков: распознавать нечего');
    }

    const desired = local.map((block) => ({
      pageIndex: block.workingPageIndex,
      blockType: block.blockType as 'text' | 'image' | 'stamp',
      shapeType: block.shapeType as 'rectangle' | 'polygon',
      coordsNorm: [block.x0, block.y0, block.x1, block.y1] as [number, number, number, number],
      polygonPoints:
        block.points.length > 0
          ? block.points.map((point) => [point.x, point.y] as [number, number])
          : null,
      sortOrder: block.sortOrder,
    }));

    let lastRemoteHash = '';
    for (let pass = 0; pass < RECONCILE_PASSES; pass += 1) {
      if (ctx.signal.aborted) break;
      const result = await port.reconcileLayout({ documentId: run.rdDocumentId, desired });
      lastRemoteHash = remoteHashOf(result.remote);

      ctx.logger.info(
        {
          event: 'layout_reconcile_pass',
          pass: pass + 1,
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
          remote_blocks: result.remote.length,
          local_blocks: local.length,
          matched: lastRemoteHash === run.localLayoutHash,
        },
        'проход цикла сверки разметки',
      );

      if (lastRemoteHash !== run.localLayoutHash) continue;

      // Хэш записывается ТОЛЬКО при совпадении — см. `saveRemoteHashBefore`.
      await deps.saveRemoteHashBefore(run.runId, lastRemoteHash);
      await ctx.emit('recognition.layout_reconciled', {
        recognitionRunId: run.runId,
        layoutRevisionId: run.layoutRevisionId,
        blocks: result.remote.length,
      });
      await ctx.enqueue({
        type: 'rd.start_recognition',
        payload: { revisionId: run.revisionId, recognitionRunId: run.runId, ...carry(ctx) },
        dedupeKey: `rd.start_recognition:${run.runId}`,
      });
      return;
    }

    // Последняя попытка исчерпана, а набор так и не сошёлся. Оставить прогон
    // «выполняющимся» нельзя: он висел бы вечно, а по §5.2 расхождение — это
    // законченное состояние, в котором результаты не используются.
    if (ctx.attempt >= ctx.maxAttempts) {
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        remoteLayoutHashAfter: lastRemoteHash === '' ? undefined : lastRemoteHash,
        reason: 'цикл сверки не свёл удалённый набор блоков к заказанному',
        counts: { localBlocks: local.length },
      });
      throw new RecognitionIntegrityError(
        `Удалённый набор блоков не сведён к заказанному за ${ctx.maxAttempts} попыток: ` +
          `локальный хэш ${run.localLayoutHash.slice(0, 12)}…, удалённый ${
            lastRemoteHash.slice(0, 12) || '(нет)'
          }…`,
      );
    }

    // Отсрочка, а не отказ: RD WEB ничего не сломал, сверка просто ещё не
    // сошлась. `RdWebError` здесь означал бы, что виноват их сервис, и писал бы
    // попытку исходом `failed` — то есть считал бы нормальный ход дела серией
    // отказов и заслонял бы ими настоящие.
    throw new JobDeferredError('Цикл сверки разметки ещё не сошёлся, требуется повтор');
  });
}

// =====================================================================
// Задача 11: запуск OCR (§5.2, шаг 6)
// =====================================================================

export function createStartRecognitionHandler(
  deps: RecognitionDeps,
): JobHandler<'rd.start_recognition'> {
  return withRunTermination(deps, async (ctx: JobContext<'rd.start_recognition'>) => {
    const port = requirePort(deps);
    if (deps.selections.length === 0) {
      throw new RecognitionConfigurationError(
        'Профиль распознавания RD WEB не настроен: задайте RDWEB_OCR_MODEL ' +
          '(и при необходимости RDWEB_OCR_PROVIDER)',
      );
    }
    const run = await loadRunningRun(deps, ctx.payload);

    // НЕ-ДЕГРАДИРУЕМЫЙ ГЕЙТ. Проверка повторяется здесь, хотя цикл сверки уже
    // записал хэш только при совпадении: гейт «OCR не стартует при расхождении»
    // обязан держаться задачей, которая ЗАПУСКАЕТ OCR, а не доверием к соседней.
    if (run.remoteLayoutHashBefore === null) {
      throw new RecognitionIntegrityError(
        'Распознавание не запускается: цикл сверки не подтвердил совпадение хэшей разметки',
      );
    }
    if (run.remoteLayoutHashBefore !== run.localLayoutHash) {
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        reason: 'хэш удалённой разметки не совпал с локальным перед стартом OCR',
      });
      throw new RecognitionIntegrityError(
        'Распознавание не запускается: удалённый хэш разметки не совпал с локальным',
      );
    }

    if (run.rdJobId !== null) {
      // Задача 11 объявлена с одной попыткой, но повторно поставить её может
      // администратор из консоли. Второй запуск — это второй прогон на GPU по
      // тому же документу, и он обязан не состояться.
      ctx.logger.warn(
        { event: 'recognition_already_started', rd_job_id: run.rdJobId },
        'OCR по этому прогону уже запущен, повторный запуск не выполняется',
      );
      await enqueuePoll(ctx, run);
      return;
    }

    const status = await port.startRecognition({
      documentId: run.rdDocumentId,
      selections: deps.selections,
      documentMode: deps.documentMode,
      // Ключ идемпотентности их стороны — идентификатор нашего прогона: он
      // уникален и не рассказывает ни о стройке, ни о подрядчике.
      idempotencyKey: run.runId,
    });
    await deps.saveRdJobId(run.runId, status.jobId);

    ctx.logger.info(
      {
        event: 'recognition_started',
        rd_job_id: status.jobId,
        total_blocks: status.totalBlocks,
        remote_status: status.status,
      },
      'распознавание запущено',
    );
    await ctx.emit('recognition.ocr_started', {
      recognitionRunId: run.runId,
      totalBlocks: status.totalBlocks,
    });
    await enqueuePoll(ctx, run);
  });
}

async function enqueuePoll(ctx: JobContext<'rd.start_recognition'>, run: RunTarget): Promise<void> {
  await ctx.enqueue({
    type: 'rd.poll_recognition',
    payload: { revisionId: run.revisionId, recognitionRunId: run.runId, ...carry(ctx) },
    dedupeKey: `rd.poll_recognition:${run.runId}`,
  });
}

// =====================================================================
// Задача 12: поллинг (§5.2, шаг 6 → 8)
// =====================================================================

export interface PollRecognitionOptions {
  readonly pollsPerAttempt?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('ожидание прервано остановкой воркера'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createPollRecognitionHandler(
  deps: RecognitionDeps,
  options: PollRecognitionOptions = {},
): JobHandler<'rd.poll_recognition'> {
  const polls = options.pollsPerAttempt ?? 5;
  const interval = options.pollIntervalMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;

  return withRunTermination(deps, async (ctx: JobContext<'rd.poll_recognition'>) => {
    const port = requirePort(deps);
    const run = await loadRunningRun(deps, ctx.payload);
    if (run.rdJobId === null) {
      throw new RecognitionStateError('OCR не запущен: у прогона нет идентификатора job RD WEB');
    }

    for (let poll = 0; poll < polls; poll += 1) {
      if (poll > 0) await sleep(interval, ctx.signal);
      const status = await port.pollRecognition(run.rdJobId);

      if (!TERMINAL_RECOGNITION_STATUSES.has(status.status)) continue;

      if (!SUCCESSFUL_RECOGNITION_STATUSES.has(status.status)) {
        await deps.finishRun({
          runId: run.runId,
          status: 'failed',
          reason: `RD WEB завершил распознавание со статусом ${status.status}`,
          counts: {
            totalBlocks: status.totalBlocks,
            recognizedBlocks: status.recognizedBlocks,
            failedBlocks: status.failedBlocks,
          },
          warnings:
            status.errorMessage === null
              ? []
              : [{ code: 'rdweb_job_failed', message: status.errorMessage }],
        });
        ctx.logger.error(
          { event: 'recognition_failed', remote_status: status.status },
          'RD WEB завершил распознавание отказом',
        );
        return;
      }

      // НЕ-ДЕГРАДИРУЕМЫЙ ГЕЙТ. Забор экспорта ставится ТОЛЬКО при `has_export`.
      //
      // Терминальный успех БЕЗ экспорта — это конец, а не «ещё не готово». У
      // них порядок записи в финализаторе фиксированный (`service_export._export`):
      // манифест выкладывается в хранилище, потом проставляется
      // `qa_manifest_s3_key`, и только последним — терминальный статус job'а.
      // Значит `done` при `has_export=false` означает не «подождите», а
      // «манифеста не будет»; ожидание в этом состоянии — это шестьдесят
      // попыток ради предрешённого исхода, а стадия «идёт сборка» у них уже
      // выражена отдельным нетерминальным статусом `finalizing`.
      if (!status.hasExport) {
        await deps.finishRun({
          runId: run.runId,
          status: 'failed',
          reason: `RD WEB завершил job со статусом ${status.status}, но экспорт не финализирован`,
          counts: {
            totalBlocks: status.totalBlocks,
            recognizedBlocks: status.recognizedBlocks,
          },
          warnings: [
            { code: 'export_not_finalized', message: 'has_export=false у завершённого job' },
          ],
        });
        ctx.logger.error(
          { event: 'recognition_export_missing', remote_status: status.status },
          'job завершён, но QA-финализации не было: экспорта не будет',
        );
        return;
      }

      await ctx.emit('recognition.ocr_finished', {
        recognitionRunId: run.runId,
        recognizedBlocks: status.recognizedBlocks,
        failedBlocks: status.failedBlocks,
      });
      await ctx.enqueue({
        type: 'rd.fetch_export_once',
        payload: { revisionId: run.revisionId, recognitionRunId: run.runId, ...carry(ctx) },
        dedupeKey: `rd.fetch_export_once:${run.runId}`,
      });
      return;
    }

    // Попытки исчерпаны, а job так и не дошёл до терминального статуса. Прогон
    // обязан закончиться отказом, а не висеть в `running` вечно: «зависло у
    // них» — это состояние, о котором должен узнать человек.
    if (ctx.attempt >= ctx.maxAttempts) {
      await deps.finishRun({
        runId: run.runId,
        status: 'failed',
        reason: 'RD WEB не завершил распознавание за отведённое число попыток',
      });
      throw new RecognitionStateError(
        `Распознавание не завершилось за ${ctx.maxAttempts} попыток поллинга`,
      );
    }

    // «Ещё идёт» — отсрочка. Ветка выше уже перевела исчерпание попыток в
    // настоящий отказ с закрытием прогона, поэтому здесь остаётся только
    // ожидание, и записывать его как неудачу нечем.
    throw new JobDeferredError('Распознавание ещё идёт');
  });
}

// =====================================================================
// Задача 13: однократный забор экспорта (§5.2, шаги 7–9)
// =====================================================================

export function createFetchExportHandler(
  deps: RecognitionDeps,
): JobHandler<'rd.fetch_export_once'> {
  return withRunTermination(deps, async (ctx: JobContext<'rd.fetch_export_once'>) => {
    const port = requirePort(deps);
    const run = await loadRunningRun(deps, ctx.payload);
    if (run.rdJobId === null) {
      throw new RecognitionStateError('OCR не запускался: забирать нечего');
    }

    // --- Шаг 7: подмена блока после старта даёт integrity_error -------------
    const remote = await port.listBlocks(run.rdDocumentId);
    const remoteHash = remoteHashOf(remote);
    if (remoteHash !== run.localLayoutHash) {
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        remoteLayoutHashAfter: remoteHash,
        reason: 'набор блоков RD WEB изменился после старта распознавания',
        counts: { remoteBlocks: remote.length },
      });
      // Документ закрывается и здесь: он больше не описывает заказанное, и
      // повторный прогон по нему был бы прогоном по подменённому набору.
      await deps.closeRunDocument(run.layoutRevisionId);
      ctx.logger.error(
        {
          event: 'recognition_integrity_error',
          stage: 'after_ocr',
          local_hash: run.localLayoutHash,
          remote_hash: remoteHash,
        },
        'набор блоков на стороне RD WEB изменился после старта OCR',
      );
      throw new RecognitionIntegrityError(
        'Набор блоков RD WEB изменился после старта распознавания: результаты не используются',
      );
    }

    // --- Шаг 8: забор ровно один раз ---------------------------------------
    const archive = await obtainArchive(deps, port, ctx, run);

    let entries;
    try {
      entries = readZipEntries(archive.bytes, MAX_EXPORT_UNPACKED_BYTES);
    } catch (error) {
      if (!(error instanceof ZipError)) throw error;
      await deps.finishRun({
        runId: run.runId,
        status: 'failed',
        reason: `архив экспорта не разбирается: ${error.message}`,
      });
      throw error;
    }
    const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));

    const markdown = requireEntry(byName, EXPORT_ENTRY_MARKDOWN);
    const html = requireEntry(byName, EXPORT_ENTRY_HTML);
    const qa = requireEntry(byName, EXPORT_ENTRY_QA);

    const mdArtifact = await storeDerived(deps, run.runId, 'md', markdown, 'text/markdown');
    await storeDerived(deps, run.runId, 'html', html, 'text/html');
    await storeDerived(deps, run.runId, 'qa', qa, 'application/json');

    const parsed = parseExportMarkdown(markdown.toString('utf8'));

    // --- Сопоставление блоков и провенанс результатов -----------------------
    const local = await deps.loadFrozenBlocks(run.runId);
    const match = matchBlocks(
      local,
      remote.map((block, index) => ({ ...toHashable(block, index), blockId: block.blockId })),
    );
    if (match.unmatchedLocal.length > 0) {
      // Хэши совпали, а сопоставление не сошлось — значит канонизация и
      // сопоставление разъехались. Это дефект нашей стороны, и он обязан
      // останавливать прогон, а не терять результаты молча.
      throw new RecognitionIntegrityError(
        `Совпавшие хэши, но ${match.unmatchedLocal.length} локальных блоков ` +
          'не сопоставлены с удалёнными',
      );
    }

    const localByRemoteId = new Map(
      match.matched.map((pair) => [pair.remote.blockId, pair.local.id]),
    );

    // --- Нулевой и неполный экспорт не считаются успехом --------------------
    const coverage = assessCoverage(local, parsed.blocks, localByRemoteId);
    if (coverage.foreign > 0) {
      // Хэши совпали, то есть мультимножества блоков двух сторон равны. Секция
      // блока, которого в этом множестве нет, означает, что экспорт описывает
      // НЕ тот набор, за который мы поручились. Это расхождение доказательств.
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        remoteLayoutHashAfter: remoteHash,
        reason:
          `экспорт содержит ${coverage.foreign} секций блоков, ` +
          'не принадлежащих замороженной разметке',
        counts: coverageCounts(coverage),
      });
      throw new RecognitionIntegrityError(
        `Экспорт описывает чужой набор блоков: ${coverage.foreign} секций ` +
          'не сопоставлены с замороженной разметкой',
      );
    }
    if (coverage.missing > 0 || coverage.expected === 0 || parsed.pages.length === 0) {
      // Их собственный QA-инвариант: `document.md` обязан содержать КАЖДЫЙ
      // не-STAMP блок задания. Недобор — это не «часть не распозналась» (текст
      // блока может быть и пустым, это законно и учтено отдельно), а неполный
      // документ, после которого пользователь ждал бы текста и не получил его.
      await deps.finishRun({
        runId: run.runId,
        status: 'failed',
        remoteLayoutHashAfter: remoteHash,
        reason:
          coverage.expected === 0
            ? 'замороженная разметка не содержит ни одного блока, дающего текст'
            : `экспорт покрывает ${coverage.covered} блоков из ${coverage.expected}`,
        counts: coverageCounts(coverage),
        warnings: [
          {
            code: 'export_incomplete',
            expected: coverage.expected,
            covered: coverage.covered,
            pages: parsed.pages.length,
          },
        ],
      });
      throw new ExportCoverageError(
        `Экспорт покрывает ${coverage.covered} блоков из ${coverage.expected} ` +
          `и ${parsed.pages.length} страниц: нулевой результат не считается успехом`,
      );
    }
    if (coverage.withoutText > 0) {
      // Не отказ: §9.1 прямо требует, чтобы низкое качество OCR не давало
      // `fail`. Но и не молчание — счётчик уходит в `counts`, предупреждение в
      // `warnings`, и человек видит, сколько блоков приехало пустыми.
      ctx.logger.warn(
        { event: 'recognition_blocks_without_text', blocks: coverage.withoutText },
        'часть блоков приехала из OCR без текста',
      );
    }

    const recognizedRemoteIds = parsed.blocks
      .map((block) => block.remoteBlockId)
      .filter((blockId) => localByRemoteId.has(blockId));

    let provenance: readonly RemoteBlockResult[] = [];
    try {
      provenance = await port.fetchBlockResults(recognizedRemoteIds);
    } catch (error) {
      // Провенанс — обогащение, а не результат: без него текст блока остаётся
      // верным, а `model_id`/`confidence` честно пустыми. Ронять прогон,
      // который уже дошёл до забранного экспорта, из-за него нельзя.
      ctx.logger.warn(
        { event: 'block_results_unavailable', reason: (error as Error).name },
        'провенанс результатов блоков недоступен, model_id и confidence останутся пустыми',
      );
    }
    const provenanceById = new Map(provenance.map((row) => [row.blockId, row]));

    const blocks = parsed.blocks.flatMap((block) => {
      const layoutBlockId = localByRemoteId.get(block.remoteBlockId);
      if (layoutBlockId === undefined) return [];
      const row = provenanceById.get(block.remoteBlockId);
      return [
        {
          layoutBlockId,
          resultType: row?.resultType ?? `${block.blockType}_md`,
          contentHtml: row?.ocrHtml ?? null,
          contentMd: block.contentMd,
          contentJson: row?.ocrJson ?? null,
          modelId: row?.modelId ?? null,
          confidence: row?.confidence ?? null,
        },
      ];
    });

    const saved = await deps.saveResults({
      runId: run.runId,
      artifactVersionId: mdArtifact.artifactVersionId,
      pages: parsed.pages.map((page) => ({
        workingPageIndex: page.workingPageIndex,
        textMd: page.textMd,
      })),
      blocks,
    });

    if (saved.pagesOutOfRange > 0) {
      // Отдельная причина, а не общий «пропущено»: номер страницы за пределами
      // рабочего документа означает, что экспорт описывает не тот документ,
      // который заказан, — при том что хэши блоков сошлись. Батч при этом не
      // записан вовсе, поэтому терминальный прогон не оставляет за собой
      // половину неизменяемого текста страниц.
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        remoteLayoutHashAfter: remoteHash,
        reason: `экспорт содержит ${saved.pagesOutOfRange} страниц вне рабочего документа`,
        counts: { ...coverageCounts(coverage), pagesOutOfRange: saved.pagesOutOfRange },
      });
      throw new RecognitionIntegrityError(
        `Экспорт содержит ${saved.pagesOutOfRange} страниц, которых нет в рабочем документе`,
      );
    }

    // --- Шаг 9: закрытие RD-документа (долг S6) ----------------------------
    try {
      await port.closeRunDocument(run.rdDocumentId);
    } catch (error) {
      // Проба достижимости — диагностика, а не условие закрытия: закрытие
      // фиксируется у НАС, и недоступность их API не должна оставлять документ
      // формально открытым для следующего прогона.
      ctx.logger.warn(
        { event: 'rd_close_probe_failed', reason: (error as Error).name },
        'проба достижимости RD-документа перед закрытием не удалась',
      );
    }
    const closed = await deps.closeRunDocument(run.layoutRevisionId);

    const counts = {
      archiveBytes: archive.bytes.byteLength,
      pagesWritten: saved.pagesWritten,
      pagesAlreadyPresent: saved.pagesAlreadyPresent,
      pagesOutOfRange: saved.pagesOutOfRange,
      blocksWritten: saved.blocksWritten,
      blocksAlreadyPresent: saved.blocksAlreadyPresent,
      blocksUnknown: saved.blocksUnknown,
      matchedBlocks: match.matched.length,
      redactedProvenanceLines: parsed.redactedLines,
      ...coverageCounts(coverage),
    };

    await deps.finishRun({
      runId: run.runId,
      status: 'done',
      remoteLayoutHashAfter: remoteHash,
      counts,
      warnings:
        coverage.withoutText === 0
          ? []
          : [{ code: 'blocks_without_text', blocks: coverage.withoutText }],
    });

    ctx.logger.info(
      {
        event: 'recognition_export_stored',
        artifact_sha256: archive.sha256,
        reused: archive.reused,
        run_document_closed: closed.changed,
        ...counts,
      },
      'экспорт забран, разобран и записан',
    );
    await ctx.emit('recognition.export_stored', {
      recognitionRunId: run.runId,
      ...counts,
    });

    // Переход «распознавание → анализ» при сквозном прогоне (S21). До S21 здесь
    // стояло только `ctx.emit`, а оно доставляется ЭКРАНУ и задачу не ставит:
    // цепочка обрывалась молча, и выглядело это как «распознали, а дальше
    // ничего». Ветка RD WEB получает переход наравне с VLM — иначе поведение
    // кнопки зависело бы от настройки провайдера, которую пользователь не видит.
    if (ctx.payload.autoContinue === true) {
      await ctx.enqueue({
        type: 'doc.classify_pages',
        payload: { revisionId: run.revisionId, autoContinue: true },
        dedupeKey: `doc.classify_pages:${run.revisionId}`,
      });
    }
  });
}

/**
 * Передача признака сквозного прогона следующему звену цепочки `rd.*`.
 *
 * Опускается, когда его нет, а не пишется `false`: пошаговый путь инженера не
 * должен отличаться от прежнего ни одним байтом payload.
 */
function carry(ctx: { readonly payload: { readonly autoContinue?: boolean | undefined } }): {
  autoContinue?: true;
} {
  return ctx.payload.autoContinue === true ? { autoContinue: true } : {};
}

/**
 * Отказ «экспорт не покрывает заказанное».
 *
 * Отдельный класс, а не общий `Error`: расхождение доказательств здесь нет —
 * хэши сошлись, набор блоков тот же, — но результата, ради которого стадия
 * запускалась, не получено. По `job_runs.error_class` это обязано отличаться и
 * от сетевого сбоя, и от `RecognitionIntegrityError`.
 */
export class ExportCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportCoverageError';
  }
}

interface CoverageAssessment {
  /** Сколько блоков замороженной разметки ОБЯЗАНЫ иметь секцию в экспорте. */
  readonly expected: number;
  readonly covered: number;
  readonly missing: number;
  /** Секции экспорта, не принадлежащие замороженной разметке. */
  readonly foreign: number;
  /** Секции с пустым телом: OCR законно мог не дать текста (§9.1). */
  readonly withoutText: number;
}

/**
 * Покрытие замороженной разметки экспортом.
 *
 * Ожидаемое множество — не «все блоки», а блоки НЕ типа `stamp`: их рендер
 * пропускает STAMP при обходе (`iter_markdown_blocks`), и их же собственная
 * проверка `markdown_contains_all_blocks` считается по тем же не-STAMP блокам
 * (`finalizer/service_export._export`). Это и есть тот самый «явный допуск на
 * блоки, которые OCR законно не даёт», и он один — придумывать процентный порог
 * поверх их собственного инварианта было бы ослаблением на ровном месте.
 */
function assessCoverage(
  local: readonly LocalBlock[],
  exported: readonly { readonly remoteBlockId: string; readonly contentMd: string }[],
  localByRemoteId: ReadonlyMap<string, string>,
): CoverageAssessment {
  const expected = new Set(
    local.filter((block) => block.blockType !== 'stamp').map((block) => block.id),
  );

  const covered = new Set<string>();
  let foreign = 0;
  let withoutText = 0;
  for (const section of exported) {
    const layoutBlockId = localByRemoteId.get(section.remoteBlockId);
    if (layoutBlockId === undefined) {
      foreign += 1;
      continue;
    }
    covered.add(layoutBlockId);
    if (section.contentMd.trim() === '') withoutText += 1;
  }

  const coveredExpected = [...covered].filter((id) => expected.has(id)).length;
  return {
    expected: expected.size,
    covered: coveredExpected,
    missing: expected.size - coveredExpected,
    foreign,
    withoutText,
  };
}

function coverageCounts(coverage: CoverageAssessment): Record<string, number> {
  return {
    blocksExpected: coverage.expected,
    blocksCovered: coverage.covered,
    blocksMissing: coverage.missing,
    blocksForeign: coverage.foreign,
    blocksWithoutText: coverage.withoutText,
  };
}

interface ObtainedArchive {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** `true` — байты взяты из НАШЕГО хранилища, второго забора не было. */
  readonly reused: boolean;
}

/**
 * Получение архива экспорта РОВНО ОДИН РАЗ.
 *
 * Три рубежа, и они проверяются именно в этом порядке:
 *
 * 1. строка `artifact_versions` вида `zip` — забор уже был, байты обязаны
 *    лежать у нас; их хэш сверяется с записанным (верификация artifact hash);
 * 2. объект в нашем хранилище по детерминированному ключу — забор был, но
 *    строку записать не успели: байты берутся оттуда, а не тянутся заново;
 * 3. и только теперь обращение к RD WEB.
 *
 * Без второго рубежа падение между выкладкой и записью строки означало бы
 * второй забор транзиентного экспорта — то есть, возможно, другие байты.
 */
async function obtainArchive(
  deps: RecognitionDeps,
  port: RdWebPort,
  ctx: JobContext<'rd.fetch_export_once'>,
  run: RunTarget,
): Promise<ObtainedArchive> {
  const recorded = await deps.findArtifact(run.runId, 'zip');
  if (recorded !== null) {
    const bytes = await deps.readArtifactBytes(run.runId, 'zip');
    if (bytes === null) {
      throw new RecognitionIntegrityError(
        'Артефакт экспорта записан, но объект в хранилище отсутствует: ' +
          'повторный забор запрещён §5.2',
      );
    }
    const sha256 = deps.sha256(bytes);
    if (sha256 !== recorded.artifactSha256) {
      await deps.finishRun({
        runId: run.runId,
        status: 'integrity_error',
        reason: 'хэш сохранённого архива экспорта не совпал с записанным',
      });
      throw new RecognitionIntegrityError(
        'Хэш архива экспорта в хранилище не совпал с записанным в artifact_versions',
      );
    }
    ctx.logger.info(
      { event: 'export_already_fetched', artifact_sha256: sha256 },
      'экспорт уже забран ранее, повторный запрос к RD WEB не выполняется',
    );
    return { bytes, sha256, reused: true };
  }

  const staged = await deps.readArtifactBytes(run.runId, 'zip');
  if (staged !== null) {
    const sha256 = deps.sha256(staged);
    const outcome = await deps.recordArtifact({
      runId: run.runId,
      kind: 'zip',
      artifactSha256: sha256,
      byteSize: staged.byteLength,
    });
    assertRecordedHash(outcome, sha256);
    ctx.logger.warn(
      { event: 'export_recovered_from_storage', artifact_sha256: sha256 },
      'байты экспорта нашлись в хранилище от прошлой попытки, забор не повторяется',
    );
    return { bytes: staged, sha256, reused: true };
  }

  const payload = await port.fetchExportOnce(run.rdJobId as string);
  const sha256 = deps.sha256(payload.bytes);
  await deps.writeArtifactBytes({
    runId: run.runId,
    kind: 'zip',
    bytes: payload.bytes,
    contentType: payload.contentType,
  });
  const outcome = await deps.recordArtifact({
    runId: run.runId,
    kind: 'zip',
    artifactSha256: sha256,
    byteSize: payload.bytes.byteLength,
  });
  assertRecordedHash(outcome, sha256);
  return { bytes: payload.bytes, sha256, reused: false };
}

function assertRecordedHash(
  outcome: { readonly kind: 'recorded' | 'already'; readonly artifactSha256: string },
  sha256: string,
): void {
  if (outcome.artifactSha256 !== sha256) {
    throw new RecognitionIntegrityError(
      'Артефакт того же прогона уже записан с другим хэшем: забранные байты не совпадают',
    );
  }
}

/** Производный артефакт из архива: те же три рубежа, но без обращения к RD WEB. */
async function storeDerived(
  deps: RecognitionDeps,
  runId: string,
  kind: ArtifactKind,
  bytes: Buffer,
  contentType: string,
): Promise<{ readonly artifactVersionId: string }> {
  const sha256 = deps.sha256(bytes);
  await deps.writeArtifactBytes({ runId, kind, bytes, contentType });
  const outcome = await deps.recordArtifact({
    runId,
    kind,
    artifactSha256: sha256,
    byteSize: bytes.byteLength,
  });
  assertRecordedHash(outcome, sha256);
  return { artifactVersionId: await deps.artifactId(runId, kind) };
}
