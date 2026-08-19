/**
 * Адаптер legacy-формата RD WEB: markdown (+ необязательный `blocks.json`) →
 * канонический RecognitionResult v2.
 *
 * ## Что здесь гарантируется
 *
 * * `page.text` — ДОСЛОВНО тот же текст страницы, который сегодня получает
 *   конвейер (строки страницы без заголовков блоков и служебных `> **…`,
 *   `\n{3,}` схлопнуты, края обрезаны). Байт-идентичность — по построению,
 *   офсеты и цитаты не сдвигаются.
 * * Подписанные URL (`crop_url`, ссылки `> **Crop:**`) в канонический результат
 *   НЕ попадают — §11 считает их секретом, и схема это дополнительно держит
 *   `superRefine`-ом.
 * * Страница, которой нет в markdown: с блоками кроме штампов — ошибка
 *   («экспорт усечён»), без них — законная пустая страница. Страница markdown,
 *   которой нет в `blocks.json`, — ошибка. Это те же fail-closed правила, что
 *   выработаны на корпусе temp/MD.
 *
 * ## Ограничение сопоставления штампов
 *
 * Markdown не связывает строку `> **Stamp:** …` с конкретным stamp-блоком:
 * строки разобраны по СТРАНИЦЕ и раздаются stamp-блокам страницы по порядку.
 * При одном штампе на страницу (подавляющий случай корпуса) сопоставление
 * точное; при нескольких — приближённое, и это документированное ограничение
 * формата-источника, а не адаптера.
 */
import {
  RECOGNITION_RESULT_SCHEMA_VERSION,
  type RecognitionBlock,
  type RecognitionPage,
  type RecognitionResult,
} from '../schema.js';

export const RDWEB_MD_ADAPTER_VERSION = 'rdweb-md.v1';

const PAGE_HEADING = /^## Page (\d+)\s*$/u;
const BLOCK_HEADING = /^### BLOCK #(\d+) \[([A-Z]+)\]: (\S+)\s*$/u;
const PROVENANCE_LINE = /^> \*\*/u;
const STAMP_LINE = /^> \*\*Stamp:\*\*\s*(.+)$/u;
const DOC_STAMP_LINE = /^\*\*Stamp:\*\*\s*(.+)$/u;

// ---------------------------------------------------------------------------
// blocks.json (schema_version 1)
// ---------------------------------------------------------------------------

interface BlocksJson {
  readonly generated_at?: string;
  readonly pages?: readonly {
    page_index: number;
    width_px: number;
    height_px: number;
    rotation: number;
  }[];
  readonly blocks?: readonly {
    block_id?: string;
    ordinal: number | null;
    page_index: number;
    block_type: string;
    coords_norm?: readonly number[] | null;
  }[];
}

// ---------------------------------------------------------------------------
// Разбор markdown
// ---------------------------------------------------------------------------

interface MdBlock {
  readonly ordinal: number;
  readonly blockType: 'text' | 'image';
  readonly remoteId: string;
  readonly lines: string[];
}

interface MdPage {
  /** Строки текста страницы: без заголовков блоков и провенанса. */
  readonly textLines: string[];
  readonly blocks: MdBlock[];
  /** Разобранные строки `> **Stamp:** …` этой страницы, по порядку. */
  readonly stampLines: string[];
}

