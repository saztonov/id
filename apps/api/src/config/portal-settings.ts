/**
 * Эффективные значения настроек портала для ветвления конвейера (ADR-0007/0008).
 *
 * ## Почему не `readSetting` из репозитория администрирования
 *
 * Тот читатель требует неограниченной области видимости (`requireGlobalScope`)
 * — и это правильно для экрана настроек, где видны секретные ссылки и статусы
 * интеграций. Но ветвление конвейера происходит в роутах, которые вызывает
 * инженер с областью, ограниченной объектами, и падать на «недостаточно прав»
 * при чтении НЕсекретного ключа закрытого реестра — значит сломать запуск
 * распознавания для законного пользователя. Здесь читаются ТОЛЬКО ключи из
 * `SETTINGS_REGISTRY` (незнакомый ключ не компилируется — тип `SettingKey`),
 * а секреты в реестр не попадают по построению (`SECRET_SETTINGS`, 422 на
 * запись). Сам запрос к БД живёт в `db/repositories/admin.ts`
 * (`readSettingValue`, без области) — §4.1 требует, чтобы запросы жили в
 * репозиториях, а не в роутах и не в конфигурационном слое.
 *
 * ## Почему непригодное хранимое значение тихо заменяется значением по умолчанию
 *
 * Значение проходило схему при записи, поэтому расхождение возможно только
 * после ужесточения схемы в коде. Останавливать конвейер из-за этого нельзя —
 * поведение обязано совпадать с «настройку ещё не трогали», а расхождение
 * заметит экран настроек (он показывает сырое значение).
 */
import type {
  DetectionProviderSetting,
  JsonValue,
  RecognitionProviderSetting,
} from '@id/contracts';
import { readSettingValue } from '../db/repositories/admin.js';
import { SETTINGS_REGISTRY, type SettingKey } from '../modules/admin/schemas.js';
import type { Database } from '../db/repositories/users.js';

async function readEffectiveSetting(db: Database, key: SettingKey): Promise<JsonValue> {
  const definition = SETTINGS_REGISTRY[key];
  const stored = await readSettingValue(db, key);
  if (stored === undefined) return definition.defaultValue;
  const parsed = definition.schema.safeParse(stored);
  return parsed.success ? (parsed.data as JsonValue) : definition.defaultValue;
}

export interface RecognitionProviderSettings {
  readonly provider: RecognitionProviderSetting;
  /** Пустая строка — модель не выбрана; прогон VLM обязан отказать (409). */
  readonly vlmModel: string;
}

export async function readRecognitionSettings(db: Database): Promise<RecognitionProviderSettings> {
  const [provider, vlmModel] = await Promise.all([
    readEffectiveSetting(db, 'recognition.provider'),
    readEffectiveSetting(db, 'recognition.vlm_model'),
  ]);
  return {
    provider: provider as RecognitionProviderSetting,
    vlmModel: (vlmModel as string).trim(),
  };
}

/** Режим dry-run стадий AI (`ai.dry_run_only`) — уходит в снимок прогона VLM. */
export async function readAiDryRunOnly(db: Database): Promise<boolean> {
  const value = await readEffectiveSetting(db, 'ai.dry_run_only');
  return value === true;
}

/**
 * Разбор `LLM_MODEL_ALLOWLIST`: список слагов через запятую, `null` — без
 * ограничения. Семантика обязана совпадать с политикой провайдера
 * (`llm/policy.ts`): роут отвергает модель ДО создания прогона, политика — до
 * сетевого вызова; расхождение дало бы прогон, который не может сделать ни
 * одного вызова.
 */
export function parseModelAllowlist(raw: string | undefined): readonly string[] | null {
  if (raw === undefined) return null;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? null : entries;
}

export interface DetectionProviderSettings {
  readonly provider: DetectionProviderSetting;
  /** Пустая строка — модель не загружена; локальная детекция честно отказывает. */
  readonly modelVersion: string;
}

export async function readDetectionSettings(db: Database): Promise<DetectionProviderSettings> {
  const [provider, modelVersion] = await Promise.all([
    readEffectiveSetting(db, 'detection.provider'),
    readEffectiveSetting(db, 'detection.model_version'),
  ]);
  return {
    provider: provider as DetectionProviderSetting,
    modelVersion: (modelVersion as string).trim(),
  };
}
