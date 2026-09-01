/**
 * Формат листа: правило калибруется числами, и числа обязаны быть в тесте.
 *
 * Опорная фикстура — РЕАЛЬНЫЕ размеры боевого комплекта на 220 страниц
 * (`temp/ИД Мастер апрель 2026.pdf`, снято зондом `probePdf`). Они здесь не для
 * полноты, а потому что доказывают необходимость допуска: ни одна страница
 * комплекта не равна номиналу, и правило «равно A4» не сработало бы ни разу.
 * Размеры листов реквизитами участников не являются и в маркерах `pii:scan`
 * не состоят.
 */

import { describe, expect, it } from 'vitest';

import {
  LEGACY_MARKUP_POLICY,
  MARKUP_POLICY_VERSION,
  classifySheet,
  markupPolicyFromSettings,
  pageMarkupMode,
  parseMarkupPolicy,
  resolvePageMarkupMode,
  sheetFormatLabel,
  type MarkupPolicy,
} from './sheet-format.js';

/**
 * Размеры страниц боевого комплекта в пунктах, как их отдал зонд: 220 страниц =
 * 196 портретных A4 + 12 АЛЬБОМНЫХ A4 + 12 альбомных A3.
 *
 * Альбомные A4 (842×594) здесь не для полноты: без нормализации сторон их
 * короткая сторона читалась бы как 842 pt, и двенадцать страниц комплекта
 * потеряли бы весь свой текст, попав в крупные листы.
 */
const MASTER_BUNDLE_A4_PORTRAIT: readonly (readonly [number, number])[] = [
  [594, 842],
  [593, 842],
  [595, 842],
];
const MASTER_BUNDLE_A4_LANDSCAPE: readonly (readonly [number, number])[] = [
  [842, 594],
  [842, 593],
];
const MASTER_BUNDLE_A3: readonly (readonly [number, number])[] = [
  [1188, 842],
  [1189, 842],
  [1187, 842],
  [1190, 842],
];

const SHEET_AWARE: MarkupPolicy = {
  version: MARKUP_POLICY_VERSION,
  sheetStrategy: 'sheet_aware',
  numberZone: 'near_stamp',
  numberZonePad: { x: 0.1, y: 0.25 },
};

describe('classifySheet', () => {
  describe('боевой комплект', () => {
    it.each(MASTER_BUNDLE_A4_PORTRAIT)('%i×%i pt — малый лист A4', (width, height) => {
      const format = classifySheet(width, height);

      expect(format.sheetClass).toBe('small');
      expect(format.code).toBe('A4');
      expect(format.orientation).toBe('portrait');
    });

    it.each(MASTER_BUNDLE_A4_LANDSCAPE)(
      '%i×%i pt — альбомный A4 остаётся малым листом',
      (width, height) => {
        const format = classifySheet(width, height);

        expect(format.sheetClass).toBe('small');
        expect(format.code).toBe('A4');
        expect(format.orientation).toBe('landscape');
      },
    );

    it.each(MASTER_BUNDLE_A3)('%i×%i pt — крупный лист A3', (width, height) => {
      const format = classifySheet(width, height);

      expect(format.sheetClass).toBe('large');
      expect(format.code).toBe('A3');
      expect(format.orientation).toBe('landscape');
    });

    it('ни один размер комплекта не равен номиналу — без допуска правило мертво', () => {
      // 210 мм = 595.2756 pt, 297 мм = 841.8898 pt, 420 мм = 1190.5512 pt.
      // В комплекте — 593..595 и 1187..1190, то есть мимо каждого номинала.
      const nominals = [595.2755905511812, 841.8897637795277, 1190.5511811023623];
      const exact = [
        ...MASTER_BUNDLE_A4_PORTRAIT,
        ...MASTER_BUNDLE_A4_LANDSCAPE,
        ...MASTER_BUNDLE_A3,
      ].filter(([width, height]) => nominals.includes(width) || nominals.includes(height));

      expect(exact).toEqual([]);
    });
  });

  it('ориентация на класс и имя не влияет', () => {
    const portrait = classifySheet(595, 842);
    const landscape = classifySheet(842, 595);

    expect(landscape.sheetClass).toBe(portrait.sheetClass);
    expect(landscape.code).toBe(portrait.code);
    expect(portrait.orientation).toBe('portrait');
    expect(landscape.orientation).toBe('landscape');
  });

  it('US Letter — малый лист без имени формата', () => {
    // 612×792 pt: это же DEFAULT_MEDIA_BOX для страницы без /MediaBox, и такая
    // страница обязана размечаться, а не выпадать в крупные.
    const format = classifySheet(612, 792);

    expect(format.sheetClass).toBe('small');
    expect(format.code).toBeNull();
    expect(format.fitsIn).toBe('A3');
  });

  it('скан A4 с полями остаётся малым', () => {
    expect(classifySheet(600, 850).sheetClass).toBe('small');
    expect(classifySheet(600, 850).code).toBe('A4');
  });

  it.each([
    ['A2', 1191, 1684],
    ['A1', 1684, 2384],
    ['A0', 2384, 3370],
  ])('%s — крупный лист', (code, width, height) => {
    const format = classifySheet(width, height);

    expect(format.sheetClass).toBe('large');
    expect(format.code).toBe(code);
  });

  it('A5 и A6 — малые листы со своими именами', () => {
    expect(classifySheet(420, 595).sheetClass).toBe('small');
    expect(classifySheet(420, 595).code).toBe('A5');
    expect(classifySheet(298, 420).code).toBe('A6');
  });

  describe('граница класса', () => {
    // Допуск 5 % от номинала A4: 625.04 × 883.98 pt.
    it('ровно на границе лист ещё малый', () => {
      expect(classifySheet(625.0, 883.9).sheetClass).toBe('small');
    });

    it('за границей по длинной стороне лист уже крупный', () => {
      expect(classifySheet(595, 884.1).sheetClass).toBe('large');
    });

    it('за границей по короткой стороне лист уже крупный', () => {
      expect(classifySheet(625.1, 842).sheetClass).toBe('large');
    });
  });

  it('MediaBox, записанный в пикселях, читается как A1 — известное поведение', () => {
    // 1654×2339 — это A4 при 200 dpi, записанный в бокс как пункты. Портал
    // такой лист считает крупным и ищет на нём штамп; страница без штампа
    // получит флаг, а не молча потеряется. Кейс зафиксирован намеренно, чтобы
    // смена поведения была видна в диффе.
    const format = classifySheet(1654, 2339);

    expect(format.sheetClass).toBe('large');
    expect(format.code).toBe('A1');
  });

  it('нестандартный крупный лист не получает имени, но получает границу', () => {
    const format = classifySheet(2550, 3900);

    expect(format.sheetClass).toBe('large');
    expect(format.code).toBeNull();
    expect(format.fitsIn).toBe('over_a0');
  });

  describe('нечитаемый размер', () => {
    it.each([
      ['NaN', Number.NaN, 842],
      ['бесконечность', Number.POSITIVE_INFINITY, 842],
      ['ноль', 0, 842],
      ['отрицательное', -10, 842],
    ])('%s даёт unknown, а не малый лист', (_name, width, height) => {
      expect(classifySheet(width, height).sheetClass).toBe('unknown');
    });

    it('у unknown нулём не подменяется ничего: все описательные поля null', () => {
      expect(classifySheet(0, 0)).toEqual({
        sheetClass: 'unknown',
        code: null,
        fitsIn: null,
        orientation: null,
        widthMm: null,
        heightMm: null,
      });
    });
  });

  it('миллиметры считаются для человека и округляются до 0.1', () => {
    const format = classifySheet(595, 842);

    expect(format.widthMm).toBe(209.9);
    expect(format.heightMm).toBe(297.0);
  });
});

