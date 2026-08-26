/**
 * Задачи 22–23 конвейера: нарезка документов и архив ревизии (§12, §13).
 *
 * ## Порядок, который здесь выражен
 *
 * §12 ставит нарезку ПОСЛЕ подтверждения границ, а архив — после согласования.
 * Между этими двумя фактами есть жёсткая связь, и она не стилистическая:
 * содержимое согласованной ревизии заперто триггерами (0008, класс `derived`),
 * то есть после approve нарезать уже нечем — запись `derived_pdf_*` будет
 * отвергнута базой. Поэтому подтверждение документа СРАЗУ ставит задачу 22, а
 * согласование требует, чтобы нарезка была готова (`approveBlockers`). Архив
 * же собирается из готовых нарезок и не пишет в ревизию ничего.
 *
 * ## Отказ обрабатывается общим правилом
 *
 * `withDeliveryTermination` — прямое следствие S7: там шесть путей отказа из
 * шести оставляли прогон незавершённым, потому что обработчик ПЕРЕЧИСЛЯЛ классы
 * ошибок. Здесь правило одно: если повтора больше не будет (последняя попытка
 * либо неповторяемая ошибка — те же два условия, по которым `JobRunner`
 * объявляет задачу мёртвой), в ленту ревизии уходит терминальное событие с
 * названной причиной. Ревизия не имеет права остаться в состоянии, о котором
 * ничего не сказано: «архива нет» и «архив не собрался, потому что …» — разные
 * вещи, и вторая обязана быть видна пользователю, а не только в `job_runs`.
 *
 * Состояние выдачи при этом НЕ хранится отдельным полем: оно вычисляется по
 * `submission_archives` и по журналу задач, как и `processing_status` (§3.8).
 * Хранимое поле «архив собирается» пришлось бы поддерживать в согласии с
 * очередью и врать при падении воркера.
 */
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import {
  classifyFailure,
  isContiguous,
  overlappingTargets,
  writeZipStream,
  type ArchivePlan,
  type ArchiveView,
  type JobContext,
  type JobHandler,
  type JobType,
  type MaterializationPlan,
  type MaterializationTarget,
  type RecordArchiveOutcome,
  type SaveDerivedOutcome,
  type ZipSourceEntry,
} from '@id/api';

/**
 * Отметка о производности (§13).
 *
 * Текст говорит две вещи, и обе обязательны: файл производный, и встроенная
 * подпись оригинала к нему не относится. Второе — единственная причина, по
 * которой §13 вообще требует отметки: нарезка внешне неотличима от оригинала.
 */
export const DERIVED_DOCUMENT_NOTE =
  'Портал ИД: производная копия документа. Подпись оригинала к копии не относится.';

/** Версия сборщика архива: смена состава обязана быть видна в `submission_archives`. */
export const ARCHIVE_BUILDER = 'archive/1';

/** Имя манифеста внутри архива. */
export const ARCHIVE_MANIFEST_ENTRY = 'manifest.json';

/**
 * Состояние, при котором работа невозможна и повтор ничего не изменит.
 *
 * `retriable = false` читает `classifyFailure()` (§12): движок задач принимает
 * решение о повторе по САМОМУ классу отказа, а не по перечислению в обработчике
 * — это правило заведено на S8 и здесь просто соблюдается.
 */
export class DeliveryStateError extends Error {
  readonly retriable = false;

  constructor(message: string) {
    super(message);
    this.name = 'DeliveryStateError';
  }
}

// =====================================================================
// Общее правило завершения
// =====================================================================

const MAX_REASON_LENGTH = 400;

type DeliveryJobType = 'doc.materialize_pdf' | 'submission.build_archive';

/**
 * Терминальное событие, когда повтора больше не будет.
 *
 * Обёртка, а не ветка в каждом обработчике: перечисление классов ошибок уже
 * один раз потеряло пять случаев из шести (S7). Обёртка не подменяет точные
 * диагнозы внутри обработчиков — она закрывает всё остальное, включая ошибки,
 * которых сегодня ещё нет.
 */
