/**
 * Схемы ответов VLM-модели для трёх типов блоков (ADR-0007, план v3).
 *
 * ## Двойное представление и почему их именно два
 *
 * Каждая схема существует в двух формах, и обе — контракт:
 *
 * 1. **zod** — то, чем разбирается ФАКТИЧЕСКИЙ ответ модели. Провайдеру нельзя
 *    верить на слово, что `strict: true` сработал: OpenRouter маршрутизирует на
 *    разные бекенды, и часть из них schema-constrained decoding не поддерживает
 *    (гвард `require_parameters` стоит на шлюзе, но проверяет параметры, а не
 *    качество их исполнения). Ответ, не прошедший zod, — не результат.
 * 2. **JSON Schema** — то, что уезжает провайдеру в `response_format`
 *    (`json_schema`, `strict: true`). Составлена вручную под ограничения
 *    OpenRouter Structured Outputs: без `$ref` (инлайн), на каждом объекте
 *    `additionalProperties: false` и ВСЕ свойства в `required`, отсутствие
 *    значения — только через nullable-тип `{"type": ["string", "null"]}`, без
 *    `minLength`/`maxLength` (ограничения длины строк ломают grammar-компиляцию
 *    у части бекендов — боевой опыт RD WEB, `parser_json._strip_string_length_bounds`).
 *
 * Согласие двух форм держит тест `schemas.test.ts`: он сверяет множества
 * свойств, required и additionalProperties узел в узел. Расхождение означало бы,
 * что модель ограничена одной схемой, а проверяется другой, — класс дефекта,
 * который не виден ни на одном отдельном прогоне.
 *
 * ## Одна асимметрия двух форм — и она намеренная
 *
 * В JSON Schema **все** свойства попадают в `required`: этого требует strict-
 * режим, и модель со schema-constrained decoding обязана выписать каждый ключ.
 * В zod необязательные значения фрагмента объявлены `.nullish()`, то есть
 * отсутствие ключа приравнено к `null`. Причина в маршрутизации OpenRouter: часть
 * бекендов грамматику по схеме не исполняет (гвард `require_parameters` проверяет
 * параметры запроса, а не качество их исполнения), и там модель следует ТЕКСТУ
 * промпта, выписывая только значимые ключи. Требовать от такого ответа полный
 * набор значило бы браковать содержательно верную транскрипцию из-за
 * особенностей бекенда, о которых она не знает.
 *
 * ## Отличие от канонических схем `@id/recognition`
 *
 * Формы зеркалят канонический `ContentFragment`, но БЕЗ default'ов канона: в
 * ответе модели ВСЕ поля обязательны, «нет значения» выражается явным `null`.
 * Default в схеме ответа маскировал бы неполный ответ под полный — и strict-режим
 * провайдера, который обязан выписывать все ключи, перестал бы проверяться.
 * Табличный фрагмент в ответе ПЛОСКИЙ (`{kind:'table', header, rows, title}`,
 * без вложенного объекта `table`) — так зафиксировано контрактом плана v3;
 * вложение в канонический вид (`{kind:'table', table:{…}}`) делает `map.ts`.
 *
 * ## Почему у text-фрагмента нет `anyOf`
 *
 * Была: три варианта объекта под `anyOf`, по одному на вид фрагмента. Google AI
 * Studio такую схему не компилирует и отвечает `400 INVALID_ARGUMENT`
 * («schema at properties.fragments.items.anyOf.1 requires unspecified property
 * "kind"»): он требует согласованного набора свойств у вариантов, а весь смысл
 * union'а — в том, что наборы разные. Отказ приходит ДО генерации, то есть
 * промптом не лечится и ретраями не обходится: в проде это было 16 отказов из 20
 * на text-блоках при исправно работающих `image` и `stamp` (у них union'а нет).
 *
 * Поэтому wire-форма фрагмента ПЛОСКАЯ: один объект, обязательный дискриминант
 * `kind` и шесть nullable-полей, из которых значимы те, что относятся к его виду.
 * Дискриминированный союз никуда не делся — он остался доменной формой (`map.ts`
 * и валидаторы работают с ней), а плоский ответ приводится к нему нормализатором
 * `vlmTextFragmentFromWire`.
 *
 * Профиля «схема под Gemini» рядом с прежним `anyOf` заводить не стали: две
 * wire-формы одного контракта разошлись бы при первой же правке, и разошлись бы
 * молча — проверялась бы одна, а модель ограничивалась бы другой.
 *
 * ## Числовые и строковые `enum` в wire-форме
 *
 * `level` и `emphasis` в wire-схеме ограничены только типом. Google принимает
 * `enum` исключительно для строк, поэтому `[1,…,6,null]` и `['none','strong',null]`
 * — ровно те конструкции, которые ломают конвертацию схемы на его стороне.
 * Диапазон заголовка и перечень выделений проверяет zod: место ограничения там,
 * где его исполнение можно гарантировать.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { VlmJsonSchemaFormat } from '../../llm/vlm-port.js';

// ---------------------------------------------------------------------------
// zod: text
// ---------------------------------------------------------------------------

/**
 * ДОМЕННАЯ форма фрагмента: с ней работают `map.ts` и валидаторы `postprocess.ts`.
 *
 * Все объекты — `strictObject`: лишний ключ означает, что нормализатор собрал
 * не то, и такой объект обязан падать в разбор, а не молча очищаться
 * (`z.object` по умолчанию срезает неизвестные ключи — это как раз тихая
 * маскировка нарушения контракта).
 */
