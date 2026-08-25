/**
 * Seed промптов стадий анализа (`migrations/0032_seed_analysis_prompts.sql`) не
 * отстаёт от `FIELD_EXTRACT_PROMPT` и `LLM_REVIEW_PROMPT` — по образцу
 * `recognition-prompts-seed.test.ts` и по той же причине.
 *
 * Сверка не может быть zero-build: источники — модули внутри `apps/api/src`,
 * а vitest-алиас `@id/api` резолвит ровно `index.ts`, не произвольный путь
 * пакета. Поэтому используется ТОТ ЖЕ путь, что и у генератора: сборка `@id/api`
 * и глубокий импорт скомпилированных модулей. Чистые функции генератора
 * переиспользуются как есть — дважды писать логику генерации значило бы
 * завести второй источник истины, расходящийся молча.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumOf, loadMigrations } from '@id/migrator';
import { describe, expect, it } from 'vitest';

import {
  generateAnalysisPromptsSeedSql,
  loadAnalysisPrompts,
  TARGET,
} from '../../../../tools/scripts/generate-analysis-prompts-seed-migration.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
/**
 * Сверяется ПОСЛЕДНЯЯ редакция сида, а не первая.
 *
 * 0032 засеяла две стадии из трёх и защищена контрольной суммой мигратора:
 * применённый файл правке не подлежит. Появление `page_classify` означало новый
 * файл, и предмет сверки переехал на него — сверять надо то, что описывает
 * нынешний набор дефолтов, а не исторический.
 */
const SEED_FILE = '0043_seed_analysis_prompts_v2.sql';

describe('seed промптов анализа не отстаёт от дефолтов', () => {
  it('совпадает с текущим выводом generateAnalysisPromptsSeedSql()', async () => {
    const committed = readFileSync(TARGET, 'utf8').replace(/\r\n/gu, '\n');
    const prompts = await loadAnalysisPrompts();

    expect(
      checksumOf(committed),
      `${SEED_FILE} разошёлся с дефолтами промптов. ` +
        'Перегенерируйте: pnpm analysis-prompts:seed:generate',
    ).toBe(checksumOf(generateAnalysisPromptsSeedSql(prompts)));
  }, 180_000);

  it('заводит все три стадии анализа, и код совпадает со стадией', async () => {
    // Совпадение `code` и `stage` — решение, а не случайность: у портала на
    // стадию один код, и разъехавшись, они дали бы «опубликованного промта
    // стадии нет» при заведённом промте (см. `PAGE_CLASSIFY_STAGE`).
    //
    // Три, а не две: `page_classify` не сеяла ни одна миграция с S8, и увидеть
    // текст, которым портал классифицирует страницы, в админ-консоли было негде.
    const prompts = await loadAnalysisPrompts();
    expect(prompts.map((prompt) => prompt.stage).sort()).toEqual([
      'check',
      'extract',
      'page_classify',
    ]);
    for (const prompt of prompts) {
      expect(prompt.code).toBe(prompt.stage);
      expect(prompt.system.length).toBeGreaterThan(200);
      expect(prompt.user.length).toBeGreaterThan(20);
    }
  }, 180_000);

  it('виден раннеру миграций и входит в непрерывную нумерацию', () => {
    const committed = readFileSync(TARGET, 'utf8').replace(/\r\n/gu, '\n');
    const migration = loadMigrations(MIGRATIONS_DIR).find((m) => m.fileName === SEED_FILE);

    expect(migration).toBeDefined();
    expect(migration?.checksum).toBe(checksumOf(committed));
  });

  it('промты засеяны черновиками, а не опубликованными', () => {
    // Публикация — действие администратора с записью в аудит. Миграция,
    // сеющая `published`, подделала бы `published_by` в журнале, который
    // читают как доказательство.
    const committed = readFileSync(TARGET, 'utf8');
    expect(committed).toContain('$prompt$draft$prompt$');
    expect(committed).not.toContain('$prompt$published$prompt$');
  });
});
