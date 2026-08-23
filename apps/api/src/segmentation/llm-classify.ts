/**
 * Фаза 2 сегментации — классификация страницы моделью (§8.2).
 *
 * Модель вызывается ТОЛЬКО для страниц, которые фаза 1 оставила без сигнала.
 * Провайдер приходит инъекцией: здесь нет ни сети, ни базы, ни ключей, ни
 * кэша — только схема ответа, её разбор и отображение цитаты на текст.
 *
 * ## Почему разбор устроен недоверчиво
 *
 * Ответ модели — это ВХОДНЫЕ ДАННЫЕ, а не результат. Три состояния должны
 * различаться, и все три обязаны оставлять след:
 *
 * - ответ разобран и подтверждён цитатой → классификация;
 * - ответ не разобран (не JSON, не по схеме, цитата не подтверждается) →
 *   `undetermined`: классификации нет, причина названа. Страница остаётся
 *   `U` и достаётся человеку;
 * - исключение провайдера → то же самое, но это отказ инфраструктуры.
 *
 * Чего здесь нет ни при каких условиях — молчаливого `U` без следа. §9.1
 * требует троичной логики, и «модель ответила ерунду» обязано отличаться от
 * «модель честно сказала, что не знает»: первое чинится промтом и моделью,
 * второе — расширением каталога.
 *
 * ## Цитата — не украшение, а условие принятия ответа
 *
 * §8.2 требует отобразить цитату на точный span `page_text_versions`, и
 * невозможность отображения делает результат `undetermined`. Причина
 * практическая: модель, сочинившая цитату, столь же охотно сочинит и вид
 * документа, а обнаружить это по самому ответу нельзя. Проверка цитаты —
 * единственный дешёвый способ отличить чтение страницы от пересказа
 * ожиданий. Поэтому цитата обязательна даже у ответа `U`.
 */
import { DOC_TYPES } from '@id/doc-types';
import { z } from 'zod';
import { LlmError } from '../llm/port.js';
import type { PageClassification, PageInput, TextEvidence, TypeOutcome } from './types.js';

/**
 * Версия схемы ответа.
 *
 * Входит в ключ кэша LLM (§8.2): изменение схемы меняет смысл ответа, и
 * переиспользовать записи, сделанные по прежней схеме, нельзя — они разберутся
 * без ошибок и дадут неверное решение.
 */
export const SCHEMA_VERSION = 'segmentation.page_classify.v1';

/** Исходы вида документа, которые модель называет словом, а не кодом. */
const OPEN_WORLD_OUTCOMES = ['other', 'uncertain'] as const;

/**
 * Коды, которые модель имеет право назвать.
 *
 * Резервные типы исключены: их присваивает декодер по исходу `other`
 * (см. `prompts.ts`). Ответ резервным кодом — не по схеме.
 */
const KNOWN_CODES: ReadonlySet<string> = new Set(
  DOC_TYPES.filter((t) => !t.isFallback).map((t) => t.code),
);

