/**
 * Человекочитаемая причина отказа задачи — рядом с отпечатком, а не вместо него
 * (S44).
 *
 * ## Что решает этот файл
 *
 * `job_runs.error_message` нормализован: `normalizeErrorMessage` (ADR-0010)
 * вычёркивает числа намеренно. Иначе одинаковые дефекты разъезжались бы по
 * журналу на сотни уникальных строк, а в сообщение провайдера или Postgres
 * могли бы попасть данные документа.
 *
 * Плата за это видна на боевом прогоне: там, где задача не уложилась в аренду,
 * человек читал «попытка не уложилась в <n> мс». Отпечаток верен, а ответить на
 * вопрос «сколько ждали» по нему нельзя.
 *
 * ## Почему закрытый перечень, а не «взять исходное сообщение»
 *
 * Разница между этой функцией и «не нормализовывать» — в ИСТОЧНИКЕ строки.
 * Здесь текст собирается ЗАНОВО из типизированных полей СВОИХ классов ошибок:
 * `JobTimeoutError.timeoutMs` — число, которое портал сам и задал,
 * `LlmBudgetError.spent` — сумма, которую портал сам и посчитал. Ни одно из них
 * не приходит снаружи, и приписать к ним ПДн неоткуда.
 *
 * Всё остальное — сообщение провайдера, текст Postgres, ошибка чужой
 * библиотеки — даёт `null`, и плашка показывает нормализованный шаблон, как
 * показывала. Свойство «сюда не просачиваются ПДн» держится именно этим: не
 * фильтрацией строки, а тем, что чужая строка сюда не попадает вовсе.
 *
 * ## Почему по имени класса, а не `instanceof`
 *
 * Классы живут в двух пакетах, и `instanceof` через границу пакетов ломается
 * при дублировании зависимости молча — тем же приёмом и по той же причине, что
 * `deferralOf` и `retriableOf` в движке задач.
 */

/** Поля, которые причина читает у своих классов. Чужой объект их не имеет. */
interface OwnErrorShape {
  readonly name?: unknown;
  readonly timeoutMs?: unknown;
  readonly spent?: unknown;
  readonly budget?: unknown;
  readonly bytes?: unknown;
  readonly retryAfterMs?: unknown;
  readonly model?: unknown;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Секунды с одним знаком: «600.0 с» читается, «600011 мс» — считается. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}

/**
 * Причина отказа словами, либо `null` — «своим классом не является».
 *
 * `null` НЕ означает «причины нет»: он означает «эта причина не наша, и
 * пересказывать её своими словами портал не вправе».
 */
export function readableJobReason(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const own = error as OwnErrorShape;
  const name = typeof own.name === 'string' ? own.name : null;

  switch (name) {
    case 'JobTimeout': {
      const timeoutMs = numberOf(own.timeoutMs);
      return timeoutMs === null
        ? null
        : `Попытка не уложилась в отведённое время (${seconds(timeoutMs)}).`;
    }
    case 'LeaseLost':
      return 'Аренду задачи подобрал другой воркер: попытка прервана без потери работы.';
    case 'LlmBudgetError': {
      const spent = numberOf(own.spent);
      const budget = numberOf(own.budget);
      return spent === null || budget === null
        ? null
        : `Месячный бюджет модели исчерпан: потрачено ${spent.toFixed(2)} из ${budget.toFixed(2)}.`;
    }
    case 'LlmRateLimitError': {
      const retryAfterMs = numberOf(own.retryAfterMs);
      return retryAfterMs === null
        ? 'Шлюз модели ограничил частоту запросов.'
        : `Шлюз модели ограничил частоту запросов и просит подождать ${seconds(retryAfterMs)}.`;
    }
    case 'LlmTimeoutError': {
      const timeoutMs = numberOf(own.timeoutMs);
      return timeoutMs === null
        ? null
        : `Модель не ответила за отведённое время (${seconds(timeoutMs)}).`;
    }
    case 'LlmPayloadTooLargeError': {
      const bytes = numberOf(own.bytes);
      return bytes === null
        ? null
        : `Запрос к модели не пролез в шлюз: ${String(Math.round(bytes / 1024))} КБ.`;
    }
    case 'LlmDisabledError':
      return 'Обращения к модели выключены настройкой портала.';
    case 'LlmModelNotAllowedError': {
      // Имя модели — не ПДн: оно приходит из настройки портала, а не из скана.
      const model = typeof own.model === 'string' ? own.model : null;
      return model === null
        ? 'Модель не входит в список разрешённых.'
        : `Модель «${model}» не входит в список разрешённых.`;
    }
    default:
      // Сообщение провайдера, текст Postgres, ошибка чужой библиотеки. Портал
      // пересказывать их не берётся: плашка покажет нормализованный шаблон.
      return null;
  }
}
