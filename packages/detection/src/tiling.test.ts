import { describe, expect, it } from 'vitest';

import {
  BLANK_TILE_STD_THRESHOLD,
  isBlankTile,
  pilGrayscaleLuma,
  planInferenceTiles,
  planPageTiles,
  remapRectToPage,
  wholePageTile,
} from './tiling.js';

describe('planInferenceTiles', () => {
  it('сетка 2×2 с overlap: последняя плитка выровнена к краю', () => {
    // step = 1024-128 = 896; origins X/Y: [0, 776] (776 = 1800-1024)
    const tiles = planInferenceTiles(1800, 1800, { tileSize: 1024, overlap: 128 });
    expect(tiles.map((t) => [t.tileId, t.x0, t.y0, t.x1, t.y1])).toEqual([
      [0, 0, 0, 1024, 1024],
      [1, 776, 0, 1800, 1024],
      [2, 0, 776, 1024, 1800],
      [3, 776, 776, 1800, 1800],
    ]);
    expect(tiles.every((t) => t.width === 1024 && t.height === 1024)).toBe(true);
  });

  it('страница меньше плитки по оси → одна плитка во всю ось', () => {
    // По X (500 <= 1024) — один origin 0; по Y origins [0, 896, 976]:
    // полноразмерные шаги 896, затем последняя плитка выравнивается к краю.
    const tiles = planInferenceTiles(500, 2000, { tileSize: 1024, overlap: 128 });
    expect(tiles.map((t) => [t.x0, t.y0, t.x1, t.y1])).toEqual([
      [0, 0, 500, 1024],
      [0, 896, 500, 1920],
      [0, 976, 500, 2000],
    ]);
    // крайние плитки не квадратные — потребитель масштабирует на реальные размеры
    expect(tiles[0]?.width).toBe(500);
  });

  it('валидация аргументов', () => {
    expect(() => planInferenceTiles(0, 100, { tileSize: 1024, overlap: 128 })).toThrow(RangeError);
    expect(() => planInferenceTiles(100, 100, { tileSize: 0, overlap: 0 })).toThrow(RangeError);
    expect(() => planInferenceTiles(100, 100, { tileSize: 64, overlap: 64 })).toThrow(RangeError);
    expect(() => planInferenceTiles(100, 100, { tileSize: 64, overlap: -1 })).toThrow(RangeError);
  });
});

describe('wholePageTile / planPageTiles', () => {
  it('wholePageTile покрывает весь лист', () => {
    expect(wholePageTile(640, 480)).toEqual({
      tileId: 0,
      x0: 0,
      y0: 0,
      x1: 640,
      y1: 480,
      width: 640,
      height: 480,
    });
    expect(() => wholePageTile(0, 480)).toThrow(RangeError);
  });

  it('правило _run_page: whole_page-режим ИЛИ страница помещается в один tile', () => {
    const whole = planPageTiles(4000, 3000, { tileSize: 1024, overlap: 128, mode: 'whole_page' });
    expect(whole).toHaveLength(1);
    expect(whole[0]?.width).toBe(4000);

    const small = planPageTiles(800, 600, { tileSize: 1024, overlap: 128, mode: 'tiles' });
    expect(small).toHaveLength(1); // мелкая страница — одна плитка даже в режиме tiles

    const grid = planPageTiles(1800, 1800, { tileSize: 1024, overlap: 128, mode: 'tiles' });
    expect(grid).toHaveLength(4);
  });
});

describe('remapRectToPage', () => {
  const tile = { tileId: 3, x0: 896, y0: 776, x1: 1800, y1: 1400, width: 904, height: 624 };

  it('перенос локальных координат в страницу', () => {
    expect(remapRectToPage([10, 20, 100, 200], tile, 1800, 1400)).toEqual([906, 796, 996, 976]);
  });

  it('кламп к границам страницы', () => {
    expect(remapRectToPage([-1000, -1000, 5000, 5000], tile, 1800, 1400)).toEqual([
      0, 0, 1800, 1400,
    ]);
  });
});

describe('blank-tile критерий', () => {
  it('порог из референса: std яркости < 1.0', () => {
    expect(BLANK_TILE_STD_THRESHOLD).toBe(1.0);
    expect(isBlankTile(0)).toBe(true);
    expect(isBlankTile(0.99)).toBe(true);
    expect(isBlankTile(1.0)).toBe(false);
    expect(isBlankTile(37.5)).toBe(false);
  });

  it('pilGrayscaleLuma повторяет целочисленную формулу Pillow convert("L")', () => {
    expect(pilGrayscaleLuma(0, 0, 0)).toBe(0);
    expect(pilGrayscaleLuma(255, 255, 255)).toBe(255);
    expect(pilGrayscaleLuma(255, 0, 0)).toBe(76); // чистый красный у PIL — 76
    expect(pilGrayscaleLuma(0, 255, 0)).toBe(150);
    expect(pilGrayscaleLuma(0, 0, 255)).toBe(29);
  });
});
