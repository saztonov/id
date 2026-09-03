/**
 * Ядро движка правил (§9.6).
 *
 * Движок отвечает за три вещи, которых не имеет права делать ни одно правило:
 *
 * 1. **Применимость — явное решение, а не побочный эффект** (§9.1). Правило не
 *    «просто ничего не находит» на разделе без профиля; оно объявляется
 *    неприменимым с названной причиной, и причина попадает в отчёт.
 * 2. **Поведение берётся из неизменяемого снимка `ruleset_rules`**, а не из
 *    кода. Severity, blocking и параметры приезжают из снимка, поэтому прогон
 *    месячной давности воспроизводится точно (§3.7).
 * 3. **Инварианты троичной логики держатся здесь**, а не в дисциплине сорока
 *    реализаций: низкая уверенность не даёт `fail`, `undetermined` не бывает
 *    блокирующим, находка LLM не блокирует без подтверждения инженером.
 *
 * ## Почему исполнение фиксируется поимённо
 *
 * Шесть этапов подряд давали один и тот же отказ: код написан, покрыт зелёными
 * тестами и не исполняется (S3 — модуль не вызван, S5 — задача не поставлена в
 * очередь, S6 — задача исполняется и уносит данные, S8 — тест измеряет прошлую
 * сборку). Поэтому результат прогона содержит НЕ только замечания, но и журнал
 * `executions`: по каждому коду — вердикт и причина. «Правило прошло» и
 * «правило не исполнялось» перестают быть неразличимы, а гейт этапа может
 * потребовать, чтобы конкретный код в журнале был и имел конкретный вердикт.
 */
import {
  fromFindings,
  inconsistencyOf,
  minConfidenceOf,
  notApplicable,
  undeterminedByApplicability,
  severityRank,
  softenByConfidence,
} from './result.js';
import type {
  CheckGraph,
  FindingSeverity,
  PreparedFinding,
  RuleExecution,
  RuleFinding,
  RuleRunCounts,
  RuleRunResult,
  RuleSkipReason,
  RuleSnapshotEntry,
  RuleSpec,
} from './types.js';

/** Расхождение реестра правил и реализаций (§9.6). */
export class RuleRegistryError extends Error {
  readonly missingImplementations: readonly string[];
  readonly missingDefinitions: readonly string[];

  constructor(missingImplementations: readonly string[], missingDefinitions: readonly string[]) {
    const parts: string[] = [];
    if (missingImplementations.length > 0) {
      parts.push(`нет реализации для кодов: ${missingImplementations.join(', ')}`);
    }
    if (missingDefinitions.length > 0) {
      parts.push(`нет записи в реестре правил для кодов: ${missingDefinitions.join(', ')}`);
    }
    super(`реестр правил разошёлся с реализациями — ${parts.join('; ')}`);
    this.name = 'RuleRegistryError';
    this.missingImplementations = missingImplementations;
    this.missingDefinitions = missingDefinitions;
  }
}

/**
 * Сверка «каждый код имеет реализацию и наоборот» (§9.6).
 *
 * Обе стороны обязательны. Проверять только одну — распространённая ошибка:
 * забытая строка в `rule_definitions` даёт правило, которое невозможно включить
 * в профиль, а забытая реализация даёт правило, которое администратор включил и
 * которое молча не исполняется. Второе хуже: профиль показывает проверку
 * включённой, прогон отвечает «замечаний нет», и отличить это от исправной
 * работы нечем — тот же дефект, что на S4 давала опечатка в
 * `enabled_rule_codes`.
 *
 * Расхождение — fail-fast: исключение бросается, а не логируется.
 *
 * ## Снятые правила — законное исключение с ОДНОЙ стороны (S30)
 *
 * Правило, снятое с исполнения, остаётся в `rule_definitions` навсегда:
 * `findings.rule_code` — внешний ключ на неё, и удалить строку значило бы либо
 * стереть замечания прошлых прогонов, либо порвать ссылку. Строка снимка
 * опубликованного набора удалению не подлежит тем более — её запирает триггер,
 * и запирает верно: снимок описывает, ЧТО проверял прогон месячной давности.
 *
 * Поэтому такой код разрешён в БД без реализации — но ТОЛЬКО в эту сторону.
 * Обратная («реализация есть, записи нет») остаётся отказом: это по-прежнему
 * правило, которое невозможно включить в профиль.
 */
