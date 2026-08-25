/**
 * Задачи 4–9 конвейера: рабочий документ в RD WEB, детекция, флаги, превью (§12).
 *
 * Обработчики написаны на портах (`MarkupDeps`), а связывание с базой,
 * хранилищем и адаптером RD WEB живёт в `pipeline.ts`. Разделение то же, что у
 * задач 1–3, и по той же причине: обработчик, знающий про Drizzle, невозможно
 * прогнать иначе как на настоящей базе, а порт, никем не связанный с
 * реализацией, — это мёртвый код при зелёных тестах (урок S3).
 *
 * ## Почему `rd.create_run_document` делает и загрузку тоже
 *
 * Легаси-API связывает создание документа и приём байтов одним талоном:
 * `upload/init` создаёт строку документа И выдаёт presigned PUT, а повторный
 * `init` создаёт ВТОРОЙ документ. Талон при этом — секрет (§11 относит
 * presigned URL к значениям, подлежащим redaction), и класть его в
 * `jobs.payload`, то есть в БД без срока хранения, нельзя. Пересечь границу
 * задачи ему нечем, поэтому `init → PUT → complete` выполняется одной задачей.
 *
 * ## Почему строка `rd_run_documents` пишется ДО выкладки байтов
 *
 * Порядок здесь — не стиль, а единственная защита от «пяти документов, о
 * которых никто не знает». Наша строка — это ЕДИНСТВЕННЫЙ след того, что на их
 * стороне заведён документ: повторно выдать талон их API не умеет, найти
 * документ по нашему идентификатору нечем. Запись строки последней означала бы,
 * что падение между `init` и `complete` не оставляет следа вовсе, защита
 * `findRunDocument() !== null` на повторе не срабатывает, и каждая из пяти
 * попыток заводит новый документ и везёт 86 МБ заново.
 *
 * Поэтому строка пишется сразу после `init` — когда `document_id` уже
 * существует. Следствие честно закрывает задача 5: документ есть, а байтов у
 * него может не быть. `rd.upload_working_pdf` различает эти состояния и, найдя
 * документ без принятых байтов, ИМЕНУЕТ брошенный документ в журнале
 * (`rd_run_document_orphaned`), заводит новый и ОБНОВЛЯЕТ ту же строку — вторую
 * вставить всё равно не даст `layout_revision_id UNIQUE`. Требование разнести
 * создание и приём байтов двумя независимыми вызовами — пункт техзадания S13.
 */
import type { AttentionFlag, BlockType, ShapeType } from '@id/contracts';
import type { JobContext, JobHandler } from '@id/api';
import {
  analyzePages,
  JobDeferredError,
  RdWebError,
  type AnalyzedPage,
  type DetectedBlockInput,
  type LayoutThresholds,
  type PageAnalysis,
  type RdWebPort,
  type RemoteBlock,
} from '@id/api';

/** Ревизия разметки в объёме, нужном задачам конвейера. */
export interface MarkupTarget {
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
}

export interface RunDocumentRef {
  readonly rdDocumentId: string;
  readonly rdProjectId: string;
  readonly closed: boolean;
}

export interface PageBlocksSnapshot {
  readonly workingPageIndex: number;
  readonly sourcePageId: string;
  readonly blocks: readonly {
    readonly blockType: BlockType;
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  }[];
}

export interface MarkupDeps {
  /**
   * Адаптер RD WEB или `null`, если интеграция не настроена.
   *
   * `null` — не повод молча пропускать работу: задача обязана упасть с внятной
   * причиной, иначе «разметка не появилась» будет выглядеть как зависание.
   */
  readonly rdweb: RdWebPort | null;
  /** Проект RD WEB, которым владеет портал (§5.1, allowlist). */
  readonly rdProjectId: string | null;
  /** Кэшировать ли превью страниц (`PREVIEW_MODE=cached`, §7.1). */
  readonly previewCached: boolean;

