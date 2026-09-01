/**
 * Задачи 14–19 конвейера: сегментация, реквизиты, реестр, граф (§8, §12).
 *
 * Обработчики написаны на портах (`SegmentationDeps`); связывание с базой и
 * провайдером модели живёт в `pipeline.ts`. Разделение то же, что у задач 1–13,
 * и по той же причине (урок S3: слой, который никто не вызывает, выглядит
 * рабочим и покрыт зелёными тестами).
 *
 * ## Открытый мир — не оговорка, а поведение по умолчанию
 *
 * Корпус покрывает два раздела работ из многих (§0.5). Поэтому ни один
 * обработчик здесь не имеет права трактовать «я не знаю этот вид документа»
 * как ошибку. Незнакомый документ получает резервный тип, его заголовок уходит
 * в `doc_type_candidates`, базовые реквизиты извлекаются наравне со знакомыми,
 * а границы соседних документов не меняются. Отсутствие опубликованного промта,
 * отключённый провайдер модели и исчерпанный бюджет — тоже не отказ конвейера:
 * фаза 2 пропускается с названной причиной, а фаза 1 уже дала результат.
 *
 * ## Почему каждая задача заменяет свой выход целиком
 *
 * Повтор задачи обязан быть безопасен (§12, at-least-once). Частичное
 * обновление оставило бы рядом решения двух прогонов, и на разном составе
 * страниц это дало бы декодеру метки, которых он не заказывал. Замена целиком
 * плюс проверка непустоты входа — то же правило, что на S6 закрыло «успешную
 * задачу, уничтожающую данные».
 *
 * ## Чего задача НЕ имеет права сделать
 *
 * Завершиться успехом, ничего не изменив или потеряв данные. Отсюда три
 * охранника, каждый со своим тестом:
 *
 * 1. `doc.segment` отказывается применять сегментацию, если классификаций нет
 *    вовсе, — иначе повтор после сбоя задачи 14 стёр бы прошлую сборку и
 *    оставил ревизию с нулём документов, отчитавшись успехом;
 * 2. `doc.segment` отказывается переписывать ревизию, в которой есть документы,
 *    подтверждённые ЧЕЛОВЕКОМ (`confirmation_source = 'human'`): подтверждение
 *    — это работа инженера, а §8.2 прямо объявляет ручную разметку
 *    приоритетной. Это ВЕРХНИЙ из трёх рубежей, а не единственный: отказ обязан
 *    наступить и без обработчика, поэтому та же проверка стоит в
 *    `applySegmentation` (репозиторий) и триггером
 *    `logical_documents_confirmed_lock` (0016/0038). Здесь она нужна ради
 *    ранней и дешёвой диагностики — до чтения страниц и декодирования.
 *
 *    Собственные, машинные подтверждения сюда не попадают (S27): границы,
 *    собранные конвейером, он же и подтверждает — иначе не поедет нарезка, — и
 *    запрещать ему пересобирать свою работу значило бы запретить повторное
 *    распознавание вообще после первого прогона;
 * 3. `applySegmentation` откатывает всё, если после применения остаются
 *    неучтённые страницы (non-degradable гейт §1.6), и обработчик этот отказ
 *    не глотает.
 */
import {
  classifyPages,
  classifyPageWithLlm,
  decodeSegmentation,
  documentNumbersOf,
  documentsNamedInActItem3,
  extractFields,
  extractFieldsWithLlm,
  llmFieldsFor,
  LlmError,
  matchRegistryRows,
  pagesNeedingLlm,
  parseAnnexRegistry,
  renderExtractUserPrompt,
  renderUserPrompt,
  promptDocTypeCodes,
  type DocumentRelationInput,
  type FieldValueView,
  type JobContext,
  type JobHandler,
  type LlmAttempt,
  type LlmProviderName,
  type LogicalDocumentView,
  type MatchableDocument,
  type PageAssignmentView,
  type PageClassification,
  type PageClassificationView,
  type PageInput,
  type ParsedRegistryRow,
  type RegistryMatch,
  type RegistryRowView,
  type Segmentation,
  type SegmentationInput,
} from '@id/api';
import { isAnalysisAnchor } from '@id/doc-types';
import { AOSR_FIELDS, matchCounterparty, periodOfEarliestAct } from '@id/rules';

/**
 * Версия сегментатора и экстрактора.
 *
 * Пишется в `field_values.extractor_version` и в событие ревизии. Значение
 * поднимается вместе с изменением правил разбора, иначе «переизвлечь тем же
 * экстрактором» и «переизвлечь новым» неотличимы, а замена значений идёт
 * именно по версии.
 */
export const SEGMENTATION_VERSION = 's8.1';

/**
 * Стадия и код промта постраничной классификации — одно значение.
 *
 * `prompt_templates` различает `code` и `stage`, и совпадение их здесь не
 * случайность, а решение: стадия у портала одна на код, и разъехавшись, они
 * дали бы «опубликованного промта стадии нет» при заведённом промте.
 */
export const PAGE_CLASSIFY_STAGE = 'page_classify';

/**
 * Стадия и код промта извлечения реквизитов моделью (§8.4, S21).
 *
 * Имя совпадает со стадией `ai_runs.stage`, у которой CHECK заведён ещё в 0004:
 * `extract` там объявлен с самого начала, а кода за ним не стояло — поля с
 * `extractor: 'llm'` не извлекал никто. Теперь стоит.
 */
export const FIELD_EXTRACT_STAGE = 'extract';

/**
 * Стадии, на которых портал обращается к ТЕКСТОВОЙ модели.
 *
 * Одно перечисление на все три, а не по одному на модуль: порт модели, запись
 * `ai_runs` и чтение опубликованного промта у них общие, и разные типы стадии
 * заставили бы приводить строку в месте связывания — то есть терять проверку
 * ровно там, где она нужна. `check` принадлежит ИИ-проверке заполнения
 * (`checks-llm-review.ts`), но объявлен здесь, потому что здесь объявлен порт.
 */
export type LlmTextStage =
  typeof PAGE_CLASSIFY_STAGE | typeof FIELD_EXTRACT_STAGE | typeof LLM_REVIEW_STAGE;

/** Стадия и код промта ИИ-проверки заполнения (§9.1, S21). */
export const LLM_REVIEW_STAGE = 'check';

/**
 * Промт стадии: опубликованный, иначе встроенный (S27).
 *
 * Опубликованной версии может не быть, и это ШТАТНОЕ состояние: §10 требует
 * цикла `draft → test → publish` с аудитом, а публикация — действие
 * администратора, не миграции. Сеять `published`-строку миграцией значило бы
 * подделать `published_by` в журнале, который читают как доказательство.
 *
 * Но выключать из-за этого LLM-ступень оказалось неверно: сид-миграция 0032
 * кладёт промты черновиками и ГЕНЕРИРУЕТСЯ из констант в коде, то есть
 * «неопубликованный черновик» и «встроенный текст» — одна и та же строка.
 * Ступени не выполнялись никогда, а причина лежала в консоли. Теперь при пустом
 * каталоге берётся встроенный текст с `version: 0`, и ноль в
 * `ai_runs.prompt_version` прямо говорит, чем работала модель.
 *
 * `null` остался ровно для одного случая: у стадии нет ни опубликованной
 * версии, ни встроенного текста. Тогда пропуск с названной причиной — законный
 * исход.
 */
export interface PublishedPrompt {
  readonly code: string;
  readonly version: number;
  readonly systemPrompt: string;
  readonly userTemplate: string;
  readonly modelOverride: string | null;
}

/** Итог одного обращения к модели — вход строки `ai_runs`. */
export interface LlmCallResult {
  readonly text: string;
  readonly model: string;
  /** Закрытое перечисление: `ai_runs.provider` покрыт CHECK'ом (0004). */
  readonly provider: LlmProviderName;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
}

export interface SegmentationDeps {
  /**
   * Проставить месяц комплекта, если он ещё не определён (S30).
   *
   * Порт, а не прямой вызов репозитория: обработчики этого файла написаны на
   * портах целиком, и один прямой вызов сделал бы их непроверяемыми без базы.
   * Возвращает `true`, если месяц записан именно этим вызовом.
   */
  readonly fillFolderPeriod: (folderId: string, period: string) => Promise<boolean>;
  /**
   * Заменить ПОДСТАВЛЕННОГО порталом исполнителя организацией из акта (S37).
   *
   * Пара к `fillFolderPeriod` и по той же причине порт: обработчики этого файла
   * написаны на портах целиком. Названного человеком исполнителя не трогает —
   * условие живёт в самом операторе, а не в вызывающем.
   */
  readonly replaceAssumedContractor: (folderId: string, contractorId: string) => Promise<boolean>;
  /** Запомнить наименование из акта, которого нет в справочнике объекта. */
  readonly rememberContractorRaw: (folderId: string, raw: string) => Promise<boolean>;
  /** Организации справочника, с которыми сопоставляется исполнитель из акта. */
  readonly listMatchableContractors: () => Promise<
    readonly { id: string; name: string; inn: string | null; ogrn: string | null }[]
  >;
  /** Вход сегментации: страницы ревизии, текст последнего успешного прогона. */
  loadPages(folderId: string): Promise<SegmentationInput>;

