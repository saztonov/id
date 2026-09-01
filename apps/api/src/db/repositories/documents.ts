/**
 * Логические документы, учёт страниц, реквизиты и реестр приложений (§3.6, §8).
 *
 * ## Центральная функция файла — `applySegmentation`, и она про инвариант
 *
 * §16 требует: каждая страница ревизии — ровно в одном документе либо явной
 * строкой «не привязана»; пересечений и потерь нет. Это non-degradable гейт
 * §1.6, и держат его ДВА независимых рубежа БД, а не аккуратность кода:
 *
 * - `page_assignments_page_uq UNIQUE (folder_id, source_page_id)` — «страница
 *   не в двух местах». Ограничение говорит о строке, которая есть;
 * - представление `v_unaccounted_pages` — «потерь нет». Ограничением это не
 *   выражается вовсе: утверждение о полноте — это утверждение о странице,
 *   которой в `page_assignments` НЕТ.
 *
 * Поэтому `applySegmentation` проверяет представление ВНУТРИ той же транзакции,
 * которая переписала документы, и ненулевой результат откатывает всё. Проверка
 * после коммита была бы наблюдением за уже случившейся потерей.
 *
 * ## Успешная задача, ничего не изменившая, — это отказ
 *
 * Прямой урок S5 и S6: там задачи завершались успехом, не поставив ни одной
 * строки в очередь (S5) и уничтожив 124 блока разметки (S6). Поэтому каждая
 * изменяющая функция здесь возвращает СЧЁТЧИКИ, а не `void`, и вызывающий
 * обязан их видеть: «переписано 0 документов» и «переписано 12 документов» —
 * разные исходы, и второй не должен быть неотличим от первого.
 *
 * ## Что не затирается повтором
 *
 * `saveFieldValues` не трогает значения `extracted_by = 'manual'` с
 * `is_verified`. Инженер, исправивший номер сертификата руками, не должен
 * терять эту работу от повторного прогона извлечения — ровно тот класс отказа,
 * который S6 нашёл у импорта блоков.
 *
 * ## Область видимости
 *
 * У `logical_documents` есть собственные `object_id` и `contractor_id`, но
 * область всё равно применяется соединением с `folders` — как в
 * `recognition.ts` и `layout.ts`. Причина не в удобстве: у `page_assignments`,
 * `page_classifications` и `registry_rows` своих колонок области нет вовсе, и
 * один способ на весь файл означает, что «забыл область» невозможно по форме
 * запроса. Ни одна функция не выполняется без `withScope()`.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import {
  complects,
  docTypes,
  documentRelations,
  fieldValues,
  layoutBlocks,
  layoutRevisions,
  logicalDocuments,
  pageAssignments,
  pageClassifications,
  pageRoles,
  pageTextVersions,
  processingBundlePages,
  recognitionRuns,
  registryRowCandidates,
  registryRows,
  sourcePages,
  folders,
  vUnaccountedPages,
} from '@id/db';
import type { DocumentRelation, MatchState, PageRoleCode } from '@id/contracts';
import { planComplects } from '../../segmentation/complects.js';
import type { AuthScope } from '../../auth/scope.js';
import {
  conflict,
  internal,
  isHttpProblem,
  notFound,
  preconditionFailed,
} from '../../lib/problem.js';
import type {
  ClassificationSource,
  DecodedDocument,
  DecodedUnassigned,
  ExtractedField,
  ManualLabel,
  PageClassification,
  PageLabel,
  ParsedRegistryRow,
  SegmentationBlockType,
  TypeOutcome,
} from '../../segmentation/types.js';
import { driverField } from '../driver-errors.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { appendAudit, type AuditActor } from './audit.js';
import { appendFolderEvent } from './jobs.js';
import type { Database } from './users.js';

/**
 * Чтение, одинаково пригодное и базе, и открытой транзакции.
 *
 * Тот же приём, что в остальных репозиториях (`checks.ts`, `files.ts`). Нужен
 * читателям, которых зовёт отчёт о составе комплекта: он собирает документы,
 * реквизиты и строки реестра ОДНОЙ транзакцией, иначе пересегментация посреди
 * чтения даёт ответ, часть которого описывает прежнюю нарезку.
 */
type ReadExecutor = Pick<Database, 'select'>;

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/**
 * Статусы ревизии поставки, в которых документы менять можно.
 *
 * Документы — класс `derived` (0008): их производит конвейер и правит
 * проверяющий, поэтому заперты только терминальные состояния. Список
 * продублирован здесь сознательно, как в `layout.ts`: отказ обязан приходить
 * понятным текстом ДО дорогой работы, а не исключением триггера после неё.
 */
const isoAt = (column: unknown, alias: string) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    alias,
  );

// =====================================================================
// Общая проверка ревизии
// =====================================================================

interface VisibleFolder {
  readonly id: string;
  readonly objectId: string;
  readonly contractorId: string;
}

/**
 * Папка в области видимости вызывающего.
 *
 * Одна функция на весь файл: «сначала убедиться, что папка видна, затем
 * писать» — это и есть второй уровень изоляции (§4.1). Разбросанные по
 * функциям проверки разошлись бы, а пропущенная означала бы запись в чужую
 * папку по прямому идентификатору.
 *
 * Требования ИЗМЕНЯЕМОСТИ здесь больше нет: статусы подачи сняты вместе с
 * согласованием (S44), и «терминальной» папки не существует. Видимость —
 * единственное, что проверяется перед записью.
 */