  loadTargetByLayout(input: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
  }): Promise<MarkupTarget | null>;

  findRunDocument(layoutRevisionId: string): Promise<RunDocumentRef | null>;
  saveRunDocument(input: {
    readonly layoutRevisionId: string;
    readonly revisionId: string;
    readonly rdDocumentId: string;
    readonly rdProjectId: string;
  }): Promise<void>;
  /**
   * Замена брошенного RD-документа новым в ТОЙ ЖЕ строке.
   *
   * Не вставка второй строки: `rd_run_documents.layout_revision_id` уникален, и
   * двух документов на одну ревизию разметки быть не должно по определению —
   * иначе «какой из них распознавали» становится неотвечаемым вопросом.
   */
  replaceRunDocument(input: {
    readonly layoutRevisionId: string;
    readonly revisionId: string;
    readonly rdDocumentId: string;
    readonly rdProjectId: string;
  }): Promise<void>;

  openWorkingPdf(key: string): Promise<{
    readonly stream: () => NodeJS.ReadableStream;
    readonly sizeBytes: number;
  }>;

  importBlocks(input: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
    readonly workingPageIndices: readonly number[];
    readonly blocks: readonly DetectedBlockInput[];
  }): Promise<{ readonly imported: number; readonly skippedPages: readonly number[] }>;

  loadPageBlocks(input: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
  }): Promise<readonly PageBlocksSnapshot[]>;

  saveFlags(input: {
    readonly revisionId: string;
    readonly flags: ReadonlyMap<string, readonly AttentionFlag[]>;
  }): Promise<{ readonly written: boolean; readonly reason?: string }>;

  storePreview(input: {
    readonly bundleId: string;
    readonly workingPageIndex: number;
    readonly bytes: Uint8Array;
  }): Promise<void>;
}

/** Отказ конвейера, у которого причина в конфигурации, а не во внешнем сервисе. */
export class MarkupConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkupConfigurationError';
  }
}

export class MarkupStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkupStateError';
  }
}

function requirePort(deps: MarkupDeps): RdWebPort {
  if (deps.rdweb === null || deps.rdProjectId === null) {
    throw new MarkupConfigurationError(
      'Интеграция RD WEB не настроена: задайте RDWEB_BASE_URL, RDWEB_USER, ' +
        'RDWEB_PASSWORD и RDWEB_PROJECT_ALLOWLIST',
    );
  }
  return deps.rdweb;
}

/**
 * Цель задачи разметки по ЯВНОМУ идентификатору ревизии разметки.
 *
 * Не «текущий черновик этого bundle»: черновик у поставки один, но за её жизнь
 * их сменяется несколько, и задача, поставленная для ревизии №1 и выполненная
 * после её заморозки, отработала бы по №2. Сверка `bundleId` здесь — не
 * формальность: payload с чужим рабочим документом означает, что координаты
 * легли бы на другую карту страниц.
 */
async function loadMarkupTarget(
  deps: MarkupDeps,
  payload: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
    readonly bundleId: string;
  },
): Promise<MarkupTarget> {
  const target = await deps.loadTargetByLayout({
    revisionId: payload.revisionId,
    layoutRevisionId: payload.layoutRevisionId,
  });
  if (target === null) {
    throw new MarkupStateError(
      'Ревизия разметки не найдена: цепочка разметки начинается с ' + 'POST /revisions/{id}/layout',
    );
  }
  if (target.bundleId !== payload.bundleId) {
    throw new MarkupStateError(
      `Ревизия разметки собрана по рабочему документу ${target.bundleId}, ` +
        `а задача поставлена для ${payload.bundleId}`,
    );
  }
  return target;
}

/**
 * Размер пачки страниц синхронной детекции (§5.2, шаг 3).
 *
 * Совпадает с потолком адаптера. Здесь он нужен для фан-аута: одна задача = одна
 * пачка, поэтому падение на 47-й странице не переигрывает первые сорок шесть.
 */
export const DETECT_PAGE_BATCH = 8;

// =====================================================================
// Задача 4: создание RD-документа и загрузка рабочего PDF
// =====================================================================

