/**
 * Задача `layout.detect_local`: растеризация страницы + RF-DETR ONNX на CPU
 * (ADR-0008) — локальный аналог задачи 7 (`layout.detect_pages` в `markup.ts`),
 * без похода в RD WEB.
 *
 * ## Чем отличается от `layout.detect_pages`
 *
 * У легаси-детекции решение «пропустить уже размеченную страницу без
 * `overwriteExisting`» принимает УДАЛЁННАЯ сторона (RD WEB возвращает такие
 * страницы в `skipped_pages`). У локальной детекции удалённой стороны нет —
 * это решение обязан принять сам обработчик ДО рендера и инференса, иначе
 * повторный прогон без флага перезаписи тратил бы CPU на страницы, которые
 * всё равно не изменятся. Правило «страница с РУЧНЫМ блоком не трогается
 * никогда» при этом остаётся за репозиторием (`importDetectedBlocks` →
 * `pagesWithManualBlocks`) — та же защита, что и у легаси-пути, а не вторая
 * реализация того же правила.
 *
 * ## Терминальность пустой страницы
 *
 * Страница, на которой детектор не нашёл ни одного блока, — это не отказ:
 * `deps.importBlocks` вызывается и для неё (с пустым списком блоков), задача
 * завершается успехом, а `layout.analyze_coverage` пометит страницу флагом
 * `no_blocks` тем же механизмом, что и у легаси-пути (страница без единого
 * блока в карте). Ничего специально «замораживать» от повторной детекции не
 * нужно: следующий явный запуск локальной детекции по этой же странице
 * задействует тот же движок и с высокой вероятностью повторит тот же
 * результат — а бесконечного цикла нет, потому что ничто, кроме явного
 * действия оператора (кнопка «Разметить»/«Передетектировать»), эту задачу не
 * переставляет; ограничение на случай сбоя — `maxAttempts: 3` самой задачи.
 *
 * ## Отказ страницы vs отказ задачи
 *
 * Три класса проблем ведут себя по-разному:
 * - конфигурация локальной детекции целиком не готова (пустая версия модели,
 *   нет весов/манифеста в хранилище, нет растеризатора) — `DetectionConfigurationError`
 *   валит ВСЮ задачу до единой страницы: чинить это способен только оператор,
 *   и попытка «размечить хотя бы часть» дала бы бессмысленно частичный результат;
 * - рендер ОДНОЙ страницы не удался или её размер разошёлся с картой рабочего
 *   документа сверх допуска — страница пропускается с диагностикой в журнале,
 *   остальные страницы пачки обрабатываются, задача завершается успехом (её
 *   единственный обязанный результат — не соврать про то, что не смогла);
 * - инференс ONNX бросил исключение (`DetectionModelMismatchError` и подобные)
 *   — это НЕ частная проблема страницы: манифест не соответствует графу для
 *   ЛЮБОЙ страницы одинаково, поэтому исключение НЕ ловится в цикле по
 *   страницам и валит всю задачу — продолжать перебор остальных страниц
 *   сломанной моделью означало бы тратить CPU на заведомо испорченный результат.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  errorDigest,
  RASTER_DPI,
  type BundlePageView,
  type DetectedBlockInput,
  type JobContext,
  type JobHandler,
  type PageRasterizer,
} from '@id/api';
import {
  applyParamOverrides,
  describeAppliedOverrides,
  INFERENCE_MODE_AUTO,
  type Candidate,
  type InferenceMode,
  type InferenceParamOverrides,
} from '@id/detection';

import { detectPage } from '../detection/detector.js';
import { DetectionConfigurationError } from '../detection/errors.js';
import type { ModelStore } from '../detection/model-store.js';
import { MarkupStateError, type MarkupTarget } from './markup.js';

export interface LocalDetectionDeps {
  /** `null` — на воркере нет `pdftoppm`: задача отказывает честно (§ выше). */
  readonly rasterizer: PageRasterizer | null;
  readonly modelStore: ModelStore;
  /** Каталог временных копий; по умолчанию системный (паттерн `bundle-build.ts`). */
  readonly workDirBase?: string | undefined;

  /**
   * Цель задачи по ЯВНОМУ `layoutRevisionId` — как у `layout.detect_pages`
   * (`layoutPayload` не несёт `bundleId`, сверять не с чем; `bundleId`
   * приходит УЖЕ ВНУТРИ `MarkupTarget`).
   */
  loadTargetByLayout(input: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
  }): Promise<MarkupTarget | null>;

  /**
   * Настройки детекции портала: версия модели и ручки качества.
   *
   * Читаются ЗДЕСЬ, а не на постановке: роут, ставящий задачу, не знает про
   * воркерский стор моделей, а значения могли смениться между постановкой и
   * исполнением (действуют на новые прогоны, ADR-0008).
   *
   * Поля переопределений необязательны — тесты и легаси-вызовы передают только
   * версию, и это означает «всё из манифеста», ровно как незаполненная
   * карточка в админке.
   */
  detectionSettings(): Promise<{
    readonly modelVersion: string;
    readonly inferenceMode?: InferenceMode | typeof INFERENCE_MODE_AUTO;
    readonly overrides?: InferenceParamOverrides;
  }>;

  /** Карта страниц рабочего документа с размерами и поворотом (`sourcePages`). */
  pageGeometry(input: {
    readonly revisionId: string;
    readonly bundleId: string;
  }): Promise<readonly BundlePageView[]>;

  /**
   * Страницы (из запрошенного списка), у которых УЖЕ есть хотя бы один блок
   * (любого `source`) — для skip-правила «есть блоки и не overwriteExisting».
   * Ручных блоков это НЕ заменяет: та защита — безусловно в `importBlocks`.
   */
  existingBlockPages(input: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
  }): Promise<ReadonlySet<number>>;

  fetchWorkingPdf(key: string, destinationPath: string): Promise<void>;

  importBlocks(input: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
    readonly workingPageIndices: readonly number[];
    readonly blocks: readonly DetectedBlockInput[];
  }): Promise<{ readonly imported: number; readonly skippedPages: readonly number[] }>;
}

