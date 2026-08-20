#!/usr/bin/env node
/**
 * Генератор seed-миграции промптов стадии `recognize` (ADR-0007, план v3 Ф4/Ф5).
 *
 * Источник правды — `RECOGNITION_PROMPT_DEFAULTS` в
 * `apps/api/src/recognition/vlm/prompts.ts`; в БД он попадает миграцией 0020
 * тремя `INSERT` (по одному на `recognition_block_text/image/stamp`),
 * `state='draft'` — публикация промптов стадии `recognize` остаётся ручным
 * действием администратора: `vlm.start_recognition` честно отказывает без
 * опубликованных промптов всех трёх кодов («опубликуйте промпты стадии
 * recognize»), см. `apps/worker/src/jobs/vlm-recognition.ts`.
 *
 * Параметры генерации (`temperature`/`maxTokens`/`topK`) в `prompt_templates`
 * НЕ пишутся — их читает воркер из тех же `RECOGNITION_PROMPT_DEFAULTS` на
 * каждом вызове (`generationProfile` в deps `vlm-recognition.ts`); здесь в БД
 * уходят только `system_prompt`/`user_template`/`output_schema`.
 *
 * ## Импорт в обход барреля пакета
 *
 * На момент написания этого скрипта `apps/api/src/index.ts` (публичная
 * поверхность `@id/api`) не реэкспортирует `RECOGNITION_PROMPT_DEFAULTS` —
 * символ существует и протестирован в `recognition/vlm/prompts.ts`, но
 * недоступен через package boundary. Импорт здесь идёт ГЛУБОКИМ путём
 * в скомпилированный `apps/api/dist/recognition/vlm/prompts.js`, той же
 * техникой, что `generate-rules-seed-migration.mjs` использует для
 * `RULE_CATALOG` (сборка `tsc` пакета → dynamic import скомпилированного
 * модуля) — разница только в том, что здесь путь импорта НЕ через
 * `dist/index.js` пакета, а на уровень глубже.
 *
 * Файл `migrations/0020_seed_recognition_prompts.sql` пишется байт-в-байт
 * выводом `generateRecognitionPromptsSeedSql()`; сверка на дрейф —
 * `apps/worker/src/jobs/recognition-prompts-seed.test.ts`.
 *
 *   pnpm prompts:seed:generate
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_DIR = join(ROOT, 'apps', 'api');
export const TARGET = join(ROOT, 'migrations', '0020_seed_recognition_prompts.sql');

const BLOCK_TYPES = ['text', 'image', 'stamp'];
const STAGE = 'recognize';
const TAG_BASE = 'prompt';

/**
 * Литерал в долларовых кавычках — тот же приём, что `sqlLiteral` в
 * `packages/rules/src/seed.ts`: безопасен при `standard_conforming_strings`
 * любого значения и не требует экранирования кавычек/апострофов внутри
 * промпта. Тег подбирается так, чтобы не столкнуться с текстом значения.
 */
export function sqlLiteral(value) {
  let tag = TAG_BASE;
  for (let attempt = 1; value.includes(`$${tag}$`); attempt += 1) {
    tag = `${TAG_BASE}${attempt}`;
  }
  return `$${tag}$${value}$${tag}$`;
}

/** JSON Schema ответа — тем же долларовым литералом, приведённым к `jsonb`. */
function jsonbLiteral(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

const HEADER = `-- Seed промптов стадии recognize (ADR-0007, план v3 Ф4/Ф5).
--
-- Файл сгенерирован generateRecognitionPromptsSeedSql() из
-- RECOGNITION_PROMPT_DEFAULTS (apps/api/src/recognition/vlm/prompts.ts).
-- Править вручную бессмысленно: следующая генерация вернёт содержимое
-- дефолтов. Перегенерировать: pnpm prompts:seed:generate.
--
-- state='draft': публикация — ручное действие администратора.
-- vlm.start_recognition отказывает без опубликованных промптов всех трёх
-- кодов («опубликуйте промпты стадии recognize»).
--
-- Параметры генерации (temperature/maxTokens/topK) здесь НЕ хранятся — их
-- источник тот же RECOGNITION_PROMPT_DEFAULTS, читаемый воркером на каждом
-- вызове (см. vlm-recognition.ts, generationProfile).
--
-- ON CONFLICT (code, version) DO NOTHING: повторное применение не затирает
-- ни черновик, правленый администратором, ни опубликованную версию.
`;

/**
 * Три `INSERT` (не один с тремя `VALUES`) — по одному на код, читаются и
 * диффятся независимо друг от друга.
 */
export function generateRecognitionPromptsSeedStatements(defaults) {
  return BLOCK_TYPES.map((type) => {
    const spec = defaults[type];
    return `INSERT INTO prompt_templates (
  code, version, stage, doc_type_code, state, system_prompt, user_template, output_schema, model_override
)
VALUES (
  ${sqlLiteral(spec.code)},
  1,
  ${sqlLiteral(STAGE)},
  NULL,
  ${sqlLiteral('draft')},
  ${sqlLiteral(spec.systemPrompt)},
  ${sqlLiteral(spec.userTemplate)},
  ${jsonbLiteral(spec.responseFormat.schema)},
  NULL
)
ON CONFLICT (code, version) DO NOTHING`;
  });
}

export function generateRecognitionPromptsSeedSql(defaults) {
  return `${HEADER}\n${generateRecognitionPromptsSeedStatements(defaults).join(';\n\n')};\n`;
}

/**
 * Сборка `@id/api` (tsc, тот же образ, что `pnpm --filter @id/api build`) и
 * загрузка `RECOGNITION_PROMPT_DEFAULTS` глубоким импортом (см. шапку файла).
 *
 * Экспортирована отдельно от генерации SQL: сверка на дрейф вызывает ровно
 * эти две функции по отдельности (сборка + свежие дефолты, затем чистая
 * генерация), не дублируя ни tsc-вызов, ни путь импорта.
 */
export async function loadRecognitionPromptDefaults() {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(API_DIR, 'tsconfig.build.json')], {
    stdio: 'inherit',
  });

  const promptsModuleUrl = pathToFileURL(
    join(API_DIR, 'dist', 'recognition', 'vlm', 'prompts.js'),
  ).href;
  const { RECOGNITION_PROMPT_DEFAULTS } = await import(promptsModuleUrl);
  return RECOGNITION_PROMPT_DEFAULTS;
}

// ---------------------------------------------------------------------------
// Точка входа: выполняется ТОЛЬКО при прямом запуске файла, не при импорте
// (сверка на дрейф импортирует функции выше без побочных эффектов сборки).
// ---------------------------------------------------------------------------
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const defaults = await loadRecognitionPromptDefaults();
  const sql = generateRecognitionPromptsSeedSql(defaults);

  const shortPath = relative(ROOT, TARGET).replaceAll('\\', '/');

  let previous = null;
  try {
    previous = readFileSync(TARGET, 'utf8');
  } catch {
    // Файла ещё нет — первая генерация.
  }

  if (previous === sql) {
    console.log(`${shortPath}: без изменений.`);
  } else {
    writeFileSync(TARGET, sql, 'utf8');
    console.log(`${shortPath}: ${previous === null ? 'создан' : 'обновлён'}.`);
  }
}
