/** Типы для build-скрипта генерации схемы: он на JS, а тесты на TS. */
export interface GeneratedSchema {
  readonly files: Record<string, string>;
  readonly migrationsApplied: number;
  readonly outDir: string;
}

export function generateSchema(options?: { outDir?: string }): Promise<GeneratedSchema>;
export function writeGenerated(files: Record<string, string>, outDir: string): string[];
