/**
 * Хранение и выдача сверки описи передачи с комплектами папки (S20).
 *
 * ## Почему отдельный репозиторий
 *
 * Запись сюда делает воркер одной транзакцией, а читателей два, и они разные
 * не фильтром, а ЕДИНИЦЕЙ выдачи: сводка по папке и результат по одному
 * комплекту. Разложить их по `navigation.ts` и `documents.ts` значило бы
 * разнести по двум файлам одно решение — какие сведения о папке кому видны, —
 * а его надо читать целиком.
 *
 * ## Единица результата — комплект
 *
 * В одной папке комплекты разных субподрядчиков. Подрядчик имеет право знать
 * об ошибках в СВОИХ документах и не имеет права знать о работах соседей,
 * поэтому:
 *
 * * `findWorkReconciliation` отдаёт срез по ревизии комплекта и не содержит в
 *   ответе ни одного поля о папке — ни шапки описи, ни групп без комплекта, ни
 *   общих счётчиков. Спрятать их нельзя забыть: их нет в типе;
 * * `findRegistryReconciliation` отдаёт папку целиком, и рубеж у него —
 *   `registry.manage` на маршруте плюс `findRegistry` по области.
 *
 * ## Запись переписывает результат целиком
 *
 * Сверка — производный факт о КОНКРЕТНОМ скане, а не бумага. Повторный прогон
 * (после нового распознавания, после правки разметки) обязан её пересчитать,
 * поэтому `saveReconciliation` делает `DELETE`+`INSERT` под уникальным ключом
 * `(registry_id, revision_id)`. Единственное, что переживает пересчёт, —
 * отметка «разобрано»: человек разбирал расхождение, а не строку таблицы.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import {
  registryReconciliationExtraDocs,
  registryReconciliationGroups,
  registryReconciliationRows,
  registryReconciliationWorks,
  registryReconciliations,
} from '@id/db';
import type {
  ReconciliationExtraDocument,
  ReconciliationGroup,
  ReconciliationRow,
  ReconciliationVerdict,
  ReconciliationWork,
  RegistryReconciliation,
} from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, notFound } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { submissionRevisions } from '@id/db';
import { appendAudit, type AuditActor } from './audit.js';
import type { Database } from './users.js';

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

/**
 * Ключ advisory-блокировки прогона сверки.
 *
 * Произвольная константа; важна только её уникальность в пределах базы. Второй
 * аргумент `pg_advisory_xact_lock` — младшие биты `registry_id`: блокировка
 * нужна на ПАПКУ, а не на всю таблицу, иначе две сверки разных папок ждали бы
 * друг друга без всякой на то причины.
 */
const RECONCILE_LOCK_KEY = 0x5230_2001;

// =====================================================================
// Запись
// =====================================================================

export interface SaveReconciliationInput {
  readonly objectId: string;
  readonly registryId: string;
  /** Комплект-файл описи и его ревизия: сверен конкретный скан. */
  readonly workId: string;
  readonly revisionId: string;
  readonly verdict: ReconciliationVerdict;
  readonly headerRegistryNo: string | null;
  readonly headerFolderNo: string | null;
  readonly headerMismatch: boolean;
  readonly parserVersion: string;
  readonly matcherVersion: string;
  readonly warnings: readonly string[];
  readonly works: readonly ReconciliationWork[];
  readonly groups: readonly ReconciliationGroup[];
  readonly rows: readonly ReconciliationRow[];
  readonly extraDocuments: readonly ReconciliationExtraDocument[];
}

function countBy<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.reduce((total, item) => (predicate(item) ? total + 1 : total), 0);
}

/**
 * Записывает прогон сверки, переписывая предыдущий по тому же скану.
 *
 * Порядок внутри транзакции значим дважды. Advisory-блокировка берётся ПЕРВОЙ:
 * очередь `io` имеет параллелизм 6, и два прогона по одной папке иначе оба
 * дошли бы до `DELETE`+`INSERT` под уникальным ключом, где второй упал бы уже
 * после всей дорогой работы. Отметка «разобрано» читается ДО удаления и
 * возвращается на место после вставки: она принадлежит человеку, а не прогону.
 */
