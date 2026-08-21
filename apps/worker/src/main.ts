/**
 * Точка входа процесса-воркера (§2, §12).
 *
 * Тот же код и тот же образ, что у API, но другая точка входа: воркер не
 * слушает HTTP и не знает ни про сессии, ни про маршруты. Всё, что ему нужно —
 * конфигурация, пул, журнал, регистрация ошибок и движок задач — берётся из
 * `@id/api`, а не пишется здесь второй раз. Своя копия захвата задач или своя
 * нормализация ошибок разошлись бы с первой молча.
 *
 * Порядок старта значим и совпадает с API: сначала конфигурация (без неё
 * подниматься нельзя), затем журнал, затем пул с таймингами, затем регистрация
 * ошибок, и только потом захват задач. Обратный порядок означал бы, что первый
 * же отказ произошёл бы до появления того, чем его записывают.
 *
 * ## Завершение
 *
 * SIGTERM: новые задачи не берутся, текущие дорабатывают. Не успевшие —
 * не потеряны: аренда истечёт, и задачу подберёт reaper (at-least-once, §12).
 * Именно поэтому здесь нет попыток «доделать любой ценой»: Docker присылает
 * SIGKILL через 10 секунд после SIGTERM, и ждать дольше бессмысленно.
 */
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { z } from 'zod';
import {
  closePool,
  createAiSpendReader,
  createDatabase,
  createErrorReporting,
  DbProcessingFeedbackSink,
  createLogger,
  assertRuleRegistryConsistent,
  createMetrics,
  createPdfLibToolkit,
  createPool,
  createQpdfToolkit,
  createRdWeb,
  createStorage,
  createVlmProvider,
  detectQpdf,
  EnvError,
  firstAllowedProject,
  recognitionSelections,
  errorDigest,
  installProcessErrorHandlers,
  instrumentPool,
  JobRunner,
  loadEnv,
  loadPdfLibModule,
  selectPdfToolkit,
  selectRasterizer,
  type AppLogger,
  type Env,
  type Metrics,
  type PdfToolkit,
  type SqlExecutor,
} from '@id/api';
import { createWorkerRegistry, SYSTEM_SCOPE } from './jobs/pipeline.js';

/** Метка процесса в журнале и в метках метрик: строки API и воркера в общем потоке. */
const SERVICE_NAME = 'worker';

/** Потолок ожидания текущих задач при остановке. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * Настройки самого воркера.
 *
 * Разбираются здесь, а не в общем `loadEnv()`: они относятся к процессу-воркеру,
 * а API про них ничего не знает. Проверка всё равно fail-fast — переменная с
 * мусором обязана валить старт, а не молча превращаться в NaN. Значения
 * параллелизма дополнительно зажимаются диапазонами §12 (`clampConcurrency`),
 * поэтому «поставить 16 на cpu» не получится даже намеренно.
 */
const workerEnvSchema = z.object({
  WORKER_CONCURRENCY_IO: z.coerce.number().int().positive().optional(),
  WORKER_CONCURRENCY_CPU: z.coerce.number().int().positive().optional(),
  WORKER_CONCURRENCY_LLM: z.coerce.number().int().positive().optional(),
  /**
   * Порт служебного `/metrics` воркера.
   *
   * По умолчанию сервер не поднимается: воркер живёт в своём контейнере, и порт
   * ему назначает деплой. Пока порт не задан, глубина очереди всё равно видна —
   * её отдаёт `/metrics` API из той же таблицы `jobs`; без порта не видны только
   * метрики самого процесса воркера.
   */
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
});

type WorkerEnv = z.infer<typeof workerEnvSchema>;

