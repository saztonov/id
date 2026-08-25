/**
 * Правила дат (§9.2) и правила подписей (`SIG.*`).
 *
 * ## Почему здесь нет ни одного «универсального» срока
 *
 * §9.2 начинается с отрицания: «универсального „действует на дату окончания
 * работ“ нет». Релевантная дата документа определяется СВЯЗЬЮ — сертификат
 * проверяется на дату производства, поставки или применения по основанию
 * профиля объекта, протокол — на дату испытания, поверка прибора — на дату
 * измерения. Поэтому ни одно правило файла не берёт `graph.today` в качестве
 * «даты события»: `today` фигурирует ровно в одном месте — `DATE.302`, которое
 * и означает «истёк на дату проверки», а не «не действовал в момент
 * применения».
 *
 * ## Почему неизвестная дата даёт `undetermined`, а не `fail`
 *
 * Прямая цитата §9.2: «Если нужная дата или тип связи неизвестны —
 * `undetermined`, а не `fail`». Отсутствие связи документа с актом — это
 * состояние конвейера (сегментация не построила ребро, OCR не прочитал дату), а
 * не дефект комплекта подрядчика. Объявить дефектом то, чего система не смогла
 * прочитать, — самый быстрый способ разрушить доверие к порталу (§9.1).
 * Поэтому у КАЖДОГО правила дат есть ветка «релевантная дата не определена», и
 * она порождает `unknown(...)` с текстом, называющим, чего именно не хватает.
 *
 * ## Почему уверенность не понижается здесь
 *
 * Правило обязано лишь приложить `confidence` источника факта
 * (`effectiveConfidence`), а понижение `fail → undetermined` делает движок
 * (`softenByConfidence`). Сорок реализаций, каждая из которых помнит про порог,
 * — это сорок мест, где о нём можно забыть, а забывание выглядит как исправная
 * работа.
 *
 * ## Почему нет таблиц ГОСТ и СП
 *
 * Сроки действия сертификатов, классы бетона и нормативные интервалы в код НЕ
 * зашиты. Всё, что не напечатано в документе и не задано параметром снимка или
 * профиля, — неизвестно. Выдуманный норматив даёт ложную ошибку с видом
 * законного вывода, и проверить её инженеру нечем.
 */
import {
  ACT_FIELDS,
  ACT_TYPES,
  actField,
  daysBetween,
  documentById,
  documentsOfType,
  effectiveConfidence,
  evidenceOf,
  field,
  foldHomoglyphs,
  formatDate,
  isAnalysisAnchor,
  isIsoDate,
  isRegistryCode,
  parentsOf,
  PROTOCOL_TYPES,
  relevantDateFor,
  textOf,
  threshold,
} from './helpers.js';
import { defect, externalUnavailable, fromFindings, notApplicable, unknown } from './result.js';
import type { RelevantDate } from './helpers.js';
import type {
  BatchNode,
  CheckGraph,
  DocumentNode,
  FieldNode,
  FindingEvidence,
  RuleFinding,
  RuleParams,
  RuleResult,
  RuleSpec,
  WaiverRole,
} from './types.js';

// ---------------------------------------------------------------------------
// Общие вспомогательные структуры
// ---------------------------------------------------------------------------

/** Кому позволено снимать замечание. Блокирующее — только руководителю (§9.6). */
const BLOCKING_WAIVERS: readonly WaiverRole[] = ['manager'];
const SOFT_WAIVERS: readonly WaiverRole[] = ['engineer', 'manager'];

/**
 * Значение даты вместе с полем-источником.
 *
 * Источник нужен не для красоты: из него берутся `evidence`, страница, блок и
 * `confidence`. Замечание без цитаты и без страницы неадресуемо, а без
 * уверенности движок не сможет применить §9.1 («низкая уверенность не даёт
 * `fail`»).
 */
interface DateRef {
  readonly value: string | null;
  readonly source: FieldNode | null;
}

function dateRef(document: DocumentNode, fieldCode: string): DateRef {
  const source = field(document, fieldCode);
  const raw = source?.valueDate ?? null;
  return { value: isIsoDate(raw) ? raw : null, source };
}

/**
 * То же для реквизита АКТА: код канонический, исторические имена читаются.
 *
 * Отдельная функция, а не флаг у `dateRef`: группы совместимости привязаны к
 * типу `aosr`, и применять их к документу качества было бы неверно —
 * `date_start`/`date_end` там означают собственные даты бланка.
 */
function actDateRef(act: DocumentNode, fieldCode: string): DateRef {
  const source = actField(act, fieldCode);
  const raw = source?.valueDate ?? null;
  return { value: isIsoDate(raw) ? raw : null, source };
}

/** Акт освидетельствования, к которому документ привязан ребром графа. */
function actOf(graph: CheckGraph, document: DocumentNode): DocumentNode | null {
  return (
    parentsOf(graph, document.id).find(
      (parent) => parent.docTypeCode !== null && ACT_TYPES.test(parent.docTypeCode),
    ) ?? null
  );
}

/**
 * Дата выполнения работ по акту.
 *
 * Отдельно от `relevantDateFor` потому, что «применение материала» — это всегда
 * работы по акту, независимо от основания профиля. Под основанием `production`
 * `relevantDateFor` вернул бы дату изготовления самого документа, и сравнение
 * «изготовлено не позже применения» превратилось бы в сравнение величины с
 * самой собой.
 */
