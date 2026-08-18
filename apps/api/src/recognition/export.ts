/**
 * Разбор экспорта RD WEB в текст страниц и результаты блоков (§5.2, шаг 8).
 *
 * ## Что лежит в архиве и почему именно это
 *
 * `GET /api/exports/jobs/{id}/zip` собирает ровно три записи —
 * `document.md`, `document.html`, `qa_manifest.json` (их `exports.py`).
 * Индекса блоков (`*_blocks.json`) в архиве JOB'а нет: он есть только в
 * ПОДОКУМЕНТНОМ архиве, который дополнительно кладёт внутрь исходный PDF, то
 * есть второй заезд 86 МБ ради файла, геометрию из которого мы и так знаем
 * (она у нас заморожена). Поэтому вид артефакта `blocks_json` (§3.5) на
 * легаси-API не производится — это зафиксированное допущение, а не пропуск.
 *
 * ## Форма Markdown
 *
 * Проверена по реальным выгрузкам `temp/MD/*` и по их `render_markdown.py`:
 *
 * ```
 * # Document: <имя>
 * ## Page <N>                       N = page_index + 1
 * ### BLOCK #<k> [TEXT]: <block_id>
 * > **Created:** …                  провенанс, не текст документа
 * > **Crop:** [Crop](<подписанный URL>)
 * > **Stamp:** …
 * <тело блока>
 * ```
 *
 * Страница без единого терминального блока секции НЕ получает: их рендер идёт
 * по блокам, а не по страницам. Отсутствие строки `page_text_versions` для
 * такой страницы — честный ответ «текста нет», и он отличается от пустой
 * строки, которую пришлось бы придумать.
 *
 * ## Почему строки провенанса вырезаются
 *
 * `> **Crop:**` несёт БЕССРОЧНУЮ подписанную ссылку на их сайт. §11 прямо
 * относит подписанный URL к значениям, подлежащим redaction, а `text_md`
 * попадает и в ответы API, и в цитаты доказательств, и живёт без срока
 * хранения. Правило живёт в `redaction.ts` и применяется ДВАЖДЫ: здесь — к
 * тексту, который ложится в базу, и на выдаче артефакта — к содержимому,
 * которое уходит наружу. Одно правило в двух точках, а не два похожих.
 *
 * Сам архив при этом сохраняется побайтово — иначе `artifact_sha256` перестал
 * бы описывать то, что мы получили (ADR-0005 п. 4).
 */
import { PROVENANCE_LINE, redactAbsoluteUrls } from './redaction.js';

/** Заголовок страницы: `## Page 12`. */
const PAGE_HEADING = /^## Page (\d+)\s*$/;

/** Заголовок блока: `### BLOCK #3 [TEXT]: blk_…`. */
const BLOCK_HEADING = /^### BLOCK #(\d+) \[([A-Z]+)\]: (\S+)\s*$/;

export const EXPORT_ENTRY_MARKDOWN = 'document.md';
export const EXPORT_ENTRY_HTML = 'document.html';
export const EXPORT_ENTRY_QA = 'qa_manifest.json';

export interface ExportPageText {
  /** Индекс страницы рабочего документа (`## Page N` минус единица). */
  readonly workingPageIndex: number;
  readonly textMd: string;
}

export interface ExportBlockText {
  readonly remoteBlockId: string;
  readonly workingPageIndex: number;
  readonly ordinal: number;
  readonly blockType: string;
  readonly contentMd: string;
}

export interface ParsedExport {
  readonly pages: readonly ExportPageText[];
  readonly blocks: readonly ExportBlockText[];
  /** Сколько строк провенанса вырезано: ноль на непустом экспорте подозрителен. */
  readonly redactedLines: number;
}

export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportFormatError';
  }
}

/**
 * Разбор `document.md` на страницы и блоки за один проход.
 *
 * Один проход, а не два независимых разбора: страницы и блоки обязаны
 * описывать ОДИН И ТОТ ЖЕ документ, и второй парсер разошёлся бы с первым в
 * трактовке границ ровно тогда, когда их рендер что-нибудь поменяет.
 */
export function parseExportMarkdown(markdown: string): ParsedExport {
  const lines = markdown.split(/\r?\n/);

  const pages: ExportPageText[] = [];
  const blocks: ExportBlockText[] = [];
  let redactedLines = 0;

  let pageIndex: number | null = null;
  let pageLines: string[] = [];
  let block: { ordinal: number; type: string; id: string; lines: string[] } | null = null;

  const flushBlock = (): void => {
    if (block === null || pageIndex === null) return;
    blocks.push({
      remoteBlockId: block.id,
      workingPageIndex: pageIndex,
      ordinal: block.ordinal,
      blockType: block.type.toLowerCase(),
      contentMd: block.lines.join('\n').trim(),
    });
    block = null;
  };

  const flushPage = (): void => {
    flushBlock();
    if (pageIndex === null) return;
    pages.push({ workingPageIndex: pageIndex, textMd: pageLines.join('\n').trim() });
    pageIndex = null;
    pageLines = [];
  };

  for (const raw of lines) {
    const pageMatch = PAGE_HEADING.exec(raw);
    if (pageMatch !== null) {
      flushPage();
      const label = Number.parseInt(pageMatch[1] ?? '', 10);
      if (!Number.isInteger(label) || label < 1) {
        throw new ExportFormatError(`Экспорт содержит недопустимый номер страницы «${raw}»`);
      }
      // `_page_label` у них — это `page_index + 1`; обратное преобразование
      // здесь единственное, и оно названо, а не размазано по вызывающим.
      pageIndex = label - 1;
      pageLines = [];
      continue;
    }

    if (pageIndex === null) continue; // шапка документа: имя, путь, штамп тома

    const blockMatch = BLOCK_HEADING.exec(raw);
    if (blockMatch !== null) {
      flushBlock();
      block = {
        ordinal: Number.parseInt(blockMatch[1] ?? '0', 10),
        type: blockMatch[2] ?? '',
        id: blockMatch[3] ?? '',
        lines: [],
      };
      continue;
    }

    if (PROVENANCE_LINE.test(raw)) {
      redactedLines += 1;
      continue;
    }

    const scrubbed = redactAbsoluteUrls(raw);
    redactedLines += scrubbed.count;
    pageLines.push(scrubbed.text);
    if (block !== null) block.lines.push(scrubbed.text);
  }
  flushPage();

  return { pages, blocks, redactedLines };
}

/** Записи архива по имени — с внятным отказом на недостающую. */
export function requireEntry(entries: ReadonlyMap<string, Buffer>, name: string): Buffer {
  const found = entries.get(name);
  if (found === undefined) {
    throw new ExportFormatError(
      `В архиве экспорта нет записи «${name}»: получено ${[...entries.keys()].join(', ') || '(ничего)'}`,
    );
  }
  return found;
}
