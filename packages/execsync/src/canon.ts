/**
 * Каноническая проекция снимка и `manifest_sha256` (§13, канон `rd.execsync.canon.v1`).
 *
 * Пять правил контракта реализованы дословно:
 *
 *   1. числа геометрии рендерятся строкой с шестью знаками (`fixed6`), `-0.0`
 *      даёт `0.000000`;
 *   2. `null`-поля удаляются — отсутствующее тождественно явному `null`;
 *   3. блоки сортируются по `external_block_id` (снимок это множество);
 *   4. строки нормализуются в NFC;
 *   5. JSON компактный, ключи отсортированы, не-ASCII не экранируется.
 *
 * ## Почему текст собирается вручную, а не `JSON.stringify(объект)`
 *
 * Из-за порядка ключей. V8 перечисляет «целочисленные» ключи первыми и по
 * возрастанию, независимо от порядка вставки:
 *
 *   JSON.stringify({'10': 1, '9': 2, 'b': 3, 'a': 4})  →  {"9":2,"10":1,"b":3,"a":4}
 *   json.dumps({'10': 1, '9': 2}, sort_keys=True)      →  {"10": 1, "9": 2}
 *
 * То есть приём «пересобрать объект с отсортированными ключами и позвать
 * `JSON.stringify`» ломается ровно на `metadata` с числовыми ключами — и ломается
 * молча. Ключи печатает эта функция, а не движок.
 *
 * ## Почему ключи сортируются по байтам UTF-8
 *
 * `Array.prototype.sort()` сравнивает строки по кодовым единицам UTF-16, и на
 * суррогатных парах это расходится с порядком кодовых точек, по которому
 * сортирует Python (`['＀','😀'].sort()` в JS даёт `['😀','＀']`). Порядок байтов
 * UTF-8 тождественен порядку кодовых точек, поэтому сравнение идёт по ним. Тем же
 * компаратором сортируются блоки: идентификаторы у нас ASCII, но правило не
 * должно зависеть от везения.
 *
 * ## Почему NFC применяется и к ключам, и ДО сортировки
 *
 * §13 говорит только «строки нормализуются в NFC», не уточняя, считаются ли
 * ключи строками. Уточняет их собственный код: в `contracts/agent_protocol/v1/
 * hashing.py` соседнего контракта функция `_nfc` нормализует ключи наравне со
 * значениями. Порядок операций при этом не косметика: отсортировав ДО
 * нормализации, мы посчитали бы порядок по одним байтам, а напечатали по другим.
 *
 * Расхождение с их реализацией здесь возможно и вынесено вопросом команде; до
 * ответа поведение зафиксировано тестом, а не догадкой в коде.
 */
import { createHash } from 'node:crypto';

import { fixed6 } from './fixed6.js';
import {
  assertHashSafeMetadata,
  assertWellFormed,
  ExecSyncCanonError,
  requireSafeInteger,
} from './safety.js';
import {
  execSyncSnapshotBodySchema,
  type ExecSyncBlock,
  type ExecSyncMetadataValue,
  type ExecSyncSnapshotBody,
  type ExecSyncSnapshotEnvelope,
} from './wire.js';

/**
 * Значение канонической проекции.
 *
 * `null` в тип НЕ входит: правило 2 удаляет `null`-члены объектов, а внутри
 * массивов их запрещает предполёт `metadata`. Тип выражает это, чтобы
 * сериализатору не пришлось решать вопрос, ответа на который в контракте нет.
 */
export type CanonValue =
  string | number | boolean | readonly CanonValue[] | { readonly [key: string]: CanonValue };

/** NFC для строки + проверка отсутствия одиночных суррогатов. */
function text(value: string, where: string): string {
  assertWellFormed(value, where);
  return value.normalize('NFC');
}

/** Сравнение по байтам UTF-8 = сравнение по кодовым точкам (см. шапку). */
export function compareCanonKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Каноническая форма `metadata`: NFC ключей и значений, удаление `null`,
 * проверка чисел. Единственное место проекции, где структура не известна
 * заранее, — потому и единственное, где обход рекурсивный.
 */
function canonMetadata(value: ExecSyncMetadataValue, where: string): CanonValue | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return text(value, where);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return requireSafeInteger(value, where);
  if (Array.isArray(value)) {
    // `null` внутри массива не удаляется: длина массива — это данные, и
    // выбросив элемент, мы изменили бы смысл, а не форму. Предполёт такие
    // значения запрещает заранее, поэтому сюда они не доходят.
    return value.map((item, index) => {
      const canonical = canonMetadata(item, `${where}[${String(index)}]`);
      if (canonical === undefined) {
        throw new ExecSyncCanonError(`${where}[${String(index)}]: null внутри массива metadata`);
      }
      return canonical;
    });
  }

  const source = value as { readonly [key: string]: ExecSyncMetadataValue };
  const result: Record<string, CanonValue> = {};
  for (const [key, item] of Object.entries(source)) {
    const canonicalKey = text(key, `${where}.<ключ>`);
    const canonicalValue = canonMetadata(item, `${where}.${canonicalKey}`);
    if (canonicalValue === undefined) continue;
    if (Object.hasOwn(result, canonicalKey)) {
      // После NFC два разных ключа могут схлопнуться в один. Молча взять
      // последний означало бы потерять данные так, что этого никто не заметит.
      throw new ExecSyncCanonError(
        `${where}: ключи metadata схлопнулись после NFC в «${canonicalKey}»`,
      );
    }
    result[canonicalKey] = canonicalValue;
  }
  return result;
}

