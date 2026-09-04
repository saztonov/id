/**
 * Реестр устойчивой идентичности блоков и журнал отправок в RD WEB (0069).
 *
 * ## Зачем реестр вообще нужен
 *
 * Контракт document-sync распознаёт не всё, а только изменившееся, и это
 * свойство целиком держится на одном условии: внешний идентификатор блока
 * СТАБИЛЕН между отправками. Стабильного идентификатора у портала не было.
 *
 * `layout_blocks.id` не годится: `PIPELINE_RESET_DELETES` сносит результаты, а
 * `importDetectedBlocks` вслед за ними — блоки `source='auto'`, и повторная
 * детекция вставляет их заново с новыми `uuid` при той же геометрии. Для RD WEB
 * это `new_block` по каждому блоку, то есть повторная оплата распознавания
 * всего комплекта.
 *
 * Геометрия не годится тоже: правку рамки `updateLayoutBlock` делает НА МЕСТЕ,
 * `uuid` при этом сохраняется, а геометрия меняется — и блок, у которого просто
 * подвинули границу, потерял бы связь со своим прежним результатом.
 *
 * Отсюда двухпроходное сопоставление: сперва по `layout_block_id` (переживает
 * правку рамки), затем по `geometry_key` (переживает переразметку). Ни один ключ
 * по отдельности не покрывает оба случая, а цена промаха одинакова в обе
 * стороны — счёт за распознавание комплекта.
 *
 * ## Что здесь НЕ решается
 *
 * Сборка тела снимка и канонический хеш: они живут в `@id/execsync` и
 * `integrations/rdweb-exec/snapshot.ts` и не знают про БД. Репозиторий отвечает
 * на вопрос «какой у этого блока внешний идентификатор и какая у него ревизия»,
 * а не «как это выглядит на проводе».
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  constructionObjects,
  folders,
  layoutBlocks,
  rdExecBlocks,
  rdExecDocuments,
  rdExecSyncs,
} from '@id/db';
import type { BlockType } from '@id/contracts';

import type { AuthScope } from '../../auth/scope.js';
import { conflict, internal, notFound } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import type { Database } from './users.js';

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/** Состояния строки отправки. Совпадают с CHECK миграции 0069. */
export type ExecSyncRowState =
  'preparing' | 'initialized' | 'uploaded' | 'completed' | 'terminal' | 'conflict';

const NON_TERMINAL_STATES: readonly ExecSyncRowState[] = [
  'preparing',
  'initialized',
  'uploaded',
  'completed',
];

// =====================================================================
// Идентификаторы
// =====================================================================

/**
 * Идентификатор логического документа.
 *
 * Папка, а не рабочий PDF: контракт различает документ и его редакцию, и у нас
 * это различие уже есть — папка живёт, `processing_bundles` пересобирается.
 * Префикс нужен, чтобы идентификатор читался человеком в интерфейсе RD WEB и
 * не выглядел безымянным uuid среди чужих проектов.
 */
export function externalDocumentIdOf(folderId: string): string {
  return `folder/${folderId}`;
}

/**
 * Ключ идемпотентности отправки (§9).
 *
 * Детерминирован по построению: та же папка, та же генерация и тот же круг
 * пересборки дают ту же строку. Повтор задачи после падения воркера обязан
 * попасть в `duplicate: true`, а не завести вторую отправку.
 */
export function externalSyncIdOf(folderId: string, generation: number, round: number): string {
  return `sync-${folderId}-g${String(generation)}-r${String(round)}`;
}

function externalBlockIdOf(seq: number): string {
  return `blk-${String(seq).padStart(6, '0')}`;
}

// =====================================================================
// Сопоставление блоков
// =====================================================================

/** Блок разметки на входе сопоставления. */
export interface ReconcileBlockInput {
  readonly layoutBlockId: string;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  /** sha256 канонической строки геометрии (`blockGeometryKey`). */
  readonly geometryKey: string;
  /** sha256 всей объявленной проекции блока: геометрия, порядок, имя, metadata. */
  readonly declaredHash: string;
}

