/**
 * Флаги внимания (§7.3) и канонический хэш набора блоков (§5.2).
 *
 * Обе функции чистые, поэтому проверяются напрямую: их поведение — это и есть
 * методика, а не деталь реализации. Тесты написаны от требований плана, а не от
 * текущих чисел: пороги приходят параметром, и подобранное «под код» значение
 * здесь не спрятать.
 */
import { describe, expect, it } from 'vitest';

import type { PageMarkupMode } from '@id/contracts';
import { analyzePages, unionArea, type AnalyzedPage } from './attention.js';
import {
  computeBlocksHash,
  FALLBACK_LAYOUT_THRESHOLDS,
  type HashableBlock,
} from '../db/repositories/layout.js';

const T = FALLBACK_LAYOUT_THRESHOLDS;

function page(index: number, blocks: AnalyzedPage['blocks']): AnalyzedPage {
  return { workingPageIndex: index, blocks };
}

function text(x0: number, y0: number, x1: number, y1: number): AnalyzedPage['blocks'][number] {
  return { blockType: 'text', x0, y0, x1, y1 };
}

/** Страница «как надо»: три текстовых блока, покрытие заметно выше порога. */
function healthy(index: number): AnalyzedPage {
  return page(index, [
    text(0.08, 0.05, 0.92, 0.3),
    text(0.08, 0.32, 0.92, 0.62),
    text(0.08, 0.64, 0.92, 0.9),
  ]);
}