  savePageClassifications(input: {
    readonly folderId: string;
    readonly classifications: readonly PageClassification[];
  }): Promise<{ readonly removed: number; readonly written: number }>;
  listPageClassifications(folderId: string): Promise<readonly PageClassificationView[]>;

  applySegmentation(input: {
    readonly folderId: string;
    readonly segmentation: Segmentation;
  }): Promise<{
    readonly documentsCreated: number;
    /** Сколько документов прошлой сборки удалено: «переписано» ≠ «собрано». */
    readonly documentsReplaced: number;
    readonly pagesAssigned: number;
    readonly pagesUnassigned: number;
    readonly registryRowsUnlinked: number;
    readonly documentIds: readonly string[];
  }>;

  listDocuments(folderId: string): Promise<readonly LogicalDocumentView[]>;
  listPageAssignments(folderId: string): Promise<readonly PageAssignmentView[]>;
  listFieldValues(documentId: string): Promise<readonly FieldValueView[]>;

  saveFieldValues(input: {
    readonly folderId: string;
    readonly documentId: string;
    readonly fields: ReturnType<typeof extractFields>;
    readonly extractorVersion: string;
  }): Promise<{ readonly removed: number; readonly written: number }>;

  saveRegistryRows(input: {
    readonly folderId: string;
    readonly documentId: string;
    readonly rows: readonly ParsedRegistryRow[];
  }): Promise<{ readonly removed: number; readonly written: number }>;
  listRegistryRows(folderId: string): Promise<readonly RegistryRowView[]>;
  saveRegistryMatches(input: {
    readonly folderId: string;
    readonly matches: readonly RegistryMatch[];
  }): Promise<{ readonly updated: number; readonly skipped: number }>;

  saveDocumentRelations(input: {
    readonly folderId: string;
    readonly relations: readonly DocumentRelationInput[];
  }): Promise<{ readonly removed: number; readonly written: number; readonly skipped: number }>;

  /** Наблюдение незнакомого заголовка: цикл роста каталога (§3.2). */
  observeCandidate(input: {
    readonly observedTitle: string;
    readonly folderId: string;
    readonly sourcePageId: string;
  }): Promise<{ readonly created: boolean; readonly occurrences: number }>;

  /** Опубликованный промт стадии; `null` — стадия модели пропускается. */
  stagePrompt(stage: LlmTextStage): Promise<PublishedPrompt | null>;

  /**
   * Вызов модели. `null` — провайдер не подключён.
   *
   * Порт принимает и возвращает ТОЛЬКО строки и числа: raw PDF и изображения
   * внешней модели не отправляются (§10), и это выражено формой типа, а не
   * дисциплиной вызывающего.
   */
  callLlm:
    | ((input: {
        readonly stage: LlmTextStage;
        readonly promptCode: string;
        readonly promptVersion: number;
        readonly systemPrompt: string;
        readonly userPrompt: string;
        readonly schemaVersion: string;
        readonly cacheContext: string;
        readonly model?: string | undefined;
      }) => Promise<LlmCallResult>)
    | null;

  /** Строка `ai_runs`: только хэши и структурированный результат (§3.5). */
  recordAiRun(input: {
    readonly folderId: string;
    readonly stage: LlmTextStage;
    readonly provider: LlmProviderName;
    readonly model: string;
    readonly promptCode: string;
    readonly promptVersion: number;
    readonly inputHash: string;
    /** `null` — ответа не было: вызов состоялся, но результата не дал. */
    readonly outputHash: string | null;
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    readonly cost: number | null;
    readonly latencyMs: number;
    readonly structuredResult: unknown;
    readonly requestId: string | null;
  }): Promise<void>;
}

/**
 * Отказ стадии сегментации, при котором повтор бессмыслен.
 *
 * Отдельный класс, а не общий `Error`: `job_runs.error_class` обязан отличать
 * «входа нет» от «сеть моргнула». Первое исправляется человеком (запустить
 * распознавание), второе — повтором.
 */
export class SegmentationStateError extends Error {
  /**
   * Повтор бессмыслен, и класс объявляет это САМ.
   *
   * `classifyFailure()` читает поле по форме, а не по перечислению классов:
   * пока его здесь не было, «прогона распознавания нет» и «документы
   * подтверждены человеком» уходили в `max_attempts` попыток с backoff —
   * ни то, ни другое от повтора не меняется, а конвейер четверть часа
   * выглядел работающим. Тот же механизм чинили на S7 для `RdWebError`.
   */
  readonly retriable = false;

  constructor(message: string) {
    super(message);
    this.name = 'SegmentationStateError';
  }
}

/** Резервные типы каталога: по ним определяется «документ незнакомого вида». */
const FALLBACK_PREFIX = 'other_';
const UNKNOWN_DOCUMENT = 'unknown_document';

function isFallbackType(code: string | null): boolean {
  return code !== null && (code === UNKNOWN_DOCUMENT || code.startsWith(FALLBACK_PREFIX));
}

/** Страницы репозитория → вход фаз классификации. */
function toPageInputs(input: SegmentationInput): readonly PageInput[] {
  return input.pages.map((page) => ({
    sourcePageId: page.sourcePageId,
    folderOrdinal: page.folderOrdinal,
    sourceFileId: page.sourceFileId,
    filePageIndex: page.filePageIndex,
    pageTextVersionId: page.pageTextVersionId,
    text: page.text,
    blockTypes: page.blockTypes,
    rotation: page.rotation,
    // Ручная метка (§8.2, фаза 3): репозиторий поднимает её из
    // `page_classifications` (source='manual'), фаза 1 не переопределяет и
    // при пересборке записывает обратно — метка переживает прогоны.
    manual: page.manual,
  }));
}

/** Решение из БД → структура фазы 3. Обратное преобразование `savePageClassifications`. */
function toClassification(row: PageClassificationView): PageClassification {
  return {
    sourcePageId: row.sourcePageId,
    label: row.label,
    docTypeCode: row.docTypeCode,
    typeOutcome: row.typeOutcome,
    observedTitle: row.observedTitle,
    pageRoleCode: row.pageRoleCode,
    parentRef: row.parentRef,
    confidence: row.confidence ?? 0,
    reason: row.reason ?? '',
    source: row.source,
    alternatives: row.alternatives,
    ambiguous: row.ambiguous,
    evidence:
      row.pageTextVersionId !== null && row.charSpan !== null && row.quote !== null
        ? {
            pageTextVersionId: row.pageTextVersionId,
            charStart: row.charSpan.start,
            charEnd: row.charSpan.end,
            quote: row.quote,
          }
        : null,
  };
}

// =====================================================================
// Сквозной прогон
// =====================================================================

/**
 * Передача признака «доведи до конца» следующему звену цепочки (S21).
 *
 * Цепочка `classify → segment → extract → parse_registry → match_registry →
 * graph.build` ставит себя сама, а решение «идти ли дальше в проверки»
 * принимает человек ОДИН раз — нажатием «Проверить». Значит, признак обязан
 * доехать от головы цепочки до её хвоста, и единственный способ сделать это
 * честно — нести его в payload.
 *
 * Читать настройку заново на каждом звене нельзя: между первым звеном и
 * шестым проходят минуты, настройку успевают сменить, и половина цепочки
 * прошла бы по одному решению, а половина — по другому. Тем же соображением
 * ADR-0007 пиннит провайдера и модель в снимке прогона.
 *
 * Поле опускается, когда его нет, а не пишется `false`: пошаговый путь
 * инженера не должен отличаться от прежнего ни одним байтом payload — иначе
 * ключи идемпотентности разъедутся с уже стоящими в очереди задачами.
 */
function forwardAutoContinue(ctx: {
  readonly payload: { readonly autoContinue?: boolean | undefined };
}): { autoContinue?: true } {
  return ctx.payload.autoContinue === true ? { autoContinue: true } : {};
}

// =====================================================================
// Задача 14. doc.classify_pages
// =====================================================================