/** Допуск расхождения рендера с картой страниц: скан/DPI не бывают идеальными. */
const RASTER_SIZE_TOLERANCE_RATIO = 0.02;
const POINTS_PER_INCH = 72;

function withinTolerance(actual: number, expected: number, ratio: number): boolean {
  if (expected <= 0) return false;
  return Math.abs(actual - expected) / expected <= ratio;
}

/**
 * Сверка размера рендера с картой рабочего документа (§ шапка файла).
 *
 * `sourcePages.widthPx/heightPx` — это `round(widthPt)` (см. `verify.ts`), то
 * есть точки PDF, округлённые до целого, НЕ пиксели рендера: единица там же,
 * где 1 pt = 1/72 дюйма. Рендер сделан на `RASTER_DPI` (300) — ожидаемый
 * размер масштабируется отношением `dpi/72` перед сравнением. Допуск ~2%
 * покрывает округления `Math.round(widthPt)` и особенности растеризатора, не
 * скрывая рендер ДРУГОГО файла или ошибку поворота.
 *
 * Расхождение, которое исчезает при перестановке сторон, — это, вероятнее
 * всего, поворот, учтённый на одной стороне сравнения и не учтённый на
 * другой: подсказка в тексте экономит время диагностики, но автокоррекции
 * здесь нет — это осознанный отказ страницы, а не молчаливая правка геометрии.
 */
function checkRenderedSize(
  rendered: { readonly widthPx: number; readonly heightPx: number },
  expected: { readonly widthPx: number; readonly heightPx: number },
  dpi: number,
): { readonly ok: boolean; readonly message: string | null } {
  const scale = dpi / POINTS_PER_INCH;
  const expectedWidth = expected.widthPx * scale;
  const expectedHeight = expected.heightPx * scale;
  const widthOk = withinTolerance(rendered.widthPx, expectedWidth, RASTER_SIZE_TOLERANCE_RATIO);
  const heightOk = withinTolerance(rendered.heightPx, expectedHeight, RASTER_SIZE_TOLERANCE_RATIO);
  if (widthOk && heightOk) return { ok: true, message: null };

  const swappedOk =
    withinTolerance(rendered.widthPx, expectedHeight, RASTER_SIZE_TOLERANCE_RATIO) &&
    withinTolerance(rendered.heightPx, expectedWidth, RASTER_SIZE_TOLERANCE_RATIO);
  const hint = swappedOk
    ? ' — совпадает при перестановке сторон, похоже на несогласованный поворот страницы'
    : '';
  return {
    ok: false,
    message:
      `рендер ${rendered.widthPx}×${rendered.heightPx} px разошёлся с картой рабочего документа ` +
      `(ожидалось ~${Math.round(expectedWidth)}×${Math.round(expectedHeight)} px при ${dpi} DPI, ` +
      `допуск ${Math.round(RASTER_SIZE_TOLERANCE_RATIO * 100)}%)${hint}`,
  };
}

