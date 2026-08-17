/**
 * Перегенерация seed-миграции каталога видов ИД.
 *
 * Источник правды — массивы `DOC_TYPES` и `PAGE_ROLES` в packages/doc-types;
 * в БД они попадают миграцией 0009. Два представления одного каталога обязаны
 * расходиться заметно, а не молча: файл пишется байт-в-байт выводом
 * `generateSeedSql()`, поэтому тест на дрейф (packages/db/src/seed-drift.test.ts)
 * сравнивает содержимое строгим равенством контрольных сумм.
 *
 *   pnpm seed:generate
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_TYPES_DIR = join(ROOT, 'packages', 'doc-types');
const TARGET = join(ROOT, 'migrations', '0009_seed_doc_types.sql');

/**
 * tsc запускается своим JS-энтрипоинтом, а не через `npx tsc`: на Windows `npx`
 * — это .cmd, который `execFileSync` без `shell` запустить не может, а с
 * `shell: true` появляются вопросы к экранированию пути. Резолв через require
 * вдобавок гарантирует ту версию TypeScript, что зафиксирована в репозитории,
 * а не случайно скачанную npx.
 */
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(DOC_TYPES_DIR, 'tsconfig.build.json')], {
  stdio: 'inherit',
});

/**
 * dist импортируется по файловому URL, а не по имени пакета: tools/scripts —
 * не воркспейс и зависимостей не объявляет, поэтому `@id/doc-types` отсюда
 * не резолвится.
 */
const dist = pathToFileURL(join(DOC_TYPES_DIR, 'dist', 'index.js')).href;
const { DOC_TYPES, PAGE_ROLES, generateSeedSql } = await import(dist);

const sql = generateSeedSql();

// Шапку пишет сам генератор. Проверяем её наличие, потому что миграция без
// пометки «сгенерирован» приглашает править файл руками, а следующий запуск
// такую правку молча затрёт.
if (!sql.startsWith('--') || !/сгенерирован/iu.test(sql.slice(0, 1000))) {
  console.error('generateSeedSql() вернул SQL без шапки о том, что файл сгенерирован.');
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
  console.log(
    `${shortPath}: без изменений (${DOC_TYPES.length} видов, ${PAGE_ROLES.length} ролей).`,
  );
} else {
  writeFileSync(TARGET, sql, 'utf8');
  console.log(
    `${shortPath}: ${previous === null ? 'создан' : 'обновлён'} ` +
      `(${DOC_TYPES.length} видов, ${PAGE_ROLES.length} ролей).`,
  );
}
