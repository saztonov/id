/**
 * Сквозной офлайн-прогон проверок по одному пакету `temp/MD`.
 *
 * Повторяет прод-конвейер (задачи 14 → 16 → 17 → 18 → 19 → 20) на настоящих
 * функциях портала — `classifyPages`, `decodeSegmentation`, `extractFields`,
 * `parseAnnexRegistry`, `matchRegistryRows`, `runRules` — но без БД: граф
 * собирается зеркалом `loadCheckGraph` поверх выходов этих функций.
 *
 * Чего здесь НЕТ по построению:
 * * LLM-фазы сегментации — страницы, которым она нужна, считаются метрикой
 *   `llmPending`, а не дефектом (как в `corpus-metrics.test.ts`);
 * * контрагентов, шифров РД и внешних реестров — их даёт только БД; правила,
 *   которым они нужны, дают предсказуемые `undetermined`/`n_a`, и отчёт
 *   помечает их как ожидаемый офлайн-шум.
 */
import { basename } from 'node:path';

import {
  annexCandidates,
  classifyPages,
  decodeSegmentation,
  extractFields,
  KNOWN_TYPE_MIN_CONFIDENCE,
  documentNumbersOf,
  matchRegistryRows,
  transferPartitions,
  matchTransferGroups,
  pagesNeedingLlm,
  parseAnnexRegistry,
  parseTransferRegistry,
  planComplects,
  toRegistryRows,
  TRANSFER_TYPE,
  type ExtractedField,
  type MatchRegistryResult,
  type PageClassification,
  type PageInput,
  type RegistryParseResult,
  type ScopedDocument,
  type Segmentation,
  type TransferGroupCandidate,
  type TransferGroupsOutcome,
  type TransferParseResult,
} from '@id/api';
import { isAnalysisAnchor } from '@id/doc-types';
import {
  deriveMaterials,
  isFallbackCode,
  makeGraph,
  makeProfile,
  makeFolder,
  makeUnavailableRegistries,
  makeUnconfiguredProfile,
  RULE_CATALOG,
  runRulesByComplect,
  snapshotOf,
  type CheckGraph,
  type DocumentNode,
  type FieldNode,
  type RegistryRowNode,
  type RuleRunResult,
} from '@id/rules';
import { parseSourcePackage } from '@id/fixtures';

import { deriveOfflineRelations } from './relations.js';

/**
 * Зеркало порога задачи 16 (`apps/worker/src/jobs/segmentation.ts:752`,
 * `TYPE_CONFIDENT_THRESHOLD`): типо-специфичная схема извлечения применяется
 * только к уверенно типизированному документу.
 */
const TYPE_CONFIDENT_THRESHOLD = 0.7;

const REGISTRY_TYPE = 'annex_registry';

export interface HarnessOptions {
  /** Дата прогона `YYYY-MM-DD` — вход правил дат, фиксируется явно. */
  readonly today: string;
  /** Прогнать со строкой 2 матрицы §9.1: раздел без настроенного профиля. */
  readonly unconfiguredProfile: boolean;
}

export interface RegistryRunView {
  readonly documentId: string;
  readonly documentOrdinal: number;
  readonly parsed: RegistryParseResult;
  readonly match: MatchRegistryResult;
}

/**
 * Разбор описи передачи и сопоставление её разделов с комплектами (S50).
 *
 * До S50 стенд описи не касался вовсе: правила REG.110–112 на нём всегда
 * отвечали «в папке нет описи», и главный вопрос — «сходится ли состав папки с
 * тем, что перечислено в общем реестре» — офлайн не проверялся ни разу. Разбор
 * тот же, что в задаче 17 воркера, и берётся он из портала, а не пишется здесь
 * заново.
 */
export interface TransferRunView {
  readonly documentId: string;
  readonly documentOrdinal: number;
  readonly parsed: TransferParseResult;
  readonly outcome: TransferGroupsOutcome;
}

export interface PackageRunResult {
  readonly packageDir: string;
  readonly packageName: string;
  readonly options: HarnessOptions;
  readonly pages: readonly PageInput[];
  readonly classifications: readonly PageClassification[];
  readonly segmentation: Segmentation;
  /** Страницы, которым нужна LLM-фаза (здесь она не выполняется). */
  readonly llmPending: number;
  readonly typeConfidentByDocument: ReadonlyMap<string, boolean>;
  readonly fieldsByDocument: ReadonlyMap<string, readonly ExtractedField[]>;
  readonly registries: readonly RegistryRunView[];
  readonly transfers: readonly TransferRunView[];
  readonly graph: CheckGraph;
  readonly rules: RuleRunResult;
  readonly anomalies: readonly string[];
}