export function withDeliveryTermination<T extends DeliveryJobType>(
  handler: JobHandler<T>,
): JobHandler<T> {
  return async (ctx: JobContext<T>) => {
    try {
      await handler(ctx);
    } catch (error) {
      if (ctx.attempt < ctx.maxAttempts && !classifyFailure(error).permanent) throw error;

      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      try {
        await ctx.emit(`${eventPrefix(ctx.type)}.failed`, {
          jobType: ctx.type,
          attempt: ctx.attempt,
          errorClass: classifyFailure(error).errorClass,
          reason: `${name}: ${message}`.slice(0, MAX_REASON_LENGTH),
        });
      } catch (emitError) {
        // Отказ записи события не имеет права подменить исходную ошибку: она
        // объясняет, что случилось, а неудача записи — отдельный факт журнала.
        ctx.logger.error(
          { event: 'delivery_termination_failed', reason: (emitError as Error).name },
          'терминальное событие выдачи не записано',
        );
      }
      throw error;
    }
  };
}

function eventPrefix(type: JobType): string {
  return type === 'submission.build_archive' ? 'archive' : 'document.materialize';
}

// =====================================================================
// Задача 22: нарезка логических документов
// =====================================================================

export interface StoredDerivedPdf {
  readonly sha256: string;
  readonly byteSize: number;
  readonly s3Key: string;
}

export interface MaterializeDeps {
  readonly loadPlan: (revisionId: string) => Promise<MaterializationPlan | null>;
  /** Выкладывает рабочий PDF ревизии во временный файл потоком. */
  readonly fetchWorkingPdf: (storageKey: string, destinationPath: string) => Promise<void>;
  readonly extractPages: (input: {
    readonly sourcePath: string;
    readonly outputPath: string;
    readonly firstPageIndex: number;
    readonly lastPageIndex: number;
    readonly derivedNote: string;
  }) => Promise<{
    readonly pageCount: number;
    readonly toolkit: string;
    readonly derivedNoteApplied: boolean;
  }>;
  readonly storeDerivedPdf: (documentId: string, localPath: string) => Promise<StoredDerivedPdf>;
  readonly saveDerivedPdf: (input: {
    readonly documentId: string;
    readonly sha256: string;
    readonly byteSize: number;
    readonly pageCount: number;
    readonly toolkit: string;
    readonly noteApplied: boolean;
  }) => Promise<SaveDerivedOutcome>;
  readonly workDirBase?: string | undefined;
}

/**
 * Без `documentId` задача раскладывает ревизию на пачки по одному документу.
 *
 * Так же устроена постраничная детекция (S6): задача веера сама ничего не
 * нарезает. Причина та же — нарезка одного документа обязана падать и
 * повторяться отдельно от остальных, иначе один разрывный набор страниц лишал
 * бы нарезки весь комплект.
 */
export function createMaterializePdfHandler(
  deps: MaterializeDeps,
): JobHandler<'doc.materialize_pdf'> {
  return withDeliveryTermination(async (ctx: JobContext<'doc.materialize_pdf'>) => {
    const { revisionId, documentId } = ctx.payload;

    const plan = await deps.loadPlan(revisionId);
    if (plan === null) {
      throw new DeliveryStateError(
        `Ревизия ${revisionId} не найдена или недоступна в области видимости задачи.`,
      );
    }

    if (documentId === undefined) {
      await fanOut(ctx, plan);
      return;
    }

    const target = plan.targets.find((item) => item.documentId === documentId);
    if (target === undefined) {
      throw new DeliveryStateError(
        `Документ ${documentId} не принадлежит ревизии ${revisionId} либо не имеет ни одной страницы.`,
      );
    }
    await materializeOne(ctx, deps, plan, target);
  });
}

async function fanOut(
  ctx: JobContext<'doc.materialize_pdf'>,
  plan: MaterializationPlan,
): Promise<void> {
  const confirmed = plan.targets.filter((target) => target.isConfirmed);
  for (const target of confirmed) {
    await ctx.enqueue({
      type: 'doc.materialize_pdf',
      payload: { revisionId: plan.revisionId, documentId: target.documentId },
      // Диапазон входит в ключ: изменение границ документа — это ДРУГАЯ работа,
      // и сливать её с уже стоящей задачей нельзя.
      dedupeKey: `doc.materialize_pdf:${target.documentId}:${target.firstWorkingPageIndex}-${target.lastWorkingPageIndex}`,
    });
  }

  ctx.logger.info(
    {
      event: 'materialize_fanout',
      revision_id: plan.revisionId,
      documents: plan.targets.length,
      confirmed: confirmed.length,
    },
    'нарезка разложена по документам',
  );
  await ctx.emit('document.materialize.scheduled', {
    documents: plan.targets.length,
    confirmed: confirmed.length,
  });
}