/**
 * Фаза 1 по всем страницам, фаза 2 — только по оставшимся `U` (§8.2).
 *
 * Порядок именно такой и обратным быть не может: модель дорога, а якорные
 * правила детерминированы и бесплатны. Отправлять в модель страницу, тип
 * которой уже назван якорем, значит платить за подтверждение и получить второй
 * источник правды с правом его опровергнуть.
 *
 * Отказ модели НЕ роняет задачу. Это принципиально: фаза 1 уже дала результат,
 * и потерять его из-за исчерпанного бюджета или отвалившегося провайдера
 * значило бы поставить весь конвейер в зависимость от внешнего сервиса, без
 * которого §0.5 требует работоспособности.
 */
export function createClassifyPagesHandler(
  deps: SegmentationDeps,
): JobHandler<'doc.classify_pages'> {
  return async (ctx: JobContext<'doc.classify_pages'>) => {
    const { folderId } = ctx.payload;
    const input = await deps.loadPages(folderId);

    if (input.recognitionRunId === null) {
      throw new SegmentationStateError(
        `Ревизия ${folderId}: завершённого прогона распознавания нет, классифицировать нечего.`,
      );
    }
    if (input.pages.length === 0) {
      throw new SegmentationStateError(`Ревизия ${folderId}: страниц не найдено.`);
    }

    const pages = toPageInputs(input);
    const phase1 = classifyPages(pages);

    const byId = new Map(pages.map((page) => [page.sourcePageId, page]));
    const order = new Map(pages.map((page, index) => [page.sourcePageId, index]));
    const result = new Map(phase1.map((c) => [c.sourcePageId, c]));

    const llmStats = {
      considered: 0,
      called: 0,
      resolved: 0,
      rejected: 0,
      /** Сколько страниц не дошло до модели из-за отказа, общего для всех. */
      abandoned: 0,
      skippedReason: null as string | null,
      stoppedReason: null as string | null,
    };

    const undecided = pagesNeedingLlm(phase1);
    llmStats.considered = undecided.length;

    const prompt = undecided.length > 0 ? await deps.stagePrompt(PAGE_CLASSIFY_STAGE) : null;
    if (undecided.length > 0) {
      if (deps.callLlm === null) {
        llmStats.skippedReason = 'провайдер модели не подключён';
      } else if (prompt === null) {
        // Недостижимо, пока у стадии есть встроенный текст: отсутствие
        // ОПУБЛИКОВАННОЙ версии ступень больше не выключает. Ветка оставлена
        // для стадии, у которой встроенного текста нет вовсе, — и говорит
        // именно это, а не «опубликуйте промт».
        llmStats.skippedReason =
          'у стадии page_classify нет ни опубликованного, ни встроенного промта';
      }
    }

    if (undecided.length > 0 && deps.callLlm !== null && prompt !== null) {
      const codes = promptDocTypeCodes();
      for (const candidate of undecided) {
        // Кооперативная отмена — по той же причине, что в обходе документов
        // ниже: брошенная попытка обязана прекратить звонить в шлюз.
        ctx.signal.throwIfAborted();

        const page = byId.get(candidate.sourcePageId);
        if (page === undefined) continue;
        const index = order.get(candidate.sourcePageId) ?? 0;
        const neighbours = {
          before: index > 0 ? (pages[index - 1] ?? null) : null,
          after: index + 1 < pages.length ? (pages[index + 1] ?? null) : null,
        };

        const outcome = await runLlmForPage(deps, ctx, {
          folderId,
          page,
          neighbours,
          prompt,
          codes,
        });
        llmStats.called += 1;
        if (outcome.classification === null) llmStats.rejected += 1;
        else {
          result.set(candidate.sourcePageId, outcome.classification);
          llmStats.resolved += 1;
        }

        if (outcome.stop !== null) {
          // Отказ, относящийся ко ВСЕМ последующим вызовам (исчерпанный
          // бюджет, отключённый или заблокированный провайдер, модель вне
          // allowlist). Продолжать обход — значит получить тот же отказ ещё
          // восемьдесят два раза и записать восемьдесят две одинаковые строки
          // `ai_runs`. Фаза 1 при этом уже дала результат, и он сохраняется.
          llmStats.stoppedReason = outcome.stop;
          llmStats.abandoned = undecided.length - llmStats.called;
          ctx.logger.warn(
            { reason: outcome.stop, abandoned: llmStats.abandoned },
            'фаза 2 прервана: отказ относится ко всем оставшимся страницам',
          );
          break;
        }
      }
    }

    const classifications = pages.map(
      (page) => result.get(page.sourcePageId) as PageClassification,
    );

    const saved = await deps.savePageClassifications({ folderId, classifications });

    // Нулевая запись при непустом входе — отказ, а не успех: значит решения
    // страниц до базы не доехали, а следующая задача применила бы пустоту.
    if (saved.written !== classifications.length) {
      throw new SegmentationStateError(
        `Записано ${saved.written} решений из ${classifications.length}.`,
      );
    }

    const counts = {
      pages: classifications.length,
      typed: classifications.filter((c) => c.docTypeCode !== null).length,
      roles: classifications.filter((c) => c.pageRoleCode !== null).length,
      unknown: classifications.filter((c) => c.label === 'U').length,
      other: classifications.filter((c) => c.typeOutcome === 'other').length,
      uncertain: classifications.filter((c) => c.typeOutcome === 'uncertain').length,
      llm: llmStats,
    };
    ctx.logger.info({ counts }, 'страницы классифицированы');
    await ctx.emit('documents.pages_classified', counts);

    await ctx.enqueue({
      type: 'doc.segment',
      payload: { folderId, ...forwardAutoContinue(ctx) },
      dedupeKey: `doc.segment:${folderId}`,
    });
  };
}

/** Итог одной страницы фазы 2. */
interface LlmPageOutcome {
  readonly classification: PageClassification | null;
  /**
   * Причина, по которой обход остальных страниц бессмыслен, либо `null`.
   *
   * Берётся у самого отказа (`LlmError.stopsBatch`), а не перечисляется здесь
   * по классам: перечисление — это способ, которым дефект возвращается со
   * следующим классом ошибки.
   */
  readonly stop: string | null;
}

/**
 * Один вызов модели по одной странице.
 *
 * Отказ провайдера НЕ роняет задачу: страница остаётся `U`, а причина уходит в
 * журнал. `LlmError` здесь ловится целиком, а не перечислением подклассов, —
 * перечисление классов ошибок уже подводило на S7, где необъявленный
 * `ExportFormatError` оставлял прогон в `running`.
 *
 * Строка `ai_runs` пишется ДО разбора ответа: стоимость вызова возникает в
 * момент ответа модели, а не в момент, когда ответ нам понравился. Иначе
 * отвергнутые схемой ответы не попадали бы в бюджет, и §11 считал бы траты
 * меньше фактических.
 *
 * По той же причине строка пишется и при ОТКАЗЕ, если вызов дошёл до
 * провайдера: `LlmError.attempt` несёт хэш промта, модель и длительность.
 * Прежде таймаут не оставлял следа вовсе — вызов был, время потрачено, а в
 * аудите пусто, и расследование «почему страница осталась неопознанной»
 * упиралось в тишину.
 */
async function runLlmForPage(
  deps: SegmentationDeps,
  ctx: JobContext<'doc.classify_pages'>,
  input: {
    readonly folderId: string;
    readonly page: PageInput;
    readonly neighbours: { readonly before: PageInput | null; readonly after: PageInput | null };
    readonly prompt: PublishedPrompt;
    readonly codes: readonly string[];
  },
): Promise<LlmPageOutcome> {
  const call = deps.callLlm;
  if (call === null) return { classification: null, stop: 'провайдер модели не подключён' };

  const userPrompt = renderUserPrompt(
    input.page,
    input.neighbours,
    input.codes,
    input.prompt.userTemplate,
  );

  let recorded: LlmCallResult | null = null;
  try {
    const outcome = await classifyPageWithLlm(
      input.page,
      input.neighbours,
      {
        complete: async (request) => {
          const response = await call({
            stage: PAGE_CLASSIFY_STAGE,
            promptCode: input.prompt.code,
            promptVersion: input.prompt.version,
            systemPrompt: request.systemPrompt,
            userPrompt: request.userPrompt,
            schemaVersion: request.schemaVersion,
            cacheContext: request.cacheContext,
            model: input.prompt.modelOverride ?? undefined,
          });
          recorded = response;
          return { text: response.text };
        },
      },
      { system: input.prompt.systemPrompt, user: userPrompt },
    );

    await writeAiRun(deps, ctx, input, recorded, {
      sourcePageId: input.page.sourcePageId,
      accepted: outcome.classification !== null,
      problem: outcome.problem,
    });

    if (outcome.problem !== null) {
      ctx.logger.warn(
        { sourcePageId: input.page.sourcePageId, problem: outcome.problem },
        'ответ модели не принят',
      );
    }
    return { classification: outcome.classification, stop: null };
  } catch (error) {
    if (error instanceof LlmError) {
      await writeAiRun(
        deps,
        ctx,
        input,
        recorded,
        {
          sourcePageId: input.page.sourcePageId,
          accepted: false,
          problem: `${error.name}: ${error.message}`,
        },
        error.attempt,
      );
      ctx.logger.warn(
        {
          sourcePageId: input.page.sourcePageId,
          errorClass: error.name,
          stopsBatch: error.stopsBatch,
        },
        'провайдер модели отказал; страница остаётся неопознанной',
      );
      return {
        classification: null,
        stop: error.stopsBatch ? `${error.name}: ${error.message}` : null,
      };
    }
    throw error;
  }
}

