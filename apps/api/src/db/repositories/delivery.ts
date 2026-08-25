/**
 * Выдача: нарезка логических документов и архив ревизии (§12 задачи 22–23, §13).
 *
 * ## Почему нарезка адресуется рабочим документом, а не оригиналами
 *
 * Логический документ — это набор страниц РЕВИЗИИ, и он свободно пересекает
 * границу исходных файлов (§0.2, «документ, пересекающий границу файлов»).
 * Нарезать его из оригиналов значило бы склеивать куски нескольких файлов,
 * то есть выполнять ту же работу, которую уже сделала сборка рабочего
 * документа. Поэтому источник нарезки — working PDF, а диапазон берётся из
 * карты `processing_bundle_pages`, которая и существует ради этого отображения.
 *
 * ## Непрерывность диапазона — предусловие, а не допущение
 *
 * `qpdf --pages src A-B` вырезает ОДИН отрезок. Сегментация отрезки и строит:
 * документ — это последовательные страницы комплекта. Но ручное переназначение
 * страницы (экран «Документы», §14) способно сделать набор разрывным, и тогда
 * нарезка по min..max молча включила бы чужие страницы. Поэтому разрывность
 * проверяется и является отказом с названной причиной: молча выдать подрядчику
 * PDF с чужим листом хуже, чем не выдать никакого.
 */
import { asc, eq, sql } from 'drizzle-orm';
import {
  findings,
  logicalDocuments,
  pageAssignments,
  processingBundlePages,
  processingBundles,
  sourceFiles,
  storedBlobs,
  submissionArchives,
  submissionRevisions,
  works,
} from '@id/db';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, notFound } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { LATEST_VALIDATION_RUN } from './checks.js';
import type { Database } from './users.js';

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

// =====================================================================
// Задача 22: что и из чего нарезать
// =====================================================================

/** Рабочий документ ревизии — источник нарезки. */
export interface MaterializationSource {
  readonly bundleId: string;
  readonly workingPdfSha256: string;
  readonly workingPdfKey: string;
  readonly workingPdfBytes: number;
  readonly pageCount: number;
}

export interface MaterializationTarget {
  readonly documentId: string;
  readonly revisionId: string;
  readonly ordinal: number;
  readonly docTypeCode: string | null;
  readonly isConfirmed: boolean;
  /** Уже нарезан: повтор задачи не обязан делать работу заново. */
  readonly derivedPdfSha256: string | null;
  readonly firstWorkingPageIndex: number;
  readonly lastWorkingPageIndex: number;
  readonly pageCount: number;
}

export interface MaterializationPlan {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly status: string;
  readonly source: MaterializationSource | null;
  readonly targets: readonly MaterializationTarget[];
}

/**
 * План нарезки ревизии: рабочий документ и подтверждённые документы с их
 * диапазонами страниц.
 *
 * Берётся ПОСЛЕДНИЙ собранный рабочий документ ревизии — тот же, по которому
 * шла разметка. У ревизии он один: `processing_bundles` заперт с момента submit,
 * а до submit пересборка меняет строку только вместе с составом.
 */
