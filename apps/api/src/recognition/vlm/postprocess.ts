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

/** Ответ целиком обёрнут в кодовый фенс: ```json … ``` (порт _strip_code_fences). */
const FENCED_RE = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/u;

/**
 * Снять reasoning-блоки и обёртку кодовых фенсов.
 *
 * Фенс срезается только когда охватывает ВЕСЬ ответ: фенс в середине текста —
 * часть содержимого, и его вырезание исказило бы транскрипцию; вложенный JSON
 * оттуда достанет балансный скан `extractJson`.
 */
export function stripNoise(text: string): string {
  const withoutThink = text.replace(THINK_BLOCK_RE, '').trim();
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

export interface BlockValidation {
  readonly warnings: readonly string[];
  /** Код непригодности либо `null` — результат пригоден. */
  readonly invalid: string | null;
}

const VALID: BlockValidation = { warnings: [], invalid: null };

export function validateText(response: VlmTextResponse): BlockValidation {
  const warnings: string[] = [];
  if (response.fragments.length === 0) warnings.push(WARNING_EMPTY_FRAGMENTS);

  for (const fragment of response.fragments) {
    if (fragment.kind !== 'table') continue;
    const widths = new Set(fragment.rows.map((row) => row.length));
    if (widths.size > 1) {
      warnings.push(WARNING_TABLE_RAGGED_ROWS);
      break; // Один код на блок: warnings — сигнал, а не перечень таблиц.
    }
  }
  return warnings.length === 0 ? VALID : { warnings, invalid: null };
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
    return { warnings: [], invalid: INVALID_STAMP_PROSE_DOCUMENT_CODE };
  }
  return allBlank ? { warnings: [WARNING_STAMP_ALL_FIELDS_BLANK], invalid: null } : VALID;
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
