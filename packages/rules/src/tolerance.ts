/**
 * Разбор колонок «Норма по НД» и «Фактически» (§9.4, `PASS`).
 *
 * Паспорт качества — это таблица, в которой рядом стоят требование и
 * измерение. Автосравнение возможно ровно тогда, когда требование разобрано
 * однозначно; во всех остальных случаях ответ — «разобрать не удалось», и
 * правило обязано выдать `undetermined`, а не `fail`.
 *
 * ## Чего здесь НЕТ и почему
 *
 * Здесь нет ни одной нормативной таблицы ГОСТ или СП. §8.1 прямо запрещает
 * вводить их без ручной верификации источника и его редакции: выдуманное
 * значение предела текучести — это ложное обвинение подрядчику, подписанное
 * порталом. Модуль сравнивает ФАКТ с НОРМОЙ, НАПЕЧАТАННОЙ В ТОМ ЖЕ ДОКУМЕНТЕ,
 * и только с ней.
 *
 * ## Десятичная запятая
 *
 * В документах она запятая, а не точка. Замена делается на входе разбора, а не
 * при нормализации текста страницы: `4,2` — число, а `РОСС RU Д-RU.PA01,B` —
 * номер, и глобальная замена испортила бы второе.
 */

/** Разобранное требование. */
export type Requirement =
  /** `не менее 5`, `≥ 5`. */
  | { readonly kind: 'min'; readonly value: number; readonly unit: string | null }
  /** `не более 5`, `не выше 5`, `≤ 5`. */
  | { readonly kind: 'max'; readonly value: number; readonly unit: string | null }
  /** `4 ± 0,2`, `800 +200/-200`, `от 3 до 5`. */
  | {
      readonly kind: 'range';
      readonly low: number;
      readonly high: number;
      readonly unit: string | null;
    }
  /** Точное значение без допуска. */
  | { readonly kind: 'exact'; readonly value: number; readonly unit: string | null };

export type ParsedRequirement =
  | { readonly status: 'parsed'; readonly requirement: Requirement }
  /**
   * Требование есть, но формы, которую мы умеем сравнивать, в нём нет.
   *
   * `empty` различает два разных случая, и различие не косметическое: пустая
   * графа нормы — это НЕЗАПОЛНЕННЫЙ бланк, о котором правило обязано сказать,
   * а качественная норма («белый», «соответствует вееру») — показатель,
   * который числами не проверяют вовсе.
   */
  | { readonly status: 'unparsed'; readonly reason: string; readonly empty: boolean };

const NUM = String.raw`[-+]?\d+(?:[.,]\d+)?`;

function num(raw: string): number {
  return Number.parseFloat(raw.replace(',', '.'));
}

/** Единица измерения — хвост после числа; служит только для текста замечания. */
function unitOf(rest: string): string | null {
  const trimmed = rest.replace(/^[\s)]+/u, '').trim();
  if (trimmed === '') return null;
  const match = /^([^\s,;]{1,16})/u.exec(trimmed);
  return match?.[1] ?? null;
}

/**
 * Разбор требования из ячейки «Норма по НД».
 *
 * Порядок проверок значим: `4 ± 0,2` обязан распознаться диапазоном раньше,
 * чем точным значением `4`, а `не менее 3, не более 5` — двусторонним
 * диапазоном, а не первым же односторонним ограничением.
 */
