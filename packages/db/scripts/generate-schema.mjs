/**
 * Генерирует схему Drizzle ИЗ SQL-миграций.
 *
 * Стандарт (раздел 8) объявляет SQL-миграции источником правды для схемы
 * production. Значит схема Drizzle — производная, и писать её руками параллельно
 * с миграциями нельзя: первая же попытка дала 39 расхождений в колонках и нулевое
 * пересечение по ~100 именам ограничений, причём часть расхождений ломала runtime
 * (в коде `doc_type_id`, в БД `doc_type_code` — любой запрос падал бы на
 * несуществующей колонке).
 *
 * Порядок работы: поднять файловую pglite, применить все миграции, отдать её
 * `drizzle-kit introspect`. Отдельный процесс drizzle-kit и нужен файловый
 * dataDir: БД в памяти он не увидит.
 *
 * Ограничения CHECK намеренно не переносятся в Drizzle: они живут в SQL и
 * исполняются БД. Дублирование логики проверок в двух местах создало бы ровно
 * тот класс расхождений, от которого избавляет генерация.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createPgliteDatabase } from '@id/db-harness';
import { loadMigrations, applyMigrations } from '@id/migrator';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PKG, '..', '..');
const MIGRATIONS = join(REPO, 'migrations');
const OUT = join(PKG, 'src', 'generated');

/** Куда положить файловую БД: вне репозитория, чтобы не попала в git. */
const workDir = join(tmpdir(), `id-portal-introspect-${process.pid}`);

/**
 * Берётся только `schema.ts`.
 *
 * `relations.ts` не используется: он нужен реляционному API запросов Drizzle,
 * а для схемы с большим числом составных FK drizzle-kit порождает в нём
 * дублирующиеся имена связей — файл получается синтаксически некорректным
 * («An object literal cannot have multiple properties with the same name»).
 * Если реляционные запросы понадобятся, связи для конкретных случаев проще
 * описать вручную небольшим файлом, чем чинить генерацию.
 */
const KEEP = new Set(['schema.ts']);

/** Читает сгенерированные файлы в объект для сравнения и записи. */
function readGenerated(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.ts') && KEEP.has(name)) out[name] = readFileSync(join(dir, name), 'utf8');
  }
  return out;
}

const HEADER = `/**
 * ФАЙЛ СГЕНЕРИРОВАН. Не правьте его руками.
 *
 * Источник правды — SQL-миграции в migrations/. Чтобы изменить схему, добавьте
 * миграцию и выполните \`pnpm db:schema:generate\`. Ручная правка будет затёрта,
 * а тест на дрейф её заметит.
 */
`;

/** Типы БД, которых нет в pg-core; подставляются из src/custom-types.ts. */
const CUSTOM_TYPES = ['citext', 'bytea', 'int4range'];

/**
 * Доводит вывод drizzle-kit до компилируемого состояния.
 *
 * Три класса правок, все — обход известных ограничений генератора, а не
 * изменение схемы:
 *
 * 1. Неотображённые типы. Для citext, bytea и int4range drizzle-kit выдаёт
 *    `unknown("колонка")` с пометкой «failed to parse database type».
 * 2. Циклические ссылки. Указатель submissions.current_revision_id смотрит на
 *    submission_revisions, а та ссылается обратно на submissions. Для такой
 *    пары TypeScript не может вывести тип и требует явной аннотации
 *    `(): AnyPgColumn =>`; drizzle-kit тип импортирует, но не применяет.
 * 3. Неиспользуемые аргументы обратного вызова, которые отвергает
 *    noUnusedLocals.
 *
 * Правки детерминированы, а тест на дрейф сверяет результат целиком, поэтому
 * незаметно разойтись с миграциями схема не может.
 */