async function writeAiRun(
  deps: SegmentationDeps,
  ctx: JobContext<'doc.classify_pages'>,
  input: { readonly folderId: string; readonly prompt: PublishedPrompt },
  call: LlmCallResult | null,
  structured: {
    readonly sourcePageId: string;
    readonly accepted: boolean;
    readonly problem: string | null;
  },
  attempt: LlmAttempt | null = null,
): Promise<void> {
  // Попадание в кэш — не новый вызов провайдера: вторая строка `ai_runs`
  // удвоила бы учтённую стоимость, которой не было.
  if (call !== null && call.cacheHit) return;

  // Ответа нет, но попытка состоялась: строка пишется без `output_hash`, со
  // стоимостью `null` (провайдер её не сообщил) и с названной причиной в
  // разобранном результате. Молчание здесь означало бы, что вызов, потративший
  // время и, возможно, деньги, в аудите не существует.
  const trace =
    call === null
      ? attempt === null
        ? null
        : {
            provider: attempt.provider,
            model: attempt.model,
            inputHash: attempt.inputHash,
            outputHash: null as string | null,
            tokensIn: null,
            tokensOut: null,
            cost: null,
            latencyMs: attempt.latencyMs,
          }
      : {
          provider: call.provider,
          model: call.model,
          inputHash: call.inputHash,
          outputHash: call.outputHash as string | null,
          tokensIn: call.tokensIn,
          tokensOut: call.tokensOut,
          cost: call.cost,
          latencyMs: call.latencyMs,
        };
  // Отказ до сборки промта (провайдер не подключён либо модель не выбрана):
  // хэшей нет, и строка без них нарушила бы собственные CHECK'и `ai_runs`.
  if (trace === null) return;

  await deps.recordAiRun({
    folderId: input.folderId,
    stage: PAGE_CLASSIFY_STAGE,
    provider: trace.provider,
    model: trace.model,
    promptCode: input.prompt.code,
    promptVersion: input.prompt.version,
    inputHash: trace.inputHash,
    outputHash: trace.outputHash,
    tokensIn: trace.tokensIn,
    tokensOut: trace.tokensOut,
    cost: trace.cost,
    latencyMs: trace.latencyMs,
    // Только структурированный итог: ни промта, ни ответа модели дословно
    // (§3.5, требование D). Хэши выше уже позволяют доказать, что отвечали
    // именно на этот вход.
    structuredResult: structured,
    requestId: ctx.payload.request_id ?? null,
  });
}

// =====================================================================
// Задача 15. doc.segment
// =====================================================================

/**
 * Фаза 3: решения по страницам → логические документы (§8.2).
 *
 * Здесь же замыкается цикл роста каталога: документ, получивший резервный тип,
 * отдаёт свой наблюдённый заголовок в `doc_type_candidates`. Без этого шага
 * незнакомый вид документа обрабатывался бы корректно и исчезал бесследно, то
 * есть каталог никогда не пополнялся бы эксплуатацией (§0.5, п.3).
 */
export function createSegmentHandler(deps: SegmentationDeps): JobHandler<'doc.segment'> {
  return async (ctx: JobContext<'doc.segment'>) => {
    const { folderId } = ctx.payload;

    const stored = await deps.listPageClassifications(folderId);
    if (stored.length === 0) {
      // Охранник 1. Пустой вход при существующей сборке — это повтор после
      // сбоя задачи 14, и применить его значило бы «успешно» удалить все
      // документы ревизии.
      throw new SegmentationStateError(
        `Ревизия ${folderId}: решений по страницам нет, пересобирать документы не из чего.`,
      );
    }

    const existing = await deps.listDocuments(folderId);
    // Охранник 2. Подтверждение ЧЕЛОВЕКОМ — работа инженера, и §8.2 объявляет
    // ручное решение приоритетным. Молча переписать его пересегментацией — тот
    // же класс отказа, что импорт блоков на S6.
    //
    // Машинное подтверждение сюда не попадает (S27): границы, собранные
    // конвейером, он же и подтверждает — иначе не поедет нарезка, — и запрещать
    // ему пересобирать собственную работу значило бы запретить повторное
    // распознавание вообще после первого прогона.
    const confirmed = existing.filter(
      (document) => document.isConfirmed && document.confirmationSource === 'human',
    );
    if (confirmed.length > 0) {
      throw new SegmentationStateError(
        `Ревизия ${folderId}: ${confirmed.length} документов подтверждены человеком; ` +
          'пересегментация переписала бы их. Снимите подтверждение явным действием.',
      );
    }

    const input = await deps.loadPages(folderId);
    const pages = toPageInputs(input);
    if (pages.length === 0) {
      throw new SegmentationStateError(`Ревизия ${folderId}: страниц не найдено.`);
    }

    const known = new Set(pages.map((page) => page.sourcePageId));
    const classifications = stored
      .filter((row) => known.has(row.sourcePageId))
      .map(toClassification);
    if (classifications.length !== pages.length) {
      // Решения и страницы разошлись: между задачами 14 и 15 состав ревизии
      // изменился. Декодер такое отвергнет и сам, но диагностика здесь точнее.
      throw new SegmentationStateError(
        `Ревизия ${folderId}: решений ${classifications.length} против ${pages.length} страниц; ` +
          'состав ревизии изменился, требуется повторная классификация.',
      );
    }

    const segmentation = decodeSegmentation(pages, classifications);
    const applied = await deps.applySegmentation({ folderId, segmentation });

    // Кандидаты в справочник — после успешного применения: заголовок, чья
    // сегментация откатилась, наблюдением не является.
    let candidates = 0;
    for (const [index, document] of segmentation.documents.entries()) {
      if (!isFallbackType(document.docTypeCode)) continue;
      const title = document.observedTitle ?? document.title;
      if (title === null || title.trim() === '') continue;
      const firstPage = document.pages[0];
      if (firstPage === undefined) continue;
      const outcome = await deps.observeCandidate({
        observedTitle: title,
        folderId,
        sourcePageId: firstPage.sourcePageId,
      });
      candidates += 1;
      ctx.logger.info(
        { ordinal: index, occurrences: outcome.occurrences, created: outcome.created },
        'незнакомый вид документа записан кандидатом в справочник',
      );
    }

    const counts = {
      documents: applied.documentsCreated,
      documentsReplaced: applied.documentsReplaced,
      pagesAssigned: applied.pagesAssigned,
      pagesUnassigned: applied.pagesUnassigned,
      registryRowsUnlinked: applied.registryRowsUnlinked,
      needsReview: segmentation.documents.filter((d) => d.needsReview).length,
      fallbackTypes: segmentation.documents.filter((d) => isFallbackType(d.docTypeCode)).length,
      candidatesObserved: candidates,
    };
    ctx.logger.info({ counts }, 'документы собраны');
    await ctx.emit('documents.segmented', counts);

    // Нарезка ставится ЗДЕСЬ (S27), а не подтверждением человека.
    //
    // Прежде `doc.materialize_pdf` ставил только маршрут `POST …/confirm`. С
    // отменой ручного подтверждения кнопки не стало, и задача 22 осталась бы
    // написанным и никогда не вызываемым обработчиком — отказ S5 в чистом виде,
    // а согласование навсегда упиралось бы в «документов без нарезки».
    //
    // Веер по документам ревизии обработчик разложит сам. Ключ дедупликации —
    // по ревизии: уникальность действует только пока задача не `done`, поэтому
    // повторная сегментация поставит нарезку заново, а не сольётся с уже
    // отработавшей.
    await ctx.enqueue({
      type: 'doc.materialize_pdf',
      payload: { folderId },
      dedupeKey: `doc.materialize_pdf:${folderId}`,
    });

    await ctx.enqueue({
      type: 'doc.extract_fields',
      payload: { folderId, ...forwardAutoContinue(ctx) },
      dedupeKey: `doc.extract_fields:${folderId}`,
    });
  };
}