export function reconcileRuleRegistry(
  definitionCodes: Iterable<string>,
  specs: readonly RuleSpec[] = RULE_SPECS_PLACEHOLDER,
  retiredCodes: Iterable<string> = [],
): void {
  const defined = new Set(definitionCodes);
  const implemented = new Set(specs.map((spec) => spec.code));
  const retired = new Set(retiredCodes);

  const missingImplementations = [...defined]
    .filter((code) => !implemented.has(code) && !retired.has(code))
    .sort();
  const missingDefinitions = [...implemented].filter((code) => !defined.has(code)).sort();

  if (missingImplementations.length > 0 || missingDefinitions.length > 0) {
    throw new RuleRegistryError(missingImplementations, missingDefinitions);
  }
}

/**
 * Заглушка по умолчанию для `reconcileRuleRegistry`.
 *
 * Пустой массив здесь намеренно: подставить сюда каталог значило бы завести
 * циклический импорт `engine → catalog → правила → engine`. Вызывающий передаёт
 * каталог явно; `index.ts` экспортирует связанную версию.
 */
const RULE_SPECS_PLACEHOLDER: readonly RuleSpec[] = [];

export interface RunRulesOptions {
  /** Каталог реализаций. */
  readonly specs: readonly RuleSpec[];
  /** Снимок поведения (`ruleset_rules` опубликованной версии). */
  readonly snapshot: readonly RuleSnapshotEntry[];
  /**
   * Список кодов из профиля.
   *
   * `null` — «профиль список не задаёт»: тогда исполняются все правила снимка.
   * Пустой массив и `null` — РАЗНОЕ: пустой список означает, что администратор
   * выключил все правила, и это законное решение, а не отсутствие настройки.
   */
  readonly enabledRuleCodes: readonly string[] | null;
}

/**
 * Прогон правил над графом.
 *
 * Порядок исполнения — лексикографический по коду: он не влияет на результат
 * (правила чисты и независимы), но делает журнал прогона и отчёт стабильными,
 * а diff двух прогонов — читаемым.
 */
export function runRules(graph: CheckGraph, options: RunRulesOptions): RuleRunResult {
  const snapshotByCode = new Map(options.snapshot.map((entry) => [entry.ruleCode, entry]));
  const profileCodes = options.enabledRuleCodes === null ? null : new Set(options.enabledRuleCodes);

  const executions: RuleExecution[] = [];
  const skipped: Record<string, RuleSkipReason> = {};
  const findings: PreparedFinding[] = [];

  const ordered = [...options.specs].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );

  for (const spec of ordered) {
    const entry = snapshotByCode.get(spec.code);
    if (entry === undefined) {
      skipped[spec.code] = 'absent_from_snapshot';
      continue;
    }
    if (!entry.isEnabled) {
      skipped[spec.code] = 'disabled_in_snapshot';
      continue;
    }
    if (profileCodes !== null && !profileCodes.has(spec.code)) {
      // §9.1, строка 4: правило не из списка профиля НЕ исполняется. Это не
      // `n_a` — оно вообще не рассматривалось.
      skipped[spec.code] = 'not_in_profile';
      continue;
    }

    const params = { ...spec.defaultParams, ...entry.params };
    const applicability = decideApplicability(spec, graph);

    const result =
      applicability === null
        ? evaluateGuarded(spec, graph, params)
        : applicability.kind === 'n_a'
          ? notApplicable(applicability.reason)
          : undeterminedByApplicability(applicability.reason);

    const inconsistency = inconsistencyOf(result);
    if (inconsistency !== null) {
      throw new Error(`правило ${spec.code} вернуло несогласованный результат: ${inconsistency}`);
    }

    const prepared =
      result.verdict === 'n_a'
        ? []
        : prepareFindings(spec, entry, result.findings, minConfidenceOf(params));

    // Понижение уверенностью могло превратить `fail` в `undetermined`: вердикт
    // обязан отражать то, что реально записано, а не то, что вернуло правило.
    const verdict = result.verdict === 'n_a' ? 'n_a' : fromFindings(prepared).verdict;

    executions.push({
      ruleCode: spec.code,
      verdict,
      reason: result.reason ?? null,
      findingCount: prepared.length,
    });
    findings.push(...prepared);
  }

  return {
    executions,
    skipped,
    findings,
    counts: countUp(options.specs.length, executions, findings, skipped),
  };
}

/**
 * Ответ о применимости: «нечего проверять» либо «не на чем строить вывод».
 *
 * `null` — правило исполняется.
 */
export type Applicability =
  | { readonly kind: 'n_a'; readonly reason: string }
  | { readonly kind: 'undetermined'; readonly reason: string }
  | null;

