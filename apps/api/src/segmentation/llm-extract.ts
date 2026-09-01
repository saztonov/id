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
import { toIsoDate } from './extract.js';
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

/**
 * Сколько лишних значений сверх заказанных разбор ещё готов просмотреть.
 *
 * Защита от «модель перечислила всё подряд» осталась, но считается от числа
 * запрошенных полей: константа 32 при тридцати одном заказанном поле не
 * оставляла запаса и превращала любую болтливость в потерю всего ответа.
 */
const MAX_EXTRA_VALUES = 8;

/** Потолок длины одного значения: наименование продукции — не абзац. */
const MAX_VALUE_LENGTH = 500;

/**
 * Оболочка ответа и ОТДЕЛЬНО — форма одного значения.
 *
 * Разделение принципиальное, и вот почему. Прежде схема была одна: массив
 * значений внутри объекта проверялся целиком, и `safeParse` над ним отвечал
 * «да» или «нет» на весь документ сразу. На боевой папке из 220 страниц это
 * дало 306 отброшенных ответов из 402 — три четверти работы модели в мусор, —
 * и у десяти актов из двенадцати не осталось НИ ОДНОГО реквизита. Причина
 * каждый раз была одна: единственный элемент из тридцати одного не проходил
 * проверку (цитата пустая, значение длиннее потолка), а вместе с ним падали
 * тридцать годных.
 *
 * Инварианты при этом не ослаблены ни на йоту: годным элемент считается по тем
 * же условиям, что и раньше, — цитата непуста, значение в пределах потолка,
 * уверенность в [0,1]. Изменилась ЕДИНИЦА проверки: негодное значение теперь
 * отбрасывается со своей причиной, а не уносит с собой документ.
 */
const envelopeSchema = z.object({ values: z.array(z.unknown()) });