export async function requireVisibleFolder(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<VisibleFolder> {
  const rows = await db
    .select({
      id: folders.id,
      objectId: folders.objectId,
      contractorId: folders.contractorId,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw notFound('Папка не найдена.');
  return row;
}

/**
 * Выполняет запись, переводя отказ БД в осмысленный ответ.
 *
 * ## Почему нарушения ограничений называются поимённо
 *
 * `page_assignments_page_uq` — это не «внутренняя ошибка», а вторая половина
 * инварианта §16, сработавшая по назначению: декодер попытался положить одну
 * страницу в два места. То же с `page_classifications_observed_title_chk`:
 * это поломка цикла роста каталога (§3.2). Ответ обязан их называть, иначе
 * единственный след такого дефекта — 500 без объяснения.
 *
 * ## Почему НЕЗНАКОМАЯ ошибка БД тоже не уходит наружу как есть
 *
 * Сообщение `DrizzleQueryError` собрано как `Failed query: <весь SQL>
params:
 * <ВСЕ значения bind-параметров>`, а `toHttpProblem()` кладёт сообщение
 * необёрнутой ошибки в `logDetail`, то есть в журнал. Здесь параметрами идут
 * цитаты из документов, наблюдённые заголовки и распознанный текст — то самое,
 * что §11 запрещает логировать. Поэтому граница репозитория заменяет текст на
 * свой: SQLSTATE и имени ограничения для диагностики достаточно. Это тот же
 * приём, что в `catalog.ts`, и заведён он там по итогам утечки S3.
 */
export async function guardWrites<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    // Собственные отказы репозитория (409 инварианта, 412 версии) брошены
    // внутри транзакции и ошибкой драйвера не являются.
    if (isHttpProblem(error)) throw error;

    const constraintName = driverField(error, 'constraint');
    const sqlState = driverField(error, 'code');

    if (constraintName === 'page_assignments_page_uq') {
      throw conflict(
        'Страница ревизии учтена дважды: сегментация нарушила инвариант ' +
          '«страница ровно в одном документе либо в непривязанных».',
        { logDetail: 'нарушено page_assignments_page_uq' },
      );
    }
    if (constraintName === 'page_classifications_observed_title_chk') {
      throw conflict(
        'Классификация с исходом «other» обязана нести наблюдённый заголовок: ' +
          'без него документ незнакомого типа не попадёт в кандидаты каталога.',
        { logDetail: 'нарушено page_classifications_observed_title_chk' },
      );
    }
    if (constraintName === 'logical_documents_confirmed_lock') {
      // Третий рубеж инварианта «ручная разметка приоритетна» (§8.2). Сюда
      // доезжает только запрос в обход `applySegmentation` — например прямой
      // SQL или будущий второй вызывающий. Отказ обязан называть причину, иначе
      // единственным следом уничтоженного подтверждения был бы 500.
      throw conflict(
        'Подтверждённый человеком документ удалён быть не может: ' +
          'снимите подтверждение явным действием.',
        { logDetail: 'сработал триггер logical_documents_confirmed_lock' },
      );
    }
    if (constraintName === 'registry_rows_matched_chk') {
      throw conflict(
        'Совпадение строки реестра без документа: состояние «matched» требует ' +
          'указания документа, иначе сверка утверждает совпадение неизвестно с чем.',
        { logDetail: 'нарушено registry_rows_matched_chk' },
      );
    }
    // `restrict_violation` поднимают триггеры неизменяемости (0008, 0014).
    if (sqlState === '23001') {
      throw conflict(
        'Ревизия поставки в терминальном статусе: содержимое документов неизменяемо. ' +
          'Исправление вносится созданием новой ревизии.',
        { logDetail: `отказ триггера неизменяемости (SQLSTATE ${sqlState})` },
      );
    }

    throw internal({
      logDetail:
        `запись документов отвергнута базой (SQLSTATE ${sqlState ?? 'неизвестен'}, ` +
        `ограничение ${constraintName ?? 'не указано'})`,
    });
  }
}

// =====================================================================
// Классификация страниц (задача 14)
// =====================================================================

export interface PageClassificationView {
  readonly sourcePageId: string;
  readonly folderOrdinal: number;
  readonly label: PageLabel;
  readonly docTypeCode: string | null;
  readonly typeOutcome: TypeOutcome;
  readonly observedTitle: string | null;
  readonly pageRoleCode: string | null;
  readonly parentRef: string | null;
  readonly confidence: number | null;
  readonly reason: string | null;
  readonly source: ClassificationSource;
  readonly pageTextVersionId: string | null;
  readonly charSpan: { readonly start: number; readonly end: number } | null;
  readonly quote: string | null;
  readonly alternatives: readonly string[];
  readonly ambiguous: boolean;
}

export interface SaveClassificationsInput {
  readonly folderId: string;
  readonly classifications: readonly PageClassification[];
}

export interface SaveClassificationsOutcome {
  readonly removed: number;
  readonly written: number;
}

/**
 * Полная замена набора решений по ревизии ОДНОЙ транзакцией.
 *
 * Замена, а не upsert по странице: набор меток описывает ревизию целиком, и
 * частичное обновление оставило бы решения прошлого прогона рядом с решениями
 * текущего — при разном составе страниц (файл переупорядочен, страница удалена
 * в черновике) это дало бы декодеру метки, которых он не заказывал.
 *
 * `DELETE` + `INSERT` внутри одной транзакции, потому что промежуточное
 * состояние «меток нет» не должно быть наблюдаемым: задача 15, стартовавшая
 * между ними, собрала бы документы из пустоты и завершилась успехом.
 */
export async function savePageClassifications(
  db: Database,
  scope: AuthScope,
  input: SaveClassificationsInput,
): Promise<SaveClassificationsOutcome> {
  await requireVisibleFolder(db, scope, input.folderId);

  return guardWrites(() =>
    db.transaction(async (tx) => {
      const removed = await tx
        .delete(pageClassifications)
        .where(eq(pageClassifications.folderId, input.folderId))
        .returning({ sourcePageId: pageClassifications.sourcePageId });

      let written = 0;
      for (const item of input.classifications) {
        await tx.insert(pageClassifications).values({
          folderId: input.folderId,
          sourcePageId: item.sourcePageId,
          label: item.label,
          docTypeCode: item.docTypeCode,
          typeOutcome: item.typeOutcome,
          observedTitle: item.observedTitle,
          pageRoleCode: item.pageRoleCode,
          parentRef: item.parentRef,
          confidence: item.confidence,
          reason: item.reason,
          source: item.source,
          pageTextVersionId: item.evidence?.pageTextVersionId ?? null,
          charSpan:
            item.evidence === null
              ? null
              : { start: item.evidence.charStart, end: item.evidence.charEnd },
          quote: item.evidence?.quote ?? null,
          alternatives: [...item.alternatives],
          ambiguous: item.ambiguous,
        });
        written += 1;
      }

      await appendFolderEvent(tx, {
        folderId: input.folderId,
        eventType: 'documents.pages_classified',
        payload: { removed: removed.length, written },
      });

      return { removed: removed.length, written };
    }),
  );
}

/** Объяснение решения: почему страница получила такую метку. */
export async function listPageClassifications(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<readonly PageClassificationView[]> {
  const rows = await db
    .select({
      sourcePageId: pageClassifications.sourcePageId,
      folderOrdinal: sourcePages.folderOrdinal,
      label: pageClassifications.label,
      docTypeCode: pageClassifications.docTypeCode,
      typeOutcome: pageClassifications.typeOutcome,
      observedTitle: pageClassifications.observedTitle,
      pageRoleCode: pageClassifications.pageRoleCode,
      parentRef: pageClassifications.parentRef,
      confidence: pageClassifications.confidence,
      reason: pageClassifications.reason,
      source: pageClassifications.source,
      pageTextVersionId: pageClassifications.pageTextVersionId,
      charSpan: pageClassifications.charSpan,
      quote: pageClassifications.quote,
      alternatives: pageClassifications.alternatives,
      ambiguous: pageClassifications.ambiguous,
    })
    .from(pageClassifications)
    .innerJoin(
      sourcePages,
      and(
        eq(sourcePages.id, pageClassifications.sourcePageId),
        eq(sourcePages.folderId, pageClassifications.folderId),
      ),
    )
    .innerJoin(folders, eq(pageClassifications.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(pageClassifications.folderId, folderId)))
    .orderBy(asc(sourcePages.folderOrdinal));

  return rows.map((row) => ({
    ...row,
    label: row.label as PageLabel,
    typeOutcome: row.typeOutcome as TypeOutcome,
    source: row.source as ClassificationSource,
    charSpan: row.charSpan === null ? null : { start: row.charSpan.start, end: row.charSpan.end },
    alternatives: Array.isArray(row.alternatives) ? (row.alternatives as string[]) : [],
  }));
}

// =====================================================================
// Ручная разметка страницы (§8.2, фаза 3)
// =====================================================================

export interface ManualPageLabelInput {
  readonly folderId: string;
  readonly sourcePageId: string;
  readonly label: PageLabel;
  readonly docTypeCode: string | null;
  readonly pageRoleCode: string | null;
  readonly actor: AuditActor;
}

export interface ManualPageLabelView {
  readonly folderId: string;
  readonly sourcePageId: string;
  readonly label: PageLabel;
  readonly docTypeCode: string | null;
  readonly pageRoleCode: string | null;
  readonly source: 'manual';
}

/**
 * Ручная метка страницы: инженер указывает тип каждой страницы сам.
 *
 * Хранится строкой `page_classifications` с `source = 'manual'` — это
 * задуманная точка входа фазы 3 (§8.2): `loadSegmentationPages` поднимает её в
 * `PageInput.manual`, фаза 1 её не переопределяет (`classifyOne`, приоритет 1)
 * и при пересборке записывает обратно с тем же источником — метка переживает
 * повторные прогоны без специальной защиты.
 *
 * Пересборка документов НЕ запускается отсюда: она стоит прогона LLM по всем
 * страницам, и запуск остаётся за явной кнопкой (`POST …/segment`) — тот же
 * принцип, что у переизвлечения реквизитов.
 */
export async function saveManualPageLabel(
  db: Database,
  scope: AuthScope,
  input: ManualPageLabelInput,
): Promise<ManualPageLabelView> {
  const folder = await requireVisibleFolder(db, scope, input.folderId);

  // Совместность полей — то, что CHECK таблицы выразить не может: роль без
  // A-ROLE и тип у служебной страницы дали бы декодеру противоречивый вход.
  if (input.label === 'A-ROLE' && input.pageRoleCode === null) {
    throw conflict('Метка A-ROLE требует код роли страницы.');
  }
  if (input.label !== 'A-ROLE' && input.pageRoleCode !== null) {
    throw conflict('Код роли страницы допустим только при метке A-ROLE.');
  }
  if ((input.label === 'A-ROLE' || input.label === 'U') && input.docTypeCode !== null) {
    throw conflict('Вид документа указывается только у меток B-DOC и I-DOC.');
  }

  const pageRows = await db
    .select({ id: sourcePages.id })
    .from(sourcePages)
    .where(and(eq(sourcePages.id, input.sourcePageId), eq(sourcePages.folderId, input.folderId)))
    .limit(1);
  if (pageRows[0] === undefined) throw notFound('Страница не принадлежит этой ревизии.');

  if (input.docTypeCode !== null) {
    const known = await db
      .select({ code: docTypes.code })
      .from(docTypes)
      .where(eq(docTypes.code, input.docTypeCode))
      .limit(1);
    if (known[0] === undefined) {
      throw notFound(`Вид документа «${input.docTypeCode}» не найден в справочнике.`);
    }
  }
  if (input.pageRoleCode !== null) {
    const known = await db
      .select({ code: pageRoles.code })
      .from(pageRoles)
      .where(eq(pageRoles.code, input.pageRoleCode))
      .limit(1);
    if (known[0] === undefined) {
      throw notFound(`Роль страницы «${input.pageRoleCode}» не найдена в справочнике.`);
    }
  }

  const values = {
    folderId: input.folderId,
    sourcePageId: input.sourcePageId,
    label: input.label,
    docTypeCode: input.docTypeCode,
    // Тип задан человеком — исход `known`; без типа сигнал типовой отсутствует.
    typeOutcome: input.docTypeCode === null ? 'none' : 'known',
    observedTitle: null,
    pageRoleCode: input.pageRoleCode,
    parentRef: null,
    confidence: 1,
    reason: 'ручная разметка страницы',
    source: 'manual',
    pageTextVersionId: null,
    charSpan: null,
    quote: null,
    alternatives: [],
    ambiguous: false,
  };

  await guardWrites(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(pageClassifications)
        .values(values)
        .onConflictDoUpdate({
          target: [pageClassifications.folderId, pageClassifications.sourcePageId],
          set: values,
        });
      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'page.manual_label_set',
        entityType: 'source_page',
        entityId: input.sourcePageId,
        objectId: folder.objectId,
        payload: {
          label: input.label,
          docTypeCode: input.docTypeCode,
          pageRoleCode: input.pageRoleCode,
        },
      });
    }),
  );

  return {
    folderId: input.folderId,
    sourcePageId: input.sourcePageId,
    label: input.label,
    docTypeCode: input.docTypeCode,
    pageRoleCode: input.pageRoleCode,
    source: 'manual',
  };
}

/**
 * Снятие ручной метки.
 *
 * Удаляется ТОЛЬКО строка с `source = 'manual'`: машинное решение (если
 * инженер его перекрыл) уже перезаписано и не восстанавливается — страница
 * остаётся без классификации до следующей пересборки, и это честнее, чем
 * воскрешать решение, которого больше никто не видел.
 */