/**
 * Универсальная применимость (§9.1).
 *
 * Возвращает причину `n_a` либо `null`, если правило надо исполнять. Здесь
 * только те две строки матрицы, которые не зависят от конкретного документа:
 * профиль раздела и наличие документов нужного вида. Категория материала вне
 * профиля разрешается внутри правил материалов — она относится к отдельному
 * материалу, а не ко всему правилу.
 */
export function decideApplicability(spec: RuleSpec, graph: CheckGraph): Applicability {
  if (spec.requiresSectionProfile && !graph.profile.completenessConfigured) {
    return { kind: 'n_a', reason: 'профиль раздела не настроен' };
  }

  if (spec.docTypeCode !== null) {
    const present = graph.documents.some(
      (document) => document.isKnownType && document.docTypeCode === spec.docTypeCode,
    );
    if (!present) {
      /**
       * «Вида нет» и «вид не подтверждён» — разные ответы (S50).
       *
       * Прежде оба давали `n_a`, и это ровно тот случай, когда одна неуверенная
       * страница гасит целый чек-лист. На боевой папке акт освидетельствования
       * получал тип по форме бланка с двумя маркерами вместо трёх — уверенность
       * 0.6, — и все девятнадцать правил AOSR по комплекту отвечали
       * «неприменимо». Отчёт при этом выглядел спокойным: неприменимое правило
       * не спрашивают, почему оно молчит.
       *
       * Различие простое: документов вида нет вовсе — правилу нечего проверять,
       * это законное `n_a`. Документы есть, но ни у одного вид не подтверждён —
       * проверять ЕСТЬ что, просто не на чем строить вывод; это `undetermined`,
       * и он виден в отчёте как «не проверено» с причиной.
       */
      const uncertain = graph.documents.filter(
        (document) => !document.isKnownType && document.docTypeCode === spec.docTypeCode,
      );
      if (uncertain.length > 0) {
        const names = uncertain
          .slice(0, 3)
          .map((document) => document.title ?? `документ ${String(document.ordinal)}`)
          .join(', ');
        return {
          kind: 'undetermined',
          reason:
            `вид «${spec.docTypeCode}» в комплекте есть, но не подтверждён ` +
            `(${String(uncertain.length)}: ${names}) — проверка по нему не выполнялась`,
        };
      }
      return {
        kind: 'n_a',
        reason: `в комплекте нет документов вида «${spec.docTypeCode}» с уверенно определённым типом`,
      };
    }
  }

  return null;
}

/** Исполнение с приведением исключения правила к отказу задачи. */
function evaluateGuarded(
  spec: RuleSpec,
  graph: CheckGraph,
  params: Readonly<Record<string, unknown>>,
): ReturnType<RuleSpec['evaluate']> {
  try {
    return spec.evaluate(graph, params);
  } catch (error) {
    // Исключение правила НЕ превращается в «замечаний нет»: тихо проглоченный
    // отказ — это «правило прошло, не будучи исполненным», прямо запрещённое
    // гейтом этапа. Задача обязана упасть и попасть в `job_runs`.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`правило ${spec.code} упало: ${message}`, { cause: error });
  }
}

/**
 * Применение снимка к фактам правила плюс три инварианта.
 *
 * Инварианты держатся здесь потому, что БД их тоже проверяет (0006:
 * `findings_llm_blocking_chk`, `findings_undetermined_chk`), и приложение,
 * которое узнаёт о нарушении из отказа вставки, теряет весь прогон целиком.
 */
function prepareFindings(
  spec: RuleSpec,
  entry: RuleSnapshotEntry,
  raw: readonly RuleFinding[],
  minConfidence: number,
): PreparedFinding[] {
  const softened = softenByConfidence(raw, minConfidence);

  return softened.map((finding) => {
    // Правило вправе ПОНИЗИТЬ тяжесть (у `LAB` семисуточный протокол — `info`),
    // но не поднять: иначе снимок перестаёт ограничивать поведение.
    const severity: FindingSeverity =
      finding.severityOverride !== undefined &&
      severityRank(finding.severityOverride) < severityRank(entry.severity)
        ? finding.severityOverride
        : entry.severity;

    const isBlocking =
      entry.isBlocking &&
      finding.state === 'open' &&
      finding.origin === 'deterministic' &&
      severity === 'error';

    return {
      ...finding,
      ruleCode: spec.code,
      severity,
      isBlocking,
    };
  });
}

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
