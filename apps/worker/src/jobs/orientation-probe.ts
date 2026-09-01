/**
 * Задача `page.orientation_probe` — в какую сторону повёрнут скан (ADR-0020).
 *
 * ## Что она отвечает и почему это отдельная задача
 *
 * У страницы два поворота. `/Rotate` из PDF портал читает при пробинге, и он к
 * моменту растеризации уже применён. А скан, положенный на лист боком при
 * нулевом `/Rotate`, не видит никто: именно из-за него страница 4 эталонного
 * комплекта распозналась наполовину — модель сняла строчный текст и потеряла
 * таблицу целиком.
 *
 * Зонд — отдельная задача, а не шаг детекции и не шаг распознавания. По времени
 * он обязан отработать ДО детекции, значит внутри `vlm.recognize_page` быть не
 * может. По существу он не должен быть и шагом `layout.detect_local` — довод
 * дословно тот, что записан в шапке `signature-probe.ts`: у них разные
 * последствия. Отказ детекции оставляет страницу без блоков; отказ зонда не
 * имеет права останавливать конвейер вовсе. Смешав их, мы дали бы одному
 * таймауту шлюза сжигать 600-секундную аренду очереди `cpu` и переигрывать
 * вместе с собой ONNX-инференс.
 *
 * ## Детекция ставится в ЛЮБОМ исходе
 *
 * Постановка `layout.detect_local` лежит на пути, который выполняется и когда
 * зонд ответил, и когда он отказал. Одна недоступность шлюза не имеет права
 * оставить комплект неразмеченным — а именно так и вышло бы, будь детекция
 * следствием успеха.
 *
 * ## Картинка — миниатюра, а не растр распознавания
 *
 * Рендер идёт при 72 DPI (A4 → 595×842) с потолком длинной стороны 1024 px.
 * Вопрос «в какую сторону бежит текст» отвечается по миниатюре; рендер A0 на
 * 300 DPI стоил бы секунды и сотни мегабайт ради результата, который всё равно
 * будет уменьшен. Потолок берётся ЧЕРЕЗ `cropBlockPng` с прямоугольником во всю
 * страницу: второй путь ресемплинга заводить незачем, а побочный выигрыш в том,
 * что картинка зонда попадает под ту же версию crop policy.
 *
 * ## Что делает низкая уверенность
 *
 * Мнение записывается, действующее значение остаётся нулевым. Асимметрия цены:
 * не повернуть повёрнутую страницу — потерять то, что теряется и сегодня;
 * повернуть прямую — сломать страницу, которая работала.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';

import type { JobContext, JobHandler, LlmProviderName } from '@id/api';
import type { ContentRotation } from '@id/contracts';

/**
 * Порог уверенности зонда.
 *
 * Константа, а не настройка: это часть политики разворота, и настройка дала бы
 * два прогона с одной версией политики и разными поворотами — дословно тот
 * довод, которым `crop.ts` объясняет, почему потолок кропа не настраивается.
 */
export const ORIENTATION_MIN_CONFIDENCE = 0.6;

/** DPI миниатюры. Совпадает с `POINTS_PER_INCH`: A4 выходит 595×842. */
export const ORIENTATION_PROBE_DPI = 72;

/** Потолок длинной стороны миниатюры, px. */
export const ORIENTATION_PROBE_MAX_LONG_EDGE_PX = 1024;

/**
 * Потолок ожидания ответа модели для ЗОНДА, мс (S41).
 *
 * Общий `LLM_TIMEOUT_MS` рассчитан на распознавание крупного блока и в проде
 * равен 450 секундам — вчетверо больше, чем аренда самой задачи зонда (120 с).
 * Аренда же работает и потолком попытки, поэтому медленный вызов гарантированно
 * оканчивался `JobTimeout`, три попытки подряд убивали зонд, а мёртвый зонд не
 * ставит детекцию своей страницы: лист оставался неразмеченным без внятной
 * причины на экране.
 *
 * Минута — с запасом: зонд смотрит на миниатюру 1024 px и отвечает одним
 * коротким JSON. Вызов, не уложившийся в неё, не станет полезнее на второй.
 */
export const PROBE_CALL_TIMEOUT_MS = 60_000;

export const ORIENTATION_PROBE_JOB_TYPE = 'page.orientation_probe';

