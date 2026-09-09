/**
 * Сверка строк перечня с документами комплекта моделью (S57).
 *
 * ## Почему стадия отдельная, а не часть задачи 18
 *
 * Задача 18 (`doc.match_registry`) осталась предфильтром: она отвечает на
 * вопрос, на который отвечает арифметика, — совпал ли номер посимвольно или
 * после свёртки написания. Это дёшево, детерминированно и переигрывается точно.
 * Всё остальное — смысл: «б/н» у приложения, партия вместо номера, организация,
 * записанная другим лицом, ссылка на чужой акт. Смысл судит модель.
 *
 * Разделение проходит там же, где проходит граница доверия: точное совпадение
 * модель не переспаривает (`mergeLlmMatches`), а всё, что ниже, она решает,
 * называя документ и довод.
 *
 * ## Почему веер, а не один обход в одной задаче
 *
 * На боевой папке выборок около двух десятков, и обход их подряд в одной задаче
 * упирается в аренду: попытка, не уложившаяся в потолок, теряется целиком
 * вместе с оплаченными вызовами. Тот же урок уже оплачен извлечением реквизитов
 * (S44) — постановщик, единица работы, барьер. Здесь устройство то же:
 * `doc.match_plan` считает выборки, `doc.match_partition` берёт одну, а
 * `doc.match_finalize` ждёт всех и передаёт эстафету графу.
 *
 * ## Что происходит без модели
 *
 * Ничего страшного и ничего молчаливого: строки остаются на решении
 * предфильтра, ниже него становятся `undetermined` («портал не сопоставил»), и
 * причина называется в событии. Портал не притворяется, будто проверил.
 */
import {
  acceptDecisions,
  JobDeferredError,
  mergeLlmMatches,
  registryMatchResponseSchema,
  renderRegistryMatchPrompt,
  type LlmRowDecision,
  type PrefilterRow,
  type PromptDocument,
  type PromptRow,
  type PartitionRow,
} from '@id/api';

import { REGISTRY_MATCH_STAGE } from './segmentation.js';

import type { JobContext, JobHandler } from '@id/api';
import type { SegmentationDeps } from './segmentation.js';

/** Версия схемы ответа: уезжает в ключ кэша и в эффективный промт. */
const SCHEMA_VERSION = 'segmentation.registry_match.v1';

/**
 * Потолок объёма одной выборки.
 *
 * Не в символах, а в строках и документах: выборка — это таблица, и урезать её
 * серединой текста означало бы оборвать строку на половине графы. Усечение
 * называется в промте прямо, чтобы модель не рассуждала о том, чего ей не
 * показали.
 */
const MAX_ROWS_PER_CALL = 60;
const MAX_DOCUMENTS_PER_CALL = 60;

/** Дословная причина пропуска: на неё опираются событие и тесты. */
export const MATCH_LLM_NO_PROVIDER = 'провайдер модели не подключён';
export const MATCH_LLM_NO_PROMPT =
  'у стадии registry_match нет ни опубликованного, ни встроенного промта';

export function createMatchPlanHandler(deps: SegmentationDeps): JobHandler<'doc.match_plan'> {
  return async (ctx: JobContext<'doc.match_plan'>) => {
    const { folderId } = ctx.payload;

    const prompt = await deps.stagePrompt(REGISTRY_MATCH_STAGE);
    if (prompt === null || deps.callLlm === null) {
      const reason = prompt === null ? MATCH_LLM_NO_PROMPT : MATCH_LLM_NO_PROVIDER;
      ctx.logger.info({ event: 'registry_match_llm_skipped', reason }, 'сверка моделью пропущена');
      await ctx.emit('documents.registry_match_llm_skipped', { reason });
      await enqueueGraph(ctx);
      return;
    }

    const partitions = await deps.matchPartitions(folderId);
    if (partitions.length === 0) {
      await ctx.emit('documents.registry_match_llm_skipped', { reason: 'сверять нечего' });
      await enqueueGraph(ctx);
      return;
    }

    // Поколение — идентификатор ЭТОЙ постановки. Без него барьер не отличил бы
    // свой веер от веера следующего прогона (тот же приём, что у извлечения).
    const generation = ctx.jobId;
    for (const partition of partitions) {
      await ctx.enqueue({
        type: 'doc.match_partition',
        payload: {
          folderId,
          generation,
          partitionKey: partition.key,
          ...forwardAutoContinue(ctx),
        },
        dedupeKey: `doc.match_partition:${generation}:${partition.key}`,
      });
    }

    await ctx.enqueue({
      type: 'doc.match_finalize',
      payload: { folderId, generation, ...forwardAutoContinue(ctx) },
      dedupeKey: `doc.match_finalize:${generation}`,
    });

    ctx.logger.info({ partitions: partitions.length }, 'сверка моделью разложена по выборкам');
  };
}

