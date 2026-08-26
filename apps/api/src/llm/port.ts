/**
 * Порт внешней LLM (§10): форма запроса, форма ответа и классы отказов.
 *
 * ## Почему порт принимает ТОЛЬКО строки
 *
 * §10 требует: «Raw PDF и изображения внешней LLM не отправляются — только
 * распознанный текст и структурированный JSON». Это требование выражено формой
 * типа, а не дисциплиной вызывающего: в `LlmRequest` нет ни `Buffer`, ни
 * `Uint8Array`, ни поля под адрес изображения, поэтому «случайно приложить
 * страницу PDF» здесь нельзя — код просто не соберётся. Дисциплина в этом месте
 * не работает: отправка картинки выглядит как безобидная оптимизация качества,
 * а обнаруживается она не тестом, а утечкой ИД наружу.
 *
 * ## Почему стоимость и токены допускают `null`
 *
 * Их сообщает провайдер, и он вправе их не сообщать. Ноль вместо отсутствия
 * означал бы «вызов был бесплатным», и бюджет §11 считался бы по выдуманным
 * данным: сумма `ai_runs.cost` тихо занижалась бы, а порог не срабатывал.
 *
 * ## Почему у каждой ошибки есть `retriable`
 *
 * Решение о повторе принимает движок задач, а не место вызова. Отказ по
 * бюджету, по allowlist и по схеме ответа повторять бессмысленно: пять попыток
 * дадут пять одинаковых отказов и пять записей в `ai_runs`. Повтор оправдан на
 * лимите частоты, таймауте и сетевом сбое.
 */

/**
 * Стадии §10; совпадают с CHECK `ai_runs_stage_chk` (миграция 0004,
 * расширена 0019 значением `recognize` для VLM-распознавания по кропам
 * блоков, ADR-0007). `recognize` использует не этот текстовый порт, а
 * `VlmPort` (`vlm-port.ts`) — стадия здесь нужна только как значение поля
 * `ai_runs.stage`, разделяемое обоими путями аудита.
 */
export type LlmStage =
  'page_classify' | 'doc_split' | 'extract' | 'check' | 'summary' | 'recognize';

/** Провайдеры; совпадают с CHECK `ai_runs_provider_chk`. `rdweb` заблокирован (§0.3 п.6). */
export type LlmProviderName = 'proxy_llm' | 'rdweb' | 'recorded';

export interface LlmRequest {
  readonly stage: LlmStage;
  readonly promptCode: string;
  readonly promptVersion: number;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Версия схемы ответа — входит в ключ кэша. */
  readonly schemaVersion: string;
  /** Соседний контекст (страницы вокруг) — входит в ключ кэша, но НЕ в промт дважды. */
  readonly cacheContext: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface LlmResponse {
  /** Сырой ответ модели: разбор и проверка по схеме — обязанность вызывающего. */
  readonly text: string;
  readonly model: string;
  readonly provider: LlmProviderName;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** Стоимость вызова; `null` — провайдер её не сообщил. */
  readonly cost: number | null;
  readonly latencyMs: number;
  /** sha256 полного эффективного промта, hex. Он же `ai_runs.input_hash`. */
  readonly inputHash: string;
  /** sha256 текста ответа, hex. Он же `ai_runs.output_hash`. */
  readonly outputHash: string;
  readonly cacheHit: boolean;
}

export interface LlmPort {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/**
 * Состоявшаяся попытка вызова — то, за что уже заплачено или могло быть.
 *
 * Провайдер знает `inputHash` и модель ДО того, как отправит запрос, и обязан
 * приложить их к отказу. Без этого таймаут не оставлял в `ai_runs` ни строки:
 * вызов был, деньги могли уйти, а следа нет — то есть §11 считал траты меньше
 * фактических, а расследование «почему страница осталась неопознанной»
 * упиралось в пустой аудит.
 */
export interface LlmAttempt {
  readonly provider: LlmProviderName;
  readonly model: string;
  /** sha256 полного эффективного промта, hex. Он же `ai_runs.input_hash`. */
  readonly inputHash: string;
  readonly latencyMs: number;
}

/**
 * Базовый класс отказов LLM.
 *
 * Конкретный класс — часть контракта порта: вызывающий обязан различать
 * «модель запрещена политикой» и «провайдер не ответил», иначе первое
 * превратится в бесконечные повторы, а второе — в тихую остановку конвейера.
 *
 * ## Два независимых вопроса, а не один
 *
 * `retriable` отвечает «поможет ли повтор ЭТОГО вызова», `stopsBatch` —
 * «имеет ли смысл продолжать обход остальных страниц». Свести их нельзя:
 * непригодный ответ модели на одной странице неповторяем, но остальные
 * страницы обработать надо; исчерпанный бюджет тоже неповторяем, и остальные
 * страницы обрабатывать уже нечем. До разделения цикл классификации при
 * исчерпанном бюджете дёргал провайдера на каждой оставшейся странице — по
 * разу на страницу, все восемьдесят три.
 */
export class LlmError extends Error {
  readonly retriable: boolean;
  /** Отказ относится ко всем последующим вызовам, а не только к этому. */
  readonly stopsBatch: boolean;
  /**
   * Попытка, если вызов дошёл до провайдера. `null` — отказ до сборки промта.
   *
   * Мутируемое поле: заполняет его провайдер по пути наружу, там где хэш
   * промта уже посчитан. Собирать его в конструкторе нельзя — половина
   * отказов рождается в местах, где модель ещё не выбрана.
   */
  attempt: LlmAttempt | null = null;

