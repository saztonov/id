/**
 * Чтение ZIP-архива экспорта RD WEB (§5.2, шаг 8).
 *
 * ## Почему свой разбор, а не библиотека
 *
 * Читается ровно один архив известного происхождения: их `build_export_zip()`
 * кладёт записи через `zipfile.ZipFile(..., ZIP_DEFLATED)` без шифрования, без
 * ZIP64 и без потоковых дескрипторов. Нужны две вещи — перечислить записи и
 * распаковать их, — и обе даёт `node:zlib`. Зависимость ради этого добавлять
 * незачем (§2: каждая новая обосновывается), а площадь отказа у распаковщика
 * произвольных архивов заметно больше, чем у ста строк на известный формат.
 *
 * ## Что обязано отличаться от «повреждён»
 *
 * Артефакт прогона неизменяем и на него ссылаются доказательства замечаний,
 * поэтому «архив разобран частично» — недопустимое состояние: либо мы приняли
 * все записи и проверили каждую по CRC-32, либо забор объявлен неудавшимся.
 * Отсюда `ZipError` на любое расхождение: обрезанный хвост, чужая сигнатура,
 * несовпадение контрольной суммы, неизвестный метод сжатия. Молчаливое «в
 * архиве не оказалось document.md» превратило бы повреждённый экспорт в
 * успешный прогон с нулём распознанных страниц.
 */
import { inflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** Флаг «размеры лежат в data descriptor» — их `zipfile` его не ставит. */
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_ENCRYPTED = 0x0001;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  return crc32Finish(crc32Update(0xffffffff, data));
}

/**
 * Шаг накопительного CRC-32.
 *
 * Существует ради потоковой сборки архива: считать контрольную сумму записи,
 * не поднимая её в память целиком, иначе нельзя. Начальное состояние —
 * `0xffffffff`, финализация — `crc32Finish`; промежуточное значение НЕ является
 * контрольной суммой, и путать их нельзя, поэтому финализация вынесена в
 * отдельную функцию, а не «применяется, если не забыли».
 */
export function crc32Update(crc: number, data: Buffer): number {
  let next = crc;
  for (const byte of data) {
    next = (CRC32_TABLE[(next ^ byte) & 0xff] ?? 0) ^ (next >>> 8);
  }
  return next >>> 0;
}