// =====================================================================
// Задача 16. doc.extract_fields
// =====================================================================

/**
 * Двухуровневое извлечение реквизитов (§8.4).
 *
 * Базовая схема применяется ВСЕГДА, включая резервные и неопознанные типы, —
 * это то, что позволяет системе работать на разделах, которых в корпусе не
 * было: номер, даты, издатель, продукция, ГОСТ и срок действия одинаковы у
 * сертификата на арматуру и у паспорта на вентустановку. Типо-специфичная
 * схема применяется только при уверенно определённом типе; уверенность здесь
 * читается из `type_confidence` документа, а не из наличия кода — тип-гипотеза
 * с пометкой `needs_review` специфичных правил не заслуживает.
 *
 * Без `documentId` в payload обрабатывается вся ревизия и ставится следующая
 * задача; с `documentId` — только один документ и ничего не ставится. Это
 * ручное переизвлечение с экрана документа, и продолжать за ним весь конвейер
 * было бы неожиданностью для нажавшего кнопку.
 */
const TYPE_CONFIDENT_THRESHOLD = 0.7;

export function createExtractFieldsHandler(
  deps: SegmentationDeps,
): JobHandler<'doc.extract_fields'> {
  return async (ctx: JobContext<'doc.extract_fields'>) => {
    const { folderId, documentId } = ctx.payload;

    const documents = await deps.listDocuments(folderId);
    const targets =
      documentId === undefined ? documents : documents.filter((d) => d.id === documentId);
    if (targets.length === 0) {
      throw new SegmentationStateError(
        documentId === undefined
          ? `Ревизия ${folderId}: документов нет, извлекать реквизиты не из чего.`
          : `Документ ${documentId} не принадлежит ревизии ${folderId}.`,
      );
    }

    const input = await deps.loadPages(folderId);
    const textOf = new Map(
      input.pages.map((page) => [
        page.sourcePageId,
        { pageTextVersionId: page.pageTextVersionId, text: page.text },
      ]),
    );
    const assignments = await deps.listPageAssignments(folderId);
    const pagesOfDocument = new Map<string, string[]>();
    for (const assignment of [...assignments].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
    )) {
      if (assignment.documentId === null) continue;
      const list = pagesOfDocument.get(assignment.documentId) ?? [];
      list.push(assignment.sourcePageId);
      pagesOfDocument.set(assignment.documentId, list);
    }

    // Промт стадии читается ОДИН раз на прогон, а не на документ: он один и тот
    // же, а `stagePrompt` ходит в базу. `null` теперь означает «встроенного
    // текста у стадии нет вовсе» — отсутствие ОПУБЛИКОВАННОЙ версии больше не
    // выключает ступень, иначе она не выполнялась бы никогда (сид-миграция 0032
    // кладёт этот промт черновиком).
    const llmPrompt = await deps.stagePrompt(FIELD_EXTRACT_STAGE);
    let llmStop: string | null = null;

    let written = 0;
    let baseOnly = 0;
    let llmFields = 0;
    let llmProblems = 0;
    /** Даты актов: по самой ранней портал выведет месяц комплекта (S30). */
    const actDates: (string | null)[] = [];
    /** Реквизиты исполнителя из акта: по ним портал заменит подставленного (S37). */
    let contractorTriple: {
      name: string | null;
      inn: string | null;
      ogrn: string | null;
    } | null = null;
    for (const document of targets) {
      // Отмена проверяется НА КАЖДОМ документе, а не однажды на входе.
      //
      // Сторож задачи обрывает попытку по `leaseMs`, но кооперативную отмену
      // обязан подхватить сам обход: без этой строки брошенная попытка
      // продолжала обходить все 134 документа рядом с новой, взятой ей на
      // смену. На боевом прогоне это дало три перекрывающиеся попытки и
      // тройные копии реквизитов — при том, что сама запись идемпотентна.
      ctx.signal.throwIfAborted();

      const pageIds = pagesOfDocument.get(document.id) ?? [];
      const pages = pageIds
        .map((id) => textOf.get(id))
        .filter(
          (value): value is { pageTextVersionId: string | null; text: string } =>
            value !== undefined,
        );

      const typeConfident =
        document.docTypeCode !== null &&
        !isFallbackType(document.docTypeCode) &&
        !document.needsReview &&
        (document.typeConfidence ?? 0) >= TYPE_CONFIDENT_THRESHOLD;
      if (!typeConfident) baseOnly += 1;

      const fields = [
        ...extractFields({
          docTypeCode: document.docTypeCode,
          typeConfident,
          pages,
        }),
      ];

      // Вторая ступень: поля, у которых `extractor: 'llm'`. Она НЕ трогает уже
      // извлечённое правилами — `llmFieldsFor` отбирает только свои коды, — и
      // не роняет задачу: документ без ответа модели остаётся с базовыми
      // реквизитами, ровно как до S21.
      if (llmPrompt !== null && deps.callLlm !== null && llmStop === null) {
        const outcome = await runLlmExtraction(deps, ctx, {
          folderId,
          document,
          typeConfident,
          pages,
          prompt: llmPrompt,
        });
        fields.push(...outcome.fields);
        llmFields += outcome.fields.length;
        llmProblems += outcome.problems.length;
        // Отказ провайдера относится ко ВСЕМ последующим документам: исчерпанный
        // бюджет или упавший шлюз не починятся к следующему из тридцати.
        llmStop = outcome.stop;
        if (outcome.problems.length > 0) {
          ctx.logger.warn(
            { documentId: document.id, problems: outcome.problems },
            'часть значений модели не принята',
          );
        }
      }

      if (isAnalysisAnchor(document.docTypeCode)) {
        const actDate = fields.find((value) => value.fieldCode === AOSR_FIELDS.actDate);
        actDates.push(actDate?.valueDate ?? null);

        // Тройка исполнителя берётся с ПЕРВОГО акта, у которого она непуста.
        // Актов в комплекте бывает несколько, но работу выполняет одна
        // организация: выбирать из расходящихся троек значило бы гадать, а
        // расхождение и без того выносит замечанием AOSR.HDR.023.
        if (contractorTriple === null) {
          const textOfField = (code: string): string | null =>
            fields.find((value) => value.fieldCode === code)?.valueText ?? null;
          const triple = {
            name: textOfField(AOSR_FIELDS.contractorName),
            inn: textOfField(AOSR_FIELDS.contractorInn),
            ogrn: textOfField(AOSR_FIELDS.contractorOgrn),
          };
          if (triple.name !== null || triple.inn !== null || triple.ogrn !== null) {
            contractorTriple = triple;
          }
        }
      }

      const outcome = await deps.saveFieldValues({
        folderId,
        documentId: document.id,
        fields,
        extractorVersion: SEGMENTATION_VERSION,
      });
      written += outcome.written;
    }

    if (llmStop !== null) {
      ctx.logger.warn({ reason: llmStop }, 'ступень модели прервана: обход документов остановлен');
    }

    const counts = {
      documents: targets.length,
      fields: written,
      baseSchemaOnly: baseOnly,
      llm: {
        used: llmPrompt !== null && deps.callLlm !== null,
        fields: llmFields,
        problems: llmProblems,
        stopped: llmStop,
      },
    };
    ctx.logger.info({ counts }, 'реквизиты извлечены');
    await ctx.emit('documents.fields_extracted', counts);

    /**
     * Месяц комплекта выводится ЗДЕСЬ (S30).
     *
     * Раньше его называл человек при заведении, не видя акта, — и подставленный
     * по умолчанию текущий месяц оставался в карточке как факт. Теперь он
     * берётся по самому раннему распознанному акту.
     *
     * Только при полном прогоне: `documentId` задан — переизвлекали ОДИН
     * документ, и остальные акты комплекта в `actDates` не попали. Вывести месяц
     * по одному из нескольких актов значило бы назвать не самый ранний.
     *
     * Запись идемпотентна и не трогает уже определённый месяц; отсутствие
     * распознанных дат — не повод подставить сегодняшний.
     */
    if (documentId === undefined) {
      const period = periodOfEarliestAct(actDates);
      if (period !== null) {
        const filled = await deps.fillFolderPeriod(folderId, period);
        if (filled) {
          ctx.logger.info({ period }, 'месяц комплекта выведен по дате акта');
          await ctx.emit('work.period_resolved', { period });
        }
      } else if (actDates.length > 0) {
        /**
         * Разбор прошёл, а даты нет — и это НЕ то же самое, что «ещё не
         * разбирали» (S37).
         *
         * Раньше здесь была тишина, и экран объекта в обоих случаях печатал
         * «После OCR». Заказчик на это и указал: «комплект распознан, а месяц —
         * После OCR». Числа в событии различают две причины пустоты: якорей
         * нет вовсе или якоря есть, но дата ни на одном не прочиталась.
         */
        const dated = actDates.filter((value) => value !== null).length;
        ctx.logger.info(
          { anchors: actDates.length, dated },
          'месяц комплекта не выведен: даты акта не распознаны',
        );
        await ctx.emit('work.period_unresolved', { anchors: actDates.length, dated });
      }
    }

    /**
     * Исполнитель комплекта выводится здесь же, рядом с месяцем (S37).
     *
     * Только при полном прогоне и по тем же основаниям: переизвлечение ОДНОГО
     * документа не видит остальных актов комплекта.
     *
     * Отличие от месяца — в источнике: реквизиты исполнителя объявлены
     * `extractor: 'llm'` (в шапке РД-11-02 ИНН напечатан у четырёх участников
     * подряд, и шаблон взял бы первый попавшийся). Значит при выключенной
     * ступени модели тройка не придёт, и признак «подставлен» останется. Это
     * записано долгом честно, а не спрятано.
     */
    if (documentId === undefined && contractorTriple !== null) {
      const parties = await deps.listMatchableContractors();
      const matched = matchCounterparty(parties, contractorTriple);
      if (matched === null) {
        // Организация ПРОЧИТАНА, но в справочнике её нет. Заводит человек:
        // создавать контрагента по строке из скана значило бы наполнять
        // справочник результатом распознавания. Портал запоминает прочитанное,
        // чтобы экран сказал, чего именно не хватает.
        const raw = contractorTriple.name;
        if (raw !== null) {
          const remembered = await deps.rememberContractorRaw(folderId, raw);
          if (remembered) {
            ctx.logger.info(
              { contractor: raw },
              'исполнитель из акта не найден в справочнике контрагентов',
            );
            await ctx.emit('work.contractor_unresolved', { reason: 'not_in_directory' });
          }
        }
      } else {
        const replaced = await deps.replaceAssumedContractor(folderId, matched.id);
        if (replaced) {
          ctx.logger.info({ contractorId: matched.id }, 'исполнитель комплекта выведен из акта');
          await ctx.emit('work.contractor_resolved', { contractorId: matched.id });
        }
      }
    }

    if (documentId === undefined) {
      await ctx.enqueue({
        type: 'doc.parse_registry',
        payload: { folderId, ...forwardAutoContinue(ctx) },
        dedupeKey: `doc.parse_registry:${folderId}`,
      });
    }
  };
}

