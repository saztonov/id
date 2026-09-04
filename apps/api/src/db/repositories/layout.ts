/**
 * Ревизии разметки, блоки и RD-документ прогона (§3.4, §5.2, §6.1, §7).
 *
 * ## Что здесь считается источником правды
 *
 * Набор блоков ревизии разметки — это ЗАКАЗ на распознавание. Всё остальное
 * (`blocks_hash`, удалённый набор блоков RD WEB, артефакты прогона) описывает
 * его же с разных сторон, поэтому канонический хэш обязан считаться по одному
 * правилу и в одном месте — `computeBlocksHash()`. Вторая реализация хэша
 * означала бы, что цикл сверки §5.2 сравнивает два разных представления одного
 * набора и либо вечно расходится, либо вечно совпадает.
 *
 * ## Почему у блока нет собственной версии
 *
 * Оптимистичная блокировка (§7.2, `If-Match`) ведётся по `layout_revisions.version`,
 * а не по версии блока: в схеме S2 у `layout_blocks` колонки `version` нет, и
 * добавлять её незачем. Единица конфликта на экране разметки — не блок, а
 * страница целиком: пользователь двигает рамку, второй в это время удаляет
 * соседнюю, и «моя версия блока не менялась» ничего не говорит о том, что набор
 * страницы уже другой. Поэтому любая мутация поднимает версию ревизии разметки,
 * и она же служит ETag.
 *
 * ## Область видимости
 *
 * У `layout_revisions` есть собственный денормализованный `object_id`, но
 * `contractor_id` — только у ревизии поставки, поэтому область применяется
 * соединением с `folders` (как в `bundles.ts`). Ни один запрос
 * этого файла не выполняется без `withScope()`: подрядчик не видит чужую
 * разметку ни списком, ни по прямому идентификатору (§16).
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  layoutBlockPoints,
  layoutBlocks,
  layoutProfiles,
  layoutRevisions,
  processingBundlePages,
  processingBundles,
  rdRunDocuments,
  sourcePages,
  folders,
} from '@id/db';
import {
  attentionFlagSchema,
  classifySheet,
  LEGACY_MARKUP_POLICY,
  parseMarkupPolicy,
  type AttentionFlag,
  type BlockType,
  type DetectorProvenance,
  type MarkupPolicy,
  type ShapeType,
} from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import { unionArea } from '../../layout/attention.js';
import { conflict, internal, notFound, preconditionFailed } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendFolderEvent, type JobExecutor } from './jobs.js';
import type { Database } from './users.js';

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/**
 * Статусы ревизии поставки, в которых разметку менять можно.
 *
 * Разметка относится к классу `derived` (0008): её производит конвейер и правит
 * проверяющий, поэтому она заперта только в терминальных состояниях, а не с
 * момента подачи. Список продублирован здесь сознательно — отказ обязан
 * приходить понятным текстом до дорогой работы, а не исключением триггера
 * после неё.
 */

/** Код профиля разметки по умолчанию (миграция 0012). */
export const DEFAULT_LAYOUT_PROFILE_CODE = 'default';

// =====================================================================
// Канонический хэш набора блоков
// =====================================================================

/**
 * Версия канонической формы. Входит в хэш: изменив состав полей, мы обязаны
 * получить другие хэши, иначе старый пин перестанет описывать то, что описывал.
 */
export const BLOCKS_HASH_VERSION = 2;

/**
 * Разрядность координат в каноническом виде.
 *
 * Координаты уезжают в RD WEB и возвращаются оттуда через JSON, то есть
 * проходят через двоичное представление double и обратно. Сравнивать их
 * побитово нельзя: `0.1 + 0.2` на одной стороне и разбор `0.30000000000000004`
 * на другой дали бы вечное расхождение хэшей и `integrity_error` на исправном
 * прогоне. Шесть знаков — это доля пикселя даже на странице 4000 px.
 */
const COORD_PRECISION = 6;

function fixed(value: number): string {
  // `toFixed` даёт «-0.000000» для отрицательного нуля; нормализуем, иначе
  // одинаковая геометрия дала бы два разных хэша.
  const text = value.toFixed(COORD_PRECISION);
  return text === `-${(0).toFixed(COORD_PRECISION)}` ? (0).toFixed(COORD_PRECISION) : text;
}

/** Блок в том виде, в каком он участвует в хэше. Идентификаторов здесь нет. */
export interface HashableBlock {
  readonly workingPageIndex: number;
  readonly blockType: string;
  readonly shapeType: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly sortOrder: number;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/** Геометрия блока без порядка чтения: страница, тип, форма, координаты, точки. */
function geometryRow(block: HashableBlock): string {
  const points = block.points.map((p) => `${fixed(p.x)},${fixed(p.y)}`).join(';');
  return [
    block.workingPageIndex,
    block.blockType,
    block.shapeType,
    fixed(block.x0),
    fixed(block.y0),
    fixed(block.x1),
    fixed(block.y1),
    points,
  ].join('|');
}

/**
 * Отпечаток геометрии ОДНОГО блока — ключ узнавания «это тот же блок».
 *
 * Экспортируется ради реестра внешних идентификаторов RD WEB
 * (`rd_exec_blocks.geometry_key`): там нужно ответить на вопрос «эта рамка уже
 * объявлялась?» после переразметки, которая снесла строки `source='auto'` и
 * вставила их заново с новыми `uuid`. Без такого ключа неизменившийся блок
 * выглядел бы для RD WEB новым, и комплект перераспознавался бы целиком за наш
 * счёт.
 *
 * Считается по ТОЙ ЖЕ канонической строке, что участвует в `computeBlocksHash`,
 * и это не экономия, а условие: вторая канонизация геометрии в проекте разошлась
 * бы с первой молча — ровно тем классом расхождения, ради которого `geometryRow`
 * и написан один раз.
 *
 * Порядок чтения в ключ НЕ входит (его нет в `geometryRow`) — и правильно:
 * контракт RD WEB относит `sort_order` к `metadata_only`, то есть перестановка
 * блоков местами не меняет ни выреза, ни его идентичности.
 */
export function blockGeometryKey(block: HashableBlock): string {
  return createHash('sha256').update(geometryRow(block), 'utf8').digest('hex');
}

/** Группа порядка чтения — та же ось, что у `_next_sort_order` RD WEB: страница × тип. */
function orderGroupKey(block: HashableBlock): string {
  return `${block.workingPageIndex}|${block.blockType}`;
}

/**
 * Порядок чтения в канонической форме — ПЛОТНЫЙ РАНГ, а не сырое `sort_order`.
 *
 * Это не косметика, а условие исполнимости §5.2, шага 5. `sort_order` на
 * удалённой стороне назначает ИХ сервер (`_next_sort_order` = max+1 внутри
 * группы «страница × тип»), нашего значения он не принимает ни в create, ни в
 * PATCH. После любого удаления в группе остаются дыры (0, 5, 7), и сырые числа
 * двух сторон не совпали бы никогда — то есть хэши расходились бы на исправном
 * прогоне, а `integrity_error` перестал бы что-либо значить.
 *
 * Ранг же выражает ровно то, что порядок чтения и означает: «этот блок идёт
 * вторым в своей группе». Он вычисляется одинаково из локальных строк и из
 * ответа RD WEB, а разрыв нумерации на него не влияет. Тай-брейк по геометрии
 * обязателен: идентификаторы блоков у двух сторон разные, и без него два блока
 * с равным `sort_order` получили бы ранги в порядке выдачи.
 */
function withOrderRanks(blocks: readonly HashableBlock[]): readonly string[] {
  const groups = new Map<string, { readonly sortOrder: number; readonly row: string }[]>();
  for (const block of blocks) {
    const key = orderGroupKey(block);
    const entry = { sortOrder: block.sortOrder, row: geometryRow(block) };
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [entry]);
    else list.push(entry);
  }

  const rows: string[] = [];
  for (const list of groups.values()) {
    const ordered = [...list].sort(
      (a, b) => a.sortOrder - b.sortOrder || (a.row < b.row ? -1 : a.row > b.row ? 1 : 0),
    );
    ordered.forEach((entry, rank) => {
      rows.push(`${entry.row}|#${rank}`);
    });
  }
  return rows;
}

/**
 * Канонический хэш набора блоков.
 *
 * Детерминирован и не зависит ни от порядка строк в БД, ни от локальных
 * идентификаторов: строки приводятся к каноническому виду и сортируются
 * лексикографически. Это принципиально — удалённая сторона (RD WEB) своих
 * `block_id` нам не сообщает заранее и порядок выдачи не гарантирует, а хэш
 * обязан совпасть с локальным (§5.2, шаг 5).
 *
 * Порядок точек полигона, наоборот, значим и сохраняется: он задаёт саму форму.
 */
