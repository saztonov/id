/**
 * Провайдер и модель прогона распознавания из его снимка настроек (ADR-0007).
 *
 * `settingsSnapshot` приходит как `unknown` — и это не лень типизации, а
 * свойство данных: снимок пишется на СТАРТЕ прогона тем кодом, который тогда
 * работал, и в базе живут одновременно несколько поколений. Сегодня это:
 *
 * - v1 (`{version: 1, provider, model, …}`) — legacy-путь RD WEB; поле
 *   `provider` там несёт тип провайдера ИХ стороны (`lmstudio`), а не выбор
 *   ветки портала, и может быть `null`, когда OCR не был настроен;
 * - v2 (`{schemaVersion: 2, provider, model, dryRun, …}`) — снимок VLM-ветки.
 *
 * Разбор обязан быть толерантным: незнакомая форма отвечает `null`, а не
 * бросает, — прогон месячной давности не становится нечитаемым из-за смены
 * формата снимка.
 */

export interface RunProviderInfo {
  readonly provider: string | null;
  readonly model: string | null;
}

const RDWEB_LABEL = 'RD WEB';

/** Подписи известных провайдеров РАСПОЗНАВАНИЯ (`recognition.provider`). */
export const RECOGNITION_PROVIDER_LABELS: Record<string, string> = {
  rdweb: RDWEB_LABEL,
  openrouter_vlm: 'OpenRouter VLM',
  /** Каноническое имя legacy-источника из `@id/recognition` — тот же RD WEB. */
  rdweb_md: RDWEB_LABEL,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Толерантный разбор снимка: отсутствие поля или чужая форма — `null`. */
export function runProviderOf(run: { settingsSnapshot: unknown }): RunProviderInfo {
  const snapshot = asRecord(run.settingsSnapshot);
  return {
    provider: stringField(snapshot, 'provider'),
    model: stringField(snapshot, 'model'),
  };
}

/** Прогон шёл (или пойдёт) по ветке OpenRouter VLM. */
export function isVlmRun(run: { settingsSnapshot: unknown }): boolean {
  return runProviderOf(run).provider === 'openrouter_vlm';
}

/** Снимок v2 несёт признак dry-run: прогон завершён без публикации результатов. */
export function isDryRun(run: { settingsSnapshot: unknown }): boolean {
  return asRecord(run.settingsSnapshot)?.['dryRun'] === true;
}

/**
 * Подпись провайдера для человека.
 *
 * Решение по данным, а не по словарю вслепую:
 *
 * 1. известный провайдер — из словаря;
 * 2. снимок v1 (`version: 1`) — это legacy-путь RD WEB по построению: поле
 *    `provider` там называет провайдера стороны RD WEB (`lmstudio`), и печатать
 *    его как провайдера портала значило бы врать об архитектуре;
 * 3. провайдера в снимке нет — «RD WEB» утверждается ТОЛЬКО при видимых следах
 *    RD-пути (задача или удалённые хэши), иначе честное «—»;
 * 4. незнакомая строка показывается как есть: открытый мир §0.5 — новое
 *    значение обязано быть видно, а не спрятано за прочерком.
 */
export function recognitionProviderLabel(run: {
  settingsSnapshot: unknown;
  rdJobId: string | null;
  remoteLayoutHashBefore: string | null;
  remoteLayoutHashAfter: string | null;
}): string {
  const { provider } = runProviderOf(run);
  if (provider !== null) {
    const known = RECOGNITION_PROVIDER_LABELS[provider];
    if (known !== undefined) return known;
  }

  const snapshot = asRecord(run.settingsSnapshot);
  if (snapshot?.['version'] === 1) return RDWEB_LABEL;

  if (provider === null) {
    const hasRdEvidence =
      run.rdJobId !== null ||
      run.remoteLayoutHashBefore !== null ||
      run.remoteLayoutHashAfter !== null;
    return hasRdEvidence ? RDWEB_LABEL : '—';
  }

  return provider;
}
