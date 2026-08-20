/**
 * Типы для генератора seed-миграции промптов recognize
 * (`tools/scripts/generate-recognition-prompts-seed-migration.mjs`).
 *
 * Скрипт живёт вне рабочего дерева `@id/worker` (`tools/scripts/`, не под
 * `rootDir: ./src`) и написан как обычный `.mjs`-модуль без своего `.d.ts` —
 * та же природа, что у остальных файлов `tools/scripts/*.mjs` (плоские
 * Node-скрипты, не workspace-пакет с типами). Wildcard-специфайер, а не
 * точный относительный путь: правило ambient-модуля матчится по ИМЕНИ файла
 * независимо от глубины относительного пути на конкретном месте импорта
 * (`recognition-prompts-seed.test.ts` — единственный потребитель на сегодня,
 * но декларация не обязана знать, из какой глубины её будут импортировать).
 */
declare module '*/generate-recognition-prompts-seed-migration.mjs' {
  /** Абсолютный путь к закоммиченному `migrations/0020_seed_recognition_prompts.sql`. */
  export const TARGET: string;

  export function sqlLiteral(value: string): string;

  export function generateRecognitionPromptsSeedStatements(
    defaults: Record<string, unknown>,
  ): readonly string[];

  export function generateRecognitionPromptsSeedSql(defaults: Record<string, unknown>): string;

  /**
   * Собирает `@id/api` (`tsc`) и возвращает `RECOGNITION_PROMPT_DEFAULTS`
   * (`apps/api/src/recognition/vlm/prompts.ts`) — по ключам `text`/`image`/`stamp`.
   */
  export function loadRecognitionPromptDefaults(): Promise<
    Record<
      'text' | 'image' | 'stamp',
      {
        readonly code: string;
        readonly systemPrompt: string;
        readonly userTemplate: string;
        readonly temperature: number;
        readonly maxTokens: number;
        readonly topK?: number;
        readonly responseFormat: { readonly name: string; readonly schema: unknown; readonly strict: true };
      }
    >
  >;
}