export function computeBlocksHash(blocks: readonly HashableBlock[]): string {
  const rows = [...withOrderRanks(blocks)].sort();
  const canonical = `v${BLOCKS_HASH_VERSION}\n${rows.join('\n')}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// =====================================================================
// Профиль разметки
// =====================================================================

/**
 * Пороги флагов внимания (§7.3).
 *
 * Живут в `layout_profiles`, а не константами: калибровка порога не должна быть
 * релизом, а прошлый расчёт флагов обязан воспроизводиться по запиненному
 * профилю. Значения по умолчанию здесь — фолбэк на случай, если профиль не
 * заведён вовсе; они же лежат строкой в миграции 0012.
 */
export interface LayoutThresholds {
  /** Ниже этой доли union-площади страница получает `low_coverage`. */
  readonly minCoverageRatio: number;
  /** Ниже этой доли страница — кандидат в пустые. */
  readonly blankPageCoverageRatio: number;
  /** Площадь блока ниже этой доли страницы — `tiny_block`. */
  readonly tinyBlockAreaRatio: number;
  /** IoU двух блоков ОДНОГО класса выше порога — `suspicious_overlap`. */
  readonly overlapIouThreshold: number;
  /** Сторона блока меньше этой доли страницы — вырожденная геометрия. */
  readonly degenerateSideRatio: number;
  /** Отклонение числа блоков от соседних страниц выше доли — `neighbor_mismatch`. */
  readonly neighborCountDeltaRatio: number;
  /** Ниже этого числа блоков сравнение с соседями не делается: шум. */
  readonly neighborMinBlocks: number;
  /** Ждать ли `stamp` на странице, где есть `image` (схемы). */
  readonly expectStampOnImagePage: boolean;
  /**
   * Ниже какой доли покрытия страница уходит на распознавание ЦЕЛИКОМ
   * (`applyTextCoverageFallback`).
   *
   * Отличается от `minCoverageRatio` предметом: тот решает, показать ли человеку
   * флаг внимания, а этот — заменить ли скудную автоматическую разметку одним
   * блоком на всю страницу. Флаг ничего не меняет и ждёт человека; замена меняет
   * вход распознавания и делается сама, поэтому и порог у неё свой, заметно
   * выше.
   *
   * `0` — только страницы БЕЗ единого блока: детекция ничего не нашла, и
   * распознавать иначе нечего.
   *
   * Живёт в профиле разметки, а не в настройках портала, и это не вкусовщина:
   * профиль пинится ревизией разметки, значит прогон месячной давности
   * воспроизводится с тем порогом, с которым выполнялся, а применённая версия
   * профиля уже уезжает в событие `layout.coverage_analyzed`. Глобальная
   * настройка меняла бы прошлое молча.
   */
  readonly textFallbackCoverageRatio: number;
}

export const FALLBACK_LAYOUT_THRESHOLDS: LayoutThresholds = {
  minCoverageRatio: 0.12,
  blankPageCoverageRatio: 0.02,
  tinyBlockAreaRatio: 0.002,
  overlapIouThreshold: 0.2,
  degenerateSideRatio: 0.002,
  neighborCountDeltaRatio: 0.6,
  neighborMinBlocks: 3,
  expectStampOnImagePage: false,
  textFallbackCoverageRatio: 0.35,
};

export interface LayoutProfileView {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly thresholds: LayoutThresholds;
}

function numberOr(source: Record<string, unknown>, key: keyof LayoutThresholds): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : (FALLBACK_LAYOUT_THRESHOLDS[key] as number);
}

/**
 * Разбор порогов профиля.
 *
 * Отсутствующий или непригодный ключ заменяется фолбэком, а не роняет расчёт:
 * флаг внимания — подсказка человеку, и потерять её из-за опечатки в jsonb
 * хуже, чем посчитать по значению по умолчанию. Опечатка при этом видна —
 * `layout.analyze_coverage` пишет применённый профиль в событие ревизии.
 */
export function parseThresholds(raw: unknown): LayoutThresholds {
  if (typeof raw !== 'object' || raw === null) return FALLBACK_LAYOUT_THRESHOLDS;
  const source = raw as Record<string, unknown>;
  return {
    minCoverageRatio: numberOr(source, 'minCoverageRatio'),
    blankPageCoverageRatio: numberOr(source, 'blankPageCoverageRatio'),
    tinyBlockAreaRatio: numberOr(source, 'tinyBlockAreaRatio'),
    overlapIouThreshold: numberOr(source, 'overlapIouThreshold'),
    degenerateSideRatio: numberOr(source, 'degenerateSideRatio'),
    neighborCountDeltaRatio: numberOr(source, 'neighborCountDeltaRatio'),
    neighborMinBlocks: numberOr(source, 'neighborMinBlocks'),
    // Профили, заведённые до S27, ключа не содержат: `numberOr` подставит
    // умолчание, и миграции под новый порог не требуется.
    textFallbackCoverageRatio: numberOr(source, 'textFallbackCoverageRatio'),
    expectStampOnImagePage:
      typeof source.expectStampOnImagePage === 'boolean'
        ? source.expectStampOnImagePage
        : FALLBACK_LAYOUT_THRESHOLDS.expectStampOnImagePage,
  };
}

/**
 * Профиль, действующий на дату.
 *
 * Справочник конфигурации, а не коммерческие данные: областью видимости не
 * ограничивается — по той же границе, что на S4 отделила профили разделов от
 * контрагентов.
 */
export async function findActiveLayoutProfile(
  db: Database,
  code: string = DEFAULT_LAYOUT_PROFILE_CODE,
  onDate?: string,
): Promise<LayoutProfileView | null> {
  const day = onDate ?? new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: layoutProfiles.id,
      code: layoutProfiles.code,
      version: layoutProfiles.version,
      thresholds: layoutProfiles.thresholds,
    })
    .from(layoutProfiles)
    .where(
      and(
        eq(layoutProfiles.code, code),
        sql`${layoutProfiles.effectiveFrom} <= ${day}::date`,
        sql`(${layoutProfiles.effectiveTo} is null or ${layoutProfiles.effectiveTo} > ${day}::date)`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    thresholds: parseThresholds(row.thresholds),
  };
}

/** Профиль, запиненный ревизией разметки; иначе — действующий сейчас. */
export async function loadProfileForLayout(
  db: Database,
  layoutProfileId: string | null,
): Promise<LayoutProfileView | null> {
  if (layoutProfileId === null) return findActiveLayoutProfile(db);
  const rows = await db
    .select({
      id: layoutProfiles.id,
      code: layoutProfiles.code,
      version: layoutProfiles.version,
      thresholds: layoutProfiles.thresholds,
    })
    .from(layoutProfiles)
    .where(eq(layoutProfiles.id, layoutProfileId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return findActiveLayoutProfile(db);
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    thresholds: parseThresholds(row.thresholds),
  };
}

// =====================================================================
// Чтение ревизии разметки
// =====================================================================

export interface LayoutRevisionView {
  readonly id: string;
  readonly folderId: string;
  readonly objectId: string;
  readonly bundleId: string;
  readonly revisionNo: number;
  readonly state: string;
  readonly blocksHash: string | null;
  readonly version: number;
  readonly detectorProfile: string;
  readonly layoutProfileId: string | null;
  readonly firstManualEditAt: string | null;
  readonly frozenAt: string | null;
  readonly frozenBy: string | null;
  readonly createdAt: string;
  /**
   * Правило разметки, ЗАПИНЕННОЕ при создании черновика (S42).
   *
   * Читать настройку вместо этого поля нельзя нигде, кроме самого пина:
   * детекция, анализ покрытия, заплатка и экран разметки спрашивают правило в
   * разные моменты времени, и настройка, сменившаяся между ними, дала бы одну
   * ревизию, размеченную двумя правилами.
   */
  readonly markupPolicy: MarkupPolicy;
}

const LAYOUT_SELECTION = {
  id: layoutRevisions.id,
  folderId: layoutRevisions.folderId,
  objectId: layoutRevisions.objectId,
  bundleId: layoutRevisions.bundleId,
  revisionNo: layoutRevisions.revisionNo,
  state: layoutRevisions.state,
  blocksHash: layoutRevisions.blocksHash,
  version: layoutRevisions.version,
  detectorProfile: layoutRevisions.detectorProfile,
  layoutProfileId: layoutRevisions.layoutProfileId,
  firstManualEditAt: sql<
    string | null
  >`to_char(${layoutRevisions.firstManualEditAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    'first_manual_edit_at_iso',
  ),
  frozenAt: sql<
    string | null
  >`to_char(${layoutRevisions.frozenAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    'frozen_at_iso',
  ),
  frozenBy: layoutRevisions.frozenBy,
  createdAt:
    sql<string>`to_char(${layoutRevisions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
      'created_at_iso',
    ),
  markupPolicy: layoutRevisions.markupPolicy,
};

type LayoutRow = { readonly markupPolicy: unknown } & Omit<LayoutRevisionView, 'markupPolicy'>;

/**
 * Строка в вид: разбор политики — единственное, что здесь происходит.
 *
 * `parseMarkupPolicy` возвращает прежнее поведение на непригодном значении, а
 * не бросает: колонку пишут миграция и портал, но экран разметки не должен
 * отвечать пятисоткой на строку, которую поправили руками в консоли БД.
 */
function toLayoutView(row: LayoutRow): LayoutRevisionView {
  return { ...row, markupPolicy: parseMarkupPolicy(row.markupPolicy) };
}

export async function findLayoutRevision(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
): Promise<LayoutRevisionView | null> {
  const rows = await db
    .select(LAYOUT_SELECTION)
    .from(layoutRevisions)
    .innerJoin(folders, eq(layoutRevisions.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(layoutRevisions.id, layoutRevisionId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toLayoutView(row);
}

export async function listLayoutRevisions(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<readonly LayoutRevisionView[]> {
  const rows = await db
    .select(LAYOUT_SELECTION)
    .from(layoutRevisions)
    .innerJoin(folders, eq(layoutRevisions.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(layoutRevisions.folderId, folderId)))
    .orderBy(asc(layoutRevisions.revisionNo));
  return rows.map(toLayoutView);
}

/** Единственный черновик разметки поставки (частичный UNIQUE, 0004). */
export async function findDraftLayout(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<LayoutRevisionView | null> {
  const rows = await db
    .select(LAYOUT_SELECTION)
    .from(layoutRevisions)
    .innerJoin(folders, eq(layoutRevisions.folderId, folders.id))
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        eq(layoutRevisions.folderId, folderId),
        eq(layoutRevisions.state, 'draft'),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toLayoutView(row);
}

/**
 * Вернуть последнюю разметку ревизии в работу как черновик.
 *
 * Осталось от заморозки (0048) и продолжает быть нужным по другой причине:
 * `superseded`-ревизии есть в базах, работавших до отмены заморозки, и повторная
 * разметка обязана попасть в ту же строку, а не заводить новую по номеру.
 * `null` — размораживать нечего: разметки у ревизии ещё нет, и вызывающий
 * заведёт первую обычным путём.
 *
 * `bundle_id` переписывается на текущий рабочий документ: комплект могли
 * пересобрать между нажатиями, и разметка обязана лежать на той карте страниц, по
 * которой её сейчас считают. Блоки при этом не трогаются — их заменит детекция,
 * а страницы вне новой карты отсеет `importDetectedBlocks`.
 */
async function thawLatestLayout(
  db: Database,
  scope: AuthScope,
  input: EnsureDraftLayoutInput,
): Promise<LayoutRevisionView | null> {
  const rows = await db
    .select({ id: layoutRevisions.id })
    .from(layoutRevisions)
    .innerJoin(folders, eq(layoutRevisions.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(layoutRevisions.folderId, input.folderId)))
    .orderBy(desc(layoutRevisions.revisionNo))
    .limit(1);

  const found = rows[0];
  if (found === undefined) return null;

  await db
    .update(layoutRevisions)
    .set({
      state: 'draft',
      blocksHash: null,
      frozenAt: null,
      frozenBy: null,
      bundleId: input.bundleId,
      version: sql`${layoutRevisions.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(layoutRevisions.id, found.id));

  await appendFolderEvent(db, {
    folderId: input.folderId,
    eventType: 'layout.thawed',
    payload: { layoutRevisionId: found.id, bundleId: input.bundleId },
  });

  return findLayoutRevision(db, scope, found.id);
}

// =====================================================================
// Создание черновика
// =====================================================================

export interface EnsureDraftLayoutInput {
  readonly folderId: string;
  readonly bundleId: string;
  /** §5.3: `full_page` допустим только на однородных текстовых комплектах. */
  readonly detectorProfile?: 'rf_detr' | 'full_page';
  /**
   * Правило разметки, пиннящееся на НОВОМ черновике (S42).
   *
   * Необязательно: вызывающие, которым разметку надо просто найти, правило не
   * читают, и черновик тогда получает прежнее поведение. Перепинить правило на
   * уже существующем черновике этот вызов НЕ может — это делает `pinMarkupPolicy`
   * по явному нажатию кнопки стадии.
   */
  readonly markupPolicy?: MarkupPolicy;
  /**
   * Строгий режим (`core.enforce_immutability`, ADR-0015). `false` — повторное
   * выделение блоков ПЕРЕЗАПИСЫВАЕТ единственную разметку вместо того, чтобы
   * заводить следующую по номеру. Умолчание строгое: забытый аргумент не имеет
   * права молча сменить поведение.
   */
  readonly enforceGates?: boolean;
}

export interface EnsureDraftLayoutResult {
  readonly layout: LayoutRevisionView;
  readonly created: boolean;
}

/**
 * Черновик разметки под рабочий документ: найти или создать.
 *
 * Идемпотентно по построению — частичный уникальный индекс не даёт двум
 * черновикам сосуществовать, и повторное нажатие «Разметить файл» обязано
 * попасть в тот же черновик, а не получить 409.
 *
 * Профиль порогов пиннится ЗДЕСЬ, а не в момент расчёта флагов: иначе
 * перепубликация профиля между детекцией и анализом дала бы флаги, посчитанные
 * по одному профилю, и запись о другом.
 *
 * ## Одна разметка вместо ряда ревизий (режим тестирования)
 *
 * Ряд «Ревизия 1, 2, 3…» превращал повторное нажатие кнопки в накопление мусора
 * и выносил наружу понятие, которого на экране быть не должно. Поэтому повтор
 * переиспользует ту же разметку. В базах, работавших до отмены заморозки (0048),
 * последняя ревизия могла остаться `superseded` — её и возвращает в работу
 * `thawLatestLayout`.
 *
 * Ручная правка при этом переживает переразметку: `importDetectedBlocks` сносит
 * только блоки `source='auto'` и целиком пропускает страницы с ручными.
 */
export async function ensureDraftLayout(
  db: Database,
  scope: AuthScope,
  input: EnsureDraftLayoutInput,
): Promise<EnsureDraftLayoutResult> {
  const existing = await findDraftLayout(db, scope, input.folderId);
  if (existing !== null) {
    if (existing.bundleId !== input.bundleId) {
      throw conflict(
        'Для этой поставки уже есть разметка по другому рабочему документу: ' +
          'пересоберите комплект или разметьте тот же документ.',
      );
    }
    return { layout: existing, created: false };
  }

  if (input.enforceGates === false) {
    const reused = await thawLatestLayout(db, scope, input);
    if (reused !== null) return { layout: reused, created: false };
  }

  const profile = await findActiveLayoutProfile(db);

  const layoutId = await db.transaction(async (tx) => {
    // Область проверяется внутри транзакции: строка ревизии и разрешение писать
    // — одно решение, и разносить их нельзя.
    const bundles = await tx
      .select({
        bundleId: processingBundles.id,
        folderId: processingBundles.folderId,
        objectId: folders.objectId,
      })
      .from(processingBundles)
      .innerJoin(folders, eq(processingBundles.folderId, folders.id))
      .where(
        withScope(
          scope,
          FOLDER_SCOPE,
          eq(processingBundles.id, input.bundleId),
          eq(processingBundles.folderId, input.folderId),
        ),
      )
      .limit(1);

    const bundle = bundles[0];
    if (bundle === undefined) throw notFound('Рабочий документ не найден.');

    const maxRows = await tx
      .select({ maxNo: sql<number>`coalesce(max(${layoutRevisions.revisionNo}), 0)::int` })
      .from(layoutRevisions)
      .where(eq(layoutRevisions.folderId, input.folderId));

    const inserted = await tx
      .insert(layoutRevisions)
      .values({
        folderId: bundle.folderId,
        objectId: bundle.objectId,
        bundleId: bundle.bundleId,
        revisionNo: (maxRows[0]?.maxNo ?? 0) + 1,
        state: 'draft',
        detectorProfile: input.detectorProfile ?? 'rf_detr',
        ...(input.markupPolicy === undefined ? {} : { markupPolicy: input.markupPolicy }),
        ...(profile !== null ? { layoutProfileId: profile.id } : {}),
      })
      .returning({ id: layoutRevisions.id });

    const row = inserted[0];
    if (row === undefined) {
      throw internal({ logDetail: 'INSERT ревизии разметки не вернул строку' });
    }

    await appendFolderEvent(tx, {
      folderId: bundle.folderId,
      eventType: 'layout.draft_created',
      payload: {
        layoutRevisionId: row.id,
        bundleId: bundle.bundleId,
        layoutProfileVersion: profile?.version ?? null,
        markupPolicy: input.markupPolicy ?? LEGACY_MARKUP_POLICY,
      },
    });

    return row.id;
  });

  const layout = await findLayoutRevision(db, scope, layoutId);
  if (layout === null) {
    throw internal({ logDetail: 'ревизия разметки не читается сразу после записи' });
  }
  return { layout, created: true };
}

/**
 * Перепин правила разметки на существующем черновике (S42).
 *
 * Вызывается ТОЛЬКО из обработчика кнопки стадии («Выделить блоки»): нажатие —
 * это решение человека разметить комплект заново, и вместе с ним правило
 * законно берётся текущее. Всё остальное — постраничные задачи детекции, анализ
 * покрытия, заплатка, экран — читает пин и переключения не видит, иначе смена
 * настройки посреди веера дала бы одну ревизию, размеченную двумя правилами.
 *
 * `version` не бампится: ETag ревизии сторожит НАБОР БЛОКОВ, а правило блоков
 * не меняет. Бамп здесь означал бы 412 у всех, кто держит экран разметки
 * открытым, — без единой правки в том, что на экране нарисовано.
 *
 * Событие пишется только при фактической смене: запись «правило прежнее» на
 * каждое нажатие кнопки утопила бы ленту ревизии в шуме.
 */
export async function pinMarkupPolicy(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly policy: MarkupPolicy;
  },
): Promise<{ readonly changed: boolean }> {
  const layout = await findLayoutRevision(db, scope, input.layoutRevisionId);
  if (layout === null) throw notFound('Ревизия разметки не найдена.');

  const before = layout.markupPolicy;
  const same =
    before.version === input.policy.version &&
    before.sheetStrategy === input.policy.sheetStrategy &&
    before.numberZone === input.policy.numberZone &&
    before.numberZonePad.x === input.policy.numberZonePad.x &&
    before.numberZonePad.y === input.policy.numberZonePad.y;
  if (same) return { changed: false };

  await db.transaction(async (tx) => {
    await tx
      .update(layoutRevisions)
      .set({ markupPolicy: input.policy, updatedAt: sql`now()` })
      .where(eq(layoutRevisions.id, layout.id));

    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.policy_pinned',
      payload: { layoutRevisionId: layout.id, from: before, to: input.policy },
    });
  });

  return { changed: true };
}

// =====================================================================
// Блоки
// =====================================================================

export interface LayoutBlockView {
  readonly id: string;
  readonly layoutRevisionId: string;
  readonly sourcePageId: string;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  readonly shapeType: ShapeType;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly sortOrder: number;
  readonly source: 'auto' | 'user';
  readonly detectorProvenance: DetectorProvenance;
  /**
   * Уверенность детектора, 0..1, либо `null`.
   *
   * `null` у ручных блоков и у блоков от легаси-API RD WEB: их `BlockOut`
   * уверенности не несёт (ADR-0004). Отсутствие значения — это «неизвестно», а
   * не «ноль», и на экране оно так и показывается.
   */
  readonly detectionScore: number | null;
  readonly points: readonly { readonly pointNo: number; readonly x: number; readonly y: number }[];
}

const BLOCK_SELECTION = {
  id: layoutBlocks.id,
  layoutRevisionId: layoutBlocks.layoutRevisionId,
  sourcePageId: layoutBlocks.sourcePageId,
  workingPageIndex: layoutBlocks.workingPageIndex,
  blockType: layoutBlocks.blockType,
  shapeType: layoutBlocks.shapeType,
  x0: layoutBlocks.x0,
  y0: layoutBlocks.y0,
  x1: layoutBlocks.x1,
  y1: layoutBlocks.y1,
  sortOrder: layoutBlocks.sortOrder,
  source: layoutBlocks.source,
  detectorProvenance: layoutBlocks.detectorProvenance,
  detectionScore: layoutBlocks.detectionScore,
};

/**
 * Блоки ревизии разметки вместе с точками полигонов.
 *
 * Точки читаются вторым запросом, а не JOIN'ом: соединение размножило бы каждый
 * прямоугольник на число точек его бывшей формы, а полигонов в комплекте
 * единицы. Порядок точек берётся из `point_no` — он и есть форма.
 */
/**
 * Номера страниц, на которых у ревизии уже есть блоки (S50).
 *
 * Отдельный запрос вместо `listLayoutBlocks`, потому что вопрос другой:
 * детекции нужно знать, размечена ли страница, а не какие на ней фигуры. Читая
 * блоки целиком, задача на 220-страничной папке тянула к концу прогона тысячи
 * строк вместе с их точками — и делала это на КАЖДОЙ странице, то есть объём
 * рос квадратично по ходу разметки.
 */
export async function listPagesWithBlocks(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
): Promise<ReadonlySet<number>> {
  const rows = await db
    .selectDistinct({ workingPageIndex: layoutBlocks.workingPageIndex })
    .from(layoutBlocks)
    .innerJoin(folders, eq(layoutBlocks.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(layoutBlocks.layoutRevisionId, layoutRevisionId)));

  return new Set(rows.map((row) => row.workingPageIndex));
}

export async function listLayoutBlocks(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
  workingPageIndex?: number,
): Promise<readonly LayoutBlockView[]> {
  const conditions = [eq(layoutBlocks.layoutRevisionId, layoutRevisionId)];
  if (workingPageIndex !== undefined) {
    conditions.push(eq(layoutBlocks.workingPageIndex, workingPageIndex));
  }

  const rows = await db
    .select(BLOCK_SELECTION)
    .from(layoutBlocks)
    .innerJoin(folders, eq(layoutBlocks.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, ...conditions))
    .orderBy(asc(layoutBlocks.workingPageIndex), asc(layoutBlocks.sortOrder), asc(layoutBlocks.id));

  if (rows.length === 0) return [];

  const points = await db
    .select({
      blockId: layoutBlockPoints.blockId,
      pointNo: layoutBlockPoints.pointNo,
      x: layoutBlockPoints.x,
      y: layoutBlockPoints.y,
    })
    .from(layoutBlockPoints)
    .where(
      inArray(
        layoutBlockPoints.blockId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(layoutBlockPoints.blockId), asc(layoutBlockPoints.pointNo));

  const byBlock = new Map<string, { pointNo: number; x: number; y: number }[]>();
  for (const point of points) {
    const list = byBlock.get(point.blockId);
    if (list === undefined) byBlock.set(point.blockId, [point]);
    else list.push(point);
  }

  return rows.map((row) => ({
    ...row,
    blockType: row.blockType as BlockType,
    shapeType: row.shapeType as ShapeType,
    source: row.source as 'auto' | 'user',
    detectorProvenance: row.detectorProvenance as DetectorProvenance,
    // У прямоугольника точки могут остаться от прежней формы — их отдаёт только
    // полигон. Та же гарда стоит у RD WEB в `blocks_json.py`.
    points: row.shapeType === 'polygon' ? (byBlock.get(row.id) ?? []) : [],
  }));
}

/** Блок вместе со своей ревизией разметки — вход всех правок. */
export interface BlockWithLayout {
  readonly block: LayoutBlockView;
  readonly layout: LayoutRevisionView;
}

export async function findLayoutBlock(
  db: Database,
  scope: AuthScope,
  blockId: string,
): Promise<BlockWithLayout | null> {
  const rows = await db
    .select({ ...BLOCK_SELECTION, ...LAYOUT_SELECTION, blockId: layoutBlocks.id })
    .from(layoutBlocks)
    .innerJoin(layoutRevisions, eq(layoutBlocks.layoutRevisionId, layoutRevisions.id))
    .innerJoin(folders, eq(layoutBlocks.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(layoutBlocks.id, blockId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  const blocks = await listLayoutBlocks(db, scope, row.layoutRevisionId, row.workingPageIndex);
  const block = blocks.find((candidate) => candidate.id === row.blockId);
  if (block === undefined) return null;

  return {
    block,
    layout: {
      id: row.id,
      folderId: row.folderId,
      objectId: row.objectId,
      bundleId: row.bundleId,
      revisionNo: row.revisionNo,
      state: row.state,
      blocksHash: row.blocksHash,
      version: row.version,
      detectorProfile: row.detectorProfile,
      layoutProfileId: row.layoutProfileId,
      firstManualEditAt: row.firstManualEditAt,
      markupPolicy: parseMarkupPolicy(row.markupPolicy),
      frozenAt: row.frozenAt,
      frozenBy: row.frozenBy,
      createdAt: row.createdAt,
    },
  };
}

// =====================================================================
// Разрешение на правку и оптимистичная блокировка
// =====================================================================

/**
 * Ревизия разметки, пригодная для правки, с проверкой ожидаемой версии.
 *
 * Три отказа, и они разные по смыслу: `404` — не нашли или не наше, `409` —
 * ревизия поставки закрыта либо разметка вытеснена, `412` — версия устарела.
 * Сваливать их в один код нельзя: на `412` клиент перечитывает и показывает
 * сравнение (§7.2), на `409` перечитывать бессмысленно.
 */
async function requireEditableLayout(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
  expectedVersion: number | undefined,
): Promise<LayoutRevisionView> {
  const layout = await findLayoutRevision(db, scope, layoutRevisionId);
  if (layout === null) throw notFound('Ревизия разметки не найдена.');
  assertEditableLayout(layout);
  if (expectedVersion !== undefined && expectedVersion !== layout.version) {
    throw preconditionFailed(
      `Разметка изменилась: ожидалась версия ${expectedVersion}, текущая ${layout.version}.`,
    );
  }
  return layout;
}

/**
 * Можно ли править блоки этой разметки.
 *
 * Состояние разметки здесь БОЛЬШЕ НЕ СПРАШИВАЕТСЯ (0048). Прежде черновик был
 * единственным правимым состоянием, и после отправки на распознавание портал
 * отвечал «исправление — новая ревизия разметки», а маршрута такой правки не
 * было вовсе: один клик закрывал возможность поправить рамку до конца жизни
 * комплекта. Заморозки не существует, а `superseded` — история уже работавших
 * баз: её нет ни у одной разметки, которую портал сейчас отдаёт на правку.
 *
 * Последний запрет — «терминальный статус поставки» — снят вместе со статусами
 * (S44): запирать разметку больше нечем и незачем. Функция сохранена пустой
 * намеренно, чтобы точка решения осталась названной: если запрет вернётся, он
 * вернётся сюда, а не расползётся по вызывающим.
 */
export function assertEditableLayout(_layout: LayoutRevisionView): void {
  // Условий больше нет.
}

/**
 * Отметка «человек трогал разметку».
 *
 * Ставится один раз и больше не переписывается: важен ФАКТ и момент первой
 * правки, потому что именно с него `full-page-text` на стороне RD WEB
 * становится опасным — он удаляет прежние блоки страницы (§5.3, подтверждено по
 * `blocks_bulk.py`).
 */
async function bumpVersion(
  tx: JobExecutor,
  layoutRevisionId: string,
  actorUserId: string | null,
  manual: boolean,
): Promise<number> {
  const updated = await tx.execute<{ version: number }>(sql`
    update ${layoutRevisions}
       set version = ${layoutRevisions.version} + 1,
           updated_at = now(),
           first_manual_edit_at = case
             when ${manual} and ${layoutRevisions.firstManualEditAt} is null then now()
             else ${layoutRevisions.firstManualEditAt} end,
           first_manual_edit_by = case
             when ${manual} and ${layoutRevisions.firstManualEditAt} is null
               then ${actorUserId}::uuid
             else ${layoutRevisions.firstManualEditBy} end
     where ${layoutRevisions.id} = ${layoutRevisionId}::uuid
       and ${layoutRevisions.state} = 'draft'
    returning version
  `);
  const row = updated.rows[0];
  if (row === undefined) {
    throw conflict('Разметка перестала быть черновиком в ходе правки.');
  }
  return Number(row.version);
}

// =====================================================================
// Импорт результатов детекции
// =====================================================================

export interface DetectedBlockInput {
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  readonly shapeType: ShapeType;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly sortOrder: number;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  /**
   * Уверенность и версия модели локального детектора (ADR-0008).
   *
   * Опциональны и НЕ входят в геометрический хэш (`HashableBlock`): легаси-путь
   * RD WEB (`toDetectedBlock` в `markup.ts`) их не знает и не обязан передавать,
   * а хэш сверки §5.2 обязан совпадать независимо от того, откуда приехали
   * координаты. `detectionScore` без `detectionModelVersion` (и наоборот) —
   * ошибка вызывающего: если пишем один, обязаны знать и другой.
   */
  readonly detectionScore?: number | undefined;
  readonly detectionModelVersion?: string | undefined;
}

export interface ImportDetectionInput {
  readonly layoutRevisionId: string;
  /** Страницы пачки: их прежние авто-блоки заменяются целиком. */
  readonly workingPageIndices: readonly number[];
  readonly blocks: readonly DetectedBlockInput[];
  readonly provenance: DetectorProvenance;
}

export interface ImportDetectionResult {
  readonly imported: number;
  readonly replaced: number;
  readonly version: number;
  readonly skippedPages: readonly number[];
}

/**
 * Импорт координат детекции в черновик разметки (§6.1, подстадия «Импорт»).
 *
 * Заменяются только АВТОМАТИЧЕСКИЕ блоки страницы: ручная правка приоритетна
 * внутри текущей ревизии (§8.2, фаза 3) и повторная детекция не имеет права её
 * стереть. Страница, на которой человек уже что-то создал, пропускается целиком
 * и попадает в `skippedPages` — ровно так же ведёт себя и удалённая сторона,
 * возвращая `skipped_pages` без `overwrite_existing`.
 */
export async function importDetectedBlocks(
  db: Database,
  scope: AuthScope,
  input: ImportDetectionInput,
): Promise<ImportDetectionResult> {
  const layout = await requireEditableLayout(db, scope, input.layoutRevisionId, undefined);

  const pages = await loadPageMap(db, scope, layout.bundleId, input.workingPageIndices);
  const manualPages = await pagesWithManualBlocks(db, layout.id, input.workingPageIndices);
  const targetPages = input.workingPageIndices.filter((page) => !manualPages.has(page));
  const skippedPages = input.workingPageIndices.filter((page) => manualPages.has(page));

  if (targetPages.length === 0) {
    return { imported: 0, replaced: 0, version: layout.version, skippedPages };
  }

  const targetSet = new Set(targetPages);
  const accepted = input.blocks.filter((block) => targetSet.has(block.workingPageIndex));

  return db.transaction(async (tx) => {
    const removed = await tx.execute<{ id: string }>(sql`
      delete from ${layoutBlocks}
       where ${layoutBlocks.layoutRevisionId} = ${layout.id}::uuid
         and ${layoutBlocks.source} = 'auto'
         and ${layoutBlocks.workingPageIndex} = any(${sql.raw(intArrayLiteral(targetPages))}::int[])
      returning id
    `);

    for (const block of accepted) {
      const page = pages.get(block.workingPageIndex);
      if (page === undefined) {
        throw conflict(
          `Страница ${block.workingPageIndex} отсутствует в карте рабочего документа: ` +
            'разметка не может лечь на страницу, которой нет.',
        );
      }
      await insertBlock(tx, {
        layoutRevisionId: layout.id,
        folderId: layout.folderId,
        bundleId: layout.bundleId,
        objectId: layout.objectId,
        sourcePageId: page,
        block,
        source: 'auto',
        provenance: input.provenance,
      });
    }

    const version = await bumpVersion(tx, layout.id, null, false);

    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.detected',
      payload: {
        layoutRevisionId: layout.id,
        pages: targetPages,
        imported: accepted.length,
        skippedPages,
        detectorProvenance: input.provenance,
      },
    });

    return {
      imported: accepted.length,
      replaced: removed.rows.length,
      version,
      skippedPages,
    };
  });
}

/** Литерал массива int для `= any(...)`: значения приходят из уже разобранной схемы. */
function intArrayLiteral(values: readonly number[]): string {
  return `array[${values.map((value) => String(Math.trunc(value))).join(',') || 'null'}]`;
}

async function pagesWithManualBlocks(
  db: Database,
  layoutRevisionId: string,
  workingPageIndices: readonly number[],
): Promise<ReadonlySet<number>> {
  if (workingPageIndices.length === 0) return new Set();
  const rows = await db
    .select({ page: layoutBlocks.workingPageIndex })
    .from(layoutBlocks)
    .where(
      and(
        eq(layoutBlocks.layoutRevisionId, layoutRevisionId),
        eq(layoutBlocks.source, 'user'),
        inArray(layoutBlocks.workingPageIndex, [...workingPageIndices]),
      ),
    );
  return new Set(rows.map((row) => row.page));
}

/** Карта «индекс страницы рабочего PDF → id исходной страницы» под областью. */
/**
 * Размеры страниц рабочего документа в ПУНКТАХ, по индексу страницы.
 *
 * Отдельно от `loadPageMap` намеренно: тот отвечает на вопрос «какой исходной
 * странице соответствует эта рабочая» и нужен пяти вызывающим, а размеры нужны
 * ровно одному — заплатке покрытия, которой запрещено трогать крупные листы.
 * Расширить общий запрос значило бы обязать четырёх остальных читать поля,
 * которые им не нужны.
 *
 * Колонки названы `_px` исторически: в них лежат округлённые пункты
 * (`apps/api/src/modules/files/verify.ts`), и `classifySheet` ждёт именно их.
 */
async function loadPageSizes(
  db: Database,
  scope: AuthScope,
  bundleId: string,
): Promise<ReadonlyMap<number, { readonly widthPt: number; readonly heightPt: number }>> {
  const rows = await db
    .select({
      workingPageIndex: processingBundlePages.workingPageIndex,
      widthPt: sourcePages.widthPx,
      heightPt: sourcePages.heightPx,
    })
    .from(processingBundlePages)
    .innerJoin(processingBundles, eq(processingBundlePages.bundleId, processingBundles.id))
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .innerJoin(sourcePages, eq(processingBundlePages.sourcePageId, sourcePages.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(processingBundlePages.bundleId, bundleId)));

  return new Map(
    rows.map((row) => [row.workingPageIndex, { widthPt: row.widthPt, heightPt: row.heightPt }]),
  );
}

async function loadPageMap(
  db: Database,
  scope: AuthScope,
  bundleId: string,
  workingPageIndices: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const conditions = [eq(processingBundlePages.bundleId, bundleId)];
  if (workingPageIndices.length > 0) {
    conditions.push(inArray(processingBundlePages.workingPageIndex, [...workingPageIndices]));
  }
  const rows = await db
    .select({
      workingPageIndex: processingBundlePages.workingPageIndex,
      sourcePageId: processingBundlePages.sourcePageId,
    })
    .from(processingBundlePages)
    .innerJoin(processingBundles, eq(processingBundlePages.bundleId, processingBundles.id))
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, ...conditions));

  return new Map(rows.map((row) => [row.workingPageIndex, row.sourcePageId]));
}

interface InsertBlockInput {
  readonly layoutRevisionId: string;
  readonly folderId: string;
  readonly bundleId: string;
  readonly objectId: string;
  readonly sourcePageId: string;
  readonly block: DetectedBlockInput;
  readonly source: 'auto' | 'user';
  readonly provenance: DetectorProvenance;
}

async function insertBlock(tx: JobExecutor, input: InsertBlockInput): Promise<string> {
  const b = input.block;
  // Половинчатая пара — дефект вызывающего: score без версии модели нельзя
  // приписать никакому прогону, версия без score — числовая уверенность
  // потеряна молча. Обе колонки нужны или обе оставлены NULL.
  if ((b.detectionScore === undefined) !== (b.detectionModelVersion === undefined)) {
    throw internal({
      logDetail: 'detectionScore и detectionModelVersion обязаны задаваться парой',
    });
  }
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into ${layoutBlocks}
      (layout_revision_id, folder_id, bundle_id, source_page_id, working_page_index,
       object_id, block_type, shape_type, x0, y0, x1, y1, sort_order, source,
       detector_provenance, detection_score, detection_model_version)
    values (${input.layoutRevisionId}::uuid, ${input.folderId}::uuid, ${input.bundleId}::uuid,
            ${input.sourcePageId}::uuid, ${b.workingPageIndex}, ${input.objectId}::uuid,
            ${b.blockType}, ${b.shapeType}, ${b.x0}, ${b.y0}, ${b.x1}, ${b.y1},
            ${b.sortOrder}, ${input.source}, ${input.provenance},
            ${b.detectionScore ?? null}, ${b.detectionModelVersion ?? null})
    returning id
  `);
  const row = inserted.rows[0];
  if (row === undefined) throw internal({ logDetail: 'INSERT блока разметки не вернул строку' });

  if (b.shapeType === 'polygon') {
    if (b.points.length < 3) {
      throw conflict('Полигон описывается не менее чем тремя точками.');
    }
    for (const [index, point] of b.points.entries()) {
      await tx.execute(sql`
        insert into ${layoutBlockPoints} (block_id, point_no, x, y)
        values (${row.id}::uuid, ${index}, ${point.x}, ${point.y})
      `);
    }
  }
  return row.id;
}

// =====================================================================
// Ручная правка
// =====================================================================

export interface CreateBlockInput {
  readonly layoutRevisionId: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  readonly shapeType: ShapeType;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface BlockMutationResult {
  readonly blockId: string;
  readonly version: number;
}

export async function createLayoutBlock(
  db: Database,
  scope: AuthScope,
  input: CreateBlockInput,
): Promise<BlockMutationResult> {
  const layout = await requireEditableLayout(
    db,
    scope,
    input.layoutRevisionId,
    input.expectedVersion,
  );
  const pages = await loadPageMap(db, scope, layout.bundleId, [input.workingPageIndex]);
  const sourcePageId = pages.get(input.workingPageIndex);
  if (sourcePageId === undefined) {
    throw conflict(`Страницы ${input.workingPageIndex} нет в рабочем документе.`);
  }

  const sortOrder = await nextSortOrder(db, layout.id, input.workingPageIndex, input.blockType);

  return db.transaction(async (tx) => {
    const blockId = await insertBlock(tx, {
      layoutRevisionId: layout.id,
      folderId: layout.folderId,
      bundleId: layout.bundleId,
      objectId: layout.objectId,
      sourcePageId,
      block: { ...input, sortOrder },
      source: 'user',
      // Блок, нарисованный человеком, детектор не порождал: провенанс `user`
      // (§0.1 — выдуманной уверенности здесь быть не может).
      provenance: 'user',
    });
    const version = await bumpVersion(tx, layout.id, input.actorUserId, true);
    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.block_created',
      payload: { layoutRevisionId: layout.id, blockId, page: input.workingPageIndex },
    });
    return { blockId, version };
  });
}

async function nextSortOrder(
  db: Database,
  layoutRevisionId: string,
  workingPageIndex: number,
  blockType: BlockType,
): Promise<number> {
  const rows = await db
    .select({ maxOrder: sql<number>`coalesce(max(${layoutBlocks.sortOrder}), -1)::int` })
    .from(layoutBlocks)
    .where(
      and(
        eq(layoutBlocks.layoutRevisionId, layoutRevisionId),
        eq(layoutBlocks.workingPageIndex, workingPageIndex),
        eq(layoutBlocks.blockType, blockType),
      ),
    );
  return (rows[0]?.maxOrder ?? -1) + 1;
}

export interface UpdateBlockInput {
  readonly blockId: string;
  /**
   * Ревизия разметки из адреса.
   *
   * Проверяется, а не игнорируется: блок адресуется собственным uuid, поэтому
   * без сверки маршрут `/layouts/A/blocks/{из B}` правил бы блок ревизии B,
   * а `If-Match` при этом сверялся бы с версией B — то есть адрес говорил бы
   * одно, а происходило другое.
   */
  readonly layoutRevisionId: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly blockType?: BlockType | undefined;
  readonly shapeType?: ShapeType | undefined;
  readonly coords?:
    | { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
    | undefined;
  readonly points?: readonly { readonly x: number; readonly y: number }[] | undefined;
  readonly sortOrder?: number | undefined;
}

/**
 * Правка блока: перемещение, растягивание, смена типа, полигон.
 *
 * Одна функция на все четыре операции намеренно: у них общая проверка версии,
 * общая отметка ручной правки и общий подъём версии ревизии. Разнесённые по
 * четырём функциям, они разошлись бы в том, что именно считается ручной
 * правкой.
 */
export async function updateLayoutBlock(
  db: Database,
  scope: AuthScope,
  input: UpdateBlockInput,
): Promise<BlockMutationResult> {
  const found = await findLayoutBlock(db, scope, input.blockId);
  if (found === null || found.layout.id !== input.layoutRevisionId) {
    throw notFound('Блок разметки не найден.');
  }
  assertEditableLayout(found.layout);
  if (found.layout.version !== input.expectedVersion) {
    throw preconditionFailed(
      `Разметка изменилась: ожидалась версия ${input.expectedVersion}, ` +
        `текущая ${found.layout.version}.`,
    );
  }

  const shapeType = input.shapeType ?? found.block.shapeType;
  const points = input.points ?? found.block.points;
  if (shapeType === 'polygon' && points.length < 3) {
    throw conflict('Полигон описывается не менее чем тремя точками.');
  }
  const coords = input.coords ?? {
    x0: found.block.x0,
    y0: found.block.y0,
    x1: found.block.x1,
    y1: found.block.y1,
  };

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      update ${layoutBlocks}
         set block_type = ${input.blockType ?? found.block.blockType},
             shape_type = ${shapeType},
             x0 = ${coords.x0}, y0 = ${coords.y0}, x1 = ${coords.x1}, y1 = ${coords.y1},
             sort_order = ${input.sortOrder ?? found.block.sortOrder},
             source = 'user',
             detector_provenance = 'user',
             updated_at = now()
       where ${layoutBlocks.id} = ${input.blockId}::uuid
    `);

    if (input.points !== undefined || input.shapeType !== undefined) {
      await tx.execute(sql`
        delete from ${layoutBlockPoints}
         where ${layoutBlockPoints.blockId} = ${input.blockId}::uuid
      `);
      if (shapeType === 'polygon') {
        for (const [index, point] of points.entries()) {
          await tx.execute(sql`
            insert into ${layoutBlockPoints} (block_id, point_no, x, y)
            values (${input.blockId}::uuid, ${index}, ${point.x}, ${point.y})
          `);
        }
      }
    }

    const version = await bumpVersion(tx, found.layout.id, input.actorUserId, true);
    await appendFolderEvent(tx, {
      folderId: found.layout.folderId,
      eventType: 'layout.block_updated',
      payload: {
        layoutRevisionId: found.layout.id,
        blockId: input.blockId,
        page: found.block.workingPageIndex,
      },
    });
    return { blockId: input.blockId, version };
  });
}

export async function deleteLayoutBlock(
  db: Database,
  scope: AuthScope,
  input: {
    readonly blockId: string;
    readonly layoutRevisionId: string;
    readonly expectedVersion: number;
    readonly actorUserId: string;
  },
): Promise<{ readonly version: number }> {
  const found = await findLayoutBlock(db, scope, input.blockId);
  if (found === null || found.layout.id !== input.layoutRevisionId) {
    throw notFound('Блок разметки не найден.');
  }
  assertEditableLayout(found.layout);
  if (found.layout.version !== input.expectedVersion) {
    throw preconditionFailed(
      `Разметка изменилась: ожидалась версия ${input.expectedVersion}, ` +
        `текущая ${found.layout.version}.`,
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from ${layoutBlocks} where ${layoutBlocks.id} = ${input.blockId}::uuid
    `);
    const version = await bumpVersion(tx, found.layout.id, input.actorUserId, true);
    await appendFolderEvent(tx, {
      folderId: found.layout.folderId,
      eventType: 'layout.block_deleted',
      payload: {
        layoutRevisionId: found.layout.id,
        blockId: input.blockId,
        page: found.block.workingPageIndex,
      },
    });
    return { version };
  });
}

/**
 * Замена страницы одним TEXT-блоком — ЯВНОЕ действие пользователя (§5.3).
 *
 * Автоматически такой блок не добавляется никогда: страница с блоками на 30%
 * площади получила бы перекрытие, и один и тот же текст попал бы в md дважды.
 * Поэтому операция живёт отдельной функцией с отдельным правом на маршруте, а
 * не веткой внутри импорта детекции.
 */
export async function replacePageWithFullPageBlock(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly workingPageIndex: number;
  },
): Promise<BlockMutationResult> {
  const layout = await requireEditableLayout(
    db,
    scope,
    input.layoutRevisionId,
    input.expectedVersion,
  );
  const pages = await loadPageMap(db, scope, layout.bundleId, [input.workingPageIndex]);
  const sourcePageId = pages.get(input.workingPageIndex);
  if (sourcePageId === undefined) {
    throw conflict(`Страницы ${input.workingPageIndex} нет в рабочем документе.`);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from ${layoutBlocks}
       where ${layoutBlocks.layoutRevisionId} = ${layout.id}::uuid
         and ${layoutBlocks.workingPageIndex} = ${input.workingPageIndex}
    `);
    const blockId = await insertBlock(tx, {
      layoutRevisionId: layout.id,
      folderId: layout.folderId,
      bundleId: layout.bundleId,
      objectId: layout.objectId,
      sourcePageId,
      block: {
        workingPageIndex: input.workingPageIndex,
        blockType: 'text',
        shapeType: 'rectangle',
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
        sortOrder: 0,
        points: [],
      },
      source: 'user',
      // Полностраничная заплатка — не результат детектора: провенанс `full_page`
      // отличает её и от `rf_detr`, и от нарисованного человеком блока.
      provenance: 'full_page',
    });
    const version = await bumpVersion(tx, layout.id, input.actorUserId, true);
    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.page_replaced',
      payload: { layoutRevisionId: layout.id, page: input.workingPageIndex, blockId },
    });
    return { blockId, version };
  });
}

/**
 * Режим `full-page-text` на весь комплект (§5.3).
 *
 * Соответствует их `POST /blocks/full-page-text` и повторяет его семантику: все
 * прежние блоки страницы УДАЛЯЮТСЯ, вместо них — один TEXT на всю страницу.
 * Именно поэтому режим запрещён после первой ручной правки: он молча уничтожил
 * бы работу человека, а на их стороне это подтверждено чтением `blocks_bulk.py`.
 *
 * Локально, а не вызовом их эндпоинта: перед распознаванием портал всё равно
 * приводит удалённый набор к своему (§5.2, шаг 5), поэтому лишний заезд на их
 * сторону ничего не добавил бы, кроме риска рассинхрона.
 */
export async function applyFullPageTextProfile(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly expectedVersion: number;
    readonly actorUserId: string;
  },
): Promise<{ readonly version: number; readonly pages: number }> {
  const layout = await requireEditableLayout(
    db,
    scope,
    input.layoutRevisionId,
    input.expectedVersion,
  );

  if (layout.firstManualEditAt !== null) {
    throw conflict(
      'Режим «вся страница одним текстовым блоком» недоступен после ручной правки: ' +
        'он удаляет прежние блоки страницы и стёр бы уже сделанную разметку.',
    );
  }

  const pages = await loadPageMap(db, scope, layout.bundleId, []);
  if (pages.size === 0) throw conflict('У рабочего документа нет карты страниц.');

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from ${layoutBlocks}
       where ${layoutBlocks.layoutRevisionId} = ${layout.id}::uuid
    `);
    for (const [workingPageIndex, sourcePageId] of pages) {
      await insertBlock(tx, {
        layoutRevisionId: layout.id,
        folderId: layout.folderId,
        bundleId: layout.bundleId,
        objectId: layout.objectId,
        sourcePageId,
        block: {
          workingPageIndex,
          blockType: 'text',
          shapeType: 'rectangle',
          x0: 0,
          y0: 0,
          x1: 1,
          y1: 1,
          sortOrder: 0,
          points: [],
        },
        source: 'auto',
        provenance: 'full_page',
      });
    }
    await tx.execute(sql`
      update ${layoutRevisions}
         set detector_profile = 'full_page'
       where ${layoutRevisions.id} = ${layout.id}::uuid
    `);
    // Профиль применяет конвейер по требованию пользователя, но САМА расстановка
    // блоков ручной правкой не является: иначе повторный вызов режима стал бы
    // невозможен сразу после первого.
    const version = await bumpVersion(tx, layout.id, null, false);
    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.full_page_text_applied',
      payload: { layoutRevisionId: layout.id, pages: pages.size },
    });
    return { version, pages: pages.size };
  });
}