/** Страница → вход фазы 1. Маппинг из `corpus-metrics.test.ts:48-63`. */
function toPageInputs(dir: string, source: ReturnType<typeof parseSourcePackage>): PageInput[] {
  return source.map((page) => ({
    sourcePageId: `p${page.pageNo}`,
    folderOrdinal: page.pageNo - 1,
    sourceFileId: basename(dir),
    filePageIndex: page.pageNo - 1,
    // Ненулевая версия текста обязательна: без неё `extractFields` не строит
    // доказательств и `FieldNode.charSpan`/`quote` уходят в граф пустыми.
    // Исключение — страница без текста (нет блоков): у неё версии нет и в
    // проде (`page_text_versions` не создаётся).
    pageTextVersionId: page.text === '' ? null : `ptv-${page.pageNo}`,
    text: page.text,
    blockTypes: page.blockTypes,
    rotation: page.rotation,
    manual: null,
  }));
}

function toFieldNode(
  field: ExtractedField,
  id: string,
  ptvToPage: ReadonlyMap<string, string>,
): FieldNode {
  return {
    id,
    fieldCode: field.fieldCode,
    valueText: field.valueText,
    valueDate: field.valueDate,
    valueNum: field.valueNum === null ? null : Number(field.valueNum),
    valueJson: field.valueJson,
    confidence: field.confidence,
    isVerified: false,
    extractedBy: field.extractedBy,
    pageTextVersionId: field.evidence?.pageTextVersionId ?? null,
    charSpan:
      field.evidence === null
        ? null
        : { start: field.evidence.charStart, end: field.evidence.charEnd },
    quote: field.evidence?.quote ?? null,
    sourcePageId:
      field.evidence === null ? null : (ptvToPage.get(field.evidence.pageTextVersionId) ?? null),
    // Извлечение идёт по тексту страницы, а не по блоку: в проде у rule-полей
    // `source_block_id` тоже пуст (`loadFields`, checks.ts), поэтому null.
    blockType: null,
    blockId: null,
  };
}

