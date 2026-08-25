/**
 * Двухуровневое извлечение реквизитов (§8.4).
 *
 * ## Базовая схема применяется ВСЕГДА
 *
 * Это главное требование §8.4 и гейт S8. Корпус покрывает два раздела работ из
 * многих (§0.5), и документы незнакомых разделов — паспорт вентустановки, акт
 * гидравлического испытания, протокол измерения сопротивления изоляции — будут
 * приходить постоянно. Номер, даты, срок действия, ГОСТ и партия у них ровно
 * такие же, как у сертификата на арматуру, и именно они питают проверки сроков
 * (§9.2) и сверку с реестром (§8.3). Поэтому базовая схема применяется и к
 * резервным типам, и к `unknown_document`: система обязана давать данные о
 * документе, вида которого не знает, иначе незнакомый раздел проваливается
 * целиком, а не частично.
 *
 * Типо-специфичная схема применяется только при `typeConfident === true`.
 * Причина обратная той же природы: специфичный экстрактор написан под форму
 * конкретного вида, и на документе другого вида он не «не найдёт», а найдёт
 * НЕ ТО — и результат будет неотличим от верного.
 *
 * ## Чего детерминированное извлечение не делает
 *
 * Поля, у которых в схеме `extractor: 'llm'` (`issuer`, `applicant`,
 * `manufacturer`, `product_name`, `product_marks`, `basis_documents`), здесь
 * НЕ выдаются вовсе — ни догадкой, ни «первой строкой после слова
 * ИЗГОТОВИТЕЛЬ». Значение с `extractedBy: 'rule'` выглядит проверенным фактом:
 * оно показывается инженеру рядом с цитатой и уходит в правила §9 наравне с
 * номером и датой. Выдуманное наименование организации в этом качестве хуже
 * отсутствующего — отсутствие видно, а подделка нет. Место этих полей
 * оставляет LLM-стадия, которая помечает свои значения `extractedBy: 'llm'`
 * и не становится blocking без подтверждения человеком (§9.1).
 *
 * ## Уверенность различает сильный и слабый шаблон
 *
 * `confidence` — не украшение. Она уходит в `field_values.confidence` и дальше
 * в §9.1, где низкая уверенность обязана давать `undetermined`, а не `fail`.
 * Дата, найденная по «от 12.05.2026», и дата, найденная как просто
 * «12.05.2026» где-то в теле, — разные факты: вторая может оказаться датой
 * поверки прибора, сроком аккредитации или чем угодно ещё.
 */

import { checkInn, checkOgrn } from '@id/contracts';
import { BASE_EVIDENCE_FIELDS, DOC_TYPES, fieldsForType } from '@id/doc-types';
import type { ExtractedField, TextEvidence } from './types.js';

/** Страница на входе извлечения. */
export interface ExtractionPage {
  /** Версия текста, в которой измеряются `char_span`; `null` — доказательства не будет. */
  readonly pageTextVersionId: string | null;
  readonly text: string;
}

export interface ExtractionInput {
  readonly docTypeCode: string | null;
  /** Уверенно ли определён тип. Только при `true` работает типо-специфичная схема. */
  readonly typeConfident: boolean;
  readonly pages: readonly ExtractionPage[];
}

// =====================================================================
// Уровни уверенности
// =====================================================================

/**
 * Уровни названы, а не рассыпаны числами по коду.
 *
 * Числа обязаны быть сравнимы между полями: правило §9.1 сравнивает
 * `confidence` с порогом, не зная, каким экстрактором значение получено.
 */
const CONFIDENCE = {
  /** Явная подпись рядом со значением: «Дата изготовления: …», «№ …». */
  labelled: 0.9,
  /** Устойчивая форма без подписи: «ГОСТ 34028-2016», «RA.RU.21НВ77». */
  shaped: 0.8,
  /** Реквизит с непрошедшей контрольной суммой: значение есть, доверия нет. */
  checksumFailed: 0.45,
  /** Значение найдено по слабому признаку — «где-то в тексте есть такая форма». */
  weak: 0.35,
} as const;

// =====================================================================
// Механика поиска
// =====================================================================

interface RawHit {
  readonly value: string;
  readonly confidence: number;
  readonly start: number;
  readonly end: number;
}

/** Как сводятся находки со всех страниц в одно значение реквизита. */
type Merge = 'text' | 'date' | 'number' | 'list';

interface RuleSpec {
  readonly fieldCode: string;
  readonly merge: Merge;
  readonly find: (text: string) => readonly RawHit[];
}