export interface TextCoverageFallbackResult {
  readonly version: number;
  /** Страницы, ушедшие на распознавание целиком. Пусто — ничего не тронуто. */
  readonly pages: readonly number[];
}

/**
 * Страница, которую детекция не покрыла, уходит на распознавание ЦЕЛИКОМ.
 *
 * ## Зачем
 *
 * Распознавание идёт по блокам: нет блока — нет и вызова модели, то есть у
 * страницы не появляется ни строки текста. Дальше её не видит ни классификатор,
 * ни сегментация, и комплект теряет документ, который на ней напечатан. При этом
 * «страница без блоков» — штатный исход детекции, а не сбой: она честно
 * отвечает, что ничего не нашла. До S27 выход был один — человек открывал
 * «Разметку» и нажимал «Заменить страницу одним блоком» на каждой такой
 * странице.
 *
 * ## Чем отличается от `applyFullPageTextProfile`
 *
 * Та сносит блоки ВСЕХ страниц комплекта и запрещена после первой ручной правки
 * — это режим «распознавать весь комплект сплошным текстом». Здесь наоборот:
 * трогаются ровно те страницы, где распознавать иначе нечего, а всё остальное
 * остаётся как есть.
 *
 * ## Политика по странице
 *
 * 1. блоков нет — вставить один `text` на всю страницу;
 * 2. все блоки `text` и покрытие ниже порога профиля — снести автоматические,
 *    вставить один: скудная разметка означает, что детекция нашла заголовок и
 *    потеряла тело, и половина текста документа пропала бы молча;
 * 3. есть `image` или `stamp` — НЕ трогать. Это единственный признак
 *    исполнительной схемы (`docs/CORPUS_FINDINGS.md`): у неё текста почти нет по
 *    построению, и низкое покрытие для неё нормально, а полностраничный `text`
 *    отправил бы чертёж в текстовый промт;
 * 4. есть блок `source='user'` — НЕ трогать: человек уже сказал, как надо.
 *
 * ## Почему `source='auto'`
 *
 * Не деталь, а условие обратимости: `importDetectedBlocks` удаляет и заменяет
 * именно автоматические блоки целевых страниц, а страницы с ручными пропускает.
 * Полностраничная заплатка с `source='user'` (как в
 * `replacePageWithFullPageBlock`, где это верно — там её ставит человек)
 * навсегда закрыла бы странице повторную детекцию.
 */
