/**
 * Разбор загруженной таблицы в строки предпросмотра (§3.2, миграция 0027).
 *
 * ## Функция чистая: ни БД, ни хранилища
 *
 * Всё, что разбор знает о состоянии портала, приходит одним объектом
 * `CatalogSnapshot`: виды контрагентов, уже заведённые ИНН, наименования и коды
 * объектов. Так сделано ради того же, ради чего чистой сделана сверка реестра
 * приложений (`segmentation/match.ts`): здесь нет ни ревизии, ни области
 * видимости, а значит нет и способа ошибиться ими. Побочная польза — разбор
 * проверяется таблицей случаев, а не поднятым воркером.
 *
 * ## Отказ файла и отказ строки — разные вещи
 *
 * Неизвестный заголовок и пропущенная обязательная колонка отвергают файл
 * ЦЕЛИКОМ. Это не строгость ради строгости: колонка, которую портал не понял,
 * почти наверняка и есть та, ради которой файл собирали, а импорт, тихо
 * пропустивший её, заведёт полсотни карточек без ИНН — и обнаружится это на
 * первом же реестре, где эти карточки не сойдутся с документами.
 *
 * Дефект отдельной строки файл не отвергает: полсотни правильных строк не
 * должны ждать, пока человек починит одну. Строка получает `error` и перечень
 * замечаний, остальные — `create`.
 *
 * ## Почему дубликат — не ошибка
 *
 * Повторная загрузка того же списка после дописывания пяти строк — штатный
 * способ работы, а не оплошность. Требовать вычищать уже заведённое значило бы
 * заставлять человека сверять два списка руками, то есть делать ровно ту работу,
 * ради которой импорт и заводился.
 */

import {
  CATALOG_IMPORT_COLUMNS,
  checkInn,
  checkKpp,
  checkOgrn,
  normalizeHeader,
  type CatalogImportColumn,
  type CatalogImportProblem,
  type CatalogImportTarget,
  type CatalogImportVerdict,
  type IdentifierCheck,
  type IdentifierRejected,
} from '@id/contracts';

// =====================================================================
// Вход и выход
// =====================================================================

/** Ячейка в том виде, в котором её отдаёт читатель книги. */
export interface ImportCell {
  readonly text: string;
  readonly kind: 'text' | 'integer' | 'fractional' | 'boolean' | 'error';
}

export interface ImportSheetRow {
  readonly rowNo: number;
  readonly cells: ReadonlyMap<string, ImportCell>;
}

export interface ImportSheet {
  readonly rows: readonly ImportSheetRow[];
}

/**
 * Состояние справочника на момент разбора.
 *
 * Снимок, а не запросы по ходу: разбор идёт над файлом целиком, и полтысячи
 * точечных запросов «есть ли такой ИНН» стоили бы полтысячи round-trip'ов.
 * Снимок при этом устаревает — поэтому применение перепроверяет дубликаты
 * заново, уже в своей транзакции (см. `applyCatalogImport`).
 */
export interface CatalogSnapshot {
  /** Код вида контрагента → активен ли он. */
  readonly kinds: ReadonlyMap<string, boolean>;
  /** ИНН → идентификатор контрагента. */
  readonly counterpartyByInn: ReadonlyMap<string, string>;
  /** Нормализованное наименование → идентификаторы (их может быть несколько). */
  readonly counterpartyByName: ReadonlyMap<string, readonly string[]>;
  /** Коды заведённых объектов в верхнем регистре. */
  readonly objectCodes: ReadonlySet<string>;
}

export interface ParsedImportRow {
  readonly rowNo: number;
  /** Прочитанные ячейки по ключам колонок — как есть, до приведения. */
  readonly raw: Record<string, string>;
  /** Тело создания. `null` у строки, до приведения не дошедшей. */
  readonly normalized: Record<string, string | null> | null;
  readonly verdict: CatalogImportVerdict;
  readonly problems: readonly CatalogImportProblem[];
}

