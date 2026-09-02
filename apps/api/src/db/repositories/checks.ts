/**
 * Прогоны проверок, замечания и сборка графа §9.1.
 *
 * ## Почему граф собирается здесь, а не в правилах
 *
 * `@id/rules` — чистая логика без доступа к БД: это условие §3.7, по которому
 * прогон месячной давности обязан воспроизводиться точно по снимку. Значит
 * кто-то должен превратить полтора десятка таблиц в один `CheckGraph`, и это
 * место — репозиторий: только здесь есть `AuthScope`, и только здесь запрос к
 * БД разрешён eslint-правилом.
 *
 * ## Материалы выводятся и ЗАПИСЫВАЮТСЯ
 *
 * Таблицы `materials`, `batches` и `material_documents` заведены схемой S2 и до
 * S9 не заполнялись ничем. Оставить их пустыми и держать материалы только в
 * памяти было бы удобно и неверно: замечание `MAT.111` адресуется партии
 * (`target_type = 'batch'`), и `target_id`, не ведущий никуда, — это замечание,
 * которое невозможно открыть с экрана. Поэтому вывод сохраняется, а `target_id`
 * ссылается на настоящую строку.
 *
 * Запись идёт заменой по ревизии: повтор задачи обязан быть безопасен (§12,
 * at-least-once), а частичное обновление оставило бы рядом партии двух
 * прогонов — тот же класс отказа, что на S6 уносил блоки разметки.
 *
 * ## Пиннинг
 *
 * `validation_runs` хранит ссылки на версию набора правил, профиль раздела
 * и профиль правил объекта. Пересчитывать их по дате при чтении нельзя: после
 * публикации новой версии профиля прошлый прогон «переехал» бы на другой набор
 * ожиданий, и §3.2 с §3.7 потеряли бы смысл. Это уже чинилось на S4 миграцией
 * 0011 — здесь ссылки наконец получают вызывающего.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  batches,
  constructionObjects,
  counterparties,
  docTypeOverrides,
  docTypes,
  documentRelations,
  fieldValues,
  findingEvidence,
  findings,
  layoutBlocks,
  logicalDocuments,
  materialDocuments,
  materials,
  pageAssignments,
  pageTextVersions,
  processingBundlePages,
  processingBundles,
  rdDocuments,
  registryRowCandidates,
  registryRows,
  ruleDefinitions,
  rulesetRules,
  rulesetVersions,
  sourcePages,
  folders,
  validationRuns,
} from '@id/db';
import type {
  BatchNode,
  CheckGraph,
  CounterpartyNode,
  DocumentNode,
  FieldNode,
  FindingOrigin,
  FindingSeverity,
  MaterialNode,
  PreparedFinding,
  RdDocumentNode,
  RegistryRowNode,
  RelationNode,
  RuleRunCounts,
  RuleSnapshotEntry,
} from '@id/rules';
import { deriveMaterials, isFallbackCode } from '@id/rules';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, internal, notFound } from '../../lib/problem.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import { readSetting } from './admin.js';
import { RULESET_ACTIVE_VERSION_KEY } from '../../modules/admin/schemas.js';
import { resolveEffectiveRules } from './object-rule-profiles.js';
import type { Database } from './users.js';

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/** То же, что в остальных репозиториях: одинаково подходит и базе, и транзакции. */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/**
 * Порог уверенности типа, ниже которого тип считается неуверенным.
 *
 * Согласован с потолком уверенности фазы 2 сегментации
 * (`BOUNDARY_CONFIDENCE_CEILING`, S8): правило §9.1 «тип документа неизвестен
 * или резервный → `n_a`» обязано срабатывать на том же множестве документов,
 * которое сегментатор сам считает неуверенным. Разъехавшись, эти два числа
 * дали бы документы, помеченные `needs_review`, по которым правила всё равно
 * выносят `fail`.
 */
export const KNOWN_TYPE_MIN_CONFIDENCE = 0.8;

// =====================================================================
// Снимок набора правил
// =====================================================================

export interface RulesetSnapshot {
  readonly versionId: string;
  readonly version: string;
  readonly rules: readonly RuleSnapshotEntry[];
}

/**
 * Опубликованный снимок по идентификатору версии.
 *
 * Только опубликованные версии: черновик, попавший в прогон, менял бы результат
 * проверки, не будучи решением администратора. Тот же принцип, что у профилей
 * разделов на S4.
 */
export async function loadRulesetSnapshot(
  db: Database,
  versionId: string,
): Promise<RulesetSnapshot | null> {
  const versions = await db
    .select({
      id: rulesetVersions.id,
      version: rulesetVersions.version,
      publishedAt: rulesetVersions.publishedAt,
    })
    .from(rulesetVersions)
    .where(eq(rulesetVersions.id, versionId))
    .limit(1);

  const version = versions[0];
  if (version === undefined) return null;
  if (version.publishedAt === null) {
    throw conflict(
      `Версия набора правил ${version.version} не опубликована: прогон по черновику невозможен.`,
    );
  }

  const rows = await db
    .select({
      ruleCode: rulesetRules.ruleCode,
      isEnabled: rulesetRules.isEnabled,
      severity: rulesetRules.severity,
      isBlocking: rulesetRules.isBlocking,
      params: rulesetRules.params,
    })
    .from(rulesetRules)
    .where(eq(rulesetRules.rulesetVersionId, versionId))
    .orderBy(asc(rulesetRules.ruleCode));

  return {
    versionId: version.id,
    version: version.version,
    rules: rows.map((row) => ({
      ruleCode: row.ruleCode,
      isEnabled: row.isEnabled,
      severity: row.severity as RuleSnapshotEntry['severity'],
      isBlocking: row.isBlocking,
      params: (row.params ?? {}) as Readonly<Record<string, unknown>>,
    })),
  };
}

/** Коды реестра правил. Вход сверки при старте (§9.6). */
export async function listRuleDefinitionCodes(db: Database): Promise<readonly string[]> {
  const rows = await db
    .select({ code: ruleDefinitions.code })
    .from(ruleDefinitions)
    .orderBy(asc(ruleDefinitions.code));
  return rows.map((row) => row.code);
}

// =====================================================================
// Сборка графа
// =====================================================================

/** Папка с разделом и видом раздела: корень графа. */
interface FolderContext {
  readonly id: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly sectionCode: string;
  /** Наименование работы: попадает в тексты замечаний вместо кода тома. */
  readonly folderTitle: string;
  /** Месяц комплекта, `ГГГГ-ММ-01`: с ним сверяются даты актов (`AOSR.ACT.032`). */
  readonly period: string;
}