export function crc32Finish(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

// =====================================================================
// Сборка архива согласованной ревизии (§13, задача 23)
// =====================================================================

/**
 * Дата-время записей архива: фиксированное значение, а не «сейчас».
 *
 * Архив согласованной ревизии обязан быть воспроизводим: один и тот же состав
 * даёт один и тот же sha256, и повтор задачи после падения воркера пишет те же
 * байты по тому же ключу, а не второй файл под другим хэшем. Текущее время
 * сделало бы `archive_sha256` бессмысленным — он менялся бы при каждой сборке,
 * ничего не говоря о содержимом. Когда собран архив, записано в БД
 * (`submission_archives.created_at`), и это единственное место, где такой факт
 * уместен.
 *
 * Значение — 1980-01-01 00:00:00 в формате MS-DOS, минимальное представимое.
 */
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 0x0021;

/** Версия ZIP, достаточная для метода STORED без ZIP64. */
const VERSION_NEEDED = 20;

/** Флаг «имена в UTF-8»: в архив едут русские имена файлов. */
const FLAG_UTF8 = 0x0800;

/**
 * Одна запись архива: имя, ЗАРАНЕЕ известный размер и способ получить байты.
 *
 * Размер обязателен и заявляется до чтения. Без него пришлось бы либо
 * складывать запись в память целиком, либо выносить размеры в data descriptor —
 * а такие архивы наш собственный читатель отвергает, и правильно делает: они
 * неразбираемы без последовательного прохода. Все размеры у нас и так известны:
 * `logical_documents.derived_pdf_bytes` пишет задача 22, а манифест собирается
 * в памяти.
 *
 * `open()` вызывается ДВАЖДЫ на запись: первый проход считает CRC-32, второй
 * пишет байты. Это не небрежность, а следствие формата: в локальном заголовке
 * STORED-записи контрольная сумма стоит ПЕРЕД данными, а единственные
 * альтернативы — держать запись в памяти целиком (то, ради ухода от чего
 * писатель и потоковый) либо вынести размеры в data descriptor (такие архивы
 * отвергает наш собственный читатель). Лишний проход — это чтение с диска или
 * из хранилища один раз за согласование поставки.
 */
export interface ZipSourceEntry {
  readonly name: string;
  readonly byteLength: number;
  /** Поток содержимого; вызывается дважды и обязан отдавать одно и то же. */
  open(): AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

/** Куда пишется архив: минимальная часть `Writable`, которой достаточно. */
export interface ZipSink {
  write(chunk: Uint8Array): void | boolean | Promise<unknown>;
}

export interface ZipWriteResult {
  readonly byteSize: number;
  readonly entryCount: number;
}

/**
 * Потоковая сборка ZIP — метод STORED, без сжатия.
 *
 * ## Почему потоком, а не в память
 *
 * Архив согласованной ревизии — это все её нарезанные документы, то есть
 * практически весь комплект: десятки мегабайт, а на реальных образцах до 86.
 * Собирать его `Buffer.concat`'ом значило бы вернуть ровно ту проблему, ради
 * которой боевая работа с PDF вынесена в `qpdf` (ADR-0003), причём на очереди
 * `cpu`, где рядом идёт вторая такая задача.
 *
 * ## Почему без сжатия
 *
 * Содержимое — уже сжатые внутри себя PDF и небольшой манифест. Deflate над
 * ними даёт единицы процентов и стоит процессорного времени. STORED к тому же
 * позволяет заполнить локальный заголовок ДО чтения данных, то есть обойтись
 * без data descriptor.
 *
 * ## Почему свой писатель, а не библиотека
 *
 * Та же причина, что у читателя выше: формат нужен ровно в одном известном
 * виде, а зависимость обосновывается (§2). Побочная польза важнее: собранный
 * архив разбирается НАШИМ ЖЕ `readZipEntries`, то есть писатель и читатель
 * проверяют друг друга на каждом прогоне теста.
 *
 * ZIP64 не поддерживается сознательно: превышение 4 ГиБ — отказ с внятной
 * причиной, а не молча испорченный файл.
 */
export async function writeZipStream(
  entries: readonly ZipSourceEntry[],
  sink: ZipSink,
): Promise<ZipWriteResult> {
  if (entries.length === 0) {
    throw new ZipError('Архив без записей не собирается: пустой файл ничего не подтверждает');
  }

  const names = new Set<string>();
  const centrals: Buffer[] = [];
  let offset = 0;

  const emit = async (chunk: Buffer): Promise<void> => {
    await sink.write(chunk);
    offset += chunk.length;
  };

  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new ZipError(`Запись «${entry.name}» встречается в архиве дважды`);
    }
    names.add(entry.name);

    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new ZipError(`У записи «${entry.name}» непригодный размер ${entry.byteLength}`);
    }
    if (entry.byteLength > 0xffffffff || offset > 0xffffffff) {
      throw new ZipError(`Архив превышает 4 ГиБ на записи «${entry.name}»: ZIP64 не поддержан`);
    }

    const name = Buffer.from(entry.name, 'utf8');
    const localOffset = offset;

    // Первый проход: контрольная сумма и сверка заявленного размера.
    const digest = await digestOf(entry);

    await emit(localHeader(name, digest, entry.byteLength));
    await emit(name);

    // Второй проход: сами байты. Размер сверяется ещё раз — источник, отдавший
    // на втором проходе другое количество байт, испортил бы архив молча.
    let written = 0;
    for await (const chunk of entry.open()) {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      written += buffer.length;
      if (written > entry.byteLength) {
        throw new ZipError(
          `Содержимое записи «${entry.name}» длиннее заявленных ${entry.byteLength} Б`,
        );
      }
      await emit(buffer);
    }
    if (written !== entry.byteLength) {
      throw new ZipError(
        `Содержимое записи «${entry.name}» короче заявленных ${entry.byteLength} Б`,
      );
    }

    centrals.push(centralHeader(name, digest, entry.byteLength, localOffset), name);
  }

  const centralDirectory = Buffer.concat(centrals);
  const centralOffset = offset;
  await emit(centralDirectory);

  const end = Buffer.alloc(END_SIZE);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  await emit(end);

  return { byteSize: offset, entryCount: entries.length };
}

/** CRC-32 записи первым проходом; заодно ловит расхождение с заявленным размером. */
async function digestOf(entry: ZipSourceEntry): Promise<number> {
  let crc = 0xffffffff;
  let seen = 0;
  for await (const chunk of entry.open()) {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    crc = crc32Update(crc, buffer);
    seen += buffer.length;
  }
  if (seen !== entry.byteLength) {
    throw new ZipError(
      `Запись «${entry.name}» отдала ${seen} Б при заявленных ${entry.byteLength} Б`,
    );
  }
  return crc32Finish(crc);
}

