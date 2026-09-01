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
 * ## Что именно запрещено в диапазоне нарезки
 *
 * `qpdf --pages src A-B` вырезает ОДИН отрезок, и охраняется здесь ровно один
 * факт: в выдаче подрядчика не должно оказаться листа ЧУЖОГО документа. Пропуск
 * внутри набора сам по себе таким листом не является — между страницами
 * документа штатно лежит непривязанная страница (пустой оборот, штамп ЭП, лист
 * без сигнала), и она принадлежит тому же бумажному документу.
 *
 * Первая редакция запрещала любой пропуск, и на реальном комплекте это лишило
 * выдачи весь комплект из-за одного пустого оборота: задача 22 умирала
 * неповторяемой ошибкой, а согласование блокировалось ненарезанным документом.
 * Поэтому проверок теперь две и они разные по силе:
 *
 * - `overlappingTargets()` — пересечение с диапазоном другого документа. Это и
 *   есть «чужой лист», отказ с названной причиной.
 * - `isContiguous()` — есть ли пропуск вообще. Не отказ: повод предупредить в
 *   журнале и ленте ревизии, потому что в нарезку попадут страницы, которые
 *   портал ни к какому документу не отнёс.
 */
import { asc, eq, sql } from 'drizzle-orm';
import {
  logicalDocuments,
  pageAssignments,
  processingBundlePages,
  processingBundles,
  storedBlobs,
  folders,
} from '@id/db';
import type { AuthScope } from '../../auth/scope.js';
import { notFound } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import type { Database } from './users.js';

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
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
  readonly folderId: string;
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
  readonly folderId: string;
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
  folderId: string,
): Promise<MaterializationPlan | null> {
  const visible = await db
    .select({
      id: folders.id,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
    .limit(1);

  const folder = visible[0];
  if (folder === undefined) return null;

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
    .where(eq(processingBundles.folderId, folderId))
    .orderBy(asc(processingBundles.createdAt))
    .limit(1);

  const targets = await db
    .select({
      documentId: logicalDocuments.id,
      folderId: logicalDocuments.folderId,
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
    .innerJoin(folders, eq(folders.id, logicalDocuments.folderId))
    .where(withScope(scope, FOLDER_SCOPE, eq(logicalDocuments.folderId, folderId)))
    .groupBy(
      logicalDocuments.id,
      logicalDocuments.folderId,
      logicalDocuments.ordinal,
      logicalDocuments.docTypeCode,
      logicalDocuments.isConfirmed,
      logicalDocuments.derivedPdfBlobSha256,
    )
    .orderBy(asc(logicalDocuments.ordinal));

  return {
    folderId: folder.id,
    source: bundles[0] ?? null,
    targets,
  };
}

/**
 * Есть ли в наборе страниц документа пропуск.
 *
 * Отдельная функция, а не проверка на месте, потому что её вызывают и
 * обработчик задачи, и тест: «нарезка корректна» — специфический гейт S10, и
 * условие его корректности обязано быть названо один раз.
 *
 * Пропуск — не дефект сам по себе (см. шапку файла): он означает лишь, что в
 * отрезок попадут страницы, не отнесённые ни к какому документу.
 */
export function isContiguous(target: MaterializationTarget): boolean {
  return target.lastWorkingPageIndex - target.firstWorkingPageIndex + 1 === target.pageCount;
}

/**
 * Документы, чьи страницы попали бы в нарезку этого документа.
 *
 * Сравниваются ОТРЕЗКИ `first..last`, а не поимённые списки страниц: план
 * нарезки несёт границы каждого документа ревизии, и пересечение отрезков
 * равносильно «внутри моего диапазона лежит чужой лист». Дополнительных
 * запросов это не требует, а ошибиться в нём негде.
 *
 * Пустой результат — единственное условие, при котором отрезок вырезать можно.
 */
export function overlappingTargets(
  target: MaterializationTarget,
  targets: readonly MaterializationTarget[],
): readonly MaterializationTarget[] {
  return targets.filter(
    (other) =>
      other.documentId !== target.documentId &&
      other.firstWorkingPageIndex <= target.lastWorkingPageIndex &&
      other.lastWorkingPageIndex >= target.firstWorkingPageIndex,
  );
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
    .innerJoin(folders, eq(folders.id, logicalDocuments.folderId))
    .where(withScope(scope, FOLDER_SCOPE, eq(logicalDocuments.id, input.documentId)))
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
  readonly folderId: string;
  readonly objectId: string;
  readonly ordinal: number;
  readonly title: string | null;
  readonly docTypeCode: string | null;
  readonly sha256: string;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly isDerivedCopy: boolean;
  readonly noteApplied: boolean;
}

/** Папка, которой принадлежит документ; отдельным чтением ради области. */
export async function requireVisibleFolderOfDocument(
  db: Database,
  scope: AuthScope,
  documentId: string,
): Promise<{ readonly folderId: string; readonly objectId: string }> {
  const rows = await db
    .select({
      folderId: logicalDocuments.folderId,
      objectId: logicalDocuments.objectId,
    })
    .from(logicalDocuments)
    .innerJoin(folders, eq(folders.id, logicalDocuments.folderId))
    .where(withScope(scope, FOLDER_SCOPE, eq(logicalDocuments.id, documentId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound('Логический документ не найден.');
  return { folderId: row.folderId, objectId: row.objectId };
}
