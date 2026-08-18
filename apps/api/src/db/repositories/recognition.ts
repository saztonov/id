/**
 * Прогоны распознавания, неизменяемые артефакты и распознанный текст (§3.5, §5.2).
 *
 * ## Что здесь считается доказательством
 *
 * Прогон хранит ТРИ хэша разметки, и они доказывают разное: `local_layout_hash`
 * — что заказывали, `remote_layout_hash_before` — что стояло у RD WEB перед
 * стартом OCR, `remote_layout_hash_after` — что стояло там после. Расхождение
 * любой пары переводит прогон в `integrity_error`, и результаты не
 * используются. Именно поэтому запись хэшей и запись статуса — разные функции:
 * «хэш совпал» обязано быть отдельным зафиксированным фактом, а не побочным
 * следствием того, что задача не упала.
 *
 * ## Что здесь неизменяемо
 *
 * `artifact_versions` и `page_text_versions` заперты триггерами (0008), а
 * `artifact_versions_run_kind_uq` делает ВТОРОЙ артефакт того же вида в прогоне
 * нарушением ограничения. Это и есть механизм «забор экспорта ровно один раз»:
 * он держится БД, а не аккуратностью обработчика. `recordArtifact()` поэтому
 * возвращает исход, а не бросает — повторный забор обязан быть отличим от
 * сбоя записи.
 *
 * ## Область видимости
 *
 * Ни один запрос файла не выполняется без `withScope()`. У `recognition_runs`
 * есть денормализованный `revision_id`, но `object_id`/`contractor_id` живут на
 * ревизии поставки, поэтому область применяется соединением с
 * `submission_revisions` — как в `layout.ts` и `bundles.ts`. Подрядчик не видит
 * чужой прогон ни списком, ни по прямому идентификатору, ни через выдачу файла
 * артефакта: ключ объекта в хранилище выдаётся только тем же соединением.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  artifactVersions,
  blockResults,
  currentBlockResult,
  layoutBlocks,
  layoutRevisions,
  pageTextVersions,
  processingBundlePages,
  rdRunDocuments,
  recognitionRuns,
  submissionRevisions,
} from '@id/db';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, internal, notFound } from '../../lib/problem.js';
import { artifactKey, type ArtifactKind } from '../../storage/keys.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendRevisionEvent } from './jobs.js';
import type { Database } from './users.js';

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

export type RecognitionRunStatus = 'running' | 'done' | 'integrity_error' | 'failed';

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['done', 'integrity_error', 'failed']);

export interface RecognitionRunView {
  readonly id: string;
  readonly revisionId: string;
  readonly objectId: string;
  readonly layoutRevisionId: string;
  readonly rdRunDocumentId: string;
  readonly rdDocumentId: string;
  readonly rdJobId: string | null;
  readonly localLayoutHash: string;
  readonly remoteLayoutHashBefore: string | null;
  readonly remoteLayoutHashAfter: string | null;
  readonly workingPdfSha256: string;
  readonly settingsSnapshot: unknown;
  readonly status: RecognitionRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly counts: Record<string, unknown>;
  readonly warnings: readonly unknown[];
  readonly runDocumentClosedAt: string | null;
}

const isoAt = (column: unknown, alias: string) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    alias,
  );

const RUN_SELECTION = {
  id: recognitionRuns.id,
  revisionId: recognitionRuns.revisionId,
  objectId: submissionRevisions.objectId,
  layoutRevisionId: recognitionRuns.layoutRevisionId,
  rdRunDocumentId: recognitionRuns.rdRunDocumentId,
  rdDocumentId: rdRunDocuments.rdDocumentId,
  rdJobId: recognitionRuns.rdJobId,
  localLayoutHash: recognitionRuns.localLayoutHash,
  remoteLayoutHashBefore: recognitionRuns.remoteLayoutHashBefore,
  remoteLayoutHashAfter: recognitionRuns.remoteLayoutHashAfter,
  workingPdfSha256: recognitionRuns.workingPdfSha256,
  settingsSnapshot: recognitionRuns.settingsSnapshot,
  status: recognitionRuns.status,
  startedAt: isoAt(recognitionRuns.startedAt, 'started_at_iso'),
  finishedAt: isoAt(recognitionRuns.finishedAt, 'finished_at_iso'),
  counts: recognitionRuns.counts,
  warnings: recognitionRuns.warnings,
  runDocumentClosedAt: isoAt(rdRunDocuments.closedAt, 'run_document_closed_at_iso'),
};

function toView(row: Record<string, unknown>): RecognitionRunView {
  return {
    ...(row as unknown as RecognitionRunView),
    status: row.status as RecognitionRunStatus,
    startedAt: (row.startedAt as string | null) ?? '',
    counts: (row.counts ?? {}) as Record<string, unknown>,
    warnings: (row.warnings ?? []) as readonly unknown[],
  };
}

function runQuery(db: Database, scope: AuthScope, ...conditions: SQL[]) {
  return db
    .select(RUN_SELECTION)
    .from(recognitionRuns)
    .innerJoin(rdRunDocuments, eq(recognitionRuns.rdRunDocumentId, rdRunDocuments.id))
    .innerJoin(submissionRevisions, eq(recognitionRuns.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, ...conditions));
}

export async function findRecognitionRun(
  db: Database,
  scope: AuthScope,
  runId: string,
): Promise<RecognitionRunView | null> {
  const rows = await runQuery(db, scope, eq(recognitionRuns.id, runId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

export async function listRecognitionRuns(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<readonly RecognitionRunView[]> {
  const rows = await runQuery(db, scope, eq(recognitionRuns.revisionId, revisionId)).orderBy(
    desc(recognitionRuns.startedAt),
  );
  return rows.map(toView);
}

/** Прогон конкретной ревизии разметки: их не больше одного незавершённого. */
export async function findRunForLayout(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
): Promise<RecognitionRunView | null> {
  const rows = await runQuery(
    db,
    scope,
    eq(recognitionRuns.layoutRevisionId, layoutRevisionId),
  ).orderBy(desc(recognitionRuns.startedAt));
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

// =====================================================================
// Создание прогона
// =====================================================================

export interface StartRunInput {
  readonly layoutRevisionId: string;
  readonly settingsSnapshot: Record<string, unknown>;
}

export interface StartRunResult {
  readonly run: RecognitionRunView;
  readonly created: boolean;
}

/**
 * Создание прогона по ЗАМОРОЖЕННОЙ ревизии разметки.
 *
 * Все входные пины (`local_layout_hash`, `working_pdf_sha256`,
 * `rd_run_document_id`) читаются здесь из БД, а не приходят параметрами: они
 * доказывают, ЧТО заказано, и принимать их от вызывающего значило бы позволить
 * ему заказать одно, а записать другое.
 *
 * Идемпотентность — по домену, а не по заголовку: незавершённый прогон этой
 * ревизии разметки возвращается как есть. Повторное нажатие кнопки — это второй
 * прогон на GPU и второй экспорт, то есть ровно то, что §5.2 запрещает.
 */
export async function startRecognitionRun(
  db: Database,
  scope: AuthScope,
  input: StartRunInput,
): Promise<StartRunResult> {
  const layout = await db
    .select({
      id: layoutRevisions.id,
      revisionId: layoutRevisions.revisionId,
      state: layoutRevisions.state,
      blocksHash: layoutRevisions.blocksHash,
      bundleId: layoutRevisions.bundleId,
      submissionStatus: submissionRevisions.status,
    })
    .from(layoutRevisions)
    .innerJoin(submissionRevisions, eq(layoutRevisions.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, eq(layoutRevisions.id, input.layoutRevisionId)))
    .limit(1);

  const found = layout[0];
  if (found === undefined) throw notFound('Ревизия разметки не найдена.');
  if (found.state !== 'frozen' || found.blocksHash === null) {
    throw conflict(
      'На распознавание отправляется только замороженная ревизия разметки: ' +
        'сначала POST /layouts/{id}/freeze.',
    );
  }

  const existing = await findRunForLayout(db, scope, input.layoutRevisionId);
  if (existing !== null && !TERMINAL_RUN_STATUSES.has(existing.status)) {
    return { run: existing, created: false };
  }
  if (existing !== null && existing.runDocumentClosedAt !== null) {
    // Документ прогона закрыт (§5.2, шаг 9) — переиспользовать его нельзя, и
    // это не ошибка вызывающего, а конец жизненного цикла этой разметки.
    throw conflict(
      `Прогон по этой ревизии разметки уже завершён (${existing.status}), ` +
        'а RD-документ закрыт: для нового распознавания нужна новая ревизия разметки.',
    );
  }

  const runDocument = await db
    .select({ id: rdRunDocuments.id, closedAt: rdRunDocuments.closedAt })
    .from(rdRunDocuments)
    .where(eq(rdRunDocuments.layoutRevisionId, input.layoutRevisionId))
    .limit(1);
  const document = runDocument[0];
  if (document === undefined) {
    throw conflict('RD-документ прогона не создан: цепочка разметки не была выполнена.');
  }
  if (document.closedAt !== null) {
    throw conflict('RD-документ прогона закрыт: требуется новая ревизия разметки.');
  }

  const bundle = await db
    .select({ sha256: sql<string>`pb.working_pdf_blob_sha256` })
    .from(sql`processing_bundles pb`)
    .where(sql`pb.id = ${found.bundleId}::uuid`)
    .limit(1);
  const workingPdfSha256 = bundle[0]?.sha256;
  if (workingPdfSha256 === undefined) {
    throw internal({ logDetail: 'рабочий документ ревизии разметки не найден' });
  }

  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(recognitionRuns)
      .values({
        revisionId: found.revisionId,
        layoutRevisionId: found.id,
        rdRunDocumentId: document.id,
        localLayoutHash: found.blocksHash as string,
        workingPdfSha256,
        settingsSnapshot: input.settingsSnapshot,
        status: 'running',
      })
      .returning({ id: recognitionRuns.id });

    await appendRevisionEvent(tx, {
      revisionId: found.revisionId,
      eventType: 'recognition.started',
      payload: {
        layoutRevisionId: found.id,
        recognitionRunId: rows[0]?.id ?? null,
        localLayoutHash: found.blocksHash,
      },
    });
    return rows[0]?.id ?? null;
  });

  if (inserted === null) throw internal({ logDetail: 'прогон распознавания не записался' });
  const run = await findRecognitionRun(db, scope, inserted);
  if (run === null) throw internal({ logDetail: 'прогон не читается сразу после записи' });
  return { run, created: true };
}