export async function deleteManualPageLabel(
  db: Database,
  scope: AuthScope,
  input: {
    readonly folderId: string;
    readonly sourcePageId: string;
    readonly actor: AuditActor;
  },
): Promise<void> {
  const folder = await requireVisibleFolder(db, scope, input.folderId);

  await guardWrites(() =>
    db.transaction(async (tx) => {
      const removed = await tx
        .delete(pageClassifications)
        .where(
          and(
            eq(pageClassifications.folderId, input.folderId),
            eq(pageClassifications.sourcePageId, input.sourcePageId),
            eq(pageClassifications.source, 'manual'),
          ),
        )
        .returning({ sourcePageId: pageClassifications.sourcePageId });
      if (removed.length === 0) {
        throw notFound('Ручная разметка этой страницы не найдена.');
      }
      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'page.manual_label_cleared',
        entityType: 'source_page',
        entityId: input.sourcePageId,
        objectId: folder.objectId,
        payload: {},
      });
    }),
  );
}

// =====================================================================
// Вход сегментации (задачи 14–19)
// =====================================================================

export interface SegmentationPageRow {
  readonly sourcePageId: string;
  readonly folderOrdinal: number;
  readonly sourceFileId: string;
  readonly filePageIndex: number;
  readonly workingPageIndex: number | null;
  readonly pageTextVersionId: string | null;
  /** `''` — текста нет; страница всё равно обязана дойти до декодера. */
  readonly text: string;
  readonly blockTypes: readonly SegmentationBlockType[];
  readonly rotation: number;
  /** Ручная метка (`page_classifications.source = 'manual'`): фазы 1–2 её не переопределяют. */
  readonly manual: ManualLabel | null;
}

export interface SegmentationInput {
  /** Прогон, из которого взят текст; `null` — завершённого распознавания нет. */
  readonly recognitionRunId: string | null;
  readonly pages: readonly SegmentationPageRow[];
}

/**
 * Вход сегментации: страницы ревизии с текстом ОДНОГО прогона и составом блоков.
 *
 * ## Почему прогон выбирается явно и один
 *
 * `page_text_versions` уникальна по паре «страница × прогон», то есть у одной
 * страницы легально несколько версий текста. «Взять какой-нибудь текст
 * страницы» означало бы собрать документ из двух разных распознаваний: у
 * страницы 5 текст свежего прогона, у страницы 6 — прошлого, а `char_span`
 * реквизитов измеряется в конкретной версии, и доказательства поехали бы, не
 * дав ни одной ошибки. Берётся последний прогон со статусом `done`.
 *
 * ## Почему страницы без текста тоже возвращаются
 *
 * Пустая страница, страница-схема без OCR и страница, до которой распознавание
 * не дошло, обязаны попасть на вход декодера: инвариант §16 требует, чтобы
 * учтена была КАЖДАЯ страница ревизии, а страница, выпавшая из входа, не
 * попадёт ни в документ, ни в непривязанные — то есть потеряется молча и
 * всплывёт только на `v_unaccounted_pages`.
 *
 * ## Почему нужен состав блоков
 *
 * Четыре класса документов корпуса текстом не определяются в принципе
 * (`docs/CORPUS_FINDINGS.md`): исполнительная схема — это `image` плюс `stamp`
 * без якорей. Классификатору нужен состав блоков той ревизии разметки, по
 * которой шёл прогон, а не «какой-нибудь разметки».
 *
 * Отсутствие завершённого прогона — не исключение, а `recognitionRunId: null` с
 * пустым списком: «распознавания ещё не было» и «страниц нет» — разные факты, и
 * вызывающая задача обязана их различать. Прогон, не опубликовавший ни строки
 * (shadow-режим ADR-0007), завершённым здесь не считается — см. условие в
 * запросе.
 */
export async function loadSegmentationPages(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<SegmentationInput> {
  await requireVisibleFolder(db, scope, folderId);

  const runs = await db
    .select({
      id: recognitionRuns.id,
      layoutRevisionId: recognitionRuns.layoutRevisionId,
      bundleId: layoutRevisions.bundleId,
    })
    .from(recognitionRuns)
    .innerJoin(folders, eq(recognitionRuns.folderId, folders.id))
    .innerJoin(layoutRevisions, eq(recognitionRuns.layoutRevisionId, layoutRevisions.id))
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        eq(recognitionRuns.folderId, folderId),
        eq(recognitionRuns.status, 'done'),
        /**
         * Прогон обязан быть ОПУБЛИКОВАННЫМ, а не просто завершённым.
         *
         * Прогон в режиме dry-run (`ai.dry_run_only`, ADR-0007) выполняется
         * целиком и закрывается честным `done`, но публикацию пропускает —
         * `page_text_versions` после него нет ни одной. Выбранный «как
         * последний завершённый», он давал сегментации ревизию, у которой текст
         * есть только у прежнего, настоящего прогона: соединение по
         * `pageTextVersions` ниже отдало бы `null` на КАЖДОЙ странице, и
         * комплект выглядел бы нераспознанным при живом распознавании под ним.
         *
         * Условие подзапросом, а не соединением: строка нужна одна, и `exists`
         * останавливается на первой найденной версии текста.
         */
        sql`exists (
          select 1 from ${pageTextVersions} ptv
           where ptv.recognition_run_id = ${recognitionRuns.id}
        )`,
      ),
    )
    .orderBy(sql`${recognitionRuns.finishedAt} desc nulls last`)
    .limit(1);

  const run = runs[0];
  if (run === undefined) return { recognitionRunId: null, pages: [] };

  const rows = await db
    .select({
      sourcePageId: sourcePages.id,
      folderOrdinal: sourcePages.folderOrdinal,
      sourceFileId: sourcePages.sourceFileId,
      filePageIndex: sourcePages.filePageIndex,
      workingPageIndex: processingBundlePages.workingPageIndex,
      pageTextVersionId: pageTextVersions.id,
      textMd: pageTextVersions.textMd,
      rotation: sourcePages.rotation,
      // Состав блоков страницы в ревизии разметки ЭТОГО прогона. `distinct` с
      // сортировкой — чтобы порядок не зависел от физического порядка строк:
      // ключ кэша промта фазы 2 включает вход, и переставленный массив дал бы
      // промах кэша на неизменившейся странице.
      blockTypes: sql<string[] | null>`(
        select array_agg(distinct b.block_type order by b.block_type)
          from ${layoutBlocks} b
         where b.layout_revision_id = ${run.layoutRevisionId}::uuid
           and b.source_page_id = ${sourcePages.id}
      )`.as('block_types'),
      manualLabel: pageClassifications.label,
      manualDocTypeCode: pageClassifications.docTypeCode,
      manualPageRoleCode: pageClassifications.pageRoleCode,
    })
    .from(sourcePages)
    .innerJoin(folders, eq(sourcePages.folderId, folders.id))
    .leftJoin(
      pageTextVersions,
      and(
        eq(pageTextVersions.sourcePageId, sourcePages.id),
        eq(pageTextVersions.recognitionRunId, run.id),
      ),
    )
    .leftJoin(
      processingBundlePages,
      and(
        eq(processingBundlePages.sourcePageId, sourcePages.id),
        eq(processingBundlePages.bundleId, run.bundleId),
      ),
    )
    // Ручная разметка приоритетна внутри ревизии (§8.2, фаза 3): она и есть
    // причина, по которой вход сегментации читает `page_classifications`.
    .leftJoin(
      pageClassifications,
      and(
        eq(pageClassifications.sourcePageId, sourcePages.id),
        eq(pageClassifications.folderId, sourcePages.folderId),
        eq(pageClassifications.source, 'manual'),
      ),
    )
    .where(withScope(scope, FOLDER_SCOPE, eq(sourcePages.folderId, folderId)))
    .orderBy(asc(sourcePages.folderOrdinal));

  return {
    recognitionRunId: run.id,
    pages: rows.map((row) => ({
      sourcePageId: row.sourcePageId,
      folderOrdinal: Number(row.folderOrdinal),
      sourceFileId: row.sourceFileId,
      filePageIndex: Number(row.filePageIndex),
      workingPageIndex: row.workingPageIndex === null ? null : Number(row.workingPageIndex),
      pageTextVersionId: row.pageTextVersionId,
      // Текст отдаётся КАК ЕСТЬ: `char_span` цитат измеряется именно в нём
      // (`offset_convention = 'utf16-code-unit'`), и любая подчистка на чтении
      // сдвинула бы все доказательства разом.
      text: row.textMd ?? '',
      blockTypes: (row.blockTypes ?? []) as readonly SegmentationBlockType[],
      rotation: Number(row.rotation),
      manual:
        row.manualLabel === null
          ? null
          : {
              label: row.manualLabel as PageLabel,
              docTypeCode: row.manualDocTypeCode,
              pageRoleCode: row.manualPageRoleCode,
            },
    })),
  };
}

/** Страница документа в том виде, в каком её читает извлечение реквизитов. */
export interface DocumentPageText {
  readonly pageTextVersionId: string | null;
  readonly text: string;
}

/**
 * Текст страниц ОДНОГО документа (S44).
 *
 * Появилась вместе с веером `doc.extract_document`. До S44 извлечение читало
 * `loadSegmentationPages` однажды на всю папку и раздавало текст документам из
 * памяти; после дробления на задачу по документу тот же вызов означал бы 134
 * полных чтения папки — с составом блоков, ручной разметкой и координатами,
 * которые извлечению не нужны вовсе.
 *
 * Прогон выбирается ТЕМ ЖЕ правилом, что в `loadSegmentationPages`: последний
 * завершённый и опубликовавший хотя бы одну версию текста. Разойдясь, два
 * правила дали бы `char_span` реквизита, измеренный в одной версии текста, и
 * цитату — в другой.
 *
 * Порядок страниц — порядок в документе (`page_assignments.sort_order`), а не
 * порядок в папке: реквизиты читаются по документу, и его первая страница — та,
 * которую человек видит первой, открыв документ.
 */
