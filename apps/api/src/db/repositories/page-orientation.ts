/**
 * Разворот содержимого страницы: чтение, ручная правка и запись зонда (ADR-0020).
 *
 * ## Величина и её единственный смысл
 *
 * `content_rotation` отвечает на вопрос «на сколько градусов ПО ЧАСОВОЙ СТРЕЛКЕ
 * повернуть растр страницы, чтобы текст читался нормально». Это поправка к
 * скану, легшему на лист боком при нулевом `/Rotate`, — не сам `/Rotate`
 * (`source_pages.rotation`), который к моменту растеризации уже применён.
 *
 * ## Почему ручное значение зонд не перекрывает, и почему правило в SQL
 *
 * `ON CONFLICT … WHERE source <> 'user'` — не оптимизация. Инженер поворачивает
 * страницу тогда же, когда по комплекту идут задачи зонда: между чтением строки
 * в обработчике и её записью помещается чужая транзакция, и «проверить, потом
 * записать» проиграло бы эту гонку молча — человек увидел бы, как его поворот
 * откатывается сам собой через несколько секунд. Условие в самом запросе делает
 * гонку невозможной, а не маловероятной.
 *
 * ## Что делает снятие ручной правки
 *
 * Два разных случая, и различает их наличие мнения зонда.
 *
 * Зонд отвечал (или честно отказался) — строка ОСТАЁТСЯ: его мнение лежит в ней
 * же, в отдельных колонках, и никуда не девалось. `content_rotation` возвращается
 * к `probe_rotation`, `source` — к `probe`. Это отличие от ручной метки вида ИД
 * (`deleteManualPageLabel`), где машинное решение затёрто и воскрешать нечего.
 *
 * Зонда не было вовсе (страницу развернули руками до всякого зонда) — строка
 * УДАЛЯЕТСЯ. Оставить её с `source = 'probe'` нельзя буквально: CHECK
 * `page_orientations_probe_evidence_chk` требует от строки зонда сказать, что он
 * видел, либо почему не увидел ничего, — и правильно требует, иначе «зонд
 * ответил ноль» стало бы неотличимо от «зонда не было». Отсутствие строки и есть
 * честное «решения никто не принимал».
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { pageOrientations, sourcePages } from '@id/db';
import type { ContentRotation, ContentRotationSource } from '@id/contracts';

import type { AuthScope } from '../../auth/scope.js';
import { notFound } from '../../lib/problem.js';
import { appendAudit, type AuditActor } from './audit.js';
// `guardWrites` и `requireMutableRevision` берутся из `documents.ts`, а не
// пишутся здесь заново: правило «в каких статусах производное решение можно
// менять» и перевод отказа БД в осмысленный ответ обязаны быть одними на всех.
import { guardWrites, requireMutableRevision } from './documents.js';
import type { Database } from './users.js';

export interface PageOrientationView {
  readonly revisionId: string;
  readonly sourcePageId: string;
  readonly contentRotation: ContentRotation;
  /**
   * Кем поставлен разворот; `null` — решения нет вовсе (строки нет).
   *
   * Нулевое значение и отсутствие решения различимы намеренно: «зонд посмотрел
   * и сказал ноль» и «никто не смотрел» ведут себя одинаково сегодня, но
   * отвечают на разные вопросы, и склеивать их в контракте нельзя.
   */
  readonly source: ContentRotationSource | null;
  /** Что увидел зонд; `null` — зонд не отвечал (или ответил отказом). */
  readonly probeRotation: ContentRotation | null;
  readonly probeConfidence: number | null;
  readonly probeError: string | null;
}

function toRotation(value: number | null): ContentRotation | null {
  return value === 0 || value === 90 || value === 180 || value === 270 ? value : null;
}

function toView(row: {
  readonly revisionId: string;
  readonly sourcePageId: string;
  readonly contentRotation: number;
  readonly source: string;
  readonly probeRotation: number | null;
  readonly probeConfidence: number | null;
  readonly probeError: string | null;
}): PageOrientationView {
  return {
    revisionId: row.revisionId,
    sourcePageId: row.sourcePageId,
    contentRotation: toRotation(row.contentRotation) ?? 0,
    source: row.source === 'user' ? 'user' : 'probe',
    probeRotation: toRotation(row.probeRotation),
    probeConfidence: row.probeConfidence,
    probeError: row.probeError,
  };
}

