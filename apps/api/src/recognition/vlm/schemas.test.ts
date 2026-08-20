/**
 * Согласие двух форм схемы ответа: zod (разбор факта) ↔ JSON Schema (wire,
 * response_format).
 *
 * Сверка структурная и двусторонняя: обход идёт ПАРАЛЛЕЛЬНО по обоим деревьям,
 * поэтому свойство, известное только одной стороне, падает в любом направлении.
 * Дополнительно закреплены strict-инварианты OpenRouter на каждом объекте wire-
 * схемы: `additionalProperties: false`, `required` = все свойства, nullable —
 * только через `{"type": [X, "null"]}`, отсутствие `minLength`/`maxLength`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  IMAGE_BLOCK_RESULT_SCHEMA,
  IMAGE_FRAGMENT_TYPES,
  STAMP_BLOCK_RESULT_SCHEMA,
  TEXT_BLOCK_RESULT_SCHEMA,
  VLM_IMAGE_RESPONSE_FORMAT,
  VLM_STAMP_RESPONSE_FORMAT,
  VLM_TEXT_RESPONSE_FORMAT,
  schemaHash,
  vlmImageResponseSchema,
  vlmStampResponseSchema,
  vlmTextResponseSchema,
} from './schemas.js';

type Wire = Record<string, unknown>;

function wireOf(value: unknown, path: string): Wire {
  expect(value, `${path}: узел wire-схемы должен быть объектом`).toBeTypeOf('object');
  return value as Wire;
}

/** Значение дискриминанта `kind` варианта wire-юниона (одноэлементный enum). */
function wireKind(variant: Wire, path: string): string {
  const kind = wireOf((variant['properties'] as Wire)['kind'], `${path}.kind`);
  const values = kind['enum'];
  expect(Array.isArray(values) && values.length === 1, `${path}: kind — одноэлементный enum`).toBe(
    true,
  );
  return (values as string[])[0] as string;
}

/** Параллельный обход: каждый узел wire-схемы сверяется с узлом zod-схемы. */
function assertAgreement(wire: Wire, zodNode: z.ZodType, path: string): void {
  if (zodNode instanceof z.ZodNullable) {
    const type = wire['type'];
    expect(Array.isArray(type) && type.includes('null'), `${path}: nullable через type-массив`).toBe(
      true,
    );
    const rest = (type as string[]).filter((item) => item !== 'null');
    expect(rest.length, `${path}: nullable-юнион ровно из одного типа и null`).toBe(1);
    assertAgreement({ ...wire, type: rest[0] }, zodNode.unwrap() as z.ZodType, path);
    return;
  }
  if (zodNode instanceof z.ZodObject) {
    expect(wire['type'], `${path}: тип object`).toBe('object');
    expect(wire['additionalProperties'], `${path}: additionalProperties`).toBe(false);
    const properties = wireOf(wire['properties'], `${path}.properties`);
    const wireKeys = Object.keys(properties).sort();
    const zodKeys = Object.keys(zodNode.shape).sort();
    expect(wireKeys, `${path}: множества свойств совпадают`).toEqual(zodKeys);
    expect([...(wire['required'] as string[])].sort(), `${path}: required = все свойства`).toEqual(
      wireKeys,
    );
    for (const key of wireKeys) {
      assertAgreement(
        wireOf(properties[key], `${path}.${key}`),
        zodNode.shape[key] as z.ZodType,
        `${path}.${key}`,
      );
    }
    return;
  }
  if (zodNode instanceof z.ZodArray) {
    expect(wire['type'], `${path}: тип array`).toBe('array');
    assertAgreement(wireOf(wire['items'], `${path}[]`), zodNode.element as z.ZodType, `${path}[]`);
    return;
  }
  if (zodNode instanceof z.ZodDiscriminatedUnion) {
    const variants = wire['anyOf'];
    expect(Array.isArray(variants), `${path}: юнион — anyOf (без $ref)`).toBe(true);
    const options = zodNode.options as readonly z.ZodObject[];
    expect((variants as unknown[]).length, `${path}: число вариантов юниона`).toBe(options.length);
    for (const rawVariant of variants as unknown[]) {
      const variant = wireOf(rawVariant, path);
      const kind = wireKind(variant, path);
      const option = options.find((candidate) => {
        const discriminator = candidate.shape['kind'];
        return discriminator instanceof z.ZodLiteral && discriminator.value === kind;
      });
      expect(option, `${path}: вариант "${kind}" известен zod-схеме`).toBeDefined();
      assertAgreement(variant, option as z.ZodType, `${path}<${kind}>`);
    }
    return;
  }
  if (zodNode instanceof z.ZodLiteral) {
    expect(wire['enum'], `${path}: литерал — одноэлементный enum`).toEqual([zodNode.value]);
    return;
  }
  if (zodNode instanceof z.ZodEnum) {
    expect(wire['type'], `${path}: тип enum-строки`).toBe('string');
    expect(wire['enum'], `${path}: значения enum совпадают`).toEqual(zodNode.options);
    return;
  }
  if (zodNode instanceof z.ZodString) {
    expect(wire['type'], `${path}: тип string`).toBe('string');
    expect(wire['minLength'], `${path}: без minLength (strict-совместимость)`).toBeUndefined();
    expect(wire['maxLength'], `${path}: без maxLength (strict-совместимость)`).toBeUndefined();
    return;
  }
  if (zodNode instanceof z.ZodNumber) {
    expect(wire['type'] === 'integer' || wire['type'] === 'number', `${path}: числовой тип`).toBe(
      true,
    );
    return;
  }
  throw new Error(`${path}: непокрытый вид zod-узла ${zodNode.constructor.name}`);
}