export async function loadDocumentPageText(
  db: Database,
  scope: AuthScope,
  folderId: string,
  documentId: string,
): Promise<readonly DocumentPageText[]> {
  await requireVisibleFolder(db, scope, folderId);

  const rows = await db.execute<{
    page_text_version_id: string | null;
    text_md: string | null;
  }>(sql`
    with run as (
      select r.id
        from recognition_runs r
       where r.folder_id = ${folderId}::uuid
         and r.status = 'done'
         and exists (select 1 from page_text_versions ptv where ptv.recognition_run_id = r.id)
       order by r.finished_at desc nulls last
       limit 1
    )
    select ptv.id as page_text_version_id, ptv.text_md as text_md
      from page_assignments pa
      join source_pages sp on sp.id = pa.source_page_id
      left join page_text_versions ptv
        on ptv.source_page_id = sp.id
       and ptv.recognition_run_id = (select id from run)
     where pa.folder_id = ${folderId}::uuid
       and pa.document_id = ${documentId}::uuid
     order by pa.sort_order asc nulls last, sp.folder_ordinal asc
  `);

  return rows.rows.map((row) => ({
    pageTextVersionId: row.page_text_version_id,
    // Текст отдаётся КАК ЕСТЬ по той же причине, что в `loadSegmentationPages`:
    // `char_span` цитат измеряется именно в нём.
    text: row.text_md ?? '',
  }));
}

// =====================================================================
// Применение сегментации (задача 15) — центральная функция этапа
// =====================================================================

export interface ApplySegmentationInput {
  readonly folderId: string;
  readonly documents: readonly DecodedDocument[];
  readonly unassigned: readonly DecodedUnassigned[];
  /** Версия декодера: уходит в событие ревизии, чтобы прогон был объясним. */
  readonly extractorVersion: string;
}

export interface ApplySegmentationOutcome {
  readonly documentsCreated: number;
  /**
   * Сколько документов прошлой сборки удалено.
   *
   * Отдельно от `documentsCreated`, потому что «собрано 12 документов на
   * пустой ревизии» и «собрано 12 документов вместо прежних 12» — разные
   * события: второе уничтожило предыдущую сборку, и вызывающий обязан это
   * видеть, а не выводить из совпадения чисел.
   */
  readonly documentsReplaced: number;
  readonly pagesAssigned: number;
  readonly pagesUnassigned: number;
  /** Сколько строк реестра потеряли привязку: их документы переписаны. */
  readonly registryRowsUnlinked: number;
  readonly documentIds: readonly string[];
}

/**
 * Пересегментация ревизии ОДНОЙ транзакцией.
 *
 * Порядок операций не переставляется, и каждый шаг существует по своей причине:
 *
 * 1. **Обнуление `registry_rows.matched_document_id`.** У этого FK нет каскада
 *    намеренно (0005): строка реестра — самостоятельный факт поставки, и
 *    удаление документов не имеет права её уносить. Значит привязку обязан снять
 *    вызывающий, иначе `DELETE` документов упадёт на ссылке. Вместе с
 *    идентификатором снимается и `match_state`: `matched` без документа
 *    запрещён `registry_rows_matched_chk`, а «совпало с неизвестно чем» —
 *    худший вид ложного факта.
 * 2. **Удаление учёта страниц.** Явное, а не каскадом от документов: каскад
 *    уносит только привязанные строки, а непривязанные (`document_id IS NULL`)
 *    остались бы от прошлой сегментации и столкнулись бы с новыми по
 *    `page_assignments_page_uq`.
 * 3. **Удаление документов** — вместе с ними каскадом уходят `field_values` и
 *    `document_relations` прошлой сборки.
 * 4. **Вставка документов и учёта страниц**, включая ЯВНЫЕ строки для
 *    непривязанных: отсутствие строки не отличить от потерянной страницы.
 * 5. **Проверка `v_unaccounted_pages` В ТОЙ ЖЕ ТРАНЗАКЦИИ.** Ненулевой
 *    результат откатывает всё: half-applied сегментация хуже отказа, потому что
 *    выглядит выполненной.
 *
 * ## Подтверждённый документ переписан быть не может
 *
 * Шаг 0, идущий раньше всех остальных, — отказ при наличии документов с
 * `is_confirmed`. Охранник стоит ЗДЕСЬ, а не только в обработчике задачи 15,
 * потому что уничтожает работу человека именно `DELETE FROM logical_documents`
 * ниже, а не обработчик: проверка у одного из вызывающих защищает ровно этого
 * вызывающего, и второй снял бы подтверждение молча. §8.2 объявляет ручную
 * разметку приоритетной, и приоритет обязан держать тот слой, который
 * физически способен её стереть.
 *
 * Проверка идёт ВНУТРИ транзакции и до удаления: между чтением снаружи и
 * записью помещается подтверждение второго проверяющего. Третий рубеж —
 * триггер `logical_documents_confirmed_lock` (0016): он запрещает удаление
 * подтверждённой строки любым запросом, включая прямой SQL.
 */
export async function applySegmentation(
  db: Database,
  scope: AuthScope,
  input: ApplySegmentationInput,
): Promise<ApplySegmentationOutcome> {
  const folder = await requireVisibleFolder(db, scope, input.folderId);

  return guardWrites(() =>
    db.transaction(async (tx) => {
      // Шаг 0. Подтверждение — решение человека, и пересегментация его не
      // отменяет. Счёт возвращается в тексте отказа: «переписала бы 3 из 12»
      // говорит инженеру, что именно он потеряет, а «нельзя» — не говорит.
      //
      // Смотрим на `confirmation_source`, а не на один `is_confirmed` (S27):
      // границы, собранные конвейером, он же и подтверждает — иначе не поедет
      // нарезка, — и запрещать пересборку собственной работы значило бы
      // запретить её вообще после первого же прогона. Запирает только решение
      // человека; тот же фильтр стоит в триггере `logical_documents_confirmed_lock`.
      const confirmed = await tx
        .select({ id: logicalDocuments.id, ordinal: logicalDocuments.ordinal })
        .from(logicalDocuments)
        .where(
          and(
            eq(logicalDocuments.folderId, input.folderId),
            eq(logicalDocuments.isConfirmed, true),
            eq(logicalDocuments.confirmationSource, 'human'),
          ),
        );
      if (confirmed.length > 0) {
        throw conflict(
          `Ревизия содержит ${confirmed.length} подтверждённых человеком документов: ` +
            'пересегментация переписала бы их. Снимите подтверждение явным действием.',
          {
            logDetail:
              `applySegmentation отклонена: подтверждённых документов ${confirmed.length} ` +
              `в ревизии ${input.folderId}`,
          },
        );
      }

      const unlinked = await tx
        .update(registryRows)
        .set({ matchedDocumentId: null, matchScore: null, matchState: 'missing' })
        .where(
          and(eq(registryRows.folderId, input.folderId), isNotNull(registryRows.matchedDocumentId)),
        )
        .returning({ id: registryRows.id });

      await tx.delete(pageAssignments).where(eq(pageAssignments.folderId, input.folderId));
      const removed = await tx
        .delete(logicalDocuments)
        .where(eq(logicalDocuments.folderId, input.folderId))
        .returning({ id: logicalDocuments.id });

      // Комплекты снимаются ПОСЛЕ документов: `logical_documents.complect_id`
      // ссылается на них составным ключом, и обратный порядок отверг бы
      // удаление внешним ключом посреди транзакции.
      await tx.delete(complects).where(eq(complects.folderId, input.folderId));

      // Нарезка на комплекты — по тому же правилу «ближайший предшествующий
      // акт», которым `graph.build` связывает акт с его перечнем приложений.
      const plan = planComplects(
        input.documents.map((document) => ({
          ordinal: document.ordinal,
          docTypeCode: document.docTypeCode,
        })),
      );
      const complectByDocument = new Map<number, string>();
      for (const group of plan.groups) {
        const insertedComplect = await tx
          .insert(complects)
          .values({
            folderId: input.folderId,
            objectId: folder.objectId,
            contractorId: folder.contractorId,
            ordinal: group.ordinal,
          })
          .returning({ id: complects.id });
        const complectId = insertedComplect[0]?.id;
        if (complectId === undefined) {
          throw internal({ logDetail: 'INSERT комплекта не вернул строку' });
        }
        for (const documentOrdinal of group.documentOrdinals) {
          complectByDocument.set(documentOrdinal, complectId);
        }
      }

      const documentIds: string[] = [];
      let pagesAssigned = 0;
      for (const document of input.documents) {
        const inserted = await tx
          .insert(logicalDocuments)
          .values({
            folderId: input.folderId,
            objectId: folder.objectId,
            contractorId: folder.contractorId,
            docTypeCode: document.docTypeCode,
            ordinal: document.ordinal,
            title: document.title,
            typeConfidence: document.typeConfidence,
            boundaryConfidence: document.boundaryConfidence,
            needsReview: document.needsReview,
            // `null` — документ вне комплектов (опись, титул, всё до первого
            // акта). Составной ключ при `MATCH SIMPLE` такую строку не
            // проверяет, и это ровно тот случай, ради которого колонка
            // необязательна.
            complectId: complectByDocument.get(document.ordinal) ?? null,
          })
          .returning({ id: logicalDocuments.id });
        const documentId = inserted[0]?.id;
        if (documentId === undefined) {
          throw internal({ logDetail: 'INSERT логического документа не вернул строку' });
        }
        documentIds.push(documentId);

        for (const page of document.pages) {
          await tx.insert(pageAssignments).values({
            folderId: input.folderId,
            sourcePageId: page.sourcePageId,
            documentId,
            sortOrder: page.sortOrder,
            pageRoleCode: page.pageRoleCode,
            needsReview: document.needsReview,
          });
          pagesAssigned += 1;
        }
      }

      let pagesUnassigned = 0;
      for (const page of input.unassigned) {
        await tx.insert(pageAssignments).values({
          folderId: input.folderId,
          sourcePageId: page.sourcePageId,
          // Причина обязательна: `page_assignments_state_chk` не примет строку
          // без неё, и это верно — «не привязана почему-то» бесполезно на экране.
          reason: page.reason,
          needsReview: page.needsReview,
        });
        pagesUnassigned += 1;
      }

      // Границы, собранные конвейером, подтверждает конвейер (S27).
      //
      // Прежде подтверждение было ручным шагом §12 между сегментацией и
      // нарезкой. На практике шаг оказался тупиком: подтверждённый документ
      // запрещает пересегментацию, а маршрута снятия в портале не было — один
      // клик закрывал повторную обработку комплекта навсегда. Заказчик отменил
      // сам шаг: «не нужно ничего собирать, документ уже есть — это загруженный
      // комплект».
      //
      // Отметка обязательна, а не косметична: и `logical_documents_derived_
      // confirmed_chk`, и веер `doc.materialize_pdf` требуют `is_confirmed`, и
      // без неё нарезка не поехала бы никогда.
      //
      // ОТДЕЛЬНЫМ оператором, а не полем в `.values()` выше: `confirmation_
      // source` относится не к содержимому документа, а к тому, кто решил, что
      // границы верны, — и читается на месте, где это сказано словами. Умолчание
      // колонки — `'human'` (намеренно строгое), поэтому значение ставится явно.
      await tx
        .update(logicalDocuments)
        .set({
          isConfirmed: true,
          confirmationSource: 'machine',
          confirmedBy: null,
          confirmedAt: sql`now()`,
        })
        .where(eq(logicalDocuments.folderId, input.folderId));

      // НЕ ДЕГРАДИРУЕМЫЙ РУБЕЖ §1.6. Проверка идёт по представлению и внутри
      // транзакции: за её пределами это было бы наблюдением за уже сохранённой
      // потерей страницы.
      const unaccounted = await tx
        .select({ sourcePageId: vUnaccountedPages.sourcePageId })
        .from(vUnaccountedPages)
        .where(eq(vUnaccountedPages.folderId, input.folderId));
      if (unaccounted.length > 0) {
        throw conflict(
          `Сегментация не учла ${unaccounted.length} страниц(ы) ревизии: ` +
            'каждая страница обязана быть либо в документе, либо в непривязанных. ' +
            'Изменения отменены.',
          {
            logDetail:
              `v_unaccounted_pages вернул ${unaccounted.length} строк(и) после применения ` +
              `сегментации ревизии ${input.folderId}`,
          },
        );
      }

      await appendFolderEvent(tx, {
        folderId: input.folderId,
        eventType: 'documents.segmented',
        payload: {
          documentsCreated: documentIds.length,
          documentsReplaced: removed.length,
          pagesAssigned,
          pagesUnassigned,
          registryRowsUnlinked: unlinked.length,
          extractorVersion: input.extractorVersion,
        },
      });

      return {
        documentsCreated: documentIds.length,
        documentsReplaced: removed.length,
        pagesAssigned,
        pagesUnassigned,
        registryRowsUnlinked: unlinked.length,
        documentIds,
      };
    }),
  );
}

