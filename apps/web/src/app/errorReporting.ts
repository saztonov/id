/**
 * Отправка ошибок браузера в журнал портала (§11).
 *
 * ## Чем это ограничено и почему
 *
 * Модуль работает на стороне пользователя и обязан быть дешевле проблемы,
 * которую диагностирует. Отсюда четыре ограничения, каждое из которых снимает
 * свой способ навредить:
 *
 * 1. **Один отчёт на отпечаток за жизнь вкладки.** Цикл отрисовки способен
 *    бросить одно и то же исключение десятки раз в секунду; без подавления
 *    вкладка сама себе устроила бы отказ в обслуживании.
 * 2. **Потолок отправок на вкладку.** Разные отпечатки тоже могут идти
 *    потоком — например, когда сломан общий модуль.
 * 3. **Повторы считаются, а не теряются.** Подавленные отчёты увеличивают
 *    `repeatCount` следующего; без этого частота веб-ошибок в журнале была бы
 *    заведомо заниженной, причём незаметно.
 * 4. **Сбой самой отправки не отправляется.** Иначе первая же сетевая ошибка
 *    порождает вторую, и так до потолка.
 *
 * ## Почему `sendBeacon`
 *
 * Ошибка часто совпадает с уходом со страницы (пользователь закрывает
 * сломавшуюся вкладку), а обычный `fetch` в этот момент браузер отменяет.
 * `sendBeacon` ставит запрос в очередь браузера и переживает выгрузку. Ответ он
 * не отдаёт — и это не потеря: показать пользователю нужно `clientEventId`,
 * который сгенерирован здесь же, а не то, что ответил сервер.
 */
import { CLIENT_ERROR_PATH, type ClientErrorKind, type ClientErrorReport } from '../api/types.js';
// Метка выкатки объявлена в одном месте на весь фронт: её же читает плашка
// «доступна новая версия», и разойтись в трактовке пустого значения им нельзя.
import { BUILD_ID } from './buildVersion.js';

/** Потолок отправок за жизнь вкладки. */
const MAX_REPORTS_PER_TAB = 10;
const MAX_MESSAGE = 500;
const MAX_STACK = 4_000;

interface Suppressed {
  /** Сколько раз ошибка повторилась после отправки первого отчёта. */
  repeats: number;
}

const seen = new Map<string, Suppressed>();
let sent = 0;
/** Защита от рекурсии: пока идёт отправка, новые отчёты не принимаются. */
let sending = false;

/**
 * Отпечаток на стороне клиента — только для подавления повторов.
 *
 * Настоящий отпечаток считает сервер: клиентскому доверять нельзя, а
 * согласовывать два алгоритма значило бы поддерживать их одинаковыми вечно.
 * Здесь достаточно грубого совпадения класса, сообщения и первого кадра.
 */
function localKey(name: string, message: string, stack: string | undefined): string {
  const frame = (stack ?? '').split('\n')[1]?.trim() ?? '';
  return `${name}|${message}|${frame}`.slice(0, 400);
}

function nameOf(error: unknown): string {
  if (error instanceof Error && error.name !== '') return error.name;
  if (typeof error === 'string') return 'StringThrown';
  return 'UnknownError';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? 'нераспознанная ошибка';
  } catch {
    return 'нераспознанная ошибка';
  }
}

/**
 * Отказ, о котором сообщать нечего.
 *
 * Отменённые запросы и уход со страницы — не поломки: их порождает сам
 * пользователь, закрывая экран. Если их не отсеять, журнал заполнится шумом,
 * который выглядит как отказ портала.
 */
function isNoise(error: unknown): boolean {
  const name = nameOf(error);
  if (name === 'AbortError' || name === 'CanceledError') return true;
  const message = messageOf(error);
  return /NetworkError when attempting to fetch|Load failed|The operation was aborted/u.test(
    message,
  );
}

export interface ReportOptions {
  readonly kind: ClientErrorKind;
  readonly componentStack?: string | undefined;
  /** Статус и код отказа чужого сервиса — см. `ClientErrorReport`. */
  readonly statusCode?: number | undefined;
  readonly errorCode?: string | undefined;
}

/**
 * Отправляет отчёт и возвращает идентификатор события.
 *
 * Идентификатор возвращается ВСЕГДА, даже когда отчёт подавлен: он показывается
 * пользователю, и «номер обращения выдаётся не всегда» было бы худшим из
 * возможных поведений — человек не знает, что его случай сочли повтором.
 */
export function reportClientError(error: unknown, options: ReportOptions): string {
  const clientEventId = crypto.randomUUID();
  if (sending || isNoise(error)) return clientEventId;

  const name = nameOf(error);
  const message = messageOf(error).slice(0, MAX_MESSAGE);
  const stack = error instanceof Error ? error.stack?.slice(0, MAX_STACK) : undefined;
  const key = localKey(name, message, stack);

  const known = seen.get(key);
  if (known !== undefined) {
    known.repeats += 1;
    return clientEventId;
  }
  if (sent >= MAX_REPORTS_PER_TAB) return clientEventId;

  seen.set(key, { repeats: 0 });
  sent += 1;

  const report: ClientErrorReport = {
    name,
    message,
    kind: options.kind,
    clientEventId,
    repeatCount: 1,
    ...(stack === undefined ? {} : { stack }),
    ...(options.componentStack === undefined ? {} : { componentStack: options.componentStack }),
    ...(options.statusCode === undefined ? {} : { statusCode: options.statusCode }),
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
    ...(BUILD_ID === undefined ? {} : { buildId: BUILD_ID }),
    ...(typeof location === 'undefined' ? {} : { url: location.href }),
  };

  send(report);
  return clientEventId;
}

function send(report: ClientErrorReport): void {
  const body = JSON.stringify(report);
  sending = true;
  try {
    // `application/json` обязателен: маршрут закрыт `jsonOnlyGuard`, и любой
    // другой тип содержимого будет отвергнут — как и форма с чужой страницы.
    const blob = new Blob([body], { type: 'application/json' });
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(CLIENT_ERROR_PATH, blob))
      return;

    void fetch(CLIENT_ERROR_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
      // `keepalive`: запрос обязан пережить уход со страницы, иначе отчёт о
      // поломке, которая заставила пользователя закрыть вкладку, не уйдёт.
      keepalive: true,
      // Сбой отправки глотается намеренно: сообщать о нём некому и нечем, а
      // попытка сообщить порождает следующий отчёт.
    }).catch(() => undefined);
  } finally {
    sending = false;
  }
}

/**
 * Ставит перехватчики на необработанные ошибки вкладки.
 *
 * Возвращает функцию снятия — она нужна тестам; в приложении перехватчики
 * живут столько же, сколько вкладка.
 */
export function installClientErrorReporting(): () => void {
  const onError = (event: ErrorEvent): void => {
    reportClientError(event.error ?? event.message, { kind: 'window_error' });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    reportClientError(event.reason, { kind: 'unhandled_rejection' });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Сброс состояния подавления. Только для тестов. */
export function resetClientErrorReporting(): void {
  seen.clear();
  sent = 0;
  sending = false;
}