/** Ни одного `$ref`/`$defs` нигде в wire-схеме (требование инлайна). */
function assertNoRefs(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoRefs(item, `${path}[${index}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Wire)) {
      expect(key === '$ref' || key === '$defs', `${path}: запрещённый ключ ${key}`).toBe(false);
      assertNoRefs(value, `${path}.${key}`);
    }
  }
}

const validText = {
  fragments: [
    { kind: 'paragraph', text: '1. Общие указания', emphasis: 'none' },
    { kind: 'paragraph', text: 'ВНИМАНИЕ', emphasis: 'strong' },
    { kind: 'heading', level: null, text: 'Примечания' },
    { kind: 'heading', level: 2, text: 'Ведомость' },
    { kind: 'table', title: null, header: ['Поз.', 'Кол.'], rows: [['1', '2']] },
    { kind: 'table', title: 'Спецификация', header: null, rows: [] },
  ],
};

const validImage = {
  fragment_type: 'План',
  location: { grid_lines: '5.А-5.К', zone_name: null, level_or_elevation: '+3,300' },
  content_summary: 'План этажа с осями.',
  detailed_description: 'Видны оси 5.А–5.К и помещения.',
  verification_recommendations: '',
  key_entities: ['5.А', 'DN50'],
};

const validStamp = {
  document_code: 'СТ26/01-14-АР5-3-РД',
  project_name: null,
  sheet_name: 'План на отм. 0,000',
  stage: 'РД',
  sheet_number: '3',
  total_sheets: '12',
  organization: null,
  signatures: [{ role: 'Разраб.', surname: 'Иванов', date: '05.2026' }],
  revisions: [],
};

describe('схемы ответов VLM', () => {
  it('валидные примеры проходят zod (включая пустые/null-ветки)', () => {
    expect(vlmTextResponseSchema.parse(validText)).toEqual(validText);
    expect(vlmImageResponseSchema.parse(validImage)).toEqual(validImage);
    expect(vlmStampResponseSchema.parse(validStamp)).toEqual(validStamp);
    expect(vlmTextResponseSchema.parse({ fragments: [] })).toEqual({ fragments: [] });
  });

  it('неизвестный ключ отвергается zod — паритет с additionalProperties:false', () => {
    expect(vlmTextResponseSchema.safeParse({ ...validText, extra: 1 }).success).toBe(false);
    expect(vlmImageResponseSchema.safeParse({ ...validImage, extra: 1 }).success).toBe(false);
    expect(vlmStampResponseSchema.safeParse({ ...validStamp, extra: 1 }).success).toBe(false);
  });

  it('отсутствующий ключ отвергается zod — паритет с required = все свойства', () => {
    const { emphasis: _dropped, ...paragraphWithout } = {
      kind: 'paragraph',
      text: 'т',
      emphasis: 'none',
    };
    expect(vlmTextResponseSchema.safeParse({ fragments: [paragraphWithout] }).success).toBe(false);
    const { organization: _org, ...stampWithout } = validStamp;
    expect(vlmStampResponseSchema.safeParse(stampWithout).success).toBe(false);
  });

  it('text: wire-схема и zod согласованы узел в узел', () => {
    assertAgreement(TEXT_BLOCK_RESULT_SCHEMA as Wire, vlmTextResponseSchema, 'text');
    assertNoRefs(TEXT_BLOCK_RESULT_SCHEMA, 'text');
  });

  it('image: wire-схема и zod согласованы узел в узел', () => {
    assertAgreement(IMAGE_BLOCK_RESULT_SCHEMA as Wire, vlmImageResponseSchema, 'image');
    assertNoRefs(IMAGE_BLOCK_RESULT_SCHEMA, 'image');
  });

  it('stamp: wire-схема и zod согласованы узел в узел', () => {
    assertAgreement(STAMP_BLOCK_RESULT_SCHEMA as Wire, vlmStampResponseSchema, 'stamp');
    assertNoRefs(STAMP_BLOCK_RESULT_SCHEMA, 'stamp');
  });

  it('fragment_type — ровно 21 значение RD WEB', () => {
    expect(IMAGE_FRAGMENT_TYPES).toHaveLength(21);
    expect(new Set(IMAGE_FRAGMENT_TYPES).size).toBe(21);
  });

  it('уровень заголовка nullable выражен enum-ом 1..6 + null', () => {
    const validated = vlmTextResponseSchema.safeParse({
      fragments: [{ kind: 'heading', level: 7, text: 'x' }],
    });
    expect(validated.success).toBe(false);
  });

  it('key_entities длиннее 50 отвергается', () => {
    const overflow = { ...validImage, key_entities: Array.from({ length: 51 }, (_, i) => `${i}`) };
    expect(vlmImageResponseSchema.safeParse(overflow).success).toBe(false);
  });

  it('имена response_format стабильны, strict — литеральный true', () => {
    expect(VLM_TEXT_RESPONSE_FORMAT).toMatchObject({ name: 'text_block_result', strict: true });
    expect(VLM_IMAGE_RESPONSE_FORMAT).toMatchObject({ name: 'image_block_result', strict: true });
    expect(VLM_STAMP_RESPONSE_FORMAT).toMatchObject({ name: 'stamp_block_result', strict: true });
    expect(VLM_TEXT_RESPONSE_FORMAT.schema).toBe(TEXT_BLOCK_RESULT_SCHEMA);
    expect(VLM_IMAGE_RESPONSE_FORMAT.schema).toBe(IMAGE_BLOCK_RESULT_SCHEMA);
    expect(VLM_STAMP_RESPONSE_FORMAT.schema).toBe(STAMP_BLOCK_RESULT_SCHEMA);
  });

  it('schemaHash детерминирован и не зависит от порядка ключей', () => {
    expect(schemaHash({ a: 1, b: [1, 2, null] })).toBe(schemaHash({ b: [1, 2, null], a: 1 }));
    expect(schemaHash({ a: 1 })).not.toBe(schemaHash({ a: 2 }));
    // Порядок МАССИВОВ значим: enum из других по порядку значений — другая схема.
    expect(schemaHash({ enum: ['a', 'b'] })).not.toBe(schemaHash({ enum: ['b', 'a'] }));
    expect(schemaHash(TEXT_BLOCK_RESULT_SCHEMA)).toMatch(/^[0-9a-f]{64}$/);
    expect(schemaHash(TEXT_BLOCK_RESULT_SCHEMA)).toBe(schemaHash(TEXT_BLOCK_RESULT_SCHEMA));
  });

  it('хэши трёх схем попарно различны (схемы не совпадают случайно)', () => {
    const hashes = [
      schemaHash(TEXT_BLOCK_RESULT_SCHEMA),
      schemaHash(IMAGE_BLOCK_RESULT_SCHEMA),
      schemaHash(STAMP_BLOCK_RESULT_SCHEMA),
    ];
    expect(new Set(hashes).size).toBe(3);
  });
});
