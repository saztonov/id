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
  rdDocuments,
  registryRows,
  ruleDefinitions,
  rulesetRules,
  rulesetVersions,
  sourcePages,
  submissionRevisions,
  works,
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

const REVISION_SCOPE: ScopeTarget = {
  objectId: submissionRevisions.objectId,
  contractorId: submissionRevisions.contractorId,
};

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

/** Ревизия с разделом и видом раздела: корень графа. */
interface RevisionContext {
  readonly id: string;
  readonly objectId: string;
  readonly contractorId: string;
  readonly sectionCode: string;
  /** Наименование работы: попадает в тексты замечаний вместо кода тома. */
  readonly workTitle: string;
  /** Месяц комплекта, `ГГГГ-ММ-01`: с ним сверяются даты актов (`AOSR.ACT.032`). */
  readonly period: string;
  readonly status: string;
}

async function loadRevisionContext(
  db: Database,
  scope: AuthScope,
  revisionId: string,
): Promise<RevisionContext> {
  const rows = await db
    .select({
      id: submissionRevisions.id,
      objectId: submissionRevisions.objectId,
      contractorId: submissionRevisions.contractorId,
      sectionCode: works.sectionCode,
      workTitle: works.title,
      // Дата без времени: месяц — это `ГГГГ-ММ-01`, а не метка времени, и
      // `to_char` здесь тот же, что в `WORK_SELECTION` навигации. Без него
      // драйвер отдал бы `Date`, и правило сравнивало бы объект со строкой.
      period: sql<string>`to_char(${works.period}, 'YYYY-MM-DD')`.as('work_period'),
      status: submissionRevisions.status,
    })
    .from(submissionRevisions)
    .innerJoin(works, eq(submissionRevisions.workId, works.id))
    .where(withScope(scope, REVISION_SCOPE, eq(submissionRevisions.id, revisionId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound('Ревизия комплекта не найдена.');
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
async function loadFields(db: Database, revisionId: string): Promise<Map<string, FieldNode[]>> {
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
    .where(eq(fieldValues.revisionId, revisionId))
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
  input: { readonly revisionId: string; readonly today: string },
): Promise<Omit<CheckGraph, 'external'>> {
  const revision = await loadRevisionContext(db, scope, input.revisionId);

  const rules = await resolveEffectiveRules(
    db,
    scope,
    { objectId: revision.objectId, sectionCode: revision.sectionCode },
    input.today,
  );
  if (rules === null) {
    throw internal({ logDetail: `раздел ${revision.sectionCode} не разрешился для объекта` });
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
    .where(eq(constructionObjects.id, revision.objectId))
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
      .where(eq(rdDocuments.objectId, revision.objectId))
      .orderBy(asc(rdDocuments.cipher))
  ).map((row) => ({ ...row, name: row.name ?? row.cipher }));

  const documentRows = await db
    .select({
      id: logicalDocuments.id,
      ordinal: logicalDocuments.ordinal,
      docTypeCode: logicalDocuments.docTypeCode,
      title: logicalDocuments.title,
      typeConfidence: logicalDocuments.typeConfidence,
      boundaryConfidence: logicalDocuments.boundaryConfidence,
      needsReview: logicalDocuments.needsReview,
      isConfirmed: logicalDocuments.isConfirmed,
    })
    .from(logicalDocuments)
    .where(eq(logicalDocuments.revisionId, input.revisionId))
    .orderBy(asc(logicalDocuments.ordinal));

  const pageRows = await db
    .select({
      documentId: pageAssignments.documentId,
      sourcePageId: pageAssignments.sourcePageId,
      sortOrder: pageAssignments.sortOrder,
      pageRoleCode: pageAssignments.pageRoleCode,
    })
    .from(pageAssignments)
    .where(eq(pageAssignments.revisionId, input.revisionId))
    .orderBy(asc(pageAssignments.sortOrder));

  const fieldsByDocument = await loadFields(db, input.revisionId);

  const documents: readonly DocumentNode[] = documentRows.map((row) => {
    const code = row.docTypeCode;
    const fallback = isFallbackCode(code);
    const confident =
      row.typeConfidence === null || row.typeConfidence >= KNOWN_TYPE_MIN_CONFIDENCE;
    return {
      id: row.id,
      ordinal: row.ordinal,
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

  const registryRowsData: readonly RegistryRowNode[] = (
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
      .where(eq(registryRows.revisionId, input.revisionId))
      .orderBy(asc(registryRows.documentId), asc(registryRows.ordinal))
  ).map((row) => ({ ...row, matchState: row.matchState as RegistryRowNode['matchState'] }));

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
    .where(eq(sourcePages.revisionId, input.revisionId));

  return {
    revision,
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
    registryRows: registryRowsData,
    relations,
    materials: [],
    today: input.today,
    hasRecognizedText: Number(hasText[0]?.count ?? 0) > 0,
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
  input: { readonly revisionId: string; readonly documents: readonly DocumentNode[] },
): Promise<SaveMaterialsOutcome> {
  await loadRevisionContext(db, scope, input.revisionId);

  let materialSeq = 0;
  let batchSeq = 0;
  const draft = deriveMaterials(input.documents, {
    materialId: () => `m${String((materialSeq += 1))}`,
    batchId: (materialId, key) => `${materialId}:b${String((batchSeq += 1))}:${key}`,
  });

  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(materials)
      .where(eq(materials.revisionId, input.revisionId))
      .returning({ id: materials.id });

    const nodes: MaterialNode[] = [];
    let batchCount = 0;
    let linkCount = 0;

    for (const material of draft) {
      const inserted = await tx
        .insert(materials)
        .values({
          revisionId: input.revisionId,
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
              revisionId: input.revisionId,
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
            revisionId: input.revisionId,
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
  readonly revisionId: string;
  readonly rulesetVersionId: string;
  readonly sectionProfileId: string | null;
  readonly objectRuleProfileId: string | null;
}

export async function startValidationRun(
  db: Database,
  scope: AuthScope,
  input: StartValidationRunInput,
): Promise<{ readonly id: string }> {
  await loadRevisionContext(db, scope, input.revisionId);

  const rows = await db
    .insert(validationRuns)
    .values({
      revisionId: input.revisionId,
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
    readonly revisionId: string;
    readonly findings: readonly PreparedFinding[];
  },
): Promise<SaveFindingsOutcome> {
  const revision = await loadRevisionContext(db, scope, input.revisionId);

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
          revisionId: input.revisionId,
          objectId: revision.objectId,
          contractorId: revision.contractorId,
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
    readonly revisionId: string;
    readonly findings: readonly PreparedFinding[];
  },
): Promise<SaveFindingsOutcome> {
  const revision = await loadRevisionContext(db, scope, input.revisionId);

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
          revisionId: input.revisionId,
          objectId: revision.objectId,
          contractorId: revision.contractorId,
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
    readonly revisionId: string;
    readonly journal: RuleExecutionJournal;
  },
): Promise<void> {
  await loadRevisionContext(db, scope, input.revisionId);

  const updated = await db
    .update(validationRuns)
    .set({ counts: { journal: input.journal } })
    .where(
      and(
        eq(validationRuns.id, input.validationRunId),
        eq(validationRuns.revisionId, input.revisionId),
      ),
    )
    .returning({ id: validationRuns.id });

  if (updated.length === 0) throw notFound('Прогон проверок не найден.');
}

/** Журнал прогона; `null` — задача 20 его не записала. */
export async function loadRunJournal(
  db: Database,
  scope: AuthScope,
  input: { readonly validationRunId: string; readonly revisionId: string },
): Promise<RuleExecutionJournal | null> {
  await loadRevisionContext(db, scope, input.revisionId);

  const rows = await db
    .select({ counts: validationRuns.counts })
    .from(validationRuns)
    .where(
      and(
        eq(validationRuns.id, input.validationRunId),
        eq(validationRuns.revisionId, input.revisionId),
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
    readonly revisionId: string;
    readonly summary: ValidationSummary;
  },
): Promise<void> {
  await loadRevisionContext(db, scope, input.revisionId);

  const updated = await db
    .update(validationRuns)
    .set({ finishedAt: sql`now()`, counts: input.summary })
    .where(
      and(
        eq(validationRuns.id, input.validationRunId),
        eq(validationRuns.revisionId, input.revisionId),
      ),
    )
    .returning({ id: validationRuns.id });

  if (updated.length === 0) {
    throw notFound('Прогон проверок не найден.');
  }
}

export interface ValidationRunView {
  readonly id: string;
  readonly revisionId: string;
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
  revisionId: string,
): Promise<readonly ValidationRunView[]> {
  const rows = await db
    .select({
      id: validationRuns.id,
      revisionId: validationRuns.revisionId,
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
    .innerJoin(submissionRevisions, eq(validationRuns.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, eq(validationRuns.revisionId, revisionId)))
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
}

export async function listFindings(
  db: Database,
  scope: AuthScope,
  input: { readonly revisionId: string; readonly validationRunId?: string | undefined },
): Promise<readonly FindingView[]> {
  const conditions =
    input.validationRunId === undefined
      ? [eq(findings.revisionId, input.revisionId)]
      : [
          eq(findings.revisionId, input.revisionId),
          eq(findings.validationRunId, input.validationRunId),
        ];

  const rows = await db
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
    .innerJoin(submissionRevisions, eq(findings.revisionId, submissionRevisions.id))
    .where(withScope(scope, REVISION_SCOPE, ...conditions))
    .orderBy(asc(findings.ruleCode), asc(findings.createdAt));

  // Приведение к закрытым перечислениям: значения держат CHECK-ограничения
  // 0006, и расширять их можно только миграцией.
  return rows.map((row) => ({
    ...row,
    severity: row.severity as FindingSeverity,
    state: row.state as FindingView['state'],
    origin: row.origin as FindingOrigin,
  }));
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