/**
 * Крупный ли лист. Неизвестный размер — НЕ крупный: страницу с нечитаемой
 * геометрией заплатка обязана обработать как раньше, а не выбросить молча.
 */
function isLargeSheet(
  size: { readonly widthPt: number; readonly heightPt: number } | undefined,
): boolean {
  if (size === undefined) return false;
  return classifySheet(size.widthPt, size.heightPt).sheetClass === 'large';
}

export async function applyTextCoverageFallback(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly expectedVersion: number;
    readonly thresholds: LayoutThresholds;
  },
): Promise<TextCoverageFallbackResult> {
  const layout = await requireEditableLayout(
    db,
    scope,
    input.layoutRevisionId,
    input.expectedVersion,
  );

  const pages = await loadPageMap(db, scope, layout.bundleId, []);
  if (pages.size === 0) return { version: layout.version, pages: [] };

  /**
   * Правило 0: при `sheet_aware` крупный лист не трогается никогда.
   *
   * Иначе заплатка отменяла бы решение разметки ровно там, где оно принято
   * осознанно: на крупном листе портал ищет ТОЛЬКО штамп, и лист, оставшийся
   * без блоков, — это «штамп не найден, нужен человек», а не «детекция не
   * справилась». Полностраничный `text` на листе A1 отправил бы чертёж в
   * текстовый промт и стёр бы флаг, ради которого страница и осталась пустой.
   *
   * Правило читается из ПИНА ревизии, а не из настройки: заплатку жмут кнопкой
   * «Проверить» уже после разметки, и настройка к этому моменту могла смениться
   * — тогда лист судился бы одним правилом, а размечался другим.
   */
  const skipLargeSheets = layout.markupPolicy.sheetStrategy === 'sheet_aware';
  const sizes = skipLargeSheets
    ? await loadPageSizes(db, scope, layout.bundleId)
    : new Map<number, { readonly widthPt: number; readonly heightPt: number }>();

  const blocks = await listLayoutBlocks(db, scope, layout.id);
  const byPage = new Map<number, LayoutBlockView[]>();
  for (const block of blocks) {
    const list = byPage.get(block.workingPageIndex) ?? [];
    list.push(block);
    byPage.set(block.workingPageIndex, list);
  }

  const ratio = input.thresholds.textFallbackCoverageRatio;
  const targets: number[] = [];
  for (const workingPageIndex of pages.keys()) {
    if (skipLargeSheets && isLargeSheet(sizes.get(workingPageIndex))) continue;
    const own = byPage.get(workingPageIndex) ?? [];
    if (own.length === 0) {
      targets.push(workingPageIndex);
      continue;
    }
    if (own.some((block) => block.source === 'user')) continue;
    if (own.some((block) => block.blockType !== 'text')) continue;
    if (ratio <= 0) continue;
    const covered = unionArea(own.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })));
    if (covered < ratio) targets.push(workingPageIndex);
  }

  if (targets.length === 0) return { version: layout.version, pages: [] };

  const version = await db.transaction(async (tx) => {
    for (const workingPageIndex of targets) {
      // Только автоматические: страницы с ручными блоками сюда не попадают
      // вовсе, и условие здесь — второй рубеж, а не первый.
      await tx.execute(sql`
        delete from ${layoutBlocks}
         where ${layoutBlocks.layoutRevisionId} = ${layout.id}::uuid
           and ${layoutBlocks.workingPageIndex} = ${workingPageIndex}
           and ${layoutBlocks.source} = 'auto'
      `);
      const sourcePageId = pages.get(workingPageIndex);
      if (sourcePageId === undefined) continue;
      await insertBlock(tx, {
        layoutRevisionId: layout.id,
        folderId: layout.folderId,
        bundleId: layout.bundleId,
        objectId: layout.objectId,
        sourcePageId,
        block: {
          workingPageIndex,
          blockType: 'text',
          shapeType: 'rectangle',
          x0: 0,
          y0: 0,
          x1: 1,
          y1: 1,
          sortOrder: 0,
          points: [],
        },
        source: 'auto',
        provenance: 'full_page',
      });
    }

    /**
     * Флаг внимания — ДОПОЛНЕНИЕМ к существующим, а не заменой набора.
     *
     * `savePageAttentionFlags` заменяет флаги страницы целиком: так и надо
     * анализу покрытия, который пересчитывает их все разом. Здесь наоборот —
     * добавляется один факт к тому, что анализ уже посчитал (`no_blocks`,
     * `low_coverage` останутся и объяснят, ПОЧЕМУ заплатка понадобилась).
     *
     * `array_append` под условием `not ... = any(...)`: повторный вызов не
     * должен наращивать массив дублями.
     */
    const targetIds = targets
      .map((page) => pages.get(page))
      .filter((id): id is string => id !== undefined);
    if (targetIds.length > 0) {
      await tx.execute(sql`
        update ${sourcePages}
           set attention_flags = array_append(attention_flags, 'text_fallback_applied')
         where ${sourcePages.id} in (${sql.join(
           targetIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
           and not ('text_fallback_applied' = any(attention_flags))
      `);
    }

    // Ручной правкой это не является: заплатку ставит конвейер, и пометив её
    // как работу человека, портал запретил бы сам себе режим `full-page-text` и
    // соврал бы в поле `first_manual_edit_by`.
    const next = await bumpVersion(tx, layout.id, null, false);
    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.text_fallback_applied',
      payload: {
        layoutRevisionId: layout.id,
        pages: targets,
        coverageRatio: ratio,
      },
    });
    return next;
  });

  return { version, pages: targets };
}