// =====================================================================
// Отметки хода прогона
// =====================================================================

/**
 * Запись совпавшего удалённого хэша ДО старта OCR (§5.2, шаг 5).
 *
 * Записывается только совпадение: несовпадение — это `integrity_error`, а не
 * «запишем и посмотрим». Запись расходящегося значения в
 * `remote_layout_hash_before` сделала бы прогон, у которого хэши разошлись,
 * неотличимым от прогона, у которого они совпали.
 */
export async function saveRemoteHashBefore(
  db: Database,
  scope: AuthScope,
  runId: string,
  remoteHash: string,
): Promise<void> {
  const run = await requireRunningRun(db, scope, runId);
  if (run.localLayoutHash !== remoteHash) {
    throw conflict('Удалённый хэш разметки не совпал с локальным: сверка не завершена.');
  }
  await db
    .update(recognitionRuns)
    .set({ remoteLayoutHashBefore: remoteHash })
    .where(eq(recognitionRuns.id, runId));
}

export async function saveRdJobId(
  db: Database,
  scope: AuthScope,
  runId: string,
  rdJobId: string,
): Promise<void> {
  await requireRunningRun(db, scope, runId);
  await db.update(recognitionRuns).set({ rdJobId }).where(eq(recognitionRuns.id, runId));
}

