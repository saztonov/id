/**
 * Метрики качества сегментации методом leave-one-package-out (§16).
 *
 * ## Что здесь считается и чего здесь НЕ происходит
 *
 * Модуль считает числа для отчёта. Он намеренно не содержит ни одного порога и
 * не умеет «падать»: корпус — три комплекта двух разделов работ из многих, и
 * §0.5 прямо запрещает переносить измеренное на остальные разделы. Гейтом эти
 * числа станут для конкретного раздела тогда, когда раздел наберёт собственную
 * статистику (§16: не менее 5 поставок, доля ручных правок типа ниже 10%, ни
 * одной тихой высокоуверенной ошибки границы), и решение о переходе в
 * `automatic` принимает человек, а не тест.
 *
 * Тестами покрыт сам расчёт, а не его результат на корпусе. Тест «boundary
 * recall ≥ 95%» ловил бы не регресс сегментатора, а факт наличия закрытого
 * корпуса на машине.
 *
 * ## Почему фолд — комплект, а не страница
 *
 * Страницы одного комплекта не должны быть одновременно в калибровке и в
 * оценке: у комплекта общий бланк, общий подрядчик, одна и та же вёрстка
 * штампа «КОПИЯ ВЕРНА» и один и тот же набор подписантов. Классификатор,
 * подсмотревший половину комплекта, на второй половине покажет качество,
 * которого на новой поставке не будет. Поэтому единица разбиения — комплект.
 *
 * ## Почему усреднений ДВА, а не одно
 *
 * Комплекты корпуса разноразмерны: 9, 50 и 83 страницы. Макро-среднее по
 * фолдам даёт комплекту из девяти страниц тот же вес, что комплекту из
 * восьмидесяти трёх, и на этом корпусе расходится с микро на восемь пунктов —
 * 0.831 против 0.746 = 44/59. Оба числа верны и отвечают на разные вопросы:
 * микро — «какую долю документов система нашла», макро — «как она ведёт себя
 * на типичной поставке». Беда начинается там, где выбирают одно: число,
 * читающееся как «нашли 83% документов» при найденных 75%, вводит в
 * заблуждение, даже будучи посчитанным правильно. §16 способ усреднения не
 * задаёт, поэтому здесь считаются и выводятся оба, всегда с явными
 * знаменателями.
 *
 * ## Почему в отчёте есть то, чего нет в F1
 *
 * §16 требует считать F1 только по типам с support >= 3 — это правило РАСЧЁТА.
 * Оно не разрешает выбрасывать типы из ОТЧЁТА, а именно это делало
 * систематическую галлюцинацию невидимой: тип, которого в эталоне нет вовсе,
 * имеет support = 0, в F1 не входит и в список редких не попадал. Поэтому
 * результат содержит `types` (все типы с их весом в корпусе), `phantomTypes`
 * (выдуманные) и `missedBoundaries` (пропуски по типам): один непокрытый класс
 * документов и полтора десятка разрозненных ошибок дают одинаковый recall и
 * требуют разной работы.
 */
import type { ReferencePackage, ReferencePageLabel } from './corpus-reference.js';

/** Предсказание сегментатора по одной странице держащегося комплекта. */
export interface SegmentationPrediction {
  readonly pageNo: number;
  readonly label: ReferencePageLabel;
  readonly docTypeCode: string | null;
  readonly documentKey: string | null;
  /**
   * Уверенность в границе, 0..1.
   *
   * Необязательна, и отсутствие значения трактуется как 1 — то есть как
   * заявленная уверенность. Так и надо: §16 считает более значимым критерием
   * не F1, а ТИХУЮ высокоуверенную ошибку границы, а сегментатор, вовсе не
   * сообщающий уверенность, ошибается ровно тихо.
   */
  readonly boundaryConfidence?: number;
  /** Поднят ли флаг ручной проверки. Ошибка с флагом уже не тихая. */
  readonly needsReview?: boolean;
}

/** Счётчики одного типа документа. */
export interface TypeCounts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Сколько документов этого типа в эталоне фолда. */
  readonly support: number;
}

/** Пропущенные границы одного типа документа: не число, а адрес работы. */
export interface MissedBoundaries {
  /** `null` — у эталонного документа тип не проставлен. */
  readonly code: string | null;
  readonly missed: number;
  /** Сколько документов этого типа в эталоне: 14 из 14 и 14 из 130 — разное. */
  readonly support: number;
}

