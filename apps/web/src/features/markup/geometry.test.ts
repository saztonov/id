/**
 * Пересчёт координат, в том числе при `rotation != 0` (гейт §17, строка S11).
 *
 * Тест намеренно не ограничивается арифметикой на выдуманных числах. Главное
 * утверждение этапа — «пересчёт сводится к умножению на размер отрисованной
 * страницы» — держится на том, что ТРИ фрейма совпадают: пост-поворотная
 * геометрия, записанная порталом в `source_pages`, координаты RD WEB и вьюпорт
 * pdf.js. Проверить это можно только настоящим pdf.js на настоящем PDF с
 * поворотами, поэтому здесь открывается фикстура `rotated.pdf` (страницы 0, 90,
 * 180, 270, последняя — A3 landscape) и сверяется с тем, что портал записал бы
 * в карту страниц.
 *
 * Без этого тест доказывал бы, что умножение — это умножение.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  areaOf,
  coordsToRect,
  fitInto,
  framesAgree,
  isDegenerate,
  normalizeCoords,
  rectToCoords,
  type RenderedSize,
} from './geometry.js';

const FIXTURE = fileURLToPath(
  new URL('../../../../../tools/fixtures/pdf/rotated.pdf', import.meta.url),
);

/**
 * Ожидаемые размеры страниц фикстуры В ПОСТ-ПОВОРОТНОМ фрейме.
 *
 * Считаны из генератора (`tools/fixtures/src/synthetic.ts`): A4 портрет для
 * первых трёх страниц и A3 landscape для четвёртой, повороты 0/90/180/270.
 * При повороте на 90 и 270 стороны меняются местами — ровно так же, как это
 * делает `geometryOf()` в `apps/api/src/pdf/probe.ts`.
 */
const EXPECTED_PAGES = [
  { rotation: 0, width: 595, height: 842 },
  { rotation: 90, width: 842, height: 595 },
  { rotation: 180, width: 595, height: 842 },
  { rotation: 270, width: 842, height: 1191 },
] as const;

interface ProbedPage {
  readonly rotation: number;
  readonly viewport: RenderedSize;
}

let probed: ProbedPage[] = [];

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;

  const document = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(FIXTURE)),
    // Те же ограничения, что и в браузере: см. `pdf/pdfjs.ts`. Здесь важно
    // именно `enableXfa: false` — форма XFA приводит движок форм в действие, а
    // геометрию страницы это заодно определяет иначе.
    enableXfa: false,
  }).promise;

  const pages: ProbedPage[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({
      rotation: page.rotate,
      viewport: { width: viewport.width, height: viewport.height },
    });
  }
  probed = pages;
}, 60_000);

describe('фрейм страницы при повороте', () => {
  it('pdf.js отдаёт вьюпорт уже с учётом /Rotate', () => {
    expect(probed).toHaveLength(EXPECTED_PAGES.length);
    for (const [index, expected] of EXPECTED_PAGES.entries()) {
      const actual = probed[index];
      expect(actual, `страница ${index}`).toBeDefined();
      expect(actual?.rotation, `поворот страницы ${index}`).toBe(expected.rotation);
      expect(Math.round(actual?.viewport.width ?? 0), `ширина страницы ${index}`).toBe(
        expected.width,
      );
      expect(Math.round(actual?.viewport.height ?? 0), `высота страницы ${index}`).toBe(
        expected.height,
      );
    }
  });

  it('карта страниц портала и вьюпорт pdf.js описывают один фрейм', () => {
    for (const [index, expected] of EXPECTED_PAGES.entries()) {
      const viewport = probed[index]?.viewport;
      expect(viewport).toBeDefined();
      if (viewport === undefined) continue;
      // `widthPx`/`heightPx` из карты страниц — это и есть `expected`:
      // репозиторий пишет их округлёнными и пост-поворотными.
      expect(framesAgree(expected, viewport), `страница ${index}`).toBe(true);
    }
  });

  it('перепутанный поворот ловится сравнением фреймов', () => {
    // Ровно тот отказ, ради которого сравнение и существует: вьюпорт снят до
    // применения /Rotate, а карта страниц — после.
    const preRotationViewport = { width: 595, height: 842 };
    expect(framesAgree({ width: 842, height: 595 }, preRotationViewport)).toBe(false);
  });
});

