/**
 * Постобработка ответов VLM: чистка, извлечение JSON, валидаторы,
 * классификация неудач.
 */
import { describe, expect, it } from 'vitest';

import {
  CORRECTIVE_INSTRUCTION,
  INVALID_STAMP_PROSE_DOCUMENT_CODE,
  RETRYABLE_TABLE_EMPTY_ROWS,
  RETRY_INSTRUCTION,
  WARNING_EMPTY_FRAGMENTS,
  WARNING_STAMP_ALL_FIELDS_BLANK,
  WARNING_TABLE_RAGGED_ROWS,
  classifyFailure,
  extractJson,
  stripNoise,
  validateStamp,
  validateText,
} from './postprocess.js';
import {
  vlmImageResponseSchema,
  vlmTextResponseSchema,
  type VlmStampResponse,
  type VlmTextResponse,
} from './schemas.js';

function stamp(patch: Partial<VlmStampResponse>): VlmStampResponse {
  return {
    document_code: null,
    sheet_code: null,
    project_name: null,
    sheet_name: null,
    stage: null,
    sheet_number: null,
    total_sheets: null,
    organization: null,
    signatures: [],
    revisions: [],
    ...patch,
  };
}

describe('stripNoise', () => {
  it('снимает закрытые <think>-блоки и кодовые фенсы', () => {
    expect(stripNoise('<think>рассуждаю…</think>{"a":1}')).toBe('{"a":1}');
    expect(stripNoise('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripNoise('<think>x</think>\n```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('фенс в середине текста не вырезается (это содержимое)', () => {
    const middle = 'до ```json\n{"a":1}\n``` после';
    expect(stripNoise(middle)).toBe(middle);
  });

  it('литеральный </think> внутри валидного JSON не страдает', () => {
    // Ответ начинается с `{` — значит тег принадлежит содержимому страницы,
    // а не разметке рассуждений, и снимать его нельзя.
    expect(stripNoise('{"текст":"тег </think> в кавычках"}')).toBe(
      '{"текст":"тег </think> в кавычках"}',
    );
  });

  it('одиночный </think> снимается вместе с черновиком из рассуждений', () => {
    // Шаблон чата подставил `<think>` за модель, поэтому в content приезжает
    // только закрывающий тег. Без снятия префикса балансный скан взял бы
    // ПЕРВЫЙ объект — черновик, набросанный моделью по дороге.
    expect(stripNoise('прикину {"a":0} и уточню</think>{"a":1}')).toBe('{"a":1}');
  });

  it('незакрытый <think> срезается вместе со всем, что за ним', () => {
    // Обрыв внутри рассуждений. Ответа нет вовсе — и это честнее, чем выдать
    // за ответ черновик, который модель писала для себя.
    expect(stripNoise('<think>набросок {"a":0}, но проверю')).toBe('');
  });
});

describe('extractJson', () => {
  it('строгий разбор объекта', () => {
    expect(extractJson('{"fragments":[]}')).toEqual({ fragments: [] });
  });

  it('repair: первый сбалансированный объект из прозы', () => {
    expect(extractJson('Вот ответ: {"a":{"b":"}"}} и хвост')).toEqual({ a: { b: '}' } });
  });

  it('скобки и кавычки внутри строк не ломают баланс', () => {
    expect(extractJson('x {"a":"скобка { и \\" кавычка"} y')).toEqual({
      a: 'скобка { и " кавычка',
    });
  });

  it('валидный НЕ-объект (массив-дамп) не чинится — null', () => {
    expect(extractJson('[{"bbox":[1,2,3,4]}]')).toBeNull();
  });

  it('пустая строка, проза без объекта, битый JSON без баланса — null', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('Не могу распознать изображение.')).toBeNull();
    expect(extractJson('{"a": незакрыто')).toBeNull();
  });
});

describe('validateText', () => {
  it('пустые fragments — warning empty_fragments, не отказ', () => {
    const verdict = validateText({ fragments: [] });
    expect(verdict.warnings).toEqual([WARNING_EMPTY_FRAGMENTS]);
    expect(verdict.invalid).toBeNull();
    expect(verdict.retryable).toBeNull();
  });

  it('таблица без строк и без шапки — retryable, а не отказ и не норма', () => {
    // Боевой ответ модели на страницу описи передачи: сетку объявила, из сорока
    // строк не выписала ни одной. Страница осталась без текста и не отнеслась
    // ни к одному документу.
    const verdict = validateText({
      fragments: [{ kind: 'table', title: null, header: null, rows: [] }],
    });
    expect(verdict.retryable).toBe(RETRYABLE_TABLE_EMPTY_ROWS);
    expect(verdict.invalid).toBeNull();
  });

  it('пустая сетка рядом с абзацами — тоже retryable', () => {
    // Тот же ответ, но текст вокруг таблицы модель отдала. Потеряна ровно
    // таблица, и это по-прежнему потеря: на боевой странице так ушёл весь
    // перечень документов, а шапка и подвал остались.
    const verdict = validateText({
      fragments: [
        { kind: 'table', title: null, header: null, rows: [] },
        { kind: 'paragraph', text: 'Стр. 1 из 4', emphasis: 'none' },
      ],
    });
    expect(verdict.retryable).toBe(RETRYABLE_TABLE_EMPTY_ROWS);
  });

  it('шапка без строк — законная форма бланка, повтора не просит', () => {
    // Незаполненная графа печатной формы: шапка напечатана, данных нет. Такая
    // таблица есть на первой странице описи, и требовать по ней повтор значило
    // бы платить за то, что модель прочитала верно.
    const verdict = validateText({
      fragments: [{ kind: 'table', title: null, header: ['№', 'Наименование'], rows: [] }],
    });
    expect(verdict.retryable).toBeNull();
    expect(verdict.warnings).toEqual([]);
  });

  it('таблица с рваными строками — warning table_ragged_rows, не отказ', () => {
    const response: VlmTextResponse = {
      fragments: [{ kind: 'table', title: null, header: null, rows: [['a'], ['b', 'c']] }],
    };
    const verdict = validateText(response);
    expect(verdict.warnings).toEqual([WARNING_TABLE_RAGGED_ROWS]);
    expect(verdict.invalid).toBeNull();
  });

  it('ровная таблица и непустые абзацы — чисто', () => {
    const verdict = validateText({
      fragments: [
        { kind: 'paragraph', text: 'т', emphasis: 'none' },
        { kind: 'table', title: null, header: ['а', 'б'], rows: [['1', '2']] },
      ],
    });
    expect(verdict).toEqual({ warnings: [], invalid: null, retryable: null });
  });

  it('рваная таблица и пустая сетка в одном блоке — оба кода, по одному', () => {
    const verdict = validateText({
      fragments: [
        { kind: 'table', title: null, header: null, rows: [['a'], ['b', 'c']] },
        { kind: 'table', title: null, header: null, rows: [] },
      ],
    });
    expect(verdict.warnings).toEqual([WARNING_TABLE_RAGGED_ROWS]);
    expect(verdict.retryable).toBe(RETRYABLE_TABLE_EMPTY_ROWS);
  });
});

describe('validateStamp', () => {
  it('все поля пусты — warning stamp_all_fields_blank, не отказ', () => {
    const verdict = validateStamp(stamp({}));
    expect(verdict.warnings).toEqual([WARNING_STAMP_ALL_FIELDS_BLANK]);
    expect(verdict.invalid).toBeNull();
  });

  it('пробельные скаляры считаются пустыми', () => {
    const verdict = validateStamp(stamp({ stage: '  ' }));
    expect(verdict.warnings).toEqual([WARNING_STAMP_ALL_FIELDS_BLANK]);
  });

  it('компактный шифр — чисто', () => {
    expect(validateStamp(stamp({ document_code: 'СТ26/01-14-АР5-3-РД' }))).toEqual({
      warnings: [],
      invalid: null,
      retryable: null,
    });
  });

  it('проза наименования вместо шифра — invalid stamp_prose_document_code', () => {
    const prose =
      'Многоквартирный жилой дом со встроенными помещениями обслуживания по адресу город условный, улица условная, участок 12';
    const verdict = validateStamp(stamp({ document_code: prose }));
    expect(verdict.invalid).toBe(INVALID_STAMP_PROSE_DOCUMENT_CODE);
    // Проза в шифре повтором не лечится: промпт уже требует шифр из графы.
    expect(verdict.retryable).toBeNull();
  });

  it('сверхдлинная строка (>160) — invalid независимо от состава слов', () => {
    const verdict = validateStamp(stamp({ document_code: 'X'.repeat(161) }));
    expect(verdict.invalid).toBe(INVALID_STAMP_PROSE_DOCUMENT_CODE);
  });

  it('длинный, но кодоподобный шифр без русской прозы — чисто', () => {
    const longCode = 'СТ26/01-14-АР5-3-РД-К1 СТ26/01-14-АР5-3-РД-К2 СТ26/01-14-АР5-3-РД-К3 ИЗМ.2';
    expect(validateStamp(stamp({ document_code: longCode })).invalid).toBeNull();
  });
});

describe('classifyFailure', () => {
  it('проза/markdown вместо JSON — fixable_genre', () => {
    expect(classifyFailure('Не могу это распознать.', null)).toBe('fixable_genre');
  });

  it('JSON без ожидаемой обёртки (нет ключей схемы) — fixable_genre', () => {
    const raw = '{"result": "готово"}';
    const parsed = vlmTextResponseSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(classifyFailure(raw, parsed.error)).toBe('fixable_genre');
  });

  it('обёртка есть, но значения не по схеме — invalid (повтор бессмыслен)', () => {
    const raw = '{"fragments": 5}';
    const parsed = vlmTextResponseSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(classifyFailure(raw, parsed.error)).toBe('invalid');
  });

  it('чужое значение enum при полной обёртке — invalid', () => {
    const raw = JSON.stringify({
      fragment_type: 'Чертёж',
      location: { grid_lines: null, zone_name: null, level_or_elevation: null },
      content_summary: 'с',
      detailed_description: 'о',
      verification_recommendations: '',
      key_entities: [],
    });
    const parsed = vlmImageResponseSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(classifyFailure(raw, parsed.error)).toBe('invalid');
  });

  it('JSON в фенсе с think-префиксом классифицируется по содержимому', () => {
    const raw = '<think>…</think>```json\n{"unexpected": true}\n```';
    const parsed = vlmTextResponseSchema.safeParse({ unexpected: true });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(classifyFailure(raw, parsed.error)).toBe('fixable_genre');
  });
});

describe('CORRECTIVE_INSTRUCTION', () => {
  it('объявлена для всех трёх типов, начинается с CRITICAL, требует один JSON', () => {
    for (const type of ['text', 'image', 'stamp'] as const) {
      expect(CORRECTIVE_INSTRUCTION[type]).toMatch(/^CRITICAL — /u);
      expect(CORRECTIVE_INSTRUCTION[type]).toContain('ONLY one JSON object');
      expect(CORRECTIVE_INSTRUCTION[type]).toContain('response_format');
    }
  });
});

describe('RETRY_INSTRUCTION', () => {
  it('у каждого кода retryable есть свой довесок', () => {
    // Код без инструкции означал бы повтор с тем же промптом: платный вызов,
    // детерминированно возвращающий тот же ответ.
    const instruction = RETRY_INSTRUCTION[RETRYABLE_TABLE_EMPTY_ROWS];
    expect(instruction).toBeDefined();
    expect(instruction).toMatch(/^CRITICAL — /u);
    expect(instruction).toContain('ONLY one JSON object');
  });

  it('говорит о таблице, а не о жанре ответа', () => {
    // Жанр здесь верен: модель ответила по схеме. Сказать ей «вернул не тот вид
    // ответа» значило бы отправить чинить то, что не сломано.
    expect(RETRY_INSTRUCTION[RETRYABLE_TABLE_EMPTY_ROWS]).toContain('rows');
    expect(RETRY_INSTRUCTION[RETRYABLE_TABLE_EMPTY_ROWS]).not.toContain('wrong kind of answer');
  });
});
