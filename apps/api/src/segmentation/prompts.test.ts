/**
 * Промты сегментации.
 *
 * Главный тест здесь — запрет §0.5 п. 6: промт не сообщает модели раздел
 * работ и не намекает на разделы, которыми оказался покрыт корпус. Проверка
 * механическая, потому что нарушить запрет проще всего из лучших побуждений:
 * добавить в промт названия типов «чтобы модель лучше понимала» или оставить
 * в списке только коды, встреченные в текущем комплекте.
 *
 * Что именно сканируется: сам промт — системная часть, шаблон
 * пользовательской части и список кодов, — но не текст страницы, который в
 * шаблон подставляется. Текст реального документа, разумеется, говорит о
 * своём предмете; это данные, а не инструкция модели.
 */
import { describe, expect, it } from 'vitest';
import { DOC_TYPES } from '@id/doc-types';
import {
  findSectionMarkers,
  PAGE_CLASSIFY_PROMPT,
  promptDocTypeCodes,
  renderUserPrompt,
  SECTION_MARKERS,
} from './prompts.js';
import type { PageInput } from './types.js';

function neutralPage(text: string, id = 'p1'): PageInput {
  return {
    sourcePageId: id,
    folderOrdinal: 4,
    sourceFileId: 'file-1',
    filePageIndex: 3,
    pageTextVersionId: 'ptv-1',
    text,
    blockTypes: ['text', 'stamp'],
    rotation: 0,
  };
}

/** Эффективный промт: инструкции плюс всё, что мы подставляем от себя. */
function effectivePrompt(): string {
  const codes = promptDocTypeCodes();
  const rendered = renderUserPrompt(
    neutralPage('НЕЙТРАЛЬНЫЙ ТЕКСТ СТРАНИЦЫ № 1'),
    { before: null, after: null },
    codes,
  );
  return [PAGE_CLASSIFY_PROMPT.system, PAGE_CLASSIFY_PROMPT.user, codes.join(' '), rendered].join(
    '\n',
  );
}

describe('промт не знает раздела работ (§0.5, п. 6)', () => {
  it('не содержит ни одного маркера разделов корпуса', () => {
    const found = findSectionMarkers(effectivePrompt());
    expect(found, `промт намекает на раздел работ: ${found.join(', ')}`).toEqual([]);
  });

  it('сканер умеет краснеть, а не молчит всегда', () => {
    // Проверка запрета, которая не способна сработать, не проверяет ничего.
    // Здесь сканеру подсовывается ровно то, что он обязан ловить.
    expect(findSectionMarkers('Комплект относится к разделу 2.5.1 «Кровля автостоянки».')).toEqual(
      expect.arrayContaining(['кровля', '2.5.1']),
    );
    expect(SECTION_MARKERS.length).toBeGreaterThan(5);
  });

  it('список кодов передаётся целиком, без отбора «релевантных разделу»', () => {
    const codes = promptDocTypeCodes();
    const expected = DOC_TYPES.filter((t) => !t.isFallback).map((t) => t.code);
    expect(codes).toEqual(expected);
    // Отбор по разделу — самый сильный намёк из возможных: он сообщает раздел
    // вернее любого текста. Поэтому в списке есть и типы, которых в корпусе
    // не было ни разу.
    expect(codes.some((c) => !DOC_TYPES.find((t) => t.code === c)?.observedInCorpus)).toBe(true);
  });

  it('резервные коды модели не предлагаются', () => {
    // Их присваивает декодер по исходу `other`. Предложи мы их как обычные
    // коды — модель выбирала бы резерв вместо честного `other`, и
    // `doc_type_candidates` остались бы пустыми.
    expect(promptDocTypeCodes()).not.toContain('unknown_document');
    expect(promptDocTypeCodes().some((c) => c.startsWith('other_'))).toBe(false);
  });
});

describe('промт задаёт открытый мир явно', () => {
  it('требует различать «other» и «uncertain»', () => {
    for (const prompt of [PAGE_CLASSIFY_PROMPT.system]) {
      expect(prompt).toContain('"other"');
      expect(prompt).toContain('"uncertain"');
      expect(prompt).toMatch(/другой случай|разные ответы/u);
    }
  });

  it('требует observed_title при «other»', () => {
    for (const prompt of [PAGE_CLASSIFY_PROMPT.system]) {
      expect(prompt).toContain('observed_title');
      expect(prompt).toMatch(/ОБЯЗАТЕЛЬНО|обязателен/u);
    }
  });

  it('требует дословную цитату', () => {
    expect(PAGE_CLASSIFY_PROMPT.system).toContain('quote');
    expect(PAGE_CLASSIFY_PROMPT.system).toMatch(/дословн/iu);
  });
});

describe('подстановка в шаблон', () => {
  it('не оставляет незаполненных мест', () => {
    const rendered = renderUserPrompt(
      neutralPage('ТЕКСТ СТРАНИЦЫ'),
      { before: neutralPage('ПРЕДЫДУЩАЯ', 'p0'), after: neutralPage('СЛЕДУЮЩАЯ', 'p2') },
      promptDocTypeCodes(),
    );
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/u);
    expect(rendered).toContain('ПРЕДЫДУЩАЯ');
    expect(rendered).toContain('СЛЕДУЮЩАЯ');
    expect(rendered).toContain('ТЕКСТ СТРАНИЦЫ');
  });

  it('отсутствующий сосед назван явно, а не пустой строкой', () => {
    const rendered = renderUserPrompt(
      neutralPage('ТЕКСТ'),
      { before: null, after: null },
      promptDocTypeCodes(),
    );
    expect(rendered).toContain('(страницы нет)');
  });

  it('не искажает текст страницы со спецсимволами замены', () => {
    // `String.prototype.replace` со строкой-заменой трактует `$&` и `$'`
    // как ссылки на совпадение. Искажение текста в промте тихое: ответ
    // модели остаётся правдоподобным, а основан на другом тексте.
    const tricky = "Цена $& за штуку; сноска $' и группа $1";
    const rendered = renderUserPrompt(
      neutralPage(tricky),
      { before: null, after: null },
      promptDocTypeCodes(),
    );
    expect(rendered).toContain(tricky);
  });
});
