/**
 * Свёрнутые блоки вкладки «Проверка» (S59).
 *
 * Заказчик попросил сворачивать блоки комплектов и секций: папка на двенадцать
 * актов — это двенадцать групп по четыре таблицы, и до нужной приходилось
 * прокручивать всё. Состояние живёт в браузере и портала не касается: это
 * удобство, а не настройка (тот же довод, что у свёрнутого меню в `AppShell`).
 *
 * Логика ключей вынесена в чистые функции по правилу вкладки: компонентных
 * тестов в проекте нет, и всё, что можно проверить без DOM, проверяется здесь.
 * Ломается тихо ровно разбор: испорченная запись в хранилище не должна ни
 * ронять экран, ни сворачивать всё подряд.
 */

const STORAGE_PREFIX = 'checks-collapsed:';

/** Ключ хранилища на папку: свёрнутое в одной папке другой не касается. */
export function collapsedStorageKey(folderId: string): string {
  return `${STORAGE_PREFIX}${folderId}`;
}

/**
 * Разбор записи хранилища: массив строк либо ничего.
 *
 * Любая другая форма — пустой список, а не ошибка: запись мог оставить старый
 * клиент или чужой скрипт, и портал не вправе из-за неё ни падать, ни
 * сворачивать блоки по догадке.
 */
export function parseCollapsedKeys(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function serializeCollapsedKeys(keys: readonly string[]): string {
  return JSON.stringify([...keys]);
}

/** Ключ переключается: свёрнутый разворачивается, развёрнутый сворачивается. */
export function toggleCollapsedKey(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
}

/** Чтение из `localStorage`: в приватном окне само обращение бросает. */
export function readCollapsedKeys(folderId: string): readonly string[] {
  try {
    return parseCollapsedKeys(window.localStorage.getItem(collapsedStorageKey(folderId)));
  } catch {
    return [];
  }
}

export function storeCollapsedKeys(folderId: string, keys: readonly string[]): void {
  try {
    window.localStorage.setItem(collapsedStorageKey(folderId), serializeCollapsedKeys(keys));
  } catch {
    // Не записалось — состояние просто не переживёт перезагрузку.
  }
}
