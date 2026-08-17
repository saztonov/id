/**
 * Структурный разбор PDF без внешних инструментов (§4.2, §12 задача 1 и 2).
 *
 * Отвечает на три вопроса, от которых зависит вся дальнейшая обработка:
 * сколько в файле страниц и какова геометрия каждой (нужно S6 для координат),
 * зашифрован ли файл (такой уходит в карантин) и есть ли в нём встроенная
 * подпись (фиксируется, но не проверяется).
 *
 * ## Почему собственный разбор, а не qpdf
 *
 * `qpdf` на машине разработки отсутствует (ADR-0003), а решение «пускать файл
 * в обработку или в карантин» обязано приниматься одинаково везде и не зависеть
 * от наличия бинарника. Разбор здесь читает только структуру — словари, дерево
 * страниц, маркеры подписи — и никогда не декодирует содержимое страниц, потому
 * что сканы внутри лежат как `DCTDecode`/`JPXDecode` и их декодирование ничего
 * не добавляет к ответам на три вопроса выше.
 *
 * ## Почему объекты ищутся сканированием, а не по xref
 *
 * Таблица перекрёстных ссылок в реальных файлах регулярно расходится с телом
 * (её ломают редакторы, системы ЭДО и обрывы передачи), а нам нужен ответ
 * «файл разбираем или нет» именно по содержимому. Сканирование — то же, что
 * делает режим восстановления любого читателя PDF: идём по файлу, находим
 * `N G obj`, разбираем словарь, перепрыгиваем через данные потока. Прыжок
 * через поток принципиален: без него байты скана, случайно содержащие `obj`,
 * породили бы фантомный объект, который перекрыл бы настоящий (побеждает
 * последнее определение — так работает инкрементальное обновление).
 *
 * Объектные потоки (`/Type /ObjStm`) разбираются обязательно: в наблюдаемом
 * корпусе это PDF-1.6, где каталог и дерево страниц лежат внутри `ObjStm`
 * (`docs/CORPUS_FINDINGS.md`). Без их распаковки настоящие комплекты дали бы
 * «страниц не найдено» и ушли бы в карантин целиком.
 *
 * ## Границы
 *
 * Криптографической проверки подписи здесь нет и не будет (§0.1, §11.2):
 * найденная подпись фиксируется как `detected_unverified`, полная проверка ГОСТ
 * требует внешнего сервиса. Растровый штамп ЭДО («ДОКУМЕНТ ПОДПИСАН
 * ЭЛЕКТРОННОЙ ПОДПИСЬЮ») этот модуль не видит и видеть не должен — он
 * впечатан в изображение страницы и ловится правилом по OCR-тексту.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { SignatureProbeResult } from '@id/contracts';

// =====================================================================
// Пределы разбора: защита от PDF-бомб (§4.2)
// =====================================================================

/** Заголовок ищется только в начале файла: дальше это уже не заголовок. */
const HEADER_SEARCH_BYTES = 1024;

/** Больше объектов, чем в самом большом наблюдаемом комплекте, с запасом. */
const MAX_OBJECTS = 500_000;

/** Глубина дерева страниц: реальные деревья двухуровневые. */
const MAX_PAGE_TREE_DEPTH = 64;

/** Верхняя граница числа страниц при обходе; прикладной лимит — в политике. */
const MAX_PAGES_HARD = 100_000;

/**
 * Потолок распаковки одного потока объектов.
 *
 * Бомба сжатия — это несколько килобайт, разворачивающихся в гигабайты.
 * `maxOutputLength` у zlib превращает такой поток в ошибку распаковки, а не
 * в исчерпание памяти процесса.
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** Формат страницы по умолчанию (US Letter), если `/MediaBox` не найден нигде. */
const DEFAULT_MEDIA_BOX: readonly [number, number, number, number] = [0, 0, 612, 792];

// =====================================================================
// Публичные типы
// =====================================================================

/**
 * Геометрия страницы.
 *
 * `widthPt`/`heightPt` даны УЖЕ с учётом поворота — в том же пост-поворотном
 * фрейме, в котором §7.1 задаёт `coords_norm` и в котором `source_pages`
 * хранит размеры. Значения в пунктах (1/72 дюйма) дробные: округляет их
 * репозиторий при записи, потому что целочисленность — свойство колонки, а не
 * документа.
 */
export interface PdfPageGeometry {
  /** Индекс страницы в файле, 0-based, в порядке дерева страниц. */
  readonly index: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly rotation: 0 | 90 | 180 | 270;
}

/**
 * Признаки встроенной подписи и вердикт по ним.
 *
 * Поля `hasByteRange`, `subFilters`, `signatureFieldCount` совпадают с
 * `signatureProbeSchema` из контрактов — именно они уезжают в
 * `source_files.signature_probe`. `incrementalUpdates` в контракте нет: это
 * подтверждающий признак для диагностики (подпись всегда накладывается
 * инкрементальным обновлением и даёт второй `%%EOF`), и он идёт в журнал.
 */