export interface OrientationProbeAnswer {
  readonly rotation: ContentRotation;
  readonly confidence: number | null;
  readonly evidence: string | null;
}

export interface OrientationProbeCall {
  readonly promptCode: string;
  readonly promptVersion: number;
  readonly model: string;
  readonly provider: LlmProviderName;
  readonly inputHash: string;
  readonly outputHash: string | null;
  readonly answer: OrientationProbeAnswer;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
  readonly latencyMs: number | null;
}

export interface OrientationProbeDeps {
  /** `false` — зонд выключен настройкой: детекция ставится, вызова нет. */
  readonly probeEnabled: () => Promise<boolean>;
  /** `true` — режим `ai.dry_run_only`: вызова нет, строка пишется с причиной. */
  readonly dryRun: () => Promise<boolean>;
  /**
   * Уже решённый разворот этой страницы.
   *
   * `null` — строки нет. `source='user'` означает, что человек уже повернул
   * страницу руками, и зонду здесь делать нечего: его вызов был бы оплачен ради
   * значения, которое ON CONFLICT всё равно не запишет.
   *
   * `answered` (S41) — отвечал ли зонд по существу. Строка от зонда бывает и
   * записью об отказе (`probe_error`), и такую страницу спросить заново нужно,
   * а вот уже полученное мнение обязано переиспользоваться: повторный запуск
   * разметки на 220 страниц иначе платит за 220 одинаковых вызовов, и
   * пользователь эти минуты видит как «разметка стоит на нуле».
   */
  readonly existingSource: (input: {
    readonly folderId: string;
    readonly sourcePageId: string;
  }) => Promise<{ readonly source: 'probe' | 'user'; readonly answered: boolean } | null>;
  /** Рабочий PDF во временный файл; `cleanup` зовётся в `finally`. */
  readonly workingPdfToFile: (
    bundleId: string,
  ) => Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }>;
  readonly renderPage: (input: {
    readonly pdfPath: string;
    readonly pageIndex: number;
    readonly dpi: number;
    readonly outPath: string;
    /** Отмена попытки: внешний процесс рендера снимается сразу (S41). */
    readonly signal?: AbortSignal | undefined;
  }) => Promise<{ readonly widthPx: number; readonly heightPx: number }>;
  /** Миниатюра страницы: тот же `cropBlockPng`, прямоугольник во весь лист. */
  readonly thumbnail: (input: {
    readonly pagePngPath: string;
    readonly widthPx: number;
    readonly heightPx: number;
  }) => Promise<Uint8Array | null>;
  /** Единственный вызов модели. Бросает — значит зонд не ответил. */
  readonly probe: (input: {
    readonly png: Uint8Array;
    readonly pageNumber: number;
    /** Отмена попытки: брошенный вызов не держит соединение до ответа (S41). */
    readonly signal?: AbortSignal | undefined;
    /** Потолок ОДНОГО вызова: он обязан быть меньше аренды задачи (S41). */
    readonly timeoutMs?: number | undefined;
  }) => Promise<OrientationProbeCall>;
  readonly saveOrientation: (input: {
    readonly folderId: string;
    readonly sourcePageId: string;
    readonly rotation: ContentRotation | null;
    readonly confidence: number | null;
    readonly effective: ContentRotation;
    readonly model: string | null;
    readonly promptCode: string | null;
    readonly promptVersion: number | null;
    readonly inputHash: string | null;
    readonly error: string | null;
  }) => Promise<boolean>;
  readonly recordAiRun: (input: {
    readonly folderId: string;
    readonly stage: 'orientation';
    readonly provider: LlmProviderName;
    readonly model: string;
    readonly promptCode: string;
    readonly promptVersion: number;
    readonly inputHash: string;
    readonly outputHash: string | null;
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    readonly cost: number | null;
    readonly latencyMs: number | null;
    readonly structuredResult: unknown;
    readonly requestId: string | null;
  }) => Promise<void>;
  /**
   * Постановка детекции этой страницы. Зовётся в ЛЮБОМ исходе зонда.
   *
   * Журнал прокидывается из контекста задачи, а не берётся из настроек
   * связывания: постановка обязана попасть в тот же поток событий, что и сама
   * задача, иначе «детекция поставлена» окажется в другом месте, чем «зонд
   * ответил», и связать их будет нечем.
   */
  readonly enqueueDetection: (input: {
    readonly folderId: string;
    readonly layoutRevisionId: string;
    readonly workingPageIndex: number;
    readonly logger: JobContext<'page.orientation_probe'>['logger'];
  }) => Promise<void>;
  /** Отчёт о качестве: «зонд не отработал» и «зонд не уверен» — разные коды. */
  readonly reportFeedback: (input: {
    readonly folderId: string;
    readonly sourcePageId: string;
    readonly workingPageIndex: number;
    readonly reasonCode: 'orientation.probe_failed' | 'orientation.low_confidence';
    readonly detail: string;
  }) => Promise<void>;
  /** Классификация отказа: повторяемый уходит наверх, движок повторит сам. */
  readonly isRetriable: (error: unknown) => boolean;
  readonly workDirBase?: string | undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 400);
  return String(error).slice(0, 400);
}

