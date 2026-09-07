/**
 * Слияние решений модели с решениями предфильтра (S57).
 *
 * ## Зачем модуль отдельный и чистый
 *
 * Сверку строки перечня с документом теперь судит модель, но принимает её ответ
 * не она сама: ответ приходит текстом, и превращение его в состояние строки —
 * это решение портала. Здесь оно и живёт: без БД, без сети, без часов. Тот же
 * код читает офлайн-стенд (`tools/check-harness`), и это не удобство, а
 * условие того, что стенд судит папку ТЕМ ЖЕ правилом, что портал. Прецедент
 * известен: копии выборок кандидатов разошлись молча, и мутация сверки на
 * стенде перестала краснеть (см. шапку `candidates.ts`).
 *
 * ## Что модель НЕ вправе изменить
 *
 * Строку, которую предфильтр нашёл посимвольным совпадением номера. Точное
 * равенство — утверждение более сильное, чем суждение по смыслу, и переспорить
 * его моделью значило бы поставить вероятность выше факта. Довод модели при
 * этом не выбрасывается: он ложится в `matchNote` и виден в отчёте — если
 * модель сомневается в паре, найденной точно, это первое, что должен увидеть
 * разбирающий, и первое сырьё для табло качества.
 *
 * ## Почему «не найдено» ещё не значит «нет в папке»
 *
 * Выборка кандидатов ограничена разделом описи (`candidates.ts`), и документ,
 * лежащий не в своём разделе, модели просто не показан. Объявить его
 * отсутствующим — обвинить комплект в границах собственного поиска. Поэтому
 * `not_in_scope` и `absent` проходят второй, детерминированный круг по ВСЕЙ
 * папке (`locateInFolder`), и только не найденный там документ, о котором
 * модель уверенно сказала «отсутствует», даёт `missing`. Всё остальное —
 * `undetermined`: «портал не сопоставил», а не «бумаги нет».
 *
 * ## Почему счёт у строки значит разное
 *
 * У `matched_by = 'rule'` в `match_score` лежит счёт ступени лестницы, у
 * `'llm'` — уверенность модели. Числа несопоставимы, и складывать их в одну
 * шкалу нельзя; различает их автор решения, поэтому `matched_by` и хранится
 * рядом. Отчёт печатает не число, а довод.
 */
import { z } from 'zod';

import { CANDIDATE_BASES, type CandidateBasis, type MatchState } from './match.js';
import type { PromptDocument } from './registry-match-prompt.js';

/**
 * Порог принятия документа, названного моделью.
 *
 * Параметр пилота, а не доказанная величина: он выбран так, чтобы уверенное
 * решение становилось совпадением, а сомнительное — кандидатом, которого
 * проверяющий увидит рядом со строкой. Табло качества (метки инженера) и
 * покажет, где порог стоит неверно; до тех пор всякое его изменение — гипотеза.
 */
export const MIN_MATCH_CONFIDENCE = 0.8;

/** Что модель ответила о поиске документа для строки. */
export const LLM_MATCH_REASONS = [
  /** Документ найден среди показанных. */
  'found',
  /** Подходят несколько, различить нечем. */
  'several',
  /** Данных в строке или в документах не хватило для вывода. */
  'insufficient',
  /** Среди показанных документа нет, но он может быть в папке. */
  'not_in_scope',
  /** Документа нет: строка описывает бумагу, которой в папке не видно. */
  'absent',
] as const;

export type LlmMatchReason = (typeof LLM_MATCH_REASONS)[number];

/** Виды проверок СОДЕРЖАНИЯ строки: верно ли она описывает найденный документ. */
export const ROW_CHECK_KINDS = ['org', 'act_reference', 'number_form', 'date', 'sheets'] as const;

export type RowCheckKind = (typeof ROW_CHECK_KINDS)[number];

export const ROW_CHECK_STATUSES = ['ok', 'mismatch', 'unsure'] as const;

export type RowCheckStatus = (typeof ROW_CHECK_STATUSES)[number];

/**
 * Проверка одной графы строки против реквизита документа.
 *
 * Цитаты с ОБЕИХ сторон обязательны у расхождения: замечание, называющее одну
 * сторону, проверяющему приходится достраивать самому, а замечание, не
 * называющее ни одной, — это мнение. `docQuote` допускает `null` ровно там, где
 * второй стороны нет по существу: реквизит не прочитан вовсе.
 */
export interface RowCheck {
  readonly kind: RowCheckKind;
  /** Графа строки описи: `doc_name_raw`, `doc_no_raw`, `org_raw`, `issued_at`, `sheets`. */
  readonly rowCell: string;
  /** Реквизит документа, с которым сверялись; `null` — сверять было не с чем. */
  readonly documentFieldCode: string | null;
  readonly status: RowCheckStatus;
  readonly confidence: number;
  readonly message: string;
  readonly rowQuote: string;
  readonly docQuote: string | null;
}