function collapse(lines: readonly string[]): string {
  return lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function parseMarkdown(markdown: string): {
  readonly pages: ReadonlyMap<number, MdPage>;
  readonly docStamp: string | null;
} {
  const pages = new Map<number, MdPage>();
  let current: MdPage | null = null;
  let currentBlock: MdBlock | null = null;
  let docStamp: string | null = null;

  for (const line of markdown.split('\n')) {
    const pageHeading = PAGE_HEADING.exec(line);
    if (pageHeading !== null) {
      const label = Number(pageHeading[1]);
      if (pages.has(label)) throw new Error(`страница ${label} встречается в markdown дважды`);
      current = { textLines: [], blocks: [], stampLines: [] };
      currentBlock = null;
      pages.set(label, current);
      continue;
    }
    if (current === null) {
      const doc = DOC_STAMP_LINE.exec(line);
      if (doc !== null) docStamp = (doc[1] ?? '').trim();
      continue;
    }

    const blockHeading = BLOCK_HEADING.exec(line);
    if (blockHeading !== null) {
      const kind = blockHeading[2] === 'IMAGE' ? 'image' : 'text';
      currentBlock = {
        ordinal: Number(blockHeading[1]),
        blockType: kind,
        remoteId: blockHeading[3] ?? '',
        lines: [],
      };
      current.blocks.push(currentBlock);
      continue;
    }

    if (PROVENANCE_LINE.test(line)) {
      const stamp = STAMP_LINE.exec(line);
      if (stamp !== null) current.stampLines.push((stamp[1] ?? '').trim());
      continue;
    }

    current.textLines.push(line);
    currentBlock?.lines.push(line);
  }

  return { pages, docStamp };
}

// ---------------------------------------------------------------------------
// Поля штампа и IMAGE-секции
// ---------------------------------------------------------------------------

const STAMP_KEYS: ReadonlyMap<string, string> = new Map([
  ['code', 'code'],
  ['stage', 'stage'],
  ['sheet', 'sheet'],
  ['object', 'object'],
  ['name', 'name'],
  ['organization', 'organization'],
  ['revisions', 'revisions'],
]);

type StampFields = {
  code: string | null;
  stage: string | null;
  sheet: string | null;
  object: string | null;
  name: string | null;
  organization: string | null;
  revisions: string | null;
  extra: Record<string, string>;
};

/** `Code: ИД-01 | Stage: ИД | Object: …` → поля штампа. */
export function parseStampLine(line: string): StampFields {
  const fields: StampFields = {
    code: null,
    stage: null,
    sheet: null,
    object: null,
    name: null,
    organization: null,
    revisions: null,
    extra: {},
  };
  for (const part of line.split('|')) {
    const separator = part.indexOf(':');
    if (separator < 0) continue;
    const rawKey = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (rawKey === '' || value === '') continue;
    const key = STAMP_KEYS.get(rawKey.toLowerCase());
    if (key === undefined) fields.extra[rawKey] = value;
    else fields[key as Exclude<keyof StampFields, 'extra'>] = value;
  }
  return fields;
}

const IMAGE_HEAD = /^\*\*\[IMAGE\]\*\*\s*(.*)$/u;
const IMAGE_SECTION = /^\*\*(Summary|Description|Entities|Verification):\*\*\s*(.*)$/u;

type ImageFields = RecognitionBlock extends infer B
  ? B extends { blockType: 'image'; image: infer I }
    ? I
    : never
  : never;

/** Тело IMAGE-блока → структурные поля. Нераспознанное остаётся null. */
export function parseImageContent(lines: readonly string[]): ImageFields {
  const image: ImageFields = {
    imageType: null,
    axes: null,
    zone: null,
    level: null,
    summary: null,
    description: null,
    entities: [],
    verification: null,
  };

  let section: 'summary' | 'description' | 'verification' | null = null;
  const sectionLines: Record<'summary' | 'description' | 'verification', string[]> = {
    summary: [],
    description: [],
    verification: [],
  };

  for (const line of lines) {
    const head = IMAGE_HEAD.exec(line);
    if (head !== null) {
      for (const part of (head[1] ?? '').split('|')) {
        const separator = part.indexOf(':');
        if (separator < 0) continue;
        const key = part.slice(0, separator).trim().toLowerCase();
        const value = part.slice(separator + 1).trim();
        if (value === '') continue;
        if (key === 'type') image.imageType = value;
        else if (key === 'axes') image.axes = value;
        else if (key === 'zone') image.zone = value;
        else if (key === 'level') image.level = value;
      }
      section = null;
      continue;
    }

    const sectionHead = IMAGE_SECTION.exec(line);
    if (sectionHead !== null) {
      const name = (sectionHead[1] ?? '').toLowerCase();
      const rest = sectionHead[2] ?? '';
      if (name === 'entities') {
        image.entities = rest
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '');
        section = null;
      } else {
        section = name as 'summary' | 'description' | 'verification';
        if (rest !== '') sectionLines[section].push(rest);
      }
      continue;
    }

    if (section !== null && line.trim() !== '') sectionLines[section].push(line);
  }

  const joined = (key: 'summary' | 'description' | 'verification'): string | null => {
    const text = sectionLines[key].join('\n').trim();
    return text === '' ? null : text;
  };
  image.summary = joined('summary');
  image.description = joined('description');
  image.verification = joined('verification');
  return image;
}

// ---------------------------------------------------------------------------
// Сборка канонического результата
// ---------------------------------------------------------------------------

const BLOCK_TYPES: readonly string[] = ['text', 'image', 'stamp'];