export interface PdfSignatureFindings {
  readonly result: SignatureProbeResult;
  readonly hasByteRange: boolean;
  readonly subFilters: readonly string[];
  readonly signatureFieldCount: number;
  readonly incrementalUpdates: number;
  readonly probeError: string | null;
}

export type PdfProbeFailure = 'not_a_pdf' | 'encrypted' | 'unparsable';

export interface PdfProbeSuccess {
  readonly ok: true;
  /** Версия из заголовка `%PDF-1.6`; пустая строка, если она нечитаема. */
  readonly version: string;
  readonly pageCount: number;
  readonly pages: readonly PdfPageGeometry[];
  readonly signature: PdfSignatureFindings;
  /** Несмертельные расхождения: расходящийся `/Count`, страница без `/MediaBox`. */
  readonly warnings: readonly string[];
}

export interface PdfProbeRejection {
  readonly ok: false;
  readonly reason: PdfProbeFailure;
  readonly detail: string;
  /** Признаки подписи выдаются и здесь: зонд подписи не зависит от вердикта. */
  readonly signature: PdfSignatureFindings;
}

export type PdfProbeResult = PdfProbeSuccess | PdfProbeRejection;

// =====================================================================
// Разбор значений PDF
// =====================================================================

type PdfValue =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'array'; readonly items: readonly PdfValue[] }
  | { readonly kind: 'dict'; readonly entries: ReadonlyMap<string, PdfValue> }
  | { readonly kind: 'ref'; readonly num: number }
  | { readonly kind: 'keyword'; readonly value: string };

const NULL_VALUE: PdfValue = { kind: 'null' };

function isWhitespace(byte: number): boolean {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isDelimiter(byte: number): boolean {
  // ( ) < > [ ] { } / %
  return (
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25
  );
}

function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte);
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/** Курсор разбора: позиция изменяемая, буфер — нет. */
interface Cursor {
  readonly buf: Buffer;
  pos: number;
  readonly end: number;
}

function skipTrivia(cur: Cursor): void {
  while (cur.pos < cur.end) {
    const byte = cur.buf[cur.pos];
    if (byte === undefined) return;
    if (isWhitespace(byte)) {
      cur.pos += 1;
      continue;
    }
    // Комментарий `%` живёт до конца строки и может стоять между любыми
    // лексемами, в том числе внутри словаря.
    if (byte === 0x25) {
      while (cur.pos < cur.end) {
        const c = cur.buf[cur.pos];
        if (c === 10 || c === 13) break;
        cur.pos += 1;
      }
      continue;
    }
    return;
  }
}

function parseName(cur: Cursor): PdfValue {
  cur.pos += 1; // '/'
  const chars: number[] = [];
  while (cur.pos < cur.end) {
    const byte = cur.buf[cur.pos];
    if (byte === undefined || !isRegular(byte)) break;
    if (byte === 0x23 && cur.pos + 2 < cur.end) {
      const hex = cur.buf.toString('latin1', cur.pos + 1, cur.pos + 3);
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code)) {
        chars.push(code);
        cur.pos += 3;
        continue;
      }
    }
    chars.push(byte);
    cur.pos += 1;
  }
  return { kind: 'name', value: Buffer.from(chars).toString('latin1') };
}

function parseLiteralString(cur: Cursor): PdfValue {
  cur.pos += 1; // '('
  let depth = 1;
  const chars: number[] = [];
  while (cur.pos < cur.end) {
    const byte = cur.buf[cur.pos];
    cur.pos += 1;
    if (byte === undefined) break;
    if (byte === 0x5c) {
      // Экранирование: содержимое строк нам не нужно по смыслу, важно лишь не
      // принять экранированную скобку за конец строки.
      cur.pos += 1;
      continue;
    }
    if (byte === 0x28) depth += 1;
    if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) break;
    }
    chars.push(byte);
  }
  return { kind: 'string', value: Buffer.from(chars).toString('latin1') };
}

function parseHexString(cur: Cursor): PdfValue {
  cur.pos += 1; // '<'
  const start = cur.pos;
  while (cur.pos < cur.end && cur.buf[cur.pos] !== 0x3e) cur.pos += 1;
  const text = cur.buf.toString('latin1', start, cur.pos);
  cur.pos += 1; // '>'
  return { kind: 'string', value: text };
}

function parseNumberOrKeyword(cur: Cursor): PdfValue {
  const start = cur.pos;
  while (cur.pos < cur.end) {
    const byte = cur.buf[cur.pos];
    if (byte === undefined || !isRegular(byte)) break;
    cur.pos += 1;
  }
  const token = cur.buf.toString('latin1', start, cur.pos);
  if (token.length === 0) {
    // Ни одна лексема не начинается с этого байта: двигаемся, иначе цикл встанет.
    cur.pos += 1;
    return NULL_VALUE;
  }
  if (token === 'true') return { kind: 'bool', value: true };
  if (token === 'false') return { kind: 'bool', value: false };
  if (token === 'null') return NULL_VALUE;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
    return { kind: 'num', value: Number.parseFloat(token) };
  }
  return { kind: 'keyword', value: token };
}

