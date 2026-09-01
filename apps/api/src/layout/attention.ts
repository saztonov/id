/**
 * Флаги внимания страницы разметки (§7.3).
 *
 * Чистая функция от набора блоков и порогов профиля: ни базы, ни сети, ни
 * часов. Так её можно прогнать на любой странице-ловушке из синтетических
 * фикстур и получить тот же ответ, что получит конвейер.
 *
 * ## Что здесь принципиально
 *
 * **Полностраничный TEXT-блок не добавляется НИКОГДА.** Это самая дорогая
 * ошибка предыдущей редакции плана: страница с блоками на 30% площади получила
 * бы поверх них ещё один блок на всю страницу, они перекрылись бы, и один и тот
 * же текст уехал бы в md дважды. Поэтому подозрительная страница получает флаг,
 * а замена страницы одним блоком остаётся явным действием пользователя (§5.3).
 *
 * **Слабые сигналы не являются самостоятельной ошибкой.** Смена ориентации и
 * маленький вложенный `stamp` — это норма для комплекта, где встречаются A3-схемы
 * и печати ЭДО в подвале. Они не порождают флага сами по себе: `tiny_block`
 * ставится по площади и НЕ ставится штампу, `suspicious_overlap` смотрит только
 * на блоки ОДНОГО класса (вложенный штамп внутри текстового блока законен), а
 * `neighbor_mismatch` требует расхождения И по числу блоков, И по составу типов
 * — по отдельности каждое из двух ловит типовую раскладку корпуса, а не дефект.
 *
 * **Пороги приходят снаружи.** Они принадлежат версионному профилю разметки
 * (`layout_profiles`, миграция 0012), а не этому файлу: калибровка порога не
 * должна быть релизом.
 */
import type { AttentionFlag, PageMarkupMode } from '@id/contracts';
import type { LayoutThresholds } from '../db/repositories/layout.js';