export function parseRequirement(raw: string): ParsedRequirement {
  const text = raw.replace(/[\u00A0\u202F]/gu, ' ').trim();
  if (text === '') return { status: 'unparsed', reason: 'ячейка нормы пуста', empty: true };

  // «4 ± 0,2» и «4 +/- 0,2»
  const symmetric = new RegExp(`(${NUM})\\s*(?:±|\\+/-|\\+-)\\s*(${NUM})(.*)$`, 'u').exec(text);
  if (symmetric !== null) {
    const centre = num(symmetric[1] as string);
    const delta = Math.abs(num(symmetric[2] as string));
    return {
      status: 'parsed',
      requirement: {
        kind: 'range',
        low: centre - delta,
        high: centre + delta,
        unit: unitOf(symmetric[3] ?? ''),
      },
    };
  }

  // «800 +200/-200», «800 +200 / -100»
  const asymmetric = new RegExp(
    `(${NUM})\\s*\\+\\s*(\\d+(?:[.,]\\d+)?)\\s*/\\s*-\\s*(\\d+(?:[.,]\\d+)?)(.*)$`,
    'u',
  ).exec(text);
  if (asymmetric !== null) {
    const centre = num(asymmetric[1] as string);
    return {
      status: 'parsed',
      requirement: {
        kind: 'range',
        low: centre - num(asymmetric[3] as string),
        high: centre + num(asymmetric[2] as string),
        unit: unitOf(asymmetric[4] ?? ''),
      },
    };
  }

  // «от 3 до 5», «3…5», «3-5» — последнее только при явном разделителе с
  // пробелами, иначе «М-150» и «А240-С» разбирались бы как диапазоны.
  const between = new RegExp(`от\\s*(${NUM})\\s*до\\s*(${NUM})(.*)$`, 'iu').exec(text);
  if (between !== null) {
    return {
      status: 'parsed',
      requirement: {
        kind: 'range',
        low: num(between[1] as string),
        high: num(between[2] as string),
        unit: unitOf(between[3] ?? ''),
      },
    };
  }
  /**
   * Пара чисел через дефис — диапазон, но только когда ЯЧЕЙКА состоит из неё.
   *
   * Паспорта печатают допуск так: «1400 -1700», «70000-100000». Разбирать
   * такую запись первым числом нельзя: норма «1400» становилась точным
   * требованием, и факт 1464 объявлялся нарушением — три ложные ошибки на
   * каждый паспорт «Сен-Гобен» папки «ИД Мастер апрель 2026».
   *
   * Условие «вся ячейка» и запрет буквы перед дефисом отделяют диапазон от
   * марки («М-150», «А240-С») и от номера: там дефис соединяет не два числа.
   */
  const dashRange = new RegExp(`^\\s*(${NUM})\\s*[-]\\s*(${NUM})\\s*(.*)$`, 'u').exec(text);
  if (dashRange !== null && !/\p{L}\s*[-]/u.test(text)) {
    const low = num(dashRange[1] as string);
    const high = num(dashRange[2] as string);
    if (low <= high) {
      return {
        status: 'parsed',
        requirement: { kind: 'range', low, high, unit: unitOf(dashRange[3] ?? '') },
      };
    }
  }

  const ellipsis = new RegExp(`(${NUM})\\s*(?:\\.\\.\\.|…|―|—)\\s*(${NUM})(.*)$`, 'u').exec(text);
  if (ellipsis !== null) {
    return {
      status: 'parsed',
      requirement: {
        kind: 'range',
        low: num(ellipsis[1] as string),
        high: num(ellipsis[2] as string),
        unit: unitOf(ellipsis[3] ?? ''),
      },
    };
  }

  // Двустороннее словесное: «не менее 3, не более 5».
  // «не ранее 90» — та же нижняя граница, только о времени: так паспорт КНАУФ
  // печатает начало схватывания смеси.
  const lower = new RegExp(
    `(?:не\\s+менее|не\\s+ниже|не\\s+меньше|не\\s+ранее|≥|>=)\\s*(${NUM})`,
    'iu',
  ).exec(text);
  const upper = new RegExp(
    `(?:не\\s+более|не\\s+выше|не\\s+больше|не\\s+превыша\\p{L}*|≤|<=)\\s*(${NUM})`,
    'iu',
  ).exec(text);

  if (lower !== null && upper !== null) {
    return {
      status: 'parsed',
      requirement: {
        kind: 'range',
        low: num(lower[1] as string),
        high: num(upper[1] as string),
        unit: unitOf(text.slice((upper.index ?? 0) + (upper[0] as string).length)),
      },
    };
  }
  if (lower !== null) {
    return {
      status: 'parsed',
      requirement: {
        kind: 'min',
        value: num(lower[1] as string),
        unit: unitOf(text.slice(lower.index + (lower[0] as string).length)),
      },
    };
  }
  if (upper !== null) {
    return {
      status: 'parsed',
      requirement: {
        kind: 'max',
        value: num(upper[1] as string),
        unit: unitOf(text.slice(upper.index + (upper[0] as string).length)),
      },
    };
  }

  // Одиночное число: точное требование.
  const single = new RegExp(`^\\s*(${NUM})\\s*(.*)$`, 'u').exec(text);
  if (single !== null) {
    return {
      status: 'parsed',
      requirement: {
        kind: 'exact',
        value: num(single[1] as string),
        unit: unitOf(single[2] ?? ''),
      },
    };
  }

  return {
    status: 'unparsed',
    reason: `норма «${text}» не приведена к числовому требованию`,
    empty: false,
  };
}