export interface FoldResult {
  readonly heldOutPackage: string;
  readonly boundaryRecall: number;
  readonly boundaryPrecision: number;
  /** Знаменатели фолда: без них доля не проверяема и не складывается в микро. */
  readonly boundaryMatched: number;
  readonly boundaryReference: number;
  readonly boundaryPredicted: number;
  readonly perType: ReadonlyMap<string, TypeCounts>;
  readonly missedBoundaries: readonly MissedBoundaries[];
  /** Тихие высокоуверенные ошибки границы внутри фолда. */
  readonly silentHighConfidenceBoundaryErrors: number;
}

/** Полный разбор одного типа документа. Выводится и для типов с support = 0. */
export interface TypeReport {
  readonly code: string;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly support: number;
  /**
   * Доля документов этого типа в эталоне корпуса, 0..1.
   *
   * Без неё macro-F1 читается как средневзвешенное, а он им не является:
   * тип, составляющий пятую часть корпуса и опознаваемый с F1 = 0, весит в
   * макро-среднем ровно столько же, сколько тип из трёх документов.
   */
  readonly share: number;
  readonly f1: number;
  /** Вошёл ли тип в macro-F1 (support >= minSupport, §16). */
  readonly countedInMacroF1: boolean;
}

export interface CorpusMetrics {
  readonly folds: readonly FoldResult[];
  /**
   * Микро-recall границ: `boundaryMatched / boundaryReference` по всему корпусу.
   *
   * Это ответ на вопрос «какую долю документов система нашла», и именно так
   * число читают. Считается вместе с макро и НИКОГДА вместо него.
   */
  readonly boundaryRecallMicro: number;
  /**
   * Макро по фолдам: среднее долей, комплект весит как комплект.
   *
   * Отвечает на другой вопрос — «как система ведёт себя на типичной поставке»,
   * и на разноразмерных комплектах расходится с микро в разы: комплект из
   * девяти страниц весит столько же, сколько комплект из восьмидесяти трёх.
   * Одно из двух чисел без второго вводит в заблуждение независимо от того,
   * какое выбрано.
   */
  readonly boundaryRecallMacro: number;
  readonly boundaryPrecisionMicro: number;
  /** Явные знаменатели: «44/59» проверяемо, «0.746» — нет. */
  readonly boundaryMatched: number;
  readonly boundaryReference: number;
  readonly boundaryPredicted: number;
  /**
   * Пропущенные границы по типам, по убыванию числа пропусков.
   *
   * «Один непокрытый класс документов» и «пятнадцать разрозненных ошибок»
   * требуют разной работы: первое чинится якорем, второе — калибровкой.
   * Одно число `recall` их не различает.
   */
  readonly missedBoundaries: readonly MissedBoundaries[];
  /** Макро-F1 ТОЛЬКО по типам с суммарным support >= 3 (§16). */
  readonly macroF1Types: number;
  /** Все типы, встреченные в эталоне ИЛИ выданные сегментатором. */
  readonly types: readonly TypeReport[];
  /** Типы с 0 < support < 3: отдельный список ручной проверки, не число. */
  readonly rareTypes: readonly { readonly code: string; readonly support: number }[];
  /**
   * Типы, которых в эталоне НЕТ вовсе, но сегментатор их выдаёт.
   *
   * Отдельным полем, потому что иначе систематическая галлюцинация типа
   * невидима по построению: в macro-F1 такой тип не попадает (support < 3), а
   * в список редких — не попадал, потому что редким считался тип с support > 0.
   * То есть «сегментатор выдумал вид документа сорок раз» не отражалось в
   * отчёте ни одним числом.
   */
  readonly phantomTypes: readonly { readonly code: string; readonly fp: number }[];
  readonly silentHighConfidenceBoundaryErrors: number;
}

export interface EvaluateOptions {
  /**
   * Порог, выше которого предсказание считается высокоуверенным.
   *
   * Значение по умолчанию — предмет калибровки на пилоте (§7.3: пороги
   * принадлежат версионному профилю), поэтому оно параметр, а не константа.
   */
  readonly highConfidence?: number;
  /** Минимальный support, при котором тип участвует в macro-F1. §16 требует 3. */
  readonly minSupport?: number;
}

const DEFAULT_HIGH_CONFIDENCE = 0.9;
const DEFAULT_MIN_SUPPORT = 3;

/** Документ эталона или предсказания: граница плюс тип. */
interface DocumentView {
  readonly startPage: number;
  readonly docTypeCode: string | null;
}

