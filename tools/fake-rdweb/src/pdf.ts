/**
 * Разбор PDF и статические бинарные ответы двойника — без сторонних библиотек.
 *
 * Число страниц считается по НАСТОЯЩИМ байтам загруженного файла, а не берётся из
 * запроса: тесты портала опираются на «страниц ровно столько, сколько в PDF», и
 * подставное число превратило бы весь поллинг рендера в проверку самой себя.
 */

/** Сигнатура PDF: первые пять байт, ровно как `_PDF_MAGIC` в `_documents_helpers.py`. */
export const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** Есть ли у буфера сигнатура `%PDF-` (проверяется по факту, а не по content-type). */
export function hasPdfMagic(bytes: Buffer): boolean {
  return bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * Число страниц PDF: прямой подсчёт объектов `/Type /Page`.
 *
 * `/Type /Pages` — это узел ДЕРЕВА страниц, а не страница, поэтому «s» на конце
 * исключается негативным просмотром вперёд. Фолбэк на `/Count N` нужен для файлов,
 * где листы лежат в сжатом потоке объектов: там строк `/Type /Page` в байтах нет,
 * а заголовок корня дерева обычно остаётся в открытом виде.
 *
 * Байты читаются как latin1: разбирается структура (ASCII-лексемы), а не содержимое,
 * и однобайтовая кодировка сохраняет позиции символов один-к-одному с байтами.
 */
export function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const direct = text.match(/\/Type\s*\/Page(?![\w])/g);
  if (direct !== null && direct.length > 0) {
    return direct.length;
  }
  // Фолбэк: `/Count N` у узла с `/Type /Pages` — в любом порядке ключей словаря.
  let best = 0;
  const patterns = [
    /\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/g,
    /\/Count\s+(\d+)[\s\S]{0,400}?\/Type\s*\/Pages/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number.parseInt(match[1] ?? '0', 10);
      if (Number.isFinite(value) && value > best) {
        best = value;
      }
    }
  }
  return best;
}

/**
 * Минимальный валидный PNG 1×1 — тело ответа превью страницы.
 *
 * Двойник не растеризует PDF: порталу от превью нужен только факт «пришли байты
 * картинки с правильным content-type», а не пиксели.
 */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Сигнатуры записей ZIP (little-endian): локальный заголовок, центральный, EOCD. */
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;

const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Детерминированный ZIP с одной записью без сжатия.
 *
 * Настоящий архив, а не просто байты с нужной сигнатурой: если потребитель
 * попробует его распаковать, он обязан распаковаться. Штампы времени — нули,
 * поэтому выдача побайтово воспроизводима между запусками.
 */
export function buildStoredZip(entries: Readonly<Record<string, Buffer>>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [entryName, content] of Object.entries(entries)) {
    const name = Buffer.from(entryName, 'utf8');
    const crc = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4); // версия, необходимая для распаковки
    localHeader.writeUInt16LE(0, 6); // флаги
    localHeader.writeUInt16LE(0, 8); // метод: stored
    localHeader.writeUInt16LE(0, 10); // время
    localHeader.writeUInt16LE(0, 12); // дата
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4); // версия создателя
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // номер диска
    centralHeader.writeUInt16LE(0, 36); // внутренние атрибуты
    centralHeader.writeUInt32LE(0, 38); // внешние атрибуты
    centralHeader.writeUInt32LE(offset, 42); // смещение локального заголовка

    local.push(localHeader, name, content);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + content.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBytes, end]);
}
