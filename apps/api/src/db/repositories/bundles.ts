/**
 * Рабочий документ ревизии и карта его страниц (§3.3).
 *
 * Рабочий PDF — производный неизменяемый документ, собранный из ВСЕХ файлов
 * ревизии в заданном пользователем порядке. Именно он уезжает в RD WEB, и
 * именно на него ложится разметка. Оригиналы при этом не меняются вовсе.
 *
 * ## Карта страниц — не удобство, а условие связности
 *
 * `processing_bundle_pages` обязана позволять по любой странице рабочего PDF
 * назвать исходный файл и номер страницы в нём. Без этого распознанный текст
 * невозможно связать с оригиналом: пользователь видит «страница 47» рабочего
 * документа, а претензия относится к третьему листу второго файла. Поэтому
 * карта строится ДО сборки (`planWorkingPdf()` в `pdf/toolkit.ts`), а сборщик
 * обязан лишь произвести документ ровно из такого числа страниц.
 *
 * ## Область видимости
 *
 * Ни у `source_files`, ни у `source_pages`, ни у `processing_bundles` нет
 * собственных `object_id`/`contractor_id` — они есть у ревизии, а составные FK
 * (0003) не дают дочерней строке принадлежать другой ревизии. Поэтому область
 * применяется соединением с `folders` и `withScope()` по её
 * колонкам. Это касается и выдачи ссылок, и обратного поиска страницы: любой
 * доступ к файлу, странице и поставке проходит проверку принадлежности.
 *
 * ## Почему сборка возможна только в черновике
 *
 * `processing_bundles` относится к классу `source` (0008): состав, поданный
 * подрядчиком, после submit неизменяем. Триггер БД отвергнет INSERT в поданную
 * ревизию, поэтому репозиторий проверяет статус заранее — иначе отказ пришёл бы
 * ПОСЛЕ склейки 86 МБ, то есть после самой дорогой части работы.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  pageOrientations,
  processingBundlePages,
  processingBundles,
  sourceFiles,
  sourcePages,
  storedBlobs,
  folders,
} from '@id/db';
import type { ContentRotation, ContentRotationSource } from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, internal, notFound } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendFolderEvent } from './jobs.js';
import type { Database } from './users.js';

/**
 * Цель области видимости: колонки ревизии.
 *
 * Одна на все запросы этого файла. Второй экземпляр правила доступа рядом
 * означал бы два источника правды для изоляции подрядчиков.
 */
const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/** Статусы, в которых состав ревизии ещё можно менять (0008, класс `source`). */

// =====================================================================
// Хэш состава
// =====================================================================

/**
 * Версия формы манифеста.
 *
 * Входит в хэш: изменив состав полей, мы обязаны получить другие хэши, иначе
 * старые и новые манифесты стали бы неразличимы, а §5.2 переиспользует
 * результаты прошлой ревизии именно по совпадению хэшей.
 */
export const AGGREGATE_MANIFEST_VERSION = 1;

export interface ManifestFile {
  readonly sortOrder: number;
  readonly blobSha256: string;
}

/**
 * `aggregate_manifest_hash` — хэш состава и порядка файлов (§3.3).
 *
 * В хэш идут содержимое (SHA-256 каждого файла) и позиция в комплекте, но НЕ
 * идентификаторы строк, не имена файлов и не сами значения `sort_order`.
 * Причина прикладная: повторная подача после возврата — типовой сценарий, и
 * ровно тот же комплект в новой ревизии обязан дать тот же хэш, иначе
 * переиспользование результатов прошлого прогона (§5.2) не сработает никогда.
 * Позиция берётся нормализованной (0,1,2…), чтобы перенумерация без изменения
 * порядка не считалась другим составом.
 */
