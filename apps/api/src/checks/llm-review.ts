/**
 * ИИ-проверка заполнения: разбор ответа модели в замечания (§9.1, S21).
 *
 * ## Что эта стадия проверяет, чего не проверяет движок правил
 *
 * Движок сравнивает ФАКТ С НОРМОЙ, напечатанной рядом, и делает это
 * детерминированно: даты, номера, контрольные суммы, наличие приложений.
 * Чего он не умеет — прочитать документ и сказать «в графе „Изготовитель“
 * стоит наименование лаборатории» или «номер акта в шапке и в подвале
 * разный». Это и есть второй этап проверки, названный заказчиком: «распознанный
 * текст отправляется на анализ, сопоставление, поиск ошибок».
 *
 * ## Модель не придумывает коды
 *
 * `rule_code` — внешний ключ на `rule_definitions`, и выдуманный код кончился
 * бы отказом транзакции записи, то есть потерей ВСЕГО прогона из-за одной
 * строки. Поэтому набор кодов закрыт (`LLM_REVIEW_CODES`), схема ответа
 * проверяет принадлежность, а замечание с чужим кодом отбрасывается с
 * названной причиной.
 *
 * ## Цитата обязательна
 *
 * По той же причине, что и при извлечении реквизитов: замечание без опоры на
 * текст неотличимо от сочинённого, а показывается оно инженеру рядом с
 * цитатой и ссылкой на страницу. Не отобразилась на текст — замечание
 * отброшено.
 *
 * ## Ни одно замечание не блокирует
 *
 * `state` может быть только `open` или `undetermined`, `isBlocking` всегда
 * `false`. Это не осторожность, а инвариант БД (`findings_llm_blocking_chk`):
 * находка модели становится блокирующей лишь после подтверждения человеком
 * (§3.7, §9.1). Троичность при этом сохранена: «нашёл дефект» и «не смог
 * определить» — разные ответы, и второй не выдаётся за первый.
 */
import { z } from 'zod';

import { isLlmReviewCode, LLM_REVIEW_CODES } from '@id/rules';
import type { PreparedFinding } from '@id/rules';

import { LlmError } from '../llm/port.js';
import { locateQuote } from '../segmentation/llm-classify.js';

/**
 * Версия схемы ответа.
 *
 * Входит в ключ кэша LLM: изменение схемы меняет смысл ответа, и
 * переиспользовать записи, сделанные по прежней схеме, нельзя.
 */
export const LLM_REVIEW_SCHEMA_VERSION = 'checks.llm_review.v1';

/** Потолок замечаний на один документ: защита от «модель разошлась». */
const MAX_FINDINGS = 24;

const MAX_MESSAGE_LENGTH = 500;

const responseSchema = z.object({
  findings: z
    .array(
      z.object({
        code: z.string().min(1),
        /**
         * `open` — дефект найден; `undetermined` — данных для вывода не хватило.
         * Третьего значения нет: `resolved`/`waived` ставит человек.
         */
        state: z.enum(['open', 'undetermined']),
        severity: z.enum(['error', 'warning', 'info']),
        message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
        /** Способ устранения: замечание без него бесполезно подрядчику (§9.1). */
        hint: z.string().max(MAX_MESSAGE_LENGTH).nullish(),
        quote: z.string().min(1),
      }),
    )
    .max(MAX_FINDINGS),
});

/** Документ на входе проверки: то, что модель читает и на что ссылается. */
export interface ReviewDocument {
  readonly documentId: string;
  readonly docTypeCode: string | null;
  readonly pages: readonly {
    readonly sourcePageId: string;
    readonly pageTextVersionId: string | null;
    readonly text: string;
  }[];
  readonly fields: readonly {
    readonly fieldCode: string;
    readonly valueText: string | null;
    readonly valueDate: string | null;
  }[];
}

export interface LlmReviewDeps {
  readonly complete: (req: {
    systemPrompt: string;
    userPrompt: string;
    schemaVersion: string;
    cacheContext: string;
  }) => Promise<{ text: string }>;
}

export interface LlmReviewOutcome {
  readonly findings: readonly PreparedFinding[];
  readonly problems: readonly string[];
}

/** Дословная формулировка отказа по цитате: на неё опираются тест и журнал. */
export const REVIEW_QUOTE_NOT_MAPPED = 'цитата не отображается на текст документа';

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/iu.exec(trimmed);
  return fenced ? (fenced[1] as string).trim() : trimmed;
}

/**
 * Проверяет заполнение одного документа моделью.
 *
 * Непригодный ОТВЕТ — пустой результат с названной причиной: документ просто
 * остаётся без ИИ-замечаний, детерминированные никуда не деваются. Отказ
 * ПРОВАЙДЕРА пробрасывается: он относится ко всем последующим документам, и
 * вызывающий обязан прекратить обход, а не оплачивать тридцать бесполезных
 * вызовов подряд.
 */
export async function reviewDocumentWithLlm(
  document: ReviewDocument,
  deps: LlmReviewDeps,
  promptText: { system: string; user: string },
): Promise<LlmReviewOutcome> {
  if (document.pages.length === 0) return { findings: [], problems: [] };

  let raw: string;
  try {
    const result = await deps.complete({
      systemPrompt: promptText.system,
      userPrompt: promptText.user,
      schemaVersion: LLM_REVIEW_SCHEMA_VERSION,
      cacheContext: document.documentId,
    });
    raw = result.text;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { findings: [], problems: [`провайдер не ответил: ${message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { findings: [], problems: ['ответ модели не является JSON'] };
  }

  const checked = responseSchema.safeParse(parsed);
  if (!checked.success) {
    return { findings: [], problems: ['ответ модели не соответствует схеме'] };
  }

  const findings: PreparedFinding[] = [];
  const problems: string[] = [];

  for (const item of checked.data.findings) {
    if (!isLlmReviewCode(item.code)) {
      // Выдуманный код не пройдёт по внешнему ключу и уронил бы всю запись.
      problems.push(
        `код «${item.code}» не входит в набор ИИ-проверки (${LLM_REVIEW_CODES.join(', ')})`,
      );
      continue;
    }

    const located = locateInDocument(document, item.quote);
    if (located === null) {
      problems.push(`${item.code}: ${REVIEW_QUOTE_NOT_MAPPED}`);
      continue;
    }

    findings.push({
      ruleCode: item.code,
      severity: item.severity,
      state: item.state,
      // См. шапку: инвариант БД, а не умолчание.
      isBlocking: false,
      origin: 'llm',
      targetType: 'document',
      targetId: document.documentId,
      sourcePageId: located.sourcePageId,
      message: item.message,
      hint: item.hint ?? null,
      evidence: [located.evidence],
    });
  }

  return { findings, problems };
}

/**
 * Ищет цитату по страницам документа и возвращает вместе со страницей.
 *
 * Страница нужна отдельно от span: `findings.source_page_id` — это адрес, по
 * которому экран открывает доказательство, и без него ссылка «перейти к
 * замечанию» не строится вовсе (§16).
 */
function locateInDocument(
  document: ReviewDocument,
  quote: string,
): { sourcePageId: string; evidence: NonNullable<PreparedFinding['evidence']>[number] } | null {
  for (const page of document.pages) {
    const evidence = locateQuote(page, quote);
    if (evidence !== null) return { sourcePageId: page.sourcePageId, evidence };
  }
  return null;
}
