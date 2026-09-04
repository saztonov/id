/**
 * Сборка `RecognitionResult v2` из результатов прогона со СТРОГОЙ двусторонней
 * сверкой (инвариант 5 плана, ADR-0007).
 *
 * Сборка провайдер-нейтральна: маршрутов распознавания два (VLM через
 * OpenRouter и снимок в RD WEB), а сверка с разметкой, порядок блоков и форма
 * канона у них общие. Чем распознано, говорит вызывающий полем `source` — и
 * говорит обязательно, без умолчания.
 *
 * ## Почему сверка двусторонняя и почему она здесь
 *
 * Финализация публикует результат атомарно, и публикация неполного или
 * загрязнённого набора непоправима: текст страниц уедет вниз по конвейеру, и
 * все офсеты/якоря посчитаются по нему. Поэтому ДО валидации схемы результат
 * сверяется с замороженной разметкой в обе стороны:
 *
 * - каждый замороженный блок ОБЯЗАН иметь ровно один результат;
 * - ни одного результата ВНЕ замороженного набора (результат неизвестного
 *   блока — признак смешения прогонов или гонки);
 * - идентичность каждого результата (layoutBlockId, тип, ordinal) совпадает с
 *   замороженным блоком — маппинг не имел права их изменить;
 * - диапазоны координат в [0,1] и невырожденны по знаку (x0≤x1, y0≤y1);
 * - страницы результатов существуют в наборе страниц и не дублируются.
 *
 * Любое расхождение — `RecognitionAssembleError` с ПОЛНЫМ перечнем (не первым
 * попавшимся): падение финализации расследуют по одной записи журнала, и
 * список из всех расхождений сразу отличает единичный дефект от системного.
 *
 * ## Детерминированный порядок
 *
 * Блоки страницы сортируются по `ordinal` (= `sortOrder` замороженного блока);
 * при равенстве — по `layoutBlockId` (лексикографически): двух одинаковых
 * `sortOrder` в замороженной разметке быть не должно, но сборка обязана быть
 * детерминированной и в этом случае, а не зависеть от порядка обхода Map.
 * Страницы — строго по возрастанию `workingPageIndex` (это же требует и
 * superRefine схемы).
 *
 * `pages[].text = null` — принципиально и одинаково для обоих маршрутов: текст
 * страницы СОБИРАЕТСЯ рендерером (`renderPageText` поверх блоков), а не хранится
 * дословно. Так `PAGE_TEXT_RENDER_VERSION` означает одно и то же на обеих
 * ветках, и офсеты цитат downstream сопоставимы между провайдерами; дословный
 * текст был привилегией legacy-адаптера, где он уже был каноном.
 */
import {
  RECOGNITION_RESULT_SCHEMA_VERSION,
  recognitionResultSchema,
  type RecognitionBlock,
  type RecognitionPage,
  type RecognitionProvider,
  type RecognitionResult,
} from '@id/recognition';
import type { BlockType } from '@id/contracts';

export interface AssemblePageInput {
  readonly workingPageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
}

export interface AssembleFrozenBlock {
  readonly layoutBlockId: string;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  readonly coordsNorm: readonly [number, number, number, number];
  readonly sortOrder: number;
}

export interface AssembleRecognitionInput {
  /**
   * Чем распознано. Без значения по умолчанию намеренно.
   *
   * До появления второго маршрута провайдер был зашит константой, и это было
   * честно ровно до тех пор, пока маршрут оставался один. Умолчание сегодня
   * означало бы, что вызывающий, забывший поле, молча подписывает свой артефакт
   * чужим именем — а `source.provider` это единственное, по чему прогоны двух
   * веток различимы на одних и тех же пикселях.
   */
  readonly source: {
    readonly provider: RecognitionProvider;
    /** Версия адаптера, а не модели: `openrouter-vlm.v3`, `rdweb-exec.v1`. */
    readonly adapterVersion: string;
  };
  /** Модель прогона (снимок настроек); `null` — законен для RD WEB и recorded-двойника. */
  readonly modelId: string | null;
  readonly pages: readonly AssemblePageInput[];
  readonly frozenBlocks: readonly AssembleFrozenBlock[];
  /** Результаты по `layoutBlockId` (уникальность ключей — свойством Map). */
  readonly results: ReadonlyMap<string, RecognitionBlock>;
}

export class RecognitionAssembleError extends Error {
  readonly discrepancies: readonly string[];

  constructor(discrepancies: readonly string[]) {
    super(
      `двусторонняя сверка результатов с замороженной разметкой провалена ` +
        `(${discrepancies.length}): ${discrepancies.join('; ')}`,
    );
    this.name = 'RecognitionAssembleError';
    this.discrepancies = discrepancies;
  }
}

