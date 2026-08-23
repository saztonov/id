/**
 * Извлечение реквизитов моделью (§8.4, S21).
 *
 * Проверяется НЕ «функция вернула массив», а те три инварианта, ради которых
 * этот слой существует отдельно от промта:
 *
 * 1. значение без подтверждённой цитаты не принимается — иначе сочинённое
 *    наименование организации попадёт в `field_values` наравне с прочитанным;
 * 2. модель не может дописать поле, которого не заказывали, — расхождение
 *    промта и каталога обязано быть видно, а не пройти молча;
 * 3. отказ ПРОВАЙДЕРА пробрасывается, а непригодный ОТВЕТ — нет: первое
 *    относится ко всем следующим документам, второе — только к этому.
 */
import { describe, expect, it } from 'vitest';

import { LlmError } from '../llm/port.js';
import {
  EXTRACT_QUOTE_NOT_MAPPED,
  extractFieldsWithLlm,
  llmFieldsFor,
  type ExtractPage,
} from './llm-extract.js';
import { clipDocumentText } from './prompts.js';

const PAGE: ExtractPage = {
  pageTextVersionId: '00000000-0000-4000-8000-000000000001',
  text: [
    'СЕРТИФИКАТ СООТВЕТСТВИЯ № РОСС RU.АБ12.Н00123',
    'Изготовитель: ООО «Металлургический завод», 143000, Московская обл., г. Одинцово',
    'Продукция: арматура класса А500С',
  ].join('\n'),
};

const PROMPT = { system: 'система', user: 'пользователь' };

function respond(payload: unknown) {
  return {
    complete: async () => Promise.resolve({ text: JSON.stringify(payload) }),
  };
}

describe('llmFieldsFor', () => {
  it('отбирает только поля с extractor: llm и не дублирует коды', () => {
    const fields = llmFieldsFor({ docTypeCode: null, typeConfident: false });
    const codes = fields.map((field) => field.code);

    expect(codes).toContain('issuer');
    expect(codes).toContain('manufacturer');
    // Номер и дата — детерминированные: их берёт `extract.ts`, и второй
    // источник правды с правом опровергнуть первый здесь не нужен.
    expect(codes).not.toContain('number');
    expect(codes).not.toContain('issued_at');
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('типо-специфичную схему подмешивает только при уверенном типе', () => {
    const unsure = llmFieldsFor({ docTypeCode: 'aosr', typeConfident: false }).map((f) => f.code);
    const sure = llmFieldsFor({ docTypeCode: 'aosr', typeConfident: true }).map((f) => f.code);
    expect(sure.length).toBeGreaterThanOrEqual(unsure.length);
  });
});

describe('extractFieldsWithLlm', () => {
  const input = {
    docTypeCode: null,
    typeConfident: false,
    documentId: 'doc-1',
    pages: [PAGE],
  };

  it('принимает значение с цитатой и отображает её на исходный текст', async () => {
    const outcome = await extractFieldsWithLlm(
      input,
      respond({
        values: [
          {
            code: 'manufacturer',
            value: 'ООО «Металлургический завод»',
            items: null,
            confidence: 0.9,
            quote: 'Изготовитель: ООО «Металлургический завод»',
          },
        ],
      }),
      PROMPT,
    );

    expect(outcome.problems).toEqual([]);
    expect(outcome.fields).toHaveLength(1);
    const field = outcome.fields[0];
    expect(field?.fieldCode).toBe('manufacturer');
    expect(field?.extractedBy).toBe('llm');
    // Цитата — срез ИСХОДНОГО текста, а не строка модели: иначе подсветка в UI
    // разойдётся с записанным диапазоном.
    expect(field?.evidence?.quote).toBe(
      PAGE.text.slice(field?.evidence?.charStart, field?.evidence?.charEnd),
    );
  });

  it('отбрасывает значение с выдуманной цитатой и называет причину', async () => {
    const outcome = await extractFieldsWithLlm(
      input,
      respond({
        values: [
          {
            code: 'manufacturer',
            value: 'ООО «Другой завод»',
            items: null,
            confidence: 0.95,
            quote: 'Изготовитель: ООО «Другой завод»',
          },
        ],
      }),
      PROMPT,
    );

    expect(outcome.fields).toEqual([]);
    expect(outcome.problems).toEqual([`manufacturer: ${EXTRACT_QUOTE_NOT_MAPPED}`]);
  });

  it('не принимает поле, которого не заказывали', async () => {
    const outcome = await extractFieldsWithLlm(
      input,
      respond({
        values: [
          {
            code: 'number',
            value: 'РОСС RU.АБ12.Н00123',
            items: null,
            confidence: 1,
            quote: 'СЕРТИФИКАТ СООТВЕТСТВИЯ № РОСС RU.АБ12.Н00123',
          },
        ],
      }),
      PROMPT,
    );

    expect(outcome.fields).toEqual([]);
    expect(outcome.problems[0]).toContain('не запрашивалось');
  });

  it('пустое значение — ответ, а не значение: строка в field_values не пишется', async () => {
    const outcome = await extractFieldsWithLlm(
      input,
      respond({
        values: [
          { code: 'applicant', value: null, items: [], confidence: 0.8, quote: 'Продукция:' },
        ],
      }),
      PROMPT,
    );

    expect(outcome.fields).toEqual([]);
    expect(outcome.problems).toEqual([]);
  });

  it('ответ не по схеме не роняет документ', async () => {
    const outcome = await extractFieldsWithLlm(
      input,
      { complete: async () => Promise.resolve({ text: 'не json вовсе' }) },
      PROMPT,
    );
    expect(outcome.fields).toEqual([]);
    expect(outcome.problems).toEqual(['ответ модели не является JSON']);
  });

  it('отказ провайдера пробрасывается: он относится ко всем документам', async () => {
    await expect(
      extractFieldsWithLlm(
        input,
        {
          complete: async () => {
            await Promise.resolve();
            throw new LlmError('месячный бюджет исчерпан', {
              retriable: false,
              stopsBatch: true,
            });
          },
        },
        PROMPT,
      ),
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe('clipDocumentText', () => {
  it('короткий документ не трогает', () => {
    expect(clipDocumentText('шапка и подвал', 100)).toBe('шапка и подвал');
  });

  it('режет СЕРЕДИНУ, оставляя шапку и подвал', () => {
    // Реквизиты живут по краям: «Изготовитель» в начале сертификата, подписи и
    // дата в конце. Обрезка хвостом отняла бы ровно половину нужного.
    const text = `ШАПКА${'x'.repeat(500)}ПОДВАЛ`;
    const clipped = clipDocumentText(text, 100);

    expect(clipped.startsWith('ШАПКА')).toBe(true);
    expect(clipped.endsWith('ПОДВАЛ')).toBe(true);
    expect(clipped).toContain('середина документа пропущена');
  });

  it('пропуск отмечен явно, а не молчаливым стыком', () => {
    // Молчаливый разрыв читается моделью как соседство несоседних строк, и она
    // честно сообщит о противоречии, которого в бумаге нет.
    const clipped = clipDocumentText('A'.repeat(400), 50);
    expect(clipped).toContain('[середина документа пропущена]');
  });
});