/**
 * Кандидат детектора → блок для `importBlocks`.
 *
 * `sortOrder` — реалистичный fallback порядка чтения, которого у RF-DETR нет
 * (в отличие от `toDetectedBlock` в `markup.ts`, где RD WEB иногда присылает
 * свой `sort_order`): кандидаты страницы сортируются по (y0, затем x0) —
 * сверху вниз, слева направо — ОДНИМ счётчиком на страницу, без разделения по
 * `blockType`. Это НЕ проблема для канонического хэша (§`computeBlocksHash`):
 * он пересчитывает плотный ранг внутри каждой группы «страница×тип» сам,
 * сырые числа с дырами (в том числе от чужого типа между ними) для него не
 * значат ничего, кроме относительного порядка внутри своей группы — а он
 * глобальным счётчиком не нарушается.
 */
function toBlockInput(
  workingPageIndex: number,
  candidate: Candidate,
  sortOrder: number,
  modelVersion: string,
): DetectedBlockInput {
  const [x0, y0, x1, y1] = candidate.coordsNorm;
  return {
    workingPageIndex,
    blockType: candidate.blockType,
    shapeType: 'rectangle',
    x0,
    y0,
    x1,
    y1,
    sortOrder,
    points: [],
    detectionScore: candidate.score,
    detectionModelVersion: modelVersion,
  };
}

function orderReadingWise(candidates: readonly Candidate[]): readonly Candidate[] {
  return [...candidates].sort((a, b) => {
    const dy = a.coordsNorm[1] - b.coordsNorm[1];
    return dy !== 0 ? dy : a.coordsNorm[0] - b.coordsNorm[0];
  });
}

