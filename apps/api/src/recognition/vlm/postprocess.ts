/**
 * Постобработка сырого ответа VLM: чистка шума, извлечение JSON, быстрые
 * валидаторы и классификация неудач (порт боевых эвристик RD WEB —
 * `providers/parser_json.py`, `pipeline/validators.py`).
 *
 * ## Warning ≠ отказ
 *
 * Валидаторы различают два сорта кодов, и это несущее различие:
 *
 * - **warning** — состояние законно, но заслуживает следа в `warnings`
 *   прогона. Пустой кроп даёт пустые `fragments` и штамп из одних `null` —
 *   это ЧЕСТНЫЙ ответ модели («смотрел и не нашёл»), а не брак; браковать его
 *   значило бы ретраить детерминированную пустоту весь бюджет попыток (боевой
 *   срез RD WEB 2026-08-10: 24 отказа = 3 пустых штампа × 8 попыток).
 * - **invalid** — результат непригоден и повтор не поможет (эвристика
 *   детерминирована): например, в `document_code` лежит проза наименования
 *   объекта вместо шифра.
 *
 * ## Граница fixable_genre / invalid
 *
 * Корректирующий повтор — платный, поэтому он разрешён ровно один раз и только
 * когда ошибка «жанровая»: модель ответила ДРУГИМ ВИДОМ вывода (проза,
 * markdown, рассуждения, layout-дамп) либо JSON-объектом без ожидаемой
 * обёртки. Такой ответ чинится довеском к system-промпту — RD WEB держит для
 * этого `output_shape`. Если же модель вернула JSON, в котором ожидаемые
 * верхнеуровневые ключи ЕСТЬ, но значения не проходят схему (чужой enum,
 * не тот тип), жанр верен и корректирующая инструкция «верни только JSON»
 * исправлять ничего не будет — это `invalid`, платить за повтор незачем.
 */
import type { ZodError } from 'zod';

import type { VlmStampResponse, VlmTextResponse } from './schemas.js';

// ---------------------------------------------------------------------------
// Чистка шума
// ---------------------------------------------------------------------------

/** Закрытые reasoning-блоки (Qwen-стиль: `<think>…</think>{json}`). */
const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/giu;

/** Открывающий тег, оставшийся без пары после снятия закрытых блоков. */
const THINK_OPEN_RE = /<think\b[^>]*>/iu;

/** Закрывающий тег без пары: шаблон чата подставил `<think>` за модель. */
const THINK_CLOSE_RE = /<\/think\s*>/giu;

/** Ответ целиком обёрнут в кодовый фенс: ```json … ``` (порт _strip_code_fences). */
const FENCED_RE = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/u;

/**
 * Снять хвост рассуждений, оставшийся без пары тегов.
 *
 * Балансный regex выше снимает только ПАРНЫЙ блок, и до перехода на Qwen этого
 * хватало. У reasoning-моделей пара распадается двумя способами, и оба
 * заканчиваются не отказом, а НЕВЕРНО прочитанным блоком:
 *
 * - шаблон чата подставляет `<think>` за модель, поэтому в `content` приезжает
 *   только закрывающий тег: `…рассуждения</think>{json}`. Балансный скан
 *   `extractJson` возьмёт ПЕРВЫЙ сбалансированный объект, а модель по дороге
 *   успевает набросать в рассуждениях черновой JSON — и в схему уходит черновик;
 * - ответ обрывается внутри незакрытого `<think>`. Обычно это ловится раньше по
 *   `finish_reason='length'`, но если шлюз причину не донёс, черновик из
 *   рассуждений опять уедет как ответ.
 *
 * Оба случая срезаются только когда ответ НЕ начинается с `{`: литеральный
 * `</think>` внутри значения JSON — это содержимое страницы, а не разметка
 * рассуждений, и трогать его нельзя.
 */
function stripUnpairedThinking(text: string): string {
  if (text.startsWith('{')) return text;

  const open = THINK_OPEN_RE.exec(text);
  if (open !== null) return text.slice(0, open.index).trim();

  let afterLastClose = -1;
  for (const match of text.matchAll(THINK_CLOSE_RE)) {
    afterLastClose = match.index + match[0].length;
  }
  return afterLastClose === -1 ? text : text.slice(afterLastClose).trim();
}

