/**
 * Растеризатор на внешнем `pdftoppm` (poppler-utils) — боевой (ADR-0008).
 *
 * Тот же класс решения, что qpdf в ADR-0003: промышленный потоковый инструмент,
 * ставится пакетным менеджером в образ воркера, вызывается без оболочки.
 * Рендер шрифтов и сканов у poppler заметно надёжнее любых JS-примитивов, а
 * детектор обучен на ~300 DPI PNG — качество рендера здесь не косметика,
 * а вход модели.
 *
 * ## Что проверяемо на машине разработки
 *
 * Как и с qpdf: бинарника может не быть, поэтому тестами закрыты обнаружение,
 * состав аргументов и разбор кодов возврата; живой рендер — гейт приёмки на
 * целевой машине. Интеграционные тесты задач используют тестовый двойник порта.
 */
import { spawn } from 'node:child_process';
import { rename } from 'node:fs/promises';
import {
  RasterizerError,
  readPngSize,
  type PageRasterizer,
  type RenderPageInput,
  type RenderPageResult,
} from './raster.js';

export const DEFAULT_PDFTOPPM_BINARY = 'pdftoppm';

const DETECT_TIMEOUT_MS = 5000;
/** Рендер одной страницы 300 DPI обязан укладываться с запасом. */
const RENDER_TIMEOUT_MS = 120_000;

interface RunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Запуск без оболочки — аргументы массивом, как в qpdf.ts (инъекция невозможна). */
function run(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal | undefined,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    // Отменённую попытку не начинаем вовсе: процесс, запущенный для того, кто
    // его уже не ждёт, — это чистая трата ядра на перегруженной машине.
    if (signal?.aborted === true) {
      reject(
        signal.reason instanceof Error ? signal.reason : new RasterizerError('рендер отменён'),
      );
      return;
    }

    const child = spawn(binary, [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      detachAbort();
      child.kill('SIGKILL');
      reject(new RasterizerError(`pdftoppm не завершился за ${timeoutMs} мс и был снят`));
    }, timeoutMs);
    timer.unref?.();

    /**
     * Отмена попытки снимает процесс сразу (S41).
     *
     * SIGKILL, а не SIGTERM: poppler на большом листе не проверяет сигналы, пока
     * не закончит страницу, и мягкая просьба означала бы те же десятки секунд
     * занятого ядра. Наружу отдаётся причина отмены, поставленная движком задач
     * (`JobTimeout`, `LeaseLost`), — подменять её на «рендер не удался» нельзя:
     * разбор ушёл бы к poppler вместо настоящей причины.
     */
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new RasterizerError('рендер отменён'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const detachAbort = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbort();
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbort();
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface PdftoppmDetection {
  readonly available: boolean;
  readonly version: string | null;
  readonly binary: string;
  readonly error: string | null;
}

/**
 * Проба бинарника при старте. Не бросает: решение «работать без растеризатора
 * или нет» принимает selectRasterizer/старт воркера, а не факт наличия файла.
 *
 * `pdftoppm -v` пишет версию в stderr («pdftoppm version 24.02.0») и выходит
 * нулём — это его штатное поведение, а не ошибка.
 */
export async function detectPdftoppm(binary = DEFAULT_PDFTOPPM_BINARY): Promise<PdftoppmDetection> {
  try {
    const outcome = await run(binary, ['-v'], DETECT_TIMEOUT_MS);
    if (outcome.code !== 0) {
      return {
        available: false,
        version: null,
        binary,
        error: `pdftoppm -v завершился с кодом ${outcome.code}`,
      };
    }
    const match = /pdftoppm version ([^\s]+)/iu.exec(outcome.stderr + outcome.stdout);
    return { available: true, version: match?.[1] ?? null, binary, error: null };
  } catch (error) {
    return {
      available: false,
      version: null,
      binary,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Аргументы рендера одной страницы. Вынесено из renderPage ради теста:
 * состав аргументов проверяем и без бинарника (паттерн qpdf.ts).
 *
 * `-singlefile` заставляет писать ровно `{prefix}.png` без суффикса номера
 * страницы — имя выхода детерминировано. `-f/-l` у poppler 1-базные.
 */
export function pdftoppmArgs(input: RenderPageInput, outPrefix: string): string[] {
  const page = input.pageIndex + 1;
  return [
    '-f',
    String(page),
    '-l',
    String(page),
    '-r',
    String(input.dpi),
    '-png',
    '-singlefile',
    input.pdfPath,
    outPrefix,
  ];
}

export class PdftoppmRasterizer implements PageRasterizer {
  readonly kind = 'pdftoppm' as const;
  readonly version: string | null;
  readonly #binary: string;

  constructor(options: { readonly binary: string; readonly version: string | null }) {
    this.#binary = options.binary;
    this.version = options.version;
  }

  async renderPage(input: RenderPageInput): Promise<RenderPageResult> {
    if (!Number.isInteger(input.pageIndex) || input.pageIndex < 0) {
      throw new RasterizerError('Индекс страницы обязан быть неотрицательным целым');
    }
    if (!Number.isInteger(input.dpi) || input.dpi <= 0) {
      throw new RasterizerError('DPI обязан быть положительным целым');
    }
    // pdftoppm дописывает расширение сам; ему отдаётся префикс без «.png».
    const outPrefix = input.outPath.endsWith('.png') ? input.outPath.slice(0, -4) : input.outPath;
    const outcome = await run(
      this.#binary,
      pdftoppmArgs(input, outPrefix),
      RENDER_TIMEOUT_MS,
      input.signal,
    );
    if (outcome.code !== 0) {
      // stderr уходит в диагностику как есть: poppler не печатает содержимое
      // документа, только структурные жалобы («Syntax Error: …»).
      throw new RasterizerError(
        `pdftoppm завершился с кодом ${outcome.code}: ${outcome.stderr.slice(0, 500)}`,
      );
    }
    // При outPath без .png poppler всё равно написал `{prefix}.png` — приводим
    // имя к заказанному, чтобы вызывающий не знал про эту особенность.
    const produced = `${outPrefix}.png`;
    if (produced !== input.outPath) {
      await rename(produced, input.outPath);
    }
    return readPngSize(input.outPath);
  }
}

export interface SelectRasterizerOptions {
  readonly binary?: string | undefined;
}

/**
 * Выбор растеризатора при старте воркера (паттерн selectPdfToolkit, ADR-0003).
 *
 * `null` — растеризации нет: воркер поднимается с warning, а задачи локальной
 * детекции и VLM-распознавания отказывают с внятным классом ошибки. Падать
 * процессом нельзя: обе новые ветки — опциональные настройки, и портал с
 * `detection.provider=rdweb` обязан работать без poppler.
 */
export async function selectRasterizer(
  options: SelectRasterizerOptions = {},
): Promise<PageRasterizer | null> {
  const binary = options.binary ?? DEFAULT_PDFTOPPM_BINARY;
  const detection = await detectPdftoppm(binary);
  if (detection.available) {
    return new PdftoppmRasterizer({ binary, version: detection.version });
  }
  return null;
}