export function createOrientationProbeHandler(
  deps: OrientationProbeDeps,
): JobHandler<'page.orientation_probe'> {
  return async (ctx: JobContext<'page.orientation_probe'>): Promise<void> => {
    const { folderId, layoutRevisionId, bundleId, sourcePageId, workingPageIndex } = ctx.payload;

    /**
     * Детекция ставится в `finally`-стиле: одним вызовом на выходе из любой
     * ветки. Дублировать её по веткам значило бы однажды забыть одну — и
     * комплект остался бы неразмеченным без единого сообщения об ошибке.
     */
    const continueWithDetection = async (): Promise<void> => {
      await deps.enqueueDetection({
        folderId,
        layoutRevisionId,
        workingPageIndex,
        logger: ctx.logger,
      });
    };

    if (!(await deps.probeEnabled())) {
      ctx.logger.info(
        { event: 'orientation_probe_disabled', working_page_index: workingPageIndex },
        'зонд ориентации выключен настройкой: страница считается прямой',
      );
      await continueWithDetection();
      return;
    }

    // Человек уже развернул страницу руками — его значение сильнее зонда по
    // построению, и платить за вызов, результат которого ON CONFLICT не
    // запишет, незачем.
    const existing = await deps.existingSource({ folderId, sourcePageId });
    if (existing?.source === 'user') {
      ctx.logger.info(
        { event: 'orientation_probe_skipped_manual', working_page_index: workingPageIndex },
        'разворот страницы задан вручную: зонд не вызывается',
      );
      await continueWithDetection();
      return;
    }

    /**
     * Мнение зонда уже есть — второй раз за него не платим (S41).
     *
     * Разворот — свойство скана, а не результата конвейера: страница, снятая
     * боком, останется такой при любом повторном запуске разметки. Прежде
     * повтор стоил 220 вызовов модели на комплект и столько же минут ожидания.
     * Записанный ОТКАЗ зонда сюда не подходит: там мнения нет, и спросить
     * заново — единственный способ его получить.
     */
    if (existing?.source === 'probe' && existing.answered) {
      ctx.logger.info(
        { event: 'orientation_probe_reused', working_page_index: workingPageIndex },
        'разворот страницы уже определён зондом: вызов не повторяется',
      );
      await continueWithDetection();
      return;
    }

    if (await deps.dryRun()) {
      await deps.saveOrientation({
        folderId,
        sourcePageId,
        rotation: null,
        confidence: null,
        effective: 0,
        model: null,
        promptCode: null,
        promptVersion: null,
        inputHash: null,
        error: 'ai.dry_run_only',
      });
      await continueWithDetection();
      return;
    }

    const outPath = join(
      deps.workDirBase ?? tmpdir(),
      `orientation-${folderId}-${String(workingPageIndex)}-${randomUUID()}.png`,
    );

    let failure: string | null = null;
    let call: OrientationProbeCall | null = null;
    const pdf = await deps.workingPdfToFile(bundleId);
    try {
      const rendered = await deps.renderPage({
        pdfPath: pdf.path,
        pageIndex: workingPageIndex,
        dpi: ORIENTATION_PROBE_DPI,
        outPath,
        signal: ctx.signal,
      });
      const png = await deps.thumbnail({
        pagePngPath: outPath,
        widthPx: rendered.widthPx,
        heightPx: rendered.heightPx,
      });
      if (png === null) {
        failure = 'миниатюра страницы вырождена';
      } else {
        call = await deps.probe({
          png,
          pageNumber: workingPageIndex + 1,
          signal: ctx.signal,
          timeoutMs: PROBE_CALL_TIMEOUT_MS,
        });
      }
    } catch (error) {
      /**
       * Отмена попытки — не отказ зонда (S41).
       *
       * Записать её как отказ значило бы сохранить страницу с причиной «зонд не
       * ответил» и поставить детекцию, тогда как на самом деле попытка просто
       * не состоялась: её потолок истёк или аренду забрал другой воркер. Мнение
       * о развороте осталось бы ложным до тех пор, пока страницу не тронет
       * человек, — и это ровно тот сорт молчаливой порчи данных, ради которого
       * зонд вообще заведён.
       */
      if (ctx.signal.aborted) throw error;

      /**
       * Повторяемый отказ шлюза пробрасывается — движок повторит задачу сам.
       *
       * Отличие от `signature-probe.ts`, который глотает всё: там зонд
       * локальный, разбор байтов, и повтор ничего не меняет. Здесь транзиентный
       * 429 стоит одной повторной попытки, а восемьдесят три непрозондированные
       * страницы после минутной недоступности шлюза — молчаливая потеря.
       *
       * На ПОСЛЕДНЕЙ попытке отказ уже не пробрасывается: иначе задача умерла
       * бы, не поставив детекцию, и комплект остался бы неразмеченным.
       */
      const exhausted = ctx.attempt >= ctx.maxAttempts;
      if (!exhausted && deps.isRetriable(error)) throw error;
      failure = describeError(error);
    } finally {
      await pdf.cleanup();
      await unlink(outPath).catch(() => undefined);
    }

    if (call === null) {
      const detail = failure ?? 'зонд не дал ответа';
      await deps.saveOrientation({
        folderId,
        sourcePageId,
        rotation: null,
        confidence: null,
        effective: 0,
        model: null,
        promptCode: null,
        promptVersion: null,
        inputHash: null,
        error: detail,
      });
      await deps.reportFeedback({
        folderId,
        sourcePageId,
        workingPageIndex,
        reasonCode: 'orientation.probe_failed',
        detail,
      });
      ctx.logger.warn(
        { event: 'orientation_probe_failed', working_page_index: workingPageIndex, detail },
        'зонд ориентации не дал ответа: страница считается прямой',
      );
      await continueWithDetection();
      return;
    }

    const { answer } = call;
    const confident = answer.confidence === null || answer.confidence >= ORIENTATION_MIN_CONFIDENCE;
    const effective: ContentRotation = confident ? answer.rotation : 0;

    const written = await deps.saveOrientation({
      folderId,
      sourcePageId,
      rotation: answer.rotation,
      confidence: answer.confidence,
      effective,
      model: call.model,
      promptCode: call.promptCode,
      promptVersion: call.promptVersion,
      inputHash: call.inputHash,
      error: null,
    });

    await deps.recordAiRun({
      folderId,
      stage: 'orientation',
      provider: call.provider,
      model: call.model,
      promptCode: call.promptCode,
      promptVersion: call.promptVersion,
      inputHash: call.inputHash,
      outputHash: call.outputHash,
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
      cost: call.cost,
      latencyMs: call.latencyMs,
      structuredResult: {
        sourcePageId,
        workingPageIndex,
        rotation: answer.rotation,
        confidence: answer.confidence,
        effective,
        dpi: ORIENTATION_PROBE_DPI,
        maxLongEdgePx: ORIENTATION_PROBE_MAX_LONG_EDGE_PX,
      },
      requestId: null,
    });

    if (!confident && answer.rotation !== 0) {
      await deps.reportFeedback({
        folderId,
        sourcePageId,
        workingPageIndex,
        reasonCode: 'orientation.low_confidence',
        detail: `зонд предложил ${String(answer.rotation)}° при уверенности ${String(answer.confidence)}`,
      });
    }

    ctx.logger.info(
      {
        event: 'orientation_probe_done',
        working_page_index: workingPageIndex,
        rotation: answer.rotation,
        effective,
        confidence: answer.confidence,
        // `false` означает: пока зонд летел, страницу развернули руками, и его
        // ответ не записан. Не ошибка — но и не то же самое, что запись.
        written,
      },
      'разворот страницы определён зондом',
    );

    await continueWithDetection();
  };
}