async function loadFolderContext(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<FolderContext> {
  const rows = await db
    .select({
      id: folders.id,
      objectId: folders.objectId,
      contractorId: folders.contractorId,
      sectionCode: folders.sectionCode,
      folderTitle: folders.title,
      // Дата без времени: месяц — это `ГГГГ-ММ-01`, а не метка времени, и
      // `to_char` здесь тот же, что в `WORK_SELECTION` навигации. Без него
      // драйвер отдал бы `Date`, и правило сравнивало бы объект со строкой.
      period: sql<string>`to_char(${folders.period}, 'YYYY-MM-DD')`.as('folder_period'),
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound('Папка не найдена.');
  return row;
}

/**
 * Реквизиты всех документов ревизии одним запросом.
 *
 * Вид блока-источника дочитывается соединением с `layout_blocks`: именно он
 * отличает значение, снятое с чистого текста, от значения, вычитанного с
 * круглой печати. Без него ОГРН `…138138` был бы неотличим от ОГРН из шапки
 * акта, и требование «два битых значения — разные вердикты» стало бы
 * невыполнимым (`docs/CORPUS_FINDINGS.md`).
 */
async function loadFields(db: Database, folderId: string): Promise<Map<string, FieldNode[]>> {
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
      extractedBy: fieldValues.extractedBy,
      pageTextVersionId: fieldValues.pageTextVersionId,
      charSpan: fieldValues.charSpan,
      quote: fieldValues.quote,
      blockId: fieldValues.sourceBlockId,
      blockType: layoutBlocks.blockType,
      blockPageId: layoutBlocks.sourcePageId,
      textPageId: pageTextVersions.sourcePageId,
    })
    .from(fieldValues)
    .leftJoin(layoutBlocks, eq(fieldValues.sourceBlockId, layoutBlocks.id))
    .leftJoin(pageTextVersions, eq(fieldValues.pageTextVersionId, pageTextVersions.id))
    .where(eq(fieldValues.folderId, folderId))
    .orderBy(asc(fieldValues.documentId), asc(fieldValues.fieldCode));

  const byDocument = new Map<string, FieldNode[]>();
  for (const row of rows) {
    const node: FieldNode = {
      id: row.id,
      fieldCode: row.fieldCode,
      valueText: row.valueText,
      valueDate: row.valueDate,
      valueNum: row.valueNum === null ? null : Number(row.valueNum),
      valueJson: row.valueJson,
      confidence: row.confidence,
      isVerified: row.isVerified,
      extractedBy: row.extractedBy as FieldNode['extractedBy'],
      pageTextVersionId: row.pageTextVersionId,
      charSpan: row.charSpan === null ? null : { start: row.charSpan.start, end: row.charSpan.end },
      quote: row.quote,
      sourcePageId: row.blockPageId ?? row.textPageId ?? null,
      blockType: (row.blockType as FieldNode['blockType']) ?? null,
      blockId: row.blockId,
    };
    const list = byDocument.get(row.documentId);
    if (list === undefined) byDocument.set(row.documentId, [node]);
    else list.push(node);
  }
  return byDocument;
}

/**
 * Граф ревизии без ответов внешних реестров.
 *
 * Внешние реестры добавляются вызывающим (задача 20): опрос источника — это
 * ввод-вывод, а репозиторий отвечает за БД. Разделение то же, что у LLM на S8.
 */
export async function loadCheckGraph(
  db: Database,
  scope: AuthScope,
  input: { readonly folderId: string; readonly today: string },
): Promise<Omit<CheckGraph, 'external'>> {
  const folder = await loadFolderContext(db, scope, input.folderId);

  const rules = await resolveEffectiveRules(
    db,
    scope,
    { objectId: folder.objectId, sectionCode: folder.sectionCode },
    input.today,
  );
  if (rules === null) {
    throw internal({ logDetail: `раздел ${folder.sectionCode} не разрешился для объекта` });
  }

  const objectRows = await db
    .select({
      id: constructionObjects.id,
      code: constructionObjects.code,
      name: constructionObjects.name,
      fullName: constructionObjects.fullName,
      address: constructionObjects.address,
      isActive: constructionObjects.isActive,
      actNumberPattern: constructionObjects.actNumberPattern,
      developerId: constructionObjects.developerId,
      techCustomerId: constructionObjects.techCustomerId,
      generalContractorId: constructionObjects.generalContractorId,
    })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, folder.objectId))
    .limit(1);
  const object = objectRows[0];
  if (object === undefined) throw internal({ logDetail: 'карточка объекта не найдена' });

  const counterpartyRows: readonly CounterpartyNode[] = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      inn: counterparties.inn,
      kpp: counterparties.kpp,
      ogrn: counterparties.ogrn,
      kind: counterparties.kind,
      isActive: counterparties.isActive,
    })
    .from(counterparties)
    .orderBy(asc(counterparties.name));

  const rdRows: readonly RdDocumentNode[] = (
    await db
      .select({
        id: rdDocuments.id,
        cipher: rdDocuments.cipher,
        revision: rdDocuments.revision,
        name: rdDocuments.name,
        isActive: rdDocuments.isActive,
      })
      .from(rdDocuments)
      .where(eq(rdDocuments.objectId, folder.objectId))
      .orderBy(asc(rdDocuments.cipher))
  ).map((row) => ({ ...row, name: row.name ?? row.cipher }));

  const documentRows = await db
    .select({
      id: logicalDocuments.id,
      ordinal: logicalDocuments.ordinal,
      complectId: logicalDocuments.complectId,
      docTypeCode: logicalDocuments.docTypeCode,
      title: logicalDocuments.title,
      typeConfidence: logicalDocuments.typeConfidence,
      boundaryConfidence: logicalDocuments.boundaryConfidence,
      needsReview: logicalDocuments.needsReview,
      isConfirmed: logicalDocuments.isConfirmed,
    })
    .from(logicalDocuments)
    .where(eq(logicalDocuments.folderId, input.folderId))
    .orderBy(asc(logicalDocuments.ordinal));

  const pageRows = await db
    .select({
      documentId: pageAssignments.documentId,
      sourcePageId: pageAssignments.sourcePageId,
      sortOrder: pageAssignments.sortOrder,
      pageRoleCode: pageAssignments.pageRoleCode,
    })
    .from(pageAssignments)
    .where(eq(pageAssignments.folderId, input.folderId))
    .orderBy(asc(pageAssignments.sortOrder));

  const fieldsByDocument = await loadFields(db, input.folderId);

  const documents: readonly DocumentNode[] = documentRows.map((row) => {
    const code = row.docTypeCode;
    const fallback = isFallbackCode(code);
    const confident =
      row.typeConfidence === null || row.typeConfidence >= KNOWN_TYPE_MIN_CONFIDENCE;
    return {
      id: row.id,
      ordinal: row.ordinal,
      complectId: row.complectId,
      docTypeCode: code,
      // Резервный тип и неуверенный тип оба закрывают типо-специфичные правила
      // (§9.1, строка 1), но остаются различимы: первый — открытый мир,
      // второй — плохой скан, и на экране документов это разные подсказки.
      isKnownType: code !== null && !fallback && confident && !row.needsReview,
      isFallbackType: fallback,
      title: row.title,
      typeConfidence: row.typeConfidence,
      boundaryConfidence: row.boundaryConfidence,
      needsReview: row.needsReview,
      isConfirmed: row.isConfirmed,
      pages: pageRows
        .filter((page) => page.documentId === row.id)
        .map((page) => ({
          sourcePageId: page.sourcePageId,
          sortOrder: page.sortOrder ?? 0,
          pageRoleCode: page.pageRoleCode,
        })),
      fields: fieldsByDocument.get(row.id) ?? [],
    };
  });

  const registryRowsData = (
    await db
      .select({
        id: registryRows.id,
        registryDocumentId: registryRows.documentId,
        ordinal: registryRows.ordinal,
        rowNo: registryRows.rowNo,
        sectionTitle: registryRows.sectionTitle,
        docNameRaw: registryRows.docNameRaw,
        docNoRaw: registryRows.docNoRaw,
        docNoNorm: registryRows.docNoNorm,
        docNoFolded: registryRows.docNoFolded,
        orgRaw: registryRows.orgRaw,
        validFrom: registryRows.validFrom,
        validTo: registryRows.validTo,
        issuedAt: registryRows.issuedAt,
        matchedDocumentId: registryRows.matchedDocumentId,
        matchScore: registryRows.matchScore,
        matchState: registryRows.matchState,
      })
      .from(registryRows)
      .where(eq(registryRows.folderId, input.folderId))
      .orderBy(asc(registryRows.documentId), asc(registryRows.ordinal))
  ).map((row) => ({ ...row, matchState: row.matchState as RegistryRowNode['matchState'] }));

  // Кандидаты — одним запросом на ревизию, а не по строке: правило REG.101
  // читает их для КАЖДОГО документа, и запрос на строку превратил бы одну
  // проверку в сотню round-trip'ов.
  const candidatesByRow = new Map<string, string[]>();
  for (const candidate of await db
    .select({
      registryRowId: registryRowCandidates.registryRowId,
      documentId: registryRowCandidates.documentId,
    })
    .from(registryRowCandidates)
    .where(eq(registryRowCandidates.folderId, input.folderId))
    .orderBy(desc(registryRowCandidates.score))) {
    const bucket = candidatesByRow.get(candidate.registryRowId);
    if (bucket === undefined) candidatesByRow.set(candidate.registryRowId, [candidate.documentId]);
    else bucket.push(candidate.documentId);
  }

  const registryRowNodes: readonly RegistryRowNode[] = registryRowsData.map((row) => ({
    ...row,
    candidateDocumentIds: candidatesByRow.get(row.id) ?? [],
  }));

  const documentIds = documents.map((document) => document.id);
  const relations: readonly RelationNode[] =
    documentIds.length === 0
      ? []
      : await db
          .select({
            parentDocumentId: documentRelations.parentDocumentId,
            childDocumentId: documentRelations.childDocumentId,
            relation: documentRelations.relation,
          })
          .from(documentRelations)
          .where(inArray(documentRelations.parentDocumentId, documentIds));

  const hasText = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pageTextVersions)
    .innerJoin(sourcePages, eq(pageTextVersions.sourcePageId, sourcePages.id))
    .where(eq(sourcePages.folderId, input.folderId));

  // Пробелы покрытия: листы, которых портал НЕ разобрал.
  //
  // Два случая, и оба означают одно — часть комплекта система не видела:
  // с листа ничего не прочитано, либо прочитанное не отнесено ни к одному
  // документу. Подтверждённый пустой лист сюда не входит: он разобран, и на
  // нём действительно ничего нет.
  const coverage = await db
    .select({
      gaps: sql<number>`count(*) filter (
        where (
          not exists (
            select 1 from page_text_versions ptv
            where ptv.source_page_id = source_pages.id and length(btrim(ptv.text_md)) > 0
          )
          and not exists (
            select 1 from page_classifications pc
            where pc.source_page_id = source_pages.id and pc.page_role_code = 'blank'
          )
        )
        or (
          exists (
            select 1 from page_text_versions ptv
            where ptv.source_page_id = source_pages.id and length(btrim(ptv.text_md)) > 0
          )
          and not exists (
            select 1 from page_assignments pa where pa.source_page_id = source_pages.id
          )
        )
      )::int`,
    })
    .from(sourcePages)
    .where(eq(sourcePages.folderId, input.folderId));

  return {
    folder,
    object,
    profile: {
      sectionProfileId: rules.sectionProfileId,
      sectionProfileVersion: rules.sectionProfileVersion,
      objectProfileIds: rules.objectProfileIds,
      expectedDocTypes: rules.expectedDocTypes,
      materialCategories: rules.materialCategories,
      materialMatrix: (rules.materialMatrix ?? {}) as Readonly<Record<string, unknown>>,
      enabledRuleCodes: rules.enabledRuleCodes,
      thresholds: (rules.thresholds ?? {}) as Readonly<Record<string, unknown>>,
      autonomyLevel: rules.autonomyLevel,
      relevantDateBasis: rules.relevantDateBasis,
      completenessConfigured: rules.completenessConfigured,
    },
    counterparties: counterpartyRows,
    rdDocuments: rdRows,
    documents,
    registryRows: registryRowNodes,
    relations,
    materials: [],
    today: input.today,
    hasRecognizedText: Number(hasText[0]?.count ?? 0) > 0,
    coverageGaps: Number(coverage[0]?.gaps ?? 0),
  };
}

