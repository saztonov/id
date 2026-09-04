import { defineConfig } from 'vitest/config';

import shared from '../../vitest.shared.js';

/**
 * Единственный воркспейс, расширяющий общий `include`.
 *
 * Общая конфигурация видит только `src/**`, и у всех остальных пакетов этого
 * довольно. У веба — нет: стенд сквозного прогона живёт в `e2e/`, то есть ВНЕ
 * области видимости `pnpm test`. Ровно этим дефект S44 и доехал до прода: сторож
 * `e2e/navigation.spec.ts` существовал, был обновлён тем же коммитом и не мог
 * быть запущен командой тестов (`EXECUTION_LOG.md:3025`).
 *
 * Сюда попадают только `*.test.mjs` харнесса — проверки самого стенда, которым не
 * нужен браузер. Сценарии Playwright (`*.spec.ts`) остаются за `pnpm test:e2e`:
 * их запускает `playwright test`, и `testMatch` у него `/.*\.spec\.ts$/`, поэтому
 * пересечения между двумя наборами нет ни в одну сторону.
 */
export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    include: ['src/**/*.{test,spec}.ts', 'e2e/harness/**/*.test.mjs'],
  },
});