/** Что решено по блоку: его внешний идентификатор и объявляемая ревизия. */
export interface BlockDeclaration {
  readonly layoutBlockId: string;
  readonly externalBlockId: string;
  readonly revision: number;
  /** Чем блок узнан. Идёт в журнал: по нему объясняется цена прогона. */
  readonly matchedBy: 'layout_block' | 'geometry' | 'new';
}

export interface ExecSnapshotPlan {
  readonly folderId: string;
  readonly externalProjectId: string;
  readonly externalDocumentId: string;
  readonly documentRevision: string;
  readonly syncGeneration: number;
  readonly baseGeneration: number;
  readonly declarations: readonly BlockDeclaration[];
  /** Отправка этого прогона уже готовилась: генерация переиспользована. */
  readonly reused: boolean;
}

interface ExistingRegistryRow {
  readonly externalBlockId: string;
  readonly geometryKey: string;
  readonly declaredHash: string;
  readonly revision: number;
  readonly layoutBlockId: string | null;
}

/**
 * Привести реестр к текущему набору блоков и вернуть план объявления.
 *
 * Одной транзакцией целиком: генерация, реестр и решение по каждому блоку
 * имеют смысл только вместе. Разорвись это на три вызова — сбой посередине
 * оставил бы поднятую генерацию без реестра, и следующая отправка объявила бы
 * старые блоки под новыми идентификаторами.
 *
 * Идемпотентность по прогону: если у прогона уже есть нетерминальная отправка,
 * генерация НЕ поднимается, а переиспользуется. Повторная попытка задачи
 * обязана собрать тот же снимок — иначе `external_sync_id` совпал бы, а тело
 * нет, и контракт ответил бы `409 sync_identity_conflict` (§9).
 */
