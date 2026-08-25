#!/usr/bin/env node
/**
 * Генератор seed-миграции промптов стадий анализа (§8.4, §9.1, S21).
 *
 * Источники правды — `FIELD_EXTRACT_PROMPT` (`segmentation/prompts.ts`) и
 * `LLM_REVIEW_PROMPT` (`checks/llm-review-prompt.ts`). В БД они попадают
 * миграцией 0032 двумя `INSERT`, `state='draft'`: публикация — действие
 * администратора с записью в аудит, и сеять `published`-строку миграцией
 * значило бы подделать `published_by` в журнале, который читают как
 * доказательство. Обе стадии при отсутствии опубликованного промта честно
 * пропускают себя с названной причиной, а не падают.
 *
 * `page_classify` здесь НЕТ намеренно: его промт не засеян с S8, и добавлять
 * его этой миграцией значило бы менять поведение стадии, которую этап не
 * трогает. Долг назван в журнале исполнения.
 *
 * `output_schema` не пишется: у текстовых стадий портала ответ проверяется zod
 * на нашей стороне (`llm-extract.ts`, `checks/llm-review.ts`), а не
 * `response_format` шлюза — в отличие от `recognize`, где строгая схема уходит
 * в запрос. Колонка остаётся `NULL`, и это отличие видно, а не спрятано.
 *
 * ## Импорт в обход барреля пакета
 *
 * Тем же приёмом, что `generate-recognition-prompts-seed-migration.mjs`:
 * сборка `@id/api` через tsc, затем глубокий импорт скомпилированных модулей.
 *
 *   pnpm analysis-prompts:seed:generate
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_DIR = join(ROOT, 'apps', 'api');
/**
 * Цель генерации — ПОСЛЕДНЯЯ редакция сида, а не первая.
 *
 * До S27 здесь стояла 0032, засеявшая `extract` и `check`. Применённый файл
 * защищён контрольной суммой мигратора и правке не подлежит, поэтому появление
 * третьей стадии (`page_classify`) означает новый файл, а цель сверки на дрейф
 * переезжает на него: сверять надо то, что описывает НЫНЕШНИЙ набор дефолтов.
 *
 * Новая редакция повторяет и первые две стадии — `ON CONFLICT (code, version)
 * DO NOTHING` делает их вставку безвредным no-op на базах, где 0032 уже
 * применена. Так один файл описывает весь набор целиком, и «какие стадии
 * засеяны» не приходится собирать из истории миграций.
 */
export const TARGET = join(ROOT, 'migrations', '0043_seed_analysis_prompts_v2.sql');

const TAG_BASE = 'prompt';

/**
 * Литерал в долларовых кавычках: промты содержат и кавычки-ёлочки, и
 * апострофы, и фигурные скобки JSON. Тег подбирается так, чтобы не столкнуться
 * с текстом значения.
 */
export function sqlLiteral(value) {
  let tag = TAG_BASE;
  for (let attempt = 1; value.includes(`$${tag}$`); attempt += 1) {
    tag = `${TAG_BASE}${attempt}`;
  }
  return `$${tag}$${value}$${tag}$`;
}