function coordsValid(coords: readonly [number, number, number, number]): boolean {
  const [x0, y0, x1, y1] = coords;
  const inRange = coords.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  return inRange && x0 <= x1 && y0 <= y1;
}

export function assembleRecognitionResult(input: AssembleRecognitionInput): RecognitionResult {
  const discrepancies: string[] = [];

  // --- страницы: уникальность индексов ---------------------------------------
  const pagesByIndex = new Map<number, AssemblePageInput>();
  for (const page of input.pages) {
    if (pagesByIndex.has(page.workingPageIndex)) {
      discrepancies.push(`страница ${page.workingPageIndex} задана дважды`);
      continue;
    }
    pagesByIndex.set(page.workingPageIndex, page);
  }

  // --- замороженные блоки: уникальность, страницы, координаты ---------------
  const frozenById = new Map<string, AssembleFrozenBlock>();
  for (const block of input.frozenBlocks) {
    if (frozenById.has(block.layoutBlockId)) {
      discrepancies.push(`замороженный блок ${block.layoutBlockId} встречается дважды`);
      continue;
    }
    frozenById.set(block.layoutBlockId, block);
    if (!pagesByIndex.has(block.workingPageIndex)) {
      discrepancies.push(
        `блок ${block.layoutBlockId} ссылается на отсутствующую страницу ${block.workingPageIndex}`,
      );
    }
    if (!coordsValid(block.coordsNorm)) {
      discrepancies.push(
        `блок ${block.layoutBlockId}: coordsNorm вне диапазона [0,1] или вырождены по знаку`,
      );
    }
  }

  // --- сверка «замороженный → результат» -------------------------------------
  for (const frozen of frozenById.values()) {
    const result = input.results.get(frozen.layoutBlockId);
    if (result === undefined) {
      discrepancies.push(`блок ${frozen.layoutBlockId} без результата распознавания`);
      continue;
    }
    if (result.layoutBlockId !== frozen.layoutBlockId) {
      discrepancies.push(
        `результат под ключом ${frozen.layoutBlockId} несёт чужой layoutBlockId ${String(result.layoutBlockId)}`,
      );
    }
    if (result.blockType !== frozen.blockType) {
      discrepancies.push(
        `блок ${frozen.layoutBlockId}: тип результата ${result.blockType} ≠ замороженному ${frozen.blockType}`,
      );
    }
    if (result.ordinal !== frozen.sortOrder) {
      discrepancies.push(
        `блок ${frozen.layoutBlockId}: ordinal результата ${String(result.ordinal)} ≠ sortOrder ${frozen.sortOrder}`,
      );
    }
  }

  // --- сверка «результат → замороженный» (нет лишних) ------------------------
  for (const layoutBlockId of input.results.keys()) {
    if (!frozenById.has(layoutBlockId)) {
      discrepancies.push(`результат ${layoutBlockId} вне замороженного набора блоков`);
    }
  }

  if (discrepancies.length > 0) throw new RecognitionAssembleError(discrepancies);

  // --- сборка: страницы по возрастанию, блоки по ordinal ---------------------
  const orderedPages = [...pagesByIndex.values()].sort(
    (a, b) => a.workingPageIndex - b.workingPageIndex,
  );

  const pages: RecognitionPage[] = orderedPages.map((page) => {
    const pageBlocks = [...frozenById.values()]
      .filter((block) => block.workingPageIndex === page.workingPageIndex)
      .sort((a, b) =>
        a.sortOrder !== b.sortOrder
          ? a.sortOrder - b.sortOrder
          : a.layoutBlockId < b.layoutBlockId
            ? -1
            : a.layoutBlockId > b.layoutBlockId
              ? 1
              : 0,
      )
      // Наличие результата доказано сверкой выше; `as` здесь нет — get типизирован.
      .map((block) => input.results.get(block.layoutBlockId))
      .filter((block): block is RecognitionBlock => block !== undefined);

    return {
      workingPageIndex: page.workingPageIndex,
      rotation: page.rotation,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      /** Текст страницы VLM-пути всегда собирает рендерер (см. шапку файла). */
      text: null,
      blocks: pageBlocks,
    };
  });

  const result = {
    schemaVersion: RECOGNITION_RESULT_SCHEMA_VERSION,
    source: {
      provider: input.source.provider,
      adapterVersion: input.source.adapterVersion,
      modelId: input.modelId,
      /** Момент генерации проставляет финализация при записи артефакта. */
      generatedAt: null,
    },
    pages,
    warnings: [],
  };

  // Финальная валидация канона: superRefine §11 (подписанные ссылки на кропы)
  // и порядок страниц срабатывают сами; их нарушение — ZodError, а не
  // RecognitionAssembleError, потому что это дефект содержимого, а не сверки.
  return recognitionResultSchema.parse(result);
}