export async function reconcileExecSnapshot(
  db: Database,
  scope: AuthScope,
  input: {
    readonly folderId: string;
    readonly recognitionRunId: string;
    readonly externalProjectId: string;
    readonly documentSha256: string;
    readonly blocks: readonly ReconcileBlockInput[];
  },
): Promise<ExecSnapshotPlan> {
  const scoped = await db
    .select({ folderId: folders.id, objectId: folders.objectId })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, input.folderId)))
    .limit(1);
  const folder = scoped[0];
  if (folder === undefined) throw notFound('Папка не найдена.');

  return db.transaction(async (tx) => {
    // --- документ ---------------------------------------------------------
    await tx
      .insert(rdExecDocuments)
      .values({
        folderId: folder.folderId,
        objectId: folder.objectId,
        externalProjectId: input.externalProjectId,
        externalDocumentId: externalDocumentIdOf(folder.folderId),
      })
      .onConflictDoNothing({ target: rdExecDocuments.folderId });

    const documentRows = await tx
      .select()
      .from(rdExecDocuments)
      .where(eq(rdExecDocuments.folderId, folder.folderId))
      .limit(1);
    const document = documentRows[0];
    if (document === undefined) {
      throw internal({ logDetail: 'строка rd_exec_documents не читается сразу после записи' });
    }

    if (document.externalProjectId !== input.externalProjectId) {
      // Проект развёртывания сменили посреди жизни документа. Молча отправить
      // снимок в другой проект нельзя: там у документа нет ни истории, ни
      // результатов, и «ничего не распозналось» выглядело бы сбоем модели.
      throw conflict(
        `Документ папки заведён в проекте «${document.externalProjectId}», а настройка ` +
          `указывает «${input.externalProjectId}». Смена проекта требует нового документа ` +
          'на стороне RD WEB — обратитесь к эксплуатации.',
      );
    }

    // --- отправка этого прогона: новая или переиспользуемая ----------------
    const openRows = await tx
      .select({
        syncGeneration: rdExecSyncs.syncGeneration,
        baseGeneration: rdExecSyncs.baseGeneration,
        documentRevision: rdExecSyncs.documentRevision,
      })
      .from(rdExecSyncs)
      .where(
        and(
          eq(rdExecSyncs.folderId, folder.folderId),
          eq(rdExecSyncs.recognitionRunId, input.recognitionRunId),
          inArray(rdExecSyncs.state, [...NON_TERMINAL_STATES]),
        ),
      )
      .limit(1);
    const open = openRows[0];

    let syncGeneration: number;
    let baseGeneration: number;
    let documentRevision: string;

    if (open !== undefined) {
      syncGeneration = open.syncGeneration;
      baseGeneration = open.baseGeneration;
      documentRevision = open.documentRevision;
    } else {
      syncGeneration = document.syncGeneration + 1;
      baseGeneration = document.baseGeneration;

      /*
       * Метка редакции PDF растёт вместе со сменой файла.
       *
       * Счётчик, а не хеш: §2 зовёт поле человеческой меткой, и «R3» в их
       * интерфейсе читается, а «b7f1a2c9» — нет. Пересборка комплекта, не
       * изменившая байты рабочего PDF, метку не двигает: это та же редакция.
       */
      const pdfChanged = document.lastPdfSha256 !== input.documentSha256;
      const pdfRevisionNo = pdfChanged ? document.pdfRevisionNo + 1 : document.pdfRevisionNo;
      documentRevision = `R${String(Math.max(1, pdfRevisionNo))}`;

      await tx
        .update(rdExecDocuments)
        .set({
          syncGeneration,
          pdfRevisionNo: Math.max(1, pdfRevisionNo),
          lastPdfSha256: input.documentSha256,
          updatedAt: sql`now()`,
        })
        .where(eq(rdExecDocuments.folderId, folder.folderId));
    }

    // --- реестр: четыре прохода -------------------------------------------
    const existingRows = await tx
      .select({
        externalBlockId: rdExecBlocks.externalBlockId,
        geometryKey: rdExecBlocks.geometryKey,
        declaredHash: rdExecBlocks.declaredSha256,
        revision: rdExecBlocks.revision,
        layoutBlockId: rdExecBlocks.layoutBlockId,
      })
      .from(rdExecBlocks)
      .where(and(eq(rdExecBlocks.folderId, folder.folderId), isNull(rdExecBlocks.deletedAt)));

    const byLayoutBlock = new Map<string, ExistingRegistryRow>();
    const byGeometry = new Map<string, ExistingRegistryRow[]>();
    for (const row of existingRows) {
      if (row.layoutBlockId !== null) byLayoutBlock.set(row.layoutBlockId, row);
      const bucket = byGeometry.get(row.geometryKey) ?? [];
      bucket.push(row);
      byGeometry.set(row.geometryKey, bucket);
    }
    // Захват по возрастанию идентификатора: два блока с одинаковой геометрией
    // обязаны разбираться детерминированно, а не в порядке выдачи БД.
    for (const bucket of byGeometry.values()) {
      bucket.sort((a, b) => (a.externalBlockId < b.externalBlockId ? -1 : 1));
    }

    const taken = new Set<string>();
    const declarations: BlockDeclaration[] = [];
    const pending: ReconcileBlockInput[] = [];

    // Проход 1: по строке разметки — переживает правку рамки.
    for (const block of input.blocks) {
      const match = byLayoutBlock.get(block.layoutBlockId);
      if (match === undefined || taken.has(match.externalBlockId)) {
        pending.push(block);
        continue;
      }
      taken.add(match.externalBlockId);
      declarations.push({
        layoutBlockId: block.layoutBlockId,
        externalBlockId: match.externalBlockId,
        revision: match.declaredHash === block.declaredHash ? match.revision : match.revision + 1,
        matchedBy: 'layout_block',
      });
    }

    // Проход 2: по геометрии — переживает переразметку с новыми uuid.
    const stillPending: ReconcileBlockInput[] = [];
    for (const block of pending) {
      const bucket = byGeometry.get(block.geometryKey) ?? [];
      const match = bucket.find((row) => !taken.has(row.externalBlockId));
      if (match === undefined) {
        stillPending.push(block);
        continue;
      }
      taken.add(match.externalBlockId);
      declarations.push({
        layoutBlockId: block.layoutBlockId,
        externalBlockId: match.externalBlockId,
        // Геометрия совпала — значит совпал и вырез. Ревизия не растёт, RD WEB
        // отвечает `unchanged`, и модель по этому блоку не вызывается.
        revision: match.declaredHash === block.declaredHash ? match.revision : match.revision + 1,
        matchedBy: 'geometry',
      });
    }

    // Проход 3: остаток — новые идентификаторы из счётчика документа.
    let nextSeq = document.nextBlockSeq;
    for (const block of stillPending) {
      const externalBlockId = externalBlockIdOf(nextSeq);
      nextSeq += 1;
      taken.add(externalBlockId);
      declarations.push({
        layoutBlockId: block.layoutBlockId,
        externalBlockId,
        revision: 1,
        matchedBy: 'new',
      });
    }
    if (nextSeq !== document.nextBlockSeq) {
      await tx
        .update(rdExecDocuments)
        .set({ nextBlockSeq: nextSeq, updatedAt: sql`now()` })
        .where(eq(rdExecDocuments.folderId, folder.folderId));
    }

    // Запись решений.
    const inputById = new Map(input.blocks.map((block) => [block.layoutBlockId, block]));
    for (const declaration of declarations) {
      const block = inputById.get(declaration.layoutBlockId);
      if (block === undefined) continue;
      await tx
        .insert(rdExecBlocks)
        .values({
          folderId: folder.folderId,
          externalBlockId: declaration.externalBlockId,
          geometryKey: block.geometryKey,
          declaredSha256: block.declaredHash,
          revision: declaration.revision,
          layoutBlockId: block.layoutBlockId,
          workingPageIndex: block.workingPageIndex,
          blockType: block.blockType,
          firstAnnouncedGeneration: syncGeneration,
          lastAnnouncedGeneration: syncGeneration,
        })
        .onConflictDoUpdate({
          target: [rdExecBlocks.folderId, rdExecBlocks.externalBlockId],
          set: {
            geometryKey: block.geometryKey,
            declaredSha256: block.declaredHash,
            revision: declaration.revision,
            layoutBlockId: block.layoutBlockId,
            workingPageIndex: block.workingPageIndex,
            blockType: block.blockType,
            lastAnnouncedGeneration: syncGeneration,
            deletedAt: null,
            updatedAt: sql`now()`,
          },
        });
    }

    // Проход 4: строки реестра без пары. В снимок они не попадают (режим
    // `replace` даёт `deleted`), но строка остаётся: «блока нет, потому что вы
    // его удалили» и «блока нет, потому что мы его потеряли» — разные факты.
    const orphaned = existingRows
      .filter((row) => !taken.has(row.externalBlockId))
      .map((row) => row.externalBlockId);
    if (orphaned.length > 0) {
      await tx
        .update(rdExecBlocks)
        .set({ deletedAt: sql`now()`, layoutBlockId: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(rdExecBlocks.folderId, folder.folderId),
            inArray(rdExecBlocks.externalBlockId, orphaned),
          ),
        );
    }

    return {
      folderId: folder.folderId,
      externalProjectId: document.externalProjectId,
      externalDocumentId: document.externalDocumentId,
      documentRevision,
      syncGeneration,
      baseGeneration,
      declarations,
      reused: open !== undefined,
    };
  });
}