const HEADER = `-- Seed промптов стадий анализа: page_classify, extract и check (§8.4, §9.1).
--
-- Файл сгенерирован generateAnalysisPromptsSeedSql() из PAGE_CLASSIFY_PROMPT и
-- FIELD_EXTRACT_PROMPT (apps/api/src/segmentation/prompts.ts) и LLM_REVIEW_PROMPT
-- (apps/api/src/checks/llm-review-prompt.ts). Править вручную бессмысленно:
-- следующая генерация вернёт содержимое дефолтов.
-- Перегенерировать: pnpm analysis-prompts:seed:generate.
--
-- ## Почему вторая редакция (S27)
--
-- Первая (0032) засеяла две стадии из трёх: промт page_classify не сеяла ни одна
-- миграция с S8, и в админ-консоли этой стадии не существовало. Увидеть текст,
-- которым портал классифицирует страницы, было негде, а поправить — тем более.
--
-- extract и check повторены здесь намеренно: ON CONFLICT делает их вставку
-- безвредным no-op там, где 0032 уже применена, зато один файл описывает весь
-- набор целиком, и «какие стадии засеяны» не приходится собирать из истории.
--
-- ## Что state='draft' теперь значит
--
-- Публикация остаётся ручным действием администратора с записью в аудит: сеять
-- published-строку миграцией значило бы подделать published_by в журнале,
-- который читают как доказательство.
--
-- Но черновик БОЛЬШЕ НЕ ОЗНАЧАЕТ, что стадия пропускается. Тексты промптов
-- лежат в коде, и сид генерируется из них же, поэтому «неопубликованный
-- черновик» и «встроенный текст» — одна и та же строка; конвейер берёт
-- встроенную версию (analysisPromptDefaultByStage) и помечает её нулём в
-- ai_runs.prompt_version. Опубликованная версия по-прежнему в приоритете.
--
-- output_schema = NULL: ответ этих стадий проверяется zod на нашей стороне, а
-- не response_format шлюза (в отличие от стадии recognize, 0020).
--
-- ON CONFLICT (code, version) DO NOTHING: повторное применение не затирает
-- ни черновик, правленый администратором, ни опубликованную версию.
`;

/** Два `INSERT`, а не один с двумя `VALUES`: читаются и диффятся независимо. */
export function generateAnalysisPromptsSeedStatements(prompts) {
  return prompts.map(
    (prompt) => `INSERT INTO prompt_templates (
  code, version, stage, doc_type_code, state, system_prompt, user_template, output_schema, model_override
)
VALUES (
  ${sqlLiteral(prompt.code)},
  1,
  ${sqlLiteral(prompt.stage)},
  NULL,
  ${sqlLiteral('draft')},
  ${sqlLiteral(prompt.system)},
  ${sqlLiteral(prompt.user)},
  NULL,
  NULL
)
ON CONFLICT (code, version) DO NOTHING`,
  );
}

export function generateAnalysisPromptsSeedSql(prompts) {
  return `${HEADER}\n${generateAnalysisPromptsSeedStatements(prompts).join(';\n\n')};\n`;
}

/**
 * Сборка `@id/api` и загрузка обоих промтов глубоким импортом.
 *
 * `code` совпадает со `stage`: у портала на стадию один код, и разъехавшись,
 * они дали бы «опубликованного промта стадии нет» при заведённом промте (то же
 * решение, что у `PAGE_CLASSIFY_STAGE`).
 */
export async function loadAnalysisPrompts() {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(API_DIR, 'tsconfig.build.json')], {
    stdio: 'inherit',
  });

  const segmentation = await import(
    pathToFileURL(join(API_DIR, 'dist', 'segmentation', 'prompts.js')).href
  );
  const review = await import(
    pathToFileURL(join(API_DIR, 'dist', 'checks', 'llm-review-prompt.js')).href
  );

  // Порядок — конвейерный: классификация, извлечение, проверка. Он же порядок
  // операторов в файле, и по нему миграция читается как описание стадий.
  return [
    {
      code: 'page_classify',
      stage: 'page_classify',
      system: segmentation.PAGE_CLASSIFY_PROMPT.system,
      user: segmentation.PAGE_CLASSIFY_PROMPT.user,
    },
    {
      code: 'extract',
      stage: 'extract',
      system: segmentation.FIELD_EXTRACT_PROMPT.system,
      user: segmentation.FIELD_EXTRACT_PROMPT.user,
    },
    {
      code: 'check',
      stage: 'check',
      system: review.LLM_REVIEW_PROMPT.system,
      user: review.LLM_REVIEW_PROMPT.user,
    },
  ];
}

// ---------------------------------------------------------------------------
// Точка входа: только при прямом запуске (сверка на дрейф импортирует функции).
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const prompts = await loadAnalysisPrompts();
  const sql = generateAnalysisPromptsSeedSql(prompts);

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