const SELECTION = {
  revisionId: pageOrientations.revisionId,
  sourcePageId: pageOrientations.sourcePageId,
  contentRotation: pageOrientations.contentRotation,
  source: pageOrientations.source,
  probeRotation: pageOrientations.probeRotation,
  probeConfidence: pageOrientations.probeConfidence,
  probeError: pageOrientations.probeError,
};

/**
 * Развороты страниц ревизии.
 *
 * Область видимости здесь не проверяется намеренно: единственные вызывающие —
 * задачи воркера, у которых ревизия уже разрешена, и маршрут, который до вызова
 * прошёл `requireMutableRevision`. Свой `withScope` означал бы второе правило
 * доступа к тем же строкам.
 */
export async function listPageOrientations(
  db: Database,
  revisionId: string,
): Promise<readonly PageOrientationView[]> {
  const rows = await db
    .select(SELECTION)
    .from(pageOrientations)
    .where(eq(pageOrientations.revisionId, revisionId));
  return rows.map(toView);
}

export async function findPageOrientation(
  db: Database,
  revisionId: string,
  sourcePageId: string,
): Promise<PageOrientationView | null> {
  const rows = await db
    .select(SELECTION)
    .from(pageOrientations)
    .where(
      and(
        eq(pageOrientations.revisionId, revisionId),
        eq(pageOrientations.sourcePageId, sourcePageId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/** Страницы ревизии, у которых строки разворота ещё нет: вход пачки зонда. */
export async function listPagesWithoutOrientation(
  db: Database,
  revisionId: string,
  sourcePageIds: readonly string[],
): Promise<readonly string[]> {
  if (sourcePageIds.length === 0) return [];
  const known = await db
    .select({ sourcePageId: pageOrientations.sourcePageId })
    .from(pageOrientations)
    .where(
      and(
        eq(pageOrientations.revisionId, revisionId),
        inArray(pageOrientations.sourcePageId, [...sourcePageIds]),
      ),
    );
  const seen = new Set(known.map((row) => row.sourcePageId));
  return sourcePageIds.filter((id) => !seen.has(id));
}

export interface SaveManualOrientationInput {
  readonly revisionId: string;
  readonly sourcePageId: string;
  readonly rotation: ContentRotation;
  readonly actor: AuditActor;
}

/**
 * Ручной разворот: перекрывает зонда и сохраняет его мнение нетронутым.
 *
 * Колонки `probe_*` не обнуляются, и это существенно: без них исчезает ответ на
 * вопрос «зонд ошибся или инженер?», ради которого зонд и заводился. Строка,
 * созданная руками до всякого зонда, честно несёт в них `NULL`.
 */
export async function saveManualPageOrientation(
  db: Database,
  scope: AuthScope,
  input: SaveManualOrientationInput,
): Promise<PageOrientationView> {
  const revision = await requireMutableRevision(db, scope, input.revisionId);

  const pageRows = await db
    .select({ id: sourcePages.id })
    .from(sourcePages)
    .where(
      and(eq(sourcePages.id, input.sourcePageId), eq(sourcePages.revisionId, input.revisionId)),
    )
    .limit(1);
  if (pageRows[0] === undefined) throw notFound('Страница не принадлежит этой ревизии.');

  await guardWrites(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(pageOrientations)
        .values({
          revisionId: input.revisionId,
          sourcePageId: input.sourcePageId,
          contentRotation: input.rotation,
          source: 'user',
        })
        .onConflictDoUpdate({
          target: [pageOrientations.revisionId, pageOrientations.sourcePageId],
          set: {
            contentRotation: input.rotation,
            source: 'user',
            updatedAt: sql`now()`,
          },
        });
      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'page.orientation_set',
        entityType: 'source_page',
        entityId: input.sourcePageId,
        objectId: revision.objectId,
        payload: { contentRotation: input.rotation },
      });
    }),
  );

  const saved = await findPageOrientation(db, input.revisionId, input.sourcePageId);
  if (saved === null) throw notFound('Разворот страницы не сохранился.');
  return saved;
}

/**
 * Снятие ручного разворота: возврат к мнению зонда.
 *
 * Строка остаётся: в ней лежит ответ зонда, и удалить её значило бы потерять
 * его вместе с провенансом вызова, за который уже заплачено. Если зонд не
 * отвечал вовсе, действующим становится ноль — «разворота нет» это тоже ответ.
 */