// =====================================================================
// Журнал отправок
// =====================================================================

export interface ExecSyncView {
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
  readonly state: ExecSyncRowState;
  readonly remoteState: string | null;
}

/**
 * Строка отправки — ДО сетевого вызова.
 *
 * `external_sync_id` это ключ идемпотентности, и отправка, не дошедшая до
 * ответа, обязана лечиться повтором с тем же ключом. Записав строку ПОСЛЕ
 * вызова, мы теряли бы сам ключ ровно в том случае, ради которого он нужен.
 * Тем же приёмом и по той же причине `rd_run_documents` писалась до PUT.
 */
export async function openExecSync(
  db: Database,
  input: {
    readonly folderId: string;
    readonly recognitionRunId: string;
    readonly externalSyncId: string;
    readonly syncGeneration: number;
    readonly baseGeneration: number;
    readonly manifestSha256: string;
    readonly documentSha256: string;
    readonly documentRevision: string;
    readonly blocksCount: number;
  },
): Promise<ExecSyncView> {
  const rows = await db
    .insert(rdExecSyncs)
    .values({
      folderId: input.folderId,
      recognitionRunId: input.recognitionRunId,
      externalSyncId: input.externalSyncId,
      syncGeneration: input.syncGeneration,
      baseGeneration: input.baseGeneration,
      manifestSha256: input.manifestSha256,
      documentSha256: input.documentSha256,
      documentRevision: input.documentRevision,
      blocksCount: input.blocksCount,
      state: 'preparing',
    })
    .onConflictDoUpdate({
      target: [rdExecSyncs.folderId, rdExecSyncs.externalSyncId],
      set: { manifestSha256: input.manifestSha256, updatedAt: sql`now()` },
    })
    .returning({ id: rdExecSyncs.id });

  const row = rows[0];
  if (row === undefined) {
    throw internal({ logDetail: 'INSERT строки отправки RD WEB не вернул строку' });
  }
  const view = await findExecSync(db, row.id);
  if (view === null) {
    throw internal({ logDetail: 'строка отправки RD WEB не читается сразу после записи' });
  }
  return view;
}