export function createMatchPartitionHandler(
  deps: SegmentationDeps,
): JobHandler<'doc.match_partition'> {
  return async (ctx: JobContext<'doc.match_partition'>) => {
    const { folderId, partitionKey } = ctx.payload;

    const prompt = await deps.stagePrompt(REGISTRY_MATCH_STAGE);
    if (prompt === null || deps.callLlm === null) {
      // Промт или провайдер исчезли между постановкой и исполнением. Не отказ:
      // строки остаются на предфильтре, барьер посчитает выборку необойдённой.
      ctx.logger.info({ partitionKey }, 'выборка пропущена: модель недоступна');
      return;
    }

    const partition = await deps.matchPartition(folderId, partitionKey);
    if (partition === null || partition.rows.length === 0) {
      ctx.logger.info({ partitionKey }, 'выборка исчезла между постановкой и исполнением');
      return;
    }

    const userPrompt = renderRegistryMatchPrompt(
      {
        scope: partition.scope,
        rows: partition.rows.slice(0, MAX_ROWS_PER_CALL).map(toPromptRow),
        documents: partition.documents.slice(0, MAX_DOCUMENTS_PER_CALL).map(toPromptDocument),
        truncated: truncationNote(partition),
      },
      prompt.userTemplate,
    );

    const started = Date.now();

    /**
     * Отказ провайдера НЕ перехватывается, и это решение, а не упущение.
     *
     * Бюджет, чужая модель, выключенный провайдер (`LlmError` со
     * `stopsBatch`) означают, что не выйдет и у соседних выборок. Ловить их
     * здесь значило бы записать «сверено» по выборке, которую никто не смотрел,
     * и оплатить ещё девятнадцать таких же попыток. Пусть задача умрёт: барьер
     * сосчитает мёртвых и подведёт итог честно, а строки останутся на
     * предфильтре.
     */
    const call = await deps.callLlm({
      stage: REGISTRY_MATCH_STAGE,
      promptCode: prompt.code,
      promptVersion: prompt.version,
      systemPrompt: prompt.systemPrompt,
      userPrompt,
      schemaVersion: SCHEMA_VERSION,
      cacheContext: `${folderId}:${partitionKey}`,
      ...(prompt.modelOverride === null ? {} : { model: prompt.modelOverride }),
    });

    const parsed = safeParse(call.text);
    const outcome =
      parsed === null
        ? { decisions: [], problems: ['ответ модели не является JSON нужной формы'] }
        : acceptDecisions(parsed, {
            rowIds: new Set(partition.rows.map((row) => row.id)),
            documentIds: new Set(partition.documents.map((document) => document.documentId)),
          });
    const decisions: readonly LlmRowDecision[] = outcome.decisions;
    const problems: readonly string[] = outcome.problems;

    const prefilter: readonly PrefilterRow[] = partition.rows.map((row) => ({
      rowId: row.id,
      matchState: row.matchState,
      matchedDocumentId: row.matchedDocumentId,
      matchScore: row.matchScore,
      candidates: [],
    }));

    const merged = mergeLlmMatches(prefilter, decisions, {
      locateInFolder: (rowId) => partition.folderWide[rowId] ?? null,
    });

    const aiRunId = await deps.recordAiRun({
      folderId,
      stage: REGISTRY_MATCH_STAGE,
      provider: call.provider,
      model: call.model,
      promptCode: prompt.code,
      promptVersion: prompt.version,
      inputHash: call.inputHash,
      outputHash: call.outputHash,
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
      cost: call.cost,
      latencyMs: Date.now() - started,
      // В аудит уходит РЕШЕНИЕ, а не текст: сообщения расхождений лежат в самих
      // строках, и второй их экземпляр только раздувал бы `structured_result`,
      // у которого свой потолок в 32 КБ.
      structuredResult: {
        partitionKey,
        rows: merged.map((row) => ({
          rowId: row.rowId,
          state: row.matchState,
          by: row.matchedBy,
          basis: row.matchBasis,
          checks: row.checks.length,
        })),
        problems,
      },
      requestId: ctx.payload.request_id ?? null,
    });

    await deps.saveRegistryMatches({
      folderId,
      matches: merged.map((row) => ({
        registryRowId: row.rowId,
        matchedDocumentId: row.matchedDocumentId,
        matchScore: row.matchScore,
        matchState: row.matchState,
        matchedBy: row.matchedBy,
        matchBasis: row.matchBasis,
        matchNote: row.matchNote,
        matchAiRunId: aiRunId,
        checks: row.checks,
        rowAnchors: partition.anchors[row.rowId] ?? null,
        candidates: row.candidates,
      })),
    });

    ctx.logger.info(
      { partitionKey, rows: merged.length, problems: problems.length },
      'выборка сверена моделью',
    );
  };
}

