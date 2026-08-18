/**
 * Сверка реестра правил с реализациями при старте (§9.6).
 *
 * «При старте», а не «когда-нибудь»: расхождение означает, что часть проверок
 * молча не исполняется, и обнаружить это по результату прогона невозможно —
 * прогон отвечает «замечаний нет» и в исправном состоянии, и в сломанном. На
 * S4 ровно этот класс дефекта уже случился: опечатка в `enabled_rule_codes`
 * выключала правило без единого сигнала.
 *
 * Сверка двусторонняя. Забытая строка в `rule_definitions` даёт правило,
 * которое невозможно включить в профиль; забытая реализация даёт правило,
 * которое администратор включил и которое ничего не делает. Проверять одну
 * сторону — значит закрыть половину и считать вопрос решённым.
 */
import { RuleRegistryError, assertRuleRegistryMatches } from '@id/rules';
import { listRuleDefinitionCodes } from '../db/repositories/checks.js';
import type { Database } from '../db/repositories/users.js';

export interface RuleRegistryCheckLogger {
  error(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
}

/**
 * Проверка и отказ старта при расхождении.
 *
 * Исключение, а не запись в журнал: процесс, поднявшийся с неполным набором
 * правил, выдаёт подрядчику заключение «замечаний нет» по комплекту, который
 * не проверялся целиком. Это хуже отказа старта, потому что видно не будет.
 */
export async function assertRuleRegistryConsistent(
  db: Database,
  logger?: RuleRegistryCheckLogger,
): Promise<void> {
  const codes = await listRuleDefinitionCodes(db);

  try {
    assertRuleRegistryMatches(codes);
  } catch (error) {
    if (error instanceof RuleRegistryError) {
      logger?.error(
        {
          event: 'rule_registry_mismatch',
          missingImplementations: error.missingImplementations,
          missingDefinitions: error.missingDefinitions,
        },
        'реестр правил разошёлся с реализациями: старт невозможен',
      );
    }
    throw error;
  }

  logger?.info({ event: 'rule_registry_ok', rules: codes.length }, 'реестр правил сверен');
}
