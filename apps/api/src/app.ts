/**
 * Сборка приложения Fastify.
 *
 * `buildApp()` не слушает порт: это делает `server.ts`. Разделение нужно для
 * тестов — `app.inject()` проходит весь конвейер плагинов и хуков без сокета,
 * поэтому проверки изоляции RBAC и CSRF (§1.6, non-degradable) выполняются на
 * настоящем приложении, а не на выдуманном.
 *
 * Порядок регистрации значим и не переставляется:
 *   журнал запроса → helmet → rate-limit → cookie → csrf-protection → сессия →
 *   CSRF → маршруты.
 * Хук журнала первый: строка о запросе и метрика обязаны появиться и у запроса,
 * отвергнутого лимитом или проверкой CSRF, — иначе именно атакующий трафик в
 * наблюдаемости не виден. Cookie раньше сессии, потому что сессия читается из
 * cookie. Сессия раньше CSRF, потому что CSRF-токен сверяется с хэшем, лежащим
 * в сессии. Плагины ожидаются `await`, иначе их собственные `onRequest`-хуки
 * встали бы ПОСЛЕ наших, и хук сессии искал бы `request.cookies` до того, как их
 * разберут.
 *
 * Наблюдаемость (§11) собирается здесь целиком и из готовых модулей
 * `observability/`: логгер с redaction, строка запроса с шаблоном маршрута,
 * тайминги пула, метрики Prometheus, регистрация ошибок в `error_events`.
 * Собственной конфигурации pino в этом файле нет намеренно: две конфигурации
 * redaction означают, что одна из них однажды отстанет от другой, и отстанет
 * молча.
 */
import fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import cookie from '@fastify/cookie';
import csrfProtection from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { closePool, createPool } from '@id/db';
import type { ProblemError } from '@id/contracts';
import { loadEnv, trustProxyOption, type Env } from './config/env.js';
import { createAuthProvider, type AuthProvider } from './auth/oidc.js';
import { registerAuthRoutes } from './auth/routes.js';
import {
  cookieSecurity,
  createSessionCipher,
  CSRF_HEADER,
  SessionStore,
  type SessionCipher,
} from './auth/session.js';
import { csrfGuardHook, sessionContextHook } from './middleware/require-auth.js';
import { instrumentPool } from './observability/db-timing.js';
import {
  createErrorReporter,
  errorDigest,
  normalizeErrorMessage,
  type ErrorReporter,
  type SqlExecutor,
} from './observability/errors.js';
import { createLogger, type AppLogger } from './observability/logger.js';
import { createMetrics, type Metrics } from './observability/metrics.js';
import {
  createRequestLogHandler,
  setRequestLogFields,
  UNKNOWN_ROUTE,
} from './observability/request-log.js';
import {
  type HttpProblem,
  internal,
  notFound,
  PROBLEM_JSON_CONTENT_TYPE,
  problemBody,
  requestInstance,
  toHttpProblem,
  tooManyRequests,
  unprocessable,
} from './lib/problem.js';
import { registerAdminRoutes } from './modules/admin/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCatalogRoutes } from './modules/catalog/routes.js';
import { registerObjectRuleProfileRoutes } from './modules/catalog/object-rule-profiles.js';

/** Тела JSON. Файлы идут в S3 мимо API, поэтому лимит маленький. */
const JSON_BODY_LIMIT_BYTES = 1_048_576;

/** Больше — уже не помощь клиенту, а вывод внутренней схемы наружу. */
const MAX_REPORTED_VALIDATION_ERRORS = 50;

/**
 * Формат `X-Request-Id`, который принимается от доверенного прокси.
 *
 * Узкий намеренно: значение попадает в каждую строку журнала и в тело
 * problem+json, поэтому в нём не должно быть ничего, что можно прочитать как
 * разметку, кавычку или разделитель полей лога.
 */
const TRUSTED_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Различает строки API и воркера в общем потоке журнала, метка метрик. */
const SERVICE_NAME = 'api';

