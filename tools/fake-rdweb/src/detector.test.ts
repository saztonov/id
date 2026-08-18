/**
 * Детектор проверяется отдельно от HTTP: правило раскладки — это контракт данных,
 * и падать оно должно с указанием на страницу, а не на код ответа.
 *
 * Главный здесь — гейт S6: на пятидесяти страницах обязаны встретиться ВСЕ ТРИ типа
 * блока. Без него портал прошёл бы всю разработку на одних `text`-блоках и увидел бы
 * `image`/`stamp` впервые на боевых данных.
 */
import { describe, expect, it } from 'vitest';

import { detectPage, detectPages } from './detector.js';

const SEED = 'rd-web-fake';
const DOCUMENT_ID = 'doc_test';
const ALL_PAGES = Array.from({ length: 50 }, (_unused, index) => index);

describe('детерминированный детектор блоков', () => {
  it('на 50 страницах даёт все три типа блоков (гейт S6)', () => {
    const types = new Set(detectPages(SEED, DOCUMENT_ID, ALL_PAGES).map((b) => b.blockType));
    expect([...types].sort()).toEqual(['image', 'stamp', 'text']);
  });

  it('координаты нормированы: 0<=x0<=x1<=1 и 0<=y0<=y1<=1', () => {
    for (const block of detectPages(SEED, DOCUMENT_ID, ALL_PAGES)) {
      const [x0, y0, x1, y1] = block.coordsNorm;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1);
      expect(y1).toBeLessThanOrEqual(1);
      expect(x0).toBeLessThanOrEqual(x1);
      expect(y0).toBeLessThanOrEqual(y1);
    }
  });

  it('повторный вызов даёт побайтово тот же результат, а разные документы — разный', () => {
    expect(detectPages(SEED, DOCUMENT_ID, ALL_PAGES)).toEqual(
      detectPages(SEED, DOCUMENT_ID, ALL_PAGES),
    );
    const other = detectPages(SEED, 'doc_other', ALL_PAGES);
    expect(other).not.toEqual(detectPages(SEED, DOCUMENT_ID, ALL_PAGES));
  });

  it('текстовые блоки страницы не перекрываются по вертикали', () => {
    for (const pageIndex of ALL_PAGES) {
      const bands = detectPage(SEED, DOCUMENT_ID, pageIndex)
        .filter((b) => b.blockType === 'text' && b.coordsNorm[3] <= 0.9)
        .map((b) => [b.coordsNorm[1], b.coordsNorm[3]] as const)
        .sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < bands.length; i += 1) {
        const previous = bands[i - 1];
        const current = bands[i];
        if (previous === undefined || current === undefined) {
          continue;
        }
        expect(current[0]).toBeGreaterThanOrEqual(previous[1]);
      }
    }
  });

  it('каждая 17-я страница пуста, каждая 13-я даёт аномально мелкий блок', () => {
    expect(detectPage(SEED, DOCUMENT_ID, 16)).toHaveLength(0);
    expect(detectPage(SEED, DOCUMENT_ID, 33)).toHaveLength(0);

    const tiny = detectPage(SEED, DOCUMENT_ID, 12).filter((b) => {
      const [x0, y0, x1, y1] = b.coordsNorm;
      return (x1 - x0) * (y1 - y0) < 0.002;
    });
    expect(tiny).toHaveLength(1);
  });

  it('картинки и штампы появляются по своим периодам и не накладываются друг на друга', () => {
    expect(detectPage(SEED, DOCUMENT_ID, 6).some((b) => b.blockType === 'image')).toBe(true);
    expect(detectPage(SEED, DOCUMENT_ID, 10).some((b) => b.blockType === 'stamp')).toBe(true);

    for (const pageIndex of ALL_PAGES) {
      const page = detectPage(SEED, DOCUMENT_ID, pageIndex);
      const image = page.find((b) => b.blockType === 'image');
      const stamp = page.find((b) => b.blockType === 'stamp');
      if (image !== undefined && stamp !== undefined) {
        expect(image.coordsNorm[2]).toBeLessThan(stamp.coordsNorm[0]);
      }
    }
  });
});