const responseSchema = z
  .object({
    label: z.enum(['B-DOC', 'I-DOC', 'A-ROLE', 'U']),
    doc_type: z
      .string()
      .refine((v) => KNOWN_CODES.has(v) || (OPEN_WORLD_OUTCOMES as readonly string[]).includes(v), {
        message:
          'doc_type обязан быть кодом каталога либо ровно "other"/"uncertain"; ' +
          'перевод названия вида на любой язык кодом не является',
      }),
    // Заголовок нужен не всегда, но при `other` — обязателен: см. проверку ниже.
    observed_title: z.string().nullish(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    // Цитата обязательна и непуста: ответ без опоры на текст не принимается.
    quote: z.string().min(1),
  })
  .refine((v) => v.doc_type !== 'other' || (v.observed_title ?? '').trim().length > 0, {
    message:
      'при doc_type = "other" поле observed_title обязательно: без него незнакомый вид ' +
      'не попадёт в doc_type_candidates и цикл роста каталога не работает',
    path: ['observed_title'],
  });

type LlmResponse = z.infer<typeof responseSchema>;

export interface LlmClassifyDeps {
  readonly complete: (req: {
    systemPrompt: string;
    userPrompt: string;
    schemaVersion: string;
    cacheContext: string;
  }) => Promise<{ text: string }>;
}

export interface LlmClassifyOutcome {
  /** `null` — модель не дала пригодного ответа; страница остаётся `U`. */
  readonly classification: PageClassification | null;
  /** Причина для журнала прогона и счётчиков `ai_runs.counts`. */
  readonly problem: string | null;
}

/** Дословная формулировка отказа по цитате: на неё опирается тест и журнал. */
export const QUOTE_NOT_MAPPED = 'цитата не отображается на текст страницы';

// ── Отображение цитаты на исходный текст ──────────────────────────────────

/**
 * Разметка, снимаемая при нормализации строки.
 *
 * Повторяет по смыслу `normalizeLine` из `@id/doc-types`, но посимвольно: та
 * возвращает готовую строку, а нам нужны ПОЗИЦИИ каждого уцелевшего символа в
 * исходном тексте. Без позиций цитату некуда отобразить, а `field_values.char_span`
 * и `finding_evidence.char_span` измеряются именно по исходному тексту.
 */
const LEADING_MARKUP: readonly RegExp[] = [/^[\s>]*#{1,6}\s*/u, /^[\s>*+-]+/u, /^\s*\|\s*/u];
const TRAILING_MARKUP = /[\s|*_`]+$/u;
/** Символы акцента, вычищаемые по всей строке. */
const INLINE_MARKUP = /[*_`]/u;
/**
 * Разделители внутри строки: пробельные символы И граница ячейки таблицы.
 *
 * `|` попал сюда по замеру корпуса (`temp/MD/new`, семь комплектов): цитата,
 * захватившая две соседние ячейки, не отображалась НИ РАЗУ из 1154 — а именно
 * так модель и цитирует пару «ярлык — значение», потому что в бумаге это одна
 * строка таблицы: «Партия № 58071», «Дата изготовления 21.04.2025». Требовать
 * от модели цитировать ровно одну ячейку значит требовать от неё знания о том,
 * как портал хранит текст страницы.
 *
 * Отображение при этом не становится доверчивее: диапазон по-прежнему обязан
 * найтись в тексте страницы, а `quote` записывается срезом ИСХОДНОГО текста —
 * с трубой внутри. Цитата, склеившая ячейки РАЗНЫХ строк, не совпадёт: порядок
 * символов от смены класса разделителя не меняется.
 */
const CELL_SEPARATOR = /[\s|]/u;

interface Projection {
  /** Нормализованный текст всей страницы одной строкой. */
  readonly text: string;
  /** `offsets[i]` — позиция символа `text[i]` в исходном тексте страницы. */
  readonly offsets: readonly number[];
}

/**
 * Строит нормализованную проекцию текста страницы вместе с картой позиций.
 *
 * Переводы строк схлопываются в пробел наравне с остальными пробельными
 * символами: OCR рвёт заголовок на строки произвольно, и цитата модели
 * «СЕРТИФИКАТ СООТВЕТСТВИЯ» обязана находиться на странице, где эти слова
 * стоят на разных строках. Регистр сохраняется — §8.2 требует нормализовать
 * пробелы и разметку, а не текст.
 */
function project(text: string): Projection {
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSeparator: number | null = null;

  const lineRe = /\r?\n/gu;
  let lineStart = 0;
  const pushLine = (start: number, end: number): void => {
    let from = start;
    for (const re of LEADING_MARKUP) {
      const m = re.exec(text.slice(from, end));
      if (m && m.index === 0) from += m[0].length;
    }
    let to = end;
    const tail = TRAILING_MARKUP.exec(text.slice(from, end));
    if (tail) to = from + tail.index;

    for (let i = from; i < to; i += 1) {
      const ch = text[i] as string;
      if (INLINE_MARKUP.test(ch)) continue;
      if (CELL_SEPARATOR.test(ch)) {
        pendingSeparator ??= i;
        continue;
      }
      if (chars.length > 0 && pendingSeparator !== null) {
        chars.push(' ');
        offsets.push(pendingSeparator);
      }
      pendingSeparator = null;
      chars.push(ch);
      offsets.push(i);
    }
  };

  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    pushLine(lineStart, m.index);
    pendingSeparator ??= m.index;
    lineStart = m.index + m[0].length;
  }
  pushLine(lineStart, text.length);

  return { text: chars.join(''), offsets };
}

/**
 * Нормализует цитату теми же правилами, что и текст страницы.
 *
 * Буквально теми же: `project()` вызывается и здесь, и на тексте страницы.
 * Раньше цитата шла через `normalizeLine`, а страница — через `project()`, и
 * «те же правила» держались совпадением двух реализаций. Они разошлись:
 * `project()` снимает ХВОСТОВОЙ ПРОГОН разделителей, а `normalizeLine` — ровно
 * одну трубу, поэтому строка таблицы с пустой последней ячейкой
 * (`| Партия № | 58071 |  |`) давала цитату с лишней трубой на конце и не
 * находилась. По замеру корпуса это 61 строка из 3281 — молча потерянные
 * значения, неотличимые от «модель ничего не нашла».
 */
function normalizeQuote(quote: string): string {
  return project(quote).text;
}

/**
 * Отображает цитату модели на точный диапазон в ИСХОДНОМ тексте страницы.
 *
 * При нескольких вхождениях берётся первое: выбрать «правильное» из
 * одинаковых нельзя, а отказываться от подтверждённой цитаты из-за её
 * повторяемости — значит терять верные ответы на страницах с таблицами.
 */
export function locateQuote(
  // Структурный минимум, а не `PageInput`: отображению цитаты нужны ровно текст
  // и версия, в которой измеряется span. Извлечение реквизитов (§8.4) работает
  // со страницами документа, у которых остальных полей `PageInput` нет вовсе, а
  // выдумывать их ради вызова значило бы подсунуть сюда неправду.
  page: { readonly pageTextVersionId: string | null; readonly text: string },
  quote: string,
): TextEvidence | null {
  if (page.pageTextVersionId === null) return null;
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return null;

  const projection = project(page.text);
  const at = projection.text.indexOf(needle);
  if (at < 0) return null;

  const charStart = projection.offsets[at] as number;
  const charEnd = (projection.offsets[at + needle.length - 1] as number) + 1;
  return {
    pageTextVersionId: page.pageTextVersionId,
    charStart,
    charEnd,
    // Срез ИСХОДНОГО текста, а не строка модели: `types.ts` требует, чтобы
    // `quote` был ровно `text.slice(charStart, charEnd)` — иначе подсветка
    // в UI разойдётся с записанным диапазоном.
    quote: page.text.slice(charStart, charEnd),
  };
}

// ── Разбор ответа ─────────────────────────────────────────────────────────

/**
 * Снимает обрамление ```…``` вокруг JSON.
 *
 * Терпимость ровно к одному отклонению — оформлению, а не содержанию: код
 * внутри всё равно проходит полную проверку схемой. Ответ, отличающийся от
 * схемы хоть чем-то существенным, отвергается.
 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/iu.exec(trimmed);
  return fenced ? (fenced[1] as string).trim() : trimmed;
}

function outcomeFor(response: LlmResponse): {
  docTypeCode: string | null;
  typeOutcome: TypeOutcome;
} {
  // Страница, про которую модель сказала «определить невозможно», не может
  // одновременно утверждать вид документа: документа она не открывает.
  if (response.label === 'U') return { docTypeCode: null, typeOutcome: 'none' };
  if (response.doc_type === 'other') return { docTypeCode: null, typeOutcome: 'other' };
  if (response.doc_type === 'uncertain') return { docTypeCode: null, typeOutcome: 'uncertain' };
  return { docTypeCode: response.doc_type, typeOutcome: 'known' };
}

/**
 * Классифицирует одну страницу моделью.
 *
 * Непригодный ОТВЕТ наружу не бросается: не JSON, не по схеме, выдуманная
 * цитата — это `classification: null` и названная причина. Исключение здесь
 * уронило бы весь прогон сегментации из-за одной страницы, а страница без
 * ответа модели — штатное состояние, она просто достаётся человеку.
 *
 * ## Отказ ПРОВАЙДЕРА, наоборот, пробрасывается
 *
 * `LlmError` несёт то, чего в строке `problem` нет и быть не может:
 * повторяемость, признак «отказ относится ко всем последующим вызовам» и
 * состоявшуюся попытку с хэшем промта. Решения по ним принимает вызывающий —
 * писать ли строку `ai_runs`, прерывать ли обход остальных страниц. Пока этот
 * слой сворачивал `LlmError` в текст, вся эта информация уничтожалась здесь:
 * ветка обработки отказа провайдера в `createClassifyPagesHandler` НЕ
 * ИСПОЛНЯЛАСЬ НИ РАЗУ, таймаут не оставлял строки в аудите, а исчерпанный
 * бюджет дёргал провайдера на каждой оставшейся странице.
 *
 * Прочие исключения порта остаются свёрнутыми: неклассифицированный сбой
 * адаптера ничего вызывающему не сообщает, и «страница без ответа» — верное
 * его описание.
 */
export async function classifyPageWithLlm(
  page: PageInput,
  neighbours: { before: PageInput | null; after: PageInput | null },
  deps: LlmClassifyDeps,
  promptText: { system: string; user: string },
): Promise<LlmClassifyOutcome> {
  let raw: string;
  try {
    const result = await deps.complete({
      systemPrompt: promptText.system,
      userPrompt: promptText.user,
      schemaVersion: SCHEMA_VERSION,
      // Соседний контекст входит в ключ кэша (§8.2): та же страница между
      // другими соседями — другая задача о границе, и ответ на неё другой.
      cacheContext: [
        page.sourcePageId,
        neighbours.before?.sourcePageId ?? '-',
        neighbours.after?.sourcePageId ?? '-',
      ].join('|'),
    });
    raw = result.text;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { classification: null, problem: `провайдер не ответил: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { classification: null, problem: `ответ не является JSON: ${message}` };
  }

  const validated = responseSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join('.') || '<корень>'}: ${i.message}`)
      .join('; ');
    return { classification: null, problem: `ответ не соответствует схеме: ${issues}` };
  }
  const response = validated.data;

  const evidence = locateQuote(page, response.quote);
  if (evidence === null) {
    return { classification: null, problem: QUOTE_NOT_MAPPED };
  }

  const { docTypeCode, typeOutcome } = outcomeFor(response);
  const observedTitle = (response.observed_title ?? '').trim();

  return {
    classification: {
      sourcePageId: page.sourcePageId,
      label: response.label,
      docTypeCode,
      typeOutcome,
      observedTitle: observedTitle.length > 0 ? observedTitle : null,
      // Роль страницы модель не называет: в схеме §8.2 такого поля нет, а
      // выводить роль из `label: 'A-ROLE'` значило бы выдумать код роли.
      pageRoleCode: null,
      parentRef: null,
      confidence: response.confidence,
      reason: response.reason,
      source: 'llm',
      alternatives: [],
      ambiguous: false,
      evidence,
    },
    problem: null,
  };
}

/**
 * Страницы, для которых нужен вызов модели.
 *
 * Только `U` и только не размеченные человеком: ручная разметка приоритетна
 * и фазой 2 не переопределяется (§8.2). Отдельная функция, а не фильтр по
 * месту, потому что это правило стоимости прогона — его меняют осознанно.
 */
export function pagesNeedingLlm(
  classifications: readonly PageClassification[],
): readonly PageClassification[] {
  return classifications.filter((c) => c.label === 'U' && c.source !== 'manual');
}