// =====================================================================
// Материалы и партии
// =====================================================================

export interface SaveMaterialsOutcome {
  readonly removed: number;
  readonly materials: number;
  readonly batches: number;
  readonly links: number;
  /** Узлы с настоящими идентификаторами БД: их получает граф правил. */
  readonly nodes: readonly MaterialNode[];
}

/**
 * Вывод материалов из документов и запись их в БД.
 *
 * Возвращает узлы С идентификаторами строк, а не те, что были на входе:
 * замечание, адресованное партии, обязано ссылаться на строку, которую можно
 * открыть. Возврат «сколько записали» обязателен по тому же правилу, что и в
 * `documents.ts`: успешная операция, ничего не изменившая, — это отказ.
 */
export async function saveDerivedMaterials(
  db: Database,
  scope: AuthScope,
  input: { readonly folderId: string; readonly documents: readonly DocumentNode[] },
): Promise<SaveMaterialsOutcome> {
  await loadFolderContext(db, scope, input.folderId);

  let materialSeq = 0;
  let batchSeq = 0;
  const draft = deriveMaterials(input.documents, {
    materialId: () => `m${String((materialSeq += 1))}`,
    batchId: (materialId, key) => `${materialId}:b${String((batchSeq += 1))}:${key}`,
  });

  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(materials)
      .where(eq(materials.folderId, input.folderId))
      .returning({ id: materials.id });

    const nodes: MaterialNode[] = [];
    let batchCount = 0;
    let linkCount = 0;

    for (const material of draft) {
      const inserted = await tx
        .insert(materials)
        .values({
          folderId: input.folderId,
          nameRaw: material.nameRaw,
          nameNorm: material.nameNorm,
          mark: material.mark,
          categoryCode: material.categoryCode,
          source: 'quality_doc',
        })
        .returning({ id: materials.id });
      const materialId = inserted[0]?.id;
      if (materialId === undefined) {
        throw internal({ logDetail: 'материал не записан' });
      }

      const savedBatches: BatchNode[] = [];
      for (const batch of material.batches) {
        const row = await tx
          .insert(batches)
          .values({
            materialId,
            batchNo: batch.batchNo,
            heatNo: batch.heatNo,
            manufacturedAt: batch.manufacturedAt,
          })
          .returning({ id: batches.id });
        const batchId = row[0]?.id;
        if (batchId === undefined) throw internal({ logDetail: 'партия не записана' });
        batchCount += 1;
        savedBatches.push({ ...batch, id: batchId, materialId });

        for (const documentId of batch.documentIds) {
          await tx
            .insert(materialDocuments)
            .values({
              folderId: input.folderId,
              materialId,
              documentId,
              batchId,
              relation: 'batch_doc',
            })
            .onConflictDoNothing();
          linkCount += 1;
        }
      }

      for (const documentId of material.documentIds) {
        await tx
          .insert(materialDocuments)
          .values({
            folderId: input.folderId,
            materialId,
            documentId,
            batchId: null,
            relation: 'quality_doc',
          })
          .onConflictDoNothing();
        linkCount += 1;
      }

      nodes.push({ ...material, id: materialId, batches: savedBatches });
    }

    return {
      removed: removed.length,
      materials: nodes.length,
      batches: batchCount,
      links: linkCount,
      nodes,
    };
  });
}

// =====================================================================
// Прогон и замечания
// =====================================================================

export interface StartValidationRunInput {
  readonly folderId: string;
  readonly rulesetVersionId: string;
  readonly sectionProfileId: string | null;
  readonly objectRuleProfileId: string | null;
}

export async function startValidationRun(
  db: Database,
  scope: AuthScope,
  input: StartValidationRunInput,
): Promise<{ readonly id: string }> {
  await loadFolderContext(db, scope, input.folderId);

  const rows = await db
    .insert(validationRuns)
    .values({
      folderId: input.folderId,
      rulesetVersionId: input.rulesetVersionId,
      sectionProfileId: input.sectionProfileId,
      objectRuleProfileId: input.objectRuleProfileId,
    })
    .returning({ id: validationRuns.id });

  const id = rows[0]?.id;
  if (id === undefined) throw internal({ logDetail: 'прогон проверок не создан' });
  return { id };
}

export interface SaveFindingsOutcome {
  readonly removed: number;
  readonly written: number;
  readonly evidence: number;
}

/**
 * Запись замечаний прогона.
 *
 * Замена по прогону, а не по ревизии: `checks.run` повторяется при
 * at-least-once доставке, и повтор обязан дать тот же набор строк, а не
 * второй экземпляр каждого замечания. Прошлые прогоны остаются нетронутыми —
 * история проверок и есть то, ради чего `validation_runs` существует.
 *
 * Доказательство пишется только если цитата отобразилась на диапазон: §9.6
 * прямо требует, чтобы неотобразившаяся цитата давала `undetermined`, а не
 * замечание с выдуманной ссылкой.
 */
export async function saveFindings(
  db: Database,
  scope: AuthScope,
  input: {
    readonly validationRunId: string;
    readonly folderId: string;
    readonly findings: readonly PreparedFinding[];
  },
): Promise<SaveFindingsOutcome> {
  const folder = await loadFolderContext(db, scope, input.folderId);

  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(findings)
      .where(eq(findings.validationRunId, input.validationRunId))
      .returning({ id: findings.id });

    let written = 0;
    let evidenceCount = 0;

    for (const finding of input.findings) {
      const rows = await tx
        .insert(findings)
        .values({
          validationRunId: input.validationRunId,
          folderId: input.folderId,
          objectId: folder.objectId,
          contractorId: folder.contractorId,
          ruleCode: finding.ruleCode,
          severity: finding.severity,
          state: finding.state,
          origin: finding.origin,
          isBlocking: finding.isBlocking,
          targetType: finding.targetType,
          targetId: finding.targetId,
          sourcePageId: finding.sourcePageId ?? null,
          blockId: finding.blockId ?? null,
          message: finding.message,
          hint: finding.hint ?? null,
        })
        .returning({ id: findings.id });

      const findingId = rows[0]?.id;
      if (findingId === undefined) throw internal({ logDetail: 'замечание не записано' });
      written += 1;

      for (const evidence of finding.evidence ?? []) {
        await tx
          .insert(findingEvidence)
          .values({
            findingId,
            pageTextVersionId: evidence.pageTextVersionId,
            charSpan: { start: evidence.charStart, end: evidence.charEnd },
            quote: evidence.quote,
          })
          .onConflictDoNothing();
        evidenceCount += 1;
      }
    }

    return { removed: removed.length, written, evidence: evidenceCount };
  });
}

