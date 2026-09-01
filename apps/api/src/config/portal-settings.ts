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
import type { InferenceParamOverrides } from '@id/detection';
import { markupPolicyFromSettings } from '@id/contracts';
import type {
  DetectionInferenceModeSetting,
  DetectionProviderSetting,
  DetectionSheetStrategy,
  JsonValue,
  LargeSheetNumberZone,
  MarkupPolicy,
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

/**
 * Действует ли неизменяемость §3.9 (`core.enforce_immutability`).
 *
 * Второй читатель того же ключа: первый — SQL-функция `immutability_enforced()`
 * из миграции 0035, которую спрашивают триггеры. Дублирование намеренное и не
 * сводимое к одному месту: триггер обязан решать внутри БД (иначе прямой SQL
 * обходит запрет), а репозиторий обязан решать ДО запроса — чтобы отвечать
 * человеку понятной причиной, а не ловить `restrict_violation` из драйвера и
 * гадать, какой из сорока трёх триггеров сработал.
 *
 * Ключ и значение по умолчанию у обоих читателей общие: расхождение дало бы
 * режим, в котором один слой пропускает, а другой отвергает.
 */
export async function readImmutabilityEnforced(db: Database): Promise<boolean> {
  const value = await readEffectiveSetting(db, 'core.enforce_immutability');
  return value !== false;
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

export interface OrientationProbeSettings {
  readonly enabled: boolean;
  /** Пустая строка — брать модель распознавания (`recognition.vlm_model`). */
  readonly model: string;
}

/**
 * Настройки зонда ориентации (ADR-0020).
 *
 * Порога уверенности здесь НЕТ намеренно: он часть политики разворота, и
 * настройка дала бы два прогона с одной версией политики и разными поворотами —
 * дословно тот довод, которым `crop.ts` объясняет, почему потолок кропа
 * константа, а не настройка.
 */
export async function readOrientationProbeSettings(
  db: Database,
): Promise<OrientationProbeSettings> {
  const [enabled, model] = await Promise.all([
    readEffectiveSetting(db, 'orientation.probe_enabled'),
    readEffectiveSetting(db, 'orientation.probe_model'),
  ]);
  return {
    enabled: enabled === true,
    model: typeof model === 'string' ? model.trim() : '',
  };
}

export interface DetectionProviderSettings {
  readonly provider: DetectionProviderSetting;
  /** Пустая строка — модель не загружена; локальная детекция честно отказывает. */
  readonly modelVersion: string;
  /** Режим инференса; `auto` — по манифесту модели. */
  readonly inferenceMode: DetectionInferenceModeSetting;
  /**
   * Переопределения параметров постобработки. Пустые поля означают «из
   * манифеста» — см. `applyParamOverrides` в `@id/detection`.
   */
  readonly overrides: InferenceParamOverrides;
  /**
   * Правило разметки по формату листа — то, что будет ЗАПИНЕНО на новой ревизии
   * (S42).
   *
   * Отдаётся уже собранной политикой, а не двумя настройками по отдельности:
   * собирать её у каждого вызывающего значило бы повторять и нормализацию по
   * провайдеру (легаси-путь RD WEB правила форматов не знает), и пороги. Читать
   * это поле имеет право только тот, кто СОЗДАЁТ разметку; все остальные —
   * детекция, анализ покрытия, заплатка, экран — читают пин ревизии, иначе
   * смена настройки посреди веера постраничных задач разъехалась бы по одной
   * ревизии двумя правилами.
   */
  readonly markupPolicy: MarkupPolicy;
}

/** Число либо `null`: непригодное хранимое значение — то же, что «не задано». */
function numberOrNull(value: JsonValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Пороги по классам из jsonb. Незнакомые ключи и нечисловые значения отбрасываются. */
function perClassThresholds(
  value: JsonValue,
): Readonly<Partial<Record<'text' | 'image' | 'stamp', number>>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, JsonValue>;
  const out: Record<string, number> = {};
  for (const type of ['text', 'image', 'stamp'] as const) {
    const threshold = numberOrNull(source[type] ?? null);
    if (threshold !== null) out[type] = threshold;
  }
  return Object.keys(out).length === 0 ? null : out;
}

export async function readDetectionSettings(db: Database): Promise<DetectionProviderSettings> {
  const [
    provider,
    modelVersion,
    inferenceMode,
    scoreThreshold,
    classThresholds,
    nmsIou,
    mergeSplitText,
    maxDetections,
    sheetStrategy,
    numberZone,
  ] = await Promise.all([
    readEffectiveSetting(db, 'detection.provider'),
    readEffectiveSetting(db, 'detection.model_version'),
    readEffectiveSetting(db, 'detection.inference_mode'),
    readEffectiveSetting(db, 'detection.score_threshold'),
    readEffectiveSetting(db, 'detection.per_class_thresholds'),
    readEffectiveSetting(db, 'detection.nms_iou'),
    readEffectiveSetting(db, 'detection.merge_split_text'),
    readEffectiveSetting(db, 'detection.max_detections'),
    readEffectiveSetting(db, 'detection.sheet_strategy'),
    readEffectiveSetting(db, 'detection.large_sheet_number_zone'),
  ]);
  return {
    provider: provider as DetectionProviderSetting,
    modelVersion: (modelVersion as string).trim(),
    inferenceMode: inferenceMode as DetectionInferenceModeSetting,
    overrides: {
      defaultThreshold: numberOrNull(scoreThreshold),
      perClassThresholds: perClassThresholds(classThresholds),
      nmsIou: numberOrNull(nmsIou),
      mergeSplitText: typeof mergeSplitText === 'boolean' ? mergeSplitText : null,
      maxDetections: numberOrNull(maxDetections),
    },
    markupPolicy: markupPolicyFromSettings({
      provider: provider as DetectionProviderSetting,
      sheetStrategy: sheetStrategy as DetectionSheetStrategy,
      numberZone: numberZone as LargeSheetNumberZone,
    }),
  };
}