/** Решение модели по одной строке. */
export interface LlmRowDecision {
  readonly rowId: string;
  readonly documentId: string | null;
  readonly reason: LlmMatchReason;
  readonly basis: CandidateBasis | null;
  readonly confidence: number;
  readonly note: string;
  readonly candidateIds: readonly string[];
  readonly checks: readonly RowCheck[];
}

/** Решение предфильтра по строке — то, что записала лестница номеров. */
export interface PrefilterRow {
  readonly rowId: string;
  readonly matchState: MatchState;
  readonly matchedDocumentId: string | null;
  readonly matchScore: number | null;
  readonly candidates: readonly { readonly documentId: string; readonly basis: CandidateBasis }[];
}

/** Итог по строке — то, что уходит в `registry_rows`. */
export interface MergedRow {
  readonly rowId: string;
  readonly matchState: MatchState;
  readonly matchedDocumentId: string | null;
  readonly matchScore: number | null;
  readonly matchedBy: 'rule' | 'llm';
  readonly matchBasis: CandidateBasis | null;
  readonly matchNote: string | null;
  readonly candidates: readonly {
    readonly documentId: string;
    readonly basis: CandidateBasis;
    readonly score: number;
  }[];
  readonly checks: readonly RowCheck[];
}

/** Документ, найденный по всей папке вторым, детерминированным кругом. */
export interface FolderHit {
  readonly documentId: string;
  /** Где он лежит — словами, для довода: «в разделе 7» либо «вне разделов описи». */
  readonly where: string;
}

export interface MergeOptions {
  /**
   * Поиск по ВСЕЙ папке для строк, которым выборка не подошла.
   *
   * Детерминированный и потому дешёвый: точное и свёрнутое равенство номера.
   * Передаётся функцией, чтобы модуль остался чистым, — вычисляет её тот, у
   * кого есть список документов папки.
   */
  readonly locateInFolder?: (rowId: string) => FolderHit | null;
  readonly minConfidence?: number;
}