export const vlmTextFragmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('paragraph'),
    text: z.string(),
    emphasis: z.enum(['none', 'strong']),
  }),
  z.strictObject({
    kind: z.literal('heading'),
    /** `null` — модель видит заголовок, но не его иерархию (как в каноне). */
    level: z.number().int().min(1).max(6).nullable(),
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal('table'),
    /** `null` — у таблицы нет видимой подписи. */
    title: z.string().nullable(),
    /** `null` — шапки нет; повышать первую строку данных запрещено промптом. */
    header: z.array(z.string()).nullable(),
    rows: z.array(z.array(z.string())),
  }),
]);
export type VlmTextFragment = z.infer<typeof vlmTextFragmentSchema>;

/**
 * WIRE-форма фрагмента: то, что реально приходит от провайдера (см. «Почему у
 * text-фрагмента нет `anyOf`» в шапке файла).
 *
 * Обязателен только `kind` — без него фрагмент неинтерпретируем, и никакая
 * нормализация его не восстановит. Остальные шесть полей `.nullish()`: `null`
 * пишет модель со schema-constrained decoding, отсутствие ключа — бекенд без
 * него. Эти два состояния означают одно и то же и различаться не должны.
 */
export const vlmTextFragmentWireSchema = z.strictObject({
  kind: z.enum(['paragraph', 'heading', 'table']),
  text: z.string().nullish(),
  emphasis: z.string().nullish(),
  level: z.number().int().nullish(),
  title: z.string().nullish(),
  header: z.array(z.string()).nullish(),
  rows: z.array(z.array(z.string())).nullish(),
});

const HEADING_LEVELS: readonly number[] = [1, 2, 3, 4, 5, 6];

/**
 * Плоский фрагмент → доменный.
 *
 * Правила приведения выбраны по цене ошибки, а не по строгости ради строгости:
 *
 * - **текст обязателен** у `paragraph` и `heading`: фрагмент без текста — не
 *   транскрипция, а пустое место, и принять его значило бы записать в результат
 *   абзац, которого на кропе нет;
 * - **`emphasis` вне перечня — это `none`**: выделение косметическое, и терять
 *   из-за него весь блок несоразмерно;
 * - **`level` вне 1..6 — это `null`**: ровно то же значение модель ставит, когда
 *   не видит иерархии, то есть «уровень неизвестен» уже есть в контракте;
 * - **`rows: null` — это `[]`**: таблица без строк законна, а `null` в каноне
 *   для `rows` не предусмотрен.
 *
 * `.pipe(vlmTextFragmentSchema)` в конце — не формальность: он делает
 * утверждение «нормализатор не может выпустить объект, который доменная схема не
 * примет» проверяемым во время выполнения, а не обещанием типов.
 */
