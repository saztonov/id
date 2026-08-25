/**
 * Контракт промптов стадии recognize: плейсхолдеры, формат вывода, коды,
 * параметры и следы происхождения из RD WEB.
 */
import { describe, expect, it } from 'vitest';

import {
  DOC_NAME_NEUTRAL,
  RECOGNITION_PROMPT_DEFAULTS,
  substitutePlaceholders,
} from './prompts.js';

const PLACEHOLDERS = ['{DOC_NAME}', '{PAGE_NUM}', '{BLOCK_ID}'] as const;
const TYPES = ['text', 'image', 'stamp'] as const;

describe('промпты стадии recognize', () => {
  it('коды соответствуют CHECK prompt_templates (^[a-z][a-z0-9_]*$, без точек)', () => {
    for (const type of TYPES) {
      expect(RECOGNITION_PROMPT_DEFAULTS[type].code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(RECOGNITION_PROMPT_DEFAULTS.text.code).toBe('recognition_block_text');
    expect(RECOGNITION_PROMPT_DEFAULTS.image.code).toBe('recognition_block_image');
    expect(RECOGNITION_PROMPT_DEFAULTS.stamp.code).toBe('recognition_block_stamp');
  });

  it('плейсхолдеры есть в каждом user-шаблоне и НИ в одном system', () => {
    for (const type of TYPES) {
      const { systemPrompt, userTemplate } = RECOGNITION_PROMPT_DEFAULTS[type];
      for (const placeholder of PLACEHOLDERS) {
        expect(userTemplate, `${type}: user содержит ${placeholder}`).toContain(placeholder);
        expect(systemPrompt, `${type}: system не содержит ${placeholder}`).not.toContain(
          placeholder,
        );
      }
    }
  });

  it('substitutePlaceholders подставляет контекст и не оставляет токенов', () => {
    const substituted = substitutePlaceholders(RECOGNITION_PROMPT_DEFAULTS.stamp.userTemplate, {
      pageNumber: 7,
      layoutBlockId: 'b7c0ffee-0000-4000-8000-000000000001',
    });

    expect(substituted).toContain(`DOC_NAME: ${DOC_NAME_NEUTRAL}`);
    expect(substituted).toContain('PAGE_NUM: 7');
    expect(substituted).toContain('BLOCK_ID: b7c0ffee-0000-4000-8000-000000000001');
    for (const placeholder of PLACEHOLDERS) expect(substituted).not.toContain(placeholder);
  });

  it('substitutePlaceholders заменяет ВСЕ вхождения (replaceAll, не replace)', () => {
    const doubled = substitutePlaceholders('{PAGE_NUM} и ещё раз {PAGE_NUM}', {
      pageNumber: 3,
      layoutBlockId: 'x',
    });
    expect(doubled).toBe('3 и ещё раз 3');
  });

  it('text-промпт требует строгий JSON и не содержит требований HTML', () => {
    const { systemPrompt, userTemplate } = RECOGNITION_PROMPT_DEFAULTS.text;
    const full = `${systemPrompt}\n${userTemplate}`;

    expect(full).not.toMatch(/html/iu);
    expect(full).not.toContain('<p>');
    expect(full).not.toContain('<table');
    expect(systemPrompt).toContain('{"fragments": [...]}');
    expect(systemPrompt).toContain('response_format');
  });

  it('text-промпт сохраняет правила транскрипции RD WEB дословно', () => {
    const system = RECOGNITION_PROMPT_DEFAULTS.text.systemPrompt;

    expect(system).toContain('CHARACTER AND IDENTIFIER POLICY');
    expect(system).toContain('READING ORDER AND STRUCTURE');
    expect(system).toContain('TABLES');
    // Маркерные дословные фразы боевого TEXT_SYSTEM:
    expect(system).toContain(
      'A descending axis row reads М, Л, К, И, Ж, Е, Д — never substitute the Latin sequence M, L, K, J, I, H, G.',
    );
    expect(system).toContain('write 250х120х65 or 250x120x65, never 250х120x65');
    expect(system).toContain('[неразборчиво]');
    // Правило маркеров списков: ровно один раз, как текст параграфа. Пример
    // выписан в ПЛОСКОЙ форме фрагмента — той же, что требует wire-схема
    // (`schemas.ts`): пример с тремя ключами учил бы формату, которого схема не
    // допускает, и расхождение вылезло бы только на живой модели.
    expect(system).toContain('must appear exactly once');
    expect(system).toContain(
      '{"kind": "paragraph", "text": "1. Текст пункта", "emphasis": "none", "level": null, "title": null, "header": null, "rows": null}',
    );
    // Правило шапки таблицы: null вместо повышения строки данных.
    expect(system).toContain('set "header" to null instead of promoting a data row');
  });

  it('text-промпт описывает плоский фрагмент со всеми семью ключами', () => {
    const system = RECOGNITION_PROMPT_DEFAULTS.text.systemPrompt;

    // Модель обязана получить ТУ ЖЕ форму, которой её ограничивает схема:
    // прежние три варианта «ровно один из» описывали union, а union — это как
    // раз то, на чём Google отвечал 400 и не распознавал ни одного text-блока.
    expect(system).toContain(
      'Every item of "fragments" has the same seven keys — "kind", "text", "emphasis", "level", "title", "header", "rows"',
    );
    expect(system).toContain('a key that does not apply to that "kind" is null');
    expect(system).not.toContain('is exactly one of');

    // Каждый пример — полный объект: семь ключей в одном фрагменте.
    for (const kind of ['paragraph', 'heading', 'table']) {
      const example = system
        .split('\n')
        .find((line) => line.trim().startsWith(`{"kind": "${kind}"`));
      expect(example, `пример фрагмента «${kind}» в промпте`).toBeDefined();
      for (const key of ['kind', 'text', 'emphasis', 'level', 'title', 'header', 'rows']) {
        expect(example).toContain(`"${key}":`);
      }
    }
  });

  it('image-промпт — BASE_RD_SYSTEM + аддендум image.rd.auto.compat.v1', () => {
    const { systemPrompt, userTemplate } = RECOGNITION_PROMPT_DEFAULTS.image;

    expect(systemPrompt).toContain('You analyze graphic blocks of Russian construction working');
    expect(systemPrompt).toContain('FRAGMENT-TYPE CLASSIFICATION');
    // Аддендум профиля AUTO идёт ПОСЛЕ базы (композиция compose_image_system).
    const profileAt = systemPrompt.indexOf('PROFILE: AUTO');
    expect(profileAt).toBeGreaterThan(systemPrompt.indexOf('ANSWER FIELDS'));
    expect(systemPrompt).toContain(
      'IDENTIFIERS: establish the visible discipline before resolving ambiguous marks',
    );
    // Указание про response_format уже в базе — оно сохранено, не задублировано.
    expect(systemPrompt).toContain('matching the provided response_format schema');
    expect(userTemplate).toContain('<untrusted_context_metadata>');
  });

  it('stamp-промпт: строка «omit a key» заменена на противоположную', () => {
    const system = RECOGNITION_PROMPT_DEFAULTS.stamp.systemPrompt;

    expect(system).not.toContain('Omit a key entirely instead of writing null');
    expect(system).not.toContain('omit an empty list instead of writing []');
    expect(system).toContain('Emit every field of the schema in every answer');
    expect(system).toContain('Never omit a key');
    // Остальное — дословный STAMP_SYSTEM.
    expect(system).toContain('You are Lift performing schema-constrained extraction');
    expect(system).toContain('ГОСТ Р 21.101-2020 Appendix Ж forms 3, 4, 5 or 6');
    expect(system).toContain('EVIDENCE AND CELL ASSIGNMENT');
    expect(RECOGNITION_PROMPT_DEFAULTS.stamp.userTemplate).toContain(
      'Extract this exact title-block fragment into the required JSON object.',
    );
  });

  it('параметры инференса соответствуют DEFAULT_INFERENCE_PARAMS RD WEB', () => {
    expect(RECOGNITION_PROMPT_DEFAULTS.text).toMatchObject({ temperature: 0.1, maxTokens: 12384 });
    expect(RECOGNITION_PROMPT_DEFAULTS.image).toMatchObject({ temperature: 0.7, maxTokens: 8192 });
    expect(RECOGNITION_PROMPT_DEFAULTS.stamp).toMatchObject({
      temperature: 0,
      maxTokens: 4096,
      topK: 1,
    });
    // topK объявлен только у stamp: отсутствие ключа = параметр не уезжает.
    expect('topK' in RECOGNITION_PROMPT_DEFAULTS.text).toBe(false);
    expect('topK' in RECOGNITION_PROMPT_DEFAULTS.image).toBe(false);
  });

  it('responseFormat присоединён к каждому типу и strict', () => {
    expect(RECOGNITION_PROMPT_DEFAULTS.text.responseFormat.name).toBe('text_block_result');
    expect(RECOGNITION_PROMPT_DEFAULTS.image.responseFormat.name).toBe('image_block_result');
    expect(RECOGNITION_PROMPT_DEFAULTS.stamp.responseFormat.name).toBe('stamp_block_result');
    for (const type of TYPES) {
      expect(RECOGNITION_PROMPT_DEFAULTS[type].responseFormat.strict).toBe(true);
    }
  });
});
