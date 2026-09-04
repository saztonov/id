/**
 * Сборка интеграции RD WEB из конфигурации.
 *
 * Фабрика здесь, а не в точке вызова, по той же причине, что и у хранилища:
 * адаптер, собранный на месте, остался бы без метрик, без порога
 * `SLOW_EXTERNAL_MS` и без сквозного `request_id`. Ровно так на S3 слой
 * наблюдаемости оказался мёртвым кодом.
 *
 * Токен берётся из окружения и НИКОГДА не попадает ни в `app_settings` (§10:
 * только masked-ссылка и статус подключения), ни в журнал.
 */
import type { Logger } from 'pino';

import type { Env } from '../../config/env.js';
import type { Metrics } from '../../observability/metrics.js';
import { ExecSyncAdapter } from './adapter.js';
import { ExecSyncClient } from './client.js';
import type { ExecSyncPort } from './port.js';

export * from './port.js';
export { ExecSyncAdapter } from './adapter.js';
export { ExecSyncClient, EXEC_API_PREFIX, RDWEB_EXEC_SERVICE } from './client.js';
export type { ExecSyncClientOptions } from './client.js';
export {
  buildSnapshotBody,
  SnapshotBuildError,
  type BuildSnapshotInput,
  type BuildSnapshotResult,
  type SnapshotBlockInput,
  type SnapshotDocumentInput,
} from './snapshot.js';

export interface CreateExecSyncOptions {
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Адаптер или `null`, если интеграция не настроена.
 *
 * `null`, а не исключение: портал обязан подниматься и принимать файлы даже без
 * доступа к RD WEB — иначе недоступная интеграция превращала бы загрузку
 * комплекта в отказ старта. Распознавание при этом честно отказывает с внятным
 * текстом (`assertRecognitionStageReady`), а не делает вид, что работает.
 */
export function createExecSync(env: Env, options: CreateExecSyncOptions): ExecSyncPort | null {
  if (
    env.RDWEB_EXEC_BASE_URL === undefined ||
    env.RDWEB_EXEC_TOKEN === undefined ||
    env.RDWEB_EXEC_PROJECT_ID === undefined
  ) {
    return null;
  }

  return new ExecSyncAdapter({
    client: new ExecSyncClient({
      baseUrl: env.RDWEB_EXEC_BASE_URL,
      token: env.RDWEB_EXEC_TOKEN,
      metrics: options.metrics,
      logger: options.logger,
      slowExternalMs: env.SLOW_EXTERNAL_MS,
      timeoutMs: env.RDWEB_EXEC_TIMEOUT_MS,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    }),
  });
}

/**
 * Чего не хватает для работы интеграции. Пусто — настроена.
 *
 * Список, а не булев признак: администратору нужно знать, ЧТО именно дозаполнить,
 * и тот же перечень показывает карточка настроек. Второе место, где он был бы
 * выписан руками, разошлось бы с первым.
 */
export function execSyncMissingVars(env: Env): readonly string[] {
  const missing: string[] = [];
  if (env.RDWEB_EXEC_BASE_URL === undefined) missing.push('RDWEB_EXEC_BASE_URL');
  if (env.RDWEB_EXEC_TOKEN === undefined) missing.push('RDWEB_EXEC_TOKEN');
  if (env.RDWEB_EXEC_PROJECT_ID === undefined) missing.push('RDWEB_EXEC_PROJECT_ID');
  return missing;
}
