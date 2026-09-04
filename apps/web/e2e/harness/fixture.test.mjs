/**
 * Посев стенда прикладывается к ТЕКУЩЕЙ схеме.
 *
 * ## Зачем отдельная проверка, когда есть e2e
 *
 * Потому что расхождение фикстуры со схемой ловилось самым дорогим шагом гейта и
 * только при установленном браузере. Дважды подряд оно кончалось одинаково:
 * `webServer` умирал на посеве, до первого сценария, и «стенд не проходился»
 * записывалось в журнал как нехватка времени (S33, `EXECUTION_LOG.md:2055`), а на
 * S44 миграции 0058/0059 сняли `registries`, `works` и `submission_revisions`, и
 * фикстура осталась на десять этапов позади — при том, что спеки тем же коммитом
 * перевели на папки.
 *
 * Здесь тот же посев прикладывается к тем же миграциям за секунды и без браузера.
 * Проверка не заменяет прогон: она отвечает только на вопрос «стенд вообще
 * поднимется», то есть на тот, ответ на который стоил двух этапов.
 *
 * ## Почему `.mjs`
 *
 * `apps/web/tsconfig.e2e.json` включает только `e2e/**\/*.ts`, а `fixture.mjs`
 * типов не имеет: импорт из `.ts` не прошёл бы `typecheck` — по этой же причине
 * `support/session.ts` дублирует константы вместо импорта. Соседние `serve.mjs` и
 * `run-local.mjs` — такие же обычные Node-скрипты воркспейса.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgliteDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { fixtureSql } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', '..', 'migrations');

/**
 * Хэш состава подставной, а не настоящий.
 *
 * Настоящий считает портал (`computeAggregateManifestHash`), и на стенде он
 * настоящий и есть — иначе экран проверки показывал бы «комплект изменился»
 * всегда. Здесь проверяется не значение хэша, а то, что строка ложится в
 * колонку: подстановка снимает с проверки зависимость от `apps/api/dist`, то есть
 * от порядка «сборка перед тестами».
 */
const FAKE_HASH = () => 'e'.repeat(64);

/** Один pglite на файл: 69 миграций — самая дорогая часть проверки. */
let db;

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
});

async function countOf(table) {
  const rows = await db.query(`select count(*)::int as n from ${table}`);
  return rows[0].n;
}

test('посев стенда ложится на схему целиком', async () => {
  const statements = fixtureSql({ sha: 'a'.repeat(64), size: 4096, aggregateHash: FAKE_HASH });

  for (const [index, statement] of statements.entries()) {
    try {
      await db.query(statement);
    } catch (error) {
      // Номер и текст оператора в сообщении — потому что иначе отказ выглядит как
      // «42P01 relation does not exist» без указания, ЧТО именно посеялось не так.
      // Исходный отказ остаётся в `cause`: в нём код Postgres и позиция в SQL.
      throw new Error(`оператор №${index + 1} не лёг на схему:\n${statement}`, { cause: error });
    }
  }
}, 180_000);

/**
 * Состав, а не только отсутствие отказа.
 *
 * Оператор можно снять целиком, и посев останется «зелёным»: SQL исполнился,
 * потому что его не стало. Числа держат сценарии — четыре страницы у папки с
 * разметкой это `markup.spec.ts:26`, два блока — выбор блока в панели, комплект —
 * группировка отчёта проверки.
 */
test('посев даёт состав, на который опираются сценарии', async () => {
  expect(await countOf('folders')).toBe(3);
  expect(await countOf('complects')).toBe(1);
  expect(await countOf('source_files')).toBe(2);
  expect(await countOf('source_pages')).toBe(5);
  expect(await countOf('processing_bundle_pages')).toBe(5);
  expect(await countOf('layout_blocks')).toBe(2);
  expect(await countOf('logical_documents')).toBe(1);
  expect(await countOf('validation_runs')).toBe(2);
  expect(await countOf('findings')).toBe(2);

  const [folder] = await db.query(
    `select title, section_code from folders where id = '00000000-0000-4000-8000-000000000013'`,
  );
  expect(folder.title).toBe('Комплект с разметкой');
  expect(folder.section_code).toBe('roofing');
});