export function canonicalFromArchiveEntries(
  markdown: string,
  blocksJson?: string | null,
): RecognitionResult {
  const { pages: mdPages, docStamp } = parseMarkdown(markdown);
  const parsed: BlocksJson =
    blocksJson == null || blocksJson === '' ? {} : (JSON.parse(blocksJson) as BlocksJson);
  const geometry = parsed.pages ?? [];
  const jsonBlocks = (parsed.blocks ?? []).filter((block) =>
    BLOCK_TYPES.includes(block.block_type),
  );

  const warnings: string[] = [];
  const pages: RecognitionPage[] = [];

  if (geometry.length === 0) {
    // Без blocks.json (форма архива job'а RD WEB): страницы и блоки — только
    // из markdown, геометрии и штампов нет.
    for (const [label, mdPage] of [...mdPages.entries()].sort((a, b) => a[0] - b[0])) {
      pages.push(buildPage(label - 1, null, mdPage, [], docStamp, warnings));
    }
  } else {
    const known = new Set(geometry.map((page) => page.page_index + 1));
    for (const label of mdPages.keys()) {
      if (!known.has(label)) {
        throw new Error(`в markdown есть страница ${label}, которой нет в blocks.json`);
      }
    }
    for (const page of geometry) {
      const label = page.page_index + 1;
      const mdPage = mdPages.get(label);
      const pageBlocks = jsonBlocks.filter((block) => block.page_index === page.page_index);
      if (mdPage === undefined) {
        const rendered = pageBlocks.filter((block) => block.block_type !== 'stamp');
        if (rendered.length > 0) {
          throw new Error(
            `страница ${label} с ${rendered.length} блоками отсутствует в markdown — экспорт усечён`,
          );
        }
      }
      pages.push(
        buildPage(
          page.page_index,
          page,
          mdPage ?? { textLines: [], blocks: [], stampLines: [] },
          pageBlocks,
          docStamp,
          warnings,
        ),
      );
    }
  }

  return {
    schemaVersion: RECOGNITION_RESULT_SCHEMA_VERSION,
    source: {
      provider: 'rdweb_md',
      adapterVersion: RDWEB_MD_ADAPTER_VERSION,
      modelId: null,
      generatedAt: parsed.generated_at ?? null,
    },
    pages,
    warnings,
  };
}

function buildPage(
  workingPageIndex: number,
  geometry: { width_px: number; height_px: number; rotation: number } | null,
  mdPage: MdPage,
  jsonBlocks: readonly NonNullable<BlocksJson['blocks']>[number][],
  docStamp: string | null,
  warnings: string[],
): RecognitionPage {
  const jsonByOrdinal = new Map(
    jsonBlocks.filter((block) => block.ordinal !== null).map((block) => [block.ordinal, block]),
  );

  const blocks: RecognitionBlock[] = [];

  for (const mdBlock of mdPage.blocks) {
    const json = jsonByOrdinal.get(mdBlock.ordinal);
    const base = {
      blockId: json?.block_id ?? mdBlock.remoteId,
      layoutBlockId: null,
      ordinal: mdBlock.ordinal,
      coordsNorm: toCoords(json?.coords_norm),
      confidence: null,
      modelId: null,
    };
    if (mdBlock.blockType === 'image') {
      blocks.push({
        ...base,
        blockType: 'image',
        image: parseImageContent(mdBlock.lines),
        features: null,
      });
    } else {
      blocks.push({
        ...base,
        blockType: 'text',
        text: collapse(mdBlock.lines),
        fragments: null,
        features: null,
      });
    }
  }

  // Штампы приходят только из blocks.json: собственных секций в markdown у
  // них нет. Разобранные строки `> **Stamp:**` раздаются по порядку; лишним
  // источником служит документный `**Stamp:**` (см. шапку файла).
  const stampBlocks = jsonBlocks.filter((block) => block.block_type === 'stamp');
  const stampSources = [...mdPage.stampLines];
  if (stampSources.length < stampBlocks.length && docStamp !== null) stampSources.push(docStamp);
  stampBlocks.forEach((json, index) => {
    const source = stampSources[index] ?? null;
    blocks.push({
      blockId: json.block_id ?? null,
      layoutBlockId: null,
      ordinal: json.ordinal,
      coordsNorm: toCoords(json.coords_norm),
      confidence: null,
      modelId: null,
      blockType: 'stamp',
      stamp:
        source === null
          ? {
              code: null,
              stage: null,
              sheet: null,
              object: null,
              name: null,
              organization: null,
              revisions: null,
              extra: {},
            }
          : parseStampLine(source),
    });
  });
  if (mdPage.stampLines.length > stampBlocks.length) {
    warnings.push(
      `страница ${workingPageIndex + 1}: строк штампов ${mdPage.stampLines.length}, ` +
        `stamp-блоков ${stampBlocks.length} — лишние строки отброшены`,
    );
  }

  return {
    workingPageIndex,
    rotation: geometry?.rotation ?? 0,
    widthPx: geometry?.width_px ?? null,
    heightPx: geometry?.height_px ?? null,
    text: collapse(mdPage.textLines),
    blocks,
  };
}

function toCoords(
  coords: readonly number[] | null | undefined,
): [number, number, number, number] | null {
  if (coords == null || coords.length !== 4) return null;
  const [x0, y0, x1, y1] = coords;
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return null;
  return [x0, y0, x1, y1];
}
