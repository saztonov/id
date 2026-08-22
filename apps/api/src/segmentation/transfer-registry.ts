/**
 * Разбор ОПИСИ ПЕРЕДАЧИ папки и сопоставление её групп с комплектами (S20).
 *
 * ## Это не тот реестр, который уже умеет портал
 *
 * В коде уже есть «сверка реестра» — разбор реестра ПРИЛОЖЕНИЙ внутри одного
 * АОСР (`registry.ts`, `match.ts`, таблица `registry_rows`). Здесь другой
 * документ: сопроводительная опись всей папки, где строки сгруппированы по
 * работам, у каждой работы свой исполнитель, а внутри группы перечислены акт и
 * его приложения. Совпадает у них только разметка, и ровно она вынесена в
 * `md-table.ts` и `registry-cells.ts`.
 *
 * ## Опись — эталон, и сверять её надо по НОМЕРУ
 *
 * `docs/CORPUS_FINDINGS.md`: «Сверять комплект с реестром по виду документа
 * нельзя — только по номеру… эталонен он по составу и номерам». Поэтому первая
 * ступень сопоставления группы с комплектом — номер АОСР, а не наименование
 * работы: наименование подрядчик пишет от руки и обобщает, а номер акта
 * печатается и в описи, и на самом акте.
 *
 * ## Две формы описи, и разница между ними не косметическая
 *
 * **Форма А** (пять граф): группа — строка с непустым «№ п/п», её же графа
 * «№ документа» несёт номер АОСР, исполнитель один на всю папку и назван в
 * шапке прозой.
 *
 * **Форма Б** (восемь граф): группа — слитый на всю ширину баннер
 * «Работа (ООО „Исполнитель“)», а номер АОСР в баннере ОТСУТСТВУЕТ — он стоит
 * в первой строке группы, чьё наименование начинается с «АОСР». Не учесть это
 * значит получить `actNoNorm = null` у всей формы Б и остаться без первой
 * ступени лестницы, то есть сверять опись по прозе — ровно то, что запрещено
 * находкой корпуса выше.
 *
 * ## Чего разбор намеренно не делает
 *
 * Не додумывает пропущенное. Строка без сравнимого номера, дата без дня,
 * невозможная дата, строка вне группы, нераспознанная шапка — всё это уходит в
 * `warnings` и остаётся видимым, а не заглаживается: сверка описи существует
 * ради того, чтобы показывать расхождения, и разбор, который «чинит» вход,
 * уничтожает её предмет.
 */

import { normalizeDocNo } from '@id/contracts';
import { scanBlocks, type MdTable } from './md-table.js';
import {
  DATE_PART,
  HAS_DATE,
  normalizeRegistryName,
  parseDateCell,
  parseNumberCell,
  toIsoDate,
  VALIDITY_RANGE,
  type CellDates,
} from './registry-cells.js';

export const TRANSFER_PARSER_VERSION = 'registry.transfer.v1';
export const TRANSFER_MATCHER_VERSION = 'registry.reconcile.v1';

/**
 * Потолки разбора.
 *
 * Опись на 174 строки — уже наблюдённый корпусом размер, поэтому потолок
 * заведомо выше рабочего. Он защищает не от нормальной папки, а от разметки, в
 * которой разбор принял за опись что-то другое: без потолка такой случай
 * кончился бы не ошибкой, а десятками тысяч строк в БД.
 */
const MAX_ROWS = 2000;
const MAX_GROUPS = 200;

/** Страница описи на входе. Форма повторяет `RegistryPageInput` намеренно. */
export interface TransferPageInput {
  readonly sourcePageId: string;
  /** Версия текста; `null` — текста нет, доказательство построить не на чем. */
  readonly pageTextVersionId: string | null;
  readonly text: string;
}

export interface ParsedTransferHeader {
  readonly registryNo: string | null;
  readonly folderNo: string | null;
  readonly objectRaw: string | null;
  /** Форма А: исполнитель работ один на всю папку и назван в шапке. */
  readonly contractorRaw: string | null;
}

