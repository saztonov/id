/**
 * Правила выбора реализации и построения карты страниц (ADR-0003).
 *
 * Проба `qpdf` здесь подменяется: поведение обязано быть одинаковым на машине
 * с бинарником и без него, а тест, зависящий от того, что установлено на
 * агенте, проверял бы окружение, а не решение. Отдельным тестом проверяется
 * настоящая `detectQpdf()` — но только на том, что она отвечает, а не падает.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildArgs, detectQpdf, extractArgs } from './qpdf.js';
import {
  assertWithinLimits,
  isPdfToolkitError,
  PdfToolkitError,
  planWorkingPdf,
  selectPdfToolkit,
  type PdfToolkit,
  type QpdfDetection,
  type WorkingPdfPart,
} from './toolkit.js';

function part(id: string, pageCount: number, byteSize = 1024): WorkingPdfPart {
  return { sourceFileId: id, path: `/tmp/${id}.pdf`, byteSize, pageCount };
}

function stubToolkit(kind: 'qpdf' | 'pdf-lib', limits: Partial<PdfToolkit> = {}): PdfToolkit {
  return {
    kind,
    maxInputBytes: null,
    maxTotalInputBytes: null,
    buildWorkingPdf: () => Promise.reject(new Error('не вызывается в этом тесте')),
    extractPages: () => Promise.reject(new Error('не вызывается в этом тесте')),
    ...limits,
  };
}

const PRESENT: QpdfDetection = {
  available: true,
  version: '11.9.0',
  binary: 'qpdf',
  error: null,
};
const ABSENT: QpdfDetection = {
  available: false,
  version: null,
  binary: 'qpdf',
  error: 'spawn qpdf ENOENT',
};

describe('planWorkingPdf', () => {
  it('нумерует страницы сквозь все файлы в заданном порядке', () => {
    const map = planWorkingPdf([part('f1', 4), part('f2', 1), part('f3', 2)]);

    expect(map).toHaveLength(7);
    expect(map.map((entry) => entry.workingPageIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(map[3]).toEqual({ workingPageIndex: 3, sourceFileId: 'f1', filePageIndex: 3 });
    expect(map[4]).toEqual({ workingPageIndex: 4, sourceFileId: 'f2', filePageIndex: 0 });
    expect(map[6]).toEqual({ workingPageIndex: 6, sourceFileId: 'f3', filePageIndex: 1 });
  });

  it('порядок файлов меняет карту, а не только имя файла', () => {
    const straight = planWorkingPdf([part('f1', 2), part('f2', 2)]);
    const reversed = planWorkingPdf([part('f2', 2), part('f1', 2)]);

    expect(straight[0]?.sourceFileId).toBe('f1');
    expect(reversed[0]?.sourceFileId).toBe('f2');
  });

  it('пустой состав, файл без страниц и повтор файла отвергаются', () => {
    expect(() => planWorkingPdf([])).toThrow(PdfToolkitError);
    expect(() => planWorkingPdf([part('f1', 0)])).toThrow(/не задано число страниц/);
    expect(() => planWorkingPdf([part('f1', 1), part('f1', 2)])).toThrow(/дважды/);
  });
});

describe('пределы деградации', () => {
  it('файл крупнее порога получает понятный отказ, а не падение по памяти', () => {
    const toolkit = stubToolkit('pdf-lib', {
      maxInputBytes: 20 * 1024 * 1024,
      maxTotalInputBytes: 80 * 1024 * 1024,
    });

    try {
      assertWithinLimits(toolkit, [part('big', 10, 30 * 1024 * 1024)]);
      expect.unreachable('ожидался отказ по размеру файла');
    } catch (error) {
      expect(isPdfToolkitError(error)).toBe(true);
      if (!isPdfToolkitError(error)) return;
      expect(error.code).toBe('input_too_large');
      expect(error.message).toContain('нужен qpdf');
    }
  });

  it('суммарный размер комплекта ограничен отдельно от размера файла', () => {
    const toolkit = stubToolkit('pdf-lib', {
      maxInputBytes: 20 * 1024 * 1024,
      maxTotalInputBytes: 30 * 1024 * 1024,
    });
    const parts = [part('a', 1, 19 * 1024 * 1024), part('b', 1, 19 * 1024 * 1024)];

    // Каждый файл по отдельности проходит — вместе они не проходят.
    expect(() => assertWithinLimits(toolkit, parts)).toThrow(/суммарный размер/);
  });

  it('у qpdf ограничений по размеру нет', () => {
    expect(() =>
      assertWithinLimits(stubToolkit('qpdf'), [part('huge', 500, 900 * 1024 * 1024)]),
    ).not.toThrow();
  });
});

describe('selectPdfToolkit', () => {
  it('qpdf найден — используется он, независимо от окружения', async () => {
    const createFallbackToolkit = vi.fn(() => Promise.resolve(stubToolkit('pdf-lib')));
    const selection = await selectPdfToolkit({
      nodeEnv: 'development',
      detectQpdf: () => Promise.resolve(PRESENT),
      createQpdfToolkit: () => stubToolkit('qpdf'),
      createFallbackToolkit,
    });

    expect(selection.toolkit.kind).toBe('qpdf');
    expect(selection.degraded).toBe(false);
    expect(createFallbackToolkit).not.toHaveBeenCalled();
  });

  it('в production отсутствие qpdf ВАЛИТ запуск', async () => {
    const createFallbackToolkit = vi.fn(() => Promise.resolve(stubToolkit('pdf-lib')));

    await expect(
      selectPdfToolkit({
        nodeEnv: 'production',
        detectQpdf: () => Promise.resolve(ABSENT),
        createQpdfToolkit: () => stubToolkit('qpdf'),
        createFallbackToolkit,
      }),
    ).rejects.toThrow(/qpdf не найден/);

    // Ключевое: деградации не произошло даже как побочного эффекта.
    expect(createFallbackToolkit).not.toHaveBeenCalled();
  });

  it('вне production отсутствие qpdf даёт деградацию с предупреждением', async () => {
    const warn = vi.fn();
    const selection = await selectPdfToolkit({
      nodeEnv: 'test',
      detectQpdf: () => Promise.resolve(ABSENT),
      createQpdfToolkit: () => stubToolkit('qpdf'),
      createFallbackToolkit: () =>
        Promise.resolve(stubToolkit('pdf-lib', { maxInputBytes: 1024, maxTotalInputBytes: 4096 })),
      logger: { info: vi.fn(), warn } as unknown as Parameters<
        typeof selectPdfToolkit
      >[0]['logger'],
    });

    expect(selection.toolkit.kind).toBe('pdf-lib');
    expect(selection.degraded).toBe(true);
    expect(selection.toolkit.maxInputBytes).toBe(1024);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('аргументы qpdf', () => {
  it('склейка перечисляет файлы по порядку и берёт все страницы каждого', () => {
    const args = buildArgs({
      parts: [part('f1', 4), part('f2', 1)],
      outputPath: '/tmp/out.pdf',
    });

    expect(args).toEqual([
      '--empty',
      '--deterministic-id',
      '--pages',
      '/tmp/f1.pdf',
      '1-z',
      '/tmp/f2.pdf',
      '1-z',
      '--',
      '/tmp/out.pdf',
    ]);
  });

  it('нарезка переводит 0-based границы в 1-based диапазон qpdf', () => {
    const args = extractArgs({
      sourcePath: '/tmp/in.pdf',
      outputPath: '/tmp/out.pdf',
      firstPageIndex: 0,
      lastPageIndex: 2,
    });

    expect(args).toContain('1-3');
  });

  it('detectQpdf не бросает и честно отвечает о наличии бинарника', async () => {
    // На машине разработки qpdf отсутствует (ADR-0003), в образе воркера он
    // есть. Тест проверяет форму ответа, а не состояние конкретной машины.
    const detection = await detectQpdf('qpdf-которого-точно-нет');

    expect(detection.available).toBe(false);
    expect(detection.error).not.toBeNull();
  });
});
