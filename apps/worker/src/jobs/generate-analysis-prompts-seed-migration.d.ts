/**
 * Типы для генератора seed-миграции промптов стадий анализа
 * (`tools/scripts/generate-analysis-prompts-seed-migration.mjs`).
 *
 * По образцу `generate-recognition-prompts-seed-migration.d.ts` и по той же
 * причине: скрипт живёт вне рабочего дерева `@id/worker` (`tools/scripts/`, не
 * под `rootDir: ./src`) и написан как обычный `.mjs`-модуль без своего `.d.ts`.
 * Wildcard-специфайер, а не точный относительный путь: правило матчится по
 * имени файла независимо от глубины импорта.
 */
declare module '*/generate-analysis-prompts-seed-migration.mjs' {
  /** Абсолютный путь к закоммиченному `migrations/0032_seed_analysis_prompts.sql`. */
  export const TARGET: string;

  export function sqlLiteral(value: string): string;

  /** Промт одной стадии в форме, которую принимает генератор SQL. */
  export interface AnalysisPromptSeed {
    readonly code: string;
    readonly stage: string;
    readonly system: string;
    readonly user: string;
  }

  export function generateAnalysisPromptsSeedStatements(
    prompts: readonly AnalysisPromptSeed[],
  ): readonly string[];

  export function generateAnalysisPromptsSeedSql(prompts: readonly AnalysisPromptSeed[]): string;

  /**
   * Собирает `@id/api` (`tsc`) и возвращает промты стадий `extract` и `check`
   * (`segmentation/prompts.ts`, `checks/llm-review-prompt.ts`).
   */
  export function loadAnalysisPrompts(): Promise<readonly AnalysisPromptSeed[]>;
}