/**
 * Снять reasoning-блоки и обёртку кодовых фенсов.
 *
 * Фенс срезается только когда охватывает ВЕСЬ ответ: фенс в середине текста —
 * часть содержимого, и его вырезание исказило бы транскрипцию; вложенный JSON
 * оттуда достанет балансный скан `extractJson`.
 */
export function stripNoise(text: string): string {
  const withoutThink = stripUnpairedThinking(text.replace(THINK_BLOCK_RE, '').trim());
  const fenced = FENCED_RE.exec(withoutThink);
  return fenced === null ? withoutThink : (fenced[1] ?? '').trim();
}

// ---------------------------------------------------------------------------
// Извлечение JSON
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Извлечь JSON-объект из ответа: строгий `JSON.parse`, при синтаксической
 * неудаче — первый сбалансированный `{…}` (точный порт `_repair_json` из
 * `parser_json.py`, включая корректный проход строк с экранированием).
 *
 * Валидный JSON НЕ-объект (массив, число) чинить нельзя: это другой жанр
 * ответа (layout-дамп), и выдавать за него первый вложенный объект значило бы
 * маскировать жанровую ошибку под результат — та же логика, что у референса.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const candidate = text.trim();
  if (candidate === '') return null;

  try {
    const parsed: unknown = JSON.parse(candidate);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // Синтаксис сломан — пробуем достать первый сбалансированный объект.
  }

  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(candidate.slice(start, i + 1));
          return isPlainObject(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Быстрые валидаторы
// ---------------------------------------------------------------------------

/** Пустой кроп законен; след в warnings нужен статистике прогона. */
export const WARNING_EMPTY_FRAGMENTS = 'empty_fragments';
/** Строки таблицы разной ширины: рендер выровняет пустыми ячейками, но сигнал ценен. */
export const WARNING_TABLE_RAGGED_ROWS = 'table_ragged_rows';
/** Все поля штампа пусты — законно для пустого/нечитаемого кропа. */
export const WARNING_STAMP_ALL_FIELDS_BLANK = 'stamp_all_fields_blank';
/** В document_code — проза наименования/адреса вместо шифра: результат непригоден. */
export const INVALID_STAMP_PROSE_DOCUMENT_CODE = 'stamp_prose_document_code';

/**
 * Табличный фрагмент без единой строки и без шапки — лечится повтором.
 *
 * Модель объявила, что видит сетку, и не выписала из неё ничего. Ни то ни
 * другое по отдельности дефектом не является: пустой кроп даёт пустые
 * `fragments`, а бланк с напечатанной, но незаполненной шапкой — таблицу с
 * `header` и нулём строк. Дефект — именно связка «сетка есть, содержимого нет
 * вовсе»: промпт требует переносить каждую видимую строку.
 *
 * Цена молчания здесь максимальная: на боевой папке так потерялись три
 * страницы описи передачи (сорок строк перечня) и пять учётных листов ЖАН —
 * страницы остались без текста, не отнеслись ни к одному документу и утащили
 * за собой сверку реестра. При этом `finish_reason` был `stop`, то есть ни
 * один существующий сторож такой ответ не видел.
 *
 * Не `invalid`: `invalid` в этом файле означает «повтор не поможет», а здесь
 * поможет — довесок к промпту адресует ровно это умолчание. Поэтому код живёт
 * в третьей категории, между warning и отказом.
 */
export const RETRYABLE_TABLE_EMPTY_ROWS = 'table_empty_rows';

export interface BlockValidation {
  readonly warnings: readonly string[];
  /** Код непригодности либо `null` — результат пригоден. */
  readonly invalid: string | null;
  /**
   * Код дефекта, который чинится ОДНИМ корректирующим повтором.
   *
   * После повтора результат принимается как есть, а код уходит в `warnings`:
   * упрямая пустота — всё ещё ответ модели, и ронять из-за неё страницу (а с
   * ней и прогон в строгом режиме) значило бы менять потерю одного блока на
   * потерю всех.
   */
  readonly retryable: string | null;
}

const VALID: BlockValidation = { warnings: [], invalid: null, retryable: null };

export function validateText(response: VlmTextResponse): BlockValidation {
  const warnings: string[] = [];
  if (response.fragments.length === 0) warnings.push(WARNING_EMPTY_FRAGMENTS);

  // Флагами, а не выходом из цикла: кодов на блок по-прежнему по одному
  // (warnings — сигнал, а не перечень таблиц), но искать надо оба.
  let ragged = false;
  let emptyGrid = false;
  for (const fragment of response.fragments) {
    if (fragment.kind !== 'table') continue;
    if (fragment.rows.length === 0 && (fragment.header === null || fragment.header.length === 0)) {
      emptyGrid = true;
    }
    const widths = new Set(fragment.rows.map((row) => row.length));
    if (widths.size > 1) ragged = true;
  }
  if (ragged) warnings.push(WARNING_TABLE_RAGGED_ROWS);

  return {
    warnings,
    invalid: null,
    retryable: emptyGrid ? RETRYABLE_TABLE_EMPTY_ROWS : null,
  };
}

function blank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

// Шифр из графы «Обозначение» — компактный код; наименование объекта/адрес —
// проза: длинные строчные русские слова. Пороги — боевые значения RD WEB.
const DOCUMENT_CODE_MAX_LEN = 160;
const DOCUMENT_CODE_PROSE_LEN = 60;
const DOCUMENT_CODE_PROSE_WORDS = 6;

/**
 * Аналог `\b[а-яё]{5,}\b` Python. В JS `\b` знает только ASCII-словные
 * символы, поэтому юникод-граница выражена lookaround'ами по `\p{L}\p{N}_`.
 */
const LOWERCASE_RU_WORD_RE = /(?<![\p{L}\p{N}_])[а-яё]{5,}(?![\p{L}\p{N}_])/gu;

function looksLikeProseCode(code: string): boolean {
  if (code.length > DOCUMENT_CODE_MAX_LEN) return true;
  const words = code.split(/\s+/u).filter((word) => word !== '');
  return (
    code.length > DOCUMENT_CODE_PROSE_LEN &&
    words.length > DOCUMENT_CODE_PROSE_WORDS &&
    [...code.matchAll(LOWERCASE_RU_WORD_RE)].length >= 3
  );
}

export function validateStamp(response: VlmStampResponse): BlockValidation {
  const scalars = [
    response.document_code,
    response.project_name,
    response.sheet_name,
    response.stage,
    response.sheet_number,
    response.total_sheets,
    response.organization,
  ];
  const allBlank =
    scalars.every(blank) && response.signatures.length === 0 && response.revisions.length === 0;

  const code = (response.document_code ?? '').trim();
  if (code !== '' && looksLikeProseCode(code)) {
    return { warnings: [], invalid: INVALID_STAMP_PROSE_DOCUMENT_CODE, retryable: null };
  }
  return allBlank
    ? { warnings: [WARNING_STAMP_ALL_FIELDS_BLANK], invalid: null, retryable: null }
    : VALID;
}

// ---------------------------------------------------------------------------
// Классификация неудачи разбора
// ---------------------------------------------------------------------------

export type FailureClass = 'fixable_genre' | 'invalid';

/**
 * По какой причине ответ не разобрался — см. «Граница fixable_genre / invalid»
 * в шапке файла. Признак «обёртка отсутствует» вычисляется из ошибок zod:
 * issue, чей верхнеуровневый путь указывает на ключ, которого в разобранном
 * объекте НЕТ, означает пропущенное обязательное поле схемы — модель отвечала
 * на другой контракт.
 */
export function classifyFailure(rawText: string, zodError: ZodError | null): FailureClass {
  const parsed = extractJson(stripNoise(rawText));
  if (parsed === null) return 'fixable_genre';
  if (zodError !== null) {
    for (const issue of zodError.issues) {
      const head = issue.path[0];
      if (typeof head === 'string' && !(head in parsed)) return 'fixable_genre';
    }
  }
  return 'invalid';
}

// ---------------------------------------------------------------------------
// Корректирующая инструкция (второй платный вызов)
// ---------------------------------------------------------------------------

/**
 * Довесок к system-промпту корректирующего повтора — в духе RD WEB
 * `output_shape`: коротко, императивно, по-английски (как весь system).
 * Добавляется через `system + '\n\n' + CORRECTIVE_INSTRUCTION[type]`.
 */
export const CORRECTIVE_INSTRUCTION: Record<'text' | 'image' | 'stamp', string> = {
  text: 'CRITICAL — the previous attempt returned the wrong kind of answer. Return ONLY one JSON object matching the provided response_format schema: {"fragments": [...]}, where every item carries "kind" ("paragraph", "heading" or "table") together with the keys "text", "emphasis", "level", "title", "header" and "rows", and every key that does not apply to that kind is null. No prose, no Markdown, no fences, no explanations — nothing outside the JSON object.',
  image:
    'CRITICAL — the previous attempt returned the wrong kind of answer. Return ONLY one JSON object matching the provided response_format schema, with every schema field present. No prose, no Markdown, no fences, no explanations — nothing outside the JSON object.',
  stamp:
    'CRITICAL — the previous attempt returned the wrong kind of answer. Return ONLY one JSON object matching the provided response_format schema, with every field present: null for unread scalar fields, [] for absent signature/revision rows. No prose, no Markdown, no fences, no explanations — nothing outside the JSON object.',
};

/**
 * Довесок повтора по коду `retryable` — в отличие от `CORRECTIVE_INSTRUCTION`,
 * жанр ответа здесь верен, и говорить «вернул не тот вид ответа» было бы
 * неправдой: модель ответила по схеме и промолчала о содержимом сетки.
 *
 * Ключ — код дефекта, а не тип блока: пустая сетка бывает только у текстового
 * блока, а следующий такой дефект придёт со своей причиной и своим текстом.
 */
export const RETRY_INSTRUCTION: Record<string, string> = {
  [RETRYABLE_TABLE_EMPTY_ROWS]:
    'CRITICAL — the previous attempt reported a table with an empty "rows" list. ' +
    'A visible table grid always has content: transcribe EVERY visible data row ' +
    'into "rows", each as an array of cell strings in column order, and put the ' +
    'visible header row into "header". If the grid is genuinely empty of data, ' +
    'return the header alone; if what you see is not a table at all, return the ' +
    'text as "paragraph" fragments instead. Do not answer with an empty "rows" ' +
    'for a grid you can see. Return ONLY one JSON object matching the provided ' +
    'response_format schema.',
};

// ---------------------------------------------------------------------------
// Закрывающая инструкция последнего круга дозапроса (S28)
// ---------------------------------------------------------------------------

/**
 * Довесок к system-промпту вызова, в котором инструмент уже запрещён
 * (`tool_choice: none`).
 *
 * Одна строка на все три типа блока: причина запрета от типа не зависит —
 * круги кропа кончились, и модель обязана ответить по тому, что видит. Без
 * этой инструкции запрет выглядел бы для неё сбоем инструмента, а не
 * последним словом: молчание вместо ответа — ровно то, чем закончился прогон,
 * из-за которого правило и появилось.
 *
 * Требование «нечитаемое отражай как есть» существенно: без него модель
 * восстанавливает обрезанный текст по смыслу, а ADR-0007 это прямо запрещает.
 */
export const NO_MORE_CROPS_INSTRUCTION =
  'FINAL ANSWER REQUIRED — no further page regions will be provided, and the ' +
  'crop tool is disabled for this turn. Answer from what is already visible in ' +
  'the images you have. Transcribe only what you can actually read: leave a ' +
  'field null or a fragment out rather than reconstructing it from context or ' +
  'from domain knowledge. Return ONLY one JSON object matching the provided ' +
  'response_format schema — no prose, no Markdown, no fences, no explanations.';