export async function saveReconciliation(
  db: Database,
  input: SaveReconciliationInput,
): Promise<RegistryReconciliation> {
  const counts = {
    groupsTotal: input.groups.length,
    groupsMatched: countBy(input.groups, (group) => group.matchState === 'matched'),
    groupsMissing: countBy(input.groups, (group) => group.matchState === 'missing'),
    groupsAmbiguous: countBy(input.groups, (group) => group.matchState === 'ambiguous'),
    rowsTotal: input.rows.length,
    rowsMatched: countBy(input.rows, (row) => row.matchState === 'matched'),
    rowsMissing: countBy(input.rows, (row) => row.matchState === 'missing'),
    rowsAmbiguous: countBy(input.rows, (row) => row.matchState === 'ambiguous'),
    rowsFieldMismatch: countBy(input.rows, (row) => row.fieldMismatches.length > 0),
    worksTotal: input.works.length,
    worksExtra: countBy(input.works, (work) => work.state === 'extra'),
    extraDocuments: input.extraDocuments.length,
  };

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RECONCILE_LOCK_KEY}, hashtext(${input.registryId}))`,
    );

    const previous = await tx
      .select({
        reviewedBy: registryReconciliations.reviewedBy,
        reviewedAt: registryReconciliations.reviewedAt,
        reviewedNote: registryReconciliations.reviewedNote,
        version: registryReconciliations.version,
      })
      .from(registryReconciliations)
      .where(
        and(
          eq(registryReconciliations.registryId, input.registryId),
          eq(registryReconciliations.revisionId, input.revisionId),
        ),
      )
      .limit(1);
    const kept = previous[0];

    await tx
      .delete(registryReconciliations)
      .where(
        and(
          eq(registryReconciliations.registryId, input.registryId),
          eq(registryReconciliations.revisionId, input.revisionId),
        ),
      );

    const inserted = await tx
      .insert(registryReconciliations)
      .values({
        objectId: input.objectId,
        registryId: input.registryId,
        workId: input.workId,
        revisionId: input.revisionId,
        verdict: input.verdict,
        // Версия продолжает счёт прежнего прогона: `If-Match` отметки
        // «разобрано» не должен молча совпасть после пересчёта.
        version: (kept?.version ?? -1) + 1,
        headerRegistryNo: input.headerRegistryNo,
        headerFolderNo: input.headerFolderNo,
        headerMismatch: input.headerMismatch,
        parserVersion: input.parserVersion,
        matcherVersion: input.matcherVersion,
        warnings: [...input.warnings],
        reviewedBy: kept?.reviewedBy ?? null,
        reviewedAt: kept?.reviewedAt ?? null,
        reviewedNote: kept?.reviewedNote ?? null,
        ...counts,
      })
      .returning({ id: registryReconciliations.id });

    const id = inserted[0]?.id;
    if (id === undefined) throw conflict('Сверка описи не записана.');

    if (input.works.length > 0) {
      await tx.insert(registryReconciliationWorks).values(
        input.works.map((work) => ({
          reconciliationId: id,
          revisionId: input.revisionId,
          workId: work.workId,
          matchedRevisionId: work.matchedRevisionId,
          contractorId: work.contractorId,
          title: work.title,
          contractorName: work.contractorName,
          state: work.state,
          verdict: work.verdict,
          rowsTotal: work.rowsTotal,
          rowsMatched: work.rowsMatched,
          rowsMissing: work.rowsMissing,
          rowsAmbiguous: work.rowsAmbiguous,
          rowsFieldMismatch: work.rowsFieldMismatch,
          extraDocuments: work.extraDocuments,
        })),
      );
    }

    // Группы обязаны лечь ДО строк: строка ссылается на группу составным
    // внешним ключом, а не «логически».
    if (input.groups.length > 0) {
      await tx.insert(registryReconciliationGroups).values(
        input.groups.map((group) => ({
          reconciliationId: id,
          revisionId: input.revisionId,
          ordinal: group.ordinal,
          groupNo: group.groupNo,
          titleRaw: group.titleRaw,
          actNoRaw: group.actNoRaw,
          actNoNorm: group.actNoNorm,
          contractorRaw: group.contractorRaw,
          matchedWorkId: group.matchedWorkId,
          matchedRevisionId: group.matchedRevisionId,
          matchedContractorId: group.matchedContractorId,
          matchState: group.matchState,
          matchScore: group.matchScore === null ? null : String(group.matchScore),
          reason: group.reason,
        })),
      );
    }

    if (input.rows.length > 0) {
      await tx.insert(registryReconciliationRows).values(
        input.rows.map((row) => ({
          reconciliationId: id,
          revisionId: input.revisionId,
          ordinal: row.ordinal,
          groupOrdinal: row.groupOrdinal,
          workId: row.workId,
          contractorId: row.contractorId,
          rowNo: row.rowNo,
          docNameRaw: row.docNameRaw,
          docNoRaw: row.docNoRaw,
          docNoNorm: row.docNoNorm,
          docNoFolded: null,
          orgRaw: row.orgRaw,
          issuedAt: row.issuedAt,
          validFrom: row.validFrom,
          validTo: row.validTo,
          sheets: row.sheets,
          copies: row.copies,
          pagesRaw: row.pagesRaw,
          matchedDocumentId: row.matchedDocumentId,
          matchState: row.matchState,
          matchScore: row.matchScore === null ? null : String(row.matchScore),
          fieldMismatches: [...row.fieldMismatches],
          reason: row.reason,
        })),
      );
    }

    if (input.extraDocuments.length > 0) {
      await tx.insert(registryReconciliationExtraDocs).values(
        input.extraDocuments.map((document) => ({
          reconciliationId: id,
          revisionId: input.revisionId,
          documentId: document.documentId,
          workId: document.workId,
          docRevisionId: document.revisionId,
          contractorId: document.contractorId,
          docNoRaw: document.docNoRaw,
          docNameRaw: document.docNameRaw,
          docTypeCode: document.docTypeCode,
        })),
      );
    }

    const saved = await selectReconciliation(tx, id);
    if (saved === null) throw conflict('Сверка описи не записана.');
    return saved;
  });
}

// =====================================================================
// Чтение
// =====================================================================

const RECONCILIATION_SELECTION = {
  id: registryReconciliations.id,
  registryId: registryReconciliations.registryId,
  revisionId: registryReconciliations.revisionId,
  verdict: registryReconciliations.verdict,
  version: registryReconciliations.version,
  headerRegistryNo: registryReconciliations.headerRegistryNo,
  headerFolderNo: registryReconciliations.headerFolderNo,
  headerMismatch: registryReconciliations.headerMismatch,
  parserVersion: registryReconciliations.parserVersion,
  matcherVersion: registryReconciliations.matcherVersion,
  finishedAt:
    sql<string>`to_char(${registryReconciliations.finishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as(
      'finished_at_iso',
    ),
  groupsTotal: registryReconciliations.groupsTotal,
  groupsMatched: registryReconciliations.groupsMatched,
  groupsMissing: registryReconciliations.groupsMissing,
  groupsAmbiguous: registryReconciliations.groupsAmbiguous,
  rowsTotal: registryReconciliations.rowsTotal,
  rowsMatched: registryReconciliations.rowsMatched,
  rowsMissing: registryReconciliations.rowsMissing,
  rowsAmbiguous: registryReconciliations.rowsAmbiguous,
  rowsFieldMismatch: registryReconciliations.rowsFieldMismatch,
  worksTotal: registryReconciliations.worksTotal,
  worksExtra: registryReconciliations.worksExtra,
  extraDocuments: registryReconciliations.extraDocuments,
  warnings: registryReconciliations.warnings,
  reviewedBy: registryReconciliations.reviewedBy,
  reviewedAt: sql<
    string | null
  >`to_char(${registryReconciliations.reviewedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as(
    'reviewed_at_iso',
  ),
  reviewedNote: registryReconciliations.reviewedNote,
};

type ReconciliationRowShape = { readonly verdict: string } & Omit<
  RegistryReconciliation,
  'verdict'
>;

function toReconciliation(row: ReconciliationRowShape): RegistryReconciliation {
  return { ...row, verdict: row.verdict as ReconciliationVerdict };
}

async function selectReconciliation(
  db: Database,
  id: string,
): Promise<RegistryReconciliation | null> {
  const rows = await db
    .select(RECONCILIATION_SELECTION)
    .from(registryReconciliations)
    .where(eq(registryReconciliations.id, id))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toReconciliation(row);
}

/** Сводка по ПАПКЕ вместе со всеми списками. */
export interface RegistryReconciliationView {
  readonly reconciliation: RegistryReconciliation;
  readonly works: readonly ReconciliationWork[];
  readonly groups: readonly ReconciliationGroup[];
  readonly rows: readonly ReconciliationRow[];
  readonly extraDocuments: readonly ReconciliationExtraDocument[];
}

/** Результат по ОДНОМУ комплекту: полей о папке в этом типе нет вовсе. */
export interface WorkReconciliationView {
  readonly work: ReconciliationWork;
  readonly rows: readonly ReconciliationRow[];
  readonly extraDocuments: readonly ReconciliationExtraDocument[];
  /** Версии и время прогона: без них расхождение двух сверок необъяснимо. */
  readonly parserVersion: string;
  readonly finishedAt: string;
}

const numberOrNull = (value: string | null): number | null =>
  value === null ? null : Number(value);

async function listRows(
  db: Database,
  reconciliationId: string,
  workId: string | null,
): Promise<readonly ReconciliationRow[]> {
  const rows = await db
    .select()
    .from(registryReconciliationRows)
    .where(
      workId === null
        ? eq(registryReconciliationRows.reconciliationId, reconciliationId)
        : and(
            eq(registryReconciliationRows.reconciliationId, reconciliationId),
            eq(registryReconciliationRows.workId, workId),
          ),
    )
    .orderBy(asc(registryReconciliationRows.ordinal));

  return rows.map((row) => ({
    ordinal: row.ordinal,
    groupOrdinal: row.groupOrdinal,
    workId: row.workId,
    contractorId: row.contractorId,
    rowNo: row.rowNo,
    docNameRaw: row.docNameRaw,
    docNoRaw: row.docNoRaw,
    docNoNorm: row.docNoNorm,
    orgRaw: row.orgRaw,
    issuedAt: row.issuedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    sheets: row.sheets,
    copies: row.copies,
    pagesRaw: row.pagesRaw,
    matchedDocumentId: row.matchedDocumentId,
    matchState: row.matchState as ReconciliationRow['matchState'],
    matchScore: numberOrNull(row.matchScore),
    fieldMismatches: row.fieldMismatches,
    reason: row.reason,
  }));
}

async function listExtraDocuments(
  db: Database,
  reconciliationId: string,
  workId: string | null,
): Promise<readonly ReconciliationExtraDocument[]> {
  const rows = await db
    .select()
    .from(registryReconciliationExtraDocs)
    .where(
      workId === null
        ? eq(registryReconciliationExtraDocs.reconciliationId, reconciliationId)
        : and(
            eq(registryReconciliationExtraDocs.reconciliationId, reconciliationId),
            eq(registryReconciliationExtraDocs.workId, workId),
          ),
    );

  return rows.map((row) => ({
    documentId: row.documentId,
    workId: row.workId,
    revisionId: row.docRevisionId,
    contractorId: row.contractorId,
    docNoRaw: row.docNoRaw,
    docNameRaw: row.docNameRaw,
    docTypeCode: row.docTypeCode,
  }));
}

function toWork(row: typeof registryReconciliationWorks.$inferSelect): ReconciliationWork {
  return {
    workId: row.workId,
    matchedRevisionId: row.matchedRevisionId,
    contractorId: row.contractorId,
    title: row.title,
    contractorName: row.contractorName,
    state: row.state as ReconciliationWork['state'],
    verdict: row.verdict as ReconciliationVerdict,
    rowsTotal: row.rowsTotal,
    rowsMatched: row.rowsMatched,
    rowsMissing: row.rowsMissing,
    rowsAmbiguous: row.rowsAmbiguous,
    rowsFieldMismatch: row.rowsFieldMismatch,
    extraDocuments: row.extraDocuments,
  };
}

/**
 * Сводка по папке.
 *
 * Область здесь НЕ проверяется: рубеж создаёт маршрут, вызывающий
 * `findRegistry(db, scope, registryId)` до этой функции, — то же разделение,
 * что у `listRegistryItems`. Дублировать проверку значило бы завести второй
 * источник правды о том, кому видна папка.
 */
export async function findRegistryReconciliation(
  db: Database,
  registryId: string,
  revisionId: string | null,
): Promise<RegistryReconciliationView | null> {
  const rows = await db
    .select(RECONCILIATION_SELECTION)
    .from(registryReconciliations)
    .where(
      revisionId === null
        ? eq(registryReconciliations.registryId, registryId)
        : and(
            eq(registryReconciliations.registryId, registryId),
            eq(registryReconciliations.revisionId, revisionId),
          ),
    )
    .orderBy(asc(registryReconciliations.finishedAt))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  const reconciliation = toReconciliation(row);

  const [works, groups, docRows, extraDocuments] = await Promise.all([
    db
      .select()
      .from(registryReconciliationWorks)
      .where(eq(registryReconciliationWorks.reconciliationId, reconciliation.id))
      .orderBy(asc(registryReconciliationWorks.title)),
    db
      .select()
      .from(registryReconciliationGroups)
      .where(eq(registryReconciliationGroups.reconciliationId, reconciliation.id))
      .orderBy(asc(registryReconciliationGroups.ordinal)),
    listRows(db, reconciliation.id, null),
    listExtraDocuments(db, reconciliation.id, null),
  ]);

  return {
    reconciliation,
    works: works.map(toWork),
    groups: groups.map((group) => ({
      ordinal: group.ordinal,
      groupNo: group.groupNo,
      titleRaw: group.titleRaw,
      actNoRaw: group.actNoRaw,
      actNoNorm: group.actNoNorm,
      contractorRaw: group.contractorRaw,
      matchedWorkId: group.matchedWorkId,
      matchedRevisionId: group.matchedRevisionId,
      matchedContractorId: group.matchedContractorId,
      matchState: group.matchState as ReconciliationGroup['matchState'],
      matchScore: numberOrNull(group.matchScore),
      reason: group.reason,
    })),
    rows: docRows,
    extraDocuments,
  };
}

/**
 * Результат по одному комплекту, адресуемый ЕГО ревизией.
 *
 * Область проверяется здесь и по ревизии комплекта — тем же рубежом, каким
 * закрыты все остальные чтения ревизии. Ответ не содержит полей о папке: тип
 * их не имеет, поэтому «забыть спрятать» тут нечего.
 */
export async function findWorkReconciliation(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<WorkReconciliationView | null> {
  const rows = await db
    .select({
      work: registryReconciliationWorks,
      reconciliationId: registryReconciliations.id,
      parserVersion: registryReconciliations.parserVersion,
      finishedAt:
        sql<string>`to_char(${registryReconciliations.finishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as(
          'finished_at_iso',
        ),
    })
    .from(registryReconciliationWorks)
    .innerJoin(
      registryReconciliations,
      eq(registryReconciliationWorks.reconciliationId, registryReconciliations.id),
    )
    // Область берётся от ревизии КОМПЛЕКТА, а не от ревизии скана описи:
    // спрашивают про свой комплект, и видимость должна решаться им же.
    .innerJoin(
      submissionRevisions,
      eq(registryReconciliationWorks.matchedRevisionId, submissionRevisions.id),
    )
    .where(
      withScope(
        scope,
        REVISION_SCOPE,
        eq(registryReconciliationWorks.matchedRevisionId, revisionId),
      ),
    )
    .orderBy(asc(registryReconciliations.finishedAt))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  const [docRows, extraDocuments] = await Promise.all([
    listRows(db, row.reconciliationId, row.work.workId),
    listExtraDocuments(db, row.reconciliationId, row.work.workId),
  ]);

  return {
    work: toWork(row.work),
    rows: docRows,
    extraDocuments,
    parserVersion: row.parserVersion,
    finishedAt: row.finishedAt,
  };
}

// =====================================================================
// Отметка «разобрано»
// =====================================================================

/**
 * Отметка «расхождение разобрано, дефекта нет».
 *
 * Это суждение принимающей стороны, а не наблюдение портала, поэтому пояснение
 * обязательно и содержательно (10–1000 символов): отметка без объяснения — это
 * «закрыл, чтобы не мозолило», и следующий человек не поймёт, разобрано ли
 * расхождение или спрятано.
 *
 * `If-Match` сверяется с `version`, которую пересчёт увеличивает: отметка,
 * поставленная по вчерашней сверке, не должна молча приклеиться к сегодняшней.
 */
export async function reviewReconciliation(
  db: Database,
  registryId: string,
  expectedVersion: number,
  note: string,
  userId: string,
  actor: AuditActor,
  scope: AuthScope,
): Promise<RegistryReconciliation> {
  const current = await db
    .select({
      id: registryReconciliations.id,
      objectId: registryReconciliations.objectId,
      version: registryReconciliations.version,
      verdict: registryReconciliations.verdict,
    })
    .from(registryReconciliations)
    .where(eq(registryReconciliations.registryId, registryId))
    .limit(1);

  const found = current[0];
  if (found === undefined) throw notFound('Сверка описи не проводилась.');
  if (found.verdict === 'clean') {
    throw conflict('Расхождений нет: разбирать нечего.');
  }

  const updated = await db
    .update(registryReconciliations)
    .set({
      reviewedBy: userId,
      reviewedAt: sql`now()`,
      reviewedNote: note,
      version: found.version + 1,
    })
    .where(
      and(
        eq(registryReconciliations.id, found.id),
        eq(registryReconciliations.version, expectedVersion),
      ),
    )
    .returning({ id: registryReconciliations.id });

  if (updated.length === 0) {
    throw conflict('Сверка изменилась: обновите страницу и повторите.');
  }

  await appendAudit(db, scope, {
    ...actor,
    action: 'registry.reconciliation_reviewed',
    entityType: 'registry',
    entityId: registryId,
    objectId: found.objectId,
    payload: { note },
  });

  const result = await selectReconciliation(db, found.id);
  if (result === null) throw notFound('Сверка описи не проводилась.');
  return result;
}
