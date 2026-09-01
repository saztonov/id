/**
 * Кэш рабочих PDF на диске воркера (S41).
 *
 * ## Зачем
 *
 * Каждая задача конвейера, которой нужна страница, скачивала ВЕСЬ рабочий
 * документ комплекта во временный каталог и удаляла его на выходе. Для комплекта
 * на 220 страниц это порядка 660 скачиваний одного и того же файла — зонды,
 * детекция, распознавание, — и при `MAX_UPLOAD_BYTES` в 200 МБ счёт идёт на
 * десятки гигабайт трафика к хранилищу и столько же записи на диск, у которого
 * на боевой машине и так занято около 80%. Ни одна из этих копий не отличалась
 * от прочих: файл иммутабелен по построению.
 *
 * ## Почему по содержимому, а не по идентификатору
 *
 * Ключ — sha256 самого документа (`blobKey` строится из него же). Это значит,
 * что кэш не может отдать устаревшее: пересобранный рабочий документ имеет
 * другой хэш и другой файл, а совпадение хэша означает совпадение байтов.
 * Сверять «не сменился ли bundle» не нужно вовсе — вопрос не возникает.
 *
 * ## Аренда, а не просто LRU
 *
 * Вытеснять файл, который прямо сейчас читает `pdftoppm`, нельзя: на Linux
 * открытый дескриптор переживёт удаление, но СЛЕДУЮЩИЙ рендер той же задачи
 * файла уже не найдёт, и страница упадёт с невнятной ошибкой. Поэтому у записи
 * есть счётчик пользователей: `acquire` его поднимает, `release` опускает, и
 * вытеснение обходит занятые записи стороной.
 *
 * ## Что кэш НЕ делает
 *
 * Не переживает перезапуск контейнера осмысленно: каталог лежит во временном
 * разделе, и после старта он либо пуст, либо содержит файлы, которые вытеснятся
 * по мере надобности. Это не хранилище, а буфер между хранилищем и задачей.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkingPdfCacheOptions {
  /** Каталог кэша. Создаётся при первом обращении. */
  readonly dir: string;
  /** Потолок суммарного объёма файлов кэша, байт. */
  readonly maxBytes: number;
  /** Как скачать документ, если его в кэше нет. */
  readonly fetch: (storageKey: string, destinationPath: string) => Promise<void>;
}

/** Файл кэша, выданный задаче: `release` обязателен, как `cleanup` до S41. */
export interface LeasedPdf {
  readonly path: string;
  readonly release: () => Promise<void>;
}

/**
 * Имя файла в кэше по ключу хранилища.
 *
 * Ключ уже контентный (`blobKey` строится из sha256 документа), поэтому имя от
 * него — тоже контентное: совпадение имени означает совпадение байтов. Хэшируем
 * ради формы имени, а не ради уникальности: в ключе есть слэши, и класть его в
 * имя файла как есть нельзя.
 */
function fileNameOf(storageKey: string): string {
  return createHash('sha256').update(storageKey).digest('hex');
}

export class WorkingPdfCache {
  readonly #options: WorkingPdfCacheOptions;
  /** Сколько задач сейчас читают файл: вытеснять занятые нельзя. */
  readonly #leases = new Map<string, number>();
  /**
   * Идущие скачивания.
   *
   * Без этого fan-out из двухсот задач начал бы двести параллельных скачиваний
   * одного файла — то есть ровно ту нагрузку, ради устранения которой кэш и
   * заведён. Промис общий: опоздавшие ждут первого.
   */
  readonly #inflight = new Map<string, Promise<string>>();
  #prepared = false;

  constructor(options: WorkingPdfCacheOptions) {
    this.#options = options;
  }

  /** Документ на диске. Пока аренда не освобождена, файл не вытесняется. */
  async lease(storageKey: string): Promise<LeasedPdf> {
    const name = fileNameOf(storageKey);
    const path = await this.#materialize(name, storageKey);
    this.#leases.set(name, (this.#leases.get(name) ?? 0) + 1);

    let released = false;
    return {
      path,
      release: async (): Promise<void> => {
        // Повторный вызов не должен уводить счётчик в минус: `finally` в
        // обработчиках срабатывает и на пути отказа, и на пути отмены.
        if (released) return;
        released = true;
        const held = (this.#leases.get(name) ?? 1) - 1;
        if (held <= 0) this.#leases.delete(name);
        else this.#leases.set(name, held);
        await this.#evict();
      },
    };
  }

  async #materialize(name: string, storageKey: string): Promise<string> {
    await this.#prepare();
    const path = this.#pathOf(name);

    const cached = await stat(path).catch(() => null);
    if (cached !== null && cached.isFile()) {
      // Отметка использования: вытеснение идёт по времени последнего обращения,
      // и без неё первый же большой комплект вытеснил бы файл, который читают
      // прямо сейчас, — просто потому, что скачан он был раньше всех.
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return path;
    }

    const running = this.#inflight.get(name);
    if (running !== undefined) return running;

    const download = this.#download(name, storageKey, path).finally(() => {
      this.#inflight.delete(name);
    });
    this.#inflight.set(name, download);
    return download;
  }

  async #download(name: string, storageKey: string, path: string): Promise<string> {
    // Скачивание идёт во временное имя и переезжает под конечное одним
    // `rename`: иначе параллельная задача увидела бы полуфайл и отдала бы его
    // растеризатору как готовый документ.
    const staging = `${path}.${createHash('sha256')
      .update(`${name}:${String(process.pid)}:${String(Date.now())}`)
      .digest('hex')
      .slice(0, 16)}.part`;
    try {
      await this.#options.fetch(storageKey, staging);
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.#evict();
    return path;
  }

  async #prepare(): Promise<void> {
    if (this.#prepared) return;
    await mkdir(this.#options.dir, { recursive: true });
    this.#prepared = true;
  }

  /**
   * Вытеснение по объёму: самые давние — первыми, занятые — никогда.
   *
   * Кэш вырастает выше потолка ровно на размер занятых файлов, и это осознанно:
   * альтернатива — удалить документ из-под работающей задачи, то есть обменять
   * предсказуемый перерасход диска на невоспроизводимый отказ страницы.
   */
  async #evict(): Promise<void> {
    const names = await readdir(this.#options.dir).catch(() => [] as string[]);
    const entries: { path: string; name: string; size: number; atimeMs: number }[] = [];

    for (const name of names) {
      if (name.endsWith('.part')) continue;
      const path = join(this.#options.dir, name);
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isFile()) continue;
      entries.push({ path, name, size: info.size, atimeMs: info.mtimeMs });
    }

    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.#options.maxBytes) return;

    entries.sort((a, b) => a.atimeMs - b.atimeMs);
    for (const entry of entries) {
      if (total <= this.#options.maxBytes) break;
      if ((this.#leases.get(entry.name) ?? 0) > 0) continue;
      await rm(entry.path, { force: true }).catch(() => undefined);
      total -= entry.size;
    }
  }

  #pathOf(name: string): string {
    return join(this.#options.dir, name);
  }
}