export interface AnalyzedBlock {
  readonly blockType: 'text' | 'image' | 'stamp';
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface AnalyzedPage {
  readonly workingPageIndex: number;
  readonly blocks: readonly AnalyzedBlock[];
  /**
   * Что портал ИСКАЛ на этой странице (S42). По умолчанию `full_detection` —
   * прежнее правило.
   *
   * Необязательное поле, и это обратная совместимость по построению: сигнатура
   * `analyzePages` не меняется, все прежние вызовы и тесты продолжают работать,
   * а ревизия, размеченная до правила форматов, судится тем правилом, по
   * которому её размечали.
   *
   * Передаётся именно РЕЖИМ, а не класс листа: флагам нужен ответ на вопрос
   * «что мы здесь искали», и класс листа отвечает на него только вместе со
   * стратегией. Пороги при этом не трогаются вовсе — новое правило предикат, а
   * не калибровка, и калибровать в нём нечего.
   */
  readonly markupMode?: PageMarkupMode;
}

export interface PageAnalysis {
  readonly workingPageIndex: number;
  readonly flags: readonly AttentionFlag[];
  /** Доля площади страницы, покрытая объединением блоков (0..1). */
  readonly coverage: number;
  readonly blockCount: number;
}

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function area(rect: Rect): number {
  return Math.max(0, rect.x1 - rect.x0) * Math.max(0, rect.y1 - rect.y0);
}

function intersection(a: Rect, b: Rect): number {
  const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return width <= 0 || height <= 0 ? 0 : width * height;
}

/**
 * Площадь объединения прямоугольников методом заметающей координаты.
 *
 * Сумма площадей здесь неверна: блоки текста часто соприкасаются и слегка
 * налезают друг на друга, и наивная сумма дала бы покрытие больше единицы, то
 * есть флаг «низкое покрытие» перестал бы срабатывать там, где он и нужен.
 * Разложение по уникальным x-границам точное и на десятке блоков дешёвое.
 */
export function unionArea(rects: readonly Rect[]): number {
  if (rects.length === 0) return 0;

  const xs = [...new Set(rects.flatMap((rect) => [rect.x0, rect.x1]))].sort((a, b) => a - b);
  let total = 0;

  for (let i = 0; i + 1 < xs.length; i += 1) {
    const left = xs[i] as number;
    const right = xs[i + 1] as number;
    const width = right - left;
    if (width <= 0) continue;

    const spans = rects
      .filter((rect) => rect.x0 <= left && rect.x1 >= right)
      .map((rect) => ({ from: rect.y0, to: rect.y1 }))
      .sort((a, b) => a.from - b.from);

    let covered = 0;
    let cursor = -1;
    for (const span of spans) {
      const from = Math.max(span.from, cursor);
      if (span.to > from) {
        covered += span.to - from;
        cursor = span.to;
      }
    }
    total += width * covered;
  }

  return Math.min(1, total);
}

/**
 * Флаги одной страницы без учёта соседей.
 *
 * Соседи разбираются отдельно (`analyzePages`): они требуют всего комплекта, а
 * эта функция обязана оставаться проверяемой на одной странице.
 */
function flagsOfPage(
  page: AnalyzedPage,
  thresholds: LayoutThresholds,
): {
  flags: Set<AttentionFlag>;
  coverage: number;
} {
  const flags = new Set<AttentionFlag>();
  const blocks = page.blocks;
  const mode = page.markupMode ?? 'full_detection';
  /**
   * Осматривал ли детектор эту страницу на предмет текста.
   *
   * От этого зависит право говорить о пустоте и о покрытии.
   * `blank_page_candidate` утверждает «похоже, на странице ничего не
   * напечатано», а `low_coverage` — «текста нашлось подозрительно мало». Оба
   * утверждения требуют, чтобы кто-то смотрел.
   *
   * При `stamp_only` портал искал только штамп: тот занимает 2–5 % площади, и
   * `low_coverage` встал бы на КАЖДОМ успешно размеченном чертеже — сигнал
   * означал бы «всё хорошо». При `full_page` страницу не осматривали вовсе:
   * она размечена одним блоком без единого инференса, и «похоже, ничего не
   * напечатано» было бы утверждением, ни на чём не основанным.
   */
  const examinedForText = mode === 'full_detection';

  if (blocks.length === 0) {
    // Пустая детекция — не «пустая страница»: это два разных состояния, и
    // второе подтверждается только тем, что на странице и правда ничего нет.
    // Отличить их автоматически нечем, поэтому ставятся оба сигнала.
    flags.add('no_blocks');
    if (examinedForText) flags.add('blank_page_candidate');
    // Крупный лист без штампа — это «основной надписи нет, нужен человек», и
    // сказать это прямо честнее, чем оставить одно «блоков нет».
    if (mode === 'stamp_only') flags.add('missing_expected_stamp');
    return { flags, coverage: 0 };
  }

  for (const block of blocks) {
    const outOfPage =
      block.x0 < 0 ||
      block.y0 < 0 ||
      block.x1 > 1 ||
      block.y1 > 1 ||
      block.x0 > block.x1 ||
      block.y0 > block.y1;
    if (outOfPage) flags.add('bbox_out_of_page');

    const width = block.x1 - block.x0;
    const height = block.y1 - block.y0;
    if (width <= thresholds.degenerateSideRatio || height <= thresholds.degenerateSideRatio) {
      flags.add('degenerate_geometry');
    } else if (
      // Штамп маленький по своей природе (печать в подвале листа), и мерить его
      // тем же порогом значило бы получить флаг на каждой второй странице —
      // §7.3 прямо называет это слабым сигналом, а не ошибкой.
      block.blockType !== 'stamp' &&
      area(block) < thresholds.tinyBlockAreaRatio
    ) {
      flags.add('tiny_block');
    }
  }

  // Перекрытие проверяется ТОЛЬКО внутри одного класса: `stamp` внутри `text` —
  // это штатная вёрстка документа, а два текстовых блока друг на друге означают,
  // что один и тот же текст уедет в распознавание дважды.
  for (const type of ['text', 'image', 'stamp'] as const) {
    const sameClass = blocks.filter((block) => block.blockType === type);
    for (let i = 0; i < sameClass.length; i += 1) {
      for (let j = i + 1; j < sameClass.length; j += 1) {
        const a = sameClass[i] as AnalyzedBlock;
        const b = sameClass[j] as AnalyzedBlock;
        const inter = intersection(a, b);
        if (inter <= 0) continue;
        const union = area(a) + area(b) - inter;
        if (union > 0 && inter / union >= thresholds.overlapIouThreshold) {
          flags.add('suspicious_overlap');
        }
      }
    }
  }

  const coverage = unionArea(blocks);
  if (examinedForText) {
    if (coverage < thresholds.blankPageCoverageRatio) {
      flags.add('blank_page_candidate');
      flags.add('low_coverage');
    } else if (coverage < thresholds.minCoverageRatio) {
      flags.add('low_coverage');
    }
  }

  if (
    thresholds.expectStampOnImagePage &&
    blocks.some((block) => block.blockType === 'image') &&
    !blocks.some((block) => block.blockType === 'stamp')
  ) {
    flags.add('missing_expected_stamp');
  }

  return { flags, coverage };
}

/**
 * Флаги всех страниц комплекта.
 *
 * Сравнение с соседями делается на втором проходе: «резкое изменение числа и
 * типов блоков относительно соседних страниц» (§7.3) невозможно посчитать,
 * глядя на страницу в одиночку, а именно оно ловит страницу, где детектор
 * сорвался в середине однородного комплекта.
 */
export function analyzePages(
  pages: readonly AnalyzedPage[],
  thresholds: LayoutThresholds,
): readonly PageAnalysis[] {
  const ordered = [...pages].sort((a, b) => a.workingPageIndex - b.workingPageIndex);
  const perPage = ordered.map((page) => ({ page, ...flagsOfPage(page, thresholds) }));

  for (let i = 0; i < perPage.length; i += 1) {
    const current = perPage[i] as (typeof perPage)[number];
    const currentMode = current.page.markupMode ?? 'full_detection';
    /**
     * Соседями считаются ФИЗИЧЕСКИ соседние страницы того же режима (S42).
     *
     * Без этого чередование форматов даёт флаг на каждой границе: у малого
     * листа один блок типа `text`, у крупного — штамп, и сходится всё сразу —
     * и порог по числу, и «состав типов отличается от обоих соседей». Флаг
     * «резкое изменение относительно соседей» на штатной раскладке комплекта —
     * ровно то, чего этот файл велит избегать.
     *
     * Сравниваются именно соседи по индексу, а не ближайшие того же режима:
     * группировка «все A4 подряд» сделала бы соседями страницы, разнесённые по
     * комплекту на сотню листов, и сравнение перестало бы значить хоть что-то.
     */
    const neighbours = [perPage[i - 1], perPage[i + 1]].filter(
      (entry): entry is (typeof perPage)[number] =>
        entry !== undefined && (entry.page.markupMode ?? 'full_detection') === currentMode,
    );
    if (neighbours.length === 0) continue;

    const neighbourCounts = neighbours.map((entry) => entry.page.blocks.length);
    const expected = neighbourCounts.reduce((sum, value) => sum + value, 0) / neighbours.length;
    // Ниже порога сравнивать нечего: разница «один блок против двух» на титуле
    // и на схеме — это норма, а не сигнал.
    if (expected < thresholds.neighborMinBlocks) continue;

    const actual = current.page.blocks.length;
    // Страница без блоков уже помечена `no_blocks`; второй флаг о том же
    // добавил бы шум в ленту миниатюр.
    if (actual === 0) continue;

    // §7.3 говорит о «резком изменении числа И типов блоков», и союз здесь
    // существенный. Каждое условие поодиночке даёт флаг на штатной вёрстке:
    //
    // — один СОСТАВ типов срабатывает на каждой четвёртой странице однородного
    //   комплекта, где в подвале стоит штамп ЭП, и на A3-схеме среди текстовых
    //   листов. И то, и другое §7.3 относит к СЛАБЫМ сигналам, а не к ошибке;
    // — одно ЧИСЛО срабатывает на титуле и на короткой сопроводительной
    //   странице, где блоков закономерно меньше.
    //
    // Вместе они означают другое: страница, на которой детектор сорвался
    // посреди однородного комплекта, — и число блоков не то, и типы не те.
    // Отдельного порога для состава типов нет намеренно: «состав отличается»
    // — предикат без величины, калибровать в нём нечего, а числовой порог рядом
    // с ним уже приходит из профиля (`neighborCountDeltaRatio`).
    const delta = Math.abs(actual - expected) / expected;
    if (delta < thresholds.neighborCountDeltaRatio) continue;

    const typesOf = (blocks: readonly AnalyzedBlock[]): string =>
      [...new Set(blocks.map((block) => block.blockType))].sort().join(',');
    const currentTypes = typesOf(current.page.blocks);
    if (neighbours.every((entry) => typesOf(entry.page.blocks) !== currentTypes)) {
      current.flags.add('neighbor_mismatch');
    }
  }

  return perPage.map((entry) => ({
    workingPageIndex: entry.page.workingPageIndex,
    flags: [...entry.flags].sort(),
    coverage: entry.coverage,
    blockCount: entry.page.blocks.length,
  }));
}