/**
 * Убирает из комплекта ожидаемые метки перед передачей предсказателю.
 *
 * `ReferencePackage` содержит `expected`, и передать его сегментатору как есть
 * значило бы отдать ему ответы. Тип входа при этом обязан остаться
 * `ReferencePackage`: предсказателю нужны и текст, и геометрия, и состав
 * блоков — всё, кроме ответов.
 */
function blind(pkg: ReferencePackage): ReferencePackage {
  return {
    ...pkg,
    pages: pkg.pages.map((page) => ({
      ...page,
      expected: {
        label: 'U',
        docTypeCode: null,
        typeOutcome: 'none',
        pageRoleCode: null,
        documentKey: null,
      },
    })),
  };
}

/** Эталонные документы комплекта: страница `B-DOC` задаёт границу и тип. */
function referenceDocuments(pkg: ReferencePackage): readonly DocumentView[] {
  return pkg.pages
    .filter((page) => page.expected.label === 'B-DOC')
    .map((page) => ({ startPage: page.pageNo, docTypeCode: page.expected.docTypeCode }));
}

/** Предсказанные документы: та же конструкция, но по меткам сегментатора. */
function predictedDocuments(
  predictions: readonly SegmentationPrediction[],
): readonly DocumentView[] {
  return predictions
    .filter((prediction) => prediction.label === 'B-DOC')
    .map((prediction) => ({ startPage: prediction.pageNo, docTypeCode: prediction.docTypeCode }));
}

function increment(
  counts: Map<string, { tp: number; fp: number; fn: number; support: number }>,
  code: string,
  field: 'tp' | 'fp' | 'fn' | 'support',
): void {
  const entry = counts.get(code) ?? { tp: 0, fp: 0, fn: 0, support: 0 };
  entry[field] += 1;
  counts.set(code, entry);
}

/**
 * Оценивает один фолд: комплект `heldOut` держится, предсказание делается
 * только по нему.
 */
function evaluateFold(
  heldOut: ReferencePackage,
  predictions: readonly SegmentationPrediction[],
  highConfidence: number,
): FoldResult {
  const reference = referenceDocuments(heldOut);
  const predicted = predictedDocuments(predictions);
  const referenceStarts = new Set(reference.map((doc) => doc.startPage));
  const predictedByStart = new Map(predicted.map((doc) => [doc.startPage, doc]));

  const matched = reference.filter((doc) => predictedByStart.has(doc.startPage)).length;
  const boundaryRecall = ratio(matched, reference.length, predicted.length === 0);
  const boundaryPrecision = ratio(matched, predicted.length, reference.length === 0);

  const counts = new Map<string, { tp: number; fp: number; fn: number; support: number }>();
  // Пропуски границ — по типу эталонного документа, а не общим числом: они
  // сосредоточены либо в одном классе документов, либо разбросаны, и это две
  // разные задачи для того, кто будет чинить.
  const missed = new Map<string | null, { missed: number; support: number }>();
  const noteMissed = (code: string | null, isMissed: boolean): void => {
    const entry = missed.get(code) ?? { missed: 0, support: 0 };
    entry.support += 1;
    if (isMissed) entry.missed += 1;
    missed.set(code, entry);
  };

  for (const doc of reference) {
    const code = doc.docTypeCode;
    if (code !== null) increment(counts, code, 'support');
    const hit = predictedByStart.get(doc.startPage);
    noteMissed(code, hit === undefined);
    if (hit !== undefined && hit.docTypeCode === code) {
      if (code !== null) increment(counts, code, 'tp');
      continue;
    }
    // Граница найдена, но тип другой — это одновременно промах по эталонному
    // типу и ложное срабатывание по предсказанному. Считать только первое
    // значило бы прятать систематическую подмену одного типа другим.
    if (code !== null) increment(counts, code, 'fn');
    if (hit !== undefined && hit.docTypeCode !== null) increment(counts, hit.docTypeCode, 'fp');
  }
  for (const doc of predicted) {
    if (referenceStarts.has(doc.startPage)) continue;
    if (doc.docTypeCode !== null) increment(counts, doc.docTypeCode, 'fp');
  }

  let silent = 0;
  for (const prediction of predictions) {
    const isBoundary = prediction.label === 'B-DOC';
    const shouldBeBoundary = referenceStarts.has(prediction.pageNo);
    if (isBoundary === shouldBeBoundary) continue;
    const confidence = prediction.boundaryConfidence ?? 1;
    const flagged = prediction.needsReview ?? false;
    if (!flagged && confidence >= highConfidence) silent += 1;
  }

  return {
    heldOutPackage: heldOut.packageKey,
    boundaryRecall,
    boundaryPrecision,
    boundaryMatched: matched,
    boundaryReference: reference.length,
    boundaryPredicted: predicted.length,
    perType: new Map(counts),
    missedBoundaries: [...missed]
      .filter(([, value]) => value.missed > 0)
      .map(([code, value]) => ({ code, missed: value.missed, support: value.support })),
    silentHighConfidenceBoundaryErrors: silent,
  };
}