/**
 * Прогон шаблона по тексту с точными границами захваченной группы.
 *
 * Границы берутся из `d`-флага, а не поиском подстроки в совпадении: значение
 * может встречаться внутри совпадения дважды, и `indexOf` указал бы на первое.
 * Доказательство с неверным span'ом хуже отсутствующего — цитата на экране не
 * совпадёт с подсвеченным местом, и инженер перестанет верить подсветке.
 */
function sweep(text: string, pattern: RegExp, confidence: number, group = 1): RawHit[] {
  const hits: RawHit[] = [];

  for (const match of text.matchAll(pattern)) {
    const value = match[group];
    const span = match.indices?.[group];
    if (value === undefined || span === undefined) continue;

    hits.push({ value: value.trim(), confidence, start: span[0], end: span[1] });
  }

  return hits;
}

/** Объединяет ступени поиска: сильный шаблон идёт первым и выигрывает. */
function firstOf(...stages: readonly RawHit[][]): RawHit[] {
  for (const stage of stages) {
    if (stage.length > 0) return stage;
  }

  return [];
}

// =====================================================================
// Даты
// =====================================================================

const DATE_NUMERIC = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;

/** Русские месяцы в родительном падеже — форма «от «09» марта 2026». */
const MONTHS: readonly string[] = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
];

const DATE_VERBAL = String.raw`[«"']?\s*\d{1,2}\s*[»"']?\s*(?:${MONTHS.join('|')})[а-я]*\s*\d{4}`;

/** Любая из двух записей даты. Используется как хвост подписанных шаблонов. */
const ANY_DATE = `(?:${DATE_NUMERIC}|${DATE_VERBAL})`;

function isoFromNumeric(value: string): string | null {
  const parts = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u.exec(value);
  if (parts === null) return null;

  return toIso(Number(parts[1]), Number(parts[2]), Number(parts[3]));
}

function isoFromVerbal(value: string): string | null {
  const parts = new RegExp(
    String.raw`(\d{1,2})\D+?(${MONTHS.join('|')})[а-я]*\D+?(\d{4})`,
    'iu',
  ).exec(value);
  if (parts === null) return null;

  const month = MONTHS.indexOf((parts[2] ?? '').toLowerCase()) + 1;

  return toIso(Number(parts[1]), month, Number(parts[3]));
}

