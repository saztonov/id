/**
 * Детерминированный рендер канонического текста страницы.
 *
 * ## Почему рендер версионирован
 *
 * От этого текста зависят ВСЕ офсеты: цитаты LLM-классификации, `char_span`
 * реквизитов, доказательства замечаний. Молчаливая смена правил рендера
 * сдвинула бы их все — тот же класс отказа, от которого колонку
 * `offset_convention` завели в `page_text_versions` (миграция 0004). Поэтому
 * любое изменение правил ниже обязано поднимать `PAGE_TEXT_RENDER_VERSION`,
 * а снапшот-тест в `render.test.ts` делает нарушение громким.
 *
 * ## Правила v1
 *
 * 1. `page.text !== null` — вернуть ДОСЛОВНО. Это legacy-путь: адаптер от
 *    markdown кладёт туда текущий текст страницы, и байт-идентичность
 *    достигается по построению, а не пересборкой.
 * 2. Иначе — блоки в порядке (`ordinal` по возрастанию, `null` — после всех,
 *    при равенстве — порядок массива):
 *    * text  → `text` как есть (пустые пропускаются);
 *    * image → шаблон, повторяющий сегодняшний markdown-рендер RD WEB:
 *      `**[IMAGE]** | Type: … | Axes: … | Zone: … | Level: …` — только
 *      заполненные поля; затем `**Summary:** …`, `**Description:** …`,
 *      `**Entities:** …`, `**Verification:** …` — только заполненные;
 *    * stamp → ничего: сегодня строки `> **Stamp:**` вырезаются из текста
 *      страницы, и включение штампа в рендер — отдельное решение с
 *      перекалибровкой якорей (см. ADR-0006, открытые вопросы).
 * 3. Склейка `'\n\n'`, схлопывание трёх и более переводов строки в два,
 *    `trim()` — та же нормализация, что у текущего корпусного парсера.
 */
import type { RecognitionBlock, RecognitionPage } from './schema.js';

export const PAGE_TEXT_RENDER_VERSION = 'recognition.page_text.v1';

function orderedBlocks(blocks: readonly RecognitionBlock[]): readonly RecognitionBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.ordinal === null && b.ordinal === null) return 0;
    if (a.ordinal === null) return 1;
    if (b.ordinal === null) return -1;
    return a.ordinal - b.ordinal;
  });
}

function renderImageBlock(block: Extract<RecognitionBlock, { blockType: 'image' }>): string {
  const head: string[] = ['**[IMAGE]**'];
  if (block.image.imageType !== null) head.push(`Type: ${block.image.imageType}`);
  if (block.image.axes !== null) head.push(`Axes: ${block.image.axes}`);
  if (block.image.zone !== null) head.push(`Zone: ${block.image.zone}`);
  if (block.image.level !== null) head.push(`Level: ${block.image.level}`);

  const parts: string[] = [head.join(' | ')];
  if (block.image.summary !== null) parts.push(`**Summary:** ${block.image.summary}`);
  if (block.image.description !== null) parts.push(`**Description:** ${block.image.description}`);
  if (block.image.entities.length > 0) {
    parts.push(`**Entities:** ${block.image.entities.join(', ')}`);
  }
  if (block.image.verification !== null) {
    parts.push(`**Verification:** ${block.image.verification}`);
  }
  return parts.join('\n\n');
}

export function renderPageText(page: RecognitionPage): string {
  if (page.text !== null) return page.text;

  const parts: string[] = [];
  for (const block of orderedBlocks(page.blocks)) {
    if (block.blockType === 'text') {
      if (block.text.trim() !== '') parts.push(block.text);
      continue;
    }
    if (block.blockType === 'image') {
      parts.push(renderImageBlock(block));
      continue;
    }
    // stamp: в канонический текст страницы не попадает (см. шапку файла).
  }

  return parts
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
