/**
 * Общие zod-схемы и типы, разделяемые backend и frontend.
 *
 * Наполняется на этапе S1. На S0 экспортируется только версия контракта,
 * чтобы воркспейс собирался и участвовал в гейтах.
 */

/** Версия набора контрактов. Меняется при несовместимых правках схем. */
export const CONTRACTS_VERSION = 1 as const;

export type ContractsVersion = typeof CONTRACTS_VERSION;