export interface ParsedTransferGroup {
  /** Сквозной порядок группы в описи, от нуля. Единственный её ключ. */
  readonly ordinal: number;
  /** Напечатанный номер группы: «1», «6». Уникальным быть не обязан. */
  readonly groupNo: string | null;
  readonly titleRaw: string;
  readonly actNoRaw: string | null;
  readonly actNoNorm: string | null;
  readonly actNoFolded: string | null;
  readonly contractorRaw: string | null;
  /** Порядок строки-АОСР внутри описи (форма Б); `null` — форма А. */
  readonly actRowOrdinal: number | null;
}

export interface ParsedTransferRow {
  readonly ordinal: number;
  readonly groupOrdinal: number;
  /** Напечатанный номер позиции: «6.23». Текст, а не число (урок миграции 0015). */
  readonly rowNo: string | null;
  readonly docNameRaw: string;
  readonly docNoRaw: string | null;
  readonly docNoNorm: string | null;
  readonly docNoFolded: string | null;
  readonly orgRaw: string | null;
  readonly issuedAt: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly sheets: number | null;
  readonly copies: number | null;
  /** «Страница по списку» дословно: бывает диапазоном «46-47». */
  readonly pagesRaw: string | null;
}

export interface TransferParseResult {
  /** `null` — форму определить не удалось; строк при этом может не быть вовсе. */
  readonly form: TransferForm | null;
  readonly header: ParsedTransferHeader;
  readonly groups: readonly ParsedTransferGroup[];
  readonly rows: readonly ParsedTransferRow[];
  readonly warnings: readonly string[];
}

export type TransferForm = 'a' | 'b';

// =====================================================================
// Раскладка граф
// =====================================================================

interface TransferColumns {
  readonly pos: number | null;
  readonly name: number;
  readonly number: number;
  readonly org: number | null;
  readonly date: number | null;
  readonly sheets: number | null;
  readonly copies: number | null;
  readonly pages: number | null;
  readonly count: number;
  readonly form: TransferForm;
}

/**
 * Раскладка граф описи ПО ЗАГОЛОВКУ и без позиционного фолбэка.
 *
 * Фолбэка нет намеренно, в отличие от `mapColumns` реестра приложений: там он
 * достался от исторической формы корпуса, здесь формы две и они несовместимы —
 * подставить «обычные» индексы значило бы прочитать наименование как номер и
 * записать это в БД как факт описи.
 *
 * Форма различается по графам, которых у второй формы нет вовсе: «кол-во
 * листов» и «страница по списку» есть только в форме Б, «кол-во экз.» — только
 * в форме А. Различать по числу граф нельзя: OCR теряет и добавляет пустые.
 */
function mapTransferColumns(header: readonly string[]): TransferColumns | null {
  const lower = header.map((cell) => cell.toLowerCase());

  const has = (needle: string): number => lower.findIndex((cell) => cell.includes(needle));

  const sheets = has('лист');
  const pages = has('страниц');
  const copies = has('экз');

  const form: TransferForm | null = sheets >= 0 || pages >= 0 ? 'b' : copies >= 0 ? 'a' : null;
  if (form === null) return null;

  const pos = lower.findIndex((cell) => /п\s*\/\s*п/u.test(cell));
  const nameDoc = lower.findIndex(
    (cell, index) => index !== pos && cell.includes('наименован') && cell.includes('документ'),
  );
  const name =
    nameDoc >= 0
      ? nameDoc
      : lower.findIndex((cell, index) => index !== pos && cell.includes('наименован'));
  if (name < 0) return null;

  // Графа номера ДОКУМЕНТА, а не порядковый «№» бланка: голая решётка в первой
  // графе формы Б — это счётчик групп, и принять её за номер документа значило
  // бы читать «1», «2», «3» как номера актов.
  const number = lower.findIndex(
    (cell, index) =>
      index !== pos &&
      index !== name &&
      (cell.includes('номер') ||
        (cell.includes('№') && (cell.includes('документ') || cell.includes('шифр')))),
  );
  if (number < 0) return null;

  const org = lower.findIndex((cell) => cell.includes('организац') || cell.includes('составивш'));
  const date = lower.findIndex(
    (cell, index) =>
      index !== number && index !== name && (cell.includes('дата') || cell.includes('срок')),
  );

  return {
    pos: pos >= 0 ? pos : null,
    name,
    number,
    org: org >= 0 ? org : null,
    date: date >= 0 ? date : null,
    sheets: sheets >= 0 ? sheets : null,
    copies: copies >= 0 ? copies : null,
    pages: pages >= 0 ? pages : null,
    count: header.length,
    form,
  };
}