export function createRunDocumentHandler(deps: MarkupDeps): JobHandler<'rd.create_run_document'> {
  return async (ctx: JobContext<'rd.create_run_document'>) => {
    const port = requirePort(deps);
    const projectId = deps.rdProjectId as string;

    const target = await loadMarkupTarget(deps, ctx.payload);

    const existing = await deps.findRunDocument(target.layoutRevisionId);
    if (existing !== null) {
      // Документ уже заведён: повторный `init` создал бы ВТОРОЙ документ на их
      // стороне и второй заезд 86 МБ. Идемпотентность здесь — не оптимизация.
      ctx.logger.info(
        { event: 'rd_run_document_exists', rd_document_id: existing.rdDocumentId },
        'RD-документ прогона уже создан',
      );
      await enqueueUploadCheck(ctx, target);
      return;
    }

    const { nodeId } = await port.ensureNode({
      projectId,
      // Имя папки прогона — идентификатор ревизии, а не название объекта или
      // подрядчика: имя видно людям на стороне RD WEB (§13, тот же принцип, что
      // у ключей хранилища).
      name: `portal-revision-${target.revisionId}`,
    });

    const created = await port.createRunDocument({
      projectId,
      nodeId,
      // Имя файла на их стороне — хэш рабочего документа: и уникально, и ничего
      // не рассказывает о стройке.
      fileName: `${target.workingPdfSha256}.pdf`,
      projectVersion: `layout-${target.layoutRevisionId}`,
      sizeBytes: target.workingPdfSizeBytes,
    });

    // Строка пишется ЗДЕСЬ, до единого байта выкладки: с этой секунды документ
    // на их стороне существует, и единственный способ когда-нибудь его найти —
    // наша запись. См. заголовок файла и ADR-0004 §2.
    await deps.saveRunDocument({
      layoutRevisionId: target.layoutRevisionId,
      revisionId: target.revisionId,
      rdDocumentId: created.documentId,
      rdProjectId: projectId,
    });

    const object = await deps.openWorkingPdf(target.workingPdfKey);
    await port.uploadWorkingPdf({
      documentId: created.documentId,
      uploadUrl: created.uploadUrl,
      uploadHeaders: created.uploadHeaders,
      body: () => object.stream() as never,
      sizeBytes: object.sizeBytes,
    });

    ctx.logger.info(
      {
        event: 'rd_run_document_created',
        rd_document_id: created.documentId,
        size_bytes: object.sizeBytes,
      },
      'рабочий документ отправлен в RD WEB',
    );
    await enqueueUploadCheck(ctx, target);
  };
}

async function enqueueUploadCheck(
  ctx: JobContext<'rd.create_run_document'>,
  target: MarkupTarget,
): Promise<void> {
  await ctx.enqueue({
    type: 'rd.upload_working_pdf',
    payload: {
      revisionId: target.revisionId,
      bundleId: target.bundleId,
      layoutRevisionId: target.layoutRevisionId,
    },
    dedupeKey: `rd.upload_working_pdf:${target.layoutRevisionId}`,
  });
}

// =====================================================================
// Задача 5: подтверждение, что байты приняты
// =====================================================================

/**
 * Состояния удалённого документа, означающие «байтов у документа НЕТ».
 *
 * `uploaded` — это ровно результат `upload/init`: строка документа заведена,
 * талон выдан, `complete` не выполнялся. Именно так выглядит документ, брошенный
 * падением задачи 4 между `init` и `complete`. `error` — их собственный отказ по
 * содержимому. Всё остальное (`rendering`, `ready`, любой их будущий статус)
 * считается принятым: объявлять документ брошенным по незнакомому статусу
 * значило бы заводить новый на ровном месте и везти 86 МБ второй раз.
 */
const REMOTE_STATUS_WITHOUT_BYTES = new Set(['uploaded', 'error']);

