/**
 * Согласование поставки: submit, return, approve, override (§4.1, §9.6, §3).
 *
 * ## Что здесь решается, а что решает БД
 *
 * Переходы статуса — уровень приложения: только здесь известно, КТО их делает,
 * и §4.1 разграничивает роли именно ролями, а не строками. БД про актора не
 * знает и знать не должна (0008), она держит абсолютное: содержимое поданной
 * ревизии и всё содержимое терминальной неизменяемо. Оба уровня обязательны, и
 * ни один не заменяет другой.
 *
 * ## Возврат не переоткрывает ревизию
 *
 * §3: «возврат закрывает её и создаёт новую draft с `parent_revision_id`».
 * Возврат к `draft` запрещён триггером `submission_revisions_no_reopen`, и это
 * не техническая деталь: история согласования — доказательство, а
 * переоткрытая ревизия означала бы, что решение принято по составу, которого
 * больше нет.
 *
 * ## Предусловия собираются списком, а не первым найденным
 *
 * Инженеру нужно увидеть все причины отказа сразу: «двенадцать документов не
 * подтверждены» и «три блокирующих замечания открыты» — это один разговор с
 * подрядчиком, а не три захода по одному отказу за раз. Тот же приём, что у
 * `blockers` в плане сборки рабочего документа.
 */
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  findings,
  legalHolds,
  logicalDocuments,
  processingBundles,
  reviewActions,
  sourceFiles,
  submissionRevisions,
  works,
  validationRuns,
} from '@id/db';
import type { WorkflowStatus } from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, isHttpProblem, notFound, preconditionFailed } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendAudit, type AuditActor } from './audit.js';
import { appendRevisionEvent } from './jobs.js';
import type { Database } from './users.js';

/**
 * Часть `Database`, которой пользуются помощники внутри транзакции.
 *
 * Структурный тип, а не `Database`: объект транзакции Drizzle не является
 * экземпляром пула, и требовать его целиком значило бы либо приводить типы, либо
 * дублировать тела функций внутри каждой транзакции.
 */
type WorkflowExecutor = Pick<Database, 'insert' | 'update' | 'execute'>;

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

/** Статусы, из которых ревизия ещё может быть решена проверяющим. */
const REVIEWABLE: readonly WorkflowStatus[] = ['submitted', 'in_review'];

/** Действия, попадающие в `review_actions`. Формат кода держит CHECK 0006. */
export type ReviewAction = 'submit' | 'take_to_review' | 'return' | 'approve' | 'override';

export interface RevisionWorkflowView {
  readonly id: string;
  readonly workId: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly revisionNo: number;
  readonly status: WorkflowStatus;
  readonly parentRevisionId: string | null;
  readonly aggregateManifestHash: string | null;
  readonly version: number;
  readonly submittedAt: string | null;
  /**
   * Кто подал ревизию на проверку.
   *
   * Нужен согласованию: с S21 подать вправе все пять ролей, и без этого поля
   * инженер, загрузивший исправление за подрядчика, согласовал бы собственную
   * подачу (см. `approveRevision`).
   */
  readonly submittedBy: string | null;
  readonly decidedAt: string | null;
  readonly returnReason: string | null;
}

const iso = (column: unknown, alias: string) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    alias,
  );

const REVISION_SELECTION = {
  id: submissionRevisions.id,
  workId: submissionRevisions.workId,
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
  revisionNo: submissionRevisions.revisionNo,
  status: submissionRevisions.status,
  parentRevisionId: submissionRevisions.parentRevisionId,
  aggregateManifestHash: submissionRevisions.aggregateManifestHash,
  version: submissionRevisions.version,
  submittedAt: iso(submissionRevisions.submittedAt, 'submitted_at_iso'),
  submittedBy: submissionRevisions.submittedBy,
  decidedAt: iso(submissionRevisions.decidedAt, 'decided_at_iso'),
  returnReason: submissionRevisions.returnReason,
};

/**
 * Ревизия в области видимости вызывающего.
 *
 * `null` и на «нет такой», и на «чужая»: различать их наружу значило бы
 * подтверждать существование чужой поставки перебором идентификаторов.
 */
