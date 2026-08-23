/**
 * Задачи 20–21 конвейера: прогон проверок и сводка (§9, §12).
 *
 * Обработчики написаны на портах (`ChecksDeps`); связывание с базой живёт в
 * `pipeline.ts`. Разделение то же, что у задач 1–19, и по той же причине (урок
 * S3: слой, который никто не вызывает, выглядит рабочим и покрыт зелёными
 * тестами).
 *
 * ## Почему сводка — отдельная задача, а не хвост прогона
 *
 * §12 объявляет `checks.summarize` отдельной задачей, и это не формальность.
 * Прогон правил живёт в памяти, а сводка обязана описывать то, что РЕАЛЬНО
 * лежит в `findings`: если запись части замечаний отвалилась, счётчики,
 * посчитанные по памяти, соврут именно в тот момент, когда правда важнее всего.
 * Поэтому задача 21 пересчитывает всё, что выводится из замечаний, ЧТЕНИЕМ ИЗ
 * БД, и берёт из прогона только то, что из замечаний не выводится, — журнал
 * исполнения правил. Правило, завершившееся `pass`, не оставляет ни одной
 * строки, и без журнала «правило прошло» неотличимо от «правило не
 * исполнялось» — прямой запрет гейта S9.
 *
 * ## Чего задача НЕ имеет права сделать
 *
 * Завершиться успехом, не исполнив ни одного правила. Отсюда охранники:
 * отсутствие опубликованного набора правил — отказ с названной причиной, а не
 * «замечаний нет»; расхождение реестра правил с реализациями — отказ
 * (`RuleRegistryError`); исключение внутри правила — отказ задачи, а не
 * проглоченная пустота.
 */
import {
  RuleRegistryError,
  RULE_CATALOG,
  reconcileRuleRegistry,
  resolveExternalRegistries,
  runRules,
  type CheckGraph,
  type ExternalRegistryProviders,
  type MaterialNode,
  type PreparedFinding,
  type RegistryQuery,
  type RuleRunResult,
} from '@id/rules';
import type {
  FindingView,
  RuleExecutionJournal,
  RulesetSnapshot,
  ValidationSummary,
} from '@id/api';
import type { JobContext, JobHandler } from '@id/api';

/** Версия движка правил: пишется в сводку прогона. */
export const CHECKS_ENGINE_VERSION = 's9.1';

/**
 * Отказ, относящийся к состоянию настройки, а не к сбою.
 *
 * Неповторяем: пока администратор не опубликует набор правил, повтор задачи
 * ничего не изменит, а `max_attempts` попыток с backoff только зашумят журнал.
 * Признак объявляет сам класс — общее правило, установленное на S8, после того
 * как перечисление классов ошибок дважды дало один и тот же дефект.
 */
export class ChecksStateError extends Error {
  readonly retriable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ChecksStateError';
  }
}

export interface ChecksDeps {
  /** Граф ревизии без ответов внешних реестров. */
  loadGraph(input: {
    readonly revisionId: string;
    readonly today: string;
  }): Promise<Omit<CheckGraph, 'external'>>;

  /** Вывод материалов и партий с записью в БД; возвращает узлы с id строк. */
  saveDerivedMaterials(input: {
    readonly revisionId: string;
    readonly documents: CheckGraph['documents'];
  }): Promise<{ readonly nodes: readonly MaterialNode[]; readonly materials: number }>;

  /** Опубликованный снимок активной версии набора правил; `null` — не назначена. */
  loadActiveRuleset(): Promise<RulesetSnapshot | null>;

  /** Коды реестра правил для сверки с реализациями (§9.6). */
  listRuleDefinitionCodes(): Promise<readonly string[]>;

  startValidationRun(input: {
    readonly revisionId: string;
    readonly rulesetVersionId: string;
    readonly sectionProfileId: string | null;
    readonly objectRuleProfileId: string | null;
  }): Promise<{ readonly id: string }>;

  saveFindings(input: {
    readonly validationRunId: string;
    readonly revisionId: string;
    readonly findings: readonly PreparedFinding[];
  }): Promise<{ readonly removed: number; readonly written: number; readonly evidence: number }>;

  /** Журнал исполнения правил: пишется задачей 20, читается задачей 21. */
  saveRunJournal(input: {
    readonly validationRunId: string;
    readonly revisionId: string;
    readonly journal: RuleExecutionJournal;
  }): Promise<void>;

  loadRunJournal(input: {
    readonly validationRunId: string;
    readonly revisionId: string;
  }): Promise<RuleExecutionJournal | null>;

  /** Замечания прогона ЧИТАЮТСЯ обратно: сводка описывает записанное. */
  listFindings(input: {
    readonly revisionId: string;
    readonly validationRunId: string;
  }): Promise<readonly FindingView[]>;