// =====================================================================
// Признаки посторонних блоков
// =====================================================================

/** Таблица объёмов, идущая сразу за описью: «Вид работ, переданных данным реестром». */
const VOLUMES_HEADER = /вид\s+работ|п\.\s*дгп|объ[ёе]м/iu;

/** Подвал описи. С него опись кончается, и продолжения у неё уже не бывает. */
const FOOTER_LINE = /^\s*(сдал|принял|передал|получил)\s*:?\s*$/iu;

/** Строки, которые не бывают баннером группы, как бы OCR их ни свернул. */
const NOT_A_BANNER = /^\s*(сдал|принял|передал|получил|итого|всего)(?![а-яё])/iu;

/** Наименование строки-АОСР формы Б: с неё начинается группа и в ней её номер. */
const ACT_ROW = /^\s*(аоср|акт\s+освидетельствован)/iu;

/** Номер позиции описи: «6», «6.23», «6.23.1». Точка — разделитель, а не конец. */
const POSITION_NO = /^\d{1,4}(?:\.\d{1,4}){0,3}\.?$/u;

// =====================================================================
// Даты описи
// =====================================================================

/**
 * «до DD.MM.YYYY» и «действителен до DD.MM.YYYY» — это СРОК, а не дата выдачи.
 *
 * Общий `parseDateCell` одиночную дату кладёт в `issuedAt`, потому что в реестре
 * приложений графа называется «Дата». В описи графа называется «Дата составления
 * ИЛИ СРОК ДЕЙСТВИЯ», и обе формы в ней встречаются вперемешку: положить срок
 * действия сертификата в дату составления значило бы сверять его с датой
 * документа и поднимать расхождение там, где его нет.
 */
const VALID_TO_ONLY = new RegExp(
  String.raw`(?:^|[\s;,(])(?:действ[а-яё]*\s+)?до\s*[;,]?\s*${DATE_PART}`,
  'iu',
);

/** Дата без дня: «до 10.2024г». */
const NUMERIC_MONTH_ONLY = /(?:^|[^\d.])(\d{1,2})\.(\d{4})(?!\s*\d)/u;

/** Дата без дня, месяц словом: «.апрель.2026» — наблюдено в форме А. */
const NAMED_MONTH_ONLY =
  /(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-яё]*\.?\s*\.?\s*(\d{4})/iu;

interface TransferDates extends CellDates {
  /** В ячейке есть дата, но без дня: разобрать нельзя, промолчать тоже. */
  readonly monthOnly: boolean;
}

function parseTransferDateCell(cell: string): TransferDates {
  if (VALIDITY_RANGE.test(cell)) return { ...parseDateCell(cell), monthOnly: false };

  const validTo = VALID_TO_ONLY.exec(cell);
  if (validTo !== null) {
    return {
      validFrom: null,
      validTo: toIsoDate(validTo[1], validTo[2], validTo[3]),
      issuedAt: null,
      monthOnly: false,
    };
  }

  if (HAS_DATE.test(cell)) return { ...parseDateCell(cell), monthOnly: false };

  const monthOnly = NUMERIC_MONTH_ONLY.test(cell) || NAMED_MONTH_ONLY.test(cell);
  return { validFrom: null, validTo: null, issuedAt: null, monthOnly };
}

// =====================================================================
// Шапка описи
// =====================================================================

