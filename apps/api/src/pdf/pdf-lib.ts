/**
 * Реализация `PdfToolkit` на pdf-lib — деградация вне production (ADR-0003).
 *
 * Используется в тестах, в разработке и на машинах без `qpdf`, и только для
 * файлов ниже порога: pdf-lib держит документ в heap целиком, поэтому крупный
 * комплект здесь обязан получить ПОНЯТНЫЙ отказ «нужен qpdf», а не падение по
 * памяти. Проверку порога делает `assertWithinLimits()` из `toolkit.ts` — одна
 * на обе реализации.
 *
 * ## Почему pdf-lib подаётся снаружи, а не импортируется
 *
 * `pdf-lib` объявлен зависимостью воркера (`apps/worker`), а не API: работа с
 * PDF идёт в фоновых задачах. Прямой `import 'pdf-lib'` в `apps/api` не
 * разрешается сборкой, поэтому модуль принимается аргументом, а его форма
 * описана структурными интерфейсами ниже. Побочная польза от этого решения
 * важнее вынужденности: реализация не привязана к версии библиотеки, а
 * `loadPdfLibModule()` проверяет форму на входе и падает с внятным текстом,
 * если библиотека не та.
 *
 * Обновление зависимостей — чужая зона (см. отчёт этапа): когда `pdf-lib`
 * появится в зависимостях того же воркспейса, `loadPdfLibModule()` сведётся
 * к обычному импорту, а всё остальное здесь останется неизменным.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  assertPageCountMatches,
  assertWithinLimits,
  PdfToolkitError,
  planWorkingPdf,
  PDF_LIB_MAX_INPUT_BYTES,
  PDF_LIB_MAX_TOTAL_BYTES,
  type BuildWorkingPdfInput,
  type BuildWorkingPdfResult,
  type ExtractPagesInput,
  type ExtractPagesResult,
  type PdfToolkit,
} from './toolkit.js';

// =====================================================================
// Форма pdf-lib, которой пользуется этот модуль
// =====================================================================

export interface PdfLibPageLike {
  getSize(): { readonly width: number; readonly height: number };
}

export interface PdfLibDocumentLike {
  getPageCount(): number;
  copyPages(source: PdfLibDocumentLike, indices: number[]): Promise<PdfLibPageLike[]>;
  addPage(page: PdfLibPageLike): PdfLibPageLike;
  save(options?: { useObjectStreams?: boolean }): Promise<Uint8Array>;
  setProducer(value: string): void;
  setCreator(value: string): void;
  setSubject(value: string): void;
  setCreationDate(value: Date): void;
  setModificationDate(value: Date): void;
}

export interface PdfLibModule {
  readonly PDFDocument: {
    create(options?: { updateMetadata?: boolean }): Promise<PdfLibDocumentLike>;
    load(
      input: Uint8Array,
      options?: { ignoreEncryption?: boolean; updateMetadata?: boolean },
    ): Promise<PdfLibDocumentLike>;
  };
}

const PDF_LIB_SPECIFIER = 'pdf-lib';

/**
 * Как загрузить модуль. Передаётся вызывающим, и это здесь главное.
 *
 * `import()` резолвит спецификатор относительно того файла, В КОТОРОМ он
 * написан, а не того, кто вызвал функцию. `pdf-lib` объявлен зависимостью
 * `apps/worker`, а не `apps/api`, поэтому `import('pdf-lib')`, написанный здесь,
 * при строгой раскладке pnpm не резолвится ВООБЩЕ — и деградация ADR-0003
 * падала бы при старте воркера с «pdf-lib недоступен» на машине, где pdf-lib
 * установлен. Проверено запуском: собранный `apps/api/dist` действительно не
 * находит пакет. Поэтому импорт обязан жить в модуле воркера, а сюда приходит
 * функцией.
 */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/**
 * Загрузка pdf-lib во время выполнения.
 *
 * Форма проверяется сразу: «нет библиотеки» и «библиотека не та» обязаны
 * различаться в тексте отказа, иначе разбираться придётся по стеку
 * `TypeError: undefined is not a function` из середины сборки комплекта.
 */
export async function loadPdfLibModule(
  importModule: ModuleImporter,
  specifier = PDF_LIB_SPECIFIER,
): Promise<PdfLibModule> {
  let loaded: unknown;
  try {
    loaded = await importModule(specifier);
  } catch (error) {
    throw new PdfToolkitError(
      'toolkit_unavailable',
      `pdf-lib недоступен (${specifier}): ${error instanceof Error ? error.message : 'ошибка загрузки'}`,
      { cause: error },
    );
  }
  return asPdfLibModule(loaded);
}

/** Проверка формы модуля с учётом CJS-обёртки (`module.default`). */
export function asPdfLibModule(loaded: unknown): PdfLibModule {
  const candidates: unknown[] = [loaded];
  if (typeof loaded === 'object' && loaded !== null && 'default' in loaded) {
    candidates.push((loaded as { default: unknown }).default);
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const document = (candidate as { PDFDocument?: unknown }).PDFDocument;
    if (typeof document !== 'object' && typeof document !== 'function') continue;
    const api = document as { create?: unknown; load?: unknown };
    if (typeof api.create === 'function' && typeof api.load === 'function') {
      return candidate as PdfLibModule;
    }
  }

  throw new PdfToolkitError(
    'toolkit_unavailable',
    'загруженный модуль не похож на pdf-lib: нет PDFDocument.create/PDFDocument.load',
  );
}