  constructor(
    message: string,
    options: {
      readonly retriable: boolean;
      readonly stopsBatch?: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmError';
    this.retriable = options.retriable;
    this.stopsBatch = options.stopsBatch ?? false;
  }
}

/**
 * Прикладывает к отказу состоявшуюся попытку и отдаёт его дальше.
 *
 * Отдельная функция, потому что делать это обязаны ОБА провайдера и обе
 * половины каждого из них (политика до сети и сама сеть). Разложенное по
 * четырём местам присваивание разошлось бы при первой правке.
 */
export function withAttempt(error: unknown, attempt: LlmAttempt): unknown {
  if (error instanceof LlmError && error.attempt === null) error.attempt = attempt;
  return error;
}

/** Провайдер существует в перечислении, но включать его нельзя (§0.3 п.6). */
export class LlmBlockedProviderError extends LlmError {
  readonly provider: LlmProviderName;

  constructor(provider: LlmProviderName, message: string) {
    super(message, { retriable: false, stopsBatch: true });
    this.name = 'LlmBlockedProviderError';
    this.provider = provider;
  }
}

/** LLM не подключена. Это штатное состояние, а не ошибка конфигурации (§0.5). */
export class LlmDisabledError extends LlmError {
  constructor(message: string) {
    super(message, { retriable: false, stopsBatch: true });
    this.name = 'LlmDisabledError';
  }
}

/** Модель вне `LLM_MODEL_ALLOWLIST`. Отказ до сетевого вызова. */
export class LlmModelNotAllowedError extends LlmError {
  readonly model: string;

  constructor(model: string, message: string) {
    super(message, { retriable: false, stopsBatch: true });
    this.name = 'LlmModelNotAllowedError';
    this.model = model;
  }
}

/** Месячный бюджет `LLM_BUDGET_MONTHLY` исчерпан. Повтор не поможет. */
export class LlmBudgetError extends LlmError {
  readonly spent: number;
  readonly budget: number;