function toIso(day: number, month: number, year: number): string | null {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO-дата из любой наблюдаемой записи; `null` — дата не существует в календаре. */
function toIsoDate(value: string): string | null {
  return isoFromNumeric(value.trim()) ?? isoFromVerbal(value);
}

/** Шаблон даты, подписанной одним из перечисленных слов. */
function labelledDate(labels: readonly string[]): RegExp {
  return new RegExp(String.raw`(?:${labels.join('|')})\s*[:;]?\s*(${ANY_DATE})`, 'gidu');
}

// =====================================================================
// Базовые экстракторы
// =====================================================================

/**
 * Номер документа.
 *
 * Сильная форма — со знаком «№». Слабая — латинская `N`: OCR печатает `N` и
 * там, где в оригинале «№», и там, где это буква из наименования продукции,
 * поэтому такая находка получает низкую уверенность, а не отбрасывается: §9.1
 * требует `undetermined` вместо `fail`, а для этого значение должно быть.
 *
 * Хвост номера прерывается на «от»/«с» с датой: иначе в номер уехала бы дата
 * выдачи, и сверка с реестром перестала бы находить документ.
 */
/**
 * Хвост номера: продолжение через пробел.
 *
 * Номер документа сплошь и рядом содержит пробелы, и обрыв по первому из них
 * — не мелочь, а отказ сверки с реестром. Проверено на корпусе: номер
 * декларации имеет вид `№ РОСС RU Д-RU.PA01.B.17254/23`, и шаблон, берущий
 * только первый токен, извлекал `РОСС` — то есть ОДНО И ТО ЖЕ значение у всех
 * деклараций комплекта. Сверка по §8.3 при этом не «ошибается», она перестаёт
 * работать вовсе, а фолдинг гомоглифов становится бессмысленным.
 *
 * Продолжением считается либо группа цифр (`№79 825` — разряды, разделённые
 * пробелом, тоже в корпусе есть), либо токен, начинающийся с ПРОПИСНОЙ буквы:
 * служебные слова, которыми номер заканчивается («от», «с», «по», «выдан»),
 * набраны строчными, и регистр отделяет их без списка исключений. Список
 * всё же нужен для организационно-правовых форм и ссылок на НД: они тоже
 * прописные и идут сразу за номером в свободном тексте.
 *
 * Число продолжений ограничено: без потолка одна строка таблицы утянула бы в
 * номер половину соседней ячейки.
 */
const NUMBER_TAIL = String.raw`(?:[^\S\n]+(?:\d+|(?!ООО|ОАО|ЗАО|ПАО|АО|ИП|ГОСТ|ТУ|СТО|СП|ОТ|ПО|ДО|ВЫДАН|С)[A-ZА-Я][0-9A-ZА-Я./\-]*)){0,4}`;

const NUMBER_STRONG = new RegExp(
  String.raw`№\s*([^\s|]+${NUMBER_TAIL})(?=\s*(?:от|с)\s+${ANY_DATE}|[\s,;.]|$)`,
  // Без флага `i`: регистр здесь НЕСЁТ смысл. Служебные слова, которыми
  // заканчивается номер («от», «с», «по»), набраны строчными, и именно это
  // отделяет их от продолжения номера — без списка исключений на все случаи
  // жизни. С флагом `i` шаблон захватывал «01-ТЕСТ от» и «ГИ-77 от 12», то
  // есть подмешивал в номер дату выдачи, после чего сверка с реестром (§8.3)
  // не находила документ ни точным сравнением, ни фолдингом.
  'gdu',
);
const NUMBER_WEAK = /(?:^|\n)\s*N\s*([^\s|]+)/dgu;

/**
 * Первые токены, которые номером НЕ являются, хотя стоят сразу за «№».
 *
 * Это подписи граф печатных форм, а не значения: «Лист | № док. | Подпись |
 * Дата» — штамп чертежа по ГОСТ Р 21.101 (описание штампа попадает в текст
 * IMAGE-блока исполнительной схемы), «№ п/п» — графа любой таблицы. «Партии»
 * и «плавки» — чужие реквизиты с собственными правилами (`batch_no`,
 * `heat_no`): их захват номером документа ломал сверку с реестром на
 * temp/MD/new («ПАСПОРТ КАЧЕСТВА» получал номер «партии: 7»).
 */
const NUMBER_STOP_TOKENS: ReadonlySet<string> = new Set(['док', 'п/п', 'пп', 'партии', 'плавки']);

/** Обрамляющие кавычки и пунктуация, прилипающие к номеру в OCR-тексте. */
function cleanNumberValue(value: string): string {
  return value
    .replace(/^[«»"'‚„]+/u, '')
    .replace(/[«»"'‚„.,;:]+$/u, '')
    .trim();
}

/** Похоже ли захваченное на номер документа, а не на подпись графы бланка. */
function plausibleNumber(hit: RawHit): boolean {
  const cleaned = cleanNumberValue(hit.value);
  if (cleaned === '') return false;
  const first = (cleaned.split(/\s+/u)[0] ?? '').replace(/[.:]+$/u, '').toLowerCase();
  return !NUMBER_STOP_TOKENS.has(first);
}

/**
 * Контекст штампа электронной подписи.
 *
 * Таблица подписантов («лист сертификатов» систем ЭДО, приклеенный к документу
 * как продолжение) несёт «Действителен с DD.MM.YYYY по DD.MM.YYYY» — срок
 * СЕРТИФИКАТА ПОДПИСИ, а не документа. На temp/MD/new он извлекался как
 * `valid_to` исполнительной схемы и давал ложное «документ истёк». Признак
 * узкий: отпечаток сертификата — 16+ шестнадцатеричных символов подряд —
 * в содержательных реквизитах ИД не встречается; вторая форма — время
 * подписания с «UTC» сразу после даты.
 */
const ESIGN_BEFORE = /[0-9A-F]{16,}|ЭЛЕКТРОННОЙ\s+ПОДПИСЬЮ|Отпечаток\s+и\s+реквизиты/iu;
const ESIGN_AFTER = /^\s*\d{1,2}:\d{2}\s*UTC|^\s*UTC/iu;

function outsideEsignStamp(text: string): (hit: RawHit) => boolean {
  return (hit) => {
    const before = text.slice(Math.max(0, hit.start - 160), hit.start);
    if (ESIGN_BEFORE.test(before)) return false;
    const after = text.slice(hit.end, hit.end + 24);
    return !ESIGN_AFTER.test(after);
  };
}

const BLANK_NUMBER = /бланк[а-я]*\s*(?:№|N)?\s*([0-9]{4,}[^\s|]*)/dgiu;

/** ГОСТ, ГОСТ Р, СТО, ТУ. Список: в одном документе их обычно несколько. */
const GOST_TU = /((?:ГОСТ(?:\s+Р)?|СТО|ТУ)\s+[0-9][0-9A-ZА-Я./-]*)/dgiu;

/** ОКПД 2 — точечный код из групп по две цифры. */
const OKPD2_LABELLED = /ОКПД\s*2?\s*[:;]?\s*(\d{2}(?:\.\d{1,3}){1,4})/dgiu;
/** Форма из корпуса: «код ОК 034-2014 (КПЕС 2008); 23.99.12.110». */
const OKPD2_OK034 = /ОК\s*;?\s*034-2014[^\d]{0,40}(\d{2}(?:\.\d{1,3}){2,4})/dgiu;

const TNVED = /ТН\s*ВЭД[^0-9]{0,30}(\d[\d\s]{3,13}\d)/dgiu;

const INN = /ИНН\s*[:;]?\s*(\d{9,12})/dgiu;

/**
 * ОГРН и ОГРНИП. Диапазон длин шире положенных 13 и 15 намеренно.
 *
 * В корпусе есть значение из 12 цифр вместо 13 — дефект оформления документа,
 * который правило §9 обязано увидеть и объявить `fail`. Шаблон, требующий
 * ровно 13 цифр, такое значение просто не нашёл бы, и дефект исчез бы вместе
 * с реквизитом (`docs/CORPUS_FINDINGS.md`).
 */
const OGRN = /ОГРН(?:ИП)?\s*[:;]?\s*(\d{11,16})/dgiu;

const BATCH = /парти[ияюе][^0-9№]{0,15}(?:№|N)?\s*([0-9][^\s|,;]*)/dgiu;
const HEAT = /плавк[аиуе][^0-9№]{0,15}(?:№|N)?\s*([0-9][^\s|,;]*)/dgiu;

/** Аттестат либо запись в реестре аккредитованных лиц: форма `RA.RU.…`. */
const ACCREDITATION = /((?:RA|РА)\.(?:RU|РУ)\.?[0-9A-ZА-Я]{2,12})/dgiu;

const BASE_RULES: readonly RuleSpec[] = [
  {
    fieldCode: 'number',
    merge: 'text',
    // Значение НЕ чистится от кавычек — иначе `evidence` перестал бы совпадать
    // со спаном текста; чистка участвует только в решении «номер ли это».
    find: (text) =>
      firstOf(
        sweep(text, NUMBER_STRONG, CONFIDENCE.labelled).filter(plausibleNumber),
        sweep(text, NUMBER_WEAK, CONFIDENCE.weak).filter(plausibleNumber),
      ),
  },
  {
    fieldCode: 'blank_number',
    merge: 'text',
    find: (text) => sweep(text, BLANK_NUMBER, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'issued_at',
    merge: 'date',
    find: (text) =>
      firstOf(
        sweep(
          text,
          labelledDate(['дата\\s+выдачи', 'дата\\s+регистрации', 'выдан[аон]?']),
          CONFIDENCE.labelled,
        ),
        sweep(
          text,
          new RegExp(String.raw`(?:^|[\s|(])от\s*[;,]?\s*(${ANY_DATE})`, 'gidu'),
          CONFIDENCE.labelled,
        ),
        // Голая дата без подписи: в документе она может быть чем угодно —
        // датой поверки, сроком аккредитации, датой протокола-основания.
        sweep(text, new RegExp(`(${DATE_NUMERIC})`, 'gdu'), CONFIDENCE.weak).filter(
          // Время подписания «22.05.2026 13:08 UTC» из штампа ЭП — не дата
          // выдачи документа.
          outsideEsignStamp(text),
        ),
      ),
  },
  {
    fieldCode: 'valid_from',
    merge: 'date',
    find: (text) =>
      sweep(
        text,
        new RegExp(String.raw`(?:^|[\s|(])[сc]\s*[;,]?\s*(${ANY_DATE})\s*[;,]?\s*по\s`, 'gidu'),
        CONFIDENCE.labelled,
      ).filter(outsideEsignStamp(text)),
  },
  {
    fieldCode: 'valid_to',
    merge: 'date',
    find: (text) =>
      firstOf(
        sweep(
          text,
          new RegExp(String.raw`\sпо\s*[;,]?\s*(${ANY_DATE})`, 'gidu'),
          CONFIDENCE.labelled,
        ).filter(outsideEsignStamp(text)),
        sweep(
          text,
          new RegExp(String.raw`действ[а-я]*\s+до\s*[;,]?\s*(${ANY_DATE})`, 'gidu'),
          CONFIDENCE.labelled,
        ).filter(outsideEsignStamp(text)),
      ),
  },
  {
    fieldCode: 'issuer_accreditation',
    merge: 'text',
    find: (text) => sweep(text, ACCREDITATION, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'issuer_accreditation_valid_to',
    merge: 'date',
    find: (text) =>
      sweep(
        text,
        new RegExp(String.raw`аккредитаци[а-я]*[^.\n]{0,40}?до\s*[;,]?\s*(${ANY_DATE})`, 'gidu'),
        CONFIDENCE.labelled,
      ),
  },
  {
    fieldCode: 'manufacturer_inn',
    merge: 'text',
    find: (text) => sweep(text, INN, CONFIDENCE.labelled),
  },
  {
    fieldCode: 'gost_tu',
    merge: 'list',
    find: (text) => sweep(text, GOST_TU, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'okpd2',
    merge: 'text',
    find: (text) =>
      firstOf(
        sweep(text, OKPD2_LABELLED, CONFIDENCE.labelled),
        sweep(text, OKPD2_OK034, CONFIDENCE.shaped),
      ),
  },
  {
    fieldCode: 'tnved',
    merge: 'text',
    find: (text) => sweep(text, TNVED, CONFIDENCE.labelled),
  },
  { fieldCode: 'batch_no', merge: 'text', find: (text) => sweep(text, BATCH, CONFIDENCE.labelled) },
  { fieldCode: 'heat_no', merge: 'text', find: (text) => sweep(text, HEAT, CONFIDENCE.labelled) },
  {
    fieldCode: 'manufactured_at',
    merge: 'date',
    find: (text) =>
      sweep(
        text,
        labelledDate(['дата\\s+изготовлени[яе]', 'изготовлен[аоы]?']),
        CONFIDENCE.labelled,
      ),
  },
];

// =====================================================================
// Типо-специфичные экстракторы
// =====================================================================

/**
 * Правила для реквизитов, специфичных для типа.
 *
 * Покрыты не все 213 кодов каталога, и это осознанно: код без правила просто
 * не даёт значения. Догадка по имени поля («поле называется `tested_at` —
 * возьму любую дату») выдала бы значение с `extractedBy: 'rule'`, то есть
 * подала бы совпадение по названию за извлечённый из документа факт.
 */
const TYPE_RULES: readonly RuleSpec[] = [
  {
    fieldCode: 'batch_number',
    merge: 'text',
    find: (text) => sweep(text, BATCH, CONFIDENCE.labelled),
  },
  {
    fieldCode: 'order_number',
    merge: 'text',
    find: (text) => sweep(text, /приказ[а-я]*\s*(?:№|N)\s*([^\s|,;]+)/dgiu, CONFIDENCE.labelled),
  },
  {
    fieldCode: 'order_date',
    merge: 'date',
    find: (text) =>
      sweep(
        text,
        new RegExp(String.raw`приказ[а-я]*[^\n]{0,40}?от\s*(${ANY_DATE})`, 'gidu'),
        CONFIDENCE.labelled,
      ),
  },
  {
    fieldCode: 'act_date',
    merge: 'date',
    find: (text) =>
      firstOf(
        // Бланк РД-11-02 подписывает дату СНИЗУ, а не вводит предлогом:
        //     " 21 ноября 2024 г.
        //     (дата составления акта)
        // Шаблон с «от» такую дату не находил ни на одном акте корпуса, и
        // AOSR.ACT.031 — блокирующая проверка порядка дат — отвечал
        // «не распознаны даты» на каждом комплекте.
        sweep(
          text,
          new RegExp(
            String.raw`(${ANY_DATE})\s*(?:г\.?)?\s*\(\s*дата\s+составлени[яе]\s+акта`,
            'gidu',
          ),
          CONFIDENCE.labelled,
        ),
        sweep(
          text,
          new RegExp(String.raw`акт[а-я]*[^\n]{0,40}?от\s*(${ANY_DATE})`, 'gidu'),
          CONFIDENCE.labelled,
        ),
      ),
  },
  {
    fieldCode: 'tested_at',
    merge: 'date',
    find: (text) =>
      sweep(text, labelledDate(['дата\\s+испытани[йяе]', 'испытан[аоы]']), CONFIDENCE.labelled),
  },
  {
    fieldCode: 'sampled_at',
    merge: 'date',
    find: (text) =>
      sweep(text, labelledDate(['дата\\s+(?:и\\s+время\\s+)?отбора']), CONFIDENCE.labelled),
  },
  {
    fieldCode: 'made_at',
    merge: 'date',
    find: (text) =>
      sweep(text, labelledDate(['дата\\s+изготовления\\s+образцов']), CONFIDENCE.labelled),
  },
  {
    fieldCode: 'measured_at',
    merge: 'date',
    find: (text) => sweep(text, labelledDate(['дата\\s+измерени[йяе]']), CONFIDENCE.labelled),
  },
  {
    fieldCode: 'shipped_at',
    merge: 'date',
    find: (text) =>
      sweep(text, labelledDate(['дата\\s+отгрузки', 'отгружен[аоы]?']), CONFIDENCE.labelled),
  },
  {
    fieldCode: 'valid_until',
    merge: 'date',
    find: (text) =>
      sweep(
        text,
        new RegExp(String.raw`срок\s+действи[яю][^\n]{0,20}?до\s*(${ANY_DATE})`, 'gidu'),
        CONFIDENCE.labelled,
      ),
  },
  {
    fieldCode: 'nd_reference',
    merge: 'list',
    find: (text) => sweep(text, GOST_TU, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'nd_requirements',
    merge: 'list',
    find: (text) => sweep(text, GOST_TU, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'concrete_class',
    merge: 'text',
    find: (text) =>
      sweep(text, /(?:^|[\s|(])((?:В|B)\s?\d{1,3}(?:[,.]\d)?)(?=[\s|,;)]|$)/dgu, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'frost_resistance',
    merge: 'text',
    find: (text) => sweep(text, /(?:^|[\s|(])(F\s?\d{2,3})(?=[\s|,;)]|$)/dgiu, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'water_resistance',
    merge: 'text',
    find: (text) => sweep(text, /(?:^|[\s|(])(W\s?\d{1,2})(?=[\s|,;)]|$)/dgiu, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'steel_class',
    merge: 'text',
    find: (text) =>
      sweep(text, /(?:^|[\s|(])([АA]\s?\d{3}[СCНH]?)(?=[\s|,;)]|$)/dgu, CONFIDENCE.shaped),
  },
  {
    fieldCode: 'age_days',
    merge: 'number',
    find: (text) => sweep(text, /возраст[^\d\n]{0,40}(\d{1,3})\s*сут/dgiu, CONFIDENCE.labelled),
  },
  {
    fieldCode: 'test_pressure',
    merge: 'text',
    find: (text) =>
      sweep(
        text,
        /(?:испытательн[а-я]*\s+)?давлени[ея][^\d\n]{0,20}(\d+(?:[.,]\d+)?\s*(?:МПа|кПа|бар))/dgiu,
        CONFIDENCE.labelled,
      ),
  },
  {
    fieldCode: 'registry_number',
    merge: 'text',
    find: (text) => sweep(text, OGRN, CONFIDENCE.labelled),
  },
  // ── Реквизиты бланка АОСР ────────────────────────────────────────────────
  //
  // Период работ п. 5 берётся ТОЛЬКО в контексте пункта, а не как первая пара
  // дат «с … по …». Голая пара уже разбирается базовыми `valid_from`/
  // `valid_to`, и второй код без контекста означал бы то же значение под другим
  // именем — а на бланке акта «с … по …» встречается и в реквизитах
  // сертификата, названного в п. 3.
  {
    fieldCode: 'p5_date_start',
    merge: 'date',
    find: (text) => sweep(text, WORK_PERIOD_START, CONFIDENCE.labelled),
  },
  {
    fieldCode: 'p5_date_end',
    merge: 'date',
    find: (text) => sweep(text, WORK_PERIOD_END, CONFIDENCE.labelled),
  },
  {
    fieldCode: 'p3_registry_ref',
    merge: 'text',
    find: (text) => sweep(text, REGISTRY_REF, CONFIDENCE.labelled),
  },
];

/**
 * Пункт 5 бланка: «Даты: начала работ … окончания работ …».
 *
 * Формулировка взята с шести реальных актов корпуса, а не из общих
 * соображений. Первая попытка искала «работы выполнены в период с … по …» —
 * такой строки в бланке по приказу №344/пр нет вовсе, и экстрактор не находил
 * ничего ни на одном пакете. Настоящая раскладка — подпись графы перед датой,
 * причём вторая дата уезжает на следующую строку:
 *
 *     5. Даты: начала работ "27" сентября 2024 г.
 *     окончания работ "04" октября 2024 г.
 *
 * Отсюда два независимых шаблона вместо одного с двумя группами: между
 * подписями стоит перенос, а иногда и пустая строка, и связывать их порядком
 * значило бы терять обе, когда OCR переставит строки местами.
 *
 * Дата допускается в обеих записях, включая форму с кавычками и пробелами
 * внутри них («« 01 » мая 2026г.») — её уже покрывает `ANY_DATE`.
 */
const WORK_PERIOD_START = new RegExp(String.raw`начала\s+работ\s*:?\s*(${ANY_DATE})`, 'gidu');

const WORK_PERIOD_END = new RegExp(String.raw`окончани[яе]\s+работ\s*:?\s*(${ANY_DATE})`, 'gidu');

/**
 * Ссылка на реестр приложений в п. 3.
 *
 * Захватывается вся ссылка целиком («реестр приложений № 1»), а не только
 * номер: правило `AOSR.P3.071` проверяет само НАЛИЧИЕ ссылки, а номер реестра
 * в акте и номер, напечатанный на листе реестра, совпадают не всегда — и
 * сравнивать их правило не берётся.
 */
const REGISTRY_REF = /((?:реестр|перечень)[а-я]*\s+приложени[а-я]+(?:\s*(?:№|N)\s*[\w./-]+)?)/dgiu;

/**
 * ОГРН проверяется той же единственной реализацией, что и ИНН.
 *
 * Отдельной ступенью, а не внутри `TYPE_RULES`: `registry_number` — код
 * каталога, а проверка контрольной суммы к нему привязана здесь, чтобы её
 * нельзя было забыть при добавлении соседнего правила.
 */
const CHECKSUMMED_FIELDS: ReadonlyMap<string, (value: string) => { readonly ok: boolean }> =
  new Map([
    ['manufacturer_inn', checkInn],
    ['registry_number', checkOgrn],
  ]);

// =====================================================================
// Сборка значений
// =====================================================================

const RULES_BY_CODE: ReadonlyMap<string, RuleSpec> = new Map(
  [...BASE_RULES, ...TYPE_RULES].map((rule) => [rule.fieldCode, rule]),
);

/** Коды базовой схемы: они извлекаются всегда и типом не переопределяются. */
const BASE_CODES: ReadonlySet<string> = new Set(BASE_EVIDENCE_FIELDS.map((field) => field.code));

/** Коды, за которые отвечает LLM: детерминированно они не выдаются никогда. */
const LLM_CODES: ReadonlySet<string> = new Set(
  BASE_EVIDENCE_FIELDS.filter((field) => field.extractor === 'llm').map((field) => field.code),
);

interface PageHit extends RawHit {
  readonly page: ExtractionPage;
}

function evidenceOf(hit: PageHit): TextEvidence | null {
  if (hit.page.pageTextVersionId === null) return null;

  return {
    pageTextVersionId: hit.page.pageTextVersionId,
    charStart: hit.start,
    charEnd: hit.end,
    // Цитата берётся срезом текста, а не значением находки: §3.5 требует,
    // чтобы `quote` был ровно `text.slice(charStart, charEnd)`.
    quote: hit.page.text.slice(hit.start, hit.end),
  };
}

function runRule(rule: RuleSpec, pages: readonly ExtractionPage[]): ExtractedField | null {
  const hits: PageHit[] = [];
  for (const page of pages) {
    for (const hit of rule.find(page.text)) hits.push({ ...hit, page });
  }
  if (hits.length === 0) return null;

  const check = CHECKSUMMED_FIELDS.get(rule.fieldCode);
  const verified =
    check === undefined
      ? hits
      : hits.map((hit) =>
          check(hit.value).ok ? hit : { ...hit, confidence: CONFIDENCE.checksumFailed },
        );

  if (rule.merge === 'list') return listField(rule.fieldCode, verified);

  // Из нескольких находок берётся самая уверенная, при равенстве — первая по
  // порядку страниц: реквизит документа печатается в заголовке, а повторы в
  // теле — это ссылки на него же либо на чужие документы.
  const best = verified.reduce((left, right) =>
    right.confidence > left.confidence ? right : left,
  );

  if (rule.merge === 'date') {
    const iso = toIsoDate(best.value);
    if (iso === null) return null;

    return {
      fieldCode: rule.fieldCode,
      valueText: null,
      valueDate: iso,
      valueNum: null,
      valueJson: null,
      confidence: best.confidence,
      extractedBy: 'rule',
      evidence: evidenceOf(best),
    };
  }

  if (rule.merge === 'number') {
    return {
      fieldCode: rule.fieldCode,
      valueText: null,
      valueDate: null,
      valueNum: best.value,
      valueJson: null,
      confidence: best.confidence,
      extractedBy: 'rule',
      evidence: evidenceOf(best),
    };
  }

  return {
    fieldCode: rule.fieldCode,
    valueText: best.value,
    valueDate: null,
    valueNum: null,
    valueJson: null,
    confidence: best.confidence,
    extractedBy: 'rule',
    evidence: evidenceOf(best),
  };
}

function listField(fieldCode: string, hits: readonly PageHit[]): ExtractedField {
  const seen = new Map<string, PageHit>();
  for (const hit of hits) {
    const key = hit.value.replace(/\s+/gu, ' ').toUpperCase();
    if (!seen.has(key)) seen.set(key, hit);
  }

  const items = [...seen.values()];
  const first = items[0] as PageHit;

  return {
    fieldCode,
    valueText: items.map((hit) => hit.value).join('; '),
    valueDate: null,
    valueNum: null,
    valueJson: items.map((hit) => hit.value),
    // Уверенность списка — минимальная среди элементов: список ровно настолько
    // надёжен, насколько надёжен худший его элемент.
    confidence: Math.min(...items.map((hit) => hit.confidence)),
    extractedBy: 'rule',
    evidence: evidenceOf(first),
  };
}

// =====================================================================
// Публичный интерфейс
// =====================================================================

/**
 * Базовые реквизиты. Применяются ко ВСЕМ документам без исключения.
 *
 * `docTypeCode` и `typeConfident` здесь не читаются намеренно: любое условие
 * на тип означало бы, что документ незнакомого вида остаётся без номера и дат,
 * то есть выпадает и из сверки с реестром, и из проверок сроков.
 */
export function extractBaseFields(input: ExtractionInput): readonly ExtractedField[] {
  const fields: ExtractedField[] = [];

  for (const definition of BASE_EVIDENCE_FIELDS) {
    if (definition.extractor !== 'rule') continue;
    const rule = RULES_BY_CODE.get(definition.code);
    if (rule === undefined) continue;

    const field = runRule(rule, input.pages);
    if (field !== null) fields.push(field);
  }

  return fields;
}

/**
 * Типо-специфичные реквизиты. Только при уверенно определённом типе.
 *
 * При `typeConfident === false` возвращается пустой список, и это не потеря:
 * базовые реквизиты уже извлечены, а специфичный экстрактор на документе
 * чужого вида нашёл бы не «ничего», а НЕ ТО — например, взял бы за класс
 * бетона обозначение с чертежа.
 */
export function extractTypeFields(input: ExtractionInput): readonly ExtractedField[] {
  if (!input.typeConfident || input.docTypeCode === null) return [];

  const definition = DOC_TYPES.find((type) => type.code === input.docTypeCode);
  if (definition === undefined) return [];

  const fields: ExtractedField[] = [];

  for (const field of fieldsForType(definition.fieldSchema, definition.kind)) {
    if (field.extractor !== 'rule') continue;
    // Базовые коды уже извлечены `extractBaseFields`; `fieldsForType` их
    // подмешивает, и без этого фильтра значения удвоились бы.
    if (BASE_CODES.has(field.code)) continue;

    const rule = RULES_BY_CODE.get(field.code);
    if (rule === undefined) continue;

    const extracted = runRule(rule, input.pages);
    if (extracted !== null) fields.push(extracted);
  }

  return fields;
}

/**
 * Оба уровня вместе — то, что вызывает job извлечения.
 *
 * Порядок: сначала базовые, затем специфичные. Поля с `extractor: 'llm'` в
 * результате отсутствуют по построению — их место занимает LLM-стадия.
 */
export function extractFields(input: ExtractionInput): readonly ExtractedField[] {
  const base = extractBaseFields(input);
  const seen = new Set(base.map((field) => field.fieldCode));

  return [...base, ...extractTypeFields(input).filter((field) => !seen.has(field.fieldCode))];
}

/** Коды, которые детерминированное извлечение не выдаёт никогда. См. шапку файла. */
export const LLM_ONLY_BASE_FIELDS: readonly string[] = [...LLM_CODES];

/**
 * Коды, для которых детерминированный экстрактор существует.
 *
 * Экспорт нужен предохранителю `field-codes.test.ts`: реквизит, объявленный в
 * каталоге как `extractor: 'rule'`, но не имеющий здесь реализации, не выдаётся
 * никем — и правило, которое его читает, молча не работает. Именно так семь
 * реквизитов бланка АОСР прожили до S27.
 *
 * Список НЕ покрывает все 125 таких кодов каталога, и это осознанно (см. шапку
 * `TYPE_RULES`): большинство относится к видам документов, которых портал ещё
 * не видел. Тест проверяет полноту только там, где от неё зависит работающее
 * правило.
 */
export const RULE_EXTRACTED_FIELDS: readonly string[] = [...RULES_BY_CODE.keys()];
