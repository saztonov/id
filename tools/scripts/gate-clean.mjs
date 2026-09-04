/**
 * Гейт на ЧИСТОМ дереве — то единственное, ради чего был нужен CI.
 *
 * ## Зачем отдельно от `pnpm gate`
 *
 * Обычный гейт исполняется в рабочем дереве, где `dist` и `node_modules`
 * остались от прошлых прогонов. Это скрывает целый класс отказов: пакет,
 * собирающийся только потому, что рядом лежит прошлая сборка; зависимость,
 * добавленная в `node_modules` руками и не попавшая в `pnpm-lock.yaml`;
 * сгенерированный файл, который забыли закоммитить.
 *
 * Ровно этот класс и ловил CI, и ровно на нём он падал сорок прогонов подряд
 * («Parameter 'row' implicitly has an 'any' type»): в рабочем дереве `dist`
 * был, на чистом — нет. Причина закрыта в `tsconfig.base.json`, но сам класс
 * никуда не делся, и место, где он проверяется, обязано остаться.
 *
 * ## Почему worktree, а не клон
 *
 * `git worktree` берёт объекты из уже существующего `.git`: не тянет сеть, не
 * копирует историю и не может разойтись с `origin` — он показывает РОВНО тот
 * коммит, который есть локально. Цена — незакоммиченные правки в проверку не
 * попадают, и это не изъян, а условие: выкатывается коммит, а не рабочий стол.
 *
 * ## Когда запускать
 *
 * Перед выкаткой, а не на каждый `push`: `pnpm install --frozen-lockfile` на
 * пустом дереве стоит минуты. На каждый push работает `pnpm gate` через хук
 * `pre-push`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args, cwd = REPO_ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

const dirty = git(['status', '--porcelain']).stdout.trim();
if (dirty !== '') {
  console.warn(
    'ВНИМАНИЕ. В рабочем дереве есть незакоммиченные правки — в проверку они НЕ попадут.\n' +
      'Проверяется коммит HEAD. Незакоммиченное:\n' +
      dirty
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n') +
      '\n',
  );
}

const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
const workdir = mkdtempSync(join(tmpdir(), 'id-gate-clean-'));
const tree = join(workdir, 'tree');

console.log(`Чистое дерево коммита ${head} в ${tree}`);

let status = 1;
try {
  const added = spawnSync('git', ['worktree', 'add', '--detach', tree, 'HEAD'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (added.status !== 0) throw new Error('не удалось создать worktree');

  console.log('\n=== установка зависимостей (--frozen-lockfile) ===');
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: tree,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.status !== 0) {
    // Отдельным сообщением: расхождение lock-файла с `package.json` читается по
    // выводу pnpm плохо, а причина почти всегда одна — забыли закоммитить lock.
    console.error(
      '\nГЕЙТ НЕ ПРОЙДЕН: зависимости не ставятся на чистом дереве.\n' +
        'Обычная причина — `pnpm-lock.yaml` разошёлся с `package.json` и не закоммичен.',
    );
    throw new Error('install');
  }

  console.log('\n=== гейт на чистом дереве ===');
  const gate = spawnSync('pnpm', ['gate'], {
    cwd: tree,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  status = gate.status ?? 1;
} catch {
  status = 1;
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: REPO_ROOT, stdio: 'inherit' });
  rmSync(workdir, { recursive: true, force: true });
}

if (status !== 0) {
  console.error(`\nГЕЙТ НА ЧИСТОМ ДЕРЕВЕ НЕ ПРОЙДЕН (коммит ${head}). Выкатывать нельзя.`);
  process.exit(1);
}
console.log(`\nЧистое дерево коммита ${head} проходит гейт целиком.`);
