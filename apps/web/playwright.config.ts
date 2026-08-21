/**
 * Конфигурация сквозного прогона (§16: «Playwright: основные workflow, редактор
 * блоков, навигация finding → evidence, accessibility»).
 *
 * `webServer` поднимает стенд с НАСТОЯЩИМ приложением портала (см.
 * `e2e/harness/serve.mjs`), поэтому прогон требует собранных пакетов: сборка
 * `@id/api` и сборка SPA. Это названо в команде явно — молчаливое падение с
 * `ERR_MODULE_NOT_FOUND` объясняло бы не ту причину.
 *
 * Один браузер (Chromium) намеренно: проверяются рабочие процессы портала и
 * доступность разметки, а не совместимость движков. Портал работает во
 * внутреннем контуре с управляемым парком браузеров.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 4173);
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  /**
   * Сценарии разведены по режимам стенда.
   *
   * `local-auth.spec.ts` требует `AUTH_MODE=local`, где нет ни redirect-потока,
   * ни dev-заглушки; остальные сценарии, наоборот, входят через заглушку.
   * Собрать их в один прогон нельзя: режим у стенда один, и он задаётся при
   * запуске. Поэтому прогон выбирается переменной `E2E_AUTH_MODE`, а сценарии
   * фильтруются по ней же — иначе половина набора падала бы «не тем» отказом.
   */
  testMatch: process.env['E2E_AUTH_MODE'] === 'local' ? /local-auth\.spec\.ts$/ : /.*\.spec\.ts$/,
  testIgnore: process.env['E2E_AUTH_MODE'] === 'local' ? [] : ['**/local-auth.spec.ts'],
  // Артефакты прогона (трассы, снимки, `.last-run.json`) кладутся ВНЕ дерева
  // исходников. Значение по умолчанию — `test-results/` в корне пакета — попадало
  // в `prettier --check` и роняло `format:check` двенадцатью файлами, которые
  // прогон же и создал: гейт становился красным от собственного запуска.
  // `node_modules/` уже исключён и из git, и из prettier, поэтому каталог
  // артефактов живёт там же, а не поддерживается двумя списками игнорирования в
  // корне монорепозитория.
  outputDir: './node_modules/.playwright-artifacts',
  // Стенд один и держит одну базу pglite (одно соединение), поэтому прогон
  // последовательный: параллельные воркеры делили бы одно состояние и роняли
  // бы друг другу фикстуру.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['github']],
  use: {
    baseURL: BASE_URL,
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node ./e2e/harness/serve.mjs',
    url: `${BASE_URL}/health/live`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
