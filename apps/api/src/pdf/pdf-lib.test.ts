/**
 * Сборка рабочего PDF проверяется на НАСТОЯЩЕЙ библиотеке и настоящих файлах.
 *
 * Результат сборки перечитывается собственным разбором (`probe.ts`): так
 * проверяется не «функция вернула объект», а то, что в получившемся документе
 * действительно столько страниц, сколько обещает карта, и что повороты страниц
 * дошли до рабочего документа — от них зависят координаты разметки (§7.1).
 *
 * ## Почему pdf-lib резолвится вручную
 *
 * `pdf-lib` объявлен зависимостью воркспейса воркера, а не API (там и живут
 * фоновые задачи). Реализация принимает модуль аргументом именно поэтому, а
 * тест находит его через `createRequire` от package.json того воркспейса, где
 * он объявлен. Если библиотека не найдена, набор пропускается с явной
 * причиной, а не «зеленеет» молча.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asPdfLibModule, createPdfLibToolkit, type PdfLibModule } from './pdf-lib.js';
import { probePdf } from './probe.js';
import { isPdfToolkitError, type PdfToolkit, type WorkingPdfPart } from './toolkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'tools', 'fixtures', 'pdf');

/** Воркспейсы, объявившие pdf-lib; порядок значения не имеет. */
const PDF_LIB_HOSTS = ['apps/worker', 'tools/fixtures'];

function resolvePdfLib(): string | null {
  for (const host of PDF_LIB_HOSTS) {
    try {
      const require = createRequire(pathToFileURL(join(REPO_ROOT, host, 'package.json')).href);
      return require.resolve('pdf-lib');
    } catch {
      continue;
    }
  }
  return null;
}

const PDF_LIB_PATH = resolvePdfLib();

/** Часть pdf-lib, которая нужна только тесту: чтение записанных метаданных. */
interface MetadataReader {
  readonly PDFDocument: {
    load(
      bytes: Uint8Array,
      options: { updateMetadata: boolean },
    ): Promise<{ getProducer(): string | undefined }>;
  };
}

function fixturePart(name: string, pageCount: number): WorkingPdfPart {
  const path = join(FIXTURES_DIR, `${name}.pdf`);
  return {
    sourceFileId: name,
    path,
    byteSize: readFileSync(path).byteLength,
    pageCount,
  };
}

let toolkit: PdfToolkit;
let workDir: string;

