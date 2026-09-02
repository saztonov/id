/**
 * Прогон правил ПО КОМПЛЕКТАМ, а не по всей папке разом (S44).
 *
 * ## Что чинится
 *
 * Загружают в портал папку ИД: опись передачи и двенадцать актов, у каждого свой
 * перечень приложений и свои паспорта. Пока граф правил описывал папку целиком,
 * всякое утверждение вида «в комплекте есть документ с номером X» отвечало
 * двенадцати актам сразу. На боевой папке это дало 72 строки перечня
 * «сопоставлено неоднозначно» из 138 — и это только видимая часть: правила
 * полноты и дат считали соседний акт своим по построению.
 *
 * ## Что здесь решено
 *
 * Правила уровня `folder` исполняются ОДИН раз по всему графу: они и относятся к
 * папке (ссылка на РД, график, выписка СРО). Все остальные исполняются по
 * КОМПЛЕКТУ, на подграфе из его документов, плюс один раз на документах вне
 * комплектов.
 *
 * Разрез именно по уровню правила, а не списком кодов: уровень объявлен в
 * каталоге (`RuleSpec.level`) и уже используется движком и отчётом. Второй
 * список тех же правил разошёлся бы с каталогом при первом же добавлении.
 *
 * ## Почему инвариант ADR-0018 не нарушен
 *
 * «Каждое замечание попадает в отчёт ровно один раз» держится тем, что наборы
 * правил у прогонов НЕ ПЕРЕСЕКАЮТСЯ: `folder` исполняется только в папочном
 * прогоне, остальные — только в своём комплекте, а документ принадлежит ровно
 * одному комплекту (или ни одному). Пересечься наборам нечем — они разбиение.
 *
 * ## Папка без комплектов
 *
 * Так выглядит отдельно загруженная опись передачи: комплектов нет, все
 * документы уходят в прогон «вне комплектов», и проверки идут ровно как до
 * нарезки. Это законное состояние, а не вырожденный случай.
 */
import type {
  CheckGraph,
  DocumentNode,
  PreparedFinding,
  RuleExecution,
  RuleRunCounts,
  RuleRunResult,
  RuleSkipReason,
} from './types.js';
import { runRules, type RunRulesOptions } from './engine.js';

/** Один прогон разбиения: чьи документы проверялись и что вышло. */
export interface ComplectRunSlice {
  readonly scope: 'folder' | 'complect' | 'outside';
  /** Комплект прогона; `null` у папочного прогона и у прогона вне комплектов. */
  readonly complectId: string | null;
  readonly result: RuleRunResult;
}

export interface ComplectRunResult extends RuleRunResult {
  /** Разрез журнала: с каким комплектом связано каждое исполнение (C2). */
  readonly slices: readonly ComplectRunSlice[];
}

/**
 * Разложить документы по комплектам, сохранив порядок первого появления.
 *
 * Порядок значим: журнал и отчёт печатают комплекты в порядке актов, а он задан
 * порядком документов (`ordinal`), в котором вызывающий их и передал.
 */
export function groupByComplect(
  documents: readonly DocumentNode[],
): readonly { readonly complectId: string | null; readonly documents: readonly DocumentNode[] }[] {
  const groups = new Map<string | null, DocumentNode[]>();
  for (const document of [...documents].sort((a, b) => a.ordinal - b.ordinal)) {
    const key = document.complectId;
    const own = groups.get(key) ?? [];
    own.push(document);
    groups.set(key, own);
  }
  return [...groups.entries()].map(([complectId, own]) => ({ complectId, documents: own }));
}

/**
 * Подграф комплекта: те же папка, объект и профиль, но свои документы.
 *
 * Что НЕ сужается и почему:
 *
 * - `coverageGaps` — число неразобранных листов ПАПКИ. Правила полноты читают
 *   его, чтобы не объявлять документ отсутствующим при неполном разборе, и
 *   обнулить его для комплекта значило бы разрешить им этот вывод как раз там,
 *   где оснований для него нет;
 * - `hasRecognizedText`, `rdDocuments`, `counterparties`, `external` — свойства
 *   папки и справочников, к границе акта отношения не имеющие.
 */