/**
 * Отношение с явным поведением на нуле.
 *
 * Ноль эталонных границ при нуле предсказанных — это 1 («ошибок нет»), а не
 * NaN и не 0: иначе пустой комплект портил бы макро-среднее по фолдам.
 */
function ratio(hits: number, total: number, emptyCounterpart: boolean): number {
  if (total > 0) return hits / total;
  return emptyCounterpart ? 1 : 0;
}

/**
 * Считает метрики leave-one-package-out.
 *
 * `predict` получает РОВНО ОДИН комплект — держащийся, и без ожидаемых меток.
 * Остальные комплекты фолда предсказателю не передаются вовсе: если он
 * калибруется, он делает это на своих данных, а не на оценочных.
 */
export function evaluateLeaveOnePackageOut(
  packages: readonly ReferencePackage[],
  predict: (pkg: ReferencePackage) => readonly SegmentationPrediction[],
  options: EvaluateOptions = {},
): CorpusMetrics {
  const highConfidence = options.highConfidence ?? DEFAULT_HIGH_CONFIDENCE;
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;

  const folds = packages.map((pkg) => evaluateFold(pkg, predict(blind(pkg)), highConfidence));

  const totals = new Map<string, { tp: number; fp: number; fn: number; support: number }>();
  for (const fold of folds) {
    for (const [code, counts] of fold.perType) {
      const entry = totals.get(code) ?? { tp: 0, fp: 0, fn: 0, support: 0 };
      entry.tp += counts.tp;
      entry.fp += counts.fp;
      entry.fn += counts.fn;
      entry.support += counts.support;
      totals.set(code, entry);
    }
  }

  // Типы с support < 3 не попадают ни в числитель, ни в знаменатель macro-F1
  // (§16). На двух документах F1 принимает всего несколько значений, и один
  // промах утягивает среднее на десятки процентов — число перестаёт означать
  // качество. Такие типы уходят в список ручной проверки.
  //
  // Но ИЗ ОТЧЁТА они не выпадают, и это разные решения. §16 задаёт правило
  // расчёта F1; выбрасывать тип из отчёта он не требует, а именно это и
  // прятало галлюцинацию: тип с support = 0 и ненулевым fp не попадал ни в
  // одно поле результата.
  const totalSupport = [...totals.values()].reduce((sum, counts) => sum + counts.support, 0);

  const eligible: number[] = [];
  const rareTypes: { code: string; support: number }[] = [];
  const phantomTypes: { code: string; fp: number }[] = [];
  const types: TypeReport[] = [];

  for (const [code, counts] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) {
    const countedInMacroF1 = counts.support >= minSupport;
    if (countedInMacroF1) eligible.push(f1(counts.tp, counts.fp, counts.fn));
    else if (counts.support > 0) rareTypes.push({ code, support: counts.support });
    else if (counts.fp > 0) phantomTypes.push({ code, fp: counts.fp });

    types.push({
      code,
      tp: counts.tp,
      fp: counts.fp,
      fn: counts.fn,
      support: counts.support,
      share: totalSupport === 0 ? 0 : counts.support / totalSupport,
      f1: f1(counts.tp, counts.fp, counts.fn),
      countedInMacroF1,
    });
  }

  const boundaryMatched = folds.reduce((sum, fold) => sum + fold.boundaryMatched, 0);
  const boundaryReference = folds.reduce((sum, fold) => sum + fold.boundaryReference, 0);
  const boundaryPredicted = folds.reduce((sum, fold) => sum + fold.boundaryPredicted, 0);

  const missed = new Map<string | null, { missed: number; support: number }>();
  for (const fold of folds) {
    for (const item of fold.missedBoundaries) {
      const entry = missed.get(item.code) ?? { missed: 0, support: 0 };
      entry.missed += item.missed;
      entry.support += item.support;
      missed.set(item.code, entry);
    }
  }

  const boundaryRecallMacro =
    folds.length === 0 ? 0 : average(folds.map((fold) => fold.boundaryRecall));
  const macroF1Types = eligible.length === 0 ? 0 : average(eligible);

  return {
    folds,
    // Пустой НАБОР комплектов — это не «ошибок нет», а «не измерено ничего»:
    // единица здесь означала бы идеальное качество на нулевом корпусе.
    boundaryRecallMicro:
      folds.length === 0 ? 0 : ratio(boundaryMatched, boundaryReference, boundaryPredicted === 0),
    boundaryRecallMacro,
    boundaryPrecisionMicro:
      folds.length === 0 ? 0 : ratio(boundaryMatched, boundaryPredicted, boundaryReference === 0),
    boundaryMatched,
    boundaryReference,
    boundaryPredicted,
    missedBoundaries: [...missed]
      .map(([code, value]) => ({ code, missed: value.missed, support: value.support }))
      .sort((a, b) => b.missed - a.missed || (a.code ?? '').localeCompare(b.code ?? '')),
    macroF1Types,
    types,
    rareTypes,
    phantomTypes,
    silentHighConfidenceBoundaryErrors: folds.reduce(
      (sum, fold) => sum + fold.silentHighConfidenceBoundaryErrors,
      0,
    ),
  };
}

