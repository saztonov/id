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
  '@id/doc-types': 'packages/doc-types',
  '@id/recognition': 'packages/recognition',
  '@id/rules': 'packages/rules',
  '@id/check-harness': 'tools/check-harness',
  '@id/db-harness': 'tools/db-harness',
  '@id/fake-rdweb': 'tools/fake-rdweb',
  '@id/fixtures': 'tools/fixtures',
  '@id/migrator': 'tools/migrator',
};

const workspaceAliases = Object.fromEntries(
  Object.entries(packageRoots).map(([name, root]) => [
    name,
    fileURLToPath(new URL(`./${root}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
