import { availableParallelism, freemem } from 'node:os';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Общая конфигурация тестов для всех воркспейсов.
 *
 * ## `dist` исключается явно
 *
 * Иначе vitest подхватывает и исходный `src/x.test.ts`, и скомпилированный
 * `dist/x.test.js`, отчёт показывает удвоенное число тестов, а падение в одной
 * копии маскируется другой.
 *
 * ## Внутренние пакеты разрешаются в `src`, а НЕ в `dist`
 *
 * Это не удобство, а условие того, что зелёный прогон вообще что-то доказывает.
 * У каждого пакета воркспейса `main` и `exports` указывают на `dist` — так и
 * надо в бою, — но тест, импортирующий `@id/api`, тогда исполняет ПРОШЛУЮ
 * сборку. Проверено мутацией: настоящая потеря страниц, внесённая в
 * `apps/api/src/segmentation/decoder.ts`, оставляла все 25 интеграционных тестов
 * воркера зелёными, и краснели они только после `pnpm --filter @id/api build`.
 *
 * То есть без алиаса `pnpm test` измеряет не тот код, который лежит в дереве, и
 * «гейт зелёный» перестаёт быть доказательством при любой правке чужого пакета
 * без пересборки. Порядок команд в гейте (`build` перед `test`) это ПРЯЧЕТ, а не
 * решает: он делает ответ верным сегодня и ничего не гарантирует завтра.
 *
 * Алиас убирает сам класс отказа: под vitest импорт `@id/*` всегда ведёт в
 * текущий исходник, и порядок команд перестаёт что-либо значить. На сборку и на
 * `typecheck` это не влияет — там по-прежнему работают `exports` и `.d.ts`.
 *
 * Список задан поимённо, а не выведен из `pnpm-workspace.yaml`: пакет без
 * `src/index.ts` (например, `@id/web`) алиасить нельзя, а вычисленный список
 * молча включил бы его и сломал бы разрешение вместо того, чтобы этого не
 * делать.
 */
const packageRoots: Readonly<Record<string, string>> = {
  '@id/api': 'apps/api',
  '@id/worker': 'apps/worker',
  '@id/contracts': 'packages/contracts',
  '@id/db': 'packages/db',
  '@id/detection': 'packages/detection',
  '@id/doc-types': 'packages/doc-types',
  '@id/execsync': 'packages/execsync',
  '@id/recognition': 'packages/recognition',
  '@id/rules': 'packages/rules',
  '@id/check-harness': 'tools/check-harness',
  '@id/db-harness': 'tools/db-harness',
  '@id/fake-rdweb-exec': 'tools/fake-rdweb-exec',
  '@id/fixtures': 'tools/fixtures',
  '@id/migrator': 'tools/migrator',
};

const workspaceAliases = Object.fromEntries(
  Object.entries(packageRoots).map(([name, root]) => [
    name,
    fileURLToPath(new URL(`./${root}/src/index.ts`, import.meta.url)),
  ]),
);

/**
 * Потолок параллелизма: тесты упираются в ПАМЯТЬ, а не в процессор.
 *
 * Каждый файл, которому нужна БД, поднимает собственный pglite — то есть
 * настоящий PostgreSQL, скомпилированный в WASM, со своей кучей. Таких файлов у
 * `@id/api` уже десятки, и при `maxWorkers = число ядер` прогон валится не
 * падением теста, а `FATAL ERROR: Zone Allocation failed — process out of
 * memory` либо `Worker exited unexpectedly`: воркеры умирают целиком, унося с
 * собой файлы, которые в них исполнялись. Отчёт при этом показывает «10 файлов
 * упали» без единой красной проверки — то есть гейт краснеет по причине, к коду
 * отношения не имеющей.
 *
 * ## Считается СВОБОДНАЯ память, а не общая
 *
 * Здесь стояла константа четыре — «эмпирический предел на машине с 16 ГБ». Она
 * молча предполагала, что все 16 ГБ наши. На рабочем столе это не так: серверы
 * VS Code и MCP держат около трёх гигабайт постоянно, и при 4.4 ГБ свободных
 * четыре pglite не помещаются. Прогон `@id/api` падал воспроизводимо — 107 из
 * 113 файлов, шесть «ошибок» и ни одного красного утверждения, — а те же 113
 * файлов и 2081 тест проходили с двумя воркерами.
 *
 * Поэтому потолок выводится из того, что действительно доступно: примерно
 * полтора гигабайта на воркер — измеренный аппетит pglite вместе с кучей V8.
 * На машине с запасом остаётся прежняя четвёрка, на загруженной — два, и гейт
 * говорит о коде, а не о том, сколько окон открыто.
 *
 * Снимок берётся один раз при загрузке конфигурации: память может просесть и по
 * ходу прогона, и обещать здесь гарантию нельзя. Но оценка по факту всегда
 * ближе к правде, чем константа, выведенная на другой машине.
 */
const GB = 1024 ** 3;
/** Аппетит одного воркера с поднятым pglite: измерено, не выведено. */
const MEMORY_PER_WORKER = 1.5 * GB;

const maxWorkers = Math.max(
  1,
  Math.min(4, availableParallelism(), Math.floor(freemem() / MEMORY_PER_WORKER)),
);

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
    maxWorkers,
  },
});
