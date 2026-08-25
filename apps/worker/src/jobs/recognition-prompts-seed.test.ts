/**
 * Seed промптов стадии `recognize` (`migrations/0020_seed_recognition_prompts.sql`)
 * не отстаёт от `RECOGNITION_PROMPT_DEFAULTS` — по образцу
 * `packages/db/src/rules-seed-drift.test.ts` (там сверяется реестр правил).
 *
 * ## Почему сверка не может быть zero-build, как у rules-seed-drift
 *
 * `rules-seed-drift.test.ts` импортирует `generateRuleSeedSql`/`RULE_CATALOG`
 * из `@id/rules` — под vitest это алиас на ИСХОДНИК (`packages/rules/src/index.ts`,
 * см. `vitest.shared.ts`), сборка не нужна. Здесь источник дефолтов —
 * `RECOGNITION_PROMPT_DEFAULTS` в `apps/api/src/recognition/vlm/prompts.ts`, а
 * `apps/api/src/index.ts` (публичная поверхность `@id/api` для воркера) его не
 * реэкспортирует — символ недоступен ни через package boundary, ни через
 * vitest-алиас `@id/api` (тот резолвит ровно `index.ts`, а не произвольный
 * путь пакета). Правка барреля — вне зоны этого файла (`apps/api/**`, её
 * трогает другой процесс). Поэтому сверка использует ТОТ ЖЕ путь, что и сам
 * генератор (`tools/scripts/generate-recognition-prompts-seed-migration.mjs`):
 * собрать `@id/api` (`tsc`) и импортировать
 * `apps/api/dist/recognition/vlm/prompts.js` напрямую, в обход `dist/index.js`.
 * Экспортированные из .mjs чистые функции (`loadRecognitionPromptDefaults`,
 * `generateRecognitionPromptsSeedSql`) переиспользуются как есть — дважды
 * писать логику генерации (в скрипте и в тесте) означало бы второй источник
 * истины, который расходится молча при первой правке одного из двух мест.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumOf, loadMigrations } from '@id/migrator';
import { describe, expect, it } from 'vitest';

import {
  generateRecognitionPromptsSeedSql,
  loadRecognitionPromptDefaults,
  sqlLiteral,
  TARGET,
} from '../../../../tools/scripts/generate-recognition-prompts-seed-migration.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

/**
 * Имя выводится из `TARGET`, а не пишется здесь.
 *
 * Правка промпта — это новая сид-миграция (применённый файл защищён контрольной
 * суммой мигратора), и сверять с дефолтами надо ПОСЛЕДНЮЮ. Захардкоженное имя
 * пришлось бы править вместе с генератором, а забытая правка дала бы тест,
 * который сверяет историю и проходит, что бы ни лежало в коде.
 */
const SEED_FILE = basename(TARGET);

describe('sqlLiteral', () => {
  it('подбирает тег, не встречающийся в значении', () => {
    expect(sqlLiteral('обычный текст')).toBe('$prompt$обычный текст$prompt$');
    expect(sqlLiteral('содержит $prompt$ маркер')).toBe(
      '$prompt1$содержит $prompt$ маркер$prompt1$',
    );
  });
});

describe('seed промптов recognize не отстаёт от RECOGNITION_PROMPT_DEFAULTS', () => {
  it(
    'совпадает с текущим выводом generateRecognitionPromptsSeedSql()',
    async () => {
      const committed = readFileSync(TARGET, 'utf8').replace(/\r\n/gu, '\n');
      const defaults = await loadRecognitionPromptDefaults();
      const generated = generateRecognitionPromptsSeedSql(defaults);

      expect(
        checksumOf(committed),
        `${SEED_FILE} разошёлся с RECOGNITION_PROMPT_DEFAULTS. ` +
          'Перегенерируйте: pnpm prompts:seed:generate',
      ).toBe(checksumOf(generated));
    },
    180_000,
  );

  it('содержит ровно три кода промптов recognize (text/image/stamp)', async () => {
    const defaults = await loadRecognitionPromptDefaults();
    expect(Object.keys(defaults).sort()).toEqual(['image', 'stamp', 'text']);
    expect(defaults.text.code).toBe('recognition_block_text');
    expect(defaults.image.code).toBe('recognition_block_image');
    expect(defaults.stamp.code).toBe('recognition_block_stamp');
  }, 180_000);

  it('виден раннеру миграций и входит в непрерывную нумерацию', () => {
    const committed = readFileSync(TARGET, 'utf8').replace(/\r\n/gu, '\n');
    const migration = loadMigrations(MIGRATIONS_DIR).find((m) => m.fileName === SEED_FILE);

    expect(migration).toBeDefined();
    expect(migration?.checksum).toBe(checksumOf(committed));
  });

  it('ни один текст промпта не содержит маркер $prompt$ дословно', async () => {
    // Если бы содержал — sqlLiteral сам подобрал бы другой тег (см. тест выше),
    // так что это не про корректность SQL, а про читаемость закоммиченного
    // файла: обычный $prompt$ на каждой границе значения проще диффить.
    const defaults = await loadRecognitionPromptDefaults();
    for (const spec of Object.values(defaults) as readonly { systemPrompt: string; userTemplate: string }[]) {
      expect(spec.systemPrompt).not.toContain('$prompt$');
      expect(spec.userTemplate).not.toContain('$prompt$');
    }
  }, 180_000);
});