/**
 * Свёртка `N G R` в ссылку.
 *
 * Ссылка в PDF — это не лексема, а последовательность из двух целых и `R`,
 * поэтому она собирается на уровне списка значений: разбирая массив или
 * словарь, мы держим уже прочитанные значения и при виде `R` заменяем два
 * последних числа одной ссылкой.
 */
function foldReference(values: PdfValue[], keyword: string): boolean {
  if (keyword !== 'R' || values.length < 2) return false;
  const gen = values[values.length - 1];
  const num = values[values.length - 2];
  if (num?.kind !== 'num' || gen?.kind !== 'num') return false;
  values.splice(values.length - 2, 2, { kind: 'ref', num: num.value });
  return true;
}

function parseArray(cur: Cursor, depth: number): PdfValue {
  cur.pos += 1; // '['
  const items: PdfValue[] = [];
  while (cur.pos < cur.end) {
    skipTrivia(cur);
    if (cur.buf[cur.pos] === 0x5d) {
      cur.pos += 1;
      break;
    }
    const value = parseValue(cur, depth + 1);
    if (value.kind === 'keyword') {
      if (foldReference(items, value.value)) continue;
      // Ключевое слово внутри массива — признак обрыва (`endobj`, `stream`).
      break;
    }
    items.push(value);
  }
  return { kind: 'array', items };
}

function parseDict(cur: Cursor, depth: number): PdfValue {
  cur.pos += 2; // '<<'
  const entries = new Map<string, PdfValue>();
  const pending: PdfValue[] = [];
  let key: string | null = null;

  const flush = (): void => {
    if (key === null) return;
    const value = pending[pending.length - 1];
    entries.set(key, value ?? NULL_VALUE);
    pending.length = 0;
    key = null;
  };

  while (cur.pos < cur.end) {
    skipTrivia(cur);
    if (cur.buf[cur.pos] === 0x3e && cur.buf[cur.pos + 1] === 0x3e) {
      cur.pos += 2;
      break;
    }
    const before = cur.pos;
    const value = parseValue(cur, depth + 1);
    if (cur.pos === before) {
      cur.pos += 1;
      continue;
    }
    if (value.kind === 'keyword') {
      if (foldReference(pending, value.value)) continue;
      break;
    }
    if (key === null && value.kind === 'name') {
      key = value.value;
      continue;
    }
    if (key !== null && value.kind === 'name' && pending.length > 0) {
      // Следующее имя при уже прочитанном значении — это следующий ключ.
      flush();
      key = value.value;
      continue;
    }
    pending.push(value);
  }
  flush();
  return { kind: 'dict', entries };
}

function parseValue(cur: Cursor, depth = 0): PdfValue {
  if (depth > 128) return NULL_VALUE;
  skipTrivia(cur);
  if (cur.pos >= cur.end) return NULL_VALUE;
  const byte = cur.buf[cur.pos];
  if (byte === undefined) return NULL_VALUE;
  if (byte === 0x2f) return parseName(cur);
  if (byte === 0x28) return parseLiteralString(cur);
  if (byte === 0x3c) {
    return cur.buf[cur.pos + 1] === 0x3c ? parseDict(cur, depth) : parseHexString(cur);
  }
  if (byte === 0x5b) return parseArray(cur, depth);
  if (byte === 0x5d || byte === 0x3e) {
    cur.pos += 1;
    return NULL_VALUE;
  }
  return parseNumberOrKeyword(cur);
}

// =====================================================================
// Индекс объектов
// =====================================================================

interface PdfObject {
  readonly num: number;
  /** Позиция определения в файле: побеждает последнее (инкрементальные обновления). */
  readonly position: number;
  readonly value: PdfValue;
  readonly streamStart: number | null;
  readonly streamEnd: number | null;
}

interface ObjectIndex {
  readonly objects: ReadonlyMap<number, PdfObject>;
  readonly trailers: readonly PdfValue[];
  readonly warnings: readonly string[];
  /** Не удалось разобрать объектный поток: утверждать отсутствие подписи нельзя. */
  readonly partial: boolean;
}

function dictOf(value: PdfValue | undefined): ReadonlyMap<string, PdfValue> | null {
  return value?.kind === 'dict' ? value.entries : null;
}

function nameOf(value: PdfValue | undefined): string | null {
  return value?.kind === 'name' ? value.value : null;
}

function numberOf(value: PdfValue | undefined): number | null {
  return value?.kind === 'num' ? value.value : null;
}

/**
 * Сканирование тела файла на определения объектов.
 *
 * Каждое `obj` проверяется по тому, что стоит ПЕРЕД ним: два целых через
 * пробелы. Это отсекает и `endobj`, и слово `obj` внутри текста.
 */
