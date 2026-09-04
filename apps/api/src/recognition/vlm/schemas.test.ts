/**
 * Согласие двух форм схемы ответа: zod (разбор факта) ↔ JSON Schema (wire,
 * response_format).
 *
 * Сверка структурная и двусторонняя: обход идёт ПАРАЛЛЕЛЬНО по обоим деревьям,
 * поэтому свойство, известное только одной стороне, падает в любом направлении.
 * Дополнительно закреплены strict-инварианты OpenRouter на каждом объекте wire-
 * схемы: `additionalProperties: false`, `required` = все свойства, nullable —
 * только через `{"type": [X, "null"]}`, отсутствие `minLength`/`maxLength`.
 *
 * Со стороны zod сверяется WIRE-форма (у text она разворачивается из `ZodPipe`
 * нормализатора): предмет сверки — то, чем ограничена модель, а не то, во что мы
 * её ответ приводим. Необязательность полей в zod при `required` в JSON Schema —
 * намеренная асимметрия, см. шапку `schemas.ts`; здесь она закреплена отдельным
 * тестом, чтобы не выглядела недосмотром.
 *
 * Отдельно запрещён `anyOf`: именно на нём Google AI Studio отвечал
 * `400 INVALID_ARGUMENT` и не распознавал ни одного text-блока.
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

/** Параллельный обход: каждый узел wire-схемы сверяется с узлом zod-схемы. */
function assertAgreement(wire: Wire, zodNode: z.ZodType, path: string): void {
  if (zodNode instanceof z.ZodPipe) {
    // Нормализатор `wire → домен`: сверять надо ВХОД, то есть форму, которой
    // ограничена модель. Выход — наше внутреннее представление, провайдер о нём
    // ничего не знает.
    assertAgreement(wire, zodNode.in as z.ZodType, path);
    return;
  }
  if (zodNode instanceof z.ZodOptional) {
    // Асимметрия по замыслу: wire требует ключ (обязательство strict-режима),
    // zod допускает его отсутствие — бекенды без constrained decoding пишут
    // только значимые ключи. Проверка `required` = все свойства ниже остаётся в
    // силе, здесь снимается только обёртка.
    assertAgreement(wire, zodNode.unwrap() as z.ZodType, path);
    return;
  }
  if (zodNode instanceof z.ZodNullable) {
    const type = wire['type'];
    expect(
      Array.isArray(type) && type.includes('null'),
      `${path}: nullable через type-массив`,
    ).toBe(true);
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

/**
 * Ни одного `$ref`/`$defs` (требование инлайна) и ни одного `anyOf`.
 *
 * `anyOf` запрещён не из вкуса: Google AI Studio отказывается компилировать
 * схему с вариантами разного набора свойств и отвечает `400 INVALID_ARGUMENT`
 * ещё до генерации. Так весь text-путь распознавания в проде стоял мёртвым при
 * исправных `image` и `stamp`.
 */
function assertInlineOnly(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertInlineOnly(item, `${path}[${index}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Wire)) {
      expect(
        key === '$ref' || key === '$defs' || key === 'anyOf' || key === 'oneOf',
        `${path}: запрещённый ключ ${key}`,
      ).toBe(false);
      assertInlineOnly(value, `${path}.${key}`);
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
  sheet_code: 'К14/ДК2-СЦ4',
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

  it('отсутствующий ключ отвергается zod там, где значения не подразумевается', () => {
    // У штампа необязательных полей нет: «не прочитал» выражается явным null,
    // и пропуск ключа означает ответ не по контракту.
    const { organization: _org, ...stampWithout } = validStamp;
    expect(vlmStampResponseSchema.safeParse(stampWithout).success).toBe(false);
    // У фрагмента текста дискриминант обязателен так же: без него фрагмент
    // неинтерпретируем, и никакая нормализация его не восстановит.
    expect(vlmTextResponseSchema.safeParse({ fragments: [{ text: 'т' }] }).success).toBe(false);
  });

  it('text: wire-схема и zod согласованы узел в узел', () => {
    assertAgreement(TEXT_BLOCK_RESULT_SCHEMA as Wire, vlmTextResponseSchema, 'text');
    assertInlineOnly(TEXT_BLOCK_RESULT_SCHEMA, 'text');
  });

  it('image: wire-схема и zod согласованы узел в узел', () => {
    assertAgreement(IMAGE_BLOCK_RESULT_SCHEMA as Wire, vlmImageResponseSchema, 'image');
    assertInlineOnly(IMAGE_BLOCK_RESULT_SCHEMA, 'image');
  });

  it('stamp: wire-схема и zod согласованы узел в узел', () => {
    assertAgreement(STAMP_BLOCK_RESULT_SCHEMA as Wire, vlmStampResponseSchema, 'stamp');
    assertInlineOnly(STAMP_BLOCK_RESULT_SCHEMA, 'stamp');
  });

  it('fragment_type — ровно 21 значение RD WEB', () => {
    expect(IMAGE_FRAGMENT_TYPES).toHaveLength(21);
    expect(new Set(IMAGE_FRAGMENT_TYPES).size).toBe(21);
  });

  // -------------------------------------------------------------------------
  // Плоский фрагмент: приведение к доменной форме
  // -------------------------------------------------------------------------

  it('плоский ответ со всеми ключами и null-ами приводится к доменной форме', () => {
    // Ровно то, что выпишет модель под schema-constrained decoding: все семь
    // ключей у каждого фрагмента, лишние — null.
    const flat = {
      fragments: [
        {
          kind: 'paragraph',
          text: 'ВНИМАНИЕ',
          emphasis: 'strong',
          level: null,
          title: null,
          header: null,
          rows: null,
        },
        {
          kind: 'heading',
          text: 'Ведомость',
          emphasis: null,
          level: 2,
          title: null,
          header: null,
          rows: null,
        },
        {
          kind: 'table',
          text: null,
          emphasis: null,
          level: null,
          title: 'Спецификация',
          header: ['Поз.', 'Кол.'],
          rows: [['1', '2']],
        },
      ],
    };

    expect(vlmTextResponseSchema.parse(flat)).toEqual({
      fragments: [
        { kind: 'paragraph', text: 'ВНИМАНИЕ', emphasis: 'strong' },
        { kind: 'heading', text: 'Ведомость', level: 2 },
        { kind: 'table', title: 'Спецификация', header: ['Поз.', 'Кол.'], rows: [['1', '2']] },
      ],
    });
  });

  it('«худой» ответ без незначимых ключей разбирается так же', () => {
    // Бекенд без constrained decoding следует тексту промпта и пишет только
    // значимые ключи. Отсутствие ключа и явный null означают одно и то же.
    expect(
      vlmTextResponseSchema.parse({
        fragments: [
          { kind: 'paragraph', text: 'т' },
          { kind: 'table', rows: [] },
        ],
      }),
    ).toEqual({
      fragments: [
        { kind: 'paragraph', text: 'т', emphasis: 'none' },
        { kind: 'table', title: null, header: null, rows: [] },
      ],
    });
  });

  it('уровень заголовка вне 1..6 — это «уровень неизвестен», а не отказ', () => {
    // Значение уже есть в контракте (null = иерархия не читается), и терять из-за
    // косметики весь распознанный блок несоразмерно.
    expect(
      vlmTextResponseSchema.parse({ fragments: [{ kind: 'heading', text: 'x', level: 7 }] }),
    ).toEqual({ fragments: [{ kind: 'heading', text: 'x', level: null }] });
  });

  it('выделение вне перечня — это «нет выделения»', () => {
    expect(
      vlmTextResponseSchema.parse({
        fragments: [{ kind: 'paragraph', text: 'x', emphasis: 'bold' }],
      }),
    ).toEqual({ fragments: [{ kind: 'paragraph', text: 'x', emphasis: 'none' }] });
  });

  it('абзац и заголовок без текста отвергаются: это не транскрипция', () => {
    expect(vlmTextResponseSchema.safeParse({ fragments: [{ kind: 'paragraph' }] }).success).toBe(
      false,
    );
    expect(
      vlmTextResponseSchema.safeParse({ fragments: [{ kind: 'heading', text: null }] }).success,
    ).toBe(false);
  });

  it('неизвестный вид фрагмента отвергается', () => {
    expect(
      vlmTextResponseSchema.safeParse({ fragments: [{ kind: 'list', text: 'x' }] }).success,
    ).toBe(false);
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