export type CatalogImportParseResult =
  | { readonly ok: true; readonly rows: readonly ParsedImportRow[] }
  | { readonly ok: false; readonly reason: string };

// =====================================================================
// Нормализация значений
// =====================================================================

/**
 * Наименование для сравнения с уже заведёнными.
 *
 * Регистр, кавычки любых видов, лишние пробелы и `ё` — различия, которых человек
 * не делает, а строковое равенство делает. Форма собственности НЕ отбрасывается:
 * ООО «Ромашка» и АО «Ромашка» — разные организации, и склеить их значило бы
 * потерять одну из них молча.
 */
export function normalizeOrgName(value: string): string {
  return value
    .toUpperCase()
    .replaceAll('Ё', 'Е')
    .replace(/[«»"'`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

const DIGITS_ONLY = /^[0-9]+$/u;

function problem(
  column: string | null,
  code: CatalogImportProblem['code'],
  message: string,
): CatalogImportProblem {
  return { column, code, message };
}

/**
 * Замечание по реквизиту с контрольной суммой.
 *
 * Потеря ведущего нуля выделена отдельным кодом, и это главное, ради чего вид
 * ячейки доезжает сюда из читателя. «КПП — 9 цифр» над значением из восьми,
 * набранным в числовой ячейке, отправляет человека пересчитывать цифры; «Excel
 * отбросил ведущий ноль» отправляет его поменять формат колонки — то есть
 * чинить причину.
 */
function identifierProblem(
  column: string,
  label: string,
  lengths: readonly number[],
  cell: ImportCell,
  result: IdentifierRejected,
): CatalogImportProblem {
  const expected = lengths.map((n) => String(n)).join(' или ');

  if (cell.kind === 'fractional') {
    return problem(
      column,
      'fractional_value',
      `${label} прочитан как дробное число «${cell.text}». Задайте колонке текстовый формат.`,
    );
  }
  if (
    cell.kind === 'integer' &&
    DIGITS_ONLY.test(cell.text) &&
    lengths.some((n) => cell.text.length < n)
  ) {
    return problem(
      column,
      'leading_zero_lost',
      `${label} прочитан как число из ${String(cell.text.length)} цифр вместо ${expected}: ` +
        'Excel отбросил ведущий ноль. Задайте колонке текстовый формат и повторите загрузку.',
    );
  }
  if (result.defect === 'checksum') {
    return problem(
      column,
      'checksum_failed',
      `Контрольная сумма ${label} не сходится: ожидалась цифра ${
        result.checksum?.expected ?? '?'
      }, указана ${result.checksum?.actual ?? '?'}.`,
    );
  }
  return problem(column, 'invalid_format', `${label} — ${expected} цифр без пробелов и знаков.`);
}

// =====================================================================
// Раскладка колонок
// =====================================================================

interface ColumnLayout {
  /** Буква колонки → ключ поля. */
  readonly byLetter: ReadonlyMap<string, string>;
}

function layoutOf(
  columns: readonly CatalogImportColumn[],
  header: ImportSheetRow,
):
  | { readonly ok: true; readonly layout: ColumnLayout }
  | { readonly ok: false; readonly reason: string } {
  const byAlias = new Map<string, CatalogImportColumn>();
  for (const column of columns) {
    for (const alias of column.aliases) byAlias.set(alias, column);
  }

  const byLetter = new Map<string, string>();
  const seen = new Set<string>();
  const unknown: string[] = [];

  for (const [letter, cell] of header.cells) {
    const normalized = normalizeHeader(cell.text);
    const column = byAlias.get(normalized);
    if (column === undefined) {
      unknown.push(cell.text);
      continue;
    }
    // Дважды названная колонка — не мелочь: вторая молча перекрыла бы первую, и
    // половина файла уехала бы не в ту графу.
    if (seen.has(column.key)) {
      return {
        ok: false,
        reason: `Колонка «${column.title}» встречается в файле дважды. Оставьте одну.`,
      };
    }
    seen.add(column.key);
    byLetter.set(letter, column.key);
  }

  if (unknown.length > 0) {
    const expected = columns.map((c) => c.title).join(', ');
    return {
      ok: false,
      reason:
        `Колонки не опознаны: ${unknown.map((t) => `«${t}»`).join(', ')}. ` +
        `Ожидаются: ${expected}. Скачайте шаблон, чтобы заголовки совпали.`,
    };
  }

  const missing = columns.filter((c) => c.required && !seen.has(c.key));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `В файле нет обязательных колонок: ${missing.map((c) => `«${c.title}»`).join(', ')}.`,
    };
  }

  return { ok: true, layout: { byLetter } };
}

// =====================================================================
// Разбор строки
// =====================================================================

interface RowValues {
  readonly raw: Record<string, string>;
  readonly cells: ReadonlyMap<string, ImportCell>;
}

function valuesOf(layout: ColumnLayout, row: ImportSheetRow): RowValues {
  const raw: Record<string, string> = {};
  const cells = new Map<string, ImportCell>();
  for (const [letter, key] of layout.byLetter) {
    const cell = row.cells.get(letter);
    if (cell === undefined || cell.text === '') continue;
    raw[key] = cell.text;
    cells.set(key, cell);
  }
  return { raw, cells };
}

interface IdentifierSpec {
  readonly key: string;
  readonly label: string;
  readonly lengths: readonly number[];
  readonly check: (value: string) => IdentifierCheck;
}

const IDENTIFIERS: readonly IdentifierSpec[] = [
  { key: 'inn', label: 'ИНН', lengths: [10, 12], check: checkInn },
  { key: 'kpp', label: 'КПП', lengths: [9], check: checkKpp },
  { key: 'ogrn', label: 'ОГРН', lengths: [13, 15], check: checkOgrn },
];

function requireFields(
  columns: readonly CatalogImportColumn[],
  values: RowValues,
  problems: CatalogImportProblem[],
): void {
  for (const column of columns) {
    if (!column.required) continue;
    if ((values.raw[column.key] ?? '') === '') {
      problems.push(
        problem(column.key, 'required_missing', `Колонка «${column.title}» обязательна.`),
      );
    }
  }
}

function limitLength(
  key: string,
  title: string,
  limit: number,
  values: RowValues,
  problems: CatalogImportProblem[],
): void {
  const value = values.raw[key];
  if (value !== undefined && value.length > limit) {
    problems.push(problem(key, 'too_long', `«${title}»: не длиннее ${String(limit)} символов.`));
  }
}

function checkIdentifiers(values: RowValues, problems: CatalogImportProblem[]): void {
  for (const spec of IDENTIFIERS) {
    const cell = values.cells.get(spec.key);
    if (cell === undefined) continue;
    const result = spec.check(cell.text);
    if (!result.ok) {
      problems.push(identifierProblem(spec.key, spec.label, spec.lengths, cell, result));
    }
  }
}

/** Ссылка на контрагента: сначала по ИНН, затем по наименованию. */
function resolveCounterparty(
  key: string,
  title: string,
  values: RowValues,
  snapshot: CatalogSnapshot,
  problems: CatalogImportProblem[],
): string | null {
  const value = values.raw[key];
  if (value === undefined || value === '') return null;

  if (DIGITS_ONLY.test(value)) {
    const byInn = snapshot.counterpartyByInn.get(value);
    if (byInn !== undefined) return byInn;
    problems.push(
      problem(
        key,
        'counterparty_not_found',
        `«${title}»: контрагента с ИНН ${value} нет в справочнике.`,
      ),
    );
    return null;
  }

  const candidates = snapshot.counterpartyByName.get(normalizeOrgName(value)) ?? [];
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length === 0) {
    problems.push(
      problem(
        key,
        'counterparty_not_found',
        `«${title}»: контрагент «${value}» не найден. Заведите его или укажите ИНН.`,
      ),
    );
    return null;
  }
  // Одинаковые наименования у разных организаций — обычное дело; выбрать за
  // человека нельзя, это была бы выдумка, поданная как факт.
  problems.push(
    problem(
      key,
      'counterparty_ambiguous',
      `«${title}»: под наименованием «${value}» заведено ${String(candidates.length)} организаций. Укажите ИНН.`,
    ),
  );
  return null;
}