function indexObjects(buf: Buffer): ObjectIndex {
  const objects = new Map<number, PdfObject>();
  const trailers: PdfValue[] = [];
  const warnings: string[] = [];
  let partial = false;
  let pos = 0;

  while (pos < buf.length && objects.size < MAX_OBJECTS) {
    const at = buf.indexOf('obj', pos, 'latin1');
    if (at < 0) break;

    const after = buf[at + 3];
    if (after !== undefined && isRegular(after)) {
      pos = at + 3;
      continue;
    }

    const header = readObjectHeader(buf, at);
    if (header === null) {
      pos = at + 3;
      continue;
    }

    const cur: Cursor = { buf, pos: at + 3, end: buf.length };
    const value = parseValue(cur);

    let streamStart: number | null = null;
    let streamEnd: number | null = null;
    skipTrivia(cur);
    if (buf.toString('latin1', cur.pos, cur.pos + 6) === 'stream') {
      const bounds = readStreamBounds(buf, cur.pos + 6, dictOf(value));
      streamStart = bounds.start;
      streamEnd = bounds.end;
      cur.pos = bounds.next;
    }

    const previous = objects.get(header.num);
    if (previous === undefined || previous.position < at) {
      objects.set(header.num, { num: header.num, position: at, value, streamStart, streamEnd });
    }
    pos = Math.max(cur.pos, at + 3);
  }

  if (objects.size >= MAX_OBJECTS) {
    warnings.push(`превышен предел числа объектов (${MAX_OBJECTS})`);
    partial = true;
  }

  // Классические трейлеры: словарь после ключевого слова `trailer`.
  let trailerAt = buf.indexOf('trailer', 0, 'latin1');
  while (trailerAt >= 0) {
    const cur: Cursor = { buf, pos: trailerAt + 7, end: buf.length };
    const value = parseValue(cur);
    if (value.kind === 'dict') trailers.push(value);
    trailerAt = buf.indexOf('trailer', trailerAt + 7, 'latin1');
  }

  // Потоки перекрёстных ссылок несут те же ключи `/Root` и `/Encrypt`, что и
  // трейлер, и в PDF-1.5+ трейлера может не быть вовсе.
  for (const object of objects.values()) {
    const dict = dictOf(object.value);
    if (dict !== null && nameOf(dict.get('Type')) === 'XRef') trailers.push(object.value);
  }

  const expansion = expandObjectStreams(buf, objects);
  if (expansion.failed.length > 0) {
    warnings.push(`объектные потоки не разобраны: ${expansion.failed.join(', ')}`);
    partial = true;
  }

  return { objects, trailers, warnings, partial };
}

function readObjectHeader(buf: Buffer, objAt: number): { readonly num: number } | null {
  let cursor = objAt - 1;
  while (cursor >= 0) {
    const byte = buf[cursor];
    if (byte === undefined || !isWhitespace(byte)) break;
    cursor -= 1;
  }
  const genEnd = cursor + 1;
  while (cursor >= 0 && isDigit(buf[cursor] ?? -1)) cursor -= 1;
  const genStart = cursor + 1;
  if (genStart === genEnd) return null;

  while (cursor >= 0) {
    const byte = buf[cursor];
    if (byte === undefined || !isWhitespace(byte)) break;
    cursor -= 1;
  }
  const numEnd = cursor + 1;
  if (numEnd === genStart) return null;
  while (cursor >= 0 && isDigit(buf[cursor] ?? -1)) cursor -= 1;
  const numStart = cursor + 1;
  if (numStart === numEnd) return null;

  const before = buf[numStart - 1];
  if (before !== undefined && isRegular(before)) return null;

  const num = Number.parseInt(buf.toString('latin1', numStart, numEnd), 10);
  return Number.isSafeInteger(num) ? { num } : null;
}

/**
 * Границы данных потока.
 *
 * `/Length` бывает косвенной ссылкой, а бывает и просто неверной, поэтому
 * значению доверяем только тогда, когда сразу за данными действительно стоит
 * `endstream`. Иначе конец ищется поиском — это ровно то поведение, из-за
 * которого сканирование устойчивее xref.
 */
function readStreamBounds(
  buf: Buffer,
  afterKeyword: number,
  dict: ReadonlyMap<string, PdfValue> | null,
): { readonly start: number; readonly end: number; readonly next: number } {
  let start = afterKeyword;
  if (buf[start] === 13) start += 1;
  if (buf[start] === 10) start += 1;

  const declared = numberOf(dict?.get('Length'));
  if (declared !== null && declared >= 0 && start + declared <= buf.length) {
    const cur: Cursor = { buf, pos: start + declared, end: buf.length };
    skipTrivia(cur);
    if (buf.toString('latin1', cur.pos, cur.pos + 9) === 'endstream') {
      return { start, end: start + declared, next: cur.pos + 9 };
    }
  }

  const found = buf.indexOf('endstream', start, 'latin1');
  if (found < 0) return { start, end: buf.length, next: buf.length };
  let end = found;
  if (buf[end - 1] === 10) end -= 1;
  if (buf[end - 1] === 13) end -= 1;
  return { start, end, next: found + 9 };
}