/**
 * Замечания ИИ-проверки заполнения (S21) — в ТОТ ЖЕ прогон, что и правила.
 *
 * ## Почему не отдельный `validation_run`
 *
 * `validation_runs.ruleset_version_id` объявлен `NOT NULL`: прогон без
 * опубликованного набора правил невозможен по построению. Заводить второй
 * прогон с тем же набором значило бы показывать инженеру две строки «проверка
 * от 12:31» и «проверка от 12:31», отвечающие на один вопрос, и заставлять его
 * догадываться, какая из них полная.
 *
 * ## Почему собственный метод, а не `saveFindings`
 *
 * Тот удаляет ВСЕ замечания прогона перед вставкой — он единственный писатель
 * и вправе так делать. ИИ-стадия приходит вторым писателем в тот же прогон, и
 * та же семантика стёрла бы результат движка правил. Здесь удаляются только
 * собственные строки (`origin = 'llm'`), поэтому повтор задачи заменяет свой
 * выход целиком и не трогает чужой — то же правило «задача заменяет свой выход»,
 * что и у остальных стадий (§12).
 *
 * Инвариант БД `findings_llm_blocking_chk` (никакого `is_blocking` без
 * подтверждения человеком) здесь не дублируется проверкой: он в схеме, и
 * попытка его обойти обязана кончиться отказом транзакции, а не тихим
 * приведением значения.
 */
export async function saveLlmFindings(
  db: Database,
  scope: AuthScope,
  input: {
    readonly validationRunId: string;
    readonly folderId: string;
    readonly findings: readonly PreparedFinding[];
  },
): Promise<SaveFindingsOutcome> {
  const folder = await loadFolderContext(db, scope, input.folderId);

  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(findings)
      .where(and(eq(findings.validationRunId, input.validationRunId), eq(findings.origin, 'llm')))
      .returning({ id: findings.id });

    let written = 0;
    let evidenceCount = 0;

    for (const finding of input.findings) {
      const rows = await tx
        .insert(findings)
        .values({
          validationRunId: input.validationRunId,
          folderId: input.folderId,
          objectId: folder.objectId,
          contractorId: folder.contractorId,
          ruleCode: finding.ruleCode,
          severity: finding.severity,
          state: finding.state,
          origin: 'llm',
          // См. шапку: `false` здесь — не умолчание, а единственное значение,
          // которое пропустит CHECK при `confirmed_by IS NULL`.
          isBlocking: false,
          targetType: finding.targetType,
          targetId: finding.targetId,
          sourcePageId: finding.sourcePageId ?? null,
          blockId: finding.blockId ?? null,
          message: finding.message,
          hint: finding.hint ?? null,
        })
        .returning({ id: findings.id });

      const findingId = rows[0]?.id;
      if (findingId === undefined) throw internal({ logDetail: 'замечание модели не записано' });
      written += 1;

      for (const evidence of finding.evidence ?? []) {
        await tx
          .insert(findingEvidence)
          .values({
            findingId,
            pageTextVersionId: evidence.pageTextVersionId,
            charSpan: { start: evidence.charStart, end: evidence.charEnd },
            quote: evidence.quote,
          })
          .onConflictDoNothing();
        evidenceCount += 1;
      }
    }

    return { removed: removed.length, written, evidence: evidenceCount };
  });
}

/**
 * Журнал исполнения правил (§9.6).
 *
 * Пишется задачей 20 сразу после прогона и читается задачей 21. Хранится в
 * `validation_runs.counts`, а не в памяти процесса: сводку может подхватить
 * другой воркер, а «правило прошло» и «правило не исполнялось» обязаны
 * оставаться различимы после любого перезапуска — это прямой гейт S9.
 */
export interface RuleExecutionJournal {
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly executions: readonly {
    readonly ruleCode: string;
    readonly verdict: string;
    readonly reason: string | null;
    readonly findingCount: number;
    /**
     * Комплект, на котором правило исполнялось; `null` — папка целиком (S44).
     *
     * Разрез, названный долгом в ADR-0018: до нарезки на комплекты «правило
     * пройдено» было одним ответом на папку, а на двенадцати актах смешивало бы
     * двенадцать разных. Поле необязательное: журналы прогонов до S44 его не
     * содержат, и читатель обязан пережить их без выдумывания комплекта.
     */
    readonly complectId?: string | null;
  }[];
  readonly skippedCodes: Readonly<Record<string, string>>;
  readonly externalRegistriesUnavailable: readonly string[];
  readonly engineCounts: RuleRunCounts;
}

/** Сводка прогона: журнал исполнения плюс счётчики по записанным замечаниям. */
export interface ValidationSummary extends RuleRunCounts {
  readonly journal: RuleExecutionJournal;
}

/**
 * Запись журнала исполнения до сводки.
 *
 * Отдельно от `finishValidationRun`, потому что незавершённый прогон обязан
 * оставаться незавершённым: `finished_at` — признак того, что сводка сделана, и
 * ставить его вместе с журналом значило бы объявлять прогон готовым до того,
 * как посчитаны замечания.
 */
export async function saveRunJournal(
  db: Database,
  scope: AuthScope,
  input: {
    readonly validationRunId: string;
    readonly folderId: string;
    readonly journal: RuleExecutionJournal;
  },
): Promise<void> {
  await loadFolderContext(db, scope, input.folderId);

  const updated = await db
    .update(validationRuns)
    .set({ counts: { journal: input.journal } })
    .where(
      and(
        eq(validationRuns.id, input.validationRunId),
        eq(validationRuns.folderId, input.folderId),
      ),
    )
    .returning({ id: validationRuns.id });

  if (updated.length === 0) throw notFound('Прогон проверок не найден.');
}

/** Журнал прогона; `null` — задача 20 его не записала. */
export async function loadRunJournal(
  db: Database,
  scope: AuthScope,
  input: { readonly validationRunId: string; readonly folderId: string },
): Promise<RuleExecutionJournal | null> {
  await loadFolderContext(db, scope, input.folderId);
  return readRunJournal(db, input);
}

/**
 * Журнал прогона БЕЗ проверки области — для вызывающего, который её уже сделал.
 *
 * Разбор `counts` живёт здесь одним экземпляром: `journal` лежит внутри jsonb, и
 * второе место, знающее его форму, разошлось бы с первым при первой же правке
 * `saveRunJournal`. Область проверяет `loadRunJournal`; отчёт о составе
 * комплекта проверяет её раньше и своим запросом, внутри общей транзакции.
 */
export async function readRunJournal(
  db: Executor,
  input: { readonly validationRunId: string; readonly folderId: string },
): Promise<RuleExecutionJournal | null> {
  const rows = await db
    .select({ counts: validationRuns.counts })
    .from(validationRuns)
    .where(
      and(
        eq(validationRuns.id, input.validationRunId),
        eq(validationRuns.folderId, input.folderId),
      ),
    )
    .limit(1);

  const counts = rows[0]?.counts;
  if (counts === undefined || counts === null || typeof counts !== 'object') return null;
  const journal = (counts as Record<string, unknown>)['journal'];
  return journal === undefined || journal === null ? null : (journal as RuleExecutionJournal);
}

export async function finishValidationRun(
  db: Database,
  scope: AuthScope,
  input: {
    readonly validationRunId: string;
    readonly folderId: string;
    readonly summary: ValidationSummary;
  },
): Promise<void> {
  await loadFolderContext(db, scope, input.folderId);

  const updated = await db
    .update(validationRuns)
    .set({ finishedAt: sql`now()`, counts: input.summary })
    .where(
      and(
        eq(validationRuns.id, input.validationRunId),
        eq(validationRuns.folderId, input.folderId),
      ),
    )
    .returning({ id: validationRuns.id });

  if (updated.length === 0) {
    throw notFound('Прогон проверок не найден.');
  }
}

