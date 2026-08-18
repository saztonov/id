/**
 * `prettier --check` с ВНЯТНОЙ диагностикой перевода строк.
 *
 * ## Зачем обёртка
 *
 * На S9 гейт этапа встал красным на пяти файлах `packages/rules/src/`, и
 * единственным, что об этом сообщалось, был голый список:
 *
 *     [warn] packages/rules/src/{aosr,dates,engine,evidence,result}.ts
 *
 * Причина — CRLF при `eol=lf` в `.gitattributes` и `endOfLine: "lf"` в
 * `.prettierrc.json`. По этому выводу она не читается никак: те же
 * `[warn]` prettier печатает и на сбитом отступе, и на длинной строке.
 * Разбор занял отдельное расследование — сравнение с бэкапом, чтобы
 * доказать, что файлы были CRLF ещё до правок.
 *
 * ## Почему обёртка, а не новый рубеж
 *
 * Рубеж против CRLF в репозитории ровно один — этот самый `format:check`
 * (проверено: ни git-хуков, ни husky, ни eslint-правила на переводы строк
 * нет; `.github/workflows/ci.yml` зовёт `pnpm format:check`). Рубеж
 * сработал — он и поймал CRLF. Не сработала ДИАГНОСТИКА. Заводить второй
 * рубеж поверх работающего значит удваивать сущности; поэтому здесь не
 * добавлено ни одной новой проверки, а объяснён результат имеющейся.
 *
 * ## Откуда берётся CRLF
 *
 * Не от git: `.gitattributes` объявляет `* text=auto eol=lf`, и рабочее
 * дерево получает LF. Файлы приходят CRLF от ЗАПИСИ — Windows PowerShell
 * 5.1 (`Set-Content`, `Out-File`, `>`) завершает каждую строку CRLF, тогда
 * как heredoc в bash и редактирование файла инструментом дают LF. Поэтому
 * подсказка ниже говорит и про починку, и про причину: без второй половины
 * следующий файл придёт таким же.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PRETTIER_BIN = require.resolve('prettier/bin/prettier.cjs');

const run = spawnSync(process.execPath, [PRETTIER_BIN, '--check', '.'], {
  encoding: 'utf8',
  // `fileURLToPath`, а не `URL.pathname`: на Windows второй отдаёт
  // `/C:/…`, и prettier получил бы несуществующий каталог.
  cwd: fileURLToPath(new URL('../..', import.meta.url)),
});

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
process.stdout.write(output);

if (run.status === 0) process.exit(0);

/**
 * Вывод без ANSI-раскраски.
 *
 * prettier красит `[warn]`, и разбор по сырому тексту молча не находит
 * НИЧЕГО: обёртка печатала бы список без объяснения — ровно тот отказ,
 * ради которого она написана. Escape-последовательности снимаются до
 * сопоставления.
 */
const plain = output.replace(/\[[0-9;]*m/g, '');

/** Пути, на которые пожаловался prettier. */
const flagged = [...plain.matchAll(/^\[warn\] (.+?)$/gm)]
  .map((match) => match[1]?.trim())
  .filter((path) => path !== undefined && !path.startsWith('Code style issues'));

/** Есть ли в файле хоть один CRLF. Нечитаемый файл виноватым не считается. */
function hasCrlf(path) {
  try {
    return readFileSync(path, 'utf8').includes('\r\n');
  } catch {
    return false;
  }
}

const crlf = flagged.filter(hasCrlf);
const other = flagged.filter((path) => !crlf.includes(path));

if (crlf.length > 0) {
  console.error(
    `\nПРИЧИНА: CRLF в ${crlf.length} ${plural(crlf.length)} при \`eol=lf\` ` +
      '(.gitattributes) и `endOfLine: "lf"` (.prettierrc.json).',
  );
  for (const path of crlf) console.error(`  CRLF  ${path}`);
  console.error(
    '\nПочинить:  pnpm format\n' +
      'Не повторять: файлы на Windows писать через heredoc в bash или\n' +
      'редактором, но НЕ через PowerShell (`Set-Content`/`Out-File`/`>`) —\n' +
      'он завершает каждую строку CRLF.',
  );
}

if (other.length > 0) {
  console.error(
    `\n${other.length} ${plural(other.length)} с расхождением форматирования ` +
      '(отступы, переносы, кавычки) — переводы строк ни при чём:',
  );
  for (const path of other) console.error(`  стиль ${path}`);
  console.error('\nПочинить:  pnpm format');
}

function plural(n) {
  const tail = n % 100;
  if (tail >= 11 && tail <= 14) return 'файлах';
  return n % 10 === 1 ? 'файле' : 'файлах';
}

process.exit(run.status ?? 1);
