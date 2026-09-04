/**
 * Приём ошибок браузера (§11): `POST /api/v1/client-errors`.
 *
 * ## Почему без сессии
 *
 * Экран входа — часть портала, и его поломка самая опасная: пользователь не
 * может даже сообщить о ней изнутри. Маршрут, требующий сессии, оставил бы
 * невидимым ровно тот класс отказов, из-за которого войти нельзя. Поэтому он
 * внесён в исключения CSRF-хука по образцу `PUBLIC_LOCAL_AUTH_ROUTES` и закрыт
 * теми же `sameOriginGuard` + `jsonOnlyGuard`.
 *
 * ## Почему одних этих стражей мало
 *
 * `sameOriginGuard` осознанно ПРОПУСКАЕТ запрос без `Sec-Fetch-Site` и без
 * `Origin` — то есть от `curl` он не защищает и защищать не должен: CSRF по
 * определению про браузер. Для маршрута, который пишет в БД и доступен всем,
 * этого недостаточно: поток уникальных сообщений с чужой машины создавал бы
 * новые сигнатуры без ограничения. Поэтому здесь три независимых рубежа:
 *
 *   1. лимит на IP (`CLIENT_ERROR_RATE_LIMIT_MAX`) — плагин Fastify;
 *   2. общий лимит на установку (`CLIENT_ERROR_GLOBAL_LIMIT_PER_MIN`) — счётчик
 *      в памяти процесса, на случай распределённого источника;
 *   3. потолок новых сигнатур в час в самом писателе — последний рубеж, общий
 *      для всех источников.
 *
 * Первые два отвечают 429 и не пишут ничего; третий учитывает событие
 * счётчиком служебной проблемы. «Журнал захлебнулся» обязано быть видно, но не
 * ценой роста таблиц.
 *
 * ## Телу запроса не верят ни в одном поле
 *
 * `user_id` берётся из сессии, если она есть, а не из тела; классификацию
 * (`source`, `execution`, `domain`) ставит сервер; отпечаток считается на
 * сервере; сообщение проходит `normalizeErrorMessage`, стек — сокращение до
 * своих кадров, адрес — срез строки запроса, контекст — `redactDeep`. Клиент
 * сообщает только то, чего сервер знать не может: что именно упало, где в
 * коде и сколько раз это повторилось на вкладке.
 *
 * ## Почему хэш сборки вырезается из кадров стека
 *
 * Vite кладёт в имя файла хэш содержимого (`index-a1b2c3.js`), и он меняется с
 * каждой сборкой. Без нормализации одна и та же ошибка после каждого деплоя
 * заводила бы новую сигнатуру, а ряд по релизам — единственное, ради чего эти
 * записи вообще нужны, — расщеплялся бы на одноразовые куски.
 */
import { z } from 'zod';
import type { AppInstance } from '../../app.js';
import { jsonOnlyGuard, sameOriginGuard } from '../../auth/local/origin-guard.js';
import { tooManyRequests } from '../../lib/problem.js';
import { normalizeErrorMessage } from '../../observability/errors.js';

export const CLIENT_ERRORS_PATH = '/api/v1/client-errors';

/** Сколько кадров стека браузера сохраняется: больше в разборе не участвует. */
const MAX_FRAMES = 5;
const MAX_MESSAGE = 500;
const MAX_STACK = 4_000;

/**
 * Виды события, которые различает КЛИЕНТ.
 *
 * Это не классификация журнала (её ставит сервер), а обстоятельство: упало при
 * отрисовке, в необработанном промисе или в обработчике события. Оно попадает
 * в контекст примера и помогает понять, почему стека может не быть.
 */
const CLIENT_KINDS = ['render', 'unhandled_rejection', 'window_error', 'manual'] as const;