/** Данные потока после `/Filter`. Поддержан только Flate — им сжаты `ObjStm`. */
function decodeStream(buf: Buffer, object: PdfObject): Buffer | null {
  if (object.streamStart === null || object.streamEnd === null) return null;
  const raw = buf.subarray(object.streamStart, object.streamEnd);
  const dict = dictOf(object.value);
  const filter = dict?.get('Filter');
  const filters =
    filter?.kind === 'array'
      ? filter.items.map((item) => nameOf(item)).filter((name): name is string => name !== null)
      : [nameOf(filter)].filter((name): name is string => name !== null);

  if (filters.length === 0) return Buffer.from(raw);
  if (filters.length > 1 || (filters[0] !== 'FlateDecode' && filters[0] !== 'Fl')) return null;

  let inflated: Buffer;
  try {
    inflated = inflateSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch {
    return null;
  }
  return applyPredictor(inflated, dictOf(dict?.get('DecodeParms')));
}

/**
 * PNG-предиктор `/DecodeParms`.
 *
 * У `ObjStm` встречается редко, у потоков перекрёстных ссылок — почти всегда,
 * а `/Encrypt` мы читаем в том числе из них. Без снятия предиктора такой
 * словарь распался бы на мусор, и файл с шифрованием мог бы пройти проверку.
 */
function applyPredictor(data: Buffer, parms: ReadonlyMap<string, PdfValue> | null): Buffer {
  const predictor = numberOf(parms?.get('Predictor')) ?? 1;
  if (predictor < 10) return data;

  const colors = numberOf(parms?.get('Colors')) ?? 1;
  const bpc = numberOf(parms?.get('BitsPerComponent')) ?? 8;
  const columns = numberOf(parms?.get('Columns')) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  if (rowLength <= 0) return data;

  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let previous = Buffer.alloc(rowLength);

  for (let row = 0; row < rows; row += 1) {
    const tag = data[row * (rowLength + 1)] ?? 0;
    const source = data.subarray(row * (rowLength + 1) + 1, (row + 1) * (rowLength + 1));
    const current = Buffer.alloc(rowLength);
    for (let i = 0; i < rowLength; i += 1) {
      const raw = source[i] ?? 0;
      const left = i >= bpp ? (current[i - bpp] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
      let value = raw;
      if (tag === 1) value = raw + left;
      else if (tag === 2) value = raw + up;
      else if (tag === 3) value = raw + ((left + up) >> 1);
      else if (tag === 4) value = raw + paeth(left, up, upLeft);
      current[i] = value & 0xff;
    }
    current.copy(out, row * rowLength);
    previous = current;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Объекты внутри `/Type /ObjStm`: в PDF-1.5+ там живёт каталог и дерево страниц. */
function expandObjectStreams(
  buf: Buffer,
  objects: Map<number, PdfObject>,
): { readonly failed: readonly number[] } {
  const failed: number[] = [];
  const streams = [...objects.values()].filter(
    (object) => nameOf(dictOf(object.value)?.get('Type')) === 'ObjStm',
  );

  for (const stream of streams) {
    const data = decodeStream(buf, stream);
    const dict = dictOf(stream.value);
    const count = numberOf(dict?.get('N'));
    const first = numberOf(dict?.get('First'));
    if (data === null || count === null || first === null) {
      failed.push(stream.num);
      continue;
    }

    const header: Cursor = { buf: data, pos: 0, end: Math.min(first, data.length) };
    const pairs: Array<{ num: number; offset: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const num = parseValue(header);
      const offset = parseValue(header);
      if (num.kind !== 'num' || offset.kind !== 'num') break;
      pairs.push({ num: num.value, offset: offset.value });
    }
    if (pairs.length !== count) failed.push(stream.num);

    for (const pair of pairs) {
      const start = first + pair.offset;
      if (start >= data.length) continue;
      const cur: Cursor = { buf: data, pos: start, end: data.length };
      const value = parseValue(cur);
      const previous = objects.get(pair.num);
      // Позиция объекта из потока — позиция самого потока: инкрементальное
      // обновление, переопределившее объект напрямую, обязано победить.
      if (previous === undefined || previous.position <= stream.position) {
        objects.set(pair.num, {
          num: pair.num,
          position: stream.position,
          value,
          streamStart: null,
          streamEnd: null,
        });
      }
    }
  }

  return { failed };
}

// =====================================================================
// Дерево страниц
// =====================================================================

interface InheritedAttributes {
  readonly mediaBox: readonly number[] | null;
  readonly cropBox: readonly number[] | null;
  readonly rotate: number | null;
}

function resolve(index: ObjectIndex, value: PdfValue | undefined): PdfValue | undefined {
  let current = value;
  for (let hops = 0; hops < 32; hops += 1) {
    if (current?.kind !== 'ref') return current;
    current = index.objects.get(current.num)?.value;
  }
  return undefined;
}

function boxOf(index: ObjectIndex, value: PdfValue | undefined): readonly number[] | null {
  const resolved = resolve(index, value);
  if (resolved?.kind !== 'array' || resolved.items.length < 4) return null;
  const numbers = resolved.items.map((item) => numberOf(resolve(index, item)));
  if (numbers.some((n) => n === null)) return null;
  return numbers as number[];
}

function collectPages(
  index: ObjectIndex,
  root: PdfValue,
  warnings: string[],
): readonly PdfPageGeometry[] {
  const pages: PdfPageGeometry[] = [];
  const visited = new Set<number>();

  const walk = (
    node: PdfValue | undefined,
    inherited: InheritedAttributes,
    depth: number,
  ): void => {
    if (depth > MAX_PAGE_TREE_DEPTH || pages.length >= MAX_PAGES_HARD) return;
    if (node?.kind === 'ref') {
      // Повторный визит — это цикл в /Kids: без отметки обход не завершится.
      if (visited.has(node.num)) return;
      visited.add(node.num);
    }
    const dict = dictOf(resolve(index, node));
    if (dict === null) return;

    const attributes: InheritedAttributes = {
      mediaBox: boxOf(index, dict.get('MediaBox')) ?? inherited.mediaBox,
      cropBox: boxOf(index, dict.get('CropBox')) ?? inherited.cropBox,
      rotate: numberOf(resolve(index, dict.get('Rotate'))) ?? inherited.rotate,
    };

    const kids = resolve(index, dict.get('Kids'));
    const type = nameOf(dict.get('Type'));
    if (type !== 'Page' && kids?.kind === 'array') {
      for (const kid of kids.items) walk(kid, attributes, depth + 1);
      return;
    }
    if (type === 'Pages') return;

    pages.push(geometryOf(pages.length, attributes, warnings));
  };

  walk(root, { mediaBox: null, cropBox: null, rotate: null }, 0);
  return pages;
}

function geometryOf(
  index: number,
  attributes: InheritedAttributes,
  warnings: string[],
): PdfPageGeometry {
  const media = attributes.mediaBox ?? DEFAULT_MEDIA_BOX;
  if (attributes.mediaBox === null) {
    warnings.push(`страница ${index}: /MediaBox не найден, взят формат по умолчанию`);
  }
  // Видимая область — пересечение CropBox и MediaBox: именно её показывает
  // читатель и по ней же считает координаты pdf.js (§7.1).
  const box = intersect(attributes.cropBox ?? media, media);
  const width = Math.abs(box[2] - box[0]);
  const height = Math.abs(box[3] - box[1]);
  const rotation = normalizeRotation(attributes.rotate);
  const swapped = rotation === 90 || rotation === 270;

  return {
    index,
    widthPt: swapped ? height : width,
    heightPt: swapped ? width : height,
    rotation,
  };
}

function intersect(
  a: readonly number[],
  b: readonly number[],
): readonly [number, number, number, number] {
  const ax0 = Math.min(a[0] ?? 0, a[2] ?? 0);
  const ay0 = Math.min(a[1] ?? 0, a[3] ?? 0);
  const ax1 = Math.max(a[0] ?? 0, a[2] ?? 0);
  const ay1 = Math.max(a[1] ?? 0, a[3] ?? 0);
  const bx0 = Math.min(b[0] ?? 0, b[2] ?? 0);
  const by0 = Math.min(b[1] ?? 0, b[3] ?? 0);
  const bx1 = Math.max(b[0] ?? 0, b[2] ?? 0);
  const by1 = Math.max(b[1] ?? 0, b[3] ?? 0);

  const x0 = Math.max(ax0, bx0);
  const y0 = Math.max(ay0, by0);
  const x1 = Math.min(ax1, bx1);
  const y1 = Math.min(ay1, by1);
  // Непересекающиеся рамки — дефект файла; берём MediaBox, а не нулевой размер:
  // страница нулевой ширины не пройдёт CHECK в БД и уронит весь файл.
  if (x1 <= x0 || y1 <= y0) return [bx0, by0, bx1, by1];
  return [x0, y0, x1, y1];
}

function normalizeRotation(value: number | null): 0 | 90 | 180 | 270 {
  if (value === null || !Number.isFinite(value)) return 0;
  const normalized = ((Math.trunc(value) % 360) + 360) % 360;
  if (normalized === 90) return 90;
  if (normalized === 180) return 180;
  if (normalized === 270) return 270;
  return 0;
}

/** Корень дерева страниц: сначала `/Root` трейлера, затем каталог, затем корневой `/Pages`. */
function findPageTreeRoot(index: ObjectIndex): PdfValue | null {
  for (const trailer of [...index.trailers].reverse()) {
    const root = resolve(index, dictOf(trailer)?.get('Root'));
    const pages = dictOf(root)?.get('Pages');
    if (pages !== undefined) return pages;
  }

  const ordered = [...index.objects.values()].sort((a, b) => b.position - a.position);
  for (const object of ordered) {
    const dict = dictOf(object.value);
    if (dict !== null && nameOf(dict.get('Type')) === 'Catalog') {
      const pages = dict.get('Pages');
      if (pages !== undefined) return pages;
    }
  }
  for (const object of ordered) {
    const dict = dictOf(object.value);
    if (dict !== null && nameOf(dict.get('Type')) === 'Pages' && !dict.has('Parent')) {
      return object.value;
    }
  }
  return null;
}

// =====================================================================
// Подпись
// =====================================================================

function countOccurrences(buf: Buffer, needle: string): number {
  let count = 0;
  let at = buf.indexOf(needle, 0, 'latin1');
  while (at >= 0) {
    count += 1;
    at = buf.indexOf(needle, at + needle.length, 'latin1');
  }
  return count;
}

function collectSubFilters(buf: Buffer): readonly string[] {
  const found = new Set<string>();
  let at = buf.indexOf('/SubFilter', 0, 'latin1');
  while (at >= 0 && found.size < 16) {
    const cur: Cursor = { buf, pos: at + 10, end: buf.length };
    const value = parseValue(cur);
    if (value.kind === 'name' && value.value.length > 0) found.add(value.value);
    at = buf.indexOf('/SubFilter', at + 10, 'latin1');
  }
  return [...found];
}

interface SignatureEvidence {
  readonly hasByteRange: boolean;
  readonly subFilters: readonly string[];
  readonly signatureFieldCount: number;
  readonly incrementalUpdates: number;
}

/**
 * Признаки подписи в файле.
 *
 * `ByteRange` адресует байтовые смещения самого файла и потому НЕ может лежать
 * в сжатом потоке — его отсутствие в байтах является доказательством, а не
 * догадкой (§0.1). Словарь подписи и поле формы `/FT /Sig`, наоборот, вполне
 * могут оказаться внутри `ObjStm`, поэтому они считаются по разобранным
 * объектам, а не по сырым байтам.
 */
function collectSignatureEvidence(buf: Buffer, index: ObjectIndex | null): SignatureEvidence {
  let signatureFieldCount = 0;
  if (index === null) {
    // Разбора нет — остаётся сырой счёт: он завышен (совпадёт и `/Type/Sig`
    // внутри строки), но нулевым при наличии подписи не будет.
    signatureFieldCount = countOccurrences(buf, '/Sig');
  } else {
    for (const object of index.objects.values()) {
      const dict = dictOf(object.value);
      if (dict === null) continue;
      if (nameOf(dict.get('Type')) === 'Sig' || nameOf(dict.get('FT')) === 'Sig') {
        signatureFieldCount += 1;
      }
    }
  }

  return {
    hasByteRange: buf.includes('/ByteRange', 0, 'latin1'),
    subFilters: collectSubFilters(buf),
    signatureFieldCount,
    incrementalUpdates: Math.max(0, countOccurrences(buf, '%%EOF') - 1),
  };
}

/**
 * Вердикт по признакам: три состояния, ни одно из которых не «действительна».
 *
 * `none_detected` разрешено утверждать ТОЛЬКО о файле, который разобран
 * целиком: у файла, отвергнутого как повреждённый, шифрованный или не-PDF,
 * отсутствие маркеров ничего не доказывает — мы просто не дочитали его до
 * конца. Поэтому надёжность приходит аргументом из точки возврата `probePdf()`,
 * а не выводится здесь из полноты индекса объектов: обрубленный файл даёт
 * формально «полный» индекс из одного объекта.
 */
function signatureVerdict(
  evidence: SignatureEvidence,
  reliable: boolean,
  probeError: string | null,
): PdfSignatureFindings {
  const detected =
    evidence.hasByteRange || evidence.signatureFieldCount > 0 || evidence.subFilters.length > 0;
  const result: SignatureProbeResult = detected
    ? 'detected_unverified'
    : reliable
      ? 'none_detected'
      : 'unknown';

  return {
    ...evidence,
    result,
    probeError:
      result === 'unknown' ? (probeError ?? 'структура файла разобрана не полностью') : probeError,
  };
}

// =====================================================================
// Точка входа
// =====================================================================

function headerVersion(buf: Buffer): { readonly offset: number; readonly version: string } | null {
  const window = buf.subarray(0, Math.min(buf.length, HEADER_SEARCH_BYTES));
  const offset = window.indexOf('%PDF-', 0, 'latin1');
  if (offset < 0) return null;
  const version = buf.toString('latin1', offset + 5, offset + 8).trim();
  return { offset, version: /^\d\.\d$/.test(version) ? version : '' };
}

/** Зашифрован ли файл: `/Encrypt` в трейлере или в потоке перекрёстных ссылок. */
function isEncrypted(index: ObjectIndex, buf: Buffer): boolean {
  for (const trailer of index.trailers) {
    if (dictOf(trailer)?.has('Encrypt') === true) return true;
  }
  // Трейлеров нет вовсе — судить не по чему, и тогда сырое вхождение `/Encrypt`
  // трактуется в безопасную сторону: карантин лучше разбора мусора.
  return index.trailers.length === 0 && buf.includes('/Encrypt', 0, 'latin1');
}

export function probePdf(bytes: Uint8Array): PdfProbeResult {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const header = headerVersion(buf);
  if (header === null) {
    return {
      ok: false,
      reason: 'not_a_pdf',
      detail: 'сигнатура %PDF- не найдена в первых 1024 байтах',
      signature: signatureVerdict(
        collectSignatureEvidence(buf, null),
        false,
        'файл не является PDF',
      ),
    };
  }

  let index: ObjectIndex;
  try {
    index = indexObjects(buf);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'разбор объектов прерван';
    return {
      ok: false,
      reason: 'unparsable',
      detail,
      signature: signatureVerdict(collectSignatureEvidence(buf, null), false, detail),
    };
  }

  const evidence = collectSignatureEvidence(buf, index);
  const rejected = (reason: PdfProbeFailure, detail: string): PdfProbeRejection => ({
    ok: false,
    reason,
    detail,
    signature: signatureVerdict(evidence, false, detail),
  });

  if (isEncrypted(index, buf)) {
    return rejected('encrypted', 'файл зашифрован (/Encrypt): содержимое недоступно без пароля');
  }

  const rootPages = findPageTreeRoot(index);
  if (rootPages === null) {
    return rejected(
      'unparsable',
      index.objects.size === 0
        ? 'в файле не найдено ни одного объекта PDF'
        : 'не найдено дерево страниц (/Root → /Pages)',
    );
  }

  const warnings = [...index.warnings];
  const pages = collectPages(index, rootPages, warnings);
  if (pages.length === 0) {
    return rejected('unparsable', 'дерево страниц не содержит ни одной страницы');
  }

  // Файл разобран целиком — только теперь отсутствие маркеров подписи можно
  // трактовать как `none_detected`. Неполный индекс (нераспакованный ObjStm)
  // такого права не даёт.
  const signature = signatureVerdict(
    evidence,
    !index.partial,
    index.partial ? 'часть объектов файла не разобрана' : null,
  );

  const declaredCount = numberOf(resolve(index, dictOf(resolve(index, rootPages))?.get('Count')));
  if (declaredCount !== null && declaredCount !== pages.length) {
    warnings.push(`/Count дерева страниц (${declaredCount}) не совпал с обходом (${pages.length})`);
  }

  return {
    ok: true,
    version: header.version,
    pageCount: pages.length,
    pages,
    signature,
    warnings,
  };
}

// =====================================================================
// Политика приёмки файла (§4.2)
// =====================================================================

export type FileQuarantineReason =
  PdfProbeFailure | 'too_large' | 'too_many_pages' | 'hash_mismatch' | 'unsupported_mime';

export const PDF_MIME = 'application/pdf';

export interface FileVerificationPolicy {
  readonly maxBytes: number;
  readonly maxPages: number;
  /** SHA-256, под которым файл лежит в хранилище: расхождение — порча или подмена. */
  readonly expectedSha256?: string | undefined;
  readonly declaredMime?: string | null | undefined;
}

export interface FileAccepted {
  readonly state: 'ok';
  readonly sha256: string;
  readonly pageCount: number;
  readonly pages: readonly PdfPageGeometry[];
  readonly signature: PdfSignatureFindings;
  readonly warnings: readonly string[];
}

export interface FileQuarantined {
  readonly state: 'quarantined';
  readonly sha256: string;
  readonly reason: FileQuarantineReason;
  readonly detail: string;
  readonly signature: PdfSignatureFindings;
}

export type FileVerdict = FileAccepted | FileQuarantined;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Вердикт по файлу: принять или в карантин, и по какой причине.
 *
 * Порядок проверок — от дешёвых и безусловных к разбору: размер, объявленный
 * тип, целостность байтов, структура, лимит страниц. Причина возвращается
 * кодом, а не текстом: она попадает и в `verify_error`, и в событие ревизии, и
 * по ней строится подсказка пользователю.
 *
 * Функция чистая и не знает ни о БД, ни о задачах. Это сделано намеренно:
 * решение «в карантин» обязано проверяться на настоящих файлах, а не через
 * подставные объекты задачи.
 */
export function evaluatePdfFile(bytes: Uint8Array, policy: FileVerificationPolicy): FileVerdict {
  const sha256 = sha256Hex(bytes);
  const reject = (reason: FileQuarantineReason, detail: string, probe?: PdfProbeResult) => ({
    state: 'quarantined' as const,
    sha256,
    reason,
    detail,
    signature: probe?.signature ?? probePdf(bytes).signature,
  });

  if (bytes.byteLength > policy.maxBytes) {
    return reject(
      'too_large',
      `размер ${bytes.byteLength} Б превышает предел ${policy.maxBytes} Б`,
    );
  }
  if (policy.declaredMime != null && policy.declaredMime !== PDF_MIME) {
    return reject(
      'unsupported_mime',
      `тип ${policy.declaredMime} не поддержан, ожидался ${PDF_MIME}`,
    );
  }
  if (policy.expectedSha256 !== undefined && policy.expectedSha256 !== sha256) {
    return reject(
      'hash_mismatch',
      'SHA-256 содержимого не совпал с тем, под которым файл сохранён',
    );
  }

  const probe = probePdf(bytes);
  if (!probe.ok) return reject(probe.reason, probe.detail, probe);

  if (probe.pageCount > policy.maxPages) {
    return reject('too_many_pages', `страниц ${probe.pageCount}, предел ${policy.maxPages}`, probe);
  }

  return {
    state: 'ok',
    sha256,
    pageCount: probe.pageCount,
    pages: probe.pages,
    signature: probe.signature,
    warnings: probe.warnings,
  };
}