export function createLocalDetectionHandler(
  deps: LocalDetectionDeps,
): JobHandler<'layout.detect_local'> {
  return async (ctx: JobContext<'layout.detect_local'>) => {
    const target = await deps.loadTargetByLayout({
      revisionId: ctx.payload.revisionId,
      layoutRevisionId: ctx.payload.layoutRevisionId,
    });
    if (target === null) {
      throw new MarkupStateError('Ревизия разметки не найдена');
    }
    if (target.state !== 'draft') {
      throw new MarkupStateError('Замороженная разметка не принимает результаты детекции');
    }

    const pageIndices = ctx.payload.pageIndices;
    if (pageIndices === undefined || pageIndices.length === 0) {
      throw new MarkupStateError(
        'layout.detect_local поставлена без pageIndices: локальная детекция обрабатывает ' +
          'явно переданный список страниц, а не комплект неявно',
      );
    }

    // Конфигурационные отказы — до единой страницы (см. докстринг файла).
    const settings = await deps.detectionSettings();
    if (settings.modelVersion.trim() === '') {
      throw new DetectionConfigurationError(
        'модель детекции не загружена: задайте detection.model_version в администрировании ' +
          'и выложите файлы модели, прежде чем запускать локальную детекцию',
      );
    }
    if (deps.rasterizer === null) {
      throw new DetectionConfigurationError(
        'локальная детекция недоступна: на воркере не найден растеризатор PDF (нужен poppler/pdftoppm). ' +
          'Установите poppler-utils либо задайте PDFTOPPM_PATH.',
      );
    }
    const rasterizer: PageRasterizer = deps.rasterizer;

    const {
      session,
      params: manifestParamsForModel,
      warnings,
    } = await deps.modelStore.ensureModel(settings.modelVersion);
    for (const warning of warnings) {
      ctx.logger.warn({ event: 'detect_local_model_warning' }, warning);
    }

    /**
     * Настройки портала поверх параметров манифеста.
     *
     * Незаполненная карточка ничего не меняет — `applyParamOverrides` трактует
     * `null` как «из манифеста». В журнал уходит РАЗНИЦА, а не сам объект
     * настроек: «порог 0.5» в записи не отвечает на вопрос, пришёл он из
     * модели или из админки, а объяснить прошлую разметку можно только по
     * этому ответу.
     */
    const params = applyParamOverrides(manifestParamsForModel, settings.overrides);
    const appliedOverrides = describeAppliedOverrides(manifestParamsForModel, params);
    const inferenceMode = settings.inferenceMode ?? INFERENCE_MODE_AUTO;
    if (Object.keys(appliedOverrides).length > 0 || inferenceMode !== INFERENCE_MODE_AUTO) {
      ctx.logger.info(
        {
          event: 'detect_local_overrides',
          model_version: settings.modelVersion,
          inference_mode: inferenceMode,
          applied: appliedOverrides,
        },
        'параметры детекции переопределены настройками портала',
      );
    }

    const overwriteExisting = ctx.payload.overwriteExisting === true;
    const [geometry, alreadyHasBlocks] = await Promise.all([
      deps.pageGeometry({ revisionId: target.revisionId, bundleId: target.bundleId }),
      overwriteExisting
        ? Promise.resolve<ReadonlySet<number>>(new Set())
        : deps.existingBlockPages({
            revisionId: target.revisionId,
            layoutRevisionId: target.layoutRevisionId,
          }),
    ]);
    const geometryByPage = new Map(geometry.map((page) => [page.workingPageIndex, page]));

    const scratchDir = await mkdtemp(join(deps.workDirBase ?? tmpdir(), 'id-detect-local-'));
    let renderedPages = 0;
    let renderFailedPages = 0;
    let sizeMismatchPages = 0;
    let emptyPages = 0;
    const skippedExisting: number[] = [];
    const targetPageList: number[] = [];
    const perPageBlocks = new Map<number, DetectedBlockInput[]>();

    try {
      const pdfPath = join(scratchDir, 'working.pdf');
      await deps.fetchWorkingPdf(target.workingPdfKey, pdfPath);

      for (const pageIndex of pageIndices) {
        if (alreadyHasBlocks.has(pageIndex)) {
          skippedExisting.push(pageIndex);
          continue;
        }

        const page = geometryByPage.get(pageIndex);
        if (page === undefined) {
          ctx.logger.error(
            { event: 'detect_local_page_missing', page: pageIndex },
            'страницы нет в карте рабочего документа: пропущена',
          );
          continue;
        }

        const pngPath = join(scratchDir, `page-${String(pageIndex).padStart(4, '0')}.png`);
        let rendered: { readonly widthPx: number; readonly heightPx: number };
        try {
          rendered = await rasterizer.renderPage({
            pdfPath,
            pageIndex,
            dpi: RASTER_DPI,
            outPath: pngPath,
          });
        } catch (error) {
          renderFailedPages += 1;
          ctx.logger.error(
            { event: 'detect_local_render_failed', page: pageIndex, ...errorDigest(error) },
            'рендер страницы не удался: страница пропущена',
          );
          continue;
        }
        renderedPages += 1;

        const sizeCheck = checkRenderedSize(rendered, page, RASTER_DPI);
        if (!sizeCheck.ok) {
          sizeMismatchPages += 1;
          ctx.logger.error(
            {
              event: 'detect_local_size_mismatch',
              page: pageIndex,
              rendered_width: rendered.widthPx,
              rendered_height: rendered.heightPx,
              expected_width_px: page.widthPx,
              expected_height_px: page.heightPx,
              rotation: page.rotation,
            },
            sizeCheck.message ?? 'размер рендера разошёлся с картой страницы',
          );
          continue;
        }

        // Исключение отсюда НЕ ловится (см. докстринг файла): рассинхрон
        // модели/манифеста — не свойство одной страницы.
        const detected = await detectPage({
          pageIndex,
          pngPath,
          widthPx: rendered.widthPx,
          heightPx: rendered.heightPx,
          session,
          params,
          inferenceMode,
        });
        if (detected.warning !== null) {
          ctx.logger.warn(
            { event: 'detect_local_mode_mismatch', page: pageIndex },
            detected.warning,
          );
        }

        const ordered = orderReadingWise(detected.candidates);
        const blocks = ordered.map((candidate, index) =>
          toBlockInput(pageIndex, candidate, index, settings.modelVersion),
        );
        if (blocks.length === 0) emptyPages += 1;
        perPageBlocks.set(pageIndex, blocks);
        targetPageList.push(pageIndex);
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }

    let importedBlocks = 0;
    let manualSkipped: readonly number[] = [];
    if (targetPageList.length > 0) {
      const blocks = targetPageList.flatMap((page) => perPageBlocks.get(page) ?? []);
      const imported = await deps.importBlocks({
        revisionId: target.revisionId,
        layoutRevisionId: target.layoutRevisionId,
        workingPageIndices: targetPageList,
        blocks,
      });
      importedBlocks = imported.imported;
      manualSkipped = imported.skippedPages;
    }

    ctx.logger.info(
      {
        event: 'detect_local_done',
        model_version: settings.modelVersion,
        pages_requested: pageIndices.length,
        pages_skipped_existing: skippedExisting.length,
        pages_rendered: renderedPages,
        pages_render_failed: renderFailedPages,
        pages_size_mismatch: sizeMismatchPages,
        pages_empty: emptyPages,
        pages_manual_skipped: manualSkipped.length,
        imported: importedBlocks,
        overwrite_existing: overwriteExisting,
      },
      'локальная детекция страниц завершена',
    );

    // Тот же dedupeKey-паттерн, что у легаси-пути (markup.ts): анализ покрытия
    // считает флаги по всему комплекту и идемпотентен, лишний запуск безвреден.
    await ctx.enqueue({
      type: 'layout.analyze_coverage',
      payload: { revisionId: target.revisionId, layoutRevisionId: target.layoutRevisionId },
      dedupeKey: `layout.analyze_coverage:${target.layoutRevisionId}`,
      runAfterMs: 1_000,
    });
  };
}