/**
 * Проекция блока — поле за полем, а не обходом «найти все числа».
 *
 * Явное перечисление стоит десяти строк и отвечает на вопрос «что считается
 * числом геометрии» в одном месте. Обход по типу значения отвечал бы на него
 * везде и по-разному: завтрашнее числовое поле контракта молча попало бы под
 * `%.6f` и разошлось бы с их стороной, где оно осталось бы целым.
 */
function canonBlock(block: ExecSyncBlock): CanonValue {
  const where = `blocks.${block.external_block_id}`;
  const result: Record<string, CanonValue> = {
    external_block_id: text(block.external_block_id, `${where}.external_block_id`),
    revision: requireSafeInteger(block.revision, `${where}.revision`),
    page_index: requireSafeInteger(block.page_index, `${where}.page_index`),
    block_type: block.block_type,
    shape_type: block.shape_type,
    coords_norm: block.coords_norm.map((value) => fixed6(value)),
    sort_order: requireSafeInteger(block.sort_order, `${where}.sort_order`),
    force_reprocess: block.force_reprocess,
    metadata: canonMetadata(block.metadata, `${where}.metadata`) ?? {},
  };

  // Правило 2: `null` не печатается вовсе — отсутствующее ≡ явный `null`.
  if (block.polygon_points !== null) {
    result['polygon_points'] = block.polygon_points.map((point) => [
      fixed6(point[0]),
      fixed6(point[1]),
    ]);
  }
  if (block.linked_external_block_id !== null) {
    result['linked_external_block_id'] = text(
      block.linked_external_block_id,
      `${where}.linked_external_block_id`,
    );
  }
  if (block.display_name !== null) {
    result['display_name'] = text(block.display_name, `${where}.display_name`);
  }
  return result;
}

/**
 * Каноническая проекция тела снимка.
 *
 * Экспортируется не ради красоты: когда RD WEB ответит `invalid_manifest`,
 * единственный способ понять, ГДЕ разошлось, — сравнить две проекции построчно.
 * Хеш на этот вопрос не отвечает никогда.
 */
export function canonicalProjection(body: ExecSyncSnapshotBody): CanonValue {
  assertHashSafeMetadata(body);

  const blocks = [...body.blocks].sort((a, b) =>
    compareCanonKeys(a.external_block_id, b.external_block_id),
  );

  // Дубль идентификатора превратил бы «множество» в мультимножество, а
  // сортировка сделала бы порядок таких блоков зависящим от порядка выдачи БД.
  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    if (previous !== undefined && current !== undefined) {
      if (previous.external_block_id === current.external_block_id) {
        throw new ExecSyncCanonError(
          `external_block_id «${current.external_block_id}» встречается в снимке дважды`,
        );
      }
    }
  }

  return {
    schema_version: body.schema_version,
    external_sync_id: text(body.external_sync_id, 'external_sync_id'),
    external_project_id: text(body.external_project_id, 'external_project_id'),
    project_name: text(body.project_name, 'project_name'),
    external_document_id: text(body.external_document_id, 'external_document_id'),
    document_name: text(body.document_name, 'document_name'),
    document_revision: text(body.document_revision, 'document_revision'),
    base_generation: requireSafeInteger(body.base_generation, 'base_generation'),
    sync_generation: requireSafeInteger(body.sync_generation, 'sync_generation'),
    snapshot_mode: body.snapshot_mode,
    coordinate_space: body.coordinate_space,
    document: {
      file_name: text(body.document.file_name, 'document.file_name'),
      mime_type: body.document.mime_type,
      size_bytes: requireSafeInteger(body.document.size_bytes, 'document.size_bytes'),
      sha256: body.document.sha256,
      page_count: requireSafeInteger(body.document.page_count, 'document.page_count'),
    },
    blocks: blocks.map(canonBlock),
  };
}

/**
 * Сериализация проекции: компактно, ключи отсортированы, не-ASCII как есть.
 *
 * `JSON.stringify` применяется ТОЛЬКО к строкам — там он совпадает с
 * `json.dumps(ensure_ascii=False)` дословно: экранируются кавычка, обратный слеш
 * и управляющие символы ниже 0x20 (с короткими формами `\n`, `\t`, …), всё
 * остальное печатается как есть.
 */
function writeCanon(value: CanonValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(writeCanon).join(',')}]`;

  const entries = Object.entries(value as { readonly [key: string]: CanonValue });
  entries.sort((a, b) => compareCanonKeys(a[0], b[0]));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${writeCanon(item)}`).join(',')}}`;
}

/** Канонический текст: то, от чьих UTF-8 байтов берётся sha256. */
export function canonicalManifestJson(body: ExecSyncSnapshotBody): string {
  return writeCanon(canonicalProjection(body));
}

/** `manifest_sha256` — 64 hex в нижнем регистре. */
export function manifestSha256(body: ExecSyncSnapshotBody): string {
  return createHash('sha256').update(canonicalManifestJson(body), 'utf8').digest('hex');
}

/**
 * Единственное место, где поле `manifest_sha256` появляется на свет.
 *
 * Тело проверяется схемой ЗДЕСЬ, а не у вызывающего: снимок, не проходящий
 * собственную схему, не имеет права получить хеш — иначе мы бы отправили
 * заведомо негодное тело с формально верным манифестом и получили бы 422 про
 * поле, а не про манифест.
 */
export function sealSnapshot(body: ExecSyncSnapshotBody): ExecSyncSnapshotEnvelope {
  const parsed = execSyncSnapshotBodySchema.parse(body);
  return { ...parsed, manifest_sha256: manifestSha256(parsed) };
}
