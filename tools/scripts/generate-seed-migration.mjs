/**
 * Перегенерация seed-миграции каталога видов ИД.
 *
 * Источник правды — массивы `DOC_TYPES` и `PAGE_ROLES` в packages/doc-types.
 * Два представления одного каталога обязаны расходиться заметно, а не молча:
 * файл пишется байт-в-байт выводом `generateSeedSql()`, поэтому тест на дрейф
 * (packages/db/src/seed-drift.test.ts) сравнивает содержимое строгим равенством
 * контрольных сумм.
 *
 * ## Почему `TARGET` — НОВЫЙ файл, а не прежняя 0009
 *
 * Применённая миграция заморожена: раннер сверяет контрольную сумму каждого
 * применённого файла и отказывает на изменённом задним числом
 * (`tools/migrator/src/index.ts`, «Применённые миграции изменены задним
 * числом»). Первое же изменение каталога после развёртывания сломало бы накат
 * на любом стенде, где 0009 уже применена.
 *
 * Поэтому каталог переезжает так же, как промты распознавания на S26: новой
 * сид-миграцией, а `TARGET` указывает на последнюю из них. Сид идемпотентен —
 * `ON CONFLICT (code) DO UPDATE` по системным колонкам, — поэтому повторное
 * применение на свежей базе даёт тот же результат, что и накат поверх 0009.
 * Тест на дрейф выводит имя файла из `TARGET` и потому переезжает вместе с ним.
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
export const TARGET = join(ROOT, 'migrations', '0070_reseed_doc_types.sql');

/**
 * Собирает каталог и возвращает его вместе с готовым SQL.
 *
 * tsc запускается своим JS-энтрипоинтом, а не через `npx tsc`: на Windows `npx`
 * — это .cmd, который `execFileSync` без `shell` запустить не может, а с
 * `shell: true` появляются вопросы к экранированию пути. Резолв через require
 * вдобавок гарантирует ту версию TypeScript, что зафиксирована в репозитории,
 * а не случайно скачанную npx.
 *
 * dist импортируется по файловому URL, а не по имени пакета: tools/scripts —
 * не воркспейс и зависимостей не объявляет, поэтому `@id/doc-types` отсюда
 * не резолвится.
 */
export async function loadCatalogSeed() {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(DOC_TYPES_DIR, 'tsconfig.build.json')], {
    stdio: 'inherit',
  });

  const dist = pathToFileURL(join(DOC_TYPES_DIR, 'dist', 'index.js')).href;
  const { DOC_TYPES, PAGE_ROLES, generateSeedSql } = await import(dist);

  return { docTypes: DOC_TYPES, pageRoles: PAGE_ROLES, sql: generateSeedSql() };
}

// ---------------------------------------------------------------------------
// Точка входа: только при прямом запуске.
//
// Сверка на дрейф импортирует отсюда `TARGET`, и импорт, который собирает
// пакет и переписывает миграцию, превратил бы тест из наблюдателя в участника:
// он бы сам чинил расхождение, которое обязан обнаружить. Тот же гейт стоит в
// генераторе промтов анализа и заведён там по той же причине.
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { docTypes, pageRoles, sql } = await loadCatalogSeed();

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
      `${shortPath}: без изменений (${docTypes.length} видов, ${pageRoles.length} ролей).`,
    );
  } else {
    writeFileSync(TARGET, sql, 'utf8');
    console.log(
      `${shortPath}: ${previous === null ? 'создан' : 'обновлён'} ` +
        `(${docTypes.length} видов, ${pageRoles.length} ролей).`,
    );
  }
}
