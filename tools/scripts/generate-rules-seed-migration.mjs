/**
 * Перегенерация seed-миграций реестра правил.
 *
 * Источник правды — `RULE_CATALOG` в packages/rules. В БД он попадает НЕ одним
 * файлом, а партиями (`RULE_SEED_BATCHES`): миграция, однажды применённая,
 * заморожена контрольной суммой раннера, поэтому правило, добавленное после
 * 0017, приезжает своей миграцией. Каждая партия пишется байт-в-байт выводом
 * `generateRuleSeedSql(batch.rules)`, и тест на дрейф сравнивает пары строгим
 * равенством.
 *
 * Скрипт перезаписывает ТОЛЬКО расходящиеся файлы. Если он собрался переписать
 * давно применённую миграцию — значит правило добавили в старую партию вместо
 * новой, и это ошибка правки каталога, а не скрипта.
 *
 *   pnpm rules:seed:generate
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_DIR = join(ROOT, 'packages', 'rules');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

// tsc запускается своим JS-энтрипоинтом: на Windows `npx` — это .cmd, который
// execFileSync без shell запустить не может. Резолв через require вдобавок
// гарантирует версию TypeScript, зафиксированную в репозитории.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(RULES_DIR, 'tsconfig.build.json')], {
  stdio: 'inherit',
});

const dist = pathToFileURL(join(RULES_DIR, 'dist', 'index.js')).href;
const { RULE_SEED_BATCHES, generateRuleSeedSql } = await import(dist);

for (const batch of RULE_SEED_BATCHES) {
  const target = join(MIGRATIONS_DIR, `${batch.migration}.sql`);
  const sql = generateRuleSeedSql(batch.rules);

  if (!sql.startsWith('--') || !/сгенерирован/iu.test(sql.slice(0, 1000))) {
    console.error('generateRuleSeedSql() вернул SQL без шапки о том, что файл сгенерирован.');
    process.exit(1);
  }

  const shortPath = relative(ROOT, target).replaceAll('\\', '/');

  let previous = null;
  try {
    previous = readFileSync(target, 'utf8');
  } catch {
    // Файла ещё нет — первая генерация партии.
  }

  if (previous === sql) {
    console.log(`${shortPath}: без изменений (${batch.rules.length} правил).`);
  } else {
    writeFileSync(target, sql, 'utf8');
    console.log(
      `${shortPath}: ${previous === null ? 'создан' : 'обновлён'} (${batch.rules.length} правил).`,
    );
  }
}