interface LlmExtractionResult {
  readonly fields: readonly ExtractedFieldOfDocument[];
  readonly problems: readonly string[];
  /** Причина, по которой обход остальных документов бессмыслен, либо `null`. */
  readonly stop: string | null;
}

/** Значение реквизита в форме, которую принимает `saveFieldValues`. */
type ExtractedFieldOfDocument = ReturnType<typeof extractFields>[number];

/**
 * Ступень модели для одного документа.
 *
 * Отказ ОТВЕТА и отказ ПРОВАЙДЕРА разведены так же, как на фазе 2 сегментации,
 * и по той же причине. Непригодный ответ — это пустой результат с названной
 * причиной: документ остаётся с базовыми реквизитами, и остальные документы
 * обрабатываются дальше. `LlmError` — это `stop`: исчерпанный бюджет или
 * упавший шлюз не починятся к следующему документу из тридцати, а тридцать
 * бесполезных вызовов будут оплачены заказчиком.
 */
async function runLlmExtraction(
  deps: SegmentationDeps,
  ctx: JobContext<'doc.extract_fields'>,
  input: {
    readonly folderId: string;
    readonly document: LogicalDocumentView;
    readonly typeConfident: boolean;
    readonly pages: readonly { readonly pageTextVersionId: string | null; readonly text: string }[];
    readonly prompt: PublishedPrompt;
  },
): Promise<LlmExtractionResult> {
  const call = deps.callLlm;
  if (call === null) return { fields: [], problems: [], stop: null };

  const wanted = llmFieldsFor({
    docTypeCode: input.document.docTypeCode,
    typeConfident: input.typeConfident,
  });
  if (wanted.length === 0) return { fields: [], problems: [], stop: null };

  const userPrompt = renderExtractUserPrompt(
    {
      docTypeLabel: input.document.docTypeCode ?? 'не определён',
      fields: wanted,
      pages: input.pages,
    },
    input.prompt.userTemplate,
  );

  let recorded: LlmCallResult | null = null;
  try {
    const outcome = await extractFieldsWithLlm(
      {
        docTypeCode: input.document.docTypeCode,
        typeConfident: input.typeConfident,
        documentId: input.document.id,
        pages: input.pages,
      },
      {
        complete: async (request) => {
          const response = await call({
            stage: FIELD_EXTRACT_STAGE,
            promptCode: input.prompt.code,
            promptVersion: input.prompt.version,
            systemPrompt: request.systemPrompt,
            userPrompt: request.userPrompt,
            schemaVersion: request.schemaVersion,
            cacheContext: request.cacheContext,
            model: input.prompt.modelOverride ?? undefined,
          });
          recorded = response;
          return { text: response.text };
        },
      },
      { system: input.prompt.systemPrompt, user: userPrompt },
    );

    await writeExtractAiRun(deps, ctx, input, recorded, {
      documentId: input.document.id,
      accepted: outcome.fields.length,
      problems: outcome.problems,
    });
    return { fields: outcome.fields, problems: outcome.problems, stop: null };
  } catch (error) {
    if (error instanceof LlmError) {
      await writeExtractAiRun(deps, ctx, input, recorded, {
        documentId: input.document.id,
        accepted: 0,
        problems: [error.message],
      });
      return { fields: [], problems: [error.message], stop: error.message };
    }
    throw error;
  }
}

/**
 * Строка `ai_runs` стадии `extract`.
 *
 * Только хэши и структурированный итог: ни промта, ни ответа модели дословно
 * (§3.5, требование D). Отдельная функция, а не общая с `page_classify`: у той
 * структурированный итог описывает СТРАНИЦУ, и склеивать две формы в одну ради
 * экономии двадцати строк значило бы делать оба журнала нечитаемыми.
 */
async function writeExtractAiRun(
  deps: SegmentationDeps,
  ctx: JobContext<'doc.extract_fields'>,
  input: { readonly folderId: string; readonly prompt: PublishedPrompt },
  call: LlmCallResult | null,
  structured: { documentId: string; accepted: number; problems: readonly string[] },
): Promise<void> {
  // Отказ до состоявшегося вызова: хэшей нет, и строка без них нарушила бы
  // собственные CHECK'и `ai_runs`.
  if (call === null) return;

  await deps.recordAiRun({
    folderId: input.folderId,
    stage: FIELD_EXTRACT_STAGE,
    provider: call.provider,
    model: call.model,
    promptCode: input.prompt.code,
    promptVersion: input.prompt.version,
    inputHash: call.inputHash,
    outputHash: call.outputHash,
    tokensIn: call.tokensIn,
    tokensOut: call.tokensOut,
    cost: call.cost,
    latencyMs: call.latencyMs,
    structuredResult: structured,
    requestId: ctx.payload.request_id ?? null,
  });
}

// =====================================================================
// Задача 17. doc.parse_registry
// =====================================================================

/** Вид документа-реестра приложений. */
const REGISTRY_TYPE = 'annex_registry';

/**
 * Разбор реестров приложений (§8.3).
 *
 * Реестров в поставке столько же, сколько актов, и разбирается каждый по
 * СВОИМ страницам: таблица продолжается на следующем листе без шапки, и
 * склейка идёт внутри одного документа, а не по всей ревизии — иначе реестр
 * второго акта дочитался бы как продолжение первого.
 *
 * Комплект без реестра — не отказ. Из трёх комплектов корпуса реестра нет у
 * одного, и это законное оформление: при пяти и менее приложениях реестр не
 * обязателен (§9.3, `AOSR.P3`).
 */