export async function loadMaterializationPlan(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<MaterializationPlan | null> {
  const revisions = await db
    .select({
      id: submissionRevisions.id,
      revisionNo: submissionRevisions.revisionNo,
      status: submissionRevisions.status,
    })
    .from(submissionRevisions)
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.id, revisionId)))
    .limit(1);

  const revision = revisions[0];
  if (revision === undefined) return null;

  const bundles = await db
    .select({
      bundleId: processingBundles.id,
      workingPdfSha256: processingBundles.workingPdfBlobSha256,
      workingPdfKey: storedBlobs.s3Key,
      workingPdfBytes: storedBlobs.sizeBytes,
      pageCount: sql<number>`(select count(*)::int from ${processingBundlePages} bp where bp.bundle_id = processing_bundles.id)`,
    })
    .from(processingBundles)
    .innerJoin(storedBlobs, eq(storedBlobs.sha256, processingBundles.workingPdfBlobSha256))
    .where(eq(processingBundles.revisionId, revisionId))
    .orderBy(asc(processingBundles.createdAt))
    .limit(1);

  const targets = await db
    .select({
      documentId: logicalDocuments.id,
      revisionId: logicalDocuments.revisionId,
      ordinal: logicalDocuments.ordinal,
      docTypeCode: logicalDocuments.docTypeCode,
      isConfirmed: logicalDocuments.isConfirmed,
      derivedPdfSha256: logicalDocuments.derivedPdfBlobSha256,
      firstWorkingPageIndex: sql<number>`min(${processingBundlePages.workingPageIndex})::int`,
      lastWorkingPageIndex: sql<number>`max(${processingBundlePages.workingPageIndex})::int`,
      pageCount: sql<number>`count(*)::int`,
    })
    .from(logicalDocuments)
    .innerJoin(pageAssignments, eq(pageAssignments.documentId, logicalDocuments.id))
    .innerJoin(
      processingBundlePages,
      eq(processingBundlePages.sourcePageId, pageAssignments.sourcePageId),
    )
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, logicalDocuments.revisionId))
    .where(withScope(scope, REVISION_SCOPE, eq(logicalDocuments.revisionId, revisionId)))
    .groupBy(
      logicalDocuments.id,
      logicalDocuments.revisionId,
      logicalDocuments.ordinal,
      logicalDocuments.docTypeCode,
      logicalDocuments.isConfirmed,
      logicalDocuments.derivedPdfBlobSha256,
    )
    .orderBy(asc(logicalDocuments.ordinal));

  return {
    revisionId: revision.id,
    revisionNo: revision.revisionNo,
    status: revision.status,
    source: bundles[0] ?? null,
    targets,
  };
}

/**
 * Разрывный набор страниц: диапазон описывал бы не тот документ.
 *
 * Отдельная функция, а не проверка на месте, потому что её вызывают и
 * обработчик задачи, и тест: «нарезка корректна» — специфический гейт S10, и
 * условие его корректности обязано быть названо один раз.
 */
export function isContiguous(target: MaterializationTarget): boolean {
  return target.lastWorkingPageIndex - target.firstWorkingPageIndex + 1 === target.pageCount;
}

export interface SaveDerivedPdfInput {
  readonly documentId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly toolkit: string;
  readonly noteApplied: boolean;
}

export type SaveDerivedOutcome =
  | { readonly kind: 'written' }
  /** Ревизия стала терминальной, документ разподтверждён и т. п. */
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Запись результата нарезки.
 *
 * Не бросает на запрете БД, а возвращает причину: между постановкой задачи и её
 * исполнением ревизию могли согласовать, и тогда писать в неё нельзя (0008,
 * класс `derived`). Это штатный исход повторной задачи, а не отказ, требующий
 * пяти попыток с backoff. Отличать «нельзя писать» от «не удалось записать»
 * обязан журнал — так же, как это сделано у вердикта проверки файла (S5).
 */
export async function saveDerivedPdf(
  db: Database,
  scope: AuthScope,
  input: SaveDerivedPdfInput,
): Promise<SaveDerivedOutcome> {
  // Видимость проверяется отдельным чтением, а запись идёт по первичному ключу:
  // `UPDATE ... FROM` со связанной областью выразим, но читается хуже, а гонки
  // между двумя операциями здесь нет — настоящий инвариант держат триггеры БД,
  // и именно их отказ разбирается ниже.
  const visible = await db
    .select({ id: logicalDocuments.id })
    .from(logicalDocuments)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, logicalDocuments.revisionId))
    .where(withScope(scope, REVISION_SCOPE, eq(logicalDocuments.id, input.documentId)))
    .limit(1);

  if (visible[0] === undefined) {
    return { kind: 'rejected', reason: 'документ не найден в области видимости задачи' };
  }

  try {
    await db
      .update(logicalDocuments)
      .set({
        derivedPdfBlobSha256: input.sha256,
        derivedPdfBytes: input.byteSize,
        derivedPdfPageCount: input.pageCount,
        derivedPdfToolkit: input.toolkit,
        derivedNoteApplied: input.noteApplied,
        derivedPdfBuiltAt: sql`now()`,
        // Нарезка производна по определению (§13). Флаг выставляется здесь же,
        // а не полагается на значение по умолчанию: ограничение
        // `logical_documents_derived_marked_chk` иначе отвергло бы запись, и
        // это правильный порядок — сначала инвариант, потом удобство.
        isDerivedCopy: true,
        updatedAt: sql`now()`,
        version: sql`${logicalDocuments.version} + 1`,
      })
      .where(eq(logicalDocuments.id, input.documentId));

    return { kind: 'written' };
  } catch (error) {
    const sqlState = driverCode(error);
    // 23001 — триггеры неизменяемости, 23514 — CHECK «нарезка только у
    // подтверждённого» и «нарезка помечена производной».
    if (sqlState === '23001' || sqlState === '23514') {
      return {
        kind: 'rejected',
        reason: 'база отвергла запись: ревизия закрыта либо границы документа не подтверждены',
      };
    }
    throw error;
  }
}

function driverCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

// =====================================================================
// Выдача нарезанного документа
// =====================================================================

export interface DerivedDocumentRef {
  readonly documentId: string;
  readonly revisionId: string;
  readonly objectId: string;
  readonly revisionNo: number;
  readonly ordinal: number;
  readonly title: string | null;
  readonly docTypeCode: string | null;
  readonly sha256: string;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly isDerivedCopy: boolean;
  readonly noteApplied: boolean;
}

/**
 * Нарезанный документ для выдачи содержимого.
 *
 * `null` и на «нет такого», и на «чужой», и на «ещё не нарезан»: первые два
 * обязаны быть неразличимы (§1.6, изоляция), а третий отличается от них
 * состоянием карточки документа, которое подрядчик и так видит.
 */
export async function findDerivedDocument(
  db: Database,
  scope: AuthScope,
  documentId: string,
): Promise<DerivedDocumentRef | null> {
  const rows = await db
    .select({
      documentId: logicalDocuments.id,
      revisionId: logicalDocuments.revisionId,
      objectId: logicalDocuments.objectId,
      revisionNo: submissionRevisions.revisionNo,
      ordinal: logicalDocuments.ordinal,
      title: logicalDocuments.title,
      docTypeCode: logicalDocuments.docTypeCode,
      sha256: logicalDocuments.derivedPdfBlobSha256,
      byteSize: logicalDocuments.derivedPdfBytes,
      pageCount: logicalDocuments.derivedPdfPageCount,
      isDerivedCopy: logicalDocuments.isDerivedCopy,
      noteApplied: logicalDocuments.derivedNoteApplied,
    })
    .from(logicalDocuments)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, logicalDocuments.revisionId))
    .where(withScope(scope, REVISION_SCOPE, eq(logicalDocuments.id, documentId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.sha256 === null || row.byteSize === null || row.pageCount === null) return null;
  return {
    ...row,
    sha256: row.sha256,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    noteApplied: row.noteApplied ?? false,
  };
}

// =====================================================================
// Задача 23: архив согласованной ревизии
// =====================================================================

export interface ArchiveDocumentEntry {
  readonly documentId: string;
  readonly ordinal: number;
  readonly title: string | null;
  readonly docTypeCode: string | null;
  readonly sha256: string;
  readonly pageCount: number;
  /** Нужен писателю ZIP до чтения байтов: размер записи стоит в её заголовке. */
  readonly byteSize: number;
}

export interface ArchivePlan {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly status: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly workId: string;
  readonly workTitle: string;
  readonly sectionCode: string;
  readonly aggregateManifestHash: string | null;
  readonly decidedAt: string | null;
  readonly documents: readonly ArchiveDocumentEntry[];
  readonly sourceFiles: readonly {
    readonly fileName: string;
    readonly sortOrder: number;
    readonly sha256: string;
  }[];
  readonly findingCounts: Readonly<Record<string, number>>;
}

/** Всё, из чего собирается архив, одним чтением. */
export async function loadArchivePlan(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<ArchivePlan | null> {
  const revisions = await db
    .select({
      revisionId: submissionRevisions.id,
      revisionNo: submissionRevisions.revisionNo,
      status: submissionRevisions.status,
      objectId: submissionRevisions.objectId,
      contractorId: submissionRevisions.contractorId,
      workId: submissionRevisions.workId,
      workTitle: works.title,
      sectionCode: works.sectionCode,
      aggregateManifestHash: submissionRevisions.aggregateManifestHash,
      decidedAt: sql<
        string | null
      >`to_char(${submissionRevisions.decidedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
        'decided_at_iso',
      ),
    })
    .from(submissionRevisions)
    .innerJoin(works, eq(works.id, submissionRevisions.workId))
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.id, revisionId)))
    .limit(1);

  const revision = revisions[0];
  if (revision === undefined) return null;

  const documents = await db
    .select({
      documentId: logicalDocuments.id,
      ordinal: logicalDocuments.ordinal,
      title: logicalDocuments.title,
      docTypeCode: logicalDocuments.docTypeCode,
      sha256: logicalDocuments.derivedPdfBlobSha256,
      pageCount: logicalDocuments.derivedPdfPageCount,
      byteSize: logicalDocuments.derivedPdfBytes,
    })
    .from(logicalDocuments)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, logicalDocuments.revisionId))
    .where(withScope(scope, REVISION_SCOPE, eq(logicalDocuments.revisionId, revisionId)))
    .orderBy(asc(logicalDocuments.ordinal));

  const files = await db
    .select({
      fileName: sourceFiles.fileName,
      sortOrder: sourceFiles.sortOrder,
      sha256: sourceFiles.blobSha256,
    })
    .from(sourceFiles)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, sourceFiles.revisionId))
    .where(withScope(scope, REVISION_SCOPE, eq(sourceFiles.revisionId, revisionId)))
    .orderBy(asc(sourceFiles.sortOrder));

  // Только авторитетный прогон (S27): `saveFindings` заменяет строки лишь
  // своего прогона, поэтому сумма по всей ревизии считала бы каждое замечание
  // столько раз, сколько было проверок, и манифест архива называл бы числа,
  // которых на экране никто не видел.
  const counts = await db
    .select({ state: findings.state, value: sql<number>`count(*)::int` })
    .from(findings)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, findings.revisionId))
    .where(
      withScope(
        scope,
        REVISION_SCOPE,
        eq(findings.revisionId, revisionId),
        sql`${findings.validationRunId} = ${LATEST_VALIDATION_RUN}`,
      ),
    )
    .groupBy(findings.state);

  return {
    ...revision,
    // Документы без нарезки в архив не попадают. Это не потеря: согласование
    // требует нарезки у КАЖДОГО документа (`approveBlockers`), поэтому у
    // согласованной ревизии список пуст по построению, а у любой другой архив
    // и не собирается.
    documents: documents.flatMap((document) =>
      document.sha256 === null || document.pageCount === null || document.byteSize === null
        ? []
        : [
            {
              ...document,
              sha256: document.sha256,
              pageCount: document.pageCount,
              byteSize: document.byteSize,
            },
          ],
    ),
    sourceFiles: files,
    findingCounts: Object.fromEntries(counts.map((row) => [row.state, row.value])),
  };
}

export interface ArchiveView {
  readonly id: string;
  readonly revisionId: string;
  readonly s3Key: string;
  readonly archiveSha256: string;
  readonly byteSize: number;
  readonly entryCount: number;
  readonly builderVersion: string;
  readonly createdAt: string;
}

const ARCHIVE_SELECTION = {
  id: submissionArchives.id,
  revisionId: submissionArchives.revisionId,
  s3Key: submissionArchives.s3Key,
  archiveSha256: submissionArchives.archiveSha256,
  byteSize: submissionArchives.byteSize,
  entryCount: submissionArchives.entryCount,
  builderVersion: submissionArchives.builderVersion,
  createdAt:
    sql<string>`to_char(${submissionArchives.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
      'created_at_iso',
    ),
};

export async function findArchive(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<ArchiveView | null> {
  const rows = await db
    .select(ARCHIVE_SELECTION)
    .from(submissionArchives)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, submissionArchives.revisionId))
    .where(withScope(scope, REVISION_SCOPE, eq(submissionArchives.revisionId, revisionId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface RecordArchiveInput {
  readonly revisionId: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly s3Key: string;
  readonly archiveSha256: string;
  readonly byteSize: number;
  readonly entryCount: number;
  readonly builderVersion: string;
}

export type RecordArchiveOutcome =
  | { readonly kind: 'created'; readonly id: string }
  /** Строка уже была: повтор задачи после падения между выкладкой и записью. */
  | { readonly kind: 'exists' };

/**
 * Запись архива.
 *
 * `ON CONFLICT DO NOTHING` по ревизии, а не проверка перед вставкой: между
 * проверкой и вставкой помещается второй воркер, а уникальность здесь — это
 * инвариант «один архив на ревизию», и держать его обязана БД.
 */
export async function recordArchive(
  db: Database,
  input: RecordArchiveInput,
): Promise<RecordArchiveOutcome> {
  const inserted = await db
    .insert(submissionArchives)
    .values({
      revisionId: input.revisionId,
      objectId: input.objectId,
      contractorId: input.contractorId,
      s3Key: input.s3Key,
      archiveSha256: input.archiveSha256,
      byteSize: input.byteSize,
      entryCount: input.entryCount,
      builderVersion: input.builderVersion,
    })
    .onConflictDoNothing({ target: submissionArchives.revisionId })
    .returning({ id: submissionArchives.id });

  const row = inserted[0];
  return row === undefined ? { kind: 'exists' } : { kind: 'created', id: row.id };
}

// =====================================================================
// Переиспользование результатов предыдущей ревизии (§3)
// =====================================================================

export interface ReusableBundle {
  readonly bundleId: string;
  readonly revisionId: string;
  readonly workingPdfBlobSha256: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
}

/**
 * Рабочий документ ПРЕДЫДУЩЕЙ ревизии, пригодный к переиспользованию.
 *
 * §3: «результаты предыдущей ревизии переиспользуются только при совпадении
 * `aggregate_manifest_hash`». Здесь это условие и выражено: совпасть обязаны
 * хэш состава и версия сборщика, а сама ревизия обязана быть предком по цепочке
 * `parent_revision_id` — то есть той же поставки, а не «какой-нибудь чужой с
 * тем же набором файлов». Последнее важно: дедупликация блобов глобальна, и без
 * ограничения на цепочку два подрядчика, подавшие одинаковые файлы, делили бы
 * рабочий документ.
 *
 * Возврат `null` означает «собирать заново» — и это безопасный исход по
 * построению: он лишь стоит времени.
 */
export async function findReusableBundle(
  db: Database,
  scope: AuthScope,
  target: {
    readonly revisionId: string;
    readonly aggregateManifestHash: string;
    readonly builderVersion: string;
  },
): Promise<ReusableBundle | null> {
  const rows = await db
    .select({
      bundleId: processingBundles.id,
      revisionId: processingBundles.revisionId,
      workingPdfBlobSha256: processingBundles.workingPdfBlobSha256,
      sizeBytes: storedBlobs.sizeBytes,
      pageCount: sql<number>`(select count(*)::int from ${processingBundlePages} bp where bp.bundle_id = processing_bundles.id)`,
    })
    .from(processingBundles)
    .innerJoin(storedBlobs, eq(storedBlobs.sha256, processingBundles.workingPdfBlobSha256))
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, processingBundles.revisionId))
    .where(
      withScope(
        scope,
        REVISION_SCOPE,
        eq(processingBundles.aggregateManifestHash, target.aggregateManifestHash),
        eq(processingBundles.builderVersion, target.builderVersion),
        sql`${processingBundles.revisionId} in (
          with recursive chain(id, parent_id) as (
            select r.id, r.parent_revision_id from submission_revisions r where r.id = ${target.revisionId}::uuid
            union all
            select r.id, r.parent_revision_id
              from submission_revisions r
              join chain c on r.id = c.parent_id
          )
          select id from chain where id <> ${target.revisionId}::uuid
        )`,
      ),
    )
    .orderBy(asc(processingBundles.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/** Ревизия, которой принадлежит документ; отдельным чтением ради области. */
export async function requireVisibleRevisionOfDocument(
  db: Database,
  scope: AuthScope,
  documentId: string,
): Promise<{ readonly revisionId: string; readonly objectId: string }> {
  const rows = await db
    .select({
      revisionId: logicalDocuments.revisionId,
      objectId: logicalDocuments.objectId,
      status: submissionRevisions.status,
    })
    .from(logicalDocuments)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, logicalDocuments.revisionId))
    .where(withScope(scope, REVISION_SCOPE, eq(logicalDocuments.id, documentId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound('Логический документ не найден.');
  return { revisionId: row.revisionId, objectId: row.objectId };
}

/** Проверка «архив можно отдавать»: ревизия согласована и архив записан. */
export async function requireReadyArchive(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<ArchiveView> {
  const archive = await findArchive(db, scope, revisionId);
  if (archive === null) {
    throw conflict(
      'Архив ревизии ещё не собран: он появляется после согласования, ' +
        'когда задача сборки отработает в фоне.',
    );
  }
  return archive;
}