// =====================================================================
// Флаги внимания страниц
// =====================================================================

export interface SaveAttentionFlagsInput {
  readonly folderId: string;
  readonly flags: ReadonlyMap<string, readonly AttentionFlag[]>;
}

export type SaveFlagsOutcome =
  | { readonly kind: 'written'; readonly pages: number }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * Запись флагов внимания в `source_pages`.
 *
 * ## Почему запись разрешена не только в черновике
 *
 * `attention_flags` — данные ПРОИЗВОДНЫЕ: их считает конвейер по текущей
 * разметке, они не входят в `aggregate_manifest_hash` и не описывают состав
 * поставки. Разметку же по модели прав правит и инженер (`markup.edit`:
 * contractor, engineer), а на проверке ревизия уже `submitted`. Запрет на всё,
 * кроме черновика, означал ровно то, что S2 назвал перерасширением запрета:
 * детекция отрабатывает, флаги не пишутся, экран показывает «флагов нет» — и
 * это неотличимо от «флаги не записаны».
 *
 * Поэтому колонка отнесена к классу `derived` отдельным триггером (0013), и
 * список статусов здесь тот же, что у остальной разметки (`LAYOUT_MUTABLE_STATUSES`).
 * Состав поставки при этом остаётся запертым с момента подачи: триггер
 * пропускает UPDATE только тогда, когда `attention_flags` — ЕДИНСТВЕННОЕ
 * изменённое поле строки.
 *
 * `skipped` с причиной сохраняется для терминальных статусов: разница между
 * «нельзя писать» и «не удалось записать» обязана быть видна в журнале.
 */
