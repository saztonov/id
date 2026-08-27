#!/usr/bin/env node
/**
 * Генератор seed-миграции промптов стадии `recognize` (ADR-0007, план v3 Ф4/Ф5).
 *
 * Источник правды — `RECOGNITION_PROMPT_DEFAULTS` в
 * `apps/api/src/recognition/vlm/prompts.ts`; в БД он попадает сид-миграцией
 * тремя `INSERT` (по одному на `recognition_block_text/image/stamp`),
 * `state='draft'` — публикация промптов стадии `recognize` остаётся осознанным
 * действием администратора. Отсутствие опубликованной версии при этом НЕ
 * останавливает прогон: воркер берёт встроенный текст из тех же дефолтов
 * (`recognitionPromptDefaultByCode`), а опубликованная версия просто имеет над
 * ним приоритет, см. `apps/worker/src/jobs/vlm-recognition.ts`.
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
 * Файл `TARGET` (последняя сид-миграция промптов) пишется байт-в-байт
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

/**
 * Правка промпта — это НОВАЯ миграция, а не перегенерация прежней.
 *
 * Мигратор считает контрольную сумму каждого применённого файла и отказывает
 * на изменённом задним числом («Стандарт требует исправлять новой миграцией»).
 * Поэтому при содержательной правке `RECOGNITION_PROMPT_DEFAULTS` здесь
 * поднимаются ОБЕ константы разом: номер версии строки в `prompt_templates` и
 * файл-цель. Прежние сид-миграции остаются в репозитории как есть — они
 * описывают то, что уже применено.
 *
 * Сверка на дрейф (`recognition-prompts-seed.test.ts`) смотрит на `TARGET`,
 * то есть всегда на ПОСЛЕДНЮЮ сид-миграцию: «в БД уезжает то, что лежит в коде»
 * — утверждение про неё, а не про историю.
 */
export const SEED_VERSION = 4;
export const TARGET = join(ROOT, 'migrations', '0053_reseed_recognition_prompts_v4.sql');

/**
 * Что именно сеется — пары «промт + его стадия».
 *
 * Прежде здесь стоял список типов блоков и ОДНА стадия на весь файл. Допущение
 * «сколько промтов, столько типов блоков, и стадия у них общая» перестало быть
 * верным с зондом ориентации (ADR-0020): он смотрит на страницу целиком,
 * блоков не знает вовсе и живёт на собственной стадии `orientation` — отдельной
 * потому, что у его строки `ai_runs` нет прогона распознавания.
 *
 * Разрешать это `if`-ом на месте вставки было бы дешевле на одну строку и
 * дороже на одно молчаливое допущение: следующий промт вне трёх типов блоков
 * снова потребовал бы правки в двух местах.
 */
const SEEDED = [
  { key: 'text', stage: 'recognize' },
  { key: 'image', stage: 'recognize' },
  { key: 'stamp', stage: 'recognize' },
  { key: 'orientation', stage: 'orientation' },
];
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

const HEADER = `-- Seed промптов распознавания и зонда ориентации, версия ${SEED_VERSION}.
--
-- Стадий здесь ДВЕ: recognize у трёх промтов блоков (ADR-0007) и orientation
-- у зонда разворота страницы (ADR-0020). Допущение «одна стадия на сид-файл»
-- перестало быть верным вместе с появлением зонда.
--
-- Файл сгенерирован generateRecognitionPromptsSeedSql() из
-- RECOGNITION_PROMPT_DEFAULTS (apps/api/src/recognition/vlm/prompts.ts).
-- Править вручную бессмысленно: следующая генерация вернёт содержимое
-- дефолтов. Перегенерировать: pnpm prompts:seed:generate.
--
-- Новая версия, а не правка прежней сид-миграции: применённый файл защищён
-- контрольной суммой, и мигратор отказывает на изменённом задним числом.
--
-- state='draft': публикация — осознанное действие администратора. Отсутствие
-- опубликованной версии НЕ отказ: воркер берёт встроенный текст из
-- RECOGNITION_PROMPT_DEFAULTS, из которого сгенерирован и этот файл, —
-- опубликованная версия лишь имеет приоритет над ним.
--
-- Параметры генерации (temperature/maxTokens/topK) здесь НЕ хранятся — их
-- источник тот же RECOGNITION_PROMPT_DEFAULTS, читаемый воркером на каждом
-- вызове (см. vlm-recognition.ts, generationProfile).
--
-- ON CONFLICT (code, version) DO NOTHING: повторное применение не затирает
-- ни черновик, правленый администратором, ни опубликованную версию.
`;

/**
 * По одному `INSERT` на код, а не один с несколькими `VALUES`: они читаются и
 * диффятся независимо друг от друга, а промты — самое длинное, что вообще
 * попадает в диффы этого репозитория.
 */
export function generateRecognitionPromptsSeedStatements(defaults) {
  return SEEDED.map(({ key, stage }) => {
    const spec = defaults[key];
    if (spec === undefined) {
      throw new Error(`Дефолт промпта «${key}» не найден: сид сгенерировал бы пустую строку`);
    }
    return `INSERT INTO prompt_templates (
  code, version, stage, doc_type_code, state, system_prompt, user_template, output_schema, model_override
)
VALUES (
  ${sqlLiteral(spec.code)},
  ${SEED_VERSION},
  ${sqlLiteral(stage)},
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
  const { RECOGNITION_PROMPT_DEFAULTS, RECOGNITION_ORIENTATION_PROMPT } = await import(
    promptsModuleUrl
  );
  // Зонд лежит ОТДЕЛЬНОЙ константой, а не четвёртым ключом словаря блоков: тот
  // типизирован тремя типами блоков, и четвёртый ключ в нём означал бы, что
  // «видов блока четыре». Сводятся они здесь, на границе генератора.
  return { ...RECOGNITION_PROMPT_DEFAULTS, orientation: RECOGNITION_ORIENTATION_PROMPT };
}

// ---------------------------------------------------------------------------
// Точка входа: выполняется ТОЛЬКО при прямом запуске файла, не при импорте
// (сверка на дрейф импортирует функции выше без побочных эффектов сборки).
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

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