async function requireRunningRun(
  db: Database,
  scope: AuthScope,
  runId: string,
): Promise<RecognitionRunView> {
  const run = await findRecognitionRun(db, scope, runId);
  if (run === null) throw notFound('Прогон распознавания не найден.');
  if (run.status !== 'running') {
    throw conflict(`Прогон уже завершён со статусом ${run.status}: изменить его нельзя.`);
  }
  return run;
}

/**
 * Третий хэш (`remote_layout_hash_after`) пишется ТОЛЬКО через
 * `finishRecognitionRun`, и отдельного писателя у него нет намеренно.
 *
 * Он фиксирует состояние удалённого набора на момент, когда прогон закончился, —
 * то есть по смыслу это часть исхода, а не самостоятельная отметка хода. Ранее
 * здесь жил экспортированный `saveRemoteHashAfter()`, которого не вызывал никто:
 * два пути записи одного доказательства расходятся при первой же правке, и
 * писатель, притворяющийся работающим, — это отказ S3.
 */
export interface FinishRunInput {
  readonly runId: string;
  readonly status: Exclude<RecognitionRunStatus, 'running'>;
  readonly counts?: Record<string, unknown> | undefined;
  readonly warnings?: readonly unknown[] | undefined;
  /** Записывается только у неуспешных исходов: у успешного он совпал по определению. */
  readonly remoteLayoutHashAfter?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * Завершение прогона — единственный путь из `running`.
 *
 * Идемпотентно по построению: `where status = 'running'` не даст переписать уже
 * вынесенный исход. Повтор задачи, дошедшей до конца, обязан увидеть тот же
 * результат, а не переоформить `integrity_error` в `done`.
 */
export async function finishRecognitionRun(
  db: Database,
  scope: AuthScope,
  input: FinishRunInput,
): Promise<{ readonly changed: boolean; readonly status: RecognitionRunStatus }> {
  const run = await findRecognitionRun(db, scope, input.runId);
  if (run === null) throw notFound('Прогон распознавания не найден.');
  if (run.status !== 'running') return { changed: false, status: run.status };

  return db.transaction(async (tx) => {
    const updated = await tx.execute<{ status: string }>(sql`
      update ${recognitionRuns}
         set status = ${input.status},
             finished_at = now(),
             counts = ${JSON.stringify(input.counts ?? {})}::jsonb,
             warnings = ${JSON.stringify(input.warnings ?? [])}::jsonb,
             remote_layout_hash_after = coalesce(
               ${input.remoteLayoutHashAfter ?? null}, ${recognitionRuns.remoteLayoutHashAfter})
       where ${recognitionRuns.id} = ${input.runId}::uuid
         and ${recognitionRuns.status} = 'running'
      returning status
    `);
    const row = updated.rows[0];
    if (row === undefined) return { changed: false, status: run.status };

    await appendRevisionEvent(tx, {
      revisionId: run.revisionId,
      eventType: input.status === 'done' ? 'recognition.done' : 'recognition.failed',
      payload: {
        recognitionRunId: input.runId,
        layoutRevisionId: run.layoutRevisionId,
        status: input.status,
        reason: input.reason ?? null,
        counts: input.counts ?? {},
      },
    });
    return { changed: true, status: input.status };
  });
}

// =====================================================================
// Закрытие RD-документа (§5.2, шаг 9 — долг, оставленный S6)
// =====================================================================

/**
 * Отметка «портал больше не работает с этим RD-документом».
 *
 * Настоящей операции закрытия у RD WEB нет (ADR-0004 §7): есть только удаление,
 * а удалять нельзя — блоки и экспорт остаются доказательством того, ЧТО именно
 * распознавали. Поэтому закрытие фиксируется у нас, и с этого момента
 * `startRecognitionRun` отказывает в новом прогоне по той же разметке.
 *
 * Идемпотентно: `where closed_at is null` делает повтор задачи безвредным и
 * при этом отличимым — вызывающий видит `changed: false`.
 */
export async function closeRunDocument(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
): Promise<{ readonly changed: boolean; readonly rdDocumentId: string }> {
  const rows = await db
    .select({
      id: rdRunDocuments.id,
      rdDocumentId: rdRunDocuments.rdDocumentId,
      revisionId: layoutRevisions.revisionId,
      closedAt: rdRunDocuments.closedAt,
    })
    .from(rdRunDocuments)
    .innerJoin(layoutRevisions, eq(rdRunDocuments.layoutRevisionId, layoutRevisions.id))
    .innerJoin(submissionRevisions, eq(layoutRevisions.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, eq(rdRunDocuments.layoutRevisionId, layoutRevisionId)))
    .limit(1);

  const found = rows[0];
  if (found === undefined) throw notFound('RD-документ прогона не найден.');
  if (found.closedAt !== null) return { changed: false, rdDocumentId: found.rdDocumentId };

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(rdRunDocuments)
      .set({ closedAt: sql`now()` })
      .where(and(eq(rdRunDocuments.id, found.id), isNull(rdRunDocuments.closedAt)))
      .returning({ id: rdRunDocuments.id });
    if (updated.length === 0) return { changed: false, rdDocumentId: found.rdDocumentId };

    await appendRevisionEvent(tx, {
      revisionId: found.revisionId,
      eventType: 'layout.run_document_closed',
      payload: { layoutRevisionId, rdDocumentId: found.rdDocumentId },
    });
    return { changed: true, rdDocumentId: found.rdDocumentId };
  });
}

