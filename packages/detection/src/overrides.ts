/**
 * Переопределения параметров инференса настройками портала (ADR-0008).
 *
 * ## Зачем они вообще
 *
 * В референсном RD WEB порог принятия детекции, NMS IoU, склейка разорванного
 * текста, потолок детекций и режим инференса — НАСТРОЙКИ СЕРВИСА
 * (`DetectionSettings` в `core/settings_models_runtime.py`): их калибруют, не
 * трогая модель. У портала таких настроек не было, и всё перечисленное
 * читалось только из манифеста модели — а манифест их не обязан содержать и на
 * практике не содержит. Действовали хардкод-дефолты: порог 0.5, NMS 0.5,
 * склейка выключена, потолка нет. Из-за этого «страница не обведена» была
 * состоянием без выхода: единственным способом снизить порог была правка
 * файла модели в хранилище.
 *
 * ## `null` — это «из манифеста», а не «ноль»
 *
 * Каждое поле необязательно, и `null`/`undefined` означает «не переопределять».
 * Иначе настройка со значением по умолчанию затирала бы манифест молча, и
 * смысл манифеста как источника параметров модели пропал бы: администратор,
 * никогда не открывавший эту карточку, всё равно навязал бы модели свои числа.
 *
 * Отсюда одно осознанное ограничение: `maxDetections` переопределяется только
 * ВВЕРХ от «нет потолка» — задать «снять потолок, который стоит в манифесте»
 * этой настройкой нельзя, потому что `null` уже занят под наследование. Случай
 * гипотетический (ни один выложенный манифест `max_detections` не задаёт), а
 * второй сентинел ради него сделал бы настройку нечитаемой.
 *
 * ## Почему это отдельный модуль, а не поле `manifestParams`
 *
 * Манифест описывает МОДЕЛЬ и проверяется жёстко; настройки описывают, как её
 * применяют сегодня, и меняются человеком в админке. Смешав их в одном разборе,
 * нельзя было бы ответить на вопрос «что здесь от модели, а что от оператора» —
 * а именно он и возникает, когда результат детекции расходится с ожидаемым.
 * Разделение сохраняет и провенанс: в снимок прогона уходит и то, и другое.
 */

import type { InferenceParams } from './manifest.js';
import { DETECTION_BLOCK_TYPES, type DetectionBlockType } from './postprocess.js';

/**
 * Переопределения из настроек портала.
 *
 * Отсутствующее либо `null` поле оставляет значение манифеста нетронутым.
 */
export interface InferenceParamOverrides {
  /** Порог принятия детекции для классов без собственного порога. */
  readonly defaultThreshold?: number | null;
  /** Пороги по классам; заданный класс перекрывает манифест, остальные остаются. */
  readonly perClassThresholds?: Readonly<Partial<Record<DetectionBlockType, number>>> | null;
  readonly nmsIou?: number | null;
  readonly mergeSplitText?: boolean | null;
  readonly maxDetections?: number | null;
}

/** Ничего не переопределено — параметры берутся из манифеста как есть. */
export const NO_PARAM_OVERRIDES: InferenceParamOverrides = {};

function unitOrNull(value: number | null | undefined): number | null {
  // Значение вне 0..1 не «поджимается» к границе, а отбрасывается: подогнанный
  // порог выглядел бы применённым и давал бы не тот результат, который
  // администратор задал. Схема настройки диапазон уже проверила — это второй
  // рубеж на случай значения, попавшего в базу мимо неё.
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

/**
 * Наложить переопределения на параметры манифеста.
 *
 * Чистая функция: ни настроек, ни БД, ни модели она не знает — на вход приходят
 * уже прочитанные значения. Это и делает её проверяемой без сессии ONNX.
 */
export function applyParamOverrides(
  params: InferenceParams,
  overrides: InferenceParamOverrides | null | undefined,
): InferenceParams {
  if (overrides === null || overrides === undefined) return params;

  const defaultThreshold = unitOrNull(overrides.defaultThreshold);
  const nmsIou = unitOrNull(overrides.nmsIou);

  // Пороги по классам сливаются, а не заменяют набор целиком: настройка на
  // один класс не должна снимать пороги остальных, иначе правка порога для
  // `stamp` молча меняла бы поведение `text`.
  let thresholds = params.thresholds;
  const perClass = overrides.perClassThresholds;
  if (perClass !== null && perClass !== undefined) {
    const merged: Partial<Record<DetectionBlockType, number>> = { ...params.thresholds };
    for (const type of DETECTION_BLOCK_TYPES) {
      const value = unitOrNull(perClass[type]);
      if (value !== null) merged[type] = value;
    }
    thresholds = merged;
  }

  const maxDetections =
    typeof overrides.maxDetections === 'number' &&
    Number.isInteger(overrides.maxDetections) &&
    overrides.maxDetections >= 1
      ? overrides.maxDetections
      : params.maxDetections;

  return {
    ...params,
    thresholds,
    defaultThreshold: defaultThreshold ?? params.defaultThreshold,
    nmsIou: nmsIou ?? params.nmsIou,
    mergeSplitText: overrides.mergeSplitText ?? params.mergeSplitText,
    maxDetections,
  };
}

/**
 * Что из переопределений реально изменило параметры — для снимка прогона и лога.
 *
 * Пишется именно РАЗНИЦА, а не сам объект настроек: «порог 0.5» в снимке не
 * отвечает на вопрос, пришёл он из манифеста или из админки, а
 * воспроизводимость прошлой разметки держится на этом ответе.
 */
export function describeAppliedOverrides(
  before: InferenceParams,
  after: InferenceParams,
): Record<string, unknown> {
  const applied: Record<string, unknown> = {};
  if (before.defaultThreshold !== after.defaultThreshold) {
    applied['default_threshold'] = { from: before.defaultThreshold, to: after.defaultThreshold };
  }
  if (before.nmsIou !== after.nmsIou) {
    applied['nms_iou'] = { from: before.nmsIou, to: after.nmsIou };
  }
  if (before.mergeSplitText !== after.mergeSplitText) {
    applied['merge_split_text'] = { from: before.mergeSplitText, to: after.mergeSplitText };
  }
  if (before.maxDetections !== after.maxDetections) {
    applied['max_detections'] = { from: before.maxDetections, to: after.maxDetections };
  }
  for (const type of DETECTION_BLOCK_TYPES) {
    if (before.thresholds[type] !== after.thresholds[type]) {
      applied[`threshold_${type}`] = {
        from: before.thresholds[type] ?? null,
        to: after.thresholds[type],
      };
    }
  }
  return applied;
}
