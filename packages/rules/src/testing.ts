/**
 * Конструкторы графа для тестов и для отладочных прогонов.
 *
 * Лежит в `src`, а не в тестах, намеренно: граф собирают тесты трёх групп
 * правил, тесты движка, тесты задач воркера и регрессия семи известных дефектов
 * корпуса. Четыре копии конструктора разъехались бы, и «граф в тесте» перестал
 * бы означать «граф, который приходит из БД» — тот же класс отказа, из-за
 * которого на S5 девять тестовых адаптеров pglite скрывали дефект продакшна.
 *
 * Значения по умолчанию выбраны безобидными: пустой комплект, настроенный
 * профиль, недоступные внешние реестры. Тест дополняет ровно то, что проверяет,
 * и тогда упавший тест указывает на изменённое поле, а не на фон.
 */
import { normalizeDocNo } from '@id/contracts';
import { NO_SOURCE_REASON } from './external.js';
import type {
  BatchNode,
  CheckGraph,
  CounterpartyNode,
  DocumentNode,
  ExternalRegistriesSnapshot,
  FieldNode,
  MaterialNode,
  ObjectNode,
  ProfileNode,
  RdDocumentNode,
  RegistryRowNode,
  RelationNode,
  FolderNode,
  RuleSnapshotEntry,
  RuleSpec,
} from './types.js';

let counter = 0;