const bodySchema = z.object({
  /** Класс ошибки в браузере: `TypeError`, `ChunkLoadError` и подобные. */
  name: z.string().min(1).max(120),
  message: z.string().min(1).max(MAX_MESSAGE),
  stack: z.string().max(MAX_STACK).optional(),
  kind: z.enum(CLIENT_KINDS),
  /** Адрес страницы. Строка запроса срезается на сервере: в ней бывают ПДн. */
  url: z.string().max(1_000).optional(),
  /** Стек компонентов React: имена компонентов, не данные. */
  componentStack: z.string().max(MAX_STACK).optional(),
  /** Идентификатор сборки: без него кадры стека не сопоставить с исходниками. */
  buildId: z.string().max(120).optional(),
  /**
   * Идентификатор события, показанный пользователю.
   *
   * У ошибки отрисовки нет `request_id` — запроса не было, — и обращение «у
   * меня всё сломалось, вот номер» иначе не с чем сопоставить.
   */
  clientEventId: z.uuid(),
  /** Сколько раз вкладка наблюдала эту ошибку до отправки. */
  repeatCount: z.coerce.number().int().min(1).max(10_000).default(1),
  /**
   * Статус чужого сервиса, отказ которого и есть эта ошибка.
   *
   * Появляется там, где браузер ходит МИМО портала: единственный такой путь —
   * заливка байтов в S3 по presigned-адресу (§4.2). У отказа обращения к самому
   * порталу этих полей нет: он приезжает в журнал со стороны сервера вместе с
   * `request_id`, и брать статус из тела значило бы позволить клиенту назвать
   * его самому.
   */
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  /**
   * Код отказа чужого сервиса: `InternalError`, `SlowDown`, `AccessDenied`.
   *
   * Форма проверяется жёстко, потому что значение приходит СНАРУЖИ и становится
   * осью `error_code` журнала: ось — это идентификатор, по которому группируют,
   * а не место для текста, тем более пользовательского.
   */
  errorCode: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u, 'errorCode — идентификатор из латиницы и цифр')
    .optional(),
});

/**
 * Общий счётчик на установку.
 *
 * В памяти процесса, а не в БД: рубеж существует, чтобы НЕ ходить в БД под
 * потоком, и счётчик в ней противоречил бы собственной цели. Пробитие лимита
 * несколькими процессами кратно числу процессов — приемлемо: последний рубеж
 * (потолок сигнатур) общий и живёт в БД.
 */
class MinuteQuota {
  #windowStartedAt = 0;
  #used = 0;

  constructor(private readonly limit: number) {}

  tryTake(now: number): boolean {
    if (now - this.#windowStartedAt >= 60_000) {
      this.#windowStartedAt = now;
      this.#used = 0;
    }
    if (this.#used >= this.limit) return false;
    this.#used += 1;
    return true;
  }
}

/** Кадры своего кода: `node_modules` и адреса расширений браузера отброшены. */
function ownFrames(stack: string | undefined): string[] {
  if (stack === undefined) return [];

  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('at ') && !frame.includes('@')) continue;
    // Расширения браузера — чужой код в нашей странице: их падения не наши.
    if (/chrome-extension:|moz-extension:|safari-extension:/u.test(frame)) continue;
    if (frame.includes('node_modules')) continue;

    frames.push(normalizeFrame(frame));
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/**
 * Кадр без хэша сборки, номера строки и адреса.
 *
 * Номер строки убирается по той же причине, что и в серверных отпечатках:
 * правка файла выше по тексту расщепляла бы счётчик существующей ошибки.
 */
function normalizeFrame(frame: string): string {
  return frame
    .replace(/https?:\/\/[^\s)]+\//gu, '')
    .replace(/-[0-9a-zA-Z_]{6,}\.(js|mjs|css)/gu, '.$1')
    .replace(/:\d+:\d+\)?/gu, '')
    .slice(0, 300);
}

