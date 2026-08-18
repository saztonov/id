/**
 * Реализация `PdfToolkit` на внешнем `qpdf` — боевая (ADR-0003).
 *
 * `qpdf` работает потоково: он не разбирает документ в объектную модель целиком
 * и не перекодирует сканы, поэтому склейка 86 МБ комплекта стоит постоянной
 * памяти и сохраняет качество изображений. Это единственная реализация,
 * которой разрешены файлы крупнее порога деградации.
 *
 * ## Что здесь проверяемо на машине разработки, а что нет
 *
 * Бинарника на этой машине нет (ADR-0003), поэтому проверены: обнаружение
 * (`detectQpdf()` честно отвечает «нет»), состав аргументов и разбор кодов
 * возврата. Само выполнение склейки и нарезки на реальных файлах — открытый
 * гейт §16, закрывается на S12 вместе с целевой VPS. Это зафиксированный долг,
 * а не забытая проверка.
 *
 * ## Коды возврата
 *
 * `qpdf` различает ошибку (2) и предупреждение (3). Предупреждение означает
 * «файл нестандартен, но обработан» — типичная ситуация для сканов из систем
 * ЭДО, и считать её отказом значило бы отвергать половину реального корпуса.
 * Поэтому 3 — это успех с записью в журнал, а не провал.
 */
import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { buildDerivedNotePdf, verifyDerivedNote } from './derived-note.js';
import {
  assertPageCountMatches,
  assertWithinLimits,
  PdfToolkitError,
  planWorkingPdf,
  type BuildWorkingPdfInput,
  type BuildWorkingPdfResult,
  type ExtractPagesInput,
  type ExtractPagesResult,
  type PdfToolkit,
  type QpdfDetection,
} from './toolkit.js';

export const DEFAULT_QPDF_BINARY = 'qpdf';

/** Успех и «успех с предупреждениями»: см. заголовок файла. */
const EXIT_OK = 0;
const EXIT_WARNINGS = 3;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DETECT_TIMEOUT_MS = 5000;

interface RunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Запуск бинарника без оболочки.
 *
 * Аргументы передаются массивом: имена файлов приходят из хранилища и из
 * пользовательского ввода, и любая форма конкатенации в командную строку была
 * бы инъекцией. Оболочка не используется вовсе — ни `shell: true`, ни строковая
 * команда.
 */
function run(binary: string, args: readonly string[], timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(
        new PdfToolkitError('build_failed', `qpdf не завершился за ${timeoutMs} мс и был снят`),
      );
    }, timeoutMs);
    timer.unref?.();

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
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Проба бинарника при старте процесса.
 *
 * Не бросает: решение «падать или деградировать» принимает
 * `selectPdfToolkit()`, потому что оно зависит от окружения, а не от факта
 * наличия файла.
 */
export async function detectQpdf(binary = DEFAULT_QPDF_BINARY): Promise<QpdfDetection> {
  try {
    const outcome = await run(binary, ['--version'], DETECT_TIMEOUT_MS);
    if (outcome.code !== EXIT_OK) {
      return {
        available: false,
        version: null,
        binary,
        error: `qpdf --version завершился с кодом ${outcome.code}`,
      };
    }
    const version = /qpdf version ([\d.]+)/i.exec(outcome.stdout)?.[1] ?? null;
    return { available: true, version, binary, error: null };
  } catch (error) {
    return {
      available: false,
      version: null,
      binary,
      error: error instanceof Error ? error.message : 'не удалось запустить qpdf',
    };
  }
}

export interface QpdfToolkitOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  /** Журнал предупреждений qpdf: файл обработан, но нестандартен. */
  readonly onWarning?: (message: string) => void;
}