const REGISTRY_NO = /реестр[^\n]{0,80}?№\s*([^\s,;|]+)/iu;
const FOLDER_NO_PROSE = /папк[аи][^\n]{0,20}?№\s*([^\s,;|]+)/iu;
const FOLDER_NO_CELL = /номер\s+папки/iu;
/**
 * Границы слова здесь заданы явным просмотром, а не `\b`.
 *
 * `\b` в JavaScript определена через ASCII-класс `[A-Za-z0-9_]`, поэтому между
 * кириллической буквой и пробелом границы НЕТ, и `объект\b` не совпадал ни с
 * одной настоящей шапкой. Ошибка тихая: разбор возвращал `objectRaw: null` и
 * выглядел работающим.
 */
const OBJECT_LINE = /^\s*объект(?![а-яё])[^\n]*/imu;
const CONTRACTOR_LINE = /^\s*исполнител[ья]\s+работ\s*[:\s]([^\n]+)/imu;

function parseTransferHeader(pages: readonly TransferPageInput[]): ParsedTransferHeader {
  const first = pages[0];
  if (first === undefined) {
    return { registryNo: null, folderNo: null, objectRaw: null, contractorRaw: null };
  }
  const text = first.text;

  const registryNo = REGISTRY_NO.exec(text)?.[1] ?? null;

  let folderNo = FOLDER_NO_PROSE.exec(text)?.[1] ?? null;
  if (folderNo === null) {
    // Форма Б держит номер папки в таблице-шапке: `| Номер папки | №4 |`.
    for (const block of scanBlocks(text)) {
      if (block.kind !== 'table') continue;
      for (const row of [block.table.header ?? [], ...block.table.rows]) {
        const at = row.findIndex((cell) => FOLDER_NO_CELL.test(cell));
        if (at < 0) continue;
        const value = row.slice(at + 1).find((cell) => cell !== '');
        if (value !== undefined) folderNo = value.replace(/^№\s*/u, '');
        break;
      }
      if (folderNo !== null) break;
    }
  }

  const objectRaw = OBJECT_LINE.exec(text)?.[0]?.trim() ?? null;
  const contractorRaw = CONTRACTOR_LINE.exec(text)?.[1]?.trim() ?? null;

  return { registryNo, folderNo, objectRaw, contractorRaw };
}

// =====================================================================
// Разбор описи
// =====================================================================

/** Исполнитель из баннера формы Б: «Работа (ООО „БАУТРАНС“)». */
function splitBanner(text: string): { title: string; contractor: string | null } {
  const match = /^(.*)\(([^()]{2,120})\)\s*$/u.exec(text.trim());
  if (match === null) return { title: normalizeRegistryName(text), contractor: null };
  return {
    title: normalizeRegistryName(match[1] ?? ''),
    contractor: normalizeRegistryName(match[2] ?? ''),
  };
}

interface ParseState {
  readonly groups: ParsedTransferGroup[];
  readonly rows: ParsedTransferRow[];
  readonly warnings: string[];
  layout: TransferColumns | null;
  closed: boolean;
  truncated: boolean;
}

/**
 * Похожа ли строка таблицы на баннер группы формы Б.
 *
 * Признак — ровно одна непустая ячейка: слитая на всю ширину ячейка приходит от
 * OCR либо первой графой, либо той, в которую он её положил, но соседние при
 * этом пусты. Строка данных описи так не выглядит никогда: у неё заполнены и
 * наименование, и хотя бы одна из граф номера, даты и листов.
 */
function bannerText(cells: readonly string[]): string | null {
  const filled = cells.filter((cell) => cell !== '');
  if (filled.length !== 1) return null;
  const text = filled[0] ?? '';
  if (text === '' || POSITION_NO.test(text) || NOT_A_BANNER.test(text)) return null;
  return text;
}

function isVolumesTable(table: MdTable): boolean {
  const header = table.header;
  if (header === null) return false;
  return header.some((cell) => VOLUMES_HEADER.test(cell));
}

function cellAt(cells: readonly string[], index: number | null): string {
  return index === null ? '' : (cells[index] ?? '');
}

