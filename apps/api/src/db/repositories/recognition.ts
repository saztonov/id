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
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  artifactVersions,
  blockResults,
  currentBlockResult,
  layoutBlocks,
  layoutRevisions,
  pageTextVersions,
  processingBundlePages,
  rdRunDocuments,
  recognitionRunPages,
  recognitionRuns,
  submissionRevisions,
} from '@id/db';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, internal, notFound } from '../../lib/problem.js';
import { artifactKey, type ArtifactKind } from '../../storage/keys.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendRevisionEvent, enqueueSystemJob } from './jobs.js';
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
  /**
   * `null` — прогон ветки VLM (ADR-0007): RD-документа у него нет по
   * построению. Легаси-обработчики, которым RD-документ обязателен,
   * проверяют это явно, а не полагаются на тип.
   */
  readonly rdRunDocumentId: string | null;
  readonly rdDocumentId: string | null;
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
  /** Сколько раундов дораспознавания уже потратила финализация (S28). */
  readonly recoveryRound: number;
  /** Прогон, который этот восстанавливает; `null` — обычный прогон (S28). */
  readonly repairOfRunId: string | null;
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
  recoveryRound: recognitionRuns.recoveryRound,
  repairOfRunId: recognitionRuns.repairOfRunId,
};

function toView(row: Record<string, unknown>): RecognitionRunView {
  return {
    ...(row as unknown as RecognitionRunView),
    status: row.status as RecognitionRunStatus,
    startedAt: (row.startedAt as string | null) ?? '',
    counts: (row.counts ?? {}) as Record<string, unknown>,
    warnings: (row.warnings ?? []) as readonly unknown[],
    recoveryRound: (row.recoveryRound as number | null) ?? 0,
  };
}