function worksDateOf(act: DocumentNode | null): DateRef {
  if (act === null) return { value: null, source: null };
  const end = actDateRef(act, ACT_FIELDS.dateEnd);
  if (end.value !== null) return end;
  return actDateRef(act, ACT_FIELDS.actDate);
}

/** Основание релевантной даты словами: текст замечания обязан быть проверяемым. */
const BASIS_LABEL: Readonly<Record<string, string>> = {
  production: 'дата производства',
  delivery: 'дата поставки',
  application: 'дата применения',
};

interface Relevant {
  readonly act: DocumentNode | null;
  readonly date: RelevantDate | null;
}

function relevantOf(graph: CheckGraph, document: DocumentNode): Relevant {
  const act = actOf(graph, document);
  return { act, date: relevantDateFor(graph, document, act) };
}

/** Человекочитаемое обозначение документа для текста замечания. */
function documentLabel(document: DocumentNode): string {
  const number = textOf(document, 'number');
  const name = document.title ?? document.docTypeCode ?? 'документ';
  return number === null ? `«${name}»` : `«${name}» № ${number}`;
}

function batchLabel(batch: BatchNode): string {
  const parts = [
    batch.batchNo === null ? null : `партия № ${batch.batchNo}`,
    batch.heatNo === null ? null : `плавка № ${batch.heatNo}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'партия без номера' : parts.join(', ');
}

interface FindingAddress {
  readonly origin: 'deterministic';
  readonly targetType: 'document';
  readonly targetId: string;
  readonly sourcePageId: string | null;
  readonly blockId: string | null;
  readonly evidence: readonly FindingEvidence[];
  readonly confidence: number | null;
}

/** Общая часть замечания к документу: адрес, цитата, уверенность. */
function at(document: DocumentNode, source: FieldNode | null): FindingAddress {
  return {
    origin: 'deterministic',
    targetType: 'document',
    targetId: document.id,
    sourcePageId: source?.sourcePageId ?? document.pages[0]?.sourcePageId ?? null,
    blockId: source?.blockId ?? null,
    evidence: evidenceOf(source),
    confidence: effectiveConfidence(source),
  };
}

/**
 * Замечание «релевантная дата не определена».
 *
 * Отдельная функция, а не двенадцать похожих строк: текст обязан называть и
 * основание профиля, и причину, иначе инженер не поймёт, чинить ли ему связь
 * документа с актом или распознавание дат акта.
 */
function unknownRelevant(
  graph: CheckGraph,
  document: DocumentNode,
  relevant: Relevant,
  aspect: string,
): RuleFinding {
  const basis = BASIS_LABEL[graph.profile.relevantDateBasis] ?? graph.profile.relevantDateBasis;
  const cause =
    relevant.act === null
      ? 'документ не связан ребром графа ни с одним актом освидетельствования'
      : 'у связанного акта не распознаны ни дата окончания работ, ни дата акта';
  return unknown({
    ...at(document, null),
    message: `${documentLabel(document)}: релевантная дата (основание профиля — ${basis}) не определена, ${cause}; вывод о ${aspect} не сделан`,
    hint: 'привяжите документ к акту освидетельствования и проверьте распознавание дат акта либо дат изготовления и отгрузки',
  });
}

/**
 * Документы, СРОК ДЕЙСТВИЯ которых вообще имеет смысл.
 *
 * ## Что это отсекает и почему это не сужение проверки
 *
 * Правила `DATE.3xx` отвечают на один вопрос: действовал ли документ,
 * ПОДТВЕРЖДАЮЩИЙ материал, в момент применения материала. Ни акт
 * освидетельствования, ни реестр приложений такого утверждения не несут:
 *
 * - **акт** ничего не подтверждает, он фиксирует факт работ. У акта нет срока
 *   действия, и «акт истёк» — утверждение без смысла;
 * - **реестр приложений** составляется В ДЕНЬ подписания акта, то есть по
 *   построению позже окончания работ. `DATE.310` («выдан позже применения»)
 *   объявлял бы его дефектом на КАЖДОМ комплекте, где реестр есть.
 *
 * Оба случая наблюдались на корпусе ровно в тот момент, когда даты акта начали
 * распознаваться: до этого релевантная дата была неизвестна, и правила молчали
 * с вердиктом `undetermined`. То есть дефект существовал всё это время и был
 * замаскирован другим дефектом.
 *
 * ## Чего фильтр НЕ делает
 *
 * Не отсекает документы незнакомого и резервного типа. §9.1, строка 1: базовые
 * правила дат работают даже там, где типо-специфичные дают `n_a`, — иначе
 * незнакомый раздел вообще не проверялся бы на сроки, а именно ради этого §8.4
 * применяет базовую схему реквизитов ко всем документам. Отсекаются ровно две
 * РОЛИ, а не «всё, чего мы не знаем».
 */
function documentsWithValidity(graph: CheckGraph): readonly DocumentNode[] {
  return graph.documents.filter(
    (document) => !isAnalysisAnchor(document.docTypeCode) && !isRegistryCode(document.docTypeCode),
  );
}

// ---------------------------------------------------------------------------
// DATE.300 — интервальный документ действует на релевантную дату
// ---------------------------------------------------------------------------

/**
 * Работает и на документах НЕИЗВЕСТНОГО типа.
 *
 * §9.1, строка 1: «базовые правила дат и сверки с реестром работают» даже
 * тогда, когда типо-специфичные дают `n_a`. Отсечь здесь `isKnownType === false`
 * значило бы, что незнакомый раздел вообще не проверяется на сроки, — а именно
 * ради этого §8.4 применяет базовую схему реквизитов ко всем документам.
 */
function evaluateInterval(graph: CheckGraph): RuleResult {
  const findings: RuleFinding[] = [];
  let applicable = 0;

  for (const document of documentsWithValidity(graph)) {
    const from = dateRef(document, 'valid_from');
    const to = dateRef(document, 'valid_to');
    if (from.value === null || to.value === null) continue;
    applicable += 1;

    const relevant = relevantOf(graph, document);
    if (relevant.date === null) {
      findings.push(
        unknownRelevant(graph, document, relevant, 'действии документа на дату применения'),
      );
      continue;
    }

    const period = `${formatDate(from.value)} — ${formatDate(to.value)}`;
    if (relevant.date.date < from.value || relevant.date.date > to.value) {
      findings.push(
        defect({
          ...at(document, relevant.date.date > to.value ? to.source : from.source),
          message: `${documentLabel(document)} действует ${period}, а релевантная дата (${relevant.date.basis}) — ${formatDate(relevant.date.date)}: документ не действовал в этот момент`,
          hint: 'приложите документ, действующий на релевантную дату, либо отметку о подтверждении действия',
        }),
      );
    }
  }

  if (applicable === 0) {
    return notApplicable(
      'в комплекте нет документов с распознанными датами начала и окончания действия',
    );
  }
  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.302 — истёк на дату проверки
// ---------------------------------------------------------------------------

/**
 * Единственное правило файла, опирающееся на `graph.today`.
 *
 * Это НЕ дефект комплекта: документ мог законно действовать в день применения
 * материала и истечь позже. Отсюда `info` и отсутствие блокировки — §9.1 прямо
 * отделяет текущую дату от даты релевантного события, и `DATE.300` против
 * `DATE.302` держатся именно на этом различии.
 */
function evaluateExpiredToday(graph: CheckGraph): RuleResult {
  const findings: RuleFinding[] = [];
  let applicable = 0;

  for (const document of documentsWithValidity(graph)) {
    const to = dateRef(document, 'valid_to');
    if (to.value === null) continue;
    applicable += 1;
    if (to.value < graph.today) {
      findings.push(
        defect({
          ...at(document, to.source),
          message: `${documentLabel(document)} истёк ${formatDate(to.value)} (дата проверки — ${formatDate(graph.today)}); на действительность комплекта в момент выполнения работ это само по себе не влияет`,
          hint: 'если документ нужен для последующих поставок, запросите действующую версию',
        }),
      );
    }
  }

  if (applicable === 0) {
    return notApplicable('в комплекте нет документов с распознанной датой окончания действия');
  }
  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.303 — ещё не действовал на релевантную дату
// ---------------------------------------------------------------------------

function evaluateNotYetValid(graph: CheckGraph): RuleResult {
  const findings: RuleFinding[] = [];
  let applicable = 0;

  for (const document of documentsWithValidity(graph)) {
    const from = dateRef(document, 'valid_from');
    if (from.value === null) continue;
    applicable += 1;

    const relevant = relevantOf(graph, document);
    if (relevant.date === null) {
      findings.push(unknownRelevant(graph, document, relevant, 'начале действия документа'));
      continue;
    }
    if (relevant.date.date < from.value) {
      findings.push(
        defect({
          ...at(document, from.source),
          message: `${documentLabel(document)} действует с ${formatDate(from.value)}, а релевантная дата (${relevant.date.basis}) — ${formatDate(relevant.date.date)}: на этот момент документ ещё не действовал`,
          hint: 'приложите документ, действовавший на релевантную дату, либо уточните даты работ в акте',
        }),
      );
    }
  }

  if (applicable === 0) {
    return notApplicable('в комплекте нет документов с распознанной датой начала действия');
  }
  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.304 — отметка о подтверждении действия покрывает период
// ---------------------------------------------------------------------------

/**
 * Применимо только к документу, у которого есть И исходный интервал, И отметка.
 *
 * Требование `valid_to` здесь не формальность: поле `valid_until` без исходного
 * интервала означает не продление, а срок поверки прибора, и его проверяет
 * `DATE.331`. Без этого разделения два правила молча спорили бы об одном поле.
 */
function evaluateProlongation(graph: CheckGraph): RuleResult {
  const findings: RuleFinding[] = [];
  let applicable = 0;

  for (const document of documentsWithValidity(graph)) {
    const to = dateRef(document, 'valid_to');
    const until = dateRef(document, 'valid_until');
    if (to.value === null || until.value === null) continue;
    applicable += 1;

    const relevant = relevantOf(graph, document);
    if (relevant.date === null) {
      findings.push(
        unknownRelevant(graph, document, relevant, 'покрытии периода отметкой о продлении'),
      );
      continue;
    }
    if (until.value < relevant.date.date) {
      findings.push(
        defect({
          ...at(document, until.source),
          message: `${documentLabel(document)}: отметка о подтверждении действия продлевает документ до ${formatDate(until.value)}, а релевантная дата (${relevant.date.basis}) — ${formatDate(relevant.date.date)}: период не покрыт`,
          hint: 'приложите отметку о подтверждении действия, покрывающую релевантную дату',
        }),
      );
    }
  }

  if (applicable === 0) {
    return notApplicable(
      'в комплекте нет документов с отметкой о подтверждении действия при известном сроке окончания',
    );
  }
  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.310 — разовый документ выдан не позже применения
// ---------------------------------------------------------------------------

function evaluateIssuedBeforeUse(graph: CheckGraph): RuleResult {
  const findings: RuleFinding[] = [];
  let applicable = 0;

  for (const document of documentsWithValidity(graph)) {
    const issued = dateRef(document, 'issued_at');
    if (issued.value === null) continue;
    // Интервальные документы проверяются `DATE.300`/`DATE.303`: у них дата
    // выдачи не определяет период действия.
    if (dateRef(document, 'valid_from').value !== null) continue;
    if (dateRef(document, 'valid_to').value !== null) continue;
    applicable += 1;

    const relevant = relevantOf(graph, document);
    if (relevant.date === null) {
      findings.push(
        unknownRelevant(graph, document, relevant, 'дате выдачи относительно применения'),
      );
      continue;
    }
    if (issued.value > relevant.date.date) {
      findings.push(
        defect({
          ...at(document, issued.source),
          message: `${documentLabel(document)} выдан ${formatDate(issued.value)}, то есть позже релевантной даты (${relevant.date.basis}) ${formatDate(relevant.date.date)}: документ не мог подтверждать материал в момент применения`,
          hint: 'проверьте дату выдачи документа и даты работ в акте либо приложите документ, выданный до применения',
        }),
      );
    }
  }

  if (applicable === 0) {
    return notApplicable('в комплекте нет разовых документов с распознанной датой выдачи');
  }
  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.311 — документ не абсурдно старый
// ---------------------------------------------------------------------------

/**
 * Порог — ПАРАМЕТР, а не норматив.
 *
 * Никакого «сертификат действует три года» в коде нет и быть не может (§9.2,
 * §0.5): срок задаёт документ, а не движок. `maxAgeDays` отвечает на другой
 * вопрос — насколько давняя дата выдачи выглядит как ошибка распознавания или
 * подмена документа. Отсюда `warning` и отсутствие блокировки.
 *
 * Порог берётся `threshold()`: `thresholds` профиля раздела поверх параметров
 * снимка набора правил (§9.2 требует порогов ИЗ ПРОФИЛЯ). Обоснование
 * приоритета — в докстринге `threshold` в `helpers.ts`.
 */
function evaluateAbsurdlyOld(graph: CheckGraph, params: RuleParams): RuleResult {
  const maxAgeDays = threshold(graph.profile, params, 'maxAgeDays', 3650);
  const findings: RuleFinding[] = [];
  let applicable = 0;

  for (const document of documentsWithValidity(graph)) {
    const issued = dateRef(document, 'issued_at');
    if (issued.value === null) continue;
    applicable += 1;

    const relevant = relevantOf(graph, document);
    if (relevant.date === null) {
      findings.push(unknownRelevant(graph, document, relevant, 'возрасте документа'));
      continue;
    }
    const age = daysBetween(issued.value, relevant.date.date);
    if (age > maxAgeDays) {
      findings.push(
        defect({
          ...at(document, issued.source),
          message: `${documentLabel(document)} выдан ${formatDate(issued.value)} — за ${age} дн. до релевантной даты (${relevant.date.basis}) ${formatDate(relevant.date.date)}, что превышает порог ${maxAgeDays} дн.`,
          hint: 'проверьте, тот ли документ приложен и верно ли распознана дата выдачи',
        }),
      );
    }
  }

  if (applicable === 0) {
    return notApplicable('в комплекте нет документов с распознанной датой выдачи');
  }
  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.312 — партия изготовлена не позже применения
// ---------------------------------------------------------------------------

/** Работы, к которым относится партия: акт над любым из её документов. */
function worksDateForBatch(graph: CheckGraph, batch: BatchNode): DateRef {
  for (const documentId of batch.documentIds) {
    const document = documentById(graph, documentId);
    if (document === null) continue;
    const date = worksDateOf(actOf(graph, document));
    if (date.value !== null) return date;
  }
  return { value: null, source: null };
}

function evaluateBatchManufactured(graph: CheckGraph): RuleResult {
  const findings: RuleFinding[] = [];
  let applicable = 0;

  for (const material of graph.materials) {
    for (const batch of material.batches) {
      applicable += 1;
      const base = {
        origin: 'deterministic' as const,
        targetType: 'batch' as const,
        targetId: batch.id,
        sourcePageId: null,
        blockId: null,
        evidence: [] as readonly FindingEvidence[],
        confidence: null,
      };
      const label = `${material.nameRaw}, ${batchLabel(batch)}`;

      if (!isIsoDate(batch.manufacturedAt)) {
        findings.push(
          unknown({
            ...base,
            message: `${label}: дата изготовления партии не распознана, сравнение с датой работ не выполнено`,
            hint: 'проверьте распознавание даты изготовления в документе о качестве партии',
          }),
        );
        continue;
      }

      const works = worksDateForBatch(graph, batch);
      if (works.value === null) {
        findings.push(
          unknown({
            ...base,
            message: `${label}: дата выполнения работ не определена — партия не связана через документы качества ни с одним актом с распознанными датами; сравнение не выполнено`,
            hint: 'привяжите документы качества партии к акту освидетельствования',
          }),
        );
        continue;
      }

      if (batch.manufacturedAt > works.value) {
        findings.push(
          defect({
            ...base,
            sourcePageId: works.source?.sourcePageId ?? null,
            blockId: works.source?.blockId ?? null,
            evidence: evidenceOf(works.source),
            confidence: effectiveConfidence(works.source),
            message: `${label} изготовлена ${formatDate(batch.manufacturedAt)}, а работы по акту выполнены к ${formatDate(works.value)}: материал не мог быть применён до изготовления`,
            hint: 'проверьте дату изготовления партии и даты работ в акте, при необходимости замените документ о качестве',
          }),
        );
      }
    }
  }

  if (applicable === 0) {
    return notApplicable('в комплекте нет партий материалов');
  }
  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.320 — отгрузка смеси и сохраняемость
// ---------------------------------------------------------------------------

/**
 * Сохраняемость смеси нормативом здесь не задаётся.
 *
 * `workabilityHours` попадает только в ТЕКСТ замечания как ориентир из
 * конфигурации (профиль поверх снимка); сравнение идёт по дням (`maxDaysBetweenShipmentAndUse`), потому что в
 * реквизитах корпуса время суток не распознаётся — есть только дата отгрузки.
 * Сравнивать часы, которых нет, значило бы выдумывать точность.
 */
function evaluateMixShipment(graph: CheckGraph, params: RuleParams): RuleResult {
  const maxDays = threshold(graph.profile, params, 'maxDaysBetweenShipmentAndUse', 0);
  const workabilityHours = threshold(graph.profile, params, 'workabilityHours', 4);

  const targets = documentsOfType(graph, 'mix_quality_doc').filter(
    (document) => document.isKnownType && !document.isFallbackType,
  );
  if (targets.length === 0) {
    return notApplicable(
      'в комплекте нет документов о качестве смеси с уверенно определённым типом',
    );
  }

  const findings: RuleFinding[] = [];
  for (const document of targets) {
    const shipped = dateRef(document, 'shipped_at');
    if (shipped.value === null) {
      findings.push(
        unknown({
          ...at(document, shipped.source),
          message: `${documentLabel(document)}: дата отгрузки смеси не распознана, сохраняемость не проверена`,
          hint: 'проверьте распознавание даты отгрузки в документе о качестве смеси',
        }),
      );
      continue;
    }

    const act = actOf(graph, document);
    const works = worksDateOf(act);
    if (works.value === null) {
      findings.push(unknownRelevant(graph, document, { act, date: null }, 'сохраняемости смеси'));
      continue;
    }

    const gap = Math.abs(daysBetween(shipped.value, works.value));
    if (gap > maxDays) {
      findings.push(
        defect({
          ...at(document, shipped.source),
          message: `${documentLabel(document)}: смесь отгружена ${formatDate(shipped.value)}, а работы по акту датированы ${formatDate(works.value)} — расхождение ${gap} дн. при сохраняемости порядка ${workabilityHours} ч`,
          hint: 'сверьте дату отгрузки смеси с датой укладки; при переносе укладки требуется документ на соответствующую партию',
        }),
      );
    }
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.330 — аккредитация лаборатории действует на дату испытания
// ---------------------------------------------------------------------------

/** Протоколы с уверенно определённым типом: логика типо-специфична (§9.1). */
function protocolsOf(graph: CheckGraph): DocumentNode[] {
  return documentsOfType(graph, PROTOCOL_TYPES).filter(
    (document) => document.isKnownType && !document.isFallbackType,
  );
}

/** Дата испытания: испытание, затем отбор проб, затем дата выдачи протокола. */
function testDateOf(document: DocumentNode): DateRef {
  const tested = dateRef(document, 'tested_at');
  if (tested.value !== null) return tested;
  const sampled = dateRef(document, 'sampled_at');
  if (sampled.value !== null) return sampled;
  return dateRef(document, 'issued_at');
}

function evaluateAccreditationDate(graph: CheckGraph): RuleResult {
  const targets = protocolsOf(graph).filter(
    (document) => dateRef(document, 'issuer_accreditation_valid_to').value !== null,
  );
  if (targets.length === 0) {
    return notApplicable(
      'в комплекте нет протоколов с распознанным сроком действия аккредитации лаборатории',
    );
  }

  const findings: RuleFinding[] = [];
  for (const document of targets) {
    const accreditation = dateRef(document, 'issuer_accreditation_valid_to');
    if (accreditation.value === null) continue;
    const tested = testDateOf(document);

    if (tested.value === null) {
      findings.push(
        unknown({
          ...at(document, accreditation.source),
          message: `${documentLabel(document)}: дата испытания не распознана, действие аккредитации лаборатории на неё не проверено`,
          hint: 'проверьте распознавание даты испытания и даты отбора проб в протоколе',
        }),
      );
      continue;
    }

    if (accreditation.value < tested.value) {
      findings.push(
        defect({
          ...at(document, accreditation.source),
          message: `${documentLabel(document)}: аккредитация лаборатории действует по ${formatDate(accreditation.value)}, а испытание проведено ${formatDate(tested.value)} — на дату испытания аккредитация не действовала`,
          hint: 'запросите протокол лаборатории с действующей на дату испытания аккредитацией',
        }),
      );
    }
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.331 — поверка прибора действует на дату измерения
// ---------------------------------------------------------------------------

function evaluateInstrumentCalibration(graph: CheckGraph): RuleResult {
  const targets = graph.documents.filter((document) => field(document, 'measured_at') !== null);
  if (targets.length === 0) {
    return notApplicable('в комплекте нет документов с реквизитом даты измерения');
  }

  const findings: RuleFinding[] = [];
  for (const document of targets) {
    const measured = dateRef(document, 'measured_at');
    const calibration = dateRef(document, 'valid_until');

    if (measured.value === null) {
      findings.push(
        unknown({
          ...at(document, measured.source),
          message: `${documentLabel(document)}: дата измерения не распознана как дата, действие поверки прибора на неё не проверено`,
          hint: 'проверьте распознавание даты измерения в протоколе',
        }),
      );
      continue;
    }
    if (calibration.value === null) {
      findings.push(
        unknown({
          ...at(document, measured.source),
          message: `${documentLabel(document)}: срок действия поверки прибора не распознан, сопоставление с датой измерения ${formatDate(measured.value)} не выполнено`,
          hint: 'проверьте распознавание сведений о поверке средств измерений',
        }),
      );
      continue;
    }
    if (calibration.value < measured.value) {
      findings.push(
        defect({
          ...at(document, calibration.source),
          message: `${documentLabel(document)}: поверка прибора действует по ${formatDate(calibration.value)}, а измерение выполнено ${formatDate(measured.value)} — на дату измерения поверка истекла`,
          hint: 'запросите протокол с прибором, поверенным на дату измерения',
        }),
      );
    }
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.332 — аккредитация подтверждена внешним реестром
// ---------------------------------------------------------------------------

/** Аттестат сравнивается по буквам и цифрам: OCR даёт разные разделители. */
function normalizeAttestat(value: string): string {
  return foldHomoglyphs(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function evaluateAccreditationRegistry(graph: CheckGraph): RuleResult {
  const targets = graph.documents.filter(
    (document) => textOf(document, 'issuer_accreditation') !== null,
  );
  if (targets.length === 0) {
    return notApplicable(
      'в комплекте нет документов с распознанным номером аттестата аккредитации',
    );
  }

  const lookup = graph.external.accreditation;

  if (lookup.status === 'unavailable') {
    // §9.5: без источника данных вывод об аккредитации — юридическое
    // утверждение, которого система сделать не может. Одно замечание на
    // ревизию, а не по одному на каждый протокол: инженер всё равно пойдёт в
    // реестр один раз.
    const numbers = targets
      .map((document) => textOf(document, 'issuer_accreditation'))
      .filter((value): value is string => value !== null);
    return fromFindings([
      externalUnavailable({
        targetType: 'revision',
        targetId: graph.revision.id,
        sourcePageId: null,
        blockId: null,
        evidence: [],
        confidence: null,
        message: `Аккредитация лабораторий по внешнему реестру не подтверждена: ${lookup.reason}. Аттестаты в комплекте: ${numbers.join(', ')}. Требуется ручная проверка в реестре аккредитованных лиц.`,
        hint: 'проверьте аттестаты в реестре аккредитованных лиц вручную и зафиксируйте результат',
      }),
    ]);
  }

  const findings: RuleFinding[] = [];
  for (const document of targets) {
    const source = field(document, 'issuer_accreditation');
    const number = textOf(document, 'issuer_accreditation');
    if (number === null) continue;
    const normalized = normalizeAttestat(number);
    const record = lookup.records.find(
      (item) => normalizeAttestat(item.registryNumber) === normalized,
    );

    if (record === undefined) {
      findings.push(
        defect({
          ...at(document, source),
          message: `${documentLabel(document)}: аттестат аккредитации ${number} не найден в реестре аккредитованных лиц`,
          hint: 'сверьте номер аттестата с реестром; при опечатке исправьте реквизит, иначе запросите протокол аккредитованной лаборатории',
        }),
      );
      continue;
    }

    const tested = testDateOf(document);
    if (tested.value === null) {
      findings.push(
        unknown({
          ...at(document, source),
          message: `${documentLabel(document)}: аттестат ${number} найден в реестре, но дата испытания не распознана — действие аккредитации на неё не проверено`,
          hint: 'проверьте распознавание даты испытания в протоколе',
        }),
      );
      continue;
    }
    if (isIsoDate(record.validTo) && record.validTo < tested.value) {
      findings.push(
        defect({
          ...at(document, source),
          message: `${documentLabel(document)}: по реестру аккредитация ${number} действует по ${formatDate(record.validTo)}, а испытание проведено ${formatDate(tested.value)}`,
          hint: 'запросите протокол лаборатории с действующей на дату испытания аккредитацией',
        }),
      );
    }
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// DATE.372 — протокол испытаний относится к применённым партиям
// ---------------------------------------------------------------------------

/** Дата протокола: выдача, затем испытание, затем отбор проб. */
function protocolDateOf(document: DocumentNode): DateRef {
  const issued = dateRef(document, 'issued_at');
  if (issued.value !== null) return issued;
  const tested = dateRef(document, 'tested_at');
  if (tested.value !== null) return tested;
  return dateRef(document, 'sampled_at');
}

/**
 * Дефект №4 корпуса.
 *
 * В АОСР №336 (работы 28.02–09.03.2026) приложен протокол №10353.А/06.25 от
 * 20.06.2025, а партии арматуры — от 09.01.2026 и позже. Протокол физически не
 * может относиться к материалу, которого на дату испытаний ещё не существовало,
 * и никакая проверка сроков действия этого не ловит: сам протокол «свежий»
 * относительно работ, а каждая партия изготовлена до работ. Ошибка видна только
 * в сопоставлении протокола с партиями ТОГО ЖЕ акта.
 *
 * Тяжесть — `warning`, а не `error`: связь протокола с партией восстанавливается
 * не только датой (бывает входной контроль по ранее отобранным пробам), и §9.1
 * запрещает превращать неполноту модели в блокирующий вывод.
 */
function evaluateProtocolCoversBatches(graph: CheckGraph, params: RuleParams): RuleResult {
  const graceDays = threshold(graph.profile, params, 'graceDays', 0);
  const targets = protocolsOf(graph);
  if (targets.length === 0) {
    return notApplicable('в комплекте нет протоколов испытаний с уверенно определённым типом');
  }

  const findings: RuleFinding[] = [];
  for (const document of targets) {
    const protocolDate = protocolDateOf(document);
    if (protocolDate.value === null) {
      findings.push(
        unknown({
          ...at(document, protocolDate.source),
          message: `${documentLabel(document)}: ни дата выдачи, ни дата испытания, ни дата отбора проб не распознаны — отнесение протокола к партиям не проверено`,
          hint: 'проверьте распознавание дат протокола',
        }),
      );
      continue;
    }

    const act = actOf(graph, document);
    if (act === null) {
      findings.push(
        unknown({
          ...at(document, protocolDate.source),
          message: `${documentLabel(document)}: протокол не связан ребром графа ни с одним актом освидетельствования — состав применённых партий неизвестен`,
          hint: 'привяжите протокол к акту освидетельствования',
        }),
      );
      continue;
    }

    // Партии «того же акта» — те, чьи документы качества принадлежат этому акту.
    const actDocumentIds = new Set(
      graph.relations
        .filter((edge) => edge.parentDocumentId === act.id)
        .map((edge) => edge.childDocumentId),
    );
    actDocumentIds.add(act.id);

    const dated = graph.materials.flatMap((material) =>
      material.batches
        .filter(
          (batch) =>
            isIsoDate(batch.manufacturedAt) &&
            batch.documentIds.some((id) => actDocumentIds.has(id)),
        )
        .map((batch) => ({ material, batch })),
    );

    if (dated.length === 0) {
      findings.push(
        unknown({
          ...at(document, protocolDate.source),
          message: `${documentLabel(document)}: у акта ${documentLabel(act)} нет партий с распознанной датой изготовления — отнесение протокола к партиям не проверено`,
          hint: 'проверьте распознавание дат изготовления партий в документах о качестве',
        }),
      );
      continue;
    }

    for (const { material, batch } of dated) {
      const manufacturedAt = batch.manufacturedAt;
      if (!isIsoDate(manufacturedAt)) continue;
      if (daysBetween(protocolDate.value, manufacturedAt) > graceDays) {
        findings.push(
          defect({
            ...at(document, protocolDate.source),
            message: `${documentLabel(document)} датирован ${formatDate(protocolDate.value)}, а партия «${material.nameRaw}» (${batchLabel(batch)}) изготовлена ${formatDate(manufacturedAt)}: протокол не может относиться к материалу, которого на дату испытаний ещё не существовало`,
            hint: 'приложите протокол испытаний, относящийся к применённым партиям, либо уточните состав приложений акта',
          }),
        );
      }
    }
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// SIG.STAMP.370 — срок сертификата ЭП по визуальному штампу
// ---------------------------------------------------------------------------

/**
 * Источник — OCR, а не криптография.
 *
 * `docs/CORPUS_FINDINGS.md`: во всех трёх PDF корпуса нет ни `ByteRange`, ни
 * `SubFilter`, ни `/Type/Sig` — штамп «ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ»
 * впечатан в растр страницы системой ЭДО. Поэтому правило НИКОГДА не `error`:
 * вывод о недействительности подписи по распознанной картинке — утверждение,
 * которого система сделать не вправе.
 */
function evaluateSignatureStamp(graph: CheckGraph): RuleResult {
  const targets = graph.documents.filter(
    (document) => field(document, 'signature_stamp_valid_to') !== null,
  );
  if (targets.length === 0) {
    return notApplicable('в комплекте нет документов с распознанным штампом электронной подписи');
  }

  const findings: RuleFinding[] = [];
  for (const document of targets) {
    const stamp = dateRef(document, 'signature_stamp_valid_to');
    if (stamp.value === null) {
      findings.push(
        unknown({
          ...at(document, stamp.source),
          message: `${documentLabel(document)}: срок действия сертификата в штампе ЭП не распознан как дата, проверка не выполнена`,
          hint: 'проверьте распознавание штампа электронной подписи на странице документа',
        }),
      );
      continue;
    }

    // §9.2: у визуального штампа релевантна напечатанная дата подписания, и
    // только если её нет — дата события, к которому документ привязан.
    const signed = dateRef(document, 'signed_at');
    const relevant = relevantOf(graph, document);
    const against =
      signed.value !== null
        ? { date: signed.value, basis: 'дата подписания из штампа', source: signed.source }
        : relevant.date === null
          ? null
          : { date: relevant.date.date, basis: relevant.date.basis, source: relevant.date.source };

    if (against === null) {
      findings.push(unknownRelevant(graph, document, relevant, 'сроке сертификата ЭП'));
      continue;
    }

    if (stamp.value < against.date) {
      findings.push(
        defect({
          ...at(document, stamp.source),
          message: `${documentLabel(document)}: по штампу ЭП сертификат действует по ${formatDate(stamp.value)}, а ${against.basis} — ${formatDate(against.date)}; сведения сняты с изображения штампа, криптографическая проверка не выполнялась`,
          hint: 'проверьте штамп подписи глазами и при подтверждении запросите документ, подписанный действующим сертификатом',
        }),
      );
    }
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// SIG.PDF.371 — структурный зонд встроенной подписи
// ---------------------------------------------------------------------------

/**
 * Зонд отвечает на вопрос «есть ли в файле словарь подписи», а не «действительна
 * ли подпись». `detected_unverified` — это `info`, а не дефект: найдена не
 * значит действительна, и обратное утверждение в MVP недоказуемо.
 */
function evaluateSignatureProbe(graph: CheckGraph): RuleResult {
  const targets = graph.documents.filter((document) => field(document, 'signature_probe') !== null);
  if (targets.length === 0) {
    return notApplicable('в комплекте нет документов с результатом структурного зонда подписи');
  }

  const findings: RuleFinding[] = [];
  for (const document of targets) {
    const probe = field(document, 'signature_probe');
    const value = probe?.valueText ?? null;

    if (value === 'none_detected') continue;

    if (value === 'detected_unverified') {
      findings.push(
        defect({
          ...at(document, probe),
          message: `${documentLabel(document)}: в файле обнаружена встроенная электронная подпись, криптографическая проверка в MVP не выполняется`,
          hint: 'при необходимости проверьте подпись штатным средством проверки ЭП',
        }),
      );
      continue;
    }

    findings.push(
      unknown({
        ...at(document, probe),
        message: `${documentLabel(document)}: результат структурного зонда подписи неизвестен (${value ?? 'значение не задано'}), вывод о встроенной подписи не сделан`,
        hint: 'перезапустите задачу структурного зондирования подписи для исходного файла',
      }),
    );
  }

  return fromFindings(findings);
}

// ---------------------------------------------------------------------------
// Каталог группы
// ---------------------------------------------------------------------------

export const DATE_RULES: readonly RuleSpec[] = [
  {
    code: 'DATE.300',
    title: 'Интервальный документ действует на релевантную дату',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: BLOCKING_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateInterval(graph),
  },
  {
    code: 'DATE.302',
    title: 'Документ истёк на дату проверки',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'info',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateExpiredToday(graph),
  },
  {
    code: 'DATE.303',
    title: 'Документ ещё не действовал на релевантную дату',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: BLOCKING_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateNotYetValid(graph),
  },
  {
    code: 'DATE.304',
    title: 'Отметка о подтверждении действия покрывает период',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateProlongation(graph),
  },
  {
    code: 'DATE.310',
    title: 'Разовый документ выдан не позже применения',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: BLOCKING_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateIssuedBeforeUse(graph),
  },
  {
    code: 'DATE.311',
    title: 'Документ не абсурдно старый',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: { maxAgeDays: 3650 },
    evaluate: evaluateAbsurdlyOld,
  },
  {
    code: 'DATE.312',
    title: 'Партия изготовлена не позже применения',
    docTypeCode: null,
    level: 'material',
    kind: 'dates',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: BLOCKING_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateBatchManufactured(graph),
  },
  {
    code: 'DATE.320',
    title: 'Отгрузка смеси и сохраняемость',
    docTypeCode: 'mix_quality_doc',
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: { workabilityHours: 4, maxDaysBetweenShipmentAndUse: 0 },
    evaluate: evaluateMixShipment,
  },
  {
    code: 'DATE.330',
    title: 'Аккредитация лаборатории действует на дату испытания',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'error',
    defaultBlocking: true,
    waiverRoles: BLOCKING_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateAccreditationDate(graph),
  },
  {
    code: 'DATE.331',
    title: 'Поверка прибора действует на дату измерения',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateInstrumentCalibration(graph),
  },
  {
    code: 'DATE.332',
    title: 'Аккредитация подтверждена внешним реестром',
    docTypeCode: null,
    level: 'document',
    kind: 'external',
    defaultSeverity: 'error',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: 'accreditation',
    defaultParams: {},
    evaluate: (graph) => evaluateAccreditationRegistry(graph),
  },
  {
    code: 'DATE.372',
    title: 'Протокол испытаний относится к применённым партиям',
    docTypeCode: null,
    level: 'document',
    kind: 'dates',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: { graceDays: 0 },
    evaluate: evaluateProtocolCoversBatches,
  },
];

export const SIGNATURE_RULES: readonly RuleSpec[] = [
  {
    code: 'SIG.STAMP.370',
    title: 'Срок сертификата ЭП по визуальному штампу',
    docTypeCode: null,
    level: 'signature',
    kind: 'signatures',
    defaultSeverity: 'warning',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateSignatureStamp(graph),
  },
  {
    code: 'SIG.PDF.371',
    title: 'Структурный зонд встроенной подписи',
    docTypeCode: null,
    level: 'signature',
    kind: 'signatures',
    defaultSeverity: 'info',
    defaultBlocking: false,
    waiverRoles: SOFT_WAIVERS,
    requiresSectionProfile: false,
    requiresExternalRegistry: null,
    defaultParams: {},
    evaluate: (graph) => evaluateSignatureProbe(graph),
  },
];