function postProcess(body) {
  let out = body;

  // 1. Неотображённые типы.
  for (const type of CUSTOM_TYPES) {
    const re = new RegExp(
      `\\s*// TODO: failed to parse database type '${type}'\\n(\\s*)(\\w+): unknown\\(`,
      'gu',
    );
    out = out.replace(re, (_m, indent, prop) => `\n${indent}${prop}: ${type}(`);
  }
  const used = CUSTOM_TYPES.filter((t) => new RegExp(`: ${t}\\(`, 'u').test(out));
  if (used.length > 0) {
    out = out.replace(
      /^(import \{[\s\S]*?\} from "drizzle-orm\/pg-core";?)$/mu,
      `$1\nimport { ${used.join(', ')} } from "../custom-types.js";`,
    );
  }

  // 2. Циклические ссылки между таблицами.
  //
  // `submissions.current_revision_id` смотрит на `submission_revisions`, а та
  // ссылается обратно на `submissions`. Объявления `foreignKey` со ссылкой
  // ВПЕРЁД (на таблицу, определённую ниже) образуют для TypeScript цикл
  // вывода типов: «implicitly has type any because it is referenced directly
  // or indirectly in its own initializer».
  //
  // Такие объявления удаляются. Потери нет: ограничение живёт в БД и ею же
  // исполняется, а в Drizzle объявления FK нужны только генератору миграций,
  // которым мы не пользуемся — схема производная от SQL, а не наоборот.
  const declarations = new Map();
  for (const m of out.matchAll(/^export const (\w+) = pgTable\(/gmu)) {
    declarations.set(m[1], m.index);
  }
  const dropped = [];
  out = out.replace(
    /\n\tforeignKey\(\{\n(?:[^}]*?)foreignColumns: \[([^\]]*)\],\n\s*name: "([^"]+)"\n\t\t\}\)(\.\w+\([^)]*\))*,/gu,
    (match, foreignColumns, name, _tail, offset) => {
      const targets = [...foreignColumns.matchAll(/(\w+)\./gu)].map((m2) => m2[1]);
      const forward = targets.some((t) => {
        const at = declarations.get(t);
        return at !== undefined && at > offset;
      });
      if (!forward) return match;
      dropped.push(name);
      return '';
    },
  );
  if (dropped.length > 0) {
    out = out.replace(
      /^(\/\*\*[\s\S]*?\*\/)/u,
      `$1\n\n// Ограничения, опущенные из-за циклической ссылки (живут в БД):\n${dropped
        .map((n) => `//   ${n}`)
        .join('\n')}`,
    );
  }

  // 3. Неиспользуемые аргументы и импорт AnyPgColumn.
  out = out.replace(/\((table)\) => \[([\s\S]*?)\n\]\)/gu, (match, _arg, bodyText) =>
    /\btable\b/u.test(bodyText) ? match : `() => [${bodyText}\n])`,
  );
  if (!/AnyPgColumn/u.test(out.replace(/type AnyPgColumn/u, ''))) {
    out = out.replace(/,\s*type AnyPgColumn/u, '');
  }

  return out;
}

export async function generateSchema({ outDir = OUT } = {}) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const dbDir = join(workDir, 'db');
  const db = await createPgliteDatabase({ dataDir: dbDir });
  const migrations = loadMigrations(MIGRATIONS);
  const { applied } = await applyMigrations(db, migrations);
  await db.close();

  const configPath = join(workDir, 'drizzle.config.mjs');
  writeFileSync(
    configPath,
    [
      'export default {',
      "  dialect: 'postgresql',",
      "  driver: 'pglite',",
      `  dbCredentials: { url: ${JSON.stringify(dbDir)} },`,
      `  out: ${JSON.stringify(join(workDir, 'out'))},`,
      // Журнал раннера — служебная таблица, в схеме приложения ей не место.
      "  schemaFilter: ['public'],",
      "  tablesFilter: ['!schema_migrations'],",
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  // Бинарник вызывается через node напрямую, без npx и без shell: на Windows
  // npx — это .cmd, а запуск .cmd требует оболочки, и тогда аргументы
  // конкатенируются в строку вместо передачи массивом.
  const drizzleKitBin = join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs');
  if (!existsSync(drizzleKitBin)) {
    throw new Error(`Не найден drizzle-kit: ${drizzleKitBin}. Выполните pnpm install.`);
  }

  execFileSync(process.execPath, [drizzleKitBin, 'introspect', `--config=${configPath}`], {
    cwd: PKG,
    stdio: 'inherit',
  });

  const generated = readGenerated(join(workDir, 'out'));
  if (Object.keys(generated).length === 0) {
    throw new Error('drizzle-kit introspect не создал ни одного файла схемы');
  }

  const withHeader = Object.fromEntries(
    Object.entries(generated).map(([name, body]) => [name, HEADER + postProcess(body)]),
  );

  // Проверка синтаксиса на месте, а не на гейте typecheck.
  //
  // drizzle-kit 0.31.10 неверно экранирует пустую строку по умолчанию и выдаёт
  // `text().default(')` — незакрытый литерал. Без этой проверки сломанный файл
  // попал бы в репозиторий, а typecheck указал бы на «ошибку в схеме», хотя
  // причина в SQL: `DEFAULT ''` у текстовой колонки.
  for (const [name, body] of Object.entries(withHeader)) {
    const broken = /\.default\('\)/u.test(body);
    if (broken) {
      throw new Error(
        `${name}: drizzle-kit сломал экранирование пустой строки по умолчанию. ` +
          "Уберите DEFAULT '' из миграции: для текстовой колонки это либо nullable, " +
          'либо NOT NULL без значения по умолчанию.',
      );
    }
    // Баланс скобок ловит незакрытые вызовы и литералы, порождённые сбоем
    // экранирования, не прибегая к исполнению сгенерированного кода.
    const open = (body.match(/\(/gu) ?? []).length;
    const close = (body.match(/\)/gu) ?? []).length;
    if (open !== close) {
      throw new Error(
        `${name}: несбалансированные скобки (${open} против ${close}) — ` +
          'сгенерированный файл повреждён',
      );
    }
  }

  rmSync(workDir, { recursive: true, force: true });
  return { files: withHeader, migrationsApplied: applied.length, outDir };
}

/** Записывает результат на диск. Возвращает список изменённых файлов. */
export function writeGenerated(files, outDir) {
  mkdirSync(outDir, { recursive: true });
  const previous = readGenerated(outDir);
  const changed = [];

  for (const [name, body] of Object.entries(files)) {
    if (previous[name] !== body) {
      writeFileSync(join(outDir, name), body, 'utf8');
      changed.push(name);
    }
  }

  for (const name of Object.keys(previous)) {
    if (!(name in files)) {
      rmSync(join(outDir, name));
      changed.push(`- ${name}`);
    }
  }

  return changed;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { files, migrationsApplied, outDir } = await generateSchema();
  const changed = writeGenerated(files, outDir);
  console.log(
    `Миграций применено: ${migrationsApplied}. Файлов схемы: ${Object.keys(files).length}.`,
  );
  console.log(changed.length > 0 ? `Изменено: ${changed.join(', ')}` : 'Изменений нет.');
}