function f1(tp: number, fp: number, fn: number): number {
  const denominator = 2 * tp + fp + fn;
  return denominator === 0 ? 0 : (2 * tp) / denominator;
}

/**
 * Отчёт для человека — единственное место, где числа превращаются в текст.
 *
 * Формат живёт здесь, а не в тесте, ровно по той причине, по которой сюда же
 * переехал микро-recall: доклад, собираемый на месте, показывает то число,
 * которое пишущему удобнее. Отчёт обязан показывать ОБА способа усреднения с
 * явными знаменателями, разбивку пропусков по типам и вес типа в корпусе —
 * иначе «нашли 83% документов» пишется честно и означает 75%.
 */
export function formatCorpusMetrics(metrics: CorpusMetrics): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines: string[] = [
    'Замер сегментации на эталонной разметке корпуса (§16):',
    `  boundary recall, микро: ${metrics.boundaryRecallMicro.toFixed(3)} ` +
      `= ${metrics.boundaryMatched}/${metrics.boundaryReference} (доля найденных документов)`,
    `  boundary recall, макро по фолдам: ${metrics.boundaryRecallMacro.toFixed(3)} ` +
      `(комплект весит как комплект, независимо от числа страниц)`,
    `  boundary precision, микро: ${metrics.boundaryPrecisionMicro.toFixed(3)} ` +
      `= ${metrics.boundaryMatched}/${metrics.boundaryPredicted}`,
    `  macro-F1 по типам с support >= 3: ${metrics.macroF1Types.toFixed(3)} ` +
      `(типов в среднем: ${metrics.types.filter((type) => type.countedInMacroF1).length})`,
    `  тихих высокоуверенных ошибок границ: ${metrics.silentHighConfidenceBoundaryErrors}`,
  ];

  lines.push('  пропущенные границы по типам:');
  const missed = metrics.missedBoundaries.filter((item) => item.missed > 0);
  if (missed.length === 0) lines.push('    пропусков нет');
  for (const item of missed) {
    lines.push(
      `    ${item.code ?? '(тип не проставлен)'}: ${item.missed}/${item.support} ` +
        `(${pct(item.missed / Math.max(item.support, 1))} документов этого типа)`,
    );
  }

  lines.push('  типы: код — tp/fp/fn, support, доля корпуса, F1, в macro-F1');
  for (const type of metrics.types) {
    lines.push(
      `    ${type.code} — ${type.tp}/${type.fp}/${type.fn}, support ${type.support}, ` +
        `${pct(type.share)} корпуса, F1 ${type.f1.toFixed(3)}, ` +
        `${type.countedInMacroF1 ? 'да' : 'нет'}`,
    );
  }

  if (metrics.phantomTypes.length > 0) {
    lines.push('  ВЫДУМАННЫЕ типы (в эталоне их нет, сегментатор их выдаёт):');
    for (const type of metrics.phantomTypes) {
      lines.push(`    ${type.code}: ложных срабатываний ${type.fp}`);
    }
  }

  lines.push('  фолды:');
  for (const fold of metrics.folds) {
    lines.push(
      `    ${fold.heldOutPackage}: recall ${fold.boundaryRecall.toFixed(3)} ` +
        `= ${fold.boundaryMatched}/${fold.boundaryReference}, ` +
        `precision ${fold.boundaryPrecision.toFixed(3)} ` +
        `= ${fold.boundaryMatched}/${fold.boundaryPredicted}, ` +
        `тихих ошибок ${fold.silentHighConfidenceBoundaryErrors}`,
    );
  }

  return lines.join('\n');
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
