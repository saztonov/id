/**
 * Гейт приёмки: одна команда вместо восьми, исполняемых по памяти.
 *
 * ## Зачем
 *
 * Набор проверок в проекте сильный, но до сих пор он был СПИСКОМ КОМАНД,
 * которые запускают руками. Список, исполняемый по памяти, исполняется не
 * целиком: `pnpm -r test` помнят все, `format:check` и `pii:scan` — не всегда,
 * а `test:e2e` не запускали ни разу за восемь этапов. Ровно поэтому дефект S44
 * (переименован весь `/api/v1`, экран объекта пуст) доехал до прода: сторож
 * `apps/web/e2e/navigation.spec.ts` существовал, был обновлён тем же коммитом и
 * не был запущен.
 *
 * Здесь нет ни одной НОВОЙ проверки — только те же восемь шагов, собранные в
 * одно место и исполняемые до первого падения. Ценность не в проверках, а в
 * том, что «гейт зелёный» перестаёт зависеть от того, что человек вспомнил.
 *
 * ## Почему порядок именно такой
 *
 * Дешёвое раньше дорогого: формат и линт отвечают за секунды и ловят половину
 * правок, а `test:e2e` поднимает браузер и стенд с настоящей БД. Смысл — в
 * длине обратной связи, а не в важности шагов.
 *
 * `build` стоит перед `test:e2e` не по вкусу, а по необходимости:
 * `apps/web/e2e/harness/serve.mjs` поднимает `buildApp()` из `apps/api/dist`.
 * На `typecheck` порядок больше не влияет — с S52 он разрешает `@id/*` в `src`
 * (`tsconfig.base.json`), а не в прошлую сборку.
 *
 * ## Чего этот скрипт НЕ делает
 *
 * Не проверяет чистое дерево: `dist` и `node_modules` на машине разработки
 * остаются от прошлых прогонов. Это отдельная команда `pnpm gate:clean`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Шаги гейта. `hint` печатается при падении: чем перезапустить ОДИН шаг, не
 * прогоняя предыдущие семь.
 */
const STEPS = [
  { name: 'формат', args: ['format:check'], hint: 'pnpm format' },
  { name: 'линт', args: ['-r', 'lint'], hint: 'pnpm -r lint' },
  { name: 'типы', args: ['-r', 'typecheck'], hint: 'pnpm -r typecheck' },
  { name: 'сборка', args: ['-r', 'build'], hint: 'pnpm -r build' },
  { name: 'тесты', args: ['-r', 'test'], hint: 'pnpm -r test' },
  { name: 'e2e', args: ['test:e2e'], hint: 'pnpm test:e2e', needsBrowser: true },
  { name: 'ПДн корпуса', args: ['pii:scan'], hint: 'pnpm pii:scan' },
];

/**
 * Браузер Playwright ставится отдельной командой и в `node_modules` не лежит.
 * Без этой проверки шаг `e2e` падает стеной текста про отсутствующий
 * исполняемый файл, и это читается как поломка стенда, а не как незаконченная
 * установка.
 */
function browserMissing() {
  const home = process.env.LOCALAPPDATA ?? process.env.HOME ?? '';
  if (home === '') return false;
  const cache =
    process.platform === 'win32'
      ? join(home, 'ms-playwright')
      : join(home, '.cache', 'ms-playwright');
  return existsSync(cache) === false;
}

function run(args, label) {
  const started = Date.now();
  const result = spawnSync('pnpm', args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return { ok: result.status === 0, seconds, label };
}

const timings = [];
let failed = null;

for (const step of STEPS) {
  if (step.needsBrowser === true && browserMissing()) {
    console.error(
      `\nГЕЙТ НЕ ПРОЙДЕН на шаге «${step.name}»: браузер Playwright не установлен.\n` +
        'Один раз выполните:  pnpm --filter @id/web exec playwright install chromium\n' +
        'Пропустить шаг нельзя: набор e2e — единственное место, где сверяются\n' +
        'адреса клиента и живого API (см. дефект S44).',
    );
    process.exit(1);
  }

  console.log(`\n=== ${step.name} ===`);
  const outcome = run(step.args, step.name);
  timings.push(outcome);
  if (!outcome.ok) {
    failed = step;
    break;
  }
}

/**
 * Детерминированность фикстур — не команда, а сравнение: генератор прогоняется
 * заново, и рабочее дерево обязано не измениться. Отдельно от `STEPS`, потому
 * что шаг состоит из двух действий.
 */
if (failed === null) {
  console.log('\n=== фикстуры детерминированы ===');
  const generated = run(['fixtures:generate'], 'фикстуры');
  timings.push(generated);
  if (!generated.ok) {
    failed = { name: 'фикстуры', hint: 'pnpm fixtures:generate' };
  } else {
    const diff = spawnSync('git', ['diff', '--exit-code', '--', 'tools/fixtures/pdf'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (diff.status !== 0) {
      failed = {
        name: 'фикстуры детерминированы',
        hint: 'генератор выдал другой PDF на тех же входных данных — сверьте tools/fixtures',
      };
    }
  }
}

console.log('\n---- время шагов ----');
for (const t of timings) console.log(`${t.label.padEnd(22)} ${t.seconds} с`);
const total = timings.reduce((sum, t) => sum + Number(t.seconds), 0).toFixed(1);
console.log(`${'ИТОГО'.padEnd(22)} ${total} с`);

if (failed !== null) {
  console.error(`\nГЕЙТ НЕ ПРОЙДЕН на шаге «${failed.name}».`);
  console.error(`Перезапустить только его:  ${failed.hint}`);
  process.exit(1);
}

console.log('\nГейт пройден целиком.');
