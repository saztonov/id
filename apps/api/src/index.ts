/**
 * Публичная поверхность пакета `@id/api` для ВТОРОГО процесса — воркера.
 *
 * Портал — модульный монолит: API и воркер это один код и один образ с разными
 * точками входа (§2). Отсюда правило: движок задач, конфигурация и слой
 * наблюдаемости существуют в одном экземпляре, а `apps/worker` их использует, а
 * не повторяет. Второй экземпляр очереди — в воркере своя реализация захвата,
 * своя нормализация ошибок, свой разбор окружения — разошёлся бы с первым молча
 * и ровно в тот момент, когда конвейер начнёт терять задачи.
 *
 * Здесь именно поверхность, а не «всё подряд»: `buildApp()` не экспортируется
 * намеренно. Импорт этого модуля не должен тянуть в процесс воркера Fastify со
 * всеми плагинами — воркер не слушает HTTP, и загружать в него слой, которого
 * он не использует, значит увеличивать и время старта, и площадь отказа.
 * Точка входа API (`server.ts`) берёт `buildApp()` напрямую из `app.ts`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { Database } from './db/repositories/users.js';

export { createPool, closePool } from '@id/db';

export { loadEnv, EnvError, allowedModels, trustProxyOption } from './config/env.js';
export type { Env } from './config/env.js';

export { createLogger } from './observability/logger.js';
export type { AppLogger, LogLevel } from './observability/logger.js';
export { createMetrics, measureExternalCall } from './observability/metrics.js';
export type { Metrics } from './observability/metrics.js';
export {
  createErrorReporter,
  errorDigest,
  installProcessErrorHandlers,
  NoopErrorReporter,
  normalizeErrorMessage,
} from './observability/errors.js';
export type { ErrorReporter, SqlExecutor } from './observability/errors.js';
export { instrumentPool } from './observability/db-timing.js';
export {
  childLogger,
  currentContext,
  newRequestId,
  runWithContext,
  tracePayload,
} from './observability/context.js';

export { JobRunner, JobTimeoutError, LeaseLostError } from './jobs/runner.js';
export type { JobRunnerOptions } from './jobs/runner.js';
export { createMaintenanceRegistry, JobRegistry } from './jobs/registry.js';
export type { JobContext, JobHandler } from './jobs/registry.js';
export {
  backoffDelayMs,
  clampConcurrency,
  dedupeKeyFor,
  JOB_QUEUES,
  JOB_TYPES,
  jobDefinition,
  jobTypesOfQueue,
  queueOf,
  stageOf,
} from './jobs/types.js';
export type { JobPayload, JobQueue, JobType } from './jobs/types.js';

export {
  appendOutbox,
  appendRevisionEvent,
  computeProcessingStatus,
  enqueueSystemJob,
  publishOutboxBatch,
  queueSnapshot,
  reapExpiredLeases,
} from './db/repositories/jobs.js';
export type { Database } from './db/repositories/users.js';

/**
 * Поверхность для обработчиков стадий конвейера (§12).
 *
 * Воркер выполняет те же задачи над теми же данными, что и API, и потому ему
 * нужны те же три вещи: область видимости, репозитории и разбор PDF. Вторая
 * реализация любой из них разошлась бы с первой молча — так, что принятый при
 * загрузке файл отвергался бы конвейером без единого признака причины.
 *
 * `buildApp()` по-прежнему не экспортируется: HTTP-слой воркеру не нужен.
 */
export type { AuthScope } from './auth/scope.js';

export {
  createBundle,
  computeAggregateManifestHash,
  findBundle,
  findBundleByManifest,
  findSourceOfWorkingPage,
  listBundlePages,
  listBundles,
  loadBundlePlan,
  orderedParts,
} from './db/repositories/bundles.js';
export type {
  BundlePageView,
  BundlePlan,
  BundlePlanFile,
  BundleView,
  CreateBundleInput,
} from './db/repositories/bundles.js';

export {
  findFileContent,
  findRevisionForFiles,
  listSourceFiles,
  saveFileVerdict,
  saveSignatureProbe,
} from './db/repositories/files.js';
export type {
  FileContentRef,
  RevisionForFiles,
  SaveVerdictInput,
  SaveVerdictOutcome,
} from './db/repositories/files.js';

export { storableVerdict } from './modules/files/verify.js';

export { evaluatePdfFile, PDF_MIME, probePdf, sha256Hex } from './pdf/probe.js';
export type {
  FileQuarantineReason,
  FileVerdict,
  FileVerificationPolicy,
  PdfPageGeometry,
  PdfProbeResult,
  PdfSignatureFindings,
} from './pdf/probe.js';
export {
  assertPageCountMatches,
  assertWithinLimits,
  isPdfToolkitError,
  PDF_LIB_MAX_INPUT_BYTES,
  PDF_LIB_MAX_TOTAL_BYTES,
  PdfToolkitError,
  planWorkingPdf,
  selectPdfToolkit,
} from './pdf/toolkit.js';
export type {
  PdfToolkit,
  PdfToolkitKind,
  PdfToolkitSelection,
  WorkingPageMapping,
  WorkingPdfPart,
} from './pdf/toolkit.js';
export { createQpdfToolkit, detectQpdf } from './pdf/qpdf.js';
export { createPdfLibToolkit, loadPdfLibModule } from './pdf/pdf-lib.js';

export {
  createStorage,
  instrumentStorage,
  isStorageError,
  StorageError,
} from './storage/provider.js';
export type { StorageProvider } from './storage/provider.js';
export { blobKey } from './storage/keys.js';

/**
 * Обёртка Drizzle над пулом.
 *
 * Существует ради того, чтобы воркер не создавал экземпляр Drizzle сам: в
 * монорепозитории у двух воркспейсов могут оказаться два физических экземпляра
 * одной библиотеки, и тогда объект, собранный в воркере, приезжал бы в код API
 * из другой копии модуля. Одна фабрика на оба процесса снимает вопрос целиком.
 */
export function createDatabase(pool: Pool): Database {
  return drizzle(pool);
}
