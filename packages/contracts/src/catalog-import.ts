/**
 * Описание колонок массового ввода справочников (§3.2, миграция 0027).
 *
 * ## Почему описание живёт в контрактах, а не рядом с разборщиком
 *
 * Колонки нужны трём местам сразу: воркер по ним раскладывает ячейки файла, API
 * по ним собирает пустой шаблон для скачивания, а экран предпросмотра по ним
 * подписывает столбцы таблицы. Три копии разошлись бы на одной букве заголовка,
 * и расхождение проявилось бы как «портал не видит колонку, которая в файле
 * есть» — то есть как отказ разбора, причину которого нужно искать в чужом коде.
 *
 * ## Колонки сопоставляются по ЗАГОЛОВКУ, а не по позиции
 *
 * Файл собирает человек: он добавит свой столбец с комментарием, поменяет
 * порядок, вставит пустую колонку между. Разбор по позиции в такой файл упрётся
 * молча — прочитает не то и заведёт контрагентов с ИНН в графе наименования.
 * Поэтому у каждой колонки есть набор принимаемых заголовков, а неизвестный
 * заголовок — это отказ всего импорта с перечислением ожидаемых, а не тихий
 * пропуск: столбец, который портал не понял, почти наверняка и есть тот, ради
 * которого файл собирали.
 *
 * ## Все значения — текст
 *
 * Ни у контрагента, ни у объекта нет ни одного поля-даты и ни одного числового.
 * Это не совпадение, а следствие: ИНН, КПП, ОГРН и код объекта — идентификаторы,
 * а не числа, и ведущий ноль в них значим. Excel об этом не знает и хранит их
 * числовыми ячейками, теряя ноль; разборщик обязан это заметить и сказать вслух
 * (см. `apps/worker/src/xlsx`).
 */

import { z } from 'zod';

/** Какой справочник наполняет импорт. */
export const catalogImportTargetSchema = z.enum(['counterparties', 'construction_objects']);
export type CatalogImportTarget = z.infer<typeof catalogImportTargetSchema>;

export const catalogImportStatusSchema = z.enum([
  'uploading',
  'parsing',
  'ready',
  'applied',
  'failed',
  'expired',
]);
export type CatalogImportStatus = z.infer<typeof catalogImportStatusSchema>;

/**
 * Вердикт строки предпросмотра.
 *
 * `duplicate` — не ошибка: повторная загрузка того же списка после добавления
 * пяти строк это штатный сценарий, и требовать от человека вычищать уже
 * заведённое значило бы заставлять его сверять два списка руками.
 */
export const catalogImportVerdictSchema = z.enum(['create', 'duplicate', 'error']);
export type CatalogImportVerdict = z.infer<typeof catalogImportVerdictSchema>;

export interface CatalogImportColumn {
  /** Ключ в `raw` и в теле создания. */
  readonly key: string;
  /** Заголовок, который портал печатает в шаблоне. */
  readonly title: string;
  readonly required: boolean;
  /**
   * Принимаемые заголовки в нормализованном виде: нижний регистр, без пробелов,
   * точек и дефисов (`normalizeHeader`). Первый — то, что печатает шаблон.
   */
  readonly aliases: readonly string[];
  /** Подсказка под заголовком шаблона; она же — текст в предпросмотре. */
  readonly hint: string;
}

/**
 * Приводит заголовок из файла к виду, в котором он сравнивается с `aliases`.
 *
 * Вычёркиваются пробелы (включая неразрывный — он приезжает из Word), точки,
 * дефисы, кавычки и скобки; регистр приводится к нижнему, `ё` к `е`. Всё это —
 * различия, которые человек не считает различиями, а сравнение строк считает.
 */
export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[\s.\-–—_"'«»()]/gu, '');
}

const COUNTERPARTY_COLUMNS: readonly CatalogImportColumn[] = [
  {
    key: 'name',
    title: 'Наименование',
    required: true,
    aliases: ['наименование', 'название', 'организация', 'контрагент', 'наименованиеорганизации'],
    hint: 'Полное наименование организации',
  },
  {
    key: 'kind',
    title: 'Вид',
    required: true,
    aliases: ['вид', 'виддеятельности', 'тип', 'категория', 'роль'],
    hint: 'Код или название вида из справочника: подрядчик, лаборатория, …',
  },
  {
    key: 'inn',
    title: 'ИНН',
    required: false,
    aliases: ['инн'],
    hint: '10 цифр у организации или 12 у ИП; формат ячейки — текстовый',
  },
  {
    key: 'kpp',
    title: 'КПП',
    required: false,
    aliases: ['кпп'],
    hint: '9 цифр; формат ячейки — текстовый',
  },
  {
    key: 'ogrn',
    title: 'ОГРН',
    required: false,
    aliases: ['огрн', 'огрнип'],
    hint: '13 цифр у организации или 15 (ОГРНИП); формат ячейки — текстовый',
  },
  {
    key: 'legalAddress',
    title: 'Юридический адрес',
    required: false,
    aliases: ['юридическийадрес', 'адрес', 'юрадрес'],
    hint: 'Необязательно',
  },
];

