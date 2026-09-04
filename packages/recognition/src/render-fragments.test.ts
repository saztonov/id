/**
 * Снапшоты рендера фрагментов v1.
 *
 * Ожидаемые строки зафиксированы буквально: от `content_md` зависят якоря
 * классификации и офсеты цитат, поэтому любое изменение правил обязано
 * делать этот файл красным вместе с поднятием `RENDER_FRAGMENTS_VERSION`.
 */
import { describe, expect, it } from 'vitest';

import { RENDER_FRAGMENTS_VERSION, renderFragmentsToMarkdown } from './render-fragments.js';
import type { ContentFragment } from './schema.js';

function paragraph(text: string, emphasis: 'none' | 'strong' = 'none'): ContentFragment {
  return { kind: 'paragraph', text, emphasis };
}

function heading(level: number | null, text: string): ContentFragment {
  return { kind: 'heading', level, text };
}

function table(
  header: string[] | null,
  rows: string[][],
  title: string | null = null,
): ContentFragment {
  return { kind: 'table', table: { header, rows, title } };
}

describe('renderFragmentsToMarkdown v1', () => {
  it('версия правил зафиксирована', () => {
    expect(RENDER_FRAGMENTS_VERSION).toBe('recognition.fragments_md.v1');
  });

  it('абзацы: обычный, жирный, пустые пропускаются', () => {
    const result = renderFragmentsToMarkdown([
      paragraph('1. Общие указания'),
      paragraph(''),
      paragraph('   '),
      paragraph('ВНИМАНИЕ', 'strong'),
      paragraph('Труба стальная по ГОСТ 10704-91.'),
    ]);

    expect(result).toBe('1. Общие указания\n\n**ВНИМАНИЕ**\n\nТруба стальная по ГОСТ 10704-91.');
  });

  it('заголовки: уровень 1..6 — решётки, null — жирный абзац', () => {
    const result = renderFragmentsToMarkdown([
      heading(1, 'АКТ'),
      heading(3, 'освидетельствования скрытых работ'),
      heading(null, 'Примечания'),
    ]);

    expect(result).toBe('# АКТ\n\n### освидетельствования скрытых работ\n\n**Примечания**');
  });

  it('таблица с шапкой и заголовком — GFM с **title** над таблицей', () => {
    const result = renderFragmentsToMarkdown([
      table(
        ['Поз.', 'Наименование', 'Кол.'],
        [
          ['1', 'Труба DN50', '2'],
          ['2', 'Отвод 90°', '4'],
        ],
        'Спецификация',
      ),
    ]);

    expect(result).toBe(
      '**Спецификация**\n\n' +
        '| Поз. | Наименование | Кол. |\n' +
        '| --- | --- | --- |\n' +
        '| 1 | Труба DN50 | 2 |\n' +
        '| 2 | Отвод 90° | 4 |',
    );
  });

  it('header null: первая строка НЕ повышается до шапки, шапка из пустых ячеек', () => {
    const result = renderFragmentsToMarkdown([
      table(null, [
        ['Разраб.', 'Иванов'],
        ['Пров.', 'Петров'],
      ]),
    ]);

    expect(result).toBe(
      '|  |  |\n' + '| --- | --- |\n' + '| Разраб. | Иванов |\n' + '| Пров. | Петров |',
    );
  });

  it('рваные строки дополняются пустыми ячейками до максимальной ширины', () => {
    const result = renderFragmentsToMarkdown([table(['А', 'Б'], [['1'], ['2', '3', '4']])]);

    // Ширина = max(2, 1, 3) = 3: ни одна ячейка не теряется.
    expect(result).toBe(
      '| А | Б |  |\n' + '| --- | --- | --- |\n' + '| 1 |  |  |\n' + '| 2 | 3 | 4 |',
    );
  });

  it('в ячейках экранируется | и переводы строк становятся <br>', () => {
    const result = renderFragmentsToMarkdown([
      table(['Марка'], [['АР3 | КЖ1'], ['строка 1\nстрока 2']]),
    ]);

    expect(result).toBe(
      '| Марка |\n' + '| --- |\n' + '| АР3 \\| КЖ1 |\n' + '| строка 1<br>строка 2 |',
    );
  });

  it('пустая таблица и пустой набор фрагментов дают пустую строку', () => {
    expect(renderFragmentsToMarkdown([])).toBe('');
    expect(renderFragmentsToMarkdown([table(null, [])])).toBe('');
    expect(renderFragmentsToMarkdown([table(null, []), paragraph('')])).toBe('');
  });

  it('склейка \\n\\n, схлопывание \\n{3,} и trim — как у renderPageText v1', () => {
    const result = renderFragmentsToMarkdown([
      paragraph('первый\n\n\n\nс лишними переводами'),
      paragraph('второй'),
    ]);

    expect(result).toBe('первый\n\nс лишними переводами\n\nвторой');
  });

  it('детерминирован: два вызова дают идентичную строку', () => {
    const sample: ContentFragment[] = [
      heading(2, 'Ведомость'),
      table(['№', 'Обозначение'], [['1', 'СТ26/01-14-АР5-3-РД']]),
    ];

    expect(renderFragmentsToMarkdown(sample)).toBe(renderFragmentsToMarkdown(sample));
  });
});