// =====================================================================
// Артефакты
// =====================================================================

export interface ArtifactView {
  readonly id: string;
  readonly recognitionRunId: string;
  readonly kind: ArtifactKind;
  readonly s3Key: string;
  readonly artifactSha256: string;
  readonly byteSize: number;
}

export type RecordArtifactOutcome =
  | { readonly kind: 'recorded'; readonly artifact: ArtifactView }
  | { readonly kind: 'already'; readonly artifact: ArtifactView };

/**
 * Запись артефакта прогона.
 *
 * `on conflict do nothing` по `(recognition_run_id, kind)` плюс перечитывание —
 * это и есть механизм однократности: вторая попытка забора не создаёт вторую
 * строку и, что важнее, ВИДИТ первую и её `artifact_sha256`. Вызывающий обязан
 * сверить хэш повторного забора с записанным: расхождение означает, что
 * удалённая сторона отдала другие байты, то есть результат уже не описывает
 * заказанное.
 */
export async function recordArtifact(
  db: Database,
  scope: AuthScope,
  input: {
    readonly recognitionRunId: string;
    readonly kind: ArtifactKind;
    readonly artifactSha256: string;
    readonly byteSize: number;
  },
): Promise<RecordArtifactOutcome> {
  const run = await findRecognitionRun(db, scope, input.recognitionRunId);
  if (run === null) throw notFound('Прогон распознавания не найден.');

  const key = artifactKey(input.recognitionRunId, input.kind);
  await db
    .insert(artifactVersions)
    .values({
      recognitionRunId: input.recognitionRunId,
      kind: input.kind,
      s3Key: key,
      artifactSha256: input.artifactSha256,
      byteSize: input.byteSize,
    })
    .onConflictDoNothing();

  const artifact = await findArtifact(db, scope, input.recognitionRunId, input.kind);
  if (artifact === null) throw internal({ logDetail: 'артефакт не читается сразу после записи' });
  return artifact.artifactSha256 === input.artifactSha256 && artifact.byteSize === input.byteSize
    ? { kind: 'recorded', artifact }
    : { kind: 'already', artifact };
}

