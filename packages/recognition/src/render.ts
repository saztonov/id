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
 *    * stamp → строка `**[STAMP]** …` (правила v2, см. ниже).
 * 3. Склейка `'\n\n'`, схлопывание трёх и более переводов строки в два,
 *    `trim()` — та же нормализация, что у текущего корпусного парсера.
 *
 * ## Что изменила v2: штамп попал в текст страницы
 *
 * До v2 stamp-блок в текст не рендерился вовсе — «включение штампа отдельное
 * решение с перекалибровкой якорей» (ADR-0006, открытые вопросы). Решение
 * принято, и вот почему.
 *
 * На листе исполнительной схемы нет ничего, кроме чертежа и штампа: ни
 * заголовка, ни номера в теле страницы. Всё, чем такой лист вообще назван, —
 * ячейки штампа: «Исполнительная схема стяжки в/о …» и номер `№ К14/ДК2-СЦ4`.
 * Пока штамп из текста вырезался, портал не мог ни определить вид документа
 * (каталог так и записан: «`exec_scheme` текстом не определяется»), ни извлечь
 * его номер, — а без номера сверка с реестром приложений объявляла «нет в
 * комплекте» КАЖДУЮ схему, лежащую в комплекте.
 *
 * Номер листа печатается с `№` намеренно: правило извлечения `number` ищет
 * именно эту форму. «Обозначение» проекта (`Code:`) печатается без `№` — оно
 * общее у всех листов раздела и номером документа не является.
 *
 * Смена версии безопасна для уже разобранных страниц: `page_text_versions`
 * хранит `render_version` построчно, поэтому старые офсеты остаются описаны
 * своим правилом, а не переопределяются задним числом.
 */
import type { RecognitionBlock, RecognitionPage } from './schema.js';

export const PAGE_TEXT_RENDER_VERSION = 'recognition.page_text.v2';

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

/**
 * Заполнено ли поле штампа.
 *
 * Проверка шире, чем `!== null`, потому что сюда попадают и канонические
 * артефакты ПРОШЛЫХ версий, разобранные без схемы: у них поля `sheetCode`
 * просто нет, и строгое сравнение с `null` напечатало бы «№ undefined».
 */
function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function renderStampBlock(block: Extract<RecognitionBlock, { blockType: 'stamp' }>): string {
  const head: string[] = ['**[STAMP]**'];
  // Номер листа — первым и с «№»: это номер документа, и правило извлечения
  // ищет его именно в этой форме.
  if (present(block.stamp.sheetCode)) head.push(`№ ${block.stamp.sheetCode}`);
  if (present(block.stamp.code)) head.push(`Code: ${block.stamp.code}`);
  if (present(block.stamp.stage)) head.push(`Stage: ${block.stamp.stage}`);
  if (present(block.stamp.sheet)) head.push(`Sheet: ${block.stamp.sheet}`);

  const parts: string[] = [head.join(' | ')];
  if (present(block.stamp.name)) parts.push(`**Name:** ${block.stamp.name}`);
  if (present(block.stamp.object)) parts.push(`**Object:** ${block.stamp.object}`);
  if (present(block.stamp.organization)) {
    parts.push(`**Organization:** ${block.stamp.organization}`);
  }
  if (present(block.stamp.revisions)) parts.push(`**Revisions:** ${block.stamp.revisions}`);
  // `extra` — поля, которых контракт не знает по имени. Порядок ключей
  // детерминирован сортировкой: иначе один и тот же штамп давал бы разный
  // текст и разные офсеты от прогона к прогону.
  for (const key of Object.keys(block.stamp.extra).sort()) {
    parts.push(`**${key}:** ${block.stamp.extra[key] ?? ''}`);
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
    parts.push(renderStampBlock(block));
  }

  return parts
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