export const vlmTextFragmentFromWire = vlmTextFragmentWireSchema
  .transform((fragment, ctx): VlmTextFragment => {
    if (fragment.kind === 'table') {
      return {
        kind: 'table',
        title: fragment.title ?? null,
        header: fragment.header ?? null,
        rows: fragment.rows ?? [],
      };
    }

    const text = fragment.text ?? null;
    if (text === null) {
      ctx.addIssue({
        code: 'custom',
        message: `фрагмент «${fragment.kind}» без текста`,
        path: ['text'],
      });
      return z.NEVER;
    }

    if (fragment.kind === 'paragraph') {
      return {
        kind: 'paragraph',
        text,
        emphasis: fragment.emphasis === 'strong' ? 'strong' : 'none',
      };
    }

    const level = fragment.level ?? null;
    return {
      kind: 'heading',
      text,
      level: level !== null && HEADING_LEVELS.includes(level) ? level : null,
    };
  })
  .pipe(vlmTextFragmentSchema);

export const vlmTextResponseSchema = z.strictObject({
  /** Пустой массив — законный ответ на кроп без читаемого текста. */
  fragments: z.array(vlmTextFragmentFromWire),
});
export type VlmTextResponse = z.infer<typeof vlmTextResponseSchema>;

// ---------------------------------------------------------------------------
// zod: image
// ---------------------------------------------------------------------------

/**
 * 21 значение `fragment_type` — дословно из RD WEB (`domain/results.ImageFragmentType`,
 * §12.2). Список закрыт: промпт BASE_RD_SYSTEM перечисляет ровно его, и новый
 * тип фрагмента — это правка промпта, схемы и значений одновременно.
 */
export const IMAGE_FRAGMENT_TYPES = [
  'План',
  'Схема',
  'Схема автоматизации',
  'Схема стояков',
  'Разрез',
  'Фасад',
  'Узел',
  'Деталь',
  'Таблица',
  'Спецификация',
  'Экспликация',
  'Легенда',
  'Примечания',
  'Ведомость',
  'Лист общих данных',
  'Формула',
  'Расчет',
  'График',
  'Штамп',
  'Смешанный фрагмент',
  'Не определено',
] as const;

export const vlmImageResponseSchema = z.strictObject({
  fragment_type: z.enum(IMAGE_FRAGMENT_TYPES),
  location: z.strictObject({
    grid_lines: z.string().nullable(),
    zone_name: z.string().nullable(),
    level_or_elevation: z.string().nullable(),
  }),
  content_summary: z.string(),
  detailed_description: z.string(),
  /** Пустая строка — «причины проверять нет» (семантика RD WEB), не null. */
  verification_recommendations: z.string(),
  /** Потолок 50 — из промпта RD WEB (KEY_ENTITIES_SOFT_LIMIT); здесь он жёсткий. */
  key_entities: z.array(z.string()).max(50),
});
export type VlmImageResponse = z.infer<typeof vlmImageResponseSchema>;

// ---------------------------------------------------------------------------
// zod: stamp
// ---------------------------------------------------------------------------

export const vlmStampSignatureSchema = z.strictObject({
  role: z.string().nullable(),
  surname: z.string().nullable(),
  date: z.string().nullable(),
});
export type VlmStampSignature = z.infer<typeof vlmStampSignatureSchema>;

export const vlmStampRevisionSchema = z.strictObject({
  change_num: z.string().nullable(),
  doc_num: z.string().nullable(),
  date: z.string().nullable(),
});
export type VlmStampRevision = z.infer<typeof vlmStampRevisionSchema>;

/**
 * В отличие от RD WEB (D13: «omit a key instead of null») здесь ВСЕ поля
 * обязательны: strict-режим OpenRouter требует required на каждое свойство,
 * поэтому «не прочитал» выражается `null`, а пустые списки — `[]`. Симметричная
 * замена сделана и в тексте stamp-промпта (см. prompts.ts).
 */