export function createUploadWorkingPdfHandler(
  deps: MarkupDeps,
): JobHandler<'rd.upload_working_pdf'> {
  return async (ctx: JobContext<'rd.upload_working_pdf'>) => {
    const port = requirePort(deps);
    const projectId = deps.rdProjectId as string;
    const target = await loadMarkupTarget(deps, ctx.payload);

    const runDocument = await deps.findRunDocument(target.layoutRevisionId);
    if (runDocument === null) {
      throw new MarkupStateError(
        'RD-документ прогона не создан: задача rd.create_run_document не отработала',
      );
    }

    // Проверяется ФАКТ на их стороне, а не наша запись: задача 4 могла упасть
    // между PUT и complete, и тогда строка у нас есть, а байтов у документа нет.
    const status = await probeRemoteStatus(port, runDocument.rdDocumentId);
    if (!REMOTE_STATUS_WITHOUT_BYTES.has(status)) {
      ctx.logger.info(
        {
          event: 'rd_upload_verified',
          rd_document_id: runDocument.rdDocumentId,
          remote_status: status,
        },
        'рабочий документ принят RD WEB',
      );
      await enqueueWaitPages(ctx, target);
      return;
    }

    // Байтов нет, а повторно выдать талон их API не умеет (ADR-0004 §2).
    // Единственный путь вперёд — новый документ. Брошенный называется в журнале
    // ИМЕНЕМ: иначе он остаётся на их стороне навсегда и найти его нечем.
    ctx.logger.warn(
      {
        event: 'rd_run_document_orphaned',
        rd_document_id: runDocument.rdDocumentId,
        rd_project_id: runDocument.rdProjectId,
        remote_status: status,
      },
      'RD-документ прогона брошен без принятых байтов, заводится новый',
    );

    const { nodeId } = await port.ensureNode({
      projectId,
      name: `portal-revision-${target.revisionId}`,
    });
    const created = await port.createRunDocument({
      projectId,
      nodeId,
      fileName: `${target.workingPdfSha256}.pdf`,
      projectVersion: `layout-${target.layoutRevisionId}`,
      sizeBytes: target.workingPdfSizeBytes,
    });

    // Строка обновляется ДО выкладки — по той же причине, по которой задача 4
    // пишет её до выкладки: следующая попытка обязана найти новый документ, а не
    // завести третий.
    await deps.replaceRunDocument({
      layoutRevisionId: target.layoutRevisionId,
      revisionId: target.revisionId,
      rdDocumentId: created.documentId,
      rdProjectId: projectId,
    });

    const object = await deps.openWorkingPdf(target.workingPdfKey);
    await port.uploadWorkingPdf({
      documentId: created.documentId,
      uploadUrl: created.uploadUrl,
      uploadHeaders: created.uploadHeaders,
      body: () => object.stream() as never,
      sizeBytes: object.sizeBytes,
    });

    const retried = await probeRemoteStatus(port, created.documentId);
    if (REMOTE_STATUS_WITHOUT_BYTES.has(retried)) {
      throw new RdWebError(`RD WEB не принял рабочий документ повторно (status=${retried})`, {
        operation: 'upload_verify',
      });
    }

    ctx.logger.info(
      {
        event: 'rd_upload_verified',
        rd_document_id: created.documentId,
        remote_status: retried,
        replaced: true,
      },
      'рабочий документ принят RD WEB после замены брошенного документа',
    );
    await enqueueWaitPages(ctx, target);
  };
}

/**
 * Статус удалённого документа; исчезнувший документ — это тоже «байтов нет».
 *
 * 404 здесь равносилен брошенному документу: продолжать по идентификатору,
 * которого у них уже нет, невозможно, а падать пять раз подряд бессмысленно.
 */
async function probeRemoteStatus(port: RdWebPort, documentId: string): Promise<string> {
  try {
    const { document } = await port.waitPages(documentId);
    return document.status;
  } catch (error) {
    if (error instanceof RdWebError && error.status === 404) return 'error';
    throw error;
  }
}

async function enqueueWaitPages(
  ctx: JobContext<'rd.upload_working_pdf'>,
  target: MarkupTarget,
): Promise<void> {
  await ctx.enqueue({
    type: 'rd.wait_pages',
    payload: {
      revisionId: target.revisionId,
      bundleId: target.bundleId,
      layoutRevisionId: target.layoutRevisionId,
    },
    dedupeKey: `rd.wait_pages:${target.layoutRevisionId}`,
  });
}

// =====================================================================
// Задача 6: ожидание рендера страниц
// =====================================================================