/** Точное совпадение предфильтра: посимвольное равенство номера. */
function isExactPrefilter(row: PrefilterRow): boolean {
  return row.matchState === 'matched' && row.matchScore === 1;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Слить решения модели с предфильтром.
 *
 * Строки, о которых модель не сказала ничего, не исчезают и не выдумываются:
 * найденное точно остаётся найденным, остальное становится `undetermined` с
 * названной причиной. Молчание модели — это отсутствие суждения, а не суждение
 * об отсутствии.
 */
export function mergeLlmMatches(
  prefilter: readonly PrefilterRow[],
  decisions: readonly LlmRowDecision[],
  options: MergeOptions = {},
): readonly MergedRow[] {
  const minConfidence = options.minConfidence ?? MIN_MATCH_CONFIDENCE;
  const byRow = new Map(decisions.map((decision) => [decision.rowId, decision]));

  return prefilter.map((row) => {
    const decision = byRow.get(row.rowId);
    if (decision === undefined) return silent(row, 'модель не ответила об этой строке');
    return mergeOne(row, decision, minConfidence, options.locateInFolder);
  });
}

/**
 * Строка без суждения модели.
 *
 * Точное совпадение переживает молчание: оно получено не моделью и в ней не
 * нуждается. Всё прочее — `undetermined`, потому что счёт ступени лестницы,
 * которую пилот снял, больше ничего не утверждает.
 */
function silent(row: PrefilterRow, why: string): MergedRow {
  if (isExactPrefilter(row)) {
    return {
      rowId: row.rowId,
      matchState: 'matched',
      matchedDocumentId: row.matchedDocumentId,
      matchScore: 1,
      matchedBy: 'rule',
      matchBasis: 'doc_no',
      matchNote: 'номер совпал посимвольно',
      candidates: [],
      checks: [],
    };
  }

  return {
    rowId: row.rowId,
    matchState: 'undetermined',
    matchedDocumentId: null,
    matchScore: null,
    matchedBy: 'rule',
    matchBasis: null,
    matchNote: why,
    candidates: row.candidates.map((candidate) => ({ ...candidate, score: 0 })),
    checks: [],
  };
}

function mergeOne(
  row: PrefilterRow,
  decision: LlmRowDecision,
  minConfidence: number,
  locateInFolder: MergeOptions['locateInFolder'],
): MergedRow {
  const confidence = clampConfidence(decision.confidence);
  const note = decision.note.trim() === '' ? null : decision.note.trim();

  // Точное совпадение неприкосновенно: см. шапку. Проверки содержания при этом
  // сохраняются целиком — ради них строку и показывали модели.
  if (isExactPrefilter(row)) {
    return {
      rowId: row.rowId,
      matchState: 'matched',
      matchedDocumentId: row.matchedDocumentId,
      matchScore: 1,
      matchedBy: 'rule',
      matchBasis: 'doc_no',
      matchNote: note ?? 'номер совпал посимвольно',
      candidates: [],
      checks: decision.checks,
    };
  }

  if (decision.reason === 'found' && decision.documentId !== null) {
    if (confidence >= minConfidence) {
      return {
        rowId: row.rowId,
        matchState: 'matched',
        matchedDocumentId: decision.documentId,
        matchScore: confidence,
        matchedBy: 'llm',
        matchBasis: decision.basis,
        matchNote: note,
        candidates: [],
        checks: decision.checks,
      };
    }

    // Ниже порога документ назван, но не подтверждён: строке он показывается
    // кандидатом, а расхождения по нему судятся мягче (правила S57).
    return {
      rowId: row.rowId,
      matchState: 'candidate',
      matchedDocumentId: null,
      matchScore: confidence,
      matchedBy: 'llm',
      matchBasis: null,
      matchNote: note,
      candidates: [
        { documentId: decision.documentId, basis: decision.basis ?? 'doc_no', score: confidence },
      ],
      checks: decision.checks,
    };
  }

  if (decision.reason === 'several') {
    return {
      rowId: row.rowId,
      matchState: 'ambiguous',
      matchedDocumentId: null,
      matchScore: null,
      matchedBy: 'llm',
      matchBasis: null,
      matchNote: note,
      candidates: decision.candidateIds.map((documentId) => ({
        documentId,
        basis: decision.basis ?? 'doc_no',
        score: confidence,
      })),
      checks: decision.checks,
    };
  }

  if (decision.reason === 'not_in_scope' || decision.reason === 'absent') {
    const hit = locateInFolder?.(row.rowId) ?? null;
    if (hit !== null) {
      // Документ в папке есть, но лежит не там, где его искали. Это вопрос
      // раскладки папки по разделам (REG.112), а не отсутствия бумаги.
      return {
        rowId: row.rowId,
        matchState: 'candidate',
        matchedDocumentId: null,
        matchScore: confidence,
        matchedBy: 'llm',
        matchBasis: 'doc_no',
        matchNote: `среди документов раздела не найден; по номеру найден ${hit.where}`,
        candidates: [{ documentId: hit.documentId, basis: 'doc_no', score: confidence }],
        checks: decision.checks,
      };
    }

    if (decision.reason === 'absent' && confidence >= minConfidence) {
      return {
        rowId: row.rowId,
        matchState: 'missing',
        matchedDocumentId: null,
        matchScore: null,
        matchedBy: 'llm',
        matchBasis: null,
        matchNote: note,
        candidates: [],
        checks: decision.checks,
      };
    }

    return {
      rowId: row.rowId,
      matchState: 'undetermined',
      matchedDocumentId: null,
      matchScore: null,
      matchedBy: 'llm',
      matchBasis: null,
      matchNote: note ?? 'документ не найден среди документов раздела и по номеру в папке',
      candidates: [],
      checks: decision.checks,
    };
  }

  return {
    rowId: row.rowId,
    matchState: 'undetermined',
    matchedDocumentId: null,
    matchScore: null,
    matchedBy: 'llm',
    matchBasis: null,
    matchNote: note ?? 'данных для сопоставления не хватило',
    candidates: [],
    checks: decision.checks,
  };
}

/**
 * Строка перечня в том виде, в каком её видит сверка.
 *
 * Объявлена структурно, а не импортом `RegistryRowView`: репозиторий знает про
 * область видимости, транзакции и вид перечня, и ничего из этого сверке не
 * нужно. Совместимость держит компилятор — представление репозитория этому
 * набору полей отвечает.
 */
export interface PartitionRow {
  readonly id: string;
  readonly rowNo: number;
  readonly sectionTitle: string | null;
  readonly docNameRaw: string;
  readonly docNoRaw: string | null;
  readonly orgRaw: string | null;
  readonly issuedAt: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly matchState: MatchState;
  readonly matchedDocumentId: string | null;
  readonly matchScore: number | null;
}

/** Всё, что нужно одной задаче веера, чтобы сверить свою выборку. */
export interface MatchPartitionInput {
  readonly key: string;
  /** Заголовок выборки для промта: раздел описи с его актом либо перечень акта. */
  readonly scope: string;
  readonly rows: readonly PartitionRow[];
  readonly documents: readonly PromptDocument[];
  /**
   * Документы, найденные по номеру ВНЕ выборки, — по идентификатору строки.
   *
   * Считается детерминированно и заранее: второй круг поиска не должен стоить
   * второго вызова модели. Пусто — значит по номеру в папке ничего не нашлось.
   */
  readonly folderWide: Readonly<Record<string, FolderHit>>;
  /** Где в тексте перечня лежат ячейки строки — по идентификатору строки. */
  readonly anchors: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

// =====================================================================
// Разбор ответа модели
// =====================================================================

const checkSchema = z.object({
  kind: z.enum(ROW_CHECK_KINDS),
  rowCell: z.string().min(1),
  documentFieldCode: z.string().nullish(),
  status: z.enum(ROW_CHECK_STATUSES),
  confidence: z.number().min(0).max(1),
  message: z.string().min(1).max(300),
  rowQuote: z.string().min(1),
  docQuote: z.string().nullish(),
});

const rowSchema = z.object({
  rowId: z.string().min(1),
  match: z.object({
    documentId: z.string().nullish(),
    reason: z.enum(LLM_MATCH_REASONS),
    basis: z.enum(CANDIDATE_BASES).nullish(),
    confidence: z.number().min(0).max(1),
    note: z.string().max(200).nullish(),
    candidates: z.array(z.string().min(1)).max(12).nullish(),
  }),
  checks: z.array(checkSchema).max(5).nullish(),
});

export const registryMatchResponseSchema = z.object({ rows: z.array(rowSchema).max(200) });

/** Дословные причины отказа: на них опираются журнал прогона и тесты. */
export const DECISION_UNKNOWN_ROW = 'строки с таким идентификатором в выборке не было';
export const DECISION_FOREIGN_DOCUMENT = 'назван документ, которого не было среди показанных';
export const DECISION_DUPLICATE_ROW = 'строка названа в ответе дважды';
export const DECISION_QUOTE_NOT_GIVEN = 'у расхождения нет цитаты из строки описи';

export interface AcceptOutcome {
  readonly decisions: readonly LlmRowDecision[];
  /** Причины отброшенных решений — по одной на строку, для журнала. */
  readonly problems: readonly string[];
}

/**
 * Принять ответ модели ПОСТРОЧНО, а не целиком.
 *
 * Урок `llm-extract.ts`: единая проверка «годен ли ответ» отбрасывала документ
 * из-за одного негодного значения из тридцати одного — на боевой папке так
 * пропало три четверти работы модели. Здесь единица годности — строка: чужой
 * идентификатор портит своё решение и только его.
 *
 * Что отбрасывается: строка не из этой выборки, документ не из показанных,
 * повтор строки, расхождение без цитаты. Отброшенная строка не исчезает —
 * `mergeLlmMatches` увидит её как строку без суждения и объявит `undetermined`
 * с названной причиной.
 */
export function acceptDecisions(
  parsed: z.infer<typeof registryMatchResponseSchema>,
  scope: { readonly rowIds: ReadonlySet<string>; readonly documentIds: ReadonlySet<string> },
): AcceptOutcome {
  const decisions: LlmRowDecision[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const row of parsed.rows) {
    if (!scope.rowIds.has(row.rowId)) {
      problems.push(`${row.rowId}: ${DECISION_UNKNOWN_ROW}`);
      continue;
    }
    if (seen.has(row.rowId)) {
      problems.push(`${row.rowId}: ${DECISION_DUPLICATE_ROW}`);
      continue;
    }

    const documentId = row.match.documentId ?? null;
    if (documentId !== null && !scope.documentIds.has(documentId)) {
      problems.push(`${row.rowId}: ${DECISION_FOREIGN_DOCUMENT}`);
      continue;
    }

    const candidateIds = (row.match.candidates ?? []).filter((id) => scope.documentIds.has(id));
    const checks = row.checks ?? [];
    const withoutQuote = checks.find(
      (check) => check.status === 'mismatch' && check.rowQuote.trim() === '',
    );
    if (withoutQuote !== undefined) {
      problems.push(`${row.rowId}: ${DECISION_QUOTE_NOT_GIVEN}`);
      continue;
    }

    seen.add(row.rowId);
    decisions.push({
      rowId: row.rowId,
      documentId,
      reason: row.match.reason,
      basis: row.match.basis ?? null,
      confidence: row.match.confidence,
      note: row.match.note ?? '',
      candidateIds,
      checks: checks.map((check) => ({
        kind: check.kind,
        rowCell: check.rowCell,
        documentFieldCode: check.documentFieldCode ?? null,
        status: check.status,
        confidence: check.confidence,
        message: check.message,
        rowQuote: check.rowQuote,
        docQuote: check.docQuote ?? null,
      })),
    });
  }

  return { decisions, problems };
}