  finishValidationRun(input: {
    readonly validationRunId: string;
    readonly revisionId: string;
    readonly summary: ValidationSummary;
  }): Promise<void>;

  /** Провайдеры внешних реестров (§9.5). В MVP — internal без источников. */
  readonly registries: ExternalRegistryProviders;
}

// =====================================================================
// Задача 20. checks.run
// =====================================================================

/**
 * Прогон правил над ревизией.
 *
 * Порядок шагов значим:
 *
 * 1. сверка реестра правил с реализациями — до всего остального: расхождение
 *    означает, что часть проверок не исполнится, и прогон, начатый в таком
 *    состоянии, дал бы неполный результат, выглядящий полным;
 * 2. граф без материалов;
 * 3. вывод материалов и их ЗАПИСЬ — до правил, потому что замечание о партии
 *    обязано ссылаться на существующую строку;
 * 4. опрос внешних реестров — один раз на прогон, вне правил (§9.5);
 * 5. исполнение правил снимком опубликованного набора;
 * 6. запись замечаний;
 * 7. постановка сводки.
 */
export function createChecksRunHandler(deps: ChecksDeps): JobHandler<'checks.run'> {
  return async (ctx: JobContext<'checks.run'>) => {
    const { revisionId } = ctx.payload;

    // 1. Сверка §9.6. Ошибка — не «предупреждение в журнале»: правило,
    // включённое администратором и не имеющее реализации, молча не исполняется,
    // и отличить это от исправной работы нечем.
    const definitionCodes = await deps.listRuleDefinitionCodes();
    try {
      reconcileRuleRegistry(definitionCodes, RULE_CATALOG);
    } catch (error) {
      if (error instanceof RuleRegistryError) {
        throw new ChecksStateError(
          `Прогон проверок невозможен: ${error.message}. ` +
            'Примените миграцию сида правил или согласуйте каталог реализаций.',
        );
      }
      throw error;
    }

    const snapshot = await deps.loadActiveRuleset();
    if (snapshot === null) {
      throw new ChecksStateError(
        'Активная версия набора правил не назначена: опубликуйте набор и укажите его ' +
          'активным в администрировании (§3.7).',
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const base = await deps.loadGraph({ revisionId, today });

    if (base.documents.length === 0) {
      throw new ChecksStateError(
        `Ревизия ${revisionId}: логических документов нет, проверять нечего. ` +
          'Сначала должна отработать сегментация (задачи 14–19).',
      );
    }

    const derived = await deps.saveDerivedMaterials({
      revisionId,
      documents: base.documents,
    });

    const external = await resolveExternalRegistries(deps.registries, queryOf(base));
    const graph: CheckGraph = { ...base, materials: derived.nodes, external };

    const run = await deps.startValidationRun({
      revisionId,
      rulesetVersionId: snapshot.versionId,
      sectionProfileId: graph.profile.sectionProfileId,
      objectRuleProfileId: graph.profile.objectProfileIds.at(-1) ?? null,
    });

    const result: RuleRunResult = runRules(graph, {
      specs: RULE_CATALOG,
      snapshot: snapshot.rules,
      // Пустой список профиля и отсутствие списка — РАЗНОЕ (§9.1, строка 4):
      // пустой означает, что администратор выключил всё, и это законное
      // решение; отсутствие настройки означает «ограничений нет».
      enabledRuleCodes:
        graph.profile.enabledRuleCodes.length === 0 && graph.profile.sectionProfileId === null
          ? null
          : graph.profile.enabledRuleCodes,
    });

    // Ни одно правило не исполнилось — это отказ, а не «замечаний нет».
    if (result.executions.length === 0) {
      throw new ChecksStateError(
        `Ревизия ${revisionId}: не исполнено ни одного правила. ` +
          `Пропущено ${String(Object.keys(result.skipped).length)} кодов; ` +
          'проверьте enabled_rule_codes профиля и состав снимка набора правил.',
      );
    }

    const saved = await deps.saveFindings({
      validationRunId: run.id,
      revisionId,
      findings: result.findings,
    });

    if (saved.written !== result.findings.length) {
      throw new Error(
        `Записано ${String(saved.written)} замечаний из ${String(result.findings.length)}.`,
      );
    }

    // Журнал исполнения пишется ДО постановки сводки: сводка обязана найти
    // его в базе независимо от того, какой процесс её подхватит.
    await deps.saveRunJournal({
      validationRunId: run.id,
      revisionId,
      journal: {
        engineVersion: CHECKS_ENGINE_VERSION,
        rulesetVersion: snapshot.version,
        executions: result.executions.map((execution) => ({ ...execution })),
        skippedCodes: result.skipped,
        externalRegistriesUnavailable: unavailableNames(external),
        engineCounts: result.counts,
      },
    });

    ctx.logger.info(
      {
        validationRunId: run.id,
        ruleset: snapshot.version,
        counts: result.counts,
        materials: derived.materials,
      },
      'правила исполнены',
    );

    await ctx.emit('checks.run_completed', {
      validationRunId: run.id,
      executed: result.counts.executed,
      findings: saved.written,
    });

    // Между прогоном правил и сводкой встаёт ИИ-проверка заполнения (S21):
    // её замечания принадлежат ЭТОМУ же прогону, и сводка обязана считаться
    // уже с ними. Сводку ставит она сама — в том числе когда пропускает себя
    // (нет промта, нет провайдера), иначе конвейер обрывался бы ровно там, где
    // внешняя модель не настроена.
    await ctx.enqueue({
      type: 'checks.llm_review',
      payload: { revisionId, validationRunId: run.id },
      dedupeKey: `checks.llm_review:${run.id}`,
    });
  };
}

function unavailableNames(external: CheckGraph['external']): readonly string[] {
  return (Object.keys(external) as (keyof CheckGraph['external'])[]).filter(
    (key) => external[key].status === 'unavailable',
  );
}

function queryOf(graph: Omit<CheckGraph, 'external'>): RegistryQuery {
  const inns = new Set<string>();
  const people = new Set<string>();
  const accreditations = new Set<string>();
  const dates = new Set<string>([graph.today]);

  for (const counterparty of graph.counterparties) {
    if (counterparty.inn !== null) inns.add(counterparty.inn);
  }
  for (const document of graph.documents) {
    for (const value of document.fields) {
      if (value.valueText === null || value.valueText.trim() === '') continue;
      if (value.fieldCode === 'manufacturer_inn') inns.add(value.valueText);
      if (value.fieldCode === 'issuer_accreditation') accreditations.add(value.valueText);
      if (value.fieldCode === 'signers') people.add(value.valueText);
      if (value.valueDate !== null) dates.add(value.valueDate);
    }
  }

  return {
    objectId: graph.revision.objectId,
    contractorId: graph.revision.contractorId,
    inns: [...inns],
    people: [...people],
    accreditationNumbers: [...accreditations],
    onDates: [...dates],
  };
}

// =====================================================================
// Задача 21. checks.summarize
// =====================================================================

/**
 * Сводка прогона по ЗАПИСАННЫМ замечаниям.
 *
 * Счётчики по тяжести, состоянию и блокирующим считаются чтением из
 * `findings`, а не по памяти прогона. Разойдясь, эти два числа означают, что
 * часть замечаний не записалась, и сводка обязана показывать второе — то, что
 * реально увидит инженер.
 */
export function createChecksSummarizeHandler(deps: ChecksDeps): JobHandler<'checks.summarize'> {
  return async (ctx: JobContext<'checks.summarize'>) => {
    const { revisionId, validationRunId } = ctx.payload;

    const stored = await deps.listFindings({ revisionId, validationRunId });
    const journal = await deps.loadRunJournal({ revisionId, validationRunId });

    // Журнала нет — значит задача 20 по этому прогону не отработала. Сводка,
    // построенная в таком состоянии, показала бы «ноль замечаний» как
    // результат проверки, а не как её отсутствие.
    if (journal === null) {
      throw new ChecksStateError(
        `Прогон ${validationRunId}: журнал исполнения правил не записан. ` +
          'Сводка по неисполненному прогону не строится.',
      );
    }

    const by = (predicate: (finding: FindingView) => boolean): number =>
      stored.filter(predicate).length;

    const summary: ValidationSummary = {
      rulesTotal: journal.engineCounts.rulesTotal,
      executed: journal.engineCounts.executed,
      passed: journal.engineCounts.passed,
      failed: journal.engineCounts.failed,
      undetermined: journal.engineCounts.undetermined,
      notApplicable: journal.engineCounts.notApplicable,
      skipped: Object.keys(journal.skippedCodes).length,
      findings: stored.length,
      blocking: by((finding) => finding.isBlocking),
      errors: by((finding) => finding.severity === 'error'),
      warnings: by((finding) => finding.severity === 'warning'),
      infos: by((finding) => finding.severity === 'info'),
      externalUnavailable: by((finding) => finding.origin === 'external_unavailable'),
      journal,
    };

    await deps.finishValidationRun({ validationRunId, revisionId, summary });

    ctx.logger.info(
      { validationRunId, findings: summary.findings, blocking: summary.blocking },
      'сводка проверок записана',
    );
    await ctx.emit('checks.summarized', {
      validationRunId,
      findings: summary.findings,
      blocking: summary.blocking,
      errors: summary.errors,
      undetermined: by((finding) => finding.state === 'undetermined'),
    });
  };
}