// =====================================================================
// Разбор файла
// =====================================================================

/** Та же форма, что `objectCodeSchema` в контрактах: 1–5 букв или цифр. */
const OBJECT_CODE = /^[\p{L}\p{N}]{1,5}$/u;

export function parseCatalogImport(
  target: CatalogImportTarget,
  sheet: ImportSheet,
  snapshot: CatalogSnapshot,
): CatalogImportParseResult {
  const columns = CATALOG_IMPORT_COLUMNS[target];
  const [header, ...body] = sheet.rows;

  if (header === undefined) {
    return { ok: false, reason: 'Файл пуст: в нём нет ни заголовка, ни строк.' };
  }

  const resolved = layoutOf(columns, header);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (body.length === 0) {
    return { ok: false, reason: 'В файле только заголовок: заводить нечего.' };
  }

  const rows: ParsedImportRow[] = [];
  // Ключи, уже встреченные В ЭТОМ ФАЙЛЕ: вторая строка с тем же ИНН — не
  // дубликат справочника, а опечатка в самом файле, и назвать её нужно иначе.
  const seenInFile = new Set<string>();

  for (const row of body) {
    const values = valuesOf(resolved.layout, row);
    if (Object.keys(values.raw).length === 0) continue;

    const problems: CatalogImportProblem[] = [];
    requireFields(columns, values, problems);
    checkIdentifiers(values, problems);

    const judged =
      target === 'counterparties'
        ? judgeCounterparty(values, snapshot, seenInFile, problems)
        : judgeObject(values, snapshot, seenInFile, problems);

    rows.push({
      rowNo: row.rowNo,
      raw: values.raw,
      normalized: judged.normalized,
      verdict: judged.verdict,
      problems,
    });
  }

  if (rows.length === 0) {
    return { ok: false, reason: 'В файле нет ни одной заполненной строки под заголовком.' };
  }
  return { ok: true, rows };
}