export function createParseRegistryHandler(
  deps: SegmentationDeps,
): JobHandler<'doc.parse_registry'> {
  return async (ctx: JobContext<'doc.parse_registry'>) => {
    const { folderId } = ctx.payload;

    const documents = await deps.listDocuments(folderId);
    const registries = documents.filter((document) => document.docTypeCode === REGISTRY_TYPE);

    const input = await deps.loadPages(folderId);
    const pageById = new Map(input.pages.map((page) => [page.sourcePageId, page]));
    const assignments = [...(await deps.listPageAssignments(folderId))].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
    );

    let rows = 0;
    const warnings: string[] = [];
    for (const registry of registries) {
      const pages = assignments
        .filter((assignment) => assignment.documentId === registry.id)
        .map((assignment) => pageById.get(assignment.sourcePageId))
        .filter((page): page is NonNullable<typeof page> => page !== undefined)
        .map((page) => ({
          sourcePageId: page.sourcePageId,
          pageTextVersionId: page.pageTextVersionId,
          text: page.text,
        }));

      const parsed = parseAnnexRegistry({ pages });
      warnings.push(...parsed.warnings);
      const outcome = await deps.saveRegistryRows({
        folderId,
        documentId: registry.id,
        rows: parsed.rows,
      });
      rows += outcome.written;
    }

    const counts = { registries: registries.length, rows, warnings: warnings.length };
    ctx.logger.info({ counts, warnings }, 'реестры приложений разобраны');
    await ctx.emit('documents.registry_parsed', counts);

    await ctx.enqueue({
      type: 'doc.match_registry',
      payload: { folderId, ...forwardAutoContinue(ctx) },
      dedupeKey: `doc.match_registry:${folderId}`,
    });
  };
}

// =====================================================================
// Задача 18. doc.match_registry
// =====================================================================

/**
 * Сверка реестра с фактическим составом комплекта (§8.3).
 *
 * Сверка идёт ТОЛЬКО по номеру. Реестр называет документы не так, как они
 * называются сами («Паспорт качества Арматура №16005» против «СЕРТИФИКАТ
 * КАЧЕСТВА № 16005»), и расхождение вида дефектом комплекта не является —
 * проверено чтением корпуса, `docs/CORPUS_FINDINGS.md`.
 *
 * Номер документа берётся из реквизита `number`, который извлекла задача 16, —
 * поэтому 18 идёт ПОСЛЕ 16, а не параллельно ей. Порядок «сначала реквизиты,
 * потом сверка» и есть причина, по которой конвейер здесь линеен.
 *
 * Строки сопоставляются с разобранными ПО ПОРЯДКУ: `matchRegistryRows`
 * возвращает ровно одно решение на строку входа в том же порядке, а `row_no`
 * ключом быть не может — нумерация реестра начинается заново в каждом разделе
 * (миграция 0015).
 */
export function createMatchRegistryHandler(
  deps: SegmentationDeps,
): JobHandler<'doc.match_registry'> {
  return async (ctx: JobContext<'doc.match_registry'>) => {
    const { folderId } = ctx.payload;

    const stored = await deps.listRegistryRows(folderId);
    const documents = await deps.listDocuments(folderId);

    if (stored.length === 0) {
      const counts = { rows: 0, matched: 0, missing: 0, ambiguous: 0, candidate: 0, extra: 0 };
      ctx.logger.info({ counts }, 'реестра в поставке нет: сверять нечего');
      await ctx.emit('documents.registry_matched', counts);
      await ctx.enqueue({
        type: 'graph.build',
        payload: { folderId, ...forwardAutoContinue(ctx) },
        dedupeKey: `graph.build:${folderId}`,
      });
      return;
    }

    // Номеров у документа может быть несколько: у исполнительной схемы он
    // приходит шифром схемы из штампа, у бланочных форм рядом с `number` стоит
    // номер бланка. Список кодов — общий для обеих сверок (`documentNumbersOf`).
    const numbers = new Map<string, readonly string[]>();
    // Дата выдачи — слабый признак КАНДИДАТА, а не основание совпадения:
    // строка, которой номер не ответил, может быть узнана по дате.
    const issuedAt = new Map<string, string | null>();
    for (const document of documents) {
      const values = await deps.listFieldValues(document.id);
      numbers.set(document.id, documentNumbersOf(values));
      issuedAt.set(
        document.id,
        values.find((value) => value.fieldCode === 'issued_at')?.valueDate ?? null,
      );
    }

    const registryDocumentIds = new Set(stored.map((row) => row.documentId));

    /**
     * Кандидаты сверки — документы ЭТОГО ЖЕ комплекта, а не всей папки.
     *
     * Прежде сверка искала по всей ревизии, и на папке из двенадцати актов это
     * давало 72 строки «сопоставлено неоднозначно» из 138: один и тот же
     * сертификат лежит в приложениях каждого акта, и по номеру он отвечал
     * двенадцати строкам сразу. Различить их сверка не могла и честно
     * отказывалась — правильный ответ на неправильно поставленный вопрос.
     *
     * Комплект границу и задаёт: перечень приложений принадлежит одному акту, и
     * искать его строки за пределами этого акта незачем. Документы вне
     * комплектов (опись, титулы) в кандидаты не попадают вовсе: перечень
     * приложений акта их не называет.
     */
    const candidatesOf = (complectId: string | null): readonly MatchableDocument[] =>
      documents
        // Сам реестр в сверку не входит: он перечисляет приложения, а не себя.
        .filter((document) => !registryDocumentIds.has(document.id))
        .filter((document) => complectId !== null && document.complectId === complectId)
        .map((document) => ({
          documentId: document.id,
          docTypeCode: document.docTypeCode,
          numbers: numbers.get(document.id) ?? [],
          issuedAt: issuedAt.get(document.id) ?? null,
          title: document.title,
        }));

    const matches: RegistryMatch[] = [];
    let matched = 0;
    let missing = 0;
    let ambiguous = 0;
    let candidate = 0;
    const extra = new Set<string>();

    // По каждому перечню отдельно: и строки, и КАНДИДАТЫ берутся из одного
    // комплекта — перечень принадлежит акту, и документы соседних актов ему
    // не отвечают.
    const complectOfDocument = new Map(documents.map((d) => [d.id, d.complectId]));
    for (const registryDocumentId of registryDocumentIds) {
      const matchable = candidatesOf(complectOfDocument.get(registryDocumentId) ?? null);
      const rowsOfRegistry = stored.filter((row) => row.documentId === registryDocumentId);
      const parsed: readonly ParsedRegistryRow[] = rowsOfRegistry.map((row) => ({
        rowNo: row.rowNo,
        sectionTitle: row.sectionTitle,
        docNameRaw: row.docNameRaw,
        docNoRaw: row.docNoRaw,
        orgRaw: row.orgRaw,
        docNoNorm: row.docNoNorm,
        docNoFolded: row.docNoFolded,
        validFrom: row.validFrom,
        validTo: row.validTo,
        issuedAt: row.issuedAt,
      }));

      const outcome = matchRegistryRows(parsed, matchable);
      for (const id of outcome.extraDocumentIds) extra.add(id);

      for (const [index, decision] of outcome.rows.entries()) {
        const row = rowsOfRegistry[index];
        if (row === undefined) continue;
        matches.push({
          registryRowId: row.id,
          matchedDocumentId: decision.matchedDocumentId,
          matchScore: decision.matchScore,
          matchState: decision.matchState,
          candidates: decision.candidates.map((candidate) => ({
            documentId: candidate.documentId,
            basis: candidate.basis,
            score: candidate.score,
          })),
        });
        if (decision.matchState === 'matched') matched += 1;
        else if (decision.matchState === 'ambiguous') ambiguous += 1;
        else if (decision.matchState === 'candidate') candidate += 1;
        else missing += 1;
      }
    }

    const saved = await deps.saveRegistryMatches({ folderId, matches });
    if (saved.updated !== matches.length) {
      throw new SegmentationStateError(
        `Записано ${saved.updated} решений сверки из ${matches.length}.`,
      );
    }

    const counts = {
      rows: stored.length,
      matched,
      missing,
      ambiguous,
      candidate,
      extra: extra.size,
    };
    ctx.logger.info({ counts }, 'реестр сверен с комплектом');
    await ctx.emit('documents.registry_matched', counts);

    await ctx.enqueue({
      type: 'graph.build',
      payload: { folderId, ...forwardAutoContinue(ctx) },
      dedupeKey: `graph.build:${folderId}`,
    });
  };
}

// =====================================================================
// Задача 19. graph.build
// =====================================================================

/** Группы каталога, определяющие вид связи документа с актом. */
const PROTOCOL_TYPES = /^lab_protocol_|^sampling_act$|^protocol_/u;
const QUALITY_TYPES =
  /^cert_conformity$|^declaration$|^quality_passport$|^technical_passport$|^mill_certificate$|^mix_quality_doc$|^fire_certificate$|^refusal_letter$|^equipment_passport$|^ttn$|^other_quality_docs$/u;
const PRIMARY_TYPES = /^aosr/u;

/**
 * Чертежи: исполнительные схемы, генплан, схемы сетей и свай.
 *
 * Выделены ради одного вопроса — «свой ли это номер»: у чертежа собственного
 * номера на листе нет, и извлечённый берётся из штампа, где стоит шифр рабочей
 * документации, общий на весь файл.
 */
const DRAWING_TYPES = /^exec_|^other_exec_schemes$/u;

