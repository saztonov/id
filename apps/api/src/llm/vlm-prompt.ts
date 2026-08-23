/**
 * Канонизация эффективного входа VLM (ADR-0007): что именно хэшируется в
 * `input_hash` вызова распознавания.
 *
 * ## Почему у VLM своя канонизация, а не расширение `ID-LLM-PROMPT/1`
 *
 * Текстовая канонизация (`prompt.ts`) — часть контракта записанных ответов и
 * строк `ai_runs` текстовых стадий: её формат менять нельзя, не обесценив все
 * существующие записи. У VLM-вызова другой состав входа — картинки, строгая
 * схема ответа и generation-профиль (температура, лимит токенов, top_k),
 * которых у текстового пути нет и которые МЕНЯЮТ ответ модели. Впихнуть их в
 * старый формат значило бы либо сломать его версию, либо оставить вне хэша
 * то, от чего зависит результат, — и кэш выдавал бы ответ «тёплой» модели за
 * ответ детерминированной. Поэтому отдельный формат с отдельной версией.
 *
 * ## Почему в канонизацию входят ХЭШИ картинок, а не сами байты
 *
 * Кроп страницы — мегабайты PNG. Складывать их в каноническую строку означало
 * бы держать в памяти вторую копию каждого кропа и гонять sha256 по удвоенному
 * объёму. Хэш байтов несёт ровно ту же различающую силу: другой кроп — другой
 * хэш — другой `input_hash`. По той же причине кэш ответов хранит только текст
 * ответа, а не изображения: повторный ВЫЗОВ приносит кропы с собой.
 *
 * ## Почему схема ответа хэшируется канонизированной
 *
 * `responseFormat.schema` — это объект, собранный из zod-описания. Порядок
 * ключей в нём — деталь реализации сборки, а не смысл схемы: пересборка тех же
 * полей в другом порядке не меняет ни валидацию, ни ответ модели, и не должна
 * менять `input_hash`. Поэтому JSON сортируется по ключам рекурсивно; порядок
 * элементов МАССИВОВ при этом значим (например, `required`) и сохраняется.
 *
 * ## Версия 2: инструменты и круги диалога (ADR-0013, S21)
 *
 * Модель научилась просить дополнительный кроп, и вызов перестал быть одним
 * обменом. В канонизацию вошли объявленные инструменты и все состоявшиеся
 * круги «запросила — дали». Без этого второй круг давал бы ТОТ ЖЕ `input_hash`,
 * что первый, — а на нём висят и LRU-кэш ответов, и `X-Idempotency-Key` шлюза:
 * модель получила бы в ответ собственный прежний запрос кропа, и цикл не
 * сошёлся бы никогда, оплачиваясь на каждом круге.
 *
 * Версия поднята, а не «добавлены строки при наличии инструментов»: формат
 * входа изменился, и правило этого файла — версионировать изменение формата, а
 * не его наблюдаемость на частном случае. Цена — несравнимость новых хэшей со
 * старыми, и она осознанна: это ровно то, что версия и означает.
 */
import type { VlmRequest, VlmToolExchange } from './vlm-port.js';
import { normalizeNewlines, sha256Hex } from './prompt.js';

/**
 * Версия канонизации VLM-входа. Меняется при любой правке формата ниже —
 * независимо от `EFFECTIVE_PROMPT_VERSION` текстового пути: они версионируют
 * разные контракты.
 */
export const VLM_PROMPT_CANON_VERSION = 2;

const HEADER = `ID-VLM-PROMPT/${VLM_PROMPT_CANON_VERSION}`;
const SYSTEM_MARK = '--SYSTEM--';
const USER_MARK = '--USER--';
const END_MARK = '--END--';