interface Judged {
  readonly verdict: CatalogImportVerdict;
  readonly normalized: Record<string, string | null> | null;
}

function text(values: RowValues, key: string): string | null {
  const value = values.raw[key];
  return value === undefined || value === '' ? null : value;
}

function judgeCounterparty(
  values: RowValues,
  snapshot: CatalogSnapshot,
  seenInFile: Set<string>,
  problems: CatalogImportProblem[],
): Judged {
  const kind = values.raw['kind'];
  if (kind !== undefined) {
    const active = snapshot.kinds.get(kind);
    if (active === undefined) {
      problems.push(
        problem(
          'kind',
          'unknown_kind',
          `Вид «${kind}» не найден в справочнике видов контрагентов. ` +
            `Допустимые коды: ${[...snapshot.kinds.keys()].join(', ')}.`,
        ),
      );
    } else if (!active) {
      problems.push(problem('kind', 'inactive_kind', `Вид «${kind}» отключён.`));
    }
  }

  limitLength('name', 'Наименование', 500, values, problems);
  limitLength('legalAddress', 'Юридический адрес', 1000, values, problems);

  if (problems.length > 0) return { verdict: 'error', normalized: null };

  const name = values.raw['name'] ?? '';
  const inn = text(values, 'inn');
  // Ключ сравнения: ИНН, если он есть, иначе нормализованное наименование.
  // ИНН надёжнее — две организации с одинаковым названием встречаются, с
  // одинаковым ИНН не бывает.
  const key = inn === null ? `name:${normalizeOrgName(name)}` : `inn:${inn}`;

  if (seenInFile.has(key)) {
    problems.push(
      problem(null, 'duplicate_in_file', 'Такая же строка уже есть в этом файле выше.'),
    );
    return { verdict: 'duplicate', normalized: null };
  }
  seenInFile.add(key);

  const existing =
    inn === null
      ? (snapshot.counterpartyByName.get(normalizeOrgName(name)) ?? []).length > 0
      : snapshot.counterpartyByInn.has(inn);
  if (existing) {
    problems.push(
      problem(null, 'duplicate_in_catalog', 'Контрагент с такими реквизитами уже заведён.'),
    );
    return { verdict: 'duplicate', normalized: null };
  }

  return {
    verdict: 'create',
    normalized: {
      name,
      kind: values.raw['kind'] ?? '',
      inn,
      kpp: text(values, 'kpp'),
      ogrn: text(values, 'ogrn'),
      legalAddress: text(values, 'legalAddress'),
    },
  };
}