// =====================================================================
// Чтение документов и учёта страниц
// =====================================================================

export interface LogicalDocumentView {
  readonly id: string;
  readonly folderId: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly docTypeCode: string | null;
  readonly ordinal: number;
  readonly title: string | null;
  /** Комплект (акт со своими приложениями); `null` — документ вне комплектов. */
  readonly complectId: string | null;
  readonly typeConfidence: number | null;
  readonly boundaryConfidence: number | null;
  readonly needsReview: boolean;
  readonly isConfirmed: boolean;
  /**
   * Кто подтвердил границы: конвейер или человек.
   *
   * Отдельно от `confirmedBy`, потому что читается предикатом, а не для показа:
   * пересегментацию, удаление документа и удаление файла запирает только
   * `'human'`. Признак, выводимый из отсутствия автора, забыл бы первый же
   * новый вызывающий.
   */
  readonly confirmationSource: 'human' | 'machine';
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  readonly version: number;
  readonly pageCount: number;
}

const DOCUMENT_SELECTION = {
  id: logicalDocuments.id,
  folderId: logicalDocuments.folderId,
  objectId: logicalDocuments.objectId,
  contractorId: logicalDocuments.contractorId,
  docTypeCode: logicalDocuments.docTypeCode,
  ordinal: logicalDocuments.ordinal,
  title: logicalDocuments.title,
  complectId: logicalDocuments.complectId,
  typeConfidence: logicalDocuments.typeConfidence,
  boundaryConfidence: logicalDocuments.boundaryConfidence,
  needsReview: logicalDocuments.needsReview,
  isConfirmed: logicalDocuments.isConfirmed,
  confirmationSource: logicalDocuments.confirmationSource,
  confirmedBy: logicalDocuments.confirmedBy,
  confirmedAt: isoAt(logicalDocuments.confirmedAt, 'confirmed_at_iso'),
  version: logicalDocuments.version,
  pageCount: sql<number>`(
    select count(*) from ${pageAssignments} a where a.document_id = ${logicalDocuments.id}
  )`.as('page_count'),
};

function documentQuery(db: ReadExecutor, scope: AuthScope, ...conditions: SQL[]) {
  return db
    .select(DOCUMENT_SELECTION)
    .from(logicalDocuments)
    .innerJoin(folders, eq(logicalDocuments.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, ...conditions));
}

function toDocumentView(row: Record<string, unknown>): LogicalDocumentView {
  return {
    ...(row as unknown as LogicalDocumentView),
    pageCount: Number(row.pageCount ?? 0),
  };
}

export async function listLogicalDocuments(
  db: ReadExecutor,
  scope: AuthScope,
  folderId: string,
): Promise<readonly LogicalDocumentView[]> {
  const rows = await documentQuery(db, scope, eq(logicalDocuments.folderId, folderId)).orderBy(
    asc(logicalDocuments.ordinal),
  );
  return rows.map(toDocumentView);
}

export async function findLogicalDocument(
  db: Database,
  scope: AuthScope,
  documentId: string,
): Promise<LogicalDocumentView | null> {
  const rows = await documentQuery(db, scope, eq(logicalDocuments.id, documentId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toDocumentView(row);
}

/**
 * Потолок межревизионного чтения.
 *
 * Папка из двухсот комплектов — уже не папка, а признак того, что вызывающий
 * собрал список не оттуда. Потолок здесь ради предсказуемого запроса, а не
 * ради защиты: превышение обязано быть названо вслух вызывающим, поэтому
 * функция не режет молча, а бросает.
 */
export const MAX_FOLDERS_PER_READ = 200;

/**
 * Документы НЕСКОЛЬКИХ ревизий сразу — первое в проекте чтение через границу
 * ревизии.
 *
 * До S20 каждый запрос к `logical_documents` фильтровался либо по одной
 * ревизии, либо по конкретному документу. Сверка описи спрашивает иначе: опись
 * описывает всю папку, и сравнивать её надо со всеми комплектами сразу.
 * Поэтому область здесь обязательна и применяется тем же `withScope` по
 * `folders`: расширение вопроса не расширяет прав.
 *
 * Пустой список — ранний выход, а не запрос: `inArray` с пустым массивом в
 * ряде построителей вырождается в условие, которое ничего не ограничивает.
 */
export async function listDocumentsOfFolders(
  db: Database,
  scope: AuthScope,
  folderIds: readonly string[],
): Promise<readonly LogicalDocumentView[]> {
  if (folderIds.length === 0) return [];
  if (folderIds.length > MAX_FOLDERS_PER_READ) {
    throw internal({
      logDetail: `запрошены документы ${folderIds.length} ревизий при потолке ${MAX_FOLDERS_PER_READ}`,
    });
  }

  const rows = await documentQuery(
    db,
    scope,
    inArray(logicalDocuments.folderId, [...folderIds]),
  ).orderBy(asc(logicalDocuments.folderId), asc(logicalDocuments.ordinal));

  return rows.map(toDocumentView);
}

/** Реквизит документа в межревизионном чтении: только то, что нужно сверке. */
export interface DocumentFieldValue {
  readonly documentId: string;
  readonly folderId: string;
  readonly fieldCode: string;
  readonly valueText: string | null;
  readonly valueDate: string | null;
}

/**
 * Реквизиты документов нескольких ревизий ОДНИМ запросом.
 *
 * Существующая `listFieldValues` читает один документ, и `doc.match_registry`
 * из-за этого выполняет запрос на каждый документ ревизии. Внутри одной
 * ревизии это терпимо, на папке из семи комплектов по три десятка документов —
 * уже сотни round-trip'ов на одну сверку. Форма ответа плоская намеренно:
 * вызывающий раскладывает её по документам сам, а группировка в SQL заставила
 * бы читать `jsonb` там, где нужен один `text`.
 */
export async function listFieldValuesOfFolders(
  db: ReadExecutor,
  scope: AuthScope,
  folderIds: readonly string[],
  fieldCodes: readonly string[],
): Promise<readonly DocumentFieldValue[]> {
  if (folderIds.length === 0 || fieldCodes.length === 0) return [];
  if (folderIds.length > MAX_FOLDERS_PER_READ) {
    throw internal({
      logDetail: `запрошены реквизиты ${folderIds.length} ревизий при потолке ${MAX_FOLDERS_PER_READ}`,
    });
  }

  return db
    .select({
      documentId: fieldValues.documentId,
      folderId: fieldValues.folderId,
      fieldCode: fieldValues.fieldCode,
      valueText: fieldValues.valueText,
      valueDate: fieldValues.valueDate,
    })
    .from(fieldValues)
    .innerJoin(folders, eq(fieldValues.folderId, folders.id))
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        inArray(fieldValues.folderId, [...folderIds]),
        inArray(fieldValues.fieldCode, [...fieldCodes]),
      ),
    );
}