/** Разбор измеренного значения. `null` — числа в ячейке нет. */
export function parseMeasured(raw: string): number | null {
  const text = raw.replace(/[\u00A0\u202F]/gu, ' ').trim();
  // «соответствует», «отсутствует», «н/д» — не числа, и притворяться, что это
  // ноль, значило бы порождать ложные `fail`.
  const match = new RegExp(`(?:^|[\\s(])(${NUM})`, 'u').exec(text);
  if (match === null) return null;
  const value = num(match[1] as string);
  return Number.isFinite(value) ? value : null;
}

export type Comparison =
  | { readonly status: 'ok' }
  | { readonly status: 'violated'; readonly explanation: string }
  | { readonly status: 'undecidable'; readonly reason: string };

/**
 * Сравнение факта с требованием.
 *
 * Точное требование сравнивается с допуском в одну единицу последнего
 * разряда напечатанного значения: у «толщина 4» и измерения «4.0» расхождения
 * нет, а требовать буквального равенства чисел с плавающей точкой значило бы
 * порождать замечания на округлении.
 */
export function compare(requirement: Requirement, measured: number): Comparison {
  const fmt = (value: number): string => String(Number(value.toFixed(6)));
  const unit = 'unit' in requirement && requirement.unit !== null ? ` ${requirement.unit}` : '';

  switch (requirement.kind) {
    case 'min':
      return measured >= requirement.value
        ? { status: 'ok' }
        : {
            status: 'violated',
            explanation: `фактически ${fmt(measured)}${unit} при норме не менее ${fmt(requirement.value)}${unit}`,
          };
    case 'max':
      return measured <= requirement.value
        ? { status: 'ok' }
        : {
            status: 'violated',
            explanation: `фактически ${fmt(measured)}${unit} при норме не более ${fmt(requirement.value)}${unit}`,
          };
    case 'range':
      return measured >= requirement.low && measured <= requirement.high
        ? { status: 'ok' }
        : {
            status: 'violated',
            explanation: `фактически ${fmt(measured)}${unit} вне допуска ${fmt(requirement.low)}…${fmt(requirement.high)}${unit}`,
          };
    case 'exact': {
      const tolerance = Math.max(
        Math.abs(requirement.value) * 1e-9,
        0.5 * lastDigitStep(requirement.value),
      );
      return Math.abs(measured - requirement.value) <= tolerance
        ? { status: 'ok' }
        : {
            status: 'violated',
            explanation: `фактически ${fmt(measured)}${unit} при норме ${fmt(requirement.value)}${unit}`,
          };
    }
  }
}

/** Шаг последнего значащего разряда: у `4` это 1, у `4,25` — 0,01. */
function lastDigitStep(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 1 : 10 ** -(text.length - dot - 1);
}

/** Строка таблицы «показатель / норма / факт». */
export interface NormFactRow {
  readonly indicator: string;
  readonly norm: string;
  readonly fact: string;
}

/**
 * Строки таблицы «Норма по НД / Фактически» из `value_json` реквизита
 * `nd_requirements`.
 *
 * Форма разбирается терпимо: экстрактор мог положить массив объектов с
 * разными именами ключей, и отказ разбора здесь означал бы потерю всей
 * проверки из-за имени поля.
 */
export function normFactRows(json: unknown): NormFactRow[] {
  if (!Array.isArray(json)) return [];
  const rows: NormFactRow[] = [];
  for (const item of json) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const pick = (...keys: readonly string[]): string => {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
        if (typeof value === 'number') return String(value);
      }
      return '';
    };
    const indicator = pick('indicator', 'name', 'показатель', 'parameter');
    const norm = pick('norm', 'requirement', 'норма', 'nd');
    const fact = pick('fact', 'actual', 'measured', 'фактически', 'значение');
    if (indicator === '' && norm === '' && fact === '') continue;
    rows.push({ indicator, norm, fact });
  }
  return rows;
}