export async function findExecSync(db: Database, syncId: string): Promise<ExecSyncView | null> {
  const rows = await db
    .select({
      id: rdExecSyncs.id,
      folderId: rdExecSyncs.folderId,
      recognitionRunId: rdExecSyncs.recognitionRunId,
      externalSyncId: rdExecSyncs.externalSyncId,
      externalDocumentId: rdExecDocuments.externalDocumentId,
      syncGeneration: rdExecSyncs.syncGeneration,
      baseGeneration: rdExecSyncs.baseGeneration,
      manifestSha256: rdExecSyncs.manifestSha256,
      documentSha256: rdExecSyncs.documentSha256,
      documentRevision: rdExecSyncs.documentRevision,
      blocksCount: rdExecSyncs.blocksCount,
      remoteSyncId: rdExecSyncs.remoteSyncId,
      uploadRequired: rdExecSyncs.uploadRequired,
      uploadAttempts: rdExecSyncs.uploadAttempts,
      state: rdExecSyncs.state,
      remoteState: rdExecSyncs.remoteState,
    })
    .from(rdExecSyncs)
    .innerJoin(rdExecDocuments, eq(rdExecDocuments.folderId, rdExecSyncs.folderId))
    .where(eq(rdExecSyncs.id, syncId))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : { ...row, state: row.state as ExecSyncRowState };
}

/** Действующая отправка прогона: нетерминальная, одна по построению. */
export async function findExecSyncForRun(
  db: Database,
  recognitionRunId: string,
): Promise<ExecSyncView | null> {
  const rows = await db
    .select({ id: rdExecSyncs.id })
    .from(rdExecSyncs)
    .where(eq(rdExecSyncs.recognitionRunId, recognitionRunId))
    .orderBy(sql`${rdExecSyncs.syncGeneration} desc`)
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : findExecSync(db, row.id);
}