describe('площадь объединения', () => {
  it('перекрытие не считается дважды', () => {
    // Наивная сумма дала бы 0.5 + 0.5 = 1.0 и «покрытие 100%» там, где его нет.
    const area = unionArea([
      { x0: 0, y0: 0, x1: 1, y1: 0.5 },
      { x0: 0, y0: 0.25, x1: 1, y1: 0.75 },
    ]);
    expect(area).toBeCloseTo(0.75, 6);
  });

  it('непересекающиеся прямоугольники складываются', () => {
    const area = unionArea([
      { x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
      { x0: 0.5, y0: 0.5, x1: 1, y1: 1 },
    ]);
    expect(area).toBeCloseTo(0.5, 6);
  });

  it('пустой набор даёт ноль', () => {
    expect(unionArea([])).toBe(0);
  });
});

/**
 * Флаги обязаны судить страницу по тому правилу, по которому её размечали (S42).
 *
 * Иначе сигнал перестаёт быть сигналом: `low_coverage` встал бы на КАЖДОМ
 * успешно размеченном крупном листе (штамп — это 2–5 % площади), а
 * `blank_page_candidate` утверждал бы «на странице ничего не напечатано» там,
 * где текст просто не искали.
 */
describe('режим разметки страницы', () => {
  const stamp = (): AnalyzedPage['blocks'][number] => ({
    blockType: 'stamp',
    x0: 0.72,
    y0: 0.82,
    x1: 0.97,
    y1: 0.95,
  });

  function withMode(base: AnalyzedPage, markupMode: PageMarkupMode): AnalyzedPage {
    return { ...base, markupMode };
  }

  it('малый лист с одним полностраничным блоком флагов не получает', () => {
    const [analysis] = analyzePages([withMode(page(0, [text(0, 0, 1, 1)]), 'full_page')], T);

    expect(analysis?.flags).toEqual([]);
    expect(analysis?.coverage).toBeCloseTo(1, 6);
  });

  it('крупный лист со штампом не считается ни пустым, ни скудно покрытым', () => {
    // Покрытие тут ~3 %, то есть ниже обоих порогов. При прежнем правиле это
    // дало бы `low_coverage` и `blank_page_candidate` на каждом чертеже.
    const [analysis] = analyzePages([withMode(page(0, [stamp()]), 'stamp_only')], T);

    expect(analysis?.flags).toEqual([]);
  });

  it('крупный лист без штампа говорит об этом прямо', () => {
    const [analysis] = analyzePages([withMode(page(0, []), 'stamp_only')], T);

    // `missing_expected_stamp` вместо `blank_page_candidate`: «основной надписи
    // нет» — это утверждение о документе, а «страница пуста» — о печати, и на
    // чертеже второе было бы ложью.
    expect(analysis?.flags).toEqual(['missing_expected_stamp', 'no_blocks']);
  });

  it('малый лист без блоков остаётся просто пустым', () => {
    const [analysis] = analyzePages([withMode(page(0, []), 'full_page')], T);

    expect(analysis?.flags).toEqual(['no_blocks']);
  });

  it('без указания режима поведение прежнее — якорь совместимости', () => {
    // Ревизии, размеченные до правила форматов, судятся тем правилом, по
    // которому их размечали.
    const [analysis] = analyzePages([page(0, [])], T);

    expect(analysis?.flags).toEqual(['blank_page_candidate', 'no_blocks']);
  });

  it('чередование форматов не порождает neighbor_mismatch', () => {
    // Без учёта режима сходится всё сразу: и порог по числу блоков, и «состав
    // типов отличается от обоих соседей». Флаг «резкое изменение относительно
    // соседей» на штатной раскладке комплекта — это шум, а не сигнал.
    const pages = [0, 1, 2, 3, 4, 5].map((index) =>
      index % 2 === 0
        ? withMode(page(index, [text(0, 0, 1, 1)]), 'full_page')
        : withMode(page(index, [stamp(), stamp(), stamp(), stamp()]), 'stamp_only'),
    );

    const analysis = analyzePages(pages, T);

    expect(analysis.flatMap((entry) => entry.flags)).not.toContain('neighbor_mismatch');
  });

  it('аномалия среди страниц ОДНОГО режима по-прежнему замечается', () => {
    // Отрицательный контроль: правило снимает шум на границах форматов, а не
    // выключает сравнение с соседями.
    const many = (index: number): AnalyzedPage =>
      withMode(
        page(index, [text(0.05, 0.05, 0.9, 0.2), text(0.05, 0.25, 0.9, 0.4), stamp(), stamp()]),
        'full_detection',
      );
    const analysis = analyzePages(
      [many(0), withMode(page(1, [text(0.05, 0.05, 0.9, 0.9)]), 'full_detection'), many(2)],
      T,
    );

    expect(analysis[1]?.flags).toContain('neighbor_mismatch');
  });
});

describe('флаги внимания', () => {
  it('страница без блоков помечена и как пустая детекция, и как кандидат в пустые', () => {
    const [result] = analyzePages([page(0, [])], T);
    expect(result?.flags).toContain('no_blocks');
    expect(result?.flags).toContain('blank_page_candidate');
  });

  it('низкое покрытие ловится, здоровая страница — нет', () => {
    const [low, ok] = analyzePages([page(0, [text(0.4, 0.4, 0.5, 0.5)]), healthy(1)], T);
    expect(low?.flags).toContain('low_coverage');
    expect(ok?.flags).not.toContain('low_coverage');
  });

  it('перекрытие блоков ОДНОГО класса — сигнал, вложенный штамп — нет', () => {
    const overlapping = analyzePages(
      [page(0, [text(0.1, 0.1, 0.9, 0.6), text(0.1, 0.15, 0.9, 0.62)])],
      T,
    );
    expect(overlapping[0]?.flags).toContain('suspicious_overlap');

    // Маленький штамп внутри текстового блока — штатная вёрстка документа
    // (печать ЭДО в подвале листа), и §7.3 называет это слабым сигналом.
    //
    // Фикстура подобрана так, чтобы проверять именно ИСКЛЮЧЕНИЕ штампа, а не
    // совпадать с порогом: площадь штампа 0.0016 НИЖЕ порога `tinyBlockAreaRatio`
    // (0.002), а его IoU с маленьким текстовым блоком — 0.33 при пороге 0.2.
    // Снимите любую из двух защит в `attention.ts` — тест покраснеет. Прежняя
    // фикстура (штамп площадью 0.039 и IoU 0.05) проходила бы и без них.
    const nestedStamp = analyzePages(
      [
        page(0, [
          text(0.08, 0.05, 0.92, 0.9),
          text(0.59, 0.74, 0.66, 0.81),
          { blockType: 'stamp', x0: 0.6, y0: 0.75, x1: 0.64, y1: 0.79 },
        ]),
      ],
      T,
    );
    expect(nestedStamp[0]?.flags).not.toContain('suspicious_overlap');
    expect(nestedStamp[0]?.flags).not.toContain('tiny_block');
  });

  it('вырожденная геометрия и аномально маленький блок различаются', () => {
    const [degenerate] = analyzePages([page(0, [text(0.3, 0.5, 0.9, 0.5)])], T);
    expect(degenerate?.flags).toContain('degenerate_geometry');

    const [tiny] = analyzePages([page(0, [healthyBlock(), text(0.5, 0.5, 0.52, 0.51)])], T);
    expect(tiny?.flags).toContain('tiny_block');
    expect(tiny?.flags).not.toContain('degenerate_geometry');
  });

  it('bbox вне страницы помечается отдельно', () => {
    const [result] = analyzePages([page(0, [text(0.1, 0.1, 1.4, 0.9)])], T);
    expect(result?.flags).toContain('bbox_out_of_page');
  });

  it('резкое изменение ЧИСЛА И ТИПОВ блоков относительно соседей — сигнал', () => {
    // §7.3 говорит именно о «резком изменении числа И типов». Один блок против
    // восьми у обоих соседей, да ещё и другого состава типов, — это страница, на
    // которой детектор сорвался посреди комплекта.
    const pages = [dense(0), page(1, [text(0.08, 0.05, 0.92, 0.95)]), dense(2)];
    const analysis = analyzePages(pages, T);
    expect(analysis[1]?.flags).toContain('neighbor_mismatch');
    expect(analysis[0]?.flags).not.toContain('neighbor_mismatch');
    expect(analysis[2]?.flags).not.toContain('neighbor_mismatch');
  });

  it('одно только изменение числа блоков флага не даёт', () => {
    // Титул или короткое сопроводительное письмо среди листов акта: блоков
    // закономерно меньше, но состав типов тот же. §7.3 требует обоих условий.
    const analysis = analyzePages(
      [healthy(0), page(1, [text(0.08, 0.05, 0.92, 0.95)]), healthy(2)],
      T,
    );
    expect(analysis[1]?.flags).not.toContain('neighbor_mismatch');
  });

  it('штамп ЭП на каждой четвёртой странице однородного комплекта — не сигнал', () => {
    // Типовая раскладка корпуса: печать ЭДО в подвале каждого четвёртого листа.
    // Правило «состав типов отличается от обоих соседей» без порога по числу
    // давало здесь флаг на каждой такой странице, то есть шум вместо проверки.
    const pages = [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
      index % 4 === 3 ? withStamp(index) : healthy(index),
    );
    const analysis = analyzePages(pages, T);
    expect(analysis.flatMap((entry) => entry.flags)).toEqual([]);
  });

  it('A3-схема среди текстовых листов — не сигнал', () => {
    // Схема даёт `image` с описанием чертежа, штамп основной надписи и текстовую
    // легенду — состав типов другой, число блоков сопоставимо. §7.3 относит это
    // к слабым сигналам, а не к самостоятельной ошибке.
    const scheme = page(2, [
      { blockType: 'image', x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.75 },
      text(0.05, 0.78, 0.6, 0.95),
      { blockType: 'stamp', x0: 0.7, y0: 0.8, x1: 0.92, y1: 0.93 },
    ]);
    const analysis = analyzePages([healthy(0), healthy(1), scheme, healthy(3), healthy(4)], T);
    expect(analysis[2]?.flags).not.toContain('neighbor_mismatch');
  });

  it('однородный комплект не порождает флагов вовсе', () => {
    const analysis = analyzePages([healthy(0), healthy(1), healthy(2), healthy(3)], T);
    expect(analysis.flatMap((entry) => entry.flags)).toEqual([]);
  });

  it('порог берётся из профиля, а не из кода', () => {
    const strict = { ...T, minCoverageRatio: 0.99 };
    const analysis = analyzePages([healthy(0)], strict);
    expect(analysis[0]?.flags).toContain('low_coverage');
  });
});

function healthyBlock(): AnalyzedPage['blocks'][number] {
  return text(0.08, 0.05, 0.92, 0.9);
}

/** Та же страница, что `healthy`, плюс штамп ЭП в подвале — печать ЭДО. */
function withStamp(index: number): AnalyzedPage {
  return page(index, [
    ...healthy(index).blocks,
    { blockType: 'stamp', x0: 0.6, y0: 0.75, x1: 0.9, y1: 0.88 },
  ]);
}

/** Плотный лист акта: семь текстовых блоков и штамп — восемь блоков. */
function dense(index: number): AnalyzedPage {
  const blocks = [0, 1, 2, 3, 4, 5, 6].map((row) =>
    text(0.08, 0.02 + row * 0.14, 0.92, 0.13 + row * 0.14),
  );
  return page(index, [...blocks, { blockType: 'stamp', x0: 0.6, y0: 0.75, x1: 0.9, y1: 0.88 }]);
}

// =====================================================================
// Канонический хэш
// =====================================================================

function block(overrides: Partial<HashableBlock> = {}): HashableBlock {
  return {
    workingPageIndex: 0,
    blockType: 'text',
    shapeType: 'rectangle',
    x0: 0.1,
    y0: 0.1,
    x1: 0.9,
    y1: 0.5,
    sortOrder: 0,
    points: [],
    ...overrides,
  };
}

describe('канонический хэш набора блоков', () => {
  it('не зависит от порядка строк', () => {
    const a = block();
    const b = block({ workingPageIndex: 1, y0: 0.6, y1: 0.9 });
    const c = block({ blockType: 'stamp', x0: 0.7, x1: 0.95, y0: 0.8, y1: 0.95 });

    expect(computeBlocksHash([a, b, c])).toBe(computeBlocksHash([c, a, b]));
    expect(computeBlocksHash([a, b, c])).toBe(computeBlocksHash([b, c, a]));
  });

  it('различает геометрию, тип и страницу', () => {
    const base = computeBlocksHash([block()]);
    expect(computeBlocksHash([block({ x1: 0.91 })])).not.toBe(base);
    expect(computeBlocksHash([block({ blockType: 'image' })])).not.toBe(base);
    expect(computeBlocksHash([block({ workingPageIndex: 1 })])).not.toBe(base);
  });

  /**
   * Порядок чтения входит в хэш РАНГОМ, а не сырым `sort_order`.
   *
   * Сырое число сравнивать нельзя: на стороне RD WEB его назначает их сервер
   * (max+1 внутри группы «страница × тип»), нашего значения он не принимает, а
   * после удалений в нумерации остаются дыры. Хэш обязан ловить смену ПОРЯДКА
   * блоков и не обязан ловить смену нумерации, при которой порядок тот же.
   */
  it('ловит перестановку блоков и не ловит разрыв нумерации', () => {
    const first = block({ y0: 0.1, y1: 0.3, sortOrder: 0 });
    const second = block({ y0: 0.4, y1: 0.6, sortOrder: 1 });

    const ordered = computeBlocksHash([first, second]);
    // Дыры в нумерации (0, 5) описывают ТОТ ЖЕ порядок чтения.
    expect(computeBlocksHash([first, { ...second, sortOrder: 5 }])).toBe(ordered);
    // А перестановка — уже другой порядок, и хэш обязан её увидеть.
    expect(
      computeBlocksHash([
        { ...first, sortOrder: 1 },
        { ...second, sortOrder: 0 },
      ]),
    ).not.toBe(ordered);
  });

  it('устойчив к дрожанию double после round-trip через JSON', () => {
    // Координата, вернувшаяся от RD WEB, отличается в 15-м знаке. Побитовое
    // сравнение дало бы `integrity_error` на исправном прогоне.
    const jittered = block({ x0: 0.1 + Number.EPSILON });
    expect(computeBlocksHash([jittered])).toBe(computeBlocksHash([block()]));
  });

  it('порядок точек полигона значим: он задаёт форму', () => {
    const p1 = block({
      shapeType: 'polygon',
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
    });
    const p2 = block({
      shapeType: 'polygon',
      points: [
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
    });
    expect(computeBlocksHash([p1])).not.toBe(computeBlocksHash([p2]));
  });

  it('пустой набор даёт стабильное значение, а не ошибку', () => {
    expect(computeBlocksHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