/** Адрес без строки запроса: в ней приезжают поисковые строки с ПДн. */
function pathOfUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
  } catch {
    const cut = url.indexOf('?');
    return (cut < 0 ? url : url.slice(0, cut)).slice(0, 300);
  }
}

/**
 * Ошибка, восстановленная из отчёта браузера.
 *
 * Собственный класс, а не `Error` с подменённым `name`: отпечаток считается по
 * `name`, и одинаковые `TypeError` из браузера и из Node обязаны различаться
 * хотя бы источником. Источник задаётся осью `source: 'web'`, а стек
 * подставляется уже нормализованным — сервер не доверяет исходному тексту.
 */
class ClientError extends Error {
  /**
   * Код отказа чужого сервиса.
   *
   * Именно `code`, а не собственное поле: ось `error_code` журнала выводится
   * `fieldInChain(error, 'code')` — тем же способом, что SQLSTATE у отказов
   * базы. Своё имя потребовало бы правки общего разбора ради одного источника.
   */
  readonly code: string | undefined;

  constructor(name: string, message: string, frames: readonly string[], code: string | undefined) {
    super(message);
    this.name = name;
    this.code = code;
    this.stack = [`${name}: ${message}`, ...frames.map((frame) => `    ${frame}`)].join('\n');
  }
}

export function registerClientErrorRoutes(app: AppInstance): void {
  const { env } = app;
  if (!env.CLIENT_ERROR_REPORTING) return;

  const originGuard = sameOriginGuard(env);
  const quota = new MinuteQuota(env.CLIENT_ERROR_GLOBAL_LIMIT_PER_MIN);

  app.post(
    CLIENT_ERRORS_PATH,
    {
      schema: { body: bodySchema, response: { 204: z.null() } },
      config: {
        rateLimit: { max: env.CLIENT_ERROR_RATE_LIMIT_MAX, timeWindow: 60_000 },
      },
      onRequest: [originGuard, jsonOnlyGuard],
    },
    async (request, reply) => {
      if (!quota.tryTake(Date.now())) {
        // 429, а не тихое отбрасывание: клиент обязан понять, что отчёт не
        // принят, и не считать себя услышанным.
        throw tooManyRequests(60, 'Слишком много отчётов об ошибках.', {
          logDetail: 'общий лимит приёма клиентских ошибок за минуту исчерпан',
        });
      }

      const body = request.body;
      const frames = ownFrames(body.stack);
      const error = new ClientError(
        body.name,
        // Нормализация здесь, а не только в отпечатке: в `message` браузера
        // попадает и содержимое страницы («Cannot read properties of null»
        // безобидно, а вот текст из ответа сервера — нет).
        normalizeErrorMessage(body.message),
        frames,
        body.errorCode,
      );

      await app.errorReporter.report(error, {
        source: 'web',
        execution: 'client',
        // Домен браузерной ошибки — всегда приложение: определить его точнее
        // по отчёту нельзя, а гадать значит засорить срез по категориям.
        domain: 'application',
        severity: 'error',
        clientEventId: body.clientEventId,
        repeatCount: body.repeatCount,
        ...(body.statusCode === undefined ? {} : { statusCode: body.statusCode }),
        // Пользователь — из сессии, если она есть. Из тела его брать нельзя:
        // это позволило бы приписать чужую ошибку кому угодно.
        ...(request.authContext?.user.id === undefined
          ? {}
          : { userId: request.authContext.user.id }),
        ...(pathOfUrl(body.url) === undefined ? {} : { route: pathOfUrl(body.url) }),
        extra: {
          client_kind: body.kind,
          ...(body.buildId === undefined ? {} : { build_id: body.buildId }),
          // Стек компонентов — имена компонентов, не данные. Он всё равно
          // проходит общую очистку контекста.
          ...(body.componentStack === undefined
            ? {}
            : { component_stack: body.componentStack.split('\n').slice(0, MAX_FRAMES).join('\n') }),
        },
      });

      return reply.code(204).send(null);
    },
  );
}
