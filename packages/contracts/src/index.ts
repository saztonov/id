/**
 * Общие контракты: zod-схемы и выведенные из них типы.
 *
 * Единственный источник правды по форме данных для backend и frontend.
 * Схема Drizzle (S2) реализует эти сущности в БД, а не наоборот: инварианты
 * вроде диапазона координат блока описаны здесь и продублированы в БД
 * ограничениями `CHECK`, чтобы их держал не только код приложения.
 */

/** Версия набора контрактов. Меняется при несовместимых правках схем. */
export const CONTRACTS_VERSION = 1 as const;

export type ContractsVersion = typeof CONTRACTS_VERSION;

export * from './enums.js';
export * from './domain.js';
export * from './api.js';