async function materializeOne(
  ctx: JobContext<'doc.materialize_pdf'>,
  deps: MaterializeDeps,
  plan: MaterializationPlan,
  target: MaterializationTarget,
): Promise<void> {
  if (!target.isConfirmed) {
    // §12: нарезка идёт после подтверждения границ. То же держит CHECK
    // `logical_documents_derived_confirmed_chk`, поэтому отказ здесь — ранняя
    // и внятная диагностика, а не единственный рубеж.
    throw new DeliveryStateError(
      `Границы документа ${target.documentId} не подтверждены: нарезка выполняется после подтверждения.`,
    );
  }
  const overlapping = overlappingTargets(target, plan.targets);
  if (overlapping.length > 0) {
    throw new DeliveryStateError(
      `Диапазон документа ${target.documentId} ` +
        `(${target.firstWorkingPageIndex}..${target.lastWorkingPageIndex}) пересекается ` +
        `с документом ${overlapping[0]?.documentId ?? '—'}: нарезка включила бы чужие листы.`,
    );
  }
  if (plan.source === null) {
    throw new DeliveryStateError(
      `У ревизии ${plan.revisionId} нет собранного рабочего документа: нарезать нечего.`,
    );
  }
  if (target.lastWorkingPageIndex >= plan.source.pageCount) {
    throw new DeliveryStateError(
      `Документ ${target.documentId} ссылается на страницу ${target.lastWorkingPageIndex} ` +
        `рабочего документа, в котором ${plan.source.pageCount} страниц.`,
    );
  }

  /**
   * Страницы отрезка, не отнесённые ни к какому документу.
   *
   * Считается ЗДЕСЬ, а не выводится из `pageCount` внизу: там `produced` — это
   * то, что вернул qpdf, и сравнивать его надо с ожиданием, а не с ожиданием,
   * выведенным из него же. Пропуск не отказ (см. `isContiguous`), но выдача
   * получает листы, о которых портал ничего не утверждает, и молчать об этом
   * нельзя — ни в журнале, ни в ленте ревизии.
   */
  const sliceLength = target.lastWorkingPageIndex - target.firstWorkingPageIndex + 1;
  const unassignedInRange = sliceLength - target.pageCount;
  if (!isContiguous(target)) {
    ctx.logger.warn(
      {
        event: 'derived_pdf_range_has_gaps',
        document_id: target.documentId,
        first_page: target.firstWorkingPageIndex,
        last_page: target.lastWorkingPageIndex,
        assigned_pages: target.pageCount,
        unassigned_pages: unassignedInRange,
      },
      'в отрезок нарезки попадут непривязанные страницы',
    );
    await ctx.emit('document.materialize.gaps', {
      documentId: target.documentId,
      assignedPages: target.pageCount,
      unassignedPages: unassignedInRange,
    });
  }

  const startedAt = Date.now();
  const workDir = await mkdtemp(join(deps.workDirBase ?? tmpdir(), 'id-slice-'));
  try {
    const sourcePath = join(workDir, 'working.pdf');
    await deps.fetchWorkingPdf(plan.source.workingPdfKey, sourcePath);

    const outputPath = join(workDir, 'document.pdf');
    const produced = await deps.extractPages({
      sourcePath,
      outputPath,
      firstPageIndex: target.firstWorkingPageIndex,
      lastPageIndex: target.lastWorkingPageIndex,
      derivedNote: DERIVED_DOCUMENT_NOTE,
    });

    // Ожидание — длина ОТРЕЗКА, а не число привязанных страниц: при пропуске
    // внутри диапазона эти числа расходятся законно, и сравнение с `pageCount`
    // объявляло бы отказом ровно то, о чём выше уже сказано предупреждением.
    if (produced.pageCount !== sliceLength) {
      throw new DeliveryStateError(
        `Нарезка документа ${target.documentId} дала ${produced.pageCount} страниц вместо ${sliceLength}.`,
      );
    }

    // Выкладка ПЕРЕД записью строки: ключ детерминирован (`documents/{id}.pdf`),
    // поэтому повтор задачи перезаписывает тот же объект, а не плодит сироты.
    // Обратный порядок оставил бы в БД ссылку на файл, которого нет.
    const stored = await deps.storeDerivedPdf(target.documentId, outputPath);
    const outcome = await deps.saveDerivedPdf({
      documentId: target.documentId,
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      pageCount: produced.pageCount,
      toolkit: produced.toolkit,
      noteApplied: produced.derivedNoteApplied,
    });

    if (outcome.kind === 'rejected') {
      // Не отказ задачи: между постановкой и исполнением ревизию могли
      // согласовать, и это законный исход. Но и не тишина — причина уходит и в
      // журнал, и в ленту ревизии.
      ctx.logger.warn(
        {
          event: 'derived_pdf_not_written',
          document_id: target.documentId,
          reason: outcome.reason,
        },
        'нарезка выполнена, но не записана',
      );
      await ctx.emit('document.materialize.skipped', {
        documentId: target.documentId,
        reason: outcome.reason,
      });
      return;
    }

    ctx.logger.info(
      {
        event: 'derived_pdf_built',
        document_id: target.documentId,
        pages: produced.pageCount,
        size_bytes: stored.byteSize,
        toolkit: produced.toolkit,
        derived_note_applied: produced.derivedNoteApplied,
        duration_ms: Date.now() - startedAt,
      },
      'логический документ нарезан',
    );
    await ctx.emit('document.materialize.ready', {
      documentId: target.documentId,
      pageCount: produced.pageCount,
      derivedNoteApplied: produced.derivedNoteApplied,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// =====================================================================
// Задача 23: архив согласованной ревизии
// =====================================================================

export interface StoredArchive {
  readonly sha256: string;
  readonly byteSize: number;
  readonly s3Key: string;
}

export interface ArchiveDeps {
  readonly loadPlan: (revisionId: string) => Promise<ArchivePlan | null>;
  readonly findArchive: (revisionId: string) => Promise<ArchiveView | null>;
  /** Поток содержимого нарезанного документа из хранилища. */
  readonly openDocumentPdf: (documentId: string) => AsyncIterable<Uint8Array>;
  readonly storeArchive: (
    revisionId: string,
    revisionNo: number,
    localPath: string,
  ) => Promise<StoredArchive>;
  readonly recordArchive: (input: {
    readonly revisionId: string;
    readonly objectId: string;
    readonly contractorId: string;
    readonly s3Key: string;
    readonly archiveSha256: string;
    readonly byteSize: number;
    readonly entryCount: number;
    readonly builderVersion: string;
  }) => Promise<RecordArchiveOutcome>;
  readonly workDirBase?: string | undefined;
}

export function createBuildArchiveHandler(
  deps: ArchiveDeps,
): JobHandler<'submission.build_archive'> {
  return withDeliveryTermination(async (ctx: JobContext<'submission.build_archive'>) => {
    const { revisionId } = ctx.payload;

    // Первый рубеж однократности — строка в БД. Тот же порядок, что у забора
    // экспорта на S7: сначала запись, потом объект, и только потом работа.
    const existing = await deps.findArchive(revisionId);
    if (existing !== null) {
      ctx.logger.info(
        { event: 'archive_reused', revision_id: revisionId, sha256: existing.archiveSha256 },
        'архив ревизии уже собран',
      );
      await ctx.emit('archive.ready', {
        sha256: existing.archiveSha256,
        byteSize: existing.byteSize,
        entryCount: existing.entryCount,
        reused: true,
      });
      return;
    }

    const plan = await deps.loadPlan(revisionId);
    if (plan === null) {
      throw new DeliveryStateError(
        `Ревизия ${revisionId} не найдена или недоступна в области видимости задачи.`,
      );
    }
    if (plan.status !== 'approved') {
      // Тот же запрет держит триггер `submission_archives_approved_only`.
      throw new DeliveryStateError(
        `Архив собирается только у согласованной ревизии, а её статус «${plan.status}».`,
      );
    }
    if (plan.documents.length === 0) {
      throw new DeliveryStateError(
        `У ревизии ${revisionId} нет ни одного нарезанного документа: архив ничего не подтверждал бы.`,
      );
    }

    const workDir = await mkdtemp(join(deps.workDirBase ?? tmpdir(), 'id-archive-'));
    try {
      const manifest = Buffer.from(JSON.stringify(buildManifest(plan), null, 2), 'utf8');
      const entries: ZipSourceEntry[] = [
        {
          name: ARCHIVE_MANIFEST_ENTRY,
          byteLength: manifest.length,
          open: () => [manifest],
        },
        ...plan.documents.map((document, index) => ({
          name: entryNameOf(index, document.documentId),
          byteLength: byteLengthOf(plan, document.documentId),
          open: () => deps.openDocumentPdf(document.documentId),
        })),
      ];

      const archivePath = join(workDir, 'archive.zip');
      const result = await writeZipToFile(entries, archivePath);

      const stored = await deps.storeArchive(revisionId, plan.revisionNo, archivePath);
      const outcome = await deps.recordArchive({
        revisionId,
        objectId: plan.objectId,
        contractorId: plan.contractorId,
        s3Key: stored.s3Key,
        archiveSha256: stored.sha256,
        byteSize: stored.byteSize,
        entryCount: result.entryCount,
        builderVersion: ARCHIVE_BUILDER,
      });

      ctx.logger.info(
        {
          event: 'archive_built',
          revision_id: revisionId,
          entries: result.entryCount,
          size_bytes: stored.byteSize,
          created: outcome.kind === 'created',
        },
        'архив согласованной ревизии собран',
      );
      await ctx.emit('archive.ready', {
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        entryCount: result.entryCount,
        reused: outcome.kind === 'exists',
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
}

/**
 * Запись архива в файл с честным ожиданием слива.
 *
 * `write()` возвращает `false` при заполнении буфера, и игнорировать это —
 * значит держать в памяти весь архив под видом потоковой записи. Поэтому
 * ожидание `drain` обязательно, а завершение — через `finished()`: без него
 * файл может остаться недописанным к моменту, когда его начнут хэшировать.
 */
async function writeZipToFile(
  entries: readonly ZipSourceEntry[],
  path: string,
): Promise<{ readonly byteSize: number; readonly entryCount: number }> {
  const sink = createWriteStream(path);
  try {
    const result = await writeZipStream(entries, {
      write: async (chunk) => {
        if (!sink.write(chunk)) {
          await once(sink, 'drain');
        }
      },
    });
    sink.end();
    await finished(sink);
    return result;
  } catch (error) {
    sink.destroy();
    throw error;
  }
}

/** Размер нарезки берётся из БД: писателю ZIP он нужен до чтения байтов. */
function byteLengthOf(plan: ArchivePlan, documentId: string): number {
  const document = plan.documents.find((item) => item.documentId === documentId);
  if (document === undefined) {
    throw new DeliveryStateError(`Документ ${documentId} исчез из плана архива.`);
  }
  return document.byteSize;
}

/** Имя записи внутри архива: порядковый номер для человека, uuid для точности. */
export function entryNameOf(index: number, documentId: string): string {
  return `documents/${String(index + 1).padStart(3, '0')}-${documentId}.pdf`;
}

/**
 * Манифест архива.
 *
 * Он существует не для красоты: архив уезжает к заказчику и живёт отдельно от
 * портала, поэтому в нём обязано быть сказано, ЧТО именно согласовано — состав
 * поставки, хэши исходных файлов, хэши нарезок и сводка замечаний. Без него
 * содержимое архива невозможно сверить ни с чем.
 */
export function buildManifest(plan: ArchivePlan): Record<string, unknown> {
  return {
    builder: ARCHIVE_BUILDER,
    revision: {
      id: plan.revisionId,
      no: plan.revisionNo,
      status: plan.status,
      decidedAt: plan.decidedAt,
      aggregateManifestHash: plan.aggregateManifestHash,
    },
    // Ключ манифеста переименован вместе с сущностью: единица подачи — комплект
    // работы, а не поставка вообще. Архив читают глазами, и «submission» в нём
    // отсылал бы к таблице, которой больше нет.
    work: {
      id: plan.workId,
      title: plan.workTitle,
      sectionCode: plan.sectionCode,
    },
    sourceFiles: plan.sourceFiles.map((file) => ({
      fileName: file.fileName,
      sortOrder: file.sortOrder,
      sha256: file.sha256,
    })),
    documents: plan.documents.map((document, index) => ({
      entry: entryNameOf(index, document.documentId),
      id: document.documentId,
      ordinal: document.ordinal,
      title: document.title,
      docTypeCode: document.docTypeCode,
      pageCount: document.pageCount,
      sha256: document.sha256,
      // Отметка едет в манифест по той же причине, что и в метаданные PDF:
      // получатель обязан знать, что перед ним нарезка, а не оригинал.
      derivedCopy: true,
    })),
    findings: plan.findingCounts,
  };
}