export interface ValidationRunView {
  readonly id: string;
  readonly folderId: string;
  readonly rulesetVersionId: string;
  readonly sectionProfileId: string | null;
  readonly objectRuleProfileId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly counts: Readonly<Record<string, unknown>>;
}

export async function listValidationRuns(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<readonly ValidationRunView[]> {
  const rows = await db
    .select({
      id: validationRuns.id,
      folderId: validationRuns.folderId,
      rulesetVersionId: validationRuns.rulesetVersionId,
      sectionProfileId: validationRuns.sectionProfileId,
      objectRuleProfileId: validationRuns.objectRuleProfileId,
      startedAt: sql<string>`to_char(${validationRuns.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      finishedAt: sql<
        string | null
      >`to_char(${validationRuns.finishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      counts: validationRuns.counts,
    })
    .from(validationRuns)
    .innerJoin(folders, eq(validationRuns.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(validationRuns.folderId, folderId)))
    .orderBy(desc(validationRuns.startedAt));

  return rows.map((row) => ({
    ...row,
    counts: (row.counts ?? {}) as Readonly<Record<string, unknown>>,
  }));
}

export interface FindingView {
  readonly id: string;
  readonly validationRunId: string;
  readonly ruleCode: string;
  readonly severity: FindingSeverity;
  readonly state: 'open' | 'resolved' | 'waived' | 'undetermined';
  readonly origin: FindingOrigin;
  readonly isBlocking: boolean;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly sourcePageId: string | null;
  readonly blockId: string | null;
  readonly message: string;
  readonly hint: string | null;
  /** Текст строки списка: `summary` правила, пока его нет — `message`. */
  readonly text: string;
  readonly page: FindingPageView | null;
  readonly document: FindingDocumentView | null;
  readonly target: FindingTargetView;
  readonly evidence: readonly FindingEvidenceView[];
}

export interface FindingPageView {
  /** Сквозной номер страницы по комплекту: `source_pages.folder_ordinal + 1`. */
  readonly number: number;
  /** Страница рабочего документа — только для ссылки на разметку. */
  readonly workingPageIndex: number | null;
  /** Откуда взят номер. `document` — приблизительно, начало документа. */
  readonly basis: 'finding' | 'evidence' | 'field' | 'document';
}

export interface FindingDocumentView {
  readonly id: string;
  readonly docTypeCode: string | null;
  /** Название вида ИД либо заголовок документа, если вид не определён. */
  readonly label: string;
}

export interface FindingTargetView {
  readonly kind:
    'document' | 'material' | 'batch' | 'registry_row' | 'page' | 'field' | 'folder' | 'gone';
  readonly label: string;
  readonly detail: string | null;
}

export interface FindingEvidenceView {
  readonly quote: string;
  readonly pageTextVersionId: string;
  readonly charSpan: { readonly start: number; readonly end: number };
}

/**
 * Текст строки списка замечаний.
 *
 * Одна функция вместо выражения по месту вызова — точка встречи с потоком,
 * который добавляет колонку `findings.summary` (короткая формулировка «что не
 * так» без имени документа и номера страницы). Когда колонка появится, здесь
 * станет `summary ?? message`, и правка будет ровно одна. Сослаться на неё
 * раньше нельзя: запрос упал бы на несуществующей колонке.
 */
function findingText(row: { readonly message: string }): string {
  return row.message;
}

/**
 * Авторитетный прогон ревизии — САМЫЙ НОВЫЙ, завершён он или нет.
 *
 * «Самый новый завершённый» было бы удобнее для экрана и неверно для решения:
 * согласование по завершённому прогону, поверх которого уже идёт следующий, —
 * это решение по проверке, которую сам портал считает устаревшей. Поэтому
 * авторитетность и показываемость разведены: здесь — кто главный, в
 * `resolveShownRun` — что показать, пока главный не закончил.
 *
 * Второй ключ сортировки нужен: `started_at` двух прогонов, поставленных одной
 * пачкой, совпадает с точностью до микросекунды далеко не всегда, но совпасть
 * может, и тогда порядок без второго ключа не определён.
 */
/**
 * Подзапрос «авторитетный прогон» для коррелирующих счётчиков.
 *
 * Ревизия названа ТЕКСТОМ (`folders.id`), поэтому фрагмент годится
 * только внутри запроса, который сам выбирает из `folders`. Это не
 * ограничение, а условие корректности: в запросе без джойнов Drizzle рендерит
 * колонку без имени таблицы, и коррелирующее условие связалось бы с
 * одноимённой колонкой внутренней таблицы — счётчик молча вернул бы ноль (тем
 * же способом много этапов подряд был сломан `hasBundle` в `files.ts`).
 *
 * Читают его `loadFolderReadiness` (блокеры согласования) и счётчики архива.
 */
export const LATEST_VALIDATION_RUN = sql`(
  select v.id from validation_runs v
   where v.folder_id = folders.id
   order by v.started_at desc, v.id desc
   limit 1)`;

export interface ChecksRunView {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * Замечания копятся по прогонам, и это дефект выдачи, а не хранения.
 *
 * `saveFindings` заменяет строки ТОЛЬКО своего прогона — история проверок ради
 * того и существует. Но выдача читала findings всей ревизии без фильтра, и
 * второе нажатие «Распознать» показывало каждое замечание дважды. Заказчик:
 * «вести историю ошибок не нужно» — пользователю показывается один прогон.
 *
 * Прошлые прогоны остаются в базе техническим следом и доступны явным
 * `validationRunId`; в блокерах согласования и в сводке архива они больше не
 * участвуют.
 */
export async function resolveShownRun(
  db: Executor,
  scope: AuthScope,
  folderId: string,
  requested: string | undefined,
): Promise<{ readonly latest: ChecksRunView | null; readonly shownRunId: string | null }> {
  // Область видимости обязательна и здесь, хотя findings ниже отбираются ею
  // повторно. Время прогона — тоже факт о чужой поставке (§16): «проверка
  // соседа шла вчера в 14:20» получается арифметикой из ответа, в котором нет
  // ни одного его замечания.
  const rows = await db
    .select({
      id: validationRuns.id,
      startedAt: sql<string>`to_char(${validationRuns.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      finishedAt: sql<
        string | null
      >`to_char(${validationRuns.finishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(validationRuns)
    .innerJoin(folders, eq(validationRuns.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(validationRuns.folderId, folderId)))
    .orderBy(desc(validationRuns.startedAt), desc(validationRuns.id))
    .limit(2);

  const latest = rows[0] ?? null;

  // Явный прогон — диагностический просмотр. Он задаёт И список, И счётчики:
  // items одного прогона со сводкой другого были бы внутренне противоречивым
  // ответом, по которому нельзя понять, что именно проверяли.
  //
  // Принадлежность проверяется, а не предполагается: идентификатор приходит от
  // клиента, и прогон чужой ревизии обязан дать пустой ответ, а не список,
  // отфильтрованный где-то ниже по случайному совпадению условий.
  if (requested !== undefined) {
    const owned = await db
      .select({ id: validationRuns.id })
      .from(validationRuns)
      .innerJoin(folders, eq(validationRuns.folderId, folders.id))
      .where(
        withScope(
          scope,
          FOLDER_SCOPE,
          eq(validationRuns.id, requested),
          eq(validationRuns.folderId, folderId),
        ),
      )
      .limit(1);
    return { latest, shownRunId: owned.length === 0 ? null : requested };
  }

  if (latest === null) return { latest: null, shownRunId: null };
  if (latest.finishedAt !== null) return { latest, shownRunId: latest.id };

  // Идёт новая проверка. Гасить список нельзя: результат предыдущего прогона —
  // правда о ТОМ ЖЕ комплекте (состав не может измениться, не снеся прогоны:
  // `validation_runs` входит в `DERIVED_DELETES`). Экран покажет его с явной
  // подписью, что идёт новая проверка, а согласование по нему не пройдёт —
  // блокер смотрит на `latest`.
  const previous = rows[1];
  return { latest, shownRunId: previous?.finishedAt != null ? previous.id : null };
}

/**
 * Сводка экрана проверки.
 *
 * Одним запросом с коррелирующими подзапросами — по образцу
 * `loadFolderReadiness`, включая его урок: внешняя таблица названа ТЕКСТОМ
 * (`folders.id`), потому что в запросе без джойнов Drizzle
 * рендерит колонку без имени таблицы и коррелирующее условие связывается с
 * одноимённой колонкой внутренней таблицы — каждый счётчик молча вернул бы ноль.
 *
 * `v_unaccounted_pages` здесь НЕ используется, хотя выглядит подходящим:
 * `applySegmentation` проверяет его пустоту в своей же транзакции и
 * откатывается при непустом результате, то есть после успешной сегментации оно
 * пусто по построению. Непривязанная страница — это `page_assignments` с
 * `document_id IS NULL` и названной причиной, и считать надо именно её.
 */
export interface ChecksCoverage {
  readonly pagesTotal: number;
  readonly pagesRecognized: number;
  readonly pagesAssigned: number;
  readonly pagesUnassigned: number;
  /**
   * Номера непривязанных страниц, первые двадцать.
   *
   * Число без номеров непроверяемо: «портал не разобрал 2 страницы» не говорит,
   * какие, и человеку нечего открыть. Список ограничен, потому что на комплекте,
   * где не разобралось ничего, он совпал бы со всем комплектом.
   */
  readonly unassignedPageNumbers: readonly number[];
  readonly documentsTotal: number;
  /**
   * Документы, вид которых не определён либо резервный.
   *
   * Тоже заявление о полноте, а не замечание: типо-специфичные правила по таким
   * документам не исполняются вовсе, и человек обязан знать, что пустой список
   * ошибок по ним ничего не доказывает. Замечанием это было бы неверно —
   * подрядчику нечего с ним делать, вид определяет портал.
   */
  readonly documentsUnknownType: number;
}

/** Сколько номеров непривязанных страниц уходит на экран. */
const UNASSIGNED_PAGES_SHOWN = 20;

export async function loadChecksCoverage(
  db: Executor,
  scope: AuthScope,
  folderId: string,
): Promise<ChecksCoverage> {
  const rows = await db
    .select({
      pagesTotal: sql<number>`(select count(*)::int from ${sourcePages} p where p.folder_id = folders.id)`,
      pagesRecognized: sql<number>`(select count(distinct t.source_page_id)::int from ${pageTextVersions} t where t.folder_id = folders.id)`,
      pagesAssigned: sql<number>`(select count(*)::int from ${pageAssignments} a where a.folder_id = folders.id and a.document_id is not null)`,
      pagesUnassigned: sql<number>`(select count(*)::int from ${pageAssignments} a where a.folder_id = folders.id and a.document_id is null)`,
      unassignedPageNumbers: sql<number[]>`(
        select coalesce(array_agg(p.folder_ordinal + 1 order by p.folder_ordinal), '{}'::int[])
          from ${pageAssignments} a
          join ${sourcePages} p on p.id = a.source_page_id
         where a.folder_id = folders.id and a.document_id is null)`,
      documentsTotal: sql<number>`(select count(*)::int from ${logicalDocuments} d where d.folder_id = folders.id)`,
      documentsUnknownType: sql<number>`(
        select count(*)::int from ${logicalDocuments} d
         left join ${docTypes} t on t.code = d.doc_type_code
         where d.folder_id = folders.id
           and (d.doc_type_code is null or t.is_fallback))`,
    })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
    .limit(1);

  const row = rows[0];
  // Ревизия вне области видимости даёт НУЛИ, а не отказ. Маршрут замечаний —
  // список, и по решению модуля список чужой ревизии это 200 с пустым
  // содержимым, а не 404: иначе клиент учится различать «нет прав» и «нет
  // данных» по коду ответа. Нули одинаковы для чужой и для несуществующей
  // ревизии, поэтому сводка не сообщает о чужой поставке ничего (§16).
  if (row === undefined) {
    return {
      pagesTotal: 0,
      pagesRecognized: 0,
      pagesAssigned: 0,
      pagesUnassigned: 0,
      unassignedPageNumbers: [],
      documentsTotal: 0,
      documentsUnknownType: 0,
    };
  }
  return {
    ...row,
    unassignedPageNumbers: row.unassignedPageNumbers.slice(0, UNASSIGNED_PAGES_SHOWN),
  };
}

export interface ChecksCounts {
  readonly openErrors: number;
  readonly openWarnings: number;
  readonly openInfo: number;
  readonly undetermined: number;
  readonly waived: number;
}

/**
 * Счётчики сводки — по УЖЕ загруженному списку, а не отдельным запросом.
 *
 * Второй запрос считал бы то же самое в другой момент времени и по другому
 * условию, и число в сводке могло бы разойтись со списком под ней. Расхождение
 * здесь — не косметика: по нему пользователь решает, все ли ошибки он увидел.
 *
 * Важность считается только у открытых: `undetermined` — это «данных для вывода
 * нет», и складывать его с ошибками значит утверждать дефект там, где методика
 * его не установила.
 */
export function countFindings(items: readonly FindingView[]): ChecksCounts {
  const openOf = (severity: FindingSeverity): number =>
    items.filter((item) => item.state === 'open' && item.severity === severity).length;
  return {
    openErrors: openOf('error'),
    openWarnings: openOf('warning'),
    openInfo: openOf('info'),
    undetermined: items.filter((item) => item.state === 'undetermined').length,
    waived: items.filter((item) => item.state === 'waived').length,
  };
}

export interface FindingListView {
  readonly items: readonly FindingView[];
  readonly latestRun: ChecksRunView | null;
  readonly shownRunId: string | null;
}

/**
 * Замечания одного прогона, готовые к печати строкой «Страница — вид — что не так».
 *
 * Номер страницы и вид документа живут только в БД, и собирать подпись обязан
 * сервер: клиент добывал номер вторым и третьим запросом через карту
 * `processing_bundle_pages`, а вида документа не знал вовсе. Прецедент —
 * `submitBlockers`, приходящие готовыми русскими фразами.
 *
 * Обогащение сделано КАРТАМИ, а не полудюжиной left join'ов: фиксированное
 * число запросов независимо от числа замечаний (образец — `loadFields` выше).
 * Все они идут одной транзакцией: в READ COMMITTED пересегментация посреди
 * чтения дала бы ответ, часть которого описывает старые замечания, а часть —
 * уже новые документы.
 */
export async function listFindings(
  db: Database,
  scope: AuthScope,
  input: { readonly folderId: string; readonly validationRunId?: string | undefined },
): Promise<readonly FindingView[]> {
  const view = await listFindingsView(db, scope, input);
  return view.items;
}

export async function listFindingsView(
  db: Database,
  scope: AuthScope,
  input: { readonly folderId: string; readonly validationRunId?: string | undefined },
): Promise<FindingListView> {
  return db.transaction(async (tx) => {
    const { latest, shownRunId } = await resolveShownRun(
      tx,
      scope,
      input.folderId,
      input.validationRunId,
    );
    if (shownRunId === null) return { items: [], latestRun: latest, shownRunId: null };

    const items = await collectFindings(tx, scope, input.folderId, shownRunId);
    return { items, latestRun: latest, shownRunId };
  });
}

/**
 * Замечания одного прогона внутри УЖЕ ОТКРЫТОЙ транзакции.
 *
 * Отдельно от `listFindingsView`, потому что вызывающих двое: список замечаний
 * и отчёт о составе комплекта (`check-report.ts`). Оба обязаны читать замечания
 * ТЕМ ЖЕ прогоном и в ТОЙ ЖЕ транзакции, что и остальные свои таблицы, — иначе
 * в READ COMMITTED пересегментация посреди чтения даёт ответ, часть которого
 * описывает старые замечания, а часть уже новые документы.
 */
export async function collectFindings(
  tx: Executor,
  scope: AuthScope,
  folderId: string,
  shownRunId: string,
): Promise<readonly FindingView[]> {
  const rows = await tx
    .select({
      id: findings.id,
      validationRunId: findings.validationRunId,
      ruleCode: findings.ruleCode,
      severity: findings.severity,
      state: findings.state,
      origin: findings.origin,
      isBlocking: findings.isBlocking,
      targetType: findings.targetType,
      targetId: findings.targetId,
      sourcePageId: findings.sourcePageId,
      blockId: findings.blockId,
      message: findings.message,
      hint: findings.hint,
    })
    .from(findings)
    .innerJoin(folders, eq(findings.folderId, folders.id))
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        eq(findings.folderId, folderId),
        eq(findings.validationRunId, shownRunId),
      ),
    )
    .orderBy(asc(findings.ruleCode), asc(findings.createdAt));

  if (rows.length === 0) return [];

  const context = await loadFindingContext(
    tx,
    folderId,
    rows.map((row) => row.id),
  );

  // Приведение к закрытым перечислениям: значения держат CHECK-ограничения
  // 0006, и расширять их можно только миграцией.
  const items = rows.map((row) => {
    const severity = row.severity as FindingSeverity;
    const state = row.state as FindingView['state'];
    const evidence = context.evidence.get(row.id) ?? [];
    const resolved = resolveSubject(row, context, evidence);
    return {
      ...row,
      severity,
      state,
      origin: row.origin as FindingOrigin,
      text: findingText(row),
      page: resolved.page,
      document: resolved.document,
      target: resolved.target,
      evidence,
    };
  });

  return orderForScreen(items);
}

/**
 * Порядок задаёт сервер, а не разметка.
 *
 * Сначала замечания со страницей — по её номеру: человек читает список,
 * листая комплект сверху вниз. Внутри страницы — по важности, потом по коду
 * правила, чтобы порядок был устойчив между обновлениями. Замечания без
 * страницы идут следом: это «чего в комплекте не хватает», и место им в конце.
 */
const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

function orderForScreen(items: readonly FindingView[]): readonly FindingView[] {
  return [...items].sort((a, b) => {
    if ((a.page === null) !== (b.page === null)) return a.page === null ? 1 : -1;
    if (a.page !== null && b.page !== null && a.page.number !== b.page.number) {
      return a.page.number - b.page.number;
    }
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.ruleCode.localeCompare(b.ruleCode, 'ru');
  });
}

// =====================================================================
// Обогащение замечаний: страница, документ, объект, доказательство
// =====================================================================

export interface PageFacts {
  readonly number: number;
  readonly workingPageIndex: number | null;
  readonly documentId: string | null;
}

export interface DocumentFacts {
  readonly label: string;
  readonly docTypeCode: string | null;
  readonly firstPageId: string | null;
  /** Комплект документа; `null` — опись, титул, всё до первого акта (S44). */
  readonly complectId: string | null;
}

export interface FindingContext {
  readonly pages: ReadonlyMap<string, PageFacts>;
  readonly documents: ReadonlyMap<string, DocumentFacts>;
  readonly fields: ReadonlyMap<
    string,
    { documentId: string; fieldCode: string; pageId: string | null }
  >;
  readonly materials: ReadonlyMap<string, string>;
  readonly batches: ReadonlyMap<string, { material: string; detail: string | null }>;
  readonly registryRows: ReadonlyMap<string, { label: string; detail: string | null }>;
  readonly evidence: ReadonlyMap<string, readonly FindingEvidenceView[]>;
  readonly evidencePageOf: ReadonlyMap<string, string>;
}

export async function loadFindingContext(
  db: Executor,
  folderId: string,
  findingIds: readonly string[],
): Promise<FindingContext> {
  // 1. Страницы ревизии вместе с их местом в рабочем документе и документом,
  //    к которому они отнесены. Карта страниц берётся у ПОСЛЕДНЕГО бандла: на
  //    неё ссылается только адрес разметки, и адрес по устаревшей карте вёл бы
  //    не туда.
  const pageRows = await db
    .select({
      id: sourcePages.id,
      folderOrdinal: sourcePages.folderOrdinal,
      workingPageIndex: processingBundlePages.workingPageIndex,
      documentId: pageAssignments.documentId,
    })
    .from(sourcePages)
    .leftJoin(
      pageAssignments,
      and(
        eq(pageAssignments.folderId, sourcePages.folderId),
        eq(pageAssignments.sourcePageId, sourcePages.id),
      ),
    )
    .leftJoin(
      processingBundlePages,
      and(
        eq(processingBundlePages.sourcePageId, sourcePages.id),
        eq(
          processingBundlePages.bundleId,
          sql`(select b.id from ${processingBundles} b
                where b.folder_id = ${folderId}
                order by b.created_at desc limit 1)`,
        ),
      ),
    )
    .where(eq(sourcePages.folderId, folderId));

  const pages = new Map<string, PageFacts>();
  for (const row of pageRows) {
    pages.set(row.id, {
      number: row.folderOrdinal + 1,
      workingPageIndex: row.workingPageIndex,
      documentId: row.documentId,
    });
  }

  // 2. Документы с ЭФФЕКТИВНЫМ названием вида. Название берётся из БД, а не из
  //    каталога в коде: администратор заводит новые виды в портале и
  //    переименовывает существующие через `doc_type_overrides`, и второй
  //    источник названия разошёлся бы с первым на первой же правке.
  const documentRows = await db
    .select({
      id: logicalDocuments.id,
      docTypeCode: logicalDocuments.docTypeCode,
      complectId: logicalDocuments.complectId,
      title: logicalDocuments.title,
      typeName: sql<string | null>`coalesce(${docTypeOverrides.name}, ${docTypes.name})`,
      firstPageId: sql<string | null>`(
        select a.source_page_id from ${pageAssignments} a
         where a.document_id = ${logicalDocuments.id}
         order by a.sort_order asc nulls last
         limit 1)`,
    })
    .from(logicalDocuments)
    .leftJoin(docTypes, eq(docTypes.code, logicalDocuments.docTypeCode))
    .leftJoin(docTypeOverrides, eq(docTypeOverrides.docTypeCode, logicalDocuments.docTypeCode))
    .where(eq(logicalDocuments.folderId, folderId));

  const documents = new Map<string, DocumentFacts>();
  for (const row of documentRows) {
    documents.set(row.id, {
      // Заголовок документа — запасной вариант, а не основной: он взят из
      // скана и может быть чем угодно, тогда как вид ИД — это то слово,
      // которым инженер документ и называет.
      label: row.typeName ?? row.title ?? 'Вид документа не определён',
      docTypeCode: row.docTypeCode,
      firstPageId: row.firstPageId,
      complectId: row.complectId,
    });
  }

  // 3. Реквизиты: у замечания на реквизит документ поднимается по нему, а
  //    страница — тем же двухступенчатым запасом, что в `loadFields`.
  const fieldRows = await db
    .select({
      id: fieldValues.id,
      documentId: fieldValues.documentId,
      fieldCode: fieldValues.fieldCode,
      blockPageId: layoutBlocks.sourcePageId,
      textPageId: pageTextVersions.sourcePageId,
    })
    .from(fieldValues)
    .leftJoin(layoutBlocks, eq(fieldValues.sourceBlockId, layoutBlocks.id))
    .leftJoin(pageTextVersions, eq(fieldValues.pageTextVersionId, pageTextVersions.id))
    .where(eq(fieldValues.folderId, folderId));

  const fields = new Map<
    string,
    { documentId: string; fieldCode: string; pageId: string | null }
  >();
  for (const row of fieldRows) {
    fields.set(row.id, {
      documentId: row.documentId,
      fieldCode: row.fieldCode,
      pageId: row.blockPageId ?? row.textPageId ?? null,
    });
  }

  // 4. Материалы, партии и строки реестра — объекты замечаний, у которых
  //    документа может не быть вовсе.
  const materialRows = await db
    .select({ id: materials.id, nameRaw: materials.nameRaw })
    .from(materials)
    .where(eq(materials.folderId, folderId));
  const materialNames = new Map(materialRows.map((row) => [row.id, row.nameRaw]));

  const batchRows = await db
    .select({
      id: batches.id,
      materialId: batches.materialId,
      batchNo: batches.batchNo,
      heatNo: batches.heatNo,
    })
    .from(batches)
    .innerJoin(materials, eq(batches.materialId, materials.id))
    .where(eq(materials.folderId, folderId));
  const batchFacts = new Map<string, { material: string; detail: string | null }>();
  for (const row of batchRows) {
    const parts: string[] = [];
    if (row.batchNo !== null) parts.push(`партия № ${row.batchNo}`);
    if (row.heatNo !== null) parts.push(`плавка № ${row.heatNo}`);
    batchFacts.set(row.id, {
      material: materialNames.get(row.materialId) ?? 'Материал',
      detail: parts.length > 0 ? parts.join(', ') : null,
    });
  }

  const registryRowFacts = new Map<string, { label: string; detail: string | null }>();
  const registryRowRows = await db
    .select({
      id: registryRows.id,
      docNameRaw: registryRows.docNameRaw,
      docNoRaw: registryRows.docNoRaw,
    })
    .from(registryRows)
    .where(eq(registryRows.folderId, folderId));
  for (const row of registryRowRows) {
    registryRowFacts.set(row.id, {
      label: row.docNameRaw,
      detail: row.docNoRaw === null ? null : `№ ${row.docNoRaw}`,
    });
  }

  // 5. Доказательства. Таблица заполняется с S9 и до сих пор не читалась ни
  //    одним маршрутом; это компенсация удаляемого раздела «Реквизиты»:
  //    «просрочена дата» становится «просрочена дата — в документе написано
  //    „действителен до 12.03.2024“».
  const evidence = new Map<string, FindingEvidenceView[]>();
  const evidencePageOf = new Map<string, string>();
  if (findingIds.length > 0) {
    const evidenceRows = await db
      .select({
        findingId: findingEvidence.findingId,
        pageTextVersionId: findingEvidence.pageTextVersionId,
        charSpan: findingEvidence.charSpan,
        quote: findingEvidence.quote,
        sourcePageId: pageTextVersions.sourcePageId,
      })
      .from(findingEvidence)
      .innerJoin(pageTextVersions, eq(findingEvidence.pageTextVersionId, pageTextVersions.id))
      .where(inArray(findingEvidence.findingId, [...findingIds]))
      .orderBy(asc(findingEvidence.findingId), asc(findingEvidence.charSpan));

    for (const row of evidenceRows) {
      const list = evidence.get(row.findingId);
      const node: FindingEvidenceView = {
        quote: row.quote,
        pageTextVersionId: row.pageTextVersionId,
        charSpan: { start: row.charSpan.start, end: row.charSpan.end },
      };
      // Не больше трёх цитат на замечание: экран показывает первую, остальные
      // нужны поддержке, а неограниченный список раздувает ответ на пустом месте.
      if (list === undefined) evidence.set(row.findingId, [node]);
      else if (list.length < EVIDENCE_PER_FINDING) list.push(node);
      if (!evidencePageOf.has(row.findingId)) evidencePageOf.set(row.findingId, row.sourcePageId);
    }
  }

  return {
    pages,
    documents,
    fields,
    materials: materialNames,
    batches: batchFacts,
    registryRows: registryRowFacts,
    evidence,
    evidencePageOf,
  };
}

const EVIDENCE_PER_FINDING = 3;

interface SubjectRow {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly sourcePageId: string | null;
}

interface ResolvedSubject {
  readonly page: FindingPageView | null;
  readonly document: FindingDocumentView | null;
  readonly target: FindingTargetView;
}

/**
 * Страница, документ и объект замечания.
 *
 * ## Откуда берётся страница
 *
 * Приоритет: явная страница замечания → страница доказательства → страница
 * реквизита → ПЕРВАЯ страница документа. Последняя ступень нужна: замечание
 * уровня документа («просрочена дата») страницы не имеет, а без неё половина
 * списка выпала бы из формы «Страница N — вид — что не так».
 *
 * Но выдавать начало документа за точное место ошибки нельзя — срок действия
 * может стоять на любом листе. Поэтому ступень названа в `basis`, и экран
 * пишет «Документ со стр. N», а не «Страница N». Врать точностью хуже, чем
 * признать приблизительность.
 *
 * ## Почему документ и объект разделены
 *
 * `target` бывает не документом: материал, партия, строка реестра. Колонка «Что
 * за документ», в которую положили бы имя материала, называлась бы неправдой.
 */
function resolveSubject(
  row: SubjectRow,
  context: FindingContext,
  evidence: readonly FindingEvidenceView[],
): ResolvedSubject {
  const target = describeTarget(row, context);
  const documentId = documentIdOf(row, context);
  const facts = documentId === null ? null : (context.documents.get(documentId) ?? null);
  const document: FindingDocumentView | null =
    documentId === null || facts === null
      ? null
      : { id: documentId, docTypeCode: facts.docTypeCode, label: facts.label };

  const evidencePageId = evidence.length > 0 ? (context.evidencePageOf.get(row.id) ?? null) : null;
  const fieldPageId =
    row.targetType === 'field_value' && row.targetId !== null
      ? (context.fields.get(row.targetId)?.pageId ?? null)
      : null;

  const candidates: readonly (readonly [string | null, FindingPageView['basis']])[] = [
    [row.sourcePageId, 'finding'],
    [evidencePageId, 'evidence'],
    [fieldPageId, 'field'],
    [facts?.firstPageId ?? null, 'document'],
  ];

  for (const [pageId, basis] of candidates) {
    if (pageId === null) continue;
    const page = context.pages.get(pageId);
    if (page === undefined) continue;
    return {
      page: { number: page.number, workingPageIndex: page.workingPageIndex, basis },
      document,
      target,
    };
  }

  return { page: null, document, target };
}

function documentIdOf(row: SubjectRow, context: FindingContext): string | null {
  if (row.targetType === 'document') return row.targetId;
  if (row.targetType === 'field_value' && row.targetId !== null) {
    return context.fields.get(row.targetId)?.documentId ?? null;
  }
  if (row.targetType === 'registry_row' && row.targetId !== null) {
    // Строка реестра принадлежит документу-реестру, но замечание о ней — про
    // отсутствующее приложение, а не про сам реестр. Документ здесь не
    // подставляется намеренно.
    return null;
  }
  // Замечание на страницу: документ у неё есть, если страница отнесена.
  if (row.sourcePageId !== null) {
    return context.pages.get(row.sourcePageId)?.documentId ?? null;
  }
  return null;
}

function describeTarget(row: SubjectRow, context: FindingContext): FindingTargetView {
  const gone: FindingTargetView = {
    kind: 'gone',
    label: 'Объект замечания пересобран после проверки',
    detail: null,
  };

  switch (row.targetType) {
    case 'folder':
      return { kind: 'folder', label: 'Комплект целиком', detail: null };
    case 'document': {
      if (row.targetId === null) return gone;
      const facts = context.documents.get(row.targetId);
      return facts === undefined ? gone : { kind: 'document', label: facts.label, detail: null };
    }
    case 'field_value': {
      if (row.targetId === null) return gone;
      const field = context.fields.get(row.targetId);
      if (field === undefined) return gone;
      const document = context.documents.get(field.documentId);
      return {
        kind: 'field',
        label: document?.label ?? 'Документ комплекта',
        detail: `реквизит «${field.fieldCode}»`,
      };
    }
    case 'material': {
      if (row.targetId === null) return gone;
      const name = context.materials.get(row.targetId);
      return name === undefined ? gone : { kind: 'material', label: name, detail: null };
    }
    case 'batch': {
      if (row.targetId === null) return gone;
      const facts = context.batches.get(row.targetId);
      return facts === undefined
        ? gone
        : { kind: 'batch', label: facts.material, detail: facts.detail };
    }
    case 'registry_row': {
      if (row.targetId === null) return gone;
      const facts = context.registryRows.get(row.targetId);
      return facts === undefined
        ? gone
        : { kind: 'registry_row', label: facts.label, detail: facts.detail };
    }
    case 'source_page': {
      const page = row.sourcePageId === null ? undefined : context.pages.get(row.sourcePageId);
      return page === undefined
        ? gone
        : { kind: 'page', label: `Страница ${String(page.number)}`, detail: null };
    }
    default:
      // Открытый мир §0.5: незнакомый код цели обязан быть виден, а не
      // подменяться прочерком, за которым не отличить новое от пустого.
      return { kind: 'gone', label: row.targetType, detail: null };
  }
}

/**
 * Снимок активной версии набора правил.
 *
 * Указатель на активную версию живёт в `app_settings` (`ruleset.active_version_id`)
 * и ставится администратором при публикации. `null` означает «активная версия не
 * назначена» — это состояние настройки, а не сбой, и прогон обязан отказаться с
 * названной причиной, а не отчитаться «замечаний нет».
 */
export async function loadActiveRulesetSnapshot(
  db: Database,
  scope: AuthScope,
): Promise<RulesetSnapshot | null> {
  const setting = await readSetting(db, scope, RULESET_ACTIVE_VERSION_KEY);
  const value = setting?.value ?? null;
  if (typeof value !== 'string' || value === '') return null;
  return loadRulesetSnapshot(db, value);
}
