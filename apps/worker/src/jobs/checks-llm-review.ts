/**
 * Задача `checks.llm_review` — второй этап проверки (§9.1, S21).
 *
 * Движок правил сравнивает факт с нормой, напечатанной рядом, и делает это
 * детерминированно. Эта задача добирает то, что формой не выражается: пустую
 * обязательную графу, значение, взятое из соседней строки, шапку и подвал,
 * называющие разные организации. Заказчик назвал это прямо: «распознанный текст
 * отправляется на анализ, сопоставление, поиск ошибок».
 *
 * ## Замечания дописываются в чужой прогон, и это решение
 *
 * `validation_runs.ruleset_version_id` объявлен `NOT NULL`, поэтому собственного
 * прогона у ИИ-стадии быть не может — а если бы и был, инженер видел бы две
 * строки «проверка от 12:31» и гадал, какая полная. Поэтому задача принимает
 * `validationRunId` и пишет `saveLlmFindings`, который заменяет ТОЛЬКО строки
 * `origin='llm'`: повтор задачи заменяет свой выход целиком и не трогает
 * результат движка (§12).
 *
 * ## Отсутствие модели — не отказ конвейера
 *
 * Нет опубликованного промта, не подключён провайдер, исчерпан бюджет — задача
 * завершается успехом, назвав причину. Детерминированные замечания уже
 * записаны, и ронять из-за внешней модели стадию, которая без неё работает,
 * запрещает §0.5. Отказ провайдера при этом прекращает обход остальных
 * документов: он относится ко всем, и тридцать бесполезных вызовов подряд
 * оплачивал бы заказчик.
 */
import {
  LlmError,
  renderReviewUserPrompt,
  reviewDocumentWithLlm,
  type JobContext,
  type JobHandler,
  type LlmProviderName,
  type ReviewDocument,
} from '@id/api';
import type { PreparedFinding } from '@id/rules';

import {
  LLM_REVIEW_STAGE,
  type LlmCallResult,
  type LlmTextStage,
  type PublishedPrompt,
} from './segmentation.js';

export { LLM_REVIEW_STAGE };

export interface ChecksLlmReviewDeps {
  /**
   * Документы ревизии с текстом страниц и извлечёнными реквизитами.
   *
   * Реквизиты идут в промт не для полноты: без них код `LLM.FILL.020`
   * («извлечённое значение расходится с документом») сравнивать не с чем.
   */
  loadReviewDocuments(folderId: string): Promise<readonly ReviewDocument[]>;

  saveLlmFindings(input: {
    readonly validationRunId: string;
    readonly folderId: string;
    readonly findings: readonly PreparedFinding[];
  }): Promise<{ readonly removed: number; readonly written: number }>;

  /** Опубликованный промт стадии; `null` — проверка пропускается. */
  stagePrompt(stage: LlmTextStage): Promise<PublishedPrompt | null>;

  /** Вызов модели. `null` — провайдер не подключён. */
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

  recordAiRun(input: {
    readonly folderId: string;
    readonly stage: LlmTextStage;
    readonly provider: LlmProviderName;
    readonly model: string;
    readonly promptCode: string;
    readonly promptVersion: number;
    readonly inputHash: string;
    readonly outputHash: string | null;
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    readonly cost: number | null;
    readonly latencyMs: number;
    readonly structuredResult: unknown;
    readonly requestId: string | null;
  }): Promise<void>;
}