export interface PageAssignmentView {
  readonly sourcePageId: string;
  readonly folderOrdinal: number;
  readonly documentId: string | null;
  readonly sortOrder: number | null;
  readonly pageRoleCode: PageRoleCode | null;
  readonly reason: string | null;
  readonly needsReview: boolean;
}

/** Учёт страниц ревизии: и привязанные, и явно непривязанные — одним списком. */
export async function listPageAssignments(
  db: ReadExecutor,
  scope: AuthScope,
  folderId: string,
): Promise<readonly PageAssignmentView[]> {
  const rows = await db
    .select({
      sourcePageId: pageAssignments.sourcePageId,
      folderOrdinal: sourcePages.folderOrdinal,
      documentId: pageAssignments.documentId,
      sortOrder: pageAssignments.sortOrder,
      pageRoleCode: pageAssignments.pageRoleCode,
      reason: pageAssignments.reason,
      needsReview: pageAssignments.needsReview,
    })
    .from(pageAssignments)
    .innerJoin(
      sourcePages,
      and(
        eq(sourcePages.id, pageAssignments.sourcePageId),
        eq(sourcePages.folderId, pageAssignments.folderId),
      ),
    )
    .innerJoin(folders, eq(pageAssignments.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(pageAssignments.folderId, folderId)))
    .orderBy(asc(sourcePages.folderOrdinal));

  return rows.map((row) => ({ ...row, pageRoleCode: row.pageRoleCode as PageRoleCode | null }));
}

export interface UnaccountedPageView {
  readonly sourcePageId: string;
  readonly sourceFileId: string;
  readonly folderOrdinal: number;
}

/**
 * Неучтённые страницы ревизии — чтение представления.
 *
 * Список обязан быть пуст. Он отдаётся наружу именно поэтому: непустой набор —
 * это ВИДИМЫЙ сигнал нарушения §16, а не тишина. Экран, который просто не
 * показывает потерянные страницы, делает потерю ненаблюдаемой.
 */
