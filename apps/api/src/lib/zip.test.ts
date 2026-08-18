/**
 * Разбор архива экспорта: целостность, а не «как-нибудь распакуется» (§5.2, шаг 8).
 *
 * Архив приходит из внешней системы и становится неизменяемым артефактом
 * прогона, на который ссылаются доказательства замечаний. Поэтому проверяется
 * именно ОТКАЗ на всех формах повреждения: молчаливое «в архиве не оказалось
 * document.md» превратило бы битый экспорт в успешный прогон с нулём страниц.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  crc32,
  crc32Finish,
  crc32Update,
  readZipEntries,
  writeZipStream,
  ZipError,
  type ZipSink,
  type ZipSourceEntry,
} from './zip.js';

const LIMIT = 1024 * 1024;

interface Entry {
  readonly name: string;
  readonly content: Buffer;
  readonly deflate?: boolean;
}

/** Сборка архива в тесте: тот же формат, что у `zipfile.ZipFile` в RD WEB. */
function buildZip(entries: readonly Entry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const stored = entry.deflate === true ? deflateRawSync(entry.content) : entry.content;
    const method = entry.deflate === true ? 8 : 0;
    const crc = crc32(entry.content);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(stored.length, 18);
    header.writeUInt32LE(entry.content.length, 22);
    header.writeUInt16LE(name.length, 26);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(stored.length, 20);
    dir.writeUInt32LE(entry.content.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);

    local.push(header, name, stored);
    central.push(dir, name);
    offset += header.length + name.length + stored.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, centralBytes, end]);
}

const MD = Buffer.from('# Document: комплект\n\n## Page 1\n', 'utf8');
const HTML = Buffer.from('<!doctype html><html></html>', 'utf8');

describe('чтение архива экспорта', () => {
  it('читает записи stored и deflate одинаково', () => {
    const zip = buildZip([
      { name: 'document.md', content: MD },
      { name: 'document.html', content: HTML, deflate: true },
    ]);
    const entries = readZipEntries(zip, LIMIT);
    expect(entries.map((entry) => entry.name)).toEqual(['document.md', 'document.html']);
    expect(entries[0]?.bytes.toString('utf8')).toBe(MD.toString('utf8'));
    expect(entries[1]?.bytes.toString('utf8')).toBe(HTML.toString('utf8'));
  });

  it('отвергает обрезанный архив', () => {
    const zip = buildZip([{ name: 'document.md', content: MD }]);
    expect(() => readZipEntries(zip.subarray(0, zip.length - 30), LIMIT)).toThrow(ZipError);
  });

  it('отвергает повреждённое содержимое по контрольной сумме', () => {
    const zip = buildZip([{ name: 'document.md', content: MD }]);
    const damaged = Buffer.from(zip);
    // Структура цела: правится только байт данных, каталог и размеры прежние.
    const dataStart = 30 + Buffer.from('document.md', 'utf8').length;
    damaged[dataStart] = (damaged[dataStart] ?? 0) ^ 0xff;
    expect(() => readZipEntries(damaged, LIMIT)).toThrow(/Контрольная сумма/);
  });

  it('отвергает архив, распакованный размер которого выше потолка', () => {
    const big = Buffer.alloc(4096, 0x41);
    const zip = buildZip([{ name: 'document.md', content: big, deflate: true }]);
    // Сжатый размер здесь десятки байт — потолок обязан считаться по
    // РАСПАКОВАННОМУ, иначе zip-бомба проходит.
    expect(zip.length).toBeLessThan(1024);
    expect(() => readZipEntries(zip, 1024)).toThrow(/предел/);
  });

  it('отвергает пустой и бессигнатурный вход', () => {
    expect(() => readZipEntries(new Uint8Array(4), LIMIT)).toThrow(ZipError);
    expect(() => readZipEntries(Buffer.alloc(64, 0x00), LIMIT)).toThrow(/EOCD/);
  });
});

// =====================================================================
// Сборка архива согласованной ревизии (§13, задача 23)
// =====================================================================

/**
 * Писатель проверяется ЧИТАТЕЛЕМ, а не собственным утверждением.
 *
 * Обе стороны написаны здесь же, и «мой архив разбирается моим же разбором» —
 * слабое доказательство ровно до тех пор, пока читатель не проверяет CRC-32,
 * размеры и структуру каталога. Он проверяет всё три, поэтому круг замыкается
 * содержательно: испорченный писатель роняет чтение.
 */
function collect(): { sink: ZipSink; bytes: () => Buffer } {
  const chunks: Buffer[] = [];
  return {
    sink: {
      write: (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
    },
    bytes: () => Buffer.concat(chunks),
  };
}

function entry(name: string, content: Buffer, chunkSize = content.length): ZipSourceEntry {
  return {
    name,
    byteLength: content.length,
    open: function* () {
      for (let offset = 0; offset < content.length; offset += Math.max(1, chunkSize)) {
        yield content.subarray(offset, offset + Math.max(1, chunkSize));
      }
    },
  };
}

describe('сборка архива', () => {
  it('собирает архив, который читается обратно побайтово', async () => {
    const { sink, bytes } = collect();
    const result = await writeZipStream(
      [entry('manifest.json', MD), entry('documents/001.pdf', HTML)],
      sink,
    );

    const archive = bytes();
    expect(result.entryCount).toBe(2);
    expect(result.byteSize).toBe(archive.length);

    const entries = readZipEntries(archive, LIMIT);
    expect(entries.map((item) => item.name)).toEqual(['manifest.json', 'documents/001.pdf']);
    expect(entries[0]?.bytes.toString('utf8')).toBe(MD.toString('utf8'));
    expect(entries[1]?.bytes.toString('utf8')).toBe(HTML.toString('utf8'));
  });

  it('содержимое, приходящее кусками, не меняет результат', async () => {
    const whole = collect();
    await writeZipStream([entry('a.bin', MD)], whole.sink);
    const chunked = collect();
    await writeZipStream([entry('a.bin', MD, 3)], chunked.sink);
    // Побайтовое совпадение — это ещё и детерминизм: время записей
    // зафиксировано, поэтому sha256 архива описывает содержимое, а не момент.
    expect(chunked.bytes().equals(whole.bytes())).toBe(true);
  });

  it('расхождение заявленного и фактического размера — отказ, а не битый архив', async () => {
    const lying: ZipSourceEntry = {
      name: 'a.bin',
      byteLength: MD.length + 1,
      open: () => [MD],
    };
    await expect(writeZipStream([lying], collect().sink)).rejects.toThrow(/заявленных/);
  });

  it('пустой архив и повтор имени отвергаются', async () => {
    await expect(writeZipStream([], collect().sink)).rejects.toThrow(/без записей/);
    await expect(
      writeZipStream([entry('a.bin', MD), entry('a.bin', HTML)], collect().sink),
    ).rejects.toThrow(/дважды/);
  });

  it('накопительный CRC-32 совпадает с одноразовым', () => {
    const halves = [MD.subarray(0, 5), MD.subarray(5)];
    let crc = 0xffffffff;
    for (const half of halves) crc = crc32Update(crc, half);
    expect(crc32Finish(crc)).toBe(crc32(MD));
  });
});