export async function recordSyncInitialized(
  db: Database,
  syncId: string,
  input: {
    readonly remoteSyncId: string;
    readonly duplicate: boolean;
    readonly uploadRequired: boolean;
    readonly remoteState: string;
  },
): Promise<void> {
  await db
    .update(rdExecSyncs)
    .set({
      remoteSyncId: input.remoteSyncId,
      duplicate: input.duplicate,
      uploadRequired: input.uploadRequired,
      remoteState: input.remoteState,
      state: 'initialized',
      updatedAt: sql`now()`,
    })
    .where(eq(rdExecSyncs.id, syncId));
}

export async function recordSyncState(
  db: Database,
  syncId: string,
  state: ExecSyncRowState,
  patch: {
    readonly remoteState?: string | undefined;
    readonly allTerminal?: boolean | undefined;
    readonly allSuccessful?: boolean | undefined;
    readonly counters?: Record<string, number> | undefined;
    readonly errorCode?: string | null | undefined;
    readonly errorMessage?: string | null | undefined;
  } = {},
): Promise<void> {
  await db
    .update(rdExecSyncs)
    .set({
      state,
      updatedAt: sql`now()`,
      ...(patch.remoteState === undefined ? {} : { remoteState: patch.remoteState }),
      ...(patch.allTerminal === undefined ? {} : { allTerminal: patch.allTerminal }),
      ...(patch.allSuccessful === undefined ? {} : { allSuccessful: patch.allSuccessful }),
      ...(patch.counters === undefined ? {} : { counters: patch.counters }),
      ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
      ...(patch.errorMessage === undefined ? {} : { errorMessage: patch.errorMessage }),
    })
    .where(eq(rdExecSyncs.id, syncId));
}

/** Круг «загрузили → complete сказал upload_not_verified». Ровно один. */
export async function countUploadAttempt(db: Database, syncId: string): Promise<number> {
  const rows = await db
    .update(rdExecSyncs)
    .set({ uploadAttempts: sql`${rdExecSyncs.uploadAttempts} + 1`, updatedAt: sql`now()` })
    .where(eq(rdExecSyncs.id, syncId))
    .returning({ uploadAttempts: rdExecSyncs.uploadAttempts });
  return rows[0]?.uploadAttempts ?? 0;
}

/**
 * Отправка принята сервером: генерация становится базой для следующей.
 *
 * `base_generation` — это «поверх чего строился снимок», и строим мы поверх
 * ПРИНЯТОГО, а не поверх опубликованного: §4 требует именно этого, и отправка,
 * не дошедшая до `completed`, базой быть не может.
 */
export async function acceptGeneration(
  db: Database,
  folderId: string,
  generation: number,
): Promise<void> {
  await db
    .update(rdExecDocuments)
    .set({ baseGeneration: generation, resyncRequired: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(rdExecDocuments.folderId, folderId),
        sql`${rdExecDocuments.baseGeneration} < ${generation}`,
      ),
    );
}

// =====================================================================
// Разбор конфликтов (§9)
// =====================================================================

/**
 * Снимок разошёлся с сервером: пересобрать, а не повторить.
 *
 * Признак поднимается ЗДЕСЬ, а лечение делает отдельная задача, потому что
 * лечение — это новая генерация и новый круг, то есть работа, а не флаг.
 */
export async function markResyncRequired(db: Database, folderId: string): Promise<void> {
  await db
    .update(rdExecDocuments)
    .set({ resyncRequired: true, updatedAt: sql`now()` })
    .where(eq(rdExecDocuments.folderId, folderId));
}

/**
 * Поднять генерацию выше серверной.
 *
 * Ручки, отдающей действующую `sync_generation` документа, в контракте нет —
 * это записано открытым вопросом к команде RD WEB. Пока её нет, единственное
 * лечение `stale_generation` — шагнуть вперёд и повторить снимок, и потолок
 * кругов обязателен: без него портал крутил бы 409 бесконечно.
 */