export async function listUnaccountedPages(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<readonly UnaccountedPageView[]> {
  const rows = await db
    .select({
      sourcePageId: vUnaccountedPages.sourcePageId,
      sourceFileId: vUnaccountedPages.sourceFileId,
      folderOrdinal: vUnaccountedPages.folderOrdinal,
    })
    .from(vUnaccountedPages)
    .innerJoin(folders, eq(vUnaccountedPages.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(vUnaccountedPages.folderId, folderId)))
    .orderBy(asc(vUnaccountedPages.folderOrdinal));

  return rows.map((row) => ({
    sourcePageId: row.sourcePageId ?? '',
    sourceFileId: row.sourceFileId ?? '',
    folderOrdinal: Number(row.folderOrdinal ?? 0),
  }));
}

// =====================================================================
// Реквизиты (задача 16)
// =====================================================================

export interface FieldValueView {
  readonly id: string;
  readonly documentId: string;
  readonly fieldCode: string;
  readonly valueText: string | null;
  readonly valueDate: string | null;
  readonly valueNum: string | null;
  readonly valueJson: unknown;
  readonly confidence: number | null;
  readonly isVerified: boolean;
  readonly extractorVersion: string;
  readonly pageTextVersionId: string | null;
  readonly charSpan: { readonly start: number; readonly end: number } | null;
  readonly quote: string | null;
  readonly extractedBy: 'rule' | 'llm' | 'manual';
}

export interface SaveFieldValuesInput {
  readonly folderId: string;
  readonly documentId: string;
  readonly fields: readonly ExtractedField[];
  readonly extractorVersion: string;
}

export interface SaveFieldValuesOutcome {
  readonly removed: number;
  readonly written: number;
  /** Сколько проверенных ручных значений повтор НЕ тронул. */
  readonly preservedManual: number;
}

/**
 * Замена значений документа по версии экстрактора.
 *
 * ## Что здесь неприкосновенно
 *
 * Значение с `extracted_by = 'manual'` и `is_verified` — это работа инженера:
 * он открыл документ, прочитал номер сертификата и исправил распознанное.
 * Повторный прогон извлечения, стирающий такую строку, — тот же класс отказа,
 * что импорт блоков на S6, который «успешно» уносил 124 блока разметки. Отсюда
 * условие `NOT (extracted_by = 'manual' AND is_verified)` в `DELETE`, и отсюда
 * же счётчик `preservedManual`: сохранённое обязано быть видно, иначе «ничего
 * не сохранили» и «сохранять было нечего» неразличимы.
 *
 * ## Почему замена по версии, а не полная
 *
 * `field_values` не имеет UNIQUE по `(document_id, field_code)` намеренно
 * (0005): детерминированный экстрактор и LLM могут предложить значение одного и
 * того же реквизита, и выбор фиксируется `is_verified`. Полная замена уничтожала
 * бы вторую гипотезу при перезапуске первой.
 */
export async function saveFieldValues(
  db: Database,
  scope: AuthScope,
  input: SaveFieldValuesInput,
): Promise<SaveFieldValuesOutcome> {
  await requireVisibleFolder(db, scope, input.folderId);
  const document = await findLogicalDocument(db, scope, input.documentId);
  if (document === null || document.folderId !== input.folderId) {
    throw notFound('Логический документ не найден.');
  }

  return guardWrites(() =>
    db.transaction(async (tx) => {
      /**
       * Замок строки документа — первым действием транзакции.
       *
       * `DELETE` + `INSERT` ниже идемпотентны по отдельности, но от КОНКУРЕНТА
       * не защищены: в READ COMMITTED две перекрывающиеся попытки удаляют
       * каждая то, что видит, и вставляют своё — итог тройные копии реквизитов
       * одного документа. Ровно это и наблюдалось на боевом прогоне, где
       * сторож оборвал попытку по аренде, а обход документов продолжился.
       *
       * Отмена (`ctx.signal`) перекрытие сокращает, но не исключает:
       * кооперативный сигнал доходит между шагами, а транзакция уже начата.
       * Поэтому писателей сериализует БД, а не договорённость.
       */
      await tx.execute(sql`select id from logical_documents where id = ${input.documentId}::uuid
                            for update`);

      const preserved = await tx
        .select({ id: fieldValues.id })
        .from(fieldValues)
        .where(
          and(
            eq(fieldValues.documentId, input.documentId),
            eq(fieldValues.extractorVersion, input.extractorVersion),
            eq(fieldValues.extractedBy, 'manual'),
            eq(fieldValues.isVerified, true),
          ),
        );

      const removed = await tx
        .delete(fieldValues)
        .where(
          and(
            eq(fieldValues.documentId, input.documentId),
            eq(fieldValues.extractorVersion, input.extractorVersion),
            sql`not (${fieldValues.extractedBy} = 'manual' and ${fieldValues.isVerified})`,
          ),
        )
        .returning({ id: fieldValues.id });

      let written = 0;
      for (const field of input.fields) {
        await tx.insert(fieldValues).values({
          folderId: input.folderId,
          documentId: input.documentId,
          fieldCode: field.fieldCode,
          valueText: field.valueText,
          valueDate: field.valueDate,
          valueNum: field.valueNum,
          valueJson: field.valueJson ?? null,
          confidence: field.confidence,
          extractorVersion: input.extractorVersion,
          pageTextVersionId: field.evidence?.pageTextVersionId ?? null,
          charSpan:
            field.evidence === null
              ? null
              : { start: field.evidence.charStart, end: field.evidence.charEnd },
          quote: field.evidence?.quote ?? null,
          extractedBy: field.extractedBy,
        });
        written += 1;
      }

      return { removed: removed.length, written, preservedManual: preserved.length };
    }),
  );
}

export async function listFieldValues(
  db: Database,
  scope: AuthScope,
  documentId: string,
): Promise<readonly FieldValueView[]> {
  const rows = await db
    .select({
      id: fieldValues.id,
      documentId: fieldValues.documentId,
      fieldCode: fieldValues.fieldCode,
      valueText: fieldValues.valueText,
      valueDate: fieldValues.valueDate,
      valueNum: fieldValues.valueNum,
      valueJson: fieldValues.valueJson,
      confidence: fieldValues.confidence,
      isVerified: fieldValues.isVerified,
      extractorVersion: fieldValues.extractorVersion,
      pageTextVersionId: fieldValues.pageTextVersionId,
      charSpan: fieldValues.charSpan,
      quote: fieldValues.quote,
      extractedBy: fieldValues.extractedBy,
    })
    .from(fieldValues)
    .innerJoin(folders, eq(fieldValues.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(fieldValues.documentId, documentId)))
    .orderBy(asc(fieldValues.fieldCode));

  return rows.map((row) => ({
    ...row,
    charSpan: row.charSpan === null ? null : { start: row.charSpan.start, end: row.charSpan.end },
    extractedBy: row.extractedBy as 'rule' | 'llm' | 'manual',
  }));
}

// =====================================================================
// Реестр приложений (задачи 17 и 18)
// =====================================================================

export interface RegistryRowView {
  readonly id: string;
  readonly folderId: string;
  readonly documentId: string;
  /** Сквозной порядок строки в реестре (миграция 0015). */
  readonly ordinal: number;
  /** Номер, НАПЕЧАТАННЫЙ в реестре: уникальным быть не обязан. */
  readonly rowNo: number;
  readonly sectionTitle: string | null;
  readonly docNameRaw: string;
  readonly docNoRaw: string | null;
  readonly orgRaw: string | null;
  readonly docNoNorm: string | null;
  readonly docNoFolded: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly issuedAt: string | null;
  readonly matchedDocumentId: string | null;
  readonly matchScore: number | null;
  readonly matchState: MatchState;
  /**
   * Документы, похожие на строку, но номером не подтверждённые.
   *
   * Отдаются вместе со строкой, а не отдельным запросом: их читают и правило
   * «документ не назван реестром», и отчёт, и разойтись в том, кого считать
   * названным, они не вправе.
   */
  readonly candidateDocumentIds: readonly string[];
}

export interface SaveRegistryRowsInput {
  readonly folderId: string;
  readonly documentId: string;
  readonly rows: readonly ParsedRegistryRow[];
}

/**
 * Замена строк реестра приложений одного документа-реестра.
 *
 * По документу, а не по ревизии: реестров в поставке бывает несколько (по
 * одному на акт), и перезапуск разбора одного не имеет права уносить строки
 * соседнего. `registry_rows_row_uq (document_id, row_no)` при этом делает
 * повторную вставку того же номера отказом, поэтому замена идёт через DELETE.
 */
export async function saveRegistryRows(
  db: Database,
  scope: AuthScope,
  input: SaveRegistryRowsInput,
): Promise<{ readonly removed: number; readonly written: number }> {
  await requireVisibleFolder(db, scope, input.folderId);
  const document = await findLogicalDocument(db, scope, input.documentId);
  if (document === null || document.folderId !== input.folderId) {
    throw notFound('Документ-реестр не найден.');
  }

  return guardWrites(() =>
    db.transaction(async (tx) => {
      const removed = await tx
        .delete(registryRows)
        .where(eq(registryRows.documentId, input.documentId))
        .returning({ id: registryRows.id });

      let written = 0;
      for (const [index, row] of input.rows.entries()) {
        await tx.insert(registryRows).values({
          folderId: input.folderId,
          documentId: input.documentId,
          // Сквозной порядок строки, а не напечатанный номер: подрядчик
          // нумерует каждый раздел реестра с единицы (миграция 0015), поэтому
          // ключом может быть только положение в разобранном наборе. Позиция
          // берётся из ПОРЯДКА входа, а не из `rowNo`: иначе два раздела с
          // одинаковой нумерацией дали бы одинаковый ordinal и упёрлись в тот
          // же уникальный индекс, ради обхода которого он и заведён.
          ordinal: index,
          rowNo: row.rowNo,
          sectionTitle: row.sectionTitle,
          docNameRaw: row.docNameRaw,
          docNoRaw: row.docNoRaw,
          orgRaw: row.orgRaw,
          docNoNorm: row.docNoNorm,
          docNoFolded: row.docNoFolded,
          validFrom: row.validFrom,
          validTo: row.validTo,
          issuedAt: row.issuedAt,
        });
        written += 1;
      }
      return { removed: removed.length, written };
    }),
  );
}

export interface RegistryMatch {
  readonly registryRowId: string;
  readonly matchedDocumentId: string | null;
  readonly matchScore: number | null;
  readonly matchState: MatchState;
  /**
   * Похожие документы у строки в состоянии `candidate`.
   *
   * Пишутся вместе с решением и в той же транзакции: кандидат без решения —
   * это утверждение о похожести, оторванное от того, почему номер не ответил.
   */
  readonly candidates: readonly {
    readonly documentId: string;
    readonly basis: string;
    readonly score: number;
  }[];
}

/**
 * Проставление результата сверки реестра с комплектом (задача 18).
 *
 * `matched` без документа отвергается БД (`registry_rows_matched_chk`), и это
 * не формальность: §8.3 требует, чтобы совпадение только по `folded` при
 * коллизии давало `ambiguous`, а не `matched`. Если бы «совпало, но неизвестно
 * с чем» записывалось, различить два случая было бы нечем.
 *
 * Область применяется к КАЖДОЙ строке через ревизию: чужую строку реестра
 * обновить нельзя, даже зная её идентификатор.
 */
export async function saveRegistryMatches(
  db: Database,
  scope: AuthScope,
  input: { readonly folderId: string; readonly matches: readonly RegistryMatch[] },
): Promise<{ readonly updated: number; readonly skipped: number }> {
  await requireVisibleFolder(db, scope, input.folderId);

  const known = new Set(
    (
      await db
        .select({ id: registryRows.id })
        .from(registryRows)
        .innerJoin(folders, eq(registryRows.folderId, folders.id))
        .where(withScope(scope, FOLDER_SCOPE, eq(registryRows.folderId, input.folderId)))
    ).map((row) => row.id),
  );

  return guardWrites(() =>
    db.transaction(async (tx) => {
      let updated = 0;
      let skipped = 0;
      for (const match of input.matches) {
        if (!known.has(match.registryRowId)) {
          // Строка не из этой ревизии (или не видна): пропуск считается, а не
          // молчится — иначе «сверка ничего не нашла» станет неотличимо от
          // «сверке подсунули чужие идентификаторы».
          skipped += 1;
          continue;
        }
        const changed = await tx
          .update(registryRows)
          .set({
            matchedDocumentId: match.matchedDocumentId,
            matchScore: match.matchScore,
            matchState: match.matchState,
          })
          .where(eq(registryRows.id, match.registryRowId))
          .returning({ id: registryRows.id });
        if (changed.length > 0) updated += 1;
        else skipped += 1;

        // Кандидаты переписываются целиком: повторный прогон сверки обязан
        // отменять прежнее «похоже на этот документ», а не копить его.
        await tx
          .delete(registryRowCandidates)
          .where(eq(registryRowCandidates.registryRowId, match.registryRowId));
        if (match.candidates.length > 0) {
          await tx.insert(registryRowCandidates).values(
            match.candidates.map((candidate) => ({
              folderId: input.folderId,
              registryRowId: match.registryRowId,
              documentId: candidate.documentId,
              basis: candidate.basis,
              score: candidate.score,
            })),
          );
        }
      }
      return { updated, skipped };
    }),
  );
}

export async function listRegistryRows(
  db: ReadExecutor,
  scope: AuthScope,
  folderId: string,
): Promise<readonly RegistryRowView[]> {
  const rows = await db
    .select({
      id: registryRows.id,
      folderId: registryRows.folderId,
      documentId: registryRows.documentId,
      ordinal: registryRows.ordinal,
      rowNo: registryRows.rowNo,
      sectionTitle: registryRows.sectionTitle,
      docNameRaw: registryRows.docNameRaw,
      docNoRaw: registryRows.docNoRaw,
      orgRaw: registryRows.orgRaw,
      docNoNorm: registryRows.docNoNorm,
      docNoFolded: registryRows.docNoFolded,
      validFrom: registryRows.validFrom,
      validTo: registryRows.validTo,
      issuedAt: registryRows.issuedAt,
      matchedDocumentId: registryRows.matchedDocumentId,
      matchScore: registryRows.matchScore,
      matchState: registryRows.matchState,
    })
    .from(registryRows)
    .innerJoin(folders, eq(registryRows.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(registryRows.folderId, folderId)))
    // Сортировка по сквозному порядку, а не по напечатанному номеру: разделы
    // реестра нумеруются с единицы каждый, и `rowNo` перемешал бы их между
    // собой (миграция 0015).
    .orderBy(asc(registryRows.documentId), asc(registryRows.ordinal));

  const candidates = await db
    .select({
      registryRowId: registryRowCandidates.registryRowId,
      documentId: registryRowCandidates.documentId,
      score: registryRowCandidates.score,
    })
    .from(registryRowCandidates)
    .where(eq(registryRowCandidates.folderId, folderId))
    // По убыванию силы основания: первый кандидат — самый вероятный.
    .orderBy(desc(registryRowCandidates.score));

  const byRow = new Map<string, string[]>();
  for (const candidate of candidates) {
    const bucket = byRow.get(candidate.registryRowId);
    if (bucket === undefined) byRow.set(candidate.registryRowId, [candidate.documentId]);
    else bucket.push(candidate.documentId);
  }

  return rows.map((row) => ({
    ...row,
    matchState: row.matchState as MatchState,
    candidateDocumentIds: byRow.get(row.id) ?? [],
  }));
}

// =====================================================================
// Граф документов (задача 19)
// =====================================================================

export interface DocumentRelationInput {
  readonly parentDocumentId: string;
  readonly childDocumentId: string;
  readonly relation: DocumentRelation;
}

/**
 * Полная пересборка графа связей ревизии.
 *
 * Замена, а не добавление: граф выводится из текущего состава документов, и
 * связь, оставшаяся от прошлой сборки, указывала бы на документ, которого уже
 * нет, либо утверждала бы то, чего свежий разбор не подтверждает.
 *
 * Связи с документами не этой ревизии отбрасываются со счётчиком: составные FK
 * (0005) отвергли бы их и так, но 500 на этом месте не назвал бы причину.
 */
export async function saveDocumentRelations(
  db: Database,
  scope: AuthScope,
  input: { readonly folderId: string; readonly relations: readonly DocumentRelationInput[] },
): Promise<{ readonly removed: number; readonly written: number; readonly skipped: number }> {
  await requireVisibleFolder(db, scope, input.folderId);

  const known = new Set((await listLogicalDocuments(db, scope, input.folderId)).map((d) => d.id));

  return guardWrites(() =>
    db.transaction(async (tx) => {
      const removed = await tx
        .delete(documentRelations)
        .where(eq(documentRelations.folderId, input.folderId))
        .returning({ relation: documentRelations.relation });

      let written = 0;
      let skipped = 0;
      for (const edge of input.relations) {
        if (
          !known.has(edge.parentDocumentId) ||
          !known.has(edge.childDocumentId) ||
          edge.parentDocumentId === edge.childDocumentId
        ) {
          skipped += 1;
          continue;
        }
        await tx
          .insert(documentRelations)
          .values({
            folderId: input.folderId,
            parentDocumentId: edge.parentDocumentId,
            childDocumentId: edge.childDocumentId,
            relation: edge.relation,
          })
          .onConflictDoNothing();
        written += 1;
      }
      return { removed: removed.length, written, skipped };
    }),
  );
}

export async function listDocumentRelations(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<readonly DocumentRelationInput[]> {
  const rows = await db
    .select({
      parentDocumentId: documentRelations.parentDocumentId,
      childDocumentId: documentRelations.childDocumentId,
      relation: documentRelations.relation,
    })
    .from(documentRelations)
    .innerJoin(folders, eq(documentRelations.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(documentRelations.folderId, folderId)))
    .orderBy(asc(documentRelations.parentDocumentId), asc(documentRelations.childDocumentId));

  return rows.map((row) => ({ ...row, relation: row.relation as DocumentRelation }));
}

// =====================================================================
// Подтверждение документа инженером
// =====================================================================

export interface ConfirmDocumentInput {
  readonly documentId: string;
  readonly actorUserId: string;
  /** Оптимистичная блокировка (§14, `If-Match`). */
  readonly expectedVersion: number;
  readonly docTypeCode?: string | undefined;
  readonly needsReview?: boolean | undefined;
  readonly actor: AuditActor;
}

/**
 * Подтверждение типа и границ документа проверяющим.
 *
 * Запись в `audit_log` идёт ТОЙ ЖЕ транзакцией, что и правка (урок S4): аудит,
 * который может не записаться, бесполезен — при сбое на второй операции
 * остаётся подтверждение без автора. А подтверждение здесь юридически значимо:
 * именно оно переводит предположение конвейера в решение человека, после
 * которого §12 разрешает нарезку документа (задача 22).
 *
 * Версия проверяется в самом `UPDATE` (`where version = $expected`), а не
 * чтением перед записью: между чтением и записью помещается вся правка второго
 * проверяющего.
 */
export async function confirmDocument(
  db: Database,
  scope: AuthScope,
  input: ConfirmDocumentInput,
): Promise<LogicalDocumentView> {
  const document = await findLogicalDocument(db, scope, input.documentId);
  if (document === null) throw notFound('Логический документ не найден.');
  await requireVisibleFolder(db, scope, document.folderId);

  await guardWrites(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(logicalDocuments)
        .set({
          isConfirmed: true,
          // Явно, а не умолчанием колонки: документ мог быть подтверждён
          // конвейером, и без этой строки решение человека осталось бы помечено
          // машинным — то есть перестало бы запирать пересегментацию.
          confirmationSource: 'human',
          confirmedBy: input.actorUserId,
          confirmedAt: sql`now()`,
          updatedAt: sql`now()`,
          version: sql`${logicalDocuments.version} + 1`,
          ...(input.docTypeCode === undefined ? {} : { docTypeCode: input.docTypeCode }),
          // Подтверждение снимает пометку «требуется проверка»: её смысл —
          // «человек ещё не смотрел». Явное значение в запросе перекрывает.
          needsReview: input.needsReview ?? false,
        })
        .where(
          and(
            eq(logicalDocuments.id, input.documentId),
            eq(logicalDocuments.version, input.expectedVersion),
          ),
        )
        .returning({ id: logicalDocuments.id });

      if (updated.length === 0) {
        throw preconditionFailed(
          'Документ изменён другим пользователем: перечитайте карточку и повторите.',
        );
      }

      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'document.confirmed',
        entityType: 'logical_document',
        entityId: input.documentId,
        objectId: document.objectId,
        // Заголовка документа в журнале нет: это фрагмент документа подрядчика,
        // а `entityId` и так ведёт к самой карточке.
        payload: {
          docTypeCode: input.docTypeCode ?? document.docTypeCode,
          needsReview: input.needsReview ?? false,
          previousVersion: input.expectedVersion,
        },
      });

      await appendFolderEvent(tx, {
        folderId: document.folderId,
        eventType: 'documents.confirmed',
        payload: { documentId: input.documentId, docTypeCode: input.docTypeCode ?? null },
      });
    }),
  );

  const fresh = await findLogicalDocument(db, scope, input.documentId);
  if (fresh === null) throw internal({ logDetail: 'документ не читается сразу после записи' });
  return fresh;
}

