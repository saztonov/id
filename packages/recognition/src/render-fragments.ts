/**
 * Детерминированный рендер структурных фрагментов текста блока в markdown.
 *
 * ## Место в конвейере
 *
 * VLM-путь (ADR-0007) получает от модели строгий JSON по схеме фрагментов,
 * зеркалящей канонический `ContentFragment`. Первичный источник — сами
 * фрагменты (`block_results.content_json`); `content_md` и текст страницы
 * СОБИРАЮТСЯ из них этим рендерером. От собранного текста зависят якоря
 * классификации, офсеты цитат и `char_span` реквизитов — тот же класс
 * зависимостей, что у `renderPageText` (см. render.ts), поэтому правила здесь
 * так же версионированы: любая правка обязана поднимать
 * `RENDER_FRAGMENTS_VERSION`, а снапшот-тест делает молчаливое изменение
 * громким.
 *
 * ## Правила v1
 *
 * 1. `paragraph` → текст как есть; `emphasis: 'strong'` оборачивает ВЕСЬ текст
 *    в `**…**` (модель отмечает жирным целый прогон, а не подстроки — так
 *    устроена схема ответа). Пустой текст — фрагмент пропускается: рендерить
 *    `****` значило бы выдумать содержимое.
 * 2. `heading` → `#`×level + пробел + текст (уровни 1..6 — GFM). `level: null`
 *    («модель видит заголовок, но не иерархию») → `**текст**` отдельным
 *    абзацем: выдумывать уровень нельзя, а потеря выделения обеднила бы якоря.
 * 3. `table` → GFM-таблица. GFM не умеет таблицу БЕЗ строки шапки, поэтому при
 *    `header: null` решение такое: первая строка данных НЕ повышается до шапки
 *    (это исказило бы данные — правило «never promote a data row» из промпта),
 *    вместо неё рендерится строка шапки из ПУСТЫХ ячеек. Число колонок —
 *    максимум по шапке и всем строкам (детерминировано; более узкие строки
 *    дополняются пустыми ячейками, чтобы ни одна ячейка не потерялась у
 *    рендереров, обрезающих лишние колонки). `title` — если задан, отдельным
 *    абзацем `**…**` НАД таблицей. `|` в ячейках экранируется `\|`, переводы
 *    строк внутри ячейки → `<br>` (единственный способ GFM сохранить строение
 *    многострочной ячейки). Таблица без единой ячейки пропускается.
 * 4. Объединённые ячейки (colspan/rowspan) контрактом НЕ поддерживаются —
 *    модель пишет значение один раз в верхней-левой позиции, остальные позиции
 *    пусты (правило промпта); рендеру здесь чинить нечего.
 * 5. Склейка фрагментов `'\n\n'`, схлопывание `\n{3,}` в два, `trim()` — та же
 *    нормализация, что у `renderPageText` v1: собранный из блоков текст
 *    страницы обязан вести себя одинаково независимо от того, каким путём
 *    получен текст блока.
 *
 * Экранирование markdown-метасимволов в тексте абзацев НЕ выполняется —
 * симметрично `renderPageText` v1, который отдаёт `text` блока как есть:
 * транскрипция инженерного текста со звёздочками и решётками встречается, и
 * искажение символов сдвинуло бы якоря хуже, чем случайное срабатывание
 * разметки.
 */
import type { ContentFragment } from './schema.js';

export const RENDER_FRAGMENTS_VERSION = 'recognition.fragments_md.v1';

/** `|` ломает структуру GFM-строки; перевод строки — саму строку таблицы. */
function tableCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r\n?|\n/gu, '<br>');
}

function renderTable(fragment: Extract<ContentFragment, { kind: 'table' }>): string {
  const { header, rows, title } = fragment.table;
  const width = Math.max(header?.length ?? 0, ...rows.map((row) => row.length), 0);
  if (width === 0) return '';

  const pad = (cells: readonly string[]): string => {
    const padded = [...cells.map(tableCell)];
    while (padded.length < width) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const lines: string[] = [];
  // Шапка обязательна для GFM; отсутствующая (`null`) заменяется пустыми
  // ячейками, а не первой строкой данных — см. правило 3 в шапке файла.
  lines.push(pad(header ?? []));
  lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  for (const row of rows) lines.push(pad(row));

  const table = lines.join('\n');
  const caption = title == null ? '' : title.trim();
  return caption === '' ? table : `**${caption}**\n\n${table}`;
}

function renderFragment(fragment: ContentFragment): string {
  switch (fragment.kind) {
    case 'paragraph': {
      const text = fragment.text.trim() === '' ? '' : fragment.text;
      if (text === '') return '';
      return fragment.emphasis === 'strong' ? `**${text}**` : text;
    }
    case 'heading': {
      const text = fragment.text.trim() === '' ? '' : fragment.text;
      if (text === '') return '';
      return fragment.level === null ? `**${text}**` : `${'#'.repeat(fragment.level)} ${text}`;
    }
    case 'table':
      return renderTable(fragment);
  }
}

/**
 * `ContentFragment[]` → markdown (GFM) по правилам v1.
 *
 * Детерминирован: одинаковый вход даёт байт-идентичный выход на любой
 * платформе — это условие стабильности `content_md` и всех офсетов ниже.
 */
export function renderFragmentsToMarkdown(fragments: readonly ContentFragment[]): string {
  const parts: string[] = [];
  for (const fragment of fragments) {
    const rendered = renderFragment(fragment);
    if (rendered !== '') parts.push(rendered);
  }
  return parts
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