export async function savePageAttentionFlags(
  db: Database,
  scope: AuthScope,
  input: SaveAttentionFlagsInput,
): Promise<SaveFlagsOutcome> {
  const visible = await db
    .select({ id: folders.id })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, input.folderId)))
    .limit(1);

  if (visible[0] === undefined) return { kind: 'skipped', reason: 'папка недоступна' };

  let written = 0;
  for (const [sourcePageId, flags] of input.flags) {
    // Значения собираются в литерал массива (параметризованного `text[]` у
    // Drizzle тут нет), поэтому каждое сверяется с закрытым перечнем контрактов.
    // Флаги приходят из нашего же анализатора, но литерал, собранный из
    // непроверенной строки, — это класс дефекта, а не конкретная строка.
    for (const flag of flags) {
      if (!attentionFlagSchema.safeParse(flag).success) {
        throw internal({ logDetail: 'неизвестный флаг внимания страницы' });
      }
    }
    const literal = `array[${flags.map((flag) => `'${flag}'`).join(',')}]::text[]`;
    const updated = await db.execute<{ id: string }>(sql`
      update ${sourcePages}
         set attention_flags = ${sql.raw(flags.length === 0 ? `'{}'::text[]` : literal)}
       where ${sourcePages.id} = ${sourcePageId}::uuid
         and ${sourcePages.folderId} = ${input.folderId}::uuid
      returning id
    `);
    written += updated.rows.length;
  }
  return { kind: 'written', pages: written };
}