export function createChecksLlmReviewHandler(
  deps: ChecksLlmReviewDeps,
): JobHandler<'checks.llm_review'> {
  return async (ctx: JobContext<'checks.llm_review'>) => {
    const { folderId, validationRunId } = ctx.payload;

    const prompt = await deps.stagePrompt(LLM_REVIEW_STAGE);
    if (prompt === null || deps.callLlm === null) {
      // Штатное состояние, а не отказ: см. шапку. Причина названа, чтобы
      // «модель не позвали» не выглядело как «модель ничего не нашла».
      const reason =
        prompt === null
          ? 'у стадии check нет ни опубликованного, ни встроенного промта'
          : 'провайдер модели не подключён';
      ctx.logger.info({ event: 'llm_review_skipped', reason }, 'ИИ-проверка пропущена');
      await ctx.emit('checks.llm_review_skipped', { validationRunId, reason });
      await enqueueSummary(ctx);
      return;
    }

    const documents = await deps.loadReviewDocuments(folderId);
    const accepted: PreparedFinding[] = [];
    const problems: string[] = [];
    let stop: string | null = null;
    let reviewed = 0;

    for (const document of documents) {
      if (stop !== null) break;
      // Кооперативная отмена: без неё брошенная по аренде попытка продолжала
      // обходить весь комплект рядом с новой, взятой ей на смену (S44).
      ctx.signal.throwIfAborted();
      const outcome = await runOne(deps, ctx, { folderId, document, prompt });
      accepted.push(...outcome.findings);
      problems.push(...outcome.problems);
      stop = outcome.stop;
      if (outcome.stop === null) reviewed += 1;
    }

    // Запись идёт ОДНИМ вызовом в конце, а не по документу: `saveLlmFindings`
    // заменяет весь свой выход, и запись внутри цикла стирала бы замечания
    // предыдущих документов на каждом шаге.
    const saved = await deps.saveLlmFindings({
      validationRunId,
      folderId,
      findings: accepted,
    });

    const counts = {
      documents: documents.length,
      reviewed,
      findings: saved.written,
      problems: problems.length,
      stopped: stop,
    };
    ctx.logger.info({ counts, problems }, 'ИИ-проверка заполнения выполнена');
    await ctx.emit('checks.llm_review_completed', { validationRunId, ...counts });
    await enqueueSummary(ctx);
  };
}

/**
 * Сводка прогона — последнее звено цепочки проверок.
 *
 * Ставится и на пропуске стадии, и после неё: сводка считает записанные
 * замечания, и без неё прогон остался бы без `finished_at`. Один вызов на оба
 * пути, потому что забыть его на редкой ветке — значит получить конвейер,
 * который «работает, пока модель настроена».
 */
async function enqueueSummary(ctx: JobContext<'checks.llm_review'>): Promise<void> {
  await ctx.enqueue({
    type: 'checks.summarize',
    payload: {
      folderId: ctx.payload.folderId,
      validationRunId: ctx.payload.validationRunId,
    },
    dedupeKey: `checks.summarize:${ctx.payload.validationRunId}`,
  });
}

interface OneOutcome {
  readonly findings: readonly PreparedFinding[];
  readonly problems: readonly string[];
  readonly stop: string | null;
}

async function runOne(
  deps: ChecksLlmReviewDeps,
  ctx: JobContext<'checks.llm_review'>,
  input: {
    readonly folderId: string;
    readonly document: ReviewDocument;
    readonly prompt: PublishedPrompt;
  },
): Promise<OneOutcome> {
  const call = deps.callLlm;
  if (call === null) return { findings: [], problems: [], stop: null };

  const userPrompt = renderReviewUserPrompt(
    {
      docTypeCode: input.document.docTypeCode,
      fields: input.document.fields,
      pages: input.document.pages,
    },
    input.prompt.userTemplate,
  );

  let recorded: LlmCallResult | null = null;
  try {
    const outcome = await reviewDocumentWithLlm(
      input.document,
      {
        complete: async (request) => {
          const response = await call({
            stage: LLM_REVIEW_STAGE,
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
      documentId: input.document.documentId,
      accepted: outcome.findings.length,
      problems: outcome.problems,
    });
    return { findings: outcome.findings, problems: outcome.problems, stop: null };
  } catch (error) {
    if (error instanceof LlmError) {
      await writeAiRun(deps, ctx, input, recorded, {
        documentId: input.document.documentId,
        accepted: 0,
        problems: [error.message],
      });
      return { findings: [], problems: [error.message], stop: error.message };
    }
    throw error;
  }
}

/** Строка `ai_runs` стадии `check`: только хэши и структурированный итог (§3.5). */
async function writeAiRun(
  deps: ChecksLlmReviewDeps,
  ctx: JobContext<'checks.llm_review'>,
  input: { readonly folderId: string; readonly prompt: PublishedPrompt },
  call: LlmCallResult | null,
  structured: { documentId: string; accepted: number; problems: readonly string[] },
): Promise<void> {
  if (call === null) return;

  await deps.recordAiRun({
    folderId: input.folderId,
    stage: LLM_REVIEW_STAGE,
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
