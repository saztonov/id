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
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
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