// =====================================================================
// Реализация
// =====================================================================

export interface PdfLibToolkitOptions {
  readonly maxInputBytes?: number;
  readonly maxTotalInputBytes?: number;
  /** Подставляется в тестах, чтобы метаданные производной копии были сравнимы. */
  readonly now?: () => Date;
}

export function createPdfLibToolkit(
  pdfLib: PdfLibModule,
  options: PdfLibToolkitOptions = {},
): PdfToolkit {
  const maxInputBytes = options.maxInputBytes ?? PDF_LIB_MAX_INPUT_BYTES;
  const maxTotalInputBytes = options.maxTotalInputBytes ?? PDF_LIB_MAX_TOTAL_BYTES;
  const now = options.now ?? ((): Date => new Date());

  const toolkit: PdfToolkit = {
    kind: 'pdf-lib',
    maxInputBytes,
    maxTotalInputBytes,

    async buildWorkingPdf(input: BuildWorkingPdfInput): Promise<BuildWorkingPdfResult> {
      const map = planWorkingPdf(input.parts);
      assertWithinLimits(toolkit, input.parts);

      const target = await pdfLib.PDFDocument.create({ updateMetadata: false });

      for (const part of input.parts) {
        // Документы загружаются по одному и ссылка на исходный не сохраняется:
        // после копирования страниц он становится мусором и может быть собран.
        // Загрузка всех файлов заранее удерживала бы в heap весь комплект.
        const bytes = await readFile(part.path);
        const source = await loadDocument(pdfLib, bytes, part.path);
        const pageCount = source.getPageCount();

        if (pageCount !== part.pageCount) {
          throw new PdfToolkitError(
            'build_failed',
            `у файла ${part.sourceFileId} ${pageCount} страниц, а карта построена ` +
              `по ${part.pageCount}: состав ревизии разошёлся с содержимым файла`,
          );
        }

        const indices = Array.from({ length: pageCount }, (_, index) => index);
        const copied = await target.copyPages(source, indices);
        for (const page of copied) target.addPage(page);
      }

      applyDerivedMetadata(target, input.derivedNote, now());
      await writeFile(input.outputPath, await target.save({ useObjectStreams: false }));
      assertPageCountMatches(map.length, target.getPageCount());

      return {
        pageCount: map.length,
        map,
        toolkit: 'pdf-lib',
        derivedNoteApplied: input.derivedNote !== undefined,
      };
    },

    async extractPages(input: ExtractPagesInput): Promise<ExtractPagesResult> {
      const bytes = await readFile(input.sourcePath);
      const source = await loadDocument(pdfLib, bytes, input.sourcePath);
      const total = source.getPageCount();

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

      const indices = Array.from(
        { length: input.lastPageIndex - input.firstPageIndex + 1 },
        (_, offset) => input.firstPageIndex + offset,
      );
      const target = await pdfLib.PDFDocument.create({ updateMetadata: false });
      const copied = await target.copyPages(source, indices);
      for (const page of copied) target.addPage(page);

      applyDerivedMetadata(target, input.derivedNote, now());
      await writeFile(input.outputPath, await target.save({ useObjectStreams: false }));

      return {
        pageCount: indices.length,
        toolkit: 'pdf-lib',
        derivedNoteApplied: input.derivedNote !== undefined,
      };
    },
  };

  return toolkit;
}

/**
 * Загрузка исходного документа.
 *
 * `ignoreEncryption` не включается: зашифрованный файл до сборки не доходит
 * (его отправляет в карантин `file.verify`), и если он всё же оказался здесь —
 * это дефект конвейера, который обязан быть виден отказом, а не обойдён.
 */
async function loadDocument(
  pdfLib: PdfLibModule,
  bytes: Uint8Array,
  path: string,
): Promise<PdfLibDocumentLike> {
  try {
    return await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new PdfToolkitError(
      'build_failed',
      `pdf-lib не смог прочитать ${path}: ${error instanceof Error ? error.message : 'ошибка разбора'}`,
      { cause: error },
    );
  }
}

/**
 * Отметка о производности в метаданных (§13).
 *
 * Нужна затем, что производная копия внешне неотличима от оригинала, а
 * встроенная подпись оригинала (если бы она была) к ней не относится. Отметка
 * в метаданных — вспомогательная: источник правды — флаг в БД, потому что
 * метаданные PDF любой редактор перепишет.
 */
function applyDerivedMetadata(
  document: PdfLibDocumentLike,
  note: string | undefined,
  timestamp: Date,
): void {
  if (note === undefined) return;
  document.setProducer(note);
  document.setCreator(note);
  document.setSubject(note);
  document.setCreationDate(timestamp);
  document.setModificationDate(timestamp);
}