export function computeAggregateManifestHash(files: readonly ManifestFile[]): string {
  const ordered = [...files].sort((a, b) => a.sortOrder - b.sortOrder);
  const canonical = JSON.stringify({
    v: AGGREGATE_MANIFEST_VERSION,
    files: ordered.map((file) => file.blobSha256),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// =====================================================================
// План сборки
// =====================================================================

export interface BundlePlanPage {
  readonly sourcePageId: string;
  readonly filePageIndex: number;
}

export interface BundlePlanFile {
  readonly sourceFileId: string;
  readonly fileName: string;
  readonly sortOrder: number;
  readonly blobSha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly s3Key: string;
  readonly verifyState: string;
  readonly pages: readonly BundlePlanPage[];
}

export interface BundlePlan {
  readonly folderId: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly files: readonly BundlePlanFile[];
  readonly aggregateManifestHash: string;
  /** Пусто — можно собирать; иначе перечень причин, почему нельзя. */
  readonly blockers: readonly string[];
}

/**
 * Состав ревизии в порядке, заданном пользователем, вместе с хэшем манифеста.
 *
 * `null` — ревизии нет ИЛИ она вне области видимости. Разница между этими
 * случаями наружу не выдаётся намеренно: «не найдено» и «не ваше» обязаны быть
 * неразличимы, иначе перебором идентификаторов узнаётся факт существования
 * чужой поставки.
 *
 * Препятствия сборке (`blockers`) собираются списком, а не первым найденным:
 * пользователю нужно увидеть все файлы в карантине сразу, а не по одному за
 * попытку.
 */
export async function loadBundlePlan(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<BundlePlan | null> {
  const visible = await db
    .select({
      id: folders.id,
      objectId: folders.objectId,
      contractorId: folders.contractorId,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
    .limit(1);

  const folder = visible[0];
  if (folder === undefined) return null;

  const rows = await db
    .select({
      sourceFileId: sourceFiles.id,
      fileName: sourceFiles.fileName,
      sortOrder: sourceFiles.sortOrder,
      blobSha256: sourceFiles.blobSha256,
      verifyState: sourceFiles.verifyState,
      sizeBytes: storedBlobs.sizeBytes,
      mime: storedBlobs.mime,
      s3Key: storedBlobs.s3Key,
      sourcePageId: sourcePages.id,
      filePageIndex: sourcePages.filePageIndex,
    })
    .from(sourceFiles)
    .innerJoin(folders, eq(sourceFiles.folderId, folders.id))
    .innerJoin(storedBlobs, eq(sourceFiles.blobSha256, storedBlobs.sha256))
    // LEFT: файл без страниц обязан остаться в плане и стать препятствием,
    // а INNER JOIN молча выбросил бы его из состава — и рабочий документ
    // собрался бы без него, не сообщив об этом никому.
    .leftJoin(sourcePages, eq(sourcePages.sourceFileId, sourceFiles.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(sourceFiles.folderId, folderId)))
    .orderBy(asc(sourceFiles.sortOrder), asc(sourcePages.filePageIndex));

  const byFile = new Map<
    string,
    { file: Omit<BundlePlanFile, 'pages'>; pages: BundlePlanPage[] }
  >();
  for (const row of rows) {
    let entry = byFile.get(row.sourceFileId);
    if (entry === undefined) {
      entry = {
        file: {
          sourceFileId: row.sourceFileId,
          fileName: row.fileName,
          sortOrder: row.sortOrder,
          blobSha256: row.blobSha256,
          sizeBytes: Number(row.sizeBytes),
          mime: row.mime,
          s3Key: row.s3Key,
          verifyState: row.verifyState,
        },
        pages: [],
      };
      byFile.set(row.sourceFileId, entry);
    }
    if (row.sourcePageId !== null && row.filePageIndex !== null) {
      entry.pages.push({ sourcePageId: row.sourcePageId, filePageIndex: row.filePageIndex });
    }
  }

  const files: BundlePlanFile[] = [...byFile.values()].map((entry) => ({
    ...entry.file,
    pages: entry.pages,
  }));

  return {
    folderId: folder.id,
    objectId: folder.objectId,
    contractorId: folder.contractorId,
    files,
    aggregateManifestHash: computeAggregateManifestHash(files),
    blockers: collectBlockers(files),
  };
}

function collectBlockers(files: readonly BundlePlanFile[]): readonly string[] {
  const blockers: string[] = [];

  if (files.length === 0) blockers.push('в папке нет ни одного файла');

  for (const file of files) {
    if (file.verifyState === 'quarantined') {
      blockers.push(`файл «${file.fileName}» в карантине`);
    } else if (file.verifyState !== 'ok') {
      blockers.push(`файл «${file.fileName}» ещё не проверен (${file.verifyState})`);
    } else if (file.pages.length === 0) {
      // Проверенный файл без страниц — расхождение внутри конвейера: file.verify
      // обязан записать страницы вместе со статусом «ok».
      blockers.push(`у файла «${file.fileName}» нет ни одной страницы`);
    }
  }

  const positions = new Set(files.map((file) => file.sortOrder));
  if (positions.size !== files.length) {
    blockers.push('порядок файлов задан неоднозначно: есть совпадающие позиции');
  }

  return blockers;
}

// =====================================================================
// Чтение bundle
// =====================================================================

export interface BundleView {
  readonly id: string;
  readonly folderId: string;
  readonly aggregateManifestHash: string;
  readonly workingPdfBlobSha256: string;
  readonly builderVersion: string;
  readonly createdAt: string;
  readonly pageCount: number;
}

const BUNDLE_SELECTION = {
  id: processingBundles.id,
  folderId: processingBundles.folderId,
  aggregateManifestHash: processingBundles.aggregateManifestHash,
  workingPdfBlobSha256: processingBundles.workingPdfBlobSha256,
  builderVersion: processingBundles.builderVersion,
  createdAt:
    sql<string>`to_char(${processingBundles.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
      'created_at_iso',
    ),
  // Внутренняя таблица под алиасом, внешняя — ТЕКСТОМ: в запросе без джойнов
  // Drizzle рендерит подставленную колонку без имени таблицы, и `bundle_id = "id"`
  // связалось бы с `id` самой `processing_bundle_pages` (тот же дефект, что
  // обнулял `hasBundle` и счётчик страниц файла в `files.ts`). Сегодня все три
  // чтения этой выборки джойнят ревизию, но корректность не должна зависеть от
  // того, сохранит ли следующий вызывающий джойн.
  pageCount:
    sql<number>`(select count(*)::int from ${processingBundlePages} bp where bp.bundle_id = processing_bundles.id)`.as(
      'page_count',
    ),
};

export async function findBundle(
  db: Database,
  scope: AuthScope,
  bundleId: string,
): Promise<BundleView | null> {
  const rows = await db
    .select(BUNDLE_SELECTION)
    .from(processingBundles)
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(processingBundles.id, bundleId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Уже собранный документ ровно того же состава и той же версии сборщика. */
export async function findBundleByManifest(
  db: Database,
  scope: AuthScope,
  target: {
    readonly folderId: string;
    readonly aggregateManifestHash: string;
    readonly builderVersion: string;
  },
): Promise<BundleView | null> {
  const rows = await db
    .select(BUNDLE_SELECTION)
    .from(processingBundles)
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        eq(processingBundles.folderId, target.folderId),
        eq(processingBundles.aggregateManifestHash, target.aggregateManifestHash),
        eq(processingBundles.builderVersion, target.builderVersion),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listBundles(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<readonly BundleView[]> {
  return db
    .select(BUNDLE_SELECTION)
    .from(processingBundles)
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(processingBundles.folderId, folderId)))
    .orderBy(asc(processingBundles.createdAt));
}

// =====================================================================
// Карта страниц
// =====================================================================

export interface BundlePageView {
  readonly workingPageIndex: number;
  readonly sourcePageId: string;
  readonly sourceFileId: string;
  readonly fileName: string;
  readonly filePageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /**
   * `/Rotate` из самого PDF. УЖЕ применён — и к `widthPx/heightPx` выше, и к
   * вьюпорту pdf.js, и к растру poppler.
   */
  readonly rotation: number;
  /**
   * Разворот СОДЕРЖИМОГО: поправка к скану, легшему на лист боком (ADR-0020).
   * Не применён никем; его применяют детекция и кроп, а показывает разметка.
   *
   * Спутать эти два поля — самый вероятный класс ошибки в этом коде, поэтому у
   * них разные имена и разные докстринги, а не одно поле с флагом.
   */
  readonly contentRotation: ContentRotation;
  /** Кем поставлен разворот; `null` — решения не было, значение нулевое. */
  readonly contentRotationSource: ContentRotationSource | null;
  /**
   * Разрешение покрывающего страницу растра, точек на дюйм; `null` — растра нет
   * либо он не опознан.
   *
   * Потолок для рендера: выше него страница не станет детальнее, а байты и
   * время на кодирование вырастут (см. `effectiveRasterDpi`).
   */
  readonly nativeDpi: number | null;
}

/**
 * Разворот приезжает ТЕМ ЖЕ запросом, что и карта страниц.
 *
 * Левое соединение, а не второй запрос: карту страниц читают все трое, кому
 * разворот нужен, — локальная детекция, распознавание и экран разметки. Второй
 * источник означал бы три места, где его забыли прочитать, и три разных ответа
 * на один вопрос.
 */
const PAGE_MAP_SELECTION = {
  workingPageIndex: processingBundlePages.workingPageIndex,
  sourcePageId: processingBundlePages.sourcePageId,
  sourceFileId: sourcePages.sourceFileId,
  fileName: sourceFiles.fileName,
  filePageIndex: sourcePages.filePageIndex,
  widthPx: sourcePages.widthPx,
  heightPx: sourcePages.heightPx,
  rotation: sourcePages.rotation,
  nativeDpi: sourcePages.nativeDpi,
  contentRotation: sql<number>`coalesce(${pageOrientations.contentRotation}, 0)`,
  contentRotationSource: pageOrientations.source,
};

/**
 * Условие соединения с разворотом — по ПАРЕ ключей, а не по `source_page_id`.
 *
 * Ревизия входит в первичный ключ `page_orientations`, и соединение по одному
 * идентификатору страницы опиралось бы на то, что он уникален глобально:
 * сегодня это так, но схема этого не обещает.
 */
const ORIENTATION_JOIN = and(
  eq(pageOrientations.folderId, processingBundles.folderId),
  eq(pageOrientations.sourcePageId, processingBundlePages.sourcePageId),
);

/** Строка карты страниц из выборки — с приведением развёрнутых полей к контракту. */
function toPageView(row: {
  readonly workingPageIndex: number;
  readonly sourcePageId: string;
  readonly sourceFileId: string;
  readonly fileName: string;
  readonly filePageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
  readonly nativeDpi: number | null;
  readonly contentRotation: number;
  readonly contentRotationSource: string | null;
}): BundlePageView {
  return {
    workingPageIndex: row.workingPageIndex,
    sourcePageId: row.sourcePageId,
    sourceFileId: row.sourceFileId,
    fileName: row.fileName,
    filePageIndex: row.filePageIndex,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    rotation: row.rotation,
    nativeDpi: row.nativeDpi,
    // CHECK базы уже сузил домен до четырёх значений; здесь только приведение
    // типа, а `?? 0` покрывает страницу без строки разворота.
    contentRotation: (row.contentRotation ?? 0) as ContentRotation,
    contentRotationSource:
      row.contentRotationSource === 'probe' || row.contentRotationSource === 'user'
        ? row.contentRotationSource
        : null,
  };
}

/** Полная карта: страница рабочего PDF → файл и страница оригинала. */
export async function listBundlePages(
  db: Database,
  scope: AuthScope,
  bundleId: string,
): Promise<readonly BundlePageView[]> {
  const rows = await db
    .select(PAGE_MAP_SELECTION)
    .from(processingBundlePages)
    .innerJoin(processingBundles, eq(processingBundlePages.bundleId, processingBundles.id))
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .innerJoin(sourcePages, eq(processingBundlePages.sourcePageId, sourcePages.id))
    .innerJoin(sourceFiles, eq(sourcePages.sourceFileId, sourceFiles.id))
    .leftJoin(pageOrientations, ORIENTATION_JOIN)
    .where(withScope(scope, FOLDER_SCOPE, eq(processingBundlePages.bundleId, bundleId)))
    .orderBy(asc(processingBundlePages.workingPageIndex));
  return rows.map(toPageView);
}

/**
 * Обратное отображение одной страницы.
 *
 * Отдельным запросом, а не выборкой из полной карты: на 83-страничном
 * комплекте результат распознавания приходит постранично, и тянуть всю карту
 * ради одной строки значит делать это восемьдесят три раза.
 */
export async function findSourceOfWorkingPage(
  db: Database,
  scope: AuthScope,
  bundleId: string,
  workingPageIndex: number,
): Promise<BundlePageView | null> {
  const rows = await db
    .select(PAGE_MAP_SELECTION)
    .from(processingBundlePages)
    .innerJoin(processingBundles, eq(processingBundlePages.bundleId, processingBundles.id))
    .innerJoin(folders, eq(processingBundles.folderId, folders.id))
    .innerJoin(sourcePages, eq(processingBundlePages.sourcePageId, sourcePages.id))
    .innerJoin(sourceFiles, eq(sourcePages.sourceFileId, sourceFiles.id))
    .leftJoin(pageOrientations, ORIENTATION_JOIN)
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        eq(processingBundlePages.bundleId, bundleId),
        eq(processingBundlePages.workingPageIndex, workingPageIndex),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toPageView(row);
}

// =====================================================================
// Запись
// =====================================================================

export interface WorkingPdfBlob {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly s3Key: string;
  readonly mime?: string;
}

export interface CreateBundleInput {
  readonly folderId: string;
  readonly aggregateManifestHash: string;
  readonly builderVersion: string;
  readonly workingPdf: WorkingPdfBlob;
  readonly pages: readonly { readonly workingPageIndex: number; readonly sourcePageId: string }[];
}

export interface CreateBundleResult {
  readonly bundle: BundleView;
  /** `false` — такой же документ уже был собран, повторной записи не было. */
  readonly created: boolean;
}

/**
 * Запись рабочего документа и его карты одной транзакцией.
 *
 * Идемпотентно: `bundle.build` перезапускается при падении воркера, и второй
 * рабочий документ того же состава был бы и лишней копией 86 МБ, и
 * неоднозначностью «какой из двух отправляли» (§3.3). Поэтому существующий
 * bundle того же манифеста и той же версии сборщика возвращается как есть.
 *
 * Карта пишется в той же транзакции, что и сам bundle: bundle без карты — это
 * рабочий PDF, страницы которого не сопоставить с оригиналами, то есть
 * бесполезный и при этом выглядящий готовым артефакт.
 */
export async function createBundle(
  db: Database,
  scope: AuthScope,
  input: CreateBundleInput,
): Promise<CreateBundleResult> {
  const existing = await findBundleByManifest(db, scope, input);
  if (existing !== null) return { bundle: existing, created: false };

  assertPageMap(input.pages);

  const bundleId = await db.transaction(async (tx) => {
    // Область видимости проверяется внутри транзакции: строка ревизии здесь и
    // разрешение на запись — одно решение, и разносить их нельзя.
    const visible = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, input.folderId)))
      .limit(1);

    if (visible[0] === undefined) throw notFound('Папка не найдена.');

    // Дедупликация по содержимому (§3.3): те же байты второй раз не хранятся.
    // Конфликт возможен и по s3_key — тогда запись тоже пропускается, а
    // осиротевший объект в хранилище убирает сборка мусора (§13).
    await tx
      .insert(storedBlobs)
      .values({
        sha256: input.workingPdf.sha256,
        s3Key: input.workingPdf.s3Key,
        sizeBytes: input.workingPdf.sizeBytes,
        mime: input.workingPdf.mime ?? 'application/pdf',
      })
      .onConflictDoNothing();

    const inserted = await tx
      .insert(processingBundles)
      .values({
        folderId: input.folderId,
        aggregateManifestHash: input.aggregateManifestHash,
        workingPdfBlobSha256: input.workingPdf.sha256,
        builderVersion: input.builderVersion,
      })
      .returning({ id: processingBundles.id });

    const row = inserted[0];
    if (row === undefined) {
      throw internal({ logDetail: 'INSERT рабочего документа не вернул строку' });
    }

    if (input.pages.length > 0) {
      await tx.insert(processingBundlePages).values(
        input.pages.map((page) => ({
          bundleId: row.id,
          folderId: input.folderId,
          workingPageIndex: page.workingPageIndex,
          sourcePageId: page.sourcePageId,
        })),
      );
    }

    // Событие пишется той же транзакцией и общей функцией из `jobs.ts`:
    // второй выдачи `seq` быть не должно — расхождение номеров означало бы
    // пропущенное событие у SSE-клиента с `Last-Event-ID`.
    await appendFolderEvent(tx, {
      folderId: input.folderId,
      eventType: 'bundle.created',
      payload: {
        bundleId: row.id,
        builderVersion: input.builderVersion,
        aggregateManifestHash: input.aggregateManifestHash,
        pageCount: input.pages.length,
      },
    });

    return row.id;
  });

  const bundle = await findBundle(db, scope, bundleId);
  if (bundle === null) {
    throw internal({ logDetail: 'рабочий документ не читается сразу после записи' });
  }
  return { bundle, created: true };
}

/**
 * Проверка карты до записи.
 *
 * БД удержит уникальность индекса и страницы (`processing_bundle_pages_*_uq`),
 * но не сплошность нумерации: карта с дырой прошла бы все ограничения и дала бы
 * рабочий документ, у части страниц которого нет соответствия. Ошибка обязана
 * быть здесь, а не при первом обращении к странице 47 через месяц.
 */
function assertPageMap(
  pages: readonly { readonly workingPageIndex: number; readonly sourcePageId: string }[],
): void {
  const indices = [...pages].map((page) => page.workingPageIndex).sort((a, b) => a - b);
  const uniquePages = new Set(pages.map((page) => page.sourcePageId));

  if (uniquePages.size !== pages.length) {
    throw conflict('Одна и та же страница оригинала не может занимать две страницы рабочего PDF.');
  }
  for (let expected = 0; expected < indices.length; expected += 1) {
    if (indices[expected] !== expected) {
      throw conflict(
        `Карта страниц рабочего PDF не сплошная: ожидался индекс ${expected}, ` +
          `получен ${String(indices[expected])}.`,
      );
    }
  }
}

/** Совместим ли уже собранный документ с текущим составом ревизии. */
export function isBundleCurrent(
  bundle: BundleView,
  plan: BundlePlan,
  builderVersion: string,
): boolean {
  return (
    bundle.aggregateManifestHash === plan.aggregateManifestHash &&
    bundle.builderVersion === builderVersion
  );
}

/** Проверка условий сборки до дорогой работы. */
export function assertPlanBuildable(plan: BundlePlan): void {
  if (plan.blockers.length > 0) {
    throw conflict(`Рабочий документ собрать нельзя: ${plan.blockers.join('; ')}.`);
  }
}

/** Состав в порядке, заданном пользователем, — вход для `planWorkingPdf()`. */
export function orderedParts(plan: BundlePlan): readonly BundlePlanFile[] {
  return [...plan.files].sort((a, b) => a.sortOrder - b.sortOrder);
}