const CONSTRUCTION_OBJECT_COLUMNS: readonly CatalogImportColumn[] = [
  {
    key: 'code',
    title: 'Код',
    required: true,
    aliases: ['код', 'кодобъекта', 'шифр', 'шифробъекта'],
    hint: 'От 1 до 5 букв или цифр любого алфавита; печатается в номерах актов',
  },
  {
    key: 'name',
    title: 'Наименование',
    required: true,
    aliases: ['наименование', 'название', 'краткоенаименование'],
    hint: 'Короткое имя объекта для списков',
  },
  {
    key: 'fullName',
    title: 'Полное наименование',
    required: true,
    aliases: ['полноенаименование', 'полноеназвание', 'объекткапитальногостроительства'],
    hint: 'Как в разрешении на строительство',
  },
  {
    key: 'address',
    title: 'Адрес',
    required: false,
    aliases: ['адрес', 'почтовыйадрес', 'адресобъекта'],
    hint: 'Необязательно',
  },
  {
    key: 'cadastralNumber',
    title: 'Кадастровый номер',
    required: false,
    aliases: ['кадастровыйномер', 'кадастровыйномеручастка', 'кадастр'],
    hint: 'Необязательно; печатается в шапке реестра',
  },
  {
    key: 'permitIdentifier',
    title: 'Идентификатор',
    required: false,
    aliases: ['идентификатор', 'идентификаторокс', 'идентификаторобъекта'],
    hint: 'Идентификатор ОКС из разрешения на строительство',
  },
  {
    key: 'actNumberPattern',
    title: 'Шаблон номера акта',
    required: false,
    aliases: ['шаблонномераакта', 'шаблонакта', 'формануомераакта'],
    hint: 'Необязательно; сверяется правилом AOSR.ACT',
  },
  {
    key: 'developer',
    title: 'Застройщик',
    required: false,
    aliases: ['застройщик', 'девелопер'],
    hint: 'ИНН или наименование контрагента; ИНН надёжнее',
  },
  {
    key: 'techCustomer',
    title: 'Технический заказчик',
    required: false,
    aliases: ['техническийзаказчик', 'техзаказчик'],
    hint: 'ИНН или наименование контрагента',
  },
  {
    key: 'generalContractor',
    title: 'Генеральный подрядчик',
    required: false,
    aliases: ['генеральныйподрядчик', 'генподрядчик'],
    hint: 'ИНН или наименование контрагента',
  },
];

export const CATALOG_IMPORT_COLUMNS: Readonly<
  Record<CatalogImportTarget, readonly CatalogImportColumn[]>
> = {
  counterparties: COUNTERPARTY_COLUMNS,
  construction_objects: CONSTRUCTION_OBJECT_COLUMNS,
};

/** Человеческое имя справочника: заголовок листа шаблона и текст отказов. */
export const CATALOG_IMPORT_TARGET_LABELS: Readonly<Record<CatalogImportTarget, string>> = {
  counterparties: 'Контрагенты',
  construction_objects: 'Объекты строительства',
};

/**
 * Коды проблем строки. Закрытый перечень, потому что по ним экран решает, что
 * подсказать: «поправьте формат ячейки» и «сверьте с выпиской» — разные советы.
 */
export const CATALOG_IMPORT_PROBLEM_CODES = [
  'required_missing',
  'unknown_kind',
  'inactive_kind',
  'invalid_format',
  'checksum_failed',
  'leading_zero_lost',
  'fractional_value',
  'too_long',
  'counterparty_not_found',
  'counterparty_ambiguous',
  'duplicate_in_file',
  'duplicate_in_catalog',
  'created_meanwhile',
] as const;

export const catalogImportProblemCodeSchema = z.enum(CATALOG_IMPORT_PROBLEM_CODES);
export type CatalogImportProblemCode = z.infer<typeof catalogImportProblemCodeSchema>;

/** Замечание к строке: поле, код и текст, который читает человек. */
export const catalogImportProblemSchema = z.object({
  /** Ключ колонки; `null` — замечание относится ко всей строке. */
  column: z.string().max(64).nullable(),
  code: catalogImportProblemCodeSchema,
  message: z.string().min(1).max(1000),
});
export type CatalogImportProblem = z.infer<typeof catalogImportProblemSchema>;