export function runPackage(dir: string, options: HarnessOptions): PackageRunResult {
  const source = parseSourcePackage(dir);
  const pages = toPageInputs(dir, source);
  const pageById = new Map(pages.map((page) => [page.sourcePageId, page]));
  const ptvToPage = new Map(
    pages.flatMap((page) =>
      page.pageTextVersionId === null ? [] : [[page.pageTextVersionId, page.sourcePageId] as const],
    ),
  );

  // Фазы 1 и 3 сегментации — как задачи 14–15 (без LLM-фазы 2).
  const classifications = classifyPages(pages);
  const llmPending = pagesNeedingLlm(classifications).length;
  const segmentation = decodeSegmentation(pages, classifications);
  const textBySourcePage = new Map(pages.map((page) => [page.sourcePageId, page.text] as const));

  // Задача 16: извлечение реквизитов по каждому документу.
  const typeConfidentByDocument = new Map<string, boolean>();
  const fieldsByDocument = new Map<string, readonly ExtractedField[]>();
  const extractionPagesOf = new Map<
    string,
    readonly { sourcePageId: string; pageTextVersionId: string | null; text: string }[]
  >();

  for (const document of segmentation.documents) {
    const documentId = `doc-${document.ordinal}`;
    const docPages = [...document.pages]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((page) => pageById.get(page.sourcePageId))
      .filter((page): page is PageInput => page !== undefined)
      .map((page) => ({
        sourcePageId: page.sourcePageId,
        pageTextVersionId: page.pageTextVersionId,
        text: page.text,
      }));
    extractionPagesOf.set(documentId, docPages);

    // Зеркало условия задачи 16 (segmentation.ts:800-804).
    const typeConfident =
      document.docTypeCode !== null &&
      !isFallbackCode(document.docTypeCode) &&
      !document.needsReview &&
      (document.typeConfidence ?? 0) >= TYPE_CONFIDENT_THRESHOLD;
    typeConfidentByDocument.set(documentId, typeConfident);

    const fields = extractFields({
      docTypeCode: document.docTypeCode,
      typeConfident,
      pages: docPages,
    });
    fieldsByDocument.set(documentId, fields);
  }

  /**
   * Нарезка на комплекты — зеркало `applySegmentation` (S44).
   *
   * Стенд обязан судить папку тем же разбиением, что и портал: без него проверки
   * шли бы по всей папке разом, и числа стенда разошлись бы с боевыми ровно там,
   * где разбиение и заведено.
   */
  const complectPlan = planComplects(
    segmentation.documents.map((document) => ({
      ordinal: document.ordinal,
      docTypeCode: document.docTypeCode,
    })),
  );
  const complectByOrdinal = new Map<number, string>();
  for (const group of complectPlan.groups) {
    for (const ordinal of group.documentOrdinals) {
      complectByOrdinal.set(ordinal, `complect-${String(group.ordinal)}`);
    }
  }

  // Узлы документов — зеркало `loadCheckGraph` (checks.ts:376-404).
  const documents: readonly DocumentNode[] = segmentation.documents.map((document) => {
    const documentId = `doc-${document.ordinal}`;
    const code = document.docTypeCode;
    const fallback = isFallbackCode(code);
    const confident =
      document.typeConfidence === null || document.typeConfidence >= KNOWN_TYPE_MIN_CONFIDENCE;
    const fields = (fieldsByDocument.get(documentId) ?? []).map((field, index) =>
      toFieldNode(field, `fld-${document.ordinal}-${index + 1}`, ptvToPage),
    );
    return {
      id: documentId,
      ordinal: document.ordinal,
      complectId: complectByOrdinal.get(document.ordinal) ?? null,
      docTypeCode: code,
      isKnownType: code !== null && !fallback && confident && !document.needsReview,
      isFallbackType: fallback,
      title: document.title,
      typeConfidence: document.typeConfidence,
      boundaryConfidence: document.boundaryConfidence,
      needsReview: document.needsReview,
      isConfirmed: false,
      pages: document.pages,
      fields,
    };
  });

  /**
   * Документы в том виде, в каком о них судит выборка кандидатов.
   *
   * Правило выборки берётся из портала (`@id/api`, `candidates.ts`), а не
   * пишется здесь заново: свои копии стенда и воркера разошлись молча, и
   * мутация сверки на стенде из-за этого не краснела (S53).
   */
  const scoped: readonly ScopedDocument[] = documents.map((document) => ({
    documentId: document.id,
    docTypeCode: document.docTypeCode,
    complectId: document.complectId,
    // Все формы номера, а не один `number`: у исполнительной схемы он приходит
    // шифром из штампа, и сверка обязана видеть его тоже.
    numbers: documentNumbersOf(document.fields),
    issuedAt: document.fields.find((field) => field.fieldCode === 'issued_at')?.valueDate ?? null,
    title: document.title,
  }));

  // Задачи 17–18: разбор реестров и сверка по номеру.
  const registries: RegistryRunView[] = [];
  const registryRows: RegistryRowNode[] = [];

  for (const document of documents) {
    if (document.docTypeCode !== REGISTRY_TYPE) continue;
    const parsed = parseAnnexRegistry({ pages: extractionPagesOf.get(document.id) ?? [] });

    const match = matchRegistryRows(parsed.rows, annexCandidates(scoped, document.complectId));
    registries.push({
      documentId: document.id,
      documentOrdinal: document.ordinal,
      parsed,
      match,
    });

    for (const [index, row] of parsed.rows.entries()) {
      const decision = match.rows[index];
      registryRows.push({
        id: `row-${document.ordinal}-${index + 1}`,
        registryDocumentId: document.id,
        ordinal: index + 1,
        rowNo: row.rowNo,
        sectionTitle: row.sectionTitle,
        docNameRaw: row.docNameRaw,
        docNoRaw: row.docNoRaw,
        docNoNorm: row.docNoNorm,
        docNoFolded: row.docNoFolded,
        orgRaw: row.orgRaw,
        validFrom: row.validFrom,
        validTo: row.validTo,
        issuedAt: row.issuedAt,
        matchedDocumentId: decision?.matchedDocumentId ?? null,
        matchScore: decision?.matchScore ?? null,
        // `RegistryRowNode` не знает состояния `extra` — оно относится к
        // документам, а не строкам; воркер делает то же (segmentation.ts:998).
        matchState:
          decision?.matchState === 'matched'
            ? 'matched'
            : decision?.matchState === 'ambiguous'
              ? 'ambiguous'
              : decision?.matchState === 'candidate'
                ? 'candidate'
                : 'missing',
        candidateDocumentIds: (decision?.candidates ?? []).map((candidate) => candidate.documentId),
        // Стенд разбирает только реестры приложений: у их строк комплект один
        // на весь перечень и в строке не хранится (его несут строки описи).
        complectId: null,
      });
    }
  }

  /**
   * Опись передачи: разбор и привязка её разделов к комплектам (S50).
   *
   * Кандидатами идут комплекты — по одному на акт, — и номера берутся из
   * реквизитов акта, как в задаче 17 воркера. Наименование работы и исполнитель
   * передаются настоящими: без них у сопоставления живёт только ступень номера,
   * и раздел, номер которого распознан с ошибкой, теряет комплект вместе со
   * всеми своими строками.
   */
  const transfers: TransferRunView[] = [];
  const transferRows: RegistryRowNode[] = [];

  for (const document of documents) {
    if (document.docTypeCode !== TRANSFER_TYPE) continue;
    const parsed = parseTransferRegistry({ pages: extractionPagesOf.get(document.id) ?? [] });

    const candidates: TransferGroupCandidate[] = documents
      .filter(
        (candidate) => isAnalysisAnchor(candidate.docTypeCode) && candidate.complectId !== null,
      )
      .map((candidate) => ({
        workId: candidate.complectId as string,
        folderId: 'folder-1',
        // Контрагентов у стенда нет: справочник — свойство базы, а не разбора.
        contractorId: 'contractor-1',
        contractorName:
          candidate.fields.find((field) => field.fieldCode === 'contractor_name')?.valueText ??
          null,
        title: candidate.fields.find((field) => field.fieldCode === 'p1_works')?.valueText ?? '',
        actNumbers: documentNumbersOf(candidate.fields),
      }));

    const outcome = matchTransferGroups(parsed.groups, candidates);
    transfers.push({
      documentId: document.id,
      documentOrdinal: document.ordinal,
      parsed,
      outcome,
    });

    for (const [index, row] of toRegistryRows(parsed, outcome).entries()) {
      transferRows.push({
        id: `transfer-${document.ordinal}-${index + 1}`,
        registryDocumentId: document.id,
        ordinal: index + 1,
        rowNo: row.rowNo,
        sectionTitle: row.sectionTitle,
        docNameRaw: row.docNameRaw,
        docNoRaw: row.docNoRaw,
        docNoNorm: row.docNoNorm,
        docNoFolded: row.docNoFolded,
        orgRaw: row.orgRaw,
        validFrom: row.validFrom,
        validTo: row.validTo,
        issuedAt: row.issuedAt,
        // Сверка строк описи с документами — задача 18 воркера; стенд считает
        // её отдельно ниже, чтобы кандидаты ограничивались своим комплектом.
        matchedDocumentId: null,
        matchScore: null,
        matchState: 'missing',
        candidateDocumentIds: [],
        complectId: row.complectId ?? null,
      });
    }
  }

  /**
   * Строки описи сверяются ВНУТРИ своего комплекта (S50), раздел без акта — по
   * всей папке (S53).
   *
   * Раздел, привязанный к комплекту, ищет свои документы только среди его
   * документов: двенадцать одинаковых паспортов одной папки иначе дают
   * «неоднозначно» на каждой строке. Разбиение берётся у портала — прежде
   * стенд строки без комплекта просто пропускал, то есть молча объявлял их
   * ненайденными, а воркер искал их по всей папке.
   */
  const transferRowIndex = new Map(transferRows.map((row, index) => [row.id, index] as const));
  for (const partition of transferPartitions(scoped, transferRows)) {
    const outcome = matchRegistryRows(
      partition.rows.map((row) => ({
        rowNo: row.rowNo,
        sectionTitle: row.sectionTitle,
        docNameRaw: row.docNameRaw,
        docNoRaw: row.docNoRaw,
        docNoNorm: row.docNoNorm,
        docNoFolded: row.docNoFolded,
        orgRaw: row.orgRaw,
        validFrom: row.validFrom,
        validTo: row.validTo,
        issuedAt: row.issuedAt,
      })),
      partition.documents,
    );

    for (const [position, decision] of outcome.rows.entries()) {
      const row = partition.rows[position];
      if (row === undefined) continue;
      const index = transferRowIndex.get(row.id);
      if (index === undefined) continue;
      transferRows[index] = {
        ...row,
        matchedDocumentId: decision.matchedDocumentId,
        matchScore: decision.matchScore,
        matchState:
          decision.matchState === 'matched'
            ? 'matched'
            : decision.matchState === 'ambiguous'
              ? 'ambiguous'
              : decision.matchState === 'candidate'
                ? 'candidate'
                : 'missing',
        candidateDocumentIds: decision.candidates.map((candidate) => candidate.documentId),
      };
    }
  }
  // Задача 19: связи. Затем материалы — как в задаче 20 (checks.ts:507).
  const relations = deriveOfflineRelations(documents, registryRows);

  let materialSeq = 0;
  const batchSeqOf = new Map<string, number>();
  const materials = deriveMaterials(documents, {
    materialId: () => {
      materialSeq += 1;
      return `mat-${materialSeq}`;
    },
    batchId: (materialId: string) => {
      const next = (batchSeqOf.get(materialId) ?? 0) + 1;
      batchSeqOf.set(materialId, next);
      return `${materialId}-b${next}`;
    },
  });

  /**
   * Пробелы покрытия с адресом комплекта — зеркало `checks.ts` (S50).
   *
   * Комплект здесь тоже непрерывный отрезок листов: лист без документа
   * принадлежит комплекту, чьи страницы идут перед ним. Стенд обязан считать
   * это тем же правилом, что и портал, иначе его числа разойдутся с боевыми
   * ровно там, где проверяется устойчивость к потерянному листу.
   */
  const coverage = ((): {
    total: number;
    byComplect: Record<string, number>;
    outside: number;
  } => {
    const complectOfPage = new Map<string, string | null>();
    for (const document of documents) {
      for (const page of document.pages) complectOfPage.set(page.sourcePageId, document.complectId);
    }
    const gaps = new Set(
      segmentation.unassigned
        .filter((page) => (textBySourcePage.get(page.sourcePageId) ?? '').trim() !== '')
        .map((page) => page.sourcePageId),
    );

    const byComplect: Record<string, number> = {};
    let outside = 0;
    let current: string | null = null;
    for (const page of pages) {
      const own = complectOfPage.get(page.sourcePageId);
      if (own !== undefined && own !== null) current = own;
      if (!gaps.has(page.sourcePageId)) continue;
      if (current === null) {
        outside += 1;
        continue;
      }
      byComplect[current] = (byComplect[current] ?? 0) + 1;
    }
    return { total: gaps.size, byComplect, outside };
  })();
  const graph = makeGraph({
    profile: options.unconfiguredProfile ? makeUnconfiguredProfile() : makeProfile(),
    folder: makeFolder(),
    documents,
    registryRows,
    transferRows,
    relations,
    materials,
    external: makeUnavailableRegistries(),
    counterparties: [],
    rdDocuments: [],
    today: options.today,
    hasRecognizedText: true,
    // Пробел покрытия офлайн считается так же, как в БД (`checks.ts`): лист,
    // не отнесённый ни к одному документу, при том что содержание на нём есть.
    // Пустой оборот не считается: он разобран, и на нём действительно ничего
    // нет.
    coverageGaps: coverage.total,
    coverageGapsByComplect: coverage.byComplect,
    coverageGapsOutside: coverage.outside,
  });

  // Задача 20: полный каталог, все правила включены (`enabledRuleCodes: null`
  // — «ограничений нет», см. `checks.run` в apps/worker/src/jobs/checks.ts).
  const rules = runRulesByComplect(graph, {
    specs: RULE_CATALOG,
    snapshot: snapshotOf(RULE_CATALOG),
    enabledRuleCodes: null,
  });

  const anomalies: string[] = [];
  for (const page of pages) {
    if (page.text.trim() === '') anomalies.push(`страница ${page.sourcePageId}: пустой текст`);
    if (page.blockTypes.length === 0)
      anomalies.push(`страница ${page.sourcePageId}: нет блоков в blocks.json`);
  }
  const handwriting = pages.filter((page) => page.text.includes('[Handwritten')).length;
  if (handwriting > 0) anomalies.push(`страниц с пометкой рукописи: ${handwriting}`);
  const hardroller = pages.filter((page) => page.text.includes('HARDROLLER')).length;
  if (hardroller > 0) anomalies.push(`страниц с подписью HARDROLLER: ${hardroller}`);

  return {
    packageDir: dir,
    packageName: basename(dir),
    options,
    pages,
    classifications,
    segmentation,
    llmPending,
    typeConfidentByDocument,
    fieldsByDocument,
    registries,
    transfers,
    graph,
    rules,
    anomalies,
  };
}
