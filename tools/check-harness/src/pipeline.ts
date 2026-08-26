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
  classifyPages,
  decodeSegmentation,
  extractFields,
  KNOWN_TYPE_MIN_CONFIDENCE,
  documentNumbersOf,
  matchRegistryRows,
  pagesNeedingLlm,
  parseAnnexRegistry,
  type ExtractedField,
  type MatchableDocument,
  type MatchRegistryResult,
  type PageClassification,
  type PageInput,
  type RegistryParseResult,
  type Segmentation,
} from '@id/api';
import {
  deriveMaterials,
  isFallbackCode,
  makeGraph,
  makeProfile,
  makeRevision,
  makeUnavailableRegistries,
  makeUnconfiguredProfile,
  RULE_CATALOG,
  runRules,
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
  readonly graph: CheckGraph;
  readonly rules: RuleRunResult;
  readonly anomalies: readonly string[];
}

/** Страница → вход фазы 1. Маппинг из `corpus-metrics.test.ts:48-63`. */
function toPageInputs(dir: string, source: ReturnType<typeof parseSourcePackage>): PageInput[] {
  return source.map((page) => ({
    sourcePageId: `p${page.pageNo}`,
    revisionOrdinal: page.pageNo - 1,
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

  // Задачи 17–18: разбор реестров и сверка по номеру.
  const registries: RegistryRunView[] = [];
  const registryRows: RegistryRowNode[] = [];

  for (const document of documents) {
    if (document.docTypeCode !== REGISTRY_TYPE) continue;
    const parsed = parseAnnexRegistry({ pages: extractionPagesOf.get(document.id) ?? [] });

    const matchable: readonly MatchableDocument[] = documents
      .filter((candidate) => candidate.id !== document.id)
      .map((candidate) => ({
        documentId: candidate.id,
        docTypeCode: candidate.docTypeCode,
        // Все формы номера, а не один `number`: у исполнительной схемы он
        // приходит шифром из штампа, и сверка обязана видеть его тоже.
        numbers: documentNumbersOf(candidate.fields),
        title: candidate.title,
      }));

    const match = matchRegistryRows(parsed.rows, matchable);
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
              : 'missing',
      });
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

  const graph = makeGraph({
    profile: options.unconfiguredProfile ? makeUnconfiguredProfile() : makeProfile(),
    revision: makeRevision(),
    documents,
    registryRows,
    relations,
    materials,
    external: makeUnavailableRegistries(),
    counterparties: [],
    rdDocuments: [],
    today: options.today,
    hasRecognizedText: true,
  });

  // Задача 20: полный каталог, все правила включены (`enabledRuleCodes: null`
  // — «ограничений нет», см. `checks.run` в apps/worker/src/jobs/checks.ts).
  const rules = runRules(graph, {
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
    graph,
    rules,
    anomalies,
  };
}