export const vlmStampResponseSchema = z.strictObject({
  document_code: z.string().nullable(),
  /**
   * Собственный номер листа из отдельной ячейки рядом со штампом.
   *
   * Отдельное поле, а не «ещё один вид `document_code`»: на исполнительных
   * схемах в штампе стоит «Обозначение» проекта (общее у всех листов раздела),
   * а номер, которым лист назван в реестре приложений, напечатан выше штампа
   * своей ячейкой. Пока их не различали, у схемы не было номера вовсе.
   */
  sheet_code: z.string().nullable(),
  project_name: z.string().nullable(),
  sheet_name: z.string().nullable(),
  stage: z.string().nullable(),
  sheet_number: z.string().nullable(),
  total_sheets: z.string().nullable(),
  organization: z.string().nullable(),
  signatures: z.array(vlmStampSignatureSchema),
  revisions: z.array(vlmStampRevisionSchema),
});
export type VlmStampResponse = z.infer<typeof vlmStampResponseSchema>;

// ---------------------------------------------------------------------------
// Ориентация страницы (ADR-0020)
// ---------------------------------------------------------------------------

/**
 * Ответ зонда ориентации в ДОМЕННОЙ форме.
 *
 * Набор из четырёх значений держит zod, а не JSON Schema: числового `enum`
 * Google не принимает, и попытка ограничить грамматику им кончилась бы 400 до
 * генерации — тем же способом, каким кончился `anyOf` у text-фрагмента.
 *
 * `.nullish()`, а не `.nullable()`, у необязательных: часть бекендов
 * OpenRouter грамматику по схеме не исполняет и выписывает только значимые
 * ключи. Требовать от такого ответа полный набор значило бы браковать верный
 * ответ из-за особенностей бекенда, о которых он не знает.
 */
export const vlmOrientationResponseSchema = z.strictObject({
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  /**
   * Уверенность 0..1. Отсутствие — не ноль: «модель не сказала» и «модель
   * сказала, что не уверена» ведут к разному, и второе обязано быть видно.
   */
  confidence: z.number().min(0).max(1).nullish(),
  /** Короткая фраза «шапка идёт снизу вверх» — для человека, читающего журнал. */
  evidence: z.string().nullish(),
});
export type VlmOrientationResponse = z.infer<typeof vlmOrientationResponseSchema>;

// ---------------------------------------------------------------------------
// JSON Schema для response_format
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/**
 * Единственная точка, где собирается объект wire-схемы: `required` всегда
 * равен полному списку свойств, `additionalProperties` всегда false — strict-
 * инварианты OpenRouter выполняются ПО ПОСТРОЕНИЮ, а не дисциплиной автора
 * каждого литерала.
 */
function strictObjectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const stringSchema: JsonSchema = { type: 'string' };
const nullableStringSchema: JsonSchema = { type: ['string', 'null'] };

export const TEXT_BLOCK_RESULT_SCHEMA: JsonSchema = strictObjectSchema({
  fragments: {
    type: 'array',
    // Один плоский объект вместо `anyOf` из трёх вариантов — см. «Почему у
    // text-фрагмента нет `anyOf`» в шапке файла. Дискриминант — строковый enum
    // из трёх значений: он ограничивает грамматику там, где это безопасно, и
    // именно по нему нормализатор выбирает доменную форму.
    items: strictObjectSchema({
      kind: { type: 'string', enum: ['paragraph', 'heading', 'table'] },
      text: nullableStringSchema,
      // Ни `enum`, ни minimum/maximum: числовые границы входят в тот же список
      // keywords, который отвергает часть strict-бекендов, а числовой `enum`
      // не принимает Google. Перечень значений держит zod.
      emphasis: nullableStringSchema,
      level: { type: ['integer', 'null'] },
      title: nullableStringSchema,
      header: { type: ['array', 'null'], items: stringSchema },
      rows: { type: ['array', 'null'], items: { type: 'array', items: stringSchema } },
    }),
  },
});