export async function findArtifact(
  db: Database,
  scope: AuthScope,
  recognitionRunId: string,
  kind: ArtifactKind,
): Promise<ArtifactView | null> {
  const rows = await artifactQuery(db)
    .where(
      withScope(
        scope,
        REVISION_SCOPE,
        eq(artifactVersions.recognitionRunId, recognitionRunId),
        eq(artifactVersions.kind, kind),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { ...row, kind: row.kind as ArtifactKind };
}

export async function listArtifacts(
  db: Database,
  scope: AuthScope,
  recognitionRunId: string,
): Promise<readonly ArtifactView[]> {
  const rows = await artifactQuery(db)
    .where(
      withScope(scope, REVISION_SCOPE, eq(artifactVersions.recognitionRunId, recognitionRunId)),
    )
    .orderBy(asc(artifactVersions.kind));
  return rows.map((row) => ({ ...row, kind: row.kind as ArtifactKind }));
}

function artifactQuery(db: Database) {
  return db
    .select({
      id: artifactVersions.id,
      recognitionRunId: artifactVersions.recognitionRunId,
      kind: artifactVersions.kind,
      s3Key: artifactVersions.s3Key,
      artifactSha256: artifactVersions.artifactSha256,
      byteSize: artifactVersions.byteSize,
    })
    .from(artifactVersions)
    .innerJoin(recognitionRuns, eq(artifactVersions.recognitionRunId, recognitionRuns.id))
    .innerJoin(submissionRevisions, eq(recognitionRuns.revisionId, submissionRevisions.id));
}

// =====================================================================
// Текст страниц и результаты блоков
// =====================================================================

export interface PageTextView {
  readonly id: string;
  readonly sourcePageId: string;
  readonly workingPageIndex: number | null;
  readonly recognitionRunId: string;
  readonly artifactVersionId: string;
  readonly textMd: string;
  readonly textSha256: string;
  readonly offsetConvention: string;
}

export async function listPageTexts(
  db: Database,
  scope: AuthScope,
  recognitionRunId: string,
): Promise<readonly PageTextView[]> {
  const rows = await db
    .select({
      id: pageTextVersions.id,
      sourcePageId: pageTextVersions.sourcePageId,
      workingPageIndex: processingBundlePages.workingPageIndex,
      recognitionRunId: pageTextVersions.recognitionRunId,
      artifactVersionId: pageTextVersions.artifactVersionId,
      textMd: pageTextVersions.textMd,
      textSha256: pageTextVersions.textSha256,
      offsetConvention: pageTextVersions.offsetConvention,
    })
    .from(pageTextVersions)
    .innerJoin(recognitionRuns, eq(pageTextVersions.recognitionRunId, recognitionRuns.id))
    .innerJoin(submissionRevisions, eq(pageTextVersions.revisionId, submissionRevisions.id))
    .innerJoin(layoutRevisions, eq(recognitionRuns.layoutRevisionId, layoutRevisions.id))
    .leftJoin(
      processingBundlePages,
      and(
        eq(processingBundlePages.bundleId, layoutRevisions.bundleId),
        eq(processingBundlePages.sourcePageId, pageTextVersions.sourcePageId),
      ),
    )
    .where(
      withScope(scope, REVISION_SCOPE, eq(pageTextVersions.recognitionRunId, recognitionRunId)),
    )
    .orderBy(asc(processingBundlePages.workingPageIndex));
  return rows;
}

export interface SavePageTextInput {
  readonly workingPageIndex: number;
  readonly textMd: string;
}

export interface SaveBlockResultInput {
  readonly layoutBlockId: string;
  readonly resultType: string;
  readonly contentHtml: string | null;
  readonly contentMd: string | null;
  readonly contentJson: unknown;
  readonly modelId: string | null;
  readonly confidence: number | null;
}

export interface SaveResultsInput {
  readonly recognitionRunId: string;
  readonly artifactVersionId: string;
  readonly pages: readonly SavePageTextInput[];
  readonly blocks: readonly SaveBlockResultInput[];
}

export interface SaveResultsOutcome {
  readonly pagesWritten: number;
  /** Страница этого прогона уже была записана: штатный повтор задачи. */
  readonly pagesAlreadyPresent: number;
  /** Номер страницы вне рабочего документа: отдельная причина, не «пропущено». */
  readonly pagesOutOfRange: number;
  readonly blocksWritten: number;
  /** Результат блока в этом прогоне уже записан: штатный повтор задачи. */
  readonly blocksAlreadyPresent: number;
  /** Блок не принадлежит замороженной разметке прогона. */
  readonly blocksUnknown: number;
}

/**
 * Запись распознанного текста и результатов блоков ОДНОЙ транзакцией.
 *
 * ## Почему одной
 *
 * `page_text_versions` ссылается на артефакт, `block_results` — на прогон, а
 * `current_block_result` — на конкретный результат. Разорванная посередине
 * запись оставила бы прогон, у которого текст страниц есть, а указателей
 * «текущий результат» нет, и отличить это от «блоки не распознались» было бы
 * нечем.
 *
 * ## Почему повтор безопасен
 *
 * Не «обе таблицы неизменяемы» — это было бы неправдой, и точность здесь имеет
 * значение. Заперты БЕЗУСЛОВНО (0008, п. 3) только `artifact_versions` и
 * `page_text_versions`: у них триггеры на UPDATE и DELETE без всяких условий.
 * `block_results` и указатель `current_block_result` покрыты триггером класса
 * `derived` (0008, п. 7.3), то есть запираются лишь с переходом ревизии
 * поставки в терминальный статус; до него повторное распознавание законно и
 * указатель обязан двигаться. Значит безопасность повтора держится здесь НЕ
 * запретом БД, а явным пропуском уже записанного: страницы отсекаются по
 * `page_text_versions_page_run_uq` и по прочитанному множеству, блоки — по
 * множеству уже записанных блоков ЭТОГО прогона. Итог тот же: задача,
 * выполненная дважды, даёт то же состояние, а не удваивает его и не падает на
 * ограничении.
 *
 * ## Почему пропуски различаются по причинам
 *
 * «Страница уже записана» и «страницы с таким номером в рабочем документе нет» —
 * это разные факты: первый — штатный повтор, второй — экспорт, описывающий не
 * тот документ, который заказан. Пока они складывались в один `pagesSkipped`,
 * второй был неотличим от первого и уходил в успешный прогон молча. Поэтому
 * счётчики разведены, а батч со страницей вне диапазона не пишется ВООБЩЕ:
 * прогон, который сейчас будет остановлен, не имеет права оставить за собой
 * половину неизменяемого текста страниц.
 */
export async function saveRecognitionResults(
  db: Database,
  scope: AuthScope,
  input: SaveResultsInput,
): Promise<SaveResultsOutcome> {
  const run = await findRecognitionRun(db, scope, input.recognitionRunId);
  if (run === null) throw notFound('Прогон распознавания не найден.');

  const pageMap = await loadPageMap(db, scope, run.layoutRevisionId);
  const existingPages = new Set(
    (
      await db
        .select({ sourcePageId: pageTextVersions.sourcePageId })
        .from(pageTextVersions)
        .where(eq(pageTextVersions.recognitionRunId, input.recognitionRunId))
    ).map((row) => row.sourcePageId),
  );

  const knownBlocks = new Set(
    (
      await db
        .select({ id: layoutBlocks.id })
        .from(layoutBlocks)
        .where(eq(layoutBlocks.layoutRevisionId, run.layoutRevisionId))
    ).map((row) => row.id),
  );
  const existingResults = new Set(
    (
      await db
        .select({ blockId: blockResults.layoutBlockId })
        .from(blockResults)
        .where(eq(blockResults.recognitionRunId, input.recognitionRunId))
    ).map((row) => row.blockId),
  );

  // Разрешение номеров страниц ДО транзакции: батч, в котором есть страница вне
  // рабочего документа, не пишется вовсе.
  const pagesOutOfRange = input.pages.filter(
    (page) => pageMap.get(page.workingPageIndex) === undefined,
  ).length;
  if (pagesOutOfRange > 0) {
    return {
      pagesWritten: 0,
      pagesAlreadyPresent: 0,
      pagesOutOfRange,
      blocksWritten: 0,
      blocksAlreadyPresent: 0,
      blocksUnknown: 0,
    };
  }

  return db.transaction(async (tx) => {
    let pagesWritten = 0;
    let pagesAlreadyPresent = 0;
    for (const page of input.pages) {
      const sourcePageId = pageMap.get(page.workingPageIndex);
      if (sourcePageId === undefined || existingPages.has(sourcePageId)) {
        pagesAlreadyPresent += 1;
        continue;
      }
      await tx.insert(pageTextVersions).values({
        revisionId: run.revisionId,
        sourcePageId,
        recognitionRunId: input.recognitionRunId,
        artifactVersionId: input.artifactVersionId,
        textMd: page.textMd,
        textSha256: createHash('sha256').update(page.textMd, 'utf8').digest('hex'),
      });
      pagesWritten += 1;
    }

    let blocksWritten = 0;
    let blocksAlreadyPresent = 0;
    let blocksUnknown = 0;
    for (const block of input.blocks) {
      if (!knownBlocks.has(block.layoutBlockId)) {
        blocksUnknown += 1;
        continue;
      }
      if (existingResults.has(block.layoutBlockId)) {
        blocksAlreadyPresent += 1;
        continue;
      }
      const rows = await tx
        .insert(blockResults)
        .values({
          layoutRevisionId: run.layoutRevisionId,
          layoutBlockId: block.layoutBlockId,
          recognitionRunId: input.recognitionRunId,
          resultType: block.resultType,
          contentHtml: block.contentHtml,
          contentMd: block.contentMd,
          contentJson: block.contentJson ?? null,
          modelId: block.modelId,
          confidence: block.confidence,
        })
        .returning({ id: blockResults.id });
      const resultId = rows[0]?.id;
      if (resultId === undefined) continue;

      await tx
        .insert(currentBlockResult)
        .values({ layoutBlockId: block.layoutBlockId, blockResultId: resultId })
        .onConflictDoUpdate({
          target: currentBlockResult.layoutBlockId,
          set: { blockResultId: resultId, updatedAt: sql`now()` },
        });
      blocksWritten += 1;
    }

    return {
      pagesWritten,
      pagesAlreadyPresent,
      pagesOutOfRange: 0,
      blocksWritten,
      blocksAlreadyPresent,
      blocksUnknown,
    };
  });
}

/** Карта «страница рабочего документа → исходная страница» ревизии разметки. */
async function loadPageMap(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
): Promise<ReadonlyMap<number, string>> {
  const rows = await db
    .select({
      workingPageIndex: processingBundlePages.workingPageIndex,
      sourcePageId: processingBundlePages.sourcePageId,
    })
    .from(processingBundlePages)
    .innerJoin(layoutRevisions, eq(layoutRevisions.bundleId, processingBundlePages.bundleId))
    .innerJoin(submissionRevisions, eq(layoutRevisions.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, eq(layoutRevisions.id, layoutRevisionId)));
  return new Map(rows.map((row) => [row.workingPageIndex, row.sourcePageId]));
}

/** Результаты блоков прогона — для чтения наружу и для проверок последствий. */
export async function listBlockResults(
  db: Database,
  scope: AuthScope,
  runId: string,
): Promise<
  readonly {
    readonly layoutBlockId: string;
    readonly resultType: string;
    readonly contentMd: string | null;
    readonly modelId: string | null;
    readonly confidence: number | null;
    readonly isCurrent: boolean;
  }[]
> {
  const rows = await db
    .select({
      layoutBlockId: blockResults.layoutBlockId,
      resultType: blockResults.resultType,
      contentMd: blockResults.contentMd,
      modelId: blockResults.modelId,
      confidence: blockResults.confidence,
      currentId: currentBlockResult.blockResultId,
      id: blockResults.id,
    })
    .from(blockResults)
    .innerJoin(recognitionRuns, eq(blockResults.recognitionRunId, recognitionRuns.id))
    .innerJoin(submissionRevisions, eq(recognitionRuns.revisionId, submissionRevisions.id))
    .leftJoin(currentBlockResult, eq(currentBlockResult.layoutBlockId, blockResults.layoutBlockId))
    .where(withScope(scope, REVISION_SCOPE, eq(blockResults.recognitionRunId, runId)))
    .orderBy(asc(blockResults.layoutBlockId));

  return rows.map((row) => ({
    layoutBlockId: row.layoutBlockId,
    resultType: row.resultType,
    contentMd: row.contentMd,
    modelId: row.modelId,
    confidence: row.confidence,
    isCurrent: row.currentId === row.id,
  }));
}
