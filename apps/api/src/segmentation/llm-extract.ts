/**
 * Извлечение реквизитов, у которых `extractor: 'llm'` (§8.4).
 *
 * До S21 таких полей не извлекал НИКТО. `extract.ts` их сознательно
 * пропускает — и правильно делает: «первая строка после слова ИЗГОТОВИТЕЛЬ»
 * дала бы значение с `extractedBy: 'rule'`, то есть выдала бы догадку за
 * проверенный факт. Но второй ступени, которая их возьмёт, не существовало, и
 * `issuer`, `applicant`, `manufacturer`, `product_name`, `product_marks`,
 * `basis_documents` оставались пустыми всегда. Правила §9, которые на них
 * опираются, при этом честно отвечали `undetermined` — то есть портал молча не
 * проверял часть того, ради чего заведён.
 *
 * ## Устройство повторяет фазу 2 сегментации, и это намеренно
 *
 * Здесь нет ни сети, ни базы, ни ключей: провайдер приходит инъекцией, а модуль
 * знает только схему ответа, её разбор и отображение цитаты на текст. Тот же
 * приём, что в `llm-classify.ts`, и по той же причине — ответ модели это
 * ВХОДНЫЕ ДАННЫЕ, а не результат.
 *
 * ## Цитата обязательна, и это не формальность
 *
 * Значение без цитаты не принимается вовсе. Наименование организации,
 * сочинённое моделью, неотличимо от прочитанного — ни по форме, ни по
 * правдоподобию, — а попав в `field_values`, оно уходит в правила §9 и в сверку
 * с реестром §8.3 наравне с номером и датой. Отображение цитаты на точный span
 * `page_text_versions` — единственная дешёвая проверка того, что модель читала
 * страницу, а не пересказывала ожидания. Поэтому неотобразившееся значение
 * отбрасывается с названной причиной, а не записывается с низкой уверенностью.
 *
 * ## Чего этот модуль не делает
 *
 * Не решает, блокирует ли что-нибудь его результат: у всех значений
 * `extractedBy: 'llm'`, и §9.1 требует подтверждения человеком, прежде чем
 * замечание по ним станет блокирующим. Не трогает поля с `extractor: 'rule'` —
 * даже если модель их назвала: детерминированное извлечение уже дало по ним
 * ответ, и второй источник правды с правом опровергнуть первый здесь не нужен.
 */
import { z } from 'zod';

import { BASE_EVIDENCE_FIELDS, DOC_TYPES, fieldsForType } from '@id/doc-types';
import type { FieldDefinition } from '@id/doc-types';

import { LlmError } from '../llm/port.js';
import { locateQuote } from './llm-classify.js';
import type { ExtractedField } from './types.js';

/** Страница документа на входе извлечения: текст и версия, в которой span. */
export interface ExtractPage {
  readonly pageTextVersionId: string | null;
  readonly text: string;
}

/**
 * Версия схемы ответа.
 *
 * Входит в ключ кэша LLM: изменение схемы меняет смысл ответа, и
 * переиспользовать записи, сделанные по прежней схеме, нельзя — они разберутся
 * без ошибок и дадут неверные значения.
 */
export const EXTRACT_SCHEMA_VERSION = 'segmentation.field_extract.v1';

/** Потолок значений в одном ответе: защита от «модель перечислила всё подряд». */
const MAX_VALUES = 32;

/** Потолок длины одного значения: наименование продукции — не абзац. */
const MAX_VALUE_LENGTH = 500;

const responseSchema = z.object({
  values: z
    .array(
      z.object({
        code: z.string().min(1),
        /** `null` — модель прочитала страницу и значения не нашла. */
        value: z.string().max(MAX_VALUE_LENGTH).nullable(),
        /** Список для полей типа `list`; пусто — значение не список. */
        items: z.array(z.string().max(MAX_VALUE_LENGTH)).nullish(),
        confidence: z.number().min(0).max(1),
        /** Цитата обязательна и непуста даже при `value: null`: см. шапку. */
        quote: z.string().min(1),
      }),
    )
    .max(MAX_VALUES),
});

export interface LlmExtractDeps {
  readonly complete: (req: {
    systemPrompt: string;
    userPrompt: string;
    schemaVersion: string;
    cacheContext: string;
  }) => Promise<{ text: string }>;
}

export interface LlmExtractOutcome {
  readonly fields: readonly ExtractedField[];
  /** Причины отброшенных значений — для журнала прогона и `ai_runs.counts`. */
  readonly problems: readonly string[];
}

/** Дословная формулировка отказа по цитате: на неё опираются тест и журнал. */
export const EXTRACT_QUOTE_NOT_MAPPED = 'цитата не отображается на текст документа';

/**
 * Поля документа, которые обязана дать модель.
 *
 * Базовая схема применяется ВСЕГДА, типо-специфичная — только при уверенно
 * определённом типе. Правило то же, что в `extract.ts`, и по той же причине:
 * специфичный экстрактор на документе другого вида не «не найдёт», а найдёт
 * НЕ ТО.
 */
