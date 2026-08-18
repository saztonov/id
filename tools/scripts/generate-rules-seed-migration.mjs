/**
 * Перегенерация seed-миграции реестра правил.
 *
 * Источник правды — `RULE_CATALOG` в packages/rules; в БД он попадает миграцией
 * 0017. Два представления одного каталога обязаны расходиться заметно, а не
 * молча: файл пишется байт-в-байт выводом `generateRuleSeedSql()`, поэтому тест
 * на дрейф сравнивает содержимое строгим равенством.
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
const TARGET = join(ROOT, 'migrations', '0017_seed_rule_definitions.sql');

// tsc запускается своим JS-энтрипоинтом: на Windows `npx` — это .cmd, который
// execFileSync без shell запустить не может. Резолв через require вдобавок
// гарантирует версию TypeScript, зафиксированную в репозитории.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(RULES_DIR, 'tsconfig.build.json')], {
  stdio: 'inherit',
});

const dist = pathToFileURL(join(RULES_DIR, 'dist', 'index.js')).href;
const { RULE_CATALOG, generateRuleSeedSql } = await import(dist);

const sql = generateRuleSeedSql();

if (!sql.startsWith('--') || !/сгенерирован/iu.test(sql.slice(0, 1000))) {
  console.error('generateRuleSeedSql() вернул SQL без шапки о том, что файл сгенерирован.');
  process.exit(1);
}

const shortPath = relative(ROOT, TARGET).replaceAll('\\', '/');

let previous = null;
try {
  previous = readFileSync(TARGET, 'utf8');
} catch {
  // Файла ещё нет — первая генерация.
}

if (previous === sql) {
  console.log(`${shortPath}: без изменений (${RULE_CATALOG.length} правил).`);
} else {
  writeFileSync(TARGET, sql, 'utf8');
  console.log(
    `${shortPath}: ${previous === null ? 'создан' : 'обновлён'} (${RULE_CATALOG.length} правил).`,
  );
}