export interface UnconfirmDocumentInput {
  readonly documentId: string;
  readonly actorUserId: string;
  readonly expectedVersion: number;
  readonly actor: AuditActor;
}

/**
 * Снятие подтверждения границ.
 *
 * ## Почему маршрут существует, хотя кнопки в портале нет
 *
 * Текст отказа пересегментации — «Снимите подтверждение явным действием» — и
 * HINT триггера `logical_documents_confirmed_lock` называли действие, которого
 * в портале не было ни в каком виде. Один вызов `POST …/confirm` (маршрут
 * остаётся, ADR-0014: «убраны кнопки, а не возможности») закрывал повторную
 * обработку комплекта навсегда, и выйти из этого состояния было нечем.
 *
 * ## Нарезка обнуляется вместе с подтверждением
 *
 * Это не уборка «на всякий случай», а требование схемы, и оно записано прямо в
 * миграции 0018: `logical_documents_derived_confirmed_chk` не примет
 * неподтверждённый документ с непустой нарезкой, а
 * `logical_documents_derived_provenance_chk` требует, чтобы весь блок
 * `derived_pdf_*` был либо заполнен целиком, либо пуст целиком. Смысл за
 * ограничением тот же: границы снова под вопросом, а прежний PDF описывает уже
 * не тот документ.
 *
 * Байты нарезки в хранилище не трогаются — это дело `storage.gc`, как и у
 * удаления файла.
 */
export async function unconfirmDocument(
  db: Database,
  scope: AuthScope,
  input: UnconfirmDocumentInput,
): Promise<LogicalDocumentView> {
  const document = await findLogicalDocument(db, scope, input.documentId);
  if (document === null) throw notFound('Логический документ не найден.');
  await requireVisibleFolder(db, scope, document.folderId);

  await guardWrites(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(logicalDocuments)
        .set({
          isConfirmed: false,
          confirmationSource: 'human',
          confirmedBy: null,
          confirmedAt: null,
          derivedPdfBlobSha256: null,
          derivedPdfPageCount: null,
          derivedPdfBytes: null,
          derivedPdfBuiltAt: null,
          derivedPdfToolkit: null,
          derivedNoteApplied: null,
          updatedAt: sql`now()`,
          version: sql`${logicalDocuments.version} + 1`,
        })
        .where(
          and(
            eq(logicalDocuments.id, input.documentId),
            eq(logicalDocuments.version, input.expectedVersion),
          ),
        )
        .returning({ id: logicalDocuments.id });

      if (updated.length === 0) {
        throw preconditionFailed(
          'Документ изменён другим пользователем: перечитайте карточку и повторите.',
        );
      }

      await appendAudit(tx, scope, {
        ...input.actor,
        action: 'document.unconfirmed',
        entityType: 'logical_document',
        entityId: input.documentId,
        objectId: document.objectId,
        payload: {
          previousVersion: input.expectedVersion,
          previousSource: document.confirmationSource,
        },
      });

      await appendFolderEvent(tx, {
        folderId: document.folderId,
        eventType: 'documents.unconfirmed',
        payload: { documentId: input.documentId },
      });
    }),
  );

  const fresh = await findLogicalDocument(db, scope, input.documentId);
  if (fresh === null) throw internal({ logDetail: 'документ не читается сразу после записи' });
  return fresh;
}

/**
 * Идентификаторы документов ревизии по списку — для проверок последствий.
 *
 * Экспортируется, потому что задачи 16–19 адресуют документы поштучно и обязаны
 * убедиться, что работают со СВОЕЙ ревизией: `inArray` без области видимости в
 * обработчике был бы четвёртым путём в обход §4.1.
 */
export async function filterDocumentsOfFolder(
  db: Database,
  scope: AuthScope,
  folderId: string,
  documentIds: readonly string[],
): Promise<readonly string[]> {
  if (documentIds.length === 0) return [];
  const rows = await db
    .select({ id: logicalDocuments.id })
    .from(logicalDocuments)
    .innerJoin(folders, eq(logicalDocuments.folderId, folders.id))
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        eq(logicalDocuments.folderId, folderId),
        inArray(logicalDocuments.id, [...documentIds]),
      ),
    );
  return rows.map((row) => row.id);
}