export const IMAGE_BLOCK_RESULT_SCHEMA: JsonSchema = strictObjectSchema({
  fragment_type: { type: 'string', enum: [...IMAGE_FRAGMENT_TYPES] },
  location: strictObjectSchema({
    grid_lines: nullableStringSchema,
    zone_name: nullableStringSchema,
    level_or_elevation: nullableStringSchema,
  }),
  content_summary: stringSchema,
  detailed_description: stringSchema,
  verification_recommendations: stringSchema,
  key_entities: { type: 'array', items: stringSchema, maxItems: 50 },
});

export const STAMP_BLOCK_RESULT_SCHEMA: JsonSchema = strictObjectSchema({
  document_code: nullableStringSchema,
  sheet_code: nullableStringSchema,
  project_name: nullableStringSchema,
  sheet_name: nullableStringSchema,
  stage: nullableStringSchema,
  sheet_number: nullableStringSchema,
  total_sheets: nullableStringSchema,
  organization: nullableStringSchema,
  signatures: {
    type: 'array',
    items: strictObjectSchema({
      role: nullableStringSchema,
      surname: nullableStringSchema,
      date: nullableStringSchema,
    }),
  },
  revisions: {
    type: 'array',
    items: strictObjectSchema({
      change_num: nullableStringSchema,
      doc_num: nullableStringSchema,
      date: nullableStringSchema,
    }),
  },
});

/**
 * Ответ зонда ориентации страницы (ADR-0020).
 *
 * Три поля и ни одного лишнего: зонд отвечает на один вопрос, и всё, что он мог
 * бы сказать сверх этого, было бы транскрипцией — то есть работой, за которую
 * платят потом и другой моделью.
 *
 * `rotation` — ЧИСЛО, а не строка, потому что величина арифметическая: её
 * обращают, складывают и передают в `sharp.rotate`. Числового `enum` в схеме
 * нет намеренно: Google его для не-строк не принимает (см. шапку файла), и
 * закрытый набор из четырёх значений держит zod ниже.
 */
export const ORIENTATION_RESULT_SCHEMA: JsonSchema = strictObjectSchema({
  rotation: { type: 'integer' },
  confidence: { type: ['number', 'null'] },
  evidence: nullableStringSchema,
});

/** Имена схем — стабильные идентификаторы `json_schema.name` (паритет RD WEB). */
export const VLM_TEXT_RESPONSE_FORMAT: VlmJsonSchemaFormat = {
  name: 'text_block_result',
  schema: TEXT_BLOCK_RESULT_SCHEMA,
  strict: true,
};

export const VLM_IMAGE_RESPONSE_FORMAT: VlmJsonSchemaFormat = {
  name: 'image_block_result',
  schema: IMAGE_BLOCK_RESULT_SCHEMA,
  strict: true,
};

export const VLM_STAMP_RESPONSE_FORMAT: VlmJsonSchemaFormat = {
  name: 'stamp_block_result',
  schema: STAMP_BLOCK_RESULT_SCHEMA,
  strict: true,
};

export const VLM_ORIENTATION_RESPONSE_FORMAT: VlmJsonSchemaFormat = {
  name: 'page_orientation_result',
  schema: ORIENTATION_RESULT_SCHEMA,
  strict: true,
};

// ---------------------------------------------------------------------------
// Хэш схемы
// ---------------------------------------------------------------------------

/**
 * Каноническая сериализация: ключи объектов сортируются рекурсивно (по кодовым
 * единицам, НЕ localeCompare — тот зависит от локали процесса и дал бы разные
 * хэши на разных машинах), порядок массивов значим и сохраняется, `undefined`-
 * значения отбрасываются как несуществующие (JSON их не выражает).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 канонизированной схемы, hex.
 *
 * Это «один источник истины» контракта v3: хэш связывает JSON Schema, zod и
 * текст промпта — он входит в `schemaVersion` вызова (ключ кэша и идемпотентный
 * ключ шлюза), и любое изменение схемы меняет его, инвалидируя записанные
 * ответы двойника вместо тихой подмены контракта.
 */
export function schemaHash(schema: unknown): string {
  return createHash('sha256').update(canonicalJson(schema), 'utf8').digest('hex');
}
