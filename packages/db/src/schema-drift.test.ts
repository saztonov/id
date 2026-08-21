/**
 * Схема Drizzle не разошлась с SQL-миграциями.
 *
 * Проверка тривиальна по смыслу и потому надёжна: перегенерировать схему из
 * миграций и сравнить с закоммиченной. Расхождение означает одно из двух —
 * либо миграцию добавили, а схему не перегенерировали, либо схему правили
 * руками. Оба случая приводят к одному итогу на проде: код обращается к
 * колонкам, которых в БД нет.
 *
 * Такой тест возможен только потому, что схема производная. Пока она писалась
 * руками параллельно с миграциями, сверка находила 39 расхождений в колонках
 * и ни одного совпадения среди ~100 имён ограничений.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSchema } from '../scripts/generate-schema.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = join(PKG, 'src', 'generated');

describe('схема Drizzle сгенерирована из миграций', () => {
  it('перегенерация не даёт расхождений', async () => {
    const { files } = await generateSchema();

    const committed: Record<string, string> = {};
    if (existsSync(GENERATED)) {
      for (const name of readdirSync(GENERATED).sort()) {
        if (name.endsWith('.ts')) committed[name] = readFileSync(join(GENERATED, name), 'utf8');
      }
    }

    expect(Object.keys(files).sort()).toEqual(Object.keys(committed).sort());

    for (const [name, body] of Object.entries(files)) {
      // Переводы строк нормализуются: checkout на Windows не должен ломать тест.
      const norm = (s: string): string => s.replace(/\r\n/gu, '\n');
      expect(
        norm(committed[name] ?? ''),
        `${name} расходится — выполните pnpm db:schema:generate`,
      ).toBe(norm(body));
    }
  }, 180_000);

  it('служебная таблица журнала миграций в схему приложения не попала', () => {
    const schema = readFileSync(join(GENERATED, 'schema.ts'), 'utf8');

    expect(schema).not.toContain('schemaMigrations');
    expect(schema).not.toContain('"schema_migrations"');
  });

  it('в сгенерированной схеме есть таблицы всех девяти разделов §3', () => {
    const schema = readFileSync(join(GENERATED, 'schema.ts'), 'utf8');
    const expected = [
      'users',
      'construction_objects',
      'submission_revisions',
      'source_pages',
      'processing_bundles',
      'layout_blocks',
      'recognition_runs',
      'logical_documents',
      'page_assignments',
      'findings',
      'jobs',
      'error_issues',
    ];

    for (const table of expected) {
      expect(schema, `нет таблицы ${table}`).toContain(`pgTable("${table}"`);
    }
  });
});