export function subgraphOfDocuments(
  graph: CheckGraph,
  documents: readonly DocumentNode[],
): CheckGraph {
  const ids = new Set(documents.map((document) => document.id));
  return {
    ...graph,
    documents,
    registryRows: graph.registryRows.filter((row) => ids.has(row.registryDocumentId)),
    // Ребро принадлежит подграфу, только если ОБА его конца в нём. Ребро
    // наружу — это связь между комплектами, и утверждать по ней что-либо внутри
    // одного из них нельзя.
    relations: graph.relations.filter(
      (relation) => ids.has(relation.parentDocumentId) && ids.has(relation.childDocumentId),
    ),
    // Материал принадлежит комплекту, если его вывели документы этого комплекта.
    materials: graph.materials
      .map((material) => ({
        ...material,
        documentIds: material.documentIds.filter((id) => ids.has(id)),
      }))
      .filter((material) => material.documentIds.length > 0),
  };
}

export function runRulesByComplect(graph: CheckGraph, options: RunRulesOptions): ComplectRunResult {
  const folderSpecs = options.specs.filter((spec) => spec.level === 'folder');
  const scopedSpecs = options.specs.filter((spec) => spec.level !== 'folder');

  const slices: ComplectRunSlice[] = [];

  if (folderSpecs.length > 0) {
    slices.push({
      scope: 'folder',
      complectId: null,
      result: stamp(runRules(graph, { ...options, specs: folderSpecs }), null),
    });
  }

  if (scopedSpecs.length > 0) {
    for (const group of groupByComplect(graph.documents)) {
      slices.push({
        scope: group.complectId === null ? 'outside' : 'complect',
        complectId: group.complectId,
        result: stamp(
          runRules(subgraphOfDocuments(graph, group.documents), {
            ...options,
            specs: scopedSpecs,
          }),
          group.complectId,
        ),
      });
    }
  }

  return { ...mergeSlices(slices, options.specs.length), slices };
}

/**
 * Проставить комплект исполнениям прогона.
 *
 * Снаружи движка, а не внутри: `runRules` о разбиении не знает и знать не
 * должен — он исполняет набор правил на графе, который ему дали, и добавление
 * туда параметра «чей это подграф» сделало бы его зависимым от того, кто его
 * зовёт.
 */
function stamp(result: RuleRunResult, complectId: string | null): RuleRunResult {
  return {
    ...result,
    executions: result.executions.map((execution) => ({ ...execution, complectId })),
  };
}

function mergeSlices(slices: readonly ComplectRunSlice[], rulesTotal: number): RuleRunResult {
  const executions: RuleExecution[] = [];
  const findings: PreparedFinding[] = [];
  const skipped: Record<string, RuleSkipReason> = {};

  for (const slice of slices) {
    executions.push(...slice.result.executions);
    findings.push(...slice.result.findings);
    // Пропуск зависит от снимка и профиля, а не от графа: один и тот же код в
    // разных прогонах пропускается одинаково, и слияние карт непротиворечиво.
    Object.assign(skipped, slice.result.skipped);
  }

  return {
    executions,
    findings,
    skipped,
    counts: countUp(rulesTotal, executions, findings, skipped),
  };
}

/**
 * Счётчики по слитому прогону.
 *
 * Повторяет `countUp` движка намеренно: тот считает ОДИН прогон и не знает о
 * разбиении, а вынести его в общий экспорт значило бы объявить внутренность
 * движка частью его договора ради двенадцати строк.
 */
function countUp(
  rulesTotal: number,
  executions: readonly RuleExecution[],
  findings: readonly PreparedFinding[],
  skipped: Readonly<Record<string, RuleSkipReason>>,
): RuleRunCounts {
  const byVerdict = (verdict: string): number =>
    executions.filter((execution) => execution.verdict === verdict).length;

  return {
    rulesTotal,
    executed: executions.length,
    passed: byVerdict('pass'),
    failed: byVerdict('fail'),
    undetermined: byVerdict('undetermined'),
    notApplicable: byVerdict('n_a'),
    skipped: Object.keys(skipped).length,
    findings: findings.length,
    blocking: findings.filter((finding) => finding.isBlocking).length,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    infos: findings.filter((finding) => finding.severity === 'info').length,
    externalUnavailable: findings.filter((finding) => finding.origin === 'external_unavailable')
      .length,
  };
}
