import { defineConfig } from 'vitest/config';

/**
 * Общая конфигурация тестов для всех воркспейсов.
 *
 * Ключевое: `dist` исключается явно. Иначе vitest подхватывает и исходный
 * `src/x.test.ts`, и скомпилированный `dist/x.test.js`, отчёт показывает
 * удвоенное число тестов, а падение в одной копии маскируется другой.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