function judgeObject(
  values: RowValues,
  snapshot: CatalogSnapshot,
  seenInFile: Set<string>,
  problems: CatalogImportProblem[],
): Judged {
  const code = values.raw['code'];

  // Эвристики «потерянного ведущего нуля» здесь больше нет, и это следствие
  // расширения правила, а не забывчивость: код короче пяти символов стал
  // ЗАКОННЫМ (0033), и `1234` теперь неотличим от намеренно короткого кода.
  // Отличить их можно было бы только предупреждением, а замечание разбора
  // импорта строку отвергает — то есть предупреждение отвергало бы законные
  // коды. У КПП и ИНН, где длина фиксирована, эвристика осталась.
  if (code !== undefined && !OBJECT_CODE.test(code)) {
    problems.push(
      problem(
        'code',
        'invalid_format',
        'Код объекта — от 1 до 5 букв или цифр без пробелов и разделителей.',
      ),
    );
  }

  limitLength('name', 'Наименование', 255, values, problems);
  limitLength('fullName', 'Полное наименование', 1000, values, problems);
  limitLength('address', 'Адрес', 1000, values, problems);
  limitLength('cadastralNumber', 'Кадастровый номер', 255, values, problems);
  limitLength('permitIdentifier', 'Идентификатор', 255, values, problems);
  limitLength('actNumberPattern', 'Шаблон номера акта', 255, values, problems);

  const developerId = resolveCounterparty('developer', 'Застройщик', values, snapshot, problems);
  const techCustomerId = resolveCounterparty(
    'techCustomer',
    'Технический заказчик',
    values,
    snapshot,
    problems,
  );
  const generalContractorId = resolveCounterparty(
    'generalContractor',
    'Генеральный подрядчик',
    values,
    snapshot,
    problems,
  );

  if (problems.length > 0) return { verdict: 'error', normalized: null };

  const key = `code:${(code ?? '').toUpperCase()}`;
  if (seenInFile.has(key)) {
    problems.push(problem('code', 'duplicate_in_file', 'Такой код уже встречался в этом файле.'));
    return { verdict: 'duplicate', normalized: null };
  }
  seenInFile.add(key);

  if (snapshot.objectCodes.has((code ?? '').toUpperCase())) {
    problems.push(problem('code', 'duplicate_in_catalog', 'Объект с таким кодом уже заведён.'));
    return { verdict: 'duplicate', normalized: null };
  }

  return {
    verdict: 'create',
    normalized: {
      code: code ?? '',
      name: values.raw['name'] ?? '',
      fullName: values.raw['fullName'] ?? '',
      address: text(values, 'address'),
      cadastralNumber: text(values, 'cadastralNumber'),
      permitIdentifier: text(values, 'permitIdentifier'),
      actNumberPattern: text(values, 'actNumberPattern'),
      developerId,
      techCustomerId,
      generalContractorId,
    },
  };
}
