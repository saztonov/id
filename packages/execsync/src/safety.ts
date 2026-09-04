/**
 * Предполёт: что обязано быть отвергнуто ДО отправки, а не после (§12, §13).
 *
 * ## Почему `metadata` ограничена жёстче, чем требует контракт
 *
 * Контракт разрешает в `metadata` произвольный JSON. Но канонический хеш
 * считают две реализации на разных языках, и на числах они расходятся не там,
 * где ожидаешь:
 *
 *   JSON.stringify(1e16) → "10000000000000000"   json.dumps(1e16) → "1e+16"
 *   JSON.stringify(1e-7) → "1e-7"                json.dumps(1e-7) → "1e-07"
 *
 * Обычные целые и дроби в пределах безопасного диапазона обе стороны печатают
 * одинаково (кратчайшим round-trip представлением), расходятся ПОРОГИ перехода в
 * экспоненциальную запись — и правило перехода в контракте не описано, потому что
 * составители его не предполагали. Числа геометрии от этого защищены рендером
 * `%.6f`; в `metadata` защиты нет.
 *
 * Поэтому здесь разрешены только строки, булевы, `null` и БЕЗОПАСНЫЕ ЦЕЛЫЕ.
 * Запрет ничего не стоит: `metadata` порождаем мы сами, и класть туда дробь
 * незачем. Зато равенство хешей превращается из вероятного в доказуемое —
 * а это единственное свойство, ради которого весь модуль существует.
 *
 * ## `NaN`, `Infinity` и одиночные суррогаты
 *
 * `JSON.stringify(NaN)` даёт `null`, Python печатает `NaN` — невалидный JSON,
 * который их же разбор потом не примет. Одиночный суррогат JS экранирует
 * (`\ud800`), Python с `ensure_ascii=False` отдаёт его сырым и падает на
 * `.encode('utf-8')`. Оба случая — расхождение, которое проявится один раз на
 * тысяче комплектов и будет отлаживаться неделю. Дешевле отказать сразу.
 */
import type { ExecSyncMetadataValue, ExecSyncSnapshotBody } from './wire.js';

/** Отказ канонизации: неповторяемый — тело не станет годным от повтора. */
export class ExecSyncCanonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecSyncCanonError';
  }
}

/** Лимиты §12. Значения по умолчанию; развёртывание может их сузить. */
export const EXEC_SYNC_LIMITS = {
  /** Размер PDF, байт. */
  documentBytes: 268_435_456,
  /** Число страниц документа. */
  pageCount: 2000,
  /** Блоков в снимке. */
  blockCount: 20_000,
  /** Размер манифеста, байт. */
  manifestBytes: 33_554_432,
  /** `metadata` одного блока, байт. */
  metadataBytes: 4096,
  /** Глубина вложенности `metadata`. */
  metadataDepth: 8,
  /** Длина внешних идентификаторов, символов. */
  externalIdLength: 128,
  /** Точек полигона. */
  polygonPoints: 512,
} as const;

export type ExecSyncLimits = typeof EXEC_SYNC_LIMITS;

/**
 * Одиночный суррогат — половина пары, оставшаяся без своей второй половины.
 *
 * Регулярное выражение, а не `String.prototype.isWellFormed()`: последняя
 * появилась в ES2024, а `lib` проекта зафиксирована на `es2023` (ADR-0001).
 * Поведение то же, зависимости от версии среды нет.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function assertWellFormed(value: string, where: string): void {
  if (LONE_SURROGATE.test(value)) {
    throw new ExecSyncCanonError(
      `${where}: строка содержит одиночный суррогат — такую строку нельзя закодировать в UTF-8`,
    );
  }
}

/**
 * Целое, которое обе стороны напечатают одинаково.
 *
 * Возвращает само значение, чтобы вызов читался выражением: проверка и
 * использование в одном месте не расходятся при правке.
 */
export function requireSafeInteger(value: number, where: string): number {
  if (!Number.isFinite(value)) {
    throw new ExecSyncCanonError(`${where}: ожидалось конечное число, получено ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new ExecSyncCanonError(
      `${where}: ожидалось целое в безопасном диапазоне, получено ${String(value)}`,
    );
  }
  return value;
}

function walkMetadata(value: ExecSyncMetadataValue, where: string, depth: number): void {
  if (depth > EXEC_SYNC_LIMITS.metadataDepth) {
    throw new ExecSyncCanonError(
      `${where}: вложенность metadata глубже ${String(EXEC_SYNC_LIMITS.metadataDepth)}`,
    );
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertWellFormed(value, where);
    return;
  }
  if (typeof value === 'number') {
    requireSafeInteger(value, where);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item === null) {
        throw new ExecSyncCanonError(
          `${where}[${String(index)}]: null внутри массива metadata — ` +
            'правило §13 удаляет null у членов объекта, но не у элементов массива, ' +
            'а печатать его в каноне контракт не описывает',
        );
      }
      walkMetadata(item, `${where}[${String(index)}]`, depth + 1);
    });
    return;
  }
  for (const [key, item] of Object.entries(
    value as { readonly [k: string]: ExecSyncMetadataValue },
  )) {
    assertWellFormed(key, `${where}.<ключ>`);
    walkMetadata(item, `${where}.${key}`, depth + 1);
  }
}

/** Проверка `metadata` всех блоков снимка: форма, глубина и размер (§12). */
export function assertHashSafeMetadata(body: ExecSyncSnapshotBody): void {
  for (const block of body.blocks) {
    const where = `blocks.${block.external_block_id}.metadata`;
    walkMetadata(block.metadata, where, 1);

    const size = Buffer.byteLength(JSON.stringify(block.metadata), 'utf8');
    if (size > EXEC_SYNC_LIMITS.metadataBytes) {
      throw new ExecSyncCanonError(
        `${where}: ${String(size)} байт при потолке ${String(EXEC_SYNC_LIMITS.metadataBytes)}`,
      );
    }
  }
}