describe.skipIf(PDF_LIB_PATH === null)('createPdfLibToolkit на настоящем pdf-lib', () => {
  beforeAll(async () => {
    const loaded: unknown = await import(pathToFileURL(PDF_LIB_PATH ?? '').href);
    const pdfLib: PdfLibModule = asPdfLibModule(loaded);
    toolkit = createPdfLibToolkit(pdfLib, { now: () => new Date(Date.UTC(2026, 0, 1)) });
    workDir = await mkdtemp(join(tmpdir(), 'id-pdf-lib-'));
  });

  afterAll(async () => {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  });

  it('multipage + single-1..3 дают рабочий документ из семи страниц с верной картой', async () => {
    const parts = [
      fixturePart('multipage', 4),
      fixturePart('single-1', 1),
      fixturePart('single-2', 1),
      fixturePart('single-3', 1),
    ];
    const outputPath = join(workDir, 'working.pdf');

    const result = await toolkit.buildWorkingPdf({ parts, outputPath });

    expect(result.pageCount).toBe(7);
    expect(result.toolkit).toBe('pdf-lib');
    expect(result.map).toHaveLength(7);

    // Любая страница рабочего PDF однозначно отображается на файл и его
    // страницу — иначе результат распознавания не связать с оригиналом (§3.3).
    expect(result.map[0]).toEqual({
      workingPageIndex: 0,
      sourceFileId: 'multipage',
      filePageIndex: 0,
    });
    expect(result.map[3]).toEqual({
      workingPageIndex: 3,
      sourceFileId: 'multipage',
      filePageIndex: 3,
    });
    expect(result.map[4]).toEqual({
      workingPageIndex: 4,
      sourceFileId: 'single-1',
      filePageIndex: 0,
    });
    expect(result.map[6]).toEqual({
      workingPageIndex: 6,
      sourceFileId: 'single-3',
      filePageIndex: 0,
    });

    // Проверка не по обещанию функции, а по получившемуся файлу.
    const probe = probePdf(readFileSync(outputPath));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pageCount).toBe(7);
    expect(probe.signature.result).toBe('none_detected');
  });

  it('повороты страниц доходят до рабочего документа', async () => {
    const outputPath = join(workDir, 'rotated-working.pdf');
    const parts = [fixturePart('rotated', 4), fixturePart('single-1', 1)];

    const result = await toolkit.buildWorkingPdf({ parts, outputPath });
    expect(result.pageCount).toBe(5);

    const probe = probePdf(readFileSync(outputPath));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pages.map((page) => page.rotation)).toEqual([0, 90, 180, 270, 0]);
    // Разные форматы страниц тоже сохраняются: A3 внутри комплекта из A4.
    const heights = new Set(probe.pages.map((page) => Math.round(page.heightPt)));
    expect(heights.size).toBeGreaterThan(1);
  });

  it('расхождение числа страниц с составом ревизии — отказ, а не подгонка карты', async () => {
    const parts = [{ ...fixturePart('multipage', 4), pageCount: 3 }];

    try {
      await toolkit.buildWorkingPdf({ parts, outputPath: join(workDir, 'mismatch.pdf') });
      expect.unreachable('ожидался отказ по расхождению числа страниц');
    } catch (error) {
      expect(isPdfToolkitError(error)).toBe(true);
      if (!isPdfToolkitError(error)) return;
      expect(error.code).toBe('build_failed');
      expect(error.message).toContain('разошёлся с содержимым файла');
    }
  });

  it('файл крупнее порога деградации не собирается вовсе', async () => {
    const small = createPdfLibToolkit(
      asPdfLibModule(await import(pathToFileURL(PDF_LIB_PATH ?? '').href)),
      {
        maxInputBytes: 512,
        maxTotalInputBytes: 512,
      },
    );

    await expect(
      small.buildWorkingPdf({
        parts: [fixturePart('multipage', 4)],
        outputPath: join(workDir, 'too-large.pdf'),
      }),
    ).rejects.toThrow(/нужен qpdf/);
  });

  it('нарезка отдаёт запрошенный диапазон и помечает копию производной', async () => {
    const outputPath = join(workDir, 'slice.pdf');
    const note = 'Производная копия портала ИД';

    const result = await toolkit.extractPages({
      sourcePath: join(FIXTURES_DIR, 'multipage.pdf'),
      outputPath,
      firstPageIndex: 1,
      lastPageIndex: 2,
      derivedNote: note,
    });

    expect(result.pageCount).toBe(2);
    expect(result.derivedNoteApplied).toBe(true);

    const probe = probePdf(readFileSync(outputPath));
    expect(probe.ok && probe.pageCount).toBe(2);

    // Отметка о производности обязана быть в метаданных файла (§13), а не
    // только в базе: файл живёт и вне портала.
    //
    // `updateMetadata: false` при перечитывании обязателен: pdf-lib по
    // умолчанию переписывает /Producer и /ModDate ПРИ ЗАГРУЗКЕ, и без этого
    // флага тест сравнивал бы отметку не с той, что записана в файл, а с той,
    // что подставил читатель. По той же причине флаг стоит и в реализации.
    const loaded: unknown = await import(pathToFileURL(PDF_LIB_PATH ?? '').href);
    const reader = asPdfLibModule(loaded) as unknown as MetadataReader;
    const reopened = await reader.PDFDocument.load(readFileSync(outputPath), {
      updateMetadata: false,
    });
    expect(reopened.getProducer()).toBe(note);
  });

  it('диапазон за пределами документа отвергается', async () => {
    await expect(
      toolkit.extractPages({
        sourcePath: join(FIXTURES_DIR, 'multipage.pdf'),
        outputPath: join(workDir, 'bad-range.pdf'),
        firstPageIndex: 2,
        lastPageIndex: 9,
      }),
    ).rejects.toThrow(/выходит за пределы/);
  });
});

describe('asPdfLibModule', () => {
  it('чужой модуль отвергается с внятным текстом', () => {
    expect(() => asPdfLibModule({ something: 'else' })).toThrow(/не похож на pdf-lib/);
  });

  it('CJS-обёртка с default разворачивается', () => {
    const fake = { default: { PDFDocument: { create: () => null, load: () => null } } };
    expect(() => asPdfLibModule(fake)).not.toThrow();
  });
});