const valueSchema = z.object({
  code: z.string().min(1),
  /** `null` — модель прочитала страницу и значения не нашла. */
  value: z.string().max(MAX_VALUE_LENGTH).nullable(),
  /** Список для полей типа `list`; пусто — значение не список. */
  items: z.array(z.string().max(MAX_VALUE_LENGTH)).nullish(),
  confidence: z.number().min(0).max(1),
  /** Цитата обязательна и непуста даже при `value: null`: см. шапку. */
  quote: z.string().min(1),
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

/** Отказ по ОБОЛОЧКЕ ответа: это единственное, что обнуляет документ целиком. */
export const EXTRACT_ENVELOPE_BROKEN = 'ответ модели не является объектом со списком values';

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

  // `fieldsForType` УЖЕ знает, какие типы имеют базовые реквизиты: у `primary`
  // (акт) и `registry` (реестр приложений) их нет, потому что ни изготовителя,
  // ни продукции, ни срока действия у них не бывает. Безусловная подмешка
  // базовой схемы отменяла это знание и заставляла модель искать в АКТЕ
  // `product_name`, `manufacturer` и `issuer` — то есть платить за вопрос, на
  // который честный ответ всегда `null`, и получать натянутый, когда модель
  // всё же что-нибудь найдёт.
  //
  // Базовая схема остаётся для документа, тип которого НЕ определён: §8.4
  // требует, чтобы номер, даты и продукция извлекались и у незнакомого вида, —
  // именно это позволяет работать на разделе, которого система не видела.
  const all =
    definition === null
      ? BASE_EVIDENCE_FIELDS
      : fieldsForType(definition.fieldSchema, definition.kind);

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

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return { fields: [], problems: [EXTRACT_ENVELOPE_BROKEN] };
  }

  const byCode = new Map(wanted.map((field) => [field.code, field]));
  const fields: ExtractedField[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();

  // Потолок считается от числа ЗАКАЗАННЫХ полей, а не константой: у акта их
  // тридцать один, и прежний общий потолок в 32 не оставлял запаса ни на один
  // лишний элемент. Запас нужен не модели, а разбору: он отделяет «модель
  // назвала пару лишних кодов» от «модель перечислила всё подряд».
  const limit = wanted.length + MAX_EXTRA_VALUES;
  if (envelope.data.values.length > limit) {
    problems.push(`ответ длиннее ожидаемого: значений ${String(envelope.data.values.length)}`);
  }

  for (const raw of envelope.data.values.slice(0, limit)) {
    const element = valueSchema.safeParse(raw);
    if (!element.success) {
      // Причина называется поимённо и по КОНКРЕТНОМУ полю: «ответ не
      // соответствует схеме» без адреса не позволял отличить длинное значение
      // от пустой цитаты, и разбор боевого прогона упирался в эту фразу.
      const code =
        typeof (raw as { code?: unknown })?.code === 'string'
          ? (raw as { code: string }).code
          : 'без кода';
      const issue = element.error.issues[0];
      const where = issue === undefined ? '' : ` (${issue.path.join('.')}: ${issue.message})`;
      problems.push(`${code}: значение не соответствует форме ответа${where}`);
      continue;
    }
    const value = element.data;
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

    const evidence = locateAcrossPages(input.pages, value.quote);
    if (evidence === null) {
      problems.push(`${value.code}: ${EXTRACT_QUOTE_NOT_MAPPED}`);
      continue;
    }

    const empty = value.value === null && (value.items ?? []).length === 0;
    if (empty) {
      // НАБЛЮДАЕМОЕ ПУСТОЕ ЗНАЧЕНИЕ, а не отсутствие ответа.
      //
      // До S27 такой ответ просто отбрасывался, и «модель прочитала графу и
      // нашла её пустой» становилось неотличимо от «до реквизита извлечение не
      // дошло». Правилам это различие нужно: первое — дефект бумаги, второе —
      // состояние конвейера, и §9.1 требует по ним РАЗНЫХ вердиктов (`fail`
      // против `undetermined`). Разница выражена формой строки: все значения
      // пусты, но цитата отобразилась на текст — то есть место в документе, где
      // реквизита нет, указано и проверяемо.
      taken.add(value.code);
      fields.push({
        fieldCode: value.code,
        valueText: null,
        valueDate: null,
        valueNum: null,
        valueJson: null,
        confidence: value.confidence,
        extractedBy: 'llm',
        evidence,
      });
      continue;
    }

    const typed = typedValue(definition, value.value, value.items ?? []);
    if (typed === null) {
      // Значение не разобралось в свой тип: дата не существует в календаре,
      // число не число. Записать его как достоверное нельзя — оно уйдёт в
      // правила §9 наравне с прочитанным, — а записать текстом значило бы
      // подменить тип реквизита молча.
      problems.push(`${value.code}: ${EXTRACT_VALUE_NOT_TYPED} (${definition.type})`);
      continue;
    }

    taken.add(value.code);
    fields.push({
      fieldCode: value.code,
      ...typed,
      confidence: value.confidence,
      extractedBy: 'llm',
      evidence,
    });
  }

  return { fields, problems };
}

/** Дословная формулировка отказа по типу: на неё опираются тест и журнал. */
export const EXTRACT_VALUE_NOT_TYPED = 'значение не разобралось в тип реквизита';

/** Разложенное по колонкам значение: ровно то, что принимает `field_values`. */
type TypedValue = Pick<ExtractedField, 'valueText' | 'valueDate' | 'valueNum' | 'valueJson'>;

/**
 * Значение модели, разложенное по типу реквизита из КАТАЛОГА.
 *
 * ## Что здесь чинится
 *
 * До S27 модуль клал `valueDate: null` безусловно, а дату записывал строкой в
 * `valueText`. Правила `DATE.*` читают `value_date` и не смотрят на текст —
 * значит НИ ОДНА дата, извлечённая моделью, до них не доезжала. Правка промта
 * этого не чинит в принципе: сколько ни требуй формат `ГГГГ-ММ-ДД`, значение
 * ложится не в ту колонку.
 *
 * ## Почему разбор ДАТЫ терпим к записи, а не требует ISO
 *
 * Модель отвечает тем, что напечатано, и «12.05.2026» — законный ответ на
 * просьбу процитировать документ дословно. Требовать ISO значило бы просить её
 * ПРЕОБРАЗОВАТЬ значение, а преобразование — это место, где ошибка становится
 * неотличимой от чтения. Поэтому разбирается любая наблюдаемая запись, тем же
 * `toIsoDate`, что и в детерминированном извлечении: одна реализация на оба
 * пути, иначе они разойдутся молча.
 *
 * `null` означает «в свой тип не разобралось» — вызывающий обязан отбросить
 * значение с названной причиной, а не записать его текстом.
 */
function typedValue(
  definition: FieldDefinition,
  raw: string | null,
  items: readonly string[],
): TypedValue | null {
  if (definition.type === 'list') {
    const list = items.map((item) => item.trim()).filter((item) => item.length > 0);
    // Модель вправе ответить на список одной строкой: бланк печатает перечень
    // в одну графу, и дробить его — работа читателя, а не отвечающего.
    const fromValue = raw === null || raw.trim() === '' ? [] : [raw.trim()];
    const merged = list.length > 0 ? list : fromValue;
    return merged.length === 0
      ? null
      : { valueText: null, valueDate: null, valueNum: null, valueJson: merged };
  }

  const text = raw === null ? null : raw.trim();
  if (text === null || text === '') return null;

  if (definition.type === 'date') {
    const iso = toIsoDate(text);
    return iso === null
      ? null
      : { valueText: null, valueDate: iso, valueNum: null, valueJson: null };
  }

  if (definition.type === 'number') {
    // Запятая как десятичный разделитель: в документах она чаще точки.
    const normalized = text.replace(/\s+/gu, '').replace(',', '.');
    if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) return null;
    return { valueText: null, valueDate: null, valueNum: normalized, valueJson: null };
  }

  return { valueText: text, valueDate: null, valueNum: null, valueJson: null };
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