describe('нормализованные координаты и пиксели канвы', () => {
  it('на повёрнутой странице рамка ложится умножением, без разворота осей', () => {
    const viewport = probed[1]?.viewport;
    expect(viewport).toBeDefined();
    if (viewport === undefined) return;

    // Полоса вдоль верхнего края альбомной страницы: если бы код разворачивал
    // оси «на всякий случай», она уехала бы к боковой границе.
    const coords = { x0: 0.1, y0: 0, x1: 0.9, y1: 0.2 };
    const rect = coordsToRect(coords, viewport);

    expect(rect.x).toBeCloseTo(0.1 * viewport.width, 6);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.width).toBeCloseTo(0.8 * viewport.width, 6);
    expect(rect.height).toBeCloseTo(0.2 * viewport.height, 6);
    // Ширина полосы больше её высоты именно потому, что страница альбомная.
    expect(rect.width).toBeGreaterThan(rect.height);
  });

  it('обратное преобразование возвращает исходные доли на всех четырёх поворотах', () => {
    const coords = { x0: 0.125, y0: 0.25, x1: 0.75, y1: 0.875 };
    for (const [index] of EXPECTED_PAGES.entries()) {
      const viewport = probed[index]?.viewport;
      expect(viewport).toBeDefined();
      if (viewport === undefined) continue;
      const back = rectToCoords(coordsToRect(coords, viewport), viewport);
      expect(back.x0, `x0 страницы ${index}`).toBeCloseTo(coords.x0, 9);
      expect(back.y0, `y0 страницы ${index}`).toBeCloseTo(coords.y0, 9);
      expect(back.x1, `x1 страницы ${index}`).toBeCloseTo(coords.x1, 9);
      expect(back.y1, `y1 страницы ${index}`).toBeCloseTo(coords.y1, 9);
    }
  });

  it('масштаб не меняет нормализованные координаты', () => {
    const base = probed[3]?.viewport;
    expect(base).toBeDefined();
    if (base === undefined) return;
    const coords = { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.4 };
    const small = rectToCoords(coordsToRect(coords, base), base);
    const zoomed = { width: base.width * 2.5, height: base.height * 2.5 };
    const large = rectToCoords(coordsToRect(coords, zoomed), zoomed);
    expect(large.x0).toBeCloseTo(small.x0, 9);
    expect(large.y0).toBeCloseTo(small.y0, 9);
    expect(large.x1).toBeCloseTo(small.x1, 9);
    expect(large.y1).toBeCloseTo(small.y1, 9);
  });
});

describe('приведение координат', () => {
  it('рамка, растянутая вверх-влево, меняет границы местами, а не отвергается', () => {
    expect(normalizeCoords({ x0: 0.8, y0: 0.9, x1: 0.2, y1: 0.1 })).toEqual({
      x0: 0.2,
      y0: 0.1,
      x1: 0.8,
      y1: 0.9,
    });
  });

  it('выход за край страницы ограничивается диапазоном CHECK, а не даёт 422', () => {
    expect(normalizeCoords({ x0: -0.5, y0: -1, x1: 1.4, y1: 2 })).toEqual({
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
    });
  });

  it('вырожденность меряется в долях страницы, а не в пикселях канвы', () => {
    expect(isDegenerate({ x0: 0.5, y0: 0.5, x1: 0.5005, y1: 0.9 })).toBe(true);
    expect(isDegenerate({ x0: 0.5, y0: 0.5, x1: 0.55, y1: 0.9 })).toBe(false);
  });

  it('площадь считается по приведённым координатам', () => {
    expect(areaOf({ x0: 0.5, y0: 0.5, x1: 0.25, y1: 0.25 })).toBeCloseTo(0.0625, 9);
  });
});

describe('вписывание страницы в область', () => {
  it('страница целиком помещается и сохраняет пропорции', () => {
    const fitted = fitInto({ width: 842, height: 1191 }, { width: 600, height: 600 });
    expect(fitted.height).toBeCloseTo(600, 6);
    expect(fitted.width).toBeCloseTo((842 / 1191) * 600, 6);
  });

  it('вырожденный размер страницы не даёт NaN', () => {
    expect(fitInto({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({
      width: 0,
      height: 0,
    });
  });
});
