/**
 * Сверка реестра правил с реализациями при старте (§9.6).
 *
 * «При старте», а не «когда-нибудь»: расхождение означает, что часть проверок
 * молча не исполняется, и обнаружить это по результату прогона невозможно —
 * прогон отвечает «замечаний нет» и в исправном состоянии, и в сломанном. На
 * S4 ровно этот класс дефекта уже случился: опечатка в `enabled_rule_codes`
 * выключала правило без единого сигнала.
 *
 * Сверка двусторонняя, но стороны НЕ равноправны, и это выяснилось на бою
 * (S58).
 *
 * **Реализация есть, записи в реестре нет — портал чинит сам.** Содержимое
 * `rule_definitions` производно от каталога кода: его строки генерируются из
 * `RULE_CATALOG` (`ruleDefinitionRows`), и миграции-партии существуют ради
 * воспроизводимости, а не потому, что оператор их наполняет. Отказ старта в
 * этом случае превращал пропажу производных строк в полную остановку портала:
 * 8 сентября пять определений и пять строк опубликованного снимка были удалены
 * из боевой базы вне портала (кода, который их удаляет, в портале нет), и
 * api с воркером ушли в цикл перезапусков, хотя восстановить недостающее можно
 * из собственного каталога за один INSERT. Теперь портал досевает их сам и
 * говорит об этом строкой журнала — пропажа перестала быть отказом и осталась
 * видимой.
 *
 * **Запись есть, реализации нет — по-прежнему отказ.** Это обратное отношение:
 * база ушла вперёд кода, то есть процесс собран старее схемы. Досевать здесь
 * нечего (реализацию правила не выдумать), а работать нельзя: администратор
 * видит правило включённым, а оно не исполняется. С S58 у этого состояния есть
 * и второй сторож — забор сборки (`jobs/build-fence.ts`).
 */
import { RuleRegistryError, assertRuleRegistryMatches, ruleDefinitionRows } from '@id/rules';
import {
  insertMissingRuleDefinitions,
  listRuleDefinitionCodes,
} from '../db/repositories/checks.js';
import type { Database } from '../db/repositories/users.js';

export interface RuleRegistryCheckLogger {
  error(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
}

/**
 * Проверка, досев недостающих определений и отказ старта при расхождении.
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
    if (!(error instanceof RuleRegistryError)) throw error;

    // Досев возможен ровно для одной стороны расхождения; вторая (реализации
    // нет) остаётся отказом, и её причина печатается ниже целиком.
    if (error.missingDefinitions.length > 0) {
      const missing = new Set(error.missingDefinitions);
      const restored = await insertMissingRuleDefinitions(
        db,
        ruleDefinitionRows().filter((row) => missing.has(row.code)),
      );
      logger?.warn(
        {
          event: 'rule_registry_backfilled',
          codes: [...error.missingDefinitions],
          restored,
        },
        'в реестре правил не было записей для реализованных правил: досеяны из каталога',
      );
    }

    const after = await listRuleDefinitionCodes(db);
    try {
      assertRuleRegistryMatches(after);
    } catch (secondError) {
      if (secondError instanceof RuleRegistryError) {
        logger?.error(
          {
            event: 'rule_registry_mismatch',
            missingImplementations: secondError.missingImplementations,
            missingDefinitions: secondError.missingDefinitions,
          },
          'реестр правил разошёлся с реализациями: старт невозможен',
        );
      }
      throw secondError;
    }
  }

  logger?.info({ event: 'rule_registry_ok', rules: codes.length }, 'реестр правил сверен');
}