export function llmFieldsFor(input: {
  readonly docTypeCode: string | null;
  readonly typeConfident: boolean;
}): readonly FieldDefinition[] {
  const definition =
    input.typeConfident && input.docTypeCode !== null
      ? (DOC_TYPES.find((type) => type.code === input.docTypeCode) ?? null)
      : null;
  const specific =
    definition === null ? [] : fieldsForType(definition.fieldSchema, definition.kind);
  const all = [...BASE_EVIDENCE_FIELDS, ...specific];

  const seen = new Set<string>();
  const result: FieldDefinition[] = [];
  for (const field of all) {
    if (field.extractor !== 'llm') continue;
    if (seen.has(field.code)) continue;
    seen.add(field.code);
    result.push(field);
  }
  return result;
}

/**
 * Снимает обрамление ```…``` вокруг JSON.
 *
 * Терпимость ровно к одному отклонению — оформлению, а не содержанию: код
 * внутри всё равно проходит полную проверку схемой.
 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/iu.exec(trimmed);
  return fenced ? (fenced[1] as string).trim() : trimmed;
}

/**
 * Извлекает LLM-поля одного документа.
 *
 * Непригодный ОТВЕТ наружу не бросается: не JSON, не по схеме, выдуманная
 * цитата — это пустой результат и названная причина. Исключение здесь уронило
 * бы прогон извлечения из-за одного документа, а документ без реквизитов от
 * модели — штатное состояние: они просто останутся пустыми, как и до S21.
 *
 * Отказ ПРОВАЙДЕРА, наоборот, пробрасывается: `LlmError` несёт повторяемость и
 * признак «отказ относится ко всем последующим вызовам», и решение по ним
 * принимает вызывающий. Свернуть его в строку значило бы дёргать исчерпанный
 * бюджет на каждом оставшемся документе — дефект, уже разобранный на фазе 2.
 */
export async function extractFieldsWithLlm(
  input: {
    readonly docTypeCode: string | null;
    readonly typeConfident: boolean;
    readonly documentId: string;
    readonly pages: readonly ExtractPage[];
  },
  deps: LlmExtractDeps,
  promptText: { system: string; user: string },
): Promise<LlmExtractOutcome> {
  const wanted = llmFieldsFor(input);
  if (wanted.length === 0 || input.pages.length === 0) return { fields: [], problems: [] };

  let raw: string;
  try {
    const result = await deps.complete({
      systemPrompt: promptText.system,
      userPrompt: promptText.user,
      schemaVersion: EXTRACT_SCHEMA_VERSION,
      // Документ целиком — единица кэша: реквизиты читаются из шапки и подвала,
      // и постраничный ключ дал бы разные ответы на разных страницах одного
      // документа.
      cacheContext: input.documentId,
    });
    raw = result.text;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { fields: [], problems: [`провайдер не ответил: ${message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { fields: [], problems: ['ответ модели не является JSON'] };
  }

  const checked = responseSchema.safeParse(parsed);
  if (!checked.success) {
    return { fields: [], problems: ['ответ модели не соответствует схеме'] };
  }

  const byCode = new Map(wanted.map((field) => [field.code, field]));
  const fields: ExtractedField[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();

  for (const value of checked.data.values) {
    const definition = byCode.get(value.code);
    if (definition === undefined) {
      // Поле не заказывали. Молча пропустить нельзя: это сигнал о расхождении
      // промта и каталога, а не безобидная болтливость модели.
      problems.push(`поле «${value.code}» не запрашивалось`);
      continue;
    }
    if (taken.has(value.code)) {
      problems.push(`поле «${value.code}» названо дважды`);
      continue;
    }

    // Модель прочитала и не нашла — это ответ, а не значение. Пустая строка
    // в `field_values` выглядела бы прочитанным пустым реквизитом.
    if (value.value === null && (value.items ?? []).length === 0) {
      taken.add(value.code);
      continue;
    }

    const evidence = locateAcrossPages(input.pages, value.quote);
    if (evidence === null) {
      problems.push(`${value.code}: ${EXTRACT_QUOTE_NOT_MAPPED}`);
      continue;
    }

    taken.add(value.code);
    const items = value.items ?? [];
    fields.push({
      fieldCode: value.code,
      valueText: definition.type === 'list' ? null : (value.value?.trim() ?? null),
      valueDate: null,
      valueNum: null,
      valueJson:
        definition.type === 'list'
          ? items.map((item) => item.trim()).filter((item) => item.length > 0)
          : null,
      confidence: value.confidence,
      extractedBy: 'llm',
      evidence,
    });
  }

  return { fields, problems };
}

/**
 * Ищет цитату по страницам документа, а не по одной.
 *
 * Реквизиты живут в шапке и подвале, и документ из четырёх листов даёт
 * `issuer` на первом, а `basis_documents` — на последнем. Первое совпадение
 * побеждает: выбрать «правильное» из одинаковых нельзя, а отказ от
 * подтверждённой цитаты из-за её повторяемости терял бы верные значения.
 */
function locateAcrossPages(
  pages: readonly ExtractPage[],
  quote: string,
): ExtractedField['evidence'] {
  for (const page of pages) {
    const found = locateQuote(page, quote);
    if (found !== null) return found;
  }
  return null;
}
