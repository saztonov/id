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
  effectiveRasterDpi,
  errorDigest,
  type BundlePageView,
  type DetectedBlockInput,
  type JobContext,
  type JobHandler,
  type PageRasterizer,
  type ProcessingFeedbackSink,
} from '@id/api';
import {
  applyParamOverrides,
  describeAppliedOverrides,
  DETECTION_BLOCK_TYPES,
  INFERENCE_MODE_AUTO,
  inverseTurn,
  rotateRectNorm,
  type Candidate,
  type DetectPageStats,
  type InferenceMode,
  type InferenceParamOverrides,
  type Rect,
} from '@id/detection';

import { detectPage } from '../detection/detector.js';
import { rotatePagePng } from '../detection/preprocess.js';
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
   * Обратная связь конвейера (поток C, ADR-0010): почему страница осталась без
   * блоков. Необязательна — без неё задача работает как раньше, только молча.
   */
  readonly feedback?: ProcessingFeedbackSink | undefined;

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

  /**
   * Рабочий PDF комплекта на диске (S41).
   *
   * Возвращает файл в аренду, а не скачивает по указанному пути: документ один
   * на весь комплект и иммутабелен, поэтому 220 задач детекции читают ОДНУ
   * копию. `release` обязателен — пока аренда держится, кэш файл не вытесняет.
   */
  workingPdf(
    key: string,
  ): Promise<{ readonly path: string; readonly release: () => Promise<void> }>;

  importBlocks(input: {
    readonly revisionId: string;
    readonly layoutRevisionId: string;
    readonly workingPageIndices: readonly number[];
    readonly blocks: readonly DetectedBlockInput[];
  }): Promise<{ readonly imported: number; readonly skippedPages: readonly number[] }>;
}

/**
 * Доля порога, ниже которой снижать порог уже бессмысленно.
 *
 * Разделяет два разных сообщения на одном и том же внешнем признаке «блоков
 * нет». Лучший непринятый кандидат на 0.45 при пороге 0.5 означает «порог
 * виноват, снизьте его»; на 0.000002 — «модель не увидела ничего, порог ни при
 * чём». Половина порога выбрана как заведомо консервативная граница: она не
 * обещает, что снижение поможет, а только отделяет случай, где его стоит
 * попробовать.
 */
const LOW_SCORE_HINT_RATIO = 0.5;

/** Лучшая уверенность среди непринятых по всем типам, либо `null`. */
function bestRejected(stats: DetectPageStats): number | null {
  let best: number | null = null;
  for (const type of DETECTION_BLOCK_TYPES) {
    const score = stats.bestRejectedScore[type];
    if (score !== undefined && (best === null || score > best)) best = score;
  }
  return best;
}

/**
 * Записать в обратную связь конвейера, почему страница осталась без блоков.
 *
 * Коды `detect.no_blocks` и `detect.low_score` были заведены заранее
 * (миграция 0024), но их никто не писал: `DetectPageStats` считалась и
 * выбрасывалась. Из-за этого на вопрос «почему страница 49 не обведена»
 * ответить было нечем — оставался жёлтый бейдж «Блоков не найдено», который
 * называет симптом, а не причину.
 *
 * Записывается ОДИН код на страницу, а не оба: у них разный смысл и разное
 * следствие для оператора, и две записи на одно событие сделали бы годовой ряд
 * по причинам нечитаемым.
 *
 * Значения полей сюда не попадают — только счётчики и уверенности (§11).
 */