export async function findRevisionWorkflow(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<RevisionWorkflowView | null> {
  const rows = await db
    .select(REVISION_SELECTION)
    .from(submissionRevisions)
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.id, revisionId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { ...row, status: row.status as WorkflowStatus };
}

async function requireRevision(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<RevisionWorkflowView> {
  const revision = await findRevisionWorkflow(db, scope, revisionId);
  if (revision === null) throw notFound('Ревизия поставки не найдена.');
  return revision;
}

// =====================================================================
// Готовность ревизии к переходу
// =====================================================================

export interface RevisionReadiness {
  readonly fileCount: number;
  readonly filesNotOk: number;
  readonly hasBundle: boolean;
  /** Хэш состава по фактическому набору файлов — считает `bundles.ts`. */
  readonly bundleManifestHash: string | null;
  readonly documentCount: number;
  readonly unconfirmedDocuments: number;
  readonly unmaterializedDocuments: number;
  readonly openBlockingFindings: number;
  readonly finishedValidationRuns: number;
}

/**
 * Одним запросом: всё, от чего зависят предусловия обоих переходов.
 *
 * Подзапросы, а не пять round-trip'ов, потому что ответ обязан описывать ОДНО
 * состояние. Пять последовательных чтений дали бы картину, в которой документы
 * подтверждены в один момент времени, а замечания сосчитаны в другой, — и
 * предусловие approve проверялось бы по состоянию, которого не было никогда.
 */
export async function loadRevisionReadiness(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<RevisionReadiness> {
  // Внешняя таблица во всех подзапросах названа ТЕКСТОМ (`submission_revisions.id`),
  // а не через `${submissionRevisions.id}`. Проверено дампом SQL: в запросе без
  // джойнов Drizzle рендерит колонку без имени таблицы, и коррелирующее условие
  // связывалось бы с одноимённой колонкой ВНУТРЕННЕЙ таблицы — то есть каждый
  // счётчик молча возвращал бы ноль. Тем же способом много этапов подряд был
  // сломан `hasBundle` в `files.ts`.
  const rows = await db
    .select({
      fileCount: sql<number>`(select count(*)::int from ${sourceFiles} f where f.revision_id = submission_revisions.id)`,
      filesNotOk: sql<number>`(select count(*)::int from ${sourceFiles} f where f.revision_id = submission_revisions.id and f.verify_state <> 'ok')`,
      bundleManifestHash: sql<
        string | null
      >`(select pb.aggregate_manifest_hash from ${processingBundles} pb where pb.revision_id = submission_revisions.id order by pb.created_at desc limit 1)`,
      documentCount: sql<number>`(select count(*)::int from ${logicalDocuments} d where d.revision_id = submission_revisions.id)`,
      unconfirmedDocuments: sql<number>`(select count(*)::int from ${logicalDocuments} d where d.revision_id = submission_revisions.id and not d.is_confirmed)`,
      unmaterializedDocuments: sql<number>`(select count(*)::int from ${logicalDocuments} d where d.revision_id = submission_revisions.id and d.derived_pdf_blob_sha256 is null)`,
      openBlockingFindings: sql<number>`(select count(*)::int from ${findings} f where f.revision_id = submission_revisions.id and f.is_blocking and f.state = 'open')`,
      finishedValidationRuns: sql<number>`(select count(*)::int from ${validationRuns} v where v.revision_id = submission_revisions.id and v.finished_at is not null)`,
    })
    .from(submissionRevisions)
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.id, revisionId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound('Ревизия поставки не найдена.');
  return { ...row, hasBundle: row.bundleManifestHash !== null };
}

/**
 * Препятствия подаче (§4.1: подрядчик подаёт то, что уже собрано).
 *
 * Подача требует собранного рабочего документа, а не только загруженных файлов:
 * `aggregate_manifest_hash` ревизии — это хэш ТОГО состава, по которому дальше
 * пойдёт разметка и распознавание, и записывать его, не имея собранного
 * документа, значило бы пиннить состав, который никто не собирал.
 */
export function submitBlockers(
  revision: RevisionWorkflowView,
  readiness: RevisionReadiness,
): readonly string[] {
  const blockers: string[] = [];
  if (revision.status !== 'draft') {
    blockers.push(`ревизия уже подана: статус «${revision.status}»`);
  }
  if (readiness.fileCount === 0) blockers.push('в ревизии нет ни одного файла');
  if (readiness.filesNotOk > 0) {
    blockers.push(`файлов не прошло проверку: ${readiness.filesNotOk}`);
  }
  if (!readiness.hasBundle) blockers.push('рабочий документ ревизии не собран');
  return blockers;
}

/**
 * Препятствия согласованию (§9.6).
 *
 * Список намеренно строгий в трёх местах, и каждое — требование плана, а не
 * осторожность:
 *
 * * прогон проверок обязан быть (§9): согласование без единого прогона — это
 *   решение, принятое без методики;
 * * блокирующее открытое замечание закрывает approve, и снять его может только
 *   руководитель обоснованным override (§9.6). Иначе роль `revision.override`
 *   не имела бы смысла;
 * * документы обязаны быть подтверждены И нарезаны. Первое — §8.2 («ручная
 *   разметка приоритетна»), второе — §12: нарезка идёт после подтверждения
 *   границ, а после approve содержимое ревизии заперто, и нарезать станет
 *   нечем. Архив согласованной ревизии без её документов был бы архивом ни о
 *   чём.
 */
export function approveBlockers(
  revision: RevisionWorkflowView,
  readiness: RevisionReadiness,
): readonly string[] {
  const blockers: string[] = [];
  if (!REVIEWABLE.includes(revision.status)) {
    blockers.push(`ревизия в статусе «${revision.status}» не находится на согласовании`);
  }
  if (readiness.finishedValidationRuns === 0) {
    blockers.push('по ревизии не завершён ни один прогон проверок');
  }
  if (readiness.documentCount === 0) {
    blockers.push('в ревизии не собрано ни одного логического документа');
  }
  if (readiness.unconfirmedDocuments > 0) {
    blockers.push(`документов без подтверждения границ: ${readiness.unconfirmedDocuments}`);
  }
  if (readiness.unmaterializedDocuments > 0) {
    blockers.push(
      `документов без нарезки: ${readiness.unmaterializedDocuments} ` +
        '(нарезка выполняется фоновой задачей после подтверждения границ)',
    );
  }
  if (readiness.openBlockingFindings > 0) {
    blockers.push(
      `открытых блокирующих замечаний: ${readiness.openBlockingFindings} ` +
        '(снимаются устранением либо обоснованным решением руководителя)',
    );
  }
  return blockers;
}

// =====================================================================
// Переходы
// =====================================================================

export interface WorkflowActionInput {
  readonly revisionId: string;
  readonly actorUserId: string;
  /** Оптимистичная блокировка (§14, `If-Match`). */
  readonly expectedVersion: number;
  readonly comment?: string | undefined;
  readonly actor: AuditActor;
  /**
   * Запирают ли блокеры переход (`core.enforce_immutability`, S24).
   *
   * `false` — режим тестирования: препятствия по-прежнему ВЫЧИСЛЯЮТСЯ и уходят
   * на экран, но переход не отвергают. Убирать сам список было бы ошибкой:
   * «чего не хватает» — самая полезная часть этого ответа, и на этапе
   * тестирования она нужна не меньше, чем на бою. Мешает не список, а запрет.
   *
   * Проверка версии (`If-Match`), права и переходы статусов остаются в силе:
   * они защищают не от неполноты комплекта, а от гонки и от чужого действия, и
   * к неизменяемости отношения не имеют.
   */
  readonly enforceBlockers?: boolean;
}

export interface SubmitInput extends WorkflowActionInput {
  /** Хэш состава: считает `loadBundlePlan()`, здесь он только пиннится. */
  readonly aggregateManifestHash: string;
}

export interface WorkflowResult {
  readonly revision: RevisionWorkflowView;
  /** Ревизия, созданная возвратом. `null` у остальных переходов. */
  readonly nextRevisionId: string | null;
  /**
   * Совпал ли состав с родительской ревизией (§3).
   *
   * `null` — родителя нет. Значение решает единственный вопрос: разрешено ли
   * переиспользовать результаты предыдущей ревизии. Читает его сборка рабочего
   * документа (`findReusableBundle`), поэтому поле не декоративное.
   */
  readonly manifestMatchesParent: boolean | null;
}

/**
 * Перевод ревизии одним UPDATE с проверкой версии И статуса.
 *
 * Статус проверяется в самом операторе, а не чтением перед записью: между
 * чтением и записью помещается решение второго проверяющего, и «оба нажали
 * approve» превратилось бы в два разных исхода по одной ревизии.
 */
async function transition(
  tx: WorkflowExecutor,
  input: {
    readonly revisionId: string;
    readonly expectedVersion: number;
    readonly from: readonly WorkflowStatus[];
    readonly set: Record<string, unknown>;
  },
): Promise<void> {
  const updated = await tx
    .update(submissionRevisions)
    .set({
      ...input.set,
      version: sql`${submissionRevisions.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(submissionRevisions.id, input.revisionId),
        eq(submissionRevisions.version, input.expectedVersion),
        inArray(submissionRevisions.status, [...input.from]),
      ),
    )
    .returning({ id: submissionRevisions.id });

  if (updated.length === 0) {
    throw preconditionFailed(
      'Ревизия изменена другим пользователем: перечитайте карточку и повторите действие.',
    );
  }
}

async function recordAction(
  tx: WorkflowExecutor,
  scope: AuthScope,
  input: {
    readonly revisionId: string;
    readonly objectId: string;
    readonly actorUserId: string;
    readonly action: ReviewAction;
    readonly comment: string | null;
    readonly actor: AuditActor;
    readonly auditPayload: Record<string, unknown>;
    readonly eventPayload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(reviewActions).values({
    revisionId: input.revisionId,
    actorUserId: input.actorUserId,
    action: input.action,
    comment: input.comment,
  });

  // Аудит — ТОЙ ЖЕ транзакцией, что и переход (урок S4): решение без автора
  // юридически бесполезно, а аудит, который может не записаться, — это ровно
  // такое решение.
  await appendAudit(tx, scope, {
    ...input.actor,
    action: `revision.${input.action}`,
    entityType: 'submission_revision',
    entityId: input.revisionId,
    objectId: input.objectId,
    payload: input.auditPayload,
  });

  await appendRevisionEvent(tx, {
    revisionId: input.revisionId,
    eventType: `workflow.${input.action}`,
    payload: input.eventPayload,
  });
}

/** Отказ БД переводится в осмысленный ответ; см. тот же приём в `documents.ts`. */
async function guardWorkflow<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    if (isHttpProblem(error)) throw error;
    const driver = error as { code?: unknown; constraint?: unknown; cause?: unknown };
    const code = typeof driver.code === 'string' ? driver.code : undefined;
    const nested = driver.cause as { code?: unknown; constraint?: unknown } | undefined;
    const sqlState = code ?? (typeof nested?.code === 'string' ? nested.code : undefined);

    // `restrict_violation` поднимают триггеры неизменяемости (0008, 0018).
    if (sqlState === '23001') {
      throw conflict(
        'Изменение отвергнуто базой: ревизия или её содержимое неизменяемы. ' +
          'Исправление вносится созданием новой ревизии поставки.',
        { logDetail: 'сработал триггер неизменяемости' },
      );
    }
    if (sqlState === '23505') {
      throw conflict('У поставки уже есть незакрытая черновая ревизия.', {
        logDetail: 'нарушен ux_submission_revisions_single_draft',
      });
    }
    throw error;
  }
}

/**
 * Подача комплекта подрядчиком (§4.1).
 *
 * Здесь же ревизия получает `aggregate_manifest_hash`: до подачи состав ещё
 * меняется, и пиннить его раньше значило бы пиннить черновик. После подачи
 * состав заперт триггерами класса `source`, поэтому хэш и содержимое расходиться
 * уже не могут.
 */
export async function submitRevision(
  db: Database,
  scope: AuthScope,
  input: SubmitInput,
): Promise<WorkflowResult> {
  const revision = await requireRevision(db, scope, input.revisionId);
  const readiness = await loadRevisionReadiness(db, scope, input.revisionId);
  const blockers = submitBlockers(revision, readiness);
  if (blockers.length > 0 && input.enforceBlockers !== false) {
    throw conflict(`Комплект нельзя подать: ${blockers.join('; ')}.`);
  }
  if (
    readiness.bundleManifestHash !== input.aggregateManifestHash &&
    input.enforceBlockers !== false
  ) {
    // Состав изменился между сборкой рабочего документа и подачей. Молча
    // подать «то, что есть» нельзя: разметка и распознавание уже идут по
    // собранному документу, и хэш описывал бы не его.
    //
    // В режиме тестирования проверка снята вместе с блокерами, и это не
    // отдельное послабление, а условие того, чтобы первое имело смысл: чаще
    // всего рабочего документа просто нет, `bundleManifestHash` равен null, и
    // подача упиралась бы сюда сразу после снятого «рабочий документ не собран».
    throw conflict(
      'Состав ревизии изменился после сборки рабочего документа: соберите его заново.',
    );
  }

  const parentHash = await parentManifestHash(db, revision);

  await guardWorkflow(() =>
    db.transaction(async (tx) => {
      await transition(tx, {
        revisionId: input.revisionId,
        expectedVersion: input.expectedVersion,
        from: ['draft'],
        set: {
          status: 'submitted',
          submittedAt: sql`now()`,
          submittedBy: input.actorUserId,
          aggregateManifestHash: input.aggregateManifestHash,
        },
      });
      await recordAction(tx, scope, {
        revisionId: input.revisionId,
        objectId: revision.objectId,
        actorUserId: input.actorUserId,
        action: 'submit',
        comment: input.comment ?? null,
        actor: input.actor,
        auditPayload: {
          revisionNo: revision.revisionNo,
          fileCount: readiness.fileCount,
          aggregateManifestHash: input.aggregateManifestHash,
        },
        eventPayload: {
          revisionNo: revision.revisionNo,
          manifestMatchesParent:
            parentHash === null ? null : parentHash === input.aggregateManifestHash,
        },
      });
    }),
  );

  return {
    revision: await requireRevision(db, scope, input.revisionId),
    nextRevisionId: null,
    manifestMatchesParent: parentHash === null ? null : parentHash === input.aggregateManifestHash,
  };
}

/** Хэш состава родительской ревизии; `null` — родителя нет либо он не пиннен. */
async function parentManifestHash(
  db: Database,
  revision: RevisionWorkflowView,
): Promise<string | null> {
  if (revision.parentRevisionId === null) return null;
  // Область не применяется намеренно и безопасно: родитель — это ревизия ТОЙ ЖЕ
  // поставки, а сама ревизия уже прошла проверку области. Фильтр по
  // `work_id` делает запрос замкнутым внутри одного комплекта, поэтому
  // чужую строку он вернуть не может по построению.
  const rows = await db
    .select({ hash: submissionRevisions.aggregateManifestHash })
    .from(submissionRevisions)
    .where(
      and(
        eq(submissionRevisions.id, revision.parentRevisionId),
        eq(submissionRevisions.workId, revision.workId),
      ),
    )
    .limit(1);
  return rows[0]?.hash ?? null;
}

/**
 * Взятие в работу: `submitted → in_review`.
 *
 * Отдельное действие, потому что иначе статус `in_review` не достижим ни одним
 * путём и превращается в мёртвое значение перечисления §3 — то же, что мёртвый
 * код, только в схеме. Заодно подрядчик видит по ленте, что комплект открыли,
 * а не лежит.
 */
export async function takeRevisionToReview(
  db: Database,
  scope: AuthScope,
  input: WorkflowActionInput,
): Promise<WorkflowResult> {
  const revision = await requireRevision(db, scope, input.revisionId);
  if (revision.status !== 'submitted') {
    throw conflict(
      `Взять в работу можно только поданную ревизию, а её статус «${revision.status}».`,
    );
  }

  await guardWorkflow(() =>
    db.transaction(async (tx) => {
      await transition(tx, {
        revisionId: input.revisionId,
        expectedVersion: input.expectedVersion,
        from: ['submitted'],
        set: { status: 'in_review' },
      });
      await recordAction(tx, scope, {
        revisionId: input.revisionId,
        objectId: revision.objectId,
        actorUserId: input.actorUserId,
        action: 'take_to_review',
        comment: input.comment ?? null,
        actor: input.actor,
        auditPayload: { revisionNo: revision.revisionNo },
        eventPayload: { revisionNo: revision.revisionNo },
      });
    }),
  );

  return {
    revision: await requireRevision(db, scope, input.revisionId),
    nextRevisionId: null,
    manifestMatchesParent: null,
  };
}

export interface ReturnInput extends WorkflowActionInput {
  readonly reason: string;
}

/**
 * Возврат подрядчику: закрывает ревизию и открывает следующую (§3).
 *
 * Новая ревизия создаётся ТОЙ ЖЕ транзакцией. Иначе отказ между двумя
 * операциями оставил бы поставку без единой открытой ревизии, а подрядчику
 * некуда было бы подавать исправление: индекс `ux_submission_revisions_single_draft`
 * не позволил бы завести её вручную вторым действием, если первая уже есть, и
 * наоборот — ничего бы не подсказало, что её нет.
 */
export async function returnRevision(
  db: Database,
  scope: AuthScope,
  input: ReturnInput,
): Promise<WorkflowResult> {
  const revision = await requireRevision(db, scope, input.revisionId);
  if (!REVIEWABLE.includes(revision.status)) {
    throw conflict(
      `Вернуть можно только ревизию на согласовании, а её статус «${revision.status}».`,
    );
  }

  const nextRevisionId = await guardWorkflow(() =>
    db.transaction(async (tx) => {
      await transition(tx, {
        revisionId: input.revisionId,
        expectedVersion: input.expectedVersion,
        from: REVIEWABLE,
        set: {
          status: 'returned',
          decidedAt: sql`now()`,
          decidedBy: input.actorUserId,
          returnReason: input.reason,
        },
      });

      const created = await tx
        .insert(submissionRevisions)
        .values({
          workId: revision.workId,
          objectId: revision.objectId,
          contractorId: revision.contractorId,
          revisionNo: revision.revisionNo + 1,
          parentRevisionId: revision.id,
          status: 'draft',
        })
        .returning({ id: submissionRevisions.id });

      const next = created[0];
      if (next === undefined) {
        throw conflict('Новая ревизия комплекта не создана: повторите действие.');
      }

      // Указатель комплекта переводится на новую ревизию: без этого экран
      // комплекта продолжал бы открывать закрытую возвратом.
      await tx
        .update(works)
        .set({ currentRevisionId: next.id })
        .where(eq(works.id, revision.workId));

      await recordAction(tx, scope, {
        revisionId: input.revisionId,
        objectId: revision.objectId,
        actorUserId: input.actorUserId,
        action: 'return',
        comment: input.reason,
        actor: input.actor,
        auditPayload: { revisionNo: revision.revisionNo, nextRevisionId: next.id },
        eventPayload: { revisionNo: revision.revisionNo, nextRevisionId: next.id },
      });

      // Событие и в новой ревизии: её лента начинается с причины, по которой
      // она вообще появилась.
      await appendRevisionEvent(tx, {
        revisionId: next.id,
        eventType: 'workflow.opened_after_return',
        payload: { parentRevisionId: revision.id, revisionNo: revision.revisionNo + 1 },
      });

      return next.id;
    }),
  );

  return {
    revision: await requireRevision(db, scope, input.revisionId),
    nextRevisionId,
    manifestMatchesParent: null,
  };
}

/** Согласование (§4.1: инженер или руководитель). */
export async function approveRevision(
  db: Database,
  scope: AuthScope,
  input: WorkflowActionInput,
): Promise<WorkflowResult> {
  const revision = await requireRevision(db, scope, input.revisionId);

  /**
   * Подавший не согласует собственную подачу.
   *
   * До S21 запрет держался сам собой: подавать могли только подрядчик и
   * генподрядчик, согласовывать — только инженер и руководитель, и пересечься
   * ролям было негде. Заказчик разрешил подавать всем пяти ролям, и пересечение
   * появилось: инженер, загрузивший исправление за подрядчика без учётной
   * записи, оказался бы и подающим, и согласующим.
   *
   * Проверка по ПОЛЬЗОВАТЕЛЮ, а не по роли: второй инженер того же объекта
   * согласует такую ревизию свободно, и это верно — разделение требуется между
   * людьми, а не между должностями (§4.1, тот же принцип, по которому
   * администратор не согласует без роли `manager`, а генподрядчик не принимает
   * папку, которую сам передал).
   */
  if (revision.submittedBy !== null && revision.submittedBy === input.actorUserId) {
    throw conflict(
      'Согласовать ревизию, поданную вами же, нельзя: решение принимает другой ' +
        'проверяющий. Это разделение обязанностей, а не ограничение прав.',
    );
  }

  // Предусловия — ПОСЛЕ проверки актора и списком, а не первым отказом.
  // Порядок именно такой: «поданную вами же» не изменится от того, что
  // подрядчик устранит замечания, и сообщать о ней после списка блокеров
  // значило бы отправить человека чинить то, что не откроет ему это действие.
  const readiness = await loadRevisionReadiness(db, scope, input.revisionId);
  const blockers = approveBlockers(revision, readiness);
  if (blockers.length > 0 && input.enforceBlockers !== false) {
    throw conflict(`Комплект нельзя согласовать: ${blockers.join('; ')}.`);
  }

  await guardWorkflow(() =>
    db.transaction(async (tx) => {
      await transition(tx, {
        revisionId: input.revisionId,
        expectedVersion: input.expectedVersion,
        from: REVIEWABLE,
        set: { status: 'approved', decidedAt: sql`now()`, decidedBy: input.actorUserId },
      });
      await recordAction(tx, scope, {
        revisionId: input.revisionId,
        objectId: revision.objectId,
        actorUserId: input.actorUserId,
        action: 'approve',
        comment: input.comment ?? null,
        actor: input.actor,
        auditPayload: {
          revisionNo: revision.revisionNo,
          documentCount: readiness.documentCount,
        },
        eventPayload: {
          revisionNo: revision.revisionNo,
          documentCount: readiness.documentCount,
        },
      });
    }),
  );

  return {
    revision: await requireRevision(db, scope, input.revisionId),
    nextRevisionId: null,
    manifestMatchesParent: null,
  };
}

// =====================================================================
// Обоснованное снятие блокирующего замечания (§9.6)
// =====================================================================

export interface OverrideInput {
  readonly findingId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly actor: AuditActor;
}

export interface OverrideResult {
  readonly findingId: string;
  readonly revisionId: string;
  readonly ruleCode: string;
}

/**
 * Снятие блокирующего замечания руководителем.
 *
 * Право проверяет маршрут (`revision.override` выдано только `manager`), но
 * обоснование и след — здесь: §9.6 говорит «только с обоснованием и записью в
 * аудит», и оба условия обязаны выполняться независимо от того, какой маршрут
 * вызвал функцию. Пустое обоснование отвергает и БД (`findings_waived_chk`
 * требует автора и причину), поэтому инвариант держат оба уровня.
 *
 * Снимается ТОЛЬКО открытое блокирующее: снятие уже устранённого замечания
 * ничего не меняет, а снятие неблокирующего создаёт видимость работы там, где
 * решения не требовалось.
 */
export async function overrideFinding(
  db: Database,
  scope: AuthScope,
  input: OverrideInput,
): Promise<OverrideResult> {
  const rows = await db
    .select({
      id: findings.id,
      revisionId: findings.revisionId,
      objectId: findings.objectId,
      ruleCode: findings.ruleCode,
      state: findings.state,
      isBlocking: findings.isBlocking,
      status: submissionRevisions.status,
      revisionNo: submissionRevisions.revisionNo,
    })
    .from(findings)
    .innerJoin(submissionRevisions, eq(findings.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, eq(findings.id, input.findingId)))
    .limit(1);

  const finding = rows[0];
  if (finding === undefined) throw notFound('Замечание не найдено.');
  if (!REVIEWABLE.includes(finding.status as WorkflowStatus)) {
    throw conflict(
      `Замечание ревизии в статусе «${finding.status}» не снимается: ` +
        'решение по ней уже принято.',
    );
  }
  if (!finding.isBlocking || finding.state !== 'open') {
    throw conflict(
      'Снимается только открытое блокирующее замечание: ' +
        `сейчас оно ${finding.isBlocking ? 'не открыто' : 'не блокирующее'}.`,
    );
  }

  await guardWorkflow(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(findings)
        .set({
          state: 'waived',
          waivedBy: input.actorUserId,
          waivedAt: sql`now()`,
          waiverReason: input.reason,
        })
        .where(and(eq(findings.id, input.findingId), eq(findings.state, 'open')))
        .returning({ id: findings.id });

      if (updated.length === 0) {
        throw conflict('Замечание изменено другим пользователем: перечитайте список.');
      }

      await recordAction(tx, scope, {
        revisionId: finding.revisionId,
        objectId: finding.objectId,
        actorUserId: input.actorUserId,
        action: 'override',
        comment: input.reason,
        actor: input.actor,
        auditPayload: { findingId: input.findingId, ruleCode: finding.ruleCode },
        eventPayload: { findingId: input.findingId, ruleCode: finding.ruleCode },
      });
    }),
  );

  return {
    findingId: input.findingId,
    revisionId: finding.revisionId,
    ruleCode: finding.ruleCode,
  };
}

// =====================================================================
// История согласования
// =====================================================================

export interface ReviewActionView {
  readonly id: string;
  readonly revisionId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly comment: string | null;
  readonly at: string;
}

export async function listReviewActions(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<readonly ReviewActionView[]> {
  return db
    .select({
      id: reviewActions.id,
      revisionId: reviewActions.revisionId,
      actorUserId: reviewActions.actorUserId,
      action: reviewActions.action,
      comment: reviewActions.comment,
      at: sql<string>`to_char(${reviewActions.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
        'at_iso',
      ),
    })
    .from(reviewActions)
    .innerJoin(submissionRevisions, eq(reviewActions.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, eq(reviewActions.revisionId, revisionId)))
    .orderBy(desc(reviewActions.at), asc(reviewActions.id));
}

// =====================================================================
// Legal hold (§4.2)
// =====================================================================

export interface LegalHoldView {
  readonly id: string;
  readonly revisionId: string;
  readonly objectId: string;
  readonly reason: string;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
  readonly releaseNote: string | null;
}

const HOLD_SELECTION = {
  id: legalHolds.id,
  revisionId: legalHolds.revisionId,
  objectId: legalHolds.objectId,
  reason: legalHolds.reason,
  placedBy: legalHolds.placedBy,
  placedAt:
    sql<string>`to_char(${legalHolds.placedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
      'placed_at_iso',
    ),
  releasedBy: legalHolds.releasedBy,
  releasedAt: iso(legalHolds.releasedAt, 'released_at_iso'),
  releaseNote: legalHolds.releaseNote,
};

export async function listLegalHolds(
  db: Database,
  scope: AuthScope,
  filter: { readonly revisionId?: string | undefined; readonly activeOnly?: boolean } = {},
): Promise<readonly LegalHoldView[]> {
  const conditions = [
    ...(filter.revisionId === undefined ? [] : [eq(legalHolds.revisionId, filter.revisionId)]),
    ...(filter.activeOnly === true ? [isNull(legalHolds.releasedAt)] : []),
  ];
  return db
    .select(HOLD_SELECTION)
    .from(legalHolds)
    .innerJoin(submissionRevisions, eq(legalHolds.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, ...conditions))
    .orderBy(desc(legalHolds.placedAt), asc(legalHolds.id));
}

export interface PlaceHoldInput {
  readonly revisionId: string;
  readonly reason: string;
  readonly actorUserId: string;
  readonly actor: AuditActor;
}

export async function placeLegalHold(
  db: Database,
  scope: AuthScope,
  input: PlaceHoldInput,
): Promise<LegalHoldView> {
  const revision = await requireRevision(db, scope, input.revisionId);

  const id = await guardWorkflow(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(legalHolds)
        .values({
          revisionId: input.revisionId,
          objectId: revision.objectId,
          reason: input.reason,
          placedBy: input.actorUserId,
        })
        .returning({ id: legalHolds.id });

      const row = inserted[0];
      if (row === undefined) throw conflict('Удержание не наложено: повторите действие.');

      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'legal_hold.placed',
        entityType: 'legal_hold',
        entityId: row.id,
        objectId: revision.objectId,
        payload: { revisionId: input.revisionId, revisionNo: revision.revisionNo },
      });
      return row.id;
    }),
  );

  const holds = await listLegalHolds(db, scope, { revisionId: input.revisionId });
  const hold = holds.find((item) => item.id === id);
  if (hold === undefined) throw notFound('Удержание не читается сразу после записи.');
  return hold;
}

export interface ReleaseHoldInput {
  readonly holdId: string;
  readonly note: string;
  readonly actorUserId: string;
  readonly actor: AuditActor;
}

export async function releaseLegalHold(
  db: Database,
  scope: AuthScope,
  input: ReleaseHoldInput,
): Promise<LegalHoldView> {
  const rows = await db
    .select({
      id: legalHolds.id,
      revisionId: legalHolds.revisionId,
      objectId: legalHolds.objectId,
      releasedAt: legalHolds.releasedAt,
    })
    .from(legalHolds)
    .innerJoin(submissionRevisions, eq(legalHolds.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, eq(legalHolds.id, input.holdId)))
    .limit(1);

  const hold = rows[0];
  if (hold === undefined) throw notFound('Удержание не найдено.');
  if (hold.releasedAt !== null) throw conflict('Удержание уже снято.');

  await guardWorkflow(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(legalHolds)
        .set({
          releasedBy: input.actorUserId,
          releasedAt: sql`now()`,
          releaseNote: input.note,
        })
        .where(and(eq(legalHolds.id, input.holdId), isNull(legalHolds.releasedAt)))
        .returning({ id: legalHolds.id });

      if (updated.length === 0) throw conflict('Удержание уже снято другим пользователем.');

      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'legal_hold.released',
        entityType: 'legal_hold',
        entityId: input.holdId,
        objectId: hold.objectId,
        payload: { revisionId: hold.revisionId },
      });
    }),
  );

  const fresh = await listLegalHolds(db, scope, { revisionId: hold.revisionId });
  const result = fresh.find((item) => item.id === input.holdId);
  if (result === undefined) throw notFound('Удержание не читается сразу после записи.');
  return result;
}

/** Число действующих удержаний ревизии: вход решения о хранении (§4.2). */
export async function countActiveHolds(db: Database, revisionId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(legalHolds)
    .where(and(eq(legalHolds.revisionId, revisionId), isNull(legalHolds.releasedAt)));
  return rows[0]?.value ?? 0;
}
