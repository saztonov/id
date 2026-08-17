// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'temp/**',
      // Сгенерированный код: корректность держит тест на дрейф, а не стиль.
      '**/src/generated/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Скрипты и инструменты пишут в stdout по назначению.
    files: ['tools/**/*.ts', '**/*.config.ts', '**/*.config.js'],
    rules: { 'no-console': 'off' },
  },
  {
    /**
     * Второй уровень изоляции доступа делается механическим.
     *
     * По §4.1 плана каждый запрос к данным ИД обязан быть ограничен областью
     * видимости через `withScope()`. Полагаться на дисциплину тут нельзя:
     * один забытый `db.select()` в обработчике роута — это утечка данных
     * между подрядчиками, и обнаружится она не тестом, а инцидентом.
     * Поэтому обращения к БД разрешены только внутри `db/repositories/`,
     * где область видимости является обязательным аргументом.
     */
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    ignores: [
      'apps/api/src/db/**',
      'apps/worker/src/db/**',
      '**/*.test.ts',
      // Проверки живости и готовности выполняют SELECT 1 вне области видимости.
      'apps/api/src/routes/health.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Методы, специфичные для построителя запросов: столкновений с
          // библиотечными именами у них нет, поэтому получатель не уточняется.
          selector:
            'CallExpression > MemberExpression[property.name=/^(select|selectDistinct|selectDistinctOn|insert)$/]',
          message:
            'Запросы к БД — только в db/repositories/, где область видимости обязательна (§4.1). ' +
            'Прямой запрос из роута или job обходит изоляцию между подрядчиками.',
        },
        {
          /**
           * `update`, `delete` и `execute` носят и обычные объекты: `Set.delete`,
           * `Map.delete`, `createHash().update()`. Широкое правило поймало
           * подсчёт sha256 в разборщике PDF, то есть запрещало корректный код.
           * Поэтому здесь уточняется получатель — им может быть только
           * дескриптор соединения или транзакции.
           */
          selector:
            'CallExpression > MemberExpression[object.name=/^(db|tx|trx|executor|conn|pool)$/][property.name=/^(update|delete|execute)$/]',
          message:
            'Запросы к БД — только в db/repositories/, где область видимости обязательна (§4.1). ' +
            'Прямой запрос из роута или job обходит изоляцию между подрядчиками.',
        },
      ],
    },
  },
  prettier,
);