export function createMatchFinalizeHandler(
  deps: SegmentationDeps,
): JobHandler<'doc.match_finalize'> {
  return async (ctx: JobContext<'doc.match_finalize'>) => {
    const { folderId, generation } = ctx.payload;

    const fan = await deps.matchFanState(folderId, generation);
    if (fan.live > 0) {
      throw new JobDeferredError(`Сверка моделью ещё идёт: ${fan.live} из ${fan.total} выборок`);
    }

    ctx.logger.info({ fan }, 'сверка моделью завершена');
    await ctx.emit('documents.registry_match_llm_completed', {
      partitions: fan.total,
      failed: fan.dead,
    });
    await enqueueGraph(ctx);
  };
}

/**
 * Граф — единственный преемник обеих ветвей.
 *
 * Ставится и при пропуске стадии, и после её завершения: забыть его на редкой
 * ветке значит получить конвейер, который «работает, пока модель настроена».
 */
async function enqueueGraph(
  ctx: JobContext<'doc.match_plan'> | JobContext<'doc.match_finalize'>,
): Promise<void> {
  await ctx.enqueue({
    type: 'graph.build',
    payload: { folderId: ctx.payload.folderId, ...forwardAutoContinue(ctx) },
    dedupeKey: `graph.build:${ctx.payload.folderId}`,
  });
}

/** Сквозной прогон протягивается через веер: без него цепочка обрывается. */
function forwardAutoContinue(ctx: {
  readonly payload: { readonly autoContinue?: boolean | undefined };
}): { autoContinue?: boolean } {
  return ctx.payload.autoContinue === true ? { autoContinue: true } : {};
}

function truncationNote(partition: {
  readonly rows: readonly unknown[];
  readonly documents: readonly unknown[];
}): string | null {
  const notes: string[] = [];
  if (partition.rows.length > MAX_ROWS_PER_CALL) {
    notes.push(
      `показаны первые ${String(MAX_ROWS_PER_CALL)} строк из ${String(partition.rows.length)}`,
    );
  }
  if (partition.documents.length > MAX_DOCUMENTS_PER_CALL) {
    notes.push(
      `показаны первые ${String(MAX_DOCUMENTS_PER_CALL)} документов из ${String(partition.documents.length)}`,
    );
  }
  return notes.length === 0 ? null : `Внимание: ${notes.join('; ')}.`;
}

function toPromptRow(row: PartitionRow): PromptRow {
  return {
    rowId: row.id,
    position: row.sectionTitle ?? `строка ${String(row.rowNo)}`,
    docNameRaw: row.docNameRaw,
    docNoRaw: row.docNoRaw,
    orgRaw: row.orgRaw,
    issuedAt: row.issuedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    prefilter: prefilterNote(row),
  };
}

/**
 * Что решил предфильтр — словами, чтобы модель знала, где он остановился.
 *
 * Решённая строка (посимвольно или после свёртки написания, S59) модели не
 * переспаривается: её документ неприкосновенен (`isSettledPrefilter`), и в
 * выборку она попадает только соседкой нерешённых строк.
 */
function prefilterNote(row: PartitionRow): string {
  if (row.matchState === 'matched' && row.matchScore === 1) {
    return `номер совпал посимвольно с документом ${row.matchedDocumentId ?? '—'}; решение принято, не переспаривай`;
  }
  if (row.matchState === 'matched') {
    return `номер сошёлся после свёртки написания с документом ${row.matchedDocumentId ?? '—'}; решение принято, не переспаривай`;
  }
  return 'номер не сошёлся ни с одним документом';
}

function toPromptDocument(document: {
  readonly documentId: string;
  readonly kind: string;
  readonly title: string | null;
  readonly pageCount: number | null;
  readonly fields: readonly string[];
}): PromptDocument {
  return document;
}

function safeParse(text: string): ReturnType<typeof registryMatchResponseSchema.parse> | null {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text.trim());
  const body = fenced?.[1] ?? text;
  try {
    const parsed: unknown = JSON.parse(body);
    const result = registryMatchResponseSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