export async function clearManualPageOrientation(
  db: Database,
  scope: AuthScope,
  input: {
    readonly revisionId: string;
    readonly sourcePageId: string;
    readonly actor: AuditActor;
  },
): Promise<PageOrientationView> {
  const revision = await requireMutableRevision(db, scope, input.revisionId);

  await guardWrites(() =>
    db.transaction(async (tx) => {
      const manual = and(
        eq(pageOrientations.revisionId, input.revisionId),
        eq(pageOrientations.sourcePageId, input.sourcePageId),
        eq(pageOrientations.source, 'user'),
      );

      // Мнение зонда есть — возвращаемся к нему.
      const reverted = await tx
        .update(pageOrientations)
        .set({
          contentRotation: sql`coalesce(${pageOrientations.probeRotation}, 0)`,
          source: 'probe',
          updatedAt: sql`now()`,
        })
        .where(
          and(
            manual,
            sql`(${pageOrientations.probeRotation} is not null
                           or ${pageOrientations.probeError} is not null)`,
          ),
        )
        .returning({ sourcePageId: pageOrientations.sourcePageId });

      if (reverted.length === 0) {
        // Зонда не было: строка целиком принадлежала человеку, и её отсутствие —
        // ровно то состояние, в которое он просит вернуть страницу.
        const removed = await tx
          .delete(pageOrientations)
          .where(manual)
          .returning({ sourcePageId: pageOrientations.sourcePageId });
        if (removed.length === 0) {
          throw notFound('Ручной разворот этой страницы не найден.');
        }
      }
      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'page.orientation_cleared',
        entityType: 'source_page',
        entityId: input.sourcePageId,
        objectId: revision.objectId,
        payload: {},
      });
    }),
  );

  const remaining = await findPageOrientation(db, input.revisionId, input.sourcePageId);
  // Строки не осталось — это и есть ответ «решения никто не принимал».
  return (
    remaining ?? {
      revisionId: input.revisionId,
      sourcePageId: input.sourcePageId,
      contentRotation: 0,
      source: null,
      probeRotation: null,
      probeConfidence: null,
      probeError: null,
    }
  );
}

export interface ProbeOrientationInput {
  readonly revisionId: string;
  readonly sourcePageId: string;
  /** Что увидел зонд; `null` — не увидел ничего (тогда обязателен `error`). */
  readonly rotation: ContentRotation | null;
  readonly confidence: number | null;
  /**
   * Действующее значение. Отличается от `rotation` при низкой уверенности:
   * мнение записывается, а страница остаётся неповёрнутой.
   */
  readonly effective: ContentRotation;
  readonly model: string | null;
  readonly promptCode: string | null;
  readonly promptVersion: number | null;
  readonly inputHash: string | null;
  readonly error: string | null;
}

/**
 * Запись ответа зонда.
 *
 * `WHERE source <> 'user'` в `ON CONFLICT` — единственная защита ручного
 * значения, и она обязана быть здесь, а не в вызывающем: см. шапку файла.
 * Возвращает `false`, когда запись не состоялась именно по этой причине, —
 * задача пишет об этом в журнал, а не считает, что отработала.
 */
export async function saveProbeOrientation(
  db: Database,
  input: ProbeOrientationInput,
): Promise<boolean> {
  const values = {
    revisionId: input.revisionId,
    sourcePageId: input.sourcePageId,
    contentRotation: input.effective,
    source: 'probe' as const,
    probeRotation: input.rotation,
    probeConfidence: input.confidence,
    probeModel: input.model,
    probePromptCode: input.promptCode,
    probePromptVersion: input.promptVersion,
    probeInputHash: input.inputHash,
    probedAt: sql`now()`,
    probeError: input.error,
  };

  const written = await guardWrites(() =>
    db
      .insert(pageOrientations)
      .values(values)
      .onConflictDoUpdate({
        target: [pageOrientations.revisionId, pageOrientations.sourcePageId],
        set: { ...values, updatedAt: sql`now()` },
        setWhere: sql`${pageOrientations.source} <> 'user'`,
      })
      .returning({ sourcePageId: pageOrientations.sourcePageId }),
  );

  return written.length > 0;
}