export function createQpdfToolkit(options: QpdfToolkitOptions = {}): PdfToolkit {
  const binary = options.binary ?? DEFAULT_QPDF_BINARY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const execute = async (args: readonly string[], what: string): Promise<void> => {
    let outcome: RunOutcome;
    try {
      outcome = await run(binary, args, timeoutMs);
    } catch (error) {
      if (error instanceof PdfToolkitError) throw error;
      throw new PdfToolkitError(
        'build_failed',
        `не удалось запустить qpdf (${binary}): ${error instanceof Error ? error.message : 'ошибка запуска'}`,
        { cause: error },
      );
    }

    if (outcome.code === EXIT_WARNINGS) {
      options.onWarning?.(outcome.stderr.trim());
      return;
    }
    if (outcome.code !== EXIT_OK) {
      // Текст qpdf содержит имена файлов, то есть временные пути, но не
      // содержимое документов; он и нужен для разбора отказа.
      throw new PdfToolkitError(
        'build_failed',
        `${what} не выполнена: qpdf завершился с кодом ${outcome.code}. ${outcome.stderr.trim()}`,
      );
    }
  };

  const countPages = async (path: string): Promise<number> => {
    const outcome = await run(binary, ['--show-npages', path], timeoutMs);
    const pages = Number.parseInt(outcome.stdout.trim(), 10);
    if (outcome.code !== EXIT_OK && outcome.code !== EXIT_WARNINGS) {
      throw new PdfToolkitError(
        'build_failed',
        `qpdf не смог сосчитать страницы ${path}: код ${outcome.code}. ${outcome.stderr.trim()}`,
      );
    }
    if (!Number.isSafeInteger(pages) || pages <= 0) {
      throw new PdfToolkitError(
        'build_failed',
        `qpdf вернул нечитаемое число страниц для ${path}: «${outcome.stdout.trim()}»`,
      );
    }
    return pages;
  };

  /**
   * Первичный вход qpdf: либо `--empty`, либо шаблон с отметкой (§13).
   *
   * Шаблон живёт ровно на время вызова и удаляется в `finally`: временный файл
   * рядом с выходом на очереди `cpu` — это тот же класс мусора, что оставляла
   * неудачная сборка bundle на S5.
   */
  const withPrimaryInput = async <T>(
    outputPath: string,
    note: string | undefined,
    run: (primary: readonly string[]) => Promise<T>,
  ): Promise<T> => {
    if (note === undefined) return run(['--empty']);

    const templatePath = `${outputPath}.derived-note.pdf`;
    await writeFile(templatePath, buildDerivedNotePdf(note));
    try {
      return await run([templatePath]);
    } finally {
      await rm(templatePath, { force: true });
    }
  };

  const toolkit: PdfToolkit = {
    kind: 'qpdf',
    // Ради этого qpdf и нужен: ограничения по размеру у боевой реализации нет.
    maxInputBytes: null,
    maxTotalInputBytes: null,

    async buildWorkingPdf(input: BuildWorkingPdfInput): Promise<BuildWorkingPdfResult> {
      const map = planWorkingPdf(input.parts);
      assertWithinLimits(toolkit, input.parts);

      await withPrimaryInput(input.outputPath, input.derivedNote, (primary) =>
        execute(buildArgs(input, primary), 'сборка рабочего PDF'),
      );
      assertPageCountMatches(map.length, await countPages(input.outputPath));

      return {
        pageCount: map.length,
        map,
        toolkit: 'qpdf',
        derivedNoteApplied:
          input.derivedNote !== undefined &&
          (await verifyDerivedNote(input.outputPath, input.derivedNote)),
      };
    },

    async extractPages(input: ExtractPagesInput): Promise<ExtractPagesResult> {
      const total = await countPages(input.sourcePath);
      if (
        !Number.isSafeInteger(input.firstPageIndex) ||
        !Number.isSafeInteger(input.lastPageIndex) ||
        input.firstPageIndex < 0 ||
        input.lastPageIndex < input.firstPageIndex ||
        input.lastPageIndex >= total
      ) {
        throw new PdfToolkitError(
          'invalid_input',
          `диапазон страниц ${input.firstPageIndex}..${input.lastPageIndex} выходит ` +
            `за пределы документа из ${total} страниц`,
        );
      }

      await withPrimaryInput(input.outputPath, input.derivedNote, (primary) =>
        execute(extractArgs(input, primary), 'нарезка документа'),
      );
      const produced = input.lastPageIndex - input.firstPageIndex + 1;
      assertPageCountMatches(produced, await countPages(input.outputPath));

      return {
        pageCount: produced,
        toolkit: 'qpdf',
        derivedNoteApplied:
          input.derivedNote !== undefined &&
          (await verifyDerivedNote(input.outputPath, input.derivedNote)),
      };
    },
  };

  return toolkit;
}

// =====================================================================
// Аргументы командной строки
// =====================================================================

/**
 * `qpdf <первичный вход> --deterministic-id --pages f1 1-z f2 1-z -- out.pdf`.
 *
 * `--deterministic-id` заменяет случайный `/ID` хэшем содержимого: одинаковый
 * состав даёт побайтово одинаковый рабочий PDF, а значит тот же SHA-256 и ту же
 * запись в `stored_blobs`. Без него повторная сборка того же состава плодила бы
 * копии одного документа под разными хэшами.
 *
 * Первичный вход приходит аргументом, а не пишется здесь: `--empty` означает
 * «никаких document-level данных», а шаблон с `/Info` — «отметка о
 * производности» (§13, `derived-note.ts`). Страницы в обоих случаях берутся
 * только из спецификаций `--pages`.
 *
 * Экспортируется ради проверки состава аргументов: выполнить qpdf на машине
 * разработки нельзя, а вот убедиться, что диапазоны и порядок файлов собраны
 * верно, — можно и нужно.
 */
export function buildArgs(
  input: BuildWorkingPdfInput,
  primary: readonly string[] = ['--empty'],
): readonly string[] {
  const args = [...primary, '--deterministic-id', '--pages'];
  for (const part of input.parts) {
    args.push(part.path, '1-z');
  }
  args.push('--', input.outputPath);
  return args;
}

/** Диапазон qpdf задаётся 1-based и включительно с обеих сторон. */
export function extractArgs(
  input: ExtractPagesInput,
  primary: readonly string[] = ['--empty'],
): readonly string[] {
  return [
    ...primary,
    '--deterministic-id',
    '--pages',
    input.sourcePath,
    `${input.firstPageIndex + 1}-${input.lastPageIndex + 1}`,
    '--',
    input.outputPath,
  ];
}