  constructor(message: string, options: { readonly spent: number; readonly budget: number }) {
    // Повтор бюджет не восстановит, и следующая страница упрётся в тот же
    // порог: продолжать обход бессмысленно, а не просто бесполезно.
    super(message, { retriable: false, stopsBatch: true });
    this.name = 'LlmBudgetError';
    this.spent = options.spent;
    this.budget = options.budget;
  }
}

/** Превышен `LLM_RATE_LIMIT_PER_MIN` либо провайдер ответил 429. */
export class LlmRateLimitError extends LlmError {
  constructor(message: string) {
    super(message, { retriable: true });
    this.name = 'LlmRateLimitError';
  }
}

export class LlmTimeoutError extends LlmError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message: string) {
    super(message, { retriable: true });
    this.name = 'LlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Шлюз ответил, но ответа модели в его теле нет.
 *
 * ## Почему это отдельный класс, а не `LlmProtocolError`
 *
 * Оба выглядят одинаково — «разбирать нечего», — но чинятся противоположным.
 * Непригодный ответ детерминирован: тот же промт даст тот же мусор, и повтор
 * лишь потратит бюджет. Молчание провайдера случайно: тело без `choices` —
 * это ровно то, что возвращает шлюз, когда апстрим отказал на его стороне, и
 * следующий такой же запрос обычно проходит.
 *
 * Разделение сделано по замеру, а не по вкусу. На боевых прогонах восемь
 * вызовов получили ответ без `choices` — все с `actualModel: null` и нулевым
 * учётом токенов, — и семь из восьми прошли со следующей же попытки. Восьмой
 * стоил комплекту всего прогона: класс был неповторяемым, движок задач повтора
 * не давал, блок оставался непокрытым, и финализация закрывала прогон отказом
 * по неполному покрытию.
 */
export class LlmUpstreamError extends LlmError {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { retriable: true, ...options });
    this.name = 'LlmUpstreamError';
  }
}

/**
 * Ответ не разобрался: не JSON либо в `choices[0]` нет пригодного текста.
 *
 * Не повторяется намеренно: детерминированный промт даёт детерминированно
 * непригодный ответ, а повтор лишь потратит бюджет. Дефект здесь — в промте
 * или в модели, и чинится он человеком. Случай «шлюз не вернул `choices`
 * вовсе» сюда НЕ относится — он `LlmUpstreamError` (см. выше).
 */
export class LlmProtocolError extends LlmError {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { retriable: false, ...options });
    this.name = 'LlmProtocolError';
  }
}

/**
 * Тело запроса не пролезает в шлюз: сработал предохранитель до отправки
 * либо шлюз ответил 413.
 *
 * Повтор ТОГО ЖЕ тела бессмысленен — оно упрётся в тот же потолок, поэтому
 * `retriable: false`. Но и прогон это не останавливает: остальные блоки могут
 * быть меньше. Класс отдельный, а не `LlmTransportError`, потому что по нему
 * принимается решение, недоступное по коду статуса: вызывающий обязан один раз
 * уменьшить кроп (downscale-retry, crop policy Ф4а) и повторить уже ДРУГОЕ
 * тело — а сетевую ошибку так чинить нечем.
 */
export class LlmPayloadTooLargeError extends LlmError {
  /** Размер сериализованного тела, байт: без него не подобрать downscale. */
  readonly bytes: number;

  constructor(bytes: number, message: string) {
    super(message, { retriable: false, stopsBatch: false });
    this.name = 'LlmPayloadTooLargeError';
    this.bytes = bytes;
  }
}

/** Сетевой сбой или неуспешный HTTP-статус. Повторяемость — по статусу. */
export class LlmTransportError extends LlmError {
  readonly status: number | undefined;

  constructor(message: string, options: { readonly status?: number | undefined } = {}) {
    super(message, { retriable: isRetriableStatus(options.status) });
    this.name = 'LlmTransportError';
    this.status = options.status;
  }
}

/**
 * У двойника нет записанного ответа на этот хэш промта.
 *
 * Отдельный класс, а не «правдоподобный ответ по умолчанию»: см. `recorded.ts`.
 */
export class LlmRecordingMissingError extends LlmError {
  readonly promptHash: string;

  constructor(promptHash: string, message: string) {
    super(message, { retriable: false });
    this.name = 'LlmRecordingMissingError';
    this.promptHash = promptHash;
  }
}

/**
 * Повторять ли вызов по HTTP-статусу — та же логика, что у `RdWebError`.
 *
 * 4xx, кроме 429, — отказ по существу запроса: повтор даст тот же ответ.
 * Отсутствие статуса означает, что ответа не было вовсе (сеть, DNS, TLS) — это
 * внешняя и преходящая причина.
 */
function isRetriableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}