/** Флаги страниц ревизии — для экрана разметки и ленты миниатюр (§7.2). */
export async function listPageAttentionFlags(
  db: Database,
  scope: AuthScope,
  bundleId: string,
): Promise<readonly { readonly workingPageIndex: number; readonly flags: readonly string[] }[]> {
  const rows = await db
    .select({
      workingPageIndex: processingBundlePages.workingPageIndex,
      flags: sourcePages.attentionFlags,
    })
    .from(processingBundlePages)
    .innerJoin(processingBundles, eq(processingBundlePages.bundleId, processingBundles.id))
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .innerJoin(sourcePages, eq(processingBundlePages.sourcePageId, sourcePages.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(processingBundlePages.bundleId, bundleId)))
    .orderBy(asc(processingBundlePages.workingPageIndex));

  return rows.map((row) => ({
    workingPageIndex: row.workingPageIndex,
    flags: (row.flags ?? []) as readonly string[],
  }));
}

// =====================================================================
// RD-документ прогона
// =====================================================================

export interface RunDocumentView {
  readonly id: string;
  readonly layoutRevisionId: string;
  readonly rdDocumentId: string;
  readonly rdProjectId: string;
  readonly closedAt: string | null;
}

const RUN_DOCUMENT_SELECTION = {
  id: rdRunDocuments.id,
  layoutRevisionId: rdRunDocuments.layoutRevisionId,
  rdDocumentId: rdRunDocuments.rdDocumentId,
  rdProjectId: rdRunDocuments.rdProjectId,
  closedAt: sql<
    string | null
  >`to_char(${rdRunDocuments.closedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    'closed_at_iso',
  ),
};

export async function findRunDocument(
  db: Database,
  scope: AuthScope,
  layoutRevisionId: string,
): Promise<RunDocumentView | null> {
  const rows = await db
    .select(RUN_DOCUMENT_SELECTION)
    .from(rdRunDocuments)
    .innerJoin(layoutRevisions, eq(rdRunDocuments.layoutRevisionId, layoutRevisions.id))
    .innerJoin(folders, eq(layoutRevisions.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(rdRunDocuments.layoutRevisionId, layoutRevisionId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Регистрация RD-документа прогона.
 *
 * Идемпотентна: задача перезапускается при падении воркера, и
 * второй документ на ту же разметку означал бы второй заезд 86 МБ и
 * неоднозначность «какой из двух распознавали». Уникальность держит и БД
 * (`rd_run_documents.layout_revision_id UNIQUE`), но узнавать об этом из
 * нарушения ограничения — плохой способ.
 */
export async function createRunDocument(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly rdDocumentId: string;
    readonly rdProjectId: string;
  },
): Promise<{ readonly runDocument: RunDocumentView; readonly created: boolean }> {
  const existing = await findRunDocument(db, scope, input.layoutRevisionId);
  if (existing !== null) return { runDocument: existing, created: false };

  const layout = await findLayoutRevision(db, scope, input.layoutRevisionId);
  if (layout === null) throw notFound('Ревизия разметки не найдена.');

  await db.transaction(async (tx) => {
    await tx
      .insert(rdRunDocuments)
      .values({
        layoutRevisionId: input.layoutRevisionId,
        rdDocumentId: input.rdDocumentId,
        rdProjectId: input.rdProjectId,
      })
      .onConflictDoNothing();
    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.run_document_created',
      payload: { layoutRevisionId: layout.id, rdProjectId: input.rdProjectId },
    });
  });

  const created = await findRunDocument(db, scope, input.layoutRevisionId);
  if (created === null) {
    throw internal({ logDetail: 'RD-документ прогона не читается сразу после записи' });
  }
  return { runDocument: created, created: true };
}

/**
 * Замена брошенного RD-документа новым в ТОЙ ЖЕ строке (ADR-0004 §2).
 *
 * Возникает ровно в одном случае: документ на их стороне заведён, но байтов у
 * него нет (задача 4 упала между `init` и `complete`), а повторно выдать талон
 * их API не умеет. Второй строкой такой документ записать нельзя —
 * `layout_revision_id` уникален, — да и не нужно: одна ревизия разметки, один
 * действующий документ. Брошенный при этом не исчезает бесследно: его
 * идентификатор уходит в журнал (`rd_run_document_orphaned`) и в событие
 * ревизии, иначе он остался бы на их стороне неназванным.
 */
export async function replaceRunDocument(
  db: Database,
  scope: AuthScope,
  input: {
    readonly layoutRevisionId: string;
    readonly rdDocumentId: string;
    readonly rdProjectId: string;
  },
): Promise<{ readonly previousRdDocumentId: string | null }> {
  const existing = await findRunDocument(db, scope, input.layoutRevisionId);
  if (existing === null) throw notFound('RD-документ прогона не найден.');
  if (existing.rdDocumentId === input.rdDocumentId) {
    return { previousRdDocumentId: null };
  }

  const layout = await findLayoutRevision(db, scope, input.layoutRevisionId);
  if (layout === null) throw notFound('Ревизия разметки не найдена.');

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(rdRunDocuments)
      .set({ rdDocumentId: input.rdDocumentId, rdProjectId: input.rdProjectId })
      .where(
        and(
          eq(rdRunDocuments.id, existing.id),
          eq(rdRunDocuments.rdDocumentId, existing.rdDocumentId),
          isNull(rdRunDocuments.closedAt),
        ),
      )
      .returning({ id: rdRunDocuments.id });
    if (updated.length === 0) {
      throw conflict('RD-документ прогона изменился или закрыт: замена не выполнена.');
    }

    await appendFolderEvent(tx, {
      folderId: layout.folderId,
      eventType: 'layout.run_document_replaced',
      payload: {
        layoutRevisionId: layout.id,
        rdProjectId: input.rdProjectId,
        // Брошенный документ назван: без этого он неотличим от несуществующего.
        orphanedRdDocumentId: existing.rdDocumentId,
      },
    });
  });

  return { previousRdDocumentId: existing.rdDocumentId };
}