export interface WaitPagesOptions {
  /** Сколько опросов делает одна попытка задачи. */
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

/**
 * Поллинг рендера (§6.1, подстадия «Рендер страниц»).
 *
 * Опрос идёт короткими сериями внутри попытки, а не одним долгим ожиданием: 83
 * страницы рендерятся минутами, и задача, спящая всё это время, держала бы
 * аренду и соединение. Не дождавшись за серию, задача честно падает и уходит на
 * повтор — тогда прогресс виден в `job_runs`, а число попыток (30, §12)
 * ограничивает ожидание сверху.
 */
export function createWaitPagesHandler(
  deps: MarkupDeps,
  options: WaitPagesOptions = {},
): JobHandler<'rd.wait_pages'> {
  const polls = options.pollsPerAttempt ?? 5;
  const interval = options.pollIntervalMs ?? 3_000;
  const sleep = options.sleep ?? defaultSleep;

  return async (ctx: JobContext<'rd.wait_pages'>) => {
    const port = requirePort(deps);
    const target = await loadMarkupTarget(deps, ctx.payload);

    const runDocument = await deps.findRunDocument(target.layoutRevisionId);
    if (runDocument === null) throw new MarkupStateError('RD-документ прогона не создан');

    for (let poll = 0; poll < polls; poll += 1) {
      if (poll > 0) await sleep(interval, ctx.signal);
      const { ready, document } = await port.waitPages(runDocument.rdDocumentId);
      if (!ready) continue;

      // Число страниц обязано совпасть с картой рабочего документа: расхождение
      // означает, что их рендер видит не тот файл, который мы собрали, и
      // координаты легли бы на чужие страницы.
      if (document.pages.length !== target.pageIndices.length) {
        throw new MarkupStateError(
          `RD WEB отрендерил ${document.pages.length} страниц, ` +
            `в рабочем документе их ${target.pageIndices.length}`,
        );
      }

      await ctx.emit('layout.pages_ready', {
        layoutRevisionId: target.layoutRevisionId,
        pages: document.pages.length,
      });

      // Фан-аут детекции: без `pageIndices` задача разложит комплект на пачки.
      await ctx.enqueue({
        type: 'layout.detect_pages',
        payload: {
          revisionId: target.revisionId,
          layoutRevisionId: target.layoutRevisionId,
        },
        dedupeKey: `layout.detect_pages:${target.layoutRevisionId}:fanout`,
      });
      return;
    }

    // Отсрочка, а не отказ: рендер идёт, спрашиваем снова. Прежний `RdWebError`
    // писал каждую проверку исходом `failed`, и ожидание рендера выглядело в
    // сводке обработки как серия отказов внешнего сервиса.
    throw new JobDeferredError('RD WEB ещё не отрендерил страницы рабочего документа');
  };
}

// =====================================================================
// Задача 7: синхронная постраничная детекция
// =====================================================================

/** Разбиение списка страниц на пачки фиксированного размера. */
export function splitBatches(
  pages: readonly number[],
  size: number = DETECT_PAGE_BATCH,
): readonly (readonly number[])[] {
  const ordered = [...new Set(pages)].sort((a, b) => a - b);
  const batches: number[][] = [];
  for (let offset = 0; offset < ordered.length; offset += size) {
    batches.push(ordered.slice(offset, offset + size));
  }
  return batches;
}

/**
 * Импортируемый блок из ответа RD WEB.
 *
 * `sortOrder` берётся их значением, если оно есть, и порядком в ответе иначе:
 * он задаёт порядок чтения, и потерять его значит получить md, в котором абзацы
 * идут не в том порядке, что на листе.
 */
function toDetectedBlock(block: RemoteBlock, fallbackOrder: number): DetectedBlockInput {
  const [x0, y0, x1, y1] = block.coordsNorm;
  return {
    workingPageIndex: block.pageIndex,
    blockType: block.blockType as BlockType,
    shapeType: block.shapeType as ShapeType,
    x0,
    y0,
    x1,
    y1,
    sortOrder: block.sortOrder ?? fallbackOrder,
    points: (block.polygonPoints ?? []).map((point) => ({ x: point[0], y: point[1] })),
  };
}

export function createDetectPagesHandler(deps: MarkupDeps): JobHandler<'layout.detect_pages'> {
  return async (ctx: JobContext<'layout.detect_pages'>) => {
    const port = requirePort(deps);
    const target = await deps.loadTargetByLayout({
      revisionId: ctx.payload.revisionId,
      layoutRevisionId: ctx.payload.layoutRevisionId,
    });
    if (target === null) throw new MarkupStateError('Ревизия разметки не найдена');
    if (target.state !== 'draft') {
      // «Опоздал, уже не нужно», а не отказ — разбор в `local-detection.ts`.
      ctx.logger.info(
        {
          event: 'detection_batch_obsolete',
          layout_revision_id: target.layoutRevisionId,
          layout_state: target.state,
          pages: ctx.payload.pageIndices?.length ?? 0,
        },
        'разметка уже не черновик: пачка детекции устарела и пропущена',
      );
      return;
    }

    const runDocument = await deps.findRunDocument(target.layoutRevisionId);
    if (runDocument === null) throw new MarkupStateError('RD-документ прогона не создан');

    const overwriteExisting = ctx.payload.overwriteExisting === true;

    // Без списка страниц задача работает фан-аутом: раскладывает комплект на
    // пачки и ставит по задаче на каждую. Сама она при этом ничего не
    // детектирует — иначе первая же пачка выполнялась бы дважды.
    if (ctx.payload.pageIndices === undefined) {
      const batches = splitBatches(target.pageIndices);
      for (const batch of batches) {
        await ctx.enqueue({
          type: 'layout.detect_pages',
          payload: {
            revisionId: target.revisionId,
            layoutRevisionId: target.layoutRevisionId,
            pageIndices: [...batch],
            // Флаг перезаписи наследуется дочерними пачками: иначе явная
            // переразметка комплекта превратилась бы в обычную детекцию.
            ...(overwriteExisting ? { overwriteExisting: true } : {}),
          },
          dedupeKey:
            `layout.detect_pages:${target.layoutRevisionId}:` +
            `${String(batch[0])}-${String(batch[batch.length - 1])}` +
            (overwriteExisting ? ':overwrite' : ''),
        });
      }
      ctx.logger.info(
        {
          event: 'detect_fanout',
          batches: batches.length,
          pages: target.pageIndices.length,
          overwrite_existing: overwriteExisting,
        },
        'детекция разложена на пачки',
      );
      return;
    }

    const requestedPages = new Set(ctx.payload.pageIndices);
    const result = await port.detectPages({
      documentId: runDocument.rdDocumentId,
      pageIndices: ctx.payload.pageIndices,
      ...(overwriteExisting ? { overwriteExisting: true } : {}),
    });

    // Блок со страницей, которой мы не запрашивали, — это не «детектор ничего не
    // нашёл», а внешняя система, ответившая мимо запроса. Молча отбросить такие
    // блоки значило бы сделать эти два случая неразличимыми: задача succeeded,
    // блоков ноль. Прогон останавливается — по той же причине и тем же способом,
    // что расхождение числа отрендеренных страниц в `rd.wait_pages`.
    const foreign = result.created.filter((block) => !requestedPages.has(block.pageIndex));
    if (foreign.length > 0) {
      const pages = [...new Set(foreign.map((block) => block.pageIndex))].sort((a, b) => a - b);
      ctx.logger.error(
        {
          event: 'detect_foreign_pages',
          blocks: foreign.length,
          pages,
          requested: [...ctx.payload.pageIndices],
        },
        'RD WEB вернул блоки страниц, которых пачка не запрашивала',
      );
      throw new MarkupStateError(
        `RD WEB вернул ${foreign.length} блок(ов) страниц ${pages.join(', ')} ` +
          `в ответ на пачку ${ctx.payload.pageIndices.join(', ')}`,
      );
    }

    // Страница, которую удалённая сторона отказалась переразмечать, приходит в
    // `skipped_pages` и НЕ содержит ни одного блока в `created`. Импортировать
    // такую пачку как есть значило бы удалить наши авто-блоки этих страниц,
    // ничего не вставив взамен: было четыре блока — стало ноль, задача
    // succeeded. Поэтому замена всегда происходит на равное: у пропущенных
    // страниц забирается их СУЩЕСТВУЮЩИЙ удалённый набор. Побочный полезный
    // эффект — повтор задачи после сбоя импорта восстанавливает пачку, а не
    // теряет её.
    const remoteSkipped = [...new Set(result.skippedPages)]
      .filter((page) => requestedPages.has(page))
      .sort((a, b) => a - b);

    let recovered: readonly RemoteBlock[] = [];
    if (remoteSkipped.length > 0) {
      const skipped = new Set(remoteSkipped);
      const all = await port.listBlocks(runDocument.rdDocumentId);
      recovered = all.filter((block) => skipped.has(block.pageIndex));
    }

    // Страница, у которой блоков нет и на их стороне, в список удаления не
    // попадает вовсе: удалять нечего, а замены нет.
    const recoveredPages = new Set(recovered.map((block) => block.pageIndex));
    const emptySkipped = new Set(remoteSkipped.filter((page) => !recoveredPages.has(page)));
    const importPages = ctx.payload.pageIndices.filter((page) => !emptySkipped.has(page));

    const perPageOrder = new Map<number, number>();
    const blocks = [...result.created, ...recovered].map((block) => {
      const next = perPageOrder.get(block.pageIndex) ?? 0;
      perPageOrder.set(block.pageIndex, next + 1);
      return toDetectedBlock(block, next);
    });

    const imported = await deps.importBlocks({
      revisionId: target.revisionId,
      layoutRevisionId: target.layoutRevisionId,
      workingPageIndices: importPages,
      blocks,
    });

    if (result.warnings.length > 0) {
      ctx.logger.warn(
        { event: 'detect_warnings', count: result.warnings.length },
        'детекция вернула предупреждения',
      );
    }

    ctx.logger.info(
      {
        event: 'detect_batch_done',
        pages: ctx.payload.pageIndices.length,
        imported: imported.imported,
        overwrite_existing: overwriteExisting,
        skipped_remote: remoteSkipped.length,
        recovered_blocks: recovered.length,
        untouched_pages: [...emptySkipped],
        skipped_local: imported.skippedPages.length,
      },
      'пачка страниц размечена',
    );

    // Анализ покрытия ставится ПОСЛЕ каждой пачки с общим ключом дедупликации:
    // он считает флаги по всему комплекту и идемпотентен, поэтому лишний запуск
    // безвреден, а пропущенный — нет.
    await ctx.enqueue({
      type: 'layout.analyze_coverage',
      payload: {
        revisionId: target.revisionId,
        layoutRevisionId: target.layoutRevisionId,
      },
      dedupeKey: `layout.analyze_coverage:${target.layoutRevisionId}`,
      runAfterMs: 1_000,
    });
  };
}

// =====================================================================
// Задача 8: анализ покрытия и флаги внимания
// =====================================================================

export function createAnalyzeCoverageHandler(
  deps: MarkupDeps,
): JobHandler<'layout.analyze_coverage'> {
  return async (ctx: JobContext<'layout.analyze_coverage'>) => {
    const target = await deps.loadTargetByLayout({
      revisionId: ctx.payload.revisionId,
      layoutRevisionId: ctx.payload.layoutRevisionId,
    });
    if (target === null) throw new MarkupStateError('Ревизия разметки не найдена');

    const snapshots = await deps.loadPageBlocks({
      revisionId: target.revisionId,
      layoutRevisionId: target.layoutRevisionId,
    });

    const pages: AnalyzedPage[] = snapshots.map((page) => ({
      workingPageIndex: page.workingPageIndex,
      blocks: page.blocks.map((block) => ({
        blockType: block.blockType,
        x0: block.x0,
        y0: block.y0,
        x1: block.x1,
        y1: block.y1,
      })),
    }));

    const analysis = analyzePages(pages, target.thresholds);
    const byPage = new Map(snapshots.map((page) => [page.workingPageIndex, page.sourcePageId]));

    const flags = new Map<string, readonly AttentionFlag[]>();
    for (const page of analysis) {
      const sourcePageId = byPage.get(page.workingPageIndex);
      if (sourcePageId !== undefined) flags.set(sourcePageId, page.flags);
    }

    const outcome = await deps.saveFlags({ revisionId: target.revisionId, flags });

    const summary = summarizeAnalysis(analysis);
    await ctx.emit('layout.coverage_analyzed', {
      layoutRevisionId: target.layoutRevisionId,
      pages: summary.pages,
      flaggedPages: summary.flagged,
      byFlag: summary.byFlag,
      layoutProfileVersion: target.layoutProfileVersion,
      flagsWritten: outcome.written,
      // Полностраничный блок НЕ добавлен ни на одну страницу: замена страницы
      // одним блоком — явное действие пользователя (§5.3).
      fullPagePatchApplied: false,
    });

    ctx.logger.info(
      {
        event: 'coverage_analyzed',
        pages: summary.pages,
        flagged_pages: summary.flagged,
        // Разбивка по флагам: «флагов 12» и «двенадцать раз tiny_block» — разные
        // диагнозы, и по сводке в консоли задач это должно быть видно сразу.
        by_flag: summary.byFlag,
        flags_written: outcome.written,
        flags_skip_reason: outcome.reason ?? null,
        layout_profile_version: target.layoutProfileVersion,
      },
      'флаги внимания рассчитаны',
    );

    if (deps.previewCached) {
      await ctx.enqueue({
        type: 'preview.cache_pages',
        payload: {
          revisionId: target.revisionId,
          bundleId: target.bundleId,
          layoutRevisionId: target.layoutRevisionId,
        },
        dedupeKey: `preview.cache_pages:${target.layoutRevisionId}`,
      });
    }
  };
}

/**
 * Сводка анализа: сколько страниц, сколько флагованных и сколько раз какой флаг.
 *
 * Считается по тому же набору, что уходит в `source_pages`, и попадает и в
 * журнал, и в событие ревизии: «флагов 12» без разбивки не отличает двенадцать
 * пустых страниц от двенадцати маленьких блоков, а решения это разные.
 */
export function summarizeAnalysis(analysis: readonly PageAnalysis[]): {
  readonly pages: number;
  readonly flagged: number;
  readonly byFlag: Readonly<Record<string, number>>;
} {
  const byFlag: Record<string, number> = {};
  for (const page of analysis) {
    for (const flag of page.flags) byFlag[flag] = (byFlag[flag] ?? 0) + 1;
  }
  return {
    pages: analysis.length,
    flagged: analysis.filter((page) => page.flags.length > 0).length,
    byFlag,
  };
}

// =====================================================================
// Задача 9: кэш превью страниц
// =====================================================================

/**
 * Кэш превью (§12, задача 9) — только при `PREVIEW_MODE=cached`.
 *
 * По умолчанию портал рендерит страницы в браузере через pdf.js (§7.1), и эта
 * задача не ставится вовсе. При `cached` превью берутся у RD WEB и кладутся в
 * наше хранилище как есть: пережатие в два webp-тира требует `sharp` — нативной
 * зависимости, которую незачем тащить в образ ради выключенного по умолчанию
 * режима. Это зафиксированный долг, а не забытая строка: ключ уже разведён по
 * тирам (`previewPageKey`), и добавление пережатия не меняет ни адресацию, ни
 * контракт задачи.
 */
export function createPreviewCacheHandler(deps: MarkupDeps): JobHandler<'preview.cache_pages'> {
  return async (ctx: JobContext<'preview.cache_pages'>) => {
    if (!deps.previewCached) {
      ctx.logger.info(
        { event: 'preview_cache_skipped' },
        'PREVIEW_MODE=pdfjs: кэш превью не нужен',
      );
      return;
    }
    const port = requirePort(deps);
    const target = await loadMarkupTarget(deps, ctx.payload);

    const runDocument = await deps.findRunDocument(target.layoutRevisionId);
    if (runDocument === null) throw new MarkupStateError('RD-документ прогона не создан');

    let stored = 0;
    for (const workingPageIndex of target.pageIndices) {
      if (ctx.signal.aborted) break;
      const bytes = await port.fetchPagePreview(runDocument.rdDocumentId, workingPageIndex);
      await deps.storePreview({ bundleId: target.bundleId, workingPageIndex, bytes });
      stored += 1;
    }

    ctx.logger.info({ event: 'preview_cached', pages: stored }, 'превью страниц закэшированы');
  };
}