function toCount(value: string): number | null {
  const digits = /^\s*(\d{1,4})\s*(?:шт\.?)?\s*$/u.exec(value);
  if (digits === null) return null;
  const parsed = Number(digits[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

function openGroup(
  state: ParseState,
  group: Omit<ParsedTransferGroup, 'ordinal'>,
  pageId: string,
): boolean {
  if (state.groups.length >= MAX_GROUPS) {
    if (!state.truncated) {
      state.truncated = true;
      state.warnings.push(
        `страница ${pageId}: групп больше ${MAX_GROUPS} — разбор описи прерван, ` +
          'остаток не разобран',
      );
    }
    return false;
  }
  state.groups.push({ ...group, ordinal: state.groups.length });
  return true;
}

function buildRow(
  state: ParseState,
  cells: readonly string[],
  layout: TransferColumns,
  groupOrdinal: number,
  pageId: string,
): void {
  if (state.rows.length >= MAX_ROWS) {
    if (!state.truncated) {
      state.truncated = true;
      state.warnings.push(
        `страница ${pageId}: строк больше ${MAX_ROWS} — разбор описи прерван, остаток не разобран`,
      );
    }
    return;
  }

  const ordinal = state.rows.length;
  const number = parseNumberCell(cellAt(cells, layout.number));
  const dateCell = cellAt(cells, layout.date);
  const dates = parseTransferDateCell(dateCell);

  if (dates.monthOnly) {
    state.warnings.push(`строка ${ordinal + 1}: дата «${dateCell}» указана без дня — не разобрана`);
  } else if (
    HAS_DATE.test(dateCell) &&
    dates.validFrom === null &&
    dates.validTo === null &&
    dates.issuedAt === null
  ) {
    state.warnings.push(`строка ${ordinal + 1}: дата «${dateCell}» не распознана или невозможна`);
  }

  const normalized =
    number.comparable && number.docNoRaw !== null ? normalizeDocNo(number.docNoRaw) : null;
  const orgRaw = cellAt(cells, layout.org);
  const rowNoRaw = cellAt(cells, layout.pos).replace(/\.$/u, '');
  const pagesRaw = cellAt(cells, layout.pages);

  state.rows.push({
    ordinal,
    groupOrdinal,
    rowNo: rowNoRaw === '' ? null : rowNoRaw,
    docNameRaw: cellAt(cells, layout.name),
    docNoRaw: number.docNoRaw,
    docNoNorm: normalized?.normalized ?? null,
    docNoFolded: normalized?.folded ?? null,
    orgRaw: orgRaw === '' ? null : orgRaw,
    // Даты из графы номера точнее: там их форма («от…», «с… по…») названа явно.
    issuedAt: number.issuedAt ?? dates.issuedAt,
    validFrom: number.validFrom ?? dates.validFrom,
    validTo: number.validTo ?? dates.validTo,
    sheets: toCount(cellAt(cells, layout.sheets)),
    copies: toCount(cellAt(cells, layout.copies)),
    pagesRaw: pagesRaw === '' ? null : pagesRaw,
  });
}

/**
 * Дописывает номер АОСР открытой группе формы Б.
 *
 * Номер приходит не с баннером, а со строкой акта внутри группы, и потому
 * группа существует раньше, чем становится известен её номер. Переписывается
 * только ПЕРВАЯ такая строка: вторым «АОСР» в одной группе бывает акт
 * приложения, и он номер группы не задаёт.
 */
function attachActNo(state: ParseState, groupOrdinal: number, row: ParsedTransferRow): void {
  const group = state.groups[groupOrdinal];
  if (group === undefined || group.actNoRaw !== null) return;
  if (!ACT_ROW.test(normalizeRegistryName(row.docNameRaw))) return;

  state.groups[groupOrdinal] = {
    ...group,
    actNoRaw: row.docNoRaw,
    actNoNorm: row.docNoNorm,
    actNoFolded: row.docNoFolded,
    actRowOrdinal: row.ordinal,
  };
}

export function parseTransferRegistry(input: {
  readonly pages: readonly TransferPageInput[];
}): TransferParseResult {
  const state: ParseState = {
    groups: [],
    rows: [],
    warnings: [],
    layout: null,
    closed: false,
    truncated: false,
  };
  let openGroupOrdinal: number | null = null;

  for (const page of input.pages) {
    if (state.closed || state.truncated) break;

    for (const block of scanBlocks(page.text)) {
      if (state.closed || state.truncated) break;

      if (block.kind === 'bold') {
        if (FOOTER_LINE.test(block.text)) {
          state.closed = true;
          break;
        }
        if (state.layout?.form === 'b' && !NOT_A_BANNER.test(block.text)) {
          const banner = splitBanner(block.text);
          if (banner.title !== '') {
            const opened = openGroup(
              state,
              {
                groupNo: null,
                titleRaw: banner.title,
                actNoRaw: null,
                actNoNorm: null,
                actNoFolded: null,
                contractorRaw: banner.contractor,
                actRowOrdinal: null,
              },
              page.sourcePageId,
            );
            if (opened) openGroupOrdinal = state.groups.length - 1;
          }
        }
        continue;
      }

      const table = block.table;
      if (isVolumesTable(table)) {
        // Таблица объёмов идёт ПОСЛЕ описи и её строки описью не являются.
        // Пропустить её мало — надо закрыть опись: иначе следующая таблица
        // подвала была бы принята за продолжение.
        state.closed = true;
        break;
      }

      if (state.layout === null) {
        if (table.header === null) continue;
        const layout = mapTransferColumns(table.header);
        if (layout === null) continue;
        state.layout = layout;
      } else if (table.header !== null && table.header.some((cell) => cell !== '')) {
        // Шапка есть и она непустая — это либо повтор шапки описи, либо чужая
        // таблица. Повтор узнаётся раскладкой; чужая таблица пропускается.
        const repeated = mapTransferColumns(table.header);
        if (repeated === null || repeated.form !== state.layout.form) continue;
      }
      // Пустая шапка `| | | | | |` — это продолжение описи через разрыв
      // страницы, и раскладка наследуется от открытой таблицы. Требовать
      // читаемую шапку на каждой странице значило бы терять половину описи.

      const layout = state.layout;

      for (const cells of table.rows) {
        if (state.truncated) break;
        if (cells.every((cell) => cell === '')) continue;

        const banner = layout.form === 'b' ? bannerText(cells) : null;
        if (banner !== null) {
          const split = splitBanner(banner);
          const opened = openGroup(
            state,
            {
              groupNo: null,
              titleRaw: split.title,
              actNoRaw: null,
              actNoNorm: null,
              actNoFolded: null,
              contractorRaw: split.contractor,
              actRowOrdinal: null,
            },
            page.sourcePageId,
          );
          if (opened) openGroupOrdinal = state.groups.length - 1;
          continue;
        }

        if (cells.length !== layout.count) {
          state.warnings.push(
            `страница ${page.sourcePageId}: строка описи из ${cells.length} граф ` +
              `вместо ${layout.count} отброшена`,
          );
          continue;
        }
        if (cells.every((cell, index) => cell === String(index + 1))) continue;

        const posRaw = cellAt(cells, layout.pos).replace(/\.$/u, '');

        if (layout.form === 'a' && posRaw !== '' && POSITION_NO.test(posRaw)) {
          // Форма А: строка с непустым «№ п/п» — это САМА РАБОТА, её графа
          // «№ документа» несёт номер АОСР, а следующие строки с пустым «№ п/п»
          // суть приложения этой работы.
          const number = parseNumberCell(cellAt(cells, layout.number));
          const normalized =
            number.comparable && number.docNoRaw !== null ? normalizeDocNo(number.docNoRaw) : null;
          const opened = openGroup(
            state,
            {
              groupNo: posRaw,
              titleRaw: normalizeRegistryName(cellAt(cells, layout.name)),
              actNoRaw: number.docNoRaw,
              actNoNorm: normalized?.normalized ?? null,
              actNoFolded: normalized?.folded ?? null,
              contractorRaw: null,
              actRowOrdinal: null,
            },
            page.sourcePageId,
          );
          if (!opened) break;
          openGroupOrdinal = state.groups.length - 1;
        }

        if (openGroupOrdinal === null) {
          state.warnings.push(
            `страница ${page.sourcePageId}: строка описи «${cellAt(cells, layout.name)}» ` +
              'встретилась до первой группы — отнести её к комплекту не к чему',
          );
          continue;
        }

        const before = state.rows.length;
        buildRow(state, cells, layout, openGroupOrdinal, page.sourcePageId);
        const added = state.rows[before];
        if (added !== undefined && layout.form === 'b') {
          attachActNo(state, openGroupOrdinal, added);
        }
      }
    }
  }

  const form = state.layout?.form ?? null;
  if (form === null) {
    state.warnings.push(
      'шапка описи не распознана: ни «кол-во листов»/«страница по списку» (форма Б), ' +
        'ни «кол-во экз.» (форма А) — строки не разобраны',
    );
  }
  for (const group of state.groups) {
    if (group.actNoRaw === null) {
      state.warnings.push(
        `группа ${group.ordinal + 1} «${group.titleRaw}»: номер АОСР не найден — ` +
          'сопоставление комплекта пойдёт по наименованию, а не по номеру',
      );
    }
  }

  return {
    form,
    header: parseTransferHeader(input.pages),
    groups: state.groups,
    rows: state.rows,
    warnings: state.warnings,
  };
}

// =====================================================================
// Сопоставление групп описи с комплектами
// =====================================================================

/** Комплект папки в том виде, в каком он участвует в сопоставлении групп. */
export interface TransferGroupCandidate {
  readonly workId: string;
  readonly revisionId: string;
  readonly contractorId: string;
  readonly contractorName: string | null;
  readonly title: string;
  /** Номера документов типа `aosr` этой ревизии (`field_values.number`). */
  readonly actNumbers: readonly string[];
}

export interface TransferGroupMatch {
  readonly groupOrdinal: number;
  readonly state: 'matched' | 'missing' | 'ambiguous';
  readonly workId: string | null;
  readonly revisionId: string | null;
  readonly contractorId: string | null;
  readonly score: number | null;
  readonly reason: string;
}

export interface TransferGroupsOutcome {
  readonly groups: readonly TransferGroupMatch[];
  /** Комплекты папки, которых опись не назвала ни одной группой. */
  readonly extraWorkIds: readonly string[];
}

/** Счёт точного совпадения номера АОСР. Единица — и только здесь. */
const ACT_EXACT_SCORE = 1;
/** Совпадение номера после фолдинга гомоглифов: строго меньше точного (§8.3). */
const ACT_FOLDED_SCORE = 0.85;
/** Совпадение по наименованию работы: номера не было или он не сошёлся. */
const TITLE_SCORE = 0.9;
/** Коллизия, различённая исполнителем: самый слабый способ выбрать один. */
const CONTRACTOR_SCORE = 0.8;

function indexActNumbers(
  candidates: readonly TransferGroupCandidate[],
  form: (value: string) => string,
): Map<string, TransferGroupCandidate[]> {
  const index = new Map<string, TransferGroupCandidate[]>();
  for (const candidate of candidates) {
    for (const number of candidate.actNumbers) {
      const key = form(number);
      if (key === '') continue;
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [candidate]);
      else if (!bucket.includes(candidate)) bucket.push(candidate);
    }
  }
  return index;
}

/** Сужение коллизии исполнителем: сравниваются нормализованные наименования. */
function narrowByContractor(
  found: readonly TransferGroupCandidate[],
  contractorRaw: string | null,
): TransferGroupCandidate[] {
  if (contractorRaw === null) return [...found];
  const needle = normalizeRegistryName(contractorRaw).toLowerCase();
  if (needle === '') return [...found];

  const narrowed = found.filter((candidate) => {
    const name = (candidate.contractorName ?? '').toLowerCase();
    if (name === '') return false;
    return name.includes(needle) || needle.includes(name);
  });
  return narrowed.length > 0 ? narrowed : [...found];
}

/**
 * Сопоставляет группы описи с комплектами папки.
 *
 * Лестница фиксирована: точный номер АОСР → номер после фолдинга → точное
 * наименование работы → сужение исполнителем. Порядок не переставляется:
 * наименование работы в описи пишется от руки и обобщается, поэтому поставить
 * его выше номера значило бы предпочесть слабое свидетельство сильному.
 *
 * Функция чистая: ни БД, ни области видимости. Решение о том, что делать с
 * `extraWorkIds`, принимает задача — здесь нет ни ревизии, ни прав, а значит
 * нет и способа ими ошибиться.
 */
export function matchTransferGroups(
  groups: readonly ParsedTransferGroup[],
  candidates: readonly TransferGroupCandidate[],
): TransferGroupsOutcome {
  const byNormalized = indexActNumbers(candidates, (value) => normalizeDocNo(value).normalized);
  const byFolded = indexActNumbers(candidates, (value) => normalizeDocNo(value).folded);

  const byTitle = new Map<string, TransferGroupCandidate[]>();
  for (const candidate of candidates) {
    const key = normalizeRegistryName(candidate.title).toLowerCase();
    if (key === '') continue;
    const bucket = byTitle.get(key);
    if (bucket === undefined) byTitle.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const named = new Set<string>();
  const matches: TransferGroupMatch[] = [];

  const decide = (
    group: ParsedTransferGroup,
    found: readonly TransferGroupCandidate[],
    score: number,
    reason: string,
  ): TransferGroupMatch | null => {
    if (found.length === 0) return null;
    for (const candidate of found) named.add(candidate.workId);

    const narrowed =
      found.length === 1 ? [...found] : narrowByContractor(found, group.contractorRaw);
    const single = narrowed.length === 1 ? narrowed[0] : undefined;
    if (single === undefined) {
      return {
        groupOrdinal: group.ordinal,
        state: 'ambiguous',
        workId: null,
        revisionId: null,
        contractorId: null,
        score: null,
        reason: `${reason}: подходят ${narrowed.length} комплектов, различить их сверка не может`,
      };
    }

    return {
      groupOrdinal: group.ordinal,
      state: 'matched',
      workId: single.workId,
      revisionId: single.revisionId,
      contractorId: single.contractorId,
      score: found.length === 1 ? score : CONTRACTOR_SCORE,
      reason: found.length === 1 ? reason : `${reason}, коллизия различена исполнителем`,
    };
  };

  for (const group of groups) {
    // Ступени берутся ЛЕНИВО и обрываются на первой сработавшей. Посчитать все
    // три и выбрать лучшую нельзя: `decide` попутно помечает найденных
    // кандидатов названными описью, и комплект, чьё наименование случайно
    // совпало с уже сопоставленной по номеру группой, перестал бы попадать в
    // «не названные описью» — то есть проигравшая ступень молча гасила бы
    // расхождение, ради которого сверка и существует.
    const ladder: readonly (() => TransferGroupMatch | null)[] = [
      () =>
        group.actNoNorm === null
          ? null
          : decide(
              group,
              byNormalized.get(group.actNoNorm) ?? [],
              ACT_EXACT_SCORE,
              'номер АОСР совпал точно',
            ),
      () =>
        group.actNoFolded === null
          ? null
          : decide(
              group,
              byFolded.get(group.actNoFolded) ?? [],
              ACT_FOLDED_SCORE,
              'номер АОСР совпал после фолдинга гомоглифов',
            ),
      () =>
        decide(
          group,
          byTitle.get(normalizeRegistryName(group.titleRaw).toLowerCase()) ?? [],
          TITLE_SCORE,
          'наименование работы совпало точно',
        ),
    ];

    let decided: TransferGroupMatch | null = null;
    for (const step of ladder) {
      decided = step();
      if (decided !== null) break;
    }

    matches.push(
      decided ?? {
        groupOrdinal: group.ordinal,
        state: 'missing',
        workId: null,
        revisionId: null,
        contractorId: null,
        score: null,
        reason:
          group.actNoNorm === null
            ? 'у группы описи нет номера АОСР, а наименование работы не совпало ни с одним комплектом'
            : 'комплекта с таким номером АОСР в папке нет',
      },
    );
  }

  const extraWorkIds = candidates
    .filter((candidate) => !named.has(candidate.workId))
    .map((candidate) => candidate.workId);

  return { groups: matches, extraWorkIds };
}
