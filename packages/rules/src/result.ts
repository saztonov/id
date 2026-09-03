/**
 * Конструирование результата правила и инварианты троичной логики (§9.1).
 *
 * Здесь же — единственное место, где действует запрет «низкая уверенность OCR
 * не даёт `fail`». Он вынесен из правил намеренно: сорок реализаций, каждая из
 * которых помнит про порог уверенности, — это сорок мест, где о нём можно
 * забыть, и забывание выглядит как исправная работа. На S8 ровно так же был
 * вынесен из промтов запрет §0.5 п. 6: проверка, живущая в дисциплине автора,
 * держится ровно до следующего автора.
 */
import type { FindingSeverity, RuleFinding, RuleResult, RuleVerdict } from './types.js';

/**
 * Порог уверенности, ниже которого факт не может дать `fail`.
 *
 * Значение по умолчанию; конкретное правило переопределяет его параметром
 * `minConfidence` из снимка `ruleset_rules`. 0.75 — не выдумка про качество
 * OCR, а граница, разделяющая два наблюдения корпуса: ОГРН из шапки акта
 * (чистый текстовый блок) и ОГРН с круглой печати, перекрытой подписью, где тот
 * же OCR прочитал слово «ОГРН» как «ОТРИ» (`docs/CORPUS_FINDINGS.md`).
 */
export const DEFAULT_MIN_CONFIDENCE = 0.75;

/** Правило неприменимо. Причина обязательна: она уходит в отчёт прогона. */
export function notApplicable(reason: string): RuleResult {
  return { verdict: 'n_a', reason };
}

/**
 * Правило исполнить не на чем: данные есть, но им нельзя верить (S50).
 *
 * Отличается от `notApplicable` предметом отказа. «Неприменимо» говорит о
 * ПАПКЕ: такого вида документов в ней нет, спрашивать не о чем. «Не проверено»
 * говорит о ПОРТАЛЕ: документ есть, а вид его не подтверждён, и вывод по нему
 * был бы выводом по догадке. Первое человеку чинить нечем, второе — повод
 * посмотреть на документ.
 *
 * Замечание одно и без цели: оно описывает не дефект бумаги, а границу
 * проверки, и привязывать его к документу значило бы обвинить документ.
 */
export function undeterminedByApplicability(reason: string): RuleResult {
  return {
    verdict: 'undetermined',
    findings: [
      unknown({
        origin: 'deterministic',
        targetType: 'folder',
        targetId: null,
        message: reason,
        hint: 'Проверьте вид документа на экране разметки и подтвердите его.',
      }),
    ],
    reason,
  };
}

/** Правило применимо, дефектов нет. */
export function passed(reason?: string): RuleResult {
  return reason === undefined
    ? { verdict: 'pass', findings: [] }
    : { verdict: 'pass', findings: [], reason };
}

/**
 * Правило применимо, вердикт выводится из состава замечаний.
 *
 * Единственный конструктор для непустого набора: вычислять вердикт в каждой
 * реализации значило бы разрешить правилу объявить `pass` при открытом
 * замечании. Пустой набор здесь означает `pass` — и это верно: замечаний нет.
 */
export function fromFindings(findings: readonly RuleFinding[], reason?: string): RuleResult {
  const verdict: RuleVerdict = findings.some((finding) => finding.state === 'open')
    ? 'fail'
    : findings.some((finding) => finding.state === 'undetermined')
      ? 'undetermined'
      : 'pass';
  return reason === undefined
    ? ({ verdict, findings } as RuleResult)
    : ({ verdict, findings, reason } as RuleResult);
}

/** Дефект найден. */
export function defect(finding: Omit<RuleFinding, 'state'>): RuleFinding {
  return { ...finding, state: 'open' };
}

/** Вывод не сделан: данных нет, цитата не отобразилась, уверенность низка. */
export function unknown(finding: Omit<RuleFinding, 'state'>): RuleFinding {
  return { ...finding, state: 'undetermined' };
}

/**
 * Замечание внешнего реестра (§9.5).
 *
 * Всегда `undetermined` и всегда `external_unavailable`: без источника данных
 * вывод о членстве в СРО или об аккредитации — это юридическое утверждение,
 * которого система сделать не может.
 */
export function externalUnavailable(finding: Omit<RuleFinding, 'state' | 'origin'>): RuleFinding {
  return { ...finding, state: 'undetermined', origin: 'external_unavailable' };
}

/**
 * Порог уверенности из параметров снимка.
 *
 * Отсутствие ключа — не ноль: ноль отключил бы защиту молча, а именно молчащее
 * отключение защиты — известная болезнь проекта (S6, S7, S8).
 */
export function minConfidenceOf(params: Readonly<Record<string, unknown>>): number {
  const value = params['minConfidence'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_MIN_CONFIDENCE;
}

/**
 * Понижение `fail` до `undetermined` при недостаточной уверенности источника
 * (§9.1, §16: «ни одно поле с недостаточной уверенностью не создаёт
 * автоматический blocking fail»).
 *
 * Понижается только `open`. `undetermined` остаётся собой, а уверенность
 * `null` — это «источник уверенности не сообщил», и понижать по ней нельзя:
 * иначе любое значение без метрики перестало бы проверяться вовсе, и защита
 * превратилась бы в глушитель.
 */
export function softenByConfidence(
  findings: readonly RuleFinding[],
  minConfidence: number,
  note = 'значение распознано с низкой уверенностью, требуется ручная проверка',
): readonly RuleFinding[] {
  return findings.map((finding) => {
    if (finding.state !== 'open') return finding;
    const confidence = finding.confidence;
    if (confidence === null || confidence === undefined) return finding;
    if (confidence >= minConfidence) return finding;
    return {
      ...finding,
      state: 'undetermined',
      message: `${finding.message} (${note})`,
    };
  });
}

/** Строгость по возрастанию: движок не разрешает правилу поднимать её. */
const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_ORDER[severity];
}

/** Причина несогласованности результата правила; `null` — всё в порядке. */
export function inconsistencyOf(result: RuleResult): string | null {
  if (result.verdict === 'n_a') {
    return result.reason.trim() === '' ? 'вердикт n_a без причины' : null;
  }

  const findings = result.findings;
  const hasOpen = findings.some((finding) => finding.state === 'open');
  const hasUnknown = findings.some((finding) => finding.state === 'undetermined');

  if (result.verdict === 'pass' && hasOpen) return 'вердикт pass при открытом замечании';
  if (result.verdict === 'pass' && hasUnknown) return 'вердикт pass при неразрешённом замечании';
  if (result.verdict === 'fail' && !hasOpen) return 'вердикт fail без открытых замечаний';
  if (result.verdict === 'undetermined' && !hasUnknown) {
    return 'вердикт undetermined без неразрешённых замечаний';
  }
  if (result.verdict === 'undetermined' && hasOpen) {
    return 'вердикт undetermined при открытом замечании';
  }
  return null;
}