function runQuery(db: Database, scope: AuthScope, ...conditions: SQL[]) {
  return (
    db
      .select(RUN_SELECTION)
      .from(recognitionRuns)
      // LEFT JOIN, а не INNER: у VLM-прогона rd_run_document_id NULL (0019), и
      // внутреннее соединение молча выкинуло бы такие прогоны из всех выборок —
      // они «исчезали» бы из истории и из finalize.
      .leftJoin(rdRunDocuments, eq(recognitionRuns.rdRunDocumentId, rdRunDocuments.id))
      .innerJoin(submissionRevisions, eq(recognitionRuns.revisionId, submissionRevisions.id))
      .where(withScope(scope, REVISION_SCOPE, ...conditions))
  );
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

/**
 * Опубликовал ли прогон хоть одну страницу текста.
 *
 * ## Почему статуса `done` недостаточно
 *
 * Прогон в режиме dry-run (`ai.dry_run_only`, ADR-0007) проходит весь путь,
 * пишет canonical-артефакт и завершается ЧЕСТНЫМ `done` — но публикацию
 * пропускает: ни `page_text_versions`, ни указателя `current_block_result`
 * после него нет. Downstream-конвейер такой прогон видеть не должен вовсе, и
 * именно это shadow-режим и означает.
 *
 * Пока «распознано» проверялось статусом, dry-run выдавал себя за настоящее
 * распознавание сразу в трёх местах: маршрут «Проверить» считал стадию
 * пройденной и уходил к анализу, которому нечего читать; сегментация выбирала
 * этот прогон и получала страницы без текста; а `startRecognitionRun`
 * отказывался создавать новый прогон по той же разметке — то есть завершённый
 * dry-run запирал разметку НАВСЕГДА, и выйти из этого можно было только новой
 * ревизией разметки. Заказчик увидел это как пустой экран «Проверка», из
 * которого нет выхода.
 *
 * `page_text_versions` — правильный признак не по удобству, а по смыслу: это
 * ровно то, ради чего распознавание существует, и ровно то, чего у dry-run
 * нет. Прогон, не опубликовавший ни строки, распознаванием не является, каким
 * бы ни был его статус.
 *
 * `layoutRevisionId` необязателен: маршрут спрашивает про конкретную разметку
 * («можно ли считать ЭТУ стадию пройденной»), сегментация — про ревизию
 * целиком.
 */
export async function hasPublishedRecognition(
  db: Database,
  scope: AuthScope,
  input: { readonly revisionId: string; readonly layoutRevisionId?: string | undefined },
): Promise<boolean> {
  const rows = await db
    .select({ id: recognitionRuns.id })
    .from(recognitionRuns)
    .innerJoin(submissionRevisions, eq(recognitionRuns.revisionId, submissionRevisions.id))
    .where(
      withScope(
        scope,
        REVISION_SCOPE,
        eq(recognitionRuns.revisionId, input.revisionId),
        eq(recognitionRuns.status, 'done'),
        ...(input.layoutRevisionId === undefined
          ? []
          : [eq(recognitionRuns.layoutRevisionId, input.layoutRevisionId)]),
        sql`exists (
          select 1 from ${pageTextVersions}
           where ${pageTextVersions.recognitionRunId} = ${recognitionRuns.id}
        )`,
      ),
    )
    .limit(1);
  return rows.length > 0;
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
  /**
   * Прогон, который новый восстанавливает (S28).
   *
   * Не «продолжение» и не переоткрытие: родитель остаётся терминальным со
   * своим исходом, а ссылка отвечает на вопрос «откуда взялись результаты,
   * которых этот прогон не считал сам». Без неё перенесённые блоки выглядели
   * бы распознанными заново, и цена прогона в аудите не сходилась бы с числом
   * строк `ai_runs`.
   */
  readonly repairOfRunId?: string | null | undefined;
  /**
   * Нужен ли прогону RD-документ. Ветка RD WEB — да (без него OCR негде
   * запускать), ветка VLM (ADR-0007) — нет. Флаг обязателен и без значения по
   * умолчанию: решение принадлежит роуту, который выбрал ветку, и молчаливое
   * «как раньше» скрыло бы выбор.
   */
  readonly requireRdDocument: boolean;
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
  if (!input.requireRdDocument && existing !== null && existing.status === 'done') {
    /**
     * Зеркало легаси-дисциплины: у RD WEB повторный прогон done-разметки
     * запирает закрытый документ, у VLM запирать нечем — запрет явный.
     * Результаты неизменяемы, повторное распознавание = новая ревизия разметки.
     *
     * Спрашивается при этом не статус, а ПУБЛИКАЦИЯ. Запрет защищает
     * неизменяемость результатов, поэтому там, где результатов нет, защищать
     * нечего: прогон в режиме dry-run завершается честным `done`, не
     * опубликовав ни строки, — и, считая его успешным, запрет запирал разметку
     * навсегда за прогон, который ничего не оставил. Выйти из этого было
     * нельзя: новая ревизия разметки требует правки блоков, а блоки после
     * заморозки заперты триггером.
     */
    const published = await hasPublishedRecognition(db, scope, {
      revisionId: found.revisionId,
      layoutRevisionId: input.layoutRevisionId,
    });
    if (published) {
      throw conflict(
        'Прогон по этой ревизии разметки уже завершён успешно: ' +
          'для повторного распознавания нужна новая ревизия разметки.',
      );
    }
  }

  let rdRunDocumentId: string | null = null;
  if (input.requireRdDocument) {
    const runDocument = await db
      .select({ id: rdRunDocuments.id, closedAt: rdRunDocuments.closedAt })
      .from(rdRunDocuments)
      .where(eq(rdRunDocuments.layoutRevisionId, input.layoutRevisionId))
      .limit(1);
    const document = runDocument[0];
    if (document === undefined) {
      // Сюда же приходит комбинация «детекция local + распознавание rdweb»
      // (ADR-0007, матрица провайдеров): локальная разметка RD-документа не
      // создаёт, и честный отказ обязан подсказать оба выхода.
      throw conflict(
        'RD-документ прогона не создан: цепочка разметки RD WEB не выполнялась. ' +
          'Либо переразметьте с детекцией через RD WEB, либо переключите ' +
          'распознавание на VLM в настройках портала.',
      );
    }
    if (document.closedAt !== null) {
      throw conflict('RD-документ прогона закрыт: требуется новая ревизия разметки.');
    }
    rdRunDocumentId = document.id;
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
        rdRunDocumentId,
        localLayoutHash: found.blocksHash as string,
        workingPdfSha256,
        settingsSnapshot: input.settingsSnapshot,
        status: 'running',
        repairOfRunId: input.repairOfRunId ?? null,
      })
      .returning({ id: recognitionRuns.id });

    await appendRevisionEvent(tx, {
      revisionId: found.revisionId,
      eventType: 'recognition.started',
      payload: {
        layoutRevisionId: found.id,
        recognitionRunId: rows[0]?.id ?? null,
        localLayoutHash: found.blocksHash,
        ...(input.repairOfRunId != null ? { repairOfRunId: input.repairOfRunId } : {}),
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

// =====================================================================
// Ветка VLM (ADR-0007): состояние страниц прогона и append-only результаты
// =====================================================================

/**
 * Здесь три инварианта плана, и все три держатся БД, а не дисциплиной кода:
 *
 * 1. Прогресс — таблица `recognition_run_pages`, а не payload'ы очереди:
 *    финализация спрашивает «все ли страницы терминальны», и ответ обязан
 *    переживать смерть воркера и повтор любой задачи.
 * 2. Один результат на блок в прогоне — UNIQUE `(recognition_run_id,
 *    layout_block_id)` (0019) + `ON CONFLICT DO NOTHING`: повторная аренда
 *    задачи не создаёт дублей и не двигает ничего.
 * 3. Публикация атомарна: во время прогона пишутся ТОЛЬКО `block_results` и
 *    состояние страниц; `page_text_versions` и указатели
 *    `current_block_result` появляются одной финальной транзакцией. Упавший
 *    прогон не оставляет downstream ни байта.
 */

export type RunPageStatus = 'pending' | 'done' | 'failed';

export interface RunPageState {
  readonly workingPageIndex: number;
  readonly status: RunPageStatus;
  readonly blocksTotal: number;
  readonly blocksRecognized: number;
  readonly blocksInvalid: number;
  readonly blocksRefused: number;
}

/**
 * Сидирование страниц прогона при старте (`vlm.start_recognition`).
 *
 * `ON CONFLICT DO NOTHING`: повтор стартовой задачи после смерти воркера
 * не сбрасывает счётчики страниц, уже отработанных другими задачами.
 */
export async function seedRunPages(
  db: Database,
  scope: AuthScope,
  runId: string,
  pages: readonly { readonly workingPageIndex: number; readonly blocksTotal: number }[],
): Promise<void> {
  const run = await findRecognitionRun(db, scope, runId);
  if (run === null) throw notFound('Прогон распознавания не найден.');
  if (pages.length === 0) return;
  await db
    .insert(recognitionRunPages)
    .values(
      pages.map((page) => ({
        recognitionRunId: runId,
        workingPageIndex: page.workingPageIndex,
        blocksTotal: page.blocksTotal,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Дополнение снимка настроек прогона фактами, известными только воркеру
 * (версии опубликованных промптов, растеризатор, версия crop policy).
 *
 * Merge, а не перезапись: ядро снимка (провайдер, модель, dryRun) записал роут,
 * и затирать его воркер не имеет права. Пишется только у running-прогона —
 * снимок завершённого прогона неизменен как часть исхода.
 */
export async function mergeRunSettingsSnapshot(
  db: Database,
  scope: AuthScope,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await requireRunningRun(db, scope, runId);
  await db
    .update(recognitionRuns)
    .set({
      settingsSnapshot: sql`${recognitionRuns.settingsSnapshot} || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(and(eq(recognitionRuns.id, runId), eq(recognitionRuns.status, 'running')));
}

/** Терминальная отметка страницы прогона — пишет `vlm.recognize_page` в конце обхода. */
export async function markRunPage(
  db: Database,
  scope: AuthScope,
  input: {
    readonly runId: string;
    readonly workingPageIndex: number;
    readonly status: Exclude<RunPageStatus, 'pending'>;
    readonly blocksRecognized: number;
    readonly blocksInvalid: number;
    readonly blocksRefused: number;
  },
): Promise<void> {
  const run = await findRecognitionRun(db, scope, input.runId);
  if (run === null) throw notFound('Прогон распознавания не найден.');
  const updated = await db
    .update(recognitionRunPages)
    .set({
      status: input.status,
      blocksRecognized: input.blocksRecognized,
      blocksInvalid: input.blocksInvalid,
      blocksRefused: input.blocksRefused,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(recognitionRunPages.recognitionRunId, input.runId),
        eq(recognitionRunPages.workingPageIndex, input.workingPageIndex),
      ),
    )
    .returning({ workingPageIndex: recognitionRunPages.workingPageIndex });
  if (updated.length === 0) {
    // Строки нет — стартовая задача её не сидировала. Это дефект постановщика,
    // и молча создать строку здесь значило бы спрятать его.
    throw notFound('Страница прогона не сидирована: vlm.start_recognition не выполнялась.');
  }
}

export async function listRunPages(
  db: Database,
  scope: AuthScope,
  runId: string,
): Promise<readonly RunPageState[]> {
  const run = await findRecognitionRun(db, scope, runId);
  if (run === null) throw notFound('Прогон распознавания не найден.');
  const rows = await db
    .select({
      workingPageIndex: recognitionRunPages.workingPageIndex,
      status: recognitionRunPages.status,
      blocksTotal: recognitionRunPages.blocksTotal,
      blocksRecognized: recognitionRunPages.blocksRecognized,
      blocksInvalid: recognitionRunPages.blocksInvalid,
      blocksRefused: recognitionRunPages.blocksRefused,
    })
    .from(recognitionRunPages)
    .where(eq(recognitionRunPages.recognitionRunId, runId))
    .orderBy(asc(recognitionRunPages.workingPageIndex));
  return rows.map((row) => ({ ...row, status: row.status as RunPageStatus }));
}

/**
 * Планирование раунда дораспознавания упавших страниц (S28).
 *
 * Одной транзакцией и в одном месте, потому что три её действия имеют смысл
 * только вместе: пометить раунд израсходованным, вернуть страницы в `pending`
 * и поставить им задачи. Разорвись это на три вызова — сбой посередине оставил
 * бы страницы ожидающими работы, которой никто не поставил, и финализация
 * ждала бы их своими двумястами сорока попытками (часы), прежде чем закрыть
 * прогон отказом.
 *
 * Переход `recovery_round` — сравнение с ожидаемым значением, а не инкремент:
 * финализация — поллер, её попытки идут одна за другой и могут пересечься.
 * Проигравшая гонку получает `scheduled: false` и просто ждёт, вместо того
 * чтобы поставить второй комплект задач на те же страницы.
 *
 * `dedupeKey` несёт номер раунда: ключ прежней задачи занят, если та умерла
 * (`enqueueSystemJob` держит мёртвых в индексе намеренно — исчерпавшая попытки
 * задача разбирается человеком, а не пересоздаётся молча), и без номера раунда
 * страница осталась бы `pending` навсегда.
 */
export async function scheduleRunRecoveryRound(
  db: Database,
  scope: AuthScope,
  input: {
    readonly runId: string;
    /** Номер раунда, который сейчас записан у прогона (ожидание для перехода). */
    readonly fromRound: number;
    readonly pages: readonly number[];
  },
): Promise<{ readonly scheduled: boolean; readonly round: number }> {
  const run = await findRecognitionRun(db, scope, input.runId);
  if (run === null) throw notFound('Прогон распознавания не найден.');
  if (input.pages.length === 0) return { scheduled: false, round: run.recoveryRound };

  const round = input.fromRound + 1;
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(recognitionRuns)
      .set({ recoveryRound: round })
      .where(
        and(
          eq(recognitionRuns.id, input.runId),
          eq(recognitionRuns.recoveryRound, input.fromRound),
          // Раунд имеет смысл только у прогона, в который ещё можно писать:
          // закрытому дораспознавать нечего, его исход уже объявлен.
          eq(recognitionRuns.status, 'running'),
        ),
      )
      .returning({ id: recognitionRuns.id });
    if (claimed.length === 0) return { scheduled: false, round: run.recoveryRound };

    await tx
      .update(recognitionRunPages)
      .set({
        status: 'pending',
        // Счётчики обнуляются: их перезапишет проход страницы, а до тех пор
        // «непригодных блоков 1» относилось бы к прошлому кругу и врало бы.
        blocksInvalid: 0,
        blocksRefused: 0,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(recognitionRunPages.recognitionRunId, input.runId),
          inArray(recognitionRunPages.workingPageIndex, [...input.pages]),
        ),
      );

    for (const pageIndex of input.pages) {
      await enqueueSystemJob(tx, {
        type: 'vlm.recognize_page',
        payload: {
          revisionId: run.revisionId,
          recognitionRunId: input.runId,
          pageIndex,
        },
        dedupeKey: `vlm.recognize_page:${input.runId}:${String(pageIndex)}:r${String(round)}`,
      });
    }

    return { scheduled: true, round };
  });
}

/**
 * Идемпотентная запись результата одного блока — checkpoint `vlm.recognize_page`.
 *
 * Указатель `current_block_result` здесь НЕ двигается (инвариант 3): до
 * финальной публикации частичный результат не виден downstream. `written:
 * false` — строка уже есть (повторная аренда), и это штатный исход, а не сбой.
 */
export async function insertBlockResultIdempotent(
  db: Database,
  // Область не применяется: запись адресуется прогоном, чью область вызывающий
  // уже проверил, загружая прогон. Параметр сохранён ради симметрии deps-порта.
  _scope: AuthScope,
  input: {
    readonly recognitionRunId: string;
    readonly layoutRevisionId: string;
    readonly block: SaveBlockResultInput;
  },
): Promise<{ readonly written: boolean }> {
  const rows = await db
    .insert(blockResults)
    .values({
      layoutRevisionId: input.layoutRevisionId,
      layoutBlockId: input.block.layoutBlockId,
      recognitionRunId: input.recognitionRunId,
      resultType: input.block.resultType,
      contentHtml: input.block.contentHtml,
      contentMd: input.block.contentMd,
      contentJson: input.block.contentJson ?? null,
      modelId: input.block.modelId,
      confidence: input.block.confidence,
    })
    .onConflictDoNothing({
      target: [blockResults.recognitionRunId, blockResults.layoutBlockId],
    })
    .returning({ id: blockResults.id });
  return { written: rows.length > 0 };
}

/** Уже записанные блоки прогона — чем `vlm.recognize_page` отсекает оплаченное. */
export async function listRunBlockIds(
  db: Database,
  // См. insertBlockResultIdempotent: область проверена загрузкой прогона.
  _scope: AuthScope,
  runId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ blockId: blockResults.layoutBlockId })
    .from(blockResults)
    .where(eq(blockResults.recognitionRunId, runId));
  return new Set(rows.map((row) => row.blockId));
}

/** Конверты результатов прогона — вход финальной сборки RecognitionResult. */
export async function listRunBlockEnvelopes(
  db: Database,
  scope: AuthScope,
  runId: string,
): Promise<
  readonly {
    readonly id: string;
    readonly layoutBlockId: string;
    readonly contentJson: unknown;
    readonly modelId: string | null;
  }[]
> {
  const run = await findRecognitionRun(db, scope, runId);
  if (run === null) throw notFound('Прогон распознавания не найден.');
  return db
    .select({
      id: blockResults.id,
      layoutBlockId: blockResults.layoutBlockId,
      contentJson: blockResults.contentJson,
      modelId: blockResults.modelId,
    })
    .from(blockResults)
    .where(eq(blockResults.recognitionRunId, runId))
    .orderBy(asc(blockResults.layoutBlockId));
}

export interface PublishVlmResultsInput {
  readonly recognitionRunId: string;
  readonly artifactVersionId: string;
  readonly pages: readonly {
    readonly workingPageIndex: number;
    readonly textMd: string;
    readonly renderVersion: string;
  }[];
}

/**
 * Финальная публикация VLM-прогона — ОДНА транзакция (инвариант 3 плана):
 * тексты страниц с версией рендера и перевод указателей «текущий результат»
 * на все результаты прогона. Вызывается только после проверки полного
 * покрытия; упавший прогон сюда не доходит.
 *
 * Повтор безопасен тем же механизмом, что `saveRecognitionResults`: страницы
 * отсекаются по уже записанному множеству, указатели переводятся upsert'ом —
 * второй раз в то же самое место.
 */
export async function publishVlmRunResults(
  db: Database,
  scope: AuthScope,
  input: PublishVlmResultsInput,
): Promise<{
  readonly pagesWritten: number;
  readonly pagesAlreadyPresent: number;
  readonly pagesOutOfRange: number;
  readonly pointersMoved: number;
}> {
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

  const pagesOutOfRange = input.pages.filter(
    (page) => pageMap.get(page.workingPageIndex) === undefined,
  ).length;
  if (pagesOutOfRange > 0) {
    // Как в saveRecognitionResults: публикация со страницей вне рабочего
    // документа не пишет ВООБЩЕ ничего — прогон будет остановлен целиком.
    return { pagesWritten: 0, pagesAlreadyPresent: 0, pagesOutOfRange, pointersMoved: 0 };
  }

  const results = await db
    .select({ id: blockResults.id, layoutBlockId: blockResults.layoutBlockId })
    .from(blockResults)
    .where(eq(blockResults.recognitionRunId, input.recognitionRunId));

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
        renderVersion: page.renderVersion,
      });
      pagesWritten += 1;
    }

    let pointersMoved = 0;
    for (const result of results) {
      await tx
        .insert(currentBlockResult)
        .values({ layoutBlockId: result.layoutBlockId, blockResultId: result.id })
        .onConflictDoUpdate({
          target: currentBlockResult.layoutBlockId,
          set: { blockResultId: result.id, updatedAt: sql`now()` },
        });
      pointersMoved += 1;
    }

    return { pagesWritten, pagesAlreadyPresent, pagesOutOfRange: 0, pointersMoved };
  });
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
