/**
 * Кэш рабочих PDF (S41).
 *
 * Проверяется то, ради чего он заведён: один файл вместо сотен скачиваний,
 * одно скачивание при одновременном спросе и вытеснение, которое не трогает
 * файл, читаемый прямо сейчас.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkingPdfCache } from './pdf-cache.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'id-pdf-cache-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Хранилище-двойник: считает обращения и пишет содержимое по ключу. */
function storage(contents: Record<string, string>): {
  readonly fetch: (key: string, destination: string) => Promise<void>;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    fetch: async (key, destination) => {
      calls += 1;
      await writeFile(destination, contents[key] ?? '');
    },
    calls: () => calls,
  };
}

describe('WorkingPdfCache', () => {
  it('второй запрос того же документа не идёт в хранилище', async () => {
    // 220 страниц комплекта — это 660 задач, каждая из которых до S41 скачивала
    // один и тот же файл целиком.
    const store = storage({ 'blobs/aa': 'PDF-A' });
    const cache = new WorkingPdfCache({ dir, maxBytes: 1024 * 1024, fetch: store.fetch });

    const first = await cache.lease('blobs/aa');
    expect(await readFile(first.path, 'utf8')).toBe('PDF-A');
    await first.release();

    const second = await cache.lease('blobs/aa');
    expect(second.path).toBe(first.path);
    await second.release();

    expect(store.calls()).toBe(1);
  });

  it('одновременный спрос скачивает файл один раз', async () => {
    // Fan-out ставит задачи разом, и без склейки кэш дал бы двести параллельных
    // скачиваний одного документа — ровно ту нагрузку, от которой он спасает.
    const store = storage({ 'blobs/bb': 'PDF-B' });
    const cache = new WorkingPdfCache({ dir, maxBytes: 1024 * 1024, fetch: store.fetch });

    const leased = await Promise.all([
      cache.lease('blobs/bb'),
      cache.lease('blobs/bb'),
      cache.lease('blobs/bb'),
    ]);
    for (const lease of leased) expect(await readFile(lease.path, 'utf8')).toBe('PDF-B');
    await Promise.all(leased.map((lease) => lease.release()));

    expect(store.calls()).toBe(1);
  });

  it('вытесняет по объёму, но не трогает арендованный файл', async () => {
    /**
     * Обратная сторона кэша: удалить документ из-под работающей задачи значит
     * обменять предсказуемый перерасход диска на невоспроизводимый отказ
     * страницы — следующий рендер просто не найдёт файла.
     */
    const store = storage({
      'blobs/held': 'H'.repeat(400),
      'blobs/old': 'O'.repeat(400),
      'blobs/new': 'N'.repeat(400),
    });
    const cache = new WorkingPdfCache({ dir, maxBytes: 900, fetch: store.fetch });

    // Первый документ остаётся в аренде: его читают прямо сейчас.
    const held = await cache.lease('blobs/held');

    const old = await cache.lease('blobs/old');
    await old.release();

    const fresh = await cache.lease('blobs/new');
    await fresh.release();

    const names = await readdir(dir);
    expect(names).toHaveLength(2);
    expect(await readFile(held.path, 'utf8')).toBe('H'.repeat(400));

    await held.release();
  });

  it('незавершённое скачивание не выдаётся как готовый документ', async () => {
    // Полуфайл, отданный растеризатору, выглядел бы как испорченный PDF —
    // отказ, который не воспроизводится и ничего не объясняет.
    const cache = new WorkingPdfCache({
      dir,
      maxBytes: 1024 * 1024,
      fetch: async (_key, destination) => {
        await writeFile(destination, 'частично');
        throw new Error('соединение оборвалось');
      },
    });

    await expect(cache.lease('blobs/broken')).rejects.toThrow('соединение оборвалось');
    expect(await readdir(dir)).toHaveLength(0);
  });
});
