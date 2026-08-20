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
 * ## Дискриминант — `enum` с одним значением, а не `const`
 *
 * Обе формы эквивалентны по JSON Schema, но одноэлементный `enum` понимает и
 * старый парк грамматических движков; `const` появился в поддержке structured
 * outputs позже и до сих пор реализован не везде. Цена — ноль, совместимость — шире.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { VlmJsonSchemaFormat } from '../../llm/vlm-port.js';

// ---------------------------------------------------------------------------
// zod: text
// ---------------------------------------------------------------------------

/**
 * Все объекты — `strictObject`: лишний ключ в ответе означает, что провайдер
 * схему не исполнял, и такой ответ обязан падать в разбор, а не молча
 * очищаться (`z.object` по умолчанию срезает неизвестные ключи — это как раз
 * тихая маскировка нарушения контракта).
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

export const vlmTextResponseSchema = z.strictObject({
  /** Пустой массив — законный ответ на кроп без читаемого текста. */
  fragments: z.array(vlmTextFragmentSchema),
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

/** Дискриминант варианта юниона — одноэлементный enum (см. шапку файла). */
function kindSchema(kind: string): JsonSchema {
  return { type: 'string', enum: [kind] };
}

export const TEXT_BLOCK_RESULT_SCHEMA: JsonSchema = strictObjectSchema({
  fragments: {
    type: 'array',
    items: {
      anyOf: [
        strictObjectSchema({
          kind: kindSchema('paragraph'),
          text: stringSchema,
          emphasis: { type: 'string', enum: ['none', 'strong'] },
        }),
        strictObjectSchema({
          kind: kindSchema('heading'),
          // Диапазон 1..6 выражен enum'ом, а не minimum/maximum: числовые
          // границы входят в тот же список keywords, который часть strict-
          // бекендов отвергает; enum поддержан везде и точнее.
          level: { type: ['integer', 'null'], enum: [1, 2, 3, 4, 5, 6, null] },
          text: stringSchema,
        }),
        strictObjectSchema({
          kind: kindSchema('table'),
          title: nullableStringSchema,
          header: { type: ['array', 'null'], items: stringSchema },
          rows: { type: 'array', items: { type: 'array', items: stringSchema } },
        }),
      ],
    },
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