function readEnv(): { env: Env; worker: WorkerEnv } {
  try {
    const env = loadEnv();
    const parsed = workerEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new EnvError(
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`,
        ),
      );
    }
    return { env, worker: parsed.data };
  } catch (error) {
    if (error instanceof EnvError) {
      // Конфигурация проверяется до создания журнала, поэтому причина отказа
      // старта идёт прямо в stderr — иначе она пропала бы.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { env, worker } = readEnv();

  const logger = createLogger({
    service: SERVICE_NAME,
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    env: env.NODE_ENV,
  });

  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: env.PG_POOL_MAX,
    ...(env.PG_CA_CERT_PATH !== undefined ? { caCertPath: env.PG_CA_CERT_PATH } : {}),
    // Отдельное имя в `pg_stat_activity`: иначе запрос, съевший кластер, не
    // отличить от запроса API.
    applicationName: 'id-portal-worker',
  });

  const metrics = createMetrics({
    enabled: env.METRICS_ENABLED,
    service: SERVICE_NAME,
    logger,
  });

  // Тайминги запросов к БД (§11, `SLOW_QUERY_MS`) снимаются обёрткой пула — до
  // первого запроса и до создания Drizzle.
  instrumentPool(pool, { logger, slowQueryMs: env.SLOW_QUERY_MS, metrics });

  const db = createDatabase(pool);

  const { reporter: errorReporter, writer: errorJournal } = createErrorReporting({
    kind: env.ERROR_REPORTER,
    // `pg.Pool` подходит под `SqlExecutor` по форме, но у перегруженного
    // `query` в типах `pg` это не выводится.
    sql: pool as unknown as SqlExecutor,
    logger,
    // Источник задаётся здесь один раз, а не в каждом вызове `report()`:
    // забыть его в одном месте из тридцати — это строка журнала, которая
    // приписывает падение воркера API и уводит разбор не туда.
    source: 'worker',
    sentryDsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.APP_RELEASE,
    flushIntervalMs: env.ERROR_JOURNAL_FLUSH_MS,
    sampleIntervalMs: env.ERROR_JOURNAL_SAMPLE_INTERVAL_MS,
    newSignatureLimitPerHour: env.ERROR_JOURNAL_NEW_SIGNATURE_LIMIT,
    metrics,
  });

  // Выбор реализации работы с PDF — startup check (ADR-0003), а не решение
  // места вызова. В production отсутствие qpdf бросает отсюда и не даёт воркеру
  // подняться: молчаливая деградация означала бы исчерпание памяти на первом
  // крупном комплекте, в фоновой задаче, без внятной ошибки пользователю.
  const toolkit = await choosePdfToolkit(env, logger);

  // Растеризатор PDF→PNG для локальной детекции RF-DETR и (позже) кропов VLM
  // (ADR-0008) — тот же паттерн startup-выбора, что и `toolkit` (ADR-0003), но
  // без падения процесса: `detection.provider='rdweb'` (дефолт) обязан
  // работать без poppler на машине, и это единственная причина не роднить его
  // выбор с `choosePdfToolkit`. `null` — задачи локальной детекции честно
  // отказывают `DetectionConfigurationError`, конвейер `rd.*` не страдает.
  const rasterizer = await selectRasterizer({ binary: env.PDFTOPPM_PATH });
  if (rasterizer === null) {
    logger.warn(
      { event: 'rasterizer_unavailable' },
      'pdftoppm не найден: локальная детекция RF-DETR и локальные кропы VLM недоступны',
    );
  }

  const storage = createStorage(env, { metrics, logger });

  // Обработчики стадий регистрируются здесь. Написанный, но не
  // зарегистрированный обработчик — это мёртвый код при зелёных тестах: тесты
  // проверяют его напрямую, а конвейер его никогда не вызывает (урок S3).
  // Остальные стадии (`rd.*`, `doc.*`, `checks.*`) добавляются сюда же по мере
  // появления; типы без обработчика воркер не захватывает — их задачи ждут в
  // очереди воркера, который их умеет, и видны в консоли как `queued`.
  // Адаптер RD WEB собирается фабрикой, а не на месте вызова: только так он
  // получает метрики, порог `SLOW_EXTERNAL_MS` и сквозной `request_id` (§11).
  // `null` при ненастроенной интеграции — портал обязан подниматься и принимать
  // файлы даже без доступа к RD WEB.
  const rdweb = createRdWeb(env, { metrics, logger });

  // VLM-порт распознавания (ADR-0007). Собирается всегда, тем же принципом,
  // что и `rdweb`: `LLM_PROVIDER=none` (дефолт) не даёт пустого объекта, а
  // даёт честно отказывающий провайдер — задачи `vlm.*` узнают об этом на
  // первом вызове `.complete()`, с внятной причиной, а не на старте процесса.
  // Бюджет (`ai_runs.cost`) общий с текстовыми стадиями — тот же расходомер,
  // читающий системной областью (§11).
  const vlm = createVlmProvider(env, {
    metrics,
    logger,
    spend: createAiSpendReader(db, SYSTEM_SCOPE),
  });

  // Сверка реестра правил с реализациями (§9.6). Воркер исполняет задачи 20–21,
  // то есть именно он даёт заключение по комплекту, — подниматься с неполным
  // набором правил ему нельзя тем более.
  await assertRuleRegistryConsistent(db, {
    error: (details, message) => {
      logger.error(details, message);
    },
    info: (details, message) => {
      logger.info(details, message);
    },
  });

  /**
   * Приёмник дефектов качества конвейера (§11, ADR-0010).
   *
   * Собирается здесь, потому что ряд начинается тогда, когда включён сбор:
   * задним числом «доля невалидных ответов у промта версии 3» не
   * восстанавливается ниоткуда, и выключателя у записи поэтому нет.
   */
  const feedback = new DbProcessingFeedbackSink({
    sql: pool as unknown as SqlExecutor,
    logger,
    release: env.APP_RELEASE,
  });

  const registry = createWorkerRegistry({
    db,
    storage,
    feedback,
    toolkit,
    limits: { maxBytes: env.MAX_UPLOAD_BYTES, maxPages: env.MAX_PAGES_PER_FILE },
    rdweb,
    rdProjectId: firstAllowedProject(env) ?? null,
    previewCached: env.PREVIEW_MODE === 'cached',
    // Выбор провайдера и модели OCR (§10). Пустой список означает «не
    // настроено», и задача 11 честно отказывает — она не имеет права
    // подставить чужой `model_id` за администратора.
    recognitionSelections: recognitionSelections(env),
    rasterizer,
    // `env` нужен `localDetectionDeps` ради `ORT_INTRA_OP_THREADS`/
    // `ORT_INTER_OP_THREADS`; на остальные порты (например, LLM в
    // `segmentationDeps`) не влияет — там дополнительно требуются
    // `llmLogger`/`llmMetrics`, которых здесь нет.
    env,
    vlm,
  });

  const runner = new JobRunner({
    db,
    registry,
    logger,
    metrics,
    errorReporter,
    // Имя арендатора: по `jobs.locked_by` видно, чей процесс держит задачу и
    // какой из них умер, не отпустив её.
    workerId: `${hostname()}:${process.pid}`,
    concurrency: {
      ...(worker.WORKER_CONCURRENCY_IO !== undefined ? { io: worker.WORKER_CONCURRENCY_IO } : {}),
      ...(worker.WORKER_CONCURRENCY_CPU !== undefined
        ? { cpu: worker.WORKER_CONCURRENCY_CPU }
        : {}),
      ...(worker.WORKER_CONCURRENCY_LLM !== undefined
        ? { llm: worker.WORKER_CONCURRENCY_LLM }
        : {}),
    },
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    // Очистка журнала живёт здесь, а не в API: у воркера уже есть часовой цикл
    // обслуживания, и одновременно работает всё равно только один процесс —
    // очистка берёт advisory-блокировку.
    journalRetention: {
      sampleRetentionDays: env.ERROR_SAMPLE_RETENTION_DAYS,
      statsRetentionDays: env.ERROR_STATS_RETENTION_DAYS,
      slowRetentionDays: env.SLOW_OPERATION_RETENTION_DAYS,
      samplesPerIssue: env.ERROR_SAMPLES_PER_ISSUE,
    },
  });

  const metricsServer = startMetricsServer(worker.WORKER_METRICS_PORT, metrics, logger);

  installProcessErrorHandlers({
    reporter: errorReporter,
    logger,
    // Без сброса запись о падении осталась бы в памяти процесса, который
    // прямо сейчас гасят: терялись бы ровно самые тяжёлые отказы.
    flush: () => errorJournal.flush(),
    // Процесс гасится через graceful shutdown: `process.exit()` из слоя
    // наблюдаемости оборвал бы выполняющуюся задачу на середине записи
    // результата.
    exitOnUncaught: false,
  });

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown', signal }, 'получен сигнал завершения');

    const forceExit = setTimeout(() => {
      logger.error({ event: 'shutdown_timeout' }, 'завершение не уложилось в срок, выходим');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS * 2);
    forceExit.unref();

    void (async () => {
      try {
        await runner.stop();
        // Журнал дописывается ДО закрытия пула: после него писать некуда.
        await errorJournal.stop();
        metricsServer?.close();
        await closePool(pool);
        clearTimeout(forceExit);
        logger.info({ event: 'shutdown_complete' }, 'воркер остановлен');
        process.exit(exitCode);
      } catch (error) {
        // Выжимка, а не объект ошибки: в ошибке драйвера лежит текст SQL и
        // значения параметров последнего запроса (§11).
        logger.error(
          { event: 'shutdown_failed', ...errorDigest(error) },
          'ошибка при остановке воркера',
        );
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('uncaughtException', () => {
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', () => {
    shutdown('unhandledRejection', 1);
  });

  runner.start();

  logger.info(
    {
      event: 'worker_ready',
      handled_types: registry.types(),
      unhandled_types: registry.unhandled().length,
      pdf_toolkit: toolkit.kind,
      storage_driver: storage.driver,
      // Факт настроенности, а не адрес и тем более не учётные данные (§11).
      rdweb_configured: rdweb !== null,
      llm_provider: env.LLM_PROVIDER,
      rasterizer: rasterizer?.kind ?? null,
      preview_mode: env.PREVIEW_MODE,
      metrics_port: worker.WORKER_METRICS_PORT ?? null,
    },
    'воркер готов принимать задачи',
  );
}

/**
 * Startup check работы с PDF (ADR-0003).
 *
 * Решение о падении принимает `selectPdfToolkit()`; здесь только пробы и
 * фабрики. `pdf-lib` загружается лениво — при найденном `qpdf` он в процесс
 * воркера не попадает вовсе.
 */
async function choosePdfToolkit(env: Env, logger: AppLogger): Promise<PdfToolkit> {
  const selection = await selectPdfToolkit({
    nodeEnv: env.NODE_ENV,
    detectQpdf: () => detectQpdf(),
    createQpdfToolkit: () =>
      createQpdfToolkit({
        onWarning: (message) => {
          logger.warn({ event: 'qpdf_warning' }, message);
        },
      }),
    // Импорт написан ЗДЕСЬ, а не в `@id/api`: `pdf-lib` объявлен зависимостью
    // воркера, и спецификатор резолвится относительно модуля, в котором стоит
    // `import()`. Написанный в `apps/api`, он не нашёл бы пакет вовсе.
    createFallbackToolkit: async () =>
      createPdfLibToolkit(await loadPdfLibModule((specifier) => import(specifier))),
    logger,
  });
  return selection.toolkit;
}

/**
 * Служебный HTTP-сервер только для `/metrics`.
 *
 * Наружу не публикуется (§11) — его забирает Prometheus внутри сети. Любой
 * другой путь получает 404: у воркера нет ни одного публичного эндпоинта, и
 * отвечать на что-либо ещё он не должен.
 */
function startMetricsServer(
  port: number | undefined,
  metrics: Metrics,
  logger: AppLogger,
): Server | null {
  if (port === undefined) return null;

  const server = createServer((req, res) => {
    if (req.url === undefined || !req.url.startsWith('/metrics')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void metrics.handleNodeRequest(req, res);
  });

  server.on('error', (error: unknown) => {
    // Не роняем воркер: метрики — наблюдаемость, а не условие обработки задач.
    // Но и не молчим: строка в журнале обязана быть, иначе «графиков нет»
    // выяснится через неделю.
    logger.error(
      { event: 'metrics_server_failed', ...errorDigest(error) },
      'служебный сервер метрик не поднялся',
    );
  });

  server.listen(port, () => {
    logger.info({ event: 'metrics_server_started', port }, 'служебный сервер метрик слушает');
  });

  return server;
}

main().catch((error: unknown) => {
  console.error('Не удалось запустить воркер:', error instanceof Error ? error.message : error);
  process.exit(1);
});