async function recordEmptyPageFeedback(
  deps: LocalDetectionDeps,
  input: {
    readonly revisionId: string;
    readonly sourcePageId: string;
    readonly workingPageIndex: number;
    readonly modelVersion: string;
    readonly threshold: number;
    readonly stats: DetectPageStats;
  },
): Promise<void> {
  const sink = deps.feedback;
  if (sink === undefined) return;

  const best = bestRejected(input.stats);
  const nearThreshold = best !== null && best >= input.threshold * LOW_SCORE_HINT_RATIO;

  await sink.record({
    // Тип из закрытого перечня (миграция 0024): отдельного «wrong_detection»
    // в нём нет, а `recognition_failure` — ближайший по смыслу «конвейер не
    // получил того, что должен был». Различает случаи код причины, по нему же
    // строится годовой ряд.
    feedbackType: 'recognition_failure',
    reasonCode: nearThreshold ? 'detect.low_score' : 'detect.no_blocks',
    severity: 'warn',
    revisionId: input.revisionId,
    sourcePageId: input.sourcePageId,
    workingPageIndex: input.workingPageIndex,
    pipelineStage: 'detect',
    detectorModelVersion: input.modelVersion,
    ...(best === null ? {} : { score: best }),
    observed: {
      threshold: input.threshold,
      best_rejected_score: best,
      raw_by_type: input.stats.rawByType,
      after_nms: input.stats.afterNms,
      after_threshold: input.stats.afterThreshold,
      rejected_min_box: input.stats.rejectedMinBox,
      tiles_planned: input.stats.tilesPlanned,
      tiles_inferred: input.stats.tilesInferred,
    },
  });
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
 * где 1 pt = 1/72 дюйма. Рендер сделан на разрешении, которое вернул
 * `effectiveRasterDpi` для этой страницы (300 для обычных форматов, меньше для
 * крупноформатных листов), — ожидаемый размер масштабируется отношением
 * `dpi/72` перед сравнением, и разрешение поэтому передаётся параметром. Допуск ~2%
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
      /**
       * Разметку вытеснили, пока пачка ждала исполнителя. Это не ошибка — это
       * «опоздал, уже не нужно»: результаты этой пачки писать больше некуда.
       *
       * Прежде сюда приводила заморозка, и отказ здесь стоил дорого: одно
       * преждевременное нажатие «Распознать» убивало КАЖДУЮ невыполненную
       * постраничную пачку, а `MarkupStateError` не объявляет `retriable`, то
       * есть считается преходящей — каждая убитая пачка сжигала все пять
       * попыток. Тридцать пять «исчерпали попытки» в журнале от одного нажатия
       * появились именно так.
       *
       * Заморозки нет (0048), и остановить незаконченную детекцию теперь обязан
       * тот, кто запускает прогон: маршрут «Проверить» либо отказывает, либо
       * снимает остаток с очереди. Пачка, уже взятая воркером, доложит блоки —
       * и прогон, стартовавший по прежнему набору, честно остановится своим
       * гейтом целостности, а не примет половину разметки молча.
       */
      ctx.logger.info(
        {
          event: 'detection_batch_obsolete',
          layout_revision_id: target.layoutRevisionId,
          layout_state: target.state,
          pages: ctx.payload.pageIndices?.length ?? 0,
        },
        'разметка уже не черновик: пачка детекции устарела и пропущена',
      );
      return;
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
    let rotatedPages = 0;
    let renderFailedPages = 0;
    let sizeMismatchPages = 0;
    let emptyPages = 0;
    const skippedExisting: number[] = [];
    const targetPageList: number[] = [];
    const perPageBlocks = new Map<number, DetectedBlockInput[]>();

    const pdf = await deps.workingPdf(target.workingPdfKey);
    const pdfPath = pdf.path;
    try {
      for (const pageIndex of pageIndices) {
        /**
         * Отменённую попытку не продолжаем (S41).
         *
         * Отмена приходит, когда попытка исчерпала потолок или аренду забрал
         * другой воркер: движок к этому времени уже отдал слот следующей задаче.
         * Без этой проверки брошенный обход продолжал рендерить и считать
         * инференс рядом с новой задачей, то есть перегруженный воркер сам
         * удваивал свою нагрузку — и ровно так лечение параллелизмом
         * оказывалось наполовину фиктивным. Причина отмены (`JobTimeout`,
         * `LeaseLost`) бросается как есть: она и есть настоящий исход попытки.
         */
        ctx.signal.throwIfAborted();

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
        /**
         * Разрешение считается от размеров ЭТОЙ страницы (S41).
         *
         * Крупноформатные листы на 300 DPI занимают сотни мегабайт сырого
         * растра и укладывали воркер при любом параллелизме очереди: потолок
         * очереди ограничивает число задач, а не аппетит одной. Для A4–A2
         * функция возвращает те же 300.
         */
        const dpi = effectiveRasterDpi(page.widthPx, page.heightPx);
        let rendered: { readonly widthPx: number; readonly heightPx: number };
        try {
          rendered = await rasterizer.renderPage({
            pdfPath,
            pageIndex,
            dpi,
            outPath: pngPath,
            signal: ctx.signal,
          });
        } catch (error) {
          // Отмена — не отказ рендера: считать её «страница не отрендерилась»
          // значило бы молча пропустить страницу и записать пачку без неё.
          if (ctx.signal.aborted) throw error;
          renderFailedPages += 1;
          ctx.logger.error(
            { event: 'detect_local_render_failed', page: pageIndex, ...errorDigest(error) },
            'рендер страницы не удался: страница пропущена',
          );
          continue;
        }
        renderedPages += 1;

        // Сверка идёт по ФАКТИЧЕСКОМУ разрешению рендера: с константой она
        // объявляла бы уменьшенный лист несогласованным с картой страниц.
        const sizeCheck = checkRenderedSize(rendered, page, dpi);
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

        /**
         * Разворот содержимого перед инференсом (ADR-0020).
         *
         * ПОСЛЕ `checkRenderedSize`: та сверяет СЫРОЙ рендер с картой страниц и
         * ловит подменённый файл или несогласованный `/Rotate`. Её подсказка
         * «совпадает при перестановке сторон» стала бы ложью, если бы стороны
         * переставляли мы сами.
         *
         * Ноль — полный no-op: ни одного лишнего декода. Детекция идёт по всему
         * комплекту, и лишний проход sharp на каждой прямой странице стоил бы
         * заметно, не давая ничего.
         */
        const contentRotation = page.contentRotation;
        let inferencePath = pngPath;
        let inferenceSize = { widthPx: rendered.widthPx, heightPx: rendered.heightPx };
        if (contentRotation !== 0) {
          const turnedPath = join(
            scratchDir,
            `page-${String(pageIndex).padStart(4, '0')}-r${String(contentRotation)}.png`,
          );
          inferenceSize = await rotatePagePng(pngPath, turnedPath, contentRotation);
          inferencePath = turnedPath;
          rotatedPages += 1;
        }

        // Исключение отсюда НЕ ловится (см. докстринг файла): рассинхрон
        // модели/манифеста — не свойство одной страницы.
        const detected = await detectPage({
          pageIndex,
          pngPath: inferencePath,
          widthPx: inferenceSize.widthPx,
          heightPx: inferenceSize.heightPx,
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

        /**
         * Порядок чтения считается в РАЗВЁРНУТОМ фрейме, а координаты
         * возвращаются в систему страницы.
         *
         * Порядок — свойство человеческого чтения: «сверху вниз, слева направо»
         * на боковом листе идёт по другой оси, и отсортировав до обратного
         * поворота, мы получили бы порядок, в котором текст страницы собрался бы
         * задом наперёд. Координаты же обязаны остаться там, где их рисует
         * экран разметки, — то есть в системе неповёрнутой страницы.
         */
        const ordered = orderReadingWise(detected.candidates);
        const blocks = ordered.map((candidate, index) =>
          toBlockInput(
            pageIndex,
            contentRotation === 0
              ? candidate
              : {
                  ...candidate,
                  coordsNorm: rotateRectNorm(
                    [...candidate.coordsNorm] as Rect,
                    inverseTurn(contentRotation),
                  ),
                },
            index,
            settings.modelVersion,
          ),
        );

        // Постраничная сводка: раньше `DetectPageStats` считалась и
        // выбрасывалась, а в журнал уходил только итог по всей пачке. Из-за
        // этого «страница не обведена» нельзя было объяснить: неизвестно,
        // сколько кандидатов было до порога и насколько близко подошёл лучший
        // непринятый.
        ctx.logger.info(
          {
            event: 'detect_local_page_stats',
            page: pageIndex,
            content_rotation: contentRotation,
            mode: detected.mode,
            mode_source: detected.modeSource,
            raw_by_type: detected.stats.rawByType,
            after_nms: detected.stats.afterNms,
            after_merge: detected.stats.afterMerge,
            after_threshold: detected.stats.afterThreshold,
            final_by_type: detected.stats.finalByType,
            rejected_min_box: detected.stats.rejectedMinBox,
            best_rejected_score: detected.stats.bestRejectedScore,
            threshold: params.defaultThreshold,
          },
          'детекция страницы завершена',
        );

        if (blocks.length === 0) {
          emptyPages += 1;
          await recordEmptyPageFeedback(deps, {
            revisionId: target.revisionId,
            sourcePageId: page.sourcePageId,
            workingPageIndex: pageIndex,
            modelVersion: settings.modelVersion,
            threshold: params.defaultThreshold,
            stats: detected.stats,
          });
        }
        perPageBlocks.set(pageIndex, blocks);
        targetPageList.push(pageIndex);
      }
    } finally {
      await pdf.release();
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
        pages_rotated: rotatedPages,
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