describe('sheetFormatLabel', () => {
  it('именованный формат подписывается именем, альбомный — с ориентацией', () => {
    expect(sheetFormatLabel(classifySheet(595, 842))).toBe('A4');
    expect(sheetFormatLabel(classifySheet(1188, 842))).toBe('A3, альбомный');
  });

  it('нестандартный лист подписывается размером и границей', () => {
    expect(sheetFormatLabel(classifySheet(612, 792))).toBe(
      'нестандартный 215.9×279.4 мм (в пределах A3)',
    );
  });

  it('нечитаемый размер называется честно', () => {
    expect(sheetFormatLabel(classifySheet(Number.NaN, 0))).toBe('размер неизвестен');
  });
});

describe('resolvePageMarkupMode', () => {
  it('detect_all оставляет прежнее поведение на любом листе', () => {
    for (const sheetClass of ['small', 'large', 'unknown'] as const) {
      expect(resolvePageMarkupMode(sheetClass, LEGACY_MARKUP_POLICY)).toBe('full_detection');
    }
  });

  it('sheet_aware различает малый и крупный лист', () => {
    expect(resolvePageMarkupMode('small', SHEET_AWARE)).toBe('full_page');
    expect(resolvePageMarkupMode('large', SHEET_AWARE)).toBe('stamp_only');
  });

  it('неизвестный размер размечается как раньше, а не как A4', () => {
    // Иначе страница с битым MediaBox получила бы один блок на всю страницу на
    // основании арифметической ошибки, и это было бы неотличимо от решения.
    expect(resolvePageMarkupMode('unknown', SHEET_AWARE)).toBe('full_detection');
  });

  it('pageMarkupMode отвечает по размерам напрямую', () => {
    expect(pageMarkupMode(595, 842, SHEET_AWARE)).toBe('full_page');
    expect(pageMarkupMode(842, 1188, SHEET_AWARE)).toBe('stamp_only');
    expect(pageMarkupMode(0, 0, SHEET_AWARE)).toBe('full_detection');
  });
});

describe('markupPolicyFromSettings', () => {
  it('локальный детектор получает настройку как есть', () => {
    expect(
      markupPolicyFromSettings({
        provider: 'local',
        sheetStrategy: 'sheet_aware',
        numberZone: 'near_stamp',
      }),
    ).toEqual(SHEET_AWARE);
  });

  it('легаси-путь RD WEB правила форматов не получает никогда', () => {
    // Иначе блоки размечались бы по старому правилу, а флаги считались бы по
    // новому: анализ покрытия судил бы разметку по чужому правилу.
    expect(
      markupPolicyFromSettings({
        provider: 'rdweb',
        sheetStrategy: 'sheet_aware',
        numberZone: 'near_stamp',
      }),
    ).toEqual(LEGACY_MARKUP_POLICY);
  });
});

describe('parseMarkupPolicy', () => {
  it('читает запиненное значение', () => {
    expect(parseMarkupPolicy(SHEET_AWARE)).toEqual(SHEET_AWARE);
  });

  it.each([
    ['null', null],
    ['пустой объект', {}],
    ['чужая версия', { ...SHEET_AWARE, version: 2 }],
    ['неизвестная стратегия', { ...SHEET_AWARE, sheetStrategy: 'whatever' }],
    ['строка вместо объекта', 'sheet_aware'],
  ])('непригодное значение (%s) даёт прежнее поведение, а не исключение', (_name, value) => {
    expect(parseMarkupPolicy(value)).toEqual(LEGACY_MARKUP_POLICY);
  });
});