function localHeader(name: Buffer, crc: number, size: number): Buffer {
  const local = Buffer.alloc(LOCAL_HEADER_SIZE);
  local.writeUInt32LE(LOCAL_SIGNATURE, 0);
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(FLAG_UTF8, 6);
  local.writeUInt16LE(METHOD_STORED, 8);
  local.writeUInt16LE(DOS_EPOCH_TIME, 10);
  local.writeUInt16LE(DOS_EPOCH_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  return local;
}

function centralHeader(name: Buffer, crc: number, size: number, localOffset: number): Buffer {
  const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
  central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  central.writeUInt16LE(VERSION_NEEDED, 4);
  central.writeUInt16LE(VERSION_NEEDED, 6);
  central.writeUInt16LE(FLAG_UTF8, 8);
  central.writeUInt16LE(METHOD_STORED, 10);
  central.writeUInt16LE(DOS_EPOCH_TIME, 12);
  central.writeUInt16LE(DOS_EPOCH_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(localOffset, 42);
  return central;
}

/**
 * Смещение центрального каталога.
 *
 * Ищется от конца, как предписывает формат: EOCD хвостовой и может нести
 * комментарий. Ограничение поиска 64 КиБ — это максимальная длина комментария,
 * дальше искать нечего.
 */
function findEndOfCentralDirectory(bytes: Buffer): number {
  const limit = Math.max(0, bytes.length - END_SIZE - 0xffff);
  for (let offset = bytes.length - END_SIZE; offset >= limit; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new ZipError('Архив экспорта не содержит конца центрального каталога (EOCD)');
}

/**
 * Разбор архива целиком: имена записей и их содержимое.
 *
 * Потолок распакованного размера обязателен: архив приходит из внешней системы,
 * и «zip-бомба» — это тот же класс отказа, от которого §4.2 защищает приём
 * файлов. Без потолка одна запись в 40 байт разворачивается в гигабайты heap
 * воркера.
 */
export function readZipEntries(input: Uint8Array, maxTotalBytes: number): readonly ZipEntry[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < END_SIZE) {
    throw new ZipError(`Архив экспорта короче минимального (${bytes.length} Б)`);
  }

  const end = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (centralOffset + centralSize > bytes.length) {
    throw new ZipError('Центральный каталог архива выходит за границы файла');
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  let total = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > bytes.length) {
      throw new ZipError('Запись центрального каталога обрезана');
    }
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`Запись ${index} центрального каталога имеет чужую сигнатуру`);
    }

    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes
      .subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength)
      .toString('utf8');
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipError(`Запись «${name}» зашифрована: экспорт не принимается`);
    }
    if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) {
      throw new ZipError(`Размеры записи «${name}» вынесены в data descriptor`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATED) {
      throw new ZipError(`Запись «${name}» сжата неизвестным методом ${method}`);
    }

    total += uncompressedSize;
    if (total > maxTotalBytes) {
      throw new ZipError(
        `Распакованный экспорт превышает предел ${maxTotalBytes} Б — архив не принимается`,
      );
    }

    if (localOffset + LOCAL_HEADER_SIZE > bytes.length) {
      throw new ZipError(`Локальный заголовок записи «${name}» выходит за границы файла`);
    }
    if (bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError(`Локальный заголовок записи «${name}» имеет чужую сигнатуру`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new ZipError(`Содержимое записи «${name}» обрезано`);
    }

    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (method === METHOD_STORED) {
      content = Buffer.from(raw);
    } else {
      try {
        content = inflateRawSync(raw, { maxOutputLength: maxTotalBytes });
      } catch (error) {
        throw new ZipError(
          `Запись «${name}» не распаковывается: ${error instanceof Error ? error.name : 'неизвестная ошибка'}`,
        );
      }
    }

    if (content.length !== uncompressedSize) {
      throw new ZipError(
        `Запись «${name}» распакована в ${content.length} Б вместо заявленных ${uncompressedSize} Б`,
      );
    }
    if (crc32(content) !== expectedCrc) {
      throw new ZipError(`Контрольная сумма записи «${name}» не совпала: архив повреждён`);
    }

    entries.push({ name, bytes: content });
  }

  if (entries.length === 0) {
    throw new ZipError('Архив экспорта пуст');
  }
  return entries;
}