/** Реквизит акта, в котором перечислены применённые материалы и их документы. */
const ACT_ITEM3_FIELD = 'p3_materials';

/**
 * Текст п. 3 акта одной строкой.
 *
 * Реквизит объявлен списком: LLM-стадия отдаёт позиции перечня массивом в
 * `valueJson`, а `valueText` хранит их же склейкой. Читаются оба, потому что
 * форма зависит от того, чем реквизит заполнен, а вопрос к нему один — какие
 * номера документов в нём названы.
 */
function actItem3Text(field: FieldValueView | undefined): string {
  if (field === undefined) return '';
  const json = field.valueJson;
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === 'string').join('\n');
  }
  return field.valueText ?? '';
}

/**
 * Граф проверки: кто чьё приложение (§9.1).
 *
 * Связи выводятся из ФАКТОВ, установленных предыдущими задачами, и ниоткуда
 * больше:
 *
 * * акт → его реестр приложений (`annex`) — по порядку следования: реестр
 *   идёт непосредственно за актом, к которому относится;
 * * акт → документ, названный строкой ЕГО реестра и опознанный сверкой
 *   (`quality_doc` либо `protocol` по виду документа, иначе `annex`);
 * * дубль — два документа одного вида с одинаковым номером (`duplicate`).
 *
 * `ambiguous` связью НЕ становится: §8.3 требует, чтобы совпадение только по
 * фолдингу при коллизии оставалось неразрешённым, и превращать его в ребро
 * графа значило бы восстановить ровно то утверждение, от которого сверка
 * отказалась.
 *
 * Документ незнакомого вида связи не теряет: он привязывается к акту наравне с
 * остальными, если реестр его назвал. Именно поэтому вид документа влияет
 * только на ИМЯ связи, а не на её существование.
 */
export function createGraphBuildHandler(deps: SegmentationDeps): JobHandler<'graph.build'> {
  return async (ctx: JobContext<'graph.build'>) => {
    const { folderId } = ctx.payload;

    const documents = [...(await deps.listDocuments(folderId))].sort(
      (a, b) => a.ordinal - b.ordinal,
    );
    if (documents.length === 0) {
      throw new SegmentationStateError(
        `Ревизия ${folderId}: документов нет, граф строить не из чего.`,
      );
    }

    const rows = await deps.listRegistryRows(folderId);
    const byId = new Map(documents.map((document) => [document.id, document]));
    const relations: DocumentRelationInput[] = [];
    const seen = new Set<string>();

    const add = (
      parentDocumentId: string,
      childDocumentId: string,
      relation: DocumentRelationInput['relation'],
    ): void => {
      if (parentDocumentId === childDocumentId) return;
      const key = `${parentDocumentId}|${childDocumentId}|${relation}`;
      if (seen.has(key)) return;
      seen.add(key);
      relations.push({ parentDocumentId, childDocumentId, relation });
    };

    // Акт → его реестр: ближайший предшествующий акт в порядке документов.
    const registryOwner = new Map<string, string>();
    let currentAct: string | null = null;
    for (const document of documents) {
      if (document.docTypeCode !== null && PRIMARY_TYPES.test(document.docTypeCode)) {
        currentAct = document.id;
        continue;
      }
      if (document.docTypeCode === REGISTRY_TYPE && currentAct !== null) {
        registryOwner.set(document.id, currentAct);
        add(currentAct, document.id, 'annex');
      }
    }

    // Акт → документ, названный строкой его реестра и опознанный сверкой.
    for (const row of rows) {
      if (row.matchState !== 'matched' || row.matchedDocumentId === null) continue;
      const parent = registryOwner.get(row.documentId);
      if (parent === undefined) continue;
      const child = byId.get(row.matchedDocumentId);
      if (child === undefined) continue;
      const code = child.docTypeCode ?? '';
      const relation = PROTOCOL_TYPES.test(code)
        ? 'protocol'
        : QUALITY_TYPES.test(code)
          ? 'quality_doc'
          : 'annex';
      add(parent, child.id, relation);
    }

    const fieldsByDocument = new Map<string, readonly FieldValueView[]>();
    for (const document of documents) {
      fieldsByDocument.set(document.id, await deps.listFieldValues(document.id));
    }

    // Акт → документ, названный в п. 3 самого акта.
    //
    // Второй законный способ назвать приложение: бланк пишет «Приложения: в
    // соответствии с п. 3, 4», то есть приложениями объявлены и перечень
    // документов о качестве из п. 3, и реестр из п. 4. Ребро строится по тому же
    // номеру и той же лестницей (`documentsNamedInActItem3`), что и по реестру, —
    // разница только в том, где напечатана ссылка.
    for (const act of documents) {
      const code = act.docTypeCode;
      if (code === null || !PRIMARY_TYPES.test(code)) continue;

      const item3 = (fieldsByDocument.get(act.id) ?? []).find(
        (field) => field.fieldCode === ACT_ITEM3_FIELD,
      );
      const text = actItem3Text(item3);
      if (text === '') continue;

      const matchable: readonly MatchableDocument[] = documents
        .filter((candidate) => candidate.id !== act.id && candidate.docTypeCode !== REGISTRY_TYPE)
        .map((candidate) => ({
          documentId: candidate.id,
          docTypeCode: candidate.docTypeCode,
          numbers: documentNumbersOf(fieldsByDocument.get(candidate.id) ?? []),
          issuedAt: null,
          title: candidate.title,
        }));

      for (const documentId of documentsNamedInActItem3(text, matchable)) {
        const child = byId.get(documentId);
        if (child === undefined) continue;
        const childCode = child.docTypeCode ?? '';
        add(
          act.id,
          child.id,
          PROTOCOL_TYPES.test(childCode)
            ? 'protocol'
            : QUALITY_TYPES.test(childCode)
              ? 'quality_doc'
              : 'annex',
        );
      }
    }

    // Дубли: одинаковый вид и одинаковый номер В ОДНОМ КОМПЛЕКТЕ. Правило по
    // контексту, а не ограничение БД (§9.3, `XS`).
    //
    // Границей служит комплект, а не папка. Один и тот же сертификат законно
    // лежит в приложениях каждого из двенадцати актов папки: подрядчик обязан
    // приложить его к КАЖДОМУ акту, где применён материал. На боевом прогоне
    // сравнение по всей папке дало 74 ребра `duplicate` — то есть объявило
    // дублями законные экземпляры и увело сверку в «неоднозначно».
    //
    // Чертёж в сравнение не входит: собственного номера у него на листе нет, и
    // тот, что извлечён, взят из штампа — а в штамп печатается шифр рабочей
    // документации, один на весь файл. Две исполнительные схемы комплекта
    // `№01_Бл_П` получили из штампа один и тот же «02-200223-ГПЗ.1» и были
    // объявлены дублем друг друга, хотя сняты с разных осей и разных отметок.
    // Совпадение шифра здесь означает «оба листа из одного комплекта РД», а не
    // «это один и тот же лист дважды».
    const numbers = new Map<string, string[]>();
    for (const document of documents) {
      const code = document.docTypeCode ?? '-';
      if (DRAWING_TYPES.test(code)) continue;
      const fields = fieldsByDocument.get(document.id) ?? [];
      const number = fields.find((field) => field.fieldCode === 'number')?.valueText ?? null;
      if (number === null || number.trim() === '') continue;
      const key = `${document.complectId ?? 'вне комплектов'}|${code}|${number.trim().toUpperCase()}`;
      const list = numbers.get(key) ?? [];
      list.push(document.id);
      numbers.set(key, list);
    }
    for (const list of numbers.values()) {
      if (list.length < 2) continue;
      const [first, ...rest] = list;
      if (first === undefined) continue;
      for (const other of rest) add(first, other, 'duplicate');
    }

    const saved = await deps.saveDocumentRelations({ folderId, relations });
    const counts = {
      documents: documents.length,
      relations: saved.written,
      skipped: saved.skipped,
      duplicates: relations.filter((relation) => relation.relation === 'duplicate').length,
    };
    ctx.logger.info({ counts }, 'граф документов построен');
    await ctx.emit('documents.graph_built', counts);

    // Хвост цепочки анализа. До S21 он был терминальным, и прогон правил
    // человек запускал шестой кнопкой; теперь при сквозном прогоне он идёт
    // сам. Ключ идемпотентности — по ревизии: пересобранная нарезка не должна
    // порождать второй прогон правил, пока первый ещё в очереди.
    if (ctx.payload.autoContinue === true) {
      await ctx.enqueue({
        type: 'checks.run',
        payload: { folderId },
        dedupeKey: `checks.run:${folderId}`,
      });
    }
  };
}