/** Детерминированный идентификатор: тесты сравнивают тексты замечаний. */
export function testId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, '0')}`;
}

export function resetTestIds(): void {
  counter = 0;
}

export function makeField(patch: Partial<FieldNode> & { readonly fieldCode: string }): FieldNode {
  return {
    id: testId('fld'),
    valueText: null,
    valueDate: null,
    valueNum: null,
    valueJson: null,
    confidence: 0.95,
    isVerified: false,
    extractedBy: 'rule',
    pageTextVersionId: 'ptv-1',
    charSpan: { start: 0, end: 10 },
    quote: 'цитата',
    sourcePageId: 'page-1',
    blockType: 'text',
    blockId: 'block-1',
    ...patch,
  };
}

export function makeDocument(patch: Partial<DocumentNode> = {}): DocumentNode {
  const code = patch.docTypeCode ?? null;
  return {
    id: testId('doc'),
    ordinal: 1,
    complectId: null,
    docTypeCode: code,
    isKnownType: code !== null,
    isFallbackType: false,
    title: null,
    typeConfidence: 0.9,
    boundaryConfidence: 0.9,
    needsReview: false,
    isConfirmed: false,
    pages: [{ sourcePageId: 'page-1', sortOrder: 0, pageRoleCode: null }],
    fields: [],
    ...patch,
  };
}

export function makeBatch(patch: Partial<BatchNode> = {}): BatchNode {
  return {
    id: testId('batch'),
    materialId: 'mat-1',
    batchNo: null,
    heatNo: null,
    manufacturedAt: null,
    documentIds: [],
    ...patch,
  };
}

export function makeMaterial(patch: Partial<MaterialNode> = {}): MaterialNode {
  return {
    id: testId('mat'),
    nameRaw: 'Материал',
    nameNorm: 'МАТЕРИАЛ',
    mark: null,
    categoryCode: null,
    batches: [],
    documentIds: [],
    ...patch,
  };
}

/**
 * Строка реестра приложений.
 *
 * Сравнимые формы номера выводятся из `docNoRaw` той же `normalizeDocNo`, что
 * и в разборе реестра, — если тест не задал их сам. Иначе фикстура описывала бы
 * состояние, которого конвейер не порождает: номер напечатан, а сравнить его
 * нечем. Такое состояние законно ровно для «б/н», и выражается оно явным
 * `docNoNorm: null`.
 */
export function makeRegistryRow(patch: Partial<RegistryRowNode> = {}): RegistryRowNode {
  const raw = 'docNoRaw' in patch ? (patch.docNoRaw ?? null) : null;
  const derived = raw === null ? null : normalizeDocNo(raw);

  return {
    id: testId('row'),
    registryDocumentId: 'doc-registry',
    ordinal: 1,
    rowNo: 1,
    sectionTitle: null,
    docNameRaw: 'Документ о качестве',
    docNoRaw: null,
    docNoNorm: derived?.normalized ?? null,
    docNoFolded: derived?.folded ?? null,
    complectId: null,
    orgRaw: null,
    validFrom: null,
    validTo: null,
    issuedAt: null,
    matchedDocumentId: null,
    matchScore: null,
    matchState: 'missing',
    candidateDocumentIds: [],
    ...patch,
  };
}

export function makeObject(patch: Partial<ObjectNode> = {}): ObjectNode {
  return {
    id: 'obj-1',
    code: 'OBJ01',
    name: 'Объект',
    fullName: null,
    address: null,
    isActive: true,
    actNumberPattern: null,
    developerId: null,
    techCustomerId: null,
    generalContractorId: null,
    ...patch,
  };
}

export function makeCounterparty(patch: Partial<CounterpartyNode> = {}): CounterpartyNode {
  return {
    id: testId('cp'),
    name: 'Подрядчик',
    inn: null,
    kpp: null,
    ogrn: null,
    kind: 'contractor',
    isActive: true,
    ...patch,
  };
}

export function makeFolder(patch: Partial<FolderNode> = {}): FolderNode {
  return {
    id: 'rev-1',
    objectId: 'obj-1',
    contractorId: 'cp-1',
    sectionCode: 'roofing',
    folderTitle: 'Кровля автостоянки',
    ...patch,
  };
}

/** Профиль настроен: строка 2 матрицы §9.1 не срабатывает. */
export function makeProfile(patch: Partial<ProfileNode> = {}): ProfileNode {
  return {
    sectionProfileId: 'prof-1',
    sectionProfileVersion: 1,
    objectProfileIds: [],
    expectedDocTypes: ['aosr', 'annex_registry'],
    materialCategories: ['roll_waterproofing', 'rebar', 'ready_mix_concrete'],
    materialMatrix: {},
    enabledRuleCodes: [],
    thresholds: {},
    autonomyLevel: 'assisted',
    relevantDateBasis: 'application',
    completenessConfigured: true,
    ...patch,
  };
}

/** Раздел без опубликованного профиля: строка 2 матрицы §9.1. */
export function makeUnconfiguredProfile(): ProfileNode {
  return makeProfile({
    sectionProfileId: null,
    sectionProfileVersion: null,
    expectedDocTypes: [],
    materialCategories: [],
    completenessConfigured: false,
  });
}

/** Внешние реестры MVP: источников нет (§9.5). */
export function makeUnavailableRegistries(): ExternalRegistriesSnapshot {
  const unavailable = { status: 'unavailable', reason: NO_SOURCE_REASON } as const;
  return { nrs: unavailable, sro: unavailable, accreditation: unavailable, schedule: unavailable };
}

export function makeGraph(patch: Partial<CheckGraph> = {}): CheckGraph {
  return {
    folder: makeFolder(),
    object: makeObject(),
    profile: makeProfile(),
    counterparties: [],
    rdDocuments: [],
    documents: [],
    registryRows: [],
    transferRows: [],
    relations: [],
    materials: [],
    external: makeUnavailableRegistries(),
    today: '2026-08-18',
    hasRecognizedText: true,
    // Комплект разобран целиком: пробелы покрытия — отдельный случай, и тест,
    // который их проверяет, объявляет их явно.
    coverageGaps: 0,
    ...patch,
  };
}

export function makeRelation(patch: Partial<RelationNode> = {}): RelationNode {
  return {
    parentDocumentId: 'doc-act',
    childDocumentId: 'doc-child',
    relation: 'annex',
    ...patch,
  };
}

export function makeRdDocument(patch: Partial<RdDocumentNode> = {}): RdDocumentNode {
  return {
    id: testId('rd'),
    cipher: '2.5.1-АР',
    revision: '1',
    name: 'Кровля',
    isActive: true,
    ...patch,
  };
}

/**
 * Снимок ruleset со значениями каталога.
 *
 * Нужен тестам, чтобы прогнать правило через ДВИЖОК, а не мимо него: только так
 * проверяются понижение по уверенности, запрет блокирующей находки LLM и
 * согласованность вердикта с составом замечаний.
 */
export function snapshotOf(specs: readonly RuleSpec[]): readonly RuleSnapshotEntry[] {
  return specs.map((spec) => ({
    ruleCode: spec.code,
    isEnabled: true,
    severity: spec.defaultSeverity,
    isBlocking: spec.defaultBlocking,
    params: spec.defaultParams,
  }));
}