/**
 * Детерминированная сериализация JSON: ключи объектов сортируются рекурсивно,
 * порядок массивов сохраняется, свойства со значением `undefined` опускаются —
 * так же, как их опустил бы `JSON.stringify` при отправке.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // `JSON.stringify(undefined)` возвращает `undefined`; в JSON-документе на
    // этом месте оказался бы `null` — каноническая форма обязана совпадать с
    // тем, что реально уехало бы по сети.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * Каноническая строка VLM-вызова. Её sha256 — `input_hash` (`vlmInputHash`).
 *
 * Порядок полей фиксирован здесь и нигде не повторяется. Длины частей в `len`
 * — по той же причине, что в текстовом формате: разделители могут встретиться
 * внутри промта, и без длин перенос текста между частями давал бы ту же строку.
 * `topK=` с пустым значением означает «не задан» — ни одно число так не
 * отрисуется, поэтому отсутствие отличимо от любого значения, включая ноль.
 */
export function buildVlmCanonicalInput(request: VlmRequest): string {
  const system = normalizeNewlines(request.systemPrompt);
  const user = normalizeNewlines(request.userPrompt);
  const imageHashes = request.images.map((image) => sha256Hex(image.png));
  const schemaHash = sha256Hex(canonicalJson(request.responseFormat.schema));
  const tools = request.tools ?? [];
  const exchanges = request.exchanges ?? [];

  return [
    HEADER,
    `prompt=${request.promptCode}@${request.promptVersion}`,
    `schema=${request.schemaVersion}`,
    `model=${request.model}`,
    `temperature=${request.temperature}`,
    `maxTokens=${request.maxTokens}`,
    `topK=${request.topK ?? ''}`,
    `responseSchema=${schemaHash}`,
    // Счётчик перед списком: хэш картинки — фиксированные 64 символа, но само
    // число картинок тоже различает вызовы, и явное `images=0` не даёт пустому
    // списку слиться со следующим полем.
    `images=${imageHashes.length}`,
    ...imageHashes.map((hash, index) => `image[${index}]=${hash}`),
    // Инструменты входят объявлением целиком: изменившееся описание меняет
    // поведение модели так же, как изменившийся промт.
    `tools=${tools.length}`,
    ...tools.map(
      (tool, index) =>
        `tool[${index}]=${tool.name}:${sha256Hex(
          canonicalJson({ description: tool.description, parameters: tool.parameters }),
        )}`,
    ),
    `exchanges=${exchanges.length}`,
    ...exchanges.flatMap((exchange, index) => canonicalExchange(exchange, index)),
    `len=${system.length},${user.length}`,
    SYSTEM_MARK,
    system,
    USER_MARK,
    user,
    END_MARK,
  ].join('\n');
}

/**
 * sha256 канонического входа — `ai_runs.input_hash` VLM-вызова, ключ LRU-кэша
 * ответов и ключ записей офлайн-двойника (`vlm-recorded.ts`).
 */
export function vlmInputHash(request: VlmRequest): string {
  return sha256Hex(buildVlmCanonicalInput(request));
}

/**
 * Один круг диалога в канонической форме.
 *
 * Аргументы вызова хэшируются канонизированным JSON, а не строкой как есть:
 * модель вправе прислать те же параметры с другим порядком ключей или иными
 * пробелами, и такой ответ — тот же запрос, а не новый.
 */
function canonicalExchange(exchange: VlmToolExchange, index: number): readonly string[] {
  const calls = exchange.calls.map(
    (call, i) =>
      `exchange[${index}].call[${i}]=${call.name}:${sha256Hex(
        canonicalJson(parseArgumentsForHash(call.argumentsJson)),
      )}`,
  );
  const results = exchange.results.map((result, i) => {
    const images = result.images.map((image) => sha256Hex(image.png)).join(',');
    return `exchange[${index}].result[${i}]=${sha256Hex(result.text)}:${images}`;
  });
  return [...calls, ...results];
}

/**
 * Аргументы вызова для хэширования.
 *
 * Неразобравшийся JSON хэшируется как СТРОКА: аргументы приходят от модели, и
 * «не разобралось» — законное состояние, которое обязано различать разные
 * неразобравшиеся строки, а не сливать их в одно значение.
 */
function parseArgumentsForHash(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}