/** Наружу не публикуется: ограничение делает nginx (§11). */
const METRICS_PATH = '/metrics';

/**
 * Пути без строки журнала и без метрик.
 *
 * Балансировщик опрашивает готовность раз в секунду, Prometheus — раз в
 * интервал сбора. Их записи вытеснили бы из журнала контейнера всё остальное, а
 * в гистограмме HTTP дали бы серию, по которой ничего не диагностируется.
 */
const UNLOGGED_PATHS: readonly string[] = ['/health/live', '/health/ready', METRICS_PATH];

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    pool: Pool;
    db: NodePgDatabase;
    sessions: SessionStore;
    sessionCipher: SessionCipher;
    authProvider: AuthProvider;
    metrics: Metrics;
    /** Регистрация ошибок в `error_events` (§11): нужна и `server.ts`. */
    errorReporter: ErrorReporter;
  }
}

export interface BuildAppOptions {
  readonly env?: Env;
  /** Готовый пул (тесты, pglite). Переданный извне пул не закрывается при shutdown. */
  readonly pool?: Pool;
  readonly authProvider?: AuthProvider;
  /**
   * Готовый логгер. Нужен проверкам, которые читают сам поток журнала: подмена
   * приёмника — единственный способ доказать, что значение не ушло в stdout.
   */
  readonly logger?: AppLogger;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<AppInstance> {
  const env = options.env ?? loadEnv();
  const ownsPool = options.pool === undefined;
  const pool =
    options.pool ??
    createPool({
      connectionString: env.DATABASE_URL,
      max: env.PG_POOL_MAX,
      ...(env.PG_CA_CERT_PATH !== undefined ? { caCertPath: env.PG_CA_CERT_PATH } : {}),
      applicationName: 'id-portal-api',
    });

  // Логгер собирается модулем наблюдаемости, а не описывается здесь: redaction
  // по списку §11 — это ~500 путей, свой censor для presigned URL и свои
  // сериализаторы `err`/`req`/`res`. Вторая, «упрощённая» конфигурация в этом
  // файле означала бы, что журнал защищён не тем, что проверено тестами.
  const logger =
    options.logger ??
    createLogger({
      service: SERVICE_NAME,
      // В тестах журнал глушится: сотни строк pino между сообщениями vitest
      // делают вывод нечитаемым, а нужные строки проверяются напрямую.
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      env: env.NODE_ENV,
    });

  const metrics = createMetrics({
    enabled: env.METRICS_ENABLED,
    service: SERVICE_NAME,
    logger,
    path: METRICS_PATH,
  });

  // Тайминги запросов к БД снимаются обёрткой пула: логгер Drizzle вызывается
  // до выполнения и длительности не знает. Пул инструментируется до `drizzle()`
  // и до первого запроса — обёртка накладывается на месте и на клиентов
  // транзакций тоже.
  instrumentPool(pool, { logger, slowQueryMs: env.SLOW_QUERY_MS, metrics });

  const errorReporter = createErrorReporter({
    kind: env.ERROR_REPORTER,
    // `pg.Pool` подходит под `SqlExecutor` по форме, но у перегруженного
    // `query` в типах `pg` это не выводится.
    sql: pool as unknown as SqlExecutor,
    logger,
    sentryDsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
  });

  const app = fastify({
    // Тип экземпляра логгера Fastify выводит из этой опции, а `AppInstance`
    // объявлен на `FastifyBaseLogger`: приложение не должно зависеть в типах от
    // того, что реализация журнала — pino.
    loggerInstance: logger as FastifyBaseLogger,
    // Строку о запросе пишет слой наблюдаемости: в ней есть шаблон маршрута,
    // `user_id`, `duration_ms` и метрика. Штатные строки Fastify («incoming
    // request», «request completed») к ним ничего не добавляют, зато утраивают
    // объём журнала и сериализуют объект запроса ещё дважды. Через
    // `logController`, а не одноимённую опцию верхнего уровня: она объявлена
    // устаревшей и в Fastify 6 будет удалена.
    logController: new LogController({ disableRequestLogging: true }),
    // Список доверенных прокси, а не `true`: безусловное доверие к
    // `X-Forwarded-For` отдаёт выбор `request.ip` самому клиенту, а `request.ip` —
    // это ключ rate-limit и значение `auth_sessions.ip`. Проверено атакой:
    // при `RATE_LIMIT_MAX=3` восемь запросов с ротацией заголовка не дали 429.
    trustProxy: trustProxyOption(env),
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    genReqId: (request) => {
      // Идентификатор по умолчанию генерируется нами. Заголовок клиента — это
      // подделка корреляции журналов и отражение произвольной строки в ответе,
      // поэтому он принимается только при явном TRUST_REQUEST_ID (который сам
      // требует непустого TRUST_PROXY) и только в узком формате. Непригодное
      // значение отбрасывается молча: сообщать о нём — значит дать обратную
      // связь на подбор.
      if (!env.TRUST_REQUEST_ID) return randomUUID();
      const header = request.headers['x-request-id'];
      const supplied = Array.isArray(header) ? header[0] : header;
      return supplied !== undefined && TRUSTED_REQUEST_ID_PATTERN.test(supplied)
        ? supplied
        : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const sessionCipher = await createSessionCipher(env);
  const sessions = new SessionStore(pool, sessionCipher, env);
  const authProvider = options.authProvider ?? createAuthProvider(env);

  app.decorate('env', env);
  app.decorate('pool', pool);
  app.decorate('db', drizzle(pool));
  app.decorate('sessions', sessions);
  app.decorate('sessionCipher', sessionCipher);
  app.decorate('authProvider', authProvider);
  app.decorate('metrics', metrics);
  app.decorate('errorReporter', errorReporter);

  app.decorateRequest('authSession', null);
  app.decorateRequest('authContext', null);
  app.decorateRequest('authDenial', null);

  /**
   * Журнал запроса, сквозной `request_id` и метрика HTTP.
   *
   * Хук стоит раньше всех остальных, включая хуки плагинов: запрос, отвергнутый
   * лимитом (429) или проверкой CSRF (403), обязан быть в журнале и в
   * гистограмме — именно такой трафик и интересен при разборе инцидента.
   *
   * Обработчик открывает область AsyncLocalStorage и не закрывает её до конца
   * запроса: продолжения всей цепочки хуков и обработчика выполняются внутри
   * неё, поэтому `request_id` попадает и в строки кода, ничего не знающего о
   * запросе, и в payload'ы job'ов (§11).
   */
  const requestLog = createRequestLogHandler({
    logger,
    slowRequestMs: env.SLOW_REQUEST_MS,
    ignorePaths: UNLOGGED_PATHS,
    metrics,
    trustIncomingRequestId: env.TRUST_REQUEST_ID,
  });

  app.addHook('onRequest', (request, reply, done) => {
    requestLog(
      request.raw,
      reply.raw,
      () => {
        // Шаблон маршрута известен только Fastify. В метку метрики и в контекст
        // он обязан попасть шаблоном: конкретный путь с uuid превратил бы
        // гистограмму в тысячи серий. У 404 шаблона нет — остаётся `unknown`.
        setRequestLogFields(request.raw, { route: request.routeOptions.url });
        done();
      },
      request.id,
    );
  });

  const secure = cookieSecurity(env);
  // Вне продакшна секреты необязательны (`loadEnv()`), но константы по
  // умолчанию доезжают до боевых стендов, поэтому берётся случайное значение
  // на время жизни процесса.
  const cookieSecret = env.CSRF_SECRET ?? randomBytes(32).toString('hex');

  await app.register(helmet, {
    // API отдаёт JSON, но этим же процессом позже раздаётся SPA (§14), поэтому
    // политика рассчитана и на неё: pdf.js требует worker из blob: и wasm.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: secure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // По адресу, а не по пользователю: хук лимита выполняется раньше загрузки
    // сессии, и пользователь на этом этапе ещё неизвестен. Адрес берётся из
    // сокета, пока `TRUST_PROXY` не назовёт прокси: за nginx без этой переменной
    // все клиенты сойдутся в один ключ — это ограничение конфигурации, а не
    // повод доверять заголовку от кого угодно.
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      tooManyRequests(context.ttl / 1000, 'Слишком много запросов. Повторите позже.'),
  });

  await app.register(cookie, { secret: cookieSecret });

  /**
   * Плагин CSRF используется как генератор токена: он выдаёт значение,
   * привязанное к пользователю и подписанное HMAC. Проверку выполняет
   * `csrfGuardHook`, сверяя хэш с `auth_sessions.csrf_hash` (§4.1). Штатная
   * проверка плагина — double-submit с cookie — здесь была бы второй, более
   * слабой схемой: она доверяет cookie, а хэш в БД подменить снаружи нечем.
   */
  await app.register(csrfProtection, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: 'id_csrf_secret',
    cookieOpts: { httpOnly: true, secure, sameSite: 'lax', path: '/', signed: true },
    csrfOpts: { hmacKey: cookieSecret, userInfo: true },
    getToken: (request) => {
      const header = request.headers[CSRF_HEADER];
      return Array.isArray(header) ? header[0] : header;
    },
  });

  const middlewareDeps = { pool, sessions, env };
  app.addHook('onRequest', sessionContextHook(middlewareDeps));

  // `user_id` в строке запроса и в записи `error_events`. Раньше этого места
  // пользователь неизвестен — сессия ещё не прочитана; позже проверки CSRF —
  // отказ 403 остался бы без имени пользователя, а это первое, что спрашивают.
  app.addHook('onRequest', (request, _reply, done) => {
    const userId = request.authContext?.user.id ?? request.authSession?.userId;
    if (userId !== undefined) setRequestLogFields(request.raw, { userId });
    done();
  });

  app.addHook('onRequest', csrfGuardHook(middlewareDeps));

  // Ответы API кэшировать нельзя: /me и списки поставок зависят от сессии, а
  // промежуточный кэш о ней не знает.
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  // Отдельного хука о медленном запросе здесь нет: порог `SLOW_REQUEST_MS`
  // применяет слой журнала запросов — он переводит ту же самую строку
  // `http_request` в warn. Вторая строка о том же запросе только раздваивала бы
  // подсчёт медленных запросов.

  app.setErrorHandler((error, request, reply) => {
    const problem = mapToProblem(error);

    /**
     * В журнал уходит выжимка, а не объект ошибки.
     *
     * `err: error` целиком — это утечка: у ошибки драйвера `pg` в полях `query`
     * и `params` лежит текст SQL и ВСЕ значения bind-параметров. Для INSERT в
     * `auth_sessions` это id сессии, `user_id`, `kc_sid`, `csrf_hash` и
     * шифрованный конверт refresh-токена; на запросах к документам —
     * распознанный текст и ФИО подписантов. Выжимка оставляет класс, SQLSTATE,
     * имя ограничения, свои кадры стека и нормализованное сообщение.
     */
    const logFields = {
      event: 'request_failed',
      ...errorDigest(error),
      status_code: problem.status,
      problem_type: problem.type,
      route: request.routeOptions.url ?? UNKNOWN_ROUTE,
      user_id: request.authContext?.user.id ?? null,
    };
    // Текст сообщения тоже нормализуется: `logDetail` бывает сообщением ошибки
    // нижнего слоя, а в нём — значение, из-за которого она возникла
    // («invalid input syntax for type uuid: "…"»). Redaction к тексту
    // сообщения не применяется по построению.
    const logMessage = normalizeErrorMessage(
      problem.logDetail ??
        (problem.status >= 500 ? 'необработанная ошибка запроса' : 'запрос отклонён'),
    );

    if (problem.status >= 500) {
      request.log.error(logFields, logMessage);
      // Без ожидания: запись в `error_events` не должна задерживать ответ на
      // время `connectionTimeoutMillis`, а репортер по построению не бросает и
      // сам пишет о своём сбое. Контекст (`request_id`, `user_id`, маршрут)
      // репортер берёт из области AsyncLocalStorage этого запроса.
      void app.errorReporter.report(error, { extra: { status_code: problem.status } });
    } else {
      request.log.warn(logFields, logMessage);
    }

    if (problem.headers !== undefined) {
      for (const [name, value] of Object.entries(problem.headers)) reply.header(name, value);
    }

    return reply
      .code(problem.status)
      .type(PROBLEM_JSON_CONTENT_TYPE)
      .send(problemBody(problem, problemContext(request)));
  });

  /**
   * Обработчик «маршрут не найден» с собственным лимитом запросов.
   *
   * Плагин лимита навешивается на зарегистрированные маршруты, поэтому запросы
   * к несуществующим путям идут мимо него — проверено прогоном. Без этого
   * перебор путей ничем не ограничен, хотя каждый такой запрос всё равно
   * поднимает сессию и обходит хуки.
   */
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) =>
    reply
      .code(404)
      .type(PROBLEM_JSON_CONTENT_TYPE)
      .send(problemBody(notFound('Маршрут не найден.'), problemContext(request))),
  );

  registerHealthRoutes(app);
  registerMetricsRoute(app, metrics);
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerCatalogRoutes(app);
  // Профили правил объекта — тот же префикс `/catalog`, но свой модуль: у них своя
  // форма наложений и своё разрешение «правила на дату» (§9.2).
  registerObjectRuleProfileRoutes(app);
  registerAuditRoutes(app);

  app.addHook('onClose', async () => {
    // Пул, полученный извне, принадлежит вызывающему: закрыть его здесь значит
    // сломать остальные тесты того же файла.
    if (ownsPool) await closePool(pool);
  });

  return app;
}

function problemContext(request: FastifyRequest) {
  return { requestId: request.id, instance: requestInstance(request.url) };
}

/**
 * `GET /metrics` в формате Prometheus (§11).
 *
 * При `METRICS_ENABLED=false` маршрута нет вовсе: пустой ответ 200 сказал бы
 * Prometheus «метрики есть, значений нет», и отключённый сбор выглядел бы как
 * исправный. Лимит запросов снят — опрос идёт с фиксированным интервалом и не
 * должен получать 429; наружу путь не публикуется (это делает nginx).
 */
function registerMetricsRoute(app: AppInstance, metrics: Metrics): void {
  const route = metrics.route;
  if (route === undefined) return;

  app.get(route.url, { config: { rateLimit: false } }, async (request, reply) => {
    await route.handler(request, reply);
    return reply;
  });
}

/**
 * Ошибка → проблема.
 *
 * Ошибки валидации zod разбираются отдельно: только у них есть поля, которые
 * клиенту полезно и безопасно вернуть. Ошибка сериализации ОТВЕТА, напротив,
 * всегда 500 без подробностей — она описывает нашу внутреннюю модель.
 */
function mapToProblem(error: unknown): HttpProblem {
  if (hasZodFastifySchemaValidationErrors(error)) {
    const errors: ProblemError[] = error.validation
      .slice(0, MAX_REPORTED_VALIDATION_ERRORS)
      .map((issue) => ({
        pointer: issue.instancePath === '' ? null : issue.instancePath,
        code: issue.keyword,
        message: issue.message ?? 'некорректное значение',
      }));
    return unprocessable(errors, 'Запрос не прошёл проверку.');
  }

  if (isResponseSerializationError(error)) {
    return internal({
      cause: error,
      logDetail: 'ответ не соответствует объявленной схеме',
    });
  }

  return toHttpProblem(error);
}