export async function liftGeneration(
  db: Database,
  folderId: string,
  atLeast: number,
): Promise<number> {
  const rows = await db
    .update(rdExecDocuments)
    .set({
      syncGeneration: sql`greatest(${rdExecDocuments.syncGeneration}, ${atLeast})`,
      updatedAt: sql`now()`,
    })
    .where(eq(rdExecDocuments.folderId, folderId))
    .returning({ syncGeneration: rdExecDocuments.syncGeneration });
  return rows[0]?.syncGeneration ?? atLeast;
}

/** Поднять ревизии блоков выше объявленных сервером (409 block_revision_conflict). */
export async function liftBlockRevisions(
  db: Database,
  folderId: string,
  remote: readonly { readonly externalBlockId: string; readonly revision: number }[],
): Promise<void> {
  if (remote.length === 0) return;
  await db.transaction(async (tx) => {
    for (const row of remote) {
      await tx
        .update(rdExecBlocks)
        .set({
          revision: sql`greatest(${rdExecBlocks.revision}, ${row.revision + 1})`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(rdExecBlocks.folderId, folderId),
            eq(rdExecBlocks.externalBlockId, row.externalBlockId),
          ),
        );
    }
  });
}

// =====================================================================
// Чтение реестра
// =====================================================================

export interface DeclaredBlockView {
  readonly externalBlockId: string;
  readonly revision: number;
  readonly layoutBlockId: string | null;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
}

/**
 * Объявленные блоки документа — вход гейта целостности при заборе результатов.
 *
 * `GET /documents/{id}/blocks` отдаёт ПОСЛЕДНИЕ результаты документа, а не
 * результаты нашей отправки: ради этого различия в ответе и существует
 * `external_block_revision`. Без сверки с объявленным вытесненная отправка
 * молча подложила бы результаты другого набора блоков.
 */
export async function listDeclaredBlocks(
  db: Database,
  folderId: string,
): Promise<readonly DeclaredBlockView[]> {
  const rows = await db
    .select({
      externalBlockId: rdExecBlocks.externalBlockId,
      revision: rdExecBlocks.revision,
      layoutBlockId: rdExecBlocks.layoutBlockId,
      workingPageIndex: rdExecBlocks.workingPageIndex,
      blockType: rdExecBlocks.blockType,
    })
    .from(rdExecBlocks)
    .where(and(eq(rdExecBlocks.folderId, folderId), isNull(rdExecBlocks.deletedAt)))
    .orderBy(rdExecBlocks.externalBlockId);
  return rows.map((row) => ({ ...row, blockType: row.blockType as BlockType }));
}

export interface ExecDocumentNaming {
  /** Наименование объекта — `project_name` контракта. */
  readonly projectName: string;
  /** Раздел и заголовок папки — `document_name` контракта. */
  readonly documentName: string;
}

/**
 * Человекочитаемые имена для снимка.
 *
 * Читаются одним запросом здесь, а не собираются вызывающим из двух чтений:
 * поля попадают в канонический хеш манифеста, и собранные по-разному в двух
 * местах они дали бы два разных хеша на одном и том же документе.
 */
export async function loadDocumentNaming(
  db: Database,
  folderId: string,
): Promise<ExecDocumentNaming> {
  const rows = await db
    .select({
      objectName: constructionObjects.name,
      sectionCode: folders.sectionCode,
      title: folders.title,
    })
    .from(folders)
    .innerJoin(constructionObjects, eq(constructionObjects.id, folders.objectId))
    .where(eq(folders.id, folderId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound('Папка не найдена.');
  return {
    projectName: row.objectName,
    documentName: `${row.sectionCode} — ${row.title}`,
  };
}

/** Есть ли у папки строки разметки, на которые смотрит реестр. Для тестов и диагностики. */
export async function countLinkedBlocks(db: Database, folderId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rdExecBlocks)
    .innerJoin(layoutBlocks, eq(layoutBlocks.id, rdExecBlocks.layoutBlockId))
    .where(eq(rdExecBlocks.folderId, folderId));
  return rows[0]?.count ?? 0;
}
