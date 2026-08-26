/**
 * Рендер канонического текста страницы.
 *
 * Снапшот-набор фиксирует ПРАВИЛА v2 буквально: изменение рендера без смены
 * `PAGE_TEXT_RENDER_VERSION` обязано делать этот файл красным — от текста
 * зависят все офсеты и цитаты конвейера.
 */
import { describe, expect, it } from 'vitest';

import { PAGE_TEXT_RENDER_VERSION, renderPageText } from './render.js';
import type { RecognitionBlock, RecognitionPage } from './schema.js';

const base = {
  blockId: null,
  layoutBlockId: null,
  coordsNorm: null,
  confidence: null,
  modelId: null,
} as const;

function textBlock(ordinal: number | null, text: string): RecognitionBlock {
  return { ...base, ordinal, blockType: 'text', text, fragments: null, features: null };
}

function page(patch: Partial<RecognitionPage>): RecognitionPage {
  return {
    workingPageIndex: 0,
    rotation: 0,
    widthPx: null,
    heightPx: null,
    text: null,
    blocks: [],
    ...patch,
  };
}

describe('renderPageText v2', () => {
  it('версия правил зафиксирована', () => {
    expect(PAGE_TEXT_RENDER_VERSION).toBe('recognition.page_text.v2');
  });

  it('пре-отрендеренный текст возвращается дословно, байт-в-байт', () => {
    const verbatim = '##### АКТ\n\n\n\nосвидетельствования   скрытых работ  ';

    // Никакой нормализации: legacy-текст уже канонический, офсеты в нём.
    expect(renderPageText(page({ text: verbatim }))).toBe(verbatim);
  });

  it('блоки собираются по ordinal, штамп идёт последним при ordinal = null', () => {
    const result = renderPageText(
      page({
        blocks: [
          textBlock(2, 'второй абзац'),
          {
            ...base,
            ordinal: null,
            blockType: 'stamp',
            stamp: {
              code: 'ИД-01',
              sheetCode: null,
              stage: null,
              sheet: null,
              object: null,
              name: null,
              organization: null,
              revisions: null,
              extra: {},
            },
          },
          textBlock(1, 'первый абзац'),
        ],
      }),
    );

    expect(result).toBe('первый абзац\n\nвторой абзац\n\n**[STAMP]** | Code: ИД-01');
  });

  it('номер листа печатается с «№» — в форме, которую ищет извлечение номера', () => {
    // Лист исполнительной схемы не назван нигде, кроме штампа: ни заголовка, ни
    // номера в теле страницы нет. Пока штамп не попадал в текст, у документа не
    // было номера, и сверка с реестром объявляла «нет в комплекте».
    const result = renderPageText(
      page({
        blocks: [
          {
            ...base,
            ordinal: 1,
            blockType: 'stamp',
            stamp: {
              code: 'СТ26/01-14-ДК2-РД',
              sheetCode: 'К14/ДК2-СЦ4',
              stage: 'ИД',
              sheet: '1 из 1',
              object: 'Корпус 14',
              name: 'Исполнительная схема стяжки в/о П.Д-П.Ж',
              organization: 'ООО «ЭМДМ-СТРОЙ»',
              revisions: null,
              extra: { signature_1: 'Пр. работ — Хусенов М.К.' },
            },
          },
        ],
      }),
    );

    expect(result).toBe(
      '**[STAMP]** | № К14/ДК2-СЦ4 | Code: СТ26/01-14-ДК2-РД | Stage: ИД | Sheet: 1 из 1\n\n' +
        '**Name:** Исполнительная схема стяжки в/о П.Д-П.Ж\n\n' +
        '**Object:** Корпус 14\n\n' +
        '**Organization:** ООО «ЭМДМ-СТРОЙ»\n\n' +
        '**signature_1:** Пр. работ — Хусенов М.К.',
    );
  });

  it('штамп прошлой версии, разобранный без схемы, не печатает «№ undefined»', () => {
    // Канонические артефакты, записанные до появления `sheetCode`, поля просто
    // не имеют. Строгое сравнение с `null` напечатало бы «undefined» в тексте,
    // от которого зависят офсеты доказательств.
    const legacyStamp = {
      ...base,
      ordinal: 1,
      blockType: 'stamp',
      stamp: { code: 'ИД-01', stage: null, sheet: null, object: null, name: null, organization: null, revisions: null, extra: {} },
    } as unknown as RecognitionBlock;

    expect(renderPageText(page({ blocks: [legacyStamp] }))).toBe('**[STAMP]** | Code: ИД-01');
  });

  it('IMAGE-блок рендерится фиксированным шаблоном (снапшот правил v1)', () => {
    const result = renderPageText(
      page({
        blocks: [
          {
            ...base,
            ordinal: 1,
            blockType: 'image',
            image: {
              imageType: 'План',
              axes: '1/2, 2/2',
              zone: null,
              level: '-1 этаж',
              summary: 'Синтетическая схема.',
              description: 'Один лист с планом.',
              entities: [],
              verification: null,
            },
            features: null,
          },
        ],
      }),
    );

    expect(result).toBe(
      '**[IMAGE]** | Type: План | Axes: 1/2, 2/2 | Level: -1 этаж\n\n' +
        '**Summary:** Синтетическая схема.\n\n' +
        '**Description:** Один лист с планом.',
    );
  });

  it('детерминирован: два вызова дают идентичную строку', () => {
    const sample = page({ blocks: [textBlock(1, 'абзац')] });

    expect(renderPageText(sample)).toBe(renderPageText(sample));
  });
});
